// Builds guide.json for the TV player.
//
// Runs in two steps (the GitHub Action calls both):
//   node scripts/build-guide.mjs channels  -> picks a guide source for each channel
//   node scripts/build-guide.mjs json      -> turns the downloaded guide into guide.json
//
// Expects the iptv-org/epg grabber to be cloned into ./epg (the Action does this).

import fs from 'fs'
import path from 'path'

const ROOT = process.cwd()
const EPG_DIR = path.join(ROOT, 'epg')
const WORK_DIR = path.join(ROOT, 'work')
const CHANNELS_DIR = path.join(WORK_DIR, 'channels') // one channel list per site
const GUIDES_DIR = path.join(WORK_DIR, 'guides')     // one downloaded guide per site
const IDS_FILE = path.join(WORK_DIR, 'playlist-ids.json')
const GUIDE_JSON = path.join(ROOT, 'guide.json')

// Guide sources to try first when a channel is listed on several sites.
// These cover the most US channels and are usually reliable.
const PREFERRED_SITES = [
  'tvtv.us', 'tvpassport.com', 'plex.tv', 'pluto.tv', 'xumo.tv',
  'i.mjh.nz', 'tvguide.com', 'distro.tv', 'watchyour.tv'
]

// Keep programmes from 1 hour ago to 36 hours ahead
const KEEP_PAST_MS = 1 * 3600e3
const KEEP_AHEAD_MS = 36 * 3600e3

// Regional feeds with different schedules: never swap one for another
const REGIONAL_FEEDS = new Set(['East', 'West', 'Pacific', 'Mountain', 'Central'])

const step = process.argv[2]
if (step === 'channels') await buildChannels()
else if (step === 'json') buildJson()
else {
  console.error('Usage: node scripts/build-guide.mjs <channels|json>')
  process.exit(1)
}

// ---------- Step 1: choose guide sources ----------

async function buildChannels() {
  // Read the playlist URLs straight from the dropdown in index.html,
  // so adding a playlist to the page automatically adds it to the guide.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  const playlistUrls = [...html.matchAll(/<option\s+value="([^"]+\.m3u8?)"/g)].map(m => m[1])
  console.log(`Playlists found in index.html: ${playlistUrls.length}`)

  const ids = new Set()
  for (const url of playlistUrls) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      for (const m of text.matchAll(/tvg-id="([^"]+)"/g)) ids.add(m[1])
    } catch (err) {
      console.warn(`  could not load ${url}: ${err.message}`)
    }
  }
  console.log(`Channel IDs in playlists: ${ids.size}`)

  // Index every channel the grabber knows about, by full ID and by base ID
  const byFullId = new Map()
  const byBaseId = new Map()
  for (const file of listFiles(path.join(EPG_DIR, 'sites'), '.channels.xml')) {
    const xml = fs.readFileSync(file, 'utf8')
    for (const m of xml.matchAll(/<channel\b([^>]*)>([^<]*)<\/channel>/g)) {
      const attrs = parseAttrs(m[1])
      if (!attrs.xmltv_id || !attrs.site || !attrs.site_id) continue
      const entry = { ...attrs, name: m[2] }
      push(byFullId, attrs.xmltv_id, entry)
      push(byBaseId, splitId(attrs.xmltv_id).base, entry)
    }
  }

  const picked = []
  for (const id of ids) {
    const { base, feed } = splitId(id)
    let candidates = byFullId.get(id) || []
    if (!candidates.length) {
      // No exact match: accept another feed of the same channel,
      // unless it's a different time-zone feed (East vs West etc.)
      candidates = (byBaseId.get(base) || []).filter(c => {
        const cFeed = splitId(c.xmltv_id).feed
        if (!feed || !cFeed || feed === cFeed) return true
        return !REGIONAL_FEEDS.has(feed) && !REGIONAL_FEEDS.has(cFeed)
      })
    }
    if (!candidates.length) continue
    candidates.sort((a, b) => siteRank(a) - siteRank(b))
    // Output uses the playlist's own ID so the page can match it directly
    picked.push({ ...candidates[0], xmltv_id: id })
  }

  // One file per site, so the Action can download each site separately
  // and a crash on one site doesn't lose the others
  fs.rmSync(CHANNELS_DIR, { recursive: true, force: true })
  fs.mkdirSync(CHANNELS_DIR, { recursive: true })
  const bySite = new Map()
  for (const c of picked) push(bySite, c.site, c)
  for (const [site, list] of bySite) {
    const lines = list.map(c =>
      `  <channel site="${esc(c.site)}" lang="${esc(c.lang || 'en')}" xmltv_id="${esc(c.xmltv_id)}" site_id="${esc(c.site_id)}">${esc(decode(c.name))}</channel>`
    )
    fs.writeFileSync(path.join(CHANNELS_DIR, `${site}.channels.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${lines.join('\n')}\n</channels>\n`)
  }
  fs.writeFileSync(IDS_FILE, JSON.stringify([...ids]))

  console.log(`Channels with a guide source: ${picked.length} of ${ids.size}`)
  console.log('By site:', Object.fromEntries([...bySite].map(([s, l]) => [s, l.length])))
}

function siteRank(entry) {
  const i = PREFERRED_SITES.indexOf(entry.site)
  const langPenalty = entry.lang && entry.lang !== 'en' ? 100 : 0
  return (i === -1 ? PREFERRED_SITES.length : i) + langPenalty
}

// ---------- Step 2: convert to guide.json ----------

function buildJson() {
  const files = listFiles(GUIDES_DIR, '.xml')
  if (!files.length) {
    console.error('No guides were downloaded; keeping the existing guide.json')
    return
  }
  const now = Date.now()
  const channels = {}
  let count = 0

  for (const file of files) {
    let fileCount = 0
    const xml = fs.readFileSync(file, 'utf8')
    for (const m of xml.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
      const attrs = parseAttrs(m[1])
      const start = parseXmltvTime(attrs.start)
      const stop = parseXmltvTime(attrs.stop)
      if (!attrs.channel || !start || !stop) continue
      if (stop < now - KEEP_PAST_MS || start > now + KEEP_AHEAD_MS) continue

      const title = decode((m[2].match(/<title\b[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').trim()
      if (!title) continue
      const sub = decode((m[2].match(/<sub-title\b[^>]*>([\s\S]*?)<\/sub-title>/) || [])[1] || '').trim()

      // Compact form: [start, stop, title, subtitle?] with times in seconds
      const row = [Math.floor(start / 1000), Math.floor(stop / 1000), title]
      if (sub) row.push(sub)
      ;(channels[decode(attrs.channel)] ||= []).push(row)
      fileCount++
    }
    console.log(`  ${path.basename(file)}: ${fileCount} programmes`)
    count += fileCount
  }

  for (const list of Object.values(channels)) {
    list.sort((a, b) => a[0] - b[0])
    // Drop duplicates (same start time)
    for (let i = list.length - 1; i > 0; i--) if (list[i][0] === list[i - 1][0]) list.splice(i, 1)
  }

  if (count === 0) {
    console.error('Downloaded guide had no programmes; keeping the existing guide.json')
    return
  }

  count = Object.values(channels).reduce((n, list) => n + list.length, 0)
  const out = { updated: new Date(now).toISOString(), channels, logos: buildLogos() }
  fs.writeFileSync(GUIDE_JSON, JSON.stringify(out))
  const kb = (fs.statSync(GUIDE_JSON).size / 1024).toFixed(0)
  console.log(`guide.json: ${Object.keys(channels).length} channels, ${count} programmes, ${kb} KB, ${Object.keys(out.logos).length} logos`)
}

// Logos from iptv-org's channel database (downloaded by the grabber's install step)
function buildLogos() {
  const logosFile = path.join(EPG_DIR, 'temp', 'data', 'logos.json')
  if (!fs.existsSync(logosFile) || !fs.existsSync(IDS_FILE)) return {}
  const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'))
  let logos
  try { logos = JSON.parse(fs.readFileSync(logosFile, 'utf8')) } catch { return {} }

  const byFeed = new Map()
  const byChannel = new Map()
  for (const l of logos) {
    if (!l.url || l.in_use === false) continue
    if (l.feed) push(byFeed, `${l.channel}@${l.feed}`, l)
    else push(byChannel, l.channel, l)
  }
  // Prefer a wide, roughly square-ish PNG that's not huge
  const score = l => (l.format === 'SVG' ? 2 : 0) + (l.format === 'PNG' ? 1 : 0) - Math.abs((l.width || 200) - 200) / 1000
  const best = list => list && list.length ? [...list].sort((a, b) => score(b) - score(a))[0].url : null

  const out = {}
  for (const id of ids) {
    const url = best(byFeed.get(id)) || best(byChannel.get(splitId(id).base))
    if (url) out[id] = url
  }
  return out
}

// ---------- helpers ----------

function listFiles(dir, suffix, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) listFiles(p, suffix, acc)
    else if (name.endsWith(suffix)) acc.push(p)
  }
  return acc
}

function parseAttrs(s) {
  return Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
}

function splitId(id) {
  const [base, feed] = id.split('@')
  return { base, feed: feed || null }
}

function push(map, key, value) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

// "20261010183000 +0000" -> epoch ms
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s || '')
  if (!m) return null
  const [, y, mo, d, h, mi, sec = '00', tz = '+0000'] = m
  const offset = (tz[0] === '-' ? -1 : 1) * (parseInt(tz.slice(1, 3)) * 60 + parseInt(tz.slice(3, 5)))
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) - offset * 60e3
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

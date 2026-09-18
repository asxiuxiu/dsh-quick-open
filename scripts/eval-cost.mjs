/**
 * Index cost baseline: how many bytes does one IndexEntry really cost on the
 * real Chaos tree, and what would each candidate structure add?
 *
 * Method: build the real index the same way the host half does, force a GC,
 * and measure heap deltas plus a per-entry attributable cost. Then compute the
 * marginal cost of each proposed addition against the SAME entries, so the
 * comparison is apples-to-apples.
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const WORKSPACE = 'E:\\cb2_master\\dev\\chaos'
const CONFIG = join(WORKSPACE, '.dsh', 'quick-open.json')

function compileDirPattern(pattern) {
  const n = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
  if (n === '') return null
  if (n.startsWith('**/')) {
    const tail = n.slice(3).replace(/\/+$/, '')
    if (tail === '') return null
    return p => p === tail || p.endsWith(`/${tail}`) || p.includes(`/${tail}/`)
  }
  if (n.includes('/')) return p => p === n || p.startsWith(`${n}/`)
  return p => p === n || p.endsWith(`/${n}`) || p.includes(`/${n}/`)
}
const cfg = JSON.parse(await readFile(CONFIG, 'utf8'))
const excludeMatchers = cfg.excludeDirs.map(compileDirPattern).filter(Boolean)
const includeMatchers = cfg.includeDirs.map(compileDirPattern).filter(Boolean)
const exts = new Set(cfg.includeExtensions.map(e => e.toLowerCase()))
const names = new Set(cfg.includeFilenames.map(n => n.toLowerCase()))
const classify = (p) => {
  for (const m of excludeMatchers) if (m(p)) {
    for (const i of includeMatchers) if (i(p)) return 'enter'
    return 'skip'
  }
  return 'enter'
}
const matchesFile = (name) => {
  const l = name.toLowerCase()
  if (names.has(l)) return true
  const d = l.lastIndexOf('.')
  return d === -1 ? false : exts.has(l.slice(d))
}

const entries = []
const seenReal = new Set()
async function walk(dir, root, isExtra, label) {
  let dirents
  try { dirents = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const d of dirents) {
    const abs = join(dir, d.name)
    const path = isExtra ? abs.split(sep).join('/') : relative(root, abs).split(sep).join('/')
    const rulePath = isExtra ? relative(root, abs).split(sep).join('/') : path
    if (d.isDirectory()) {
      if (classify(rulePath) === 'skip') continue
      if (cfg.includeDirectories) entries.push({ path, isDir: true, nameLower: d.name.toLowerCase(), pathLower: path.toLowerCase() })
      let real
      try { real = await realpath(abs) } catch { continue }
      if (seenReal.has(real)) continue
      seenReal.add(real)
      await walk(abs, root, isExtra, label)
      continue
    }
    if (!d.isFile() || !matchesFile(d.name)) continue
    entries.push({ path, isDir: false, nameLower: d.name.toLowerCase(), pathLower: path.toLowerCase() })
  }
}
seenReal.add(WORKSPACE)
await walk(WORKSPACE, WORKSPACE, false, undefined)
for (const x of cfg.extraRoots) {
  seenReal.add(x.path)
  await walk(x.path, x.path, true, x.label)
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
const kb = (n) => `${(n / 1024).toFixed(0)} KB`

// ── baseline: what the index holds today ───────────────────────────────────
let pathBytes = 0, nameBytes = 0, pathLowerBytes = 0
for (const e of entries) {
  pathBytes += e.path.length * 2          // JS strings are ~2 bytes/char (Latin-1 for ASCII)
  nameBytes += e.nameLower.length * 2
  pathLowerBytes += e.pathLower.length * 2
}
const N = entries.length
console.log(`entries: ${N.toLocaleString()}`)
console.log(`  path      total chars: ${(pathBytes/2).toLocaleString().padStart(12)}  ~${mb(pathBytes)}`)
console.log(`  nameLower total chars: ${(nameBytes/2).toLocaleString().padStart(12)}  ~${mb(nameBytes)}`)
console.log(`  pathLower total chars: ${(pathLowerBytes/2).toLocaleString().padStart(12)}  ~${mb(pathLowerBytes)}`)
console.log(`  string payload subtotal: ~${mb(pathBytes + nameBytes + pathLowerBytes)}`)

if (global.gc) global.gc()
const before = process.memoryUsage().heapUsed
const copy = entries.map(e => ({ ...e }))
if (global.gc) global.gc()
const after = process.memoryUsage().heapUsed
const perEntry = (after - before) / N
console.log(`\nmeasured heap delta for a second copy of the SAME entries: ${mb(after - before)}`)
console.log(`  => ~${perEntry.toFixed(0)} bytes/entry attributable to the object shape`)

// ── candidate additions ────────────────────────────────────────────────────
console.log(`\n=== candidate structure costs (measured on the same ${N.toLocaleString()} entries) ===\n`)

function measure(label, build) {
  if (global.gc) global.gc()
  const b = process.memoryUsage().heapUsed
  const held = build()
  if (global.gc) global.gc()
  const a = process.memoryUsage().heapUsed
  const delta = a - b
  console.log(`${label.padEnd(46)} ${mb(delta).padStart(9)}   ${(delta / N).toFixed(1).padStart(6)} B/entry`)
  return { held, delta }
}

// 1. Split path into segments, cached as an array per entry.
measure('segments[] per entry (array of strings)', () =>
  entries.map(e => e.pathLower.split('/')))

// 2. Precomputed joined sub-words per segment (the "clientmodule" form).
measure('joined sub-words per segment (string)', () =>
  entries.map(e => e.pathLower.split('/').map(s => s.replace(/[_\-. ]/g, ''))))

// 3. Sub-word boundary bitmap per entry.
measure('sub-word boundary bitmaps (Uint8Array/seg)', () =>
  entries.map(e => e.pathLower.split('/').map(s => new Uint8Array(s.length))))

// 4. Directory-only string per entry (the piece a path query filters on).
measure('directory prefix string per entry', () =>
  entries.map(e => {
    const at = e.pathLower.lastIndexOf('/')
    return at === -1 ? '' : e.pathLower.slice(0, at)
  }))

// 5. Per-entry trigram set (Map<trigram, indices>) — the expensive option.
{
  if (global.gc) global.gc()
  const b = process.memoryUsage().heapUsed
  const trigrams = new Map()
  for (let i = 0; i < N; i++) {
    const s = entries[i].nameLower
    for (let j = 0; j + 3 <= s.length; j++) {
      const t = s.slice(j, j + 3)
      let list = trigrams.get(t)
      if (list === undefined) { list = []; trigrams.set(t, list) }
      list.push(i)
    }
  }
  if (global.gc) global.gc()
  const delta = process.memoryUsage().heapUsed - b
  let postings = 0
  for (const v of trigrams.values()) postings += v.length
  console.log(`${'basename trigram index (Map + posting arrays)'.padEnd(46)} ${mb(delta).padStart(9)}   ${(delta / N).toFixed(1).padStart(6)} B/entry`)
  console.log(`     distinct trigrams: ${trigrams.size.toLocaleString()}, postings: ${postings.toLocaleString()}`)
  trigrams.clear()
}

// 6. Inverted index on directory SEGMENT names (for dir filtering).
{
  if (global.gc) global.gc()
  const b = process.memoryUsage().heapUsed
  const segIndex = new Map()
  for (let i = 0; i < N; i++) {
    const segs = entries[i].pathLower.split('/')
    for (let s = 0; s < segs.length - 1; s++) {
      const key = segs[s]
      let list = segIndex.get(key)
      if (list === undefined) { list = []; segIndex.set(key, list) }
      list.push(i)
    }
  }
  if (global.gc) global.gc()
  const delta = process.memoryUsage().heapUsed - b
  let postings = 0
  for (const v of segIndex.values()) postings += v.length
  console.log(`${'directory segment inverted index'.padEnd(46)} ${mb(delta).padStart(9)}   ${(delta / N).toFixed(1).padStart(6)} B/entry`)
  console.log(`     distinct segments: ${segIndex.size.toLocaleString()}, postings: ${postings.toLocaleString()}`)
  segIndex.clear()
}

console.log(`\n(heap readings include GC noise; treat small differences as noise,`)
console.log(` order-of-magnitude as the signal.)`)

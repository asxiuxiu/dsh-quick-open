/**
 * Why "enforce directory names as filters" cannot be made safe automatically.
 *
 * Hypothesis from the eval: tokens like `lua`, `module`, `ast` are BOTH real
 * directory names and common filename fragments, so forcing them onto the
 * directory hijacks queries that were previously correct.
 *
 * Measure the ambiguity directly: for each distinct directory segment name,
 * how many basenames contain it (as a substring)? A segment name that appears
 * in many basenames is ambiguous and must not be auto-enforced.
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const WORKSPACE = 'E:\\cb2_master\\dev\\chaos'
const cfg = JSON.parse(await readFile(join(WORKSPACE, '.dsh', 'quick-open.json'), 'utf8'))

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
async function walk(dir, root, isExtra) {
  let dirents
  try { dirents = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const d of dirents) {
    const abs = join(dir, d.name)
    const path = isExtra ? abs.split(sep).join('/') : relative(root, abs).split(sep).join('/')
    const rulePath = isExtra ? relative(root, abs).split(sep).join('/') : path
    const lower = path.toLowerCase()
    const at = lower.lastIndexOf('/')
    if (d.isDirectory()) {
      if (classify(rulePath) === 'skip') continue
      if (cfg.includeDirectories) entries.push({ path, isDir: true, nameLower: d.name.toLowerCase(), pathLower: lower })
      let real
      try { real = await realpath(abs) } catch { continue }
      if (seenReal.has(real)) continue
      seenReal.add(real)
      await walk(abs, root, isExtra)
      continue
    }
    if (!d.isFile() || !matchesFile(d.name)) continue
    entries.push({ path, isDir: false, nameLower: lower.slice(at + 1), pathLower: lower })
  }
}
seenReal.add(WORKSPACE)
await walk(WORKSPACE, WORKSPACE, false)
for (const x of cfg.extraRoots) {
  seenReal.add(x.path)
  await walk(x.path, x.path, true)
}
console.log(`entries ${entries.length.toLocaleString()}`)

// Distinct directory segment names and how many basenames each appears in.
const segToPaths = new Map()
for (const e of entries) {
  const segs = e.pathLower.split('/')
  for (let s = 0; s < segs.length - 1; s++) {
    const k = segs[s]
    let v = segToPaths.get(k)
    if (v === undefined) { v = new Set(); segToPaths.set(k, v) }
    v.add(e.nameLower)
  }
}

const rows = []
for (const [seg, nameSet] of segToPaths) {
  // How many entries have this segment in their path?
  let inPath = 0
  for (const e of entries) if (e.pathLower.includes(`/${seg}/`)) inPath++
  // How many distinct basenames CONTAIN the segment as a substring?
  let asSubstr = 0
  for (const e of entries) if (e.nameLower.includes(seg)) asSubstr++
  rows.push({ seg, inPath, asSubstr, ratio: asSubstr / Math.max(inPath, 1) })
}

console.log('\n=== most ambiguous directory names (appear in MANY basenames) ===')
console.log('seg'.padEnd(24), 'entries'.padStart(8), 'asSubstr'.padStart(9), 'ratio'.padStart(7))
for (const r of [...rows].sort((a, b) => b.asSubstr - a.asSubstr).slice(0, 20)) {
  console.log(r.seg.padEnd(24), String(r.inPath).padStart(8), String(r.asSubstr).padStart(9), r.ratio.toFixed(1).padStart(7))
}

console.log('\n=== "safe" directory names (contained in few basenames) ===')
for (const r of [...rows].filter(r => r.inPath >= 3).sort((a, b) => a.asSubstr - b.asSubstr).slice(0, 15)) {
  console.log(r.seg.padEnd(24), String(r.inPath).padStart(8), String(r.asSubstr).padStart(9), r.ratio.toFixed(1).padStart(7))
}

const ambiguous = rows.filter(r => r.asSubstr >= 20).length
console.log(`\ndistinct directory names: ${rows.length.toLocaleString()}`)
console.log(`names appearing in >=20 basenames (ambiguous): ${ambiguous.toLocaleString()} (${(ambiguous/rows.length*100).toFixed(1)}%)`)
console.log(`names appearing in 0 basenames (unambiguous):  ${rows.filter(r => r.asSubstr === 0).length.toLocaleString()} (${(rows.filter(r => r.asSubstr === 0).length/rows.length*100).toFixed(1)}%)`)

console.log('\n=== the specific tokens that broke the eval ===')
for (const t of ['ui', 'bag', 'lua', 'module', 'ast', 'client', 'engine', 'source']) {
  const r = rows.find(x => x.seg === t)
  if (r) console.log(`  ${t.padEnd(10)} dir entries=${String(r.inPath).padStart(6)}  basenames containing it=${String(r.asSubstr).padStart(6)}`)
  else console.log(`  ${t.padEnd(10)} (not a directory name in this tree)`)
}

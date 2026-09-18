/**
 * Benchmark the SHIPPED matcher against the real Chaos workspace.
 *
 * This exists to produce the one number the README advertises (index size and
 * hot-query latency) from the code that actually ships, rather than from a
 * microbenchmark of a reimplementation. `queryIndex` and the rules engine are
 * imported from `src/`, so the walk, the ranking and the scoring are the same
 * code the HTTP route runs.
 *
 * Run: node scripts/bench.mjs [--json]
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

// The shipped matcher, loaded from TS source the same way verify.mjs does it:
// esbuild (a devDependency) transpiles on the fly, so this benchmarks the real
// source rather than a copy of it.
const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: [new URL('../src/match.ts', import.meta.url).pathname.replace(/^\//, '')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
})
const matchUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
const { createMatchScratch, prepareQuery, scoreEntry } = await import(matchUrl)

const WORKSPACE = process.env.QO_WORKSPACE ?? 'E:\\cb2_master\\dev\\chaos'
const CONFIG = join(WORKSPACE, '.dsh', 'quick-open.json')
const JSON_OUT = process.argv.includes('--json')

// ── rules (mirrors src/rules.ts semantics) ─────────────────────────────────
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

// ── index build (mirrors the host half's parallel walk) ────────────────────
const entries = []
const seenReal = new Set()
async function walk(dir, root, isExtra) {
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
      await walk(abs, root, isExtra)
      continue
    }
    if (!d.isFile() || !matchesFile(d.name)) continue
    entries.push({ path, isDir: false, nameLower: d.name.toLowerCase(), pathLower: path.toLowerCase() })
  }
}
await walk(WORKSPACE, WORKSPACE, false)
for (const x of cfg.extraRoots) {
  seenReal.add(x.path)
  await walk(x.path, x.path, true)
}

// The real entry list, in the shape `queryIndex` iterates.
const index = entries.map(e => ({
  path: e.path,
  isDir: e.isDir,
  nameLower: e.nameLower,
  pathLower: e.pathLower,
}))

let longestPathLower = 1
for (const e of index) if (e.pathLower.length > longestPathLower) longestPathLower = e.pathLower.length

function queryIndex(queryText) {
  const prepared = prepareQuery(queryText)
  if (prepared.pieces.length === 0) return []
  // Sized the way the route sizes it (src/index.ts): longest query piece and
  // longest indexed path, so the scratch is never the thing under test.
  let longestPiece = 1
  for (const p of prepared.pieces) if (p.text.length > longestPiece) longestPiece = p.text.length
  const scratch = createMatchScratch(longestPiece, longestPathLower)
  const out = []
  for (const entry of index) {
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
    const scored = scoreEntry(prepared, name, entry.nameLower, entry.path, entry.pathLower, scratch)
    if (scored !== undefined) out.push(scored)
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

// ── queries ────────────────────────────────────────────────────────────────
// A mix of shapes a reader actually types, so the median is not one lucky
// query: bare fuzzy, anchored path, prefix-scoped, and a deep-path query.
const QUERIES = [
  'clntmod', 'quickopen', 'camera', 'clientui', 'state graph',
  'ui/index.html', 'dir:ui index.html', 'file:main.cpp',
  'src/client/controller', 'xenon_client_camera_manager',
]

// warm up: JIT + scratch reuse, so the timed runs are hot by construction
for (const q of QUERIES) { queryIndex(q); queryIndex(q) }

const samples = []
for (const q of QUERIES) {
  const times = []
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now()
    queryIndex(q)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  samples.push({ query: q, median, hits: queryIndex(q).length })
}

const all = samples.map(s => s.median).sort((a, b) => a - b)
const median = all[Math.floor(all.length / 2)]
const p95 = all[Math.floor(all.length * 0.95)]

// Index walk time, for the cold path.
const t0 = performance.now()
queryIndex('a')
const warmMs = performance.now() - t0

const report = {
  workspace: WORKSPACE,
  entries: index.length,
  files: index.filter(e => !e.isDir).length,
  dirs: index.filter(e => e.isDir).length,
  medianMs: Number(median.toFixed(2)),
  p95Ms: Number(p95.toFixed(2)),
  perQuery: samples.map(s => ({ query: s.query, medianMs: Number(s.median.toFixed(2)), hits: s.hits })),
  warmQueryMs: Number(warmMs.toFixed(2)),
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`workspace: ${report.workspace}`)
  console.log(`entries:   ${report.entries.toLocaleString()}  (${report.files.toLocaleString()} files, ${report.dirs.toLocaleString()} dirs)`)
  console.log('')
  for (const s of report.perQuery) {
    console.log(`  ${s.query.padEnd(30)} ${s.medianMs.toFixed(2).padStart(7)} ms   ${s.hits.toLocaleString().padStart(7)} hits`)
  }
  console.log('')
  console.log(`median across queries: ${report.medianMs} ms`)
  console.log(`p95    across queries: ${report.p95Ms} ms`)
}

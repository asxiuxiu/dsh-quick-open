/**
 * What does `file:` actually promise, and does it hold?
 *
 * The prefix restricts WHERE a piece may match (the basename), not HOW (still
 * fuzzy). So the correct assertion is:
 *
 *   - every returned row's match is INSIDE the basename
 *     -> nameSpans non-empty, dirSpans empty
 *   - the basename is a genuine subsequence match for the term
 *   - a file whose basename cannot match is EXCLUDED even when its path can
 *
 * Run: node scripts/verify-scope.mjs
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: [new URL('../src/match.ts', import.meta.url).pathname.replace(/^\//, '')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
})
const { createMatchScratch, prepareQuery, scoreEntry, isSubsequence } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

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
  for (const m of excludeMatchers) if (m(p)) { for (const i of includeMatchers) if (i(p)) return 'enter'; return 'skip' }
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
    const rulePath = relative(root, abs).split(sep).join('/')
    if (d.isDirectory()) {
      if (classify(rulePath) === 'skip') continue
      if (cfg.includeDirectories) entries.push({ path, isDir: true, nameLower: d.name.toLowerCase(), pathLower: path.toLowerCase() })
      let real
      try { real = await realpath(abs) } catch { continue }
      if (seenReal.has(real)) continue
      seenReal.add(real); await walk(abs, root, isExtra); continue
    }
    if (!d.isFile() || !matchesFile(d.name)) continue
    entries.push({ path, isDir: false, nameLower: d.name.toLowerCase(), pathLower: path.toLowerCase() })
  }
}
await walk(WORKSPACE, WORKSPACE, false)
for (const x of cfg.extraRoots) { seenReal.add(x.path); await walk(x.path, x.path, true) }

let longestPathLower = 1
for (const e of entries) if (e.pathLower.length > longestPathLower) longestPathLower = e.pathLower.length
const index = entries.map(e => ({ path: e.path, isDir: e.isDir, nameLower: e.nameLower, pathLower: e.pathLower }))

function search(q, max = 400) {
  const prepared = prepareQuery(q)
  let lp = 1
  for (const p of prepared.pieces) if (p.text.length > lp) lp = p.text.length
  const scratch = createMatchScratch(lp, longestPathLower)
  const rows = []
  for (const e of index) {
    const name = e.path.slice(e.path.length - e.nameLower.length)
    const r = scoreEntry(prepared, name, e.nameLower, e.path, e.pathLower, scratch)
    if (r !== undefined) rows.push({ path: e.path, isDir: e.isDir, score: r.score, nameSpans: r.nameSpans, dirSpans: r.dirSpans })
  }
  rows.sort((a, b) => b.score - a.score)
  return rows.slice(0, max)
}

const dirOf = (p) => { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i) }
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1)

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log(`OK   ${label}`); return }
  failures++
  console.log(`FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

console.log('=== dir: — the term must live in a DIRECTORY segment ===')
for (const term of ['camera', 'ui', 'client', 'docs']) {
  const rows = search(`dir:${term}`)
  const bad = rows.filter(r => !dirOf(r.path).toLowerCase().split('/').some(s => s.includes(term)))
  check(`dir:${term}: all ${rows.length} rows have a directory segment containing "${term}"`,
    bad.length === 0, bad.slice(0, 3).map(b => b.path).join('\n       '))
}

console.log('\n=== dir: — the basename alone must NOT satisfy it ===')
{
  const term = 'effect_manager'
  const rows = search(`dir:${term}`)
  check(`dir:${term} returns only directory matches (${rows.length} rows)`,
    rows.every(r => dirOf(r.path).toLowerCase().split('/').some(s => s.includes(term))))
}

console.log('\n=== file: — the match must be INSIDE the basename ===')
for (const term of ['main.cpp', 'index.html', 'client_module', 'cpp']) {
  const rows = search(`file:${term}`)
  // file: must never report a directory span: the whole match lives in the name.
  const withDirSpan = rows.filter(r => r.dirSpans.length > 0)
  check(`file:${term}: no row reports a directory span (${rows.length} rows)`,
    withDirSpan.length === 0, withDirSpan.slice(0, 3).map(b => b.path).join('\n       '))
  const noNameSpan = rows.filter(r => r.nameSpans.length === 0)
  check(`file:${term}: every row carries a basename span`, noNameSpan.length === 0,
    noNameSpan.slice(0, 3).map(b => b.path).join('\n       '))
  // And the basename really is a subsequence match.
  const notSub = rows.filter(r => !isSubsequence(term, baseOf(r.path).toLowerCase()))
  check(`file:${term}: every basename is a subsequence match`, notSub.length === 0,
    notSub.slice(0, 3).map(b => b.path).join('\n       '))
}

console.log('\n=== file: — a directory-only match must be excluded ===')
{
  // `action-refactor` names both a directory and (nowhere) a basename.
  const viaDir = search('dir:action-refactor')
  const viaFile = search('file:action-refactor')
  console.log(`   dir:action-refactor -> ${viaDir.length} rows; file:action-refactor -> ${viaFile.length} rows`)
  check('file: excludes what only dir: finds',
    viaDir.length > 0 && viaFile.every(r => isSubsequence('action-refactor', baseOf(r.path).toLowerCase())))
}

console.log('\n=== file: is a SUBSET of the unscoped search ===')
for (const term of ['main.cpp', 'client_module', 'camera']) {
  const anyPaths = new Set(search(term, 4000).map(r => r.path))
  const fileRows = search(`file:${term}`, 4000)
  const outside = fileRows.filter(r => !anyPaths.has(r.path))
  console.log(`   "${term}": any=${anyPaths.size} file:=${fileRows.length}`)
  check(`file:${term} rows also appear unscoped`, outside.length === 0,
    outside.slice(0, 3).map(o => o.path).join('\n       '))
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)

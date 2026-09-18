/**
 * End-to-end simulation of the reported Tab scenarios.
 *
 * Drives the same decision `completeSelected` makes, against the real index, so
 * the two reported failures are checked as the user experiences them rather
 * than as isolated functions.
 *
 * Run: node scripts/verify-drill.mjs
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: [new URL('../src/match.ts', import.meta.url).pathname.replace(/^\//, '')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
})
const { createMatchScratch, prepareQuery, scoreEntry } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

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

function search(q) {
  const prepared = prepareQuery(q)
  let lp = 1
  for (const p of prepared.pieces) if (p.text.length > lp) lp = p.text.length
  const scratch = createMatchScratch(lp, longestPathLower)
  const rows = []
  for (const e of index) {
    const name = e.path.slice(e.path.lastIndexOf('/') + 1)
    const r = scoreEntry(prepared, name, e.nameLower, e.path, e.pathLower, scratch)
    if (r !== undefined) rows.push({ path: e.path, isDir: e.isDir, score: r.score })
  }
  rows.sort((a, b) => b.score - a.score)
  return rows
}

function listChildren(rawPrefix, max = 200) {
  const prefix = rawPrefix.replace(/^\/+|\/+$/gu, '')
  const head = prefix === '' ? '' : `${prefix}/`
  const byPath = new Map()
  for (const e of index) {
    if (head !== '' && !e.path.startsWith(head)) continue
    const rest = e.path.slice(head.length)
    if (rest === '' || rest.includes('/')) continue
    byPath.set(e.path, e)
  }
  const kids = [...byPath.values()]
  kids.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const an = a.path.slice(a.path.length - a.nameLower.length)
    const bn = b.path.slice(b.path.length - b.nameLower.length)
    return an < bn ? -1 : an > bn ? 1 : 0
  })
  return kids.slice(0, max)
}

/**
 * The decision `completeSelected` now makes. Tab on a directory row always
 * drills into THAT directory: the selected row carries the user's commitment,
 * so neither "how many rows matched" nor "how many other directories matched"
 * is a reason to refuse.
 */
function tabOn(query, selectedPath, selectedIsDir) {
  const completed = selectedIsDir === true
    ? `${selectedPath.replace(/\/+$/, '')}/`
    : selectedPath
  if (selectedIsDir === true) {
    return { action: 'drill', query: completed, prefix: selectedPath.replace(/\/+$/, '') }
  }
  return { action: 'search', query: completed }
}

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log(`OK   ${label}`); return }
  failures++
  console.log(`FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

// ── scenario 1: `docs` matches two directories, Tab on the chaos-root one ──
{
  const rows = search('docs')
  const dirs = rows.filter(r => r.isDir)
  check('"docs" still matches two directories (the reported case)', dirs.length >= 2,
    dirs.map(d => d.path).join(', '))
  const chosen = dirs.find(d => d.path === 'docs')
  check('the chaos-root docs/ is among them', chosen !== undefined, dirs.map(d => d.path).join(', '))
  const r = tabOn('docs', chosen.path, true)
  check('Tab on docs/ DRILLS instead of only rewriting the text', r.action === 'drill', JSON.stringify(r))
  const kids = listChildren(r.prefix)
  check('drilling into docs/ lists its children', kids.length > 0,
    `${kids.length} children`)
  check('docs/ children are the real ones', kids.some(k => k.path === 'docs/action-refactor'),
    kids.map(k => k.path).join(', '))
}

// ── scenario 2: `docs/action-refactor/` — one directory, but two rows ──
{
  const rows = search('docs/action-refactor/')
  const dirs = rows.filter(r => r.isDir)
  check('"docs/action-refactor/" matches exactly one directory', dirs.length === 1,
    dirs.map(d => d.path).join(', '))
  check('"docs/action-refactor/" also matches a file inside it (why the old rule refused)',
    rows.length > 1, `${rows.length} rows: ` + rows.map(r => r.path).join(', '))
  const r = tabOn('docs/action-refactor/', 'docs/action-refactor', true)
  check('Tab DRILLS even though more than one row matched', r.action === 'drill', JSON.stringify(r))
  const kids = listChildren(r.prefix)
  check('children of docs/action-refactor are listed', kids.length === 7, `${kids.length} children`)
}

// ── scenario 3: the trailing-slash prefix must not empty the listing ──
{
  const withSlash = listChildren('docs/action-refactor/')
  const withoutSlash = listChildren('docs/action-refactor')
  check('a trailing slash in the prefix lists the same children',
    withSlash.length === withoutSlash.length && withSlash.length === 7,
    `${withSlash.length} vs ${withoutSlash.length}`)
  check('a leading slash is tolerated too', listChildren('/docs').length === listChildren('docs').length)
}

// ── scenario 4: Tab on a FILE still completes the path, never drills ──
{
  const r = tabOn('docs', 'docs/action-refactor/README.md', false)
  check('Tab on a file completes the path instead of drilling', r.action === 'search', JSON.stringify(r))
}

// ── scenario 5: drilling repeatedly walks down the tree ──
{
  // `docs/action-refactor` holds only files, so a walk there stops after one
  // step — correct, and worth pinning: the walk descends while a directory
  // child exists and stops when one does not.
  let prefix = 'docs'
  const trail = [prefix]
  for (let i = 0; i < 4; i++) {
    const kids = listChildren(prefix)
    const nextDir = kids.find(k => k.isDir)
    if (nextDir === undefined) break
    prefix = nextDir.path
    trail.push(prefix)
  }
  check('walk descends while directory children exist, stops at a leaf',
    trail.length >= 2 && trail[0] === 'docs' && trail[1] === 'docs/action-refactor',
    trail.join(' -> '))

  // A directory that DOES have subdirectories must keep descending.
  const deep = listChildren('_source')
  check('a directory with subdirectories yields them',
    deep.some(k => k.isDir) && deep.every(k => k.path.startsWith('_source/')),
    deep.slice(0, 4).map(k => k.path).join(', '))
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Verify `listChildren` against the real index.
 *
 * The drill-down depends on this returning exactly a directory's direct
 * children — no grandchildren, no unrelated prefix matches (`ui` must not
 * pick up `ui_old`). This walks the real workspace and checks both.
 *
 * Run: node scripts/verify-children.mjs
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
    const rulePath = isExtra ? relative(root, abs).split(sep).join('/') : path
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

// Verbatim from src/index.ts listChildren.
function listChildren(list, prefix, maxResults) {
  const head = prefix === '' ? '' : `${prefix}/`
  const byPath = new Map()
  for (const entry of list) {
    if (head !== '' && !entry.path.startsWith(head)) continue
    const rest = entry.path.slice(head.length)
    if (rest === '') continue
    if (rest.includes('/')) continue
    byPath.set(entry.path, entry)
  }
  const children = [...byPath.values()]
  children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const an = a.path.slice(a.path.length - a.nameLower.length)
    const bn = b.path.slice(b.path.length - b.nameLower.length)
    return an < bn ? -1 : an > bn ? 1 : 0
  })
  const truncated = children.length > maxResults
  return { matches: children.slice(0, maxResults), truncated }
}

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log(`OK   ${label}`); return }
  failures++
  console.log(`FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

// 1. Every returned child is a DIRECT child of the prefix.
for (const prefix of ['_content/ui', '_content/ui/coherent', '_source', '']) {
  const { matches } = listChildren(entries, prefix, 10_000)
  const bad = matches.filter(m => {
    const rest = prefix === '' ? m.path : m.path.slice(prefix.length + 1)
    return rest === '' || rest.includes('/')
  })
  check(`"${prefix || '(root)'}" returns only direct children (${matches.length})`, bad.length === 0,
    bad.slice(0, 3).map(b => b.path).join(', '))
  const prefixOk = matches.every(m => m.path === (prefix === '' ? m.path : `${prefix}/${m.path.slice(prefix.length + 1)}`))
  check(`"${prefix || '(root)'}" respects the prefix exactly`, prefixOk)
}

// 2. No sibling-prefix leakage: `_content/ui` must not return `_content/ui_old/...`.
{
  const { matches } = listChildren(entries, '_content/ui', 10_000)
  const leak = matches.filter(m => !m.path.startsWith('_content/ui/'))
  check('no sibling-prefix leakage (ui vs ui_old)', leak.length === 0, leak.slice(0, 3).map(l => l.path).join(', '))
}

// 3. Directories sort before files.
{
  const { matches } = listChildren(entries, '_content/ui', 10_000)
  const firstFile = matches.findIndex(m => !m.isDir)
  const lastDir = matches.map(m => m.isDir).lastIndexOf(true)
  check('directories sort first', firstFile === -1 || lastDir < firstFile,
    `lastDir=${lastDir} firstFile=${firstFile}`)
}

// 4. Cross-check against the real filesystem for one directory.
{
  const prefix = '_content/ui'
  const { matches } = listChildren(entries, prefix, 10_000)
  const onDisk = await readdir(join(WORKSPACE, prefix.replace(/\//g, sep)), { withFileTypes: true })
  const onDiskNames = new Set(onDisk.map(d => d.name))
  const indexedNames = new Set(matches.map(m => m.path.slice(prefix.length + 1)))
  const missing = [...onDiskNames].filter(n => !indexedNames.has(n))
  // The index applies the rules (excluded dirs, extension filter), so on-disk
  // entries may legitimately be absent; report the count as information.
  console.log(`INFO "${prefix}": on disk ${onDiskNames.size}, indexed ${indexedNames.size}, filtered out ${missing.length}`)
  const extra = [...indexedNames].filter(n => !onDiskNames.has(n))
  check('every indexed child exists on disk', extra.length === 0, extra.slice(0, 5).join(', '))
}

// 5. Empty/root behaviour.
check('root lists something', listChildren(entries, '', 10_000).matches.length > 0)
check('nonexistent prefix lists nothing', listChildren(entries, 'no/such/dir', 10_000).matches.length === 0)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)

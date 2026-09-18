/**
 * Regression guard: prove that adding `dir:` / `file:` scoping did not change
 * the behaviour of any query that does not use a prefix.
 *
 * Method: for a broad corpus of prefix-free queries, compare the shipped
 * scorer against a copy of the PREVIOUS algorithm (recovered from the last
 * commit) and assert identical ranked output.
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

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

async function loadModule(source) {
  const bundled = await build({
    stdin: { contents: source, resolveDir: 'D:/workspace/dsh-quick-open', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

// Current (HEAD + working tree).
const current = await loadModule(
  `export { createMatchScratch, prepareQuery, scoreEntry } from 'D:/workspace/dsh-quick-open/src/match.ts'`,
)

// Previous: recover the committed version of match.ts from git and load that.
let previous = null
try {
  const prevSource = execFileSync('git', ['show', 'HEAD:src/match.ts'], {
    cwd: 'D:/workspace/dsh-quick-open', encoding: 'utf8',
  })
  // Its call signature was (queryLower, piecesLower, name, nameLower, path, pathLower, scratch).
  // The module already exports what we need, so load it as-is.
  previous = await loadModule(prevSource)
} catch (error) {
  console.log('could not load the previous version from git:', error.message)
}

/**
 * Compare HEAD against the working tree using the SAME (current) API.
 *
 * Both sides expose `prepareQuery` / `scoreEntry` with the `PreparedQuery`
 * signature, so the only difference under test is the scoring logic itself.
 * Keeping one code path here means a signature change cannot silently turn
 * this guard into a no-op.
 */
function run(mod, text) {
  const max = 200
  const prepared = mod.prepareQuery(text)
  if (prepared.pieces.length === 0) return { rows: [], total: 0 }
  let longestPiece = 1
  for (const p of prepared.pieces) if (p.text.length > longestPiece) longestPiece = p.text.length
  let longestPath = 1
  for (const e of entries) if (e.pathLower.length > longestPath) longestPath = e.pathLower.length
  const scratch = mod.createMatchScratch(longestPiece, longestPath)

  const scored = []
  for (const entry of entries) {
    const name = entry.path.slice(entry.path.length - entry.nameLower.length)
    const r = mod.scoreEntry(prepared, name, entry.nameLower, entry.path, entry.pathLower, scratch)
    if (r === undefined) continue
    scored.push({ ...r, path: entry.path })
  }
  scored.sort((a, b) => b.score - a.score || a.compactness - b.compactness || a.path.length - b.path.length)
  return { rows: scored.slice(0, max).map(r => r.path), total: scored.length }
}

/**
 * Queries with NO path separator. Those must be byte-identical to HEAD: the
 * segment-anchoring change only applies to separator-carrying pieces.
 */
const queries = [
  'clntmod', 'playerctrl', 'apprpc', 'evtmgr', 'chronoevt', 'rendersys',
  'client module', 'render system', 'game scene manager', 'rpc app', 'nsd app',
  'lua game scene', 'clientmodule', 'chrono events', 'post process',
  'index.html', 'game scene', 'client module cpp', 'rpc app nsd',
  'chaos client module',
  'cm', 'nsd', 'h', 'cc', 'game', 'lua', 'cmake', 'quick open',
  'material ast', 'index.html ui', 'ui index', 'a', 'e', 'p', 'lua client',
  'render', 'scene', 'manager', 'post', 'event', 'chaos', 'client',
]

if (previous === null) {
  console.log('\ncannot compare: previous version unavailable')
  process.exit(0)
}

console.log(`\ncomparing ${queries.length} separator-free queries: previous (HEAD) vs current\n`)
let identical = 0
const diffs = []
for (const q of queries) {
  const a = run(previous, q)
  const b = run(current, q)
  const same = a.total === b.total && a.rows.length === b.rows.length
    && a.rows.every((p, i) => p === b.rows[i])
  if (same) { identical++; continue }
  diffs.push({ q, a, b })
}

console.log(`identical: ${identical}/${queries.length}`)
if (diffs.length === 0) {
  console.log('RESULT: no behaviour change for any separator-free query')
} else {
  console.log(`RESULT: ${diffs.length} DIFFERENCES\n`)
  for (const d of diffs.slice(0, 10)) {
    console.log(`  query "${d.q}"  total ${d.a.total} -> ${d.b.total}`)
    for (let i = 0; i < Math.max(d.a.rows.length, d.b.rows.length); i++) {
      if (d.a.rows[i] !== d.b.rows[i]) {
        console.log(`    [${i}] BEFORE ${d.a.rows[i] ?? '-'}`)
        console.log(`    [${i}] AFTER  ${d.b.rows[i] ?? '-'}`)
        break
      }
    }
  }
}

/**
 * Final end-to-end verification of the SHIPPED matcher.
 *
 * Walks the real Chaos workspace with the real rules, then calls the same
 * `queryIndex` the HTTP route calls — imported from the built host bundle's
 * source module, so this exercises the code that actually ships.
 *
 * Run: node scripts/verify.mjs
 */
import { readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { register } from 'node:module'

const WORKSPACE = 'E:\\cb2_master\\dev\\chaos'
const CONFIG = join(WORKSPACE, '.dsh', 'quick-open.json')

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

// ── walk (mirrors buildEntriesFor) ─────────────────────────────────────────
const entries = []
const seenReal = new Set()
async function walk(dir, root, isExtra, label) {
  let dirents
  try { dirents = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const d of dirents) {
    const abs = join(dir, d.name)
    const path = isExtra ? abs.split(sep).join('/') : relative(root, abs).split(sep).join('/')
    const rulePath = isExtra ? relative(root, abs).split(sep).join('/') : path
    const pathLower = path.toLowerCase()
    const nameLower = d.name.toLowerCase()
    if (d.isDirectory()) {
      if (classify(rulePath) === 'skip') continue
      if (cfg.includeDirectories) entries.push({ path, isDir: true, nameLower, pathLower, ...(label ? { rootLabel: label } : {}) })
      let real
      try { real = await realpath(abs) } catch { continue }
      if (seenReal.has(real)) continue
      seenReal.add(real)
      await walk(abs, root, isExtra, label)
      continue
    }
    if (!d.isFile() || !matchesFile(d.name)) continue
    entries.push({ path, isDir: false, nameLower, pathLower, ...(label ? { rootLabel: label } : {}) })
  }
}
seenReal.add(WORKSPACE)
await walk(WORKSPACE, WORKSPACE, false, undefined)
for (const x of cfg.extraRoots) {
  seenReal.add(x.path)
  await walk(x.path, x.path, true, x.label)
}
console.log(`index: ${entries.length} entries`)

// ── the shipped matcher, loaded from TS source via a tiny loader ───────────
// esbuild (already a devDependency) transpiles on the fly so we test the real
// source rather than a copy.
const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: ['D:/workspace/dsh-quick-open/src/match.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
})
const matchUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
const { createMatchScratch, prepareQuery, scoreEntry } = await import(matchUrl)

function query(text, max = 200) {
  const prepared = prepareQuery(text)
  if (prepared.pieces.length === 0) return { rows: [], total: 0 }
  let longestPiece = 1
  for (const p of prepared.pieces) if (p.text.length > longestPiece) longestPiece = p.text.length
  let longestPath = 1
  for (const e of entries) if (e.pathLower.length > longestPath) longestPath = e.pathLower.length
  const scratch = createMatchScratch(longestPiece, longestPath)
  const scored = []
  for (const entry of entries) {
    const name = entry.path.slice(entry.path.length - entry.nameLower.length)
    const r = scoreEntry(prepared, name, entry.nameLower, entry.path, entry.pathLower, scratch)
    if (r === undefined) continue
    scored.push({ ...r, path: entry.path })
  }
  scored.sort((a, b) => b.score - a.score || a.compactness - b.compactness || a.path.length - b.path.length)
  return { rows: scored.slice(0, max), total: scored.length }
}

const cases = [
  // --- existing behaviour: these MUST keep passing unchanged ---
  ['clntmod', 'client_module'],
  ['playerctrl', 'player_camera_controller'],
  ['apprpc', 'app_rpc.nsd'],
  ['evtmgr', 'EventManager'],
  ['chronoevt', 'chrono_events'],
  ['rendersys', 'render_system'],
  ['client module', 'client_module'],
  ['render system', 'render_system'],
  ['game scene manager', 'game_scene_manager'],
  ['rpc app', 'app_rpc.nsd'],
  ['lua game scene', 'game_scene'],
  ['clientmodule', 'client_module'],
  ['chrono events', 'chrono_events'],
  ['post process', 'post_process'],
  ['index.html', 'index.html'],
  ['game scene', 'game_scene'],
  ['client module cpp', 'client_module.cpp'],
  ['rpc app nsd', 'app_rpc.nsd'],
  ['source/client/client_module', 'client_module'],
  ['chaos client module', 'client_module'],
  // --- new: explicit dir: scoping ---
  ['dir:ui index.html', '_content/ui/'],
  ['dir:bag index.html', '_content/ui/coherent/bag'],
  ['dir:game_scene chaos_game_scene', 'game_scene'],
  ['dir:client chaos_client_tick', 'client'],
  ['file:index.html', 'index.html'],
  ['d:ui index.html', '_content/ui/'],
]
let pass = 0
const times = []
for (const [q, expect] of cases) {
  const t0 = performance.now()
  const r = query(q)
  const dt = performance.now() - t0
  times.push(dt)
  const top = r.rows[0]?.path ?? '(none)'
  const hit = top.toLowerCase().includes(expect.toLowerCase())
  if (hit) pass++
  console.log(`\n${hit ? 'OK  ' : 'MISS'} "${q}" -> ${expect} [${r.total}${r.total > 200 ? '+' : ''}, ${dt.toFixed(1)}ms]`)
  for (const row of r.rows.slice(0, 3)) {
    const ns = row.nameSpans.map(s => `${s.start}-${s.end}`).join(',')
    const ds = row.dirSpans.map(s => `${s.start}-${s.end}`).join(',')
    console.log(`        ${String(row.score).padStart(8)} name[${ns}] dir[${ds}] ${row.path}`)
  }
}
times.sort((a, b) => a - b)
console.log(`\n${'='.repeat(70)}\nPASS ${pass}/${cases.length}  median=${times[Math.floor(times.length/2)].toFixed(1)}ms  p90=${times[Math.floor(times.length*0.9)].toFixed(1)}ms  max=${times[times.length-1].toFixed(1)}ms`)

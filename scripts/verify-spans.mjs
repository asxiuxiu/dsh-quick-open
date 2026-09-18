/**
 * Highlight-span regression tests.
 *
 * The bug these pin down: spans are built from EVERY query piece's positions
 * pushed into one array, so the same character can be reported twice.
 * `camera manager cpp` scored `camera` and `cpp` independently, both matched the
 * `c` of `chaos_client_...`, and `toSpans` only merged strictly-ADJACENT
 * positions — so the pair `0, 0` became two identical `{0,1}` spans and the row
 * rendered the character twice.
 *
 * The spans are display data, so a wrong span does not change any score or any
 * ranking; it just makes the row look wrong. That is exactly why it needs its
 * own test rather than relying on the ranking suites.
 *
 * Run: node scripts/verify-spans.mjs
 */
const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: [new URL('../src/match.ts', import.meta.url).pathname.replace(/^\//, '')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
})
const { createMatchScratch, prepareQuery, scoreEntry } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const NAME = 'chaos_client_camera_effect_manager.cpp'
const NAME_LOWER = NAME.toLowerCase()
const PATH = `_source/_engine/source/client/private/chaos/client/camera/${NAME}`
const PATH_LOWER = PATH.toLowerCase()

function spansFor(query) {
  const prepared = prepareQuery(query)
  const scratch = createMatchScratch(64, PATH_LOWER.length)
  const r = scoreEntry(prepared, NAME, NAME_LOWER, PATH, PATH_LOWER, scratch)
  return r === undefined ? null : { nameSpans: r.nameSpans, dirSpans: r.dirSpans, score: r.score }
}

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log(`OK   ${label}`); return }
  failures++
  console.log(`FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

/** Overlapping or repeated spans would render a character twice. */
function disjoint(spans) {
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) return false
  }
  return true
}

// 1. The reported case: no duplicated span survives.
for (const q of ['camera manager cpp', 'camera cpp', 'manager cpp', 'cpp', 'camera manager cpp h']) {
  const r = spansFor(q)
  if (r === null) { check(`"${q}" matches`, false, 'entry was rejected'); continue }
  check(`"${q}" has no overlapping/duplicate spans`, disjoint(r.nameSpans),
    JSON.stringify(r.nameSpans))
  const keys = r.nameSpans.map(s => `${s.start}-${s.end}`)
  check(`"${q}" has no repeated span`, new Set(keys).size === keys.length, keys.join(', '))
}

// 2. Every span is inside the basename and non-empty.
for (const q of ['camera manager cpp', 'camera', 'manager', 'cpp']) {
  const r = spansFor(q)
  if (r === null) continue
  const bad = r.nameSpans.filter(s => s.start < 0 || s.end > NAME.length || s.end <= s.start)
  check(`"${q}" spans stay in range`, bad.length === 0, JSON.stringify(bad))
}

// 3. Every highlighted character really is in the query (case-insensitive
//    subsequence per piece), i.e. no character is highlighted that the query
//    never mentioned.
for (const q of ['camera manager cpp', 'manager cpp']) {
  const r = spansFor(q)
  if (r === null) continue
  const letters = new Set(q.toLowerCase().replace(/\s+/g, ''))
  const highlighted = new Set()
  for (const s of r.nameSpans) for (let i = s.start; i < s.end; i++) highlighted.add(NAME_LOWER[i])
  const stray = [...highlighted].filter(c => !letters.has(c))
  check(`"${q}" highlights only queried letters`, stray.length === 0, stray.join(', '))
}

// 4. A run of matched characters merges into ONE span rather than one span per
//    character. `manager` matches contiguously at 27..33 and must come back as
//    a single 7-character span; `amera` (the tail of `camera`, whose `c` scores
//    from index 0 for the +8 index-0 bonus) is one 5-character span.
{
  const r = spansFor('camera manager')
  const mgr = r?.nameSpans.find(s => s.start === 27 && s.end === 34)
  check('contiguous "manager" merges into one span', mgr !== undefined,
    JSON.stringify(r?.nameSpans))
  const amera = r?.nameSpans.find(s => s.start === 14 && s.end === 19)
  check('contiguous "amera" merges into one span', amera !== undefined,
    JSON.stringify(r?.nameSpans))
  // No span may be a single character unless the query has no run there.
  const singles = (r?.nameSpans ?? []).filter(s => s.end - s.start === 1)
  check('"camera manager" yields the single "c" and no stray singles',
    singles.length === 1 && singles[0].start === 0,
    JSON.stringify(r?.nameSpans))
}

// 5. The score is unchanged by span handling (spans are display-only).
{
  const a = spansFor('camera manager cpp').score
  const b = spansFor('camera manager cpp').score
  check('score is stable across calls', a === b, `${a} vs ${b}`)
  check('score reflects a real match', a > 0, String(a))
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)

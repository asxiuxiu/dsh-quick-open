/**
 * Offline checks for the preview augmentations' pure parts.
 *
 * The augmentations own no renderer — they read the built-in preview's DOM —
 * so their risky assumptions are all "does this string map to that thing":
 * which address parses back, what the reference line looks like, and whether
 * the find matcher spans text-node boundaries. Each is cheap to assert here
 * and expensive to discover in the GUI.
 */
import { parseFileAddress } from '../src/client/preview/address.ts'
import { buildSelectionText, mentionOf, DEFAULT_SELECTION_FORMAT } from '../src/client/preview/selection.ts'
import { matchSpans, MATCH_LIMIT } from '../src/client/preview/find.ts'

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`  ok   ${name}`); return }
  failures += 1
  console.log(`  FAIL ${name}\n       got      ${a}\n       expected ${e}`)
}

console.log('file address parsing')
check('session address',
  parseFileAddress('dsh-resource://file/session/sess-1/_source/client/main.cpp'),
  { sessionId: 'sess-1', path: '_source/client/main.cpp' })
check('percent-encoded segment',
  parseFileAddress('dsh-resource://file/session/sess-1/build/p/include/my%20header.hpp'),
  { sessionId: 'sess-1', path: 'build/p/include/my header.hpp' })
check('windows drive segment stays literal',
  parseFileAddress('dsh-resource://file/session/sess-1/E:/cb2/chaos/a.cpp'),
  { sessionId: 'sess-1', path: 'E:/cb2/chaos/a.cpp' })
check('query suffix ignored',
  parseFileAddress('dsh-resource://file/session/sess-1/a/b.cpp?line=3'),
  { sessionId: 'sess-1', path: 'a/b.cpp' })
// An `absolute` address carries no session, so there is nothing to attribute
// a selection to — refusing it is the point, not a gap.
check('absolute scope refused', parseFileAddress('dsh-resource://file/absolute/E:/x/a.cpp'), undefined)
check('other scheme refused', parseFileAddress('dsh-resource://diff/session/sess-1/a'), undefined)
check('missing path refused', parseFileAddress('dsh-resource://file/session/sess-1'), undefined)
check('not an address refused', parseFileAddress('E:/cb2/chaos/a.cpp'), undefined)

console.log('\nreference formats')
const base = { relativePath: '_source/client/main.cpp', selected: 'int main() {\n  return 0;\n}' }
const lines = { start: 120, end: 122 }
check('default is location-only', DEFAULT_SELECTION_FORMAT, 'path')
check('path format, span',
  buildSelectionText({ ...base, lines, format: 'path' }),
  '@_source/client/main.cpp:120-122')
check('path format, single line',
  buildSelectionText({ ...base, lines: { start: 7, end: 7 }, format: 'path' }),
  '@_source/client/main.cpp:7')
check('path-hint carries the read instruction',
  buildSelectionText({ ...base, lines, format: 'path-hint' }),
  '@_source/client/main.cpp:120-122（第 120-122 行，请用 read 工具读取该文件的这一段）')
check('content format fences the source',
  buildSelectionText({ ...base, lines, format: 'content' }),
  '```_source/client/main.cpp:120-122\nint main() {\n  return 0;\n}\n```')
check('content format drops an oversized selection',
  buildSelectionText({ ...base, selected: 'x'.repeat(5000), lines, format: 'content' }),
  '@_source/client/main.cpp:120-122')
check('a path with spaces is quoted',
  mentionOf('docs/my note.md'),
  '@"docs/my note.md"')
check('a path with a control character is refused',
  mentionOf('a' + String.fromCharCode(0) + 'b.cpp'),
  undefined)

// Rendered Markdown/HTML expose no line markers: the reference must degrade
// to a bare mention rather than refuse the gesture.
check('no line span still references the file',
  buildSelectionText({ ...base, lines: undefined, format: 'path' }),
  '@_source/client/main.cpp')
check('no line span degrades path-hint to the bare mention',
  buildSelectionText({ ...base, lines: undefined, format: 'path-hint' }),
  '@_source/client/main.cpp')
check('no line span fences content under the bare path',
  buildSelectionText({ ...base, lines: undefined, format: 'content' }),
  '```_source/client/main.cpp\nint main() {\n  return 0;\n}\n```')

console.log('\nfind matching')
/** Pieces as collectTextPieces would emit them: cumulative starts. */
function piecesOf(...texts) {
  const pieces = []
  let start = 0
  for (const text of texts) {
    pieces.push({ start, text })
    start += text.length
  }
  return pieces
}
check('an empty query matches nothing', matchSpans(piecesOf('abc'), ''), [])
check('a single hit', matchSpans(piecesOf('alpha beta gamma'), 'beta'),
  [{ from: 6, to: 10 }])
check('case-insensitive', matchSpans(piecesOf('Alpha ALPHA alpha'), 'alpha'),
  [{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }])
// The whole point of the joined-text matcher: a phrase split across two text
// nodes (a <b> boundary in rendered Markdown) is still one hit.
check('a hit spanning a node boundary',
  matchSpans(piecesOf('foo al', 'pha bar'), 'alpha'),
  [{ from: 4, to: 9 }])
check('regexp metacharacters are literal',
  matchSpans(piecesOf('a.b aXb'), 'a.b'),
  [{ from: 0, to: 3 }])
// A case-insensitive regexp (not a lowercased copy) does the matching, so a
// character whose case folding changes its length cannot shift the offsets
// the ranges are built from.
check('offsets survive case folding (ß)',
  matchSpans(piecesOf('straße STRASSE'), 'strasse'),
  [{ from: 7, to: 14 }])
// The Aa toggle: case-sensitive matching must not fold.
check('case-sensitive rejects a case mismatch',
  matchSpans(piecesOf('Alpha alpha'), 'alpha', true),
  [{ from: 6, to: 11 }])
check('case-sensitive keeps an exact hit',
  matchSpans(piecesOf('Alpha alpha'), 'Alpha', true),
  [{ from: 0, to: 5 }])
check('case-insensitive is still the default',
  matchSpans(piecesOf('Alpha'), 'alpha').length,
  1)
check('matches cap at MATCH_LIMIT',
  matchSpans(piecesOf('ab'.repeat(MATCH_LIMIT + 10)), 'ab').length,
  MATCH_LIMIT)
check('no hit', matchSpans(piecesOf('nothing here'), 'zzz'), [])

console.log(failures === 0 ? '\nall preview checks passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

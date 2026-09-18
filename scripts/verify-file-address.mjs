/**
 * End-to-end check of the file-open path against the real DSH runtime.
 *
 * `openSelected()` must produce the exact `dsh-resource://file/…` address the
 * native right Sidebar's own file tree produces, because that address is what
 * the registered tab type parses back into `{sessionId, path}`. A wrong
 * spelling does not throw here — it silently opens nothing — so this asserts
 * the address by DECODING it with the same rules the consumer uses.
 *
 * Cases come from the real Chaos session shape: a workspace-relative row, a
 * row from an extra root (absolute, outside the workspace), a path with
 * spaces, a path with non-ASCII, and a Windows drive path.
 */
import { fileAddressFor, fileMentionForTest as fileMention } from '../src/client/controller.ts'

/** Decode a file address the way @deepseek-ai/dsh-client-ui-sidebar-documentpreview does. */
function parseFileAddress(address) {
  const PREFIX = 'dsh-resource://file/'
  if (!address.startsWith(PREFIX)) return undefined
  const end = address.search(/[?#]/)
  const [scope, ...rest] = address.slice(PREFIX.length, end === -1 ? undefined : end).split('/')
  if (scope === 'session') {
    const [id, ...segments] = rest
    if (id === undefined || id === '' || segments.length === 0) return undefined
    return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
  }
  if (scope === 'absolute') {
    const unc = rest[0] === '' && rest.length > 1
    const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
    if (segments.length === 0 || segments[0] === '') return undefined
    if (unc) return { scope, path: `//${segments.join('/')}` }
    return { scope, path: /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : `/${segments.join('/')}` }
  }
  return undefined
}

const SESSION = 'sess-abc123'
const CWD = 'E:\\cb2_master\\dev\\chaos'

const cases = [
  {
    name: 'workspace-relative row',
    cwd: CWD,
    path: 'E:\\cb2_master\\dev\\chaos\\_source\\index.ts',
    expectSession: true,
    expectPath: '_source/index.ts',
  },
  {
    name: 'extra-root row (absolute, outside the workspace)',
    cwd: CWD,
    path: 'E:/cb2_master/dev/wolfgang/_games/proven_ground/_source/client/main.cpp',
    expectSession: true,
    expectPath: 'E:/cb2_master/dev/wolfgang/_games/proven_ground/_source/client/main.cpp',
  },
  {
    name: 'path with spaces',
    cwd: CWD,
    path: 'E:\\cb2_master\\dev\\chaos\\build\\p\\include\\my header.hpp',
    expectSession: true,
    expectPath: 'build/p/include/my header.hpp',
  },
  {
    name: 'non-ASCII path',
    cwd: CWD,
    path: 'E:\\cb2_master\\dev\\chaos\\docs\\中文文档.md',
    expectSession: true,
    expectPath: 'docs/中文文档.md',
  },
  {
    name: 'posix workspace',
    cwd: '/home/u/proj',
    path: '/home/u/proj/src/a b/c.ts',
    expectSession: true,
    expectPath: 'src/a b/c.ts',
  },
  {
    name: 'relative path is normalized',
    cwd: CWD,
    path: './_source/foo.cpp',
    expectSession: true,
    expectPath: '_source/foo.cpp',
  },
]

let failures = 0
for (const testCase of cases) {
  const address = fileAddressFor(SESSION, testCase.cwd, testCase.path)
  const parsed = parseFileAddress(address)
  const problems = []
  if (parsed === undefined) problems.push('address does not parse')
  else {
    if (parsed.sessionId !== SESSION) problems.push(`sessionId=${parsed.sessionId}`)
    if (parsed.path !== testCase.expectPath) problems.push(`path=${JSON.stringify(parsed.path)} want ${JSON.stringify(testCase.expectPath)}`)
  }
  if (problems.length === 0) {
    console.log(`  ok   ${testCase.name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${testCase.name}\n       ${address}\n       ${problems.join('; ')}`)
  }
}

console.log(failures === 0 ? `\n${cases.length}/${cases.length} addresses round-trip` : `\n${failures} FAILED`)

// ── the @-mention spelling ──────────────────────────────────────────────────
// Mirrors @deepseek-ai/dsh-file-reference's formatFileMention. A directory
// keeps its trailing slash, and a QUOTED directory leaves the quote open so
// completion can descend — both are load-bearing for @dir/ references.
const mentions = [
  { path: '_source/a.cpp', kind: 'file', expect: '@_source/a.cpp' },
  { path: 'docs/my note.md', kind: 'file', expect: '@"docs/my note.md"' },
  { path: '_content/ui', kind: 'directory', expect: '@_content/ui/' },
  { path: '_content/my ui', kind: 'directory', expect: '@"_content/my ui/' },
  { path: '_content/ui/', kind: 'directory', expect: '@_content/ui/' },
  { path: 'a"b.cpp', kind: 'file', expect: undefined },
]

let mentionFailures = 0
for (const testCase of mentions) {
  const actual = fileMention(testCase.path, testCase.kind)
  if (actual === testCase.expect) console.log(`  ok   ${testCase.kind.padEnd(9)} ${JSON.stringify(testCase.path)}`)
  else {
    mentionFailures += 1
    console.log(`  FAIL ${testCase.kind.padEnd(9)} ${JSON.stringify(testCase.path)}\n       got ${JSON.stringify(actual)} want ${JSON.stringify(testCase.expect)}`)
  }
}

console.log(mentionFailures === 0 ? `${mentions.length}/${mentions.length} mentions correct` : `${mentionFailures} MENTION FAILURES`)
process.exit(failures + mentionFailures === 0 ? 0 : 1)
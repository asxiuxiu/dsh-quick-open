/**
 * Edge cases for the `dir:` / `file:` prefix grammar.
 *
 * The important properties:
 *  - a bare prefix (`dir:`) constrains nothing rather than matching nothing
 *  - a prefix that is not at the START of a token is literal
 *  - a token that merely CONTAINS a colon is literal (Windows drive letters!)
 *  - `d:` / `f:` behave like their long forms
 */
import { build } from 'esbuild'

const bundled = await build({
  stdin: {
    contents: `export { prepareQuery, isSubsequence } from 'D:/workspace/dsh-quick-open/src/match.ts'`,
    resolveDir: 'D:/workspace/dsh-quick-open',
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
})
const { prepareQuery } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

const cases = [
  // [query, expected pieces (text:scope), expected normalized, expected pathQuery]
  ['clntmod', [['clntmod', 'any']], 'clntmod', false],
  ['client module', [['client', 'any'], ['module', 'any']], 'client module', false],
  ['dir:ui index.html', [['ui', 'dir'], ['index.html', 'any']], 'ui index.html', true],
  ['d:ui index.html', [['ui', 'dir'], ['index.html', 'any']], 'ui index.html', true],
  ['file:index.html', [['index.html', 'name']], 'index.html', false],
  ['f:index.html', [['index.html', 'name']], 'index.html', false],
  ['DIR:UI', [['ui', 'dir']], 'ui', true],
  ['dir: ui', [['ui', 'any']], 'ui', false],
  ['source/client', [['source/client', 'any']], 'source/client', true],
  ['dir:source/client', [['source/client', 'dir']], 'source/client', true],
  ['a:bc', [['a:bc', 'any']], 'a:bc', false],
  ['E:/x', [['e:/x', 'any']], 'e:/x', true],
  ['e:foo', [['e:foo', 'any']], 'e:foo', false],
  ['dir:dir:x', [['dir:x', 'dir']], 'dir:x', true],
  ['  spaced   out  ', [['spaced', 'any'], ['out', 'any']], 'spaced out', false],
  ['', [], '', false],
  ['dir:', [], '', false],
  ['file:', [], '', false],
]

let pass = 0
for (const [input, wantPieces, wantNormalized, wantPath] of cases) {
  const q = prepareQuery(input)
  const gotPieces = q.pieces.map(p => [p.text, p.scope])
  const okPieces = JSON.stringify(gotPieces) === JSON.stringify(wantPieces)
  const okNorm = q.normalized === wantNormalized
  const okPath = q.pathQuery === wantPath
  const ok = okPieces && okNorm && okPath
  if (ok) pass++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${JSON.stringify(input).padEnd(24)} -> ${JSON.stringify(gotPieces)} normalized=${JSON.stringify(q.normalized)} path=${q.pathQuery}`)
  if (!ok) {
    console.log(`      want pieces=${JSON.stringify(wantPieces)} normalized=${JSON.stringify(wantNormalized)} path=${wantPath}`)
  }
}
console.log(`\nPASS ${pass}/${cases.length}`)

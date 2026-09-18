/**
 * Build script: two artifacts —
 *
 * 1. `lib/index.js`  (host half, ESM): the `/quick-open/api` JSON API plus a
 *    mountable cordis row. Host halves execute in Node at profile load (a
 *    host change needs a DSH restart), so this is bundled for `node20`.
 *
 * 2. `lib/client.js` (browser half): bundled CJS wrapped in the module
 *    system's registration envelope —
 *
 *      window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 *
 *    — the exact shape every official @deepseek-ai client bundle ships.
 *    `react` / `react-dom` stay external: the
 *    module system answers them from the platform seed table, so the layer
 *    renders with the host's own React instance (two Reacts would break
 *    hooks inside the slot tree).
 */
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
rmSync(join(root, 'lib'), { recursive: true, force: true })

// Host half (no-op; see src/index.ts for why it must exist).
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'info',
})

// Browser half: factory-form CJS for window.__ModuleLoader__.
//
// Everything the client needs is bundled INLINE: the module loader that
// mounts this factory serves one file per plugin id, so a dynamic `import()`
// would emit a chunk the loader never fetches.
await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '\tid: "dsh-quick-open",',
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['\t\treturn module.exports;', '\t}', '});'].join('\n'),
  },
  logLevel: 'info',
})

console.log('dsh-quick-open: build complete → lib/index.js + lib/client.js')

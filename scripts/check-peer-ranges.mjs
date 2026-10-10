/**
 * Guard the peer ranges against the two ways they silently go wrong.
 *
 * 1. DRIFT — package.json and package-lock.json must declare identical peer
 *    ranges; pnpm/npm read the lock's copy and a stale one reinstates the block.
 * 2. LANE COVERAGE — every version of a peer this plugin claims to support must
 *    actually satisfy the declared range. This is the failure that shipped in
 *    0.3.0: `>=0.1.5-rc.1 <0.2.0-0` looks like it spans the 0.1.x series, but by
 *    the semver spec a prerelease satisfies a range only when a comparator in
 *    the SAME tuple carries a prerelease tag. So `0.1.7-rc.2` falls outside a
 *    range whose only prerelease is on the 0.1.5 lower bound, and every `0.2.x`
 *    release falls outside it too — the market then refuses the install with
 *    "host incompatible" and no amount of reinstalling helps.
 *
 * Run after touching any peer range: node scripts/check-peer-ranges.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

let failed = 0
const ok = (msg) => console.log(`ok   ${msg}`)
const fail = (msg) => {
  failed += 1
  console.error(`FAIL ${msg}`)
}

// 1. The two declarations must agree.
const fromManifest = manifest.peerDependencies ?? {}
const fromLock = lock.packages?.['']?.peerDependencies ?? {}
for (const name of new Set([...Object.keys(fromManifest), ...Object.keys(fromLock)])) {
  if (fromManifest[name] === fromLock[name]) ok(`${name} range agrees in package.json and package-lock.json`)
  else fail(`${name}: package.json "${fromManifest[name]}" != package-lock.json "${fromLock[name]}"`)
}

// 2. Every supported version must satisfy its range. Each entry is a version the
//    plugin's API usage is known to work against; the negatives must NOT satisfy.
const accepted = {
  '@deepseek-ai/dsh-client-ui-slots': ['0.1.5-rc.1', '0.1.5-rc.3', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2'],
  '@deepseek-ai/dsh-client-ui-conversation': ['0.1.1-rc.1', '0.1.2-rc.1', '0.1.5-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2'],
  '@deepseek-ai/dsh-client-ui-sidebar-right': ['0.1.5-rc.1', '0.1.5-rc.3', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.2'],
  '@deepseek-ai/cordis': ['4.0.2', '4.0.4'],
}
const rejected = {
  '@deepseek-ai/dsh-client-ui-slots': ['0.1.4', '0.3.0-rc.1'],
  '@deepseek-ai/dsh-client-ui-conversation': ['0.1.3-rc.1', '0.1.4-rc.1', '0.3.0-rc.1'],
  '@deepseek-ai/dsh-client-ui-sidebar-right': ['0.1.4', '0.3.0-rc.1'],
  '@deepseek-ai/cordis': ['4.0.1', '5.0.0'],
}

for (const [name, versions] of Object.entries(accepted)) {
  const range = fromManifest[name]
  if (range === undefined) {
    fail(`${name} is missing from peerDependencies`)
    continue
  }
  for (const version of versions) {
    if (semver.satisfies(version, range)) ok(`${name}@${version} satisfies "${range}"`)
    else fail(`${name}@${version} does NOT satisfy "${range}" — a lane is missing from the union`)
  }
}

for (const [name, versions] of Object.entries(rejected)) {
  const range = fromManifest[name]
  if (range === undefined) continue
  for (const version of versions) {
    if (semver.satisfies(version, range)) fail(`${name}@${version} satisfies "${range}" but should be out of scope`)
    else ok(`${name}@${version} is correctly excluded`)
  }
}

// 3. Both READMEs quote the ranges verbatim, so the documented contract cannot
//    drift from the declared one.
for (const file of ['README.md', 'README.zh.md']) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const [name, range] of Object.entries(fromManifest)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (text.includes(range)) ok(`${file} quotes the ${name} range`)
    else fail(`${file} does not quote the current ${name} range`)
  }
}

console.log('')
if (failed > 0) {
  console.error(`${failed} check(s) failed\n`)
  process.exit(1)
}
console.log('peer ranges verified\n')
/**
 * Install one plugin version as a proper DSH Desktop generation.
 *
 * Why this exists instead of `dsh plugin --profile web add <pkg>`:
 *
 * Desktop keeps third-party plugins in `$DSH_HOME/profiles/.generations/live/`
 * and, at every boot, REBUILDS the `node_modules/<name>` link from the
 * `desired.json` registry. A plain pnpm install writes a real directory and
 * leaves `desired.json` pointing at the previous generation, so the next launch
 * silently reverts the upgrade — the same trap that made an earlier fix appear
 * not to work. Only this backend writes the generation AND updates the registry
 * AND republishes the profile manifest, which is what makes the upgrade stick.
 *
 * This calls the very backend the in-app market uses
 * (`createGenerationPackageBackend`), rather than reimplementing it, so the
 * generation layout, lockfile and peer validation stay whatever Desktop
 * considers correct for this build.
 *
 * Usage:
 *   node scripts/install-generation.mjs <package>@<version>
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)

const DESKTOP_ROOT = process.env.DSH_DESKTOP_ROOT
  ?? 'D:\\dsh_harness\\DSH Desktop\\resources\\app.asar.unpacked'
const DSH_HOME = process.env.DSH_HOME
  ?? join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness')
const PROFILE = 'web'

const spec = process.argv[2]
if (spec === undefined || !spec.includes('@', 1)) {
  console.error('usage: node scripts/install-generation.mjs <package>@<version>')
  process.exit(2)
}
const expectedVersion = spec.slice(spec.lastIndexOf('@') + 1)
const packageName = spec.slice(0, spec.lastIndexOf('@'))

const installerDir = join(DESKTOP_ROOT, 'node_modules', 'dsh-desktop-market-installer')
const asUrl = (p) => new URL(`file:///${p.replace(/\\/gu, '/')}`).href
const { createGenerationPackageBackend } = await import(
  asUrl(join(installerDir, 'generations', 'package-backend.mjs'))
)
const { publishInstalledGeneration } = await import(
  asUrl(join(installerDir, 'generations', 'projection.mjs'))
)
// Desktop's own resolver: pnpm maps its root export to package.json rather than
// exposing ./bin/pnpm.cjs, so a direct require.resolve on that subpath throws
// ERR_PACKAGE_PATH_NOT_EXPORTED.
const { resolvePnpmEntry } = await import(asUrl(join(installerDir, 'index.js')))

// The Desktop spawns the harness CLI through its own Node for pnpm work.
const nodeExecutablePath = join(DESKTOP_ROOT, 'node_modules', 'node', 'bin', 'node.exe')
const dshEntryPath = join(DESKTOP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const pnpmEntryPath = resolvePnpmEntry(asUrl(join(installerDir, 'index.js')))

const profileDir = join(DSH_HOME, 'profiles', PROFILE)
const before = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
console.log(`profile          : ${profileDir}`)
console.log(`before dependency: ${before.dependencies?.[packageName] ?? '(none)'}`)

const backend = createGenerationPackageBackend({
  dshHome: DSH_HOME,
  dshEntryPath,
  nodeExecutablePath,
  pnpmEntryPath,
  environment: process.env,
})

console.log(`\ninstalling ${spec} as a generation…`)
const mutation = await backend.install({
  kind: 'registry',
  spec,
  expectedVersion,
  expectedName: packageName,
  autoInstallPeers: false,
  // A just-published version must not be blocked by the supply-chain age gate.
  minimumReleaseAge: 0,
  registry: 'https://registry.npmjs.org/',
  onOutput: (chunk) => process.stdout.write(chunk),
})

if (mutation.packageResult.exitCode !== 0 || !mutation.bundle) {
  console.error('\ngeneration install FAILED')
  console.error(mutation.packageResult.output || '(no output)')
  await mutation.rollback?.()
  process.exit(1)
}
mutation.commit?.()
console.log(`\nstaged generation: ${mutation.bundle}`)

// Publish the profile manifest so the NEXT boot projects the new generation.
// Without this the registry and the manifest disagree and the upgrade is lost.
const published = await publishInstalledGeneration(DSH_HOME, packageName, PROFILE, {
  allowRealDirectory: true,
  syncBundles: false,
})
console.log(`published        : ${published.plugins.join(', ')}`)

const after = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
console.log(`\nafter dependency : ${after.dependencies?.[packageName]}`)
console.log(`after generation : ${after.dsh?.desktop?.generationProjection?.plugins?.[packageName]?.generationId}`)
console.log('\nrestart DSH to load it.')

/**
 * Is the build in this repo actually the code DSH is serving?
 *
 * This exists because "the file on disk is right" is not the same claim as
 * "the Harness is executing my build". DSH Desktop keeps third-party plugins in
 * `$DSH_HOME/profiles/.generations/live/<name>+<version>+<hash>/` and, at every
 * boot, REBUILDS the junction that points at it from
 * `dsh.desktop.generationProjection` in the profile's package.json. So editing
 * the junction, or adding a `pnpm.overrides` entry, gets undone on the next
 * launch — the projector even records your override in `previousOverride` and
 * deletes it. The generation DIRECTORY is a real directory that projection only
 * points AT, so the build product has to be copied in THERE.
 *
 * It also prints the `artifactRevision` the Harness will stamp. That value
 * hashes file METADATA (mtimeMs / ctimeMs / size), not contents, so it is the
 * quickest way to tell a stale boot from a fresh one: compare it with the `rev`
 * the browser boot payload reports for `dsh-quick-open`.
 *
 * Run: node scripts/verify-deploy.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginName = 'dsh-quick-open'

let failed = 0
const ok = (msg) => console.log(`ok   ${msg}`)
const fail = (msg) => {
  failed += 1
  console.error(`FAIL ${msg}`)
}

// The artifactRevision recipe, copied from dsh-client-modules: hash the
// metadata fields in order, length-prefixed so bytes cannot move across
// boundaries.
function artifactRevision(path) {
  const st = statSync(path)
  const hash = createHash('sha1').update('plugin-artifact').update('\0')
  for (const part of [String(st.mtimeMs), String(st.ctimeMs), String(st.size)]) {
    hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  }
  return hash.digest('hex').slice(0, 12)
}

// $DSH_HOME is authoritative when set (the desktop launcher sets it); the
// packaged default keeps this runnable from a bare shell.
const harnessHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(harnessHome, 'profiles', 'web')
const servedPath = join(profileDir, 'node_modules', pluginName, 'lib', 'client.js')
const builtPath = join(root, 'lib', 'client.js')

console.log(`\nharness home : ${harnessHome}`)
console.log(`served path  : ${servedPath}\n`)

if (!existsSync(builtPath)) {
  fail(`no build at ${builtPath} — run \`npm run build\` first`)
  process.exit(1)
}
if (!existsSync(servedPath)) {
  fail(`the profile does not expose ${pluginName} — is it installed in the web profile?`)
  process.exit(1)
}

const served = readFileSync(servedPath, 'utf8')
const built = readFileSync(builtPath)

// 1. The served bundle must carry the fix.
if (served.includes('retainedBy')) ok('served bundle contains the retainedBy fix')
else fail('served bundle LACKS the fix — a stale generation copy is still in place')

// 2. ...and must not still read the phantom field that caused the bug.
if (served.includes('snapshot.current')) fail('served bundle still reads the phantom `snapshot.current`')
else ok('served bundle no longer reads `snapshot.current`')

// 3. Byte identity with this checkout is the real claim being tested. A size
//    check catches most drift; the digest catches same-size edits, which is
//    exactly what artifactRevision cannot see.
const servedBytes = readFileSync(servedPath)
if (servedBytes.length === built.length) ok(`served size matches this build (${built.length} bytes)`)
else fail(`served size ${servedBytes.length} != this build ${built.length} — copy lib/ into the generation directory`)

const digest = (buf) => createHash('sha256').update(buf).digest('hex')
if (digest(servedBytes) === digest(built)) ok('served bytes are identical to this build')
else fail('served bytes DIFFER from this build — the Harness would run other code')

console.log(`\nserved artifactRevision = ${artifactRevision(servedPath)}`)
console.log('compare it with the `rev` reported for this plugin in the browser boot payload;')
console.log('a mismatch means the running Harness booted before this build — restart DSH.\n')

if (failed > 0) {
  console.error(`${failed} check(s) failed\n`)
  process.exit(1)
}
console.log('deployment verified\n')

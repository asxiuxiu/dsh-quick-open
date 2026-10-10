/**
 * Inspect the staged npm release and approve it.
 *
 * Three npm-side constraints shape this script:
 *
 * 1. Staging and approving need npm >= 11.15, so it pins npm@12 rather than
 *    using whatever npm the machine has (10.9.8 has no `stage` subcommand at all).
 * 2. `npm stage list --json` emits UTF-8 with a BOM, which JSON.parse rejects.
 * 3. `npx` routes the call through `npm exec`, whose banner lands on stderr even
 *    on success and whose redaction rewrites the stage id to `***` in error
 *    messages — the id on the wire is intact, the message just cannot be trusted.
 *
 * Approved releases stop being listed, so an empty `npm stage list` is the
 * success signal; the version also appears in `npm view <pkg> versions`.
 *
 * Usage:
 *   node scripts/approve-staged-release.mjs            # show what is staged and the approve command
 *   node scripts/approve-staged-release.mjs --approve  # run the approve now
 *
 * Credentials and extra npm flags are forwarded verbatim:
 *   node scripts/approve-staged-release.mjs --approve --//registry.npmjs.org/:_authToken=$NPM_TOKEN
 */
import { execFileSync } from 'node:child_process'

// Everything after the script name goes straight through to npm — that is how the
// token reaches the child, since this script intentionally holds none itself.
const passthrough = process.argv.slice(2).filter((arg) => arg !== '--approve')

const npmStage = (args, options = {}) =>
  execFileSync('npx', ['--quiet', '--yes', 'npm@12.2.0', 'stage', ...args, ...passthrough], {
    encoding: 'utf8',
    shell: true,
    ...options,
  })

const list = () => {
  try {
    return JSON.parse(npmStage(['list', '--json']).replace(/^\uFEFF/u, ''))
  } catch (error) {
    // An auth failure surfaces here as E401 before anything else can be reported.
    console.error(String(error.stderr ?? error.message).trim())
    process.exit(1)
  }
}

const staged = list()

if (staged.length === 0) {
  console.log('nothing is staged — the release has been published (or was never staged)')
  console.log('confirm with: npm view dsh-quick-open versions --json')
  process.exit(0)
}

for (const entry of staged) {
  console.log(`${entry.packageName}@${entry.version}  [${entry.status}]  id=${entry.id}  tag=${entry.tag}`)
}

if (!process.argv.includes('--approve')) {
  console.log('\nto publish, approve the staged version:')
  for (const entry of staged) {
    console.log(`  npx npm@12.2.0 stage approve ${entry.id}`)
  }
  console.log('\nor re-run this script with --approve to do it now.')
  process.exit(0)
}

// Approve one at a time: a single call must never be able to publish several
// versions, and the registry rejects an ambiguous multi-approve anyway.
if (staged.length > 1) {
  console.error(`\n${staged.length} staged versions — approve one explicitly:`)
  for (const entry of staged) {
    console.error(`  npx npm@12.2.0 stage approve ${entry.id}`)
  }
  process.exit(1)
}

const { id, packageName, version } = staged[0]
console.log(`\napproving ${packageName}@${version} (${id})\n`)

npmStage(['approve', id], { encoding: undefined, stdio: 'inherit' })

const remaining = list()
if (remaining.some((entry) => entry.id === id)) {
  console.error(`\n${packageName}@${version} is STILL staged — the approve did not take`)
  process.exit(1)
}
console.log(`\n${packageName}@${version} approved — it is no longer staged`)
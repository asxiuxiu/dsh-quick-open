/**
 * Approve the staged npm release.
 *
 * Two npm-side constraints shape this script:
 *
 * 1. Staging (`npm stage publish`) requires npm >= 11.15, so it pins npm@12
 *    rather than using whatever npm the machine has.
 * 2. Approving is a proof-of-presence step. When the account requires a
 *    one-time code, a granular 2FA-bypass token cannot supply it — the registry
 *    answers E404, not a prompt. So approval is documented as an interactive
 *    `npm login` step, and this script's job is to hand over the right
 *    stage-id and print the commands, without ever holding a credential.
 *
 * The stage id is read from `npm stage list --json` rather than typed by hand,
 * so a copy that picked up a BOM or a stray space cannot turn into a confusing
 * "staged version not found".
 *
 * Usage:
 *   node scripts/approve-staged-release.mjs            # show the staged release and how to approve it
 *   node scripts/approve-staged-release.mjs --approve  # run the approve now (expect an OTP prompt)
 *
 * Credentials and extra npm flags are forwarded verbatim:
 *   node scripts/approve-staged-release.mjs --//registry.npmjs.org/:_authToken=$NPM_TOKEN
 *   node scripts/approve-staged-release.mjs --userconfig=.npmrc
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
  // The JSON comes back UTF-8 with a BOM, which JSON.parse rejects outright.
  return JSON.parse(npmStage(['list', '--json']).replace(/^\uFEFF/u, ''))
}

const staged = list()

if (staged.length === 0) {
  console.error('nothing is staged — run `npm stage publish` first')
  process.exit(1)
}

for (const entry of staged) {
  console.log(`${entry.packageName}@${entry.version}  [${entry.status}]  id=${entry.id}  tag=${entry.tag}`)
}

if (staged.length > 1 && !process.argv.includes('--approve')) {
  console.error(`\n${staged.length} staged versions — approve one explicitly:`)
  console.error('  npx npm@12.2.0 stage approve <id>')
  process.exit(1)
}

if (!process.argv.includes('--approve')) {
  console.log('\nto publish, authenticate interactively and approve:')
  console.log('  npm login')
  console.log(`  npx npm@12.2.0 stage approve ${staged[0].id}`)
  console.log('\nor re-run this script with --approve to do it now.')
  process.exit(0)
}

const { id, packageName, version } = staged[0]
console.log(`\napproving ${packageName}@${version} (${id})`)
console.log('npm will ask for a one-time code if the account requires one.\n')

npmStage(['approve', id], { encoding: undefined, stdio: 'inherit' })

console.log(`\n${packageName}@${version} approved`)
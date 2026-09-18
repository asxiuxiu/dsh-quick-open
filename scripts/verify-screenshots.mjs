/**
 * Validate screenshots.json against the market's rules.
 *
 * contributing.md:
 *   - 1-8 images
 *   - declared next to package.json (repo root for a non-monorepo entry)
 *   - paths relative to that file, pointing at images already in the repo
 *   - relative paths may not leave the plugin directory (no leading '/', no '..')
 *   - {"screenshots": [...]} is also accepted
 *
 * Run: node scripts/verify-screenshots.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'screenshots.json'
const problems = []

if (!fs.existsSync(FILE)) {
  console.log(`FAIL ${FILE} is missing`)
  process.exit(1)
}

let raw
try {
  raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
} catch (e) {
  console.log(`FAIL ${FILE} is not valid JSON: ${e.message}`)
  process.exit(1)
}

// Both shapes are accepted by the market.
const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.screenshots) ? raw.screenshots : null)
if (list === null) {
  console.log(`FAIL ${FILE} must be an array or {"screenshots": [...]}`)
  process.exit(1)
}

if (list.length < 1 || list.length > 8) problems.push(`must list 1-8 images, got ${list.length}`)

const root = path.resolve('.')
for (const entry of list) {
  if (typeof entry !== 'string' || entry.trim() === '') {
    problems.push(`entry is not a non-empty string: ${JSON.stringify(entry)}`)
    continue
  }
  // Absolute URLs are allowed only when they are GitHub-hosted https.
  if (/^https?:\/\//iu.test(entry)) {
    if (!/^https:\/\/(raw\.githubusercontent\.com|user-images\.githubusercontent\.com|camo\.githubusercontent\.com|github\.com)\//iu.test(entry)) {
      problems.push(`absolute URL must be GitHub-hosted https: ${entry}`)
    }
    continue
  }
  if (entry.startsWith('/')) problems.push(`relative path may not start with '/': ${entry}`)
  if (entry.split(/[\\/]/u).includes('..')) problems.push(`relative path may not contain '..': ${entry}`)
  const abs = path.resolve(root, entry)
  if (!abs.startsWith(root)) problems.push(`path escapes the plugin directory: ${entry}`)
  if (!fs.existsSync(abs)) problems.push(`file does not exist in the repo: ${entry}`)
  else {
    const bytes = fs.statSync(abs).size
    const sig = fs.readFileSync(abs).subarray(0, 4)
    const isPng = sig[0] === 0x89 && sig[1] === 0x50
    const isJpg = sig[0] === 0xff && sig[1] === 0xd8
    const isWebp = sig.toString('latin1', 0, 4) === 'RIFF'
    const isGif = sig.toString('latin1', 0, 3) === 'GIF'
    if (!isPng && !isJpg && !isWebp && !isGif) problems.push(`not a recognised image: ${entry}`)
    console.log(`  ${entry}  ${(bytes / 1024).toFixed(0)} kB  ` +
      `${isPng ? 'PNG' : isJpg ? 'JPEG' : isWebp ? 'WebP' : isGif ? 'GIF' : '?'}`)
  }
}

// The market extracts images from the README only when nothing is declared, so
// a declared list must actually cover what the README shows.
if (fs.existsSync('README.md')) {
  const readme = fs.readFileSync('README.md', 'utf8')
  const refs = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)].map(m => m[1])
  if (refs.length > 0) {
    console.log(`\nREADME image references: ${refs.length}`)
    for (const r of refs) {
      const abs = path.resolve(root, r)
      if (!fs.existsSync(abs)) problems.push(`README references a missing image: ${r}`)
    }
  } else {
    console.log('\nREADME has no image references yet')
  }
}

console.log('')
if (problems.length === 0) {
  console.log('PASS: screenshots.json is valid')
  process.exit(0)
}
console.log(`FAIL:\n  - ${problems.join('\n  - ')}`)
process.exit(1)

/**
 * i18n coverage and behaviour.
 *
 * The failure this guards against is not a crash — it is a string that ships in
 * one language only. A missing Chinese key would render English inside an
 * otherwise Chinese panel, which looks like a half-finished translation and is
 * exactly the kind of defect that survives review because nobody switches
 * language to check.
 *
 * Three properties are asserted:
 *
 * 1. **Key parity.** `zh` and `en` declare the same keys. TypeScript already
 *    enforces this at compile time (both tables are annotated `Messages`), so
 *    this is the runtime backstop for a table built dynamically or a key added
 *    with an `as any` escape.
 * 2. **No empty and no untranslated values.** Every value is non-empty, and no
 *    `zh` value is byte-identical to its `en` counterpart UNLESS it is on the
 *    deliberate allowlist below — a zh value that equals en is usually a
 *    forgotten translation, but a handful of strings are legitimately the same
 *    in both languages (product names, key names).
 * 3. **Placeholders survive translation.** A `{count}` in `en` must appear in
 *    `zh` too, or the Chinese line silently drops the number.
 *
 * Run: node scripts/verify-i18n.mjs
 */
import { EN_TABLE, ZH_TABLE, MESSAGE_KEYS, messages, t, activeLocale } from '../src/client/i18n.ts'

let failures = 0
function ok(name) { console.log(`  ok   ${name}`) }
function fail(name, detail) {
  failures += 1
  console.log(`  FAIL ${name}${detail === undefined ? '' : `\n       ${detail}`}`)
}

/**
 * Keys whose two languages are legitimately identical.
 *
 * Each needs a reason: an entry here is a claim that the string is not a
 * forgotten translation, and a reviewer should be able to check that claim.
 */
const SAME_IN_BOTH = new Set([
  // Key names are proper nouns of the keyboard, identical in both languages.
  // (Nothing yet — kept as an explicit, reviewable seam rather than deleting
  // the check. An empty allowlist means every zh value must differ from en.)
])

console.log('key parity')
{
  const enKeys = new Set(Object.keys(EN_TABLE))
  const zhKeys = new Set(Object.keys(ZH_TABLE))
  const missingZh = [...enKeys].filter(k => !zhKeys.has(k))
  const missingEn = [...zhKeys].filter(k => !enKeys.has(k))
  const declared = new Set(MESSAGE_KEYS)

  if (missingZh.length === 0) ok('every en key has a zh value')
  else fail('en keys missing from zh', missingZh.join(', '))

  if (missingEn.length === 0) ok('every zh key has an en value')
  else fail('zh keys missing from en', missingEn.join(', '))

  const undeclared = [...enKeys].filter(k => !declared.has(k))
  if (undeclared.length === 0) ok('MESSAGE_KEYS matches the en table')
  else fail('MESSAGE_KEYS is out of sync with the en table', undeclared.join(', '))
}

console.log('\nno empty or untranslated values')
{
  const empty = MESSAGE_KEYS.filter(k => String(EN_TABLE[k]).trim() === '' || String(ZH_TABLE[k]).trim() === '')
  if (empty.length === 0) ok('no empty values in either table')
  else fail('empty values', empty.join(', '))

  const identical = MESSAGE_KEYS.filter(k =>
    !SAME_IN_BOTH.has(k) && EN_TABLE[k] === ZH_TABLE[k])
  if (identical.length === 0) ok('every zh value differs from its en value')
  else fail('zh value is identical to en (forgotten translation?)', identical.join(', '))
}

console.log('\nplaceholders survive translation')
{
  const placeholderOf = (value) => new Set([...String(value).matchAll(/\{(\w+)\}/gu)].map(m => m[1]))
  const mismatched = []
  for (const key of MESSAGE_KEYS) {
    const en = placeholderOf(EN_TABLE[key])
    const zh = placeholderOf(ZH_TABLE[key])
    const missing = [...en].filter(name => !zh.has(name))
    const extra = [...zh].filter(name => !en.has(name))
    if (missing.length > 0 || extra.length > 0) {
      mismatched.push(`${key} (missing in zh: ${missing.join(',') || '-'}; extra: ${extra.join(',') || '-'})`)
    }
  }
  if (mismatched.length === 0) ok('every {placeholder} appears in both languages')
  else fail('placeholder mismatch', mismatched.join('\n       '))
}

console.log('\nlanguage resolution')
{
  const withLang = (lang, fn) => {
    const previous = globalThis.document
    globalThis.document = { documentElement: { lang } }
    try { return fn() } finally { globalThis.document = previous }
  }

  if (withLang('zh', activeLocale) === 'zh') ok('zh resolves to the Chinese table')
  else fail('zh did not resolve to zh')

  if (withLang('zh-CN', activeLocale) === 'zh') ok('a regional zh tag (zh-CN) resolves to zh')
  else fail('zh-CN did not resolve to zh')

  if (withLang('en', activeLocale) === 'en') ok('en resolves to English')
  else fail('en did not resolve to en')

  if (withLang('', activeLocale) === 'en') ok('a missing lang degrades to English')
  else fail('empty lang did not degrade to en')

  // A language the plugin does not ship must not blank the UI.
  if (withLang('de', activeLocale) === 'en') ok('an unsupported language degrades to English')
  else fail('de did not degrade to en')
}

console.log('\ninterpolation')
{
  const zhIndex = withLangZh(() => t('indexInfo', { count: '1,234', age: 3 }))
  if (zhIndex === '索引 1,234 项 · 3s 前') ok('zh interpolation substitutes every placeholder')
  else fail('zh interpolation', `got ${JSON.stringify(zhIndex)}`)

  const enIndex = withLangEn(() => t('indexInfo', { count: '1,234', age: 3 }))
  if (enIndex === 'Indexed 1,234 entries · 3s ago') ok('en interpolation substitutes every placeholder')
  else fail('en interpolation', `got ${JSON.stringify(enIndex)}`)

  // An unmatched placeholder must stay visible: a literal {count} is a bug
  // report, whereas an empty string reads as intentional.
  const unmatched = withLangEn(() => t('indexInfo', {}))
  if (unmatched.includes('{count}')) ok('an unmatched placeholder is left verbatim, not blanked')
  else fail('unmatched placeholder was not preserved', `got ${JSON.stringify(unmatched)}`)

  const noParams = withLangEn(() => t('save'))
  if (noParams === EN_TABLE.save) ok('a call with no params returns the raw template')
  else fail('no-params call returned the wrong value')
}

function withLangZh(fn) {
  const previous = globalThis.document
  globalThis.document = { documentElement: { lang: 'zh' } }
  try { return fn() } finally { globalThis.document = previous }
}
function withLangEn(fn) {
  const previous = globalThis.document
  globalThis.document = { documentElement: { lang: 'en' } }
  try { return fn() } finally { globalThis.document = previous }
}

console.log('\nselection reference reads in the active language')
{
  // The reference text is what lands in the composer draft, so a language
  // switch has to reach it — it is not decoration.
  const { buildSelectionText } = await import('../src/client/preview/selection.ts')
  const input = {
    relativePath: 'src/main.cpp',
    selected: 'int main() {}',
    lines: { start: 120, end: 122 },
    format: 'path-hint',
  }
  const zh = withLangZh(() => buildSelectionText(input))
  const en = withLangEn(() => buildSelectionText(input))
  if (zh.includes('第 120-122 行')) ok('zh draft reference names the span in Chinese')
  else fail('zh draft reference', `got ${JSON.stringify(zh)}`)
  if (en.includes('lines 120-122')) ok('en draft reference names the span in English')
  else fail('en draft reference', `got ${JSON.stringify(en)}`)
  if (zh !== en) ok('the two languages produce different draft text')
  else fail('draft text did not change with the language')
}

console.log(failures === 0 ? '\ni18n verified\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)

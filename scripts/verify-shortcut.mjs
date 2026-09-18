/**
 * Shortcut matching, platform mapping, migration, and persistence.
 *
 * The risk this covers: a shortcut is matched against EVERY keystroke in the
 * app, so a matcher that is too loose swallows keys the user needs, and one
 * that is too strict leaves a gesture unreachable. Both are invisible until
 * someone hits the combination by hand, so they are pinned here.
 *
 * Run: node scripts/verify-shortcut.mjs
 */
import { readFile, writeFile, rm } from 'node:fs/promises'

// The module reads `window.localStorage` and `navigator`, so stub both before
// importing. The matcher itself is pure and takes the platform as an argument.
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
  },
}
// `navigator` is a getter-only global in modern Node, so it has to be
// redefined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { platform: 'Win32' },
  configurable: true,
  writable: true,
})

const src = await readFile(new URL('../src/client/shortcut.ts', import.meta.url), 'utf8')
const tmp = new URL('../src/client/_shortcut-test.ts', import.meta.url)
await writeFile(tmp, src, 'utf8')
const { build } = await import('esbuild')
const bundled = await build({
  entryPoints: [tmp.pathname.replace(/^\//, '')],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
})
await rm(tmp, { force: true })
const S = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

let failures = 0
const check = (label, ok, detail) => {
  if (ok) { console.log(`OK   ${label}`); return }
  failures++
  console.log(`FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

const ev = (key, mods = {}) => ({
  key,
  ctrlKey: mods.ctrl === true,
  metaKey: mods.meta === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
})

const {
  DEFAULT_SHORTCUTS: DEF, SHORTCUT_ACTIONS, matchesShortcut, describeShortcut,
  bindableKey, validateShortcut, shortcutFromEvent, readShortcut, readShortcuts,
  writeShortcut, coerceShortcut, modifiersMatch,
} = S

console.log('=== every shipped default fires with the platform modifier ===')
check('open: Windows Ctrl+P', matchesShortcut(DEF.open, ev('p', { ctrl: true }), false))
check('open: macOS Cmd+P', matchesShortcut(DEF.open, ev('p', { meta: true }), true))
check('find: Windows Ctrl+F', matchesShortcut(DEF.find, ev('f', { ctrl: true }), false))
check('find: macOS Cmd+F', matchesShortcut(DEF.find, ev('f', { meta: true }), true))
check('reference: Windows Ctrl+Enter', matchesShortcut(DEF.reference, ev('Enter', { ctrl: true }), false))
check('reference: macOS Cmd+Enter', matchesShortcut(DEF.reference, ev('Enter', { meta: true }), true))

console.log('\n=== the three bindings do not collide ===')
check('Ctrl+F does not open the palette', !matchesShortcut(DEF.open, ev('f', { ctrl: true }), false))
check('Ctrl+P does not open find', !matchesShortcut(DEF.find, ev('p', { ctrl: true }), false))
check('Ctrl+Enter does not open the palette', !matchesShortcut(DEF.open, ev('Enter', { ctrl: true }), false))
check('plain Enter does NOT reference (it opens)',
  !matchesShortcut(DEF.reference, ev('Enter'), false))

console.log('\n=== and do not fire on near-misses ===')
for (const [label, which, event] of [
  ['bare p', 'open', ev('p')],
  ['Ctrl+Shift+P', 'open', ev('p', { ctrl: true, shift: true })],
  ['Ctrl+Alt+P', 'open', ev('p', { ctrl: true, alt: true })],
  ['Ctrl+Shift+F', 'find', ev('f', { ctrl: true, shift: true })],
  ['Ctrl+Enter with Shift', 'reference', ev('Enter', { ctrl: true, shift: true })],
]) {
  check(`does not fire on ${label}`, !matchesShortcut(DEF[which], event, false))
}

console.log('\n=== bindable keys ===')
for (const k of ['Control', 'Meta', 'Shift', 'Alt', 'CapsLock', 'F5', 'ArrowDown']) {
  check(`"${k}" is not bindable`, bindableKey(k) === undefined)
}
check('Escape is NOT bindable (panels close with it)', bindableKey('Escape') === undefined)
check('Enter IS bindable (the reference gesture)', bindableKey('Enter') === 'enter')
check('space is bindable as "space"', bindableKey(' ') === 'space')
check('"p" is bindable', bindableKey('p') === 'p')
check('"/" is bindable', bindableKey('/') === '/')

console.log('\n=== validation ===')
check('no modifier at all is refused',
  validateShortcut({ mod: false, ctrl: false, shift: false, alt: false, key: 'p' }) !== undefined)
check('shift-only IS accepted (a real modifier)',
  validateShortcut({ mod: false, ctrl: false, shift: true, alt: false, key: 'p' }) === undefined)

console.log('\n=== recording maps the platform modifier to `mod` ===')
{
  const onWin = shortcutFromEvent(ev('k', { ctrl: true }), false)
  check('Windows Ctrl+K records mod=true', typeof onWin === 'object' && onWin.mod === true, JSON.stringify(onWin))
  const onMac = shortcutFromEvent(ev('k', { meta: true }), true)
  check('macOS Cmd+K records mod=true (portable)', typeof onMac === 'object' && onMac.mod === true, JSON.stringify(onMac))
  const macCtrl = shortcutFromEvent(ev('k', { ctrl: true }), true)
  check('macOS Ctrl+K records ctrl=true, mod=false',
    typeof macCtrl === 'object' && macCtrl.mod === false && macCtrl.ctrl === true, JSON.stringify(macCtrl))
  check('recording a bare key returns an error string',
    typeof shortcutFromEvent(ev('k'), false) === 'string')
  check('recording a modifier-only press returns an error string',
    typeof shortcutFromEvent(ev('Control', { ctrl: true }), false) === 'string')
  const enter = shortcutFromEvent(ev('Enter', { ctrl: true }), false)
  check('Ctrl+Enter is recordable', typeof enter === 'object' && enter.key === 'enter', JSON.stringify(enter))
}

console.log('\n=== a recorded combination round-trips ===')
{
  const recorded = shortcutFromEvent(ev('k', { ctrl: true, shift: true }), false)
  if (typeof recorded === 'object') {
    check('  -> fires on Ctrl+Shift+K', matchesShortcut(recorded, ev('k', { ctrl: true, shift: true }), false))
    check('  -> not on Ctrl+K', !matchesShortcut(recorded, ev('k', { ctrl: true }), false))
    check('  -> not on Shift+K', !matchesShortcut(recorded, ev('k', { shift: true }), false))
  } else check('Ctrl+Shift+K recorded', false)
}

console.log('\n=== cross-platform reading ===')
{
  const recorded = shortcutFromEvent(ev('k', { ctrl: true }), false)
  check('recorded on Windows, fires with Cmd on macOS',
    typeof recorded === 'object' && matchesShortcut(recorded, ev('k', { meta: true }), true))
  check('recorded on Windows, does NOT fire with Ctrl on macOS',
    typeof recorded === 'object' && !matchesShortcut(recorded, ev('k', { ctrl: true }), true))
}

console.log('\n=== the default is PLATFORM-SPECIFIC (a deliberate change) ===')
{
  // The original hardcoded listener used `ctrlKey || metaKey`, so it accepted
  // either modifier on either platform. The customizable default narrows that
  // to the platform's own primary modifier. Pinned so it cannot drift back.
  check('macOS default: Cmd+P fires', matchesShortcut(DEF.open, ev('p', { meta: true }), true))
  check('macOS default: Ctrl+P does NOT fire (rebind in settings)',
    !matchesShortcut(DEF.open, ev('p', { ctrl: true }), true))
  check('Windows default: Ctrl+P fires', matchesShortcut(DEF.open, ev('p', { ctrl: true }), false))
  check('Windows default: Cmd+P does NOT fire',
    !matchesShortcut(DEF.open, ev('p', { meta: true }), false))
}

console.log('\n=== the modifier-only half, for modified clicks ===')
{
  check('Ctrl+click matches the reference modifiers',
    modifiersMatch(DEF.reference, { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, false))
  check('plain click does not',
    !modifiersMatch(DEF.reference, { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, false))
}

console.log('\n=== persistence: per action, per entry ===')
{
  store.clear()
  writeShortcut({ mod: true, ctrl: false, shift: false, alt: false, key: 'k' }, 'open')
  check('one action written, the others keep their defaults',
    readShortcut('open').key === 'k' && readShortcut('find').key === 'f' && readShortcut('reference').key === 'enter',
    JSON.stringify(readShortcuts()))

  writeShortcut({ mod: true, ctrl: false, shift: false, alt: false, key: 'g' }, 'find')
  check('a second action does not disturb the first',
    readShortcut('open').key === 'k' && readShortcut('find').key === 'g', JSON.stringify(readShortcuts()))

  // One corrupt entry must not reset the others.
  store.set('dsh-quick-open:shortcuts', JSON.stringify({
    open: { mod: true, ctrl: false, shift: false, alt: false, key: 'k' },
    find: { mod: false, ctrl: false, shift: false, alt: false, key: 'f' },
    reference: 'nonsense',
  }))
  check('a corrupt entry falls back alone; good entries survive',
    readShortcut('open').key === 'k' && readShortcut('find').key === 'f' && readShortcut('reference').key === 'enter',
    JSON.stringify(readShortcuts()))

  store.set('dsh-quick-open:shortcuts', '{ not json')
  check('corrupt JSON -> all defaults',
    SHORTCUT_ACTIONS.every(a => readShortcut(a).key === DEF[a].key))

  store.clear()
  check('nothing stored -> all defaults',
    SHORTCUT_ACTIONS.every(a => readShortcut(a).key === DEF[a].key))

  // Migration from the single-binding key the previous version wrote.
  store.set('dsh-quick-open:shortcut', JSON.stringify({ mod: true, ctrl: false, shift: false, alt: false, key: 'j' }))
  check('the legacy single binding migrates into `open`',
    readShortcut('open').key === 'j' && readShortcut('find').key === 'f', JSON.stringify(readShortcuts()))

  store.set('dsh-quick-open:shortcut', '{ broken')
  check('a corrupt legacy value is ignored rather than throwing',
    readShortcut('open').key === 'p')

  check('coerceShortcut rejects an unknown shape', coerceShortcut({ key: 'F5' }) === undefined)
}

console.log('\n=== labels ===')
check('Windows says Ctrl+P', describeShortcut(DEF.open, false) === 'Ctrl+P', describeShortcut(DEF.open, false))
check('macOS says Cmd+P', describeShortcut(DEF.open, true) === 'Cmd+P', describeShortcut(DEF.open, true))
check('reference reads as Ctrl+Enter, not Ctrl+ENTER',
  describeShortcut(DEF.reference, false) === 'Ctrl+Enter', describeShortcut(DEF.reference, false))
check('macOS Alt is labelled Option',
  describeShortcut({ mod: true, ctrl: false, shift: false, alt: true, key: 'p' }, true).includes('Option'))
check('space is labelled Space',
  describeShortcut({ mod: true, ctrl: false, shift: false, alt: false, key: 'space' }, false).includes('Space'))

console.log(`\n${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
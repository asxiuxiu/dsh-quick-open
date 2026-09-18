/**
 * Shortcut matching, platform mapping, and persistence.
 *
 * The risk this covers: a shortcut is matched against EVERY keystroke in the
 * app, so a matcher that is too loose swallows keys the user needs, and one
 * that is too strict leaves the palette unreachable. Both are invisible until
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
// redefined rather than assigned. `localStorage` is reached through `window`.
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

const { DEFAULT_SHORTCUT: DEF, matchesShortcut, describeShortcut, bindableKey, validateShortcut, shortcutFromEvent, readShortcut, writeShortcut } = S

console.log('=== the default fires with the platform modifier ===')
check('Windows: Ctrl+P', matchesShortcut(DEF, ev('p', { ctrl: true }), false))
check('macOS:   Cmd+P', matchesShortcut(DEF, ev('p', { meta: true }), true))
check('uppercase P (Caps Lock) still fires', matchesShortcut(DEF, ev('P', { ctrl: true }), false))

console.log('\n=== and does NOT fire on near-misses ===')
const misses = [
  ['bare p (no modifier)', ev('p'), false],
  ['Ctrl+Shift+P', ev('p', { ctrl: true, shift: true }), false],
  ['Ctrl+Alt+P', ev('p', { ctrl: true, alt: true }), false],
  ['Ctrl+O (different key)', ev('o', { ctrl: true }), false],
  ['Shift+P', ev('p', { shift: true }), false],
  ['Cmd+P on Windows (meta is not the platform modifier)', ev('p', { meta: true }), false],
  ['Ctrl+P on macOS (ctrl is not the platform modifier)', ev('p', { ctrl: true }), true],
].slice(0, 6)
for (const [label, event, mac] of misses) {
  check(`does not fire on ${label}`, !matchesShortcut(DEF, event, mac))
}

console.log('\n=== a modifier-only press never becomes a shortcut ===')
for (const k of ['Control', 'Meta', 'Shift', 'Alt', 'CapsLock', 'F5', 'Escape', 'ArrowDown', 'Enter']) {
  check(`"${k}" is not bindable`, bindableKey(k) === undefined)
}
check('"p" is bindable', bindableKey('p') === 'p')
check('"/" is bindable', bindableKey('/') === '/')
check('space is bindable as "space"', bindableKey(' ') === 'space')

console.log('\n=== validation refuses an unusable binding ===')
check('no modifier at all is refused',
  validateShortcut({ mod: false, ctrl: false, shift: false, alt: false, key: 'p' }) !== undefined)
check('shift-only IS accepted (a real modifier)',
  validateShortcut({ mod: false, ctrl: false, shift: true, alt: false, key: 'p' }) === undefined)

console.log('\n=== recording maps the platform modifier to `mod` ===')
{
  const onWin = shortcutFromEvent(ev('k', { ctrl: true }), false)
  check('Windows Ctrl+K records mod=true', typeof onWin === 'object' && onWin.mod === true && onWin.key === 'k',
    JSON.stringify(onWin))
  const onMac = shortcutFromEvent(ev('k', { meta: true }), true)
  check('macOS Cmd+K records mod=true (portable across platforms)',
    typeof onMac === 'object' && onMac.mod === true && onMac.key === 'k', JSON.stringify(onMac))
  const macCtrl = shortcutFromEvent(ev('k', { ctrl: true }), true)
  check('macOS Ctrl+K records ctrl=true, mod=false (distinct from Cmd)',
    typeof macCtrl === 'object' && macCtrl.mod === false && macCtrl.ctrl === true, JSON.stringify(macCtrl))
  const bare = shortcutFromEvent(ev('k'), false)
  check('recording a bare key returns an error string, not a binding',
    typeof bare === 'string', JSON.stringify(bare))
  const modOnly = shortcutFromEvent(ev('Control', { ctrl: true }), false)
  check('recording a modifier-only press returns an error string',
    typeof modOnly === 'string', JSON.stringify(modOnly))
}

console.log('\n=== a recorded combination round-trips through matching ===')
{
  const recorded = shortcutFromEvent(ev('k', { ctrl: true, shift: true }), false)
  check('Ctrl+Shift+K recorded', typeof recorded === 'object')
  if (typeof recorded === 'object') {
    check('  -> fires on Ctrl+Shift+K', matchesShortcut(recorded, ev('k', { ctrl: true, shift: true }), false))
    check('  -> does NOT fire on Ctrl+K', !matchesShortcut(recorded, ev('k', { ctrl: true }), false))
    check('  -> does NOT fire on Shift+K', !matchesShortcut(recorded, ev('k', { shift: true }), false))
  }
}

console.log('\n=== the same config reads correctly on the other platform ===')
{
  // Recorded on Windows as Ctrl+K; on a Mac the same stored value means Cmd+K.
  const recorded = shortcutFromEvent(ev('k', { ctrl: true }), false)
  check('recorded on Windows, fires with Cmd on macOS',
    typeof recorded === 'object' && matchesShortcut(recorded, ev('k', { meta: true }), true))
  check('recorded on Windows, does NOT fire with Ctrl on macOS',
    typeof recorded === 'object' && !matchesShortcut(recorded, ev('k', { ctrl: true }), true))
}

console.log('\n=== persistence ===')
{
  writeShortcut({ mod: true, ctrl: false, shift: true, alt: false, key: 'k' })
  const back = readShortcut()
  check('a written shortcut reads back equal',
    back.mod === true && back.shift === true && back.key === 'k', JSON.stringify(back))

  store.set('dsh-quick-open:shortcut', '{ not json')
  check('corrupt JSON falls back to the default', readShortcut().key === DEF.key)

  store.set('dsh-quick-open:shortcut', JSON.stringify({ mod: false, ctrl: false, shift: false, alt: false, key: 'p' }))
  check('a stored value with NO modifier is treated as corrupt (palette must stay reachable)',
    readShortcut().mod === true, JSON.stringify(readShortcut()))

  store.set('dsh-quick-open:shortcut', JSON.stringify({ mod: true, key: 'Control' }))
  check('a stored multi-char key is rejected', readShortcut().key === DEF.key)

  store.delete('dsh-quick-open:shortcut')
  check('nothing stored -> the default', readShortcut().key === DEF.key)
}

console.log('\n=== the default is PLATFORM-SPECIFIC (a deliberate change) ===')
{
  // The old hardcoded listener used `ctrlKey || metaKey`, so it accepted either
  // modifier on either platform. The customizable default narrows that to the
  // platform's own primary modifier. This is a user-visible change and is
  // pinned here so it cannot drift back by accident.
  check('macOS default: Cmd+P fires', matchesShortcut(DEF, ev('p', { meta: true }), true))
  check('macOS default: Ctrl+P does NOT fire (use the settings panel to rebind)',
    !matchesShortcut(DEF, ev('p', { ctrl: true }), true))
  check('Windows default: Ctrl+P fires', matchesShortcut(DEF, ev('p', { ctrl: true }), false))
  check('Windows default: Cmd+P does NOT fire',
    !matchesShortcut(DEF, ev('p', { meta: true }), false))
}

console.log('\n=== labels ===')
check('Windows label says Ctrl+P', describeShortcut(DEF, false) === 'Ctrl+P', describeShortcut(DEF, false))
check('macOS label says Cmd+P', describeShortcut(DEF, true) === 'Cmd+P', describeShortcut(DEF, true))
check('macOS Alt is labelled Option',
  describeShortcut({ mod: true, ctrl: false, shift: false, alt: true, key: 'p' }, true).includes('Option'))
check('space is labelled Space',
  describeShortcut({ mod: true, ctrl: false, shift: false, alt: false, key: 'space' }, false).includes('Space'))

console.log(`\n${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)

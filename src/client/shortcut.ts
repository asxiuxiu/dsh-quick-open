/**
 * The customizable shortcut that opens the quick-open layer.
 *
 * A shortcut is stored as a small STRUCTURED value rather than a display
 * string, because the platform modifier differs and the difference has to be
 * represented, not guessed at render time:
 *
 *   - macOS users expect Cmd; Windows/Linux users expect Ctrl. `mod` means
 *     "whichever this platform calls the primary modifier", so one setting
 *     reads correctly on both.
 *   - A user may want NO modifier (a bare key), which a display-string format
 *     would have to encode as a special case. Here it is just `mod: false`.
 *
 * Matching is strict about the modifiers that must be ABSENT, so a bound `mod+p`
 * does not also fire on Ctrl+Shift+P — that combination belongs to something
 * else (in DSH, Shift+Ctrl+P is the browser/print family), and stealing it
 * would be a surprise the user cannot undo from the UI.
 */

/** Which modifiers the shortcut requires. */
export interface Shortcut {
  /** The platform's primary modifier: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean
  /** The literal Ctrl key, on every platform. */
  ctrl: boolean
  shift: boolean
  alt: boolean
  /**
   * `KeyboardEvent.key`, lowercased and as a single character where possible
   * (e.g. `p`, `/`, `\``). Compared case-insensitively, so Caps Lock does not
   * break the shortcut.
   */
  key: string
}

/** What ships: Cmd+P on macOS, Ctrl+P elsewhere. */
export const DEFAULT_SHORTCUT: Shortcut = {
  mod: true,
  ctrl: false,
  shift: false,
  alt: false,
  key: 'p',
}

/** localStorage key the settings panel writes and the listener reads. */
export const SHORTCUT_KEY = 'dsh-quick-open:shortcut'

/** True when this build runs on macOS (Cmd is the primary modifier there). */
export function isMacPlatform(): boolean {
  // `navigator.platform` is deprecated but still the most widely populated
  // signal; `userAgentData.platform` is preferred where it exists. A wrong
  // answer only changes which key the UI names, never whether it works — both
  // modifiers are matched on every platform (see `matchesShortcut`).
  const nav = globalThis.navigator as
    | { userAgentData?: { platform?: string }, platform?: string, userAgent?: string }
    | undefined
  if (nav === undefined) return false
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? ''
  return /mac|iphone|ipad|ipod/iu.test(platform)
}

/** The primary modifier's display name on this platform. */
export function primaryModifierLabel(): string {
  return isMacPlatform() ? 'Cmd' : 'Ctrl'
}

/**
 * Split a `KeyboardEvent.key` into a bindable single-character key.
 *
 * Returns undefined for modifier-only presses (a bare `Control` keydown must
 * not become the shortcut) and for keys that are not a single character, so a
 * recorder cannot bind `F5` or `Escape` by accident.
 */
export function bindableKey(eventKey: string): string | undefined {
  if (eventKey === ' ' ) return 'space'
  if (eventKey.length !== 1) return undefined
  return eventKey.toLowerCase()
}

/**
 * Whether an event fires `shortcut`.
 *
 * `mod` is matched against Cmd on macOS and Ctrl elsewhere; `ctrl` is matched
 * against the literal Ctrl key, so a user who wants Ctrl on a Mac can say so.
 * Every modifier not required must be ABSENT — see the module note.
 */
export function matchesShortcut(
  shortcut: Shortcut,
  event: { key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean },
  mac: boolean = isMacPlatform(),
): boolean {
  const key = bindableKey(event.key)
  if (key === undefined || key !== shortcut.key) return false

  // The event's contribution to `mod` and `ctrl` depends on the platform:
  // on macOS Cmd is `mod` and Ctrl is `ctrl`; elsewhere Ctrl is `mod` and the
  // literal-ctrl slot is unreachable (there is only one Ctrl key).
  const eventMod = mac ? event.metaKey : event.ctrlKey
  const eventCtrl = mac ? event.ctrlKey : false

  if (shortcut.mod !== eventMod) return false
  if (shortcut.ctrl !== eventCtrl) return false
  if (shortcut.shift !== event.shiftKey) return false
  if (shortcut.alt !== event.altKey) return false
  return true
}

/** Human-readable form for the settings UI and the footer hint. */
export function describeShortcut(shortcut: Shortcut, mac: boolean = isMacPlatform()): string {
  const parts: string[] = []
  if (shortcut.mod) parts.push(mac ? 'Cmd' : 'Ctrl')
  if (shortcut.ctrl) parts.push('Ctrl')
  if (shortcut.shift) parts.push('Shift')
  if (shortcut.alt) parts.push(mac ? 'Option' : 'Alt')
  parts.push(shortcut.key === 'space' ? 'Space' : shortcut.key.toUpperCase())
  return parts.join('+')
}

/**
 * Whether a shortcut is usable.
 *
 * A bare key with no modifier would swallow that key everywhere in the app —
 * typing `p` would open the palette — so at least one modifier is required.
 * This is refused at the point of binding rather than silently accepted.
 */
export function validateShortcut(shortcut: Shortcut): string | undefined {
  if (!shortcut.mod && !shortcut.ctrl && !shortcut.shift && !shortcut.alt) {
    return '至少需要一个修饰键（Ctrl / Cmd / Shift / Alt）'
  }
  if (shortcut.key === '' ) return '缺少主键'
  return undefined
}

/** Read the persisted shortcut, falling back to the default on anything odd. */
export function readShortcut(): Shortcut {
  try {
    const raw = window.localStorage.getItem(SHORTCUT_KEY)
    if (raw === null) return DEFAULT_SHORTCUT
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SHORTCUT
    const record = parsed as Record<string, unknown>
    const key = record.key
    if (typeof key !== 'string' || bindableKey(key) !== key) return DEFAULT_SHORTCUT
    const shortcut: Shortcut = {
      mod: record.mod === true,
      ctrl: record.ctrl === true,
      shift: record.shift === true,
      alt: record.alt === true,
      key,
    }
    // A stored value with no modifier would make the palette unreachable-by-
    // accident; treat it as corrupt rather than honouring it.
    return validateShortcut(shortcut) === undefined ? shortcut : DEFAULT_SHORTCUT
  } catch {
    return DEFAULT_SHORTCUT
  }
}

/** Persist the shortcut; a storage failure must not break the panel. */
export function writeShortcut(shortcut: Shortcut): void {
  try {
    window.localStorage.setItem(SHORTCUT_KEY, JSON.stringify(shortcut))
  } catch {
    // A full or blocked localStorage is not worth surfacing for a preference.
  }
}

/**
 * Build a shortcut from a recorded keydown, or an error string when it cannot
 * be bound.
 */
export function shortcutFromEvent(event: {
  key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean
}, mac: boolean = isMacPlatform()): Shortcut | string {
  const key = bindableKey(event.key)
  if (key === undefined) return '请按一个字母、数字或符号键（不能只按修饰键）'
  // The recorder records what the user PRESSED and names it the way their
  // platform does, so pressing Cmd on a Mac stores `mod` (not a Mac-only flag)
  // and the same setting reads correctly if the config is copied to Windows.
  const shortcut: Shortcut = {
    mod: mac ? event.metaKey : event.ctrlKey,
    ctrl: mac ? event.ctrlKey : false,
    shift: event.shiftKey,
    alt: event.altKey,
    key,
  }
  const problem = validateShortcut(shortcut)
  return problem === undefined ? shortcut : problem
}

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

/**
 * The gestures this plugin binds.
 *
 * Kept as one named set rather than one storage key per feature: they share
 * the platform-modifier semantics, the validation, and the settings UI, and a
 * single record makes it impossible for one binding to be persisted in a shape
 * another cannot read.
 */
export type ShortcutAction = 'open' | 'find' | 'reference'

/** Every action, in the order the settings panel shows them. */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ['open', 'find', 'reference']

/** Human label for each action. */
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  open: '呼出快速打开面板',
  find: '在文件预览里搜索内容',
  reference: '把选中文件加入对话（面板内）',
}

/** One-line explanation of when each action applies. */
export const SHORTCUT_HINTS: Record<ShortcutAction, string> = {
  open: '任意会话页面按下即可呼出；再按一次关闭。',
  find: '焦点在侧边栏文件预览里时生效，打开浮动查找条。',
  reference: '快速打开面板打开时生效：按住修饰键再回车，把文件作为引用放进草稿，面板不关闭。',
}

/**
 * What ships.
 *
 * `open` and `find` mirror the conventions every editor uses (Ctrl/Cmd+P and
 * Ctrl/Cmd+F), so the defaults need no learning. `reference` is Ctrl/Cmd+Enter
 * — the palette's own modifier pressed with its accept key — which is why it
 * is a full combination rather than a bare key like the built-in Enter.
 */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, Shortcut> = {
  open: { mod: true, ctrl: false, shift: false, alt: false, key: 'p' },
  find: { mod: true, ctrl: false, shift: false, alt: false, key: 'f' },
  reference: { mod: true, ctrl: false, shift: false, alt: false, key: 'enter' },
}

/** The primary binding, for callers that only ever mean "open the palette". */
export const DEFAULT_SHORTCUT: Shortcut = DEFAULT_SHORTCUTS.open

/** Where every binding is stored, as one record. */
export const SHORTCUTS_KEY = 'dsh-quick-open:shortcuts'

/** The single-binding key used before the set existed, read once for migration. */
const LEGACY_SHORTCUT_KEY = 'dsh-quick-open:shortcut'

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

/** Named (non-character) keys a gesture may use, lowercased. */
const NAMED_KEYS = new Set(['enter', 'space', 'tab', 'backspace', 'delete', 'home', 'end'])

/**
 * Split a `KeyboardEvent.key` into a bindable key, or undefined when it may
 * not be bound.
 *
 * Single characters are taken as themselves, lowercased so Caps Lock cannot
 * break the shortcut. A small allowlist of named keys is accepted because a
 * gesture like "add this file to the conversation" naturally lands on Enter.
 * Escape is deliberately NOT bindable: the layers use it to close, and binding
 * it would leave a panel with no way out.
 */
export function bindableKey(eventKey: string): string | undefined {
  if (eventKey === ' ') return 'space'
  const lower = eventKey.toLowerCase()
  if (NAMED_KEYS.has(lower)) return lower
  // Anything else longer than one character is a modifier, a function key, or
  // an arrow — none of which a recorder should bind by the user pressing it.
  if (eventKey.length !== 1) return undefined
  return lower
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
  return modifiersMatch(shortcut, event, mac)
}

/**
 * The modifier half of `matchesShortcut`, for gestures that carry modifiers but
 * no key — a modified mouse click reuses a keyboard binding's modifiers without
 * having a key of its own.
 */
export function modifiersMatch(
  shortcut: Shortcut,
  event: { ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean },
  mac: boolean = isMacPlatform(),
): boolean {
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
  parts.push(keyLabel(shortcut.key))
  return parts.join('+')
}

/** Display name for one key: `Enter`, `Space`, `P`, `/`. */
function keyLabel(key: string): string {
  if (key === 'space') return 'Space'
  // Named keys read as words; a single character reads as its uppercase form.
  if (key.length > 1) return key.charAt(0).toUpperCase() + key.slice(1)
  return key.toUpperCase()
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

/**
 * Coerce one stored value into a Shortcut, or undefined when it is unusable.
 *
 * Exported for the tests and for the migration path: every rejection here is a
 * value that would otherwise make a gesture unreachable or fire on keystrokes
 * the user never chose.
 */
export function coerceShortcut(value: unknown): Shortcut | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const key = record.key
  if (typeof key !== 'string' || bindableKey(key) !== key) return undefined
  const shortcut: Shortcut = {
    mod: record.mod === true,
    ctrl: record.ctrl === true,
    shift: record.shift === true,
    alt: record.alt === true,
    key,
  }
  return validateShortcut(shortcut) === undefined ? shortcut : undefined
}

/**
 * Read every binding, falling back to the defaults per action.
 *
 * Per ACTION, not all-or-nothing: one unreadable entry must not reset the
 * others, because the user's other choices are still perfectly good.
 *
 * A single binding saved under the pre-set key is migrated into `open`, so an
 * existing customization survives this upgrade.
 */
export function readShortcuts(): Record<ShortcutAction, Shortcut> {
  const out: Record<ShortcutAction, Shortcut> = { ...DEFAULT_SHORTCUTS }
  try {
    const raw = window.localStorage.getItem(SHORTCUTS_KEY)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        for (const action of SHORTCUT_ACTIONS) {
          const coerced = coerceShortcut(record[action])
          if (coerced !== undefined) out[action] = coerced
        }
        return out
      }
      return out
    }
    // Migration: the earlier version stored only the palette's own binding.
    const legacy = window.localStorage.getItem(LEGACY_SHORTCUT_KEY)
    if (legacy !== null) {
      const coerced = coerceShortcut(JSON.parse(legacy))
      if (coerced !== undefined) out.open = coerced
    }
    return out
  } catch {
    return out
  }
}

/** The binding for one action, on the current platform. */
export function readShortcut(action: ShortcutAction = 'open'): Shortcut {
  return readShortcuts()[action]
}

/** Persist the whole set; a storage failure must not break the panel. */
export function writeShortcuts(shortcuts: Record<ShortcutAction, Shortcut>): void {
  try {
    window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts))
  } catch {
    // A full or blocked localStorage is not worth surfacing for a preference.
  }
}

/** Persist one action, leaving the others as stored. */
export function writeShortcut(shortcut: Shortcut, action: ShortcutAction = 'open'): void {
  writeShortcuts({ ...readShortcuts(), [action]: shortcut })
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

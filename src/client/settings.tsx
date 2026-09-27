/**
 * Settings panel for the per-workspace index rules, mounted into the official
 * `settings.section` slot.
 *
 * The panel edits `<active session cwd>/.dsh/quick-open.json` — the config
 * belongs to a WORKSPACE, not to the app, so the panel must name the workspace
 * it is editing. It reads the active cwd from the same `sessions` snapshot the
 * controller uses; with no active session (a fresh app, the welcome shell)
 * there is no workspace to edit, so the panel renders READ-ONLY and says why
 * instead of guessing a path.
 *
 * Every write goes through the host half's `config.set`, which validates and
 * writes atomically; this component never touches the filesystem.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Context, SessionScope } from './types.ts'
import { readActiveScope } from './controller.ts'
import { t } from './i18n.ts'
import { readSelectionFormat, writeSelectionFormat, type SelectionFormat } from './preview/selection.ts'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  describeShortcut,
  isMacPlatform,
  readShortcuts,
  shortcutFromEvent,
  shortcutHint,
  shortcutLabel,
  writeShortcut,
  type Shortcut,
  type ShortcutAction,
} from './shortcut.ts'

/** One list editor row group: a labelled textarea of newline-separated patterns. */
const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    fontSize: 13,
    color: '#cccccc',
    maxWidth: 720,
  },
  banner: {
    padding: '8px 12px',
    borderRadius: 6,
    fontSize: 12,
    lineHeight: 1.5,
  },
  bannerOk: {
    background: '#1e3a24',
    border: '1px solid #2d5a37',
    color: '#b8e0c0',
  },
  bannerWarn: {
    background: '#3a341e',
    border: '1px solid #5a532d',
    color: '#e6dcae',
  },
  path: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    color: '#9cdcfe',
    wordBreak: 'break-all',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  label: {
    fontSize: 12,
    color: '#9a9a9a',
  },
  hint: {
    fontSize: 11,
    color: '#6a6a6a',
    lineHeight: 1.5,
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 68,
    padding: '6px 8px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#cccccc',
    background: '#3c3c3c',
    border: '1px solid #555555',
    borderRadius: 4,
    outline: 'none',
    resize: 'vertical',
  },
  textareaReadonly: {
    background: '#2d2d2d',
    color: '#8a8a8a',
  },
  select: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    fontSize: 12,
    color: '#cccccc',
    background: '#3c3c3c',
    border: '1px solid #555555',
    borderRadius: 4,
    outline: 'none',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  checkbox: {
    accentColor: '#0e639c',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
  },
  button: {
    padding: '5px 14px',
    fontSize: 12,
    color: '#ffffff',
    background: '#0e639c',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
  },
  buttonSecondary: {
    padding: '5px 14px',
    fontSize: 12,
    color: '#cccccc',
    background: '#3a3a3a',
    border: '1px solid #555555',
    borderRadius: 4,
    cursor: 'pointer',
  },
  buttonDisabled: {
    opacity: 0.45,
    cursor: 'default',
  },
  buttonRecording: {
    background: '#7a3d0e',
    outline: '1px dashed #d7a05a',
    outlineOffset: 1,
  },
  status: {
    fontSize: 12,
    color: '#9a9a9a',
  },
  statusError: {
    fontSize: 12,
    color: '#f48771',
  },
}

interface RulesShape {
  excludeDirs: string[]
  includeDirs: string[]
  includeExtensions: string[]
  includeFilenames: string[]
  includeDirectories: boolean
  extraRoots: { path: string; label?: string }[]
}

interface ConfigGetValue {
  cwd: string
  configPath: string
  configExists: boolean
  rules: RulesShape
  indexedEntries: number
}

const EMPTY_RULES: RulesShape = {
  excludeDirs: [],
  includeDirs: [],
  includeExtensions: [],
  includeFilenames: [],
  includeDirectories: true,
  extraRoots: [],
}

async function post<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/quick-open/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const parsed: { ok?: boolean; value?: T; error?: { message?: string } } | null =
    await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
  }
  return parsed.value
}

/** Newline-separated list <-> array. Blank lines and stray whitespace are dropped. */
function toLines(values: readonly string[]): string {
  return values.join('\n')
}

function fromLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

/**
 * One extra-root line: `<absolute path>` or `<absolute path> | <label>`.
 * The host re-validates absolute-ness, so a relative line is simply dropped
 * there rather than being silently joined against some cwd here.
 */
function parseExtraRootLine(line: string): { path: string; label?: string } {
  const separator = line.indexOf('|')
  if (separator === -1) return { path: line.trim() }
  const path = line.slice(0, separator).trim()
  const label = line.slice(separator + 1).trim()
  return label === '' ? { path } : { path, label }
}

export function QuickOpenSettings({ ctx }: { ctx: Context }): React.ReactElement {
  const [scope, setScope] = useState<SessionScope | undefined>(() => readScope(ctx))
  const [rules, setRules] = useState<RulesShape>(EMPTY_RULES)
  const [configPath, setConfigPath] = useState<string>('')
  const [configExists, setConfigExists] = useState(false)
  const [indexedEntries, setIndexedEntries] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The viewer preference is app-wide (not a workspace index rule), so it is
  // stored beside the recents rather than in the workspace config file.
  const [selectionFormat, setSelectionFormat] = useState<SelectionFormat>(() => readSelectionFormat())
  // The quick-open gestures, app-wide for the same reason.
  const [shortcuts, setShortcuts] = useState<Record<ShortcutAction, Shortcut>>(() => readShortcuts())
  /** Which gesture is capturing the next combination, or null. */
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [shortcutError, setShortcutError] = useState<string | null>(null)

  /**
   * Capture the next combination while recording.
   *
   * `stopPropagation` matters: without it a recorded combination would also
   * reach the app underneath, so binding `Ctrl+K` would both set the shortcut
   * and trigger whatever else listens for it.
   */
  const onRecorderKeyDown = useCallback((event: React.KeyboardEvent, action: ShortcutAction) => {
    if (recording !== action) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(null)
      setShortcutError(null)
      return
    }
    const next = shortcutFromEvent(event.nativeEvent)
    if (typeof next === 'string') {
      setShortcutError(next)
      return
    }
    setShortcutError(null)
    setShortcuts((prev) => ({ ...prev, [action]: next }))
    writeShortcut(next, action)
    setRecording(null)
  }, [recording])

  // Follow the active session: switching conversations must switch the
  // workspace shown (and the file edited).
  useEffect(() => ctx.sessions.list.subscribe(() => {
    setScope(readScope(ctx))
  }), [ctx])

  const hasWorkspace = scope?.cwd !== undefined && scope.cwd !== ''

  const load = useCallback(async (target: SessionScope | undefined) => {
    if (target === undefined || target.cwd === undefined || target.cwd === '') {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const value = await post<ConfigGetValue>('config.get', {
        sessionId: target.sessionId,
        cwd: target.cwd,
      })
      setRules(value.rules)
      setConfigPath(value.configPath)
      setConfigExists(value.configExists)
      setIndexedEntries(value.indexedEntries)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(scope)
  }, [load, scope])

  const save = useCallback(async () => {
    if (scope?.cwd === undefined || scope.cwd === '') return
    setSaving(true)
    setStatus(null)
    setError(null)
    try {
      await post('config.set', { sessionId: scope.sessionId, cwd: scope.cwd, rules })
      setStatus(t('settingsSaved'))
      setConfigExists(true)
      // The rebuild runs in the host; a follow-up read reports the new count.
      window.setTimeout(() => {
        void load(scope)
        setStatus(null)
      }, 1200)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }, [load, rules, scope])

  const reset = useCallback(async () => {
    if (scope?.cwd === undefined || scope.cwd === '') return
    setSaving(true)
    setStatus(null)
    setError(null)
    try {
      await post('config.reset', { sessionId: scope.sessionId, cwd: scope.cwd })
      await load(scope)
      setStatus(t('settingsReset'))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }, [load, scope])

  const readOnly = !hasWorkspace || loading

  // The viewer preference is app-wide, so it renders even without a workspace
  // to edit — there is nothing workspace-scoped about it.
  const viewerSection = (
    <div style={styles.field}>
      <div style={styles.label}>{t('viewerLabel')}</div>
      <select
        style={styles.select}
        value={selectionFormat}
        onChange={(event) => {
          const next = event.target.value as SelectionFormat
          setSelectionFormat(next)
          writeSelectionFormat(next)
        }}
      >
        <option value="path">{t('viewerOptionPath')}</option>
        <option value="path-hint">{t('viewerOptionHint')}</option>
        <option value="content">{t('viewerOptionContent')}</option>
      </select>
      <div style={styles.hint}>{t('viewerHint')}</div>
    </div>
  )

  // The shortcut is app-wide too: it belongs to the user's habits, not to a
  // workspace. It renders in both branches for the same reason the viewer
  // preference does.
  // Every gesture is app-wide too, so this section renders in both branches.
  const shortcutSection = (
    <div style={styles.field}>
      <div style={styles.label}>{t('shortcutLabel')}</div>
      {SHORTCUT_ACTIONS.map((action) => (
        <div key={action} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <div style={styles.hint}>{shortcutLabel(action)}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              style={{ ...styles.button, ...(recording === action ? styles.buttonRecording : {}) }}
              onClick={() => setRecording(action)}
              onBlur={() => setRecording((current) => (current === action ? null : current))}
              onKeyDown={(event) => onRecorderKeyDown(event, action)}
            >
              {recording === action
                ? t('shortcutRecording')
                : describeShortcut(shortcuts[action], isMacPlatform())}
            </button>
            <button
              type="button"
              style={styles.buttonSecondary}
              onClick={() => {
                const fallback = DEFAULT_SHORTCUTS[action]
                setShortcuts((prev) => ({ ...prev, [action]: fallback }))
                writeShortcut(fallback, action)
                setShortcutError(null)
                setRecording(null)
              }}
              disabled={recording !== null}
            >
              {t('shortcutRestore')}
            </button>
          </div>
          <div style={styles.hint}>{shortcutHint(action)}</div>
        </div>
      ))}
      <div style={{ ...styles.hint, marginTop: 6 }}>
        {t('shortcutHint', {
          modifier: isMacPlatform() ? 'Cmd' : 'Ctrl',
          platform: isMacPlatform() ? 'macOS' : 'Windows / Linux',
        })}
        {shortcutError !== null && (
          <>
            <br />
            <span style={{ color: '#e6a0a0' }}>{shortcutError}</span>
          </>
        )}
      </div>
    </div>
  )

  if (!hasWorkspace) {
    return (
      <div style={styles.root}>
        <div style={{ ...styles.banner, ...styles.bannerWarn }}>
          {t('noWorkspaceTitle')}
          <br />
          {t('noWorkspaceBody')}
        </div>
        {viewerSection}
        {shortcutSection}
      </div>
    )
  }

  return (
    <div style={styles.root}>
      <div style={{ ...styles.banner, ...styles.bannerOk }}>
        <div>{t('currentWorkspace')}</div>
        <div style={styles.path}>{scope?.cwd}</div>
        <div style={{ ...styles.hint, marginTop: 6 }}>
          {t('configFile')}
          <span style={styles.path}>{configPath}</span>
          {configExists ? t('configExists') : t('configMissing')}
          {' · '}
          {t('indexedEntries', { count: indexedEntries.toLocaleString() })}
        </div>
      </div>

      {viewerSection}

      {shortcutSection}

      <div style={styles.field}>
        <div style={styles.label}>{t('excludeDirsLabel')}</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.excludeDirs)}
          onChange={event => setRules(prev => ({ ...prev, excludeDirs: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>{t('excludeDirsHint')}</div>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>{t('includeDirsLabel')}</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.includeDirs)}
          onChange={event => setRules(prev => ({ ...prev, includeDirs: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>{t('includeDirsHint')}</div>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>{t('includeExtensionsLabel')}</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.includeExtensions)}
          onChange={event => setRules(prev => ({ ...prev, includeExtensions: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>{t('includeExtensionsHint')}</div>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>{t('includeFilenamesLabel')}</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.includeFilenames)}
          onChange={event => setRules(prev => ({ ...prev, includeFilenames: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>{t('includeFilenamesHint')}</div>
      </div>

      <div style={styles.field}>
        <label style={styles.row}>
          <input
            type="checkbox"
            style={styles.checkbox}
            disabled={readOnly}
            checked={rules.includeDirectories}
            onChange={event => setRules(prev => ({ ...prev, includeDirectories: event.target.checked }))}
          />
          <span>{t('includeDirectoriesLabel')}</span>
        </label>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>{t('extraRootsLabel')}</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.extraRoots.map(root => (root.label === undefined
            ? root.path
            : `${root.path} | ${root.label}`)))}
          onChange={event => setRules(prev => ({
            ...prev,
            extraRoots: fromLines(event.target.value).map(parseExtraRootLine),
          }))}
        />
        <div style={styles.hint}>{t('extraRootsHint')}</div>
      </div>

      <div style={styles.actions}>
        <button
          type="button"
          style={{ ...styles.button, ...(readOnly || saving ? styles.buttonDisabled : {}) }}
          disabled={readOnly || saving}
          onClick={() => void save()}
        >
          {saving ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          style={{ ...styles.buttonSecondary, ...(readOnly || saving ? styles.buttonDisabled : {}) }}
          disabled={readOnly || saving}
          onClick={() => void reset()}
        >
          {t('reset')}
        </button>
        <button
          type="button"
          style={{ ...styles.buttonSecondary, ...(readOnly || saving ? styles.buttonDisabled : {}) }}
          disabled={readOnly || saving}
          onClick={() => void load(scope)}
        >
          {t('reload')}
        </button>
        {status !== null ? <span style={styles.status}>{status}</span> : null}
        {error !== null ? <span style={styles.statusError}>{error}</span> : null}
      </div>
    </div>
  )
}

/**
 * The active session's scope, or undefined when nothing is open.
 *
 * Delegates to the controller's reader so the settings panel and the Ctrl+P
 * layer can never disagree about which session they are configuring — they
 * used to carry two copies of the same (wrong) `snapshot.current` lookup.
 */
const readScope = readActiveScope

/**
 * The slot registration consumed by the client entry's `apply`.
 *
 * `label` is a GETTER rather than a string: the settings sidebar reads it when
 * it renders the section list, and the shell can change the language without a
 * reload. A captured string would keep the previous language until the page was
 * refreshed.
 */
export const quickOpenSettingsSection = {
  name: 'settings.section' as const,
  id: 'dsh-quick-open',
  order: 60,
  get label(): string {
    return t('settingsSection')
  },
}

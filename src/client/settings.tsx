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
import { readSelectionFormat, writeSelectionFormat, type SelectionFormat } from './preview/selection.ts'
import {
  DEFAULT_SHORTCUT,
  describeShortcut,
  isMacPlatform,
  readShortcut,
  shortcutFromEvent,
  writeShortcut,
  type Shortcut,
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
  // The quick-open shortcut, app-wide for the same reason.
  const [shortcut, setShortcut] = useState<Shortcut>(() => readShortcut())
  /** True while the button is capturing the next key combination. */
  const [recording, setRecording] = useState(false)
  const [shortcutError, setShortcutError] = useState<string | null>(null)

  /**
   * Capture the next combination while recording.
   *
   * `stopPropagation` matters: without it a recorded combination would also
   * reach the app underneath, so binding `Ctrl+K` would both set the shortcut
   * and trigger whatever else listens for it.
   */
  const onRecorderKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      setShortcutError(null)
      return
    }
    const next = shortcutFromEvent(event.nativeEvent)
    if (typeof next === 'string') {
      setShortcutError(next)
      return
    }
    setShortcutError(null)
    setShortcut(next)
    writeShortcut(next)
    setRecording(false)
  }, [recording])

  const resetShortcut = useCallback(() => {
    setShortcut(DEFAULT_SHORTCUT)
    writeShortcut(DEFAULT_SHORTCUT)
    setShortcutError(null)
    setRecording(false)
  }, [])

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
      setStatus('已保存，正在按新规则重建索引…')
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
      setStatus('已删除配置文件，恢复内置默认规则。')
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
      <div style={styles.label}>文件查看器：选中文本加入会话的格式</div>
      <select
        style={styles.select}
        value={selectionFormat}
        onChange={(event) => {
          const next = event.target.value as SelectionFormat
          setSelectionFormat(next)
          writeSelectionFormat(next)
        }}
      >
        <option value="path">仅位置：@path/file.cpp:12-15</option>
        <option value="path-hint">位置 + 提示模型去读取该段</option>
        <option value="content">位置 + 围栏代码块（带上选中内容）</option>
      </select>
      <div style={styles.hint}>
        在侧边栏文件里选中文本后点「加入会话」时插入的内容。
        <br />
        <strong>仅位置</strong>最省上下文，模型自行读取所需范围；
        <strong>位置 + 提示</strong>多一句「请用 read 读取该段」，能减少模型忽略行号的情况；
        <strong>围栏代码块</strong>把选中内容一并带入，代价是每轮都重复这段代码。
      </div>
    </div>
  )

  // The shortcut is app-wide too: it belongs to the user's habits, not to a
  // workspace. It renders in both branches for the same reason the viewer
  // preference does.
  const shortcutSection = (
    <div style={styles.field}>
      <div style={styles.label}>呼出快速打开面板的快捷键</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          style={{ ...styles.button, ...(recording ? styles.buttonRecording : {}) }}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={onRecorderKeyDown}
        >
          {recording
            ? '按下新的快捷键…（Esc 取消）'
            : describeShortcut(shortcut, isMacPlatform())}
        </button>
        <button
          type="button"
          style={styles.button}
          onClick={resetShortcut}
          disabled={recording}
        >
          恢复默认
        </button>
      </div>
      <div style={styles.hint}>
        点上面的按钮再按一次新的组合键即可（必须带修饰键）。
        <br />
        默认：
        <strong>{describeShortcut(DEFAULT_SHORTCUT, isMacPlatform())}</strong>
        ，其中 {isMacPlatform() ? 'Cmd' : 'Ctrl'} 是
        {isMacPlatform() ? 'macOS' : '本平台'}的主修饰键——同一份配置换到
        {isMacPlatform() ? ' Windows 会按 Ctrl' : ' macOS 会按 Cmd'} 解释，
        所以跨平台的习惯都能对上。
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
          当前没有活跃会话，无法确定要编辑哪个工作区。
          <br />
          索引规则按工作区存放（<code>.dsh/quick-open.json</code> 位于工作区根目录下），
          请先打开一个会话再回到此面板。
        </div>
        {viewerSection}
        {shortcutSection}
      </div>
    )
  }

  return (
    <div style={styles.root}>
      <div style={{ ...styles.banner, ...styles.bannerOk }}>
        <div>当前工作区</div>
        <div style={styles.path}>{scope?.cwd}</div>
        <div style={{ ...styles.hint, marginTop: 6 }}>
          配置文件：
          <span style={styles.path}>{configPath}</span>
          {configExists ? '（已存在）' : '（不存在，当前使用内置默认规则）'}
          {' · '}
          已索引 <strong>{indexedEntries.toLocaleString()}</strong> 项
        </div>
      </div>

      {viewerSection}

      {shortcutSection}

      <div style={styles.field}>
        <div style={styles.label}>排除目录 excludeDirs</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.excludeDirs)}
          onChange={event => setRules(prev => ({ ...prev, excludeDirs: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>
          每行一个，相对工作区根。<code>build/go</code> 只匹配该目录；
          <code>**/shaders/d3d11</code> 匹配任意深度下同名目录。目录被排除后整棵子树都不遍历。
        </div>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>强制包含目录 includeDirs</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.includeDirs)}
          onChange={event => setRules(prev => ({ ...prev, includeDirs: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>
          优先级高于排除目录。用于救回被父级排除但确实需要的生成树，
          例如 <code>build/p/include</code>（生成的头文件，源码会 include）。
        </div>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>包含后缀 includeExtensions</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.includeExtensions)}
          onChange={event => setRules(prev => ({ ...prev, includeExtensions: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>
          每行一个，带点，如 <code>.cpp</code>。只有这些后缀的文件进索引。
          <strong>留空表示不按后缀过滤</strong>（索引遍历到的所有文件）。
        </div>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>包含文件名 includeFilenames</div>
        <textarea
          style={{ ...styles.textarea, ...(readOnly ? styles.textareaReadonly : {}) }}
          readOnly={readOnly}
          spellCheck={false}
          value={toLines(rules.includeFilenames)}
          onChange={event => setRules(prev => ({ ...prev, includeFilenames: fromLines(event.target.value) }))}
        />
        <div style={styles.hint}>
          每行一个完整文件名（不区分大小写），不受后缀过滤限制。
          用于 <code>CMakeLists.txt</code> 这类需要保留的名字。
        </div>
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
          <span>索引目录条目（关闭后无法在快速打开面板里引用 <code>@dir/</code>）</span>
        </label>
      </div>

      <div style={styles.field}>
        <div style={styles.label}>额外索引根 extraRoots</div>
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
        <div style={styles.hint}>
          每行一个<strong>绝对目录路径</strong>，可加 <code>| 别名</code> 指定结果行里显示的前缀。
          用于索引工作区<b>之外</b>的目录——例如引擎仓库与游戏仓库是并列的两个文件夹，开发时需要互查。
          这些目录用与工作区相同的目录/后缀规则遍历，结果行以完整绝对路径显示。
        </div>
      </div>

      <div style={styles.actions}>
        <button
          type="button"
          style={{ ...styles.button, ...(readOnly || saving ? styles.buttonDisabled : {}) }}
          disabled={readOnly || saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存到工作区'}
        </button>
        <button
          type="button"
          style={{ ...styles.buttonSecondary, ...(readOnly || saving ? styles.buttonDisabled : {}) }}
          disabled={readOnly || saving}
          onClick={() => void reset()}
        >
          恢复默认
        </button>
        <button
          type="button"
          style={{ ...styles.buttonSecondary, ...(readOnly || saving ? styles.buttonDisabled : {}) }}
          disabled={readOnly || saving}
          onClick={() => void load(scope)}
        >
          重新读取
        </button>
        {status !== null ? <span style={styles.status}>{status}</span> : null}
        {error !== null ? <span style={styles.statusError}>{error}</span> : null}
      </div>
    </div>
  )
}

/** The active session's scope, or undefined when nothing is open. */
function readScope(ctx: Context): SessionScope | undefined {
  const snapshot = ctx.sessions.list.getSnapshot()
  const sessionId = snapshot.current
  if (sessionId === undefined) return undefined
  const cwd = snapshot.byId[sessionId]?.cwd
  return { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
}

/** The slot registration consumed by the client entry's `apply`. */
export const quickOpenSettingsSection = {
  name: 'settings.section' as const,
  id: 'dsh-quick-open',
  order: 60,
  label: 'Quick Open 索引',
}

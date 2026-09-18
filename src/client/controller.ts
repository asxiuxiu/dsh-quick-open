/**
 * Quick-open controller: owns every side effect the layer needs — global
 * shortcut gating, workspace search, recent-files history, file open (through
 * DSH's native right Sidebar), and conversation-draft reference insert.
 *
 * Search pipeline, fastest path first:
 *
 * 1. QUERY CACHE — a small LRU of served results makes backspacing and
 *    reopening the layer with a preserved query instant; a background
 *    revalidation still refreshes the list.
 * 2. INDEXED ROUTE — `/quick-open/api/search` (this plugin's own host half)
 *    answers from a per-workspace in-memory index with a fuzzy scorer, and
 *    returns rows ALREADY RANKED together with the spans to highlight
 *    (single-digit ms at 50k entries). The client must not re-rank these:
 *    fuzzy matches are not substrings, and only the host has the index.
 *
 * The client-side incremental filter that used to sit in front of the network
 * is gone: it relied on substring semantics (extending a query can only shrink
 * a complete result set), which fuzzy matching does not satisfy.
 *
 * Interaction invariants enforced here:
 * - FOCUS: the search input owns keyboard focus for the layer's whole life.
 *   Any action that keeps the layer open (reference append) bumps `focusSeq`
 *   — twice, the second pass ~80ms later to win the race against the
 *   composer's own async focus when the draft is written.
 * - DIRECTORIES: rows whose kind is unknown (recents) are probed before an
 *   open; indexed rows carry `isDir` and skip the probe. Files open in the
 *   sidebar editor; folders reference as `@dir/`.
 * - REFERENCES: appended to the draft as plain text with exactly one
 *   separating space (see `appendReferenceText` for why the chip path is not
 *   usable from a plugin).
 * - RECENTS: an empty query shows the per-workspace recent list
 *   (localStorage), so Ctrl+P → Enter reopens the last file.
 */
import type { Context, SessionScope, SidebarRightServiceLike } from './types.ts'
import type { MatchSpan, QuickOpenStore, SearchEntry } from './store.ts'

/** Debounce before a keystroke becomes a search request (ms). */
const SEARCH_DEBOUNCE_MS = 100
/** How long a transient notice stays visible (ms). */
const NOTICE_MS = 1600
/** Second focus-reclaim pass after a chip insert (ms). */
const REFOCUS_RETRY_MS = 80
/** Cap of the per-workspace recent-files list. */
const RECENTS_CAP = 15
/** Cap of the query-result LRU cache. */
const QUERY_CACHE_CAP = 10

/** POSIX roots, drive letters and UNC shares must not be joined onto cwd. */
function isAbsolutePath(path: string): boolean {
  return /^(?:[\\/]|[a-zA-Z]:[\\/]|\\\\)/.test(path)
}

/** Resolve a (possibly relative) search match against the session cwd. */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (isAbsolutePath(path)) return path
  const base = cwd ?? ''
  if (base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path}`
}

/** The row's absolute path: extra-root rows are already absolute. */
function absolutePathOf(scope: SessionScope, entry: SearchEntry): string {
  if (entry.absolute === true || isAbsolutePath(entry.path)) return entry.path
  return resolveWorkspacePath(scope.cwd, entry.path)
}

/**
 * Component-encode one address segment, keeping ':' literal so a Windows
 * drive letter survives (`E:` reads as `E:`, not `E%3A`).
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * The `dsh-resource://file/…` address of one file, in the native right
 * Sidebar's address grammar (`@deepseek-ai/dsh-util-workspace-path`).
 *
 * A path inside the session workspace is recorded relative to its root, so
 * the same file in two sessions reads as two distinct addresses; an absolute
 * path outside the workspace keeps its own spelling, which the grammar
 * resolves regardless of cwd. Both separators normalize to '/'.
 */
export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const root = cwd === undefined ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = !isAbsolutePath(normalized)
    ? normalized.replace(/^(?:\.\/)+/, '')
    : root !== '' && normalized === root
      ? ''
      : root !== '' && normalized.startsWith(`${root}/`)
        ? normalized.slice(root.length + 1)
        : normalized
  const encoded = relative.split('/').map(encodeSegment).join('/')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`
}

/**
 * The DSH `@file` spelling for one path, mirroring the host grammar
 * (`formatFileMention` in @deepseek-ai/dsh-file-reference): plain when there
 * is no whitespace, quoted when there is; a directory keeps its trailing slash
 * (a quoted directory deliberately leaves the quote OPEN so completion can
 * descend another level). `undefined` when the path carries a control
 * character or quote the editor grammar cannot represent.
 */
function fileMention(path: string, kind: 'file' | 'directory'): string | undefined {
  const base = path.replace(/[\\/]+$/, '')
  const text = kind === 'directory' ? `${base}/` : base
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u0022]/u.test(text)) return undefined
  if (!/\s/u.test(text)) return `@${text}`
  return kind === 'directory' ? `@"${text}` : `@"${text}"`
}

/** Shared POST helper for the `{ok:true,value}` JSON envelope both plugin APIs use. */
async function apiCall<T>(base: string, method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const parsed: { ok?: boolean; value?: T; error?: { message?: string } } | null =
    await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
  }
  return parsed.value
}

function scopePayload(scope: SessionScope, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: scope.sessionId,
    ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    ...extra,
  }
}

interface IndexedSearchResult {
  matches: {
    path: string
    isDir: boolean
    absolute?: boolean
    rootLabel?: string
    nameSpans?: MatchSpan[]
    dirSpans?: MatchSpan[]
  }[]
  truncated: boolean
  indexedEntries?: number
  indexAge?: number
}

/**
 * Directory probe for rows whose kind the wire did not carry (the recents
 * list). This plugin's own host route answers `quick-open/api/probe`: it
 * stats the path and reports whether it is a directory. Any failure is
 * treated as "file" so a probe hiccup never blocks opening.
 */
async function probeIsDir(scope: SessionScope, relativePath: string): Promise<boolean> {
  try {
    const result = await apiCall<{ isDir?: boolean }>('/quick-open/api', 'probe', scopePayload(scope, { path: relativePath }))
    return result.isDir === true
  } catch {
    return false
  }
}

export function createQuickOpenController(ctx: Context, store: QuickOpenStore) {
  let debounceTimer: number | undefined
  let noticeTimer: number | undefined
  let inFlight: AbortController | undefined
  let searchSeq = 0
  /** Small LRU of served results by scope+query: instant backspace/reopen. */
  const queryCache = new Map<string, { entries: SearchEntry[]; complete: boolean }>()

  /** The active session's scope (id + cwd when hydrated); undefined without a session. */
  const currentScope = (): SessionScope | undefined => {
    const snapshot = ctx.sessions.list.getSnapshot()
    const sessionId = snapshot.current
    if (sessionId === undefined) return undefined
    const cwd = snapshot.byId[sessionId]?.cwd
    return { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
  }

  const scopeKeyOf = (scope: SessionScope): string => `${scope.sessionId}\n${scope.cwd ?? ''}`

  /**
   * The native right Sidebar's navigation face. It is the only channel a
   * plugin has for opening a file in the sidebar, and the sidebar's own file
   * tree goes through it too, so a quick-open Enter and a tree click land
   * identically. Absent only before the sidebar half mounts.
   */
  const sidebarRight = (): SidebarRightServiceLike | undefined => ctx.get('sidebarRight')

  // --- recents (per-workspace, localStorage) ---

  const recentsKey = (): string | undefined => {
    const cwd = currentScope()?.cwd
    return cwd === undefined ? undefined : `dsh-quick-open:recents:${cwd}`
  }

  /**
   * Recents persist as `{path, a?, l?}` objects rather than bare strings: a
   * row from an extra root must keep its `absolute` flag, otherwise reloading
   * the history would turn an absolute path back into a "workspace-relative"
   * one and every later action on it would resolve against the wrong cwd.
   * Plain strings are still read (older entries).
   */
  const loadRecents = (): SearchEntry[] => {
    const key = recentsKey()
    if (key === undefined) return []
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === null) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      const out: SearchEntry[] = []
      for (const item of parsed) {
        if (typeof item === 'string') {
          out.push({ path: item })
          continue
        }
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        if (typeof record.path !== 'string' || record.path === '') continue
        out.push({
          path: record.path,
          ...(record.absolute === true ? { absolute: true } : {}),
          ...(typeof record.label === 'string' && record.label !== '' ? { rootLabel: record.label } : {}),
        })
      }
      return out
    } catch {
      return []
    }
  }

  const pushRecent = (entry: SearchEntry): void => {
    const key = recentsKey()
    if (key === undefined) return
    const rest = loadRecents().filter(item => item.path !== entry.path)
    const next = [entry, ...rest].slice(0, RECENTS_CAP)
    const serialized = next.map(item => (item.absolute === true
      ? { path: item.path, absolute: true, ...(item.rootLabel !== undefined ? { label: item.rootLabel } : {}) }
      : item.path))
    try {
      window.localStorage.setItem(key, JSON.stringify(serialized))
    } catch {
      // storage full / private mode: history is best-effort
    }
    // Keep the visible list in sync when it is showing recents.
    const state = store.getSnapshot()
    if (state.open && state.listKind === 'recents') {
      store.set({ matches: next, selected: 0 })
    }
  }

  // --- feedback ---

  const notice = (text: string): void => {
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    store.set({ notice: text })
    noticeTimer = window.setTimeout(() => {
      noticeTimer = undefined
      store.set({ notice: null })
    }, NOTICE_MS)
  }

  /**
   * Reclaim keyboard focus for the layer: an immediate bump plus one delayed
   * pass, because the conversation composer grabs focus asynchronously when
   * it mints a reference chip — a single refocus races it and loses.
   */
  const reclaimFocus = (): void => {
    store.set({ focusSeq: store.getSnapshot().focusSeq + 1 })
    window.setTimeout(() => {
      if (store.getSnapshot().open) store.set({ focusSeq: store.getSnapshot().focusSeq + 1 })
    }, REFOCUS_RETRY_MS)
  }

  const cancelSearch = (): void => {
    if (debounceTimer !== undefined) {
      window.clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
    inFlight?.abort()
    inFlight = undefined
  }

  /**
   * Whether Ctrl+P can do anything useful right now. The overlay slot only
   * renders inside a session, so without one the shortcut is NOT swallowed
   * and the browser default (print) passes through.
   */
  const canServe = (): boolean => currentScope() !== undefined

  const open = (): void => {
    const scope = currentScope()
    if (scope === undefined) return
    cancelSearch()
    const query = store.getSnapshot().query
    store.set({
      open: true,
      sessionId: scope.sessionId,
      selected: 0,
      error: null,
      indexInfo: null,
      focusSeq: store.getSnapshot().focusSeq + 1,
      // An empty query shows the recent-files list; a preserved query
      // re-searches below (cache-hit first).
      ...(query.trim() === ''
        ? { matches: loadRecents(), listKind: 'recents' as const }
        : {}),
    })
    if (query.trim() !== '') runSearch(query.trim())
  }

  const close = (): void => {
    if (!store.getSnapshot().open) return
    cancelSearch()
    store.reset()
  }

  /** Ctrl+P toggles the layer, exactly like VSCode's quick open. */
  const toggle = (): void => {
    if (store.getSnapshot().open) close()
    else open()
  }

  /** Close when the active session changes: stale matches belong to the old cwd. */
  const closeOnSessionChange = (): void => {
    const state = store.getSnapshot()
    if (!state.open) return
    if (state.sessionId !== currentScope()?.sessionId) close()
  }

  /** One network search against this plugin's own indexed route. */
  const fetchEntries = async (
    scope: SessionScope,
    query: string,
    signal: AbortSignal,
  ): Promise<{ entries: SearchEntry[]; truncated: boolean; indexInfo: string | null }> => {
    const found = await apiCall<IndexedSearchResult>('/quick-open/api', 'search', scopePayload(scope, { query }), signal)
    const indexInfo = found.indexedEntries !== undefined
      ? `索引 ${found.indexedEntries.toLocaleString()} 项 · ${Math.round((found.indexAge ?? 0) / 1000)}s 前`
      : null
    return { entries: found.matches, truncated: found.truncated, indexInfo }
  }

  const cachePut = (key: string, value: { entries: SearchEntry[]; complete: boolean }): void => {
    queryCache.delete(key)
    queryCache.set(key, value)
    while (queryCache.size > QUERY_CACHE_CAP) {
      const oldest = queryCache.keys().next().value
      if (oldest === undefined) break
      queryCache.delete(oldest)
    }
  }

  const runSearch = (query: string): void => {
    const scope = currentScope()
    if (scope === undefined) return
    const scopeKey = scopeKeyOf(scope)
    const needle = query.toLowerCase()

    // The incremental local filter that used to live here relied on substring
    // semantics: extending a query could only shrink a complete result set.
    // Fuzzy matching breaks that invariant — a longer query can match entries
    // the shorter one rejected (and vice versa) — so every query now goes to
    // the host, which is fast enough (single-digit ms) to make that a non-issue.
    cancelSearch()
    const seq = ++searchSeq
    const controller = new AbortController()
    inFlight = controller

    // 2. Query cache: serve instantly, revalidate in the background.
    const cached = queryCache.get(`${scopeKey}\n${needle}`)
    if (cached !== undefined) {
      store.set({
        searching: true,
        matches: cached.entries,
        truncated: !cached.complete,
        selected: 0,
        error: null,
        listKind: 'search',
      })
    } else {
      store.set({ searching: true, error: null, listKind: 'search' })
    }

    fetchEntries(scope, query, controller.signal)
      .then((found) => {
        if (seq !== searchSeq || controller.signal.aborted) return
        const complete = !found.truncated
        cachePut(`${scopeKey}\n${needle}`, { entries: found.entries, complete })
        store.set({
          searching: false,
          matches: found.entries,
          truncated: found.truncated,
          selected: 0,
          error: null,
          indexInfo: found.indexInfo,
        })
      })
      .catch((failure: unknown) => {
        if (seq !== searchSeq || controller.signal.aborted) return
        store.set({
          searching: false,
          matches: [],
          truncated: false,
          error: failure instanceof Error ? failure.message : String(failure),
        })
      })
  }

  const setQuery = (query: string): void => {
    store.set({ query })
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    if (query.trim() === '') {
      cancelSearch()
      searchSeq += 1
      // Back to the recent-files list.
      store.set({ matches: loadRecents(), listKind: 'recents', truncated: false, selected: 0, searching: false, error: null })
      return
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined
      runSearch(query.trim())
    }, SEARCH_DEBOUNCE_MS)
  }

  const move = (delta: number): void => {
    const { matches, selected } = store.getSnapshot()
    if (matches.length === 0) return
    const next = (selected + delta + matches.length) % matches.length
    store.set({ selected: next })
  }

  const select = (index: number): void => {
    store.set({ selected: index })
  }

  /** Jump to the first/last row (Home/End, PageUp/PageDown). */
  const jump = (where: 'first' | 'last'): void => {
    const { matches } = store.getSnapshot()
    if (matches.length === 0) return
    store.set({ selected: where === 'first' ? 0 : matches.length - 1 })
  }

  const selectedMatch = (): SearchEntry | undefined => {
    const { matches, selected } = store.getSnapshot()
    return matches[selected]
  }

  /** The row's kind, probing only when the wire did not carry it. */
  const resolveIsDir = (scope: SessionScope, entry: SearchEntry): Promise<boolean> => {
    if (entry.isDir !== undefined) return Promise.resolve(entry.isDir)
    // Rows from the indexed route always carry isDir; only the recents list
    // can lack it. Those rows may be extra-root files, so probe the absolute
    // path.
    return probeIsDir(scope, absolutePathOf(scope, entry))
  }

  /**
   * Tab: complete the search box from the selected row.
   *
   * Completion is SEGMENT-WISE, which is what makes Tab useful for drilling
   * into a tree rather than only for accepting a whole path:
   *
   * - A DIRECTORY row completes to that directory with a trailing '/', so
   *   repeated Tab presses walk down the tree (`ui/` -> `ui/coherent/` -> …).
   * - A FILE row completes to its full path, finishing the query.
   *
   * The completion must satisfy the SAME scope as the token it replaces:
   * a `file:` token can only ever match a basename, so completing it with a
   * full path would produce a query that matches nothing. That mistake is easy
   * to make and silent, so the scope decides which text is written.
   */
  const completeSelected = (): void => {
    const entry = selectedMatch()
    if (entry === undefined) return
    const state = store.getSnapshot()
    // The empty-query list is the recent-files history, not search results:
    // completing from it would paste a path the user never searched for.
    if (state.listKind === 'recents') return
    const trimmed = state.query.trim()

    // Keep every earlier token; only the last one is being completed.
    const tokens = trimmed.split(/\s+/u).filter(token => token !== '')
    const lastToken = tokens[tokens.length - 1] ?? ''
    const prefixMatch = /^(dir:|d:|file:|f:)/u.exec(lastToken)
    const scope = prefixMatch === null
      ? 'any'
      : (prefixMatch[1].startsWith('f') ? 'name' : 'dir')
    const head = tokens.slice(0, Math.max(0, tokens.length - 1))
    const headText = head.filter(token => !/^(?:dir:|d:|file:|f:)$/u.test(token)).join(' ')

    // What this row can be completed TO, given the token's scope.
    const path = entry.path
    const basename = path.slice(path.lastIndexOf('/') + 1)
    let completed: string
    if (scope === 'name') {
      completed = basename
    } else if (entry.isDir === true) {
      completed = `${path.replace(/\/+$/, '')}/`
    } else {
      completed = path
    }

    const prefixText = prefixMatch === null ? '' : prefixMatch[1]
    const next = `${headText === '' ? '' : `${headText} `}${prefixText}${completed}`
    applyQuery(next)
  }

  /**
   * Write the query and search immediately, bypassing the keystroke debounce:
   * a completion should show its results at once, not 100ms later.
   */
  const applyQuery = (text: string): void => {
    store.set({ query: text })
    cancelSearch()
    const trimmed = text.trim()
    if (trimmed === '') {
      searchSeq += 1
      store.set({ matches: loadRecents(), listKind: 'recents', truncated: false, selected: 0, searching: false, error: null })
      return
    }
    runSearch(trimmed)
  }

  /** Enter: open the selected file in the sidebar editor, then close. */
  const openSelected = async (): Promise<void> => {
    const entry = selectedMatch()
    if (entry === undefined) return
    const scope = currentScope()
    if (scope === undefined) return
    if (await resolveIsDir(scope, entry)) {
      notice('这是目录：Ctrl+Enter 以 @dir/ 引用')
      reclaimFocus()
      return
    }
    const service = sidebarRight()
    if (service === undefined) {
      notice('侧边栏服务未就绪，暂时无法打开文件')
      reclaimFocus()
      return
    }
    // An extra-root row already carries an absolute path; joining it against
    // the cwd would produce nonsense like `E:\chaos\E:\wolfgang\...`.
    try {
      service.openResource(fileAddressFor(scope.sessionId, scope.cwd, absolutePathOf(scope, entry)))
    } catch (error) {
      // An address no registered tab type claims throws in the navigation
      // face; surface it instead of letting the overlay vanish silently.
      notice(error instanceof Error ? error.message : '无法打开这个文件')
      reclaimFocus()
      return
    }
    pushRecent(entry)
    close()
  }

  /** Append plain mention text at the end of the conversation draft. */
  /**
   * Append one reference to the end of the conversation draft as PLAIN TEXT,
   * guaranteeing exactly one separating space.
   *
   * Why not the chip path (`slash/input-insert-reference`): that event's `span`
   * is in DETECT coordinates, where a chip occupies a single U+FFFC character,
   * while the public `draft` string is the CLIPBOARD projection, where the same
   * chip expands to its full `@path` text. Feeding a clipboard-derived offset
   * into a detect-coordinate splice overruns the document — `selectSpan` maps
   * nothing, the edit silently fails, and successive inserts end up jammed
   * together with the spacing lost. Detect offsets are not exposed on the
   * public input face, so there is no correct chip-path span to compute.
   * Plain text is fully under our control and is what a chip serializes to
   * anyway (`clipboardText` === the mention).
   */
  const appendReferenceText = (sessionId: string, mention: string): boolean => {
    const actx = ctx.sessions.scope(sessionId)
    const conversation = ctx.get('conversation')
    if (actx === undefined || conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    // Exactly one space between references: append to a non-empty draft, but
    // never double up when the user already left trailing whitespace.
    const trimmed = draft.replace(/\s+$/u, '')
    input.setDraft(trimmed === '' ? mention : `${trimmed} ${mention}`)
    return true
  }

  /**
   * Ctrl+Enter: append the selected match to the conversation draft and KEEP
   * the layer open so several references can stack. Both files and folders go
   * in as plain `@`-mention text through `appendReferenceText` — see that
   * function for why the chip path is unusable here.
   */
  const referenceSelected = async (): Promise<void> => {
    const entry = selectedMatch()
    if (entry === undefined) return
    const scope = currentScope()
    if (scope === undefined) return

    // The reference is ABSOLUTE for an extra-root row: the workspace-relative
    // spelling does not exist for a file outside the workspace, and DSH's file
    // grammar resolves any absolute path regardless of cwd.
    const referencePath = absolutePathOf(scope, entry)

    // Folders reference as @dir/ (no quote survives the trailing slash);
    // files go through the shared grammar. Open does not depend on this.
    const kind = await resolveIsDir(scope, entry) ? 'directory' as const : 'file' as const
    const reference = fileMention(referencePath, kind)
    if (reference === undefined) {
      notice('路径包含无法引用的字符')
      reclaimFocus()
      return
    }
    if (appendReferenceText(scope.sessionId, reference)) {
      pushRecent(entry)
    } else {
      notice('对话服务不可用')
    }
    // The composer grabbed focus while appending — take it back so the next
    // keystroke still goes to the search box.
    reclaimFocus()
  }

  return {
    store,
    canServe,
    toggle,
    open,
    close,
    closeOnSessionChange,
    setQuery,
    move,
    select,
    jump,
    completeSelected,
    openSelected,
    referenceSelected,
  }
}

export type QuickOpenController = ReturnType<typeof createQuickOpenController>

/** The `@`-mention spelling, exposed for the offline address/mention checks. */
export const fileMentionForTest = fileMention

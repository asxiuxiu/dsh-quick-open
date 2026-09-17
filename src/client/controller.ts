/**
 * Quick-open controller: owns every side effect the layer needs — global
 * shortcut gating, workspace search, recent-files history, file open
 * (through the dsh-better-sidebar service), and conversation-draft reference
 * insert.
 *
 * Search pipeline, fastest path first:
 *
 * 1. INCREMENTAL FILTER — when the new query extends the last one and its
 *    result was complete (not truncated), substring semantics make the
 *    locally-filtered set EXACT: zero network, zero server CPU.
 * 2. QUERY CACHE — a small LRU of served results makes backspacing and
 *    reopening the layer with a preserved query instant; a background
 *    revalidation still refreshes the list.
 * 3. INDEXED ROUTE — `/quick-open/api/search` (this plugin's own host half)
 *    answers from a per-workspace in-memory index (<10ms at 100k entries)
 *    and carries `isDir` on every row.
 * 4. LEGACY FALLBACK — dsh-better-sidebar's `fs.search` (full tree walk per
 *    keystroke, no isDir): used when the host half is unavailable, detected
 *    once per activation rather than retried per keystroke.
 *
 * Interaction invariants enforced here:
 * - FOCUS: the search input owns keyboard focus for the layer's whole life.
 *   Any action that keeps the layer open (reference insert) bumps `focusSeq`
 *   — twice, the second pass ~80ms later to win the race against the
 *   composer's own async focus on chip insert.
 * - DIRECTORIES: rows whose kind is unknown (legacy route, recents) are
 *   probed via `/sidebar/api/fs.tree` on demand; indexed rows skip the
 *   probe. Files open in the sidebar editor; folders reference as `@dir/`.
 * - RECENTS: an empty query shows the per-workspace recent list
 *   (localStorage), so Ctrl+P → Enter reopens the last file.
 */
import type { BetterSidebarServiceLike, Context, SessionScope } from './types.ts'
import type { QuickOpenStore, SearchEntry } from './store.ts'

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

/**
 * The DSH `@file` spelling for one relative path, mirroring the host grammar
 * (`formatFileMention` in @deepseek-ai/dsh-file-reference): plain when there
 * is no whitespace, quoted when there is; `undefined` when the path carries
 * a control character or quote the editor grammar cannot represent.
 */
function fileMention(relativePath: string): { mention: string; label: string } | undefined {
  const path = relativePath.replace(/[\\/]+$/, '')
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u0022]/u.test(path)) return undefined
  const mention = /\s/u.test(path) ? `@"${path}"` : `@${path}`
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const label = at === -1 ? path : path.slice(at + 1)
  return { mention, label }
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
  matches: { path: string; isDir: boolean }[]
  truncated: boolean
  indexedEntries?: number
  indexAge?: number
}

interface LegacySearchResult {
  matches: string[]
  truncated: boolean
}

/**
 * Directory probe for rows whose kind the wire did not carry: `fs.tree`
 * lists one level and throws on a non-directory path, so success/failure is
 * the isDir signal. Any failure is treated as "file" so a probe hiccup never
 * blocks opening.
 */
async function probeIsDir(scope: SessionScope, relativePath: string): Promise<boolean> {
  try {
    await apiCall('/sidebar/api', 'fs.tree', scopePayload(scope, { path: relativePath }))
    return true
  } catch {
    return false
  }
}

/**
 * Client-side re-rank of server matches: exact basename match first, then
 * basename prefix, then other basename hits, shorter paths winning ties.
 * Both routes match name-substrings only, so every row contains the query in
 * its basename.
 */
export function rankMatches(entries: SearchEntry[], query: string): SearchEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries
  const score = (rel: string): number => {
    const at = rel.lastIndexOf('/')
    const name = (at === -1 ? rel : rel.slice(at + 1)).toLowerCase()
    if (name === needle) return 0
    if (name.startsWith(needle)) return 1
    return 2
  }
  return entries
    .map((entry, index) => ({ entry, index, score: score(entry.path) }))
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.index - b.index)
    .map(item => item.entry)
}

/** Lowercase basename of a '/'-separated relative path (the match target). */
function nameLowerOf(rel: string): string {
  const at = rel.lastIndexOf('/')
  return (at === -1 ? rel : rel.slice(at + 1)).toLowerCase()
}

export function createQuickOpenController(ctx: Context, store: QuickOpenStore) {
  let debounceTimer: number | undefined
  let noticeTimer: number | undefined
  let inFlight: AbortController | undefined
  let searchSeq = 0
  /**
   * Fast-route availability: undefined = untested, true/false after the
   * first settled request. A failed probe disables the route for the rest of
   * the activation (an abort is not a failure).
   */
  let fastRoute: boolean | undefined
  /** The last served search: the incremental filter's exactness source. */
  let lastServed: { scopeKey: string; needle: string; entries: SearchEntry[]; complete: boolean } | null = null
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
   * The sidebar service, gated on its monotonic capability list
   * ('openFile' exists since v0.12.0 and features are never removed).
   */
  const sidebar = (): BetterSidebarServiceLike | undefined => {
    const service = ctx.get('betterSidebar')
    if (service === undefined || !service.features.includes('openFile')) return undefined
    return service
  }

  // --- recents (per-workspace, localStorage) ---

  const recentsKey = (): string | undefined => {
    const cwd = currentScope()?.cwd
    return cwd === undefined ? undefined : `dsh-quick-open:recents:${cwd}`
  }

  const loadRecents = (): SearchEntry[] => {
    const key = recentsKey()
    if (key === undefined) return []
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === null) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string').map(path => ({ path }))
        : []
    } catch {
      return []
    }
  }

  const pushRecent = (rel: string): void => {
    const key = recentsKey()
    if (key === undefined) return
    const paths = [rel, ...loadRecents().map(e => e.path).filter(x => x !== rel)].slice(0, RECENTS_CAP)
    try {
      window.localStorage.setItem(key, JSON.stringify(paths))
    } catch {
      // storage full / private mode: history is best-effort
    }
    // Keep the visible list in sync when it is showing recents.
    const state = store.getSnapshot()
    if (state.open && state.listKind === 'recents') {
      store.set({ matches: paths.map(path => ({ path })), selected: 0 })
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

  /** One network search: indexed route first, legacy fs.search as fallback. */
  const fetchEntries = async (
    scope: SessionScope,
    query: string,
    signal: AbortSignal,
  ): Promise<{ entries: SearchEntry[]; truncated: boolean; indexInfo: string | null }> => {
    if (fastRoute !== false) {
      try {
        const found = await apiCall<IndexedSearchResult>('/quick-open/api', 'search', scopePayload(scope, { query }), signal)
        fastRoute = true
        const indexInfo = found.indexedEntries !== undefined
          ? `索引 ${found.indexedEntries.toLocaleString()} 项 · ${Math.round((found.indexAge ?? 0) / 1000)}s 前`
          : null
        return { entries: found.matches, truncated: found.truncated, indexInfo }
      } catch (error) {
        if (signal.aborted) throw error
        fastRoute = false // the host half is unavailable: legacy path for this activation
      }
    }
    const legacy = await apiCall<LegacySearchResult>('/sidebar/api', 'fs.search', scopePayload(scope, { query }), signal)
    return {
      entries: legacy.matches.map(path => ({ path })),
      truncated: legacy.truncated,
      indexInfo: null,
    }
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

    // 1. Incremental filter: extending a complete result is exact under
    //    substring semantics — answer locally, skip the network entirely.
    if (
      lastServed !== null
      && lastServed.complete
      && lastServed.scopeKey === scopeKey
      && lastServed.needle !== ''
      && needle.startsWith(lastServed.needle)
      && needle !== lastServed.needle
    ) {
      const filtered = lastServed.entries.filter(entry => nameLowerOf(entry.path).includes(needle))
      const ranked = rankMatches(filtered, query)
      lastServed = { scopeKey, needle, entries: ranked, complete: true }
      cachePut(`${scopeKey}\n${needle}`, { entries: ranked, complete: true })
      cancelSearch()
      searchSeq += 1
      store.set({
        searching: false,
        matches: ranked,
        truncated: false,
        selected: 0,
        error: null,
        listKind: 'search',
      })
      return
    }

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
        const ranked = rankMatches(found.entries, query)
        const complete = !found.truncated
        lastServed = { scopeKey, needle, entries: ranked, complete }
        cachePut(`${scopeKey}\n${needle}`, { entries: ranked, complete })
        store.set({
          searching: false,
          matches: ranked,
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
    return probeIsDir(scope, entry.path)
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
    const service = sidebar()
    if (service === undefined) {
      notice('需要 dsh-better-sidebar 才能打开文件（搜索与引用不受影响）')
      reclaimFocus()
      return
    }
    service.openFile(scope, resolveWorkspacePath(scope.cwd, entry.path))
    pushRecent(entry.path)
    close()
  }

  /** Append plain mention text at the end of the conversation draft. */
  const appendMentionText = (sessionId: string, mention: string): boolean => {
    const actx = ctx.sessions.scope(sessionId)
    const conversation = ctx.get('conversation')
    if (actx === undefined || conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? mention : `${draft} ${mention}`)
    return true
  }

  /**
   * Ctrl+Enter: insert the selected match into the conversation draft and
   * KEEP the layer open so several references can stack. Files insert as a
   * structured chip (the native `@` picker's `slash/input-insert-reference`
   * event, plain-text fallback); directories append the `@dir/` folder
   * mention as plain text so folder completion keeps working.
   */
  const referenceSelected = async (): Promise<void> => {
    const entry = selectedMatch()
    if (entry === undefined) return
    const scope = currentScope()
    if (scope === undefined) return

    if (await resolveIsDir(scope, entry)) {
      const mention = `@${entry.path.replace(/[\\/]+$/, '')}/`
      if (appendMentionText(scope.sessionId, mention)) {
        pushRecent(entry.path)
        notice(`已加入对话 ${mention}`)
      } else {
        notice('对话服务不可用')
      }
      reclaimFocus()
      return
    }

    const reference = fileMention(entry.path)
    if (reference === undefined) {
      notice('路径包含无法引用的字符')
      reclaimFocus()
      return
    }
    const actx = ctx.sessions.scope(scope.sessionId)
    const conversation = ctx.get('conversation')
    if (actx === undefined || conversation === undefined) {
      notice('对话服务不可用')
      reclaimFocus()
      return
    }
    const input = conversation.input.for(actx)
    const before = input.state.getSnapshot()
    let inserted = false
    if (before.draftRev !== undefined) {
      try {
        // The session-scope Context's typed emit is keyed to DSH's closed
        // event map; this internal composer event is deliberately
        // string-loose at runtime (same escape hatch better-sidebar uses).
        actx.emit('slash/input-insert-reference', {
          reference: {
            source: 'reference',
            ref: reference.mention,
            label: reference.label,
            appearance: 'file',
            clipboardText: reference.mention,
          },
          span: {
            draftRev: before.draftRev,
            start: before.draft.length,
            end: before.draft.length,
          },
        })
        inserted = input.state.getSnapshot().draftRev !== before.draftRev
      } catch {
        inserted = false
      }
    }
    if (!inserted) {
      const draft = before.draft
      input.setDraft(draft.trim() === '' ? reference.mention : `${draft} ${reference.mention}`)
    }
    pushRecent(entry.path)
    notice(`已加入对话 ${reference.mention}`)
    // The composer grabbed focus while minting the chip — take it back so
    // the next keystroke still goes to the search box.
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
    openSelected,
    referenceSelected,
  }
}

export type QuickOpenController = ReturnType<typeof createQuickOpenController>

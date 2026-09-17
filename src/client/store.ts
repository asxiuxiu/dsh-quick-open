/**
 * The quick-open layer's state store: one instance per plugin activation
 * (created in `apply`, never module-level — the official factory rule), read
 * by the React layer through useSyncExternalStore.
 */

/** One visible row: a workspace-relative path plus its kind when known
 *  (the indexed `/quick-open/api/search` route always knows; the legacy
 *  `fs.search` fallback and the recents list leave it undefined and actions
 *  probe on demand). */
export interface SearchEntry {
  path: string
  isDir?: boolean
}

export interface QuickOpenSnapshot {
  /** Whether the floating layer is visible. */
  open: boolean
  /** The session the layer was opened for (results are cwd-relative to it). */
  sessionId: string | undefined
  query: string
  /**
   * The visible rows: search matches when `listKind` is 'search', recent
   * files when it is 'recents' (empty query). Actions operate on this list
   * uniformly.
   */
  matches: SearchEntry[]
  listKind: 'search' | 'recents'
  truncated: boolean
  selected: number
  searching: boolean
  error: string | null
  /** Transient feedback line (e.g. "已加入对话 @x.ts", directory hint). */
  notice: string | null
  /** Index transparency line for the footer (e.g. "索引 12,345 项 · 3s 前"). */
  indexInfo: string | null
  /**
   * Focus discipline token: bumped by the controller whenever the layer must
   * reclaim keyboard focus (e.g. after the composer steals it on a chip
   * insert). The component refocuses its input on every bump.
   */
  focusSeq: number
}

const INITIAL: QuickOpenSnapshot = {
  open: false,
  sessionId: undefined,
  query: '',
  matches: [],
  listKind: 'search',
  truncated: false,
  selected: 0,
  searching: false,
  error: null,
  notice: null,
  indexInfo: null,
  focusSeq: 0,
}

export function createQuickOpenStore() {
  let state: QuickOpenSnapshot = INITIAL
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: (): QuickOpenSnapshot => state,
    set(patch: Partial<QuickOpenSnapshot>): void {
      state = { ...state, ...patch }
      emit()
    },
    reset(): void {
      state = INITIAL
      emit()
    },
  }
}

export type QuickOpenStore = ReturnType<typeof createQuickOpenStore>

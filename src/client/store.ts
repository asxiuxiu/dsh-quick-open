/**
 * The quick-open layer's state store: one instance per plugin activation
 * (created in `apply`, never module-level — the official factory rule), read
 * by the React layer through useSyncExternalStore.
 */

/** A half-open [start, end) range within a path, for highlighting. */
export interface MatchSpan {
  start: number
  end: number
}

/** One visible row: a workspace-relative path plus its kind when known
 *  (the indexed `/quick-open/api/search` route always knows; the recents
 *  list leaves it undefined and actions probe on demand). */
export interface SearchEntry {
  path: string
  isDir?: boolean
  /**
   * The path is absolute because the entry came from an extra root (a
   * directory outside the workspace, such as the sibling game repository).
   * Such a path must never be joined against the session cwd.
   */
  absolute?: boolean
  /** Extra-root label, shown as the row's dimmed prefix. */
  rootLabel?: string
  /**
   * Matched spans of the basename, as offsets into the basename (not the
   * path). Empty for the recents list, which does not score and therefore
   * cannot report spans.
   */
  nameSpans?: MatchSpan[]
  /**
   * Matched spans in FULL-PATH coordinates that fall outside the basename —
   * i.e. hits inside directory names. Only present for path queries.
   */
  dirSpans?: MatchSpan[]
}

export interface QuickOpenSnapshot {
  /** Whether the floating layer is visible. */
  open: boolean
  /** The session the layer was opened for (results are cwd-relative to it). */
  sessionId: string | undefined
  query: string
  /**
   * The visible rows: search matches when `listKind` is 'search', recent
   * files when it is 'recents' (empty query), or one directory's direct
   * children when it is 'drill' (Tab landed on a directory). Actions operate
   * on this list uniformly.
   */
  matches: SearchEntry[]
  listKind: 'search' | 'recents' | 'drill'
  /**
   * The directory being browsed while `listKind` is 'drill', as a
   * workspace-relative path with no trailing slash ('' is the workspace
   * root). `undefined` in every other list kind.
   */
  drillPrefix: string | undefined
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
  drillPrefix: undefined,
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

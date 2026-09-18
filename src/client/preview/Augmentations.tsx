/**
 * The two augmentations over DSH's built-in document preview: a floating
 * find bar (Ctrl/Cmd+F) and the selection popup that adds a reference to the
 * conversation draft.
 *
 * The plugin no longer owns a renderer — the stock preview shows every file,
 * and this layer decorates whatever it rendered. Both features therefore work
 * from DOM facts alone:
 *
 * - the find bar searches the preview's TEXT NODES and paints hits with the
 *   CSS Custom Highlight API, which never mutates the React-owned tree, so it
 *   works identically over plain text, highlighted code and rendered
 *   Markdown;
 * - the selection popup watches the DOCUMENT selection: any non-empty
 *   selection inside a preview's markup can be referenced, in every renderer,
 *   with a line span where the renderer marks lines.
 *
 * The layer is a singleton mounted into its own React root by `index.ts` —
 * NOT into a slot — because it must exist exactly once per app, independent
 * of how many conversation inputs (and therefore overlay slots) are mounted.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { addressOfRoot, isVisible, lineOfNode, previewRootOf, visiblePreviews, type PreviewTarget } from './probe.ts'
import { clearMatches, collectTextPieces, matchSpans, paintMatches, revealMatch, MATCH_LIMIT, type TextPiece, type MatchSpan } from './find.ts'
import { appendToDraft, buildSelectionText, readSelectionFormat, SELECTION_FORMAT_KEY, type SelectionFormat } from './selection.ts'
import { isImeComposition } from '../ime-guard.ts'
import { matchesShortcut, readShortcut } from '../shortcut.ts'
import { t } from './locales.ts'
import { previewCss } from './styles.ts'

/** The context surface the augmentations use (draft write + session cwd). */
export interface PreviewContext {
  get(name: string): unknown
  sessions?: {
    scope?(id: string): unknown
    list?: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } }
  }
}

/** The session's workspace root, for the workspace-relative reference spelling. */
function readCwd(ctx: PreviewContext | undefined, sessionId: string): string | undefined {
  const sessions = ctx?.get('sessions') as { list?: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } } } | undefined
  return sessions?.list?.getSnapshot().byId[sessionId]?.cwd
}

/** The workspace-relative spelling, when the session cwd is known and matches. */
function relativeTo(cwd: string | undefined, path: string): string {
  if (cwd === undefined || cwd === '') return path
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/u, '')
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
}

/** Whether a node sits inside this layer's own find bar. */
function isInFindBar(node: Node | null | undefined): boolean {
  if (node === null || node === undefined) return false
  const element = node.nodeType === 1 ? node as Element : node.parentElement
  return element?.closest('[data-preview-find]') != null
}

/** Keep a floating control reachable when its anchor sits against an edge. */
const EDGE_MARGIN = 60

/** Height of the selection button plus its gap above the line, in px. */
const BUTTON_RISE = 30

/** Where and what the pending selection insert is. */
interface PendingSelection {
  /** The draft text this button would insert. */
  text: string
  left: number
  top: number
}

/** localStorage key for the find bar's case-sensitivity toggle. */
const CASE_SENSITIVE_KEY = 'dsh-quick-open:find-case-sensitive'

/** The persisted toggle; absent or unreadable means case-insensitive. */
function readCaseSensitive(): boolean {
  try {
    return window.localStorage.getItem(CASE_SENSITIVE_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the toggle; a storage failure must not break the bar. */
function writeCaseSensitive(value: boolean): void {
  try {
    window.localStorage.setItem(CASE_SENSITIVE_KEY, value ? '1' : '0')
  } catch {
    // A full or blocked localStorage is not worth surfacing for a preference.
  }
}

export function PreviewAugmentations(props: {
  ctx?: PreviewContext
  /** The quick-open layer owns Esc while it is open (it is the modal on top). */
  isQuickOpenOpen?: () => boolean
}): ReturnType<typeof createElement> {
  const { ctx, isQuickOpenOpen } = props

  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchTotal, setMatchTotal] = useState(0)
  const [current, setCurrent] = useState(0)
  const [barPos, setBarPos] = useState<{ left: number, top: number } | null>(null)
  /** The target preview still has pages to load, so the search covers a prefix only. */
  const [partial, setPartial] = useState(false)
  const [caseSensitive, setCaseSensitiveState] = useState(() => readCaseSensitive())
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [notice, setNotice] = useState<{ text: string, left: number, top: number } | null>(null)

  /** The preview the open find bar searches; null while closed. */
  const targetRef = useRef<PreviewTarget | null>(null)
  /** The pieces/spans of the last pass, kept so navigation can repaint. */
  const searchRef = useRef<{ pieces: TextPiece[], spans: MatchSpan[] }>({ pieces: [], spans: [] })
  const rangesRef = useRef<Range[]>([])
  /** Live mirrors, so window-level listeners never read stale state. */
  const findOpenRef = useRef(false)
  const queryRef = useRef('')
  const currentRef = useRef(0)
  const pendingRef = useRef<PendingSelection | null>(null)
  const popupRangeRef = useRef<Range | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const popupButtonRef = useRef<HTMLButtonElement | null>(null)
  const caseSensitiveRef = useRef(caseSensitive)
  /** The preview the reader last touched; the Ctrl+F target tie-breaker. */
  const touchedRootRef = useRef<HTMLElement | null>(null)
  const noticeTimerRef = useRef<number | undefined>(undefined)

  findOpenRef.current = findOpen
  queryRef.current = query
  currentRef.current = current
  pendingRef.current = pending
  caseSensitiveRef.current = caseSensitive

  /** Persisted toggle: flip it, persist it, and re-run the search. */
  const setCaseSensitive = useCallback((next: boolean) => {
    writeCaseSensitive(next)
    caseSensitiveRef.current = next
    setCaseSensitiveState(next)
  }, [])

  // The reference format is an app-wide preference (set in the settings
  // panel), read per gesture rather than passed down: this layer is mounted
  // outside the slot tree and has no prop channel to the settings UI.
  const [selectionFormat, setSelectionFormat] = useState<SelectionFormat>(() => readSelectionFormat())
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === SELECTION_FORMAT_KEY) setSelectionFormat(readSelectionFormat())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const formatRef = useRef(selectionFormat)
  formatRef.current = selectionFormat

  const hidePopup = useCallback(() => {
    popupRangeRef.current = null
    if (pendingRef.current === null) return
    pendingRef.current = null
    setPending(null)
  }, [])

  const closeFind = useCallback(() => {
    targetRef.current = null
    searchRef.current = { pieces: [], spans: [] }
    rangesRef.current = []
    clearMatches()
    findOpenRef.current = false
    setFindOpen(false)
    setMatchTotal(0)
    setCurrent(0)
    currentRef.current = 0
    setBarPos(null)
    setPartial(false)
  }, [])

  /**
   * Run one find pass over the target's current DOM and paint it. Reads the
   * query and current index from refs so every caller (input change, mutation
   * observer, navigation) drives the same path.
   */
  const runSearch = useCallback(() => {
    const target = targetRef.current
    if (target === null || !document.contains(target.root)) return
    const pieces = collectTextPieces(target.root)
    const spans = matchSpans(pieces, queryRef.current, caseSensitiveRef.current)
    searchRef.current = { pieces, spans }
    const clamped = spans.length === 0 ? 0 : Math.min(currentRef.current, spans.length - 1)
    currentRef.current = clamped
    setCurrent(clamped)
    setMatchTotal(spans.length)
    // The preview loads pages lazily; while its "load more" affordance exists
    // the search has covered a prefix only, and the bar must say so rather
    // than let "no results" read as "not in the file".
    setPartial(target.root.querySelector('[data-textpreview-more]') !== null)
    rangesRef.current = paintMatches(pieces, spans, clamped)
  }, [])

  /** Move the current hit by `delta`, wrapping, and reveal it. */
  const stepMatch = useCallback((delta: number) => {
    const { pieces, spans } = searchRef.current
    if (spans.length === 0) return
    const next = (currentRef.current + delta + spans.length) % spans.length
    currentRef.current = next
    setCurrent(next)
    rangesRef.current = paintMatches(pieces, spans, next)
    const range = rangesRef.current[next]
    if (range !== undefined) revealMatch(range)
  }, [])

  /** The preview a find gesture applies to: focused, else last touched, else first visible. */
  const pickTarget = useCallback((): PreviewTarget | null => {
    const visible = visiblePreviews()
    if (visible.length === 0) return null
    const focused = visible.find(target => target.root.contains(document.activeElement))
    if (focused !== undefined) return focused
    const touched = touchedRootRef.current
    if (touched !== null) {
      const hit = visible.find(target => target.root === touched)
      if (hit !== undefined) return hit
    }
    return visible[0] ?? null
  }, [])

  // Ctrl/Cmd+F at window capture: "search THIS file" must win over a generic
  // find while the reader is looking at a file, and the built-in preview's
  // scroll surface never claims the gesture itself. With NO visible preview
  // the key is left alone — the browser or app default is then correct.
  //
  // Esc is the mirror gesture: an open bar closes from wherever the caret is,
  // provided the reader is engaged with THIS bar or its preview (the input,
  // or the preview they last touched). The quick-open layer owns Esc while
  // open, and a stranger's surface (the composer, a dialog) keeps its own.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!findOpenRef.current) return
        if (isImeComposition(event)) return
        if (isQuickOpenOpen?.() === true) return
        const target = targetRef.current
        const inBar = isInFindBar(document.activeElement)
        const engaged = touchedRootRef.current !== null && target !== null && touchedRootRef.current === target.root
        if (!inBar && !engaged) return
        event.preventDefault()
        event.stopPropagation()
        closeFind()
        return
      }
      // Read per keypress so a rebind takes effect without a reload, matching
      // the palette's own listener.
      if (!matchesShortcut(readShortcut('find'), event)) return
      const target = findOpenRef.current ? targetRef.current : pickTarget()
      if (target === null || !isVisible(target.root)) return
      event.preventDefault()
      event.stopPropagation()
      if (findOpenRef.current) {
        inputRef.current?.focus()
        inputRef.current?.select()
        return
      }
      targetRef.current = target
      findOpenRef.current = true
      // Seed the query from the target's own selection, the way VSCode's find
      // does: a single-line selection in the preview becomes the query. A
      // preserved query stays when nothing is selected.
      const selection = document.getSelection()
      if (selection !== null && !selection.isCollapsed && selection.anchorNode !== null
        && previewRootOf(selection.anchorNode) === target.root) {
        const selected = selection.toString()
        if (selected.trim() !== '' && !selected.includes('\n') && selected.length <= 200) {
          queryRef.current = selected
          setQuery(selected)
        }
      }
      setFindOpen(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pickTarget, closeFind, isQuickOpenOpen])

  // The bar takes the caret when its input MOUNTS. An effect keyed on
  // findOpen cannot do this: the bar renders only once the tracking loop has
  // measured the anchor (barPos), a frame after the flag flips, so the effect
  // ran while no input existed and the caret never moved. A stable callback
  // ref fires exactly at mount — every open is a fresh mount because closing
  // unmounts the bar. Reopening selects what was typed before, so repeating
  // the gesture refines rather than restarts.
  const bindInput = useCallback((element: HTMLInputElement | null): void => {
    inputRef.current = element
    if (element !== null) {
      element.focus()
      element.select()
    }
  }, [])

  // Search whenever the bar opens, the query changes, or the case toggle flips.
  useEffect(() => {
    if (!findOpen) return
    runSearch()
  }, [findOpen, query, caseSensitive, runSearch])

  // The preview loads pages lazily; new text arriving under an open bar must
  // join the search. Debounced: a page load mutates many nodes at once.
  useEffect(() => {
    if (!findOpen) return undefined
    const target = targetRef.current
    if (target === null) return undefined
    let timer: number | undefined
    const observer = new MutationObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(runSearch, 200)
    })
    observer.observe(target.root, { childList: true, subtree: true, characterData: true })
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [findOpen, runSearch])

  // Anchor the bar to the target's top-right corner, and follow it: the
  // sidebar resizes without a window event, so while the bar is open a rAF
  // loop re-reads the rect. A target that closed or hid closes the bar.
  useEffect(() => {
    if (!findOpen) return undefined
    let frame = 0
    let last = ''
    const track = (): void => {
      frame = window.requestAnimationFrame(track)
      const target = targetRef.current
      if (target === null || !document.contains(target.root) || !isVisible(target.root)) {
        closeFind()
        return
      }
      const rect = target.root.getBoundingClientRect()
      const next = `${Math.round(rect.right)}:${Math.round(rect.top)}`
      if (next !== last) {
        last = next
        setBarPos({ left: Math.max(rect.right - 320, EDGE_MARGIN), top: rect.top + 8 })
      }
    }
    frame = window.requestAnimationFrame(track)
    return () => window.cancelAnimationFrame(frame)
  }, [findOpen, closeFind])

  // The selection popup: a non-empty, non-blank selection inside a visible
  // preview raises the button over it; anything else withdraws it. Watched on
  // the document because the plugin owns no renderer to hook into.
  useEffect(() => {
    let frame = 0
    const sync = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const selection = document.getSelection()
        if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
          hidePopup()
          return
        }
        const selected = selection.toString()
        if (selected.trim() === '') {
          hidePopup()
          return
        }
        const root = previewRootOf(selection.anchorNode)
        if (root === null || !root.contains(selection.focusNode) || !isVisible(root)) {
          hidePopup()
          return
        }
        const address = addressOfRoot(root)
        if (address === undefined) {
          hidePopup()
          return
        }
        // A backward selection has anchor after focus; the span is ordered.
        const anchorLine = selection.anchorNode === null ? undefined : lineOfNode(root, selection.anchorNode)
        const focusLine = selection.focusNode === null ? undefined : lineOfNode(root, selection.focusNode)
        const lines = anchorLine !== undefined && focusLine !== undefined
          ? { start: Math.min(anchorLine, focusLine), end: Math.max(anchorLine, focusLine) }
          : undefined
        const text = buildSelectionText({
          relativePath: relativeTo(readCwd(ctx, address.sessionId), address.path),
          lines,
          selected,
          format: formatRef.current,
        })
        if (text === undefined) {
          hidePopup()
          return
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) {
          hidePopup()
          return
        }
        popupRangeRef.current = selection.getRangeAt(0).cloneRange()
        const above = rect.top - BUTTON_RISE >= 0
        const next: PendingSelection = {
          text,
          left: Math.min(Math.max(rect.left, EDGE_MARGIN), window.innerWidth - EDGE_MARGIN),
          top: above ? rect.top - BUTTON_RISE : rect.bottom + 6,
        }
        pendingRef.current = next
        setPending(next)
      })
    }
    document.addEventListener('selectionchange', sync)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', sync)
    }
  }, [ctx, hidePopup])

  // Track the preview the reader last interacted with (the Ctrl+F
  // tie-breaker), and withdraw the popup on any press outside its button.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      touchedRootRef.current = previewRootOf(event.target as Node | null)
      const button = popupButtonRef.current
      if (pendingRef.current === null) return
      if (button !== null && (button === event.target || button.contains(event.target as Node))) return
      hidePopup()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [hidePopup])

  // The popup is anchored in viewport coordinates, so anything that moves the
  // text under it invalidates the placement. Recomputing from the stored live
  // Range keeps it welded to its selection; a detached range hides it.
  useEffect(() => {
    if (pending === null) return undefined
    let frame = 0
    const remeasure = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const range = popupRangeRef.current
        const current = pendingRef.current
        if (range === null || current === null) return
        const rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) {
          hidePopup()
          return
        }
        const above = rect.top - BUTTON_RISE >= 0
        const next: PendingSelection = {
          text: current.text,
          left: Math.min(Math.max(rect.left, EDGE_MARGIN), window.innerWidth - EDGE_MARGIN),
          top: above ? rect.top - BUTTON_RISE : rect.bottom + 6,
        }
        pendingRef.current = next
        setPending(next)
      })
    }
    document.addEventListener('scroll', remeasure, true)
    window.addEventListener('resize', remeasure)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      document.removeEventListener('scroll', remeasure, true)
      window.removeEventListener('resize', remeasure)
    }
  }, [pending, hidePopup])

  // Highlights never outlive the layer itself (plugin reload, unmount).
  useEffect(() => () => clearMatches(), [])

  /** Commit the pending selection into the conversation draft. */
  const commitSelection = useCallback(() => {
    const currentPending = pendingRef.current
    if (currentPending === null) return
    const root = popupRangeRef.current === null ? null : previewRootOf(popupRangeRef.current.startContainer)
    hidePopup()
    const address = root === null ? undefined : addressOfRoot(root)
    if (address === undefined) {
      flash(t('noConversation'))
      return
    }
    flash(appendToDraft(ctx, address.sessionId, currentPending.text) ? t('added') : t('noConversation'))
  }, [ctx, hidePopup])

  /** Brief confirmation, anchored under the viewport's center-bottom. */
  const flash = (message: string): void => {
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current)
    setNotice({ text: message, left: window.innerWidth / 2, top: window.innerHeight - 96 })
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 1600)
  }

  const onInputKeyDown = (event: {
    key: string, shiftKey: boolean,
    preventDefault(): void, stopPropagation(): void,
  }): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeFind()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      stepMatch(event.shiftKey ? -1 : 1)
    }
  }

  const countLabel = query === ''
    ? ''
    : matchTotal === 0
      ? t('noResults')
      : `${current + 1}/${matchTotal}${matchTotal >= MATCH_LIMIT ? '+' : ''}`

  return createElement(Fragment, null,
    findOpen && barPos !== null && createPortal(
      createElement('div', {
        className: previewCss.find,
        'data-preview-find': 'true',
        style: { left: barPos.left, top: barPos.top },
      },
        createElement('input', {
          ref: bindInput,
          value: query,
          placeholder: t('findPlaceholder'),
          'data-preview-find-input': 'true',
          onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
          onKeyDown: onInputKeyDown,
        }),
        createElement('span', {
          className: previewCss.findCount,
          'data-empty': matchTotal === 0 ? 'true' : 'false',
        }, countLabel),
        partial && query !== '' && createElement('span', {
          className: previewCss.findPartial,
          title: t('partialCoverageHint'),
          'data-preview-find-partial': 'true',
        }, t('partialCoverage')),
        createElement('button', {
          type: 'button',
          className: previewCss.findButton,
          'data-preview-find-case': 'true',
          'aria-pressed': caseSensitive,
          title: t('findCaseSensitive'),
          onClick: () => setCaseSensitive(!caseSensitiveRef.current),
        }, 'Aa'),
        createElement('button', {
          type: 'button',
          className: previewCss.findButton,
          title: t('findPrevious'),
          disabled: matchTotal === 0,
          onClick: () => stepMatch(-1),
        }, '↑'),
        createElement('button', {
          type: 'button',
          className: previewCss.findButton,
          title: t('findNext'),
          disabled: matchTotal === 0,
          onClick: () => stepMatch(1),
        }, '↓'),
        createElement('button', {
          type: 'button',
          className: previewCss.findButton,
          title: t('findClose'),
          onClick: closeFind,
        }, '×'),
      ),
      document.body,
    ),
    pending !== null && createPortal(
      createElement('button', {
        ref: popupButtonRef,
        type: 'button',
        className: previewCss.selection,
        'data-preview-selection-popup': 'true',
        style: { left: pending.left, top: pending.top },
        // Keep the selection alive until the click lands — this press would
        // otherwise clear the selection and the button would unmount before
        // the click arrives.
        onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
        onClick: commitSelection,
      }, t('addSelection')),
      document.body,
    ),
    notice !== null && createPortal(
      createElement('span', {
        className: previewCss.notice,
        'data-preview-notice': 'true',
        style: { left: notice.left, top: notice.top, transform: 'translateX(-50%)' },
      }, notice.text),
      document.body,
    ),
  )
}

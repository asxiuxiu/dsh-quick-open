/**
 * The quick-open floating layer, mounted through the official
 * `conversation.input.overlay` slot (the input bar's overlay anchor) and
 * PORTALED to `document.body`.
 *
 * The portal is load-bearing, not cosmetic: the slot sits inside the composer
 * card, and any ancestor that establishes a containing block or stacking
 * context (a transform, paint containment, a clipped scroller) would trap the
 * fixed backdrop inside the conversation column — capping its effective
 * z-index below the sidebar's own layers (panel 10/40, float host 60) and
 * clipping it to the column. Portaling to the body escapes every ancestor
 * context, so the backdrop competes only at the root, where nothing in the
 * app exceeds its z-index. The sidebar's own float layer uses the same
 * pattern for the same reason.
 *
 * Interaction model (VSCode quick-open discipline):
 * - KEYBOARD FOCUS NEVER LEAVES THE INPUT while the layer is open. Row
 *   mousedown is preventDefault'd so clicks don't blur; the controller bumps
 *   `focusSeq` after any action that lets the composer steal focus (chip
 *   insert), and this component refocuses on every bump.
 * - Opening selects the whole preserved query, so typing replaces it while
 *   arrow keys reuse it. An empty query shows the recent-files list, making
 *   Ctrl+P → Enter reopen the last file.
 * - The selected row exposes a visible "+ 引用" affordance (the Ctrl+Enter
 *   gesture made discoverable); hovering a row selects it.
 *
 * Styling is inline on purpose: DSH client bundles must be single-file
 * (CSS Modules would need a lightningcss build step), and a fixed-position
 * layer ignores the anchor's geometry anyway. The palette follows VSCode's
 * dark quick-open.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { QuickOpenController } from './controller.ts'
import type { MatchSpan } from './store.ts'
import { isImeComposition } from './ime-guard.ts'
import { describeShortcut, readShortcut } from './shortcut.ts'

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.35)',
    zIndex: 10000,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  panel: {
    marginTop: '12vh',
    width: 'min(640px, 90vw)',
    background: '#252526',
    border: '1px solid #454545',
    borderRadius: 8,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    fontSize: 14,
    color: '#cccccc',
    background: '#3c3c3c',
    border: 'none',
    outline: 'none',
  },
  section: {
    padding: '4px 12px 2px',
    fontSize: 11,
    color: '#7a7a7a',
    letterSpacing: '0.04em',
  },
  list: {
    maxHeight: 320,
    overflowY: 'auto',
  },
  row: {
    padding: '6px 12px',
    fontSize: 13,
    color: '#cccccc',
    cursor: 'default',
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    // Rows are click targets, not text: a drag across one should not look like
    // a selection. The text spans below opt back in.
    userSelect: 'none',
  },
  rowSelected: {
    background: '#094771',
  },
  rowName: {
    color: '#e8e8e8',
    flexShrink: 0,
    userSelect: 'text',
  },
  rowDirName: {
    color: '#4fc1ff',
    flexShrink: 0,
    userSelect: 'text',
  },
  rowHit: {
    color: '#4ec9b0',
  },
  /**
   * The directory as a right-aligned suffix, front-elided in JS rather than by
   * CSS. CSS `text-overflow: ellipsis` clips the TAIL, which is exactly the
   * part that distinguishes two rows of the same file name — so a deep shared
   * prefix (`E:/cb2_master/dev/.../client/public/chaos/client/`) would hide the
   * one segment the user actually needs to compare.
   */
  rowDirPinned: {
    color: '#8a8a8a',
    fontSize: 12,
    whiteSpace: 'nowrap',
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    userSelect: 'text',
  },
  /** The elided leading portion of a path, dimmed to read as "omitted". */
  pathDim: {
    color: '#6a6a6a',
  },
  rowRoot: {
    flexShrink: 0,
    padding: '0 6px',
    borderRadius: 3,
    background: '#3a3d41',
    color: '#bdbdbd',
    fontSize: 11,
  },
  rowAction: {
    flexShrink: 0,
    fontSize: 11,
    color: '#cccccc',
    background: 'rgba(255, 255, 255, 0.08)',
    border: '1px solid #555555',
    borderRadius: 4,
    padding: '1px 8px',
    cursor: 'pointer',
  },
  status: {
    padding: '10px 12px',
    fontSize: 12,
    color: '#8a8a8a',
  },
  notice: {
    padding: '8px 12px',
    fontSize: 12,
    color: '#cca700',
    borderTop: '1px solid #454545',
  },
  error: {
    padding: '8px 12px',
    fontSize: 12,
    color: '#f48771',
    borderTop: '1px solid #454545',
  },
  footer: {
    padding: '6px 12px',
    fontSize: 11,
    color: '#7a7a7a',
    borderTop: '1px solid #454545',
    display: 'flex',
    gap: 16,
    flexWrap: 'wrap',
  },
}

/** Split one workspace-relative path into basename + dimmed directory. */
function splitPath(rel: string): { dir: string; name: string } {
  const at = rel.lastIndexOf('/')
  return at === -1 ? { dir: '', name: rel } : { dir: rel.slice(0, at + 1), name: rel.slice(at + 1) }
}

/** How many directory segments to keep when pinning the tail of a deep path. */
const PINNED_SEGMENTS = 3

/**
 * Build a SHORT, match-aware view of a directory path for the row suffix.
 *
 * The problem this solves: results are distinguished by their directory, but a
 * deep path (`_source/_engine/source/client/public/chaos/client/module/`) runs
 * off the right edge of the row, so every row looks identical. Truncating the
 * FRONT with `…` (instead of the tail with CSS `text-overflow`) keeps the
 * segments nearest the file — which is what actually differs between rows.
 *
 * When the matcher hit directory segments (a path query such as
 * `source/client/client_module`), those segments are always kept, so the
 * highlighted part of the path can never be the part that gets truncated away.
 *
 * `elided` is true when a leading prefix was dropped, and the returned offsets
 * are in the coordinates of the returned string.
 */
function compactDir(
  dir: string,
  spans: readonly MatchSpan[] | undefined,
): { text: string; spans: MatchSpan[]; elided: boolean } {
  if (dir === '') return { text: '', spans: [], elided: false }

  // Segment boundaries of the directory INCLUDING its trailing '/'.
  const bounds: { start: number; end: number }[] = []
  let start = 0
  for (let i = 0; i < dir.length; i++) {
    if (dir[i] === '/') {
      bounds.push({ start, end: i + 1 })
      start = i + 1
    }
  }
  if (start < dir.length) bounds.push({ start, end: dir.length })

  const keep = new Set<number>()
  const tailFrom = Math.max(0, bounds.length - PINNED_SEGMENTS)
  for (let i = tailFrom; i < bounds.length; i++) keep.add(i)

  // Any segment containing a match is kept regardless of depth.
  if (spans !== undefined) {
    for (const span of spans) {
      for (let i = 0; i < bounds.length; i++) {
        if (span.start < bounds[i].end && span.end > bounds[i].start) keep.add(i)
      }
    }
  }

  const kept = [...keep].sort((a, b) => a - b)
  // Nothing to elide: hand back the original string and offsets untouched.
  if (kept.length === bounds.length) {
    return { text: dir, spans: spans === undefined ? [] : [...spans], elided: false }
  }

  const segments = kept.map(i => dir.slice(bounds[i].start, bounds[i].end))
  const text = `…${segments.join('')}`
  // Shift offsets by the dropped prefix plus the ellipsis character.
  const shift = bounds[kept[0]].start - 1
  const shifted: MatchSpan[] = []
  for (const span of spans ?? []) {
    const s = Math.max(0, span.start - shift)
    const e = Math.min(text.length, span.end - shift)
    if (e > s) shifted.push({ start: s, end: e })
  }
  return { text, spans: shifted, elided: true }
}

/**
 * Render `text` with the given spans emphasized. Spans are half-open offsets
 * into `text`, already sorted and merged by the matcher; anything malformed is
 * ignored rather than throwing, because a bad span must never blank a row.
 */
function highlight(text: string, spans: readonly MatchSpan[] | undefined): ReactNode {
  if (spans === undefined || spans.length === 0) return text
  const parts: ReactNode[] = []
  let cursor = 0
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, text.length))
    const end = Math.max(start, Math.min(span.end, text.length))
    if (start > cursor) parts.push(text.slice(cursor, start))
    if (end > start) parts.push(<span key={start} style={styles.rowHit}>{text.slice(start, end)}</span>)
    cursor = Math.max(cursor, end)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

/** The dimmed directory prefix, compacted and with path hits highlighted. */
function highlightDir(dir: string, spans: readonly MatchSpan[] | undefined): ReactNode {
  const compact = compactDir(dir, spans)
  if (compact.text === '') return null
  const body = highlight(compact.text, compact.spans)
  // The ellipsis marks where the path was elided, so it reads as intentional
  // rather than as a path that literally starts with '…'.
  if (!compact.elided) return body
  return <span style={styles.pathDim}>{body}</span>
}

const PAGE_STEP = 10

export function QuickOpenLayer({ controller }: { controller: QuickOpenController }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  // Read per render so the footer names whatever is bound right now. The layer
  // re-renders on every open, so a shortcut changed in the settings panel shows
  // up the next time the palette appears — no subscription needed for a label.
  const boundShortcut = readShortcut()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)

  // Focus discipline: the input owns the keyboard for the layer's whole
  // life. Opening also selects the preserved query (typing replaces it);
  // later focusSeq bumps only refocus (the composer steals focus when it
  // mints a reference chip).
  useEffect(() => {
    if (!state.open) {
      wasOpenRef.current = false
      return
    }
    const input = inputRef.current
    if (input === null) return
    input.focus()
    if (!wasOpenRef.current) input.select()
    wasOpenRef.current = true
  }, [state.open, state.focusSeq])

  // A fresh list restarts the scroll position at the top.
  useEffect(() => {
    const list = listRef.current
    if (list !== null) list.scrollTop = 0
  }, [state.matches])

  // Keep the selected row inside the scroll window.
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    const row = list.children[state.selected] as HTMLElement | undefined
    row?.scrollIntoView({ block: 'nearest' })
  }, [state.selected])

  if (!state.open) return null

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    // IME composition owns every key while active (issue #535 convention).
    if (isImeComposition(event.nativeEvent)) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        event.stopPropagation()
        controller.move(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        event.stopPropagation()
        controller.move(-1)
        return
      case 'PageDown':
        event.preventDefault()
        event.stopPropagation()
        controller.move(PAGE_STEP)
        return
      case 'PageUp':
        event.preventDefault()
        event.stopPropagation()
        controller.move(-PAGE_STEP)
        return
      case 'Home':
        event.preventDefault()
        event.stopPropagation()
        controller.jump('first')
        return
      case 'End':
        event.preventDefault()
        event.stopPropagation()
        controller.jump('last')
        return
      case 'Enter':
        event.preventDefault()
        event.stopPropagation()
        if (event.ctrlKey || event.metaKey) void controller.referenceSelected()
        else void controller.openSelected()
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        controller.close()
        return
      default:
    }
  }

  /**
   * Stop a mousedown from moving keyboard focus OUT of the search input.
   *
   * Only the RESULT ROWS use this. It must not be applied to the whole panel:
   * `preventDefault` on mousedown also suppresses native drag-selection, so
   * blanketing the panel made it impossible to select text in the input with
   * the mouse.
   */
  /**
   * A row mousedown must not move keyboard focus out of the search input —
   * otherwise the next keystroke goes nowhere. It must NOT blanket-block the
   * default either, or dragging across a row's path could never select it.
   *
   * `user-select: none` on the row does the blocking for the row body, and
   * this handler keeps focus. The row's TEXT spans opt back into selection
   * (see `pathSelectable`), so a drag over the path still selects it and
   * mousedown defaults are only prevented for the non-text parts.
   */
  const keepFocus = (event: ReactMouseEvent): void => {
    event.preventDefault()
  }

  /**
   * Backdrop mousedown: close only when the click really landed on the
   * backdrop itself. `preventDefault` is deliberately NOT called here, so
   * selecting text inside the panel still works.
   */
  const onBackdropMouseDown = (event: ReactMouseEvent): void => {
    if (event.target === event.currentTarget) controller.close()
  }

  const onRowClick = (index: number, event: ReactMouseEvent): void => {
    controller.select(index)
    if (event.ctrlKey || event.metaKey) void controller.referenceSelected()
    else void controller.openSelected()
  }

  const onRowReference = (index: number, event: ReactMouseEvent): void => {
    event.stopPropagation()
    controller.select(index)
    void controller.referenceSelected()
  }

  const body = (): ReactNode => {
    if (state.listKind === 'recents') {
      if (state.matches.length === 0) {
        return <div style={styles.status}>输入以搜索当前工作区的文件</div>
      }
    } else if (state.listKind === 'drill' && !state.searching && state.matches.length === 0) {
      return <div style={styles.status}>该目录为空</div>
    } else if (state.searching && state.matches.length === 0) {
      return <div style={styles.status}>搜索中…</div>
    } else if (!state.searching && state.matches.length === 0 && state.error === null) {
      return <div style={styles.status}>无匹配文件</div>
    }
    return (
      <>
        {state.listKind === 'recents' && <div style={styles.section}>最近使用</div>}
        {state.listKind === 'drill' && (
          <div style={styles.section}>{state.drillPrefix === '' ? '工作区根目录' : `${state.drillPrefix}/`}</div>
        )}
        <div ref={listRef} style={styles.list} role="listbox">
          {state.matches.map((entry, index) => {
            const { dir, name } = splitPath(entry.path)
            const selected = index === state.selected
            return (
              <div
                key={entry.path}
                role="option"
                aria-selected={selected}
                style={selected ? { ...styles.row, ...styles.rowSelected } : styles.row}
                onMouseDown={keepFocus}
                onMouseEnter={() => controller.select(index)}
                onClick={(event) => onRowClick(index, event)}
              >
                {entry.rootLabel !== undefined && (
                  <span style={styles.rowRoot}>{entry.rootLabel}</span>
                )}
                <span style={entry.isDir === true ? styles.rowDirName : styles.rowName}>
                  {highlight(name, entry.nameSpans)}
                  {entry.isDir === true && '/'}
                </span>
                {/*
                  The directory as a right-aligned, front-elided suffix. CSS
                  `text-overflow` would clip the TAIL, which is exactly the part
                  that tells two rows apart; eliding the shared prefix instead
                  keeps the distinguishing segment visible.
                */}
                <span style={styles.rowDirPinned} title={dir}>
                  {highlightDir(dir, entry.dirSpans)}
                </span>
                {selected && (
                  <button
                    type="button"
                    style={styles.rowAction}
                    title="加入对话（Ctrl+Enter）"
                    onMouseDown={keepFocus}
                    onClick={(event) => onRowReference(index, event)}
                  >
                    + 引用
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </>
    )
  }

  return createPortal(
    <div style={styles.backdrop} onMouseDown={onBackdropMouseDown}>
      <div
        style={styles.panel}
        role="dialog"
        aria-label="快速打开文件"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          style={styles.input}
          value={state.query}
          placeholder="模糊搜索文件名；空格分词，dir: 前缀限定目录（如 dir:ui index.html）"
          spellCheck={false}
          onChange={(event) => controller.setQuery(event.target.value)}
        />
        {body()}
        {state.error !== null && <div style={styles.error}>搜索失败：{state.error}</div>}
        {state.notice !== null && <div style={styles.notice}>{state.notice}</div>}
        <div style={styles.footer}>
          <span>↑↓ 导航</span>
          <span>Tab 补全路径</span>
          <span>Enter 打开</span>
          <span>:行号 跳行</span>
          <span>Ctrl+Enter 加入对话（不关闭）</span>
          <span>dir: 限定目录</span>
          <span>file: 限定文件名</span>
          <span>Esc 关闭</span>
          {/* The bound combination, not a hardcoded one: the shortcut is
              customizable, so a fixed label would be wrong the moment the user
              changes it. */}
          <span>{describeShortcut(boundShortcut)} 开关</span>
          {state.truncated && <span>结果已截断，请细化关键词</span>}
          {state.indexInfo !== null && <span style={{ marginLeft: 'auto' }}>{state.indexInfo}</span>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

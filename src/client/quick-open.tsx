/**
 * The quick-open floating layer, rendered into the official
 * `conversation.input.overlay` slot (the input bar's overlay anchor).
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
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { QuickOpenController } from './controller.ts'
import { isImeComposition } from './ime-guard.ts'

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
  },
  rowSelected: {
    background: '#094771',
  },
  rowName: {
    color: '#e8e8e8',
    flexShrink: 0,
  },
  rowDirName: {
    color: '#4fc1ff',
    flexShrink: 0,
  },
  rowHit: {
    color: '#4ec9b0',
  },
  rowDir: {
    color: '#8a8a8a',
    fontSize: 12,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: 1,
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

/** Basename with the query substring highlighted (case-insensitive). */
function highlightName(name: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase()
  if (needle === '') return name
  const at = name.toLowerCase().indexOf(needle)
  if (at === -1) return name
  return (
    <>
      {name.slice(0, at)}
      <span style={styles.rowHit}>{name.slice(at, at + needle.length)}</span>
      {name.slice(at + needle.length)}
    </>
  )
}

const PAGE_STEP = 10

export function QuickOpenLayer({ controller }: { controller: QuickOpenController }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
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

  // mousedown would move keyboard focus out of the search input — prevent it
  // everywhere inside the panel so the keyboard flow never breaks.
  const keepFocus = (event: ReactMouseEvent): void => {
    event.preventDefault()
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
    } else if (state.searching && state.matches.length === 0) {
      return <div style={styles.status}>搜索中…</div>
    } else if (!state.searching && state.matches.length === 0 && state.error === null) {
      return <div style={styles.status}>无匹配文件</div>
    }
    return (
      <>
        {state.listKind === 'recents' && <div style={styles.section}>最近使用</div>}
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
                <span style={entry.isDir === true ? styles.rowDirName : styles.rowName}>
                  {highlightName(name, state.query)}
                  {entry.isDir === true && '/'}
                </span>
                <span style={styles.rowDir}>{dir}</span>
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

  return (
    <div style={styles.backdrop} onMouseDown={keepFocus} onClick={() => controller.close()}>
      <div
        style={styles.panel}
        role="dialog"
        aria-label="快速打开文件"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          style={styles.input}
          value={state.query}
          placeholder="按文件名搜索（Enter 打开，Ctrl+Enter 加入对话）"
          spellCheck={false}
          onChange={(event) => controller.setQuery(event.target.value)}
        />
        {body()}
        {state.error !== null && <div style={styles.error}>搜索失败：{state.error}</div>}
        {state.notice !== null && <div style={styles.notice}>{state.notice}</div>}
        <div style={styles.footer}>
          <span>↑↓ 导航</span>
          <span>Enter 打开</span>
          <span>Ctrl+Enter 加入对话（不关闭）</span>
          <span>Esc 关闭</span>
          {state.truncated && <span>结果已截断，请细化关键词</span>}
          {state.indexInfo !== null && <span style={{ marginLeft: 'auto' }}>{state.indexInfo}</span>}
        </div>
      </div>
    </div>
  )
}

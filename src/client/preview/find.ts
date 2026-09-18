/**
 * In-file find, built for a renderer the plugin does not own.
 *
 * The built-in preview renders a file as plain DOM (plain-text pages, a
 * highlighted code block, Markdown, HTML), so the search runs over the DOM's
 * TEXT NODES rather than over any editor model: a TreeWalker collects the
 * visible text, a pure matcher finds the query's spans across node
 * boundaries, and the hits are painted with the CSS Custom Highlight API —
 * `CSS.highlights` decorates Ranges WITHOUT touching the DOM, which is the
 * only safe way to mark up a tree React owns.
 *
 * The module is split so the risky part is testable offline: `matchSpans`
 * (pure: text pieces in, spans out) carries all the boundary logic; the DOM
 * glue around it is thin and obviously correct.
 */

/** One text node's contribution to the searchable text. */
export interface TextPiece {
  node: Text
  /** This piece's start offset in the concatenated searchable text. */
  start: number
  text: string
}

/** One match, as offsets into the concatenated searchable text. */
export interface MatchSpan {
  from: number
  to: number
}

/** Matches beyond this count are not painted; the bar reports a capped count. */
export const MATCH_LIMIT = 1000

/** The highlight registry names; the stylesheet paints `::highlight(<name>)`. */
export const HIGHLIGHT_MATCH = 'qo-preview-find-match'
export const HIGHLIGHT_CURRENT = 'qo-preview-find-current'

/** Escape a literal query for use in a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Find every case-insensitive occurrence of `query` across `pieces`.
 *
 * Matching runs over the concatenation of all pieces so a phrase split
 * across two text nodes (a `<b>` boundary in rendered Markdown, a highlight
 * span in the code renderer) still matches; because each piece's `start` is
 * its offset in that same concatenation, the joined offsets map straight
 * back onto the pieces. A case-insensitive REGEXP (not a lowercased copy)
 * does the matching, so a character whose case folding changes its length
 * (ß, İ) cannot shift the offsets the ranges are built from. Spans are
 * returned in document order and capped at MATCH_LIMIT.
 */
export function matchSpans(pieces: readonly { start: number, text: string }[], query: string): MatchSpan[] {
  if (query === '') return []
  const joined = pieces.map(piece => piece.text).join('')
  const pattern = new RegExp(escapeRegExp(query), 'giu')
  const spans: MatchSpan[] = []
  for (;;) {
    const hit = pattern.exec(joined)
    if (hit === null) break
    spans.push({ from: hit.index, to: hit.index + hit[0].length })
    if (spans.length >= MATCH_LIMIT) break
  }
  return spans
}

/**
 * The text pieces of one preview body, in document order.
 *
 * The walk is rooted at the preview BODY when one is marked (the header's
 * path text and the change bar would otherwise produce phantom hits the
 * reader cannot be looking for), and falls back to the whole root when no
 * body is marked. Nodes under `script`/`style` are skipped.
 */
export function collectTextPieces(root: HTMLElement): TextPiece[] {
  const scope = root.querySelector('[data-textpreview-plain], [data-code-preview]') ?? root
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      if ((node.textContent ?? '') === '') return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const pieces: TextPiece[] = []
  let start = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    pieces.push({ node: node as Text, start, text })
    start += text.length
  }
  return pieces
}

/** Materialize one span as a live Range, or undefined when it strays. */
function rangeForSpan(pieces: readonly TextPiece[], span: MatchSpan): Range | undefined {
  const first = pieces.find(piece => span.from < piece.start + piece.text.length)
  const last = pieces.find(piece => span.to <= piece.start + piece.text.length)
  if (first === undefined || last === undefined) return undefined
  const range = document.createRange()
  range.setStart(first.node, span.from - first.start)
  range.setEnd(last.node, span.to - last.start)
  return range
}

/** The minimal Custom Highlight API surface this module uses. */
interface HighlightRegistry {
  set(name: string, highlight: unknown): void
  delete(name: string): boolean
}

function highlightRegistry(): HighlightRegistry | undefined {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  return css?.highlights
}

/** The Highlight constructor, where the Custom Highlight API exists. */
function highlightCtor(): (new(...ranges: Range[]) => unknown) | undefined {
  return (globalThis as { Highlight?: new(...ranges: Range[]) => unknown }).Highlight
}

/**
 * Paint match and current-hit highlights over the found spans.
 *
 * Returns the painted ranges (used for scroll navigation). Without the
 * Custom Highlight API the function still returns the ranges — navigation
 * and the match count keep working, only the persistent paint is absent.
 */
export function paintMatches(pieces: readonly TextPiece[], spans: readonly MatchSpan[], current: number): Range[] {
  const ranges: Range[] = []
  for (const span of spans) {
    const range = rangeForSpan(pieces, span)
    if (range !== undefined) ranges.push(range)
  }
  const registry = highlightRegistry()
  const Ctor = highlightCtor()
  if (registry !== undefined && Ctor !== undefined) {
    const rest = ranges.filter((_, index) => index !== current)
    const active = ranges[current]
    if (rest.length > 0) registry.set(HIGHLIGHT_MATCH, new Ctor(...rest))
    else registry.delete(HIGHLIGHT_MATCH)
    if (active !== undefined) registry.set(HIGHLIGHT_CURRENT, new Ctor(active))
    else registry.delete(HIGHLIGHT_CURRENT)
  }
  return ranges
}

/** Remove both highlight groups (bar closed, or the preview went away). */
export function clearMatches(): void {
  const registry = highlightRegistry()
  if (registry === undefined) return
  registry.delete(HIGHLIGHT_MATCH)
  registry.delete(HIGHLIGHT_CURRENT)
}

/** Bring one hit into view, centered where the scroller allows it. */
export function revealMatch(range: Range): void {
  const element = range.startContainer.nodeType === 1
    ? range.startContainer as Element
    : range.startContainer.parentElement
  element?.scrollIntoView({ block: 'center', behavior: 'auto' })
}

/**
 * Discovery against the built-in document preview's DOM.
 *
 * The augmentations own no renderer — the stock preview does — so everything
 * they know about a file comes from the preview's own markup. The contract
 * used here is the preview's `data-*` attribute surface, read from
 * @deepseek-ai/dsh-client-ui-sidebar-documentpreview:
 *
 * - the root carries `data-textpreview-url` (the tab's file address) and
 *   `data-document-preview` (the selected renderer id);
 * - the plain-text body marks every line with `data-textpreview-line="<n>"`;
 * - the code body renders one `.line` element per source line inside `pre`.
 *
 * These attributes are the preview's own instrumentation, not a public API,
 * so every read here DEGRADES rather than assumes: an unrecognized root is
 * skipped, a missing line marker means "no line span" (the reference falls
 * back to a bare `@path`), never an exception.
 */
import { parseFileAddress, type FileAddress } from './address.ts'

/** The selector matching one mounted built-in preview root. */
const PREVIEW_ROOT_SELECTOR = '[data-textpreview-url]'

/** One discovered preview: its root element and the address it shows. */
export interface PreviewTarget {
  root: HTMLElement
  address: FileAddress
}

/** The preview root an event target or DOM node belongs to, if any. */
export function previewRootOf(node: Node | null): HTMLElement | null {
  if (node === null) return null
  const element = node.nodeType === 1 ? node as HTMLElement : node.parentElement
  return element?.closest(PREVIEW_ROOT_SELECTOR) ?? null
}

/**
 * Whether an element is on screen, as opposed to merely mounted.
 *
 * Every tab in the pane stays mounted for the panel's lifetime; the inactive
 * ones are hidden by a `visibility: hidden` ancestor (or sit in a collapsed,
 * translated-away panel). `offsetParent` alone would not catch `visibility`,
 * and geometry alone would not catch the collapsed panel, so both are checked.
 */
export function isVisible(element: HTMLElement): boolean {
  let node: HTMLElement | null = element
  while (node !== null) {
    const style = window.getComputedStyle(node)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    node = node.parentElement
  }
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Every on-screen built-in preview, with its address parsed.
 *
 * Split panes and floating panes can show two previews at once; callers pick
 * among them (most recently touched wins), so this returns them all rather
 * than deciding here.
 */
export function visiblePreviews(): PreviewTarget[] {
  const out: PreviewTarget[] = []
  for (const element of document.querySelectorAll(PREVIEW_ROOT_SELECTOR)) {
    if (!(element instanceof HTMLElement)) continue
    const raw = element.dataset.textpreviewUrl
    if (raw === undefined) continue
    const address = parseFileAddress(raw)
    if (address === undefined) continue
    if (!isVisible(element)) continue
    out.push({ root: element, address })
  }
  return out
}

/** The address one preview root is showing, or undefined when unreadable. */
export function addressOfRoot(root: HTMLElement): FileAddress | undefined {
  const raw = root.dataset.textpreviewUrl
  return raw === undefined ? undefined : parseFileAddress(raw)
}

/**
 * The 1-based source line a DOM node sits on, when the renderer marks lines.
 *
 * Two renderers mark lines, with two different schemes:
 * - plain text: the line element itself carries `data-textpreview-line`;
 * - code: the line is a `.line` child of the `pre`, and its number is its
 *   ordinal among the pre's lines.
 *
 * Rendered Markdown, HTML, PDF and images expose neither — undefined there,
 * which callers treat as "no line span", not as a failure.
 */
export function lineOfNode(root: HTMLElement, node: Node): number | undefined {
  const element = node.nodeType === 1 ? node as Element : node.parentElement
  if (element === null) return undefined
  const plain = element.closest('[data-textpreview-line]')
  if (plain !== null && root.contains(plain)) {
    const parsed = Number(plain.getAttribute('data-textpreview-line'))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  const codeLine = element.closest('pre .line')
  if (codeLine !== null && root.contains(codeLine)) {
    const pre = codeLine.closest('pre')
    if (pre === null || !root.contains(pre)) return undefined
    const lines = pre.querySelectorAll('.line')
    const index = Array.prototype.indexOf.call(lines, codeLine)
    return index >= 0 ? index + 1 : undefined
  }
  return undefined
}

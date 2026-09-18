/**
 * Payload for "add selection to conversation", plus the draft injection.
 *
 * The reference format is a SETTING, because the two useful shapes pull in
 * opposite directions and neither is right for every project:
 *
 * - `path`  — `@path/file.cpp:120-160`. Minimal: the model is told WHERE, and
 *   reads the file itself. Cheapest in context, and the model keeps whatever
 *   surrounding code it decides it needs.
 * - `path-hint` — the same, plus one sentence telling the model to read that
 *   line. Costs a few tokens and measurably reduces "I don't see the file"
 *   responses, because the instruction is explicit rather than inferred from
 *   a path suffix the model may not parse as a location.
 * - `content` — a fenced block carrying the selected text, the shape this
 *   used to have. Self-contained, but the snippet is duplicated into every
 *   turn that quotes it.
 *
 * The draft write goes through the conversation input service, the same
 * channel dsh-quick-open's own reference insert uses — no plugin-specific
 * route, no chip-coordinate tricks.
 */

/** How a selection is written into the composer draft. */
export type SelectionFormat = 'path' | 'path-hint' | 'content'

/** The default: location only, the cheapest useful shape. */
export const DEFAULT_SELECTION_FORMAT: SelectionFormat = 'path'

/** localStorage key the settings panel writes and the viewer reads. */
export const SELECTION_FORMAT_KEY = 'dsh-quick-open:selection-format'

/** Read the persisted format, falling back to the default on anything odd. */
export function readSelectionFormat(): SelectionFormat {
  try {
    const raw = window.localStorage.getItem(SELECTION_FORMAT_KEY)
    return raw === 'path' || raw === 'path-hint' || raw === 'content' ? raw : DEFAULT_SELECTION_FORMAT
  } catch {
    return DEFAULT_SELECTION_FORMAT
  }
}

/** Persist the format; a storage failure must not break the panel. */
export function writeSelectionFormat(value: SelectionFormat): void {
  try {
    window.localStorage.setItem(SELECTION_FORMAT_KEY, value)
  } catch {
    // A full or blocked localStorage is not worth surfacing for a preference.
  }
}

/** Guard against a selection large enough to bloat the draft. */
export const CONTENT_LIMIT = 4000

/** Cap on lines quoted for `path-hint`'s instruction. */
const HINT_LINES_SUGGESTED = 60

/** The 1-based inclusive line span a selection covers. */
export interface SelectionLines {
  start: number
  end: number
}

/** The composer input face (structural mirror of ui-conversation's input). */
interface ConversationInput {
  for(actx: unknown): {
    state: { getSnapshot(): { draft: string } }
    setDraft(text: string): void
  }
}

interface ConversationLike {
  input: ConversationInput
}

/** The pieces a reference line is built from. */
export interface ReferenceInput {
  /** Workspace-relative path, '/'-separated. */
  relativePath: string
  /**
   * The line span, when the renderer exposes one. The plain-text and code
   * renderers mark every line in the DOM; a rendered Markdown or HTML page
   * does not, and there a bare `@path` mention is still useful — dropping the
   * reference entirely because no line number is available would be worse.
   */
  lines?: SelectionLines
  /** The selected text, used only by the `content` format. */
  selected: string
  format: SelectionFormat
}

/**
 * The `@`-mention spelling of a path: quoted when it contains whitespace,
 * mirroring `formatFileMention` in @deepseek-ai/dsh-file-reference. `undefined`
 * when the path carries a character the mention grammar cannot represent.
 */
export function mentionOf(relativePath: string): string | undefined {
  const path = relativePath.replace(/^\/+/u, '')
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u0022]/u.test(path)) return undefined
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`
}

/** `path:12` for one line, `path:12-15` for a span. */
function locationOf(relativePath: string, lines: SelectionLines): string {
  return lines.end > lines.start
    ? `${relativePath}:${lines.start}-${lines.end}`
    : `${relativePath}:${lines.start}`
}

/**
 * Build the draft text for one selection.
 *
 * Every format starts from the `@path` mention so the reference is
 * machine-recognizable whichever shape is chosen; the line span qualifies it
 * when the renderer exposed one, and the formats differ only in what is
 * appended after it.
 */
export function buildSelectionText(input: ReferenceInput): string | undefined {
  const { relativePath, lines, selected, format } = input
  const mention = mentionOf(relativePath)
  if (mention === undefined) return undefined
  const location = lines === undefined
    ? mention
    : `${mention}:${lines.end > lines.start ? `${lines.start}-${lines.end}` : lines.start}`

  if (format === 'content') {
    if (selected.length > CONTENT_LIMIT) return location
    const head = lines === undefined ? relativePath : locationOf(relativePath, lines)
    return `\`\`\`${head}\n${selected}\n\`\`\``
  }
  if (format === 'path-hint') {
    if (lines === undefined) return location
    const span = lines.end > lines.start ? `第 ${lines.start}-${lines.end} 行` : `第 ${lines.start} 行`
    const tooLong = lines.end - lines.start + 1 > HINT_LINES_SUGGESTED
      ? '范围较长，可只读取其中相关部分。'
      : ''
    return `${location}（${span}，请用 read 工具读取该文件的这一段）${tooLong}`
  }
  return location
}

/**
 * Append text to a session's composer draft, keeping exactly one separating
 * space and never sending. Returns false when the conversation service or the
 * session scope is unavailable.
 */
export function appendToDraft(
  ctx: { sessions?: { scope?(id: string): unknown }, get(name: string): unknown } | undefined,
  sessionId: string,
  text: string,
): boolean {
  try {
    const actx = ctx?.sessions?.scope?.(sessionId)
    if (actx === undefined) return false
    const conversation = ctx?.get('conversation') as ConversationLike | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    const trimmed = draft.replace(/\s+$/u, '')
    input.setDraft(trimmed === '' ? text : `${trimmed} ${text}`)
    return true
  } catch (error) {
    console.warn('[dsh-quick-open] draft fill failed:', error)
    return false
  }
}

/**
 * The `dsh-resource://file/session/<id>/<path>` address grammar.
 *
 * The augmentations never read a file themselves — the built-in document
 * preview does that — but they still need the address a preview tab is
 * showing: the built-in preview writes it onto its root element as
 * `data-textpreview-url`, and the selection reference needs the session and
 * path back out of it. Only `session` addresses carry a session to attribute
 * a selection to, so anything else parses to undefined.
 */

/** The parts of a session-scoped file address. */
export interface FileAddress {
  sessionId: string
  path: string
}

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/**
 * Parse a `dsh-resource://file/session/<id>/<path>` address.
 *
 * Mirrors the native grammar: scheme and type first, then a scope segment.
 * A segment that is not validly percent-encoded is a malformed address rather
 * than a path to guess at.
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const end = address.search(/[?#]/u)
  const body = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
  const [scope, ...rest] = body.split('/')
  if (scope !== 'session') return undefined
  const [id, ...segments] = rest
  if (id === undefined || id === '' || segments.length === 0) return undefined
  try {
    return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
  } catch {
    return undefined
  }
}

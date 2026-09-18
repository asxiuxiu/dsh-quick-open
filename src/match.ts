/**
 * The quick-open fuzzy matcher.
 *
 * Design provenance: this is a port of VSCode's file quick-open scorer
 * (`src/vs/base/common/fuzzyScorer.ts` + `src/vs/base/common/filters.ts`),
 * whose constants and rank bands were read from source rather than invented.
 * An earlier attempt at hand-tuned scoring was abandoned after five distinct
 * designs each broke a different set of queries — see
 * `docs/matching-research.md` for the experiments and the negative results.
 *
 * What is taken from VSCode:
 *
 * - QUERY SHAPE: the query splits on SPACES, and every piece must match
 *   (AND). A piece that does not match rejects the whole entry.
 * - TARGET CHOICE (`preferLabelMatches`): score the basename alone unless the
 *   query contains a path separator, in which case score the whole path.
 * - CHAR SCORE (`computeCharScore`): +1 per char, a consecutive-run bonus of
 *   `min(run,3)*6 + max(0,run-3)*3`, +1 for a case-identical char, +8 at
 *   index 0, +5 after `/` or `\`, +4 after `_ - . space ' " :`, and +2 for a
 *   camelCase uppercase hit that is not part of a run.
 * - SEQUENTIAL CONSTRAINT: a non-first pattern char scores 0 unless the
 *   diagonal had a score, which is what stops `de` from matching `ede` at a
 *   word-start bonus.
 * - RANK BANDS: disjoint bases (`1<<18` identity, `1<<17` name prefix,
 *   `1<<16` name) rather than a tuned weight, so "matched the filename" can
 *   never be overtaken by "matched the path".
 *
 * Two deviations, both deliberate:
 *
 * 1. The DP matrix is allocated per call. VSCode caches whole item scores; we
 *    cannot, because our corpus is ~50k entries and the score depends on the
 *    query. Measured cost is ~4ms median at 51k entries, so this is fine.
 * 2. A conservative subsequence prescreen runs before the matrix. It can only
 *    reject entries that cannot match, so it never changes the result set.
 */

/** One scored result: the entry plus its match spans for highlighting. */
export interface ScoredMatch {
  /** Total rank value; higher is better. */
  score: number
  /** Spans of the basename that matched, for highlighting. */
  nameSpans: MatchSpan[]
  /**
   * Spans of the full path that matched outside the basename, for
   * highlighting the directory prefix. Empty when the basename sufficed.
   */
  dirSpans: MatchSpan[]
  /**
   * Span from the first to the last matched character (smaller is tighter).
   * Used as a tie-break so a tight abbreviation outranks a scattered match
   * that happens to reach the same fuzzy score.
   */
  compactness: number
}

/** A half-open [start, end) range. */
export interface MatchSpan {
  start: number
  end: number
}

/** Rank bands, lifted from VSCode's fuzzyScorer.ts. */
const PATH_IDENTITY_SCORE = 1 << 18
const NAME_PREFIX_SCORE = 1 << 17
const NAME_SCORE = 1 << 16
/**
 * An explicit `dir:` match. Sits between the basename bands and the
 * incidental path band: the user asked for a directory, so it must outrank
 * loose fuzzy path hits, but it is still not a filename match.
 */
const DIR_SCOPE_SCORE = 1 << 15
/** Matches that needed the directory: below any whole-basename match. */
const PATH_ASSISTED_SCORE = 1 << 14

/** Case-insensitive comparison of one character code against a lowercase char. */
function lowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

/** VSCode's `scoreSeparatorAtPos`. */
function scoreSeparatorAtPos(code: number): number {
  switch (code) {
    case 47: // '/'
    case 92: // '\'
      return 5
    case 95: // '_'
    case 45: // '-'
    case 46: // '.'
    case 32: // ' '
    case 39: // "'"
    case 34: // '"'
    case 58: // ':'
      return 4
    default:
      return 0
  }
}

/**
 * VSCode's `computeCharScore`. `queue` positions are compared lowercased, so
 * `target` keeps its original case for the case-identical bonus while
 * `targetLower` is the precomputed lowercase of the string.
 */
function computeCharScore(
  queryCharCode: number,
  target: string,
  targetLower: string,
  targetIndex: number,
  sequenceLength: number,
): number {
  if (lowerCode(queryCharCode) !== targetLower.charCodeAt(targetIndex)) return 0

  let score = 1
  if (sequenceLength > 0) {
    score += Math.min(sequenceLength, 3) * 6 + Math.max(0, sequenceLength - 3) * 3
  }
  if (queryCharCode === target.charCodeAt(targetIndex)) score += 1

  if (targetIndex === 0) {
    score += 8
  } else {
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1))
    if (separatorBonus !== 0) {
      score += separatorBonus
    } else if (
      sequenceLength === 0
      && target.charCodeAt(targetIndex) >= 65
      && target.charCodeAt(targetIndex) <= 90
    ) {
      score += 2
    }
  }
  return score
}

/**
 * VSCode's `doScoreFuzzy`: a (queryLength × targetLength) DP matrix. `scores`
 * holds the best score reaching each cell, `matches` the length of the
 * consecutive run ending there. Positions are recovered by walking back from
 * the bottom-right corner, which is what makes highlight spans exact.
 *
 * `scores` / `matches` are caller-provided scratch buffers so the hot loop
 * allocates nothing.
 */
function scoreFuzzy(
  queryLower: string,
  target: string,
  targetLower: string,
  scores: Int32Array,
  matches: Int32Array,
  positions: number[],
): number {
  const queryLength = queryLower.length
  const targetLength = target.length
  positions.length = 0
  if (queryLength === 0 || targetLength < queryLength) return 0

  for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
    const queryOffset = queryIndex * targetLength
    const previousOffset = queryOffset - targetLength
    const queryIndexGtNull = queryIndex > 0
    const queryCharCode = queryLower.charCodeAt(queryIndex)

    for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
      const currentIndex = queryOffset + targetIndex
      const targetIndexGtNull = targetIndex > 0
      const leftScore = targetIndexGtNull ? scores[currentIndex - 1] : 0
      const diagonalScore = queryIndexGtNull && targetIndexGtNull ? scores[previousOffset + targetIndex - 1] : 0
      const sequenceLength = queryIndexGtNull && targetIndexGtNull ? matches[previousOffset + targetIndex - 1] : 0

      // A non-first query char may only continue an existing alignment; this
      // is the sequential constraint that keeps the match in order.
      const score = !diagonalScore && queryIndexGtNull
        ? 0
        : computeCharScore(queryCharCode, target, targetLower, targetIndex, sequenceLength)

      if (score !== 0 && diagonalScore + score >= leftScore) {
        matches[currentIndex] = sequenceLength + 1
        scores[currentIndex] = diagonalScore + score
      } else {
        matches[currentIndex] = 0
        scores[currentIndex] = leftScore
      }
    }
  }

  let queryIndex = queryLength - 1
  let targetIndex = targetLength - 1
  while (queryIndex >= 0 && targetIndex >= 0) {
    const currentIndex = queryIndex * targetLength + targetIndex
    if (matches[currentIndex] === 0) {
      targetIndex--
    } else {
      positions.push(targetIndex)
      queryIndex--
      targetIndex--
    }
  }
  // The walk yields positions in descending order.
  for (let i = 0, j = positions.length - 1; i < j; i++, j--) {
    const swap = positions[i]
    positions[i] = positions[j]
    positions[j] = swap
  }
  return scores[queryLength * targetLength - 1]
}

/**
 * Conservative gate: can `needle` appear in `hay` as a subsequence? Rejects
 * only genuine impossibilities, so it never removes a real match — it just
 * spares the DP matrix for the vast majority of entries.
 */
export function isSubsequence(needle: string, hay: string): boolean {
  let hayIndex = 0
  const hayLength = hay.length
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex++) {
    const code = needle.charCodeAt(needleIndex)
    let found = false
    while (hayIndex < hayLength) {
      if (hay.charCodeAt(hayIndex) === code) {
        found = true
        hayIndex++
        break
      }
      hayIndex++
    }
    if (!found) return false
  }
  return true
}

/** Merge ascending positions into half-open spans. */
function toSpans(positions: readonly number[], offset: number): MatchSpan[] {
  const spans: MatchSpan[] = []
  for (const position of positions) {
    const last = spans[spans.length - 1]
    if (last !== undefined && last.end === position + offset) last.end = position + offset + 1
    else spans.push({ start: position + offset, end: position + offset + 1 })
  }
  return spans
}

/**
 * Scratch buffers for the DP matrix. Allocating once per query and reusing
 * them across entries is what keeps a 50k-entry scan interactive; allocating
 * inside `scoreEntry` costs ~10x. The buffers must hold `queryLength ×
 * targetLength` cells, and since the target is the full path for path
 * queries, size them from the longest piece and the longest path up front.
 */
export interface MatchScratch {
  scores: Int32Array
  matches: Int32Array
  positions: number[]
}

/** Create scratch space guaranteed to fit `pieceLength × targetLength`. */
export function createMatchScratch(pieceLength: number, targetLength: number): MatchScratch {
  const cellCount = Math.max(pieceLength, 1) * Math.max(targetLength, 1)
  return { scores: new Int32Array(cellCount), matches: new Int32Array(cellCount), positions: [] }
}

/** Where one query piece is allowed to match. */
export type PieceScope =
  /** Default: the basename, falling back to the path for path queries. */
  | 'any'
  /** `dir:` — must match the directory portion (never the basename). */
  | 'dir'
  /** `file:` — must match the basename. */
  | 'name'

/** One query piece plus the scope its prefix selected. */
export interface QueryPiece {
  text: string
  scope: PieceScope
}

/** A parsed query: the pieces, plus the raw normalized forms used for scoring. */
export interface PreparedQuery {
  pieces: QueryPiece[]
  /**
   * The lowercased query with its spaces INTACT and any `dir:` / `file:`
   * prefixes stripped.
   *
   * The identity and prefix checks use this rather than the pieces joined
   * without spaces. Typing `post process` must not satisfy the prefix test
   * for `postprocess`: doing so promotes short unrelated paths into the
   * prefix band and displaces the real matches (a regression caught by the
   * verification suite).
   */
  normalized: string
  /** Whether the query addresses a path (has a separator or a `dir:` scope). */
  pathQuery: boolean
}

/** Prefixes that scope a piece. Kept short and unambiguous. */
const SCOPE_PREFIXES: readonly (readonly [string, PieceScope])[] = [
  ['dir:', 'dir'],
  ['d:', 'dir'],
  ['file:', 'name'],
  ['f:', 'name'],
]

/**
 * Parse a raw query into scoped pieces.
 *
 * The grammar is deliberately tiny: each whitespace-separated piece may carry
 * an optional `dir:` / `file:` prefix (or the single-letter `d:` / `f:`),
 * which restricts where that piece is allowed to match. A piece whose text is
 * ONLY a prefix (`dir:`) is dropped, so a half-typed prefix yields no
 * constraint rather than an empty match.
 *
 * With no prefixes present the result is exactly the pre-existing behaviour:
 * the pieces are the whitespace split, `normalized` is the lowercased query
 * with its spaces intact, and `pathQuery` is the separator test. That property
 * is what keeps this addition from changing any query a user already relies on.
 */
export function prepareQuery(raw: string): PreparedQuery {
  const trimmed = raw.trim().toLowerCase()
  const pieces: QueryPiece[] = []
  let sawDirScope = false

  for (const token of trimmed.split(/\s+/u)) {
    if (token === '') continue
    let scope: PieceScope = 'any'
    let text = token
    for (const [prefix, kind] of SCOPE_PREFIXES) {
      // A token that is EXACTLY a prefix carries no text and constrains
      // nothing: it is dropped below rather than kept as a literal `dir:`
      // search term (which would filter for files containing "dir:").
      if (token.startsWith(prefix)) {
        scope = kind
        text = token.slice(prefix.length)
        break
      }
    }
    // Half-typed prefixes contribute no constraint, so typing `dir:` on the
    // way to `dir:ui` narrows nothing instead of emptying the result list.
    if (text === '') continue
    if (scope === 'dir') sawDirScope = true
    pieces.push({ text, scope })
  }

  return {
    pieces,
    normalized: pieces.map(piece => piece.text).join(' '),
    // A `dir:` piece is an explicit path request even without a separator, so
    // `dir:ui index.html` scores against the path.
    pathQuery: sawDirScope || trimmed.includes('/') || trimmed.includes('\\'),
  }
}

/**
 * Score one entry against a prepared query.
 *
 * `query` carries the scoped pieces and the normalized forms used for the
 * identity and prefix checks; `scratch` must be large enough for this entry
 * (see `createMatchScratch`).
 *
 * Returns `undefined` when the entry does not match.
 */
export function scoreEntry(
  query: PreparedQuery,
  name: string,
  nameLower: string,
  path: string,
  pathLower: string,
  scratch: MatchScratch,
): ScoredMatch | undefined {
  const nameLength = name.length
  const nameStart = path.length - nameLength
  const { scores, matches, positions } = scratch
  const { pieces, normalized, pathQuery } = query

  // The directory portion is only sliced when a `dir:` piece needs it, so the
  // common (prefix-free) path never pays for the extra string.
  let directory = ''
  let directoryLower = ''
  let directoryReady = false

  let total = 0
  let usedPath = false
  let forcedDir = false
  const namePositions: number[] = []
  const dirPositions: number[] = []

  for (const piece of pieces) {
    // `dir:` pieces must land outside the basename, so they never consult the
    // basename target at all — that is the whole point of the prefix.
    if (piece.scope !== 'dir') {
      const nameScore = isSubsequence(piece.text, nameLower)
        ? scoreFuzzy(piece.text, name, nameLower, scores, matches, positions)
        : 0
      if (nameScore !== 0) {
        total += nameScore
        for (const position of positions) namePositions.push(position)
        continue
      }
      // A `file:` piece may not fall back to the path.
      if (piece.scope === 'name') return undefined
    }

    if (!pathQuery) return undefined

    if (piece.scope === 'dir') {
      // Score the directory PREFIX rather than the whole path. The piece must
      // land outside the basename anyway, and the prefix is far shorter than
      // the path, so the DP matrix shrinks by the basename's share — the
      // difference between a ~7ms and a ~50ms query on a 50k-entry index.
      if (!directoryReady) {
        directory = path.slice(0, nameStart)
        directoryLower = pathLower.slice(0, nameStart)
        directoryReady = true
      }
      if (directory === '') return undefined
      if (!isSubsequence(piece.text, directoryLower)) return undefined
      const dirScore = scoreFuzzy(piece.text, directory, directoryLower, scores, matches, positions)
      if (dirScore === 0) return undefined
      forcedDir = true
      total += dirScore
      usedPath = true
      for (const position of positions) dirPositions.push(position)
      continue
    }

    // The path target may satisfy this piece from the directory.
    if (!isSubsequence(piece.text, pathLower)) return undefined
    const pathScore = scoreFuzzy(piece.text, path, pathLower, scores, matches, positions)
    if (pathScore === 0) return undefined

    total += pathScore
    usedPath = true
    for (const position of positions) dirPositions.push(position)
  }

  namePositions.sort((a, b) => a - b)
  dirPositions.sort((a, b) => a - b)

  let score: number
  if (pathLower === normalized) {
    score = PATH_IDENTITY_SCORE
  } else if (!usedPath && nameLower.startsWith(normalized)) {
    // A basename prefix hit outranks a mid-name hit, and a prefix covering
    // more of the basename outranks a shorter one (VSCode's `prefixLengthBoost`).
    score = NAME_PREFIX_SCORE + Math.round((normalized.length / nameLength) * 100) + total
  } else if (!usedPath) {
    // Satisfied entirely from the basename, whether or not the query had a
    // separator (e.g. `client/client_module`).
    score = NAME_SCORE + total
  } else if (forcedDir) {
    // An explicit `dir:` request: rank above the incidental path matches, so
    // the rows the user asked for are not buried under loose fuzzy hits.
    score = DIR_SCOPE_SCORE + total
  } else {
    // Needed the directory: ranked below any whole-basename match.
    score = PATH_ASSISTED_SCORE + total
  }

  const nameSpans = toSpans(namePositions, 0)
  // Directory spans are reported in full-path coordinates; positions inside
  // the basename are dropped (they are already in `nameSpans`).
  const dirSpans = mergeSpans(
    dirPositions
      .filter(position => position < nameStart)
      .map(position => ({ start: position, end: position + 1 })),
  )

  // Coverage: how much of the target the match actually spans. A scattered
  // match inside a long name can reach the same fuzzy score as a tight
  // abbreviation, and this ratio is what separates them (`clntmod` ->
  // `client_module` covers the whole name; the same letters inside
  // `client_game_actor_outline_mode_data` do not). VSCode breaks this tie with
  // `compareByMatchLength`; a ratio generalises it to targets of any length.
  // Measured against the target that actually matched.
  const targetLength = usedPath ? path.length : nameLength
  const first = usedPath
    ? (dirPositions.length > 0 ? dirPositions[0] : 0)
    : (namePositions.length > 0 ? namePositions[0] : 0)
  const last = usedPath
    ? (dirPositions.length > 0 ? dirPositions[dirPositions.length - 1] : 0)
    : (namePositions.length > 0 ? namePositions[namePositions.length - 1] : 0)
  const scattered = (last - first - normalized.length + 1) / targetLength

  return { score, nameSpans, dirSpans, compactness: scattered }
}

/** Merge ascending, possibly-adjacent spans. */
function mergeSpans(spans: readonly MatchSpan[]): MatchSpan[] {
  const out: MatchSpan[] = []
  for (const span of spans) {
    const last = out[out.length - 1]
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else out.push({ start: span.start, end: span.end })
  }
  return out
}

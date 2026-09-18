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

/**
 * Score one entry against a prepared query.
 *
 * `queryLower` is the whole query lowercased (used for the identity and
 * prefix checks); `piecesLower` are its space-separated parts, each of which
 * must match. `scratch` must be large enough for this entry — see
 * `createMatchScratch`.
 *
 * Returns `undefined` when the entry does not match.
 */
export function scoreEntry(
  queryLower: string,
  piecesLower: readonly string[],
  name: string,
  nameLower: string,
  path: string,
  pathLower: string,
  scratch: MatchScratch,
): ScoredMatch | undefined {
  const nameLength = name.length
  const nameStart = path.length - nameLength
  const { scores, matches, positions } = scratch

  // Target choice, per VSCode's `preferLabelMatches`: a query with a
  // separator is a path query; otherwise the basename is the target.
  const pathQuery = queryLower.includes('/') || queryLower.includes('\\')

  let total = 0
  let usedPath = false
  const namePositions: number[] = []
  const dirPositions: number[] = []

  for (const piece of piecesLower) {
    const nameScore = isSubsequence(piece, nameLower)
      ? scoreFuzzy(piece, name, nameLower, scores, matches, positions)
      : 0
    if (nameScore !== 0) {
      total += nameScore
      for (const position of positions) namePositions.push(position)
      continue
    }
    if (!pathQuery) return undefined
    // A path query may satisfy a piece from the directory.
    if (!isSubsequence(piece, pathLower)) return undefined
    const pathScore = scoreFuzzy(piece, path, pathLower, scores, matches, positions)
    if (pathScore === 0) return undefined
    total += pathScore
    usedPath = true
    for (const position of positions) dirPositions.push(position)
  }

  namePositions.sort((a, b) => a - b)
  dirPositions.sort((a, b) => a - b)

  let score: number
  if (pathLower === queryLower) {
    score = PATH_IDENTITY_SCORE
  } else if (!usedPath && nameLower.startsWith(queryLower)) {
    // A basename prefix hit outranks a mid-name hit, and a prefix covering
    // more of the basename outranks a shorter one (VSCode's `prefixLengthBoost`).
    score = NAME_PREFIX_SCORE + Math.round((queryLower.length / nameLength) * 100) + total
  } else if (!usedPath) {
    // Satisfied entirely from the basename, whether or not the query had a
    // separator (e.g. `client/client_module`).
    score = NAME_SCORE + total
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
  const scattered = (last - first - queryLower.length + 1) / targetLength

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

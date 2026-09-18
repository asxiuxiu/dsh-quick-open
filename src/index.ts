/**
 * dsh-quick-open host half: the `/quick-open/api` JSON API — an indexed
 * workspace file search built for speed.
 *
 * Why this exists: dsh-better-sidebar's `fs.search` re-walks the whole tree
 * with SEQUENTIAL `opendir` calls on every keystroke (fine for small trees,
 * 0.5-2s on a 100k-file repo, and aborted requests keep burning server CPU
 * because the walk cannot be cancelled). This host half keeps a per-workspace
 * IN-MEMORY INDEX instead:
 *
 * - One parallel `readdir` walk (16-way concurrency) builds the full entry
 *   list once; queries are pure in-memory substring filters (<10ms even at
 *   100k entries).
 * - Stale-while-revalidate: an index older than TTL serves instantly while
 *   a background rebuild refreshes it.
 * - Entries carry `isDir`, so the client never probes `fs.tree` to decide
 *   whether a match opens (file) or references as `@dir/` (folder).
 * - The search root is ALWAYS the host-resolved session cwd (attached
 *   session header first, caller-supplied absolute cwd only as the hydration
 *   fallback) — the walk can never escape the workspace.
 *
 * What the walk indexes is governed by the workspace's own
 * `<cwd>/.dsh-quick-open.json` (see ./rules.ts): exclude/include directories
 * plus a file-type filter. Without that file the built-in DEFAULT_RULES
 * apply, so a workspace that never configures anything still gets a sane,
 * low-noise index.
 *
 * The route prefix `/quick-open/api` is unique to this plugin, so it cannot
 * collide with another plugin's routes. The browser-trust fence mirrors the
 * /sidebar and /api gateways: loopback or configured trusted hosts only.
 */
import { mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONFIG_DIRNAME,
  CONFIG_FILENAME,
  DEFAULT_RULES,
  classifyDirectory,
  compileDirMatchers,
  configPathFor,
  legacyConfigPathFor,
  matchesFileRules,
  parseRules,
  serializeRules,
  type IndexRules,
} from './rules.ts'
import { createMatchScratch, scoreEntry, type MatchSpan } from './match.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-quick-open'

/** Services required before mounting: route registration + session store. */
export const inject = ['webServer', 'sessions']

// ── wire ────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

const BODY_LIMIT = 64 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    // IncomingMessage normally yields Buffers; tolerate string chunks so the
    // parser is transport-agnostic (and unit-testable with plain Readables).
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > BODY_LIMIT) throw new ApiError('bad-request', 'body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new ApiError('bad-request', 'body must be a JSON object')
  return parsed as Record<string, unknown>
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value === '') throw new ApiError('bad-request', `"${key}" must be a non-empty string`)
  return value
}

// ── trust fence (loopback / trusted-host, same rule as the /api gateway) ────

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Loopback Host header or a deployment-trusted authority; cross-site browser markers refuse. */
function isTrusted(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) {
    const trusted = trustedHosts.some((entry) => {
      try {
        return new URL(`http://${entry}`).hostname === hostname
      } catch {
        return false
      }
    })
    if (!trusted) return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).hostname !== hostname) return false
    } catch {
      return false
    }
  }
  return true
}

// ── session cwd resolution (host-authoritative) ─────────────────────────────

interface HostSessionsService {
  get(sessionId: string): { header: { cwd?: string } } | undefined
}

/**
 * The session's authoritative cwd: attached session header first; the
 * caller's own list-summary cwd only while the session hydrates (and only
 * when it is an absolute path — the walk must never be redirected to a
 * relative guess).
 */
function sessionCwdOf(sessions: HostSessionsService, payload: Record<string, unknown>): string {
  const sessionId = requireString(payload, 'sessionId')
  const headerCwd = sessions.get(sessionId)?.header.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  const clientCwd = payload.cwd
  if (typeof clientCwd === 'string' && clientCwd !== '' && isAbsolute(clientCwd)) return clientCwd
  throw new ApiError('bad-request', 'session cwd is not available yet (session still hydrating)')
}

// ── the workspace index ─────────────────────────────────────────────────────

/** Safety bound for a runaway tree (a home directory root). */
const MAX_VISITED = 500_000
/** Walk concurrency: parallel readdir across the tree. */
const WALK_CONCURRENCY = 16
/** Index freshness window; older indexes serve stale while rebuilding. */
const INDEX_TTL_MS = 30_000
/** At most this many workspaces keep an index (LRU by build order). */
const INDEX_LRU_CAP = 3
/**
 * Config file revalidation window. A config edit must be picked up without a
 * host restart, so the file's mtime is re-checked at most this often per
 * workspace (cheap `stat`, far less frequent than the index TTL).
 */
const CONFIG_TTL_MS = 3_000

export interface IndexEntry {
  /**
   * Workspace-relative '/'-separated path, OR an absolute '/'-separated path
   * for entries that came from an extra root (see `absolute`).
   */
  path: string
  isDir: boolean
  /** Precomputed lowercase basename (the default match target). */
  nameLower: string
  /** Precomputed lowercase full path (the target for path queries). */
  pathLower: string
  /**
   * True when `path` is already absolute (the entry lives in an extra root
   * outside the workspace) and the client must NOT join it against the cwd.
   */
  absolute?: boolean
  /** Extra-root label, for the result row's dimmed prefix. */
  rootLabel?: string
}

interface WorkspaceIndex {
  entries: IndexEntry[]
  builtAt: number
  /** Non-null while a (background) rebuild is running. */
  building: Promise<IndexEntry[]> | null
  /** The rules this index was built with; a config change invalidates it. */
  rules: IndexRules
  /** When the config file was last stat'ed (ms). */
  configCheckedAt: number
}

/** One walk target: the workspace root, or a configured extra root outside it. */
interface WalkRoot {
  /** Absolute directory to walk. */
  root: string
  /** True for extra roots: their entries carry absolute paths. */
  isExtra: boolean
  /** Extra-root label for the result row; undefined for the workspace root. */
  label?: string
}

/**
 * Parallel breadth-first walk of one root. Directories rejected by the rules
 * are neither matched nor descended, files the rules reject are not indexed,
 * and an unreadable level is skipped — permission errors never fail the whole
 * build.
 *
 * `includeDirs` is consulted before `excludeDirs`, so a generated tree nested
 * under an excluded build root stays reachable. The same explicit inclusion is
 * the ONLY way a symbolic-linked directory is descended (a `.skills` junction,
 * say); every other symlink is left alone, and a followed link that resolves
 * to an already-visited real path is dropped so a cycle cannot hang the walk.
 *
 * Directory rules are matched against the path RELATIVE TO THIS ROOT, so a
 * rule such as `_install` applies inside every root identically, and an extra
 * root that happens to live under a directory named `build` is not silently
 * swallowed by the workspace's own `build/*` exclusions.
 */
async function buildEntriesFor(target: WalkRoot, rules: IndexRules): Promise<IndexEntry[]> {
  const { root, isExtra, label } = target
  const entries: IndexEntry[] = []
  const matchers = compileDirMatchers(rules)
  const queue: string[] = [root]
  /** Real paths already queued, so a followed symlink cannot re-enter this tree. */
  const seenReal = new Set<string>()
  let visited = 0
  let active = 0
  let overflow = false

  /** Absolute-path entries are '/'-separated so the client never sees a backslash. */
  const entryPath = (absolute: string): string =>
    isExtra ? absolute.split(sep).join('/') : relative(root, absolute).split(sep).join('/')

  return new Promise((resolve) => {
    const maybeDone = (): void => {
      if ((queue.length === 0 && active === 0) || overflow) resolve(entries)
    }
    /** Queue one directory unless its real path was already visited (cycle). */
    const enqueue = (absolute: string): void => {
      void realpath(absolute)
        .then((real) => {
          if (seenReal.has(real)) return
          seenReal.add(real)
          queue.push(absolute)
          pump()
        })
        .catch(() => {
          // Unresolvable link: skipped.
        })
    }
    const pump = (): void => {
      while (!overflow && active < WALK_CONCURRENCY && queue.length > 0) {
        const dir = queue.shift() as string
        active += 1
        void readdir(dir, { withFileTypes: true })
          .then((dirents) => {
            for (const dirent of dirents) {
              visited += 1
              if (visited > MAX_VISITED) {
                overflow = true
                break
              }
              const absolute = join(dir, dirent.name)
              const path = entryPath(absolute)
              const pathLower = path.toLowerCase()
              const nameLower = dirent.name.toLowerCase()
              // Rules match the root-relative path; extra roots use the same
              // vocabulary so `_install` means the same thing everywhere.
              const rulePath = isExtra ? relative(root, absolute).split(sep).join('/') : path
              if (dirent.isDirectory()) {
                const verdict = classifyDirectory(matchers, rulePath, dirent.isSymbolicLink())
                if (verdict === 'skip') continue
                if (rules.includeDirectories) {
                  entries.push({
                    path,
                    isDir: true,
                    nameLower,
                    pathLower,
                    ...(isExtra ? { absolute: true } : {}),
                    ...(label !== undefined ? { rootLabel: label } : {}),
                  })
                }
                if (verdict === 'enter') {
                  seenReal.add(absolute)
                  queue.push(absolute)
                } else {
                  enqueue(absolute)
                }
                continue
              }
              if (!dirent.isFile()) continue
              if (!matchesFileRules(rules, dirent.name)) continue
              entries.push({
                path,
                isDir: false,
                nameLower,
                pathLower,
                ...(isExtra ? { absolute: true } : {}),
                ...(label !== undefined ? { rootLabel: label } : {}),
              })
            }
          })
          .catch(() => {
            // unreadable level: skipped, never fatal
          })
          .finally(() => {
            active -= 1
            pump()
            maybeDone()
          })
      }
      maybeDone()
    }
    seenReal.add(root)
    pump()
  })
}

/** Basename of an absolute path, used as the default extra-root label. */
function basenameOf(path: string): string {
  const normalized = path.split(sep).join('/').replace(/\/+$/, '')
  const at = normalized.lastIndexOf('/')
  return at === -1 ? normalized : normalized.slice(at + 1)
}

/**
 * Walk every configured root and concatenate the entries. The workspace root
 * comes first so its matches win ties in the ranker; extra roots are walked
 * after it, each independently (their own cycle guard, their own rule-relative
 * paths).
 */
async function buildEntries(root: string, rules: IndexRules): Promise<IndexEntry[]> {
  const targets: WalkRoot[] = [
    { root, isExtra: false },
    ...rules.extraRoots.map(extra => ({
      root: extra.path,
      isExtra: true,
      label: extra.label ?? basenameOf(extra.path),
    })),
  ]
  const groups = await Promise.all(targets.map(target => buildEntriesFor(target, rules)))
  return groups.flat()
}

const indexes = new Map<string, WorkspaceIndex>()

// ── per-workspace config file ───────────────────────────────────────────────

/** Read and parse a config file, or undefined when it is absent/unreadable. */
async function readConfigFile(path: string): Promise<IndexRules | undefined> {
  try {
    const raw = await readFile(path, 'utf8')
    return parseRules(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * The workspace's rules: `<cwd>/.dsh/quick-open.json`, falling back to the
 * legacy root-level file from an earlier version, and finally to the neutral
 * built-in defaults. A broken file is treated as absent rather than fatal.
 */
async function readRules(cwd: string): Promise<{ rules: IndexRules; path: string; exists: boolean }> {
  const primary = configPathFor(cwd)
  const fromPrimary = await readConfigFile(primary)
  if (fromPrimary !== undefined) return { rules: fromPrimary, path: primary, exists: true }
  const legacy = legacyConfigPathFor(cwd)
  const fromLegacy = await readConfigFile(legacy)
  if (fromLegacy !== undefined) return { rules: fromLegacy, path: legacy, exists: true }
  return { rules: { ...DEFAULT_RULES }, path: primary, exists: false }
}

/** Structural key for rules equality: a reparse that changes nothing must not rebuild. */
function rulesKey(rules: IndexRules): string {
  return JSON.stringify([
    rules.excludeDirs,
    rules.includeDirs,
    rules.includeExtensions,
    rules.includeFilenames,
    rules.includeDirectories,
    rules.extraRoots.map(extra => [extra.path, extra.label ?? '']),
  ])
}

/** The index for one workspace, building on first use and revalidating by TTL. */
function indexFor(cwd: string): WorkspaceIndex {
  const existing = indexes.get(cwd)
  if (existing !== undefined) {
    // LRU touch.
    indexes.delete(cwd)
    indexes.set(cwd, existing)
    if (Date.now() - existing.builtAt > INDEX_TTL_MS && existing.building === null) {
      existing.building = buildEntries(cwd, existing.rules)
        .then((entries) => {
          existing.entries = entries
          existing.builtAt = Date.now()
          return entries
        })
        .catch(() => existing.entries)
        .finally(() => {
          existing.building = null
        })
    }
    return existing
  }
  const created: WorkspaceIndex = {
    entries: [],
    builtAt: 0,
    building: null,
    rules: { ...DEFAULT_RULES },
    configCheckedAt: 0,
  }
  created.building = buildEntries(cwd, created.rules)
    .then((entries) => {
      created.entries = entries
      created.builtAt = Date.now()
      return entries
    })
    .finally(() => {
      created.building = null
    })
  indexes.set(cwd, created)
  // LRU eviction.
  while (indexes.size > INDEX_LRU_CAP) {
    const oldest = indexes.keys().next().value
    if (oldest === undefined) break
    indexes.delete(oldest)
  }
  return created
}

/**
 * Refresh a workspace's rules from disk and drop the index when they changed,
 * so the next query rebuilds. Runs at most once per CONFIG_TTL_MS per
 * workspace. A rule change is applied by REPLACING the index object, which
 * also invalidates any in-flight build's result (that build used the old
 * rules).
 */
async function revalidateRules(cwd: string): Promise<WorkspaceIndex> {
  const index = indexFor(cwd)
  if (Date.now() - index.configCheckedAt < CONFIG_TTL_MS) return index
  index.configCheckedAt = Date.now()
  const loaded = await readRules(cwd)
  if (rulesKey(loaded.rules) === rulesKey(index.rules)) return index
  const rules = loaded.rules
  const replacement: WorkspaceIndex = {
    entries: [],
    builtAt: 0,
    building: null,
    rules,
    configCheckedAt: index.configCheckedAt,
  }
  replacement.building = buildEntries(cwd, rules)
    .then((entries) => {
      replacement.entries = entries
      replacement.builtAt = Date.now()
      return entries
    })
    .finally(() => {
      replacement.building = null
    })
  indexes.set(cwd, replacement)
  return replacement
}

/** One row handed to the client: the path plus everything the row needs to render and act. */
interface MatchRow {
  path: string
  isDir: boolean
  /** The path is absolute (extra root) and must not be joined against the cwd. */
  absolute?: boolean
  /** Extra-root label for the dimmed prefix. */
  rootLabel?: string
  /** Matched spans of the basename, for highlighting. */
  nameSpans?: MatchSpan[]
  /** Matched spans inside the directory portion (path queries only). */
  dirSpans?: MatchSpan[]
}

/**
 * Fuzzy query over the index — the hot path.
 *
 * The scorer is a port of VSCode's quick-open scorer (see ./match.ts for what
 * was taken and why). Two properties matter for the shape of this loop:
 *
 * - Every query piece must match (space-separated AND), so a query is scored
 *   as a whole rather than progressively filtered.
 * - Scoring is O(query × target) per entry, so the cheap subsequence
 *   prescreen inside `scoreEntry` rejects most entries before the DP runs.
 *
 * Results are ranked by the scorer's own band-plus-fuzzy value, with a
 * deterministic fallback on path length so the same query always yields the
 * same order.
 */
function queryIndex(entries: readonly IndexEntry[], query: string, maxMatches: number): { matches: MatchRow[]; truncated: boolean } {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === '') return { matches: [], truncated: false }
  const pieces = trimmed.split(/\s+/u).filter(piece => piece !== '')
  if (pieces.length === 0) return { matches: [], truncated: false }

  // Size the DP scratch once for the whole scan. The matrix needs
  // `pieceLength × targetLength` cells and the target can be a full path, so
  // this is driven by the longest piece and the longest path in the index.
  // Reusing one buffer is what keeps a 50k-entry scan interactive.
  let longestPiece = 1
  for (const piece of pieces) {
    if (piece.length > longestPiece) longestPiece = piece.length
  }
  let longestPath = 1
  for (const entry of entries) {
    if (entry.pathLower.length > longestPath) longestPath = entry.pathLower.length
  }
  const scratch = createMatchScratch(longestPiece, longestPath)

  const scored: { row: MatchRow; score: number; compactness: number }[] = []

  for (const entry of entries) {
    // The walk stores the path already '/'-separated, so the basename is the
    // tail after the last '/'. Extra roots keep their absolute prefix in
    // `path`; scoring uses it only for path queries, which is intended (the
    // user typed a separator, so they are addressing a path).
    const nameLower = entry.nameLower
    const name = entry.path.slice(entry.path.length - nameLower.length)

    const scoredEntry = scoreEntry(trimmed, pieces, name, nameLower, entry.path, entry.pathLower, scratch)
    if (scoredEntry === undefined) continue

    scored.push({
      score: scoredEntry.score,
      compactness: scoredEntry.compactness,
      row: {
        path: entry.path,
        isDir: entry.isDir,
        ...(entry.absolute === true ? { absolute: true } : {}),
        ...(entry.rootLabel !== undefined ? { rootLabel: entry.rootLabel } : {}),
        ...(scoredEntry.nameSpans.length > 0 ? { nameSpans: scoredEntry.nameSpans } : {}),
        ...(scoredEntry.dirSpans.length > 0 ? { dirSpans: scoredEntry.dirSpans } : {}),
      },
    })
  }

  // Rank by score, then by how tight the match is, then by path length so the
  // order is always deterministic.
  scored.sort((a, b) =>
    b.score - a.score
    || a.compactness - b.compactness
    || a.row.path.length - b.row.path.length)
  const truncated = scored.length > maxMatches
  return { matches: scored.slice(0, maxMatches).map(item => item.row), truncated }
}

// ── plugin ──────────────────────────────────────────────────────────────────

interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  }): () => void
}

interface HostContext {
  webServer: WebServerLike
  sessions: HostSessionsService
  get(name: 'webRuntime'): { trustedHosts?: readonly string[] } | undefined
  get(name: string): unknown
  effect(body: () => (() => void) | void, label?: string): void
  logger: {
    warn(message: string, ...args: unknown[]): void
  }
}

const MAX_MATCHES = 200

/** Report whether the walk hit MAX_VISITED, so a truncated index is never silent. */
interface SearchOutcome {
  matches: MatchRow[]
  truncated: boolean
  indexedEntries: number
  indexAge: number
  indexTruncated: boolean
}

/**
 * Atomic config write: the new content lands in a sibling temp file that is
 * renamed over the target, so a crash mid-write can never leave a half-written
 * config behind (rename is atomic on the same filesystem). The `.dsh`
 * directory is created on demand — the file is the first thing to live there.
 */
async function writeConfigAtomically(cwd: string, rules: IndexRules): Promise<string> {
  const target = configPathFor(cwd)
  const dir = join(cwd, CONFIG_DIRNAME)
  const temp = join(dir, `.${CONFIG_FILENAME}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temp, serializeRules(rules), 'utf8')
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError('write-failed', `cannot write ${CONFIG_DIRNAME}/${CONFIG_FILENAME}: ${message}`, 500)
  }
  return target
}

export function apply(ctx: HostContext): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/quick-open/api',
    handler: async (req, res) => {
      const trustedHosts = ctx.get('webRuntime')?.trustedHosts ?? []
      if (!isTrusted(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/quick-open/api/') ? pathname.slice('/quick-open/api/'.length) : undefined
      try {
        const payload = await readJsonBody(req)
        const cwd = sessionCwdOf(ctx.sessions, payload)

        if (method === 'search') {
          const query = requireString(payload, 'query')
          const index = await revalidateRules(cwd)
          // The first build for a workspace blocks the query; revalidations
          // are backgrounded and serve the previous index.
          const entries = index.builtAt === 0 && index.building !== null
            ? await index.building
            : index.entries
          const outcome: SearchOutcome = {
            ...queryIndex(entries, query, MAX_MATCHES),
            indexedEntries: entries.length,
            indexAge: Date.now() - index.builtAt,
            indexTruncated: entries.length >= MAX_VISITED,
          }
          writeOk(res, { cwd, ...outcome })
          return
        }

        if (method === 'config.get') {
          const index = await revalidateRules(cwd)
          const loaded = await readRules(cwd)
          writeOk(res, {
            cwd,
            configPath: loaded.path,
            configExists: loaded.exists,
            rules: index.rules,
            defaults: DEFAULT_RULES,
            indexedEntries: index.entries.length,
          })
          return
        }

        if (method === 'config.set') {
          const rules = parseRules(payload.rules)
          const target = await writeConfigAtomically(cwd, rules)
          // Remove the legacy root-level file so the workspace does not end up
          // with two configs whose precedence is not obvious.
          await unlink(legacyConfigPathFor(cwd)).catch(() => {})
          // Drop the cached index so the next search rebuilds under the new
          // rules instead of serving entries from the old ones.
          const previous = indexes.get(cwd)
          if (previous !== undefined) {
            previous.configCheckedAt = 0
            previous.rules = rules
            previous.builtAt = 0
            previous.entries = []
            previous.building = buildEntries(cwd, rules)
              .then((entries) => {
                previous.entries = entries
                previous.builtAt = Date.now()
                return entries
              })
              .finally(() => {
                previous.building = null
              })
          }
          ctx.logger.warn('[dsh-quick-open] index rules updated for {0}', cwd)
          writeOk(res, { cwd, configPath: target, rules })
          return
        }

        if (method === 'config.reset') {
          await unlink(configPathFor(cwd)).catch(() => {})
          await unlink(legacyConfigPathFor(cwd)).catch(() => {})
          indexes.delete(cwd)
          writeOk(res, { cwd, rules: DEFAULT_RULES })
          return
        }

        throw new ApiError('not-found', `unknown quick-open API method "${String(method)}"`, 404)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-quick-open: /quick-open/api routes')
}

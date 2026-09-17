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
 * The route prefix `/quick-open/api` is unique to this plugin, so it cannot
 * collide with another plugin's routes. The browser-trust fence mirrors the
 * /sidebar and /api gateways: loopback or configured trusted hosts only.
 */
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

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

/** Noise forests that burn the walk budget without ever being search targets. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', '.yarn', '.turbo', '.turbopack',
  '.next', '.nuxt', '.output', '.cache', '.parcel-cache', 'coverage',
  'dist', 'build', 'out', '.umi', '.umi-production', '.dumi',
])

/** Safety bound for a runaway tree (a home directory root). */
const MAX_VISITED = 200_000
/** Walk concurrency: parallel readdir across the tree. */
const WALK_CONCURRENCY = 16
/** Index freshness window; older indexes serve stale while rebuilding. */
const INDEX_TTL_MS = 30_000
/** At most this many workspaces keep an index (LRU by build order). */
const INDEX_LRU_CAP = 8

export interface IndexEntry {
  /** Workspace-relative, '/'-separated. */
  path: string
  isDir: boolean
  /** Precomputed lowercase basename for the substring filter. */
  nameLower: string
}

interface WorkspaceIndex {
  entries: IndexEntry[]
  builtAt: number
  /** Non-null while a (background) rebuild is running. */
  building: Promise<IndexEntry[]> | null
}

/**
 * Parallel breadth-first walk of `root`. Symlinked directories are NOT
 * descended (cycle safety), noise directories are neither matched nor
 * descended, and an unreadable level is skipped — permission errors never
 * fail the whole build.
 */
async function buildEntries(root: string): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = []
  const queue: string[] = [root]
  let visited = 0
  let active = 0
  let overflow = false

  return new Promise((resolve) => {
    const maybeDone = (): void => {
      if ((queue.length === 0 && active === 0) || overflow) resolve(entries)
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
              if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name.toLowerCase())) continue
              const rel = relative(root, join(dir, dirent.name)).split(sep).join('/')
              entries.push({ path: rel, isDir: dirent.isDirectory(), nameLower: dirent.name.toLowerCase() })
              // Descend real directories only: a symlinked directory may
              // point back up the tree (cycle).
              if (dirent.isDirectory() && !dirent.isSymbolicLink()) queue.push(join(dir, dirent.name))
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
    pump()
  })
}

const indexes = new Map<string, WorkspaceIndex>()

/** The index for one workspace, building on first use and revalidating by TTL. */
function indexFor(cwd: string): WorkspaceIndex {
  const existing = indexes.get(cwd)
  if (existing !== undefined) {
    // LRU touch.
    indexes.delete(cwd)
    indexes.set(cwd, existing)
    if (Date.now() - existing.builtAt > INDEX_TTL_MS && existing.building === null) {
      existing.building = buildEntries(cwd)
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
  const created: WorkspaceIndex = { entries: [], builtAt: 0, building: null }
  created.building = buildEntries(cwd)
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

/** In-memory name-substring query over the index — the hot path. */
function queryIndex(entries: readonly IndexEntry[], query: string, maxMatches: number): { matches: { path: string; isDir: boolean }[]; truncated: boolean } {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { matches: [], truncated: false }
  const matches: { path: string; isDir: boolean }[] = []
  for (const entry of entries) {
    if (!entry.nameLower.includes(needle)) continue
    matches.push({ path: entry.path, isDir: entry.isDir })
    if (matches.length >= maxMatches) return { matches, truncated: true }
  }
  return { matches, truncated: false }
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
        if (method !== 'search') throw new ApiError('not-found', `unknown quick-open API method "${String(method)}"`, 404)
        const payload = await readJsonBody(req)
        const cwd = sessionCwdOf(ctx.sessions, payload)
        const query = requireString(payload, 'query')
        const index = indexFor(cwd)
        // The first build for a workspace blocks the query; revalidations
        // are backgrounded and serve the previous index.
        const entries = index.builtAt === 0 && index.building !== null
          ? await index.building
          : index.entries
        writeOk(res, {
          cwd,
          ...queryIndex(entries, query, MAX_MATCHES),
          indexedEntries: index.entries.length,
          indexAge: Date.now() - index.builtAt,
        })
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-quick-open: /quick-open/api routes')
}

// src/index.ts
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
var name = "dsh-quick-open";
var inject = ["webServer", "sessions"];
var ApiError = class extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
};
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}
function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value });
}
function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  writeJson(res, 500, { ok: false, error: { code: "internal", message } });
}
var BODY_LIMIT = 64 * 1024;
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new ApiError("bad-request", "body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new ApiError("bad-request", "body must be a JSON object");
  return parsed;
}
function requireString(payload, key) {
  const value = payload[key];
  if (typeof value !== "string" || value === "") throw new ApiError("bad-request", `"${key}" must be a non-empty string`);
  return value;
}
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function isTrusted(req, trustedHosts) {
  const host = req.headers.host;
  if (host === void 0) return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostname)) {
    const trusted = trustedHosts.some((entry) => {
      try {
        return new URL(`http://${entry}`).hostname === hostname;
      } catch {
        return false;
      }
    });
    if (!trusted) return false;
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    try {
      if (new URL(origin).hostname !== hostname) return false;
    } catch {
      return false;
    }
  }
  return true;
}
function sessionCwdOf(sessions, payload) {
  const sessionId = requireString(payload, "sessionId");
  const headerCwd = sessions.get(sessionId)?.header.cwd;
  if (headerCwd !== void 0 && headerCwd !== "") return headerCwd;
  const clientCwd = payload.cwd;
  if (typeof clientCwd === "string" && clientCwd !== "" && isAbsolute(clientCwd)) return clientCwd;
  throw new ApiError("bad-request", "session cwd is not available yet (session still hydrating)");
}
var SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  ".turbo",
  ".turbopack",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".parcel-cache",
  "coverage",
  "dist",
  "build",
  "out",
  ".umi",
  ".umi-production",
  ".dumi"
]);
var MAX_VISITED = 2e5;
var WALK_CONCURRENCY = 16;
var INDEX_TTL_MS = 3e4;
var INDEX_LRU_CAP = 8;
async function buildEntries(root) {
  const entries = [];
  const queue = [root];
  let visited = 0;
  let active = 0;
  let overflow = false;
  return new Promise((resolve) => {
    const maybeDone = () => {
      if (queue.length === 0 && active === 0 || overflow) resolve(entries);
    };
    const pump = () => {
      while (!overflow && active < WALK_CONCURRENCY && queue.length > 0) {
        const dir = queue.shift();
        active += 1;
        void readdir(dir, { withFileTypes: true }).then((dirents) => {
          for (const dirent of dirents) {
            visited += 1;
            if (visited > MAX_VISITED) {
              overflow = true;
              break;
            }
            if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name.toLowerCase())) continue;
            const rel = relative(root, join(dir, dirent.name)).split(sep).join("/");
            entries.push({ path: rel, isDir: dirent.isDirectory(), nameLower: dirent.name.toLowerCase() });
            if (dirent.isDirectory() && !dirent.isSymbolicLink()) queue.push(join(dir, dirent.name));
          }
        }).catch(() => {
        }).finally(() => {
          active -= 1;
          pump();
          maybeDone();
        });
      }
      maybeDone();
    };
    pump();
  });
}
var indexes = /* @__PURE__ */ new Map();
function indexFor(cwd) {
  const existing = indexes.get(cwd);
  if (existing !== void 0) {
    indexes.delete(cwd);
    indexes.set(cwd, existing);
    if (Date.now() - existing.builtAt > INDEX_TTL_MS && existing.building === null) {
      existing.building = buildEntries(cwd).then((entries) => {
        existing.entries = entries;
        existing.builtAt = Date.now();
        return entries;
      }).catch(() => existing.entries).finally(() => {
        existing.building = null;
      });
    }
    return existing;
  }
  const created = { entries: [], builtAt: 0, building: null };
  created.building = buildEntries(cwd).then((entries) => {
    created.entries = entries;
    created.builtAt = Date.now();
    return entries;
  }).finally(() => {
    created.building = null;
  });
  indexes.set(cwd, created);
  while (indexes.size > INDEX_LRU_CAP) {
    const oldest = indexes.keys().next().value;
    if (oldest === void 0) break;
    indexes.delete(oldest);
  }
  return created;
}
function queryIndex(entries, query, maxMatches) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { matches: [], truncated: false };
  const matches = [];
  for (const entry of entries) {
    if (!entry.nameLower.includes(needle)) continue;
    matches.push({ path: entry.path, isDir: entry.isDir });
    if (matches.length >= maxMatches) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}
var MAX_MATCHES = 200;
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/quick-open/api",
    handler: async (req, res) => {
      const trustedHosts = ctx.get("webRuntime")?.trustedHosts ?? [];
      if (!isTrusted(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
      const method = pathname.startsWith("/quick-open/api/") ? pathname.slice("/quick-open/api/".length) : void 0;
      try {
        if (method !== "search") throw new ApiError("not-found", `unknown quick-open API method "${String(method)}"`, 404);
        const payload = await readJsonBody(req);
        const cwd = sessionCwdOf(ctx.sessions, payload);
        const query = requireString(payload, "query");
        const index = indexFor(cwd);
        const entries = index.builtAt === 0 && index.building !== null ? await index.building : index.entries;
        writeOk(res, {
          cwd,
          ...queryIndex(entries, query, MAX_MATCHES),
          indexedEntries: index.entries.length,
          indexAge: Date.now() - index.builtAt
        });
      } catch (error) {
        writeError(res, error);
      }
    }
  }), "dsh-quick-open: /quick-open/api routes");
}
export {
  apply,
  inject,
  name
};

// src/index.ts
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join2, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";

// src/rules.ts
import { isAbsolute, join } from "node:path";
var CONFIG_DIRNAME = ".dsh";
var CONFIG_FILENAME = "quick-open.json";
var LEGACY_CONFIG_FILENAME = ".dsh-quick-open.json";
function configPathFor(cwd) {
  return join(cwd, CONFIG_DIRNAME, CONFIG_FILENAME);
}
function legacyConfigPathFor(cwd) {
  return join(cwd, LEGACY_CONFIG_FILENAME);
}
var CONFIG_VERSION = 1;
var DEFAULT_RULES = {
  excludeDirs: [
    // Version control metadata.
    ".git",
    ".hg",
    ".svn",
    // Dependency and package-manager trees.
    "node_modules",
    "bower_components",
    "vendor",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".pnpm-store",
    ".yarn",
    ".npm",
    ".cargo",
    ".gradle",
    ".m2",
    "Pods",
    "Carthage",
    // Build output and caches.
    "dist",
    "build",
    "out",
    "target",
    "bin",
    "obj",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".turbopack",
    ".nx",
    ".svelte-kit",
    ".next",
    ".nuxt",
    ".output",
    ".umi",
    ".umi-production",
    ".dumi",
    ".angular",
    "coverage",
    ".nyc_output",
    // Editor / IDE state.
    ".idea",
    ".vs"
  ],
  includeDirs: [],
  includeExtensions: [
    // C / C++.
    ".h",
    ".hpp",
    ".hh",
    ".hxx",
    ".inl",
    ".ipp",
    ".tpp",
    ".c",
    ".cc",
    ".cpp",
    ".cxx",
    ".m",
    ".mm",
    // JVM / .NET / Go / Rust.
    ".java",
    ".kt",
    ".kts",
    ".scala",
    ".cs",
    ".go",
    ".rs",
    // Scripting.
    ".py",
    ".rb",
    ".php",
    ".pl",
    ".lua",
    ".tcl",
    ".r",
    // Web.
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".vue",
    ".svelte",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".html",
    ".htm",
    ".svg",
    // Shell.
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".bat",
    ".cmd",
    ".ps1",
    ".psm1",
    // Data / config.
    ".json",
    ".jsonc",
    ".json5",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".cfg",
    ".conf",
    ".xml",
    ".csv",
    ".tsv",
    ".env",
    ".properties",
    // Databases / schemas / API.
    ".sql",
    ".proto",
    ".graphql",
    ".gql",
    ".thrift",
    ".avsc",
    // Shaders.
    ".glsl",
    ".hlsl",
    ".vert",
    ".frag",
    ".comp",
    ".wgsl",
    ".metal",
    // Docs and markup.
    ".md",
    ".markdown",
    ".rst",
    ".adoc",
    ".txt",
    ".tex",
    // Build systems and templates.
    ".cmake",
    ".gradle",
    ".mk",
    ".mak",
    ".tpl",
    ".tmpl",
    ".hbs",
    ".ejs",
    ".jinja",
    ".j2"
  ],
  includeFilenames: [
    // Extensionless or dot-file names that carry real meaning across projects.
    "cmakelists.txt",
    "makefile",
    "gnumakefile",
    "dockerfile",
    "containerfile",
    "vagrantfile",
    "jenkinsfile",
    "procfile",
    "brewfile",
    "rakefile",
    "gemfile",
    "podfile",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".dockerignore",
    ".editorconfig",
    ".env",
    ".env.example",
    ".clang-format",
    ".clang-tidy",
    ".eslintrc",
    ".prettierrc",
    ".babelrc",
    ".npmrc",
    ".nvmrc",
    ".python-version",
    ".ruby-version"
  ],
  includeDirectories: true,
  // Empty by default: an extra root is opt-in per workspace, since it widens
  // the search beyond the workspace boundary.
  extraRoots: []
};
function normalizeDirPath(path) {
  return path.split("\\").join("/").replace(/^\/+|\/+$/g, "");
}
function compileDirPattern(pattern) {
  const normalized = normalizeDirPath(pattern);
  if (normalized === "") return () => false;
  const covers = (dir, base) => dir === base || dir.startsWith(`${base}/`);
  const tailMatches = (dir, base) => {
    if (covers(dir, base)) return true;
    return dir.endsWith(`/${base}`) || dir.includes(`/${base}/`);
  };
  const doubleStar = normalized.indexOf("**/");
  if (doubleStar !== -1) {
    const suffix = normalized.slice(doubleStar + 3);
    if (suffix === "") return () => true;
    return (dir) => tailMatches(dir, suffix);
  }
  if (!normalized.includes("/")) {
    return (dir) => tailMatches(dir, normalized);
  }
  return (dir) => covers(dir, normalized);
}
function compileDirMatchers(rules) {
  const excludeFns = rules.excludeDirs.map(compileDirPattern);
  const includeFns = rules.includeDirs.map(compileDirPattern);
  return {
    exclude: (dir) => excludeFns.some((fn) => fn(dir)),
    include: (dir) => includeFns.some((fn) => fn(dir))
  };
}
function classifyDirectory(matchers, dir, isSymbolicLink) {
  const included = matchers.include(dir);
  if (!included && matchers.exclude(dir)) return "skip";
  if (isSymbolicLink) return included ? "enter-follow-link" : "skip";
  return "enter";
}
function extensionOf(name2) {
  const at = name2.lastIndexOf(".");
  if (at <= 0) return "";
  return name2.slice(at).toLowerCase();
}
function matchesFileRules(rules, name2) {
  const lower = name2.toLowerCase();
  if (rules.includeFilenames.includes(lower)) return true;
  if (rules.includeExtensions.length === 0) return true;
  return rules.includeExtensions.includes(extensionOf(name2));
}
function readStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}
function normalizeExtension(value) {
  const lower = value.trim().toLowerCase();
  if (lower === "") return "";
  return lower.startsWith(".") ? lower : `.${lower}`;
}
function readExtraRoots(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string") {
      const path2 = item.trim();
      if (path2 !== "" && isAbsolute(path2)) out.push({ path: path2 });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const entry = item;
    const path = typeof entry.path === "string" ? entry.path.trim() : "";
    if (path === "" || !isAbsolute(path)) continue;
    const label = typeof entry.label === "string" && entry.label.trim() !== "" ? entry.label.trim() : void 0;
    out.push(label === void 0 ? { path } : { path, label });
  }
  return out;
}
function parseRules(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_RULES };
  const source = raw;
  const hasExtensions = Array.isArray(source.includeExtensions);
  const extensions = hasExtensions ? readStringArray(source.includeExtensions, []).map(normalizeExtension).filter((x) => x !== "") : DEFAULT_RULES.includeExtensions;
  return {
    excludeDirs: readStringArray(source.excludeDirs, DEFAULT_RULES.excludeDirs).map(normalizeDirPath),
    includeDirs: readStringArray(source.includeDirs, DEFAULT_RULES.includeDirs).map(normalizeDirPath),
    includeExtensions: extensions,
    includeFilenames: readStringArray(source.includeFilenames, DEFAULT_RULES.includeFilenames).map((name2) => name2.toLowerCase()),
    includeDirectories: typeof source.includeDirectories === "boolean" ? source.includeDirectories : DEFAULT_RULES.includeDirectories,
    // An explicit list replaces the default entirely; extra roots are opt-in,
    // so an absent field simply means "none".
    extraRoots: readExtraRoots(source.extraRoots)
  };
}
function serializeRules(rules) {
  return `${JSON.stringify({ version: CONFIG_VERSION, ...rules }, null, 2)}
`;
}

// src/match.ts
var PATH_IDENTITY_SCORE = 1 << 18;
var NAME_PREFIX_SCORE = 1 << 17;
var NAME_SCORE = 1 << 16;
var DIR_SCOPE_SCORE = 1 << 15;
var PATH_ASSISTED_SCORE = 1 << 14;
function lowerCode(code) {
  return code >= 65 && code <= 90 ? code + 32 : code;
}
function scoreSeparatorAtPos(code) {
  switch (code) {
    case 47:
    // '/'
    case 92:
      return 5;
    case 95:
    // '_'
    case 45:
    // '-'
    case 46:
    // '.'
    case 32:
    // ' '
    case 39:
    // "'"
    case 34:
    // '"'
    case 58:
      return 4;
    default:
      return 0;
  }
}
function computeCharScore(queryCharCode, target, targetLower, targetIndex, sequenceLength) {
  if (lowerCode(queryCharCode) !== targetLower.charCodeAt(targetIndex)) return 0;
  let score = 1;
  if (sequenceLength > 0) {
    score += Math.min(sequenceLength, 3) * 6 + Math.max(0, sequenceLength - 3) * 3;
  }
  if (queryCharCode === target.charCodeAt(targetIndex)) score += 1;
  if (targetIndex === 0) {
    score += 8;
  } else {
    const separatorBonus = scoreSeparatorAtPos(target.charCodeAt(targetIndex - 1));
    if (separatorBonus !== 0) {
      score += separatorBonus;
    } else if (sequenceLength === 0 && target.charCodeAt(targetIndex) >= 65 && target.charCodeAt(targetIndex) <= 90) {
      score += 2;
    }
  }
  return score;
}
function scoreFuzzy(queryLower, target, targetLower, scores, matches, positions) {
  const queryLength = queryLower.length;
  const targetLength = target.length;
  positions.length = 0;
  if (queryLength === 0 || targetLength < queryLength) return 0;
  for (let queryIndex3 = 0; queryIndex3 < queryLength; queryIndex3++) {
    const queryOffset = queryIndex3 * targetLength;
    const previousOffset = queryOffset - targetLength;
    const queryIndexGtNull = queryIndex3 > 0;
    const queryCharCode = queryLower.charCodeAt(queryIndex3);
    for (let targetIndex2 = 0; targetIndex2 < targetLength; targetIndex2++) {
      const currentIndex = queryOffset + targetIndex2;
      const targetIndexGtNull = targetIndex2 > 0;
      const leftScore = targetIndexGtNull ? scores[currentIndex - 1] : 0;
      const diagonalScore = queryIndexGtNull && targetIndexGtNull ? scores[previousOffset + targetIndex2 - 1] : 0;
      const sequenceLength = queryIndexGtNull && targetIndexGtNull ? matches[previousOffset + targetIndex2 - 1] : 0;
      const score = !diagonalScore && queryIndexGtNull ? 0 : computeCharScore(queryCharCode, target, targetLower, targetIndex2, sequenceLength);
      if (score !== 0 && diagonalScore + score >= leftScore) {
        matches[currentIndex] = sequenceLength + 1;
        scores[currentIndex] = diagonalScore + score;
      } else {
        matches[currentIndex] = 0;
        scores[currentIndex] = leftScore;
      }
    }
  }
  let queryIndex2 = queryLength - 1;
  let targetIndex = targetLength - 1;
  while (queryIndex2 >= 0 && targetIndex >= 0) {
    const currentIndex = queryIndex2 * targetLength + targetIndex;
    if (matches[currentIndex] === 0) {
      targetIndex--;
    } else {
      positions.push(targetIndex);
      queryIndex2--;
      targetIndex--;
    }
  }
  for (let i = 0, j = positions.length - 1; i < j; i++, j--) {
    const swap = positions[i];
    positions[i] = positions[j];
    positions[j] = swap;
  }
  return scores[queryLength * targetLength - 1];
}
function bestDirectorySegment(directory, directoryLower, needle) {
  let segmentStart = 0;
  for (let i = 0; i <= directoryLower.length; i++) {
    if (i !== directoryLower.length && directoryLower.charCodeAt(i) !== 47) continue;
    if (i > segmentStart) {
      const lower = directoryLower.slice(segmentStart, i);
      if (lower.includes(needle)) {
        return { text: directory.slice(segmentStart, i), lower, start: segmentStart };
      }
    }
    segmentStart = i + 1;
  }
  return void 0;
}
function isSubsequence(needle, hay) {
  let hayIndex = 0;
  const hayLength = hay.length;
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex++) {
    const code = needle.charCodeAt(needleIndex);
    let found = false;
    while (hayIndex < hayLength) {
      if (hay.charCodeAt(hayIndex) === code) {
        found = true;
        hayIndex++;
        break;
      }
      hayIndex++;
    }
    if (!found) return false;
  }
  return true;
}
function toSpans(positions, offset) {
  const spans = [];
  for (const position of positions) {
    const at = position + offset;
    const last = spans[spans.length - 1];
    if (last !== void 0 && at <= last.end) last.end = Math.max(last.end, at + 1);
    else spans.push({ start: at, end: at + 1 });
  }
  return spans;
}
function createMatchScratch(pieceLength, targetLength) {
  const cellCount = Math.max(pieceLength, 1) * Math.max(targetLength, 1);
  return { scores: new Int32Array(cellCount), matches: new Int32Array(cellCount), positions: [] };
}
var SCOPE_PREFIXES = [
  ["dir:", "dir"],
  ["d:", "dir"],
  ["file:", "name"],
  ["f:", "name"]
];
function prepareQuery(raw) {
  const trimmed = raw.trim().toLowerCase();
  const pieces = [];
  let sawDirScope = false;
  for (const token of trimmed.split(/\s+/u)) {
    if (token === "") continue;
    let scope = "any";
    let text = token;
    for (const [prefix, kind] of SCOPE_PREFIXES) {
      if (token.startsWith(prefix)) {
        scope = kind;
        text = token.slice(prefix.length);
        break;
      }
    }
    if (text === "") continue;
    if (scope === "dir") sawDirScope = true;
    const segments = text.includes("/") || text.includes("\\") ? text.split(/[\\/]+/u).filter((segment) => segment !== "") : [];
    pieces.push({ text, scope, segments });
  }
  return {
    pieces,
    normalized: pieces.map((piece) => piece.text).join(" "),
    // A `dir:` piece is an explicit path request even without a separator, so
    // `dir:ui index.html` scores against the path.
    pathQuery: sawDirScope || trimmed.includes("/") || trimmed.includes("\\")
  };
}
function scoreEntry(query, name2, nameLower, path, pathLower, scratch) {
  const nameLength = name2.length;
  const nameStart = path.length - nameLength;
  const { scores, matches, positions } = scratch;
  const { pieces, normalized, pathQuery } = query;
  let directory = "";
  let directoryLower = "";
  let directoryReady = false;
  let total = 0;
  let usedPath = false;
  let forcedDir = false;
  const namePositions = [];
  const dirPositions = [];
  for (const piece of pieces) {
    if (piece.scope !== "dir") {
      const nameScore = isSubsequence(piece.text, nameLower) ? scoreFuzzy(piece.text, name2, nameLower, scores, matches, positions) : 0;
      if (nameScore !== 0) {
        total += nameScore;
        for (const position of positions) namePositions.push(position);
        continue;
      }
      if (piece.scope === "name") return void 0;
    }
    if (!pathQuery) return void 0;
    if (piece.segments.length > 0) {
      const anchored = matchPathSegments(piece, path, pathLower, nameStart, nameLength, scores, matches, positions);
      if (anchored === void 0) return void 0;
      total += anchored.score;
      usedPath = true;
      if (anchored.hitDirectory) forcedDir = true;
      for (const position of anchored.positions) dirPositions.push(position);
      for (const position of anchored.namePositions) namePositions.push(position);
      continue;
    }
    if (piece.scope === "dir") {
      if (!directoryReady) {
        directory = path.slice(0, nameStart);
        directoryLower = pathLower.slice(0, nameStart);
        directoryReady = true;
      }
      if (directory === "") return void 0;
      const segment = bestDirectorySegment(directory, directoryLower, piece.text);
      if (segment === void 0) return void 0;
      const dirScore = scoreFuzzy(piece.text, segment.text, segment.lower, scores, matches, positions);
      if (dirScore === 0) return void 0;
      forcedDir = true;
      total += dirScore;
      usedPath = true;
      for (const position of positions) dirPositions.push(segment.start + position);
      continue;
    }
    if (!isSubsequence(piece.text, pathLower)) return void 0;
    const pathScore = scoreFuzzy(piece.text, path, pathLower, scores, matches, positions);
    if (pathScore === 0) return void 0;
    total += pathScore;
    usedPath = true;
    for (const position of positions) dirPositions.push(position);
  }
  namePositions.sort((a, b) => a - b);
  dirPositions.sort((a, b) => a - b);
  let score;
  if (pathLower === normalized) {
    score = PATH_IDENTITY_SCORE;
  } else if (!usedPath && nameLower.startsWith(normalized)) {
    score = NAME_PREFIX_SCORE + Math.round(normalized.length / nameLength * 100) + total;
  } else if (!usedPath) {
    score = NAME_SCORE + total;
  } else if (forcedDir) {
    score = DIR_SCOPE_SCORE + total;
  } else {
    score = PATH_ASSISTED_SCORE + total;
  }
  const nameSpans = toSpans(namePositions, 0);
  const dirSpans = mergeSpans(
    dirPositions.filter((position) => position < nameStart).map((position) => ({ start: position, end: position + 1 }))
  );
  const targetLength = usedPath ? path.length : nameLength;
  const first = usedPath ? dirPositions.length > 0 ? dirPositions[0] : 0 : namePositions.length > 0 ? namePositions[0] : 0;
  const last = usedPath ? dirPositions.length > 0 ? dirPositions[dirPositions.length - 1] : 0 : namePositions.length > 0 ? namePositions[namePositions.length - 1] : 0;
  const scattered = (last - first - normalized.length + 1) / targetLength;
  return { score, nameSpans, dirSpans, compactness: scattered };
}
function mergeSpans(spans) {
  const out = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last !== void 0 && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ start: span.start, end: span.end });
  }
  return out;
}
function matchPathSegments(piece, path, pathLower, nameStart, nameLength, scores, matches, positions) {
  const querySegments = piece.segments;
  const lastIndex = querySegments.length - 1;
  const lastQuery = querySegments[lastIndex];
  const nameTarget = path.slice(nameStart);
  const nameTargetLower = pathLower.slice(nameStart);
  if (nameTargetLower.indexOf(lastQuery) === -1) return void 0;
  const nameScore = scoreFuzzy(lastQuery, nameTarget, nameTargetLower, scores, matches, positions);
  if (nameScore === 0) return void 0;
  const namePositions = [];
  for (const position of positions) namePositions.push(position);
  let total = nameScore;
  let hitDirectory = false;
  if (lastIndex > 0) {
    const bounds = [];
    let segmentStart = 0;
    for (let i = 0; i < nameStart; i++) {
      if (pathLower.charCodeAt(i) === 47) {
        bounds.push({ start: segmentStart, end: i });
        segmentStart = i + 1;
      }
    }
    const directoryPositions = [];
    let searchFrom = 0;
    for (let qi = 0; qi < lastIndex; qi++) {
      const querySegment = querySegments[qi];
      if (querySegment === "") return void 0;
      let found = false;
      for (let si = searchFrom; si < bounds.length; si++) {
        const bound = bounds[si];
        const segmentLower = pathLower.slice(bound.start, bound.end);
        const at = segmentLower.indexOf(querySegment);
        if (at === -1) continue;
        const segmentScore = scoreFuzzy(
          querySegment,
          path.slice(bound.start, bound.end),
          segmentLower,
          scores,
          matches,
          positions
        );
        if (segmentScore === 0) continue;
        total += segmentScore;
        for (const position of positions) directoryPositions.push(bound.start + position);
        searchFrom = si + 1;
        hitDirectory = true;
        found = true;
        break;
      }
      if (!found) return void 0;
    }
    return { score: total, positions: directoryPositions, namePositions, hitDirectory };
  }
  if (nameLength === 0) return void 0;
  return { score: total, positions: [], namePositions, hitDirectory };
}

// src/index.ts
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
  if (typeof clientCwd === "string" && clientCwd !== "" && isAbsolute2(clientCwd)) return clientCwd;
  throw new ApiError("bad-request", "session cwd is not available yet (session still hydrating)");
}
var MAX_VISITED = 5e5;
var WALK_CONCURRENCY = 16;
var INDEX_TTL_MS = 3e4;
var INDEX_LRU_CAP = 3;
var CONFIG_TTL_MS = 3e3;
async function buildEntriesFor(target, rules) {
  const { root, isExtra, label } = target;
  const entries = [];
  const matchers = compileDirMatchers(rules);
  const queue = [root];
  const seenReal = /* @__PURE__ */ new Set();
  let visited = 0;
  let active = 0;
  let overflow = false;
  const entryPath = (absolute) => isExtra ? absolute.split(sep).join("/") : relative(root, absolute).split(sep).join("/");
  return new Promise((resolve) => {
    const maybeDone = () => {
      if (queue.length === 0 && active === 0 || overflow) resolve(entries);
    };
    const enqueue = (absolute) => {
      void realpath(absolute).then((real) => {
        if (seenReal.has(real)) return;
        seenReal.add(real);
        queue.push(absolute);
        pump();
      }).catch(() => {
      });
    };
    const pump = () => {
      while (!overflow && active < WALK_CONCURRENCY && queue.length > 0) {
        const dir = queue.shift();
        active += 1;
        void readdir(dir, { withFileTypes: true }).then(async (dirents) => {
          for (const dirent of dirents) {
            visited += 1;
            if (visited > MAX_VISITED) {
              overflow = true;
              break;
            }
            const absolute = join2(dir, dirent.name);
            const path = entryPath(absolute);
            const isLink = dirent.isSymbolicLink();
            let isDir = dirent.isDirectory();
            if (!isDir && isLink) {
              try {
                isDir = (await stat(absolute)).isDirectory();
              } catch {
                continue;
              }
            }
            const pathLower = path.toLowerCase();
            const nameLower = dirent.name.toLowerCase();
            if (!isDir) {
              if (!dirent.isFile()) continue;
              if (!matchesFileRules(rules, dirent.name)) continue;
              entries.push({
                path,
                isDir: false,
                nameLower,
                pathLower,
                ...isExtra ? { absolute: true } : {},
                ...label !== void 0 ? { rootLabel: label } : {}
              });
              continue;
            }
            const rulePath = isExtra ? relative(root, absolute).split(sep).join("/") : path;
            const verdict = classifyDirectory(matchers, rulePath, isLink);
            if (verdict === "skip") continue;
            if (rules.includeDirectories) {
              entries.push({
                path,
                isDir: true,
                nameLower,
                pathLower,
                ...isExtra ? { absolute: true } : {},
                ...label !== void 0 ? { rootLabel: label } : {}
              });
            }
            if (verdict === "enter") {
              seenReal.add(absolute);
              queue.push(absolute);
            } else {
              enqueue(absolute);
            }
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
    seenReal.add(root);
    pump();
  });
}
function basenameOf(path) {
  const normalized = path.split(sep).join("/").replace(/\/+$/, "");
  const at = normalized.lastIndexOf("/");
  return at === -1 ? normalized : normalized.slice(at + 1);
}
async function buildEntries(root, rules) {
  const targets = [
    { root, isExtra: false },
    ...rules.extraRoots.map((extra) => ({
      root: extra.path,
      isExtra: true,
      label: extra.label ?? basenameOf(extra.path)
    }))
  ];
  const groups = await Promise.all(targets.map((target) => buildEntriesFor(target, rules)));
  return groups.flat();
}
var indexes = /* @__PURE__ */ new Map();
async function readConfigFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    return parseRules(JSON.parse(raw));
  } catch {
    return void 0;
  }
}
async function readRules(cwd) {
  const primary = configPathFor(cwd);
  const fromPrimary = await readConfigFile(primary);
  if (fromPrimary !== void 0) return { rules: fromPrimary, path: primary, exists: true };
  const legacy = legacyConfigPathFor(cwd);
  const fromLegacy = await readConfigFile(legacy);
  if (fromLegacy !== void 0) return { rules: fromLegacy, path: legacy, exists: true };
  return { rules: { ...DEFAULT_RULES }, path: primary, exists: false };
}
function rulesKey(rules) {
  return JSON.stringify([
    rules.excludeDirs,
    rules.includeDirs,
    rules.includeExtensions,
    rules.includeFilenames,
    rules.includeDirectories,
    rules.extraRoots.map((extra) => [extra.path, extra.label ?? ""])
  ]);
}
function indexFor(cwd) {
  const existing = indexes.get(cwd);
  if (existing !== void 0) {
    indexes.delete(cwd);
    indexes.set(cwd, existing);
    if (Date.now() - existing.builtAt > INDEX_TTL_MS && existing.building === null) {
      existing.building = buildEntries(cwd, existing.rules).then((entries) => {
        existing.entries = entries;
        existing.builtAt = Date.now();
        return entries;
      }).catch(() => existing.entries).finally(() => {
        existing.building = null;
      });
    }
    return existing;
  }
  const created = {
    entries: [],
    builtAt: 0,
    building: null,
    rules: { ...DEFAULT_RULES },
    configCheckedAt: 0
  };
  created.building = buildEntries(cwd, created.rules).then((entries) => {
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
async function revalidateRules(cwd) {
  const index = indexFor(cwd);
  if (Date.now() - index.configCheckedAt < CONFIG_TTL_MS) return index;
  index.configCheckedAt = Date.now();
  const loaded = await readRules(cwd);
  if (rulesKey(loaded.rules) === rulesKey(index.rules)) return index;
  const rules = loaded.rules;
  const replacement = {
    entries: [],
    builtAt: 0,
    building: null,
    rules,
    configCheckedAt: index.configCheckedAt
  };
  replacement.building = buildEntries(cwd, rules).then((entries) => {
    replacement.entries = entries;
    replacement.builtAt = Date.now();
    return entries;
  }).finally(() => {
    replacement.building = null;
  });
  indexes.set(cwd, replacement);
  return replacement;
}
function queryIndex(entries, query, maxMatches) {
  const prepared = prepareQuery(query);
  if (prepared.pieces.length === 0) return { matches: [], truncated: false };
  let longestPiece = 1;
  for (const piece of prepared.pieces) {
    if (piece.text.length > longestPiece) longestPiece = piece.text.length;
  }
  let longestPath = 1;
  for (const entry of entries) {
    if (entry.pathLower.length > longestPath) longestPath = entry.pathLower.length;
  }
  const scratch = createMatchScratch(longestPiece, longestPath);
  const scored = [];
  for (const entry of entries) {
    const nameLower = entry.nameLower;
    const name2 = entry.path.slice(entry.path.length - nameLower.length);
    const scoredEntry = scoreEntry(prepared, name2, nameLower, entry.path, entry.pathLower, scratch);
    if (scoredEntry === void 0) continue;
    scored.push({
      score: scoredEntry.score,
      compactness: scoredEntry.compactness,
      row: {
        path: entry.path,
        isDir: entry.isDir,
        ...entry.absolute === true ? { absolute: true } : {},
        ...entry.rootLabel !== void 0 ? { rootLabel: entry.rootLabel } : {},
        ...scoredEntry.nameSpans.length > 0 ? { nameSpans: scoredEntry.nameSpans } : {},
        ...scoredEntry.dirSpans.length > 0 ? { dirSpans: scoredEntry.dirSpans } : {}
      }
    });
  }
  scored.sort((a, b) => b.score - a.score || a.compactness - b.compactness || a.row.path.length - b.row.path.length);
  const truncated = scored.length > maxMatches;
  return { matches: scored.slice(0, maxMatches).map((item) => item.row), truncated };
}
function listChildren(entries, rawPrefix, maxResults) {
  const prefix = rawPrefix.replace(/^\/+|\/+$/gu, "");
  const head = prefix === "" ? "" : `${prefix}/`;
  const byPath = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (head !== "" && !entry.path.startsWith(head)) continue;
    const rest = entry.path.slice(head.length);
    if (rest === "") continue;
    if (rest.includes("/")) continue;
    byPath.set(entry.path, entry);
  }
  const children = [...byPath.values()];
  children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const an = a.path.slice(a.path.length - a.nameLower.length);
    const bn = b.path.slice(b.path.length - b.nameLower.length);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const truncated = children.length > maxResults;
  const matches = children.slice(0, maxResults).map((entry) => ({
    path: entry.path,
    isDir: entry.isDir,
    ...entry.absolute === true ? { absolute: true } : {},
    ...entry.rootLabel !== void 0 ? { rootLabel: entry.rootLabel } : {}
  }));
  return { matches, truncated };
}
var MAX_MATCHES = 200;
async function writeConfigAtomically(cwd, rules) {
  const target = configPathFor(cwd);
  const dir = join2(cwd, CONFIG_DIRNAME);
  const temp = join2(dir, `.${CONFIG_FILENAME}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, serializeRules(rules), "utf8");
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError("write-failed", `cannot write ${CONFIG_DIRNAME}/${CONFIG_FILENAME}: ${message}`, 500);
  }
  return target;
}
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
        const payload = await readJsonBody(req);
        const cwd = sessionCwdOf(ctx.sessions, payload);
        if (method === "search") {
          const query = requireString(payload, "query");
          const index = await revalidateRules(cwd);
          const entries = index.builtAt === 0 && index.building !== null ? await index.building : index.entries;
          const outcome = {
            ...queryIndex(entries, query, MAX_MATCHES),
            indexedEntries: entries.length,
            indexAge: Date.now() - index.builtAt,
            indexTruncated: entries.length >= MAX_VISITED
          };
          writeOk(res, { cwd, ...outcome });
          return;
        }
        if (method === "children") {
          const prefix = requireString(payload, "prefix");
          const index = await revalidateRules(cwd);
          const entries = index.builtAt === 0 && index.building !== null ? await index.building : index.entries;
          const outcome = {
            ...listChildren(entries, prefix, MAX_MATCHES),
            indexedEntries: entries.length,
            indexAge: Date.now() - index.builtAt,
            indexTruncated: entries.length >= MAX_VISITED
          };
          writeOk(res, { cwd, ...outcome });
          return;
        }
        if (method === "config.get") {
          const index = await revalidateRules(cwd);
          const loaded = await readRules(cwd);
          writeOk(res, {
            cwd,
            configPath: loaded.path,
            configExists: loaded.exists,
            rules: index.rules,
            defaults: DEFAULT_RULES,
            indexedEntries: index.entries.length
          });
          return;
        }
        if (method === "config.set") {
          const rules = parseRules(payload.rules);
          const target = await writeConfigAtomically(cwd, rules);
          await unlink(legacyConfigPathFor(cwd)).catch(() => {
          });
          const previous = indexes.get(cwd);
          if (previous !== void 0) {
            previous.configCheckedAt = 0;
            previous.rules = rules;
            previous.builtAt = 0;
            previous.entries = [];
            previous.building = buildEntries(cwd, rules).then((entries) => {
              previous.entries = entries;
              previous.builtAt = Date.now();
              return entries;
            }).finally(() => {
              previous.building = null;
            });
          }
          ctx.logger.warn("[dsh-quick-open] index rules updated for {0}", cwd);
          writeOk(res, { cwd, configPath: target, rules });
          return;
        }
        if (method === "config.reset") {
          await unlink(configPathFor(cwd)).catch(() => {
          });
          await unlink(legacyConfigPathFor(cwd)).catch(() => {
          });
          indexes.delete(cwd);
          writeOk(res, { cwd, rules: DEFAULT_RULES });
          return;
        }
        if (method === "probe") {
          const target = requireString(payload, "path");
          const absolute = isAbsolute2(target) ? target : join2(cwd, target);
          try {
            const info = await stat(absolute);
            writeOk(res, { isDir: info.isDirectory() });
          } catch {
            writeOk(res, { isDir: false });
          }
          return;
        }
        throw new ApiError("not-found", `unknown quick-open API method "${String(method)}"`, 404);
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

/**
 * Workspace index rules: which directories and files the walk may enter, and
 * which entries the index keeps.
 *
 * Why this exists: the first cut shipped a hardcoded SKIP_DIRS blacklist and
 * indexed everything else, which wastes the whole budget on generated noise.
 * On a large C++ repo, most of the tree turned out to be shader build
 * products, install copies and object files, while the ONE generated tree the
 * source actually includes was excluded wholesale because its parent
 * directory happened to be named `build`.
 *
 * So the model is now per-workspace and layered:
 *
 * 1. `excludeDirs` — subtrees the walk never descends, matched against the
 *    root-relative directory path.
 * 2. `includeDirs` — subtrees re-admitted even when an ancestor exclusion
 *    would have dropped them (the generated-headers escape hatch).
 * 3. Entry filter — `includeExtensions` / `includeFilenames` decide which
 *    FILES become entries. Directories are governed by `includeDirectories`.
 * 4. `extraRoots` — absolute directories outside the workspace, indexed too.
 *
 * A file passes the entry filter when its lowercase extension is listed, OR
 * its full lowercase basename is listed in `includeFilenames` (for
 * extension-less-but-meaningful names like `CMakeLists.txt`). An EMPTY
 * `includeExtensions` means "no extension filtering" — index every file the
 * walk reaches, which is how a workspace opts back into the old behaviour.
 *
 * DEFAULT_RULES is deliberately LANGUAGE- AND PROJECT-NEUTRAL: only the noise
 * directories that every ecosystem agrees on, plus source/config extensions
 * common across languages. A specific repository's quirks (a bespoke build
 * layout, generated header trees, sibling repositories) belong in that
 * repository's own config file, never in the shipped defaults.
 */
import { isAbsolute, join } from 'node:path'

/**
 * Per-workspace config file, inside the workspace's own `.dsh` directory:
 * `<workspace>/.dsh/quick-open.json`.
 *
 * It lives under `.dsh` rather than at the repository root so the plugin's
 * bookkeeping stays in one namespaced folder instead of scattering dotfiles
 * through a project the plugin does not own.
 */
export const CONFIG_DIRNAME = '.dsh'
export const CONFIG_FILENAME = 'quick-open.json'

/**
 * Legacy config location from an earlier version, read as a fallback when the
 * `.dsh` file is absent so an existing setup keeps working.
 */
export const LEGACY_CONFIG_FILENAME = '.dsh-quick-open.json'

/** The absolute path of a workspace's config file. */
export function configPathFor(cwd: string): string {
  return join(cwd, CONFIG_DIRNAME, CONFIG_FILENAME)
}

/** The absolute path of a workspace's legacy (pre-`.dsh`) config file. */
export function legacyConfigPathFor(cwd: string): string {
  return join(cwd, LEGACY_CONFIG_FILENAME)
}

/** Schema version of the config file; unknown/newer versions fall back to defaults. */
export const CONFIG_VERSION = 1

export interface IndexRules {
  /** Workspace-relative directory paths (or globs) the walk never descends. */
  excludeDirs: string[]
  /** Workspace-relative directory paths (or globs) re-admitted under an excluded ancestor. */
  includeDirs: string[]
  /**
   * Lowercase file extensions including the dot, e.g. `.cpp`. An EMPTY array
   * disables extension filtering entirely (every file is indexed).
   */
  includeExtensions: string[]
  /** Lowercase full basenames indexed regardless of their extension. */
  includeFilenames: string[]
  /** Whether directory entries themselves are indexed (needed for `@dir/` references). */
  includeDirectories: boolean
  /**
   * ABSOLUTE directories OUTSIDE the workspace, indexed alongside it. The
   * Chaos engine and the proven_ground game are sibling repositories, not
   * nested ones, so engine work constantly needs to look up game-side code —
   * a single-root walk cannot express that.
   *
   * Each extra root is walked with the SAME directory/file rules as the
   * workspace root, and its entries carry an absolute `path` so the client
   * can resolve and reference them without a cwd to join against.
   */
  extraRoots: ExtraRoot[]
}

/** One directory outside the workspace that is indexed alongside it. */
export interface ExtraRoot {
  /** Absolute directory path. */
  path: string
  /**
   * Label shown in the result row instead of the long absolute path. Defaults
   * to the directory's basename when absent.
   */
  label?: string
}

/**
 * Built-in defaults: deliberately LANGUAGE- AND PROJECT-NEUTRAL.
 *
 * Only the noise directories every ecosystem agrees on, plus source/config
 * extensions shared across mainstream languages. Nothing here is specific to
 * one company's repository layout — a project whose build tree, generated
 * headers or sibling repositories need special handling expresses that in its
 * OWN config file, which is the whole point of making the rules per-workspace.
 *
 * The shape is EXCLUSION-based (everything the walk reaches is indexed unless
 * a rule drops it) because the alternative — whitelisting only the handful of
 * directories a developer uses — silently hides every directory added later.
 */
export const DEFAULT_RULES: IndexRules = {
  excludeDirs: [
    // Version control metadata.
    '.git', '.hg', '.svn',
    // Dependency and package-manager trees.
    'node_modules', 'bower_components', 'vendor',
    '.venv', 'venv', 'env', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
    '.pnpm-store', '.yarn', '.npm', '.cargo', '.gradle', '.m2',
    'Pods', 'Carthage',
    // Build output and caches.
    'dist', 'build', 'out', 'target', 'bin', 'obj',
    '.cache', '.parcel-cache', '.turbo', '.turbopack', '.nx', '.svelte-kit',
    '.next', '.nuxt', '.output', '.umi', '.umi-production', '.dumi', '.angular',
    'coverage', '.nyc_output',
    // Editor / IDE state.
    '.idea', '.vs',
  ],
  includeDirs: [],
  includeExtensions: [
    // C / C++.
    '.h', '.hpp', '.hh', '.hxx', '.inl', '.ipp', '.tpp',
    '.c', '.cc', '.cpp', '.cxx', '.m', '.mm',
    // JVM / .NET / Go / Rust.
    '.java', '.kt', '.kts', '.scala', '.cs', '.go', '.rs',
    // Scripting.
    '.py', '.rb', '.php', '.pl', '.lua', '.tcl', '.r',
    // Web.
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.css', '.scss', '.sass', '.less', '.html', '.htm', '.svg',
    // Shell.
    '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1',
    // Data / config.
    '.json', '.jsonc', '.json5', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
    '.xml', '.csv', '.tsv', '.env', '.properties',
    // Databases / schemas / API.
    '.sql', '.proto', '.graphql', '.gql', '.thrift', '.avsc',
    // Shaders.
    '.glsl', '.hlsl', '.vert', '.frag', '.comp', '.wgsl', '.metal',
    // Docs and markup.
    '.md', '.markdown', '.rst', '.adoc', '.txt', '.tex',
    // Build systems and templates.
    '.cmake', '.gradle', '.mk', '.mak', '.tpl', '.tmpl', '.hbs', '.ejs', '.jinja', '.j2',
  ],
  includeFilenames: [
    // Extensionless or dot-file names that carry real meaning across projects.
    'cmakelists.txt',
    'makefile',
    'gnumakefile',
    'dockerfile',
    'containerfile',
    'vagrantfile',
    'jenkinsfile',
    'procfile',
    'brewfile',
    'rakefile',
    'gemfile',
    'podfile',
    '.gitignore',
    '.gitattributes',
    '.gitmodules',
    '.dockerignore',
    '.editorconfig',
    '.env',
    '.env.example',
    '.clang-format',
    '.clang-tidy',
    '.eslintrc',
    '.prettierrc',
    '.babelrc',
    '.npmrc',
    '.nvmrc',
    '.python-version',
    '.ruby-version',
  ],
  includeDirectories: true,
  // Empty by default: an extra root is opt-in per workspace, since it widens
  // the search beyond the workspace boundary.
  extraRoots: [],
}

// ── directory matching ──────────────────────────────────────────────────────

/** Normalize a workspace-relative directory path to '/'-separated, no leading or trailing slash. */
export function normalizeDirPath(path: string): string {
  return path.split('\\').join('/').replace(/^\/+|\/+$/g, '')
}

/**
 * Compile one directory pattern to a matcher. Supports the two forms a
 * workspace config realistically needs:
 *
 * Three pattern forms, all covering the whole subtree beneath a match:
 *
 * - `name`     — that directory name at ANY depth. A bare name is how every
 *                ecosystem thinks about noise (`node_modules`, `dist`,
 *                `__pycache__`): they nest, and only excluding the copy at
 *                the workspace root would silently index every nested one.
 * - `a/b`      — that exact path, and its subtree. Path patterns stay
 *                root-anchored: `build/go` must not match `x/build/go`, and
 *                must never touch `build/golang`.
 * - `**\/a/b`  — that path at any depth.
 *
 * Matching is NOT a bare prefix match at the segment level: excluding
 * `build/go` never touches `build/golang`.
 */
function compileDirPattern(pattern: string): (dir: string) => boolean {
  const normalized = normalizeDirPath(pattern)
  if (normalized === '') return () => false
  /** `dir` is the pattern path itself, or something nested inside it. */
  const covers = (dir: string, base: string): boolean =>
    dir === base || dir.startsWith(`${base}/`)
  /** The pattern appears at `dir`'s tail, on a segment boundary. */
  const tailMatches = (dir: string, base: string): boolean => {
    if (covers(dir, base)) return true
    return dir.endsWith(`/${base}`) || dir.includes(`/${base}/`)
  }

  const doubleStar = normalized.indexOf('**/')
  if (doubleStar !== -1) {
    const suffix = normalized.slice(doubleStar + 3)
    if (suffix === '') return () => true
    return dir => tailMatches(dir, suffix)
  }
  // A bare name (no slash) matches at any depth; a path pattern is anchored.
  if (!normalized.includes('/')) {
    return dir => tailMatches(dir, normalized)
  }
  return dir => covers(dir, normalized)
}

/** A compiled set of directory patterns, queried per walked directory. */
export interface DirMatchers {
  exclude: (dir: string) => boolean
  include: (dir: string) => boolean
}

export function compileDirMatchers(rules: IndexRules): DirMatchers {
  const excludeFns = rules.excludeDirs.map(compileDirPattern)
  const includeFns = rules.includeDirs.map(compileDirPattern)
  return {
    exclude: dir => excludeFns.some(fn => fn(dir)),
    include: dir => includeFns.some(fn => fn(dir)),
  }
}

/** How the walk must treat one directory it just found. */
export type DirVerdict =
  /** Not indexed, not descended. */
  | 'skip'
  /** Indexed, and descended only when it is a real directory (not a symlink). */
  | 'enter'
  /** Indexed, and descended even through a symbolic link. */
  | 'enter-follow-link'

/**
 * Classify a directory the walk reached (workspace-relative, normalized).
 *
 * `includeDirs` wins over `excludeDirs`, which is the whole point:
 * `build/p/include` (and everything below it) stays reachable even though
 * `build/*` is otherwise excluded.
 *
 * Symbolic links are normally NOT descended (a link can point back up the
 * tree), but an EXPLICIT `includeDirs` entry overrides that too — that is the
 * only way to index a deliberately linked directory such as a `.skills`
 * junction. A link that resolves inside an already-visited path is still
 * dropped by the caller's cycle guard.
 */
export function classifyDirectory(matchers: DirMatchers, dir: string, isSymbolicLink: boolean): DirVerdict {
  const included = matchers.include(dir)
  if (!included && matchers.exclude(dir)) return 'skip'
  if (isSymbolicLink) return included ? 'enter-follow-link' : 'skip'
  return 'enter'
}

// ── entry matching ──────────────────────────────────────────────────────────

/** Lowercase extension including the dot, or '' when the name has none. */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  // A leading dot alone ('.gitignore') is a name, not an extension.
  if (at <= 0) return ''
  return name.slice(at).toLowerCase()
}

/**
 * Whether a FILE becomes an index entry. Extension list decides first; the
 * filename list catches names the extension rule would drop.
 */
export function matchesFileRules(rules: IndexRules, name: string): boolean {
  const lower = name.toLowerCase()
  if (rules.includeFilenames.includes(lower)) return true
  if (rules.includeExtensions.length === 0) return true
  return rules.includeExtensions.includes(extensionOf(name))
}

// ── config parsing ──────────────────────────────────────────────────────────

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

/** Normalize an extension list entry to a lowercase leading-dot form. */
function normalizeExtension(value: string): string {
  const lower = value.trim().toLowerCase()
  if (lower === '') return ''
  return lower.startsWith('.') ? lower : `.${lower}`
}

/**
 * Parse the extra-root list. A bare string is accepted as shorthand for
 * `{ path }`, and a relative path is REJECTED: an extra root is resolved
 * against the filesystem, not against the workspace, so a relative entry
 * would silently depend on the process cwd.
 */
function readExtraRoots(value: unknown): ExtraRoot[] {
  if (!Array.isArray(value)) return []
  const out: ExtraRoot[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const path = item.trim()
      if (path !== '' && isAbsolute(path)) out.push({ path })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (path === '' || !isAbsolute(path)) continue
    const label = typeof entry.label === 'string' && entry.label.trim() !== ''
      ? entry.label.trim()
      : undefined
    out.push(label === undefined ? { path } : { path, label })
  }
  return out
}

/**
 * Parse an untrusted config object into rules. Every field is optional and
 * falls back to its default, so a partial or slightly-wrong file still works
 * instead of silently indexing nothing.
 *
 * `includeExtensions` is the one field where an explicit empty array is
 * meaningful (it means "no filtering"), so it is distinguished from absent.
 */
export function parseRules(raw: unknown): IndexRules {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_RULES }
  const source = raw as Record<string, unknown>
  const hasExtensions = Array.isArray(source.includeExtensions)
  const extensions = hasExtensions
    ? readStringArray(source.includeExtensions, []).map(normalizeExtension).filter(x => x !== '')
    : DEFAULT_RULES.includeExtensions
  return {
    excludeDirs: readStringArray(source.excludeDirs, DEFAULT_RULES.excludeDirs).map(normalizeDirPath),
    includeDirs: readStringArray(source.includeDirs, DEFAULT_RULES.includeDirs).map(normalizeDirPath),
    includeExtensions: extensions,
    includeFilenames: readStringArray(source.includeFilenames, DEFAULT_RULES.includeFilenames)
      .map(name => name.toLowerCase()),
    includeDirectories: typeof source.includeDirectories === 'boolean'
      ? source.includeDirectories
      : DEFAULT_RULES.includeDirectories,
    // An explicit list replaces the default entirely; extra roots are opt-in,
    // so an absent field simply means "none".
    extraRoots: readExtraRoots(source.extraRoots),
  }
}

/** The serialized shape written back to disk (stable key order, schema version first). */
export function serializeRules(rules: IndexRules): string {
  return `${JSON.stringify({ version: CONFIG_VERSION, ...rules }, null, 2)}\n`
}

/**
 * The plugin's copy, in one place, in both languages.
 *
 * Every user-visible string lives here rather than inline at its use site.
 * Three reasons, in order of how much they matter:
 *
 * 1. **A language is reviewable as a unit.** A translator — or a maintainer
 *    checking the English reads naturally rather than as translated Chinese —
 *    reads one table instead of hunting through JSX.
 * 2. **Missing keys are a type error, not a silent English leak.** The `zh`
 *    table is annotated `Messages`, so a key added to `en` and forgotten here
 *    fails `tsc` instead of shipping.
 * 3. **Language resolution is one decision.** `document.documentElement.lang`
 *    is what the DSH shell already sets from the user's locale preference, so
 *    reading it per call means a language switch needs no reload and no
 *    service injection.
 *
 * ## Why not `ctx.locale`?
 *
 * DSH ships a locale service (`register(ns, {zh, en})` + `bind(ns)`) and this
 * plugin could register into it. It is not used here because the two halves of
 * this plugin disagree about when they exist: the preview augmentations mount
 * a React root OUTSIDE the slot tree (see `preview/index.ts` for why), and the
 * controller reads copy from plain async callbacks that hold no context. Both
 * would need a context threaded through to them, and a missing context would
 * mean falling back to English anyway. Reading `documentElement.lang` gives the
 * same observable behaviour — correct language, live switching — with no
 * plumbing and no failure mode where the panel is Chinese but the palette is
 * not.
 *
 * The cost is that a client plugin cannot ADD a language here; adding one means
 * adding a table below. That is an acceptable trade for a two-language plugin,
 * and it keeps the whole surface testable from the existing stub.
 */

/** Which language a surface should render in. */
export type Locale = 'en' | 'zh'

/** Every message key the plugin can render. */
export interface Messages {
  // ── the palette (quick-open.tsx) ──────────────────────────────────────────
  /** Footer hint, empty query, nothing typed yet. */
  paletteIdle: string
  /** Footer hint when the drilled-into directory has no children. */
  paletteEmptyDir: string
  /** Footer hint while a query is in flight. */
  paletteSearching: string
  /** Footer hint when a query matched nothing. */
  paletteNoMatches: string
  /** Section header above the recently-opened list. */
  paletteRecents: string
  /** Section header naming the workspace root while browsing. */
  paletteWorkspaceRoot: string
  /** Row affordance: put this file in the draft without closing. */
  paletteReference: string
  /** Row affordance title (tooltip). */
  paletteReferenceTitle: string
  /** Search input aria-label. */
  paletteInputLabel: string
  /** Search input placeholder, naming the token prefixes. */
  palettePlaceholder: string
  /** Prefix on a failed search. */
  paletteError: string
  /** Key-hint: arrow keys move the selection. */
  hintNavigate: string
  /** Key-hint: Tab completes into the highlighted directory. */
  hintComplete: string
  /** Key-hint: Enter opens the file. */
  hintOpen: string
  /** Key-hint: a `:N` suffix jumps to a line. */
  hintLine: string
  /** Key-hint: the reference gesture. `{keys}` is the bound combination. */
  hintReference: string
  /** Key-hint: the palette toggle. `{keys}` is the bound combination. */
  hintToggle: string
  /** Key-hint: `dir:` scopes to a directory. */
  hintDirScope: string
  /** Key-hint: `file:` scopes to a filename. */
  hintFileScope: string
  /** Key-hint: Esc closes. */
  hintClose: string
  /** Warning that the result list was capped. */
  hintTruncated: string

  // ── controller notices ────────────────────────────────────────────────────
  /** Index transparency line. `{count}` entries, `{age}` seconds ago. */
  indexInfo: string
  /** Notice after drilling into a directory. `{prefix}` is the path. */
  enteredDir: string
  /** Notice when Enter lands on a directory instead of a file. */
  dirNeedsReference: string
  /** Notice when the right Sidebar is not mounted yet. */
  sidebarUnavailable: string
  /** Notice when a file open failed for an unclassified reason. */
  openFailed: string
  /** Notice when a path contains characters the mention grammar rejects. */
  unquotablePath: string
  /** Notice when the conversation service is missing. */
  noConversation: string

  // ── settings panel (settings.tsx) ─────────────────────────────────────────
  /** Section label in the settings sidebar. */
  settingsSection: string
  /** Status after saving the rules file. */
  settingsSaved: string
  /** Status after deleting the rules file. */
  settingsReset: string
  /** Heading for the selection-reference format field. */
  viewerLabel: string
  /** Option: bare location. */
  viewerOptionPath: string
  /** Option: location plus a read instruction. */
  viewerOptionHint: string
  /** Option: location plus the selected text. */
  viewerOptionContent: string
  /** Explanatory copy under the format select. */
  viewerHint: string
  /** Heading for the shortcut recorder. */
  shortcutLabel: string
  /** Button label while recording a new combination. */
  shortcutRecording: string
  /** Button label restoring an action's default combination. */
  shortcutRestore: string
  /** Explanatory copy under the shortcut recorder. */
  shortcutHint: string
  /** Banner shown when no session is active. */
  noWorkspaceTitle: string
  /** Banner body explaining the rules are per workspace. */
  noWorkspaceBody: string
  /** Heading naming the workspace being edited. */
  currentWorkspace: string
  /** Label before the rules file path. */
  configFile: string
  /** Suffix when the rules file exists. */
  configExists: string
  /** Suffix when the rules file is absent. */
  configMissing: string
  /** Indexed-entry count. `{count}` is formatted. */
  indexedEntries: string
  /** Field label for `excludeDirs`. */
  excludeDirsLabel: string
  /** Field hint for `excludeDirs`. */
  excludeDirsHint: string
  /** Field label for `includeDirs`. */
  includeDirsLabel: string
  /** Field hint for `includeDirs`. */
  includeDirsHint: string
  /** Field label for `includeExtensions`. */
  includeExtensionsLabel: string
  /** Field hint for `includeExtensions`. */
  includeExtensionsHint: string
  /** Field label for `includeFilenames`. */
  includeFilenamesLabel: string
  /** Field hint for `includeFilenames`. */
  includeFilenamesHint: string
  /** Checkbox label for indexing directory entries. */
  includeDirectoriesLabel: string
  /** Field label for `extraRoots`. */
  extraRootsLabel: string
  /** Field hint for `extraRoots`. */
  extraRootsHint: string
  /** Primary action: write the rules file. */
  save: string
  /** Primary action while saving. */
  saving: string
  /** Secondary action: restore built-in defaults. */
  reset: string
  /** Secondary action: re-read from disk. */
  reload: string

  // ── shortcut recorder validation ──────────────────────────────────────────
  /** Settings label: the palette toggle action. */
  shortcutActionOpen: string
  /** Settings label: the in-preview find action. */
  shortcutActionFind: string
  /** Settings label: the reference-into-draft action. */
  shortcutActionReference: string
  /** When the palette toggle applies. */
  shortcutHintOpen: string
  /** When the in-preview find applies. */
  shortcutHintFind: string
  /** When the reference-into-draft gesture applies. */
  shortcutHintReference: string
  /** Rejection: a bare key would swallow that key app-wide. */
  shortcutNeedsModifier: string
  /** Rejection: no main key recorded. */
  shortcutNeedsKey: string
  /** Recorder prompt while waiting for a combination. */
  shortcutPressKeys: string
  /** Recorder rejection when only modifiers were pressed. */
  shortcutModifierOnly: string

  // ── selection reference (preview/selection.ts) ────────────────────────────
  /** Instruction appended by the `path-hint` format. `{span}` names the lines. */
  selectionReadHint: string
  /** Line span wording. `{start}`/`{end}` are line numbers. */
  selectionLineSpan: string
  /** Single-line variant of the span wording. `{line}` is the line number. */
  selectionSingleLine: string
  /** Appended when the quoted span is long enough to read partially. */
  selectionSpanLong: string

  // ── preview augmentations (preview/locales.ts re-exports these) ───────────
  /** Notice when the conversation service is missing (preview surface). */
  previewNoConversation: string
  /** Confirmation after adding a selection. */
  previewAdded: string
  /** Popup action: add the selection to the conversation. */
  previewAddSelection: string
  /** Find bar placeholder. */
  previewFindPlaceholder: string
  /** Find bar: previous match. */
  previewFindPrevious: string
  /** Find bar: next match. */
  previewFindNext: string
  /** Find bar: close. */
  previewFindClose: string
  /** Find bar: case sensitivity toggle. */
  previewFindCaseSensitive: string
  /** Find bar: no matches. */
  previewNoResults: string
  /** Find bar: partial-coverage badge. */
  previewPartialCoverage: string
  /** Find bar: partial-coverage explanation. */
  previewPartialCoverageHint: string
}

const en: Messages = {
  paletteIdle: 'Type to search files in this workspace',
  paletteEmptyDir: 'This directory is empty',
  paletteSearching: 'Searching…',
  paletteNoMatches: 'No matching files',
  paletteRecents: 'Recently used',
  paletteWorkspaceRoot: 'Workspace root',
  paletteReference: '+ Reference',
  paletteReferenceTitle: 'Add to conversation (Ctrl+Enter)',
  paletteInputLabel: 'Quick open file',
  palettePlaceholder: 'Fuzzy-match file names; space separates terms, dir: scopes to a directory (e.g. dir:ui index.html)',
  paletteError: 'Search failed: ',
  hintNavigate: '↑↓ navigate',
  hintComplete: 'Tab complete path',
  hintOpen: 'Enter open',
  hintLine: ':line jump',
  hintReference: '{keys} add to conversation (keeps panel open)',
  hintToggle: '{keys} toggle',
  hintDirScope: 'dir: scope to directory',
  hintFileScope: 'file: scope to filename',
  hintClose: 'Esc close',
  hintTruncated: 'Results truncated — refine your query',

  indexInfo: 'Indexed {count} entries · {age}s ago',
  enteredDir: 'Entered {prefix}/',
  dirNeedsReference: 'This is a directory: Ctrl+Enter references it as @dir/',
  sidebarUnavailable: 'The sidebar service is not ready, so the file cannot be opened yet',
  openFailed: 'Could not open this file',
  unquotablePath: 'The path contains characters that cannot be referenced',
  noConversation: 'The conversation service is unavailable',

  settingsSection: 'Quick Open index',
  settingsSaved: 'Saved — rebuilding the index with the new rules…',
  settingsReset: 'Config file deleted; built-in default rules restored.',
  viewerLabel: 'File viewer: format for adding selected text to the conversation',
  viewerOptionPath: 'Location only: @path/file.cpp:12-15',
  viewerOptionHint: 'Location + tell the model to read that span',
  viewerOptionContent: 'Location + fenced code block (carries the selected text)',
  viewerHint:
    'What gets inserted when you select text in a sidebar file and click "Add to conversation". '
    + 'Location only is cheapest — the model reads what it needs; '
    + 'Location + hint adds one sentence asking it to read that span, which reduces cases where it ignores the line numbers; '
    + 'the fenced block carries the text itself, at the cost of repeating it every turn.',
  shortcutLabel: 'Shortcuts',
  shortcutRecording: 'Press a new combination… (Esc cancels)',
  shortcutRestore: 'Restore default',
  shortcutHint:
    'Click a button, then press the new combination (a modifier is required; Enter may also be the main key on its own). '
    + '{modifier} is the primary modifier on {platform} — the same configuration is interpreted as Ctrl on Windows and Cmd on macOS, '
    + 'so habits carry across platforms.',
  noWorkspaceTitle: 'No active session, so there is no workspace to edit.',
  noWorkspaceBody:
    'Index rules are stored per workspace (.dsh/quick-open.json sits at the workspace root). '
    + 'Open a session first, then come back to this panel.',
  currentWorkspace: 'Current workspace',
  configFile: 'Config file: ',
  configExists: ' (exists)',
  configMissing: ' (absent — built-in defaults are in use)',
  indexedEntries: 'Indexed {count} entries',
  excludeDirsLabel: 'Excluded directories — excludeDirs',
  excludeDirsHint:
    'One per line, relative to the workspace root. build/go matches that directory only; '
    + '**/shaders/d3d11 matches a directory of that name at any depth. '
    + 'An excluded directory is never descended into, so its whole subtree is skipped.',
  includeDirsLabel: 'Force-included directories — includeDirs',
  includeDirsHint:
    'Takes precedence over excluded directories. Use it to rescue a generated tree that a parent exclude '
    + 'swept up but that is genuinely needed, such as build/p/include (generated headers the sources include).',
  includeExtensionsLabel: 'Included extensions — includeExtensions',
  includeExtensionsHint:
    'One per line, with the dot, e.g. .cpp. Only files with these extensions are indexed. '
    + 'Leave empty to filter by no extension at all (every file the walk reaches).',
  includeFilenamesLabel: 'Included file names — includeFilenames',
  includeFilenamesHint:
    'One complete file name per line (case-insensitive), exempt from extension filtering. '
    + 'For names worth keeping such as CMakeLists.txt.',
  includeDirectoriesLabel: 'Index directory entries (off means @dir/ cannot be referenced in the palette)',
  extraRootsLabel: 'Extra index roots — extraRoots',
  extraRootsHint:
    'One absolute directory path per line; append | alias to set the prefix shown on result rows. '
    + 'For indexing directories OUTSIDE the workspace — for example an engine repository and a game repository '
    + 'sitting side by side, which you need to cross-check while working. These are walked with the same '
    + 'directory/extension rules as the workspace, and their rows show the full absolute path.',
  save: 'Save to workspace',
  saving: 'Saving…',
  reset: 'Restore defaults',
  reload: 'Re-read from disk',

  shortcutActionOpen: 'Open the quick-open palette',
  shortcutActionFind: 'Search within the file preview',
  shortcutActionReference: 'Add the highlighted file to the conversation (from the palette)',
  shortcutHintOpen: 'Works on any session page; press again to close.',
  shortcutHintFind: 'Applies while the sidebar file preview has focus; opens the floating find bar.',
  shortcutHintReference: 'Applies while the palette is open: hold the modifier and press Enter to drop the file into the draft as a reference, leaving the palette open.',
  shortcutNeedsModifier: 'At least one modifier is required (Ctrl / Cmd / Shift / Alt)',
  shortcutNeedsKey: 'Missing main key',
  shortcutPressKeys: 'Press a letter, digit or symbol key (modifiers alone are not enough)',
  shortcutModifierOnly: 'At least one modifier is required (Ctrl / Cmd / Shift / Alt)',

  selectionReadHint: 'please read this span of the file with the read tool',
  selectionLineSpan: 'lines {start}-{end}',
  selectionSingleLine: 'line {line}',
  selectionSpanLong: 'The span is long; reading only the relevant part is fine.',

  previewNoConversation: 'The conversation service is unavailable.',
  previewAdded: 'Added to conversation',
  previewAddSelection: 'Add to conversation',
  previewFindPlaceholder: 'Find in file',
  previewFindPrevious: 'Previous match (Shift+Enter)',
  previewFindNext: 'Next match (Enter)',
  previewFindClose: 'Close (Esc)',
  previewFindCaseSensitive: 'Match case',
  previewNoResults: 'No results',
  previewPartialCoverage: 'loaded part',
  previewPartialCoverageHint: 'The file has pages not yet loaded; only the loaded part was searched.',
}

/**
 * The Chinese table.
 *
 * Typed as `Messages`, so adding a key to `en` without adding it here is a
 * compile error — which is the whole point of centralising the copy.
 */
const zh: Messages = {
  paletteIdle: '输入以搜索当前工作区的文件',
  paletteEmptyDir: '该目录为空',
  paletteSearching: '搜索中…',
  paletteNoMatches: '无匹配文件',
  paletteRecents: '最近使用',
  paletteWorkspaceRoot: '工作区根目录',
  paletteReference: '+ 引用',
  paletteReferenceTitle: '加入对话（Ctrl+Enter）',
  paletteInputLabel: '快速打开文件',
  palettePlaceholder: '模糊搜索文件名；空格分词，dir: 前缀限定目录（如 dir:ui index.html）',
  paletteError: '搜索失败：',
  hintNavigate: '↑↓ 导航',
  hintComplete: 'Tab 补全路径',
  hintOpen: 'Enter 打开',
  hintLine: ':行号 跳行',
  hintReference: '{keys} 加入对话（不关闭）',
  hintToggle: '{keys} 开关',
  hintDirScope: 'dir: 限定目录',
  hintFileScope: 'file: 限定文件名',
  hintClose: 'Esc 关闭',
  hintTruncated: '结果已截断，请细化关键词',

  indexInfo: '索引 {count} 项 · {age}s 前',
  enteredDir: '进入 {prefix}/',
  dirNeedsReference: '这是目录：Ctrl+Enter 以 @dir/ 引用',
  sidebarUnavailable: '侧边栏服务未就绪，暂时无法打开文件',
  openFailed: '无法打开这个文件',
  unquotablePath: '路径包含无法引用的字符',
  noConversation: '对话服务不可用',

  settingsSection: 'Quick Open 索引',
  settingsSaved: '已保存，正在按新规则重建索引…',
  settingsReset: '已删除配置文件，恢复内置默认规则。',
  viewerLabel: '文件查看器：选中文本加入会话的格式',
  viewerOptionPath: '仅位置：@path/file.cpp:12-15',
  viewerOptionHint: '位置 + 提示模型去读取该段',
  viewerOptionContent: '位置 + 围栏代码块（带上选中内容）',
  viewerHint:
    '在侧边栏文件里选中文本后点「加入会话」时插入的内容。'
    + '仅位置最省上下文，模型自行读取所需范围；'
    + '位置 + 提示多一句「请用 read 读取该段」，能减少模型忽略行号的情况；'
    + '围栏代码块把选中内容一并带入，代价是每轮都重复这段代码。',
  shortcutLabel: '快捷键',
  shortcutRecording: '按下新的快捷键…（Esc 取消）',
  shortcutRestore: '恢复默认',
  shortcutHint:
    '点按钮再按一次新的组合键即可（必须带修饰键；Enter 也可单独作为主键）。'
    + '{modifier} 是{platform}的主修饰键——同一份配置换到另一个平台会按对方的主修饰键解释，所以跨平台的习惯都能对上。',
  noWorkspaceTitle: '当前没有活跃会话，无法确定要编辑哪个工作区。',
  noWorkspaceBody:
    '索引规则按工作区存放（.dsh/quick-open.json 位于工作区根目录下），请先打开一个会话再回到此面板。',
  currentWorkspace: '当前工作区',
  configFile: '配置文件：',
  configExists: '（已存在）',
  configMissing: '（不存在，当前使用内置默认规则）',
  indexedEntries: '已索引 {count} 项',
  excludeDirsLabel: '排除目录 excludeDirs',
  excludeDirsHint:
    '每行一个，相对工作区根。build/go 只匹配该目录；'
    + '**/shaders/d3d11 匹配任意深度下同名目录。目录被排除后整棵子树都不遍历。',
  includeDirsLabel: '强制包含目录 includeDirs',
  includeDirsHint:
    '优先级高于排除目录。用于救回被父级排除但确实需要的生成树，'
    + '例如 build/p/include（生成的头文件，源码会 include）。',
  includeExtensionsLabel: '包含后缀 includeExtensions',
  includeExtensionsHint:
    '每行一个，带点，如 .cpp。只有这些后缀的文件进索引。'
    + '留空表示不按后缀过滤（索引遍历到的所有文件）。',
  includeFilenamesLabel: '包含文件名 includeFilenames',
  includeFilenamesHint:
    '每行一个完整文件名（不区分大小写），不受后缀过滤限制。用于 CMakeLists.txt 这类需要保留的名字。',
  includeDirectoriesLabel: '索引目录条目（关闭后无法在快速打开面板里引用 @dir/）',
  extraRootsLabel: '额外索引根 extraRoots',
  extraRootsHint:
    '每行一个绝对目录路径，可加 | 别名 指定结果行里显示的前缀。'
    + '用于索引工作区之外的目录——例如引擎仓库与游戏仓库是并列的两个文件夹，开发时需要互查。'
    + '这些目录用与工作区相同的目录/后缀规则遍历，结果行以完整绝对路径显示。',
  save: '保存到工作区',
  saving: '保存中…',
  reset: '恢复默认',
  reload: '重新读取',

  shortcutActionOpen: '呼出快速打开面板',
  shortcutActionFind: '在文件预览里搜索内容',
  shortcutActionReference: '把选中文件加入对话（面板内）',
  shortcutHintOpen: '任意会话页面按下即可呼出；再按一次关闭。',
  shortcutHintFind: '焦点在侧边栏文件预览里时生效，打开浮动查找条。',
  shortcutHintReference: '快速打开面板打开时生效：按住修饰键再回车，把文件作为引用放进草稿，面板不关闭。',
  shortcutNeedsModifier: '至少需要一个修饰键（Ctrl / Cmd / Shift / Alt）',
  shortcutNeedsKey: '缺少主键',
  shortcutPressKeys: '请按一个字母、数字或符号键（不能只按修饰键）',
  shortcutModifierOnly: '至少需要一个修饰键（Ctrl / Cmd / Shift / Alt）',

  selectionReadHint: '请用 read 工具读取该文件的这一段',
  selectionLineSpan: '第 {start}-{end} 行',
  selectionSingleLine: '第 {line} 行',
  selectionSpanLong: '范围较长，可只读取其中相关部分。',

  previewNoConversation: '对话服务不可用。',
  previewAdded: '已加入会话',
  previewAddSelection: '加入会话',
  previewFindPlaceholder: '在文件中查找',
  previewFindPrevious: '上一个匹配（Shift+Enter）',
  previewFindNext: '下一个匹配（Enter）',
  previewFindClose: '关闭（Esc）',
  previewFindCaseSensitive: '区分大小写',
  previewNoResults: '无结果',
  previewPartialCoverage: '仅已加载',
  previewPartialCoverageHint: '文件还有未加载的部分，搜索结果只覆盖已加载的内容。',
}

const TABLES: Record<Locale, Messages> = { en, zh }

/**
 * The active language.
 *
 * Read from `<html lang>`, which the DSH shell sets from the user's locale
 * preference. Read PER CALL rather than captured at module load: the shell can
 * change the attribute without a reload, and a captured value would leave the
 * plugin in the previous language until the page was refreshed.
 *
 * Anything that is not `zh*` resolves to English, so an unexpected or missing
 * `lang` degrades to the language every developer can read.
 */
export function activeLocale(): Locale {
  if (typeof document === 'undefined') return 'en'
  const lang = document.documentElement?.lang ?? ''
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** The message table for the active language. */
export function messages(locale: Locale = activeLocale()): Messages {
  return TABLES[locale] ?? en
}

/**
 * Look up one message, substituting `{name}` placeholders.
 *
 * A placeholder with no matching param is left verbatim rather than blanked:
 * a visible `{count}` in the UI is a bug report, whereas an empty string reads
 * as intentional and hides the omission.
 */
export function t<K extends keyof Messages>(
  key: K,
  params?: Record<string, string | number>,
): string {
  const template = messages()[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    (name in params ? String(params[name]) : match))
}

/** Every key in the English table, for coverage assertions. */
export const MESSAGE_KEYS = Object.keys(en) as (keyof Messages)[]

/** The Chinese table, exported for coverage assertions only. */
export const ZH_TABLE: Readonly<Messages> = zh

/** The English table, exported for coverage assertions only. */
export const EN_TABLE: Readonly<Messages> = en

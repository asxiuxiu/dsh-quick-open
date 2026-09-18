# TODO — dsh-quick-open 预览增强

> 记录时间：架构重构完成后（「增强而不替换」方案落地）。
> 本文件记录**当前架构、已验证的事实、遗留风险**，供下一个会话直接接手。

---

## 架构（本次重构后的形态）

**不再接管任何 tab kind**。内置文档预览（`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`）
保留所有文件地址和全部功能（渲染器切换、代码高亮、分页加载、变更提示、换行、行号跳转）。

插件改为对内置预览做 **DOM 层增强**，代码在 `src/client/preview/`：

| 模块 | 职责 |
|---|---|
| `index.ts` | 单例 React root（挂在 `document.body` 自己的 div 上，**不走 slot**——slot 每会话一份会重复挂载监听器） |
| `Augmentations.tsx` | 搜索条 + 选中浮框 + 通知，全部 portal 到 body，`z-index: 10000` |
| `probe.ts` | 发现内置预览：`[data-textpreview-url]` 根节点、可见性判断、行号推导 |
| `find.ts` | 文件内搜索：TreeWalker 收集文本节点 → `matchSpans`（纯正则匹配）→ CSS Custom Highlight API 画高亮（**不改 React 托管的 DOM**） |
| `selection.ts` | 引用文本构造 + 写草稿（`lines` 现在可选，无行号的渲染器退化为裸 `@path`） |
| `address.ts` | `dsh-resource://file/session/...` 地址解析 |

## 关键事实（已核实，不要重新推导）

- **Ctrl+P 浮层必须 portal 到 `document.body`**。它挂在 `conversation.input.overlay` slot 里，
  该 slot 在 composer card（`position:relative`）内部；任何祖先建立 containing block /
  stacking context（transform、paint containment、裁剪的滚动容器）都会把 fixed 浮层困在
  会话列里，z-index 10000 也救不了。portal 到 body 后只在根层级竞争，而全应用最大
  z-index 只有 1100（dialog/toast）。侧边栏自己的 Floats 层就是同样做法。
- **hover 色调 token（`--dsw-alias-interactive-bg-hover`）是半透明的**，直接当 background 会让
  文件文字透过来。正确用法：不透明底色（`--dsw-alias-bg-elevated`）+ `background-image`
  线性渐变叠 tint。`preview/styles.ts` 的 `.qo-preview-selection:hover` 就是这么写的。
- 内置预览根节点自带 `data-textpreview-url`（文件地址）和 `data-document-preview`（渲染器 id）；
  纯文本 body 每行带 `data-textpreview-line`，代码 body 每行是 `pre .line`。
  证据：`dsh-client-ui-sidebar-documentpreview/lib/client.js` 的 `TextPreview`/`TextBody`/`CodeBody`。
- 内置预览的完整功能清单：渲染器切换菜单（text/code/markdown/html/image/pdf 经 `documentPreviews`
  注册表竞选）、`CodeBody` 代码高亮（带行号+复制按钮）、分页加载、文件变更提示条、换行开关、
  `?line=N` 行号跳转。**它没有**文件内搜索和选中加入会话——正是本插件补的两个。
- 「包裹内置 TextPreview 组件」路线**不可行**：`boundRenderSlot` 只允许渲染自己 entry 声明的
  children（`dsh-client-ui-slots/lib/index.js` 抛错），TextPreview 也不导出。
- 侧边栏浮动层 `floatHost` 是 `z-index: 60` 且 portal 到 body 的顺序在本插件之后，同值必输——
  所以两个浮层都用 **10000**（与 Ctrl+P backdrop 同层）。
- 搜索匹配用**大小写不敏感正则**（不是 lowerCase 副本），否则 ß/İ 这类大小写折叠变长的字符会让
  Range 偏移错位。

## 旧问题清单的处置（对应上一版 todo.md）

1. ~~查找面板太丑~~ → CodeMirror 原生面板已删除，搜索条是自绘 React 组件，穿 Ctrl+P 调色板
   （#252526/#3c3c3c/#454545，8px 圆角，`0 8px 32px` 投影），样式 100% 可控。
2. ~~「预览」按钮没反应~~ → 不再需要该按钮，kind 接管机制整体删除。
3. ~~浮框被侧边栏层级盖住~~ → 两个浮层 `z-index: 10000`，验证脚本有断言。
4. ~~查找面板英文硬编码按钮~~ → 自绘组件全中文文案（`preview/locales.ts`）。

## 遗留风险与注意点

- **依赖内置预览的 `data-*` 属性**（非正式契约）。所有探测都做了降级：找不到根节点就不弹框、
  没有行号标记就退化为裸 `@path`，不会崩。DSH 升级后如果增强失效，先查这些属性名是否变了。
- **分页加载**：搜索只覆盖已加载的页。打开搜索条后新加载的页会通过 MutationObserver
  （200ms 防抖）自动并入搜索。未加载的部分搜不到——如需提示主人，这是设计内限制。
- **CSS Custom Highlight API** 需要 Chromium 105+。不支持时降级为「只计数+跳转，无高亮」，
  不会报错。
- 切走 tab（预览隐藏）会自动关掉搜索条并清掉高亮，这是有意的。
- Markdown 渲染视图里选中也能加会话（无行号，退化为 `@path`）——比旧架构更强，是有意行为。

## 验证

- `node scripts/verify-preview.mjs` — 纯逻辑：地址解析、引用格式、跨文本节点匹配。
- `node scripts/verify-client-bundle.mjs` — 端到端桩测试：不注册 tab type、内置预览保住地址、
  Ctrl+F 无预览时透传/有预览时认领、搜索计数、选区浮框→写草稿→通知、z-index 与高亮名契约。
  **桩的有效性已用「故意改坏」验证过**（改 z-index→60、删 preventDefault，断言均如期 FAIL）。
- 改了 client 端只需 `Ctrl+Shift+R` 刷新，不需要重启 DSH。
- 观感类问题**实际截图比对**，不要靠正则断言。

## 工作方式提醒（写给下一个会话）

- 主人是「**先看结果再说话**」的反馈风格，且**明确讨厌猜测**。
- 新增断言后，务必用「故意改坏 → 断言必须失败」的方式验证断言本身有效。
- 提交规范：conventional commit、中文描述、**不要出现任何 AI 参与标记**、**禁止 `git add -f`**、提交前确认无 BOM。
- 本仓库是**独立插件仓库**（`D:\workspace\dsh-quick-open`），**不得依赖任何 workspace**。
- `node_modules` 里的 CodeMirror 依赖已全部移除（`npm prune` 已同步 lockfile），bundle 从 ~1.4MB 降到 ~78KB。

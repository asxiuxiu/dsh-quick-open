# 架构说明

本插件如何与 DSH 内置能力共存、内部各模块的职责，以及若干**踩过的坑**。
后者是有意保留的：它们都是从失败尝试里换来的结论，重新推导一遍代价很高。

---

## 一、设计原则：增强，不替换

插件**不接管任何 tab kind**，也不替换内置文档预览
（`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`）。内置预览的地址体系与全部功能
（渲染器切换、代码高亮、分页加载、变更提示、换行、行号跳转）原样保留。

本插件只在 DOM 层做增强，代码在 `src/client/preview/`：

| 模块 | 职责 |
|---|---|
| `index.ts` | 单例 React root。挂在 `document.body` 自己的 div 上，**不走 slot**——slot 每会话一份会重复挂载监听器 |
| `Augmentations.tsx` | 搜索条 + 选中浮框 + 通知，全部 portal 到 body，`z-index: 10000` |
| `probe.ts` | 发现内置预览：`[data-textpreview-url]` 根节点、可见性判断、行号推导 |
| `find.ts` | 文件内搜索：TreeWalker 收集文本节点 → `matchSpans`（纯正则匹配）→ CSS Custom Highlight API 画高亮（**不改 React 托管的 DOM**） |
| `selection.ts` | 引用文本构造 + 写草稿（`lines` 可选，无行号的渲染器退化为裸 `@path`） |
| `address.ts` | `dsh-resource://file/session/...` 地址解析 |

卸载即恢复原样：插件不持有内置预览的任何状态，也不改它的 DOM 结构。

---

## 二、已核实的平台事实

这些结论已用源码或实验确认，不必重新推导。

### 浮层必须 portal 到 `document.body`

Ctrl+P 浮层挂在 `conversation.input.overlay` slot 里，该 slot 位于 composer card
（`position: relative`）内部。**任何祖先建立 containing block 或 stacking context**
（transform、paint containment、带裁剪的滚动容器）都会把 `position: fixed` 的浮层困在
会话列里，此时 `z-index: 10000` 也救不了。portal 到 body 后只在根层级竞争，
而全应用最大 z-index 仅 1100（dialog/toast）。侧边栏自己的 Floats 层是同样做法。

### 两个浮层用 `z-index: 10000`

侧边栏浮动层 `floatHost` 是 `z-index: 60`，且它的 portal 到 body 顺序在本插件**之后**。
同值时后插入者获胜，所以本插件必须显著更高——与 Ctrl+P backdrop 取同一层 10000。

### hover 色调 token 是半透明的

`--dsw-alias-interactive-bg-hover` 直接当 `background` 会让底下的文件文字透过来。
正确用法：**不透明底色**（`--dsw-alias-bg-elevated`）+ `background-image` 线性渐变叠 tint。
见 `preview/styles.ts` 的 `.qo-preview-selection:hover`。

### 内置预览的可探测标记

| 标记 | 含义 |
|---|---|
| `data-textpreview-url` | 文件地址（预览根节点自带） |
| `data-document-preview` | 渲染器 id |
| `data-textpreview-line` | 纯文本 body 的每一行 |
| `pre .line` | 代码 body 的每一行 |

证据：`dsh-client-ui-sidebar-documentpreview/lib/client.js` 的
`TextPreview` / `TextBody` / `CodeBody`。

内置预览**有**渲染器切换菜单（text/code/markdown/html/image/pdf 经 `documentPreviews`
注册表竞选）、`CodeBody` 代码高亮（带行号与复制按钮）、分页加载、文件变更提示条、
换行开关、`?line=N` 行号跳转；**没有**文件内搜索与选中加入会话——正是本插件补的两项。

### 「包裹内置 TextPreview 组件」不可行

`boundRenderSlot` 只允许渲染自己 entry 声明的 children
（`dsh-client-ui-slots/lib/index.js` 抛错），且 `TextPreview` 未导出。
所以增强只能在 DOM 层做。

### 搜索匹配用大小写不敏感正则

不能用小写副本比对。`ß`、`İ` 这类字符大小写折叠后长度会变，会让 Range 偏移错位。
`preview/find.ts` 因此用 `new RegExp(..., 'giu')` 直接匹配原文。

---

## 三、依赖与降级

以下都是**对非正式契约的依赖**，全部做了降级，不会崩：

- **内置预览的 `data-*` 属性**。找不到根节点就不弹框；没有行号标记就退化为裸 `@path`。
  DSH 升级后如果增强失效，**先查这些属性名是否变了**。
- **CSS Custom Highlight API** 需要 Chromium 105+。不支持时降级为「只计数 + 跳转，无高亮」。
- **分页加载**。搜索只覆盖已加载的页；打开搜索条后新加载的页由 MutationObserver
  （200ms 防抖）自动并入。**未加载的部分搜不到**，这是设计上的限制而非缺陷。
- **`sidebarRight.openResource`** 要求目标 session 的右侧栏已挂载（adopted），
  未挂载时打开会被静默丢弃（上游 issue #694）。此限制对原生注册表的所有使用者一致。

---

## 四、有意为之的行为

- 切走 tab（预览隐藏）会自动关掉搜索条并清掉高亮。
- Markdown 渲染视图里选中也能加入会话（无行号，退化为 `@path`）。
- 不接管、不替换内置预览；卸载即恢复原样。

---

## 五、验证方式

| 脚本 | 覆盖 |
|---|---|
| `scripts/verify-preview.mjs` | 纯逻辑：地址解析、引用格式、跨文本节点匹配 |
| `scripts/verify-client-bundle.mjs` | 端到端桩测试：不注册 tab type、内置预览保住地址、Ctrl+F 无预览时透传/有预览时认领、搜索计数、选区浮框→写草稿→通知、z-index 与高亮名契约 |

桩的有效性用**「故意改坏 → 断言必须失败」**验证过（把 z-index 改成 60、删掉
`preventDefault`，断言均如期 FAIL）。

改了 client 端只需 `Ctrl+Shift+R` 刷新，不需要重启 DSH。
观感类问题**实际截图比对**，不靠正则断言。

相关文档：`matching-research.md`（模糊打分器的实验与负面结果）、
`dir-filter-evaluation.md`（目录过滤的性能评估）、`better-sidebar-integration.md`
（与第三方侧边栏插件的集成调研）。

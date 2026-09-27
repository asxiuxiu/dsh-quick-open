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

### 「活动会话」必须靠 `retainedBy.mainView`，快照里没有 `current`

会话列表快照的真实形状**只有四个键**（`dsh-api-session-controller/lib/client.js`
的初始值与其唯一一次全量 `list.set`）：

```
{ ids, byId, phase, projectionsBySession }
```

**没有 `current` / `activeSessionId`**。官方客户端标记「主视图正在展示哪个会话」的方式是
用 `mainView` 这个 retain 来源**保留**它，所以 `retainedBy.mainView > 0` 才是唯一受支持的
判定。全应用一致的写法（8 个包、18 处）：

```js
Object.values(ctx.sessions.list.getSnapshot().byId)
  .find((row) => (row.retainedBy.mainView ?? 0) > 0)
```

出现于 `dsh-client-ui-workspace` / `-session`（`isMain()`）/ `-layout` / `-cordis` /
`-open-in-app` / `-agent-preset` / `-experimental-agent-team`。
`mainView` 由 `sessions.retain(target, { source: 'mainView' })` 声明
（`dsh-client-ui-workspace`）。

两个必须避开的坑：

- `byId` **同时包含 subagent 子会话行**（`origin: 'subagent'`），所以「取第一行」或
  `ids[0]` 可能拿到子会话，而不是用户正在看的那个。
- `mainView` 是**计数**不是布尔，用 `?? 0` 兜底。

**这个 bug 曾经以最隐蔽的方式存活过**：`scripts/verify-client-bundle.mjs` 的桩把
`getSnapshot()` 写成了 `{ current: 'sess-1', byId: {...} }` —— 桩**凭空发明了**那个运行时
从不设置的字段。于是桩和实现共享同一个错误契约，测试全绿而线上 Ctrl+P 完全无反应
（`canServe()` 恒 `false`，且它在 `preventDefault()` **之前**返回，所以既不报错也不留日志）。

教训：**镜子照出 bug 就抓不到 bug**。桩必须逐字复刻生产形状；`sessions` 桩现已改为真实的
四键快照，并**故意把 subagent 子行排在前面**，任何「取第一行」的回归都会在这里失败。
断言也从「注册了几个 keydown 监听器」升级为**真的派发 Ctrl+P 并断言 `preventDefault` 被调用**。

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

## 五、国际化（zh / en）

### 文案集中在一张表，且「漏译」是编译错误

所有用户可见文案在 `src/client/i18n.ts`。两张表都标注为 `Messages`，所以
「英文加了键、中文忘了加」直接编译失败——这比靠 review 靠谱。

### 语言从 `<html lang>` 读，每次取文案都重读

```ts
const lang = document.documentElement.lang ?? ''
return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
```

DSH 外壳会按用户的 locale 偏好设置这个属性。**每次调用都重读而不是模块加载时捕获**：
外壳可以在不刷新页面的情况下改掉它，捕获的值会让插件停留在旧语言。非 `zh*` 一律回落英文。

### 为什么没用 `ctx.locale`

DSH 自带 locale 服务（`register(ns, {zh, en})` + `bind(ns)`），本插件没有用它，因为插件的
两半在「什么时候存在」上不一致：预览增强把 React root 挂在 slot 树**之外**
（理由见 `preview/index.ts`），而 controller 是从不持有 context 的异步回调里取文案。
两者都得把 context 一路穿进去，而 context 缺失时还是得回落英文。直接读
`documentElement.lang` 得到同样的可观测行为——语言正确、切换即时——却不需要任何管线，
也不存在「面板是中文但浮层是英文」这种失败态。

代价：client 插件无法在这里**新增**语言，加一种语言就是加一张表。对双语插件这是划算的，
而且整块文案能被现有桩测试覆盖。

### 占位符用 `{name}`，取不到就原样保留

`t('indexInfo', { count, age })`。没有对应参数的占位符**原样留下**而不是清空：
界面上出现字面的 `{count}` 是一条 bug 报告，而空字符串看起来像有意为之，会把遗漏藏起来。

### 中文在构建产物里是 `\uXXXX` 转义

esbuild 默认 `charset: 'ascii'`，所以 `lib/client.js` 里的中文是转义序列。
用 `grep 无匹配文件` 查产物**查不到**，要查 `\u65E0\u5339\u914D\u6587\u4EF6`——
这不是丢失，运行时字符串完全一致（0.2.2 及更早的产物一直如此）。

### 语言切换要覆盖「写进草稿的文本」

引用文本（`preview/selection.ts` 的 `path-hint` 格式）会进入会话草稿，属于用户可见输出，
所以它也走 `t()`。`verify-i18n.mjs` 对这一点有断言：同一份输入在两种语言下必须产生**不同**的草稿文本。

---

## 六、验证方式

| 脚本 | 覆盖 |
|---|---|
| `scripts/verify-preview.mjs` | 纯逻辑：地址解析、引用格式、跨文本节点匹配 |
| `scripts/verify-client-bundle.mjs` | 端到端桩测试：不注册 tab type、内置预览保住地址、**Ctrl+P 真的被认领（有会话时）/ 裸 p 透传**、Ctrl+F 无预览时透传/有预览时认领、搜索计数、选区浮框→写草稿→通知、z-index 与高亮名契约 |
| `scripts/verify-i18n.mjs` | 双语键位对齐、无空值/漏译、占位符在翻译后仍存在、语言回落、插值、**草稿引用文本随语言变化** |
| `scripts/verify-deploy.ps1` | **部署核对**：DSH 实际服务的那份 `lib/client.js` 是否就是本仓库的构建产物（字节比对 + `artifactRevision`） |

`verify-deploy.ps1` 存在的理由：DSH Desktop 把第三方插件放在
`$DSH_HOME/profiles/.generations/live/<name>+<version>+<hash>/` 下，并在**每次启动时**
按 `package.json` 的 `dsh.desktop.generationProjection` **重建指向它的 junction**。
所以改 junction 或改 `pnpm.overrides` 都会被启动维护**改回去**（投射器还会把你加的
override 记进 `previousOverride` 并清除）。正确做法是把构建产物**复制进 generation 目录
本身**——它是真实目录，投射只管理指向它的链接。

另注：判断 bundle 是否变化的 `artifactRevision` 哈希的是**文件元数据**
（`mtimeMs` / `ctimeMs` / `size`），**不是内容**。改动若恰好不改变文件大小，缓存不会失效。

桩的有效性用**「故意改坏 → 断言必须失败」**验证过（把 z-index 改成 60、删掉
`preventDefault`，断言均如期 FAIL）。

改了 client 端只需 `Ctrl+Shift+R` 刷新，不需要重启 DSH。
观感类问题**实际截图比对**，不靠正则断言。

相关文档：`matching-research.md`（模糊打分器的实验与负面结果）、
`dir-filter-evaluation.md`（目录过滤的性能评估）、`better-sidebar-integration.md`
（与第三方侧边栏插件的集成调研）。

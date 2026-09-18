# better-sidebar 相关的三个需求调研

针对「HTML 默认编辑模式」「Tab 内搜索文件内容」「引用带行号不带内容」三个需求的调研结论。
本轮**未改动任何代码**，仅记录事实与可行路径，供后续决策。

调研基线：`dsh-better-sidebar@0.19.1`（安装于 profile `.generations/live/`）、
DSH `0.1.5-rc.2`、`dsh-quick-open@0.1.0`。

---

## 一、dsh-better-sidebar 的定位

### 历史

DSH 早期**没有原生右侧栏**，better-sidebar 自绘一个右列面板填补空白。
DSH `0.1.5-rc.1` 自己实现原生右侧栏后，better-sidebar 在 v0.19.0 把右列交还给 DSH：
不再自绘右侧面板（旧浮窗能力同步移除），只保留底部工作台，以及开放给第三方的
`ctx.betterSidebar` 服务。

### 交还右列后仍保留的能力

| 类别 | 内容 | DSH 原生 |
|---|---|---|
| 底部工作台 | 分栏 / 终端 / 随会话持久化 | 无 |
| 真实终端 | xterm.js + node-pty，断线重连 | 无 |
| Git / 文件变动 | 真 diff、历史、暂存提交、本轮文件追踪 | 无 |
| 文件 viewer | Markdown（Mermaid）/ HTML / PDF / 图片 | 有 documentpreview，能力较弱 |
| Subagent / 后台任务 | 拓扑 + 实时输出 + 强制终止 | 有 jobs，无拓扑 |
| 侧边对话 | Codex 风格侧线程 | 无 |
| 固定终端 | 跨会话不消失 | 无 |

### 真正的意义：服务提供者

内置的 8 tab + 6 viewer 与第三方插件走**同一套** `ctx.betterSidebar` API 注册，
能力完全对等。对外扩展点：

```
registerTab(descriptor)        // 侧边栏页面
registerFileViewer(descriptor) // 文件预览器
registerFileIcon(descriptor)   // 文件 / 目录图标
openFile(scope, path)          // 在侧边栏打开文件
```

官方明确「不再内置、可由生态提供的功能，交由生态插件实现」（Office 预览已按此移出）。
因此**正确做法不是改 better-sidebar，而是用它的扩展点在其旁边加一个 viewer**。

---

## 二、dsh-quick-open 与 better-sidebar 的耦合

全插件只有一个耦合点，位于 `src/client/controller.ts` 的 `sidebar()`：

```ts
const service = ctx.get('betterSidebar')
if (service === undefined || !service.features.includes('openFile')) return undefined
return service
```

只在 `openSelected()` 一处使用。`package.json` 的 `inject` 不含它，属可选依赖。

| 功能 | 是否依赖 | 通道 |
|---|---|---|
| 搜索（Ctrl+P） | 否 | 自有 host 路由，降级 `fs.search` |
| 引用到会话（Ctrl+Enter） | 否 | `ctx.get('conversation')` |
| 打开文件（Enter） | **是** | `ctx.betterSidebar.openFile()`，缺失时仅提示不崩 |

---

## 三、三个需求的结论

### 1. HTML 默认走预览

**位置**：better-sidebar `src/client/TextEditor.tsx`

```ts
const [mode, setMode] = useState<ViewMode>('preview')
```

HTML 与 code、markdown 共用同一组件，初值写死 `'preview'`，**无设置项**。

**descriptor 不支持**：`FileViewerDescriptor` 只有
`id / title / icon / exts / priority / fetchStrategy / detect / load / settings / component`，
没有任何 pass-through 字段可从外部把初始 mode 传进去。

**现成缓解**：编辑器头部有「预览 / 编辑」切换按钮（`EditorHost.tsx` 的 `editorModeToggle`），
点「编辑」即为代码模式，可选中片段加入会话。

**对游戏 UI 资源的特殊性**：游戏 UI 的 `.html` 在浏览器里预览不出实际效果，
「默认预览」对这类文件是无意义的开销。这是**新写一个 HTML viewer**（`priority` 抢占，
或在设置里关掉内置 `html` viewer 让其 fall through）的合理动机。

### 2. Tab 内搜索文件内容

**真缺功能**，非配置问题：

- `@codemirror/search` 在 `package.json` 依赖中，但**未安装**
  （profile 的 `node_modules/@codemirror/` 下无此包），源码中零处 import
- `TextEditor.tsx` 的 keymap 只挂了自建 `Mod-s`、`defaultKeymap`、`historyKeymap`，
  **无 `searchKeymap`**，因此 Ctrl+F 无反应
- 预览模式下完全无从搜索

**更关键**：即便未来上游补上 `searchKeymap`，也对 HTML 无效。因为
selection popup 的注册条件在源码里是**硬编码**的：

```ts
...(viewerId === 'code' || viewerId === 'markdown' ? [ /* updateListener */ ] : []),
```

`viewerId === 'html'` **不在其中**。这带来一个连带的现成缺陷：

> **HTML 在编辑模式下手动选中文本，不会弹出「添加到会话」按钮。**

（HTML 的预览模式有 `handlePreviewMouseUp` 走 DOM 选区路径，但编辑模式下没有对应的
CodeMirror 选区监听。）

### 3. 引用带内容而非「路径 + 行号」

**已实现**，位置 `src/client/selection-payload.ts`：

```ts
export const SELECTION_LIMIT = 500

export function buildSelectionInsert(path, cwd, lines, selected): string {
  const header = headerOf(path, cwd, lines)              // 相对路径:起止行
  if (selected.length > SELECTION_LIMIT) return header    // 超限 → 只留路径行号
  return `\`\`\`${header}\n${selected}\n\`\`\``            // 未超 → 围栏块带内容
}
```

- 选中 **> 500 字符** → 只插入 `path:12-15`，**不带内容**
- 选中 **≤ 500 字符** → 插入围栏代码块，**带内容**

行号格式本就是 `path:12`（单行）/ `path:12-15`（多行），符合期望形态；
用户感知的"缺陷"来自阈值 500 而非格式设计。

### 3.1 DSH `@` 语法不支持行号

`@deepseek-ai/dsh-file-reference` 的 `formatFileMention` 只有两种形态：
`@path` 与 `@"path with spaces"`。系统提示词将 `@` 定义为路径：

> Tokens prefixed with @ are workspace paths the user explicitly referenced...

因此 `@file.cpp:120-160` **不可行**——模型会当成不存在的路径去 read 而失败。
行号必须以 `path:12-15` 这类**明确文本**呈现，即 better-sidebar 现有方案。

---

## 四、可行路径

| 需求 | 做法 | 成本 | 归属 |
|---|---|---|---|
| 引用只带行号 | 调 `SELECTION_LIMIT`，或加「仅路径」二级按钮 | 低 | `dsh-quick-open` |
| HTML 默认编辑 | 新写 HTML viewer（`registerFileViewer` + `priority`） | 中 | 新插件 |
| Tab 内搜内容 | 同上：自建 viewer 自带 CodeMirror + `searchKeymap` | 中 | 新插件 |
| HTML 编辑模式选中弹按钮 | 上游修 `viewerId` 白名单 | 低 | 上游 |

**结论**：需求 2、3 共用同一个产物——一个自带 CodeMirror（含 `searchKeymap`）与
可选默认编辑模式的 HTML/代码 viewer。需求 1 在 `dsh-quick-open` 内独立解决。

---

## 五、修改 better-sidebar 的代价（备选路径）

若选择直接改插件源码，需注意：

- 发布包**不含构建配置**：`src/`、`lib/`、`package.json`、`scripts/install.*` 都在，
  但 `tsconfig*.json`、`tsdown.config.*`、`eslint` 配置均不在 `files` 白名单内
- 目录是 pnpm 硬链接，**原地修改会污染全局 store**，必须复制后再装
- 安装位置在 `.generations/live/`，**插件升级即失效**
- 推荐改用 `link:D:\workspace\dsh-better-sidebar` 本地克隆（README 有此流程）

---

## 六、待决问题

1. 三个需求各自的实际优先级（用户倾向先想清楚是否需要）
2. 若做新 viewer：是覆盖内置 `html` viewer，还是并存并用设置切换
3. `SELECTION_LIMIT` 的目标值，或是否需要「强制仅路径」的显式按钮
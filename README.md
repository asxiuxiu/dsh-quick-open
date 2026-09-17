# dsh-quick-open

DSH Web GUI 插件：VSCode 式 `Ctrl+P` 快速打开，**索引级搜索性能**。

- 在任意会话页面按 `Ctrl+P` 唤出搜索浮层（window 级 capture 监听，不依赖任何面板挂载状态）
- **自有 host 半 `/quick-open/api/search`**：每工作区内存索引（16 路并行 `readdir` 建索引），查询纯内存过滤——实测 20 万条目的树上冷建索引 2.7s、**热查询 1-8ms**；TTL 30s + stale-while-revalidate 保鲜
- 客户端三级加速：query 扩展时**增量本地过滤**（子串语义下结果精确，零网络）→ 查询结果 LRU 缓存（后退/重开即响应，后台重验）→ 网络请求
- 空查询显示**最近使用**文件（按工作区记忆，`Ctrl+P → Enter` 直接重开上一文件）
- `Enter` 在侧边栏编辑器中打开文件（走 `ctx.betterSidebar.openFile()` 公开服务契约）
- `Ctrl+Enter` 把文件作为结构化 chip 插入当前会话输入框，**浮层保持打开、焦点留在搜索框**，可连续添加多个文件
- 结果行携带 `isDir`：目录按 `Enter` 提示，按 `Ctrl+Enter` 以 `@dir/` 纯文本引用（索引路由零探测；legacy 降级路径按需探测 `fs.tree`）
- 结果按匹配质量重排：完全匹配 > 前缀匹配 > 包含匹配（服务端只返回字母序）
- `↑↓`/`PageUp`/`PageDown`/`Home`/`End` 导航、`Esc` 关闭、点击遮罩关闭；中文输入法组词中不响应按键
- footer 显示索引透明度信息（条目数与新鲜度）

## 交互模型

**焦点纪律（核心不变量）**：浮层存活期间，键盘焦点永不离开搜索框。

- 行内 `mousedown` 一律 `preventDefault`，鼠标点击/悬停不会夺走输入焦点
- `Ctrl+Enter` 插入 chip 时 DSH 输入机会异步聚焦对话输入框——控制器立即 + 80ms 延迟**两次夺回焦点**（`focusSeq` 递增驱动），赢得这场竞争
- 打开浮层时自动全选保留的旧查询：输入即替换，方向键则复用

**可发现性**：选中行右侧显示「+ 引用」按钮（`Ctrl+Enter` 的鼠标等价物），footer 常驻键位提示。

## 依赖

- **打开文件**依赖 [`dsh-better-sidebar`](https://www.npmjs.com/package/dsh-better-sidebar)（≥ v0.12.0 的 `openFile` 能力）
- **搜索/引用不依赖它**：索引路由由本插件 host 半提供；自有路由不可用时降级到 `fs.search`（此时搜索依赖 better-sidebar 的 host 路由）

降级矩阵：缺 better-sidebar → 搜索与引用照常，Enter 提示无法打开；自有路由缺失 → 自动退回 `fs.search`。

## 安装

```bash
# 依赖插件（仅「打开文件」需要；建议安装）
dsh plugin --profile web add dsh-better-sidebar

# 本插件（GitHub 源 / npm 源 / 本地 link 三选一）
dsh plugin --profile web add github:<you>/dsh-quick-open
dsh plugin --profile web add dsh-quick-open
dsh plugin --profile web add link:D:/dev/dsh-quick-open   # 本地开发
```

安装后**重启 DSH**（host 半只在 boot 时挂载）。link 安装下改 client 代码后 `npm run build` + 刷新页面即可；改 host 代码（`src/index.ts`）需重启。

## 开发

```bash
npm install
npm run build       # 产出 lib/index.js（host：索引搜索路由）+ lib/client.js（__ModuleLoader__ 封装）
npm run typecheck
```

## 架构

```
src/index.ts            host 半：/quick-open/api/search（并行建索引、SWR 保鲜、trust fence、isDir 标记）
src/client/index.tsx    client 入口：全局 Ctrl+P（ctx.effect + window capture）+ slot 注册
src/client/controller.ts 搜索管线（增量过滤/缓存/索引路由/legacy 降级）、打开、引用、最近记录、焦点回收
src/client/quick-open.tsx 浮层组件（内联样式，无 CSS 构建链）
src/client/store.ts     每激活一份的状态存储（useSyncExternalStore）
src/client/ime-guard.ts IME 组词判据（isComposing + keyCode 229，DSH core 约定）
src/client/types.ts     最小服务契约类型（slots / sessions / conversation / betterSidebar）
```

## 路线图（可拓展方向）

按「价值 / 成本」排序：

1. **文件预览窗格**：导航时右侧显示选中文件的前 N 行（`fs.read` 路由已有，需处理二进制与大文件）——类 VSCode peek
2. **拼音/首字母匹配**：中文文件名用拼音检索（索引已在内存，客户端加分词映射即可，成本中等）
3. **多选批量引用**：`Ctrl+Space` 标记多行，一次 `Ctrl+Enter` 全部加入对话
4. **fs.watch 精准失效**：替代/补充 TTL，索引实时跟随文件变更（Windows 支持递归 watch，Linux 需逐目录——跨平台取舍）
5. **设置页**：自定义键位、防抖时长、最近记录上限（走 `settings.section` slot）
6. **全文搜索模式**：`%query` 前缀切换内容检索（索引已就位，加内容扫描路由即可）

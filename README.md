# dsh-quick-open

DSH Web GUI 插件：VSCode 式 `Ctrl+P` 快速打开，**索引级搜索性能 + 模糊匹配**。

- 在任意会话页面按 `Ctrl+P` 唤出搜索浮层（window 级 capture 监听，不依赖任何面板挂载状态）
- **自有 host 半 `/quick-open/api/search`**：每工作区内存索引（16 路并行 `readdir` 建索引），查询纯内存打分——实测 5 万条目**热查询中位数 7.4ms、最大 18.5ms**；TTL 30s + stale-while-revalidate 保鲜
- **模糊匹配不要求拼对全名**：`clntmod` → `client_module.cpp`、`playerctrl` → `player_camera_controller.lua`、`apprpc` → `app_rpc.nsd` 都能直接命中（见下节）
- **空格分词 AND**：`game scene lua` 三片必须全部命中；**查询含 `/` 时匹配完整路径**，可用来按目录定位（`ui/index.html`）
- 匹配到的字符**逐段高亮**（不再是整段子串），路径查询时目录片段也会高亮
- 空查询显示**最近使用**文件（按工作区记忆，`Ctrl+P → Enter` 直接重开上一文件）
- `Enter` 在侧边栏编辑器中打开文件（走 `ctx.betterSidebar.openFile()` 公开服务契约）
- `Ctrl+Enter` 把文件作为纯文本 `@` 引用插入当前会话输入框，**浮层保持打开、焦点留在搜索框**，可连续添加多个文件
- 结果行携带 `isDir`：目录按 `Enter` 提示，按 `Ctrl+Enter` 以 `@dir/` 纯文本引用（索引路由零探测；legacy 降级路径按需探测 `fs.tree`）
- `↑↓`/`PageUp`/`PageDown`/`Home`/`End` 导航、`Esc` 关闭、点击遮罩关闭；中文输入法组词中不响应按键
- footer 显示索引透明度信息（条目数与新鲜度）
- **每工作区可配置索引规则**（设置页编辑，见下）：排除目录 / 强制包含目录 / 后缀白名单 / 文件名白名单 / 是否索引目录
- **可索引工作区之外的目录**（`extraRoots`）：引擎仓库与游戏仓库是并列文件夹，开发时需要互查

## 搜索匹配

匹配器是 **VSCode quick-open 打分器的移植**（`src/vs/base/common/fuzzyScorer.ts` + `filters.ts`，常数与分档取自源码，非自创）。

**为什么是移植而不是自调参**：先试过 8 种自创打分方案（纯子序列、段感知、结构分层、join 子词 + 长度归一化……），每一种都在另一组查询上崩掉——详见 `docs/matching-research.md` 的实验与负结果。VSCode 的常数是 `1<<16` 量级的**互不重叠分档基数**加 `computeCharScore` 的小整数，二者的量级关系已经决定了「命中文件名」永远压过「命中路径」，**没有需要调的权重**。这是它更稳的根本原因。

| 行为 | 说明 |
|---|---|
| 字符命中 | `+1`；连续命中 `min(run,3)*6 + max(0,run-3)*3`；大小写也相同 `+1` |
| 词首加成 | 位置 0 `+8`；前一位是 `/` 或 `\` `+5`；前一位是 `_ - . 空格 ' " :` `+4`；词内驼峰（非连续时）`+2` |
| 顺序约束 | 非首字符必须有对角分才计分，保证查询字符按序匹配 |
| 分档 | 全路径相同 `1<<18` > 文件名前缀 `1<<17` > 命中文件名 `1<<16` > `dir:` 命中目录 `1<<15` > 仅命中目录 `1<<14` |
| 平局 | 命中越紧凑优先（跨度过大者降级），再由路径长度兜底——保证结果顺序稳定 |
| 门槛 | 查询片必须是目标的子序列才进入矩阵打分（保守预筛，不会漏掉真实命中） |

### 作用域前缀：`dir:` / `file:`

每个空格分隔的词都可以带前缀，限定它只能在哪里匹配：

| 写法 | 含义 |
|---|---|
| `dir:ui index.html` | `ui` **必须**命中目录段，`index.html` 命中文件名 |
| `d:ui index.html` | 同上（简写） |
| `file:index.html` | 只匹配文件名，不回落到路径 |
| `f:index.html` | 同上（简写） |
| `ui/index.html` | 带 `/` 等价于路径查询（VSCode 行为） |

解决的就是下面「已知边界」里那个问题——**用显式前缀代替自动猜测**。

- **零索引体积**：纯查询解析，不新增任何索引结构
- **零默认行为改动**：不带前缀时逐字节等价于原行为（有 44 条查询的对比测试证明，见 `scripts/verify-no-regression.mjs`）
- 前缀只在**词首**识别；`e:foo`（Windows 盘符）、`a:bc` 这类含冒号的词按字面处理
- 半成品前缀（如刚敲下 `dir:`）不产生约束，不会把结果清空
- 代价：`dir:` 查询要按路径打分，实测 22–48ms（普通查询 ~7ms）。这是显式高级查询，可接受

**已知边界**：`index.html ui` 这种「无分隔符、想让 `ui` 去匹配目录段」的写法**不保证**把 `ui/` 目录的结果排到最前——`ui` 本身就是 `..._observer_index.html` 的合法子序列，算法无法知道你想指的是目录。请改用 `dir:ui index.html`，或带上 `/`（`ui/index.html`）。

> 该边界已做过完整可行性评估（体积 + 准确率实测），结论是**不做自动目录筛选**：机制能让 `index.html bag` 从 0 结果变正确，但会把 `game_scene lua`、`client module`、`material ast` 三个原本正确的查询劫持到错误结果。根因是 `lua`/`module`/`ast` 这类词**既是真实目录名又是常见文件名片段**——2,801 个目录名里只有 3 个不出现在任何 basename 中（`module` 有 4 个目录却出现在 539 个 basename 里），不存在可用的判定阈值。数据与各结构体积对比见 `docs/dir-filter-evaluation.md`。

## 索引规则（每工作区一份）

索引什么由工作区的 **`.dsh/quick-open.json`** 决定；没有该文件时使用**内置默认规则**（`src/rules.ts` 的 `DEFAULT_RULES`）。旧版本的仓库根 `.dsh-quick-open.json` 仍会被读取（作为回退），保存时会自动迁移到新位置并删除旧文件。

配置放在 `.dsh/` 下而不是仓库根，是为了让插件的痕迹集中在**一个命名空间目录**里，而不是往一个它并不拥有的项目里撒点文件。建议把它加入本地忽略（`.git/info/exclude`），不要提交进业务仓库。

**为什么需要它**：早期版本硬编码 `SKIP_DIRS` 黑名单后全量收，噪音占绝大多数——shader 编译产物、安装拷贝、目标文件；而源码**真正会 include** 的生成头文件树却因为父目录名叫 `build` 被整棵排掉。

**内置默认是语言中立、项目中立的**：只有各生态公认的噪音目录 + 跨语言通用的源码/配置后缀。某个仓库特有的构建布局、生成头文件树、并列的兄弟仓库，都写在**那个仓库自己的配置文件**里——这正是规则按工作区存放的意义。把某个公司的仓库布局硬编码成出厂默认，换一个项目就会误伤。

| 字段 | 作用 |
|---|---|
| `excludeDirs` | 整棵子树不遍历，见下方模式语义 |
| `includeDirs` | **优先级高于排除**，救回被父级排除但需要的生成树（如生成头文件目录）。也是唯一能下探符号链接目录的方式 |
| `includeExtensions` | 文件后缀白名单（带点，小写）。**留空 = 不按后缀过滤** |
| `includeFilenames` | 完整文件名白名单，不受后缀限制（`CMakeLists.txt` 等） |
| `includeDirectories` | 是否索引目录条目（关闭后无法 `@dir/` 引用） |
| `extraRoots` | **工作区之外**的绝对目录，一并索引（见下节） |

**目录模式有三种形式**，都覆盖匹配点以下的整棵子树：

| 写法 | 含义 |
|---|---|
| `node_modules` | **裸名字：匹配任意深度**的同名目录。噪音目录几乎都会嵌套（monorepo 的 `packages/*/node_modules`、`sub/project/__pycache__`），只排除根目录那一个会静默漏掉其余全部 |
| `build/go` | **带斜杠：锚定在工作区根**。不会匹配 `x/build/go`，也不会误伤 `build/golang` |
| `**/shaders/d3d11` | 指定路径在任意深度 |

配置示例（只写要覆盖的字段，其余省略即用默认）：

```jsonc
{
  "version": 1,
  "excludeDirs": ["_install", "_content", "build/Engine", "build/go"],
  "includeDirs": ["build/p/include"],
  "includeExtensions": [".h", ".cpp", ".py", ".lua", ".md", ".json"],
  "includeFilenames": ["CMakeLists.txt", ".clang-format"],
  "includeDirectories": true,
  "extraRoots": [
    { "path": "E:\\path\\to\\sibling-repo\\_source", "label": "sibling/_source" }
  ]
}
```

> **写出完整规则集的后果**：设置面板保存时会写**当前生效的全量规则**（含从默认继承来的值），此后该工作区不再跟随插件升级后的新默认。这是有意的取舍——所见即所得，且不同工作区可以各自演化。

> **后缀白名单的固有盲区**：同一后缀在不同目录可能含义完全不同。`.ast` 在 shader 模板目录下是编译中间产物（数万条），在别处是**真实配置源**（材质、实体、相机配置）。这类冲突要靠**目录级排除**解决，而不是把后缀从白名单里删掉（删掉会让真实配置源一起消失）。同理 `.png` 在 UI 目录里数量巨大，靠后缀排除更划算。

## 额外索引根（工作区之外）

引擎仓库与游戏仓库是**并列的两个文件夹，不是包含关系**，但开发时经常需要互查。`extraRoots` 让一个工作区把工作区外的目录一并索引：

```jsonc
{
  "extraRoots": [
    { "path": "E:\\cb2_master\\dev\\wolfgang\\_games\\proven_ground\\_source",   "label": "proven_ground/_source" },
    { "path": "E:\\cb2_master\\dev\\wolfgang\\_games\\proven_ground\\_schemas",  "label": "proven_ground/_schemas" },
    { "path": "E:\\cb2_master\\dev\\wolfgang\\_games\\proven_ground\\_content\\ui", "label": "proven_ground/ui" }
  ]
}
```

| 行为 | 说明 |
|---|---|
| 路径必须**绝对** | 相对路径会被丢弃：额外根是针对文件系统解析的，相对路径会隐式依赖进程 cwd |
| 规则复用 | 每个额外根用**同一套**目录/后缀规则遍历（`_install` 在每个根里含义一致） |
| 规则基准 | 目录规则按**各根自身**的相对路径匹配，所以某个额外根即使位于名叫 `build` 的目录下，也不会被工作区的 `build/*` 排除吞掉 |
| 结果显示 | 结果行显示**完整绝对路径**（`E:/cb2_master/dev/...`），`label` 作为行首徽章 |
| `@` 引用 | 额外根的文件用**绝对路径**引用；工作区内文件保持相对路径 |
| 环检测 | 每个根独立维护 `seenReal`，跟随符号链接时防环 |

## 设置页

「设置 → Quick Open 索引」面板编辑**当前活跃会话工作区**的规则。

- 顶部显示当前工作区路径与配置文件状态（已存在 / 使用默认）、当前索引条目数
- 无活跃会话时面板**只读**并提示原因——规则按工作区存放，没有会话就没有可编辑的目标，面板不会猜测路径
- 保存走 host 半 `config.set`：**校验 + 原子写入**（临时文件 rename），随后立即按新规则重建索引
- 「恢复默认」删除配置文件并回落到内置默认规则
- 配置改动在 **3 秒内外**被 host 半感知（`CONFIG_TTL_MS` 重验），无需重启

## 依赖

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
dsh plugin --profile web add github:asxiuxiu/dsh-quick-open
dsh plugin --profile web add dsh-quick-open
dsh plugin --profile web add link:D:/dev/dsh-quick-open   # 本地开发
```

安装后**重启 DSH**（host 半只在 boot 时挂载）。link 安装下改 client 代码后 `npm run build` + 刷新页面即可；改 host 代码（`src/index.ts`）需重启。

## 开发

```bash
npm install
npm run build       # 产出 lib/index.js（host：索引搜索路由）+ lib/client.js（__ModuleLoader__ 封装）
npm run typecheck

# 验证脚本（均针对真实工作区索引，需先按脚本内路径配置工作区）
node scripts/verify.mjs                  # 匹配质量回归（含 dir:/file: 用例）
node scripts/verify-no-regression.mjs    # 对比 HEAD 与当前：证明无前缀查询行为未变
node scripts/verify-grammar.mjs          # dir:/file: 前缀解析边界用例
node --expose-gc scripts/eval-cost.mjs   # 索引体积基线 + 候选结构代价
node scripts/eval-ambiguity.mjs          # 目录名歧义量化
```

## 架构

```
src/rules.ts            索引规则：类型/默认规则/目录匹配（子树语义 + **/ glob）/文件过滤/配置解析与序列化
src/match.ts            模糊匹配器：VSCode quick-open 打分器移植（分档/字符分/顺序约束/紧凑度平局/高亮区间）
                        含查询解析：dir: / file: 作用域前缀（纯解析层，不带前缀时行为与之前逐字节一致）
src/index.ts            host 半：/quick-open/api/{search,config.get,config.set,config.reset}
                        （规则驱动的并行建索引、SWIG 式模糊查询、SWR 保鲜、配置文件热重验、原子写入、trust fence、isDir 标记）
src/client/index.tsx    client 入口：全局 Ctrl+P（ctx.effect + window capture）+ 两个 slot 注册
src/client/controller.ts 搜索管线（查询缓存/索引路由/legacy 降级）、打开、引用、最近记录、焦点回收
src/client/quick-open.tsx 浮层组件（内联样式，多段高亮，无 CSS 构建链）
src/client/settings.tsx 设置面板：当前工作区规则编辑（无会话时只读降级）
src/client/store.ts     每激活一份的状态存储（useSyncExternalStore）
src/client/ime-guard.ts IME 组词判据（isComposing + keyCode 229，DSH core 约定）
src/client/types.ts     最小服务契约类型（slots / sessions / conversation / betterSidebar）
docs/matching-research.md 匹配方案调研：VSCode/fzf/fzy 源码结论 + 8 种设计的实测对比与负结果
docs/dir-filter-evaluation.md 目录筛选可行性评估：索引体积实测 + 目录名歧义量化（结论：不做自动筛选）
```

## 路线图（可拓展方向）

按「价值 / 成本」排序：

1. **文件预览窗格**：导航时右侧显示选中文件的前 N 行（`fs.read` 路由已有，需处理二进制与大文件）——类 VSCode peek
2. **拼音/首字母匹配**：中文文件名用拼音检索（索引已在内存，客户端加分词映射即可，成本中等）
3. **多选批量引用**：`Ctrl+Space` 标记多行，一次 `Ctrl+Enter` 全部加入对话
4. **`fs.watch` 精准失效**：替代/补充 TTL，索引实时跟随文件变更（Windows 支持递归 watch，Linux 需逐目录——跨平台取舍）
5. **设置页扩展**：自定义键位、防抖时长、最近记录上限（`settings.section` slot 已就位，当前用于索引规则）
6. **全文搜索模式**：`%query` 前缀切换内容检索（索引已就位，加内容扫描路由即可）
7. **`dir:` 查询提速**：目前 22–48ms（需按路径打分）。可用索引期预计算的目录段倒排索引把候选直接切出来，代价 +4.3MB（占总索引 ~23MB 的 19%），见 `docs/dir-filter-evaluation.md`
8. **索引截断提示**：walk 触及 `MAX_VISITED`（50 万）时向客户端上报 `indexTruncated`，浮层 footer 显式告警（host 半已在响应中返回该字段，待客户端消费）


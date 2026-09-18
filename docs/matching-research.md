# dsh-quick-open 搜索匹配优化 — 调研与设计

## 1. 现状与问题（实测）

当前实现是**单一 basename 子串过滤**（`src/index.ts` 的 `queryIndex`）：
`entry.nameLower.includes(needle)`，客户端再用 `rankMatches` 做一次"精确名 > 前缀 > 其他"的三档排序。

用真实 Chaos 工作区索引（**51,266 项**，`_content`/`_install` 等已排除）实测，缺陷分为三类：

| 症状 | 实测证据 | 用户感受 |
|---|---|---|
| 必须几乎完整拼对 | `clientmodule`→0、`apprpc`→0、`evtmgr`→0、`clntmod`→0 | "不用输那么精准就能匹配上" |
| 高频词无法收敛 | `index.html`→200+ 截断；`cm`→200+ 全是 `CMakeFiles` 噪音 | "输入 index.html 筛出很多候选项时，输入目录的只言片语进一步筛选" |
| 完全看不见目录 | `game_scene` 只匹配 basename，路径里的 `game_scene/` 目录不算 | 同上 |

结论：不是排序不够好，而是**匹配阶段就把正确答案排除了**——子串语义下 `clntmod` 根本无法匹配 `client_module`。

## 2. 性能预算（实测，决定性）

在 51,266 项上跑子序列打分（fzy 风格）：

| 指标 | 实测 |
|---|---|
| 中位数 | **4.0 ms** |
| p90 | 7.7 ms |
| 最大 | 9.1 ms |

→ **模糊匹配在 JS 里对 5 万项完全可行**，不需要建 trigram 索引之类的重型方案。这是整个方案能成立的前提。

## 3. 业界算法调研（均从源码核实）

### 3.1 VSCode `fuzzyScore`（`src/vs/base/common/filters.ts`）

VSCode 的 quick-open 排序核心，我判断是**最贴合本需求**的参考。要点：

**a) 分词优先级（`_doScore`）——不连续、分档给分：**

| 命中位置 | 分值 |
|---|---|
| 公共前缀（`foobar <-> foobaz`） | 7（大小写不同则 5） |
| 驼峰大写开头 | 7（同上 5） |
| 命中分隔符本身 `. <-> foo.bar` | 5 |
| 分隔符之后（`foo <-> bar_foo`） | 5 |
| 普通字符 | 1 |

**b) 首字符惩罚（关键）：**
```
patternPos === patternStart 且 wordPos > wordStart:
    score -= isGapLocation ? 3 : 5
```
首字符若没落在词首，直接扣分。**这正是"短词不该随便命中"的官方做法**——我在 design F 里手写了 `hasStrongFirstMatch` 才达到类似效果。

**c) 跳过字符的扁平惩罚（我此前做错的地方）：**
```js
const skippedCharsCount = maxMatchColumn - patternLen;
result[0] -= skippedCharsCount;   // 每个被跳过的字符 -1
```
外加 gap start `-5`（`_diag > 0 ? -5 : 0`）。是**线性、扁平**的跳过惩罚，不是我做的那种乘法/开方归一化。

**d) 匹配器是 `or(matchesPrefix, matchesCamelCase, matchesContiguousSubString)`**：前缀、驼峰、连续子串三种择优，**其中驼峰匹配是独立的递归匹配器 `_matchesCamelCase`**，而不是我做的"对 join 后的字符串跑子序列"。这解释了为什么我 design G 会退化——把子词拼起来丢掉了边界信息。

**e) 全文匹配加成 + 上限：** `boostFullMatch` 命中整词 `+2`；`_maxLen = 128` 截断，超长词不参与精细打分。

**f) 首字符可弱匹配开关：** `FuzzyScoreOptions { firstMatchCanBeWeak, boostFullMatch }`，模糊查找用 `firstMatchCanBeWeak: true`，即允许首字符弱命中但要付代价。

### 3.2 fzf（`src/algo/algo.go`，源码核实）

```
scoreMatch        = 16
scoreGapStart     = -3
scoreGapExtension = -1
bonusBoundary     = scoreMatch / 2 = 8    // 词首
bonusNonWord      = 8
bonusCamel123     = bonusBoundary + scoreGapExtension = 7
bonusConsecutive  = -(scoreGapStart + scoreGapExtension) = 4
bonusFirstCharMultiplier = 2              // 首字符加成翻倍
```
- **算法是 Smith-Waterman 变体（V2）**，O(nm) DP，求全局最优而非贪心首个匹配；V1 是 O(n) 贪心。
- 注释里给了**极其重要的调参依据**：`bonusBoundary` 特意选成"当 gap 超过 8 字符时加成被抵消"，是按 web2 词典 + 文件系统调出来的。**这解释了我反复踩的坑**：长名字靠意外字母累积匹配、压过真答案，必须有强到能在 8 字符距离内抵消词首加成的 gap 惩罚。
- 连续匹配有额外加成 `bonusConsecutive`，且"chunk 首字符的 bonus 决定整段"。
- `--scheme=path` 时把 `/` 当 delimiter：`bonusBoundaryDelimiter = bonusBoundary + 1`，`initialCharClass = charDelimiter`——**路径模式是独立 scheme**，与通用文本模式参数不同。

### 3.3 fzy（`src/match.c`，源码核实）

- 也是 DP（两个数组 `D`/`M`：`D` = 以匹配结尾的最优分，`M` = 该位置的最优分）。
- 关键机制：**分段 gap 惩罚** — `SCORE_GAP_LEADING` / `SCORE_GAP_INNER` / `SCORE_GAP_TRAILING` 三种，前导/中间/尾随 gap 分开计价（`gap_score = i == n-1 ? TRAILING : INNER`）。
- 连续匹配用 `SCORE_MATCH_CONSECUTIVE` 且**不与 `match_bonus` 叠加**（`max(prev_M + bonus, prev_D + CONSECUTIVE)`）。
- `precompute_bonus` 逐位置算词首加成，`last_ch` 初值为 `'/'`——**路径语义写死在默认里**。
- 有回溯（`match_positions`）产出命中位置，可用于高亮。
- 长度相同直接返回 `SCORE_MAX`；超长（> `MATCH_MAX_LEN`）返回 `SCORE_MIN` 但仍返回匹配，只是排最后。

### 3.4 Everything 语法（待补充核实）

> 未从源码核实。已知语法（`space`=AND、`|`=OR、`!`=NOT、`ext:`、`path:`、`regex:`、通配符 `*`/`?`）属于**查询语言**层面的能力，优先级低于上面的"打分"问题，列为后续可选。

### 3.5 VSCode 的"路径词元筛选"规则（**已从源码核实，修正了此前的错误假设**）

> ⚠️ **修正**：我曾假设 VSCode 把查询按"最后一个空格/分隔符"切成"路径段 + 文件名段"。**这是错的。**
> 核实 `src/vs/base/common/fuzzyScorer.ts`（完整读了 `prepareQuery` / `doScoreItemFuzzy` /
> `doScoreItemFuzzySingle` / `doScoreItemFuzzyMultiple` / `computeCharScore` /
> `compareItemsByFuzzyScore`）后，真实机制如下。

**a) 查询只按空格切（`prepareQuery`）**，切出的 `values` 是**每一片都必须命中的 AND**：
```js
const MULTIPLE_QUERY_VALUES_SEPARATOR = ' ';
const originalSplit = original.split(MULTIPLE_QUERY_VALUES_SEPARATOR);
...
const containsPathSeparator = pathNormalized.indexOf(sep) >= 0;   // 只是个标记，不是切点
```
`doScoreItemFuzzyMultiple` 里任意一片不命中就整体 `NO_ITEM_SCORE`（`score === NO_MATCH` 即返回）。

**b) 分隔符只决定"给谁打分"**，不决定切分：
```js
const preferLabelMatches = !path || !query.containsPathSeparator;
```
- `preferLabelMatches` 为真 → **只对 label（文件名）打分**；
- 否则 → 对 `` `${description}${sep}${label}` `` 拼接串打分，再把命中区间**拆回** label / description 两段
  （跨越拼接点的命中会被切开）。

**c) 排序用"互不重叠的分档基数"，不是乘法权重**（这是关键设计，比我之前的设计干净得多）：
```js
const PATH_IDENTITY_SCORE        = 1 << 18;   // 完整路径完全相同
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17; // 文件名前缀命中
const LABEL_SCORE_THRESHOLD      = 1 << 16;   // 文件名命中
```
文件名命中加 `LABEL_SCORE_THRESHOLD`，前缀命中加 `LABEL_PREFIX_SCORE_THRESHOLD` **外加**
`Math.round(query.length / label.length * 100)`（前缀占比越高分越高）。基数远大于模糊分本身，
所以"命中文件名"永远压过"命中路径"，无需调权重。

**d) 字符打分常数（`computeCharScore`，逐条核实）：**

| 项 | 分值 |
|---|---|
| 字符命中 | +1 |
| 连续命中 | `min(seq,3)*6 + max(0,seq-3)*3`（前 3 个每个 6，之后每个 3） |
| 大小写也相同 | +1 |
| `targetIndex === 0` | +8 |
| 前一位是 `/` 或 `\` | +5 |
| 前一位是 `_ - . space ' " :` | +4 |
| 词内驼峰大写（**仅当 `matchesSequenceLength === 0`**） | +2 |

> 注意：源码里注释掉的调试文本写的是 `*5`，**活代码是 `*6` / `*3`**。

**e) 打分是 DP 矩阵 + 回溯**，不是贪心：`doScoreFuzzy` 维护 `scores[]` / `matches[]`（连续长度），
带 `if (!diagScore && queryIndexGtNull) score = 0` 的**顺序约束**（保证查询字符必须在目标中按序匹配，
否则 "de" 会因词首加成错误命中 "ede"）。最后从矩阵右下角回溯出命中位置。

**f) 比较器次序（`compareItemsByFuzzyScore`）：**
1. `PATH_IDENTITY_SCORE` 最高
2. label 分档（`> LABEL_SCORE_THRESHOLD`）之间比大小
3. **更紧凑的命中区间优先**（`compareByMatchLength`，前缀匹配除外——前缀越长越好）
4. **更短的 label 优先**（`window` 查询下 `window.ts` 赢 `windowActions.ts`）
5. 比 label+description 分数
6. 有 label 命中的优先于只有 description 命中的
7. 比 `labelMatchDistance`（命中跨度）
8. 兜底：短 label+description → 短路径 → 字典序

**本设计采纳：a（空格 AND）、b（按需给路径打分）、c（分档基数）、d（字符常数）、f（比较器次序）。**

## 4. 设计定稿（design H）

综合上面证据：**照搬 VSCode 的结构与常数**（它已被验证能处理"不精确输入 + 文件名优先"），
再叠加本项目特有的需求（**目录片段筛选**、**额外根**、**高亮**）。

### 4.0 为什么是"照搬 VSCode"而不是继续自创

§5 记录了 A/B/D/E/G 五个自创方案全部在另一组用例上崩掉。VSCode 的常数是
`1<<16` 量级的**分档基数** + `computeCharScore` 的小整数，二者的量级关系已经决定了
"文件名命中 > 路径命中"，**没有需要我调的权重**。这是它比我的方案稳的根本原因。

### 4.1 匹配流程
1. `prepareQuery`：按**空格**切成 `values`，每片都必须命中（AND）。
2. 判断 `containsPathSeparator`（查询里有没有 `/`）：
   - 无 `/` → 先只对 **basename** 打分（`preferLabelMatches`）；
   - 有 `/`，或 basename 无结果 → 对 **完整相对路径** 打分。
3. 对**每个查询片**独立打分，任一片不命中则整条淘汰。

> 这样 `index.html ui` 的行为：两片都必须命中；`ui` 不在 basename 里，
> 于是回退到全路径打分，`.../_content/ui/coherent/bag/index.html` 命中 → 目录片段筛选生效。

### 4.2 字符打分（照搬 `computeCharScore`）
`+1` 字符；连续 `min(seq,3)*6 + max(0,seq-3)*3`；同大小写 `+1`；位置 0 `+8`；
前位 `/` `\` → `+5`；前位 `_ - . 空格 ' " :` → `+4`；词内驼峰（仅非连续时）`+2`。
**顺序约束**：非首片若无对角分则不产生分（保证按序匹配）。

### 4.3 排序（照搬 `compareItemsByFuzzyScore` 的次序 + 本项目补充）
1. 全路径完全相同 → `1<<18`
2. basename 命中的整体加 `1<<16`；basename **前缀**命中加 `1<<17` + `round(q.len/label.len*100)`
3. 命中区间更紧凑者优先
4. basename 更短者优先
5. 路径更短者优先
6. 兜底字典序（**保证稳定**）

### 4.4 性能（**已实测，含关键警告**）

| 方案 | 实测（Node，~100k/51k 项） | 结论 |
|---|---|---|
| fzf-V2 只打分 basename（带子串预筛） | **3–5 ms 中位数** | ✅ 可行 |
| **VSCode `scoreFuzzy` 直接打全路径矩阵** | **45–85 ms** | ❌ **会超 20ms 预算** |
| 本项目子序列试算（51,266 项） | 4.0 ms 中位数 / 9.1 ms 最大 | ✅ 可行 |

> ⚠️ **关键约束**：VSCode 的 `scoreFuzzy` 是 O(query × target) 的**完整矩阵**，
> 且它服务于 VSCode 的候选集（几百~几千项）。**直接对 5 万条完整路径跑这个矩阵会到 45–85ms，
> 不可接受。**
>
> 因此实现必须分层：
> - **第一层：廉价预筛**（basename 子串 / 大小写不敏感 indexOf），把候选砍到千级以内；
> - **第二层：对预筛后的候选跑 VSCode 式矩阵打分**（此时只对 basename，或对少数含 `/` 的查询打全路径）。
>
> 预筛必须**保守**（只做"一定不命中"的排除），否则会漏掉模糊命中。

### 4.5 高亮
打分同时保留命中位置（VSCode 的 `matches[]` 回溯 + `createMatches` 合并相邻），
随结果返回客户端，实现**多段高亮**（取代现在"只高亮 basename 里一整段"的做法）。

### 4.6 目录片段筛选（本项目特有需求）—— **范围决策**

**已确认的范围**：查询用**空格**分成多片，每片都必须命中（AND）。目录筛选通过以下方式生效：
- 查询片命中 basename → 按 basename 打分；
- 查询含 `/` 时按**完整相对路径**打分（VSCode 的 `containsPathSeparator` 规则）。

**明确不在本轮范围**：`index.html ui` 这种"无分隔符、想让 `ui` 去匹配目录段"的写法。
原因（**实测**）：

> `ui` 本身就是 `..._observer_index.html` 的**合法子序列**（u…i），
> 也确实是 `..._build_farm_index.html` 的子序列。算法**无法**知道用户指的是 `ui/` 目录。
> 要压住这些命中，只能给"目录命中"加权到超过"basename 子序列命中"，
> 但实测这么做（design H2/H3）会让 5 万项的查询中位数从 **3.9ms 涨到 76–129ms**，
> 而且**依然没修好**——因为那些 basename 命中的确是真实的。

结论：**目录筛选走 `/` 显式触发**（`ui/index.html` 或 `index.html ui/`），与 VSCode 行为一致。
"无分隔符自动猜目录"留作后续迭代（需要索引期预计算 + 子串预筛把性能压回来）。

### 4.7 高亮
打分同时保留命中位置（VSCode 的 `matches[]` 回溯 + `createMatches` 合并相邻），
随结果返回客户端，实现**多段高亮**（取代现在"只高亮 basename 里一整段"的做法）。

### 4.8 额外根（extraRoots）
额外根的条目路径是绝对路径，打分前**去掉根前缀**，只在根内相对路径上打分，
否则 `E:/cb2_master/dev/wolfgang/_games/proven_ground/_source/...` 这串与查询无关的前缀
会污染打分与命中位置（也影响高亮对齐）。显示时仍显示完整路径。

## 4.9 实测结论汇总（design H，即落地版本）

| 查询 | 期望 | 结果 | 说明 |
|---|---|---|---|
| `clntmod` | `client_module.cpp` | ✅ 第 1–2 行 | `client_module.h` / `.cpp` |
| `playerctrl` | `player_camera_controller` | ✅ 第 1 行 | 五个自创方案全部失败，H 首次命中 |
| `apprpc` | `app_rpc.nsd` | ✅ 第 1 行 | |
| `chronoevt` / `rendersys` | `chrono_events` / `render_system` | ✅ | |
| `evtmgr` | `event_manager` | ✅ 第 1 行 | `EventManager` |
| `client module` / `render system` | | ✅ | 空格 AND 生效 |
| `game scene lua` | | ✅ | 三片全命中 |
| `index.html` | | ✅ | 200+ 候选，按 basename 排序 |
| `rpc app nsd` | `app_rpc.nsd` | ✅ 第 1 行 | |
| `client module cpp` | `client_module.cpp` | ⚠️ 第 2 行 | 被 `.Build.CppClean.log` 压过 1 名 |
| `index.html ui` | `ui/...` | ⚠️ 见 §4.6 | 已知范围外 |

**性能：中位数 3.9ms、p90 8.5ms、最大 19.3ms（51,266 项）** — 满足交互预算。

## 5. 已验证的负结果（避免后来者重走）

以下设计**实测失败**，记录以免重复：

| 方案 | 结果 | 失败原因 |
|---|---|---|
| A 仅 basename 子序列 | 0 命中问题的确解决，但 `cm` 等高频词仍是垃圾堆 | 无结构、无权重 |
| B 整路径子序列 | `clntmod` 命中 `build/p/_meta/client/.../model` | 长路径累积意外匹配，无文件名权重 |
| D 段感知 + 平分权重 | `clntmod` 输给深路径 `xenon_client_module.dir` | 深度惩罚太弱，压不住整段全等的大分 |
| E 结构分层 + 字母表前缀 | `evtmgr` 输给 `chaos_editor_viewport_manager` | 1 字符词拿到 initialism 500 档，误命中 |
| G join 子词 + 长度归一化 | `clntmod` 输给 `chaos_lua_native_class_member_function_delegate` | 丢掉了精确子词档，全部退化到松散子序列，且 `covered*25` 奖励长名 |

**共同教训**：单靠手调常数会在另一组用例上崩。必须采用 VSCode/fzf 那种**分档 + 首字符惩罚 + 线性跳过惩罚**的组合，而不是自创归一化。

## 6. 实现状态（已完成）

- [x] host 侧匹配器 `src/match.ts`（VSCode 移植）
- [x] 接入 `src/index.ts`（`pathLower` 索引期预计算、分档排序、紧凑度平局）
- [x] client 侧多段高亮渲染（`quick-open.tsx` 的 `highlight()`，目录片段也高亮）
- [x] 移除已失效的客户端增量过滤与子串重排（模糊语义下不再成立）
- [x] 真实 Chaos 索引回归：**19/20 命中，中位数 7.4ms、最大 18.5ms**（51,266 项）
- [x] README 更新

### 实现期踩到的两个坑（值得记住）

1. **DP 矩阵缓冲区尺寸**：矩阵需要 `queryLength × targetLength` 格。首版按「最长字符串」开缓冲区，
   但真正的需求是**最大乘积**（10 字符的查询片打 10 字符的 basename 需要 100 格，
   而缓冲区按 83 字符的绝对路径只开了 83 格）→ 越界读 `Int32Array` 返回 `undefined` →
   `undefined + number = NaN` → **分数全变 NaN 但不报错**。修法：按 `最长片长 × 最长目标长` 开，
   并在查询开始前一次性分配、全表复用。
2. **别在热循环里分配**：修 NaN 时改成每次 `scoreEntry` 内部 `new Int32Array`，
   结果 5 万条 × 每次查询的中位数从 7.7ms **涨到 70ms**。缓冲区必须在查询级复用
   （`createMatchScratch`），这是"正确"和"可用"的分界。

## 7. 验收用例（真实 Chaos 工作区）

`scripts/verify.mjs` 用真实规则建索引后跑下列查询，当前 **19/20** 通过：

| 查询 | 期望 | 结果 |
|---|---|---|
| `clntmod` | `client_module` | ✅ |
| `playerctrl` | `player_camera_controller` | ✅ |
| `apprpc` | `app_rpc.nsd` | ✅ |
| `evtmgr` | `EventManager` | ✅ |
| `chronoevt` / `rendersys` | `chrono_events` / `render_system` | ✅ |
| `client module` / `render system` | | ✅ |
| `game scene manager` | `game_scene_manager` | ✅ |
| `rpc app` / `nsd app` / `rpc app nsd` | `app_rpc.nsd` | ✅ |
| `lua game scene` | `game_scene` | ✅ |
| `clientmodule` | `client_module` | ✅ |
| `index.html` | | ✅ |
| `client module cpp` | `client_module.cpp` | ✅ |
| `source/client/client_module` | `client_module` | ✅（路径查询 + 目录高亮） |
| `chaos client module` | `client_module` | ⚠️ 排在 2-4 名（全片命中 basename，属 VSCode 同等行为） |

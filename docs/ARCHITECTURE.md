# NarrateOS 业务流与领域数据契约规范 (ARCHITECTURE)

> **定位**：面向百万至亿字级规模、模型无关、与编程语言及运行时宿主完全解耦的通用长篇小说创作业务规范。
> **阅读指引**：领域词汇与裁决基线见 [`../ROADMAP.md`](../ROADMAP.md)；微观文风与静态门禁词典见 [`WRITING-CRAFT.md`](WRITING-CRAFT.md)；软件工程模块划分与开发计划见 [`DEVELOPMENT-PLAN.md`](DEVELOPMENT-PLAN.md)；外部论文与底座数据见 [`RESEARCH.md`](RESEARCH.md)。

---

## 1. 架构公理与三层职责分工

长篇小说创作兼具自由文学表达与严格因果约束：**已归档手稿是唯一剧情事实真源（`WAL`）**，而物理排他状态、时空可达性、视角认知边界与句法配额共同构成确定性护栏。

### 1.1 四大业务公理

1. **单模同构公理（Bootloader 吃脏活，运行时零分支）**：不在运行时区分“原创模式”与“同人模式”。无论是零基础一句话脑洞，还是几十万字外部同人设定包，一律在开书第 0 步（Bootloader）编译为标准作品工作区，运行时 100% 统一调度。
2. **缓存复用与净室解耦公理**：后台检索与离线整理利用前缀缓存低成本读取分级目录（压在 `<100K Tokens` 内规避长窗口阶梯溢价）；负责文学表达的执笔写手（Prose Writer）强制采用**无对话历史、零工具声明**的单轮净室调用，由可配置的窗口预算（`writer_token_budget`）配合分级降级链抑制注意力稀释与思考块污染。
3. **纯文本数据库与双粒度事务公理**：每部作品独立存放于各自的 `books/<slug>/` Git 仓库。定稿手稿为最高事实真源（支持人工直接编辑并通过 `Sync` 平账），实体档案与目录为派生物化视图（遵循**环境补集原则**：相邻章尾窗可见的临时站位与动作绝不重复抄录）。单章正文落盘与视图更新拆为两次独立原子提交，由预写相位锁（WAL）保障崩溃恢复一致性。
4. **审美与字面校验权责分离公理**：严禁轻量模型评判文学优劣或潜台词；凡确定性规则能判定的标签剥离、配额扫描、视角裁剪、外键可达性与原句存在性，一律收归零模型开销的确定性内核执行。

### 1.2 三层执行单元矩阵

仅 `Planner` 与 `Prose Writer` 共享同一强模型创作前缀池；`Librarian`、`Fact Checker`、`Dreamer` 的前缀池物理独立，天然支持配置**跨厂商异构模型互相挑刺**以对冲单一模型的预训练盲区。

| 执行单元 | 能力档位 | 窗口特征 | 核心职责与输出契约 |
| :--- | :--- | :--- | :--- |
| **确定性内核** | 纯规则逻辑 | `0 Token` | 动静保序拼装前缀、可用声纹 `tag` 枚举透传与同标签内 `LRU` 轮换、超预算按需降级裁剪（自动挂载上一章 `L2` 摘要与尾窗）、POV 底牌与 `director_rationale` 物理剥离、`WARPED` 灰象剥离、`story_day` 偏序过滤、跨称谓 `ripgrep` 回表、静态文风配额扫描、开书大纲厚度与新建实体 `canonical_name` 强校验、固有属性写保护与外键校验、WAL 双粒度提交、`Sync` 哈希检测、伏笔配额硬锁（`ACTIVE <= 15`）与零模型遥测采集 |
| **1. Librarian 选页员** | 轻量快模型 | `<100K` | 通读多级目录索引、词条摘要、实体别名列表、当前局势与上一章尾窗，输出本章所需的 `lore_library` 词条文件名、需唤醒的冷宫旧实体 ID 及需回表的原稿查询条件 |
| **2. Planner 章节导演** | 旗舰强模型 | 单轮净室 | 零工具声明（与写手共享静态前缀），结合卷纲刻度、`open_threads.md`、多轨触发 `future_horizon.md`（含 `WARPED` 偏转推演）、前台切镜信号与圆谎纸条，输出结构化细纲：内部全知因果推演 `director_rationale`（对写手物理屏蔽）、本章实质预期偏差 `chapter_turn`、`timeline_mode`、弹性字数、`focus_cast / background_cast` 划分、匹配池内标签的 `preferred_voice_tag`、收尾节拍及面向写手的纯表面镜头单 `outline_text` |
| **3. Prose Writer 写手** | 旗舰强模型 | 单轮净室（受 `writer_token_budget` 管控） | 零工具单轮生成：头部输出 100 字 `<blocking>` 空间走位自检，随后基于纯表面镜头单 `outline_text` 输出停在具象感官画面的纯净章节正文（或针对违规段落输出定点 `Patch` 替换块） |
| **4. Fact Checker 核查兵** | 轻量/异构模型 | 单章局部窗口 | **零审美评判**；锁定最新单章草稿核对物理伤残红线、视角认知越界、专有名撞车、显式数字算术闭合，以及是否违反 `current_arc_envelope.md` 的阶段天花板禁区（`Stage Ceiling` 违规直抛 `PLAN_CONFLICT`），并提交双侧原文子串供内核做去标点存在性验真 |
| **5. Extractor / Dreamer** | 旗舰/异构强模型 | 单章提取 / 离线整理 | 单章定稿后由 `Extractor` 输出行级状态补丁（含揭秘章后的 `OMNISCIENT_SECRET -> PUBLIC/READER_KNOWN` 翻转）、`L2` 章卡摘要、`world_state` 局势更新及 2~3 条下一章候选推进方向 `next_chapter_options`；达水位时触发离线 `Dreaming` 清洗脏实体页、盘点 `open_threads.md` 立项与 `RESOLVED` 销账、滚动补货 `future_horizon.md`、归档过期死元组、抛 `Spotlight Trigger` 并执行跨章连续性三级自动自愈；卷末达标时执行五步原子换卷 `advanceVolume` |

---

## 2. 作品工作区纯文本数据库结构与原子事务协议

每部作品的全部设定、索引、实体视图与手稿真源均以 **UTF-8 纯文本（Markdown / YAML / JSONL）** 存储在独立的 `books/<slug>/` Git 仓库中：

```text
books/<book-slug>/                 # 独立 Git 仓库（与引擎源码物理隔离）
├── world/
│   ├── book_config.yaml           # [作品可配变量] 窗口预算、自动回滚阈值、craft_plugins、异构模型路由表
│   ├── static_base_and_voice.md   # [静态前缀 #1] 世界底层法则、空间连通拓扑、抽象句法纪律（整卷零变动）
│   ├── current_arc_envelope.md    # [静态前缀 #2] 当前卷纲要、冲突烈度边界与阶段锁（换卷更新）
│   ├── voice_samples.yaml         # [动态声纹池] 0~N 条自由标签短句法标本（按 LRU 轮换挂载）
│   ├── ops_style_amendments.md    # [动态首段] 卷中新增的长期风格修订（换卷合入前缀 #1）
│   ├── world_state.md             # 全局当前日历锚点（含整数 story_day）与宏观局势摘要
│   ├── future_horizon.md          # 世界默认惯性表（统一承载原创倒推拐点与同人 T0 后预定事件）
│   └── open_threads.md            # 跨卷必收伏笔台账（含唤醒条件与冷档指针，永不被 L0 折叠裁除）
├── lore_library/
│   └── lore_*.md                  # 静态世界书词条库（仅由 Librarian 挑页挂入动态尾部，严禁前插击穿缓存）
├── index/
│   ├── L0_sagas.md                # 纪元折叠总表（每满 10 卷封存一纪元，支撑亿字级收敛）
│   ├── L1_volumes.md              # 活跃卷级总表（记录卷名、地图舞台、story_day 跨度与收束结果）
│   └── L2_cards/
│       └── vol_01_cards.md        # 按卷分片双轨章卡（主干剧情 + 反常异象锚点与节拍指纹）
├── entities/
│   ├── char_001.md                # 不可变 entity_id 命名：四段式角色病历与欠条视图
│   ├── item_001.md                # 唯一性关键证物/道具视图（普通消耗品与未转正路人不建独立文件）
│   └── cold_archive/              # 退场休眠角色、过期 WARPED 归档与主角旧纪元分片履历
├── manuscripts/
│   └── ch_0001.md                 # [WAL 唯一真源] 剥离工程标签后的章节定稿（支持人工直接编辑）
└── .ops/
    ├── tx_state.json              # 原子事务预写相位锁（WAL）与章节 SHA-256 指纹表
    ├── signals.jsonl              # 外部微调指令、圆谎纸条与 Spotlight Trigger 队列（安全点消费）
    ├── parallel_deltas/           # PARALLEL 并行时间线窗口内的分支状态增量暂存区
    ├── chapter_outlines/          # 章节规划快照：ch_XXXX.json 存该章最终实际使用的 PlannerOutline
    └── telemetry.jsonl            # 每章零模型开销采集的健康度与缓存遥测流水
```

### 双粒度 Git 提交与 WAL 崩溃恢复契约

单章落盘严格拆分为两次独立原子提交，由 `.ops/tx_state.json` 记录相位（`DRAFTING -> FEAT_COMMITTED -> STATE_COMMITTED -> [DREAM_COMMITTED]`）：

1. **正文真源提交**：`feat(ch-0045): settle manuscript`（写入 `manuscripts/ch_0045.md` 并登记正文 `sha256`；本章最终实际使用的细纲快照 `.ops/chapter_outlines/ch_0045.json` 同笔落盘并纳入既有写集恢复）。
2. **物化视图提交**：`state(ch-0045): update entity pages & L2 card`（行级补丁过完固有属性锁与 1ms 外键可达性检查后提交；达离线水位时追加独立的 `dream(ch-0045)` 提交）。

**崩溃恢复**：若进程在 `FEAT_COMMITTED` 后中断，重启自检自动跳过正文生成，直接重入 `Extractor` 补齐 `state` 提交；对 `HEAD` 若仅状态提取有瑕疵，可单独回退 `state` 重算视图而无损保留正文。

**细纲规划快照契约**：`.ops/chapter_outlines/ch_XXXX.json` 仅是规划快照，正文仍是唯一剧情真源；快照不投回写手、不作为剧情事实。改纲 (`PlanConflict` v2) 后持久化最终实际使用版本；`FEAT_COMMITTED` 崩溃恢复沿已存快照继续抽取，不重新调用 Planner；`Sync` 手改重提交不覆盖原快照；PARALLEL 各支线按全局唯一章号落盘，互不串纲。旧章未留存快照时读取端明确返回 `missing`（不捏造、不调用模型补历史）；快照损坏或非法返回 `error` 且正文仍可审阅。插件 `GET /api/narrate/chapter` 据此返回 `outlineText: string | null`（完整 PlannerOutline JSON 字符串）与 `outlineStatus: 'available' | 'missing' | 'error'`。

---

## 3. Step 0 四阶段开书统一引导编译 (Bootloader)

遵循**非对称复杂度预算（重初始化、轻单章推进）**，开书第 0 步通过四阶段流水线将一句话原创种子或外部万字设定包统一编译为第 2 节标准文件集：

### 3.1 Step 0：模型分词率实测标定 (`calibrateTokensPerChar`)
向当前配置的 `strong_creative` 模型发送标定短样本，依据实测返回的 `usage.inputTokens / text.length` 动态计算 `tokens_per_char` 系数写入 `world/book_config.yaml`。

### 3.2 Phase 1：脱离 JSON 枷锁的纯文本深推演（三维正交叙事坐标定标）
针对零基础或单薄原创种子（`original` 模式），先在纯文本空间完成高密度长篇构思，避免 JSON 语法对齐挤占模型创意注意力：

1. **Phase 1A（三维正交叙事坐标定标 + 反俗套 3 选 1 切口）**：
   摒弃有交叉重叠与流派遗漏的平面题材分类，由 `strong_creative` 模型在三个正交维度上为作品定标并组合推导大纲策略：
   - **维度 1：结构拓扑轴（故事如何分块推进）**
     - `连续递进式`（如《诡秘之主》《凡人修仙传》）：按小生态位到大生态位规划 `L1_volumes.md` 分卷阶梯、换图驱赶危机与跨地图常驻锚点（组织/信物/宿敌）；
     - `单元巡礼式`（如《虫师》《无限流副本》《单元刑侦》）：`L1` 按独立闭环单元/副本规划，另设一条跨单元缓慢推进的主角心境或主线暗流；
     - `多线群像交织式`（如《冰与火之歌》《群像权谋》）：初始化多名 POV 角色，预设阵营并行时钟与汇合节点。
   - **维度 2：核心张力源（读者为何翻下一页，支持组合配比）**
     - `认知信息差`（悬疑真相 / 规则怪谈禁忌 / 迪化错位喜剧）：强制启用**里表双账本**——悬疑将幕后真相存入 `OMNISCIENT_SECRET`，迪化喜剧将主角真实意图存入 `SELF_ONLY`、外界脑补误解存入 `PUBLIC`；
     - `目标与生存阻力`（升级 / 种田基建 / 荒野求生 / 竞技）：建立力量或资源**代价阶梯**与问题树链式反应（上一阶段破局手段成为下一阶段系统危机的导火索）；
     - `关系与情感极性`（言情 / 宅斗权谋 / 救赎复仇）：建立 4~6 名核心角色的**关系极性翻转矩阵**（试探利用 -> 被迫同盟 -> 底牌决裂 -> 终局重塑）。
   - **维度 3：终局形态轴（故事如何收束）**
     - `收敛闭环型`（有唯一终极谜底或宿命决战）：启用**终局倒推法**，先锁死 `Day -inf` 底层真相与终局收束条件再倒推第 1 卷；
     - `开放演进型`（按生态或单元持续衍生）：锁死世界底层生态循环铁律，卷末基于未结伏笔滚动派生新卷。
   - 显式拉黑该坐标组合下最平庸的 3 种套路走向，生成 3 组高张力候选切口。
2. **Phase 1B（双轨拍板：`interactive` vs `auto_best`）**：
   - `interactive` 模式供人类作者挑选、混搭或增补批注；
   - `auto_best`（无头 CLI / YOLO）模式由异构 `audit` 模型按冲突燃料密度与反俗套度自动择优。
3. **Phase 1C（扩写纯文本《全书架构圣经》）**：
   围绕选定切口推演出 5 大模块：① 里账本底层真相与代价定律；② 全书母题（`L0_sagas.md`）与 3~5 卷递进蓝图（`L1_volumes.md`）；③ 第 1 卷三幕拐点、**开篇第 1 章具象点火器（`Ch.01 In Medias Res Hook`）**与**本卷阶段天花板（`Stage Ceiling` 禁区）**；④ 4~6 名带底牌与默认行动轨迹（`Default Trajectory`）的核心角色；⑤ 首批跨卷伏笔与近期外部世界动态。

### 3.3 Phase 2：三把手术刀结构化分拣编译（原创与同人 `fanfic` 汇合点）
将 Phase 1 产出的纯文本圣经（或 `fanfic` 模式的外部设定集）按三把手术刀切入结构化槽位：
1. **视角刀（建立里表双账本，防写手剧透）**：表象与公开局势标为 `PUBLIC`，角色私密执念与主观误判标为 `SELF_ONLY`，尚未揭晓的真凶身份、世界终极秘密与诡计底牌强制标为 **`OMNISCIENT_SECRET`**，桌下炸弹悬念标为 `READER_KNOWN`。
2. **时序刀（以开局锚点 `T0 / story_day = 0` 为界）**：`story_day <= 0` 的既成事实归入 `entities/*.md` 与 `lore_library/*.md`；`story_day > 0` 的未来预定动态彻底剥离进 `world/future_horizon.md`（附成立前提 `Premise`、章节窗口 `after_ch` 或 `storyDay`）。
3. **冰山刀（10% 水上常驻 vs 90% 水下按需挑页）**：10% 核心法则与抽象句法纪律写入 `world/static_base_and_voice.md`（总长硬锁 `<=1,500 字`）；90% 派系、历史、高阶规则拆为独立 `lore_library/lore_*.md`；同时按 **4~5 类核心场景标签 × 每标签至少 3 句异构句法标本（共 12~15 句）** 生成 `voice_samples.yaml`。

### 3.4 Phase 3 & Phase 4：三重门禁安检与标准库落盘
编译产物落盘前依次通过三道自动安检（任一未过则附错误清单回炉重跑 Phase 2）：
1. **确定性配额与 `T0` 泄露扫描（`0 Token`）**：Zod 与代码直接硬校验 `entities.length >= 4`、`L1` 卷数 $\ge 2$、每类声纹标签标本数 $\ge 2$、含信息差维度时必有 `OMNISCIENT_SECRET`，并拦截 `entities` 中任何 `storyDay > 0` 的未来穿越项；
2. **声纹标本门禁清洗（`0 Token`）**：将 `voice_samples.yaml` 全部过一遍 `Static Prose Gate`，剔除含 AI 八股词的劣质示范句；
3. **异构语义剧透与守恒盲审（`audit` 模型）**：扫描所有 `PUBLIC` 文本是否在语义上变相泄露了 `OMNISCIENT_SECRET` 底牌，并校验同人设定包专有名词与核心事实召回率 `>=98%`。
全部通过后写入 `books/<slug>/` 标准目录树，初始化 `.ops/tx_state.json` 并完成初始 `chore(boot)` Git 提交。

---

## 4. 前缀装配、补集视图与确定性检索契约

### 4.1 强/弱双独立前缀池、灰象双视图与按需降级链

1. **旗舰强模型创作池（`Planner` + `Prose Writer` 共享首部前缀）**：
   - **静态前缀区（整卷零字节变动）**：统一零工具声明 + 共享系统基准指令 + `static_base_and_voice.md` + `current_arc_envelope.md`。
   - **动态尾部区**：`ops_style_amendments.md` + 本章任务指令（`Planner` 按需挂载 `craft_plugins` 与 `future_horizon`；`Writer` 挂载结构化细纲与 `LRU` 抽出的 1 条 `voice_samples` 标本）+ 挑出的 `lore_library` 词条 + 经 POV 与时间线裁剪后的出场实体视图 + 相邻章衔接文本 + 短期信号。
2. **轻量快模型检索池（`Librarian` 阶梯前缀）**：
   - **静态前段（整卷零重写）**：固定检索声明 + `lore_library` 摘要目录 + `L0_sagas.md` + `L1_volumes.md` + **已封卷旧卷章卡 `vol_01..{k-1}_cards.md`**。
   - **动态末段**：仅追加每章变动的**当前活跃卷 `vol_k_cards.md`** 与 `open_threads.md`，消除每章重写击穿全量目录缓存。
3. **`WARPED` 灰象双视图隔离（防粉红大象词法反噬）**：
   - 当 `future_horizon.md` 中的原著或旧大纲事件因前提破灭翻转为 `WARPED` 时，仅向 `Planner` 暴露废止原委，由 `Planner` 排定占满同一时空槽位的**正向排他事件**；
   - 内核为 `Prose Writer` 拼装输入时，**物理剔除一切 `WARPED` 条目及废止原著词**，确保写手窗口内只存在正向具体戏码。
4. **可配置预算分级降级链（Context Eviction Pipeline）**：
   - 写手窗口上限由 `book_config.yaml` 中的变量 `writer_token_budget` 控制（未配置或未超标时完整放行，不截断群像大戏）；当拼装后超出设定预算时，按固定优先级逐级压缩直至达标：
     ① 将无缝续场的“上一章全文”降级为「上章结构摘要 + 末尾原文窗口」；
     ② 将 `background_cast` 旁观角色压缩为单行简卡（仅留姓名、先天物理红线、当场位置与口癖）；
     ③ 缩减 `L3 ripgrep` 回表切片数量；
     ④ 缩减 `lore_library` 挂载词条数量。

### 4.2 四段式实体档案（补集原则）与 POV 物理剥离

实体档案严格遵循**环境补集原则**：凡相邻章尾窗和 `L2` 主干一眼可见的当场站位与临时交谈动作一概不记，仅记录翻篇后原文不可见的跨章不变量。所有时序条目携带整数日历 `story_day`（`T0 = 0`，开局前历史为负数）：

```markdown
---
entity_id: char_002
canonical_name: 神代雪乃
unique_aliases: ["雪乃", "冰山副会长", "神代大小姐", "神代同学"]
contextual_titles: ["副会长", "风纪委员长", "铁血委员长", "学姐"]
historical_anchors: ["ch_0002:四楼锁窗女生"]
last_seen_ch: 45
---

## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)
- [vis: SELF_ONLY] 极度怕黑，无光源密闭环境下无法独自行动 [锚点 ch_0008]
- [vis: PUBLIC] 右手腕内侧有旧烫伤浅疤

## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)
- [day:12 | ch:45 | vis: PUBLIC] 持有物：item_001（黄铜钥匙）；驻留节点：学生会室
- [day:5 | ch:16 | vis: SELF_ONLY] 主观认知偏差：误信琉璃台词谎言，以为《月光》旧琴谱已烧毁
- [day:-1095 | ch:01 | vis: OMNISCIENT_SECRET] 隐藏底牌：三年前亲手锁死四楼音乐室真相
- [Tracked Numeric Ledger] 社团剩余经费: 1200日元 | 备用钥匙数: 1

## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)
- [day:-1095 | ch:21] (插叙揭露) 曾在四楼音乐室门框悬挂风铃
- [day:0 | ch:01] 签发废部通知，立下周五核查赌约
- [day:3 | ch:10] 从男主手中收回黄铜钥匙锁入铁柜

## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)
- [day:12 | ch:44] 发现铁柜锁舌新划痕，确认钥匙仍在
- 对话声纹：句式工整克制，禁用流行俚语，习惯拿校规掩饰真实意图
  > 标本：「我只是按章办事。至于六点以后谁去四楼锁窗，排班表恰好翻篇了。」
```

- **POV 可见性物理剥离与细纲信道隔离（防二道贩子泄底）**：
  - 拼装写手上下文时，`ViewSlicer` 对非当前 `pov_character` 物理剔除所有 `vis: SELF_ONLY`，并对所有角色无条件物理剔除 `vis: OMNISCIENT_SECRET` 条目；仅 `vis: READER_KNOWN` 条目转化为 `[仅读者已知的戏剧张力点]` 注入细纲。
  - 为防止 `Planner`（拥有 `OMNISCIENT_SECRET` 全知视角）在生成细纲时将幕后底牌顺手写进 `outline_text` 间接泄露给 `Writer`，`PlannerOutlineSchema` 强制拆分为 **`director_rationale`（导演全知因果内参，拼装写手请求时由内核物理丢弃）** 与 **`outline_text`（面向写手的纯表面动作与感官指令单，未达揭秘节点前严禁写入任何 `OMNISCIENT_SECRET` 解释）**。
- **`OMNISCIENT_SECRET` 解密翻转（Declassification）闭环**：
  - 当剧情推进至满足卷纲或 `future_horizon.md` 条件的正式揭秘章时，`Planner` 将本次揭晓的真相细节写入 `outline_text` 交由 `Writer` 正面呈现；
  - 揭秘章定稿后，第 6 步 `Extractor` 通过 `upsert_slot` 将该底牌槽位的 `visibility` 从 `OMNISCIENT_SECRET` 正式翻转为 **`PUBLIC`**（全员皆知）或 **`READER_KNOWN`**（仅在场者与读者知晓），确保后续章节的 `Writer` 正常继承该既成事实而不发生“揭秘后失忆”。
- **PR 式入库门禁、别名归并与路人缓建档**：`Extractor` 仅输出结构化行级补丁（严禁整文件覆写防丢失更新），经内核校验固有属性锁、新建实体必填标准中文 `canonical_name`、台词谎言分流与外键可达性后入库；向 `Librarian` 与 `Extractor` 展示可用实体列表时同行拼入 `unique_aliases` 与 `contextual_titles`（引导揭晓马甲时调用 `add_unique_aliases` 归并原卡，严禁重复建卡）；单章临时路人未跨章复现且未关联 `open_threads.md` 前，仅记于 `L2` 备注而不新建独立 `entities/char_*.md` 文件。
- **跨纪元分片收敛**：每满 10 卷触发 `L0` 折叠时，常驻角色旧纪元第 3 区变迁史切分归档至 `cold_archive/char_XXX_saga_YY.md`，主卡第 3 区仅留终身核心烙印与当前纪元履历，未完结跨卷伏笔常驻 `open_threads.md`。

### 4.3 `L0-L3` 分级目录与成对 `ripgrep` 回表

1. **双轨 `L2` 章卡**：每章拆为 `主干剧情` 与 `反常异象、专有锚点及节拍指纹`，保护草蛇灰线不被常规摘要洗掉。
2. **跨称谓 `L3` 原稿回表**：展开 `canonical_name + unique_aliases + historical_anchors` 全文毫秒扫描；对通用职务称谓 `contextual_titles`，限定在 `L2` 已标出该角色出场的章节集合内执行 **`rg -C 2`（上下各 2 段窗口）**，所有返回切片顶部硬套强制时间差信封：`[出自第 03 章 (day:1) | 距当前第 45 章 (day:12) 已过 42 章 / 11 天 - 历史现场非当前归属]`。
3. **伏笔与证物成对挂载**：凡触及 `open_threads.md` 回收、唯一道具重现或故地重游的章节，强制校验同时挂齐「实体/设定视图 + 至少 1 段 `L3` 原稿切片」。

---

## 5. 单章生产闭环、手改同步与三态时间线

### 5.1 弹性章长与双关审校内环

单章字数由 `Planner` 按戏核分量在弹性区间（参考 `1,800-6,500 字`）自由设定，不卡僵硬百分比。

```mermaid
flowchart TD
    L["1. Librarian 检索选页 + 成对回表校验"] --> P["2. Planner 生成细纲 (含 focus/background 划分与收尾节拍)"]
    P --> K["3. 内核保序拼装 + POV/灰象剥离 + LRU 抽声纹 + 按需预算裁剪"]
    K --> W["4. Prose Writer 净室单轮执笔"]
    W --> G["5. 第一关: Static Prose Gate (0 Token 可开关规则表)<br/>剥离 blocking + 八股配额/跨章喻体复读行号检出"]
    G -- "<=2 段局部超标" --> Patch["定点局部修补 Patch (仅传违规段上下窗口)"]
    G -- "通过" --> C["6. 第二关: Fact Checker (字面核查)<br/>物理红线 / POV 越界 / 算术闭合 + 双侧原句去标点验真"]
    C -- "<=2 段局部穿帮 (限 2 轮)" --> Patch
    Patch --> G
    C -- "多处崩坏 (限 1 次)" --> Rewrite["丢弃废稿整章重生成"]
    Rewrite --> G
    C -- "细纲级物理悖论" --> Replan["抛 PlanConflictException 退回 Planner 改纲 v2 (限 1 次)"]
    Replan --> K
    C -- "细纲 v2 仍失败" --> Halt["SAFE_HALT: 写入诊断快照挂起告警"]
    C -- "全部通过" --> Commit["WAL 双粒度提交: feat 正文真源 -> Extractor + PR 门禁 -> state 视图"]
```

### 5.2 人机共驾与手稿真源增量同步 (`Sync`)

人工可直接用任意文本编辑器修改已归档的 `manuscripts/ch_*.md`。引擎在下一轮运行前或显式触发 `Sync` 时，比对 `.ops/tx_state.json` 中的章节 `sha256` 指纹：
1. **最新章手改**：提取 `git diff`——若仅涉字词文笔润色（无剧情事实与状态变动），零模型开销更新指纹直接放行；若涉物品转移、伤势或台词事实变更，增量调用 `Extractor` 刷新对应实体与 `L2` 视图并提交 `state(sync)`。
2. **历史旧章手改（后续已有归档章节）**：刷新该章增量视图后，对下游章节执行**只读连续性冲突扫描**，精准报出受波及的下游章号与行号供作者定夺，**严禁后台静默篡改下游手稿**以防后期状态反向穿越污染。

### 5.3 三态时间线读写隔离沙盒 (`timeline_mode`)

| 模式 | 适用场景 | 起草挂载裁剪规则（确定性执行） | 归档状态写回规则 |
| :--- | :--- | :--- | :--- |
| **`MAINLINE`** | 常规顺叙推进 | 挂载 `Innate Locks` + 可见 `Acquired State` + 变迁履历 + 近期缓冲 | 行级更新第 2-4 区并推进 `world_state.md` 的 `story_day` |
| **`PARALLEL`** | 同一时间窗切换异地多视角 | 开启窗口自动打标签 `git tag parallel-fork-{id}`；各支线均读取分叉起点纯净快照并共享只读全局环境广播表 | 支线状态增量暂存 `.ops/parallel_deltas/`，**冻结 `world_state.md` 主线 `story_day` 重复累加**；限期内汇合执行显式 3-Way Merge（硬拦截唯一道具双线冲突）并统一推进主时钟 |
| **`FLASHBACK`** | 插叙过往回忆或倒叙 | 保留 `Innate Locks`（先天红线永不屏蔽）；**物理屏蔽当前 `Acquired State` 与近期缓冲**，仅挂载 `day < target_day` 的历史履历 | **严禁覆写当前 `Acquired State` 或推进主线 `story_day`**；新揭露往事仅带历史 `story_day` 追加至第 3 区履历与相关知情者认知层 |

### 5.4 阅读节奏控制、候选方向接力 (`next_chapter_options`) 与 `Plot-Haystack` 验收探针

- **六项戏剧质感与连跑接力锚点**：
  1. **戏眼与实质波折（`chapter_turn`）**：单章最多 1-2 个连续物理场景，明确唯一慢放戏眼（`Spotlight`），并在细纲强制填写无题材偏见的 `chapter_turn`（本章发生的实质预期偏差、代价或关系偏移，拒绝零阻力顺水推舟）；
  2. **桌下炸弹**：将 `READER_KNOWN` 信息差转化为戏剧反讽悬念提示；
  3. **重逢唤醒**：`current_ch - last_seen_ch > 30` 时自动注入半句感官特征唤醒读者记忆；
  4. **前章衔接与降级摘要**：时空紧接章挂载上章完整原文，超 `writer_token_budget` 触发第 1 级降级时自动组合 `vol_XX_cards.md` 中的上章一句话摘要与末尾 600 字尾窗；第 1 步 `Librarian` 自动附加上章尾窗与当前局势摘要防漏选新出场词条；
  5. **三态收尾**：支持 `HOOK / AFTERGLOW / CLOSURE` 三态收尾切换，底线停在具象画面；
  6. **章末候选推进方向（`next_chapter_options`）**：第 6 步 `Extractor` 定稿抽取时结合 `current_arc_envelope.md` 顺手产出 2~3 条具象的下一章推进选项（`0` 额外调用），在人机共驾模式下供作者一键点选，在 YOLO 连跑模式下直接作为下一章输入交由 `Planner` 择优展开。
- **40 章盲测基准（`Plot-Haystack Benchmark`）**：在 Ch.01-05 预埋 10 枚探针（3 组得而复失极性反转、3 条低语义关联负向红线、2 处台词谎言信息差、2 个跨 35 章反常闲笔），于 Ch.36-40 检验穿帮率、成对召回率、缓存命中率与词汇保持率。

---

## 6. 周期睡眠整理 (`Dreaming`)、伏笔销账、换卷交接 (`advanceVolume`) 与跨章自愈

### 6.1 按脏页增量 `VACUUM`、伏笔台账盘点与前台切镜触发 (`Spotlight Trigger`)

当累计新增定稿字数或活跃实体第 4 区缓冲达到配置水位时（卷中 40%-60% 死亡谷区间加密里程碑核对），触发离线 `Dreaming`：
1. **按脏页局部清洗**：仅读取并压缩近期出场攒满脏缓冲的实体页（将其关键转折带原文锚点提炼入第 3 区，未出场干净档案零读取零重算）；
2. **跨卷伏笔台账周期盘点（`open_threads.md`）**：单章轻量 `Extractor` 不直接修改 `open_threads.md`（防琐碎动作乱挖坑与早泄误销账）；统一由 `Dreaming` 对照近期多章 `L2` 章卡语义盘点——将已彻底兑现的伏笔翻转为 `status: RESOLVED` 移入归档区，立项跨章新悬念（内核硬锁单次新增 `<=2` 条、全局 `ACTIVE` 活跃伏笔总数 `<=15` 条）；
3. **死元组归档与 `future_horizon.md` 滚动补货**：核对 `future_horizon.md` 翻转破灭节点为 `WARPED`，将已过时间窗（默认 3 天）的 `WARPED` 死元组移入 `entities/cold_archive/warped_horizon.md`，长期退场角色移入 `entities/cold_archive/`，并根据离场角色待办目标滚动补充近期外部世界惯性节点；
4. **离场角色幕后推进与前台镜头原则（`On-Screen Principle`）**：
   - 不设主配角身份限制，平等支持单主角与多主角群像叙事；
   - 对近期未出场但挂有待办目标的重要角色，后台仅顺延其筹备或位移进度；一旦蓄力抵达**即将改变局势或引爆重大冲突的临界点**，严禁在后台用一行状态更新偷偷结算（防“幕后杀青”），改为向 `.ops/signals.jsonl` 抛出 **`Spotlight Trigger`（前台切镜信号）**，在下一章安全点自动并入挂载实体列表并注入 `Planner`（优先触发前台碰撞介入主线现场，必要时切视角或开启 `PARALLEL` 线）。

### 6.2 跨章穿帮三级全自动梯度自愈（默认零人工打扰）

离线连续性审计上报疑似冲突时，内核先执行**双侧原句去标点存在性代码验真**与中间章节合法转移记录核查（捏造引文或已合法转移的误报直接静默丢弃），实锤问题按影响范围三级自动处置：

1. **软微瑕（天气体感口误、次要环境微差）**：自动投递短期 `Retcon` 信号，由下一章顺嘴圆回，**0 停机**。
2. **单点硬穿帮（生死/唯一物/地理硬冲突，但下游章节未依赖该错误事实）**：自动对穿帮章节违规段执行局部 `Patch` 并调用 `Sync` 刷新视图，**0 停机、0 废章静默自愈**。
3. **连带支线硬穿帮（下游章节建立在该错误事实之上）**：对照 `book_config.yaml` 中的变量 `max_auto_rollback_chapters`：
   - **波及章数 `<=` 阈值**：自动创建 `git tag` 备份快照留底，随即 `git reset` 回冲突前章节并附修正约束自动重跑（**0 停机**）；
   - **波及章数 `>` 阈值（或自动重跑 1 次仍死锁）**：触发 `SAFE_HALT` 挂起，仅输出确定性物理量报告：**`冲突双侧行号 + 需回退重写章数与总字数`**。

### 6.3 零模型健康度遥测与安全点信号消费

每章定稿后纯规则采集指标写入 `.ops/telemetry.jsonl`：细纲重排率（`replan_rate`）、语言退化四联指标（**`MATTR-500`** + **Kontoyiannis 非参数熵率 $\hat{H}_K$** + **句段长变异系数 CV** + **AI 八股千字命中密度**）、故事时钟推进与节拍冷却指纹、以及实耗 Token 与缓存命中率。外部指令仅在双粒度 Git 提交全部落盘后的 **Safe-Point（安全间隙）** 分拣消费。

### 6.4 卷域包络天花板 (`Stage Ceiling`) 与五步原子换卷交接 (`advanceVolume`)

每卷的 `world/current_arc_envelope.md` 固定包含四要素：① 本卷舞台与主冲突；② 三幕帐篷桩（开局切口 -> 中盘翻转 -> **卷末收束标志事件**）；③ **本卷阶段天花板（`Stage Ceiling` 禁区，严禁提前揭露的高层底牌与进度上限）**；④ 跨卷过渡钩子与常驻锚点。

当章节达到本卷跨度窗口且 `Dreaming` 确认卷末收束标志事件已完成（或由作者显式触发）时，执行低频的 **`advanceVolume` 五步原子交接**：
1. **封存旧卷账本**：将第 $k$ 卷实际收束摘要与 `story_day` 跨度写回 `index/L1_volumes.md`，打上 Git 标签 `arc-seal-vol-{k}`；旧卷 `index/L2_cards/vol_{k}_cards.md` 自动转为 `Librarian` 只读静态前缀，新建 `vol_{k+1}_cards.md`；
2. **旧地图角色冷宫归档**：除明确随行进入下一卷的同伴外，将旧地图非随行角色批量移入 `entities/cold_archive/`（跨图羁绊通过信物、组织或未结伏笔传承，后续返场时由 `Librarian` 唤醒）；
3. **提炼合入风格修订**：将本卷 `.ops/style_amendments.md` 去重提炼（`Condense`）后合入 `world/static_base_and_voice.md`（总字数硬锁 `<=1,500 字`）并清空修订表；
4. **完结封笔裁决 vs 下一卷包络编译**：
   - **完结封笔**：若已走完 `L1_volumes.md` 终局卷且作者未要求续写新卷，将剩余开放悬念标记为 `status: OPEN_ENDING` 封存，打上 `novel-completed` Git 标签；
   - **新卷展开**：依据 `L0_sagas.md`、`L1_volumes.md`、存活角色状态及 `open_threads.md` 中遗留的未解高层伏笔，编译生成第 $k+1$ 卷的 `current_arc_envelope.md`（含新地图驱动危机、跨图锚点与新阶段天花板）及新一批 `future_horizon.md` 事件，并校验不与已封卷历史及角色第 3 区不可逆履历冲突；
5. **推进卷游标并提交**：将 `world_state.md` 的 `current_volume` 加 1，执行独立 `chore(volume): advance to vol_{k+1}` Git 提交。

---

## 7. 内核常量与可配变量总表

| 分类 | 固化的机制常量（跨书跨模型恒定） | 开放的可配变量 / 模型自决项（见 `book_config.yaml`） |
| :--- | :--- | :--- |
| **窗口与缓存** | 单轮零历史零工具净室调用；双独立前缀池动静分层；四级按需降级链顺序 | `writer_token_budget`（可按模型设定或置空直通）、各工种异构模型路由映射 |
| **记忆与实体** | 手稿 `WAL` 真源地位；四段式补集结构；`story_day` 整数偏序；POV 四级物理剥离；PR 入库锁与外键校验；未转正路人不建独立文件 | `dream_word_threshold` / `dream_buffer_limit` 触发水位、纪元折叠卷数跨度 |
| **文风与群像** | 抽象纪律锁前缀 + 动态标本池 `LRU` 抽样槽位；可开关 `Static Prose Gate` 执行框架 | `voice_samples.yaml` 标签集合与标本数（`0~N`）、单场 `focus_cast / background_cast` 划分与人数、各门禁规则开关与阈值、`craft_plugins: []` |
| **时序与自愈** | `WARPED` 灰象双视图隔离；`Spotlight Trigger` 前台镜头原则；双原句代码验真；单点穿帮自动 `Patch + Sync` | `max_auto_rollback_chapters`（`0` 为全人工确认，`N` 为 `N` 章内自动备份回滚）、`parallel_max_chapters` 汇合跨度 |

# 核心领域词表与架构裁决基线 (ROADMAP)

> **当前状态**：全部业务与架构设计分支已完成裁决冻结，进入程序实现阶段。纯业务流程规范见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，软件工程设计与分步施工计划见 [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md)。

---

## 一、 核心领域词汇表 (Domain Glossary)

本表仅定义通用写作引擎的领域概念；具体作品的世界观专有名词归属各自的 `books/<slug>/` 工作区内部。

- **Book（作品工作区）**：一部独立长篇小说的全部纯文本创作资产集合，存放于独立的 `books/<slug>/` 子仓库并拥有独立 Git 历史。内部遵循纯文本数据库同构契约：**定稿手稿（`manuscripts/`）为唯一事实真源（`WAL`）**，实体档案与分级目录为可增量刷新的**物化视图（`Materialized View`）**。
- **Bootloader（四阶段开书引导编译器）**：开书第 0 步的一次性离线初始化流程，经由「分词率实测标定 -> 三维正交叙事坐标定标与纯文本《全书架构圣经》深推演（支持 `interactive` 人工拍板与 `auto_best` 自动择优）-> 三把手术刀结构化分拣（时序刀 `T0`、视角刀里表双账本、冰山刀 `10%/90%` 词条分离）-> 三重门禁核验（确定性配额与 `T0` 扫描、声纹 `Static Prose Gate` 过滤、异构语义剧透盲审）」统一编译为标准作品工作区。
- **Static Base & Voice Samples（静态法则基线与多场景声纹池）**：整卷锁死在前缀首部的 10% 世界底层代价铁律与抽象句法纪律（`static_base_and_voice.md`，上限 `<=1,500 字`），配合覆盖 4~5 类核心场景标签、每标签至少 3 句异构句法标本的动态声纹池（`voice_samples.yaml`）。装配器将可用标签枚举透传给 `Planner`，并在匹配标签内按 `LRU` 轮换抽样注入写手。
- **Inside-Outside Dual Ledger（里表双账本与解密翻转）**：将表象与误导标为 `PUBLIC / SELF_ONLY`，将尚未揭晓的真凶身份、世界终极真相与幕后底牌标为 `OMNISCIENT_SECRET`。`Planner` 结合 `OMNISCIENT_SECRET` 在内部 `director_rationale` 中推演因果，向写手下达纯表面动作单 `outline_text`（内核对写手物理剥离 `OMNISCIENT_SECRET` 与 `director_rationale`）；待揭秘章正式呈现后，由 `Extractor` 将该词条翻转为 `PUBLIC` 或 `READER_KNOWN`。
- **Volume Envelope & Transition（卷域包络与换卷交接 `advanceVolume`）**：`current_arc_envelope.md` 固化本卷舞台冲突、三幕拐点（含开篇第 1 章点火器）、**阶段天花板禁区（`Stage Ceiling`）**与跨卷钩子；卷末收束达标时执行五步原子换卷（封存旧卷章卡打 `arc-seal-vol-XX` 标签、非随行旧角色移入 `cold_archive/`、提炼压缩 `style_amendments.md`、基于未结伏笔与跨图锚点编译下一卷包络或标记 `OPEN_ENDING` 完结封笔、推进 `current_volume`）。
- **Future Horizon & Grey-Elephant Isolation（世界默认惯性表与灰象双视图隔离）**：统一记录原创预定动态与同人 `T0` 后事件，支持前置条件 `Premise`、章节窗口 `after_ch` 与日历 `storyDay` 多轨触发（兼容单夜慢流与跨年快流）。前提破灭时翻转为偏转态（`WARPED`）：仅向 `Planner` 暴露废止原委以排定正向替代事件，对写手物理剥离一切 `WARPED` 条目。
- **Entity Page（四段式实体档案 · 补集原则）**：以不可变 `entity_id` 命名的角色或唯一性关键道具单页档案，遵循**环境补集原则**（相邻章尾窗可见的临时站位与动作绝不抄录，仅记跨章不变量），拆分为：① 先天永久红线（`Innate Locks`）、② 带整数日历 `story_day` 与视角可见性的后天状态（`Acquired State & Numeric Ledger`）、③ 不可逆极性变迁史（`Irreversible Trajectory`）、④ 近期滑动缓冲与对话声纹（`Recent Buffer & Voice`）。
- **Hierarchical Index（`L0-L3` 分级目录与成对回表）**：`L0` 纪元总表（全书核心母题与每 10 卷折叠）、`L1` 活跃卷总表（3~5 卷递进蓝图）、`L2` 双轨章卡（每章定稿自动追加主干剧情与异象锚点）、`L3` 跨称谓 `ripgrep -C 2` 原稿回表（硬套时间差信封）。凡触及伏笔回收或证物重现，强制成对挂齐「档案视图 + 原稿切片」。
- **Open Thread（跨卷必收伏笔）**：登记在独立台账 `open_threads.md` 中（活跃区硬上限 `<=15` 条，单章 `Extractor` 不越权修改，统一由周期 `Dreaming` 与换卷 `advanceVolume` 执行立项与 `RESOLVED` 销账归档），未回收前永不被纪元折叠裁除。
- **Timeline Mode（三态时间线沙盒）**：单章细纲头部的读写隔离模式——`MAINLINE`（常规顺叙推进）、`PARALLEL`（从分叉起点快照隔离演进、冻结主时钟重复累加并在限期内 3-Way Merge）、`FLASHBACK`（按 `story_day` 过滤历史履历，冻结保护当前快照）。
- **Static Prose Gate（静态文风配额门禁）**：开书声纹标本入池与单章成文后零模型开销运行的可开关代码规则集，剥离工程自检标签并按行号检出高频 AI 八股句式、微距套话超标与跨章具象喻体复读。
- **Sync（手稿真源增量同步）**：人工直接编辑 `manuscripts/ch_*.md` 后，基于 `SHA-256` 与 `git diff` 触发的物化视图增量刷新及下游章节只读冲突扫描流程。
- **Dreaming & Spotlight Trigger（周期睡眠 `VACUUM` 与前台切镜触发器）**：按字数或缓冲水位离线触发的增量整理工序，清洗活跃脏实体页、盘点 `open_threads.md` 立项与销账、滚动补货 `future_horizon.md`、归档过期 `WARPED` 死元组与退场角色、执行跨章连续性三级自动自愈；对离场角色一旦触及重大局势转折临界点，严禁后台一行结算，改为抛出 **`Spotlight Trigger`** 驱动后续章节通过前台碰撞或切镜展开。

---

## 二、 已冻结架构裁决基线（常量 vs 变量 · 内聚 vs 解耦）

| 领域维度 | 状态 | 内核固化常量（机制与不变量） | 释放为变量 / 独立解耦项 |
| :--- | :--- | :--- | :--- |
| **引擎与作品隔离** | **已确认** | 根仓库仅存通用引擎；作品存 `books/<slug>/` 独立 Git 仓，双粒度原子提交（`feat` 正文 + `state` 视图）配 WAL 崩溃恢复 | 具体作品目录位置、分支命名与备份标签策略 |
| **业务与宿主底座解耦** | **已确认** | 业务规范零语言/宿主假设；代码实现切分为零宿主依赖的纯核心模块与外层可插拔宿主适配层（见 [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md)） | 各工种绑定的模型厂商（支持跨厂商异构混编互审）、交互界面形态 |
| **净室执笔与窗口裁剪** | **已确认** | 单轮零对话历史、零工具声明净室调用；超预算四级按需降级裁剪链 | `writer_token_budget`（按模型实测注意力甜点配置，或设为 `null` 无损直通，不写死固定 Token 魔数） |
| **全题材开局与里表双账本** | **已确认** | 四阶段开书（纯文本深推演 -> 三把手术刀编译 -> 三重门禁 -> 落盘）；`director_rationale` 与 `outline_text` 物理隔离防细纲泄底；揭秘章后 `OMNISCIENT_SECRET -> PUBLIC/READER_KNOWN` 状态翻转 | 三维正交叙事坐标（结构拓扑 × 核心张力源 × 终局形态）组合定标；开局拍板策略（`interactive` 人工选择 vs `auto_best` 自动择优） |
| **声纹保鲜与防复读** | **已确认** | 「静态抽象纪律（锁前缀，`<=1,500 字`）+ 动态多场景标本池」两层槽位；可用 `tag` 枚举透传 `Planner` + 同标签内 `LRU` 轮换抽样；开书标本强制过 `Static Prose Gate` | 标本场景标签集合与每标签句子数（推荐 4~5 类标签 × 每标签 3 句异构句式）；跨章喻体复读窗口大小 |
| **伏笔账本与换卷交接** | **已确认** | 单章 `Extractor` 仅输出实体补丁、`L2` 章卡摘要与 `next_chapter_options`；伏笔立项/销账（`ACTIVE <= 15`）收归 `Dreaming` 与 `advanceVolume`；换卷执行五步原子交接与非随行角色 `cold_archive` 归档 | 分卷跨度、卷末收束标志条件、完结封笔（`OPEN_ENDING`）或基于未结伏笔衍生新地图卷 |
| **群像聚焦与路人管控** | **已确认** | 临时路人未跨章复现且未绑伏笔前不新建独立 `entities/` 文件；新建实体强制校验标准中文 `canonical_name` | 每章 `focus_cast / background_cast` 名单与人数由 `Planner` 按戏剧张力自决（无硬编码人数上限）；重型认知链归入 `craft_plugins` 默认关闭 |
| **多视角幕后推进** | **已确认** | 前台镜头原则：改变局势的大事件禁止在后台摘要结算，触及临界点抛 `Spotlight Trigger` 交前台章节叙事 | 单主角或多主角群像体制、切镜采用视角轮换还是 `PARALLEL` 并行章 |
| **人机共驾与手改同步** | **已确认** | 手稿为唯一真源（`WAL`）；人工改稿后按 `SHA-256 + git diff` 增量刷新视图，改历史旧章仅做下游只读冲突扫描不篡改后文 | 作者介入频率（全程挂机跑批、抽查微调或逐章共驾） |
| **蝴蝶偏转与跨章自愈** | **已确认** | `WARPED` 灰象双视图隔离；双侧原句去标点代码验真；软微瑕自动圆、单点硬穿帮自动 `Patch + Sync`、超限走 `SAFE_HALT`（仅报冲突行号与涉及章数/字数） | `max_auto_rollback_chapters`（设 `0` 则回滚均需人工确认，设 `N` 则 `<=N` 章连带穿帮自动备份并回滚重跑） |

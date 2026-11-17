# 核心领域词表与架构裁决基线 (ROADMAP)

> **规范状态**：本文记录已确认的领域术语与常量/变量分界。完整业务流程见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；DSH 插件拓扑与分步施工验收见 [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md)。

---

## 一、 核心领域词汇表 (Domain Glossary)

本表仅定义通用写作引擎的领域概念；具体作品的世界观专有名词归属各自的 `books/<slug>/` 工作区内部。

- **Book（作品工作区）**：一部独立小说的纯文本创作资产集合，存放于独立的 `books/<slug>/` Git 子仓库。内部遵循纯文本数据库契约：**定稿手稿（`manuscripts/`）为唯一事实真源（`WAL`）**，实体档案与分级目录为可增量刷新的**物化视图（`Materialized View`）**。
- **Author Charter（作者契约与对齐）**：开书构思与重大改纲收口沉淀进作品的只读权威文件（`world/author_charter.md`），区分**核心承诺**（作者锁定的体验、排雷红线与原话 `T0` 现场）、**当前方案**（可调整的实现路径）与**授权范围**（系统可自主择优的边界）。向规划、审校、睡眠整理与换卷暴露，对写手物理屏蔽。
- **Bootloader（开书引导与建库停机）**：在主对话中经构思 Skill 完成行业/舞台取证与因果自检，锁定契约后编译标准作品资产并执行初始化门禁；建库完成即原地停机，待作者检阅并手动启动第一章。流程见 [开书与校准](docs/ARCHITECTURE.md#3-作者对齐开书建库与开篇校准)。
- **Opening Calibration & Voice Harvest（开篇校准与声纹采集）**：以正式生成并归档的第一章核对人物气口、节奏、描写密度与信息释放；校准认可且初始声纹池为空时，从第一章定稿采集脱敏纯表达示范写入 `.ops/voice_samples.yaml`，随后由作者手动放行日常生产。
- **Scoped Role Agents & Cleanroom Writer（受控探查工种与净室写手）**：检索（`Librarian`）、规划（`Planner`）、核查（`Fact Checker`）、抽取（`Extractor`）与睡眠整理（`Dreamer`）运行为带受控作品工具与专属 `yield_*` 终态门禁的多轮工种；执笔写手（`Prose Writer`）与局部修补（`Patch`）保持零工具、零多轮历史的单轮净室调用。
- **Static Base & Voice Samples（静态法则基线与动态声纹池）**：常驻世界法则、叙述人称基线与抽象句法纪律（`world/static_base_and_voice.md`），配合按场景标签 `LRU` 轮换抽样的 `.ops/voice_samples.yaml`（支持 `0~N` 条，随 `Dreaming` 淘汰高频复读标本）。详见 [声纹契约](docs/WRITING-CRAFT.md#31-默认内聚的无感环境补集对写手零填表负担)。
- **Inside-Outside Dual Ledger（里表双账本与解密翻转）**：表象与角色主观认知标为 `PUBLIC / SELF_ONLY`，戏剧反讽标为 `READER_KNOWN`，未揭晓底牌标为 `OMNISCIENT_SECRET`（明牌作品允许 `0` 条底牌）。`Planner` 在全知 `director_rationale` 中推演因果，向写手输出含表面动作与当场表演潜台词指导的 `outline_text`；正式揭秘章定稿后由 `Extractor` 将对应底牌翻转为 `PUBLIC` 或 `READER_KNOWN`。
- **Volume Envelope & Arc Director Plan（正向卷域包络与导演禁区计划）**：中程规划拆分为两份文件——`world/current_arc_envelope.md` 仅承载对写手安全的正向舞台常态；`world/arc_director_plan.md` 承载**阶段天花板禁区（`Stage Ceiling`）**、未揭秘三幕拐点及开局至第一幕转折的 **3~5 个无章号开篇序列节拍（`Opening Sequence Beats`）**，仅对规划、核查与睡眠整理可见。
- **Future Horizon & Grey-Elephant Isolation（世界默认惯性表与灰象双视图隔离）**：记录预定外部动态与同人 `T0` 后事件，支持前提 `Premise`、章节窗口 `after_ch` 与日历 `storyDay` 触发。前提破灭翻转为偏转态（`WARPED`）后仅向 `Planner` 暴露以排定正向替代事件，对写手物理剥离一切 `WARPED` 条目。
- **Entity Page（四段式实体档案 · 补集原则）**：以不可变 `entity_id` 命名的角色或唯一关键道具单页档案，遵循**环境补集原则**（相邻章尾窗可见的临时动作不抄录，仅记跨章不变量），分为：① 先天永久红线（`Innate Locks`）、② 带整数 `story_day` 与可见性的后天状态（`Acquired State & Numeric Ledger`）、③ 不可逆变迁史（`Irreversible Trajectory`）、④ 近期滑动缓冲与对话声纹（`Recent Buffer & Voice`）。
- **Hierarchical Index（`L0-L3` 分级目录与成对回表）**：`L0` 纪元总表、`L1` 活跃卷总表、`L2` 双轨章卡（主干剧情 + 异象锚点）、`L3` 跨称谓 `ripgrep -C 2` 原稿回表（自动注入时间差信封）。凡触及伏笔回收或证物重现，强制成对挂齐「档案视图 + 原稿切片」。
- **Open Thread（跨卷必收伏笔）**：登记于 `world/open_threads.md`（活跃区上限 `<=15` 条，统一由多轮 `Dreaming` 与换卷 `advanceVolume` 立项或核实原稿后销账归档），未回收前不被纪元折叠裁除。
- **Timeline Mode（三态时间线沙盒）**：单章读写隔离模式——`MAINLINE`（顺叙推进）、`PARALLEL`（分叉快照隔离演进、冻结主时钟重复累加并执行三方合并）、`FLASHBACK`（按 `story_day` 过滤历史履历并冻结当前状态）。
- **Static Prose Gate（静态文风配额门禁）**：零模型开销运行的可开关代码规则集，适配作品叙述人称主观度，剥离工程自检标签并按行号检出高频 AI 套话、微距套词超标与跨章具象喻体复读。
- **Sync（手稿真源增量同步）**：人工编辑 `manuscripts/ch_*.md` 后，基于 `SHA-256` 与 `git diff` 触发的物化视图增量刷新及历史章下游只读冲突扫描流程。
- **Dreaming & Spotlight Trigger（多轮睡眠整理与前台切镜触发器）**：由多轮 `Dreamer` 自主核实近期章卡与存疑原稿，在隔离暂存区联动更新脏实体履历、伏笔表、惯性表与卷纲进度并经门禁原子提交；离场角色抵达重大冲突临界点时抛出 `Spotlight Trigger` 信号交前台章节呈现。

---

## 二、 已确认架构裁决基线（常量 vs 变量）

| 领域维度 | 状态 | 固化的机制常量（不变量与护栏） | 开放的可配变量 / 声明式资产 |
| :--- | :--- | :--- | :--- |
| **引擎与作品隔离** | **已确认** | 根仓库仅存通用插件与预设；作品存 `books/<slug>/` 独立 Git 仓，双粒度原子提交（`feat` 正文 + `state` 视图）配排他锁与 WAL 恢复 | 具体作品目录位置、分支与备份标签策略 |
| **DSH 插件与角色解耦** | **已确认** | 全面扎根 `@deepseek-ai/dsh` 插件与单一顶层创作模式；Host 服务与前端 UI 物理分包；多轮工种经 `yield_*` 门禁与未提交续跑 Hook 收口 | `roles/*.yml` 与 `prompts/*.md` 声明的模型池、工具白名单、调用配额与提示词（支持单书覆盖） |
| **净室执笔与前缀缓存** | **已确认** | 写手与局部修补保持零工具单轮净室调用；各工种跨章独立复用自身前缀缓存；超预算执行四级降级裁剪链 | `writer_token_budget`（按模型设定或置 `null` 直通）、各工种异构模型路由映射 |
| **全题材开书与双账本** | **已确认** | 构思收口沉淀只读 `author_charter.md`；导演禁区拆入 `arc_director_plan.md`；建库完成即停机待手动启动；支持单卷本（`>=1` 卷）与明牌 `0` 黑幕 | 体验承诺、POV 切镜体制、卷/副本尺度、远期留白（`OPEN_HORIZON`）与局部闭环边界；开书构思 Skill 迭代版本 |
| **声纹防污染与人称适配** | **已确认** | 无预设样章时开书声纹池留空 `0` 条；首章校准通过后经 `Voice Harvest` 采集脱敏句式；运行期 `LRU` 轮换并在 `Dreaming` 周期代谢复读标本 | 叙述人称与主观度基线、声纹标签集合与标本数（`0~N`）、跨章喻体复读窗口与各门禁开关阈值 |
| **多轮维护与换卷交接** | **已确认** | `Dreamer` 只读核实原稿 + 隔离暂存区联动 `book_edit` + `yield_dream_commit` 一次性校验 `Innate Locks` 与伏笔上限后原子落盘 | 触发字数/缓冲水位、分卷跨度、完结封笔或后续新卷展开 |
| **群像聚焦与前台切镜** | **已确认** | 临时路人未跨章复现且未绑伏笔前缓建独立实体卡；新建实体强校验中文 `canonical_name`；离场大事件抛 `Spotlight Trigger` 交前台叙事 | 单场 `focus_cast / background_cast` 划分与人数、外置可选认知插件 `craft_plugins` |
| **双入口共驾与跨章自愈** | **已确认** | 主对话负责构思与大改纲，Studio 按钮与 `/narrate-*` 斜杠命令触发后台管线，Studio 底部框仅投递安全点微调信号；双原句代码验真与三级梯度自愈 | 开篇校准跳过授权、`max_auto_rollback_chapters` 自动回滚阈值、`parallel_max_chapters` 并行汇合跨度 |

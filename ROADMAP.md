# 核心领域词汇表 (ROADMAP / Domain Glossary)

> **规范定位**：本文定义通用写作引擎的核心领域术语；具体作品的世界观专有名词归属各自的 `books/<slug>/` 工作区。完整业务流程与「固化机制常量 vs 可配变量总表（§7）」见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；形式化架构、契约与行为模型见 [`design/`](design/)。

---

- **Book（作品工作区）**：一部独立小说的纯文本创作资产集合，存放于独立的 `books/<slug>/` Git 子仓库。内部遵循纯文本数据库契约：**定稿手稿（`manuscripts/`）为唯一事实真源（`WAL`）**，实体档案与分级目录为可增量刷新的**物化视图（`Materialized View`）**；单章按 `FEAT_COMMITTED`（正文落盘）与 `STATE_COMMITTED`（派生视图更新）双粒度原子提交。
- **Author Charter（作者契约与对齐）**：开书构思与重大改纲收口沉淀进作品的只读权威文件（`world/author_charter.md`），区分**核心承诺**（作者锁定的体验、排雷红线与原话 `T0` 现场）、**当前方案**（可调整的实现路径）与**授权范围**（系统可自主择优的边界）。向规划、审校、睡眠整理与换卷暴露，对写手与内存修补物理屏蔽。
- **Bootloader（开书引导与建库停机）**：在主对话中经构思 Skill 完成行业/舞台取证与因果自检，锁定契约后在临时目录编译标准作品资产、通过确定性门禁并原子替换发布，随后自动尝试切换激活新书并原地停机，待作者检阅并手动启动第一章。流程见 [`docs/ARCHITECTURE.md` §3](docs/ARCHITECTURE.md#3-作者对齐开书建库与开篇校准)。
- **Opening Calibration & Voice Harvest（开篇校准与混合滚动声纹采集）**：首章定稿后是否自动停机由独立的 `pause_after_first_chapter` 配置控制（与声纹初始化策略完全解耦）。在 `hybrid_rolling` 模式下，前 `voice_rolling_warmup_chapters`（默认 `3`）章每章定稿后，只要非空声纹池仍含临时种子（`boot_seed`）或未达目标容量，自动从刚定稿正文提取逐字存在、脱专名且通过静态门禁的互补原句，优先置换临时种子再补充容量；若初始池为空，则在首章校准认可后经 `Voice Harvest` 采集入池。
- **Scoped Role Agents, Cleanroom Writer & In-Memory Patch（受控探查工种、净室写手与内存修补）**：检索（`Librarian`）、规划（`Planner`）、核查（`Fact Checker`）、抽取（`Extractor`）与睡眠整理（`Dreamer`）运行为带受控磁盘工具与专属 `yield_*` 终态门禁的多轮工种；执笔写手（`Prose Writer`，含 `WRITER` / `REWRITE`）保持零工具、零多轮历史的单轮净室调用；局部修补（`Patch`）运行于净室内存段落编辑闭环（仅配纯内存 `patch_paragraphs` 与 `yield_patched_draft`，零磁盘读写且诊断脱敏命中原词）。全工种统一经原生会话引擎驱动并物理剥离宿主 `AGENTS.md`。
- **Static Base & Voice Samples（静态法则基线与动态声纹池）**：常驻世界法则、叙述人称基线与抽象句法纪律（`world/static_base_and_voice.md`），配合按场景标签 `LRU` 轮换抽样的 `.ops/voice_samples.yaml`（支持 `0~N` 条，随 `Dreaming` 淘汰高频复读标本）。详见 [`docs/WRITING-CRAFT.md` §3.1](docs/WRITING-CRAFT.md#31-默认内聚的无感环境补集对写手零填表负担)。
- **Inside-Outside Dual Ledger（里表双账本与解密翻转）**：表象与角色主观认知标为 `PUBLIC / SELF_ONLY`，戏剧反讽标为 `READER_KNOWN`，未揭晓底牌标为 `OMNISCIENT_SECRET`（明牌作品允许 `0` 条底牌）。`Planner` 在全知 `director_rationale` 中推演因果，向写手输出含表面动作与当场表演潜台词指导的 `outline_text`；正式揭秘章定稿后由 `Extractor` 按 `slot_key` 将对应底牌原地翻转为 `PUBLIC` 或 `READER_KNOWN`。
- **Volume Envelope & Arc Director Plan（正向卷域包络与导演禁区计划）**：中程规划拆分为两份文件——`world/current_arc_envelope.md` 仅承载对写手安全的正向舞台常态；`world/arc_director_plan.md` 承载**阶段天花板禁区（`Stage Ceiling`）**、未揭秘三幕拐点及开局至第一幕转折的 **3~5 个无章号开篇序列节拍（`Opening Sequence Beats`）**，仅对规划、核查与睡眠整理可见。
- **Future Horizon & Grey-Elephant Isolation（世界默认惯性表与灰象双视图隔离）**：记录预定外部动态与同人 `T0` 后事件，支持前提 `Premise`、章节窗口 `after_ch` 与日历 `storyDay` 触发。前提破灭翻转为偏转态（`WARPED`）后仅向 `Planner` 暴露以排定正向替代事件，对写手物理剥离一切 `WARPED` 条目。
- **Entity Page（四段式实体档案 · 补集原则）**：以不可变 `entity_id` 命名的角色或唯一关键道具单页档案，遵循**环境补集原则**（相邻章尾窗可见的临时动作不抄录，仅记跨章不变量），分为：① 先天永久红线（`Innate Locks`）、② 带整数 `story_day` 与可见性的后天状态（`Acquired State & Numeric Ledger`）、③ 不可逆变迁史（`Irreversible Trajectory`）、④ 近期滑动缓冲与对话声纹（`Recent Buffer & Voice`）。
- **Hierarchical Index（`L0-L3` 分级目录与成对回表）**：`L0` 纪元总表、`L1` 活跃卷总表、`L2` 双轨章卡（主干剧情 + 异象锚点）、`L3` 跨称谓 `ripgrep -C 2` 原稿回表（自动注入时间差信封）。凡触及伏笔回收或证物重现，强制成对挂齐「档案视图 + 原稿切片」（角色当章首次登场豁免）。
- **Open Thread（跨卷必收伏笔）**：登记于 `world/open_threads.md`（活跃区上限 `<=15` 条）。在主线顺叙推进且无活跃并行分支窗口时，`Fact Checker` 终审通过时一并确认已达成的开篇节拍与已结案伏笔，随正文定稿持久化并于 `STATE_COMMITTED` 阶段同批幂等核销；多轮 `Dreaming` 与换卷 `advanceVolume` 则通过回查原稿执行跨章兜底盘点、新伏笔立项与归档，未回收前不被纪元折叠裁除。
- **Timeline Mode（三态时间线沙盒）**：单章读写隔离模式——`MAINLINE`（顺叙推进）、`PARALLEL`（分叉快照隔离演进、冻结主时钟重复累加并执行三方合并）、`FLASHBACK`（按 `story_day` 过滤历史履历并冻结当前状态）。
- **Static Prose Gate（静态文风配额门禁）**：零模型开销运行的可开关确定性规则集，适配作品叙述人称主观度，剥离工程自检标签并按行号检出高频 AI 套话、微距套词超标与跨章具象喻体复读，诊断与快照自动将违规原词脱敏为正向改写目标。
- **Sync（手稿真源增量同步）**：人工编辑 `manuscripts/ch_*.md` 后，基于 `SHA-256` 与 `git diff` 触发的物化视图增量刷新及历史章下游只读冲突扫描流程（存在未完成半章事务时优先恢复该章，禁止以同步代为结账）。
- **Dreaming & Spotlight Trigger（多轮睡眠整理与前台切镜触发器）**：由多轮 `Dreamer` 自主核实近期章卡与存疑原稿，在支持单步回退（`revert`）的隔离内存暂存区联动更新脏实体履历、伏笔表、惯性表与卷纲进度，经 `yield_dream_commit` 终态门禁复核后原子落盘；离场角色抵达重大冲突临界点时抛出 `Spotlight Trigger` 信号交前台章节呈现。

# NarrateOS 软件工程架构与程序开发计划 (DEVELOPMENT-PLAN)

> **定位**：将 [`ARCHITECTURE.md`](ARCHITECTURE.md) 与 [`WRITING-CRAFT.md`](WRITING-CRAFT.md) 的纯业务规范落地为可测试、零宿主锁死的深模块代码与 `@deepseek-ai/dsh` 插件生态的工程施工蓝图。
> **核心原则**：业务规范与工程实现解耦；核心包零宿主框架依赖；每个模块通过窄接口隐藏内部复杂度（Deep Module），每个施工阶段以可自动执行的完备测试作为唯一放行判据。

---

## 1. 技术基线与仓库包拓扑

- **运行时与工具链**：`Node.js >= 24.9`（对齐 `@deepseek-ai/dsh` 最新引擎基线）、`TypeScript 5.x`（`strict: true`，ESM，统一 4 空格缩进）、`pnpm` Workspace、`vitest`、系统原生 `git` 与 `rg` (`ripgrep`)。
- **单向依赖拓扑（严禁反向引用）**：

```text
narrateos/
├── packages/
│   ├── core/                # [@narrateos/core] 纯 TypeScript 业务内核（零 @deepseek-ai/* 依赖）
│   ├── cli/                 # [@narrateos/cli] 独立无头运行器与评测驱动（供单测、批处理与基准回放）
│   └── dsh-plugin/          # [@narrateos/dsh-plugin] 薄 Cordis 插件、LlmAdapter 桥接与 Web 插槽面板
├── presets/
│   └── narrate-studio/      # [dsh-agent-preset] 专属写作模式集合（agent.cordis.yml + preset.yml）
├── plugins/
│   └── craft/               # 外置可选文风插件模板（vad-bdi.md / dual-reaction.md / scene-act.md）
├── fixtures/
│   └── sample-book/         # 测试夹具工作区（从只读 manuscript/vol-01/ch-01.md 派生初始化）
└── books/                   # [gitignored] 实际创作的独立作品 Git 仓库目录
```

**依赖红线**：`packages/core` 运行时仅允许依赖 `yaml`、`zod` 与 Node.js 标准库，严禁导入任何 `@deepseek-ai/*`、第三方 LLM SDK 或 UI 包；根开发依赖限定为 `typescript`、`vitest`、`@types/node`。上游 `dsh` 版本迭代引发的接口适配 100% 封闭在 `packages/dsh-plugin` 与 `packages/cli` 适配层内完成。

---

## 2. 外部接缝（Seams）与核心深模块（Deep Modules）契约

仅在真实存在多套实现的边界设置接缝（Two adapters = a real seam），内部逻辑收敛为 6 个窄接口深模块：

### 2.1 两条外部接缝（External Seams）

1. **`LlmPort`（模型调用窄接缝）**：
   - **Interface**：`generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse>`。
   - **输入不变量**：显式区分 `pool: 'strong_creative' | 'fast_retrieval' | 'audit'`，携带结构化分段 `{ staticPrefixBlocks: string[], dynamicTail: string }`（零工具声明、零历史会话数组）、采样/思考档位参数；输出标准化无交集 `TokenUsage`（`inputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`）。
   - **Adapters**：
     - `ScriptedLlmAdapter`：按输入指纹返回预置响应或注入故障，支撑全套编排单测毫秒级离线运行；
     - `DshLlmAdapter`：在 `packages/dsh-plugin` 与 `packages/cli` 中复用 `@deepseek-ai/dsh-llm`（搭配 `dsh-llm-deepseek` / `dsh-llm-pi-ai` / `dsh-llm-retry`），通过无 `sessionId` 的流式调用绕过宿主对话上下文，不自研 HTTP/Retry 客户端。
   - **结构化输出重试契约**：零 `tools` 净室请求统一要求 fenced JSON 输出并经 `zod` 校验；校验或解析失败时附带错误详情同轮自动修复重试，默认上限 **5 次**、指数退避 `1s -> 2s -> 4s -> 8s -> 16s`（支持配置覆盖，单测环境可设为 `0ms`）。
2. **`SystemPort`（版本库与全文检索接缝）**：
   - **Interface**：封装针对单本 `bookRoot` 的原子 `git` 操作（`commitPaths`、`createTag`、`readFileAtRef`、`diffFile`、`resetHard`）与 `ripgrepSearch(patterns, chapterWhitelist, contextParagraphs)`。
   - **测试策略**：集成测试直接在 `/tmp` 创建真实临时 Git 子仓执行并自动清理，不编写脆弱的 Git 字符串 Mock。

### 2.2 `packages/core` 六大深模块接口设计

| 模块名 (`packages/core/src/*`) | 对外窄接口（Interface） | 内部隐藏的深度实现（Implementation） |
| :--- | :--- | :--- |
| **`1. BookStore`** | `loadSnapshot()` / `commitDraft(ch, text)` / `applyStatePatch(ch, patch)` / `recoverWal()` / `detectDirtyChapters()` | 解析 `book_config.yaml` 与四段式实体 Markdown；执行行级槽位增量合并（禁整文件覆写）；拦截固有属性篡改 Diff；执行 1ms 跨文件外键（`char_*`/`item_*`/`ch_*`/`cold_archive`）可达性校验；驱动 `.ops/tx_state.json` 双粒度提交恢复与 `SHA-256` 比对。 |
| **`2. ViewSlicer`** | `sliceForPlanner(snap, req)` / `sliceForWriter(snap, plan)` | 执行 `MAINLINE / PARALLEL / FLASHBACK` 三态 `story_day` 偏序过滤（插叙保留 `Innate Locks`、屏蔽 `Acquired`）；对非 `pov_character` 物理剥离 `SELF_ONLY` 与 `OMNISCIENT_SECRET`；转化 `READER_KNOWN` 戏剧反讽块；对写手物理剥离 `WARPED` 废止条目（灰象双视图隔离）；计算 `>30` 章未出场感官唤醒提示。 |
| **`3. IndexRecall`** | `buildLibrarianCatalog(snap)` / `executePairedRecall(snap, query)` | 按「已封旧卷静态区 + 当前活跃卷动态尾」组装 `<100K` 目录；展开实名、唯一别名与职务称谓（限定出场章白名单）执行 `rg -C 2`；硬编码注入时间差信封；强制校验伏笔回收与证物重现场景的「档案视图 + 原稿切片」成对挂载。 |
| **`4. PrefixAssembler`** | `assemblePlannerRequest(ctx)` / `assembleWriterRequest(ctx)` | 保证同卷内 `Planner` 与 `Writer` 前段静态前缀（含 `static_base_and_voice.md` 与 `current_arc_envelope.md`）字节 100% 一致；提取 `voice_samples.yaml` 可用标签枚举供 `Planner` 选择，并在匹配标签内按 `LRU` 轮换抽样；对 `Writer` 物理丢弃 `PlannerOutline.director_rationale` 防细纲信道泄底；当配置了 `writer_token_budget` 且超限时，按四级顺序自动压缩（第 1 级自动组合 `L2` 上章摘要与 600 字尾窗）。 |
| **`5. ProseGateAndTelemetry`** | `scanDraft(draft, recentChs, rulesCfg)` / `verifyDualQuotes(claims, store)` / `collectTelemetry(ch, usage)` | 提取并剥离头部 `<blocking>` 标签；运行可独立开关的 `Static Prose Gate` 正则配额表与跨章具象喻体复读检测，输出精确违规行号与上下窗口；执行双侧原句去标点子串验真；零模型计算 `MATTR-500`、Kontoyiannis 熵率 $\hat{H}_K$ 与句段长变异系数 CV。 |
| **`6. NarrativeEngine`** | `bootBook()` / `stepChapter()` / `syncManuscripts()` / `runDreaming()` / `advanceVolume()` | 串联四阶段开书（三维正交坐标纯文本深推演 -> 三把手术刀编译 -> 三重门禁 -> 落盘）；驱动单章 6 步闭环（挂载选中 `lore_library` 词条与 `open_threads.md`、消费 `.ops/signals.jsonl`、`Stage Ceiling` 违规抛 `PlanConflictError`、落盘 `L2` 章卡并产出 `next_chapter_options`）；处理 `PARALLEL` 分支主时钟锁定与 3-Way Merge；执行人工手改 `Sync`；运行 `Dreaming`（脏页清洗、`open_threads` 周期立项/销账、`future_horizon` 多轨补货、`Spotlight Trigger` 派发与跨章三级自动自愈）及五步原子换卷 `advanceVolume()`。 |

---

## 3. `@deepseek-ai/dsh` 插件集与 Operator Studio 集成方案

外层宿主适配完全基于 `@deepseek-ai/dsh@0.2.2-rc.1` 的 Cordis 插件声明、`dsh-client-ui-layout` 与 `ctx.webServer` 组装，零侵入修改 `dsh` 官方源码，且彻底放弃聊天框斜杠指令交互，采用 **Operator Studio（导演/运维控制台）** 范式：

1. **后端宿主胶水与 LLM 调度复用（`packages/dsh-plugin`）**：
   - 注册 `DshLlmAdapter` 复用宿主 `ctx.llm.stream()`（及 `dsh-llm-retry` 限流重试）与本机模型/Key 配置；
   - 绑定引擎生命周期与 Cordis Fiber 卸载钩子，先请求安全停机并等待已接收任务结束；超过停机提示窗口时发出 `halt:waiting` 并继续等待，不删除在途事务锁或提前卸载 REST/SSE，任务完成后再释放资源；
   - 通过 `ctx.webServer` 注册 REST 控制接口与 SSE 状态流，将 `.ops/signals.jsonl` 运维事件、6 节点运行阶段、正文/细纲/Diff 与遥测数据推送给前端。
2. **非会话 `'main'` 槽位前端（设计完成后接续施工）**：
   - 通过 `@deepseek-ai/dsh-client-ui-layout` 注册独立 `'main'` keyed 槽位（`narrate-studio`），绕开 `conversation` 累进上下文会话循环；
   - 复用 `dsh-client-ui-theme` CSS 变量，呈现 6 节点运行阶段图（含 `Dreaming`、隐藏 0-LLM 节点）、YOLO 连续运行控制、`正文 | 本章细纲 | 修改 Diff` 三视图、底部 `.ops/signals.jsonl` 运维输入/事件流及右侧 7 块可折叠运维检查器。
3. **预设包（`presets/narrate-studio/`）**：
   - `preset.yml` / `agent.cordis.yml`：注册「NarrateOS 长篇创作室」模式入口，按需禁用编码专用冗余内置插件（如 `tool-subagent`、`tool-ralph`、`compaction-basic` 等）。

---

## 4. 分阶段施工序列与确定性完工判据

严格按依赖自底向上推进；每个阶段结束必须跑通对应自动化检查且零残留占位符（`TODO` / `FIXME`），达标后方可进入下一阶段。

### Phase 1：工作区脚手架、测试夹具与存储事务层 (`BookStore` + `SystemPort`)
- **前置动作**：在初始化 `package.json` 前向用户确认具体第三方基础依赖清单（如 `yaml`、`zod`、`vitest`）。保持根目录 [`manuscript/vol-01/ch-01.md`](../manuscript/vol-01/ch-01.md) 原样不动，编写初始化脚本将其复制派生为 `fixtures/sample-book/` 标准作品仓夹具。
- **交付内容**：搭建 `pnpm` Monorepo 与 TypeScript 严格编译配置；实现 `SystemPort`（真实临时 Git 仓与 `rg` 调用封装）与 `BookStore`（配置加载、四段式实体解析与序列化、行级槽位补丁合并、固有属性写保护 Diff、1ms 外键可达性扫描、WAL 相位状态机与 `SHA-256` 脏章检测）。
- **完工判据（Exit Criteria）**：
  - `pnpm test --filter @narrateos/core` 退出码为 `0`；
  - 自动化测试完整覆盖并断言通过：① 并发/顺序行级补丁零状态丢失；② 企图修改实体 `canonical_name` 或 `Innate Locks` 已锁条目的补丁 100% 被拦截报错；③ 引用不存在的 `char_XXX` / `item_XXX` / `ch_XXXX` 触发外键异常阻止 `state` 提交；④ 模拟 `FEAT_COMMITTED` 后断电重启，`recoverWal()` 精确识别未完成状态并保持 Git 树零脏文件。
  - 事务锁仅在持锁进程已退出时回收；锁龄不能使存活进程失去互斥保护。释放时核验本次获取的所有权，不删除其他持有者的锁。损坏锁仅按超时规则恢复。
  - WAL 恢复以 Git 已提交的事务状态为相位依据；工作区中提前写入的 FEAT/STATE/DREAM 不构成提交成功证据。正文提交失败返回起草恢复，状态提交失败继续从已提交正文抽取。
  - 恢复仅回退持久化写集内的文件，先将这些文件备份到 `.ops/recovery/`；历史章手改、未登记实体及未跟踪笔记原地保留并继续报告脏状态，不执行整仓 reset/clean。恢复备份不参与工作区干净度判断。
  - Dreaming 在调用模型或写入任何整理结果之前拒绝 DRAFTING/FEAT_COMMITTED；强制整理不能跳过章节恢复，最终提交再次校验相位。
  - 单章推进与 Dreaming 从读取快照到最终提交始终持有同一作品事务锁，模型等待期间也不释放；不同 CLI/Web 实例不能交错生成、恢复或整理同一作品。
  - 在线保存只编辑已存在的四位章号文件，保存与 Sync 共用作品锁。写入前保留原稿与待同步稿到 `.ops/manual_edits/`；成功同步后删除备份，失败保留手改正文及备份供重试 Sync。

### Phase 2：确定性裁剪、成对检索与静态门禁内核 (`ViewSlicer` + `IndexRecall` + `ProseGateAndTelemetry`)
- **交付内容**：零 LLM 调用完整实现 `ViewSlicer`、`IndexRecall` 与 `ProseGateAndTelemetry` 三个纯确定性深模块。
- **完工判据（Exit Criteria）**：
  - 零网络、零模型调用单测全部通过（退出码 `0`）：
    1. **隔离性断言**：`FLASHBACK` 模式下 `day >= target_day` 的后天状态与缓冲 100% 物理消失且 `Innate Locks` 完整保留；非当前 POV 角色的 `SELF_ONLY` 与 `OMNISCIENT_SECRET` 条目在输出字符串中出现次数为 `0`；`WARPED` 条目及违禁原著词在写手视图中出现次数为 `0`；
    2. **回表断言**：对 `fixtures/sample-book/` 执行实名、唯一别名与限章职务称谓检索，准确返回上下各 2 段完整切片且顶部 100% 携带精确计算的 `[出自第 X 章 ... 已过 Y 天]` 时间差信封；伏笔回收缺原稿切片时触发确定性校验失败；
    3. **门禁与遥测断言**：构造含 `<blocking>` 标签、S 姐七刀超标句与跨 5 章重复明喻的测试稿，`scanDraft()` 精确剥离标签并报出全部违规行号；捏造单字差异的伪原句被 `verifyDualQuotes()` 100% 拒止；`MATTR-500` 与 Kontoyiannis 熵率 $\hat{H}_K$ 在合成退化语料（重复文本 vs 自然样章）上呈现严格单调区分。

### Phase 3：双池前缀装配、单章自愈闭环与人工改稿同步 (`PrefixAssembler` + `stepChapter` + `syncManuscripts`)
- **交付内容**：实现 `LlmPort`（含 `ScriptedLlmAdapter`、`LoggingLlmAdapter` 与结构化 JSON 校验/5 次指数退避修复重试）、`PrefixAssembler`（双池拼装、声纹标本多标签 `LRU` 轮换、`director_rationale` 物理剥离、`writer_token_budget` 可配四级降级与无预算直通、`craft_plugins` 动态加载）、`NarrativeEngine.stepChapter()` 全链路审校自愈闭环（含 `.ops/signals.jsonl` 消费、`lore_library` 读盘挂载、`L2` 章卡更新、新建实体 `canonical_name` 强校验与 `next_chapter_options` 产出）、`NarrativeEngine.syncManuscripts()` 手改同步及 `@narrateos/cli` 基础命令。
- **完工判据（Exit Criteria）**：
  - 基于 `ScriptedLlmAdapter` 跑通全部状态机分支单测（退出码 `0`）：
    1. **前缀零分叉与防泄底断言**：同一卷内 `Planner` 与 `Prose Writer` 请求的静态前缀区（含 `static_base_and_voice.md` 与 `current_arc_envelope.md`）字节序列 `SHA-256` 100% 相等；`PlannerOutline.director_rationale` 在 `Writer` 请求中出现次数为 `0`；同场景标签连续抽样 `voice_samples` 按 `LRU` 轮换不发生相邻重复；设 `writer_token_budget = null` 时零裁剪直通，设紧预算时严格按四级顺序压入阈值内；
    2. **分级返工与落盘断言**：注入 `<=2` 段八股/小穿帮仅触发局部 `Patch`（不重跑整章），注入细纲级悖论或违反 `Stage Ceiling` 触发 `PlanConflictError` 改纲 v2，连续失败准确落入 `SAFE_HALT`；新建实体缺省中文 `canonical_name` 时触发结构化重试；定稿后 `index/L2_cards/vol_XX_cards.md` 准确写入本章摘要；
    3. **手改 `Sync` 断言**：修改最新章纯修辞零模型调用更新 `sha256`；修改最新章钥匙归属自动增量刷新实体卡；修改旧章自动输出下游冲突章号与行号且下游 `manuscripts/` 文件字节零变动。

### Phase 4：四阶段开书编译器、多时间线合并、周期睡眠与换卷交接 (`bootBook` + `PARALLEL` + `runDreaming` + `advanceVolume`)
- **交付内容**：实现四阶段 `bootBook`（分词率标定 -> 三维正交坐标纯文本深推演与 `interactive / auto_best` 拍板 -> 三把手术刀结构化编译 -> 确定性配额/`T0` 扫描、声纹 `Static Prose Gate` 过滤与异构剧透盲审）、`PARALLEL` 分叉快照与 3-Way Merge（主时钟冻结与唯一物双线冲突拦截）、按脏页增量 `Dreaming`（含 `open_threads.md` 周期立项/销账与 `ACTIVE <= 15` 配额硬锁、`future_horizon.md` 多轨补货、`Spotlight Trigger` 派发及跨章穿帮三级自动自愈）、以及五步原子换卷 `advanceVolume()`。
- 开书只接受空目录，在调用模型前排他创建 `.boot-incomplete`；失败保留标记与已写资产，后续开书拒绝复用该目录，成功提交前移除标记。重复开书不是作品重建入口。
- **完工判据（Exit Criteria）**：
  - 自动化集成测试全部通过（退出码 `0`）：
    1. 开书编译后，`T0` 后事件在初始 `entities/*.md` 中残留数为 `0`；`L0_sagas.md`、`L1_volumes.md` 与含 `Stage Ceiling` 的 `current_arc_envelope.md` 非空落盘；声纹池含八股词的示范句被 `Static Prose Gate` 100% 剔除；同人设定包专有名词守恒率 `>=98%`；
    2. `PARALLEL` 双线各写 2 章期间互不可见对方增量且主线 `story_day` 不重复累加，汇合时成功合并非冲突状态，双线同时消耗同一 `item_001` 时被确定性拦截；
    3. `Dreaming` 执行期间未出场干净实体文件 `mtime` 保持不变；`open_threads.md` 超配额或已兑现条目准确归档；离场角色达临界点产出 `Spotlight Trigger` 信号并在下一章 `stepChapter` 被自动挂载消费；`advanceVolume()` 准确封存旧卷章卡、将非随行旧角色移入 `cold_archive/`、提炼压缩 `style_amendments.md` 并递增 `current_volume`。

### Phase 5：`@deepseek-ai/dsh` 插件包、后端控制流与 Operator Studio 集成 (`packages/dsh-plugin` + `presets/`)
- **交付内容**：先交付后端部分——实现 `DshLlmAdapter`（复用 `@deepseek-ai/dsh-llm` 无 `sessionId` 流式调度与限流重试）、`ctx.webServer` REST + SSE 控制/遥测接口、`presets/narrate-studio/` 模式配置与优雅停机钩子；待前端设计稿定稿后接续交付 `'main'` keyed 槽位（`narrate-studio`）Operator Studio 面板。
- **完工判据（Exit Criteria）**：
  - `packages/core` 对 `@deepseek-ai/*` 的依赖检查计数为 `0`；
  - 后端部分：`DshLlmAdapter` 实弹或集成夹具验证 `TokenUsage.cacheReadTokens > 0`，`ctx.webServer` REST/SSE 路由实时推送 `.ops/signals.jsonl` 与遥测指标，中断信号在 5 秒内安全落盘 `.ops/tx_state.json`；
  - 前端部分（后续接续）：在真实 `dsh web` 的 `'main'` keyed 槽位中独立渲染，不污染 `conversation` 会话流。

### Phase 6：`Plot-Haystack` 40 章盲测基准验收
- **交付内容**：构建自动化 40 章同源种子评测脚本与 10 探针核验套件（3 组得而复失极性反转、3 条无日常关联负向红线、2 处台词谎言分流、2 个跨 35 章伏笔回收）。
- **完工判据（Exit Criteria）**：
  - 跑完完整 40 章闭环零未捕获崩溃，所有 Git 提交树与外键完整性 100% 合法；
  - Ch.36-40 定向诱发测试中：负向红线与死亡/唯一物硬穿帮率 `= 0%`，跨 35 章伏笔「档案 + 原稿切片」成对召回率 `= 100%`，同卷内静态前缀缓存命中率稳定达标，首尾 5 章 `MATTR-500` 与 $\hat{H}_K$ 无统计显著坍缩。

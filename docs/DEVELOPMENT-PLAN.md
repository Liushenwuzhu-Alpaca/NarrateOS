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

**依赖红线**：`packages/core` 仅允许依赖 Node 标准库及轻量数据校验/YAML 解析库（开始编码前向用户确认具体依赖清单），严禁导入任何 `@deepseek-ai/*` 或 UI 包；上游 `dsh` 版本迭代引发的接口适配 100% 封闭在 `packages/dsh-plugin` 内完成。

---

## 2. 外部接缝（Seams）与核心深模块（Deep Modules）契约

仅在真实存在多套实现的边界设置接缝（Two adapters = a real seam），内部逻辑收敛为 6 个窄接口深模块：

### 2.1 两条外部接缝（External Seams）

1. **`LlmPort`（模型调用窄接缝）**：
   - **Interface**：`generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse>`。
   - **输入不变量**：显式区分 `pool: 'strong_creative' | 'fast_retrieval' | 'audit'`，携带结构化分段 `{ staticPrefixBlocks: string[], dynamicTail: string }`（零工具声明、零历史会话数组）、采样/思考档位参数；输出标准化无交集 `TokenUsage`（`inputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`）。
   - **Adapters**：
     - `ScriptedLlmAdapter`：按输入指纹返回预置响应或注入故障，支撑全套编排单测毫秒级离线运行；
     - `DshLlmAdapter`：在 `packages/dsh-plugin` 内调用无 `sessionId` 的 `ctx.llm.stream()` 绕过宿主提示词与动态时钟（针对需要多级显式 `cache_control` 断点的后端，同步提供可注册至 `ctx.llm.registerAdapter()` 的轻量适配器）；
     - `DirectHttpLlmAdapter`：在 `packages/cli` 内直连标准 HTTP 接口，支撑无宿主批处理与 `Plot-Haystack` 评测。
2. **`SystemPort`（版本库与全文检索接缝）**：
   - **Interface**：封装针对单本 `bookRoot` 的原子 `git` 操作（`commitPaths`、`createTag`、`readFileAtRef`、`diffFile`、`resetHard`）与 `ripgrepSearch(patterns, chapterWhitelist, contextParagraphs)`。
   - **测试策略**：集成测试直接在 `/tmp` 创建真实临时 Git 子仓执行并自动清理，不编写脆弱的 Git 字符串 Mock。

### 2.2 `packages/core` 六大深模块接口设计

| 模块名 (`packages/core/src/*`) | 对外窄接口（Interface） | 内部隐藏的深度实现（Implementation） |
| :--- | :--- | :--- |
| **`1. BookStore`** | `loadSnapshot()` / `commitDraft(ch, text)` / `applyStatePatch(ch, patch)` / `recoverWal()` / `detectDirtyChapters()` | 解析 `book_config.yaml` 与四段式实体 Markdown；执行行级槽位增量合并（禁整文件覆写）；拦截固有属性篡改 Diff；执行 1ms 跨文件外键（`char_*`/`item_*`/`ch_*`/`cold_archive`）可达性校验；驱动 `.ops/tx_state.json` 双粒度提交恢复与 `SHA-256` 比对。 |
| **`2. ViewSlicer`** | `sliceForPlanner(snap, req)` / `sliceForWriter(snap, plan)` | 执行 `MAINLINE / PARALLEL / FLASHBACK` 三态 `story_day` 偏序过滤（插叙保留 `Innate Locks`、屏蔽 `Acquired`）；对非 `pov_character` 物理剥离 `SELF_ONLY` 与 `OMNISCIENT_SECRET`；转化 `READER_KNOWN` 戏剧反讽块；对写手物理剥离 `WARPED` 废止条目（灰象双视图隔离）；计算 `>30` 章未出场感官唤醒提示。 |
| **`3. IndexRecall`** | `buildLibrarianCatalog(snap)` / `executePairedRecall(snap, query)` | 按「已封旧卷静态区 + 当前活跃卷动态尾」组装 `<100K` 目录；展开实名、唯一别名与职务称谓（限定出场章白名单）执行 `rg -C 2`；硬编码注入时间差信封；强制校验伏笔回收与证物重现场景的「档案视图 + 原稿切片」成对挂载。 |
| **`4. PrefixAssembler`** | `assembleStrongPrompt(ctx)` / `assembleFastPrompt(ctx)` | 保证 `Planner` 与 `Writer` 前段静态前缀字节 100% 一致；从 `voice_samples.yaml` 按自定义标签执行 `LRU` 防连挂抽样；按需拼入 `ops_style_amendments.md` 与 `craft_plugins`；当配置了 `writer_token_budget` 且超限时，按四级顺序自动压缩直至达标（未设预算或未超标则无损直通）。 |
| **`5. ProseGateAndTelemetry`** | `scanDraft(draft, recentChs, rulesCfg)` / `verifyDualQuotes(claims, store)` / `collectTelemetry(ch, usage)` | 提取并剥离头部 `<blocking>` 标签；运行可独立开关的 `Static Prose Gate` 正则配额表与跨章具象喻体复读检测，输出精确违规行号与上下窗口；执行双侧原句去标点子串验真；零模型计算 `MATTR-500`、Kontoyiannis 熵率 $\hat{H}_K$ 与句段长变异系数 CV。 |
| **`6. NarrativeEngine`** | `bootBook()` / `stepChapter()` / `syncManuscripts()` / `runDreaming()` | 串联开书原创/同人 `T0` 编译与分词率标定；驱动单章双关审校闭环（`<=2` 段局部 `Patch` -> 整章重写 -> `PlanConflictException` 改纲 -> `SAFE_HALT`）；处理 `PARALLEL` 分支暂存与 3-Way Merge；执行人工手改 `Sync` 增量提状态与历史旧章下游只读冲突扫描；运行按脏页增量 `VACUUM`、`Spotlight Trigger` 信号派发及跨章穿帮三级自动梯度自愈。 |

---

## 3. `@deepseek-ai/dsh` 插件集与模式预设集成方案

外层宿主适配完全基于 Cordis 插件声明与 `dsh-agent-presets` 组装，零侵入修改 `dsh` 官方源码：

1. **Bundle 级冗余插件裁剪（`packages/dsh-plugin/cordis.patch.yml`）**：
   - 按 `id` 显式将编码专用插件设为 `disabled: true`：`tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`、`tool-ralph`、`tool-workflow`、`workflow-worker-thread`、`compaction-basic`、`tool-result-pruner`、`agent-instructions`、`plan-mode`。
   - 挂载 `@narrateos/dsh-plugin` 宿主服务，注入 `llm`、`commands`、`tools`、`userQuestions` 与 `workspace`。
2. **专属写作模式预设包（`presets/narrate-studio/`）**：
   - `preset.yml`：注册显示名称「NarrateOS 长篇创作室」，支持在 `dsh web` 设置与新建会话时一键切换；
   - `agent.cordis.yml`：挂载 `@deepseek-ai/dsh-persona`（设 `complete: true, includeRuntimeContext: false` 彻底屏蔽默认编码 Agent 身份与动态环境快照），仅暴露高层工单工具（`narrate_boot`、`narrate_step`、`narrate_sync`、`narrate_dream`、`narrate_status`）。
3. **主会话防污染与优雅停机铁律**：
   - 所有章节正文只在 `NarrativeEngine` 内部流转并直接落盘至 `books/<slug>/manuscripts/`；工具与 `/narrate` 斜杠命令仅向 `dsh` 主会话返回 `< 300` 字符的结构化回执（章号、字数、门禁结果、熵率指标、Git SHA）；
   - 绑定工具执行的 `exec.signal` 与 Cordis Fiber 卸载钩子 `ctx.effect(() => () => engine.requestSafePointHalt())`，确保 5 秒停机窗口内完成 `.ops/tx_state.json` 安全落盘；
   - 开书戏核三选一与超阈值（`> max_auto_rollback_chapters`）回滚确认直接桥接 `ctx.userQuestions.ask()` 弹窗；Web 右侧栏通过 `@deepseek-ai/dsh-client-ui-slots` 渲染章节进度、实体视图与健康度遥测卡片。

---

## 4. 分阶段施工序列与确定性完工判据

严格按依赖自底向上推进；每个阶段结束必须跑通对应自动化检查且零残留占位符（`TODO` / `FIXME`），达标后方可进入下一阶段。

### Phase 1：工作区脚手架、测试夹具与存储事务层 (`BookStore` + `SystemPort`)
- **前置动作**：在初始化 `package.json` 前向用户确认具体第三方基础依赖清单（如 `yaml`、`zod`、`vitest`）。保持根目录 [`manuscript/vol-01/ch-01.md`](../manuscript/vol-01/ch-01.md) 原样不动，编写初始化脚本将其复制派生为 `fixtures/sample-book/` 标准作品仓夹具。
- **交付内容**：搭建 `pnpm` Monorepo 与 TypeScript 严格编译配置；实现 `SystemPort`（真实临时 Git 仓与 `rg` 调用封装）与 `BookStore`（配置加载、四段式实体解析与序列化、行级槽位补丁合并、固有属性写保护 Diff、1ms 外键可达性扫描、WAL 相位状态机与 `SHA-256` 脏章检测）。
- **完工判据（Exit Criteria）**：
  - `pnpm test --filter @narrateos/core` 退出码为 `0`；
  - 自动化测试完整覆盖并断言通过：① 并发/顺序行级补丁零状态丢失；② 企图修改实体 `canonical_name` 或 `Innate Locks` 已锁条目的补丁 100% 被拦截报错；③ 引用不存在的 `char_XXX` / `item_XXX` / `ch_XXXX` 触发外键异常阻止 `state` 提交；④ 模拟 `FEAT_COMMITTED` 后断电重启，`recoverWal()` 精确识别未完成状态并保持 Git 树零脏文件。

### Phase 2：确定性裁剪、成对检索与静态门禁内核 (`ViewSlicer` + `IndexRecall` + `ProseGateAndTelemetry`)
- **交付内容**：零 LLM 调用完整实现 `ViewSlicer`、`IndexRecall` 与 `ProseGateAndTelemetry` 三个纯确定性深模块。
- **完工判据（Exit Criteria）**：
  - 零网络、零模型调用单测全部通过（退出码 `0`）：
    1. **隔离性断言**：`FLASHBACK` 模式下 `day >= target_day` 的后天状态与缓冲 100% 物理消失且 `Innate Locks` 完整保留；非当前 POV 角色的 `SELF_ONLY` 与 `OMNISCIENT_SECRET` 条目在输出字符串中出现次数为 `0`；`WARPED` 条目及违禁原著词在写手视图中出现次数为 `0`；
    2. **回表断言**：对 `fixtures/sample-book/` 执行实名、唯一别名与限章职务称谓检索，准确返回上下各 2 段完整切片且顶部 100% 携带精确计算的 `[出自第 X 章 ... 已过 Y 天]` 时间差信封；伏笔回收缺原稿切片时触发确定性校验失败；
    3. **门禁与遥测断言**：构造含 `<blocking>` 标签、S 姐七刀超标句与跨 5 章重复明喻的测试稿，`scanDraft()` 精确剥离标签并报出全部违规行号；捏造单字差异的伪原句被 `verifyDualQuotes()` 100% 拒止；`MATTR-500` 与 Kontoyiannis 熵率 $\hat{H}_K$ 在合成退化语料（重复文本 vs 自然样章）上呈现严格单调区分。

### Phase 3：双池前缀装配、单章自愈闭环与人工改稿同步 (`PrefixAssembler` + `stepChapter` + `syncManuscripts`)
- **交付内容**：实现 `LlmPort`（含 `ScriptedLlmAdapter` 与 `DirectHttpLlmAdapter`）、`PrefixAssembler`（双池拼装、声纹标本 `LRU` 轮换、`writer_token_budget` 可配四级降级与无预算直通、`craft_plugins` 动态加载）、`NarrativeEngine.stepChapter()` 全链路审校自愈闭环、`NarrativeEngine.syncManuscripts()` 手改同步及 `@narrateos/cli` 基础命令。
- **完工判据（Exit Criteria）**：
  - 基于 `ScriptedLlmAdapter` 跑通全部状态机分支单测（退出码 `0`）：
    1. **前缀零分叉断言**：同一卷内 `Planner` 与 `Prose Writer` 请求的静态前缀区字节序列 `SHA-256` 100% 相等；连续 3 章抽样 `voice_samples` 不发生相邻重复；设 `writer_token_budget = null` 时零裁剪直通，设紧预算时严格按四级顺序压入阈值内；
    2. **分级返工断言**：注入 `<=2` 段八股/小穿帮仅触发局部 `Patch`（不重跑整章），注入细纲级悖论触发 `PlanConflictException` 改纲 v2，连续失败准确落入 `SAFE_HALT`；
    3. **手改 `Sync` 断言**：修改最新章纯修辞零模型调用更新 `sha256`；修改最新章钥匙归属自动增量刷新实体卡；修改旧章自动输出下游冲突章号与行号且下游 `manuscripts/` 文件字节零变动。

### Phase 4：开书编译器、多时间线合并与周期睡眠自愈 (`bootBook` + `PARALLEL` + `runDreaming`)
- **交付内容**：实现原创试播集冷启动与同人 `T0` 设定包切分编译（含异构盲审、召回率 `>=98%` 守恒校验与动态 `tokens_per_char` 标定）、`PARALLEL` 分叉快照与 3-Way Merge（唯一物双线冲突拦截）、按脏页增量 `Dreaming`、`Spotlight Trigger` 前台切镜信号派发、以及基于 `max_auto_rollback_chapters` 的跨章穿帮三级自动自愈。
- **完工判据（Exit Criteria）**：
  - 自动化集成测试全部通过（退出码 `0`）：
    1. 同人设定包编译后，`T0` 后事件在初始 `entities/*.md` 中残留数为 `0`，专有名词守恒率 `>=98%`；
    2. `PARALLEL` 双线各写 2 章期间互不可见对方增量，汇合时成功合并非冲突状态，双线同时消耗同一 `item_001` 时被确定性拦截；
    3. `Dreaming` 执行期间未出场干净实体文件 `mtime` 保持不变；离场角色达临界点产出 `Spotlight Trigger` 信号而非后台直接结算；模拟单点跨章硬穿帮自动完成历史 `Patch + Sync` 零停机修复，模拟阈值内支线穿帮自动打备份 Tag 并 `git reset` 重跑，超阈值准确触发 `SAFE_HALT` 并输出精确章数与字数。

### Phase 5：`@deepseek-ai/dsh` 插件包、写作模式预设与 Web 面板集成 (`packages/dsh-plugin` + `presets/`)
- **交付内容**：实现 `DshLlmAdapter`（无 `sessionId` 净室流式调用与可选显式缓存断点适配器）、`cordis.patch.yml` 冗余插件裁剪、`presets/narrate-studio/` 模式配置、工单回执工具与斜杠命令、`ctx.userQuestions` 问卷桥接，以及基于 `@deepseek-ai/dsh-client-ui-slots` 的 Web 状态与遥测侧栏组件。
- **完工判据（Exit Criteria）**：
  - `packages/core` 对 `@deepseek-ai/*` 的依赖检查计数为 `0`；
  - 启动真实 `dsh web` 加载 `narrate-studio` 预设端到端验证通过：① 冗余内置插件（`subagent`/`ralph`/`tool-result-pruner` 等）处于已禁用态；② 连续执行 3 章生成后，主对话历史仅含百字级工单回执（零章节正文滞留），`TokenUsage.cacheReadTokens > 0` 证实静态前缀缓存真实命中；③ Web 侧栏实时反映最新章节状态与遥测指标，中断信号在 5 秒内安全落盘 `.ops/tx_state.json`。

### Phase 6：`Plot-Haystack` 40 章盲测基准验收
- **交付内容**：构建自动化 40 章同源种子评测脚本与 10 探针核验套件（3 组得而复失极性反转、3 条无日常关联负向红线、2 处台词谎言分流、2 个跨 35 章伏笔回收）。
- **完工判据（Exit Criteria）**：
  - 跑完完整 40 章闭环零未捕获崩溃，所有 Git 提交树与外键完整性 100% 合法；
  - Ch.36-40 定向诱发测试中：负向红线与死亡/唯一物硬穿帮率 `= 0%`，跨 35 章伏笔「档案 + 原稿切片」成对召回率 `= 100%`，同卷内静态前缀缓存命中率稳定达标，首尾 5 章 `MATTR-500` 与 $\hat{H}_K$ 无统计显著坍缩。

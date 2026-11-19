# NarrateOS 软件工程架构与演进规划 (DEVELOPMENT-PLAN)

> **定位**：将 [`ARCHITECTURE.md`](ARCHITECTURE.md) 与 [`WRITING-CRAFT.md`](WRITING-CRAFT.md) 的领域契约落地为 `@deepseek-ai/dsh` 插件集、外部化角色配置与可测试深模块。形式化组件边界、端口契约与行为接线见 [`../design/`](../design/)；架构取舍见 [`ADR-0004`](adr/0004-dsh-native-plugins-and-scoped-role-agents.md)。
> **核心原则**：全面扎根 `@deepseek-ai/dsh` 插件生态；Host 后端与浏览器前端物理分包；工种提示词与工具配额外置为声明式配置；每个模块以 `pnpm run check` 与 `ssot check design` 作为确定性门禁判据。

---

## 1. 技术基线与 DSH 插件包拓扑

- **运行时与工具链**：`Node.js >= 24.9`（对齐 `@deepseek-ai/dsh@0.2.2-rc.1` 基线）、`TypeScript 5.x`（`strict: true`，ESM，4 空格缩进）、`pnpm` Workspace、`vitest`、系统原生 `git` 与内置/系统 `rg` (`ripgrep`)。
- **插件与预设目录拓扑（统一采用 `dsh-` 前缀）**：

```text
narrateos/
├── design/                     # SSoT 形式化架构 (LikeC4)、端口契约 (VDM-SL) 与行为接线 (Quint)
├── packages/
│   ├── dsh-book-store/         # [@narrateos/dsh-book-store] 确定性作品存储、锁、裁剪、门禁与暂存服务 (ctx.narrateStore)
│   ├── dsh-book-tools/         # [@narrateos/dsh-book-tools] 受控读写检索工具、Read-Your-Own-Writes 暂存编辑与 yield_* 门禁
│   ├── dsh-pipeline/           # [@narrateos/dsh-pipeline] 纯 Host 后端：配置化角色执行器、管线调度、斜杠命令与 REST/SSE
│   └── dsh-client-ui-studio/   # [@narrateos/dsh-client-ui-studio] 纯浏览器前端：三栏 Studio 面板与节点实时/历史会话钻取
├── presets/
│   └── dsh-preset-narrateos/   # [@narrateos/dsh-preset-narrateos] 顶层「NarrateOS 创作模式」配置包（零业务代码）
│       ├── cordis.patch.yml    # 开启创作插件与联网工具，显式禁用编码向冗余工具
│       ├── skills/
│       │   └── narrate-boot/   # 开书构思与重大改纲 Skill（主 SKILL.md < 8,192 字符 + references/）
│       └── roles/              # 后台工种声明式配置与提示词（支持在 books/<slug>/world/roles/ 单书覆盖）
│           ├── boot-compiler.yml
│           ├── librarian.yml
│           ├── planner.yml
│           ├── writer.yml
│           ├── patch.yml
│           ├── fact-checker.yml
│           ├── extractor.yml
│           ├── dreamer.yml
│           └── prompts/*.md
├── plugins/
│   └── craft/                  # 外置可选认知插件声明 (vad-bdi.yaml / dual-reaction.yaml / scene-act.yaml / dialogue-subtext.yaml / sensory-grounding.yaml)
├── fixtures/
│   └── sample-book/            # 测试夹具工作区（从只读 manuscript/vol-01/ch-01.md 派生初始化）
└── books/                      # [gitignored] 实际创作的独立作品 Git 仓库目录
```

**前后端与配置边界**：
1. `dsh-book-store`、`dsh-book-tools`、`dsh-pipeline` 为纯 Node.js 包，零 React/DOM 依赖；无头回归测试、批处理驱动与二期评测只需加载这 3 个包与 `dsh-base` 即可运行。
2. `dsh-client-ui-studio` 遵循 `@deepseek-ai/dsh` 官方 `dsh-client-ui-*` 规范（Host 入口仅做空发现导出，浏览器代码走 `dsh.client` 独立编译打包）。
3. 任何工种的模型池路由、允许调用的工具列表、只读次数上限、采样参数与系统提示词一律从 `roles/*.yml` 与 `prompts/*.md` 加载，严禁在 TypeScript 代码中写死。

---

## 2. Cordis 服务契约、受控工具与可观测性设计

### 2.1 四大插件深模块契约

| 插件包 | 静态 `inject` | 动态可选 `ctx.inject` | 对外服务与核心职责 |
| :--- | :--- | :--- | :--- |
| **`@narrateos/dsh-book-store`** | 无模型/Web 依赖 | 无 | 提供 `ctx.narrateStore`：管理多书切换（`onBookSwitched` 广播，在途任务未排空前拒绝 `switchBook` 并返回 `409`）、`.ops/tx.lock` 排他锁（进程内互斥队列 + 原子 `rename` 回收过期锁）、WAL 双粒度提交恢复（`BookConfigSchema` 收口 `opening` / `retrieval` / `context_assembly` / `repair_loop` / `dreaming` / `ops_and_sync` 六组可配变量，全仓显式路径提交并生成单书 `.gitignore`）、`Innate Locks` 防篡改（仅在开书/新建/改第 1 区拦截 `OMNISCIENT_SECRET`，第 2 区 `upsert_slot` 强制回填 `slot_key` 并校验转义 `|` / `[` / `]`）、1ms 外键可达性校验、冷宫合法 ID 过滤与 `MAINLINE` 唤醒回写（`FLASHBACK` 写保护）、`ParallelSandbox`（`PARALLEL` 分叉/三方合并及分支 `L2` 增量暂存）、`ViewSlicer`（POV / 未知 `vis:` Fail-Closed `DROP` / `WARPED` / `author_charter` / `arc_director_plan` 剥离，仅 `cleanroomDisplay: true` 对 `Writer`/`Patch` 剥离工程标签）、`IndexRecall`（按 `bookRoot` 实例缓存校验 `(mtimeMs, size, chapter_hashes)` 并优先读 `StagingSession`、定长块冻结折叠、段级限流共现排序与首秀豁免）、`StaticProseGate`（`maxPatchParagraphs=15`, `maxPatchParagraphRatio=0.6`, 跨章喻体按历史章数判定，诊断脱敏命中原词）、双侧原句去标点验真、退化遥测、扩展 `RunRecordSchema` 与 `StagingSession`（每文件版本栈支持单步 `revert`、`.ops/` 硬白名单 + `realpath` 重验）。 |
| **`@narrateos/dsh-book-tools`** | `narrateStore` | `tools`（主会话写保护守卫） | 导出按 `runId` 与角色 YAML 配置实例化的受控工具构建器，并对主会话挂载 `tools/pre-execute` 守卫（Shell 只读命令白名单，同时覆盖 `booksRoot` 与当前活跃 `bookRoot`）：<br>1. `book_read` / `book_grep` / `book_glob`：锁死当前 `bookRoot` 允许目录（`.ops/` 硬白名单、字符/条数限流与 `realpath` 软链逃逸拦截、支持 `blockedReadPaths` 与 `PARALLEL` 分支手稿隔离），`book_read` 支持最多 8 路径批读与整行续读游标、**优先读取本轮 `StagingSession` 覆盖层（Read-Your-Own-Writes）**，仅在至少成功读取一个新文件时扣减 `maxReadCalls` 配额；<br>2. `book_edit`：支持 `replace` 与单步 `revert` 操作写入当前 `runId` 独占 `StagingSession`（与 `yield_dream_commit` 共用同一套只读路径、实体结构与 `Innate Locks` 校验，编辑期违规返回非阻塞预警与 `revert` 指引），`finally` 块无条件丢弃未提交暂存；<br>3. `patch_paragraphs` & `yield_patched_draft`：面向 `Patch` 的纯内存段落编辑闭环（`InMemoryDraftPatchSession`，零磁盘读写与 `maxReadCalls: 0`），按 `0-based` 索引执行非重叠区间替换（拆并段后返回最新段首坐标表、脱敏命中原词、保留章首标题且 `editCount >= 1`）并内置实时 `StaticProseGate` 复核；<br>4. `yield_*` 终态门禁（`yield_context_pack`、`yield_outline`、`yield_verdict`、`yield_state_patch`、`yield_dream_commit`、`yield_boot_bundle`、`yield_patched_draft`）：禁用并行（`isConcurrencySafe: false`），校验首秀豁免/手填切片原稿验真、防死循环 `prose_anchors`、`FLASHBACK` 第 2/4 区拦截、冷宫 `Innate Locks`、声纹门禁与 `accumulated_words_since_dream` 归零后，最后调用 `exec.concludeTurn()`；配套 `'agent/pre-step'` 与 `'agent/turn-stopping'` 联合统计步数受 `maxSteps` 硬限制；<br>5. `lock_charter_and_boot`：同一文件系统临时目录编译与初始 Git 提交后原子替换发布、生成单书 `.gitignore`、保留 `BOOT_COMPILER` 会话轨迹，随后自动触发 `switchBook` 激活新书（返回 `switchedBook` 与冲突原因）。 |
| **`@narrateos/dsh-pipeline`** | `narrateStore`, `agents`, `llm` | `webServer`, `commands`, `skills` | 提供 `ctx.narratePipeline`：解析外部 `roles/*.yml`（`RoleLoader` 解析 `realpath` 防软链越界，支持 `books/<slug>/world/roles/` 单书覆盖及 `blockedReadPaths` 透传）；配置 `pluginSearchDirs`（引擎 `plugins/craft/` + 单书 `<bookRoot>/plugins/`，在 `craft_plugins: []` 时早退零扫盘）按 `applicable_roles` 分发注入 `Planner` / `Writer` / `FactChecker`；`RoleRunner` **全面统一基于 `ctx.agents.create`（通过最外层 `{ prepend: true }` 拦截 `agent/pre-step` 剥离 `AGENTS.md`、`beginRun` 置入 `try`、会话落盘即清 `liveSessionDetails` 并校验 `bookRoot`、`DshLlmAdapter` 统一拆分 `provider:model` 与透传真实 `finishReason`）**，其中 `writer`（`cleanroom: true`）保持零工具单轮净室调用，`patch`（`cleanroom: false`, `maxReadCalls: 0`）运行于纯内存段落编辑闭环；内置 `ChapterPipeline`（`FEAT_COMMITTED` 保存终审确认 `fact_confirmations` 并在主线 `STATE_COMMITTED` 同批幂等核销开篇节拍与已结案伏笔、`hybrid_rolling` 声纹置换、局部哨兵 vs 全局熔断双轨计数）、`SyncPipeline`（未完成半章恢复优先于同步、已登记缺失手稿显式报错、分批扫描 + 双侧验真在指纹提交后公开 `.ops/sync_conflicts.json`）、`DreamingPipeline`（闭区间分段锁自愈与 `.ops/heal_plan.json` 持久化断点）、`VolumePipeline`（显式路径提交后再打 Tag、注入 `author_charter.md` 拆离 `current_arc_envelope.md` / `arc_director_plan.md`、满 `10` 卷或完结折叠 `L0_sagas.md`），以及基于 `.ops/signals_cursor.json` (`consumedIds`)、`.ops/next_chapter_options.json` 与软硬双档 `requestHalt({ force })` 的运行时控制面。 |
| **`@narrateos/dsh-client-ui-studio`** | 浏览器侧 `slots`, `layout` | 无 | 注册 `'main'` 槽位 `narrateos-studio` 与侧栏入口：渲染左栏书目/章卡/物化视图、中栏 6 节点状态图（`SSE_STAGE_ALIAS` 将 `LOCAL_PATCH` / `REWRITE` 归集于 `WRITER` 节点、`REPLAN` 归集于 `PLANNER` 节点并按序保留全部尝试会话 `StageAttemptSession[]`）+ `正文 \| 细纲 \| Diff` 编辑检阅（含未保存草稿导航守卫）+ 底部**无 Agent Loop 微调信号输入栏**、右栏运维诊断检查器（含「关联会话轨迹列表」按次点入任意 `attempt`）与「工具」页签（挂载 `RoleRoutingEditor` 直接编辑分角色两层模型路由及「声纹采集 (Voice Harvest)」操作卡片）；`StageSessionViewer` 支持实时原生视图与 `.ops/session_logs` 归档回放，展示 `modelId`、`thinkingChars`、完整 `requestInput` 与完整 `tool-result` 原文。 |

### 2.2 Cordis 生命周期与斜杠命令契约

1. **零单例与有序排空卸载**：禁止模块级可变状态；服务发布统一采用 `ctx.effect(function* () { ... yield ctx.provide(...); })` 组合持有。`dsh-pipeline` 卸载时先关闭新任务准入闸门，向在途任务发出收束信号并等待运行中的工种 `Agent` 与 WAL/Git 提交彻底排空（超时发出 `halt:waiting` 状态提示但不强杀锁或提前卸载路由），排空完成后再释放下层资源。
2. **聊天栏斜杠命令（`@deepseek-ai/dsh-commands`）**：通过动态 `ctx.inject(['commands'])` 注册 `/narrate-step`、`/narrate-yolo [n]`、`/narrate-halt`、`/narrate-dream`、`/narrate-sync`、`/narrate-signal <内容>`。所有命令绕过模型（0 Token、不开对话 Turn），校验准入后**异步启动后台管线并立即返回短文本回执**，避免阻塞聊天输入框。
3. **顶层创作模式（`@narrateos/dsh-preset-narrateos`）**：通过 `@deepseek-ai/dsh-agent-preset` 注册唯一面向用户的「NarrateOS 创作模式」，挂载 `@deepseek-ai/dsh-persona`（`complete: true`, `includeRuntimeContext: false`）、上述 4 个插件及 `dsh-tool-web`，显式禁用编码向工具插件；不将后台工种注册为 `dsh-agent-preset`，保持模式下拉列表纯净。

### 2.3 原生会话日志与本地追踪协同

1. **全工种统一原生会话留存与 `.ops/session_logs/` 调试归档**：`RoleRunner` 对多轮探查工种、`Patch` 内存闭环与净室单轮 `Writer` 统一基于 `ctx.agents.create` 启动独立会话（设置 `meta: { cwd: bookRoot }` 并在 `setup` 内以最外层 `{ prepend: true }` 拦截 `agent/pre-step` 过滤宿主 `agent-instructions` / `AGENTS.md`，同时调用 `agentCtx.tools.restrict({ allow: [] })` 屏蔽宿主全局工具），执行完毕调用 `handle.dispose()` 停止循环，保留 DSH 持久化 Session 日志；同时将 `{ runId, chapter, stage, role, sessionId, status, attempt, triggerReason, parentSessionId, mode }` 追加记录至作品 `.ops/runs.jsonl`，并将完整会话调试快照落盘至 `.ops/session_logs/<sessionId>.json`（含 `modelId`、`usage`、`reasoning`、`thinkingChars`、在 `trace_level !== 'off'` 时写入的完整 `requestInput` 输入上下文，以及最大 `32000` 字符的完整 `tool-result` 与实时流事件）。
2. **极简环境回退与门禁产物本地追踪**：仅当极简单测环境未注入 `ctx.agents.create` 时，`runCleanroom` 安全回退至 `DshLlmAdapter` 直调；净室 `Writer`（经 `generateTraced`）及门禁前废稿/诊断，继续支持 `world/book_config.yaml` 的 `trace_level`（`full` | `metadata` | `off`，默认 `full`）落盘至 `.ops/traces/<run_id>/`（目录权限 `0700`、文件 `0600`，`.gitignore` 排除提交，遮蔽认证字段，追踪故障仅写 stderr 绝不影响业务结果）；开书阶段保留 `BOOT_COMPILER` 会话日志迁入新书 `.ops/session_logs/` 以便工作台回放。

---

## 3. 外部化角色配置规范 (`roles/*.yml`)

`dsh-pipeline` 的通用角色执行器按以下结构解析每个工种配置（代码只认 schema，不绑定具体角色名）：

```yaml
id: planner
pool: strong_creative               # 映射作品/宿主配置的 strong_creative | fast_retrieval | audit（可被 book_config.yaml role_routing[id] 覆盖）
cleanroom: false                    # 统一经 ctx.agents.create 启动：true 为零工具单轮净室路径；false 为挂载受控工具与 yield_* 的多轮路径
promptFile: ./prompts/planner.md    # 相对路径，支持单书在 world/roles/prompts/ 覆盖
temperature: 0.5
reasoningEffort: high
maxSteps: 6                         # 多轮工种最大步数兜底
maxReadCalls: 3                     # 工具层对 book_read / book_grep / book_glob 的硬限流总次数（patch 置为 0）
tools:                              # 仅挂载列出的受控工具名（patch 仅挂纯内存 patch_paragraphs）
    - book_read
    - book_grep
yieldTool: yield_outline            # 必须成功调用方可结束回合的终态门禁工具（patch 为 yield_patched_draft）
```

---

## 4. 已落地基线（Phase 1-4）与二期演进规划（Phase 5）

### 4.1 已落地工程基线（Phase 1-4）

四大源码包（`@narrateos/dsh-book-store`、`@narrateos/dsh-book-tools`、`@narrateos/dsh-pipeline`、`@narrateos/dsh-client-ui-studio`）与顶层预设（`@narrateos/dsh-preset-narrateos`）已完成全量落地与集成回归覆盖：
- **代码与预设门禁**：`pnpm run check`（串联全包构建、TypeScript 类型检查、`scripts/lint-repo.mjs` 静态门禁、预设校验与 Vitest 全量单测/集成测试）；
- **形式化架构与契约门禁**：`ssot check design`（校验 [`design/structure/narrateos.c4`](../design/structure/narrateos.c4) 四层架构拓扑、[`design/contract/*.vdmsl`](../design/contract/) 端口前后置契约与 [`design/behavior/settlement.qnt`](../design/behavior/settlement.qnt) 两阶段提交/暂存门禁/崩溃恢复轨迹回放）。

### 4.2 Phase 5（二期规划与后续专项演进）

以下各项属后续专项演进规划，未在当前基线实装：
1. **`Boot Plan Bench`（开篇大纲方案评判修正循环）**：固定跨题材种子集，利用解耦的 `skills/narrate-boot` 与 `roles/` 配置自动跑完「开书建库 + 试写前 3 章正文」，结合契约违背率、节奏早泄检测与盲测阅读评分迭代寻优开篇构思方案。
2. **`Plot-Haystack` 40 章盲测基准**：运行 40 章同源种子与 10 枚探针核验套件，验证 Ch.36-40 负向红线零穿帮、跨 35 章伏笔 `100%` 成对召回与首尾语言熵率稳定。
3. **既有存稿两步反向建库**：支持导入已写 `ch_0001..K.md` 手稿计算哈希建档、滑窗抽取现状并人工复核 `Innate Locks` 与声纹，再进入构思对话补齐未揭底牌与后续卷纲无缝续写。
4. **Flow B 卷中改纲受控写回与 Boot 多 Agent 并行拆解**：主对话卷中重大改纲专用的受控资产写回工具（`replan_book_assets`）与开书编排多 Agent 并行拆解留待后续专项迭代落地；当前卷中微调通过 `.ops/signals.jsonl` 在安全点消费，开书统一经 `lock_charter_and_boot` 原子编译并自动 `switchBook`。

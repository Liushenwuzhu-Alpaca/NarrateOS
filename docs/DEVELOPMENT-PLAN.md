# NarrateOS 软件工程架构与程序开发计划 (DEVELOPMENT-PLAN)

> **定位**：将 [`ARCHITECTURE.md`](ARCHITECTURE.md) 与 [`WRITING-CRAFT.md`](WRITING-CRAFT.md) 的领域契约落地为 `@deepseek-ai/dsh` 插件集、外部化角色配置与可测试深模块的工程施工蓝图。
> **核心原则**：全面扎根 `@deepseek-ai/dsh` 插件生态；Host 后端与浏览器前端物理分包；工种提示词与工具配额外置为声明式配置；每个模块以可自动执行的确定性测试作为唯一放行判据。
> **状态口径**：仓库当前存有待重构迁移的早期包结构（`packages/core`、`packages/cli`、`packages/dsh-plugin`、`presets/narrate-studio`）；下文定义的目标多插件拓扑与各阶段能力以源码落地及自动化测试通过确认交付。架构取舍见 [`ADR-0004`](adr/0004-dsh-native-plugins-and-scoped-role-agents.md)。

---

## 1. 技术基线与 DSH 插件包拓扑

- **运行时与工具链**：`Node.js >= 24.9`（对齐 `@deepseek-ai/dsh@0.2.2-rc.1` 基线）、`TypeScript 5.x`（`strict: true`，ESM，4 空格缩进）、`pnpm` Workspace、`vitest`、系统原生 `git` 与内置/系统 `rg` (`ripgrep`)。
- **插件与预设目录拓扑（统一采用 `dsh-` 前缀）**：

```text
narrateos/
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
│   └── craft/                  # 外置可选认知插件模板（vad-bdi.md / dual-reaction.md / scene-act.md）
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
| **`@narrateos/dsh-book-store`** | 无模型/Web 依赖 | 无 | 提供 `ctx.narrateStore`：管理多书切换（在途任务未排空前拒绝 `switchBook` 并返回 `409`）、`.ops/tx.lock` 排他锁、WAL 双粒度提交恢复、`Innate Locks` 防篡改、1ms 外键可达性校验、`ParallelSandbox`（`PARALLEL` 分叉与三方合并）、`ViewSlicer`（POV / `WARPED` / `author_charter` / `arc_director_plan` 物理剥离）、`IndexRecall`（带时间差信封与成对挂载核验）、`StaticProseGate`、双侧原句去标点验真、退化遥测、`.ops/runs.jsonl` 会话索引，以及**按 `runId` 隔离的 `StagingSession`（内存暂存覆盖层）**。 |
| **`@narrateos/dsh-book-tools`** | `narrateStore` | `tools`（主会话写保护守卫） | 导出按 `runId` 与角色 YAML 配置实例化的受控工具构建器，并对主会话挂载 `tools/pre-execute` 守卫（禁止普通对话用裸 `write/edit/bash` 直接修改 `books/<slug>/`）：<br>1. `book_read` / `book_grep` / `book_glob`：锁死当前 `bookRoot` 允许目录（物理屏蔽 `.ops/` 与跨书路径），`book_read` **优先读取本轮 `StagingSession` 覆盖层（Read-Your-Own-Writes）**，按角色配置 `maxReadCalls` 执行硬计数限流；<br>2. `book_edit`：局部字符串替换写入当前 `runId` 独占 `StagingSession`，禁碰 `manuscripts/`，`finally` 块无条件丢弃未提交暂存；<br>3. `patch_paragraphs` & `yield_patched_draft`：面向 `Patch` 的纯内存段落编辑闭环（`InMemoryDraftPatchSession`，零磁盘读写与 `maxReadCalls: 0`），按 `0-based` 索引执行非重叠区间替换并内置实时 `StaticProseGate` 复核；<br>4. `yield_*` 终态门禁（`yield_context_pack`、`yield_outline`、`yield_verdict`、`yield_state_patch`、`yield_dream_commit`、`yield_boot_bundle`、`yield_patched_draft`）：禁用并行（`isConcurrencySafe: false`），**先完成全部确定性校验与 WAL/Git 原子落盘，最后一行调用 `exec.concludeTurn()`**；配套 `'agent/turn-stopping'` Hook 拦截未完成 `yield_*` 的纯文本提前停止并注入 `steer` 继续指令（受 `maxSteps` 兜底限制）；<br>5. `lock_charter_and_boot`：锁定《作者契约》快照并执行原子建库，建库后自动调用 `ctx.narrateStore.switchBook(res.bookRoot)` 激活新书（遇在途锁冲突不回滚已落盘建库结果）。 |
| **`@narrateos/dsh-pipeline`** | `narrateStore`, `agents`, `llm` | `webServer`, `commands`, `skills` | 提供 `ctx.narratePipeline`：解析外部 `roles/*.yml`（优先读取 `books/<slug>/world/roles/` 单书覆盖，回退至预设包默认配置）；`RoleRunner` **全面统一基于 `ctx.agents.create`（通过最外层 `{ prepend: true }` 拦截 `agent/pre-step` 剥离 `agent-instructions` / `AGENTS.md`）** 为全工种建立可回放会话——多轮工种挂受控白名单与 `yield_*` 防逃逸 Hook，`writer`（`cleanroom: true`）保持零工具单轮净室调用（`REWRITE` 仅接收正向脱敏 `rewriteFeedback`），`patch`（`cleanroom: false`, `maxReadCalls: 0`）运行于纯内存段落编辑闭环；支持分角色两层模型路由 `role_routing` 与单章/YOLO/`Sync`/多轮 `Dreaming`/跨章自愈/换卷调度，并动态挂载 REST/SSE（含 `POST /api/narrate/voice-harvest`）、`/narrate-*` 斜杠命令与 `narrate-boot` Skill。 |
| **`@narrateos/dsh-client-ui-studio`** | 浏览器侧 `slots`, `layout` | 无 | 注册 `'main'` 槽位 `narrateos-studio` 与侧栏入口：渲染左栏书目/章卡/物化视图、中栏 6 节点状态图（`SSE_STAGE_ALIAS` 将 `LOCAL_PATCH` / `REWRITE` 归集于 `WRITER` 节点、`REPLAN` 归集于 `PLANNER` 节点并按序保留全部尝试会话 `StageAttemptSession[]`）+ `正文 \| 细纲 \| Diff` 编辑检阅（含未保存草稿导航守卫）+ 底部**无 Agent Loop 微调信号输入栏**、右栏运维诊断检查器（含「关联会话轨迹列表」按次点入任意 `attempt`）与「工具」页签（挂载 `RoleRoutingEditor` 直接编辑分角色两层模型路由及「声纹采集 (Voice Harvest)」操作卡片）；`StageSessionViewer` 支持实时原生视图与 `.ops/session_logs` 归档回放，展示 `modelId`、`thinkingChars`、完整 `requestInput` 与完整 `tool-result` 原文。 |

### 2.2 Cordis 生命周期与斜杠命令契约

1. **零单例与有序排空卸载**：禁止模块级可变状态；服务发布统一采用 `ctx.effect(function* () { ... yield ctx.provide(...); })` 组合持有。`dsh-pipeline` 卸载时先关闭新任务准入闸门，向在途任务发出收束信号并等待运行中的工种 `Agent` 与 WAL/Git 提交彻底排空（超时发出 `halt:waiting` 状态提示但不强杀锁或提前卸载路由），排空完成后再释放下层资源。
2. **聊天栏斜杠命令（`@deepseek-ai/dsh-commands`）**：通过动态 `ctx.inject(['commands'])` 注册 `/narrate-step`、`/narrate-yolo [n]`、`/narrate-halt`、`/narrate-dream`、`/narrate-sync`、`/narrate-signal <内容>`。所有命令绕过模型（0 Token、不开对话 Turn），校验准入后**异步启动后台管线并立即返回短文本回执**，避免阻塞聊天输入框。
3. **顶层创作模式（`@narrateos/dsh-preset-narrateos`）**：通过 `@deepseek-ai/dsh-agent-preset` 注册唯一面向用户的「NarrateOS 创作模式」，挂载 `@deepseek-ai/dsh-persona`（`complete: true`, `includeRuntimeContext: false`）、上述 4 个插件及 `dsh-tool-web`，显式禁用编码向工具插件；不将后台工种注册为 `dsh-agent-preset`，保持模式下拉列表纯净。

### 2.3 原生会话日志与本地追踪协同

1. **全工种统一原生会话留存与 `.ops/session_logs/` 调试归档**：`RoleRunner` 对多轮探查工种、`Patch` 内存闭环与净室单轮 `Writer` 统一基于 `ctx.agents.create` 启动独立会话（设置 `meta: { cwd: bookRoot }` 并在 `setup` 内以最外层 `{ prepend: true }` 拦截 `agent/pre-step` 过滤宿主 `agent-instructions` / `AGENTS.md`，同时调用 `agentCtx.tools.restrict({ allow: [] })` 屏蔽宿主全局工具），执行完毕调用 `handle.dispose()` 停止循环，保留 DSH 持久化 Session 日志；同时将 `{ runId, chapter, stage, role, sessionId, status, attempt, triggerReason, parentSessionId, mode }` 追加记录至作品 `.ops/runs.jsonl`，并将完整会话调试快照落盘至 `.ops/session_logs/<sessionId>.json`（含 `modelId`、`usage`、`reasoning`、`thinkingChars`、在 `trace_level !== 'off'` 时写入的完整 `requestInput` 输入上下文，以及最大 `32000` 字符的完整 `tool-result` 与实时流事件）。
2. **极简环境回退与门禁产物本地追踪**：仅当极简单测环境未注入 `ctx.agents.create` 时，`runCleanroom` 安全回退至 `DshLlmAdapter` 直调；分词标定、净室 `Writer`（经 `generateTraced`）及门禁前废稿/诊断，继续支持 `world/book_config.yaml` 的 `trace_level`（`full` | `metadata` | `off`，默认 `full`）落盘至 `.ops/traces/<run_id>/`（目录权限 `0700`、文件 `0600`，`.gitignore` 排除提交，遮蔽认证字段，追踪故障仅写 stderr 绝不影响业务结果）。

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

## 4. 分阶段施工序列与确定性完工判据

按依赖顺序自底向上施工；每一阶段必须通过对应自动化测试且零 `TODO` / `FIXME` 占位符方可放行。

### Phase 1：确定性存储、裁剪、门禁与暂存服务 (`@narrateos/dsh-book-store`)

- **交付内容**：将现有纯确定性仓储、裁剪、回表、门禁与并行沙盒迁移提纯为 `@narrateos/dsh-book-store`（导出 `ctx.narrateStore`），新增 `author_charter.md` / `arc_director_plan.md` 读写与物理剥离、`.ops/runs.jsonl` 会话索引，以及按 `runId` 隔离的 `StagingSession` 内存覆盖层。保持 [`manuscript/vol-01/ch-01.md`](../manuscript/vol-01/ch-01.md) 只读不动。
- **确定性不变量与完工判据**：
  - `pnpm --filter @narrateos/dsh-book-store test` 退出码为 `0`（全离线零模型调用）：
  - **排他锁与恢复**：事务锁仅在持锁进程已退出时回收，释放时校验所有权；WAL 恢复以 Git 已提交状态为准，仅回退持久化写集文件并先备份至 `.ops/recovery/`（保留历史手改与未跟踪笔记并继续报告脏状态）；`Dreaming` 在运行前与提交前双重拒绝 `DRAFTING / FEAT_COMMITTED` 未完成相位。
  - **隔离与裁剪**：`ViewSlicer` 为写手拼装视图时，`OMNISCIENT_SECRET`、`WARPED`、`author_charter.md` 与 `arc_director_plan.md` 内容出现次数为 `0`；`FLASHBACK` 模式下 `day >= target_day` 的后天状态与缓冲出现次数为 `0` 且 `Innate Locks` 完整保留；四级预算裁剪保留每个必需证据章至少 1 条切片，仍超 `writer_token_budget` 时明确报错停止而非删必需证据。
  - **回表、门禁与分段器**：`L2` 章卡持久化出场实体 ID，通用职务称谓仅在对应出场章集合内执行 `rg -C 2` 并 100% 携带时间差信封；门禁与局部 `Patch` 共用空白行自然段分段器，跨行 HTML 注释报告起始行列进入修补，双侧原句去标点验真 100% 拦截单字捏造伪句；强主观第一人称配置下豁免视角角色主观评判规则。
  - **多时间线与暂存隔离**：`PARALLEL` 显式 fork/merge 校验标签有效性、章号严格递增与窗口内唯一，双线消耗同一唯一道具时确定性拦截；两个并发 `runId` 的 `StagingSession` 读写完全隔离，未提交销毁后磁盘文件字节零变动。

### Phase 2：受控领域工具库、`yield_*` 门禁与防逃逸 Hook (`@narrateos/dsh-book-tools`)

- **交付内容**：实现 `book_read` / `book_grep` / `book_glob`、`book_edit`、纯内存段落编辑工具 `patch_paragraphs`（`InMemoryDraftPatchSession`）、全套 `yield_*`（`yield_context_pack`、`yield_outline`、`yield_verdict`、`yield_state_patch`、`yield_dream_commit`、`yield_boot_bundle`、`yield_patched_draft`）、`lock_charter_and_boot`（建库后自动 `switchBook`）、`'agent/turn-stopping'` 未提交续跑 Hook 及主会话 `books/<slug>/` 裸写拦截守卫。
- **完工判据**：
  - `pnpm --filter @narrateos/dsh-book-tools test` 退出码为 `0`：
  - **路径围栏与配额守卫**：企图通过 `book_read / book_grep / book_glob` 读取 `../`、其他作品目录或 `.ops/` 时 100% 拦截报错；当 `maxReadCalls = 3` 时，第 4 次只读调用被确定性拦截并返回调用 `yield_*` 提示。
  - **纯内存修补闭环与自动切书**：`patch_paragraphs` 校验 `0-based` 非重叠区间替换、自动保留第 0 段 `# ` 一级标题并在每次修改后实时运行 `StaticProseGate`；`yield_patched_draft` 提交前再次强制复检门禁（`enforceProseGateOnYield`），全程零磁盘读写；`lock_charter_and_boot` 落盘后自动调用 `ctx.narrateStore.switchBook`（遇在途锁冲突不回滚已建库资产）。
  - **Read-Your-Own-Writes 与红线保护**：同一 `runId` 内调用 `book_edit` 修改 `open_threads.md` 后紧接着调用 `book_read`，准确读回修改后的暂存文本；企图 `book_edit` 修改 `manuscripts/` 当场拒绝；`yield_dream_commit` 与 `yield_state_patch` 对篡改 `Innate Locks`、超 `15` 条活跃伏笔、缺中文 `canonical_name` 或断链外键 100% 报错打回且磁盘零写入，全部校验与 WAL/Git 落盘成功后方才触发 `exec.concludeTurn()`。
  - **防纯文本逃逸**：模拟工种模型未调 `yield_*` 直接返回纯文本，`'agent/turn-stopping'` Hook 准确拦截停止并注入继续指令；达 `maxSteps` 仍未提交时安全中止并清理暂存区。

### Phase 3：外部化角色配置、后台管线调度与斜杠命令 (`@narrateos/dsh-pipeline` + `@narrateos/dsh-preset-narrateos`)

- **交付内容**：搭建 `presets/dsh-preset-narrateos/`（顶层模式 `cordis.patch.yml`、全套 `roles/*.yml` 含 `patch.yml` 与 `prompts/*.md`）；实现 `@narrateos/dsh-pipeline` 的配置加载器（支持单书覆盖及 `role_routing` 两层模型路由）、统一基于 `ctx.agents.create` 的通用 `RoleRunner`（最外层 `{ prepend: true }` 拦截 `agent/pre-step` 剥离 `AGENTS.md`，写手保持零工具单轮净室且支持正向脱敏 `rewriteFeedback`，`Patch` 接入纯内存多轮段落编辑闭环，`.ops/session_logs/<sessionId>.json` 留档 `requestInput` 与完整 `tool-result`，`.ops/runs.jsonl` 记录 `attempt` / `triggerReason`）、单章 6 阶段管线（分散超标 `<=15` 段且占比 `<=60%` 优先 `LOCAL_PATCH`，大面积失控或 `Fact Checker` `>=3` 段崩盘触发 `REWRITE`）、YOLO 连跑、`Sync`（共用作品锁与 `.ops/manual_edits/` 备份）、多轮 `Dreaming`、三级跨章自愈、五步换卷、动态 `webServer` REST/SSE 路由（含 `POST /api/narrate/voice-harvest`）与 `/narrate-*` 斜杠命令，以及基于精简 Cordis Host 的无头批处理入口。
- **完工判据**：
  - 在无 `webServer` 的精简 Cordis Host 下跑通全部管线集成测试（退出码 `0`）：
  - **配置解耦与模式纯净度**：修改单本书 `world/roles/planner.yml` 的 `maxReadCalls`、`prompts/*.md` 或 `book_config.yaml` 中的 `role_routing` 无需重新编译即生效；挂载 `dsh-preset-narrateos` 后，前端模式列表仅新增单一「NarrateOS 创作模式」，编码向冗余工具在该模式下不可见。
  - **多工种管线、内存修补与多轮 Dreaming**：单章推进完整写入 `.ops/runs.jsonl`（含 `attempt` / `triggerReason`）与 `.ops/session_logs/<sessionId>.json`（含 `requestInput` 与 `tool-result`）；`Writer` 与 `Patch` 均隔离宿主 `AGENTS.md` 及全知档案；`Dreamer` 多轮读取章卡与原稿后通过 `book_edit` 同步更新脏实体、伏笔表、惯性表与 `arc_director_plan.md` 并在单次 `dream` 提交落盘，未出场干净实体 `mtime` 不变；跑章期间请求 `switchBook` 返回 `409`。
  - **斜杠命令与优雅停机**：`/narrate-step`、`/narrate-yolo`、`/narrate-halt`、`/narrate-signal` 零模型调用异步触发并立即返回回执；在途章节生成中触发插件卸载，服务等待当前安全点或取消收束完成后释放，零残留锁文件。

### Phase 4：Studio 独立前端、实时节点会话钻取与开书端到端验收 (`@narrateos/dsh-client-ui-studio` + `narrate-boot`)

- **交付内容**：将三栏工作台迁入独立包 `@narrateos/dsh-client-ui-studio`；打通中栏 6 节点流水线状态（`SSE_STAGE_ALIAS` 将 `LOCAL_PATCH` / `REWRITE` 归集于 `WRITER` 节点、`REPLAN` 归集于 `PLANNER` 节点，按序保留 `StageAttemptSession[]`）与右栏「关联会话轨迹列表」按次点入 `StageSessionViewer` 展示 DSH 原生 `Conversation` / `Trajectory`、`modelId`、`thinkingChars`、完整 `requestInput` 与 `tool-result` 原文；在右栏「工具」页签挂载 `RoleRoutingEditor` 与「声纹采集 (Voice Harvest)」操作卡片（`POST /api/narrate/voice-harvest`）；编写 `< 8,192` 字符主体的 `skills/narrate-boot/SKILL.md`（及 `references/`）与首章 `Voice Harvest` 采集逻辑。
- **完工判据**：
  - 前端与端到端检查全部通过，并在真实 `dsh web` 界面完成实测验证：
  - **界面、路由编辑与多尝试钻取验证**：三栏布局、未保存草稿导航守卫、底部无 Loop 微调信号投递与撤回正常运作；右栏「工具」页签可直接调整并持久化 `role_routing`，亦可手动触发 `Voice Harvest`；单章推进与 `Dreaming` 期间点击活跃节点或历史节点「关联会话轨迹列表」中的任意尝试，可实时或从 `.ops/session_logs` 回放思考流、`requestInput` 与工具调用原文。
  - **同源种子端到端实跑验收**：使用写实港口核验种子跑通 `主对话 /narrate-boot 构思锁定契约 -> lock_charter_and_boot 建库停机并自动 switchBook -> Studio 书目自动刷新 -> 手动点启动生成第 1 章（0 声纹起步，仅消费第 1 拍）-> 首章校准与 Voice Harvest 入池 -> 连跑推进触发首次多轮 Dreaming`，核验 `T0` 100% 守恒、零超自然越权漂移、写手输入零禁区词泄露、声纹池零案情私货。

### Phase 5（二期规划与后续专项演进）：开篇 Bench、40 章盲测、存稿建库与未实装演进项

在主业务流程端到端稳定运行后推进（以下各项当前均属规划或后续专项演进，未在当前基线实装）：
1. **`Boot Plan Bench`（开篇大纲方案评判修正循环）**：固定跨题材种子集，利用解耦的 `skills/narrate-boot` 与 `roles/` 配置自动跑完「开书建库 + 试写前 3 章正文」，结合契约违背率、节奏早泄检测与盲测阅读评分迭代寻优开篇构思方案。
2. **`Plot-Haystack` 40 章盲测基准**：运行 40 章同源种子与 10 枚探针核验套件，验证 Ch.36-40 负向红线零穿帮、跨 35 章伏笔 `100%` 成对召回与首尾语言熵率稳定。
3. **既有存稿两步反向建库**：支持导入已写 `ch_0001..K.md` 手稿计算哈希建档、滑窗抽取现状并人工复核 `Innate Locks` 与声纹，再进入构思对话补齐未揭底牌与后续卷纲无缝续写。
4. **Flow B 卷中改纲受控写回与 Boot 多 Agent 并行拆解**：主对话卷中重大改纲专用的受控资产写回工具（`replan_book_assets`）与开书编排多 Agent 并行拆解留待后续专项迭代落地；当前卷中微调通过 `.ops/signals.jsonl` 在安全点消费，开书统一经 `lock_charter_and_boot` 原子编译并自动 `switchBook`。

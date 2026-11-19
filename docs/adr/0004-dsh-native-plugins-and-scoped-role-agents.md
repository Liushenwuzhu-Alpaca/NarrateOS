# ADR-0004: 全面扎根 DSH 插件生态、外部化角色配置与双入口协同

- **状态**: 已采纳 (Accepted)
- **日期**: 2026-11-17

## 背景与决策

早期设计为脱离 `@deepseek-ai/dsh` 独立运行，将检索、规划、核查与睡眠整理全部限制为零工具单轮 JSON 请求，并在 CLI 中重复维护底层流式解析与重试逻辑；这导致二跳检索漏挂、睡眠整理无法自主核实原稿并联动编辑多份文档。

现决定全面扎根 `@deepseek-ai/dsh` 插件生态，将工程收敛为一套顶层模式配置包（`@narrateos/dsh-preset-narrateos`）与四个 `dsh-` 前缀插件包（`dsh-book-store`、`dsh-book-tools`、`dsh-pipeline`、`dsh-client-ui-studio`）：

1. **顶层单一创作模式与外部化角色配置**：仅向宿主注册一个面向作者的「NarrateOS 创作模式」以启用创作工具并关闭编码冗余工具；后台工种的模型池、工具白名单、调用配额与提示词外置为声明式 `roles/*.yml` 与 `prompts/*.md`（支持单书覆盖），不注册会暴露在前端模式选择器中的内部 `dsh-agent-preset`。
2. **`ctx.agents.create` 统一原生会话、受控探查工种、净室写手与纯内存修补**：后台按钮与无头调度无活体父对话 Agent，全工种统一通过 `ctx.agents.create({ meta: { origin: 'subagent' }, setup })` 启动独立会话并拦截剥离宿主 `AGENTS.md`，保留持久化 Session 供 Studio 节点实时与事后检视 `Conversation / Trajectory`；多轮受控探查工种通过带业务门禁的 `yield_*`（`exec.concludeTurn()`）配合 `'agent/turn-stopping'` 未提交续跑 Hook 收口；局部 `Patch` 运行于纯内存段落编辑闭环（仅挂载 `patch_paragraphs` 与 `yield_patched_draft`，零磁盘读写）；`Prose Writer` 保持零工具净室单轮生成，各工种独立复用自身前缀缓存。
3. **双入口与斜杠命令协同**：开书构思与重大改纲复用主对话会话 + `narrate-boot` Skill（联网考据后经 `lock_charter_and_boot` 建库停机）；日常生产保留三栏 Operator Studio 工作台（顶部按钮拉起后台管线，底部输入框无 Agent Loop、仅投递 `.ops/signals.jsonl` 微调信号），同时通过 `ctx.inject(['commands'])` 提供零模型开销的 `/narrate-*` 聊天栏操控命令，通过 `ctx.inject(['webServer'])` 按需挂载 HTTP/SSE 以确保无头测试环境零阻塞启动。

## 后果

- **收益**：消除自研多轮工具循环与跨厂商思考块回传负担，解决检索与睡眠整理的盲猜瓶颈，实现配置修改零编译与工种会话原生可观测。
- **约束**：运行环境统一建立在 `@deepseek-ai/dsh`（`dsh-web-app` 或基于 `dsh-base` 的精简 Cordis Host）之上；领域数据安全依赖 `dsh-book-tools` 对读写目录、只读配额与内存暂存区（`StagingSession`）的显式封装，而非直接暴露宿主原生文件系统工具。

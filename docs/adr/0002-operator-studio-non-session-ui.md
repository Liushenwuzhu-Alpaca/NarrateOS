# ADR-0002: Operator Studio 非会话 UI 范式

- **状态**: 已采纳 (Accepted)
- **日期**: 2026-11-16

## 背景与问题

早期计划曾考虑将 NarrateOS 嵌入 `dsh` 默认的聊天会话（`dsh-persona` + `/narrate` 斜杠命令 + 工具返回 `< 300` 字符回执）。但在 `dsh 0.2.2-rc.1` 实机验证与交互推演后发现：人类在 NarrateOS 中是**运维/导演（Operator）**，而非与助手一问一答的聊天用户；强制走 `conversation` 会话框会引入累进上下文干扰与反直觉的指令输入心智。

## 决策

1. **放弃聊天会话模式**：不在 `conversation` 对话框中通过斜杠命令驱动引擎，也不在对话流中输出百字工具回执。
2. **采用非会话 `'main'` 槽位**：在 `dsh@0.2.2-rc.1` 中通过 `@deepseek-ai/dsh-client-ui-layout` 注册独立的 `'main'` keyed 槽位（`narrate-studio`），配合 `ctx.webServer` 暴露 REST + SSE 状态通道驱动引擎。
3. **有限复用宿主资源**：复用 `dsh` 的模型凭证配置、HTTP 服务与认证壳以及 `dsh-client-ui-theme` CSS 变量，页面版式与交互逻辑由 NarrateOS 独立掌控。

## 取舍与后果

- **收益**：彻底隔离累进对话历史，以 6 节点运行阶段图、YOLO 连续运行控制、正文/细纲/Diff 三视图及可折叠运维检查器贴合长篇创作运维心智。
- **代价**：`packages/dsh-plugin` 需自行维护一份 REST/SSE 控制器与独立 `'main'` 面板组件，无法直接复用默认聊天消息流渲染。

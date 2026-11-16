# ADR-0001: 内核物理隔离与复用 dsh-llm 调度层

- **状态**: 已采纳 (Accepted)
- **日期**: 2026-11-16

## 背景与问题

NarrateOS 需要既能作为 `@deepseek-ai/dsh` 插件运行，也能在无界面 CLI 与长程评测脚本（如 `Plot-Haystack`）中独立运行，同时保持测试套件（`pnpm test`）全离线、零 API 费用运行。如果在 `packages/core` 中直接依赖 `@deepseek-ai/*` 或自研一套 HTTP/Retry/SSE 模型客户端，会导致上游 `dsh` 版本升级时核心业务被迫跟着重构，或出现两套重复的模型调度与重试逻辑。

## 决策

1. **`packages/core` 保持纯粹**：运行时仅依赖 `yaml` 与 `zod`（以及 Node.js 24+ 标准库），零 `@deepseek-ai/*`、零第三方 LLM SDK、零 UI 依赖。所有模型调用统一经由 `LlmPort` 窄接缝，文件系统/Git/Ripgrep 操作经由 `SystemPort` 窄接缝。
2. **模型调度复用 `@deepseek-ai/dsh-llm`**：`packages/dsh-plugin` 与 `packages/cli` 的真实模型调用直接复用 `@deepseek-ai/dsh-llm`（搭配 `dsh-llm-deepseek` / `dsh-llm-pi-ai` / `dsh-llm-retry`），**取消原计划中自研的 `DirectHttpLlmAdapter`**。
3. **离线测试契约**：所有自动化单测与状态机集成测试在 `packages/core` 内通过 `ScriptedLlmAdapter` 离线运行，不消耗真实 API 配额。

## 取舍与后果

- **收益**：消除重复造轮子，直接复用 `dsh` 生态的提供商适配、限流重试与配置体系；同时上游 `dsh` 破坏性变更被严格隔离在 `packages/dsh-plugin` 与 `packages/cli` 适配层内。
- **代价**：`packages/cli` 在真机联调时需以轻量方式装配 `@deepseek-ai/dsh-llm` 依赖；若未来脱离 `dsh` 生态，需要为 `LlmPort` 另写一个独立适配器（接缝已预留）。

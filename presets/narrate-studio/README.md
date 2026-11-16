# @narrateos/preset-narrate-studio

NarrateOS 基础模式预设包，遵循 `@deepseek-ai/dsh@0.2.2-rc.1` Bundle Patch 规范，用于声明无会话 Operator Studio 的后端模式接入。

## 定位与组成

- `package.json`：声明 `@narrateos/preset-narrate-studio` 包元信息，并通过 `dsh.bundle.patch` 指向 `./cordis.patch.yml`。
- `cordis.patch.yml`：通过 `- insert:` 挂载 `@deepseek-ai/dsh-agent-preset`（`config.id: narrate-studio`），并在其作用域内组合：
  - `@deepseek-ai/dsh-persona`（`complete: true`、`includeRuntimeContext: false`）：遮蔽宿主默认对话人设与可选运行时上下文，避免编码向运行时快照注入写作链路。
  - `@narrateos/dsh-plugin`：挂载 NarrateOS 后端 `DshLlmAdapter`、`ctx.webServer` REST/SSE 控制与遥测路由及优雅停机钩子。

## 前端 `'main'` 槽位状态说明

- 本预设当前仅覆盖**无会话 Operator Studio 后端接入声明**。
- 前端 `'main'` keyed 槽位（`narrate-studio`）Operator Studio 控制台 UI 组件**暂未实现**，留待前端设计稿定稿后通过 `@deepseek-ai/dsh-client-ui-layout` 接续接入。

## Workspace 接入提示

- 仓库根 `pnpm-workspace.yaml` 当前仅包含 `packages/*`，尚未包含 `presets/*`。若需由 pnpm workspace 统一解析本预设包，请在后续集成时按需将 `presets/*` 加入 `pnpm-workspace.yaml`。

# @narrateos/preset-narrate-studio

NarrateOS 基础模式预设包，遵循 `@deepseek-ai/dsh@0.2.2-rc.1` Bundle Patch 规范，用于声明无会话 Operator Studio 的后端模式接入。

## 定位与组成

- `package.json`：声明 `@narrateos/preset-narrate-studio` 包元信息，并通过 `dsh.bundle.patch` 指向 `./cordis.patch.yml`。
- `cordis.patch.yml`：通过 `- insert:` 挂载 `@deepseek-ai/dsh-agent-preset`（`config.id: narrate-studio`），并在其作用域内组合：
  - `@deepseek-ai/dsh-persona`（`complete: true`、`includeRuntimeContext: false`）：遮蔽宿主默认对话人设与可选运行时上下文，避免编码向运行时快照注入写作链路。
  - `@narrateos/dsh-plugin`：挂载 NarrateOS 后端 `DshLlmAdapter`、`ctx.webServer` REST/SSE 控制与遥测路由及优雅停机钩子。

## 后端配置

预设显式传入 `bookRoot: ./books/default`、`booksRoot: ./books` 和三个模型池路由，相对路径以宿主工作目录为准。初始目录尚无作品时，可在控制面选择已有作品或开书。

默认路由使用宿主注册的 `deepseek-official` provider，创作与审计使用 `deepseek-v4`，检索使用 `deepseek-v4-flash`。部署时将 `cordis.patch.yml` 中的 provider/model 改为宿主实际可用的标识；认证信息只由宿主配置提供，预设不保存密钥。插件在注册路由前检查作品路径和三池配置，缺项会给出明确配置错误。

作品 `world/book_config.yaml` 的 `model_routing` 以池名映射模型名称，每次实际调用重新读取当前作品，切书无需重启适配器。优先级为作品配置、`NARRATEOS_MODEL_STRONG/FAST/AUDIT`、宿主 `poolRouting` 默认模型；provider 仍由宿主对应池配置决定，状态接口使用相同优先级。CLI 同样优先使用作品模型映射。



## 前端 `'main'` 槽位状态说明

- 本预设当前仅覆盖**无会话 Operator Studio 后端接入声明**。
- 前端 `'main'` keyed 槽位（`narrate-studio`）Operator Studio 控制台 UI 组件**暂未实现**，留待前端设计稿定稿后通过 `@deepseek-ai/dsh-client-ui-layout` 接续接入。

## Workspace 接入提示

- 仓库根 `pnpm-workspace.yaml` 当前仅包含 `packages/*`，尚未包含 `presets/*`。若需由 pnpm workspace 统一解析本预设包，请在后续集成时按需将 `presets/*` 加入 `pnpm-workspace.yaml`。

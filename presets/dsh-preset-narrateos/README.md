# @narrateos/dsh-preset-narrateos

NarrateOS 长篇小说多智能体写作引擎的 `@deepseek-ai/dsh` 顶层模式配置包（零业务代码）。

## 目录结构

```text
presets/dsh-preset-narrateos/
├── package.json                  # DSH Bundle 清单与导出声明
├── cordis.patch.yml              # 宿主共享服务/UI 与单一「NarrateOS 创作模式」补丁
├── locale/
│   ├── en.json
│   └── zh.json
├── roles/                        # 后台 8 大工种的外部化 YAML 配置与中文提示词
│   ├── boot-compiler.yml
│   ├── librarian.yml
│   ├── planner.yml
│   ├── writer.yml
│   ├── patch.yml
│   ├── fact-checker.yml
│   ├── extractor.yml
│   ├── dreamer.yml
│   └── prompts/*.md
├── skills/
│   └── narrate-boot/             # 开书对齐构思与卷中重大改纲 Skill
│       ├── SKILL.md              # 主体严格 < 8,192 字符（防止 tool-result-pruner 截断）
│       └── references/           # 按需加载的细化检查表与改纲协议
└── tests/
    └── preset.test.mjs           # 配置完整性、分层隔离与字符预算校验测试
```

## 设计约定

1. **单一顶层模式与宿主/预设分层**：`cordis.patch.yml` 在宿主平面（顶层 `- insert:`）注册 `@narrateos/dsh-book-store`、`@narrateos/dsh-book-tools`、`@narrateos/dsh-pipeline` 共享服务插件、`@narrateos/dsh-client-ui-studio` 浏览器工作台，以及唯一面向作者的 `@deepseek-ai/dsh-agent-preset`（`id: narrateos`，名称「NarrateOS 创作模式」），不将后台工种注册为模式下拉选项。
2. **工具隔离与净室**：`preset-narrateos.config.plugins` 仅保留会话级插件（零根作用域服务泄露），并在预设作用域内显式挂载严格只读的 `@deepseek-ai/dsh-tool-fs`（`read: true, readImage: false, write: false, edit: false, applyPatch: false`）与 `@deepseek-ai/dsh-tool-fs-search`（`sampleOverCapGlobResults: false`），同时在顶层补丁显式禁用 `dsh-base` 宿主层的 `tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`tool-todo`、`tool-goal`、`plan-mode` 全部 8 项编码/终端向宿主行，使 `dsh-base` 与 `dsh-web-app` 双场景都统一获得严格只读的 `read` / `glob` / `grep` 能力且不泄露全局写工具；写手（`writer`）保持 `cleanroom: true`、`tools: []` 单轮净室，且提示词仅陈述正向目标状态。
3. **单书覆盖**：各作品可在 `books/<slug>/world/roles/` 放置同名 YAML 或 `prompts/*.md` 覆盖本预设包的默认参数与提示词，无需重新编译。
4. **历史出场回填**：`Dreamer` 回查定稿后，通过 `yield_dream_commit.appearances` 逐章提交规范 `entity_id`、`chapter_number` 和出场原句 `quote`；仅提及或未找到可靠证据时传 `null`。是否实际在场由 Dreamer 结合上下文判断，工具只验证引文与 Git 定稿、WAL 指纹及档案身份一致；通过后，工具在同一次 `dream` 事务内补登 `index/L2_cards/vol_XX_cards.md` 的对应章卡，保持其余章卡内容不变。
   出场漏登本身不触发整理；在已触发的一轮中，已建档道具（包括冷宫归档）可回查水位以前的章卡，回填不会唤醒实体。同轮暂存的卷卡优先参与核验，回填结果并入同一次落盘。

## 沙盒与分发

先在仓库根目录运行 `pnpm install --frozen-lockfile` 和 `pnpm build`，再用 `pnpm dev:sandbox --init-only` 校验入口。去掉 `--init-only` 启动宿主。`NARRATEOS_SANDBOX_DIR` 可用绝对路径或相对于调用目录的路径；已导出的变量优先于仓库 `.env`。已有 profile 清单和补丁不会重写，请在 GUI 修改，或用新的目录重新初始化。

沙盒不复制宿主凭据或保存启动日志。可使用环境变量，或在沙盒的模型设置中单独保存凭据；DSH 自身的沙盒托管凭据优先于环境变量。自定义模型需先在对应提供方注册，`NARRATEOS_SANDBOX_AGENT_MODEL=provider:model` 只选择路由，不声明模型能力。

仅安装三个后端包时，默认角色、开书技能与内建文风插件随 pipeline 包分发。使用本预设且没有 web-app 注册表时，预设提供注册表；与 web-app 组合时保留宿主选择。各包的 `pnpm pack` 会生成包含入口和声明的本地安装包。

## 运行测试

```bash
pnpm --filter @narrateos/dsh-preset-narrateos test
```

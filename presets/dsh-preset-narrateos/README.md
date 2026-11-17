# @narrateos/dsh-preset-narrateos

NarrateOS 长篇小说多智能体写作引擎的 `@deepseek-ai/dsh` 顶层模式配置包（零业务代码）。

## 目录结构

```text
presets/dsh-preset-narrateos/
├── package.json                  # DSH Bundle 清单与导出声明
├── cordis.patch.yml              # 注册单一「NarrateOS 创作模式」并禁用编码向冗余工具
├── locale/
│   ├── en.json
│   └── zh.json
├── roles/                        # 后台 7 大工种的外部化 YAML 配置与中文提示词
│   ├── boot-compiler.yml
│   ├── librarian.yml
│   ├── planner.yml
│   ├── writer.yml
│   ├── fact-checker.yml
│   ├── extractor.yml
│   ├── dreamer.yml
│   └── prompts/*.md
├── skills/
│   └── narrate-boot/             # 开书对齐构思与卷中重大改纲 Skill
│       ├── SKILL.md              # 主体严格 < 8,192 字符（防止 tool-result-pruner 截断）
│       └── references/           # 按需加载的细化检查表与改纲协议
└── tests/
    └── preset.test.mjs           # 配置完整性、禁区约束与字符预算校验测试
```

## 设计约定

1. **单一顶层模式**：`cordis.patch.yml` 仅向宿主注册一个面向作者的 `@deepseek-ai/dsh-agent-preset`（`id: narrateos`，名称「NarrateOS 创作模式」），不将后台工种注册为模式下拉选项。
2. **工具隔离与净室**：显式禁用 `tool-bash`、`tool-pwsh`、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`、`tool-todo`、`tool-goal`、`tool-jobs`、`tool-schedule`、`plan-mode` 与 `tool-ralph`；写手（`writer`）保持 `cleanroom: true`、`tools: []` 单轮净室，且提示词仅陈述正向目标状态。
3. **单书覆盖**：各作品可在 `books/<slug>/world/roles/` 放置同名 YAML 或 `prompts/*.md` 覆盖本预设包的默认参数与提示词，无需重新编译。

## 运行测试

```bash
pnpm --filter @narrateos/dsh-preset-narrateos test
```

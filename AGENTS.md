# AGENTS.md

本仓库构建基于 `@deepseek-ai/dsh` 插件生态的通用长篇小说多智能体写作引擎（NarrateOS），具体作品资产与引擎源码物理隔离。

## 上下文指针（按需读取）

- **领域词表与常量基线** -> [`ROADMAP.md`](ROADMAP.md)：核对领域术语定义，或区分固化机制常量与作品可配变量时读取。
- **业务流与数据契约** -> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：修改作者契约对齐、开书编译与停机、开篇校准与声纹采集、作品目录结构、视角与禁区隔离、单章管线、`Sync`、三态时间线、多轮 `Dreaming`、换卷或跨章自愈时读取。
- **文风纪律与门禁词典** -> [`docs/WRITING-CRAFT.md`](docs/WRITING-CRAFT.md)：调整叙述人称主观度、规划/执笔提示词、声纹标本边界、静态门禁规则或 `craft_plugins` 时读取。
- **DSH 插件架构与开发计划** -> [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md)：开发 `dsh-*` 插件包、编写外部 `roles/*.yml` 角色配置、接入 `ctx.agents.create` / `yield_*` 门禁 / 斜杠命令 / Studio 节点日志钻取，或核查各阶段完工判据时读取。
- **产品边界与架构决策** -> [`docs/PRODUCT.md`](docs/PRODUCT.md)、[`docs/adr/`](docs/adr/)：核对双入口协作定位、Operator Studio 交互职责或历史架构取舍原因时读取。
- **外部论文与 DSH 源码备忘** -> [`docs/RESEARCH.md`](docs/RESEARCH.md)：查阅长篇评测实证数据、跨厂商缓存/`logprobs` 契约，或核对 `@deepseek-ai/dsh` 底座机制时读取。
- **早期视觉沙盘** -> [`docs/narrateos-prototype.html`](docs/narrateos-prototype.html)：仅在回看早期静态布局原型时读取；现行契约以 `ARCHITECTURE.md` 为准，实现状态以源码与自动化测试为准。

## 仓库专属硬约束（含子代理）

- **引擎与作品物理隔离**：根仓库仅承载通用插件源码、模式配置与测试夹具，不续写任何具体小说；每部作品独立存放于各自的 `books/<slug>/` Git 子仓库；[`manuscript/vol-01/ch-01.md`](manuscript/vol-01/ch-01.md) 保持只读原样。
- **扎根 DSH 插件生态与配置解耦**：业务规范（`ARCHITECTURE.md` / `WRITING-CRAFT.md`）保持纯领域表达；工程实现扎根 `@deepseek-ai/dsh` Cordis 插件与顶层创作模式（`dsh-preset-narrateos`），Host 后端包与浏览器 `dsh-client-ui-*` 前端包物理分离；各工种的模型池、工具白名单、调用配额与系统提示词外置为声明式配置文件（`roles/*.yml` 与 `prompts/*.md`），不在代码中硬编码。
- **常量机制与配置变量分离**：存储与规则层仅固化槽位结构、因果偏序、排他锁与确定性门禁；写手窗口预算（`writer_token_budget`）、自动回滚章数（`max_auto_rollback_chapters`）、叙述人称主观度、声纹标签集合、焦点角色人数与外置认知插件（`craft_plugins`）均留作可配变量或模型自决项，零先验文学分类枚举。
- **净室写手与内存修补隔离**：执笔写手（`Writer`，含 `WRITER` / `REWRITE`）保持零工具单轮净室调用（`REWRITE` 仅接收经正向转写且脱敏的 `rewriteFeedback`）；局部修补（`Patch`）运行于净室内存段落编辑闭环（仅配纯内存 `patch_paragraphs` 与 `yield_patched_draft`，`maxReadCalls: 0`、零磁盘读写）。二者均物理剥离 `OMNISCIENT_SECRET`、`WARPED`、作者契约（`world/author_charter.md`）、导演禁区（`world/arc_director_plan.md`）与宿主 `AGENTS.md`；提示词与上下文装配件统一陈述排他的正向具象目标状态。

# AGENTS.md

本仓库构建通用长篇小说多智能体写作引擎（NarrateOS），业务规范与工程底座双层解耦，具体小说资产与引擎源码物理隔离。

## 上下文指针（按需读取）

- **领域词表与裁决基线** -> [`ROADMAP.md`](ROADMAP.md)：核对核心领域术语定义，或区分内核固化常量与作品可配变量时读取。
- **业务工作流与数据契约** -> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：理解或修改 `books/<slug>/` 纯文本数据库布局、四阶段开书引导（三维正交坐标与三把手术刀编译）、动静前缀与里表双账本隔离、单章审校、手改 `Sync`、三态时间线、睡眠 `VACUUM`、换卷交接（`advanceVolume`）或跨章三级自动自愈规则时读取。
- **微观文风与门禁词典** -> [`docs/WRITING-CRAFT.md`](docs/WRITING-CRAFT.md)：编写规划/执笔提示词、配置 `Static Prose Gate` 可开关规则表（含跨章喻体复读），或扩展 `craft_plugins` 外置文风插件时读取。
- **程序架构与分步开发计划** -> [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md)：编写引擎代码、设计 `packages/core` 深模块与 `LlmPort` 接缝、开发 `@deepseek-ai/dsh` 插件与 `agent-preset` 模式包，或核查各施工阶段完工判据时读取。
- **外部实证与底座源码备忘** -> [`docs/RESEARCH.md`](docs/RESEARCH.md)：查阅长篇评测论文数据、跨厂商 API 缓存/`logprobs` 边界，或核对 `@deepseek-ai/dsh` 源码机制时读取。
- **交互式视觉沙盘原型** -> [`docs/narrateos-prototype.html`](docs/narrateos-prototype.html)：对照可视化状态流转或 Web 侧栏作战室面板样式时读取。

## 仓库专属硬约束（含子代理）

- **引擎与作品物理隔离**：根仓库仅承载通用引擎源码、规范与测试夹具，不续写任何具体小说；每部作品独立存放于各自的 `books/<slug>/` Git 子仓库；[`manuscript/vol-01/ch-01.md`](manuscript/vol-01/ch-01.md) 仅作只读静态原始样本，保持原样不改不续。
- **业务规范与宿主内核双层解耦**：业务文档（`ARCHITECTURE.md` / `WRITING-CRAFT.md`）保持编程语言与宿主无关；工程实现中 `packages/core` 保持零 `@deepseek-ai/*` 依赖，所有 `dsh` Cordis、Preset 与 Web UI 胶水严格封闭在 `packages/dsh-plugin` 与 `presets/` 内，模型调用统一经由 `LlmPort` 窄接缝路由。
- **常量机制与配置变量分离**：内核仅固化物理槽位结构、因果偏序与确定性校验机制；写手窗口预算（`writer_token_budget`）、自动回滚章数（`max_auto_rollback_chapters`）、声纹标签集合、单场焦点角色人数与外置认知插件（`craft_plugins`）一律作为可配变量或模型自决项，不在内核硬编码先验文学分类枚举或经验魔数。
- **正向槽位表达**：编写生成提示词与上下文装配件时，只投喂排他的正向具象目标状态与槽位事实（对写手物理剥离 `WARPED` 废止词条），避免注入含高频违禁共现词的纯否定禁令引发词法反噬。

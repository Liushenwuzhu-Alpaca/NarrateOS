# AGENTS.md

本仓库构建基于 `@deepseek-ai/dsh` 插件生态的通用长篇小说多智能体写作引擎（NarrateOS），具体作品资产与引擎源码物理隔离。

## 上下文指针（按需读取）

- **形式化架构、端口契约与行为接线（SSoT）** -> [`design/`](design/)：调整跨容器/组件调用边界（[`design/structure/narrateos.c4`](design/structure/narrateos.c4)）、系统核心需求不变量（[`design/requirements.md`](design/requirements.md)）、存储双阶段提交与受控工具暂存端口契约（[`design/contract/*.vdmsl`](design/contract/)）或崩溃恢复交错（[`design/behavior/settlement.qnt`](design/behavior/settlement.qnt)）时读取，并用 `ssot check design` 验证。
- **核心领域词表** -> [`ROADMAP.md`](ROADMAP.md)：核对 16 个核心领域术语（如 `Author Charter`、`Inside-Outside Dual Ledger`、`Entity Page`、`Timeline Mode`）的权威定义时读取。
- **业务流、数据 Schema 与常量/变量总表** -> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：修改开书建库与开篇校准、`books/<slug>/` 纯文本数据库文件树与实体四段式格式、视角与禁区剥离、单章管线、`Sync`、三态时间线、多轮 `Dreaming`、换卷、跨章自愈，或区分固化机制常量与作品可配变量（§7）时读取。
- **文风纪律与门禁词典** -> [`docs/WRITING-CRAFT.md`](docs/WRITING-CRAFT.md)：调整叙述人称主观度、规划/执笔提示词、混合滚动声纹池、静态门禁规则表或外置 `craft_plugins` 时读取。
- **DSH 插件契约、角色配置与 Phase 5 规划** -> [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md)、[`docs/adr/0004-dsh-native-plugins-and-scoped-role-agents.md`](docs/adr/0004-dsh-native-plugins-and-scoped-role-agents.md)：开发 `dsh-*` 插件包、编写 `roles/*.yml` 声明式角色配置、接入 `ctx.agents.create` / `yield_*` 门禁 / `/narrate-*` 斜杠命令 / Studio 会话日志钻取，或推进 Phase 5 演进项时读取。
- **产品边界与 Operator Studio 视觉系统** -> [`docs/impeccable/PRODUCT.md`](docs/impeccable/PRODUCT.md)、[`docs/impeccable/DESIGN.md`](docs/impeccable/DESIGN.md)、[`docs/impeccable/studio-frontend-brief.md`](docs/impeccable/studio-frontend-brief.md)：修改双入口交互分工或 Studio 视觉界面时读取。
- **外部论文与 DSH 底座备忘** -> [`docs/RESEARCH.md`](docs/RESEARCH.md)：查阅长篇评测实证数据、跨厂商缓存/`logprobs` 边界，或核对 `@deepseek-ai/dsh` 底层机制时读取。
- **代码审查准则与工程门禁** -> [`CODING_STANDARDS.md`](CODING_STANDARDS.md)：执行代码审查（Standards 轴）或核查 WAL 排他锁、三态时间线读写覆盖、净室整条剥离与 Cordis 生命周期对称释放不变量时读取。

## 仓库专属硬约束（含子代理）

- **引擎与作品物理隔离**：根仓库仅承载通用插件源码、模式配置与测试夹具，不续写任何具体小说；每部作品独立存放于各自的 `books/<slug>/` Git 子仓库；[`manuscript/vol-01/ch-01.md`](manuscript/vol-01/ch-01.md) 保持只读原样。
- **DSH 插件与声明式角色解耦**：Host 后端包（`dsh-book-store`、`dsh-book-tools`、`dsh-pipeline`）与浏览器前端包（`dsh-client-ui-studio`）物理分离；各工种的模型池、工具白名单、只读配额与提示词外置为 `roles/*.yml` 与 `prompts/*.md`（支持单书覆盖），不在 TypeScript 代码中硬编码。
- **净室正向隔离**：写手（`WRITER` / `REWRITE`）保持零工具单轮净室调用，局部修补（`Patch`）运行于零磁盘读写的纯内存段落编辑闭环；二者均物理剥离 `OMNISCIENT_SECRET`、`WARPED`、非当前 POV `SELF_ONLY`、`world/author_charter.md`、`world/arc_director_plan.md` 与宿主 `AGENTS.md`，提示词与反馈统一陈述排他的正向具象目标状态。
- **`ovnfs` 隔离工作树并行开发**：多子代理并行编码、分支重构或主目录有常驻服务运行时，通过 `P=$(ovnfs new /run/media/alpaca/Data/Works/Novel --rev HEAD --name <task-name>)` 创建写时复制隔离检出，在 `$P` 内完成修改、提交与 `pnpm run check`；合入前校验 `ovnfs diff <task-name>` 与 `ovnfs apply <task-name> --dry-run` 无冲突，再合入主目录；仅允许 `ovnfs rm` 清理本人创建的 checkout。
- **门禁自检与依赖定位**：代码变更交付前运行 `pnpm run check`（串联构建、类型检查、静态仓库门禁、预设测试与全量单测），设计模型变更运行 `ssot check design`；查阅 `@deepseek-ai/*` 依赖统一走子包软链 `packages/<pkg>/node_modules/@deepseek-ai/<dep>/`；跨会话留存的设计与审计文档统一写入 `./tmp/`。

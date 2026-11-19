# NarrateOS

**面向超长篇小说的多智能体确定性协作写作引擎（基于 `@deepseek-ai/dsh` 插件生态）**

[简体中文](./README.md) | [English](./README.en.md)

---

## 简介

**NarrateOS** 是构建在 `@deepseek-ai/dsh`（Cordis 插件架构）之上的通用长篇小说多智能体写作系统。它专门针对百万字级长篇连载中的四大核心痛点进行工程化治理：

1. **跨卷因果与状态漂移**：角色先天红线（`Innate Locks`）、后天状态（`Acquired State`）与不可逆轨迹（`Irreversible Trajectory`）分槽存储，配合三态时间线（`MAINLINE` / `FLASHBACK` / `PARALLEL`）与 WAL 事务状态机（`IDLE -> DRAFTING -> AUDITING -> MANUSCRIPT_SETTLED -> STATE_COMMITTED`），从根源杜绝吃书与时间线错乱。
2. **视角越界与全知剧透反噬**：通过物理路径围栏（`PathFence`）与里表双轨细纲，将全知底牌（`OMNISCIENT_SECRET`）、作者契约（`world/author_charter.md`）与导演禁区（`world/arc_director_plan.md`）对写手（`Writer`）和内存修补工种（`Patch`）实施物理剥离。
3. **否定禁令反噬（Pink Elephant Effect）**：净室写手（`Writer`）保持零工具、单轮纯正向镜头指令输入；所有门禁与修补提示词统一陈述排他的正向具象目标状态，严禁注入“不要写 X”类否定禁令。
4. **AI 陈词滥调与声纹退化**：内置确定性静态文风门禁（`StaticProseGate`：高频 AI 词汇黑名单、句式密度、段落长度与跨章明喻查重）、纯内存段落级修补闭环（`InMemoryDraftPatchSession`）以及声纹标本滚动保鲜池（`.ops/voice_samples.yaml`）。

> **引擎与作品物理隔离**：本仓库仅承载通用插件源码、预设模式配置与测试夹具，不包含任何具体小说续写；每部作品均作为独立 Git 子仓库存放于 `books/<slug>/`。

---

## 核心架构

### 1. 双入口人机协作
- **DSH 主对话（作者契约与总导演入口）**：运行唯一的顶层预设模式 `NarrateOS 创作模式`（`id: narrateos`）。作者在此与总导演对齐创作意图、锁定《作者契约》、执行开书编译（`lock_charter_and_boot`），并通过 `/narrate`、`/narrate-yolo`、`/narrate-rollback`、`/narrate-new-volume` 等斜杠命令调度管线。
- **Operator Studio（`/studio` 浏览器工作台）**：由 `@narrateos/dsh-client-ui-studio` 提供的三栏可视化文学编辑部，支持：
  - 实时 6 节点流水线状态与单步/连写（YOLO）控制；
  - 章节正文、里表细纲、改动对比（Diff）及设定集（人物与物品、未解伏笔、剧情预案与废案）检视；
  - 各工种思考轨迹（Stage Session）、工具调用详情与遥测指标（MATTR-500、信息熵、句长变异系数、缓存命中率）下钻；
  - 按作品独立配置 `strong_creative` / `fast_retrieval` 双模型池与 8 大工种精细模型路由。

### 2. 单章 6 节点确定性管线与周期性 Dreaming

```text
[1. Librarian] ---> [2. Planner] ---> [3. Writer (净室)] ---> [4. ProseGate / LocalPatch (内存)]
                                                                          |
[WAL & Git Commit] <--- [6. Extractor (Sync)] <--- [5. FactChecker (双侧引文去标点验真)]
        |
        +---> (跨章水位触发) ---> [Dreamer (多轮记忆蒸馏 / 伏笔修剪 / 声纹滚动)]
```

| 工种 | 角色 ID | 默认模型池 | 净室 | 核心职责与终态门禁工具 |
|---|---|---|---|---|
| **开书编译器** | `boot-compiler` | `strong_creative` | 否 | 编译《作者契约》、T0 锚点、初始实体、世界书与声纹种子（`yield_boot_bundle` / `lock_charter_and_boot`） |
| **档案检索员** | `librarian` | `fast_retrieval` | 否 | 按时间线与可见性召回活跃实体、世界书与 L3 原稿切片，执行首次登场外成对挂载校验（`yield_context_pack`） |
| **细纲规划师** | `planner` | `strong_creative` | 否 | 编写导演内参（`director_rationale`）与净室正向镜头细纲（`outline_text`），执行防剧透与防否定词门禁（`yield_outline`） |
| **执笔写手** | `writer` | `strong_creative` | **是** | 零工具单轮净室调用，仅接收可见实体切片、声纹标本与正向镜头细纲生成初稿 |
| **段落修补匠** | `patch` | `strong_creative` | **是** | 纯内存 0-based 段落区间替换（`patch_paragraphs`），定点清除静态文风违规或局部事实冲突（`yield_patched_draft`） |
| **事实核查员** | `fact-checker` | `strong_creative` | 否 | 零审美评判，专注核查先天红线、POV 越界、算术账本与阶段天花板，强制双侧原句去标点逐字验真（`yield_verdict`） |
| **状态提取员** | `extractor` | `fast_retrieval` | 否 | 提取增量实体槽位补丁、双轨 L2 章卡与下章候选分支，推进两阶段 Git 原子提交（`yield_state_patch`） |
| **记忆蒸馏师** | `dreamer` | `strong_creative` | 否 | 周期性离线整合实体缓冲、归档冷宫角色、修剪超期伏笔并更新声纹池（`book_edit` + `yield_dream_commit`） |

---

## 仓库目录结构

```text
.
├── packages/
│   ├── dsh-book-store/          # @narrateos/dsh-book-store：实体四段式解析、三态时间线过滤、L0-L3 召回、StaticProseGate、WAL 与 Git 事务
│   ├── dsh-book-tools/          # @narrateos/dsh-book-tools：PathFence、ReadQuotaCounter、StagingSession、受控读写/修补工具与 7 个 yield_* 门禁
│   ├── dsh-pipeline/            # @narrateos/dsh-pipeline：单章管线、Dreaming 蒸馏、跨章级联回滚、斜杠命令与 HTTP/SSE 控制器
│   └── dsh-client-ui-studio/    # @narrateos/dsh-client-ui-studio：Operator Studio 浏览器前端与 DSH Web Workbench 挂载模块
├── presets/
│   └── dsh-preset-narrateos/    # @narrateos/dsh-preset-narrateos：DSH 顶层创作模式配置、8 大工种 roles/*.yml、prompts/*.md 与 narrate-boot 技能
├── scripts/
│   ├── dev-sandbox.sh           # 隔离沙盒初始化与热启动脚本（默认创建 /tmp/narrateos-sandbox）
│   └── lint-repo.mjs            # 仓库静态门禁（ASCII 连字符校验、防私有模型硬编码、只读样本保护、前端产物时间戳校验）
├── docs/
│   ├── ARCHITECTURE.md          # 业务流、数据契约、视角隔离、单章管线与 WAL 状态机规范
│   ├── WRITING-CRAFT.md         # 文风纪律、人称主观度、声纹标本与静态门禁词典规范
│   ├── DEVELOPMENT-PLAN.md      # DSH 插件架构、包边界与各阶段完工判据
│   ├── RESEARCH.md              # 长篇评测实证数据与 @deepseek-ai/dsh 底座机制备忘
│   ├── impeccable/              # 产品定位（PRODUCT.md）、视觉系统（DESIGN.md）与 Studio 前端规范
│   └── adr/                     # 架构决策记录（ADR）
├── ROADMAP.md                   # 领域词表与固化常量 / 可配变量基线
└── CODING_STANDARDS.md          # 工程门禁与代码审查（Standards 轴）不变量准则
```

---

## 快速开始

### 环境要求
- **Node.js**：`>= 22`（推荐 Node 24）
- **pnpm**：`10.33.0+`
- **Git**：作品状态账本与跨章回滚依赖本地 Git 仓库

### 1. 安装与全量构建

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### 2. 启动隔离开发沙盒（Operator Studio + DSH Web Workbench）

你可以通过环境变量或仓库根目录下的 `.env`（已被 Git 忽略）配置模型路由，然后一键启动隔离沙盒：

```bash
# 仅初始化并校验沙盒目录（默认位于 /tmp/narrateos-sandbox）
pnpm run dev:sandbox -- --init-only

# 启动沙盒服务（可指定端口，例如 PORT=42893）
PORT=42893 pnpm run dev:sandbox
```

启动后终端会输出带鉴权 Token 的本地访问地址：
- **DSH 主对话工作台**：切换至「**NarrateOS 创作模式**」即可与总导演构思新书或执行 `/narrate` 命令。
- **Operator Studio 文学编辑部**：点击左侧导航栏的 **NarrateOS Studio** 图标（或访问 `/studio` 视图）进入可视化推章、设定集检视与单工种模型配置界面。

### 3. 运行工程门禁与测试

每次提交或发布前，请运行统一门禁命令（串联全包构建、TypeScript 类型检查、静态仓库门禁、预设校验与全量 Vitest 单测）：

```bash
pnpm run check
```

常用分项命令：

```bash
pnpm run build        # 编译全部 4 个源码包并打包 Studio 前端模块
pnpm run typecheck    # 全包构建与 TypeScript 类型检查
pnpm run lint         # 运行 scripts/lint-repo.mjs 静态门禁
pnpm test             # 运行全量单元测试、预设测试与发布门禁测试
```

---

## 作品子仓库目录契约（`books/<slug>/`）

每部通过 `lock_charter_and_boot` 创建的作品均拥有独立的 Git 仓库与如下标准结构：

```text
books/<slug>/
├── world/
│   ├── book_config.yaml           # 作品参数（人称主观度、窗口预算、双模型池与工种路由、门禁附加词等）
│   ├── author_charter.md          # 《作者契约》与 T0 锚点（对 Writer / Patch 物理屏蔽）
│   ├── arc_director_plan.md       # 阶段天花板禁区、开篇序列节拍与未揭秘拐点（对 Writer / Patch 物理屏蔽）
│   ├── current_arc_envelope.md    # 当前卷公开包络与阶段边界
│   ├── static_base_and_voice.md   # 静态世界基底与句法声纹总纲
│   ├── world_state.md             # 随章节演进的全局世界状态快照
│   ├── open_threads.md            # 跨章活跃伏笔台账
│   └── future_horizon.md          # 远期天际线事件（支持 WARPED 状态翻转）
├── entities/
│   ├── char_*.md                  # 角色四段式档案（Innate Locks / Acquired State / Irreversible Trajectory / Buffer）
│   └── item_*.md                  # 关键道具与地点四段式档案
├── lore_library/
│   └── lore_*.md                  # 按需挂载的世界书设定词条
├── index/
│   ├── L0_sagas.md                # L0 纪元总纲
│   ├── L1_volumes.md              # L1 活跃卷纲
│   └── L2_cards/vol_XX_cards.md   # L2 双轨章卡（剧情摘要 + 原文锚点）
├── manuscripts/
│   └── ch_XXXX.md                 # 已结算定稿章节正文（四位零填充章号）
└── .ops/                          # 引擎运行时账本（tx_state.json、voice_samples.yaml、runs.jsonl、session_logs/、telemetry.jsonl 等）
```

---

## 核心设计文档索引

- **领域词表与常量基线**：[ROADMAP.md](./ROADMAP.md)
- **业务流与数据契约**：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **文风纪律与门禁词典**：[docs/WRITING-CRAFT.md](./docs/WRITING-CRAFT.md)
- **DSH 插件架构与开发计划**：[docs/DEVELOPMENT-PLAN.md](./docs/DEVELOPMENT-PLAN.md)
- **产品边界与视觉规范**：[docs/impeccable/PRODUCT.md](./docs/impeccable/PRODUCT.md)、[docs/impeccable/DESIGN.md](./docs/impeccable/DESIGN.md)
- **工程门禁与代码审查准则**：[CODING_STANDARDS.md](./CODING_STANDARDS.md)

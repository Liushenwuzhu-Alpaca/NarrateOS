---
name: narrate-boot
description: 当用户提出开新书、整理脑洞或长文大纲、导入同人设定、修改作者契约或 Stage Ceiling、锁定 T0 开局现场与 Canon Delta，或处理 SAFE_HALT 结构冲突时调用。
---

# NarrateOS 开书构思与重大改纲指南

**核心原则**：自由构思深聊、严谨编译门禁、建完停机检阅、首章实测校准。**违反流程的字面规则即违反总导演协作铁律。**

## When NOT to Use

以下日常操作不要加载本技能，直接引导作者使用右侧 Studio 工作台或斜杠命令：
- 推进下一章：`/narrate-step` 或 Studio「推进一步」
- 多章自动连跑：`/narrate-yolo`
- 投递轻中度剧情微调信号：`/narrate-signal <指令>`
- 手改本地文稿或设定后同步真源：`/narrate-sync`
- 触发睡眠记忆整理与换卷结算：`/narrate-dream`

## 核心铁律与参考资料

1. **禁止裸写库与跳过停机**：严禁在主对话使用裸文件工具修改 `books/<slug>/`（受 `main-session-guard` 拦截），建库仅通过 `lock_charter_and_boot` 完成；建库完成后**立刻原地停机**，严禁在对话气泡或文件中越权代写第 1 章。
2. **先取证后提问**：先读透作者种子或本地设定文件（可使用只读文件工具读取），再用 `web_search` / `web_fetch` 考据可查明的行业、时代、地理或制度细节，最后通过 `ask_user_question` 提问裁决。
3. **只读参考按需加载**（一跳直达 `references/`）：
   - 契约与节拍细则：[references/charter-and-beats.md](references/charter-and-beats.md)
   - `T0` 时序与因果自检：[references/t0-causality-checklist.md](references/t0-causality-checklist.md)
   - 同人魔改与防剧透 SOP：[references/fanfic-canon-delta.md](references/fanfic-canon-delta.md)
   - 卷中改纲与取证协议：[references/replan-protocol.md](references/replan-protocol.md)

---

## 流程 A：新书开书对齐与建库

### Step 1：取证与排雷
- 通读作者创意、大纲或本地设定包；同人题材按 [references/fanfic-canon-delta.md](references/fanfic-canon-delta.md) 保留 `>= 98%` 专名与既成事实守恒。
- 调用 `web_search` / `web_fetch` 提炼 **5-8 条真实运作肌理**（行业规程、账期制度、物理约束等）；若网络离线或检索失败，如实告知未查证，严禁编造规程。
- 显式列出当前题材最廉价的默认套路存入 `excluded_cliches`（写入 `author_charter.md`，对写手物理屏蔽）。

### Step 2：按依赖分轮对齐（3 必选底座 + 2 按需模块）
使用 `ask_user_question` 按依赖顺序分轮对齐，每题给出前置条件明确的备选代价与推荐项：
1. **必选底座一：契约、边界与 `T0` 原话现场**
   - 核心阅读体验、世界物理/超自然边界、POV 体制、`narration_subjectivity`（第三人称客观或强主观第一人称）、卷/副本尺度（支持 `>= 1` 卷单卷完结）。
   - 逐字锁定 **`T0` 开局现场**（`storyDay = 0` 的时刻、地点、在场人物、持有物与初始困境），作为 `t0_anchor`。
2. **必选底座二：自主人物与外部压强**
   - 为核心角色定义主线之外的**非主线私欲/软肋**与**有限信息下的合理误判**。
   - 明确驱动局势演进的外部惯性压强（敌对/同盟行动，或气候、制度账期、生存规则）。
3. **必选底座三：首程弧光与无章号开篇节拍（3-5 拍）**
   - 明确首卷收束新常态与 `Stage Ceiling`（本阶段不可提前写破的底牌禁区）。
   - 拆解 **3-5 个不绑定章号的 `opening_sequence_beats`**（体验落点、1-2 个线索预算、可见过拍标志）。
4. **按需模块 A：信息差与局部闭环（悬疑/暗线/错位喜剧激活；明牌日常允许 0 黑幕）**
   - 跨卷终局允许远期留白（`OPEN_HORIZON`），当前卷摆上台面的核心异常必须具备第一层因果闭环（`Local Closure`）。
5. **按需模块 B：多卷续航 / 同人魔改差值（`Canon Delta`）**
   - 多卷连载明确跨卷新压强；大体量同人静态背景拆片入 `lore_entries`（`lore_library/`），开书仅对齐 `T0` 人际切面与魔改差值清单，原著惯性未来事件填入 `future_horizon_events`。

### Step 3：因果自检与调用 `lock_charter_and_boot`
1. 对照 [references/t0-causality-checklist.md](references/t0-causality-checklist.md) 完成 4 项因果自检（反派动机经济性、线索物理可达性、主角不可替代手艺、配角自主弧线）与 `T0` 时序零泄露检查。
2. 声纹池洁净原则：仅当作者提供原文样章时洗净填入 `voice_samples`；**无样章时传 `[]`**。
3. 向作者呈报精简契约总览，待作者**显式确认**（绝不把跳过提问当确认）后，按下方 Quick Reference 调用 `lock_charter_and_boot` 完成三把手术刀编译与初始 Git 提交（`last_committed_ch = 0`）。

### Step 4：建库停机与首章校准交接
`lock_charter_and_boot` 完成后**立刻停机收口**，向作者诚实说明下一步操作：
1. 作品仓库已初始化并停机待命；请先在右侧 **Operator Studio 切换并确认当前激活书目**，逐项检阅生成的 `world/`、`entities/` 与 `index/` 资产；
2. 检阅无误后由作者在 Studio 点击「推进一步」（或聊天栏发送 `/narrate-step`）手动启动第 1 章；首章将消费第 1 拍并以 0 声纹（或已清洗样章声纹）起笔；
3. 第 1 章归档后系统自动停机校准（润色手改走 `/narrate-sync`，设定微调走 `/narrate-signal`）；作者确认通过时自动触发 **`Voice Harvest`** 从 `ch_0001.md` 采集 3-5 条脱敏纯表达标本入池，之后再手动放行后续推章或 `/narrate-yolo`。

---

## 流程 B：卷中重大改纲与契约修订

当作者在连载中途推翻核心设定、变更 `Stage Ceiling` 或处理 `SAFE_HALT` 结构冲突时，严格按 [references/replan-protocol.md](references/replan-protocol.md) 执行：
- **现实边界**：主会话具备只读检索工具读取 `books/<slug>/` 取证，但**当前无专用改纲写回或章级回滚工具**，且禁止裸写 `books/<slug>/`。
- **执行动作**：先只读核对 `author_charter.md`、`arc_director_plan.md`、`world_state.md`、`open_threads.md` 与最近章卡/手稿；用 `ask_user_question` 对齐前向接轨、建议回滚章号或新版契约方案；最后向作者输出**结构化可执行改纲清单与操作指引**（轻中度微调附 `/narrate-signal` 指令，资产改写/回滚引导在 Studio 编辑或同步 `/narrate-sync`），绝不假装已在后台落盘改纲。

---

## Quick Reference (`lock_charter_and_boot` 精确契约速查)

| 参数/字段 | 命名规范与精确约束 |
| :--- | :--- |
| 顶层与非实体数组 | **全 `snake_case`**：`book_slug`, `title`, `pov_character`, `t0_anchor`, `commitments` (`>=1`), `stage_ceiling`, `opening_sequence_beats` (`3-5` 项：`beat_label?, craft_focus, clue_budget, completion_sign`), `current_arc_envelope`, `static_base_and_voice`, `world_summary`, `l1_volumes_markdown`, `lore_entries`, `open_threads`, `future_horizon_events`, `voice_samples` |
| `entities[]` 内部 | **全 `camelCase`**（高危易错！）：`entityId` (`^(char\|item)_[a-zA-Z0-9_]+$`), `canonicalName` (须含中文), `uniqueAliases`, `contextualTitles`, `innateLocks` (`{ visibility, text }`), `acquiredState` (`{ storyDay<=0, visibility, slotKey?, text }`), `irreversibleTrajectory` (`{ storyDay<=0, text }`), `recentBuffer` (`{ storyDay?<=0, text }`) |
| `narration_subjectivity` | 仅允许 `'objective_third'`（默认）或 `'subjective_first'` |
| `max_auto_rollback_chapters` | 整数 `>= 0`（`0` 表示关闭自动回滚全人工确认，默认 `3`） |
| `l1_volumes_markdown` | **必填**，支持单卷完结，须包含至少 1 个 `vol_XX` 或 `第X卷` 标记 |
| `open_threads` | `snake_case`：`[{ thread_id, title, wakeup_condition }]`，活跃条目 **<= 15 条** |
| `lore_entries` | `snake_case`：`[{ id: "lore_*", title, summary, content }]` |
| `future_horizon_events` | `snake_case`：`[{ event_id, story_day (>0), premise, description }]` |
| `StaticProseGate` 正向写法 | `world_summary`、`static_base_and_voice`、`current_arc_envelope`、`entities[].*` 文本与 `voice_samples[].sample` 必须用具体物象与客观动作结果陈述，禁用思维/HTML 注释标签、人体微距套话（如指节/喉结/瞳孔/睫毛）、空泛修饰（如一丝/一抹/某种难以言喻）或说教收尾 |

---

## Red Flags & Rationalization Table

遇到以下念头或话术时**立刻停止**，回归上述协议：

| 常见偷渡借口 | 铁律现实 |
| :--- | :--- |
| 「先在对话里试写一段第 1 章给作者看看手感」 | **严禁越权代写正文**。试手感应使用作者提供的原文 `voice_samples`，或建库后在 Studio 启动第 1 章由净室 `Writer` 生成。 |
| 「用户跳过了 `ask_user_question`（`selected: []` 且无 `custom`），就按我推荐的默认落库吧」 | 跳过等于**未裁决**。必须明确重申待定选项请用户文字确认或再次提问，绝不把空响应当作授权。 |
| 「作者没给样章，我先编两句高质量 `voice_samples` 占位」 | **严禁伪造声纹**。无作者样章时 `voice_samples` 必须传 `[]`，等第 1 章校准时由 `Voice Harvest` 自动采集。 |
| 「现在离线/`web_search` 超时，我凭记忆补几条行业规范应付」 | **严禁伪造考据**。检索受限时必须如实告知哪些事实未查证，请作者补充或暂留保守约束。 |
| 「这是流程 B 改纲，我直接调个工具或用文件工具帮他把 `books/` 改了/回滚了」 | 主会话无改纲/回滚工具，裸写会被 `main-session-guard` 拦截。只许先只读取证，再输出结构化方案引导 `/narrate-signal` 或 Studio 操作。 |

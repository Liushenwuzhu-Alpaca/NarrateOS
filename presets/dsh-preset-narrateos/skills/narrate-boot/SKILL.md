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
   - 多卷连载明确跨卷新压强；大体量同人公开背景拆片入 `lore_entries`（`lore_library/`）。未揭露法则与谜底放入 `unrevealed_pivots` 或 `OMNISCIENT_SECRET` 槽位，原著惯性未来事件填入 `future_horizon_events`。

### Step 3：因果自检与调用 `lock_charter_and_boot`
1. 对照 [references/t0-causality-checklist.md](references/t0-causality-checklist.md) 完成 4 项因果自检（反派动机经济性、线索物理可达性、主角不可替代手艺、配角自主弧线）与 `T0` 时序零泄露检查。
2. 声纹池按 `hybrid_rolling` 策略交接：作者样章提取为 `author_sample`；没有样章时，按工具 Schema 提供脱专名的硬动作或对话 `boot_seed`，或使用空池。系统暖机期以定稿原句 `chapter_harvest` 置换并补足配置容量。
3. 向作者呈报精简契约总览，待作者**显式确认**（绝不把跳过提问当确认）后，按当前工具 Schema 调用 `lock_charter_and_boot` 完成编译与初始提交。

### Step 4：建库停机与首章校准交接
`lock_charter_and_boot` 完成后**立刻停机收口**，向作者诚实说明下一步操作：
1. `lock_charter_and_boot` 建库成功后会自动激活并切换至新书（若返回 `switchConflictReason` 提示存在在途任务锁冲突，再请作者待当前任务完成后于右侧 **Operator Studio** 切换激活）；请逐项检阅生成的 `world/`、`entities/` 与 `index/` 资产；
2. 检阅无误后由作者在 Studio 点击「推进一步」（或聊天栏发送 `/narrate-step`）手动启动第 1 章；首章将消费第 1 拍并以 `author_sample` 或 `boot_seed` 声纹起笔；
3. 若启用了 `opening.pause_after_chapter_1`，首章归档后自动停机检阅；润色手改走 `/narrate-sync`，设定微调走 `/narrate-signal`。暖机期 `Voice Harvest` 从定稿提取纯表达好句，置换临时种子并按配置补池。

---

## 流程 B：卷中重大改纲与契约修订

当作者在连载中途推翻核心设定、变更 `Stage Ceiling` 或处理 `SAFE_HALT` 结构冲突时，严格按 [references/replan-protocol.md](references/replan-protocol.md) 执行：
- **现实边界**：主会话具备只读检索工具读取 `books/<slug>/` 取证，但**当前无专用改纲写回或章级回滚工具**，且禁止裸写 `books/<slug>/`。
- **执行动作**：先只读核对 `author_charter.md`、`arc_director_plan.md`、`world_state.md`、`open_threads.md` 与最近章卡/手稿；用 `ask_user_question` 对齐前向接轨、建议回滚章号或新版契约方案；最后向作者输出**结构化可执行改纲清单与操作指引**（轻中度微调附 `/narrate-signal` 指令，资产改写/回滚引导在 Studio 编辑或同步 `/narrate-sync`），绝不假装已在后台落盘改纲。

---

## 提交速查：语义与编码陷阱

`lock_charter_and_boot` 的工具 Schema 是参数结构与配额的唯一真源；提交时按当前暴露的字段填写，避免从旧示例复制整包结构。

- **命名共置**：顶层沿用 `snake_case`；实体兼容 `snake_case` 与 `camelCase`（如 `entity_id` / `entityId`），单个对象选定一种拼法并保持一致。
- **多行文本**：Markdown 内容使用真实换行，由 JSON 编码器转义；不要把换行再次转义为落盘正文里的字面量 `\\n`。
- **正向资产**：`StaticProseGate` 检查世界摘要、写手可见基线、实体事实与声纹；这些资产陈述具体动作和可感状态。导演禁区与未揭底牌留在全知资产。
- **T0 守恒**：初始现状只能写已经成立的事实；未来事件的成立前提放入 `future_horizon_events`，不以预期当现状。
- **声纹来源**：`author_sample` 来自作者原文，`boot_seed` 是启动参考，`chapter_harvest` 来自定稿；样本只携带节奏与表达方式，不承载人物专名或案情答案。

---

## Red Flags & Rationalization Table

遇到以下念头或话术时**立刻停止**，回归上述协议：

| 常见偷渡借口 | 铁律现实 |
| :--- | :--- |
| 「先在对话里试写一段第 1 章给作者看看手感」 | **严禁越权代写正文**。试手感应使用作者提供的原文 `voice_samples`，或建库后在 Studio 启动第 1 章由净室 `Writer` 生成。 |
| 「用户跳过了 `ask_user_question`（`selected: []` 且无 `custom`），就按我推荐的默认落库吧」 | 跳过等于**未裁决**。必须明确重申待定选项请用户文字确认或再次提问，绝不把空响应当作授权。 |
| 「作者没给样章，我先编景物空镜或带人名剧透的句子充当声纹」 | 无合格样本时保留空池；需要启动参考时按工具要求生成脱专名的硬动作或对话 `boot_seed`，由后续定稿采血替换。 |
| 「现在离线/`web_search` 超时，我凭记忆补几条行业规范应付」 | **严禁伪造考据**。检索受限时必须如实告知哪些事实未查证，请作者补充或暂留保守约束。 |
| 「这是流程 B 改纲，我直接调个工具或用文件工具帮他把 `books/` 改了/回滚了」 | 主会话无改纲/回滚工具，裸写会被 `main-session-guard` 拦截。只许先只读取证，再输出结构化方案引导 `/narrate-signal` 或 Studio 操作。 |

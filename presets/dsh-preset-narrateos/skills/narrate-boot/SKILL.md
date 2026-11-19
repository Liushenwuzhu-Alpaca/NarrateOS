---
name: narrate-boot
description: 当用户提出开新书、整理脑洞或长文大纲、导入同人设定、诊断第 1 章试拍不对味（节奏/气口/人设偏差）、修改作者契约或 Stage Ceiling，或处理 SAFE_HALT 结构冲突时调用。
---

# NarrateOS 试播集制片人与改纲指南

**核心原则**：先给具象试播集抓手、三锚因果由作者拍板、严格按工具 Schema 原子编译停机、基于只读实证会诊首章与改纲。

## 入口路由与禁用边界（When NOT to Use）

- **日常推进与操控（不加载本技能）**：推进下一章（`/narrate-step`，或 Studio 开局扉页「写第 1 章（开篇校准）」/ 顶栏「写下一章」）、多章连跑（`/narrate-yolo`）、投递轻中度剧情微调（`/narrate-signal <指令>`）、手改正文后同步（`/narrate-sync`）、触发记忆整理（`/narrate-dream`）、历史手改冲突自愈（`/narrate-heal`）。直接引导作者使用对应命令或右侧 Studio 按钮。
- **流程 A（新书构思与建库）**：按下方「三幕工作流」执行。
- **流程 B（卷中改纲 / SAFE_HALT）** 与 **流程 C（首章试拍会诊）**：立即按需读取 [references/replan-protocol.md](references/replan-protocol.md)，全程仅用只读工具取证。

## 核心铁律

1. **禁止裸写库与跳过停机**：严禁在主对话使用裸文件或 Shell 写工具修改 `books/<slug>/`（受 `main-session-guard` 拦截）；建库唯一入口为 `lock_charter_and_boot`。建库完成后**立刻原地停机**，严禁在对话或文件中试写、代写第 1 章正文。
2. **显式授权**：`ask_user_question` 被跳过（`selected: []` 且无 `custom`）等于**未裁决**；必须重申待定项请作者文字确认，绝不把空响应当作默认授权。
3. **诚实考据**：网络离线或 `web_search` 失败时如实告知未查证项，严禁编造行业规程或原著事实。
4. **按需单跳加载参考**：
   - 契约裁决、无章号物理节拍与多语域声纹配方：[references/charter-and-beats.md](references/charter-and-beats.md)
   - `T0` 时序守恒、常识因果四问与多人共知边界：[references/t0-causality-checklist.md](references/t0-causality-checklist.md)
   - 同人守恒与 `Canon Delta` 拆片：[references/fanfic-canon-delta.md](references/fanfic-canon-delta.md)
   - 首章试拍会诊（流程 C）与卷中改纲（流程 B）：[references/replan-protocol.md](references/replan-protocol.md)

---

## 流程 A：新书「试播集制片人」三幕工作流

### 第一幕：接球诊断与轻量定调（按输入体量 A-1 / A-2 分流）
> **完成判据**：已读完输入并完成必要的事实定调，向作者输出具象「试播集提案卡」或「因果断层诊断」，并收到作者对核心分叉的明确拍板。

- **前置轻量定调（仅当存在外部事实依赖时执行）**：若题材涉及真实历史、专业行业规程或同人原作，先执行 `1-2` 次 `web_search` 或读取本地设定包（同人题材加载 [references/fanfic-canon-delta.md](references/fanfic-canon-delta.md)）；纯架空或常识明晰题材直接 `0` 检索进入分流。
- **分支 A-1（一句话脑洞 / 短创意种子）**：直接输出固定四槽位的**「试播集提案卡」**：
  1. `T0 开局第一镜`（具体时刻、地点、在场人物、手头持有物、当场困境）；
  2. `主角看家手艺与破局抓手`（不可替代的职业手艺、性格软肋或关系网）；
  3. `首卷核心矛盾与阶段禁区草案`（本卷主舞台冲突 vs 暂不揭开的底牌）；
  4. `排除的廉价套路清单`（拟存入 `excluded_cliches` 的排雷项）。
  随后使用 `ask_user_question` 仅提出 `1-2` 个决定主干路线的分叉选择题（附备选代价与推荐项）。
- **分支 A-2（已有长纲 / 设定集 / 同人设定包）**：静默读完全部材料，不重复询问作者已写明的设定；加载 [references/t0-causality-checklist.md](references/t0-causality-checklist.md)，用「常识因果四问」揪出 `1-2` 处未闭合的动机/线索断层或未来剧透风险，用 `ask_user_question` 请作者拍板。

### 第二幕：三锚拍板（收敛编译底座）
> **完成判据**：以下 3 个故事硬锚点全部获作者明确拍板，无悬空待定项。进入本幕时加载 [references/charter-and-beats.md](references/charter-and-beats.md)；第一幕中作者已拍板确认的 `T0` 设定与禁区直接继承，仅追问尚未锁定的锚点，不重复复问。

使用 `ask_user_question` 按依赖收敛以下三项核心锚点：
1. **锚点 1：`T0` 开局现场与声纹标尺**
   - 锁定 `t0_anchor`（仅含 `story_day <= 0` 已成立事实）、POV 体制、叙述人称主观度 `narration_subjectivity` 与卷尺度（支持 `>= 1` 卷单卷完结）。
   - **声纹定标**：若作者提供原文样章，提纯为脱专名且过静态门禁的 `author_sample`；若无样章，给出 3 种**脱专名、非本章剧情、15-45 字的纯腔调标尺句**（如冷峻硬动作 / 高密度吐槽 / 市井口语交锋）请作者选定主导语感（供第三幕扩展为 `3-4` 条多语域 `boot_seed`，或按作者意愿留空池 `samples: []` 待首章后采集）。
2. **锚点 2：无章号开篇节拍（3-5 拍）与 `Stage Ceiling`**
   - 明确首卷收束新常态与 `stage_ceiling`（阶段天花板禁区）。
   - 拆解 `3-5` 个按因果推进、不绑死章号的 `opening_sequence_beats`：每拍包含 `craft_focus`、限量 `clue_budget`，以及**以可定位的物理位移、证物交接或公开表态结果定义的 `completion_sign`**。
3. **锚点 3：桌面下的暗牌与世界默认惯性**（对照 [references/t0-causality-checklist.md](references/t0-causality-checklist.md) 第 2-3 节）
   - 定义核心角色非主线私欲与有限信息下的合理误判；当前卷核心异常须具备第一层因果闭环（`Local Closure`）。
   - 暗牌归位：单人或多人共知秘密记入唯一真源实体卡的 `SELF_ONLY`（多人共知用逗号分隔 `owner: "char_a,char_b"`，所有知情人 ID 须在初始 `entities` 中建卡）；读者已知戏剧张力标 `READER_KNOWN`；未揭底牌标 `OMNISCIENT_SECRET` 并绑定 `slot_key`。
   - 外部惯性：将 `T0` 后若无干预将发生的预定大事件记入 `future_horizon_events`（`story_day > 0`），每条必须绑定**可被角色行动推翻的客观成立前提 `premise`**（连载期由 `Planner` 每章核对并在 `impacted_horizon_events` 点名唤醒 `Dreamer` 核销或转 `WARPED`）。

### 第三幕：靶向肌理考据、门禁编译与停机交接
> **完成判据**：作者对「开局沙盘确认单」显式确认，`lock_charter_and_boot` 调用成功返回，主对话立即停机交接。

1. **靶向动作肌理考据**：围绕已拍板的开局舞台与前 3 拍主角手艺，调用 `web_search` / `web_fetch` 查证 `3-5` 条可直接用于动作戏与器物交互的真实运作细节。**考据所得行业规程、器械流程与背景制度优先拆片写入 `lore_entries`（300-800 字/条）**；`static_base_and_voice` 仅保留核心物理/超自然常驻界限、空间连通拓扑与抽象句法纪律（严控 `<= 1,500` 字且零否定词）。
2. **门禁自检**：对照 [references/t0-causality-checklist.md](references/t0-causality-checklist.md) 核验 `T0` 零未来泄露与外键完整性；确保所有写手可见资产（`world_summary`、`static_base_and_voice`、`current_arc_envelope`、实体条目、声纹）使用正向具象描述并通过 `StaticProseGate`；无作者样章时按第二幕选定腔调构造 `3-4` 条覆盖不同 `tag`、15-45 字、脱专名、脱案情的合规 `boot_seed`（或留空池）。
3. **沙盘确认与原子建库**：向作者呈报精简「开局沙盘确认单」（含书名、`book_slug`、`pov_character`、`T0` 锚点、核心承诺与排雷、`Stage Ceiling`、3-5 拍过拍标志、初始角色/道具与声纹策略）。收到作者**显式确认**后，严格按当前工具 Schema 调用 `lock_charter_and_boot`。
4. **建库停机与首章校准交接**：`lock_charter_and_boot` 返回后**立刻停机**，向作者说明：
   - 新书已自动激活（若返回 `switchConflictReason` 提示存在在途任务锁冲突，请作者待当前任务结束后在 **Operator Studio** 顶部书名切换菜单中切换），请先在 Studio 检阅生成的 `world/`、`entities/` 与 `index/` 资产；
   - 检阅无误后，在 Studio 中栏开局扉页点击**「写第 1 章（开篇校准）」**（或顶栏**「写下一章」**，或聊天栏发送 `/narrate-step`）启动第 1 章（首章默认仅消费第 1 拍）；
   - 首章写完后若对腔调、节奏或人设有任何不满，可随时回到主对话触发**「流程 C：首章试拍会诊」**。

---

## Red Flags & Rationalization Table

遇到以下念头或话术时**立刻停止**，回归上述协议：

| 常见偷渡借口 | 铁律现实 |
| :--- | :--- |
| 「先在对话里试写一段第 1 章（或带主角名字和开场案情的试音段）给作者看看手感」 | **严禁越权代写正文**。试音仅允许给出脱专名、非剧情的 15-45 字腔调标尺句；建库时传入 `3-4` 条不同 `tag` 的合规 `boot_seed`，由 Studio 净室 `Writer` 写第 1 章。 |
| 「用户跳过了 `ask_user_question`（`selected: []` 且无 `custom`），按推荐项默认建库吧」 | 跳过等于**未裁决**。必须明确重申待定选项请用户文字确认或再次提问，绝不把空响应当授权。 |
| 「只把作者三选一挑中的那 1 句传入 `voice_samples` 就够了」 | 单条样本一旦被门禁过滤会导致 `cleanVoiceSamples = 0` 整包建库报错，且破坏多语域轮换。无样章时必须构造 `3-4` 条不同 `tag` 的脱专名合规 `boot_seed`（或留空池）。 |
| 「给节拍加上预期天数或建议章数，更能控制开篇速度」 | 工具 Schema 拒绝额外字段，且在 `completion_sign` 绑天数/章号会阻碍 `Fact Checker` 二值核销。控节奏唯一抓手是将 `completion_sign` 写为不可逆物理位移或交接动作。 |
| 「第 1 章写歪了，教作者手改 `voice_samples.yaml` 或 `arc_director_plan.md` 后跑 `/narrate-sync` 重跑第 1 章」 | `/narrate-sync` **仅同步 `manuscripts/ch_*.md`**，系统无首章回滚重跑命令，手改 `world/` 或 `.ops/` 不提交会污染 Git 工作树。必须按 [references/replan-protocol.md](references/replan-protocol.md) 走真实受控通道。 |

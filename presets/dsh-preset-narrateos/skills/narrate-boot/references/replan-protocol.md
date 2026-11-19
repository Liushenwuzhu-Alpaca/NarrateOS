# 首章试拍会诊与卷中重大改纲协议 (Pilot Calibration & Replan Protocol)

当作者在跑完第 1 章后反馈“味道不对 / 节奏太慢 / 人设偏差”（**流程 C：首章试拍会诊**），或在连载中途需要调整剧情方向、修改《作者契约》与 `Stage Ceiling`、处理 `SAFE_HALT` 挂起冲突（**流程 B：卷中重大改纲**）时，按本协议在主对话中推进。

## 1. 现实系统边界与事实真源铁律（严禁虚假承诺）

- **主会话只读围栏**：主会话拥有只读检索工具（`read` / `glob` / `grep`）读取 `books/<slug>/` 取证，但**没有改纲写回、设定落盘或章节回滚工具**；`main-session-guard` 会拦截主对话对 `books/<slug>/` 的一切裸写操作（仅放行开新书 `lock_charter_and_boot`）。读取长文件（如手稿、章卡）时优先分段读取并记录精确路径与行号，不凭可能已被剪枝的对话记忆引用原句。
- **已归档手稿 (`manuscripts/ch_0001..K.md`) 是最高事实真源 (`WAL`)**，且 **`Innate Locks` 不可静默覆写**：除非作者自行编辑手稿，改纲不能凭空否定已写入定稿的硬事实；若确需改动角色先天红线，必须先向作者点名确认影响面。
- **`/narrate-sync` 的真实作用范围**：`/narrate-sync`（及 Studio 顶栏「同步修改」按钮，或「改动对比」页签「立即同步修改」）**仅扫描并提交 `manuscripts/ch_*.md` 的正文修改**（同步重算 `entities/`、`index/L2_cards/`、`world/world_state.md` 与 `.ops/tx_state.json`）。它**不会**同步或提交作者对 `world/*.md` 或 `.ops/voice_samples.yaml` 的手动修改；若作者在本地手改了 `world/` 下的契约或计划文件，必须手动执行 `git commit` 提交，否则脏工作树会阻塞后续 `/narrate-heal` 的 `git read-tree` 自愈预演。
- **无单章回滚重跑命令**：系统当前没有 `/narrate-rollback` 或「重跑第 1 章」按钮；`/narrate-heal` 仅在修改**历史旧章（`dirtyCh < last_committed_ch`）**产生连续性冲突报告（`.ops/sync_conflicts.json`）时工作。严禁教作者手动删除 `manuscripts/ch_0001.md`（删除已登记手稿会导致 `Sync` 报错拒绝）。

---

## 2. 流程 C：首章试拍会诊 SOP（第 1 章定稿后调优）

### Step 1：只读三方比对取证
锁定当前激活作品 `books/<slug>/`，读取以下文件定位病根：
1. `manuscripts/ch_0001.md`（首章实际定稿正文）与 `.ops/chapter_outlines/ch_0001.json`（首章导演细纲与节拍提名）；
2. `world/author_charter.md`、`world/arc_director_plan.md`、`world/static_base_and_voice.md`；
3. `.ops/voice_samples.yaml`（当前生效的声纹样本池）与 `.ops/tx_state.json`。

### Step 2：按病根匹配 4 条真实受控处方
向作者指出具体原句与成因，并严格从以下 **4 条系统真实可闭环的通道**中给出操作方案：

1. **处方一：首章字句气口不佳 / 局部剧情想直接改写 -> Studio「直接改稿」保存**
   - 主对话帮作者挑出 `ch_0001.md` 中的问题段落并给出修订稿参考；
   - 引导作者在右侧 Studio 中央工作台顶栏点击**「直接改稿」**，将修改后的第 1 章正文粘贴并点击**「保存并自动同步」**（Studio 调用 `PUT /api/narrate/chapter` 自动落盘正文并触发 `Sync` 重新提取人物状态与章卡，保持 WAL 指纹绝对一致）。
2. **处方二：校准或置换声纹样本池 -> 区分自动滚动采血与空池手动提取**
   - **若开书时传入了 `boot_seed`（默认 `hybrid_rolling` 模式）**：如实告知作者，第 1 章定稿入库时管线已在后台自动采集正文好句置换了至多 2 条 `boot_seed`，剩余临时种子会在第 2-3 章定稿时自动替换（此时若手动点击界面上的提取声纹按钮，系统会因声纹池非空自动跳过）；若对首章句式不满，先按「处方一」直接改顺第 1 章正文，再配合「处方三」推进第 2-3 章完成滚动换血。
   - **若开书时传入了空声纹池（`samples: []`）且池内尚无标本**：可在首章定稿（或改稿保存）满意后，点击 Studio 中栏顶栏右上角**「⋯」（更多创作整理操作）->「重新提取本章对话声纹」**手动采血入库。
3. **处方三：首章可接受，但第 2 章起需加快过拍节奏、纠正人设腔调或微调走向 -> 发送 `/narrate-signal`**
   - 主对话直接为作者拟好一条**正向具象**的微调指令文本（如 `/narrate-signal 第2章直接切入次日放学后新音乐楼问询现场，单章内完成备用钥匙交接以推进节拍二；对白保持短促冷幽默`），请作者在聊天栏发送或于 Studio 底部微调指令栏投递。
4. **处方四：开局 `T0` 现场、核心人设或《作者契约》想从根上推翻重来 -> 新 `book_slug` 重开建库**
   - 诚实告知作者当前无首章回滚命令；在主对话快速对齐修订版三锚参数后，使用新的 `book_slug` 重新调用 `lock_charter_and_boot` 生成全新干净工作区并自动切换激活。

---

## 3. 流程 B：卷中重大改纲与 `SAFE_HALT` 处置 SOP

### Step 1：只读取证盘点（定位受波及范围）
确认当前激活的 `books/<slug>/`，用只读工具核查 `.ops/tx_state.json`（当前 `last_committed_ch`、`story_day`）、`world/author_charter.md`、`world/arc_director_plan.md`、`world/open_threads.md`、`world/future_horizon.md` 及最近章卡与手稿：
1. 若为**未落盘新章生成中途触发 `SAFE_HALT` 挂起**，读取 `.ops/safe_halt.json`（及 `.ops/runs.jsonl` 关联记录），核查触发熔断的具体门禁或 `Fact Checker` 冲突证据；
2. 若为**已归档历史章手改触发冲突**，核查 `.ops/sync_conflicts.json` 或 `.ops/heal_plan.json` 中的冲突双侧章号、行号与波及章数；
3. 盘点哪些已写入定稿手稿（`manuscripts/ch_0001..K.md`）的硬事实不可凭空否定。

### Step 2：依赖对齐与方案裁决
使用 `ask_user_question` 与作者裁决走哪条受控路径：
- **路径 0（未落盘新章 `SAFE_HALT` 拦截恢复）**：新章尚未写入 `manuscripts/`。主对话诊断出草稿越界或细纲偏差原因后，为作者拟好正向纠偏便签，引导作者在 Studio 中栏顶部拦截卡点击**「带上微调便签重写本章」**（或点击**「先写便签调整走向」**，或发送 `/narrate-signal <指令>` 后再点**「写下一章」** / `/narrate-step`）。
- **路径 1（前向平滑改道 / Retcon 圆谎）**：不动已定稿历史章，通过投递 `/narrate-signal` 指令引导后续 `Planner` 在 `impacted_horizon_events` 点名未触发的旧 `future_horizon` 事件、由 `Dreamer` 将其标为 `WARPED` 并转向新剧情线（也可在中栏「⋯」菜单点击**「立即整理设定与伏笔」**或发送 `/narrate-dream`）。
- **路径 2（修改历史某章正文触发跨章自愈）**：若必须推翻第 `M` 章（`M < last_committed_ch`）的已发生剧情，引导作者在 Studio 左栏切换到第 `M` 章，点击中栏**「直接改稿」**修改该历史章正文并点击**「保存并自动同步」**（自动触发 `Sync` 扫描下游冲突并生成 `.ops/sync_conflicts.json`），随后在 Studio 中栏顶部冲突裁决卡点击**「处理本条冲突（可能按作品限额回滚重跑）」**（或发送 `/narrate-heal`）执行三级跨章自愈。
- **路径 3（原地修订《作者契约》/ `Stage Ceiling` 或另立新书）**：若 `/narrate-signal` 无法覆盖而作者确需放宽或修改 `world/author_charter.md`、`world/arc_director_plan.md`、`world/current_arc_envelope.md`，诚实说明系统暂无主对话改纲写回工具且 `/narrate-sync` 不同步 `world/`；主对话输出「目标文件路径 + 原文本定位 + 符合 `StaticProseGate` 且零泄底的新版替换文本」清单，并**显式提醒作者在本地修改保存后须在该书目录手动执行 `git commit` 保持工作树干净**（避免阻塞后续自愈回滚），再恢复推进；若需颠覆全书开局根基，则以新 `book_slug` 重新调用 `lock_charter_and_boot`。

# 卷中重大改纲与契约修订协议 (Replan Protocol)

当作者在连载中途需要调整核心剧情方向、重写未执行卷纲、修正 `SAFE_HALT` 暴露的结构性矛盾，或授权修订《作者契约》时，按本协议在主对话中安全推进。

## 1. 铁律：既成事实真源不可篡改

- **已归档手稿（`manuscripts/ch_0001..K.md`）是最高事实真源（`WAL`）**：除非作者显式指示并自行编辑或授权回滚指定章节，改纲绝不能凭空否定已经写进已定稿手稿里的硬事实（生死、已交付证物、已公开发生的事件）。
- **`Innate Locks` 不可静默覆写**：所有角色的先天红线维持稳定；若确因重大设定调整需要改动，必须先向作者点名确认影响面。

## 2. 四步增量改纲流程

### Step 1：取证盘点（定位受波及范围）
向作者确认或引导确认当前作品状态（结合 `world/author_charter.md`、`world/arc_director_plan.md`、`world/world_state.md`、`world/open_threads.md`、`index/L1_volumes.md` 与最近数章 `L2` 章卡）：
1. 已写到第几章（`last_committed_ch`）、当前 `story_day` 与卷号；
2. 哪些已定稿事件与新想法存在张力，哪些仍然完全成立；
3. 是否由 `SAFE_HALT` 挂起触发（核对冲突双侧章号、行号与波及章数）。

### Step 2：依赖对齐与授权裁决
使用 `ask_user_question` 向作者明确展示改纲取舍：
- **分支一（前向平滑接轨）**：保留全部已归档手稿，只修订后续 `arc_director_plan.md`、未触发的 `future_horizon.md`（将失效节点标为 `WARPED`）、`open_threads.md` 与 `current_arc_envelope.md`，必要时通过 `SPOTLIGHT_TRIGGER` 或下章自然转折圆回；
- **分支二（受控回滚重开）**：若最近少数几章已走偏且无法前向圆回，明示回滚到第几章及影响字数，待作者确认后交后台安全回滚并附带新约束重跑；
- **分支三（契约核心承诺变更）**：若本次改纲改变了 `author_charter.md` 的核心承诺（如 POV 体制、世界物理边界、核心排雷或终局基调），逐条呈请作者确认新版契约快照。

### Step 3：增量修订并保留有效资产
- 修订方案锁定后，仅更新受波及的规划与契约文档（`author_charter.md`、`arc_director_plan.md`、`current_arc_envelope.md`、`future_horizon.md`、`open_threads.md`），完整保留依然成立的人物履历、声纹样本与未冲突卷纲。
- 若更新了开篇/阶段节拍，重新标注未完成节拍与新的 `Stage Ceiling`，确保正向 `current_arc_envelope.md` 仍无底牌泄露与否定禁令词。

### Step 4：停机检阅与恢复推进
修订落盘并完成结构一致性确认后停机，提醒作者在 Studio 检阅更新后的卷纲与节拍，再手动点击继续推章或投递微调信号。

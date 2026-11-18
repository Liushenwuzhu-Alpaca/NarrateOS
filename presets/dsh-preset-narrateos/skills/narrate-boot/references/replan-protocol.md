# 卷中重大改纲与契约修订协议 (Replan Protocol)

当作者在连载中途需要调整核心剧情方向、重写未执行卷纲、修正 `SAFE_HALT` 暴露的结构性矛盾，或授权修订《作者契约》时，按本协议在主对话中推进。

## 1. 现实边界与事实真源铁律

- **主会话工具边界**：主会话具备只读工具（`read_file` / `fs_search` 等）用于读取 `books/<slug>/` 取证，但**没有专用改纲写回或回滚工具**，且 `main-session-guard` 会拦截对 `books/<slug>/` 的任何裸写操作（写保护仅放行 `lock_charter_and_boot`）。严禁假装已调用不存在的后台回滚/改纲工具。
- **已归档手稿 (`manuscripts/ch_0001..K.md`) 是最高事实真源 (`WAL`)**：除非作者自行编辑或回滚指定章节，改纲绝不能凭空否定已写入定稿手稿的硬事实（生死、已交付证物、已公开发生的事件）。
- **`Innate Locks` 不可静默覆写**：角色的先天红线维持稳定；若确因重大设定调整需要改动，必须先向作者点名确认影响面。

## 2. 四步只读取证与增量改纲流程

### Step 1：只读取证盘点（定位受波及范围）
使用只读工具直接核查目标作品目录 `books/<slug>/` 下的真实文件（`world/author_charter.md`、`world/arc_director_plan.md`、`world/world_state.md`、`world/open_threads.md`、`world/future_horizon.md`、`index/L1_volumes.md` 与最近数章 `index/L2_cards/vol_*.md`、`manuscripts/`）：
1. 已提交到第几章（`.ops/tx_state.json` 的 `last_committed_ch`）、当前 `story_day` 与卷号；
2. 哪些已定稿事实与新想法存在张力，哪些仍然完全成立；
3. 若由 `SAFE_HALT` 挂起触发，核对冲突双侧章号、行号与波及章数（参考 `.ops/runs.jsonl` 或 Studio 报错）。

### Step 2：依赖对齐与方案裁决
使用 `ask_user_question` 向作者明确展示改纲取舍：
- **分支一（轻中度微调 / 前向平滑接轨）**：保留全部已归档手稿，仅调整后续方向、修正未触发的 `future_horizon.md`（标为 `WARPED`）或调节近期节奏，可直接通过 `/narrate-signal` 投递微调信号实现；
- **分支二（受控回滚重开）**：若最近少数几章已走偏且无法前向圆回，明示建议回滚到的目标章号及影响字数；
- **分支三（契约/卷纲核心承诺变更）**：若改变 `author_charter.md` 核心承诺（POV 体制、世界物理边界、核心排雷或 `Stage Ceiling`），逐条对齐新版表述与写手安全可见的 `current_arc_envelope` 正向草案。

### Step 3：输出结构化可执行改纲方案（不伪造写回）
对齐确认后，向作者输出清晰的**结构化修订清单与操作指引**（逐文件列出「目标文件路径 + 原文本定位 + 建议替换内容」，并确保新增正向描述符合 `StaticProseGate` 且不向 `current_arc_envelope` 泄露 `OMNISCIENT_SECRET`）：
- 若属于**方向微调**：给出可直接发送的 `/narrate-signal <指令>` 文本；
- 若属于**手稿/设定文本修订**：提示作者在右侧 Studio 对应资产面板编辑保存，或在本地修改后执行 `/narrate-sync` 同步真源；
- 若属于**`SAFE_HALT` 或章级回滚**：明确告知作者需在右侧 Studio 工作台执行回滚或解除挂起确认，再恢复推进。

### Step 4：停机检阅提示
确认作者已拿到完整操作清单并提醒：全部修订在 Studio 落盘同步完毕后，先核验 `world/arc_director_plan.md` 与 `world/current_arc_envelope.md`，再手动点击 Studio「推进一步」或发送 `/narrate-step`。

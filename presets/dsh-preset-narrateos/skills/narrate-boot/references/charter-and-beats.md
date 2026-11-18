# 作者契约与开篇节拍细则 (Charter & Opening Beats)

在 `narrate-boot` Step 2 与 Step 3 中按本细则组织《作者契约》与开篇序列节拍，确保传入 `lock_charter_and_boot` 的参数无缺项、无模糊口号。

## 1. 《作者契约》与 `lock_charter_and_boot` 核心字段对齐

1. **核心承诺（写入 `world/author_charter.md`）**：
   - `commitments`：核心阅读体验、题材边界、世界物理/超自然规则（非空数组）；
   - `narration_subjectivity`：叙述人称主观度枚举，仅允许 `'objective_third'`（默认，第三人称客观限知镜头）或 `'subjective_first'`（强主观第一人称）；
   - `excluded_cliches`：显式排除的廉价套路清单（仅存契约，对写手物理屏蔽）；
   - `t0_anchor`：作者原话逐字锁定的 `T0` 开局现场（时间、地点、在场人物、持有物与初始困境）。
2. **授权与预算边界（写入 `world/book_config.yaml`）**：
   - `authorization_boundary`：运行期授权边界说明；
   - `max_auto_rollback_chapters`：整数 `>= 0`（`0` 表示关闭自动回滚全由人工确认，默认 `3`）；
   - `writer_token_budget`：写手窗口 Token 预算（`null` 或正整数）；
   - `craft_plugins`：启用的外置认知插件名列表（默认 `[]`）。
3. **跨卷与当前卷骨架**：
   - `l1_volumes_markdown`：**必填**，支持 `>= 1` 卷单卷完结，文本中必须至少包含 1 个 `vol_XX`（如 `vol_01`）或 `第X卷`（如 `第1卷`）标记，否则门禁拒绝；
   - `open_threads`：活跃伏笔数组（`snake_case`：`{ thread_id, title, wakeup_condition }`），上限 **<= 15 条**；
   - 按需模块结论（`OPEN_HORIZON` 远期留白与 `Local Closure` 当前卷因果闭环，或 `Canon Delta` 同人魔改差值）应体现在 `commitments`、`world_summary` 与 `stage_ceiling` 中。

## 2. 无章号「开篇序列节拍（3-5 拍）」规范

`opening_sequence_beats`（3-5 个对象，**严禁绑死固定章号**）写入 `world/arc_director_plan.md` 按序消耗。每拍精确字段（`snake_case`）：
- `beat_label`（可选）：节拍标签，如 `节拍一：异常接单与现场受阻`；
- `craft_focus`（必填）：体验与手艺落点，确立主角手艺与当前生活/职业约束；
- `clue_budget`（必填）：限量投放的 1-2 个具体物理线索或关系暗流，防止开局泄底；
- `completion_sign`（必填）：正文中可直接核验的客观过拍事件，供 `Dreamer` 翻阅原稿后标为 `DONE`。

## 3. `Stage Ceiling` 阶段天花板禁区

- `stage_ceiling`（必填）明确列出本阶段（如第 1 卷前段或整个第 1 卷）**不可提前揭露或提前触发**的真相、幕后人物或能力跃迁；
- 仅写入 `world/arc_director_plan.md`（对 `Writer` 物理屏蔽），供 `Planner` 绕行与 `Fact Checker` 把关。

## 4. 写手静态基线 (`<=1,500 字`) 与声纹边界

- `static_base_and_voice` 必须精炼在 **1,500 字以内**，仅承载：世界常驻底层规则、主要空间拓扑、人称主观度基线、可执行句法纪律（长篇设定切分至 `lore_entries`）；
- `world_summary`、`static_base_and_voice`、`current_arc_envelope` 均须通过 `StaticProseGate`：写具体物象、地形、规程与动作结果，不使用思维标签/`<!-- -->`、空泛修饰或人体微距套话、不作说教式结尾；
- `voice_samples`：作者提供原文样章时整理为 `{ tag, sample }`（每条须通过 `StaticProseGate`）；**未提供样章时必须传 `[]`**，待第 1 章定稿校准后再经 `Voice Harvest` 采集 3-5 句脱敏表达标本。

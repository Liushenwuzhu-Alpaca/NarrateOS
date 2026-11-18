# T0 时序守恒与常识因果自检清单

在调用 `lock_charter_and_boot` 前，逐项完成以下核验；任何未闭合项必须在主对话中对齐补齐后再锁定快照。

## 1. 常识因果四问 (Common-Sense Causality Audit)

1. **幕后方动机经济性**：反派或对手方为何采用当前布局，而非更省钱、更低风险、更直接的常规手段？其行动成本、收益与风险是否符合其资源体量？
2. **关键线索物理可达性**：主角及盟友如何通过合理渠道（行业接口、物理遗留、人际利益交换）接触到破局线索？严禁依赖无端巧合或天降知情人。
3. **主角不可替代手艺**：当前危局为何必须由主角依靠其具体职业手艺、性格软肋或关系网来撬动，而非交给警方/官方机构/旁人一眼看破？
4. **核心角色自主弧线**：除主角外，至少 2-3 名核心配角具备独立于主角主线之外的私欲、算计或盲区，在有限信息下会做出合乎自身利益的合理误判。

## 2. `T0` 时序零泄露清单 (`storyDay <= 0`)

- 系统自动将 `world_state.md` 初始化为 `story_day: 0`、`current_volume: 1`、`current_chapter: 0`、`timeline_mode: MAINLINE`。
- `entities[]` 检查（注意 `entities[]` 内部字段全为 **`camelCase`**）：
  - `entityId`：必须匹配 `^(char|item)_[a-zA-Z0-9_]+$`，且全数组不重复；
  - `canonicalName`：**必须包含至少 1 个中文字符**；
  - `innateLocks`（`{ visibility, text }`）：先天/底层永久特征（落盘后自动标注 `since_day: -inf`）；
  - `acquiredState`（`{ storyDay, visibility, slotKey?, text }`）：**仅允许 `storyDay <= 0`** 的开局前既成事实与在场持物；**任何 `storyDay > 0` 会被 `BootGateError` 拦截**；
  - `irreversibleTrajectory`（`{ storyDay, text }`）：仅记录 `T0` 之前（**`storyDay <= 0`**）的过往重大节点；
  - `recentBuffer`（`{ storyDay?, text }`）：若填写 `storyDay`，同样必须 `<= 0`；
  - 所有条目的 `text` 均须通过 `StaticProseGate`（具体事实表述，无微距套话、无空泛修饰、无标签注释）。
- `future_horizon_events[]`（注意此处为 **`snake_case`**）：
  - 所有预定在 `T0` 之后才发生的外部变故或同人原著惯性事件统一存放在此，每项为 `{ event_id, story_day (>0), premise, description }`，必须写明可证伪的前提条件 `premise`。

## 3. 四级信息边界与防泄底清单

| 可见性标记 (`visibility`) | 含义 | 写手 (`Writer`) 是否可见 |
| :--- | :--- | :--- |
| `PUBLIC` | 公开常识、众人皆知的状态 | 可见 |
| `SELF_ONLY` | 仅某角色自己知道的心思、私密持有物或误判 | 仅当该角色为当前 `pov_character` 时可见 |
| `READER_KNOWN` | 读者已知但场上角色不知的戏剧张力点 | 转为 `[仅读者已知的戏剧张力点]` 提示 |
| `OMNISCIENT_SECRET` | 尚未揭晓的幕后真相与底牌 | **无条件物理剥离（绝对不可见）** |

- `current_arc_envelope`：仅包含写手安全可见的**正向舞台常态**，检查零 `OMNISCIENT_SECRET` 泄底、零否定禁令词，且必须通过 `StaticProseGate`。
- 同人设定模式（`Canon Delta`）：核对原著专名、人物关系与核心设定守恒率 `>= 98%`，拆片指南见 [fanfic-canon-delta.md](fanfic-canon-delta.md)。

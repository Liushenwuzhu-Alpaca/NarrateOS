# 同人创作与 Canon Delta 执行指南 (Fanfic Canon Delta SOP)

本指南适用于基于已有原著世界观与角色的同人开书与连载前编译。核心原则：保留 `>=98%` 原著专名、物理/超自然规则与既有关系守恒，仅把与原著分叉的部分定义为 `Canon Delta`。

## 1. 抗参数引力：严防未来剧情剧透 (`T0` 隔离)

大模型在参数记忆中自带原著全剧情，开书时最容易条件反射写出「尚未发生的未来事件」。
- **信息边界**：在 `world_summary`、`entities[].innateLocks`、`entities[].acquiredState`、`entities[].irreversibleTrajectory` 中，只允许出现 **`T0` (`storyDay <= 0`) 之前** 已公开发生或角色自身已知的事实。
- **反剧透自查**：凡属原著后续章节才会揭晓的反派真身、未来背叛、未到手的神器/秘籍、未爆发的大战，严禁写入 `entities` 的公开状态或 `current_arc_envelope`；若确需作远期底牌，仅允许写入 `unrevealed_pivots`（对写手物理屏蔽）或 `future_horizon_events`（见第 3 节）。

## 2. `T0` 人际切面与 `Canon Delta` 魔改清单

大体量同人设定不做全量硬压，开书仅对齐以下两项：
1. **魔改差值 (`Canon Delta`)**：在《作者契约》中逐条列明与原著的差异点（如：主角提前截胡某机缘、某原著关键配角性格/立场偏移、时间线提前 N 天、引入新势力或金手指），并明确「未在差值清单提及的设定默认沿用原著」。
2. **`T0` 人际切面**：只编译开局首卷即将接触的核心角色，每名角色的 `acquiredState` (`storyDay <= 0`) 只写此刻彼此的称谓、阵营归属、物理位置与尚未消解的误解/利害关系，不提前预判好感度走势。

## 3. `future_horizon_events` 的 `premise` 写法与 `WARPED` 触发条件

原著中「若无主角干预本该按惯性发生」的未来大事件，统一录入 `future_horizon_events[]`：
- 字段格式（`snake_case`）：`{ event_id, story_day (>0), premise, description }`。
- **`premise` 必须写为可证伪的前置条件**（如 `"反派尚未发现密信已失窃，且某港口封锁照常执行"`），而非空泛的 `"按原著推进"`。
- **`WARPED` 机制**：连载期间若主角行动或局势变化打破了某事件的 `premise`，后台 `Dreamer` 会将该事件标记为 `WARPED`（历史分叉作废），后续大纲不再强行按原著剧本硬凑该事件，转由既有角色按自身私欲在当前局势下重新决策。

## 4. `lore_library/` 拆片粒度

- 原著庞杂的势力架构、力量体系、地理图志、年表与名词解释，严禁整坨塞进 `world/static_base_and_voice.md`（写手静态基线须保持精炼）。
- 将静态设定按**单一主题**拆分为多条 `lore_entries[]`（`snake_case`：`{ id: "lore_*", title, summary, content }`）：
  - 每条专注一个独立主题（如单个宗门/机构规程、单项法术/器械代价、单一城市区划），正文控制在 **300-800 字**；
  - `summary` 用 1-2 句说清触发检索的关键词与核心约束，供后台 `Librarian` 按章节需要精准召回 `lore_library/<id>.md`。

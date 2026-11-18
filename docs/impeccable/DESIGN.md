---
name: "NarrateOS Operator Studio"
description: "面向长篇小说多智能体创作的去框化清样校勘与总控调度设计系统"
colors:
  cobalt-action: "#4c7cf0"
  cobalt-fill: "#3762cc"
  cobalt-fill-hover: "#436fd9"
  cobalt-ink: "#96b6ff"
  cinnabar-seal: "#df6447"
  jade-done: "#46c978"
  amber-gloss: "#eba434"
  coral-halt: "#e86565"
  ink-outer: "#0c0d0f"
  ink-host: "#121316"
  ink-side: "#16171a"
  ink-stage: "#1a1b1e"
  ink-sheet: "#1f2024"
  ink-elevated: "#26282d"
  paper-side: "#f2efe7"
  paper-stage: "#f8f5ee"
  paper-sheet: "#fcfbf7"
  ink-primary: "#f3f2ee"
  ink-secondary: "#c8c6bf"
  ink-muted: "#98968f"
  ink-prose: "#e6e2d8"
  galley-numeral: "#575853"
  hairline-subtle: "rgba(255, 255, 255, 0.068)"
  hairline-default: "rgba(255, 255, 255, 0.125)"
  scrim-backdrop: "rgba(0, 0, 0, 0.44)"
typography:
  display:
    fontFamily: "Inter, 'PingFang SC', system-ui, sans-serif"
    fontSize: "4.25rem"
    fontWeight: 200
    lineHeight: 0.86
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', Georgia, serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.38
    letterSpacing: "0.02em"
  subheadline:
    fontFamily: "Inter, 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "Inter, 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.005em"
  prose:
    fontFamily: "'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', Georgia, serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.98
    letterSpacing: "0.012em"
  body:
    fontFamily: "Inter, 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, 'PingFang SC', 'Noto Sans CJK SC', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  xs: "5px"
  sm: "7px"
  md: "9px"
  lg: "11px"
  sheet: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  sheet-y: "36px"
  sheet-x: "44px"
components:
  button-primary:
    backgroundColor: "{colors.cobalt-fill}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-fill-hover}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-outline:
    backgroundColor: "{colors.ink-sheet}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  manuscript-sheet:
    backgroundColor: "{colors.ink-sheet}"
    textColor: "{colors.ink-prose}"
    typography: "{typography.prose}"
    rounded: "{rounded.sheet}"
    padding: "36px 44px 44px"
    width: "672px"
  pipeline-card:
    backgroundColor: "{colors.ink-side}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "9px 11px"
  director-note-dock:
    backgroundColor: "{colors.ink-sheet}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "6px 8px 6px 10px"
    width: "672px"
  seal-stamp:
    backgroundColor: "rgba(223, 100, 71, 0.11)"
    textColor: "{colors.cinnabar-seal}"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    size: "48px"
---

# Design System: NarrateOS Operator Studio

## Overview

**Creative North Star: "东方清样校勘室 (The Literary Galley Desk)"**

NarrateOS Operator Studio 同时服务高频后台管线操控（`Operate`）与数小时沉浸式长篇小说审阅（`Read`）。设计系统遵循 **85% 隐形工具骨架 + 15% 文学清样签名触点** 的克制配比：顶栏、章节目录、检查器与两层模型路由严格承袭 `@deepseek-ai/dsh` 宿主的冷静家族秩序，做到零装饰干扰；视觉张力集中投放在中央 `672px` 独立书稿舞台与 `3x2` 工序灯阵之上，让每一次章节落盘都具备文学清样盖印封存的呼吸感与确信感。

界面彻底摒弃传统后台「外框套卡片再套小方框」的机械表格感，改由深墨/暖纸微色阶层叠与极淡 `1px` 分割线组织空间。工程术语（如 `WAL`、`WARPED`、`MATTR-500`）在界面层全部转译为作者直白中文，同时保留干练的英文工种名（`1. Librarian` 至 `6. Dreamer`）与真实模型标识（`provider:model`）。明确排斥的视觉反模式包括：赛博霓虹发光、单侧 `3px` 粗彩条（`side-tab`）、标题上方生硬的小号眉题（eyebrow kicker）、多层嵌套描边卡片，以及无状态因果意义的纯炫技循环动画。

**Key Characteristics:**
- **双模式同台分工**：周边 `Operate` 控制面保持高扫描效率与低存在感，中央 `Read` 书稿纸面拥有衬线排版、宽裕页边距与清样仪式感。
- **去框化色阶分层**：以五级微温差中性表面替代密集矩形线框，全屏仅保留「`写下一章`」唯一高饱和实心主行动点。
- **清样校勘品牌签名**：大号超细章节序号刊头（`02 | 标题`）、悬停浮现页边段号（`P01`）、刊头润色校勘签与章末微倾 `-4deg` 宣纸印泥质感「`定稿`」朱印。
- **因果可追溯实时流**：`3x2` 工序与模型矩阵承载呼吸态进度体感，点击任意工种卡片通过原生共享元素过渡直达右栏实时思考链。

## Colors

色板围绕「深墨夜读（Ink & Night Paper）」与「暖纸日间（Warm Rag Paper）」两套精心调校的温润中性色阶构建，在长时间阅读中消除纯黑冷白刺眼眩光，并以极低剂量的钴蓝与朱砂分别锚定操作主行动点与文学定稿签名。

### Primary
- **Cobalt Dispatch (`cobalt-action` / `cobalt-fill`)**: 唯一操作主强调色，专用于顶栏实心主按钮「`写下一章 | YOLO`」、底部便签发送钮、当前激活工序灯与键盘焦点环（`2px` 实线外轮廓），严禁用于静态背景装饰。
- **Cobalt Ink (`cobalt-ink`)**: 暗色表面上的高可读交互墨色，用于「`直接写 ->`」快捷动作与已单独覆盖模型的工种高亮文本。

### Secondary
- **Cinnabar Galley Seal (`cinnabar-seal`)**: 品牌专属朱砂印泥色，仅用于章末「`定稿`」方印与书页顶部 `2px` 极细滚动阅读进度丝带，绝不与报错告警混用。

### Tertiary
- **Jade Settled (`jade-done`)**: 工序已完成状态灯、文风体检通过徽标与改动对比新增行底纹。
- **Amber Gloss (`amber-gloss`)**: 手改未同步提示（「`同步修改`」按钮）、润色校勘签、隐藏底牌隔离标注与回忆时间线提示。
- **Coral Halt (`coral-halt`)**: 设定冲突暂停（`SAFE_HALT`）状态灯、冲突裁决卡顶栏与正文冲突原句定位高亮。

### Neutral
- **Obsidian Host & Side Rails (`ink-outer` / `ink-host` / `ink-side`)**: 暗色模式下从宿主导航轨到左右辅助栏的冷墨底座，自动退居视觉二线。
- **Galley Stage & Editorial Sheet (`ink-stage` / `ink-sheet` 与亮色 `paper-stage` / `paper-sheet`)**: 中央阅读舞台与独立书稿画布，暗色带微暖炭墨底调，亮色呈未漂白棉浆纸感，确保正文对比度稳定高于 `11:1`（远超 WCAG AA `4.5:1`）。
- **Warm Ivory & Carbon Inks (`ink-primary` / `ink-prose` / `ink-secondary` / `ink-muted`)**: 四级带微暖纸色倾向的文字墨阶，连输入框占位符均保证 `>= 4.5:1` 可读对比度；`galley-numeral` 专用于刊头巨型弱对比章节序号。

### Named Rules
**The Single Solid CTA Rule.** 同一视口内仅允许「`写下一章`」（或冲突裁决卡的首选修复动作）使用实心 `cobalt-fill` 填充；其余次要操作一律退回微底色或描边态，确保视线在 0.5 秒内锁定主推进入口。

**The Seal-Is-Not-Danger Rule.** 朱砂色 `cinnabar-seal` 永远代表「文学清样核验封存」的正向仪式感，任何错误、阻断或破坏性操作必须使用语义红 `coral-halt` 并搭配明确文字标签。

**The Dual-Cue Status Rule.** 6 步工序灯与章节状态绝不仅仅依赖红绿颜色区分：必须同步提供光晕形态（常亮实心圆、呼吸脉冲环、警示描边）与直白中文状态词（「已完成 / 生成中 / 有冲突 / 待命」）。

## Typography

**Display Font:** Inter (200 ExtraLight, tabular-nums, fallback system-ui)
**Body Font:** Inter, "PingFang SC", "Noto Sans CJK SC"（控制面 UI）；"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC"（书稿正文与章节标题）
**Label/Mono Font:** "JetBrains Mono", "SF Mono", ui-monospace（模型标识 `provider:model`、Token 计量、段号 `P01` 与 Git SHA）

**Character:** 无衬线控制面保持如精密排字尺般的干练紧凑（固定 `px/rem` 阶梯，不用流体 `clamp`），而一旦视线落入书页画布，思源宋体/宋体的温润笔锋与 `1.98` 舒展行高立即接管，形成「外冷内温」的阅读沉浸切换。

### Hierarchy
- **Display** (`200`, `4.25rem` / `68px`, `line-height: 0.86`, `letter-spacing: -0.04em`): 专用于书稿刊头左侧的巨型双位章节序号（如 `02`），以低对比墨色充当视觉锚点而非喧宾夺主。
- **Headline** (`600`, `1.625rem` / `26px`, `line-height: 1.38`, 衬线): 章节主标题与全书设定集书名页标题。
- **Title** (`600`, `0.875rem` / `14px`, `line-height: 1.4`): 顶栏当前书名切换器、面板分组标题与冲突裁决卡主标题。
- **Prose** (`400`, `1.0625rem` / `17px`, `line-height: 1.98`, 首行缩进 `2em`, 行宽上限 `672px` 约 `36-38` 汉字): 章节正文唯一阅读字阶，兼顾长篇连读舒适度与校勘扫视效率。
- **Body** (`400`, `0.8125rem` / `13px`, `line-height: 1.5`): 左右侧栏列表、导演便签输入与设定档案正文。
- **Label** (`500`, `0.75rem` / `12px`, `line-height: 1.4`): 按钮、分段页签、胶囊徽标与表单字段说明。
- **Mono** (`400`, `0.71875rem` / `11.5px`, `tabular-nums`): 英文模型路由名、Git 提交哈希、页边段号与遥测数值，绝不把等宽字体当作普通中文标签的装饰皮肤。

### Named Rules
**The Serif Boundary Rule.** 衬线体仅出现在书稿纸面内部（章节标题、正文段落与朱砂「定稿」印文）；顶栏、侧栏、按钮与抽屉一律使用无衬线体，严守工具区与作品区的心理边界。

**The Tabular Telemetry Rule.** 所有章节号、字数、故事日、Token 预算与百分比必须启用 `font-variant-numeric: tabular-nums`，保证连写跳数时界面零横向抖动。

## Layout

整体采用嵌套在 `@deepseek-ai/dsh` 宿主 `'main'` 槽位内的**容器感知三栏工作台**。由于宿主自身左侧栏可在收起（`56px`）与展开（`264px`）之间动态伸缩，Studio 所有响应式断点一律基于 `.ns-studio-shell` 自身的 `ResizeObserver` 实测容器宽度计算，绝不依赖 `window.innerWidth`：

- **宽屏三栏常驻态（容器宽 `>= 1200px`）**：`224px` 左栏（卷信息 + 正文目录 + 底部「全书设定集」独立入口） | `minmax(0, 1fr)` 中央书稿舞台 | `340px` 右栏（`思考过程 | 运行状态 | 模型分配`，支持一键收起为 `0px`）。
- **中等宽度自适应态（`820px <= 容器宽 < 1200px`）**：自动收起常驻左栏，将其无损收纳进顶栏左侧的「`第 X 章 · 目录与设定集 ▾`」浮层菜单，优先保全中央书稿阅读宽度与右侧面板同时可见。
- **紧凑抽屉态（容器宽 `< 820px`）**：右侧栏转为带半透明遮罩的浮层抽屉，确保中央书稿绝不被挤压变形。

中央舞台内部严格执行**单轴光学对齐**：顶部分段工具栏、`3x2` 展开式工序矩阵、设定冲突裁决卡、独立书稿纸面（最大宽 `672px`，内边距 `36px 44px 44px`）以及底部的「下一章走向建议」与「导演便签舱」共享同一居中轴线与 `672px` 版心宽度，彻底消除控件贴墙散落的撕裂感。间距采用 `4px` 基础模数：组内紧凑关联用 `4px-8px`，同级模块间隔用 `12px-16px`，书稿纸面内外留白跃升至 `24px-44px` 形成鲜明疏密节奏。

## Elevation & Depth

系统采用 **微色阶表面分层为主、定向环境柔影为辅（Tonal Layering + Purposeful Float）** 的混合深度模型。静止侧栏与检查器完全平铺（零阴影），依靠从外到内逐级提亮的表面明度（暗色 `#121316 -> #16171a -> #1a1b1e -> #1f2024`；亮色 `#ece8df -> #f2efe7 -> #f8f5ee -> #fcfbf7`）建立自然景深。

### Shadow Vocabulary
- **Manuscript Rest (`0 6px 24px rgba(0, 0, 0, 0.12)`)**: 赋予中央独立书页轻微离开桌面底板的纸张厚度感。
- **Director Dock (`0 10px 30px rgba(0, 0, 0, 0.34)` / 亮色 `0 8px 26px rgba(36, 30, 20, 0.08)`)**: 托起底部一体式导演便签舱，表达其作为常驻操作坞的前景层级。
- **Floating Popover (`0 16px 40px rgba(0, 0, 0, 0.44), 0 2px 8px rgba(0, 0, 0, 0.24)`)**: 专用于作品切换、停止二级菜单、便签类型下拉与窄屏目录浮层，且浮层必须逃逸局部滚动裁剪容器。

### Named Rules
**The De-Boxed Inspector Rule.** 侧栏与运行状态面板内部禁止卡片套卡片或四面描边盒子；分组之间仅通过 `14px` 垂直留白与单条 `1px` `hairline-subtle` 极淡横线分隔。

## Shapes

圆角尺度随构件体量递进：内嵌行内输入框与小徽标为 `5px-7px`（`xs`/`sm`），工序卡片与模型池组为 `9px`（`md`），底部导演便签舱为 `11px`（`lg`），中央独立书稿画布为温润的 `12px`（`sheet`），状态胶囊统一为全圆角 `999px`（`pill`）。

状态告警卡（如冲突裁决卡）采用整周 `1px` 低透语义描边配合顶栏同色系柔光底条，严禁在卡片左侧或右侧加粗 `3px-4px` 彩色竖条。章末「`定稿`」朱印采用 `48px x 48px`、`7px` 微圆角方印，以 `-4deg` 手工钤印倾角叠合内联 SVG `feTurbulence` 宣纸印泥微斑驳滤镜，形成不可复制的东方出版物器物感。

## Components

### Buttons
- **Shape:** 统一 `30px` 紧凑高度与 `7px` 圆角（`rounded.sm`），主推进与停止动作采用左侧主动作 + 右侧 `▾` 下拉的组合分体按钮（Split Action）。
- **Primary:** `cobalt-fill` 实心底配纯白字，全屏仅主行动点使用；运行态自动切换为琥珀色 `写完本章暂停 | ▾`（下拉收纳破坏性的 `立即中断并撤回半截草稿`）。
- **Hover / Focus:** `140ms` 背景平滑提亮；`:focus-visible` 呈现 `2px` `cobalt-action` 外轮廓（`2px` 偏移）。
- **Secondary / Ghost / Subtle:** 默认透明或 `rgba(255,255,255,0.048)` 微底色，悬停显现边界，绝不与主按钮争抢视觉权重。

### Chips
- **Style:** `20px` 高全圆角轻徽标（`rounded.pill`），采用 `12%-14%` 低透明度语义柔底配高可读同色系墨色文字，无外描边。
- **State:** 待消费导演便签胶囊附可点击 `×` 撤回热区；多尝试会话胶囊支持选中态切换。

### Cards / Containers
- **Corner Style:** 书稿纸面 `12px`，`3x2` 工序面板外框 `11px`、内部单步工种卡 `9px`。
- **Background:** 书稿纸面恒用最亮一级表面（`ink-sheet` / `paper-sheet`）；工序单步卡用退后半阶的 `ink-side` 以衬托选中态。
- **Shadow Strategy:** 仅书稿纸面保留轻纸感底影，侧栏分组容器零阴影。
- **Border:** `1px` `hairline-subtle` 极淡描边；连写运行中的当前激活工序卡通过 CSS `@property` 驱动柔和钴蓝呼吸光边以传达实时推进体感。
- **Internal Padding:** 书稿纸面 `36px 44px 44px`；工序单步卡紧凑 `9px 11px`。

### Inputs / Fields
- **Style:** 底部导演便签舱采用无框一体式设计——去除原生灰底 `<select>`，左侧便签类型切换（`剧情微调 ▾`）为圆润轻标签，选择「`插入回忆`」或「`切换视角`」时同行平滑展开天数或人物选择胶囊，右侧紧接无边框透明输入区。
- **Focus:** 整舱 `:focus-within` 平滑点亮 `cobalt-action` 半透明描边并改变光标色（`caret-color`），无需局部输入框再套双层焦点框。
- **Error / Disabled:** 忙碌运行态下模型路由保存与冲突动作按钮置灰禁用并给出明确原因提示。

### Navigation
- **左栏双层结构**：上半区为可滚动的章节状态目录（展示章号、标题与字数/`已改`/`冲突`徽标），底部固定收口为跨章「**全书设定集**」三入口（`人物与物品档案` · `未解伏笔清单` · `剧情预案与废案`），点击后通过原生 `View Transitions` 在主画布切换为独立设定集纸面，右上角配醒目的 `<- 返回第 X 章正文`。
- **右栏三页签**：精简为 `思考过程 | 运行状态 | 模型分配`，与展开态 `3x2` 工序矩阵建立点击直达联动（共享状态指示灯变形飞入右栏顶栏）。

### Editorial Galley Sheet & Cinnabar Seal
- **章节刊头与页边标号**：纸面顶部以双栏网格并列 `68px` 超细章节序号与衬线主标题（副信息置于标题下方），正文每段左侧页边预留 `P01` 等宽标号，鼠标悬停段落时以 `150ms` 柔和浮现供精准校勘定位；若本章经过 `Patch` 自动润色，在刊头下方展示可点击校勘签直达润色会话。
- **阅读进度丝带与定稿钤印**：书稿纸面顶边内嵌 `2px` 朱砂阅读进度丝带，由纯 CSS `animation-timeline: scroll()` 零脚本驱动；新章或润色段落初现时经 `Web Animations API` 渐进遮罩如墨迹落纸般显影（支持快速切章随时中断与 `prefers-reduced-motion` 无感瞬显）；已定稿无手改章节末尾居中落 `-4deg` 宣纸纤维质感「`定稿`」朱印及真实 Git Commit SHA 落款。

## Do's and Don'ts

### Do:
- **Do** 保持「单章手稿页签（`本章正文 | 本章细纲 | 改动对比`）」与左栏底部跨章「全书设定集」彻底物理分离，绝不混排在同一组 Tab 中。
- **Do** 让中央工具栏、`3x2` 工序矩阵、冲突裁决卡、书稿纸面与底部导演便签舱严格遵守 `672px` 版心光学同宽对齐。
- **Do** 基于 `.ns-studio-shell` 自身 `ResizeObserver` 实测容器宽度触发 `1200px`（收左栏）与 `820px`（右栏转抽屉）断点，无缝兼容 DSH 宿主侧栏伸缩与明暗主题切换。
- **Do** 根据真实后端物理状态分流冲突裁决卡操作（已落盘跨章冲突提供自动修补与直接改稿；未落盘新章拦截提供带便签重写与走向调整，绝不渲染会报 `404` 的假改稿按钮）。
- **Do** 为所有 `View Transitions`、`scroll()` 进度条与 `WAAPI` 墨迹显影提供 `@supports` 渐进增强兜底及 `@media (prefers-reduced-motion: reduce)` 降级路径。

### Don't:
- **Don't** 在卡片、提示条或列表项单侧使用超过 `1px` 的彩色粗边条（严禁 `border-left: 3px solid ...` 等 `side-tab` AI 模板痕迹）。
- **Don't** 在章节主标题或卡片主标题正上方堆叠小号大写眉题（eyebrow / kicker label）；元数据一律置于主标题下方或同行右侧。
- **Don't** 在界面文案中裸露 `WAL`、`WARPED`、`Kontoyiannis H_K`、`MATTR-500`、`force: false` 等底层工程黑话，也不要捏造后端未持久化的句级润色偏移高亮。
- **Don't** 用打断式弹窗阻断切书或外部 `book_switched` 事件；未保存手改草稿一律按 `bookRoot + chapterNumber` 自动暂存并在切回时温和恢复。
- **Don't** 用 Emoji 或字符符号充当界面图标；所有操作图标统一采用 `1.5px` 描边的内联矢量 SVG。

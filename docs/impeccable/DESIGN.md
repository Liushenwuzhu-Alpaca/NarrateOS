---
name: "NarrateOS 宋椠朱批 · 碑拓夜读"
description: "面向长篇小说多智能体创作的东方古籍品牌视觉系统：日间宋刻本，夜间碑拓，工种印谱与朱批校勘"
colors:
  # 日间 · 宋刻本
  desk-paper: "#e4dac6"
  side-paper: "#ece3d1"
  sheet-paper: "#f7f1e3"
  sheet-paper-2: "#efe6d2"
  ink-song: "#1e1914"
  ink-song-2: "#574d42"
  ink-song-3: "#8a7e6d"
  rule-paper: "rgba(30, 25, 20, 0.12)"
  rule-paper-strong: "rgba(30, 25, 20, 0.26)"
  frame-paper: "#2a231c"
  # 夜间 · 碑拓
  desk-stele: "#0c0b0a"
  side-stele: "#11100f"
  sheet-stele: "#171513"
  sheet-stele-2: "#1d1b18"
  ink-rubbing: "#e8e2d3"
  ink-rubbing-2: "#b6ae9f"
  ink-rubbing-3: "#948d80"
  rule-stele: "rgba(232, 226, 211, 0.085)"
  rule-stele-strong: "rgba(232, 226, 211, 0.2)"
  frame-stele: "#cdc5b3"
  # 印泥与语义
  cinnabar: "#b5372a"
  cinnabar-night: "#cf513b"
  cinnabar-soft: "rgba(181, 55, 42, 0.09)"
  malachite-done: "#3e6e61"
  malachite-done-night: "#79b3a1"
  gamboge-warn: "#a8730f"
  gamboge-warn-night: "#d9a441"
  rouge-halt: "#a13256"
  rouge-halt-night: "#e0708f"
typography:
  kantou:
    fontFamily: "'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', serif"
    fontSize: "34px"
    fontWeight: 900
    letterSpacing: "0.32em"
    writingMode: "vertical-rl"
  prose:
    fontFamily: "'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 2
    letterSpacing: "0.02em"
  heading:
    fontFamily: "'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', serif"
    fontSize: "13px-18px"
    fontWeight: 700
    letterSpacing: "0.06em-0.2em"
  marginalia:
    fontFamily: "'FandolKai', 'Kaiti SC', 'STKaiti', 'KaiTi', serif"
    fontSize: "12px-13.5px"
    lineHeight: 1.75
  control:
    fontFamily: "'Source Han Sans CN', 'Noto Sans CJK SC', 'PingFang SC', system-ui, sans-serif"
    fontSize: "12px-13px"
    fontWeight: 400
  mono:
    fontFamily: "'Maple Mono NF CN', 'JetBrains Mono', ui-monospace, monospace"
    fontSize: "10px-11px"
rounded:
  seal: "4px"
  sheet: "2px"
  control: "3px"
  host-card: "12px"
spacing:
  base: "4px"
  sheet-inner: "14px"
  prose: "38px 30px 40px 46px"
  column: "690px"
components:
  cta-ink-block:
    backgroundColor: "{colors.ink-song}"
    textColor: "{colors.sheet-paper}"
    rounded: "{rounded.control}"
    height: "32px"
    shadow: "2px 2px 0 {colors.cinnabar}"
  seal-baiwen:
    backgroundColor: "{colors.cinnabar}"
    textColor: "{colors.sheet-paper}"
    rounded: "{rounded.seal}"
  seal-zhuwen:
    backgroundColor: "{colors.cinnabar-soft}"
    textColor: "{colors.cinnabar}"
    border: "inset 2.5px {colors.cinnabar}"
  manuscript-frame:
    border: "2px outer + 0.5px inner at 6px"
    columns: "prose | 76px kantou | 30px banxin"
---

# Design System: NarrateOS 宋椠朱批 · 碑拓夜读

## Overview

**Creative North Star: 「宋椠朱批 · 碑拓夜读」**

NarrateOS 的视觉系统追求一眼可辨、过目难忘的品牌感：日间是一页宋刻本，夜间是一方碑拓。签名不来自装饰，而来自与产品机制一一对应的古籍语汇：

- 6 个后台工种各执一方闲章，`3x2` 工序矩阵即一页**印谱**；
- 未揭底牌与禁区内容以古籍缺字标记**墨钉**呈现（夜间为碑面**泐痕**）；
- 修补与核查意见以**朱批**挂在页边，正文对应字句加朱色**着重号**；
- 章节定稿以**钤印**收束。

明暗切换不是换色，而是介质切换：刻本（墨字落于宣纸）与拓片（白字显于墨石）。

设计投放遵循 **The Calm Prose Rule**：大胆风格集中在边框、页边、印谱、刊头与转场时刻；正文阅读区本身保持安静，对比度、行宽、行距服从连续数小时阅读。

原版 DSH 宿主界面执行保守改造（见 The Conservative Host Rule），全力美化的对象是 Operator Studio。

视觉原型：`tmp/theme-prototype/galley-stele.html`（本地一次性样张，不入库）。

**Key Characteristics:**
- **介质双态**：日间宋刻本（宣纸纤维底纹 + 松烟墨），夜间碑拓（墨石颗粒底纹 + 拓白字轻微晕散）。
- **刻本版式**：书稿纸面四周双边（外粗内细），右侧竖排刊头与乌丝栏，最右书口条带上下鱼尾与页码。
- **印章语汇**：白文实印 = 已完成，朱文呼吸印 = 运行中，淡色印痕 = 待命，裂印 = 冲突。
- **墨块主行动**：全屏唯一实心主按钮是一块墨（日间墨黑、夜间拓白），以 `2px` 朱砂错位投影为签名。

## Colors

### Media（介质色阶）
- **宋刻本（日间）**：书案 `desk-paper` -> 侧栏 `side-paper` -> 书稿 `sheet-paper`，书口与次级面 `sheet-paper-2`；三级墨阶 `ink-song` / `ink-song-2` / `ink-song-3`。所有纸面叠加极淡宣纸纤维噪点（SVG `feTurbulence`，不透明度不超过 0.09）。
- **碑拓（夜间）**：书案 `desk-stele` -> 侧栏 `side-stele` -> 书稿 `sheet-stele`；三级拓白 `ink-rubbing` / `ink-rubbing-2` / `ink-rubbing-3`。纸面叠加墨石颗粒噪点；正文与刊头加 `0 0 0.6px` 拓白晕散，不得降低可读对比度。
- **版框与栏线**：`frame-*` 仅用于书稿双边、刊头与书口分隔；`rule-*` 用于分组发丝线与乌丝栏。

### Cinnabar（朱砂）
朱砂是品牌主色，承担：印章（工种印谱、定稿钤印、品牌印）、朱批与着重号、当前章与当前页签的小朱点、墨块主按钮的错位投影、浮签签头。朱砂不用于大面积背景，不用于报错。

### Semantic（语义）
- **石绿 `malachite-done`**：已完成状态文字。
- **藤黄 `gamboge-warn`**：手改未同步、润色校勘提示。
- **胭脂 `rouge-halt`**：设定冲突暂停（`SAFE_HALT`）与破坏性操作，必须配裂印形态与明确中文标签，与朱砂严格区分。

### Named Rules
**The Ink-Is-Action Rule.** 同一视口内只有一个实心墨块主按钮（「写下一章 / 写完本章暂停」或冲突裁决卡的首选动作）；其余操作退回描边或纯文字。

**The Dual-Cue Status Rule.** 工序与章节状态必须同时具备印章形态（白文 / 朱文呼吸 / 印痕 / 裂印）与直白中文状态词（已完成 / 生成中 / 待命 / 有冲突），不只依赖颜色。

## Typography

- **宋体（思源宋体 / Noto Serif CJK SC）**：书稿正文、章节刊头、印文、Studio 各级标题与页签。
- **楷体（FandolKai / 楷体系统字体）**：朱批、卷次眉注、设定集分组名等"手写批语"层，仅用于短文本。
- **黑体（思源黑体 / Noto Sans CJK SC）**：高密度控件、按钮内次要文字、表单与原版 DSH 界面。
- **等宽（Maple Mono NF CN / JetBrains Mono）**：`provider:model`、Git SHA、时间戳、Token 计量。

字体全部使用系统已安装字体栈，不随插件打包网络字体。

### Hierarchy
- **Kantou 竖排刊头**（`900`, `34px`, `letter-spacing: 0.32em`, `writing-mode: vertical-rl`）：章节标题，位于书稿纸面右侧刊头栏，上方为「第X章」小字，下方为楷体朱色状态（如「执笔初稿」）。
- **Prose**（`400`, `17px`, `line-height: 2`, 首行缩进 `2em`）：章节正文唯一字阶。
- **Heading**（`700`, `13px-18px`, 宽字距）：卷名、面板标题、工种名。
- **Marginalia**（楷体, `12px-13.5px`, `line-height: 1.75`）：朱批与眉注。
- **Control / Mono**：控件与遥测，数字一律 `tabular-nums`。

### Named Rules
**The Script Layer Rule.** 宋体承载"书"，楷体承载"批"，黑体承载"器"，等宽承载"数"。四层不得混用：按钮主文案用宋体宽字距，批语不用黑体，模型标识不用宋体。

## Layout

Studio 嵌在 DSH 宿主 `main` 槽位内，保留容器感知三栏工作台与既有 `ResizeObserver` 断点：

- **左栏 · 古籍目录**：卷次眉注（楷体朱色）+ 卷名宽字距 + 遥测行；章节列表以「第X章」汉字序号起首，当前章以页边小朱点与极淡朱砂渐隐底标记（禁止侧边粗彩条）；底部「全书设定集」三入口以六角括号〔〕包裹。
- **中栏 · 刻本舞台**：页签、工序印谱、书稿纸面、浮签共用 `690px` 版心；版心左侧保留批语栏（约 `150px`），用于挂朱批。
- **右栏 · 书签页签**：`思考过程 | 运行状态 | 模型分配`，激活页签为宋体加粗 + 底部墨线；轨迹列表为竖向时间线，运行中节点为朱砂呼吸点。

### Manuscript Leaf（书稿版式）
```
┌═══════════════════════════════════════┬──────┬───┐
│  正文（prose）                          │ 竖排 │书 │
│                                         │ 刊头 │口 │
│                                         │ 乌丝 │鱼 │
│                              定稿钤印   │ 栏   │尾 │
└═══════════════════════════════════════┴──────┴───┘
```
- 外框 `2px` + 内框 `0.5px`（内缩 `6px`），纸面圆角仅 `2px`。
- 刊头栏 `76px`，背景为间距 `38px` 的竖向乌丝栏；书口条 `30px`，自上而下为书名、上鱼尾、卷次、下鱼尾、页码。
- 段号以汉字「〇一」竖排，悬停段落时于左页边浮现。

## Elevation & Depth

以纸张层叠而非卡片阴影组织深度：书案底纹 -> 侧栏 -> 书稿纸面。仅书稿纸面与浮签有投影（日间暖褐柔影，夜间深黑长影）；侧栏、印谱面板零阴影，靠发丝线与纸色区分。

## Shapes

- **印章**：近方形，`4px` 微圆角，经 SVG 位移滤镜形成不规则印泥边缘与斑驳；定稿印与品牌印 `-4deg` 钤印倾角。
- **控件**：`3px` 圆角，硬朗如裁切纸签。
- **书稿**：`2px` 圆角，几乎直角。
- **原版 DSH 浮动主舞台**：沿用宿主 `12px` 圆角。

## Components

### 工序印谱（Pipeline Seal Catalog）
六方闲章：「典籍」Librarian、「谋篇」Planner、「执笔」Writer、「勘误」Fact-checker、「录事」Extractor、「入梦」Dreamer。印文为两字竖排宋体加粗（宋体印式）。
- 已完成：白文实印（朱底拓白字）。
- 运行中：朱文印（朱字朱框浅朱底）+ `2.2s` 呼吸。
- 待命：淡色印痕（发丝框 + 弱墨字，无滤镜）。
- 冲突：裂印（对角裂纹）+ 胭脂色「有冲突」。
- 状态从运行中转为已完成时播放一次钤印动画（放大落下、轻微回弹，`620ms`）。
- 点击任一印章进入右栏该工种的思考轨迹。

### 墨钉 / 泐痕（Mo-ding）
- 日间为实心墨块，夜间为碑面泐痕（浅色风化斑块）；悬停揭示原文，并以楷体注明来源（如「未揭底牌 · 第十二章揭底」）。
- **The Mo-ding Truth Rule.** 墨钉只覆盖后端明确标记为隐藏的数据（`OMNISCIENT_SECRET`、非当前 POV `SELF_ONLY`、禁区）；不得凭前端推测制造墨钉。

### 朱批与圈点（Marginalia）
- 楷体朱字挂在版心左侧批语栏，以虚线引线指向正文；正文对应字句加朱色着重号（CSS `text-emphasis: filled dot`）。
- **The Marginalia Truth Rule.** 朱批只渲染后端已持久化且带定位的意见（如 Patch 段落号、门禁违规行号）；无定位的意见进入右栏，不在正文伪造圈点。

### 定稿钤印
已定稿且无手改的章节，章末右下落 `56px` 白文「定稿」印，左侧等宽落款为真实 Git Commit SHA 与时间。

### 墨块主按钮（Ink Block CTA）
日间墨黑底宣纸字、夜间拓白底墨字，`3px` 圆角，`2px 2px 0` 朱砂错位投影；主文案宋体加粗宽字距；右侧 `▾` 分体下拉收纳次级与破坏性动作。焦点环为 `2px` 墨色实线外轮廓（`2px` 偏移）。

### 浮签（Director Note Dock）
左端竖排朱底「浮签」签头，随后为楷体便签类型切换与宋体输入区，右端墨块「贴签」按钮；整体如一张夹在书页间的纸签。

### 原版 DSH（保守改造）
- 品牌位：白文「叙事」方印 + `NarrateOS` 黑体字样 + 楷体「叙事引擎」。
- 配色：通过 `ctx.theme.overrideTokens` 换为宋刻本 / 碑拓色阶。
- 中栏：浮动主舞台内侧一圈 `0.5px` 极淡版框发丝线。
- 对话：助手回复正文改宋体舒展行距（代码、表格、工具卡片保持黑体与等宽）；引用块为浅朱底色块（无侧边竖条）。

**The Conservative Host Rule.** 原版 DSH 只允许三类改动：颜色变量、公开 `data-*` 属性挂钩、少数无公开钩子区域的精确哈希类名（必须由单测从已安装 DSH 包源码断言存在）。禁止 `[class*=...]` 子串匹配；设置弹窗、插件管理、工具卡片、diff、终端只换色不改结构。

## Motion

- **水墨晕开（日间）**：新章或切章时段落依次由模糊到清晰（`1.1s`，逐段错开 `140ms`）。
- **拓印显影（夜间）**：段落由暗到亮显出。
- **钤印**：印章放大落下并回弹。
- **呼吸**：运行中的印章与轨迹节点。
- 所有动画提供 `prefers-reduced-motion: reduce` 瞬显降级，快速切章可随时中断。

## Do's and Don'ts

### Do:
- **Do** 让每个古籍语汇对应一个真实产品机制（印谱 = 工种，墨钉 = 隐藏数据，朱批 = 带定位的校勘意见，钤印 = 定稿）。
- **Do** 保持正文区安静：签名元素只出现在页边、刊头、书口、印谱与转场。
- **Do** 日夜两态同时验收，夜间拓白晕散不得降低正文可读性。
- **Do** 保持单章页签（`本章正文 | 本章细纲 | 改动对比`）与跨章「全书设定集」物理分离。

### Don't:
- **Don't** 使用单侧粗彩条（`border-left: 3px solid ...` 等 side-tab）；当前项用小朱点或渐隐底标记。
- **Don't** 用朱砂表达错误或危险；冲突与破坏性操作一律用胭脂色 + 裂印 + 中文标签。
- **Don't** 堆砌与产品机制无关的古风装饰（祥云、回纹边框、毛笔字标题、仿古按钮）。
- **Don't** 在界面文案中裸露 `WAL`、`WARPED`、`MATTR-500` 等工程术语。
- **Don't** 用 Emoji 或字符充当图标；操作图标统一为 `1.5px` 描边内联 SVG。
- **Don't** 用打断式弹窗阻断切书或外部 `book_switched` 事件。

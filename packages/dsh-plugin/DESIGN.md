---
name: NarrateOS Studio
description: 安静的导演书桌，克制、清晰、耐读的长篇创作控制台
colors:
  primary: "#5686fe"
  primary-light: "#3b6fe0"
  primary-ink: "#86a8ff"
  primary-ink-light: "#2b5cc9"
  graphite: "#151517"
  paper: "#faf8f4"
  panel: "#18181a"
  panel-light: "#f3efe7"
  card: "#232324"
  card-light: "#fffdf9"
  raised: "#2c2c2e"
  raised-light: "#fffefb"
  text: "#f9fafb"
  text-light: "#1c1a17"
  text-secondary: "#cfd3d6"
  text-secondary-light: "#45413b"
  text-muted: "#8c9199"
  text-muted-light: "#6b665e"
  prose: "#e6e3dc"
  prose-light: "#262420"
  success-ink: "#4ed17e"
  success-ink-light: "#15703c"
  warning-ink: "#f7ad31"
  warning-ink-light: "#8a4a05"
  danger-ink: "#f26d6d"
  danger-ink-light: "#b02a2a"
  warped: "#a78bfa"
  warped-light: "#6d4bd0"
  seal: "#e0664a"
  seal-light: "#c0492f"
  on-primary: "#ffffff"
typography:
  body:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  prose:
    fontFamily: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", serif'
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 2
    letterSpacing: "0.012em"
  title:
    fontFamily: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", serif'
    fontSize: "28px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.02em"
  label:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "12.5px"
    fontWeight: 500
  label-small:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 500
  mono-summary:
    fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace'
    fontSize: "11px"
    lineHeight: 1.3
  chapter-number:
    fontFamily: '"Inter Display", Inter, system-ui, sans-serif'
    fontSize: "84px"
    fontWeight: 200
    lineHeight: 0.82
    letterSpacing: "-0.05em"
  metric:
    fontFamily: '"Inter Display", Inter, system-ui, sans-serif'
    fontSize: "28px"
    fontWeight: 300
    lineHeight: 1.1
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  pill: "999px"
spacing:
  gap-4: "4px"
  gap-6: "6px"
  gap-8: "8px"
  gap-10: "10px"
  inset-12: "12px"
  inset-14: "14px"
  inset-16: "16px"
  inset-18: "18px"
  gutter-24: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0px 11px"
    height: "30px"
  button-ghost:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0px 10px"
    height: "30px"
  input:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 11px"
  nav-tabs:
    height: "38px"
  status-chip:
    textColor: "{colors.success-ink}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  inspector-card:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.lg}"
    padding: "12px"
  stage-node:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    padding: "0px 10px"
    height: "28px"
  inspector-accordion:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
---

# Design System: NarrateOS Studio

## Overview

**Creative North Star: "安静的导演书桌"**

克制、清晰、耐读。创作内容与运行控制共处，但不争夺同一种注意力：宋体正文承接连续阅读，无衬线界面负责导航和操作，等宽信息用于代码、度量与状态识别。工具的精确不需要依靠粗重标题、装饰图表或持续闪动来表达。

常驻区平整，浮层以柔和阴影表达结构。组件轻巧克制，状态明确；暖纸浅色与石墨深色是同一系统的两种使用环境，不是两套品牌。保留现有设计中的文学阅读质感，同时让控制、选中与异常有各自清楚的表达。

**Key Characteristics:**

- 宋体阅读、无衬线操作、等宽度量，各自承担明确职责。
- 中性色构成常驻表面，调度蓝识别动作，状态色不与朱印语义混用。
- 以字级、留白、细线和表面层次组织密度，显式设计字重不超过 500。
- 常驻区平整，弹出层的阴影说明覆盖关系而非装饰。
- 深浅主题共享布局与交互结构，宿主原语和插件内容保持清晰边界。

本记录仅覆盖 `packages/dsh-plugin` 的现有 Studio，不为 CLI 或未来宣传页规定视觉风格。产品事实引用 [docs/PRODUCT.md](../../docs/PRODUCT.md)，不复制其内容；不以该文件能够被启动器自动发现为前提。

提取依据是 [主样式](src/client/styles.ts)、[检查器样式](src/client/inspector-styles.ts)、[开书样式](src/client/boot-styles.ts) 与当前组件源码。实机抽样检查了宿主内的深浅主题、正文、检查器、开书弹窗和窄屏布局。这里记录的是实现与用户确认的描述，不是一次完整无障碍审计或 UI 整改。

## Colors

调度蓝提供功能重心，石墨黑与暖纸白承托内容，朱印红保留少量身份与钤印意味。YAML 中无 `-light` 后缀的成对颜色代表深色主题；浅色主题使用对应后缀，主画布例外为 `graphite` / `paper`。颜色原值只在 frontmatter 定义，正文说明用途。

### Primary

- **调度蓝**：`primary` 对应主操作、激活点和键盘焦点；`primary-ink` 对应文字型强调。浅色的实心与文字色分开，不把主按钮填充色直接当作所有蓝色小字。
- `on-primary` 用于实心主按钮的文字。悬停沿用源码的 `color-mix()` 提亮，条件限定在支持 hover 的精细指针设备。
- 选中底、选区、焦点外环和描边使用源码既有的半透明派生 token；不把实心主色铺满内容区域。

### Secondary

- **朱印红**：`seal` 与 `seal-light` 对应模式标识中的朱印点及已有钤印样式。它不是危险红，也不是另一种主要操作色。
- **语义状态色**：`success-ink` 表达完成或正常，`warning-ink` 表达警告或修复，`danger-ink` 表达失败或安全停机；浅色主题有各自更深的文字色。实心状态点与进度条仍使用源码独立的状态填充 token，不能误用文字 token 替换。
- **偏转紫**：`warped` 仅用于既有偏转状态，不作为额外装饰色。

### Neutral

- **石墨黑 / 暖纸白**：主画布。浅色带暖感，正文颜色随之偏暖，不使用机械黑白反转。
- **面板、卡片、浮起表面**：`panel`、`card`、`raised` 对应不同层级；分界仍依靠细边框，不把每个区域都做成悬浮卡片。
- **一级、次级、弱化文字**：`text`、`text-secondary`、`text-muted` 区分信息优先级；正文另用 `prose`，不与工具说明混成同一灰度。

**The 语义分色 Rule.** 调度蓝负责动作，状态色负责运行事实，朱印红不承担告警。不能为了页面更鲜艳而交换这些角色。

**The 主题同源 Rule.** 宿主 `body` 带 `data-ds-dark-theme` 时进入深色，否则进入浅色。独立预览的浅色覆盖是额外入口，不代表存在对称的 `data-theme="dark"` 契约。Portal 内的开书内容必须拥有自己的主题变量，不能假定继承 Studio 外壳。

## Typography

界面字体栈以 Inter 与中文无衬线回退组合；正文与章名以思源／Noto 宋体和本机宋体回退组合。等宽栈用于 SHA、WAL、模型标识与度量；展示字体栈只用于章号和既有大数。当前样式未打包字体文件，字体栈不等于首选字体在所有机器都已加载。

### 层级

| 角色 | frontmatter 记录 | 使用方式 |
|---|---|---|
| 界面正文 | `typography.body` | 工具说明、常规信息与界面基础节奏 |
| 小说正文 | `typography.prose` | 默认阅读字级，另有 15px / 19px 两档；段首缩进 2em，段后间距 0.9em |
| 章名 | `typography.title` | 标题与正文同属宋体，不借助粗黑体制造主次 |
| 按钮与小标题 | `typography.label` / `label-small` | 工具操作、检查器标题，重点来自状态和布局 |
| 度量摘要 | `typography.mono-summary` | 紧凑摘要，不用等宽字体装饰普通叙述 |
| 章号 | `typography.chapter-number` | 既有章节标识的轻字重视觉锚点，不推广成通用大标题 |
| 指标大数 | `typography.metric` | 既有检查器数据，不作为新增面板的默认模板 |

**The 轻字重 Rule.** 设计字重上限为 500。层级优先靠字级、字体职责、对比和间距，而不是叠加粗体。

实际抽样中，界面基础字重为 400，正文默认行高为 34px，主按钮与活动页签为 500。部分控件字体依赖宿主重置；源码对所有原生 `b` / `strong` 未作统一覆盖，因此不能把“所有最终节点都已满足字重上限”当作这次记录的验证结论。

## Layout

### 空间关系

Studio 自身是中间工作区与右侧辅助栏的两列系统。左侧整块 dsh 导航属于宿主；本地章节目录位于右栏的「目录」页签内。不要把源码遗留的独立左栏样式误认为当前三栏布局。

- 右栏展开且容器足够宽时占 332px；收起时网格列宽归零。
- 正文最大宽度为 660px，底部输入区最大宽度为 720px。二者有各自的水平空间，不强行统一成满宽表格。
- 顶栏为 46px，次级页签条为 38px。正文与检查器分别滚动，外壳填满宿主槽位。
- 宽屏阅读栏保留 120px 底部余量；窄屏源码覆盖为 72px。它们是当前布局值，不是所有未来浮层通用的安全距离。
- 间距表是源码重复使用的字面值归纳，当前没有对应的 `--ns-space-*` 全局 token，也不存在严格的单一倍数网格。

### 响应式契约

| 条件 | 当前行为 |
|---|---|
| Studio 容器宽度小于 1060px | 右栏成为覆盖式抽屉，宽 332px、最大 90vw；遮罩点击可关闭 |
| 容器从宽跨入窄 | 自动收起右栏；变宽不会自动重新展开 |
| 视口不超过 640px | 开书路径卡、字段与校准网格改为单列 |
| 视口不超过 480px | 顶栏与动作允许换行，工作区横向内距缩小，底部输入区圆角及正文余量调整 |
| 粗指针设备 | 开书输入字号提升到 16px；不能将窄视口测试等同于触屏测试 |

容器断点与视口断点不是同一个条件，不能把右栏逻辑改写成只看浏览器宽度的媒体查询。宿主自身侧栏也会占用空间。

## Elevation & Depth

**常驻区平整，浮层以柔和阴影表达结构。** 面板与卡片主要通过表面色和细线分界；弹出菜单、窄屏右栏、开书弹窗使用带偏移与柔化的阴影。底部输入区另有局部焦点反馈。零偏移的焦点外环是交互指示，不是装饰光晕。

阴影原值记录在 [.impeccable/design.json](.impeccable/design.json) 的 `extensions.shadows`；深浅主题的阴影与外环不同。不要把同一份暗色阴影机械套到浅色主题。

**The 结构深度 Rule.** 常驻信息不靠阴影竞争层级；覆盖关系与焦点变化才需要额外的深度提示。

既有动效包含按钮和列表的短过渡、布局列宽变化、正文轻移入与运行状态脉冲。它们是状态反馈，不是新增页面时应到处复制的装饰配方。外壳范围的 `prefers-reduced-motion` 会关闭动画和过渡；该选择器不覆盖 Portal 弹窗，不能宣称所有浮层已经继承这项保护。

## Shapes

小控件、常规卡片、较大容器和弹窗分别使用 frontmatter 的 `sm`、`md`、`lg`、`xl` 圆角。胶囊标签与阶段节点使用 pill；状态点和圆形发送键使用圆形。

组合推进按钮的相邻边不各自圆角，保持一个动作组的轮廓。底部输入区采用独立的 16px 圆角，窄屏变为 14px；这是既有组件特征，不需要硬凑进通用圆角档位。

边框通常为 1px，强弱随主题与状态变化。圆角不承担信息优先级，不能只因某块内容重要就不断加大圆角或边框。

## Components

**组件气质：轻巧克制，状态明确。** frontmatter 的组件记录提供深色基础外观；浅色替换遵循成对颜色与源码主题 token。扩展记录提供两种主题的自包含视觉样例，不依赖 Studio 外壳。样例不是运行时组件实现，也不提供 API 调用、业务状态或宿主焦点管理。

### 按钮

主按钮使用调度蓝，次按钮使用卡片表面与控件边框；两者共用轻字重。次按钮的小号、极小号分别为 26px / 22px 高。主按钮与小号类组合后，当前层叠仍以主按钮的 30px 高度生效，不把名义尺寸写成实际尺寸。

悬停只在 `(hover: hover) and (pointer: fine)` 下生效。禁用态透明度为 0.45，禁用时不能继续显示可点击的悬停反馈。Studio 外壳内的键盘焦点采用 2px 调度蓝轮廓与 2px 偏移。

### 输入与导演纸条

开书字段使用基础表面、控件边框、常规圆角和 `8px 11px` 内距；焦点时边框转为品牌色并增加 3px 半透明外环。文本域沿用界面字体，代码标识字段可使用等宽栈。

底部导演输入是独立组件，不与开书字段混为一套尺寸。输入、待消费纸条、撤回和推进动作各自可辨；撤回是实际业务操作，不应仅做纸条消失动画来替代。

### 页签与章节目录

中栏页签用底部细线和字重区分当前视图，右栏页签用浅底区分目录、检查器和工具。章节条目通过背景、边框和文字层级表达选中；不要把宿主会话目录复制成另一个本地左栏。

现有页签是带 `aria-selected` 的原生按钮。此记录不声称已实现方向键切换和 roving tabindex；组件样例也不伪装完整键盘协议。

### 标签与状态

状态标签用文字加语义色浅底，不只依靠颜色。成功、修复、失败与偏转不能仅靠更换同一个装饰徽章表示。紧凑标签不是新增标题的默认前缀。

### 检查器卡片与手风琴

卡片平整、细边框、紧凑内距。手风琴组头保留名称与摘要，折叠只减少细节，不抹去组的当前信息。内部内容按任务组织，不要求所有分组具有相同的卡片数量或高度。

### 阶段点链

折叠时使用紧凑点链，展开后呈现工序节点与状态。普通门禁扫描属于 Writer 的执行过程；只有局部 Patch 才显示修复语义。Dreaming 的休眠状态采用虚线表达，与失败和等待不同。阶段图是运行事实的解释，不是任意装饰时间线。

### 宿主 Modal 与 Toast

开书使用宿主 `Modal`，本地负责其内容、表单与主题变量。Portal、遮罩、Escape 和焦点恢复属于宿主契约，不能在样例中画一个相似方框就宣称已复用这些行为。实机抽样中，桌面卡片宽 860px；390px 视口下为 342px，实际宽度受宿主外层约束，不能只按本地 CSS 计算。

Toast 使用宿主原语，不建立本地影子组件。当前错误与普通通知的区别是驻留时长，不存在本地传入的错误色调变体；设计记录不杜撰该变体。

### 记录与实现边界

前端样式中的未使用选择器不纳入组件清单。扩展样例只摘取当前活跃模式，使用 `ds-` 前缀隔离，并显式提供脱离宿主后所需的字体和颜色。样例中的焦点样式不构成生产 Portal 组件已通过无障碍验证的证据。

## Do's and Don'ts

### Do:

- **Do** 让阅读文字、操作文字和度量文字承担不同职责，保留源码已有的字体栈与回退。
- **Do** 成对维护深浅主题，并让脱离外壳的 Portal 内容自带必要变量。
- **Do** 用字级、间距、细边框与表面层次组织信息，遵守设计字重不超过 500 的约束。
- **Do** 保留 hover 的设备条件、明确的焦点反馈与真实的禁用状态。
- **Do** 以实际挂载的组件和最终层叠值更新本记录，重新生成扩展样例以保持一致。

### Don't:

- **Don't** 把朱印红当作告警色，或将运行状态色扩展成无语义装饰。
- **Don't** 将宿主导航、Modal 或 Toast 伪装成插件自有组件与自有交互契约。
- **Don't** 把旧原型、死样式、名义按钮尺寸或未加载的首选字体写成当前实机事实。
- **Don't** 将局部控件的抽样验证扩写成整个界面已通过对比度、键盘或减少动效审计。
- **Don't** 把扩展记录里用于展示的色阶当作新增生产 token；它们不替代 frontmatter 与源码主题值。

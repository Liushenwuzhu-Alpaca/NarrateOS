export const THEME_PLUGIN_ID = '@narrateos/dsh-client-ui-theme-narrateos';
export const THEME_STYLE_CSS_ID = '@narrateos/dsh-client-ui-theme-narrateos/global.css';

/**
 * NarrateOS 东方清样校勘室 · 书案三栏（Card-on-Desk）全局版式与排版样式表。
 * - 同时美化原版 DSH（AppFrame、左侧栏、右侧栏、对话流、Composer、设置浮层）
 *   与 NarrateOS Operator Studio（.ns-studio-shell）；
 * - 卸载插件时由 DSH 或 ctx.effect 清理器整张移除，瞬间还原原版 DSH。
 */
export const NARRATEOS_GLOBAL_THEME_CSS = `
/* ========== 0. 字体变量与全局纸墨基础 ========== */
body {
    --ns-theme-font-sans: var(--dsw-font-family, Inter, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif);
    --ns-theme-font-serif: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif;
    --ns-theme-font-mono: var(--ds-font-family-code, "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace);
    --ns-theme-seal: #df6447;
    --ns-theme-seal-soft: rgba(223, 100, 71, 0.12);
    --ns-theme-desk-shadow: 0 2px 14px rgba(24, 20, 14, 0.06), 0 0 0 0.5px var(--dsw-alias-border-l2);
    --ns-theme-composer-shadow: 0 8px 28px rgba(24, 20, 14, 0.08), 0 1px 4px rgba(24, 20, 14, 0.04);
    --ns-theme-bubble-shadow: 0 1px 3px rgba(24, 20, 14, 0.04);
}

body[data-ds-dark-theme] {
    --ns-theme-desk-shadow: 0 4px 20px rgba(0, 0, 0, 0.28), 0 0 0 0.5px var(--dsw-alias-border-l2);
    --ns-theme-composer-shadow: 0 10px 32px rgba(0, 0, 0, 0.36), 0 2px 6px rgba(0, 0, 0, 0.20);
    --ns-theme-bubble-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
}

/* ========== 1. 书案三栏全局版式（Card-on-Desk AppFrame） ========== */
html:not([data-platform="darwin"]):not([data-windows-titlebar]) [class*="_frame"] {
    background: var(--dsw-specific-sidebar-fill);
}

/* 左侧栏：退居低存在感桌面底板，去掉生硬竖线 */
[class*="_sidebarCol"] {
    background: var(--dsw-specific-sidebar-fill) !important;
    border-right: none !important;
}

/* 宽屏三栏下，将中央主舞台塑造成浮动清样纸面 */
[class*="_frame"]:not([data-sidebar-drawer]):not([data-rightbar-fullscreen]) [class*="_centerCol"] {
    margin: 8px 8px 8px 0;
    border-radius: 12px;
    background: var(--dsw-alias-bg-base);
    box-shadow: var(--ns-theme-desk-shadow);
    border-left: none !important;
    overflow: hidden;
}

/* 当左侧栏收起或处于 macOS 无左栏轨道时，补齐左侧书案边距 */
[class*="_frame"][data-sidebar-collapsed]:not([data-sidebar-drawer]):not([data-rightbar-fullscreen]) [class*="_centerCol"] {
    margin-left: 8px;
}

/* 窄屏抽屉态或右栏全屏态保持完整贴边，不浪费窄屏像素 */
[class*="_frame"][data-sidebar-drawer] [class*="_centerCol"],
[class*="_frame"][data-rightbar-fullscreen] [class*="_centerCol"] {
    margin: 0;
    border-radius: 0;
    box-shadow: none;
}

/* Windows 标题栏模式适配 */
[data-windows-titlebar] [class*="_frame"]:not([data-sidebar-drawer]) [class*="_centerCol"] {
    margin: 0 8px 8px 0;
    border-radius: 12px;
    box-shadow: var(--ns-theme-desk-shadow);
}

/* 右侧栏轨道融入书案底板 */
[class*="_rightbarCol"] {
    background: transparent;
}

[class*="_rightbarCol"] [class*="_panel"] {
    background: var(--dsw-alias-bg-layer-1);
    border-left: 0.5px solid var(--dsw-alias-border-l2);
}

/* ========== 2. 左侧栏品牌徽标与导航节奏 ========== */
.ns-theme-brand-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.ns-theme-brand-mark svg {
    display: block;
}

[class*="_logoRow"]:hover .ns-theme-brand-mark {
    transform: rotate(2deg) scale(1.03);
}

.ns-theme-brand-wordmark {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
}

.ns-theme-brand-title {
    font-family: var(--ns-theme-font-sans);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--dsw-alias-label-primary);
}

.ns-theme-brand-tag {
    font-family: var(--ns-theme-font-mono);
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.08em;
    color: var(--ns-theme-seal);
    background: var(--ns-theme-seal-soft);
    padding: 1px 5px;
    border-radius: 999px;
    line-height: 1.35;
}

/* 左侧栏导航项去粗边条，采用微圆角暖墨高亮 */
[class*="_panelRow"] {
    border-radius: 8px;
    transition: background-color 0.14s ease, color 0.14s ease;
}

[class*="_panelRow"][class*="_panelActive"],
[class*="_panelRow"][aria-current="page"] {
    background: var(--dsw-specific-sidebar-nav-item-active) !important;
    color: var(--dsw-alias-label-primary);
    font-weight: 500;
}

[class*="_newSession"] {
    border-radius: 8px;
    border: 0.5px solid var(--dsw-alias-border-l2);
    box-shadow: var(--ns-theme-bubble-shadow);
}

/* ========== 3. 主对话区：文学清样对话流 ========== */
[data-chat-flow] {
    max-width: min(740px, 100%);
    margin-left: auto;
    margin-right: auto;
    padding-top: 12px;
    padding-bottom: 24px;
}

/* 用户消息气泡：轻巧暖底便签，保留极淡发丝边框 */
[data-message-bubble] {
    background: var(--dsw-specific-bubble) !important;
    border: 0.5px solid var(--dsw-alias-border-l2);
    border-radius: 11px !important;
    box-shadow: var(--ns-theme-bubble-shadow);
    font-family: var(--ns-theme-font-sans);
    line-height: 1.62;
}

/* AI 回复正文：书卷衬线排版 + 舒展行距（严格排除紧凑变体与工程代码区） */
[data-chat-flow] [class*="_markdown_"]:not([data-markdown-variant="compact"]) {
    font-family: var(--ns-theme-font-serif);
    line-height: 1.86;
    letter-spacing: 0.01em;
    color: var(--dsw-alias-label-primary);
}

[data-chat-flow] [class*="_markdown_"]:not([data-markdown-variant="compact"]) h1,
[data-chat-flow] [class*="_markdown_"]:not([data-markdown-variant="compact"]) h2,
[data-chat-flow] [class*="_markdown_"]:not([data-markdown-variant="compact"]) h3 {
    font-family: var(--ns-theme-font-serif);
    letter-spacing: 0.015em;
    margin-top: 1.25em;
    margin-bottom: 0.55em;
}

[data-chat-flow] [class*="_markdown_"]:not([data-markdown-variant="compact"]) p {
    margin-bottom: 0.9em;
}

[data-chat-flow] [class*="_markdown_"]:not([data-markdown-variant="compact"]) blockquote {
    border-left: 2px solid var(--ns-theme-seal);
    padding-left: 14px;
    color: var(--dsw-alias-label-secondary);
    font-style: normal;
}

/* 代码块、行内代码、表格与引用徽标严格回到等宽/无衬线，维持工具秩序 */
[data-chat-flow] [class*="_markdown_"] pre,
[data-chat-flow] [class*="_markdown_"] code,
[data-chat-flow] [class*="_markdown_"] kbd {
    font-family: var(--ns-theme-font-mono) !important;
    letter-spacing: 0;
}

[data-chat-flow] [class*="_markdown_"] table,
[data-chat-flow] [class*="_markdown_"] th,
[data-chat-flow] [class*="_markdown_"] td {
    font-family: var(--ns-theme-font-sans);
    line-height: 1.5;
    letter-spacing: 0;
}

/* 底部悬浮输入舱（Composer） */
[data-composer-seat] {
    padding-bottom: 14px;
}

[data-composer-card="true"] {
    background: var(--dsw-specific-input-major) !important;
    border-radius: 12px !important;
    border: 0.5px solid var(--dsw-alias-border-l2);
    box-shadow: var(--ns-theme-composer-shadow) !important;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

[data-composer-card="true"]:focus-within {
    border-color: rgba(76, 124, 240, 0.55);
}

[data-composer-input="true"] {
    font-family: var(--ns-theme-font-sans);
    line-height: 1.58;
}

/* ========== 4. Operator Studio 无缝联动美化 ========== */
/* Studio 已挂载在浮动清样主舞台内时，消除外层边界冲突并统一底板气韵 */
[class*="_mainPanel"] .ns-studio-shell {
    background: var(--dsw-alias-bg-base);
    --ns-bg-outer: var(--dsw-specific-sidebar-fill);
    --ns-bg-host: var(--dsw-specific-sidebar-fill);
    --ns-bg-stage: var(--dsw-alias-bg-base);
}

[class*="_mainPanel"] .ns-studio-shell .ns-topbar {
    background: transparent;
    border-bottom-color: var(--dsw-alias-border-l1);
}

[class*="_mainPanel"] .ns-studio-shell .ns-left,
[class*="_mainPanel"] .ns-studio-shell .ns-right {
    border-color: var(--dsw-alias-border-l1);
}

/* ========== 5. 减弱动态偏好兼容 ========== */
@media (prefers-reduced-motion: reduce) {
    .ns-theme-brand-mark,
    [class*="_panelRow"],
    [data-composer-card="true"] {
        transition: none !important;
    }
}
`;

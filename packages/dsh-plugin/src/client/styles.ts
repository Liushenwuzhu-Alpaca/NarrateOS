/**
 * NarrateOS Operator Studio 视觉样式层
 * - 100% 对齐 @deepseek-ai/dsh-client-ui-theme 设计令牌与 docs/dsh-studio-prototype.html 排版细节
 * - 所有 CSS 变量与选择器均使用 ns- 作用域前缀，避免污染 DSH 宿主全局样式
 * - 支持暗色默认主题与 [data-theme="light"] 亮色主题自适应切换
 */

export const STUDIO_STYLE_ELEMENT_ID = 'narrateos-studio-styles';

export const STUDIO_CSS = `
.ns-studio-shell {
    color-scheme: dark;
    --ns-bg-base: #151517;
    --ns-bg-panel: #18181a;
    --ns-bg-card: #232324;
    --ns-bg-surface-2: #2c2c2e;
    --ns-bg-hover: rgba(255, 255, 255, 0.05);
    --ns-bg-press: rgba(255, 255, 255, 0.09);
    --ns-border-1: rgba(255, 255, 255, 0.06);
    --ns-border-2: rgba(255, 255, 255, 0.12);
    --ns-border-3: rgba(255, 255, 255, 0.2);
    --ns-text-1: #f9fafb;
    --ns-text-2: #cfd3d6;
    --ns-text-3: #adb2b8;
    --ns-text-4: #8c9199;
    --ns-numeral: #5a5f68;
    --ns-prose: #e6e3dc;
    --ns-brand: #5686fe;
    --ns-brand-ink: #86a8ff;
    --ns-brand-soft: rgba(86, 134, 254, 0.14);
    --ns-brand-line: rgba(86, 134, 254, 0.42);
    --ns-green: #4ed17e;
    --ns-green-ink: #4ed17e;
    --ns-green-soft: rgba(78, 209, 126, 0.12);
    --ns-amber: #f7ad31;
    --ns-amber-ink: #f7ad31;
    --ns-amber-soft: rgba(247, 173, 49, 0.12);
    --ns-amber-line: rgba(247, 173, 49, 0.4);
    --ns-red: #f26d6d;
    --ns-red-ink: #f26d6d;
    --ns-red-soft: rgba(242, 109, 109, 0.12);
    --ns-red-line: rgba(242, 109, 109, 0.42);
    --ns-violet: #a78bfa;
    --ns-violet-soft: rgba(167, 139, 250, 0.13);
    /* 品牌朱印仅用于 NarrateOS 标识与「定稿」钤印，不承担告警语义 */
    --ns-seal: #e0664a;
    --ns-seal-soft: rgba(224, 102, 74, 0.12);
    --ns-pop-shadow: 0 18px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--ns-border-2);
    --ns-col: 660px;
    --ns-r-sm: 6px;
    --ns-r-md: 10px;
    --ns-r-lg: 14px;
    --ns-r-xl: 18px;
    --ns-ease: cubic-bezier(0.2, 0.7, 0.2, 1);
    --ns-font-sans: Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
    --ns-font-serif: "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "Songti SC", serif;
    --ns-font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    --ns-font-display: "Inter Display", Inter, system-ui, sans-serif;

    font-family: var(--ns-font-sans);
    background: var(--ns-bg-base);
    color: var(--ns-text-1);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--ns-right-w, 332px);
    grid-template-rows: minmax(0, 1fr);
    transition: grid-template-columns 0.24s var(--ns-ease);
    overflow: hidden;
    position: relative;
}

.ns-studio-shell > * {
    min-height: 0;
    min-width: 0;
}

.ns-drawer-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.36);
    z-index: 40;
}

/* 亮色主题变量适配（兼容宿主根节点或外壳节点挂载 data-theme="light"） */
[data-theme="light"] .ns-studio-shell,
.ns-studio-shell[data-theme="light"] {
    color-scheme: light;
    --ns-bg-base: #ffffff;
    --ns-bg-panel: #f9fafb;
    --ns-bg-card: #f5f6f7;
    --ns-bg-surface-2: #ffffff;
    --ns-bg-hover: rgba(0, 0, 0, 0.04);
    --ns-bg-press: rgba(0, 0, 0, 0.07);
    --ns-border-1: rgba(0, 0, 0, 0.06);
    --ns-border-2: rgba(0, 0, 0, 0.1);
    --ns-border-3: rgba(0, 0, 0, 0.18);
    --ns-text-1: #0f1115;
    --ns-text-2: #44494e;
    --ns-text-3: #61666b;
    --ns-text-4: #696d74;
    --ns-numeral: #b6bac2;
    --ns-prose: #23252a;
    --ns-brand: #4176e6;
    --ns-brand-ink: #3567d6;
    --ns-brand-soft: rgba(65, 118, 230, 0.09);
    --ns-brand-line: rgba(65, 118, 230, 0.38);
    --ns-green: #22c55e;
    --ns-green-ink: #15803d;
    --ns-green-soft: rgba(34, 197, 94, 0.1);
    --ns-amber: #f59e0b;
    --ns-amber-ink: #b45309;
    --ns-amber-soft: rgba(245, 158, 11, 0.1);
    --ns-amber-line: rgba(245, 158, 11, 0.45);
    --ns-red: #dc2626;
    --ns-red-ink: #dc2626;
    --ns-red-soft: rgba(220, 38, 38, 0.07);
    --ns-red-line: rgba(220, 38, 38, 0.35);
    --ns-violet: #7c3aed;
    --ns-violet-soft: rgba(124, 58, 237, 0.08);
    --ns-seal: #c8452c;
    --ns-seal-soft: rgba(200, 69, 44, 0.08);
    --ns-pop-shadow: 0 18px 48px rgba(15, 17, 21, 0.14), 0 0 0 1px var(--ns-border-2);
}

.ns-studio-shell *,
.ns-studio-shell *::before,
.ns-studio-shell *::after {
    box-sizing: border-box;
}

.ns-studio-shell :focus-visible {
    outline: 2px solid var(--ns-brand);
    outline-offset: 2px;
    border-radius: var(--ns-r-sm);
}

.ns-studio-shell ::selection {
    background: var(--ns-brand-soft);
}

.ns-studio-shell ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}

.ns-studio-shell ::-webkit-scrollbar-thumb {
    background: var(--ns-border-2);
    border-radius: 8px;
    border: 2px solid transparent;
    background-clip: content-box;
}

.ns-studio-shell ::-webkit-scrollbar-track {
    background: transparent;
}

.ns-mono {
    font-family: var(--ns-font-mono);
}

@keyframes ns-ping {
    0% { box-shadow: 0 0 0 0 currentColor; }
    70% { box-shadow: 0 0 0 5px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
}

@keyframes ns-rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
}

@keyframes ns-blink {
    50% { opacity: 0; }
}

/* 1. 左栏：作品与章节目录 */
.ns-book-nav {
    background: var(--ns-bg-panel);
    border-right: 1px solid var(--ns-border-1);
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    transition: opacity 0.2s ease;
}

.ns-left-collapsed .ns-book-nav {
    opacity: 0;
    pointer-events: none;
    border-right-color: transparent;
}

.ns-nav-head {
    height: 48px;
    padding: 0 12px 0 14px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-shrink: 0;
}

.ns-nav-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 10px 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ns-book-card {
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    padding: 9px 11px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
}

.ns-book-card:hover {
    background: var(--ns-bg-surface-2);
    border-color: var(--ns-border-2);
}

.ns-book-card.active {
    border-color: var(--ns-brand-line);
    background: var(--ns-brand-soft);
}

.ns-group-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--ns-text-4);
    padding: 2px 6px 4px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.ns-ch-btn {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    color: var(--ns-text-3);
    padding: 7px 10px 7px 12px;
    border-radius: var(--ns-r-md);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12.5px;
    transition: background 0.12s ease, color 0.12s ease;
}

.ns-ch-btn:hover {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-ch-btn.active {
    background: var(--ns-bg-press);
    border-color: var(--ns-border-2);
    color: var(--ns-text-1);
}

.ns-seal-xs {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: var(--ns-seal);
    color: #fff;
    display: inline-grid;
    place-items: center;
    font: 700 9.5px/1 var(--ns-font-serif);
    flex-shrink: 0;
}

.ns-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
}

.ns-pill-brand { background: var(--ns-brand-soft); color: var(--ns-brand-ink); }
.ns-pill-green { background: var(--ns-green-soft); color: var(--ns-green-ink); }
.ns-pill-amber { background: var(--ns-amber-soft); color: var(--ns-amber-ink); }
.ns-pill-red { background: var(--ns-red-soft); color: var(--ns-red-ink); }
.ns-pill-muted { background: var(--ns-bg-hover); color: var(--ns-text-3); }

/* 2. 中栏：主控台与阅读/编辑区 */
.ns-main,
.ns-center-workbench {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--ns-bg-base);
    position: relative;
}

.ns-topbar {
    height: 46px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--ns-border-1);
    background: var(--ns-bg-base);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-shrink: 0;
    min-width: 0;
    position: relative;
    z-index: 25;
}

.ns-top-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
}

.ns-top-book-select {
    max-width: 220px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--ns-r-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--ns-text-1);
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    outline: none;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
}

.ns-top-book-select:hover {
    background: var(--ns-bg-hover);
    border-color: var(--ns-border-1);
}

.ns-top-book-select option {
    background: var(--ns-bg-surface-2);
    color: var(--ns-text-1);
}

.ns-mode-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    background: var(--ns-bg-hover);
    border: 1px solid var(--ns-border-1);
    font-size: 12px;
    color: var(--ns-text-2);
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
}

.ns-mode-pill:hover {
    background: var(--ns-bg-press);
    border-color: var(--ns-border-2);
}

.ns-seal-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ns-seal);
    flex-shrink: 0;
}

.ns-icon-btn {
    position: relative;
    width: 28px;
    height: 28px;
    border-radius: var(--ns-r-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--ns-text-3);
    display: inline-grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: background 0.12s ease, color 0.12s ease;
}

.ns-icon-btn:hover:not(:disabled) {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-icon-btn.ns-btn-active {
    background: var(--ns-bg-press);
    color: var(--ns-text-1);
}

.ns-icon-btn.ns-btn-dirty {
    color: var(--ns-amber-ink);
}

.ns-icon-btn.ns-btn-halt-alert {
    color: var(--ns-red-ink);
}

.ns-badge-dot {
    position: absolute;
    top: 1px;
    right: 1px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 999px;
    font: 700 9px/14px var(--ns-font-sans);
    text-align: center;
    background: var(--ns-amber);
    color: #1a1200;
}

.ns-badge-dot.ns-badge-red {
    background: var(--ns-red);
    color: #fff;
}

.ns-chapter-badge {
    font-family: var(--ns-font-mono);
    font-size: 12.5px;
    color: var(--ns-text-1);
    white-space: nowrap;
    flex-shrink: 0;
}

.ns-book-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 500;
    color: var(--ns-text-2);
}

.ns-book-slug {
    white-space: nowrap;
    flex-shrink: 0;
    font-size: 11.5px;
    color: var(--ns-text-4);
}

.ns-top-center {
    display: flex;
    align-items: center;
    gap: 8px;
    position: relative;
    flex-shrink: 0;
}

.ns-top-right {
    display: flex;
    align-items: center;
    gap: 6px;
    position: relative;
    flex-shrink: 0;
}

.ns-yolo-running-bar {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.ns-split-btn-wrap {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
}

/* 次级标签条：dsh 同款蓝底线页签 */
.ns-top-2 {
    height: 38px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--ns-border-1);
    background: var(--ns-bg-base);
    position: relative;
    z-index: 20;
}

.ns-dsh-tabs {
    display: flex;
    gap: 6px;
    height: 100%;
}

.ns-dsh-tab {
    position: relative;
    height: 100%;
    padding: 0 6px;
    border: 0;
    background: transparent;
    font-size: 13px;
    color: var(--ns-text-3);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    transition: color 0.15s ease;
}

.ns-dsh-tab:hover:not(:disabled) {
    color: var(--ns-text-1);
}

.ns-dsh-tab.on {
    color: var(--ns-text-1);
    font-weight: 500;
}

.ns-dsh-tab.on::after {
    content: "";
    position: absolute;
    left: 4px;
    right: 4px;
    bottom: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--ns-brand);
}

.ns-tab-count {
    font: 500 10.5px var(--ns-font-mono);
    color: var(--ns-text-4);
}

.ns-top2-spacer {
    flex: 1 1 0;
    min-width: 8px;
}

.ns-top2-right {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}

.ns-thread-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 8px;
    border-radius: var(--ns-r-sm);
    border: 0;
    background: transparent;
    font-size: 11.5px;
    color: var(--ns-text-3);
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
}

.ns-thread-btn:hover,
.ns-thread-btn.open {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-dots {
    display: inline-flex;
    align-items: center;
}

.ns-dt {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.4px var(--ns-border-3);
    position: relative;
    display: inline-block;
}

.ns-dt.done {
    background: var(--ns-green);
    box-shadow: none;
}

.ns-dt.healing {
    background: var(--ns-amber);
    box-shadow: none;
}

.ns-dt.active {
    background: var(--ns-brand);
    box-shadow: none;
}

.ns-dt.active::after {
    content: "";
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 1.5px solid var(--ns-brand);
    animation: ns-ping 1.4s infinite;
}

.ns-dt.halt {
    background: var(--ns-red);
    box-shadow: 0 0 0 2px var(--ns-red-soft);
}

.ns-ln {
    width: 10px;
    height: 1.4px;
    background: var(--ns-border-2);
    display: inline-block;
}

.ns-ln.on {
    background: var(--ns-green);
    opacity: 0.6;
}

.ns-aa-btn {
    font: 600 13px var(--ns-font-serif);
}

.ns-split-btn {
    display: inline-flex;
    border-radius: var(--ns-r-md);
    overflow: hidden;
}

.ns-btn {
    height: 30px;
    padding: 0 10px;
    border-radius: var(--ns-r-md);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    font-size: 12.5px;
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.ns-btn-sm {
    height: 26px;
    padding: 0 9px;
    font-size: 12px;
    border-radius: var(--ns-r-sm);
}

.ns-btn-xs {
    height: 22px;
    padding: 0 7px;
    font-size: 11px;
    border-radius: var(--ns-r-sm);
}

.ns-btn-primary {
    height: 30px;
    background: var(--ns-brand);
    border: 1px solid transparent;
    color: #fff;
    padding: 0 11px;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    border-radius: var(--ns-r-md);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.15s ease, opacity 0.15s ease;
}

.ns-btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ns-brand) 86%, #fff);
}

.ns-split-btn .ns-btn-primary {
    border-radius: var(--ns-r-md) 0 0 var(--ns-r-md);
}

.ns-btn-primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ns-btn-yolo {
    height: 30px;
    background: var(--ns-brand);
    border: 1px solid transparent;
    box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.24);
    color: #fff;
    padding: 0 9px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 0 var(--ns-r-md) var(--ns-r-md) 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.15s ease;
}

.ns-btn-yolo:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ns-brand) 86%, #fff);
}

.ns-btn-ghost {
    height: 30px;
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    border-radius: var(--ns-r-md);
    padding: 0 10px;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.ns-btn-ghost.ns-btn-sm {
    height: 26px;
    padding: 0 9px;
    font-size: 12px;
    border-radius: var(--ns-r-sm);
}

.ns-btn-ghost.ns-btn-xs {
    height: 22px;
    padding: 0 7px;
    font-size: 11px;
    border-radius: var(--ns-r-sm);
}

.ns-btn-ghost:hover:not(:disabled) {
    background: var(--ns-bg-surface-2);
    border-color: var(--ns-border-3);
}

.ns-btn-ghost:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ns-btn-ghost.ns-btn-active {
    border-color: var(--ns-brand-line);
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
}

.ns-btn-ghost.dirty,
.ns-btn-ghost.ns-btn-dirty {
    border-color: var(--ns-amber-line);
    color: var(--ns-amber-ink);
    background: var(--ns-amber-soft);
}

.ns-btn-ghost.ns-btn-halt-alert {
    border-color: var(--ns-red-line);
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
    box-shadow: 0 0 0 1px var(--ns-red-line);
}

.ns-btn-stop {
    height: 30px;
    background: var(--ns-red-soft);
    border: 1px solid var(--ns-red-line);
    color: var(--ns-red-ink);
    border-radius: var(--ns-r-md);
    padding: 0 10px;
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    flex-shrink: 0;
}

.ns-popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 300px;
    background: var(--ns-bg-surface-2);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-lg);
    padding: 14px;
    box-shadow: var(--ns-pop-shadow);
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ns-pop-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-pop-input {
    width: 64px;
    height: 26px;
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    border-radius: var(--ns-r-sm);
    padding: 0 6px;
    font: 12px var(--ns-font-mono);
    text-align: center;
}

/* 6 阶段单行紧凑胶囊流水线（默认整体高度 <= 44px，点击才展开详情条） */
.ns-stage-strip {
    background: var(--ns-bg-panel);
    border-bottom: 1px solid var(--ns-border-1);
    padding: 6px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
}

.ns-pipeline-graph {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 30px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
}

.ns-pipeline-graph::-webkit-scrollbar {
    display: none;
}

.ns-stage-node {
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    color: var(--ns-text-2);
    font-size: 11.5px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.ns-stage-node:hover {
    border-color: var(--ns-border-2);
    color: var(--ns-text-1);
}

.ns-stage-node.ns-selected {
    box-shadow: 0 0 0 1px var(--ns-brand);
    border-color: var(--ns-brand-line);
}

.ns-stage-node.ns-stage-done {
    border-color: color-mix(in srgb, var(--ns-green) 42%, transparent);
}

.ns-stage-node.ns-stage-active {
    border-color: var(--ns-brand-line);
    background: var(--ns-brand-soft);
    color: var(--ns-text-1);
}

.ns-stage-node.ns-stage-healing {
    border-color: var(--ns-amber-line);
    background: var(--ns-amber-soft);
}

.ns-stage-node.ns-stage-halt {
    border-color: var(--ns-red-line);
    background: var(--ns-red-soft);
}

.ns-stage-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--ns-text-4);
}

.ns-dot-done {
    background: var(--ns-green);
}

.ns-dot-active {
    background: var(--ns-brand);
    color: var(--ns-brand);
    animation: ns-ping 1.4s infinite;
}

.ns-dot-healing {
    background: var(--ns-amber);
}

.ns-dot-halt {
    background: var(--ns-red);
}

.ns-stage-label {
    white-space: nowrap;
}

.ns-stage-status {
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 999px;
    line-height: 1.3;
    white-space: nowrap;
}

.ns-badge-brand {
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
}

.ns-badge-green {
    background: var(--ns-green-soft);
    color: var(--ns-green-ink);
}

.ns-badge-amber {
    background: var(--ns-amber-soft);
    color: var(--ns-amber-ink);
}

.ns-badge-red {
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
}

.ns-badge-muted {
    background: var(--ns-bg-hover);
    color: var(--ns-text-3);
}

.ns-stage-arrow {
    color: var(--ns-text-4);
    font-size: 12px;
    flex-shrink: 0;
    user-select: none;
}

.ns-stage-inspector {
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-sm);
    padding: 8px 12px;
    font-size: 11.5px;
    color: var(--ns-text-3);
}

.ns-inspector-main {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 100%;
}

.ns-inspector-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--ns-text-1);
}

.ns-inspector-io {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    line-height: 1.5;
}

/* 主阅读区切换栏与正稿排版 */
.ns-view-bar {
    padding: 8px 20px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
}

.ns-view-tabs {
    display: inline-flex;
    background: var(--ns-bg-panel);
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    padding: 2px;
    gap: 2px;
    flex-shrink: 0;
}

.ns-view-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
    flex-shrink: 0;
}

.ns-chapter-select {
    width: auto;
    max-width: 240px;
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
}

.ns-vtab {
    background: transparent;
    border: none;
    color: var(--ns-text-3);
    padding: 4px 12px;
    border-radius: var(--ns-r-sm);
    font-size: 12px;
    cursor: pointer;
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.15s ease, color 0.15s ease;
}

.ns-vtab:hover {
    color: var(--ns-text-1);
}

.ns-vtab.active,
.ns-vtab.ns-active {
    background: var(--ns-bg-card);
    color: var(--ns-text-1);
}

.ns-stage-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 24px 36px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    scroll-behavior: smooth;
}

/* 居中 660px 舒适衬线体阅读栏 */
.ns-prose-col {
    width: 100%;
    max-width: var(--ns-col);
    margin: 0 auto;
    padding: 20px 0 48px;
}

.ns-prose-col > * {
    animation: ns-rise 0.28s var(--ns-ease) both;
}

/* 章节头与大号半透明章号 */
.ns-chap-header {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 22px;
    align-items: center;
    margin-bottom: 36px;
}

.ns-chap-numeral {
    font: 200 84px/0.82 var(--ns-font-display);
    letter-spacing: -0.05em;
    color: var(--ns-numeral);
    padding-right: 22px;
    border-right: 1px solid var(--ns-border-2);
    user-select: none;
}

.ns-chap-kick {
    font-size: 11.5px;
    color: var(--ns-text-4);
    letter-spacing: 0.04em;
}

.ns-chap-header h1 {
    font: 700 28px/1.3 var(--ns-font-serif);
    letter-spacing: 0.02em;
    color: var(--ns-text-1);
    margin: 5px 0 8px;
}

.ns-chap-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 14px;
    font-size: 12px;
    color: var(--ns-text-3);
}

.ns-prose {
    font-family: var(--ns-font-serif);
    font-size: var(--ns-fs, 17px);
    line-height: 2;
    color: var(--ns-prose);
    letter-spacing: 0.012em;
}

.ns-prose p {
    text-indent: 2em;
    margin: 0 0 0.9em;
    position: relative;
}

.ns-brk {
    text-align: center;
    text-indent: 0 !important;
    color: var(--ns-text-4);
    letter-spacing: 0.8em;
    font-size: 13px;
    margin: 1.4em 0 !important;
}

.ns-caret {
    display: inline-block;
    width: 2px;
    height: 1.1em;
    margin-left: 2px;
    vertical-align: -0.18em;
    background: var(--ns-brand);
    animation: ns-blink 1.05s steps(1) infinite;
}

.ns-livebar {
    margin-top: 26px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--ns-brand-ink);
}

.ns-livebar .ns-prog-bar {
    flex: 0 0 130px;
    height: 3px;
    margin-top: 0;
    background: var(--ns-brand-soft);
}

/* 章末朱印「定稿」印章 */
.ns-endmark {
    margin-top: 52px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
}

.ns-stamp {
    width: 56px;
    height: 56px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    transform: rotate(-4deg);
    color: var(--ns-seal);
    border: 2px solid var(--ns-seal);
    box-shadow: inset 0 0 0 3px var(--ns-bg-base), inset 0 0 0 4.5px var(--ns-seal);
    font: 700 16px/1.05 var(--ns-font-serif);
    letter-spacing: 0.08em;
    background: var(--ns-seal-soft);
    user-select: none;
}

.ns-endmark small {
    font: 10.5px var(--ns-font-mono);
    color: var(--ns-text-4);
}

/* 细纲节拍比例条 */
.ns-beats {
    display: flex;
    gap: 4px;
    height: 60px;
    margin-bottom: 6px;
}

.ns-beat {
    border-radius: var(--ns-r-md);
    padding: 9px 11px;
    background: var(--ns-bg-hover);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-width: 0;
}

.ns-beat b {
    font: 600 11px var(--ns-font-mono);
    color: var(--ns-text-3);
}

.ns-beat span {
    font-size: 12px;
    color: var(--ns-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ns-beat.eye {
    background: var(--ns-brand-soft);
    box-shadow: inset 0 0 0 1px var(--ns-brand-line);
}

.ns-beat.eye b {
    color: var(--ns-brand-ink);
}

.ns-beats-cap {
    display: flex;
    justify-content: space-between;
    font: 10.5px var(--ns-font-mono);
    color: var(--ns-text-4);
    margin-bottom: 24px;
}

.ns-alert-box {
    position: relative;
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    border-left: 3px solid var(--ns-red);
    border-radius: var(--ns-r-xl);
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ns-alert-box.warn {
    border-left-color: var(--ns-amber);
}

.ns-alert-box.boot {
    border-left-color: var(--ns-brand);
}

.ns-choice-btn {
    text-align: left;
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    padding: 10px 13px;
    border-radius: var(--ns-r-lg);
    cursor: pointer;
    font-size: 12.5px;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.ns-choice-btn:hover {
    border-color: var(--ns-border-3);
    background: var(--ns-bg-hover);
}

.ns-choice-btn.picked {
    border-color: var(--ns-green);
    background: var(--ns-green-soft);
}

.ns-paper {
    width: 100%;
    max-width: var(--ns-col);
    margin: 0 auto;
    background: transparent;
    border: none;
    padding: 12px 0 40px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ns-paper-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--ns-border-1);
    padding-bottom: 12px;
    gap: 10px;
}

.ns-paper-text {
    font-family: var(--ns-font-serif);
    font-size: var(--ns-fs, 17px);
    line-height: 2;
    letter-spacing: 0.012em;
    white-space: pre-wrap;
    color: var(--ns-prose);
    word-break: break-word;
}

.ns-editor-textarea {
    width: 100%;
    min-height: 440px;
    background: transparent;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    padding: 16px 18px;
    color: var(--ns-prose);
    font-family: var(--ns-font-serif);
    font-size: var(--ns-fs, 17px);
    line-height: 2;
    letter-spacing: 0.012em;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s ease;
}

.ns-editor-textarea:focus {
    border-color: var(--ns-brand-line);
}

.ns-patch-mark {
    background: linear-gradient(transparent 64%, var(--ns-amber-soft) 64%);
    box-shadow: 0 1.5px 0 0 var(--ns-amber-line);
    padding: 1px 2px;
    border-radius: 2px;
}

.ns-err-mark {
    background: var(--ns-red-soft);
    box-shadow: 0 1.5px 0 0 var(--ns-red);
    padding: 1px 2px;
    border-radius: 2px;
}

.ns-diff-add {
    background: var(--ns-green-soft);
    color: var(--ns-green-ink);
    padding: 3px 10px;
    border-radius: 4px;
    display: block;
}

.ns-diff-del {
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
    padding: 3px 10px;
    border-radius: 4px;
    display: block;
    text-decoration: line-through;
}

/* 底部悬浮圆角导演信号栏（dsh 原生圆角输入卡风格） */
.ns-composer-dock {
    background: var(--ns-bg-base);
    padding: 6px 24px 10px;
    flex-shrink: 0;
}

.ns-composer-wrap {
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-queue {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.ns-qslip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 24px;
    padding: 0 4px 0 9px;
    border-radius: 999px;
    font-size: 11.5px;
    color: var(--ns-text-2);
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-2);
    max-width: 100%;
}

.ns-qslip-ty {
    font: 600 10.5px var(--ns-font-sans);
    color: var(--ns-brand-ink);
    white-space: nowrap;
}

.ns-qslip-tx {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ns-qslip-del {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 0;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--ns-text-4);
    cursor: pointer;
    flex-shrink: 0;
}

.ns-qslip-del:hover {
    background: var(--ns-bg-hover);
    color: var(--ns-red-ink);
}

.ns-composer-box {
    border-radius: 16px;
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-2);
    padding: 10px 10px 8px 14px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ns-composer-box:focus-within {
    border-color: var(--ns-brand-line);
    box-shadow: 0 0 0 3px var(--ns-brand-soft);
}

.ns-composer-input {
    width: 100%;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--ns-text-1);
    font-size: 13.5px;
    padding: 2px 0 10px;
}

.ns-composer-input::placeholder {
    color: var(--ns-text-4);
}

.ns-composer-bar {
    display: flex;
    align-items: center;
    gap: 6px;
}

.ns-composer-sp {
    flex: 1;
}

.ns-pill-sel {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--ns-bg-hover);
    font-size: 12px;
    color: var(--ns-text-2);
    white-space: nowrap;
}

.ns-pill-sel select {
    border: 0;
    outline: none;
    background: transparent;
    color: var(--ns-text-2);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
}

.ns-pill-sel select option {
    background: var(--ns-bg-surface-2);
    color: var(--ns-text-1);
}

.ns-send-circle {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 0;
    background: var(--ns-brand);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    display: grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s ease, opacity 0.15s ease;
}

.ns-send-circle:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ns-brand) 86%, #fff);
}

.ns-send-circle:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ns-composer-telemetry {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 4px 10px;
    font: 11px var(--ns-font-mono);
    color: var(--ns-text-4);
}

.ns-composer-telemetry button {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 1px 4px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
}

.ns-composer-telemetry button:hover {
    background: var(--ns-bg-hover);
    color: var(--ns-text-2);
}

.ns-tel-sep {
    opacity: 0.45;
}

/* 3. 右侧三页签辅助栏（目录 / 检查器 / 工具） */
.ns-right {
    background: var(--ns-bg-panel);
    border-left: 1px solid var(--ns-border-1);
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    transition: opacity 0.2s ease, transform 0.24s var(--ns-ease);
}

.ns-right-closed .ns-right {
    opacity: 0;
    pointer-events: none;
    border-left-color: transparent;
}

.ns-narrow.ns-right-open .ns-right {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 332px;
    max-width: 90vw;
    z-index: 45;
    border-left: 1px solid var(--ns-border-2);
    box-shadow: var(--ns-pop-shadow);
    opacity: 1;
    pointer-events: auto;
}

.ns-r-head {
    height: 46px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 10px 0 12px;
    border-bottom: 1px solid var(--ns-border-1);
}

.ns-r-tabs {
    display: flex;
    gap: 2px;
    flex: 1;
    min-width: 0;
}

.ns-r-tab {
    height: 30px;
    padding: 0 10px;
    border-radius: var(--ns-r-sm);
    border: 0;
    background: transparent;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--ns-text-3);
    white-space: nowrap;
    cursor: pointer;
    position: relative;
    transition: background 0.12s ease, color 0.12s ease;
}

.ns-r-tab:hover {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-r-tab.on {
    background: var(--ns-bg-press);
    color: var(--ns-text-1);
    font-weight: 500;
}

.ns-r-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ns-amber);
}

.ns-r-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 12px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.ns-right .ns-ops-inspector {
    width: 100%;
    border-left: none;
    background: transparent;
}

.ns-right .ns-right-head {
    display: none;
}

.ns-right .ns-right-scroll {
    padding: 0;
}

.ns-toc-embedded {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.ns-views-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
}

.ns-vtile {
    padding: 10px 8px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.ns-vtile:hover,
.ns-vtile.ns-active {
    border-color: var(--ns-brand-line);
    background: var(--ns-bg-surface-2);
}

.ns-vtile b {
    display: block;
    font: 600 16px var(--ns-font-mono);
    color: var(--ns-text-1);
}

.ns-vtile span {
    font-size: 11px;
    color: var(--ns-text-4);
    white-space: nowrap;
}

.ns-vtile-warped b {
    color: var(--ns-violet);
}

.ns-tool-cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ns-tool-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: var(--ns-r-lg);
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    text-align: left;
    color: var(--ns-text-1);
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.ns-tool-card:hover:not(:disabled) {
    border-color: var(--ns-border-2);
    background: var(--ns-bg-surface-2);
}

.ns-tool-card:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.ns-tool-card-danger .ns-tool-icon {
    color: var(--ns-red-ink);
}

.ns-tool-icon {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    font-size: 15px;
    color: var(--ns-brand-ink);
    flex-shrink: 0;
}

.ns-tool-card b {
    display: block;
    font-size: 13px;
    font-weight: 500;
}

.ns-tool-card small {
    display: block;
    font-size: 11px;
    color: var(--ns-text-4);
    margin-top: 2px;
}

.ns-pool-card {
    padding: 12px 14px;
    border-radius: var(--ns-r-lg);
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ns-pool-card-title {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ns-text-3);
}

.ns-pool-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
}

.ns-pool-item b {
    display: block;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-pool-item small {
    display: block;
    font-size: 10.5px;
    color: var(--ns-text-4);
}

.ns-pool-item > span {
    font-size: 11px;
    color: var(--ns-brand-ink);
    white-space: nowrap;
}

.ns-right-head {
    height: 48px;
    padding: 0 12px 0 14px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    font-size: 12.5px;
    flex-shrink: 0;
}

.ns-right-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 14px 14px 28px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

details.ns-acc {
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-lg);
    overflow: hidden;
}

details.ns-acc summary {
    list-style: none;
    cursor: pointer;
    padding: 9px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    font-size: 12px;
    user-select: none;
    transition: background 0.12s ease;
}

details.ns-acc summary:hover {
    background: var(--ns-bg-hover);
}

details.ns-acc[open] summary {
    border-bottom: 1px solid var(--ns-border-1);
}

.ns-acc-body {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-kv-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    border-radius: var(--ns-r-md);
    overflow: hidden;
    background: var(--ns-border-1);
    border: 1px solid var(--ns-border-1);
}

.ns-metric {
    background: var(--ns-bg-card);
    padding: 9px 11px;
}

.ns-metric-k {
    font-size: 11px;
    color: var(--ns-text-4);
}

.ns-metric-v {
    font: 500 15px var(--ns-font-mono);
    color: var(--ns-text-1);
    margin-top: 2px;
}

.ns-row-item {
    border-top: 1px solid var(--ns-border-1);
    padding-top: 7px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ns-row-item:first-child {
    border-top: none;
    padding-top: 0;
}

.ns-prog-bar {
    height: 4px;
    background: var(--ns-border-1);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 5px;
}

.ns-prog-fill {
    height: 100%;
    background: var(--ns-brand);
    transition: width 0.3s ease;
}

.ns-gate-toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11.5px;
}

/* 开新书弹窗与消息提示 */
.ns-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(8, 9, 12, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 16px;
}

.ns-modal {
    width: 100%;
    max-width: 520px;
    background: var(--ns-bg-surface-2);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-xl);
    box-shadow: var(--ns-pop-shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.ns-modal-head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    font-size: 13.5px;
}

.ns-modal-body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 75vh;
    overflow-y: auto;
}

.ns-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-input,
.ns-textarea,
.ns-select {
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    border-radius: var(--ns-r-md);
    padding: 8px 11px;
    font-size: 12.5px;
    outline: none;
    width: 100%;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ns-textarea {
    min-height: 84px;
    resize: vertical;
    font-family: inherit;
}

.ns-input:focus,
.ns-textarea:focus,
.ns-select:focus {
    border-color: var(--ns-brand-line);
    box-shadow: 0 0 0 3px var(--ns-brand-soft);
}

.ns-modal-foot {
    padding: 12px 18px;
    border-top: 1px solid var(--ns-border-1);
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.ns-toast {
    position: fixed;
    bottom: 18px;
    right: 20px;
    background: var(--ns-bg-surface-2);
    border: 1px solid var(--ns-brand-line);
    color: var(--ns-text-1);
    padding: 8px 14px;
    border-radius: var(--ns-r-md);
    font-size: 12px;
    z-index: 60;
    box-shadow: var(--ns-pop-shadow);
}
`;

/**
 * 幂等向 document.head 注入 Operator Studio 样式标签
 */
export function ensureStudioStyles(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STUDIO_STYLE_ELEMENT_ID)) return;

    const styleEl = document.createElement('style');
    styleEl.id = STUDIO_STYLE_ELEMENT_ID;
    styleEl.textContent = STUDIO_CSS;
    document.head.appendChild(styleEl);
}

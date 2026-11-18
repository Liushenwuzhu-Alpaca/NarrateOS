/**
 * NarrateOS Operator Studio 视觉样式层
 * - 100% 对齐 @deepseek-ai/dsh-client-ui-theme 设计令牌与 docs/dsh-studio-prototype.html 排版细节
 * - 所有 CSS 变量与选择器均使用 ns- 作用域前缀，避免污染 DSH 宿主全局样式
 * - 支持宿主明暗主题：宿主暗色时挂载 data-ds-dark-theme，亮色时无该属性；
 *   同时保留 [data-theme="light"] 独立预览覆盖
 */

import { INSPECTOR_CSS } from './inspector-styles';
import { BOOT_CSS } from './boot-styles';

export const STUDIO_STYLE_ELEMENT_ID = 'narrateos-studio-styles';

export const STUDIO_CSS = `
.ns-studio-shell {
    color-scheme: dark;
    --ns-bg-outer: #0c0d0f;
    --ns-bg-host: #121316;
    --ns-bg-side: #16171a;
    --ns-bg-stage: #1a1b1e;
    --ns-bg-sheet: #1f2024;
    --ns-bg-elevated: #26282d;
    --ns-bg-base: var(--ns-bg-stage);
    --ns-bg-panel: var(--ns-bg-side);
    --ns-bg-card: var(--ns-bg-sheet);
    --ns-bg-surface-2: var(--ns-bg-elevated);
    --ns-bg-hover: rgba(255, 255, 255, 0.052);
    --ns-bg-press: rgba(255, 255, 255, 0.09);
    --ns-border-1: rgba(255, 255, 255, 0.068);
    --ns-border-2: rgba(255, 255, 255, 0.125);
    --ns-border-3: rgba(255, 255, 255, 0.22);
    --ns-text-1: #f3f2ee;
    --ns-text-2: #c8c6bf;
    --ns-text-3: #98968f;
    --ns-text-4: #98968f;
    --ns-numeral: #575853;
    --ns-prose: #e6e2d8;
    --ns-brand: #4c7cf0;
    --ns-brand-ink: #96b6ff;
    --ns-brand-soft: rgba(76, 124, 240, 0.14);
    --ns-brand-line: rgba(76, 124, 240, 0.4);
    --ns-brand-fill: #3762cc;
    --ns-brand-fill-hover: #436fd9;
    --ns-green: #46c978;
    --ns-green-ink: #6ee098;
    --ns-green-soft: rgba(70, 201, 120, 0.14);
    --ns-amber: #eba434;
    --ns-amber-ink: #f5be62;
    --ns-amber-soft: rgba(235, 164, 52, 0.13);
    --ns-amber-line: rgba(235, 164, 52, 0.38);
    --ns-red: #e86565;
    --ns-red-ink: #f59393;
    --ns-red-soft: rgba(232, 101, 101, 0.12);
    --ns-red-line: rgba(232, 101, 101, 0.38);
    --ns-violet: #96b6ff;
    --ns-violet-soft: rgba(76, 124, 240, 0.14);
    /* 品牌朱砂印仅用于书稿「定稿」钤印与顶部阅读进度丝带，不承担告警语义 */
    --ns-seal: #df6447;
    --ns-seal-soft: rgba(223, 100, 71, 0.11);
    --ns-scrim: rgba(0, 0, 0, 0.44);
    --ns-shadow-sheet: 0 6px 24px rgba(0, 0, 0, 0.14);
    --ns-shadow-float: 0 16px 40px rgba(0, 0, 0, 0.44), 0 2px 8px rgba(0, 0, 0, 0.24);
    --ns-shadow-dock: 0 10px 30px rgba(0, 0, 0, 0.34);
    --ns-pop-shadow: var(--ns-shadow-float);
    --ns-col: 672px;
    --ns-r-xs: 5px;
    --ns-r-sm: 7px;
    --ns-r-md: 9px;
    --ns-r-lg: 11px;
    --ns-r-sheet: 12px;
    --ns-r-xl: 12px;
    --ns-r-pill: 999px;
    --ns-ease: cubic-bezier(0.16, 1, 0.3, 1);
    --ns-ease-layout: cubic-bezier(0.2, 0.7, 0.2, 1);
    --ns-font-sans: Inter, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif;
    --ns-font-serif: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif;
    --ns-font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    --ns-font-display: Inter, "PingFang SC", system-ui, sans-serif;

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

/* 亮色主题变量适配：宿主亮色（body 无 data-ds-dark-theme）与独立预览 [data-theme="light"] 共用暖白纸感方案 */
[data-theme="light"] .ns-studio-shell,
.ns-studio-shell[data-theme="light"],
body:not([data-ds-dark-theme]) .ns-studio-shell {
    color-scheme: light;
    --ns-bg-outer: #e4dfd5;
    --ns-bg-host: #ece8df;
    --ns-bg-side: #f2efe7;
    --ns-bg-stage: #f8f5ee;
    --ns-bg-sheet: #fcfbf7;
    --ns-bg-elevated: #ffffff;
    --ns-bg-base: var(--ns-bg-stage);
    --ns-bg-panel: var(--ns-bg-side);
    --ns-bg-card: var(--ns-bg-sheet);
    --ns-bg-surface-2: var(--ns-bg-elevated);
    --ns-bg-hover: rgba(32, 28, 22, 0.048);
    --ns-bg-press: rgba(32, 28, 22, 0.085);
    --ns-border-1: rgba(32, 28, 22, 0.08);
    --ns-border-2: rgba(32, 28, 22, 0.14);
    --ns-border-3: rgba(32, 28, 22, 0.24);
    --ns-text-1: #1e1c18;
    --ns-text-2: #48443d;
    --ns-text-3: #68635a;
    --ns-text-4: #68635a;
    --ns-numeral: #bdb5a7;
    --ns-prose: #26231e;
    --ns-brand: #3566d6;
    --ns-brand-ink: #2450b5;
    --ns-brand-soft: rgba(53, 102, 214, 0.11);
    --ns-brand-line: rgba(53, 102, 214, 0.36);
    --ns-brand-fill: #2f5ec9;
    --ns-brand-fill-hover: #2650b2;
    --ns-green: #1f9952;
    --ns-green-ink: #16703b;
    --ns-green-soft: rgba(31, 153, 82, 0.12);
    --ns-amber: #cc7408;
    --ns-amber-ink: #8a4b03;
    --ns-amber-soft: rgba(204, 116, 8, 0.11);
    --ns-amber-line: rgba(204, 116, 8, 0.36);
    --ns-red: #cf4242;
    --ns-red-ink: #a12525;
    --ns-red-soft: rgba(207, 66, 66, 0.09);
    --ns-red-line: rgba(207, 66, 66, 0.35);
    --ns-violet: #2450b5;
    --ns-violet-soft: rgba(53, 102, 214, 0.11);
    --ns-seal: #c4452b;
    --ns-seal-soft: rgba(196, 69, 43, 0.08);
    --ns-shadow-sheet: 0 6px 22px rgba(36, 30, 20, 0.06);
    --ns-shadow-float: 0 16px 38px rgba(36, 30, 20, 0.13), 0 2px 8px rgba(36, 30, 20, 0.06);
    --ns-shadow-dock: 0 8px 26px rgba(36, 30, 20, 0.08);
    --ns-pop-shadow: var(--ns-shadow-float);
}

/* 亮色下阶段点链与连线加重,避免浅底上几乎不可见 */
body:not([data-ds-dark-theme]) .ns-studio-shell .ns-dt {
    box-shadow: inset 0 0 0 1.4px var(--ns-text-4);
}

body:not([data-ds-dark-theme]) .ns-studio-shell .ns-dt.done,
body:not([data-ds-dark-theme]) .ns-studio-shell .ns-dt.healing,
body:not([data-ds-dark-theme]) .ns-studio-shell .ns-dt.active,
body:not([data-ds-dark-theme]) .ns-studio-shell .ns-dt.halt {
    box-shadow: none;
}

body:not([data-ds-dark-theme]) .ns-studio-shell .ns-ln {
    background: var(--ns-border-3);
}

body:not([data-ds-dark-theme]) .ns-studio-shell .ns-ln.on {
    background: var(--ns-text-4);
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
    border-radius: var(--ns-r-sm);
    border: 2px solid transparent;
    background-clip: content-box;
}

.ns-studio-shell ::-webkit-scrollbar-track {
    background: transparent;
}

/* 主要滚动容器统一细滚动条（轨道透明、拇指用边框 token） */
.ns-nav-scroll,
.ns-stage-body,
.ns-prose-col,
.ns-paper,
.ns-queue,
.ns-r-body,
.ns-right-scroll {
    scrollbar-width: thin;
    scrollbar-color: var(--ns-border-2) transparent;
}

.ns-nav-scroll::-webkit-scrollbar,
.ns-stage-body::-webkit-scrollbar,
.ns-prose-col::-webkit-scrollbar,
.ns-paper::-webkit-scrollbar,
.ns-queue::-webkit-scrollbar,
.ns-r-body::-webkit-scrollbar,
.ns-right-scroll::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

.ns-nav-scroll::-webkit-scrollbar-thumb,
.ns-stage-body::-webkit-scrollbar-thumb,
.ns-prose-col::-webkit-scrollbar-thumb,
.ns-paper::-webkit-scrollbar-thumb,
.ns-queue::-webkit-scrollbar-thumb,
.ns-r-body::-webkit-scrollbar-thumb,
.ns-right-scroll::-webkit-scrollbar-thumb {
    background: var(--ns-border-2);
    border-radius: var(--ns-r-sm);
    border: 1px solid transparent;
    background-clip: content-box;
}

.ns-nav-scroll::-webkit-scrollbar-track,
.ns-stage-body::-webkit-scrollbar-track,
.ns-prose-col::-webkit-scrollbar-track,
.ns-paper::-webkit-scrollbar-track,
.ns-queue::-webkit-scrollbar-track,
.ns-r-body::-webkit-scrollbar-track,
.ns-right-scroll::-webkit-scrollbar-track {
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
    font-size: 13px;
    transition: background 0.12s ease, color 0.12s ease;
}

.ns-ch-btn.active {
    background: var(--ns-bg-press);
    border-color: var(--ns-border-2);
    color: var(--ns-text-1);
}

.ns-seal-xs {
    width: 16px;
    height: 16px;
    border-radius: var(--ns-r-xs);
    background: var(--ns-seal);
    color: #ffffff;
    display: inline-grid;
    place-items: center;
    font: 500 9.5px/1 var(--ns-font-serif);
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
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    outline: none;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 1;
}

.ns-top-book-select option {
    background: var(--ns-bg-surface-2);
    color: var(--ns-text-1);
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
    font-size: 11px;
    font-weight: 500;
    line-height: 14px;
    text-align: center;
    background: var(--ns-amber);
    color: var(--ns-bg-outer);
}

.ns-badge-dot.ns-badge-red {
    background: var(--ns-red);
    color: #ffffff;
}

.ns-chapter-badge {
    font-family: var(--ns-font-mono);
    font-size: 13px;
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
    font-size: 12px;
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
    border-radius: var(--ns-r-xs);
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
    font-size: 12px;
    color: var(--ns-text-3);
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
}

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
    font: 500 13px var(--ns-font-serif);
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
    font-size: 13px;
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
    height: 24px;
    padding: 0 7px;
    font-size: 11px;
    border-radius: var(--ns-r-sm);
}

.ns-btn-primary {
    height: 30px;
    background: var(--ns-brand-fill);
    border: 1px solid transparent;
    color: #ffffff;
    padding: 0 11px;
    font-size: 13px;
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

.ns-split-btn .ns-btn-primary {
    border-radius: var(--ns-r-md) 0 0 var(--ns-r-md);
}

.ns-btn-primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ns-btn-yolo {
    height: 30px;
    background: var(--ns-brand-fill);
    border: 1px solid transparent;
    box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.24);
    color: #ffffff;
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

.ns-btn-ghost {
    height: 30px;
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    border-radius: var(--ns-r-md);
    padding: 0 10px;
    font-size: 13px;
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
    height: 24px;
    padding: 0 7px;
    font-size: 11px;
    border-radius: var(--ns-r-sm);
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
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
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

.ns-stage-node.ns-stage-dormant {
    border-style: dashed;
    border-color: var(--ns-border-2);
    background: transparent;
    color: var(--ns-text-4);
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

.ns-dot-dormant {
    background: transparent;
    box-shadow: inset 0 0 0 1.4px var(--ns-border-3);
}

.ns-dt.dormant {
    box-shadow: inset 0 0 0 1.4px var(--ns-border-2);
}

.ns-stage-label {
    white-space: nowrap;
}

.ns-stage-status {
    font-size: 11px;
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
    font-size: 12px;
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
    padding: 20px 0 120px;
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
    font-size: 12px;
    color: var(--ns-text-4);
    letter-spacing: 0.04em;
}

.ns-chap-header h1 {
    font: 500 28px/1.3 var(--ns-font-serif);
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
    border-radius: var(--ns-r-sm);
    display: grid;
    place-items: center;
    transform: rotate(-4deg);
    color: var(--ns-seal);
    border: 2px solid var(--ns-seal);
    box-shadow: inset 0 0 0 3px var(--ns-bg-base), inset 0 0 0 4.5px var(--ns-seal);
    font: 500 16px/1.05 var(--ns-font-serif);
    letter-spacing: 0.08em;
    background: var(--ns-seal-soft);
    user-select: none;
}

.ns-endmark small {
    font: 10.5px var(--ns-font-mono);
    color: var(--ns-text-4);
}

/* SAFE_HALT / Sync 双栏对比裁决卡 */
.ns-verdict {
    position: relative;
    margin-bottom: 36px;
    padding: 24px 26px 22px;
    border-radius: var(--ns-r-xl);
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    overflow: hidden;
}

.ns-verdict-red {
    --ns-v: var(--ns-red);
    --ns-v-ink: var(--ns-red-ink);
    --ns-v-soft: var(--ns-red-soft);
    border-color: var(--ns-red-line);
}

.ns-verdict-amber {
    --ns-v: var(--ns-amber);
    --ns-v-ink: var(--ns-amber-ink);
    --ns-v-soft: var(--ns-amber-soft);
    border-color: var(--ns-amber-line);
}

.ns-v-eye {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 500;
    color: var(--ns-v-ink);
}

.ns-v-pd {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
    animation: ns-ping 1.4s infinite;
}

.ns-v-tag {
    margin-left: auto;
    font: 500 11px var(--ns-font-mono);
    color: var(--ns-text-4);
    padding: 2px 7px;
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-1);
}

.ns-verdict h2 {
    font: 500 20px/1.5 var(--ns-font-serif);
    color: var(--ns-text-1);
    margin: 10px 0 8px;
}

.ns-v-sub {
    margin: 0;
    font-size: 13px;
    color: var(--ns-text-3);
    line-height: 1.7;
}

.ns-v-sub b {
    color: var(--ns-text-1);
    font-family: var(--ns-font-mono);
}

.ns-v-ev {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 16px 0 18px;
}

.ns-v-ev figure {
    margin: 0;
    padding: 12px 14px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-1);
    min-width: 0;
}

.ns-v-ev figcaption {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font: 11px var(--ns-font-mono);
    color: var(--ns-text-4);
    margin-bottom: 6px;
}

.ns-v-ev figcaption b {
    color: var(--ns-v-ink);
}

.ns-v-ev blockquote {
    margin: 0;
    font: 14px/1.85 var(--ns-font-serif);
    color: var(--ns-prose);
    word-break: break-word;
}

.ns-v-ev mark {
    background: var(--ns-v-soft);
    color: inherit;
    box-shadow: 0 1.5px 0 var(--ns-v);
    padding: 0 2px;
    border-radius: var(--ns-r-xs);
}

.ns-v-ev mark.ns-add {
    background: var(--ns-green-soft);
    box-shadow: 0 1.5px 0 var(--ns-green);
}

.ns-v-issue-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-v-issue-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.ns-v-issue-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font: 11px var(--ns-font-mono);
    color: var(--ns-text-4);
}

.ns-v-issue-meta b {
    color: var(--ns-v-ink);
}

.ns-v-acts {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 10px;
}

.ns-v-opt {
    display: flex;
    gap: 11px;
    align-items: flex-start;
    text-align: left;
    padding: 12px 14px;
    border-radius: var(--ns-r-lg);
    border: 1px solid var(--ns-border-2);
    background: var(--ns-bg-base);
    color: var(--ns-text-1);
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease, opacity 0.15s ease;
}

.ns-v-opt:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.ns-v-opt-ico {
    font-size: 14px;
    line-height: 1.3;
    flex-shrink: 0;
    color: var(--ns-text-3);
}

.ns-v-opt b {
    display: block;
    font-size: 13px;
    font-weight: 500;
}

.ns-v-opt small {
    display: block;
    font-size: 12px;
    color: var(--ns-text-4);
    margin-top: 2px;
    line-height: 1.45;
}

.ns-v-opt.ns-go {
    background: var(--ns-brand-fill);
    border-color: var(--ns-brand-fill);
    color: #ffffff;
}

.ns-v-opt.ns-go .ns-v-opt-ico,
.ns-v-opt.ns-go small {
    color: rgba(255, 255, 255, 0.84);
}

/* 填充底上的图标与副文案用纯白: 0.96 透明度在浅色基态不足 4.5:1, 层级改由字号承担 */
.ns-studio-shell .ns-v-opt.ns-go .ns-v-opt-ico,
.ns-studio-shell .ns-v-opt.ns-go small {
    color: #ffffff;
}

.ns-v-more {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 12px;
    color: var(--ns-text-4);
}

.ns-v-more button {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--ns-text-3);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
}

.ns-v-more button:hover {
    color: var(--ns-text-1);
}

@media (max-width: 720px) {
    .ns-v-ev,
    .ns-v-acts {
        grid-template-columns: 1fr;
    }
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
    font: 500 11px var(--ns-font-mono);
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
    border-color: var(--ns-red-line);
    border-radius: var(--ns-r-xl);
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ns-alert-box.warn {
    border-color: var(--ns-amber-line);
}

.ns-alert-box.boot {
    border-color: var(--ns-brand-line);
}

.ns-choice-btn {
    text-align: left;
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    padding: 10px 13px;
    border-radius: var(--ns-r-lg);
    cursor: pointer;
    font-size: 13px;
    transition: border-color 0.15s ease, background 0.15s ease;
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

/* 占位文字统一用弱化文字 token, 两主题对各自底色均 >= 4.5:1 */
.ns-editor-textarea::placeholder {
    color: var(--ns-text-4);
}

.ns-patch-mark {
    background: linear-gradient(transparent 64%, var(--ns-amber-soft) 64%);
    box-shadow: 0 1.5px 0 0 var(--ns-amber-line);
    padding: 1px 2px;
    border-radius: var(--ns-r-xs);
}

.ns-err-mark {
    background: var(--ns-red-soft);
    box-shadow: 0 1.5px 0 0 var(--ns-red);
    padding: 1px 2px;
    border-radius: var(--ns-r-xs);
}

.ns-diff-add {
    background: var(--ns-green-soft);
    color: var(--ns-green-ink);
    padding: 3px 10px;
    border-radius: var(--ns-r-xs);
    display: block;
}

.ns-diff-del {
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
    padding: 3px 10px;
    border-radius: var(--ns-r-xs);
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
    font-size: 12px;
    color: var(--ns-text-2);
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-2);
    max-width: 100%;
}

.ns-qslip-ty {
    font: 500 10.5px var(--ns-font-sans);
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

.ns-composer-box {
    position: relative;
    border-radius: var(--ns-r-sheet);
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
    font-size: 14px;
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

/* 左下角极简提示与已选指令胶囊 */
.ns-composer-hint {
    font-size: 12px;
    color: var(--ns-text-4);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ns-kind-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 5px 0 10px;
    border-radius: 999px;
    background: var(--ns-brand-soft);
    border: 1px solid var(--ns-brand-line);
    color: var(--ns-brand-ink);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
}

.ns-kind-pill-label {
    line-height: 1;
}

.ns-kind-pill-clear {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 0;
    background: transparent;
    color: var(--ns-brand-ink);
    display: grid;
    place-items: center;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
}

/* 斜杠 / 指令联想浮层菜单 */
.ns-slash-menu {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 8px);
    background: var(--ns-bg-surface-2);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-lg);
    padding: 6px;
    box-shadow: var(--ns-pop-shadow);
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ns-slash-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--ns-r-sm);
    background: transparent;
    color: var(--ns-text-2);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
}

.ns-slash-item.is-active {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
    box-shadow: inset 2px 0 0 var(--ns-brand);
}

.ns-slash-cmd {
    font: 500 12px var(--ns-font-mono);
    color: var(--ns-brand-ink);
    min-width: 88px;
    white-space: nowrap;
}

.ns-slash-alias {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    color: var(--ns-text-3);
    white-space: nowrap;
}

.ns-slash-desc {
    flex: 1;
    min-width: 0;
    color: var(--ns-text-2);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ns-slash-kind {
    font-size: 11px;
    color: var(--ns-text-4);
    white-space: nowrap;
}

.ns-slash-foot {
    margin-top: 2px;
    padding: 4px 10px 2px;
    border-top: 1px solid var(--ns-border-1);
    font-size: 11px;
    color: var(--ns-text-4);
}

.ns-send-circle {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 0;
    background: var(--ns-brand-fill);
    color: #ffffff;
    font-size: 14px;
    font-weight: 500;
    display: grid;
    place-items: center;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s ease, opacity 0.15s ease;
}

.ns-send-circle:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

/* 输入框下方运行状态: 13px 界面字体, 居中可换行; role=status + aria-live 承载语义 */
.ns-runtime-status {
    font-size: 13px;
    line-height: 1.5;
    color: var(--ns-text-4);
    text-align: center;
}

/* 等待安全点: 琥珀墨色 + 左侧呼吸圆点 + 文案写明等待, 不只靠颜色 */
.ns-runtime-status-waiting {
    color: var(--ns-amber-ink);
}

.ns-runtime-status-waiting::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 7px;
    border-radius: 50%;
    background: var(--ns-amber);
    animation: ns-ping 1.4s infinite;
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
    visibility: hidden;
    border-left-color: transparent;
}

.ns-narrow.ns-right-closed .ns-right {
    display: none;
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
    font-size: 13px;
    color: var(--ns-text-3);
    white-space: nowrap;
    cursor: pointer;
    position: relative;
    transition: background 0.12s ease, color 0.12s ease;
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

.ns-vtile.ns-active {
    border-color: var(--ns-brand-line);
    background: var(--ns-bg-surface-2);
}

.ns-vtile b {
    display: block;
    font: 500 16px var(--ns-font-mono);
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
    font-size: 14px;
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
    font-size: 12px;
    font-weight: 500;
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
    font-size: 11px;
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
    font-weight: 500;
    font-size: 13px;
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
    font-weight: 500;
    font-size: 12px;
    user-select: none;
    transition: background 0.12s ease;
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
    font-size: 12px;
}

/* 正文阅读：章节快捷导航 */
.ns-chap-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid var(--ns-border-1);
}

/* 细纲视图 */
.ns-plan-head {
    margin-bottom: 22px;
}

.ns-plan-kicker {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ns-text-4);
}

.ns-plan-title {
    margin: 6px 0 0;
    font: 500 24px/1.35 var(--ns-font-serif);
    color: var(--ns-text-1);
}

.ns-plan-title-sm {
    font-size: 20px;
}

.ns-plan-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.ns-plan-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: 11px var(--ns-font-mono);
    padding: 3px 10px;
    border-radius: var(--ns-r-pill, 999px);
    border: 1px solid var(--ns-border-1);
    background: var(--ns-bg-hover);
    color: var(--ns-text-3);
}

.ns-plan-pill b {
    color: var(--ns-text-1);
    font-weight: 500;
}

.ns-plan-kv {
    display: grid;
    grid-template-columns: 160px minmax(0, 1fr);
    margin: 0;
}

.ns-plan-kv dt {
    padding: 14px 12px 14px 0;
    border-top: 1px solid var(--ns-border-1);
    font-size: 13px;
    color: var(--ns-text-3);
}

.ns-plan-kv dt small {
    display: block;
    margin-top: 2px;
    font: 10.5px var(--ns-font-mono);
    color: var(--ns-text-4);
}

.ns-plan-kv dd {
    margin: 0;
    padding: 14px 0;
    border-top: 1px solid var(--ns-border-1);
    font-size: 13px;
    color: var(--ns-text-1);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.ns-plan-prose {
    line-height: 1.8;
    white-space: pre-wrap;
    word-break: break-word;
}

.ns-plan-ending {
    display: flex;
    gap: 10px;
    align-items: flex-start;
}

.ns-plan-outline {
    font: 15px/1.9 var(--ns-font-serif);
    color: var(--ns-prose, var(--ns-text-1));
}

.ns-plan-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 28px 24px;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-lg);
    background: var(--ns-bg-card);
}

.ns-plan-empty-hint {
    margin: 0;
    font-size: 13px;
    color: var(--ns-text-3);
    line-height: 1.7;
}

.ns-actor-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px 3px 4px;
    border-radius: 999px;
    border: 1px solid var(--ns-border-1);
    background: var(--ns-bg-card);
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-actor-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    color: #ffffff;
    font-size: 11px;
    font-weight: 500;
    font-style: normal;
    flex-shrink: 0;
}

/* Diff 视图 */
.ns-hunk {
    margin-bottom: 20px;
    border-radius: var(--ns-r-lg);
    border: 1px solid var(--ns-border-1);
    overflow: hidden;
    background: var(--ns-bg-base);
}

.ns-hunk-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 9px 14px;
    font-size: 12px;
    background: var(--ns-bg-hover);
    border-bottom: 1px solid var(--ns-border-1);
}

.ns-hunk-file {
    color: var(--ns-text-1);
}

.ns-hunk-range {
    color: var(--ns-text-4);
}

.ns-hunk-spacer {
    flex: 1;
}

.ns-hunk-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding: 9px 14px;
    font-size: 12px;
    color: var(--ns-text-4);
    border-top: 1px solid var(--ns-border-1);
}

.ns-diff-row {
    display: grid;
    grid-template-columns: 48px 22px minmax(0, 1fr);
    font: 14px/1.9 var(--ns-font-serif);
}

.ns-diff-row-del {
    background: var(--ns-red-soft);
}

.ns-diff-row-del .ns-diff-ln,
.ns-diff-row-del .ns-diff-glyph,
.ns-diff-row-del .ns-diff-text {
    color: var(--ns-red-ink);
}

.ns-diff-row-del .ns-diff-text {
    text-decoration: line-through;
}

.ns-diff-row-add {
    background: var(--ns-green-soft);
}

.ns-diff-row-add .ns-diff-ln,
.ns-diff-row-add .ns-diff-glyph,
.ns-diff-row-add .ns-diff-text {
    color: var(--ns-green-ink);
}

.ns-diff-ln {
    font: 11px/2.45 var(--ns-font-mono);
    color: var(--ns-text-4);
    text-align: left;
    padding-left: 14px;
    user-select: none;
}

.ns-diff-glyph {
    font: 12px/2.25 var(--ns-font-mono);
    text-align: center;
    user-select: none;
    color: var(--ns-text-4);
}

.ns-diff-text {
    padding: 3px 14px 3px 2px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--ns-text-3);
}

.ns-diff-clean {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 24px;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-lg);
    background: var(--ns-bg-card);
}

.ns-diff-clean-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
}

.ns-diff-clean-file {
    font: 12px var(--ns-font-mono);
    color: var(--ns-text-4);
}

.ns-diff-clean-text {
    font-size: 13px;
    color: var(--ns-text-2);
    line-height: 1.7;
}

.ns-diff-clean-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--ns-border-1);
    font-size: 12px;
    color: var(--ns-text-4);
}

/* 阶段图修复徽标 */
.ns-stage-repair {
    display: inline-block;
    font: 9.5px var(--ns-font-mono);
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--ns-amber-soft);
    color: var(--ns-amber-ink);
    border: 1px solid color-mix(in srgb, var(--ns-amber-ink) 20%, transparent);
}

/* 操作反馈条（中栏顶部、composer 上方） */
.ns-feedback-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0 24px 8px;
    padding: 6px 12px;
    border-radius: var(--ns-r-sm);
    font-size: 12px;
    line-height: 1.5;
    flex-shrink: 0;
}

.ns-feedback-err {
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
    border: 1px solid var(--ns-red-line);
}

.ns-feedback-ok {
    background: var(--ns-green-soft);
    color: var(--ns-green-ink);
    border: 1px solid color-mix(in srgb, var(--ns-green) 36%, transparent);
}

/* SAFE_HALT 顶部挂起告警条 */
.ns-safe-halt-banner {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 8px 14px 0;
    padding: 9px 12px;
    border: 1px solid var(--ns-red-line);
    border-radius: var(--ns-r-md);
    background: var(--ns-red-soft);
    color: var(--ns-text-2);
    font-size: 12px;
    flex-shrink: 0;
}

.ns-safe-halt-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--ns-red-ink);
    font-size: 13px;
}

.ns-safe-halt-head strong {
    font-weight: 500;
}

.ns-safe-halt-reason {
    line-height: 1.55;
}

.ns-safe-halt-details {
    font-size: 11px;
    line-height: 1.5;
    color: var(--ns-text-3);
    overflow-wrap: anywhere;
}

/* 左栏章节列表与正文加载骨架 */
@keyframes ns-skel-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
}

.ns-skel,
.ns-skel-line {
    display: block;
    border-radius: var(--ns-r-xs);
    background: color-mix(in srgb, var(--ns-text-4) 14%, transparent);
    animation: ns-skel-pulse 1.4s ease-in-out infinite;
}

.ns-skel-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
}

.ns-skel-code {
    width: 44px;
    height: 12px;
}

.ns-skel-title {
    flex: 1;
    height: 12px;
}

.ns-skel-pill {
    width: 40px;
    height: 16px;
    border-radius: 999px;
}

.ns-prose-skel {
    width: 100%;
    max-width: var(--ns-col);
    margin: 0 auto;
    padding: 12px 0 40px;
}

.ns-skel-line {
    height: 14px;
    margin-bottom: 14px;
    width: 100%;
}

.ns-skel-line-short {
    width: 62%;
}

/* 窄屏响应式 */
@media (max-width: 480px) {
    .ns-topbar {
        height: auto;
        min-height: 46px;
        flex-wrap: wrap;
        padding: 6px 12px;
        gap: 6px;
    }

    .ns-top-left {
        flex: 1 1 100%;
        overflow: visible;
    }

    .ns-top-book-select {
        max-width: 100%;
        flex-shrink: 1;
    }

    .ns-top-2 {
        height: auto;
        min-height: 38px;
        flex-wrap: wrap;
        padding: 6px 12px;
        gap: 4px;
    }

    .ns-composer-dock {
        padding: 6px 12px 10px;
    }

    .ns-composer-box {
        padding: 8px 8px 6px 10px;
        border-radius: var(--ns-r-lg);
    }

    .ns-stage-strip {
        padding: 6px 12px;
    }

    .ns-stage-body {
        padding: 12px 16px 28px;
    }

    .ns-paper {
        padding: 16px;
    }

    .ns-prose-col {
        padding: 16px 0 72px;
    }

    .ns-chap-nav {
        flex-wrap: wrap;
    }

    .ns-chap-nav .ns-btn {
        flex: 1 1 auto;
        height: auto;
        padding: 6px 10px;
        white-space: normal;
        text-align: left;
    }

    .ns-feedback-bar,
    .ns-safe-halt-banner {
        margin-left: 16px;
        margin-right: 16px;
    }

    .ns-plan-kv {
        grid-template-columns: minmax(0, 1fr);
    }

    .ns-plan-kv dt {
        padding: 14px 0 2px;
    }

    .ns-plan-kv dd {
        padding: 4px 0 14px;
        border-top: 0;
    }

    .ns-plan-title {
        font-size: 20px;
    }

    .ns-verdict {
        padding: 18px 16px;
    }
}

@media (prefers-reduced-motion: reduce) {
    .ns-studio-shell,
    .ns-studio-shell *,
    .ns-studio-shell *::before,
    .ns-studio-shell *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
    }
}

/* 悬浮交互统一收口：仅在支持 hover 的精确指针设备启用，触屏无残留底色 */
@media (hover: hover) and (pointer: fine) {
    .ns-book-card:hover {
        background: var(--ns-bg-surface-2);
        border-color: var(--ns-border-2);
    }

    .ns-ch-btn:hover {
        background: var(--ns-bg-hover);
        color: var(--ns-text-1);
    }

    .ns-top-book-select:hover {
        background: var(--ns-bg-hover);
        border-color: var(--ns-border-1);
    }

    .ns-icon-btn:hover:not(:disabled) {
        background: var(--ns-bg-hover);
        color: var(--ns-text-1);
    }

    .ns-thread-btn:hover {
        background: var(--ns-bg-hover);
        color: var(--ns-text-1);
    }

    .ns-btn-primary:hover:not(:disabled),
    .ns-btn-yolo:hover:not(:disabled) {
        background: var(--ns-brand-fill-hover);
    }

    .ns-btn-ghost:hover:not(:disabled) {
        background: var(--ns-bg-surface-2);
        border-color: var(--ns-border-3);
    }

    .ns-stage-node:hover {
        border-color: var(--ns-border-2);
        color: var(--ns-text-1);
    }

    .ns-v-opt:hover:not(:disabled) {
        border-color: var(--ns-border-3);
        background: var(--ns-bg-surface-2);
    }

    .ns-v-opt.ns-go:hover:not(:disabled) {
        background: var(--ns-brand-fill-hover);
        border-color: var(--ns-brand-fill-hover);
    }

    .ns-choice-btn:hover {
        border-color: var(--ns-border-3);
        background: var(--ns-bg-hover);
    }

    .ns-qslip-del:hover {
        background: var(--ns-bg-hover);
        color: var(--ns-red-ink);
    }

    .ns-kind-pill-clear:hover {
        background: var(--ns-bg-hover);
        color: var(--ns-text-1);
    }

    .ns-slash-item:hover {
        background: var(--ns-bg-hover);
        color: var(--ns-text-1);
    }

    .ns-send-circle:hover:not(:disabled) {
        background: var(--ns-brand-fill-hover);
    }

    .ns-r-tab:hover {
        background: var(--ns-bg-hover);
        color: var(--ns-text-1);
    }

    .ns-vtile:hover {
        border-color: var(--ns-brand-line);
        background: var(--ns-bg-surface-2);
    }

    .ns-tool-card:hover:not(:disabled) {
        border-color: var(--ns-border-2);
        background: var(--ns-bg-surface-2);
    }

    details.ns-acc summary:hover {
        background: var(--ns-bg-hover);
    }

    .ns-popover-item:hover {
        background: var(--ns-bg-hover);
        border-color: var(--ns-border-2);
    }

    .ns-entity-summary:hover {
        background: var(--ns-bg-hover);
    }

    .ns-link-btn:hover {
        color: var(--ns-text-1);
    }

    .ns-studio-shell ::-webkit-scrollbar-thumb:hover {
        background-color: var(--ns-border-3);
    }
}

/* 触屏粗指针: xs 按钮命中区放大到 32px; 目录排序命中区放大到 40px 高 */
@media (pointer: coarse) {
    .ns-btn-xs,
    .ns-btn-ghost.ns-btn-xs {
        height: 32px;
        padding: 0 12px;
    }

    .ns-send-circle {
        width: 40px;
        height: 40px;
        font-size: 17px;
    }

    .ns-group-title .ns-link-btn {
        min-height: 40px;
        padding: 0 8px;
    }
}

/* ---- 左栏真源目录 ---- */
.ns-nav-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--ns-text-2);
}

.ns-book-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.ns-book-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ns-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ns-book-path {
    font-size: 11px;
    color: var(--ns-text-4);
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-book-switcher {
    margin-top: 8px;
}

.ns-book-select {
    width: 100%;
    height: 28px;
    background: var(--ns-bg-base);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    border-radius: var(--ns-r-sm);
    padding: 0 6px;
    font-size: 12px;
    cursor: pointer;
}

.ns-book-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
}

.ns-nav-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.ns-ch-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ns-ch-label {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
}

.ns-ch-code {
    font-size: 11px;
    color: var(--ns-text-4);
    flex-shrink: 0;
}

.ns-ch-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ns-ch-btn.ns-active {
    background: var(--ns-bg-press);
    border-color: var(--ns-border-2);
    color: var(--ns-text-1);
}

.ns-link-btn {
    background: transparent;
    border: none;
    /* 命中区至少 24px 高, 视觉字级保持不变 */
    min-height: 24px;
    padding: 0 4px;
    font-size: 11px;
    color: var(--ns-text-4);
    cursor: pointer;
}

.ns-empty-hint {
    font-size: 12px;
    color: var(--ns-text-4);
    padding: 10px 8px;
    line-height: 1.7;
}

.ns-view-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ns-view-badge {
    font-size: 11px;
    color: var(--ns-text-4);
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-xs);
    padding: 1px 5px;
    flex-shrink: 0;
}

/* ---- 通用弱化文本与编辑器 ---- */
.ns-muted {
    color: var(--ns-text-4);
}

.ns-editor-wrap {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.ns-editor-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 12px;
}

/* ---- YOLO 模式弹层 ---- */
.ns-yolo-popover {
    width: 264px;
    padding: 10px;
    gap: 4px;
}

.ns-popover-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--ns-text-4);
    letter-spacing: 0.06em;
    padding: 2px 6px 6px;
}

.ns-popover-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--ns-r-md);
    padding: 8px 10px;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
}

.ns-popover-item-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-popover-item-desc {
    font-size: 11px;
    color: var(--ns-text-4);
    line-height: 1.5;
}

/* ---- 顶栏状态与呼吸提示 ---- */
.ns-thread-label {
    font-size: 12px;
    color: var(--ns-text-3);
    white-space: nowrap;
}

.ns-pulse {
    animation: ns-blink 1.6s ease-in-out infinite;
}

.ns-pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ns-brand-ink);
    flex-shrink: 0;
    animation: ns-blink 1.2s ease-in-out infinite;
}

/* ---- 物化视图页 ---- */
.ns-subtabs {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--ns-bg-hover);
    border-radius: var(--ns-r-md);
    padding: 3px;
    overflow-x: auto;
    max-width: 100%;
}

.ns-entities-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
}

.ns-entity-card {
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-card);
    overflow: hidden;
}

.ns-entity-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px;
    font-size: 13px;
    color: var(--ns-text-1);
    cursor: pointer;
    list-style: none;
}

.ns-entity-summary::-webkit-details-marker {
    display: none;
}

.ns-entity-summary strong {
    font-weight: 500;
}

.ns-pre-block {
    margin: 0;
    padding: 12px 14px;
    font-size: 12px;
    line-height: 1.8;
    color: var(--ns-text-2);
    white-space: pre-wrap;
    word-break: break-word;
    border-top: 1px solid var(--ns-border-1);
    max-height: 480px;
    overflow-y: auto;
}

/* 未保存草稿确认弹窗（宿主 Modal 内部内容，不自绘遮罩）
   令牌自足复用 BOOT_CSS 的 .ns-b-modal-shell/.ns-b-modal-content 容器（暗色默认 + 宿主亮色）。
   STUDIO_CSS 先于 BOOT_CSS 注入，同特异性会被后者覆盖，
   故用双类选择器提升特异性，只覆盖窄宽度与内容留白，不复制色值 */
.ns-b-modal-shell.ns-guard-modal-shell {
    width: min(480px, calc(100vw - 32px));
    max-width: 480px;
}

.ns-b-modal-content.ns-guard-modal-content {
    padding: 4px 20px 18px;
}

.ns-guard-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.ns-guard-hint {
    margin: 0;
    font-size: 13px;
    line-height: 1.7;
    color: var(--ns-text-3);
    overflow-wrap: break-word;
}

.ns-guard-error {
    margin: 0;
    padding: 6px 10px;
    border-radius: var(--ns-r-sm);
    font-size: 12px;
    line-height: 1.6;
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
    border: 1px solid var(--ns-red-line);
    overflow-wrap: break-word;
}

.ns-guard-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
}

/* 阶段节点 Session 指示与右侧原生 DSH 会话/轨迹检查器 */
.ns-stage-node.ns-has-session {
    border-style: solid;
}

.ns-stage-sess-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.3;
    white-space: nowrap;
}

.ns-sess-live {
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
    border: 1px solid var(--ns-brand-line);
}

.ns-sess-done {
    background: var(--ns-bg-hover);
    color: var(--ns-text-2);
    border: 1px solid var(--ns-border-2);
}

.ns-sess-cleanroom {
    background: var(--ns-bg-hover);
    color: var(--ns-text-3);
    border: 1px dashed var(--ns-border-2);
}

.ns-stage-sess-spinner {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--ns-brand);
    border-top-color: transparent;
    animation: ns-spin 0.9s linear infinite;
}

@keyframes ns-spin {
    to {
        transform: rotate(360deg);
    }
}

.ns-inspector-cleanroom-note,
.ns-inspector-session-note {
    margin-top: 4px;
    padding: 5px 8px;
    border-radius: var(--ns-r-sm);
    font-size: 11px;
    line-height: 1.5;
    background: var(--ns-bg-panel);
    border: 1px solid var(--ns-border-1);
    color: var(--ns-text-3);
}

.ns-i-stage-session-row {
    margin-top: 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
}

.ns-session-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    gap: 10px;
}

.ns-session-empty {
    justify-content: center;
    align-items: center;
    padding: 16px;
}

.ns-session-empty-card,
.ns-session-fallback {
    background: var(--ns-bg-card);
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    padding: 12px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--ns-text-2);
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-session-empty-card p,
.ns-session-fallback p {
    margin: 0;
}

.ns-session-fallback-title {
    font-weight: 600;
    color: var(--ns-text-1);
}

.ns-session-error {
    color: var(--ns-red-ink);
}

.ns-session-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--ns-border-1);
    flex-shrink: 0;
}

.ns-session-title-row,
.ns-session-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}

.ns-session-title-group {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.ns-session-id-badge {
    font-size: 11px;
    color: var(--ns-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-session-run-row {
    font-size: 11px;
    color: var(--ns-text-4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-session-model-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 11px;
}

.ns-session-view-ring {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    padding: 3px;
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-panel);
    border: 1px solid var(--ns-border-1);
}

.ns-session-view-btn {
    border: none;
    border-radius: var(--ns-r-sm);
    background: transparent;
    color: var(--ns-text-3);
    font-size: 12px;
    font-weight: 500;
    padding: 5px 8px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
}

.ns-session-view-btn.on {
    background: var(--ns-bg-card);
    color: var(--ns-brand-ink);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16);
}

.ns-session-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
}

.ns-stage-session-embed {
    flex: 1 1 auto;
    min-height: 220px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-base);
}

.ns-session-supplementary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-card);
    flex-shrink: 0;
}

.ns-session-request-body {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-session-request-block {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.ns-session-request-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--ns-text-3);
}

.ns-session-tool-result-details {
    font-size: 11px;
    color: var(--ns-text-3);
}

.ns-session-tool-result-details summary {
    cursor: pointer;
    font-weight: 500;
    color: var(--ns-text-2);
}

.ns-stage-session-embed [data-composer-seat] {
    display: none;
}

.ns-session-loading-bar {
    padding: 6px 10px;
    font-size: 11px;
    color: var(--ns-text-3);
    border-bottom: 1px solid var(--ns-border-1);
}

.ns-session-kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    margin: 0;
    font-size: 11px;
}

.ns-session-kv dt {
    color: var(--ns-text-4);
}

.ns-session-kv dd {
    margin: 0;
    color: var(--ns-text-2);
    word-break: break-all;
}

.ns-session-detail {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--ns-border-1);
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-session-turns {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-session-turn {
    padding: 8px;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-base);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-session-turn-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 11px;
}

.ns-session-turn-thinking {
    font-size: 12px;
    color: var(--ns-text-3);
}

.ns-session-turn-thinking summary {
    cursor: pointer;
    font-weight: 500;
    color: var(--ns-text-2);
}

.ns-session-tool-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-session-tool-call {
    padding: 6px 8px;
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-hover);
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.ns-session-tool-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--ns-text-1);
}

.ns-session-pre {
    margin: 4px 0 0;
    padding: 6px;
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-surface-2);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ns-text-2);
}

.ns-session-pre-result {
    border-left: 1px solid var(--ns-border-3);
}

.ns-session-turn-output {
    font-size: 12px;
    line-height: 1.55;
    color: var(--ns-text-1);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

/* =====================================================================
 * Wave 4 东方清样校勘室（Overdrive A+B）：
 * - 容器感知三栏布局（>=1200px 三栏常驻，820~1200px 收左栏，<820px 右栏抽屉）
 * - 左栏：卷信息 + 正文目录 + 底部全书设定集三入口
 * - 中栏：672px 清样纸面、68px 超细刊头、P01 悬停段号、-4deg 朱砂定稿印
 * - Overdrive：@property 流光边、scroll() 进度丝带、View Transitions、reduced-motion 降级
 * ===================================================================== */

@property --ns-beam-angle {
    syntax: "<angle>";
    initial-value: 0deg;
    inherits: false;
}

@keyframes ns-beam-spin {
    to {
        --ns-beam-angle: 360deg;
    }
}

@keyframes ns-lamp-breathe {
    0%, 100% {
        box-shadow: 0 0 0 2px var(--ns-brand-soft);
    }
    50% {
        box-shadow: 0 0 0 5px var(--ns-brand-soft);
    }
}

@keyframes ns-seal-impress {
    0% {
        opacity: 0;
        transform: scale(1.38) rotate(-10deg);
    }
    68% {
        opacity: 1;
        transform: scale(0.96) rotate(-3deg);
    }
    100% {
        opacity: 1;
        transform: scale(1) rotate(-4deg);
    }
}

@keyframes ns-ribbon-progress {
    from {
        transform: scaleX(0);
    }
    to {
        transform: scaleX(1);
    }
}

/* 原生 View Transitions 共享元素流转 */
::view-transition-old(ns-studio-sheet),
::view-transition-new(ns-studio-sheet) {
    animation-duration: 210ms;
    animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
}

::view-transition-group(ns-trace-lamp),
::view-transition-group(ns-trace-role) {
    animation-duration: 260ms;
    animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
}

/* 容器感知三栏布局（由 .ns-studio-shell ResizeObserver 实测宽度驱动） */
.ns-studio-shell.ns-layout-wide {
    grid-template-columns: 224px minmax(0, 1fr) var(--ns-right-w, 340px);
}

.ns-studio-shell.ns-layout-medium {
    grid-template-columns: minmax(0, 1fr) var(--ns-right-w, 340px);
}

.ns-studio-shell.ns-layout-compact {
    grid-template-columns: minmax(0, 1fr);
}

.ns-studio-shell.ns-right-closed {
    --ns-right-w: 0px;
}

.ns-num {
    font-variant-numeric: tabular-nums;
}

/* 通用按钮与胶囊徽标 */
.ns-btn {
    height: 30px;
    padding: 0 11px;
    border-radius: var(--ns-r-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--ns-text-2);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}

.ns-btn:hover:not(:disabled) {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.ns-btn-subtle {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-btn-subtle:hover:not(:disabled) {
    background: var(--ns-bg-press);
}

.ns-btn-outline {
    border-color: var(--ns-border-2);
    background: var(--ns-bg-sheet);
    color: var(--ns-text-1);
}

.ns-btn-outline:hover:not(:disabled) {
    border-color: var(--ns-border-3);
    background: var(--ns-bg-elevated);
}

.ns-btn-primary {
    background: var(--ns-brand-fill);
    color: #ffffff;
}

.ns-btn-primary:hover:not(:disabled) {
    background: var(--ns-brand-fill-hover);
    color: #ffffff;
}

.ns-btn-warn {
    background: var(--ns-amber-soft);
    border-color: var(--ns-amber-line);
    color: var(--ns-amber-ink);
}

.ns-btn-warn:hover:not(:disabled) {
    background: var(--ns-bg-press);
}

.ns-btn-danger {
    background: var(--ns-red-soft);
    border-color: var(--ns-red-line);
    color: var(--ns-red-ink);
}

.ns-btn-icon-only {
    width: 30px;
    padding: 0;
    justify-content: center;
}

.ns-btn-xs {
    height: 24px;
    padding: 0 8px;
    font-size: 11px;
}

.ns-split-action {
    display: inline-flex;
    align-items: center;
    border-radius: var(--ns-r-sm);
    position: relative;
}

.ns-split-action > .ns-btn:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
}

.ns-split-action > .ns-btn:nth-child(2) {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid rgba(255, 255, 255, 0.22);
    padding: 0 9px;
}

.ns-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--ns-r-pill);
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
}

.ns-badge-ok {
    background: var(--ns-green-soft);
    color: var(--ns-green-ink);
}

.ns-badge-accent {
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
}

.ns-badge-warn {
    background: var(--ns-amber-soft);
    color: var(--ns-amber-ink);
}

.ns-badge-danger {
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
}

.ns-badge-neutral {
    background: var(--ns-bg-hover);
    color: var(--ns-text-3);
}

/* 浮层菜单 */
.ns-menu-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    min-width: 244px;
    background: var(--ns-bg-elevated);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-lg);
    box-shadow: var(--ns-shadow-float);
    padding: 5px;
    z-index: 80;
    opacity: 1;
    transform: translateY(0) scale(1);
    transition: opacity 0.14s var(--ns-ease), transform 0.14s var(--ns-ease);
}

@starting-style {
    .ns-menu-pop {
        opacity: 0;
        transform: translateY(-4px) scale(0.98);
    }
}

.ns-menu-pop.ns-left {
    right: auto;
    left: 0;
}

.ns-menu-row {
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--ns-r-sm);
    background: transparent;
    color: var(--ns-text-1);
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
}

.ns-menu-row:hover {
    background: var(--ns-bg-hover);
}

.ns-menu-row span {
    font-size: 11px;
    color: var(--ns-text-3);
}

.ns-menu-row.ns-danger {
    color: var(--ns-red-ink);
}

.ns-menu-divider {
    height: 1px;
    background: var(--ns-border-1);
    margin: 4px;
}

/* Wave 4 左栏（224px 常驻：卷与天数 / 正文目录 / 底部全书设定集三入口） */
.ns-left-pane {
    background: var(--ns-bg-side);
    border-right: 1px solid var(--ns-border-1);
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
}

.ns-left-vol-bar {
    height: 46px;
    padding: 0 14px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    color: var(--ns-text-2);
    font-weight: 600;
    flex-shrink: 0;
}

.ns-left-vol-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-left-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px 8px;
    scrollbar-width: thin;
    scrollbar-color: var(--ns-border-2) transparent;
}

.ns-left-group-label {
    padding: 4px 10px 6px;
    font-size: 11px;
    color: var(--ns-text-3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
}

.ns-ch-item {
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--ns-r-sm);
    background: transparent;
    color: var(--ns-text-2);
    font-family: inherit;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    text-align: left;
    margin-bottom: 2px;
}

.ns-ch-item:hover {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-ch-item.ns-active {
    background: var(--ns-bg-press);
    color: var(--ns-text-1);
    font-weight: 500;
}

.ns-ch-title-wrap {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-ch-no {
    color: var(--ns-text-3);
    margin-right: 4px;
    font-size: 12px;
}

.ns-ch-chars {
    font-size: 11px;
    color: var(--ns-text-3);
    flex-shrink: 0;
}

.ns-left-codex {
    padding: 10px 8px 12px;
    border-top: 1px solid var(--ns-border-1);
    flex-shrink: 0;
}

.ns-codex-row {
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--ns-r-sm);
    background: transparent;
    color: var(--ns-text-2);
    font-family: inherit;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    cursor: pointer;
    text-align: left;
}

.ns-codex-row:hover {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-codex-row.ns-active {
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
    font-weight: 500;
}

/* 中栏舞台与顶栏 */
.ns-center-pane {
    background: var(--ns-bg-stage);
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    position: relative;
}

.ns-center-header {
    height: 46px;
    padding: 0 16px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
}

.ns-book-switcher {
    border: 0;
    background: transparent;
    color: var(--ns-text-1);
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    padding: 4px 8px;
    margin-left: -8px;
    border-radius: var(--ns-r-sm);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
}

.ns-book-switcher:hover {
    background: var(--ns-bg-hover);
}

/* 阅读工具栏 + 672px 版心光学对齐的 3x2 Agent 工序矩阵 */
.ns-reader-toolbar-wrap {
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding: 10px 24px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
}

.ns-reader-bar {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}

.ns-seg-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: var(--ns-bg-side);
    padding: 3px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-1);
}

.ns-seg-tab {
    border: 0;
    background: transparent;
    color: var(--ns-text-3);
    font-family: inherit;
    font-size: 12px;
    padding: 4px 11px;
    border-radius: var(--ns-r-sm);
    cursor: pointer;
    transition: background 0.14s ease, color 0.14s ease;
}

.ns-seg-tab:hover {
    color: var(--ns-text-1);
}

.ns-seg-tab.ns-active {
    background: var(--ns-bg-sheet);
    color: var(--ns-text-1);
    font-weight: 500;
}

.ns-pipeline-toggle-btn {
    height: 30px;
    padding: 0 11px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-2);
    background: var(--ns-bg-sheet);
    color: var(--ns-text-1);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.ns-pipeline-toggle-btn:hover {
    border-color: var(--ns-border-3);
    background: var(--ns-bg-elevated);
}

.ns-pipeline-toggle-btn.ns-open {
    border-color: var(--ns-brand-line);
    background: var(--ns-bg-elevated);
}

.ns-lamp-group {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.ns-lamp {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: transparent;
    border: 1px solid var(--ns-border-3);
    display: inline-block;
    flex-shrink: 0;
    transition: background 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}

.ns-lamp.ns-done {
    background: var(--ns-green);
    border-color: var(--ns-green);
    box-shadow: 0 0 0 2px var(--ns-green-soft);
}

.ns-lamp.ns-active {
    background: var(--ns-brand);
    border-color: var(--ns-brand);
    box-shadow: 0 0 0 3px var(--ns-brand-soft);
    animation: ns-lamp-breathe 1.8s ease-in-out infinite;
}

.ns-lamp.ns-halt {
    background: var(--ns-red);
    border-color: var(--ns-red);
    border-radius: var(--ns-r-xs);
    transform: rotate(45deg) scale(0.88);
    box-shadow: 0 0 0 3px var(--ns-red-soft);
}

.ns-pipeline-drawer {
    width: 100%;
    background: var(--ns-bg-sheet);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-lg);
    padding: 9px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 7px;
}

.ns-pipe-card {
    padding: 9px 11px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-1);
    background: var(--ns-bg-side);
    color: var(--ns-text-1);
    font-family: inherit;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
    position: relative;
    transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s var(--ns-ease);
}

.ns-pipe-card:hover {
    background: var(--ns-bg-hover);
    border-color: var(--ns-border-2);
}

.ns-pipe-card.ns-selected {
    background: var(--ns-brand-soft);
    border-color: var(--ns-brand-line);
}

.ns-pipe-card.ns-running-live {
    background:
        linear-gradient(var(--ns-bg-sheet), var(--ns-bg-sheet)) padding-box,
        conic-gradient(from var(--ns-beam-angle), var(--ns-brand-line), rgba(76, 124, 240, 0.08) 42%, var(--ns-brand) 78%, var(--ns-brand-line)) border-box;
    border: 1px solid transparent;
    animation: ns-beam-spin 3.6s linear infinite;
}

.ns-pipe-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
}

.ns-pipe-step-name {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    font-weight: 600;
    color: var(--ns-text-1);
}

.ns-pipe-step-state {
    font-size: 11px;
    color: var(--ns-text-3);
}

.ns-pipe-card.ns-running-live .ns-pipe-step-state {
    color: var(--ns-brand-ink);
    font-weight: 500;
}

.ns-pipe-live-note {
    font-size: 11px;
    color: var(--ns-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-pipe-card.ns-running-live .ns-pipe-live-note {
    color: var(--ns-text-2);
}

.ns-pipe-model-tag {
    font-family: var(--ns-font-mono);
    font-size: 11px;
    color: var(--ns-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-pipe-card.ns-selected .ns-pipe-model-tag {
    color: var(--ns-brand-ink);
}

/* 书稿滚动区 + 672px 清样画布 + scroll() 进度丝带 */
.ns-stage-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 24px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    scroll-timeline-name: --ns-manuscript-scroll;
    scroll-timeline-axis: block;
    scrollbar-width: thin;
    scrollbar-color: var(--ns-border-2) transparent;
}

.ns-manuscript-sheet {
    width: 100%;
    max-width: 672px;
    background: var(--ns-bg-sheet);
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-sheet);
    padding: 36px 44px 44px;
    box-shadow: var(--ns-shadow-sheet);
    position: relative;
    overflow: hidden;
    view-transition-name: ns-studio-sheet;
}

.ns-reading-ribbon {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--ns-seal);
    transform-origin: 0 50%;
    transform: scaleX(var(--ns-scroll-fallback, 0));
    opacity: 0.88;
    pointer-events: none;
}

@supports (animation-timeline: scroll()) {
    .ns-reading-ribbon {
        transform: scaleX(0);
        animation: ns-ribbon-progress linear both;
        animation-timeline: --ns-manuscript-scroll;
    }
}

.ns-editorial-masthead {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 22px;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--ns-border-1);
}

.ns-editorial-numeral {
    font-family: var(--ns-font-display);
    font-weight: 200;
    font-size: 68px;
    line-height: 0.86;
    letter-spacing: -0.04em;
    color: var(--ns-numeral);
    padding-right: 20px;
    border-right: 1px solid var(--ns-border-2);
    font-variant-numeric: tabular-nums;
    user-select: none;
}

.ns-manuscript-sheet h1 {
    font-family: var(--ns-font-serif);
    font-size: 26px;
    font-weight: 600;
    line-height: 1.38;
    color: var(--ns-text-1);
    margin: 0;
    letter-spacing: 0.02em;
    text-wrap: balance;
}

.ns-ch-meta-line {
    font-size: 12px;
    color: var(--ns-text-3);
    margin-top: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.ns-patch-colophon-bar {
    margin: -8px 0 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 11px;
    border-radius: var(--ns-r-md);
    background: var(--ns-amber-soft);
    border: 1px solid var(--ns-amber-line);
    color: var(--ns-amber-ink);
    font-size: 12px;
}

.ns-patch-colophon-bar button {
    border: 0;
    background: transparent;
    color: var(--ns-amber-ink);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
    padding: 0;
}

.ns-prose-body {
    font-family: var(--ns-font-serif);
    font-size: 17px;
    line-height: 1.98;
    color: var(--ns-prose);
    letter-spacing: 0.012em;
}

.ns-prose-para-wrap {
    position: relative;
}

.ns-prose-folio {
    position: absolute;
    left: -36px;
    top: 6px;
    font-family: var(--ns-font-mono);
    font-size: 11px;
    color: var(--ns-text-3);
    opacity: 0;
    transition: opacity 0.15s ease;
    user-select: none;
}

.ns-prose-para-wrap:hover .ns-prose-folio {
    opacity: 0.9;
}

.ns-prose-body p {
    margin: 0 0 16px;
    text-indent: 2em;
    border-radius: var(--ns-r-xs);
}

.ns-prose-body p.ns-conflict-highlight {
    background: var(--ns-red-soft);
    outline: 1px solid var(--ns-red-line);
    padding: 6px 10px;
    margin-left: -10px;
    margin-right: -10px;
}

.ns-editorial-endmark {
    margin-top: 36px;
    padding-top: 24px;
    border-top: 1px dashed var(--ns-border-1);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 9px;
}

.ns-seal-stamp {
    width: 48px;
    height: 48px;
    border-radius: var(--ns-r-sm);
    border: 1px solid var(--ns-seal);
    background: var(--ns-seal-soft);
    color: var(--ns-seal);
    font-family: var(--ns-font-serif);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.08em;
    display: grid;
    place-items: center;
    transform: rotate(-4deg);
    filter: url(#ns-cinnabar-grain);
    user-select: none;
    transition: transform 0.25s var(--ns-ease);
}

.ns-seal-stamp:hover {
    transform: rotate(0deg) scale(1.04);
}

.ns-seal-stamp.ns-stamping {
    animation: ns-seal-impress 0.36s var(--ns-ease) both;
}

/* 双模式设定冲突裁决卡 */
.ns-conflict-card {
    width: 100%;
    max-width: 672px;
    background: var(--ns-bg-sheet);
    border: 1px solid var(--ns-red-line);
    border-radius: var(--ns-r-sheet);
    overflow: hidden;
    flex-shrink: 0;
}

.ns-conflict-head {
    padding: 10px 16px;
    background: var(--ns-red-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
}

.ns-conflict-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.ns-conflict-compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px;
}

.ns-compare-pane {
    padding: 10px 12px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-side);
    font-size: 13px;
    line-height: 1.6;
    color: var(--ns-text-2);
}

.ns-compare-caption {
    font-size: 11px;
    color: var(--ns-text-3);
    margin-bottom: 4px;
    display: flex;
    justify-content: space-between;
}

/* 暂存草稿恢复提示条 */
.ns-stash-restore-bar {
    width: 100%;
    max-width: 672px;
    padding: 8px 14px;
    border-radius: var(--ns-r-lg);
    background: var(--ns-amber-soft);
    border: 1px solid var(--ns-amber-line);
    color: var(--ns-amber-ink);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    flex-shrink: 0;
}

/* 底部走向建议与一体式便签舱 */
.ns-director-footer {
    padding: 6px 24px 16px;
    display: flex;
    justify-content: center;
    flex-shrink: 0;
}

.ns-director-wrap {
    width: 100%;
    max-width: 672px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-next-ideas-panel {
    background: var(--ns-bg-sheet);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-lg);
    overflow: hidden;
}

.ns-next-ideas-header {
    width: 100%;
    padding: 6px 12px;
    border: 0;
    background: transparent;
    color: var(--ns-text-2);
    font-family: inherit;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
}

.ns-next-ideas-header:hover {
    background: var(--ns-bg-hover);
    color: var(--ns-text-1);
}

.ns-next-idea-list {
    border-top: 1px solid var(--ns-border-1);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ns-next-idea-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 8px;
    border-radius: var(--ns-r-sm);
}

.ns-next-idea-row:hover {
    background: var(--ns-bg-hover);
}

.ns-next-idea-text {
    flex: 1;
    border: 0;
    background: transparent;
    color: var(--ns-text-2);
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    padding: 0;
    line-height: 1.45;
}

.ns-next-idea-row:hover .ns-next-idea-text {
    color: var(--ns-text-1);
}

.ns-next-idea-go {
    border: 0;
    background: transparent;
    color: var(--ns-brand-ink);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 3px 8px;
    border-radius: var(--ns-r-xs);
    cursor: pointer;
    white-space: nowrap;
}

.ns-next-idea-row:hover .ns-next-idea-go {
    background: var(--ns-brand-soft);
}

.ns-queued-notes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.ns-note-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: var(--ns-r-pill);
    background: var(--ns-bg-sheet);
    border: 1px solid var(--ns-border-2);
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-note-tag button {
    border: 0;
    background: transparent;
    color: var(--ns-text-3);
    cursor: pointer;
    padding: 0 2px;
    font-size: 13px;
    line-height: 1;
}

.ns-note-dock {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 10px;
    background: var(--ns-bg-sheet);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-lg);
    box-shadow: var(--ns-shadow-dock);
    position: relative;
    transition: border-color 0.15s ease;
}

.ns-note-dock:focus-within {
    border-color: var(--ns-brand-line);
}

.ns-note-kind-btn {
    height: 26px;
    padding: 0 9px;
    border-radius: var(--ns-r-sm);
    border: 0;
    background: var(--ns-bg-hover);
    color: var(--ns-text-2);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    white-space: nowrap;
}

.ns-spotlight-select {
    height: 25px;
    border-radius: var(--ns-r-sm);
    border: 1px solid var(--ns-brand-line);
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
    padding: 0 6px;
    font-size: 12px;
    font-family: inherit;
}

.ns-note-input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--ns-text-1);
    font-family: inherit;
    font-size: 13px;
    outline: none;
}

.ns-note-input::placeholder {
    color: var(--ns-text-3);
}

/* 右栏（支持 <820px 自动浮层抽屉） */
.ns-right-pane {
    background: var(--ns-bg-side);
    border-left: 1px solid var(--ns-border-1);
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
}

.ns-right-pane.ns-right-drawer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(352px, 90%);
    z-index: 65;
    box-shadow: var(--ns-shadow-float);
}

.ns-right-top {
    height: 46px;
    padding: 0 12px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    flex-shrink: 0;
}

.ns-right-tab {
    height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--ns-r-sm);
    background: transparent;
    color: var(--ns-text-3);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
}

.ns-right-tab:hover {
    color: var(--ns-text-1);
    background: var(--ns-bg-hover);
}

.ns-right-tab.ns-active {
    color: var(--ns-text-1);
    background: var(--ns-bg-press);
    font-weight: 500;
}

.ns-right-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ns-toast-banner {
    position: fixed;
    top: 48px;
    right: 20px;
    padding: 8px 14px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-elevated);
    border: 1px solid var(--ns-border-2);
    box-shadow: var(--ns-shadow-float);
    color: var(--ns-text-1);
    font-size: 12px;
    z-index: 140;
}

/* 无障碍：系统减弱动态效果时移除位移、旋转循环与脉冲，保留色彩与状态反馈 */
@media (prefers-reduced-motion: reduce) {
    .ns-studio-shell *,
    .ns-studio-shell *::before,
    .ns-studio-shell *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
    }

    ::view-transition-old(ns-studio-sheet),
    ::view-transition-new(ns-studio-sheet),
    ::view-transition-group(ns-trace-lamp),
    ::view-transition-group(ns-trace-role) {
        animation: none !important;
    }
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
    styleEl.textContent = STUDIO_CSS + INSPECTOR_CSS + BOOT_CSS;
    document.head.appendChild(styleEl);
}

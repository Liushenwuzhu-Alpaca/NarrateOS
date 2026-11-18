/**
 * NarrateOS 开书弹窗与轻量动作弹窗（BootBookModal / StudioActionModals）专属样式层
 * - 弹窗内容经宿主 Modal portal 到 body，脱离 .ns-studio-shell 作用域，
 *   所有 --ns-* 令牌由 .ns-b-modal-shell 自足声明（深墨夜间默认 + 暖纸日间覆盖）
 * - 严格遵循 DESIGN.md 色阶、字阶与圆角刻度
 */
export const BOOT_CSS = `
.ns-b-modal-shell {
    width: min(860px, calc(100vw - 32px));
    max-width: 860px;
    margin: 0 auto;
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--ns-font-sans);
    font-size: 13px;
    line-height: 1.5;
    background: var(--ns-bg-elevated);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-sheet);
    box-shadow: var(--ns-shadow-float);
    color: var(--ns-text-1);
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
    --ns-font-sans: Inter, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif;
    --ns-font-serif: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif;
    --ns-font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    --ns-font-display: Inter, "PingFang SC", system-ui, sans-serif;
}

/* 暖纸日间主题适配（宿主无 data-ds-dark-theme 或独立预览 data-theme="light"） */
body:not([data-ds-dark-theme]) .ns-b-modal-shell,
[data-theme="light"] .ns-b-modal-shell {
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

.ns-b-modal-shell,
.ns-b-modal-shell *,
.ns-b-modal-shell *::before,
.ns-b-modal-shell *::after {
    box-sizing: border-box;
}

.ns-b-modal-shell :focus-visible {
    outline: 2px solid var(--ns-brand);
    outline-offset: 2px;
    border-radius: var(--ns-r-sm);
}

.ns-b-modal-content {
    padding: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

/* 轻量动作弹窗（换卷 / 多线并行）收窄卡片宽度 */
.ns-b-modal-shell.ns-action-modal-shell {
    width: min(460px, calc(100vw - 32px));
    max-width: 460px;
}

.ns-modal-head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    font-size: 14px;
}

.ns-modal-body {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 75vh;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--ns-border-2) transparent;
}

.ns-modal-body::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

.ns-modal-body::-webkit-scrollbar-thumb {
    background: var(--ns-border-2);
    border-radius: var(--ns-r-pill);
    border: 1px solid transparent;
    background-clip: content-box;
}

.ns-modal-body::-webkit-scrollbar-track {
    background: transparent;
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
    background: var(--ns-bg-sheet);
    border: 1px solid var(--ns-border-2);
    color: var(--ns-text-1);
    border-radius: var(--ns-r-sm);
    padding: 8px 11px;
    font-size: 13px;
    outline: none;
    width: 100%;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ns-textarea {
    min-height: 84px;
    resize: vertical;
    font-family: inherit;
}

.ns-input::placeholder,
.ns-textarea::placeholder {
    color: var(--ns-text-3);
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

/* 弹窗头部 */
.ns-b-head-stack {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.ns-b-head-row {
    display: flex;
    align-items: center;
    gap: 8px;
}

.ns-b-step0-badge {
    font-family: var(--ns-font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--ns-brand-ink);
    background: var(--ns-brand-soft);
    border: 1px solid var(--ns-brand-line);
    border-radius: var(--ns-r-pill);
    padding: 2px 8px;
}

.ns-b-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--ns-text-1);
}

.ns-b-head-hint {
    margin: 0;
    font-size: 12px;
    color: var(--ns-text-3);
}

/* 顶部主对话构思引导条 */
.ns-b-chat-guide {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 9px 12px;
    border-radius: var(--ns-r-md);
    background: var(--ns-brand-soft);
    border: 1px solid var(--ns-brand-line);
    color: var(--ns-brand-ink);
    font-size: 12px;
    line-height: 1.5;
}

.ns-b-chat-guide-text {
    flex: 1 1 260px;
    min-width: 0;
}

.ns-b-chat-guide code {
    font-family: var(--ns-font-mono);
    font-size: 11px;
    padding: 1px 5px;
    border-radius: var(--ns-r-xs);
    background: var(--ns-bg-sheet);
    color: var(--ns-text-1);
}

/* 顶部 4 步引导条 */
.ns-b-steps {
    padding: 10px 18px;
    border-bottom: 1px solid var(--ns-border-1);
    background: var(--ns-bg-side);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}

.ns-b-step-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: var(--ns-r-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--ns-text-3);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.ns-b-step-btn:hover:not(:disabled) {
    background: var(--ns-bg-hover);
    color: var(--ns-text-2);
}

.ns-b-step-btn--active {
    border-color: var(--ns-brand-line);
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
}

.ns-b-step-btn--active:hover:not(:disabled) {
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
}

.ns-b-step-btn--done {
    background: var(--ns-green-soft);
    color: var(--ns-green-ink);
}

.ns-b-step-btn:disabled {
    cursor: not-allowed;
    opacity: 0.55;
}

.ns-b-step-sep {
    color: var(--ns-text-3);
    font-size: 11px;
    user-select: none;
}

/* 弹窗正文与字段布局 */
.ns-b-body {
    gap: 14px;
}

.ns-b-label {
    font-weight: 500;
    color: var(--ns-text-2);
}

.ns-b-form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
}

.ns-b-mono-input {
    font-family: var(--ns-font-mono);
}

/* 双路径选择卡 */
.ns-b-mode-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 10px;
}

.ns-b-mode-card {
    text-align: left;
    padding: 12px 13px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-2);
    background: var(--ns-bg-sheet);
    color: var(--ns-text-1);
    font-family: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 5px;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.ns-b-mode-card:hover:not(:disabled) {
    border-color: var(--ns-border-3);
}

.ns-b-mode-card:disabled {
    cursor: not-allowed;
    opacity: 0.55;
}

.ns-b-mode-card--active {
    border-color: var(--ns-brand-line);
    background: var(--ns-brand-soft);
}

.ns-b-mode-card--active:hover:not(:disabled) {
    border-color: var(--ns-brand-line);
}

.ns-b-mode-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.ns-b-mode-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-b-mode-card--active .ns-b-mode-name {
    color: var(--ns-brand-ink);
}

.ns-b-mode-code {
    font-family: var(--ns-font-mono);
    font-size: 11px;
    color: var(--ns-text-3);
}

.ns-b-mode-desc {
    font-size: 12px;
    color: var(--ns-text-3);
    line-height: 1.45;
}

/* 角色与红线卡片 */
.ns-b-redline-card {
    padding: 12px 14px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-2);
    background: var(--ns-bg-sheet);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-b-section-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-b-redline-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-b-mini-card {
    padding: 9px 10px;
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-side);
    border: 1px solid var(--ns-border-1);
}

.ns-b-mini-title {
    font-weight: 500;
    margin-bottom: 3px;
}

.ns-b-mini-text {
    color: var(--ns-text-3);
}

.ns-b-accent-brand {
    color: var(--ns-brand-ink);
}

.ns-b-accent-seal {
    color: var(--ns-seal);
}

.ns-b-accent-amber {
    color: var(--ns-amber-ink);
}

.ns-b-accent-green {
    color: var(--ns-green-ink);
}

/* 试播标定三卡与核对表 */
.ns-b-calib-card {
    padding: 12px 14px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-2);
    background: var(--ns-bg-sheet);
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-b-calib-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-b-calib-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-b-check-card {
    padding: 10px 14px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-1);
    background: var(--ns-bg-side);
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-b-check-title {
    font-weight: 500;
    color: var(--ns-text-2);
}

.ns-b-check-row {
    color: var(--ns-text-3);
}

/* 启动预告与目录树 */
.ns-b-launch-card {
    padding: 12px 14px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-2);
    background: var(--ns-bg-sheet);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-b-launch-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--ns-brand-ink);
}

.ns-b-tree {
    font-family: var(--ns-font-mono);
    font-size: 11px;
    color: var(--ns-text-2);
    line-height: 1.7;
}

.ns-b-hint-card {
    padding: 10px 12px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-1);
    background: var(--ns-bg-side);
    font-size: 12px;
    color: var(--ns-text-3);
}

/* 加载态与错误条 */
.ns-b-loading-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-brand-line);
    background: var(--ns-brand-soft);
    color: var(--ns-brand-ink);
    font-size: 12px;
}

.ns-b-error-bar {
    padding: 10px 12px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-red-line);
    background: var(--ns-red-soft);
    color: var(--ns-red-ink);
    font-size: 12px;
}

/* 弹窗底部 */
.ns-b-foot {
    justify-content: space-between;
    align-items: center;
}

.ns-b-foot-counter {
    font-size: 12px;
    color: var(--ns-text-3);
}

.ns-b-foot-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* 轻量动作弹窗（换卷归档 / 多线并行）内部排版 */
.ns-action-modal-body {
    gap: 12px;
}

.ns-action-modal-desc {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: var(--ns-text-2);
}

.ns-action-check-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 0;
    border-top: 1px solid var(--ns-border-1);
    border-bottom: 1px solid var(--ns-border-1);
}

.ns-action-check-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    color: var(--ns-text-3);
}

.ns-action-check-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 200px;
    overflow-y: auto;
}

.ns-action-check-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: var(--ns-r-sm);
    font-size: 13px;
    color: var(--ns-text-1);
    cursor: pointer;
}

.ns-action-check-item:hover {
    background: var(--ns-bg-hover);
}

.ns-action-check-name {
    font-weight: 500;
}

.ns-action-check-role {
    margin-left: auto;
    font-size: 12px;
    color: var(--ns-text-3);
}

.ns-action-empty {
    font-size: 12px;
    color: var(--ns-text-3);
}

.ns-action-toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--ns-text-1);
    cursor: pointer;
}

.ns-action-warn-box {
    padding: 9px 12px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-amber-line);
    background: var(--ns-amber-soft);
    color: var(--ns-amber-ink);
    font-size: 12px;
    line-height: 1.5;
}

/* 窄屏：弹窗宽度自适应，路径卡与字段网格回落单列 */
@media (max-width: 640px) {
    .ns-b-modal-shell {
        width: calc(100vw - 16px);
        max-width: 100%;
    }

    .ns-b-mode-grid,
    .ns-b-form-grid,
    .ns-b-redline-grid,
    .ns-b-calib-grid {
        grid-template-columns: minmax(0, 1fr);
    }

    .ns-b-steps {
        padding: 10px 14px;
    }

    .ns-b-foot {
        flex-wrap: wrap;
        gap: 8px;
    }
}

/* 触屏粗指针设备：输入控件字号提升至 17px，避免聚焦自动缩放 */
@media (pointer: coarse) {
    .ns-b-modal-shell .ns-input,
    .ns-b-modal-shell .ns-textarea,
    .ns-b-modal-shell .ns-select {
        font-size: 17px;
    }
}
`;

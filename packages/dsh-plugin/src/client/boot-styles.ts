/**
 * NarrateOS 开书弹窗（Step 0 Bootloader）专属样式层
 * - ns-b-* 向导内容样式 + 宿主 Modal 卡片壳层覆盖
 * - 弹窗内容经宿主 Modal portal 到 body，不再位于 .ns-studio-shell 内，
 *   所有 --ns-* 令牌必须由 .ns-b-modal-shell 自带（暗色默认 + 宿主亮色一套）
 * - 全部字重不超过 500，强调依赖字号与墨色
 */
export const BOOT_CSS = `
/* 宿主 Modal 卡片宽度覆盖：className 挂在宿主卡片根节点，卡片默认宽度未知；
   同时给 width 与 max-width，覆盖顺序与最终宽度需实机校验 */
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
    background: var(--ns-bg-surface-2);
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-xl);
    box-shadow: var(--ns-pop-shadow);
    color: var(--ns-text-1);
    color-scheme: dark;

    /* portal 脱离 .ns-studio-shell 后的令牌自足声明（暗色一套，值拷自 styles.ts） */
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
}

/* 宿主亮色（body 无 data-ds-dark-theme）时切换暖白纸感令牌，值拷自 styles.ts */
body:not([data-ds-dark-theme]) .ns-b-modal-shell {
    color-scheme: light;
    --ns-bg-base: #faf8f4;
    --ns-bg-panel: #f3efe7;
    --ns-bg-card: #fffdf9;
    --ns-bg-surface-2: #fffefb;
    --ns-bg-hover: rgba(28, 25, 21, 0.05);
    --ns-bg-press: rgba(28, 25, 21, 0.09);
    --ns-border-1: rgba(28, 25, 21, 0.1);
    --ns-border-2: rgba(28, 25, 21, 0.18);
    --ns-border-3: rgba(28, 25, 21, 0.3);
    --ns-text-1: #1c1a17;
    --ns-text-2: #45413b;
    --ns-text-3: #625e57;
    --ns-text-4: #6b665e;
    --ns-numeral: #b3ada2;
    --ns-prose: #262420;
    --ns-brand: #3b6fe0;
    --ns-brand-ink: #2b5cc9;
    --ns-brand-soft: rgba(59, 111, 224, 0.1);
    --ns-brand-line: rgba(59, 111, 224, 0.4);
    --ns-green: #1f9d55;
    --ns-green-ink: #15703c;
    --ns-green-soft: rgba(31, 157, 85, 0.1);
    --ns-amber: #d97706;
    --ns-amber-ink: #8a4a05;
    --ns-amber-soft: rgba(217, 119, 6, 0.1);
    --ns-amber-line: rgba(217, 119, 6, 0.45);
    --ns-red: #d64545;
    --ns-red-ink: #b02a2a;
    --ns-red-soft: rgba(214, 69, 69, 0.09);
    --ns-red-line: rgba(214, 69, 69, 0.38);
    --ns-violet: #6d4bd0;
    --ns-violet-soft: rgba(109, 75, 208, 0.09);
    --ns-seal: #c0492f;
    --ns-seal-soft: rgba(192, 73, 47, 0.08);
    --ns-pop-shadow: 0 18px 48px rgba(40, 36, 30, 0.18), 0 0 0 1px var(--ns-border-2);
}

/* portal 后不再命中 .ns-studio-shell * 的盒模型规则，此处补齐 */
.ns-b-modal-shell,
.ns-b-modal-shell *,
.ns-b-modal-shell *::before,
.ns-b-modal-shell *::after {
    box-sizing: border-box;
}

/* 宿主 Modal 正文容器默认内边距未知，清零后由向导自有的头/步条/正文/底栏负责留白 */
.ns-b-modal-content {
    padding: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

/* 以下弹窗头/正文/底栏与表单控件原位于 styles.ts 通用层，
   随弹窗门户化迁入此处；类名保持全局，弹窗所需 --ns-* 由 .ns-b-modal-shell 继承 */
.ns-modal-head {
    padding: 14px 18px;
    border-bottom: 1px solid var(--ns-border-1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 500;
    font-size: 13.5px;
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
    border-radius: 8px;
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

/* 弹窗头部：Step 0 徽标 + 标题 + 副题 */
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
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ns-brand-ink);
    background: var(--ns-brand-soft);
    border: 1px solid var(--ns-brand-line);
    border-radius: 999px;
    padding: 2px 8px;
}

.ns-b-title {
    margin: 0;
    font-size: 14.5px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-b-head-hint {
    margin: 0;
    font-size: 11.5px;
    color: var(--ns-text-3);
}

/* 顶部 4 步引导条 */
.ns-b-steps {
    padding: 10px 18px;
    border-bottom: 1px solid var(--ns-border-1);
    background: var(--ns-bg-card);
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
    color: var(--ns-text-4);
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
    background: var(--ns-bg-card);
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
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-b-mode-card--active .ns-b-mode-name {
    color: var(--ns-brand-ink);
}

.ns-b-mode-code {
    font-family: var(--ns-font-mono);
    font-size: 10.5px;
    color: var(--ns-text-3);
}

.ns-b-mode-desc {
    font-size: 11.5px;
    color: var(--ns-text-3);
    line-height: 1.45;
}

/* 角色与红线卡片 */
.ns-b-redline-card {
    padding: 12px 14px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-2);
    background: var(--ns-bg-card);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-b-section-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-b-redline-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
    font-size: 11.5px;
    color: var(--ns-text-2);
}

.ns-b-mini-card {
    padding: 9px 10px;
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-base);
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
    background: var(--ns-bg-card);
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ns-b-calib-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-b-calib-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
    font-size: 11.5px;
    color: var(--ns-text-2);
}

.ns-b-check-card {
    padding: 10px 14px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-1);
    background: var(--ns-bg-base);
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
    background: var(--ns-bg-card);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-b-launch-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ns-brand-ink);
}

.ns-b-tree {
    font-family: var(--ns-font-mono);
    font-size: 11.5px;
    color: var(--ns-text-2);
    line-height: 1.7;
}

.ns-b-hint-card {
    padding: 10px 12px;
    border-radius: var(--ns-r-md);
    border: 1px solid var(--ns-border-1);
    background: var(--ns-bg-base);
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
    font-size: 11.5px;
    color: var(--ns-text-3);
}

.ns-b-foot-actions {
    display: flex;
    align-items: center;
    gap: 8px;
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

/* 触屏粗指针设备：输入控件字号提升至 16px，避免聚焦自动缩放 */
@media (pointer: coarse) {
    .ns-b-modal-shell .ns-input,
    .ns-b-modal-shell .ns-textarea,
    .ns-b-modal-shell .ns-select {
        font-size: 16px;
    }
}
`;

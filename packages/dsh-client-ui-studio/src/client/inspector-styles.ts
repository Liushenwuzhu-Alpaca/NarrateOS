/**
 * 运维检查器手风琴样式（ns-i-* 前缀，由主代理合并进 STUDIO_CSS）
 * - 仅使用 styles.ts 已定义的 --ns-* 变量，暗色与浅色主题自动适配
 * - 静态样式全部集中于此，组件内只保留 width 等纯动态内联值
 */
export const INSPECTOR_CSS = `
/* 顶部工具行与分组列表 */
.ns-i-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 9px;
    border-bottom: 1px solid var(--ns-border-1);
    flex-shrink: 0;
}

.ns-i-toolbar-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--ns-text-1);
    letter-spacing: 0.01em;
    white-space: nowrap;
}

.ns-i-toolbar-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}

.ns-i-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
    min-width: 0;
}

/* 手风琴分组容器 */
.ns-i-acc {
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-lg);
    background: var(--ns-bg-card);
    overflow: hidden;
    min-width: 0;
}

.ns-i-acc-head {
    width: 100%;
    min-height: 36px;
    padding: 8px 10px;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: transparent;
    color: var(--ns-text-1);
    font-family: var(--ns-font-sans);
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
}

.ns-i-acc-head:hover {
    background: var(--ns-bg-hover);
}

.ns-i-acc-head[aria-expanded="true"] {
    border-bottom: 1px solid var(--ns-border-1);
}

.ns-i-acc-title {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 500;
    color: var(--ns-text-1);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-i-sum {
    flex-shrink: 0;
    font-family: var(--ns-font-mono);
    font-size: 11px;
    line-height: 1.3;
    white-space: nowrap;
}

.ns-i-sum-quiet {
    color: var(--ns-text-4);
}

.ns-i-sum-alert {
    color: var(--ns-amber-ink);
}

.ns-i-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
}

.ns-i-dot-green {
    background: var(--ns-green);
}

.ns-i-dot-amber {
    background: var(--ns-amber);
}

.ns-i-dot-red {
    background: var(--ns-red);
}

.ns-i-dot-idle {
    background: var(--ns-text-4);
}

.ns-i-chevron {
    flex-shrink: 0;
    font-size: 12px;
    line-height: 1;
    color: var(--ns-text-4);
    transition: transform 0.18s var(--ns-ease);
}

.ns-i-acc-head[aria-expanded="true"] .ns-i-chevron {
    transform: rotate(90deg);
}

.ns-i-acc-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    min-width: 0;
    font-size: 12px;
    color: var(--ns-text-2);
}

.ns-i-acc-body[hidden] {
    display: none;
}

/* 分组内卡片与通用文本 */
.ns-i-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    min-width: 0;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-lg);
    background: var(--ns-bg-surface-2);
}

.ns-i-card-halt {
    border-color: var(--ns-red-line);
    background: var(--ns-red-soft);
}

.ns-i-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 8px;
    min-width: 0;
    font-size: 11px;
    font-weight: 500;
    color: var(--ns-text-3);
    letter-spacing: 0.02em;
}

.ns-i-card-head > span {
    min-width: 0;
    overflow-wrap: anywhere;
}

.ns-i-text-2 {
    font-size: 12px;
    color: var(--ns-text-2);
    overflow-wrap: anywhere;
}

.ns-i-text-3 {
    font-size: 11.5px;
    color: var(--ns-text-3);
    overflow-wrap: anywhere;
}

.ns-i-green-ink {
    color: var(--ns-green-ink);
}

.ns-i-amber-ink {
    color: var(--ns-amber-ink);
}

.ns-i-red-ink {
    color: var(--ns-red-ink);
}

.ns-i-muted {
    color: var(--ns-text-4);
}

.ns-i-head-value {
    color: var(--ns-text-2);
}

.ns-i-strong {
    font-weight: 500;
}

.ns-i-empty {
    font-size: 12px;
    color: var(--ns-text-4);
}

.ns-i-big {
    font-family: var(--ns-font-display);
    font-size: 28px;
    font-weight: 300;
    line-height: 1.1;
    color: var(--ns-text-1);
}

.ns-i-big-unit {
    margin-left: 1px;
    font-size: 14px;
    color: var(--ns-text-4);
}

.ns-i-prog-top {
    margin-top: 2px;
}

.ns-i-prog-flat {
    margin-top: 0;
}

.ns-i-fill-green {
    background: var(--ns-green);
}

.ns-i-fill-brand {
    background: var(--ns-brand);
}

.ns-i-fill-amber {
    background: var(--ns-amber);
}

.ns-i-fill-violet {
    background: var(--ns-violet);
}

/* 四联指标 */
.ns-i-metric-k-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
}

.ns-i-metric-note {
    font-size: 10.5px;
    color: var(--ns-text-4);
}

/* Token 与预算分布条 */
.ns-i-bar {
    display: flex;
    gap: 2px;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--ns-bg-hover);
}

.ns-i-bar-seg {
    height: 100%;
    flex-shrink: 0;
}

.ns-i-seg-in {
    background: var(--ns-text-3);
}

.ns-i-seg-green {
    background: var(--ns-green);
}

.ns-i-seg-amber {
    background: var(--ns-amber);
}

.ns-i-seg-brand {
    background: var(--ns-brand);
}

.ns-i-bar-legend {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--ns-text-4);
}

/* Token 统计范围辅助说明：口径边界常驻可见 */
.ns-i-scope-note {
    margin-top: 4px;
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--ns-text-4);
}

.ns-i-budget-total {
    font-size: 11.5px;
    color: var(--ns-text-2);
}

.ns-i-budget-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 11px;
    color: var(--ns-text-4);
}

/* 三池模型路由：长模型名截断并保留 title 提示 */
.ns-i-route-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-i-route {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 52%);
    gap: 2px 8px;
    min-width: 0;
    padding: 8px 10px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-hover);
    font-size: 12px;
}

.ns-i-route-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-i-route-model {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    font-size: 11px;
}

.ns-i-route-model-brand {
    color: var(--ns-brand-ink);
}

.ns-i-route-model-green {
    color: var(--ns-green-ink);
}

.ns-i-route-model-amber {
    color: var(--ns-amber-ink);
}

.ns-i-route-role {
    grid-column: 1 / -1;
    font-size: 10.5px;
    color: var(--ns-text-4);
    overflow-wrap: anywhere;
}

/* 活跃实体 */
.ns-i-entity-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-i-entity {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-hover);
}

.ns-i-entity-warped {
    border: 1px dashed var(--ns-violet);
}

.ns-i-entity-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 9px 10px;
    border: 0;
    background: transparent;
    color: var(--ns-text-1);
    font-family: var(--ns-font-sans);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
}

.ns-i-entity-btn:hover {
    background: var(--ns-bg-press);
}

.ns-i-entity-avatar {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--ns-brand-fill);
    color: #fff;
    font-size: 12px;
    font-weight: 500;
}

.ns-i-entity-avatar-warped {
    background: var(--ns-violet);
}

.ns-i-entity-main {
    flex: 1;
    min-width: 0;
}

.ns-i-entity-name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-i-entity-meta {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--ns-text-4);
}

.ns-i-entity-brief {
    padding: 0 10px 8px 44px;
    font-size: 11.5px;
    color: var(--ns-text-3);
    overflow-wrap: anywhere;
}

/* Spotlight 与伏笔 */
.ns-i-spotlight-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}

.ns-i-spotlight-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    font-size: 12px;
}

.ns-i-spotlight-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-i-spotlight-row > :last-child {
    flex-shrink: 0;
}

.ns-i-thread-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-i-thread {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-hover);
    font-size: 12px;
}

.ns-i-thread-ch {
    color: var(--ns-text-4);
}

.ns-i-thread-main {
    min-width: 0;
}

.ns-i-thread-title {
    color: var(--ns-text-1);
    overflow-wrap: anywhere;
}

.ns-i-thread-hint {
    font-size: 10.5px;
    color: var(--ns-text-4);
    overflow-wrap: anywhere;
}

/* WAL 相位四格与提交信息 */
.ns-i-wal-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
}

.ns-i-wal-cell {
    padding: 6px 2px;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-hover);
    color: var(--ns-text-4);
    font-size: 9.5px;
    text-align: center;
    overflow-wrap: anywhere;
}

.ns-i-wal-done {
    color: var(--ns-green-ink);
    background: var(--ns-green-soft);
    border-color: var(--ns-border-1);
}

.ns-i-wal-cur {
    color: var(--ns-brand-ink);
    background: var(--ns-brand-soft);
    border-color: var(--ns-brand-line);
}

.ns-i-wal-halt {
    color: var(--ns-red-ink);
    background: var(--ns-red-soft);
    border-color: var(--ns-red-line);
}

.ns-i-wal-idle {
    color: var(--ns-text-4);
    background: var(--ns-bg-hover);
    border-color: var(--ns-border-1);
}

.ns-i-lock-holder {
    font-size: 11.5px;
    color: var(--ns-amber-ink);
    overflow-wrap: anywhere;
}

.ns-i-commit-sha {
    font-size: 11px;
    color: var(--ns-text-4);
    overflow-wrap: anywhere;
}

/* SAFE_HALT 诊断 */
.ns-i-halt-reason {
    font-size: 12px;
    color: var(--ns-text-1);
    overflow-wrap: anywhere;
}

.ns-i-halt-refs {
    font-size: 11px;
    color: var(--ns-text-2);
    overflow-wrap: anywhere;
}

.ns-i-halt-excerpt {
    margin-top: 4px;
}

.ns-i-halt-excerpt-tight {
    margin-top: 2px;
}

.ns-i-halt-scope {
    font-size: 11px;
    color: var(--ns-text-3);
    overflow-wrap: anywhere;
}

/* 卷纲 */
.ns-i-vol-meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--ns-text-4);
}

.ns-i-future {
    font-size: 12px;
    color: var(--ns-text-2);
    line-height: 1.6;
    overflow-wrap: anywhere;
}

.ns-i-milestone {
    padding: 8px 10px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-hover);
    font-size: 11.5px;
    color: var(--ns-text-3);
    overflow-wrap: anywhere;
}

/* 门禁规则行 */
.ns-i-rule-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.ns-i-rule {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 7px 9px;
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-hover);
}

.ns-i-rule-main {
    min-width: 0;
}

.ns-i-rule-id {
    font-size: 11px;
    color: var(--ns-text-1);
    overflow-wrap: anywhere;
}

.ns-i-rule-label {
    font-size: 10.5px;
    color: var(--ns-text-4);
    overflow-wrap: anywhere;
}

.ns-i-rule-count {
    font-size: 10.5px;
    color: var(--ns-text-4);
    white-space: nowrap;
}

.ns-i-rule-count-on {
    color: var(--ns-amber-ink);
}

/* 分角色两层模型覆盖配置卡片 */
.ns-i-role-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.ns-i-role-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-md);
    background: var(--ns-bg-hover);
}

.ns-i-role-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
}

.ns-i-role-id {
    font-size: 11.5px;
    font-weight: 500;
    color: var(--ns-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-i-role-pool {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--ns-text-4);
    white-space: nowrap;
}

.ns-i-role-effective {
    font-size: 11px;
    color: var(--ns-brand-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ns-i-role-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 88px);
    gap: 6px;
    min-width: 0;
}

.ns-i-role-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.ns-i-role-field-full {
    grid-column: 1 / -1;
}

.ns-i-role-label {
    font-size: 10px;
    color: var(--ns-text-4);
}

.ns-i-select,
.ns-i-input {
    width: 100%;
    min-width: 0;
    height: 26px;
    padding: 0 7px;
    box-sizing: border-box;
    border: 1px solid var(--ns-border-2);
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-base);
    color: var(--ns-text-1);
    font-family: var(--ns-font-sans);
    font-size: 11px;
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ns-i-input {
    font-family: var(--ns-font-mono);
}

.ns-i-input::placeholder {
    color: var(--ns-text-4);
}

.ns-i-select:focus,
.ns-i-input:focus {
    border-color: var(--ns-brand-line);
    box-shadow: 0 0 0 2px var(--ns-brand-soft);
}

.ns-i-select:disabled,
.ns-i-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.ns-i-role-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 2px;
}

.ns-i-role-feedback {
    font-size: 11px;
    line-height: 1.4;
    overflow-wrap: anywhere;
}

.ns-i-stage-sessions {
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--ns-border-1);
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ns-i-stage-sessions-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--ns-text-3);
}

.ns-i-stage-sessions-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.ns-i-stage-session-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--ns-border-1);
    border-radius: var(--ns-r-sm);
    background: var(--ns-bg-base);
    color: var(--ns-text-2);
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
}

.ns-i-stage-session-item:hover:not(:disabled) {
    border-color: var(--ns-brand-line);
    background: var(--ns-bg-hover);
}

.ns-i-stage-session-item:disabled {
    opacity: 0.6;
    cursor: default;
}

.ns-i-stage-session-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
}

.ns-i-stage-session-stage {
    font-size: 11px;
    font-weight: 500;
    color: var(--ns-text-1);
}

.ns-i-stage-session-reason {
    font-size: 11px;
    line-height: 1.4;
    color: var(--ns-text-3);
    overflow-wrap: anywhere;
}

.ns-i-stage-session-id {
    font-size: 10.5px;
    word-break: break-all;
}
`;

import type React from 'react';

/** 水平页签的自动激活键盘协议；复用按钮点击路径，保留视图加载与焦点。 */
export function handleTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const current = tabs.findIndex((tab) => tab.contains(event.target));
    if (current < 0 || tabs.length === 0) return;
    const index = event.key === 'Home' ? 0
        : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[index]?.focus();
    tabs[index]?.click();
}

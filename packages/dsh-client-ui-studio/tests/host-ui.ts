import React from 'react';
import { createPortal } from 'react-dom';

interface TestModalProps {
    open: boolean;
    title: string;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    onClose: () => void;
    closeLabel?: string;
    className?: string;
    contentClassName?: string;
}

/** 仅替换宿主适配边界；被测编辑器仍使用真实 React 状态、effect 与 DOM 事件。 */
export function Modal({ open, title, children, footer, onClose, closeLabel = '关闭', className, contentClassName }: TestModalProps) {
    if (!open) return null;
    return createPortal(
        React.createElement('section', { role: 'dialog', 'aria-label': title, className },
            React.createElement('button', { type: 'button', onClick: onClose, 'aria-label': closeLabel }, closeLabel),
            React.createElement('div', { className: contentClassName }, children),
            footer
        ),
        document.body
    );
}

export function Toast({ text }: { text: string }) {
    return createPortal(React.createElement('div', { role: 'status' }, text), document.body);
}

export function Button({ children, variant: _variant, size: _size, icon, ...props }: Record<string, unknown>) {
    return React.createElement('button', props, icon, children);
}

/**
 * 宿主 UI 原语环境声明：
 * 运行时由 DSH 宿主 staticModules 种子表注入 `@deepseek-ai/dsh-client-ui-primitives`
 * （bundle 脚本对非相对 require 原样透传 hostRequire，seed 必命中）。
 * 本仓库未安装该包，故用 ambient module 补齐类型；React 类型复用 react-shims.d.ts
 * 的全局 React 命名空间，避免引入 @types/react。
 * 该库样式只消费宿主 --dsw-* 令牌，自动跟随宿主明暗主题。
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
    /**
     * 宿主模态框：
     * - body portal；Escape、遮罩点击、关闭按钮统一回调 onClose，关闭后恢复焦点
     * - 初始焦点取自 DOM 属性 data-modal-autofocus（滚动首帧执行，勿用 React autoFocus）
     * - headless 时不渲染默认头部与关闭按钮，仅保留遮罩、卡片与 Escape
     */
    export type ModalProps = {
        open: boolean;
        onClose: () => void;
        title: string;
        description?: string;
        children?: React.ReactNode;
        footer?: React.ReactNode;
        className?: string;
        contentClassName?: string;
        backdropBlur?: boolean;
    } & ({ headless: true } | { headless?: false; closeLabel: string });

    export const Modal: React.FC<ModalProps>;

    /** 宿主轻提示：淡出完成后回调 onDone，调用方必须在 onDone 中卸载自身 */
    export interface ToastProps {
        text: string;
        tone?: 'success';
        icon?: React.ReactNode;
        holdMs?: number;
        actions?: React.ReactNode;
        onDone: () => void;
    }

    export const Toast: React.FC<ToastProps>;

    /** 宿主按钮：变体与尺寸由宿主 --dsw-* 令牌驱动，其余属性透传原生 button */
    export type ButtonProps = React.IntrinsicElementProps & {
        variant?: 'primary' | 'ghost' | 'outline' | 'toolbar';
        size?: 'md' | 'sm';
        icon?: React.ReactNode;
    };

    export const Button: React.FC<ButtonProps>;
}

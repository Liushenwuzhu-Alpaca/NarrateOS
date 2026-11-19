/**
 * 前端客户端最小化类型垫片：
 * 运行时由 DSH 宿主浏览器环境注入 React 18 与 Cordis，
 * 此声明文件确保在无 @types/react 的环境中也能通过 tsc 严格检查。
 */

declare namespace React {
    type ReactNode =
        | ReactElement
        | string
        | number
        | boolean
        | null
        | undefined
        | Iterable<ReactNode>;

    interface ReactElement<P = any> {
        type: any;
        props: P;
        key: string | null;
    }

    type FC<P = Record<string, never>> = (props: P) => ReactElement | null;
    type ComponentType<P = Record<string, never>> = (props: P) => ReactElement | null;
    type CSSProperties = Record<string, string | number | undefined>;

    interface IntrinsicElementProps {
        children?: ReactNode;
        className?: string | undefined;
        style?: CSSProperties | undefined;
        [key: string]: any;
    }
}

declare namespace JSX {
    type Element = React.ReactElement;
    interface ElementChildrenAttribute {
        children: {};
    }
    interface IntrinsicElements {
        [elemName: string]: React.IntrinsicElementProps;
    }
    interface IntrinsicAttributes {
        key?: string | number | null | undefined;
    }
}

declare module 'react' {
    export type ReactNode = React.ReactNode;
    export type ReactElement<P = any> = React.ReactElement<P>;
    export type FC<P = Record<string, never>> = React.FC<P>;
    export type ComponentType<P = Record<string, never>> = React.ComponentType<P>;
    export type CSSProperties = React.CSSProperties;

    const ReactDefault: Record<string, any>;
    export default ReactDefault;
}

declare module 'react/jsx-runtime' {
    export namespace JSX {
        type Element = React.ReactElement;
        interface ElementChildrenAttribute {
            children: {};
        }
        interface IntrinsicElements {
            [elemName: string]: React.IntrinsicElementProps;
        }
        interface IntrinsicAttributes {
            key?: string | number | null | undefined;
        }
    }
    export function jsx(
        type: any,
        props: Record<string, any>,
        key?: string | number
    ): React.ReactElement;
    export function jsxs(
        type: any,
        props: Record<string, any>,
        key?: string | number
    ): React.ReactElement;
}

declare module '@deepseek-ai/cordis' {
    export interface Context {
        [key: string]: any;
    }
    export const Context: any;
}

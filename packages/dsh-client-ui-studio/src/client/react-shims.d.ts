/**
 * 前端客户端最小化类型垫片：
 * 运行时由 DSH 宿主浏览器环境通过 staticModules 注入 React 18 与 Cordis，
 * 此声明文件为纯环境声明（无顶层 import/export），确保无 @types/react 时也能通过 tsc 检查。
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

    interface Context<T> {
        Provider: ComponentType<{ value: T; children?: ReactNode }>;
        Consumer: ComponentType<{ children: (value: T) => ReactNode }>;
    }

    type CSSProperties = Record<string, string | number | undefined>;

    interface SyntheticEvent<T = Element> {
        currentTarget: T;
        target: EventTarget & T;
        preventDefault(): void;
        stopPropagation(): void;
    }

    interface ChangeEvent<T = Element> extends SyntheticEvent<T> {}
    interface FormEvent<T = Element> extends SyntheticEvent<T> {}
    interface MouseEvent<T = Element> extends SyntheticEvent<T> {
        button: number;
        clientX: number;
        clientY: number;
    }
    interface PointerEvent<T = Element> extends MouseEvent<T> {
        pointerId: number;
    }
    interface KeyboardEvent<T = Element> extends SyntheticEvent<T> {
        key: string;
        ctrlKey: boolean;
        metaKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
    }

    interface MutableRefObject<T> {
        current: T;
    }

    interface RefObject<T> {
        readonly current: T | null;
    }

    interface IntrinsicElementProps {
        children?: ReactNode;
        className?: string | undefined;
        style?: CSSProperties | undefined;
        onClick?: ((e: any) => void) | undefined;
        onChange?: ((e: any) => void) | undefined;
        onInput?: ((e: any) => void) | undefined;
        onSubmit?: ((e: any) => void) | undefined;
        onKeyDown?: ((e: any) => void) | undefined;
        onKeyUp?: ((e: any) => void) | undefined;
        onFocus?: ((e: any) => void) | undefined;
        onBlur?: ((e: any) => void) | undefined;
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
    export type Context<T> = React.Context<T>;
    export type CSSProperties = React.CSSProperties;
    export type SyntheticEvent<T = Element> = React.SyntheticEvent<T>;
    export type ChangeEvent<T = Element> = React.ChangeEvent<T>;
    export type FormEvent<T = Element> = React.FormEvent<T>;
    export type MouseEvent<T = Element> = React.MouseEvent<T>;
    export type PointerEvent<T = Element> = React.PointerEvent<T>;
    export type KeyboardEvent<T = Element> = React.KeyboardEvent<T>;
    export type MutableRefObject<T> = React.MutableRefObject<T>;
    export type RefObject<T> = React.RefObject<T>;

    export function useState<S>(
        initialState: S | (() => S)
    ): [S, (value: S | ((prev: S) => S)) => void];
    export function useState<S = undefined>(): [
        S | undefined,
        (value: S | undefined | ((prev: S | undefined) => S | undefined)) => void
    ];

    export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
    export function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T;
    export function useCallback<T extends (...args: any[]) => any>(
        callback: T,
        deps: readonly unknown[]
    ): T;
    export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
    export function useRef<T>(initialValue: T): MutableRefObject<T>;
    export function useRef<T>(initialValue: T | null): RefObject<T>;
    export function useRef<T = undefined>(): MutableRefObject<T | undefined>;
    export function createContext<T>(defaultValue: T): Context<T>;
    export function useContext<T>(context: Context<T>): T;

    export const Fragment: (props: {
        children?: React.ReactNode;
        key?: string | number | null | undefined;
    }) => React.ReactElement | null;

    const ReactDefault: {
        Fragment: typeof Fragment;
        useState: typeof useState;
        useEffect: typeof useEffect;
        useCallback: typeof useCallback;
        useMemo: typeof useMemo;
        useRef: typeof useRef;
        createContext: typeof createContext;
        useContext: typeof useContext;
    };
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
    export const Fragment: (props: {
        children?: React.ReactNode;
        key?: string | number | null | undefined;
    }) => React.ReactElement | null;
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

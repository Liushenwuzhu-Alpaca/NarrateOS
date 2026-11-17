import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
    BookStore,
    DreamingRunner,
    LlmPool,
    NarrativeEngine,
    SystemPort
} from '@narrateos/core';

/** 兼容 @deepseek-ai/dsh-llm 的文本内容块 */
export interface DshTextBlock {
    type: 'text';
    text: string;
}

/** 兼容 @deepseek-ai/dsh-llm 的通用内容块 */
export type DshContentBlock =
    | DshTextBlock
    | { type: string; [key: string]: unknown };

/** 兼容 @deepseek-ai/dsh-llm 的单轮请求用户消息 */
export interface DshRequestMessage {
    readonly role: 'user';
    readonly content: readonly DshTextBlock[];
}

/** 兼容 @deepseek-ai/dsh-llm 的失败信息 */
export interface DshLlmFailure {
    readonly message: string;
    readonly code: string;
    readonly status?: number;
    readonly providerRetryAfterMs?: number;
    readonly requestId?: string;
}

/** 兼容 @deepseek-ai/dsh-llm 的结束原因 */
export type DshFinishReason =
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
    | { kind: 'aborted'; failure: DshLlmFailure }
    | { kind: 'error'; failure: DshLlmFailure }
    | { kind: string; failure?: DshLlmFailure };

/** 兼容 @deepseek-ai/dsh-llm 的 Token 用量结构 */
export interface DshLlmTokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}

/** 兼容 @deepseek-ai/dsh-llm 的流式分片 */
export type DshStreamChunk =
    | { type: 'block-start'; index: number; blockType: string }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'block-end'; index: number; block: DshContentBlock }
    | { type: 'usage'; usage: DshLlmTokenUsage }
    | { type: 'finish'; reason: DshFinishReason }
    | { type: string; [key: string]: unknown };

/** 兼容 @deepseek-ai/dsh-llm 的生成请求选项（净室无 sessionId） */
export interface DshGenerateOptions {
    provider: string;
    model: string;
    messages: DshRequestMessage[];
    system?: string;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: string;
    signal?: AbortSignal;
}

/** 兼容 @deepseek-ai/dsh-llm 的 LlmRuntime 窄接口 */
export interface DshLlmService {
    stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>;
}

/** 兼容 @deepseek-ai/dsh-host-webserver 的 HTTP 路由处理器 */
export type DshHttpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** 兼容 @deepseek-ai/dsh-host-webserver 的路由注册项 */
export interface DshWebServerRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: DshHttpHandler;
}

/** 兼容 @deepseek-ai/dsh-host-webserver 的 WebServer 服务窄接口 */
export interface DshWebServerService {
    register(route: DshWebServerRoute): () => void;
}

/** 兼容 @deepseek-ai/cordis 的上下文窄接口 */
export interface DshCordisContext {
    llm: DshLlmService;
    webServer: DshWebServerService;
    effect(
        callback: () => (() => void | Promise<void>) | void,
        label?: string
    ): () => void;
}

/** 单个模型池路由目标 */
export interface LlmRouteTarget {
    provider: string;
    model: string;
}

/** 三个模型池的路由映射 */
export type LlmPoolRouting = Record<LlmPool, LlmRouteTarget>;

/** DshLlmAdapter 配置选项 */
export interface DshLlmAdapterOptions {
    poolRouting: LlmPoolRouting;
    resolveModelRouting?: () => Promise<Record<string, string>>;
    maxRetries?: number;
    backoffMs?: readonly number[];
    retryableCodes?: readonly string[];
    sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 插件配置项 */
export interface NarratePluginConfig {
    bookRoot: string;
    booksRoot?: string;
    poolRouting: LlmPoolRouting;
    llmRetry?: {
        maxRetries?: number;
        backoffMs?: readonly number[];
        retryableCodes?: readonly string[];
    };
    heartbeatIntervalMs?: number;
    shutdownTimeoutMs?: number;
    /** 可选覆盖注入（供单测或自定义装配使用） */
    system?: SystemPort;
    store?: BookStore;
    engine?: NarrativeEngine;
    dreamingRunner?: DreamingRunner;
}

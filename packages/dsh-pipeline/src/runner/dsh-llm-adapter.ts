import {
    ReasoningEffortId,
    type GenerateOptions,
    type LlmFailure,
    type LlmRuntime,
    type StreamChunk
} from '@deepseek-ai/dsh-llm';
import {
    sleepWithSignal,
    traceArtifact,
    traceEvent,
    type BookConfig,
    type CleanroomRequest,
    type CleanroomResponse,
    type LlmPool,
    type LlmPort,
    type TokenUsage
} from '@narrateos/dsh-book-store';
import type { LlmPoolRouting, LlmRouteTarget } from '../schemas.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
const DEFAULT_RETRYABLE_CODES = new Set<string>([
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'EMPTY_RESPONSE'
]);
const RETRYABLE_HTTP_STATUSES = new Set<number>([429, 500, 502, 503, 504]);
const RETRYABLE_NODE_CODES = new Set<string>([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE'
]);

/** DshLlmAdapter 配置选项 */
export interface DshLlmAdapterOptions {
    poolRouting: LlmPoolRouting;
    resolveModelRouting?: () => Promise<Record<string, string> | undefined>;
    maxRetries?: number | undefined;
    backoffMs?: readonly number[] | undefined;
    retryableCodes?: readonly string[] | undefined;
    sleepFn?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

/** @deepseek-ai/dsh-llm 流式调用失败错误 */
export class DshStreamError extends Error {
    readonly failure: LlmFailure;

    constructor(failure: LlmFailure) {
        super(`[${failure.code}] ${failure.message}`);
        this.name = 'DshStreamError';
        this.failure = failure;
    }
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
        return true;
    }
    if (err instanceof Error) {
        if (err.name === 'AbortError') return true;
        if (err instanceof DshStreamError && err.failure.code === 'ABORTED') return true;
    }
    return false;
}

function isTransientError(err: unknown, retryableCodes: ReadonlySet<string>): boolean {
    if (err instanceof DshStreamError) {
        if (retryableCodes.has(err.failure.code)) {
            return true;
        }
        if (err.failure.status !== undefined && RETRYABLE_HTTP_STATUSES.has(err.failure.status)) {
            return true;
        }
        return false;
    }

    if (err instanceof Error) {
        const nodeCode = (err as { code?: unknown }).code;
        if (typeof nodeCode === 'string' && RETRYABLE_NODE_CODES.has(nodeCode)) {
            return true;
        }
        const status = (err as { status?: unknown }).status;
        if (typeof status === 'number' && RETRYABLE_HTTP_STATUSES.has(status)) {
            return true;
        }
        const msg = err.message.toLowerCase();
        if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout')) {
            return true;
        }
    }
    return false;
}

function resolveRetryDelay(
    err: unknown,
    attempt: number,
    backoffMs: readonly number[]
): number {
    if (err instanceof DshStreamError) {
        const retryAfter = err.failure.providerRetryAfterMs;
        if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
            return Math.min(retryAfter, 60_000);
        }
    }
    return backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 4000;
}

/** 按模型池解析 provider 与 model（支持 book_config.yaml 的 model_routing 单书覆盖） */
export function resolvePoolRoute(
    poolRouting: LlmPoolRouting,
    pool: LlmPool,
    bookConfig?: Pick<BookConfig, 'model_routing'> | Record<string, string> | undefined
): LlmRouteTarget {
    const base = poolRouting[pool];
    if (!base) {
        throw new Error(`未配置模型池路由: ${pool}`);
    }
    const routingMap =
        bookConfig && 'model_routing' in bookConfig
            ? (bookConfig as Pick<BookConfig, 'model_routing'>).model_routing
            : (bookConfig as Record<string, string> | undefined);
    const override = routingMap?.[pool]?.trim();
    if (!override) {
        return { provider: base.provider, model: base.model };
    }
    return { provider: base.provider, model: override };
}

/**
 * 基于 @deepseek-ai/dsh-llm 的 LlmPort 适配器：
 * - 无 sessionId / 无 tools 净室单轮流式调用；
 * - 仅拼接 text-delta / text block-end 正文（隔离 reasoning-delta）；
 * - 标准化 TokenUsage 并对瞬时错误执行指数退避重试。
 */
export class DshLlmAdapter implements LlmPort {
    private readonly poolRouting: LlmPoolRouting;
    private readonly maxRetries: number;
    private readonly backoffMs: readonly number[];
    private readonly retryableCodes: Set<string>;
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly resolveModelRouting: DshLlmAdapterOptions['resolveModelRouting'];

    constructor(
        private readonly llm: Pick<LlmRuntime, 'stream'>,
        options: DshLlmAdapterOptions
    ) {
        this.poolRouting = options.poolRouting;
        this.resolveModelRouting = options.resolveModelRouting;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
        this.retryableCodes = options.retryableCodes
            ? new Set(options.retryableCodes)
            : DEFAULT_RETRYABLE_CODES;
        this.sleepFn = options.sleepFn ?? sleepWithSignal;
    }

    async generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse> {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        }

        const modelRouting = await this.resolveModelRouting?.();
        const route = resolvePoolRoute(this.poolRouting, req.pool, modelRouting);

        const options: GenerateOptions = {
            provider: route.provider,
            model: route.model,
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'text', text: req.dynamicTail }]
                }
            ]
        };

        const systemPrompt = req.staticPrefixBlocks.join('\n\n');
        if (systemPrompt.length > 0) {
            options.system = systemPrompt;
        }
        if (req.temperature !== undefined) {
            options.temperature = req.temperature;
        }
        if (req.maxTokens !== undefined) {
            options.maxTokens = req.maxTokens;
        }
        if (req.reasoningEffort !== undefined) {
            options.reasoningEffort = ReasoningEffortId(req.reasoningEffort);
        }
        if (signal !== undefined) {
            options.signal = signal;
        }

        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            if (attempt > 0) {
                await traceEvent('transport.retry', { attempt: attempt + 1 });
                const delayMs = resolveRetryDelay(lastError, attempt - 1, this.backoffMs);
                await this.sleepFn(delayMs, signal);
            }

            await traceEvent('transport.started', {
                attempt: attempt + 1,
                model: options.model,
                provider: options.provider
            });

            try {
                return await this.consumeStream(options, options.model, signal);
            } catch (err: unknown) {
                lastError = err;
                if (isAbortError(err, signal)) {
                    throw err;
                }
                if (attempt >= this.maxRetries || !isTransientError(err, this.retryableCodes)) {
                    throw err;
                }
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async consumeStream(
        options: GenerateOptions,
        modelId: string,
        signal?: AbortSignal
    ): Promise<CleanroomResponse> {
        const textParts: string[] = [];
        const deltaSeenIndices = new Set<number>();
        const usage: TokenUsage = {
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0
        };
        let finishReason: string | undefined;

        try {
            for await (const chunk of this.llm.stream(options) as AsyncIterable<StreamChunk>) {
                if (signal?.aborted) {
                    throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
                }

                switch (chunk.type) {
                    case 'text-delta': {
                        deltaSeenIndices.add(chunk.index);
                        textParts.push(chunk.text);
                        break;
                    }
                    case 'block-end': {
                        if (
                            chunk.block.type === 'text' &&
                            !deltaSeenIndices.has(chunk.index)
                        ) {
                            textParts.push(chunk.block.text);
                        }
                        break;
                    }
                    case 'usage': {
                        usage.inputTokens = chunk.usage.inputTokens;
                        usage.cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
                        usage.cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
                        usage.outputTokens = chunk.usage.outputTokens;
                        break;
                    }
                    case 'finish': {
                        if (chunk.reason.kind === 'error') {
                            throw new DshStreamError(
                                chunk.reason.failure ?? {
                                    code: 'UNKNOWN',
                                    message: 'LLM 流返回未知错误'
                                }
                            );
                        }
                        if (chunk.reason.kind === 'aborted') {
                            const abortErr = new Error(
                                chunk.reason.failure?.message ?? 'LLM 请求已取消'
                            );
                            abortErr.name = 'AbortError';
                            throw abortErr;
                        }
                        finishReason = chunk.reason.kind;
                        break;
                    }
                    default:
                        break;
                }
            }
        } catch (error) {
            if (textParts.length > 0) {
                await traceArtifact('transport.partial', {
                    text: textParts.join(''),
                    modelId,
                    incomplete: true
                });
            }
            throw error;
        }

        const response: CleanroomResponse = {
            text: textParts.join(''),
            usage,
            modelId
        };
        if (finishReason !== undefined) {
            response.finishReason = finishReason;
        }
        return response;
    }
}

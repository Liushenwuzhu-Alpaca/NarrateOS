import {
    sleepWithSignal,
    type CleanroomRequest,
    type CleanroomResponse,
    type LlmPort,
    type TokenUsage
} from '@narrateos/core';
import type {
    DshGenerateOptions,
    DshLlmAdapterOptions,
    DshLlmFailure,
    DshLlmService,
    LlmPoolRouting
} from './types.js';

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

/** dsh-llm 流式调用失败错误 */
export class DshStreamError extends Error {
    readonly failure: DshLlmFailure;

    constructor(failure: DshLlmFailure) {
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

/**
 * 基于 @deepseek-ai/dsh-llm 的 LlmPort 适配器：
 * - 无 sessionId / 无 tools 净室单轮流式调用
 * - 仅拼接 text-delta / text block-end 正文（隔离 reasoning-delta）
 * - 标准化 TokenUsage 并对瞬时错误执行指数退避重试
 */
export class DshLlmAdapter implements LlmPort {
    private readonly poolRouting: LlmPoolRouting;
    private readonly maxRetries: number;
    private readonly backoffMs: readonly number[];
    private readonly retryableCodes: Set<string>;
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

    constructor(
        private readonly llm: DshLlmService,
        options: DshLlmAdapterOptions
    ) {
        this.poolRouting = options.poolRouting;
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

        const route = this.poolRouting[req.pool];
        if (!route) {
            throw new Error(`未配置模型池路由: ${req.pool}`);
        }

        const options: DshGenerateOptions = {
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
            options.reasoningEffort = req.reasoningEffort;
        }
        if (signal !== undefined) {
            options.signal = signal;
        }

        let lastError: unknown;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) {
                const delayMs = resolveRetryDelay(lastError, attempt - 1, this.backoffMs);
                await this.sleepFn(delayMs, signal);
            }

            try {
                return await this.consumeStream(options, route.model, signal);
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
        options: DshGenerateOptions,
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

        for await (const chunk of this.llm.stream(options)) {
            if (signal?.aborted) {
                throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
            }

            switch (chunk.type) {
                case 'text-delta': {
                    const index = (chunk as { index: number }).index;
                    const text = (chunk as { text: string }).text;
                    deltaSeenIndices.add(index);
                    textParts.push(text);
                    break;
                }
                case 'block-end': {
                    const index = (chunk as { index: number }).index;
                    const block = (chunk as { block: { type: string; text?: unknown } }).block;
                    if (
                        block.type === 'text' &&
                        typeof block.text === 'string' &&
                        !deltaSeenIndices.has(index)
                    ) {
                        textParts.push(block.text);
                    }
                    break;
                }
                case 'usage': {
                    const u = (chunk as {
                        usage: {
                            inputTokens: number;
                            outputTokens: number;
                            cacheReadTokens?: number;
                            cacheWriteTokens?: number;
                        };
                    }).usage;
                    usage.inputTokens = u.inputTokens;
                    usage.cacheReadTokens = u.cacheReadTokens ?? 0;
                    usage.cacheWriteTokens = u.cacheWriteTokens ?? 0;
                    usage.outputTokens = u.outputTokens;
                    break;
                }
                case 'finish': {
                    const reason = (chunk as {
                        reason: { kind: string; failure?: DshLlmFailure };
                    }).reason;
                    if (reason.kind === 'error') {
                        throw new DshStreamError(
                            reason.failure ?? {
                                code: 'UNKNOWN',
                                message: 'LLM 流返回未知错误'
                            }
                        );
                    }
                    if (reason.kind === 'aborted') {
                        const abortErr = new Error(reason.failure?.message ?? 'LLM 请求已取消');
                        abortErr.name = 'AbortError';
                        throw abortErr;
                    }
                    finishReason = reason.kind;
                    break;
                }
                default:
                    break;
            }
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

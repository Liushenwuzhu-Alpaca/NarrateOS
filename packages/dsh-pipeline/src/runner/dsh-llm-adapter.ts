import {
    ReasoningEffortId,
    type GenerateOptions,
    type LlmFailure,
    type LlmRuntime,
    type StreamChunk
} from '@deepseek-ai/dsh-llm';
import {
    normalizeLlmPool,
    sleepWithSignal,
    traceArtifact,
    traceEvent,
    type BookConfig,
    type CleanroomRequest,
    type CleanroomResponse,
    type LlmPool,
    type LlmPort,
    type ReasoningEffortLevel,
    type RoleModelOverride,
    type TokenUsage
} from '@narrateos/dsh-book-store';
import { isAbortError } from '../pipeline/helpers.js';
import type { LlmPoolRouting, LlmRouteTarget } from '../schemas.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
const DEFAULT_RETRYABLE_CODES = new Set<string>([
    'RATE_LIMIT',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'EMPTY_RESPONSE',
    'MALFORMED_RESPONSE'
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
    resolvePoolRouting?: (() => LlmPoolRouting) | undefined;
    ensurePoolRoutingReady?: (() => Promise<void>) | undefined;
    resolveModelRouting?: () => Promise<Record<string, string> | undefined>;
    resolveBookConfig?:
        | (() => Promise<Pick<BookConfig, 'model_routing' | 'role_routing'> | undefined>)
        | undefined;
    resolveGlobalRoleRouting?: (() => Record<string, RoleModelOverride>) | undefined;
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

function isStreamAbortError(err: unknown, signal?: AbortSignal): boolean {
    if (isAbortError(err, signal)) {
        return true;
    }
    return err instanceof DshStreamError && err.failure.code === 'ABORTED';
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

/** 拆分 'provider:model' 复合路由字符串，缺省回退默认 provider */
export function parseProviderModelSpec(spec: string, fallbackProvider: string): LlmRouteTarget {
    const trimmed = spec.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0 && colonIdx < trimmed.length - 1) {
        const provider = trimmed.slice(0, colonIdx).trim();
        const model = trimmed.slice(colonIdx + 1).trim();
        if (provider.length > 0 && model.length > 0) {
            return { provider, model };
        }
    }
    return { provider: fallbackProvider, model: trimmed };
}

/** 按模型池解析 provider 与 model（支持 book_config.yaml 的 model_routing 单书覆盖、provider:model 复合格式及历史 'audit' 无损回退） */
export function resolvePoolRoute(
    poolRouting: LlmPoolRouting,
    pool: LlmPool,
    bookConfig?: Pick<BookConfig, 'model_routing'> | Record<string, string> | undefined
): LlmRouteTarget {
    const routingMap =
        bookConfig && 'model_routing' in bookConfig
            ? (bookConfig as Pick<BookConfig, 'model_routing'>).model_routing
            : (bookConfig as Record<string, string> | undefined);

    if (pool === 'audit') {
        const auditOverride = routingMap?.['audit']?.trim();
        const auditBase = poolRouting.audit ?? poolRouting.strong_creative;
        if (auditOverride) {
            if (!auditBase) {
                throw new Error('未配置模型池路由: strong_creative');
            }
            return parseProviderModelSpec(auditOverride, auditBase.provider);
        }
        if (poolRouting.audit) {
            return { provider: poolRouting.audit.provider, model: poolRouting.audit.model };
        }
    }

    const effectivePool = pool === 'audit' ? normalizeLlmPool(pool) : pool;
    const base = poolRouting[effectivePool];
    if (!base) {
        throw new Error(`未配置模型池路由: ${effectivePool}`);
    }
    const override = routingMap?.[effectivePool]?.trim();
    if (!override) {
        return { provider: base.provider, model: base.model };
    }
    return parseProviderModelSpec(override, base.provider);
}

/** 将角色层级覆盖 (strong/weak) 映射为对应模型池 */
export function resolveTierPool(tier: string | undefined, fallbackPool: LlmPool): LlmPool {
    if (tier === 'strong') return 'strong_creative';
    if (tier === 'weak') return 'fast_retrieval';
    return fallbackPool;
}

/**
 * 解析单个工种的最终 provider 与 model：
 * 优先级：Layer 2 role_routing[roleId].model -> Layer 1 role_routing[roleId].tier -> poolOverride ?? defaultPool -> model_routing/poolRouting
 */
export function resolveRoleRoute(
    poolRouting: LlmPoolRouting,
    roleId: string | undefined,
    defaultPool: LlmPool,
    bookConfig?: Pick<BookConfig, 'model_routing' | 'role_routing'> | undefined,
    poolOverride?: LlmPool | undefined
): LlmRouteTarget {
    const roleOverride = roleId ? bookConfig?.role_routing?.[roleId] : undefined;
    const effectivePool = resolveTierPool(roleOverride?.tier, poolOverride ?? defaultPool);
    const baseRoute = resolvePoolRoute(poolRouting, effectivePool, bookConfig);
    const modelOverride = roleOverride?.model?.trim();
    if (!modelOverride) {
        return baseRoute;
    }
    return parseProviderModelSpec(modelOverride, baseRoute.provider);
}

/** 解析单个工种的推理强度（role_routing[roleId].reasoning_effort > override > defaultEffort） */
export function resolveRoleReasoningEffort(
    roleId: string | undefined,
    defaultEffort: ReasoningEffortLevel | undefined,
    bookConfig?: Pick<BookConfig, 'role_routing'> | undefined,
    override?: ReasoningEffortLevel | undefined
): ReasoningEffortLevel | undefined {
    const roleEffort = roleId ? bookConfig?.role_routing?.[roleId]?.reasoning_effort : undefined;
    return roleEffort ?? override ?? defaultEffort;
}

const REASONING_FALLBACK_ORDER: Record<ReasoningEffortLevel, readonly string[]> = {
    off: ['off'],
    low: ['low', 'off'],
    medium: ['medium', 'low', 'high', 'off'],
    high: ['high', 'max', 'medium', 'low', 'off'],
    max: ['max', 'high', 'medium', 'low', 'off']
};

/**
 * 将角色配置的 reasoningEffort 适配为目标 provider/model 实际支持的值。
 * 优先精确匹配；不兼容时按降级链匹配，避免 deepseek-flash（仅支持 off）或
 * deepseek-v4-pro（不支持 medium）因 effort 枚举差异在发包前直接报错。
 */
export async function resolveCompatibleReasoningEffort(
    llm:
        | (Pick<LlmRuntime, 'stream'> & { resolveModelInfo?: LlmRuntime['resolveModelInfo'] })
        | undefined,
    provider: string,
    model: string,
    requestedEffort: ReasoningEffortLevel | undefined,
    signal?: AbortSignal
): Promise<ReasoningEffortId | undefined> {
    if (requestedEffort === undefined) {
        return undefined;
    }
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
        return ReasoningEffortId(requestedEffort);
    }

    let resolvedInfo: Awaited<ReturnType<LlmRuntime['resolveModelInfo']>>;
    try {
        resolvedInfo = await llm.resolveModelInfo(provider, model, signal);
    } catch (err: unknown) {
        if (signal?.aborted) {
            throw err;
        }
        return ReasoningEffortId(requestedEffort);
    }

    const reasoning = resolvedInfo.reasoning;
    if (!reasoning || reasoning.efforts.length === 0) {
        return undefined;
    }

    const supportedIds = new Set(reasoning.efforts.map((effort) => effort.id));
    const exactId = ReasoningEffortId(requestedEffort);
    if (supportedIds.has(exactId)) {
        return exactId;
    }

    const candidates = REASONING_FALLBACK_ORDER[requestedEffort] ?? [requestedEffort];
    for (const candidate of candidates) {
        const candidateId = ReasoningEffortId(candidate);
        if (supportedIds.has(candidateId)) {
            return candidateId;
        }
    }

    return reasoning.defaultEffort ?? reasoning.efforts[0]?.id;
}

/**
 * 基于 @deepseek-ai/dsh-llm 的 LlmPort 适配器：
 * - 无 sessionId / 无 tools 净室单轮流式调用；
 * - 仅拼接 text-delta / text block-end 正文（隔离 reasoning-delta）；
 * - 标准化 TokenUsage 并对瞬时错误执行指数退避重试。
 */
export class DshLlmAdapter implements LlmPort {
    private readonly poolRouting: LlmPoolRouting;
    private readonly resolvePoolRouting: DshLlmAdapterOptions['resolvePoolRouting'];
    private readonly ensurePoolRoutingReady: DshLlmAdapterOptions['ensurePoolRoutingReady'];
    private readonly maxRetries: number;
    private readonly backoffMs: readonly number[];
    private readonly retryableCodes: Set<string>;
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly resolveModelRouting: DshLlmAdapterOptions['resolveModelRouting'];
    private readonly resolveBookConfig: DshLlmAdapterOptions['resolveBookConfig'];
    private readonly resolveGlobalRoleRouting: DshLlmAdapterOptions['resolveGlobalRoleRouting'];

    constructor(
        private readonly llm: Pick<LlmRuntime, 'stream'> & {
            resolveModelInfo?: LlmRuntime['resolveModelInfo'];
        },
        options: DshLlmAdapterOptions
    ) {
        this.poolRouting = options.poolRouting;
        this.resolvePoolRouting = options.resolvePoolRouting;
        this.ensurePoolRoutingReady = options.ensurePoolRoutingReady;
        this.resolveModelRouting = options.resolveModelRouting;
        this.resolveBookConfig = options.resolveBookConfig;
        this.resolveGlobalRoleRouting = options.resolveGlobalRoleRouting;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
        this.retryableCodes = options.retryableCodes
            ? new Set(options.retryableCodes)
            : DEFAULT_RETRYABLE_CODES;
        this.sleepFn = options.sleepFn ?? sleepWithSignal;
    }

    async generate(
        req: CleanroomRequest,
        signal?: AbortSignal,
        roleContext?: {
            roleId?: string | undefined;
            bookConfig?: Pick<BookConfig, 'model_routing' | 'role_routing'> | undefined;
        }
    ): Promise<CleanroomResponse> {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        }

        await this.ensurePoolRoutingReady?.();
        const activePoolRouting = this.resolvePoolRouting
            ? this.resolvePoolRouting()
            : this.poolRouting;
        const resolvedBookConfig =
            roleContext?.bookConfig ?? (await this.resolveBookConfig?.());
        const modelRouting = resolvedBookConfig
            ? resolvedBookConfig.model_routing
            : await this.resolveModelRouting?.();
        const globalRoleRouting = this.resolveGlobalRoleRouting?.();
        const mergedRoleRouting =
            globalRoleRouting && Object.keys(globalRoleRouting).length > 0
                ? { ...globalRoleRouting, ...(resolvedBookConfig?.role_routing ?? {}) }
                : resolvedBookConfig?.role_routing;
        let effectiveBookConfig: Pick<BookConfig, 'model_routing' | 'role_routing'> | undefined;
        if (resolvedBookConfig || modelRouting || mergedRoleRouting) {
            effectiveBookConfig = {};
            if (modelRouting) {
                effectiveBookConfig.model_routing = modelRouting;
            }
            if (mergedRoleRouting) {
                effectiveBookConfig.role_routing = mergedRoleRouting;
            }
        }
        const route = resolveRoleRoute(
            activePoolRouting,
            roleContext?.roleId,
            req.pool,
            effectiveBookConfig
        );
        const effectiveReasoningEffort = resolveRoleReasoningEffort(
            roleContext?.roleId,
            req.reasoningEffort,
            effectiveBookConfig
        );

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
        if (effectiveReasoningEffort !== undefined) {
            const compatibleEffort = await resolveCompatibleReasoningEffort(
                this.llm,
                route.provider,
                route.model,
                effectiveReasoningEffort,
                signal
            );
            if (compatibleEffort !== undefined) {
                options.reasoningEffort = compatibleEffort;
            }
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
                if (isStreamAbortError(err, signal)) {
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

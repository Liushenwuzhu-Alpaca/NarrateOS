import type {
    CleanroomRequest,
    CleanroomResponse,
    LlmPool,
    LlmPort,
    TokenUsage
} from '@narrateos/core';

/** 动态加载的 dsh-llm 模块调度函数签名 */
export interface DshLlmGenerateArgs {
    model: string;
    pool: LlmPool;
    staticPrefixBlocks: string[];
    dynamicTail: string;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
    signal?: AbortSignal | undefined;
}

export interface DshLlmRawResult {
    text?: string | undefined;
    content?: string | undefined;
    usage?: Partial<TokenUsage> | undefined;
    modelId?: string | undefined;
    finishReason?: string | undefined;
}

export interface DshLlmModuleLike {
    generate?: ((args: DshLlmGenerateArgs, signal?: AbortSignal) => Promise<DshLlmRawResult>) | undefined;
    createClient?: (() => {
        generate: (args: DshLlmGenerateArgs, signal?: AbortSignal) => Promise<DshLlmRawResult>;
    }) | undefined;
    default?: {
        generate?: ((args: DshLlmGenerateArgs, signal?: AbortSignal) => Promise<DshLlmRawResult>) | undefined;
    } | undefined;
}

export interface DshRuntimeClientOptions {
    /** 动态加载的模块名，默认 '@deepseek-ai/dsh-llm' */
    moduleSpecifier?: string | undefined;
    /** 自定义模块加载器（便于单测或自定义解析路径注入） */
    loader?: ((specifier: string) => Promise<DshLlmModuleLike>) | undefined;
    /** 按模型池路由的模型名称映射 */
    modelRouting?: Partial<Record<LlmPool, string>> | undefined;
    /** 兜底模型名称 */
    defaultModel?: string | undefined;
    /** 自定义 DeepSeek API Base URL（默认 https://api.deepseek.com） */
    baseUrl?: string | undefined;
    /** 单次 HTTP 请求总超时毫秒数（默认读 NARRATEOS_REQUEST_TIMEOUT_MS 或 120000，0 表示禁用） */
    requestTimeoutMs?: number | undefined;
    /** 流式空闲看门狗毫秒数（默认读 NARRATEOS_STREAM_IDLE_TIMEOUT_MS 或 60000，0 表示禁用） */
    streamIdleTimeoutMs?: number | undefined;
}

const DEFAULT_DSH_LLM_MODULE = '@deepseek-ai/dsh-llm';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

interface DeepSeekUsageRaw {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
}

interface DeepSeekApiResponse {
    model?: string;
    choices?: Array<{
        message?: {
            content?: string | null;
        };
        finish_reason?: string | null;
    }>;
    usage?: DeepSeekUsageRaw;
}

interface DeepSeekStreamChunk {
    model?: string;
    choices?: Array<{
        delta?: {
            content?: string | null;
            reasoning_content?: string | null;
        };
        finish_reason?: string | null;
    }>;
    usage?: DeepSeekUsageRaw | null;
}

function resolveDefaultModelRouting(): Partial<Record<LlmPool, string>> {
    return {
        ...(process.env['NARRATEOS_MODEL_STRONG']
            ? { strong_creative: process.env['NARRATEOS_MODEL_STRONG'] }
            : {}),
        ...(process.env['NARRATEOS_MODEL_FAST']
            ? { fast_retrieval: process.env['NARRATEOS_MODEL_FAST'] }
            : {}),
        ...(process.env['NARRATEOS_MODEL_AUDIT']
            ? { audit: process.env['NARRATEOS_MODEL_AUDIT'] }
            : {})
    };
}

function normalizeUsage(raw?: Partial<TokenUsage>): TokenUsage {
    return {
        inputTokens: raw?.inputTokens ?? 0,
        cacheReadTokens: raw?.cacheReadTokens ?? 0,
        cacheWriteTokens: raw?.cacheWriteTokens ?? 0,
        outputTokens: raw?.outputTokens ?? 0
    };
}

/**
 * 面向 CLI 的 @deepseek-ai/dsh-llm 动态运行时客户端：
 * 运行时按需动态导入全局或工作区内的 dsh-llm 调度器，避免编译期强绑定。
 */
export class DshRuntimeClient implements LlmPort {
    private readonly moduleSpecifier: string;
    private readonly hasCustomModuleOrLoader: boolean;
    private readonly loader: (specifier: string) => Promise<DshLlmModuleLike>;
    private readonly modelRouting: Partial<Record<LlmPool, string>>;
    private readonly baseUrl: string;
    private readonly requestTimeoutMs: number;
    private readonly streamIdleTimeoutMs: number;
    private cachedModule: DshLlmModuleLike | null = null;

    constructor(options: DshRuntimeClientOptions = {}) {
        this.hasCustomModuleOrLoader =
            options.loader !== undefined ||
            options.moduleSpecifier !== undefined ||
            process.env['NARRATEOS_DSH_LLM_MODULE'] !== undefined;
        this.moduleSpecifier =
            options.moduleSpecifier ?? process.env['NARRATEOS_DSH_LLM_MODULE'] ?? DEFAULT_DSH_LLM_MODULE;
        this.loader =
            options.loader ??
            (async (specifier: string) => {
                return (await import(specifier)) as DshLlmModuleLike;
            });
        const defaults = resolveDefaultModelRouting();
        const fallback = options.defaultModel;
        const strong = options.modelRouting?.strong_creative ?? defaults.strong_creative ?? fallback;
        const fast = options.modelRouting?.fast_retrieval ?? defaults.fast_retrieval ?? fallback;
        const audit = options.modelRouting?.audit ?? defaults.audit ?? fallback;
        this.modelRouting = {};
        if (strong) this.modelRouting.strong_creative = strong;
        if (fast) this.modelRouting.fast_retrieval = fast;
        if (audit) this.modelRouting.audit = audit;
        this.baseUrl = (
            options.baseUrl ??
            process.env['DEEPSEEK_BASE_URL'] ??
            DEFAULT_DEEPSEEK_BASE_URL
        ).replace(/\/+$/, '');
        const rawTimeout = options.requestTimeoutMs ?? Number(process.env['NARRATEOS_REQUEST_TIMEOUT_MS']);
        this.requestTimeoutMs =
            Number.isFinite(rawTimeout) && rawTimeout >= 0 ? rawTimeout : DEFAULT_REQUEST_TIMEOUT_MS;
        const rawIdle =
            options.streamIdleTimeoutMs ?? Number(process.env['NARRATEOS_STREAM_IDLE_TIMEOUT_MS']);
        this.streamIdleTimeoutMs =
            Number.isFinite(rawIdle) && rawIdle >= 0 ? rawIdle : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    }

    private async resolveModule(): Promise<DshLlmModuleLike> {
        if (this.cachedModule) {
            return this.cachedModule;
        }
        try {
            const loaded = await this.loader(this.moduleSpecifier);
            this.cachedModule = loaded;
            return loaded;
        } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `无法加载动态调度器 "${this.moduleSpecifier}": ${detail}。请确认已安装 @deepseek-ai/dsh-llm 或在测试/CI 中注入 ScriptedLlmAdapter。`
            );
        }
    }

    private async callDeepSeekApi(
        req: CleanroomRequest,
        model: string,
        apiKey: string,
        signal?: AbortSignal
    ): Promise<CleanroomResponse> {
        const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
        const staticSystem = req.staticPrefixBlocks.join('\n\n').trim();
        if (staticSystem.length > 0) {
            messages.push({ role: 'system', content: staticSystem });
        }
        messages.push({ role: 'user', content: req.dynamicTail });

        const isReasoner = model.includes('reasoner');
        const body: Record<string, unknown> = {
            model,
            messages,
            stream: true,
            stream_options: { include_usage: true }
        };
        if (!isReasoner && req.temperature !== undefined) {
            body['temperature'] = req.temperature;
        }
        if (req.maxTokens !== undefined) {
            body['max_tokens'] = req.maxTokens;
        }

        const backoffMs = [1000, 2000, 4000, 8000, 16000];
        let lastError: unknown;
        for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
            const idleController = new AbortController();
            let idleTimer: ReturnType<typeof setTimeout> | undefined;
            const resetIdleWatchdog = (): void => {
                if (idleTimer !== undefined) {
                    clearTimeout(idleTimer);
                }
                if (this.streamIdleTimeoutMs > 0) {
                    idleTimer = setTimeout(() => {
                        idleController.abort(
                            new Error(`流式空闲超时 (${this.streamIdleTimeoutMs}ms 无响应)`)
                        );
                    }, this.streamIdleTimeoutMs);
                }
            };

            const signals: AbortSignal[] = [idleController.signal];
            if (signal) signals.push(signal);
            if (this.requestTimeoutMs > 0) {
                signals.push(AbortSignal.timeout(this.requestTimeoutMs));
            }
            const combinedSignal = AbortSignal.any(signals);
            resetIdleWatchdog();

            try {
                const resp = await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(body),
                    signal: combinedSignal
                });

                if (!resp.ok) {
                    const errText = await resp.text();
                    const err = new Error(`DeepSeek API HTTP ${resp.status}: ${errText.slice(0, 300)}`);
                    if ((resp.status === 429 || resp.status >= 500) && attempt < backoffMs.length) {
                        lastError = err;
                        const delay = backoffMs[attempt] ?? 1000;
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    throw err;
                }

                const contentType = resp.headers.get('content-type') ?? '';
                if (!contentType.includes('text/event-stream') || !resp.body) {
                    const json = (await resp.json()) as DeepSeekApiResponse;
                    return this.mapUsageResponse(
                        json.choices?.[0]?.message?.content ?? '',
                        json.usage,
                        json.model ?? model,
                        json.choices?.[0]?.finish_reason ?? undefined
                    );
                }

                return await this.consumeSseStream(resp.body, model, resetIdleWatchdog);
            } catch (err: unknown) {
                if (signal?.aborted) {
                    throw err;
                }
                lastError = err;
                if (attempt < backoffMs.length) {
                    const delay = backoffMs[attempt] ?? 1000;
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                throw err;
            } finally {
                if (idleTimer !== undefined) {
                    clearTimeout(idleTimer);
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error('DeepSeek API 调用失败');
    }

    private mapUsageResponse(
        text: string,
        usageRaw: DeepSeekUsageRaw | null | undefined,
        modelId: string,
        finishReason?: string
    ): CleanroomResponse {
        const cacheRead =
            usageRaw?.prompt_cache_hit_tokens ??
            usageRaw?.prompt_tokens_details?.cached_tokens ??
            0;
        const inputUncached =
            usageRaw?.prompt_cache_miss_tokens ??
            Math.max(0, (usageRaw?.prompt_tokens ?? 0) - cacheRead);

        return {
            text,
            usage: {
                inputTokens: inputUncached,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: 0,
                outputTokens: usageRaw?.completion_tokens ?? 0
            },
            modelId,
            ...(finishReason !== undefined ? { finishReason } : {})
        };
    }

    private async consumeSseStream(
        streamBody: ReadableStream<Uint8Array>,
        fallbackModel: string,
        onActivity: () => void
    ): Promise<CleanroomResponse> {
        const reader = streamBody.getReader();
        const decoder = new TextDecoder('utf8');
        let buffer = '';
        let text = '';
        let modelId = fallbackModel;
        let finishReason: string | undefined;
        let usageRaw: DeepSeekUsageRaw | null | undefined;

        const processLine = (line: string): void => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) {
                return;
            }
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') {
                return;
            }
            const chunk = JSON.parse(dataStr) as DeepSeekStreamChunk;
            if (chunk.model) {
                modelId = chunk.model;
            }
            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) {
                text += choice.delta.content;
            }
            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }
            if (chunk.usage) {
                usageRaw = chunk.usage;
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                onActivity();
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    processLine(line);
                }
            }
            buffer += decoder.decode();
            if (buffer.trim().length > 0) {
                processLine(buffer);
            }
        } finally {
            reader.releaseLock();
        }

        return this.mapUsageResponse(text, usageRaw, modelId, finishReason);
    }

    async generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse> {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        }

        const configuredModel =
            this.modelRouting[req.pool] ??
            (req.pool === 'strong_creative'
                ? process.env['NARRATEOS_MODEL_STRONG']
                : req.pool === 'fast_retrieval'
                  ? process.env['NARRATEOS_MODEL_FAST']
                  : process.env['NARRATEOS_MODEL_AUDIT']);
        const apiKey = process.env['DEEPSEEK_API_KEY']?.trim();
        if (!this.hasCustomModuleOrLoader && apiKey) {
            if (!configuredModel) {
                throw new Error(
                    `未配置模型池 "${req.pool}"，请在 .env 中设置 NARRATEOS_MODEL_STRONG / NARRATEOS_MODEL_FAST / NARRATEOS_MODEL_AUDIT。`
                );
            }
            return await this.callDeepSeekApi(req, configuredModel, apiKey, signal);
        }

        const model = configuredModel ?? req.pool;
        const mod = await this.resolveModule();
        const payload: DshLlmGenerateArgs = {
            model,
            pool: req.pool,
            staticPrefixBlocks: req.staticPrefixBlocks,
            dynamicTail: req.dynamicTail,
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            reasoningEffort: req.reasoningEffort,
            signal
        };

        let raw: DshLlmRawResult;
        if (typeof mod.generate === 'function') {
            raw = await mod.generate(payload, signal);
        } else if (typeof mod.createClient === 'function') {
            const client = mod.createClient();
            raw = await client.generate(payload, signal);
        } else if (mod.default && typeof mod.default.generate === 'function') {
            raw = await mod.default.generate(payload, signal);
        } else {
            throw new Error(`模块 "${this.moduleSpecifier}" 未导出兼容的 generate() 或 createClient() 接口。`);
        }

        const text = raw.text ?? raw.content ?? '';
        return {
            text,
            usage: normalizeUsage(raw.usage),
            modelId: raw.modelId ?? model,
            ...(raw.finishReason !== undefined ? { finishReason: raw.finishReason } : {})
        };
    }
}

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
}

const DEFAULT_DSH_LLM_MODULE = '@deepseek-ai/dsh-llm';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

interface DeepSeekApiResponse {
    model?: string;
    choices?: Array<{
        message?: {
            content?: string | null;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens_details?: {
            cached_tokens?: number;
        };
    };
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
            stream: false
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
            try {
                const resp = await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(body),
                    ...(signal ? { signal } : {})
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

                const json = (await resp.json()) as DeepSeekApiResponse;
                const text = json.choices?.[0]?.message?.content ?? '';
                const usageRaw = json.usage;
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
                    modelId: json.model ?? model,
                    ...(json.choices?.[0]?.finish_reason
                        ? { finishReason: json.choices[0].finish_reason }
                        : {})
                };
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
            }
        }
        throw lastError instanceof Error ? lastError : new Error('DeepSeek API 调用失败');
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

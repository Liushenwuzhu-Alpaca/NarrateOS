import { generateTraced, traceArtifact, traceEvent, withTraceStage } from '../trace/trace.js';
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';

/** 活跃双模型池分类（强创意池 / 快检索池） */
export type ActiveLlmPool = 'strong_creative' | 'fast_retrieval';

/** 模型池路由分类（兼容历史配置中可能残留的 'audit'，运行时无损回退至 strong_creative） */
export type LlmPool = ActiveLlmPool | 'audit';

/** 将模型池标识（含历史残留 'audit'）无损规范化为强/弱双池 */
export function normalizeLlmPool(pool: string | undefined): ActiveLlmPool {
    if (pool === 'fast_retrieval') {
        return 'fast_retrieval';
    }
    return 'strong_creative';
}

/** 标准化无交集 Token 用量统计 */
export interface TokenUsage {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
}

/** 推理深度等级（兼容各模型槽位与历史 medium 别名） */
export type ReasoningEffortLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

/** 净室单轮请求结构（严禁携带工具声明或会话历史） */
export interface CleanroomRequest {
    /** 仅供本地追踪关联角色，不发送给模型提供商。 */
    traceStage?: string;
    pool: LlmPool;
    staticPrefixBlocks: string[];
    dynamicTail: string;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: ReasoningEffortLevel;
}

/** 净室响应结构 */
export interface CleanroomResponse {
    text: string;
    usage: TokenUsage;
    modelId?: string;
    finishReason?: string;
}

/** 模型调用窄接缝 */
export interface LlmPort {
    generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse>;
}

/** 结构化 JSON 重试配置 */
export interface StructuredRetryOptions {
    /** 最大修复重试次数，默认 5 */
    maxRetries?: number;
    /** 每次重试前等待毫秒数，默认 [1000, 2000, 4000, 8000, 16000] */
    backoffMs?: number[];
    /** 自定义睡眠函数，单测可注入零延迟替身 */
    sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 默认结构化重试上限 */
export const DEFAULT_STRUCTURED_MAX_RETRIES = 5;

/** 默认指数退避序列：1s -> 2s -> 4s -> 8s -> 16s */
export const DEFAULT_STRUCTURED_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];

/** 结构化输出超过重试上限后的明确错误 */
export class StructuredOutputError extends Error {
    readonly attempts: number;
    readonly lastRawOutput: string;
    readonly lastValidationError: string;

    constructor(attempts: number, lastRawOutput: string, lastValidationError: string) {
        super(
            `结构化 JSON 校验在尝试 ${attempts} 次后仍然失败: ${lastValidationError}`
        );
        this.name = 'StructuredOutputError';
        this.attempts = attempts;
        this.lastRawOutput = lastRawOutput;
        this.lastValidationError = lastValidationError;
    }
}

/** 支持 AbortSignal 的异步等待 */
export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        }
        return;
    }
    await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
            return;
        }
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
        };
        const cleanup = () => {
            signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** 从模型输出中提取 fenced JSON 块或裸 JSON 对象/数组 */
export function extractJsonCandidate(rawText: string): string {
    const fencedMatch = rawText.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/i);
    if (fencedMatch?.[1] !== undefined) {
        return fencedMatch[1].trim();
    }

    const trimmed = rawText.trim();
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');
    let start = -1;
    let endChar = '}';

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        start = firstBrace;
        endChar = '}';
    } else if (firstBracket !== -1) {
        start = firstBracket;
        endChar = ']';
    }

    if (start !== -1) {
        const end = trimmed.lastIndexOf(endChar);
        if (end > start) {
            return trimmed.slice(start, end + 1);
        }
    }

    return trimmed;
}

/**
 * 发起零 tools 净室结构化 JSON 请求，附带 Zod 校验与指数退避修复重试。
 * 首次调用后若解析或 Schema 校验失败，最多额外重试 maxRetries 次（默认 5 次）。
 */
export async function generateStructuredJson<T>(
    llm: LlmPort,
    req: CleanroomRequest,
    schema: ZodType<T>,
    options: StructuredRetryOptions = {},
    signal?: AbortSignal
): Promise<{ data: T; totalUsage: TokenUsage; attempts: number }> {
    return await withTraceStage(req.traceStage ?? 'model', async () => {
    const maxRetries = options.maxRetries ?? DEFAULT_STRUCTURED_MAX_RETRIES;
    const backoffMs = options.backoffMs ?? DEFAULT_STRUCTURED_BACKOFF_MS;
    const sleepFn = options.sleepFn ?? sleepWithSignal;

    const totalUsage: TokenUsage = {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0
    };

    let currentReq: CleanroomRequest = req;
    let lastRawOutput = '';
    let lastValidationError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            await traceEvent('call.retry', { attempt: attempt + 1, reason: 'structured_validation' });
            const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 16000;
            await sleepFn(delay, signal);
            // 将上次错误附带进动态尾部提示，绝不改动 staticPrefixBlocks 以保护 KV 缓存前缀
            currentReq = {
                ...req,
                dynamicTail: [
                    req.dynamicTail,
                    '',
                    '## 上次输出格式校验失败，请仅输出一个合法的 ```json 代码块进行修复',
                    `错误信息: ${lastValidationError}`,
                    `上次输出片段: ${lastRawOutput.slice(0, 600)}`
                ].join('\n')
            };
        }

        const res = await generateTraced(llm, currentReq, signal, attempt + 1);
        totalUsage.inputTokens += res.usage.inputTokens;
        totalUsage.cacheReadTokens += res.usage.cacheReadTokens;
        totalUsage.cacheWriteTokens += res.usage.cacheWriteTokens;
        totalUsage.outputTokens += res.usage.outputTokens;
        lastRawOutput = res.text;

        const candidate = extractJsonCandidate(res.text);
        try {
            const parsed: unknown = JSON.parse(candidate);
            const validated = schema.safeParse(parsed);
            if (validated.success) {
                return {
                    data: validated.data,
                    totalUsage,
                    attempts: attempt + 1
                };
            }
            lastValidationError = validated.error.issues
                .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
                .join('; ');
        } catch (err) {
            lastValidationError = err instanceof Error ? err.message : String(err);
        }
        await traceEvent('call.validation_failed', { attempt: attempt + 1 });
        await traceArtifact('validation.error', { attempt: attempt + 1, message: lastValidationError });
    }

    throw new StructuredOutputError(maxRetries + 1, lastRawOutput, lastValidationError);
    });
}

/** 计算静态前缀块的 SHA-256 指纹，供缓存一致性断言 */
export function hashStaticPrefix(staticPrefixBlocks: string[]): string {
    return createHash('sha256').update(staticPrefixBlocks.join('\n\n')).digest('hex');
}

export interface ScriptedCallRecord {
    request: CleanroomRequest;
    prefixHash: string;
}

export type ScriptedResponder =
    | CleanroomResponse
    | Error
    | ((req: CleanroomRequest, callIndex: number) => CleanroomResponse | Promise<CleanroomResponse>);

/**
 * 离线测试专用的脚本化 LLM 适配器：
 * 按调用顺序或匹配器返回确定性响应，不发生任何网络请求。
 */
export class ScriptedLlmAdapter implements LlmPort {
    private readonly queue: ScriptedResponder[];
    readonly history: ScriptedCallRecord[] = [];

    constructor(responders: ScriptedResponder[] = []) {
        this.queue = [...responders];
    }

    enqueue(...responders: ScriptedResponder[]): void {
        this.queue.push(...responders);
    }

    async generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse> {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        }
        const callIndex = this.history.length;
        this.history.push({
            request: req,
            prefixHash: hashStaticPrefix(req.staticPrefixBlocks)
        });

        const next = this.queue.shift();
        if (!next) {
            throw new Error(`ScriptedLlmAdapter 队列已耗尽 (第 ${callIndex + 1} 次调用, pool=${req.pool})`);
        }
        if (next instanceof Error) {
            throw next;
        }
        if (typeof next === 'function') {
            return await next(req, callIndex);
        }
        return next;
    }
}

/** 单次模型调用审计日志条目 */
export interface LlmCallLogEntry {
    timestamp: string;
    pool: LlmPool;
    modelId?: string | undefined;
    durationMs: number;
    prefixHash: string;
    dynamicTailChars: number;
    status: 'ok' | 'error';
    usage?: TokenUsage | undefined;
    error?: string | undefined;
}

export interface LoggingLlmAdapterOptions {
    /** 追加写入 JSONL 日志的文件路径（如 .ops/llm_calls.jsonl） */
    logPath?: string | undefined;
    /** 每次调用完成或失败时的实时回调 */
    onCallFinish?: ((entry: LlmCallLogEntry) => void) | undefined;
}

/**
 * 透明模型调用审计装饰器：
 * 包装任意 LlmPort，在每次调用结束或失败后记录耗时、Token 命中与状态。
 */
export class LoggingLlmAdapter implements LlmPort {
    private readonly inner: LlmPort;
    private readonly logPath: string | undefined;
    private readonly onCallFinish: ((entry: LlmCallLogEntry) => void) | undefined;

    constructor(inner: LlmPort, options: LoggingLlmAdapterOptions = {}) {
        this.inner = inner;
        this.logPath = options.logPath;
        this.onCallFinish = options.onCallFinish;
    }

    private async recordEntry(entry: LlmCallLogEntry): Promise<void> {
        if (this.onCallFinish) {
            try {
                this.onCallFinish(entry);
            } catch {
                // 避免外部日志回调异常中断主流程
            }
        }
        if (this.logPath) {
            try {
                await mkdir(dirname(this.logPath), { recursive: true });
                await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
            } catch {
                try { process.stderr.write('[llm-log] 调用统计写盘失败，写作继续\n'); } catch { /* 终端故障不改变模型结果 */ }
            }
        }
    }

    async generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse> {
        const startedAt = Date.now();
        const prefixHash = hashStaticPrefix(req.staticPrefixBlocks);
        try {
            const res = await this.inner.generate(req, signal);
            await this.recordEntry({
                timestamp: new Date().toISOString(),
                pool: req.pool,
                ...(res.modelId !== undefined ? { modelId: res.modelId } : {}),
                durationMs: Date.now() - startedAt,
                prefixHash,
                dynamicTailChars: req.dynamicTail.length,
                status: 'ok',
                usage: res.usage
            });
            return res;
        } catch (err: unknown) {
            await this.recordEntry({
                timestamp: new Date().toISOString(),
                pool: req.pool,
                durationMs: Date.now() - startedAt,
                prefixHash,
                dynamicTailChars: req.dynamicTail.length,
                status: 'error',
                error: err instanceof Error ? err.message : String(err)
            });
            throw err;
        }
    }
}

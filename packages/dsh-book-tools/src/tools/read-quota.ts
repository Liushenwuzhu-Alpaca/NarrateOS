import { ReadQuotaExceededError } from '../errors.js';

/** 只读调用配额配置 */
export interface ReadQuotaOptions {
    /** 本轮允许的最大只读调用次数（book_read + book_grep + book_glob 共享） */
    maxReadCalls?: number | undefined;
    /** 耗尽配额后提示调用的终态工具名 */
    yieldToolHint?: string | undefined;
}

/**
 * 按 runId 共享的只读工具硬计数限流器：
 * 超过 maxReadCalls 后立即拦截并提示工种停止读取、调用 yield_* 交棒。
 */
export class ReadQuotaCounter {
    public readonly maxReadCalls: number;
    public readonly yieldToolHint: string;
    private usedCount = 0;

    constructor(options: ReadQuotaOptions = {}) {
        const maxCalls = options.maxReadCalls ?? Number.POSITIVE_INFINITY;
        if (
            maxCalls !== Number.POSITIVE_INFINITY &&
            (!Number.isInteger(maxCalls) || maxCalls < 0)
        ) {
            throw new Error(`非法的 maxReadCalls 配额: ${String(maxCalls)}`);
        }
        this.maxReadCalls = maxCalls;
        this.yieldToolHint = options.yieldToolHint ?? 'yield_*';
    }

    /** 消耗 1 次只读配额；超限时立即抛出 ReadQuotaExceededError */
    consume(toolName: string): number {
        if (this.usedCount >= this.maxReadCalls) {
            throw new ReadQuotaExceededError(toolName, this.maxReadCalls, this.yieldToolHint);
        }
        this.usedCount += 1;
        return this.usedCount;
    }

    /** 已消耗次数 */
    get count(): number {
        return this.usedCount;
    }

    /** 剩余可用次数 */
    get remaining(): number {
        if (this.maxReadCalls === Number.POSITIVE_INFINITY) {
            return Number.POSITIVE_INFINITY;
        }
        return Math.max(0, this.maxReadCalls - this.usedCount);
    }
}

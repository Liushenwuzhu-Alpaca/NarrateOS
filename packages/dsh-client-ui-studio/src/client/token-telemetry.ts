/**
 * 遥测 Token 聚合（章节生成累计口径）
 * - 四项 Token 互不重叠：input=未缓存输入，cacheRead=缓存读取，cacheWrite=缓存写入，output=输出
 * - 命中率一律由四项总量重算：cacheRead / (input + cacheRead + cacheWrite)，不采信条目自带的 cacheHitRate
 * - 按 timestamp + chapter 真实记录键去重 SSE 重放；无键历史记录逐条保留，不凭 Token 值猜测重复
 */
import type { TelemetryItem } from './types';

/** 四项 Token 总量与重算后的命中率 */
export interface AggregatedTelemetryTokens {
    /** 未缓存输入 Token 总量 */
    inputTokens: number;
    /** 缓存读取 Token 总量 */
    cacheReadTokens: number;
    /** 缓存写入 Token 总量 */
    cacheWriteTokens: number;
    /** 输出 Token 总量 */
    outputTokens: number;
    /** 命中率 (0-1 小数)；输入侧无任何 prompt Token 数据时为 undefined（未提供） */
    cacheHitRate: number | undefined;
}

/** 兼容嵌套 token_usage 与扁平字段读取单项 Token；0 是合法测量值，用 ?? 保留 */
function readItemTokens(item: TelemetryItem): {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
} {
    const usage = item.token_usage;
    // 只接受有限非负数值；缺失/非法按 0 计入总量；0 是合法测量值，用 ?? 保留
    const tokens = {
        inputTokens: usage?.inputTokens ?? item.inputTokens,
        cacheReadTokens: usage?.cacheReadTokens ?? item.cacheReadTokens,
        cacheWriteTokens: usage?.cacheWriteTokens ?? item.cacheWriteTokens,
        outputTokens: usage?.outputTokens ?? item.outputTokens
    };
    return {
        inputTokens:
            typeof tokens.inputTokens === 'number' &&
            Number.isFinite(tokens.inputTokens) &&
            tokens.inputTokens >= 0
                ? tokens.inputTokens
                : 0,
        cacheReadTokens:
            typeof tokens.cacheReadTokens === 'number' &&
            Number.isFinite(tokens.cacheReadTokens) &&
            tokens.cacheReadTokens >= 0
                ? tokens.cacheReadTokens
                : 0,
        cacheWriteTokens:
            typeof tokens.cacheWriteTokens === 'number' &&
            Number.isFinite(tokens.cacheWriteTokens) &&
            tokens.cacheWriteTokens >= 0
                ? tokens.cacheWriteTokens
                : 0,
        outputTokens:
            typeof tokens.outputTokens === 'number' &&
            Number.isFinite(tokens.outputTokens) &&
            tokens.outputTokens >= 0
                ? tokens.outputTokens
                : 0
    };
}

/**
 * 真实记录键：timestamp + chapter 同时存在才可去重（SSE 重放会重复推送同一行）。
 * 缺任一键的历史记录返回 null，逐条保留；不凭 Token 值相同误判为重复。
 */
function recordKey(item: TelemetryItem): string | null {
    const timestamp = typeof item.timestamp === 'string' ? item.timestamp : '';
    const chapter = item.chapter ?? item.chapterNumber;
    if (!timestamp || typeof chapter !== 'number' || !Number.isFinite(chapter)) return null;
    return `${timestamp}|${chapter}`;
}

/**
 * 命中率统一口径 (0-1 小数)：cacheRead / (input + cacheRead + cacheWrite)。
 * 输入侧总量非正（无 prompt 数据）返回 undefined；聚合与检查器共用，避免双份口径。
 */
export function computeCacheHitRate(
    inputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number
): number | undefined {
    const promptTotal = inputTokens + cacheReadTokens + cacheWriteTokens;
    return promptTotal > 0 ? cacheReadTokens / promptTotal : undefined;
}

/**
 * 聚合章节生成遥测条目的四项 Token 总量并重算命中率。
 * 只聚合传入的历史条目，不掺入 liveTelemetry 或外传 cacheHitRate。
 */
export function aggregateTelemetryTokens(
    entries: readonly TelemetryItem[]
): AggregatedTelemetryTokens {
    const seen = new Map<string, number>();
    const kept: TelemetryItem[] = [];
    for (const item of entries) {
        const key = recordKey(item);
        if (key === null) {
            kept.push(item);
            continue;
        }
        const prevIndex = seen.get(key);
        if (prevIndex === undefined) {
            seen.set(key, kept.length);
            kept.push(item);
        } else {
            // 同键重放以最后一条为准（SSE 分片合并可能补全字段）
            kept[prevIndex] = item;
        }
    }

    let inputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;
    for (const item of kept) {
        const tokens = readItemTokens(item);
        inputTokens += tokens.inputTokens;
        cacheReadTokens += tokens.cacheReadTokens;
        cacheWriteTokens += tokens.cacheWriteTokens;
        outputTokens += tokens.outputTokens;
    }

    return {
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens)
    };
}
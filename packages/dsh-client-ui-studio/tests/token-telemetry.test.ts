/**
 * 章节生成累计 Token 聚合回归：
 * 四项互不重叠总量、命中率重算（不采信外传 cacheHitRate）、
 * timestamp+chapter 真实记录键去重与无键历史记录保留。
 */
import { describe, expect, it } from 'vitest';
import { aggregateTelemetryTokens } from '../src/client/token-telemetry.js';
import type { TelemetryItem } from '../src/client/types.js';

describe('aggregateTelemetryTokens 四项总量与命中率', () => {
    it('input100/read900/write100/output50 总量 1150，命中率 900/1100', () => {
        const result = aggregateTelemetryTokens([
            {
                chapter: 1,
                timestamp: '2026-11-17T00:00:00.000Z',
                token_usage: {
                    inputTokens: 100,
                    cacheReadTokens: 900,
                    cacheWriteTokens: 100,
                    outputTokens: 50
                }
            }
        ]);
        expect(result.inputTokens).toBe(100);
        expect(result.cacheReadTokens).toBe(900);
        expect(result.cacheWriteTokens).toBe(100);
        expect(result.outputTokens).toBe(50);
        expect(
            result.inputTokens +
                result.cacheReadTokens +
                result.cacheWriteTokens +
                result.outputTokens
        ).toBe(1150);
        expect(result.cacheHitRate).toBeCloseTo(900 / 1100, 10);
    });

    it('嵌套 token_usage 优先，兼容扁平字段与 chapterNumber', () => {
        const result = aggregateTelemetryTokens([
            {
                chapterNumber: 2,
                timestamp: '2026-11-17T01:00:00.000Z',
                inputTokens: 999,
                token_usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5 }
            },
            {
                chapter: 3,
                timestamp: '2026-11-17T02:00:00.000Z',
                inputTokens: 1,
                cacheReadTokens: 2,
                cacheWriteTokens: 3,
                outputTokens: 4
            }
        ]);
        expect(result.inputTokens).toBe(11);
        expect(result.cacheReadTokens).toBe(22);
        expect(result.cacheWriteTokens).toBe(3);
        expect(result.outputTokens).toBe(9);
        expect(result.cacheHitRate).toBeCloseTo(22 / 36, 10);
    });

    it('全缓存命中：input=0/write=0 时命中率为 1', () => {
        const result = aggregateTelemetryTokens([
            {
                chapter: 1,
                timestamp: '2026-11-17T00:00:00.000Z',
                token_usage: {
                    inputTokens: 0,
                    cacheReadTokens: 500,
                    cacheWriteTokens: 0,
                    outputTokens: 80
                }
            }
        ]);
        expect(result.cacheHitRate).toBe(1);
    });

    it('真实 0 消耗保留零计数，但零分母不能计算命中率', () => {
        const result = aggregateTelemetryTokens([
            {
                chapter: 1,
                timestamp: '2026-11-17T00:00:00.000Z',
                token_usage: {
                    inputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    outputTokens: 0
                }
            }
        ]);
        expect(result.inputTokens).toBe(0);
        expect(result.outputTokens).toBe(0);
        expect(result.cacheHitRate).toBeUndefined();
    });

    it('无任何 prompt Token 数据时命中率 undefined（未提供）', () => {
        expect(aggregateTelemetryTokens([]).cacheHitRate).toBeUndefined();
        const outputOnly = aggregateTelemetryTokens([
            { chapter: 1, timestamp: '2026-11-17T00:00:00.000Z', outputTokens: 42 }
        ]);
        expect(outputOnly.outputTokens).toBe(42);
        expect(outputOnly.cacheHitRate).toBeUndefined();
    });

    it('无 Token 字段的条目按 0 计入，不产生 NaN', () => {
        const result = aggregateTelemetryTokens([
            { chapter: 1, timestamp: '2026-11-17T00:00:00.000Z', raw: '{broken' },
            {
                chapter: 2,
                timestamp: '2026-11-17T01:00:00.000Z',
                inputTokens: Number.NaN,
                cacheReadTokens: -5,
                outputTokens: 7
            }
        ]);
        expect(result.inputTokens).toBe(0);
        expect(result.cacheReadTokens).toBe(0);
        expect(result.cacheWriteTokens).toBe(0);
        expect(result.outputTokens).toBe(7);
        expect(result.cacheHitRate).toBeUndefined();
    });

    it('不采信条目自带 cacheHitRate，一律由四项总量重算', () => {
        const result = aggregateTelemetryTokens([
            {
                chapter: 1,
                timestamp: '2026-11-17T00:00:00.000Z',
                cacheHitRate: 99.9,
                token_usage: {
                    inputTokens: 100,
                    cacheReadTokens: 100,
                    cacheWriteTokens: 0,
                    outputTokens: 10
                }
            }
        ]);
        expect(result.cacheHitRate).toBe(0.5);
    });
});

describe('aggregateTelemetryTokens 重放去重', () => {
    const record: TelemetryItem = {
        chapter: 1,
        timestamp: '2026-11-17T00:00:00.000Z',
        token_usage: {
            inputTokens: 100,
            cacheReadTokens: 900,
            cacheWriteTokens: 100,
            outputTokens: 50
        }
    };

    it('同 timestamp+chapter 的 SSE 重放只计一次', () => {
        const result = aggregateTelemetryTokens([record, { ...record }, { ...record }]);
        expect(result.inputTokens).toBe(100);
        expect(result.cacheReadTokens).toBe(900);
        expect(result.cacheWriteTokens).toBe(100);
        expect(result.outputTokens).toBe(50);
        expect(result.cacheHitRate).toBeCloseTo(900 / 1100, 10);
    });

    it('同键重放以最后一条为准（分片合并补全字段）', () => {
        const result = aggregateTelemetryTokens([
            { chapter: 1, timestamp: '2026-11-17T00:00:00.000Z', outputTokens: 10 },
            {
                chapter: 1,
                timestamp: '2026-11-17T00:00:00.000Z',
                token_usage: { inputTokens: 5, outputTokens: 20 }
            }
        ]);
        expect(result.inputTokens).toBe(5);
        expect(result.outputTokens).toBe(20);
    });

    it('chapterNumber 与 chapter 视为同一记录键', () => {
        const result = aggregateTelemetryTokens([
            record,
            { ...record, chapter: undefined, chapterNumber: 1 }
        ]);
        expect(result.outputTokens).toBe(50);
    });

    it('无键历史记录逐条保留，即使 Token 值完全相同也不误去重', () => {
        const legacy: TelemetryItem = { inputTokens: 10, outputTokens: 5 };
        const result = aggregateTelemetryTokens([legacy, { ...legacy }, { ...legacy }]);
        expect(result.inputTokens).toBe(30);
        expect(result.outputTokens).toBe(15);
        expect(result.cacheHitRate).toBe(0);
    });

    it('缺 timestamp 或缺 chapter 的记录不参与去重', () => {
        const result = aggregateTelemetryTokens([
            { chapter: 1, inputTokens: 10 },
            { chapter: 1, inputTokens: 10 },
            { timestamp: '2026-11-17T00:00:00.000Z', inputTokens: 10 },
            { timestamp: '2026-11-17T00:00:00.000Z', inputTokens: 10 }
        ]);
        expect(result.inputTokens).toBe(40);
    });

    it('同 chapter 不同 timestamp 是两次真实生成，分别累计', () => {
        const result = aggregateTelemetryTokens([
            record,
            { ...record, timestamp: '2026-11-17T03:00:00.000Z' }
        ]);
        expect(result.inputTokens).toBe(200);
        expect(result.outputTokens).toBe(100);
    });
});
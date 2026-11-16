import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    DEFAULT_STRUCTURED_BACKOFF_MS,
    DEFAULT_STRUCTURED_MAX_RETRIES,
    LoggingLlmAdapter,
    type LlmCallLogEntry,
    NodeSystemAdapter,
    ScriptedLlmAdapter,
    StructuredOutputError,
    generateStructuredJson
} from './index.js';

const tempDirs: string[] = [];

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('LlmPort & generateStructuredJson', () => {
    const schema = z.object({
        chapter: z.number().int().positive(),
        title: z.string().min(1)
    });

    it('在首次返回畸形 JSON 后附带错误提示重试并保持静态前缀不变', async () => {
        const sleepLog: number[] = [];
        const adapter = new ScriptedLlmAdapter([
            {
                text: '```json\n{"chapter": "not-a-number"}\n```',
                usage: { inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 0, outputTokens: 10 }
            },
            {
                text: '```json\n{"chapter": 1, "title": "夜雨归舟"}\n```',
                usage: { inputTokens: 120, cacheReadTokens: 80, cacheWriteTokens: 0, outputTokens: 15 }
            }
        ]);

        const res = await generateStructuredJson(
            adapter,
            {
                pool: 'fast_retrieval',
                staticPrefixBlocks: ['STATIC_BASE', 'ARC_ENVELOPE'],
                dynamicTail: '请输出章节信息'
            },
            schema,
            {
                sleepFn: async (ms) => {
                    sleepLog.push(ms);
                }
            }
        );

        expect(res.data).toEqual({ chapter: 1, title: '夜雨归舟' });
        expect(res.attempts).toBe(2);
        expect(sleepLog).toEqual([1000]);
        expect(res.totalUsage.inputTokens).toBe(220);
        // 修复重试绝不能改动 staticPrefixBlocks 的 SHA-256 指纹
        expect(adapter.history[0]?.prefixHash).toBe(adapter.history[1]?.prefixHash);
        expect(adapter.history[1]?.request.dynamicTail).toContain('上次输出格式校验失败');
    });

    it('连续 6 次（首轮 + 5 次重试）失败后按 1s->2s->4s->8s->16s 退避并抛出 StructuredOutputError', async () => {
        const sleepLog: number[] = [];
        const badResponse = {
            text: '非法的纯文本输出',
            usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }
        };
        const adapter = new ScriptedLlmAdapter(
            Array.from({ length: DEFAULT_STRUCTURED_MAX_RETRIES + 1 }, () => badResponse)
        );

        await expect(
            generateStructuredJson(
                adapter,
                {
                    pool: 'audit',
                    staticPrefixBlocks: ['PREFIX'],
                    dynamicTail: 'TAIL'
                },
                schema,
                {
                    sleepFn: async (ms) => {
                        sleepLog.push(ms);
                    }
                }
            )
        ).rejects.toBeInstanceOf(StructuredOutputError);

        expect(adapter.history).toHaveLength(6);
        expect(sleepLog).toEqual([...DEFAULT_STRUCTURED_BACKOFF_MS]);
    });

    it('LoggingLlmAdapter 应记录成功与失败的每次模型调用到 JSONL 并触发回调', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'narrateos-llmlog-'));
        tempDirs.push(tempDir);
        const logPath = join(tempDir, '.ops/llm_calls.jsonl');
        const events: LlmCallLogEntry[] = [];

        const inner = new ScriptedLlmAdapter([
            {
                text: 'ok',
                modelId: 'gemini-4-argon',
                usage: { inputTokens: 120, cacheReadTokens: 60, cacheWriteTokens: 0, outputTokens: 30 }
            },
            new Error('simulated timeout')
        ]);

        const logged = new LoggingLlmAdapter(inner, {
            logPath,
            onCallFinish: (entry) => events.push(entry)
        });

        const res = await logged.generate({
            pool: 'strong_creative',
            staticPrefixBlocks: ['STATIC'],
            dynamicTail: 'TAIL'
        });
        expect(res.text).toBe('ok');

        await expect(
            logged.generate({
                pool: 'audit',
                staticPrefixBlocks: ['STATIC'],
                dynamicTail: 'TAIL'
            })
        ).rejects.toThrow('simulated timeout');

        expect(events).toHaveLength(2);
        expect(events[0]?.status).toBe('ok');
        expect(events[0]?.modelId).toBe('gemini-4-argon');
        expect(events[0]?.usage?.cacheReadTokens).toBe(60);
        expect(events[1]?.status).toBe('error');
        expect(events[1]?.error).toContain('simulated timeout');

        const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(2);
        const parsed0 = JSON.parse(lines[0]!) as LlmCallLogEntry;
        expect(parsed0.pool).toBe('strong_creative');
        expect(parsed0.durationMs).toBeGreaterThanOrEqual(0);
    });
});

describe('NodeSystemAdapter (真实临时 Git 仓 + ripgrep)', () => {
    it('支持独立子仓初始化、原子提交、回读历史版本与 rg 检索', async () => {
        const bookRoot = await mkdtemp(join(tmpdir(), 'narrateos-sys-'));
        tempDirs.push(bookRoot);

        const sys = new NodeSystemAdapter();
        await sys.initRepo(bookRoot);

        const chapterPath = join(bookRoot, 'ch_0001.md');
        await writeFile(chapterPath, '第一段\n\n神代雪乃锁上了四楼音乐室的门。\n\n第三段\n', 'utf8');
        const c1 = await sys.commitPaths(bookRoot, ['ch_0001.md'], 'feat(ch-0001): init');
        expect(c1.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(await sys.isWorkingTreeClean(bookRoot)).toBe(true);

        const archived = await sys.readFileAtRef(bookRoot, c1.sha, 'ch_0001.md');
        expect(archived).toContain('神代雪乃');

        const matches = await sys.ripgrepSearch(bookRoot, ['神代雪乃'], ['ch_0001.md'], 2);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.text).toContain('神代雪乃');
        expect(matches[0]?.contextBefore).toContain('第一段');
        expect(matches[0]?.contextAfter).toContain('第三段');
    });
});

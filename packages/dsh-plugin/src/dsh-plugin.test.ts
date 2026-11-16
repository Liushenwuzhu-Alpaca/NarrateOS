import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    BookStore,
    NodeSystemAdapter,
    TxLockConflictError,
    type BookConfig,
    type WorldState
} from '@narrateos/core';
import {
    DshLlmAdapter,
    apply,
    inject,
    name,
    type DshCordisContext,
    type DshGenerateOptions,
    type DshLlmService,
    type DshStreamChunk,
    type DshWebServerRoute,
    type DshWebServerService,
    type LlmPoolRouting
} from './index.js';

const DEFAULT_ROUTING: LlmPoolRouting = {
    strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4' },
    fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    audit: { provider: 'openai-compat', model: 'gpt-audit' }
};

function createTestBookConfig(): BookConfig {
    return {
        book_slug: 'test-novel',
        title: '测试长篇',
        tokens_per_char: 0.5,
        writer_token_budget: 6000,
        max_auto_rollback_chapters: 3,
        structured_json_retry: {
            max_retries: 2,
            backoff_ms: [0, 0]
        },
        craft_plugins: [],
        prose_gate: {
            enable_anti_cliche: true,
            enable_cross_chapter_simile: true,
            cross_chapter_simile_window: 5
        }
    };
}

function createTestWorldState(): WorldState {
    return {
        frontmatter: {
            story_day: 1,
            current_volume: 1,
            current_chapter: 1,
            pov_character: 'char_lin',
            timeline_mode: 'MAINLINE'
        },
        summaryMarkdown: '主角林彻初入雾港。'
    };
}

async function setupTempBookRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'narrateos-dsh-test-'));
    const system = new NodeSystemAdapter();
    await system.initRepo(dir);
    const store = new BookStore(dir, system);
    await store.writeBookConfig(createTestBookConfig());
    await store.writeWorldState(createTestWorldState());
    await mkdir(join(dir, 'manuscripts'), { recursive: true });
    await writeFile(join(dir, 'manuscripts', 'ch_0001.md'), '# 第一章\n\n雾港雨夜。', 'utf8');
    await store.initializeWalFromDisk();
    await system.commitPaths(
        dir,
        ['world/book_config.yaml', 'world/world_state.md', 'manuscripts/ch_0001.md', '.ops/tx_state.json'],
        'chore: init test book'
    );
    return dir;
}

class MockWebServer implements DshWebServerService {
    private readonly exactRoutes = new Map<string, DshWebServerRoute>();
    private server: ReturnType<typeof createServer> | null = null;

    register(route: DshWebServerRoute): () => void {
        if (route.kind !== 'exact') {
            throw new Error(`测试桩仅预期 exact 路由: ${route.kind}`);
        }
        if (this.exactRoutes.has(route.path)) {
            throw new Error(`重复注册路由: ${route.path}`);
        }
        this.exactRoutes.set(route.path, route);
        return () => {
            this.exactRoutes.delete(route.path);
        };
    }

    hasRoute(path: string): boolean {
        return this.exactRoutes.has(path);
    }

    async listen(): Promise<string> {
        this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const route = this.exactRoutes.get(url.pathname);
            if (!route) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: 'Not Found' }));
                return;
            }
            try {
                await route.handler(req, res);
            } catch (err) {
                if (!res.headersSent) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
                } else {
                    res.destroy();
                }
            }
        });
        await new Promise<void>((resolve) => {
            this.server!.listen(0, '127.0.0.1', () => resolve());
        });
        const addr = this.server.address() as AddressInfo;
        return `http://127.0.0.1:${addr.port}`;
    }

    async close(): Promise<void> {
        if (!this.server) return;
        this.server.closeAllConnections?.();
        await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
        });
        this.server = null;
    }
}

describe('DshLlmAdapter', () => {
    it('应按 LlmPool 映射路由、无 sessionId 流式调用并拼装正文与标准化 TokenUsage', async () => {
        const captured: DshGenerateOptions[] = [];
        const mockLlm: DshLlmService = {
            async *stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
                captured.push(options);
                yield { type: 'block-start', index: 0, blockType: 'reasoning' };
                yield { type: 'reasoning-delta', index: 0, text: '内部推理过程不应进入正文' };
                yield { type: 'block-start', index: 1, blockType: 'text' };
                yield { type: 'text-delta', index: 1, text: '雨夜的' };
                yield { type: 'text-delta', index: 1, text: '雾港灯火微弱。' };
                yield {
                    type: 'block-end',
                    index: 1,
                    block: { type: 'text', text: '雨夜的雾港灯火微弱。' }
                };
                yield {
                    type: 'usage',
                    usage: {
                        inputTokens: 120,
                        cacheReadTokens: 800,
                        outputTokens: 35
                    }
                };
                yield { type: 'finish', reason: { kind: 'stop' } };
            }
        };

        const adapter = new DshLlmAdapter(mockLlm, {
            poolRouting: DEFAULT_ROUTING,
            sleepFn: async () => {}
        });

        const res = await adapter.generate({
            pool: 'strong_creative',
            staticPrefixBlocks: ['世界观基线', '文风基线'],
            dynamicTail: '请续写第 2 章开头',
            temperature: 0.7,
            maxTokens: 2048,
            reasoningEffort: 'medium'
        });

        expect(captured).toHaveLength(1);
        const call = captured[0]!;
        expect(call.provider).toBe('deepseek-official');
        expect(call.model).toBe('deepseek-v4');
        expect(call.system).toBe('世界观基线\n\n文风基线');
        expect(call.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: '请续写第 2 章开头' }] }
        ]);
        expect(call.temperature).toBe(0.7);
        expect(call.maxTokens).toBe(2048);
        expect(call.reasoningEffort).toBe('medium');
        expect('sessionId' in call).toBe(false);
        expect('tools' in call).toBe(false);

        expect(res.text).toBe('雨夜的雾港灯火微弱。');
        expect(res.usage).toEqual({
            inputTokens: 120,
            cacheReadTokens: 800,
            cacheWriteTokens: 0,
            outputTokens: 35
        });
        expect(res.modelId).toBe('deepseek-v4');
        expect(res.finishReason).toBe('stop');
    });

    it('遇到 RATE_LIMIT 瞬时错误应按指数退避重试并在恢复后返回结果', async () => {
        let attempts = 0;
        const sleepDelays: number[] = [];
        const mockLlm: DshLlmService = {
            async *stream(): AsyncIterable<DshStreamChunk> {
                attempts++;
                if (attempts < 3) {
                    yield {
                        type: 'finish',
                        reason: {
                            kind: 'error',
                            failure: {
                                code: 'RATE_LIMIT',
                                message: 'Too Many Requests',
                                status: 429
                            }
                        }
                    };
                    return;
                }
                yield { type: 'text-delta', index: 0, text: '重试成功输出' };
                yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            }
        };

        const adapter = new DshLlmAdapter(mockLlm, {
            poolRouting: DEFAULT_ROUTING,
            maxRetries: 3,
            backoffMs: [100, 200, 400],
            sleepFn: async (ms) => {
                sleepDelays.push(ms);
            }
        });

        const res = await adapter.generate({
            pool: 'fast_retrieval',
            staticPrefixBlocks: [],
            dynamicTail: '检索关键词'
        });

        expect(attempts).toBe(3);
        expect(sleepDelays).toEqual([100, 200]);
        expect(res.text).toBe('重试成功输出');
        expect(res.modelId).toBe('deepseek-v4-flash');
    });

    it('遇到 aborted 或非瞬时 AUTH 错误应立即抛出且不重试', async () => {
        let authAttempts = 0;
        const authLlm: DshLlmService = {
            async *stream(): AsyncIterable<DshStreamChunk> {
                authAttempts++;
                yield {
                    type: 'finish',
                    reason: {
                        kind: 'error',
                        failure: { code: 'AUTH', message: 'Invalid API Key', status: 401 }
                    }
                };
            }
        };
        const authAdapter = new DshLlmAdapter(authLlm, {
            poolRouting: DEFAULT_ROUTING,
            sleepFn: async () => {}
        });
        await expect(
            authAdapter.generate({ pool: 'audit', staticPrefixBlocks: [], dynamicTail: 'check' })
        ).rejects.toThrow(/Invalid API Key/);
        expect(authAttempts).toBe(1);

        let abortAttempts = 0;
        const abortLlm: DshLlmService = {
            async *stream(): AsyncIterable<DshStreamChunk> {
                abortAttempts++;
                yield {
                    type: 'finish',
                    reason: {
                        kind: 'aborted',
                        failure: { code: 'ABORTED', message: 'Request aborted' }
                    }
                };
            }
        };
        const abortAdapter = new DshLlmAdapter(abortLlm, {
            poolRouting: DEFAULT_ROUTING,
            sleepFn: async () => {}
        });
        await expect(
            abortAdapter.generate({ pool: 'audit', staticPrefixBlocks: [], dynamicTail: 'check' })
        ).rejects.toThrow(/Request aborted/);
        expect(abortAttempts).toBe(1);
    });
});

describe('NarrateOS DSH Plugin 控制面、SSE 与停机钩子', () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
        while (cleanups.length > 0) {
            const fn = cleanups.pop()!;
            await fn();
        }
    });

    it('应导出正确的插件元信息并在 REST 控制面、SSE 与停机 Safe-Point 正常联动', async () => {
        expect(name).toBe('narrateos-dsh-plugin');
        expect(inject).toEqual(['llm', 'webServer']);

        const bookRoot = await setupTempBookRepo();
        cleanups.push(async () => {
            await rm(bookRoot, { recursive: true, force: true });
        });

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());

        const mockLlm: DshLlmService = {
            async *stream(): AsyncIterable<DshStreamChunk> {
                yield { type: 'text-delta', index: 0, text: '{}' };
                yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            }
        };

        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: mockLlm,
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
                };
            }
        };

        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        let releaseStepGate: (() => void) | null = null;
        const stepEntered = new Promise<void>((resolve) => {
            releaseStepGate = resolve;
        });
        let finishStepGate: (() => void) | null = null;
        const stepCanFinish = new Promise<void>((resolve) => {
            finishStepGate = resolve;
        });

        let stepCalls = 0;
        let syncCalls = 0;
        let dreamCalls = 0;

        const fakeEngine = {
            async stepChapter(options: { chapterGoal: string; signal?: AbortSignal }) {
                stepCalls++;
                // 模拟持有排他事务锁的真实推进过程，直到测试释放门闩或收到安全点停机
                return await store.withTxLock(async () => {
                    await writeFile(
                        join(bookRoot, '.ops/telemetry.jsonl'),
                        `${JSON.stringify({ chapter: 2, proseGatePass: true, wordCount: 1500 })}\n`,
                        'utf8'
                    );
                    releaseStepGate?.();
                    await stepCanFinish;
                    return {
                        status: 'COMMITTED' as const,
                        chapterNumber: 2,
                        manuscriptPath: 'manuscripts/ch_0002.md',
                        featCommitSha: 'abc1234',
                        stateCommitSha: 'def5678',
                        outline: null,
                        replanCount: 0,
                        rewriteCount: 0,
                        patchRounds: 0,
                        telemetry: {
                            charCount: 3000,
                            wordCount: 1500,
                            sentenceCount: 80,
                            mattr500: 0.72,
                            kontoyiannisEntropy: 4.1,
                            sentenceLengthCv: 0.45,
                            clicheDensityPer1k: 0.5
                        },
                        totalUsage: {
                            inputTokens: 100,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0,
                            outputTokens: 50
                        },
                        updatedEntities: []
                    };
                });
            },
            async syncManuscripts() {
                syncCalls++;
                return {
                    status: 'CLEAN' as const,
                    dirtyChapters: [],
                    updatedEntities: [],
                    downstreamConflicts: [],
                    totalUsage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
                };
            }
        };

        const fakeDreaming = {
            async runDreaming() {
                dreamCalls++;
                return {
                    skipped: false,
                    vacuumedEntities: [],
                    warpedNodesFlipped: 0,
                    archivedFiles: [],
                    spotlightTriggers: [],
                    committedTxState: null,
                    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
                };
            }
        };

        apply(ctx, {
            bookRoot,
            poolRouting: DEFAULT_ROUTING,
            store,
            engine: fakeEngine as never,
            dreamingRunner: fakeDreaming as never
        });

        const baseUrl = await webServer.listen();

        // 1. 验证 GET /api/narrate/status
        const statusRes = await fetch(`${baseUrl}/api/narrate/status`);
        expect(statusRes.status).toBe(200);
        const statusJson = (await statusRes.json()) as {
            bookSlug: string;
            walPhase: string;
            lastCommittedChapter: number;
            latestChapter: number;
            runtime: { activeTask: string; haltRequested: boolean };
        };
        expect(statusJson.bookSlug).toBe('test-novel');
        expect(statusJson.walPhase).toBe('IDLE');
        expect(statusJson.lastCommittedChapter).toBe(1);
        expect(statusJson.latestChapter).toBe(1);
        expect(statusJson.runtime.activeTask).toBe('IDLE');

        // 2. 建立真实 SSE 连接，准备接收实时事件
        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        expect(sseRes.status).toBe(200);
        expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';

        async function readSseUntil(predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
            const deadline = Date.now() + timeoutMs;
            while (!predicate(sseBuffer)) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new Error(`等待 SSE 事件超时，已收到:\n${sseBuffer}`);
                }
                const chunk = await Promise.race([
                    reader.read(),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('SSE read timeout')), remaining)
                    )
                ]);
                if (chunk.done) break;
                sseBuffer += decoder.decode(chunk.value, { stream: true });
            }
            return sseBuffer;
        }

        await readSseUntil((text) => text.includes('event: connected'));

        // 3. 验证 POST /api/narrate/signals 写入 .ops/signals.jsonl
        const signalRes = await fetch(`${baseUrl}/api/narrate/signals`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'SPOTLIGHT_TRIGGER',
                chapter: 1,
                entity_id: 'char_lin',
                suggested_mode: 'MAINLINE',
                reason: '读者指令切入雾港码头'
            })
        });
        expect(signalRes.status).toBe(201);
        const signalsContent = await readFile(join(bookRoot, '.ops/signals.jsonl'), 'utf8');
        expect(signalsContent).toContain('SPOTLIGHT_TRIGGER');
        expect(signalsContent).toContain('读者指令切入雾港码头');
        await readSseUntil((text) => text.includes('event: signal:received'));

        // 4. 验证 POST /api/narrate/sync 与 POST /api/narrate/dream
        const syncRes = await fetch(`${baseUrl}/api/narrate/sync`, { method: 'POST' });
        expect(syncRes.status).toBe(200);
        expect(syncCalls).toBe(1);

        const dreamRes = await fetch(`${baseUrl}/api/narrate/dream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ force: true })
        });
        expect(dreamRes.status).toBe(200);
        expect(dreamCalls).toBe(1);

        // 5. 并发发起 POST /api/narrate/step，并在持有 tx.lock 时验证停机钩子等待 Safe-Point
        const stepPromise = fetch(`${baseUrl}/api/narrate/step`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chapterGoal: '推进第 2 章码头冲突' })
        });

        await stepEntered;
        // 验证运行中遇到 POST /api/narrate/halt 可正常响应
        const haltRes = await fetch(`${baseUrl}/api/narrate/halt`, { method: 'POST' });
        expect(haltRes.status).toBe(202);
        const haltJson = (await haltRes.json()) as { haltRequested: boolean };
        expect(haltJson.haltRequested).toBe(true);

        // 触发 Cordis ctx.effect 停机钩子，并在短暂延迟后允许 step 完成（模拟 Safe-Point 收尾）
        expect(disposers.length).toBeGreaterThan(0);
        const shutdownPromise = Promise.all(disposers.map((d) => Promise.resolve(d())));
        setTimeout(() => {
            finishStepGate?.();
        }, 30);

        const [stepHttpRes] = await Promise.all([stepPromise, shutdownPromise]);
        expect(stepHttpRes.status).toBe(200);
        expect(stepCalls).toBe(1);

        // 验证 SSE 收到了阶段事件与 telemetry.jsonl 指标
        await readSseUntil(
            (text) => text.includes('event: chapter:phase') && text.includes('event: telemetry')
        );
        sseAbort.abort();

        // 验证停机完成后 .ops/tx.lock 已释放且路由已卸载
        let lockExists = true;
        try {
            await readFile(join(bookRoot, '.ops/tx.lock'), 'utf8');
        } catch (err: unknown) {
            if ((err as { code?: string }).code === 'ENOENT') {
                lockExists = false;
            }
        }
        expect(lockExists).toBe(false);
        expect(webServer.hasRoute('/api/narrate/status')).toBe(false);
    });

    it('TxLockConflictError 应映射为 HTTP 409 Conflict，且 SSE 心跳在连接期间正常推送并在停机时清理', async () => {
        const bookRoot = await setupTempBookRepo();
        cleanups.push(async () => {
            await rm(bookRoot, { recursive: true, force: true });
        });

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());

        const mockLlm: DshLlmService = {
            async *stream(): AsyncIterable<DshStreamChunk> {
                yield { type: 'text-delta', index: 0, text: '{}' };
                yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
                yield { type: 'finish', reason: { kind: 'stop' } };
            }
        };

        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: mockLlm,
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
                };
            }
        };

        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        const conflictEngine = {
            async stepChapter() {
                throw new TxLockConflictError('作品仓库事务锁被占用');
            },
            async syncManuscripts() {
                throw new TxLockConflictError('作品仓库事务锁被占用');
            }
        };
        const conflictDreaming = {
            async runDreaming() {
                throw new TxLockConflictError('作品仓库事务锁被占用');
            }
        };

        apply(ctx, {
            bookRoot,
            poolRouting: DEFAULT_ROUTING,
            heartbeatIntervalMs: 30,
            store,
            engine: conflictEngine as never,
            dreamingRunner: conflictDreaming as never
        });

        const baseUrl = await webServer.listen();

        // 1. 验证 TxLockConflictError 统一映射为 409 Conflict
        const stepRes = await fetch(`${baseUrl}/api/narrate/step`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chapterGoal: '测试锁冲突' })
        });
        expect(stepRes.status).toBe(409);

        const syncRes = await fetch(`${baseUrl}/api/narrate/sync`, { method: 'POST' });
        expect(syncRes.status).toBe(409);

        const dreamRes = await fetch(`${baseUrl}/api/narrate/dream`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ force: true })
        });
        expect(dreamRes.status).toBe(409);

        // 2. 验证 SSE 心跳保活（: ping）与停机清理
        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        expect(sseRes.status).toBe(200);
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const deadline = Date.now() + 2000;
        while (!buffer.includes(': ping')) {
            if (Date.now() > deadline) {
                throw new Error(`未在超时内收到 SSE 心跳，已收到:\n${buffer}`);
            }
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
        }
        expect(buffer).toContain(': ping');

        // 触发停机钩子应清理定时器并结束 SSE 流
        await Promise.all(disposers.map((d) => Promise.resolve(d())));
        sseAbort.abort();
    });
});

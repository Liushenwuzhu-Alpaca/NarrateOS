import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    BookStore,
    DEFAULT_SECTION_HEADINGS,
    NodeSystemAdapter,
    serializeEntityMarkdown,
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

    it('应支持多作品目录扫描、安全切换与开新书 (boot)', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-books-root-'));
        cleanups.push(async () => {
            await rm(booksRoot, { recursive: true, force: true });
        });

        const system = new NodeSystemAdapter();
        const bookAlpha = join(booksRoot, 'alpha-book');
        await mkdir(bookAlpha, { recursive: true });
        await system.initRepo(bookAlpha);
        const storeAlpha = new BookStore(bookAlpha, system);
        await storeAlpha.writeBookConfig({ ...createTestBookConfig(), book_slug: 'alpha-book', title: '阿尔法卷' });
        await storeAlpha.writeWorldState(createTestWorldState());
        await mkdir(join(bookAlpha, 'manuscripts'), { recursive: true });
        await writeFile(join(bookAlpha, 'manuscripts', 'ch_0001.md'), '# 第一章\n\n阿尔法开篇。', 'utf8');
        await storeAlpha.initializeWalFromDisk();
        await system.commitPaths(
            bookAlpha,
            ['world/book_config.yaml', 'world/world_state.md', 'manuscripts/ch_0001.md', '.ops/tx_state.json'],
            'chore: init alpha'
        );

        const bookBeta = join(booksRoot, 'beta-book');
        await mkdir(bookBeta, { recursive: true });
        await system.initRepo(bookBeta);
        const storeBeta = new BookStore(bookBeta, system);
        await storeBeta.writeBookConfig({ ...createTestBookConfig(), book_slug: 'beta-book', title: '贝塔卷' });
        await storeBeta.writeWorldState({
            frontmatter: {
                story_day: 5,
                current_volume: 1,
                current_chapter: 2,
                pov_character: 'char_lin',
                timeline_mode: 'MAINLINE'
            },
            summaryMarkdown: '贝塔卷摘要。'
        });
        await storeBeta.initializeWalFromDisk();
        await system.commitPaths(
            bookBeta,
            ['world/book_config.yaml', 'world/world_state.md', '.ops/tx_state.json'],
            'chore: init beta'
        );

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());

        const mockLlm: DshLlmService = {
            async *stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk> {
                const prompt = options.messages[0]?.content[0]?.text ?? '';
                if (prompt.includes('标定样本')) {
                    yield { type: 'text-delta', index: 0, text: 'OK' };
                    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 2 } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                    return;
                }
                if (prompt.includes('Phase 1A')) {
                    const proposal = {
                        coordinates: {
                            topology: 'CONTINUOUS_ESCALATION',
                            tensionDrivers: ['EPISTEMIC_GAP'],
                            endgame: 'CONVERGENT_CLOSURE'
                        },
                        excludedCliches: ['失忆开局', '天降系统', '反派无脑送人头'],
                        pitches: [
                            {
                                index: 0,
                                title: '雾港钟表匠',
                                logline: '调查员在雨夜码头捡到一只倒走怀表，发现失踪船员的线索被封存在表壳内。',
                                coreHook: '每次拨动表冠，表盘都会映射出一段被掩盖的旧船坞记录。',
                                antiClicheNote: '无超凡系统加持，全部依靠实证拼图推进。'
                            },
                            {
                                index: 1,
                                title: '潮汐账本',
                                logline: '老旧船坞的潮汐时刻表与三年前沉船案的保险赔付单完全重合。',
                                coreHook: '幕后经手人仍在港务局内部销毁物理证据。',
                                antiClicheNote: '双线并进，反派同样在主动反侦察。'
                            }
                        ]
                    };
                    yield { type: 'text-delta', index: 0, text: JSON.stringify(proposal) };
                    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 80 } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                    return;
                }
                if (prompt.includes('候选切口列表')) {
                    yield {
                        type: 'text-delta',
                        index: 0,
                        text: JSON.stringify({
                            selectedIndex: 0,
                            rationale: '切口 0 兼具悬念张力与实证推理空间。'
                        })
                    };
                    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                    return;
                }
                if (prompt.includes('脱离 JSON 格式限制')) {
                    const bible = [
                        '# 全书架构圣经',
                        '',
                        '## 1. 里账本底层真相与代价定律',
                        '倒走怀表实为走私船队加密计时器，周伯曾参与篡改航道信号。',
                        '',
                        '## 2. 全书母题与卷级蓝图',
                        '- vol_01: 雾港迷局',
                        '- vol_02: 深水回响',
                        '',
                        '## 3. 第 1 卷三幕拐点与阶段天花板',
                        'Ch.01 雨夜码头拾获怀表，本卷天花板止于揭露旧船坞走私链。',
                        '',
                        '## 4. 核心角色',
                        '林彻、苏岚、周伯、倒走怀表。',
                        '',
                        '## 5. 伏笔与外部惯性',
                        '失踪怀表与港务局清点封条事件。'
                    ].join('\n');
                    yield { type: 'text-delta', index: 0, text: bible };
                    yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 120 } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                    return;
                }
                if (prompt.includes('执行异构剧透盲审')) {
                    yield {
                        type: 'text-delta',
                        index: 0,
                        text: JSON.stringify({
                            recallRate: 1,
                            missingFacts: [],
                            t0Leaks: [],
                            publicSpoilerLeaks: [],
                            passed: true
                        })
                    };
                    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 20 } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                    return;
                }
                const bootPayload = {
                    worldSummary: '新开作品世界摘要',
                    staticBaseAndVoice: '冷峻写实文风基线',
                    currentArcEnvelope: '第一卷：雾港迷局；Ch.01 雨夜码头拾获倒走怀表；Stage Ceiling 止于旧船坞走私链。',
                    l0SagasMarkdown: '# L0 纪元折叠总表\n\n- saga_01: 雾港真相与代价',
                    l1VolumesMarkdown: '# L1 活跃卷级总表\n\n- vol_01: 第一卷 雾港迷局 (story_day: 0..)\n- vol_02: 第二卷 深水回响 (待开启)',
                    voiceSamples: [{ tag: 'narrator', sample: '雨落在码头铁皮棚顶上。' }],
                    openThreads: [
                        {
                            threadId: 'thread_01',
                            title: '失踪的怀表',
                            wakeupCondition: '主角抵达旧船坞'
                        }
                    ],
                    futureHorizonEvents: [
                        {
                            eventId: 'evt_01',
                            storyDay: 3,
                            premise: '旧船坞未提前封锁',
                            description: '港务局例行清点仓库封条'
                        }
                    ],
                    loreEntries: [
                        {
                            id: 'lore_01',
                            title: '雾港潮汐钟',
                            summary: '旧码头用于校准货轮进出港的机械钟表体系',
                            content: '每逢大潮夜，雾港旧灯塔与码头钟楼会同步校准机械齿轮。'
                        }
                    ],
                    entities: [
                        {
                            entityId: 'char_lin',
                            canonicalName: '林彻',
                            uniqueAliases: ['林调查员'],
                            contextualTitles: [],
                            innateLocks: [{ visibility: 'PUBLIC', text: '左眉骨有旧疤' }],
                            acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: 'attire', text: '身着深灰风衣' }],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        },
                        {
                            entityId: 'char_su',
                            canonicalName: '苏岚',
                            uniqueAliases: ['苏法医'],
                            contextualTitles: [],
                            innateLocks: [{ visibility: 'PUBLIC', text: '习惯用左手记录笔记' }],
                            acquiredState: [{ storyDay: 0, visibility: 'SELF_ONLY', slotKey: 'agenda', text: '暗中核对沉船名单' }],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        },
                        {
                            entityId: 'char_zhou',
                            canonicalName: '周伯',
                            uniqueAliases: ['老周'],
                            contextualTitles: ['守夜人'],
                            innateLocks: [{ visibility: 'OMNISCIENT_SECRET', text: '三年前曾篡改沉船航道信号' }],
                            acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: 'location', text: '在旧船坞值班室守夜' }],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        },
                        {
                            entityId: 'item_watch',
                            canonicalName: '倒走怀表',
                            uniqueAliases: ['铜壳怀表'],
                            contextualTitles: [],
                            innateLocks: [{ visibility: 'PUBLIC', text: '表壳内侧刻有编号 07' }],
                            acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: 'owner', text: '暂由林彻保管' }],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        }
                    ]
                };
                yield { type: 'text-delta', index: 0, text: JSON.stringify(bootPayload) };
                yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 200 } };
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

        apply(ctx, {
            bookRoot: bookAlpha,
            booksRoot,
            poolRouting: DEFAULT_ROUTING
        });
        cleanups.push(async () => {
            await Promise.all(disposers.map((d) => Promise.resolve(d())));
        });

        const baseUrl = await webServer.listen();

        // 1. 扫描多作品列表
        const booksRes = await fetch(`${baseUrl}/api/narrate/books`);
        expect(booksRes.status).toBe(200);
        const booksJson = (await booksRes.json()) as {
            currentBookRoot: string;
            books: Array<{ bookRoot: string; slug: string; title: string; storyDay: number }>;
        };
        expect(booksJson.currentBookRoot).toBe(bookAlpha);
        expect(booksJson.books).toHaveLength(2);
        expect(booksJson.books.map((b) => b.slug).sort()).toEqual(['alpha-book', 'beta-book']);

        // 2. 防路径穿越校验
        const traversalRes = await fetch(`${baseUrl}/api/narrate/book/select`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookRoot: '../outside-dir' })
        });
        expect(traversalRes.status).toBe(400);

        // 3. 切换至 beta-book 并验证 SSE book_switched
        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        async function readUntil(pred: (t: string) => boolean): Promise<string> {
            const deadline = Date.now() + 3000;
            while (!pred(sseBuf)) {
                if (Date.now() > deadline) throw new Error(`SSE 超时:\n${sseBuf}`);
                const chunk = await reader.read();
                if (chunk.done) break;
                sseBuf += decoder.decode(chunk.value, { stream: true });
            }
            return sseBuf;
        }
        await readUntil((t) => t.includes('event: connected'));

        const selectRes = await fetch(`${baseUrl}/api/narrate/book/select`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug: 'beta-book' })
        });
        expect(selectRes.status).toBe(200);
        await readUntil((t) => t.includes('event: book_switched'));

        const statusAfterSelect = await (await fetch(`${baseUrl}/api/narrate/status`)).json() as {
            bookSlug: string;
        };
        expect(statusAfterSelect.bookSlug).toBe('beta-book');

        // 4. 持有 tx.lock 时拒绝切换，返回 409 Conflict
        await writeFile(
            join(bookBeta, '.ops/tx.lock'),
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            'utf8'
        );
        const conflictSelectRes = await fetch(`${baseUrl}/api/narrate/book/select`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ slug: 'alpha-book' })
        });
        expect(conflictSelectRes.status).toBe(409);
        await rm(join(bookBeta, '.ops/tx.lock'), { force: true });

        // 5. 调用 POST /api/narrate/boot 开新书并自动切换
        const bootRes = await fetch(`${baseUrl}/api/narrate/boot`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                slug: 'gamma-book',
                title: '伽马新篇',
                povCharacter: 'char_lin',
                mode: 'original',
                premiseOrSeed: '雾港调查员在雨夜发现失踪怀表。'
            })
        });
        expect(bootRes.status).toBe(201);
        const statusAfterBoot = await (await fetch(`${baseUrl}/api/narrate/status`)).json() as {
            bookSlug: string;
            title: string;
        };
        expect(statusAfterBoot.bookSlug).toBe('gamma-book');
        expect(statusAfterBoot.title).toBe('伽马新篇');

        sseAbort.abort();
    });

    it('应支持章节列表、单章读取与 Diff、PUT 在线编辑触发 Sync 及物化视图 views 查询', async () => {
        const bookRoot = await setupTempBookRepo();
        cleanups.push(async () => {
            await rm(bookRoot, { recursive: true, force: true });
        });

        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        await mkdir(join(bookRoot, 'entities'), { recursive: true });
        await writeFile(join(bookRoot, 'world/future_horizon.md'), '# 未来地平线\n\n第 3 章揭露旧船坞阴谋。', 'utf8');
        await writeFile(join(bookRoot, 'world/open_threads.md'), '- [ ] thread_watch: 怀表去向', 'utf8');
        await writeFile(
            join(bookRoot, 'entities/char_lin.md'),
            serializeEntityMarkdown({
                metadata: {
                    entity_id: 'char_lin',
                    canonical_name: '林彻',
                    unique_aliases: ['林调查员'],
                    contextual_titles: [],
                    historical_anchors: [],
                    last_seen_ch: 1
                },
                sectionHeadings: DEFAULT_SECTION_HEADINGS,
                innateLocks: [{ visibility: 'PUBLIC', text: '左眉骨有旧疤', continuationLines: [] }],
                acquiredState: [{ storyDay: 1, chapter: 1, visibility: 'PUBLIC', text: '抵达雾港码头', continuationLines: [] }],
                irreversibleTrajectory: [],
                recentBuffer: [{ text: '正在追踪怀表线索', continuationLines: [] }]
            }),
            'utf8'
        );
        await writeFile(
            join(bookRoot, '.ops/telemetry.jsonl'),
            `${JSON.stringify({ chapter: 1, proseGatePass: true, wordCount: 2200 })}\n`,
            'utf8'
        );
        await writeFile(
            join(bookRoot, '.ops/signals.jsonl'),
            `${JSON.stringify({
                type: 'SPOTLIGHT_TRIGGER',
                chapter: 1,
                entity_id: 'char_lin',
                suggested_mode: 'MAINLINE',
                reason: '测试信号',
                created_at: new Date().toISOString()
            })}\n`,
            'utf8'
        );
        await writeFile(
            join(bookRoot, '.ops/safe_halt.json'),
            JSON.stringify({ status: 'SAFE_HALT', chapterNumber: 2, reason: '测试挂起' }),
            'utf8'
        );

        let syncCalls = 0;
        const fakeEngine = {
            async stepChapter() {
                throw new Error('not used');
            },
            async syncManuscripts() {
                syncCalls++;
                return {
                    status: 'PROSE_POLISH_SYNCED' as const,
                    dirtyChapters: [],
                    updatedEntities: [],
                    downstreamConflicts: [],
                    totalUsage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
                };
            }
        };

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());
        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: {
                async *stream() {
                    yield { type: 'text-delta', index: 0, text: '{}' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            },
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
                };
            }
        };

        apply(ctx, {
            bookRoot,
            poolRouting: DEFAULT_ROUTING,
            store,
            engine: fakeEngine as never
        });
        cleanups.push(async () => {
            await Promise.all(disposers.map((d) => Promise.resolve(d())));
        });

        const baseUrl = await webServer.listen();

        // 1. 章节列表
        const chaptersRes = await fetch(`${baseUrl}/api/narrate/chapters`);
        expect(chaptersRes.status).toBe(200);
        const chaptersJson = (await chaptersRes.json()) as {
            chapters: Array<{ chapterNumber: number; fileName: string; title: string; dirty: boolean }>;
        };
        expect(chaptersJson.chapters).toHaveLength(1);
        expect(chaptersJson.chapters[0]?.chapterNumber).toBe(1);
        expect(chaptersJson.chapters[0]?.fileName).toBe('ch_0001.md');
        expect(chaptersJson.chapters[0]?.title).toBe('第一章');
        expect(chaptersJson.chapters[0]?.dirty).toBe(false);

        // 2. 单章读取
        const chRes = await fetch(`${baseUrl}/api/narrate/chapter?ch=1`);
        expect(chRes.status).toBe(200);
        const chJson = (await chRes.json()) as {
            chapterNumber: number;
            content: string;
            dirty: boolean;
            sha256: string;
            diffFromHead: string;
        };
        expect(chJson.chapterNumber).toBe(1);
        expect(chJson.content).toContain('雾港雨夜');
        expect(chJson.dirty).toBe(false);
        expect(chJson.sha256).toHaveLength(64);

        // 3. PUT 在线编辑并触发 Sync + SSE chapter_synced
        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        async function readUntil(pred: (t: string) => boolean): Promise<string> {
            const deadline = Date.now() + 3000;
            while (!pred(sseBuf)) {
                if (Date.now() > deadline) throw new Error(`SSE 超时:\n${sseBuf}`);
                const chunk = await reader.read();
                if (chunk.done) break;
                sseBuf += decoder.decode(chunk.value, { stream: true });
            }
            return sseBuf;
        }
        await readUntil((t) => t.includes('event: connected'));

        const putRes = await fetch(`${baseUrl}/api/narrate/chapter`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                chapterNumber: 1,
                content: '# 第一章\n\n雾港雨夜，钟楼敲响十二下。'
            })
        });
        expect(putRes.status).toBe(200);
        expect(syncCalls).toBe(1);
        const diskContent = await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8');
        expect(diskContent).toContain('钟楼敲响十二下');
        await readUntil((t) => t.includes('event: chapter_synced'));

        // 读取修改后的 diffFromHead 应包含差异
        const chAfterRes = await fetch(`${baseUrl}/api/narrate/chapter?ch=1`);
        const chAfterJson = (await chAfterRes.json()) as { dirty: boolean; diffFromHead: string };
        expect(chAfterJson.dirty).toBe(true);
        expect(chAfterJson.diffFromHead).toContain('钟楼敲响十二下');

        // 4. 物化视图 views 查询
        const entitiesView = await (await fetch(`${baseUrl}/api/narrate/views?kind=entities`)).json() as {
            entities: Array<{ entityId: string; canonicalName: string }>;
            coldArchiveCount: number;
        };
        expect(entitiesView.entities.some((e) => e.entityId === 'char_lin')).toBe(true);
        expect(entitiesView.coldArchiveCount).toBe(0);

        const horizonView = await (await fetch(`${baseUrl}/api/narrate/views?kind=horizon`)).json() as {
            content: string;
        };
        expect(horizonView.content).toContain('旧船坞阴谋');

        const threadsView = await (await fetch(`${baseUrl}/api/narrate/views?kind=threads`)).json() as {
            content: string;
        };
        expect(threadsView.content).toContain('thread_watch');

        const telemetryView = await (await fetch(`${baseUrl}/api/narrate/views?kind=telemetry`)).json() as {
            entries: Array<{ chapter: number }>;
        };
        expect(telemetryView.entries).toHaveLength(1);

        const signalsView = await (await fetch(`${baseUrl}/api/narrate/views?kind=signals`)).json() as {
            signals: Array<{ type: string }>;
        };
        expect(signalsView.signals).toHaveLength(1);

        const haltView = await (await fetch(`${baseUrl}/api/narrate/views?kind=halt`)).json() as {
            safeHalt: { status: string } | null;
            quarantineReport: unknown;
        };
        expect(haltView.safeHalt?.status).toBe('SAFE_HALT');
        expect(haltView.quarantineReport).toBeNull();

        sseAbort.abort();
    });

    it('应支持 YOLO 连跑 2 章、推送 6 阶段 stage 事件并支持中途安全停止', async () => {
        const bookRoot = await setupTempBookRepo();
        cleanups.push(async () => {
            await rm(bookRoot, { recursive: true, force: true });
        });

        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        let completedStepCount = 0;
        let dreamCount = 0;

        const fakeEngine = {
            async stepChapter(options: {
                chapterGoal: string;
                onProgress?: (evt: { stage: string; chapterNumber: number; message: string; timestamp: string }) => void;
            }) {
                const ch = 2 + completedStepCount;
                for (const stage of ['LIBRARIAN', 'PLANNER', 'WRITER', 'PROSE_GATE', 'FACT_CHECKER', 'EXTRACTOR']) {
                    options.onProgress?.({
                        stage,
                        chapterNumber: ch,
                        message: `${stage} running`,
                        timestamp: new Date().toISOString()
                    });
                }
                completedStepCount++;
                return {
                    status: 'COMMITTED' as const,
                    chapterNumber: ch,
                    manuscriptPath: `manuscripts/ch_000${ch}.md`,
                    featCommitSha: 'sha1',
                    stateCommitSha: 'sha2',
                    outline: null,
                    replanCount: 0,
                    rewriteCount: 0,
                    patchRounds: 0,
                    telemetry: {
                        charCount: 1000,
                        wordCount: 500,
                        sentenceCount: 20,
                        mattr500: 0.7,
                        kontoyiannisEntropy: 4.0,
                        sentenceLengthCv: 0.4,
                        clicheDensityPer1k: 0.2
                    },
                    totalUsage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
                    updatedEntities: [],
                    nextChapterOptions: []
                };
            },
            async syncManuscripts() {
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
                dreamCount++;
                return {
                    skipped: true,
                    vacuumedEntities: [],
                    warpedNodesFlipped: 0,
                    archivedFiles: [],
                    spotlightTriggers: [],
                    committedTxState: null,
                    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
                };
            }
        };

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());
        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: {
                async *stream() {
                    yield { type: 'text-delta', index: 0, text: '{}' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            },
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
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
        cleanups.push(async () => {
            await Promise.all(disposers.map((d) => Promise.resolve(d())));
        });

        const baseUrl = await webServer.listen();

        // 注入 1 条待消费信号，验证 status.pendingSignalsCount
        const sigRes = await fetch(`${baseUrl}/api/narrate/signals`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'SPOTLIGHT_TRIGGER',
                chapter: 1,
                entity_id: 'char_lin',
                suggested_mode: 'MAINLINE',
                reason: '增加雨夜压迫感'
            })
        });
        expect(sigRes.status).toBe(201);

        const preStatus = await (await fetch(`${baseUrl}/api/narrate/status`)).json() as {
            pendingSignalsCount: number;
            yolo: { running: boolean; completedChapters: number; targetChapters: number };
        };
        expect(preStatus.pendingSignalsCount).toBe(1);
        expect(preStatus.yolo.running).toBe(false);

        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        async function readUntil(pred: (t: string) => boolean): Promise<string> {
            const deadline = Date.now() + 4000;
            while (!pred(sseBuf)) {
                if (Date.now() > deadline) throw new Error(`SSE 超时:\n${sseBuf}`);
                const chunk = await reader.read();
                if (chunk.done) break;
                sseBuf += decoder.decode(chunk.value, { stream: true });
            }
            return sseBuf;
        }
        await readUntil((t) => t.includes('event: connected'));

        // 启动 YOLO 连跑 2 章
        const yoloStartRes = await fetch(`${baseUrl}/api/narrate/yolo/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetChapters: 2, defaultGoal: '推进雾港连跑' })
        });
        expect(yoloStartRes.status).toBe(202);

        await readUntil((t) => t.includes('event: stage') && t.includes('event: yolo_completed'));
        expect(completedStepCount).toBe(2);
        expect(dreamCount).toBe(2);

        // 验证中途安全停止：启动持续连跑 (targetChapters: 0) 并在首章门闩处触发 yolo/stop
        let holdSecondChapter: () => void = () => {};
        let enteredSecondCall = false;
        let resolveEnteredSecond: (() => void) | null = null;
        const secondEntered = new Promise<void>((resolve) => {
            resolveEnteredSecond = resolve;
        });

        const origStep = fakeEngine.stepChapter;
        fakeEngine.stepChapter = async (opts) => {
            if (completedStepCount >= 3 && !enteredSecondCall) {
                enteredSecondCall = true;
                resolveEnteredSecond?.();
                await new Promise<void>((resolve) => {
                    holdSecondChapter = resolve;
                });
            }
            return await origStep(opts);
        };

        const continuousRes = await fetch(`${baseUrl}/api/narrate/yolo/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetChapters: 0 })
        });
        expect(continuousRes.status).toBe(202);

        await secondEntered;
        const stopRes = await fetch(`${baseUrl}/api/narrate/yolo/stop`, { method: 'POST' });
        expect(stopRes.status).toBe(202);
        holdSecondChapter();

        await readUntil((t) => t.includes('event: yolo_halted'));
        sseAbort.abort();
    });

    it('PUT /api/narrate/chapter 在 .ops/tx.lock 被占用时返回 409 且不修改磁盘文件', async () => {
        const bookRoot = await setupTempBookRepo();
        cleanups.push(async () => {
            await rm(bookRoot, { recursive: true, force: true });
        });

        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const originalContent = await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8');

        let syncCalls = 0;
        const fakeEngine = {
            async stepChapter() {
                throw new Error('not used');
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

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());
        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: {
                async *stream() {
                    yield { type: 'text-delta', index: 0, text: '{}' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            },
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
                };
            }
        };

        apply(ctx, {
            bookRoot,
            poolRouting: DEFAULT_ROUTING,
            store,
            engine: fakeEngine as never
        });
        cleanups.push(async () => {
            await Promise.all(disposers.map((d) => Promise.resolve(d())));
        });

        const baseUrl = await webServer.listen();

        // 模拟外部进程持有有效 .ops/tx.lock
        await writeFile(
            join(bookRoot, '.ops/tx.lock'),
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            'utf8'
        );

        const putRes = await fetch(`${baseUrl}/api/narrate/chapter`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                chapterNumber: 1,
                content: '# 第一章\n\n不应被写入的内容'
            })
        });
        expect(putRes.status).toBe(409);
        expect(syncCalls).toBe(0);

        const diskContent = await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8');
        expect(diskContent).toBe(originalContent);

        // yolo/start 同样应被有效 .ops/tx.lock 前置拦截返回 409
        const yoloStartRes = await fetch(`${baseUrl}/api/narrate/yolo/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetChapters: 1 })
        });
        expect(yoloStartRes.status).toBe(409);
    });

    it('yolo/stop 不打断当前在途生成而在本章提交后平滑停止，且 YOLO 运行期间互斥外部任务', async () => {
        const bookRoot = await setupTempBookRepo();
        cleanups.push(async () => {
            await rm(bookRoot, { recursive: true, force: true });
        });

        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        let completedStepCount = 0;
        let observedAbortedDuringStep = false;
        let dreamCalls = 0;
        let holdCurrentChapter: () => void = () => {};
        let resolveEnteredFirst: (() => void) | null = null;
        const firstEntered = new Promise<void>((resolve) => {
            resolveEnteredFirst = resolve;
        });

        const fakeEngine = {
            async stepChapter(options: { signal?: AbortSignal }) {
                resolveEnteredFirst?.();
                await new Promise<void>((resolve) => {
                    holdCurrentChapter = resolve;
                });
                observedAbortedDuringStep = Boolean(options.signal?.aborted);
                completedStepCount++;
                return {
                    status: 'COMMITTED' as const,
                    chapterNumber: 1 + completedStepCount,
                    manuscriptPath: `manuscripts/ch_000${1 + completedStepCount}.md`,
                    featCommitSha: 'sha1',
                    stateCommitSha: 'sha2',
                    outline: null,
                    replanCount: 0,
                    rewriteCount: 0,
                    patchRounds: 0,
                    telemetry: {
                        charCount: 1000,
                        wordCount: 500,
                        sentenceCount: 20,
                        mattr500: 0.7,
                        kontoyiannisEntropy: 4.0,
                        sentenceLengthCv: 0.4,
                        clicheDensityPer1k: 0.2
                    },
                    totalUsage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
                    updatedEntities: [],
                    nextChapterOptions: []
                };
            },
            async syncManuscripts() {
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
                    skipped: true,
                    vacuumedEntities: [],
                    warpedNodesFlipped: 0,
                    archivedFiles: [],
                    spotlightTriggers: [],
                    committedTxState: null,
                    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
                };
            }
        };

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());
        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: {
                async *stream() {
                    yield { type: 'text-delta', index: 0, text: '{}' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            },
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
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
        cleanups.push(async () => {
            await Promise.all(disposers.map((d) => Promise.resolve(d())));
        });

        const baseUrl = await webServer.listen();
        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        async function readUntil(pred: (t: string) => boolean): Promise<string> {
            const deadline = Date.now() + 4000;
            while (!pred(sseBuf)) {
                if (Date.now() > deadline) throw new Error(`SSE 超时:\n${sseBuf}`);
                const chunk = await reader.read();
                if (chunk.done) break;
                sseBuf += decoder.decode(chunk.value, { stream: true });
            }
            return sseBuf;
        }
        await readUntil((t) => t.includes('event: connected'));

        const yoloStartRes = await fetch(`${baseUrl}/api/narrate/yolo/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetChapters: 3 })
        });
        expect(yoloStartRes.status).toBe(202);

        await firstEntered;

        // YOLO 运行期间，外部并发请求必须返回 409 Conflict
        const [stepConflict, syncConflict, dreamConflict, putConflict] = await Promise.all([
            fetch(`${baseUrl}/api/narrate/step`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chapterGoal: '外部插队' })
            }),
            fetch(`${baseUrl}/api/narrate/sync`, { method: 'POST' }),
            fetch(`${baseUrl}/api/narrate/dream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({})
            }),
            fetch(`${baseUrl}/api/narrate/chapter`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chapterNumber: 1, content: '# 冲突编辑' })
            })
        ]);
        expect(stepConflict.status).toBe(409);
        expect(syncConflict.status).toBe(409);
        expect(dreamConflict.status).toBe(409);
        expect(putConflict.status).toBe(409);

        // 触发安全点停止：仅标记 stopRequested 并广播 SSE，不应 abort 在途生成
        const stopRes = await fetch(`${baseUrl}/api/narrate/yolo/stop`, { method: 'POST' });
        expect(stopRes.status).toBe(202);
        await readUntil((t) => t.includes('event: yolo:stop_requested'));

        // 放行当前在途章节，验证未被打断且本章提交后平滑停止（不再进入第 2 章与 dreaming）
        holdCurrentChapter();
        await readUntil((t) => t.includes('event: yolo_halted'));

        expect(observedAbortedDuringStep).toBe(false);
        expect(completedStepCount).toBe(1);
        expect(dreamCalls).toBe(0);

        const statusAfter = await (await fetch(`${baseUrl}/api/narrate/status`)).json() as {
            yolo: { running: boolean; completedChapters: number };
        };
        expect(statusAfter.yolo.running).toBe(false);
        expect(statusAfter.yolo.completedChapters).toBe(1);

        sseAbort.abort();
    });

    it('GET /api/narrate/status 在未配置 model_routing 时从环境变量填充 modelRouting，且显式配置优先', async () => {
        const prevStrong = process.env['NARRATEOS_MODEL_STRONG'];
        const prevFast = process.env['NARRATEOS_MODEL_FAST'];
        const prevAudit = process.env['NARRATEOS_MODEL_AUDIT'];
        process.env['NARRATEOS_MODEL_STRONG'] = 'deepseek-reasoner';
        process.env['NARRATEOS_MODEL_FAST'] = 'deepseek-chat';
        process.env['NARRATEOS_MODEL_AUDIT'] = 'gpt-audit-env';

        try {
            const bookRoot = await setupTempBookRepo();
            cleanups.push(async () => {
                await rm(bookRoot, { recursive: true, force: true });
            });
            const store = new BookStore(bookRoot, new NodeSystemAdapter());
            const webServer = new MockWebServer();
            cleanups.push(() => webServer.close());
            const mockLlm: DshLlmService = {
                async *stream(): AsyncIterable<DshStreamChunk> {
                    yield { type: 'text-delta', index: 0, text: '{}' };
                    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            };
            const ctx: DshCordisContext = {
                llm: mockLlm,
                webServer,
                effect(factory) {
                    const cleanup = factory();
                    return () => {
                        if (cleanup) void cleanup();
                    };
                }
            };

            apply(ctx, {
                bookRoot,
                poolRouting: DEFAULT_ROUTING,
                store,
                engine: { async stepChapter() {}, async syncManuscripts() {} } as never,
                dreamingRunner: { async runDreaming() {} } as never
            });

            const baseUrl = await webServer.listen();
            const envOnlyRes = await fetch(`${baseUrl}/api/narrate/status`);
            expect(envOnlyRes.status).toBe(200);
            const envOnlyJson = (await envOnlyRes.json()) as {
                modelRouting: Record<string, string>;
            };
            expect(envOnlyJson.modelRouting).toEqual({
                strong_creative: 'deepseek-reasoner',
                fast_retrieval: 'deepseek-chat',
                audit: 'gpt-audit-env'
            });

            // 显式配置部分 model_routing 时，显式项优先，其余池继续从环境变量回退
            await writeFile(
                join(bookRoot, 'world/book_config.yaml'),
                [
                    'book_slug: test-novel',
                    'title: 测试小说',
                    'tokens_per_char: 1.5',
                    'writer_token_budget: 24000',
                    'max_auto_rollback_chapters: 3',
                    'model_routing:',
                    '  strong_creative: custom-strong-model',
                    '  custom_pool: custom-extra-model',
                    ''
                ].join('\n'),
                'utf8'
            );

            const mixedRes = await fetch(`${baseUrl}/api/narrate/status`);
            expect(mixedRes.status).toBe(200);
            const mixedJson = (await mixedRes.json()) as {
                modelRouting: Record<string, string>;
            };
            expect(mixedJson.modelRouting).toEqual({
                strong_creative: 'custom-strong-model',
                fast_retrieval: 'deepseek-chat',
                audit: 'gpt-audit-env',
                custom_pool: 'custom-extra-model'
            });
        } finally {
            if (prevStrong === undefined) delete process.env['NARRATEOS_MODEL_STRONG'];
            else process.env['NARRATEOS_MODEL_STRONG'] = prevStrong;
            if (prevFast === undefined) delete process.env['NARRATEOS_MODEL_FAST'];
            else process.env['NARRATEOS_MODEL_FAST'] = prevFast;
            if (prevAudit === undefined) delete process.env['NARRATEOS_MODEL_AUDIT'];
            else process.env['NARRATEOS_MODEL_AUDIT'] = prevAudit;
        }
    });

    it('YOLO 默认目标连跑时应消费上一章产出的 nextChapterOptions 拼入下一章 chapterGoal', async () => {
        const bookRoot = await setupTempBookRepo();
        cleanups.push(async () => {
            await rm(bookRoot, { recursive: true, force: true });
        });

        const store = new BookStore(bookRoot, new NodeSystemAdapter());
        const receivedGoals: string[] = [];
        let callIndex = 0;

        const fakeEngine = {
            async stepChapter(options: { chapterGoal: string }) {
                receivedGoals.push(options.chapterGoal);
                callIndex++;
                const ch = 1 + callIndex;
                return {
                    status: 'COMMITTED' as const,
                    chapterNumber: ch,
                    manuscriptPath: `manuscripts/ch_000${ch}.md`,
                    featCommitSha: 'sha1',
                    stateCommitSha: 'sha2',
                    outline: null,
                    replanCount: 0,
                    rewriteCount: 0,
                    patchRounds: 0,
                    telemetry: {
                        charCount: 1000,
                        wordCount: 500,
                        sentenceCount: 20,
                        mattr500: 0.7,
                        kontoyiannisEntropy: 4.0,
                        sentenceLengthCv: 0.4,
                        clicheDensityPer1k: 0.2
                    },
                    totalUsage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 },
                    updatedEntities: [],
                    nextChapterOptions:
                        callIndex === 1
                            ? ['陆沉追查老钟表行里的残缺航海日志', '星野琉璃暗中核对沉船乘客名单']
                            : []
                };
            },
            async syncManuscripts() {
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
                return {
                    skipped: true,
                    vacuumedEntities: [],
                    warpedNodesFlipped: 0,
                    archivedFiles: [],
                    spotlightTriggers: [],
                    committedTxState: null,
                    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
                };
            }
        };

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());
        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: {
                async *stream() {
                    yield { type: 'text-delta', index: 0, text: '{}' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            },
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
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
        cleanups.push(async () => {
            await Promise.all(disposers.map((d) => Promise.resolve(d())));
        });

        const baseUrl = await webServer.listen();
        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        async function readUntil(pred: (t: string) => boolean): Promise<string> {
            const deadline = Date.now() + 4000;
            while (!pred(sseBuf)) {
                if (Date.now() > deadline) throw new Error(`SSE 超时:\n${sseBuf}`);
                const chunk = await reader.read();
                if (chunk.done) break;
                sseBuf += decoder.decode(chunk.value, { stream: true });
            }
            return sseBuf;
        }
        await readUntil((t) => t.includes('event: connected'));

        const yoloStartRes = await fetch(`${baseUrl}/api/narrate/yolo/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetChapters: 2 })
        });
        expect(yoloStartRes.status).toBe(202);
        await readUntil((t) => t.includes('event: yolo_completed'));

        expect(receivedGoals).toHaveLength(2);
        expect(receivedGoals[0]).toBe('按既定主线与人物弧光自然推进下一章');
        expect(receivedGoals[1]).toContain('陆沉追查老钟表行里的残缺航海日志');
        expect(receivedGoals[1]).toContain('星野琉璃暗中核对沉船乘客名单');

        sseAbort.abort();
    });

    it('POST /api/narrate/volume/advance 应校验 tx.lock、调用 advanceVolume 并广播 volume:advanced SSE 事件', async () => {
        const bookRoot = await setupTempBookRepo();
        cleanups.push(() => rm(bookRoot, { recursive: true, force: true }));
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        const advanceCalls: Array<{ companionEntityIds?: string[]; completeBook?: boolean }> = [];
        const fakeEngine = {
            async stepChapter() {
                throw new Error('not used');
            },
            async syncManuscripts() {
                throw new Error('not used');
            },
            async advanceVolume(opts: { companionEntityIds?: string[]; completeBook?: boolean } = {}) {
                advanceCalls.push(opts);
                return {
                    sealedVolume: 1,
                    nextVolume: 2,
                    tagName: 'arc-seal-vol-01',
                    archivedEntities: ['char_002'],
                    completedBook: Boolean(opts.completeBook),
                    commitSha: 'deadbeef1234'
                };
            }
        };

        const fakeDreaming = {
            async runDreaming() {
                throw new Error('not used');
            }
        };

        const webServer = new MockWebServer();
        cleanups.push(() => webServer.close());
        const disposers: Array<() => void | Promise<void>> = [];
        const ctx: DshCordisContext = {
            llm: {
                async *stream() {
                    yield { type: 'text-delta', index: 0, text: '{}' };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                }
            },
            webServer,
            effect(factory) {
                const cleanup = factory();
                if (cleanup) disposers.push(cleanup);
                return () => {
                    if (cleanup) void cleanup();
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
        cleanups.push(async () => {
            await Promise.all(disposers.map((d) => Promise.resolve(d())));
        });

        const baseUrl = await webServer.listen();
        expect(webServer.hasRoute('/api/narrate/volume/advance')).toBe(true);

        const sseAbort = new AbortController();
        const sseRes = await fetch(`${baseUrl}/api/narrate/events`, { signal: sseAbort.signal });
        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        async function readUntil(pred: (t: string) => boolean): Promise<string> {
            const deadline = Date.now() + 4000;
            while (!pred(sseBuf)) {
                if (Date.now() > deadline) throw new Error(`SSE 超时:\n${sseBuf}`);
                const chunk = await reader.read();
                if (chunk.done) break;
                sseBuf += decoder.decode(chunk.value, { stream: true });
            }
            return sseBuf;
        }
        await readUntil((t) => t.includes('event: connected'));

        // 1. 存在活跃 .ops/tx.lock 时应返回 409
        await mkdir(join(bookRoot, '.ops'), { recursive: true });
        const lockPath = join(bookRoot, '.ops/tx.lock');
        await writeFile(
            lockPath,
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            'utf8'
        );
        const lockedRes = await fetch(`${baseUrl}/api/narrate/volume/advance`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ companionEntityIds: ['char_003'] })
        });
        expect(lockedRes.status).toBe(409);
        await rm(lockPath, { force: true });

        // 2. 正常调用返回 200 并广播 volume:advanced
        const okRes = await fetch(`${baseUrl}/api/narrate/volume/advance`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ companionEntityIds: ['char_003'], completeBook: false })
        });
        expect(okRes.status).toBe(200);
        const okJson = (await okRes.json()) as {
            sealedVolume: number;
            nextVolume: number;
            tagName: string;
            archivedEntities: string[];
        };
        expect(okJson.sealedVolume).toBe(1);
        expect(okJson.nextVolume).toBe(2);
        expect(okJson.tagName).toBe('arc-seal-vol-01');
        expect(okJson.archivedEntities).toEqual(['char_002']);
        expect(advanceCalls).toHaveLength(1);
        expect(advanceCalls[0]).toMatchObject({ companionEntityIds: ['char_003'], completeBook: false });

        const events = await readUntil((t) => t.includes('event: volume:advanced'));
        expect(events).toContain('arc-seal-vol-01');

        sseAbort.abort();
    });
});

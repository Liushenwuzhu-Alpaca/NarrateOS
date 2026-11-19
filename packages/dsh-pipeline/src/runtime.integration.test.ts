import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { isNativeConfigSchema } from '@deepseek-ai/dsh-app-boot';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import { BookSwitchConflictError } from '@narrateos/dsh-book-store';
import * as bookToolsPlugin from '@narrateos/dsh-book-tools';
import { afterEach, describe, expect, it } from 'vitest';
import * as pipelinePlugin from './index.js';
import { AdmissionClosedError, registerPresetBootSkill } from './index.js';
import type { SyncManuscriptsResult } from './schemas.js';
import {
    createGitBookWorkspace,
    createHeadlessMockServices,
    textToStreamChunks
} from './test-harness.js';

const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void> | void> = [];

function registerCleanup(fn: () => Promise<void> | void): void {
    cleanupCallbacks.push(fn);
}

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
        const fn = cleanupCallbacks.pop();
        if (fn) {
            try {
                await fn();
            } catch {
                // 清理期容错
            }
        }
    }
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

/** 构造模拟 webServer，支持精确路由注册与 HTTP 请求/SSE 捕获 */
function createMockWebServer(ctx: Context) {
    const routes = new Map<string, WebRoute['handler']>();

    const mockWebServer = {
        register(route: WebRoute) {
            const key = `${route.kind}:${route.path}`;
            routes.set(key, route.handler);
            return () => {
                routes.delete(key);
            };
        }
    } as unknown as Pick<WebServer, 'register'>;

    ctx.provide('webServer', mockWebServer as WebServer);

    async function invoke(
        method: string,
        url: string,
        body?: unknown
    ): Promise<{ statusCode: number; json: Record<string, unknown> }> {
        const parsedUrl = new URL(url, 'http://127.0.0.1');
        const handler = routes.get(`exact:${parsedUrl.pathname}`);
        if (!handler) {
            return { statusCode: 404, json: { error: `Route not found: ${parsedUrl.pathname}` } };
        }

        const reqStream = new PassThrough();
        const req = reqStream as unknown as IncomingMessage;
        req.method = method;
        req.url = url;
        if (body !== undefined) {
            reqStream.end(JSON.stringify(body));
        } else {
            reqStream.end();
        }

        const chunks: Buffer[] = [];
        const headers = new Map<string, string>();
        let resolveDone: (() => void) | undefined;
        const done = new Promise<void>((r) => {
            resolveDone = r;
        });

        const res = Object.assign(new EventEmitter(), {
            writableEnded: false,
            destroyed: false,
            statusCode: 200,
            setHeader(k: string, v: string) {
                headers.set(k.toLowerCase(), v);
            },
            write(chunk: string | Buffer) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                return true;
            },
            end(chunk?: string | Buffer) {
                if (chunk) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                (res as { writableEnded: boolean }).writableEnded = true;
                resolveDone?.();
            }
        }) as unknown as ServerResponse;

        await handler(req, res);
        await done;
        const raw = Buffer.concat(chunks).toString('utf8');
        return {
            statusCode: res.statusCode,
            json: raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}
        };
    }

    async function openSse(): Promise<{
        statusCode: number;
        events: Array<{ event: string; data: Record<string, unknown> }>;
        waitForEvent: (
            predicate: (evt: { event: string; data: Record<string, unknown> }) => boolean
        ) => Promise<{ event: string; data: Record<string, unknown> }>;
        close: () => void;
    }> {
        const handler = routes.get('exact:/api/narrate/events');
        if (!handler) {
            throw new Error('SSE 路由 /api/narrate/events 未注册');
        }
        const req = new EventEmitter() as unknown as IncomingMessage;
        req.method = 'GET';
        req.url = '/api/narrate/events';

        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        const waiters: Array<{
            predicate: (evt: { event: string; data: Record<string, unknown> }) => boolean;
            resolve: (evt: { event: string; data: Record<string, unknown> }) => void;
        }> = [];
        let buffer = '';

        const res = Object.assign(new EventEmitter(), {
            writableEnded: false,
            destroyed: false,
            statusCode: 200,
            setHeader() {},
            flushHeaders() {},
            write(chunk: string | Buffer) {
                buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
                const frames = buffer.split('\n\n');
                buffer = frames.pop() ?? '';
                for (const frame of frames) {
                    if (!frame.trim() || frame.startsWith(':')) continue;
                    const eventMatch = /^event:\s*(.+)$/m.exec(frame);
                    const dataMatch = /^data:\s*(.+)$/m.exec(frame);
                    if (eventMatch?.[1] && dataMatch?.[1]) {
                        const evt = {
                            event: eventMatch[1].trim(),
                            data: JSON.parse(dataMatch[1]) as Record<string, unknown>
                        };
                        events.push(evt);
                        for (let i = waiters.length - 1; i >= 0; i -= 1) {
                            const waiter = waiters[i]!;
                            if (waiter.predicate(evt)) {
                                waiters.splice(i, 1);
                                waiter.resolve(evt);
                            }
                        }
                    }
                }
                return true;
            },
            end(chunk?: string | Buffer) {
                if (chunk) {
                    this.write(chunk);
                }
                (res as { writableEnded: boolean }).writableEnded = true;
            }
        }) as unknown as ServerResponse;

        await handler(req, res);
        return {
            statusCode: res.statusCode,
            events,
            waitForEvent(predicate) {
                const existing = events.find(predicate);
                if (existing) {
                    return Promise.resolve(existing);
                }
                return new Promise((resolve) => {
                    waiters.push({ predicate, resolve });
                });
            },
            close: () => {
                (req as unknown as EventEmitter).emit('close');
            }
        };
    }

    return { routes, invoke, openSse };
}

/** 构造轻量 mock commands 注册表，支持零 LLM 验证所有斜杠命令 */
function createMockCommandsRuntime(ctx: Context) {
    const defs = new Map<string, CommandDefinition>();
    const mockCommands = {
        register(def: CommandDefinition) {
            defs.set(def.name, def);
            return () => {
                defs.delete(def.name);
            };
        }
    };
    ctx.provide('commands', mockCommands as never);

    return {
        defs,
        async invokeCommand(name: string, rawInput = '') {
            const def = defs.get(name);
            if (!def) throw new Error(`未注册命令 /${name}`);
            return await def.handler({
                commandId: `cmd-${name}` as never,
                agent: { id: 'main-session' } as unknown as Agent,
                rawInput,
                attachments: [],
                signal: new AbortController().signal
            });
        }
    };
}

describe('Phase 3 控制面、切书 409、斜杠命令、REST/SSE 与优雅停机集成测试', () => {
    it('Config 满足 DSH Schemastery 原生协议 (isNativeConfigSchema === true) 且无写死假模型/audit 池', () => {
        expect(isNativeConfigSchema(pipelinePlugin.Config)).toBe(true);
        const normalized = pipelinePlugin.Config(undefined);
        expect(normalized.poolRouting).toEqual({
            strong_creative: { provider: '', model: '' },
            fast_retrieval: { provider: '', model: '' }
        });
        expect((normalized.poolRouting as Record<string, unknown>)['audit']).toBeUndefined();
        expect(normalized.heartbeatIntervalMs).toBe(15_000);
        expect(normalized.shutdownTimeoutMs).toBe(5_000);
    });

    it('环境变量 NARRATEOS_MODEL_* 可覆写插件 poolRouting 默认模型（强/弱双池）', async () => {
        const prevStrong = process.env.NARRATEOS_MODEL_STRONG;
        const prevFast = process.env.NARRATEOS_MODEL_FAST;
        process.env.NARRATEOS_MODEL_STRONG = 'override-strong-model';
        process.env.NARRATEOS_MODEL_FAST = 'override-fast-model';
        try {
            const bookRoot = await createGitBookWorkspace(tempDirs, 'book-env-model');
            const booksRoot = join(bookRoot, '..');
            const ctx = new Context();
            const promptFiber = await ctx.plugin(SystemPrompt);
            registerCleanup(() => promptFiber.dispose());
            const toolsFiber = await ctx.plugin(ToolsService);
            registerCleanup(() => toolsFiber.dispose());
            const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot, booksRoot });
            registerCleanup(() => storeFiber.dispose());
            const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
            registerCleanup(() => bookToolsFiber.dispose());
            await createHeadlessMockServices(ctx, {
                onAgent: async () => {},
                onLlmStream: () => textToStreamChunks('')
            });

            const pipelineFiber = await ctx.plugin(pipelinePlugin, { bookRoot, booksRoot });
            registerCleanup(() => pipelineFiber.dispose());

            expect(ctx.narratePipeline.poolRouting).toEqual({
                strong_creative: { provider: 'deepseek-official', model: 'override-strong-model' },
                fast_retrieval: { provider: 'deepseek-official', model: 'override-fast-model' }
            });
        } finally {
            if (prevStrong === undefined) delete process.env.NARRATEOS_MODEL_STRONG;
            else process.env.NARRATEOS_MODEL_STRONG = prevStrong;
            if (prevFast === undefined) delete process.env.NARRATEOS_MODEL_FAST;
            else process.env.NARRATEOS_MODEL_FAST = prevFast;
        }
    });

    it('在途步进期间 switchBook 与 POST /api/narrate/book/select 返回 409，并广播 activeSessionId SSE 与暴露 GET /api/narrate/runs', async () => {
        const bookA = await createGitBookWorkspace(tempDirs, 'book-a');
        const bookB = await createGitBookWorkspace(tempDirs, 'book-b');
        const booksRoot = join(bookA, '..');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookA, booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        const web = createMockWebServer(ctx);

        let releaseLibrarian: (() => void) | undefined;
        registerCleanup(() => releaseLibrarian?.());
        let resolveEntered!: () => void;
        const librarianEntered = new Promise<void>((r) => {
            resolveEntered = r;
        });
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, agentCtx, agent }) => {
                if (tools.has('yield_context_pack')) {
                    // 模拟发射思考流 chunk 验证 stage:event SSE 透传与明细持久
                    agentCtx.emit(
                        scopeTarget(agent, agent),
                        'agent/assistant-stream',
                        {
                            agent,
                            frame: {
                                type: 'chunk',
                                attemptId: 'att-1' as never,
                                revision: 1,
                                index: 0,
                                time: Date.now(),
                                chunk: { type: 'reasoning-delta', index: 0, text: '核查码头实体关联' }
                            }
                        }
                    );
                    resolveEntered();
                    await new Promise<void>((r) => {
                        releaseLibrarian = r;
                    });
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '封港夜',
                        target_word_count: 2000,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛留白',
                        chapter_turn: '账簿少了一页',
                        scene_plan: [
                            {
                                scene_index: 1,
                                location: '三号码头',
                                summary: '沈默查账',
                                is_spotlight: true
                            }
                        ],
                        outline_text: '沈默核查账簿发现少了一页。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 1,
                        chapter_summary: '沈默查出账簿缺页。',
                        next_chapter_options: ['继续追查']
                    });
                    return;
                }
                if (tools.has('yield_dream_commit')) {
                    await execTool('yield_dream_commit', {
                        summary: '梦境整理完成',
                        chapter_number: 1,
                        accumulated_words: 500,
                        spotlight_triggers: []
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks(
                    '<blocking>三号码头账房</blocking>\n\n沈默合上铁夹，灯火照亮发黄账页。'
                )
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, {
            booksRoot,
            heartbeatIntervalMs: 0
        });
        registerCleanup(() => pipeFiber.dispose());

        const sse = await web.openSse();
        registerCleanup(() => sse.close());

        // 启动在途步进，并在 Librarian 阶段卡住以测试 409 冲突
        const stepPromise = ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '夜查码头账簿'
        });

        await librarianEntered;

        // 1. 直接调用 switchBook 返回 409 BookSwitchConflictError
        let directErr: unknown;
        try {
            await ctx.narratePipeline.switchBook(bookB);
        } catch (err) {
            directErr = err;
        }
        expect(directErr).toBeInstanceOf(BookSwitchConflictError);
        expect((directErr as BookSwitchConflictError).statusCode).toBe(409);

        // 2. 通过 HTTP POST /api/narrate/book/select 返回 409
        const httpSwitchRes = await web.invoke('POST', '/api/narrate/book/select', {
            bookRoot: bookB
        });
        expect(httpSwitchRes.statusCode).toBe(409);

        // 放行 Librarian 完成单章生产
        releaseLibrarian?.();
        const stepRes = await stepPromise;
        expect(stepRes.status).toBe('COMMITTED');

        // 3. 验证 SSE stage 事件携带 activeSessionId / sessionId / runId
        const stageEvents = sse.events.filter(
            (e) => e.event === 'stage' && typeof e.data['activeSessionId'] === 'string'
        );
        expect(stageEvents.length).toBeGreaterThanOrEqual(4);
        expect(stageEvents.some((e) => e.data['stage'] === 'LIBRARIAN')).toBe(true);
        expect(stageEvents.some((e) => e.data['stage'] === 'PLANNER')).toBe(true);
        expect(stageEvents.some((e) => e.data['stage'] === 'FACT_CHECKER')).toBe(true);
        expect(stageEvents.some((e) => e.data['stage'] === 'EXTRACTOR')).toBe(true);

        // 4. 验证 GET /api/narrate/runs?chapter=1 与 GET /api/narrate/runs/detail?sessionId=...
        const runsHttp = await web.invoke('GET', '/api/narrate/runs?chapter=1');
        expect(runsHttp.statusCode).toBe(200);
        const runsList = runsHttp.json['runs'] as Array<{ stage: string; sessionId: string }>;
        const libRun = runsList.find((r) => r.stage === 'LIBRARIAN' && r.sessionId.startsWith('narrate-'));
        expect(libRun).toBeDefined();
        expect(runsList.some((r) => r.stage === 'PLANNER' && r.sessionId.startsWith('narrate-'))).toBe(true);

        const detailHttp = await web.invoke(
            'GET',
            `/api/narrate/runs/detail?sessionId=${encodeURIComponent(libRun!.sessionId)}`
        );
        expect(detailHttp.statusCode).toBe(200);
        const detailEvents = detailHttp.json['events'] as Array<{ kind: string; toolName?: string; text?: string }>;
        expect(detailEvents.some((ev) => ev.kind === 'thinking' && ev.text?.includes('核查码头'))).toBe(true);
        const toolCallEvents = detailEvents.filter(
            (ev) => ev.kind === 'tool-call' && ev.toolName === 'yield_context_pack'
        );
        const toolResultEvents = detailEvents.filter(
            (ev) => ev.kind === 'tool-result' && ev.toolName === 'yield_context_pack'
        );
        expect(toolCallEvents.length).toBe(1);
        expect(toolResultEvents.length).toBe(1);

        const stageStreamEvents = sse.events.filter((e) => e.event === 'stage:event');
        expect(stageStreamEvents.some((e) => e.data['kind'] === 'thinking')).toBe(true);
        expect(stageStreamEvents.filter((e) => e.data['kind'] === 'tool-call' && e.data['toolName'] === 'yield_context_pack').length).toBe(1);

        // 5. 触发 Dreaming 并验证 dream:started SSE 同样携带 activeSessionId
        await ctx.narratePipeline.runDreaming({ currentChapter: 1, force: true });
        const dreamStarted = sse.events.find(
            (e) => e.event === 'dream:started' && typeof e.data['activeSessionId'] === 'string'
        );
        expect(dreamStarted).toBeDefined();

        // 6. 空闲后切书至 bookB 成功
        const okSwitch = await web.invoke('POST', '/api/narrate/book/select', {
            bookRoot: bookB
        });
        expect(okSwitch.statusCode).toBe(200);
        expect(ctx.narrateStore.bookRoot).toBe(bookB);
    });

    it('斜杠命令 (/narrate-status, /narrate-step, /narrate-yolo, /narrate-halt, /narrate-signal) 0 Token 异步触发并立即返回回执，且挂载 narrate-boot Skill', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'slash-commands');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const skillFiber = await ctx.plugin(SkillRegistry);
        registerCleanup(() => skillFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        const web = createMockWebServer(ctx);
        const cmdRuntime = createMockCommandsRuntime(ctx);

        let resolveStepGate: (() => void) | undefined;
        const stepEntered = createDeferred<void>();
        resolveStepGate = () => stepEntered.resolve();
        let releaseStep: (() => void) | undefined;
        registerCleanup(() => releaseStep?.());

        const { llmCalls } = await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    resolveStepGate?.();
                    await new Promise<void>((r) => {
                        releaseStep = r;
                    });
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '斜杠测试章',
                        target_word_count: 1800,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'CLOSURE',
                        director_rationale: '秘辛',
                        chapter_turn: '盘点发现暗记',
                        scene_plan: [
                            { scene_index: 1, location: '货栈', summary: '核对', is_spotlight: true }
                        ],
                        outline_text: '沈默查看货栈暗记。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '核对暗记完成。',
                        next_chapter_options: ['继续推进']
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks('<blocking>货栈</blocking>\n\n沈默核对完箱板暗记。')
        });

        // 先挂好 skills/change 监听器，避免遗漏同步或微任务内的注册事件
        const skillRegistered = createDeferred<void>();
        const disposeSkillWatch = ctx.on('skills/change', () => {
            skillRegistered.resolve();
        });
        registerCleanup(() => {
            disposeSkillWatch();
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const sse = await web.openSse();
        registerCleanup(() => sse.close());

        // 确定性等待异步 Skill 注册完成（无需 fixed sleep）
        let bootSkill = await ctx.skills.get('narrate-boot');
        while (!bootSkill) {
            await skillRegistered.promise;
            bootSkill = await ctx.skills.get('narrate-boot');
        }
        expect(bootSkill).toBeDefined();
        expect(bootSkill?.content).toContain('lock_charter_and_boot');

        // 0. /narrate-status 0 LLM 调用只读状态查询
        const statusReceipt = await cmdRuntime.invokeCommand('narrate-status');
        expect(statusReceipt.kind).toBe('success');
        expect(statusReceipt.text).toContain('slash-commands');
        expect(llmCalls.length).toBe(0);

        // 1. /narrate-signal 0 LLM 调用投递信号
        const sigReceipt = await cmdRuntime.invokeCommand(
            'narrate-signal',
            '加强码头浓雾氛围'
        );
        expect(sigReceipt.kind).toBe('success');
        expect(llmCalls.length).toBe(0);

        // 2. /narrate-step 异步启动背景管线并立即返回回执（不等待写手 LLM）
        const stepReceipt = await cmdRuntime.invokeCommand('narrate-step', '夜查暗记');
        expect(stepReceipt.kind).toBe('success');
        expect(stepReceipt.text).toContain('异步启动');
        expect(llmCalls.length).toBe(0);

        // 3. 在途期间 /narrate-yolo 被互斥拦截，/narrate-halt 发出安全停机请求
        await stepEntered.promise;
        const yoloConflictReceipt = await cmdRuntime.invokeCommand('narrate-yolo', '2');
        expect(yoloConflictReceipt.kind).toBe('error');

        const haltReceipt = await cmdRuntime.invokeCommand('narrate-halt');
        expect(haltReceipt.kind).toBe('success');

        const stepSettled = sse.waitForEvent(
            (e) =>
                e.event === 'chapter:phase' &&
                (e.data['phase'] === 'FAILED' || e.data['phase'] === 'COMMITTED')
        );
        releaseStep?.();
        await stepSettled;
    });

    it('在途运行期间卸载插件：立即关闭准入、超时广播 halt:waiting 而不提前注销路由/锁、等待排空且零残留 .ops/tx.lock', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'teardown-drain');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());
        const web = createMockWebServer(ctx);

        let releaseInFlight: (() => void) | undefined;
        registerCleanup(() => releaseInFlight?.());
        const agentEntered = createDeferred<void>();

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    agentEntered.resolve();
                    // 挂起直到测试确定性地放行，模拟 WAL/Agent 在途排空与超时告警
                    await new Promise<void>((r) => {
                        releaseInFlight = r;
                    });
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, {
            heartbeatIntervalMs: 0,
            shutdownTimeoutMs: 40
        });
        registerCleanup(() => pipeFiber.dispose());

        const sse = await web.openSse();
        registerCleanup(() => sse.close());
        const controller = ctx.narratePipeline;

        const inFlightPromise = controller.stepChapter({
            chapterNumber: 1,
            chapterGoal: '测试停机排空'
        });
        await agentEntered.promise;

        // 发起插件卸载（此时在途任务尚未结束）
        let disposeSettled = false;
        const disposePromise = pipeFiber.dispose().then(() => {
            disposeSettled = true;
        });

        // 1. 准入闸门立即关闭：拒绝新任务
        await expect(
            controller.stepChapter({ chapterGoal: '不应被接收' })
        ).rejects.toBeInstanceOf(AdmissionClosedError);

        // 2. 确定性等待 halt:waiting SSE 事件到达，验证尚未释放路由与服务
        await sse.waitForEvent((e) => e.event === 'halt:waiting');
        expect(disposeSettled).toBe(false);
        expect(web.routes.has('exact:/api/narrate/status')).toBe(true);
        expect(ctx.reflect.get('narratePipeline', false) === controller).toBe(true);

        // 3. 放行在途任务收束后，dispose 完成且零残留 .ops/tx.lock
        releaseInFlight?.();
        await Promise.allSettled([inFlightPromise, disposePromise]);

        expect(disposeSettled).toBe(true);
        expect(ctx.reflect.get('narratePipeline', false)).toBeUndefined();
        expect(web.routes.size).toBe(0);
        await expect(stat(join(bookRoot, '.ops/tx.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('P0-2 & P1-4: 异步卸载期间安全取消 Skill 注册且先排空运行再释放 RoleRunner 作用域，零 CordisError 或 UnhandledRejection', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'async-skill-dispose-race');
        const unhandledErrors: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandledErrors.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        registerCleanup(() => {
            process.off('unhandledRejection', onUnhandled);
        });

        // 1. 使用 Deferred 挂起 registerPresetBootSkill 的 skills.get，并在异步间隙置位 disposed
        const getGate = createDeferred<undefined>();
        const getEntered = createDeferred<void>();
        let registerCalls = 0;
        const mockSkills = {
            async get() {
                getEntered.resolve();
                return await getGate.promise;
            },
            register() {
                registerCalls += 1;
                return () => {};
            }
        };

        let disposedFlag = false;
        const regPromise = registerPresetBootSkill(
            mockSkills,
            new URL('../../../presets/dsh-preset-narrateos', import.meta.url).pathname,
            { isDisposed: () => disposedFlag }
        );
        await getEntered.promise;
        disposedFlag = true;
        getGate.resolve(undefined);
        const disposer = await regPromise;
        expect(typeof disposer).toBe('function');
        expect(registerCalls).toBe(0);

        // 2. 在真实 Cordis 中挂起 skills.get 并在期间执行 pipeFiber.dispose()，同时检验 RoleRunner 卸载顺序
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        const cordisSkillGetEntered = createDeferred<void>();
        const cordisSkillGetGate = createDeferred<undefined>();
        let cordisSkillRegisterCount = 0;
        ctx.provide('skills', {
            async get() {
                cordisSkillGetEntered.resolve();
                return await cordisSkillGetGate.promise;
            },
            register() {
                cordisSkillRegisterCount += 1;
                return () => {};
            }
        } as never);

        const runnerEntered = createDeferred<void>();
        const runnerRelease = createDeferred<void>();
        let sessionEventSeenBeforeTeardown = false;

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ sessionId, tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    runnerEntered.resolve();
                    await runnerRelease.promise;
                    // 在 shutdown 排空期间发送 assistant/message 验证 runnerFiber 的 session/event 监听尚未被提前摘除
                    ctx.emit('session/event' as never, { id: sessionId } as never, {
                        type: 'assistant/message',
                        data: { usage: { inputTokens: 15, outputTokens: 5 } }
                    } as never);
                    sessionEventSeenBeforeTeardown = true;
                }
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await cordisSkillGetEntered.promise;
        const runPromise = ctx.narratePipeline.roleRunner.runMultiTurn({
            roleId: 'librarian',
            stage: 'LIBRARIAN',
            runId: 'draining-librarian',
            bookRoot,
            taskPrompt: '排空顺序测试'
        });
        await runnerEntered.promise;
        await expect(ctx.narratePipeline.roleRunner.runMultiTurn({
            roleId: 'librarian', stage: 'LIBRARIAN', bookRoot, taskPrompt: '重复提交', runId: 'draining-librarian'
        })).rejects.toThrow(/已处于活跃状态/);
        expect(ctx.narrateStore.hasActiveRuns()).toBe(true);
        expect(ctx.narratePipeline.roleRunner.getLiveSessionDetail('narrate-librarian-draining-librarian', bookRoot)).toBeDefined();

        // 卸载过程中挂起的 skills.get 仍未完成，且 RoleRunner 仍处于活跃态
        const disposePromise = pipeFiber.dispose();
        cordisSkillGetGate.resolve(undefined);
        runnerRelease.resolve();

        const [runResult] = await Promise.all([runPromise, disposePromise]);
        expect(sessionEventSeenBeforeTeardown).toBe(true);
        expect(runResult.usage.inputTokens).toBe(15);
        expect(cordisSkillRegisterCount).toBe(0);
        expect(unhandledErrors).toEqual([]);
    });

    it('P1-5 & P1-8 & P2-2: 磁盘 tool/call+tool/result 回放、信号消费水位持久化防撤回 409、bootBook 切书互斥与路由校验', async () => {
        const bookA = await createGitBookWorkspace(tempDirs, 'runtime-hardening-a');
        const bookB = await createGitBookWorkspace(tempDirs, 'runtime-hardening-b');
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-runtime-books-'));
        tempDirs.push(booksRoot);

        // 预先写入真实 DSH tool/call + tool/result 落盘格式到 .ops/session_logs/
        const rawSessionId = 'narrate-librarian-replay-1';
        await mkdir(join(bookA, '.ops/session_logs'), { recursive: true });
        await writeFile(
            join(bookA, '.ops/runs.jsonl'),
            `${JSON.stringify({
                runId: 'run-replay-1',
                chapter: 1,
                stage: 'LIBRARIAN',
                role: 'librarian',
                sessionId: rawSessionId,
                status: 'completed',
                startedAt: '2026-11-17T00:00:00.000Z',
                finishedAt: '2026-11-17T00:00:01.000Z'
            })}\n`,
            'utf8'
        );
        await writeFile(
            join(bookA, '.ops/session_logs', `${rawSessionId}.json`),
            JSON.stringify([
                {
                    seq: 0,
                    type: 'tool/call',
                    data: {
                        turn: 1,
                        step: 1,
                        callId: 'call-99',
                        name: 'book_read',
                        arguments: '{"path":"world/world_state.md"}'
                    }
                },
                {
                    seq: 1,
                    type: 'tool/result',
                    data: {
                        turn: 1,
                        step: 1,
                        message: {
                            id: 'msg-tool-1',
                            role: 'tool',
                            toolCallId: 'call-99',
                            isError: true,
                            source: { kind: 'tool', callId: 'call-99' },
                            content: [{ type: 'text', text: 'PathFence blocked' }]
                        }
                    }
                }
            ]),
            'utf8'
        );

        const ctx1 = new Context();
        const promptFiber1 = await ctx1.plugin(SystemPrompt);
        registerCleanup(() => promptFiber1.dispose());
        const toolsFiber1 = await ctx1.plugin(ToolsService);
        registerCleanup(() => toolsFiber1.dispose());
        const storeFiber1 = await ctx1.plugin(bookStorePlugin, { bookRoot: bookA, booksRoot });
        registerCleanup(() => storeFiber1.dispose());
        const bookToolsFiber1 = await ctx1.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber1.dispose());
        const web1 = createMockWebServer(ctx1);

        await createHeadlessMockServices(ctx1, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '水位测试',
                        target_word_count: 1600,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '账目对不上',
                        scene_plan: [{ scene_index: 1, location: '码头', summary: '查账', is_spotlight: true }],
                        outline_text: '沈默核对码头账簿。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '完成核对。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('<blocking>码头</blocking>\n\n沈默合上账册。')
        });

        const pipeFiber1 = await ctx1.plugin(pipelinePlugin, { booksRoot, heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber1.dispose());

        // 1. 验证 P1-5 磁盘 tool/call + tool/result 回放
        const replayHttp = await web1.invoke(
            'GET',
            `/api/narrate/runs/detail?sessionId=${encodeURIComponent(rawSessionId)}`
        );
        expect(replayHttp.statusCode).toBe(200);
        const replayEvents = replayHttp.json['events'] as Array<{
            kind: string;
            toolName?: string;
            callId?: string;
            status?: string;
            text?: string;
        }>;
        expect(replayEvents).toHaveLength(2);
        expect(replayEvents[1]).toMatchObject({
            kind: 'tool-result',
            toolName: 'book_read',
            callId: 'call-99',
            status: 'error',
            text: 'PathFence blocked'
        });

        // 2. 验证 P2-2 routes.ts 参数校验与 halt 损坏 JSON 容错
        await writeFile(join(bookA, '.ops/safe_halt.json'), '{broken-json', 'utf8');
        const haltViewRes = await web1.invoke('GET', '/api/narrate/views?kind=halt');
        expect(haltViewRes.statusCode).toBe(200);
        expect((haltViewRes.json['safeHalt'] as { malformed?: boolean }).malformed).toBe(true);

        const badParallelJson = await web1.invoke('POST', '/api/narrate/parallel/fork', 'not-json');
        expect(badParallelJson.statusCode).toBe(400);
        await web1.invoke('POST', '/api/narrate/parallel/fork', { windowId: 'win-conflict' });
        const conflictParallel = await web1.invoke('POST', '/api/narrate/parallel/fork', {
            windowId: 'win-conflict-2'
        });
        expect(conflictParallel.statusCode).toBe(409);
        await web1.invoke('POST', '/api/narrate/parallel/merge', { windowId: 'win-conflict' });

        const badModeStep = await web1.invoke('POST', '/api/narrate/step', {
            chapterGoal: '测试',
            timelineMode: 'INVALID_MODE'
        });
        expect(badModeStep.statusCode).toBe(400);
        const badChapterStep = await web1.invoke('POST', '/api/narrate/step', {
            chapterGoal: '测试',
            chapterNumber: -1
        });
        expect(badChapterStep.statusCode).toBe(400);

        // 3. 验证 P1-8 单步消费信号 + 控制器重启水位保持 + 拒绝撤回已消费信号 (409)
        const sigRes = await web1.invoke('POST', '/api/narrate/signals', {
            type: 'DIRECTOR_NOTE',
            reason: '首章加重雾夜细节'
        });
        expect(sigRes.statusCode).toBe(201);
        const sigCreatedAt = (sigRes.json['signal'] as { created_at: string }).created_at;

        const stepRes = await web1.invoke('POST', '/api/narrate/step', {
            chapterGoal: '推进第一章'
        });
        expect(stepRes.statusCode).toBe(200);
        expect(await ctx1.narratePipeline.countPendingSignals()).toBe(0);

        // 停机后（webFiber 仍在挂载期间）SSE /api/narrate/events 应拒绝连接并返回 503
        await ctx1.narratePipeline.shutdown();
        const closedSse = await web1.openSse();
        registerCleanup(() => closedSse.close());
        expect(closedSse.statusCode).toBe(503);
        await pipeFiber1.dispose();
        await bookToolsFiber1.dispose();
        await storeFiber1.dispose();
        await toolsFiber1.dispose();
        await promptFiber1.dispose();

        // 重启新控制器实例，验证信号消费水位从 .ops/signals_cursor.json 恢复且拒绝撤回
        const ctx2 = new Context();
        const promptFiber2 = await ctx2.plugin(SystemPrompt);
        registerCleanup(() => promptFiber2.dispose());
        const toolsFiber2 = await ctx2.plugin(ToolsService);
        registerCleanup(() => toolsFiber2.dispose());
        const storeFiber2 = await ctx2.plugin(bookStorePlugin, { bookRoot: bookA, booksRoot });
        registerCleanup(() => storeFiber2.dispose());
        const bookToolsFiber2 = await ctx2.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber2.dispose());
        const web2 = createMockWebServer(ctx2);

        const bootEntered = createDeferred<void>();
        const bootRelease = createDeferred<void>();
        await createHeadlessMockServices(ctx2, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_boot_bundle')) {
                    bootEntered.resolve();
                    await bootRelease.promise;
                    await execTool('yield_boot_bundle', {
                        world_summary: '冬夜港口货栈查账。',
                        static_base_and_voice: '第三人称客观视角，短句白描。',
                        current_arc_envelope: '三号码头夜班清点提货单。',
                        stage_ceiling: '第一卷暂不揭露幕后总签批人。',
                        opening_sequence_beats: [
                            { craft_focus: '风灯与旧箱', clue_budget: '三号仓编号', completion_sign: '发现缺页' },
                            { craft_focus: '交接对白', clue_budget: '夜班印章', completion_sign: '确认改签' },
                            { craft_focus: '拖轮离港', clue_budget: '船号尾数', completion_sign: '锁定去向' }
                        ],
                        l1_volumes_markdown: '# L1\n\n- vol_01: 潮汐旧账',
                        entities: [
                            {
                                entityId: 'char_shen',
                                canonicalName: '沈默',
                                innateLocks: [{ visibility: 'PUBLIC', text: '左手旧疤' }],
                                acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', text: '三号仓' }],
                                irreversibleTrajectory: [{ storyDay: 0, text: '赴码头查账' }],
                                recentBuffer: []
                            }
                        ]
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber2 = await ctx2.plugin(pipelinePlugin, { booksRoot, heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber2.dispose());

        expect(await ctx2.narratePipeline.countPendingSignals()).toBe(0);
        const delRes = await web2.invoke('DELETE', '/api/narrate/signals/delete', {
            created_at: sigCreatedAt,
            reason: '首章加重雾夜细节'
        });
        expect(delRes.statusCode).toBe(409);

        // 4. 验证 P2-2 bootBook 全程处于 BOOTING 排他保护下，并发 switchBook 返回 409
        const bootPromise = ctx2.narratePipeline.bootBook({
            slug: 'boot-mutex-book',
            title: '并发互斥测试',
            povCharacter: 'char_shen',
            mode: 'original',
            premiseOrSeed: '港口夜查旧账'
        });
        await bootEntered.promise;
        await expect(ctx2.narratePipeline.switchBook(bookB)).rejects.toBeInstanceOf(
            BookSwitchConflictError
        );
        bootRelease.resolve();
        const booted = await bootPromise;
        expect(ctx2.narrateStore.bookRoot).toBe(booted.bookRoot);
    });

    it('GET /api/narrate/status 暴露 roleRouting/roleDefinitions/availableModels，PUT /api/narrate/model-routing 支持校验、空值清洗、落盘读写与忙碌 409', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-routing-books-'));
        tempDirs.push(booksRoot);
        const bookRoot = await createGitBookWorkspace(tempDirs, 'routing-api-book');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot, booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());
        const web = createMockWebServer(ctx);

        const stepEntered = createDeferred<void>();
        const stepRelease = createDeferred<void>();
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    stepEntered.resolve();
                    await stepRelease.promise;
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '路由接口测试',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '核对接口',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '查账', is_spotlight: true }
                        ],
                        outline_text: '沈默核对账册。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '完成。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('# 路由接口测试\n\n沈默合上账册。')
        });

        // 注入可枚举提供商/模型（含故意抛错的 provider 验证静默降级）
        Object.assign(ctx.llm as unknown as Record<string, unknown>, {
            listProviders: () => [
                { id: 'deepseek-official', name: 'DeepSeek' },
                { id: 'openai', name: 'OpenAI' },
                { id: 'broken-provider', name: 'Broken' }
            ],
            listModels: async (provider: string) => {
                if (provider === 'deepseek-official') {
                    return [
                        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
                        { provider, id: 'deepseek-flash', name: 'DeepSeek Flash' }
                    ];
                }
                if (provider === 'openai') {
                    return [{ provider, id: 'gpt-5-prose', name: 'GPT-5 Prose' }];
                }
                throw new Error('provider listing unavailable');
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, {
            booksRoot,
            heartbeatIntervalMs: 0,
            poolRouting: {
                strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
                fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' }
            }
        });
        registerCleanup(() => pipeFiber.dispose());

        // 1. GET /api/narrate/status 验证新增字段
        const statusBefore = await web.invoke('GET', '/api/narrate/status');
        expect(statusBefore.statusCode).toBe(200);
        expect(statusBefore.json['defaultModel']).toBeNull();
        expect(statusBefore.json['poolOverrides']).toEqual({
            strong_creative: 'deepseek-official:deepseek-v4-pro',
            fast_retrieval: 'deepseek-official:deepseek-flash'
        });
        expect(statusBefore.json['modelRouting']).toEqual({
            strong_creative: 'deepseek-official:deepseek-v4-pro',
            fast_retrieval: 'deepseek-official:deepseek-flash'
        });
        expect(statusBefore.json['roleRouting']).toEqual({});
        const roleDefsBefore = statusBefore.json['roleDefinitions'] as Array<{
            id: string;
            defaultPool: string;
            effectivePool: string;
            effectiveProvider: string;
            effectiveModel: string;
        }>;
        expect(roleDefsBefore.map((r) => r.id)).toEqual([
            'librarian',
            'planner',
            'writer',
            'patch',
            'fact-checker',
            'extractor',
            'dreamer',
            'boot-compiler'
        ]);
        expect(roleDefsBefore.find((r) => r.id === 'fact-checker')?.defaultPool).toBe(
            'strong_creative'
        );
        const availableModels = statusBefore.json['availableModels'] as Array<{
            provider: string;
            model: string;
            label?: string;
        }>;
        expect(availableModels).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
                expect.objectContaining({ provider: 'deepseek-official', model: 'deepseek-flash' }),
                expect.objectContaining({ provider: 'openai', model: 'gpt-5-prose', label: 'GPT-5 Prose' })
            ])
        );

        // 2. PUT /api/narrate/model-routing 校验非法参数 -> 400
        expect((await web.invoke('PUT', '/api/narrate/model-routing', {})).statusCode).toBe(400);
        expect(
            (
                await web.invoke('PUT', '/api/narrate/model-routing', {
                    role_routing: 'bad-type'
                })
            ).statusCode
        ).toBe(400);
        expect(
            (
                await web.invoke('PUT', '/api/narrate/model-routing', {
                    role_routing: { writer: { tier: 'invalid-tier' } }
                })
            ).statusCode
        ).toBe(400);
        expect(
            (
                await web.invoke('PUT', '/api/narrate/model-routing', {
                    role_routing: { writer: { reasoning_effort: 'extreme' } }
                })
            ).statusCode
        ).toBe(400);

        // 崩溃的章节事务仍拥有写集；保存配置不得替换或清除它。
        const store = ctx.narrateStore.openStore(bookRoot);
        await store.recordPendingWrites(['entities/char_001.md']);
        const pending = join(bookRoot, '.ops/pending_writes.json');
        const journal = await readFile(pending, 'utf8');
        const config = await store.readBookConfig();
        const rejected = await web.invoke('PUT', '/api/narrate/model-routing', {
            model_routing: { strong_creative: 'not-saved' }
        });
        expect(rejected.statusCode).toBe(409);
        expect(await readFile(pending, 'utf8')).toBe(journal);
        expect(await store.readBookConfig()).toEqual(config);
        await store.recoverWal();

        // 3. PUT /api/narrate/model-routing 支持空值清洗与落盘读写 -> 200
        const putRes = await web.invoke('PUT', '/api/narrate/model-routing', {
            model_routing: {
                strong_creative: 'deepseek-v4-pro',
                fast_retrieval: '   '
            },
            role_routing: {
                librarian: { tier: 'strong', model: '', reasoning_effort: null },
                writer: { model: 'openai:gpt-5-prose', reasoning_effort: 'high' },
                patch: { tier: '', model: '   ', reasoning_effort: '' }
            }
        });
        expect(putRes.statusCode).toBe(200);
        expect(putRes.json['status']).toBe('ok');
        expect(putRes.json['roleRouting']).toEqual({
            librarian: { tier: 'strong' },
            writer: { model: 'openai:gpt-5-prose', reasoning_effort: 'high' }
        });
        const updatedRoleDefs = putRes.json['roleDefinitions'] as Array<{
            id: string;
            effectiveTier?: string | null;
            effectivePool: string;
            effectiveProvider: string;
            effectiveModel: string;
            effectiveReasoningEffort?: string;
        }>;
        const librarianDef = updatedRoleDefs.find((r) => r.id === 'librarian');
        expect(librarianDef).toMatchObject({
            effectiveTier: 'strong',
            effectivePool: 'strong_creative',
            effectiveProvider: 'deepseek-official',
            effectiveModel: 'deepseek-v4-pro'
        });
        const writerDef = updatedRoleDefs.find((r) => r.id === 'writer');
        expect(writerDef).toMatchObject({
            effectiveTier: null,
            effectivePool: 'strong_creative',
            effectiveProvider: 'openai',
            effectiveModel: 'gpt-5-prose',
            effectiveReasoningEffort: 'high'
        });

        const persistedConfig = await ctx.narrateStore.openStore(bookRoot).readBookConfig();
        expect(persistedConfig.role_routing).toEqual({
            librarian: { tier: 'strong' },
            writer: { model: 'openai:gpt-5-prose', reasoning_effort: 'high' }
        });

        // 4. 在途 STEPPING 任务期间调用 PUT /api/narrate/model-routing -> 409
        const stepPromise = ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '测试并发写配置 409'
        });
        await stepEntered.promise;
        const busyPutRes = await web.invoke('PUT', '/api/narrate/model-routing', {
            role_routing: { librarian: { tier: 'weak' } }
        });
        expect(busyPutRes.statusCode).toBe(409);
        stepRelease.resolve();
        await stepPromise;

        // 5. .ops/tx.lock 被外部事务占用时调用 PUT /api/narrate/model-routing -> 409
        await ctx.narrateStore.openStore(bookRoot).withTxLock(async () => {
            const lockConflictRes = await web.invoke('PUT', '/api/narrate/model-routing', {
                role_routing: { librarian: { tier: 'weak' } }
            });
            expect(lockConflictRes.statusCode).toBe(409);
        });
    });

    it('POST /api/narrate/voice-harvest 路由契约及 runs/detail (attempt, triggerReason, requestInput) 暴露', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'voice-harvest-and-runs-contract');
        const booksRoot = join(bookRoot, '..');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot, booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        const web = createMockWebServer(ctx);
        let writerCalls = 0;

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '契约测试',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '账页异常',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '查账', is_spotlight: true }
                        ],
                        outline_text: '沈默在货栈核对账册。'
                    });
                    return;
                }
                if (tools.has('yield_patched_draft')) {
                    await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 2,
                                end_paragraph: 2,
                                replacement_paragraphs: ['沈默搁下钢笔，把账册推到油灯下。']
                            }
                        ]
                    });
                    await execTool('yield_patched_draft', { summary: '修正第 2 段' });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '首章通过。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: (opts) => {
                if (opts.system?.includes('Voice Harvest')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            samples: [
                                {
                                    tag: '白描动作',
                                    text: '油灯照亮页码。'
                                },
                                {
                                    tag: '克制对白',
                                    text: '把账册推到油灯下。'
                                },
                                { tag: '声响', text: '窗外拖轮鸣了两声短笛。' }
                            ]
                        })
                    );
                }
                writerCalls += 1;
                if (writerCalls === 1) {
                    return textToStreamChunks(
                        [
                            '沈默翻开潮汐账册，油灯照亮页码。',
                            '',
                            '他指节泛白，喉结滚动着咽下一口气。',
                            '',
                            '窗外拖轮鸣了两声短笛。'
                        ].join('\n')
                    );
                }
                return textToStreamChunks('沈默合上账册。');
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { booksRoot, heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        // 1. 先跑第 1 章（触发 WRITER + LOCAL_PATCH），验证 runs 与 runs/detail 契约
        await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '产出第一章供 Voice Harvest 采集'
        });

        const runsRes = await web.invoke('GET', '/api/narrate/runs?chapter=1');
        expect(runsRes.statusCode).toBe(200);
        const runItems = runsRes.json['runs'] as Array<{
            stage: string;
            sessionId: string;
            status: string;
            attempt?: number;
            triggerReason?: string;
        }>;
        const patchRun = runItems.find((r) => r.stage === 'LOCAL_PATCH' && r.status === 'completed');
        expect(patchRun).toBeDefined();
        expect(patchRun?.attempt).toBe(1);
        expect(patchRun?.triggerReason).toContain('PROSE_GATE');

        const patchDetailRes = await web.invoke(
            'GET',
            `/api/narrate/runs/detail?sessionId=${encodeURIComponent(patchRun!.sessionId)}`
        );
        expect(patchDetailRes.statusCode).toBe(200);
        expect(patchDetailRes.json['requestInput']).toMatchObject({
            pool: 'strong_creative',
            tools: ['patch_paragraphs', 'yield_patched_draft']
        });

        // 2. 验证 POST /api/narrate/voice-harvest 方法与参数校验
        expect((await web.invoke('GET', '/api/narrate/voice-harvest')).statusCode).toBe(405);
        expect(
            (await web.invoke('POST', '/api/narrate/voice-harvest', { chapterNumber: 0 })).statusCode
        ).toBe(400);
        expect(
            (await web.invoke('POST', '/api/narrate/voice-harvest', { chapterNumber: '1' })).statusCode
        ).toBe(400);

        // 3. 首次调用按首章最低配额采集三条原句
        const harvestRes = await web.invoke('POST', '/api/narrate/voice-harvest', {
            chapterNumber: 1
        });
        expect(harvestRes.statusCode).toBe(200);
        expect(harvestRes.json).toMatchObject({
            harvestedCount: 3,
            skipped: false
        });
        expect((harvestRes.json['samples'] as unknown[]).length).toBe(3);

        // 4. 重复调用应返回 skipped: true
        const skippedRes = await web.invoke('POST', '/api/narrate/voice-harvest', {});
        expect(skippedRes.statusCode).toBe(200);
        expect(skippedRes.json).toEqual({
            harvestedCount: 0,
            skipped: true,
            samples: []
        });

        // 5. 清空声纹池后验证缺章返回 404，候选全部未通过门禁返回 422（不再返回 500）
        await writeFile(join(bookRoot, '.ops/voice_samples.yaml'), 'samples: []\n', 'utf8');
        const missingChapterRes = await web.invoke('POST', '/api/narrate/voice-harvest', {
            chapterNumber: 99
        });
        expect(missingChapterRes.statusCode).toBe(404);
    });

    it('POST /api/narrate/voice-harvest 候选样本全部未通过门禁时返回 422 且多轮 LOCAL_PATCH SSE 不串用旧 sessionId', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'voice-harvest-422-and-sse-session');
        const booksRoot = join(bookRoot, '..');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot, booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot, booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());
        const web = createMockWebServer(ctx);

        let patchCalls = 0;
        let fcCalls = 0;
        let writerCalls = 0;
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '双轮修补测试',
                        target_word_count: 1200,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '双轮 Patch SSE 时序验证',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '巡检', is_spotlight: true }
                        ],
                        outline_text: '沈默巡检码头。'
                    });
                    return;
                }
                if (tools.has('yield_patched_draft')) {
                    patchCalls += 1;
                    if (patchCalls === 1) {
                        // 第 1 轮（Gate 触发）修补第 2 段（0 索引为自动补全的一级标题），通过 StaticProseGate 门禁
                        await execTool('patch_paragraphs', {
                            edits: [
                                {
                                    start_paragraph: 2,
                                    end_paragraph: 2,
                                    replacement_paragraphs: ['沈默把铜钥匙收进风衣内袋。']
                                }
                            ]
                        });
                        await execTool('yield_patched_draft', {
                            summary: '第1轮局部修补'
                        });
                        return;
                    }
                    // 第 2 轮（FactChecker 触发）修补第 3 段
                    await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 3,
                                end_paragraph: 3,
                                replacement_paragraphs: ['老周把账本推到煤油灯下。']
                            }
                        ]
                    });
                    await execTool('yield_patched_draft', { summary: '第2轮局部修补' });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    fcCalls += 1;
                    if (fcCalls === 1) {
                        await execTool('yield_verdict', {
                            passed: false,
                            issues: [
                                {
                                    severity: 'LOCAL_PATCH',
                                    paragraph_index: 3,
                                    description: '第3段老周位置与三号码头货栈存档不符，请改为在灯下翻账本',
                                    quote_draft: '老周转身走出大门。',
                                    quote_source: '驻留节点：三号码头货栈',
                                    source_ref: 'entities/char_001.md'
                                }
                            ]
                        });
                        return;
                    }
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '双轮修补完成。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: (opts) => {
                if (opts.system?.includes('Voice Harvest')) {
                    // 返回全部命中 StaticProseGate 微距词的候选样本，触发 422 ValidationError
                    return textToStreamChunks(
                        JSON.stringify({
                            samples: [
                                { tag: '套话', text: '他指节泛白，喉结滚动。' }
                            ]
                        })
                    );
                }
                writerCalls += 1;
                if (writerCalls === 1) {
                    return textToStreamChunks(
                        [
                            '沈默走进货栈。',
                            '',
                            '他指节泛白地扶住门框。',
                            '',
                            '老周转身走出大门。',
                            '',
                            '海风从窗缝灌进来。',
                            '',
                            '拖轮拉响了低沉的汽笛。'
                        ].join('\n')
                    );
                }
                return textToStreamChunks('沈默合上账本。');
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { booksRoot, heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const sse = await web.openSse();
        registerCleanup(() => sse.close());

        const stepRes = await web.invoke('POST', '/api/narrate/step', {
            chapterNumber: 1,
            chapterGoal: '测试多轮 LOCAL_PATCH SSE 事件与 stage:session'
        });
        expect(stepRes.statusCode).toBe(200);

        const stageSessionEvents = sse.events.filter((e) => e.event === 'stage:session');
        const patchSessionEvents = stageSessionEvents.filter(
            (e) => e.data['stage'] === 'LOCAL_PATCH'
        );
        expect(patchSessionEvents).toHaveLength(2);
        const patchSession1 = patchSessionEvents[0]!.data['sessionId'];
        const patchSession2 = patchSessionEvents[1]!.data['sessionId'];
        expect(typeof patchSession1).toBe('string');
        expect(typeof patchSession2).toBe('string');
        expect(patchSession1).not.toBe(patchSession2);
        expect(patchSessionEvents[0]!.data['attempt']).toBe(1);
        expect(patchSessionEvents[1]!.data['attempt']).toBe(2);

        // 验证第 2 轮 LOCAL_PATCH 进度事件（"Gate 触发第 2 轮局部修补"）未复用第 1 轮旧 sessionId
        const round2ProgressStage = sse.events.find(
            (e) =>
                e.event === 'stage' &&
                e.data['stage'] === 'LOCAL_PATCH' &&
                typeof e.data['message'] === 'string' &&
                e.data['message'].includes('第 2 轮')
        );
        expect(round2ProgressStage).toBeDefined();
        expect(round2ProgressStage!.data['activeSessionId']).toBeUndefined();

        // 验证候选样本全部被 StaticProseGate 拒绝时返回 422
        const rejectedHarvestRes = await web.invoke('POST', '/api/narrate/voice-harvest', {
            chapterNumber: 1
        });
        expect(rejectedHarvestRes.statusCode).toBe(422);
    });
});

describe('Wave 3B 收口回归集成测试', () => {
    const execFileAsync = promisify(execFile);

    async function setupWave3bWorkspace(
        slug: string,
        opts: {
            selectBookRoot?: boolean;
            booksRoot?: string;
            exactSlugInBooksRoot?: boolean;
            onAgent?: Parameters<typeof createHeadlessMockServices>[1]['onAgent'];
            onLlmStream?: Parameters<typeof createHeadlessMockServices>[1]['onLlmStream'];
            configOverrides?: Record<string, unknown>;
        } = {}
    ) {
        let booksRoot = opts.booksRoot;
        let bookRoot = await createGitBookWorkspace(tempDirs, slug);
        if (opts.exactSlugInBooksRoot) {
            if (!booksRoot) {
                booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-books-root-'));
                tempDirs.push(booksRoot);
            }
            const targetBookRoot = join(booksRoot, slug);
            await rename(bookRoot, targetBookRoot);
            bookRoot = targetBookRoot;
        } else if (!booksRoot) {
            booksRoot = join(bookRoot, '..');
        }

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, {
            ...(opts.selectBookRoot !== false ? { bookRoot } : {}),
            booksRoot
        });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, {
            ...(opts.selectBookRoot !== false ? { bookRoot } : {}),
            booksRoot
        });
        registerCleanup(() => bookToolsFiber.dispose());

        const web = createMockWebServer(ctx);
        const cmds = createMockCommandsRuntime(ctx);
        const mockState = await createHeadlessMockServices(ctx, {
            onAgent: opts.onAgent ?? (async () => {}),
            onLlmStream: opts.onLlmStream ?? (() => textToStreamChunks('ok'))
        });
        const pipelineFiber = await ctx.plugin(pipelinePlugin, {
            heartbeatIntervalMs: 60_000,
            ...(opts.configOverrides ?? {})
        });
        registerCleanup(() => pipelineFiber.dispose());

        return { bookRoot, booksRoot, ctx, web, cmds, mockState };
    }

    it('章节 PUT 必须同时匹配原作品、章号与工作树版本，拒绝时不备份也不启动 Sync', async () => {
        const { bookRoot, ctx, web } = await setupWave3bWorkspace('edit-origin');
        const other = await createGitBookWorkspace(tempDirs, 'edit-other');
        const rel = 'manuscripts/ch_0001.md';
        for (const root of [bookRoot, other]) await writeFile(join(root, rel), '两本书的相同原文。\n');
        const detail = await web.invoke('GET', '/api/narrate/chapter?ch=1');
        expect(detail.statusCode).toBe(200);
        expect(detail.json['bookRoot']).toBe(bookRoot);
        const draft = { bookRoot, chapterNumber: 1, baseSha256: detail.json['sha256'], content: '编辑稿。' };
        const sse = await web.openSse();
        registerCleanup(() => sse.close());
        const put = (payload: Record<string, unknown>) => web.invoke('PUT', '/api/narrate/chapter', payload);
        expect((await put({ chapterNumber: 1, content: draft.content })).statusCode).toBe(400);
        await ctx.narratePipeline.switchBook(other);
        expect((await put(draft)).statusCode).toBe(409);
        expect(await readFile(join(other, rel), 'utf8')).toBe('两本书的相同原文。\n');
        await ctx.narratePipeline.switchBook(bookRoot);
        const store = ctx.narrateStore.openStore(bookRoot);
        await store.beginDraft(2);
        const pendingResult = await put(draft);
        expect(pendingResult.statusCode).toBe(409);
        expect(await readFile(join(bookRoot, rel), 'utf8')).toBe('两本书的相同原文。\n');
        await writeFile(join(bookRoot, rel), '其他编辑器的新原文。\n');
        expect((await put(draft)).statusCode).toBe(409);
        expect(await readFile(join(bookRoot, rel), 'utf8')).toBe('其他编辑器的新原文。\n');
        for (const root of [bookRoot, other]) await expect(stat(join(root, '.ops/manual_edits'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(sse.events.some((evt) => evt.event === 'sync:started')).toBe(false);
    });

    it('ISS-027 & ISS-068: service 默认从包目录解析 craft 插件（不依赖 process.cwd），并托管启动 ensureDefaultBookSelected 以便立即卸载排空', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-cwd-craft-books-'));
        tempDirs.push(booksRoot);
        const rawBookRoot = await createGitBookWorkspace(tempDirs, 'cwd-craft-and-drain');
        const bookRoot = join(booksRoot, 'cwd-craft-and-drain');
        await rename(rawBookRoot, bookRoot);
        const cfgPath = join(bookRoot, 'world/book_config.yaml');
        const rawCfg = await readFile(cfgPath, 'utf8');
        await writeFile(cfgPath, `${rawCfg}\ncraft_plugins:\n  - vad-bdi\n`, 'utf8');

        const prevCwd = process.cwd();
        const unrelatedCwd = await mkdtemp(join(tmpdir(), 'narrate-unrelated-cwd-'));
        tempDirs.push(unrelatedCwd);
        process.chdir(unrelatedCwd);
        try {
            const ctx = new Context();
            const promptFiber = await ctx.plugin(SystemPrompt);
            registerCleanup(() => promptFiber.dispose());
            const toolsFiber = await ctx.plugin(ToolsService);
            registerCleanup(() => toolsFiber.dispose());
            const storeFiber = await ctx.plugin(bookStorePlugin, { booksRoot });
            registerCleanup(() => storeFiber.dispose());
            const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
            registerCleanup(() => bookToolsFiber.dispose());
            createMockWebServer(ctx);
            await createHeadlessMockServices(ctx, {
                onAgent: async ({ tools, execTool }) => {
                    if (tools.has('yield_context_pack')) {
                        await execTool('yield_context_pack', {
                            selected_entity_ids: ['char_001'],
                            recall_queries: [],
                            selected_lore_files: []
                        });
                        return;
                    }
                    if (tools.has('yield_outline')) {
                        await execTool('yield_outline', {
                            chapter_title: '无关工作目录插件解析测试',
                            target_word_count: 1000,
                            focus_cast: ['char_001'],
                            background_cast: [],
                            ending_beat: 'HOOK',
                            director_rationale: '秘辛',
                            chapter_turn: '插件路径无关测试',
                            scene_plan: [
                                { scene_index: 1, location: '码头', summary: '开场', is_spotlight: true }
                            ],
                            outline_text: '测试内容。'
                        });
                        return;
                    }
                    if (tools.has('yield_verdict')) {
                        await execTool('yield_verdict', { passed: true, issues: [] });
                        return;
                    }
                    if (tools.has('yield_state_patch')) {
                        await execTool('yield_state_patch', {
                            entity_patches: [],
                            story_day_delta: 0,
                            chapter_summary: '完成',
                            next_chapter_options: ['继续']
                        });
                    }
                },
                onLlmStream: () => textToStreamChunks('雨夜码头静得能听见缆绳勒进木桩的声音。')
            });

            const pipelineFiber = await ctx.plugin(pipelinePlugin, {
                heartbeatIntervalMs: 60_000
            });
            // 立即卸载插件，验证 trackBackgroundTask 安全排空 ensureDefaultBookSelected 无未捕获异常
            await pipelineFiber.dispose();

            // 重新挂载后等待后台选书完成再从无关 cwd 运行单章，验证仍能稳定加载仓库内 vad-bdi craft 插件
            const pipelineFiber2 = await ctx.plugin(pipelinePlugin, {
                heartbeatIntervalMs: 60_000
            });
            registerCleanup(() => pipelineFiber2.dispose());
            await ctx.narratePipeline.ensureDefaultBookSelected();

            const res = await ctx.narratePipeline.stepChapter({
                chapterNumber: 1,
                chapterGoal: '在无关 cwd 下验证默认 craft 插件路径解析'
            });
            expect(res.status).toBe('COMMITTED');
        } finally {
            process.chdir(prevCwd);
        }
    });

    it('ISS-012 & ISS-014: 主对话 lock_charter_and_boot 触发切书联动（单次 book_switched SSE）；bootBook 前置拦截非空目录（0 LLM）并迁移 staging 日志与完整契约', async () => {
        const booksRoot1 = await mkdtemp(join(tmpdir(), 'narrateos-boot-books1-'));
        tempDirs.push(booksRoot1);
        const { ctx, web } = await setupWave3bWorkspace('boot-a', {
            booksRoot: booksRoot1,
            exactSlugInBooksRoot: true
        });
        const sse = await web.openSse();
        registerCleanup(() => sse.close());

        // 1. 主对话工具 lock_charter_and_boot 触发切书联动与 SSE 单次广播
        const lockTool = ctx.tools.get('lock_charter_and_boot');
        expect(lockTool).toBeDefined();
        await lockTool!.execute(
            {
                book_slug: 'boot-via-chat',
                title: '主对话开书测试',
                pov_character: 'char_lead',
                t0_anchor: '开元七年秋夜子时',
                commitments: ['绝不降智收尾'],
                excluded_cliches: ['瞳孔骤缩', '嘴角上扬'],
                narration_subjectivity: 'subjective_first',
                stage_ceiling: '第一卷暂不揭露幕后总签批人',
                opening_sequence_beats: [
                    { craft_focus: '风灯与旧箱', clue_budget: '三号仓编号', completion_sign: '发现缺页' },
                    { craft_focus: '交接对白', clue_budget: '夜班印章', completion_sign: '确认改签' },
                    { craft_focus: '拖轮离港', clue_budget: '船号尾数', completion_sign: '锁定去向' }
                ],
                current_arc_envelope: '雨夜码头盘库核账。',
                static_base_and_voice: '深度主观第三人称，冷峻克制。',
                world_summary: '雾夜港区旧账悬案。',
                l1_volumes_markdown: '# L1\n\n- vol_01: 码头旧账',
                entities: [
                    {
                        entityId: 'char_lead',
                        canonicalName: '沈清',
                        innateLocks: [{ visibility: 'PUBLIC', text: '右腕旧伤' }],
                        acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', text: '码头账房' }],
                        irreversibleTrajectory: [{ storyDay: 0, text: '接手查账' }],
                        recentBuffer: []
                    }
                ]
            },
            {
                token: Symbol('boot') as never,
                callId: 'call-boot' as never,
                rootCallId: 'call-boot' as never,
                name: 'lock_charter_and_boot',
                arguments: {},
                signal: new AbortController().signal,
                deferContext() {},
                concludeTurn() {}
            }
        );

        const switchEvents = sse.events.filter(
            (e) =>
                e.event === 'book_switched' &&
                typeof e.data['bookRoot'] === 'string' &&
                e.data['bookRoot'].endsWith('/boot-via-chat')
        );
        expect(switchEvents).toHaveLength(1);
        const migratedCfg = await readFile(join(booksRoot1, 'boot-via-chat/world/book_config.yaml'), 'utf8');
        expect(migratedCfg).toContain('subjective_first');
        expect(migratedCfg).toContain('tokens_per_char');
        const migratedCharter = await readFile(join(booksRoot1, 'boot-via-chat/world/author_charter.md'), 'utf8');
        expect(migratedCharter).toContain('瞳孔骤缩');
        expect(migratedCharter).toContain('开元七年秋夜子时');
        expect(migratedCharter).toContain('绝不降智收尾');

        // 2. 验证 POST /api/narrate/boot 对非空目标目录在启动 boot-compiler LLM 前直接报 409（0 Agent 调用）
        const booksRoot2 = await mkdtemp(join(tmpdir(), 'narrateos-boot-books2-'));
        tempDirs.push(booksRoot2);
        let bootCompilerCalls = 0;
        const { ctx: ctx2, web: web2 } = await setupWave3bWorkspace('boot-b', {
            booksRoot: booksRoot2,
            exactSlugInBooksRoot: true,
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_boot_bundle')) {
                    bootCompilerCalls += 1;
                    await execTool('yield_boot_bundle', {
                        world_summary: '大历三年冬至雪夜港区奇案。',
                        static_base_and_voice: '冷静客观第三人称。',
                        current_arc_envelope: '第一卷围绕港口走私账展开。',
                        stage_ceiling: '暂不揭露幕后总督。',
                        opening_sequence_beats: [
                            { craft_focus: '雪夜盘库', clue_budget: '密信封蜡', completion_sign: '密信现形' },
                            { craft_focus: '对质', clue_budget: '缺页清单', completion_sign: '锁定内鬼' },
                            { craft_focus: '封港', clue_budget: '号灯', completion_sign: '船队滞留' }
                        ],
                        l1_volumes_markdown: '# L1\n\n- vol_01: 雪夜账册',
                        entities: [
                            {
                                entityId: 'char_lead',
                                canonicalName: '沈清',
                                innateLocks: [{ visibility: 'PUBLIC', text: '右腕旧伤' }],
                                acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', text: '码头账房' }],
                                irreversibleTrajectory: [{ storyDay: 0, text: '接手查账' }],
                                recentBuffer: []
                            }
                        ]
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const nonEmptyTarget = join(booksRoot2, 'occupied-slug');
        await mkdir(nonEmptyTarget, { recursive: true });
        await writeFile(join(nonEmptyTarget, 'occupant.md'), 'keep', 'utf8');

        const conflictBootRes = await web2.invoke('POST', '/api/narrate/boot', {
            slug: 'occupied-slug',
            title: '冲突目录',
            povCharacter: 'char_lead',
            mode: 'original',
            premiseOrSeed: '测试前置冲突拦截'
        });
        expect(conflictBootRes.statusCode).toBe(409);
        expect(bootCompilerCalls).toBe(0);

        // 3. 验证 boot-compiler 建库成功并迁移 .boot-staging-* 中的 runs.jsonl 与 session_logs/*.json
        const compiledBootRes = await web2.invoke('POST', '/api/narrate/boot', {
            slug: 'fresh-compiled-book',
            title: '新编撰书',
            povCharacter: 'char_lead',
            mode: 'original',
            premiseOrSeed: '雪夜港口权谋奇幻',
            t0_anchor: '大历三年冬至',
            excluded_cliches: ['倒吸一口凉气'],
            narration_subjectivity: 'objective_third',
            commitments: ['因果严格闭环']
        });
        expect(compiledBootRes.statusCode).toBe(201);
        expect(bootCompilerCalls).toBe(1);

        const compiledRoot = join(booksRoot2, 'fresh-compiled-book');
        const runsRes = await web2.invoke('GET', '/api/narrate/runs');
        expect(runsRes.statusCode).toBe(200);
        const bootRuns = (runsRes.json['runs'] as Array<{ stage: string; sessionId: string }>).filter(
            (r) => r.stage === 'BOOT_COMPILER'
        );
        expect(bootRuns.length).toBeGreaterThanOrEqual(1);
        const detailRes = await web2.invoke(
            'GET',
            `/api/narrate/runs/detail?sessionId=${encodeURIComponent(bootRuns[0]!.sessionId)}`
        );
        expect(detailRes.statusCode).toBe(200);

        const compiledCfg = await readFile(join(compiledRoot, 'world/book_config.yaml'), 'utf8');
        expect(compiledCfg).toContain('objective_third');
        expect(compiledCfg).toContain('tokens_per_char');
        const charterMd = await readFile(join(compiledRoot, 'world/author_charter.md'), 'utf8');
        expect(charterMd).toContain('倒吸一口凉气');
        expect(charterMd).toContain('因果严格闭环');
        expect(charterMd).toContain('大历三年冬至');
        expect(ctx2.narratePipeline.bookRoot).toBe(compiledRoot);
    });

    it('ISS-013 (Q2) & ISS-060 & ISS-064 & ISS-065: pause_after_chapter_1 优雅停机、next_chapter_options 回读与完整诊断状态/SSE', async () => {
        let observedPlannerGoal = '';
        let fcRound = 0;
        const { bookRoot, ctx, web } = await setupWave3bWorkspace('q2-status-sse', {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    observedPlannerGoal = taskPrompt;
                    await execTool('yield_outline', {
                        chapter_title: '候选方向推进章',
                        target_word_count: 1000,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '按候选方向推进',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '盘查货箱', is_spotlight: true }
                        ],
                        outline_text: '盘查货箱。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    fcRound += 1;
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '盘查完货箱',
                        next_chapter_options: ['追查二号码头暗舱', '审讯夜班库管']
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks(
                    '夜潮退去时，码头青石板上留下一行盐渍与铁锈拖痕，风吹得桅杆绳索作响。'
                )
        });

        const cfgPath = join(bookRoot, 'world/book_config.yaml');
        const cfgText = await readFile(cfgPath, 'utf8');
        await writeFile(
            cfgPath,
            `${cfgText}\nopening:\n  voice_seed_mode: hybrid_rolling\n  pause_after_chapter_1: true\n`,
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/arc_director_plan.md'),
            [
                '# 导演禁区与开篇节拍计划',
                '',
                '## Opening Sequence Beats',
                '- [DONE ch_0001] 风灯与旧箱（已定稿）',
                '- [status: DONE ch_0002] 交接对白（兼容旧格式）',
                '- [PENDING] 拖轮离港'
            ].join('\n') + '\n',
            'utf8'
        );

        const sse = await web.openSse();
        registerCleanup(() => sse.close());

        // 启动目标 3 章 YOLO：第 1 章完成后应因 pause_after_chapter_1=true 优雅停机
        const started = await ctx.narratePipeline.startYolo({ targetChapters: 3 });
        expect(started.targetChapters).toBe(3);
        const pauseEvt = await sse.waitForEvent(
            (e) => e.event === 'yolo_halted' && e.data['reason'] === 'PAUSE_AFTER_CHAPTER_1'
        );
        await new Promise((r) => setImmediate(r));
        expect(pauseEvt).toBeDefined();

        expect(
            sse.events.filter(
                (e) =>
                    (e.event === 'chapter:phase' && e.data['phase'] === 'FAILED') ||
                    (e.event === 'yolo_halted' && e.data['reason'] === 'ERROR')
            )
        ).toEqual([]);
        const txAfterCh1 = await ctx.narrateStore.openStore().readTxState();
        expect(txAfterCh1.last_committed_ch).toBe(1);

        // 验证 SSE gate:result 含 kontoyiannisEntropy 与 violations，且 checker:result 已触发
        const gateEvt = sse.events.find((e) => e.event === 'gate:result');
        expect(gateEvt).toBeDefined();
        expect(typeof gateEvt!.data['kontoyiannisEntropy']).toBe('number');
        expect(Array.isArray(gateEvt!.data['violations'])).toBe(true);

        const checkerEvt = sse.events.find((e) => e.event === 'checker:result');
        expect(checkerEvt).toBeDefined();
        expect(checkerEvt!.data['passed']).toBe(true);
        expect(Array.isArray(checkerEvt!.data['issues'])).toBe(true);
        expect(checkerEvt!.data['filteredOutCount']).toBe(0);
        expect(fcRound).toBeGreaterThanOrEqual(1);

        // 验证 GET /api/narrate/status 诊断字段完整（含 [DONE ch_XXXX] 与 [status: DONE] 混合节拍解析）
        const statusRes = await web.invoke('GET', '/api/narrate/status');
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json['openingBeats']).toMatchObject({
            total: 3,
            completed: 2,
            pending: 1
        });
        expect((statusRes.json['openingBeats'] as { beats: Array<{ completedChapter?: string }> }).beats[0]?.completedChapter).toBe('ch_0001');
        expect(statusRes.json['txLockHeld']).toBe(false);
        expect(typeof statusRes.json['featCommitSha']).toBe('string');
        expect(typeof statusRes.json['stateCommitSha']).toBe('string');
        expect(statusRes.json['writerAssemblyReport']).toMatchObject({
            chapterNumber: 1
        });
        expect(statusRes.json['nextChapterOptions']).toEqual([
            '追查二号码头暗舱',
            '审讯夜班库管'
        ]);
        expect(statusRes.json['volumeProgress']).toBeDefined();
        expect(statusRes.json['dreamWatermark']).toBeDefined();
        expect(Array.isArray(statusRes.json['spotlightQueue'])).toBe(true);

        // 验证不传目标触发第 2 章时，自动回读 .ops/next_chapter_options.json 第一条方向
        const stepRes = await web.invoke('POST', '/api/narrate/step', {});
        expect(stepRes.statusCode).toBe(200);
        expect(observedPlannerGoal).toContain('追查二号码头暗舱');

        // 验证 .ops/tx.lock 持有期间 status.txLockHeld === true
        await writeFile(
            join(bookRoot, '.ops/tx.lock'),
            JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString(),
                owner: 'test'
            }),
            'utf8'
        );
        const lockedStatusRes = await web.invoke('GET', '/api/narrate/status');
        expect(lockedStatusRes.json['txLockHeld']).toBe(true);
        await rm(join(bookRoot, '.ops/tx.lock'), { force: true });
    });

    it('ISS-041 & ISS-051: 跨书 runs/detail 严格隔离；SyncPipeline 注入 roleRunner 并暴露 sync_conflicts 与 stateDiffAdvisories', async () => {
        const sharedBooksRoot = await mkdtemp(join(tmpdir(), 'narrateos-sync-books-'));
        tempDirs.push(sharedBooksRoot);

        // 先在同级目录建好 bookB
        const tempBookB = await createGitBookWorkspace(tempDirs, 'sync-book-b');
        const bookB = join(sharedBooksRoot, 'sync-book-b');
        await rename(tempBookB, bookB);

        const { bookRoot: bookA, ctx, web } = await setupWave3bWorkspace('sync-book-a', {
            booksRoot: sharedBooksRoot,
            exactSlugInBooksRoot: true,
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [
                            {
                                entity_id: 'char_001',
                                acquired_state_ops: [
                                    {
                                        op: 'append',
                                        entry: {
                                            storyDay: 1,
                                            visibility: 'PUBLIC',
                                            text: '蓝皮账本已烧成灰烬'
                                        }
                                    }
                                ]
                            }
                        ],
                        story_day_delta: 0,
                        chapter_summary: '角色状态已按手改重抽',
                        next_chapter_options: []
                    });
                }
            },
            onLlmStream: (opts) => {
                const sys = opts.system ?? '';
                if (sys.includes('手稿增量同步定性器')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            is_prose_polish_only: false,
                            reason: '手改改变了道具归属，可能与后续章冲突',
                            affected_entity_ids: ['char_001']
                        })
                    );
                }
                if (sys.includes('只读连续性冲突扫描器')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            conflicts: [
                                {
                                    chapter_number: 2,
                                    line_number: 1,
                                    quote: '第 2 章正文：他翻开完好的蓝皮账本核对页码。',
                                    dirty_chapter: 1,
                                    dirty_quote: '第 1 章正文：他把蓝皮账本扔进炉膛烧成灰烬。',
                                    description: '第 1 章已烧毁账本，第 2 章仍完好翻阅'
                                }
                            ]
                        })
                    );
                }
                return textToStreamChunks('ok');
            }
        });

        // 1. 验证 runs/detail 按当前激活 bookRoot 严格隔离同名 sessionId
        await mkdir(join(bookA, '.ops/session_logs'), { recursive: true });
        await mkdir(join(bookB, '.ops/session_logs'), { recursive: true });
        await writeFile(
            join(bookA, '.ops/session_logs/shared-sess.json'),
            JSON.stringify({ sessionId: 'shared-sess', sourceBook: 'bookA', events: [] }),
            'utf8'
        );
        await writeFile(
            join(bookB, '.ops/session_logs/shared-sess.json'),
            JSON.stringify({ sessionId: 'shared-sess', sourceBook: 'bookB', events: [] }),
            'utf8'
        );

        const detailA = await web.invoke('GET', '/api/narrate/runs/detail?sessionId=shared-sess');
        expect(detailA.statusCode).toBe(200);
        expect(detailA.json['sourceBook']).toBe('bookA');

        await ctx.narratePipeline.switchBook(bookB);
        const detailB = await web.invoke('GET', '/api/narrate/runs/detail?sessionId=shared-sess');
        expect(detailB.statusCode).toBe(200);
        expect(detailB.json['sourceBook']).toBe('bookB');
        await ctx.narratePipeline.switchBook(bookA);

        // 2. 构造两章已提交基线并手改第 1 章触发历史脏章同步与冲突扫描
        const store = ctx.narrateStore.openStore();
        await store.beginDraft(1);
        await store.commitDraft(1, '第 1 章正文：他把蓝皮账本锁进抽屉。\n');
        await store.applyStatePatch(1, []);
        await store.beginDraft(2);
        await store.commitDraft(2, '第 2 章正文：他翻开完好的蓝皮账本核对页码。\n');
        await store.applyStatePatch(2, []);

        const loaded = await web.invoke('GET', '/api/narrate/chapter?ch=1');
        const saved = await web.invoke('PUT', '/api/narrate/chapter', {
            bookRoot: loaded.json['bookRoot'], chapterNumber: 1, baseSha256: loaded.json['sha256'],
            content: '第 1 章正文：他把蓝皮账本扔进炉膛烧成灰烬。\n'
        });
        expect(saved.statusCode).toBe(200);
        const syncRes = saved.json['sync'] as SyncManuscriptsResult;
        expect(syncRes.downstreamConflicts).toHaveLength(1);
        expect(syncRes.stateDiffAdvisories?.length).toBeGreaterThanOrEqual(1);
        expect(syncRes.stateDiffAdvisories![0]).toContain('char_001');

        const viewRes = await web.invoke('GET', '/api/narrate/views?kind=sync_conflicts');
        expect(viewRes.statusCode).toBe(200);
        expect((viewRes.json['conflicts'] as unknown[]).length).toBe(1);
        expect((viewRes.json['stateDiffAdvisories'] as string[])[0]).toContain('char_001');
    });

    it('ISS-052 & ISS-063: POST /api/narrate/heal 端到端 Tier 3 回滚自动重跑并清理 heal_plan.json，且斜杠命令参数全解析', async () => {
        const capturedPlanners: string[] = [];
        let writerCount = 0;
        const { bookRoot, ctx, web, cmds } = await setupWave3bWorkspace('heal-and-cmds', {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    capturedPlanners.push(taskPrompt);
                    await execTool('yield_outline', {
                        chapter_title: '自愈重跑测试章',
                        target_word_count: 1000,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '按指令与自愈约束重写',
                        scene_plan: [
                            { scene_index: 1, location: '石阶', summary: '避开冲突重写', is_spotlight: true }
                        ],
                        outline_text: '他站在石阶前凭口头密语核对货单。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '已重演并修正',
                        next_chapter_options: []
                    });
                }
            },
            onLlmStream: (opts) => {
                const sys = opts.system ?? '';
                if (sys.includes('连续性自愈裁判')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            severity: 'CASCADING_HARD',
                            reason: '第 2 章严重依赖已烧毁的账本，需回滚重跑',
                            downstream_dependent: true
                        })
                    );
                }
                writerCount += 1;
                if (writerCount === 1) {
                    return textToStreamChunks('第一夜，他把蓝皮账本锁进抽屉，屋檐外风声紧得像拉满的弓。');
                }
                if (writerCount === 2) {
                    return textToStreamChunks('次日正午，他翻开完好的蓝皮账本核对页码，纸页干爽平整。');
                }
                return textToStreamChunks('他站在石阶前只凭半句口头密语核对货单，全程未翻动任何账本。');
            }
        });

        // 1. 先跑通第 1、2 章形成完整 Git 与 txState 基线
        await ctx.narratePipeline.stepChapter({ chapterNumber: 1, chapterGoal: '第1章' });
        await ctx.narratePipeline.stepChapter({ chapterNumber: 2, chapterGoal: '第2章' });

        // 2. 通过 POST /api/narrate/heal 触发 Tier 3 回滚自动重跑（chapterA=1, chapterB=2 => 回滚至 ch1 并自动重跑 ch2）
        const sse = await web.openSse();
        registerCleanup(() => sse.close());
        const reportPath = join(bookRoot, '.ops/sync_conflicts.json');
        const selected = { dirtyChapter: 1, dirtyQuote: '第一夜，他把蓝皮账本锁进抽屉，屋檐外风声紧得像拉满的弓。',
            chapterNumber: 2, quote: '次日正午，他翻开完好的蓝皮账本核对页码，纸页干爽平整。', description: '第 2 章出现冲突道具' };
        const other = { ...selected, description: '作者没有确认的另一条冲突' };
        await writeFile(reportPath, JSON.stringify({ conflicts: [selected, other], dirtyChapters: [1], stateDiffAdvisories: ['保留'] }));
        const view = await web.invoke('GET', '/api/narrate/views?kind=sync_conflicts');
        const selection = { bookSlug: view.json['bookSlug'], reportRevision: view.json['reportRevision'], conflictIndex: 0 };
        expect((await web.invoke('POST', '/api/narrate/heal', {})).statusCode).toBe(400);
        expect((await web.invoke('POST', '/api/narrate/heal', { selection: { ...selection, bookSlug: 'other' } })).statusCode).toBe(409);
        const healRouteRes = await web.invoke('POST', '/api/narrate/heal', { selection, maxAutoRollbackChapters: 1 });
        expect(healRouteRes.statusCode).toBe(200);
        expect(healRouteRes.json['quarantined']).toBe(false);
        const healDone = await sse.waitForEvent((e) => e.event === 'heal:completed');
        expect(healDone.data['quarantined']).toBe(false);
        expect(writerCount).toBe(3); // Ch.01 + Ch.02 + 自愈重跑 Ch.02
        expect(capturedPlanners.at(-1)).toContain(`sync-${selection.reportRevision}-0`);
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({ conflicts: [other], stateDiffAdvisories: ['保留'] });
        expect((await web.invoke('POST', '/api/narrate/heal', { selection })).statusCode).toBe(409);
        expect(writerCount).toBe(3);

        // heal_plan.json 应已清理
        await expect(stat(join(bookRoot, '.ops/heal_plan.json'))).rejects.toThrow();

        // 3. 验证 /narrate-step 高级参数解析（MAINLINE/PARALLEL/FLASHBACK + --day/--pov/--window/--branch）
        await ctx.narratePipeline.forkParallelWindow({ windowId: 'win_dock' });
        const stepCmdRes = await cmds.invokeCommand(
            'narrate-step',
            '--mode PARALLEL --day 7 --pov char_001 --window win_dock --branch br_alpha 码头潜伏支线'
        );
        expect(stepCmdRes.kind).toBe('success');
        expect(stepCmdRes.text).toContain('mode=PARALLEL');
        expect(stepCmdRes.text).toContain('day=7');
        expect(stepCmdRes.text).toContain('pov=char_001');
        await sse.waitForEvent(
            (e) => e.event === 'chapter:phase' && e.data['phase'] === 'COMMITTED' && e.data['chapterNumber'] === 3
        );
        await sse.waitForEvent((e) => e.event === 'task:idle' && e.data['task'] === 'STEPPING');
        expect(capturedPlanners[capturedPlanners.length - 1]).toContain('码头潜伏支线');
        await ctx.narratePipeline.mergeParallelWindow({ windowId: 'win_dock' });

        // 4. 验证 /narrate-yolo [章数] [默认目标]、/narrate-halt --force 与 /narrate-heal
        const badStepCmd = await cmds.invokeCommand('narrate-step', '--mode INVALID 目标');
        expect(badStepCmd.kind).toBe('error');

        const yoloCmdRes = await cmds.invokeCommand('narrate-yolo', '1 沿街追查线索');
        expect(yoloCmdRes.kind).toBe('success');
        expect(yoloCmdRes.text).toContain('沿街追查线索');
        await sse.waitForEvent(
            (e) => e.event === 'yolo_completed' || e.event === 'yolo_halted'
        );
        await new Promise((r) => setImmediate(r));

        const haltCmdRes = await cmds.invokeCommand('narrate-halt', '--force');
        expect(haltCmdRes.kind).toBe('success');
        expect(haltCmdRes.text).toContain('force=true');

        const healCmdRes = await cmds.invokeCommand('narrate-heal', '--max-rollback 2');
        expect(healCmdRes).toEqual({
            kind: 'success',
            text: expect.stringContaining('maxRollback=2')
        });
    });

    it('ISS-057 & ISS-058 & ISS-061: 并发 startYolo 原子锁定；信号队列零写盘只读查询、并发串行入队及软/硬双档停机', async () => {
        let writerEntered = createDeferred<void>();
        let writerDeferred = createDeferred<void>();
        let observedAbortSignals: boolean[] = [];
        let dreamingCalls = 0;

        const { bookRoot, ctx, web } = await setupWave3bWorkspace('concurrency-signal-halt', {
            onAgent: async ({ tools, execTool, signal }) => {
                if (tools.size === 0) {
                    writerEntered.resolve();
                    const onAbort = () => {
                        observedAbortSignals.push(true);
                        writerDeferred.resolve();
                    };
                    signal.addEventListener('abort', onAbort, { once: true });
                    await writerDeferred.promise;
                    signal.removeEventListener('abort', onAbort);
                    observedAbortSignals.push(signal.aborted);
                    if (signal.aborted) {
                        const err = new Error('Aborted');
                        err.name = 'AbortError';
                        throw err;
                    }
                    return;
                }
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '软停机与信号测试',
                        target_word_count: 1000,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '软停机与信号测试',
                        scene_plan: [
                            { scene_index: 1, location: '港口', summary: '推进剧情', is_spotlight: true }
                        ],
                        outline_text: '推进港口剧情。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '提交完成',
                        next_chapter_options: []
                    });
                    return;
                }
                if (tools.has('yield_dream_commit')) {
                    dreamingCalls += 1;
                    await execTool('yield_dream_commit', {
                        summary: '不应在软停机后执行'
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks('雨歇之后，铁锚重新沉入浅水，灯塔光束掠过防波堤。')
        });

        // 1. 信号队列并发入队自动赋予唯一 id，且 countPendingSignals / status / views?kind=signals 纯只读零写盘
        const [sig1, sig2] = await Promise.all([
            ctx.narratePipeline.enqueueSignal({ type: 'DIRECTOR_NOTE', reason: '并发信号 A' }),
            ctx.narratePipeline.enqueueSignal({ type: 'DIRECTOR_NOTE', reason: '并发信号 B' })
        ]);
        expect(sig1.id).toBeDefined();
        expect(sig2.id).toBeDefined();
        expect(sig1.id).not.toBe(sig2.id);

        await rm(join(bookRoot, '.ops/signals_cursor.json'), { force: true });
        expect(await ctx.narratePipeline.countPendingSignals()).toBe(2);
        await web.invoke('GET', '/api/narrate/status');
        await web.invoke('GET', '/api/narrate/views?kind=signals');
        await expect(stat(join(bookRoot, '.ops/signals_cursor.json'))).rejects.toThrow();

        // 2. 并发双击 startYolo：仅一个成功，另一个抛出 409 冲突，且 running 保持 true
        const sse = await web.openSse();
        registerCleanup(() => sse.close());
        const raceResults = await Promise.allSettled([
            ctx.narratePipeline.startYolo({ targetChapters: 2 }),
            ctx.narratePipeline.startYolo({ targetChapters: 2 })
        ]);
        expect(raceResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(raceResults.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect(ctx.narratePipeline.runtimeStatus.yolo.running).toBe(true);
        // 直接使用开书回调所走的 Store 入口，尚未进入 Writer 时也不可切书。
        await expect(ctx.narrateStore.switchBook(join(bookRoot, '..', 'other'))).rejects.toThrow(BookSwitchConflictError);

        // 等待第 1 章进入 WRITER 后发出默认软停机 (force=false)
        await writerEntered.promise;
        const softHaltRes = await web.invoke('POST', '/api/narrate/halt', {});
        expect(softHaltRes.statusCode).toBe(202);
        expect(softHaltRes.json['force']).toBe(false);

        // 放行在途 Writer：不应收到 abort，且第 1 章完章提交，不启动第 2 章，也不跑 Dreaming
        writerDeferred.resolve();
        await sse.waitForEvent(
            (e) => e.event === 'yolo_halted' || e.event === 'yolo_completed'
        );
        await new Promise((r) => setImmediate(r));
        expect(observedAbortSignals).toEqual([false]);
        const txAfterSoftHalt = await ctx.narrateStore.openStore().readTxState();
        expect(txAfterSoftHalt.last_committed_ch).toBe(1);
        expect(dreamingCalls).toBe(0);

        // 3. 验证 force: true 硬中断立即触发 AbortSignal 且不消费未提交章的新信号
        await ctx.narratePipeline.enqueueSignal({ type: 'DIRECTOR_NOTE', reason: '硬中断后仍保留' });
        writerEntered = createDeferred<void>();
        writerDeferred = createDeferred<void>();
        observedAbortSignals = [];
        const preHaltEventsCount = sse.events.length;
        await ctx.narratePipeline.startYolo({ targetChapters: 2 });
        await writerEntered.promise;
        const hardHaltRes = await web.invoke('POST', '/api/narrate/halt', { force: true });
        expect(hardHaltRes.statusCode).toBe(202);
        expect(hardHaltRes.json['force']).toBe(true);
        await sse.waitForEvent(
            (e) =>
                sse.events.indexOf(e) >= preHaltEventsCount &&
                (e.event === 'yolo_halted' || e.event === 'yolo_completed')
        );
        await new Promise((r) => setImmediate(r));
        expect(observedAbortSignals).toContain(true);
        expect(await ctx.narratePipeline.countPendingSignals()).toBe(1);
    });

    it('ISS-064, 065, 067, 068, 069: 软链拦截、批量 git log、SafeHalt 双套字段与严格 400 入参校验', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-sec-books-'));
        tempDirs.push(booksRoot);
        let fcAttemptInTest = 0;
        const { bookRoot, ctx, web } = await setupWave3bWorkspace('security-and-validation', {
            booksRoot,
            exactSlugInBooksRoot: true,
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: 'SafeHalt 测试',
                        target_word_count: 1000,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '验证批量 git log 与 SafeHalt 事件',
                        scene_plan: [
                            { scene_index: 1, location: '仓库', summary: '触发拦截', is_spotlight: true }
                        ],
                        outline_text: '触发拦截。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    fcAttemptInTest += 1;
                    if (fcAttemptInTest === 1) {
                        // 首次刻意提交未在基准语料存在的假原句，触发双原句验真过滤并由下一跳修正
                        try {
                            await execTool('yield_verdict', {
                                passed: false,
                                issues: [
                                    {
                                        severity: 'PLAN_CONFLICT',
                                        paragraph_index: 0,
                                        description: '无根据幻觉指控',
                                        quote_draft: '他推开仓库木门',
                                        quote_source: '不存在于语料库中的幻觉原句',
                                        source_ref: 'world/world_state.md'
                                    }
                                ]
                            });
                        } catch {
                            // 继续用真实双原句提交以触发 REPLAN -> SAFE_HALT
                        }
                    }
                    await execTool('yield_verdict', {
                        passed: false,
                        issues: [
                            {
                                severity: 'PLAN_CONFLICT',
                                paragraph_index: 0,
                                description: '持续死循环触发 SAFE_HALT',
                                quote_draft: '他推开仓库木门',
                                quote_source: '海港处于封港戒备前夕，旧账房与泊位调度仍在运转。',
                                source_ref: 'world/world_state.md'
                            }
                        ]
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('他推开仓库木门，看见墙上的旧钟停在三点整。')
        });

        // 1. 写入已提交章节 manuscripts/ch_0001.md 验证 GET /api/narrate/chapters 批量 git log 解析
        await writeFile(join(bookRoot, 'manuscripts/ch_0001.md'), '第一章正文内容。\n', 'utf8');
        await ctx.narrateStore.openStore(bookRoot).initializeWalFromDisk();
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'add ch1 for batch log']);

        const chaptersRes = await web.invoke('GET', '/api/narrate/chapters');
        expect(chaptersRes.statusCode).toBe(200);
        const chItems = chaptersRes.json['chapters'] as Array<{ chapterNumber: number; commitSha: string | null }>;
        expect(
            chItems.some(
                (c) => c.chapterNumber === 1 && typeof c.commitSha === 'string' && c.commitSha.length >= 7
            )
        ).toBe(true);

        // 2. 验证 books/ 下外部软链与循环软链（ELOOP）均被 isSubPath Fail-Closed 阻断并返回 400
        const outsideDir = await mkdtemp(join(tmpdir(), 'outside-symlink-target-'));
        tempDirs.push(outsideDir);
        await mkdir(join(outsideDir, 'world'), { recursive: true });
        await writeFile(join(outsideDir, 'world/book_config.yaml'), 'title: evil\n', 'utf8');
        await symlink(outsideDir, join(booksRoot, 'evil-link'));
        const evilSelectRes = await web.invoke('POST', '/api/narrate/book/select', {
            slug: 'evil-link'
        });
        expect(evilSelectRes.statusCode).toBe(400);

        await symlink('evil-loop', join(booksRoot, 'evil-loop'));
        const loopSelectRes = await web.invoke('POST', '/api/narrate/book/select', {
            slug: 'evil-loop'
        });
        expect(loopSelectRes.statusCode).toBe(400);

        // 3. 验证严格 Zod 400 参数校验
        expect((await web.invoke('POST', '/api/narrate/yolo/start', { maxChapters: 'abc' })).statusCode).toBe(400);
        expect((await web.invoke('POST', '/api/narrate/yolo/start', { maxChapters: -1.5 })).statusCode).toBe(400);
        expect((await web.invoke('POST', '/api/narrate/dream', { force: 'yes' })).statusCode).toBe(400);
        expect((await web.invoke('POST', '/api/narrate/halt', { force: 'yes' })).statusCode).toBe(400);
        expect((await web.invoke('POST', '/api/narrate/heal', { maxAutoRollbackChapters: -1 })).statusCode).toBe(400);
        expect(
            (await web.invoke('POST', '/api/narrate/heal', { conflicts: [{ conflictId: '' }] })).statusCode
        ).toBe(400);

        // 4. 触发 SAFE_HALT 验证 checker:result 先于 SAFE_HALT 广播（含 issues 与 filteredOutCount），且 views?kind=halt 同时提供双套字段
        const sse = await web.openSse();
        registerCleanup(() => sse.close());
        await expect(
            ctx.narratePipeline.stepChapter({ chapterNumber: 2, chapterGoal: '测试 SAFE_HALT' })
        ).rejects.toThrow();

        const checkerFailEvt = sse.events.find((e) => e.event === 'checker:result' && e.data['passed'] === false);
        expect(checkerFailEvt).toBeDefined();
        expect(Array.isArray(checkerFailEvt!.data['issues'])).toBe(true);
        expect((checkerFailEvt!.data['issues'] as unknown[]).length).toBeGreaterThanOrEqual(1);
        expect(checkerFailEvt!.data['filteredOutCount']).toBeGreaterThanOrEqual(1);

        const haltViewRes = await web.invoke('GET', '/api/narrate/views?kind=halt');
        expect(haltViewRes.statusCode).toBe(200);
        const haltObj = haltViewRes.json['safeHalt'] as Record<string, unknown>;
        expect(haltObj['reason']).toBeDefined();
        expect(haltObj['halt_reason']).toBeDefined();
        expect(haltObj['chapter']).toBe(2);
        expect(haltObj['chapter_number']).toBe(2);
    });

    it('ISS-004 & ISS-052 & Q4.2: model-routing WAL 原子提交保持洁净工作区；空闲 halt 不毒化后续 heal；YOLO 单发 dream:completed；多章自愈中断后无参 heal 断点续跑', async () => {
        let writerSeq = 0;
        let haltDuringSecondHealChapter = false;
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-heal-resume-books-'));
        tempDirs.push(booksRoot);
        let controllerRef: typeof ctx.narratePipeline | undefined;

        const { bookRoot, ctx, web } = await setupWave3bWorkspace('heal-resume-wal', {
            booksRoot,
            exactSlugInBooksRoot: true,
            onAgent: async ({ tools, execTool, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '断点续跑测试章',
                        target_word_count: 1000,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: taskPrompt.includes('第 2 章') ? 'Ch2' : 'Ch3',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '对账', is_spotlight: true }
                        ],
                        outline_text: '他站在码头核对货单。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '完成一章',
                        next_chapter_options: ['继续']
                    });
                    return;
                }
                if (tools.has('yield_dream_commit')) {
                    await execTool('yield_dream_commit', {
                        summary: 'Dreaming 整理完成',
                        chapter_number: 1,
                        accumulated_words: 100,
                        spotlight_triggers: []
                    });
                }
            },
            onLlmStream: (opts) => {
                const sys = opts.system ?? '';
                if (sys.includes('连续性自愈裁判')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            severity: 'CASCADING_HARD',
                            reason: '连环冲突需回滚重跑 ch2..ch3',
                            downstream_dependent: true
                        })
                    );
                }
                writerSeq += 1;
                if (writerSeq === 1) {
                    return textToStreamChunks('第一夜，他把蓝皮账本锁进抽屉。');
                }
                if (writerSeq === 2) {
                    return textToStreamChunks('次日清晨，他翻开完好的蓝皮账本记下船号。');
                }
                if (writerSeq === 3) {
                    return textToStreamChunks('第三日午后，账房依然摆放着那本完好的蓝皮账本。');
                }
                if (haltDuringSecondHealChapter && writerSeq === 4) {
                    // 在第 2 章重跑期间发起软停机，验证 ch2 完成后于 ch3 之前停在断点
                    haltDuringSecondHealChapter = false;
                    controllerRef?.requestHalt({ force: false });
                }
                return textToStreamChunks('他站在石阶前只凭口头密语完成核对，全程未碰账本。');
            }
        });
        controllerRef = ctx.narratePipeline;

        // 1. 验证 PUT /api/narrate/model-routing 走 WAL 登记 + git commitPaths 提交且工作区洁净
        const routePutRes = await web.invoke('PUT', '/api/narrate/model-routing', {
            model_routing: { strong_creative: 'deepseek-chat' }
        });
        expect(routePutRes.statusCode).toBe(200);
        const statusOut = await execFileAsync('git', ['-C', bookRoot, 'status', '--porcelain']);
        expect(statusOut.stdout.trim()).toBe('');
        await expect(stat(join(bookRoot, '.ops/pending_writes.json'))).rejects.toThrow();

        // 2. 验证 YOLO 运行 Dreaming 时只发送单次 dream:completed SSE（不重复发送）
        const cfgPath = join(bookRoot, 'world/book_config.yaml');
        const cfgText = await readFile(cfgPath, 'utf8');
        await writeFile(
            cfgPath,
            cfgText.replace('word_threshold: 15000', 'word_threshold: 1'),
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', 'world/book_config.yaml']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'tune dream word threshold for test']);

        const sse = await web.openSse();
        registerCleanup(() => sse.close());
        await ctx.narratePipeline.startYolo({ targetChapters: 1 });
        await sse.waitForEvent((e) => e.event === 'yolo_completed' || e.event === 'yolo_halted');
        await new Promise((r) => setImmediate(r));
        expect(sse.events.filter((e) => e.event === 'dream:completed')).toHaveLength(1);

        // 3. 推进 ch2 与 ch3，并在完全空闲时调用 POST /api/narrate/halt（验证不毒化后续 heal）
        await ctx.narratePipeline.stepChapter({ chapterNumber: 2, chapterGoal: 'Ch2' });
        await ctx.narratePipeline.stepChapter({ chapterNumber: 3, chapterGoal: 'Ch3' });

        const idleHaltRes = await web.invoke('POST', '/api/narrate/halt', {});
        expect(idleHaltRes.statusCode).toBe(202);

        // 4. 触发覆盖 ch2..ch3 的 Tier 3 自愈，并在 ch2 重跑时软停机，保留 nextChapter: 3 断点
        haltDuringSecondHealChapter = true;
        const interruptedHealRes = await web.invoke('POST', '/api/narrate/heal', {
            maxAutoRollbackChapters: 3,
            conflicts: [
                {
                    conflictId: 'c-multi-resume',
                    chapterA: 1,
                    quoteA: '第一夜，他把蓝皮账本锁进抽屉。',
                    chapterB: 2,
                    quoteB: '次日清晨，他翻开完好的蓝皮账本记下船号。',
                    description: '第 1~3 章账本存在状态连环冲突',
                    severityHint: 'CASCADING_HARD'
                }
            ]
        });
        expect(interruptedHealRes.statusCode).toBe(500);
        const planMidRaw = JSON.parse(
            await readFile(join(bookRoot, '.ops/heal_plan.json'), 'utf8')
        ) as { nextChapter: number; toChapter: number };
        expect(planMidRaw).toMatchObject({ nextChapter: 3, toChapter: 3 });
        expect((await ctx.narrateStore.openStore().readTxState()).last_committed_ch).toBe(2);

        // 模拟 ch2 已提交但游标还没写回时崩溃，只允许再生成 ch3。
        await writeFile(join(bookRoot, '.ops/heal_plan.json'), JSON.stringify({ ...planMidRaw, nextChapter: 2 }));
        const beforeResume = writerSeq;
        const resumedHealRes = await web.invoke('POST', '/api/narrate/heal', { resume: true });
        expect(resumedHealRes.statusCode).toBe(200);
        expect(resumedHealRes.json['quarantined']).toBe(false);
        expect(writerSeq - beforeResume).toBe(1);
        expect((await ctx.narrateStore.openStore().readTxState()).last_committed_ch).toBe(3);
        await expect(stat(join(bookRoot, '.ops/heal_plan.json'))).rejects.toThrow();
        // 最后一章已提交但核销中断：游标落在末章或末章后一位都只能收尾。
        for (const nextChapter of [3, 4]) {
            await writeFile(join(bookRoot, '.ops/heal_plan.json'), JSON.stringify({ ...planMidRaw, nextChapter }));
            expect((await web.invoke('POST', '/api/narrate/heal', { resume: true })).statusCode).toBe(200);
            expect(writerSeq - beforeResume).toBe(1);
            await expect(stat(join(bookRoot, '.ops/heal_plan.json'))).rejects.toThrow();
        }
    });

    it('Wave 4D: 动态继承 agentDefaultModel、剔除假模型污染、SSE default_model_changed 与无书态 200', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-w4d-nobook-'));
        tempDirs.push(booksRoot);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());
        const web = createMockWebServer(ctx);

        await createHeadlessMockServices(ctx, {
            onAgent: async () => {},
            onLlmStream: () => textToStreamChunks('')
        });

        let currentDefault: { provider: string; model: string; reasoningEffort?: string } = {
            provider: 'openai',
            model: 'gpt-5',
            reasoningEffort: 'medium'
        };
        ctx.provide('agentDefaultModel' as never, {
            currentSelection: () => ({ ...currentDefault })
        } as never);

        Object.assign(ctx.llm as unknown as Record<string, unknown>, {
            listProviders: () => [
                { id: 'openai', name: 'OpenAI' },
                { id: 'anthropic', name: 'Anthropic' }
            ],
            listModels: async (provider: string) => {
                if (provider === 'openai') {
                    return [
                        { provider, id: 'gpt-5', name: 'GPT-5' },
                        { provider, id: 'gpt-5-mini', name: 'GPT-5 Mini' }
                    ];
                }
                if (provider === 'anthropic') {
                    return [{ provider, id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }];
                }
                return [];
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, {
            booksRoot,
            heartbeatIntervalMs: 0
        });
        registerCleanup(() => pipeFiber.dispose());

        // 1. 无书态 (!controller.bookRoot) GET /api/narrate/status、/views、/chapters、/runs 均返回 200
        const statusNoBook = await web.invoke('GET', '/api/narrate/status');
        expect(statusNoBook.statusCode).toBe(200);
        expect(statusNoBook.json['bookRoot']).toBe('');
        expect(statusNoBook.json['defaultModel']).toEqual({
            provider: 'openai',
            model: 'gpt-5',
            reasoningEffort: 'medium'
        });
        expect(statusNoBook.json['poolOverrides']).toEqual({});
        expect(statusNoBook.json['modelRouting']).toEqual({
            strong_creative: 'openai:gpt-5',
            fast_retrieval: 'openai:gpt-5'
        });
        expect((statusNoBook.json['modelRouting'] as Record<string, unknown>)['audit']).toBeUndefined();
        const modelsNoBook = statusNoBook.json['availableModels'] as Array<{
            provider: string;
            model: string;
        }>;
        expect(modelsNoBook.map((m) => `${m.provider}:${m.model}`)).toEqual([
            'openai:gpt-5',
            'openai:gpt-5-mini',
            'anthropic:claude-sonnet-4-5'
        ]);
        expect(modelsNoBook.some((m) => m.model === 'deepseek-v4-pro' || m.model === 'deepseek-flash')).toBe(
            false
        );

        const roleDefsNoBook = statusNoBook.json['roleDefinitions'] as Array<{
            id: string;
            defaultPool: string;
            effectiveProvider: string;
            effectiveModel: string;
        }>;
        expect(roleDefsNoBook.find((r) => r.id === 'fact-checker')).toMatchObject({
            defaultPool: 'strong_creative',
            effectiveProvider: 'openai',
            effectiveModel: 'gpt-5'
        });

        const chaptersNoBook = await web.invoke('GET', '/api/narrate/chapters');
        expect(chaptersNoBook.statusCode).toBe(200);
        expect(chaptersNoBook.json).toEqual({ chapters: [] });

        const runsNoBook = await web.invoke('GET', '/api/narrate/runs');
        expect(runsNoBook.statusCode).toBe(200);
        expect(runsNoBook.json).toEqual({ runs: [] });

        for (const kind of [
            'entities',
            'horizon',
            'threads',
            'telemetry',
            'signals',
            'sync_conflicts',
            'halt',
            'status'
        ]) {
            const viewRes = await web.invoke('GET', `/api/narrate/views?kind=${kind}`);
            expect(viewRes.statusCode).toBe(200);
        }
        const invalidViewRes = await web.invoke('GET', '/api/narrate/views?kind=unknown');
        expect(invalidViewRes.statusCode).toBe(400);

        // 2. 监听 SSE default_model_changed 实时同步 DSH 主对话切模型与 llm/models-updated
        const sse = await web.openSse();
        registerCleanup(() => sse.close());

        currentDefault = {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            reasoningEffort: 'high'
        };
        (ctx.emit as (name: string, ...args: unknown[]) => void)(
            'session/event',
            { id: 'main-chat-session' },
            { type: 'model/selection', data: { ...currentDefault } }
        );

        const changedEvt = await sse.waitForEvent((e) => e.event === 'default_model_changed');
        expect(changedEvt.data['defaultModel']).toEqual({
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            reasoningEffort: 'high'
        });
        expect(changedEvt.data['poolOverrides']).toEqual({});
        expect(changedEvt.data['modelRouting']).toEqual({
            strong_creative: 'anthropic:claude-sonnet-4-5',
            fast_retrieval: 'anthropic:claude-sonnet-4-5'
        });
        expect(typeof changedEvt.data['timestamp']).toBe('string');
        expect(Array.isArray(changedEvt.data['availableModels'])).toBe(true);
        expect(Array.isArray(changedEvt.data['roleDefinitions'])).toBe(true);

        const countAfterSelection = sse.events.filter(
            (e) => e.event === 'default_model_changed'
        ).length;
        (ctx.emit as (name: string, ...args: unknown[]) => void)('llm/models-updated', 'openai');
        await sse.waitForEvent(
            () =>
                sse.events.filter((e) => e.event === 'default_model_changed').length >
                countAfterSelection
        );

        // 3. 无书态 PUT /api/narrate/model-routing 保存全局内存路由 -> 新选书未单独覆盖时继承 -> 空串 "" 清除恢复默认
        const globalPutRes = await web.invoke('PUT', '/api/narrate/model-routing', {
            model_routing: {
                strong_creative: 'openai:gpt-5',
                fast_retrieval: ''
            }
        });
        expect(globalPutRes.statusCode).toBe(200);
        expect(globalPutRes.json['status']).toBe('ok');
        expect(globalPutRes.json['defaultModel']).toEqual({
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            reasoningEffort: 'high'
        });
        expect(globalPutRes.json['poolOverrides']).toEqual({
            strong_creative: 'openai:gpt-5'
        });
        expect(globalPutRes.json['modelRouting']).toEqual({
            strong_creative: 'openai:gpt-5',
            fast_retrieval: 'anthropic:claude-sonnet-4-5'
        });

        // 创建并切入新书（world/book_config.yaml 未配置 model_routing），验证继承全局内存路由
        const tmpBookRoot = await createGitBookWorkspace(tempDirs, 'inherit-global-book');
        const newBookRoot = join(booksRoot, 'inherit-global-book');
        await rename(tmpBookRoot, newBookRoot);
        const selectRes = await web.invoke('POST', '/api/narrate/book/select', {
            bookRoot: newBookRoot
        });
        expect(selectRes.statusCode).toBe(200);

        const statusWithBook = await web.invoke('GET', '/api/narrate/status');
        expect(statusWithBook.statusCode).toBe(200);
        expect(statusWithBook.json['poolOverrides']).toEqual({
            strong_creative: 'openai:gpt-5'
        });
        expect(statusWithBook.json['modelRouting']).toEqual({
            strong_creative: 'openai:gpt-5',
            fast_retrieval: 'anthropic:claude-sonnet-4-5'
        });

        // 传入空串 "" 清除强池显式覆盖，恢复跟随 DSH 本体默认模型
        const clearRes = await web.invoke('PUT', '/api/narrate/model-routing', {
            model_routing: {
                strong_creative: '',
                fast_retrieval: ''
            }
        });
        expect(clearRes.statusCode).toBe(200);
        expect(clearRes.json['poolOverrides']).toEqual({});
        expect(clearRes.json['modelRouting']).toEqual({
            strong_creative: 'anthropic:claude-sonnet-4-5',
            fast_retrieval: 'anthropic:claude-sonnet-4-5'
        });

        // 4. 卸载后对称解绑，不再接收或触发广播
        sse.close();
        await pipeFiber.dispose();
        expect(() =>
            (ctx.emit as (name: string, ...args: unknown[]) => void)(
                'session/event',
                { id: 'main-chat-session' },
                { type: 'model/selection', data: { provider: 'openai', model: 'gpt-5-mini' } }
            )
        ).not.toThrow();
    });

    it('Wave 4D: 无 agentDefaultModel 且无已注册模型时 availableModels 为空且不混入假模型', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-w4d-headless-'));
        tempDirs.push(booksRoot);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());
        const web = createMockWebServer(ctx);

        await createHeadlessMockServices(ctx, {
            onAgent: async () => {},
            onLlmStream: () => textToStreamChunks('')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, {
            booksRoot,
            heartbeatIntervalMs: 0
        });
        registerCleanup(() => pipeFiber.dispose());

        const statusRes = await web.invoke('GET', '/api/narrate/status');
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.json['bookRoot']).toBe('');
        expect(statusRes.json['defaultModel']).toBeNull();
        expect(statusRes.json['poolOverrides']).toEqual({});
        expect(statusRes.json['availableModels']).toEqual([]);

        const slow = createDeferred<Array<{ id: string }>>();
        let first = true;
        Object.assign(ctx.llm, {
            listProviders: () => [{ id: 'local' }],
            listModels: () => {
                if (!first) return Promise.resolve([{ id: 'model:new' }]);
                first = false;
                return slow.promise;
            }
        });
        const oldRefresh = ctx.narratePipeline.refreshDiscoveredDefaultModel();
        expect(await ctx.narratePipeline.listAvailableModels()).toContainEqual({ provider: 'local', model: 'model:new' });
        slow.resolve([{ id: 'model:old' }]);
        await oldRefresh;
        expect(ctx.narratePipeline.poolRouting.strong_creative).toEqual({ provider: 'local', model: 'model:new' });
    });
});

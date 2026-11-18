import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
    it('Config 满足 DSH Schemastery 原生协议 (isNativeConfigSchema === true)', () => {
        expect(isNativeConfigSchema(pipelinePlugin.Config)).toBe(true);
        const normalized = pipelinePlugin.Config(undefined);
        expect(normalized.poolRouting?.strong_creative.provider).toBe('deepseek-official');
        expect(normalized.heartbeatIntervalMs).toBe(15_000);
        expect(normalized.shutdownTimeoutMs).toBe(5_000);
    });

    it('环境变量 NARRATEOS_MODEL_* 可覆写插件 poolRouting 默认模型', async () => {
        const prevStrong = process.env.NARRATEOS_MODEL_STRONG;
        const prevFast = process.env.NARRATEOS_MODEL_FAST;
        const prevAudit = process.env.NARRATEOS_MODEL_AUDIT;
        process.env.NARRATEOS_MODEL_STRONG = 'override-strong-model';
        process.env.NARRATEOS_MODEL_FAST = 'override-fast-model';
        process.env.NARRATEOS_MODEL_AUDIT = 'override-audit-model';
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
                fast_retrieval: { provider: 'deepseek-official', model: 'override-fast-model' },
                audit: { provider: 'deepseek-official', model: 'override-audit-model' }
            });
        } finally {
            if (prevStrong === undefined) delete process.env.NARRATEOS_MODEL_STRONG;
            else process.env.NARRATEOS_MODEL_STRONG = prevStrong;
            if (prevFast === undefined) delete process.env.NARRATEOS_MODEL_FAST;
            else process.env.NARRATEOS_MODEL_FAST = prevFast;
            if (prevAudit === undefined) delete process.env.NARRATEOS_MODEL_AUDIT;
            else process.env.NARRATEOS_MODEL_AUDIT = prevAudit;
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
            bookRoot,
            taskPrompt: '排空顺序测试'
        });
        await runnerEntered.promise;

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
                fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' },
                audit: { provider: 'deepseek-official', model: 'deepseek-flash' }
            }
        });
        registerCleanup(() => pipeFiber.dispose());

        // 1. GET /api/narrate/status 验证新增字段
        const statusBefore = await web.invoke('GET', '/api/narrate/status');
        expect(statusBefore.statusCode).toBe(200);
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
                                    text: '煤油灯焰矮了一截，灯罩内壁蒙着薄灰，照得账页发黄。'
                                },
                                {
                                    tag: '克制对白',
                                    text: '「账页是今早才沾的水，昨夜值班簿上可没这一笔。」'
                                }
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

        // 3. 首次调用 POST /api/narrate/voice-harvest 应成功采集 2 条样本
        const harvestRes = await web.invoke('POST', '/api/narrate/voice-harvest', {
            chapterNumber: 1
        });
        expect(harvestRes.statusCode).toBe(200);
        expect(harvestRes.json).toMatchObject({
            harvestedCount: 2,
            skipped: false
        });
        expect((harvestRes.json['samples'] as unknown[]).length).toBe(2);

        // 4. 重复调用应返回 skipped: true
        const skippedRes = await web.invoke('POST', '/api/narrate/voice-harvest', {});
        expect(skippedRes.statusCode).toBe(200);
        expect(skippedRes.json).toEqual({
            harvestedCount: 0,
            skipped: true,
            samples: []
        });
    });
});

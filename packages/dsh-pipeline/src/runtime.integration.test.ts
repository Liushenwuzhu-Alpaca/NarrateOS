import { EventEmitter } from 'node:events';
import { rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
import { AdmissionClosedError } from './index.js';
import {
    createGitBookWorkspace,
    createHeadlessMockServices,
    textToStreamChunks
} from './test-harness.js';

const tempDirs: string[] = [];

afterEach(async () => {
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
        events: Array<{ event: string; data: Record<string, unknown> }>;
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
                        events.push({
                            event: eventMatch[1].trim(),
                            data: JSON.parse(dataMatch[1]) as Record<string, unknown>
                        });
                    }
                }
                return true;
            },
            end() {
                (res as { writableEnded: boolean }).writableEnded = true;
            }
        }) as unknown as ServerResponse;

        await handler(req, res);
        return {
            events,
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

    it('在途步进期间 switchBook 与 POST /api/narrate/book/select 返回 409，并广播 activeSessionId SSE 与暴露 GET /api/narrate/runs', async () => {
        const bookA = await createGitBookWorkspace(tempDirs, 'book-a');
        const bookB = await createGitBookWorkspace(tempDirs, 'book-b');
        const booksRoot = join(bookA, '..');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        const toolsFiber = await ctx.plugin(ToolsService);
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookA, booksRoot });
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });

        const web = createMockWebServer(ctx);

        let releaseLibrarian: (() => void) | undefined;
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

        const sse = await web.openSse();

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
        expect(detailEvents.some((ev) => ev.kind === 'tool-call' && ev.toolName === 'yield_context_pack')).toBe(true);
        expect(detailEvents.some((ev) => ev.kind === 'tool-result' && ev.toolName === 'yield_context_pack')).toBe(true);

        const stageStreamEvents = sse.events.filter((e) => e.event === 'stage:event');
        expect(stageStreamEvents.some((e) => e.data['kind'] === 'thinking')).toBe(true);
        expect(stageStreamEvents.some((e) => e.data['kind'] === 'tool-call' && e.data['toolName'] === 'yield_context_pack')).toBe(true);

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

        sse.close();
        await pipeFiber.dispose();
        await bookToolsFiber.dispose();
        await storeFiber.dispose();
        await toolsFiber.dispose();
        await promptFiber.dispose();
    });

    it('斜杠命令 (/narrate-step, /narrate-yolo, /narrate-halt, /narrate-signal) 0 Token 异步触发并立即返回回执，且挂载 narrate-boot Skill', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'slash-commands');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        const toolsFiber = await ctx.plugin(ToolsService);
        const skillFiber = await ctx.plugin(SkillRegistry);
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);

        const cmdRuntime = createMockCommandsRuntime(ctx);

        let resolveStepGate: (() => void) | undefined;
        const stepEntered = new Promise<void>((r) => {
            resolveStepGate = r;
        });
        let releaseStep: (() => void) | undefined;

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

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });

        // 等待异步 Skill 注册完成
        await new Promise((r) => setTimeout(r, 30));
        const bootSkill = await ctx.skills.get('narrate-boot');
        expect(bootSkill).toBeDefined();
        expect(bootSkill?.content).toContain('lock_charter_and_boot');

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
        await stepEntered;
        const yoloConflictReceipt = await cmdRuntime.invokeCommand('narrate-yolo', '2');
        expect(yoloConflictReceipt.kind).toBe('error');

        const haltReceipt = await cmdRuntime.invokeCommand('narrate-halt');
        expect(haltReceipt.kind).toBe('success');

        releaseStep?.();
        // 等待后台任务收敛
        await new Promise((r) => setTimeout(r, 50));

        await pipeFiber.dispose();
        await bookToolsFiber.dispose();
        await storeFiber.dispose();
        await skillFiber.dispose();
        await toolsFiber.dispose();
        await promptFiber.dispose();
    });

    it('在途运行期间卸载插件：立即关闭准入、超时广播 halt:waiting 而不提前注销路由/锁、等待排空且零残留 .ops/tx.lock', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'teardown-drain');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        const toolsFiber = await ctx.plugin(ToolsService);
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        const web = createMockWebServer(ctx);

        let releaseInFlight: (() => void) | undefined;
        let agentEnteredResolve: (() => void) | undefined;
        const agentEntered = new Promise<void>((r) => {
            agentEnteredResolve = r;
        });

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    agentEnteredResolve?.();
                    // 故意延迟一小段时间再结束，模拟 WAL/Agent 在途排空与超时告警
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

        const sse = await web.openSse();
        const controller = ctx.narratePipeline;

        const inFlightPromise = controller.stepChapter({
            chapterNumber: 1,
            chapterGoal: '测试停机排空'
        });
        await agentEntered;

        // 发起插件卸载（此时在途任务尚未结束）
        let disposeSettled = false;
        const disposePromise = pipeFiber.dispose().then(() => {
            disposeSettled = true;
        });

        // 1. 准入闸门立即关闭：拒绝新任务
        await expect(
            controller.stepChapter({ chapterGoal: '不应被接收' })
        ).rejects.toBeInstanceOf(AdmissionClosedError);

        // 2. 超过 shutdownTimeoutMs=40ms 后，应发出 halt:waiting 但尚未释放路由与服务
        await new Promise((r) => setTimeout(r, 80));
        expect(disposeSettled).toBe(false);
        expect(sse.events.some((e) => e.event === 'halt:waiting')).toBe(true);
        expect(web.routes.has('exact:/api/narrate/status')).toBe(true);
        expect(ctx.reflect.get('narratePipeline', false) === controller).toBe(true);

        // 3. 放行在途任务收束后，dispose 完成且零残留 .ops/tx.lock
        releaseInFlight?.();
        await Promise.allSettled([inFlightPromise, disposePromise]);

        expect(disposeSettled).toBe(true);
        expect(ctx.reflect.get('narratePipeline', false)).toBeUndefined();
        expect(web.routes.size).toBe(0);
        await expect(stat(join(bookRoot, '.ops/tx.lock'))).rejects.toMatchObject({ code: 'ENOENT' });

        await bookToolsFiber.dispose();
        await storeFiber.dispose();
        await toolsFiber.dispose();
        await promptFiber.dispose();
    });
});

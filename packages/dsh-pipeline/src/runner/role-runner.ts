import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    generateTraced,
    type ApplyStatePatchOptions,
    type BookConfig,
    type CleanroomRequest,
    type CleanroomResponse,
    type NarrationSubjectivity,
    type NarrateStoreService,
    type TimelineMode
} from '@narrateos/dsh-book-store';
import type { BuiltRoleToolSet, NarrateToolsService } from '@narrateos/dsh-book-tools';
import { type LoadedRoleConfig, type RoleLoader } from '../roles/role-loader.js';
import {
    ExtendedRunRecordSchema,
    type ExtendedRunRecord,
    type LlmPoolRouting,
    type StageSessionDetail,
    type StageSessionEvent,
    type StageSessionEventItem,
    type StageStreamSseEvent
} from '../schemas.js';
import { DshLlmAdapter, resolvePoolRoute } from './dsh-llm-adapter.js';

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'narrateos-pipeline': {
            kind: 'narrateos-pipeline';
        };
    }
}

const DREAMER_ALLOWED_OPS_READ = [
    '.ops/voice_samples.yaml',
    '.ops/signals.jsonl',
    '.ops/telemetry.jsonl'
];
const DREAMER_ALLOWED_OPS_WRITE = [
    '.ops/voice_samples.yaml',
    '.ops/signals.jsonl'
];

/** 多轮受控工种调用选项 */
export interface RunMultiTurnOptions {
    roleId: string;
    stage: string;
    bookRoot: string;
    bookConfig?: BookConfig | undefined;
    chapterNumber?: number | undefined;
    taskPrompt: string;
    runId?: string | undefined;
    sessionId?: string | undefined;
    parentSessionId?: string | undefined;
    mode?: string | undefined;
    maxTokens?: number | undefined;
    allowedOpsPaths?: string[] | undefined;
    allowedOpsWritePaths?: string[] | undefined;
    targetChapter?: number | undefined;
    targetDay?: number | undefined;
    chapterGoal?: string | undefined;
    draftText?: string | undefined;
    draftPath?: string | undefined;
    timelineMode?: TimelineMode | undefined;
    allowInnateMutation?: boolean | undefined;
    deferCommit?: boolean | undefined;
    applyOptions?: ApplyStatePatchOptions | undefined;
    narrationSubjectivity?: NarrationSubjectivity | undefined;
    signal?: AbortSignal | undefined;
    onStageSession?: ((event: StageSessionEvent) => void) | undefined;
    onStageEvent?: ((event: StageStreamSseEvent) => void) | undefined;
}

/** 多轮受控工种调用结果 */
export interface RunMultiTurnResult<TYield = unknown> {
    runId: string;
    sessionId: string;
    roleConfig: LoadedRoleConfig;
    yieldResult: TYield;
}

/** 净室单轮执行选项 */
export interface RunCleanroomOptions {
    roleId?: string | undefined;
    bookRoot: string;
    bookConfig?: BookConfig | undefined;
    request: Omit<CleanroomRequest, 'pool'> & { pool?: CleanroomRequest['pool'] | undefined };
    signal?: AbortSignal | undefined;
}

/** RoleRunner 构造依赖 */
export interface RoleRunnerDeps {
    ctx: Context;
    storeService: NarrateStoreService;
    toolsService: NarrateToolsService;
    roleLoader: RoleLoader;
    llmAdapter: DshLlmAdapter;
    poolRouting: LlmPoolRouting;
    onStageEvent?: ((event: StageStreamSseEvent) => void) | undefined;
}

const SESSION_ID_SAFE_RE = /^[a-zA-Z0-9_.-]+$/;

async function appendExtendedRunRecord(
    bookRoot: string,
    record: ExtendedRunRecord
): Promise<void> {
    const validated = ExtendedRunRecordSchema.parse(record);
    const opsDir = join(bookRoot, '.ops');
    await mkdir(opsDir, { recursive: true });
    await appendFile(join(opsDir, 'runs.jsonl'), `${JSON.stringify(validated)}\n`, 'utf8');
}

/**
 * 通用双路径角色执行器：
 * - 多轮探查工种 (`cleanroom: false`)：通过 ctx.agents.create({ meta: { origin: 'subagent' } }) 启动受控 Agent，
 *   挂载单书/预设角色提示词、受控工具白名单与 yield_* 防逃逸 Hook，记录 .ops/runs.jsonl 会话索引与 .ops/session_logs/；
 * - 净室单轮工种 (`cleanroom: true`)：零工具、零 sessionId 直调 DshLlmAdapter (ctx.llm.stream)。
 */
export class RoleRunner {
    private readonly ctx: Context;
    private readonly storeService: NarrateStoreService;
    private readonly toolsService: NarrateToolsService;
    private readonly roleLoader: RoleLoader;
    private readonly llmAdapter: DshLlmAdapter;
    private readonly poolRouting: LlmPoolRouting;
    private readonly defaultOnStageEvent: ((event: StageStreamSseEvent) => void) | undefined;
    private readonly activeHandles = new Set<AgentHandle>();
    private readonly activePromises = new Set<Promise<unknown>>();
    private readonly liveSessionDetails = new Map<string, StageSessionDetail>();

    constructor(deps: RoleRunnerDeps) {
        this.ctx = deps.ctx;
        this.storeService = deps.storeService;
        this.toolsService = deps.toolsService;
        this.roleLoader = deps.roleLoader;
        this.llmAdapter = deps.llmAdapter;
        this.poolRouting = deps.poolRouting;
        this.defaultOnStageEvent = deps.onStageEvent;
    }

    /** 活跃受控 Agent 数量 */
    get activeCount(): number {
        return this.activePromises.size;
    }

    /** 查询内存中的活跃或近期阶段会话明细 */
    getLiveSessionDetail(sessionId: string): StageSessionDetail | undefined {
        return this.liveSessionDetails.get(sessionId);
    }

    /** 通知所有在途多轮 Agent 取消并等待全部运行句柄与清理流程完全排空 */
    async drainActiveRuns(): Promise<void> {
        for (const handle of this.activeHandles) {
            try {
                handle.agent.cancel({ kind: 'disposed' });
            } catch {
                // 忽略已销毁句柄
            }
        }
        if (this.activePromises.size > 0) {
            await Promise.allSettled([...this.activePromises]);
        }
    }

    /** 执行多轮受控工种 (cleanroom: false) */
    async runMultiTurn<TYield = unknown>(
        options: RunMultiTurnOptions
    ): Promise<RunMultiTurnResult<TYield>> {
        const execPromise = this.runMultiTurnInner<TYield>(options);
        this.activePromises.add(execPromise);
        try {
            return await execPromise;
        } finally {
            this.activePromises.delete(execPromise);
        }
    }

    private async runMultiTurnInner<TYield>(
        options: RunMultiTurnOptions
    ): Promise<RunMultiTurnResult<TYield>> {
        if (options.signal?.aborted) {
            throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('Aborted');
        }

        const roleCfg = await this.roleLoader.loadRoleConfig(options.roleId, options.bookRoot);
        if (roleCfg.cleanroom) {
            throw new Error(`工种 ${options.roleId} 配置为 cleanroom=true，请改用 runCleanroom 净室路径`);
        }

        const runId = options.runId ?? randomUUID();
        const sessionIdStr = options.sessionId ?? `narrate-${options.roleId}-${runId}`;
        const sessionId = SessionId(sessionIdStr);
        const chapter = options.chapterNumber ?? 0;
        const startedAt = new Date().toISOString();

        this.storeService.beginRun(runId);

        let toolset: BuiltRoleToolSet | undefined;
        let handle: AgentHandle | undefined;
        let abortCleanup: (() => void) | undefined;

        const sessionDetail: StageSessionDetail = {
            sessionId: sessionIdStr,
            runId,
            stage: options.stage,
            role: options.roleId,
            chapter,
            status: 'running',
            ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
            ...(options.mode ? { mode: options.mode } : {}),
            live: true,
            events: []
        };
        this.liveSessionDetails.set(sessionIdStr, sessionDetail);
        let nextSeq = 0;

        const recordSessionEvent = (item: Omit<StageSessionEventItem, 'seq'>) => {
            const fullItem: StageSessionEventItem = {
                ...item,
                seq: nextSeq++
            };
            sessionDetail.events.push(fullItem);
            try {
                const emitter = options.onStageEvent ?? this.defaultOnStageEvent;
                emitter?.({
                    sessionId: sessionIdStr,
                    stage: options.stage,
                    kind: fullItem.kind,
                    ...(fullItem.text !== undefined ? { text: fullItem.text } : {}),
                    ...(fullItem.toolName !== undefined ? { toolName: fullItem.toolName } : {}),
                    ...(fullItem.callId !== undefined ? { callId: fullItem.callId } : {}),
                    ...(fullItem.status !== undefined ? { status: fullItem.status } : {})
                });
            } catch {
                // 避免流式事件回调异常中断工种主流程
            }
        };

        let disposeSessionEventListener: (() => void) | undefined;

        try {
            const allowedOpsPaths =
                options.allowedOpsPaths ??
                (options.roleId === 'dreamer' ? DREAMER_ALLOWED_OPS_READ : undefined);
            const allowedOpsWritePaths =
                options.allowedOpsWritePaths ??
                (options.roleId === 'dreamer' ? DREAMER_ALLOWED_OPS_WRITE : undefined);

            toolset = this.toolsService.buildRoleTools({
                runId,
                bookRoot: options.bookRoot,
                maxReadCalls: roleCfg.maxReadCalls,
                tools: roleCfg.tools,
                yieldTool: roleCfg.yieldTool ?? undefined,
                allowedOpsPaths,
                allowedOpsWritePaths,
                targetChapter: options.targetChapter,
                targetDay: options.targetDay,
                chapterGoal: options.chapterGoal,
                draftText: options.draftText,
                draftPath: options.draftPath,
                chapterNumber: options.chapterNumber,
                timelineMode: options.timelineMode,
                allowInnateMutation: options.allowInnateMutation,
                deferCommit: options.deferCommit,
                applyOptions: options.applyOptions,
                narrationSubjectivity: options.narrationSubjectivity
            });

            await appendExtendedRunRecord(options.bookRoot, {
                runId,
                chapter,
                stage: options.stage,
                role: options.roleId,
                sessionId: sessionIdStr,
                status: 'running',
                startedAt,
                ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
                ...(options.mode ? { mode: options.mode } : {})
            });

            try {
                options.onStageSession?.({
                    stage: options.stage,
                    role: options.roleId,
                    chapter,
                    runId,
                    sessionId: sessionIdStr,
                    ...(options.parentSessionId
                        ? { parentSessionId: options.parentSessionId }
                        : {}),
                    ...(options.mode ? { mode: options.mode } : {})
                });
            } catch {
                // 避免 SSE 回调异常中断执行
            }

            // 若宿主挂载了 DSH session 事件总线，则订阅本 sessionId 的持久化事件
            if (typeof this.ctx.on === 'function') {
                disposeSessionEventListener = this.ctx.on('session/event', (session, ev) => {
                    if (String(session.id) !== sessionIdStr) return;
                    const ts = new Date().toISOString();
                    if (ev.type === 'tool/call') {
                        const data = ev.data as { callId?: unknown; name?: unknown; arguments?: unknown };
                        recordSessionEvent({
                            timestamp: ts,
                            kind: 'tool-call',
                            toolName: String(data.name ?? ''),
                            callId: String(data.callId ?? ''),
                            text: typeof data.arguments === 'string' ? data.arguments : '',
                            status: 'calling'
                        });
                    } else if (ev.type === 'tool/result') {
                        const data = ev.data as { callId?: unknown; name?: unknown; isError?: unknown };
                        recordSessionEvent({
                            timestamp: ts,
                            kind: 'tool-result',
                            toolName: String(data.name ?? ''),
                            callId: String(data.callId ?? ''),
                            status: data.isError ? 'error' : 'completed'
                        });
                    }
                });
            }

            const route = resolvePoolRoute(this.poolRouting, roleCfg.pool, options.bookConfig);
            const builtToolset = toolset;

            handle = await this.ctx.agents.create({
                sessionId,
                meta: {
                    origin: 'subagent',
                    cwd: options.bookRoot
                },
                agentOptions: {
                    provider: route.provider,
                    model: route.model,
                    ...(roleCfg.reasoningEffort !== undefined
                        ? { reasoningEffort: ReasoningEffortId(roleCfg.reasoningEffort) }
                        : {}),
                    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {})
                },
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
                setup: (agentCtx) => {
                    // 屏蔽宿主全局工具，仅注册该角色白名单内的受控工具（并包裹执行观测器）
                    if (agentCtx.tools) {
                        agentCtx.tools.restrict({ allow: [] });
                        for (const tool of builtToolset.tools) {
                            const observedTool: ToolDefinition = {
                                ...tool,
                                async execute(args, exec) {
                                    recordSessionEvent({
                                        timestamp: new Date().toISOString(),
                                        kind: 'tool-call',
                                        toolName: tool.name,
                                        callId: String(exec.callId),
                                        text: JSON.stringify(args),
                                        status: 'running'
                                    });
                                    try {
                                        const out = await tool.execute(args, exec);
                                        const preview =
                                            typeof out === 'string'
                                                ? out.slice(0, 800)
                                                : JSON.stringify(out).slice(0, 800);
                                        recordSessionEvent({
                                            timestamp: new Date().toISOString(),
                                            kind: 'tool-result',
                                            toolName: tool.name,
                                            callId: String(exec.callId),
                                            text: preview,
                                            status: 'completed'
                                        });
                                        return out;
                                    } catch (err) {
                                        recordSessionEvent({
                                            timestamp: new Date().toISOString(),
                                            kind: 'tool-result',
                                            toolName: tool.name,
                                            callId: String(exec.callId),
                                            text: err instanceof Error ? err.message : String(err),
                                            status: 'error'
                                        });
                                        throw err;
                                    }
                                }
                            };
                            agentCtx.tools.register(observedTool);
                        }
                    }

                    // 挂载外部化角色系统提示词（complete: true 独立隔离）
                    if (agentCtx.systemPrompt) {
                        agentCtx.systemPrompt.section({
                            name: 'narrateos-role',
                            order: 0,
                            text: roleCfg.promptText,
                            complete: true
                        });
                    }

                    // 订阅实时思考/文本流与状态变更，透传给 SSE stage:event
                    agentCtx.on('agent/assistant-stream', ({ frame }) => {
                        if (frame.type !== 'chunk') return;
                        const ts = new Date().toISOString();
                        if (frame.chunk.type === 'reasoning-delta') {
                            recordSessionEvent({
                                timestamp: ts,
                                kind: 'thinking',
                                text: frame.chunk.text
                            });
                        } else if (frame.chunk.type === 'text-delta') {
                            recordSessionEvent({
                                timestamp: ts,
                                kind: 'text',
                                text: frame.chunk.text
                            });
                        } else if (frame.chunk.type === 'tool-call-delta' && frame.chunk.name) {
                            recordSessionEvent({
                                timestamp: ts,
                                kind: 'tool-call',
                                toolName: frame.chunk.name,
                                callId: String(frame.chunk.id),
                                status: 'calling'
                            });
                        }
                    });
                    agentCtx.on('agent/status', ({ status }) => {
                        recordSessionEvent({
                            timestamp: new Date().toISOString(),
                            kind: 'status',
                            status
                        });
                    });
                    agentCtx.on('agent/error', ({ error }) => {
                        recordSessionEvent({
                            timestamp: new Date().toISOString(),
                            kind: 'error',
                            text: error instanceof Error ? error.message : String(error),
                            status: 'error'
                        });
                    });

                    // 挂载防纯文本逃逸终态门禁 Hook
                    if (roleCfg.yieldTool) {
                        this.toolsService.attachYieldEnforcementHook(agentCtx, {
                            expectedYieldTool: roleCfg.yieldTool,
                            maxSteps: roleCfg.maxSteps,
                            hasYielded: builtToolset.hasYielded,
                            cleanupStaging: () => builtToolset.cleanup()
                        });
                    }
                }
            });

            this.activeHandles.add(handle);

            if (options.signal) {
                const liveHandle = handle;
                const onAbort = () => {
                    try {
                        liveHandle.agent.cancel({ kind: 'parent' });
                    } catch {
                        // 忽略已关闭句柄
                    }
                };
                if (options.signal.aborted) {
                    onAbort();
                } else {
                    options.signal.addEventListener('abort', onAbort, { once: true });
                    abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
                }
            }

            const promptMsg = {
                content: [{ type: 'text', text: options.taskPrompt }],
                source: { kind: 'narrateos-pipeline' }
            } as unknown as UserMessage;
            handle.agent.followup(promptMsg);

            await handle.agent.whenIdle();

            if (options.signal?.aborted) {
                throw options.signal.reason instanceof Error
                    ? options.signal.reason
                    : new Error('Aborted');
            }

            if (roleCfg.yieldTool && !toolset.hasYielded()) {
                throw new Error(
                    `工种 ${options.roleId} 未调用终态门禁工具 ${roleCfg.yieldTool} 即结束运行 (maxSteps=${roleCfg.maxSteps})`
                );
            }

            const yieldResult = toolset.getYieldResult<TYield>();
            if (roleCfg.yieldTool && yieldResult === undefined) {
                throw new Error(
                    `工种 ${options.roleId} 调用 ${roleCfg.yieldTool} 后未产出有效结构化结果`
                );
            }

            sessionDetail.status = 'completed';
            await appendExtendedRunRecord(options.bookRoot, {
                runId,
                chapter,
                stage: options.stage,
                role: options.roleId,
                sessionId: sessionIdStr,
                status: 'completed',
                startedAt,
                finishedAt: new Date().toISOString(),
                ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
                ...(options.mode ? { mode: options.mode } : {})
            });

            return {
                runId,
                sessionId: sessionIdStr,
                roleConfig: roleCfg,
                yieldResult: yieldResult as TYield
            };
        } catch (err: unknown) {
            sessionDetail.status = 'failed';
            recordSessionEvent({
                timestamp: new Date().toISOString(),
                kind: 'error',
                text: err instanceof Error ? err.message : String(err),
                status: 'failed'
            });
            await appendExtendedRunRecord(options.bookRoot, {
                runId,
                chapter,
                stage: options.stage,
                role: options.roleId,
                sessionId: sessionIdStr,
                status: 'failed',
                startedAt,
                finishedAt: new Date().toISOString(),
                error: err instanceof Error ? err.message : String(err),
                ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
                ...(options.mode ? { mode: options.mode } : {})
            }).catch(() => {});
            throw err;
        } finally {
            disposeSessionEventListener?.();
            abortCleanup?.();
            sessionDetail.live = false;
            if (SESSION_ID_SAFE_RE.test(sessionIdStr)) {
                try {
                    const logsDir = join(options.bookRoot, '.ops/session_logs');
                    await mkdir(logsDir, { recursive: true });
                    await writeFile(
                        join(logsDir, `${sessionIdStr}.json`),
                        `${JSON.stringify(sessionDetail, null, 2)}\n`,
                        'utf8'
                    );
                } catch {
                    // 会话日志落盘失败不阻断业务主流程
                }
            }
            if (handle) {
                this.activeHandles.delete(handle);
                await handle.dispose().catch(() => {});
            }
            toolset?.cleanup();
            this.storeService.endRun(runId);
        }
    }

    /**
     * 执行净室单轮调用 (cleanroom: true，如 Writer / Patch)：
     * - 严禁携带 tools 或 sessionId；
     * - 从外部化角色配置读取池路由、温度与系统提示词；
     * - 根据 book_config.yaml 的 trace_level 写入 .ops/traces/<runId>/。
     */
    async runCleanroom(options: RunCleanroomOptions): Promise<{
        response: CleanroomResponse;
        roleConfig: LoadedRoleConfig;
    }> {
        const roleId = options.roleId ?? 'writer';
        const roleCfg = await this.roleLoader.loadRoleConfig(roleId, options.bookRoot);

        const req: CleanroomRequest = {
            pool: options.request.pool ?? roleCfg.pool,
            staticPrefixBlocks: options.request.staticPrefixBlocks,
            dynamicTail: options.request.dynamicTail,
            temperature: options.request.temperature ?? roleCfg.temperature,
            ...(options.request.reasoningEffort !== undefined
                ? { reasoningEffort: options.request.reasoningEffort }
                : roleCfg.reasoningEffort !== undefined
                  ? { reasoningEffort: roleCfg.reasoningEffort }
                  : {}),
            ...(options.request.maxTokens !== undefined
                ? { maxTokens: options.request.maxTokens }
                : {}),
            ...(options.request.traceStage !== undefined
                ? { traceStage: options.request.traceStage }
                : { traceStage: roleId })
        };

        const response = await generateTraced(this.llmAdapter, req, options.signal);
        return {
            response,
            roleConfig: roleCfg
        };
    }
}

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    generateTraced,
    type ApplyStatePatchOptions,
    type BookConfig,
    type CleanroomRequest,
    type CleanroomResponse,
    type EntityProfile,
    type NarrationSubjectivity,
    type NarrateStoreService,
    type TimelineMode,
    type TokenUsage
} from '@narrateos/dsh-book-store';
import type { BuiltRoleToolSet, NarrateToolsService } from '@narrateos/dsh-book-tools';
import { addUsage, createEmptyUsage } from '../pipeline/helpers.js';
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
import {
    DshLlmAdapter,
    resolveCompatibleReasoningEffort,
    resolvePoolRoute
} from './dsh-llm-adapter.js';

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'narrateos-pipeline': {
            kind: 'narrateos-pipeline';
        };
    }
}

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
    chapterNumberForTools?: number | undefined;
    timelineMode?: TimelineMode | undefined;
    allowInnateMutation?: boolean | undefined;
    deferCommit?: boolean | undefined;
    applyOptions?: ApplyStatePatchOptions | undefined;
    visibleEntities?: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile> | undefined;
    reachableIds?: ReadonlySet<string> | readonly string[] | undefined;
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
    usage: TokenUsage;
}

/** 净室单轮执行选项 */
export interface RunCleanroomOptions {
    roleId?: string | undefined;
    bookRoot: string;
    bookConfig?: BookConfig | undefined;
    chapterNumber?: number | undefined;
    request: Omit<CleanroomRequest, 'pool'> & { pool?: CleanroomRequest['pool'] | undefined };
    signal?: AbortSignal | undefined;
    onStageSession?: ((event: StageSessionEvent) => void) | undefined;
    onStageEvent?: ((event: StageStreamSseEvent) => void) | undefined;
}

const MAX_AGENT_MALFORMED_RETRIES = 2;

function isAgentInstructionsMessage(msg: unknown): boolean {
    if (typeof msg !== 'object' || msg === null) return false;
    const source = (msg as { source?: unknown }).source;
    return (
        typeof source === 'object' &&
        source !== null &&
        (source as { kind?: unknown }).kind === 'agent-instructions'
    );
}

async function waitRetryBackoff(delayMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, delayMs);
        function onAbort() {
            clearTimeout(timer);
            resolve(false);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
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
 * 通用双模式受控角色执行器（统一基于 ctx.agents.create）：
 * - 多轮探查工种 (`cleanroom: false`)：挂载受控工具白名单与 yield_* 防逃逸 Hook；
 * - 净室单轮工种 (`cleanroom: true`)：零工具、无 yield_*，直接提取单轮文本输出传给下游；
 * - 全工种统一在最外层 agent/pre-step 过滤宿主 agent-instructions (AGENTS.md)，并统一补齐 MALFORMED_RESPONSE 重试与会话归档。
 */
export class RoleRunner {
    private execCtx: Context;
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
        this.execCtx = deps.ctx;
        this.storeService = deps.storeService;
        this.toolsService = deps.toolsService;
        this.roleLoader = deps.roleLoader;
        this.llmAdapter = deps.llmAdapter;
        this.poolRouting = deps.poolRouting;
        this.defaultOnStageEvent = deps.onStageEvent;
    }

    /** 绑定独立的 Cordis 子执行上下文（隔离 session/event 监听与 agents.create 作用域） */
    setExecutionContext(execCtx: Context): void {
        this.execCtx = execCtx;
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
        const roleCfg = await this.roleLoader.loadRoleConfig(options.roleId, options.bookRoot);
        if (roleCfg.cleanroom) {
            throw new Error(`工种 ${options.roleId} 配置为 cleanroom=true，请改用 runCleanroom 净室路径`);
        }
        const sessionRes = await this.runAgentSession<TYield>({
            mode: 'multi-turn',
            roleCfg,
            roleId: options.roleId,
            stage: options.stage,
            bookRoot: options.bookRoot,
            bookConfig: options.bookConfig,
            chapterNumber: options.chapterNumber,
            taskPromptBlocks: [options.taskPrompt],
            runId: options.runId,
            sessionId: options.sessionId,
            parentSessionId: options.parentSessionId,
            agentMode: options.mode,
            maxTokens: options.maxTokens,
            allowedOpsPaths: options.allowedOpsPaths,
            allowedOpsWritePaths: options.allowedOpsWritePaths,
            targetChapter: options.targetChapter,
            targetDay: options.targetDay,
            chapterGoal: options.chapterGoal,
            draftText: options.draftText,
            draftPath: options.draftPath,
            timelineMode: options.timelineMode,
            allowInnateMutation: options.allowInnateMutation,
            deferCommit: options.deferCommit,
            applyOptions: options.applyOptions,
            visibleEntities: options.visibleEntities,
            reachableIds: options.reachableIds,
            narrationSubjectivity: options.narrationSubjectivity,
            signal: options.signal,
            onStageSession: options.onStageSession,
            onStageEvent: options.onStageEvent
        });
        return {
            runId: sessionRes.runId,
            sessionId: sessionRes.sessionId,
            roleConfig: sessionRes.roleConfig,
            yieldResult: sessionRes.yieldResult as TYield,
            usage: sessionRes.usage
        };
    }

    private async runAgentSession<TYield>(params: {
        mode: 'multi-turn' | 'cleanroom';
        roleCfg: LoadedRoleConfig;
        roleId: string;
        stage: string;
        bookRoot: string;
        bookConfig?: BookConfig | undefined;
        chapterNumber?: number | undefined;
        taskPromptBlocks: string[];
        poolOverride?: CleanroomRequest['pool'] | undefined;
        temperatureOverride?: number | undefined;
        reasoningEffortOverride?: LoadedRoleConfig['reasoningEffort'] | undefined;
        runId?: string | undefined;
        sessionId?: string | undefined;
        parentSessionId?: string | undefined;
        agentMode?: string | undefined;
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
        visibleEntities?: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile> | undefined;
        reachableIds?: ReadonlySet<string> | readonly string[] | undefined;
        narrationSubjectivity?: NarrationSubjectivity | undefined;
        signal?: AbortSignal | undefined;
        onStageSession?: ((event: StageSessionEvent) => void) | undefined;
        onStageEvent?: ((event: StageStreamSseEvent) => void) | undefined;
    }): Promise<{
        runId: string;
        sessionId: string;
        roleConfig: LoadedRoleConfig;
        yieldResult: TYield | undefined;
        assistantText: string;
        reasoningText: string;
        usage: TokenUsage;
        modelId: string;
    }> {
        if (params.signal?.aborted) {
            throw params.signal.reason instanceof Error
                ? params.signal.reason
                : new Error('Aborted');
        }

        const roleCfg = params.roleCfg;
        const isCleanroom = params.mode === 'cleanroom';
        const runId = params.runId ?? randomUUID();
        const sessionIdStr = params.sessionId ?? `narrate-${params.roleId}-${runId}`;
        const sessionId = SessionId(sessionIdStr);
        const chapter = params.chapterNumber ?? 0;
        const startedAt = new Date().toISOString();

        this.storeService.beginRun(runId);

        let toolset: BuiltRoleToolSet | undefined;
        let handle: AgentHandle | undefined;
        let abortCleanup: (() => void) | undefined;

        const sessionDetail: StageSessionDetail = {
            sessionId: sessionIdStr,
            runId,
            stage: params.stage,
            role: params.roleId,
            chapter,
            status: 'running',
            ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
            ...(params.agentMode ? { mode: params.agentMode } : {}),
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
                const emitter = params.onStageEvent ?? this.defaultOnStageEvent;
                emitter?.({
                    sessionId: sessionIdStr,
                    stage: params.stage,
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
        let lastAgentError: Error | undefined;
        let latestAssistantText = '';
        let latestReasoningText = '';
        let malformedRetries = 0;
        const multiTurnUsage = createEmptyUsage();
        const route = resolvePoolRoute(
            this.poolRouting,
            params.poolOverride ?? roleCfg.pool,
            params.bookConfig
        );

        try {
            if (!isCleanroom) {
                const allowedOpsPaths =
                    params.allowedOpsPaths ??
                    (roleCfg.allowedOpsRead.length > 0 ? roleCfg.allowedOpsRead : undefined);
                const allowedOpsWritePaths =
                    params.allowedOpsWritePaths ??
                    (roleCfg.allowedOpsWrite.length > 0 ? roleCfg.allowedOpsWrite : undefined);

                toolset = this.toolsService.buildRoleTools({
                    runId,
                    bookRoot: params.bookRoot,
                    maxReadCalls: roleCfg.maxReadCalls,
                    tools: roleCfg.tools,
                    yieldTool: roleCfg.yieldTool ?? undefined,
                    allowedOpsPaths,
                    allowedOpsWritePaths,
                    targetChapter: params.targetChapter,
                    targetDay: params.targetDay,
                    chapterGoal: params.chapterGoal,
                    draftText: params.draftText,
                    draftPath: params.draftPath,
                    chapterNumber: params.chapterNumber,
                    timelineMode: params.timelineMode,
                    allowInnateMutation: params.allowInnateMutation,
                    deferCommit: params.deferCommit,
                    applyOptions: params.applyOptions,
                    visibleEntities: params.visibleEntities,
                    reachableIds: params.reachableIds,
                    narrationSubjectivity: params.narrationSubjectivity
                });
            }

            await appendExtendedRunRecord(params.bookRoot, {
                runId,
                chapter,
                stage: params.stage,
                role: params.roleId,
                sessionId: sessionIdStr,
                status: 'running',
                startedAt,
                ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
                ...(params.agentMode ? { mode: params.agentMode } : {})
            });

            try {
                params.onStageSession?.({
                    stage: params.stage,
                    role: params.roleId,
                    chapter,
                    runId,
                    sessionId: sessionIdStr,
                    ...(params.parentSessionId
                        ? { parentSessionId: params.parentSessionId }
                        : {}),
                    ...(params.agentMode ? { mode: params.agentMode } : {})
                });
            } catch {
                // 避免 SSE 回调异常中断执行
            }

            // 监听本 sessionId 的 assistant/message 汇总多轮 Token 用量；
            // 工具调用真相源统一由下方的 observedTool 捕获，避免与 tool-call-delta / session/event 三重重复。
            if (typeof this.execCtx.on === 'function') {
                disposeSessionEventListener = this.execCtx.on('session/event', (session, ev) => {
                    if (String(session.id) !== sessionIdStr) return;
                    if (ev.type === 'assistant/message') {
                        const msgUsage = (ev.data as { usage?: Partial<TokenUsage> } | undefined)
                            ?.usage;
                        if (msgUsage) {
                            addUsage(multiTurnUsage, {
                                inputTokens: msgUsage.inputTokens ?? 0,
                                cacheReadTokens: msgUsage.cacheReadTokens ?? 0,
                                cacheWriteTokens: msgUsage.cacheWriteTokens ?? 0,
                                outputTokens: msgUsage.outputTokens ?? 0
                            });
                        }
                    }
                });
            }

            const requestedEffort = params.reasoningEffortOverride ?? roleCfg.reasoningEffort;
            const compatibleEffort = await resolveCompatibleReasoningEffort(
                this.execCtx.llm,
                route.provider,
                route.model,
                requestedEffort,
                params.signal
            );
            const builtToolset = toolset;
            const effectiveTemperature = params.temperatureOverride ?? roleCfg.temperature;

            handle = await this.execCtx.agents.create({
                sessionId,
                meta: {
                    cwd: params.bookRoot
                },
                agentOptions: {
                    provider: route.provider,
                    model: route.model,
                    ...(compatibleEffort !== undefined ? { reasoningEffort: compatibleEffort } : {}),
                    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {})
                },
                ...(params.signal !== undefined ? { signal: params.signal } : {}),
                setup: (agentCtx) => {
                    // 屏蔽宿主全局工具；净室工种零工具，多轮工种仅注册受控白名单工具
                    if (agentCtx.tools) {
                        agentCtx.tools.restrict({ allow: [] });
                        if (builtToolset) {
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
                    }

                    // 挂载外部化角色系统提示词（complete: true 独立隔离，interpolate: false 保留原文花括号）
                    if (agentCtx.systemPrompt) {
                        agentCtx.systemPrompt.section({
                            name: 'narrateos-role',
                            order: 0,
                            text: roleCfg.promptText,
                            interpolate: false,
                            complete: true
                        });
                    }

                    // 置于最外层过滤宿主 dsh-agent-instructions 注入的 AGENTS.md / CLAUDE.md，确保全工种净室隔离
                    const registerPrependOn = agentCtx.on as unknown as (
                        event: 'agent/pre-step',
                        listener: (
                            payload: unknown,
                            next: () => Promise<{ kind: string; messages?: unknown[] }>
                        ) => Promise<{ kind: string; messages?: unknown[] }>,
                        options?: { prepend?: boolean }
                    ) => unknown;
                    registerPrependOn(
                        'agent/pre-step',
                        async (_payload, next) => {
                            const decision = await next();
                            if (decision.kind === 'reject' || !Array.isArray(decision.messages)) {
                                return decision;
                            }
                            return {
                                ...decision,
                                messages: decision.messages.filter(
                                    (msg) => !isAgentInstructionsMessage(msg)
                                )
                            };
                        },
                        { prepend: true }
                    );

                    // 透传外部化角色配置的采样温度，并在每次新发起 LLM 请求时重置当前轮次输出缓冲
                    agentCtx.on('agent/request', async (_payload, next) => {
                        latestAssistantText = '';
                        latestReasoningText = '';
                        const base = await next();
                        return {
                            ...base,
                            temperature: effectiveTemperature
                        };
                    });

                    // 补齐 MALFORMED_RESPONSE（例如上游重复 message_start）指数退避重试
                    agentCtx.on('agent/request-error', async (payload, next) => {
                        const upstream = await next();
                        if (upstream?.kind === 'retry') {
                            return upstream;
                        }
                        if (
                            payload.failure.code === 'MALFORMED_RESPONSE' &&
                            malformedRetries < MAX_AGENT_MALFORMED_RETRIES
                        ) {
                            const delayMs = 500 * 2 ** malformedRetries;
                            malformedRetries += 1;
                            const ok = await waitRetryBackoff(delayMs, payload.signal);
                            if (ok) {
                                return { kind: 'retry' };
                            }
                        }
                        return upstream;
                    });

                    // 订阅实时思考/文本流与状态变更，透传给 SSE stage:event（工具调用统一由 observedTool 记录）
                    agentCtx.on('agent/assistant-stream', ({ frame }) => {
                        if (frame.type !== 'chunk') return;
                        const ts = new Date().toISOString();
                        if (frame.chunk.type === 'reasoning-delta') {
                            latestReasoningText += frame.chunk.text;
                            recordSessionEvent({
                                timestamp: ts,
                                kind: 'thinking',
                                text: frame.chunk.text
                            });
                        } else if (frame.chunk.type === 'text-delta') {
                            latestAssistantText += frame.chunk.text;
                            recordSessionEvent({
                                timestamp: ts,
                                kind: 'text',
                                text: frame.chunk.text
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
                        const normalized =
                            error instanceof Error ? error : new Error(String(error));
                        lastAgentError = normalized;
                        recordSessionEvent({
                            timestamp: new Date().toISOString(),
                            kind: 'error',
                            text: normalized.message,
                            status: 'error'
                        });
                    });

                    // 多轮工种挂载防纯文本逃逸终态门禁 Hook
                    if (!isCleanroom && roleCfg.yieldTool && builtToolset) {
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

            if (params.signal) {
                const liveHandle = handle;
                const onAbort = () => {
                    try {
                        liveHandle.agent.cancel({ kind: 'parent' });
                    } catch {
                        // 忽略已关闭句柄
                    }
                };
                if (params.signal.aborted) {
                    onAbort();
                } else {
                    params.signal.addEventListener('abort', onAbort, { once: true });
                    abortCleanup = () => params.signal?.removeEventListener('abort', onAbort);
                }
            }

            const contentBlocks = params.taskPromptBlocks
                .filter((text) => text.length > 0)
                .map((text) => ({ type: 'text' as const, text }));
            const promptMsg = createUserMessage({
                content:
                    contentBlocks.length > 0 ? contentBlocks : [{ type: 'text' as const, text: '' }],
                source: { kind: 'narrateos-pipeline' }
            });
            handle.agent.followup(promptMsg);

            await handle.agent.whenIdle();

            if (params.signal?.aborted) {
                throw params.signal.reason instanceof Error
                    ? params.signal.reason
                    : new Error('Aborted');
            }

            if (lastAgentError && (isCleanroom || !roleCfg.yieldTool || !toolset?.hasYielded())) {
                throw lastAgentError;
            }

            if (!isCleanroom && roleCfg.yieldTool && !toolset?.hasYielded()) {
                throw new Error(
                    `工种 ${params.roleId} 未调用终态门禁工具 ${roleCfg.yieldTool} 即结束运行 (maxSteps=${roleCfg.maxSteps})`
                );
            }

            const yieldResult = !isCleanroom ? toolset?.getYieldResult<TYield>() : undefined;
            if (!isCleanroom && roleCfg.yieldTool && yieldResult === undefined) {
                throw new Error(
                    `工种 ${params.roleId} 调用 ${roleCfg.yieldTool} 后未产出有效结构化结果`
                );
            }

            sessionDetail.status = 'completed';
            await appendExtendedRunRecord(params.bookRoot, {
                runId,
                chapter,
                stage: params.stage,
                role: params.roleId,
                sessionId: sessionIdStr,
                status: 'completed',
                startedAt,
                finishedAt: new Date().toISOString(),
                ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
                ...(params.agentMode ? { mode: params.agentMode } : {})
            });

            return {
                runId,
                sessionId: sessionIdStr,
                roleConfig: roleCfg,
                yieldResult,
                assistantText: latestAssistantText,
                reasoningText: latestReasoningText,
                usage: multiTurnUsage,
                modelId: `${route.provider}:${route.model}`
            };
        } catch (err: unknown) {
            sessionDetail.status = 'failed';
            recordSessionEvent({
                timestamp: new Date().toISOString(),
                kind: 'error',
                text: err instanceof Error ? err.message : String(err),
                status: 'failed'
            });
            await appendExtendedRunRecord(params.bookRoot, {
                runId,
                chapter,
                stage: params.stage,
                role: params.roleId,
                sessionId: sessionIdStr,
                status: 'failed',
                startedAt,
                finishedAt: new Date().toISOString(),
                error: err instanceof Error ? err.message : String(err),
                ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
                ...(params.agentMode ? { mode: params.agentMode } : {})
            }).catch(() => {});
            throw err;
        } finally {
            disposeSessionEventListener?.();
            abortCleanup?.();
            sessionDetail.live = false;
            if (SESSION_ID_SAFE_RE.test(sessionIdStr)) {
                try {
                    const logsDir = join(params.bookRoot, '.ops/session_logs');
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
     * - 零工具、无 yield_*，直接将单轮文本输出传给下游；
     * - 优先通过 ctx.agents.create 创建原生 DSH 会话（支持 Studio Conversation/Trajectory 查看、
     *   agent-instructions 隔离与 MALFORMED_RESPONSE 重试），同时通过 generateTraced 写入 .ops/traces/<runId>/；
     * - 若运行环境未注入 ctx.agents.create（极简单元测试），安全回退到 DshLlmAdapter 直调。
     */
    async runCleanroom(options: RunCleanroomOptions): Promise<{
        response: CleanroomResponse;
        roleConfig: LoadedRoleConfig;
        runId?: string | undefined;
        sessionId?: string | undefined;
    }> {
        const roleId = options.roleId ?? 'writer';
        const roleCfg = await this.roleLoader.loadRoleConfig(roleId, options.bookRoot);
        if (!roleCfg.cleanroom) {
            throw new Error(`工种 ${roleId} 配置为 cleanroom=false，禁止走净室单轮路径`);
        }
        if (roleCfg.tools.length > 0 || roleCfg.yieldTool !== null) {
            throw new Error(`净室工种 ${roleId} 禁止配置 tools 或 yield_tool`);
        }

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

        if (typeof this.execCtx.agents?.create !== 'function') {
            const response = await generateTraced(this.llmAdapter, req, options.signal);
            return {
                response,
                roleConfig: roleCfg
            };
        }

        const stageName = (req.traceStage ?? roleId).toUpperCase();
        let capturedRunId: string | undefined;
        let capturedSessionId: string | undefined;
        const taskPromptBlocks = [
            ...req.staticPrefixBlocks.filter((block) => block.length > 0),
            req.dynamicTail
        ].filter((block) => block.length > 0);

        const response = await generateTraced(
            {
                generate: async (_tracedReq, signal) => {
                    const execPromise = this.runAgentSession<never>({
                        mode: 'cleanroom',
                        roleCfg,
                        roleId,
                        stage: stageName === 'PATCH' ? 'LOCAL_PATCH' : stageName,
                        bookRoot: options.bookRoot,
                        bookConfig: options.bookConfig,
                        chapterNumber: options.chapterNumber,
                        taskPromptBlocks,
                        poolOverride: req.pool,
                        temperatureOverride: req.temperature,
                        reasoningEffortOverride: req.reasoningEffort,
                        maxTokens: req.maxTokens,
                        signal: signal ?? options.signal,
                        onStageSession: options.onStageSession,
                        onStageEvent: options.onStageEvent
                    });
                    this.activePromises.add(execPromise);
                    let sessionRes: Awaited<typeof execPromise>;
                    try {
                        sessionRes = await execPromise;
                    } finally {
                        this.activePromises.delete(execPromise);
                    }
                    capturedRunId = sessionRes.runId;
                    capturedSessionId = sessionRes.sessionId;
                    if (!sessionRes.assistantText.trim()) {
                        throw new Error(`净室工种 ${roleId} 未输出有效正文文本`);
                    }
                    return {
                        text: sessionRes.assistantText,
                        usage: sessionRes.usage,
                        modelId: sessionRes.modelId,
                        finishReason: 'stop'
                    };
                }
            },
            req,
            options.signal
        );

        return {
            response,
            roleConfig: roleCfg,
            runId: capturedRunId,
            sessionId: capturedSessionId
        };
    }
}

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import {
    BookStore,
    BookSwitchConflictError,
    NodeSystemAdapter,
    TxLockConflictError,
    TxLockPayloadSchema,
    type BookConfig,
    type ForkParallelWindowOptions,
    type MergeParallelWindowOptions,
    type NarrateStoreService,
    type RunRecord,
    type SystemPort
} from '@narrateos/dsh-book-store';
import type {
    BootBundleOutput,
    LockCharterAndBootInput,
    LockCharterAndBootResult,
    NarrateToolsService
} from '@narrateos/dsh-book-tools';
import {
    AdmissionClosedError,
    PathValidationError,
    SafeHaltError,
    TaskConflictError
} from '../errors.js';
import { ChapterPipeline } from '../pipeline/chapter-pipeline.js';
import { DreamingPipeline } from '../pipeline/dreaming-pipeline.js';
import {
    CHAPTER_FILE_RE,
    readOptionalText,
    readSignalsCursor,
    writeSignalsCursor
} from '../pipeline/helpers.js';
import { SyncPipeline } from '../pipeline/sync-pipeline.js';
import { harvestVoiceFromChapter } from '../pipeline/voice-harvest.js';
import { VolumePipeline } from '../pipeline/volume-pipeline.js';
import { RoleLoader } from '../roles/role-loader.js';
import { DshLlmAdapter } from '../runner/dsh-llm-adapter.js';
import { RoleRunner } from '../runner/role-runner.js';
import {
    ExtendedRunRecordSchema,
    OpsSignalSchema,
    type AdvanceVolumeOptions,
    type AdvanceVolumeResult,
    type ExtendedRunRecord,
    type HealConflictsOptions,
    type HealConflictsResult,
    type LlmPoolRouting,
    type OpsSignal,
    type RunDreamingOptions,
    type RunDreamingResult,
    type RuntimeTaskKind,
    type StageSessionDetail,
    type StageSessionEvent,
    type StageSessionEventItem,
    type StepChapterOptions,
    type StepChapterResult,
    type SuspectedConflict,
    type SyncManuscriptsOptions,
    type SyncManuscriptsResult,
    type VoiceHarvestResult,
    type YoloRuntimeState
} from '../schemas.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
export const DEFAULT_YOLO_GOAL = '按既定主线与人物弧光自然推进下一章';

export interface NarrateControllerConfig {
    bookRoot?: string | undefined;
    booksRoot?: string | undefined;
    presetRoot?: string | undefined;
    poolRouting: LlmPoolRouting;
    heartbeatIntervalMs?: number | undefined;
    shutdownTimeoutMs?: number | undefined;
    pluginSearchDirs?: string[] | undefined;
}

export interface BootFromModalPayload {
    slug: string;
    title: string;
    povCharacter: string;
    mode: 'original' | 'fanfic';
    premiseOrSeed?: string | undefined;
    sourceMaterial?: string | undefined;
    t0Anchor?: string | undefined;
}

function parseJsonLines(raw: string | null): unknown[] {
    if (raw === null) return [];
    const results: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
            results.push(JSON.parse(trimmed));
        } catch {
            results.push({ raw: trimmed });
        }
    }
    return results;
}

function extractToolResultTextPreview(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const block of content) {
        if (
            block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
        ) {
            parts.push((block as { text: string }).text);
        }
    }
    if (parts.length === 0) return undefined;
    return parts.join('\n').slice(0, 800);
}

/** 将 DSH SessionEvent[] (tool/call, tool/result 等) 映射为 StageSessionEventItem[] */
export function mapRawSessionEventsToItems(
    rawEvents: readonly unknown[],
    fallbackTimestamp: string
): StageSessionEventItem[] {
    const items: StageSessionEventItem[] = [];
    const callNameById = new Map<string, string>();

    rawEvents.forEach((ev, idx) => {
        if (!ev || typeof ev !== 'object') return;
        const rec = ev as {
            seq?: unknown;
            type?: unknown;
            timestamp?: unknown;
            data?: Record<string, unknown>;
        };
        const seq = typeof rec.seq === 'number' ? rec.seq : idx;
        const ts =
            typeof rec.timestamp === 'string' && rec.timestamp.length > 0
                ? rec.timestamp
                : fallbackTimestamp;

        if (rec.type === 'tool/call') {
            const callId = String(rec.data?.['callId'] ?? '');
            const toolName = String(rec.data?.['name'] ?? '');
            if (callId && toolName) {
                callNameById.set(callId, toolName);
            }
            items.push({
                seq,
                timestamp: ts,
                kind: 'tool-call',
                toolName,
                callId,
                text:
                    typeof rec.data?.['arguments'] === 'string'
                        ? rec.data['arguments']
                        : ''
            });
        } else if (rec.type === 'tool/result') {
            const msg = rec.data?.['message'] as Record<string, unknown> | undefined;
            const callId = String(msg?.['toolCallId'] ?? rec.data?.['callId'] ?? '');
            const isError = Boolean(msg?.['isError'] ?? rec.data?.['isError']);
            const toolName = callNameById.get(callId) ?? String(rec.data?.['name'] ?? '');
            const preview = extractToolResultTextPreview(msg?.['content']);
            items.push({
                seq,
                timestamp: ts,
                kind: 'tool-result',
                toolName,
                callId,
                ...(preview !== undefined ? { text: preview } : {}),
                status: isError ? 'error' : 'completed'
            });
        }
    });

    return items;
}

export function isSubPath(parentDir: string, candidatePath: string): boolean {
    const parent = resolve(parentDir);
    const target = resolve(candidatePath);
    const rel = relative(parent, target);
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

export async function isValidBookDirectory(dirPath: string): Promise<boolean> {
    try {
        await readFile(join(dirPath, 'world/book_config.yaml'), 'utf8');
        return true;
    } catch {
        try {
            await readFile(join(dirPath, '.ops/tx_state.json'), 'utf8');
            return true;
        } catch {
            return false;
        }
    }
}

export function resolveStatusModelRouting(
    poolRouting: LlmPoolRouting,
    configured?: Record<string, string>
): Record<string, string> {
    const routing: Record<string, string> = {};
    if (configured) {
        for (const [key, value] of Object.entries(configured)) {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
                routing[key] = trimmed;
            }
        }
    }
    for (const [pool, target] of Object.entries(poolRouting)) {
        if (!routing[pool]) {
            routing[pool] = target.model;
        }
    }
    return routing;
}

/**
 * NarrateOS 管线运行态总控器 (ctx.narratePipeline)：
 * - 管理准入闸门、排他任务锁、YOLO 连跑、单章推进、Sync、Dreaming、自愈、换卷与切书；
 * - 持有 RoleLoader、DshLlmAdapter 与双路径 RoleRunner，支持单书 roles/*.yml 热覆盖；
 * - 广播携带 activeSessionId / sessionId / runId 的 SSE 实时事件流，并支持有序排空停机。
 */
export class NarrateRuntimeController {
    public readonly ctx: Context;
    public readonly storeService: NarrateStoreService;
    public readonly toolsService: NarrateToolsService;
    public readonly system: SystemPort;
    public readonly roleLoader: RoleLoader;
    public readonly llmAdapter: DshLlmAdapter;
    public readonly roleRunner: RoleRunner;
    public readonly poolRouting: LlmPoolRouting;
    public readonly booksRoot: string;

    private readonly defaultBookRoot: string | null;
    private readonly pluginSearchDirs: string[];
    private readonly shutdownTimeoutMs: number;
    private readonly sseClients = new Set<ServerResponse>();
    private readonly backgroundPromises = new Set<Promise<unknown>>();
    private readonly activeStageSessions = new Map<string, StageSessionEvent>();

    private activeTask: RuntimeTaskKind = 'IDLE';
    private haltRequested = false;
    private shuttingDown = false;
    private activeAbortController: AbortController | null = null;
    private activePromise: Promise<unknown> | null = null;
    private telemetryOffsetLines = 0;
    private signalsConsumedLines = 0;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    private readonly yoloState: YoloRuntimeState = {
        running: false,
        stopRequested: false,
        completedChapters: 0,
        targetChapters: 0,
        currentStage: null,
        loopPromise: null
    };

    constructor(
        ctx: Context,
        storeService: NarrateStoreService,
        toolsService: NarrateToolsService,
        config: NarrateControllerConfig
    ) {
        this.ctx = ctx;
        this.storeService = storeService;
        this.toolsService = toolsService;
        this.system = storeService.system ?? new NodeSystemAdapter();
        this.poolRouting = config.poolRouting;
        this.defaultBookRoot =
            config.bookRoot && config.bookRoot.trim().length > 0
                ? resolve(config.bookRoot)
                : null;
        this.booksRoot = resolve(
            config.booksRoot ?? storeService.booksRoot ?? toolsService.booksRoot ?? './books'
        );
        this.pluginSearchDirs = config.pluginSearchDirs ?? [];
        this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.roleLoader = new RoleLoader(config.presetRoot);

        this.llmAdapter = new DshLlmAdapter(ctx.llm, {
            poolRouting: config.poolRouting,
            resolveModelRouting: async () => {
                if (!this.bookRoot) return undefined;
                try {
                    const bookCfg = await this.storeService.openStore(this.bookRoot).readBookConfig();
                    return bookCfg.model_routing;
                } catch {
                    return undefined;
                }
            }
        });

        this.roleRunner = new RoleRunner({
            ctx,
            storeService,
            toolsService,
            roleLoader: this.roleLoader,
            llmAdapter: this.llmAdapter,
            poolRouting: config.poolRouting,
            onStageEvent: (evt) => {
                this.emitEvent('stage:event', evt);
            }
        });

        const heartbeatMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        if (heartbeatMs > 0) {
            this.heartbeatTimer = setInterval(() => {
                this.sendHeartbeat();
            }, heartbeatMs);
            this.heartbeatTimer.unref?.();
        }
    }

    /** 当前激活作品目录（未选书时为 null） */
    get bookRoot(): string | null {
        return this.storeService.bookRoot ?? this.defaultBookRoot;
    }

    /** 准入闸门是否已关闭（包含 Cordis Fiber 卸载态 5/uid=null 的同步检测） */
    get isAdmissionClosed(): boolean {
        const fiber = (this.ctx as { fiber?: { uid?: number | null; state?: number } }).fiber;
        return this.shuttingDown || fiber?.uid === null || fiber?.state === 5;
    }

    /** 当前运行态摘要 */
    get runtimeStatus(): {
        activeTask: RuntimeTaskKind;
        haltRequested: boolean;
        shuttingDown: boolean;
        yolo: Omit<YoloRuntimeState, 'loopPromise'>;
    } {
        return {
            activeTask: this.activeTask,
            haltRequested: this.haltRequested,
            shuttingDown: this.shuttingDown,
            yolo: {
                running: this.yoloState.running,
                stopRequested: this.yoloState.stopRequested,
                completedChapters: this.yoloState.completedChapters,
                targetChapters: this.yoloState.targetChapters,
                currentStage: this.yoloState.currentStage
            }
        };
    }

    /** 要求当前已选定有效作品目录 */
    requireBookStore(): BookStore {
        return this.storeService.openStore(this.bookRoot ?? undefined);
    }

    /** 校验准入闸门未关闭 */
    assertAdmissionOpen(): void {
        if (this.isAdmissionClosed) {
            throw new AdmissionClosedError();
        }
    }

    /** 记录并发起背景异步任务（用于斜杠命令非阻塞触发并在停机时等待排空） */
    trackBackgroundTask<T>(task: Promise<T>): Promise<T> {
        const tracked = task.finally(() => {
            this.backgroundPromises.delete(tracked);
        });
        this.backgroundPromises.add(tracked);
        return tracked;
    }

    /** 注册 SSE 客户端 */
    addSseClient(res: ServerResponse): void {
        this.sseClients.add(res);
    }

    /** 移除 SSE 客户端 */
    removeSseClient(res: ServerResponse): void {
        this.sseClients.delete(res);
    }

    private sendHeartbeat(): void {
        for (const client of this.sseClients) {
            if (client.writableEnded || client.destroyed) {
                this.sseClients.delete(client);
                continue;
            }
            try {
                client.write(': ping\n\n');
            } catch {
                this.sseClients.delete(client);
            }
        }
    }

    /** 向所有已连接 SSE 客户端广播事件 */
    emitEvent(eventName: string, data: unknown): void {
        const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of this.sseClients) {
            if (client.writableEnded || client.destroyed) {
                this.sseClients.delete(client);
                continue;
            }
            try {
                client.write(frame);
            } catch {
                this.sseClients.delete(client);
            }
        }
    }

    /** 读取 .ops/telemetry.jsonl 新增行并推送 SSE telemetry 事件 */
    async flushTelemetryEvents(): Promise<void> {
        const bookRoot = this.bookRoot;
        if (!bookRoot) return;
        const raw = await readOptionalText(join(bookRoot, '.ops/telemetry.jsonl'));
        if (raw === null) return;

        const lines = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        if (lines.length < this.telemetryOffsetLines) {
            this.telemetryOffsetLines = 0;
        }
        if (lines.length === this.telemetryOffsetLines) {
            return;
        }

        const newLines = lines.slice(this.telemetryOffsetLines);
        this.telemetryOffsetLines = lines.length;

        for (const line of newLines) {
            try {
                this.emitEvent('telemetry', JSON.parse(line));
            } catch {
                this.emitEvent('telemetry', { raw: line });
            }
        }
    }

    /** 统计 .ops/signals.jsonl 未消费信号条数 */
    async countPendingSignals(): Promise<number> {
        const bookRoot = this.bookRoot;
        if (!bookRoot) return 0;
        const raw = await readOptionalText(join(bookRoot, '.ops/signals.jsonl'));
        const all = parseJsonLines(raw);
        let cursor = await readSignalsCursor(bookRoot);
        if (all.length < cursor) {
            cursor = 0;
            await writeSignalsCursor(bookRoot, 0);
        }
        this.signalsConsumedLines = cursor;
        return all.length - cursor;
    }

    private async consumePendingSignals(): Promise<unknown[]> {
        const bookRoot = this.bookRoot;
        if (!bookRoot) return [];
        const raw = await readOptionalText(join(bookRoot, '.ops/signals.jsonl'));
        const all = parseJsonLines(raw);
        let cursor = await readSignalsCursor(bookRoot);
        if (all.length < cursor) {
            cursor = 0;
        }
        const pending = all.slice(cursor);
        this.signalsConsumedLines = all.length;
        await writeSignalsCursor(bookRoot, all.length);
        return pending;
    }

    private async switchBookInternal(nextBookRoot: string): Promise<BookStore> {
        const switched = await this.storeService.switchBook(nextBookRoot);
        this.telemetryOffsetLines = 0;
        this.signalsConsumedLines = await readSignalsCursor(switched.bookRoot);
        this.activeStageSessions.clear();

        this.emitEvent('book_switched', {
            bookRoot: switched.bookRoot,
            timestamp: new Date().toISOString()
        });
        return switched;
    }

    /** 安全切换当前激活作品（在途任务或事务锁未排空时返回 409 BookSwitchConflictError） */
    async switchBook(nextBookRoot: string): Promise<BookStore> {
        this.assertAdmissionOpen();
        if (this.activeTask !== 'IDLE' || this.yoloState.running) {
            throw new BookSwitchConflictError(
                `当前正在执行任务 (${this.activeTask})，拒绝切换作品`
            );
        }
        return await this.runExclusiveTask('SYNCING', () => this.switchBookInternal(nextBookRoot));
    }

    /** 读取工种运行会话索引 (.ops/runs.jsonl，保留扩展字段 parentSessionId 与 mode) */
    async listRunRecords(chapter?: number): Promise<ExtendedRunRecord[]> {
        const store = this.requireBookStore();
        const raw = await readOptionalText(join(store.bookRoot, '.ops/runs.jsonl'));
        if (raw === null) {
            return [];
        }
        const records: ExtendedRunRecord[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
                const parsed = ExtendedRunRecordSchema.parse(JSON.parse(trimmed));
                if (chapter !== undefined && parsed.chapter !== chapter) continue;
                records.push(parsed);
            } catch {
                // 忽略单条损坏索引行
            }
        }
        return records;
    }

    /**
     * 读取指定 sessionId 的阶段运行实时/历史明细：
     * 1. 优先读取 RoleRunner 内存活跃会话明细与 live agent session 快照；
     * 2. 回退读取持久化文件 .ops/session_logs/<sessionId>.json；
     * 3. 兜底回查 .ops/runs.jsonl 元数据（若存在）。
     */
    async getSessionDetail(sessionId: string): Promise<StageSessionDetail | null> {
        if (!/^[a-zA-Z0-9_.-]+$/.test(sessionId)) {
            throw new PathValidationError('非法的 sessionId 格式');
        }

        const liveDetail = this.roleRunner.getLiveSessionDetail(sessionId);
        if (liveDetail) {
            return liveDetail;
        }

        const bookRoot = this.bookRoot;
        if (bookRoot) {
            const logRaw = await readOptionalText(
                join(bookRoot, '.ops/session_logs', `${sessionId}.json`)
            );
            if (logRaw !== null) {
                try {
                    const parsed: unknown = JSON.parse(logRaw);
                    if (Array.isArray(parsed)) {
                        const runs = await this.listRunRecords();
                        const matchedRun = [...runs]
                            .reverse()
                            .find((r) => r.sessionId === sessionId);
                        return {
                            sessionId,
                            ...(matchedRun?.runId ? { runId: matchedRun.runId } : {}),
                            ...(matchedRun?.stage ? { stage: matchedRun.stage } : {}),
                            ...(matchedRun?.role ? { role: matchedRun.role } : {}),
                            ...(matchedRun?.chapter !== undefined
                                ? { chapter: matchedRun.chapter }
                                : {}),
                            status: matchedRun?.status ?? 'completed',
                            live: false,
                            events: mapRawSessionEventsToItems(
                                parsed,
                                matchedRun?.startedAt ?? new Date(0).toISOString()
                            )
                        };
                    }
                    if (parsed && typeof parsed === 'object') {
                        const obj = parsed as StageSessionDetail & { events?: unknown[] };
                        if (
                            Array.isArray(obj.events) &&
                            obj.events.some(
                                (ev) =>
                                    ev &&
                                    typeof ev === 'object' &&
                                    !('kind' in ev) &&
                                    'type' in ev
                            )
                        ) {
                            return {
                                ...obj,
                                events: mapRawSessionEventsToItems(
                                    obj.events,
                                    new Date(0).toISOString()
                                )
                            };
                        }
                        return obj;
                    }
                } catch {
                    // 损坏日志回退检查其他来源
                }
            }

            const runs = await this.listRunRecords();
            const matched = [...runs].reverse().find((r) => r.sessionId === sessionId);
            if (matched) {
                let events: StageSessionEventItem[] = [];
                // 若宿主仍保有实时/历史 session，尝试从 ctx.agents 读取事件快照
                try {
                    const liveAgent = (
                        this.ctx as unknown as {
                            agents?: { get?: (id: string) => { session?: { snapshotEvents?: () => unknown[] } } };
                        }
                    ).agents?.get?.(sessionId);
                    const snap = liveAgent?.session?.snapshotEvents?.();
                    if (Array.isArray(snap)) {
                        events = mapRawSessionEventsToItems(snap, matched.startedAt);
                    }
                } catch {
                    // 忽略无实时句柄
                }
                return {
                    sessionId: matched.sessionId,
                    runId: matched.runId,
                    stage: matched.stage,
                    role: matched.role,
                    chapter: matched.chapter,
                    status: matched.status,
                    ...(matched.parentSessionId
                        ? { parentSessionId: matched.parentSessionId }
                        : {}),
                    ...(matched.mode ? { mode: matched.mode } : {}),
                    live: matched.status === 'running',
                    events
                };
            }
        }

        return null;
    }

    /** 创建单章生产管线实例 */
    private createChapterPipeline(store: BookStore): ChapterPipeline {
        return new ChapterPipeline({
            store,
            roleRunner: this.roleRunner,
            roleLoader: this.roleLoader,
            llm: this.llmAdapter,
            system: this.system,
            pluginSearchDirs: this.pluginSearchDirs
        });
    }

    /** 创建睡眠整理与自愈管线实例 */
    private createDreamingPipeline(store: BookStore): DreamingPipeline {
        return new DreamingPipeline({
            store,
            roleRunner: this.roleRunner,
            llm: this.llmAdapter,
            system: this.system
        });
    }

    /** 处理工种会话启动事件并向 SSE 推送 activeSessionId / sessionId / runId */
    private handleStageSession = (evt: StageSessionEvent): void => {
        this.activeStageSessions.set(evt.stage, evt);
        const now = new Date().toISOString();

        if (evt.stage === 'DREAMING') {
            this.emitEvent('dream:started', {
                currentChapter: evt.chapter,
                activeSessionId: evt.sessionId,
                sessionId: evt.sessionId,
                runId: evt.runId,
                message: 'Dreamer 整理中',
                timestamp: now
            });
            return;
        }

        this.emitEvent('stage', {
            stage: evt.stage,
            role: evt.role,
            chapterNumber: evt.chapter,
            activeSessionId: evt.sessionId,
            sessionId: evt.sessionId,
            runId: evt.runId,
            message: `${evt.role} 运行中`,
            timestamp: now
        });
    };

    /** 执行单章推进（同步等待完成） */
    async stepChapter(
        options: StepChapterOptions,
        fromYolo = false
    ): Promise<StepChapterResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();

        return await this.runExclusiveTask(
            'STEPPING',
            async (signal) => {
                this.activeStageSessions.clear();
                this.emitEvent('chapter:phase', {
                    phase: 'STARTING',
                    chapterNumber: options.chapterNumber ?? null,
                    chapterGoal: options.chapterGoal
                });

                const pipeline = this.createChapterPipeline(store);
                try {
                    const resData = await pipeline.stepChapter({
                        ...options,
                        signal: options.signal ?? signal,
                        onStageSession: (evt) => {
                            this.handleStageSession(evt);
                            options.onStageSession?.(evt);
                        },
                        onProgress: (evt) => {
                            if (this.yoloState.running) {
                                this.yoloState.currentStage = evt.stage;
                            }
                            const sessionEvt = this.activeStageSessions.get(evt.stage);
                            const activeSessionId =
                                evt.activeSessionId ?? sessionEvt?.sessionId;
                            const runId = evt.runId ?? sessionEvt?.runId;

                            this.emitEvent('stage', {
                                stage: evt.stage,
                                chapterNumber: evt.chapterNumber,
                                message: evt.message,
                                timestamp: evt.timestamp,
                                ...(activeSessionId ? { activeSessionId, sessionId: activeSessionId } : {}),
                                ...(runId ? { runId } : {})
                            });
                            this.emitEvent('chapter:phase', {
                                phase: evt.stage,
                                chapterNumber: evt.chapterNumber,
                                message: evt.message,
                                ...(activeSessionId ? { activeSessionId, sessionId: activeSessionId } : {}),
                                ...(runId ? { runId } : {})
                            });
                            options.onProgress?.({
                                ...evt,
                                ...(activeSessionId ? { activeSessionId } : {}),
                                ...(runId ? { runId } : {})
                            });
                        }
                    });

                    this.emitEvent('gate:result', {
                        chapter: resData.chapterNumber,
                        clicheDensityPer1k: resData.telemetry.clicheDensityPer1k,
                        mattr500: resData.telemetry.mattr500,
                        sentenceLengthCv: resData.telemetry.sentenceLengthCv
                    });
                    this.emitEvent('checker:result', {
                        chapter: resData.chapterNumber,
                        replanCount: resData.replanCount,
                        rewriteCount: resData.rewriteCount,
                        patchRounds: resData.patchRounds
                    });
                    this.emitEvent('chapter:phase', {
                        phase: 'COMMITTED',
                        chapterNumber: resData.chapterNumber,
                        manuscriptPath: resData.manuscriptPath,
                        featCommitSha: resData.featCommitSha,
                        stateCommitSha: resData.stateCommitSha
                    });
                    await this.flushTelemetryEvents();
                    this.signalsConsumedLines = await readSignalsCursor(store.bookRoot);
                    return resData;
                } catch (err) {
                    this.emitEvent('chapter:phase', {
                        phase: 'FAILED',
                        error: err instanceof Error ? err.message : String(err)
                    });
                    throw err;
                }
            },
            { allowDuringYolo: fromYolo }
        );
    }

    /** 启动 YOLO 连跑 */
    async startYolo(options: {
        targetChapters?: number | undefined;
        defaultGoal?: string | undefined;
    } = {}): Promise<{ status: 'STARTED'; targetChapters: number; defaultGoal: string }> {
        this.assertAdmissionOpen();
        this.requireBookStore();

        const targetChapters = options.targetChapters ?? 3;
        if (!Number.isInteger(targetChapters) || targetChapters < 0) {
            throw new PathValidationError('targetChapters 必须为非负整数');
        }
        const defaultGoal =
            options.defaultGoal && options.defaultGoal.trim().length > 0
                ? options.defaultGoal.trim()
                : DEFAULT_YOLO_GOAL;

        if (this.yoloState.running || this.activeTask !== 'IDLE') {
            throw new TaskConflictError('已有任务或 YOLO 连跑正在执行中');
        }

        await this.assertNoActiveTxLock('当前作品持有 .ops/tx.lock，禁止启动 YOLO 连跑');

        this.haltRequested = false;
        this.yoloState.running = true;
        this.yoloState.stopRequested = false;
        this.yoloState.completedChapters = 0;
        this.yoloState.targetChapters = targetChapters;
        this.yoloState.currentStage = 'STARTING';

        this.yoloState.loopPromise = this.runYoloLoop(targetChapters, defaultGoal);

        return {
            status: 'STARTED',
            targetChapters,
            defaultGoal
        };
    }

    private async runYoloLoop(targetChapters: number, defaultGoal: string): Promise<void> {
        let lastNextChapterOptions: string[] = [];
        try {
            while (
                !this.yoloState.stopRequested &&
                !this.shuttingDown &&
                (targetChapters === 0 || this.yoloState.completedChapters < targetChapters)
            ) {
                const pendingSignals = await this.consumePendingSignals();
                let chapterGoal = defaultGoal;
                if (defaultGoal === DEFAULT_YOLO_GOAL && lastNextChapterOptions.length > 0) {
                    const optionsText = lastNextChapterOptions
                        .map((opt, idx) => `${idx + 1}. ${opt}`)
                        .join('\n');
                    chapterGoal = `${defaultGoal}\n\n[上章延续候选方向（请择优展开其一）]\n${optionsText}`;
                }
                if (pendingSignals.length > 0) {
                    const summary = pendingSignals.map((s) => JSON.stringify(s)).join('; ');
                    chapterGoal = `${chapterGoal}\n\n[待响应运维信号] ${summary}`;
                }

                const stepRes = await this.stepChapter({ chapterGoal }, true);
                lastNextChapterOptions = Array.isArray(stepRes.nextChapterOptions)
                    ? stepRes.nextChapterOptions
                    : [];
                this.yoloState.completedChapters += 1;

                if (
                    this.yoloState.stopRequested ||
                    this.shuttingDown ||
                    this.haltRequested
                ) {
                    this.emitEvent('yolo_halted', {
                        reason: 'STOP_REQUESTED',
                        completedChapters: this.yoloState.completedChapters,
                        timestamp: new Date().toISOString()
                    });
                    return;
                }

                this.yoloState.currentStage = 'DREAMING';
                const dreamRes = await this.runDreaming(
                    { currentChapter: stepRes.chapterNumber },
                    true
                );
                if (!dreamRes.skipped) {
                    this.emitEvent('dream:completed', {
                        skipped: dreamRes.skipped,
                        committedPaths: dreamRes.committedPaths,
                        spotlightTriggerCount: dreamRes.spotlightTriggerCount
                    });
                }
            }

            if (this.yoloState.stopRequested || this.haltRequested) {
                this.emitEvent('yolo_halted', {
                    reason: 'STOP_REQUESTED',
                    completedChapters: this.yoloState.completedChapters,
                    timestamp: new Date().toISOString()
                });
            } else {
                this.emitEvent('yolo_completed', {
                    completedChapters: this.yoloState.completedChapters,
                    targetChapters,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (err) {
            this.emitEvent('yolo_halted', {
                reason: err instanceof SafeHaltError ? 'SAFE_HALT' : 'ERROR',
                error: err instanceof Error ? err.message : String(err),
                completedChapters: this.yoloState.completedChapters,
                timestamp: new Date().toISOString()
            });
        } finally {
            this.yoloState.running = false;
            this.yoloState.currentStage = null;
            this.yoloState.loopPromise = null;
        }
    }

    /** 请求在本章安全点优雅停止 YOLO */
    stopYolo(): {
        stopRequested: boolean;
        running: boolean;
        completedChapters: number;
    } {
        this.yoloState.stopRequested = true;
        this.emitEvent('yolo:stop_requested', {
            stopRequested: true,
            running: this.yoloState.running,
            completedChapters: this.yoloState.completedChapters,
            currentStage: this.yoloState.currentStage,
            message: '将在当前章安全点完成后停止',
            timestamp: new Date().toISOString()
        });
        return {
            stopRequested: true,
            running: this.yoloState.running,
            completedChapters: this.yoloState.completedChapters
        };
    }

    /** 手稿真源增量同步 (Sync) */
    async syncManuscripts(
        options: SyncManuscriptsOptions = {}
    ): Promise<SyncManuscriptsResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        if (this.yoloState.running) {
            throw new TaskConflictError('YOLO 连跑正在执行中，禁止手动同步稿件');
        }

        return await this.runExclusiveTask('SYNCING', async (signal) => {
            this.emitEvent('sync:started', { timestamp: new Date().toISOString() });
            const syncPipeline = new SyncPipeline({
                store,
                llm: this.llmAdapter,
                system: this.system
            });
            const syncRes = await syncPipeline.syncManuscripts({
                signal: options.signal ?? signal
            });
            this.emitEvent('sync:completed', {
                status: syncRes.status,
                dirtyChapters: syncRes.dirtyChapters.length,
                downstreamConflicts: syncRes.downstreamConflicts.length
            });
            return syncRes;
        });
    }

    /** 保存手改章节（落 .ops/manual_edits/ 备份）并触发 Sync */
    async saveAndSyncChapter(
        chapterNumber: number,
        content: string
    ): Promise<SyncManuscriptsResult | null> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        const bookRoot = store.bookRoot;

        if (!Number.isInteger(chapterNumber) || chapterNumber <= 0 || chapterNumber > 9999) {
            throw new PathValidationError('chapterNumber 必须为 1 到 9999 的整数');
        }

        const fileName = `ch_${String(chapterNumber).padStart(4, '0')}.md`;
        const fullPath = resolve(bookRoot, 'manuscripts', fileName);
        if (!isSubPath(bookRoot, fullPath)) {
            throw new PathValidationError('非法章节路径');
        }
        if (this.yoloState.running) {
            throw new TaskConflictError('YOLO 连跑正在执行中，禁止在线编辑章节');
        }
        await this.assertNoActiveTxLock('当前作品持有 .ops/tx.lock，禁止在线编辑章节');

        return await this.runExclusiveTask('SYNCING', async (signal) =>
            store.runWithTxLock(async () => {
                const original = await readOptionalText(fullPath);
                if (original === null) {
                    return null;
                }

                const backupDir = join(bookRoot, '.ops/manual_edits');
                await mkdir(backupDir, { recursive: true });
                const backupPath = join(backupDir, `${randomUUID()}.json`);
                await writeFile(
                    backupPath,
                    JSON.stringify({ chapterNumber, original, pending: content }),
                    'utf8'
                );
                await writeFile(fullPath, content, 'utf8');

                this.emitEvent('sync:started', {
                    chapterNumber,
                    timestamp: new Date().toISOString()
                });

                const syncPipeline = new SyncPipeline({
                    store,
                    llm: this.llmAdapter,
                    system: this.system
                });
                const result = await syncPipeline.syncManuscripts({ signal });
                this.emitEvent('chapter_synced', {
                    chapterNumber,
                    status: result.status,
                    dirtyChapters: result.dirtyChapters.length,
                    downstreamConflicts: result.downstreamConflicts.length,
                    timestamp: new Date().toISOString()
                });
                await rm(backupPath, { force: true });
                return result;
            })
        );
    }

    /** 触发多轮 Dreaming 整理 */
    async runDreaming(
        options: Partial<RunDreamingOptions> = {},
        fromYolo = false
    ): Promise<RunDreamingResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        if (this.yoloState.running && !fromYolo) {
            throw new TaskConflictError('YOLO 连跑正在执行中，禁止手动触发 Dreaming');
        }

        return await this.runExclusiveTask(
            'DREAMING',
            async (signal) => {
                const txState = await store.readTxState();
                const currentChapter = options.currentChapter ?? txState.last_committed_ch;
                const pipeline = this.createDreamingPipeline(store);
                this.emitEvent('dream:started', { currentChapter });
                const dreamRes = await pipeline.runDreaming({
                    ...options,
                    currentChapter,
                    signal: options.signal ?? signal,
                    onStageSession: (evt) => {
                        this.handleStageSession(evt);
                        options.onStageSession?.(evt);
                    }
                });
                this.emitEvent('dream:completed', {
                    skipped: dreamRes.skipped,
                    committedPaths: dreamRes.committedPaths,
                    spotlightTriggerCount: dreamRes.spotlightTriggerCount
                });
                return dreamRes;
            },
            { allowDuringYolo: fromYolo }
        );
    }

    /** 触发三级跨章自愈 */
    async healCrossChapterConflicts(
        conflicts: SuspectedConflict[],
        options: HealConflictsOptions = {}
    ): Promise<HealConflictsResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        return await this.runExclusiveTask('DREAMING', async (signal) => {
            const pipeline = this.createDreamingPipeline(store);
            return await pipeline.healCrossChapterConflicts(conflicts, {
                ...options,
                signal: options.signal ?? signal
            });
        });
    }

    /** 首章校准通过后触发 Voice Harvest 采集表达标本 */
    async harvestVoiceFromChapter(chapterNumber = 1): Promise<VoiceHarvestResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        return await this.runExclusiveTask('SYNCING', async (signal) =>
            harvestVoiceFromChapter({
                store,
                llm: this.llmAdapter,
                chapterNumber,
                signal
            })
        );
    }

    /** 执行五步原子换卷或封笔 */
    async advanceVolume(
        options: AdvanceVolumeOptions = {}
    ): Promise<AdvanceVolumeResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        if (this.yoloState.running) {
            throw new TaskConflictError('YOLO 连跑正在执行中，禁止执行换卷操作');
        }

        return await this.runExclusiveTask('ADVANCING_VOLUME', async (signal) => {
            await this.assertNoActiveTxLock('存在活跃事务锁，禁止并发执行换卷');
            const pipeline = new VolumePipeline({
                store,
                llm: this.llmAdapter,
                system: this.system
            });
            const advanceRes = await pipeline.advanceVolume({
                ...options,
                signal: options.signal ?? signal
            });
            this.emitEvent('volume:advanced', advanceRes);
            return advanceRes;
        });
    }

    /** PARALLEL 并行时间线分叉 */
    async forkParallelWindow(options: ForkParallelWindowOptions) {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        return await this.runExclusiveTask('SYNCING', async () =>
            this.createChapterPipeline(store).forkParallelWindow(options)
        );
    }

    /** PARALLEL 并行时间线三方合并 */
    async mergeParallelWindow(options: MergeParallelWindowOptions) {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        return await this.runExclusiveTask('SYNCING', async () =>
            this.createChapterPipeline(store).mergeParallelWindow(options)
        );
    }

    /** 开新书编译（支持直接传入 LockCharterAndBootInput 或 Modal 请求经 boot-compiler 编译） */
    async bootBook(
        input: LockCharterAndBootInput | BootFromModalPayload
    ): Promise<LockCharterAndBootResult> {
        this.assertAdmissionOpen();
        if (this.yoloState.running) {
            throw new TaskConflictError('YOLO 连跑正在执行中，禁止开新书');
        }
        if (this.bookRoot) {
            await this.assertNoActiveTxLock('当前作品持有 .ops/tx.lock，禁止开新书');
        }

        return await this.runExclusiveTask('BOOTING', async (signal) => {
            let bootRes: LockCharterAndBootResult;
            if ('commitments' in input) {
                bootRes = await this.toolsService.lockCharterAndBoot(input, {
                    booksRoot: this.booksRoot,
                    system: this.system
                });
            } else {
                const targetRoot = resolve(this.booksRoot, input.slug);
                if (!isSubPath(this.booksRoot, targetRoot)) {
                    throw new PathValidationError('禁止路径穿越');
                }

                const roleCfg = await this.roleLoader.loadRoleConfig('boot-compiler');
                const taskPrompt = [
                    `## 开书编译任务 (${input.mode})`,
                    `- 作品标识: ${input.slug}`,
                    `- 书名: ${input.title}`,
                    `- 初始主视角实体 ID: ${input.povCharacter}`,
                    input.t0Anchor ? `- T0 原话现场锚点: ${input.t0Anchor}` : '',
                    input.premiseOrSeed ? `- 核心创意与设定:\n${input.premiseOrSeed}` : '',
                    input.sourceMaterial ? `- 外部参考设定:\n${input.sourceMaterial}` : '',
                    '',
                    '请严格按三把手术刀原则编译完整作品资产包，并调用 `yield_boot_bundle` 提交。'
                ]
                    .filter(Boolean)
                    .join('\n');

                // boot-compiler 在建库目录尚未存在时执行，暂存与运行索引在临时/booksRoot 上隔离运行
                const bootStagingRoot = resolve(this.booksRoot, `.boot-staging-${randomUUID()}`);
                await mkdir(bootStagingRoot, { recursive: true });
                try {
                    const runRes = await this.roleRunner.runMultiTurn<BootBundleOutput>({
                        roleId: roleCfg.id,
                        stage: 'BOOT_COMPILER',
                        chapterNumber: 0,
                        bookRoot: bootStagingRoot,
                        taskPrompt,
                        signal,
                        onStageSession: this.handleStageSession
                    });

                    const bundle = runRes.yieldResult;
                    if (bundle.contract_conflicts.length > 0) {
                        throw new Error(
                            `开书契约存在矛盾需作者裁决: ${bundle.contract_conflicts.join('; ')}`
                        );
                    }

                    bootRes = await this.toolsService.lockCharterAndBoot(
                        {
                            book_slug: input.slug,
                            title: input.title,
                            pov_character: input.povCharacter,
                            t0_anchor: input.t0Anchor ?? bundle.world_summary,
                            commitments: [`核心叙事承诺：${bundle.world_summary}`],
                            stage_ceiling: bundle.stage_ceiling,
                            opening_sequence_beats: bundle.opening_sequence_beats,
                            unrevealed_pivots: bundle.unrevealed_pivots,
                            current_arc_envelope: bundle.current_arc_envelope,
                            static_base_and_voice: bundle.static_base_and_voice,
                            world_summary: bundle.world_summary,
                            l0_sagas_markdown: bundle.l0_sagas_markdown,
                            l1_volumes_markdown: bundle.l1_volumes_markdown,
                            entities: bundle.entities,
                            lore_entries: bundle.lore_entries,
                            open_threads: bundle.open_threads,
                            future_horizon_events: bundle.future_horizon_events,
                            voice_samples: bundle.voice_samples
                        },
                        {
                            booksRoot: this.booksRoot,
                            system: this.system
                        }
                    );
                } finally {
                    await rm(bootStagingRoot, { recursive: true, force: true }).catch(() => {});
                }
            }

            await this.switchBookInternal(bootRes.bookRoot);
            return bootRes;
        });
    }

    /** 投递微调信号到 .ops/signals.jsonl */
    async enqueueSignal(rawInput: Record<string, unknown>): Promise<OpsSignal> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        const bookRoot = store.bookRoot;

        let defaultChapter = 1;
        try {
            const tx = await store.readTxState();
            defaultChapter = tx.last_committed_ch + 1;
        } catch {
            defaultChapter = 1;
        }

        const normalizedType =
            rawInput['type'] === 'SPOTLIGHT_TRIGGER' ||
            rawInput['type'] === 'RETCON' ||
            rawInput['type'] === 'DIRECTOR_NOTE'
                ? rawInput['type']
                : 'DIRECTOR_NOTE';

        const reason =
            typeof rawInput['reason'] === 'string' && rawInput['reason'].trim().length > 0
                ? rawInput['reason'].trim()
                : typeof rawInput['content'] === 'string' && rawInput['content'].trim().length > 0
                  ? rawInput['content'].trim()
                  : '';

        const chapter =
            typeof rawInput['chapter'] === 'number' && Number.isInteger(rawInput['chapter'])
                ? rawInput['chapter']
                : typeof rawInput['target_chapter'] === 'number' &&
                    Number.isInteger(rawInput['target_chapter'])
                  ? rawInput['target_chapter']
                  : defaultChapter;

        const parsed = OpsSignalSchema.safeParse({
            ...rawInput,
            type: normalizedType,
            reason,
            chapter,
            created_at:
                typeof rawInput['created_at'] === 'string'
                    ? rawInput['created_at']
                    : new Date().toISOString()
        });
        if (!parsed.success) {
            throw new PathValidationError(
                `信号格式校验失败: ${parsed.error.issues.map((i) => i.message).join('; ')}`
            );
        }

        const signalRecord = parsed.data;
        const opsDir = join(bookRoot, '.ops');
        await mkdir(opsDir, { recursive: true });
        await appendFile(
            join(opsDir, 'signals.jsonl'),
            `${JSON.stringify(signalRecord)}\n`,
            'utf8'
        );

        this.emitEvent('signal:received', signalRecord);
        return signalRecord;
    }

    /** 撤回一条未消费信号 */
    async deleteSignal(
        createdAt: string,
        reason: string
    ): Promise<{ status: 'WITHDRAWN'; remaining: number } | null> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        const bookRoot = store.bookRoot;

        await this.assertNoActiveTxLock('流水线运行中（.ops/tx.lock），禁止撤回纸条');

        const filePath = join(bookRoot, '.ops/signals.jsonl');
        const raw = await readOptionalText(filePath);
        if (raw === null) {
            return null;
        }

        const kept: string[] = [];
        let removedIdx = -1;
        let lineIdx = 0;
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            const currentIdx = lineIdx;
            lineIdx += 1;
            if (removedIdx < 0) {
                try {
                    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                    const parsedReason =
                        typeof parsed['reason'] === 'string'
                            ? parsed['reason']
                            : typeof parsed['content'] === 'string'
                              ? parsed['content']
                              : typeof parsed['instruction'] === 'string'
                                ? parsed['instruction']
                                : null;
                    if (parsed['created_at'] === createdAt && parsedReason === reason) {
                        removedIdx = currentIdx;
                        continue;
                    }
                } catch {
                    // 损坏行保持原样
                }
            }
            kept.push(trimmed);
        }

        if (removedIdx < 0) {
            return null;
        }

        const persistedCursor = await readSignalsCursor(bookRoot);
        const totalLines = kept.length + 1;
        const effectiveCursor =
            persistedCursor <= totalLines ? persistedCursor : this.signalsConsumedLines;
        if (removedIdx < effectiveCursor) {
            throw new TaskConflictError('目标信号已被流水线消费，禁止撤回');
        }

        await writeFile(filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
        this.emitEvent('signal:withdrawn', { created_at: createdAt, reason });
        return { status: 'WITHDRAWN', remaining: kept.length };
    }

    /** 请求在安全检查点停机 */
    requestHalt(): { haltRequested: boolean; activeTask: RuntimeTaskKind } {
        this.haltRequested = true;
        this.yoloState.stopRequested = true;
        this.activeAbortController?.abort(new Error('SAFE_HALT_REQUESTED'));
        this.emitEvent('halt:requested', {
            activeTask: this.activeTask,
            timestamp: new Date().toISOString()
        });
        return {
            haltRequested: true,
            activeTask: this.activeTask
        };
    }

    /**
     * 有序排空停机：
     * 1. 立即关闭新任务准入闸门；
     * 2. 向在途任务与 YOLO 发送收束信号；
     * 3. 等待活跃 RoleRunner 句柄、后台任务与 WAL/Git 提交彻底排空；
     *    超时时仅广播 halt:waiting 告警，不强杀 .ops/tx.lock 或提前卸载路由。
     */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        this.requestHalt();

        const waitAllPending = async () => {
            const pending: Promise<unknown>[] = [];
            if (this.yoloState.loopPromise) {
                pending.push(this.yoloState.loopPromise.catch(() => {}));
            }
            if (this.activePromise) {
                pending.push(this.activePromise.catch(() => {}));
            }
            for (const bg of this.backgroundPromises) {
                pending.push(bg.catch(() => {}));
            }
            pending.push(this.roleRunner.drainActiveRuns());
            await Promise.all(pending);
        };

        const drainTask = waitAllPending();
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timeout = Promise.withResolvers<boolean>();
            timeoutTimer = setTimeout(() => timeout.resolve(false), this.shutdownTimeoutMs);
            timeoutTimer.unref?.();

            const settled = await Promise.race([
                drainTask.then(() => true),
                timeout.promise
            ]);
            if (!settled) {
                this.emitEvent('halt:waiting', {
                    activeTask: this.activeTask,
                    activeAgents: this.roleRunner.activeCount,
                    timestamp: new Date().toISOString()
                });
                await drainTask;
            }
        } finally {
            if (timeoutTimer !== undefined) {
                clearTimeout(timeoutTimer);
            }
        }

        this.emitEvent('halt:completed', {
            timestamp: new Date().toISOString()
        });

        for (const client of this.sseClients) {
            if (!client.writableEnded) {
                client.end();
            }
        }
        this.sseClients.clear();
    }

    /** 列出 booksRoot 下所有有效作品 */
    async listBooks(): Promise<{
        currentBookRoot: string | null;
        books: Array<{
            bookRoot: string;
            slug: string;
            title: string;
            currentChapter: number;
            storyDay: number;
            walPhase: string;
        }>;
    }> {
        let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
        try {
            entries = await readdir(this.booksRoot, { withFileTypes: true });
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
        }

        const books: Array<{
            bookRoot: string;
            slug: string;
            title: string;
            currentChapter: number;
            storyDay: number;
            walPhase: string;
        }> = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dirPath = resolve(this.booksRoot, entry.name);
            if (!(await isValidBookDirectory(dirPath))) continue;

            const candidateStore = new BookStore(dirPath, this.system);
            let slug = entry.name;
            let title = entry.name;
            let currentChapter = 0;
            let storyDay = 0;
            let walPhase = 'IDLE';

            try {
                const config = await candidateStore.readBookConfig();
                slug = config.book_slug;
                title = config.title;
            } catch {
                // 忽略配置读取失败
            }
            try {
                const txState = await candidateStore.readTxState();
                walPhase = txState.phase;
                currentChapter = txState.last_committed_ch;
            } catch {
                // 忽略损坏 tx_state
            }
            try {
                const worldState = await candidateStore.readWorldState();
                storyDay = worldState.frontmatter.story_day;
                if (currentChapter === 0) {
                    currentChapter = worldState.frontmatter.current_chapter;
                }
            } catch {
                // 忽略缺失 world_state
            }

            books.push({
                bookRoot: dirPath,
                slug,
                title,
                currentChapter,
                storyDay,
                walPhase
            });
        }

        books.sort((a, b) => a.slug.localeCompare(b.slug));
        return {
            currentBookRoot: this.bookRoot,
            books
        };
    }

    /** 列出当前作品章节摘要 */
    async listChapters(): Promise<{
        chapters: Array<{
            chapterNumber: number;
            fileName: string;
            title: string;
            charCount: number;
            sha256: string;
            dirty: boolean;
            commitSha: string | null;
        }>;
    }> {
        const store = this.requireBookStore();
        const bookRoot = store.bookRoot;
        const manuscriptsDir = join(bookRoot, 'manuscripts');

        let fileNames: string[] = [];
        try {
            fileNames = await readdir(manuscriptsDir);
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
        }

        const dirtyList = await store.detectDirtyChapters();
        const dirtySet = new Set(dirtyList.map((d) => d.chapterNumber));

        const matchedFiles = fileNames
            .map((fileName) => {
                const m = CHAPTER_FILE_RE.exec(fileName);
                return m?.[1] ? { fileName, chapterNumber: Number(m[1]) } : null;
            })
            .filter(
                (item): item is { fileName: string; chapterNumber: number } => item !== null
            )
            .sort((a, b) => a.chapterNumber - b.chapterNumber);

        const chapters = [];
        for (const item of matchedFiles) {
            const relPath = `manuscripts/${item.fileName}`;
            const content = await readFile(join(bookRoot, relPath), 'utf8');
            chapters.push({
                chapterNumber: item.chapterNumber,
                fileName: item.fileName,
                title: extractChapterTitle(content, item.chapterNumber),
                charCount: content.length,
                sha256: computeSha256(content),
                dirty: dirtySet.has(item.chapterNumber),
                commitSha: null as string | null
            });
        }
        return { chapters };
    }

    private async assertNoActiveTxLock(message: string): Promise<void> {
        const bookRoot = this.bookRoot;
        if (!bookRoot) return;
        const lockPath = join(bookRoot, '.ops/tx.lock');
        const raw = await readOptionalText(lockPath);
        if (raw === null) return;

        let active = false;
        try {
            const parsed = TxLockPayloadSchema.safeParse(JSON.parse(raw));
            if (parsed.success) {
                try {
                    process.kill(parsed.data.pid, 0);
                    active = true;
                } catch (err: unknown) {
                    active =
                        !(
                            err !== null &&
                            typeof err === 'object' &&
                            'code' in err &&
                            err.code === 'ESRCH'
                        );
                }
            } else {
                const fileStat = await stat(lockPath);
                active = Date.now() - fileStat.mtimeMs < DEFAULT_LOCK_STALE_MS;
            }
        } catch {
            try {
                const fileStat = await stat(lockPath);
                active = Date.now() - fileStat.mtimeMs < DEFAULT_LOCK_STALE_MS;
            } catch {
                active = false;
            }
        }

        if (active) {
            throw new TxLockConflictError(message);
        }
    }

    private async runExclusiveTask<T>(
        kind: Exclude<RuntimeTaskKind, 'IDLE'>,
        fn: (signal: AbortSignal) => Promise<T>,
        options?: { allowDuringYolo?: boolean }
    ): Promise<T> {
        this.assertAdmissionOpen();
        if (this.yoloState.running && !options?.allowDuringYolo) {
            throw new TaskConflictError('YOLO 连跑正在执行中，禁止并发执行其他任务');
        }
        if (this.activeTask !== 'IDLE') {
            throw new TaskConflictError(`当前正在执行任务: ${this.activeTask}`);
        }

        this.activeTask = kind;
        this.haltRequested = false;
        const ac = new AbortController();
        this.activeAbortController = ac;

        const promise = (async () => {
            try {
                return await fn(ac.signal);
            } finally {
                this.activeTask = 'IDLE';
                this.activeAbortController = null;
                this.activePromise = null;
                this.emitEvent('task:idle', { task: kind });
            }
        })();

        this.activePromise = promise;
        return await promise;
    }
}

function computeSha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function extractChapterTitle(content: string, chapterNumber: number): string {
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith('#')) {
            return trimmed.replace(/^#+\s*/, '').trim() || `第 ${chapterNumber} 章`;
        }
        break;
    }
    return `第 ${chapterNumber} 章`;
}

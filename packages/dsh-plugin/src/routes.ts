import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
    OpsSignalSchema,
    TxLockConflictError,
    TxLockPayloadSchema,
    type BookStore,
    type DreamingRunner,
    type NarrativeEngine,
    type OpsSignal,
    type RunDreamingOptions,
    type StepChapterOptions,
    type SyncManuscriptsOptions
} from '@narrateos/core';
import type { DshWebServerService } from './types.js';

export type RuntimeTaskKind = 'IDLE' | 'STEPPING' | 'SYNCING' | 'DREAMING';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface NarrateControllerDeps {
    bookRoot: string;
    store: BookStore;
    engine: NarrativeEngine;
    dreamingRunner: DreamingRunner;
    heartbeatIntervalMs?: number;
    shutdownTimeoutMs?: number;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    if (res.writableEnded) return;
    const payload = JSON.stringify(body);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(payload);
}

function assertMethod(req: IncomingMessage, res: ServerResponse, expected: 'GET' | 'POST'): boolean {
    if (req.method === expected) {
        return true;
    }
    res.setHeader('Allow', expected);
    sendJson(res, 405, { error: `Method Not Allowed, expected ${expected}` });
    return false;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_JSON_BODY_BYTES) {
            throw new Error('Request body exceeds 1MB limit');
        }
        chunks.push(buf);
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw.length === 0) {
        return {};
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON body must be an object');
    }
    return parsed as Record<string, unknown>;
}

async function readOptionalText(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

/**
 * NarrateOS 运行态控制器：
 * - 序列化写任务（step / sync / dream），防止并发冲突
 * - 维护 SSE 遥测广播与 .ops/telemetry.jsonl 增量追踪
 * - 处理 Safe-Point 停机请求并在停机时等待收尾、确保 .ops/tx.lock 释放
 */
export class NarrateRuntimeController {
    readonly bookRoot: string;
    private readonly store: BookStore;
    private readonly engine: NarrativeEngine;
    private readonly dreamingRunner: DreamingRunner;

    private activeTask: RuntimeTaskKind = 'IDLE';
    private haltRequested = false;
    private shuttingDown = false;
    private activeAbortController: AbortController | null = null;
    private activePromise: Promise<unknown> | null = null;

    private readonly sseClients = new Set<ServerResponse>();
    private telemetryOffsetLines = 0;
    private readonly shutdownTimeoutMs: number;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    constructor(deps: NarrateControllerDeps) {
        this.bookRoot = deps.bookRoot;
        this.store = deps.store;
        this.engine = deps.engine;
        this.dreamingRunner = deps.dreamingRunner;
        this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

        const heartbeatMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        if (heartbeatMs > 0) {
            this.heartbeatTimer = setInterval(() => {
                this.sendHeartbeat();
            }, heartbeatMs);
            this.heartbeatTimer.unref?.();
        }
    }

    /** 向所有存活的 SSE 客户端发送保活心跳 */
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

    /** 向所有已连接的 SSE 客户端推送事件 */
    emitEvent(eventName: string, data: unknown): void {
        const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of this.sseClients) {
            if (client.writableEnded || client.destroyed) {
                this.sseClients.delete(client);
                continue;
            }
            client.write(frame);
        }
    }

    /** 读取 .ops/telemetry.jsonl 的新增行并作为 telemetry 事件广播 */
    async flushTelemetryEvents(): Promise<void> {
        const raw = await readOptionalText(join(this.bookRoot, '.ops/telemetry.jsonl'));
        if (raw === null) return;

        const lines = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        // 文件被截断或重建时重置偏移量
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
                const parsed: unknown = JSON.parse(line);
                this.emitEvent('telemetry', parsed);
            } catch {
                this.emitEvent('telemetry', { raw: line });
            }
        }
    }

    /** 请求在安全检查点停机 */
    requestHalt(): { haltRequested: boolean; activeTask: RuntimeTaskKind } {
        this.haltRequested = true;
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

    /** Cordis 停机钩子调用：等待进行中任务在 Safe-Point 收尾并确保释放本进程持有的 tx.lock */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.requestHalt();

        if (this.activePromise) {
            let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    this.activePromise.catch(() => {
                        // 停机等待阶段忽略业务异常，确保锁检查与资源释放继续执行
                    }),
                    new Promise<void>((resolve) => {
                        timeoutTimer = setTimeout(resolve, this.shutdownTimeoutMs);
                        timeoutTimer.unref?.();
                    })
                ]);
            } finally {
                if (timeoutTimer !== undefined) {
                    clearTimeout(timeoutTimer);
                }
            }
        }

        await this.ensureOwnTxLockReleased();
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

    private async ensureOwnTxLockReleased(): Promise<void> {
        const lockPath = join(this.bookRoot, '.ops/tx.lock');
        const raw = await readOptionalText(lockPath);
        if (raw === null) return;

        try {
            const parsed = TxLockPayloadSchema.safeParse(JSON.parse(raw));
            if (parsed.success && parsed.data.pid === process.pid) {
                await unlink(lockPath);
            }
        } catch {
            // 若锁文件损坏或已被清理则忽略
        }
    }

    private async runExclusiveTask<T>(
        kind: Exclude<RuntimeTaskKind, 'IDLE'>,
        fn: (signal: AbortSignal) => Promise<T>
    ): Promise<T> {
        if (this.shuttingDown) {
            throw new Error('插件正在停机中，拒绝启动新任务');
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
            }
        })();

        this.activePromise = promise;
        return await promise;
    }

    /** GET /api/narrate/status */
    async handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'GET')) return;

        try {
            const snapshot = await this.store.loadSnapshot();
            let latestChapter = snapshot.txState.last_committed_ch;
            for (const fileName of snapshot.chapterFiles) {
                const match = CHAPTER_FILE_RE.exec(fileName);
                if (match?.[1]) {
                    const chNum = Number(match[1]);
                    if (chNum > latestChapter) {
                        latestChapter = chNum;
                    }
                }
            }

            sendJson(res, 200, {
                bookSlug: snapshot.config.book_slug,
                title: snapshot.config.title,
                walPhase: snapshot.txState.phase,
                activeChapter: snapshot.txState.active_chapter,
                lastCommittedChapter: snapshot.txState.last_committed_ch,
                latestChapter,
                chapterCount: snapshot.chapterFiles.length,
                entityCount: Object.keys(snapshot.entities).length,
                coldArchiveCount: snapshot.coldArchiveIds.length,
                worldState: snapshot.worldState.frontmatter,
                runtime: {
                    activeTask: this.activeTask,
                    haltRequested: this.haltRequested
                }
            });
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** POST /api/narrate/step */
    async handleStep(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        if (typeof body['chapterGoal'] !== 'string' || body['chapterGoal'].trim().length === 0) {
            sendJson(res, 400, { error: '缺少必填参数 chapterGoal' });
            return;
        }

        const stepOptions: StepChapterOptions = {
            chapterGoal: body['chapterGoal']
        };
        if (typeof body['chapterNumber'] === 'number') {
            stepOptions.chapterNumber = body['chapterNumber'];
        }
        if (
            body['timelineMode'] === 'MAINLINE' ||
            body['timelineMode'] === 'PARALLEL' ||
            body['timelineMode'] === 'FLASHBACK'
        ) {
            stepOptions.timelineMode = body['timelineMode'];
        }
        if (typeof body['targetDay'] === 'number') {
            stepOptions.targetDay = body['targetDay'];
        }
        if (Array.isArray(body['povCharIds'])) {
            stepOptions.povCharIds = body['povCharIds'].filter(
                (item): item is string => typeof item === 'string'
            );
        }

        try {
            const result = await this.runExclusiveTask('STEPPING', async (signal) => {
                this.emitEvent('chapter:phase', {
                    phase: 'STARTING',
                    chapterNumber: stepOptions.chapterNumber ?? null,
                    chapterGoal: stepOptions.chapterGoal
                });

                const resData = await this.engine.stepChapter({
                    ...stepOptions,
                    signal
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
                return resData;
            });

            sendJson(res, 200, result);
        } catch (err) {
            if (err instanceof TaskConflictError || err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            this.emitEvent('chapter:phase', {
                phase: 'FAILED',
                error: err instanceof Error ? err.message : String(err)
            });
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** POST /api/narrate/sync */
    async handleSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        try {
            const result = await this.runExclusiveTask('SYNCING', async (signal) => {
                const opts: SyncManuscriptsOptions = { signal };
                this.emitEvent('sync:started', { timestamp: new Date().toISOString() });
                const syncRes = await this.engine.syncManuscripts(opts);
                this.emitEvent('sync:completed', {
                    status: syncRes.status,
                    dirtyChapters: syncRes.dirtyChapters.length,
                    downstreamConflicts: syncRes.downstreamConflicts.length
                });
                return syncRes;
            });
            sendJson(res, 200, result);
        } catch (err) {
            if (err instanceof TaskConflictError || err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** POST /api/narrate/dream */
    async handleDream(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        try {
            const result = await this.runExclusiveTask('DREAMING', async (signal) => {
                const txState = await this.store.readTxState();
                const currentChapter =
                    typeof body['currentChapter'] === 'number'
                        ? body['currentChapter']
                        : txState.last_committed_ch;

                const dreamOptions: RunDreamingOptions = {
                    currentChapter,
                    signal
                };
                if (typeof body['force'] === 'boolean') {
                    dreamOptions.force = body['force'];
                }
                if (typeof body['recentWordDelta'] === 'number') {
                    dreamOptions.recentWordDelta = body['recentWordDelta'];
                }
                if (Array.isArray(body['activeEntityIds'])) {
                    dreamOptions.activeEntityIds = body['activeEntityIds'].filter(
                        (item): item is string => typeof item === 'string'
                    );
                }

                this.emitEvent('dream:started', { currentChapter });
                const dreamRes = await this.dreamingRunner.runDreaming(dreamOptions);
                this.emitEvent('dream:completed', {
                    skipped: dreamRes.skipped,
                    vacuumedEntities: dreamRes.vacuumedEntities,
                    warpedNodesFlipped: dreamRes.warpedNodesFlipped,
                    archivedFiles: dreamRes.archivedFiles
                });
                return dreamRes;
            });
            sendJson(res, 200, result);
        } catch (err) {
            if (err instanceof TaskConflictError || err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** POST /api/narrate/signals */
    async handleSignals(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const parsed = OpsSignalSchema.safeParse({
            ...body,
            created_at:
                typeof body['created_at'] === 'string'
                    ? body['created_at']
                    : new Date().toISOString()
        });
        if (!parsed.success) {
            sendJson(res, 400, {
                error: '信号格式校验失败',
                issues: parsed.error.issues
            });
            return;
        }

        const signalRecord: OpsSignal = parsed.data;
        const opsDir = join(this.bookRoot, '.ops');
        await mkdir(opsDir, { recursive: true });
        await appendFile(
            join(opsDir, 'signals.jsonl'),
            `${JSON.stringify(signalRecord)}\n`,
            'utf8'
        );

        this.emitEvent('signal:received', signalRecord);
        sendJson(res, 201, { status: 'QUEUED', signal: signalRecord });
    }

    /** POST /api/narrate/halt */
    async handleHalt(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;
        const haltStatus = this.requestHalt();
        sendJson(res, 202, haltStatus);
    }

    /** GET /api/narrate/events */
    async handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'GET')) return;

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        res.write('retry: 3000\n\n');
        res.write(
            `event: connected\ndata: ${JSON.stringify({
                bookRoot: this.bookRoot,
                activeTask: this.activeTask,
                haltRequested: this.haltRequested,
                timestamp: new Date().toISOString()
            })}\n\n`
        );

        this.sseClients.add(res);
        const removeClient = () => {
            this.sseClients.delete(res);
        };
        req.on('close', removeClient);
        res.on('close', removeClient);
        res.on('error', removeClient);
    }
}

class TaskConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TaskConflictError';
    }
}

/** 注册 NarrateOS 后端 REST 与 SSE 控制面路由 */
export function registerNarrateRoutes(
    webServer: DshWebServerService,
    controller: NarrateRuntimeController
): () => void {
    const disposers = [
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/status',
            handler: (req, res) => controller.handleStatus(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/step',
            handler: (req, res) => controller.handleStep(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/sync',
            handler: (req, res) => controller.handleSync(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/dream',
            handler: (req, res) => controller.handleDream(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/signals',
            handler: (req, res) => controller.handleSignals(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/halt',
            handler: (req, res) => controller.handleHalt(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/events',
            handler: (req, res) => controller.handleEvents(req, res)
        })
    ];

    return () => {
        for (const dispose of disposers) {
            dispose();
        }
    };
}

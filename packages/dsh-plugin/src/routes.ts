import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
    BookStore,
    bootBook,
    DreamingRunner,
    NarrativeEngine,
    NodeSystemAdapter,
    OpsSignalSchema,
    SafeHaltError,
    serializeEntityMarkdown,
    TxLockConflictError,
    TxLockPayloadSchema,
    type AdvanceVolumeOptions,
    type BootMode,
    type LlmPort,
    type OpsSignal,
    type RunDreamingOptions,
    type StepChapterOptions,
    type SyncManuscriptsOptions,
    type SystemPort
} from '@narrateos/core';
import type { DshWebServerService } from './types.js';

const execFileAsync = promisify(execFile);

export type RuntimeTaskKind = 'IDLE' | 'STEPPING' | 'SYNCING' | 'DREAMING' | 'BOOTING' | 'ADVANCING_VOLUME';

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_YOLO_GOAL = '按既定主线与人物弧光自然推进下一章';

export interface NarrateControllerDeps {
    bookRoot: string;
    booksRoot?: string;
    store: BookStore;
    engine: NarrativeEngine;
    dreamingRunner: DreamingRunner;
    llm?: LlmPort;
    system?: SystemPort;
    heartbeatIntervalMs?: number;
    shutdownTimeoutMs?: number;
}

export interface YoloRuntimeState {
    running: boolean;
    stopRequested: boolean;
    completedChapters: number;
    targetChapters: number;
    currentStage: string | null;
    loopPromise: Promise<void> | null;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    if (res.writableEnded) return;
    const payload = JSON.stringify(body);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(payload);
}

function assertMethod(
    req: IncomingMessage,
    res: ServerResponse,
    expected: string | readonly string[]
): boolean {
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (req.method && allowed.includes(req.method)) {
        return true;
    }
    res.setHeader('Allow', allowed.join(', '));
    sendJson(res, 405, { error: `Method Not Allowed, expected ${allowed.join(' | ')}` });
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

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function isSubPath(parentDir: string, candidatePath: string): boolean {
    const parent = resolve(parentDir);
    const target = resolve(candidatePath);
    const rel = relative(parent, target);
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
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

function resolveStatusModelRouting(configured?: Record<string, string>): Record<string, string> {
    const routing: Record<string, string> = {};
    if (configured) {
        for (const [key, value] of Object.entries(configured)) {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
                routing[key] = trimmed;
            }
        }
    }

    const envFallbacks: Array<[string, string | undefined]> = [
        ['strong_creative', process.env['NARRATEOS_MODEL_STRONG']],
        ['fast_retrieval', process.env['NARRATEOS_MODEL_FAST']],
        ['audit', process.env['NARRATEOS_MODEL_AUDIT']]
    ];
    for (const [pool, envValue] of envFallbacks) {
        if (!routing[pool] && envValue) {
            const trimmed = envValue.trim();
            if (trimmed.length > 0) {
                routing[pool] = trimmed;
            }
        }
    }

    return routing;
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

function formatChapterFileName(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}.md`;
}

async function isValidBookDirectory(dirPath: string): Promise<boolean> {
    const hasConfig = await pathExists(join(dirPath, 'world/book_config.yaml'));
    if (hasConfig) return true;
    return await pathExists(join(dirPath, '.ops/tx_state.json'));
}

async function runGitCommand(bookRoot: string, args: string[]): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('git', ['-C', bookRoot, ...args], {
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024
        });
        return stdout;
    } catch {
        return null;
    }
}

/**
 * NarrateOS 运行态控制器：
 * - 序列化写任务（step / sync / dream / boot），防止并发冲突
 * - 管理多作品目录扫描、安全切换与开新书
 * - 提供章节真源读写、Diff、物化视图只读查询与 YOLO 连跑控制
 * - 维护 SSE 遥测/阶段广播与 .ops/telemetry.jsonl 增量追踪
 * - 处理 Safe-Point 停机请求并在停机时等待收尾、确保 .ops/tx.lock 释放
 */
export class NarrateRuntimeController {
    readonly booksRoot: string;
    private _bookRoot: string;
    private store: BookStore;
    private engine: NarrativeEngine;
    private dreamingRunner: DreamingRunner;
    private readonly llm: LlmPort | undefined;
    private readonly system: SystemPort;

    private activeTask: RuntimeTaskKind = 'IDLE';
    private haltRequested = false;
    private shuttingDown = false;
    private activeAbortController: AbortController | null = null;
    private activePromise: Promise<unknown> | null = null;

    private readonly yoloState: YoloRuntimeState = {
        running: false,
        stopRequested: false,
        completedChapters: 0,
        targetChapters: 0,
        currentStage: null,
        loopPromise: null
    };

    private readonly sseClients = new Set<ServerResponse>();
    private telemetryOffsetLines = 0;
    private signalsConsumedLines = 0;
    private readonly shutdownTimeoutMs: number;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    constructor(deps: NarrateControllerDeps) {
        this._bookRoot = resolve(deps.bookRoot);
        this.booksRoot = resolve(deps.booksRoot ?? dirname(this._bookRoot));
        this.store = deps.store;
        this.engine = deps.engine;
        this.dreamingRunner = deps.dreamingRunner;
        this.llm = deps.llm;
        this.system = deps.system ?? new NodeSystemAdapter();
        this.shutdownTimeoutMs = deps.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

        const heartbeatMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        if (heartbeatMs > 0) {
            this.heartbeatTimer = setInterval(() => {
                this.sendHeartbeat();
            }, heartbeatMs);
            this.heartbeatTimer.unref?.();
        }
    }

    get bookRoot(): string {
        return this._bookRoot;
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
        const raw = await readOptionalText(join(this._bookRoot, '.ops/telemetry.jsonl'));
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

    /** 统计 .ops/signals.jsonl 中未消费信号数量 */
    private async countPendingSignals(): Promise<number> {
        const raw = await readOptionalText(join(this._bookRoot, '.ops/signals.jsonl'));
        const all = parseJsonLines(raw);
        if (all.length < this.signalsConsumedLines) {
            this.signalsConsumedLines = 0;
        }
        return all.length - this.signalsConsumedLines;
    }

    /** 消费并返回自上次检查以来的新增信号 */
    private async consumePendingSignals(): Promise<unknown[]> {
        const raw = await readOptionalText(join(this._bookRoot, '.ops/signals.jsonl'));
        const all = parseJsonLines(raw);
        if (all.length < this.signalsConsumedLines) {
            this.signalsConsumedLines = 0;
        }
        const pending = all.slice(this.signalsConsumedLines);
        this.signalsConsumedLines = all.length;
        return pending;
    }

    /** 切换当前活跃作品目录并重建存储与引擎实例 */
    async switchBook(nextBookRoot: string): Promise<{ bookRoot: string }> {
        if (this.activeTask !== 'IDLE' || this.yoloState.running) {
            throw new TaskConflictError(`当前正在执行任务 (${this.activeTask})，禁止切换作品`);
        }

        const currentLockExists = await pathExists(join(this._bookRoot, '.ops/tx.lock'));
        if (currentLockExists) {
            throw new TxLockConflictError('当前作品持有 .ops/tx.lock，禁止切换作品');
        }

        const resolved = resolve(nextBookRoot);
        if (!isSubPath(this.booksRoot, resolved)) {
            throw new PathValidationError('目标作品路径必须位于 booksRoot 目录之内');
        }

        const valid = await isValidBookDirectory(resolved);
        if (!valid) {
            throw new NotFoundError(`无效的作品目录（缺少 world/book_config.yaml 或 .ops/tx_state.json）: ${resolved}`);
        }

        const nextStore = new BookStore(resolved, this.system);
        this._bookRoot = resolved;
        this.store = nextStore;
        if (this.llm) {
            this.engine = new NarrativeEngine({ store: nextStore, llm: this.llm, system: this.system });
            this.dreamingRunner = new DreamingRunner(nextStore, this.llm, this.system);
        }
        this.telemetryOffsetLines = 0;
        this.signalsConsumedLines = 0;

        this.emitEvent('book_switched', {
            bookRoot: this._bookRoot,
            timestamp: new Date().toISOString()
        });
        return { bookRoot: this._bookRoot };
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

    /** 停机先停止接单并等待任务结束；超时只告警，不提前释放锁或消费资源。 */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.requestHalt();

        const pendingPromises: Promise<unknown>[] = [];
        if (this.yoloState.loopPromise) {
            pendingPromises.push(this.yoloState.loopPromise.catch(() => {}));
        }
        if (this.activePromise) {
            pendingPromises.push(this.activePromise.catch(() => {}));
        }

        if (pendingPromises.length > 0) {
            let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                const timeout = Promise.withResolvers<boolean>();
                timeoutTimer = setTimeout(() => timeout.resolve(false), this.shutdownTimeoutMs);
                timeoutTimer.unref?.();
                const settled = await Promise.race([
                    Promise.all(pendingPromises).then(() => true),
                    timeout.promise
                ]);
                if (!settled) {
                    this.emitEvent('halt:waiting', { activeTask: this.activeTask, timestamp: new Date().toISOString() });
                    await Promise.all(pendingPromises);
                }
            } finally {
                if (timeoutTimer !== undefined) {
                    clearTimeout(timeoutTimer);
                }
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


    private async assertNoActiveTxLock(message: string): Promise<void> {
        const lockPath = join(this._bookRoot, '.ops/tx.lock');
        const raw = await readOptionalText(lockPath);
        if (raw === null) return;

        let active = false;
        try {
            const parsed = TxLockPayloadSchema.safeParse(JSON.parse(raw));
            if (parsed.success) {
                let alive = false;
                try {
                    process.kill(parsed.data.pid, 0);
                    alive = true;
                } catch (err: unknown) {
                    alive = !(err !== null && typeof err === 'object' && 'code' in err && err.code === 'ESRCH');
                }
                active = alive;
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
        if (this.shuttingDown) {
            throw new Error('插件正在停机中，拒绝启动新任务');
        }
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
            }
        })();

        this.activePromise = promise;
        return await promise;
    }

    /** GET /api/narrate/books */
    async handleBooks(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'GET')) return;

        try {
            const entries = await readdir(this.booksRoot, { withFileTypes: true });
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
                    // 仅含 tx_state.json 的目录使用目录名兜底
                }

                try {
                    const txState = await candidateStore.readTxState();
                    walPhase = txState.phase;
                    currentChapter = txState.last_committed_ch;
                } catch {
                    // 忽略损坏的 tx_state
                }

                try {
                    const worldState = await candidateStore.readWorldState();
                    storyDay = worldState.frontmatter.story_day;
                    if (currentChapter === 0) {
                        currentChapter = worldState.frontmatter.current_chapter;
                    }
                } catch {
                    // 忽略缺失的 world_state
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
            sendJson(res, 200, {
                currentBookRoot: this._bookRoot,
                books
            });
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** POST /api/narrate/book/select */
    async handleBookSelect(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        let targetRoot: string;
        if (typeof body['bookRoot'] === 'string' && body['bookRoot'].trim().length > 0) {
            targetRoot = resolve(this.booksRoot, body['bookRoot']);
        } else if (typeof body['slug'] === 'string' && body['slug'].trim().length > 0) {
            const slug = body['slug'].trim();
            if (!SLUG_RE.test(slug)) {
                sendJson(res, 400, { error: 'slug 格式非法，仅允许字母、数字、下划线与连字符' });
                return;
            }
            targetRoot = resolve(this.booksRoot, slug);
        } else {
            sendJson(res, 400, { error: '缺少必填参数 bookRoot 或 slug' });
            return;
        }

        if (!isSubPath(this.booksRoot, targetRoot)) {
            sendJson(res, 400, { error: '禁止路径穿越：目标作品必须位于 booksRoot 目录之内' });
            return;
        }

        try {
            const switched = await this.switchBook(targetRoot);
            sendJson(res, 200, {
                status: 'SWITCHED',
                bookRoot: switched.bookRoot
            });
        } catch (err) {
            if (err instanceof TaskConflictError || err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            if (err instanceof PathValidationError) {
                sendJson(res, 400, { error: err.message });
                return;
            }
            if (err instanceof NotFoundError) {
                sendJson(res, 404, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** POST /api/narrate/boot */
    async handleBoot(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const slug = typeof body['slug'] === 'string' ? body['slug'].trim() : '';
        const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
        const povCharacter = typeof body['povCharacter'] === 'string' ? body['povCharacter'].trim() : '';
        const mode = body['mode'];

        if (!slug || !SLUG_RE.test(slug)) {
            sendJson(res, 400, { error: 'slug 必填且仅允许字母、数字、下划线与连字符' });
            return;
        }
        if (!title || !povCharacter) {
            sendJson(res, 400, { error: '缺少必填参数 title 或 povCharacter' });
            return;
        }
        if (mode !== 'original' && mode !== 'fanfic') {
            sendJson(res, 400, { error: 'mode 必须为 original 或 fanfic' });
            return;
        }
        if (!this.llm) {
            sendJson(res, 500, { error: '未配置 LlmPort，无法执行开书编译' });
            return;
        }

        const targetRoot = resolve(this.booksRoot, slug);
        if (!isSubPath(this.booksRoot, targetRoot)) {
            sendJson(res, 400, { error: '禁止路径穿越' });
            return;
        }

        const llm = this.llm;
        try {
            if (this.yoloState.running) {
                throw new TaskConflictError('YOLO 连跑正在执行中，禁止开新书');
            }
            const currentLockExists = await pathExists(join(this._bookRoot, '.ops/tx.lock'));
            if (currentLockExists) {
                throw new TxLockConflictError('当前作品持有 .ops/tx.lock，禁止开新书');
            }

            const bootResult = await this.runExclusiveTask('BOOTING', async (signal) => {
                const resData = await bootBook(
                    {
                        bookRoot: targetRoot,
                        bookSlug: slug,
                        title,
                        povCharacter,
                        mode: mode as BootMode,
                        ...(typeof body['premiseOrSeed'] === 'string'
                            ? { premiseOrSeed: body['premiseOrSeed'] }
                            : {}),
                        ...(typeof body['sourceMaterial'] === 'string'
                            ? { sourceMaterial: body['sourceMaterial'] }
                            : {}),
                        ...(typeof body['t0Anchor'] === 'string' ? { t0Anchor: body['t0Anchor'] } : {})
                    },
                    {
                        llm,
                        system: this.system,
                        signal
                    }
                );
                return resData;
            });

            await this.switchBook(targetRoot);
            sendJson(res, 201, {
                status: 'BOOTED',
                bookRoot: targetRoot,
                result: bootResult
            });
        } catch (err) {
            if (err instanceof TaskConflictError || err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
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

            const pendingSignalsCount = await this.countPendingSignals();

            sendJson(res, 200, {
                bookRoot: this._bookRoot,
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
                modelRouting: resolveStatusModelRouting(snapshot.config.model_routing),
                pendingSignalsCount,
                yolo: {
                    running: this.yoloState.running,
                    completedChapters: this.yoloState.completedChapters,
                    targetChapters: this.yoloState.targetChapters,
                    currentStage: this.yoloState.currentStage
                },
                runtime: {
                    activeTask: this.activeTask,
                    haltRequested: this.haltRequested
                }
            });
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** GET /api/narrate/chapters */
    async handleChapters(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'GET')) return;

        try {
            const manuscriptsDir = join(this._bookRoot, 'manuscripts');
            let fileNames: string[] = [];
            try {
                fileNames = await readdir(manuscriptsDir);
            } catch (err: unknown) {
                if ((err as { code?: string }).code !== 'ENOENT') {
                    throw err;
                }
            }

            const dirtyList = await this.store.detectDirtyChapters();
            const dirtySet = new Set(dirtyList.map((d) => d.chapterNumber));

            const chapters: Array<{
                chapterNumber: number;
                fileName: string;
                title: string;
                charCount: number;
                sha256: string;
                dirty: boolean;
                commitSha: string | null;
            }> = [];

            const matchedFiles = fileNames
                .map((fileName) => {
                    const m = CHAPTER_FILE_RE.exec(fileName);
                    return m?.[1] ? { fileName, chapterNumber: Number(m[1]) } : null;
                })
                .filter((item): item is { fileName: string; chapterNumber: number } => item !== null)
                .sort((a, b) => a.chapterNumber - b.chapterNumber);

            for (const item of matchedFiles) {
                const relPath = `manuscripts/${item.fileName}`;
                const content = await readFile(join(this._bookRoot, relPath), 'utf8');
                const gitShaOut = await runGitCommand(this._bookRoot, ['log', '-n', '1', '--format=%H', '--', relPath]);
                const commitSha = gitShaOut && gitShaOut.trim().length > 0 ? gitShaOut.trim() : null;

                chapters.push({
                    chapterNumber: item.chapterNumber,
                    fileName: item.fileName,
                    title: extractChapterTitle(content, item.chapterNumber),
                    charCount: content.length,
                    sha256: computeSha256(content),
                    dirty: dirtySet.has(item.chapterNumber),
                    commitSha
                });
            }

            sendJson(res, 200, { chapters });
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** GET | PUT /api/narrate/chapter */
    async handleChapter(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, ['GET', 'PUT'])) return;
        if (req.method === 'GET') {
            await this.handleGetChapter(req, res);
        } else {
            await this.handlePutChapter(req, res);
        }
    }

    private async handleGetChapter(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const chParam = url.searchParams.get('ch');
        const chNum = Number(chParam);
        if (!chParam || !Number.isInteger(chNum) || chNum <= 0) {
            sendJson(res, 400, { error: '查询参数 ch 必须为正整数' });
            return;
        }

        const fileName = formatChapterFileName(chNum);
        const relPath = `manuscripts/${fileName}`;
        const fullPath = resolve(this._bookRoot, relPath);
        if (!isSubPath(this._bookRoot, fullPath)) {
            sendJson(res, 400, { error: '非法章节路径' });
            return;
        }

        const content = await readOptionalText(fullPath);
        if (content === null) {
            sendJson(res, 404, { error: `第 ${chNum} 章文件不存在` });
            return;
        }

        try {
            const txState = await this.store.readTxState();
            const sha256 = computeSha256(content);
            const recordedHash = txState.chapter_hashes[formatChapterFileName(chNum).replace(/\.md$/, '')] ?? null;
            const dirty = recordedHash === null || recordedHash !== sha256;
            const diffOut = await runGitCommand(this._bookRoot, ['diff', 'HEAD', '--', relPath]);

            sendJson(res, 200, {
                chapterNumber: chNum,
                content,
                dirty,
                sha256,
                diffFromHead: diffOut ?? ''
            });
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    private async handlePutChapter(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const chNum = body['chapterNumber'];
        const content = body['content'];
        if (typeof chNum !== 'number' || !Number.isInteger(chNum) || chNum <= 0 || chNum > 9999) {
            sendJson(res, 400, { error: 'chapterNumber 必须为 1 到 9999 的整数' });
            return;
        }
        if (typeof content !== 'string') {
            sendJson(res, 400, { error: 'content 必须为字符串' });
            return;
        }

        const fileName = formatChapterFileName(chNum);
        const fullPath = resolve(this._bookRoot, 'manuscripts', fileName);
        if (!isSubPath(this._bookRoot, fullPath)) {
            sendJson(res, 400, { error: '非法章节路径' });
            return;
        }

        try {
            if (this.yoloState.running) {
                throw new TaskConflictError('YOLO 连跑正在执行中，禁止在线编辑章节');
            }
            await this.assertNoActiveTxLock('当前作品持有 .ops/tx.lock，禁止在线编辑章节');

            const syncRes = await this.runExclusiveTask('SYNCING', async (signal) => this.store.runWithTxLock(async () => {
                const original = await readOptionalText(fullPath);
                if (original === null) {
                    sendJson(res, 404, { error: '只能编辑已有章节，不能通过保存接口创建新章' });
                    return null;
                }
                const backupDir = join(this._bookRoot, '.ops/manual_edits');
                await mkdir(backupDir, { recursive: true });
                const backupPath = join(backupDir, `${randomUUID()}.json`);
                await writeFile(backupPath, JSON.stringify({ chapterNumber: chNum, original, pending: content }), 'utf8');
                await writeFile(fullPath, content, 'utf8');

                this.emitEvent('sync:started', {
                    chapterNumber: chNum,
                    timestamp: new Date().toISOString()
                });
                const result = await this.engine.syncManuscripts({ signal });
                this.emitEvent('chapter_synced', {
                    chapterNumber: chNum,
                    status: result.status,
                    dirtyChapters: result.dirtyChapters.length,
                    downstreamConflicts: result.downstreamConflicts.length,
                    timestamp: new Date().toISOString()
                });
                await rm(backupPath);
                return result;
            }));
            if (syncRes === null) return;

            sendJson(res, 200, {
                chapterNumber: chNum,
                sync: syncRes
            });
        } catch (err) {
            if (err instanceof TaskConflictError || err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** GET /api/narrate/views?kind=entities|horizon|threads|telemetry|signals|halt|status */
    async handleViews(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'GET')) return;

        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const kind = url.searchParams.get('kind');

        try {
            switch (kind) {
                case 'entities': {
                    const snapshot = await this.store.loadSnapshot();
                    const entities = Object.values(snapshot.entities).map((profile) => ({
                        entityId: profile.metadata.entity_id,
                        canonicalName: profile.metadata.canonical_name,
                        aliases: profile.metadata.unique_aliases,
                        lastSeenChapter: profile.metadata.last_seen_ch,
                        markdown: serializeEntityMarkdown(profile)
                    }));
                    sendJson(res, 200, {
                        kind: 'entities',
                        entities,
                        coldArchiveCount: snapshot.coldArchiveIds.length,
                        coldArchiveIds: snapshot.coldArchiveIds
                    });
                    return;
                }
                case 'horizon': {
                    const content = await readOptionalText(join(this._bookRoot, 'world/future_horizon.md'));
                    sendJson(res, 200, { kind: 'horizon', content: content ?? '' });
                    return;
                }
                case 'threads': {
                    const content = await readOptionalText(join(this._bookRoot, 'world/open_threads.md'));
                    sendJson(res, 200, { kind: 'threads', content: content ?? '' });
                    return;
                }
                case 'telemetry': {
                    const raw = await readOptionalText(join(this._bookRoot, '.ops/telemetry.jsonl'));
                    sendJson(res, 200, { kind: 'telemetry', entries: parseJsonLines(raw) });
                    return;
                }
                case 'signals': {
                    const raw = await readOptionalText(join(this._bookRoot, '.ops/signals.jsonl'));
                    const all = parseJsonLines(raw);
                    const consumed = Math.min(this.signalsConsumedLines, all.length);
                    sendJson(res, 200, {
                        kind: 'signals',
                        signals: all,
                        pending: all.slice(consumed),
                        pendingCount: all.length - consumed
                    });
                    return;
                }
                case 'halt': {
                    const safeHaltRaw = await readOptionalText(join(this._bookRoot, '.ops/safe_halt.json'));
                    const quarantineRaw = await readOptionalText(join(this._bookRoot, '.ops/quarantine_report.json'));
                    sendJson(res, 200, {
                        kind: 'halt',
                        safeHalt: safeHaltRaw ? (JSON.parse(safeHaltRaw) as unknown) : null,
                        quarantineReport: quarantineRaw ? (JSON.parse(quarantineRaw) as unknown) : null
                    });
                    return;
                }
                case 'status': {
                    await this.handleStatus(req, res);
                    return;
                }
                default:
                    sendJson(res, 400, {
                        error: '无效的视图类型 kind，允许值: entities|horizon|threads|telemetry|signals|halt|status'
                    });
            }
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
            if (this.yoloState.running) {
                throw new TaskConflictError('YOLO 连跑正在执行中，禁止启动单步任务');
            }
            const result = await this.executeSingleStep(stepOptions);
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

    private async executeSingleStep(stepOptions: StepChapterOptions, fromYolo = false) {
        return await this.runExclusiveTask(
            'STEPPING',
            async (signal) => {
            this.emitEvent('chapter:phase', {
                phase: 'STARTING',
                chapterNumber: stepOptions.chapterNumber ?? null,
                chapterGoal: stepOptions.chapterGoal
            });

            const resData = await this.engine.stepChapter({
                ...stepOptions,
                signal,
                onProgress: (evt) => {
                    if (this.yoloState.running) {
                        this.yoloState.currentStage = evt.stage;
                    }
                    this.emitEvent('stage', {
                        stage: evt.stage,
                        chapterNumber: evt.chapterNumber,
                        message: evt.message,
                        timestamp: evt.timestamp
                    });
                    this.emitEvent('chapter:phase', {
                        phase: evt.stage,
                        chapterNumber: evt.chapterNumber,
                        message: evt.message
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
            return resData;
            },
            { allowDuringYolo: fromYolo }
        );
    }

    /** POST /api/narrate/yolo/start */
    async handleYoloStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const targetChapters =
            body['targetChapters'] === undefined ? 3 : body['targetChapters'];
        if (typeof targetChapters !== 'number' || !Number.isInteger(targetChapters) || targetChapters < 0) {
            sendJson(res, 400, { error: 'targetChapters 必须为非负整数' });
            return;
        }

        const defaultGoal =
            typeof body['defaultGoal'] === 'string' && body['defaultGoal'].trim().length > 0
                ? body['defaultGoal'].trim()
                : DEFAULT_YOLO_GOAL;

        if (this.yoloState.running || this.activeTask !== 'IDLE') {
            sendJson(res, 409, { error: '已有任务或 YOLO 连跑正在执行中' });
            return;
        }

        try {
            await this.assertNoActiveTxLock('当前作品持有 .ops/tx.lock，禁止启动 YOLO 连跑');
        } catch (err) {
            if (err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        this.haltRequested = false;
        this.yoloState.running = true;
        this.yoloState.stopRequested = false;
        this.yoloState.completedChapters = 0;
        this.yoloState.targetChapters = targetChapters;
        this.yoloState.currentStage = 'STARTING';

        this.yoloState.loopPromise = this.runYoloLoop(targetChapters, defaultGoal);

        sendJson(res, 202, {
            status: 'STARTED',
            targetChapters,
            defaultGoal
        });
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
                    const summary = pendingSignals
                        .map((s) => JSON.stringify(s))
                        .join('; ');
                    chapterGoal = `${chapterGoal}\n\n[待响应运维信号] ${summary}`;
                }

                const stepRes = await this.executeSingleStep({ chapterGoal }, true);
                lastNextChapterOptions = Array.isArray(stepRes.nextChapterOptions)
                    ? stepRes.nextChapterOptions
                    : [];
                this.yoloState.completedChapters++;

                if (this.yoloState.stopRequested || this.shuttingDown || this.haltRequested) {
                    this.emitEvent('yolo_halted', {
                        reason: 'STOP_REQUESTED',
                        completedChapters: this.yoloState.completedChapters,
                        timestamp: new Date().toISOString()
                    });
                    return;
                }

                // 每章结束后检查是否触发睡眠 VACUUM（runDreaming 内部自检水位，未达标会跳过）
                this.yoloState.currentStage = 'DREAMING';
                await this.runExclusiveTask(
                    'DREAMING',
                    async (signal) => {
                        const dreamRes = await this.dreamingRunner.runDreaming({
                            currentChapter: stepRes.chapterNumber,
                            signal
                        });
                        if (!dreamRes.skipped) {
                            this.emitEvent('dream:completed', {
                                skipped: dreamRes.skipped,
                                vacuumedEntities: dreamRes.vacuumedEntities,
                                warpedNodesFlipped: dreamRes.warpedNodesFlipped,
                                archivedFiles: dreamRes.archivedFiles
                            });
                        }
                    },
                    { allowDuringYolo: true }
                );
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

    /** POST /api/narrate/yolo/stop */
    async handleYoloStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;
        this.yoloState.stopRequested = true;
        this.emitEvent('yolo:stop_requested', {
            stopRequested: true,
            running: this.yoloState.running,
            completedChapters: this.yoloState.completedChapters,
            currentStage: this.yoloState.currentStage,
            message: '将在当前章安全点完成后停止',
            timestamp: new Date().toISOString()
        });
        sendJson(res, 202, {
            stopRequested: true,
            running: this.yoloState.running,
            completedChapters: this.yoloState.completedChapters
        });
    }

    /** POST /api/narrate/sync */
    async handleSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        try {
            if (this.yoloState.running) {
                throw new TaskConflictError('YOLO 连跑正在执行中，禁止手动同步稿件');
            }
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
            if (this.yoloState.running) {
                throw new TaskConflictError('YOLO 连跑正在执行中，禁止手动触发 Dreaming');
            }
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

    /** POST /api/narrate/volume/advance */
    async handleAdvanceVolume(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'POST')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        try {
            if (this.yoloState.running) {
                throw new TaskConflictError('YOLO 连跑正在执行中，禁止执行换卷操作');
            }
            const result = await this.runExclusiveTask('ADVANCING_VOLUME', async (signal) => {
                await this.assertNoActiveTxLock('存在活跃事务锁，禁止并发执行换卷');
                const advanceOptions: AdvanceVolumeOptions = { signal };
                if (Array.isArray(body['companionEntityIds'])) {
                    advanceOptions.companionEntityIds = body['companionEntityIds'].filter(
                        (item): item is string => typeof item === 'string'
                    );
                }
                if (typeof body['completeBook'] === 'boolean') {
                    advanceOptions.completeBook = body['completeBook'];
                }

                const advanceRes = await this.engine.advanceVolume(advanceOptions);
                this.emitEvent('volume:advanced', advanceRes);
                return advanceRes;
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
        const opsDir = join(this._bookRoot, '.ops');
        await mkdir(opsDir, { recursive: true });
        await appendFile(
            join(opsDir, 'signals.jsonl'),
            `${JSON.stringify(signalRecord)}\n`,
            'utf8'
        );

        this.emitEvent('signal:received', signalRecord);
        sendJson(res, 201, { status: 'QUEUED', signal: signalRecord });
    }

    /** DELETE /api/narrate/signals：按 created_at + reason 撤回一条未消费信号（按内容匹配重写 jsonl，非行号） */
    async handleSignalDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!assertMethod(req, res, 'DELETE')) return;

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const createdAt = typeof body['created_at'] === 'string' ? body['created_at'] : null;
        const reason = typeof body['reason'] === 'string' ? body['reason'] : null;
        if (!createdAt || !reason) {
            sendJson(res, 400, { error: '撤回信号需要 created_at 与 reason 两个匹配字段' });
            return;
        }

        try {
            await this.assertNoActiveTxLock('流水线运行中（.ops/tx.lock），禁止撤回纸条');

            const filePath = join(this._bookRoot, '.ops/signals.jsonl');
            const raw = await readOptionalText(filePath);
            if (raw === null) {
                sendJson(res, 404, { error: '信号队列不存在' });
                return;
            }

            // 保留损坏行原样;仅剔除首条内容完全匹配的记录(下标与 parseJsonLines 的非空行序一致)
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
                        // 损坏行不参与匹配
                    }
                }
                kept.push(trimmed);
            }

            if (removedIdx < 0) {
                sendJson(res, 404, { error: '未找到匹配的待撤回信号（可能已被消费或队列已变化）' });
                return;
            }

            await writeFile(filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
            // 消费游标按删除位点平移:删已消费行则前移一格,删未消费行不动,避免旧信号被重投
            if (removedIdx < this.signalsConsumedLines) {
                this.signalsConsumedLines -= 1;
            }
            this.emitEvent('signal:withdrawn', { created_at: createdAt, reason });
            sendJson(res, 200, { status: 'WITHDRAWN', remaining: kept.length });
        } catch (err) {
            if (err instanceof TxLockConflictError) {
                sendJson(res, 409, { error: err.message });
                return;
            }
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
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
                bookRoot: this._bookRoot,
                activeTask: this.activeTask,
                haltRequested: this.haltRequested,
                yoloRunning: this.yoloState.running,
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

class PathValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PathValidationError';
    }
}

class NotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotFoundError';
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
            path: '/api/narrate/books',
            handler: (req, res) => controller.handleBooks(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/book/select',
            handler: (req, res) => controller.handleBookSelect(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/boot',
            handler: (req, res) => controller.handleBoot(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/status',
            handler: (req, res) => controller.handleStatus(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/chapters',
            handler: (req, res) => controller.handleChapters(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/chapter',
            handler: (req, res) => controller.handleChapter(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/views',
            handler: (req, res) => controller.handleViews(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/step',
            handler: (req, res) => controller.handleStep(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/yolo/start',
            handler: (req, res) => controller.handleYoloStart(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/yolo/stop',
            handler: (req, res) => controller.handleYoloStop(req, res)
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
            path: '/api/narrate/volume/advance',
            handler: (req, res) => controller.handleAdvanceVolume(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/signals',
            handler: (req, res) => controller.handleSignals(req, res)
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/signals/delete',
            handler: (req, res) => controller.handleSignalDelete(req, res)
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

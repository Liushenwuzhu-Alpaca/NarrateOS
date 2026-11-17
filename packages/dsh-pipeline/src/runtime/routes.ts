import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import {
    BookSwitchConflictError,
    serializeEntityMarkdown,
    TxLockConflictError
} from '@narrateos/dsh-book-store';
import {
    AdmissionClosedError,
    NotFoundError,
    PathValidationError,
    TaskConflictError
} from '../errors.js';
import { CHAPTER_FILE_RE, readOptionalText } from '../pipeline/helpers.js';
import type {
    AdvanceVolumeOptions,
    RunDreamingOptions,
    StepChapterOptions
} from '../schemas.js';
import {
    isSubPath,
    isValidBookDirectory,
    resolveStatusModelRouting,
    type NarrateRuntimeController
} from './controller.js';

const execFileAsync = promisify(execFile);
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

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
    sendJson(res, 405, {
        error: `Method Not Allowed, expected ${allowed.join(' | ')}`
    });
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

function sendErrorResponse(res: ServerResponse, err: unknown): void {
    if (
        err instanceof BookSwitchConflictError ||
        err instanceof TaskConflictError ||
        err instanceof TxLockConflictError
    ) {
        sendJson(res, 409, { error: err.message });
        return;
    }
    if (err instanceof AdmissionClosedError) {
        sendJson(res, 503, { error: err.message });
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

/**
 * 动态挂载 NarrateOS 后端 REST 与 SSE 控制面路由到 @deepseek-ai/dsh-host-webserver：
 * - 覆盖 dsh-client-ui-studio 所需全部 /api/narrate/* 接口；
 * - 提供 GET /api/narrate/runs?chapter=... 回填阶段运行会话索引 (.ops/runs.jsonl)；
 * - 提供 GET /api/narrate/events 推送携带 activeSessionId 的 SSE 实时事件。
 */
export function registerNarrateRoutes(
    webServer: Pick<WebServer, 'register'>,
    controller: NarrateRuntimeController
): () => void {
    const handleBooks = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        try {
            const payload = await controller.listBooks();
            sendJson(res, 200, payload);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleBookSelect = async (req: IncomingMessage, res: ServerResponse) => {
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
            targetRoot = resolve(controller.booksRoot, body['bookRoot']);
        } else if (typeof body['slug'] === 'string' && body['slug'].trim().length > 0) {
            const slug = body['slug'].trim();
            if (!SLUG_RE.test(slug)) {
                sendJson(res, 400, {
                    error: 'slug 格式非法，仅允许字母、数字、下划线与连字符'
                });
                return;
            }
            targetRoot = resolve(controller.booksRoot, slug);
        } else {
            sendJson(res, 400, { error: '缺少必填参数 bookRoot 或 slug' });
            return;
        }

        if (!isSubPath(controller.booksRoot, targetRoot)) {
            sendJson(res, 400, {
                error: '禁止路径穿越：目标作品必须位于 booksRoot 目录之内'
            });
            return;
        }

        if (!(await isValidBookDirectory(targetRoot))) {
            sendJson(res, 404, {
                error: `无效的作品目录（缺少 world/book_config.yaml 或 .ops/tx_state.json）: ${targetRoot}`
            });
            return;
        }

        try {
            const switched = await controller.switchBook(targetRoot);
            sendJson(res, 200, {
                status: 'SWITCHED',
                bookRoot: switched.bookRoot
            });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleBoot = async (req: IncomingMessage, res: ServerResponse) => {
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
        const povCharacter =
            typeof body['povCharacter'] === 'string' ? body['povCharacter'].trim() : '';
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

        try {
            const result = await controller.bootBook({
                slug,
                title,
                povCharacter,
                mode,
                ...(typeof body['premiseOrSeed'] === 'string'
                    ? { premiseOrSeed: body['premiseOrSeed'] }
                    : {}),
                ...(typeof body['sourceMaterial'] === 'string'
                    ? { sourceMaterial: body['sourceMaterial'] }
                    : {}),
                ...(typeof body['t0Anchor'] === 'string'
                    ? { t0Anchor: body['t0Anchor'] }
                    : {})
            });
            sendJson(res, 201, {
                status: 'BOOTED',
                bookRoot: result.bookRoot,
                result
            });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleStatus = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        try {
            const store = controller.requireBookStore();
            const snapshot = await store.loadSnapshot();
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

            const pendingSignalsCount = await controller.countPendingSignals();
            const rt = controller.runtimeStatus;

            sendJson(res, 200, {
                bookRoot: store.bookRoot,
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
                modelRouting: resolveStatusModelRouting(
                    controller.poolRouting,
                    snapshot.config.model_routing
                ),
                pendingSignalsCount,
                yolo: rt.yolo,
                runtime: {
                    activeTask: rt.activeTask,
                    haltRequested: rt.haltRequested
                }
            });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleChapters = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        try {
            const list = await controller.listChapters();
            const bookRoot = controller.requireBookStore().bookRoot;
            const enriched = await Promise.all(
                list.chapters.map(async (ch) => {
                    const gitShaOut = await runGitCommand(bookRoot, [
                        'log',
                        '-n',
                        '1',
                        '--format=%H',
                        '--',
                        `manuscripts/${ch.fileName}`
                    ]);
                    return {
                        ...ch,
                        commitSha:
                            gitShaOut && gitShaOut.trim().length > 0
                                ? gitShaOut.trim()
                                : null
                    };
                })
            );
            sendJson(res, 200, { chapters: enriched });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleChapter = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, ['GET', 'PUT'])) return;
        if (req.method === 'GET') {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const chParam = url.searchParams.get('ch');
            const chNum = Number(chParam);
            if (!chParam || !Number.isInteger(chNum) || chNum <= 0) {
                sendJson(res, 400, { error: '查询参数 ch 必须为正整数' });
                return;
            }

            try {
                const store = controller.requireBookStore();
                const bookRoot = store.bookRoot;
                const fileName = `ch_${String(chNum).padStart(4, '0')}.md`;
                const relPath = `manuscripts/${fileName}`;
                const fullPath = resolve(bookRoot, relPath);
                if (!isSubPath(bookRoot, fullPath)) {
                    sendJson(res, 400, { error: '非法章节路径' });
                    return;
                }

                const content = await readOptionalText(fullPath);
                if (content === null) {
                    sendJson(res, 404, { error: `第 ${chNum} 章文件不存在` });
                    return;
                }

                const txState = await store.readTxState();
                const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
                const recordedHash =
                    txState.chapter_hashes[fileName.replace(/\.md$/, '')] ?? null;
                const dirty = recordedHash === null || recordedHash !== sha256;
                const diffOut = await runGitCommand(bookRoot, [
                    'diff',
                    'HEAD',
                    '--',
                    relPath
                ]);
                const outline = await store.readChapterOutline(chNum);

                sendJson(res, 200, {
                    chapterNumber: chNum,
                    content,
                    dirty,
                    sha256,
                    diffFromHead: diffOut ?? '',
                    outlineText: outline.outlineText,
                    outlineStatus: outline.status
                });
            } catch (err) {
                sendErrorResponse(res, err);
            }
            return;
        }

        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const chNum = body['chapterNumber'];
        const content = body['content'];
        if (
            typeof chNum !== 'number' ||
            !Number.isInteger(chNum) ||
            chNum <= 0 ||
            chNum > 9999
        ) {
            sendJson(res, 400, { error: 'chapterNumber 必须为 1 到 9999 的整数' });
            return;
        }
        if (typeof content !== 'string') {
            sendJson(res, 400, { error: 'content 必须为字符串' });
            return;
        }

        try {
            const syncRes = await controller.saveAndSyncChapter(chNum, content);
            if (syncRes === null) {
                sendJson(res, 404, { error: '只能编辑已有章节，不能通过保存接口创建新章' });
                return;
            }
            sendJson(res, 200, {
                chapterNumber: chNum,
                sync: syncRes
            });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleRuns = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const chParam = url.searchParams.get('chapter');
            let chapterFilter: number | undefined;
            if (chParam !== null && chParam.trim().length > 0) {
                const parsed = Number(chParam);
                if (!Number.isInteger(parsed) || parsed < 0) {
                    sendJson(res, 400, { error: '查询参数 chapter 必须为非负整数' });
                    return;
                }
                chapterFilter = parsed;
            }
            const runs = await controller.listRunRecords(chapterFilter);
            sendJson(res, 200, { runs });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleRunDetail = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
            if (sessionId.length === 0) {
                sendJson(res, 400, { error: '缺少必填查询参数 sessionId' });
                return;
            }
            const detail = await controller.getSessionDetail(sessionId);
            if (!detail) {
                sendJson(res, 404, { error: `未找到会话明细: ${sessionId}` });
                return;
            }
            sendJson(res, 200, detail);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleViews = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const kind = url.searchParams.get('kind');

        try {
            const store = controller.requireBookStore();
            const bookRoot = store.bookRoot;

            switch (kind) {
                case 'entities': {
                    const snapshot = await store.loadSnapshot();
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
                    const content = await store.readFutureHorizon();
                    sendJson(res, 200, { kind: 'horizon', content: content ?? '' });
                    return;
                }
                case 'threads': {
                    const content = await store.readOpenThreads();
                    sendJson(res, 200, { kind: 'threads', content: content ?? '' });
                    return;
                }
                case 'telemetry': {
                    const raw = await readOptionalText(join(bookRoot, '.ops/telemetry.jsonl'));
                    sendJson(res, 200, { kind: 'telemetry', entries: parseJsonLines(raw) });
                    return;
                }
                case 'signals': {
                    const raw = await readOptionalText(join(bookRoot, '.ops/signals.jsonl'));
                    const all = parseJsonLines(raw);
                    const pendingCount = await controller.countPendingSignals();
                    const consumed = Math.max(0, all.length - pendingCount);
                    sendJson(res, 200, {
                        kind: 'signals',
                        signals: all,
                        pending: all.slice(consumed),
                        pendingCount
                    });
                    return;
                }
                case 'halt': {
                    const safeHaltRaw = await readOptionalText(
                        join(bookRoot, '.ops/safe_halt.json')
                    );
                    const quarantineRaw = await readOptionalText(
                        join(bookRoot, '.ops/quarantine_report.json')
                    );
                    sendJson(res, 200, {
                        kind: 'halt',
                        safeHalt: safeHaltRaw ? (JSON.parse(safeHaltRaw) as unknown) : null,
                        quarantineReport: quarantineRaw
                            ? (JSON.parse(quarantineRaw) as unknown)
                            : null
                    });
                    return;
                }
                case 'status': {
                    await handleStatus(req, res);
                    return;
                }
                default:
                    sendJson(res, 400, {
                        error: '无效的视图类型 kind，允许值: entities|horizon|threads|telemetry|signals|halt|status'
                    });
            }
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleParallel = async (
        req: IncomingMessage,
        res: ServerResponse,
        action: 'fork' | 'merge'
    ) => {
        if (!assertMethod(req, res, 'POST')) return;
        try {
            const body = await readJsonBody(req);
            const windowId = body['windowId'];
            if (typeof windowId !== 'string' || !SLUG_RE.test(windowId)) {
                sendJson(res, 400, { error: '需要合法 windowId' });
                return;
            }
            const result =
                action === 'fork'
                    ? await controller.forkParallelWindow({ windowId })
                    : await controller.mergeParallelWindow({ windowId });
            sendJson(res, 200, result);
        } catch (err) {
            if (err instanceof AdmissionClosedError) {
                sendErrorResponse(res, err);
                return;
            }
            sendJson(res, 409, {
                error: err instanceof Error ? err.message : String(err)
            });
        }
    };

    const handleStep = async (req: IncomingMessage, res: ServerResponse) => {
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
        if (typeof body['parallelWindowId'] === 'string') {
            stepOptions.parallelWindowId = body['parallelWindowId'];
        }
        if (typeof body['parallelBranchId'] === 'string') {
            stepOptions.parallelBranchId = body['parallelBranchId'];
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
            const result = await controller.stepChapter(stepOptions);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleYoloStart = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        try {
            const started = await controller.startYolo({
                ...(typeof body['targetChapters'] === 'number'
                    ? { targetChapters: body['targetChapters'] }
                    : {}),
                ...(typeof body['defaultGoal'] === 'string'
                    ? { defaultGoal: body['defaultGoal'] }
                    : {})
            });
            sendJson(res, 202, started);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleYoloStop = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        sendJson(res, 202, controller.stopYolo());
    };

    const handleSync = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        try {
            const result = await controller.syncManuscripts();
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleDream = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const dreamOptions: Partial<RunDreamingOptions> = {};
        if (typeof body['currentChapter'] === 'number') {
            dreamOptions.currentChapter = body['currentChapter'];
        }
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

        try {
            const result = await controller.runDreaming(dreamOptions);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleAdvanceVolume = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        const advanceOptions: AdvanceVolumeOptions = {};
        if (Array.isArray(body['companionEntityIds'])) {
            advanceOptions.companionEntityIds = body['companionEntityIds'].filter(
                (item): item is string => typeof item === 'string'
            );
        }
        if (typeof body['completeBook'] === 'boolean') {
            advanceOptions.completeBook = body['completeBook'];
        }

        try {
            const result = await controller.advanceVolume(advanceOptions);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleSignals = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
        }

        try {
            const signalRecord = await controller.enqueueSignal(body);
            sendJson(res, 201, { status: 'QUEUED', signal: signalRecord });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleSignalDelete = async (req: IncomingMessage, res: ServerResponse) => {
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
            const deleted = await controller.deleteSignal(createdAt, reason);
            if (deleted === null) {
                sendJson(res, 404, {
                    error: '未找到匹配的待撤回信号（可能已被消费或队列已变化）'
                });
                return;
            }
            sendJson(res, 200, deleted);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleHalt = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        sendJson(res, 202, controller.requestHalt());
    };

    const handleEvents = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const rt = controller.runtimeStatus;
        res.write('retry: 3000\n\n');
        res.write(
            `event: connected\ndata: ${JSON.stringify({
                bookRoot: controller.bookRoot,
                activeTask: rt.activeTask,
                haltRequested: rt.haltRequested,
                yoloRunning: rt.yolo.running,
                timestamp: new Date().toISOString()
            })}\n\n`
        );

        controller.addSseClient(res);
        const removeClient = () => {
            controller.removeSseClient(res);
        };
        req.on('close', removeClient);
        res.on('close', removeClient);
        res.on('error', removeClient);
    };

    const disposers = [
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/parallel/fork',
            handler: (req, res) => handleParallel(req, res, 'fork')
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/parallel/merge',
            handler: (req, res) => handleParallel(req, res, 'merge')
        }),
        webServer.register({ kind: 'exact', path: '/api/narrate/books', handler: handleBooks }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/book/select',
            handler: handleBookSelect
        }),
        webServer.register({ kind: 'exact', path: '/api/narrate/boot', handler: handleBoot }),
        webServer.register({ kind: 'exact', path: '/api/narrate/status', handler: handleStatus }),
        webServer.register({ kind: 'exact', path: '/api/narrate/chapters', handler: handleChapters }),
        webServer.register({ kind: 'exact', path: '/api/narrate/chapter', handler: handleChapter }),
        webServer.register({ kind: 'exact', path: '/api/narrate/runs', handler: handleRuns }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/runs/detail',
            handler: handleRunDetail
        }),
        webServer.register({ kind: 'exact', path: '/api/narrate/views', handler: handleViews }),
        webServer.register({ kind: 'exact', path: '/api/narrate/step', handler: handleStep }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/yolo/start',
            handler: handleYoloStart
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/yolo/stop',
            handler: handleYoloStop
        }),
        webServer.register({ kind: 'exact', path: '/api/narrate/sync', handler: handleSync }),
        webServer.register({ kind: 'exact', path: '/api/narrate/dream', handler: handleDream }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/volume/advance',
            handler: handleAdvanceVolume
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/signals',
            handler: handleSignals
        }),
        webServer.register({
            kind: 'exact',
            path: '/api/narrate/signals/delete',
            handler: handleSignalDelete
        }),
        webServer.register({ kind: 'exact', path: '/api/narrate/halt', handler: handleHalt }),
        webServer.register({ kind: 'exact', path: '/api/narrate/events', handler: handleEvents })
    ];

    return () => {
        for (const dispose of disposers) {
            dispose();
        }
    };
}

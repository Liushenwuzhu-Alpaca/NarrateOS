import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver';
import { z } from 'zod';
import {
    BookSwitchConflictError,
    NarrationSubjectivitySchema,
    RoleReasoningEffortSchema,
    RoleTierOverrideSchema,
    serializeEntityMarkdown,
    TxLockConflictError,
    type RoleModelOverride
} from '@narrateos/dsh-book-store';
import {
    AdmissionClosedError,
    NotFoundError,
    PathValidationError,
    TaskConflictError,
    ValidationError
} from '../errors.js';
import {
    CHAPTER_FILE_RE,
    formatChapterKey,
    parseJsonLines,
    readOptionalText,
    sha256Hex
} from '../pipeline/helpers.js';
import { conflictRevision } from './heal-report.js';
import {
    SuspectedConflictSchema,
    type AdvanceVolumeOptions,
    type RunDreamingOptions
} from '../schemas.js';
import {
    isSubPath,
    isValidBookDirectory,
    resolveStatusModelRouting,
    type BootFromModalPayload,
    type NarrateRuntimeController,
    type StepChapterInputOptions
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

function safeParseJson(raw: string | null): unknown {
    if (raw === null || raw.trim().length === 0) return null;
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return { malformed: true, raw };
    }
}

async function readJsonBodyOrSend400(
    req: IncomingMessage,
    res: ServerResponse
): Promise<Record<string, unknown> | null> {
    try {
        return await readJsonBody(req);
    } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return null;
    }
}

async function readValidatedJsonBody<TSchema extends z.ZodTypeAny>(
    req: IncomingMessage,
    res: ServerResponse,
    schema: TSchema,
    label: string
): Promise<z.infer<TSchema> | null> {
    const rawBody = await readJsonBodyOrSend400(req, res);
    if (rawBody === null) return null;
    try {
        return parseWithSchema(schema, rawBody, label);
    } catch (err) {
        sendErrorResponse(res, err);
        return null;
    }
}

function pickFirstNumber(
    obj: Record<string, unknown>,
    keys: readonly string[]
): number | undefined {
    for (const key of keys) {
        if (typeof obj[key] === 'number') {
            return obj[key] as number;
        }
    }
    return undefined;
}

function pickFirstString(
    obj: Record<string, unknown>,
    keys: readonly string[]
): string | undefined {
    for (const key of keys) {
        if (typeof obj[key] === 'string') {
            return obj[key] as string;
        }
    }
    return undefined;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并清洗 PUT /api/narrate/model-routing 请求载荷（剥离空字符串与 null 覆盖项，并记录被显式清空的池/角色） */
function parseModelRoutingRequest(body: Record<string, unknown>): {
    model_routing?: Record<string, string> | undefined;
    role_routing?: Record<string, RoleModelOverride> | undefined;
    clearedPools?: string[] | undefined;
    clearedRoles?: string[] | undefined;
} {
    if (body['model_routing'] === undefined && body['role_routing'] === undefined) {
        throw new PathValidationError('请求体至少需要包含 model_routing 或 role_routing');
    }

    const result: {
        model_routing?: Record<string, string> | undefined;
        role_routing?: Record<string, RoleModelOverride> | undefined;
        clearedPools?: string[] | undefined;
        clearedRoles?: string[] | undefined;
    } = {};

    if (body['model_routing'] !== undefined) {
        if (!isPlainObject(body['model_routing'])) {
            throw new PathValidationError('model_routing 必须为键值对对象');
        }
        const cleanedModelRouting: Record<string, string> = {};
        const clearedPools: string[] = [];
        for (const [poolKey, rawVal] of Object.entries(body['model_routing'])) {
            if (rawVal === null || rawVal === undefined) {
                clearedPools.push(poolKey);
                continue;
            }
            if (typeof rawVal !== 'string') {
                throw new PathValidationError(`model_routing.${poolKey} 必须为字符串`);
            }
            const trimmed = rawVal.trim();
            if (trimmed.length > 0) {
                cleanedModelRouting[poolKey] = trimmed;
            } else {
                clearedPools.push(poolKey);
            }
        }
        result.model_routing = cleanedModelRouting;
        if (clearedPools.length > 0) {
            result.clearedPools = clearedPools;
        }
    }

    if (body['role_routing'] !== undefined) {
        if (!isPlainObject(body['role_routing'])) {
            throw new PathValidationError('role_routing 必须为角色覆盖映射对象');
        }
        const cleanedRoleRouting: Record<string, RoleModelOverride> = {};
        const clearedRoles: string[] = [];
        for (const [roleId, rawEntry] of Object.entries(body['role_routing'])) {
            if (rawEntry === null || rawEntry === undefined) {
                clearedRoles.push(roleId);
                continue;
            }
            if (!isPlainObject(rawEntry)) {
                throw new PathValidationError(`role_routing.${roleId} 必须为对象`);
            }

            const cleanedEntry: RoleModelOverride = {};

            if (rawEntry['tier'] !== undefined && rawEntry['tier'] !== null && rawEntry['tier'] !== '') {
                const tierParsed = RoleTierOverrideSchema.safeParse(rawEntry['tier']);
                if (!tierParsed.success) {
                    throw new PathValidationError(
                        `role_routing.${roleId}.tier 非法，仅允许 strong | weak`
                    );
                }
                cleanedEntry.tier = tierParsed.data;
            }

            if (rawEntry['model'] !== undefined && rawEntry['model'] !== null) {
                if (typeof rawEntry['model'] !== 'string') {
                    throw new PathValidationError(`role_routing.${roleId}.model 必须为字符串`);
                }
                const trimmedModel = rawEntry['model'].trim();
                if (trimmedModel.length > 0) {
                    cleanedEntry.model = trimmedModel;
                }
            }

            if (
                rawEntry['reasoning_effort'] !== undefined &&
                rawEntry['reasoning_effort'] !== null &&
                rawEntry['reasoning_effort'] !== ''
            ) {
                const effortParsed = RoleReasoningEffortSchema.safeParse(
                    rawEntry['reasoning_effort']
                );
                if (!effortParsed.success) {
                    throw new PathValidationError(
                        `role_routing.${roleId}.reasoning_effort 非法，仅允许 off | low | medium | high | max`
                    );
                }
                cleanedEntry.reasoning_effort = effortParsed.data;
            }

            if (
                cleanedEntry.tier !== undefined ||
                cleanedEntry.model !== undefined ||
                cleanedEntry.reasoning_effort !== undefined
            ) {
                cleanedRoleRouting[roleId] = cleanedEntry;
            } else {
                clearedRoles.push(roleId);
            }
        }
        result.role_routing = cleanedRoleRouting;
        if (clearedRoles.length > 0) {
            result.clearedRoles = clearedRoles;
        }
    }

    return result;
}

function parseWithSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    body: unknown,
    label: string
): z.infer<TSchema> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        const msg = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || label}: ${issue.message}`)
            .join('; ');
        throw new PathValidationError(`${label} 参数校验失败: ${msg}`);
    }
    return parsed.data;
}

const BookSelectRequestSchema = z.object({
    bookRoot: z.string().trim().min(1).optional(),
    slug: z.string().trim().regex(SLUG_RE, 'slug 格式非法，仅允许字母、数字、下划线与连字符').optional()
});

const BootBookRequestSchema = z.object({
    slug: z.string().trim().regex(SLUG_RE, 'slug 必填且仅允许字母、数字、下划线与连字符'),
    title: z.string().trim().min(1),
    povCharacter: z.string().trim().min(1),
    mode: z.enum(['original', 'fanfic']),
    premiseOrSeed: z.string().optional(),
    sourceMaterial: z.string().optional(),
    t0Anchor: z.string().optional(),
    t0_anchor: z.string().optional(),
    commitments: z.array(z.string().min(1)).optional(),
    excludedCliches: z.array(z.string().min(1)).optional(),
    excluded_cliches: z.array(z.string().min(1)).optional(),
    authorizationBoundary: z.string().optional(),
    authorization_boundary: z.string().optional(),
    narrationSubjectivity: NarrationSubjectivitySchema.optional(),
    narration_subjectivity: NarrationSubjectivitySchema.optional(),
    tokensPerChar: z.number().positive().optional(),
    tokens_per_char: z.number().positive().optional(),
    writerTokenBudget: z.number().int().positive().nullable().optional(),
    writer_token_budget: z.number().int().positive().nullable().optional(),
    maxAutoRollbackChapters: z.number().int().nonnegative().optional(),
    max_auto_rollback_chapters: z.number().int().nonnegative().optional(),
    craftPlugins: z.array(z.string()).optional(),
    craft_plugins: z.array(z.string()).optional(),
    modelRouting: z.record(z.string(), z.string()).optional(),
    model_routing: z.record(z.string(), z.string()).optional()
});

const StepChapterRequestSchema = z.object({
    retry: z.enum(['resume', 'restart']).optional(),
    chapterGoal: z.string().optional(),
    chapterNumber: z.number().int().min(1).max(9999).optional(),
    timelineMode: z.enum(['MAINLINE', 'PARALLEL', 'FLASHBACK']).optional(),
    targetDay: z.number().int().optional(),
    parallelWindowId: z.string().min(1).optional(),
    parallelBranchId: z.string().min(1).optional(),
    povCharIds: z.array(z.string().min(1)).optional()
});

const YoloStartRequestSchema = z.object({
    targetChapters: z.number().int().nonnegative().optional(),
    maxChapters: z.number().int().nonnegative().optional(),
    defaultGoal: z.string().optional()
});

const DreamRequestSchema = z.object({
    currentChapter: z.number().int().nonnegative().optional(),
    force: z.boolean().optional(),
    recentWordDelta: z.number().int().nonnegative().optional(),
    activeEntityIds: z.array(z.string().min(1)).optional()
});

const VoiceHarvestRequestSchema = z.object({
    chapterNumber: z.number().int().min(1).max(9999).optional()
});

const AdvanceVolumeRequestSchema = z.object({
    companionEntityIds: z.array(z.string().min(1)).optional(),
    completeBook: z.boolean().optional()
});

const ParallelWindowRequestSchema = z.object({
    windowId: z.string().regex(SLUG_RE, '需要合法 windowId')
});

const SignalDeleteRequestSchema = z.object({
    created_at: z.string().min(1),
    reason: z.string().min(1)
});

const HaltRequestSchema = z.object({
    force: z.boolean().optional()
});

const HealRequestSchema = z.object({
    selection: z.object({ bookSlug: z.string().min(1), reportRevision: z.string().regex(/^[a-f0-9]{64}$/), conflictIndex: z.number().int().nonnegative() }).strict().optional(),
    resume: z.literal(true).optional(),
    conflicts: z.array(SuspectedConflictSchema).optional(),
    maxAutoRollbackChapters: z.number().int().nonnegative().optional()
}).strict().refine(body => [body.selection, body.resume, body.conflicts].filter(value => value !== undefined).length === 1,
    '请选择一个冲突、提交明确的冲突清单或续跑已有计划');

/** 为 safe_halt / quarantine_report 补齐向后兼容的 snake_case 与 camelCase 双向映射字段 */
function normalizeHaltPayload(
    parsed: unknown,
    defaultKind: 'SAFE_HALT' | 'QUARANTINED'
): unknown {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return parsed;
    }
    const obj = { ...(parsed as Record<string, unknown>) };
    if (obj['malformed'] === true) {
        return obj;
    }

    const chapterVal = pickFirstNumber(obj, ['chapterNumber', 'chapter', 'side_b_chapter']);
    if (chapterVal !== undefined) {
        obj['chapterNumber'] ??= chapterVal;
        obj['chapter'] ??= chapterVal;
        obj['chapter_number'] ??= chapterVal;
    }

    const reasonVal = pickFirstString(obj, ['reason', 'halt_reason', 'message']);
    if (reasonVal !== undefined) {
        obj['reason'] ??= reasonVal;
        obj['halt_reason'] ??= reasonVal;
    }

    const conflictIdVal = pickFirstString(obj, ['conflictId', 'conflict_id']);
    if (conflictIdVal !== undefined) {
        obj['conflictId'] ??= conflictIdVal;
        obj['conflict_id'] ??= conflictIdVal;
    }

    const affectedVal = pickFirstNumber(obj, ['affectedChapters', 'rollback_chapters']);
    if (affectedVal !== undefined) {
        obj['affectedChapters'] ??= affectedVal;
        obj['rollback_chapters'] ??= affectedVal;
    }

    const rollbackWordsVal = pickFirstNumber(obj, ['rollbackWords', 'rollback_words']);
    if (rollbackWordsVal !== undefined) {
        obj['rollbackWords'] ??= rollbackWordsVal;
        obj['rollback_words'] ??= rollbackWordsVal;
    }

    const tsVal = pickFirstString(obj, ['timestamp', 'created_at']);
    if (tsVal !== undefined) {
        obj['timestamp'] ??= tsVal;
        obj['created_at'] ??= tsVal;
    }

    if (typeof obj['side_a_chapter'] === 'number') {
        const chA = formatChapterKey(obj['side_a_chapter']);
        const lineA = typeof obj['side_a_line'] === 'number' ? `:${obj['side_a_line']}` : '';
        obj['leftRef'] ??= `${chA}${lineA}`;
    }
    if (typeof obj['side_b_chapter'] === 'number') {
        const chB = formatChapterKey(obj['side_b_chapter']);
        const lineB = typeof obj['side_b_line'] === 'number' ? `:${obj['side_b_line']}` : '';
        obj['rightRef'] ??= `${chB}${lineB}`;
    }

    const issues = Array.isArray(obj['issues']) ? obj['issues'] : [];
    if (issues.length > 0 && issues[0] && typeof issues[0] === 'object') {
        const first = issues[0] as Record<string, unknown>;
        if (typeof first['source_ref'] === 'string') {
            obj['leftRef'] ??= first['source_ref'];
        }
        if (typeof first['quote_source'] === 'string' && first['quote_source'].trim().length > 0) {
            obj['leftExcerpt'] ??= first['quote_source'];
        }
        if (typeof first['quote_draft'] === 'string' && first['quote_draft'].trim().length > 0) {
            obj['rightExcerpt'] ??= first['quote_draft'];
        }
        if (chapterVal !== undefined) {
            obj['rightRef'] ??= formatChapterKey(chapterVal);
        }
    }

    if (typeof obj['status'] !== 'string') {
        obj['status'] = defaultKind;
    }
    return obj;
}

/** 单次批量 git log 解析全部章节最新提交 SHA，杜绝 N 次并发子进程冲击句柄 */
async function readLatestChapterCommitMap(bookRoot: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['-C', bookRoot, 'log', '--name-only', '--format=__COMMIT__%H', '--', 'manuscripts/'],
            {
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024
            }
        );
        let currentSha: string | null = null;
        for (const rawLine of stdout.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (line.length === 0) continue;
            if (line.startsWith('__COMMIT__')) {
                currentSha = line.slice('__COMMIT__'.length).trim() || null;
                continue;
            }
            if (currentSha && line.startsWith('manuscripts/') && !map.has(line)) {
                map.set(line, currentSha);
            }
        }
    } catch {
        // 无提交历史或非 Git 目录时返回空映射
    }
    return map;
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
    if (err instanceof ValidationError) {
        sendJson(res, 422, { error: err.message });
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
    controller: NarrateRuntimeController,
    resolveController?: (req: IncomingMessage) => Promise<NarrateRuntimeController>
): () => void {
    const routes = buildNarrateRoutes(controller);
    const scopedRoutes = new WeakMap([[controller, routes]]);
    const disposers = routes.map((route, index) => webServer.register({
        ...route,
        async handler(req, res) {
            try {
                const target = resolveController ? await resolveController(req) : controller;
                let entries = scopedRoutes.get(target);
                if (!entries) {
                    entries = buildNarrateRoutes(target);
                    scopedRoutes.set(target, entries);
                }
                await entries[index]!.handler(req, res);
            } catch (error) {
                if (!res.headersSent) sendErrorResponse(res, error);
                else res.end();
            }
        }
    }));
    return () => {
        for (const dispose of disposers) dispose();
    };
}

function buildNarrateRoutes(controller: NarrateRuntimeController): WebRoute[] {
    const handleBooks = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        try {
            const payload = await controller.listBooks();
            sendJson(res, 200, { ...payload, scopeBooksRoot: controller.booksRoot });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleBookSelect = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        const body = await readValidatedJsonBody(req, res, BookSelectRequestSchema, 'book/select');
        if (!body) return;

        let targetRoot: string;
        if (body.bookRoot) {
            targetRoot = resolve(controller.booksRoot, body.bookRoot);
        } else if (body.slug) {
            targetRoot = resolve(controller.booksRoot, body.slug);
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
        const body = await readValidatedJsonBody(req, res, BootBookRequestSchema, 'boot');
        if (!body) return;

        const t0Anchor = body.t0Anchor ?? body.t0_anchor;
        const excludedCliches = body.excludedCliches ?? body.excluded_cliches;
        const authorizationBoundary = body.authorizationBoundary ?? body.authorization_boundary;
        const narrationSubjectivity = body.narrationSubjectivity ?? body.narration_subjectivity;
        const tokensPerChar = body.tokensPerChar ?? body.tokens_per_char;
        const writerTokenBudget =
            body.writerTokenBudget !== undefined
                ? body.writerTokenBudget
                : body.writer_token_budget;
        const maxAutoRollbackChapters =
            body.maxAutoRollbackChapters ?? body.max_auto_rollback_chapters;
        const craftPlugins = body.craftPlugins ?? body.craft_plugins;
        const modelRouting = body.modelRouting ?? body.model_routing;

        const payload: BootFromModalPayload = {
            slug: body.slug,
            title: body.title,
            povCharacter: body.povCharacter,
            mode: body.mode,
            ...(body.premiseOrSeed !== undefined ? { premiseOrSeed: body.premiseOrSeed } : {}),
            ...(body.sourceMaterial !== undefined ? { sourceMaterial: body.sourceMaterial } : {}),
            ...(t0Anchor !== undefined ? { t0Anchor } : {}),
            ...(body.commitments !== undefined ? { commitments: body.commitments } : {}),
            ...(excludedCliches !== undefined ? { excludedCliches } : {}),
            ...(authorizationBoundary !== undefined ? { authorizationBoundary } : {}),
            ...(narrationSubjectivity !== undefined ? { narrationSubjectivity } : {}),
            ...(tokensPerChar !== undefined ? { tokensPerChar } : {}),
            ...(writerTokenBudget !== undefined ? { writerTokenBudget } : {}),
            ...(maxAutoRollbackChapters !== undefined ? { maxAutoRollbackChapters } : {}),
            ...(craftPlugins !== undefined ? { craftPlugins } : {}),
            ...(modelRouting !== undefined ? { modelRouting } : {})
        };

        try {
            const result = await controller.bootBook(payload);
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
            const rt = controller.runtimeStatus;
            if (!controller.bookRoot) {
                const availableModels = await controller.listAvailableModels();
                const roleDefinitions = await controller.resolveRoleDefinitions();
                sendJson(res, 200, {
                    bookRoot: '',
                    bookSlug: '',
                    title: '',
                    walPhase: 'IDLE',
                    activeChapter: null,
                    lastCommittedChapter: 0,
                    latestChapter: 0,
                    chapterCount: 0,
                    entityCount: 0,
                    coldArchiveCount: 0,
                    worldState: {
                        story_day: 0,
                        current_chapter: 0,
                        current_volume: 1,
                        timeline_mode: 'MAINLINE'
                    },
                    defaultModel: controller.getHostDefaultModel(),
                    poolOverrides: controller.resolvePoolOverrides(),
                    modelRouting: resolveStatusModelRouting(controller.poolRouting),
                    roleRouting: controller.getGlobalRoleRouting(),
                    roleDefinitions,
                    availableModels,
                    pendingSignalsCount: 0,
                    yolo: rt.yolo,
                    runtime: {
                        activeTask: rt.activeTask,
                        haltRequested: rt.haltRequested
                    },
                    txLockHeld: false,
                    chapterRetry: null,
                    featCommitSha: null,
                    stateCommitSha: null,
                    recentCommits: { featCommitSha: null, stateCommitSha: null },
                    writerAssemblyReport: null,
                    lastCheckerResult: null,
                    dreamWatermark: null,
                    dirtyEntityCount: 0,
                    dirtyEntityThreshold: 6,
                    spotlightQueue: [],
                    nextChapterOptions: [],
                    nextChapterOptionsSourceChapter: null,
                    openingBeats: null,
                    volumeProgress: null,
                    healPlan: null,
                    syncConflictsCount: 0
                });
                return;
            }

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

            const availableModels = await controller.listAvailableModels(snapshot.config);
            const [pendingSignalsCount, roleDefinitions, diagnostics] = await Promise.all([
                controller.countPendingSignals(),
                controller.resolveRoleDefinitions(snapshot.config, store.bookRoot),
                controller.getDiagnosticsStatus(store, snapshot)
            ]);
            const chapterRetry = !diagnostics.txLockHeld && rt.activeTask === 'IDLE' && !rt.yolo.running
                ? await controller.getChapterRetry(store, snapshot.txState)
                : null;

            sendJson(res, 200, {
                bookRoot: store.bookRoot,
                bookSlug: snapshot.config.book_slug,
                title: snapshot.config.title,
                walPhase: snapshot.txState.phase,
                activeChapter: snapshot.txState.active_chapter,
                lastCommittedChapter: snapshot.txState.last_committed_ch,
                chapterRetry,
                latestChapter,
                chapterCount: snapshot.chapterFiles.length,
                entityCount: Object.keys(snapshot.entities).length,
                coldArchiveCount: snapshot.coldArchiveIds.length,
                worldState: snapshot.worldState.frontmatter,
                defaultModel: controller.getHostDefaultModel(),
                poolOverrides: controller.resolvePoolOverrides(snapshot.config),
                modelRouting: resolveStatusModelRouting(
                    controller.poolRouting,
                    snapshot.config.model_routing
                ),
                roleRouting: controller.resolveEffectiveRoleRouting(snapshot.config),
                roleDefinitions,
                availableModels,
                pendingSignalsCount,
                yolo: rt.yolo,
                runtime: {
                    activeTask: rt.activeTask,
                    haltRequested: rt.haltRequested
                },
                ...diagnostics
            });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleModelRouting = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'PUT')) return;
        const body = await readJsonBodyOrSend400(req, res);
        if (!body) return;

        let parsed: ReturnType<typeof parseModelRoutingRequest>;
        try {
            parsed = parseModelRoutingRequest(body);
        } catch (err) {
            sendErrorResponse(res, err);
            return;
        }

        try {
            const saved = await controller.updateModelRouting(parsed);
            sendJson(res, 200, saved);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleChapters = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        try {
            if (!controller.bookRoot) {
                sendJson(res, 200, { chapters: [] });
                return;
            }
            const list = await controller.listChapters();
            const bookRoot = controller.requireBookStore().bookRoot;
            const commitMap = await readLatestChapterCommitMap(bookRoot);
            const enriched = list.chapters.map((ch) => ({
                ...ch,
                commitSha: commitMap.get(`manuscripts/${ch.fileName}`) ?? null
            }));
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
                const fileName = `${formatChapterKey(chNum)}.md`;
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
                const sha256 = sha256Hex(content);
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
                    bookRoot,
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

        const body = await readJsonBodyOrSend400(req, res);
        if (!body) return;

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

        const bookRoot = body['bookRoot'];
        const baseSha256 = body['baseSha256'];
        if (typeof bookRoot !== 'string' || !bookRoot || typeof baseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(baseSha256)) {
            sendJson(res, 400, { error: '保存需要原作品 bookRoot 和原稿 baseSha256' });
            return;
        }

        try {
            const syncRes = await controller.saveAndSyncChapter(bookRoot, chNum, baseSha256, content);
            if (syncRes === null) {
                sendJson(res, 404, { error: '只能编辑已有章节，不能通过保存接口创建新章' });
                return;
            }
            sendJson(res, 200, {
                chapterNumber: chNum,
                sha256: sha256Hex(content),
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
            const detail = await controller.getSessionDetail(
                sessionId,
                controller.bookRoot ?? undefined
            );
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
            if (kind === 'status') {
                await handleStatus(req, res);
                return;
            }

            if (!controller.bookRoot) {
                switch (kind) {
                    case 'entities':
                        sendJson(res, 200, {
                            kind: 'entities',
                            entities: [],
                            coldArchiveCount: 0,
                            coldArchiveIds: []
                        });
                        return;
                    case 'horizon':
                        sendJson(res, 200, { kind: 'horizon', content: '' });
                        return;
                    case 'threads':
                        sendJson(res, 200, { kind: 'threads', content: '' });
                        return;
                    case 'telemetry':
                        sendJson(res, 200, { kind: 'telemetry', entries: [] });
                        return;
                    case 'signals':
                        sendJson(res, 200, {
                            kind: 'signals',
                            signals: [],
                            pending: [],
                            pendingCount: 0
                        });
                        return;
                    case 'sync_conflicts':
                    case 'conflicts':
                        sendJson(res, 200, {
                            kind: 'sync_conflicts',
                            bookSlug: null,
                            reportRevision: null,
                            syncConflicts: null,
                            conflicts: [],
                            dirtyChapters: [],
                            stateDiffAdvisories: [],
                            updatedAt: null
                        });
                        return;
                    case 'halt':
                        sendJson(res, 200, {
                            kind: 'halt',
                            safeHalt: null,
                            quarantineReport: null
                        });
                        return;
                    default:
                        sendJson(res, 400, {
                            error: '无效的视图类型 kind，允许值: entities|horizon|threads|telemetry|signals|sync_conflicts|halt|status'
                        });
                        return;
                }
            }

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
                    const signalsView = await controller.listSignalsView(bookRoot);
                    sendJson(res, 200, {
                        kind: 'signals',
                        signals: signalsView.signals,
                        pending: signalsView.pending,
                        pendingCount: signalsView.pendingCount
                    });
                    return;
                }
                case 'sync_conflicts':
                case 'conflicts': {
                    const raw = await readOptionalText(join(bookRoot, '.ops/sync_conflicts.json'));
                    const parsed = safeParseJson(raw) as Record<string, unknown> | null;
                    sendJson(res, 200, {
                        kind: 'sync_conflicts',
                        bookSlug: basename(bookRoot),
                        reportRevision: raw === null ? null : conflictRevision(bookRoot, raw),
                        syncConflicts: parsed,
                        conflicts: Array.isArray(parsed?.['conflicts']) ? parsed['conflicts'] : [],
                        dirtyChapters: Array.isArray(parsed?.['dirtyChapters'])
                            ? parsed['dirtyChapters']
                            : [],
                        stateDiffAdvisories: Array.isArray(parsed?.['stateDiffAdvisories'])
                            ? parsed['stateDiffAdvisories']
                            : [],
                        updatedAt: typeof parsed?.['updatedAt'] === 'string' ? parsed['updatedAt'] : null
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
                        safeHalt: normalizeHaltPayload(safeParseJson(safeHaltRaw), 'SAFE_HALT'),
                        quarantineReport: normalizeHaltPayload(
                            safeParseJson(quarantineRaw),
                            'QUARANTINED'
                        )
                    });
                    return;
                }
                case 'status': {
                    await handleStatus(req, res);
                    return;
                }
                default:
                    sendJson(res, 400, {
                        error: '无效的视图类型 kind，允许值: entities|horizon|threads|telemetry|signals|sync_conflicts|halt|status'
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
        const body = await readValidatedJsonBody(req, res, ParallelWindowRequestSchema, 'parallel');
        if (!body) return;

        try {
            const result =
                action === 'fork'
                    ? await controller.forkParallelWindow({ windowId: body.windowId })
                    : await controller.mergeParallelWindow({ windowId: body.windowId });
            sendJson(res, 200, result);
        } catch (err) {
            if (
                err instanceof AdmissionClosedError ||
                err instanceof PathValidationError ||
                err instanceof NotFoundError
            ) {
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
        const body = await readValidatedJsonBody(req, res, StepChapterRequestSchema, 'step');
        if (!body) return;

        try {
            const stepOptions: StepChapterInputOptions = {
                retry: body.retry,
                ...(body.chapterGoal !== undefined ? { chapterGoal: body.chapterGoal } : {}),
                ...(body.chapterNumber !== undefined ? { chapterNumber: body.chapterNumber } : {}),
                ...(body.timelineMode !== undefined ? { timelineMode: body.timelineMode } : {}),
                ...(body.parallelWindowId !== undefined
                    ? { parallelWindowId: body.parallelWindowId }
                    : {}),
                ...(body.parallelBranchId !== undefined
                    ? { parallelBranchId: body.parallelBranchId }
                    : {}),
                ...(body.targetDay !== undefined ? { targetDay: body.targetDay } : {}),
                ...(body.povCharIds !== undefined ? { povCharIds: body.povCharIds } : {})
            };

            const result = await controller.stepChapter(stepOptions);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleYoloStart = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        const body = await readValidatedJsonBody(req, res, YoloStartRequestSchema, 'yolo/start');
        if (!body) return;

        const targetChapters = body.targetChapters ?? body.maxChapters;
        try {
            const started = await controller.startYolo({
                ...(targetChapters !== undefined ? { targetChapters } : {}),
                ...(body.defaultGoal !== undefined ? { defaultGoal: body.defaultGoal } : {})
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
        const body = await readValidatedJsonBody(req, res, DreamRequestSchema, 'dream');
        if (!body) return;

        const dreamOptions: Partial<RunDreamingOptions> = {
            ...(body.currentChapter !== undefined ? { currentChapter: body.currentChapter } : {}),
            ...(body.force !== undefined ? { force: body.force } : {}),
            ...(body.recentWordDelta !== undefined
                ? { recentWordDelta: body.recentWordDelta }
                : {}),
            ...(body.activeEntityIds !== undefined ? { activeEntityIds: body.activeEntityIds } : {})
        };

        try {
            const result = await controller.runDreaming(dreamOptions);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleHeal = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        const body = await readValidatedJsonBody(req, res, HealRequestSchema, 'heal');
        if (!body) return;

        try {
            const healOptions =
                body.maxAutoRollbackChapters !== undefined
                    ? { maxAutoRollbackChapters: body.maxAutoRollbackChapters }
                    : {};
            const result =
                body.conflicts !== undefined
                    ? await controller.healCrossChapterConflicts(body.conflicts, healOptions)
                    : await controller.healFromSyncConflicts(healOptions, body.selection, body.resume);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleVoiceHarvest = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        const body = await readValidatedJsonBody(
            req,
            res,
            VoiceHarvestRequestSchema,
            'voice-harvest'
        );
        if (!body) return;

        try {
            const result = await controller.harvestVoiceFromChapter(body.chapterNumber ?? 1);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleAdvanceVolume = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        const body = await readValidatedJsonBody(
            req,
            res,
            AdvanceVolumeRequestSchema,
            'volume/advance'
        );
        if (!body) return;

        const advanceOptions: AdvanceVolumeOptions = {
            ...(body.companionEntityIds !== undefined
                ? { companionEntityIds: body.companionEntityIds }
                : {}),
            ...(body.completeBook !== undefined ? { completeBook: body.completeBook } : {})
        };

        try {
            const result = await controller.advanceVolume(advanceOptions);
            sendJson(res, 200, result);
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleSignals = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'POST')) return;
        const body = await readJsonBodyOrSend400(req, res);
        if (!body) return;

        try {
            const signalRecord = await controller.enqueueSignal(body);
            sendJson(res, 201, { status: 'QUEUED', signal: signalRecord });
        } catch (err) {
            sendErrorResponse(res, err);
        }
    };

    const handleSignalDelete = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'DELETE')) return;
        const body = await readValidatedJsonBody(
            req,
            res,
            SignalDeleteRequestSchema,
            'signals/delete'
        );
        if (!body) return;

        try {
            const deleted = await controller.deleteSignal(body.created_at, body.reason);
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
        const body = await readValidatedJsonBody(req, res, HaltRequestSchema, 'halt');
        if (!body) return;

        sendJson(res, 202, controller.requestHalt({ force: body.force }));
    };

    const handleEvents = async (req: IncomingMessage, res: ServerResponse) => {
        if (!assertMethod(req, res, 'GET')) return;
        if (controller.isAdmissionClosed) {
            sendErrorResponse(res, new AdmissionClosedError());
            return;
        }
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

    return [
        { kind: 'exact', path: '/api/narrate/parallel/fork', handler: (req, res) => handleParallel(req, res, 'fork') },
        { kind: 'exact', path: '/api/narrate/parallel/merge', handler: (req, res) => handleParallel(req, res, 'merge') },
        { kind: 'exact', path: '/api/narrate/books', handler: handleBooks },
        { kind: 'exact', path: '/api/narrate/book/select', handler: handleBookSelect },
        { kind: 'exact', path: '/api/narrate/boot', handler: handleBoot },
        { kind: 'exact', path: '/api/narrate/status', handler: handleStatus },
        { kind: 'exact', path: '/api/narrate/model-routing', handler: handleModelRouting },
        { kind: 'exact', path: '/api/narrate/chapters', handler: handleChapters },
        { kind: 'exact', path: '/api/narrate/chapter', handler: handleChapter },
        { kind: 'exact', path: '/api/narrate/runs', handler: handleRuns },
        { kind: 'exact', path: '/api/narrate/runs/detail', handler: handleRunDetail },
        { kind: 'exact', path: '/api/narrate/views', handler: handleViews },
        { kind: 'exact', path: '/api/narrate/step', handler: handleStep },
        { kind: 'exact', path: '/api/narrate/yolo/start', handler: handleYoloStart },
        { kind: 'exact', path: '/api/narrate/yolo/stop', handler: handleYoloStop },
        { kind: 'exact', path: '/api/narrate/sync', handler: handleSync },
        { kind: 'exact', path: '/api/narrate/dream', handler: handleDream },
        { kind: 'exact', path: '/api/narrate/heal', handler: handleHeal },
        { kind: 'exact', path: '/api/narrate/voice-harvest', handler: handleVoiceHarvest },
        { kind: 'exact', path: '/api/narrate/volume/advance', handler: handleAdvanceVolume },
        { kind: 'exact', path: '/api/narrate/signals', handler: handleSignals },
        { kind: 'exact', path: '/api/narrate/signals/delete', handler: handleSignalDelete },
        { kind: 'exact', path: '/api/narrate/halt', handler: handleHalt },
        { kind: 'exact', path: '/api/narrate/events', handler: handleEvents }
    ];
}

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import {
    BookStore,
    BookSwitchConflictError,
    NodeSystemAdapter,
    normalizeLlmPool,
    ParallelSandbox,
    parseL2CardSections,
    TxLockConflictError,
    TxLockPayloadSchema,
    TxStateSchema,
    type ActiveLlmPool,
    type LlmPool,
    type BookConfig,
    type BookSnapshot,
    type ForkParallelWindowOptions,
    type MergeParallelWindowOptions,
    type NarrationSubjectivity,
    type NarrateStoreService,
    type ReasoningEffortLevel,
    type RoleModelOverride,
    type SystemPort
} from '@narrateos/dsh-book-store';
import type {
    BootBundleOutput,
    FactCheckIssue,
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
import {
    ChapterPipeline,
    resolveDefaultEngineCraftPluginDir
} from '../pipeline/chapter-pipeline.js';
import { DreamingPipeline } from '../pipeline/dreaming-pipeline.js';
import {
    appendJsonlLineSafe,
    addUsage,
    CHAPTER_FILE_RE,
    clearHealPlan,
    createEmptyUsage,
    formatChapterKey,
    formatVolumeCardRelPath,
    listOpenParallelWindows,
    parseJsonLines,
    readHealPlan,
    readNextChapterOptions,
    readOptionalText,
    readSignalsCursorState,
    resolveConsumedSignalIds,
    resolveSignalId,
    sha256Hex,
    splitNonEmptyLines,
    writeHealPlan,
    type HealPlan
} from '../pipeline/helpers.js';
import { SyncPipeline } from '../pipeline/sync-pipeline.js';
import { harvestVoiceFromChapter } from '../pipeline/voice-harvest.js';
import { VolumePipeline } from '../pipeline/volume-pipeline.js';
import { RoleLoader } from '../roles/role-loader.js';
import {
    DshLlmAdapter,
    parseProviderModelSpec,
    resolveCompatibleReasoningEffort,
    resolveRoleReasoningEffort,
    resolveRoleRoute,
    resolveTierPool
} from '../runner/dsh-llm-adapter.js';
import { RoleRunner } from '../runner/role-runner.js';
import {
    ExtendedRunRecordSchema,
    OpsSignalSchema,
    type AdvanceVolumeOptions,
    type AdvanceVolumeResult,
    type AvailableModelItem,
    type ExtendedRunRecord,
    type HealConflictsOptions,
    type HealConflictsResult,
    type HostDefaultModelSelection,
    type LlmPoolRouting,
    type LlmRouteTarget,
    type OpsSignal,
    type PoolModelOverrides,
    type RoleDefinitionItem,
    type RunDreamingOptions,
    type RunDreamingResult,
    type RuntimeTaskKind,
    type SaveModelRoutingResult,
    type StageSessionDetail,
    type StageSessionEvent,
    type StageSessionEventItem,
    type StepChapterOptions,
    type StepChapterResult,
    type SuspectedConflict,
    type SyncManuscriptsOptions,
    type SyncManuscriptsResult,
    type VoiceHarvestResult,
    type WriterAssemblyReport,
    type YoloRuntimeState
} from '../schemas.js';
import { acknowledgeConflict, conflictRevision, parseConflictReport, reportConflict, type SyncConflictSelection } from './heal-report.js';

const execFileAsync = promisify(execFile);
const MAX_SYMLINK_DEPTH = 32;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const LIGHTWEIGHT_FALLBACK_PROVIDER = 'deepseek-official';
const LIGHTWEIGHT_FALLBACK_MODEL = 'deepseek-chat';
export const DEFAULT_YOLO_GOAL = '按既定主线与人物弧光自然推进下一章';

/** 规范顺序的 8 个标准工种 ID */
export const CANONICAL_ROLE_IDS = [
    'librarian',
    'planner',
    'writer',
    'patch',
    'fact-checker',
    'extractor',
    'dreamer',
    'boot-compiler'
] as const;

const CANONICAL_ROLE_DEFAULT_POOLS: Record<(typeof CANONICAL_ROLE_IDS)[number], ActiveLlmPool> = {
    librarian: 'fast_retrieval',
    planner: 'strong_creative',
    writer: 'strong_creative',
    patch: 'strong_creative',
    'fact-checker': 'strong_creative',
    extractor: 'fast_retrieval',
    dreamer: 'strong_creative',
    'boot-compiler': 'strong_creative'
};

export interface PluginPoolRouteOverride {
    provider?: string | undefined;
    model?: string | undefined;
}

export interface PluginPoolRoutingOverrides {
    strong_creative?: PluginPoolRouteOverride | undefined;
    fast_retrieval?: PluginPoolRouteOverride | undefined;
}

export interface NarrateControllerConfig {
    bookRoot?: string | undefined;
    booksRoot?: string | undefined;
    presetRoot?: string | undefined;
    poolRouting?: LlmPoolRouting | undefined;
    poolRoutingOverrides?: PluginPoolRoutingOverrides | undefined;
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
    commitments?: string[] | undefined;
    excludedCliches?: string[] | undefined;
    authorizationBoundary?: string | undefined;
    narrationSubjectivity?: NarrationSubjectivity | undefined;
    tokensPerChar?: number | undefined;
    writerTokenBudget?: number | null | undefined;
    maxAutoRollbackChapters?: number | undefined;
    craftPlugins?: string[] | undefined;
    modelRouting?: Record<string, string> | undefined;
}

export interface OpeningBeatProgressItem {
    index: number;
    status: 'PENDING' | 'DONE';
    rawStatus: string;
    completedChapter?: string | undefined;
    text: string;
}

export interface OpeningBeatsProgress {
    total: number;
    completed: number;
    pending: number;
    beats: OpeningBeatProgressItem[];
}

export interface VolumeProgressSummary {
    currentVolume: number;
    volumeLabel: string;
    volumeTitle?: string | undefined;
    completedChapters: number;
    totalChapters: number | null;
    futureHorizon?: string | undefined;
    milestoneLock?: string | undefined;
}

export type StepChapterInputOptions = Omit<StepChapterOptions, 'chapterGoal'> & {
    chapterGoal?: string | undefined;
};

function extractNonEmptyStringField(
    record: Record<string, unknown>,
    keys: readonly string[]
): string | undefined {
    for (const key of keys) {
        const val = record[key];
        if (typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
    }
    return undefined;
}

function extractFirstStringField(
    record: Record<string, unknown>,
    keys: readonly string[]
): string | null {
    for (const key of keys) {
        const val = record[key];
        if (typeof val === 'string') {
            return val;
        }
    }
    return null;
}

function extractIntegerField(
    record: Record<string, unknown>,
    keys: readonly string[]
): number | undefined {
    for (const key of keys) {
        const val = record[key];
        if (typeof val === 'number' && Number.isInteger(val)) {
            return val;
        }
    }
    return undefined;
}

function extractModelId(info: { id?: unknown; model?: unknown } | null | undefined): string {
    if (typeof info?.id === 'string') return info.id;
    if (typeof info?.model === 'string') return info.model;
    return '';
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
    return parts.join('\n').slice(0, 32_000);
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

function resolveRealPathWithFallback(targetPath: string, depth = 0): string | null {
    if (depth > MAX_SYMLINK_DEPTH) {
        return null;
    }
    let current = resolve(targetPath);
    const suffixParts: string[] = [];

    while (true) {
        try {
            const st = lstatSync(current);
            if (st.isSymbolicLink()) {
                const linkTarget = readlinkSync(current);
                const nextTarget = resolve(dirname(current), linkTarget);
                const resolvedTarget = resolveRealPathWithFallback(nextTarget, depth + 1);
                if (resolvedTarget === null) {
                    return null;
                }
                return suffixParts.length > 0
                    ? join(resolvedTarget, ...suffixParts)
                    : resolvedTarget;
            }
            const real = realpathSync(current);
            return suffixParts.length > 0 ? join(real, ...suffixParts) : real;
        } catch (err: unknown) {
            const code = (err as { code?: string }).code;
            if (code !== 'ENOENT') {
                return null;
            }
            const parent = dirname(current);
            if (parent === current) {
                return suffixParts.length > 0 ? join(current, ...suffixParts) : current;
            }
            suffixParts.unshift(basename(current));
            current = parent;
        }
    }
}

export function isSubPath(parentDir: string, candidatePath: string): boolean {
    const parent = resolveRealPathWithFallback(parentDir);
    const target = resolveRealPathWithFallback(candidatePath);
    if (parent === null || target === null) {
        return false;
    }
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

function formatRouteTargetSpec(target: LlmRouteTarget): string {
    const model = target.model.trim();
    const provider = target.provider.trim();
    if (model.includes(':') || provider.length === 0) {
        return model;
    }
    return `${provider}:${model}`;
}

function normalizePluginPoolOverrides(
    config: NarrateControllerConfig
): PluginPoolRoutingOverrides {
    if (config.poolRoutingOverrides) {
        return {
            ...(config.poolRoutingOverrides.strong_creative
                ? { strong_creative: { ...config.poolRoutingOverrides.strong_creative } }
                : {}),
            ...(config.poolRoutingOverrides.fast_retrieval
                ? { fast_retrieval: { ...config.poolRoutingOverrides.fast_retrieval } }
                : {})
        };
    }
    const out: PluginPoolRoutingOverrides = {};
    if (config.poolRouting) {
        for (const pool of ['strong_creative', 'fast_retrieval'] as const) {
            const target = config.poolRouting[pool];
            const provider = target?.provider?.trim() ?? '';
            const model = target?.model?.trim() ?? '';
            if (provider.length > 0 || model.length > 0) {
                out[pool] = { provider, model };
            }
        }
    }
    return out;
}

export function resolveStatusModelRouting(
    poolRouting: LlmPoolRouting,
    configured?: Record<string, string>
): Record<string, string> {
    const routing: Record<string, string> = {};
    for (const pool of ['strong_creative', 'fast_retrieval'] as const) {
        const explicit = configured?.[pool]?.trim();
        if (explicit) {
            routing[pool] = explicit;
        } else {
            routing[pool] = formatRouteTargetSpec(poolRouting[pool]);
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
    public readonly booksRoot: string;

    private readonly explicitPoolOverrides: PluginPoolRoutingOverrides;
    private readonly defaultBookRoot: string | null;
    private readonly pluginSearchDirs: string[];
    private readonly shutdownTimeoutMs: number;
    private readonly sseClients = new Set<ServerResponse>();
    private readonly backgroundPromises = new Set<Promise<unknown>>();
    private readonly activeStageSessions = new Map<string, StageSessionEvent>();
    private readonly signalQueues = new Map<string, Promise<void>>();
    private readonly disposeBookSwitched: () => void;

    private globalModelRouting: Record<string, string> = {};
    private globalRoleRouting: Record<string, RoleModelOverride> = {};
    private discoveredFallbackModel: LlmRouteTarget | null = null;
    private discoveredFallbackLoaded = false;
    private catalogGeneration = 0;
    private modelBroadcastGeneration = 0;
    private lastObservedAgentDefaultKey: string | null = null;
    private pendingSessionDefaultSelection: HostDefaultModelSelection | null = null;
    private activeTask: RuntimeTaskKind = 'IDLE';
    private activeStage: YoloRuntimeState['currentStage'] = null;
    private haltRequested = false;
    private shuttingDown = false;
    private activeAbortController: AbortController | null = null;
    private activePromise: Promise<unknown> | null = null;
    private telemetryOffsetLines = 0;
    private signalsConsumedLines = 0;
    private yoloGeneration = 0;
    private bookSwitchHandledByEvent = false;
    private ensureDefaultBookPromise: Promise<string | null> | null = null;
    private lastWriterAssemblyReport: WriterAssemblyReport | null = null;
    private currentFactCheckerFilteredOutCount = 0;
    private lastCheckerResult: {
        chapter: number;
        passed: boolean;
        issueCount: number;
        issues: FactCheckIssue[];
        filteredOutCount: number;
        replanCount: number;
        rewriteCount: number;
        patchRounds: number;
    } | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    private readonly yoloState: Omit<YoloRuntimeState, 'currentStage'> = {
        running: false,
        stopRequested: false,
        completedChapters: 0,
        targetChapters: 0,
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
        this.explicitPoolOverrides = normalizePluginPoolOverrides(config);
        this.defaultBookRoot =
            config.bookRoot && config.bookRoot.trim().length > 0
                ? resolve(config.bookRoot)
                : null;
        this.booksRoot = resolve(
            config.booksRoot ?? storeService.booksRoot ?? toolsService.booksRoot ?? './books'
        );
        this.pluginSearchDirs =
            config.pluginSearchDirs && config.pluginSearchDirs.length > 0
                ? config.pluginSearchDirs
                : [resolveDefaultEngineCraftPluginDir()];
        this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.roleLoader = new RoleLoader(config.presetRoot);

        const initialPoolRouting = this.poolRouting;
        this.llmAdapter = new DshLlmAdapter(ctx.llm, {
            poolRouting: initialPoolRouting,
            resolvePoolRouting: () => this.poolRouting,
            ensurePoolRoutingReady: () => this.ensurePoolRoutingReady(),
            resolveGlobalRoleRouting: () => this.getGlobalRoleRouting(),
            resolveModelRouting: async () => {
                if (!this.bookRoot) return undefined;
                try {
                    const bookCfg = await this.storeService.openStore(this.bookRoot).readBookConfig();
                    return bookCfg.model_routing;
                } catch {
                    return undefined;
                }
            },
            resolveBookConfig: async () => {
                if (!this.bookRoot) return undefined;
                try {
                    return await this.storeService.openStore(this.bookRoot).readBookConfig();
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
            poolRouting: initialPoolRouting,
            resolvePoolRouting: () => this.poolRouting,
            ensurePoolRoutingReady: () => this.ensurePoolRoutingReady(),
            resolveGlobalRoleRouting: () => this.getGlobalRoleRouting(),
            onStageEvent: (evt) => {
                if (
                    evt.stage === 'FACT_CHECKER' &&
                    evt.kind === 'tool-result' &&
                    evt.toolName === 'yield_verdict' &&
                    evt.status === 'error'
                ) {
                    this.currentFactCheckerFilteredOutCount += 1;
                }
                this.emitEvent('stage:event', evt);
            }
        });

        this.disposeBookSwitched =
            typeof this.storeService.onBookSwitched === 'function'
                ? this.storeService.onBookSwitched(async (event) => {
                      if (this.shuttingDown) return;
                      this.bookSwitchHandledByEvent = true;
                      await this.onBookSwitchedSync(event.nextBookRoot);
                  })
                : () => {};

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

    /** 当前强/弱双池动态生效基础路由 */
    get poolRouting(): LlmPoolRouting {
        return {
            strong_creative: this.resolvePoolTarget('strong_creative'),
            fast_retrieval: this.resolvePoolTarget('fast_retrieval')
        };
    }

    private readAgentDefaultSelection(): HostDefaultModelSelection | null {
        try {
            const ctxRecord = this.ctx as unknown as {
                get?: (name: string) => unknown;
                agentDefaultModel?: unknown;
            };
            const svc =
                (typeof ctxRecord.get === 'function'
                    ? ctxRecord.get('agentDefaultModel')
                    : undefined) ?? ctxRecord.agentDefaultModel;
            if (!svc || typeof svc !== 'object') {
                return null;
            }
            const currentFn = (svc as { currentSelection?: unknown }).currentSelection;
            if (typeof currentFn !== 'function') {
                return null;
            }
            const sel = (currentFn as () => unknown).call(svc) as
                | { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
                | undefined;
            if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') {
                return null;
            }
            const provider = sel.provider.trim();
            const model = sel.model.trim();
            if (provider.length === 0 || model.length === 0) {
                return null;
            }
            const reasoningEffort =
                typeof sel.reasoningEffort === 'string' && sel.reasoningEffort.trim().length > 0
                    ? sel.reasoningEffort.trim()
                    : undefined;
            return {
                provider,
                model,
                ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
            };
        } catch {
            return null;
        }
    }

    /** 读取 DSH 本体当前默认模型选择（未配置时返回 null） */
    getHostDefaultModel(): HostDefaultModelSelection | null {
        const agentSel = this.readAgentDefaultSelection();
        const agentKey = agentSel
            ? `${agentSel.provider}\0${agentSel.model}\0${agentSel.reasoningEffort ?? ''}`
            : null;
        if (this.lastObservedAgentDefaultKey !== agentKey) {
            this.lastObservedAgentDefaultKey = agentKey;
            this.pendingSessionDefaultSelection = null;
        }
        if (this.pendingSessionDefaultSelection) {
            return { ...this.pendingSessionDefaultSelection };
        }
        return agentSel;
    }

    private readFirstRegisteredProviderId(): string | undefined {
        const llm = this.ctx.llm as unknown as {
            listProviders?: () => Array<{ id?: unknown }>;
        };
        if (!llm || typeof llm.listProviders !== 'function') {
            return undefined;
        }
        try {
            const providers = llm.listProviders();
            if (!Array.isArray(providers)) {
                return undefined;
            }
            for (const providerInfo of providers) {
                if (typeof providerInfo?.id === 'string' && providerInfo.id.trim().length > 0) {
                    return providerInfo.id.trim();
                }
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private resolveFallbackBaseTarget(): LlmRouteTarget {
        const hostDefault = this.getHostDefaultModel();
        if (hostDefault) {
            return { provider: hostDefault.provider, model: hostDefault.model };
        }
        if (this.discoveredFallbackModel) {
            return { ...this.discoveredFallbackModel };
        }
        const firstProvider = this.readFirstRegisteredProviderId();
        return {
            provider: firstProvider ?? LIGHTWEIGHT_FALLBACK_PROVIDER,
            model: LIGHTWEIGHT_FALLBACK_MODEL
        };
    }

    private resolvePoolTarget(pool: ActiveLlmPool): LlmRouteTarget {
        const baseDefault = this.resolveFallbackBaseTarget();
        const globalSpec = this.globalModelRouting[pool]?.trim();
        if (globalSpec) {
            const pluginProvider = this.explicitPoolOverrides[pool]?.provider?.trim();
            return parseProviderModelSpec(
                globalSpec,
                pluginProvider || baseDefault.provider
            );
        }
        const pluginOverride = this.explicitPoolOverrides[pool];
        const overrideModel = pluginOverride?.model?.trim() ?? '';
        const overrideProvider = pluginOverride?.provider?.trim() ?? '';
        if (overrideModel.length > 0) {
            return parseProviderModelSpec(
                overrideModel,
                overrideProvider || baseDefault.provider
            );
        }
        if (overrideProvider.length > 0) {
            return { provider: overrideProvider, model: baseDefault.model };
        }
        return baseDefault;
    }

    /** 探测并缓存首个可用 provider/model（仅当未加载且无 agentDefaultModel 时探测） */
    async refreshDiscoveredDefaultModel(): Promise<void> {
        await this.listAvailableModels();
    }

    private async ensurePoolRoutingReady(): Promise<void> {
        if (this.getHostDefaultModel() || this.discoveredFallbackLoaded) {
            return;
        }
        await this.refreshDiscoveredDefaultModel();
    }

    /** 返回无书态全局分角色覆盖快照 */
    getGlobalRoleRouting(): Record<string, RoleModelOverride> {
        return { ...this.globalRoleRouting };
    }

    /** 返回当前有效的分角色路由（单书覆盖优先，未覆盖时继承全局内存路由） */
    resolveEffectiveRoleRouting(
        bookConfig?: Pick<BookConfig, 'role_routing'>
    ): Record<string, RoleModelOverride> {
        return {
            ...this.globalRoleRouting,
            ...(bookConfig?.role_routing ?? {})
        };
    }

    private resolveEffectiveBookConfig(
        bookConfig?: Pick<BookConfig, 'model_routing' | 'role_routing'>
    ): Pick<BookConfig, 'model_routing' | 'role_routing'> {
        const mergedModelRouting = {
            ...this.globalModelRouting,
            ...(bookConfig?.model_routing ?? {})
        };
        const mergedRoleRouting = this.resolveEffectiveRoleRouting(bookConfig);
        return {
            ...(Object.keys(mergedModelRouting).length > 0
                ? { model_routing: mergedModelRouting }
                : {}),
            ...(Object.keys(mergedRoleRouting).length > 0
                ? { role_routing: mergedRoleRouting }
                : {})
        };
    }

    /** 返回强/弱双池的显式覆盖映射（跟随 DSH 默认时省略对应键） */
    resolvePoolOverrides(
        bookConfig?: Pick<BookConfig, 'model_routing'>
    ): PoolModelOverrides {
        const overrides: PoolModelOverrides = {};
        const baseDefault = this.resolveFallbackBaseTarget();

        for (const pool of ['strong_creative', 'fast_retrieval'] as const) {
            const bookVal = bookConfig?.model_routing?.[pool]?.trim();
            if (bookVal) {
                overrides[pool] = bookVal;
                continue;
            }
            const globalVal = this.globalModelRouting[pool]?.trim();
            if (globalVal) {
                overrides[pool] = globalVal;
                continue;
            }
            const pluginOv = this.explicitPoolOverrides[pool];
            const ovModel = pluginOv?.model?.trim() ?? '';
            const ovProvider = pluginOv?.provider?.trim() ?? '';
            if (ovModel.length > 0) {
                overrides[pool] = formatRouteTargetSpec(
                    parseProviderModelSpec(ovModel, ovProvider || baseDefault.provider)
                );
            } else if (ovProvider.length > 0) {
                overrides[pool] = formatRouteTargetSpec({
                    provider: ovProvider,
                    model: baseDefault.model
                });
            }
        }
        return overrides;
    }

    /** 处理宿主主对话会话 model/selection 事件并向 SSE 推送 default_model_changed */
    handleHostSessionModelSelection(selected: HostDefaultModelSelection): void {
        if (this.isAdmissionClosed) return;

        const agentSel = this.readAgentDefaultSelection();
        this.lastObservedAgentDefaultKey = agentSel
            ? `${agentSel.provider}\0${agentSel.model}\0${agentSel.reasoningEffort ?? ''}`
            : null;
        const matchesAgentSel =
            agentSel !== null &&
            agentSel.provider === selected.provider &&
            agentSel.model === selected.model &&
            agentSel.reasoningEffort === selected.reasoningEffort;
        this.pendingSessionDefaultSelection = matchesAgentSel ? null : selected;

        void this.trackBackgroundTask(this.broadcastDefaultModelChanged());
    }

    /** 处理宿主 LLM 适配器或模型目录更新事件并向 SSE 推送 default_model_changed */
    handleHostLlmCatalogUpdated(): void {
        if (this.isAdmissionClosed) {
            return;
        }
        this.catalogGeneration++;
        this.discoveredFallbackLoaded = false;
        this.discoveredFallbackModel = null;
        void this.trackBackgroundTask(this.broadcastDefaultModelChanged());
    }

    /** 汇总最新默认模型与双池状态并广播 SSE default_model_changed */
    async broadcastDefaultModelChanged(): Promise<void> {
        if (this.isAdmissionClosed) {
            return;
        }
        const generation = ++this.modelBroadcastGeneration;
        let bookCfg: Pick<BookConfig, 'model_routing' | 'role_routing'> | undefined;
        let activeRoot: string | undefined;
        if (this.bookRoot) {
            activeRoot = this.bookRoot;
            try {
                bookCfg = await this.storeService.openStore(this.bookRoot).readBookConfig();
            } catch {
                bookCfg = undefined;
            }
        }
        const availableModels = await this.listAvailableModels(bookCfg);
        const roleDefinitions = await this.resolveRoleDefinitions(bookCfg, activeRoot);
        if (this.isAdmissionClosed || generation !== this.modelBroadcastGeneration) {
            return;
        }
        this.emitEvent('default_model_changed', {
            defaultModel: this.getHostDefaultModel(),
            availableModels,
            poolOverrides: this.resolvePoolOverrides(bookCfg),
            modelRouting: resolveStatusModelRouting(this.poolRouting, bookCfg?.model_routing),
            roleDefinitions,
            timestamp: new Date().toISOString()
        });
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
                currentStage: this.activeStage
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

    private runSignalSerialized<T>(bookRoot: string, fn: () => Promise<T>): Promise<T> {
        const key = resolve(bookRoot);
        const prev = this.signalQueues.get(key) ?? Promise.resolve();
        const task = prev.then(fn, fn);
        const settled = task.then(
            () => undefined,
            () => undefined
        );
        this.signalQueues.set(key, settled);
        void settled.finally(() => {
            if (this.signalQueues.get(key) === settled) {
                this.signalQueues.delete(key);
            }
        });
        return task;
    }

    /** 纯只读解析当前激活作品的信号列表与未消费切片（严禁触发任何磁盘写入） */
    async listSignalsView(explicitBookRoot?: string): Promise<{
        signals: unknown[];
        pending: unknown[];
        pendingCount: number;
    }> {
        const bookRoot = explicitBookRoot ?? this.bookRoot;
        if (!bookRoot) {
            return { signals: [], pending: [], pendingCount: 0 };
        }
        const raw = await readOptionalText(join(bookRoot, '.ops/signals.jsonl'));
        const all = parseJsonLines(raw);
        if (all.length === 0) {
            return { signals: [], pending: [], pendingCount: 0 };
        }

        const cursorState = await readSignalsCursorState(bookRoot);
        const consumedIds = new Set<string>(cursorState.consumedIds);
        if (
            consumedIds.size === 0 &&
            cursorState.consumedLines > 0 &&
            cursorState.consumedLines <= all.length
        ) {
            for (let idx = 0; idx < cursorState.consumedLines; idx += 1) {
                const item = all[idx];
                if (item && typeof item === 'object' && !('raw' in item)) {
                    consumedIds.add(resolveSignalId(item as Record<string, unknown>));
                }
            }
        }

        const pending = all.filter((item) => {
            if (!item || typeof item !== 'object' || 'raw' in item) {
                return false;
            }
            const id = resolveSignalId(item as Record<string, unknown>);
            return !consumedIds.has(id);
        });

        return {
            signals: all,
            pending,
            pendingCount: pending.length
        };
    }

    /** 统计 .ops/signals.jsonl 未消费信号条数（100% 纯只读零写盘） */
    async countPendingSignals(): Promise<number> {
        const view = await this.listSignalsView();
        return view.pendingCount;
    }

    private async onBookSwitchedSync(nextBookRoot: string): Promise<void> {
        this.telemetryOffsetLines = 0;
        const cursorState = await readSignalsCursorState(nextBookRoot);
        this.signalsConsumedLines = cursorState.consumedLines;
        this.activeStageSessions.clear();
        this.lastWriterAssemblyReport = null;
        this.lastCheckerResult = null;
        this.currentFactCheckerFilteredOutCount = 0;

        this.emitEvent('book_switched', {
            bookRoot: nextBookRoot,
            timestamp: new Date().toISOString()
        });
    }

    private async switchBookInternal(nextBookRoot: string): Promise<BookStore> {
        this.bookSwitchHandledByEvent = false;
        const switched = await this.storeService.switchBook(nextBookRoot);
        if (!this.bookSwitchHandledByEvent) {
            await this.onBookSwitchedSync(switched.bookRoot);
        }
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
        if (!this.bookRoot) {
            return [];
        }
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
     * 1. 显式传入当前激活 bookRoot 调用 RoleRunner.getSessionDetail(sessionId, bookRoot)；
     * 2. 兼容旧数组格式 .ops/session_logs/<sessionId>.json 与原始 DSH 事件映射；
     * 3. 兜底回查当前 bookRoot 的 .ops/runs.jsonl 元数据。
     */
    async getSessionDetail(
        sessionId: string,
        explicitBookRoot?: string
    ): Promise<StageSessionDetail | null> {
        if (!/^[a-zA-Z0-9_.-]+$/.test(sessionId)) {
            throw new PathValidationError('非法的 sessionId 格式');
        }

        const bookRoot = explicitBookRoot ?? this.bookRoot ?? undefined;
        if (!bookRoot) {
            return null;
        }

        const runnerDetail = await this.roleRunner.getSessionDetail(sessionId, bookRoot);
        if (
            runnerDetail &&
            typeof runnerDetail.sessionId === 'string' &&
            Array.isArray(runnerDetail.events)
        ) {
            if (
                runnerDetail.events.some(
                    (ev) =>
                        ev &&
                        typeof ev === 'object' &&
                        !('kind' in ev) &&
                        'type' in ev
                )
            ) {
                return {
                    ...runnerDetail,
                    events: mapRawSessionEventsToItems(
                        runnerDetail.events,
                        runnerDetail.startedAt ?? new Date(0).toISOString()
                    )
                };
            }
            return runnerDetail;
        }

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
            } catch {
                // 损坏日志回退检查 runs.jsonl
            }
        }

        const runs = await this.listRunRecords();
        const matched = [...runs].reverse().find((r) => r.sessionId === sessionId);
        if (matched) {
            let events: StageSessionEventItem[] = [];
            try {
                const liveAgent = (
                    this.ctx as unknown as {
                        agents?: {
                            get?: (id: string) => { session?: { snapshotEvents?: () => unknown[] } };
                        };
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
                ...(matched.attempt !== undefined ? { attempt: matched.attempt } : {}),
                ...(matched.triggerReason ? { triggerReason: matched.triggerReason } : {}),
                live: matched.status === 'running',
                events
            };
        }

        return null;
    }

    /** 创建单章生产管线实例（合并引擎插件搜索目录与当前作品 plugins/ 目录） */
    private createChapterPipeline(store: BookStore): ChapterPipeline {
        const searchDirs = Array.from(
            new Set([...this.pluginSearchDirs, join(store.bookRoot, 'plugins')])
        );
        return new ChapterPipeline({
            store,
            roleRunner: this.roleRunner,
            roleLoader: this.roleLoader,
            llm: this.llmAdapter,
            system: this.system,
            pluginSearchDirs: searchDirs
        });
    }

    /** 创建手稿增量同步管线实例 */
    private createSyncPipeline(store: BookStore): SyncPipeline {
        return new SyncPipeline({
            store,
            llm: this.llmAdapter,
            system: this.system,
            roleRunner: this.roleRunner
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

    /** 处理工种会话启动事件并向 SSE 推送 stage:session 与 activeSessionId / sessionId / runId */
    private handleStageSession = (evt: StageSessionEvent): void => {
        this.activeStageSessions.set(evt.stage, evt);
        const now = new Date().toISOString();

        this.emitEvent('stage:session', evt);

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
            ...(evt.attempt !== undefined ? { attempt: evt.attempt } : {}),
            ...(evt.triggerReason ? { triggerReason: evt.triggerReason } : {}),
            message: `${evt.role} 运行中`,
            timestamp: now
        });
    };

    /** 读取未显式提供目标时的默认/延续方向（优先衔接 .ops/next_chapter_options.json） */
    private async resolveEffectiveChapterGoal(
        store: BookStore,
        rawGoal?: string,
        context?: StepChapterInputOptions
    ): Promise<string> {
        const trimmed = rawGoal?.trim() ?? '';
        if (trimmed.length > 0 && trimmed !== DEFAULT_YOLO_GOAL) {
            return trimmed;
        }
        try {
            let directions: string[] | undefined;
            if (context?.parallelWindowId && context.parallelBranchId && context.timelineMode !== 'MAINLINE' && context.timelineMode !== 'FLASHBACK') {
                directions = await new ParallelSandbox(store, this.system).getBranchNextOptions(
                    context.parallelWindowId, context.parallelBranchId
                );
            } else {
                const [tx, next] = await Promise.all([store.readTxState(), readNextChapterOptions(store.bookRoot)]);
                if (next && (next.source_chapter === tx.last_committed_ch || next.source_chapter === 0)) {
                    directions = next.options;
                }
            }
            if (directions?.length) {
                const primary = directions[0]!;
                if (directions.length === 1) return primary;
                const restText = directions.slice(1)
                    .map((opt, idx) => `${idx + 2}. ${opt}`)
                    .join('\n');
                return `${primary}\n\n[其余延续候选方向]\n${restText}`;
            }
        } catch {
            // 候选方向缺失或解析失败时安全回退默认目标
        }
        return trimmed.length > 0 ? trimmed : DEFAULT_YOLO_GOAL;
    }

    /** 检查第 1 章校准是否已被确认（.ops/opening_calibration.json confirmed === true） */
    private async isOpeningCalibrationConfirmed(bookRoot: string): Promise<boolean> {
        const raw = await readOptionalText(join(bookRoot, '.ops/opening_calibration.json'));
        if (raw === null) return false;
        try {
            const parsed = JSON.parse(raw) as { confirmed?: unknown };
            return parsed.confirmed === true;
        } catch {
            return false;
        }
    }

    /** 执行单章推进（同步等待完成） */
    async stepChapter(
        options: StepChapterInputOptions,
        context: boolean | { fromYolo?: boolean | undefined; fromHeal?: boolean | undefined } = false
    ): Promise<StepChapterResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        const fromYolo = typeof context === 'boolean' ? context : context.fromYolo === true;
        const fromHeal = typeof context === 'object' && context.fromHeal === true;

        const runCore = async (signal: AbortSignal): Promise<StepChapterResult> => {
            const effectiveGoal = await this.resolveEffectiveChapterGoal(store, options.chapterGoal, options);
            this.activeStageSessions.clear();
            this.emitEvent('chapter:phase', {
                phase: 'STARTING',
                chapterNumber: options.chapterNumber ?? null,
                chapterGoal: effectiveGoal
            });

            let emittedGateInChapter = false;
            let emittedCheckerInChapter = false;
            this.currentFactCheckerFilteredOutCount = 0;

            const pipeline = this.createChapterPipeline(store);
            try {
                const resData = await pipeline.stepChapter({
                    ...options,
                    chapterGoal: effectiveGoal,
                    signal: options.signal ?? signal,
                    onStageSession: (evt) => {
                        this.activeStage = evt.stage;
                        this.handleStageSession(evt);
                        options.onStageSession?.(evt);
                    },
                    onWriterAssembled: (report) => {
                        this.lastWriterAssemblyReport = report;
                        options.onWriterAssembled?.(report);
                    },
                    onGateResult: (gateEvt) => {
                        emittedGateInChapter = true;
                        this.emitEvent('gate:result', {
                            chapter: gateEvt.chapter,
                            passed: gateEvt.passed,
                            clicheDensityPer1k: gateEvt.metrics?.clicheDensityPer1k,
                            mattr500: gateEvt.metrics?.mattr500,
                            kontoyiannisEntropy: gateEvt.metrics?.kontoyiannisEntropy,
                            kontoyiannisHk: gateEvt.metrics?.kontoyiannisEntropy,
                            sentenceLengthCv: gateEvt.metrics?.sentenceLengthCv,
                            recommendedAction: gateEvt.recommendedAction,
                            violations: gateEvt.violations.map((v) => ({
                                rule: v.ruleId,
                                ruleId: v.ruleId,
                                detail: v.message,
                                message: v.message,
                                line: v.line,
                                column: v.column,
                                paragraphIndex: v.paragraphIndex,
                                patched: false
                            }))
                        });
                        options.onGateResult?.(gateEvt);
                    },
                    onCheckerResult: (checkerEvt) => {
                        emittedCheckerInChapter = true;
                        const filteredOutCount = this.currentFactCheckerFilteredOutCount;
                        this.currentFactCheckerFilteredOutCount = 0;
                        const checkerPayload = {
                            chapter: checkerEvt.chapter,
                            passed: checkerEvt.passed,
                            issueCount: checkerEvt.issueCount,
                            issues: checkerEvt.issues,
                            filteredOutCount,
                            replanCount: checkerEvt.replanCount,
                            rewriteCount: checkerEvt.rewriteCount,
                            patchRounds: checkerEvt.patchRounds
                        };
                        this.lastCheckerResult = checkerPayload;
                        this.emitEvent('checker:result', checkerPayload);
                        options.onCheckerResult?.(checkerEvt);
                    },
                    onProgress: (evt) => {
                        this.activeStage = evt.stage;
                        if (!evt.activeSessionId) {
                            // 进入新一轮子调用前清理同阶段上一轮残留会话，避免在 onStageSession 到达前误绑旧 sessionId
                            this.activeStageSessions.delete(evt.stage);
                        }
                        const sessionEvt = this.activeStageSessions.get(evt.stage);
                        const activeSessionId =
                            evt.activeSessionId ?? sessionEvt?.sessionId;
                        const runId = evt.runId ?? sessionEvt?.runId;
                        const attempt = sessionEvt?.attempt;
                        const triggerReason = sessionEvt?.triggerReason;

                        this.emitEvent('stage', {
                            stage: evt.stage,
                            chapterNumber: evt.chapterNumber,
                            message: evt.message,
                            timestamp: evt.timestamp,
                            ...(activeSessionId ? { activeSessionId, sessionId: activeSessionId } : {}),
                            ...(runId ? { runId } : {}),
                            ...(attempt !== undefined ? { attempt } : {}),
                            ...(triggerReason ? { triggerReason } : {})
                        });
                        this.emitEvent('chapter:phase', {
                            phase: evt.stage,
                            chapterNumber: evt.chapterNumber,
                            message: evt.message,
                            ...(activeSessionId ? { activeSessionId, sessionId: activeSessionId } : {}),
                            ...(runId ? { runId } : {}),
                            ...(attempt !== undefined ? { attempt } : {}),
                            ...(triggerReason ? { triggerReason } : {})
                        });
                        options.onProgress?.({
                            ...evt,
                            ...(activeSessionId ? { activeSessionId } : {}),
                            ...(runId ? { runId } : {})
                        });
                    }
                });

                if (resData.writerAssemblyReport) {
                    this.lastWriterAssemblyReport = resData.writerAssemblyReport;
                }
                if (!emittedGateInChapter) {
                    this.emitEvent('gate:result', {
                        chapter: resData.chapterNumber,
                        passed: true,
                        clicheDensityPer1k: resData.telemetry.clicheDensityPer1k,
                        mattr500: resData.telemetry.mattr500,
                        kontoyiannisEntropy: resData.telemetry.kontoyiannisEntropy,
                        kontoyiannisHk: resData.telemetry.kontoyiannisEntropy,
                        sentenceLengthCv: resData.telemetry.sentenceLengthCv,
                        violations: []
                    });
                }
                if (!emittedCheckerInChapter) {
                    const filteredOutCount = this.currentFactCheckerFilteredOutCount;
                    this.currentFactCheckerFilteredOutCount = 0;
                    const fallbackChecker = {
                        chapter: resData.chapterNumber,
                        passed: true,
                        issueCount: 0,
                        issues: [] as FactCheckIssue[],
                        filteredOutCount,
                        replanCount: resData.replanCount,
                        rewriteCount: resData.rewriteCount,
                        patchRounds: resData.patchRounds
                    };
                    this.lastCheckerResult = fallbackChecker;
                    this.emitEvent('checker:result', fallbackChecker);
                }
                this.emitEvent('chapter:phase', {
                    phase: 'COMMITTED',
                    chapterNumber: resData.chapterNumber,
                    manuscriptPath: resData.manuscriptPath,
                    featCommitSha: resData.featCommitSha,
                    stateCommitSha: resData.stateCommitSha,
                    ...(resData.writerAssemblyReport
                        ? { writerAssemblyReport: resData.writerAssemblyReport }
                        : {})
                });
                await this.flushTelemetryEvents();
                const cursorState = await readSignalsCursorState(store.bookRoot);
                this.signalsConsumedLines = cursorState.consumedLines;
                const bookConfig = await store.readBookConfig();
                const awaitingCalibration = resData.chapterNumber === 1 &&
                    bookConfig.opening?.pause_after_chapter_1 === true &&
                    !await this.isOpeningCalibrationConfirmed(store.bookRoot);
                const tx = await store.readTxState();
                if (!fromHeal && !options.parallelWindowId && !options.parallelBranchId &&
                    !awaitingCalibration && !this.haltRequested && !this.shuttingDown &&
                    !(options.signal ?? signal).aborted &&
                    tx.chapter_context?.timelineMode !== 'PARALLEL' &&
                    (await listOpenParallelWindows(store.bookRoot)).length === 0) {
                    await this.executeDreaming(store, {
                        currentChapter: resData.chapterNumber,
                        impactedHorizonEvents: resData.impactedHorizonEvents,
                        signal: options.signal ?? signal,
                        onStageSession: options.onStageSession
                    });
                }
                return resData;
            } catch (err) {
                this.emitEvent('chapter:phase', {
                    phase: 'FAILED',
                    error: err instanceof Error ? err.message : String(err)
                });
                throw err;
            } finally {
                this.activeStage = null;
            }
        };

        if (fromHeal) {
            const healSignal = options.signal ?? this.activeAbortController?.signal ?? new AbortController().signal;
            return await runCore(healSignal);
        }

        return await this.runExclusiveTask('STEPPING', runCore, { allowDuringYolo: fromYolo });
    }

    /** 启动 YOLO 连跑（在任何 await 前同步原子预占运行锁与代数令牌） */
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

        // 在任何 await 前同步预占锁并递增代数令牌，杜绝双击并发穿透与清理竞态
        // 整段连跑登记为在途任务，包括各工种结束后、下一章启动前的空档。
        const runId = this.storeService.beginRun();
        this.yoloGeneration += 1;
        const currentGen = this.yoloGeneration;
        this.haltRequested = false;
        this.yoloState.running = true;
        this.yoloState.stopRequested = false;
        this.yoloState.completedChapters = 0;
        this.yoloState.targetChapters = targetChapters;
        this.activeStage = 'STARTING';

        try {
            await this.assertNoActiveTxLock('当前作品持有 .ops/tx.lock，禁止启动 YOLO 连跑');
            this.assertAdmissionOpen();
        } catch (err) {
            this.storeService.endRun(runId);
            if (this.yoloGeneration === currentGen) {
                this.yoloState.running = false;
                this.yoloState.stopRequested = false;
                this.activeStage = null;
                this.yoloState.loopPromise = null;
            }
            throw err;
        }

        this.yoloState.loopPromise = this.runYoloLoop(targetChapters, defaultGoal, currentGen, runId);

        return {
            status: 'STARTED',
            targetChapters,
            defaultGoal
        };
    }

    private async runYoloLoop(
        targetChapters: number,
        defaultGoal: string,
        currentGen: number,
        runId: string
    ): Promise<void> {
        try {
            while (
                !this.yoloState.stopRequested &&
                !this.shuttingDown &&
                !this.haltRequested &&
                (targetChapters === 0 || this.yoloState.completedChapters < targetChapters)
            ) {
                const store = this.requireBookStore();
                const chapterGoal = await this.resolveEffectiveChapterGoal(store, defaultGoal);
                const stepRes = await this.stepChapter({ chapterGoal }, true);
                this.yoloState.completedChapters += 1;

                if (this.shouldStopYoloLoop()) {
                    this.finalizeStopRequestedYolo();
                    return;
                }

                // Q2: opening.pause_after_chapter_1 为 true 且首章尚未确认校准时，在章末安全点优雅停机
                if (stepRes.chapterNumber === 1) {
                    const bookConfig = await store.readBookConfig();
                    const calibrationConfirmed = await this.isOpeningCalibrationConfirmed(
                        store.bookRoot
                    );
                    if (bookConfig.opening?.pause_after_chapter_1 === true && !calibrationConfirmed) {
                        this.yoloState.stopRequested = true;
                        this.emitEvent('yolo_halted', {
                            reason: 'PAUSE_AFTER_CHAPTER_1',
                            chapterNumber: 1,
                            completedChapters: this.yoloState.completedChapters,
                            message: '第 1 章已定稿，按 opening.pause_after_chapter_1 配置停机等待作者检阅校准',
                            timestamp: new Date().toISOString()
                        });
                        return;
                    }
                }

            }

            if (this.yoloState.stopRequested || this.haltRequested) {
                if (!this.shuttingDown) {
                    this.haltRequested = false;
                }
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
            this.storeService.endRun(runId);
            if (this.yoloGeneration === currentGen) {
                this.yoloState.running = false;
                this.activeStage = null;
                this.yoloState.loopPromise = null;
            }
        }
    }

    private shouldStopYoloLoop(): boolean {
        return this.yoloState.stopRequested || this.shuttingDown || this.haltRequested;
    }

    private finalizeStopRequestedYolo(): void {
        if (!this.shuttingDown) {
            this.haltRequested = false;
        }
        this.emitEvent('yolo_halted', {
            reason: 'STOP_REQUESTED',
            completedChapters: this.yoloState.completedChapters,
            timestamp: new Date().toISOString()
        });
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
            currentStage: this.activeStage,
            message: '将在当前章安全点完成后停止',
            timestamp: new Date().toISOString()
        });
        return {
            stopRequested: true,
            running: this.yoloState.running,
            completedChapters: this.yoloState.completedChapters
        };
    }

    private async persistSyncStateDiffAdvisories(
        bookRoot: string,
        syncRes: SyncManuscriptsResult
    ): Promise<void> {
        const advisories = syncRes.stateDiffAdvisories ?? [];
        const filePath = join(bookRoot, '.ops/sync_conflicts.json');
        const raw = await readOptionalText(filePath);
        if (raw === null && advisories.length === 0) {
            return;
        }
        let existing: Record<string, unknown> = {};
        if (raw !== null && raw.trim().length > 0) {
            try {
                const parsed = JSON.parse(raw) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    existing = parsed as Record<string, unknown>;
                }
            } catch {
                existing = {};
            }
        }
        const merged = {
            updatedAt:
                typeof existing['updatedAt'] === 'string'
                    ? existing['updatedAt']
                    : new Date().toISOString(),
            dirtyChapters: Array.isArray(existing['dirtyChapters'])
                ? existing['dirtyChapters']
                : syncRes.dirtyChapters.map((d) => d.chapterNumber),
            conflicts: Array.isArray(existing['conflicts'])
                ? existing['conflicts']
                : syncRes.downstreamConflicts,
            stateDiffAdvisories: advisories
        };
        await mkdir(join(bookRoot, '.ops'), { recursive: true });
        await writeFile(filePath, `${JSON.stringify(merged, null, 4)}\n`, 'utf8');
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
            const syncPipeline = this.createSyncPipeline(store);
            const syncRes = await syncPipeline.syncManuscripts({
                signal: options.signal ?? signal
            });
            await this.persistSyncStateDiffAdvisories(store.bookRoot, syncRes);
            this.emitEvent('sync:completed', {
                status: syncRes.status,
                dirtyChapters: syncRes.dirtyChapters.length,
                downstreamConflicts: syncRes.downstreamConflicts.length,
                stateDiffAdvisories: syncRes.stateDiffAdvisories ?? []
            });
            return syncRes;
        });
    }

    /** 保存手改章节（落 .ops/manual_edits/ 备份）并触发 Sync */
    async saveAndSyncChapter(
        expectedBookRoot: string,
        chapterNumber: number,
        baseSha256: string,
        content: string
    ): Promise<SyncManuscriptsResult | null> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        const bookRoot = store.bookRoot;
        if (bookRoot !== expectedBookRoot) {
            throw new TaskConflictError('作品已切换，未保存手稿');
        }

        if (!Number.isInteger(chapterNumber) || chapterNumber <= 0 || chapterNumber > 9999) {
            throw new PathValidationError('chapterNumber 必须为 1 到 9999 的整数');
        }

        const fileName = `${formatChapterKey(chapterNumber)}.md`;
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

                if (this.storeService.bookRoot !== expectedBookRoot || sha256Hex(original) !== baseSha256) {
                    throw new TaskConflictError('作品或原稿版本已变更，未保存手稿；请比对当前正文');
                }

                await store.prepareSync();
                if ((await store.readWorldState()).frontmatter.timeline_mode === 'PARALLEL') {
                    throw new TaskConflictError('并行窗口合并前不能保存并同步主线手稿');
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

                const syncPipeline = this.createSyncPipeline(store);
                const result = await syncPipeline.syncManuscripts({ signal });
                await this.persistSyncStateDiffAdvisories(bookRoot, result);
                this.emitEvent('chapter_synced', {
                    chapterNumber,
                    status: result.status,
                    dirtyChapters: result.dirtyChapters.length,
                    downstreamConflicts: result.downstreamConflicts.length,
                    stateDiffAdvisories: result.stateDiffAdvisories ?? [],
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
            async (signal) => this.executeDreaming(store, { ...options, signal: options.signal ?? signal }),
            { allowDuringYolo: fromYolo }
        );
    }

    /** 章末与手动整理共用实现；调用者已持有控制器任务准入权，避免嵌套取锁。 */
    private async executeDreaming(store: BookStore, options: Partial<RunDreamingOptions>): Promise<RunDreamingResult> {
        const txState = await store.readTxState();
        const currentChapter = options.currentChapter ?? txState.last_committed_ch;
        this.activeStage = 'DREAMING';
        this.emitEvent('dream:started', { currentChapter });
        try {
            const dreamRes = await this.createDreamingPipeline(store).runDreaming({
                ...options,
                currentChapter,
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
        } finally {
            this.activeStage = null;
        }
    }

    private async rerunFromHealPlan(
        store: BookStore,
        plan: HealPlan,
        effectiveSignal: AbortSignal
    ): Promise<void> {
        // 以 Git 已提交 WAL 为准，而不是可能在章节提交后尚未来得及推进的提示游标。
        const committed = await this.system.readFileAtRef(store.bookRoot, 'HEAD', '.ops/tx_state.json');
        if (!committed) throw new TaskConflictError('缺少已提交的自愈事务状态');
        const wal = TxStateSchema.parse(JSON.parse(committed));
        const startChapter = wal.last_committed_ch + 1;
        const endChapter = plan.toChapter;
        if (startChapter < plan.fromChapter || startChapter > endChapter + 1 ||
            startChapter < plan.nextChapter || startChapter > plan.nextChapter + 1 ||
            (wal.phase === 'FEAT_COMMITTED' && wal.active_chapter !== startChapter)) {
            throw new TaskConflictError('自愈断点与已提交的章节不一致');
        }
        if (startChapter !== plan.nextChapter) {
            // 先修复落后一章的断点，否则在下一章提交后再次崩溃会让差距累积。
            await writeHealPlan(store.bookRoot, { ...plan, nextChapter: startChapter, updatedAt: new Date().toISOString() });
        }

        for (let ch = startChapter; ch <= endChapter; ch += 1) {
            if (this.haltRequested || this.shuttingDown || effectiveSignal.aborted) {
                await writeHealPlan(store.bookRoot, {
                    conflictId: plan.conflictId,
                    backupTag: plan.backupTag,
                    fromChapter: plan.fromChapter,
                    toChapter: plan.toChapter,
                    nextChapter: ch,
                    constraint: plan.constraint
                });
                if (!this.shuttingDown) {
                    this.haltRequested = false;
                }
                const haltErr = new Error('HEAL_HALT_REQUESTED');
                haltErr.name = 'AbortError';
                throw haltErr;
            }

            const baseGoal = await this.resolveEffectiveChapterGoal(store);
            const chapterGoal = `${baseGoal}\n\n[跨章自愈重跑约束 (${plan.conflictId})]\n${plan.constraint}`;
            const result = await this.stepChapter(
                {
                    chapterNumber: ch,
                    chapterGoal,
                    signal: effectiveSignal
                },
                { fromHeal: true }
            );
            if (result.chapterNumber !== ch) throw new TaskConflictError('重跑章节与自愈计划不符');

            await writeHealPlan(store.bookRoot, {
                conflictId: plan.conflictId,
                backupTag: plan.backupTag,
                fromChapter: plan.fromChapter,
                toChapter: plan.toChapter,
                nextChapter: ch + 1,
                constraint: plan.constraint
            });
        }
    }


    private async executeHealCrossChapterConflictsInTask(
        store: BookStore,
        conflicts: SuspectedConflict[],
        options: HealConflictsOptions,
        signal: AbortSignal
    ): Promise<HealConflictsResult> {
        this.emitEvent('heal:started', {
            conflictCount: conflicts.length,
            timestamp: new Date().toISOString()
        });
        const pipeline = this.createDreamingPipeline(store);
        const effectiveSignal = options.signal ?? signal;

        const defaultOnAutoRerun: NonNullable<HealConflictsOptions['onAutoRerun']> = async (
            ctx
        ) => {
            const diskPlan = await readHealPlan(store.bookRoot);
            if (!diskPlan || diskPlan.conflictId !== ctx.conflict.conflictId || diskPlan.backupTag !== ctx.backupTag) {
                throw new TaskConflictError('未找到本次自愈的持久化断点');
            }
            await this.rerunFromHealPlan(store, diskPlan, effectiveSignal);
            return { success: true, stillConflicting: false };
        };

        const res = await pipeline.healCrossChapterConflicts(conflicts, {
            ...options,
            onAutoRerun: options.onAutoRerun ?? defaultOnAutoRerun,
            signal: effectiveSignal
        });
        this.emitEvent('heal:completed', {
            resultCount: res.results.length,
            quarantined: res.quarantined,
            timestamp: new Date().toISOString()
        });
        return res;
    }

    /** 触发三级跨章自愈（默认挂载基于 .ops/heal_plan.json 的自动重跑闭环） */
    async healCrossChapterConflicts(
        conflicts: SuspectedConflict[],
        options: HealConflictsOptions = {}
    ): Promise<HealConflictsResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        return await this.runExclusiveTask('DREAMING', async (signal) => {
            if (await readHealPlan(store.bookRoot)) throw new TaskConflictError('请先续跑未完成的自愈计划');
            return this.executeHealCrossChapterConflictsInTask(store, conflicts, options, signal);
        });
    }

    /** 从 .ops/heal_plan.json 断点或 .ops/sync_conflicts.json 读取并执行三级跨章自愈 */
    async healFromSyncConflicts(
        options: HealConflictsOptions = {},
        selection?: SyncConflictSelection,
        resumeOnly = false
    ): Promise<HealConflictsResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        return await this.runExclusiveTask('DREAMING', async (signal) => {
            const effectiveSignal = options.signal ?? signal;
            let raw = await readOptionalText(join(store.bookRoot, '.ops/sync_conflicts.json'));
            const report = parseConflictReport(raw);
            const revision = conflictRevision(store.bookRoot, raw);
            if (selection && (selection.bookSlug !== basename(store.bookRoot) || selection.reportRevision !== revision ||
                !Number.isSafeInteger(selection.conflictIndex) || selection.conflictIndex < 0 || selection.conflictIndex >= report.conflicts.length)) {
                throw new TaskConflictError('作品或冲突清单已更新，请刷新后重新确认');
            }
            const pendingPlan = await readHealPlan(store.bookRoot);
            if (pendingPlan) {
                const idx = report.conflicts.findIndex((_, i) => `sync-${revision}-${i}` === pendingPlan.conflictId);
                if (selection && idx !== selection.conflictIndex) throw new TaskConflictError('已有其他冲突的自愈断点');
                this.emitEvent('heal:started', {
                    conflictCount: 1,
                    resumedFromPlan: true,
                    timestamp: new Date().toISOString()
                });
                await this.rerunFromHealPlan(store, pendingPlan, effectiveSignal);
                if (idx >= 0 && raw !== null) await acknowledgeConflict(store, raw, idx);
                await clearHealPlan(store.bookRoot);
                const resumedRes: HealConflictsResult = {
                    results: [
                        {
                            conflictId: pendingPlan.conflictId ?? 'heal-resume',
                            action: 'AUTO_ROLLED_BACK_AND_RERUN',
                            backupTag: pendingPlan.backupTag
                        }
                    ],
                    quarantined: false,
                    quarantineReport: null,
                    usage: createEmptyUsage()
                };
                this.emitEvent('heal:completed', {
                    resultCount: resumedRes.results.length,
                    quarantined: false,
                    resumedFromPlan: true,
                    timestamp: new Date().toISOString()
                });
                return resumedRes;
            }

            if (resumeOnly) throw new TaskConflictError('没有待续跑的自愈计划');
            const aggregate: HealConflictsResult = { results: [], quarantined: false, quarantineReport: null, usage: createEmptyUsage() };
            // 批处理入口也逐项核销，后续失败时不重做已完成的项。
            const count = selection ? 1 : report.conflicts.length;
            for (let i = 0; i < count && raw !== null; i++) {
                const idx = selection?.conflictIndex ?? 0;
                const conflict = reportConflict(parseConflictReport(raw), conflictRevision(store.bookRoot, raw), idx);
                const res = await this.executeHealCrossChapterConflictsInTask(store, [conflict], { ...options, deferPlanCleanup: true }, signal);
                aggregate.results.push(...res.results);
                addUsage(aggregate.usage, res.usage);
                if (res.quarantined) {
                    aggregate.quarantined = true;
                    aggregate.quarantineReport = res.quarantineReport;
                    break;
                }
                raw = await acknowledgeConflict(store, raw, idx);
                if (res.results[0]?.action === 'AUTO_ROLLED_BACK_AND_RERUN') await clearHealPlan(store.bookRoot);
            }
            return aggregate;
        });
    }

    /** 首章校准通过后触发 Voice Harvest 采集表达标本 */
    async harvestVoiceFromChapter(chapterNumber = 1): Promise<VoiceHarvestResult> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        return await this.runExclusiveTask('SYNCING', async (signal) => {
            return await harvestVoiceFromChapter({
                store,
                llm: this.llmAdapter,
                system: this.system,
                pluginSearchDirs: [...new Set([...this.pluginSearchDirs, join(store.bookRoot, 'plugins')])],
                chapterNumber,
                signal
            });
        });
    }

    /** harvestVoiceFromChapter 别名（向后兼容调用方命名） */
    async harvestVoiceSamples(chapterNumber = 1): Promise<VoiceHarvestResult> {
        return await this.harvestVoiceFromChapter(chapterNumber);
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

    private isDirectBootInput(
        input: LockCharterAndBootInput | BootFromModalPayload
    ): input is LockCharterAndBootInput {
        return 'book_slug' in input;
    }

    private async assertBootTargetEmpty(targetRoot: string): Promise<void> {
        try {
            const entries = await readdir(targetRoot);
            if (entries.length > 0) {
                throw new TaskConflictError(`开书目标目录非空，禁止覆盖已有作品: ${targetRoot}`);
            }
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
        }
    }

    private async migrateBootStagingLogs(
        bootStagingRoot: string,
        targetBookRoot: string
    ): Promise<void> {
        const targetOpsDir = join(targetBookRoot, '.ops');
        await mkdir(targetOpsDir, { recursive: true });

        const stagingRunsRaw = await readOptionalText(join(bootStagingRoot, '.ops/runs.jsonl'));
        if (stagingRunsRaw !== null && stagingRunsRaw.trim().length > 0) {
            const normalizedLines = stagingRunsRaw
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            if (normalizedLines.length > 0) {
                const targetRunsPath = join(targetOpsDir, 'runs.jsonl');
                const existingRuns = await readOptionalText(targetRunsPath);
                const prefix =
                    existingRuns !== null && existingRuns.length > 0 && !existingRuns.endsWith('\n')
                        ? '\n'
                        : '';
                await appendFile(targetRunsPath, `${prefix}${normalizedLines.join('\n')}\n`, 'utf8');
            }
        }

        const stagingLogsDir = join(bootStagingRoot, '.ops/session_logs');
        try {
            const logFiles = await readdir(stagingLogsDir);
            if (logFiles.length > 0) {
                const targetLogsDir = join(targetOpsDir, 'session_logs');
                await mkdir(targetLogsDir, { recursive: true });
                for (const fileName of logFiles) {
                    if (!fileName.endsWith('.json')) continue;
                    await copyFile(
                        join(stagingLogsDir, fileName),
                        join(targetLogsDir, fileName)
                    );
                }
            }
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
        }
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
            if (this.isDirectBootInput(input)) {
                const targetRoot = resolve(this.booksRoot, input.book_slug);
                if (!isSubPath(this.booksRoot, targetRoot)) {
                    throw new PathValidationError('禁止路径穿越');
                }
                await this.assertBootTargetEmpty(targetRoot);
                bootRes = await this.toolsService.lockCharterAndBoot(input, {
                    booksRoot: this.booksRoot,
                    system: this.system,
                    onBookBooted: undefined
                });
            } else {
                const targetRoot = resolve(this.booksRoot, input.slug);
                if (!isSubPath(this.booksRoot, targetRoot)) {
                    throw new PathValidationError('禁止路径穿越');
                }
                // 在启动多轮 boot-compiler LLM 前先校验目标目录不存在或为空，零白费 Token
                await this.assertBootTargetEmpty(targetRoot);

                const roleCfg = await this.roleLoader.loadRoleConfig('boot-compiler');
                const taskPrompt = [
                    `## 开书编译任务 (${input.mode})`,
                    `- 作品标识: ${input.slug}`,
                    `- 书名: ${input.title}`,
                    `- 初始主视角实体 ID: ${input.povCharacter}`,
                    input.narrationSubjectivity
                        ? `- 叙述人称主观度: ${input.narrationSubjectivity}`
                        : '',
                    input.t0Anchor ? `- T0 原话现场锚点: ${input.t0Anchor}` : '',
                    input.commitments && input.commitments.length > 0
                        ? `- 核心创作承诺:\n${input.commitments.map((c) => `  - ${c}`).join('\n')}`
                        : '',
                    input.excludedCliches && input.excludedCliches.length > 0
                        ? `- 已排除廉价套路:\n${input.excludedCliches.map((c) => `  - ${c}`).join('\n')}`
                        : '',
                    input.authorizationBoundary
                        ? `- 授权边界: ${input.authorizationBoundary}`
                        : '',
                    input.premiseOrSeed ? `- 核心创意与设定:\n${input.premiseOrSeed}` : '',
                    input.sourceMaterial ? `- 外部参考设定:\n${input.sourceMaterial}` : '',
                    '',
                    '请严格按三把手术刀原则编译完整作品资产包，并调用 `yield_boot_bundle` 提交。'
                ]
                    .filter(Boolean)
                    .join('\n');

                // boot-compiler 在建库目录尚未存在时执行，暂存与运行索引在临时目录隔离运行
                const bootStagingRoot = resolve(this.booksRoot, `.boot-staging-${randomUUID()}`);
                await mkdir(bootStagingRoot, { recursive: true });
                try {
                    const runRes = await this.roleRunner.runMultiTurn<BootBundleOutput>({
                        roleId: roleCfg.id,
                        stage: 'BOOT_COMPILER',
                        chapterNumber: 0,
                        bookRoot: bootStagingRoot,
                        ...(input.narrationSubjectivity !== undefined
                            ? { narrationSubjectivity: input.narrationSubjectivity }
                            : {}),
                        taskPrompt,
                        signal,
                        onStageSession: this.handleStageSession
                    });

                    const bundle = runRes.yieldResult;
                    if (!('entities' in bundle) || bundle.contract_conflicts.length > 0) {
                        throw new Error(
                            `开书契约存在矛盾需作者裁决: ${bundle.contract_conflicts.join('; ')}`
                        );
                    }

                    const resolvedT0Anchor =
                        input.t0Anchor && input.t0Anchor.trim().length > 0
                            ? input.t0Anchor.trim()
                            : bundle.world_summary;
                    const resolvedCommitments =
                        input.commitments && input.commitments.length > 0
                            ? input.commitments
                            : [`核心叙事承诺：${bundle.world_summary}`];

                    bootRes = await this.toolsService.lockCharterAndBoot(
                        {
                            book_slug: input.slug,
                            title: input.title,
                            pov_character: input.povCharacter,
                            t0_anchor: resolvedT0Anchor,
                            commitments: resolvedCommitments,
                            ...(input.excludedCliches && input.excludedCliches.length > 0
                                ? { excluded_cliches: input.excludedCliches }
                                : {}),
                            ...(input.authorizationBoundary &&
                            input.authorizationBoundary.trim().length > 0
                                ? { authorization_boundary: input.authorizationBoundary.trim() }
                                : {}),
                            ...(input.narrationSubjectivity !== undefined
                                ? { narration_subjectivity: input.narrationSubjectivity }
                                : {}),
                            ...(input.tokensPerChar !== undefined
                                ? { tokens_per_char: input.tokensPerChar }
                                : {}),
                            ...(input.writerTokenBudget !== undefined
                                ? { writer_token_budget: input.writerTokenBudget }
                                : {}),
                            ...(input.maxAutoRollbackChapters !== undefined
                                ? { max_auto_rollback_chapters: input.maxAutoRollbackChapters }
                                : {}),
                            ...(input.craftPlugins !== undefined
                                ? { craft_plugins: input.craftPlugins }
                                : {}),
                            ...(input.modelRouting !== undefined
                                ? { model_routing: input.modelRouting }
                                : {}),
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
                            system: this.system,
                            onBookBooted: undefined
                        }
                    );

                    await this.migrateBootStagingLogs(bootStagingRoot, bootRes.bookRoot);
                } finally {
                    await rm(bootStagingRoot, { recursive: true, force: true }).catch(() => {});
                }
            }

            await this.switchBookInternal(bootRes.bookRoot);
            bootRes.switchedBook = true;
            return bootRes;
        });
    }

    /** 投递微调信号到 .ops/signals.jsonl（按 bookRoot 串行互斥并自动赋予唯一 id） */
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

        const reason = extractNonEmptyStringField(rawInput, ['reason', 'content']) ?? '';
        const chapter = extractIntegerField(rawInput, ['chapter', 'target_chapter']) ?? defaultChapter;

        const signalId =
            typeof rawInput['id'] === 'string' && rawInput['id'].trim().length > 0
                ? rawInput['id'].trim()
                : `sig_${randomUUID()}`;

        const parsed = OpsSignalSchema.safeParse({
            ...rawInput,
            id: signalId,
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
        await this.runSignalSerialized(bookRoot, async () => {
            await appendJsonlLineSafe(
                join(bookRoot, '.ops/signals.jsonl'),
                JSON.stringify(signalRecord)
            );
        });

        this.emitEvent('signal:received', signalRecord);
        return signalRecord;
    }

    /** 撤回一条未消费信号（按 bookRoot 串行互斥并基于 consumedIds / 游标双重拦截） */
    async deleteSignal(
        createdAt: string,
        reason: string
    ): Promise<{ status: 'WITHDRAWN'; remaining: number } | null> {
        this.assertAdmissionOpen();
        const store = this.requireBookStore();
        const bookRoot = store.bookRoot;

        return await this.runSignalSerialized(bookRoot, async () => {
            await this.assertNoActiveTxLock('流水线运行中（.ops/tx.lock），禁止撤回纸条');

            const filePath = join(bookRoot, '.ops/signals.jsonl');
            const raw = await readOptionalText(filePath);
            if (raw === null) {
                return null;
            }

            const nonEmptyLines = splitNonEmptyLines(raw);
            const cursorState = await readSignalsCursorState(bookRoot);
            const consumedIds = resolveConsumedSignalIds(cursorState, nonEmptyLines);

            const kept: string[] = [];
            let removedIdx = -1;
            let removedSigId: string | null = null;
            for (let idx = 0; idx < nonEmptyLines.length; idx += 1) {
                const trimmed = nonEmptyLines[idx]!;
                if (removedIdx < 0) {
                    try {
                        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                        const parsedReason = extractFirstStringField(parsed, [
                            'reason',
                            'content',
                            'instruction'
                        ]);
                        if (parsed['created_at'] === createdAt && parsedReason === reason) {
                            removedIdx = idx;
                            removedSigId = resolveSignalId(parsed);
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

            const effectiveCursor =
                cursorState.consumedLines <= nonEmptyLines.length
                    ? cursorState.consumedLines
                    : this.signalsConsumedLines;
            const alreadyConsumed =
                (removedSigId !== null && consumedIds.has(removedSigId)) ||
                (cursorState.consumedIds.length === 0 && removedIdx < effectiveCursor);
            if (alreadyConsumed) {
                throw new TaskConflictError('目标信号已被流水线消费，禁止撤回');
            }

            await writeFile(filePath, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
            this.emitEvent('signal:withdrawn', {
                ...(removedSigId ? { id: removedSigId } : {}),
                created_at: createdAt,
                reason
            });
            return { status: 'WITHDRAWN', remaining: kept.length };
        });
    }

    /** 请求停机：默认 force=false 为软安全点停机（不 abort 在途请求）；force=true 立即中断在途调用 */
    requestHalt(options?: { force?: boolean | undefined }): {
        haltRequested: boolean;
        force: boolean;
        activeTask: RuntimeTaskKind;
    } {
        const force = options?.force === true;
        this.haltRequested = true;
        this.yoloState.stopRequested = true;
        if (force) {
            this.activeAbortController?.abort(new Error('SAFE_HALT_REQUESTED'));
        }
        this.emitEvent('halt:requested', {
            activeTask: this.activeTask,
            force,
            timestamp: new Date().toISOString()
        });
        return {
            haltRequested: true,
            force,
            activeTask: this.activeTask
        };
    }

    /**
     * 有序排空停机：
     * 1. 立即关闭新任务准入闸门并释放外部事件订阅；
     * 2. 向在途任务与 YOLO 发送强制收束信号；
     * 3. 等待活跃 RoleRunner 句柄、后台任务与 WAL/Git 提交彻底排空；
     *    超时时仅广播 halt:waiting 告警，不强杀 .ops/tx.lock 或提前卸载路由。
     */
    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        this.disposeBookSwitched();
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        this.requestHalt({ force: true });

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
            if (!entry.isDirectory() || entry.name.startsWith('.boot-')) continue;
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

    /** 宿主未显式指定单书时，自动激活 booksRoot 下第一部有效作品以便命令与控制面开箱即用 */
    async ensureDefaultBookSelected(): Promise<string | null> {
        if (this.bookRoot || this.shuttingDown) {
            return this.bookRoot;
        }
        if (this.ensureDefaultBookPromise) {
            return await this.ensureDefaultBookPromise;
        }
        if (this.activeTask !== 'IDLE') {
            return this.bookRoot;
        }
        let task: Promise<string | null> | null = null;
        task = (async () => {
            try {
                const { books } = await this.listBooks();
                if (
                    books.length > 0 &&
                    !this.bookRoot &&
                    !this.shuttingDown &&
                    this.activeTask === 'IDLE'
                ) {
                    await this.switchBook(books[0]!.bookRoot);
                }
            } catch {
                // 扫描失败或并发切换时保持静默，由后续显式 switchBook 或 bootBook 处理
            } finally {
                if (this.ensureDefaultBookPromise === task) {
                    this.ensureDefaultBookPromise = null;
                }
            }
            return this.bookRoot;
        })();
        this.ensureDefaultBookPromise = task;
        return await task;
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
        if (!this.bookRoot) {
            return { chapters: [] };
        }
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
                sha256: sha256Hex(content),
                dirty: dirtySet.has(item.chapterNumber),
                commitSha: null as string | null
            });
        }
        return { chapters };
    }

    /** 按规范顺序解析 8 个工种的默认配置与当前生效模型路由 */
    async resolveRoleDefinitions(
        bookConfig?: Pick<BookConfig, 'model_routing' | 'role_routing'>,
        bookRoot?: string
    ): Promise<RoleDefinitionItem[]> {
        await this.ensurePoolRoutingReady();
        const targetBookRoot = bookRoot ?? this.bookRoot ?? undefined;
        const effectiveBookConfig = this.resolveEffectiveBookConfig(bookConfig);
        const activePoolRouting = this.poolRouting;
        const definitions: RoleDefinitionItem[] = [];

        for (const roleId of CANONICAL_ROLE_IDS) {
            let defaultPool: LlmPool = CANONICAL_ROLE_DEFAULT_POOLS[roleId];
            let defaultReasoningEffort: ReasoningEffortLevel | undefined;

            try {
                const roleCfg = await this.roleLoader.loadRoleConfig(roleId, targetBookRoot);
                defaultPool = roleCfg.pool;
                defaultReasoningEffort = roleCfg.reasoningEffort;
            } catch {
                // 预设目录缺失或单书覆写异常时回退到标准默认池定义
            }

            const roleOverride = effectiveBookConfig.role_routing?.[roleId];
            const effectiveTier =
                roleOverride?.tier === 'strong' || roleOverride?.tier === 'weak'
                    ? roleOverride.tier
                    : null;
            const effectivePool = normalizeLlmPool(
                resolveTierPool(effectiveTier ?? undefined, defaultPool)
            );
            const route = resolveRoleRoute(
                activePoolRouting,
                roleId,
                defaultPool,
                effectiveBookConfig
            );
            const requestedEffort = resolveRoleReasoningEffort(
                roleId,
                defaultReasoningEffort,
                effectiveBookConfig
            );
            const effectiveReasoningEffort = await resolveCompatibleReasoningEffort(
                this.ctx.llm, route.provider, route.model, requestedEffort
            );

            definitions.push({
                id: roleId,
                defaultPool: normalizeLlmPool(defaultPool),
                ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
                effectiveTier,
                effectivePool,
                effectiveProvider: route.provider,
                effectiveModel: route.model,
                ...(effectiveReasoningEffort !== undefined ? { effectiveReasoningEffort } : {})
            });
        }

        return definitions;
    }

    /** 探测并汇总当前运行时所有真实可用模型候选（剔除假模型兜底，仅含已注册模型、DSH 默认模型与非空显式覆盖） */
    async listAvailableModels(
        bookConfig?: Pick<BookConfig, 'model_routing' | 'role_routing'>
    ): Promise<AvailableModelItem[]> {
        const seen = new Map<string, AvailableModelItem>();
        const hostDefault = this.getHostDefaultModel();
        const fallbackProvider = hostDefault?.provider ?? this.readFirstRegisteredProviderId() ?? '';

        const generation = ++this.catalogGeneration;
        const addCandidate = (rawProvider: string, rawModel: string, label?: string): void => {
            const provider = rawProvider.trim() || fallbackProvider;
            const model = rawModel.trim();
            if (model.length === 0) return;

            const key = `${provider}\0${model}`;
            const existing = seen.get(key);
            const cleanLabel = label?.trim();
            if (!existing) {
                seen.set(key, {
                    provider,
                    model,
                    ...(cleanLabel && cleanLabel !== model ? { label: cleanLabel } : {})
                });
            } else if (!existing.label && cleanLabel && cleanLabel !== model) {
                existing.label = cleanLabel;
            }
        };
        const addSpec = (fallback: string, spec: string): void => {
            const route = parseProviderModelSpec(spec, fallback);
            addCandidate(route.provider, route.model);
        };

        const llm = this.ctx.llm as unknown as {
            listProviders?: () => Array<{ id?: unknown; name?: unknown }>;
            listModels?: (
                provider: string
            ) => Promise<Array<{ id?: unknown; model?: unknown; name?: unknown }>>;
        };

        let firstDiscovered: LlmRouteTarget | null = null;
        if (llm && typeof llm.listProviders === 'function') {
            try {
                const providers = llm.listProviders();
                if (Array.isArray(providers)) {
                    for (const providerInfo of providers) {
                        const providerId =
                            typeof providerInfo?.id === 'string' ? providerInfo.id.trim() : '';
                        if (!providerId || typeof llm.listModels !== 'function') {
                            continue;
                        }
                        try {
                            const models = await llm.listModels(providerId);
                            if (!Array.isArray(models)) continue;
                            for (const modelInfo of models) {
                                const modelId = extractModelId(modelInfo);
                                const modelName =
                                    typeof modelInfo?.name === 'string' ? modelInfo.name : undefined;
                                const trimmedModel = modelId.trim();
                                if (trimmedModel.length > 0) {
                                    if (!firstDiscovered) {
                                        firstDiscovered = { provider: providerId, model: trimmedModel };
                                    }
                                    addCandidate(providerId, trimmedModel, modelName);
                                }
                            }
                        } catch {
                            // 单个 provider 枚举失败静默降级
                        }
                    }
                }
            } catch {
                // listProviders 异常静默降级
            }
        }
        if (generation === this.catalogGeneration) {
            this.discoveredFallbackModel = firstDiscovered;
            this.discoveredFallbackLoaded = true;
        }

        if (hostDefault) {
            addCandidate(hostDefault.provider, hostDefault.model);
        }

        const activePoolRouting = this.poolRouting;
        for (const pool of ['strong_creative', 'fast_retrieval'] as const) {
            const ov = this.explicitPoolOverrides[pool];
            const ovModel = ov?.model?.trim() ?? '';
            if (ovModel.length > 0) {
                const ovProvider = ov?.provider?.trim() || activePoolRouting[pool].provider;
                addSpec(ovProvider, ovModel);
            }
        }

        for (const [poolKey, rawModel] of Object.entries(this.globalModelRouting)) {
            const pool = normalizeLlmPool(poolKey);
            addSpec(activePoolRouting[pool].provider, rawModel);
        }

        if (bookConfig?.model_routing) {
            for (const [poolKey, rawModel] of Object.entries(bookConfig.model_routing)) {
                const pool = normalizeLlmPool(poolKey);
                addSpec(activePoolRouting[pool].provider, rawModel);
            }
        }

        const combinedRoleRouting = this.resolveEffectiveRoleRouting(bookConfig);
        for (const [roleId, override] of Object.entries(combinedRoleRouting)) {
            if (!override?.model) continue;
            const defaultPool =
                CANONICAL_ROLE_DEFAULT_POOLS[roleId as (typeof CANONICAL_ROLE_IDS)[number]] ??
                'strong_creative';
            const effectivePool = normalizeLlmPool(resolveTierPool(override.tier, defaultPool));
            addSpec(activePoolRouting[effectivePool].provider, override.model);
        }

        return Array.from(seen.values());
    }

    /** 更新模型路由配置：无书态保存至全局内存路由，有书态在事务锁保护下落盘 world/book_config.yaml */
    async updateModelRouting(input: {
        model_routing?: Record<string, string> | undefined;
        role_routing?: Record<string, RoleModelOverride> | undefined;
        clearedPools?: readonly string[] | undefined;
        clearedRoles?: readonly string[] | undefined;
    }): Promise<SaveModelRoutingResult> {
        this.assertAdmissionOpen();
        if (this.activeTask !== 'IDLE' || this.yoloState.running) {
            throw new TaskConflictError(
                `当前正在执行任务 (${this.yoloState.running ? 'YOLO' : this.activeTask})，禁止修改模型路由配置`
            );
        }

        await this.ensurePoolRoutingReady();

        if (!this.bookRoot) {
            if (input.model_routing !== undefined) {
                const nextGlobal: Record<string, string> = {};
                for (const [poolKey, val] of Object.entries(input.model_routing)) {
                    const trimmed = val.trim();
                    if (trimmed.length > 0) {
                        nextGlobal[poolKey] = trimmed;
                    }
                }
                this.globalModelRouting = nextGlobal;
            }
            if (input.role_routing !== undefined) {
                this.globalRoleRouting = { ...input.role_routing };
            }

            const effectiveBookCfg = this.resolveEffectiveBookConfig(undefined);
            return {
                status: 'ok',
                defaultModel: this.getHostDefaultModel(),
                poolOverrides: this.resolvePoolOverrides(undefined),
                modelRouting: resolveStatusModelRouting(
                    this.poolRouting,
                    effectiveBookCfg.model_routing
                ),
                roleRouting: this.getGlobalRoleRouting(),
                roleDefinitions: await this.resolveRoleDefinitions(undefined, undefined)
            };
        }

        const store = this.requireBookStore();
        return await store.withTxLock(async () => {
            const currentConfig = await store.readBookConfig();
            const nextConfig: BookConfig = { ...currentConfig };

            if (input.model_routing !== undefined) {
                if (Object.keys(input.model_routing).length > 0) {
                    nextConfig.model_routing = input.model_routing;
                } else {
                    delete nextConfig.model_routing;
                }
            }

            if (input.role_routing !== undefined) {
                if (Object.keys(input.role_routing).length > 0) {
                    nextConfig.role_routing = input.role_routing;
                } else {
                    delete nextConfig.role_routing;
                }
            }

            let hasGitHead = false;
            try {
                await this.system.currentRevision(store.bookRoot);
                hasGitHead = true;
            } catch {
                hasGitHead = false;
            }

            if (hasGitHead) {
                await store.recordPendingWrites(['world/book_config.yaml']);
                await store.writeBookConfig(nextConfig);
                await this.system.commitPaths(
                    store.bookRoot,
                    ['world/book_config.yaml'],
                    'chore(config): update model routing'
                );
                await rm(join(store.bookRoot, '.ops/pending_writes.json'), { force: true });
            } else {
                await store.assertNoPendingWrites();
                await store.writeBookConfig(nextConfig);
            }
            if (input.model_routing !== undefined) {
                for (const pool of input.clearedPools ?? []) delete this.globalModelRouting[pool];
            }
            if (input.role_routing !== undefined) {
                for (const role of input.clearedRoles ?? []) delete this.globalRoleRouting[role];
            }

            const effectiveBookCfg = this.resolveEffectiveBookConfig(nextConfig);
            return {
                status: 'ok',
                defaultModel: this.getHostDefaultModel(),
                poolOverrides: this.resolvePoolOverrides(nextConfig),
                modelRouting: resolveStatusModelRouting(
                    this.poolRouting,
                    effectiveBookCfg.model_routing
                ),
                roleRouting: this.resolveEffectiveRoleRouting(nextConfig),
                roleDefinitions: await this.resolveRoleDefinitions(nextConfig, store.bookRoot)
            };
        });
    }

    /** 查询当前激活（或指定）作品 .ops/tx.lock 是否正被活跃进程持有 */
    async isTxLockHeld(explicitBookRoot?: string): Promise<boolean> {
        const bookRoot = explicitBookRoot ?? this.bookRoot;
        if (!bookRoot) return false;
        const lockPath = join(bookRoot, '.ops/tx.lock');
        const raw = await readOptionalText(lockPath);
        if (raw === null) return false;

        try {
            const parsed = TxLockPayloadSchema.safeParse(JSON.parse(raw));
            if (parsed.success) {
                try {
                    process.kill(parsed.data.pid, 0);
                    return true;
                } catch (err: unknown) {
                    return !(
                        err !== null &&
                        typeof err === 'object' &&
                        'code' in err &&
                        err.code === 'ESRCH'
                    );
                }
            }
            const fileStat = await stat(lockPath);
            return Date.now() - fileStat.mtimeMs < DEFAULT_LOCK_STALE_MS;
        } catch {
            try {
                const fileStat = await stat(lockPath);
                return Date.now() - fileStat.mtimeMs < DEFAULT_LOCK_STALE_MS;
            } catch {
                return false;
            }
        }
    }

    /** 返回最近一次写手净室前缀装配诊断报告 */
    getLastWriterAssemblyReport(): WriterAssemblyReport | null {
        return this.lastWriterAssemblyReport;
    }

    /** 解析 world/arc_director_plan.md 开篇序列节拍进度 */
    async readOpeningBeatsProgress(bookRoot: string): Promise<OpeningBeatsProgress | null> {
        const raw = await readOptionalText(join(bookRoot, 'world/arc_director_plan.md'));
        if (raw === null) return null;

        const lines = raw.replace(/\r\n/g, '\n').split('\n');
        let inSection = false;
        const beats: OpeningBeatProgressItem[] = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (/^##\s+Opening\s+Sequence\s+Beats/i.test(trimmed)) {
                inSection = true;
                continue;
            }
            if (inSection && /^##\s+/.test(trimmed)) {
                break;
            }
            if (!inSection || !trimmed.startsWith('- ')) continue;

            const body = trimmed.slice(2).trim();
            const statusMatch = /^\[(?:status:\s*)?((?:PENDING|DONE)(?:\s+[^\]]*)?)\]\s*(.+)$/i.exec(
                body
            );
            const rawStatus = statusMatch?.[1]?.trim() ?? 'PENDING';
            const text = statusMatch?.[2]?.trim() ?? body;
            const isDone = /^DONE\b/i.test(rawStatus);
            const chMatch = /\b(ch_\d{4})\b/i.exec(rawStatus);

            beats.push({
                index: beats.length + 1,
                status: isDone ? 'DONE' : 'PENDING',
                rawStatus,
                ...(chMatch?.[1] ? { completedChapter: chMatch[1] } : {}),
                text
            });
        }

        if (beats.length === 0) return null;
        const completed = beats.filter((b) => b.status === 'DONE').length;
        return {
            total: beats.length,
            completed,
            pending: beats.length - completed,
            beats
        };
    }

    /** 读取最近一次 feat / state Git 提交 SHA（单次 git log 批量扫描） */
    async readRecentCommitShas(bookRoot: string): Promise<{
        featCommitSha: string | null;
        stateCommitSha: string | null;
    }> {
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['-C', bookRoot, 'log', '-n', '20', '--format=%H%x09%s'],
                { encoding: 'utf8', maxBuffer: 1024 * 1024 }
            );
            let featCommitSha: string | null = null;
            let stateCommitSha: string | null = null;
            for (const line of stdout.split(/\r?\n/)) {
                const tabIdx = line.indexOf('\t');
                if (tabIdx <= 0) continue;
                const sha = line.slice(0, tabIdx).trim();
                const subject = line.slice(tabIdx + 1).trim();
                if (!featCommitSha && /^feat(?:\([^)]+\))?:/i.test(subject)) {
                    featCommitSha = sha;
                }
                if (!stateCommitSha && /^state(?:\([^)]+\))?:/i.test(subject)) {
                    stateCommitSha = sha;
                }
                if (featCommitSha && stateCommitSha) break;
            }
            return { featCommitSha, stateCommitSha };
        } catch {
            return { featCommitSha: null, stateCommitSha: null };
        }
    }

    /** 汇总当前卷进度与 future_horizon 摘要 */
    async readVolumeProgress(
        store: BookStore,
        snapshot: BookSnapshot
    ): Promise<VolumeProgressSummary> {
        const currentVolume = snapshot.worldState.frontmatter.current_volume;
        const [l1Raw, cardRaw, horizonRaw] = await Promise.all([
            readOptionalText(join(store.bookRoot, 'index/L1_volumes.md')),
            readOptionalText(join(store.bookRoot, formatVolumeCardRelPath(currentVolume))),
            readOptionalText(join(store.bookRoot, 'world/future_horizon.md'))
        ]);

        let volumeTitle: string | undefined;
        let totalChapters: number | null = null;
        if (l1Raw) {
            for (const line of l1Raw.replace(/\r\n/g, '\n').split('\n')) {
                const isCurVol =
                    new RegExp(`\\bvol_0?${currentVolume}\\b`, 'i').test(line) ||
                    new RegExp(`第\\s*${currentVolume}\\s*卷`).test(line);
                if (!isCurVol) continue;
                const cleanedTitle = line
                    .replace(/^[-*#>\s]+/, '')
                    .replace(new RegExp(`^(?:vol_0?${currentVolume}|第\\s*${currentVolume}\\s*卷)\\s*[:：-]?\\s*`, 'i'), '')
                    .trim();
                if (cleanedTitle.length > 0 && !volumeTitle) {
                    volumeTitle = cleanedTitle;
                }
                const chRange = /ch_(\d{4})\s*[-~至]\s*ch_(\d{4})/i.exec(line);
                const cnRange = /第\s*(\d+)\s*[-~至]\s*第?\s*(\d+)\s*章/.exec(line);
                const m = chRange ?? cnRange;
                if (m?.[1] && m[2]) {
                    const start = Number(m[1]);
                    const end = Number(m[2]);
                    if (end >= start) {
                        totalChapters = end - start + 1;
                    }
                }
            }
        }

        const completedChapters = cardRaw ? parseL2CardSections(cardRaw).sections.length : 0;
        const futureHorizon = horizonRaw?.trim() ? horizonRaw.trim().slice(0, 240) : undefined;
        return {
            currentVolume,
            volumeLabel: `第 ${currentVolume} 卷`,
            ...(volumeTitle ? { volumeTitle } : {}),
            completedChapters,
            totalChapters,
            ...(futureHorizon ? { futureHorizon } : {})
        };
    }

    /** 收集状态栏与检查器诊断扩展字段（100% 纯只读） */
    async getDiagnosticsStatus(store: BookStore, snapshot: BookSnapshot) {
        const bookRoot = store.bookRoot;
        const [
            txLockHeld,
            recentCommits,
            dreamWatermark,
            signalsView,
            nextOpts,
            openingBeats,
            volumeProgress,
            healPlan,
            syncConflictsRaw
        ] = await Promise.all([
            this.isTxLockHeld(bookRoot),
            this.readRecentCommitShas(bookRoot),
            store.readDreamWatermark(),
            this.listSignalsView(bookRoot),
            readNextChapterOptions(bookRoot),
            this.readOpeningBeatsProgress(bookRoot),
            this.readVolumeProgress(store, snapshot),
            readHealPlan(bookRoot),
            readOptionalText(join(bookRoot, '.ops/sync_conflicts.json'))
        ]);

        const watermarkCh = dreamWatermark?.last_dream_ch ?? 0;
        const dirtyEntityCount = Object.values(snapshot.entities).filter(
            (profile) => profile.metadata.last_seen_ch > watermarkCh
        ).length;
        const dirtyEntityThreshold = snapshot.config.dreaming?.buffer_limit ?? 6;
        const spotlightQueue = signalsView.pending.filter(
            (sig) =>
                sig !== null &&
                typeof sig === 'object' &&
                (sig as { type?: unknown }).type === 'SPOTLIGHT_TRIGGER'
        );

        let syncConflictsCount = 0;
        if (syncConflictsRaw !== null) {
            try {
                const parsed = JSON.parse(syncConflictsRaw) as { conflicts?: unknown };
                if (Array.isArray(parsed.conflicts)) {
                    syncConflictsCount = parsed.conflicts.length;
                }
            } catch {
                // 忽略损坏文件
            }
        }

        return {
            txLockHeld,
            featCommitSha: recentCommits.featCommitSha,
            stateCommitSha: recentCommits.stateCommitSha,
            recentCommits,
            writerAssemblyReport: this.lastWriterAssemblyReport,
            lastCheckerResult: this.lastCheckerResult,
            dreamWatermark,
            dirtyEntityCount,
            dirtyEntityThreshold,
            spotlightQueue,
            nextChapterOptions: nextOpts?.options ?? [],
            nextChapterOptionsSourceChapter: nextOpts?.source_chapter ?? null,
            openingBeats,
            volumeProgress,
            healPlan,
            syncConflictsCount
        };
    }

    private async assertNoActiveTxLock(message: string): Promise<void> {
        if (await this.isTxLockHeld()) {
            throw new TxLockConflictError(message);
        }
    }

    private async runExclusiveTask<T>(
        kind: Exclude<RuntimeTaskKind, 'IDLE'>,
        fn: (signal: AbortSignal) => Promise<T>,
        options?: { allowDuringYolo?: boolean; allowDuringHeal?: boolean }
    ): Promise<T> {
        this.assertAdmissionOpen();
        if (this.yoloState.running && !options?.allowDuringYolo) {
            throw new TaskConflictError('YOLO 连跑正在执行中，禁止并发执行其他任务');
        }
        if (this.activeTask !== 'IDLE') {
            throw new TaskConflictError(`当前正在执行任务: ${this.activeTask}`);
        }

        this.activeTask = kind;
        // 仅在从完全空闲启动顶层独立任务时清理历史残留 haltRequested；YOLO 章节与 Dreaming 间隙绝不吞掉停机信号
        if (
            !options?.allowDuringYolo &&
            !options?.allowDuringHeal &&
            !this.yoloState.running &&
            !this.shuttingDown
        ) {
            this.haltRequested = false;
        }
        const ac = new AbortController();
        this.activeAbortController = ac;

        const promise = (async () => {
            try {
                return await fn(ac.signal);
            } finally {
                this.activeTask = 'IDLE';
                this.activeAbortController = null;
                this.activePromise = null;
                if (
                    !options?.allowDuringYolo &&
                    !options?.allowDuringHeal &&
                    !this.yoloState.running &&
                    !this.shuttingDown
                ) {
                    this.haltRequested = false;
                }
                this.emitEvent('task:idle', { task: kind });
            }
        })();

        this.activePromise = promise;
        return await promise;
    }
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

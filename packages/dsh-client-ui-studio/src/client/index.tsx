import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import { handleTabKeyDown } from './tab-keyboard';
import { aggregateTelemetryTokens } from './token-telemetry';
import {
    bootBook,
    deleteSignal,
    fetchBooks,
    fetchChapter,
    fetchChapters,
    fetchRunRecords,
    fetchStatus,
    fetchViewEntities,
    fetchViewHalt,
    fetchViewHorizon,
    fetchViewSignals,
    fetchViewTelemetry,
    fetchViewThreads,
    postSignal,
    requestHalt,
    runDreaming,
    saveChapter,
    saveModelRouting,
    selectBook,
    startYolo,
    stepChapter,
    stopYolo,
    subscribeNarrateEvents,
    syncManuscripts
} from './api';
import { BootBookModal } from './BootBookModal';
import {
    CenterWorkbench,
    resolveStageId,
    type CenterWorkbenchProps,
    type CenterWorkbenchDraftHandle,
    type DirectorSignalKind,
    type ExternalViewCommand,
    type PendingSignalItem,
    type PipelineStageId,
    type SafeHaltInfo,
    type StageNodeState,
    type StageNodeStatus,
    type StageSessionSelection,
    type SubmitSignalPayload
} from './CenterWorkbench';
import { DraftGuardModal } from './DraftGuardModal';
import {
    decideDraftNavigation,
    resolveBackgroundCommitAction,
    type DraftLocation,
    type DraftNavigationIntent
} from './draft-guard';
import { LeftBookNav, type MaterializedViewKind } from './LeftBookNav';
import {
    RightOpsInspector,
    type FactCheckerTelemetry,
    type HaltDiagnosticInfo,
    type InspectorEntityItem,
    type OpenThreadItem,
    type ProseGateViolationItem,
    type StageArtifactTelemetry,
    type VolumeProgressSnapshot
} from './RightOpsInspector';
import {
    StageSessionViewer,
    type StudioRenderStageConversation,
    type StudioSessionProviderComponent,
    type StudioSessionsService
} from './StageSessionViewer';
import { ensureStudioStyles } from './styles';
import type {
    BooksListPayload,
    ChapterDetail,
    ChapterSummary,
    EntitiesViewPayload,
    HaltViewPayload,
    MarkdownViewPayload,
    NarrateStatusPayload,
    SaveModelRoutingRequest,
    SignalsViewPayload,
    SseEventPayload,
    StageRunRecord,
    TelemetryItem,
    TelemetryViewPayload
} from './types';

export const PANEL_ID = 'narrateos-studio';

export const inject = ['slots', 'layout'] as const;

interface ToastState {
    id: number;
    message: string;
    kind: 'info' | 'error';
}

const PIPELINE_STAGE_META: ReadonlyArray<{ id: PipelineStageId; label: string }> = [
    { id: 'LIBRARIAN', label: 'Librarian' },
    { id: 'PLANNER', label: 'Planner' },
    { id: 'WRITER', label: 'Writer' },
    { id: 'FACT_CHECKER', label: 'Fact Check' },
    { id: 'EXTRACTOR', label: 'Extractor' },
    { id: 'DREAMING', label: 'Dreaming' }
];

const DEFAULT_STAGE_SUMMARIES: Record<PipelineStageId, string> = {
    LIBRARIAN: '检索本场焦点实体卡与声纹样本',
    PLANNER: '生成结构化章节细纲与节拍',
    WRITER: '净室单轮流式直出正文草稿',
    FACT_CHECKER: '异构模型核查与双侧原句验真',
    EXTRACTOR: '提取实体增量并原子提交 Git WAL',
    DREAMING: '条件睡眠 VACUUM 与跨章连续性自愈'
};

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}


/** 兼容嵌套 metrics 与扁平字段读取文风四联指标 */
function readTelemetryMetrics(item: TelemetryItem | null | undefined): {
    mattr500: number | null;
    kontoyiannisEntropy: number | null;
    sentenceLengthCv: number | null;
    clicheDensityPer1k: number | null;
} {
    return {
        mattr500: item?.metrics?.mattr500 ?? item?.mattr500 ?? null,
        kontoyiannisEntropy:
            item?.metrics?.kontoyiannisEntropy ??
            item?.metrics?.kontoyiannisHk ??
            item?.kontoyiannisEntropy ??
            item?.kontoyiannisHk ??
            null,
        sentenceLengthCv: item?.metrics?.sentenceLengthCv ?? item?.sentenceLengthCv ?? null,
        clicheDensityPer1k: item?.metrics?.clicheDensityPer1k ?? item?.clicheDensityPer1k ?? null
    };
}

function mapSafeHaltInfo(raw: Record<string, unknown> | null | undefined): SafeHaltInfo | null {
    if (!raw) return null;
    const reason =
        asString(raw['reason']) ??
        asString(raw['message']) ??
        asString(raw['error']) ??
        '检测到连续性冲突，系统已安全挂起';
    return {
        reason,
        stage: asString(raw['stage']),
        chapter: asNumber(raw['chapter']) ?? asNumber(raw['chapterNumber']),
        conflictId: asString(raw['conflictId']),
        affectedChapters: asNumber(raw['affectedChapters']),
        timestamp: asString(raw['timestamp']),
        details: asString(raw['details'])
    };
}

function mapHaltDiagnostic(haltView: HaltViewPayload | null): HaltDiagnosticInfo | null {
    if (!haltView) return null;
    const raw = haltView.safeHalt ?? haltView.quarantineReport;
    if (!raw) return null;
    const kind: 'SAFE_HALT' | 'QUARANTINED' = haltView.safeHalt ? 'SAFE_HALT' : 'QUARANTINED';
    const reason =
        asString(raw['reason']) ??
        asString(raw['message']) ??
        asString(raw['error']) ??
        '检测到跨章连续性冲突，已触发安全保护';
    const result: HaltDiagnosticInfo = {
        kind,
        reason
    };
    const leftRef = asString(raw['leftRef']);
    const rightRef = asString(raw['rightRef']);
    const leftExcerpt = asString(raw['leftExcerpt']);
    const rightExcerpt = asString(raw['rightExcerpt']);
    const affectedChapters = asNumber(raw['affectedChapters']);
    const rollbackThreshold = asNumber(raw['rollbackThreshold']);
    const timestamp = asString(raw['timestamp']);
    if (leftRef !== undefined) result.leftRef = leftRef;
    if (rightRef !== undefined) result.rightRef = rightRef;
    if (leftExcerpt !== undefined) result.leftExcerpt = leftExcerpt;
    if (rightExcerpt !== undefined) result.rightExcerpt = rightExcerpt;
    if (affectedChapters !== undefined) result.affectedChapters = affectedChapters;
    if (rollbackThreshold !== undefined) result.rollbackThreshold = rollbackThreshold;
    if (timestamp !== undefined) result.timestamp = timestamp;
    return result;
}

function mapPendingSignals(signalsView: SignalsViewPayload | null): PendingSignalItem[] {
    if (!signalsView) return [];
    // 队列只展示未消费切片;已消费历史行不得混入(撤回按内容匹配,与全量下标无关)
    const items =
        signalsView.pending ??
        signalsView.signals.slice(Math.max(0, signalsView.signals.length - signalsView.pendingCount));
    return items.map((item) => ({
        type: asString(item.type),
        reason: asString(item['reason']) ?? asString(item.content) ?? asString(item.instruction),
        chapter: asNumber(item['chapter']) ?? asNumber(item.target_chapter),
        suggested_mode: asString(item['suggested_mode']),
        created_at: asString(item.created_at),
        raw: asString(item.raw)
    }));
}

function buildSignalPayload(kind: DirectorSignalKind, content: string, chapter: number): {
    type: string;
    content: string;
    chapter: number;
    reason: string;
    suggested_mode?: string;
    created_at: string;
} {
    const trimmed = content.trim();
    const isRetcon = kind === 'Retcon';
    const payload: {
        type: string;
        content: string;
        chapter: number;
        reason: string;
        suggested_mode?: string;
        created_at: string;
    } = {
        type: isRetcon ? 'RETCON' : 'SPOTLIGHT_TRIGGER',
        content: trimmed,
        chapter: Math.max(0, chapter),
        reason: `[${kind}] ${trimmed}`,
        created_at: new Date().toISOString()
    };
    if (kind === 'PARALLEL') {
        payload.suggested_mode = 'PARALLEL';
    } else if (kind === '下章剧情' || kind === '导演指令') {
        payload.suggested_mode = 'MAINLINE';
    }
    return payload;
}

function deriveStageArtifact(latestSseStage: string | null): StageArtifactTelemetry {
    if (!latestSseStage) {
        return {
            selectedStageIndex: 0,
            stageName: '待命 (IDLE)',
            stageStatus: '就绪',
            stageSummary: '等待单步推进或 YOLO 连跑指令'
        };
    }
    if (latestSseStage === 'COMMITTED') {
        return {
            selectedStageIndex: 4,
            stageName: 'Extractor',
            stageStatus: '已提交',
            stageSummary: '本章正文与状态补丁已双提交至 Git WAL'
        };
    }
    if (latestSseStage === 'PROSE_GATE' || latestSseStage === 'LOCAL_PATCH') {
        const isPatch = latestSseStage === 'LOCAL_PATCH';
        return {
            selectedStageIndex: 2,
            stageName: 'Writer · 静态门禁',
            stageStatus: isPatch ? '门禁 Patch' : '门禁扫描',
            stageSummary: isPatch
                ? '静态门禁拦截，局部 Patch 自愈中（明细见右栏门禁组）'
                : '0-LLM 确定性文风门禁校验中'
        };
    }
    const resolved = resolveStageId(latestSseStage);
    const idx = resolved ? PIPELINE_STAGE_META.findIndex((item) => item.id === resolved) : -1;
    if (idx >= 0) {
        const meta = PIPELINE_STAGE_META[idx]!;
        return {
            selectedStageIndex: idx,
            stageName: meta.label,
            stageStatus: '运行中',
            stageSummary: DEFAULT_STAGE_SUMMARIES[meta.id]
        };
    }
    return {
        selectedStageIndex: 0,
        stageName: latestSseStage,
        stageStatus: latestSseStage,
        stageSummary: `当前处于 ${latestSseStage} 阶段`
    };
}

const STAGE_SEQUENCE: readonly PipelineStageId[] = [
    'LIBRARIAN',
    'PLANNER',
    'WRITER',
    'FACT_CHECKER',
    'EXTRACTOR',
    'DREAMING'
];

function mapRunStatusToStageStatus(rawStatus: string): StageNodeStatus {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized === 'running' || normalized === 'active' || normalized === 'in_progress') {
        return 'active';
    }
    if (normalized === 'healing' || normalized === 'patch' || normalized === 'replan') {
        return 'healing';
    }
    if (normalized === 'halt' || normalized === 'failed' || normalized === 'error' || normalized === 'blocked') {
        return 'halt';
    }
    if (normalized === 'dormant' || normalized === 'skipped') {
        return 'dormant';
    }
    return 'done';
}

function deriveHistoricalStageOverrides(
    runs: readonly StageRunRecord[]
): Partial<Record<PipelineStageId, StageNodeState>> {
    const mapped: Partial<Record<PipelineStageId, StageNodeState>> = {};
    for (const run of runs) {
        const stageId = resolveStageId(run.stage);
        if (!stageId) continue;
        const sessionId = asString(run.sessionId);
        const parentSessionId = asString(run.parentSessionId);
        const mode = asString(run.mode);
        mapped[stageId] = {
            status: mapRunStatusToStageStatus(run.status),
            summary: DEFAULT_STAGE_SUMMARIES[stageId],
            updatedAt: run.finishedAt ?? run.startedAt ?? run.timestamp,
            runId: run.runId,
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
            ...(mode !== undefined ? { mode } : {})
        };
    }
    return mapped;
}

/**
 * NarrateOS Studio 根组件可选宿主集成属性：
 * 在完整 DSH Web 中由 SlotRegistry 注入 SessionProvider 与 renderSlot，
 * 在单元测试或独立预览中缺省时自动降级为只读元数据面板。
 */
export interface NarrateStudioRootProps {
    sessionsService?: StudioSessionsService | undefined;
    SessionProvider?: StudioSessionProviderComponent | undefined;
    renderStageConversation?: StudioRenderStageConversation | undefined;
}

/**
 * NarrateOS Operator Studio 前端根组件：
 * - 幂等注入样式表
 * - 初始化拉取作品列表、全局状态、章节列表、当前章详情与 6 类物化视图
 * - 订阅 /api/narrate/events SSE 实时流并驱动三栏联动刷新
 */
export function NarrateStudioRoot({
    sessionsService,
    SessionProvider,
    renderStageConversation
}: NarrateStudioRootProps = {}): React.ReactElement {
    const [booksState, setBooksState] = useState<BooksListPayload>({
        currentBookRoot: '',
        books: []
    });
    const [status, setStatus] = useState<NarrateStatusPayload | null>(null);
    const [chapters, setChapters] = useState<ChapterSummary[]>([]);
    const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
    const [chapterDetail, setChapterDetail] = useState<ChapterDetail | null>(null);

    const [entitiesView, setEntitiesView] = useState<EntitiesViewPayload | null>(null);
    const [horizonView, setHorizonView] = useState<MarkdownViewPayload | null>(null);
    const [threadsView, setThreadsView] = useState<MarkdownViewPayload | null>(null);
    const [telemetryView, setTelemetryView] = useState<TelemetryViewPayload | null>(null);
    const [signalsView, setSignalsView] = useState<SignalsViewPayload | null>(null);
    const [haltView, setHaltView] = useState<HaltViewPayload | null>(null);

    const [latestSseStage, setLatestSseStage] = useState<string | null>(null);
    const [haltWaiting, setHaltWaiting] = useState(false);
    const [stageOverrides, setStageOverrides] = useState<Partial<Record<PipelineStageId, StageNodeState>>>({});
    const [historicalRuns, setHistoricalRuns] = useState<StageRunRecord[]>([]);
    const [liveRunChapter, setLiveRunChapter] = useState<number | null>(null);
    const [selectedStageSession, setSelectedStageSession] = useState<StageSessionSelection | null>(null);
    const [liveTelemetry, setLiveTelemetry] = useState<TelemetryItem | null>(null);
    const [gateViolations, setGateViolations] = useState<ProseGateViolationItem[]>([]);
    const [factChecker, setFactChecker] = useState<FactCheckerTelemetry>({
        totalChecked: 0,
        verifiedPassCount: 0,
        filteredOutCount: 0,
        blockedCount: 0
    });

    const [loading, setLoading] = useState<boolean>(true);
    const [bootModalOpen, setBootModalOpen] = useState<boolean>(false);
    const [activeViewKind, setActiveViewKind] = useState<MaterializedViewKind | null>(null);
    const [externalViewCommand, setExternalViewCommand] = useState<ExternalViewCommand | undefined>(undefined);
    const [toasts, setToasts] = useState<ToastState[]>([]);

    const [containerWidth, setContainerWidth] = useState<number>(() =>
        typeof window !== 'undefined' ? window.innerWidth : 1280
    );
    const [rightOpen, setRightOpen] = useState<boolean>(() =>
        typeof window !== 'undefined' ? window.innerWidth >= 720 : true
    );
    const [rightTab, setRightTab] = useState<'toc' | 'insp' | 'session' | 'tools'>('toc');

    const shellRef = useRef<HTMLDivElement | null>(null);
    const prevWidthRef = useRef<number>(containerWidth);
    const viewCommandNonceRef = useRef<number>(0);
    const selectedChapterRef = useRef<number | null>(null);
    selectedChapterRef.current = selectedChapter;

    // 宿主 Toast 原语自管生命周期(onDone 卸载),这里只维护消息队列;错误延长驻留
    const toastSeqRef = useRef(0);
    const showToast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
        toastSeqRef.current += 1;
        const nextToast: ToastState = { id: toastSeqRef.current, message, kind };
        setToasts((prev) => [...prev.slice(-2), nextToast]);
    }, []);

    useEffect(() => {
        ensureStudioStyles();
    }, []);

    useEffect(() => {
        const el = shellRef.current;
        if (!el || typeof window === 'undefined') return;

        const updateWidth = (width: number) => {
            if (width <= 0) return;
            setContainerWidth(width);
            if (prevWidthRef.current >= 720 && width < 720) {
                setRightOpen(false);
            }
            prevWidthRef.current = width;
        };

        updateWidth(el.clientWidth || window.innerWidth);

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (entry) {
                    updateWidth(entry.contentRect.width);
                }
            });
            observer.observe(el);
            return () => observer.disconnect();
        }

        const onResize = () => updateWidth(el.clientWidth || window.innerWidth);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // 作品切换、保存交接会使旧读取失效；切换请求在途期间不读取全局当前作品。
    const workspaceEpochRef = useRef(0);
    const switchingBookRef = useRef(false);
    const refreshRequestRef = useRef(0);
    const viewsRequestRef = useRef(0);
    const statusRequestRef = useRef(0);
    const saveInFlightRef = useRef(false);
    const isCurrentWorkspace = useCallback((epoch: number) =>
        epoch === workspaceEpochRef.current && !switchingBookRef.current, []);

    const loadStatus = useCallback(async () => {
        if (switchingBookRef.current) return;
        const epoch = workspaceEpochRef.current;
        const seq = ++statusRequestRef.current;
        const next = await fetchStatus();
        if (isCurrentWorkspace(epoch) && seq === statusRequestRef.current &&
            (!currentBookRootRef.current || next.bookRoot === currentBookRootRef.current)) {
            setStatus(next);
        }
    }, [isCurrentWorkspace]);

    const loadViews = useCallback(async () => {
        if (switchingBookRef.current) return;
        const epoch = workspaceEpochRef.current;
        const seq = ++viewsRequestRef.current;
        const [entities, horizon, threads, telemetry, signals, halt] = await Promise.all([
            fetchViewEntities().catch(() => null),
            fetchViewHorizon().catch(() => null),
            fetchViewThreads().catch(() => null),
            fetchViewTelemetry().catch(() => null),
            fetchViewSignals().catch(() => null),
            fetchViewHalt().catch(() => null)
        ]);
        if (!isCurrentWorkspace(epoch) || seq !== viewsRequestRef.current) return;
        if (entities) setEntitiesView(entities);
        if (horizon) setHorizonView(horizon);
        if (threads) setThreadsView(threads);
        if (telemetry) setTelemetryView(telemetry);
        if (signals) setSignalsView(signals);
        if (halt) setHaltView(halt);
    }, [isCurrentWorkspace]);

    const [chapterLoading, setChapterLoading] = useState<boolean>(false);
    // 章节详情请求序号：乱序返回时只采纳最后一次请求，失败/空详情不清空既有详情与草稿
    const chapterRequestSeqRef = useRef(0);
    const runsRequestSeqRef = useRef(0);
    // 当前作品身份 ref：详情采纳前核对，防止切作品后旧书响应串章
    const currentBookRootRef = useRef<string>('');
    const loadRunsForChapter = useCallback(async (chapterNumber: number | null) => {
        if (switchingBookRef.current) return;
        if (chapterNumber === null || !Number.isFinite(chapterNumber) || chapterNumber <= 0) {
            setHistoricalRuns([]);
            return;
        }
        const seq = ++runsRequestSeqRef.current;
        const epoch = workspaceEpochRef.current;
        const bookRoot = currentBookRootRef.current;
        try {
            const payload = await fetchRunRecords(chapterNumber);
            if (!isCurrentWorkspace(epoch) || seq !== runsRequestSeqRef.current) return;
            if (bookRoot && currentBookRootRef.current && bookRoot !== currentBookRootRef.current) return;
            setHistoricalRuns(payload.runs);
        } catch {
            // 尚未启用 /api/narrate/runs 的旧后端静默降级为空列表，不阻塞正文阅读
            if (isCurrentWorkspace(epoch) && seq === runsRequestSeqRef.current) {
                setHistoricalRuns([]);
            }
        }
    }, [isCurrentWorkspace]);

    const loadChapterByNumber = useCallback(async (chapterNumber: number) => {
        if (switchingBookRef.current || !Number.isFinite(chapterNumber) || chapterNumber <= 0) {
            return;
        }
        const seq = ++chapterRequestSeqRef.current;
        const epoch = workspaceEpochRef.current;
        setChapterLoading(true);
        try {
            const detail = await fetchChapter(chapterNumber);
            if (!isCurrentWorkspace(epoch) || seq !== chapterRequestSeqRef.current) return;
            // 请求在途期间用户可能已开始改稿：采纳前再核对最新脏态，不同章/不同作品不得覆盖
            const dirtyNow = draftLocationRef.current;
            if (
                dirtyNow &&
                (dirtyNow.chapterNumber !== detail.chapterNumber ||
                    dirtyNow.bookRoot !== currentBookRootRef.current)
            ) {
                return;
            }
            setSelectedChapter(detail.chapterNumber);
            setChapterDetail(detail);
            void loadRunsForChapter(detail.chapterNumber);
        } catch (err) {
            if (!isCurrentWorkspace(epoch) || seq !== chapterRequestSeqRef.current) return;
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            if (isCurrentWorkspace(epoch) && seq === chapterRequestSeqRef.current) {
                setChapterLoading(false);
            }
        }
    }, [isCurrentWorkspace, loadRunsForChapter, showToast]);

    // 运行态忙判定提前派生：守卫保存与刷新回调都依赖它
    const activeTask = status?.runtime.activeTask ?? 'IDLE';
    const isBusy = activeTask !== 'IDLE' || Boolean(status?.yolo.running);

    // 未保存草稿位置（由中栏编辑器上报）；ref 供事件回调与守卫读取最新值
    const [draftLocation, setDraftLocation] = useState<DraftLocation | null>(null);
    const draftLocationRef = useRef<DraftLocation | null>(null);
    const handleDraftDirtyChange = useCallback((dirty: DraftLocation | null) => {
        // 同步写 ref：同一 tick 内的导航守卫/详情采纳立刻可见，不等下一次 render
        draftLocationRef.current = dirty;
        setDraftLocation(dirty);
    }, []);
    // 中栏草稿控制句柄：守卫保存成功/放弃修改后强制结束编辑态
    const draftControlRef = useRef<CenterWorkbenchDraftHandle | null>(null);
    const handleDraftControlReady = useCallback((handle: CenterWorkbenchDraftHandle | null) => {
        draftControlRef.current = handle;
    }, []);

    // 浏览器关闭/刷新时脏草稿保护（不要求跨重启恢复）
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onBeforeUnload = (ev: BeforeUnloadEvent) => {
            if (!draftLocationRef.current) return;
            ev.preventDefault();
            ev.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    const refreshAll = useCallback(async (preferredChapter?: number | null) => {
        if (switchingBookRef.current) return;
        const epoch = workspaceEpochRef.current;
        const seq = ++refreshRequestRef.current;
        const statusSeq = ++statusRequestRef.current;
        const chapterSeq = chapterRequestSeqRef.current;
        setLoading(true);
        try {
            let booksRes = await fetchBooks();
            if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;

            if (!booksRes.currentBookRoot && booksRes.books.length > 0 && !currentBookRootRef.current) {
                const defaultBook = booksRes.books[0];
                if (defaultBook) {
                    await selectBook({ bookRoot: defaultBook.bookRoot });
                    if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
                    booksRes = await fetchBooks();
                    if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
                }
            }

            setBooksState(booksRes);
            const activeRoot = booksRes.currentBookRoot;
            if (!activeRoot) {
                currentBookRootRef.current = '';
                setStatus(null);
                setChapters([]);
                setSelectedChapter(null);
                setChapterDetail(null);
                setHistoricalRuns([]);
                setEntitiesView(null);
                setHorizonView(null);
                setThreadsView(null);
                setTelemetryView(null);
                setSignalsView(null);
                setHaltView(null);
                return;
            }

            const [statusRes, chaptersRes] = await Promise.all([
                fetchStatus(),
                fetchChapters(),
                loadViews()
            ]);
            if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
            if (activeRoot !== statusRes.bookRoot ||
                (currentBookRootRef.current && activeRoot !== currentBookRootRef.current)) return;

            currentBookRootRef.current = activeRoot;
            if (statusSeq === statusRequestRef.current) setStatus(statusRes);
            setChapters(chaptersRes.chapters);
            setLatestSseStage(statusRes.yolo.currentStage ?? null);

            // 编辑中的脏草稿优先：任何后台刷新不得换章或替换详情
            const draft = draftLocationRef.current;
            if (draft && draft.bookRoot === booksRes.currentBookRoot) {
                setSelectedChapter(draft.chapterNumber);
                return;
            }
            // 用户在刷新期间主动选章或完成保存后，后台刷新不得覆盖其选择。
            if (chapterSeq !== chapterRequestSeqRef.current) return;

            const fallbackChapter =
                chaptersRes.chapters.length > 0
                    ? chaptersRes.chapters[chaptersRes.chapters.length - 1]!.chapterNumber
                    : null;
            const candidate =
                preferredChapter ??
                statusRes.activeChapter ??
                (statusRes.latestChapter > 0 ? statusRes.latestChapter : fallbackChapter);

            if (candidate !== null && candidate > 0) {
                await loadChapterByNumber(candidate);
            } else {
                setSelectedChapter(null);
                setChapterDetail(null);
                setHistoricalRuns([]);
            }

            if (statusRes.runtime.activeTask === 'STEPPING' || statusRes.yolo.running) {
                const activeTargetChapter = (statusRes.latestChapter ?? 0) + 1;
                const activeRunsRes = await fetchRunRecords(activeTargetChapter).catch(() => null);
                if (
                    activeRunsRes &&
                    activeRunsRes.runs.length > 0 &&
                    isCurrentWorkspace(epoch) &&
                    seq === refreshRequestRef.current
                ) {
                    setLiveRunChapter(activeTargetChapter);
                    setStageOverrides((prev) =>
                        Object.keys(prev).length > 0
                            ? prev
                            : deriveHistoricalStageOverrides(activeRunsRes.runs)
                    );
                }
            }
        } catch (err) {
            if (isCurrentWorkspace(epoch) && seq === refreshRequestRef.current) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        } finally {
            if (isCurrentWorkspace(epoch) && seq === refreshRequestRef.current) setLoading(false);
        }
    }, [isCurrentWorkspace, loadChapterByNumber, loadViews, showToast]);

    useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    const refreshAllRef = useRef(refreshAll);
    refreshAllRef.current = refreshAll;
    const loadViewsRef = useRef(loadViews);
    loadViewsRef.current = loadViews;
    const loadChapterRef = useRef(loadChapterByNumber);
    loadChapterRef.current = loadChapterByNumber;
    const loadRunsRef = useRef(loadRunsForChapter);
    loadRunsRef.current = loadRunsForChapter;

    // 订阅 SSE 实时事件流
    useEffect(() => {
        const handleSseEvent = (payload: SseEventPayload) => {
            const { event, data } = payload;

            if (event === 'book_switched') {
                if (switchingBookRef.current) return;
                const bookRoot = asString(data['bookRoot']);
                // HTTP 切书已确认后，同次 SSE 可能迟到；重复通知不能使本书在途保存失效。
                if (!bookRoot || bookRoot === currentBookRootRef.current) return;
                workspaceEpochRef.current += 1;
                chapterRequestSeqRef.current += 1;
                runsRequestSeqRef.current += 1;
                currentBookRootRef.current = bookRoot;
                setHaltWaiting(false);
                setStageOverrides({});
                setHistoricalRuns([]);
                setLiveRunChapter(null);
                setSelectedStageSession(null);
                setLiveTelemetry(null);
                setTelemetryView(null);
                setGateViolations([]);
                showToast('已切换当前作品仓库');
                void refreshAllRef.current(null);
                return;
            }
            if (switchingBookRef.current) return;

            if (event === 'stage' || event === 'chapter:phase') {
                const stageName = asString(data['stage']) ?? asString(data['phase']);
                if (!stageName) return;

                if (stageName === 'STARTING') {
                    setHaltWaiting(false);
                    setStageOverrides({});
                    setLiveRunChapter(asNumber(data['chapterNumber']) ?? asNumber(data['chapter']) ?? null);
                    setLatestSseStage('LIBRARIAN');
                    setStatus((prev) =>
                        prev
                            ? {
                                  ...prev,
                                  yolo: { ...prev.yolo, stopRequested: false },
                                  runtime: { ...prev.runtime, activeTask: 'STEPPING', haltRequested: false }
                              }
                            : prev
                    );
                    return;
                }

                if (stageName === 'FAILED') {
                    const errText = asString(data['error']) ?? '章节推进失败';
                    setStageOverrides((prev) => {
                        const next: Partial<Record<PipelineStageId, StageNodeState>> = { ...prev };
                        for (const id of STAGE_SEQUENCE) {
                            const cur = next[id];
                            if (cur && cur.status === 'active') {
                                next[id] = { ...cur, status: 'halt' };
                            }
                        }
                        return next;
                    });
                    showToast(errText, 'error');
                    void loadStatus().catch(() => undefined);
                    return;
                }

                setLatestSseStage(stageName);
                const message = asString(data['message']);
                const timestamp = asString(data['timestamp']);
                const eventChapter = asNumber(data['chapterNumber']) ?? asNumber(data['chapter']);
                if (eventChapter !== undefined) {
                    setLiveRunChapter(eventChapter);
                }
                const rawSessionId = asString(data['activeSessionId']) ?? asString(data['sessionId']);
                const rawParentSessionId = asString(data['parentSessionId']);
                const rawMode = asString(data['mode']);
                const runId = asString(data['runId']);
                const resolvedStage = resolveStageId(stageName);
                if (resolvedStage && (message || rawSessionId || runId)) {
                    // PROSE_GATE 每章例行校验,只是 Writer 运行中;LOCAL_PATCH 才是拦截返修
                    const isPatch = stageName === 'LOCAL_PATCH';
                    const sessionId = rawSessionId;
                    const parentSessionId = rawParentSessionId;
                    const mode = rawMode;
                    setStageOverrides((prev) => {
                        const next: Partial<Record<PipelineStageId, StageNodeState>> = { ...prev };
                        const resolvedIdx = STAGE_SEQUENCE.indexOf(resolvedStage);
                        for (let i = 0; i < STAGE_SEQUENCE.length; i++) {
                            const id = STAGE_SEQUENCE[i]!;
                            if (id === resolvedStage || id === 'DREAMING') continue;
                            const existing = next[id];
                            if (i < resolvedIdx && existing && existing.status === 'active') {
                                next[id] = { ...existing, status: 'done' };
                            }
                        }
                        const current = next[resolvedStage];
                        next[resolvedStage] = {
                            ...current,
                            status: isPatch ? 'healing' : 'active',
                            summary: message ?? current?.summary ?? DEFAULT_STAGE_SUMMARIES[resolvedStage],
                            updatedAt: timestamp ?? current?.updatedAt,
                            ...(isPatch ? { badge: '门禁 Patch' } : {}),
                            ...(sessionId !== undefined ? { sessionId } : {}),
                            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
                            ...(mode !== undefined ? { mode } : {}),
                            ...(runId !== undefined ? { runId } : {})
                        };
                        return next;
                    });
                    if (sessionId !== undefined) {
                        setSelectedStageSession((prev) =>
                            prev && prev.sessionId === sessionId
                                ? { ...prev, status: isPatch ? 'healing' : 'active' }
                                : prev
                        );
                    }
                }

                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              yolo: { ...prev.yolo, currentStage: stageName }
                          }
                        : prev
                );

                if (stageName === 'COMMITTED') {
                    const committedCh = asNumber(data['chapterNumber']);
                    setStageOverrides((prev) => {
                        const next: Partial<Record<PipelineStageId, StageNodeState>> = { ...prev };
                        for (const id of STAGE_SEQUENCE) {
                            if (id === 'DREAMING') continue;
                            const cur = next[id];
                            if (cur && (cur.status === 'active' || cur.status === 'healing')) {
                                next[id] = { ...cur, status: 'done' };
                            }
                        }
                        return next;
                    });
                    showToast(
                        committedCh
                            ? `Ch.${String(committedCh).padStart(4, '0')} 已提交至 Git WAL`
                            : '章节已提交至 Git WAL'
                    );
                    // 后台提交不抢编辑章：有脏草稿只刷新数据；无脏草稿保持自动跟随
                    const commitAction = resolveBackgroundCommitAction(
                        committedCh ?? null,
                        selectedChapterRef.current,
                        draftLocationRef.current !== null
                    );
                    void refreshAllRef.current(
                        commitAction === 'follow' ? committedCh : selectedChapterRef.current
                    );
                    void loadRunsRef.current(committedCh ?? selectedChapterRef.current);
                }
                return;
            }

            if (event === 'gate:result') {
                const item: TelemetryItem = {
                    chapter: asNumber(data['chapter']),
                    clicheDensityPer1k: asNumber(data['clicheDensityPer1k']),
                    mattr500: asNumber(data['mattr500']),
                    sentenceLengthCv: asNumber(data['sentenceLengthCv'])
                };
                setLiveTelemetry((prev) => ({ ...prev, ...item }));
                if (Array.isArray(data['violations'])) {
                    const mapped: ProseGateViolationItem[] = data['violations']
                        .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === 'object'))
                        .map((v) => ({
                            rule: asString(v['rule']) ?? 'GATE',
                            detail: asString(v['detail']) ?? JSON.stringify(v),
                            patched: Boolean(v['patched'])
                        }));
                    setGateViolations(mapped);
                }
                return;
            }

            if (event === 'checker:result') {
                const replanCount = asNumber(data['replanCount']) ?? 0;
                const rewriteCount = asNumber(data['rewriteCount']) ?? 0;
                const patchRounds = asNumber(data['patchRounds']) ?? 0;
                setFactChecker((prev) => ({
                    ...prev,
                    totalChecked: prev.totalChecked + 1,
                    verifiedPassCount:
                        replanCount === 0 && rewriteCount === 0
                            ? prev.verifiedPassCount + 1
                            : prev.verifiedPassCount,
                    blockedCount: prev.blockedCount ? prev.blockedCount + replanCount + rewriteCount : replanCount + rewriteCount
                }));
                setStageOverrides((prev) => ({
                    ...prev,
                    FACT_CHECKER: {
                        status: replanCount > 0 || rewriteCount > 0 ? 'healing' : 'done',
                        summary: `replan=${replanCount}, rewrite=${rewriteCount}, patch=${patchRounds}`
                    }
                }));
                return;
            }

            if (event === 'telemetry') {
                const nextItem = data as TelemetryItem;
                setLiveTelemetry((prev) => ({ ...prev, ...nextItem }));
                setTelemetryView((prev) =>
                    prev ? { ...prev, entries: [...prev.entries, nextItem] } : { kind: 'telemetry', entries: [nextItem] }
                );
                return;
            }

            if (event === 'signal:received') {
                void loadViewsRef.current();
                void loadStatus().catch(() => undefined);
                showToast('导演信号已入队');
                return;
            }

            if (event === 'signal:withdrawn') {
                void loadViewsRef.current();
                return;
            }

            if (event === 'sync:started') {
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, activeTask: 'SYNCING' } } : prev
                );
                return;
            }

            if (event === 'sync:completed' || event === 'chapter_synced') {
                const ch = asNumber(data['chapterNumber']);
                showToast(
                    ch
                        ? `Ch.${String(ch).padStart(4, '0')} 手改同步完成`
                        : '全书手改差异同步完成'
                );
                void refreshAllRef.current(selectedChapterRef.current);
                if (ch && ch === selectedChapterRef.current) {
                    void loadChapterRef.current(ch);
                } else if (selectedChapterRef.current) {
                    void loadChapterRef.current(selectedChapterRef.current);
                }
                return;
            }

            if (event === 'dream:started') {
                const dreamSessionId = asString(data['activeSessionId']) ?? asString(data['sessionId']);
                const dreamParentSessionId = asString(data['parentSessionId']);
                const dreamMode = asString(data['mode']);
                const dreamRunId = asString(data['runId']);
                const dreamMessage = asString(data['message']);
                setLatestSseStage('DREAMING');
                if (dreamSessionId || dreamRunId || dreamMessage) {
                    setStageOverrides((prev) => ({
                        ...prev,
                        DREAMING: {
                            ...prev.DREAMING,
                            status: 'active',
                            summary: dreamMessage ?? prev.DREAMING?.summary ?? DEFAULT_STAGE_SUMMARIES.DREAMING,
                            ...(dreamSessionId !== undefined ? { sessionId: dreamSessionId } : {}),
                            ...(dreamParentSessionId !== undefined
                                ? { parentSessionId: dreamParentSessionId }
                                : {}),
                            ...(dreamMode !== undefined ? { mode: dreamMode } : {}),
                            ...(dreamRunId !== undefined ? { runId: dreamRunId } : {})
                        }
                    }));
                }
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, activeTask: 'DREAMING' } } : prev
                );
                return;
            }

            if (event === 'dream:completed') {
                setStageOverrides((prev) =>
                    prev.DREAMING
                        ? {
                              ...prev,
                              DREAMING: { ...prev.DREAMING, status: 'done' }
                          }
                        : prev
                );
                setSelectedStageSession((prev) =>
                    prev && prev.stageId === 'DREAMING' ? { ...prev, status: 'done' } : prev
                );
                showToast('Dreaming 睡眠 VACUUM 与连续性整理完成');
                void loadStatus().catch(() => undefined);
                void loadViewsRef.current();
                void loadRunsRef.current(selectedChapterRef.current);
                return;
            }

            if (event === 'halt:requested') {
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, haltRequested: true } } : prev
                );
                showToast('已请求在安全检查点停机');
                return;
            }

            if (event === 'halt:waiting') {
                setHaltWaiting(true);
                setStatus((prev) => prev
                    ? { ...prev, runtime: { ...prev.runtime, haltRequested: true } }
                    : prev);
                return;
            }

            if (event === 'halt:completed') {
                setHaltWaiting(false);
                // 完成事件之后宿主会关闭 SSE，不能依赖随后 HTTP 读取来结束等待。
                setStatus((prev) => prev ? {
                    ...prev,
                    runtime: { ...prev.runtime, activeTask: 'IDLE', haltRequested: true },
                    yolo: { ...prev.yolo, running: false, stopRequested: true, currentStage: null }
                } : prev);
                return;
            }

            if (event === 'yolo:stop_requested') {
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              yolo: { ...prev.yolo, stopRequested: true }
                          }
                        : prev
                );
                showToast('已请求在本章安全点后停止 YOLO 连跑');
                return;
            }

            if (event === 'yolo_halted') {
                const reason = asString(data['reason']) ?? 'HALTED';
                const errText = asString(data['error']);
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              yolo: { ...prev.yolo, running: false, currentStage: null },
                              runtime: { ...prev.runtime, activeTask: 'IDLE' }
                          }
                        : prev
                );
                showToast(
                    errText ? `YOLO 已停止 (${reason}): ${errText}` : `YOLO 已在安全点停止 (${reason})`,
                    reason === 'SAFE_HALT' || reason === 'ERROR' ? 'error' : 'info'
                );
                void refreshAllRef.current(selectedChapterRef.current);
                return;
            }

            if (event === 'yolo_completed') {
                const completed = asNumber(data['completedChapters']) ?? 0;
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              yolo: {
                                  ...prev.yolo,
                                  running: false,
                                  completedChapters: completed,
                                  currentStage: null
                              },
                              runtime: { ...prev.runtime, activeTask: 'IDLE' }
                          }
                        : prev
                );
                showToast(`YOLO 连跑已完成（共推进 ${completed} 章）`);
                void refreshAllRef.current(selectedChapterRef.current);
            }
        };

        const unsubscribe = subscribeNarrateEvents(handleSseEvent);
        return () => {
            unsubscribe();
        };
    }, [loadStatus, showToast]);

    // 交互操作回调：主动导航先经脏草稿守卫，确认后才执行
    const executeSelectBook = useCallback(
        async (bookRoot: string) => {
            if (switchingBookRef.current || saveInFlightRef.current) return;
            switchingBookRef.current = true;
            workspaceEpochRef.current += 1;
            chapterRequestSeqRef.current += 1;
            runsRequestSeqRef.current += 1;
            setLoading(true);
            setChapterLoading(true);
            setChapterDetail(null);
            setSelectedChapter(null);
            setHistoricalRuns([]);
            setStageOverrides({});
            setLiveRunChapter(null);
            setSelectedStageSession(null);
            try {
                await selectBook({ bookRoot });
                currentBookRootRef.current = bookRoot;
                setHaltWaiting(false);
                setEntitiesView(null);
                setHorizonView(null);
                setThreadsView(null);
                setTelemetryView(null);
                setSignalsView(null);
                setHaltView(null);
                showToast('正在切换作品目录…');
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            } finally {
                switchingBookRef.current = false;
                setChapterLoading(false);
                await refreshAll(null);
            }
        },
        [refreshAll, showToast]
    );

    const executeSelectChapter = useCallback(
        (chapterNumber: number) => {
            viewCommandNonceRef.current += 1;
            setExternalViewCommand({
                viewTab: 'prose',
                nonce: viewCommandNonceRef.current
            });
            void loadChapterByNumber(chapterNumber);
        },
        [loadChapterByNumber]
    );

    const executeNavigationIntent = useCallback(
        (intent: DraftNavigationIntent) => {
            if (intent.kind === 'chapter') {
                executeSelectChapter(intent.chapterNumber);
            } else if (intent.kind === 'book') {
                void executeSelectBook(intent.bookRoot);
            } else {
                setBootModalOpen(true);
            }
        },
        [executeSelectBook, executeSelectChapter]
    );

    // 待确认导航（宿主 Modal：保存并继续 / 放弃修改 / 取消）
    const [pendingNavigation, setPendingNavigation] = useState<DraftNavigationIntent | null>(null);
    const [guardSaving, setGuardSaving] = useState(false);
    const [guardError, setGuardError] = useState<string | null>(null);

    const requestNavigation = useCallback(
        (intent: DraftNavigationIntent) => {
            if (saveInFlightRef.current || switchingBookRef.current) {
                showToast('正在保存或切换作品，请等待操作完成后再导航');
                return;
            }
            if (decideDraftNavigation(draftLocationRef.current, intent) === 'confirm') {
                setGuardError(null);
                setPendingNavigation(intent);
                return;
            }
            executeNavigationIntent(intent);
        },
        [executeNavigationIntent, showToast]
    );

    const handleSelectBook = useCallback(
        (bookRoot: string) => {
            requestNavigation({ kind: 'book', bookRoot });
        },
        [requestNavigation]
    );

    const handleSelectChapter = useCallback(
        (chapterNumber: number) => {
            requestNavigation({ kind: 'chapter', chapterNumber });
        },
        [requestNavigation]
    );

    const handleOpenNewBook = useCallback(() => {
        requestNavigation({ kind: 'new-book' });
    }, [requestNavigation]);

    const handleOpenView = useCallback(
        (kind: MaterializedViewKind) => {
            setActiveViewKind(kind);
            viewCommandNonceRef.current += 1;
            setExternalViewCommand({
                viewTab: 'views',
                materialKind: kind,
                nonce: viewCommandNonceRef.current
            });
            void loadViews();
        },
        [loadViews]
    );

    const handleStepOne = useCallback(async () => {
        const res = await stepChapter({
            chapterGoal: '按既定主线与人物弧光自然推进下一章'
        });
        await refreshAll(res.chapterNumber);
    }, [refreshAll]);

    const handleStartYolo = useCallback(
        async (targetChapters: number) => {
            await startYolo({ targetChapters });
            await loadStatus();
        },
        [loadStatus]
    );

    const handleStopYolo = useCallback(async () => {
        await stopYolo();
        await loadStatus();
    }, [loadStatus]);

    const handleSync = useCallback(async () => {
        await syncManuscripts();
        await refreshAll(selectedChapterRef.current);
    }, [refreshAll]);

    const handleDream = useCallback(async () => {
        await runDreaming({ force: true });
        await Promise.all([loadStatus(), loadViews()]);
    }, [loadStatus, loadViews]);

    const handleSaveModelRouting = useCallback(
        async (payload: SaveModelRoutingRequest) => {
            if (switchingBookRef.current) {
                throw new Error('正在切换作品，请稍后重试');
            }
            const bookRoot = currentBookRootRef.current;
            const epoch = workspaceEpochRef.current;
            try {
                const res = await saveModelRouting(payload);
                if (!isCurrentWorkspace(epoch) || currentBookRootRef.current !== bookRoot) return;
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              ...(res.modelRouting !== undefined
                                  ? { modelRouting: res.modelRouting }
                                  : {}),
                              ...(res.roleRouting !== undefined
                                  ? { roleRouting: res.roleRouting }
                                  : {}),
                              ...(res.roleDefinitions !== undefined
                                  ? { roleDefinitions: res.roleDefinitions }
                                  : {})
                          }
                        : prev
                );
                await loadStatus().catch(() => undefined);
                showToast('工种模型配置已保存');
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
                throw err;
            }
        },
        [isCurrentWorkspace, loadStatus, showToast]
    );

    const handleRequestHalt = useCallback(async () => {
        try {
            await requestHalt();
            showToast('已发送安全停机请求，将在安全检查点挂起');
            await loadStatus();
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        }
    }, [loadStatus, showToast]);

    // 两个保存入口共用：已提交正文先交给渲染数据源，后续读取失败不改写保存结果。
    const handleSaveChapter = useCallback(
        async (chapterNumber: number, content: string) => {
            if (saveInFlightRef.current || switchingBookRef.current) {
                throw new Error('正在保存或切换作品，请等待当前操作完成');
            }
            const bookRoot = currentBookRootRef.current;
            const epoch = workspaceEpochRef.current;
            saveInFlightRef.current = true;
            try {
                await saveChapter({ chapterNumber, content });
                if (!isCurrentWorkspace(epoch) || currentBookRootRef.current !== bookRoot) return;
                // PUT 之前启动的详情和整批刷新均不能再发布旧正文或旧状态。
                workspaceEpochRef.current += 1;
                chapterRequestSeqRef.current += 1;
                setChapterLoading(false);
                setChapterDetail((prev) =>
                    currentBookRootRef.current === bookRoot && prev?.chapterNumber === chapterNumber
                        ? { ...prev, content }
                        : prev
                );
                void Promise.allSettled([
                    refreshAll(chapterNumber),
                    loadChapterByNumber(chapterNumber)
                ]);
            } finally {
                saveInFlightRef.current = false;
            }
        },
        [isCurrentWorkspace, loadChapterByNumber, refreshAll]
    );

    // 确认弹窗「保存并继续」：busy 或保存失败时留在原地，草稿不丢、不导航
    const handleGuardSaveAndContinue = useCallback(async () => {
        if (saveInFlightRef.current || switchingBookRef.current) return;
        const intent = pendingNavigation;
        const draft = draftLocationRef.current;
        if (!intent || !draft) {
            setPendingNavigation(null);
            return;
        }
        if (isBusy) {
            setGuardError('引擎正在执行任务，暂时无法保存；请待任务结束后重试或放弃修改');
            return;
        }
        setGuardSaving(true);
        setGuardError(null);
        try {
            await handleSaveChapter(draft.chapterNumber, draft.content);
        } catch (err) {
            setGuardError(err instanceof Error ? err.message : String(err));
            setGuardSaving(false);
            return;
        }
        // PUT 已成功即放行导航；保存后的状态刷新失败不阻塞导航
        setGuardSaving(false);
        setPendingNavigation(null);
        setDraftLocation(null);
        draftLocationRef.current = null;
        draftControlRef.current?.resetDraft(draft.content);
        executeNavigationIntent(intent);
    }, [executeNavigationIntent, handleSaveChapter, isBusy, pendingNavigation]);

    // 确认弹窗「放弃修改」：立即结束编辑态并清脏标记，再执行导航
    const handleGuardDiscardAndContinue = useCallback(() => {
        if (saveInFlightRef.current || switchingBookRef.current) return;
        const intent = pendingNavigation;
        setPendingNavigation(null);
        setGuardError(null);
        draftControlRef.current?.resetDraft();
        draftLocationRef.current = null;
        setDraftLocation(null);
        if (intent) {
            executeNavigationIntent(intent);
        }
    }, [executeNavigationIntent, pendingNavigation]);

    const handleSubmitSignal = useCallback(
        async (payload: SubmitSignalPayload) => {
            const currentCh = status?.worldState.current_chapter ?? status?.latestChapter ?? 0;
            const req = buildSignalPayload(payload.kind, payload.content, currentCh);
            await postSignal(req);
            await Promise.all([
                loadViews(),
                loadStatus()
            ]);
            if (payload.runAfter) {
                await handleStepOne();
            }
        },
        [handleStepOne, loadStatus, loadViews, status]
    );

    // 撤回纸条:后端按内容匹配真删,失败时保留队列并就地报错
    const handleDismissSignal = useCallback(async (idx: number) => {
        const item = mapPendingSignals(signalsView)[idx];
        const reason = item?.reason ?? item?.raw;
        if (!item?.created_at || !reason) {
            showToast('该纸条缺少撤回所需的元数据', 'error');
            return;
        }
        try {
            await deleteSignal({ created_at: item.created_at, reason });
            await loadViews();
            showToast('纸条已撤回');
        } catch (err) {
            showToast(err instanceof Error ? err.message : '撤回纸条失败', 'error');
        }
    }, [loadViews, signalsView, showToast]);

    // 派生右侧与中间栏视图模型
    const activeBookSummary = useMemo(
        () => booksState.books.find((b) => b.bookRoot === (status?.bookRoot ?? booksState.currentBookRoot)),
        [booksState.books, booksState.currentBookRoot, status?.bookRoot]
    );

    const latestTelemetryEntry = useMemo<TelemetryItem | null>(() => {
        if (liveTelemetry) return liveTelemetry;
        const entries = telemetryView?.entries ?? [];
        return entries.length > 0 ? entries[entries.length - 1]! : null;
    }, [liveTelemetry, telemetryView]);

    const aggregateTokens = useMemo(
        () => aggregateTelemetryTokens(telemetryView?.entries ?? []),
        [telemetryView]
    );

    const latestMetrics = useMemo(
        () => readTelemetryMetrics(latestTelemetryEntry),
        [latestTelemetryEntry]
    );

    const inspectorEntities = useMemo<InspectorEntityItem[]>(() => {
        if (!entitiesView?.entities) return [];
        return entitiesView.entities.map((ent) => ({
            id: ent.entityId,
            name: ent.canonicalName,
            ...(ent.aliases.length > 0 ? { role: ent.aliases.slice(0, 2).join(' / ') } : {}),
            ...(ent.lastSeenChapter > 0 ? { lastChapter: ent.lastSeenChapter } : {}),
            ...(ent.markdown ? { brief: ent.markdown.slice(0, 120) } : {})
        }));
    }, [entitiesView]);

    const inspectorOpenThreads = useMemo<OpenThreadItem[]>(() => {
        const md = threadsView?.content ?? '';
        if (!md.trim()) return [];
        const items: OpenThreadItem[] = [];
        for (const rawLine of md.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('# ')) continue;
            const bulletMatch = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
            const headingMatch = line.match(/^##+\s+(.+)$/);
            const text = bulletMatch?.[1] ?? headingMatch?.[1];
            if (!text) continue;
            const chMatch = text.match(/(?:Ch\.?|第)\s*(\d+)\s*章?/i);
            const chapter = chMatch?.[1] ? Number(chMatch[1]) : undefined;
            items.push({
                title: text.trim(),
                ...(chapter !== undefined && Number.isFinite(chapter) ? { chapter } : {})
            });
        }
        return items;
    }, [threadsView]);

    const inspectorVolumeProgress = useMemo<VolumeProgressSnapshot | null>(() => {
        if (!status && !horizonView?.content) return null;
        const statusExt = status as (NarrateStatusPayload & { volumeProgress?: VolumeProgressSnapshot }) | null;
        const rawVol = statusExt?.volumeProgress;
        const horizonExcerpt = horizonView?.content?.trim()
            ? horizonView.content.trim().slice(0, 240)
            : null;
        // 只透传真实的当前卷数据；缺完成数/目标时不得用全书章号伪装卷进度
        return {
            ...(rawVol?.volumeLabel ? { volumeLabel: rawVol.volumeLabel } : {}),
            ...(rawVol?.volumeTitle ? { volumeTitle: rawVol.volumeTitle } : {}),
            ...(rawVol?.completedChapters !== undefined
                ? { completedChapters: rawVol.completedChapters }
                : {}),
            ...(rawVol?.totalChapters !== undefined ? { totalChapters: rawVol.totalChapters } : {}),
            futureHorizon: rawVol?.futureHorizon ?? horizonExcerpt,
            ...(rawVol?.milestoneLock !== undefined ? { milestoneLock: rawVol.milestoneLock } : {})
        };
    }, [status, horizonView]);

    const dirtyChaptersCount = useMemo(
        () => chapters.filter((item) => item.dirty).length,
        [chapters]
    );

    const safeHaltInfo = useMemo(() => mapSafeHaltInfo(haltView?.safeHalt), [haltView]);
    const haltDiagnostic = useMemo(() => mapHaltDiagnostic(haltView), [haltView]);
    const pendingSignals = useMemo(() => mapPendingSignals(signalsView), [signalsView]);

    const historicalStageOverrides = useMemo(
        () => deriveHistoricalStageOverrides(historicalRuns),
        [historicalRuns]
    );

    const effectiveStages = useMemo<Partial<Record<PipelineStageId, StageNodeState>>>(() => {
        const isLiveUncommittedChapter =
            liveRunChapter !== null &&
            !chapters.some((ch) => ch.chapterNumber === liveRunChapter);
        const shouldOverlayLive =
            liveRunChapter === null ||
            selectedChapter === null ||
            liveRunChapter === selectedChapter ||
            isLiveUncommittedChapter;
        if (!shouldOverlayLive) {
            return historicalStageOverrides;
        }
        const merged: Partial<Record<PipelineStageId, StageNodeState>> = {
            ...historicalStageOverrides
        };
        for (const id of STAGE_SEQUENCE) {
            const live = stageOverrides[id];
            if (live) {
                merged[id] = {
                    ...merged[id],
                    ...live
                };
            }
        }
        return merged;
    }, [chapters, historicalStageOverrides, liveRunChapter, selectedChapter, stageOverrides]);

    const stageArtifact = useMemo(() => {
        const base = deriveStageArtifact(latestSseStage);
        const resolved = latestSseStage ? resolveStageId(latestSseStage) : null;
        const boundSession = resolved ? effectiveStages[resolved]?.sessionId ?? null : null;
        return boundSession ? { ...base, sessionId: boundSession } : base;
    }, [effectiveStages, latestSseStage]);

    const handleSelectStageSession = useCallback((selection: StageSessionSelection) => {
        setSelectedStageSession(selection);
        setRightTab('session');
        setRightOpen(true);
    }, []);

    const handleInspectStageSessionById = useCallback(
        (sessionId: string) => {
            const matchedId = STAGE_SEQUENCE.find(
                (id) => effectiveStages[id]?.sessionId === sessionId
            );
            const meta = matchedId
                ? PIPELINE_STAGE_META.find((item) => item.id === matchedId)
                : undefined;
            const nodeState = matchedId ? effectiveStages[matchedId] : undefined;
            handleSelectStageSession({
                stageId: matchedId ?? 'STAGE',
                stageLabel: meta?.label ?? stageArtifact.stageName,
                sessionId,
                ...(nodeState?.parentSessionId !== undefined
                    ? { parentSessionId: nodeState.parentSessionId }
                    : {}),
                ...(nodeState?.mode !== undefined ? { mode: nodeState.mode } : {}),
                runId: nodeState?.runId,
                status: nodeState?.status ?? 'done'
            });
        },
        [effectiveStages, handleSelectStageSession, stageArtifact.stageName]
    );

    const warpedHorizonCount = useMemo(() => {
        const md = horizonView?.content ?? '';
        const matches = md.match(/WARPED/gi);
        return matches ? matches.length : 0;
    }, [horizonView]);

    const openThreadsCount = useMemo(() => {
        const md = threadsView?.content ?? '';
        const matches = md.match(/^[-*]\s+|^\d+\.\s+|^##\s+/gm);
        return matches ? matches.length : 0;
    }, [threadsView]);

    const modelPools = useMemo(() => {
        const routing = status?.modelRouting ?? {};
        return {
            strongModel: routing['strong_creative'] ?? routing['strong'] ?? 'strong',
            fastModel: routing['fast_retrieval'] ?? routing['fast'] ?? 'fast',
            auditModel: routing['audit'] ?? 'audit'
        };
    }, [status?.modelRouting]);

    const centerChapterDetail: CenterWorkbenchProps['chapterDetail'] = useMemo(() => {
        if (!chapterDetail) return null;
        const summary = chapters.find((c) => c.chapterNumber === chapterDetail.chapterNumber);
        return {
            chapterNumber: chapterDetail.chapterNumber,
            title: summary?.title,
            content: chapterDetail.content,
            dirty: chapterDetail.dirty,
            sha256: chapterDetail.sha256,
            diffFromHead: chapterDetail.diffFromHead,
            outlineText: chapterDetail.outlineText,
            outlineStatus: chapterDetail.outlineStatus
        };
    }, [chapterDetail, chapters]);

    const isNarrow = containerWidth < 720;
    const shellStyle = {
        '--ns-right-w': rightOpen && !isNarrow ? (containerWidth < 1040 ? '296px' : '332px') : '0px'
    } as React.CSSProperties;

    return (
        <div
            ref={shellRef}
            className={`ns-studio-shell ${rightOpen ? 'ns-right-open' : 'ns-right-closed'} ${isNarrow ? 'ns-narrow' : ''}`}
            style={shellStyle}
        >
            <CenterWorkbench
                bookTitle={status?.title ?? activeBookSummary?.title}
                bookSlug={status?.bookSlug ?? activeBookSummary?.slug}
                currentBookRoot={status?.bookRoot ?? booksState.currentBookRoot ?? undefined}
                books={booksState.books}
                currentChapter={status?.worldState.current_chapter ?? status?.latestChapter ?? 0}
                selectedChapter={selectedChapter ?? undefined}
                timelineMode={String(status?.worldState.timeline_mode ?? 'MAINLINE')}
                walPhase={status?.walPhase ?? 'IDLE'}
                activeTask={activeTask}
                haltRequested={status?.runtime.haltRequested}
                haltWaiting={haltWaiting}
                yolo={status?.yolo}
                chapters={chapters}
                chapterDetail={centerChapterDetail}
                chapterLoading={chapterLoading}
                stages={effectiveStages}
                latestSseStage={latestSseStage}
                safeHalt={safeHaltInfo}
                pendingSignals={pendingSignals}
                pendingSignalsCount={pendingSignals.length}
                materializedViews={{
                    entities: entitiesView?.entities,
                    coldArchiveCount: entitiesView?.coldArchiveCount,
                    horizonMarkdown: horizonView?.content,
                    threadsMarkdown: threadsView?.content
                }}
                dirtyChaptersCount={dirtyChaptersCount}
                externalViewCommand={externalViewCommand}
                rightOpen={rightOpen}
                hasSafeHalt={Boolean(safeHaltInfo)}
                onSelectBook={handleSelectBook}
                onNewBook={handleOpenNewBook}
                onToggleRight={() => setRightOpen((prev) => !prev)}
                onOpenInspector={() => {
                    setRightOpen(true);
                    setRightTab('insp');
                }}
                onDismissSignal={(idx) => {
                    void handleDismissSignal(idx);
                }}
                onSelectChapter={handleSelectChapter}
                onStepOne={handleStepOne}
                onStartYolo={handleStartYolo}
                onStopYolo={handleStopYolo}
                onSync={handleSync}
                onDream={handleDream}
                onSaveChapter={handleSaveChapter}
                onSubmitSignal={handleSubmitSignal}
                onRefreshViews={loadViews}
                onDraftDirtyChange={handleDraftDirtyChange}
                onDraftControlReady={handleDraftControlReady}
                onRetryChapterDetail={() => {
                    if (chapterDetail) {
                        void loadChapterByNumber(chapterDetail.chapterNumber);
                    }
                }}
                onSelectStageSession={handleSelectStageSession}
            />

            {isNarrow && rightOpen ? (
                <div
                    className="ns-drawer-backdrop"
                    aria-hidden="true"
                    onClick={() => setRightOpen(false)}
                />
            ) : null}

            {/* 右侧四页签辅助栏：目录 | 检查器 | 会话 | 工具 */}
            <aside className="ns-right" aria-label="右侧辅助栏">
                <div className="ns-r-head">
                    <div className="ns-r-tabs" role="tablist" aria-label="作品辅助视图" onKeyDown={handleTabKeyDown}>
                        <button
                            type="button"
                            role="tab"
                            id="ns-right-tab-toc"
                            aria-controls="ns-right-panel"
                            tabIndex={rightTab === 'toc' ? 0 : -1}
                            aria-selected={rightTab === 'toc'}
                            className={`ns-r-tab ${rightTab === 'toc' ? 'on' : ''}`}
                            onClick={() => setRightTab('toc')}
                        >
                            目录
                        </button>
                        <button
                            type="button"
                            role="tab"
                            id="ns-right-tab-insp"
                            aria-controls="ns-right-panel"
                            tabIndex={rightTab === 'insp' ? 0 : -1}
                            aria-selected={rightTab === 'insp'}
                            className={`ns-r-tab ${rightTab === 'insp' ? 'on' : ''}`}
                            onClick={() => setRightTab('insp')}
                        >
                            检查器
                            {safeHaltInfo ? <span className="ns-r-dot" aria-hidden="true" /> : null}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            id="ns-right-tab-session"
                            aria-controls="ns-right-panel"
                            tabIndex={rightTab === 'session' ? 0 : -1}
                            aria-selected={rightTab === 'session'}
                            className={`ns-r-tab ${rightTab === 'session' ? 'on' : ''}`}
                            onClick={() => setRightTab('session')}
                        >
                            会话
                            {selectedStageSession?.status === 'active' ? (
                                <span className="ns-r-dot" aria-hidden="true" />
                            ) : null}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            id="ns-right-tab-tools"
                            aria-controls="ns-right-panel"
                            tabIndex={rightTab === 'tools' ? 0 : -1}
                            aria-selected={rightTab === 'tools'}
                            className={`ns-r-tab ${rightTab === 'tools' ? 'on' : ''}`}
                            onClick={() => setRightTab('tools')}
                        >
                            工具
                        </button>
                    </div>
                    <button
                        type="button"
                        className="ns-icon-btn"
                        onClick={() => setRightOpen(false)}
                        title="收起右侧辅助栏"
                        aria-label="收起右侧辅助栏"
                    >
                        ×
                    </button>
                </div>

                <div className="ns-r-body" id="ns-right-panel" role="tabpanel" aria-labelledby={`ns-right-tab-${rightTab}`} tabIndex={0}>
                    {rightTab === 'toc' ? (
                        <LeftBookNav
                            embedded
                            currentBookRoot={status?.bookRoot ?? booksState.currentBookRoot ?? ''}
                            currentTitle={status?.title ?? activeBookSummary?.title ?? ''}
                            currentSlug={status?.bookSlug ?? activeBookSummary?.slug ?? ''}
                            chapterCount={status?.chapterCount ?? chapters.length}
                            storyDay={status?.worldState.story_day ?? 0}
                            walPhase={status?.walPhase ?? 'IDLE'}
                            books={booksState.books}
                            chapters={chapters}
                            selectedChapter={selectedChapter}
                            entityCount={entitiesView?.entities.length ?? status?.entityCount ?? 0}
                            coldArchiveCount={entitiesView?.coldArchiveCount ?? status?.coldArchiveCount ?? 0}
                            warpedHorizonCount={warpedHorizonCount}
                            openThreadsCount={openThreadsCount}
                            activeViewKind={activeViewKind}
                            loading={loading}
                            onSelectBook={handleSelectBook}
                            onNewBook={handleOpenNewBook}
                            onSelectChapter={(ch) => {
                                handleSelectChapter(ch);
                                if (isNarrow) setRightOpen(false);
                            }}
                            onOpenView={(kind) => {
                                handleOpenView(kind);
                                if (isNarrow) setRightOpen(false);
                            }}
                        />
                    ) : null}

                    {rightTab === 'insp' ? (
                        <RightOpsInspector
                            walLock={{
                                walPhase: status?.walPhase ?? 'IDLE',
                                timelineMode: String(status?.worldState.timeline_mode ?? 'MAINLINE'),
                                txLockStatus: activeTask !== 'IDLE' ? 'locked' : 'free',
                                txLockHolder: activeTask !== 'IDLE' ? activeTask : null,
                                lastCommittedChapter: status?.lastCommittedChapter ?? 0,
                                activeChapter: status?.activeChapter ?? null
                            }}
                            modelPool={{
                                fastModel: modelPools.fastModel,
                                strongModel: modelPools.strongModel,
                                auditModel: modelPools.auditModel,
                                inputTokens: aggregateTokens.inputTokens,
                                cacheReadTokens: aggregateTokens.cacheReadTokens,
                                cacheWriteTokens: aggregateTokens.cacheWriteTokens,
                                outputTokens: aggregateTokens.outputTokens
                            }}
                            stageArtifact={stageArtifact}
                            proseGate={{
                                mattr500: latestMetrics.mattr500,
                                kontoyiannisEntropy: latestMetrics.kontoyiannisEntropy,
                                sentenceLengthCv: latestMetrics.sentenceLengthCv,
                                clicheDensityPer1k: latestMetrics.clicheDensityPer1k,
                                recentViolations: gateViolations
                            }}
                            factChecker={factChecker}
                            dreaming={{
                                dirtyEntityCount: null,
                                dirtyThreshold: null,
                                coldArchiveCount: entitiesView?.coldArchiveCount ?? status?.coldArchiveCount ?? 0,
                                spotlightQueue: null
                            }}
                            haltDiagnostic={haltDiagnostic}
                            modelRouting={status?.modelRouting ?? null}
                            roleRouting={status?.roleRouting ?? null}
                            roleDefinitions={status?.roleDefinitions ?? null}
                            availableModels={status?.availableModels ?? null}
                            entities={inspectorEntities}
                            openThreads={inspectorOpenThreads}
                            volumeProgress={inspectorVolumeProgress}
                            busy={isBusy}
                            onSaveModelRouting={handleSaveModelRouting}
                            onSelectEntity={() => {
                                handleOpenView('entities');
                                if (isNarrow) setRightOpen(false);
                            }}
                            onSelectChapter={(ch) => {
                                handleSelectChapter(ch);
                                if (isNarrow) setRightOpen(false);
                            }}
                            onTriggerDreaming={() => {
                                void handleDream().catch((err) => {
                                    showToast(err instanceof Error ? err.message : String(err), 'error');
                                });
                            }}
                            onInspectHalt={() => {
                                const epoch = workspaceEpochRef.current;
                                void fetchViewHalt().then((nextHalt) => {
                                    if (!isCurrentWorkspace(epoch)) return;
                                    setHaltView(nextHalt);
                                    const diag = mapHaltDiagnostic(nextHalt);
                                    if (diag) {
                                        showToast(`${diag.kind}: ${diag.reason}`, 'error');
                                    }
                                });
                            }}
                            onInspectStageSession={handleInspectStageSessionById}
                        />
                    ) : null}

                    {rightTab === 'session' ? (
                        <StageSessionViewer
                            selection={selectedStageSession}
                            sessionsService={sessionsService}
                            SessionProvider={SessionProvider}
                            renderStageConversation={renderStageConversation}
                            onClose={() => setRightTab('insp')}
                        />
                    ) : null}

                    {rightTab === 'tools' ? (
                        <div className="ns-tool-cards" aria-label="运维工具与模型池">
                            <button
                                type="button"
                                className="ns-tool-card"
                                disabled={isBusy}
                                onClick={() => {
                                    void handleSync()
                                        .then(() => showToast('已完成手改差异扫描与状态 Sync'))
                                        .catch((err) =>
                                            showToast(err instanceof Error ? err.message : String(err), 'error')
                                        );
                                }}
                            >
                                <span className="ns-tool-icon" aria-hidden="true">↻</span>
                                <span>
                                    <b>
                                        手动 Sync
                                        {dirtyChaptersCount > 0 ? ` (${dirtyChaptersCount} 处待同步)` : ''}
                                    </b>
                                    <small>扫描 SHA-256 与 Git Diff，增量刷新物化视图</small>
                                </span>
                            </button>

                            <button
                                type="button"
                                className="ns-tool-card"
                                disabled={isBusy}
                                onClick={() => {
                                    void handleDream()
                                        .then(() => showToast('已完成睡眠 VACUUM 与连续性整理'))
                                        .catch((err) =>
                                            showToast(err instanceof Error ? err.message : String(err), 'error')
                                        );
                                }}
                            >
                                <span className="ns-tool-icon" aria-hidden="true">☾</span>
                                <span>
                                    <b>手动 Dreaming</b>
                                    <small>触发离线 VACUUM 与跨章自愈整理</small>
                                </span>
                            </button>

                            <button
                                type="button"
                                className="ns-tool-card ns-tool-card-danger"
                                onClick={() => {
                                    void handleRequestHalt();
                                }}
                            >
                                <span className="ns-tool-icon" aria-hidden="true">■</span>
                                <span>
                                    <b>安全停机 (Safe-Point Halt)</b>
                                    <small>请求在当前原子事务检查点安全挂起</small>
                                </span>
                            </button>

                            <section className="ns-pool-card" aria-label="当前三池模型路由">
                                <div className="ns-pool-card-title">当前三池模型路由</div>
                                <div className="ns-pool-item">
                                    <div>
                                        <b>强创作池</b>
                                        <small>Planner · Writer</small>
                                    </div>
                                    <span className="ns-mono">{modelPools.strongModel}</span>
                                </div>
                                <div className="ns-pool-item">
                                    <div>
                                        <b>检索快池</b>
                                        <small>Librarian · Extractor</small>
                                    </div>
                                    <span className="ns-mono">{modelPools.fastModel}</span>
                                </div>
                                <div className="ns-pool-item">
                                    <div>
                                        <b>异构核查池</b>
                                        <small>Fact Checker</small>
                                    </div>
                                    <span className="ns-mono">{modelPools.auditModel}</span>
                                </div>
                            </section>
                        </div>
                    ) : null}
                </div>
            </aside>

            <BootBookModal
                open={bootModalOpen}
                onClose={() => setBootModalOpen(false)}
                onSubmitBoot={(payload) => bootBook(payload)}
                onBootSuccess={(data) => {
                    workspaceEpochRef.current += 1;
                    chapterRequestSeqRef.current += 1;
                    currentBookRootRef.current = data.bookRoot;
                    setChapterDetail(null);
                    showToast(`新书编译完成：${data.bookRoot}`);
                    void refreshAll(null);
                }}
            />

            {/* 未保存草稿导航确认（目录/上下章/检查器跳章/切作品/开新书共用） */}
            <DraftGuardModal
                open={pendingNavigation !== null}
                intent={pendingNavigation}
                draftChapter={draftLocation?.chapterNumber ?? null}
                bookTitle={status?.title ?? activeBookSummary?.title}
                saving={guardSaving}
                error={guardError}
                onSave={() => {
                    void handleGuardSaveAndContinue();
                }}
                onDiscard={handleGuardDiscardAndContinue}
                onCancel={() => {
                    if (saveInFlightRef.current) return;
                    setPendingNavigation(null);
                    setGuardError(null);
                }}
            />

            {/* 宿主 Toast 原语:body portal,自动跟随宿主主题与层级 */}
            {toasts.map((item) => (
                <Toast
                    key={item.id}
                    text={item.message}
                    holdMs={item.kind === 'error' ? 6000 : 3000}
                    onDone={() => setToasts((prev) => prev.filter((t) => t.id !== item.id))}
                />
            ))}
        </div>
    );
}

/** 侧栏导航图标组件 */
function NarrateStudioSidebarIcon(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <path d="M8 7h8" />
            <path d="M8 11h6" />
        </svg>
    );
}

export const STAGE_CONVERSATION_SLOT = 'narrateos.stage.conversation';

/** 保持引用稳定的本地视图模式 Context，避免切换 Conversation/Trajectory 时重建 Factory 槽位 */
const StageViewModeContext = createContext<string>('chat');

function StageConversationView(props: {
    renderSlot: (name: string, owner: { view?: string }) => React.ReactNode;
}): React.ReactElement {
    const view = useContext(StageViewModeContext);
    return <>{props.renderSlot('conversation.session', { view })}</>;
}

function StageConversationUnavailable(props: {
    sessionId: string;
    view?: string | undefined;
}): React.ReactElement {
    return (
        <div className="ns-session-fallback" data-stage-conversation-fallback="true">
            <div className="ns-session-fallback-title">原生 Conversation 渲染器暂不可用</div>
            <p>
                当前宿主尚未挂载 <code>conversation.content</code> Factory 或 <code>useConversation</code> Hook，
                无法渲染原生 {props.view === 'trajectory' ? 'Trajectory' : 'Conversation'} 视图。
            </p>
            <dl className="ns-session-kv ns-mono">
                <dt>sessionId</dt>
                <dd>{props.sessionId}</dd>
            </dl>
        </div>
    );
}

type StageSessionHook = <T>(selector: (snapshot: {
    blank?: boolean;
    awaitingFirstTurn?: boolean;
    running?: boolean;
    promptAttempted?: boolean;
    openState?: string;
    subagent?: { address: { mode: string }; parentAvailable?: boolean } | null;
}) => T) => T;

type StageConversationHook = <T>(
    selector: (snapshot: { activeTargets?: { size?: number } }) => T
) => T;

type StageSessionsHook = <T>(
    selector: (state: { byId?: Record<string, { blank?: boolean }> }) => T
) => T;

type StageRenderFactorySlot = (
    name: string,
    props: { variant: 'embedded'; phase: 'settling' | 'hero' | 'active'; hero: boolean },
    overrides: {
        slots: { views: typeof StageConversationView };
        fallback?: React.ReactNode;
    }
) => React.ReactNode;

export interface StageConversationSlotPanelProps {
    sessionId: string;
    view?: string | undefined;
    useSession?: StageSessionHook | undefined;
    useConversation?: StageConversationHook | undefined;
    useSessions?: StageSessionsHook | undefined;
    renderFactorySlot?: StageRenderFactorySlot | undefined;
}

function StageConversationSlotBody({
    sessionId,
    view = 'chat',
    useSession,
    useConversation,
    useSessions,
    renderFactorySlot
}: {
    sessionId: string;
    view: string;
    useSession: StageSessionHook;
    useConversation: StageConversationHook;
    useSessions: StageSessionsHook;
    renderFactorySlot: StageRenderFactorySlot;
}): React.ReactElement {
    const session = useSession((value) => value);
    const conversation = useConversation((value) => value);
    const summaryBlank = useSessions((state) => state?.byId?.[sessionId]?.blank);
    const activeTargetsSize = conversation?.activeTargets?.size ?? 0;
    const shellPhase =
        activeTargetsSize > 0 ||
        (!session?.blank && !session?.awaitingFirstTurn) ||
        session?.running
            ? 'active'
            : session?.promptAttempted
              ? 'engaging'
              : 'blank';
    const parentAvailabilityPending =
        session?.subagent?.address?.mode === 'continuable' &&
        session.subagent.parentAvailable === undefined;
    const settling =
        (shellPhase === 'blank' && session?.openState === 'loading' && summaryBlank !== true) ||
        parentAvailabilityPending;
    const hero =
        shellPhase === 'blank' && (session?.openState === 'open' || summaryBlank === true);

    return (
        <StageViewModeContext.Provider value={view}>
            {renderFactorySlot(
                'conversation.content',
                {
                    variant: 'embedded',
                    phase: settling ? 'settling' : hero ? 'hero' : 'active',
                    hero
                },
                {
                    slots: { views: StageConversationView },
                    fallback: <StageConversationUnavailable sessionId={sessionId} view={view} />
                }
            )}
        </StageViewModeContext.Provider>
    );
}

/**
 * 在 SessionProvider 作用域内挂载 DSH 原生 'conversation.content' 工厂，
 * 并在缺少 useConversation 或未加载 Factory 时安全降级，避免抛出 TypeError。
 */
export function StageConversationSlotPanel({
    sessionId,
    view = 'chat',
    useSession,
    useConversation,
    useSessions,
    renderFactorySlot
}: StageConversationSlotPanelProps): React.ReactElement {
    if (
        typeof useSession !== 'function' ||
        typeof useConversation !== 'function' ||
        typeof useSessions !== 'function' ||
        typeof renderFactorySlot !== 'function'
    ) {
        return <StageConversationUnavailable sessionId={sessionId} view={view} />;
    }

    return (
        <StageConversationSlotBody
            sessionId={sessionId}
            view={view}
            useSession={useSession}
            useConversation={useConversation}
            useSessions={useSessions}
            renderFactorySlot={renderFactorySlot}
        />
    );
}

function readContextService(ctx: unknown, serviceName: string): unknown {
    if (!ctx || typeof ctx !== 'object') return undefined;
    const record = ctx as Record<string, unknown>;
    const getter = record['get'];
    // Cordis Context 为严格代理：直接访问未注入的属性会抛错，须优先走 ctx.get() 并全程 try/catch
    if (typeof getter === 'function') {
        try {
            return (getter as (name: string) => unknown).call(ctx, serviceName);
        } catch {
            return undefined;
        }
    }
    try {
        return record[serviceName];
    } catch {
        return undefined;
    }
}

function readSessionsService(ctx: unknown): StudioSessionsService | undefined {
    const candidate = readContextService(ctx, 'sessions');
    if (
        candidate &&
        typeof candidate === 'object' &&
        typeof (candidate as StudioSessionsService).retain === 'function'
    ) {
        return candidate as StudioSessionsService;
    }
    return undefined;
}

function hasSessionUiServices(targetCtx: unknown, fallbackCtx?: unknown): boolean {
    const uiSession =
        readContextService(targetCtx, 'uiSession') ?? readContextService(fallbackCtx, 'uiSession');
    const uiConversation =
        readContextService(targetCtx, 'uiConversation') ??
        readContextService(fallbackCtx, 'uiConversation');
    return Boolean(uiSession && uiConversation);
}

interface NarrateStudioSlotProps {
    SessionProvider?: StudioSessionProviderComponent | undefined;
    renderSlot?: ((slotName: string, owner: Record<string, unknown>) => React.ReactNode) | undefined;
}

/**
 * Cordis 客户端插件入口：向 @deepseek-ai/dsh@0.2.2-rc.1 双半侧槽位注册主舞台与侧栏导航。
 * 仅当 uiSession 与 uiConversation 同时可用时才声明 scope: 'session' 子槽位，避免极简宿主抛出 SlotAssemblyError。
 */
export function apply(ctx: Context): void {
    const slots = ctx.slots as
        | {
              inject?: (slotName: string, factory: unknown) => unknown;
              register?: (meta: Record<string, unknown>, component: React.FC<Record<string, unknown>>) => unknown;
          }
        | undefined;
    if (!slots || typeof slots.inject !== 'function') {
        return;
    }

    // 安全获取可选 sessions 服务，不将其放入静态 inject 以避免阻塞极简宿主或单元测试
    let currentSessionsService = readSessionsService(ctx);
    const sessionSubscribers = new Set<() => void>();
    const notifySessionSubscribers = (): void => {
        for (const listener of sessionSubscribers) {
            listener();
        }
    };

    const dynamicInject = (
        ctx as unknown as {
            inject?: (deps: string[], callback: (scope: Context) => void | (() => void)) => unknown;
        }
    ).inject;
    const disposeDynamicResult = (handle: unknown): void => {
        if (typeof handle === 'function') {
            (handle as () => void)();
            return;
        }
        if (
            handle &&
            typeof handle === 'object' &&
            typeof (handle as { dispose?: unknown }).dispose === 'function'
        ) {
            void (handle as { dispose: () => unknown }).dispose();
        }
    };
    const registerScopeEffect = (
        scope: Context,
        setup: () => void | (() => void),
        label: string
    ): void => {
        const scopeEffect = (
            scope as unknown as {
                effect?: (callback: () => void | (() => void), name?: string) => unknown;
            }
        ).effect;
        if (typeof scopeEffect === 'function') {
            scopeEffect.call(scope, setup, label);
        } else {
            setup();
        }
    };

    if (typeof dynamicInject === 'function') {
        try {
            dynamicInject.call(ctx, ['sessions'], (scope: Context) => {
                registerScopeEffect(
                    scope,
                    () => {
                        currentSessionsService =
                            readSessionsService(scope) ?? readSessionsService(ctx);
                        notifySessionSubscribers();
                        return () => {
                            currentSessionsService = readSessionsService(ctx);
                            notifySessionSubscribers();
                        };
                    },
                    'narrateos-studio:optional-sessions'
                );
            });
        } catch {
            // 宿主未提供可选 sessions 服务时保持静默降级
        }
    }

    const NarrateStudioPanel: React.FC<NarrateStudioSlotProps> = ({
        SessionProvider,
        renderSlot
    }) => {
        const [sessionsService, setSessionsService] = useState<StudioSessionsService | undefined>(
            () => currentSessionsService ?? readSessionsService(ctx)
        );

        useEffect(() => {
            const sync = () => {
                setSessionsService(currentSessionsService ?? readSessionsService(ctx));
            };
            sync();
            sessionSubscribers.add(sync);
            return () => {
                sessionSubscribers.delete(sync);
            };
        }, []);

        const renderStageConversation = useMemo<StudioRenderStageConversation | undefined>(() => {
            if (typeof renderSlot !== 'function') return undefined;
            return (owner) => renderSlot(STAGE_CONVERSATION_SLOT, owner);
        }, [renderSlot]);

        return (
            <NarrateStudioRoot
                sessionsService={sessionsService}
                SessionProvider={SessionProvider}
                renderStageConversation={renderStageConversation}
            />
        );
    };

    const injectSlot = slots.inject.bind(slots);
    const registerSlot = typeof slots.register === 'function' ? slots.register.bind(slots) : null;

    const registerMainSlots = (withSessionUi: boolean): (() => void) => {
        const disposers: Array<() => void> = [];

        const disposeMain = injectSlot(
            'main',
            registerSlot
                ? () =>
                      registerSlot(
                          {
                              name: 'main',
                              key: PANEL_ID,
                              ...(withSessionUi
                                  ? {
                                        children: {
                                            [STAGE_CONVERSATION_SLOT]: {
                                                kind: 'single',
                                                scope: 'session'
                                            }
                                        }
                                    }
                                  : {}),
                              inject: () => ({ title: 'NarrateOS 创作室' })
                          },
                          NarrateStudioPanel as React.FC<Record<string, unknown>>
                      )
                : {
                      key: PANEL_ID,
                      title: 'NarrateOS 创作室',
                      render: () => <NarrateStudioPanel />
                  }
        );
        if (typeof disposeMain === 'function') {
            disposers.push(disposeMain as () => void);
        }

        if (withSessionUi && registerSlot) {
            const disposeStageConversation = injectSlot(STAGE_CONVERSATION_SLOT, () =>
                registerSlot(
                    { name: STAGE_CONVERSATION_SLOT },
                    StageConversationSlotPanel as unknown as React.FC<Record<string, unknown>>
                )
            );
            if (typeof disposeStageConversation === 'function') {
                disposers.push(disposeStageConversation as () => void);
            }
        }

        return () => {
            for (const dispose of disposers.reverse()) {
                try {
                    dispose();
                } catch {
                    // 忽略重复卸载或宿主已清理时的异常
                }
            }
        };
    };

    const registerSlots = (): (() => void) => {
        const disposers: Array<() => void> = [];
        let disposedAll = false;
        let activeMainDisposer: (() => void) | null = null;
        let currentSessionUi = false;

        const syncMainRegistration = (withSessionUi: boolean): void => {
            if (disposedAll) return;
            if (activeMainDisposer && currentSessionUi === withSessionUi) {
                return;
            }
            if (activeMainDisposer) {
                activeMainDisposer();
                activeMainDisposer = null;
            }
            currentSessionUi = withSessionUi;
            activeMainDisposer = registerMainSlots(withSessionUi);
        };

        const disposeSidebar = injectSlot(
            'sidebar.panellist',
            registerSlot
                ? () =>
                      registerSlot(
                          {
                              name: 'sidebar.panellist',
                              id: PANEL_ID,
                              order: 15,
                              label: () => '创作室'
                          },
                          NarrateStudioSidebarIcon as React.FC<Record<string, unknown>>
                      )
                : {
                      id: PANEL_ID,
                      order: 15,
                      label: () => '创作室',
                      icon: () => <NarrateStudioSidebarIcon />
                  }
        );
        if (typeof disposeSidebar === 'function') {
            disposers.push(disposeSidebar as () => void);
        }

        if (typeof dynamicInject === 'function') {
            try {
                const sessionUiInjectHandle = dynamicInject.call(
                    ctx,
                    ['uiSession', 'uiConversation'],
                    (sessionUiCtx: Context) => {
                        registerScopeEffect(
                            sessionUiCtx,
                            () => {
                                if (!hasSessionUiServices(sessionUiCtx, ctx)) {
                                    return;
                                }
                                syncMainRegistration(true);
                                return () => {
                                    if (!disposedAll) {
                                        syncMainRegistration(false);
                                    }
                                };
                            },
                            'narrateos-studio:optional-session-ui'
                        );
                    }
                );
                if (sessionUiInjectHandle) {
                    disposers.push(() => {
                        disposeDynamicResult(sessionUiInjectHandle);
                    });
                }
            } catch {
                // 宿主不支持多服务动态注入时安全回退为基础槽位
            }
        }

        if (!activeMainDisposer) {
            syncMainRegistration(hasSessionUiServices(ctx));
        }

        return () => {
            disposedAll = true;
            if (activeMainDisposer) {
                activeMainDisposer();
                activeMainDisposer = null;
            }
            for (const dispose of disposers) {
                try {
                    dispose();
                } catch {
                    // 忽略重复卸载或宿主已清理时的异常
                }
            }
        };
    };

    const effect = (
        ctx as unknown as {
            effect?: (callback: () => void | (() => void), label?: string) => unknown;
        }
    ).effect;

    if (typeof effect === 'function') {
        effect.call(ctx, registerSlots, 'narrateos-studio-slots');
    } else {
        registerSlots();
    }
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import {
    bootBook,
    fetchBooks,
    fetchChapter,
    fetchChapters,
    fetchStatus,
    fetchViewEntities,
    fetchViewHalt,
    fetchViewHorizon,
    fetchViewSignals,
    fetchViewTelemetry,
    fetchViewThreads,
    postSignal,
    runDreaming,
    saveChapter,
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
    type CenterWorkbenchProps,
    type DirectorSignalKind,
    type ExternalViewCommand,
    type PendingSignalItem,
    type PipelineStageId,
    type SafeHaltInfo,
    type StageNodeState,
    type SubmitSignalPayload
} from './CenterWorkbench';
import { LeftBookNav, type MaterializedViewKind } from './LeftBookNav';
import {
    RightOpsInspector,
    type FactCheckerTelemetry,
    type HaltDiagnosticInfo,
    type ProseGateViolationItem,
    type StageArtifactTelemetry
} from './RightOpsInspector';
import { ensureStudioStyles } from './styles';
import type {
    BooksListPayload,
    ChapterDetail,
    ChapterSummary,
    EntitiesViewPayload,
    HaltViewPayload,
    MarkdownViewPayload,
    NarrateStatusPayload,
    SignalsViewPayload,
    SseEventPayload,
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
    { id: 'PROSE_GATE', label: 'Static Gate' },
    { id: 'FACT_CHECKER', label: 'Fact Checker' },
    { id: 'EXTRACTOR', label: 'Extractor & WAL' }
];

const DEFAULT_STAGE_SUMMARIES: Record<PipelineStageId, string> = {
    LIBRARIAN: '检索本场焦点实体卡与声纹样本',
    PLANNER: '生成结构化章节细纲与节拍',
    WRITER: '净室单轮流式直出正文草稿',
    PROSE_GATE: '确定性文风门禁扫描与局部 Patch',
    FACT_CHECKER: '异构模型核查与双侧原句验真',
    EXTRACTOR: '提取实体增量并原子提交 Git WAL'
};

function isPipelineStageId(value: string): value is PipelineStageId {
    return PIPELINE_STAGE_META.some((item) => item.id === value);
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
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
    return signalsView.signals.map((item) => ({
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
    } else if (kind === '导演指令') {
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
            selectedStageIndex: 5,
            stageName: 'Extractor & WAL',
            stageStatus: '已提交',
            stageSummary: '本章正文与状态补丁已双提交至 Git WAL'
        };
    }
    const idx = PIPELINE_STAGE_META.findIndex((item) => item.id === latestSseStage);
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

/**
 * NarrateOS Operator Studio 前端根组件：
 * - 幂等注入样式表
 * - 初始化拉取作品列表、全局状态、章节列表、当前章详情与 6 类物化视图
 * - 订阅 /api/narrate/events SSE 实时流并驱动三栏联动刷新
 */
export function NarrateStudioRoot(): React.ReactElement {
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
    const [stageOverrides, setStageOverrides] = useState<Partial<Record<PipelineStageId, StageNodeState>>>({});
    const [liveTelemetry, setLiveTelemetry] = useState<TelemetryItem | null>(null);
    const [gateViolations, setGateViolations] = useState<ProseGateViolationItem[]>([]);
    const [factChecker, setFactChecker] = useState<FactCheckerTelemetry>({
        totalChecked: 0,
        verifiedPassCount: 0,
        filteredOutCount: 0,
        blockedCount: 0
    });
    const [lastConsumedSignal, setLastConsumedSignal] = useState<string | undefined>(undefined);

    const [loading, setLoading] = useState<boolean>(true);
    const [bootModalOpen, setBootModalOpen] = useState<boolean>(false);
    const [activeViewKind, setActiveViewKind] = useState<MaterializedViewKind | null>(null);
    const [externalViewCommand, setExternalViewCommand] = useState<ExternalViewCommand | undefined>(undefined);
    const [toast, setToast] = useState<ToastState | null>(null);

    const viewCommandNonceRef = useRef<number>(0);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const selectedChapterRef = useRef<number | null>(null);
    selectedChapterRef.current = selectedChapter;

    const showToast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
        if (toastTimerRef.current) {
            clearTimeout(toastTimerRef.current);
        }
        const nextToast: ToastState = { id: Date.now(), message, kind };
        setToast(nextToast);
        toastTimerRef.current = setTimeout(() => {
            setToast((curr) => (curr && curr.id === nextToast.id ? null : curr));
        }, 3600);
    }, []);

    useEffect(() => {
        ensureStudioStyles();
        return () => {
            if (toastTimerRef.current) {
                clearTimeout(toastTimerRef.current);
            }
        };
    }, []);

    const loadViews = useCallback(async () => {
        const [entities, horizon, threads, telemetry, signals, halt] = await Promise.all([
            fetchViewEntities().catch(() => null),
            fetchViewHorizon().catch(() => null),
            fetchViewThreads().catch(() => null),
            fetchViewTelemetry().catch(() => null),
            fetchViewSignals().catch(() => null),
            fetchViewHalt().catch(() => null)
        ]);
        if (entities) setEntitiesView(entities);
        if (horizon) setHorizonView(horizon);
        if (threads) setThreadsView(threads);
        if (telemetry) setTelemetryView(telemetry);
        if (signals) setSignalsView(signals);
        if (halt) setHaltView(halt);
    }, []);

    const loadChapterByNumber = useCallback(async (chapterNumber: number) => {
        if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) {
            setChapterDetail(null);
            return;
        }
        try {
            const detail = await fetchChapter(chapterNumber);
            setChapterDetail(detail);
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        }
    }, [showToast]);

    const refreshAll = useCallback(async (preferredChapter?: number | null) => {
        setLoading(true);
        try {
            const [booksRes, statusRes, chaptersRes] = await Promise.all([
                fetchBooks(),
                fetchStatus(),
                fetchChapters(),
                loadViews()
            ]);

            setBooksState(booksRes);
            setStatus(statusRes);
            setChapters(chaptersRes.chapters);
            setLatestSseStage(statusRes.yolo.currentStage ?? null);

            const fallbackChapter =
                chaptersRes.chapters.length > 0
                    ? chaptersRes.chapters[chaptersRes.chapters.length - 1]!.chapterNumber
                    : null;
            const candidate =
                preferredChapter ??
                statusRes.activeChapter ??
                (statusRes.latestChapter > 0 ? statusRes.latestChapter : fallbackChapter);

            if (candidate !== null && candidate > 0) {
                setSelectedChapter(candidate);
                const detail = await fetchChapter(candidate).catch(() => null);
                setChapterDetail(detail);
            } else {
                setSelectedChapter(null);
                setChapterDetail(null);
            }
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            setLoading(false);
        }
    }, [loadViews, showToast]);

    useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    const refreshAllRef = useRef(refreshAll);
    refreshAllRef.current = refreshAll;
    const loadViewsRef = useRef(loadViews);
    loadViewsRef.current = loadViews;
    const loadChapterRef = useRef(loadChapterByNumber);
    loadChapterRef.current = loadChapterByNumber;

    // 订阅 SSE 实时事件流
    useEffect(() => {
        const handleSseEvent = (payload: SseEventPayload) => {
            const { event, data } = payload;

            if (event === 'book_switched') {
                setStageOverrides({});
                setLiveTelemetry(null);
                setGateViolations([]);
                showToast('已切换当前作品仓库');
                void refreshAllRef.current(null);
                return;
            }

            if (event === 'stage' || event === 'chapter:phase') {
                const stageName = asString(data['stage']) ?? asString(data['phase']);
                if (!stageName) return;

                if (stageName === 'STARTING') {
                    setStageOverrides({});
                    setLatestSseStage('LIBRARIAN');
                    setStatus((prev) =>
                        prev
                            ? {
                                  ...prev,
                                  runtime: { ...prev.runtime, activeTask: 'STEPPING' }
                              }
                            : prev
                    );
                    return;
                }

                if (stageName === 'FAILED') {
                    const errText = asString(data['error']) ?? '章节推进失败';
                    showToast(errText, 'error');
                    void fetchStatus().then(setStatus).catch(() => undefined);
                    return;
                }

                setLatestSseStage(stageName);
                const message = asString(data['message']);
                const timestamp = asString(data['timestamp']);
                if (isPipelineStageId(stageName) && message) {
                    setStageOverrides((prev) => ({
                        ...prev,
                        [stageName]: {
                            status: 'active',
                            summary: message,
                            updatedAt: timestamp
                        }
                    }));
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
                    showToast(
                        committedCh
                            ? `Ch.${String(committedCh).padStart(4, '0')} 已提交至 Git WAL`
                            : '章节已提交至 Git WAL'
                    );
                    void refreshAllRef.current(committedCh ?? selectedChapterRef.current);
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
                const reason = asString(data['reason']) ?? asString(data['content']);
                if (reason) setLastConsumedSignal(reason);
                void fetchViewSignals().then(setSignalsView).catch(() => undefined);
                void fetchStatus().then(setStatus).catch(() => undefined);
                showToast('导演信号已入队');
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
                void fetchStatus().then(setStatus).catch(() => undefined);
                void fetchChapters().then((res) => setChapters(res.chapters)).catch(() => undefined);
                if (ch && ch === selectedChapterRef.current) {
                    void loadChapterRef.current(ch);
                } else if (selectedChapterRef.current) {
                    void loadChapterRef.current(selectedChapterRef.current);
                }
                return;
            }

            if (event === 'dream:started') {
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, activeTask: 'DREAMING' } } : prev
                );
                return;
            }

            if (event === 'dream:completed') {
                showToast('Dreaming 睡眠 VACUUM 与连续性整理完成');
                void fetchStatus().then(setStatus).catch(() => undefined);
                void loadViewsRef.current();
                return;
            }

            if (event === 'halt:requested') {
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, haltRequested: true } } : prev
                );
                showToast('已请求在安全检查点停机');
                return;
            }

            if (event === 'halt:completed') {
                void fetchStatus().then(setStatus).catch(() => undefined);
                void fetchViewHalt().then(setHaltView).catch(() => undefined);
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
    }, [showToast]);

    // 交互操作回调
    const handleSelectBook = useCallback(
        async (bookRoot: string) => {
            try {
                await selectBook({ bookRoot });
                showToast('正在切换作品目录…');
                await refreshAll(null);
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        },
        [refreshAll, showToast]
    );

    const handleSelectChapter = useCallback(
        (chapterNumber: number) => {
            setSelectedChapter(chapterNumber);
            void loadChapterByNumber(chapterNumber);
        },
        [loadChapterByNumber]
    );

    const handleOpenView = useCallback(
        (kind: MaterializedViewKind) => {
            setActiveViewKind(kind);
            viewCommandNonceRef.current += 1;
            setExternalViewCommand({
                viewTab: 'views',
                materialKind: kind,
                nonce: viewCommandNonceRef.current
            });
            if (kind === 'entities') {
                void fetchViewEntities().then(setEntitiesView).catch(() => undefined);
            } else if (kind === 'horizon') {
                void fetchViewHorizon().then(setHorizonView).catch(() => undefined);
            } else if (kind === 'threads') {
                void fetchViewThreads().then(setThreadsView).catch(() => undefined);
            }
        },
        []
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
            const nextStatus = await fetchStatus();
            setStatus(nextStatus);
        },
        []
    );

    const handleStopYolo = useCallback(async () => {
        await stopYolo();
        const nextStatus = await fetchStatus();
        setStatus(nextStatus);
    }, []);

    const handleSync = useCallback(async () => {
        await syncManuscripts();
        await refreshAll(selectedChapterRef.current);
    }, [refreshAll]);

    const handleDream = useCallback(async () => {
        await runDreaming({ force: true });
        await Promise.all([fetchStatus().then(setStatus), loadViews()]);
    }, [loadViews]);

    const handleSaveChapter = useCallback(
        async (chapterNumber: number, content: string) => {
            await saveChapter({ chapterNumber, content });
            await Promise.all([
                fetchStatus().then(setStatus),
                fetchChapters().then((res) => setChapters(res.chapters)),
                loadChapterByNumber(chapterNumber)
            ]);
        },
        [loadChapterByNumber]
    );

    const handleSubmitSignal = useCallback(
        async (payload: SubmitSignalPayload) => {
            const currentCh = status?.worldState.current_chapter ?? status?.latestChapter ?? 0;
            const req = buildSignalPayload(payload.kind, payload.content, currentCh);
            await postSignal(req);
            await Promise.all([
                fetchViewSignals().then(setSignalsView),
                fetchStatus().then(setStatus)
            ]);
            if (payload.runAfter) {
                await handleStepOne();
            }
        },
        [handleStepOne, status]
    );

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

    const aggregateTokens = useMemo(() => {
        const entries = telemetryView?.entries ?? [];
        let inputTokens = 0;
        let cacheReadTokens = 0;
        let outputTokens = 0;
        for (const item of entries) {
            inputTokens += item.inputTokens ?? 0;
            cacheReadTokens += item.cacheReadTokens ?? 0;
            outputTokens += item.outputTokens ?? 0;
        }
        return {
            inputTokens: inputTokens || (latestTelemetryEntry?.inputTokens ?? 0),
            cacheReadTokens: cacheReadTokens || (latestTelemetryEntry?.cacheReadTokens ?? 0),
            outputTokens: outputTokens || (latestTelemetryEntry?.outputTokens ?? 0),
            cacheHitRate: latestTelemetryEntry?.cacheHitRate
        };
    }, [latestTelemetryEntry, telemetryView]);

    const dirtyChaptersCount = useMemo(
        () => chapters.filter((item) => item.dirty).length,
        [chapters]
    );

    const safeHaltInfo = useMemo(() => mapSafeHaltInfo(haltView?.safeHalt), [haltView]);
    const haltDiagnostic = useMemo(() => mapHaltDiagnostic(haltView), [haltView]);
    const pendingSignals = useMemo(() => mapPendingSignals(signalsView), [signalsView]);
    const stageArtifact = useMemo(() => deriveStageArtifact(latestSseStage), [latestSseStage]);

    const activeTask = status?.runtime.activeTask ?? 'IDLE';
    const isBusy = activeTask !== 'IDLE' || Boolean(status?.yolo.running);

    const centerChapterDetail: CenterWorkbenchProps['chapterDetail'] = useMemo(() => {
        if (!chapterDetail) return null;
        const summary = chapters.find((c) => c.chapterNumber === chapterDetail.chapterNumber);
        return {
            chapterNumber: chapterDetail.chapterNumber,
            title: summary?.title,
            content: chapterDetail.content,
            dirty: chapterDetail.dirty,
            sha256: chapterDetail.sha256,
            diffFromHead: chapterDetail.diffFromHead
        };
    }, [chapterDetail, chapters]);

    return (
        <div className="ns-studio-shell">
            <LeftBookNav
                currentBookRoot={status?.bookRoot ?? booksState.currentBookRoot}
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
                activeViewKind={activeViewKind}
                loading={loading}
                onSelectBook={(root) => {
                    void handleSelectBook(root);
                }}
                onNewBook={() => setBootModalOpen(true)}
                onSelectChapter={handleSelectChapter}
                onOpenView={handleOpenView}
            />

            <CenterWorkbench
                bookTitle={status?.title}
                bookSlug={status?.bookSlug}
                currentChapter={status?.worldState.current_chapter ?? status?.latestChapter ?? 0}
                selectedChapter={selectedChapter ?? undefined}
                timelineMode={String(status?.worldState.timeline_mode ?? 'MAINLINE')}
                walPhase={status?.walPhase ?? 'IDLE'}
                activeTask={activeTask}
                yolo={status?.yolo}
                chapters={chapters}
                chapterDetail={centerChapterDetail}
                stages={stageOverrides}
                latestSseStage={latestSseStage}
                safeHalt={safeHaltInfo}
                pendingSignals={pendingSignals}
                pendingSignalsCount={signalsView?.pendingCount ?? status?.pendingSignalsCount ?? 0}
                materializedViews={{
                    entities: entitiesView?.entities,
                    coldArchiveCount: entitiesView?.coldArchiveCount,
                    horizonMarkdown: horizonView?.content,
                    threadsMarkdown: threadsView?.content
                }}
                dirtyChaptersCount={dirtyChaptersCount}
                lastConsumedSignal={lastConsumedSignal}
                externalViewCommand={externalViewCommand}
                onSelectChapter={handleSelectChapter}
                onStepOne={handleStepOne}
                onStartYolo={handleStartYolo}
                onStopYolo={handleStopYolo}
                onSync={handleSync}
                onDream={handleDream}
                onSaveChapter={handleSaveChapter}
                onSubmitSignal={handleSubmitSignal}
                onRefreshViews={loadViews}
            />

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
                    fastModel: 'fast',
                    strongModel: 'strong',
                    auditModel: 'audit',
                    inputTokens: aggregateTokens.inputTokens,
                    cacheReadTokens: aggregateTokens.cacheReadTokens,
                    outputTokens: aggregateTokens.outputTokens,
                    ...(aggregateTokens.cacheHitRate !== undefined
                        ? { cacheHitRate: aggregateTokens.cacheHitRate }
                        : {})
                }}
                stageArtifact={stageArtifact}
                proseGate={{
                    mattr500: latestTelemetryEntry?.mattr500 ?? null,
                    kontoyiannisEntropy: latestTelemetryEntry?.kontoyiannisHk ?? null,
                    sentenceLengthCv: latestTelemetryEntry?.sentenceLengthCv ?? null,
                    clicheDensityPer1k: latestTelemetryEntry?.clicheDensityPer1k ?? null,
                    recentViolations: gateViolations
                }}
                factChecker={factChecker}
                dreaming={{
                    dirtyEntityCount: 0,
                    dirtyThreshold: 5,
                    coldArchiveCount: entitiesView?.coldArchiveCount ?? status?.coldArchiveCount ?? 0,
                    spotlightQueue: []
                }}
                haltDiagnostic={haltDiagnostic}
                busy={isBusy}
                onTriggerDreaming={() => {
                    void handleDream().catch((err) => {
                        showToast(err instanceof Error ? err.message : String(err), 'error');
                    });
                }}
                onInspectHalt={() => {
                    void fetchViewHalt().then((nextHalt) => {
                        setHaltView(nextHalt);
                        const diag = mapHaltDiagnostic(nextHalt);
                        if (diag) {
                            showToast(`${diag.kind}: ${diag.reason}`, 'error');
                        }
                    });
                }}
            />

            <BootBookModal
                open={bootModalOpen}
                onClose={() => setBootModalOpen(false)}
                onSubmitBoot={(payload) => bootBook(payload)}
                onBootSuccess={(data) => {
                    showToast(`新书编译完成：${data.bookRoot}`);
                    void refreshAll(null);
                }}
            />

            {toast ? (
                <div
                    className="ns-toast"
                    role="status"
                    aria-live="polite"
                    style={
                        toast.kind === 'error'
                            ? { borderColor: 'var(--ns-red-line)', color: 'var(--ns-red-ink)' }
                            : undefined
                    }
                >
                    {toast.message}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Cordis 客户端插件入口：向 @deepseek-ai/dsh@0.2.2-rc.1 双半侧槽位注册主舞台与侧栏导航
 */
export function apply(ctx: Context): void {
    const slots = ctx.slots as
        | { inject?: (slotName: string, entry: Record<string, unknown>) => unknown }
        | undefined;
    if (!slots || typeof slots.inject !== 'function') {
        return;
    }

    const injectSlot = slots.inject.bind(slots);
    const registerSlots = (): (() => void) => {
        const disposers: Array<() => void> = [];

        const disposeMain = injectSlot('main', {
            key: PANEL_ID,
            title: 'NarrateOS 创作室',
            render: () => <NarrateStudioRoot />
        });
        if (typeof disposeMain === 'function') {
            disposers.push(disposeMain as () => void);
        }

        const disposeSidebar = injectSlot('sidebar.panellist', {
            id: PANEL_ID,
            order: 15,
            label: () => '创作室',
            icon: () => (
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
            ),
            onClick: () => {
                const layout = ctx.layout as Record<string, unknown> | undefined;
                if (!layout) return;
                if (typeof layout['openMain'] === 'function') {
                    (layout['openMain'] as (id: string) => void)(PANEL_ID);
                } else if (typeof layout['setActivePanel'] === 'function') {
                    (layout['setActivePanel'] as (id: string) => void)(PANEL_ID);
                } else if (typeof layout['activate'] === 'function') {
                    (layout['activate'] as (id: string) => void)(PANEL_ID);
                }
            }
        });
        if (typeof disposeSidebar === 'function') {
            disposers.push(disposeSidebar as () => void);
        }

        return () => {
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

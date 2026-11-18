import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { CodexView } from './CodexView';
import { ConflictVerdictCard, type SyncConflictDiagnostic } from './ConflictVerdictCard';
import { DirectorNoteDock, type NoteSignalKind } from './DirectorNoteDock';
import type { MaterializedViewKind } from './LeftBookNav';
import { collectPoolProviders, resolveEffectiveRoleModelLabel } from './RoleRoutingEditor';
import type { StageSessionSelection } from './StageSessionViewer';
import { handleTabKeyDown } from './tab-keyboard';
import type {
    RoleDefinitionItem,
    RoleModelOverride,
    RolePoolId,
    RuntimeTaskKind,
    StepChapterRequest
} from './types';
import type { StashedDraftEntry } from './draft-guard';
import {
    formatChapterLabel,
    getAvatarToneIndex,
    parseStructuredPlan,
    parseUnifiedDiff,
    prefersReducedMotion,
    runWithViewTransition,
    splitProseParagraphs,
    StudioIcons
} from './workbench-parsers';

export type { StageSessionSelection } from './StageSessionViewer';
export type { MaterializedViewKind } from './LeftBookNav';
export type { SyncConflictDiagnostic } from './ConflictVerdictCard';
export type { NoteSignalKind } from './DirectorNoteDock';

/** 6 节点流水线 ID：只画真正跑大模型的节点 + Dreaming（0-LLM 静态门禁不占节点） */
export type PipelineStageId =
    | 'LIBRARIAN'
    | 'PLANNER'
    | 'WRITER'
    | 'FACT_CHECKER'
    | 'EXTRACTOR'
    | 'DREAMING';

/** 单个流水线节点状态（dormant = Dreaming 条件未达的虚线弱态） */
export type StageNodeStatus = 'idle' | 'active' | 'done' | 'healing' | 'halt' | 'dormant';

/** 流水线节点单次工种尝试会话记录（同一节点可按序保留多次尝试，如 WRITER / LOCAL_PATCH / REWRITE） */
export interface StageAttemptSession {
    runId?: string | undefined;
    stage: string;
    role?: string | undefined;
    status: string;
    sessionId: string;
    parentSessionId?: string | undefined;
    attempt?: number | undefined;
    triggerReason?: string | undefined;
    mode?: string | undefined;
    updatedAt?: string | undefined;
}

/** 流水线节点运行态信息 */
export interface StageNodeState {
    status: StageNodeStatus;
    summary?: string | undefined;
    inputSummary?: string | undefined;
    outputSummary?: string | undefined;
    updatedAt?: string | undefined;
    badge?: string | undefined;
    sessionId?: string | undefined;
    parentSessionId?: string | undefined;
    mode?: string | undefined;
    runId?: string | undefined;
    sessions?: StageAttemptSession[] | undefined;
}

/** 主内容区视图页签 */
export type CenterViewTab = 'prose' | 'plan' | 'diff' | 'views';

/** 导演一次性信号类型 */
export type DirectorSignalKind =
    | NoteSignalKind
    | '下章剧情'
    | '导演指令'
    | 'PARALLEL'
    | 'Retcon'
    | '文风修订';

/** 章节列表摘要项 */
export interface ChapterSummaryItem {
    chapterNumber: number;
    fileName?: string | undefined;
    title: string;
    charCount?: number | undefined;
    dirty?: boolean | undefined;
    commitSha?: string | null | undefined;
}

/** 单章详情数据 */
export interface ChapterDetailData {
    chapterNumber: number;
    title?: string | undefined;
    content: string;
    dirty?: boolean | undefined;
    sha256?: string | undefined;
    diffFromHead?: string | undefined;
    outlineText?: string | null | undefined;
    outlineStatus?: 'available' | 'missing' | 'error' | undefined;
    volumeLabel?: string | undefined;
    featCommitSha?: string | undefined;
    stateCommitSha?: string | undefined;
}

/** SAFE_HALT 单条冲突/违规证据 */
export interface SafeHaltIssueItem {
    rule?: string | undefined;
    line?: number | undefined;
    quote?: string | undefined;
    snippet?: string | undefined;
    sourceRef?: string | undefined;
    sourceQuote?: string | undefined;
    detail?: string | undefined;
}

/** 门禁违规条目（用于裁决卡明细展示） */
export interface VerdictGateViolationItem {
    rule: string;
    detail: string;
    line?: number | undefined;
    snippet?: string | undefined;
    patched?: boolean | undefined;
}

/** SAFE_HALT 告警信息 (.ops/safe_halt.json) */
export interface SafeHaltInfo {
    reason: string;
    stage?: string | undefined;
    chapter?: number | undefined;
    conflictId?: string | undefined;
    affectedChapters?: number | undefined;
    affectedWords?: number | undefined;
    rollbackThreshold?: number | undefined;
    leftRef?: string | undefined;
    rightRef?: string | undefined;
    leftLine?: number | null | undefined;
    rightLine?: number | null | undefined;
    leftExcerpt?: string | undefined;
    rightExcerpt?: string | undefined;
    issues?: SafeHaltIssueItem[] | undefined;
    gateViolations?: VerdictGateViolationItem[] | undefined;
    timestamp?: string | undefined;
    details?: string | undefined;
}

/** 待消费导演信号项 (.ops/signals.jsonl) */
export interface PendingSignalItem {
    type?: string | undefined;
    reason?: string | undefined;
    chapter?: number | undefined;
    suggested_mode?: string | undefined;
    created_at?: string | undefined;
    raw?: string | undefined;
}

/** 只读实体卡片数据 */
export interface EntityViewItem {
    entityId: string;
    canonicalName: string;
    aliases?: string[] | undefined;
    lastSeenChapter?: number | undefined;
    markdown: string;
}

/** 只读物化视图集合 */
export interface MaterializedViewsData {
    entities?: EntityViewItem[] | undefined;
    coldArchiveCount?: number | undefined;
    horizonMarkdown?: string | undefined;
    threadsMarkdown?: string | undefined;
}

/** YOLO 连跑状态 */
export interface YoloStatusData {
    running: boolean;
    stopRequested?: boolean | undefined;
    completedChapters: number;
    targetChapters: number;
    currentStage?: string | null | undefined;
}

/** 投递信号回调参数 */
export interface SubmitSignalPayload {
    kind: DirectorSignalKind;
    content: string;
    runAfter: boolean;
    entityId?: string | undefined;
    targetDay?: number | undefined;
}

/** 外部触发中栏页签切换的命令 */
export interface ExternalViewCommand {
    viewTab: CenterViewTab;
    materialKind?: MaterializedViewKind | undefined;
    nonce: number;
}

/** 作品切换下拉摘要项 */
export interface CenterBookSummary {
    bookRoot: string;
    slug: string;
    title: string;
    currentChapter: number;
}

/** 中栏草稿命令式句柄（根组件守卫/暂存交接后调用） */
export interface CenterWorkbenchDraftHandle {
    resetDraft: (savedContent?: string) => void;
}

/** CenterWorkbench 组件 Props */
export interface CenterWorkbenchProps {
    bookTitle?: string | undefined;
    bookSlug?: string | undefined;
    currentBookRoot?: string | undefined;
    books?: CenterBookSummary[] | undefined;
    currentChapter: number;
    selectedChapter?: number | undefined;
    timelineMode?: string | undefined;
    walPhase?: string | undefined;
    activeTask?: RuntimeTaskKind | undefined;
    haltRequested?: boolean | undefined;
    haltWaiting?: boolean | undefined;
    yolo?: YoloStatusData | undefined;
    chapters?: ChapterSummaryItem[] | undefined;
    chapterDetail?: ChapterDetailData | null | undefined;
    chapterLoading?: boolean | undefined;
    stages?: Partial<Record<PipelineStageId, StageNodeState>> | undefined;
    latestSseStage?: string | null | undefined;
    safeHalt?: SafeHaltInfo | null | undefined;
    syncConflict?: SyncConflictDiagnostic | null | undefined;
    gateViolations?: VerdictGateViolationItem[] | undefined;
    pendingSignals?: PendingSignalItem[] | undefined;
    pendingSignalsCount?: number | undefined;
    materializedViews?: MaterializedViewsData | undefined;
    dirtyChaptersCount?: number | undefined;
    externalViewCommand?: ExternalViewCommand | undefined;
    leftCollapsed?: boolean | undefined;
    showCompactNav?: boolean | undefined;
    rightOpen?: boolean | undefined;
    hasSafeHalt?: boolean | undefined;
    currentVolumeLabel?: string | undefined;
    storyDay?: number | undefined;
    parallelWindowId?: string | undefined;
    roleDefinitions?: RoleDefinitionItem[] | undefined;
    roleRouting?: Record<string, RoleModelOverride> | undefined;
    modelRouting?: Record<string, string> | undefined;
    poolRoutes?: Record<RolePoolId, string> | undefined;
    nextChapterOptions?: string[] | undefined;
    revealNonce?: number | undefined;
    stashedDraft?: StashedDraftEntry | null | undefined;
    onDraftDirtyChange?:
        | ((dirty: { bookRoot: string; chapterNumber: number; content: string } | null) => void)
        | undefined;
    onDraftControlReady?: ((handle: CenterWorkbenchDraftHandle | null) => void) | undefined;
    onRestoreStashedDraft?: ((entry: StashedDraftEntry) => void) | undefined;
    onDiscardStashedDraft?: ((bookRoot: string, chapterNumber: number) => void) | undefined;
    onSelectBook?: ((bookRoot: string) => void) | undefined;
    onNewBook?: (() => void) | undefined;
    onToggleLeft?: (() => void) | undefined;
    onToggleRight?: (() => void) | undefined;
    onOpenInspector?: (() => void) | undefined;
    onOpenCodex?: ((kind: MaterializedViewKind) => void) | undefined;
    onCodexTabChange?: ((kind: MaterializedViewKind) => void) | undefined;
    onCloseCodex?: (() => void) | undefined;
    onDismissSignal?: ((index: number) => void) | undefined;
    onSelectChapter?: ((chapterNumber: number) => void) | undefined;
    onStepOne?: ((options?: StepChapterRequest) => Promise<void> | void) | undefined;
    onStartYolo?: ((targetChapters: number) => Promise<void> | void) | undefined;
    onStopYolo?: (() => Promise<void> | void) | undefined;
    onRequestHalt?: ((options?: { force?: boolean }) => Promise<void> | void) | undefined;
    onSync?: (() => Promise<void> | void) | undefined;
    onDream?: (() => Promise<void> | void) | undefined;
    onHarvestVoice?: ((chapterNumber?: number) => Promise<void> | void) | undefined;
    onHealConflicts?: (() => Promise<void> | void) | undefined;
    onOpenAdvanceVolumeModal?: (() => void) | undefined;
    onOpenParallelModal?: (() => void) | undefined;
    onSaveChapter?: ((chapterNumber: number, content: string) => Promise<void> | void) | undefined;
    onSubmitSignal?: ((payload: SubmitSignalPayload) => Promise<void> | void) | undefined;
    onRefreshViews?: (() => Promise<void> | void) | undefined;
    onRetryChapterDetail?: (() => void) | undefined;
    onInspectStage?: ((stageId: PipelineStageId) => void) | undefined;
    onSelectStageSession?: ((selection: StageSessionSelection) => void) | undefined;
}

interface StageDefinition {
    id: PipelineStageId;
    roleId: string;
    defaultPool: RolePoolId;
    label: string;
    shortDesc: string;
    defaultSummary: string;
}

const ACTIVE_TASK_LABELS: Record<string, string> = {
    STEPPING: '正在执笔推进',
    SYNCING: '正在同步台账',
    DREAMING: '正在整理设定',
    ADVANCING_VOLUME: '正在封存换卷',
    BOOTING: '正在建库编译'
};

const PIPELINE_STAGES: readonly StageDefinition[] = [
    {
        id: 'LIBRARIAN',
        roleId: 'librarian',
        defaultPool: 'fast_retrieval',
        label: '1. Librarian',
        shortDesc: '翻阅前文与设定选页',
        defaultSummary: '检索本场焦点实体卡与声纹样本'
    },
    {
        id: 'PLANNER',
        roleId: 'planner',
        defaultPool: 'strong_creative',
        label: '2. Planner',
        shortDesc: '规划本章剧情节拍',
        defaultSummary: '生成结构化章节细纲与节拍'
    },
    {
        id: 'WRITER',
        roleId: 'writer',
        defaultPool: 'strong_creative',
        label: '3. Writer',
        shortDesc: '纯净环境执笔正文',
        defaultSummary: '净室单轮流式直出正文草稿'
    },
    {
        id: 'FACT_CHECKER',
        roleId: 'fact_checker',
        defaultPool: 'audit',
        label: '4. Checker',
        shortDesc: '独立核对前后设定矛盾',
        defaultSummary: '异构模型核查与双侧原句验真'
    },
    {
        id: 'EXTRACTOR',
        roleId: 'extractor',
        defaultPool: 'fast_retrieval',
        label: '5. Extractor',
        shortDesc: '章末更新人物与伏笔',
        defaultSummary: '提取实体增量并原子提交双仓库'
    },
    {
        id: 'DREAMING',
        roleId: 'dreamer',
        defaultPool: 'strong_creative',
        label: '6. Dreamer',
        shortDesc: '跨章阶段整理与归纳',
        defaultSummary: '条件整理脏页水位与跨章连续性'
    }
];

const STAGE_ORDER: readonly PipelineStageId[] = PIPELINE_STAGES.map((s) => s.id);

/** 返修阶段展示元信息（统一映射目标节点、徽标与默认摘要） */
export interface StageRepairMeta {
    targetStage: PipelineStageId;
    badge: string;
    defaultSummary: string;
}

/** 返修重演阶段共享元数据表（LOCAL_PATCH / REWRITE / REPLAN） */
export const STAGE_REPAIR_META: Readonly<Record<string, StageRepairMeta>> = {
    LOCAL_PATCH: {
        targetStage: 'WRITER',
        badge: '门禁 Patch',
        defaultSummary: '正在净室内存局部 Patch 自愈'
    },
    REWRITE: {
        targetStage: 'WRITER',
        badge: 'Rewrite',
        defaultSummary: '核查打回，正在整章净室重写自愈'
    },
    REPLAN: {
        targetStage: 'PLANNER',
        badge: 'Replan',
        defaultSummary: '触发 Replan 重排细纲'
    }
};

const SSE_STAGE_ALIAS: Readonly<Record<string, PipelineStageId>> = {
    PROSE_GATE: 'WRITER',
    LOCAL_PATCH: STAGE_REPAIR_META['LOCAL_PATCH']!.targetStage,
    REWRITE: STAGE_REPAIR_META['REWRITE']!.targetStage,
    REPLAN: STAGE_REPAIR_META['REPLAN']!.targetStage
};

/** 将后端阶段名归一化为展示节点 ID（未知阶段返回 null） */
export function resolveStageId(stageName: string): PipelineStageId | null {
    const normalized = stageName.trim().toUpperCase();
    const aliased = SSE_STAGE_ALIAS[normalized] ?? normalized;
    return (STAGE_ORDER as readonly string[]).includes(aliased)
        ? (aliased as PipelineStageId)
        : null;
}

function deriveStagesFromSse(
    sseStage: string | null | undefined,
    overrides?: Partial<Record<PipelineStageId, StageNodeState>>
): Record<PipelineStageId, StageNodeState> {
    const base: Record<PipelineStageId, StageNodeState> = {
        LIBRARIAN: { status: 'idle' },
        PLANNER: { status: 'idle' },
        WRITER: { status: 'idle' },
        FACT_CHECKER: { status: 'idle' },
        EXTRACTOR: { status: 'idle' },
        DREAMING: { status: 'dormant', summary: '字数或变动人物达标后自动触发整理' }
    };

    if (sseStage) {
        if (sseStage === 'COMMITTED') {
            for (const id of STAGE_ORDER) {
                if (id === 'DREAMING') continue;
                base[id] = { status: 'done', summary: '已完成并提交入库' };
            }
        } else if (sseStage === 'SAFE_HALT') {
            base.FACT_CHECKER = { status: 'halt', summary: '检测到设定冲突，已拦截落盘' };
        } else if (sseStage === 'PROSE_GATE') {
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'done' };
            base.WRITER = { status: 'active', summary: '静态文风门禁校验中' };
        } else if (sseStage === 'LOCAL_PATCH' || sseStage === 'REWRITE') {
            const meta = STAGE_REPAIR_META[sseStage]!;
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'done' };
            base.WRITER = { status: 'healing', summary: meta.defaultSummary, badge: meta.badge };
            if (sseStage === 'REWRITE') {
                base.FACT_CHECKER = { status: 'healing', summary: '发现矛盾，触发重写' };
            }
        } else if (sseStage === 'REPLAN') {
            const meta = STAGE_REPAIR_META['REPLAN']!;
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'healing', summary: meta.defaultSummary, badge: meta.badge };
            base.FACT_CHECKER = { status: 'healing', summary: '要求重排细纲' };
        } else if (sseStage === 'DREAMING') {
            for (const id of STAGE_ORDER) {
                if (id === 'DREAMING') continue;
                base[id] = { status: 'done' };
            }
            base.DREAMING = { status: 'active', summary: '跨章整理与归纳运行中' };
        } else {
            const resolved = resolveStageId(sseStage);
            const activeIndex = resolved ? STAGE_ORDER.indexOf(resolved) : -1;
            if (activeIndex >= 0) {
                for (let i = 0; i < STAGE_ORDER.length; i++) {
                    const id = STAGE_ORDER[i];
                    if (!id || id === 'DREAMING') continue;
                    if (i < activeIndex) {
                        base[id] = { status: 'done', summary: '已完成' };
                    } else if (i === activeIndex) {
                        base[id] = { status: 'active', summary: '运行中' };
                    }
                }
            }
        }
    }

    if (overrides) {
        for (const id of STAGE_ORDER) {
            const custom = overrides[id];
            if (custom) {
                base[id] = { ...base[id], ...custom };
            }
        }
    }

    return base;
}

function getLampStatusClass(status: StageNodeStatus): string {
    switch (status) {
        case 'done':
            return 'ns-done';
        case 'active':
        case 'healing':
            return 'ns-active';
        case 'halt':
            return 'ns-halt';
        default:
            return '';
    }
}

function getStageStatusText(status: StageNodeStatus): string {
    switch (status) {
        case 'active':
            return '生成中';
        case 'done':
            return '已完成';
        case 'healing':
            return '润色中';
        case 'halt':
            return '有冲突';
        case 'dormant':
            return '条件未达';
        case 'idle':
        default:
            return '待命';
    }
}

/**
 * NarrateOS 中栏清样书稿与总控舞台组件
 */
export const CenterWorkbench: React.FC<CenterWorkbenchProps> = ({
    bookTitle,
    bookSlug,
    currentBookRoot,
    books = [],
    currentChapter,
    selectedChapter,
    timelineMode = 'MAINLINE',
    walPhase = 'STATE_COMMITTED',
    activeTask = 'IDLE',
    haltRequested = false,
    haltWaiting = false,
    yolo,
    chapters = [],
    chapterDetail,
    chapterLoading = false,
    stages,
    latestSseStage,
    safeHalt,
    syncConflict = null,
    gateViolations = [],
    pendingSignals = [],
    materializedViews,
    dirtyChaptersCount = 0,
    externalViewCommand,
    showCompactNav = false,
    rightOpen = true,
    hasSafeHalt = false,
    currentVolumeLabel,
    storyDay = 1,
    parallelWindowId,
    roleDefinitions,
    roleRouting,
    modelRouting,
    poolRoutes,
    nextChapterOptions = [],
    revealNonce = 0,
    stashedDraft = null,
    onSelectBook,
    onNewBook,
    onToggleRight,
    onOpenCodex,
    onCodexTabChange,
    onCloseCodex,
    onRestoreStashedDraft,
    onDiscardStashedDraft,
    onDismissSignal,
    onSelectChapter,
    onStepOne,
    onStartYolo,
    onStopYolo,
    onRequestHalt,
    onSync,
    onDream,
    onHarvestVoice,
    onHealConflicts,
    onOpenAdvanceVolumeModal,
    onOpenParallelModal,
    onSaveChapter,
    onSubmitSignal,
    onRefreshViews,
    onDraftDirtyChange,
    onRetryChapterDetail,
    onDraftControlReady,
    onInspectStage,
    onSelectStageSession
}) => {
    const activeChapterNumber = chapterDetail?.chapterNumber ?? selectedChapter ?? currentChapter;
    const isYoloRunning = Boolean(yolo?.running);
    const isBusy = activeTask !== 'IDLE' || isYoloRunning;
    const stopPending = haltRequested || Boolean(yolo?.stopRequested);

    // 同步防重入锁（ISS-069）：防止在途前连续点击写出重复请求
    const stepSubmittingRef = useRef(false);
    const [stepSubmitting, setStepSubmitting] = useState(false);

    // 浮层菜单状态：'book' | 'toc' | 'run' | 'stop' | 'ops' | null
    const [openMenu, setOpenMenu] = useState<'book' | 'toc' | 'run' | 'stop' | 'ops' | null>(null);
    const headerRef = useRef<HTMLElement | null>(null);

    // 主画布表面：单章手稿 ('chapter') vs 独立全书设定集 ('codex')
    const [mainSurface, setMainSurface] = useState<'chapter' | 'codex'>('chapter');
    const [chapterTab, setChapterTab] = useState<'prose' | 'plan' | 'diff'>('prose');
    const [codexTab, setCodexTab] = useState<MaterializedViewKind>('entities');

    // 3x2 工序与模型矩阵开关
    const [stageDrawerOpen, setStageDrawerOpen] = useState(false);
    const [inspectedStageId, setInspectedStageId] = useState<PipelineStageId>('WRITER');

    // 响应外部导航命令（左栏全书设定集 / 选章复位）
    useEffect(() => {
        if (!externalViewCommand) return;
        if (externalViewCommand.viewTab === 'views') {
            setMainSurface('codex');
            if (externalViewCommand.materialKind) {
                setCodexTab(externalViewCommand.materialKind);
            }
            return;
        }
        setMainSurface('chapter');
        if (
            externalViewCommand.viewTab === 'prose' ||
            externalViewCommand.viewTab === 'plan' ||
            externalViewCommand.viewTab === 'diff'
        ) {
            setChapterTab(externalViewCommand.viewTab);
        }
    }, [externalViewCommand]);

    // 点击外部或 Escape 关闭顶栏浮层菜单
    useEffect(() => {
        if (!openMenu) return;
        const onPointerDown = (ev: MouseEvent | TouchEvent) => {
            const target = ev.target as Node | null;
            if (target && headerRef.current && !headerRef.current.contains(target)) {
                setOpenMenu(null);
            }
        };
        const onKeyDown = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                setOpenMenu(null);
            }
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [openMenu]);

    // 在线改稿编辑态与草稿基线
    const [isEditing, setIsEditing] = useState(false);
    const [draftContent, setDraftContent] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);
    const savingRef = useRef(false);
    const [syncingFromDiff, setSyncingFromDiff] = useState(false);
    const [healingConflict, setHealingConflict] = useState(false);
    const [draftBaseline, setDraftBaseline] = useState<string | null>(null);
    const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

    // 底部导演便签舱受控态
    const [noteKind, setNoteKind] = useState<NoteSignalKind>('DIRECTOR_NOTE');
    const [noteText, setNoteText] = useState('');
    const [spotlightEntityId, setSpotlightEntityId] = useState('');
    const [flashbackDay, setFlashbackDay] = useState(1);
    const [submittingSignal, setSubmittingSignal] = useState(false);
    const signalInputRef = useRef<HTMLInputElement | null>(null);

    // 局部反馈提示
    const [actionMessage, setActionMessage] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // 切章/切书重置编辑态（同章后台刷新不得覆盖编辑中草稿）
    const draftChapterRef = useRef<number | null>(null);
    const draftBookRef = useRef<string | null>(null);
    useEffect(() => {
        const nextChapter = chapterDetail?.chapterNumber ?? null;
        const nextBook = currentBookRoot ?? null;
        const contextChanged =
            draftChapterRef.current !== nextChapter || draftBookRef.current !== nextBook;
        draftChapterRef.current = nextChapter;
        draftBookRef.current = nextBook;
        if (contextChanged) {
            if (chapterDetail) {
                setDraftContent(chapterDetail.content);
                setDraftBaseline(null);
                setIsEditing(false);
            }
            return;
        }
        if (!isEditing && chapterDetail) {
            setDraftContent(chapterDetail.content);
        }
    }, [chapterDetail?.chapterNumber, chapterDetail?.content, currentBookRoot, isEditing]);

    const isDraftDirty =
        isEditing && draftBaseline !== null && draftContent !== draftBaseline;
    const draftDirtyLocation =
        isDraftDirty && chapterDetail
            ? {
                  bookRoot: currentBookRoot ?? '',
                  chapterNumber: chapterDetail.chapterNumber,
                  content: draftContent
              }
            : null;

    useEffect(() => {
        onDraftDirtyChange?.(draftDirtyLocation);
    }, [
        onDraftDirtyChange,
        draftDirtyLocation?.bookRoot,
        draftDirtyLocation?.chapterNumber,
        draftDirtyLocation?.content
    ]);

    useEffect(
        () => () => {
            onDraftDirtyChange?.(null);
        },
        [onDraftDirtyChange]
    );

    const serverContentRef = useRef<string>('');
    serverContentRef.current = chapterDetail?.content ?? '';
    useEffect(() => {
        if (!onDraftControlReady) return;
        onDraftControlReady({
            resetDraft: (savedContent?: string) => {
                if (savingRef.current) return;
                setDraftBaseline(null);
                setIsEditing(false);
                setDraftContent(savedContent ?? serverContentRef.current);
            }
        });
        return () => onDraftControlReady(null);
    }, [onDraftControlReady]);

    // 滚动阅读进度丝带降级监听 & WAAPI 段落墨迹显影
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const ribbonRef = useRef<HTMLDivElement | null>(null);
    const proseBodyRef = useRef<HTMLDivElement | null>(null);
    const activeAnimationsRef = useRef<Animation[]>([]);
    const lastRevealedKeyRef = useRef<string>('');
    const [sealJustStamped, setSealJustStamped] = useState(false);

    const cancelActiveAnimations = () => {
        while (activeAnimationsRef.current.length > 0) {
            const anim = activeAnimationsRef.current.pop();
            try {
                anim?.cancel();
            } catch {
                // 忽略已结束动画清理异常
            }
        }
    };

    useEffect(() => {
        const scroller = scrollerRef.current;
        const ribbon = ribbonRef.current;
        if (!scroller || !ribbon) return;
        const supportsScrollTimeline =
            typeof window !== 'undefined' &&
            typeof window.CSS !== 'undefined' &&
            typeof window.CSS.supports === 'function' &&
            window.CSS.supports('animation-timeline: scroll()');
        if (supportsScrollTimeline) return;

        const updateProgress = () => {
            const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
            const ratio = Math.min(1, Math.max(0, scroller.scrollTop / max));
            ribbon.style.setProperty('--ns-scroll-fallback', String(ratio));
        };
        updateProgress();
        scroller.addEventListener('scroll', updateProgress, { passive: true });
        return () => scroller.removeEventListener('scroll', updateProgress);
    }, [activeChapterNumber, chapterTab, mainSurface]);

    const stageMap = useMemo(
        () => deriveStagesFromSse(latestSseStage, stages),
        [latestSseStage, stages]
    );

    const showFeedback = (msg: string) => {
        setActionError(null);
        setActionMessage(msg);
    };

    const showError = (err: unknown) => {
        setActionMessage(null);
        setActionError(err instanceof Error ? err.message : String(err));
    };

    /** 触发单步推进下一章（带同步 Ref 防重入锁，不传泛化默认 goal 让后端消费 next_chapter_options） */
    const handleStepOne = async (options?: StepChapterRequest) => {
        if (stepSubmittingRef.current || isBusy) {
            return;
        }
        stepSubmittingRef.current = true;
        setStepSubmitting(true);
        setOpenMenu(null);
        try {
            if (onStepOne) {
                await onStepOne(options);
            } else {
                const resp = await fetch('/api/narrate/step', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(options ?? {})
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `写下一章失败 (${resp.status})`);
                }
            }
            showFeedback('已启动章节生成');
        } catch (err) {
            showError(err);
        } finally {
            stepSubmittingRef.current = false;
            setStepSubmitting(false);
        }
    };

    const handleStartYolo = async (targetChapters: number) => {
        setOpenMenu(null);
        try {
            if (onStartYolo) {
                await onStartYolo(targetChapters);
            } else {
                const resp = await fetch('/api/narrate/yolo/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetChapters })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `启动 YOLO 连写失败 (${resp.status})`);
                }
            }
            showFeedback(
                targetChapters === 0
                    ? '已开启 YOLO 持续连写'
                    : `已开启 YOLO 连写 ${targetChapters} 章`
            );
        } catch (err) {
            showError(err);
        }
    };

    const handleSoftStop = async () => {
        setOpenMenu(null);
        try {
            if (isYoloRunning && onStopYolo) {
                await onStopYolo();
            } else if (onRequestHalt) {
                await onRequestHalt({ force: false });
            } else {
                await fetch('/api/narrate/halt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: false })
                });
            }
            showFeedback('将在本章写完保存后平稳停下');
        } catch (err) {
            showError(err);
        }
    };

    const handleForceStop = async () => {
        setOpenMenu(null);
        try {
            if (onRequestHalt) {
                await onRequestHalt({ force: true });
            } else {
                await fetch('/api/narrate/halt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: true })
                });
            }
            showFeedback('已发送立即中断指令，正在撤回半截草稿');
        } catch (err) {
            showError(err);
        }
    };

    const handleSync = async () => {
        try {
            if (onSync) {
                await onSync();
            } else {
                const resp = await fetch('/api/narrate/sync', { method: 'POST' });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `同步修改失败 (${resp.status})`);
                }
            }
            showFeedback('已完成手改同步与人物台账更新');
        } catch (err) {
            showError(err);
        }
    };

    const handleDream = async () => {
        setOpenMenu(null);
        try {
            if (onDream) {
                await onDream();
            } else {
                const resp = await fetch('/api/narrate/dream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: true })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `整理设定失败 (${resp.status})`);
                }
            }
            showFeedback('已启动跨章设定与伏笔整理');
        } catch (err) {
            showError(err);
        }
    };

    const handleStartEditing = () => {
        if (!chapterDetail) {
            showError('章节详情尚未加载，暂不能改稿');
            return;
        }
        setMainSurface('chapter');
        onCloseCodex?.();
        setChapterTab('prose');
        if (!isEditing) {
            setDraftContent(chapterDetail.content);
            setDraftBaseline(chapterDetail.content);
        }
        setIsEditing(true);
    };

    const handleCancelEditing = () => {
        if (isDraftDirty) {
            setDiscardConfirmOpen(true);
            return;
        }
        setDraftBaseline(null);
        setIsEditing(false);
        setDraftContent(chapterDetail?.content ?? '');
    };

    const handleSaveEditedChapter = async () => {
        if (savingRef.current) return;
        const targetChapterNumber = chapterDetail?.chapterNumber ?? activeChapterNumber;
        if (!targetChapterNumber || targetChapterNumber <= 0) {
            showError('当前没有可保存的有效章节号');
            return;
        }
        if (isBusy) {
            showError('引擎正在执行任务，暂时无法保存；草稿已保留，请待任务结束后重试');
            return;
        }
        const contentToSave = draftContent;
        savingRef.current = true;
        setSavingEdit(true);
        try {
            if (onSaveChapter) {
                await onSaveChapter(targetChapterNumber, contentToSave);
            } else {
                const resp = await fetch('/api/narrate/chapter', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chapterNumber: targetChapterNumber, content: contentToSave })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `保存并同步失败 (${resp.status})`);
                }
            }
            setDraftBaseline(contentToSave);
            setIsEditing(false);
            showFeedback(`已保存第 ${targetChapterNumber} 章并自动同步`);
        } catch (err) {
            showError(err);
        } finally {
            savingRef.current = false;
            setSavingEdit(false);
        }
    };

    const handleSignalAction = async (payload: SubmitSignalPayload) => {
        setSubmittingSignal(true);
        try {
            if (onSubmitSignal) {
                await onSubmitSignal(payload);
            } else {
                const isSpotlight = payload.kind === 'SPOTLIGHT_TRIGGER';
                const isRetcon = payload.kind === 'RETCON' || payload.kind === 'Retcon';
                const isFlashback = payload.kind === 'FLASHBACK';
                const req: Record<string, unknown> = {
                    type: isRetcon
                        ? 'RETCON'
                        : isSpotlight
                          ? 'SPOTLIGHT_TRIGGER'
                          : 'DIRECTOR_NOTE',
                    content: payload.content.trim(),
                    reason: payload.content.trim(),
                    chapter: Math.max(0, currentChapter),
                    created_at: new Date().toISOString()
                };
                if (isSpotlight && payload.entityId) {
                    req['entity_id'] = payload.entityId;
                }
                if (isFlashback) {
                    req['suggested_mode'] = 'FLASHBACK';
                }
                const resp = await fetch('/api/narrate/signals', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(req)
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `递交便签失败 (${resp.status})`);
                }
                if (payload.runAfter) {
                    await handleStepOne(
                        isFlashback && payload.targetDay
                            ? { timelineMode: 'FLASHBACK', targetDay: payload.targetDay }
                            : undefined
                    );
                }
            }
            setNoteText('');
            showFeedback(
                payload.runAfter
                    ? '便签已收好并立即开始写下一章'
                    : '便签已收好，写下一章时自动生效'
            );
        } catch (err) {
            showError(err);
        } finally {
            setSubmittingSignal(false);
        }
    };

    // 联动模型分配计算 6 步工种生效模型
    const effectivePoolRoutes = useMemo<Record<RolePoolId, string>>(
        () => ({
            strong_creative:
                poolRoutes?.strong_creative ??
                modelRouting?.['strong_creative'] ??
                modelRouting?.['strong'] ??
                '--',
            fast_retrieval:
                poolRoutes?.fast_retrieval ??
                modelRouting?.['fast_retrieval'] ??
                modelRouting?.['fast'] ??
                '--',
            audit: poolRoutes?.audit ?? modelRouting?.['audit'] ?? '--'
        }),
        [modelRouting, poolRoutes]
    );

    const poolProviders = useMemo(
        () => collectPoolProviders(effectivePoolRoutes, roleDefinitions ?? [], roleRouting),
        [effectivePoolRoutes, roleDefinitions, roleRouting]
    );

    const resolveStageModelLabel = (stageDef: StageDefinition): string => {
        const matchedDef = (roleDefinitions ?? []).find((def) => {
            const norm = def.id.trim().toLowerCase().replace('-', '_');
            return norm === stageDef.roleId;
        });
        const def: RoleDefinitionItem = matchedDef ?? {
            id: stageDef.roleId,
            defaultPool: stageDef.defaultPool,
            effectiveProvider: '',
            effectiveModel: '--'
        };
        const ov =
            roleRouting?.[def.id] ??
            roleRouting?.[stageDef.roleId] ??
            (stageDef.roleId === 'fact_checker' ? roleRouting?.['fact-checker'] : undefined);
        return resolveEffectiveRoleModelLabel(
            def,
            undefined,
            ov,
            effectivePoolRoutes,
            poolProviders
        );
    };

    const activeChapterIndex = useMemo(
        () => chapters.findIndex((ch) => ch.chapterNumber === activeChapterNumber),
        [chapters, activeChapterNumber]
    );
    const activeChapterSummary =
        activeChapterIndex >= 0 ? (chapters[activeChapterIndex] ?? null) : null;
    const prevChapterSummary =
        activeChapterIndex > 0 ? (chapters[activeChapterIndex - 1] ?? null) : null;
    const nextChapterSummary =
        activeChapterIndex >= 0 && activeChapterIndex < chapters.length - 1
            ? (chapters[activeChapterIndex + 1] ?? null)
            : null;

    const activeChapterTitle =
        chapterDetail?.title ??
        activeChapterSummary?.title ??
        (activeChapterNumber > 0 ? `第 ${activeChapterNumber} 章` : '开卷待写');
    const chapterFileName =
        activeChapterSummary?.fileName ??
        `ch_${String(Math.max(0, activeChapterNumber)).padStart(4, '0')}.md`;
    const diffHunks = useMemo(
        () => parseUnifiedDiff(chapterDetail?.diffFromHead ?? '', chapterFileName),
        [chapterDetail?.diffFromHead, chapterFileName]
    );
    const isChapterDirty = Boolean(chapterDetail?.dirty ?? activeChapterSummary?.dirty);
    const proseContent = chapterDetail?.content ?? '';
    const proseCharCount = useMemo(
        () => proseContent.replace(/\s+/g, '').length,
        [proseContent]
    );
    const proseParagraphs = useMemo(
        () => splitProseParagraphs(proseContent, activeChapterNumber, activeChapterTitle),
        [proseContent, activeChapterNumber, activeChapterTitle]
    );

    // WAAPI 段落显影：新章落盘或同步定稿后触发，切章/卸载立即 cancel()
    useEffect(() => {
        cancelActiveAnimations();
        if (
            mainSurface !== 'chapter' ||
            chapterTab !== 'prose' ||
            isEditing ||
            proseParagraphs.length === 0 ||
            !revealNonce ||
            revealNonce <= 0
        ) {
            return undefined;
        }
        const revealKey = `${activeChapterNumber}:${revealNonce}`;
        if (lastRevealedKeyRef.current === revealKey) {
            return undefined;
        }
        lastRevealedKeyRef.current = revealKey;
        setSealJustStamped(true);
        const timer = setTimeout(() => setSealJustStamped(false), 520);

        if (!prefersReducedMotion() && proseBodyRef.current) {
            const nodes = proseBodyRef.current.querySelectorAll('.ns-prose-para-wrap');
            nodes.forEach((node, idx) => {
                const el = node as HTMLElement;
                if (typeof el.animate !== 'function') return;
                const anim = el.animate(
                    [
                        { opacity: 0.08, transform: 'translateY(5px)', filter: 'blur(1.5px)' },
                        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0px)' }
                    ],
                    {
                        duration: 340,
                        delay: Math.min(idx * 55, 240),
                        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
                        fill: 'both'
                    }
                );
                activeAnimationsRef.current.push(anim);
            });
        }

        return () => {
            clearTimeout(timer);
            cancelActiveAnimations();
        };
    }, [activeChapterNumber, chapterTab, isEditing, mainSurface, proseParagraphs.length, revealNonce]);

    // 真实 Patch 校勘签（不伪造字符偏移高亮）
    const patchSession = useMemo(() => {
        const list = stageMap.WRITER.sessions ?? [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const item = list[i]!;
            if (
                item.stage.trim().toUpperCase() === 'LOCAL_PATCH' ||
                item.role?.trim().toLowerCase() === 'patch'
            ) {
                return item;
            }
        }
        return undefined;
    }, [stageMap.WRITER.sessions]);
    const patchedViolationCount = useMemo(
        () => gateViolations.filter((v) => v.patched).length,
        [gateViolations]
    );
    const showPatchColophon = Boolean(patchSession || patchedViolationCount > 0);

    // 冲突高亮行号（如有）
    const conflictTargetLine = useMemo(() => {
        if (syncConflict?.rightLine) return syncConflict.rightLine;
        if (safeHalt?.rightLine) return safeHalt.rightLine;
        return null;
    }, [safeHalt?.rightLine, syncConflict?.rightLine]);

    const featHash =
        chapterDetail?.featCommitSha?.slice(0, 7) ??
        activeChapterSummary?.commitSha?.slice(0, 7) ??
        undefined;
    const stateHash = chapterDetail?.stateCommitSha?.slice(0, 7) ?? undefined;
    const commitDisplay = featHash ?? stateHash ?? chapterDetail?.sha256?.slice(0, 7);

    const outlineStatus = chapterDetail?.outlineStatus ?? 'missing';
    const parsedPlan = useMemo(
        () =>
            outlineStatus === 'available'
                ? parseStructuredPlan(chapterDetail?.outlineText ?? undefined, activeChapterTitle)
                : null,
        [outlineStatus, chapterDetail?.outlineText, activeChapterTitle]
    );

    const pipelineButtonLabel = useMemo(() => {
        if (safeHalt || syncConflict) return 'Checker 暂停';
        const activeStage = PIPELINE_STAGES.find((s) => stageMap[s.id].status === 'active');
        if (activeStage) {
            return `${activeStage.label.replace(/^\d+\.\s*/, '')} 生成中`;
        }
        const healingStage = PIPELINE_STAGES.find((s) => stageMap[s.id].status === 'healing');
        if (healingStage) {
            return `${healingStage.label.replace(/^\d+\.\s*/, '')} 润色中`;
        }
        return 'Agent 工序与模型';
    }, [safeHalt, stageMap, syncConflict]);

    const hasChapterContent = chapters.length > 0 || chapterDetail !== null;
    const displayBookTitle = bookTitle || bookSlug || '未命名作品';
    const displayVolumeLabel =
        chapterDetail?.volumeLabel || currentVolumeLabel || (hasChapterContent ? '第一卷' : '第一卷 · 尚未开写');

    const handleInspectStep = (stageDef: StageDefinition) => {
        const nodeState = stageMap[stageDef.id];
        runWithViewTransition(() => {
            setInspectedStageId(stageDef.id);
            onInspectStage?.(stageDef.id);
            if (nodeState.sessionId && onSelectStageSession) {
                onSelectStageSession({
                    stageId: stageDef.id,
                    stageLabel: stageDef.label,
                    sessionId: nodeState.sessionId,
                    ...(nodeState.parentSessionId !== undefined
                        ? { parentSessionId: nodeState.parentSessionId }
                        : {}),
                    ...(nodeState.mode !== undefined ? { mode: nodeState.mode } : {}),
                    runId: nodeState.runId,
                    status: nodeState.status
                });
            } else if (stageDef.id === 'WRITER' && onSelectStageSession) {
                onSelectStageSession({
                    stageId: stageDef.id,
                    stageLabel: stageDef.label,
                    sessionId: `cleanroom-ch-${activeChapterNumber}`,
                    status: nodeState.status,
                    cleanroom: true
                });
            }
        });
    };

    const handleOpenPatchTrace = () => {
        runWithViewTransition(() => {
            setInspectedStageId('WRITER');
            onInspectStage?.('WRITER');
            if (patchSession && onSelectStageSession) {
                onSelectStageSession({
                    stageId: 'WRITER',
                    stageLabel: '3. Writer',
                    sessionId: patchSession.sessionId,
                    ...(patchSession.parentSessionId !== undefined
                        ? { parentSessionId: patchSession.parentSessionId }
                        : {}),
                    ...(patchSession.mode !== undefined ? { mode: patchSession.mode } : {}),
                    runId: patchSession.runId,
                    status: stageMap.WRITER.status
                });
            } else if (stageMap.WRITER.sessionId && onSelectStageSession) {
                onSelectStageSession({
                    stageId: 'WRITER',
                    stageLabel: '3. Writer',
                    sessionId: stageMap.WRITER.sessionId,
                    runId: stageMap.WRITER.runId,
                    status: stageMap.WRITER.status
                });
            } else if (onSelectStageSession) {
                onSelectStageSession({
                    stageId: 'WRITER',
                    stageLabel: '3. Writer',
                    sessionId: `cleanroom-patch-ch-${activeChapterNumber}`,
                    status: stageMap.WRITER.status,
                    cleanroom: true
                });
            }
        });
    };

    const handleFocusNoteDock = (kind: 'DIRECTOR_NOTE' | 'RETCON', prefill: string) => {
        setMainSurface('chapter');
        onCloseCodex?.();
        setNoteKind(kind);
        if (!noteText.trim() && prefill) {
            setNoteText(prefill);
        }
        signalInputRef.current?.focus();
    };

    return (
        <main className="ns-center-workbench ns-center-pane">
            {/* 内联宣纸印泥纤维 SVG 滤镜（零外部资源依赖） */}
            <svg width="0" height="0" className="ns-svg-defs" aria-hidden="true">
                <defs>
                    <filter id="ns-cinnabar-grain" x="-8%" y="-8%" width="116%" height="116%">
                        <feTurbulence
                            type="fractalNoise"
                            baseFrequency="0.75"
                            numOctaves="2"
                            seed="7"
                            result="grain"
                        />
                        <feDisplacementMap
                            in="SourceGraphic"
                            in2="grain"
                            scale="1.4"
                            xChannelSelector="R"
                            yChannelSelector="G"
                        />
                    </filter>
                </defs>
            </svg>

            {/* 顶栏：左侧无框书名切换 + 窄屏目录浮层 + 状态胶囊；右侧同步、写下一章/YOLO、⋯、右栏开关 */}
            <header className="ns-center-header" ref={headerRef}>
                <div className="ns-header-left">
                    <div className="ns-header-pop-wrap">
                        <button
                            type="button"
                            className="ns-book-switcher"
                            aria-haspopup="menu"
                            aria-expanded={openMenu === 'book'}
                            onClick={() =>
                                setOpenMenu((prev) => (prev === 'book' ? null : 'book'))
                            }
                        >
                            <span>《{displayBookTitle}》</span>
                            {StudioIcons.chev}
                        </button>
                        {openMenu === 'book' ? (
                            <div className="ns-menu-pop ns-left" role="menu" aria-label="切换作品">
                                {books.map((book) => (
                                    <button
                                        key={book.bookRoot}
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row"
                                        onClick={() => {
                                            setOpenMenu(null);
                                            if (book.bookRoot !== currentBookRoot) {
                                                onSelectBook?.(book.bookRoot);
                                            }
                                        }}
                                    >
                                        <b>{book.title || book.slug}</b>
                                        <span>
                                            {book.currentChapter > 0
                                                ? `已写至第 ${book.currentChapter} 章`
                                                : '新书待开篇'}
                                        </span>
                                    </button>
                                ))}
                                {onNewBook ? (
                                    <>
                                        {books.length > 0 ? <div className="ns-menu-divider" /> : null}
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="ns-menu-row"
                                            onClick={() => {
                                                setOpenMenu(null);
                                                onNewBook();
                                            }}
                                        >
                                            <b>+ 开启新作品</b>
                                            <span>打开建库向导或切回构思对话</span>
                                        </button>
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    {showCompactNav ? (
                        <div className="ns-header-pop-wrap">
                            <button
                                type="button"
                                className="ns-btn ns-btn-subtle"
                                aria-haspopup="menu"
                                aria-expanded={openMenu === 'toc'}
                                onClick={() =>
                                    setOpenMenu((prev) => (prev === 'toc' ? null : 'toc'))
                                }
                            >
                                <span>
                                    {hasChapterContent && activeChapterNumber > 0
                                        ? `第 ${activeChapterNumber} 章`
                                        : '新书'}{' '}
                                    · 目录与设定集
                                </span>
                                {StudioIcons.chev}
                            </button>
                            {openMenu === 'toc' ? (
                                <div className="ns-menu-pop ns-left" role="menu" aria-label="章节与设定集">
                                    {chapters.map((ch) => (
                                        <button
                                            key={ch.chapterNumber}
                                            type="button"
                                            role="menuitem"
                                            className="ns-menu-row"
                                            onClick={() => {
                                                setOpenMenu(null);
                                                setMainSurface('chapter');
                                                onSelectChapter?.(ch.chapterNumber);
                                            }}
                                        >
                                            <b>
                                                第 {ch.chapterNumber} 章 · {ch.title}
                                            </b>
                                            <span>
                                                {ch.charCount !== undefined
                                                    ? `${ch.charCount} 字`
                                                    : '已入库'}
                                            </span>
                                        </button>
                                    ))}
                                    <div className="ns-menu-divider" />
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row"
                                        onClick={() => {
                                            setOpenMenu(null);
                                            runWithViewTransition(() => {
                                                setMainSurface('codex');
                                                setCodexTab('entities');
                                                onOpenCodex?.('entities');
                                            });
                                        }}
                                    >
                                        <b>打开全书设定集</b>
                                        <span>人物档案 · 未解伏笔 · 预案与废案</span>
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {isYoloRunning ? (
                        <span className="ns-badge ns-badge-accent">
                            {yolo && yolo.targetChapters > 0
                                ? `YOLO 连写 ${yolo.completedChapters}/${yolo.targetChapters} 章`
                                : `YOLO 连写中 · 第 ${currentChapter + 1} 章`}
                        </span>
                    ) : activeTask !== 'IDLE' ? (
                        <span className="ns-badge ns-badge-accent">
                            {ACTIVE_TASK_LABELS[activeTask] ?? '正在处理'}
                        </span>
                    ) : null}

                    {timelineMode === 'PARALLEL' || parallelWindowId ? (
                        <span className="ns-badge ns-badge-warn">
                            多线并行{parallelWindowId ? ` · ${parallelWindowId}` : ''}
                        </span>
                    ) : null}
                </div>

                <div className="ns-header-right">
                    {dirtyChaptersCount > 0 ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-warn"
                            disabled={isBusy || syncingFromDiff}
                            onClick={() => void handleSync()}
                            title="根据手改正文自动更新人物与章节台账"
                        >
                            {StudioIcons.sync}
                            <span>
                                {activeTask === 'SYNCING'
                                    ? '同步中…'
                                    : `同步修改 (${dirtyChaptersCount})`}
                            </span>
                        </button>
                    ) : null}

                    {isBusy ? (
                        <div className="ns-split-action">
                            <button
                                type="button"
                                className="ns-btn ns-btn-warn"
                                disabled={stopPending}
                                onClick={() => void handleSoftStop()}
                            >
                                {StudioIcons.pause}
                                <span>
                                    {stopPending
                                        ? haltWaiting
                                            ? '等待安全点收束…'
                                            : '写完本章即停…'
                                        : '写完本章暂停'}
                                </span>
                            </button>
                            <button
                                type="button"
                                className="ns-btn ns-btn-warn"
                                aria-haspopup="menu"
                                aria-expanded={openMenu === 'stop'}
                                aria-label="更多停止选项"
                                onClick={() =>
                                    setOpenMenu((prev) => (prev === 'stop' ? null : 'stop'))
                                }
                            >
                                {StudioIcons.chev}
                            </button>
                            {openMenu === 'stop' ? (
                                <div className="ns-menu-pop" role="menu" aria-label="停止方式">
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row"
                                        onClick={() => void handleSoftStop()}
                                    >
                                        <b>写完本章后平稳停下（推荐）</b>
                                        <span>等当前章节保存完整后再退出运行</span>
                                    </button>
                                    <div className="ns-menu-divider" />
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row ns-danger"
                                        onClick={() => void handleForceStop()}
                                    >
                                        <b>立即中断并撤回半截草稿</b>
                                        <span>强行打断当前生成，恢复到上一章干净状态</span>
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <div className="ns-split-action">
                            <button
                                type="button"
                                className="ns-btn ns-btn-primary"
                                disabled={isBusy || stepSubmitting}
                                onClick={() => void handleStepOne()}
                            >
                                {StudioIcons.play}
                                <span>{stepSubmitting ? '正在开启…' : '写下一章'}</span>
                            </button>
                            <button
                                type="button"
                                className="ns-btn ns-btn-primary"
                                disabled={isBusy || stepSubmitting}
                                aria-haspopup="menu"
                                aria-expanded={openMenu === 'run'}
                                onClick={() =>
                                    setOpenMenu((prev) => (prev === 'run' ? null : 'run'))
                                }
                            >
                                <span>YOLO</span>
                                {StudioIcons.chev}
                            </button>
                            {openMenu === 'run' ? (
                                <div className="ns-menu-pop" role="menu" aria-label="YOLO 连写模式">
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row"
                                        onClick={() => void handleStartYolo(0)}
                                    >
                                        <b>YOLO 持续连写</b>
                                        <span>遇到设定冲突、关键视角切镜或手动暂停时自动停下</span>
                                    </button>
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row"
                                        onClick={() => void handleStartYolo(5)}
                                    >
                                        <b>YOLO 连写 5 章</b>
                                        <span>写满 5 章后自动停下待审</span>
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    )}

                    <div className="ns-header-pop-wrap">
                        <button
                            type="button"
                            className="ns-btn ns-btn-icon-only"
                            aria-haspopup="menu"
                            aria-expanded={openMenu === 'ops'}
                            aria-label="更多创作整理操作"
                            title="更多创作整理操作"
                            onClick={() =>
                                setOpenMenu((prev) => (prev === 'ops' ? null : 'ops'))
                            }
                        >
                            {StudioIcons.more}
                        </button>
                        {openMenu === 'ops' ? (
                            <div className="ns-menu-pop" role="menu" aria-label="更多创作操作">
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="ns-menu-row"
                                    disabled={isBusy}
                                    onClick={() => void handleDream()}
                                >
                                    <b>立即整理设定与伏笔</b>
                                    <span>归纳近期章节的人物变化与复现线索</span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="ns-menu-row"
                                    disabled={isBusy}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        onOpenAdvanceVolumeModal?.();
                                    }}
                                >
                                    <b>结束本卷 / 开启下一卷</b>
                                    <span>勾选随行人物、归档退场角色并规划新卷</span>
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="ns-menu-row"
                                    disabled={isBusy}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        onOpenParallelModal?.();
                                    }}
                                >
                                    <b>
                                        {timelineMode === 'PARALLEL' || parallelWindowId
                                            ? '管理 / 合流多线并行窗口'
                                            : '开启多线并行章节'}
                                    </b>
                                    <span>同一时间段分头推进两条人物支线</span>
                                </button>
                                <div className="ns-menu-divider" />
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="ns-menu-row"
                                    disabled={isBusy}
                                    onClick={() => {
                                        setOpenMenu(null);
                                        void onHarvestVoice?.(
                                            activeChapterNumber > 0 ? activeChapterNumber : undefined
                                        );
                                    }}
                                >
                                    <b>重新提取本章对话声纹</b>
                                    <span>从当前选定章节采集鲜活表达标本</span>
                                </button>
                                {onRefreshViews ? (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row"
                                        disabled={isBusy}
                                        onClick={() => {
                                            setOpenMenu(null);
                                            void onRefreshViews();
                                        }}
                                    >
                                        <b>刷新工作区数据</b>
                                        <span>重新读取最新章节与设定集视图</span>
                                    </button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    {onToggleRight ? (
                        <button
                            type="button"
                            className={`ns-btn ns-btn-icon-only${rightOpen ? ' ns-btn-subtle' : ''}${hasSafeHalt ? ' ns-btn-halt-alert' : ''}`}
                            onClick={onToggleRight}
                            title={rightOpen ? '收起右侧面板' : '展开右侧面板'}
                            aria-label={rightOpen ? '收起右侧面板' : '展开右侧面板'}
                        >
                            {StudioIcons.rightbar}
                        </button>
                    ) : null}
                </div>
            </header>

            {/* 单章工具栏（严禁出现原型 .sim-bar；独立设定集视图下隐藏） */}
            {mainSurface === 'chapter' && hasChapterContent ? (
                <div className="ns-reader-toolbar-wrap">
                    <div className="ns-reader-bar">
                        <div
                            className="ns-seg-tabs"
                            role="tablist"
                            aria-label="章节视图"
                            onKeyDown={handleTabKeyDown}
                        >
                            <button
                                type="button"
                                role="tab"
                                id="ns-tab-prose"
                                aria-controls="ns-chapter-panel"
                                tabIndex={chapterTab === 'prose' ? 0 : -1}
                                aria-selected={chapterTab === 'prose'}
                                className={`ns-seg-tab${chapterTab === 'prose' ? ' ns-active' : ''}`}
                                onClick={() => setChapterTab('prose')}
                            >
                                本章正文
                            </button>
                            <button
                                type="button"
                                role="tab"
                                id="ns-tab-plan"
                                aria-controls="ns-chapter-panel"
                                tabIndex={chapterTab === 'plan' ? 0 : -1}
                                aria-selected={chapterTab === 'plan'}
                                className={`ns-seg-tab${chapterTab === 'plan' ? ' ns-active' : ''}`}
                                onClick={() => setChapterTab('plan')}
                            >
                                本章细纲
                            </button>
                            <button
                                type="button"
                                role="tab"
                                id="ns-tab-diff"
                                aria-controls="ns-chapter-panel"
                                tabIndex={chapterTab === 'diff' ? 0 : -1}
                                aria-selected={chapterTab === 'diff'}
                                className={`ns-seg-tab${chapterTab === 'diff' ? ' ns-active' : ''}`}
                                onClick={() => setChapterTab('diff')}
                            >
                                改动对比
                            </button>
                        </div>

                        <div className="ns-header-right">
                            <button
                                type="button"
                                className={`ns-pipeline-toggle-btn${stageDrawerOpen ? ' ns-open' : ''}`}
                                aria-expanded={stageDrawerOpen}
                                onClick={() => setStageDrawerOpen((prev) => !prev)}
                            >
                                <span className="ns-lamp-group" aria-hidden="true">
                                    {PIPELINE_STAGES.map((stage) => (
                                        <i
                                            key={stage.id}
                                            className={`ns-lamp ${getLampStatusClass(stageMap[stage.id].status)}`}
                                        />
                                    ))}
                                </span>
                                <span>{pipelineButtonLabel}</span>
                                {stageDrawerOpen ? StudioIcons.chevUp : StudioIcons.chev}
                            </button>

                            <button
                                type="button"
                                className={`ns-btn${isEditing ? ' ns-btn-subtle' : ''}`}
                                disabled={savingEdit}
                                onClick={() => {
                                    if (isEditing) {
                                        handleCancelEditing();
                                    } else {
                                        handleStartEditing();
                                    }
                                }}
                            >
                                {StudioIcons.edit}
                                <span>{isEditing ? '退出编辑' : '直接改稿'}</span>
                            </button>
                        </div>
                    </div>

                    {stageDrawerOpen ? (
                        <section className="ns-pipeline-drawer" aria-label="6 步 Agent 工序与模型矩阵">
                            {PIPELINE_STAGES.map((stage) => {
                                const nodeState = stageMap[stage.id];
                                const effectiveModel = resolveStageModelLabel(stage);
                                const isRunningLive =
                                    nodeState.status === 'active' || nodeState.status === 'healing';
                                const isSelected = inspectedStageId === stage.id;
                                return (
                                    <button
                                        key={stage.id}
                                        type="button"
                                        className={`ns-pipe-card${isSelected ? ' ns-selected' : ''}${
                                            isRunningLive ? ' ns-running-live' : ''
                                        }`}
                                        data-stage-id={stage.id}
                                        data-session-id={nodeState.sessionId ?? ''}
                                        onClick={() => handleInspectStep(stage)}
                                        title={`点击查看 ${stage.label} 思考过程`}
                                    >
                                        <div className="ns-pipe-card-top">
                                            <span className="ns-pipe-step-name">
                                                <i
                                                    className={`ns-lamp ${getLampStatusClass(nodeState.status)}`}
                                                    aria-hidden="true"
                                                />
                                                <span>{stage.label}</span>
                                            </span>
                                            <span className="ns-pipe-step-state">
                                                {getStageStatusText(nodeState.status)}
                                            </span>
                                        </div>
                                        <div className="ns-pipe-live-note">
                                            {nodeState.summary ?? stage.shortDesc}
                                        </div>
                                        <div className="ns-pipe-model-tag">{effectiveModel}</div>
                                    </button>
                                );
                            })}
                        </section>
                    ) : null}
                </div>
            ) : null}

            {actionMessage || actionError ? (
                <div className={`ns-feedback-bar ${actionError ? 'ns-feedback-err' : 'ns-feedback-ok'}`}>
                    <span>{actionError ?? actionMessage}</span>
                    <button
                        type="button"
                        className="ns-btn ns-btn-xs"
                        onClick={() => {
                            setActionMessage(null);
                            setActionError(null);
                        }}
                    >
                        ×
                    </button>
                </div>
            ) : null}

            {/* 舞台滚动画布 */}
            <div
                ref={scrollerRef}
                className="ns-stage-scroll"
                id="ns-chapter-panel"
                role="tabpanel"
                aria-labelledby={
                    mainSurface === 'chapter' ? `ns-tab-${chapterTab}` : undefined
                }
                tabIndex={0}
            >
                {/* 暂存未保存草稿温和恢复条（Q5） */}
                {stashedDraft && !isEditing && mainSurface === 'chapter' ? (
                    <div className="ns-stash-restore-bar" role="status">
                        <span>检测到第 {stashedDraft.chapterNumber} 章有你刚才暂存的未保存手改草稿</span>
                        <div className="ns-header-right">
                            <button
                                type="button"
                                className="ns-btn ns-btn-warn ns-btn-xs"
                                onClick={() => {
                                    setMainSurface('chapter');
                                    onCloseCodex?.();
                                    setChapterTab('prose');
                                    setDraftBaseline(chapterDetail?.content ?? '');
                                    setDraftContent(stashedDraft.content);
                                    setIsEditing(true);
                                    onRestoreStashedDraft?.(stashedDraft);
                                }}
                            >
                                继续改稿
                            </button>
                            <button
                                type="button"
                                className="ns-btn ns-btn-xs"
                                onClick={() =>
                                    onDiscardStashedDraft?.(
                                        stashedDraft.bookRoot,
                                        stashedDraft.chapterNumber
                                    )
                                }
                            >
                                放弃暂存
                            </button>
                        </div>
                    </div>
                ) : null}

                {/* 双模式设定冲突裁决卡 */}
                {mainSurface === 'chapter' && (syncConflict || safeHalt) ? (
                    <ConflictVerdictCard
                        safeHalt={safeHalt}
                        syncConflict={syncConflict}
                        gateViolations={gateViolations}
                        isBusy={isBusy}
                        healing={healingConflict}
                        onHealConflicts={() => {
                            setHealingConflict(true);
                            void Promise.resolve(onHealConflicts?.()).finally(() => {
                                setHealingConflict(false);
                            });
                        }}
                        onEditChapter={handleStartEditing}
                        onRetryWithNote={(correctionText) => {
                            void handleSignalAction({
                                kind: 'RETCON',
                                content: correctionText,
                                runAfter: true
                            });
                        }}
                        onFocusNoteDock={handleFocusNoteDock}
                    />
                ) : null}

                {mainSurface === 'codex' ? (
                    <CodexView
                        bookTitle={displayBookTitle}
                        hasChapters={hasChapterContent}
                        activeChapterNumber={activeChapterNumber}
                        activeTab={codexTab}
                        entities={materializedViews?.entities ?? []}
                        coldArchiveCount={materializedViews?.coldArchiveCount ?? 0}
                        horizonMarkdown={materializedViews?.horizonMarkdown}
                        threadsMarkdown={materializedViews?.threadsMarkdown}
                        onSelectTab={(tab) => {
                            setCodexTab(tab);
                            onCodexTabChange?.(tab);
                        }}
                        onBackToProse={() =>
                            runWithViewTransition(() => {
                                setMainSurface('chapter');
                                onCloseCodex?.();
                            })
                        }
                    />
                ) : !hasChapterContent ? (
                    <article className="ns-manuscript-sheet ns-cover-sheet" aria-label="新书开卷扉页">
                        <div ref={ribbonRef} className="ns-reading-ribbon" aria-hidden="true" />
                        <div className="ns-cover-badge-row">
                            <span className="ns-cover-seal">开卷</span>
                            <span className="ns-badge ns-badge-neutral">{displayVolumeLabel}</span>
                        </div>
                        <h1>《{displayBookTitle}》</h1>
                        <p className="ns-cover-desc">
                            作者契约与人物初始档案已编译完成，当前停机待命在故事第 {storyDay} 天。点击下方按钮开启第 1 章首章执笔与对话声纹校准，也可先在下方递交导演便签调整开篇走向。
                        </p>
                        <div className="ns-cover-actions">
                            <button
                                type="button"
                                className="ns-btn ns-btn-primary"
                                disabled={isBusy || stepSubmitting}
                                onClick={() => void handleStepOne()}
                            >
                                {StudioIcons.play}
                                <span>写第 1 章（开篇校准）</span>
                            </button>
                            <button
                                type="button"
                                className="ns-btn ns-btn-outline"
                                onClick={() =>
                                    runWithViewTransition(() => {
                                        setMainSurface('codex');
                                        setCodexTab('entities');
                                        onOpenCodex?.('entities');
                                    })
                                }
                            >
                                <span>先核对全书设定集</span>
                            </button>
                        </div>
                    </article>
                ) : chapterTab === 'prose' ? (
                    <article className="ns-manuscript-sheet">
                        <div ref={ribbonRef} className="ns-reading-ribbon" aria-hidden="true" />
                        <header className="ns-editorial-masthead">
                            <div className="ns-editorial-numeral">
                                {String(Math.max(0, activeChapterNumber)).padStart(2, '0')}
                            </div>
                            <div>
                                <h1>{activeChapterTitle}</h1>
                                <div className="ns-ch-meta-line">
                                    <span className="ns-num">
                                        {displayVolumeLabel} · 故事第 {storyDay} 天 ·{' '}
                                        {proseCharCount > 0
                                            ? `${proseCharCount.toLocaleString('zh-CN')} 字`
                                            : '暂无正文内容'}
                                    </span>
                                    <span
                                        className={`ns-badge ${
                                            isChapterDirty ? 'ns-badge-warn' : 'ns-badge-ok'
                                        }`}
                                    >
                                        {isChapterDirty ? '待同步修改' : '已定稿'}
                                    </span>
                                </div>
                            </div>
                        </header>

                        {showPatchColophon ? (
                            <div className="ns-patch-colophon-bar">
                                <span>
                                    校勘记录：本章成稿时已自动润色
                                    {patchedViolationCount > 0
                                        ? `消除 ${patchedViolationCount} 处高频套话`
                                        : '完成局部门禁修补'}
                                </span>
                                <button type="button" onClick={handleOpenPatchTrace}>
                                    查看润色思考过程 →
                                </button>
                            </div>
                        ) : null}

                        {isEditing ? (
                            <div className="ns-editor-wrap">
                                <textarea
                                    className="ns-editor-textarea"
                                    value={draftContent}
                                    onChange={(e) => setDraftContent(e.target.value)}
                                    rows={20}
                                    placeholder="在此直接修订本章正文…"
                                />
                                <div className="ns-editor-footer">
                                    <span className="ns-muted">
                                        {isDraftDirty
                                            ? '有未保存修改 · 切章或切书会自动暂存草稿'
                                            : '保存后将写入原稿真源并自动同步人物与伏笔台账'}
                                    </span>
                                    <div className="ns-header-right">
                                        <button
                                            type="button"
                                            className="ns-btn ns-btn-outline"
                                            disabled={savingEdit}
                                            onClick={handleCancelEditing}
                                        >
                                            取消
                                        </button>
                                        <button
                                            type="button"
                                            className="ns-btn ns-btn-primary"
                                            disabled={savingEdit || isBusy}
                                            onClick={() => void handleSaveEditedChapter()}
                                        >
                                            {savingEdit ? '正在保存并同步…' : '保存并自动同步'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : chapterLoading && proseParagraphs.length === 0 ? (
                            <div className="ns-prose-skel" role="status" aria-label="正文加载中">
                                {Array.from({ length: 6 }, (_, idx) => (
                                    <span
                                        key={idx}
                                        className={`ns-skel ns-skel-line${
                                            idx % 3 === 2 ? ' ns-skel-line-short' : ''
                                        }`}
                                    />
                                ))}
                            </div>
                        ) : proseParagraphs.length > 0 ? (
                            <>
                                <div ref={proseBodyRef} className="ns-prose-body ns-prose">
                                    {proseParagraphs.map((para, idx) =>
                                        para.isBreak ? (
                                            <p key={idx} className="ns-brk">
                                                · · ·
                                            </p>
                                        ) : (
                                            <div key={idx} className="ns-prose-para-wrap">
                                                <span className="ns-prose-folio">
                                                    P{String(idx + 1).padStart(2, '0')}
                                                </span>
                                                <p
                                                    className={
                                                        conflictTargetLine === idx + 1
                                                            ? 'ns-conflict-highlight'
                                                            : undefined
                                                    }
                                                >
                                                    {para.text}
                                                </p>
                                            </div>
                                        )
                                    )}
                                </div>

                                {!isChapterDirty ? (
                                    <div className="ns-editorial-endmark">
                                        <div
                                            className={`ns-seal-stamp${
                                                sealJustStamped ? ' ns-stamping' : ''
                                            }`}
                                        >
                                            定稿
                                        </div>
                                        <span className="ns-mono ns-muted">
                                            {commitDisplay
                                                ? `commit ${commitDisplay} · 双门禁核验入库`
                                                : '双门禁核验入库'}
                                        </span>
                                    </div>
                                ) : (
                                    <div className="ns-editorial-endmark">
                                        <span className="ns-badge ns-badge-warn">
                                            本章含未同步手改 · 点击顶部「同步修改」更新人物台账后重新盖印
                                        </span>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="ns-muted">
                                当前章节尚无正文内容，请点击右上角「写下一章」或切换其他历史章节。
                            </div>
                        )}

                        {!isEditing && (prevChapterSummary || nextChapterSummary) ? (
                            <nav className="ns-chap-nav" aria-label="上下章快捷导航">
                                {prevChapterSummary ? (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-outline"
                                        onClick={() =>
                                            onSelectChapter?.(prevChapterSummary.chapterNumber)
                                        }
                                    >
                                        上一章 · {prevChapterSummary.title}
                                    </button>
                                ) : (
                                    <span />
                                )}
                                {nextChapterSummary ? (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-outline"
                                        onClick={() =>
                                            onSelectChapter?.(nextChapterSummary.chapterNumber)
                                        }
                                    >
                                        下一章 · {nextChapterSummary.title}
                                    </button>
                                ) : (
                                    <span />
                                )}
                            </nav>
                        ) : null}
                    </article>
                ) : chapterTab === 'plan' ? (
                    <section className="ns-manuscript-sheet">
                        <div ref={ribbonRef} className="ns-reading-ribbon" aria-hidden="true" />
                        {parsedPlan ? (
                            <>
                                <header className="ns-plan-head">
                                    <h2 className="ns-plan-title">
                                        第 {activeChapterNumber} 章 · {parsedPlan.chapterTitle}
                                    </h2>
                                    <div className="ns-plan-meta">
                                        <span className="ns-plan-pill">
                                            timeline_mode <b>{parsedPlan.timelineMode ?? '未提供'}</b>
                                        </span>
                                        <span className="ns-plan-pill">
                                            pov <b>{parsedPlan.povCharacter ?? '未提供'}</b>
                                        </span>
                                        <span className="ns-plan-pill">
                                            target{' '}
                                            <b>
                                                {parsedPlan.targetWordCount
                                                    ? `${parsedPlan.targetWordCount.toLocaleString('zh-CN')} 字`
                                                    : '自适应'}
                                            </b>
                                        </span>
                                        <span className="ns-plan-pill">
                                            ending <b>{parsedPlan.endingBeat}</b>
                                        </span>
                                    </div>
                                </header>

                                <div>
                                    <div className="ns-beats">
                                        {parsedPlan.beats.map((beat, idx) => (
                                            <div
                                                key={`${beat.label}-${idx}`}
                                                className={`ns-beat${beat.isSpotlight ? ' eye' : ''}`}
                                                style={{ flex: beat.percent }}
                                                title={`${beat.label} (${beat.percent}%): ${beat.summary}`}
                                            >
                                                <b>
                                                    {beat.label} {beat.percent}%
                                                </b>
                                                <span>{beat.summary}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="ns-beats-cap">
                                        <span>0%</span>
                                        {(() => {
                                            let acc = 0;
                                            return parsedPlan.beats.slice(0, -1).map((beat, idx) => {
                                                acc += beat.percent;
                                                return <span key={idx}>{acc}%</span>;
                                            });
                                        })()}
                                        <span>100%</span>
                                    </div>
                                </div>

                                <dl className="ns-plan-kv">
                                    <dt>
                                        视角
                                        <small>pov_character</small>
                                    </dt>
                                    <dd>
                                        {parsedPlan.povCharacter ? (
                                            <span className="ns-actor-pill">
                                                <i
                                                    className={`ns-actor-avatar ns-avatar-tone-${getAvatarToneIndex(
                                                        parsedPlan.povCharacter
                                                    )}`}
                                                >
                                                    {parsedPlan.povCharacter.slice(0, 1)}
                                                </i>
                                                {parsedPlan.povCharacter}
                                            </span>
                                        ) : (
                                            <span className="ns-muted">未提供</span>
                                        )}
                                    </dd>

                                    <dt>
                                        焦点角色
                                        <small>focus_cast</small>
                                    </dt>
                                    <dd>
                                        {parsedPlan.focusCast.length > 0 ? (
                                            parsedPlan.focusCast.map((actor) => (
                                                <span key={actor} className="ns-actor-pill">
                                                    <i
                                                        className={`ns-actor-avatar ns-avatar-tone-${getAvatarToneIndex(
                                                            actor
                                                        )}`}
                                                    >
                                                        {actor.slice(0, 1)}
                                                    </i>
                                                    {actor}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="ns-muted">本章无</span>
                                        )}
                                    </dd>

                                    <dt>
                                        背景角色
                                        <small>background_cast</small>
                                    </dt>
                                    <dd>
                                        {parsedPlan.backgroundCast.length > 0 ? (
                                            parsedPlan.backgroundCast.map((actor) => (
                                                <span key={actor} className="ns-actor-pill">
                                                    <i
                                                        className={`ns-actor-avatar ns-avatar-tone-${getAvatarToneIndex(
                                                            actor
                                                        )}`}
                                                    >
                                                        {actor.slice(0, 1)}
                                                    </i>
                                                    {actor}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="ns-muted">本章无</span>
                                        )}
                                    </dd>

                                    <dt>
                                        戏眼
                                        <small>spotlight</small>
                                    </dt>
                                    <dd className="ns-plan-prose">{parsedPlan.spotlight}</dd>

                                    <dt>
                                        收尾节拍
                                        <small>ending_beat</small>
                                    </dt>
                                    <dd className="ns-plan-prose ns-plan-ending">
                                        <span className="ns-pill ns-pill-brand ns-mono">
                                            {parsedPlan.endingBeat}
                                        </span>
                                        <span>{parsedPlan.endingSummary}</span>
                                    </dd>

                                    <dt>
                                        细纲正文
                                        <small>outline_text</small>
                                    </dt>
                                    <dd className="ns-plan-prose ns-plan-outline">
                                        {parsedPlan.outlineText}
                                    </dd>
                                </dl>
                            </>
                        ) : (
                            <div className="ns-plan-empty">
                                <h2 className="ns-plan-title ns-plan-title-sm">
                                    第 {activeChapterNumber} 章 ·{' '}
                                    {outlineStatus === 'error'
                                        ? '细纲读取失败'
                                        : chapterDetail
                                          ? '历史章节未留存细纲'
                                          : '细纲暂不可用'}
                                </h2>
                                <p className="ns-plan-empty-hint">
                                    {outlineStatus === 'error'
                                        ? '本章已保存的细纲文件损坏或读取失败，正文仍可正常审阅；可重试只读读取，不会触发生成或同步。'
                                        : chapterDetail
                                          ? '本章生成时未持久化细纲快照，历史细纲无法回看。后续新生成的章节会随正文一并留存细纲。'
                                          : '当前章节详情尚未加载，加载后可查看已留存的细纲。'}
                                </p>
                                {outlineStatus === 'error' && onRetryChapterDetail ? (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-outline"
                                        disabled={chapterLoading}
                                        onClick={onRetryChapterDetail}
                                    >
                                        {chapterLoading ? '正在重试…' : '重试读取细纲'}
                                    </button>
                                ) : null}
                            </div>
                        )}
                    </section>
                ) : (
                    <section className="ns-manuscript-sheet">
                        <div ref={ribbonRef} className="ns-reading-ribbon" aria-hidden="true" />
                        <header className="ns-plan-head">
                            <h2 className="ns-plan-title">改动对比 · {formatChapterLabel(activeChapterNumber)}</h2>
                        </header>
                        {diffHunks.length > 0 ? (
                            diffHunks.map((hunk, hunkIdx) => (
                                <div
                                    key={`${hunk.fileName}-${hunk.header}-${hunkIdx}`}
                                    className="ns-hunk"
                                >
                                    <div className="ns-hunk-head">
                                        <span className="ns-mono ns-hunk-file">{hunk.fileName}</span>
                                        <span className="ns-mono ns-hunk-range">{hunk.header}</span>
                                        <span className="ns-hunk-spacer" />
                                        <span
                                            className={`ns-badge ${
                                                isChapterDirty ? 'ns-badge-warn' : 'ns-badge-ok'
                                            }`}
                                        >
                                            {isChapterDirty ? '人工手改 · 待同步' : '已对齐'}
                                        </span>
                                    </div>
                                    <div>
                                        {hunk.rows.map((row, rowIdx) => (
                                            <div
                                                key={rowIdx}
                                                className={`ns-diff-row${
                                                    row.kind === 'del'
                                                        ? ' ns-diff-row-del'
                                                        : row.kind === 'add'
                                                          ? ' ns-diff-row-add'
                                                          : ''
                                                }`}
                                            >
                                                <span className="ns-diff-ln">{row.lineNumber ?? ''}</span>
                                                <span className="ns-diff-glyph">{row.glyph}</span>
                                                <span className="ns-diff-text">{row.text || ' '}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="ns-hunk-foot">
                                        <span>
                                            新增 +{hunk.addCount} / 删除 -{hunk.delCount} 行
                                        </span>
                                        <button
                                            type="button"
                                            className="ns-btn ns-btn-outline ns-btn-xs"
                                            disabled={isBusy || syncingFromDiff}
                                            onClick={() => {
                                                setSyncingFromDiff(true);
                                                void Promise.resolve(handleSync()).finally(() => {
                                                    setSyncingFromDiff(false);
                                                });
                                            }}
                                        >
                                            {activeTask === 'SYNCING' || syncingFromDiff
                                                ? '正在同步…'
                                                : '立即同步修改'}
                                        </button>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="ns-diff-clean">
                                <div className="ns-diff-clean-head">
                                    <span className="ns-badge ns-badge-ok">正文与版本库一致 · 无未同步差异</span>
                                    <span className="ns-mono ns-diff-clean-file">{chapterFileName}</span>
                                </div>
                                <div className="ns-diff-clean-text">
                                    当前章节正文已与定稿版本对齐，无待同步的人工手改。
                                </div>
                                <div className="ns-mono ns-diff-clean-meta">
                                    <span>状态: {walPhase}</span>
                                    {featHash ? <span> · feat {featHash}</span> : null}
                                    {stateHash ? <span> · state {stateHash}</span> : null}
                                    {chapterDetail?.sha256 ? (
                                        <span> · sha256 {chapterDetail.sha256.slice(0, 12)}</span>
                                    ) : null}
                                </div>
                            </div>
                        )}
                    </section>
                )}
            </div>

            {mainSurface === 'chapter' ? (
                <DirectorNoteDock
                    nextChapterOptions={nextChapterOptions}
                    pendingSignals={pendingSignals}
                    entities={materializedViews?.entities ?? []}
                    isBusy={isBusy}
                    submittingSignal={submittingSignal}
                    noteKind={noteKind}
                    noteText={noteText}
                    spotlightEntityId={spotlightEntityId}
                    flashbackDay={flashbackDay}
                    inputRef={signalInputRef}
                    onChangeNoteKind={setNoteKind}
                    onChangeNoteText={setNoteText}
                    onChangeSpotlightEntityId={setSpotlightEntityId}
                    onChangeFlashbackDay={setFlashbackDay}
                    onSubmitSignal={handleSignalAction}
                    onStepWithOption={(goal) =>
                        handleStepOne(goal ? { chapterGoal: goal } : undefined)
                    }
                    onDismissSignal={onDismissSignal}
                />
            ) : null}

            <Modal
                open={discardConfirmOpen}
                onClose={() => setDiscardConfirmOpen(false)}
                title="放弃未保存的修改？"
                description={`第 ${activeChapterNumber} 章的编辑尚未保存，退出编辑将丢弃当前改动；已提交的手稿不受影响。`}
                closeLabel="继续改稿"
                className="ns-b-modal-shell ns-guard-modal-shell"
                contentClassName="ns-b-modal-content ns-guard-modal-content"
            >
                <div className="ns-guard-actions">
                    <button
                        type="button"
                        className="ns-btn ns-btn-outline"
                        data-modal-autofocus=""
                        onClick={() => setDiscardConfirmOpen(false)}
                    >
                        继续改稿
                    </button>
                    <button
                        type="button"
                        className="ns-btn ns-btn-danger"
                        onClick={() => {
                            setDiscardConfirmOpen(false);
                            setDraftBaseline(null);
                            setIsEditing(false);
                            setDraftContent(chapterDetail?.content ?? '');
                        }}
                    >
                        放弃修改
                    </button>
                </div>
            </Modal>
        </main>
    );
};

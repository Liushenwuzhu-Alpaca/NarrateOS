import React, { useEffect, useMemo, useState } from 'react';

/** 6 阶段流水线节点 ID */
export type PipelineStageId =
    | 'LIBRARIAN'
    | 'PLANNER'
    | 'WRITER'
    | 'PROSE_GATE'
    | 'FACT_CHECKER'
    | 'EXTRACTOR';

/** 单个流水线节点状态 */
export type StageNodeStatus = 'idle' | 'active' | 'done' | 'healing' | 'halt';

/** 流水线节点运行态信息 */
export interface StageNodeState {
    status: StageNodeStatus;
    summary?: string | undefined;
    inputSummary?: string | undefined;
    outputSummary?: string | undefined;
    updatedAt?: string | undefined;
}

/** 主内容区视图页签 */
export type CenterViewTab = 'prose' | 'plan' | 'diff' | 'views';

/** 物化视图子类型 */
export type MaterializedViewKind = 'entities' | 'horizon' | 'threads';

/** 导演一次性信号下拉类型 */
export type DirectorSignalKind = '导演指令' | 'FLASHBACK' | 'PARALLEL' | 'Retcon' | '文风修订';

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
    outlineText?: string | undefined;
    volumeLabel?: string | undefined;
    featCommitSha?: string | undefined;
    stateCommitSha?: string | undefined;
    consumedSignal?: string | undefined;
}

/** SAFE_HALT 告警信息 (.ops/safe_halt.json) */
export interface SafeHaltInfo {
    reason: string;
    stage?: string | undefined;
    chapter?: number | undefined;
    conflictId?: string | undefined;
    affectedChapters?: number | undefined;
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
    completedChapters: number;
    targetChapters: number;
    currentStage?: string | null | undefined;
}

/** 投递信号回调参数 */
export interface SubmitSignalPayload {
    kind: DirectorSignalKind;
    content: string;
    runAfter: boolean;
}

/** 外部触发中栏页签切换的命令 */
export interface ExternalViewCommand {
    viewTab: CenterViewTab;
    materialKind?: MaterializedViewKind | undefined;
    nonce: number;
}

/** CenterWorkbench 组件 Props */
export interface CenterWorkbenchProps {
    bookTitle?: string | undefined;
    bookSlug?: string | undefined;
    currentChapter: number;
    selectedChapter?: number | undefined;
    timelineMode?: string | undefined;
    walPhase?: string | undefined;
    activeTask?: 'IDLE' | 'STEPPING' | 'SYNCING' | 'DREAMING' | 'BOOTING' | undefined;
    yolo?: YoloStatusData | undefined;
    chapters?: ChapterSummaryItem[] | undefined;
    chapterDetail?: ChapterDetailData | null | undefined;
    stages?: Partial<Record<PipelineStageId, StageNodeState>> | undefined;
    latestSseStage?: string | null | undefined;
    safeHalt?: SafeHaltInfo | null | undefined;
    pendingSignals?: PendingSignalItem[] | undefined;
    pendingSignalsCount?: number | undefined;
    materializedViews?: MaterializedViewsData | undefined;
    dirtyChaptersCount?: number | undefined;
    lastConsumedSignal?: string | undefined;
    externalViewCommand?: ExternalViewCommand | undefined;
    onSelectChapter?: ((chapterNumber: number) => void) | undefined;
    onStepOne?: (() => Promise<void> | void) | undefined;
    onStartYolo?: ((targetChapters: number) => Promise<void> | void) | undefined;
    onStopYolo?: (() => Promise<void> | void) | undefined;
    onSync?: (() => Promise<void> | void) | undefined;
    onDream?: (() => Promise<void> | void) | undefined;
    onSaveChapter?: ((chapterNumber: number, content: string) => Promise<void> | void) | undefined;
    onSubmitSignal?: ((payload: SubmitSignalPayload) => Promise<void> | void) | undefined;
    onRefreshViews?: (() => Promise<void> | void) | undefined;
}

interface StageDefinition {
    id: PipelineStageId;
    label: string;
    shortDesc: string;
    defaultInput: string;
    defaultOutput: string;
}

const PIPELINE_STAGES: readonly StageDefinition[] = [
    {
        id: 'LIBRARIAN',
        label: '1. Librarian',
        shortDesc: '检索选页',
        defaultInput: '读取 L0-L2 目录索引、活跃实体列表与待收束伏笔。',
        defaultOutput: '筛选本场焦点实体卡、历史原稿切片查询条件与声纹样本。'
    },
    {
        id: 'PLANNER',
        label: '2. Planner',
        shortDesc: '导演细纲',
        defaultInput: '接收 Librarian 上下文、时间线模式与一次性导演信号。',
        defaultOutput: '输出结构化章节细纲（戏眼、焦点角色、收尾节拍）。'
    },
    {
        id: 'WRITER',
        label: '3. Writer',
        shortDesc: '净室执笔',
        defaultInput: '净室窗口（静态前缀 + 动态尾 + 剥离后 POV 补集卡）。',
        defaultOutput: '单轮流式直出本章正文草稿（无历史会话污染）。'
    },
    {
        id: 'PROSE_GATE',
        label: '4. Static Gate',
        shortDesc: '静态门禁',
        defaultInput: '正文草稿 + 可配文风门禁规则（微距/八股/跨章喻体复读）。',
        defaultOutput: '通过校验或触发局部 Patch 返修，输出清洁正文。'
    },
    {
        id: 'FACT_CHECKER',
        label: '5. Fact Checker',
        shortDesc: '异构核查',
        defaultInput: '最新单章正文 + 实体固有属性锁 + 物理/时间线红线。',
        defaultOutput: '双侧原句去标点验真，通过或触发 Rewrite / Replan 自愈。'
    },
    {
        id: 'EXTRACTOR',
        label: '6. Extractor & WAL',
        shortDesc: '提态入库',
        defaultInput: '已核查定稿正文 + 当前世界状态快照。',
        defaultOutput: '提取实体行级补丁、L2 章卡并原子提交 Git WAL (feat -> state)。'
    }
];

const STAGE_ORDER: readonly PipelineStageId[] = PIPELINE_STAGES.map((s) => s.id);

const DIRECTOR_SIGNAL_OPTIONS: ReadonlyArray<{ value: DirectorSignalKind; label: string }> = [
    { value: '导演指令', label: '导演指令（下章剧情 / 视角）' },
    { value: 'FLASHBACK', label: 'FLASHBACK（插叙回溯）' },
    { value: 'PARALLEL', label: 'PARALLEL（并行支线）' },
    { value: 'Retcon', label: 'Retcon（圆谎纸条）' },
    { value: '文风修订', label: '文风修订（局部风格微调）' }
];

const YOLO_PRESETS: ReadonlyArray<{ targetChapters: number; label: string; desc: string }> = [
    { targetChapters: 3, label: '连跑 3 章', desc: '推进 3 章后在安全点停下' },
    { targetChapters: 5, label: '连跑 5 章', desc: '推进 5 章后在安全点停下' },
    { targetChapters: 0, label: '持续直到停机', desc: '无章数上限，遇 SAFE_HALT 或手动停止才停' }
];

const PROSE_FONT_SIZES: readonly number[] = [15, 17, 19];

/** 将章节正文拆分为阅读段落（识别场景分隔符） */
function splitProseParagraphs(content: string): Array<{ text: string; isBreak: boolean }> {
    if (!content.trim()) return [];
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => ({
            text: line,
            isBreak: /^([-*_·]\s*){3,}$/.test(line)
        }));
}

/**
 * 根据 SSE 推送的 EngineStageName 字符串推导 6 个节点的默认状态
 */
function deriveStagesFromSse(
    sseStage: string | null | undefined,
    overrides?: Partial<Record<PipelineStageId, StageNodeState>>
): Record<PipelineStageId, StageNodeState> {
    const base: Record<PipelineStageId, StageNodeState> = {
        LIBRARIAN: { status: 'idle' },
        PLANNER: { status: 'idle' },
        WRITER: { status: 'idle' },
        PROSE_GATE: { status: 'idle' },
        FACT_CHECKER: { status: 'idle' },
        EXTRACTOR: { status: 'idle' }
    };

    if (sseStage) {
        if (sseStage === 'COMMITTED') {
            for (const id of STAGE_ORDER) {
                base[id] = { status: 'done', summary: '已完成并提交 WAL' };
            }
        } else if (sseStage === 'SAFE_HALT') {
            base.FACT_CHECKER = { status: 'halt', summary: '触发 SAFE_HALT 停机保护' };
        } else if (sseStage === 'LOCAL_PATCH') {
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'done' };
            base.WRITER = { status: 'done' };
            base.PROSE_GATE = { status: 'healing', summary: '门禁拦截，正在局部 Patch 自愈' };
        } else if (sseStage === 'REWRITE') {
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'done' };
            base.WRITER = { status: 'healing', summary: '核查打回，正在局部重写自愈' };
            base.PROSE_GATE = { status: 'done' };
            base.FACT_CHECKER = { status: 'healing', summary: '发现穿帮，触发 Rewrite' };
        } else if (sseStage === 'REPLAN') {
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'healing', summary: '触发 Replan 重排细纲' };
            base.FACT_CHECKER = { status: 'healing', summary: '要求重规划细纲' };
        } else {
            const activeIndex = STAGE_ORDER.indexOf(sseStage as PipelineStageId);
            if (activeIndex >= 0) {
                for (let i = 0; i < STAGE_ORDER.length; i++) {
                    const id = STAGE_ORDER[i];
                    if (!id) continue;
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

/** 将节点状态映射为中文徽章文案与样式后缀 */
function getStageStatusMeta(status: StageNodeStatus): { text: string; badgeClass: string } {
    switch (status) {
        case 'active':
            return { text: '运行中', badgeClass: 'ns-badge-brand' };
        case 'done':
            return { text: '通过', badgeClass: 'ns-badge-green' };
        case 'healing':
            return { text: '告警自愈', badgeClass: 'ns-badge-amber' };
        case 'halt':
            return { text: '停机', badgeClass: 'ns-badge-red' };
        case 'idle':
        default:
            return { text: '待命', badgeClass: 'ns-badge-muted' };
    }
}

/** 格式化章节号为 4 位补零展示 */
function formatChapterLabel(chapterNumber: number): string {
    return `Ch.${String(Math.max(0, chapterNumber)).padStart(4, '0')}`;
}

/** 将前端导演下拉类型转换为后端 OpsSignalSchema 兼容格式 */
function buildOpsSignalPayload(
    kind: DirectorSignalKind,
    content: string,
    chapter: number
): Record<string, unknown> {
    const trimmed = content.trim();
    const isRetcon = kind === 'Retcon';
    const base: Record<string, unknown> = {
        type: isRetcon ? 'RETCON' : 'SPOTLIGHT_TRIGGER',
        chapter: Math.max(0, chapter),
        reason: `[${kind}] ${trimmed}`,
        created_at: new Date().toISOString()
    };

    if (kind === 'PARALLEL') {
        base['suggested_mode'] = 'PARALLEL';
    } else if (kind === '导演指令') {
        base['suggested_mode'] = 'MAINLINE';
    }

    return base;
}

/**
 * NarrateOS 中栏工作台组件：
 * - 顶部控制条（单步推进、YOLO 拆分下拉、安全点停止、Sync、Dreaming）
 * - SAFE_HALT 高亮告警条
 * - 6 阶段水平流水线图 + 可折叠节点检查条
 * - 正文阅读 / 本章细纲 / 手改 Diff / 物化视图（只读）+ 在线编辑保存 Sync
 * - 底部导演一次性干涉栏
 */
export const CenterWorkbench: React.FC<CenterWorkbenchProps> = ({
    bookTitle,
    bookSlug,
    currentChapter,
    selectedChapter,
    timelineMode = 'MAINLINE',
    walPhase = 'STATE_COMMITTED',
    activeTask = 'IDLE',
    yolo,
    chapters = [],
    chapterDetail,
    stages,
    latestSseStage,
    safeHalt,
    pendingSignals = [],
    pendingSignalsCount,
    materializedViews,
    dirtyChaptersCount = 0,
    lastConsumedSignal,
    externalViewCommand,
    onSelectChapter,
    onStepOne,
    onStartYolo,
    onStopYolo,
    onSync,
    onDream,
    onSaveChapter,
    onSubmitSignal,
    onRefreshViews
}) => {
    const activeChapterNumber = selectedChapter ?? chapterDetail?.chapterNumber ?? currentChapter;
    const isYoloRunning = Boolean(yolo?.running);
    const isBusy = activeTask !== 'IDLE' || isYoloRunning;

    // 顶部 YOLO 拆分下拉菜单开关
    const [yoloMenuOpen, setYoloMenuOpen] = useState(false);

    // 6 阶段流水线选中的检查节点（null 表示折叠检查条）
    const [inspectedStageId, setInspectedStageId] = useState<PipelineStageId | null>('WRITER');

    // 主视图页签 & 只读物化视图子页签
    const [viewTab, setViewTab] = useState<CenterViewTab>('prose');
    const [materialKind, setMaterialKind] = useState<MaterializedViewKind>('entities');

    // 响应外部（左栏物化视图导航）联动切换页签与子标签
    useEffect(() => {
        if (!externalViewCommand) return;
        setViewTab(externalViewCommand.viewTab);
        if (externalViewCommand.materialKind) {
            setMaterialKind(externalViewCommand.materialKind);
        }
    }, [externalViewCommand]);

    // 正文阅读字号档位（15 / 17 / 19px）
    const [fontStep, setFontStep] = useState(1);

    // 在线编辑模式
    const [isEditing, setIsEditing] = useState(false);
    const [draftContent, setDraftContent] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);

    // 底部导演一次性干涉栏输入态
    const [signalKind, setSignalKind] = useState<DirectorSignalKind>('导演指令');
    const [signalInput, setSignalInput] = useState('');
    const [submittingSignal, setSubmittingSignal] = useState(false);

    // 局部操作反馈提示
    const [actionMessage, setActionMessage] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // 切换章节或章节内容刷新时同步编辑区草稿
    useEffect(() => {
        setDraftContent(chapterDetail?.content ?? '');
        setIsEditing(false);
    }, [chapterDetail?.chapterNumber, chapterDetail?.content]);

    const stageMap = useMemo(
        () => deriveStagesFromSse(latestSseStage, stages),
        [latestSseStage, stages]
    );

    const inspectedStageDef = useMemo(
        () => PIPELINE_STAGES.find((item) => item.id === inspectedStageId) ?? null,
        [inspectedStageId]
    );

    const effectiveSignalsCount = pendingSignalsCount ?? pendingSignals.length;

    const showFeedback = (msg: string) => {
        setActionError(null);
        setActionMessage(msg);
    };

    const showError = (err: unknown) => {
        setActionMessage(null);
        setActionError(err instanceof Error ? err.message : String(err));
    };

    /** 触发单步推进 1 章 */
    const handleStepOne = async () => {
        setYoloMenuOpen(false);
        try {
            if (onStepOne) {
                await onStepOne();
            } else {
                const resp = await fetch('/api/narrate/step', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chapterGoal: '按既定主线与人物弧光自然推进下一章'
                    })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `单步推进失败 (${resp.status})`);
                }
            }
            showFeedback('已发起单步推进 1 章');
        } catch (err) {
            showError(err);
        }
    };

    /** 触发 YOLO 连跑 */
    const handleStartYolo = async (targetChapters: number) => {
        setYoloMenuOpen(false);
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
                    throw new Error(errBody.error ?? `启动 YOLO 连跑失败 (${resp.status})`);
                }
            }
            showFeedback(
                targetChapters === 0
                    ? '已开启 YOLO 持续连跑（遇安全点或人工停止为止）'
                    : `已开启 YOLO 连跑 ${targetChapters} 章`
            );
        } catch (err) {
            showError(err);
        }
    };

    /** 触发安全点停止 */
    const handleStopYolo = async () => {
        try {
            if (onStopYolo) {
                await onStopYolo();
            } else {
                const resp = await fetch('/api/narrate/yolo/stop', { method: 'POST' });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `发送安全点停止失败 (${resp.status})`);
                }
            }
            showFeedback('已请求安全点停止，将在当前事务提交后停下');
        } catch (err) {
            showError(err);
        }
    };

    /** 触发手动 Sync */
    const handleSync = async () => {
        try {
            if (onSync) {
                await onSync();
            } else {
                const resp = await fetch('/api/narrate/sync', { method: 'POST' });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `手动 Sync 失败 (${resp.status})`);
                }
            }
            showFeedback('已完成手改差异扫描与状态 Sync');
        } catch (err) {
            showError(err);
        }
    };

    /** 触发手动 Dreaming */
    const handleDream = async () => {
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
                    throw new Error(errBody.error ?? `手动 Dreaming 失败 (${resp.status})`);
                }
            }
            showFeedback('已触发睡眠 VACUUM 与连续性整理');
        } catch (err) {
            showError(err);
        }
    };

    /** 保存直接编辑的正文并自动 Sync */
    const handleSaveEditedChapter = async () => {
        if (!activeChapterNumber || activeChapterNumber <= 0) {
            showError('当前没有可保存的有效章节号');
            return;
        }
        setSavingEdit(true);
        try {
            if (onSaveChapter) {
                await onSaveChapter(activeChapterNumber, draftContent);
            } else {
                const resp = await fetch('/api/narrate/chapter', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chapterNumber: activeChapterNumber,
                        content: draftContent
                    })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `保存并 Sync 失败 (${resp.status})`);
                }
            }
            setIsEditing(false);
            showFeedback(`已保存 ${formatChapterLabel(activeChapterNumber)} 并自动完成 Sync`);
        } catch (err) {
            showError(err);
        } finally {
            setSavingEdit(false);
        }
    };

    /** 提交一次性导演信号（支持投入队列或入队并推进） */
    const handleSignalAction = async (runAfter: boolean) => {
        const trimmed = signalInput.trim();
        if (!trimmed) {
            if (runAfter) {
                await handleStepOne();
            }
            return;
        }

        setSubmittingSignal(true);
        try {
            if (onSubmitSignal) {
                await onSubmitSignal({ kind: signalKind, content: trimmed, runAfter });
            } else {
                const payload = buildOpsSignalPayload(signalKind, trimmed, currentChapter);
                const resp = await fetch('/api/narrate/signals', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `投递信号失败 (${resp.status})`);
                }
                if (runAfter) {
                    await handleStepOne();
                }
            }
            setSignalInput('');
            showFeedback(
                runAfter
                    ? '信号已写入 .ops/signals.jsonl 并触发推进'
                    : '信号已投入 .ops/signals.jsonl 队列（安全点消费即焚）'
            );
        } catch (err) {
            showError(err);
        } finally {
            setSubmittingSignal(false);
        }
    };

    /** 切换至历史章节 */
    const handleChapterChange = (nextChapter: number) => {
        if (onSelectChapter) {
            onSelectChapter(nextChapter);
        }
    };

    const yoloProgressText = yolo
        ? yolo.targetChapters > 0
            ? `YOLO 连跑 ${yolo.completedChapters}/${yolo.targetChapters} 章`
            : `YOLO 持续连跑中 · 已完成 ${yolo.completedChapters} 章`
        : '';

    const diffLines = useMemo(() => {
        const raw = chapterDetail?.diffFromHead ?? '';
        return raw ? raw.split(/\r?\n/) : [];
    }, [chapterDetail?.diffFromHead]);

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

    const isChapterDirty = Boolean(chapterDetail?.dirty ?? activeChapterSummary?.dirty);
    const proseContent = chapterDetail?.content ?? '';
    const proseCharCount = useMemo(
        () => proseContent.replace(/\s+/g, '').length,
        [proseContent]
    );
    const proseParagraphs = useMemo(
        () => splitProseParagraphs(proseContent),
        [proseContent]
    );
    const featHash =
        chapterDetail?.featCommitSha?.slice(0, 7) ??
        activeChapterSummary?.commitSha?.slice(0, 7) ??
        undefined;
    const stateHash = chapterDetail?.stateCommitSha?.slice(0, 7) ?? undefined;
    const consumedSignalText = chapterDetail?.consumedSignal ?? lastConsumedSignal;
    const currentFontSize = PROSE_FONT_SIZES[fontStep] ?? 17;

    return (
        <main className="ns-center-workbench">
            {/* 顶部控制条 */}
            <header className="ns-topbar">
                <div className="ns-top-left">
                    <strong className="ns-chapter-badge">
                        {formatChapterLabel(activeChapterNumber)}
                    </strong>
                    {bookTitle ? <span className="ns-book-name">{bookTitle}</span> : null}
                    {bookSlug ? <span className="ns-mono ns-muted">({bookSlug})</span> : null}
                    <span className="ns-pill ns-pill-brand">{timelineMode}</span>
                    <span className="ns-pill ns-pill-muted ns-mono">{walPhase}</span>
                    {activeTask !== 'IDLE' ? (
                        <span className="ns-pill ns-pill-amber">{activeTask}</span>
                    ) : null}
                </div>

                <div className="ns-top-center">
                    {isYoloRunning ? (
                        <div className="ns-yolo-running-bar">
                            <span className="ns-pill ns-pill-brand ns-pulse">
                                {yoloProgressText}
                                {yolo?.currentStage ? ` · ${yolo.currentStage}` : ''}
                            </span>
                            <button
                                type="button"
                                className="ns-btn ns-btn-stop"
                                onClick={handleStopYolo}
                            >
                                安全点停止
                            </button>
                        </div>
                    ) : (
                        <div className="ns-split-btn-wrap">
                            <div className="ns-split-btn">
                                <button
                                    type="button"
                                    className="ns-btn ns-btn-primary"
                                    disabled={isBusy}
                                    onClick={handleStepOne}
                                >
                                    单步推进 1 章
                                </button>
                                <button
                                    type="button"
                                    className="ns-btn ns-btn-yolo"
                                    disabled={isBusy}
                                    aria-expanded={yoloMenuOpen}
                                    onClick={() => setYoloMenuOpen((prev) => !prev)}
                                >
                                    YOLO 连跑 ▾
                                </button>
                            </div>

                            {yoloMenuOpen ? (
                                <div className="ns-popover ns-yolo-popover" role="menu">
                                    <div className="ns-popover-title">选择 YOLO 连跑模式</div>
                                    {YOLO_PRESETS.map((preset) => (
                                        <button
                                            key={preset.targetChapters}
                                            type="button"
                                            className="ns-popover-item"
                                            onClick={() => handleStartYolo(preset.targetChapters)}
                                        >
                                            <span className="ns-popover-item-title">
                                                {preset.label}
                                            </span>
                                            <span className="ns-popover-item-desc">
                                                {preset.desc}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    )}
                </div>

                <div className="ns-top-right">
                    <button
                        type="button"
                        className={`ns-btn ns-btn-ghost ${dirtyChaptersCount > 0 ? 'ns-btn-dirty' : ''}`}
                        disabled={isBusy}
                        onClick={handleSync}
                    >
                        手动 Sync{dirtyChaptersCount > 0 ? ` (${dirtyChaptersCount})` : ''}
                    </button>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost"
                        disabled={isBusy}
                        onClick={handleDream}
                    >
                        手动 Dreaming
                    </button>
                </div>
            </header>

            {/* SAFE_HALT 告警条 (.ops/safe_halt.json) */}
            {safeHalt ? (
                <section className="ns-safe-halt-banner" role="alert">
                    <div className="ns-safe-halt-head">
                        <strong>SAFE_HALT · 运行已安全挂起</strong>
                        {safeHalt.chapter !== undefined ? (
                            <span className="ns-pill ns-pill-red ns-mono">
                                {formatChapterLabel(safeHalt.chapter)}
                            </span>
                        ) : null}
                        {safeHalt.stage ? (
                            <span className="ns-pill ns-pill-muted ns-mono">
                                {safeHalt.stage}
                            </span>
                        ) : null}
                    </div>
                    <div className="ns-safe-halt-reason">{safeHalt.reason}</div>
                    {safeHalt.details ? (
                        <div className="ns-safe-halt-details ns-mono">{safeHalt.details}</div>
                    ) : null}
                </section>
            ) : null}

            {/* 6 阶段流水线图 */}
            <section className="ns-stage-strip">
                <div className="ns-stage-head">
                    <span>
                        <strong>6 阶段流水线</strong>（点击任意节点查看输入/输出概要）
                    </span>
                    <span className="ns-mono ns-muted">
                        SSE: {latestSseStage ?? 'IDLE'}
                    </span>
                </div>

                <div className="ns-pipeline-graph">
                    {PIPELINE_STAGES.map((stage, idx) => {
                        const nodeState = stageMap[stage.id];
                        const statusMeta = getStageStatusMeta(nodeState.status);
                        const isSelected = inspectedStageId === stage.id;
                        return (
                            <React.Fragment key={stage.id}>
                                <button
                                    type="button"
                                    className={`ns-stage-node ns-stage-${nodeState.status} ${isSelected ? 'ns-selected' : ''}`}
                                    onClick={() =>
                                        setInspectedStageId((prev) =>
                                            prev === stage.id ? null : stage.id
                                        )
                                    }
                                >
                                    <div className="ns-stage-title">
                                        <span>{stage.label}</span>
                                        <span className={`ns-badge ${statusMeta.badgeClass}`}>
                                            {nodeState.status === 'active' ? (
                                                <span className="ns-pulse-dot" />
                                            ) : null}
                                            {statusMeta.text}
                                        </span>
                                    </div>
                                    <div className="ns-stage-sub ns-mono">
                                        {stage.shortDesc}
                                        {nodeState.summary ? ` · ${nodeState.summary}` : ''}
                                    </div>
                                </button>
                                {idx < PIPELINE_STAGES.length - 1 ? (
                                    <span className="ns-stage-arrow" aria-hidden="true">
                                        -&gt;
                                    </span>
                                ) : null}
                            </React.Fragment>
                        );
                    })}
                </div>

                {/* 可折叠节点输入/输出检查条 */}
                {inspectedStageDef ? (
                    <div className="ns-stage-inspector">
                        <div className="ns-inspector-main">
                            <div className="ns-inspector-title">
                                <strong>
                                    {inspectedStageDef.label} ({inspectedStageDef.shortDesc})
                                </strong>
                                <button
                                    type="button"
                                    className="ns-btn ns-btn-ghost ns-btn-xs"
                                    onClick={() => setInspectedStageId(null)}
                                >
                                    收起
                                </button>
                            </div>
                            <div className="ns-inspector-io">
                                <span>
                                    <strong>输入概要：</strong>
                                    {stageMap[inspectedStageDef.id].inputSummary ??
                                        inspectedStageDef.defaultInput}
                                </span>
                                <span>
                                    <strong>输出概要：</strong>
                                    {stageMap[inspectedStageDef.id].outputSummary ??
                                        inspectedStageDef.defaultOutput}
                                </span>
                            </div>
                        </div>
                    </div>
                ) : null}
            </section>

            {/* 主内容视图切换栏 */}
            <div className="ns-view-bar">
                <div className="ns-view-tabs" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={viewTab === 'prose'}
                        className={`ns-vtab ${viewTab === 'prose' ? 'ns-active' : ''}`}
                        onClick={() => setViewTab('prose')}
                    >
                        正文阅读
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={viewTab === 'plan'}
                        className={`ns-vtab ${viewTab === 'plan' ? 'ns-active' : ''}`}
                        onClick={() => setViewTab('plan')}
                    >
                        本章细纲
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={viewTab === 'diff'}
                        className={`ns-vtab ${viewTab === 'diff' ? 'ns-active' : ''}`}
                        onClick={() => setViewTab('diff')}
                    >
                        手改 Diff
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={viewTab === 'views'}
                        className={`ns-vtab ${viewTab === 'views' ? 'ns-active' : ''}`}
                        onClick={() => {
                            setViewTab('views');
                            if (onRefreshViews) {
                                void onRefreshViews();
                            }
                        }}
                    >
                        物化视图（只读）
                    </button>
                </div>

                <div className="ns-view-actions">
                    {chapters.length > 0 ? (
                        <select
                            className="ns-select ns-chapter-select"
                            aria-label="切换历史章节"
                            value={activeChapterNumber}
                            onChange={(e) => handleChapterChange(Number(e.target.value))}
                        >
                            {chapters.map((ch) => (
                                <option key={ch.chapterNumber} value={ch.chapterNumber}>
                                    {formatChapterLabel(ch.chapterNumber)} · {ch.title}
                                    {ch.dirty ? ' [有手改]' : ''}
                                </option>
                            ))}
                        </select>
                    ) : null}

                    {viewTab === 'prose' ? (
                        <>
                            <button
                                type="button"
                                className="ns-btn ns-btn-ghost"
                                title={`切换阅读字号 (${currentFontSize}px)`}
                                onClick={() =>
                                    setFontStep((prev) => (prev + 1) % PROSE_FONT_SIZES.length)
                                }
                            >
                                Aa
                            </button>
                            <button
                                type="button"
                                className={`ns-btn ns-btn-ghost ${isEditing ? 'ns-btn-active' : ''}`}
                                onClick={() => {
                                    setIsEditing((prev) => !prev);
                                    setDraftContent(chapterDetail?.content ?? '');
                                }}
                            >
                                {isEditing ? '取消编辑' : '✎ 直接编辑本章'}
                            </button>
                        </>
                    ) : null}
                </div>
            </div>

            {/* 操作反馈条 */}
            {actionMessage || actionError ? (
                <div className={`ns-feedback-bar ${actionError ? 'ns-feedback-err' : 'ns-feedback-ok'}`}>
                    <span>{actionError ?? actionMessage}</span>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        onClick={() => {
                            setActionMessage(null);
                            setActionError(null);
                        }}
                    >
                        ×
                    </button>
                </div>
            ) : null}

            {/* 主内容区 */}
            <div className="ns-stage-body">
                {viewTab === 'prose' ? (
                    <article
                        className="ns-prose-col"
                        style={{ '--ns-fs': `${currentFontSize}px` } as React.CSSProperties}
                    >
                        {/* 精致章节头：大号半透明章号 + 卷/章 kicker + 标题 + 元信息 */}
                        <header className="ns-chap-header">
                            <div className="ns-chap-numeral">{activeChapterNumber}</div>
                            <div>
                                <div className="ns-chap-kick">
                                    {chapterDetail?.volumeLabel
                                        ? `${chapterDetail.volumeLabel} · `
                                        : bookTitle
                                            ? `${bookTitle} · `
                                            : ''}
                                    {formatChapterLabel(activeChapterNumber)}
                                    {timelineMode ? ` · ${timelineMode}` : ''}
                                </div>
                                <h1>
                                    {chapterDetail?.title ??
                                        activeChapterSummary?.title ??
                                        `${formatChapterLabel(activeChapterNumber)} 正文`}
                                </h1>
                                <div className="ns-chap-meta">
                                    <span
                                        className={`ns-pill ${isChapterDirty ? 'ns-pill-amber' : 'ns-pill-green'}`}
                                    >
                                        {isChapterDirty ? '有本地手改待 Sync' : '已定稿 · 已对齐 WAL'}
                                    </span>
                                    <span>
                                        {proseCharCount > 0
                                            ? `${proseCharCount.toLocaleString('zh-CN')} 字`
                                            : '暂无正文内容'}
                                    </span>
                                    {featHash ? (
                                        <span className="ns-mono">feat {featHash}</span>
                                    ) : null}
                                    {chapterDetail?.sha256 ? (
                                        <span className="ns-mono">
                                            sha256 {chapterDetail.sha256.slice(0, 7)}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        </header>

                        {/* 已消费导演纸条提示条 */}
                        {!isEditing && consumedSignalText ? (
                            <div
                                className="ns-consumed"
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '8px',
                                    margin: '-12px 0 24px',
                                    padding: '6px 12px 6px 10px',
                                    borderRadius: 'var(--ns-r-sm, 6px)',
                                    fontSize: '12px',
                                    color: 'var(--ns-text-3)',
                                    background: 'var(--ns-bg-hover)',
                                    borderLeft: '2px dashed var(--ns-border-2)'
                                }}
                            >
                                <span>已消费导演纸条</span>
                                <s style={{ textDecorationColor: 'var(--ns-text-4, var(--ns-text-3))' }}>
                                    {consumedSignalText}
                                </s>
                            </div>
                        ) : null}

                        {isEditing ? (
                            <div className="ns-editor-wrap">
                                <textarea
                                    className="ns-editor-textarea"
                                    value={draftContent}
                                    onChange={(e) => setDraftContent(e.target.value)}
                                    rows={20}
                                    placeholder="在此直接修订本章 Markdown 正文…"
                                />
                                <div className="ns-editor-footer">
                                    <span className="ns-muted">
                                        保存后将写入原稿真源并自动调用 PUT /api/narrate/chapter 触发 Sync
                                    </span>
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-primary"
                                        disabled={savingEdit}
                                        onClick={handleSaveEditedChapter}
                                    >
                                        {savingEdit ? '正在保存并 Sync…' : '保存并自动 Sync'}
                                    </button>
                                </div>
                            </div>
                        ) : proseParagraphs.length > 0 ? (
                            <>
                                <div className="ns-prose">
                                    {proseParagraphs.map((para, idx) =>
                                        para.isBreak ? (
                                            <p key={idx} className="ns-brk">
                                                · · ·
                                            </p>
                                        ) : (
                                            <p key={idx}>{para.text}</p>
                                        )
                                    )}
                                </div>

                                {/* 已提交定稿章节末尾朱印「定稿」钤印 */}
                                {!isChapterDirty ? (
                                    <div className="ns-endmark">
                                        <span className="ns-stamp">定稿</span>
                                        <small>
                                            {featHash ? `feat ${featHash}` : 'WAL 已提交'}
                                            {stateHash ? ` · state ${stateHash}` : ''}
                                            {!stateHash && chapterDetail?.sha256
                                                ? ` · sha256 ${chapterDetail.sha256.slice(0, 7)}`
                                                : ''}
                                        </small>
                                    </div>
                                ) : null}
                            </>
                        ) : (
                            <div className="ns-muted">
                                当前章节尚无正文内容，请点击上方「单步推进 1 章」或切换其他历史章节。
                            </div>
                        )}

                        {/* 章节上下章快捷导航 */}
                        {!isEditing && (prevChapterSummary || nextChapterSummary) ? (
                            <nav
                                className="ns-chap-nav"
                                style={{
                                    marginTop: '36px',
                                    paddingTop: '18px',
                                    borderTop: '1px solid var(--ns-border-1)',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    gap: '12px'
                                }}
                            >
                                {prevChapterSummary ? (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-ghost"
                                        onClick={() =>
                                            handleChapterChange(prevChapterSummary.chapterNumber)
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
                                        className="ns-btn ns-btn-ghost"
                                        onClick={() =>
                                            handleChapterChange(nextChapterSummary.chapterNumber)
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
                ) : null}

                {viewTab === 'plan' ? (
                    <section className="ns-paper">
                        <div className="ns-paper-head">
                            <strong>
                                本章细纲 ({formatChapterLabel(activeChapterNumber)})
                            </strong>
                            <span className="ns-pill ns-pill-brand">{timelineMode}</span>
                        </div>
                        <pre className="ns-mono ns-pre-block">
                            {chapterDetail?.outlineText ||
                                '当前章节暂无已记录的结构化细纲摘要。'}
                        </pre>
                    </section>
                ) : null}

                {viewTab === 'diff' ? (
                    <section className="ns-paper">
                        <div className="ns-paper-head">
                            <strong>
                                手改 Diff ({formatChapterLabel(activeChapterNumber)} vs HEAD)
                            </strong>
                            <span
                                className={`ns-pill ${diffLines.length > 0 ? 'ns-pill-amber' : 'ns-pill-muted'}`}
                            >
                                {diffLines.length > 0 ? '存在未提交变更' : '无工作区差异'}
                            </span>
                        </div>
                        {diffLines.length > 0 ? (
                            <div className="ns-diff-block ns-mono">
                                {diffLines.map((line, index) => {
                                    let cls = 'ns-diff-ctx';
                                    if (line.startsWith('+') && !line.startsWith('+++')) {
                                        cls = 'ns-diff-add';
                                    } else if (line.startsWith('-') && !line.startsWith('---')) {
                                        cls = 'ns-diff-del';
                                    } else if (line.startsWith('@@')) {
                                        cls = 'ns-diff-hunk';
                                    }
                                    return (
                                        <div key={index} className={cls}>
                                            {line || ' '}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="ns-muted">当前章节正文与 Git HEAD 一致，无手改差异。</div>
                        )}
                    </section>
                ) : null}

                {viewTab === 'views' ? (
                    <section className="ns-paper">
                        <div className="ns-paper-head">
                            <div className="ns-subtabs">
                                <button
                                    type="button"
                                    className={`ns-vtab ${materialKind === 'entities' ? 'ns-active' : ''}`}
                                    onClick={() => setMaterialKind('entities')}
                                >
                                    entities/ ({materializedViews?.entities?.length ?? 0})
                                </button>
                                <button
                                    type="button"
                                    className={`ns-vtab ${materialKind === 'horizon' ? 'ns-active' : ''}`}
                                    onClick={() => setMaterialKind('horizon')}
                                >
                                    future_horizon.md
                                </button>
                                <button
                                    type="button"
                                    className={`ns-vtab ${materialKind === 'threads' ? 'ns-active' : ''}`}
                                    onClick={() => setMaterialKind('threads')}
                                >
                                    open_threads.md
                                </button>
                            </div>
                            <span className="ns-pill ns-pill-muted">只读物化视图</span>
                        </div>

                        {materialKind === 'entities' ? (
                            <div className="ns-entities-list">
                                {materializedViews?.coldArchiveCount ? (
                                    <div className="ns-muted ns-mono">
                                        冷档实体数量：{materializedViews.coldArchiveCount}
                                    </div>
                                ) : null}
                                {materializedViews?.entities &&
                                materializedViews.entities.length > 0 ? (
                                    materializedViews.entities.map((entity) => (
                                        <details key={entity.entityId} className="ns-entity-card">
                                            <summary className="ns-entity-summary">
                                                <span>
                                                    <strong>{entity.canonicalName}</strong>{' '}
                                                    <span className="ns-mono ns-muted">
                                                        ({entity.entityId})
                                                    </span>
                                                </span>
                                                {entity.lastSeenChapter !== undefined ? (
                                                    <span className="ns-pill ns-pill-muted ns-mono">
                                                        last: Ch.{entity.lastSeenChapter}
                                                    </span>
                                                ) : null}
                                            </summary>
                                            <pre className="ns-mono ns-pre-block">
                                                {entity.markdown}
                                            </pre>
                                        </details>
                                    ))
                                ) : (
                                    <div className="ns-muted">暂无活跃实体档案。</div>
                                )}
                            </div>
                        ) : null}

                        {materialKind === 'horizon' ? (
                            <pre className="ns-mono ns-pre-block">
                                {materializedViews?.horizonMarkdown || 'world/future_horizon.md 为空。'}
                            </pre>
                        ) : null}

                        {materialKind === 'threads' ? (
                            <pre className="ns-mono ns-pre-block">
                                {materializedViews?.threadsMarkdown || 'world/open_threads.md 为空。'}
                            </pre>
                        ) : null}
                    </section>
                ) : null}
            </div>

            {/* 底部导演一次性干涉栏 */}
            <footer className="ns-signal-dock">
                <div className="ns-dock-head">
                    <span>
                        <strong>导演一次性干涉栏</strong>（写入{' '}
                        <span className="ns-mono">.ops/signals.jsonl</span> · 安全点消费即焚 ·{' '}
                        <strong>零累进上下文</strong>）
                    </span>
                    <span className="ns-mono">待消费：{effectiveSignalsCount} 条</span>
                </div>

                {pendingSignals.length > 0 ? (
                    <div className="ns-sig-list">
                        {pendingSignals.map((sig, idx) => (
                            <span key={idx} className="ns-sig-chip">
                                [{sig.type ?? 'SIGNAL'}] {sig.reason ?? sig.raw ?? '待消费信号'}
                            </span>
                        ))}
                    </div>
                ) : null}

                <div className="ns-dock-row">
                    <select
                        className="ns-dock-select"
                        aria-label="导演信号类型"
                        value={signalKind}
                        onChange={(e) => setSignalKind(e.target.value as DirectorSignalKind)}
                    >
                        {DIRECTOR_SIGNAL_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                                {opt.label}
                            </option>
                        ))}
                    </select>
                    <input
                        type="text"
                        className="ns-dock-input"
                        value={signalInput}
                        onChange={(e) => setSignalInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                void handleSignalAction(false);
                            }
                        }}
                        placeholder="输入一次性导演指令、插叙/并行支线或 Retcon 圆谎纸条…"
                    />
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost"
                        disabled={submittingSignal || !signalInput.trim()}
                        onClick={() => handleSignalAction(false)}
                    >
                        投入队列
                    </button>
                    <button
                        type="button"
                        className="ns-btn ns-btn-primary"
                        disabled={submittingSignal || isBusy}
                        onClick={() => handleSignalAction(true)}
                    >
                        入队并推进
                    </button>
                </div>
            </footer>
        </main>
    );
};

import React, { useMemo, useState } from 'react';

/** 1. WAL & 事务锁状态 */
export interface WalLockTelemetry {
    walPhase: string;
    timelineMode: string;
    txLockStatus: 'free' | 'locked';
    txLockHolder?: string | null;
    lastCommittedChapter: number;
    activeChapter?: number | null;
    featCommitSha?: string | null;
    stateCommitSha?: string | null;
}

/** 2. 异构模型池 & 前缀缓存 */
export interface ModelPoolTelemetry {
    fastModel: string;
    strongModel: string;
    auditModel: string;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens?: number;
    /** 缓存命中率 (0-100 百分比或 0-1 小数，组件内部自动兼容格式化) */
    cacheHitRate?: number;
}

/** 三池模型路由明细 (兼容 modelRouting 配置对象) */
export interface ModelRoutingSnapshot {
    strong_creative?: string;
    fast_retrieval?: string;
    audit?: string;
}

/** 3. 6 步产物 & 预算降级 */
export interface StageArtifactTelemetry {
    selectedStageIndex: number;
    stageName: string;
    stageStatus: string;
    stageSummary: string;
    staticPrefixTokens?: number;
    dynamicTailTokens?: number;
    budgetLimitTokens?: number;
    degradationLevel?: number;
    outlineSummary?: string | null;
    voiceLruSummary?: string | null;
    strippedItemsSummary?: string | null;
}

/** 4. Static Prose Gate & 四联遥测 */
export interface ProseGateViolationItem {
    rule: string;
    detail: string;
    patched?: boolean;
}

export interface ProseGateTelemetry {
    mattr500: number | null;
    kontoyiannisEntropy: number | null;
    sentenceLengthCv: number | null;
    clicheDensityPer1k: number | null;
    recentViolations: ProseGateViolationItem[];
}

/** 5. Fact Checker & 双侧原句验真 */
export interface FactCheckDetailItem {
    claim: string;
    sourceRef?: string;
    verified: boolean;
    reason?: string;
}

export interface FactCheckerTelemetry {
    totalChecked: number;
    verifiedPassCount: number;
    filteredOutCount: number;
    blockedCount?: number;
    recentFindings?: FactCheckDetailItem[];
}

/** 6. Dreaming 脏页水位 & 前台切镜 */
export interface SpotlightQueueItem {
    entityId: string;
    label: string;
    progressPct: number;
    triggered?: boolean;
}

export interface DreamingTelemetry {
    dirtyEntityCount: number;
    dirtyThreshold: number;
    coldArchiveCount: number;
    spotlightQueue: SpotlightQueueItem[];
    lastVacuumAt?: string | null;
}

/** 7. SAFE_HALT / QUARANTINED 诊断 */
export interface HaltDiagnosticInfo {
    kind: 'SAFE_HALT' | 'QUARANTINED';
    reason: string;
    leftRef?: string;
    rightRef?: string;
    leftExcerpt?: string;
    rightExcerpt?: string;
    affectedChapters?: number;
    rollbackThreshold?: number;
    timestamp?: string;
}

/** 活跃实体摘要项 (可选扩展) */
export interface InspectorEntityItem {
    id: string;
    name: string;
    role?: string;
    lastChapter?: number;
    brief?: string;
    warped?: boolean;
}

/** 伏笔线程项 (可选扩展) */
export interface OpenThreadItem {
    id?: string;
    chapter?: number;
    title: string;
    hint?: string;
    scope?: string;
}

/** 卷纲进度快照 (可选扩展) */
export interface VolumeProgressSnapshot {
    volumeLabel?: string;
    volumeTitle?: string;
    completedChapters?: number;
    totalChapters?: number;
    futureHorizon?: string | null;
    milestoneLock?: string | null;
}

/** 右栏 7 子页签运维检查器 Props */
export interface RightOpsInspectorProps {
    walLock: WalLockTelemetry;
    modelPool: ModelPoolTelemetry;
    stageArtifact: StageArtifactTelemetry;
    proseGate: ProseGateTelemetry;
    factChecker: FactCheckerTelemetry;
    dreaming: DreamingTelemetry;
    haltDiagnostic?: HaltDiagnosticInfo | null;
    /** 是否正在执行后台写任务 */
    busy?: boolean;
    /** 手动触发 Dreaming (VACUUM) */
    onTriggerDreaming?: () => void;
    /** 查看/定位挂起冲突详情回调 */
    onInspectHalt?: () => void;
    /** 真实三池模型路由配置 (可选，缺省回退至 modelPool) */
    modelRouting?: ModelRoutingSnapshot | null;
    /** 活跃实体列表 (可选) */
    entities?: InspectorEntityItem[];
    /** 未收伏笔列表 (可选) */
    openThreads?: OpenThreadItem[];
    /** 当前卷纲进度与 future_horizon (可选) */
    volumeProgress?: VolumeProgressSnapshot | null;
    /** 点击实体跳转中栏查看回调 (可选) */
    onSelectEntity?: (entityId: string, lastChapter?: number) => void;
    /** 点击章节跳转中栏查看回调 (可选) */
    onSelectChapter?: (chapter: number) => void;
}

type InspectorSubtabKey = 'tel' | 'ctx' | 'ent' | 'arc' | 'git' | 'vol' | 'gate';

interface SubtabDef {
    key: InspectorSubtabKey;
    label: string;
}

interface CoreGateRuleDef {
    id: string;
    label: string;
    threshold: string;
}

const SUBTABS: SubtabDef[] = [
    { key: 'tel', label: '遥测' },
    { key: 'ctx', label: '装配' },
    { key: 'ent', label: '实体' },
    { key: 'arc', label: '伏笔' },
    { key: 'git', label: '提交' },
    { key: 'vol', label: '卷纲' },
    { key: 'gate', label: '门禁' }
];

const CORE_GATE_RULES: CoreGateRuleDef[] = [
    { id: 'tag_residue', label: '工程标签残留', threshold: '0' },
    { id: 'negation_contrast', label: '先否决后对比句', threshold: '<=1' },
    { id: 'micro_anatomy', label: '人体微距套话', threshold: '0' },
    { id: 'skeletal_quota', label: '骨骼部位词配额', threshold: '<=1' },
    { id: 'deictic_density', label: '那+量词 / 一丝 / X了X', threshold: '<=2' },
    { id: 'filler_cliche', label: '填充套话', threshold: '<=1' },
    { id: 'ending_moralizing', label: '章末点题说教', threshold: '0' },
    { id: 'cross_chapter_simile', label: '跨 5 章具象喻体复读', threshold: '<2' }
];

const WAL_PHASES = ['DRAFTING', 'FEAT_COMMITTED', 'STATE_COMMITTED', 'DREAMING'] as const;

function formatTokenCount(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens < 0) return '0';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return String(Math.round(tokens));
}

function formatMetricNumber(value: number | null | undefined, digits = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return '--';
    }
    return value.toFixed(digits);
}

function computeCacheHitRatePct(pool: ModelPoolTelemetry): number {
    if (typeof pool.cacheHitRate === 'number' && Number.isFinite(pool.cacheHitRate)) {
        const raw = pool.cacheHitRate <= 1 ? pool.cacheHitRate * 100 : pool.cacheHitRate;
        return Math.min(100, Math.max(0, raw));
    }
    const denom = pool.inputTokens + pool.cacheReadTokens;
    if (denom <= 0) return 0;
    return Math.min(100, Math.max(0, (pool.cacheReadTokens / denom) * 100));
}

function resolveWalBadgeClass(phase: string): string {
    const upper = phase.toUpperCase();
    if (upper === 'SAFE_HALT' || upper === 'QUARANTINED') return 'ns-pill ns-pill-red';
    if (upper === 'DRAFTING' || upper === 'FEAT_COMMITTED') return 'ns-pill ns-pill-brand';
    return 'ns-pill ns-pill-green';
}

function resolveWalPhaseStepStatus(
    stepPhase: string,
    currentPhase: string
): 'done' | 'cur' | 'halt' | 'idle' {
    const upper = currentPhase.toUpperCase();
    if (upper === 'SAFE_HALT' || upper === 'QUARANTINED') {
        return stepPhase === 'DRAFTING' ? 'halt' : 'idle';
    }
    const idx = WAL_PHASES.indexOf(upper as (typeof WAL_PHASES)[number]);
    const stepIdx = WAL_PHASES.indexOf(stepPhase as (typeof WAL_PHASES)[number]);
    if (idx < 0) {
        return stepIdx === 0 ? 'idle' : 'idle';
    }
    if (stepIdx < idx) return 'done';
    if (stepIdx === idx) return 'cur';
    return 'idle';
}

/**
 * 共享样式片段：完全使用 styles.ts 的 CSS 变量，确保暗/亮主题自动适配
 */
const cardStyle: React.CSSProperties = {
    padding: '12px',
    borderRadius: 'var(--ns-r-lg)',
    background: 'var(--ns-bg-card)',
    border: '1px solid var(--ns-border-1)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
};

const subSectionTitleStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--ns-text-3)',
    letterSpacing: '0.02em'
};

/**
 * 右栏 7 子页签运维检查器：
 * - 顶部渲染 7 个横向紧凑胶囊子页签：遥测 | 装配 | 实体 | 伏笔 | 提交 | 卷纲 | 门禁
 * - 存在门禁告警或 HALT 异常时在对应子页签显示提示圆点
 */
export function RightOpsInspector(props: RightOpsInspectorProps): React.ReactElement {
    const {
        walLock,
        modelPool,
        stageArtifact,
        proseGate,
        factChecker,
        dreaming,
        haltDiagnostic = null,
        busy = false,
        onTriggerDreaming,
        onInspectHalt,
        modelRouting = null,
        entities,
        openThreads,
        volumeProgress = null,
        onSelectEntity,
        onSelectChapter
    } = props;

    const [activeSubtab, setActiveSubtab] = useState<InspectorSubtabKey>('tel');
    const [expandedEntityId, setExpandedEntityId] = useState<string | null>(null);

    const cacheHitPct = computeCacheHitRatePct(modelPool);
    const hasHalt = haltDiagnostic !== null;
    const isWalHalted =
        hasHalt ||
        walLock.walPhase.toUpperCase() === 'SAFE_HALT' ||
        walLock.walPhase.toUpperCase() === 'QUARANTINED';
    const hasGateAlert =
        proseGate.recentViolations.length > 0 || (factChecker.blockedCount ?? 0) > 0;

    // 真实三池模型路由（优先取 modelRouting，缺省回退至 modelPool）
    const resolvedRouting = useMemo(
        () => ({
            strong_creative: modelRouting?.strong_creative || modelPool.strongModel || '--',
            fast_retrieval: modelRouting?.fast_retrieval || modelPool.fastModel || '--',
            audit: modelRouting?.audit || modelPool.auditModel || '--'
        }),
        [modelRouting, modelPool]
    );

    // 8 条核心门禁规则的实时命中计数与状态
    const gateRuleStats = useMemo(() => {
        return CORE_GATE_RULES.map((rule) => {
            const matched = proseGate.recentViolations.filter(
                (v) => v.rule === rule.id || v.rule.toLowerCase().includes(rule.id)
            );
            const patchedCount = matched.filter((v) => v.patched).length;
            return {
                ...rule,
                hits: matched.length,
                patchedCount
            };
        });
    }, [proseGate.recentViolations]);

    // 实体列表：优先使用 props.entities，若未传入则从 spotlightQueue 推导活跃实体
    const resolvedEntities = useMemo<InspectorEntityItem[]>(() => {
        if (entities && entities.length > 0) {
            return entities;
        }
        return dreaming.spotlightQueue.map((item) => ({
            id: item.entityId,
            name: item.label,
            role: item.triggered ? '已触发切镜' : `切镜蓄力 ${Math.round(item.progressPct)}%`,
            ...(walLock.lastCommittedChapter > 0
                ? { lastChapter: walLock.lastCommittedChapter }
                : {}),
            brief: item.triggered ? '待前台切镜出场' : '幕后蓄力中'
        }));
    }, [entities, dreaming.spotlightQueue, walLock.lastCommittedChapter]);

    // 伏笔列表：优先使用 props.openThreads
    const resolvedThreads = useMemo<OpenThreadItem[]>(() => {
        if (openThreads && openThreads.length > 0) {
            return openThreads;
        }
        return [];
    }, [openThreads]);

    const dirtyRatioPct =
        dreaming.dirtyThreshold > 0
            ? Math.min(100, Math.round((dreaming.dirtyEntityCount / dreaming.dirtyThreshold) * 100))
            : 0;

    const staticTokens = stageArtifact.staticPrefixTokens ?? 0;
    const dynamicTokens = stageArtifact.dynamicTailTokens ?? 0;
    const totalUsedTokens = staticTokens + dynamicTokens;
    const budgetLimit = stageArtifact.budgetLimitTokens ?? 0;
    const staticPct =
        budgetLimit > 0 ? Math.min(100, (staticTokens / budgetLimit) * 100) : 0;
    const dynamicPct =
        budgetLimit > 0 ? Math.min(100 - staticPct, (dynamicTokens / budgetLimit) * 100) : 0;
    const degradationLevel = stageArtifact.degradationLevel ?? 0;

    // 卷纲进度计算
    const completedCh =
        volumeProgress?.completedChapters ?? walLock.lastCommittedChapter;
    const totalVolCh =
        volumeProgress?.totalChapters && volumeProgress.totalChapters > 0
            ? volumeProgress.totalChapters
            : Math.max(completedCh, 20);
    const volumePct =
        totalVolCh > 0 ? Math.min(100, Math.round((completedCh / totalVolCh) * 100)) : 0;

    // Token 占比条 (遥测子页签)
    const uncachedInputTokens = Math.max(0, modelPool.inputTokens - modelPool.cacheReadTokens);
    const outputTokens = modelPool.outputTokens ?? 0;
    const barTotalTokens = Math.max(
        1,
        uncachedInputTokens + modelPool.cacheReadTokens + outputTokens
    );

    const renderSubtabDot = (key: InspectorSubtabKey): boolean => {
        if (key === 'gate') return hasGateAlert;
        if (key === 'git') return isWalHalted;
        return false;
    };

    return (
        <div className="ns-ops-inspector" aria-label="运维检查器">
            {/* 顶部 7 个横向紧凑胶囊子页签 */}
            <div
                style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--ns-border-1)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '4px',
                    flexShrink: 0
                }}
                role="tablist"
                aria-label="检查器子页签"
            >
                {SUBTABS.map((tab) => {
                    const isActive = activeSubtab === tab.key;
                    const showDot = renderSubtabDot(tab.key);
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            role="tab"
                            aria-selected={isActive}
                            onClick={() => setActiveSubtab(tab.key)}
                            style={{
                                height: '26px',
                                padding: '0 9px',
                                borderRadius: '999px',
                                border: isActive
                                    ? '1px solid var(--ns-brand-line)'
                                    : '1px solid transparent',
                                background: isActive ? 'var(--ns-brand-soft)' : 'var(--ns-bg-hover)',
                                color: isActive ? 'var(--ns-brand-ink)' : 'var(--ns-text-3)',
                                fontSize: '11.5px',
                                fontWeight: isActive ? 600 : 500,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease'
                            }}
                        >
                            <span>{tab.label}</span>
                            {showDot && (
                                <span
                                    aria-label="存在告警"
                                    style={{
                                        width: '6px',
                                        height: '6px',
                                        borderRadius: '50%',
                                        background:
                                            tab.key === 'git' && isWalHalted
                                                ? 'var(--ns-red)'
                                                : 'var(--ns-amber)'
                                    }}
                                />
                            )}
                        </button>
                    );
                })}
            </div>

            {/* 子页签内容区 */}
            <div className="ns-right-scroll">
                {/* 1. 遥测 */}
                {activeSubtab === 'tel' && (
                    <>
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>静态前缀缓存命中</span>
                                <span className="ns-mono" style={{ color: 'var(--ns-green-ink)' }}>
                                    {cacheHitPct.toFixed(1)}%
                                </span>
                            </div>
                            <div
                                style={{
                                    fontSize: '28px',
                                    fontWeight: 300,
                                    lineHeight: 1.1,
                                    fontFamily: 'var(--ns-font-display)',
                                    color: 'var(--ns-text-1)'
                                }}
                            >
                                {cacheHitPct.toFixed(1)}
                                <small style={{ fontSize: '14px', color: 'var(--ns-text-4)' }}>%</small>
                            </div>
                            <div className="ns-prog-bar" style={{ marginTop: '2px' }}>
                                <div
                                    className="ns-prog-fill"
                                    style={{
                                        width: `${cacheHitPct}%`,
                                        background: 'var(--ns-green)'
                                    }}
                                />
                            </div>
                        </div>

                        {/* 四联指标卡片 */}
                        <div className="ns-kv-grid">
                            <div className="ns-metric">
                                <div className="ns-metric-k" style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>MATTR-500</span>
                                    <span
                                        style={{
                                            width: '6px',
                                            height: '6px',
                                            borderRadius: '50%',
                                            alignSelf: 'center',
                                            background:
                                                proseGate.mattr500 !== null
                                                    ? 'var(--ns-green)'
                                                    : 'var(--ns-text-4)'
                                        }}
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.mattr500)}
                                </div>
                                <div style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>词汇多样性</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k" style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>Kontoyiannis H_K</span>
                                    <span
                                        style={{
                                            width: '6px',
                                            height: '6px',
                                            borderRadius: '50%',
                                            alignSelf: 'center',
                                            background:
                                                proseGate.kontoyiannisEntropy !== null
                                                    ? 'var(--ns-green)'
                                                    : 'var(--ns-text-4)'
                                        }}
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.kontoyiannisEntropy)}
                                </div>
                                <div style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>信息熵率</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k" style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>句段长 CV</span>
                                    <span
                                        style={{
                                            width: '6px',
                                            height: '6px',
                                            borderRadius: '50%',
                                            alignSelf: 'center',
                                            background:
                                                proseGate.sentenceLengthCv !== null
                                                    ? 'var(--ns-green)'
                                                    : 'var(--ns-text-4)'
                                        }}
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.sentenceLengthCv)}
                                </div>
                                <div style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>节奏变化</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k" style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span>AI 八股千字密度</span>
                                    <span
                                        style={{
                                            width: '6px',
                                            height: '6px',
                                            borderRadius: '50%',
                                            alignSelf: 'center',
                                            background:
                                                proseGate.clicheDensityPer1k !== null
                                                    ? proseGate.clicheDensityPer1k > 1.5
                                                        ? 'var(--ns-amber)'
                                                        : 'var(--ns-green)'
                                                    : 'var(--ns-text-4)'
                                        }}
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.clicheDensityPer1k)}
                                </div>
                                <div style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>/千字</div>
                            </div>
                        </div>

                        {/* 本章实耗与 Token 分布进度条 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>本章实耗 Token 分布</span>
                                <span className="ns-mono" style={{ color: 'var(--ns-text-2)' }}>
                                    {formatTokenCount(modelPool.inputTokens + outputTokens)}
                                </span>
                            </div>
                            <div
                                style={{
                                    display: 'flex',
                                    gap: '2px',
                                    height: '8px',
                                    borderRadius: '4px',
                                    overflow: 'hidden',
                                    background: 'var(--ns-bg-surface-2)'
                                }}
                            >
                                <div
                                    title={`未命中输入 ${formatTokenCount(uncachedInputTokens)}`}
                                    style={{
                                        width: `${(uncachedInputTokens / barTotalTokens) * 100}%`,
                                        background: 'var(--ns-text-3)'
                                    }}
                                />
                                <div
                                    title={`缓存读取 ${formatTokenCount(modelPool.cacheReadTokens)}`}
                                    style={{
                                        width: `${(modelPool.cacheReadTokens / barTotalTokens) * 100}%`,
                                        background: 'var(--ns-green)'
                                    }}
                                />
                                <div
                                    title={`输出 ${formatTokenCount(outputTokens)}`}
                                    style={{
                                        width: `${(outputTokens / barTotalTokens) * 100}%`,
                                        background: 'var(--ns-brand)'
                                    }}
                                />
                            </div>
                            <div
                                className="ns-mono"
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    fontSize: '11px',
                                    color: 'var(--ns-text-4)'
                                }}
                            >
                                <span>
                                    in {formatTokenCount(modelPool.inputTokens)} - cache{' '}
                                    {formatTokenCount(modelPool.cacheReadTokens)} - out{' '}
                                    {formatTokenCount(outputTokens)}
                                </span>
                            </div>
                        </div>
                    </>
                )}

                {/* 2. 装配 */}
                {activeSubtab === 'ctx' && (
                    <>
                        {/* 三池模型路由 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>三池模型路由 (modelRouting)</span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                <div
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: '1fr auto',
                                        gap: '2px 8px',
                                        padding: '8px 10px',
                                        borderRadius: 'var(--ns-r-md)',
                                        background: 'var(--ns-bg-surface-2)',
                                        fontSize: '12px'
                                    }}
                                >
                                    <strong>强创作池 (strong_creative)</strong>
                                    <span className="ns-mono" style={{ fontSize: '11px', color: 'var(--ns-brand-ink)' }}>
                                        {resolvedRouting.strong_creative}
                                    </span>
                                    <span style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>
                                        Planner - Writer
                                    </span>
                                </div>
                                <div
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: '1fr auto',
                                        gap: '2px 8px',
                                        padding: '8px 10px',
                                        borderRadius: 'var(--ns-r-md)',
                                        background: 'var(--ns-bg-surface-2)',
                                        fontSize: '12px'
                                    }}
                                >
                                    <strong>检索快池 (fast_retrieval)</strong>
                                    <span className="ns-mono" style={{ fontSize: '11px', color: 'var(--ns-green-ink)' }}>
                                        {resolvedRouting.fast_retrieval}
                                    </span>
                                    <span style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>
                                        Librarian
                                    </span>
                                </div>
                                <div
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: '1fr auto',
                                        gap: '2px 8px',
                                        padding: '8px 10px',
                                        borderRadius: 'var(--ns-r-md)',
                                        background: 'var(--ns-bg-surface-2)',
                                        fontSize: '12px'
                                    }}
                                >
                                    <strong>异构核查池 (audit)</strong>
                                    <span className="ns-mono" style={{ fontSize: '11px', color: 'var(--ns-amber-ink)' }}>
                                        {resolvedRouting.audit}
                                    </span>
                                    <span style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>
                                        Fact Checker
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* 静态前缀与 budget 降级状态 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>写手窗口与 budget 降级</span>
                                <span
                                    className={
                                        degradationLevel > 0
                                            ? 'ns-pill ns-pill-amber'
                                            : 'ns-pill ns-pill-green'
                                    }
                                >
                                    {degradationLevel > 0 ? `降级 ${degradationLevel} 级` : '0 级正常'}
                                </span>
                            </div>
                            <div className="ns-mono" style={{ fontSize: '11.5px', color: 'var(--ns-text-2)' }}>
                                {budgetLimit > 0
                                    ? `${formatTokenCount(totalUsedTokens)} / ${formatTokenCount(budgetLimit)}`
                                    : `总装配 ${formatTokenCount(totalUsedTokens)} tokens`}
                            </div>
                            <div
                                style={{
                                    display: 'flex',
                                    gap: '2px',
                                    height: '8px',
                                    borderRadius: '4px',
                                    overflow: 'hidden',
                                    background: 'var(--ns-bg-surface-2)'
                                }}
                            >
                                <div
                                    style={{
                                        width: `${budgetLimit > 0 ? staticPct : 50}%`,
                                        background: 'var(--ns-brand)'
                                    }}
                                />
                                <div
                                    style={{
                                        width: `${budgetLimit > 0 ? dynamicPct : 30}%`,
                                        background: 'var(--ns-green)'
                                    }}
                                />
                            </div>
                            <div
                                style={{
                                    display: 'flex',
                                    gap: '12px',
                                    flexWrap: 'wrap',
                                    fontSize: '11px',
                                    color: 'var(--ns-text-4)'
                                }}
                            >
                                <span>静态前缀 {formatTokenCount(staticTokens)}</span>
                                <span>动态尾 {formatTokenCount(dynamicTokens)}</span>
                            </div>
                        </div>

                        {/* 当前阶段产物摘要 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>
                                    阶段 #{stageArtifact.selectedStageIndex + 1} - {stageArtifact.stageName}
                                </span>
                                <span className="ns-pill ns-pill-brand">
                                    {stageArtifact.stageStatus || '就绪'}
                                </span>
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--ns-text-2)' }}>
                                {stageArtifact.stageSummary}
                            </div>
                            {stageArtifact.voiceLruSummary && (
                                <div style={{ fontSize: '11.5px', color: 'var(--ns-text-3)' }}>
                                    <strong>声纹 LRU</strong>: {stageArtifact.voiceLruSummary}
                                </div>
                            )}
                            {stageArtifact.strippedItemsSummary && (
                                <div style={{ fontSize: '11.5px', color: 'var(--ns-green-ink)' }}>
                                    <strong>物理剥离</strong>: {stageArtifact.strippedItemsSummary}
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* 3. 实体 */}
                {activeSubtab === 'ent' && (
                    <>
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>活跃实体列表</span>
                                <span className="ns-mono" style={{ color: 'var(--ns-text-4)' }}>
                                    {resolvedEntities.length} 活跃 - {dreaming.coldArchiveCount} 冷归档
                                </span>
                            </div>
                            {resolvedEntities.length === 0 ? (
                                <div style={{ fontSize: '12px', color: 'var(--ns-text-4)' }}>
                                    暂无活跃实体记录，可在运行写章或刷新工作区后查看。
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    {resolvedEntities.map((ent) => {
                                        const isExpanded = expandedEntityId === ent.id;
                                        return (
                                            <div
                                                key={ent.id}
                                                style={{
                                                    borderRadius: 'var(--ns-r-md)',
                                                    background: 'var(--ns-bg-surface-2)',
                                                    border: ent.warped
                                                        ? '1px dashed var(--ns-violet)'
                                                        : '1px solid var(--ns-border-1)',
                                                    overflow: 'hidden'
                                                }}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setExpandedEntityId(isExpanded ? null : ent.id);
                                                        if (onSelectEntity) {
                                                            onSelectEntity(ent.id, ent.lastChapter);
                                                        } else if (ent.lastChapter && onSelectChapter) {
                                                            onSelectChapter(ent.lastChapter);
                                                        }
                                                    }}
                                                    style={{
                                                        width: '100%',
                                                        padding: '9px 10px',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '8px',
                                                        textAlign: 'left',
                                                        background: 'transparent',
                                                        border: 'none',
                                                        color: 'var(--ns-text-1)',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    <span
                                                        style={{
                                                            width: '26px',
                                                            height: '26px',
                                                            borderRadius: '50%',
                                                            background: ent.warped
                                                                ? 'var(--ns-violet)'
                                                                : 'var(--ns-brand)',
                                                            color: '#fff',
                                                            display: 'grid',
                                                            placeItems: 'center',
                                                            fontSize: '12px',
                                                            fontWeight: 700,
                                                            flexShrink: 0
                                                        }}
                                                    >
                                                        {ent.name.slice(0, 1) || '?'}
                                                    </span>
                                                    <span style={{ flex: 1, minWidth: 0 }}>
                                                        <strong style={{ display: 'block', fontSize: '12.5px' }}>
                                                            {ent.name}
                                                        </strong>
                                                        <span
                                                            className="ns-mono"
                                                            style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}
                                                        >
                                                            {ent.id}
                                                            {ent.role ? ` - ${ent.role}` : ''}
                                                        </span>
                                                    </span>
                                                    {typeof ent.lastChapter === 'number' && (
                                                        <span className="ns-pill ns-pill-muted ns-mono">
                                                            Ch.{ent.lastChapter}
                                                        </span>
                                                    )}
                                                </button>
                                                {ent.brief && (isExpanded || !onSelectEntity) && (
                                                    <div
                                                        style={{
                                                            padding: '0 10px 8px 44px',
                                                            fontSize: '11.5px',
                                                            color: 'var(--ns-text-3)'
                                                        }}
                                                    >
                                                        {ent.brief}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* 4. 伏笔 */}
                {activeSubtab === 'arc' && (
                    <>
                        {/* Spotlight Trigger 信号队列 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>Spotlight Trigger 信号</span>
                                <span className="ns-mono" style={{ color: 'var(--ns-amber-ink)' }}>
                                    {dreaming.spotlightQueue.length} 项
                                </span>
                            </div>
                            {dreaming.spotlightQueue.length === 0 ? (
                                <div style={{ fontSize: '12px', color: 'var(--ns-text-4)' }}>
                                    暂无待切镜幕后角色信号
                                </div>
                            ) : (
                                dreaming.spotlightQueue.map((item) => {
                                    const pct = Math.min(100, Math.max(0, item.progressPct));
                                    return (
                                        <div key={item.entityId} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    fontSize: '12px'
                                                }}
                                            >
                                                <span>
                                                    {item.label}{' '}
                                                    <span className="ns-mono" style={{ color: 'var(--ns-text-4)' }}>
                                                        ({item.entityId})
                                                    </span>
                                                </span>
                                                <span className="ns-mono">
                                                    {Math.round(pct)}%{item.triggered ? ' - 已触发' : ''}
                                                </span>
                                            </div>
                                            <div className="ns-prog-bar" style={{ marginTop: 0 }}>
                                                <div
                                                    className="ns-prog-fill"
                                                    style={{
                                                        width: `${pct}%`,
                                                        background: item.triggered
                                                            ? 'var(--ns-amber)'
                                                            : 'var(--ns-brand)'
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>

                        {/* open_threads 跨卷伏笔 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>跨卷伏笔 (open_threads)</span>
                                <span className="ns-mono">{resolvedThreads.length}</span>
                            </div>
                            {resolvedThreads.length === 0 ? (
                                <div style={{ fontSize: '12px', color: 'var(--ns-text-4)' }}>
                                    当前未挂载单独的 open_threads 明细。
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    {resolvedThreads.map((thd, idx) => (
                                        <div
                                            key={thd.id ?? `${thd.title}-${idx}`}
                                            style={{
                                                display: 'grid',
                                                gridTemplateColumns: '48px 1fr auto',
                                                gap: '8px',
                                                alignItems: 'center',
                                                padding: '8px 10px',
                                                borderRadius: 'var(--ns-r-md)',
                                                background: 'var(--ns-bg-surface-2)',
                                                fontSize: '12px'
                                            }}
                                        >
                                            <span className="ns-mono" style={{ color: 'var(--ns-text-4)' }}>
                                                {typeof thd.chapter === 'number' ? `Ch.${thd.chapter}` : '--'}
                                            </span>
                                            <div>
                                                <div style={{ color: 'var(--ns-text-1)' }}>{thd.title}</div>
                                                {thd.hint && (
                                                    <div style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>
                                                        {thd.hint}
                                                    </div>
                                                )}
                                            </div>
                                            {thd.scope && (
                                                <span className="ns-pill ns-pill-brand">{thd.scope}</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Dreaming 脏页水位 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>Dreaming 脏页水位</span>
                                <span className="ns-mono">
                                    {dreaming.dirtyEntityCount} / {dreaming.dirtyThreshold} ({dirtyRatioPct}%)
                                </span>
                            </div>
                            <div className="ns-prog-bar" style={{ marginTop: 0 }}>
                                <div
                                    className="ns-prog-fill"
                                    style={{
                                        width: `${dirtyRatioPct}%`,
                                        background: 'var(--ns-violet)'
                                    }}
                                />
                            </div>
                            {onTriggerDreaming && (
                                <button
                                    type="button"
                                    className="ns-btn-ghost ns-btn-sm"
                                    onClick={onTriggerDreaming}
                                    disabled={busy}
                                >
                                    立即执行 Dreaming (VACUUM)
                                </button>
                            )}
                        </div>
                    </>
                )}

                {/* 5. 提交 */}
                {activeSubtab === 'git' && (
                    <>
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>WAL 相位状态</span>
                                <span className={resolveWalBadgeClass(walLock.walPhase)}>
                                    {walLock.walPhase}
                                </span>
                            </div>
                            <div
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(4, 1fr)',
                                    gap: '4px'
                                }}
                            >
                                {WAL_PHASES.map((phase) => {
                                    const stepSt = resolveWalPhaseStepStatus(phase, walLock.walPhase);
                                    const color =
                                        stepSt === 'done'
                                            ? 'var(--ns-green-ink)'
                                            : stepSt === 'cur'
                                              ? 'var(--ns-brand-ink)'
                                              : stepSt === 'halt'
                                                ? 'var(--ns-red-ink)'
                                                : 'var(--ns-text-4)';
                                    const bg =
                                        stepSt === 'done'
                                            ? 'var(--ns-green-soft)'
                                            : stepSt === 'cur'
                                              ? 'var(--ns-brand-soft)'
                                              : stepSt === 'halt'
                                                ? 'var(--ns-red-soft)'
                                                : 'var(--ns-bg-surface-2)';
                                    return (
                                        <div
                                            key={phase}
                                            className="ns-mono"
                                            style={{
                                                padding: '6px 2px',
                                                borderRadius: 'var(--ns-r-sm)',
                                                textAlign: 'center',
                                                fontSize: '9.5px',
                                                color,
                                                background: bg,
                                                border:
                                                    stepSt === 'cur'
                                                        ? '1px solid var(--ns-brand-line)'
                                                        : stepSt === 'halt'
                                                          ? '1px solid var(--ns-red-line)'
                                                          : '1px solid var(--ns-border-1)'
                                            }}
                                        >
                                            {phase.replace('_COMMITTED', '')}
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="ns-kv-grid">
                                <div className="ns-metric">
                                    <div className="ns-metric-k">.ops/tx.lock</div>
                                    <div
                                        className="ns-metric-v ns-mono"
                                        style={{
                                            color:
                                                walLock.txLockStatus === 'locked'
                                                    ? 'var(--ns-amber-ink)'
                                                    : 'var(--ns-green-ink)'
                                        }}
                                    >
                                        {walLock.txLockStatus === 'locked' ? 'LOCKED' : 'free'}
                                    </div>
                                </div>
                                <div className="ns-metric">
                                    <div className="ns-metric-k">last_committed_ch</div>
                                    <div className="ns-metric-v ns-mono">
                                        Ch.{String(walLock.lastCommittedChapter).padStart(4, '0')}
                                    </div>
                                </div>
                            </div>
                            {walLock.txLockStatus === 'locked' && walLock.txLockHolder && (
                                <div className="ns-mono" style={{ fontSize: '11.5px', color: 'var(--ns-amber-ink)' }}>
                                    锁持有者: {walLock.txLockHolder}
                                </div>
                            )}
                            {(walLock.featCommitSha || walLock.stateCommitSha) && (
                                <div className="ns-mono" style={{ fontSize: '11px', color: 'var(--ns-text-4)' }}>
                                    feat: {walLock.featCommitSha ? walLock.featCommitSha.slice(0, 7) : '--'} -
                                    state: {walLock.stateCommitSha ? walLock.stateCommitSha.slice(0, 7) : '--'}
                                </div>
                            )}
                        </div>

                        {/* SAFE_HALT / QUARANTINED 诊断块 */}
                        {hasHalt && haltDiagnostic && (
                            <div
                                style={{
                                    ...cardStyle,
                                    border: '1px solid var(--ns-red-line)',
                                    background: 'var(--ns-red-soft)'
                                }}
                            >
                                <div style={subSectionTitleStyle}>
                                    <span style={{ color: 'var(--ns-red-ink)' }}>
                                        {haltDiagnostic.kind} - 冲突诊断
                                    </span>
                                    <span className="ns-pill ns-pill-red">{haltDiagnostic.kind}</span>
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--ns-text-1)' }}>
                                    {haltDiagnostic.reason}
                                </div>
                                {(haltDiagnostic.leftRef || haltDiagnostic.rightRef) && (
                                    <div className="ns-mono" style={{ fontSize: '11px', color: 'var(--ns-text-2)' }}>
                                        <div>
                                            冲突双侧: {haltDiagnostic.leftRef || '--'} vs{' '}
                                            {haltDiagnostic.rightRef || '--'}
                                        </div>
                                        {haltDiagnostic.leftExcerpt && (
                                            <div style={{ marginTop: '4px' }}>
                                                [前文] {haltDiagnostic.leftExcerpt}
                                            </div>
                                        )}
                                        {haltDiagnostic.rightExcerpt && (
                                            <div style={{ marginTop: '2px' }}>
                                                [当章] {haltDiagnostic.rightExcerpt}
                                            </div>
                                        )}
                                    </div>
                                )}
                                {typeof haltDiagnostic.affectedChapters === 'number' && (
                                    <div className="ns-mono" style={{ fontSize: '11px', color: 'var(--ns-text-3)' }}>
                                        波及范围: {haltDiagnostic.affectedChapters} 章
                                        {typeof haltDiagnostic.rollbackThreshold === 'number'
                                            ? ` (自动回滚阈值 ${haltDiagnostic.rollbackThreshold} 章)`
                                            : ''}
                                    </div>
                                )}
                                {onInspectHalt && (
                                    <button
                                        type="button"
                                        className="ns-btn-stop ns-btn-sm"
                                        onClick={onInspectHalt}
                                    >
                                        定位冲突快照与恢复方案
                                    </button>
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* 6. 卷纲 */}
                {activeSubtab === 'vol' && (
                    <>
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>
                                    {volumeProgress?.volumeLabel || '当前卷进度'}
                                    {volumeProgress?.volumeTitle ? ` - ${volumeProgress.volumeTitle}` : ''}
                                </span>
                                <span className="ns-mono">
                                    {completedCh} / {totalVolCh} ({volumePct}%)
                                </span>
                            </div>
                            <div className="ns-prog-bar" style={{ marginTop: 0 }}>
                                <div className="ns-prog-fill" style={{ width: `${volumePct}%` }} />
                            </div>
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    fontSize: '11px',
                                    color: 'var(--ns-text-4)'
                                }}
                            >
                                <span>timeline_mode: {walLock.timelineMode}</span>
                                <span>已提交 Ch.{String(walLock.lastCommittedChapter).padStart(4, '0')}</span>
                            </div>
                        </div>

                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>future_horizon 与细纲摘要</span>
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--ns-text-2)', lineHeight: 1.6 }}>
                                {volumeProgress?.futureHorizon ||
                                    stageArtifact.outlineSummary ||
                                    '暂无 future_horizon 文本，将在 Planner 产出细纲后同步展示。'}
                            </div>
                            {volumeProgress?.milestoneLock && (
                                <div
                                    style={{
                                        padding: '8px 10px',
                                        borderRadius: 'var(--ns-r-md)',
                                        background: 'var(--ns-bg-surface-2)',
                                        fontSize: '11.5px',
                                        color: 'var(--ns-text-3)'
                                    }}
                                >
                                    <strong>终局/里程碑锁</strong>: {volumeProgress.milestoneLock}
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* 7. 门禁 */}
                {activeSubtab === 'gate' && (
                    <>
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>Static Prose Gate (8 条核心规则)</span>
                                <span
                                    className={
                                        proseGate.recentViolations.length > 0
                                            ? 'ns-pill ns-pill-amber'
                                            : 'ns-pill ns-pill-green'
                                    }
                                >
                                    命中 {proseGate.recentViolations.length}
                                </span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {gateRuleStats.map((rule) => {
                                    const triggered = rule.hits > 0;
                                    return (
                                        <div
                                            key={rule.id}
                                            style={{
                                                display: 'grid',
                                                gridTemplateColumns: '1fr auto auto',
                                                gap: '8px',
                                                alignItems: 'center',
                                                padding: '7px 9px',
                                                borderRadius: 'var(--ns-r-md)',
                                                background: 'var(--ns-bg-surface-2)'
                                            }}
                                        >
                                            <div>
                                                <div className="ns-mono" style={{ fontSize: '11px', color: 'var(--ns-text-1)' }}>
                                                    {rule.id}
                                                </div>
                                                <div style={{ fontSize: '10.5px', color: 'var(--ns-text-4)' }}>
                                                    {rule.label}
                                                </div>
                                            </div>
                                            <span
                                                className="ns-mono"
                                                style={{
                                                    fontSize: '10.5px',
                                                    color: triggered
                                                        ? 'var(--ns-amber-ink)'
                                                        : 'var(--ns-text-4)'
                                                }}
                                            >
                                                {rule.hits} / {rule.threshold}
                                            </span>
                                            <span
                                                className={
                                                    triggered
                                                        ? 'ns-pill ns-pill-amber'
                                                        : 'ns-pill ns-pill-green'
                                                }
                                            >
                                                {triggered
                                                    ? rule.patchedCount > 0
                                                        ? '已 Patch'
                                                        : '命中'
                                                    : '通过'}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Fact Checker 核查概览 */}
                        <div style={cardStyle}>
                            <div style={subSectionTitleStyle}>
                                <span>Fact Checker 双侧原句验真</span>
                                <span className="ns-pill ns-pill-brand">
                                    通过 {factChecker.verifiedPassCount} / 过滤 {factChecker.filteredOutCount}
                                </span>
                            </div>
                            <div className="ns-kv-grid">
                                <div className="ns-metric">
                                    <div className="ns-metric-k">核查总数</div>
                                    <div className="ns-metric-v ns-mono">{factChecker.totalChecked}</div>
                                </div>
                                <div className="ns-metric">
                                    <div className="ns-metric-k">穿帮拦截</div>
                                    <div className="ns-metric-v ns-mono">
                                        {factChecker.blockedCount ?? 0}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

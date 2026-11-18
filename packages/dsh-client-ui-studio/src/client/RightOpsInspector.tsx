import React, { useMemo, useState } from 'react';
import type { StageAttemptSession } from './CenterWorkbench';
import { POOL_LABELS } from './RoleRoutingEditor';
import { computeCacheHitRate } from './token-telemetry';

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
    /** 未缓存输入 Token（与缓存读取/写入互不重叠） */
    inputTokens: number;
    cacheReadTokens: number;
    /** 缓存写入 Token；旧调用方可缺省按 0，生产端始终传入 */
    cacheWriteTokens?: number;
    outputTokens?: number;
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
    /** 绑定到当前阶段的 DSH Agent Session ID（可选） */
    sessionId?: string | null;
    /** 当前阶段按顺序保留的全部工种尝试会话轨迹（可选） */
    sessions?: StageAttemptSession[] | undefined;
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
    /** 脏实体数；null 表示服务未提供水位数据，不得按 0 呈现 */
    dirtyEntityCount: number | null;
    /** 脏页触发阈值；null 表示服务未提供，不得按后端默认值猜测 */
    dirtyThreshold: number | null;
    coldArchiveCount: number;
    /** 切镜信号队列；null 表示未提供数据，[] 表示真实无信号 */
    spotlightQueue: SpotlightQueueItem[] | null;
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

/** 右栏 7 组运维检查器 Props */
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
    /** 点击当前阶段绑定的 Session ID，切至右侧会话轨迹视图 */
    onInspectStageSession?: (sessionId: string) => void;
}

/** 检查器手风琴分组键（沿用旧子页签键位，便于与数据口径对齐） */
type InspectorSubtabKey = 'tel' | 'ctx' | 'ent' | 'arc' | 'git' | 'vol' | 'gate';

interface CoreGateRuleDef {
    id: string;
    label: string;
    threshold: string;
}

/** 默认展开状态：遥测、装配常驻展开，其余折叠 */
const INITIAL_EXPANDED_GROUPS: Record<InspectorSubtabKey, boolean> = {
    tel: true,
    ctx: true,
    ent: false,
    arc: false,
    git: false,
    vol: false,
    gate: false
};

/** 全部展开 / 全部收起时使用的整组状态 */
const ALL_EXPANDED_GROUPS: Record<InspectorSubtabKey, boolean> = {
    tel: true,
    ctx: true,
    ent: true,
    arc: true,
    git: true,
    vol: true,
    gate: true
};

const ALL_COLLAPSED_GROUPS: Record<InspectorSubtabKey, boolean> = {
    tel: false,
    ctx: false,
    ent: false,
    arc: false,
    git: false,
    vol: false,
    gate: false
};

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

/** 命中率百分比：口径复用 computeCacheHitRate；无 prompt 数据返回 null（未提供，不按 0 呈现） */
function computeCacheHitRatePct(pool: ModelPoolTelemetry): number | null {
    const rate = computeCacheHitRate(
        pool.inputTokens,
        pool.cacheReadTokens,
        pool.cacheWriteTokens ?? 0
    );
    if (rate === undefined) return null;
    return Math.min(100, Math.max(0, rate * 100));
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
 * 右栏运维检查器：7 组可同时展开的手风琴卡片
 * - 顶部工具行提供「全部展开 / 全部收起」
 * - 组头常驻摘要徽标；HALT 与门禁告警以圆点提示
 * - 所有静态样式走 inspector-styles.ts 的 ns-i-* 类，主题由 CSS 变量自动适配
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
        onSelectChapter,
        onInspectStageSession
    } = props;

    const [expandedGroups, setExpandedGroups] =
        useState<Record<InspectorSubtabKey, boolean>>(INITIAL_EXPANDED_GROUPS);
    const [expandedEntityId, setExpandedEntityId] = useState<string | null>(null);

    const cacheHitPct = computeCacheHitRatePct(modelPool);
    const cacheHitLabel = cacheHitPct === null ? '未提供' : `${cacheHitPct.toFixed(1)}%`;
    const hasHalt = haltDiagnostic !== null;
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

    // 实体列表：优先使用 props.entities，若未传入则从已提供的 spotlightQueue 推导活跃实体
    const resolvedEntities = useMemo<InspectorEntityItem[]>(() => {
        if (entities && entities.length > 0) {
            return entities;
        }
        return (dreaming.spotlightQueue ?? []).map((item) => ({
            id: item.entityId,
            name: item.label,
            role: item.triggered ? '已触发切镜' : `切镜蓄力 ${Math.round(item.progressPct)}%`,
            ...(walLock.lastCommittedChapter > 0
                ? { lastChapter: walLock.lastCommittedChapter }
                : {}),
            brief: item.triggered ? '待前台切镜出场' : '幕后蓄力中'
        }));
    }, [entities, dreaming.spotlightQueue, walLock.lastCommittedChapter]);

    // 实体数据来源：props.entities 已挂载或切镜队列已提供才算有真实实体口径
    const hasEntitySource = entities !== undefined || dreaming.spotlightQueue !== null;

    // 伏笔列表：优先使用 props.openThreads
    const resolvedThreads = useMemo<OpenThreadItem[]>(() => {
        if (openThreads && openThreads.length > 0) {
            return openThreads;
        }
        return [];
    }, [openThreads]);

    const triggeredSpotlightCount = (dreaming.spotlightQueue ?? []).filter(
        (item) => item.triggered
    ).length;

    // Dreaming 水位：count 与 threshold 都有真实数据才计算比例；null=未提供，不按 0 呈现
    const dirtyCount =
        typeof dreaming.dirtyEntityCount === 'number' &&
        Number.isFinite(dreaming.dirtyEntityCount)
            ? dreaming.dirtyEntityCount
            : null;
    const dirtyThreshold =
        typeof dreaming.dirtyThreshold === 'number' && Number.isFinite(dreaming.dirtyThreshold)
            ? dreaming.dirtyThreshold
            : null;
    const hasDirtyWatermark = dirtyCount !== null && dirtyThreshold !== null;
    const dirtyRatioPct =
        dirtyCount !== null && dirtyThreshold !== null && dirtyThreshold > 0
            ? Math.min(100, Math.round((dirtyCount / dirtyThreshold) * 100))
            : 0;

    // 写手预算：仅在静态/动态 tokens 均有测量时汇总；0 是合法测量值，undefined 才是缺失
    const hasAssemblyStats =
        typeof stageArtifact.staticPrefixTokens === 'number' &&
        Number.isFinite(stageArtifact.staticPrefixTokens) &&
        typeof stageArtifact.dynamicTailTokens === 'number' &&
        Number.isFinite(stageArtifact.dynamicTailTokens);
    const staticTokens = stageArtifact.staticPrefixTokens ?? 0;
    const dynamicTokens = stageArtifact.dynamicTailTokens ?? 0;
    const totalUsedTokens = staticTokens + dynamicTokens;
    const budgetLimit =
        typeof stageArtifact.budgetLimitTokens === 'number' &&
        Number.isFinite(stageArtifact.budgetLimitTokens)
            ? stageArtifact.budgetLimitTokens
            : 0;
    // 只有装配统计完整且预算为正时才画比例条；0 预算不除，缺测量不画固定条
    const hasBudgetBar = hasAssemblyStats && budgetLimit > 0;
    const staticPct = hasBudgetBar ? Math.min(100, (staticTokens / budgetLimit) * 100) : 0;
    const dynamicPct = hasBudgetBar
        ? Math.min(100 - staticPct, (dynamicTokens / budgetLimit) * 100)
        : 0;
    // 降级级数：undefined=未提供，不得按 0 级正常呈现
    const degradationLevel =
        typeof stageArtifact.degradationLevel === 'number' &&
        Number.isFinite(stageArtifact.degradationLevel)
            ? stageArtifact.degradationLevel
            : null;

    // 卷纲进度：完成数与目标都来自真实卷快照才计算百分比；不用 wal 章号顶替、不假定 20 章
    const volumeCompletedCh =
        typeof volumeProgress?.completedChapters === 'number' &&
        Number.isFinite(volumeProgress.completedChapters)
            ? volumeProgress.completedChapters
            : null;
    const volumeTotalCh =
        typeof volumeProgress?.totalChapters === 'number' &&
        Number.isFinite(volumeProgress.totalChapters) &&
        volumeProgress.totalChapters > 0
            ? volumeProgress.totalChapters
            : null;
    const volumePct =
        volumeCompletedCh !== null && volumeTotalCh !== null
            ? Math.min(100, Math.round((volumeCompletedCh / volumeTotalCh) * 100))
            : null;

    // Token 占比条 (遥测分组)：四项互不重叠，input 已是未缓存输入，不再二次扣减
    const inputTokens = Math.max(0, modelPool.inputTokens);
    const cacheReadTokens = Math.max(0, modelPool.cacheReadTokens);
    const cacheWriteTokens = Math.max(0, modelPool.cacheWriteTokens ?? 0);
    const outputTokens = Math.max(0, modelPool.outputTokens ?? 0);
    const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
    const barTotalTokens = Math.max(1, totalTokens);

    const toggleGroup = (key: InspectorSubtabKey): void => {
        setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    const expandAllGroups = (): void => {
        setExpandedGroups(ALL_EXPANDED_GROUPS);
    };

    const collapseAllGroups = (): void => {
        setExpandedGroups(ALL_COLLAPSED_GROUPS);
    };

    // 统一渲染手风琴分组：组头常驻摘要与告警圆点，body 通过 hidden 折叠
    const renderGroup = (
        key: InspectorSubtabKey,
        title: string,
        summary: React.ReactNode,
        body: React.ReactNode
    ): React.ReactElement => {
        const isOpen = expandedGroups[key];
        return (
            <section className="ns-i-acc">
                <button
                    type="button"
                    className="ns-i-acc-head"
                    aria-expanded={isOpen}
                    aria-controls={`ns-i-body-${key}`}
                    onClick={() => toggleGroup(key)}
                >
                    <span className="ns-i-acc-title">{title}</span>
                    {summary}
                    {key === 'git' && hasHalt && (
                        <span
                            className="ns-i-dot ns-i-dot-red"
                            role="img"
                            aria-label="存在 SAFE_HALT 告警"
                        />
                    )}
                    {key === 'gate' && hasGateAlert && (
                        <span
                            className="ns-i-dot ns-i-dot-amber"
                            role="img"
                            aria-label="存在门禁告警"
                        />
                    )}
                    <span className="ns-i-chevron" aria-hidden="true">
                        ›
                    </span>
                </button>
                <div className="ns-i-acc-body" id={`ns-i-body-${key}`} hidden={!isOpen}>
                    {body}
                </div>
            </section>
        );
    };

    return (
        <div className="ns-ops-inspector" aria-label="运维检查器">
            {/* 顶部工具行：标题与批量展开/收起 */}
            <div className="ns-i-toolbar">
                <span className="ns-i-toolbar-title">运维检查器</span>
                <div className="ns-i-toolbar-actions">
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        aria-label="展开全部检查器分组"
                        onClick={expandAllGroups}
                    >
                        全部展开
                    </button>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        aria-label="收起全部检查器分组"
                        onClick={collapseAllGroups}
                    >
                        全部收起
                    </button>
                </div>
            </div>

            {/* 7 组手风琴卡片 */}
            <div className="ns-i-list">
                {/* 1. 遥测与健康度 */}
                {renderGroup(
                    'tel',
                    '遥测与健康度',
                    <span className="ns-i-sum ns-i-sum-quiet">
                        缓存 {cacheHitLabel}
                    </span>,
                    <>
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>静态前缀缓存命中</span>
                                <span className="ns-mono ns-i-green-ink">{cacheHitLabel}</span>
                            </div>
                            <div className="ns-i-big">
                                {cacheHitPct === null ? '未提供' : cacheHitPct.toFixed(1)}
                                {cacheHitPct !== null && (
                                    <small className="ns-i-big-unit">%</small>
                                )}
                            </div>
                            {cacheHitPct !== null && (
                                <div className="ns-prog-bar ns-i-prog-top">
                                    <div
                                        className="ns-prog-fill ns-i-fill-green"
                                        style={{ width: `${cacheHitPct}%` }}
                                    />
                                </div>
                            )}
                        </div>

                        {/* 四联指标卡片 */}
                        <div className="ns-kv-grid">
                            <div className="ns-metric">
                                <div className="ns-metric-k ns-i-metric-k-row">
                                    <span>MATTR-500</span>
                                    <span
                                        className={`ns-i-dot ${
                                            proseGate.mattr500 !== null
                                                ? 'ns-i-dot-green'
                                                : 'ns-i-dot-idle'
                                        }`}
                                        aria-hidden="true"
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.mattr500)}
                                </div>
                                <div className="ns-i-metric-note">词汇多样性</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k ns-i-metric-k-row">
                                    <span>Kontoyiannis H_K</span>
                                    <span
                                        className={`ns-i-dot ${
                                            proseGate.kontoyiannisEntropy !== null
                                                ? 'ns-i-dot-green'
                                                : 'ns-i-dot-idle'
                                        }`}
                                        aria-hidden="true"
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.kontoyiannisEntropy)}
                                </div>
                                <div className="ns-i-metric-note">信息熵率</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k ns-i-metric-k-row">
                                    <span>句段长 CV</span>
                                    <span
                                        className={`ns-i-dot ${
                                            proseGate.sentenceLengthCv !== null
                                                ? 'ns-i-dot-green'
                                                : 'ns-i-dot-idle'
                                        }`}
                                        aria-hidden="true"
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.sentenceLengthCv)}
                                </div>
                                <div className="ns-i-metric-note">节奏变化</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k ns-i-metric-k-row">
                                    <span>AI 八股千字密度</span>
                                    <span
                                        className={`ns-i-dot ${
                                            proseGate.clicheDensityPer1k !== null
                                                ? proseGate.clicheDensityPer1k > 1.5
                                                    ? 'ns-i-dot-amber'
                                                    : 'ns-i-dot-green'
                                                : 'ns-i-dot-idle'
                                        }`}
                                        aria-hidden="true"
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.clicheDensityPer1k)}
                                </div>
                                <div className="ns-i-metric-note">/千字</div>
                            </div>
                        </div>

                        {/* 章节生成累计 Token 分布（只统计已记录的章节生成，不是全书总成本） */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>章节生成累计 Token</span>
                                <span className="ns-mono ns-i-head-value">
                                    {formatTokenCount(totalTokens)}
                                </span>
                            </div>
                            <div className="ns-i-bar">
                                <div
                                    className="ns-i-bar-seg ns-i-seg-in"
                                    title={`未缓存输入 ${formatTokenCount(inputTokens)}`}
                                    style={{
                                        width: `${(inputTokens / barTotalTokens) * 100}%`
                                    }}
                                />
                                <div
                                    className="ns-i-bar-seg ns-i-seg-green"
                                    title={`缓存读取 ${formatTokenCount(cacheReadTokens)}`}
                                    style={{
                                        width: `${(cacheReadTokens / barTotalTokens) * 100}%`
                                    }}
                                />
                                <div
                                    className="ns-i-bar-seg ns-i-seg-amber"
                                    title={`缓存写入 ${formatTokenCount(cacheWriteTokens)}`}
                                    style={{
                                        width: `${(cacheWriteTokens / barTotalTokens) * 100}%`
                                    }}
                                />
                                <div
                                    className="ns-i-bar-seg ns-i-seg-brand"
                                    title={`输出 ${formatTokenCount(outputTokens)}`}
                                    style={{
                                        width: `${(outputTokens / barTotalTokens) * 100}%`
                                    }}
                                />
                            </div>
                            <div className="ns-mono ns-i-bar-legend">
                                <span>
                                    in {formatTokenCount(inputTokens)} - read{' '}
                                    {formatTokenCount(cacheReadTokens)} - write{' '}
                                    {formatTokenCount(cacheWriteTokens)} - out{' '}
                                    {formatTokenCount(outputTokens)}
                                </span>
                            </div>
                            <div className="ns-i-scope-note">
                                只统计已记录的章节生成；不含开书、手改同步与整理消耗，不是全书总成本。
                            </div>
                        </div>
                    </>
                )}

                {/* 2. 净室装配审计 */}
                {renderGroup(
                    'ctx',
                    '净室装配审计',
                    <span className="ns-i-sum ns-i-sum-quiet">
                        {hasAssemblyStats
                            ? budgetLimit > 0
                                ? `${formatTokenCount(totalUsedTokens)}/${formatTokenCount(budgetLimit)}`
                                : `${formatTokenCount(totalUsedTokens)} tok`
                            : '装配统计未提供'}
                    </span>,
                    <>
                        {/* 三池模型路由 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>三池模型路由 (modelRouting)</span>
                            </div>
                            <div className="ns-i-route-list">
                                <div className="ns-i-route">
                                    <span className="ns-i-route-name">
                                        {POOL_LABELS.strong_creative} (strong_creative)
                                    </span>
                                    <span
                                        className="ns-mono ns-i-route-model ns-i-route-model-brand"
                                        title={resolvedRouting.strong_creative}
                                    >
                                        {resolvedRouting.strong_creative}
                                    </span>
                                    <span className="ns-i-route-role">Planner - Writer</span>
                                </div>
                                <div className="ns-i-route">
                                    <span className="ns-i-route-name">
                                        {POOL_LABELS.fast_retrieval} (fast_retrieval)
                                    </span>
                                    <span
                                        className="ns-mono ns-i-route-model ns-i-route-model-green"
                                        title={resolvedRouting.fast_retrieval}
                                    >
                                        {resolvedRouting.fast_retrieval}
                                    </span>
                                    <span className="ns-i-route-role">Librarian</span>
                                </div>
                                <div className="ns-i-route">
                                    <span className="ns-i-route-name">
                                        {POOL_LABELS.audit} (audit)
                                    </span>
                                    <span
                                        className="ns-mono ns-i-route-model ns-i-route-model-amber"
                                        title={resolvedRouting.audit}
                                    >
                                        {resolvedRouting.audit}
                                    </span>
                                    <span className="ns-i-route-role">Fact Checker</span>
                                </div>
                            </div>
                        </div>

                        {/* 静态前缀与 budget 降级状态：仅有真实测量时才画比例与级别 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>写手窗口与 budget 降级</span>
                                <span
                                    className={
                                        degradationLevel === null
                                            ? 'ns-pill ns-pill-muted'
                                            : degradationLevel > 0
                                                ? 'ns-pill ns-pill-amber'
                                                : 'ns-pill ns-pill-green'
                                    }
                                >
                                    {degradationLevel === null
                                        ? '降级级别未提供'
                                        : degradationLevel > 0
                                            ? `降级 ${degradationLevel} 级`
                                            : '0 级正常'}
                                </span>
                            </div>
                            {hasAssemblyStats ? (
                                <>
                                    <div className="ns-mono ns-i-budget-total">
                                        {budgetLimit > 0
                                            ? `${formatTokenCount(totalUsedTokens)} / ${formatTokenCount(budgetLimit)}`
                                            : `总装配 ${formatTokenCount(totalUsedTokens)} tokens`}
                                    </div>
                                    {hasBudgetBar && (
                                        <div className="ns-i-bar">
                                            <div
                                                className="ns-i-bar-seg ns-i-seg-brand"
                                                style={{ width: `${staticPct}%` }}
                                            />
                                            <div
                                                className="ns-i-bar-seg ns-i-seg-green"
                                                style={{ width: `${dynamicPct}%` }}
                                            />
                                        </div>
                                    )}
                                    <div className="ns-i-budget-legend">
                                        <span>静态前缀 {formatTokenCount(staticTokens)}</span>
                                        <span>动态尾 {formatTokenCount(dynamicTokens)}</span>
                                        {!hasBudgetBar && <span>预算上限未提供，不计算占比</span>}
                                    </div>
                                </>
                            ) : (
                                <div className="ns-i-empty">
                                    未提供装配统计，无法呈现 token 用量与预算占比。
                                </div>
                            )}
                        </div>

                        {/* 当前阶段产物摘要 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>
                                    阶段 #{stageArtifact.selectedStageIndex + 1} -{' '}
                                    {stageArtifact.stageName}
                                </span>
                                <span className="ns-pill ns-pill-brand">
                                    {stageArtifact.stageStatus || '就绪'}
                                </span>
                            </div>
                            <div className="ns-i-text-2">{stageArtifact.stageSummary}</div>
                            {stageArtifact.voiceLruSummary && (
                                <div className="ns-i-text-3">
                                    <span className="ns-i-strong">声纹 LRU</span>: {stageArtifact.voiceLruSummary}
                                </div>
                            )}
                            {stageArtifact.strippedItemsSummary && (
                                <div className="ns-i-text-3 ns-i-green-ink">
                                    <span className="ns-i-strong">物理剥离</span>: {stageArtifact.strippedItemsSummary}
                                </div>
                            )}
                            {stageArtifact.sessionId && (
                                <div className="ns-i-stage-session-row">
                                    <span className="ns-mono ns-i-muted">
                                        session: {stageArtifact.sessionId}
                                    </span>
                                    {onInspectStageSession && (
                                        <button
                                            type="button"
                                            className="ns-btn ns-btn-ghost ns-btn-xs"
                                            onClick={() => onInspectStageSession(stageArtifact.sessionId!)}
                                        >
                                            查看原生轨迹
                                        </button>
                                    )}
                                </div>
                            )}
                            {stageArtifact.sessions && stageArtifact.sessions.length > 0 && (
                                <div className="ns-i-stage-sessions" aria-label="关联会话轨迹列表">
                                    <div className="ns-i-stage-sessions-title">
                                        关联会话轨迹列表 ({stageArtifact.sessions.length})
                                    </div>
                                    <div className="ns-i-stage-sessions-list">
                                        {stageArtifact.sessions.map((item, idx) => (
                                            <button
                                                key={item.sessionId || `${item.stage}-${idx}`}
                                                type="button"
                                                className="ns-i-stage-session-item"
                                                data-attempt-session-id={item.sessionId}
                                                disabled={!onInspectStageSession}
                                                onClick={() => onInspectStageSession?.(item.sessionId)}
                                            >
                                                <span className="ns-i-stage-session-main">
                                                    <span className="ns-mono ns-i-stage-session-stage">
                                                        {item.stage}
                                                        {typeof item.attempt === 'number'
                                                            ? ` #${item.attempt}`
                                                            : ''}
                                                    </span>
                                                    <span className="ns-pill ns-pill-muted ns-mono">
                                                        {item.status}
                                                    </span>
                                                </span>
                                                {item.triggerReason ? (
                                                    <span className="ns-i-stage-session-reason">
                                                        {item.triggerReason}
                                                    </span>
                                                ) : null}
                                                <span className="ns-mono ns-i-muted ns-i-stage-session-id">
                                                    {item.sessionId}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* 3. 活跃实体 */}
                {renderGroup(
                    'ent',
                    '活跃实体',
                    <span className="ns-i-sum ns-i-sum-quiet">
                        {hasEntitySource ? `${resolvedEntities.length} 实体` : '实体数未提供'}
                    </span>,
                    <div className="ns-i-card">
                        <div className="ns-i-card-head">
                            <span>活跃实体列表</span>
                            <span className="ns-mono ns-i-muted">
                                {hasEntitySource ? `${resolvedEntities.length} 活跃` : '活跃数未提供'} -{' '}
                                {dreaming.coldArchiveCount} 冷归档
                            </span>
                        </div>
                        {!hasEntitySource ? (
                            <div className="ns-i-empty">
                                未提供活跃实体与切镜信号数据，无法呈现实体列表。
                            </div>
                        ) : resolvedEntities.length === 0 ? (
                            <div className="ns-i-empty">
                                暂无活跃实体记录，可在运行写章或刷新工作区后查看。
                            </div>
                        ) : (
                            <div className="ns-i-entity-list">
                                {resolvedEntities.map((ent) => {
                                    const isExpanded = expandedEntityId === ent.id;
                                    return (
                                        <div
                                            key={ent.id}
                                            className={`ns-i-entity${
                                                ent.warped ? ' ns-i-entity-warped' : ''
                                            }`}
                                        >
                                            <button
                                                type="button"
                                                className="ns-i-entity-btn"
                                                onClick={() => {
                                                    setExpandedEntityId(isExpanded ? null : ent.id);
                                                    if (onSelectEntity) {
                                                        onSelectEntity(ent.id, ent.lastChapter);
                                                    } else if (ent.lastChapter && onSelectChapter) {
                                                        onSelectChapter(ent.lastChapter);
                                                    }
                                                }}
                                            >
                                                <span
                                                    className={`ns-i-entity-avatar${
                                                        ent.warped
                                                            ? ' ns-i-entity-avatar-warped'
                                                            : ''
                                                    }`}
                                                    aria-hidden="true"
                                                >
                                                    {ent.name.slice(0, 1) || '?'}
                                                </span>
                                                <span className="ns-i-entity-main">
                                                    <span className="ns-i-entity-name">
                                                        {ent.name}
                                                    </span>
                                                    <span className="ns-mono ns-i-entity-meta">
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
                                                <div className="ns-i-entity-brief">{ent.brief}</div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* 4. 伏笔 · Spotlight · Dreaming 水位 */}
                {renderGroup(
                    'arc',
                    '伏笔·Spotlight·Dreaming 水位',
                    <span className="ns-i-sum ns-i-sum-quiet">
                        {triggeredSpotlightCount > 0
                            ? `切镜 ${triggeredSpotlightCount}`
                            : `伏笔 ${resolvedThreads.length}`}
                    </span>,
                    <>
                        {/* Spotlight Trigger 信号队列：null=未提供，[]=真实无信号 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>Spotlight Trigger 信号</span>
                                <span
                                    className={
                                        dreaming.spotlightQueue === null
                                            ? 'ns-mono ns-i-muted'
                                            : 'ns-mono ns-i-amber-ink'
                                    }
                                >
                                    {dreaming.spotlightQueue === null
                                        ? '未提供'
                                        : `${dreaming.spotlightQueue.length} 项`}
                                </span>
                            </div>
                            {dreaming.spotlightQueue === null ? (
                                <div className="ns-i-empty">
                                    未提供切镜信号数据，无法判断是否存在待切镜幕后角色。
                                </div>
                            ) : dreaming.spotlightQueue.length === 0 ? (
                                <div className="ns-i-empty">暂无待切镜幕后角色信号</div>
                            ) : (
                                dreaming.spotlightQueue.map((item) => {
                                    const pct = Math.min(100, Math.max(0, item.progressPct));
                                    return (
                                        <div key={item.entityId} className="ns-i-spotlight-item">
                                            <div className="ns-i-spotlight-row">
                                                <span className="ns-i-spotlight-label">
                                                    {item.label}{' '}
                                                    <span className="ns-mono ns-i-muted">
                                                        ({item.entityId})
                                                    </span>
                                                </span>
                                                <span className="ns-mono">
                                                    {Math.round(pct)}%
                                                    {item.triggered ? ' - 已触发' : ''}
                                                </span>
                                            </div>
                                            <div className="ns-prog-bar ns-i-prog-flat">
                                                <div
                                                    className={`ns-prog-fill ${
                                                        item.triggered
                                                            ? 'ns-i-fill-amber'
                                                            : 'ns-i-fill-brand'
                                                    }`}
                                                    style={{ width: `${pct}%` }}
                                                />
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>

                        {/* open_threads 跨卷伏笔 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>跨卷伏笔 (open_threads)</span>
                                <span className="ns-mono">{resolvedThreads.length}</span>
                            </div>
                            {resolvedThreads.length === 0 ? (
                                <div className="ns-i-empty">
                                    当前未挂载单独的 open_threads 明细。
                                </div>
                            ) : (
                                <div className="ns-i-thread-list">
                                    {resolvedThreads.map((thd, idx) => (
                                        <div
                                            key={thd.id ?? `${thd.title}-${idx}`}
                                            className="ns-i-thread"
                                        >
                                            <span className="ns-mono ns-i-thread-ch">
                                                {typeof thd.chapter === 'number'
                                                    ? `Ch.${thd.chapter}`
                                                    : '--'}
                                            </span>
                                            <div className="ns-i-thread-main">
                                                <div className="ns-i-thread-title">{thd.title}</div>
                                                {thd.hint && (
                                                    <div className="ns-i-thread-hint">{thd.hint}</div>
                                                )}
                                            </div>
                                            {thd.scope && (
                                                <span className="ns-pill ns-pill-brand">
                                                    {thd.scope}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Dreaming 脏页水位：仅有真实 count/threshold 时画水位条 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>Dreaming 脏页水位</span>
                                <span className={hasDirtyWatermark ? 'ns-mono' : 'ns-mono ns-i-muted'}>
                                    {hasDirtyWatermark
                                        ? `${dirtyCount} / ${dirtyThreshold} (${dirtyRatioPct}%)`
                                        : '未提供水位数据'}
                                </span>
                            </div>
                            {hasDirtyWatermark ? (
                                <div className="ns-prog-bar ns-i-prog-flat">
                                    <div
                                        className="ns-prog-fill ns-i-fill-violet"
                                        style={{ width: `${dirtyRatioPct}%` }}
                                    />
                                </div>
                            ) : (
                                <div className="ns-i-empty">
                                    服务未提供脏实体计数与触发阈值，暂无法呈现水位。
                                </div>
                            )}
                            {onTriggerDreaming && (
                                <button
                                    type="button"
                                    className="ns-btn ns-btn-ghost ns-btn-sm"
                                    onClick={onTriggerDreaming}
                                    disabled={busy}
                                >
                                    立即执行 Dreaming (VACUUM)
                                </button>
                            )}
                        </div>
                    </>
                )}

                {/* 5. Git WAL 与提交 */}
                {renderGroup(
                    'git',
                    'Git WAL 与提交',
                    <span className={`ns-i-sum ${resolveWalBadgeClass(walLock.walPhase)}`}>
                        {walLock.walPhase}
                    </span>,
                    <>
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>WAL 相位状态</span>
                                <span className={resolveWalBadgeClass(walLock.walPhase)}>
                                    {walLock.walPhase}
                                </span>
                            </div>
                            <div className="ns-i-wal-grid">
                                {WAL_PHASES.map((phase) => {
                                    const stepSt = resolveWalPhaseStepStatus(
                                        phase,
                                        walLock.walPhase
                                    );
                                    return (
                                        <div
                                            key={phase}
                                            className={`ns-mono ns-i-wal-cell ns-i-wal-${stepSt}`}
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
                                        className={`ns-metric-v ns-mono ${
                                            walLock.txLockStatus === 'locked'
                                                ? 'ns-i-amber-ink'
                                                : 'ns-i-green-ink'
                                        }`}
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
                                <div className="ns-mono ns-i-lock-holder">
                                    锁持有者: {walLock.txLockHolder}
                                </div>
                            )}
                            {(walLock.featCommitSha || walLock.stateCommitSha) && (
                                <div className="ns-mono ns-i-commit-sha">
                                    feat: {walLock.featCommitSha ? walLock.featCommitSha.slice(0, 7) : '--'}{' '}
                                    - state:{' '}
                                    {walLock.stateCommitSha
                                        ? walLock.stateCommitSha.slice(0, 7)
                                        : '--'}
                                </div>
                            )}
                        </div>

                        {/* SAFE_HALT / QUARANTINED 诊断块 */}
                        {hasHalt && haltDiagnostic && (
                            <div className="ns-i-card ns-i-card-halt">
                                <div className="ns-i-card-head">
                                    <span className="ns-i-red-ink">
                                        {haltDiagnostic.kind} - 冲突诊断
                                    </span>
                                    <span className="ns-pill ns-pill-red">
                                        {haltDiagnostic.kind}
                                    </span>
                                </div>
                                <div className="ns-i-halt-reason">{haltDiagnostic.reason}</div>
                                {(haltDiagnostic.leftRef || haltDiagnostic.rightRef) && (
                                    <div className="ns-mono ns-i-halt-refs">
                                        <div>
                                            冲突双侧: {haltDiagnostic.leftRef || '--'} vs{' '}
                                            {haltDiagnostic.rightRef || '--'}
                                        </div>
                                        {haltDiagnostic.leftExcerpt && (
                                            <div className="ns-i-halt-excerpt">
                                                [前文] {haltDiagnostic.leftExcerpt}
                                            </div>
                                        )}
                                        {haltDiagnostic.rightExcerpt && (
                                            <div className="ns-i-halt-excerpt-tight">
                                                [当章] {haltDiagnostic.rightExcerpt}
                                            </div>
                                        )}
                                    </div>
                                )}
                                {typeof haltDiagnostic.affectedChapters === 'number' && (
                                    <div className="ns-mono ns-i-halt-scope">
                                        波及范围: {haltDiagnostic.affectedChapters} 章
                                        {typeof haltDiagnostic.rollbackThreshold === 'number'
                                            ? ` (自动回滚阈值 ${haltDiagnostic.rollbackThreshold} 章)`
                                            : ''}
                                    </div>
                                )}
                                {onInspectHalt && (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-stop ns-btn-sm"
                                        onClick={onInspectHalt}
                                    >
                                        定位冲突快照与恢复方案
                                    </button>
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* 6. 卷纲进度：完成数与目标齐全才画百分比；全书提交数单独标注 */}
                {renderGroup(
                    'vol',
                    '卷纲进度',
                    <span className="ns-i-sum ns-i-sum-quiet">
                        {volumePct !== null ? `${volumePct}%` : '目标未提供'}
                    </span>,
                    <>
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>
                                    {volumeProgress?.volumeLabel || '当前卷进度'}
                                    {volumeProgress?.volumeTitle
                                        ? ` - ${volumeProgress.volumeTitle}`
                                        : ''}
                                </span>
                                <span
                                    className={volumePct !== null ? 'ns-mono' : 'ns-mono ns-i-muted'}
                                >
                                    {volumePct !== null
                                        ? `${volumeCompletedCh} / ${volumeTotalCh} (${volumePct}%)`
                                        : volumeCompletedCh !== null
                                            ? `已完成 ${volumeCompletedCh} 章 - 目标未提供`
                                            : '当前卷完成数未提供'}
                                </span>
                            </div>
                            {volumePct !== null ? (
                                <div className="ns-prog-bar ns-i-prog-flat">
                                    <div
                                        className="ns-prog-fill"
                                        style={{ width: `${volumePct}%` }}
                                    />
                                </div>
                            ) : (
                                <div className="ns-i-empty">
                                    {volumeCompletedCh === null
                                        ? '未提供当前卷完成数与目标章数，不绘制进度比例。'
                                        : '未提供当前卷目标章数，不绘制进度比例。'}
                                </div>
                            )}
                            <div className="ns-i-vol-meta">
                                <span>timeline_mode: {walLock.timelineMode}</span>
                                <span>全书已提交 {walLock.lastCommittedChapter} 章</span>
                            </div>
                        </div>

                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>future_horizon 与细纲摘要</span>
                            </div>
                            <div className="ns-i-future">
                                {volumeProgress?.futureHorizon ||
                                    stageArtifact.outlineSummary ||
                                    '暂无 future_horizon 文本，将在 Planner 产出细纲后同步展示。'}
                            </div>
                            {volumeProgress?.milestoneLock && (
                                <div className="ns-i-milestone">
                                    <span className="ns-i-strong">终局/里程碑锁</span>: {volumeProgress.milestoneLock}
                                </div>
                            )}
                        </div>
                    </>
                )}

                {/* 7. 静态门禁与核查 */}
                {renderGroup(
                    'gate',
                    '静态门禁与核查',
                    <span
                        className={`ns-i-sum ${
                            proseGate.recentViolations.length > 0
                                ? 'ns-i-sum-alert'
                                : 'ns-i-sum-quiet'
                        }`}
                    >
                        命中 {proseGate.recentViolations.length}
                    </span>,
                    <>
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
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
                            <div className="ns-i-rule-list">
                                {gateRuleStats.map((rule) => {
                                    const triggered = rule.hits > 0;
                                    return (
                                        <div key={rule.id} className="ns-i-rule">
                                            <div className="ns-i-rule-main">
                                                <div className="ns-mono ns-i-rule-id">
                                                    {rule.id}
                                                </div>
                                                <div className="ns-i-rule-label">
                                                    {rule.label}
                                                </div>
                                            </div>
                                            <span
                                                className={`ns-mono ns-i-rule-count${
                                                    triggered ? ' ns-i-rule-count-on' : ''
                                                }`}
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
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
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

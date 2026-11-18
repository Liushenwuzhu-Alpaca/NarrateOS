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
    auditModel?: string | undefined;
    /** 未缓存输入 Token（与缓存读取/写入互不重叠） */
    inputTokens: number;
    cacheReadTokens: number;
    /** 缓存写入 Token；旧调用方可缺省按 0，生产端始终传入 */
    cacheWriteTokens?: number;
    outputTokens?: number;
}

/** 双池模型路由明细 (兼容 modelRouting 配置对象) */
export interface ModelRoutingSnapshot {
    strong_creative?: string;
    fast_retrieval?: string;
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

/** 5. Checker & 双侧原句验真 */
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
    accumulatedWords?: number | undefined;
    wordThreshold?: number | undefined;
}

/** 冲突证据明细项 */
export interface HaltDiagnosticIssueItem {
    description?: string | undefined;
    quote_draft?: string | undefined;
    quote_source?: string | undefined;
    source_ref?: string | undefined;
    severity?: string | undefined;
    rule?: string | undefined;
    line?: number | undefined;
}

/** 7. SAFE_HALT / QUARANTINED 诊断 */
export interface HaltDiagnosticInfo {
    kind: 'SAFE_HALT' | 'QUARANTINED';
    reason: string;
    leftRef?: string;
    rightRef?: string;
    leftLine?: number | null | undefined;
    rightLine?: number | null | undefined;
    leftExcerpt?: string;
    rightExcerpt?: string;
    affectedChapters?: number;
    affectedWords?: number | undefined;
    rollbackThreshold?: number;
    issues?: HaltDiagnosticIssueItem[] | undefined;
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

/** Dreaming 字数水位快照 (对应 .ops/dream_watermark.json) */
export interface DreamWatermarkSnapshot {
    last_dream_ch?: number | undefined;
    accumulated_words_since_dream?: number | undefined;
    word_threshold?: number | undefined;
    updated_at?: string | undefined;
}

/** 当前章节装配选中的声纹样本摘要 */
export interface SelectedVoiceSampleSnapshot {
    id?: string | undefined;
    tag?: string | undefined;
    text?: string | undefined;
}

/** 右栏「运行状态」检查器 Props */
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
    /** 真实双池模型路由配置 (可选，缺省回退至 modelPool) */
    modelRouting?: ModelRoutingSnapshot | null;
    /** 活跃实体列表 (可选) */
    entities?: InspectorEntityItem[];
    /** 未收伏笔列表 (可选) */
    openThreads?: OpenThreadItem[];
    /** 当前卷纲进度与 future_horizon (可选) */
    volumeProgress?: VolumeProgressSnapshot | null;
    /** Dreaming 字数水位快照 (可选) */
    dreamWatermark?: DreamWatermarkSnapshot | null | undefined;
    /** 写手净室装配选中的声纹标本 (可选) */
    selectedVoiceSample?: SelectedVoiceSampleSnapshot | null | undefined;
    /** 写手净室自动屏蔽的秘密与废案项数 (可选) */
    strippedSecretCount?: number | undefined;
    /** 点击实体跳转中栏查看回调 (可选) */
    onSelectEntity?: (entityId: string, lastChapter?: number) => void;
    /** 点击章节跳转中栏查看回调 (可选) */
    onSelectChapter?: (chapter: number) => void;
    /** 点击当前阶段绑定的 Session ID，切至右侧思考过程视图 */
    onInspectStageSession?: (sessionId: string) => void;
}

interface CoreGateRuleDef {
    id: string;
    label: string;
    threshold: string;
}

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

function formatWordCount(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

function normalizeCheckerLabel(raw: string): string {
    return raw.replace(/fact[\s_-]*checker/gi, 'Checker').replace(/fact[\s_-]*check/gi, 'Checker');
}

function formatConflictRefWithLine(ref: string | undefined, line: number | null | undefined): string {
    if (!ref) return '--';
    return typeof line === 'number' && Number.isFinite(line) ? `${ref}:${line}` : ref;
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
    if (idx < 0) return 'idle';
    if (stepIdx < idx) return 'done';
    if (stepIdx === idx) return 'cur';
    return 'idle';
}

function formatWordWatermarkLabel(
    accumulatedWords: number | null,
    wordThreshold: number | null
): string {
    if (accumulatedWords !== null && wordThreshold !== null) {
        return `${formatWordCount(accumulatedWords)} / ${formatWordCount(wordThreshold)} 字`;
    }
    if (accumulatedWords !== null) {
        return `${formatWordCount(accumulatedWords)} 字`;
    }
    return '字数水位未提供';
}

function formatAssemblyBadgeLabel(
    hasAssemblyStats: boolean,
    totalUsedTokens: number,
    budgetLimit: number
): string {
    if (!hasAssemblyStats) return '装配统计未提供';
    if (budgetLimit > 0) {
        return `${formatTokenCount(totalUsedTokens)} / ${formatTokenCount(budgetLimit)}`;
    }
    return `${formatTokenCount(totalUsedTokens)} tok`;
}

function resolveDegradationBadge(degradationLevel: number | null): {
    pillClass: string;
    label: string;
} {
    if (degradationLevel === null) {
        return { pillClass: 'ns-pill ns-pill-muted', label: '降级级别未提供' };
    }
    if (degradationLevel > 0) {
        return { pillClass: 'ns-pill ns-pill-amber', label: `降级 ${degradationLevel} 级` };
    }
    return { pillClass: 'ns-pill ns-pill-green', label: '0 级正常' };
}

function resolveProseGateBadge(
    violationCount: number,
    hasAnyMetric: boolean
): { pillClass: string; label: string } {
    if (violationCount > 0) {
        return { pillClass: 'ns-pill ns-pill-amber', label: `命中 ${violationCount} 处` };
    }
    if (hasAnyMetric) {
        return { pillClass: 'ns-pill ns-pill-green', label: '通过' };
    }
    return { pillClass: 'ns-pill ns-pill-muted', label: '待检测' };
}

function resolveProseMetricDotClass(value: number | null, warnAbove?: number): string {
    if (value === null) return 'ns-i-dot ns-i-dot-idle';
    if (warnAbove !== undefined && value > warnAbove) return 'ns-i-dot ns-i-dot-amber';
    return 'ns-i-dot ns-i-dot-green';
}

function resolveGateRuleStatusText(triggered: boolean, patchedCount: number): string {
    if (!triggered) return '通过';
    return patchedCount > 0 ? '已 Patch' : '命中';
}

function formatVolumeProgressLabel(
    completed: number | null,
    total: number | null,
    pct: number | null
): string {
    if (pct !== null) return `${completed} / ${total} (${pct}%)`;
    if (completed !== null) return `已完成 ${completed} 章 - 目标未提供`;
    return '目标未提供';
}

const MODEL_ROUTE_DESCRIPTORS: ReadonlyArray<{
    poolId: keyof ModelRoutingSnapshot;
    modelClass: string;
    roles: string;
}> = [
    {
        poolId: 'strong_creative',
        modelClass: 'ns-mono ns-i-route-model ns-i-route-model-brand',
        roles: 'Planner · Writer · Checker · Patch · Dreamer'
    },
    {
        poolId: 'fast_retrieval',
        modelClass: 'ns-mono ns-i-route-model ns-i-route-model-green',
        roles: 'Librarian · Extractor'
    }
];

function renderAssemblyStatsBody(options: {
    hasAssemblyStats: boolean;
    staticTokens: number;
    dynamicTokens: number;
    totalUsedTokens: number;
    budgetLimit: number;
    hasBudgetBar: boolean;
    staticPct: number;
    dynamicPct: number;
}): React.ReactElement {
    const {
        hasAssemblyStats,
        staticTokens,
        dynamicTokens,
        totalUsedTokens,
        budgetLimit,
        hasBudgetBar,
        staticPct,
        dynamicPct
    } = options;
    if (!hasAssemblyStats) {
        return (
            <div className="ns-i-empty">
                未提供装配统计，无法呈现 token 用量与预算占比。
            </div>
        );
    }

    return (
        <>
            <div className="ns-stat-row">
                <span>固定背景与人物声纹</span>
                <span className="ns-mono">{formatTokenCount(staticTokens)} Token</span>
            </div>
            <div className="ns-stat-row">
                <span>前文片段与本章细纲</span>
                <span className="ns-mono">{formatTokenCount(dynamicTokens)} Token</span>
            </div>
            <div className="ns-stat-row">
                <span>预算上限与总装配</span>
                <span className="ns-mono">
                    {budgetLimit > 0
                        ? `${formatTokenCount(totalUsedTokens)} / ${formatTokenCount(budgetLimit)}`
                        : `总装配 ${formatTokenCount(totalUsedTokens)} tokens`}
                </span>
            </div>
            {hasBudgetBar ? (
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
            ) : (
                <div className="ns-i-empty">预算上限未提供，不计算占比</div>
            )}
        </>
    );
}

function renderStageSessionRow(
    sessionId: string | null | undefined,
    onInspectStageSession?: (sessionId: string) => void
): React.ReactNode {
    if (!sessionId) return null;
    return (
        <div className="ns-i-stage-session-row">
            <span className="ns-mono ns-i-muted">session: {sessionId}</span>
            {onInspectStageSession ? (
                <button
                    type="button"
                    className="ns-btn ns-btn-ghost ns-btn-xs"
                    onClick={() => onInspectStageSession(sessionId)}
                >
                    查看思考过程
                </button>
            ) : null}
        </div>
    );
}

function renderVolumeProgressBody(
    volumeCompletedCh: number | null,
    volumePct: number | null
): React.ReactElement {
    if (volumePct !== null) {
        return (
            <div className="ns-prog-bar ns-i-prog-flat">
                <div className="ns-prog-fill" style={{ width: `${volumePct}%` }} />
            </div>
        );
    }
    return (
        <div className="ns-i-empty">
            {volumeCompletedCh === null
                ? '未提供当前卷完成数与目标章数，不绘制进度比例。'
                : '未提供当前卷目标章数，不绘制进度比例。'}
        </div>
    );
}

function renderSpotlightQueueBody(
    spotlightQueue: SpotlightQueueItem[] | null
): React.ReactNode {
    if (spotlightQueue === null) {
        return (
            <div className="ns-i-empty">
                未提供切镜信号数据，无法判断是否存在待切镜幕后角色。
            </div>
        );
    }
    if (spotlightQueue.length === 0) {
        return <div className="ns-i-empty">暂无待切镜幕后角色信号</div>;
    }
    return spotlightQueue.map((item) => {
        const pct = Math.min(100, Math.max(0, item.progressPct));
        return (
            <div key={item.entityId} className="ns-i-spotlight-item">
                <div className="ns-i-spotlight-row">
                    <span className="ns-i-spotlight-label">
                        {item.label}{' '}
                        <span className="ns-mono ns-i-muted">({item.entityId})</span>
                    </span>
                    <span className="ns-mono">
                        {Math.round(pct)}%
                        {item.triggered ? ' - 已触发' : ''}
                    </span>
                </div>
                <div className="ns-prog-bar ns-i-prog-flat">
                    <div
                        className={`ns-prog-fill ${
                            item.triggered ? 'ns-i-fill-amber' : 'ns-i-fill-brand'
                        }`}
                        style={{ width: `${pct}%` }}
                    />
                </div>
            </div>
        );
    });
}

function renderEntitiesBody(options: {
    hasEntitySource: boolean;
    resolvedEntities: readonly InspectorEntityItem[];
    expandedEntityId: string | null;
    onToggleEntity: (id: string | null) => void;
    onSelectEntity?: ((entityId: string, lastChapter?: number) => void) | undefined;
    onSelectChapter?: ((chapter: number) => void) | undefined;
}): React.ReactElement {
    const {
        hasEntitySource,
        resolvedEntities,
        expandedEntityId,
        onToggleEntity,
        onSelectEntity,
        onSelectChapter
    } = options;
    if (!hasEntitySource) {
        return (
            <div className="ns-i-empty">
                未提供活跃实体与切镜信号数据，无法呈现实体列表。
            </div>
        );
    }
    if (resolvedEntities.length === 0) {
        return (
            <div className="ns-i-empty">
                暂无活跃实体记录，可在运行写章或刷新工作区后查看。
            </div>
        );
    }
    return (
        <div className="ns-i-entity-list">
            {resolvedEntities.map((ent) => {
                const isExpanded = expandedEntityId === ent.id;
                return (
                    <div
                        key={ent.id}
                        className={`ns-i-entity${ent.warped ? ' ns-i-entity-warped' : ''}`}
                    >
                        <button
                            type="button"
                            className="ns-i-entity-btn"
                            onClick={() => {
                                onToggleEntity(isExpanded ? null : ent.id);
                                if (onSelectEntity) {
                                    onSelectEntity(ent.id, ent.lastChapter);
                                } else if (ent.lastChapter && onSelectChapter) {
                                    onSelectChapter(ent.lastChapter);
                                }
                            }}
                        >
                            <span
                                className={`ns-i-entity-avatar${
                                    ent.warped ? ' ns-i-entity-avatar-warped' : ''
                                }`}
                                aria-hidden="true"
                            >
                                {ent.name.slice(0, 1) || '?'}
                            </span>
                            <span className="ns-i-entity-main">
                                <span className="ns-i-entity-name">{ent.name}</span>
                                <span className="ns-mono ns-i-entity-meta">
                                    {ent.id}
                                    {ent.role ? ` - ${ent.role}` : ''}
                                </span>
                            </span>
                            {typeof ent.lastChapter === 'number' ? (
                                <span className="ns-pill ns-pill-muted ns-mono">
                                    Ch.{ent.lastChapter}
                                </span>
                            ) : null}
                        </button>
                        {ent.brief && (isExpanded || !onSelectEntity) ? (
                            <div className="ns-i-entity-brief">{ent.brief}</div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

function renderHaltRefsBlock(haltDiagnostic: HaltDiagnosticInfo): React.ReactNode {
    const hasRefs = Boolean(
        haltDiagnostic.leftRef ||
            haltDiagnostic.rightRef ||
            haltDiagnostic.leftExcerpt ||
            haltDiagnostic.rightExcerpt
    );
    if (!hasRefs) return null;
    return (
        <div className="ns-mono ns-i-halt-refs">
            <div>
                冲突双侧:{' '}
                {formatConflictRefWithLine(haltDiagnostic.leftRef, haltDiagnostic.leftLine)}{' '}
                vs{' '}
                {formatConflictRefWithLine(haltDiagnostic.rightRef, haltDiagnostic.rightLine)}
            </div>
            {haltDiagnostic.leftExcerpt ? (
                <div className="ns-i-halt-excerpt">
                    [前文依据] {haltDiagnostic.leftExcerpt}
                </div>
            ) : null}
            {haltDiagnostic.rightExcerpt ? (
                <div className="ns-i-halt-excerpt-tight">
                    [当章原句] {haltDiagnostic.rightExcerpt}
                </div>
            ) : null}
        </div>
    );
}

function renderHaltIssuesBlock(issues: HaltDiagnosticIssueItem[] | undefined): React.ReactNode {
    if (!Array.isArray(issues) || issues.length === 0) return null;
    return (
        <div className="ns-i-halt-refs">
            {issues.map((issue, idx) => (
                <div key={`halt-issue-${idx}`} className="ns-i-halt-excerpt">
                    {issue.description || issue.rule || `冲突 #${idx + 1}`}
                    {issue.source_ref ? ` (${issue.source_ref})` : ''}
                    {issue.quote_source ? ` | 依据: ${issue.quote_source}` : ''}
                    {issue.quote_draft ? ` | 草稿: ${issue.quote_draft}` : ''}
                </div>
            ))}
        </div>
    );
}

function renderHaltScopeBlock(haltDiagnostic: HaltDiagnosticInfo): React.ReactNode {
    const hasChapters = typeof haltDiagnostic.affectedChapters === 'number';
    const hasWords = typeof haltDiagnostic.affectedWords === 'number';
    if (!hasChapters && !hasWords) return null;
    return (
        <div className="ns-mono ns-i-halt-scope">
            波及范围:{' '}
            {hasChapters ? `${haltDiagnostic.affectedChapters} 章` : '--'}
            {hasWords ? ` / ${haltDiagnostic.affectedWords} 字` : ''}
            {typeof haltDiagnostic.rollbackThreshold === 'number'
                ? ` (自动回滚阈值 ${haltDiagnostic.rollbackThreshold} 章)`
                : ''}
        </div>
    );
}

function renderHaltDiagnosticCard(
    haltDiagnostic: HaltDiagnosticInfo | null,
    onInspectHalt?: () => void
): React.ReactNode {
    if (!haltDiagnostic) return null;
    return (
        <div className="ns-i-card ns-i-card-halt">
            <div className="ns-i-card-head">
                <span className="ns-i-red-ink">{haltDiagnostic.kind} - 完整双侧冲突诊断</span>
                <span className="ns-pill ns-pill-red">{haltDiagnostic.kind}</span>
            </div>
            <div className="ns-i-halt-reason">{haltDiagnostic.reason}</div>
            {renderHaltRefsBlock(haltDiagnostic)}
            {renderHaltIssuesBlock(haltDiagnostic.issues)}
            {renderHaltScopeBlock(haltDiagnostic)}
            {onInspectHalt ? (
                <button
                    type="button"
                    className="ns-btn ns-btn-stop ns-btn-sm"
                    onClick={onInspectHalt}
                >
                    定位冲突快照与恢复方案
                </button>
            ) : null}
        </div>
    );
}

function renderStageSessionsList(
    sessions: readonly StageAttemptSession[] | undefined,
    onInspectStageSession?: (sessionId: string) => void
): React.ReactNode {
    if (!sessions || sessions.length === 0) return null;
    return (
        <div className="ns-i-stage-sessions" aria-label="关联会话轨迹列表">
            <div className="ns-i-stage-sessions-title">
                关联会话轨迹列表 ({sessions.length})
            </div>
            <div className="ns-i-stage-sessions-list">
                {sessions.map((item, idx) => (
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
                                {normalizeCheckerLabel(item.stage)}
                                {typeof item.attempt === 'number' ? ` #${item.attempt}` : ''}
                            </span>
                            <span className="ns-pill ns-pill-muted ns-mono">{item.status}</span>
                        </span>
                        {item.triggerReason ? (
                            <span className="ns-i-stage-session-reason">
                                {normalizeCheckerLabel(item.triggerReason)}
                            </span>
                        ) : null}
                        <span className="ns-mono ns-i-muted ns-i-stage-session-id">
                            {item.sessionId}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function renderThreadsList(resolvedThreads: readonly OpenThreadItem[]): React.ReactNode {
    if (resolvedThreads.length === 0) return null;
    return (
        <div className="ns-i-thread-list">
            {resolvedThreads.map((thd, idx) => (
                <div key={thd.id ?? `${thd.title}-${idx}`} className="ns-i-thread">
                    <span className="ns-mono ns-i-thread-ch">
                        {typeof thd.chapter === 'number' ? `Ch.${thd.chapter}` : '--'}
                    </span>
                    <div className="ns-i-thread-main">
                        <div className="ns-i-thread-title">{thd.title}</div>
                        {thd.hint ? <div className="ns-i-thread-hint">{thd.hint}</div> : null}
                    </div>
                    {thd.scope ? <span className="ns-pill ns-pill-brand">{thd.scope}</span> : null}
                </div>
            ))}
        </div>
    );
}

/**
 * 右栏「运行状态」检查器：
 * - 默认直白展示三段核心摘要：1) 本章给写手装入的资料；2) 文风体检；3) 自动整理进度
 * - 底部可折叠「底层校验与提交明细」收纳事务锁、双粒度 Git SHA、Checker 验真统计、切镜队列、实体伏笔与完整冲突诊断
 * - 保留顶部展开/收起按钮与现有测试语义，严禁出现 Fact Checker / Fact Check 与虚构 0 值
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
        dreamWatermark = null,
        selectedVoiceSample = null,
        strippedSecretCount,
        onSelectEntity,
        onSelectChapter,
        onInspectStageSession
    } = props;

    const [lowLevelOpen, setLowLevelOpen] = useState<boolean>(false);
    const [gateDetailsOpen, setGateDetailsOpen] = useState<boolean>(false);
    const [expandedEntityId, setExpandedEntityId] = useState<string | null>(null);

    const cacheHitPct = computeCacheHitRatePct(modelPool);
    const cacheHitLabel = cacheHitPct === null ? '未提供' : `${cacheHitPct.toFixed(1)}%`;
    const hasHalt = haltDiagnostic !== null;
    const hasGateAlert =
        proseGate.recentViolations.length > 0 || (factChecker.blockedCount ?? 0) > 0;

    const resolvedRouting = useMemo(
        () => ({
            strong_creative: modelRouting?.strong_creative || modelPool.strongModel || '--',
            fast_retrieval: modelRouting?.fast_retrieval || modelPool.fastModel || '--'
        }),
        [modelRouting, modelPool]
    );

    const gateRuleStats = useMemo(() => {
        return CORE_GATE_RULES.map((rule) => {
            const matched = proseGate.recentViolations.filter(
                (v) => v.rule === rule.id || v.rule.toLowerCase().includes(rule.id)
            );
            const patchedCount = matched.filter((v) => v.patched).length;
            return { ...rule, hits: matched.length, patchedCount };
        });
    }, [proseGate.recentViolations]);

    const resolvedEntities = useMemo<InspectorEntityItem[]>(() => {
        if (entities && entities.length > 0) return entities;
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

    const hasEntitySource = entities !== undefined || dreaming.spotlightQueue !== null;
    const resolvedThreads = useMemo<OpenThreadItem[]>(
        () => (openThreads && openThreads.length > 0 ? openThreads : []),
        [openThreads]
    );

    // Dreaming 脏页与字数水位
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

    const rawAccumulatedWords =
        dreamWatermark?.accumulated_words_since_dream ?? dreaming.accumulatedWords;
    const rawWordThreshold = dreamWatermark?.word_threshold ?? dreaming.wordThreshold;
    const accumulatedWords =
        typeof rawAccumulatedWords === 'number' && Number.isFinite(rawAccumulatedWords)
            ? rawAccumulatedWords
            : null;
    const wordThreshold =
        typeof rawWordThreshold === 'number' &&
        Number.isFinite(rawWordThreshold) &&
        rawWordThreshold > 0
            ? rawWordThreshold
            : null;
    const wordWatermarkLabel = formatWordWatermarkLabel(accumulatedWords, wordThreshold);

    // 写手净室资料装配统计
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
    const hasBudgetBar = hasAssemblyStats && budgetLimit > 0;
    const staticPct = hasBudgetBar ? Math.min(100, (staticTokens / budgetLimit) * 100) : 0;
    const dynamicPct = hasBudgetBar
        ? Math.min(100 - staticPct, (dynamicTokens / budgetLimit) * 100)
        : 0;
    const degradationLevel =
        typeof stageArtifact.degradationLevel === 'number' &&
        Number.isFinite(stageArtifact.degradationLevel)
            ? stageArtifact.degradationLevel
            : null;
    const degradationBadge = resolveDegradationBadge(degradationLevel);

    const voiceDisplay = useMemo(() => {
        if (selectedVoiceSample && (selectedVoiceSample.tag || selectedVoiceSample.text)) {
            const parts = [selectedVoiceSample.tag, selectedVoiceSample.text].filter(Boolean);
            return parts.join(' · ');
        }
        return stageArtifact.voiceLruSummary || null;
    }, [selectedVoiceSample, stageArtifact.voiceLruSummary]);

    const strippedDisplay = useMemo(() => {
        if (typeof strippedSecretCount === 'number' && Number.isFinite(strippedSecretCount)) {
            return stageArtifact.strippedItemsSummary
                ? `已屏蔽 ${strippedSecretCount} 项（${stageArtifact.strippedItemsSummary}）`
                : `已屏蔽 ${strippedSecretCount} 项隐藏底牌`;
        }
        return stageArtifact.strippedItemsSummary || null;
    }, [strippedSecretCount, stageArtifact.strippedItemsSummary]);

    // 卷纲进度
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

    // 章节累计 Token 分布
    const inputTokens = Math.max(0, modelPool.inputTokens);
    const cacheReadTokens = Math.max(0, modelPool.cacheReadTokens);
    const cacheWriteTokens = Math.max(0, modelPool.cacheWriteTokens ?? 0);
    const outputTokens = Math.max(0, modelPool.outputTokens ?? 0);
    const totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
    const barTotalTokens = Math.max(1, totalTokens);

    const hasAnyProseMetric =
        proseGate.mattr500 !== null ||
        proseGate.kontoyiannisEntropy !== null ||
        proseGate.sentenceLengthCv !== null ||
        proseGate.clicheDensityPer1k !== null;

    const expandAll = (): void => {
        setLowLevelOpen(true);
        setGateDetailsOpen(true);
    };

    const collapseAll = (): void => {
        setLowLevelOpen(false);
        setGateDetailsOpen(false);
    };

    const normalizedStageName = normalizeCheckerLabel(stageArtifact.stageName);
    const proseGateBadge = resolveProseGateBadge(
        proseGate.recentViolations.length,
        hasAnyProseMetric
    );
    const proseMetrics: ReadonlyArray<{
        label: string;
        value: number | null;
        note: string;
        warnAbove?: number;
    }> = [
        { label: '词汇丰富度', value: proseGate.mattr500, note: '词汇多样性' },
        { label: '信息新鲜度', value: proseGate.kontoyiannisEntropy, note: '防车轱辘话' },
        { label: '句式长短变化', value: proseGate.sentenceLengthCv, note: '节奏变化' },
        { label: '套话密度', value: proseGate.clicheDensityPer1k, note: '/千字', warnAbove: 1.5 }
    ];

    return (
        <div className="ns-ops-inspector" aria-label="运行状态">
            <div className="ns-i-toolbar">
                <span className="ns-i-toolbar-title">运行状态</span>
                <div className="ns-i-toolbar-actions">
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        aria-label="展开全部检查器分组"
                        onClick={expandAll}
                    >
                        展开明细
                    </button>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        aria-label="收起全部检查器分组"
                        onClick={collapseAll}
                    >
                        收起明细
                    </button>
                </div>
            </div>

            <div className="ns-i-list">
                {/* 1. 本章给写手装入的资料 */}
                <section className="ns-panel-section" aria-label="本章给写手装入的资料">
                    <div className="ns-sec-head">
                        <span>本章给写手装入的资料</span>
                        <span className="ns-pill ns-pill-brand ns-mono">
                            {formatAssemblyBadgeLabel(hasAssemblyStats, totalUsedTokens, budgetLimit)}
                        </span>
                    </div>

                    {renderAssemblyStatsBody({
                        hasAssemblyStats,
                        staticTokens,
                        dynamicTokens,
                        totalUsedTokens,
                        budgetLimit,
                        hasBudgetBar,
                        staticPct,
                        dynamicPct
                    })}

                    <div className="ns-stat-row">
                        <span>窗口降级等级</span>
                        <span className={degradationBadge.pillClass}>{degradationBadge.label}</span>
                    </div>

                    {voiceDisplay ? (
                        <div className="ns-i-text-3">
                            <span className="ns-i-strong">声纹样本</span>: {voiceDisplay}
                        </div>
                    ) : null}

                    {strippedDisplay ? (
                        <div className="ns-i-text-3 ns-i-amber-ink">
                            <span className="ns-i-strong">防剧透自动屏蔽项</span>: {strippedDisplay}
                        </div>
                    ) : null}

                    <div className="ns-i-text-3">
                        <span className="ns-i-strong">
                            阶段 #{stageArtifact.selectedStageIndex + 1} · {normalizedStageName}
                        </span>
                        ：{stageArtifact.stageSummary}
                    </div>

                    {renderStageSessionRow(stageArtifact.sessionId, onInspectStageSession)}

                    {renderStageSessionsList(stageArtifact.sessions, onInspectStageSession)}
                </section>

                {/* 2. 文风体检 */}
                <section className="ns-panel-section" aria-label="文风体检">
                    <div className="ns-sec-head">
                        <span>文风体检</span>
                        <span className={proseGateBadge.pillClass}>{proseGateBadge.label}</span>
                    </div>

                    <div className="ns-kv-grid">
                        {proseMetrics.map((metric) => (
                            <div key={metric.label} className="ns-metric">
                                <div className="ns-metric-k ns-i-metric-k-row">
                                    <span>{metric.label}</span>
                                    <span
                                        className={resolveProseMetricDotClass(
                                            metric.value,
                                            metric.warnAbove
                                        )}
                                        aria-hidden="true"
                                    />
                                </div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(metric.value)}
                                </div>
                                <div className="ns-i-metric-note">{metric.note}</div>
                            </div>
                        ))}
                    </div>

                    <button
                        type="button"
                        className="ns-i-acc-head"
                        aria-expanded={gateDetailsOpen}
                        aria-controls="ns-i-body-gate-rules"
                        onClick={() => setGateDetailsOpen((prev) => !prev)}
                    >
                        <span className="ns-i-acc-title">文风门禁规则明细（8 条）</span>
                        <span className="ns-i-sum ns-i-sum-quiet">
                            命中 {proseGate.recentViolations.length}
                        </span>
                        <span className="ns-i-chevron" aria-hidden="true">
                            ›
                        </span>
                    </button>
                    <div
                        className="ns-i-rule-list"
                        id="ns-i-body-gate-rules"
                        hidden={!gateDetailsOpen}
                    >
                        {gateRuleStats.map((rule) => {
                            const triggered = rule.hits > 0;
                            return (
                                <div key={rule.id} className="ns-i-rule">
                                    <div className="ns-i-rule-main">
                                        <div className="ns-i-rule-label">{rule.label}</div>
                                        <div className="ns-mono ns-i-rule-id">{rule.id}</div>
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
                                            triggered ? 'ns-pill ns-pill-amber' : 'ns-pill ns-pill-green'
                                        }
                                    >
                                        {resolveGateRuleStatusText(triggered, rule.patchedCount)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </section>

                {/* 3. 自动整理进度 */}
                <section className="ns-panel-section" aria-label="自动整理进度">
                    <div className="ns-sec-head">
                        <span>自动整理进度</span>
                        <span className="ns-pill ns-pill-muted ns-mono">{wordWatermarkLabel}</span>
                    </div>

                    <div className="ns-stat-row">
                        <span>待整理变动人物</span>
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

                    <div className="ns-stat-row">
                        <span>冷宫归档数</span>
                        <span className="ns-mono">{dreaming.coldArchiveCount} 冷归档</span>
                    </div>

                    {/* 前缀缓存命中率卡片 */}
                    <div className="ns-i-card">
                        <div className="ns-i-card-head">
                            <span>静态前缀缓存命中</span>
                            <span className="ns-mono ns-i-green-ink">{cacheHitLabel}</span>
                        </div>
                        <div className="ns-i-big">
                            {cacheHitPct === null ? '未提供' : cacheHitPct.toFixed(1)}
                            {cacheHitPct !== null ? <small className="ns-i-big-unit">%</small> : null}
                        </div>
                        {cacheHitPct !== null ? (
                            <div className="ns-prog-bar ns-i-prog-top">
                                <div
                                    className="ns-prog-fill ns-i-fill-green"
                                    style={{ width: `${cacheHitPct}%` }}
                                />
                            </div>
                        ) : null}
                    </div>

                    {/* 章节生成累计 Token 分布（保留口径说明） */}
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
                                style={{ width: `${(inputTokens / barTotalTokens) * 100}%` }}
                            />
                            <div
                                className="ns-i-bar-seg ns-i-seg-green"
                                title={`缓存读取 ${formatTokenCount(cacheReadTokens)}`}
                                style={{ width: `${(cacheReadTokens / barTotalTokens) * 100}%` }}
                            />
                            <div
                                className="ns-i-bar-seg ns-i-seg-amber"
                                title={`缓存写入 ${formatTokenCount(cacheWriteTokens)}`}
                                style={{ width: `${(cacheWriteTokens / barTotalTokens) * 100}%` }}
                            />
                            <div
                                className="ns-i-bar-seg ns-i-seg-brand"
                                title={`输出 ${formatTokenCount(outputTokens)}`}
                                style={{ width: `${(outputTokens / barTotalTokens) * 100}%` }}
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

                    {/* 卷节拍进度 */}
                    <div className="ns-i-card">
                        <div className="ns-i-card-head">
                            <span>
                                卷节拍进度
                                {volumeProgress?.volumeLabel
                                    ? ` · ${volumeProgress.volumeLabel}`
                                    : ''}
                                {volumeProgress?.volumeTitle
                                    ? ` - ${volumeProgress.volumeTitle}`
                                    : ''}
                            </span>
                            <span className={volumePct !== null ? 'ns-mono' : 'ns-mono ns-i-muted'}>
                                {formatVolumeProgressLabel(volumeCompletedCh, volumeTotalCh, volumePct)}
                            </span>
                        </div>
                        {renderVolumeProgressBody(volumeCompletedCh, volumePct)}
                        <div className="ns-i-vol-meta">
                            <span>时间线: {walLock.timelineMode}</span>
                            <span>全书已提交 {walLock.lastCommittedChapter} 章</span>
                        </div>
                        {volumeProgress?.futureHorizon || stageArtifact.outlineSummary ? (
                            <div className="ns-i-future">
                                {volumeProgress?.futureHorizon || stageArtifact.outlineSummary}
                            </div>
                        ) : null}
                        {volumeProgress?.milestoneLock ? (
                            <div className="ns-i-milestone">
                                <span className="ns-i-strong">卷末里程碑锁</span>:{' '}
                                {volumeProgress.milestoneLock}
                            </div>
                        ) : null}
                    </div>

                    {onTriggerDreaming ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-ghost ns-btn-sm"
                            onClick={onTriggerDreaming}
                            disabled={busy}
                        >
                            立即整理设定与伏笔
                        </button>
                    ) : null}
                </section>

                {/* 4. 底层校验与提交明细（默认折叠） */}
                <section className="ns-panel-section" aria-label="底层校验与提交明细">
                    <button
                        type="button"
                        className="ns-i-acc-head"
                        aria-expanded={lowLevelOpen}
                        aria-controls="ns-i-body-lowlevel"
                        onClick={() => setLowLevelOpen((prev) => !prev)}
                    >
                        <span className="ns-i-acc-title">
                            底层校验与提交明细（核查 / 锁 / Git SHA）
                        </span>
                        {hasHalt ? (
                            <span
                                className="ns-i-dot ns-i-dot-red"
                                role="img"
                                aria-label="存在 SAFE_HALT 告警"
                            />
                        ) : null}
                        {hasGateAlert ? (
                            <span
                                className="ns-i-dot ns-i-dot-amber"
                                role="img"
                                aria-label="存在门禁告警"
                            />
                        ) : null}
                        <span className="ns-i-chevron" aria-hidden="true">
                            ›
                        </span>
                    </button>

                    <div className="ns-i-acc-body" id="ns-i-body-lowlevel" hidden={!lowLevelOpen}>
                        {/* 独占事务锁与双粒度 Git SHA */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>独占事务锁与提交指纹</span>
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
                                    <div className="ns-metric-k">独占事务锁</div>
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
                                    <div className="ns-metric-k">已提交至</div>
                                    <div className="ns-metric-v ns-mono">
                                        Ch.{String(walLock.lastCommittedChapter).padStart(4, '0')}
                                    </div>
                                </div>
                            </div>
                            {walLock.txLockStatus === 'locked' && walLock.txLockHolder ? (
                                <div className="ns-mono ns-i-lock-holder">
                                    锁持有者: {walLock.txLockHolder}
                                </div>
                            ) : null}
                            <div className="ns-mono ns-i-commit-sha">
                                正文 SHA: {walLock.featCommitSha ? walLock.featCommitSha.slice(0, 7) : '--'}
                                {' · '}
                                台账 SHA: {walLock.stateCommitSha ? walLock.stateCommitSha.slice(0, 7) : '--'}
                            </div>
                        </div>

                        {/* Checker 筛除伪引文统计 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>Checker 筛除伪引文</span>
                                <span className="ns-pill ns-pill-brand">
                                    通过 {factChecker.verifiedPassCount} / 过滤{' '}
                                    {factChecker.filteredOutCount}
                                </span>
                            </div>
                            <div className="ns-kv-grid">
                                <div className="ns-metric">
                                    <div className="ns-metric-k">Checker 核查总数</div>
                                    <div className="ns-metric-v ns-mono">
                                        {factChecker.totalChecked}
                                    </div>
                                </div>
                                <div className="ns-metric">
                                    <div className="ns-metric-k">穿帮拦截</div>
                                    <div className="ns-metric-v ns-mono">
                                        {factChecker.blockedCount ?? 0}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* 待生效切镜队列 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>待生效切镜队列</span>
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
                            {renderSpotlightQueueBody(dreaming.spotlightQueue)}
                        </div>

                        {/* 活跃实体与跨卷伏笔 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>活跃实体与未解伏笔</span>
                                <span className="ns-mono ns-i-muted">
                                    {hasEntitySource ? `${resolvedEntities.length} 活跃` : '活跃数未提供'}{' '}
                                    - {dreaming.coldArchiveCount} 冷归档 - 伏笔{' '}
                                    {resolvedThreads.length}
                                </span>
                            </div>
                            {renderEntitiesBody({
                                hasEntitySource,
                                resolvedEntities,
                                expandedEntityId,
                                onToggleEntity: setExpandedEntityId,
                                onSelectEntity,
                                onSelectChapter
                            })}
                            {renderThreadsList(resolvedThreads)}
                        </div>

                        {/* 双池模型路由只读快照 */}
                        <div className="ns-i-card">
                            <div className="ns-i-card-head">
                                <span>双池模型路由 (modelRouting)</span>
                            </div>
                            <div className="ns-i-route-list">
                                {MODEL_ROUTE_DESCRIPTORS.map((desc) => {
                                    const modelValue = resolvedRouting[desc.poolId];
                                    return (
                                        <div key={desc.poolId} className="ns-i-route">
                                            <span className="ns-i-route-name">
                                                {POOL_LABELS[desc.poolId]} ({desc.poolId})
                                            </span>
                                            <span className={desc.modelClass} title={modelValue}>
                                                {modelValue}
                                            </span>
                                            <span className="ns-i-route-role">{desc.roles}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* 完整双侧冲突诊断 */}
                        {hasHalt ? renderHaltDiagnosticCard(haltDiagnostic, onInspectHalt) : null}
                    </div>
                </section>
            </div>
        </div>
    );
}

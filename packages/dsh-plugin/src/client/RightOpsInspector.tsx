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

/** 右栏 7 组可折叠运维检查器 Props */
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
}

const DEFAULT_OPEN_GROUPS: boolean[] = [true, true, false, false, false, false, false];

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
        return pool.cacheHitRate <= 1 ? pool.cacheHitRate * 100 : pool.cacheHitRate;
    }
    const denom = pool.inputTokens + pool.cacheReadTokens;
    if (denom <= 0) return 0;
    return (pool.cacheReadTokens / denom) * 100;
}

function resolveWalBadgeClass(phase: string): string {
    const upper = phase.toUpperCase();
    if (upper === 'SAFE_HALT' || upper === 'QUARANTINED') return 'ns-pill ns-pill-red';
    if (upper === 'DRAFTING' || upper === 'FEAT_COMMITTED') return 'ns-pill ns-pill-brand';
    return 'ns-pill ns-pill-green';
}

/**
 * 右栏运维检查器组件：
 * - 顶部提供「全部展开 / 收起」控制
 * - 内含 7 组独立可折叠手风琴块，默认仅展开前 2 组
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
        onInspectHalt
    } = props;

    const [openGroups, setOpenGroups] = useState<boolean[]>(DEFAULT_OPEN_GROUPS);

    const anyClosed = useMemo(() => openGroups.some((item) => !item), [openGroups]);

    const handleToggleAll = (): void => {
        const nextState = anyClosed;
        setOpenGroups(openGroups.map(() => nextState));
    };

    const handleToggleGroup = (index: number, e: React.MouseEvent<HTMLElement>): void => {
        e.preventDefault();
        setOpenGroups((prev) => prev.map((open, idx) => (idx === index ? !open : open)));
    };

    const cacheHitPct = computeCacheHitRatePct(modelPool);
    const dirtyRatioPct =
        dreaming.dirtyThreshold > 0
            ? Math.min(100, Math.round((dreaming.dirtyEntityCount / dreaming.dirtyThreshold) * 100))
            : 0;
    const hasHalt = haltDiagnostic !== null;

    return (
        <aside className="ns-right" aria-label="运维检查器">
            <div className="ns-right-head">
                <span>运维检查器 (7 组可折叠)</span>
                <button
                    type="button"
                    className="ns-btn-ghost ns-btn-sm"
                    onClick={handleToggleAll}
                >
                    {anyClosed ? '全部展开' : '全部收起'}
                </button>
            </div>

            <div className="ns-right-scroll">
                {/* 1. WAL & 事务锁状态 */}
                <details className="ns-acc" open={openGroups[0]}>
                    <summary onClick={(e) => handleToggleGroup(0, e)}>
                        <span>1. WAL &amp; 事务锁状态</span>
                        <span className={resolveWalBadgeClass(walLock.walPhase)}>
                            {walLock.walPhase}
                        </span>
                    </summary>
                    <div className="ns-acc-body">
                        <div className="ns-kv-grid">
                            <div className="ns-metric">
                                <div className="ns-metric-k">当前相位</div>
                                <div className="ns-metric-v ns-mono">{walLock.walPhase}</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">timeline_mode</div>
                                <div className="ns-metric-v ns-mono">{walLock.timelineMode}</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">.ops/tx.lock</div>
                                <div className="ns-metric-v ns-mono">
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
                            <div className="ns-row-item ns-mono ns-text-amber">
                                锁持有者：{walLock.txLockHolder}
                            </div>
                        )}
                        {(walLock.featCommitSha || walLock.stateCommitSha) && (
                            <div className="ns-row-item ns-mono ns-text-muted">
                                feat: {walLock.featCommitSha ? walLock.featCommitSha.slice(0, 7) : '--'} - state:{' '}
                                {walLock.stateCommitSha ? walLock.stateCommitSha.slice(0, 7) : '--'}
                            </div>
                        )}
                    </div>
                </details>

                {/* 2. 异构模型池 & 前缀缓存 */}
                <details className="ns-acc" open={openGroups[1]}>
                    <summary onClick={(e) => handleToggleGroup(1, e)}>
                        <span>2. 异构模型池 &amp; 前缀缓存</span>
                        <span className="ns-pill ns-pill-green">命中 {cacheHitPct.toFixed(1)}%</span>
                    </summary>
                    <div className="ns-acc-body">
                        <div className="ns-kv-grid">
                            <div className="ns-metric">
                                <div className="ns-metric-k">累计 inputTokens</div>
                                <div className="ns-metric-v ns-mono">
                                    {formatTokenCount(modelPool.inputTokens)}
                                </div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">cacheReadTokens</div>
                                <div className="ns-metric-v ns-mono">
                                    {formatTokenCount(modelPool.cacheReadTokens)}
                                </div>
                            </div>
                        </div>
                        <div className="ns-row-item ns-mono">
                            <div>快池 (fast): {modelPool.fastModel || '--'}</div>
                            <div>强池 (strong): {modelPool.strongModel || '--'}</div>
                            <div>核查池 (audit): {modelPool.auditModel || '--'}</div>
                        </div>
                        {typeof modelPool.outputTokens === 'number' && (
                            <div className="ns-row-item ns-mono ns-text-muted">
                                累计输出：{formatTokenCount(modelPool.outputTokens)} tokens
                            </div>
                        )}
                    </div>
                </details>

                {/* 3. 6 步产物 & 预算降级 */}
                <details className="ns-acc" open={openGroups[2]}>
                    <summary onClick={(e) => handleToggleGroup(2, e)}>
                        <span>3. 6 步产物 &amp; 预算降级</span>
                        <span className="ns-pill ns-pill-brand">
                            {stageArtifact.budgetLimitTokens
                                ? `${formatTokenCount((stageArtifact.staticPrefixTokens ?? 0) + (stageArtifact.dynamicTailTokens ?? 0))} / ${formatTokenCount(stageArtifact.budgetLimitTokens)}`
                                : stageArtifact.stageStatus || '就绪'}
                        </span>
                    </summary>
                    <div className="ns-acc-body">
                        <div className="ns-row-item">
                            <strong>
                                阶段 #{stageArtifact.selectedStageIndex + 1} · {stageArtifact.stageName}
                            </strong>
                            <div>{stageArtifact.stageSummary}</div>
                        </div>
                        <div className="ns-row-item">
                            <strong>窗口装配与降级</strong>
                            <div className="ns-mono">
                                静态前缀 {formatTokenCount(stageArtifact.staticPrefixTokens ?? 0)} - 动态尾{' '}
                                {formatTokenCount(stageArtifact.dynamicTailTokens ?? 0)} - 降级{' '}
                                {stageArtifact.degradationLevel ?? 0} 级
                            </div>
                        </div>
                        {stageArtifact.outlineSummary && (
                            <div className="ns-row-item">
                                <strong>细纲摘要</strong>：{stageArtifact.outlineSummary}
                            </div>
                        )}
                        {stageArtifact.voiceLruSummary && (
                            <div className="ns-row-item">
                                <strong>声纹 LRU</strong>：{stageArtifact.voiceLruSummary}
                            </div>
                        )}
                        {stageArtifact.strippedItemsSummary && (
                            <div className="ns-row-item ns-text-green">
                                <strong>物理剥离</strong>：{stageArtifact.strippedItemsSummary}
                            </div>
                        )}
                    </div>
                </details>

                {/* 4. Static Prose Gate & 四联遥测 */}
                <details className="ns-acc" open={openGroups[3]}>
                    <summary onClick={(e) => handleToggleGroup(3, e)}>
                        <span>4. Static Prose Gate &amp; 四联遥测</span>
                        <span
                            className={
                                proseGate.recentViolations.length > 0
                                    ? 'ns-pill ns-pill-amber'
                                    : 'ns-pill ns-pill-green'
                            }
                        >
                            违规 {proseGate.recentViolations.length}
                        </span>
                    </summary>
                    <div className="ns-acc-body">
                        <div className="ns-kv-grid">
                            <div className="ns-metric">
                                <div className="ns-metric-k">MATTR-500</div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.mattr500)}
                                </div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">Kontoyiannis 熵率</div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.kontoyiannisEntropy)}
                                </div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">句段长 CV</div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.sentenceLengthCv)}
                                </div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">八股千字密度</div>
                                <div className="ns-metric-v ns-mono">
                                    {formatMetricNumber(proseGate.clicheDensityPer1k)}
                                </div>
                            </div>
                        </div>

                        <div className="ns-row-item">
                            <strong>最近违规项</strong>
                            {proseGate.recentViolations.length === 0 ? (
                                <div className="ns-text-muted">本轮无门禁违规记录</div>
                            ) : (
                                proseGate.recentViolations.map((item, idx) => (
                                    <div key={`${item.rule}-${idx}`} className="ns-violation-item">
                                        <span className="ns-mono">[{item.rule}]</span> {item.detail}
                                        {item.patched ? ' (已 Patch)' : ''}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </details>

                {/* 5. Fact Checker & 双侧原句验真 */}
                <details className="ns-acc" open={openGroups[4]}>
                    <summary onClick={(e) => handleToggleGroup(4, e)}>
                        <span>5. Fact Checker &amp; 双侧原句验真</span>
                        <span className="ns-pill ns-pill-brand">
                            通过 {factChecker.verifiedPassCount} / 过滤 {factChecker.filteredOutCount}
                        </span>
                    </summary>
                    <div className="ns-acc-body">
                        <div className="ns-kv-grid">
                            <div className="ns-metric">
                                <div className="ns-metric-k">核查总数</div>
                                <div className="ns-metric-v ns-mono">{factChecker.totalChecked}</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">验真通过</div>
                                <div className="ns-metric-v ns-mono">{factChecker.verifiedPassCount}</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">误报过滤</div>
                                <div className="ns-metric-v ns-mono">{factChecker.filteredOutCount}</div>
                            </div>
                            <div className="ns-metric">
                                <div className="ns-metric-k">穿帮拦截</div>
                                <div className="ns-metric-v ns-mono">
                                    {factChecker.blockedCount ?? 0}
                                </div>
                            </div>
                        </div>

                        {factChecker.recentFindings && factChecker.recentFindings.length > 0 && (
                            <div className="ns-row-item">
                                <strong>最近验真明细</strong>
                                {factChecker.recentFindings.map((finding, idx) => (
                                    <div key={idx} className="ns-finding-item">
                                        <span className="ns-mono">
                                            {finding.verified ? '[PASS]' : '[FILTERED]'}
                                        </span>{' '}
                                        {finding.claim}
                                        {finding.sourceRef ? ` (${finding.sourceRef})` : ''}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </details>

                {/* 6. Dreaming 脏页水位 & 前台切镜 */}
                <details className="ns-acc" open={openGroups[5]}>
                    <summary onClick={(e) => handleToggleGroup(5, e)}>
                        <span>6. Dreaming 脏页水位 &amp; 前台切镜</span>
                        <span className="ns-pill ns-pill-brand">
                            {dreaming.dirtyEntityCount} / {dreaming.dirtyThreshold} 页
                        </span>
                    </summary>
                    <div className="ns-acc-body">
                        <div className="ns-row-item">
                            <div className="ns-waterline-head">
                                <strong>脏实体水位</strong>
                                <span className="ns-mono">
                                    {dreaming.dirtyEntityCount} / {dreaming.dirtyThreshold} ({dirtyRatioPct}%)
                                </span>
                            </div>
                            <div className="ns-prog-bar">
                                <div className="ns-prog-fill" style={{ width: `${dirtyRatioPct}%` }} />
                            </div>
                        </div>

                        <div className="ns-row-item">
                            <strong>冷归档实体数</strong>：
                            <span className="ns-mono">{dreaming.coldArchiveCount}</span>
                        </div>

                        <div className="ns-row-item">
                            <strong>Spotlight Trigger 队列 ({dreaming.spotlightQueue.length})</strong>
                            {dreaming.spotlightQueue.length === 0 ? (
                                <div className="ns-text-muted">暂无待切镜幕后角色</div>
                            ) : (
                                dreaming.spotlightQueue.map((item) => (
                                    <div key={item.entityId} className="ns-spotlight-item">
                                        <div className="ns-waterline-head">
                                            <span>
                                                {item.label} ({item.entityId})
                                            </span>
                                            <span className="ns-mono">
                                                {Math.min(100, Math.max(0, item.progressPct))}%
                                                {item.triggered ? ' · 已触发' : ''}
                                            </span>
                                        </div>
                                        <div className="ns-prog-bar">
                                            <div
                                                className="ns-prog-fill"
                                                style={{
                                                    width: `${Math.min(100, Math.max(0, item.progressPct))}%`
                                                }}
                                            />
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>

                        {onTriggerDreaming && (
                            <div className="ns-row-item">
                                <button
                                    type="button"
                                    className="ns-btn-ghost ns-btn-sm"
                                    onClick={onTriggerDreaming}
                                    disabled={busy}
                                >
                                    立即执行 Dreaming (VACUUM)
                                </button>
                            </div>
                        )}
                    </div>
                </details>

                {/* 7. SAFE_HALT / QUARANTINED 诊断 */}
                <details className={`ns-acc${hasHalt ? ' ns-acc-alert' : ''}`} open={openGroups[6]}>
                    <summary onClick={(e) => handleToggleGroup(6, e)}>
                        <span>7. SAFE_HALT / QUARANTINED 诊断</span>
                        <span className={hasHalt ? 'ns-pill ns-pill-red' : 'ns-pill ns-pill-green'}>
                            {hasHalt ? haltDiagnostic.kind : '正常'}
                        </span>
                    </summary>
                    <div className="ns-acc-body">
                        {!hasHalt ? (
                            <div className="ns-text-muted">
                                当前无挂起快照，双侧原句验真与 WAL 状态一致。
                            </div>
                        ) : (
                            <div className="ns-halt-card">
                                <div className="ns-row-item">
                                    <strong className="ns-text-red">
                                        {haltDiagnostic.kind} · 冲突诊断
                                    </strong>
                                    <div>{haltDiagnostic.reason}</div>
                                </div>
                                {(haltDiagnostic.leftRef || haltDiagnostic.rightRef) && (
                                    <div className="ns-row-item ns-mono">
                                        <div>
                                            冲突双侧：{haltDiagnostic.leftRef || '--'} vs{' '}
                                            {haltDiagnostic.rightRef || '--'}
                                        </div>
                                        {haltDiagnostic.leftExcerpt && (
                                            <div className="ns-halt-quote">
                                                [前文] {haltDiagnostic.leftExcerpt}
                                            </div>
                                        )}
                                        {haltDiagnostic.rightExcerpt && (
                                            <div className="ns-halt-quote">
                                                [当章] {haltDiagnostic.rightExcerpt}
                                            </div>
                                        )}
                                    </div>
                                )}
                                {typeof haltDiagnostic.affectedChapters === 'number' && (
                                    <div className="ns-row-item ns-mono">
                                        波及范围：{haltDiagnostic.affectedChapters} 章
                                        {typeof haltDiagnostic.rollbackThreshold === 'number'
                                            ? ` (自动回滚阈值 ${haltDiagnostic.rollbackThreshold} 章)`
                                            : ''}
                                    </div>
                                )}
                                {onInspectHalt && (
                                    <div className="ns-row-item">
                                        <button
                                            type="button"
                                            className="ns-btn-stop ns-btn-sm"
                                            onClick={onInspectHalt}
                                        >
                                            定位冲突快照与恢复方案
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </details>
            </div>
        </aside>
    );
}

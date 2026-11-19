import React from 'react';
import type { SafeHaltInfo, VerdictGateViolationItem } from './CenterWorkbench';
import { StudioIcons } from './workbench-parsers';

export interface SyncConflictDiagnostic {
    conflictId?: string | undefined;
    description: string;
    leftRef?: string | undefined;
    leftLine?: number | null | undefined;
    leftExcerpt?: string | undefined;
    rightRef?: string | undefined;
    rightLine?: number | null | undefined;
    rightExcerpt?: string | undefined;
    affectedChapters?: number | undefined;
    affectedWords?: number | undefined;
    rollbackThreshold?: number | undefined;
}

export interface ConflictVerdictCardProps {
    safeHalt?: SafeHaltInfo | null | undefined;
    syncConflict?: SyncConflictDiagnostic | null | undefined;
    gateViolations?: readonly VerdictGateViolationItem[] | undefined;
    isBusy?: boolean | undefined;
    healing?: boolean | undefined;
    onHealConflicts?: (() => void) | undefined;
    onEditChapter?: (() => void) | undefined;
    onRetryWithNote?: ((noteText: string) => void) | undefined;
    onFocusNoteDock?: ((kind: 'DIRECTOR_NOTE' | 'RETCON', prefill: string) => void) | undefined;
}

function formatRefLine(ref: string | undefined, line: number | null | undefined): string {
    if (!ref) return '未标定出处';
    return typeof line === 'number' && Number.isFinite(line) ? `${ref} · L${line}` : ref;
}

function renderHaltIssuesList(
    issues: NonNullable<SafeHaltInfo['issues']>,
    gateViolations: readonly VerdictGateViolationItem[]
): React.ReactNode {
    if (issues.length === 0 && gateViolations.length === 0) return null;
    return (
        <div className="ns-conflict-issues-list" aria-label="拦截冲突与门禁明细">
            {issues.map((issue, idx) => (
                <div key={`halt-issue-${idx}`} className="ns-conflict-issue-item">
                    <div className="ns-compare-caption">
                        <span>{issue.rule ?? `核查问题 #${idx + 1}`}</span>
                        <span className="ns-mono">
                            {formatRefLine(issue.sourceRef, issue.line)}
                        </span>
                    </div>
                    {issue.detail ? <div>{issue.detail}</div> : null}
                    {issue.sourceQuote ? (
                        <div className="ns-mono">依据：{issue.sourceQuote}</div>
                    ) : null}
                    {issue.quote ?? issue.snippet ? (
                        <div className="ns-mono">草稿：{issue.quote ?? issue.snippet}</div>
                    ) : null}
                </div>
            ))}
            {gateViolations.map((violation, idx) => (
                <div key={`gate-violation-${idx}`} className="ns-conflict-issue-item">
                    <div className="ns-compare-caption">
                        <span>门禁规则 · {violation.rule}</span>
                        {violation.line !== undefined ? (
                            <span className="ns-mono">L{violation.line}</span>
                        ) : null}
                    </div>
                    <div>{violation.detail}</div>
                    {violation.snippet ? (
                        <div className="ns-mono">{violation.snippet}</div>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

/**
 * 双模式设定冲突裁决卡（Q1 物理真源严格分流）：
 * - 已落盘跨章冲突：只处理本条报告项；仅有隔离报告时不能授权其他冲突。
 * - 未落盘新章拦截（safe_halt）：完整展示 issues 与 gateViolations 明细，提供「带上微调便签重写本章」与「先写便签调整走向」，绝不渲染会 404 的直接改稿或无效自愈按钮
 */
export function ConflictVerdictCard({
    safeHalt,
    syncConflict,
    gateViolations = [],
    isBusy = false,
    healing = false,
    onHealConflicts,
    onEditChapter,
    onRetryWithNote,
    onFocusNoteDock
}: ConflictVerdictCardProps): React.ReactElement | null {
    if (syncConflict) {
        const scopeParts: string[] = [];
        if (typeof syncConflict.affectedChapters === 'number') {
            scopeParts.push(`波及 ${syncConflict.affectedChapters} 章`);
        }
        if (typeof syncConflict.affectedWords === 'number') {
            scopeParts.push(`约 ${syncConflict.affectedWords.toLocaleString('zh-CN')} 字`);
        }
        if (typeof syncConflict.rollbackThreshold === 'number') {
            scopeParts.push(`自动回滚上限 ${syncConflict.rollbackThreshold} 章`);
        }
        const prefill = `解释或圆谎：${syncConflict.description}`;

        return (
            <section
                className="ns-conflict-card"
                data-conflict-mode="sync_conflicts"
                role="alert"
                aria-label="已落盘跨章设定冲突"
            >
                <div className="ns-conflict-head">
                    <div className="ns-conflict-title-wrap">
                        <span className="ns-badge ns-badge-danger">已暂停 · 发现设定冲突</span>
                        <span>{syncConflict.description}</span>
                    </div>
                    {scopeParts.length > 0 ? (
                        <span className="ns-conflict-scope ns-num">{scopeParts.join(' · ')}</span>
                    ) : null}
                </div>

                <div className="ns-conflict-body">
                    <div className="ns-conflict-compare">
                        <div className="ns-compare-pane">
                            <div className="ns-compare-caption">
                                <span>冲突侧 A（上游设定 / 前文）</span>
                                <span className="ns-mono">
                                    {formatRefLine(syncConflict.leftRef, syncConflict.leftLine)}
                                </span>
                            </div>
                            <div>{syncConflict.leftExcerpt || '请结合左侧上游设定档案核对原句。'}</div>
                        </div>

                        <div className="ns-compare-pane">
                            <div className="ns-compare-caption">
                                <span>冲突侧 B（已落盘章节正文）</span>
                                <span className="ns-mono">
                                    {formatRefLine(syncConflict.rightRef, syncConflict.rightLine)}
                                </span>
                            </div>
                            <div>{syncConflict.rightExcerpt || '请核对已落盘章节中的冲突描写。'}</div>
                        </div>
                    </div>

                    <div className="ns-conflict-actions">
                        <button
                            type="button"
                            className="ns-btn ns-btn-primary"
                            disabled={isBusy || healing || !onHealConflicts}
                            onClick={onHealConflicts}
                        >
                            {StudioIcons.spark}
                            <span>{healing ? '正在处理…' : '处理本条冲突（可能按作品限额回滚重跑）'}</span>
                        </button>
                        <button
                            type="button"
                            className="ns-btn ns-btn-outline"
                            disabled={isBusy || !onEditChapter}
                            onClick={onEditChapter}
                        >
                            {StudioIcons.edit}
                            <span>我自己动手改稿</span>
                        </button>
                        <button
                            type="button"
                            className="ns-btn ns-btn-subtle"
                            disabled={isBusy || !onFocusNoteDock}
                            onClick={() => onFocusNoteDock?.('RETCON', prefill)}
                        >
                            <span>写条便签解释原因</span>
                        </button>
                    </div>
                </div>
            </section>
        );
    }

    if (!safeHalt) {
        return null;
    }

    const issues = safeHalt.issues ?? [];
    const firstIssue = issues[0];
    const leftRef = formatRefLine(
        safeHalt.leftRef ?? firstIssue?.sourceRef,
        safeHalt.leftLine
    );
    const rightRef = formatRefLine(
        safeHalt.rightRef ??
            (safeHalt.chapter !== undefined
                ? `第 ${safeHalt.chapter} 章草稿`
                : '未落盘新章草稿'),
        safeHalt.rightLine ?? firstIssue?.line
    );
    const leftExcerpt =
        safeHalt.leftExcerpt ??
        firstIssue?.sourceQuote ??
        safeHalt.details ??
        safeHalt.reason;
    const rightExcerpt =
        safeHalt.rightExcerpt ??
        firstIssue?.quote ??
        firstIssue?.snippet ??
        firstIssue?.detail ??
        '当前草稿未通过门禁核查，已拦截落盘。';
    const retryNote = `纠偏重写：${safeHalt.reason}`;

    const haltScopeParts: string[] = [];
    if (safeHalt.stage) {
        const stageLabel = safeHalt.stage.replace(/fact[\s_-]*check(?:er)?/gi, 'Checker');
        haltScopeParts.push(`拦截环节 ${stageLabel}`);
    }
    if (typeof safeHalt.affectedChapters === 'number') {
        haltScopeParts.push(`波及 ${safeHalt.affectedChapters} 章`);
    }
    if (typeof safeHalt.affectedWords === 'number') {
        haltScopeParts.push(`约 ${safeHalt.affectedWords.toLocaleString('zh-CN')} 字`);
    }

    return (
        <section
            className="ns-conflict-card"
            data-conflict-mode="safe_halt"
            role="alert"
            aria-label="未落盘新章安全拦截"
        >
            <div className="ns-conflict-head">
                <div className="ns-conflict-title-wrap">
                    <span className="ns-badge ns-badge-danger">已暂停 · 新章拦截（未落盘）</span>
                    <span>{safeHalt.reason}</span>
                </div>
                {haltScopeParts.length > 0 ? (
                    <span className="ns-conflict-scope ns-num">{haltScopeParts.join(' · ')}</span>
                ) : null}
            </div>

            <div className="ns-conflict-body">
                <div className="ns-conflict-compare">
                    <div className="ns-compare-pane">
                        <div className="ns-compare-caption">
                            <span>前文真源 / 设定依据</span>
                            <span className="ns-mono">{leftRef}</span>
                        </div>
                        <div>{leftExcerpt}</div>
                    </div>

                    <div className="ns-compare-pane">
                        <div className="ns-compare-caption">
                            <span>被拦截新章草稿（未落盘）</span>
                            <span className="ns-mono">{rightRef}</span>
                        </div>
                        <div>{rightExcerpt}</div>
                    </div>
                </div>

                {renderHaltIssuesList(issues, gateViolations)}

                <div className="ns-conflict-actions">
                    <button
                        type="button"
                        className="ns-btn ns-btn-primary"
                        disabled={isBusy || !onRetryWithNote}
                        onClick={() => onRetryWithNote?.(retryNote)}
                    >
                        {StudioIcons.play}
                        <span>带上微调便签重写本章</span>
                    </button>
                    <button
                        type="button"
                        className="ns-btn ns-btn-outline"
                        disabled={isBusy || !onFocusNoteDock}
                        onClick={() => onFocusNoteDock?.('DIRECTOR_NOTE', retryNote)}
                    >
                        <span>先写便签调整走向</span>
                    </button>
                </div>
            </div>
        </section>
    );
}

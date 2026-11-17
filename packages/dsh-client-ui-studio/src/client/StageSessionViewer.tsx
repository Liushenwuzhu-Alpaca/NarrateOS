import React, { useEffect, useState } from 'react';
import { fetchRunDetail } from './api';
import type { StageNodeStatus } from './CenterWorkbench';
import type {
    RunDetailPayload,
    RunDetailToolCall,
    RunDetailTurn,
    StageSessionSubagentMode
} from './types';

/** 阶段会话视图模式：chat=原生 Conversation 思考与工具流；trajectory=原生 Trajectory 轮次明细 */
export type StageSessionViewMode = 'chat' | 'trajectory';

/** 阶段节点关联的会话钻取目标 */
export interface StageSessionSelection {
    stageId: string;
    stageLabel: string;
    sessionId: string;
    parentSessionId?: string | undefined;
    mode?: StageSessionSubagentMode | string | undefined;
    runId?: string | undefined;
    status: StageNodeStatus;
    cleanroom?: boolean | undefined;
}

/** 宿主 Session 引用句柄（对齐 @deepseek-ai/dsh-api-session-controller SessionReference） */
export interface StudioSessionReference {
    readonly sessionId: string;
    readonly ready?: Promise<unknown> | undefined;
    release(): void;
}

/** 宿主 sessions.retain 支持的会话定位目标（SessionId 或父子 SubagentAddress） */
export type StudioSessionTarget =
    | string
    | {
          parentSessionId: string;
          childSessionId: string;
          mode: StageSessionSubagentMode;
      };

/** 宿主 ctx.sessions 最小结构接口 */
export interface StudioSessionsService {
    retain(
        target: StudioSessionTarget,
        options: {
            source: string;
            signal?: AbortSignal | undefined;
        }
    ): StudioSessionReference;
    list?: {
        getSnapshot(): {
            byId?: Record<string, { title?: string | undefined; running?: boolean | undefined }> | undefined;
        };
    } | undefined;
}

/** 宿主 SlotRegistry 提供的 SessionProvider 组件签名 */
export type StudioSessionProviderComponent = React.ComponentType<{
    session: unknown;
    children?: React.ReactNode;
}>;

/** 渲染子槽位 narrateos.stage.conversation 的回调 */
export type StudioRenderStageConversation = (owner: {
    view?: StageSessionViewMode | string;
}) => React.ReactNode;

/** StageSessionViewer 组件 Props */
export interface StageSessionViewerProps {
    selection: StageSessionSelection | null;
    sessionsService?: StudioSessionsService | undefined;
    SessionProvider?: StudioSessionProviderComponent | undefined;
    renderStageConversation?: StudioRenderStageConversation | undefined;
    onClose?: (() => void) | undefined;
}

function defaultViewModeForStatus(status: StageNodeStatus | undefined): StageSessionViewMode {
    if (status === 'active' || status === 'healing') {
        return 'chat';
    }
    return 'trajectory';
}

function formatStageStatusText(status: StageNodeStatus): {
    label: string;
    pillClass: string;
} {
    switch (status) {
        case 'active':
            return { label: '运行中', pillClass: 'ns-pill ns-pill-brand' };
        case 'done':
            return { label: '已完成', pillClass: 'ns-pill ns-pill-green' };
        case 'healing':
            return { label: '返修中', pillClass: 'ns-pill ns-pill-amber' };
        case 'halt':
            return { label: '已拦截', pillClass: 'ns-pill ns-pill-red' };
        case 'dormant':
            return { label: '条件未达', pillClass: 'ns-pill ns-pill-muted' };
        case 'idle':
        default:
            return { label: '待命', pillClass: 'ns-pill ns-pill-muted' };
    }
}

function normalizeSubagentMode(mode: string | undefined): StageSessionSubagentMode {
    if (mode === 'one-shot' || mode === 'continuable' || mode === 'unknown') {
        return mode;
    }
    return 'one-shot';
}

function formatDetailValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function renderToolCallList(calls: readonly RunDetailToolCall[] | undefined, keyPrefix: string): React.ReactNode {
    if (!calls || calls.length === 0) return null;
    return (
        <div className="ns-session-tool-list">
            {calls.map((call, idx) => {
                const argsText = formatDetailValue(call.arguments);
                const resultText = formatDetailValue(call.result);
                return (
                    <div key={call.id ?? `${keyPrefix}-tool-${idx}`} className="ns-session-tool-call">
                        <div className="ns-session-tool-head ns-mono">
                            <strong>{call.name}</strong>
                            {call.status ? <span className="ns-muted">{call.status}</span> : null}
                            {typeof call.durationMs === 'number' ? (
                                <span className="ns-muted">{call.durationMs}ms</span>
                            ) : null}
                        </div>
                        {argsText ? (
                            <pre className="ns-session-pre ns-mono">{argsText}</pre>
                        ) : null}
                        {resultText ? (
                            <pre className="ns-session-pre ns-session-pre-result ns-mono">{resultText}</pre>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

function renderRunTurn(turn: RunDetailTurn, index: number): React.ReactNode {
    const turnNumber = typeof turn.turnIndex === 'number' ? turn.turnIndex + 1 : index + 1;
    const thinking = turn.thinking ?? turn.reasoning;
    const outputText = turn.content ?? turn.output ?? turn.text;
    const calls = turn.toolCalls ?? turn.tool_calls;

    return (
        <article key={`turn-${turnNumber}-${index}`} className="ns-session-turn">
            <div className="ns-session-turn-head ns-mono">
                <strong>Turn #{turnNumber}</strong>
                {turn.role ? <span className="ns-pill ns-pill-muted">{turn.role}</span> : null}
                {turn.timestamp ? <span className="ns-muted">{turn.timestamp}</span> : null}
            </div>
            {thinking ? (
                <details className="ns-session-turn-thinking" open>
                    <summary>Thinking</summary>
                    <pre className="ns-session-pre">{thinking}</pre>
                </details>
            ) : null}
            {renderToolCallList(calls, `turn-${index}`)}
            {outputText ? (
                <div className="ns-session-turn-output">{outputText}</div>
            ) : null}
        </article>
    );
}

/**
 * 阶段工种原生 DSH Conversation / Trajectory 会话钻取检查器：
 * - 完整宿主环境（sessionsService + SessionProvider + renderStageConversation）下：
 *   调用 sessionsService.retain(...) 获取实时/历史引用（有 parentSessionId 时透传父子地址），
 *   并在卸载或切换 sessionId 时立即屏蔽旧 sessionRef 并准确调用 reference.release() 释放引用。
 * - 在内部通过 SessionProvider 挂载 'narrateos.stage.conversation' -> 'conversation.content'，
 *   支持在原生 Conversation（实时思考块与工具流）与 Trajectory（轮次耗时/Token/JSON 明细）间切换。
 * - 无宿主会话服务或 retain() 失败时：自动回源 GET /api/narrate/runs/detail?sessionId=... 展示回合、思考、工具调用与输出，
 *   并在接口返回 404 或不可用时静默保留元数据与复制入口。
 */
export function StageSessionViewer({
    selection,
    sessionsService,
    SessionProvider,
    renderStageConversation,
    onClose
}: StageSessionViewerProps): React.ReactElement {
    const [viewMode, setViewMode] = useState<StageSessionViewMode>(() =>
        defaultViewModeForStatus(selection?.status)
    );
    const [sessionRef, setSessionRef] = useState<StudioSessionReference | null>(null);
    const [readyState, setReadyState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [retainError, setRetainError] = useState<string | null>(null);
    const [runDetail, setRunDetail] = useState<RunDetailPayload | null>(null);
    const [detailLoading, setDetailLoading] = useState<boolean>(false);
    const [copied, setCopied] = useState<boolean>(false);

    useEffect(() => {
        setViewMode(defaultViewModeForStatus(selection?.status));
        setCopied(false);
    }, [selection?.sessionId, selection?.stageId]);

    useEffect(() => {
        const targetSessionId = selection?.sessionId;
        // 切换会话或清理选中前立刻清空旧 sessionRef，防止切换瞬间把旧句柄传给新子树
        setSessionRef(null);
        setRetainError(null);
        setReadyState('idle');

        if (!sessionsService || !targetSessionId || selection?.cleanroom) {
            return;
        }

        const controller = new AbortController();
        let disposed = false;
        let acquired: StudioSessionReference | null = null;

        const retainTarget: StudioSessionTarget = selection.parentSessionId
            ? {
                  parentSessionId: selection.parentSessionId,
                  childSessionId: targetSessionId,
                  mode: normalizeSubagentMode(selection.mode)
              }
            : targetSessionId;

        try {
            acquired = sessionsService.retain(retainTarget, {
                source: 'narrateosStudio',
                signal: controller.signal
            });
            setSessionRef(acquired);
            setRetainError(null);

            if (acquired.ready) {
                setReadyState('loading');
                void acquired.ready.then(
                    () => {
                        if (!disposed) {
                            setReadyState('ready');
                        }
                    },
                    (err: unknown) => {
                        if (!disposed) {
                            setSessionRef(null);
                            setReadyState('error');
                            setRetainError(err instanceof Error ? err.message : String(err));
                        }
                    }
                );
            } else {
                setReadyState('ready');
            }
        } catch (err) {
            setSessionRef(null);
            setReadyState('error');
            setRetainError(err instanceof Error ? err.message : String(err));
        }

        return () => {
            disposed = true;
            controller.abort();
            if (acquired) {
                try {
                    acquired.release();
                } catch {
                    // 忽略宿主销毁后的重复释放
                }
            }
        };
    }, [
        sessionsService,
        selection?.sessionId,
        selection?.parentSessionId,
        selection?.mode,
        selection?.cleanroom
    ]);

    const shouldFetchDetail = Boolean(
        selection &&
            !selection.cleanroom &&
            selection.sessionId &&
            (!sessionsService || !SessionProvider || !renderStageConversation || Boolean(retainError))
    );

    useEffect(() => {
        setRunDetail(null);
        if (!shouldFetchDetail || !selection?.sessionId) {
            setDetailLoading(false);
            return;
        }

        let cancelled = false;
        setDetailLoading(true);
        void fetchRunDetail(selection.sessionId)
            .then((detail) => {
                if (!cancelled && detail && detail.sessionId === selection.sessionId) {
                    setRunDetail(detail);
                }
            })
            .catch(() => {
                // 独立单测或旧后端返回 404 / 网络失败时静默降级为元数据面板
                if (!cancelled) {
                    setRunDetail(null);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setDetailLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [shouldFetchDetail, selection?.sessionId]);

    const handleCopySessionId = () => {
        if (!selection?.sessionId) return;
        const text = selection.sessionId;
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false)
            );
            return;
        }
        setCopied(true);
    };

    if (!selection) {
        return (
            <div className="ns-session-viewer ns-session-empty" aria-label="阶段会话检查器">
                <div className="ns-session-empty-card">
                    <strong>未选择工种会话节点</strong>
                    <p>
                        点击中栏顶部的 6 圆点流水线胶囊展开阶段图，再点击任意已绑定会话的节点
                        （Librarian / Planner / Fact Check / Extractor / Dreaming），即可在此查看实时思考流或历史 Trajectory。
                    </p>
                    <p className="ns-muted">
                        注：Writer 采用零工具单轮净室调用（直调 ctx.llm），不创建多轮 Agent Session。
                    </p>
                </div>
            </div>
        );
    }

    const statusMeta = formatStageStatusText(selection.status);
    const activeSessionRef =
        sessionRef && sessionRef.sessionId === selection.sessionId ? sessionRef : null;
    const canMountNative = Boolean(
        !selection.cleanroom &&
            activeSessionRef &&
            SessionProvider &&
            renderStageConversation &&
            !retainError
    );

    const topLevelThinking = runDetail?.thinking ?? runDetail?.reasoning;
    const topLevelOutput = runDetail?.output ?? runDetail?.finalOutput ?? runDetail?.summary;
    const hasDetailBody = Boolean(
        runDetail &&
            ((Array.isArray(runDetail.turns) && runDetail.turns.length > 0) ||
                topLevelThinking ||
                (Array.isArray(runDetail.toolCalls) && runDetail.toolCalls.length > 0) ||
                topLevelOutput)
    );

    return (
        <div
            className="ns-session-viewer"
            aria-label="阶段会话检查器"
            data-stage-id={selection.stageId}
            data-session-id={selection.sessionId}
        >
            <header className="ns-session-head">
                <div className="ns-session-title-row">
                    <div className="ns-session-title-group">
                        <strong>{selection.stageLabel}</strong>
                        <span className={statusMeta.pillClass}>{statusMeta.label}</span>
                    </div>
                    {onClose ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-ghost ns-btn-xs"
                            onClick={onClose}
                            aria-label="返回检查器"
                        >
                            返回
                        </button>
                    ) : null}
                </div>

                <div className="ns-session-meta-row">
                    <span className="ns-mono ns-session-id-badge" title={selection.sessionId}>
                        session: {selection.sessionId}
                    </span>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        onClick={handleCopySessionId}
                    >
                        {copied ? '已复制' : '复制 ID'}
                    </button>
                </div>

                {selection.runId ? (
                    <div className="ns-session-run-row ns-mono">
                        runId: {selection.runId}
                    </div>
                ) : null}

                {!selection.cleanroom ? (
                    <div className="ns-session-view-ring" role="group" aria-label="原生会话视图切换">
                        <button
                            type="button"
                            className={`ns-session-view-btn${viewMode === 'chat' ? ' on' : ''}`}
                            aria-pressed={viewMode === 'chat'}
                            onClick={() => setViewMode('chat')}
                        >
                            Conversation
                        </button>
                        <button
                            type="button"
                            className={`ns-session-view-btn${viewMode === 'trajectory' ? ' on' : ''}`}
                            aria-pressed={viewMode === 'trajectory'}
                            onClick={() => setViewMode('trajectory')}
                        >
                            Trajectory
                        </button>
                    </div>
                ) : null}
            </header>

            <div className="ns-session-body">
                {selection.cleanroom ? (
                    <div className="ns-session-fallback" role="status">
                        <div className="ns-session-fallback-title">净室单轮执行（无 Agent Session）</div>
                        <p>
                            Writer（含局部 Patch）直接调用 <code>ctx.llm</code> 单轮零工具生成，不创建多轮 Agent Session。
                            门禁指标、缓存命中与 Token 统计请切换至「检查器」页签，原始净室载荷见作品
                            <code>.ops/traces/</code>。
                        </p>
                    </div>
                ) : canMountNative && SessionProvider && renderStageConversation && activeSessionRef ? (
                    <div
                        className="ns-stage-session-embed"
                        data-stage-session-mode={viewMode}
                        data-session-ready={readyState}
                    >
                        {readyState === 'loading' ? (
                            <div className="ns-session-loading-bar" role="status">
                                正在加载原生 {viewMode === 'chat' ? 'Conversation' : 'Trajectory'} 会话…
                            </div>
                        ) : null}
                        <SessionProvider key={activeSessionRef.sessionId} session={activeSessionRef}>
                            {renderStageConversation({ view: viewMode })}
                        </SessionProvider>
                    </div>
                ) : (
                    <div className="ns-session-fallback" data-session-fallback="true">
                        <div className="ns-session-fallback-title">
                            {retainError ? '会话加载失败' : '原生 DSH 会话预览不可用'}
                        </div>
                        {retainError ? (
                            <p className="ns-session-error" role="alert">
                                {retainError}
                            </p>
                        ) : (
                            <p>
                                当前运行环境未注入宿主 <code>sessions</code> / <code>slots</code> 渲染器，
                                无法挂载原生 {viewMode === 'chat' ? 'Conversation' : 'Trajectory'} 视图；已在上方保留完整标识。
                            </p>
                        )}
                        <dl className="ns-session-kv ns-mono">
                            <dt>stageId</dt>
                            <dd>{selection.stageId}</dd>
                            <dt>sessionId</dt>
                            <dd>{selection.sessionId}</dd>
                            <dt>status</dt>
                            <dd>{selection.status}</dd>
                            <dt>viewMode</dt>
                            <dd>{viewMode}</dd>
                            {selection.runId ? (
                                <>
                                    <dt>runId</dt>
                                    <dd>{selection.runId}</dd>
                                </>
                            ) : null}
                        </dl>

                        {detailLoading ? (
                            <div className="ns-session-loading-bar" role="status">
                                正在拉取历史会话明细…
                            </div>
                        ) : null}

                        {hasDetailBody && runDetail ? (
                            <div className="ns-session-detail" data-session-detail="true">
                                {topLevelThinking ? (
                                    <details className="ns-session-turn-thinking" open>
                                        <summary>Thinking</summary>
                                        <pre className="ns-session-pre">{topLevelThinking}</pre>
                                    </details>
                                ) : null}
                                {renderToolCallList(runDetail.toolCalls, 'root')}
                                {Array.isArray(runDetail.turns) && runDetail.turns.length > 0 ? (
                                    <div className="ns-session-turns">
                                        {runDetail.turns.map((turn, idx) => renderRunTurn(turn, idx))}
                                    </div>
                                ) : null}
                                {topLevelOutput ? (
                                    <div className="ns-session-turn-output">{topLevelOutput}</div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                )}
            </div>
        </div>
    );
}

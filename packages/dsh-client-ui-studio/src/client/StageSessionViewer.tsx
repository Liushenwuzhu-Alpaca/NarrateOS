import React, { useEffect, useState } from 'react';
import type { StageNodeStatus } from './CenterWorkbench';

/** 阶段会话视图模式：chat=原生 Conversation 思考与工具流；trajectory=原生 Trajectory 轮次明细 */
export type StageSessionViewMode = 'chat' | 'trajectory';

/** 阶段节点关联的会话钻取目标 */
export interface StageSessionSelection {
    stageId: string;
    stageLabel: string;
    sessionId: string;
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

/** 宿主 ctx.sessions 最小结构接口 */
export interface StudioSessionsService {
    retain(
        target: string,
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

/**
 * 阶段工种原生 DSH Conversation / Trajectory 会话钻取检查器：
 * - 完整宿主环境（sessionsService + SessionProvider + renderStageConversation）下：
 *   调用 sessionsService.retain(sessionId, { source: 'narrateosStudio' }) 获取实时/历史引用，
 *   并在卸载或切换 sessionId 时准确调用 reference.release() 释放引用。
 * - 在内部通过 SessionProvider 挂载 'narrateos.stage.conversation' -> 'conversation.content'，
 *   支持在原生 Conversation（实时思考块与工具流）与 Trajectory（轮次耗时/Token/JSON 明细）间切换。
 * - 无宿主会话服务时（单测/独立预览）：降级为信息丰富的元数据面板，展示 sessionId、stageId、运行状态与复制入口。
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
    const [copied, setCopied] = useState<boolean>(false);

    useEffect(() => {
        setViewMode(defaultViewModeForStatus(selection?.status));
        setCopied(false);
    }, [selection?.sessionId, selection?.stageId]);

    useEffect(() => {
        const targetSessionId = selection?.sessionId;
        if (!sessionsService || !targetSessionId || selection?.cleanroom) {
            setSessionRef(null);
            setReadyState('idle');
            setRetainError(null);
            return;
        }

        const controller = new AbortController();
        let disposed = false;
        let acquired: StudioSessionReference | null = null;

        try {
            acquired = sessionsService.retain(targetSessionId, {
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
    }, [sessionsService, selection?.sessionId, selection?.cleanroom]);

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
    const canMountNative = Boolean(
        !selection.cleanroom &&
            sessionRef &&
            SessionProvider &&
            renderStageConversation &&
            !retainError
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
                ) : canMountNative && SessionProvider && renderStageConversation ? (
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
                        <SessionProvider session={sessionRef}>
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
                    </div>
                )}
            </div>
        </div>
    );
}

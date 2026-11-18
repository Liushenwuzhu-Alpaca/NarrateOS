import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';

const WINDOW_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** 换卷弹窗可选随行核心人物条目 */
export interface AdvanceVolumeEntityOption {
    id: string;
    name: string;
    role?: string | undefined;
}

/** 换卷提交载荷 */
export interface AdvanceVolumeSubmitPayload {
    companionEntityIds: string[];
    completeBook: boolean;
}

/** 结束本卷 / 开启下一卷 弹窗 Props */
export interface AdvanceVolumeModalProps {
    open: boolean;
    currentVolumeLabel?: string | undefined;
    entities: readonly AdvanceVolumeEntityOption[];
    submitting?: boolean | undefined;
    errorMessage?: string | null | undefined;
    onClose: () => void;
    onConfirm: (payload: AdvanceVolumeSubmitPayload) => Promise<void> | void;
}

/** 多线并行章节窗口提交载荷 */
export interface ParallelWindowForkPayload {
    windowId: string;
    branchId?: string | undefined;
}

/** 多线并行章节窗口合流载荷 */
export interface ParallelWindowMergePayload {
    windowId: string;
}

/** 多线并行章节窗口弹窗 Props */
export interface ParallelWindowModalProps {
    open: boolean;
    parallelActive?: boolean | undefined;
    activeWindowId?: string | undefined;
    activeBranchId?: string | undefined;
    availableBranches?: readonly string[] | undefined;
    submitting?: boolean | undefined;
    errorMessage?: string | null | undefined;
    onClose: () => void;
    onFork: (payload: ParallelWindowForkPayload) => Promise<void> | void;
    onMerge: (payload: ParallelWindowMergePayload) => Promise<void> | void;
}

function CloseIcon(): React.ReactElement {
    return (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    );
}

interface ActionModalHeaderProps {
    title: string;
    subtitle?: string | undefined;
    disabled: boolean;
    onClose: () => void;
}

function ActionModalHeader({ title, subtitle, disabled, onClose }: ActionModalHeaderProps): React.ReactElement {
    return (
        <header className="ns-modal-head">
            <div className="ns-b-head-stack">
                <h2 className="ns-b-title">{title}</h2>
                {subtitle ? <p className="ns-b-head-hint">{subtitle}</p> : null}
            </div>
            <button
                type="button"
                className="ns-btn ns-btn-ghost ns-btn-xs"
                disabled={disabled}
                aria-label="关闭弹窗"
                onClick={onClose}
            >
                <CloseIcon />
            </button>
        </header>
    );
}

/**
 * 结束本卷 / 开启下一卷 轻量无障碍弹窗：
 * - 勾选随行核心人物（companionEntityIds），未勾选角色自动归入冷档案
 * - 支持完结封笔开关（completeBook）及确认提醒
 */
export const AdvanceVolumeModal: React.FC<AdvanceVolumeModalProps> = ({
    open,
    currentVolumeLabel,
    entities,
    submitting = false,
    errorMessage = null,
    onClose,
    onConfirm
}) => {
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [completeBook, setCompleteBook] = useState(false);
    const wasOpenRef = useRef(false);

    useEffect(() => {
        if (open && !wasOpenRef.current) {
            setSelectedIds(entities.map((entity) => entity.id));
            setCompleteBook(false);
        }
        wasOpenRef.current = open;
    }, [open, entities]);

    if (!open) {
        return null;
    }

    const toggleEntity = (id: string) => {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
        );
    };

    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (submitting) return;
        void onConfirm({
            companionEntityIds: selectedIds,
            completeBook
        });
    };

    const volumeSubtitle = currentVolumeLabel
        ? `当前卷：${currentVolumeLabel}`
        : '封存本卷摘要并整理跨卷人物档案';

    return (
        <Modal
            open={open}
            onClose={submitting ? () => undefined : onClose}
            title="结束本卷 / 开启下一卷"
            headless
            className="ns-b-modal-shell ns-action-modal-shell"
            contentClassName="ns-b-modal-content ns-action-modal-content"
        >
            <ActionModalHeader
                title="结束本卷 / 开启下一卷"
                subtitle={volumeSubtitle}
                disabled={submitting}
                onClose={onClose}
            />
            <form onSubmit={handleSubmit}>
                <div className="ns-modal-body ns-action-modal-body">
                    <p className="ns-action-modal-desc">
                        系统将封存当前卷摘要并打上版本标签，未勾选的长期退场人物将自动归入冷档案以节省后续上下文。
                    </p>

                    <div className="ns-action-check-group" role="group" aria-label="勾选跨入下一卷的随行核心人物">
                        <div className="ns-action-check-head">
                            <span>勾选跨入下一卷的随行核心人物</span>
                            <span className="ns-num">
                                已选 {selectedIds.length} / {entities.length}
                            </span>
                        </div>
                        {entities.length === 0 ? (
                            <div className="ns-action-empty">当前暂无活跃人物档案，可直接封存本卷。</div>
                        ) : (
                            <div className="ns-action-check-list">
                                {entities.map((entity) => {
                                    const checked = selectedIds.includes(entity.id);
                                    return (
                                        <label key={entity.id} className="ns-action-check-item">
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                disabled={submitting || completeBook}
                                                onChange={() => toggleEntity(entity.id)}
                                            />
                                            <span className="ns-action-check-name">{entity.name}</span>
                                            {entity.role ? (
                                                <span className="ns-action-check-role">{entity.role}</span>
                                            ) : null}
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <label className="ns-action-toggle-row">
                        <input
                            type="checkbox"
                            checked={completeBook}
                            disabled={submitting}
                            onChange={(e) => setCompleteBook(e.target.checked)}
                        />
                        <span>全书完结封笔（不再开启下一卷）</span>
                    </label>

                    {completeBook ? (
                        <div className="ns-action-warn-box" role="note">
                            开启完结封笔后，本卷封存即标记整部作品正式完结，后续不再开启下一卷。
                        </div>
                    ) : null}

                    {errorMessage ? (
                        <div role="alert" className="ns-b-error-bar">
                            {errorMessage}
                        </div>
                    ) : null}
                </div>

                <footer className="ns-modal-foot">
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost"
                        disabled={submitting}
                        onClick={onClose}
                    >
                        取消
                    </button>
                    <button
                        type="submit"
                        className="ns-btn ns-btn-primary"
                        disabled={submitting}
                    >
                        {submitting
                            ? '正在封存本卷…'
                            : completeBook
                              ? '确认完结封笔'
                              : '封存本卷并开启下一卷'}
                    </button>
                </footer>
            </form>
        </Modal>
    );
};

/**
 * 多线并行章节窗口 轻量无障碍弹窗：
 * - windowId 正则校验 /^[a-zA-Z0-9_-]+$/
 * - 支持开启并行分叉、切换支线继续写与合流回主线
 */
export const ParallelWindowModal: React.FC<ParallelWindowModalProps> = ({
    open,
    parallelActive = false,
    activeWindowId = '',
    activeBranchId = '',
    availableBranches = ['branch-a', 'branch-b'],
    submitting = false,
    errorMessage = null,
    onClose,
    onFork,
    onMerge
}) => {
    const [windowId, setWindowId] = useState(activeWindowId);
    const [branchId, setBranchId] = useState(activeBranchId);
    const [validationError, setValidationError] = useState<string | null>(null);
    const wasOpenRef = useRef(false);

    useEffect(() => {
        if (open && !wasOpenRef.current) {
            setWindowId(activeWindowId);
            setBranchId(activeBranchId);
            setValidationError(null);
        }
        wasOpenRef.current = open;
    }, [open, activeWindowId, activeBranchId]);

    if (!open) {
        return null;
    }

    const validateWindowId = (): string | null => {
        const trimmed = windowId.trim();
        if (!trimmed || !WINDOW_ID_RE.test(trimmed)) {
            setValidationError('并行窗口标识仅允许字母、数字、下划线(_)与连字符(-)，且不能为空');
            return null;
        }
        setValidationError(null);
        return trimmed;
    };

    const handleForkSubmit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (submitting) return;
        const validWindowId = validateWindowId();
        if (!validWindowId) return;
        const rawBranch = branchId.trim();
        if (rawBranch && !WINDOW_ID_RE.test(rawBranch)) {
            setValidationError('并行支线标识仅允许字母、数字、下划线(_)与连字符(-)');
            return;
        }
        const resolvedBranch = rawBranch || availableBranches[0] || 'branch-a';
        void onFork({
            windowId: validWindowId,
            branchId: resolvedBranch
        });
    };

    const handleMergeClick = () => {
        if (submitting) return;
        const validWindowId = validateWindowId();
        if (!validWindowId) return;
        void onMerge({ windowId: validWindowId });
    };

    const displayError = validationError ?? errorMessage;

    return (
        <Modal
            open={open}
            onClose={submitting ? () => undefined : onClose}
            title="多线并行章节窗口"
            headless
            className="ns-b-modal-shell ns-action-modal-shell"
            contentClassName="ns-b-modal-content ns-action-modal-content"
        >
            <ActionModalHeader
                title="多线并行章节窗口"
                subtitle={parallelActive ? '当前处于并行分叉时间段' : '为同期多主角支线开启隔离推进窗口'}
                disabled={submitting}
                onClose={onClose}
            />
            <form onSubmit={handleForkSubmit}>
                <div className="ns-modal-body ns-action-modal-body">
                    <p className="ns-action-modal-desc">
                        同一故事时间段分头推进两条人物支线（互不提前剧透对方结果），写完后一键合流回主线。
                    </p>

                    <label className="ns-field" htmlFor="ns-parallel-window-id">
                        <span>并行窗口标识 (windowId)</span>
                        <input
                            id="ns-parallel-window-id"
                            name="windowId"
                            type="text"
                            className="ns-input ns-b-mono-input"
                            data-modal-autofocus="true"
                            disabled={submitting}
                            value={windowId}
                            onChange={(e) => {
                                setWindowId(e.target.value);
                                if (validationError) setValidationError(null);
                            }}
                            placeholder="例如: win-dock-night"
                        />
                        <small className="ns-muted">仅允许字母、数字、下划线(_)与连字符(-)</small>
                    </label>

                    <label className="ns-field" htmlFor="ns-parallel-branch-id">
                        <span>当前支线标识（可选）</span>
                        <input
                            id="ns-parallel-branch-id"
                            name="branchId"
                            type="text"
                            className="ns-input ns-b-mono-input"
                            list="ns-parallel-branch-list"
                            disabled={submitting}
                            value={branchId}
                            onChange={(e) => setBranchId(e.target.value)}
                            placeholder="例如: branch-a"
                        />
                        <datalist id="ns-parallel-branch-list">
                            {availableBranches.map((item) => (
                                <option key={item} value={item} />
                            ))}
                        </datalist>
                    </label>

                    {displayError ? (
                        <div role="alert" className="ns-b-error-bar">
                            {displayError}
                        </div>
                    ) : null}
                </div>

                <footer className="ns-modal-foot">
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost"
                        disabled={submitting}
                        onClick={onClose}
                    >
                        取消
                    </button>
                    {parallelActive ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-warn"
                            disabled={submitting}
                            onClick={handleMergeClick}
                        >
                            合流回主线
                        </button>
                    ) : null}
                    <button
                        type="submit"
                        className="ns-btn ns-btn-primary"
                        disabled={submitting}
                    >
                        {parallelActive ? '切换支线继续写' : '开启并行分叉'}
                    </button>
                </footer>
            </form>
        </Modal>
    );
};

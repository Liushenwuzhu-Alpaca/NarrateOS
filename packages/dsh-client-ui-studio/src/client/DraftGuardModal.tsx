import React from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { DraftNavigationIntent } from './draft-guard';

/** 确认弹窗 Props：复用宿主 Modal（body portal / Escape / 焦点恢复），不自绘遮罩 */
export interface DraftGuardModalProps {
    open: boolean;
    intent: DraftNavigationIntent | null;
    draftChapter: number | null;
    bookTitle?: string | undefined;
    saving: boolean;
    error?: string | null | undefined;
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
}

/** 导航目标描述（用于弹窗正文，明确即将丢失的编辑位置） */
function describeIntent(intent: DraftNavigationIntent | null, bookTitle?: string): string {
    if (!intent) return '';
    if (intent.kind === 'chapter') {
        return `切换到第 ${intent.chapterNumber} 章`;
    }
    if (intent.kind === 'book') {
        return `切换到作品目录 ${intent.bookRoot}`;
    }
    return bookTitle ? `离开《${bookTitle}》并开新书` : '开新书';
}

/**
 * 未保存草稿离章确认：保存并继续 / 放弃修改 / 取消。
 * 保存失败时错误就地展示，弹窗保持打开且不导航；保存期间禁止关闭以防状态错乱。
 */
export const DraftGuardModal: React.FC<DraftGuardModalProps> = ({
    open,
    intent,
    draftChapter,
    bookTitle,
    saving,
    error,
    onSave,
    onDiscard,
    onCancel
}) => {
    return (
        <Modal
            open={open}
            onClose={saving ? () => undefined : onCancel}
            title="未保存的修改"
            description={
                draftChapter !== null
                    ? `第 ${draftChapter} 章有未保存的编辑，${describeIntent(intent, bookTitle)}前请选择如何处理。`
                    : '当前有未保存的编辑，离开前请选择如何处理。'
            }
            closeLabel="取消"
            className="ns-b-modal-shell ns-guard-modal-shell"
            contentClassName="ns-b-modal-content ns-guard-modal-content"
        >
            <div className="ns-guard-body">
                <p className="ns-guard-hint">
                    「放弃修改」只丢弃浏览器内未保存的草稿，不影响已提交的手稿。
                </p>
                {error ? (
                    <p className="ns-guard-error" role="alert">
                        保存失败：{error}（草稿已保留，未离开当前章节）
                    </p>
                ) : null}
            </div>
            <div className="ns-guard-actions">
                <button
                    type="button"
                    className="ns-btn ns-btn-ghost"
                    disabled={saving}
                    onClick={onCancel}
                >
                    取消
                </button>
                <button
                    type="button"
                    className="ns-btn ns-btn-stop"
                    disabled={saving}
                    onClick={onDiscard}
                >
                    放弃修改
                </button>
                <button
                    type="button"
                    className="ns-btn ns-btn-primary"
                    data-modal-autofocus=""
                    disabled={saving}
                    onClick={onSave}
                >
                    {saving ? '正在保存…' : '保存并继续'}
                </button>
            </div>
        </Modal>
    );
};
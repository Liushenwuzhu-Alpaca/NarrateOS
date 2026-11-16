import React, { useEffect, useState } from 'react';

/** 开书引导模式 */
export type BootBookMode = 'original' | 'fanfic';

/** 开书请求体 */
export interface BootBookRequestPayload {
    mode: BootBookMode;
    slug: string;
    title: string;
    povCharacter: string;
    premiseOrSeed?: string | undefined;
    sourceMaterial?: string | undefined;
    t0Anchor?: string | undefined;
}

/** 开书成功响应 */
export interface BootBookResponseData {
    status: string;
    bookRoot: string;
    result: unknown;
}

/** BootBookModal 组件 Props */
export interface BootBookModalProps {
    open: boolean;
    onClose: () => void;
    onBootSuccess?: ((data: BootBookResponseData) => void) | undefined;
    onSubmitBoot?: ((payload: BootBookRequestPayload) => Promise<BootBookResponseData>) | undefined;
}

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * NarrateOS 开新书模态弹窗组件（Step 0 Bootloader）：
 * - 支持选择模式：原创冷启动 (original) / 同人设定包 T0 切分 (fanfic)
 * - 填写 slug、书名、开局 POV 角色 ID、开局种子/同人设定包、T0 锚点
 * - 提交至 POST /api/narrate/boot 并展示编译/标定加载态
 */
export const BootBookModal: React.FC<BootBookModalProps> = ({
    open,
    onClose,
    onBootSuccess,
    onSubmitBoot
}) => {
    const [mode, setMode] = useState<BootBookMode>('original');
    const [slug, setSlug] = useState('');
    const [title, setTitle] = useState('');
    const [povCharacter, setPovCharacter] = useState('char_000');
    const [materialText, setMaterialText] = useState('');
    const [t0Anchor, setT0Anchor] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // 每次重新打开弹窗时清理错误提示
    useEffect(() => {
        if (open) {
            setErrorMessage(null);
        }
    }, [open]);

    if (!open) {
        return null;
    }

    const validateForm = (): string | null => {
        const trimmedSlug = slug.trim();
        const trimmedTitle = title.trim();
        const trimmedPov = povCharacter.trim();
        const trimmedMaterial = materialText.trim();
        const trimmedAnchor = t0Anchor.trim();

        if (!trimmedSlug || !SLUG_RE.test(trimmedSlug)) {
            return 'slug 必填，且仅允许字母、数字、下划线(_)与连字符(-)';
        }
        if (!trimmedTitle) {
            return '请填写书名';
        }
        if (!trimmedPov) {
            return '请填写开局 POV 角色 ID（例如 char_000）';
        }
        if (!trimmedMaterial) {
            return mode === 'original'
                ? '请填写原创开局种子（世界观与核心冲突）'
                : '请粘贴同人设定包或原作切分素材';
        }
        if (mode === 'fanfic' && !trimmedAnchor) {
            return '同人 T0 切分模式下必须填写 T0 锚点，以便剥离后续剧透与已知前提';
        }
        return null;
    };

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (submitting) return;

        const validationError = validateForm();
        if (validationError) {
            setErrorMessage(validationError);
            return;
        }

        const trimmedSlug = slug.trim();
        const trimmedTitle = title.trim();
        const trimmedPov = povCharacter.trim();
        const trimmedMaterial = materialText.trim();
        const trimmedAnchor = t0Anchor.trim();

        const payload: BootBookRequestPayload = {
            mode,
            slug: trimmedSlug,
            title: trimmedTitle,
            povCharacter: trimmedPov,
            ...(mode === 'original'
                ? { premiseOrSeed: trimmedMaterial }
                : { sourceMaterial: trimmedMaterial }),
            ...(trimmedAnchor ? { t0Anchor: trimmedAnchor } : {})
        };

        setSubmitting(true);
        setErrorMessage(null);

        try {
            let resultData: BootBookResponseData;
            if (onSubmitBoot) {
                resultData = await onSubmitBoot(payload);
            } else {
                const resp = await fetch('/api/narrate/boot', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const jsonBody = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
                if (!resp.ok) {
                    const errMsg =
                        typeof jsonBody['error'] === 'string'
                            ? jsonBody['error']
                            : `开书编译失败 (${resp.status})`;
                    throw new Error(errMsg);
                }
                resultData = jsonBody as unknown as BootBookResponseData;
            }

            if (onBootSuccess) {
                onBootSuccess(resultData);
            }
            onClose();
        } catch (err) {
            setErrorMessage(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div
            className="ns-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ns-boot-modal-title"
        >
            <div className="ns-boot-modal">
                <header className="ns-modal-header">
                    <div>
                        <h2 id="ns-boot-modal-title" className="ns-modal-title">
                            开新书 · Step 0 Bootloader 编译引导
                        </h2>
                        <p className="ns-modal-subtitle">
                            初始化独立作品仓库、世界静默前缀与开局角色 POV 补集卡
                        </p>
                    </div>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        disabled={submitting}
                        aria-label="关闭弹窗"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>

                <form className="ns-modal-body" onSubmit={handleSubmit}>
                    {/* 模式选择 */}
                    <div className="ns-field-group">
                        <label className="ns-field-label">开书模式</label>
                        <div className="ns-mode-grid">
                            <button
                                type="button"
                                disabled={submitting}
                                className={`ns-mode-card ${mode === 'original' ? 'ns-active' : ''}`}
                                onClick={() => setMode('original')}
                            >
                                <div className="ns-mode-title">原创冷启动 (original)</div>
                                <div className="ns-mode-desc">
                                    从开局种子生成戏核、静态世界基座与初始实体档案
                                </div>
                            </button>
                            <button
                                type="button"
                                disabled={submitting}
                                className={`ns-mode-card ${mode === 'fanfic' ? 'ns-active' : ''}`}
                                onClick={() => setMode('fanfic')}
                            >
                                <div className="ns-mode-title">同人设定包 T0 切分 (fanfic)</div>
                                <div className="ns-mode-desc">
                                    按 T0 时间锚点切分原作已知与未来事件，防止时间线剧透
                                </div>
                            </button>
                        </div>
                    </div>

                    {/* slug 与书名 */}
                    <div className="ns-form-row">
                        <div className="ns-field-group">
                            <label className="ns-field-label" htmlFor="ns-boot-slug">
                                作品标识 (slug)
                            </label>
                            <input
                                id="ns-boot-slug"
                                type="text"
                                className="ns-input ns-mono"
                                disabled={submitting}
                                value={slug}
                                onChange={(e) => setSlug(e.target.value)}
                                placeholder="例如: causality-soda"
                                required
                            />
                        </div>

                        <div className="ns-field-group">
                            <label className="ns-field-label" htmlFor="ns-boot-title">
                                书名
                            </label>
                            <input
                                id="ns-boot-title"
                                type="text"
                                className="ns-input"
                                disabled={submitting}
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="例如: 《放学后的因果律》"
                                required
                            />
                        </div>
                    </div>

                    {/* 开局 POV 角色 ID 与 T0 锚点 */}
                    <div className="ns-form-row">
                        <div className="ns-field-group">
                            <label className="ns-field-label" htmlFor="ns-boot-pov">
                                开局 POV 角色 ID
                            </label>
                            <input
                                id="ns-boot-pov"
                                type="text"
                                className="ns-input ns-mono"
                                disabled={submitting}
                                value={povCharacter}
                                onChange={(e) => setPovCharacter(e.target.value)}
                                placeholder="例如: char_000"
                                required
                            />
                        </div>

                        <div className="ns-field-group">
                            <label className="ns-field-label" htmlFor="ns-boot-t0">
                                T0 锚点{mode === 'fanfic' ? '（必填）' : '（可选）'}
                            </label>
                            <input
                                id="ns-boot-t0"
                                type="text"
                                className="ns-input"
                                disabled={submitting}
                                value={t0Anchor}
                                onChange={(e) => setT0Anchor(e.target.value)}
                                placeholder={
                                    mode === 'fanfic'
                                        ? '例如: 第一卷开学典礼前夜，主角尚未觉醒'
                                        : '例如: Day 1 黄昏旧校舍'
                                }
                                required={mode === 'fanfic'}
                            />
                        </div>
                    </div>

                    {/* 开局种子 / 同人设定包 */}
                    <div className="ns-field-group">
                        <label className="ns-field-label" htmlFor="ns-boot-material">
                            {mode === 'original' ? '开局种子 (premiseOrSeed)' : '同人设定包 (sourceMaterial)'}
                        </label>
                        <textarea
                            id="ns-boot-material"
                            className="ns-textarea"
                            disabled={submitting}
                            rows={6}
                            value={materialText}
                            onChange={(e) => setMaterialText(e.target.value)}
                            placeholder={
                                mode === 'original'
                                    ? '描述核心设定、主角处境、开局冲突与文风基调…'
                                    : '粘贴原作人物关系、世界观设定与 T0 前后事件清单…'
                            }
                            required
                        />
                    </div>

                    {/* 编译/标定加载态提示 */}
                    {submitting ? (
                        <div className="ns-boot-loading" role="status" aria-live="polite">
                            <span className="ns-pulse-dot" />
                            <span>
                                正在执行 Step 0 编译与角色标定（创建 books/{slug.trim() || '...'} 并生成世界基座），请稍候…
                            </span>
                        </div>
                    ) : null}

                    {/* 错误提示 */}
                    {errorMessage ? (
                        <div className="ns-boot-error" role="alert">
                            {errorMessage}
                        </div>
                    ) : null}

                    <footer className="ns-modal-footer">
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
                            {submitting ? '编译与标定中…' : '创建并编译新书'}
                        </button>
                    </footer>
                </form>
            </div>
        </div>
    );
};

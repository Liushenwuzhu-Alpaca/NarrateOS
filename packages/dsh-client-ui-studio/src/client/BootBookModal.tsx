import React, { useEffect, useState } from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';

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

type BootWizardStep = 1 | 2 | 3 | 4;

interface StepDescriptor {
    step: BootWizardStep;
    shortLabel: string;
    title: string;
    hint: string;
}

const BOOT_STEPS: readonly StepDescriptor[] = [
    {
        step: 1,
        shortLabel: '1 设定输入',
        title: '路径选择与核心设定输入',
        hint: '选定原创冷启动或同人 T0 切分路径，填写作品标识与初始素材'
    },
    {
        step: 2,
        shortLabel: '2 角色与红线',
        title: '开局视角角色与时间锚点红线',
        hint: '绑定开局第一视角角色与 T0 锚点，隔离未发生剧透与底牌'
    },
    {
        step: 3,
        shortLabel: '3 核对设置',
        title: '核对开书设置',
        hint: '本步仅核对已填设置；试播标定与编译在提交后才执行'
    },
    {
        step: 4,
        shortLabel: '4 启动创作',
        title: '提交开书请求并初始化作品仓库',
        hint: '提交后引擎试播标定分词率并编译，生成 books/<slug>/ 独立 Git 仓库与首卷骨架'
    }
];

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * NarrateOS 开新书模态弹窗组件（Step 0 Bootloader 4 步引导）：
 * - 顶部 4 步引导条：1 设定输入 - 2 角色与红线 - 3 核对设置 - 4 启动创作
 * - 支持清晰切换「路径 A：原创冷启动」与「路径 B：同人设定包 T0 切分」
 * - 填写 slug、书名、开局视角角色、开局种子/同人设定包、T0 锚点；第 3 步仅核对设置，不调用后端
 * - 第 4 步提交至 onSubmitBoot 或 POST /api/narrate/boot，引擎随后试播标定分词率并编译；
 *   成功后回调宿主并关闭弹窗，工作区提示完成并刷新，弹窗内不设结果页
 */
export const BootBookModal: React.FC<BootBookModalProps> = ({
    open,
    onClose,
    onBootSuccess,
    onSubmitBoot
}) => {
    const [activeStep, setActiveStep] = useState<BootWizardStep>(1);
    const [mode, setMode] = useState<BootBookMode>('original');
    const [slug, setSlug] = useState('');
    const [title, setTitle] = useState('');
    const [povCharacter, setPovCharacter] = useState('char_000');
    const [materialText, setMaterialText] = useState('');
    const [t0Anchor, setT0Anchor] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // 关闭或重新打开时都重置到第 1 步并清理错误提示：
    // 关闭时即复位，保证下一次打开的首帧就是第 1 步，宿主的 data-modal-autofocus 才能命中 slug 输入框
    useEffect(() => {
        setActiveStep(1);
        setErrorMessage(null);
    }, [open]);

    if (!open) {
        return null;
    }

    const validateStepOne = (): string | null => {
        const trimmedSlug = slug.trim();
        const trimmedTitle = title.trim();
        const trimmedMaterial = materialText.trim();

        if (!trimmedSlug || !SLUG_RE.test(trimmedSlug)) {
            return '请填写作品标识，仅允许字母、数字、下划线(_)与连字符(-)';
        }
        if (!trimmedTitle) {
            return '请填写书名';
        }
        if (!trimmedMaterial) {
            return mode === 'original'
                ? '请填写开局种子（世界观与核心冲突）'
                : '请粘贴同人设定包或原作切分素材';
        }
        return null;
    };

    const validateStepTwo = (): string | null => {
        const trimmedPov = povCharacter.trim();
        const trimmedAnchor = t0Anchor.trim();

        if (!trimmedPov) {
            return '请填写开局视角角色（例如 char_000）';
        }
        if (mode === 'fanfic' && !trimmedAnchor) {
            return '同人 T0 切分模式下必须填写 T0 锚点，以便剥离后续剧透与已知前提';
        }
        return null;
    };

    const validateForm = (): { message: string; targetStep: BootWizardStep } | null => {
        const step1Err = validateStepOne();
        if (step1Err) {
            return { message: step1Err, targetStep: 1 };
        }
        const step2Err = validateStepTwo();
        if (step2Err) {
            return { message: step2Err, targetStep: 2 };
        }
        return null;
    };

    const handleNextStep = () => {
        if (submitting) return;
        if (activeStep === 1) {
            const err = validateStepOne();
            if (err) {
                setErrorMessage(err);
                return;
            }
        } else if (activeStep === 2) {
            const err = validateStepTwo();
            if (err) {
                setErrorMessage(err);
                return;
            }
        }
        setErrorMessage(null);
        if (activeStep < 4) {
            setActiveStep((prev) => (prev + 1) as BootWizardStep);
        }
    };

    const handlePrevStep = () => {
        if (submitting) return;
        setErrorMessage(null);
        if (activeStep > 1) {
            setActiveStep((prev) => (prev - 1) as BootWizardStep);
        }
    };

    const handleSelectStep = (target: BootWizardStep) => {
        if (submitting) return;
        setErrorMessage(null);
        setActiveStep(target);
    };

    // 遮罩点击关闭、键盘关闭与初始聚焦均由宿主 Modal 原语接管，此处不再自绘

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (submitting) return;

        const validationError = validateForm();
        if (validationError) {
            setActiveStep(validationError.targetStep);
            setErrorMessage(validationError.message);
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

    const currentStepMeta: StepDescriptor = BOOT_STEPS.find((item) => item.step === activeStep) ?? {
        step: 1,
        shortLabel: '1 设定输入',
        title: '路径选择与核心设定输入',
        hint: '选定原创冷启动或同人 T0 切分路径，填写作品标识与初始素材'
    };
    const trimmedSlugDisplay = slug.trim() || '<slug>';
    const trimmedPovDisplay = povCharacter.trim() || 'char_000';
    const trimmedTitleDisplay = title.trim() || '未命名作品';
    const trimmedAnchorDisplay = t0Anchor.trim();
    const materialLength = materialText.trim().length;
    const isStep1Ready = validateStepOne() === null;
    const isStep2Ready = validateStepTwo() === null;

    return (
        <Modal
            open={open}
            onClose={submitting ? () => undefined : onClose}
            title="开新书编译引导"
            headless
            className="ns-b-modal-shell"
            contentClassName="ns-b-modal-content"
        >
            {/* 弹窗头部（向导自有头部，宿主 headless 模式不渲染默认 chrome） */}
            <header className="ns-modal-head">
                <div className="ns-b-head-stack">
                    <div className="ns-b-head-row">
                        <span className="ns-b-step0-badge">Step 0 - Bootloader</span>
                        <h2 className="ns-b-title">开新书编译引导</h2>
                    </div>
                    <p className="ns-b-head-hint">
                        {currentStepMeta.title} - {currentStepMeta.hint}
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

            {/* 顶部 4 步引导条 */}
            <nav aria-label="开书 4 步引导" className="ns-b-steps">
                    {BOOT_STEPS.map((item, idx) => {
                        const isActive = activeStep === item.step;
                        const isCompleted =
                            (item.step === 1 && isStep1Ready && activeStep > 1) ||
                            (item.step === 2 && isStep2Ready && activeStep > 2) ||
                            (item.step === 3 && activeStep > 3);

                        return (
                            <React.Fragment key={item.step}>
                                <button
                                    type="button"
                                    className={
                                        isActive
                                            ? 'ns-b-step-btn ns-b-step-btn--active'
                                            : isCompleted
                                              ? 'ns-b-step-btn ns-b-step-btn--done'
                                              : 'ns-b-step-btn'
                                    }
                                    disabled={submitting}
                                    onClick={() => handleSelectStep(item.step)}
                                    aria-current={isActive ? 'step' : undefined}
                                >
                                    <span>{isCompleted ? `✓ ${item.shortLabel}` : item.shortLabel}</span>
                                </button>
                                {idx < BOOT_STEPS.length - 1 ? (
                                    <span aria-hidden="true" className="ns-b-step-sep">
                                        -
                                    </span>
                                ) : null}
                            </React.Fragment>
                        );
                    })}
                </nav>

                <form onSubmit={handleSubmit}>
                    <div className="ns-modal-body ns-b-body">
                        {/* 步骤 1：设定输入与路径切换 */}
                        {activeStep === 1 ? (
                            <>
                                <div className="ns-field">
                                    <span className="ns-b-label">
                                        选择开书路径（双路径最终编译出同构目录结构）
                                    </span>
                                    <div className="ns-b-mode-grid">
                                        <button
                                            type="button"
                                            className={
                                                mode === 'original'
                                                    ? 'ns-b-mode-card ns-b-mode-card--active'
                                                    : 'ns-b-mode-card'
                                            }
                                            disabled={submitting}
                                            onClick={() => {
                                                setMode('original');
                                                setErrorMessage(null);
                                            }}
                                        >
                                            <div className="ns-b-mode-head">
                                                <span className="ns-b-mode-name">
                                                    路径 A：原创冷启动
                                                </span>
                                                <span className="ns-b-mode-code">original</span>
                                            </div>
                                            <span className="ns-b-mode-desc">
                                                从一句话种子出发，生成戏核、静态世界基座与首卷倒推拐点
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            className={
                                                mode === 'fanfic'
                                                    ? 'ns-b-mode-card ns-b-mode-card--active'
                                                    : 'ns-b-mode-card'
                                            }
                                            disabled={submitting}
                                            onClick={() => {
                                                setMode('fanfic');
                                                setErrorMessage(null);
                                            }}
                                        >
                                            <div className="ns-b-mode-head">
                                                <span className="ns-b-mode-name">
                                                    路径 B：同人设定包 T0 切分
                                                </span>
                                                <span className="ns-b-mode-code">fanfic</span>
                                            </div>
                                            <span className="ns-b-mode-desc">
                                                用 T0 时间刀切分原作词条，剥离未发生剧情与人物底牌，避免开局剧透
                                            </span>
                                        </button>
                                    </div>
                                </div>

                                {/* slug 与书名 */}
                                <div className="ns-b-form-grid">
                                    <label className="ns-field" htmlFor="ns-boot-slug">
                                        <span>作品标识</span>
                                        <input
                                            id="ns-boot-slug"
                                            type="text"
                                            className="ns-input ns-b-mono-input"
                                            data-modal-autofocus="true"
                                            disabled={submitting}
                                            value={slug}
                                            onChange={(e) => setSlug(e.target.value)}
                                            placeholder="例如: causality-soda"
                                            required
                                        />
                                        <small className="ns-muted">字段名 slug：仅限字母、数字、下划线(_)与连字符(-)，用作 books/ 下的目录名</small>
                                    </label>

                                    <label className="ns-field" htmlFor="ns-boot-title">
                                        <span>书名</span>
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
                                    </label>
                                </div>

                                {/* 开局种子 / 同人设定包 */}
                                <label className="ns-field" htmlFor="ns-boot-material">
                                    <span>{mode === 'original' ? '开局种子' : '同人设定包'}</span>
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
                                    <small className="ns-muted">字段名 {mode === 'original' ? 'premiseOrSeed' : 'sourceMaterial'}</small>
                                </label>
                            </>
                        ) : null}

                        {/* 步骤 2：角色与红线 */}
                        {activeStep === 2 ? (
                            <>
                                <div className="ns-b-form-grid">
                                    <label className="ns-field" htmlFor="ns-boot-pov">
                                        <span>开局视角角色</span>
                                        <input
                                            id="ns-boot-pov"
                                            type="text"
                                            className="ns-input ns-b-mono-input"
                                            disabled={submitting}
                                            value={povCharacter}
                                            onChange={(e) => setPovCharacter(e.target.value)}
                                            placeholder="例如: char_000"
                                            required
                                        />
                                        <small className="ns-muted">字段名 povCharacter：填实体 ID，开局章节以该角色为第一视角</small>
                                    </label>

                                    <label className="ns-field" htmlFor="ns-boot-t0">
                                        <span>T0 时间锚点{mode === 'fanfic' ? '（必填）' : '（可选）'}</span>
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
                                        <small className="ns-muted">字段名 t0Anchor：标记故事开局的时间位置，用于隔离开局之后的剧情</small>
                                    </label>
                                </div>

                                {/* 视角隔离与时间刀红线卡片 */}
                                <div className="ns-b-redline-card">
                                    <div className="ns-b-section-title">
                                        {mode === 'fanfic'
                                            ? 'T0 时间刀切分红线'
                                            : '四段式补集档案与视角剥离红线'}
                                    </div>
                                    <div className="ns-b-redline-grid">
                                        <div className="ns-b-mini-card">
                                            <div className="ns-b-mini-title ns-b-accent-brand">
                                                写手可见区（T0 前显性事实）
                                            </div>
                                            <div>
                                                仅投喂 <code>{trimmedPovDisplay}</code> 的显性特征、静态世界法则与当前已解锁认知，不注入未发生情节。
                                            </div>
                                        </div>
                                        <div className="ns-b-mini-card">
                                            <div className="ns-b-mini-title ns-b-accent-seal">
                                                物理剥离区（!视角隔离底牌）
                                            </div>
                                            <div>
                                                {mode === 'fanfic'
                                                    ? 'T0 之后的原作未来事件将剥离至 future_horizon.md，并附带 Premise 成立前提。'
                                                    : '隐藏动机与终局底牌仅对导演与核查可见，开局阶段对写手物理隔离。'}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : null}

                        {/* 步骤 3：核对开书设置（仅前端核对，不调用后端） */}
                        {activeStep === 3 ? (
                            <>
                                <div className="ns-b-calib-card">
                                    <div className="ns-b-calib-title">提交后执行的 Step 0 编译流程</div>
                                    <div className="ns-b-check-row">
                                        本步仅核对设置，不调用后端；以下环节在点击「创建并编译新书」后才开始，不代表已试播或已标定。
                                    </div>
                                    <div className="ns-b-calib-grid">
                                        <div className="ns-b-mini-card">
                                            <div className="ns-b-mini-title ns-b-accent-brand">
                                                1. 分词率标定
                                            </div>
                                            <div className="ns-b-mini-text">
                                                用样本文本实测模型 token 用量，标定 tokens_per_char 系数，供后续字数预算使用。
                                            </div>
                                        </div>
                                        <div className="ns-b-mini-card">
                                            <div className="ns-b-mini-title ns-b-accent-amber">
                                                2. 声纹与词条编译
                                            </div>
                                            <div className="ns-b-mini-text">
                                                编译生成声纹样本并固化至静态基座；低频背景词条分离到 lore_library/，保持缓存前缀稳定。
                                            </div>
                                        </div>
                                        <div className="ns-b-mini-card">
                                            <div className="ns-b-mini-title ns-b-accent-green">
                                                3. 终局倒推骨架
                                            </div>
                                            <div className="ns-b-mini-text">
                                                编译生成 future_horizon.md 阶段锁，细纲仅延迟展开首卷前段。
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* 当前配置核对表 */}
                                <div className="ns-b-check-card">
                                    <div className="ns-b-check-title">开书设置核对</div>
                                    <div className="ns-b-check-row">
                                        路径：{mode === 'original' ? '路径 A - 原创冷启动 (original)' : '路径 B - 同人设定包 T0 切分 (fanfic)'}
                                    </div>
                                    <div className="ns-b-check-row">
                                        作品：<code>{trimmedSlugDisplay}</code> / {trimmedTitleDisplay}
                                    </div>
                                    <div className="ns-b-check-row">
                                        视角角色：<code>{trimmedPovDisplay}</code>
                                        {trimmedAnchorDisplay ? ` | T0 锚点：${trimmedAnchorDisplay}` : ' | T0 锚点：未指定'}
                                    </div>
                                    <div className="ns-b-check-row">
                                        输入素材长度：{materialLength} 字符
                                    </div>
                                </div>
                            </>
                        ) : null}

                        {/* 步骤 4：启动创作 */}
                        {activeStep === 4 ? (
                            <>
                                <div className="ns-b-launch-card">
                                    <div className="ns-b-launch-title">
                                        即将初始化独立作品仓库：books/{trimmedSlugDisplay}/
                                    </div>
                                    <div className="ns-b-tree">
                                        <div>- world/static_base_and_voice.md  (静态世界基座与声纹样本)</div>
                                        <div>- world/future_horizon.md         (卷末终局倒推与阶段锁)</div>
                                        <div>- entities/{trimmedPovDisplay}.md   (开局视角角色补集档案)</div>
                                        <div>- lore_library/                     (按需检索词条库)</div>
                                    </div>
                                </div>

                                <div className="ns-b-hint-card">
                                    点击「创建并编译新书」后才会提交开书请求：引擎先标定分词率，再执行 Step 0 编译并初始化 Git 仓库。完成后弹窗自动关闭，工作区提示编译完成并刷新。
                                </div>
                            </>
                        ) : null}

                        {/* 标定/编译加载态提示 */}
                        {submitting ? (
                            <div
                                role="status"
                                aria-live="polite"
                                className="ns-b-loading-bar"
                            >
                                <span className="ns-pulse-dot" />
                                <span>
                                    正在标定分词率并编译新书（创建 books/{slug.trim() || '...'} 并生成世界基座），请稍候…
                                </span>
                            </div>
                        ) : null}

                        {/* 错误提示 */}
                        {errorMessage ? (
                            <div role="alert" className="ns-b-error-bar">
                                {errorMessage}
                            </div>
                        ) : null}
                    </div>

                    <footer className="ns-modal-foot ns-b-foot">
                        <div className="ns-b-foot-counter">步骤 {activeStep} / 4</div>
                        <div className="ns-b-foot-actions">
                            <button
                                type="button"
                                className="ns-btn ns-btn-ghost"
                                disabled={submitting}
                                onClick={onClose}
                            >
                                取消
                            </button>
                            {activeStep > 1 ? (
                                <button
                                    type="button"
                                    className="ns-btn ns-btn-ghost"
                                    disabled={submitting}
                                    onClick={handlePrevStep}
                                >
                                    上一步
                                </button>
                            ) : null}
                            {activeStep < 4 ? (
                                <button
                                    type="button"
                                    className="ns-btn ns-btn-primary"
                                    disabled={submitting}
                                    onClick={handleNextStep}
                                >
                                    下一步
                                </button>
                            ) : (
                                <button
                                    type="submit"
                                    className="ns-btn ns-btn-primary"
                                    disabled={submitting}
                                >
                                    {submitting ? '标定与编译中…' : '创建并编译新书'}
                                </button>
                            )}
                        </div>
                    </footer>
                </form>
        </Modal>
    );
};

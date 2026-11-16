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
        title: '开局 POV 角色与时间锚点红线',
        hint: '绑定开局第一视角实体与 T0 锚点，隔离未发生剧透与底牌'
    },
    {
        step: 3,
        shortLabel: '3 试播标定',
        title: '声纹标定与编译产物预检',
        hint: '确认 Step 0 编译流向与静态世界基座生成策略'
    },
    {
        step: 4,
        shortLabel: '4 启动创作',
        title: '初始化独立书库并编译开机',
        hint: '生成 books/<slug>/ 独立 Git 仓库与首卷骨架'
    }
];

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * NarrateOS 开新书模态弹窗组件（Step 0 Bootloader 4 步引导）：
 * - 顶部 4 步引导条：1 设定输入 - 2 角色与红线 - 3 试播标定 - 4 启动创作
 * - 支持清晰切换「路径 A：原创冷启动」与「路径 B：同人设定包 T0 切分」
 * - 填写 slug、书名、开局 POV 角色 ID、开局种子/同人设定包、T0 锚点
 * - 提交至 onSubmitBoot 或 POST /api/narrate/boot，并展示编译/标定加载态
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

    // 每次重新打开弹窗时重置引导步骤到第 1 步并清理错误提示
    useEffect(() => {
        if (open) {
            setActiveStep(1);
            setErrorMessage(null);
        }
    }, [open]);

    if (!open) {
        return null;
    }

    const validateStepOne = (): string | null => {
        const trimmedSlug = slug.trim();
        const trimmedTitle = title.trim();
        const trimmedMaterial = materialText.trim();

        if (!trimmedSlug || !SLUG_RE.test(trimmedSlug)) {
            return 'slug 必填，且仅允许字母、数字、下划线(_)与连字符(-)';
        }
        if (!trimmedTitle) {
            return '请填写书名';
        }
        if (!trimmedMaterial) {
            return mode === 'original'
                ? '请填写原创开局种子（世界观与核心冲突）'
                : '请粘贴同人设定包或原作切分素材';
        }
        return null;
    };

    const validateStepTwo = (): string | null => {
        const trimmedPov = povCharacter.trim();
        const trimmedAnchor = t0Anchor.trim();

        if (!trimmedPov) {
            return '请填写开局 POV 角色 ID（例如 char_000）';
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
        <div
            className="ns-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ns-boot-modal-title"
        >
            <div
                className="ns-modal"
                style={{
                    maxWidth: 740,
                    width: '100%'
                }}
            >
                {/* 弹窗头部 */}
                <header className="ns-modal-head">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span
                                style={{
                                    fontFamily: 'var(--ns-font-mono)',
                                    fontSize: 10.5,
                                    letterSpacing: '0.06em',
                                    textTransform: 'uppercase',
                                    color: 'var(--ns-brand-ink)',
                                    background: 'var(--ns-brand-soft)',
                                    border: '1px solid var(--ns-brand-line)',
                                    borderRadius: 999,
                                    padding: '2px 8px'
                                }}
                            >
                                Step 0 - Bootloader
                            </span>
                            <h2
                                id="ns-boot-modal-title"
                                style={{
                                    margin: 0,
                                    fontSize: 14.5,
                                    fontWeight: 600,
                                    color: 'var(--ns-text-1)'
                                }}
                            >
                                开新书编译引导
                            </h2>
                        </div>
                        <p
                            style={{
                                margin: 0,
                                fontSize: 11.5,
                                color: 'var(--ns-text-3)'
                            }}
                        >
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
                <nav
                    aria-label="开书 4 步引导"
                    style={{
                        padding: '10px 18px',
                        borderBottom: '1px solid var(--ns-border-1)',
                        background: 'var(--ns-bg-card)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap'
                    }}
                >
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
                                    disabled={submitting}
                                    onClick={() => handleSelectStep(item.step)}
                                    aria-current={isActive ? 'step' : undefined}
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '5px 10px',
                                        borderRadius: 'var(--ns-r-sm)',
                                        border: isActive
                                            ? '1px solid var(--ns-brand-line)'
                                            : '1px solid transparent',
                                        background: isActive
                                            ? 'var(--ns-brand-soft)'
                                            : isCompleted
                                              ? 'var(--ns-green-soft)'
                                              : 'transparent',
                                        color: isActive
                                            ? 'var(--ns-brand-ink)'
                                            : isCompleted
                                              ? 'var(--ns-green-ink)'
                                              : 'var(--ns-text-3)',
                                        fontSize: 12,
                                        fontWeight: isActive ? 600 : 500,
                                        cursor: submitting ? 'not-allowed' : 'pointer',
                                        transition: 'all 0.15s ease'
                                    }}
                                >
                                    <span>{isCompleted ? `✓ ${item.shortLabel}` : item.shortLabel}</span>
                                </button>
                                {idx < BOOT_STEPS.length - 1 ? (
                                    <span
                                        aria-hidden="true"
                                        style={{
                                            color: 'var(--ns-text-4)',
                                            fontSize: 11,
                                            userSelect: 'none'
                                        }}
                                    >
                                        -
                                    </span>
                                ) : null}
                            </React.Fragment>
                        );
                    })}
                </nav>

                <form onSubmit={handleSubmit}>
                    <div className="ns-modal-body" style={{ gap: 14 }}>
                        {/* 步骤 1：设定输入与路径切换 */}
                        {activeStep === 1 ? (
                            <>
                                <div className="ns-field">
                                    <span style={{ fontWeight: 600, color: 'var(--ns-text-2)' }}>
                                        选择开书路径（双路径最终编译出同构目录结构）
                                    </span>
                                    <div
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                                            gap: 10
                                        }}
                                    >
                                        <button
                                            type="button"
                                            disabled={submitting}
                                            onClick={() => {
                                                setMode('original');
                                                setErrorMessage(null);
                                            }}
                                            style={{
                                                textAlign: 'left',
                                                padding: '12px 13px',
                                                borderRadius: 'var(--ns-r-md)',
                                                border:
                                                    mode === 'original'
                                                        ? '1px solid var(--ns-brand-line)'
                                                        : '1px solid var(--ns-border-2)',
                                                background:
                                                    mode === 'original'
                                                        ? 'var(--ns-brand-soft)'
                                                        : 'var(--ns-bg-card)',
                                                cursor: submitting ? 'not-allowed' : 'pointer',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: 5
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    gap: 8
                                                }}
                                            >
                                                <span
                                                    style={{
                                                        fontWeight: 600,
                                                        fontSize: 12.5,
                                                        color:
                                                            mode === 'original'
                                                                ? 'var(--ns-brand-ink)'
                                                                : 'var(--ns-text-1)'
                                                    }}
                                                >
                                                    路径 A：原创冷启动
                                                </span>
                                                <span
                                                    style={{
                                                        fontFamily: 'var(--ns-font-mono)',
                                                        fontSize: 10.5,
                                                        color: 'var(--ns-text-3)'
                                                    }}
                                                >
                                                    original
                                                </span>
                                            </div>
                                            <span style={{ fontSize: 11.5, color: 'var(--ns-text-3)', lineHeight: 1.45 }}>
                                                从一句话种子自爆题材俗套，生成戏核、静态世界基座与首卷倒推拐点
                                            </span>
                                        </button>

                                        <button
                                            type="button"
                                            disabled={submitting}
                                            onClick={() => {
                                                setMode('fanfic');
                                                setErrorMessage(null);
                                            }}
                                            style={{
                                                textAlign: 'left',
                                                padding: '12px 13px',
                                                borderRadius: 'var(--ns-r-md)',
                                                border:
                                                    mode === 'fanfic'
                                                        ? '1px solid var(--ns-brand-line)'
                                                        : '1px solid var(--ns-border-2)',
                                                background:
                                                    mode === 'fanfic'
                                                        ? 'var(--ns-brand-soft)'
                                                        : 'var(--ns-bg-card)',
                                                cursor: submitting ? 'not-allowed' : 'pointer',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: 5
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    gap: 8
                                                }}
                                            >
                                                <span
                                                    style={{
                                                        fontWeight: 600,
                                                        fontSize: 12.5,
                                                        color:
                                                            mode === 'fanfic'
                                                                ? 'var(--ns-brand-ink)'
                                                                : 'var(--ns-text-1)'
                                                    }}
                                                >
                                                    路径 B：同人设定包 T0 切分
                                                </span>
                                                <span
                                                    style={{
                                                        fontFamily: 'var(--ns-font-mono)',
                                                        fontSize: 10.5,
                                                        color: 'var(--ns-text-3)'
                                                    }}
                                                >
                                                    fanfic
                                                </span>
                                            </div>
                                            <span style={{ fontSize: 11.5, color: 'var(--ns-text-3)', lineHeight: 1.45 }}>
                                                用 T0 时间刀外科切分原作词条，剥离未发生剧情与人物底牌，消除早期剧透
                                            </span>
                                        </button>
                                    </div>
                                </div>

                                {/* slug 与书名 */}
                                <div
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                                        gap: 12
                                    }}
                                >
                                    <label className="ns-field" htmlFor="ns-boot-slug">
                                        <span>作品标识 (slug)</span>
                                        <input
                                            id="ns-boot-slug"
                                            type="text"
                                            className="ns-input"
                                            style={{ fontFamily: 'var(--ns-font-mono)' }}
                                            disabled={submitting}
                                            value={slug}
                                            onChange={(e) => setSlug(e.target.value)}
                                            placeholder="例如: causality-soda"
                                            required
                                        />
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
                                    <span>
                                        {mode === 'original'
                                            ? '开局种子 (premiseOrSeed)'
                                            : '同人设定包 (sourceMaterial)'}
                                    </span>
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
                                </label>
                            </>
                        ) : null}

                        {/* 步骤 2：角色与红线 */}
                        {activeStep === 2 ? (
                            <>
                                <div
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                                        gap: 12
                                    }}
                                >
                                    <label className="ns-field" htmlFor="ns-boot-pov">
                                        <span>开局 POV 角色 ID</span>
                                        <input
                                            id="ns-boot-pov"
                                            type="text"
                                            className="ns-input"
                                            style={{ fontFamily: 'var(--ns-font-mono)' }}
                                            disabled={submitting}
                                            value={povCharacter}
                                            onChange={(e) => setPovCharacter(e.target.value)}
                                            placeholder="例如: char_000"
                                            required
                                        />
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
                                    </label>
                                </div>

                                {/* 视角隔离与时间刀红线卡片 */}
                                <div
                                    style={{
                                        padding: '12px 14px',
                                        borderRadius: 'var(--ns-r-md)',
                                        border: '1px solid var(--ns-border-2)',
                                        background: 'var(--ns-bg-card)',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 8
                                    }}
                                >
                                    <div
                                        style={{
                                            fontSize: 12,
                                            fontWeight: 600,
                                            color: 'var(--ns-text-1)'
                                        }}
                                    >
                                        {mode === 'fanfic'
                                            ? 'T0 时间刀外科切分红线'
                                            : '四段式补集档案与 POV 剥离红线'}
                                    </div>
                                    <div
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                                            gap: 8,
                                            fontSize: 11.5,
                                            color: 'var(--ns-text-2)'
                                        }}
                                    >
                                        <div
                                            style={{
                                                padding: '8px 10px',
                                                borderRadius: 'var(--ns-r-sm)',
                                                background: 'var(--ns-bg-base)',
                                                border: '1px solid var(--ns-border-1)'
                                            }}
                                        >
                                            <div style={{ color: 'var(--ns-brand-ink)', fontWeight: 600, marginBottom: 3 }}>
                                                写手可见区（T0 前显性事实）
                                            </div>
                                            <div>
                                                仅投喂 <code>{trimmedPovDisplay}</code> 的显性特征、静态世界法则与当前已解锁认知，不注入未发生情节。
                                            </div>
                                        </div>
                                        <div
                                            style={{
                                                padding: '8px 10px',
                                                borderRadius: 'var(--ns-r-sm)',
                                                background: 'var(--ns-bg-base)',
                                                border: '1px solid var(--ns-border-1)'
                                            }}
                                        >
                                            <div style={{ color: 'var(--ns-seal)', fontWeight: 600, marginBottom: 3 }}>
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

                        {/* 步骤 3：试播标定 */}
                        {activeStep === 3 ? (
                            <>
                                <div
                                    style={{
                                        padding: '12px 14px',
                                        borderRadius: 'var(--ns-r-md)',
                                        border: '1px solid var(--ns-border-2)',
                                        background: 'var(--ns-bg-card)',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 10
                                    }}
                                >
                                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ns-text-1)' }}>
                                        Step 0 试播标定与编译管线
                                    </div>
                                    <div
                                        style={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                                            gap: 8,
                                            fontSize: 11.5
                                        }}
                                    >
                                        <div
                                            style={{
                                                padding: '8px 10px',
                                                borderRadius: 'var(--ns-r-sm)',
                                                background: 'var(--ns-bg-base)',
                                                border: '1px solid var(--ns-border-1)'
                                            }}
                                        >
                                            <div style={{ color: 'var(--ns-brand-ink)', fontWeight: 600, marginBottom: 3 }}>
                                                1. 黄金声纹锚定
                                            </div>
                                            <div style={{ color: 'var(--ns-text-3)' }}>
                                                提取句法节奏、冷暖意象与对白密度，固化至静态底座前缀。
                                            </div>
                                        </div>
                                        <div
                                            style={{
                                                padding: '8px 10px',
                                                borderRadius: 'var(--ns-r-sm)',
                                                background: 'var(--ns-bg-base)',
                                                border: '1px solid var(--ns-border-1)'
                                            }}
                                        >
                                            <div style={{ color: 'var(--ns-amber-ink)', fontWeight: 600, marginBottom: 3 }}>
                                                2. 按需词条分离
                                            </div>
                                            <div style={{ color: 'var(--ns-text-3)' }}>
                                                非高频背景移入 lore_library/，避免污染 1 小时静默缓存前缀。
                                            </div>
                                        </div>
                                        <div
                                            style={{
                                                padding: '8px 10px',
                                                borderRadius: 'var(--ns-r-sm)',
                                                background: 'var(--ns-bg-base)',
                                                border: '1px solid var(--ns-border-1)'
                                            }}
                                        >
                                            <div style={{ color: 'var(--ns-green-ink)', fontWeight: 600, marginBottom: 3 }}>
                                                3. 终局倒推骨架
                                            </div>
                                            <div style={{ color: 'var(--ns-text-3)' }}>
                                                建立 future_horizon.md 阶段锁，细纲仅延迟展开首卷前段。
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* 当前配置核对表 */}
                                <div
                                    style={{
                                        padding: '10px 14px',
                                        borderRadius: 'var(--ns-r-md)',
                                        border: '1px solid var(--ns-border-1)',
                                        background: 'var(--ns-bg-base)',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 6,
                                        fontSize: 12
                                    }}
                                >
                                    <div style={{ fontWeight: 600, color: 'var(--ns-text-2)' }}>
                                        标定输入核对
                                    </div>
                                    <div style={{ color: 'var(--ns-text-3)' }}>
                                        路径：{mode === 'original' ? '路径 A - 原创冷启动 (original)' : '路径 B - 同人设定包 T0 切分 (fanfic)'}
                                    </div>
                                    <div style={{ color: 'var(--ns-text-3)' }}>
                                        作品：<code>{trimmedSlugDisplay}</code> / {trimmedTitleDisplay}
                                    </div>
                                    <div style={{ color: 'var(--ns-text-3)' }}>
                                        开局 POV：<code>{trimmedPovDisplay}</code>
                                        {trimmedAnchorDisplay ? ` | T0 锚点：${trimmedAnchorDisplay}` : ' | T0 锚点：未指定'}
                                    </div>
                                    <div style={{ color: 'var(--ns-text-3)' }}>
                                        输入素材长度：{materialLength} 字符
                                    </div>
                                </div>
                            </>
                        ) : null}

                        {/* 步骤 4：启动创作 */}
                        {activeStep === 4 ? (
                            <>
                                <div
                                    style={{
                                        padding: '12px 14px',
                                        borderRadius: 'var(--ns-r-md)',
                                        border: '1px solid var(--ns-brand-line)',
                                        background: 'var(--ns-brand-soft)',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 8
                                    }}
                                >
                                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ns-brand-ink)' }}>
                                        即将初始化独立作品仓库：books/{trimmedSlugDisplay}/
                                    </div>
                                    <div
                                        style={{
                                            fontFamily: 'var(--ns-font-mono)',
                                            fontSize: 11.5,
                                            color: 'var(--ns-text-2)',
                                            lineHeight: 1.7
                                        }}
                                    >
                                        <div>- world/static_base_and_voice.md  (静态世界基座与黄金声纹)</div>
                                        <div>- world/future_horizon.md         (卷末终局倒推与阶段锁)</div>
                                        <div>- entities/{trimmedPovDisplay}.md   (开局 POV 补集档案)</div>
                                        <div>- lore_library/                     (按需检索词条库)</div>
                                    </div>
                                </div>

                                <div
                                    style={{
                                        padding: '10px 12px',
                                        borderRadius: 'var(--ns-r-md)',
                                        border: '1px solid var(--ns-border-1)',
                                        background: 'var(--ns-bg-card)',
                                        fontSize: 12,
                                        color: 'var(--ns-text-3)'
                                    }}
                                >
                                    点击「创建并编译新书」后，引擎将执行 Step 0 编译与首章前置标定，完成后自动切换至新书工作台。
                                </div>
                            </>
                        ) : null}

                        {/* 编译/标定加载态提示 */}
                        {submitting ? (
                            <div
                                role="status"
                                aria-live="polite"
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    padding: '10px 12px',
                                    borderRadius: 'var(--ns-r-md)',
                                    border: '1px solid var(--ns-brand-line)',
                                    background: 'var(--ns-brand-soft)',
                                    color: 'var(--ns-brand-ink)',
                                    fontSize: 12
                                }}
                            >
                                <span className="ns-pulse-dot" />
                                <span>
                                    正在执行 Step 0 编译与角色标定（创建 books/{slug.trim() || '...'} 并生成世界基座），请稍候…
                                </span>
                            </div>
                        ) : null}

                        {/* 错误提示 */}
                        {errorMessage ? (
                            <div
                                role="alert"
                                style={{
                                    padding: '10px 12px',
                                    borderRadius: 'var(--ns-r-md)',
                                    border: '1px solid var(--ns-red-line)',
                                    background: 'var(--ns-red-soft)',
                                    color: 'var(--ns-red-ink)',
                                    fontSize: 12
                                }}
                            >
                                {errorMessage}
                            </div>
                        ) : null}
                    </div>

                    <footer
                        className="ns-modal-foot"
                        style={{ justifyContent: 'space-between', alignItems: 'center' }}
                    >
                        <div style={{ fontSize: 11.5, color: 'var(--ns-text-3)' }}>
                            步骤 {activeStep} / 4
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                                    {submitting ? '编译与标定中…' : '创建并编译新书'}
                                </button>
                            )}
                        </div>
                    </footer>
                </form>
            </div>
        </div>
    );
};

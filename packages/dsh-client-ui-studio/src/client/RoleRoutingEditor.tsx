import React, { useMemo, useState } from 'react';
import type {
    AvailableModelItem,
    RoleDefinitionItem,
    RoleModelOverride,
    RolePoolId,
    RoleReasoningEffort,
    RoleTierOverride,
    SaveModelRoutingRequest
} from './types';

/** 三池展示名称唯一真相表 */
export const POOL_LABELS: Record<RolePoolId, string> = {
    strong_creative: '强模型池',
    fast_retrieval: '快模型池',
    audit: '独立挑错池'
};

/** 推理强度可选值唯一真相表 */
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<RoleReasoningEffort> = [
    'off',
    'low',
    'medium',
    'high',
    'max'
];

const ROLE_DISPLAY_NAMES: Record<string, string> = {
    librarian: 'Librarian',
    planner: 'Planner',
    writer: 'Writer',
    fact_checker: 'Checker',
    'fact-checker': 'Checker',
    extractor: 'Extractor',
    dreamer: 'Dreamer',
    patch: 'Patch (局部修补)'
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
    librarian: '翻阅前文与设定选页',
    planner: '规划本章剧情节拍',
    writer: '纯净环境执笔正文',
    fact_checker: '独立核对前后设定矛盾',
    'fact-checker': '独立核对前后设定矛盾',
    extractor: '章末更新人物与伏笔',
    dreamer: '跨章阶段整理与归纳',
    patch: '局部修补套话与瑕疵'
};

export interface RoleRoutingEditorProps {
    /** 作品根目录切换标识，变更时重置本地未保存草稿与提示状态 */
    resetKey?: string | null | undefined;
    /** 当前三池模型路由（用于推导各池模型与提供商前缀） */
    poolRoutes: Record<RolePoolId, string>;
    /** 单书覆盖的三池配置（可选，优先用于初始化第一层底座输入框） */
    modelRouting?: Record<string, string> | null | undefined;
    /** 服务端当前已持久化的分角色覆盖配置 */
    roleRouting?: Record<string, RoleModelOverride> | null | undefined;
    /** 后端下发的工种模型定义清单 */
    roleDefinitions?: RoleDefinitionItem[] | null | undefined;
    /** 后端注册的可用模型候选清单 */
    availableModels?: AvailableModelItem[] | null | undefined;
    /** 后端处于忙碌状态时禁用编辑与保存 */
    busy?: boolean | undefined;
    /** 保存分角色模型路由覆盖配置回调 */
    onSaveModelRouting?: ((payload: SaveModelRoutingRequest) => Promise<void> | void) | undefined;
}

let roleDatalistSeq = 0;

function isValidTier(value: unknown): value is RoleTierOverride {
    return value === 'strong' || value === 'weak';
}

function isValidReasoningEffort(value: unknown): value is RoleReasoningEffort {
    return (
        typeof value === 'string' &&
        (REASONING_EFFORT_OPTIONS as readonly string[]).includes(value)
    );
}

/** 格式化 Agent 工种展示名称（fact_checker 统一映射为 Checker） */
export function formatRoleDisplayLabel(roleId: string): string {
    const normalized = roleId.trim().toLowerCase();
    return ROLE_DISPLAY_NAMES[normalized] ?? roleId;
}

function resolveBaselinePools(
    poolRoutes: Record<RolePoolId, string>,
    modelRouting?: Record<string, string> | null
): Record<RolePoolId, string> {
    return {
        strong_creative: modelRouting?.strong_creative ?? poolRoutes.strong_creative ?? '',
        fast_retrieval: modelRouting?.fast_retrieval ?? poolRoutes.fast_retrieval ?? '',
        audit: modelRouting?.audit ?? poolRoutes.audit ?? ''
    };
}

/** 规范化来自服务端或草稿的分角色覆盖表，保留合法非空字段以匹配 exactOptionalPropertyTypes */
export function normalizeRoleRoutingMap(
    raw: Record<string, RoleModelOverride> | null | undefined,
    trimModel = false
): Record<string, RoleModelOverride> {
    if (!raw) return {};
    const out: Record<string, RoleModelOverride> = {};
    for (const [roleId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== 'object') continue;
        const next: RoleModelOverride = {};
        if (isValidTier(entry.tier)) {
            next.tier = entry.tier;
        }
        if (typeof entry.model === 'string') {
            const normalizedModel = trimModel ? entry.model.trim() : entry.model;
            if (normalizedModel.trim().length > 0) {
                next.model = normalizedModel;
            }
        }
        if (typeof entry.reasoning_effort === 'string') {
            const trimmedEffort = entry.reasoning_effort.trim();
            if (isValidReasoningEffort(trimmedEffort)) {
                next.reasoning_effort = trimmedEffort;
            }
        }
        if (
            next.tier !== undefined ||
            next.model !== undefined ||
            next.reasoning_effort !== undefined
        ) {
            out[roleId] = next;
        }
    }
    return out;
}

/** 格式化候选模型值（provider:model），避免重复前缀 */
function formatAvailableModelValue(item: AvailableModelItem): string {
    if (!item.provider || item.model.includes(':')) {
        return item.model;
    }
    return `${item.provider}:${item.model}`;
}

/** 结合三池路由与无 Layer 2 覆盖的工种定义收集各池已知 provider */
export function collectPoolProviders(
    poolRoutes: Record<RolePoolId, string>,
    roleDefinitions: readonly RoleDefinitionItem[],
    serverRoleRouting?: Record<string, RoleModelOverride> | null
): Partial<Record<RolePoolId, string>> {
    const providers: Partial<Record<RolePoolId, string>> = {};
    for (const poolId of Object.keys(POOL_LABELS) as RolePoolId[]) {
        const route = poolRoutes[poolId];
        const colonIdx = route.indexOf(':');
        if (colonIdx > 0) {
            providers[poolId] = route.slice(0, colonIdx);
        }
    }
    for (const def of roleDefinitions) {
        const provider = def.effectiveProvider?.trim();
        if (!provider) continue;
        // 跳过带 Layer 2 指定模型的工种，防止其模型提供商反向污染整池默认前缀
        if (serverRoleRouting?.[def.id]?.model?.trim()) continue;
        const pool =
            def.effectivePool ??
            (def.effectiveTier === 'strong'
                ? 'strong_creative'
                : def.effectiveTier === 'weak'
                  ? 'fast_retrieval'
                  : def.defaultPool);
        if (pool && !providers[pool]) {
            providers[pool] = provider;
        }
    }
    return providers;
}

/** 根据草稿覆盖、三池基线与已知池级 provider 即时推导单工种当前解析生效模型展示文本 */
export function resolveEffectiveRoleModelLabel(
    roleDef: RoleDefinitionItem,
    draftOverride: RoleModelOverride | undefined,
    serverOverride: RoleModelOverride | undefined,
    poolRoutes: Record<RolePoolId, string>,
    poolProviders: Partial<Record<RolePoolId, string>> = {},
    preferDraftPools = false
): string {
    const resolveTargetPool = (tier: RoleTierOverride | undefined): RolePoolId | undefined => {
        if (tier === 'strong') return 'strong_creative';
        if (tier === 'weak') return 'fast_retrieval';
        return roleDef.defaultPool;
    };

    const formatPoolRoute = (pool: RolePoolId | undefined): string => {
        if (!pool) return '--';
        const route = poolRoutes[pool];
        if (!route || route === '--') return '--';
        if (route.includes(':')) return route;
        const provider = poolProviders[pool];
        return provider ? `${provider}:${route}` : route;
    };

    const draftModel = draftOverride?.model?.trim();
    if (draftModel) {
        if (draftModel.includes(':')) {
            return draftModel;
        }
        const targetPool = resolveTargetPool(draftOverride?.tier);
        const baseRoute = targetPool ? poolRoutes[targetPool] : '';
        const colonIdx = baseRoute.indexOf(':');
        const provider =
            colonIdx > 0
                ? baseRoute.slice(0, colonIdx)
                : targetPool
                  ? poolProviders[targetPool] ??
                    (targetPool === roleDef.defaultPool && !serverOverride?.model?.trim()
                        ? roleDef.effectiveProvider
                        : '')
                  : '';
        return provider ? `${provider}:${draftModel}` : draftModel;
    }

    if (draftOverride?.tier === 'strong') {
        return formatPoolRoute('strong_creative');
    }
    if (draftOverride?.tier === 'weak') {
        return formatPoolRoute('fast_retrieval');
    }

    // 未配置本地覆盖时：若第一层底座未被本地修改，采用服务端解析后的 effectiveProvider/effectiveModel
    const hadServerModelOrTier =
        Boolean(serverOverride?.model?.trim()) || isValidTier(serverOverride?.tier);
    if (
        !preferDraftPools &&
        !hadServerModelOrTier &&
        roleDef.effectiveModel &&
        roleDef.effectiveModel !== '--'
    ) {
        if (roleDef.effectiveModel.includes(':') || !roleDef.effectiveProvider) {
            return roleDef.effectiveModel;
        }
        return `${roleDef.effectiveProvider}:${roleDef.effectiveModel}`;
    }

    return formatPoolRoute(roleDef.defaultPool);
}

/**
 * 两层可编辑模型分配编辑器：
 * - 第一层「全局强弱基础模型底座」：强模型池 / 快模型池 / 独立挑错池直接编辑（关联 datalist）
 * - 第二层「按 Agent 单独指定」：手风琴按需展开，fact_checker 统一显示为 Checker，覆盖项主色高亮
 * - 严守唯一实心主按钮规则：!isDirty 时用描边次级态（ns-btn-ghost），isDirty 时点亮主色实心（ns-btn-primary）
 */
export function RoleRoutingEditor({
    resetKey = null,
    poolRoutes,
    modelRouting = null,
    roleRouting = null,
    roleDefinitions = null,
    availableModels = null,
    busy = false,
    onSaveModelRouting
}: RoleRoutingEditorProps): React.ReactElement {
    const [datalistId] = useState<string>(() => `ns-i-available-models-${++roleDatalistSeq}`);

    const baselinePools = useMemo(
        () => resolveBaselinePools(poolRoutes, modelRouting),
        [poolRoutes, modelRouting]
    );
    const serverPoolsKey = useMemo(() => JSON.stringify(baselinePools), [baselinePools]);

    const normalizedResetKey = resetKey ?? null;
    const serverRoleRoutingKey = useMemo(
        () => JSON.stringify(roleRouting ?? {}),
        [roleRouting]
    );
    const [syncedResetKey, setSyncedResetKey] = useState<string | null>(normalizedResetKey);
    const [syncedPoolsKey, setSyncedPoolsKey] = useState<string>(serverPoolsKey);
    const [syncedRoleRoutingKey, setSyncedRoleRoutingKey] = useState<string>(serverRoleRoutingKey);

    const [draftPoolRoutes, setDraftPoolRoutes] = useState<Record<RolePoolId, string>>(
        () => ({ ...baselinePools })
    );
    const [draftRoleRouting, setDraftRoleRouting] = useState<Record<string, RoleModelOverride>>(
        () => normalizeRoleRoutingMap(roleRouting)
    );
    const [expandedRoles, setExpandedRoles] = useState<Record<string, boolean>>({});
    const [savingRouting, setSavingRouting] = useState<boolean>(false);
    const [saveFeedback, setSaveFeedback] = useState<{
        kind: 'success' | 'error';
        text: string;
    } | null>(null);

    if (syncedResetKey !== normalizedResetKey) {
        setSyncedResetKey(normalizedResetKey);
        setSyncedPoolsKey(serverPoolsKey);
        setSyncedRoleRoutingKey(serverRoleRoutingKey);
        setDraftPoolRoutes({ ...baselinePools });
        setDraftRoleRouting(normalizeRoleRoutingMap(roleRouting));
        setSaveFeedback(null);
    } else {
        if (syncedPoolsKey !== serverPoolsKey) {
            setSyncedPoolsKey(serverPoolsKey);
            setDraftPoolRoutes({ ...baselinePools });
        }
        if (syncedRoleRoutingKey !== serverRoleRoutingKey) {
            setSyncedRoleRoutingKey(serverRoleRoutingKey);
            setDraftRoleRouting(normalizeRoleRoutingMap(roleRouting));
        }
    }

    const resolvedRoleDefinitions = useMemo<RoleDefinitionItem[]>(() => {
        if (roleDefinitions && roleDefinitions.length > 0) {
            return roleDefinitions;
        }
        const existingRoleIds = Object.keys(roleRouting ?? {});
        if (existingRoleIds.length === 0) {
            return [];
        }
        return existingRoleIds.map((roleId) => ({
            id: roleId,
            effectiveProvider: '',
            effectiveModel: '--'
        }));
    }, [roleDefinitions, roleRouting]);

    const poolProviders = useMemo(
        () => collectPoolProviders(draftPoolRoutes, resolvedRoleDefinitions, roleRouting),
        [draftPoolRoutes, resolvedRoleDefinitions, roleRouting]
    );

    const isPoolDirty = useMemo(
        () =>
            (['strong_creative', 'fast_retrieval', 'audit'] as const).some(
                (poolId) => draftPoolRoutes[poolId].trim() !== baselinePools[poolId].trim()
            ),
        [draftPoolRoutes, baselinePools]
    );

    const isRoleDirty = useMemo(() => {
        const currentCleaned = normalizeRoleRoutingMap(draftRoleRouting, true);
        const serverCleaned = normalizeRoleRoutingMap(roleRouting, true);
        return JSON.stringify(currentCleaned) !== JSON.stringify(serverCleaned);
    }, [draftRoleRouting, roleRouting]);

    const isDirty = isPoolDirty || isRoleDirty;

    const allExpanded =
        resolvedRoleDefinitions.length > 0 &&
        resolvedRoleDefinitions.every((def) => Boolean(expandedRoles[def.id]));

    const updatePoolDraft = (poolId: RolePoolId, value: string): void => {
        setSaveFeedback(null);
        setDraftPoolRoutes((prev) => ({
            ...prev,
            [poolId]: value
        }));
    };

    const updateRoleDraft = (
        roleId: string,
        patch: Partial<Record<'tier' | 'model' | 'reasoning_effort', string>>
    ): void => {
        setSaveFeedback(null);
        setDraftRoleRouting((prev) => {
            const current = prev[roleId] ?? {};
            const nextEntry: RoleModelOverride = { ...current };

            if ('tier' in patch) {
                if (isValidTier(patch.tier)) {
                    nextEntry.tier = patch.tier;
                } else {
                    delete nextEntry.tier;
                }
            }
            if ('model' in patch) {
                if (typeof patch.model === 'string' && patch.model.length > 0) {
                    nextEntry.model = patch.model;
                } else {
                    delete nextEntry.model;
                }
            }
            if ('reasoning_effort' in patch) {
                if (isValidReasoningEffort(patch.reasoning_effort)) {
                    nextEntry.reasoning_effort = patch.reasoning_effort;
                } else {
                    delete nextEntry.reasoning_effort;
                }
            }

            const next = { ...prev };
            if (
                nextEntry.tier === undefined &&
                nextEntry.model === undefined &&
                nextEntry.reasoning_effort === undefined
            ) {
                delete next[roleId];
            } else {
                next[roleId] = nextEntry;
            }
            return next;
        });
    };

    const toggleAllRoles = (): void => {
        const nextOpen = !allExpanded;
        const nextMap: Record<string, boolean> = {};
        for (const def of resolvedRoleDefinitions) {
            nextMap[def.id] = nextOpen;
        }
        setExpandedRoles(nextMap);
    };

    const handleSaveRoleRouting = async (): Promise<void> => {
        if (!onSaveModelRouting || busy || savingRouting) return;
        setSavingRouting(true);
        setSaveFeedback(null);
        try {
            const cleanedRoles = normalizeRoleRoutingMap(draftRoleRouting, true);
            const payload: SaveModelRoutingRequest = {
                role_routing: cleanedRoles
            };
            if (isPoolDirty) {
                payload.model_routing = {
                    strong_creative: draftPoolRoutes.strong_creative.trim(),
                    fast_retrieval: draftPoolRoutes.fast_retrieval.trim(),
                    audit: draftPoolRoutes.audit.trim()
                };
            }
            await onSaveModelRouting(payload);
            setSaveFeedback({ kind: 'success', text: '工种模型配置已保存' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setSaveFeedback({ kind: 'error', text: `保存失败: ${message}` });
        } finally {
            setSavingRouting(false);
        }
    };

    return (
        <div className="ns-i-list" aria-label="模型分配">
            <datalist id={datalistId}>
                {(availableModels ?? []).map((item) => {
                    const val = formatAvailableModelValue(item);
                    return (
                        <option key={val} value={val}>
                            {item.label ? `${item.label} (${val})` : val}
                        </option>
                    );
                })}
            </datalist>

            {/* 第一层：全局强弱基础模型底座 */}
            <section className="ns-panel-section" aria-label="全局强弱基础模型底座">
                <div className="ns-sec-head">
                    <span>第一层 · 全局强弱基础模型底座</span>
                    <span className="ns-pill ns-pill-muted">可直接修改</span>
                </div>
                <div className="ns-pool-edit-list">
                    <label className="ns-field-row">
                        <span>强模型池（默认负责 Planner · Writer · Patch · Dreamer）</span>
                        <input
                            type="text"
                            className="ns-mono"
                            list={datalistId}
                            aria-label="强模型池"
                            disabled={busy || savingRouting}
                            value={draftPoolRoutes.strong_creative}
                            onChange={(e) => updatePoolDraft('strong_creative', e.target.value)}
                        />
                    </label>
                    <label className="ns-field-row">
                        <span>快模型池（默认负责 Librarian · Extractor）</span>
                        <input
                            type="text"
                            className="ns-mono"
                            list={datalistId}
                            aria-label="快模型池"
                            disabled={busy || savingRouting}
                            value={draftPoolRoutes.fast_retrieval}
                            onChange={(e) => updatePoolDraft('fast_retrieval', e.target.value)}
                        />
                    </label>
                    <label className="ns-field-row">
                        <span>独立挑错池（默认负责 Checker 异构核查）</span>
                        <input
                            type="text"
                            className="ns-mono"
                            list={datalistId}
                            aria-label="独立挑错池"
                            disabled={busy || savingRouting}
                            value={draftPoolRoutes.audit}
                            onChange={(e) => updatePoolDraft('audit', e.target.value)}
                        />
                    </label>
                </div>
            </section>

            {/* 第二层：按 Agent 单独指定 */}
            <section className="ns-panel-section" aria-label="按 Agent 单独指定">
                <div className="ns-sec-head">
                    <span>第二层 · 按 Agent 单独指定</span>
                    {resolvedRoleDefinitions.length > 0 ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-ghost ns-btn-xs"
                            onClick={toggleAllRoles}
                        >
                            {allExpanded ? '全部收起' : '全部展开'}
                        </button>
                    ) : null}
                </div>

                {resolvedRoleDefinitions.length === 0 ? (
                    <div className="ns-i-empty">
                        等待服务端下发工种配置 (roleDefinitions)...
                    </div>
                ) : (
                    <div className="ns-role-override-list">
                        {resolvedRoleDefinitions.map((roleDef) => {
                            const draft = draftRoleRouting[roleDef.id];
                            const serverEntry = roleRouting?.[roleDef.id];
                            const effectivePool =
                                draft?.tier === 'strong'
                                    ? 'strong_creative'
                                    : draft?.tier === 'weak'
                                      ? 'fast_retrieval'
                                      : roleDef.defaultPool;
                            const poolEditedForRole = Boolean(
                                effectivePool &&
                                    draftPoolRoutes[effectivePool].trim() !==
                                        baselinePools[effectivePool].trim()
                            );
                            const effectiveLabel = resolveEffectiveRoleModelLabel(
                                roleDef,
                                draft,
                                serverEntry,
                                draftPoolRoutes,
                                poolProviders,
                                poolEditedForRole
                            );
                            const hadServerEffort = isValidReasoningEffort(
                                serverEntry?.reasoning_effort
                            );
                            const effectiveEffort =
                                draft?.reasoning_effort ??
                                (hadServerEffort
                                    ? roleDef.defaultReasoningEffort
                                    : (roleDef.effectiveReasoningEffort ??
                                      roleDef.defaultReasoningEffort));
                            const hasOverride = Boolean(
                                draft?.tier || draft?.model?.trim() || draft?.reasoning_effort
                            );
                            const isExpanded = Boolean(expandedRoles[roleDef.id]);
                            const displayName = formatRoleDisplayLabel(roleDef.id);
                            const roleDesc = ROLE_DESCRIPTIONS[roleDef.id.toLowerCase()];

                            return (
                                <div
                                    key={roleDef.id}
                                    className="ns-role-row"
                                    data-role-id={roleDef.id}
                                    data-role-overridden={hasOverride ? 'true' : undefined}
                                >
                                    <button
                                        type="button"
                                        className="ns-role-summary"
                                        aria-expanded={isExpanded}
                                        aria-controls={`ns-role-detail-${roleDef.id}`}
                                        onClick={() =>
                                            setExpandedRoles((prev) => ({
                                                ...prev,
                                                [roleDef.id]: !prev[roleDef.id]
                                            }))
                                        }
                                    >
                                        <span
                                            className={`ns-i-role-id${
                                                hasOverride ? ' ns-i-route-model-brand' : ''
                                            }`}
                                        >
                                            {displayName}
                                        </span>
                                        <span
                                            className={`ns-mono ns-i-role-effective${
                                                hasOverride ? ' ns-i-route-model-brand' : ' ns-i-muted'
                                            }`}
                                            title={effectiveLabel}
                                        >
                                            {effectiveLabel}
                                            {effectiveEffort ? ` (${effectiveEffort})` : ''}
                                        </span>
                                        <span className="ns-i-chevron" aria-hidden="true">
                                            ›
                                        </span>
                                    </button>

                                    <div
                                        className="ns-role-detail"
                                        id={`ns-role-detail-${roleDef.id}`}
                                        hidden={!isExpanded}
                                    >
                                        <div className="ns-i-role-head">
                                            <span className="ns-i-role-label">
                                                {roleDesc ?? '工种独立覆盖'}
                                            </span>
                                            <span
                                                className="ns-mono ns-i-role-pool"
                                                title={
                                                    roleDef.defaultPool
                                                        ? POOL_LABELS[roleDef.defaultPool]
                                                        : undefined
                                                }
                                            >
                                                {roleDef.defaultPool ?? '--'}
                                            </span>
                                        </div>
                                        <div className="ns-i-role-controls">
                                            <label className="ns-field-row">
                                                <span>Layer 1 档位</span>
                                                <select
                                                    aria-label={`${roleDef.id} 档位覆盖`}
                                                    disabled={busy || savingRouting}
                                                    value={draft?.tier ?? ''}
                                                    onChange={(e) =>
                                                        updateRoleDraft(roleDef.id, {
                                                            tier: e.target.value
                                                        })
                                                    }
                                                >
                                                    <option value="">继承默认</option>
                                                    <option value="strong">强模型 (strong)</option>
                                                    <option value="weak">弱模型 (weak)</option>
                                                </select>
                                            </label>
                                            <label className="ns-field-row">
                                                <span>推理强度</span>
                                                <select
                                                    aria-label={`${roleDef.id} 推理强度`}
                                                    disabled={busy || savingRouting}
                                                    value={draft?.reasoning_effort ?? ''}
                                                    onChange={(e) =>
                                                        updateRoleDraft(roleDef.id, {
                                                            reasoning_effort: e.target.value
                                                        })
                                                    }
                                                >
                                                    <option value="">继承默认</option>
                                                    {REASONING_EFFORT_OPTIONS.map((effort) => (
                                                        <option key={effort} value={effort}>
                                                            {effort}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                            <label className="ns-field-row ns-i-role-field-full">
                                                <span>Layer 2 指定模型（留空继承 Layer 1）</span>
                                                <input
                                                    type="text"
                                                    className="ns-mono"
                                                    list={datalistId}
                                                    aria-label={`${roleDef.id} 指定模型`}
                                                    placeholder="留空继承 Layer 1"
                                                    disabled={busy || savingRouting}
                                                    value={draft?.model ?? ''}
                                                    onChange={(e) =>
                                                        updateRoleDraft(roleDef.id, {
                                                            model: e.target.value
                                                        })
                                                    }
                                                />
                                            </label>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            <div className="ns-i-role-actions">
                <button
                    type="button"
                    className={`ns-btn ns-btn-sm ${isDirty ? 'ns-btn-primary' : 'ns-btn-ghost'}`}
                    disabled={
                        busy ||
                        savingRouting ||
                        !onSaveModelRouting ||
                        (resolvedRoleDefinitions.length === 0 && !isPoolDirty)
                    }
                    onClick={() => {
                        void handleSaveRoleRouting();
                    }}
                >
                    {savingRouting ? '正在保存配置…' : '保存工种模型配置'}
                </button>
                {saveFeedback ? (
                    <span
                        role="status"
                        aria-live="polite"
                        className={`ns-i-role-feedback ${
                            saveFeedback.kind === 'error' ? 'ns-i-red-ink' : 'ns-i-green-ink'
                        }`}
                    >
                        {saveFeedback.text}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

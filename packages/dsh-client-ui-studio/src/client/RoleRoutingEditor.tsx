import React, { useMemo, useState } from 'react';
import type {
    AvailableModelItem,
    DefaultModelSelection,
    RoleDefinitionItem,
    RoleModelOverride,
    RolePoolId,
    RoleReasoningEffort,
    RoleTierOverride,
    SaveModelRoutingRequest
} from './types';

/** 双池展示名称唯一真相表 */
export const POOL_LABELS: Record<RolePoolId, string> = {
    strong_creative: '强模型池',
    fast_retrieval: '快模型池'
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
    /** DSH 本体当前全局默认模型 */
    defaultModel?: DefaultModelSelection | null | undefined;
    /** 显式池级覆盖（跟随 DSH 默认时对应键省略或为空串） */
    poolOverrides?: Record<string, string> | null | undefined;
    /** 当前双池生效模型路由（用于推导各池模型与提供商前缀） */
    poolRoutes: Record<RolePoolId, string>;
    /** 生效的双池配置（兼容未提供 poolOverrides 的旧调用方） */
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

const DUAL_POOL_IDS: readonly RolePoolId[] = ['strong_creative', 'fast_retrieval'];

function normalizePoolId(pool: string | undefined): RolePoolId | undefined {
    if (pool === 'strong_creative' || pool === 'audit') return 'strong_creative';
    if (pool === 'fast_retrieval') return 'fast_retrieval';
    return undefined;
}

function formatDefaultModelLabel(defaultModel: DefaultModelSelection | null | undefined): string {
    const model = defaultModel?.model?.trim();
    if (!model) return '';
    const provider = defaultModel?.provider?.trim();
    if (provider) {
        return `${provider}:${model}`;
    }
    return model;
}

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
    poolOverrides?: Record<string, string> | null,
    modelRouting?: Record<string, string> | null
): Record<RolePoolId, string> {
    if (poolOverrides !== null && poolOverrides !== undefined) {
        return {
            strong_creative: poolOverrides['strong_creative'] ?? '',
            fast_retrieval: poolOverrides['fast_retrieval'] ?? ''
        };
    }
    if (modelRouting !== null && modelRouting !== undefined) {
        return {
            strong_creative: modelRouting['strong_creative'] ?? '',
            fast_retrieval: modelRouting['fast_retrieval'] ?? ''
        };
    }
    return {
        strong_creative: '',
        fast_retrieval: ''
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

/** 已拆分的候选只在生成配置值时拼接，原始模型名可以包含冒号。 */
function formatAvailableModelValue(item: AvailableModelItem): string {
    if (!item.provider) {
        return item.model;
    }
    return `${item.provider}:${item.model}`;
}

interface ModelSelectOption {
    value: string;
    label: string;
}

function buildSelectModelOptions(
    availableModels: readonly AvailableModelItem[] | null | undefined,
    currentValue: string
): ModelSelectOption[] {
    const options: ModelSelectOption[] = [];
    const seen = new Set<string>();
    for (const item of availableModels ?? []) {
        const val = formatAvailableModelValue(item);
        if (!val || seen.has(val)) continue;
        seen.add(val);
        const label = item.label && item.label !== val ? `${item.label} (${val})` : val;
        options.push({ value: val, label });
    }
    const trimmedCurrent = currentValue.trim();
    if (trimmedCurrent && trimmedCurrent !== '--' && !seen.has(trimmedCurrent)) {
        options.push({ value: trimmedCurrent, label: `${trimmedCurrent}（当前配置）` });
    }
    return options;
}

const POOL_EDIT_FIELDS: ReadonlyArray<{
    poolId: RolePoolId;
    label: string;
    ariaLabel: string;
}> = [
    {
        poolId: 'strong_creative',
        label: '强模型池（默认负责 Planner · Writer · Checker · Patch · Dreamer）',
        ariaLabel: '强模型池'
    },
    {
        poolId: 'fast_retrieval',
        label: '快模型池（默认负责 Librarian · Extractor）',
        ariaLabel: '快模型池'
    }
];

function resolvePoolForTier(
    tier: RoleTierOverride | null | undefined,
    fallbackPool?: RolePoolId
): RolePoolId | undefined {
    if (tier === 'strong') return 'strong_creative';
    if (tier === 'weak') return 'fast_retrieval';
    return fallbackPool;
}

function resolveEffectiveReasoningEffort(
    roleDef: RoleDefinitionItem,
    draft: RoleModelOverride | undefined,
    serverEntry: RoleModelOverride | undefined
): RoleReasoningEffort | undefined {
    if (draft?.reasoning_effort === serverEntry?.reasoning_effort) return roleDef.effectiveReasoningEffort;
    if (draft?.reasoning_effort) return draft.reasoning_effort;
    if (isValidReasoningEffort(serverEntry?.reasoning_effort)) {
        return roleDef.defaultReasoningEffort;
    }
    return roleDef.effectiveReasoningEffort;
}

function resolveDraftModelProvider(
    roleDef: RoleDefinitionItem,
    targetPool: RolePoolId | undefined,
    poolRoutes: Record<RolePoolId, string>,
    poolProviders: Partial<Record<RolePoolId, string>>,
    serverOverride: RoleModelOverride | undefined
): string {
    const baseRoute = targetPool ? poolRoutes[targetPool] : '';
    const colonIdx = baseRoute.indexOf(':');
    if (colonIdx > 0) {
        return baseRoute.slice(0, colonIdx);
    }
    if (!targetPool) return '';
    const poolProvider = poolProviders[targetPool];
    if (poolProvider !== undefined) return poolProvider;
    if (targetPool === normalizePoolId(roleDef.defaultPool) && !serverOverride?.model?.trim()) {
        return roleDef.effectiveProvider;
    }
    return '';
}

/** 结合双池路由与无 Layer 2 覆盖的工种定义收集各池已知 provider */
export function collectPoolProviders(
    poolRoutes: Record<RolePoolId, string>,
    roleDefinitions: readonly RoleDefinitionItem[],
    serverRoleRouting?: Record<string, RoleModelOverride> | null
): Partial<Record<RolePoolId, string>> {
    const providers: Partial<Record<RolePoolId, string>> = {};
    for (const poolId of DUAL_POOL_IDS) {
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
            normalizePoolId(def.effectivePool) ??
            resolvePoolForTier(def.effectiveTier, normalizePoolId(def.defaultPool));
        if (pool && !providers[pool]) {
            providers[pool] = provider;
        }
    }
    return providers;
}

/** 根据草稿覆盖、双池基线与已知池级 provider 即时推导单工种当前解析生效模型展示文本 */
export function resolveEffectiveRoleModelLabel(
    roleDef: RoleDefinitionItem,
    draftOverride: RoleModelOverride | undefined,
    serverOverride: RoleModelOverride | undefined,
    poolRoutes: Record<RolePoolId, string>,
    poolProviders: Partial<Record<RolePoolId, string>> = {},
    preferDraftPools = false
): string {
    function formatPoolRoute(pool: RolePoolId | undefined): string {
        if (!pool) return '--';
        const route = poolRoutes[pool];
        if (!route || route === '--') return '--';
        if (route.includes(':')) return route;
        const provider = poolProviders[pool];
        return provider ? `${provider}:${route}` : route;
    }

    const normalizedDefaultPool = normalizePoolId(roleDef.defaultPool);
    const draftModel = draftOverride?.model?.trim();
    if (draftModel) {
        if (draftModel.includes(':')) {
            return draftModel;
        }
        const targetPool = resolvePoolForTier(draftOverride?.tier, normalizedDefaultPool);
        const provider = resolveDraftModelProvider(
            roleDef,
            targetPool,
            poolRoutes,
            poolProviders,
            serverOverride
        );
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
        if (!roleDef.effectiveProvider) {
            return roleDef.effectiveModel;
        }
        return `${roleDef.effectiveProvider}:${roleDef.effectiveModel}`;
    }

    return formatPoolRoute(normalizedDefaultPool);
}

/**
 * 两层可编辑模型分配编辑器：
 * - 第一层「全局强弱基础模型底座」：强模型池 / 快模型池原生 <select> 选择（首项跟随 DSH 本体默认）
 * - 第二层「按 Agent 单独指定」：手风琴按需展开，fact_checker 统一显示为 Checker 并默认归属强模型池，覆盖项主色高亮
 * - 严守唯一实心主按钮规则：!isDirty 时用描边次级态（ns-btn-ghost），isDirty 时点亮主色实心（ns-btn-primary）
 */
export function RoleRoutingEditor({
    resetKey = null,
    defaultModel = null,
    poolOverrides = null,
    poolRoutes,
    modelRouting = null,
    roleRouting = null,
    roleDefinitions = null,
    availableModels = null,
    busy = false,
    onSaveModelRouting
}: RoleRoutingEditorProps): React.ReactElement {
    const baselinePools = useMemo(
        () => resolveBaselinePools(poolOverrides, modelRouting),
        [poolOverrides, modelRouting]
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

    const defaultModelLabel = formatDefaultModelLabel(defaultModel);
    const previewPoolRoutes = useMemo<Record<RolePoolId, string>>(() => {
        function resolvePoolPreview(poolId: RolePoolId): string {
            const draftVal = draftPoolRoutes[poolId].trim();
            if (draftVal) return draftVal;
            if (!baselinePools[poolId].trim() && poolRoutes[poolId] && poolRoutes[poolId] !== '--') {
                return poolRoutes[poolId];
            }
            return defaultModelLabel || '--';
        }
        return {
            strong_creative: resolvePoolPreview('strong_creative'),
            fast_retrieval: resolvePoolPreview('fast_retrieval')
        };
    }, [baselinePools, defaultModelLabel, draftPoolRoutes, poolRoutes]);

    const poolProviders = useMemo(
        () => collectPoolProviders(previewPoolRoutes, resolvedRoleDefinitions, roleRouting),
        [previewPoolRoutes, resolvedRoleDefinitions, roleRouting]
    );

    const isPoolDirty = useMemo(
        () =>
            DUAL_POOL_IDS.some(
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
                    fast_retrieval: draftPoolRoutes.fast_retrieval.trim()
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

    const toggleAllLabel = allExpanded ? '全部收起' : '全部展开';

    function renderRoleOverrideRow(roleDef: RoleDefinitionItem): React.ReactElement {
        const draft = draftRoleRouting[roleDef.id];
        const serverEntry = roleRouting?.[roleDef.id];
        const normalizedDefaultPool = normalizePoolId(roleDef.defaultPool);
        const effectivePool = resolvePoolForTier(draft?.tier, normalizedDefaultPool);
        const poolEditedForRole = Boolean(
            effectivePool &&
                draftPoolRoutes[effectivePool].trim() !== baselinePools[effectivePool].trim()
        );
        const effectiveLabel = resolveEffectiveRoleModelLabel(
            roleDef,
            draft,
            serverEntry,
            previewPoolRoutes,
            poolProviders,
            poolEditedForRole
        );
        const effectiveEffort = resolveEffectiveReasoningEffort(roleDef, draft, serverEntry);
        const hasOverride = Boolean(
            draft?.tier || draft?.model?.trim() || draft?.reasoning_effort
        );
        const isExpanded = Boolean(expandedRoles[roleDef.id]);
        const displayName = formatRoleDisplayLabel(roleDef.id);
        const roleDesc = ROLE_DESCRIPTIONS[roleDef.id.toLowerCase()];
        const roleModelValue = draft?.model ?? '';
        const roleModelOptions = buildSelectModelOptions(availableModels, roleModelValue);

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
                    <span className={`ns-i-role-id${hasOverride ? ' ns-i-route-model-brand' : ''}`}>
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
                        <span className="ns-i-role-label">{roleDesc ?? '工种独立覆盖'}</span>
                        <span
                            className="ns-mono ns-i-role-pool"
                            title={normalizedDefaultPool ? POOL_LABELS[normalizedDefaultPool] : undefined}
                        >
                            {normalizedDefaultPool ?? '--'}
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
                                    updateRoleDraft(roleDef.id, { tier: e.target.value })
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
                            <span>Layer 2 指定模型</span>
                            <select
                                className="ns-mono"
                                aria-label={`${roleDef.id} 指定模型`}
                                disabled={busy || savingRouting}
                                value={roleModelValue}
                                onChange={(e) =>
                                    updateRoleDraft(roleDef.id, { model: e.target.value })
                                }
                            >
                                <option value="">继承第一层底座</option>
                                {roleModelOptions.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </div>
            </div>
        );
    }

    function renderRoleOverrideBody(): React.ReactElement {
        if (resolvedRoleDefinitions.length === 0) {
            return (
                <div className="ns-i-empty">
                    等待服务端下发工种配置 (roleDefinitions)...
                </div>
            );
        }
        return (
            <div className="ns-role-override-list">
                {resolvedRoleDefinitions.map(renderRoleOverrideRow)}
            </div>
        );
    }

    function renderSaveFeedback(): React.ReactNode {
        if (!saveFeedback) return null;
        const toneClass = saveFeedback.kind === 'error' ? 'ns-i-red-ink' : 'ns-i-green-ink';
        return (
            <span
                role="status"
                aria-live="polite"
                className={`ns-i-role-feedback ${toneClass}`}
            >
                {saveFeedback.text}
            </span>
        );
    }

    const firstPoolOptionLabel = `跟随 DSH 本体默认（${defaultModelLabel || '未配置'}）`;

    return (
        <div className="ns-i-list" aria-label="模型分配">
            {/* 第一层：全局强弱基础模型底座 */}
            <section className="ns-panel-section" aria-label="全局强弱基础模型底座">
                <div className="ns-sec-head">
                    <span>第一层 · 全局强弱基础模型底座</span>
                    <span className="ns-pill ns-pill-muted">可直接切换</span>
                </div>
                <div className="ns-pool-edit-list">
                    {POOL_EDIT_FIELDS.map((field) => {
                        const poolValue = draftPoolRoutes[field.poolId];
                        const poolOptions = buildSelectModelOptions(availableModels, poolValue);
                        return (
                            <label key={field.poolId} className="ns-field-row">
                                <span>{field.label}</span>
                                <select
                                    className="ns-mono"
                                    aria-label={field.ariaLabel}
                                    disabled={busy || savingRouting}
                                    value={poolValue}
                                    onChange={(e) => updatePoolDraft(field.poolId, e.target.value)}
                                >
                                    <option value="">{firstPoolOptionLabel}</option>
                                    {poolOptions.map((opt) => (
                                        <option key={opt.value} value={opt.value}>
                                            {opt.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        );
                    })}
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
                            {toggleAllLabel}
                        </button>
                    ) : null}
                </div>

                {renderRoleOverrideBody()}
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
                {renderSaveFeedback()}
            </div>
        </div>
    );
}

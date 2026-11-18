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
    strong_creative: '强创作池',
    fast_retrieval: '检索快池',
    audit: '异构核查池'
};

/** 推理强度可选值唯一真相表 */
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<RoleReasoningEffort> = [
    'off',
    'low',
    'medium',
    'high',
    'max'
];

export interface RoleRoutingEditorProps {
    /** 作品根目录切换标识，变更时重置本地未保存草稿与提示状态 */
    resetKey?: string | null | undefined;
    /** 当前三池模型路由（用于推导各池模型与提供商前缀） */
    poolRoutes: Record<RolePoolId, string>;
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
    poolProviders: Partial<Record<RolePoolId, string>> = {}
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

    // 未配置本地覆盖时：若服务端原本也没有覆盖，则直接采用服务端计算后的 effectiveProvider/effectiveModel
    const hadServerModelOrTier =
        Boolean(serverOverride?.model?.trim()) || isValidTier(serverOverride?.tier);
    if (!hadServerModelOrTier && roleDef.effectiveModel && roleDef.effectiveModel !== '--') {
        if (roleDef.effectiveModel.includes(':') || !roleDef.effectiveProvider) {
            return roleDef.effectiveModel;
        }
        return `${roleDef.effectiveProvider}:${roleDef.effectiveModel}`;
    }

    return formatPoolRoute(roleDef.defaultPool);
}

/**
 * 分角色两层模型覆盖编辑器：
 * - 工种列表完全以后端下发的 roleDefinitions 为准；缺省且 roleRouting 已有键时仅按现有键生成最小配置行
 * - 切书时依据 resetKey 重置未保存草稿与反馈提示，避免跨书串稿
 */
export function RoleRoutingEditor({
    resetKey = null,
    poolRoutes,
    roleRouting = null,
    roleDefinitions = null,
    availableModels = null,
    busy = false,
    onSaveModelRouting
}: RoleRoutingEditorProps): React.ReactElement {
    const [datalistId] = useState<string>(() => `ns-i-available-models-${++roleDatalistSeq}`);

    const normalizedResetKey = resetKey ?? null;
    const serverRoleRoutingKey = useMemo(
        () => JSON.stringify(roleRouting ?? {}),
        [roleRouting]
    );
    const [syncedResetKey, setSyncedResetKey] = useState<string | null>(normalizedResetKey);
    const [syncedRoleRoutingKey, setSyncedRoleRoutingKey] = useState<string>(serverRoleRoutingKey);
    const [draftRoleRouting, setDraftRoleRouting] = useState<Record<string, RoleModelOverride>>(
        () => normalizeRoleRoutingMap(roleRouting)
    );
    const [savingRouting, setSavingRouting] = useState<boolean>(false);
    const [saveFeedback, setSaveFeedback] = useState<{
        kind: 'success' | 'error';
        text: string;
    } | null>(null);

    if (syncedResetKey !== normalizedResetKey) {
        setSyncedResetKey(normalizedResetKey);
        setSyncedRoleRoutingKey(serverRoleRoutingKey);
        setDraftRoleRouting(normalizeRoleRoutingMap(roleRouting));
        setSaveFeedback(null);
    } else if (syncedRoleRoutingKey !== serverRoleRoutingKey) {
        setSyncedRoleRoutingKey(serverRoleRoutingKey);
        setDraftRoleRouting(normalizeRoleRoutingMap(roleRouting));
    }

    // 工种列表：完全以后端下发的 roleDefinitions 为准；缺省时仅基于既有 roleRouting 键生成最小配置行
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
        () => collectPoolProviders(poolRoutes, resolvedRoleDefinitions, roleRouting),
        [poolRoutes, resolvedRoleDefinitions, roleRouting]
    );

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

    const handleSaveRoleRouting = async (): Promise<void> => {
        if (!onSaveModelRouting || busy || savingRouting) return;
        setSavingRouting(true);
        setSaveFeedback(null);
        try {
            const cleaned = normalizeRoleRoutingMap(draftRoleRouting, true);
            await onSaveModelRouting({ role_routing: cleaned });
            setSaveFeedback({ kind: 'success', text: '工种模型配置已保存' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setSaveFeedback({ kind: 'error', text: `保存失败: ${message}` });
        } finally {
            setSavingRouting(false);
        }
    };

    return (
        <div className="ns-i-card">
            <div className="ns-i-card-head">
                <span>分角色模型覆盖 (Subagent 2-Layer Override)</span>
            </div>
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
            {resolvedRoleDefinitions.length === 0 ? (
                <div className="ns-i-empty">
                    等待服务端下发工种配置 (roleDefinitions)...
                </div>
            ) : (
                <div className="ns-i-role-list">
                    {resolvedRoleDefinitions.map((roleDef) => {
                        const draft = draftRoleRouting[roleDef.id];
                        const serverEntry = roleRouting?.[roleDef.id];
                        const effectiveLabel = resolveEffectiveRoleModelLabel(
                            roleDef,
                            draft,
                            serverEntry,
                            poolRoutes,
                            poolProviders
                        );
                        // 当服务端原本存在推理强度覆盖而用户本地将其重置为空时，回退至 defaultReasoningEffort，消除旧值残留
                        const hadServerEffort = isValidReasoningEffort(serverEntry?.reasoning_effort);
                        const effectiveEffort =
                            draft?.reasoning_effort ??
                            (hadServerEffort
                                ? roleDef.defaultReasoningEffort
                                : (roleDef.effectiveReasoningEffort ??
                                  roleDef.defaultReasoningEffort));
                        return (
                            <div
                                key={roleDef.id}
                                className="ns-i-role-item"
                                data-role-id={roleDef.id}
                            >
                                <div className="ns-i-role-head">
                                    <span className="ns-mono ns-i-role-id">{roleDef.id}</span>
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
                                <div className="ns-mono ns-i-role-effective" title={effectiveLabel}>
                                    生效: {effectiveLabel}
                                    {effectiveEffort ? ` (${effectiveEffort})` : ''}
                                </div>
                                <div className="ns-i-role-controls">
                                    <label className="ns-i-role-field">
                                        <span className="ns-i-role-label">Layer 1 档位</span>
                                        <select
                                            className="ns-i-select"
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
                                    <label className="ns-i-role-field">
                                        <span className="ns-i-role-label">推理强度</span>
                                        <select
                                            className="ns-i-select"
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
                                    <label className="ns-i-role-field ns-i-role-field-full">
                                        <span className="ns-i-role-label">
                                            Layer 2 指定模型（留空继承 Layer 1）
                                        </span>
                                        <input
                                            type="text"
                                            className="ns-i-input"
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
                        );
                    })}
                </div>
            )}
            <div className="ns-i-role-actions">
                <button
                    type="button"
                    className="ns-btn ns-btn-primary ns-btn-sm"
                    disabled={
                        busy ||
                        savingRouting ||
                        !onSaveModelRouting ||
                        resolvedRoleDefinitions.length === 0
                    }
                    onClick={() => {
                        void handleSaveRoleRouting();
                    }}
                >
                    {savingRouting ? '正在保存配置…' : '保存工种模型配置'}
                </button>
                {saveFeedback && (
                    <span
                        role="status"
                        aria-live="polite"
                        className={`ns-i-role-feedback ${
                            saveFeedback.kind === 'error' ? 'ns-i-red-ink' : 'ns-i-green-ink'
                        }`}
                    >
                        {saveFeedback.text}
                    </span>
                )}
            </div>
        </div>
    );
}

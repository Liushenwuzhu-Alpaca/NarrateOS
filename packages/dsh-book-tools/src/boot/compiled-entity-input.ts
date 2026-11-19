import { isDeepStrictEqual } from 'node:util';

const ENTITY_KEYS = {
    entity_id: 'entityId', canonical_name: 'canonicalName', unique_aliases: 'uniqueAliases',
    contextual_titles: 'contextualTitles', innate_locks: 'innateLocks', acquired_state: 'acquiredState',
    irreversible_trajectory: 'irreversibleTrajectory', recent_buffer: 'recentBuffer'
} as const;
const ENTRY_KEYS = { story_day: 'storyDay', slot_key: 'slotKey' } as const;

function normalizeKeys(value: unknown, keys: Readonly<Record<string, string>>): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const normalized = { ...value } as Record<string, unknown>;
    for (const [snake, camel] of Object.entries(keys)) {
        if (!(snake in normalized)) continue;
        if (camel in normalized && !isDeepStrictEqual(normalized[snake], normalized[camel])) {
            throw new Error(`entities 字段 ${snake} 与 ${camel} 同时提供且内容不一致，请只保留一种命名`);
        }
        normalized[camel] = normalized[snake];
        delete normalized[snake];
    }
    return normalized;
}

/** 开书实体在 Zod 校验前统一字段名；正文字符串保持原样。 */
export function normalizeCompiledEntityInput(value: unknown): unknown {
    const normalized = normalizeKeys(value, ENTITY_KEYS);
    if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
    const entity = normalized as Record<string, unknown>;
    for (const section of ['innateLocks', 'acquiredState', 'irreversibleTrajectory', 'recentBuffer']) {
        if (Array.isArray(entity[section])) entity[section] = entity[section].map(entry => normalizeKeys(entry, ENTRY_KEYS));
    }
    return entity;
}

const visibility = { type: 'string', enum: ['PUBLIC', 'SELF_ONLY', 'OMNISCIENT_SECRET', 'READER_KNOWN'] } as const;
const text = { type: 'string', required: true } as const;
const timedEntry = {
    type: 'object', additionalProperties: false,
    properties: { text, story_day: { type: 'integer' }, storyDay: { type: 'integer' }, visibility, owner: { type: 'string' } }
} as const;

const innateLocks = { type: 'array', items: { type: 'object', additionalProperties: false, properties: { text, visibility } } } as const;
const acquiredState = { type: 'array', items: { ...timedEntry, properties: { ...timedEntry.properties, slot_key: { type: 'string' }, slotKey: { type: 'string' } } } } as const;
const strings = { type: 'array', items: { type: 'string' } } as const;
const history = { type: 'array', items: timedEntry } as const;

/** 兼容字段在工具前置校验层也可达；归一化后的必填约束由 Zod 统一执行。 */
export const COMPILED_ENTITY_TOOL_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        entity_id: { type: 'string', description: '必填稳定 ID：char_* 或 item_*；也接受 entityId' },
        canonical_name: { type: 'string', description: '必填中文标准名；也接受 canonicalName' },
        unique_aliases: strings, contextual_titles: strings,
        innate_locks: innateLocks, acquired_state: acquiredState,
        irreversible_trajectory: history, recent_buffer: history,
        entityId: { type: 'string' }, canonicalName: { type: 'string' },
        uniqueAliases: strings, contextualTitles: strings,
        innateLocks, acquiredState, irreversibleTrajectory: history, recentBuffer: history
    }
} as const;

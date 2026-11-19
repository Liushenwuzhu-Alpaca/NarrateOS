import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools';

const entry = {
    type: 'object', additionalProperties: false,
    properties: {
        text: { type: 'string', required: true },
        storyDay: { type: 'integer' },
        chapter: { type: 'integer' },
        visibility: { type: 'string', enum: ['SELF_ONLY', 'OMNISCIENT_SECRET', 'PUBLIC', 'READER_KNOWN'] },
        owner: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'WARPED'] },
        slotKey: { type: 'string' },
        extraTags: { type: 'object', additionalProperties: true, description: '字符串标签字典' },
        isNumericLedger: { type: 'boolean' },
        ledger: { type: 'object', additionalProperties: true, description: '字符串数值账本字典' },
        continuationLines: { type: 'array', items: { type: 'string' } }
    },
    description: '条目内层字段使用 camelCase（storyDay、slotKey、continuationLines）'
} as const satisfies ValueSchemaSpec;
const append = {
    type: 'object', additionalProperties: false,
    properties: { op: { type: 'string', const: 'append', required: true }, entry: { ...entry, required: true } }
} as const satisfies ValueSchemaSpec;
const upsertSlot = {
    type: 'object', additionalProperties: false,
    properties: {
        op: { type: 'string', const: 'upsert_slot', required: true },
        slot_key: { type: 'string', required: true },
        entry: { ...entry, required: true }
    }
} as const satisfies ValueSchemaSpec;
const removeSlot = {
    type: 'object', additionalProperties: false,
    properties: { op: { type: 'string', const: 'remove_slot', required: true }, slot_key: { type: 'string', required: true } }
} as const satisfies ValueSchemaSpec;
const upsertLedger = {
    type: 'object', additionalProperties: false,
    properties: {
        op: { type: 'string', const: 'upsert_ledger', required: true },
        entries: { type: 'object', additionalProperties: true, required: true, description: '账本键到字符串或数字的映射' }
    }
} as const satisfies ValueSchemaSpec;
const trimBuffer = {
    type: 'object', additionalProperties: false,
    properties: { op: { type: 'string', const: 'trim_buffer', required: true }, max_entries: { type: 'integer', required: true } }
} as const satisfies ValueSchemaSpec;

/** 对模型展开补丁结构，语义锁与条目约束仍由现有运行时 Schema 校验。 */
export const ENTITY_PATCH_TOOL_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
        entity_id: { type: 'string', required: true, description: 'char_* 或 item_* 的稳定实体 ID' },
        canonical_name: { type: 'string', description: '仅新建实体必填中文标准名；既有实体沿用原名' },
        last_seen_ch: { type: 'integer' },
        add_unique_aliases: { type: 'array', items: { type: 'string' } },
        add_contextual_titles: { type: 'array', items: { type: 'string' } },
        add_historical_anchors: { type: 'array', items: { type: 'string' } },
        innate_locks_ops: { type: 'array', items: { oneOf: [append, removeSlot] } },
        acquired_state_ops: { type: 'array', items: { oneOf: [append, upsertSlot, removeSlot, upsertLedger] } },
        trajectory_ops: { type: 'array', items: append },
        buffer_ops: { type: 'array', items: { oneOf: [append, upsertSlot, trimBuffer] } }
    }
} as const satisfies ValueSchemaSpec;

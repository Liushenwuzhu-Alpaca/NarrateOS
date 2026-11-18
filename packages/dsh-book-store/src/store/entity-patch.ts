import {
    DEFAULT_SECTION_HEADINGS,
    assertEntryTagsSafe,
    assertSafeEntityTagValue,
    assertSafeLedgerValue,
    inferSlotKey
} from './entity-parser.js';
import {
    EntityEntry,
    EntityEntryInput,
    EntityMetadataSchema,
    EntityPatch,
    EntityProfile,
    InnateLockViolationError
} from './schemas.js';

export const ENTITY_ID_RE = /^(?:char|item)_[a-zA-Z0-9_]+$/;
const CHINESE_CHAR_RE = /[\u4e00-\u9fff]/;

function toEntityEntry(input: EntityEntryInput): EntityEntry {
    const entry: EntityEntry = {
        text: input.text,
        continuationLines: input.continuationLines ? [...input.continuationLines] : []
    };
    if (input.storyDay !== undefined) entry.storyDay = input.storyDay;
    if (input.chapter !== undefined) entry.chapter = input.chapter;
    if (input.visibility !== undefined) entry.visibility = input.visibility;
    if (input.rawInvalidVisibility !== undefined) entry.rawInvalidVisibility = input.rawInvalidVisibility;
    if (input.owner !== undefined) entry.owner = input.owner;
    if (input.status !== undefined) entry.status = input.status;
    if (input.slotKey !== undefined) entry.slotKey = input.slotKey;
    if (input.extraTags !== undefined) entry.extraTags = { ...input.extraTags };
    if (input.isNumericLedger !== undefined) entry.isNumericLedger = input.isNumericLedger;
    if (input.ledger !== undefined) entry.ledger = { ...input.ledger };
    return entry;
}

function cloneStoredEntry(entry: EntityEntry): EntityEntry {
    const cloned: EntityEntry = {
        text: entry.text,
        continuationLines: [...entry.continuationLines]
    };
    if (entry.storyDay !== undefined) cloned.storyDay = entry.storyDay;
    if (entry.chapter !== undefined) cloned.chapter = entry.chapter;
    if (entry.visibility !== undefined) cloned.visibility = entry.visibility;
    if (entry.rawInvalidVisibility !== undefined) cloned.rawInvalidVisibility = entry.rawInvalidVisibility;
    if (entry.owner !== undefined) cloned.owner = entry.owner;
    if (entry.status !== undefined) cloned.status = entry.status;
    if (entry.slotKey !== undefined) cloned.slotKey = entry.slotKey;
    if (entry.extraTags !== undefined) cloned.extraTags = { ...entry.extraTags };
    if (entry.isNumericLedger !== undefined) cloned.isNumericLedger = entry.isNumericLedger;
    if (entry.ledger !== undefined) cloned.ledger = { ...entry.ledger };
    return cloned;
}

function mergeUniqueStrings(existing: string[], additions?: string[]): string[] {
    if (!additions || additions.length === 0) return existing;
    const seen = new Set(existing);
    const result = [...existing];
    for (const item of additions) {
        if (!seen.has(item)) {
            seen.add(item);
            result.push(item);
        }
    }
    return result;
}

function formatNumericLedgerText(ledger: Record<string, string>): string {
    return Object.entries(ledger)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ');
}

function upsertSlotInSection(
    section: EntityEntry[],
    slotKey: string,
    entryInput: EntityEntryInput
): void {
    assertSafeEntityTagValue('slotKey', slotKey);
    const nextEntry = toEntityEntry(entryInput);
    nextEntry.slotKey = nextEntry.slotKey || slotKey;
    assertEntryTagsSafe(nextEntry);
    const idx = section.findIndex((e) => inferSlotKey(e) === slotKey);
    if (idx >= 0) {
        section[idx] = nextEntry;
    } else {
        section.push(nextEntry);
    }
}

/**
 * 将单个 EntityPatch 合并至现有或新建的四段式实体档案。
 * - 新建实体强校验中文 canonical_name（ISS-008）；
 * - 新建或显式修改第 1 区 Innate Locks 时拦截 OMNISCIENT_SECRET（Q7，不误拦存量卡）；
 * - upsert_slot 回填 op.slot_key（ISS-005），upsert_ledger 同步刷新 text（ISS-024）；
 * - 校验 slotKey、owner 与数值账本键值不含分隔符（ISS-009）。
 */
export function mergeEntityProfilePatch(
    existing: EntityProfile | null,
    patch: EntityPatch,
    allowInnateMutation: boolean
): EntityProfile {
    if (!ENTITY_ID_RE.test(patch.entity_id)) {
        throw new Error(`非法的 entity_id 格式: ${patch.entity_id}`);
    }

    if (existing) {
        if (patch.canonical_name !== undefined && patch.canonical_name !== existing.metadata.canonical_name) {
            if (!allowInnateMutation) {
                throw new InnateLockViolationError(
                    patch.entity_id,
                    `禁止在未授权情况下篡改实体 canonical_name (${existing.metadata.canonical_name} -> ${patch.canonical_name})`
                );
            }
        }
        if (patch.innate_locks_ops && patch.innate_locks_ops.length > 0 && !allowInnateMutation) {
            throw new InnateLockViolationError(
                patch.entity_id,
                `禁止在未授权情况下修改实体 ${patch.entity_id} 的 1. Innate Locks`
            );
        }
    } else if (
        !patch.canonical_name ||
        patch.canonical_name.trim().length === 0 ||
        !CHINESE_CHAR_RE.test(patch.canonical_name)
    ) {
        throw new Error(`新建实体 ${patch.entity_id} 必须提供包含中文字符的 canonical_name`);
    }

    const profile: EntityProfile = existing
        ? {
              metadata: {
                  ...existing.metadata,
                  unique_aliases: [...existing.metadata.unique_aliases],
                  contextual_titles: [...existing.metadata.contextual_titles],
                  historical_anchors: [...existing.metadata.historical_anchors]
              },
              sectionHeadings: { ...existing.sectionHeadings },
              innateLocks: existing.innateLocks.map(cloneStoredEntry),
              acquiredState: existing.acquiredState.map(cloneStoredEntry),
              irreversibleTrajectory: existing.irreversibleTrajectory.map(cloneStoredEntry),
              recentBuffer: existing.recentBuffer.map(cloneStoredEntry)
          }
        : {
              metadata: {
                  entity_id: patch.entity_id,
                  canonical_name: patch.canonical_name!,
                  unique_aliases: [],
                  contextual_titles: [],
                  historical_anchors: [],
                  last_seen_ch: patch.last_seen_ch ?? 0
              },
              sectionHeadings: { ...DEFAULT_SECTION_HEADINGS },
              innateLocks: [],
              acquiredState: [],
              irreversibleTrajectory: [],
              recentBuffer: []
          };

    if (patch.canonical_name !== undefined && (allowInnateMutation || !existing)) {
        profile.metadata.canonical_name = patch.canonical_name;
    }
    if (patch.last_seen_ch !== undefined) {
        profile.metadata.last_seen_ch = Math.max(profile.metadata.last_seen_ch, patch.last_seen_ch);
    }
    profile.metadata.unique_aliases = mergeUniqueStrings(profile.metadata.unique_aliases, patch.add_unique_aliases);
    profile.metadata.contextual_titles = mergeUniqueStrings(
        profile.metadata.contextual_titles,
        patch.add_contextual_titles
    );
    profile.metadata.historical_anchors = mergeUniqueStrings(
        profile.metadata.historical_anchors,
        patch.add_historical_anchors
    );

    if (patch.innate_locks_ops) {
        for (const op of patch.innate_locks_ops) {
            if (op.op === 'append') {
                const visUpper = (op.entry.visibility ?? op.entry.rawInvalidVisibility)?.toUpperCase();
                if (visUpper === 'OMNISCIENT_SECRET') {
                    throw new InnateLockViolationError(
                        patch.entity_id,
                        `第 1 区 Innate Locks 严禁写入 OMNISCIENT_SECRET（${patch.entity_id}），可揭晓底牌请放入第 2 区 Acquired State 并绑定 slot_key`
                    );
                }
                const nextEntry = toEntityEntry(op.entry);
                assertEntryTagsSafe(nextEntry);
                profile.innateLocks.push(nextEntry);
            } else if (op.op === 'remove_slot') {
                assertSafeEntityTagValue('slotKey', op.slot_key);
                profile.innateLocks = profile.innateLocks.filter((e) => inferSlotKey(e) !== op.slot_key);
            }
        }
    }

    if (patch.acquired_state_ops) {
        for (const op of patch.acquired_state_ops) {
            if (op.op === 'upsert_slot') {
                upsertSlotInSection(profile.acquiredState, op.slot_key, op.entry);
            } else if (op.op === 'remove_slot') {
                assertSafeEntityTagValue('slotKey', op.slot_key);
                profile.acquiredState = profile.acquiredState.filter((e) => inferSlotKey(e) !== op.slot_key);
            } else if (op.op === 'upsert_ledger') {
                const ledgerIdx = profile.acquiredState.findIndex((e) => e.isNumericLedger);
                if (ledgerIdx >= 0) {
                    const existingLedger = profile.acquiredState[ledgerIdx]!;
                    const mergedLedger: Record<string, string> = { ...(existingLedger.ledger ?? {}) };
                    for (const [k, v] of Object.entries(op.entries)) {
                        assertSafeEntityTagValue('ledger_key', k);
                        const strVal = String(v);
                        assertSafeLedgerValue(strVal);
                        mergedLedger[k] = strVal;
                    }
                    existingLedger.ledger = mergedLedger;
                    existingLedger.text = formatNumericLedgerText(mergedLedger);
                } else {
                    const newLedger: Record<string, string> = {};
                    for (const [k, v] of Object.entries(op.entries)) {
                        assertSafeEntityTagValue('ledger_key', k);
                        const strVal = String(v);
                        assertSafeLedgerValue(strVal);
                        newLedger[k] = strVal;
                    }
                    profile.acquiredState.push({
                        isNumericLedger: true,
                        ledger: newLedger,
                        text: formatNumericLedgerText(newLedger),
                        continuationLines: []
                    });
                }
            } else if (op.op === 'append') {
                const nextEntry = toEntityEntry(op.entry);
                assertEntryTagsSafe(nextEntry);
                profile.acquiredState.push(nextEntry);
            }
        }
    }

    if (patch.trajectory_ops) {
        for (const op of patch.trajectory_ops) {
            if (op.op === 'append') {
                const nextEntry = toEntityEntry(op.entry);
                assertEntryTagsSafe(nextEntry);
                profile.irreversibleTrajectory.push(nextEntry);
            }
        }
    }

    if (patch.buffer_ops) {
        for (const op of patch.buffer_ops) {
            if (op.op === 'upsert_slot') {
                upsertSlotInSection(profile.recentBuffer, op.slot_key, op.entry);
            } else if (op.op === 'append') {
                const nextEntry = toEntityEntry(op.entry);
                assertEntryTagsSafe(nextEntry);
                profile.recentBuffer.push(nextEntry);
            } else if (op.op === 'trim_buffer') {
                const timedIndices: number[] = [];
                profile.recentBuffer.forEach((entry, idx) => {
                    if (entry.storyDay !== undefined || entry.chapter !== undefined) {
                        timedIndices.push(idx);
                    }
                });
                if (timedIndices.length > op.max_entries) {
                    const dropCount = timedIndices.length - op.max_entries;
                    const dropSet = new Set(timedIndices.slice(0, dropCount));
                    profile.recentBuffer = profile.recentBuffer.filter((_, idx) => !dropSet.has(idx));
                }
            }
        }
    }

    profile.metadata = EntityMetadataSchema.parse(profile.metadata);
    return profile;
}

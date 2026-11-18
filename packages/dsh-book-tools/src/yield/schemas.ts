import { z } from 'zod';
import { EntryVisibilitySchema, PlannerOutlineSchema } from '@narrateos/dsh-book-store';

export { PlannerOutlineSchema };

/** 开书编译实体档案 Schema */
export const CompiledEntitySchema = z.object({
    entityId: z.string().regex(/^(char|item)_[a-zA-Z0-9_]+$/),
    canonicalName: z.string().min(1),
    uniqueAliases: z.array(z.string()).default([]),
    contextualTitles: z.array(z.string()).default([]),
    innateLocks: z
        .array(
            z.object({
                visibility: EntryVisibilitySchema.default('PUBLIC'),
                text: z.string().min(1)
            })
        )
        .default([]),
    acquiredState: z
        .array(
            z.object({
                storyDay: z.number().int().default(0),
                visibility: EntryVisibilitySchema.default('PUBLIC'),
                slotKey: z.string().optional(),
                text: z.string().min(1)
            })
        )
        .default([]),
    irreversibleTrajectory: z
        .array(
            z.object({
                storyDay: z.number().int().default(0),
                text: z.string().min(1)
            })
        )
        .default([]),
    recentBuffer: z
        .array(
            z.object({
                storyDay: z.number().int().optional(),
                text: z.string().min(1)
            })
        )
        .default([])
});
export type CompiledEntity = z.infer<typeof CompiledEntitySchema>;

/** 开书编译世界书词条 Schema */
export const CompiledLoreEntrySchema = z.object({
    id: z.string().regex(/^lore_[a-zA-Z0-9_]+$/),
    title: z.string().min(1),
    summary: z.string().min(1),
    content: z.string().min(1)
});
export type CompiledLoreEntry = z.infer<typeof CompiledLoreEntrySchema>;

const CHINESE_CHAR_RE = /[\u4e00-\u9fa5]/;

/** 判断字符串是否包含至少一个中文字符 */
export function hasChineseCharacter(value: string): boolean {
    return CHINESE_CHAR_RE.test(value);
}

/** 统计 world/open_threads.md 中处于活跃状态的伏笔条目数 */
export function countActiveOpenThreads(markdown: string): number {
    const normalized = markdown.replace(/\r\n/g, '\n');
    let inArchiveSection = false;
    let activeCount = 0;

    for (const rawLine of normalized.split('\n')) {
        const trimmed = rawLine.trim();
        if (/^##\s+.*(已回收|已解决|已兑现|Resolved|Archive)/i.test(trimmed)) {
            inArchiveSection = true;
            continue;
        }
        if (/^##\s+/.test(trimmed)) {
            inArchiveSection = false;
            continue;
        }
        if (!trimmed.startsWith('- ')) {
            continue;
        }
        if (inArchiveSection) {
            continue;
        }
        if (/\bstatus:\s*RESOLVED\b/i.test(trimmed) || /\[RESOLVED\]/i.test(trimmed)) {
            continue;
        }
        activeCount += 1;
    }

    return activeCount;
}

/** 从 open_threads.md 活跃条目中提取引用的实体 ID (char_* / item_*) */
export function extractActiveThreadEntityRefs(markdown: string): Set<string> {
    const refs = new Set<string>();
    const normalized = markdown.replace(/\r\n/g, '\n');
    let inArchiveSection = false;

    for (const rawLine of normalized.split('\n')) {
        const trimmed = rawLine.trim();
        if (/^##\s+.*(已回收|已解决|已兑现|Resolved|Archive)/i.test(trimmed)) {
            inArchiveSection = true;
            continue;
        }
        if (/^##\s+/.test(trimmed)) {
            inArchiveSection = false;
            continue;
        }
        if (!trimmed.startsWith('- ') || inArchiveSection) {
            continue;
        }
        if (/\bstatus:\s*RESOLVED\b/i.test(trimmed) || /\[RESOLVED\]/i.test(trimmed)) {
            continue;
        }
        for (const match of trimmed.matchAll(/\b(char_[a-zA-Z0-9_]+|item_[a-zA-Z0-9_]+)\b/g)) {
            if (match[1]) {
                refs.add(match[1]);
            }
        }
    }

    return refs;
}

/** Step 1: Librarian 召回切片 Schema */
export const LibrarianRecallSliceSchema = z.object({
    entity_id: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    chapter_number: z.number().int().positive().optional(),
    snippet: z.string().min(1)
});
export type LibrarianRecallSlice = z.infer<typeof LibrarianRecallSliceSchema>;

/** Step 1: Librarian 检索选页结构化输出 Schema */
export const LibrarianOutputSchema = z.object({
    selected_entity_ids: z.array(z.string().min(1)).default([]),
    recall_queries: z
        .array(
            z.object({
                entity_id: z.string().min(1),
                extra_keywords: z.array(z.string()).default([]),
                focus_chapters: z.array(z.number().int().positive()).optional()
            })
        )
        .default([]),
    recall_slices: z.array(LibrarianRecallSliceSchema).default([]),
    selected_lore_files: z.array(z.string().min(1)).default([]),
    wakeup_entity_ids: z.array(z.string().min(1)).default([])
});
export type LibrarianOutput = z.infer<typeof LibrarianOutputSchema>;

/** Step 5: Fact Checker 审校问题 Schema */
export const FactCheckIssueSchema = z.object({
    severity: z.enum(['LOCAL_PATCH', 'MULTI_REWRITE', 'PLAN_CONFLICT']),
    paragraph_index: z.number().int().nonnegative().optional(),
    paragraph_indices: z.array(z.number().int().nonnegative()).optional(),
    description: z.string().min(1),
    quote_draft: z.string().default(''),
    quote_source: z.string().default(''),
    source_ref: z.string().optional()
});
export type FactCheckIssue = z.infer<typeof FactCheckIssueSchema>;

/** Step 5: Fact Checker 审校输出 Schema */
export const FactCheckOutputSchema = z.object({
    passed: z.boolean(),
    issues: z.array(FactCheckIssueSchema).default([])
});
export type FactCheckOutput = z.infer<typeof FactCheckOutputSchema>;

/** Step 6: Extractor 实体条目输入 Schema */
export const EntityEntryInputSchema = z.object({
    storyDay: z.number().int().optional(),
    chapter: z.number().int().nonnegative().optional(),
    visibility: z.enum(['SELF_ONLY', 'OMNISCIENT_SECRET', 'PUBLIC', 'READER_KNOWN']).optional(),
    owner: z.string().optional(),
    status: z.enum(['ACTIVE', 'WARPED']).optional(),
    slotKey: z.string().optional(),
    extraTags: z.record(z.string(), z.string()).optional(),
    isNumericLedger: z.boolean().optional(),
    ledger: z.record(z.string(), z.string()).optional(),
    text: z.string(),
    continuationLines: z.array(z.string()).optional()
});

/** Step 6: 实体增量补丁 Schema */
export const EntityPatchSchema = z.object({
    entity_id: z.string().regex(/^(char|item)_[a-zA-Z0-9_]+$/),
    last_seen_ch: z.number().int().nonnegative().optional(),
    canonical_name: z.string().min(1).optional(),
    add_unique_aliases: z.array(z.string()).optional(),
    add_contextual_titles: z.array(z.string()).optional(),
    add_historical_anchors: z.array(z.string()).optional(),
    innate_locks_ops: z
        .array(
            z.union([
                z.object({ op: z.literal('append'), entry: EntityEntryInputSchema }),
                z.object({ op: z.literal('remove_slot'), slot_key: z.string() })
            ])
        )
        .optional(),
    acquired_state_ops: z
        .array(
            z.union([
                z.object({ op: z.literal('upsert_slot'), slot_key: z.string(), entry: EntityEntryInputSchema }),
                z.object({ op: z.literal('append'), entry: EntityEntryInputSchema }),
                z.object({ op: z.literal('remove_slot'), slot_key: z.string() }),
                z.object({
                    op: z.literal('upsert_ledger'),
                    entries: z.record(z.string(), z.union([z.string(), z.number()]))
                })
            ])
        )
        .optional(),
    trajectory_ops: z
        .array(z.object({ op: z.literal('append'), entry: EntityEntryInputSchema }))
        .optional(),
    buffer_ops: z
        .array(
            z.union([
                z.object({ op: z.literal('upsert_slot'), slot_key: z.string(), entry: EntityEntryInputSchema }),
                z.object({ op: z.literal('append'), entry: EntityEntryInputSchema }),
                z.object({ op: z.literal('trim_buffer'), max_entries: z.number().int().positive() })
            ])
        )
        .optional()
});

/** Step 6: Extractor 结构化抽取输出 Schema */
export const ExtractorOutputSchema = z.object({
    entity_patches: z.array(EntityPatchSchema).default([]),
    story_day_delta: z.number().int().min(0).default(0),
    chapter_summary: z.string().min(1),
    world_summary_markdown: z.string().optional(),
    next_chapter_options: z.array(z.string().min(1)).default([])
});
export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;

/** Dreamer 提交输出 Schema */
export const DreamCommitInputSchema = z.object({
    summary: z.string().min(1),
    chapter_number: z.number().int().nonnegative().optional(),
    accumulated_words: z.number().int().nonnegative().default(0),
    spotlight_triggers: z
        .array(
            z.object({
                entity_id: z.string().min(1),
                reason: z.string().min(1),
                suggested_mode: z.enum(['MAINLINE', 'PARALLEL']).default('MAINLINE')
            })
        )
        .default([])
});
export type DreamCommitInput = z.infer<typeof DreamCommitInputSchema>;

/** Dreamer 终态提交记录结构 */
export interface DreamCommitRecord {
    summary: string;
    chapterNumber: number;
    committedPaths: string[];
    spotlightTriggerCount: number;
}

/** Boot Compiler 结构化编译输出 Schema (yield_boot_bundle) */
export const BootBundleOutputSchema = z.object({
    world_summary: z.string().min(1),
    static_base_and_voice: z.string().min(1),
    current_arc_envelope: z.string().min(1),
    stage_ceiling: z.string().min(1),
    opening_sequence_beats: z
        .array(
            z.object({
                beat_label: z.string().min(1).optional(),
                craft_focus: z.string().min(1),
                clue_budget: z.string().min(1),
                completion_sign: z.string().min(1)
            })
        )
        .min(3)
        .max(5),
    unrevealed_pivots: z.array(z.string().min(1)).default([]),
    l0_sagas_markdown: z
        .string()
        .min(1)
        .default('# L0 纪元折叠总表\n\n<!-- 每满 10 卷封存一纪元 -->'),
    l1_volumes_markdown: z.string().min(1),
    voice_samples: z
        .array(
            z.object({
                tag: z.string().min(1),
                sample: z.string().min(1)
            })
        )
        .default([]),
    open_threads: z
        .array(
            z.object({
                thread_id: z.string().min(1),
                title: z.string().min(1),
                wakeup_condition: z.string().min(1)
            })
        )
        .default([]),
    future_horizon_events: z
        .array(
            z.object({
                event_id: z.string().min(1),
                story_day: z.number().int().positive(),
                premise: z.string().min(1),
                description: z.string().min(1)
            })
        )
        .default([]),
    lore_entries: z.array(CompiledLoreEntrySchema).default([]),
    entities: z.array(CompiledEntitySchema).min(1),
    contract_conflicts: z.array(z.string().min(1)).default([])
});
export type BootBundleOutput = z.infer<typeof BootBundleOutputSchema>;

/** Patch 局部修补终态提交输入 Schema (yield_patched_draft) */
export const YieldPatchedDraftInputSchema = z.object({
    summary: z.string().optional()
});
export type YieldPatchedDraftInput = z.infer<typeof YieldPatchedDraftInputSchema>;

/** Patch 局部修补终态交付结果 */
export interface YieldPatchedDraftResult {
    patchedProse: string;
    editCount: number;
    summary?: string | undefined;
}

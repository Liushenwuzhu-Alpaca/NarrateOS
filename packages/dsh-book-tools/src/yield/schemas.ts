import { z } from 'zod';
import {
    assertSafeEntityTagValue,
    assertSafeLedgerValue,
    EntryVisibilitySchema,
    PlannerOutlineSchema,
    VoiceSampleSourceSchema
} from '@narrateos/dsh-book-store';
import { collectEntityRefs, extractActiveOpenThreadLines } from './shared.js';

export { PlannerOutlineSchema };

/** 开书声纹样本 Schema */
export const BootVoiceSampleSchema = z.object({
    tag: z.string().min(1),
    sample: z.string().min(1),
    source: VoiceSampleSourceSchema.optional()
});
export type BootVoiceSample = z.infer<typeof BootVoiceSampleSchema>;

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
                owner: z.string().optional(),
                text: z.string().min(1)
            })
        )
        .default([]),
    irreversibleTrajectory: z
        .array(
            z.object({
                storyDay: z.number().int().default(0),
                visibility: EntryVisibilitySchema.optional(),
                owner: z.string().optional(),
                text: z.string().min(1)
            })
        )
        .default([]),
    recentBuffer: z
        .array(
            z.object({
                storyDay: z.number().int().optional(),
                visibility: EntryVisibilitySchema.optional(),
                owner: z.string().optional(),
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

const CHINESE_CHAR_RE = /[\u4e00-\u9fff]/;

/** 判断字符串是否包含至少一个中文字符 */
export function hasChineseCharacter(value: string): boolean {
    return CHINESE_CHAR_RE.test(value);
}

/** 统计 world/open_threads.md 中处于活跃状态的伏笔条目数 */
export function countActiveOpenThreads(markdown: string): number {
    return extractActiveOpenThreadLines(markdown).length;
}

/** 从 open_threads.md 活跃条目中提取引用的实体 ID (char_* / item_*) */
export function extractActiveThreadEntityRefs(markdown: string): Set<string> {
    const refs = new Set<string>();
    for (const line of extractActiveOpenThreadLines(markdown)) {
        for (const entityId of collectEntityRefs(line)) {
            refs.add(entityId);
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
export const EntityEntryInputSchema = z
    .object({
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
    })
    .superRefine((entry, ctx) => {
        const checks: Array<{ label: string; value: string; isLedgerValue?: boolean }> = [];
        if (entry.slotKey !== undefined) {
            checks.push({ label: 'slotKey', value: entry.slotKey });
        }
        if (entry.owner !== undefined) {
            checks.push({ label: 'owner', value: entry.owner });
        }
        if (entry.extraTags !== undefined) {
            for (const [k, v] of Object.entries(entry.extraTags)) {
                checks.push({ label: 'extraTag_key', value: k });
                checks.push({ label: 'extraTag_value', value: v });
            }
        }
        if (entry.ledger !== undefined) {
            for (const [k, v] of Object.entries(entry.ledger)) {
                checks.push({ label: 'ledger_key', value: k });
                checks.push({ label: 'ledger_value', value: v, isLedgerValue: true });
            }
        }
        for (const item of checks) {
            try {
                if (item.isLedgerValue) {
                    assertSafeLedgerValue(item.value);
                } else {
                    assertSafeEntityTagValue(item.label, item.value);
                }
            } catch (err: unknown) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: err instanceof Error ? err.message : String(err)
                });
            }
        }
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

const ExtractorOutputRawSchema = z.object({
    entity_patches: z.array(EntityPatchSchema).default([]),
    story_day_delta: z.number().int().min(0).default(0),
    plot_summary: z.string().optional(),
    chapter_summary: z.string().optional(),
    prose_anchors: z.array(z.string().min(1)).max(8).default([]),
    appeared_entity_ids: z.array(z.string().min(1)).default([]),
    world_summary_markdown: z.string().optional().transform((text) => text?.trim() ? text : undefined),
    next_chapter_options: z.array(z.string().min(1)).default([])
});

/** Step 6: Extractor 结构化抽取输出 Schema（双轨字段 + 向后兼容 chapter_summary 双向回填） */
export const ExtractorOutputSchema = ExtractorOutputRawSchema.superRefine((data, ctx) => {
    const plot = data.plot_summary?.trim() ?? '';
    const chapter = data.chapter_summary?.trim() ?? '';
    if (plot.length === 0 && chapter.length === 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['plot_summary'],
            message: 'plot_summary 与 chapter_summary 至少需提供一个非空主干剧情摘要'
        });
    }
}).transform((data) => {
    const summary = data.plot_summary?.trim() || data.chapter_summary?.trim() || '';
    return {
        ...data,
        world_summary_markdown: data.world_summary_markdown?.trim() ? data.world_summary_markdown : undefined,
        plot_summary: summary,
        chapter_summary: data.chapter_summary?.trim() || summary
    };
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
const SuccessfulBootBundleSchema = z.object({
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
    voice_samples: z.array(BootVoiceSampleSchema).default([]),
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
export const BootBundleOutputSchema = z.union([
    z.object({ contract_conflicts: z.array(z.string().trim().min(1)).nonempty() }),
    SuccessfulBootBundleSchema
]);
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

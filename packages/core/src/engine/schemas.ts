import { z } from 'zod';
import type { TokenUsage } from '../ports/llm.js';
import type { GateViolation, TelemetryMetrics } from '../gate/types.js';
import type { DirtyChapter, TimelineMode } from '../store/schemas.js';

/** 细纲级物理悖论异常（触发退回 Planner 改纲 v2） */
export class PlanConflictError extends Error {
    readonly chapterNumber: number;
    readonly reason: string;

    constructor(chapterNumber: number, reason: string) {
        super(`第 ${chapterNumber} 章细纲存在物理/因果悖论，需重规划: ${reason}`);
        this.name = 'PlanConflictError';
        this.chapterNumber = chapterNumber;
        this.reason = reason;
    }
}

/** 安全挂起诊断快照 (.ops/safe_halt.json) */
export interface SafeHaltSnapshot {
    status: 'SAFE_HALT';
    chapterNumber: number;
    reason: string;
    replanCount: number;
    rewriteCount: number;
    patchRounds: number;
    issues: FactCheckIssue[];
    gateViolations: GateViolation[];
    timestamp: string;
}

/** 审校重试耗尽或 v2 仍失败后的安全挂起异常 */
export class SafeHaltError extends Error {
    readonly snapshot: SafeHaltSnapshot;

    constructor(snapshot: SafeHaltSnapshot) {
        super(`第 ${snapshot.chapterNumber} 章触发 SAFE_HALT 安全挂起: ${snapshot.reason}`);
        this.name = 'SafeHaltError';
        this.snapshot = snapshot;
    }
}

/** Step 1: Librarian 检索选页结构化输出 Schema */
export const LibrarianOutputSchema = z.object({
    selected_entity_ids: z.array(z.string()).default([]),
    recall_queries: z
        .array(
            z.object({
                entity_id: z.string(),
                extra_keywords: z.array(z.string()).default([]),
                focus_chapters: z.array(z.number().int().positive()).optional()
            })
        )
        .default([]),
    selected_lore_files: z.array(z.string()).default([])
});

export type LibrarianOutput = z.infer<typeof LibrarianOutputSchema>;

/** Step 2: Planner 结构化细纲输出 Schema */
export const PlannerSceneSchema = z.object({
    scene_index: z.number().int().positive(),
    location: z.string().min(1),
    summary: z.string().min(1),
    is_spotlight: z.boolean().default(false)
});

export const PlannerOutlineSchema = z.object({
    chapter_title: z.string().min(1),
    target_word_count: z.number().int().positive(),
    focus_cast: z.array(z.string()).min(1),
    background_cast: z.array(z.string()).default([]),
    ending_beat: z.enum(['HOOK', 'AFTERGLOW', 'CLOSURE']).default('HOOK'),
    director_rationale: z.string().default(''),
    chapter_turn: z.string().min(1),
    scene_plan: z.array(PlannerSceneSchema).min(1),
    outline_text: z.string().min(1),
    preferred_voice_tag: z.string().optional()
});

export type PlannerOutline = z.infer<typeof PlannerOutlineSchema>;

/** Step 5: Fact Checker 审校输出 Schema */
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
    entity_id: z.string().min(1),
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

/** Sync: 最新章手改差异定性 Schema */
export const SyncDiffAnalysisSchema = z.object({
    is_prose_polish_only: z.boolean(),
    reason: z.string().min(1),
    affected_entity_ids: z.array(z.string()).default([])
});

export type SyncDiffAnalysis = z.infer<typeof SyncDiffAnalysisSchema>;

/** Sync: 历史旧章手改下游只读冲突扫描 Schema */
export const DownstreamConflictItemSchema = z.object({
    chapter_number: z.number().int().positive(),
    line_number: z.number().int().positive().optional(),
    quote: z.string().default(''),
    description: z.string().min(1)
});

export const DownstreamScanOutputSchema = z.object({
    conflicts: z.array(DownstreamConflictItemSchema).default([])
});

export type DownstreamConflictItem = z.infer<typeof DownstreamConflictItemSchema>;
export type DownstreamScanOutput = z.infer<typeof DownstreamScanOutputSchema>;

/** 引擎单章运行阶段名 */
export type EngineStageName =
    | 'WAL_RECOVERY'
    | 'LIBRARIAN'
    | 'PLANNER'
    | 'WRITER'
    | 'PROSE_GATE'
    | 'FACT_CHECKER'
    | 'LOCAL_PATCH'
    | 'REWRITE'
    | 'REPLAN'
    | 'EXTRACTOR'
    | 'COMMITTED'
    | 'SAFE_HALT';

/** 引擎阶段进度事件 */
export interface EngineProgressEvent {
    stage: EngineStageName;
    chapterNumber: number;
    message: string;
    timestamp: string;
}

/** stepChapter 调用参数 */
export interface StepChapterOptions {
    chapterNumber?: number | undefined;
    chapterGoal: string;
    timelineMode?: TimelineMode | undefined;
    targetDay?: number | undefined;
    povCharIds?: string[] | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((event: EngineProgressEvent) => void) | undefined;
}

/** 单章执行结果 */
export interface StepChapterResult {
    status: 'COMMITTED';
    chapterNumber: number;
    manuscriptPath: string;
    featCommitSha: string;
    stateCommitSha: string;
    recoveredFromPhase?: 'FEAT_COMMITTED' | undefined;
    outline: PlannerOutline | null;
    replanCount: number;
    rewriteCount: number;
    patchRounds: number;
    telemetry: TelemetryMetrics;
    totalUsage: TokenUsage;
    updatedEntities: string[];
    nextChapterOptions: string[];
}

/** syncManuscripts 调用参数 */
export interface SyncManuscriptsOptions {
    signal?: AbortSignal | undefined;
}

/** 下游只读连续性冲突报告项 */
export interface DownstreamConflictReport {
    chapterNumber: number;
    relativePath: string;
    lineNumber: number | null;
    quote: string;
    description: string;
}

/** syncManuscripts 执行结果 */
export interface SyncManuscriptsResult {
    status: 'CLEAN' | 'PROSE_POLISH_SYNCED' | 'STATE_SYNCED' | 'DOWNSTREAM_CONFLICTS_FOUND' | 'HISTORY_SYNCED_NO_CONFLICT';
    dirtyChapters: DirtyChapter[];
    updatedEntities: string[];
    downstreamConflicts: DownstreamConflictReport[];
    totalUsage: TokenUsage;
}

/** advanceVolume 调用参数 */
export interface AdvanceVolumeOptions {
    companionEntityIds?: string[] | undefined;
    completeBook?: boolean | undefined;
    signal?: AbortSignal | undefined;
}

/** advanceVolume 执行结果 */
export interface AdvanceVolumeResult {
    sealedVolume: number;
    nextVolume: number;
    tagName: string;
    archivedEntities: string[];
    completedBook: boolean;
    commitSha: string;
}

/** 换卷 Step 1: 旧卷封存摘要输出 Schema */
export const VolumeSealOutputSchema = z.object({
    volume_summary: z.string().min(1),
    story_day_span: z.string().min(1)
});

/** 换卷 Step 3: 风格修订合并输出 Schema */
export const StyleMergeOutputSchema = z.object({
    merged_markdown: z.string().min(1)
});

/** 换卷 Step 4: 新卷包络与未来惯性输出 Schema */
export const NextVolumeEnvelopeOutputSchema = z.object({
    current_arc_envelope: z.string().min(1),
    future_horizon: z.string().min(1)
});

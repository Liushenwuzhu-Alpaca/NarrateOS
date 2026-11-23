import { z } from 'zod';

/** Step 2: Planner 结构化细纲输出 Schema（store 层持有：随正文 feat 持久化的规划快照契约） */
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
    preferred_voice_tag: z.string().optional(),
    impacted_horizon_events: z.array(z.string().min(1)).default([]),
    target_beat_label: z.string().optional()
});

export type PlannerOutline = z.infer<typeof PlannerOutlineSchema>;

/** 章节细纲快照读取结果：missing=旧章未留存，error=快照损坏/非法（正文不受影响） */
export interface ChapterOutlineSnapshot {
    outlineText: string | null;
    status: 'available' | 'missing' | 'error';
}

/** 叙述人称与主观度基线 */
export const NarrationSubjectivitySchema = z.enum(['objective_third', 'subjective_first']);
export type NarrationSubjectivity = z.infer<typeof NarrationSubjectivitySchema>;

/** 单工种模型池档位覆盖（第一层：strong -> strong_creative, weak -> fast_retrieval） */
export const RoleTierOverrideSchema = z.enum(['strong', 'weak']);
export type RoleTierOverride = z.infer<typeof RoleTierOverrideSchema>;

/** 单工种推理强度覆盖 */
export const RoleReasoningEffortSchema = z.enum(['off', 'low', 'medium', 'high', 'max']);
export type RoleReasoningEffort = z.infer<typeof RoleReasoningEffortSchema>;

/** 单工种双层模型配置覆盖项 */
export const RoleModelOverrideSchema = z.object({
    tier: RoleTierOverrideSchema.optional(),
    model: z.string().min(1).optional(),
    reasoning_effort: RoleReasoningEffortSchema.optional()
});
export type RoleModelOverride = z.infer<typeof RoleModelOverrideSchema>;

/** 按工种 ID 映射的双层模型路由覆盖表 */
export const RoleRoutingSchema = z.record(z.string(), RoleModelOverrideSchema);
export type RoleRouting = z.infer<typeof RoleRoutingSchema>;

/** 开篇声纹与首章校准可配变量 */
export const BookOpeningConfigSchema = z.object({
    voice_seed_mode: z.enum(['hybrid_rolling', 'boot_only', 'harvest_ch1', 'manual_only']).default('hybrid_rolling'),
    target_voice_pool_size: z.number().int().positive().default(4),
    voice_rolling_warmup_chapters: z.number().int().nonnegative().default(3),
    pause_after_chapter_1: z.boolean().default(false),
    first_chapter_max_beats: z.number().int().positive().default(1)
});

/** 检索与索引可配变量 */
export const BookRetrievalConfigSchema = z.object({
    max_slices_per_entity: z.number().int().positive().default(3),
    max_slices_per_chapter_pack: z.number().int().positive().default(12),
    required_slices_per_entity: z.number().int().nonnegative().default(1),
    slice_context_paragraphs: z.number().int().nonnegative().default(1),
    slice_max_chars: z.number().int().positive().default(500),
    grep_default_max_matches: z.number().int().positive().default(80),
    grep_max_output_chars: z.number().int().positive().default(12000),
    read_max_output_chars: z.number().int().min(256).default(24000),
    glob_default_max_results: z.number().int().positive().default(200),
    librarian_recent_l2_window: z.number().int().positive().default(20),
    l2_freeze_block_chapters: z.number().int().positive().default(20),
    l2_full_unfrozen_threshold: z.number().int().positive().default(40),
    extractor_full_entity_threshold: z.number().int().positive().default(15),
    extractor_recent_l2_window: z.number().int().nonnegative().default(2),
    librarian_entity_summary_chars: z.number().int().positive().default(60)
});

/** 上下文装配件可配变量 */
export const BookContextAssemblyConfigSchema = z.object({
    fallback_tail_chars: z.number().int().positive().default(600),
    wakeup_gap_chapters: z.number().int().nonnegative().default(30),
    static_base_max_chars: z.number().int().positive().default(1500)
});

/** 审校与局部修补内环可配变量 */
export const BookRepairLoopConfigSchema = z.object({
    gate_max_patch_paragraphs: z.number().int().nonnegative().default(15),
    gate_max_patch_ratio: z.number().min(0).max(1).default(0.6),
    gate_max_patch_rounds: z.number().int().nonnegative().default(2),
    fact_max_patch_paragraphs: z.number().int().nonnegative().default(6),
    fact_max_patch_ratio: z.number().min(0).max(1).default(0.35),
    fact_max_patch_rounds: z.number().int().nonnegative().default(2),
    max_rewrites_per_outline: z.number().int().nonnegative().default(1),
    max_total_rewrites_per_chapter: z.number().int().nonnegative().default(2),
    max_replans_per_chapter: z.number().int().nonnegative().default(1)
});

/** 周期 Dreaming 与长期演进可配变量 */
export const BookDreamingConfigSchema = z.object({
    word_threshold: z.number().int().positive().default(15000),
    buffer_limit: z.number().int().positive().default(6),
    max_active_open_threads: z.number().int().positive().default(15),
    max_new_threads_per_dream: z.number().int().nonnegative().default(2),
    promote_anchor_min_chapters: z.number().int().positive().default(2),
    saga_fold_volume_interval: z.number().int().positive().default(10)
});

/** 运维锁与同步自愈可配变量 */
export const BookOpsAndSyncConfigSchema = z.object({
    tx_lock_stale_ms: z.number().int().positive().default(30000),
    signal_lookback_chapters: z.number().int().nonnegative().default(1),
    conflict_scan_batch_chars: z.number().int().positive().default(24000),
    heal_git_log_max_count: z.number().int().positive().default(2000)
});

const DEFAULT_BOOK_OPENING_CONFIG = BookOpeningConfigSchema.parse({});
const DEFAULT_BOOK_RETRIEVAL_CONFIG = BookRetrievalConfigSchema.parse({});
const DEFAULT_BOOK_CONTEXT_ASSEMBLY_CONFIG = BookContextAssemblyConfigSchema.parse({});
const DEFAULT_BOOK_REPAIR_LOOP_CONFIG = BookRepairLoopConfigSchema.parse({});
const DEFAULT_BOOK_DREAMING_CONFIG = BookDreamingConfigSchema.parse({});
const DEFAULT_BOOK_OPS_AND_SYNC_CONFIG = BookOpsAndSyncConfigSchema.parse({});

/** 作品可配变量 Schema (world/book_config.yaml) */
export const BookConfigSchema = z.object({
    book_slug: z.string().min(1),
    title: z.string().min(1),
    tokens_per_char: z.number().positive(),
    narration_subjectivity: NarrationSubjectivitySchema.default('objective_third'),
    trace_level: z.enum(['full', 'metadata', 'off']).optional(),
    writer_token_budget: z.number().int().positive().nullable().optional().default(null),
    max_auto_rollback_chapters: z.number().int().nonnegative().default(3),
    parallel_max_chapters: z.number().int().positive().optional(),
    structured_json_retry: z
        .object({
            max_retries: z.number().int().min(0).default(5),
            backoff_ms: z.array(z.number().int().nonnegative()).default([1000, 2000, 4000, 8000, 16000])
        })
        .default({
            max_retries: 5,
            backoff_ms: [1000, 2000, 4000, 8000, 16000]
        }),
    craft_plugins: z.array(z.string()).default([]),
    prose_gate: z
        .object({
            rules: z.record(z.string(), z.object({
                enabled: z.boolean().optional(), max_count: z.number().int().nonnegative().optional(),
                scale_by_length: z.boolean().optional(), reference_chars: z.number().int().positive().optional(),
                last_paragraphs_only: z.number().int().positive().optional()
            })).optional(),
            enable_anti_cliche: z.boolean().default(true),
            enable_cross_chapter_simile: z.boolean().default(true),
            cross_chapter_simile_window: z.number().int().positive().default(5)
        })
        .default({
            enable_anti_cliche: true,
            enable_cross_chapter_simile: true,
            cross_chapter_simile_window: 5
        }),
    opening: BookOpeningConfigSchema.default(DEFAULT_BOOK_OPENING_CONFIG),
    retrieval: BookRetrievalConfigSchema.default(DEFAULT_BOOK_RETRIEVAL_CONFIG),
    context_assembly: BookContextAssemblyConfigSchema.default(DEFAULT_BOOK_CONTEXT_ASSEMBLY_CONFIG),
    repair_loop: BookRepairLoopConfigSchema.default(DEFAULT_BOOK_REPAIR_LOOP_CONFIG),
    dreaming: BookDreamingConfigSchema.default(DEFAULT_BOOK_DREAMING_CONFIG),
    ops_and_sync: BookOpsAndSyncConfigSchema.default(DEFAULT_BOOK_OPS_AND_SYNC_CONFIG),
    model_routing: z.record(z.string(), z.string()).optional(),
    role_routing: RoleRoutingSchema.optional()
});

export type BookConfigResolved = z.infer<typeof BookConfigSchema>;

type OptionalExtensionBookConfigKeys =
    | 'opening'
    | 'retrieval'
    | 'context_assembly'
    | 'repair_loop'
    | 'dreaming'
    | 'ops_and_sync';

/** 向后兼容的 BookConfig 类型（新扩展分组在旧字面量构造处可省略，经 BookConfigSchema.parse 后全部补齐默认值） */
export type BookConfig = Omit<BookConfigResolved, OptionalExtensionBookConfigKeys> &
    Partial<Pick<BookConfigResolved, OptionalExtensionBookConfigKeys>>;

/** 工种与 Dreaming 运行会话索引记录 (.ops/runs.jsonl) */
export const RunRecordSchema = z.object({
    runId: z.string().min(1),
    chapter: z.number().int().nonnegative(),
    stage: z.string().min(1),
    role: z.string().min(1),
    sessionId: z.string().min(1),
    status: z.string().min(1),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1).optional(),
    error: z.string().optional(),
    attempt: z.number().int().nonnegative().optional(),
    triggerReason: z.string().min(1).optional(),
    parentSessionId: z.string().min(1).optional(),
    mode: z.string().min(1).optional()
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** 周期 Dreaming 水位记录 (.ops/dream_watermark.json) */
export const DreamWatermarkSchema = z.object({
    last_dream_ch: z.number().int().nonnegative(),
    accumulated_words_since_dream: z.number().int().nonnegative(),
    updated_at: z.string().min(1),
    appearance_absences: z.record(
        z.string().regex(/^(?:char|item)_[a-zA-Z0-9_]+$/),
        z.record(z.string().regex(/^ch_\d{4}$/), z.object({
            chapter_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            identity_sha256: z.string().regex(/^[a-f0-9]{64}$/)
        }))
    ).optional()
});
export type DreamWatermark = z.infer<typeof DreamWatermarkSchema>;

/** 三态时间线模式 */
export const TimelineModeSchema = z.enum(['MAINLINE', 'PARALLEL', 'FLASHBACK']);
export type TimelineMode = z.infer<typeof TimelineModeSchema>;

/** 世界状态 Frontmatter Schema (world/world_state.md) */
export const WorldStateFrontmatterSchema = z.object({
    story_day: z.number().int(),
    current_volume: z.number().int().positive(),
    current_chapter: z.number().int().nonnegative(),
    pov_character: z.string().min(1),
    timeline_mode: TimelineModeSchema.default('MAINLINE')
});

export type WorldStateFrontmatter = z.infer<typeof WorldStateFrontmatterSchema>;

/** 世界状态完整结构 */
export interface WorldState {
    frontmatter: WorldStateFrontmatter;
    summaryMarkdown: string;
}

/** 实体条目可见性枚举 */
export const EntryVisibilitySchema = z.enum([
    'SELF_ONLY',
    'OMNISCIENT_SECRET',
    'PUBLIC',
    'READER_KNOWN'
]);
export type EntryVisibility = z.infer<typeof EntryVisibilitySchema>;

/** 实体条目状态枚举 */
export const EntryStatusSchema = z.enum(['ACTIVE', 'WARPED']);
export type EntryStatus = z.infer<typeof EntryStatusSchema>;

/** 四段式实体头部元数据 Schema */
export const EntityMetadataSchema = z.object({
    entity_id: z.string().regex(/^(char|item)_[a-zA-Z0-9_]+$/),
    canonical_name: z
        .string()
        .min(1)
        .refine(
            (name) => name.trim().length > 0 && /[\u4e00-\u9fff]/.test(name),
            { message: 'canonical_name 必须非空且包含至少一个中文字符' }
        ),
    unique_aliases: z.array(z.string()).default([]),
    contextual_titles: z.array(z.string()).default([]),
    historical_anchors: z.array(z.string()).default([]),
    last_seen_ch: z.number().int().nonnegative().default(0),
    status: EntryStatusSchema.optional()
});

export type EntityMetadata = z.infer<typeof EntityMetadataSchema>;

/** 实体区内的单行条目 */
export const EntityEntrySchema = z.object({
    storyDay: z.number().int().optional(),
    chapter: z.number().int().nonnegative().optional(),
    visibility: EntryVisibilitySchema.optional(),
    rawInvalidVisibility: z.string().optional(),
    owner: z.string().optional(),
    status: EntryStatusSchema.optional(),
    slotKey: z.string().optional(),
    extraTags: z.record(z.string(), z.string()).optional(),
    isNumericLedger: z.boolean().optional(),
    ledger: z.record(z.string(), z.string()).optional(),
    text: z.string(),
    continuationLines: z.array(z.string())
});
export type EntityEntry = z.infer<typeof EntityEntrySchema>;

/** 四段式实体档案完整模型 */
export interface EntityProfile {
    metadata: EntityMetadata;
    sectionHeadings: {
        innateLocks: string;
        acquiredState: string;
        irreversibleTrajectory: string;
        recentBuffer: string;
    };
    innateLocks: EntityEntry[];
    acquiredState: EntityEntry[];
    irreversibleTrajectory: EntityEntry[];
    recentBuffer: EntityEntry[];
}

/** 补丁条目输入（continuationLines 可省略） */
export type EntityEntryInput = Omit<EntityEntry, 'continuationLines'> & {
    continuationLines?: string[] | undefined;
};

/** 实体增量补丁操作 */
export type SlotPatchOp =
    | { op: 'upsert_slot'; slot_key: string; entry: EntityEntryInput }
    | { op: 'append'; entry: EntityEntryInput }
    | { op: 'remove_slot'; slot_key: string }
    | { op: 'upsert_ledger'; entries: Record<string, string | number> };

export type BufferPatchOp =
    | { op: 'upsert_slot'; slot_key: string; entry: EntityEntryInput }
    | { op: 'append'; entry: EntityEntryInput }
    | { op: 'trim_buffer'; max_entries: number };

export interface EntityPatch {
    entity_id: string;
    last_seen_ch?: number | undefined;
    canonical_name?: string | undefined;
    add_unique_aliases?: string[] | undefined;
    add_contextual_titles?: string[] | undefined;
    add_historical_anchors?: string[] | undefined;
    innate_locks_ops?: Array<{ op: 'append'; entry: EntityEntryInput } | { op: 'remove_slot'; slot_key: string }> | undefined;
    acquired_state_ops?: SlotPatchOp[] | undefined;
    trajectory_ops?: Array<{ op: 'append'; entry: EntityEntryInput }> | undefined;
    buffer_ops?: BufferPatchOp[] | undefined;
}

/** WAL 事务相位 */
export const WalPhaseSchema = z.enum([
    'IDLE',
    'DRAFTING',
    'FEAT_COMMITTED',
    'STATE_COMMITTED',
    'DREAM_COMMITTED'
]);
export type WalPhase = z.infer<typeof WalPhaseSchema>;

/** .ops/tx_state.json 事务相位持久化校验模式 */
export const TxStateSchema = z.object({
    phase: WalPhaseSchema,
    active_chapter: z.number().int().positive().nullable(),
    last_committed_ch: z.number().int().nonnegative(),
    chapter_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    last_sync_id: z.string().uuid().optional(),
    chapter_context: z.object({
        timelineMode: TimelineModeSchema,
        targetDay: z.number().int(),
        povCharIds: z.array(z.string()),
        signalCursorUpdate: z.object({
            consumedLines: z.number().int().nonnegative(),
            consumedIds: z.array(z.string())
        }).optional(),
        fact_confirmations: z.object({
            completed_beats: z.array(z.string()),
            resolved_threads: z.array(z.string())
        }).optional(),
        parallelWindowId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
        parallelBranchId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional()
    }).optional(),
    updated_at: z.string()
});
export type TxState = z.infer<typeof TxStateSchema>;

/** 排他锁文件内容 */
export const TxLockPayloadSchema = z.object({
    pid: z.number().int().positive(),
    acquiredAt: z.string()
});
export type TxLockPayload = z.infer<typeof TxLockPayloadSchema>;

/** WAL 恢复结果 */
export interface WalRecoveryResult {
    action: 'READY' | 'ROLLED_BACK_DRAFT' | 'NEEDS_STATE_EXTRACTION';
    phase: WalPhase;
    activeChapter: number | null;
    clean: boolean;
}

/** 脏章检测项 */
export interface DirtyChapter {
    chapterKey: string;
    chapterNumber: number;
    relativePath: string;
    recordedHash: string | null;
    actualHash: string;
    reason: 'MODIFIED' | 'UNTRACKED';
}

/** 完整工作区快照 */
export interface BookSnapshot {
    config: BookConfig;
    worldState: WorldState;
    txState: TxState;
    entities: Record<string, EntityProfile>;
    coldEntities: Record<string, EntityProfile>;
    coldArchiveIds: string[];
    chapterFiles: string[];
    parallelBroadcastEntries?: EntityEntry[] | undefined;
}

/** 排他锁冲突异常 */
export class TxLockConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TxLockConflictError';
    }
}

/** 固有属性写保护异常 */
export class InnateLockViolationError extends Error {
    constructor(
        public readonly entityId: string,
        message: string
    ) {
        super(message);
        this.name = 'InnateLockViolationError';
    }
}

/** 跨文件外键不可达异常 */
export class ForeignKeyError extends Error {
    constructor(
        public readonly missingKeys: string[],
        public readonly sourceEntityId: string
    ) {
        super(`外键可达性校验失败 (${sourceEntityId}): 引用了不存在的对象 [${missingKeys.join(', ')}]`);
        this.name = 'ForeignKeyError';
    }
}

/** 切书冲突异常（存在在途运行任务或仓库事务锁未排空） */
export class BookSwitchConflictError extends Error {
    public readonly statusCode = 409 as const;

    constructor(message = '存在在途运行任务或事务锁占用，拒绝切换作品') {
        super(message);
        this.name = 'BookSwitchConflictError';
    }
}

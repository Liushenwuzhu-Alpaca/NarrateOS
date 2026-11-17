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
    preferred_voice_tag: z.string().optional()
});

export type PlannerOutline = z.infer<typeof PlannerOutlineSchema>;

/** 章节细纲快照读取结果：missing=旧章未留存，error=快照损坏/非法（正文不受影响） */
export interface ChapterOutlineSnapshot {
    outlineText: string | null;
    status: 'available' | 'missing' | 'error';
}

/** 作品可配变量 Schema (world/book_config.yaml) */
export const BookConfigSchema = z.object({
    book_slug: z.string().min(1),
    title: z.string().min(1),
    tokens_per_char: z.number().positive(),
    writer_token_budget: z.number().int().positive().nullable().optional().default(null),
    max_auto_rollback_chapters: z.number().int().positive().default(3),
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
            enable_anti_cliche: z.boolean().default(true),
            enable_cross_chapter_simile: z.boolean().default(true),
            cross_chapter_simile_window: z.number().int().positive().default(5)
        })
        .default({
            enable_anti_cliche: true,
            enable_cross_chapter_simile: true,
            cross_chapter_simile_window: 5
        }),
    model_routing: z.record(z.string(), z.string()).optional()
});

export type BookConfig = z.infer<typeof BookConfigSchema>;

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
    canonical_name: z.string().min(1),
    unique_aliases: z.array(z.string()).default([]),
    contextual_titles: z.array(z.string()).default([]),
    historical_anchors: z.array(z.string()).default([]),
    last_seen_ch: z.number().int().nonnegative().default(0),
    status: EntryStatusSchema.optional()
});

export type EntityMetadata = z.infer<typeof EntityMetadataSchema>;

/** 实体区内的单行条目 */
export interface EntityEntry {
    storyDay?: number | undefined;
    chapter?: number | undefined;
    visibility?: EntryVisibility | undefined;
    owner?: string | undefined;
    status?: EntryStatus | undefined;
    slotKey?: string | undefined;
    extraTags?: Record<string, string> | undefined;
    isNumericLedger?: boolean | undefined;
    ledger?: Record<string, string> | undefined;
    text: string;
    continuationLines: string[];
}

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

/** .ops/tx_state.json Schema */
export const TxStateSchema = z.object({
    phase: WalPhaseSchema,
    active_chapter: z.number().int().positive().nullable(),
    last_committed_ch: z.number().int().nonnegative(),
    chapter_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    chapter_context: z.object({
        timelineMode: TimelineModeSchema,
        targetDay: z.number().int(),
        povCharIds: z.array(z.string()),
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
    coldArchiveIds: string[];
    chapterFiles: string[];
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

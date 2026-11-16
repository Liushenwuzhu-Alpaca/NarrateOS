import { z } from 'zod';
import type { StructuredRetryOptions, TokenUsage } from '../ports/llm.js';
import type { TxState } from '../store/schemas.js';

/** .ops/signals.jsonl 信号类型 */
export const SignalTypeSchema = z.enum(['SPOTLIGHT_TRIGGER', 'RETCON']);
export type SignalType = z.infer<typeof SignalTypeSchema>;

/** 前台切镜与事后圆回信号结构 */
export const OpsSignalSchema = z.object({
    type: SignalTypeSchema,
    created_at: z.string(),
    chapter: z.number().int().nonnegative(),
    entity_id: z.string().optional(),
    conflict_id: z.string().optional(),
    chapter_a: z.number().int().positive().optional(),
    chapter_b: z.number().int().positive().optional(),
    suggested_mode: z.enum(['MAINLINE', 'PARALLEL']).optional(),
    reason: z.string().min(1)
});
export type OpsSignal = z.infer<typeof OpsSignalSchema>;

/** Dreaming 第 4 区脏缓冲提炼输出 Schema */
export const DreamVacuumOutputSchema = z.object({
    trajectory_entries: z.array(
        z.object({
            story_day: z.number().int().optional(),
            chapter: z.number().int().nonnegative(),
            anchor: z.string().min(1),
            summary: z.string().min(1)
        })
    ),
    keep_buffer_texts: z.array(z.string()).default([])
});
export type DreamVacuumOutput = z.infer<typeof DreamVacuumOutputSchema>;

/** 远景节点翻转与离场角色前台切镜评估输出 Schema */
export const HorizonEvalOutputSchema = z.object({
    warped_markers: z.array(z.string()).default([]),
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
export type HorizonEvalOutput = z.infer<typeof HorizonEvalOutputSchema>;

/** 跨章穿帮严重程度分类 */
export const ConflictSeveritySchema = z.enum([
    'SOFT_MINOR',
    'SINGLE_POINT_HARD',
    'CASCADING_HARD'
]);
export type ConflictSeverity = z.infer<typeof ConflictSeveritySchema>;

/** 跨章穿帮裁决输出 Schema */
export const ConflictClassificationOutputSchema = z.object({
    severity: ConflictSeveritySchema,
    reason: z.string().min(1),
    downstream_dependent: z.boolean().default(false),
    patched_segment: z.string().optional()
});
export type ConflictClassificationOutput = z.infer<typeof ConflictClassificationOutputSchema>;

/** QUARANTINED / SAFE_HALT 确定性诊断报告 Schema */
export const QuarantineReportSchema = z.object({
    status: z.enum(['QUARANTINED', 'SAFE_HALT']),
    conflict_id: z.string().min(1),
    side_a_chapter: z.number().int().positive(),
    side_a_line: z.number().int().positive().nullable(),
    side_b_chapter: z.number().int().positive(),
    side_b_line: z.number().int().positive().nullable(),
    rollback_chapters: z.number().int().nonnegative(),
    rollback_words: z.number().int().nonnegative(),
    reason: z.string().min(1),
    created_at: z.string()
});
export type QuarantineReport = z.infer<typeof QuarantineReportSchema>;

/** 离场重要角色幕后进度输入 */
export interface OffscreenCharacterProgress {
    entityId: string;
    pendingGoal: string;
    progressNote: string;
}

/** runDreaming() 执行选项 */
export interface RunDreamingOptions {
    currentChapter: number;
    currentStoryDay?: number | undefined;
    recentWordDelta?: number | undefined;
    dreamWordThreshold?: number | undefined;
    dreamBufferLimit?: number | undefined;
    force?: boolean | undefined;
    /** 近期出场实体 ID 列表；未在其中的干净实体零读取、零修改 */
    activeEntityIds?: string[] | undefined;
    /** 明确检查是否长期退场的候选实体 ID 列表 */
    coldArchiveCandidateIds?: string[] | undefined;
    /** 长期退场归档阈值章数 */
    coldArchiveInactiveChapters?: number | undefined;
    /** WARPED 死元组过期时间窗（天数，默认 3） */
    warpedExpireDays?: number | undefined;
    /** 离场重要角色待办与进度 */
    offscreenCharacters?: OffscreenCharacterProgress[] | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
    signal?: AbortSignal | undefined;
}

/** runDreaming() 执行结果 */
export interface RunDreamingResult {
    skipped: boolean;
    vacuumedEntities: string[];
    warpedNodesFlipped: number;
    archivedFiles: string[];
    spotlightTriggers: OpsSignal[];
    committedTxState: TxState | null;
    usage: TokenUsage;
}

/** 离线连续性审计上报的疑似跨章冲突 */
export interface SuspectedConflict {
    conflictId: string;
    chapterA: number;
    quoteA: string;
    chapterB: number;
    quoteB: string;
    description: string;
    hasLegitimateTransfer?: boolean | undefined;
    severityHint?: ConflictSeverity | undefined;
    downstreamDependentChapters?: number[] | undefined;
}

/** 自动回滚重跑回调上下文 */
export interface AutoRerunContext {
    conflict: SuspectedConflict;
    rollbackToChapter: number;
    backupTag: string;
    constraint: string;
}

/** healCrossChapterConflicts() 执行选项 */
export interface HealConflictsOptions {
    maxAutoRollbackChapters?: number | undefined;
    onAutoRerun?: ((ctx: AutoRerunContext) => Promise<{ success: boolean; stillConflicting?: boolean | undefined }>) | undefined;
    onSyncAfterPatch?: ((chapterNumber: number) => Promise<void>) | undefined;
    resolveRollbackRef?: ((targetChapter: number) => Promise<string>) | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
    signal?: AbortSignal | undefined;
}

/** 单条冲突处置动作 */
export type HealAction =
    | 'DISCARDED_HALLUCINATION'
    | 'DISCARDED_LEGITIMATE_TRANSFER'
    | 'RETCON_SIGNAL'
    | 'PATCHED_IN_PLACE'
    | 'AUTO_ROLLED_BACK_AND_RERUN'
    | 'QUARANTINED';

/** 单条冲突处置结果 */
export interface HealConflictItemResult {
    conflictId: string;
    action: HealAction;
    sideALine?: number | null | undefined;
    sideBLine?: number | null | undefined;
    backupTag?: string | undefined;
    quarantineReport?: QuarantineReport | undefined;
}

/** healCrossChapterConflicts() 汇总结果 */
export interface HealConflictsResult {
    results: HealConflictItemResult[];
    quarantined: boolean;
    quarantineReport: QuarantineReport | null;
    usage: TokenUsage;
}

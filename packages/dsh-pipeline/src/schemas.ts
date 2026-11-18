import { z } from 'zod';
import type {
    DirtyChapter,
    LlmPool,
    PlannerOutline,
    RoleModelOverride,
    RoleTierOverride,
    StructuredRetryOptions,
    TelemetryMetrics,
    TimelineMode,
    TokenUsage,
    TxState
} from '@narrateos/dsh-book-store';

/** 单个模型池路由目标 */
export interface LlmRouteTarget {
    provider: string;
    model: string;
}

/** 三个模型池的路由映射 */
export type LlmPoolRouting = Record<LlmPool, LlmRouteTarget>;

/** 运行态排他任务类型 */
export type RuntimeTaskKind =
    | 'IDLE'
    | 'STEPPING'
    | 'SYNCING'
    | 'DREAMING'
    | 'BOOTING'
    | 'ADVANCING_VOLUME';

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

/** 工种运行会话广播载荷 */
export interface StageSessionEvent {
    stage: string;
    role: string;
    chapter: number;
    runId: string;
    sessionId: string;
    parentSessionId?: string | undefined;
    mode?: string | undefined;
    attempt?: number | undefined;
    triggerReason?: string | undefined;
}

/** 工种运行实时流/工具事件项 */
export interface StageSessionEventItem {
    seq?: number | undefined;
    timestamp: string;
    kind: 'thinking' | 'text' | 'tool-call' | 'tool-result' | 'status' | 'error';
    text?: string | undefined;
    toolName?: string | undefined;
    callId?: string | undefined;
    status?: string | undefined;
}

/** 工种阶段流式事件 SSE 载荷 (event: stage:event) */
export interface StageStreamSseEvent {
    sessionId: string;
    stage: string;
    kind: StageSessionEventItem['kind'];
    text?: string | undefined;
    toolName?: string | undefined;
    callId?: string | undefined;
    status?: string | undefined;
}

/** 阶段会话请求入参快照 */
export interface StageSessionRequestInput {
    systemPrompt?: string | undefined;
    taskPromptBlocks?: string[] | undefined;
    temperature?: number | undefined;
    reasoningEffort?: string | undefined;
    maxTokens?: number | undefined;
    pool?: string | undefined;
    tools?: string[] | undefined;
}

/** 阶段会话详情载荷 (GET /api/narrate/runs/detail?sessionId=...) */
export interface StageSessionDetail {
    sessionId: string;
    runId?: string | undefined;
    stage?: string | undefined;
    role?: string | undefined;
    chapter?: number | undefined;
    status?: string | undefined;
    parentSessionId?: string | undefined;
    mode?: string | undefined;
    attempt?: number | undefined;
    triggerReason?: string | undefined;
    live: boolean;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    modelId?: string | undefined;
    usage?: TokenUsage | undefined;
    reasoning?: string | undefined;
    thinkingChars?: number | undefined;
    requestInput?: StageSessionRequestInput | undefined;
    events: StageSessionEventItem[];
}

/** 单个工种的默认配置与生效模型路由摘要 (对应 status.roleDefinitions[]) */
export interface RoleDefinitionItem {
    id: string;
    defaultPool: LlmPool;
    defaultReasoningEffort?: string | undefined;
    effectiveTier?: RoleTierOverride | null | undefined;
    effectivePool: string;
    effectiveProvider: string;
    effectiveModel: string;
    effectiveReasoningEffort?: string | undefined;
}

/** 运行时探测到的可用模型候选 (对应 status.availableModels[]) */
export interface AvailableModelItem {
    provider: string;
    model: string;
    label?: string | undefined;
}

/** 模型路由保存响应载荷 (对应 PUT /api/narrate/model-routing) */
export interface SaveModelRoutingResult {
    status: 'ok';
    modelRouting: Record<string, string>;
    roleRouting: Record<string, RoleModelOverride>;
    roleDefinitions: RoleDefinitionItem[];
}

/** 扩展后的 .ops/runs.jsonl 会话索引记录 */
export const ExtendedRunRecordSchema = z.object({
    runId: z.string().min(1),
    chapter: z.number().int().nonnegative(),
    stage: z.string().min(1),
    role: z.string().min(1),
    sessionId: z.string().min(1),
    status: z.string().min(1),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1).optional(),
    error: z.string().optional(),
    parentSessionId: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative().optional(),
    triggerReason: z.string().min(1).optional()
});
export type ExtendedRunRecord = z.infer<typeof ExtendedRunRecordSchema>;

/** 引擎阶段进度事件 */
export interface EngineProgressEvent {
    stage: EngineStageName;
    chapterNumber: number;
    message: string;
    timestamp: string;
    activeSessionId?: string | undefined;
    runId?: string | undefined;
    subStage?: string | undefined;
    attempt?: number | undefined;
}

/** stepChapter 调用参数 */
export interface StepChapterOptions {
    chapterNumber?: number | undefined;
    chapterGoal: string;
    timelineMode?: TimelineMode | undefined;
    targetDay?: number | undefined;
    parallelWindowId?: string | undefined;
    parallelBranchId?: string | undefined;
    povCharIds?: string[] | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((event: EngineProgressEvent) => void) | undefined;
    onStageSession?: ((event: StageSessionEvent) => void) | undefined;
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
    dirtyChapter?: number | undefined;
    dirtyLineNumber?: number | null | undefined;
    dirtyQuote?: string | undefined;
}

/** syncManuscripts 执行结果 */
export interface SyncManuscriptsResult {
    status:
        | 'CLEAN'
        | 'PROSE_POLISH_SYNCED'
        | 'STATE_SYNCED'
        | 'DOWNSTREAM_CONFLICTS_FOUND'
        | 'HISTORY_SYNCED_NO_CONFLICT';
    dirtyChapters: DirtyChapter[];
    updatedEntities: string[];
    downstreamConflicts: DownstreamConflictReport[];
    stateDiffAdvisories?: string[] | undefined;
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

/** Voice Harvest 执行结果 */
export interface VoiceHarvestResult {
    harvestedCount: number;
    skipped: boolean;
    samples: Array<{ id: string; tag: string; text: string }>;
}

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
    dirty_chapter: z.number().int().positive().optional(),
    dirty_quote: z.string().default(''),
    description: z.string().min(1)
});

export const DownstreamScanOutputSchema = z.object({
    conflicts: z.array(DownstreamConflictItemSchema).default([])
});
export type DownstreamConflictItem = z.infer<typeof DownstreamConflictItemSchema>;
export type DownstreamScanOutput = z.infer<typeof DownstreamScanOutputSchema>;

/** 换卷 Step 1: 旧卷封存摘要输出 Schema */
export const VolumeSealOutputSchema = z.object({
    volume_summary: z.string().min(1),
    story_day_span: z.string().min(1)
});

/** 换卷 Step 3: 风格修订合并输出 Schema */
export const StyleMergeOutputSchema = z.object({
    merged_markdown: z.string().min(1)
});

/** 换卷 Step 4: 新卷包络、导演底牌与未来惯性输出 Schema */
export const NextVolumeEnvelopeOutputSchema = z.object({
    current_arc_envelope: z.string().min(1),
    arc_director_plan: z.string().optional(),
    future_horizon: z.string().min(1)
});

/** 首章校准 Voice Harvest 输出 Schema */
export const VoiceHarvestOutputSchema = z.object({
    samples: z
        .array(
            z.object({
                tag: z.string().min(1),
                text: z.string().min(1)
            })
        )
        .min(1)
        .max(5)
});

/** .ops/signals.jsonl 信号类型 */
export const SignalTypeSchema = z.enum(['SPOTLIGHT_TRIGGER', 'RETCON', 'DIRECTOR_NOTE']);
export type SignalType = z.infer<typeof SignalTypeSchema>;

/** 运维微调与切镜信号结构 */
export const OpsSignalSchema = z.object({
    id: z.string().min(1).optional(),
    type: SignalTypeSchema,
    created_at: z.string(),
    chapter: z.number().int().nonnegative(),
    entity_id: z.string().optional(),
    conflict_id: z.string().optional(),
    chapter_a: z.number().int().positive().optional(),
    chapter_b: z.number().int().positive().optional(),
    suggested_mode: z.enum(['MAINLINE', 'PARALLEL', 'FLASHBACK']).optional(),
    reason: z.string().min(1)
});
export type OpsSignal = z.infer<typeof OpsSignalSchema>;

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
    activeEntityIds?: string[] | undefined;
    coldArchiveCandidateIds?: string[] | undefined;
    coldArchiveInactiveChapters?: number | undefined;
    warpedExpireDays?: number | undefined;
    offscreenCharacters?: OffscreenCharacterProgress[] | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
    signal?: AbortSignal | undefined;
    onStageSession?: ((event: StageSessionEvent) => void) | undefined;
}

/** runDreaming() 执行结果 */
export interface RunDreamingResult {
    skipped: boolean;
    summary?: string | undefined;
    committedPaths: string[];
    spotlightTriggerCount: number;
    committedTxState: TxState | null;
    sessionId?: string | undefined;
    runId?: string | undefined;
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
    onAutoRerun?:
        | ((ctx: AutoRerunContext) => Promise<{ success: boolean; stillConflicting?: boolean | undefined }>)
        | undefined;
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

/** YOLO 运行态 */
export interface YoloRuntimeState {
    running: boolean;
    stopRequested: boolean;
    completedChapters: number;
    targetChapters: number;
    currentStage: string | null;
    loopPromise: Promise<void> | null;
}

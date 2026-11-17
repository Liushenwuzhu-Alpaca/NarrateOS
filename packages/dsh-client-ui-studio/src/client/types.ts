/**
 * NarrateOS 前端 Operator Studio 完整状态与 API 契约类型定义
 */

/** 后端运行态排他任务类型 */
export type RuntimeTaskKind = 'IDLE' | 'STEPPING' | 'SYNCING' | 'DREAMING' | 'BOOTING';

/** 章节时间线模式 */
export type TimelineMode = 'MAINLINE' | 'PARALLEL' | 'FLASHBACK';

/** 中央阅读区视图标签 */
export type ActiveViewTab = 'prose' | 'plan' | 'diff';

/** 作品列表单项摘要（对应 GET /api/narrate/books） */
export interface BookSummary {
    bookRoot: string;
    slug: string;
    title: string;
    currentChapter: number;
    storyDay: number;
    walPhase: string;
}

/** 作品列表响应载荷 */
export interface BooksListPayload {
    currentBookRoot: string;
    books: BookSummary[];
}

/** 世界状态 Frontmatter 摘要 */
export interface WorldStateSummary {
    story_day: number;
    current_chapter: number;
    timeline_mode?: TimelineMode | string | undefined;
    [key: string]: unknown;
}

/** YOLO 连跑运行态摘要 */
export interface YoloStatusSummary {
    running: boolean;
    completedChapters: number;
    targetChapters: number;
    currentStage: string | null;
    stopRequested?: boolean | undefined;
}

/** 运行态任务与停机标志 */
export interface RuntimeStatusSummary {
    activeTask: RuntimeTaskKind;
    haltRequested: boolean;
}

/** 作品全局状态载荷（对应 GET /api/narrate/status） */
export interface NarrateStatusPayload {
    bookRoot: string;
    bookSlug: string;
    title: string;
    walPhase: string;
    activeChapter: number | null;
    lastCommittedChapter: number;
    latestChapter: number;
    chapterCount: number;
    entityCount: number;
    coldArchiveCount: number;
    worldState: WorldStateSummary;
    pendingSignalsCount: number;
    yolo: YoloStatusSummary;
    runtime: RuntimeStatusSummary;
    modelRouting?: Record<string, string> | undefined;
}

/** 章节列表单项摘要（对应 GET /api/narrate/chapters） */
export interface ChapterSummary {
    chapterNumber: number;
    fileName: string;
    title: string;
    charCount: number;
    sha256: string;
    dirty: boolean;
    commitSha: string | null;
}

/** 章节列表响应载荷 */
export interface ChaptersListPayload {
    chapters: ChapterSummary[];
}

/** 章节细纲快照状态：available=已留存可解析；missing=旧章未留存（不捏造）；error=快照损坏（正文仍可读） */
export type ChapterOutlineStatus = 'available' | 'missing' | 'error';

/** 单章详情与 Diff（对应 GET /api/narrate/chapter?ch=...） */
export interface ChapterDetail {
    chapterNumber: number;
    content: string;
    dirty: boolean;
    sha256: string;
    diffFromHead: string;
    /** 保存的完整 PlannerOutline JSON 字符串（规划快照，非剧情真源）；missing/error 时为 null */
    outlineText: string | null;
    outlineStatus: ChapterOutlineStatus;
}

/** 6 节点运行阶段状态 */
export type StageNodeStatus = 'pending' | 'active' | 'done' | 'patch' | 'halt' | 'dormant';

/** 会话级子代理挂载模式 */
export type StageSessionSubagentMode = 'one-shot' | 'continuable' | 'unknown';

/** 6 节点运行阶段图单个节点状态 */
export interface StageNodeState {
    id: string;
    index: number;
    name: string;
    shortLabel: string;
    status: StageNodeStatus;
    detail: string;
    durationLabel?: string | undefined;
    updatedAt?: string | undefined;
    sessionId?: string | undefined;
    parentSessionId?: string | undefined;
    mode?: StageSessionSubagentMode | string | undefined;
    runId?: string | undefined;
}

/** .ops/runs.jsonl 单条工种会话索引记录（对应 GET /api/narrate/runs） */
export interface StageRunRecord {
    runId: string;
    chapter?: number | undefined;
    stage: string;
    role?: string | undefined;
    sessionId: string;
    parentSessionId?: string | undefined;
    mode?: StageSessionSubagentMode | string | undefined;
    status: string;
    timestamp?: string | undefined;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
}

/** 工种运行会话索引响应载荷 */
export interface RunsListPayload {
    runs: StageRunRecord[];
}

/** 阶段会话轨迹中的单次工具调用明细 */
export interface RunDetailToolCall {
    id?: string | undefined;
    name: string;
    arguments?: unknown;
    result?: unknown;
    status?: string | undefined;
    durationMs?: number | undefined;
}

/** 阶段会话轨迹中的单轮对话/推演记录 */
export interface RunDetailTurn {
    turnIndex?: number | undefined;
    role?: string | undefined;
    timestamp?: string | undefined;
    thinking?: string | undefined;
    reasoning?: string | undefined;
    content?: string | undefined;
    output?: string | undefined;
    text?: string | undefined;
    toolCalls?: RunDetailToolCall[] | undefined;
    tool_calls?: RunDetailToolCall[] | undefined;
    [key: string]: unknown;
}

/** 阶段会话历史详情响应载荷（对应 GET /api/narrate/runs/detail?sessionId=...） */
export interface RunDetailPayload {
    sessionId: string;
    runId?: string | undefined;
    stage?: string | undefined;
    status?: string | undefined;
    parentSessionId?: string | undefined;
    mode?: StageSessionSubagentMode | string | undefined;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    turns?: RunDetailTurn[] | undefined;
    thinking?: string | undefined;
    reasoning?: string | undefined;
    toolCalls?: RunDetailToolCall[] | undefined;
    output?: string | undefined;
    finalOutput?: string | undefined;
    summary?: string | undefined;
    error?: string | undefined;
    [key: string]: unknown;
}

/** 一次性导演信号条目（对应 .ops/signals.jsonl） */
export interface OpsSignalItem {
    id?: string | undefined;
    type?: string | undefined;
    content?: string | undefined;
    instruction?: string | undefined;
    target_chapter?: number | undefined;
    created_at?: string | undefined;
    raw?: string | undefined;
    [key: string]: unknown;
}

/** 遥测指标嵌套明细 */
export interface TelemetryMetrics {
    mattr500?: number | null | undefined;
    kontoyiannisEntropy?: number | null | undefined;
    kontoyiannisHk?: number | null | undefined;
    sentenceLengthCv?: number | null | undefined;
    clicheDensityPer1k?: number | null | undefined;
    [key: string]: unknown;
}

/** 遥测 Token 消耗嵌套明细 */
export interface TelemetryTokenUsage {
    inputTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    outputTokens?: number | undefined;
    [key: string]: unknown;
}

/** 遥测指标条目（对应 .ops/telemetry.jsonl） */
export interface TelemetryItem {
    chapter?: number | undefined;
    chapterNumber?: number | undefined;
    stage?: string | undefined;
    clicheDensityPer1k?: number | undefined;
    mattr500?: number | undefined;
    sentenceLengthCv?: number | undefined;
    kontoyiannisHk?: number | undefined;
    kontoyiannisEntropy?: number | undefined;
    replanRate?: number | undefined;
    cacheHitRate?: number | undefined;
    inputTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    outputTokens?: number | undefined;
    metrics?: TelemetryMetrics | undefined;
    token_usage?: TelemetryTokenUsage | undefined;
    timestamp?: string | undefined;
    raw?: string | undefined;
    [key: string]: unknown;
}

/** 实体档案物化视图条目（对应 GET /api/narrate/views?kind=entities） */
export interface EntityViewItem {
    entityId: string;
    canonicalName: string;
    aliases: string[];
    lastSeenChapter: number;
    markdown: string;
}

/** 实体视图响应载荷 */
export interface EntitiesViewPayload {
    kind: 'entities';
    entities: EntityViewItem[];
    coldArchiveCount: number;
    coldArchiveIds: string[];
}

/** Markdown 视图响应载荷（horizon / threads） */
export interface MarkdownViewPayload {
    kind: 'horizon' | 'threads';
    content: string;
}

/** 遥测视图响应载荷 */
export interface TelemetryViewPayload {
    kind: 'telemetry';
    entries: TelemetryItem[];
}

/** 信号视图响应载荷 */
export interface SignalsViewPayload {
    kind: 'signals';
    signals: OpsSignalItem[];
    /** 未消费信号切片(signals 尾部 pendingCount 条);旧后端无此字段时前端按 pendingCount 兜底 */
    pending?: OpsSignalItem[] | undefined;
    pendingCount: number;
}

/** 挂起与隔离报告视图响应载荷 */
export interface HaltViewPayload {
    kind: 'halt';
    safeHalt: Record<string, unknown> | null;
    quarantineReport: Record<string, unknown> | null;
}

/** 切换作品请求 */
export interface SelectBookRequest {
    bookRoot?: string | undefined;
    slug?: string | undefined;
}

/** 切换作品响应 */
export interface SelectBookResponse {
    status: 'SWITCHED';
    bookRoot: string;
}

/** 开新书请求 */
export interface BootBookRequest {
    slug: string;
    title: string;
    povCharacter: string;
    mode: 'original' | 'fanfic';
    premiseOrSeed?: string | undefined;
    sourceMaterial?: string | undefined;
    t0Anchor?: string | undefined;
}

/** 开新书响应 */
export interface BootBookResponse {
    status: 'BOOTED';
    bookRoot: string;
    result: Record<string, unknown>;
}

/** 单章推进请求 */
export interface StepChapterRequest {
    chapterGoal: string;
    chapterNumber?: number | undefined;
    timelineMode?: TimelineMode | undefined;
    targetDay?: number | undefined;
    povCharIds?: string[] | undefined;
}

/** 单章推进响应 */
export interface StepChapterResponse {
    chapterNumber: number;
    manuscriptPath: string;
    featCommitSha?: string | undefined;
    stateCommitSha?: string | undefined;
    replanCount: number;
    rewriteCount: number;
    patchRounds: number;
    telemetry: {
        clicheDensityPer1k: number;
        mattr500: number;
        sentenceLengthCv: number;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/** 保存章节并触发同步请求 */
export interface PutChapterRequest {
    chapterNumber: number;
    content: string;
}

/** 手改对账响应 */
export interface SyncResponse {
    status: string;
    dirtyChapters: Array<{ chapterNumber: number; [key: string]: unknown }>;
    downstreamConflicts: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

/** 保存章节响应 */
export interface PutChapterResponse {
    chapterNumber: number;
    sync: SyncResponse;
}

/** Dreaming 请求 */
export interface DreamRequest {
    currentChapter?: number | undefined;
    force?: boolean | undefined;
    recentWordDelta?: number | undefined;
    activeEntityIds?: string[] | undefined;
}

/** Dreaming 响应 */
export interface DreamResponse {
    skipped: boolean;
    vacuumedEntities?: number | undefined;
    warpedNodesFlipped?: number | undefined;
    archivedFiles?: number | undefined;
    [key: string]: unknown;
}

/** 投递导演信号请求 */
export interface PostSignalRequest {
    type: string;
    content: string;
    target_chapter?: number | undefined;
    created_at?: string | undefined;
    [key: string]: unknown;
}

/** 投递导演信号响应 */
export interface PostSignalResponse {
    status: 'QUEUED';
    signal: OpsSignalItem;
}

/** Safe-Point 停机响应 */
export interface HaltResponse {
    haltRequested: boolean;
    activeTask: RuntimeTaskKind;
}

/** YOLO 启动请求 */
export interface YoloStartRequest {
    targetChapters?: number | undefined;
    defaultGoal?: string | undefined;
}

/** YOLO 启动响应 */
export interface YoloStartResponse {
    status: 'STARTED';
    targetChapters: number;
    defaultGoal: string;
}

/** YOLO 停止响应 */
export interface YoloStopResponse {
    stopRequested: boolean;
    running: boolean;
    completedChapters: number;
}

/** 后端 SSE 推送的所有事件名称 */
export type SseEventName =
    | 'connected'
    | 'book_switched'
    | 'halt:requested'
    | 'halt:waiting'
    | 'halt:completed'
    | 'sync:started'
    | 'sync:completed'
    | 'chapter_synced'
    | 'chapter:phase'
    | 'stage'
    | 'gate:result'
    | 'checker:result'
    | 'dream:started'
    | 'dream:completed'
    | 'signal:received'
    | 'telemetry'
    | 'yolo:stop_requested'
    | 'yolo_halted'
    | 'yolo_completed';

/** 统一的 SSE 事件载荷封装 */
export interface SseEventPayload {
    event: SseEventName | string;
    data: Record<string, unknown>;
}

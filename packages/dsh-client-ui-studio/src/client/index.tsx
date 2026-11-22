import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives';
import {
    advanceVolume,
    bootBook,
    deleteSignal,
    fetchBooks,
    fetchChapter,
    fetchChapters,
    fetchRunRecords,
    fetchStatus,
    fetchViewEntities,
    fetchViewHalt,
    fetchViewHorizon,
    fetchViewSignals,
    fetchViewSyncConflicts,
    fetchViewTelemetry,
    fetchViewThreads,
    forkParallelWindow,
    harvestVoice,
    healConflicts,
    mergeParallelWindow,
    postSignal,
    requestHalt,
    runDreaming,
    saveChapter,
    saveModelRouting,
    selectBook,
    startYolo,
    stepChapter,
    stopYolo,
    subscribeNarrateEvents,
    syncManuscripts,
    type StudioRequestScope
} from './api';
import { BootBookModal } from './BootBookModal';
import {
    CenterWorkbench,
    resolvePrimaryStageSession,
    resolveStageId,
    STAGE_REPAIR_META,
    type CenterWorkbenchDraftHandle,
    type CenterWorkbenchProps,
    type ExternalViewCommand,
    type PendingSignalItem,
    type PipelineStageId,
    type SafeHaltInfo,
    type SafeHaltIssueItem,
    type StageAttemptSession,
    type StageNodeState,
    type StageNodeStatus,
    type StageSessionSelection,
    type SubmitSignalPayload,
    type SyncConflictDiagnostic,
    type VerdictGateViolationItem
} from './CenterWorkbench';
import {
    getStashedDraft,
    hasAnyUnsavedDraft,
    putStashedDraft,
    removeStashedDraft,
    type DraftLocation,
    type DraftStashMap,
    type StashedDraftEntry
} from './draft-guard';
import { LeftBookNav, type MaterializedViewKind } from './LeftBookNav';
import {
    RightOpsInspector,
    type FactCheckDetailItem,
    type FactCheckerTelemetry,
    type HaltDiagnosticInfo,
    type HaltDiagnosticIssueItem,
    type InspectorEntityItem,
    type OpenThreadItem,
    type ProseGateViolationItem,
    type SpotlightQueueItem,
    type StageArtifactTelemetry,
    type VolumeProgressSnapshot
} from './RightOpsInspector';
import {
    collectPoolProviders,
    resolveEffectiveRoleModelLabel,
    RoleRoutingEditor
} from './RoleRoutingEditor';
import {
    StageSessionViewer,
    type StageViewerAttemptItem,
    type StudioRenderStageConversation,
    type StudioSessionProviderComponent,
    type StudioSessionsService
} from './StageSessionViewer';
import { AdvanceVolumeModal, ParallelWindowModal } from './StudioActionModals';
import { ensureStudioStyles } from './styles';
import { handleTabKeyDown } from './tab-keyboard';
import { aggregateTelemetryTokens } from './token-telemetry';
import type {
    BooksListPayload,
    ChapterDetail,
    ChapterSummary,
    EntitiesViewPayload,
    HaltViewPayload,
    MarkdownViewPayload,
    NarrateStatusPayload,
    PostSignalRequest,
    RoleDefinitionItem,
    RolePoolId,
    RuntimeTaskKind,
    SaveModelRoutingRequest,
    SignalsViewPayload,
    SseEventPayload,
    StageRunRecord,
    StageSessionDetailEvent,
    StepChapterRequest,
    SyncConflictsViewPayload,
    TelemetryItem,
    TelemetryViewPayload
} from './types';
import { parseHorizonEntries, parseThreadItems } from './workbench-parsers';

export const PANEL_ID = 'narrateos-studio';

export const inject = ['slots', 'layout'] as const;

interface ToastState {
    id: number;
    message: string;
    kind: 'info' | 'error';
}

const PIPELINE_STAGE_META: ReadonlyArray<{
    id: PipelineStageId;
    roleId: string;
    defaultPool: RolePoolId;
    label: string;
}> = [
    { id: 'LIBRARIAN', roleId: 'librarian', defaultPool: 'fast_retrieval', label: '1. Librarian' },
    { id: 'PLANNER', roleId: 'planner', defaultPool: 'strong_creative', label: '2. Planner' },
    { id: 'WRITER', roleId: 'writer', defaultPool: 'strong_creative', label: '3. Writer' },
    { id: 'FACT_CHECKER', roleId: 'fact_checker', defaultPool: 'strong_creative', label: '4. Checker' },
    { id: 'EXTRACTOR', roleId: 'extractor', defaultPool: 'fast_retrieval', label: '5. Extractor' },
    { id: 'DREAMING', roleId: 'dreamer', defaultPool: 'strong_creative', label: '6. Dreamer' }
];

const DEFAULT_STAGE_SUMMARIES: Record<PipelineStageId, string> = {
    LIBRARIAN: '翻阅前文与设定选页',
    PLANNER: '规划本章剧情节拍',
    WRITER: '纯净环境执笔正文',
    FACT_CHECKER: '独立核对前后设定矛盾',
    EXTRACTOR: '章末更新人物与伏笔',
    DREAMING: '跨章阶段整理与归纳'
};

const MAX_LIVE_EVENTS_PER_SESSION = 500;
const WIDE_BREAKPOINT_PX = 1100;
const COMPACT_BREAKPOINT_PX = 820;
const LEFT_OPEN_STORAGE_KEY = 'narrateos.studio.leftOpen';
const LEFT_WIDTH_STORAGE_KEY = 'narrateos.studio.leftWidth';
const RIGHT_WIDTH_STORAGE_KEY = 'narrateos.studio.rightWidth';
const LEFT_WIDTH_DEFAULT = 224;
const LEFT_WIDTH_MIN = 180;
const LEFT_WIDTH_MAX = 380;
const RIGHT_WIDTH_DEFAULT = 340;
const RIGHT_WIDTH_MIN = 280;
const RIGHT_WIDTH_MAX = 540;

function clampPaneWidth(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(value)));
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
    if (typeof window === 'undefined') return fallback;
    try {
        const raw = window.localStorage?.getItem(key);
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        return fallback;
    } catch {
        return fallback;
    }
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
    if (typeof window === 'undefined') return fallback;
    try {
        const raw = window.localStorage?.getItem(key);
        if (!raw) return fallback;
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return clampPaneWidth(parsed, min, max);
    } catch {
        return fallback;
    }
}

function writeStorageItem(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage?.setItem(key, value);
    } catch {
        // 忽略无存储权限或配额异常
    }
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function formatChapterFileRef(chapter: number | undefined): string | undefined {
    if (chapter === undefined || !Number.isFinite(chapter) || chapter <= 0) return undefined;
    return `ch_${String(chapter).padStart(4, '0')}.md`;
}

function readTelemetryMetrics(item: TelemetryItem | null | undefined): {
    mattr500: number | null;
    kontoyiannisEntropy: number | null;
    sentenceLengthCv: number | null;
    clicheDensityPer1k: number | null;
} {
    return {
        mattr500: item?.metrics?.mattr500 ?? item?.mattr500 ?? null,
        kontoyiannisEntropy:
            item?.metrics?.kontoyiannisEntropy ??
            item?.metrics?.kontoyiannisHk ??
            item?.kontoyiannisEntropy ??
            item?.kontoyiannisHk ??
            null,
        sentenceLengthCv: item?.metrics?.sentenceLengthCv ?? item?.sentenceLengthCv ?? null,
        clicheDensityPer1k: item?.metrics?.clicheDensityPer1k ?? item?.clicheDensityPer1k ?? null
    };
}

function parseRawIssues(rawIssues: unknown): {
    haltIssues: SafeHaltIssueItem[];
    diagIssues: HaltDiagnosticIssueItem[];
} {
    if (!Array.isArray(rawIssues)) {
        return { haltIssues: [], diagIssues: [] };
    }
    const haltIssues: SafeHaltIssueItem[] = [];
    const diagIssues: HaltDiagnosticIssueItem[] = [];
    for (const entry of rawIssues) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;
        const description = asString(obj['description']) ?? asString(obj['detail']) ?? asString(obj['message']);
        const quoteDraft = asString(obj['quote_draft']) ?? asString(obj['quote']) ?? asString(obj['snippet']);
        const quoteSource = asString(obj['quote_source']) ?? asString(obj['sourceQuote']);
        const sourceRef = asString(obj['source_ref']) ?? asString(obj['sourceRef']);
        const rule = asString(obj['rule']) ?? asString(obj['ruleId']) ?? asString(obj['severity']);
        const line = asNumber(obj['line']);
        haltIssues.push({
            ...(rule !== undefined ? { rule } : {}),
            ...(line !== undefined ? { line } : {}),
            ...(quoteDraft !== undefined ? { quote: quoteDraft } : {}),
            ...(sourceRef !== undefined ? { sourceRef } : {}),
            ...(quoteSource !== undefined ? { sourceQuote: quoteSource } : {}),
            ...(description !== undefined ? { detail: description } : {})
        });
        diagIssues.push({
            ...(description !== undefined ? { description } : {}),
            ...(quoteDraft !== undefined ? { quote_draft: quoteDraft } : {}),
            ...(quoteSource !== undefined ? { quote_source: quoteSource } : {}),
            ...(sourceRef !== undefined ? { source_ref: sourceRef } : {}),
            ...(asString(obj['severity']) !== undefined ? { severity: asString(obj['severity']) } : {}),
            ...(rule !== undefined ? { rule } : {}),
            ...(line !== undefined ? { line } : {})
        });
    }
    return { haltIssues, diagIssues };
}

function parseRawGateViolations(rawList: unknown): VerdictGateViolationItem[] {
    if (!Array.isArray(rawList)) return [];
    const items: VerdictGateViolationItem[] = [];
    for (const entry of rawList) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;
        const rule = asString(obj['rule']) ?? asString(obj['ruleId']) ?? 'GATE';
        const detail = asString(obj['detail']) ?? asString(obj['message']) ?? JSON.stringify(obj);
        const line = asNumber(obj['line']);
        const snippet = asString(obj['snippet']);
        items.push({
            rule,
            detail,
            ...(line !== undefined ? { line } : {}),
            ...(snippet !== undefined ? { snippet } : {}),
            ...(obj['patched'] !== undefined ? { patched: Boolean(obj['patched']) } : {})
        });
    }
    return items;
}

interface ExtractedConflictSideFields {
    leftRef: string | undefined;
    rightRef: string | undefined;
    leftLine: number | undefined;
    rightLine: number | undefined;
    leftExcerpt: string | undefined;
    rightExcerpt: string | undefined;
    affectedChapters: number | undefined;
    affectedWords: number | undefined;
    rollbackThreshold: number | undefined;
}

function extractConflictSideFields(raw: Record<string, unknown>): ExtractedConflictSideFields {
    const sideAChapter = asNumber(raw['side_a_chapter']) ?? asNumber(raw['chapterA']);
    const sideBChapter = asNumber(raw['side_b_chapter']) ?? asNumber(raw['chapterB']);
    return {
        leftRef:
            asString(raw['leftRef']) ??
            asString(raw['left_ref']) ??
            formatChapterFileRef(sideAChapter),
        rightRef:
            asString(raw['rightRef']) ??
            asString(raw['right_ref']) ??
            formatChapterFileRef(sideBChapter),
        leftLine: asNumber(raw['leftLine']) ?? asNumber(raw['left_line']) ?? asNumber(raw['side_a_line']),
        rightLine: asNumber(raw['rightLine']) ?? asNumber(raw['right_line']) ?? asNumber(raw['side_b_line']),
        leftExcerpt:
            asString(raw['leftExcerpt']) ??
            asString(raw['left_excerpt']) ??
            asString(raw['quoteA']) ??
            asString(raw['quote_a']),
        rightExcerpt:
            asString(raw['rightExcerpt']) ??
            asString(raw['right_excerpt']) ??
            asString(raw['quoteB']) ??
            asString(raw['quote_b']),
        affectedChapters:
            asNumber(raw['affectedChapters']) ??
            asNumber(raw['rollback_chapters']) ??
            asNumber(raw['affected_chapters']),
        affectedWords:
            asNumber(raw['affectedWords']) ??
            asNumber(raw['affected_words']) ??
            asNumber(raw['rollback_words']),
        rollbackThreshold:
            asNumber(raw['rollbackThreshold']) ?? asNumber(raw['rollback_threshold'])
    };
}

/** 兼容 snake_case 与 camelCase 解析 SAFE_HALT 载荷 */
export function mapSafeHaltInfo(raw: Record<string, unknown> | null | undefined): SafeHaltInfo | null {
    if (!raw) return null;
    const reason =
        asString(raw['reason']) ??
        asString(raw['message']) ??
        asString(raw['error']) ??
        '检测到连续性冲突，系统已安全挂起';
    const fields = extractConflictSideFields(raw);
    const { haltIssues } = parseRawIssues(raw['issues']);
    const gateViolations = parseRawGateViolations(raw['gateViolations'] ?? raw['gate_violations']);

    return {
        reason,
        stage: asString(raw['stage']),
        chapter: asNumber(raw['chapter']) ?? asNumber(raw['chapterNumber']),
        conflictId: asString(raw['conflictId']) ?? asString(raw['conflict_id']),
        affectedChapters: fields.affectedChapters,
        affectedWords: fields.affectedWords,
        rollbackThreshold: fields.rollbackThreshold,
        leftRef: fields.leftRef,
        rightRef: fields.rightRef,
        leftLine: fields.leftLine,
        rightLine: fields.rightLine,
        leftExcerpt: fields.leftExcerpt,
        rightExcerpt: fields.rightExcerpt,
        ...(haltIssues.length > 0 ? { issues: haltIssues } : {}),
        ...(gateViolations.length > 0 ? { gateViolations } : {}),
        timestamp: asString(raw['timestamp']),
        details: asString(raw['details'])
    };
}

/** 兼容 snake_case 与 camelCase 解析右栏检查器冲突诊断 */
export function mapHaltDiagnostic(haltView: HaltViewPayload | null): HaltDiagnosticInfo | null {
    if (!haltView) return null;
    const raw = haltView.safeHalt ?? haltView.quarantineReport;
    if (!raw) return null;
    const kind: 'SAFE_HALT' | 'QUARANTINED' = haltView.safeHalt ? 'SAFE_HALT' : 'QUARANTINED';
    const reason =
        asString(raw['reason']) ??
        asString(raw['message']) ??
        asString(raw['error']) ??
        '检测到跨章连续性冲突，已触发安全保护';
    const result: HaltDiagnosticInfo = {
        kind,
        reason
    };
    const fields = extractConflictSideFields(raw);
    const timestamp = asString(raw['timestamp']);
    const { diagIssues } = parseRawIssues(raw['issues']);

    if (fields.leftRef !== undefined) result.leftRef = fields.leftRef;
    if (fields.rightRef !== undefined) result.rightRef = fields.rightRef;
    if (fields.leftLine !== undefined) result.leftLine = fields.leftLine;
    if (fields.rightLine !== undefined) result.rightLine = fields.rightLine;
    if (fields.leftExcerpt !== undefined) result.leftExcerpt = fields.leftExcerpt;
    if (fields.rightExcerpt !== undefined) result.rightExcerpt = fields.rightExcerpt;
    if (fields.affectedChapters !== undefined) result.affectedChapters = fields.affectedChapters;
    if (fields.affectedWords !== undefined) result.affectedWords = fields.affectedWords;
    if (fields.rollbackThreshold !== undefined) result.rollbackThreshold = fields.rollbackThreshold;
    if (diagIssues.length > 0) result.issues = diagIssues;
    if (timestamp !== undefined) result.timestamp = timestamp;
    return result;
}

function mapSyncConflictDiagnostic(
    syncView: SyncConflictsViewPayload | null,
    haltView: HaltViewPayload | null
): SyncConflictDiagnostic | null {
    const firstConflict =
        syncView?.conflicts && syncView.conflicts.length > 0 ? syncView.conflicts[0] : null;
    const rawConflict = firstConflict ?? haltView?.quarantineReport ?? null;
    if (!rawConflict) return null;

    const fields = extractConflictSideFields(rawConflict);
    const description =
        asString(rawConflict['description']) ??
        asString(rawConflict['reason']) ??
        asString(rawConflict['message']) ??
        '已落盘章节与设定之间存在跨章冲突';

    return {
        conflictId: asString(rawConflict['conflictId']) ?? asString(rawConflict['conflict_id']),
        description,
        leftRef:
            asString(rawConflict['leftRef']) ??
            asString(rawConflict['left_ref']) ??
            asString(rawConflict['source_ref']) ??
            fields.leftRef ?? (asNumber(rawConflict['dirtyChapter']) ? `第 ${rawConflict['dirtyChapter']} 章` : undefined),
        leftLine: fields.leftLine ?? asNumber(rawConflict['dirtyLineNumber']),
        leftExcerpt:
            asString(rawConflict['leftExcerpt']) ??
            asString(rawConflict['quoteA']) ??
            asString(rawConflict['quote_a']) ??
            asString(rawConflict['dirtyQuote']) ?? asString(rawConflict['quote_source']),
        rightRef: fields.rightRef ?? asString(rawConflict['relativePath']),
        rightLine: fields.rightLine ?? asNumber(rawConflict['lineNumber']),
        rightExcerpt:
            asString(rawConflict['rightExcerpt']) ??
            asString(rawConflict['quoteB']) ??
            asString(rawConflict['quote_b']) ??
            asString(rawConflict['quote']) ?? asString(rawConflict['quote_draft']),
        affectedChapters: fields.affectedChapters,
        affectedWords: fields.affectedWords,
        rollbackThreshold: fields.rollbackThreshold
    };
}

function mapPendingSignals(signalsView: SignalsViewPayload | null): PendingSignalItem[] {
    if (!signalsView) return [];
    const items =
        signalsView.pending ??
        signalsView.signals.slice(Math.max(0, signalsView.signals.length - signalsView.pendingCount));
    return items.map((item) => ({
        type: asString(item.type),
        reason: asString(item['reason']) ?? asString(item.content) ?? asString(item.instruction),
        chapter: asNumber(item['chapter']) ?? asNumber(item.target_chapter),
        suggested_mode: asString(item['suggested_mode']),
        created_at: asString(item.created_at),
        raw: asString(item.raw)
    }));
}

function buildSignalPayload(payload: SubmitSignalPayload): PostSignalRequest {
    const trimmed = payload.content.trim();
    const nowIso = new Date().toISOString();

    if (payload.kind === 'RETCON' || payload.kind === 'Retcon') {
        return {
            type: 'RETCON',
            content: trimmed,
            reason: trimmed,
            created_at: nowIso
        };
    }

    if (payload.kind === 'SPOTLIGHT_TRIGGER') {
        return {
            type: 'SPOTLIGHT_TRIGGER',
            content: trimmed,
            reason: trimmed,
            ...(payload.entityId ? { entity_id: payload.entityId } : {}),
            created_at: nowIso
        };
    }

    if (payload.kind === 'FLASHBACK') {
        return {
            type: 'DIRECTOR_NOTE',
            content: trimmed,
            reason: trimmed,
            suggested_mode: 'FLASHBACK',
            ...(payload.targetDay !== undefined ? { target_day: payload.targetDay } : {}),
            created_at: nowIso
        };
    }

    if (payload.kind === 'PARALLEL') {
        return {
            type: 'DIRECTOR_NOTE',
            content: trimmed,
            reason: trimmed,
            suggested_mode: 'PARALLEL',
            created_at: nowIso
        };
    }

    return {
        type: 'DIRECTOR_NOTE',
        content: trimmed,
        reason: trimmed,
        suggested_mode: 'MAINLINE',
        created_at: nowIso
    };
}

function deriveStageArtifact(latestSseStage: string | null): StageArtifactTelemetry {
    if (!latestSseStage) {
        return {
            selectedStageIndex: 0,
            stageName: '待命',
            stageStatus: '就绪',
            stageSummary: '等待推进下一章或连续生成指令'
        };
    }
    if (latestSseStage === 'COMMITTED') {
        return {
            selectedStageIndex: 4,
            stageName: '5. Extractor',
            stageStatus: '已完成',
            stageSummary: '本章正文与人物台账已双提交入库'
        };
    }
    if (latestSseStage === 'PROSE_GATE' || latestSseStage === 'LOCAL_PATCH') {
        const isPatch = latestSseStage === 'LOCAL_PATCH';
        return {
            selectedStageIndex: 2,
            stageName: '3. Writer · 静态门禁',
            stageStatus: isPatch ? '门禁润色' : '门禁扫描',
            stageSummary: isPatch
                ? '静态门禁拦截，局部润色自愈中'
                : '0-LLM 确定性文风门禁校验中'
        };
    }
    const resolved = resolveStageId(latestSseStage);
    const idx = resolved ? PIPELINE_STAGE_META.findIndex((item) => item.id === resolved) : -1;
    if (idx >= 0) {
        const meta = PIPELINE_STAGE_META[idx]!;
        return {
            selectedStageIndex: idx,
            stageName: meta.label,
            stageStatus: '运行中',
            stageSummary: DEFAULT_STAGE_SUMMARIES[meta.id]
        };
    }
    return {
        selectedStageIndex: 0,
        stageName: latestSseStage,
        stageStatus: latestSseStage,
        stageSummary: `当前处于 ${latestSseStage} 阶段`
    };
}

const STAGE_SEQUENCE: readonly PipelineStageId[] = [
    'LIBRARIAN',
    'PLANNER',
    'WRITER',
    'FACT_CHECKER',
    'EXTRACTOR',
    'DREAMING'
];

function readActiveStage(status: NarrateStatusPayload): string | null {
    const task = status.runtime.activeTask;
    const stage = status.yolo.currentStage;
    if (!stage || task === 'IDLE') return null;
    return resolveStageId(stage) ? stage : null;
}

function mapRunStatusToStageStatus(rawStatus: string): StageNodeStatus {
    const normalized = rawStatus.trim().toLowerCase();
    if (normalized === 'running' || normalized === 'active' || normalized === 'in_progress') {
        return 'active';
    }
    if (normalized === 'healing' || normalized === 'patch' || normalized === 'replan' || normalized === 'rewrite') {
        return 'healing';
    }
    if (normalized === 'halt' || normalized === 'failed' || normalized === 'error' || normalized === 'blocked') {
        return 'halt';
    }
    if (normalized === 'dormant' || normalized === 'skipped') {
        return 'dormant';
    }
    return 'done';
}

function resolveRepairBadge(stageName: string): string | undefined {
    return STAGE_REPAIR_META[stageName.trim().toUpperCase()]?.badge;
}

function isRunningSessionStatus(status: string): boolean {
    const normalized = status.trim().toLowerCase();
    return normalized === 'running' || normalized === 'active' || normalized === 'in_progress';
}

function updateStageSessionsToTerminal(
    sessions: readonly StageAttemptSession[] | undefined,
    terminalStatus: 'completed' | 'failed'
): StageAttemptSession[] | undefined {
    if (!sessions) return undefined;
    return sessions.map((item) =>
        isRunningSessionStatus(item.status) ? { ...item, status: terminalStatus } : item
    );
}

function buildStageAttemptEntry(fields: {
    stage: string;
    status: string;
    sessionId: string;
    runId?: string | undefined;
    role?: string | undefined;
    parentSessionId?: string | undefined;
    attempt?: number | undefined;
    triggerReason?: string | undefined;
    mode?: string | undefined;
    updatedAt?: string | undefined;
}): StageAttemptSession {
    const out: StageAttemptSession = {
        stage: fields.stage,
        status: fields.status,
        sessionId: fields.sessionId
    };
    if (fields.runId !== undefined) out.runId = fields.runId;
    if (fields.role !== undefined) out.role = fields.role;
    if (fields.parentSessionId !== undefined) out.parentSessionId = fields.parentSessionId;
    if (fields.attempt !== undefined) out.attempt = fields.attempt;
    if (fields.triggerReason !== undefined) out.triggerReason = fields.triggerReason;
    if (fields.mode !== undefined) out.mode = fields.mode;
    if (fields.updatedAt !== undefined) out.updatedAt = fields.updatedAt;
    return out;
}

function upsertStageSession(
    list: readonly StageAttemptSession[] | undefined,
    entry: StageAttemptSession
): StageAttemptSession[] {
    const prev = list ? [...list] : [];
    const existingIdx = prev.findIndex((item) => item.sessionId === entry.sessionId);
    if (existingIdx >= 0) {
        const existing = prev[existingIdx]!;
        const keepExistingStage = entry.stage.trim().toUpperCase() === 'PROSE_GATE';
        prev[existingIdx] = buildStageAttemptEntry({
            stage: keepExistingStage ? existing.stage : entry.stage,
            status: entry.status,
            sessionId: entry.sessionId,
            runId: entry.runId ?? existing.runId,
            role: entry.role ?? existing.role,
            parentSessionId: entry.parentSessionId ?? existing.parentSessionId,
            attempt: entry.attempt ?? existing.attempt,
            triggerReason: entry.triggerReason ?? existing.triggerReason,
            mode: entry.mode ?? existing.mode,
            updatedAt: entry.updatedAt ?? existing.updatedAt
        });
        return prev;
    }

    const finalizedPrev = prev.map((item) =>
        isRunningSessionStatus(item.status) ? { ...item, status: 'completed' } : item
    );
    finalizedPrev.push(entry);
    return finalizedPrev;
}

function mergeStageSessions(
    base: readonly StageAttemptSession[] | undefined,
    incoming: readonly StageAttemptSession[] | undefined
): StageAttemptSession[] {
    let acc: StageAttemptSession[] = base ? [...base] : [];
    if (incoming) {
        for (const item of incoming) {
            acc = upsertStageSession(acc, item);
        }
    }
    return acc;
}

function deriveHistoricalStageOverrides(
    runs: readonly StageRunRecord[]
): Partial<Record<PipelineStageId, StageNodeState>> {
    const mapped: Partial<Record<PipelineStageId, StageNodeState>> = {};
    for (const run of runs) {
        if (typeof run?.stage !== 'string') continue;
        const stageId = resolveStageId(run.stage);
        if (!stageId) continue;
        const existing = mapped[stageId];
        const sessionId = asString(run.sessionId);
        const parentSessionId = asString(run.parentSessionId);
        const mode = asString(run.mode);
        const role = asString(run.role);
        const triggerReason = asString(run.triggerReason);
        const updatedAt = run.finishedAt ?? run.startedAt ?? run.timestamp;
        const badge = resolveRepairBadge(run.stage) ?? existing?.badge;
        let sessions = existing?.sessions;
        if (sessionId !== undefined) {
            sessions = upsertStageSession(
                existing?.sessions,
                buildStageAttemptEntry({
                    runId: run.runId,
                    stage: run.stage,
                    status: run.status,
                    sessionId,
                    role,
                    parentSessionId,
                    attempt: run.attempt,
                    triggerReason,
                    mode,
                    updatedAt
                })
            );
        }
        const nextNode: StageNodeState = {
            status: mapRunStatusToStageStatus(run.status),
            summary: DEFAULT_STAGE_SUMMARIES[stageId],
            updatedAt: updatedAt ?? existing?.updatedAt,
            runId: run.runId
        };
        const mergedSessionId = sessionId ?? existing?.sessionId;
        const mergedParentSessionId = parentSessionId ?? existing?.parentSessionId;
        const mergedMode = mode ?? existing?.mode;
        if (badge !== undefined) nextNode.badge = badge;
        if (mergedSessionId !== undefined) nextNode.sessionId = mergedSessionId;
        if (mergedParentSessionId !== undefined) nextNode.parentSessionId = mergedParentSessionId;
        if (mergedMode !== undefined) nextNode.mode = mergedMode;
        if (sessions && sessions.length > 0) nextNode.sessions = sessions;
        mapped[stageId] = nextNode;
    }
    return mapped;
}

function settleRunningStages(
    prev: Partial<Record<PipelineStageId, StageNodeState>>,
    options: {
        targetNodeStatus: 'done' | 'halt';
        terminalSessionStatus: 'completed' | 'failed';
        includeDreaming?: boolean;
        beforeIndex?: number;
        skipStageId?: PipelineStageId;
    }
): Partial<Record<PipelineStageId, StageNodeState>> {
    const next: Partial<Record<PipelineStageId, StageNodeState>> = { ...prev };
    for (let i = 0; i < STAGE_SEQUENCE.length; i++) {
        const id = STAGE_SEQUENCE[i]!;
        if (!options.includeDreaming && id === 'DREAMING') continue;
        if (options.skipStageId && id === options.skipStageId) continue;
        if (options.beforeIndex !== undefined && i >= options.beforeIndex) continue;
        const cur = next[id];
        if (!cur || (cur.status !== 'active' && cur.status !== 'healing')) continue;
        const updatedSessions = updateStageSessionsToTerminal(
            cur.sessions,
            options.terminalSessionStatus
        );
        const settled: StageNodeState = {
            ...cur,
            status: options.targetNodeStatus
        };
        if (updatedSessions) {
            settled.sessions = updatedSessions;
        }
        next[id] = settled;
    }
    return next;
}

function resolveIncomingNodeStatus(
    upperStage: string,
    rawStatus: string | undefined,
    existingStatus: StageNodeStatus | undefined
): StageNodeStatus {
    const mappedRawStatus = rawStatus ? mapRunStatusToStageStatus(rawStatus) : undefined;
    if (mappedRawStatus !== undefined && mappedRawStatus !== 'active') {
        return mappedRawStatus;
    }
    if (
        Boolean(STAGE_REPAIR_META[upperStage]) ||
        (upperStage === 'PROSE_GATE' && existingStatus === 'healing')
    ) {
        return 'healing';
    }
    return mappedRawStatus ?? 'active';
}

function formatVolumeAdvancedToast(
    completedBook: boolean,
    sealedVolume: number | undefined
): string {
    if (completedBook) return '全书已完结封笔';
    if (sealedVolume !== undefined) return `第 ${sealedVolume} 卷已封存，已开启新卷`;
    return '换卷封存完成';
}

function resolveLayoutClass(isWide: boolean, isCompact: boolean): string {
    if (isWide) return 'ns-layout-wide';
    if (isCompact) return 'ns-layout-compact';
    return 'ns-layout-medium';
}

function resolveTxLockInfo(
    txLockHeld: boolean | undefined,
    activeTask: RuntimeTaskKind
): { txLockStatus: 'locked' | 'free'; txLockHolder: string | null } {
    const isLocked = txLockHeld !== undefined ? txLockHeld : activeTask !== 'IDLE';
    const hasHolder = Boolean(txLockHeld) || activeTask !== 'IDLE';
    return {
        txLockStatus: isLocked ? 'locked' : 'free',
        txLockHolder: hasHolder ? activeTask : null
    };
}

function formatAttemptLabel(attempt: StageAttemptSession): string {
    const upper = attempt.stage.trim().toUpperCase();
    if (upper === 'LOCAL_PATCH' || attempt.role?.toLowerCase() === 'patch') {
        return `局部润色 (Patch${attempt.attempt ? ` #${attempt.attempt}` : ''})`;
    }
    if (upper === 'REWRITE') {
        return `整章重写${attempt.attempt ? ` #${attempt.attempt}` : ''}`;
    }
    if (upper === 'REPLAN') {
        return `重排细纲${attempt.attempt ? ` #${attempt.attempt}` : ''}`;
    }
    if (upper === 'WRITER') {
        return '初稿执笔 (Writer)';
    }
    return `${attempt.stage}${attempt.attempt ? ` #${attempt.attempt}` : ''}`;
}

export interface NarrateStudioRootProps {
    sessionsService?: StudioSessionsService | undefined;
    SessionProvider?: StudioSessionProviderComponent | undefined;
    renderStageConversation?: StudioRenderStageConversation | undefined;
    requestScope?: StudioRequestScope | undefined;
    sharedDrafts?: React.MutableRefObject<DraftStashMap> | undefined;
}

/**
 * NarrateOS Operator Studio 前端根组件
 */
export function NarrateStudioRoot({
    sessionsService,
    SessionProvider,
    renderStageConversation,
    requestScope,
    sharedDrafts
}: NarrateStudioRootProps = {}): React.ReactElement {
    // 作用域由宿主按工作区重新挂载；旧回调只持有旧库根。
    const scopeArgs = useMemo<[] | [StudioRequestScope]>(() => requestScope ? [requestScope] : [], [requestScope]);
    const [booksState, setBooksState] = useState<BooksListPayload>({
        currentBookRoot: '',
        books: []
    });
    const [status, setStatus] = useState<NarrateStatusPayload | null>(null);
    const [chapters, setChapters] = useState<ChapterSummary[]>([]);
    const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
    const [chapterDetail, setChapterDetail] = useState<ChapterDetail | null>(null);

    const [entitiesView, setEntitiesView] = useState<EntitiesViewPayload | null>(null);
    const [horizonView, setHorizonView] = useState<MarkdownViewPayload | null>(null);
    const [threadsView, setThreadsView] = useState<MarkdownViewPayload | null>(null);
    const [telemetryView, setTelemetryView] = useState<TelemetryViewPayload | null>(null);
    const [signalsView, setSignalsView] = useState<SignalsViewPayload | null>(null);
    const [haltView, setHaltView] = useState<HaltViewPayload | null>(null);
    const [syncConflictsView, setSyncConflictsView] = useState<SyncConflictsViewPayload | null>(null);

    const [latestSseStage, setLatestSseStage] = useState<string | null>(null);
    const stageEventVersionRef = useRef(0);
    const setSseStage = useCallback((stage: string | null) => {
        stageEventVersionRef.current += 1;
        setLatestSseStage(stage);
    }, []);
    const [haltWaiting, setHaltWaiting] = useState(false);
    const [stageOverrides, setStageOverrides] = useState<Partial<Record<PipelineStageId, StageNodeState>>>({});
    const stageOverridesRef = useRef<Partial<Record<PipelineStageId, StageNodeState>>>({});
    const applyStageOverrides = useCallback(
        (
            updater:
                | Partial<Record<PipelineStageId, StageNodeState>>
                | ((
                      prev: Partial<Record<PipelineStageId, StageNodeState>>
                  ) => Partial<Record<PipelineStageId, StageNodeState>>)
        ) => {
            const next =
                typeof updater === 'function' ? updater(stageOverridesRef.current) : updater;
            stageOverridesRef.current = next;
            setStageOverrides(next);
        },
        []
    );
    const [historicalRuns, setHistoricalRuns] = useState<StageRunRecord[]>([]);
    const [liveRunChapter, setLiveRunChapter] = useState<number | null>(null);
    const [inspectedStageId, setInspectedStageId] = useState<PipelineStageId | null>(null);
    const [selectedStageSession, setSelectedStageSession] = useState<StageSessionSelection | null>(null);
    const [liveSessionEvents, setLiveSessionEvents] = useState<Record<string, StageSessionDetailEvent[]>>({});
    const [liveTelemetry, setLiveTelemetry] = useState<TelemetryItem | null>(null);
    const [gateViolations, setGateViolations] = useState<ProseGateViolationItem[]>([]);
    const [factChecker, setFactChecker] = useState<FactCheckerTelemetry>({
        totalChecked: 0,
        verifiedPassCount: 0,
        filteredOutCount: 0,
        blockedCount: 0
    });
    const [revealNonce, setRevealNonce] = useState(0);

    const [loading, setLoading] = useState<boolean>(true);
    const [bootModalOpen, setBootModalOpen] = useState<boolean>(false);
    const [volumeModalOpen, setVolumeModalOpen] = useState<boolean>(false);
    const [volumeSubmitting, setVolumeSubmitting] = useState<boolean>(false);
    const [volumeError, setVolumeError] = useState<string | null>(null);
    const [parallelModalOpen, setParallelModalOpen] = useState<boolean>(false);
    const [parallelSubmitting, setParallelSubmitting] = useState<boolean>(false);
    const [parallelError, setParallelError] = useState<string | null>(null);
    const [activeParallelWindowId, setActiveParallelWindowId] = useState<string>('');
    const [activeParallelBranchId, setActiveParallelBranchId] = useState<string>('');

    const [activeViewKind, setActiveViewKind] = useState<MaterializedViewKind | null>(null);
    const [externalViewCommand, setExternalViewCommand] = useState<ExternalViewCommand | undefined>(undefined);
    const [toasts, setToasts] = useState<ToastState[]>([]);

    // 容器感知三栏布局断点（ResizeObserver 监听 .ns-studio-shell 实测宽度）
    const [containerWidth, setContainerWidth] = useState<number>(() =>
        typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280
    );
    const [leftOpen, setLeftOpen] = useState<boolean>(() =>
        readStoredBoolean(LEFT_OPEN_STORAGE_KEY, true)
    );
    const [leftWidth, setLeftWidth] = useState<number>(() =>
        readStoredWidth(LEFT_WIDTH_STORAGE_KEY, LEFT_WIDTH_DEFAULT, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX)
    );
    const [rightWidth, setRightWidth] = useState<number>(() =>
        readStoredWidth(
            RIGHT_WIDTH_STORAGE_KEY,
            RIGHT_WIDTH_DEFAULT,
            RIGHT_WIDTH_MIN,
            RIGHT_WIDTH_MAX
        )
    );
    const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(null);
    const dragRef = useRef<{
        side: 'left' | 'right';
        startX: number;
        startWidth: number;
        latestWidth: number;
    } | null>(null);
    const [rightOpen, setRightOpen] = useState<boolean>(() =>
        typeof window !== 'undefined'
            ? (window.innerWidth || 1280) >= COMPACT_BREAKPOINT_PX
            : true
    );
    const [rightTab, setRightTab] = useState<'trace' | 'status' | 'routing'>('trace');

    const shellRef = useRef<HTMLDivElement | null>(null);
    const prevWidthRef = useRef<number>(containerWidth);
    const viewCommandNonceRef = useRef<number>(0);
    const selectedChapterRef = useRef<number | null>(null);
    selectedChapterRef.current = selectedChapter;

    const toastSeqRef = useRef(0);
    const showToast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
        toastSeqRef.current += 1;
        const nextToast: ToastState = { id: toastSeqRef.current, message, kind };
        setToasts((prev) => [...prev.slice(-2), nextToast]);
    }, []);

    useEffect(() => {
        ensureStudioStyles();
    }, []);

    useEffect(() => {
        const el = shellRef.current;
        if (!el || typeof window === 'undefined') return;

        const measureFallbackWidth = (): number =>
            el.clientWidth > 0 ? el.clientWidth : window.innerWidth || 1280;

        const updateWidth = (width: number) => {
            if (width <= 0) return;
            setContainerWidth(width);
            if (prevWidthRef.current >= COMPACT_BREAKPOINT_PX && width < COMPACT_BREAKPOINT_PX) {
                setRightOpen(false);
            }
            prevWidthRef.current = width;
        };

        updateWidth(measureFallbackWidth());

        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (entry) {
                    const nextW =
                        entry.contentRect.width > 0
                            ? entry.contentRect.width
                            : measureFallbackWidth();
                    updateWidth(nextW);
                }
            });
            observer.observe(el);
            return () => observer.disconnect();
        }

        const onResize = () => updateWidth(measureFallbackWidth());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    const workspaceEpochRef = useRef(0);
    const switchingBookRef = useRef(false);
    const refreshRequestRef = useRef(0);
    const viewsRequestRef = useRef(0);
    const statusRequestRef = useRef(0);
    const saveInFlightRef = useRef(false);
    useLayoutEffect(() => () => {
        workspaceEpochRef.current += 1;
    }, []);
    const isCurrentWorkspace = useCallback(
        (epoch: number) => epoch === workspaceEpochRef.current && !switchingBookRef.current,
        []
    );

    const loadStatus = useCallback(async () => {
        if (switchingBookRef.current) return;
        const epoch = workspaceEpochRef.current;
        const seq = ++statusRequestRef.current;
        const stageVersion = stageEventVersionRef.current;
        const next = await fetchStatus(...scopeArgs);
        if (
            isCurrentWorkspace(epoch) &&
            seq === statusRequestRef.current &&
            (!currentBookRootRef.current || next.bookRoot === currentBookRootRef.current)
        ) {
            setStatus(next);
            if (stageVersion === stageEventVersionRef.current) {
                setLatestSseStage(readActiveStage(next));
            }
        }
    }, [isCurrentWorkspace, scopeArgs]);

    const loadViews = useCallback(async () => {
        if (switchingBookRef.current) return;
        const epoch = workspaceEpochRef.current;
        const seq = ++viewsRequestRef.current;
        const [entities, horizon, threads, telemetry, signals, halt, syncConflicts] = await Promise.all([
            fetchViewEntities(...scopeArgs).catch(() => null),
            fetchViewHorizon(...scopeArgs).catch(() => null),
            fetchViewThreads(...scopeArgs).catch(() => null),
            fetchViewTelemetry(...scopeArgs).catch(() => null),
            fetchViewSignals(...scopeArgs).catch(() => null),
            fetchViewHalt(...scopeArgs).catch(() => null),
            fetchViewSyncConflicts(...scopeArgs).catch(() => null)
        ]);
        if (!isCurrentWorkspace(epoch) || seq !== viewsRequestRef.current) return;
        if (entities) setEntitiesView(entities);
        if (horizon) setHorizonView(horizon);
        if (threads) setThreadsView(threads);
        if (telemetry) setTelemetryView(telemetry);
        if (signals) setSignalsView(signals);
        if (halt) setHaltView(halt);
        if (syncConflicts) setSyncConflictsView(syncConflicts);
    }, [isCurrentWorkspace]);

    const [chapterLoading, setChapterLoading] = useState<boolean>(false);
    const chapterRequestSeqRef = useRef(0);
    const runsRequestSeqRef = useRef(0);
    const currentBookRootRef = useRef<string>('');

    const loadRunsForChapter = useCallback(
        async (chapterNumber: number | null) => {
            if (switchingBookRef.current) return;
            if (chapterNumber === null || !Number.isFinite(chapterNumber) || chapterNumber <= 0) {
                setHistoricalRuns([]);
                return;
            }
            const seq = ++runsRequestSeqRef.current;
            const epoch = workspaceEpochRef.current;
            const bookRoot = currentBookRootRef.current;
            try {
                const payload = await fetchRunRecords(chapterNumber, ...scopeArgs);
                if (!isCurrentWorkspace(epoch) || seq !== runsRequestSeqRef.current) return;
                if (bookRoot && currentBookRootRef.current && bookRoot !== currentBookRootRef.current) return;
                setHistoricalRuns(payload.runs);
            } catch {
                if (isCurrentWorkspace(epoch) && seq === runsRequestSeqRef.current) {
                    setHistoricalRuns([]);
                }
            }
        },
        [isCurrentWorkspace]
    );

    const activeTask = status?.runtime.activeTask ?? 'IDLE';
    const isBusy = activeTask !== 'IDLE' || Boolean(status?.yolo.running);

    // 非阻断式草稿守卫与内存暂存表（DraftStashMap）
    const [draftLocation, setDraftLocation] = useState<DraftLocation | null>(null);
    const draftLocationRef = useRef<DraftLocation | null>(null);
    const [draftStash, setDraftStash] = useState<DraftStashMap>(() => sharedDrafts?.current ?? {});
    const localDrafts = useRef<DraftStashMap>({});
    const draftStashRef = sharedDrafts ?? localDrafts;

    useLayoutEffect(() => {
        if (!sharedDrafts) return;
        setDraftStash(sharedDrafts.current);
        return () => {
            const draft = draftLocationRef.current;
            if (draft) {
                sharedDrafts.current = putStashedDraft(sharedDrafts.current, { ...draft, updatedAt: Date.now() });
            }
        };
    }, [sharedDrafts]);

    const handleDraftDirtyChange = useCallback((dirty: DraftLocation | null) => {
        draftLocationRef.current = dirty;
        setDraftLocation(dirty);
    }, []);

    const draftControlRef = useRef<CenterWorkbenchDraftHandle | null>(null);
    const handleDraftControlReady = useCallback((handle: CenterWorkbenchDraftHandle | null) => {
        draftControlRef.current = handle;
    }, []);

    const stashCurrentDraftIfDirty = useCallback(
        (toastMessage?: string): boolean => {
            const draft = draftLocationRef.current;
            if (!draft || !draft.bookRoot || draft.chapterNumber <= 0) {
                return false;
            }
            const entry: StashedDraftEntry = {
                ...draft,
                updatedAt: Date.now()
            };
            const nextStash = putStashedDraft(draftStashRef.current, entry);
            draftStashRef.current = nextStash;
            setDraftStash(nextStash);
            draftLocationRef.current = null;
            setDraftLocation(null);
            draftControlRef.current?.resetDraft();
            if (toastMessage) {
                showToast(toastMessage);
            }
            return true;
        },
        [showToast]
    );

    // 浏览器关闭/刷新前统一用 hasAnyUnsavedDraft 保护全部在编/暂存草稿
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onBeforeUnload = (ev: BeforeUnloadEvent) => {
            if (!hasAnyUnsavedDraft(draftStashRef.current, draftLocationRef.current !== null)) {
                return;
            }
            ev.preventDefault();
            ev.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, []);

    const loadChapterByNumber = useCallback(
        async (chapterNumber: number) => {
            if (switchingBookRef.current || !Number.isFinite(chapterNumber) || chapterNumber <= 0) {
                return;
            }
            const seq = ++chapterRequestSeqRef.current;
            const epoch = workspaceEpochRef.current;
            setChapterLoading(true);
            try {
                const detail = await fetchChapter(chapterNumber, ...scopeArgs);
                if (!isCurrentWorkspace(epoch) || seq !== chapterRequestSeqRef.current) return;
                if (detail.bookRoot !== currentBookRootRef.current || detail.chapterNumber !== chapterNumber) return;
                const dirtyNow = draftLocationRef.current;
                if (
                    dirtyNow &&
                    (dirtyNow.chapterNumber !== detail.chapterNumber ||
                        dirtyNow.bookRoot !== currentBookRootRef.current)
                ) {
                    return;
                }
                setSelectedChapter(detail.chapterNumber);
                setChapterDetail(detail);
                setInspectedStageId((prev) =>
                    selectedChapterRef.current !== null && selectedChapterRef.current !== detail.chapterNumber
                        ? null
                        : prev
                );
                void loadRunsForChapter(detail.chapterNumber);
            } catch (err) {
                if (!isCurrentWorkspace(epoch) || seq !== chapterRequestSeqRef.current) return;
                showToast(err instanceof Error ? err.message : String(err), 'error');
            } finally {
                if (isCurrentWorkspace(epoch) && seq === chapterRequestSeqRef.current) {
                    setChapterLoading(false);
                }
            }
        },
        [isCurrentWorkspace, loadRunsForChapter, showToast]
    );

    const refreshAll = useCallback(
        async (preferredChapter?: number | null) => {
            if (switchingBookRef.current) return;
            const epoch = workspaceEpochRef.current;
            const seq = ++refreshRequestRef.current;
            const statusSeq = ++statusRequestRef.current;
            const stageVersion = stageEventVersionRef.current;
            const chapterSeq = chapterRequestSeqRef.current;
            setLoading(true);
            try {
                let booksRes = await fetchBooks(...scopeArgs);
                if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
                if (requestScope && booksRes.scopeBooksRoot) requestScope.booksRoot = booksRes.scopeBooksRoot;

                if (!booksRes.currentBookRoot && booksRes.books.length > 0 && !currentBookRootRef.current) {
                    const defaultBook = booksRes.books[0];
                    if (defaultBook) {
                        await selectBook({ bookRoot: defaultBook.bookRoot }, ...scopeArgs);
                        if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
                        booksRes = await fetchBooks(...scopeArgs);
                        if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
                    }
                }

                setBooksState(booksRes);
                const activeRoot = booksRes.currentBookRoot;
                if (!activeRoot) {
                    currentBookRootRef.current = '';
                    setChapters([]);
                    setSelectedChapter(null);
                    setChapterDetail(null);
                    setHistoricalRuns([]);
                    setEntitiesView(null);
                    setHorizonView(null);
                    setThreadsView(null);
                    setTelemetryView(null);
                    setSignalsView(null);
                    setHaltView(null);
                    setSyncConflictsView(null);
                    const noBookStatus = await fetchStatus(...scopeArgs).catch(() => null);
                    if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
                    if (statusSeq === statusRequestRef.current) {
                        setStatus(noBookStatus);
                    }
                    return;
                }

                const [statusRes, chaptersRes] = await Promise.all([
                    fetchStatus(...scopeArgs),
                    fetchChapters(...scopeArgs),
                    loadViews()
                ]);
                if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current) return;
                if (
                    activeRoot !== statusRes.bookRoot ||
                    (currentBookRootRef.current && activeRoot !== currentBookRootRef.current)
                ) {
                    return;
                }

                currentBookRootRef.current = activeRoot;
                if (statusSeq === statusRequestRef.current) {
                    setStatus(statusRes);
                    if (stageVersion === stageEventVersionRef.current) {
                        const activeStage = readActiveStage(statusRes);
                        setLatestSseStage(activeStage);
                        if (statusRes.runtime.activeTask === 'STEPPING' ||
                            (activeStage && statusRes.runtime.activeTask === 'DREAMING')) {
                            const runningChapter = statusRes.activeChapter ||
                                (statusRes.runtime.activeTask === 'STEPPING' ? statusRes.latestChapter + 1 : statusRes.latestChapter);
                            setLiveRunChapter(runningChapter);
                            void fetchRunRecords(runningChapter, ...scopeArgs).then(({ runs }) => {
                                if (!isCurrentWorkspace(epoch) || seq !== refreshRequestRef.current ||
                                    statusSeq !== statusRequestRef.current || stageVersion !== stageEventVersionRef.current) return;
                                applyStageOverrides(deriveHistoricalStageOverrides(
                                    runs.filter((record) => record.chapter === runningChapter)
                                ));
                            }).catch(() => {});
                        }
                    }
                }
                setChapters(chaptersRes.chapters);
                // 每次全量刷新清除瞬态 liveTelemetry 覆盖层，确保展现持久化遥测或最新值
                setLiveTelemetry(null);

                const draft = draftLocationRef.current;
                if (draft && draft.bookRoot === booksRes.currentBookRoot) {
                    setSelectedChapter(draft.chapterNumber);
                    return;
                }
                if (chapterSeq !== chapterRequestSeqRef.current) return;

                const fallbackChapter =
                    chaptersRes.chapters.length > 0
                        ? chaptersRes.chapters[chaptersRes.chapters.length - 1]!.chapterNumber
                        : null;
                const candidate =
                    preferredChapter ??
                    statusRes.activeChapter ??
                    (statusRes.latestChapter > 0 ? statusRes.latestChapter : fallbackChapter);

                if (candidate !== null && candidate > 0) {
                    await loadChapterByNumber(candidate);
                } else {
                    setSelectedChapter(null);
                    setChapterDetail(null);
                    await loadRunsForChapter(null);
                }
            } catch (err) {
                if (isCurrentWorkspace(epoch) && seq === refreshRequestRef.current) {
                    showToast(err instanceof Error ? err.message : String(err), 'error');
                }
            } finally {
                if (isCurrentWorkspace(epoch) && seq === refreshRequestRef.current) setLoading(false);
            }
        },
        [applyStageOverrides, isCurrentWorkspace, loadChapterByNumber, loadRunsForChapter, loadViews, scopeArgs, showToast]
    );

    useEffect(() => {
        void refreshAll();
    }, [refreshAll]);

    const refreshAllRef = useRef(refreshAll);
    refreshAllRef.current = refreshAll;
    const loadViewsRef = useRef(loadViews);
    loadViewsRef.current = loadViews;
    const loadChapterRef = useRef(loadChapterByNumber);
    loadChapterRef.current = loadChapterByNumber;
    const loadRunsRef = useRef(loadRunsForChapter);
    loadRunsRef.current = loadRunsForChapter;

    // 订阅全量 25 类 SSE 事件
    useEffect(() => {
        if (requestScope && !booksState.scopeBooksRoot) return;
        const handleSseEvent = (payload: SseEventPayload) => {
            const { event, data } = payload;

            if (event === 'book_switched') {
                if (switchingBookRef.current) return;
                const bookRoot = asString(data['bookRoot']);
                if (!bookRoot || bookRoot === currentBookRootRef.current) return;
                // 外部切书：自动暂存旧书未保存草稿，并立即清空旧书正文杜绝串书残留
                stashCurrentDraftIfDirty('已自动暂存原作品未保存草稿并切换至新作品');
                workspaceEpochRef.current += 1;
                chapterRequestSeqRef.current += 1;
                runsRequestSeqRef.current += 1;
                currentBookRootRef.current = bookRoot;
                setActiveParallelWindowId('');
                setActiveParallelBranchId('');
                setActiveViewKind(null);
                viewCommandNonceRef.current += 1;
                setExternalViewCommand({
                    viewTab: 'prose',
                    nonce: viewCommandNonceRef.current
                });
                setEntitiesView(null);
                setHorizonView(null);
                setThreadsView(null);
                setSignalsView(null);
                setHaltView(null);
                setFactChecker({
                    totalChecked: 0,
                    verifiedPassCount: 0,
                    filteredOutCount: 0,
                    blockedCount: 0
                });
                setChapterDetail(null);
                setSelectedChapter(null);
                setHaltWaiting(false);
                setSseStage(null);
                applyStageOverrides({});
                setInspectedStageId(null);
                setHistoricalRuns([]);
                setLiveRunChapter(null);
                setSelectedStageSession(null);
                setLiveSessionEvents({});
                setLiveTelemetry(null);
                setTelemetryView(null);
                setGateViolations([]);
                setSyncConflictsView(null);
                showToast('已切换当前作品仓库');
                void refreshAllRef.current(null);
                return;
            }
            if (switchingBookRef.current) return;

            if (event === 'default_model_changed') {
                setStatus((prev) => {
                    if (!prev) return prev;
                    const next: NarrateStatusPayload = { ...prev };
                    if ('defaultModel' in data) {
                        next.defaultModel =
                            (data['defaultModel'] as NarrateStatusPayload['defaultModel']) ?? null;
                    }
                    if (Array.isArray(data['availableModels'])) {
                        next.availableModels =
                            data['availableModels'] as NarrateStatusPayload['availableModels'];
                    }
                    if (data['poolOverrides'] && typeof data['poolOverrides'] === 'object') {
                        next.poolOverrides = data['poolOverrides'] as Record<string, string>;
                    }
                    if (data['modelRouting'] && typeof data['modelRouting'] === 'object') {
                        next.modelRouting = data['modelRouting'] as Record<string, string>;
                    }
                    if (Array.isArray(data['roleDefinitions'])) {
                        next.roleDefinitions =
                            data['roleDefinitions'] as NarrateStatusPayload['roleDefinitions'];
                    }
                    return next;
                });
                void loadStatus().catch(() => undefined);
                return;
            }

            if (event === 'stage:event') {
                const sessionId = asString(data['sessionId']);
                const kind = asString(data['kind']) ?? 'text';
                if (!sessionId) return;
                const nextEv: StageSessionDetailEvent = {
                    kind,
                    ...(typeof data['seq'] === 'number' ? { seq: data['seq'] } : {}),
                    ...(asString(data['text']) !== undefined ? { text: asString(data['text']) } : {}),
                    ...(asString(data['toolName']) !== undefined ? { toolName: asString(data['toolName']) } : {}),
                    ...(asString(data['callId']) !== undefined ? { callId: asString(data['callId']) } : {}),
                    ...(asString(data['status']) !== undefined ? { status: asString(data['status']) } : {})
                };
                setLiveSessionEvents((prev) => {
                    const existing = prev[sessionId] ?? [];
                    const appended =
                        existing.length >= MAX_LIVE_EVENTS_PER_SESSION
                            ? [...existing.slice(-(MAX_LIVE_EVENTS_PER_SESSION - 1)), nextEv]
                            : [...existing, nextEv];
                    return { ...prev, [sessionId]: appended };
                });
                return;
            }

            if (event === 'stage' || event === 'chapter:phase' || event === 'stage:session') {
                const stageName = asString(data['stage']) ?? asString(data['phase']);
                if (!stageName) return;

                if (stageName === 'STARTING') {
                    setHaltWaiting(false);
                    applyStageOverrides({});
                    setInspectedStageId(null);
                    setLiveTelemetry(null);
                    setGateViolations([]);
                    setLiveSessionEvents({});
                    setLiveRunChapter(asNumber(data['chapterNumber']) ?? asNumber(data['chapter']) ?? null);
                    setSseStage(null);
                    setStatus((prev) =>
                        prev
                            ? {
                                  ...prev,
                                  yolo: { ...prev.yolo, stopRequested: false },
                                  runtime: { ...prev.runtime, activeTask: 'STEPPING', haltRequested: false }
                              }
                            : prev
                    );
                    return;
                }

                if (stageName === 'FAILED' || stageName === 'HALTED') {
                    setSseStage(null);
                    const halted = stageName === 'HALTED';
                    const errText = asString(data['error']) ?? '章节推进失败';
                    applyStageOverrides((prev) =>
                        settleRunningStages(prev, {
                            targetNodeStatus: 'halt',
                            terminalSessionStatus: 'failed',
                            includeDreaming: true
                        })
                    );
                    setSelectedStageSession((prev) =>
                        prev && (prev.status === 'active' || prev.status === 'healing')
                            ? { ...prev, status: 'halt' }
                            : prev
                    );
                    showToast(halted ? '章节已安全中止' : errText, halted ? 'info' : 'error');
                    void Promise.allSettled([loadStatus(), loadViewsRef.current()]);
                    return;
                }

                const message = asString(data['message']);
                const timestamp = asString(data['timestamp']);
                const eventChapter = asNumber(data['chapterNumber']) ?? asNumber(data['chapter']);
                if (eventChapter !== undefined) {
                    setLiveRunChapter(eventChapter);
                }
                const sessionId = asString(data['activeSessionId']) ?? asString(data['sessionId']);
                const parentSessionId = asString(data['parentSessionId']);
                const mode = asString(data['mode']);
                const role = asString(data['role']);
                const attempt = asNumber(data['attempt']);
                const triggerReason = asString(data['triggerReason']);
                const rawStatus = asString(data['status']);
                const runId = asString(data['runId']);
                const resolvedStage = resolveStageId(stageName);
                setSseStage(resolvedStage ? stageName : null);
                if (data['txLockHeld'] === true) {
                    setStatus((prev) => prev ? { ...prev, txLockHeld: true } : prev);
                }
                if (resolvedStage && (message || sessionId || runId)) {
                    const upperStage = stageName.trim().toUpperCase();
                    const repairMeta = STAGE_REPAIR_META[upperStage];
                    const repairBadge = repairMeta?.badge;
                    const existingCurrent = stageOverridesRef.current[resolvedStage];
                    const nodeStatus = resolveIncomingNodeStatus(
                        upperStage,
                        rawStatus,
                        existingCurrent?.status
                    );
                    const sessionStatus = rawStatus ?? 'running';
                    const resolvedIdx = STAGE_SEQUENCE.indexOf(resolvedStage);

                    applyStageOverrides((prev) => {
                        const next = settleRunningStages(prev, {
                            targetNodeStatus: 'done',
                            terminalSessionStatus: 'completed',
                            beforeIndex: resolvedIdx,
                            skipStageId: resolvedStage
                        });
                        const current = next[resolvedStage];
                        let nextSessions = current?.sessions;
                        if (sessionId !== undefined) {
                            nextSessions = upsertStageSession(
                                current?.sessions,
                                buildStageAttemptEntry({
                                    stage: stageName,
                                    status: sessionStatus,
                                    sessionId,
                                    runId,
                                    role,
                                    parentSessionId,
                                    attempt,
                                    triggerReason,
                                    mode,
                                    updatedAt: timestamp
                                })
                            );
                        }
                        next[resolvedStage] = {
                            ...current,
                            status: nodeStatus,
                            summary:
                                message ??
                                repairMeta?.defaultSummary ??
                                current?.summary ??
                                DEFAULT_STAGE_SUMMARIES[resolvedStage],
                            updatedAt: timestamp ?? current?.updatedAt,
                            ...(repairBadge !== undefined ? { badge: repairBadge } : {}),
                            ...(sessionId !== undefined ? { sessionId } : {}),
                            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
                            ...(mode !== undefined ? { mode } : {}),
                            ...(runId !== undefined ? { runId } : {}),
                            ...(nextSessions && nextSessions.length > 0 ? { sessions: nextSessions } : {})
                        };
                        return next;
                    });
                    setSelectedStageSession((prev) => {
                        if (!prev) return prev;
                        if (sessionId !== undefined && prev.sessionId === sessionId) {
                            return prev.status === nodeStatus ? prev : { ...prev, status: nodeStatus };
                        }
                        const prevResolved = resolveStageId(prev.stageId);
                        if (
                            prevResolved === resolvedStage &&
                            sessionId !== undefined &&
                            prev.sessionId !== sessionId &&
                            (prev.status === 'active' || prev.status === 'healing')
                        ) {
                            return { ...prev, status: 'done' };
                        }
                        if (
                            prevResolved !== null &&
                            prevResolved !== 'DREAMING' &&
                            STAGE_SEQUENCE.indexOf(prevResolved) < resolvedIdx &&
                            (prev.status === 'active' || prev.status === 'healing')
                        ) {
                            return { ...prev, status: 'done' };
                        }
                        return prev;
                    });
                }

                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              yolo: { ...prev.yolo, currentStage: stageName }
                          }
                        : prev
                );

                if (stageName === 'COMMITTED') {
                    const committedCh = asNumber(data['chapterNumber']);
                    applyStageOverrides((prev) =>
                        settleRunningStages(prev, {
                            targetNodeStatus: 'done',
                            terminalSessionStatus: 'completed'
                        })
                    );
                    setSelectedStageSession((prev) =>
                        prev &&
                        resolveStageId(prev.stageId) !== 'DREAMING' &&
                        (prev.status === 'active' || prev.status === 'healing')
                            ? { ...prev, status: 'done' }
                            : prev
                    );
                    setRevealNonce((n) => n + 1);
                    showToast(
                        committedCh
                            ? `第 ${committedCh} 章已定稿并提交入库`
                            : '章节已定稿并提交入库'
                    );
                    const hasDirty = draftLocationRef.current !== null;
                    const followCommitted =
                        !hasDirty &&
                        committedCh !== undefined &&
                        committedCh > 0 &&
                        committedCh !== selectedChapterRef.current;
                    void refreshAllRef.current(
                        followCommitted ? committedCh : selectedChapterRef.current
                    );
                    void loadRunsRef.current(committedCh ?? selectedChapterRef.current);
                }
                return;
            }

            if (event === 'gate:result') {
                const item: TelemetryItem = {
                    chapter: asNumber(data['chapter']),
                    clicheDensityPer1k: asNumber(data['clicheDensityPer1k']),
                    mattr500: asNumber(data['mattr500']),
                    sentenceLengthCv: asNumber(data['sentenceLengthCv']),
                    kontoyiannisEntropy:
                        asNumber(data['kontoyiannisEntropy']) ?? asNumber(data['kontoyiannisHk'])
                };
                setLiveTelemetry((prev) => ({ ...prev, ...item }));
                if (Array.isArray(data['violations'])) {
                    const mapped: ProseGateViolationItem[] = data['violations']
                        .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === 'object'))
                        .map((v) => ({
                            rule: asString(v['rule']) ?? asString(v['ruleId']) ?? 'GATE',
                            detail: asString(v['detail']) ?? asString(v['message']) ?? JSON.stringify(v),
                            patched: Boolean(v['patched'])
                        }));
                    setGateViolations(mapped);
                }
                return;
            }

            if (event === 'checker:result') {
                const replanCount = asNumber(data['replanCount']) ?? 0;
                const rewriteCount = asNumber(data['rewriteCount']) ?? 0;
                const patchRounds = asNumber(data['patchRounds']) ?? 0;
                const filteredOutCount = asNumber(data['filteredOutCount']) ?? 0;
                const rawIssues = Array.isArray(data['issues']) ? data['issues'] : [];
                const recentFindings: FactCheckDetailItem[] = rawIssues
                    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
                    .map((item) => {
                        const sourceRef = asString(item['source_ref']);
                        const reason = asString(item['quote_source']);
                        return {
                            claim: asString(item['description']) ?? asString(item['quote_draft']) ?? '核查项',
                            ...(sourceRef !== undefined ? { sourceRef } : {}),
                            verified: false as const,
                            ...(reason !== undefined ? { reason } : {})
                        };
                    });
                setFactChecker((prev) => ({
                    totalChecked: prev.totalChecked + 1,
                    verifiedPassCount:
                        replanCount === 0 && rewriteCount === 0
                            ? prev.verifiedPassCount + 1
                            : prev.verifiedPassCount,
                    filteredOutCount: prev.filteredOutCount + filteredOutCount,
                    blockedCount: (prev.blockedCount ?? 0) + replanCount + rewriteCount,
                    ...(recentFindings.length > 0 ? { recentFindings } : {})
                }));
                applyStageOverrides((prev) => ({
                    ...prev,
                    FACT_CHECKER: {
                        ...prev.FACT_CHECKER,
                        status: replanCount > 0 || rewriteCount > 0 ? 'healing' : 'done',
                        summary: `replan=${replanCount}, rewrite=${rewriteCount}, patch=${patchRounds}`
                    }
                }));
                return;
            }

            if (event === 'telemetry') {
                const nextItem = data as TelemetryItem;
                setLiveTelemetry((prev) => ({ ...prev, ...nextItem }));
                return;
            }

            if (event === 'signal:received') {
                void loadViewsRef.current();
                void loadStatus().catch(() => undefined);
                showToast('导演便签已入队');
                return;
            }

            if (event === 'signal:withdrawn') {
                void loadViewsRef.current();
                void loadStatus().catch(() => undefined);
                return;
            }

            if (event === 'volume:advanced') {
                const completedBook = Boolean(data['completedBook']);
                const sealedVolume = asNumber(data['sealedVolume']);
                showToast(formatVolumeAdvancedToast(completedBook, sealedVolume));
                void refreshAllRef.current(selectedChapterRef.current);
                return;
            }

            if (event === 'task:idle') {
                setSseStage(null);
                setHaltWaiting(false);
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              txLockHeld: false,
                              runtime: { ...prev.runtime, activeTask: 'IDLE' }
                          }
                        : prev
                );
                void loadStatus().catch(() => undefined);
                return;
            }

            if (event === 'heal:started') {
                const count = asNumber(data['conflictCount']) ?? 0;
                showToast(`已启动跨章连续性自愈 (${count} 处冲突)`);
                setStatus((prev) =>
                    prev
                        ? { ...prev, runtime: { ...prev.runtime, activeTask: 'SYNCING' } }
                        : prev
                );
                return;
            }

            if (event === 'heal:completed') {
                const quarantined = Boolean(data['quarantined']);
                setRevealNonce((n) => n + 1);
                showToast(
                    quarantined
                        ? '部分冲突已进入人工裁决隔离区'
                        : '跨章冲突自愈完成'
                );
                void refreshAllRef.current(selectedChapterRef.current);
                return;
            }

            if (event === 'sync:started') {
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, activeTask: 'SYNCING' } } : prev
                );
                return;
            }

            if (event === 'sync:completed' || event === 'chapter_synced') {
                const ch = asNumber(data['chapterNumber']);
                setRevealNonce((n) => n + 1);
                showToast(
                    ch
                        ? `第 ${ch} 章手改同步完成`
                        : '全书手改差异同步完成'
                );
                void refreshAllRef.current(selectedChapterRef.current);
                if (ch && ch === selectedChapterRef.current) {
                    void loadChapterRef.current(ch);
                } else if (selectedChapterRef.current) {
                    void loadChapterRef.current(selectedChapterRef.current);
                }
                return;
            }

            if (event === 'dream:started') {
                const dreamSessionId = asString(data['activeSessionId']) ?? asString(data['sessionId']);
                const dreamParentSessionId = asString(data['parentSessionId']);
                const dreamMode = asString(data['mode']);
                const dreamRunId = asString(data['runId']);
                const dreamMessage = asString(data['message']);
                setSseStage('DREAMING');
                const dreamChapter = asNumber(data['currentChapter']);
                if (dreamChapter !== undefined) setLiveRunChapter(dreamChapter);
                if (dreamSessionId || dreamRunId || dreamMessage) {
                    applyStageOverrides((prev) => ({
                        ...prev,
                        DREAMING: {
                            ...prev.DREAMING,
                            status: 'active',
                            summary: dreamMessage ?? prev.DREAMING?.summary ?? DEFAULT_STAGE_SUMMARIES.DREAMING,
                            ...(dreamSessionId !== undefined ? { sessionId: dreamSessionId } : {}),
                            ...(dreamParentSessionId !== undefined
                                ? { parentSessionId: dreamParentSessionId }
                                : {}),
                            ...(dreamMode !== undefined ? { mode: dreamMode } : {}),
                            ...(dreamRunId !== undefined ? { runId: dreamRunId } : {})
                        }
                    }));
                } else if (stageOverridesRef.current.DREAMING) {
                    const next = { ...stageOverridesRef.current };
                    delete next.DREAMING;
                    applyStageOverrides(next);
                }
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, activeTask: 'DREAMING' } } : prev
                );
                return;
            }

            if (event === 'dream:completed') {
                setSseStage(null);
                applyStageOverrides((prev) => {
                    if (!prev.DREAMING) return prev;
                    const settledSessions = updateStageSessionsToTerminal(
                        prev.DREAMING.sessions,
                        'completed'
                    );
                    return {
                        ...prev,
                        DREAMING: {
                            ...prev.DREAMING,
                            status: 'done',
                            ...(settledSessions ? { sessions: settledSessions } : {})
                        }
                    };
                });
                setSelectedStageSession((prev) =>
                    prev && prev.stageId === 'DREAMING' ? { ...prev, status: 'done' } : prev
                );
                showToast('跨章设定与伏笔整理完成');
                void loadStatus().catch(() => undefined);
                void loadViewsRef.current();
                void loadRunsRef.current(selectedChapterRef.current);
                return;
            }

            if (event === 'halt:requested') {
                const force = data['force'] === true;
                if (force) setHaltWaiting(true);
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, haltRequested: true } } : prev
                );
                showToast(force ? '正在中止在途调用并等待作品锁释放' : '已请求写完本章后暂停');
                return;
            }

            if (event === 'halt:waiting') {
                setHaltWaiting(true);
                setStatus((prev) =>
                    prev ? { ...prev, runtime: { ...prev.runtime, haltRequested: true } } : prev
                );
                return;
            }

            if (event === 'halt:completed') {
                setSseStage(null);
                setHaltWaiting(false);
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              txLockHeld: false,
                              runtime: { ...prev.runtime, activeTask: 'IDLE', haltRequested: true },
                              yolo: { ...prev.yolo, running: false, stopRequested: true, currentStage: null }
                          }
                        : prev
                );
                return;
            }

            if (event === 'yolo:stop_requested') {
                setStatus((prev) =>
                    prev ? { ...prev, yolo: { ...prev.yolo, stopRequested: true } } : prev
                );
                showToast('已请求在本章写完后平稳暂停');
                return;
            }

            if (event === 'yolo_halted') {
                setSseStage(null);
                const reason = asString(data['reason']) ?? 'HALTED';
                const errText = asString(data['error']);
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              yolo: { ...prev.yolo, running: false, currentStage: null },
                              runtime: { ...prev.runtime, activeTask: 'IDLE' }
                          }
                        : prev
                );
                showToast(
                    errText ? `连写已停止 (${reason}): ${errText}` : `连写已在安全点停止 (${reason})`,
                    reason === 'ERROR' ? 'error' : 'info'
                );
                void refreshAllRef.current(selectedChapterRef.current);
                return;
            }

            if (event === 'yolo_completed') {
                setSseStage(null);
                const completed = asNumber(data['completedChapters']) ?? 0;
                setStatus((prev) =>
                    prev
                        ? {
                              ...prev,
                              yolo: {
                                  ...prev.yolo,
                                  running: false,
                                  completedChapters: completed,
                                  currentStage: null
                              },
                              runtime: { ...prev.runtime, activeTask: 'IDLE' }
                          }
                        : prev
                );
                showToast(`连写已完成（共推进 ${completed} 章）`);
                void refreshAllRef.current(selectedChapterRef.current);
            }
        };

        const unsubscribe = requestScope
            ? subscribeNarrateEvents(handleSseEvent, undefined, requestScope)
            : subscribeNarrateEvents(handleSseEvent);
        return () => {
            unsubscribe();
        };
    }, [applyStageOverrides, booksState.scopeBooksRoot, loadStatus, requestScope, setSseStage, showToast, stashCurrentDraftIfDirty]);

    const executeSelectBook = useCallback(
        async (bookRoot: string) => {
            if (switchingBookRef.current || saveInFlightRef.current) return;
            switchingBookRef.current = true;
            workspaceEpochRef.current += 1;
            chapterRequestSeqRef.current += 1;
            runsRequestSeqRef.current += 1;
            setLoading(true);
            setSseStage(null);
            setChapterLoading(true);
            setChapterDetail(null);
            setSelectedChapter(null);
            setHistoricalRuns([]);
            applyStageOverrides({});
            setInspectedStageId(null);
            setLiveRunChapter(null);
            setSelectedStageSession(null);
            setLiveSessionEvents({});
            try {
                await selectBook({ bookRoot }, ...scopeArgs);
                currentBookRootRef.current = bookRoot;
                setActiveParallelWindowId('');
                setActiveParallelBranchId('');
                setHaltWaiting(false);
                setEntitiesView(null);
                setHorizonView(null);
                setThreadsView(null);
                setTelemetryView(null);
                setSignalsView(null);
                setHaltView(null);
                setSyncConflictsView(null);
                showToast('正在切换作品目录…');
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
            } finally {
                switchingBookRef.current = false;
                setChapterLoading(false);
                await refreshAll(null);
            }
        },
        [applyStageOverrides, refreshAll, setSseStage, showToast]
    );

    const handleSelectBook = useCallback(
        (bookRoot: string) => {
            if (saveInFlightRef.current || switchingBookRef.current) {
                showToast('正在保存或切换作品，请等待操作完成后再切换');
                return;
            }
            if (draftLocationRef.current && draftLocationRef.current.bookRoot !== bookRoot) {
                stashCurrentDraftIfDirty('已自动暂存当前作品未保存草稿，切回可继续改');
            }
            viewCommandNonceRef.current += 1;
            setActiveViewKind(null);
            setExternalViewCommand({
                viewTab: 'prose',
                nonce: viewCommandNonceRef.current
            });
            void executeSelectBook(bookRoot);
        },
        [executeSelectBook, showToast, stashCurrentDraftIfDirty]
    );

    const handleSelectChapter = useCallback(
        (chapterNumber: number) => {
            if (saveInFlightRef.current || switchingBookRef.current) {
                showToast('正在保存或切换作品，请等待操作完成后再切章');
                return;
            }
            if (draftLocationRef.current && draftLocationRef.current.chapterNumber !== chapterNumber) {
                stashCurrentDraftIfDirty('已自动暂存上一章未保存手改草稿');
            }
            setActiveViewKind(null);
            viewCommandNonceRef.current += 1;
            setExternalViewCommand({
                viewTab: 'prose',
                nonce: viewCommandNonceRef.current
            });
            void loadChapterByNumber(chapterNumber);
        },
        [loadChapterByNumber, showToast, stashCurrentDraftIfDirty]
    );

    const handleOpenNewBook = useCallback(() => {
        if (saveInFlightRef.current || switchingBookRef.current) {
            showToast('正在保存或切换作品，请稍候');
            return;
        }
        setBootModalOpen(true);
    }, [showToast]);

    const handleOpenView = useCallback(
        (kind: MaterializedViewKind) => {
            setActiveViewKind(kind);
            viewCommandNonceRef.current += 1;
            setExternalViewCommand({
                viewTab: 'views',
                materialKind: kind,
                nonce: viewCommandNonceRef.current
            });
            void loadViews();
        },
        [loadViews]
    );

    const handleStepOne = useCallback(
        async (options?: StepChapterRequest) => {
            const worldParallelWindow =
                asString(status?.worldState['parallel_window_id']) ??
                asString(status?.worldState['parallelWindowId']) ??
                '';
            const worldParallelBranch =
                asString(status?.worldState['parallel_branch_id']) ??
                asString(status?.worldState['parallelBranchId']) ??
                '';
            const isParallelActive =
                String(status?.worldState.timeline_mode ?? '') === 'PARALLEL' ||
                Boolean(activeParallelWindowId);
            let nextOptions: StepChapterRequest = options ? { ...options } : {};
            if (!options?.retry && isParallelActive && options?.timelineMode !== 'FLASHBACK') {
                const resolvedWindowId =
                    options?.parallelWindowId ?? (activeParallelWindowId || worldParallelWindow);
                const resolvedBranchId =
                    options?.parallelBranchId ??
                    (activeParallelBranchId || worldParallelBranch || 'branch-a');
                nextOptions = {
                    ...nextOptions,
                    timelineMode: 'PARALLEL',
                    ...(resolvedWindowId ? { parallelWindowId: resolvedWindowId } : {}),
                    ...(resolvedBranchId ? { parallelBranchId: resolvedBranchId } : {})
                };
            }
            const epoch = workspaceEpochRef.current;
            try {
                const res = await stepChapter(nextOptions, ...scopeArgs);
                if (!isCurrentWorkspace(epoch)) return;
                setRevealNonce((n) => n + 1);
                await refreshAll(res.chapterNumber);
            } catch (err) {
                if (isCurrentWorkspace(epoch)) await Promise.allSettled([loadStatus(), loadViews()]);
                if (err instanceof Error && err.message === 'SAFE_HALT_REQUESTED') return;
                throw err;
            }
        },
        [activeParallelBranchId, activeParallelWindowId, isCurrentWorkspace, loadStatus, loadViews, refreshAll, status?.worldState]
    );

    const handleStartYolo = useCallback(
        async (targetChapters: number) => {
            await startYolo({ targetChapters }, ...scopeArgs);
            await loadStatus();
        },
        [loadStatus]
    );

    const handleStopYolo = useCallback(async () => {
        await stopYolo(...scopeArgs);
        await loadStatus();
    }, [loadStatus]);

    const handleRequestHalt = useCallback(
        async (options?: { force?: boolean }) => {
            await requestHalt(options, ...scopeArgs);
            await loadStatus();
        },
        [loadStatus, scopeArgs]
    );

    const handleSync = useCallback(async () => {
        await syncManuscripts(...scopeArgs);
        setRevealNonce((n) => n + 1);
        await refreshAll(selectedChapterRef.current);
    }, [refreshAll]);

    const handleDream = useCallback(async () => {
        await runDreaming({ force: true }, ...scopeArgs);
        await Promise.all([loadStatus(), loadViews()]);
    }, [loadStatus, loadViews]);

    const handleHealConflicts = useCallback(async () => {
        if (!syncConflictsView?.reportRevision || !syncConflictsView.conflicts[0]) return;
        try {
            const res = await healConflicts({ selection: { bookSlug: syncConflictsView.bookSlug, reportRevision: syncConflictsView.reportRevision, conflictIndex: 0 } }, ...scopeArgs);
            setRevealNonce((n) => n + 1);
            showToast(res.quarantined ? '本条冲突已保留，请人工裁决' : '本条冲突已处理');
        } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
            await refreshAll(selectedChapterRef.current);
        }
    }, [refreshAll, showToast, syncConflictsView]);

    const handleHarvestVoice = useCallback(
        async (targetChapterArg?: number) => {
            if (switchingBookRef.current) return;
            const epoch = workspaceEpochRef.current;
            const bookRoot = currentBookRootRef.current;
            let targetChapter: number | undefined;
            if (targetChapterArg !== undefined && targetChapterArg > 0) {
                targetChapter = targetChapterArg;
            } else if (selectedChapterRef.current !== null && selectedChapterRef.current > 0) {
                targetChapter = selectedChapterRef.current;
            }
            try {
                const res = await harvestVoice(targetChapter, ...scopeArgs);
                if (!isCurrentWorkspace(epoch) || currentBookRootRef.current !== bookRoot) {
                    return;
                }
                if (res.skipped) {
                    showToast('当前作品已有声纹标本，已跳过本次采集');
                } else {
                    showToast(`声纹采集完成：新增 ${res.harvestedCount} 条样本`);
                }
                await Promise.allSettled([loadStatus(), loadViews()]);
            } catch (err) {
                if (!isCurrentWorkspace(epoch) || currentBookRootRef.current !== bookRoot) {
                    return;
                }
                showToast(err instanceof Error ? err.message : String(err), 'error');
            }
        },
        [isCurrentWorkspace, loadStatus, loadViews, showToast]
    );

    const handleSaveModelRouting = useCallback(
        async (payload: SaveModelRoutingRequest) => {
            if (switchingBookRef.current) {
                throw new Error('正在切换作品，请稍后重试');
            }
            const bookRoot = currentBookRootRef.current;
            const epoch = workspaceEpochRef.current;
            try {
                const res = await saveModelRouting(payload, ...scopeArgs);
                if (!isCurrentWorkspace(epoch) || currentBookRootRef.current !== bookRoot) return;
                setStatus((prev) => {
                    if (!prev) return prev;
                    const next = { ...prev };
                    if (res.modelRouting !== undefined) next.modelRouting = res.modelRouting;
                    if (res.poolOverrides !== undefined) next.poolOverrides = res.poolOverrides;
                    if (res.defaultModel !== undefined) next.defaultModel = res.defaultModel;
                    if (res.roleRouting !== undefined) next.roleRouting = res.roleRouting;
                    if (res.roleDefinitions !== undefined) {
                        next.roleDefinitions = res.roleDefinitions;
                    }
                    if (res.availableModels !== undefined) {
                        next.availableModels = res.availableModels;
                    }
                    return next;
                });
                await loadStatus().catch(() => undefined);
                showToast('工种模型分配已保存');
            } catch (err) {
                showToast(err instanceof Error ? err.message : String(err), 'error');
                throw err;
            }
        },
        [isCurrentWorkspace, loadStatus, showToast]
    );

    const handleSaveChapter = useCallback(
        async (draft: DraftLocation) => {
            if (saveInFlightRef.current || switchingBookRef.current) {
                throw new Error('正在保存或切换作品，请等待当前操作完成');
            }
            const { bookRoot, chapterNumber } = draft;
            if (currentBookRootRef.current !== bookRoot) throw new Error('作品已改变，未保存手稿');
            const epoch = workspaceEpochRef.current;
            saveInFlightRef.current = true;
            try {
                const saved = await saveChapter(draft, ...scopeArgs);
                if (!isCurrentWorkspace(epoch) || currentBookRootRef.current !== bookRoot) return;
                // 保存成功后清除该章内存暂存草稿
                const nextStash = removeStashedDraft(draftStashRef.current, bookRoot, chapterNumber);
                draftStashRef.current = nextStash;
                setDraftStash(nextStash);

                workspaceEpochRef.current += 1;
                chapterRequestSeqRef.current += 1;
                setChapterLoading(false);
                setChapterDetail((prev) => prev?.bookRoot === bookRoot && prev.chapterNumber === chapterNumber
                    ? { ...prev, content: draft.content, sha256: saved.sha256, dirty: false }
                    : prev);
                setRevealNonce((n) => n + 1);
                void Promise.allSettled([
                    refreshAll(chapterNumber),
                    loadChapterByNumber(chapterNumber)
                ]);
            } finally {
                saveInFlightRef.current = false;
            }
        },
        [isCurrentWorkspace, loadChapterByNumber, refreshAll]
    );

    const handleSubmitSignal = useCallback(
        async (payload: SubmitSignalPayload) => {
            const req = buildSignalPayload(payload);
            await postSignal(req, ...scopeArgs);
            await Promise.all([loadViews(), loadStatus()]);
            if (payload.runAfter) {
                if (payload.kind === 'FLASHBACK') {
                    await handleStepOne({
                        timelineMode: 'FLASHBACK',
                        ...(payload.targetDay !== undefined ? { targetDay: payload.targetDay } : {})
                    });
                } else {
                    await handleStepOne();
                }
            }
        },
        [handleStepOne, loadStatus, loadViews, status]
    );

    const handleDismissSignal = useCallback(
        async (idx: number) => {
            const item = mapPendingSignals(signalsView)[idx];
            const reason = item?.reason ?? item?.raw;
            if (!item?.created_at || !reason) {
                showToast('该便签缺少撤回所需的元数据', 'error');
                return;
            }
            try {
                await deleteSignal({ created_at: item.created_at, reason }, ...scopeArgs);
                await loadViews();
                showToast('已撤回便签');
            } catch (err) {
                showToast(err instanceof Error ? err.message : '撤回便签失败', 'error');
            }
        },
        [loadViews, signalsView, showToast]
    );

    const activeBookSummary = useMemo(
        () => booksState.books.find((b) => b.bookRoot === (status?.bookRoot ?? booksState.currentBookRoot)),
        [booksState.books, booksState.currentBookRoot, status?.bookRoot]
    );

    const latestTelemetryEntry = useMemo<TelemetryItem | null>(() => {
        if (liveTelemetry) return liveTelemetry;
        const entries = telemetryView?.entries ?? [];
        return entries.length > 0 ? entries[entries.length - 1]! : null;
    }, [liveTelemetry, telemetryView]);

    const aggregateTokens = useMemo(
        () => aggregateTelemetryTokens(telemetryView?.entries ?? []),
        [telemetryView]
    );

    const latestMetrics = useMemo(
        () => readTelemetryMetrics(latestTelemetryEntry),
        [latestTelemetryEntry]
    );

    const inspectorEntities = useMemo<InspectorEntityItem[]>(() => {
        if (!entitiesView?.entities) return [];
        return entitiesView.entities.map((ent) => ({
            id: ent.entityId,
            name: ent.canonicalName,
            ...(ent.aliases.length > 0 ? { role: ent.aliases.slice(0, 2).join(' / ') } : {}),
            ...(ent.lastSeenChapter > 0 ? { lastChapter: ent.lastSeenChapter } : {}),
            ...(ent.markdown ? { brief: ent.markdown.slice(0, 120) } : {})
        }));
    }, [entitiesView]);

    const inspectorOpenThreads = useMemo<OpenThreadItem[]>(() => {
        const items = parseThreadItems(threadsView?.content).filter((t) => !t.resolved);
        return items.map((t) => {
            const chMatch = t.text.match(/(?:Ch\.?|第)\s*(\d+)\s*章?/i);
            const chapter = chMatch?.[1] ? Number(chMatch[1]) : undefined;
            return {
                title: t.text,
                ...(chapter !== undefined && Number.isFinite(chapter) ? { chapter } : {})
            };
        });
    }, [threadsView]);

    const inspectorVolumeProgress = useMemo<VolumeProgressSnapshot | null>(() => {
        if (!status && !horizonView?.content) return null;
        const rawVol = status?.volumeProgress;
        const horizonExcerpt = horizonView?.content?.trim()
            ? horizonView.content.trim().slice(0, 240)
            : null;
        return {
            ...(rawVol?.volumeLabel ? { volumeLabel: rawVol.volumeLabel } : {}),
            ...(rawVol?.volumeTitle ? { volumeTitle: rawVol.volumeTitle } : {}),
            ...(typeof rawVol?.completedChapters === 'number'
                ? { completedChapters: rawVol.completedChapters }
                : {}),
            ...(typeof rawVol?.totalChapters === 'number'
                ? { totalChapters: rawVol.totalChapters }
                : {}),
            futureHorizon: rawVol?.futureHorizon ?? horizonExcerpt,
            ...(rawVol?.milestoneLock !== undefined && rawVol?.milestoneLock !== null
                ? { milestoneLock: rawVol.milestoneLock }
                : {})
        };
    }, [status, horizonView]);

    const dirtyChaptersCount = useMemo(
        () => chapters.filter((item) => item.dirty).length,
        [chapters]
    );

    const safeHaltInfo = useMemo(() => mapSafeHaltInfo(haltView?.safeHalt), [haltView]);
    const syncConflictInfo = useMemo(
        () => mapSyncConflictDiagnostic(syncConflictsView, haltView),
        [haltView, syncConflictsView]
    );
    const haltDiagnostic = useMemo(() => mapHaltDiagnostic(haltView), [haltView]);
    const pendingSignals = useMemo(() => mapPendingSignals(signalsView), [signalsView]);

    const historicalStageOverrides = useMemo(
        () => deriveHistoricalStageOverrides(historicalRuns),
        [historicalRuns]
    );

    const isLiveUncommittedChapter =
        liveRunChapter !== null &&
        !chapters.some((ch) => ch.chapterNumber === liveRunChapter);
    const sameChapterAsSelected =
        liveRunChapter === null ||
        selectedChapter === null ||
        liveRunChapter === selectedChapter;
    const projectedLiveStage =
        !loading && !chapterLoading ? latestSseStage : null;
    const shouldOverlayLive = sameChapterAsSelected || isLiveUncommittedChapter;
    const liveStageOverrides = useMemo(() => {
        if (!projectedLiveStage) return undefined;
        if (projectedLiveStage === 'DREAMING') {
            const dreaming = stageOverrides.DREAMING;
            return dreaming ? { DREAMING: dreaming } : undefined;
        }
        return stageOverrides;
    }, [projectedLiveStage, stageOverrides]);

    // 会话范围与实时徽标独立：空闲时保留选中章节的归档和刚结束的尝试供下钻。
    const effectiveStages = useMemo<Partial<Record<PipelineStageId, StageNodeState>>>(() => {
        if (!shouldOverlayLive) return historicalStageOverrides;
        const merged: Partial<Record<PipelineStageId, StageNodeState>> = { ...historicalStageOverrides };
        // 运行中的工序不可回退到另一章；其余工序仍可浏览选中章的历史。
        const liveStageId = projectedLiveStage ? resolveStageId(projectedLiveStage) : null;
        if (!sameChapterAsSelected && liveStageId) delete merged[liveStageId];
        for (const id of STAGE_SEQUENCE) {
            const live = stageOverrides[id];
            if (live) {
                const mergedSessions = sameChapterAsSelected
                    ? mergeStageSessions(merged[id]?.sessions, live.sessions)
                    : mergeStageSessions(undefined, live.sessions);
                merged[id] = {
                    ...(sameChapterAsSelected ? merged[id] : undefined),
                    ...live,
                    ...(mergedSessions.length > 0 ? { sessions: mergedSessions } : {})
                };
            }
        }
        return merged;
    }, [historicalStageOverrides, projectedLiveStage, sameChapterAsSelected, shouldOverlayLive, stageOverrides]);

    const defaultModelString = useMemo(() => {
        const dm = status?.defaultModel;
        if (!dm?.model) return '';
        if (dm.provider && !dm.model.includes(':')) {
            return `${dm.provider}:${dm.model}`;
        }
        return dm.model;
    }, [status?.defaultModel]);

    const modelPools = useMemo(() => {
        const routing = status?.modelRouting ?? {};
        const fallback = defaultModelString || '--';
        return {
            strongModel: routing['strong_creative'] ?? routing['strong'] ?? fallback,
            fastModel: routing['fast_retrieval'] ?? routing['fast'] ?? fallback
        };
    }, [defaultModelString, status?.modelRouting]);

    const effectivePoolRoutes = useMemo<Record<RolePoolId, string>>(
        () => ({
            strong_creative:
                status?.modelRouting?.['strong_creative'] ||
                modelPools.strongModel ||
                defaultModelString ||
                '--',
            fast_retrieval:
                status?.modelRouting?.['fast_retrieval'] ||
                modelPools.fastModel ||
                defaultModelString ||
                '--'
        }),
        [defaultModelString, modelPools, status?.modelRouting]
    );

    const poolProviders = useMemo(
        () => collectPoolProviders(effectivePoolRoutes, status?.roleDefinitions ?? [], status?.roleRouting),
        [effectivePoolRoutes, status?.roleDefinitions, status?.roleRouting]
    );

    const selectedStageEffectiveModel = useMemo(() => {
        if (!selectedStageSession) return undefined;
        const stageId = resolveStageId(selectedStageSession.stageId) ?? 'WRITER';
        const meta = PIPELINE_STAGE_META.find((m) => m.id === stageId);
        if (!meta) return undefined;
        const matchedDef: RoleDefinitionItem =
            (status?.roleDefinitions ?? []).find(
                (d) => d.id.trim().toLowerCase().replace('-', '_') === meta.roleId
            ) ?? {
                id: meta.roleId,
                defaultPool: meta.defaultPool,
                effectiveProvider: '',
                effectiveModel: '--'
            };
        const ov =
            status?.roleRouting?.[matchedDef.id] ??
            status?.roleRouting?.[meta.roleId] ??
            (meta.roleId === 'fact_checker' ? status?.roleRouting?.['fact-checker'] : undefined);
        return resolveEffectiveRoleModelLabel(
            matchedDef,
            undefined,
            ov,
            effectivePoolRoutes,
            poolProviders
        );
    }, [effectivePoolRoutes, poolProviders, selectedStageSession, status?.roleDefinitions, status?.roleRouting]);

    const selectedStageAttempts = useMemo<StageViewerAttemptItem[]>(() => {
        if (!selectedStageSession) return [];
        const stageId = resolveStageId(selectedStageSession.stageId);
        if (!stageId) return [];
        const list = effectiveStages[stageId]?.sessions ?? [];
        return list.map((item) => ({
            sessionId: item.sessionId,
            label: formatAttemptLabel(item),
            status: item.status,
            ...(item.attempt !== undefined ? { attempt: item.attempt } : {}),
            ...(item.triggerReason !== undefined ? { triggerReason: item.triggerReason } : {})
        }));
    }, [effectiveStages, selectedStageSession]);

    const stageArtifact = useMemo<StageArtifactTelemetry>(() => {
        let sseResolved: PipelineStageId | null = null;
        if (latestSseStage) {
            sseResolved =
                latestSseStage === 'COMMITTED' ? 'EXTRACTOR' : resolveStageId(latestSseStage);
        }
        const targetStageId = inspectedStageId ?? sseResolved;
        const assembly = status?.writerAssemblyReport;
        const estimated =
            assembly?.estimatedTokens && typeof assembly.estimatedTokens === 'object'
                ? assembly.estimatedTokens
                : undefined;
        const assemblyFields: Partial<StageArtifactTelemetry> = {};
        if (estimated?.staticPrefixTokens !== undefined) {
            assemblyFields.staticPrefixTokens = estimated.staticPrefixTokens;
        }
        if (estimated?.dynamicTailTokens !== undefined) {
            assemblyFields.dynamicTailTokens = estimated.dynamicTailTokens;
        }
        if (assembly?.budget !== undefined && assembly.budget !== null) {
            assemblyFields.budgetLimitTokens = assembly.budget;
        }
        if (assembly?.evictionLevel !== undefined) {
            assemblyFields.degradationLevel = assembly.evictionLevel;
        }
        if (assembly?.selectedVoiceSample?.text) {
            assemblyFields.voiceLruSummary = `${assembly.selectedVoiceSample.tag ?? '声纹'} · ${assembly.selectedVoiceSample.text.slice(0, 40)}`;
        }
        if (assembly?.strippedSecretCount !== undefined) {
            assemblyFields.strippedItemsSummary = `已隔离 ${assembly.strippedSecretCount} 项秘密与废案`;
        }

        if (targetStageId) {
            const nodeState = effectiveStages[targetStageId];
            const primarySession = resolvePrimaryStageSession(targetStageId, nodeState);
            const idx = STAGE_SEQUENCE.indexOf(targetStageId);
            const meta = PIPELINE_STAGE_META.find((item) => item.id === targetStageId);
            let base: StageArtifactTelemetry;
            if (!inspectedStageId || inspectedStageId === sseResolved) {
                base = deriveStageArtifact(latestSseStage);
            } else {
                base = {
                    selectedStageIndex: idx >= 0 ? idx : 0,
                    stageName: meta?.label ?? targetStageId,
                    stageStatus: nodeState?.badge ?? nodeState?.status ?? '就绪',
                    stageSummary: nodeState?.summary ?? DEFAULT_STAGE_SUMMARIES[targetStageId]
                };
            }
            return {
                ...base,
                ...assemblyFields,
                ...(primarySession?.sessionId ? { sessionId: primarySession.sessionId } : {}),
                ...(nodeState?.sessions && nodeState.sessions.length > 0
                    ? { sessions: nodeState.sessions }
                    : {})
            };
        }

        const base = deriveStageArtifact(latestSseStage);
        const allSessions = STAGE_SEQUENCE.flatMap((id) => effectiveStages[id]?.sessions ?? []);
        const latestSession =
            allSessions.length > 0 ? allSessions[allSessions.length - 1]!.sessionId : null;
        return {
            ...base,
            ...assemblyFields,
            ...(latestSession ? { sessionId: latestSession } : {}),
            ...(allSessions.length > 0 ? { sessions: allSessions } : {})
        };
    }, [effectiveStages, inspectedStageId, latestSseStage, status?.writerAssemblyReport]);

    const effectiveFactChecker = useMemo<FactCheckerTelemetry>(() => {
        const last = status?.lastCheckerResult;
        if (!last) return factChecker;
        const statusFindings: FactCheckDetailItem[] = (last.issues ?? []).map((issue) => ({
            claim: issue.description ?? issue.quote_draft ?? '核查项',
            ...(issue.source_ref !== undefined ? { sourceRef: issue.source_ref } : {}),
            verified: false,
            ...(issue.quote_source !== undefined ? { reason: issue.quote_source } : {})
        }));
        const recentFindings =
            statusFindings.length > 0 ? statusFindings : factChecker.recentFindings;
        return {
            totalChecked: Math.max(factChecker.totalChecked, 1),
            verifiedPassCount: Math.max(factChecker.verifiedPassCount, last.passed ? 1 : 0),
            filteredOutCount: Math.max(factChecker.filteredOutCount, last.filteredOutCount ?? 0),
            blockedCount: Math.max(factChecker.blockedCount ?? 0, last.replanCount + last.rewriteCount),
            ...(recentFindings ? { recentFindings } : {})
        };
    }, [factChecker, status?.lastCheckerResult]);

    const effectiveSpotlightQueue = useMemo<SpotlightQueueItem[] | null>(() => {
        if (!status || status.spotlightQueue === undefined) return null;
        return status.spotlightQueue.map((item, idx) => {
            const raw = item as Record<string, unknown>;
            const entityId = asString(item.entity_id) ?? asString(raw['entityId']) ?? `entity-${idx}`;
            const label = asString(raw['label']) ?? asString(item.reason) ?? entityId;
            const pct = asNumber(raw['progressPct']) ?? 100;
            return {
                entityId,
                label,
                progressPct: pct,
                triggered: Boolean(raw['triggered'])
            };
        });
    }, [status]);

    const handleSelectStageSession = useCallback((selection: StageSessionSelection) => {
        const resolved = resolveStageId(selection.stageId);
        if (resolved) {
            setInspectedStageId(resolved);
            const attempt = effectiveStages[resolved]?.sessions?.find(
                (item) => item.sessionId === selection.sessionId
            );
            if (attempt) selection = { ...selection, status: mapRunStatusToStageStatus(attempt.status) };
        }
        setSelectedStageSession(selection);
        setRightTab('trace');
        setRightOpen(true);
    }, [effectiveStages]);

    const handleInspectStageSessionById = useCallback(
        (sessionId: string) => {
            let matchedId: PipelineStageId | undefined;
            let matchedAttempt: StageAttemptSession | undefined;
            for (const id of STAGE_SEQUENCE) {
                const found = effectiveStages[id]?.sessions?.find((item) => item.sessionId === sessionId);
                if (found) {
                    matchedId = id;
                    matchedAttempt = found;
                    break;
                }
            }
            if (!matchedId) {
                matchedId = STAGE_SEQUENCE.find((id) => effectiveStages[id]?.sessionId === sessionId);
            }
            const meta = matchedId
                ? PIPELINE_STAGE_META.find((item) => item.id === matchedId)
                : undefined;
            const nodeState = matchedId ? effectiveStages[matchedId] : undefined;
            const parentSessionId = matchedAttempt?.parentSessionId ?? nodeState?.parentSessionId;
            const mode = matchedAttempt?.mode ?? nodeState?.mode;
            const runId = matchedAttempt?.runId ?? nodeState?.runId;
            const nodeStatus = matchedAttempt
                ? mapRunStatusToStageStatus(matchedAttempt.status)
                : (nodeState?.status ?? 'done');
            handleSelectStageSession({
                stageId: matchedId ?? 'STAGE',
                stageLabel: meta?.label ?? stageArtifact.stageName,
                sessionId,
                ...(parentSessionId !== undefined ? { parentSessionId } : {}),
                ...(mode !== undefined ? { mode } : {}),
                ...(runId !== undefined ? { runId } : {}),
                status: nodeStatus
            });
        },
        [effectiveStages, handleSelectStageSession, stageArtifact.stageName]
    );

    const parsedHorizonCounts = useMemo(
        () => parseHorizonEntries(horizonView?.content),
        [horizonView?.content]
    );

    const openThreadsCount = useMemo(
        () => parseThreadItems(threadsView?.content).filter((t) => !t.resolved).length,
        [threadsView?.content]
    );

    const centerChapterDetail: CenterWorkbenchProps['chapterDetail'] = useMemo(() => {
        if (!chapterDetail) return null;
        const summary = chapters.find((c) => c.chapterNumber === chapterDetail.chapterNumber);
        return {
            bookRoot: chapterDetail.bookRoot,
            chapterNumber: chapterDetail.chapterNumber,
            title: summary?.title,
            content: chapterDetail.content,
            dirty: chapterDetail.dirty,
            sha256: chapterDetail.sha256,
            diffFromHead: chapterDetail.diffFromHead,
            outlineText: chapterDetail.outlineText,
            outlineStatus: chapterDetail.outlineStatus,
            volumeLabel: status?.volumeProgress?.volumeLabel,
            featCommitSha: status?.featCommitSha ?? status?.recentCommits?.featCommitSha ?? undefined,
            stateCommitSha: status?.stateCommitSha ?? status?.recentCommits?.stateCommitSha ?? undefined
        };
    }, [chapterDetail, chapters, status?.featCommitSha, status?.recentCommits, status?.stateCommitSha, status?.volumeProgress?.volumeLabel]);

    const currentBookRoot = status?.bookRoot ?? booksState.currentBookRoot ?? '';
    const currentStashedDraft = useMemo(() => {
        if (!currentBookRoot || selectedChapter === null || selectedChapter <= 0) return null;
        return getStashedDraft(draftStash, currentBookRoot, selectedChapter);
    }, [currentBookRoot, draftStash, selectedChapter]);

    const effectiveGateViolations = useMemo(() => {
        if (gateViolations.length > 0) return gateViolations;
        return safeHaltInfo?.gateViolations ?? [];
    }, [gateViolations, safeHaltInfo?.gateViolations]);

    const isWide = containerWidth >= WIDE_BREAKPOINT_PX;
    const isCompact = containerWidth < COMPACT_BREAKPOINT_PX;
    const showLeftPane = isWide && leftOpen;
    const layoutClass = resolveLayoutClass(isWide, isCompact);
    const shellClassName = [
        'ns-studio-shell',
        layoutClass,
        rightOpen ? 'ns-right-open' : 'ns-right-closed',
        isWide && !leftOpen ? 'ns-left-closed' : '',
        resizingSide ? 'ns-resizing' : ''
    ]
        .filter(Boolean)
        .join(' ');
    const shellStyle = {
        '--ns-left-w': showLeftPane ? `${leftWidth}px` : '0px',
        '--ns-right-w': rightOpen && !isCompact ? `${rightWidth}px` : '0px'
    } as React.CSSProperties;

    const handleToggleLeft = useCallback(() => {
        setLeftOpen((prev) => {
            const next = !prev;
            writeStorageItem(LEFT_OPEN_STORAGE_KEY, String(next));
            return next;
        });
    }, []);

    const beginPaneResize = (
        side: 'left' | 'right',
        ev: React.PointerEvent<HTMLDivElement>
    ): void => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        try {
            ev.currentTarget.setPointerCapture?.(ev.pointerId);
        } catch {
            // 忽略合成事件在 jsdom 下的 pointerId 校验
        }
        const startWidth = side === 'left' ? leftWidth : rightWidth;
        dragRef.current = {
            side,
            startX: ev.clientX,
            startWidth,
            latestWidth: startWidth
        };
        setResizingSide(side);
    };

    const movePaneResize = (
        side: 'left' | 'right',
        ev: React.PointerEvent<HTMLDivElement>
    ): void => {
        const drag = dragRef.current;
        if (!drag || drag.side !== side) return;
        const delta = ev.clientX - drag.startX;
        if (side === 'left') {
            const next = clampPaneWidth(drag.startWidth + delta, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX);
            drag.latestWidth = next;
            setLeftWidth(next);
            return;
        }
        const next = clampPaneWidth(drag.startWidth - delta, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX);
        drag.latestWidth = next;
        setRightWidth(next);
    };

    const endPaneResize = (
        side: 'left' | 'right',
        ev: React.PointerEvent<HTMLDivElement>
    ): void => {
        const drag = dragRef.current;
        if (!drag || drag.side !== side) return;
        dragRef.current = null;
        setResizingSide(null);
        try {
            ev.currentTarget.releasePointerCapture?.(ev.pointerId);
        } catch {
            // 忽略合成事件释放异常
        }
        writeStorageItem(
            side === 'left' ? LEFT_WIDTH_STORAGE_KEY : RIGHT_WIDTH_STORAGE_KEY,
            String(drag.latestWidth)
        );
    };

    const resetPaneWidth = (side: 'left' | 'right'): void => {
        if (side === 'left') {
            setLeftWidth(LEFT_WIDTH_DEFAULT);
            writeStorageItem(LEFT_WIDTH_STORAGE_KEY, String(LEFT_WIDTH_DEFAULT));
            return;
        }
        setRightWidth(RIGHT_WIDTH_DEFAULT);
        writeStorageItem(RIGHT_WIDTH_STORAGE_KEY, String(RIGHT_WIDTH_DEFAULT));
    };

    const handleSeparatorKeyDown = (
        side: 'left' | 'right',
        ev: React.KeyboardEvent<HTMLDivElement>
    ): void => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const step = ev.shiftKey ? 24 : 12;
        const sign = ev.key === 'ArrowRight' ? 1 : -1;
        if (side === 'left') {
            const next = clampPaneWidth(leftWidth + sign * step, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX);
            setLeftWidth(next);
            writeStorageItem(LEFT_WIDTH_STORAGE_KEY, String(next));
            return;
        }
        const next = clampPaneWidth(rightWidth - sign * step, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX);
        setRightWidth(next);
        writeStorageItem(RIGHT_WIDTH_STORAGE_KEY, String(next));
    };

    const navChapters = useMemo(
        () =>
            chapters.map((ch) => ({
                ...ch,
                volumeLabel: status?.volumeProgress?.volumeLabel,
                conflict:
                    Boolean(safeHaltInfo?.chapter === ch.chapterNumber) ||
                    Boolean(syncConflictInfo?.rightRef?.includes(String(ch.chapterNumber)))
            })),
        [chapters, safeHaltInfo?.chapter, status?.volumeProgress?.volumeLabel, syncConflictInfo?.rightRef]
    );

    const activeStageAttemptCount = selectedStageSession ? 1 : 0;
    const txLockInfo = resolveTxLockInfo(status?.txLockHeld, activeTask);

    const renderRightTabContent = (): React.ReactElement | null => {
        if (rightTab === 'trace') {
            return (
                <StageSessionViewer
                    selection={selectedStageSession}
                    requestScope={requestScope}
                    sessionsService={sessionsService}
                    SessionProvider={SessionProvider}
                    renderStageConversation={renderStageConversation}
                    effectiveModelLabel={selectedStageEffectiveModel}
                    attemptSessions={selectedStageAttempts}
                    onSelectAttemptSession={handleInspectStageSessionById}
                    liveEvents={
                        selectedStageSession
                            ? liveSessionEvents[selectedStageSession.sessionId]
                            : undefined
                    }
                    onClose={() => setRightTab('status')}
                />
            );
        }
        if (rightTab === 'status') {
            return (
                <RightOpsInspector
                    walLock={{
                        walPhase: status?.walPhase ?? 'IDLE',
                        timelineMode: String(status?.worldState.timeline_mode ?? 'MAINLINE'),
                        txLockStatus: txLockInfo.txLockStatus,
                        txLockHolder: txLockInfo.txLockHolder,
                        lastCommittedChapter: status?.lastCommittedChapter ?? 0,
                        activeChapter: status?.activeChapter ?? null,
                        featCommitSha:
                            status?.featCommitSha ??
                            status?.recentCommits?.featCommitSha ??
                            centerChapterDetail?.featCommitSha ??
                            null,
                        stateCommitSha:
                            status?.stateCommitSha ??
                            status?.recentCommits?.stateCommitSha ??
                            centerChapterDetail?.stateCommitSha ??
                            null
                    }}
                    modelPool={{
                        fastModel: modelPools.fastModel,
                        strongModel: modelPools.strongModel,
                        inputTokens: aggregateTokens.inputTokens,
                        cacheReadTokens: aggregateTokens.cacheReadTokens,
                        cacheWriteTokens: aggregateTokens.cacheWriteTokens,
                        outputTokens: aggregateTokens.outputTokens
                    }}
                    stageArtifact={stageArtifact}
                    proseGate={{
                        mattr500: latestMetrics.mattr500,
                        kontoyiannisEntropy: latestMetrics.kontoyiannisEntropy,
                        sentenceLengthCv: latestMetrics.sentenceLengthCv,
                        clicheDensityPer1k: latestMetrics.clicheDensityPer1k,
                        recentViolations: gateViolations
                    }}
                    factChecker={effectiveFactChecker}
                    dreaming={{
                        dirtyEntityCount: status?.dirtyEntityCount ?? null,
                        dirtyThreshold: status?.dirtyEntityThreshold ?? null,
                        coldArchiveCount:
                            entitiesView?.coldArchiveCount ?? status?.coldArchiveCount ?? 0,
                        spotlightQueue: effectiveSpotlightQueue,
                        accumulatedWords: status?.dreamWatermark?.accumulated_words_since_dream
                    }}
                    dreamWatermark={status?.dreamWatermark ?? null}
                    selectedVoiceSample={status?.writerAssemblyReport?.selectedVoiceSample ?? null}
                    strippedSecretCount={status?.writerAssemblyReport?.strippedSecretCount}
                    haltDiagnostic={haltDiagnostic}
                    modelRouting={status?.modelRouting ?? null}
                    entities={inspectorEntities}
                    openThreads={inspectorOpenThreads}
                    volumeProgress={inspectorVolumeProgress}
                    busy={isBusy}
                    onSelectEntity={() => {
                        handleOpenView('entities');
                        if (isCompact) setRightOpen(false);
                    }}
                    onSelectChapter={(ch) => {
                        handleSelectChapter(ch);
                        if (isCompact) setRightOpen(false);
                    }}
                    onTriggerDreaming={() => {
                        void handleDream().catch((err) => {
                            showToast(err instanceof Error ? err.message : String(err), 'error');
                        });
                    }}
                    onInspectHalt={() => {
                        const epoch = workspaceEpochRef.current;
                        void fetchViewHalt(...scopeArgs).then((nextHalt) => {
                            if (!isCurrentWorkspace(epoch)) return;
                            setHaltView(nextHalt);
                            const diag = mapHaltDiagnostic(nextHalt);
                            if (diag) {
                                showToast(`${diag.kind}: ${diag.reason}`, 'error');
                            }
                        });
                    }}
                    onInspectStageSession={handleInspectStageSessionById}
                />
            );
        }
        if (rightTab === 'routing') {
            return (
                <RoleRoutingEditor
                    resetKey={status?.bookRoot ?? null}
                    defaultModel={status?.defaultModel ?? null}
                    poolOverrides={status?.poolOverrides ?? null}
                    poolRoutes={effectivePoolRoutes}
                    modelRouting={status?.modelRouting ?? null}
                    roleRouting={status?.roleRouting ?? null}
                    roleDefinitions={status?.roleDefinitions ?? null}
                    availableModels={status?.availableModels ?? null}
                    busy={isBusy}
                    onSaveModelRouting={handleSaveModelRouting}
                />
            );
        }
        return null;
    };

    return (
        <div
            ref={shellRef}
            className={shellClassName}
            style={shellStyle}
        >
            {showLeftPane && (
                <LeftBookNav
                    currentBookRoot={currentBookRoot}
                    currentTitle={status?.title ?? activeBookSummary?.title ?? ''}
                    currentSlug={status?.bookSlug ?? activeBookSummary?.slug ?? ''}
                    chapterCount={status?.chapterCount ?? chapters.length}
                    storyDay={status?.worldState.story_day ?? 1}
                    walPhase={status?.walPhase ?? 'IDLE'}
                    books={booksState.books}
                    chapters={navChapters}
                    selectedChapter={selectedChapter}
                    entityCount={entitiesView?.entities.length ?? status?.entityCount ?? 0}
                    coldArchiveCount={entitiesView?.coldArchiveCount ?? status?.coldArchiveCount ?? 0}
                    warpedHorizonCount={parsedHorizonCounts.warped.length}
                    pendingHorizonCount={parsedHorizonCounts.pending.length}
                    openThreadsCount={openThreadsCount}
                    activeViewKind={activeViewKind}
                    loading={loading}
                    currentVolumeLabel={status?.volumeProgress?.volumeLabel}
                    onSelectBook={handleSelectBook}
                    onNewBook={handleOpenNewBook}
                    onSelectChapter={handleSelectChapter}
                    onOpenView={handleOpenView}
                />
            )}

            {showLeftPane && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整左侧目录栏宽度"
                    aria-valuemin={LEFT_WIDTH_MIN}
                    aria-valuemax={LEFT_WIDTH_MAX}
                    aria-valuenow={leftWidth}
                    tabIndex={0}
                    className={`ns-pane-resizer ns-pane-resizer-left${
                        resizingSide === 'left' ? ' ns-pane-resizer-active' : ''
                    }`}
                    style={{ left: 'calc(var(--ns-left-w, 224px) - 3px)' }}
                    onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => beginPaneResize('left', e)}
                    onPointerMove={(e: React.PointerEvent<HTMLDivElement>) => movePaneResize('left', e)}
                    onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => endPaneResize('left', e)}
                    onPointerCancel={(e: React.PointerEvent<HTMLDivElement>) => endPaneResize('left', e)}
                    onDoubleClick={() => resetPaneWidth('left')}
                    onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => handleSeparatorKeyDown('left', e)}
                />
            )}

            <CenterWorkbench
                bookTitle={status?.title ?? activeBookSummary?.title}
                bookSlug={status?.bookSlug ?? activeBookSummary?.slug}
                currentBookRoot={currentBookRoot}
                books={booksState.books}
                currentChapter={status?.worldState.current_chapter ?? status?.latestChapter ?? 0}
                selectedChapter={selectedChapter ?? undefined}
                timelineMode={String(status?.worldState.timeline_mode ?? 'MAINLINE')}
                walPhase={status?.walPhase ?? 'IDLE'}
                txLockHeld={status?.txLockHeld}
                chapterRetry={status?.chapterRetry}
                activeTask={activeTask}
                haltRequested={status?.runtime.haltRequested}
                haltWaiting={haltWaiting}
                yolo={status?.yolo}
                chapters={chapters}
                chapterDetail={centerChapterDetail}
                chapterLoading={chapterLoading}
                stages={liveStageOverrides}
                sessionStages={effectiveStages}
                latestSseStage={projectedLiveStage}
                safeHalt={safeHaltInfo}
                syncConflict={syncConflictInfo}
                gateViolations={effectiveGateViolations}
                pendingSignals={pendingSignals}
                pendingSignalsCount={pendingSignals.length}
                materializedViews={{
                    entities: entitiesView?.entities,
                    coldArchiveCount: entitiesView?.coldArchiveCount,
                    horizonMarkdown: horizonView?.content,
                    threadsMarkdown: threadsView?.content
                }}
                dirtyChaptersCount={dirtyChaptersCount}
                externalViewCommand={externalViewCommand}
                leftOpen={leftOpen}
                showCompactNav={!isWide}
                rightOpen={rightOpen}
                hasSafeHalt={Boolean(safeHaltInfo || syncConflictInfo)}
                currentVolumeLabel={status?.volumeProgress?.volumeLabel}
                storyDay={status?.worldState.story_day ?? 1}
                parallelWindowId={activeParallelWindowId || undefined}
                roleDefinitions={status?.roleDefinitions}
                roleRouting={status?.roleRouting}
                modelRouting={status?.modelRouting}
                poolRoutes={effectivePoolRoutes}
                nextChapterOptions={status?.nextChapterOptions}
                revealNonce={revealNonce}
                stashedDraft={currentStashedDraft}
                onRestoreStashedDraft={(entry) => {
                    const nextStash = removeStashedDraft(
                        draftStashRef.current,
                        entry.bookRoot,
                        entry.chapterNumber
                    );
                    draftStashRef.current = nextStash;
                    setDraftStash(nextStash);
                }}
                onDiscardStashedDraft={(bookRoot, chapterNumber) => {
                    const nextStash = removeStashedDraft(
                        draftStashRef.current,
                        bookRoot,
                        chapterNumber
                    );
                    draftStashRef.current = nextStash;
                    setDraftStash(nextStash);
                    showToast('已丢弃暂存手改，恢复定稿原文');
                }}
                onSelectBook={handleSelectBook}
                onNewBook={handleOpenNewBook}
                onToggleLeft={handleToggleLeft}
                onToggleRight={() => setRightOpen((prev) => !prev)}
                onOpenCodex={(kind) => {
                    setActiveViewKind(kind);
                    void loadViews();
                }}
                onCodexTabChange={(kind) => setActiveViewKind(kind)}
                onCloseCodex={() => setActiveViewKind(null)}
                onDismissSignal={(idx) => {
                    void handleDismissSignal(idx);
                }}
                onSelectChapter={handleSelectChapter}
                onStepOne={handleStepOne}
                onStartYolo={handleStartYolo}
                onStopYolo={handleStopYolo}
                onRequestHalt={handleRequestHalt}
                onSync={handleSync}
                onDream={handleDream}
                onHarvestVoice={handleHarvestVoice}
                onHealConflicts={syncConflictsView?.conflicts[0] && syncConflictsView.reportRevision ? handleHealConflicts : undefined}
                onOpenAdvanceVolumeModal={() => {
                    setVolumeError(null);
                    setVolumeModalOpen(true);
                }}
                onOpenParallelModal={() => {
                    setParallelError(null);
                    setParallelModalOpen(true);
                }}
                onSaveChapter={handleSaveChapter}
                onSubmitSignal={handleSubmitSignal}
                onRefreshViews={loadViews}
                onDraftDirtyChange={handleDraftDirtyChange}
                onDraftControlReady={handleDraftControlReady}
                onRetryChapterDetail={() => {
                    if (chapterDetail) {
                        void loadChapterByNumber(chapterDetail.chapterNumber);
                    }
                }}
                onInspectStage={(stageId) => {
                    setInspectedStageId(stageId);
                    const node = effectiveStages[stageId];
                    if (!node?.sessionId && stageId !== 'WRITER') {
                        setSelectedStageSession(null);
                        setRightTab('trace');
                        setRightOpen(true);
                    }
                }}
                onSelectStageSession={handleSelectStageSession}
            />

            {isCompact && rightOpen && (
                <div
                    className="ns-drawer-backdrop"
                    aria-hidden="true"
                    onClick={() => setRightOpen(false)}
                />
            )}

            {rightOpen && !isCompact && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整右侧状态栏宽度"
                    aria-valuemin={RIGHT_WIDTH_MIN}
                    aria-valuemax={RIGHT_WIDTH_MAX}
                    aria-valuenow={rightWidth}
                    tabIndex={0}
                    className={`ns-pane-resizer ns-pane-resizer-right${
                        resizingSide === 'right' ? ' ns-pane-resizer-active' : ''
                    }`}
                    style={{ right: 'calc(var(--ns-right-w, 340px) - 3px)' }}
                    onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => beginPaneResize('right', e)}
                    onPointerMove={(e: React.PointerEvent<HTMLDivElement>) => movePaneResize('right', e)}
                    onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => endPaneResize('right', e)}
                    onPointerCancel={(e: React.PointerEvent<HTMLDivElement>) => endPaneResize('right', e)}
                    onDoubleClick={() => resetPaneWidth('right')}
                    onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => handleSeparatorKeyDown('right', e)}
                />
            )}

            {rightOpen && (
                <aside
                    className={`ns-right-pane${isCompact ? ' ns-right-drawer' : ''}`}
                    aria-label="右侧状态与配置栏"
                >
                    <div className="ns-right-top">
                        <div
                            className="ns-right-tabs-group"
                            role="tablist"
                            aria-label="作品辅助视图"
                            onKeyDown={handleTabKeyDown}
                        >
                            <button
                                type="button"
                                role="tab"
                                id="ns-right-tab-trace"
                                aria-controls="ns-right-panel"
                                tabIndex={rightTab === 'trace' ? 0 : -1}
                                aria-selected={rightTab === 'trace'}
                                className={`ns-right-tab${rightTab === 'trace' ? ' ns-active' : ''}`}
                                onClick={() => setRightTab('trace')}
                            >
                                思考过程
                                {activeStageAttemptCount > 0 && selectedStageSession?.status === 'active' && (
                                    <span className="ns-right-tab-dot ns-dot-live" aria-hidden="true" />
                                )}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                id="ns-right-tab-status"
                                aria-controls="ns-right-panel"
                                tabIndex={rightTab === 'status' ? 0 : -1}
                                aria-selected={rightTab === 'status'}
                                className={`ns-right-tab${rightTab === 'status' ? ' ns-active' : ''}`}
                                onClick={() => setRightTab('status')}
                            >
                                运行状态
                                {(safeHaltInfo || syncConflictInfo) && (
                                    <span className="ns-right-tab-dot" aria-hidden="true" />
                                )}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                id="ns-right-tab-routing"
                                aria-controls="ns-right-panel"
                                tabIndex={rightTab === 'routing' ? 0 : -1}
                                aria-selected={rightTab === 'routing'}
                                className={`ns-right-tab${rightTab === 'routing' ? ' ns-active' : ''}`}
                                onClick={() => setRightTab('routing')}
                            >
                                模型分配
                            </button>
                        </div>
                        {isCompact && (
                            <button
                                type="button"
                                className="ns-btn ns-btn-icon-only"
                                onClick={() => setRightOpen(false)}
                                aria-label="关闭右侧面板"
                            >
                                ×
                            </button>
                        )}
                    </div>

                    <div
                        className="ns-right-scroll"
                        id="ns-right-panel"
                        role="tabpanel"
                        aria-labelledby={`ns-right-tab-${rightTab}`}
                        tabIndex={0}
                    >
                        {renderRightTabContent()}
                    </div>
                </aside>
            )}

            <BootBookModal
                open={bootModalOpen}
                onClose={() => setBootModalOpen(false)}
                onSubmitBoot={(payload) => bootBook(payload, ...scopeArgs)}
                onBootSuccess={(data) => {
                    stashCurrentDraftIfDirty();
                    workspaceEpochRef.current += 1;
                    chapterRequestSeqRef.current += 1;
                    currentBookRootRef.current = data.bookRoot;
                    setActiveParallelWindowId('');
                    setActiveParallelBranchId('');
                    setChapterDetail(null);
                    setSelectedChapter(null);
                    showToast(`新书编译完成：${data.bookRoot}`);
                    void refreshAll(null);
                }}
            />

            <AdvanceVolumeModal
                open={volumeModalOpen}
                currentVolumeLabel={status?.volumeProgress?.volumeLabel}
                entities={inspectorEntities.map((ent) => ({
                    id: ent.id,
                    name: ent.name,
                    ...(ent.role ? { role: ent.role } : {})
                }))}
                submitting={volumeSubmitting}
                errorMessage={volumeError}
                onClose={() => setVolumeModalOpen(false)}
                onConfirm={async (payload) => {
                    setVolumeSubmitting(true);
                    setVolumeError(null);
                    try {
                        const res = await advanceVolume(payload, ...scopeArgs);
                        setVolumeModalOpen(false);
                        showToast(
                            res.completedBook
                                ? '全书已完结封笔'
                                : `第 ${res.sealedVolume} 卷已封存，已开启第 ${res.nextVolume} 卷`
                        );
                        await refreshAll(selectedChapterRef.current);
                    } catch (err) {
                        setVolumeError(err instanceof Error ? err.message : String(err));
                    } finally {
                        setVolumeSubmitting(false);
                    }
                }}
            />

            <ParallelWindowModal
                open={parallelModalOpen}
                parallelActive={
                    String(status?.worldState.timeline_mode ?? '') === 'PARALLEL' ||
                    Boolean(activeParallelWindowId)
                }
                activeWindowId={activeParallelWindowId}
                activeBranchId={activeParallelBranchId}
                submitting={parallelSubmitting}
                errorMessage={parallelError}
                onClose={() => setParallelModalOpen(false)}
                onFork={async (payload) => {
                    setParallelSubmitting(true);
                    setParallelError(null);
                    try {
                        const alreadyParallel =
                            String(status?.worldState.timeline_mode ?? '') === 'PARALLEL' ||
                            Boolean(activeParallelWindowId);
                        const resolvedBranch = payload.branchId?.trim() || 'branch-a';
                        if (alreadyParallel) {
                            setActiveParallelWindowId(payload.windowId);
                            setActiveParallelBranchId(resolvedBranch);
                            setParallelModalOpen(false);
                            showToast(`已切换并行支线：${resolvedBranch}（窗口 ${payload.windowId}）`);
                            return;
                        }
                        await forkParallelWindow({ windowId: payload.windowId }, ...scopeArgs);
                        setActiveParallelWindowId(payload.windowId);
                        setActiveParallelBranchId(resolvedBranch);
                        setParallelModalOpen(false);
                        showToast(`已开启多线并行窗口：${payload.windowId}`);
                        await refreshAll(selectedChapterRef.current);
                    } catch (err) {
                        setParallelError(err instanceof Error ? err.message : String(err));
                    } finally {
                        setParallelSubmitting(false);
                    }
                }}
                onMerge={async (payload) => {
                    setParallelSubmitting(true);
                    setParallelError(null);
                    try {
                        await mergeParallelWindow({ windowId: payload.windowId }, ...scopeArgs);
                        setActiveParallelWindowId('');
                        setActiveParallelBranchId('');
                        setParallelModalOpen(false);
                        showToast(`并行窗口 ${payload.windowId} 已合流回主线`);
                        await refreshAll(selectedChapterRef.current);
                    } catch (err) {
                        setParallelError(err instanceof Error ? err.message : String(err));
                    } finally {
                        setParallelSubmitting(false);
                    }
                }}
            />

            {toasts.map((item) => (
                <Toast
                    key={item.id}
                    text={item.message}
                    holdMs={item.kind === 'error' ? 6000 : 3000}
                    onDone={() => setToasts((prev) => prev.filter((t) => t.id !== item.id))}
                />
            ))}
        </div>
    );
}

/** 侧栏导航图标组件 */
function NarrateStudioSidebarIcon(): React.ReactElement {
    return (
        <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            <path d="M8 7h8" />
            <path d="M8 11h6" />
        </svg>
    );
}

export const STAGE_CONVERSATION_SLOT = 'narrateos.stage.conversation';

const StageViewModeContext = createContext<string>('chat');

function StageConversationView(props: {
    renderSlot: (name: string, owner: { view?: string }) => React.ReactNode;
}): React.ReactElement {
    const view = useContext(StageViewModeContext);
    return <>{props.renderSlot('conversation.session', { view })}</>;
}

function StageConversationUnavailable(props: {
    sessionId: string;
    view?: string | undefined;
}): React.ReactElement {
    return (
        <div className="ns-session-fallback" data-stage-conversation-fallback="true">
            <div className="ns-session-fallback-title">原生 Conversation 渲染器暂不可用</div>
            <p>
                当前宿主尚未挂载 <code>conversation.content</code> Factory 或 <code>useConversation</code> Hook，
                无法渲染原生 {props.view === 'trajectory' ? 'Trajectory' : 'Conversation'} 视图。
            </p>
            <dl className="ns-session-kv ns-mono">
                <dt>sessionId</dt>
                <dd>{props.sessionId}</dd>
            </dl>
        </div>
    );
}

type StageSessionHook = <T>(
    selector: (snapshot: {
        blank?: boolean;
        awaitingFirstTurn?: boolean;
        running?: boolean;
        promptAttempted?: boolean;
        openState?: string;
        subagent?: { address: { mode: string }; parentAvailable?: boolean } | null;
    }) => T
) => T;

type StageConversationHook = <T>(
    selector: (snapshot: { activeTargets?: { size?: number } }) => T
) => T;

type StageSessionsHook = <T>(
    selector: (state: { byId?: Record<string, { blank?: boolean }> }) => T
) => T;

type StageRenderFactorySlot = (
    name: string,
    props: { variant: 'embedded'; phase: 'settling' | 'hero' | 'active'; hero: boolean },
    overrides: {
        slots: { views: typeof StageConversationView };
        fallback?: React.ReactNode;
    }
) => React.ReactNode;

export interface StageConversationSlotPanelProps {
    sessionId: string;
    view?: string | undefined;
    useSession?: StageSessionHook | undefined;
    useConversation?: StageConversationHook | undefined;
    useSessions?: StageSessionsHook | undefined;
    renderFactorySlot?: StageRenderFactorySlot | undefined;
}

function resolveConversationSlotPhase(params: {
    activeTargetsSize: number;
    session: {
        blank?: boolean;
        awaitingFirstTurn?: boolean;
        running?: boolean;
        promptAttempted?: boolean;
        openState?: string;
        subagent?: { address: { mode: string }; parentAvailable?: boolean } | null;
    };
    summaryBlank: boolean | undefined;
}): { phase: 'settling' | 'hero' | 'active'; hero: boolean } {
    const { activeTargetsSize, session, summaryBlank } = params;
    let shellPhase: 'active' | 'engaging' | 'blank' = 'blank';
    if (
        activeTargetsSize > 0 ||
        (!session?.blank && !session?.awaitingFirstTurn) ||
        session?.running
    ) {
        shellPhase = 'active';
    } else if (session?.promptAttempted) {
        shellPhase = 'engaging';
    }
    const parentAvailabilityPending =
        session?.subagent?.address?.mode === 'continuable' &&
        session.subagent.parentAvailable === undefined;
    const settling =
        (shellPhase === 'blank' && session?.openState === 'loading' && summaryBlank !== true) ||
        parentAvailabilityPending;
    const hero =
        shellPhase === 'blank' && (session?.openState === 'open' || summaryBlank === true);
    let phase: 'settling' | 'hero' | 'active' = 'active';
    if (settling) {
        phase = 'settling';
    } else if (hero) {
        phase = 'hero';
    }
    return { phase, hero };
}

function StageConversationSlotBody({
    sessionId,
    view = 'chat',
    useSession,
    useConversation,
    useSessions,
    renderFactorySlot
}: {
    sessionId: string;
    view: string;
    useSession: StageSessionHook;
    useConversation: StageConversationHook;
    useSessions: StageSessionsHook;
    renderFactorySlot: StageRenderFactorySlot;
}): React.ReactElement {
    const session = useSession((value) => value);
    const conversation = useConversation((value) => value);
    const summaryBlank = useSessions((state) => state?.byId?.[sessionId]?.blank);
    const activeTargetsSize = conversation?.activeTargets?.size ?? 0;
    const { phase, hero } = resolveConversationSlotPhase({
        activeTargetsSize,
        session,
        summaryBlank
    });

    return (
        <StageViewModeContext.Provider value={view}>
            {renderFactorySlot(
                'conversation.content',
                {
                    variant: 'embedded',
                    phase,
                    hero
                },
                {
                    slots: { views: StageConversationView },
                    fallback: <StageConversationUnavailable sessionId={sessionId} view={view} />
                }
            )}
        </StageViewModeContext.Provider>
    );
}

/**
 * 在 SessionProvider 作用域内挂载 DSH 原生 'conversation.content' 工厂，
 * 并在缺少 useConversation 或未加载 Factory 时安全降级，避免抛出 TypeError。
 */
export function StageConversationSlotPanel({
    sessionId,
    view = 'chat',
    useSession,
    useConversation,
    useSessions,
    renderFactorySlot
}: StageConversationSlotPanelProps): React.ReactElement {
    if (
        typeof useSession !== 'function' ||
        typeof useConversation !== 'function' ||
        typeof useSessions !== 'function' ||
        typeof renderFactorySlot !== 'function'
    ) {
        return <StageConversationUnavailable sessionId={sessionId} view={view} />;
    }

    return (
        <StageConversationSlotBody
            sessionId={sessionId}
            view={view}
            useSession={useSession}
            useConversation={useConversation}
            useSessions={useSessions}
            renderFactorySlot={renderFactorySlot}
        />
    );
}

function readContextService(ctx: unknown, serviceName: string): unknown {
    if (!ctx || typeof ctx !== 'object') return undefined;
    const record = ctx as Record<string, unknown>;
    const getter = record['get'];
    if (typeof getter === 'function') {
        try {
            return (getter as (name: string) => unknown).call(ctx, serviceName);
        } catch {
            return undefined;
        }
    }
    try {
        return record[serviceName];
    } catch {
        return undefined;
    }
}

function readSessionsService(ctx: unknown): StudioSessionsService | undefined {
    const candidate = readContextService(ctx, 'sessions');
    if (
        candidate &&
        typeof candidate === 'object' &&
        typeof (candidate as StudioSessionsService).retain === 'function'
    ) {
        return candidate as StudioSessionsService;
    }
    return undefined;
}

function hasSessionUiServices(targetCtx: unknown, fallbackCtx?: unknown): boolean {
    const uiSession =
        readContextService(targetCtx, 'uiSession') ?? readContextService(fallbackCtx, 'uiSession');
    const uiConversation =
        readContextService(targetCtx, 'uiConversation') ??
        readContextService(fallbackCtx, 'uiConversation');
    return Boolean(uiSession && uiConversation);
}

interface NarrateStudioSlotProps {
    SessionProvider?: StudioSessionProviderComponent | undefined;
    renderSlot?: ((slotName: string, owner: Record<string, unknown>) => React.ReactNode) | undefined;
}

/**
 * Cordis 客户端插件入口：向 @deepseek-ai/dsh 双半侧槽位注册主舞台与侧栏导航。
 * 保存并卸载清理全部动态注入句柄（包含 ['sessions'] 与 ['uiSession', 'uiConversation']）。
 */
export function apply(ctx: Context): void {
    const slots = ctx.slots as
        | {
              inject?: (slotName: string, factory: unknown) => unknown;
              register?: (
                  meta: Record<string, unknown>,
                  component: React.FC<Record<string, unknown>>
              ) => unknown;
          }
        | undefined;
    if (!slots || typeof slots.inject !== 'function') {
        return;
    }

    let currentSessionsService = readSessionsService(ctx);
    const sessionSubscribers = new Set<() => void>();
    const notifySessionSubscribers = (): void => {
        for (const listener of sessionSubscribers) {
            listener();
        }
    };

    const dynamicInject = (
        ctx as unknown as {
            inject?: (deps: string[], callback: (scope: Context) => void | (() => void)) => unknown;
        }
    ).inject;
    const disposeDynamicResult = (handle: unknown): void => {
        if (typeof handle === 'function') {
            (handle as () => void)();
            return;
        }
        if (
            handle &&
            typeof handle === 'object' &&
            typeof (handle as { dispose?: unknown }).dispose === 'function'
        ) {
            void (handle as { dispose: () => unknown }).dispose();
        }
    };
    const registerScopeEffect = (
        scope: Context,
        setup: () => void | (() => void),
        label: string
    ): void => {
        const scopeEffect = (
            scope as unknown as {
                effect?: (callback: () => void | (() => void), name?: string) => unknown;
            }
        ).effect;
        if (typeof scopeEffect === 'function') {
            scopeEffect.call(scope, setup, label);
        } else {
            setup();
        }
    };

    const NarrateStudioPanel: React.FC<NarrateStudioSlotProps> = ({
        SessionProvider,
        renderSlot
    }) => {
        const [sessionsService, setSessionsService] = useState<StudioSessionsService | undefined>(
            () => currentSessionsService ?? readSessionsService(ctx)
        );

        useEffect(() => {
            const sync = () => {
                setSessionsService(currentSessionsService ?? readSessionsService(ctx));
            };
            sync();
            sessionSubscribers.add(sync);
            return () => {
                sessionSubscribers.delete(sync);
            };
        }, []);

        const sessionList = sessionsService?.list;
        const subscribeSessions = useCallback((listener: () => void) =>
            sessionList?.subscribe?.(listener) ?? (() => {}), [sessionList]);
        const readSessionList = useCallback(
            () => sessionList?.subscribe ? sessionList.getSnapshot() : undefined,
            [sessionList]
        );
        const sessions = useSyncExternalStore(subscribeSessions, readSessionList);
        const mainSession = Object.entries(sessions?.byId ?? {}).find(([, row]) =>
            (row.retainedBy?.['mainView'] ?? 0) > 0
        );
        const sessionId = mainSession?.[0];
        const directory = sessionId
            ? sessionsService?.binding?.(sessionId)?.session.projections.faceOf('workingDirectory')
            : undefined;
        const subscribeDirectory = useCallback((listener: () => void) =>
            directory?.subscribe(listener) ?? (() => {}), [directory]);
        const readDirectory = useCallback(() => directory?.getSnapshot(), [directory]);
        const projectedDirectory = useSyncExternalStore(subscribeDirectory, readDirectory);
        const cwd = typeof projectedDirectory === 'string' ? projectedDirectory : mainSession?.[1].cwd;
        const requestScope = useMemo<StudioRequestScope | undefined>(
            () => sessionId ? { sessionId } : undefined,
            [sessionId, cwd]
        );
        const sharedDrafts = useRef<DraftStashMap>({});

        const renderStageConversation = useMemo<StudioRenderStageConversation | undefined>(() => {
            if (typeof renderSlot !== 'function') return undefined;
            return (owner) => renderSlot(STAGE_CONVERSATION_SLOT, owner);
        }, [renderSlot]);

        if (sessionList?.subscribe && !requestScope) {
            return <div role="status">请先在主对话选择工作区并打开会话，再使用创作室。</div>;
        }

        return (
            <NarrateStudioRoot
                key={JSON.stringify([sessionId, cwd])}
                requestScope={requestScope}
                sharedDrafts={sharedDrafts}
                sessionsService={sessionsService}
                SessionProvider={SessionProvider}
                renderStageConversation={renderStageConversation}
            />
        );
    };

    const injectSlot = slots.inject.bind(slots);
    const registerSlot = typeof slots.register === 'function' ? slots.register.bind(slots) : null;

    const registerMainSlots = (withSessionUi: boolean): (() => void) => {
        const disposers: Array<() => void> = [];

        const mainMeta: Record<string, unknown> = {
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ title: 'NarrateOS 创作室' })
        };
        if (withSessionUi) {
            mainMeta['children'] = {
                [STAGE_CONVERSATION_SLOT]: {
                    kind: 'single',
                    scope: 'session'
                }
            };
        }

        const disposeMain = injectSlot(
            'main',
            registerSlot
                ? () =>
                      registerSlot(
                          mainMeta,
                          NarrateStudioPanel as React.FC<Record<string, unknown>>
                      )
                : {
                      key: PANEL_ID,
                      title: 'NarrateOS 创作室',
                      render: () => <NarrateStudioPanel />
                  }
        );
        if (typeof disposeMain === 'function') {
            disposers.push(disposeMain as () => void);
        }

        if (withSessionUi && registerSlot) {
            const disposeStageConversation = injectSlot(STAGE_CONVERSATION_SLOT, () =>
                registerSlot(
                    { name: STAGE_CONVERSATION_SLOT },
                    StageConversationSlotPanel as unknown as React.FC<Record<string, unknown>>
                )
            );
            if (typeof disposeStageConversation === 'function') {
                disposers.push(disposeStageConversation as () => void);
            }
        }

        return () => {
            for (const dispose of disposers.reverse()) {
                try {
                    dispose();
                } catch {
                    // 忽略重复卸载或宿主已清理时的异常
                }
            }
        };
    };

    const registerSlots = (): (() => void) => {
        const disposers: Array<() => void> = [];
        let disposedAll = false;
        let activeMainDisposer: (() => void) | null = null;
        let currentSessionUi = false;

        const syncMainRegistration = (withSessionUi: boolean): void => {
            if (disposedAll) return;
            if (activeMainDisposer && currentSessionUi === withSessionUi) {
                return;
            }
            if (activeMainDisposer) {
                activeMainDisposer();
                activeMainDisposer = null;
            }
            currentSessionUi = withSessionUi;
            activeMainDisposer = registerMainSlots(withSessionUi);
        };

        if (typeof dynamicInject === 'function') {
            try {
                const sessionsInjectHandle = dynamicInject.call(
                    ctx,
                    ['sessions'],
                    (scope: Context) => {
                        registerScopeEffect(
                            scope,
                            () => {
                                currentSessionsService =
                                    readSessionsService(scope) ?? readSessionsService(ctx);
                                notifySessionSubscribers();
                                return () => {
                                    currentSessionsService = readSessionsService(ctx);
                                    notifySessionSubscribers();
                                };
                            },
                            'narrateos-studio:optional-sessions'
                        );
                    }
                );
                if (sessionsInjectHandle) {
                    disposers.push(() => {
                        disposeDynamicResult(sessionsInjectHandle);
                    });
                }
            } catch {
                // 宿主未提供可选 sessions 服务时保持静默降级
            }
        }

        const disposeSidebar = injectSlot(
            'sidebar.panellist',
            registerSlot
                ? () =>
                      registerSlot(
                          {
                              name: 'sidebar.panellist',
                              id: PANEL_ID,
                              order: 15,
                              label: () => '创作室'
                          },
                          NarrateStudioSidebarIcon as React.FC<Record<string, unknown>>
                      )
                : {
                      id: PANEL_ID,
                      order: 15,
                      label: () => '创作室',
                      icon: () => <NarrateStudioSidebarIcon />
                  }
        );
        if (typeof disposeSidebar === 'function') {
            disposers.push(disposeSidebar as () => void);
        }

        if (typeof dynamicInject === 'function') {
            try {
                const sessionUiInjectHandle = dynamicInject.call(
                    ctx,
                    ['uiSession', 'uiConversation'],
                    (sessionUiCtx: Context) => {
                        registerScopeEffect(
                            sessionUiCtx,
                            () => {
                                if (!hasSessionUiServices(sessionUiCtx, ctx)) {
                                    return;
                                }
                                syncMainRegistration(true);
                                return () => {
                                    if (!disposedAll) {
                                        syncMainRegistration(false);
                                    }
                                };
                            },
                            'narrateos-studio:optional-session-ui'
                        );
                    }
                );
                if (sessionUiInjectHandle) {
                    disposers.push(() => {
                        disposeDynamicResult(sessionUiInjectHandle);
                    });
                }
            } catch {
                // 宿主不支持多服务动态注入时安全回退为基础槽位
            }
        }

        if (!activeMainDisposer) {
            syncMainRegistration(hasSessionUiServices(ctx));
        }

        return () => {
            disposedAll = true;
            if (activeMainDisposer) {
                activeMainDisposer();
                activeMainDisposer = null;
            }
            for (const dispose of disposers) {
                try {
                    dispose();
                } catch {
                    // 忽略重复卸载或宿主已清理时的异常
                }
            }
        };
    };

    const effect = (
        ctx as unknown as {
            effect?: (callback: () => void | (() => void), label?: string) => unknown;
        }
    ).effect;

    if (typeof effect === 'function') {
        effect.call(ctx, registerSlots, 'narrateos-studio-slots');
    } else {
        registerSlots();
    }
}

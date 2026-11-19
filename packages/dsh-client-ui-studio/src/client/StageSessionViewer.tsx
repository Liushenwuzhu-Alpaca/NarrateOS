import React, { useEffect, useState } from 'react';
import { fetchRunDetail } from './api';
import type { StageNodeStatus } from './CenterWorkbench';
import type {
    RunDetailPayload,
    RunDetailRequestInput,
    RunDetailToolCall,
    RunDetailTurn,
    StageSessionDetailEvent,
    StageSessionSubagentMode
} from './types';

/** 阶段会话视图模式：chat=原生 Conversation 思考与工具流；trajectory=原生 Trajectory 轮次明细 */
export type StageSessionViewMode = 'chat' | 'trajectory';

/** 阶段节点关联的会话钻取目标 */
export interface StageSessionSelection {
    stageId: string;
    stageLabel: string;
    sessionId: string;
    parentSessionId?: string | undefined;
    mode?: StageSessionSubagentMode | string | undefined;
    runId?: string | undefined;
    status: StageNodeStatus;
    cleanroom?: boolean | undefined;
}

/** 宿主 Session 引用句柄（对齐 @deepseek-ai/dsh-api-session-controller SessionReference） */
export interface StudioSessionReference {
    readonly sessionId: string;
    readonly ready?: Promise<unknown> | undefined;
    release(): void;
}

/** 宿主 sessions.retain 支持的会话定位目标（SessionId 或父子 SubagentAddress） */
export type StudioSessionTarget =
    | string
    | {
          parentSessionId: string;
          childSessionId: string;
          mode: StageSessionSubagentMode;
      };

/** 宿主 ctx.sessions 最小结构接口 */
export interface StudioSessionsService {
    retain(
        target: StudioSessionTarget,
        options: {
            source: string;
            signal?: AbortSignal | undefined;
        }
    ): StudioSessionReference;
    list?: {
        getSnapshot(): {
            byId?: Record<string, { title?: string | undefined; running?: boolean | undefined }> | undefined;
        };
    } | undefined;
}

/** 宿主 SlotRegistry 提供的 SessionProvider 组件签名 */
export type StudioSessionProviderComponent = React.ComponentType<{
    session: unknown;
    children?: React.ReactNode;
}>;

/** 渲染子槽位 narrateos.stage.conversation 的回调 */
export type StudioRenderStageConversation = (owner: {
    view?: StageSessionViewMode | string;
}) => React.ReactNode;

/** 同节点多尝试切换条目 */
export interface StageViewerAttemptItem {
    sessionId: string;
    label: string;
    status?: string | undefined;
    attempt?: number | undefined;
    triggerReason?: string | undefined;
}

/** StageSessionViewer 组件 Props */
export interface StageSessionViewerProps {
    selection: StageSessionSelection | null;
    sessionsService?: StudioSessionsService | undefined;
    SessionProvider?: StudioSessionProviderComponent | undefined;
    renderStageConversation?: StudioRenderStageConversation | undefined;
    onClose?: (() => void) | undefined;
    /** 当前阶段生效模型标签（如 provider:model），用于原生/回退顶部抬头即时展示 */
    effectiveModelLabel?: string | undefined;
    /** 同节点多次尝试会话列表（如 初稿执笔 / 局部润色 Patch / 整章重写） */
    attemptSessions?: StageViewerAttemptItem[] | undefined;
    /** 切换同节点尝试会话回调 */
    onSelectAttemptSession?: ((sessionId: string) => void) | undefined;
    /** 来自 stage:event SSE 的实时增量事件流 */
    liveEvents?: StageSessionDetailEvent[] | undefined;
}

function defaultViewModeForStatus(status: StageNodeStatus | undefined): StageSessionViewMode {
    if (status === 'active' || status === 'healing') {
        return 'chat';
    }
    return 'trajectory';
}

function formatStageStatusText(status: StageNodeStatus): {
    label: string;
    pillClass: string;
} {
    switch (status) {
        case 'active':
            return { label: '运行中', pillClass: 'ns-pill ns-pill-brand' };
        case 'done':
            return { label: '已完成', pillClass: 'ns-pill ns-pill-green' };
        case 'healing':
            return { label: '返修中', pillClass: 'ns-pill ns-pill-amber' };
        case 'halt':
            return { label: '已拦截', pillClass: 'ns-pill ns-pill-red' };
        case 'dormant':
            return { label: '条件未达', pillClass: 'ns-pill ns-pill-muted' };
        case 'idle':
        default:
            return { label: '待命', pillClass: 'ns-pill ns-pill-muted' };
    }
}

function normalizeSubagentMode(mode: string | undefined): StageSessionSubagentMode {
    if (mode === 'one-shot' || mode === 'continuable' || mode === 'unknown') {
        return mode;
    }
    return 'one-shot';
}

/** 规范化阶段工种展示名称：第 4 步核查统一显示为 4. Checker / Checker */
function normalizeStageRoleDisplayLabel(stageId: string, stageLabel: string): string {
    const upperId = stageId.trim().toUpperCase();
    const trimmed = stageLabel.trim();
    if (
        upperId === 'FACT_CHECK' ||
        upperId === 'FACT_CHECKER' ||
        /^(?:4\.\s*)?fact[\s_-]*check(?:er)?$/i.test(trimmed)
    ) {
        return '4. Checker';
    }
    return trimmed.replace(/fact[\s_-]*checker/gi, 'Checker').replace(/fact[\s_-]*check/gi, 'Checker');
}

function eventContentSignature(ev: StageSessionDetailEvent): string {
    return `${ev.kind}|${ev.callId ?? ''}|${ev.toolName ?? ''}|${ev.status ?? ''}|${ev.text ?? ''}`;
}

function isContiguousSubsequence(
    haystack: readonly string[],
    needle: readonly string[]
): boolean {
    if (needle.length === 0) return true;
    if (needle.length > haystack.length) return false;
    for (let start = 0; start <= haystack.length - needle.length; start += 1) {
        let matched = true;
        for (let offset = 0; offset < needle.length; offset += 1) {
            if (haystack[start + offset] !== needle[offset]) {
                matched = false;
                break;
            }
        }
        if (matched) return true;
    }
    return false;
}

function makeEventSeqKey(ev: StageSessionDetailEvent): string {
    return `seq:${ev.seq}:${ev.kind}:${ev.callId ?? ''}`;
}

/** 合并已落盘归档事件与实时 stage:event SSE 增量事件，避免重复条目 */
function mergeSessionEvents(
    archived: readonly StageSessionDetailEvent[] | undefined,
    live: readonly StageSessionDetailEvent[] | undefined,
    isTerminal = false
): StageSessionDetailEvent[] {
    const archivedList = Array.isArray(archived) ? archived : [];
    const liveList = Array.isArray(live) ? live : [];
    if (isTerminal && archivedList.length > 0) return [...archivedList];
    if (archivedList.length === 0) return [...liveList];
    if (liveList.length === 0) return [...archivedList];

    const bothHaveSeq =
        archivedList.every((ev) => typeof ev.seq === 'number') &&
        liveList.every((ev) => typeof ev.seq === 'number');
    if (bothHaveSeq) {
        const seenSeq = new Set<string>();
        const merged: StageSessionDetailEvent[] = [];
        for (const ev of [...archivedList, ...liveList]) {
            const key = makeEventSeqKey(ev);
            if (!seenSeq.has(key)) {
                seenSeq.add(key);
                merged.push(ev);
            }
        }
        return merged.sort((a, b) => a.seq! - b.seq!);
    }

    const archivedSigs = archivedList.map(eventContentSignature);
    const liveSigs = liveList.map(eventContentSignature);
    if (isContiguousSubsequence(archivedSigs, liveSigs)) {
        return [...archivedList];
    }

    // 计算归档尾部与实时流头部的最大重叠长度
    let overlap = 0;
    const maxOverlap = Math.min(archivedSigs.length, liveSigs.length);
    for (let len = maxOverlap; len >= 1; len -= 1) {
        let allMatch = true;
        for (let i = 0; i < len; i += 1) {
            if (archivedSigs[archivedSigs.length - len + i] !== liveSigs[i]) {
                allMatch = false;
                break;
            }
        }
        if (allMatch) {
            overlap = len;
            break;
        }
    }

    const seenCallKeys = new Set<string>();
    const seenSeq = new Set<string>();
    for (const ev of archivedList) {
        if (typeof ev.seq === 'number') {
            seenSeq.add(makeEventSeqKey(ev));
        }
        if ((ev.kind === 'tool-call' || ev.kind === 'tool-result') && ev.callId) {
            seenCallKeys.add(`${ev.kind}:${ev.callId}`);
        }
    }

    const merged = [...archivedList];
    for (const ev of liveList.slice(overlap)) {
        if (typeof ev.seq === 'number') {
            const seqKey = makeEventSeqKey(ev);
            if (seenSeq.has(seqKey)) continue;
            seenSeq.add(seqKey);
        }
        if ((ev.kind === 'tool-call' || ev.kind === 'tool-result') && ev.callId) {
            const callKey = `${ev.kind}:${ev.callId}`;
            if (seenCallKeys.has(callKey)) continue;
            seenCallKeys.add(callKey);
        }
        merged.push(ev);
    }
    return merged;
}

function formatDetailValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function renderToolCallList(calls: readonly RunDetailToolCall[] | undefined, keyPrefix: string): React.ReactNode {
    if (!calls || calls.length === 0) return null;
    return (
        <div className="ns-session-tool-list">
            {calls.map((call, idx) => {
                const argsText = formatDetailValue(call.arguments);
                const resultText = formatDetailValue(call.result);
                return (
                    <div key={call.id ?? `${keyPrefix}-tool-${idx}`} className="ns-session-tool-call">
                        <div className="ns-session-tool-head ns-mono">
                            <strong>{call.name}</strong>
                            {call.status ? <span className="ns-muted">{call.status}</span> : null}
                            {typeof call.durationMs === 'number' ? (
                                <span className="ns-muted">{call.durationMs}ms</span>
                            ) : null}
                        </div>
                        {argsText ? (
                            <pre className="ns-session-pre ns-mono">{argsText}</pre>
                        ) : null}
                        {resultText ? (
                            <details className="ns-session-tool-result-details" open>
                                <summary className="ns-mono">
                                    tool-result ({resultText.length} chars)
                                </summary>
                                <pre className="ns-session-pre ns-session-pre-result ns-mono">
                                    {resultText}
                                </pre>
                            </details>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

interface ExtractedRequestInputView {
    paramEntries: Array<[string, string]>;
    systemPrompt: string | undefined;
    taskBlocks: string[];
}

function extractRequestInputView(
    requestInput: RunDetailRequestInput | undefined
): ExtractedRequestInputView | null {
    if (!requestInput) return null;
    const paramEntries: Array<[string, string]> = [];
    if (requestInput.pool) paramEntries.push(['pool', requestInput.pool]);
    if (typeof requestInput.temperature === 'number') {
        paramEntries.push(['temperature', String(requestInput.temperature)]);
    }
    if (requestInput.reasoningEffort) {
        paramEntries.push(['reasoningEffort', requestInput.reasoningEffort]);
    }
    if (typeof requestInput.maxTokens === 'number') {
        paramEntries.push(['maxTokens', String(requestInput.maxTokens)]);
    }
    if (Array.isArray(requestInput.tools) && requestInput.tools.length > 0) {
        paramEntries.push(['tools', requestInput.tools.join(', ')]);
    }
    const knownKeys = new Set([
        'systemPrompt',
        'taskPromptBlocks',
        'pool',
        'temperature',
        'reasoningEffort',
        'maxTokens',
        'tools'
    ]);
    for (const [key, val] of Object.entries(requestInput)) {
        if (knownKeys.has(key) || val === undefined || val === null) continue;
        const formatted = formatDetailValue(val);
        if (formatted) {
            paramEntries.push([key, formatted]);
        }
    }
    const systemPrompt =
        typeof requestInput.systemPrompt === 'string' && requestInput.systemPrompt.length > 0
            ? requestInput.systemPrompt
            : undefined;
    const taskBlocks = Array.isArray(requestInput.taskPromptBlocks)
        ? requestInput.taskPromptBlocks.filter((b): b is string => typeof b === 'string' && b.length > 0)
        : [];
    if (paramEntries.length === 0 && !systemPrompt && taskBlocks.length === 0) {
        return null;
    }
    return { paramEntries, systemPrompt, taskBlocks };
}

/** 渲染完整 LLM 请求输入快照（systemPrompt、taskPromptBlocks、采样与路由参数） */
function renderRequestInputSection(
    requestInput: RunDetailRequestInput | undefined
): React.ReactNode {
    const view = extractRequestInputView(requestInput);
    if (!view) return null;
    const { paramEntries, systemPrompt, taskBlocks } = view;

    return (
        <details
            className="ns-session-turn-thinking ns-session-request-input"
            data-session-request-input="true"
        >
            <summary>完整请求输入 (requestInput)</summary>
            <div className="ns-session-request-body">
                {paramEntries.length > 0 ? (
                    <dl className="ns-session-kv ns-mono">
                        {paramEntries.map(([k, v]) => (
                            <React.Fragment key={k}>
                                <dt>{k}</dt>
                                <dd>{v}</dd>
                            </React.Fragment>
                        ))}
                    </dl>
                ) : null}
                {systemPrompt ? (
                    <div className="ns-session-request-block">
                        <div className="ns-session-request-label ns-mono">systemPrompt</div>
                        <pre className="ns-session-pre">{systemPrompt}</pre>
                    </div>
                ) : null}
                {taskBlocks.length > 0 ? (
                    <div className="ns-session-request-block">
                        <div className="ns-session-request-label ns-mono">
                            taskPromptBlocks ({taskBlocks.length})
                        </div>
                        {taskBlocks.map((block, idx) => (
                            <pre key={`task-block-${idx}`} className="ns-session-pre">
                                {block}
                            </pre>
                        ))}
                    </div>
                ) : null}
            </div>
        </details>
    );
}

/** 渲染实时原生视图下方补充的完整 tool-result 原文折叠区 */
function renderToolResultsSupplementary(
    calls: readonly RunDetailToolCall[]
): React.ReactNode {
    const withResults = calls.filter(
        (call) => call.result !== undefined && formatDetailValue(call.result).length > 0
    );
    if (withResults.length === 0) return null;
    return (
        <details
            className="ns-session-turn-thinking ns-session-tool-result-details"
            data-session-tool-results="true"
        >
            <summary>完整工具返回原文 ({withResults.length})</summary>
            <div className="ns-session-tool-list">
                {withResults.map((call, idx) => {
                    const resultText = formatDetailValue(call.result);
                    return (
                        <div
                            key={call.id ?? `sup-tool-${idx}`}
                            className="ns-session-tool-call"
                        >
                            <div className="ns-session-tool-head ns-mono">
                                <strong>{call.name}</strong>
                                {call.status ? <span className="ns-muted">{call.status}</span> : null}
                            </div>
                            <pre className="ns-session-pre ns-session-pre-result ns-mono">
                                {resultText}
                            </pre>
                        </div>
                    );
                })}
            </div>
        </details>
    );
}

function appendSeparatedText(buffer: string, text: string, separated: boolean): string {
    const needsNewline =
        buffer.length > 0 && separated && !buffer.endsWith('\n') && !text.startsWith('\n');
    return needsNewline ? `${buffer}\n${text}` : `${buffer}${text}`;
}

function normalizeEventsPayload(events: readonly StageSessionDetailEvent[] | undefined): {
    thinking: string | undefined;
    toolCalls: RunDetailToolCall[];
    output: string | undefined;
} {
    if (!events || events.length === 0) {
        return { thinking: undefined, toolCalls: [], output: undefined };
    }
    let thinkingBuffer = '';
    let thinkingSeparated = false;
    let outputBuffer = '';
    let outputSeparated = false;
    let attemptOutputStart = 0;
    let attemptThinkingStart = 0;
    const toolCalls: RunDetailToolCall[] = [];
    const callById = new Map<string, RunDetailToolCall>();

    for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.kind === 'status' && ev.status === 'attempt-start') {
            attemptOutputStart = outputBuffer.length;
            attemptThinkingStart = thinkingBuffer.length;
        } else if (ev.kind === 'status' && ev.status === 'attempt-discarded') {
            outputBuffer = outputBuffer.slice(0, attemptOutputStart);
            thinkingBuffer = thinkingBuffer.slice(0, attemptThinkingStart);
        }
        if (ev.kind === 'thinking') {
            if (typeof ev.text === 'string' && ev.text.length > 0) {
                thinkingBuffer = appendSeparatedText(thinkingBuffer, ev.text, thinkingSeparated);
                thinkingSeparated = false;
            }
            if (outputBuffer.length > 0) outputSeparated = true;
            continue;
        }

        if (thinkingBuffer.length > 0) {
            thinkingSeparated = true;
        }

        if (ev.kind === 'text') {
            if (typeof ev.text === 'string' && ev.text.length > 0) {
                outputBuffer = appendSeparatedText(outputBuffer, ev.text, outputSeparated);
                outputSeparated = false;
            }
            continue;
        }

        if (ev.kind === 'error') {
            if (typeof ev.text === 'string' && ev.text.length > 0) {
                if (outputBuffer.length > 0 && !outputBuffer.endsWith('\n')) {
                    outputBuffer += '\n';
                }
                outputBuffer += `[ERROR] ${ev.text}`;
                outputSeparated = true;
            }
            continue;
        }

        if (outputBuffer.length > 0) {
            outputSeparated = true;
        }

        if (ev.kind === 'tool-call') {
            let parsedArgs: unknown = ev.text;
            if (typeof ev.text === 'string' && ev.text.trim().length > 0) {
                try {
                    parsedArgs = JSON.parse(ev.text);
                } catch {
                    parsedArgs = ev.text;
                }
            }
            const entry: RunDetailToolCall = {
                id: ev.callId,
                name: ev.toolName || 'tool',
                arguments: parsedArgs,
                status: ev.status
            };
            toolCalls.push(entry);
            if (ev.callId) {
                callById.set(ev.callId, entry);
            }
        } else if (ev.kind === 'tool-result') {
            const matched = ev.callId ? callById.get(ev.callId) : undefined;
            if (matched) {
                matched.result = ev.text ?? '';
                matched.status = ev.status ?? matched.status ?? 'completed';
            } else {
                toolCalls.push({
                    id: ev.callId,
                    name: ev.toolName || 'tool-result',
                    result: ev.text ?? '',
                    status: ev.status ?? 'completed'
                });
            }
        }
    }

    return {
        thinking: thinkingBuffer.length > 0 ? thinkingBuffer : undefined,
        toolCalls,
        output: outputBuffer.length > 0 ? outputBuffer : undefined
    };
}

function renderRunTurn(turn: RunDetailTurn, index: number): React.ReactNode {
    const turnNumber = typeof turn.turnIndex === 'number' ? turn.turnIndex + 1 : index + 1;
    const thinking = turn.thinking ?? turn.reasoning;
    const outputText = turn.content ?? turn.output ?? turn.text;
    const calls = turn.toolCalls ?? turn.tool_calls;

    return (
        <article key={`turn-${turnNumber}-${index}`} className="ns-session-turn">
            <div className="ns-session-turn-head ns-mono">
                <strong>Turn #{turnNumber}</strong>
                {turn.role ? <span className="ns-pill ns-pill-muted">{turn.role}</span> : null}
                {turn.timestamp ? <span className="ns-muted">{turn.timestamp}</span> : null}
            </div>
            {thinking ? (
                <details className="ns-session-turn-thinking" open>
                    <summary>Thinking</summary>
                    <pre className="ns-session-pre">{thinking}</pre>
                </details>
            ) : null}
            {renderToolCallList(calls, `turn-${index}`)}
            {outputText ? (
                <div className="ns-session-turn-output">{outputText}</div>
            ) : null}
        </article>
    );
}

function resolveFallbackTitle(options: {
    hasLiveEvents: boolean;
    hasRunDetail: boolean;
    hasDetailBody: boolean;
    retainError: string | null;
}): string {
    if (options.hasLiveEvents && !options.hasRunDetail) {
        return '实时思考与工具流（stage:event 增量推流）';
    }
    if (options.hasDetailBody) {
        return '已加载阶段会话轨迹（.ops/session_logs 归档回放）';
    }
    if (options.retainError) {
        return '会话加载失败';
    }
    return '原生 DSH 会话预览不可用';
}

function renderModelMetaRow(
    resolvedModelLabel: string | undefined,
    thinkingChars: number | undefined
): React.ReactNode {
    const hasThinkingChars = typeof thinkingChars === 'number';
    if (!resolvedModelLabel && !hasThinkingChars) return null;
    return (
        <div className="ns-session-model-row ns-mono" data-session-model-meta="true">
            {resolvedModelLabel ? (
                <span className="ns-pill ns-pill-muted" title={resolvedModelLabel}>
                    执行模型: {resolvedModelLabel}
                </span>
            ) : null}
            {hasThinkingChars ? (
                <span className="ns-pill ns-pill-muted">
                    thinking: {thinkingChars} chars
                </span>
            ) : null}
        </div>
    );
}

function renderAttemptSessionsRow(
    attemptSessions: StageViewerAttemptItem[] | undefined,
    currentSessionId: string,
    onSelectAttemptSession?: (sessionId: string) => void
): React.ReactNode {
    if (!attemptSessions || attemptSessions.length === 0) return null;
    return (
        <div className="ns-session-model-row" role="group" aria-label="同阶段尝试切换">
            {attemptSessions.map((item) => {
                const isCurrent = item.sessionId === currentSessionId;
                return (
                    <button
                        key={item.sessionId}
                        type="button"
                        data-attempt-session-id={item.sessionId}
                        aria-pressed={isCurrent}
                        title={item.triggerReason}
                        className={`ns-btn ns-btn-xs ${
                            isCurrent ? 'ns-btn-ghost ns-btn-active' : 'ns-btn-ghost'
                        }`}
                        onClick={() => onSelectAttemptSession?.(item.sessionId)}
                    >
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
}

function renderViewModeSwitcher(
    viewMode: StageSessionViewMode,
    onChangeViewMode: (mode: StageSessionViewMode) => void
): React.ReactElement {
    return (
        <div className="ns-session-view-ring" role="group" aria-label="原生会话视图切换">
            <button
                type="button"
                className={`ns-session-view-btn${viewMode === 'chat' ? ' on' : ''}`}
                aria-pressed={viewMode === 'chat'}
                onClick={() => onChangeViewMode('chat')}
            >
                Conversation
            </button>
            <button
                type="button"
                className={`ns-session-view-btn${viewMode === 'trajectory' ? ' on' : ''}`}
                aria-pressed={viewMode === 'trajectory'}
                onClick={() => onChangeViewMode('trajectory')}
            >
                Trajectory
            </button>
        </div>
    );
}

function renderFallbackNotice(
    retainError: string | null,
    hasDetailBody: boolean,
    viewMode: StageSessionViewMode
): React.ReactNode {
    if (retainError && !hasDetailBody) {
        return (
            <p className="ns-session-error" role="alert">
                {retainError}
            </p>
        );
    }
    if (!hasDetailBody) {
        const modeLabel = viewMode === 'chat' ? 'Conversation' : 'Trajectory';
        return (
            <p>
                当前运行环境未注入宿主 <code>sessions</code> / <code>slots</code> 渲染器，
                无法挂载原生 {modeLabel} 视图；已在上方保留完整标识。
            </p>
        );
    }
    return null;
}

function renderFallbackDetailSection(options: {
    hasDetailBody: boolean;
    hasLiveEvents: boolean;
    runDetail: RunDetailPayload | null;
    topLevelThinking: string | undefined;
    rootOrEventToolCalls: readonly RunDetailToolCall[];
    topLevelOutput: string | undefined;
    viewMode: StageSessionViewMode;
    mergedEvents: readonly StageSessionDetailEvent[];
}): React.ReactNode {
    const {
        hasDetailBody,
        hasLiveEvents,
        runDetail,
        topLevelThinking,
        rootOrEventToolCalls,
        topLevelOutput,
        viewMode,
        mergedEvents
    } = options;
    if (!hasDetailBody) return null;

    return (
        <div
            className="ns-session-detail"
            data-session-detail="true"
            data-session-live-stream={hasLiveEvents ? 'true' : undefined}
        >
            {renderRequestInputSection(runDetail?.requestInput)}
            {topLevelThinking ? (
                <details className="ns-session-turn-thinking" open>
                    <summary>Thinking</summary>
                    <pre className="ns-session-pre">{topLevelThinking}</pre>
                </details>
            ) : null}
            {renderToolCallList(rootOrEventToolCalls, 'root')}
            {Array.isArray(runDetail?.turns) && runDetail.turns.length > 0 ? (
                <div className="ns-session-turns">
                    {runDetail.turns.map((turn, idx) => renderRunTurn(turn, idx))}
                </div>
            ) : null}
            {topLevelOutput ? (
                <div className="ns-session-turn-output">{topLevelOutput}</div>
            ) : null}
            {viewMode === 'trajectory' && mergedEvents.length > 0 ? (
                <details className="ns-session-turn-thinking">
                    <summary>原始 Trajectory 事件流 ({mergedEvents.length})</summary>
                    <pre className="ns-session-pre ns-mono">
                        {JSON.stringify(
                            {
                                usage: runDetail?.usage,
                                events: mergedEvents
                            },
                            null,
                            2
                        )}
                    </pre>
                </details>
            ) : null}
        </div>
    );
}

/**
 * 阶段工种原生 DSH Conversation / Trajectory 会话钻取检查器：
 * - 完整宿主环境（sessionsService + SessionProvider + renderStageConversation）下：
 *   调用 sessionsService.retain(...) 获取实时/历史引用（有 parentSessionId 时透传父子地址），
 *   并在卸载或切换 sessionId 时立即屏蔽旧 sessionRef 并准确调用 reference.release() 释放引用。
 * - 在内部通过 SessionProvider 挂载 'narrateos.stage.conversation' -> 'conversation.content'，
 *   支持在原生 Conversation（实时思考块与工具流）与 Trajectory（轮次耗时/Token/JSON 明细）间切换。
 * - 无宿主会话服务或 retain() 失败时：自动回源 GET /api/narrate/runs/detail?sessionId=... 展示回合、思考、工具调用与输出，
 *   并在接口返回 404 或不可用时静默保留元数据与复制入口。
 */
export function StageSessionViewer({
    selection,
    sessionsService,
    SessionProvider,
    renderStageConversation,
    onClose,
    effectiveModelLabel,
    attemptSessions,
    onSelectAttemptSession,
    liveEvents
}: StageSessionViewerProps): React.ReactElement {
    const [viewMode, setViewMode] = useState<StageSessionViewMode>(() =>
        defaultViewModeForStatus(selection?.status)
    );
    const [sessionRef, setSessionRef] = useState<StudioSessionReference | null>(null);
    const [readyState, setReadyState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [retainError, setRetainError] = useState<string | null>(null);
    const [runDetail, setRunDetail] = useState<RunDetailPayload | null>(null);
    const [detailLoading, setDetailLoading] = useState<boolean>(false);
    const [copied, setCopied] = useState<boolean>(false);

    useEffect(() => {
        setViewMode(defaultViewModeForStatus(selection?.status));
        setCopied(false);
    }, [selection?.sessionId, selection?.stageId]);

    useEffect(() => {
        const targetSessionId = selection?.sessionId;
        // 切换会话或清理选中前立刻清空旧 sessionRef，防止切换瞬间把旧句柄传给新子树
        setSessionRef(null);
        setRetainError(null);
        setReadyState('idle');

        if (!sessionsService || !targetSessionId || selection?.cleanroom) {
            return;
        }

        const controller = new AbortController();
        let disposed = false;
        let acquired: StudioSessionReference | null = null;

        const retainTarget: StudioSessionTarget = selection.parentSessionId
            ? {
                  parentSessionId: selection.parentSessionId,
                  childSessionId: targetSessionId,
                  mode: normalizeSubagentMode(selection.mode)
              }
            : targetSessionId;

        try {
            acquired = sessionsService.retain(retainTarget, {
                source: 'narrateosStudio',
                signal: controller.signal
            });
            setSessionRef(acquired);
            setRetainError(null);

            if (acquired.ready) {
                setReadyState('loading');
                void acquired.ready.then(
                    () => {
                        if (!disposed) {
                            setReadyState('ready');
                        }
                    },
                    (err: unknown) => {
                        if (!disposed) {
                            setSessionRef(null);
                            setReadyState('error');
                            setRetainError(err instanceof Error ? err.message : String(err));
                        }
                    }
                );
            } else {
                setReadyState('ready');
            }
        } catch (err) {
            setSessionRef(null);
            setReadyState('error');
            setRetainError(err instanceof Error ? err.message : String(err));
        }

        return () => {
            disposed = true;
            controller.abort();
            if (acquired) {
                try {
                    acquired.release();
                } catch {
                    // 忽略宿主销毁后的重复释放
                }
            }
        };
    }, [
        sessionsService,
        selection?.sessionId,
        selection?.parentSessionId,
        selection?.mode,
        selection?.cleanroom
    ]);

    const shouldFetchDetail = Boolean(
        selection &&
            !selection.cleanroom &&
            selection.sessionId
    );

    useEffect(() => {
        if (!shouldFetchDetail || !selection?.sessionId) {
            setRunDetail(null);
            setDetailLoading(false);
            return;
        }
        setRunDetail((prev) => (prev && prev.sessionId === selection.sessionId ? prev : null));

        let cancelled = false;
        setDetailLoading(true);
        void fetchRunDetail(selection.sessionId)
            .then((detail) => {
                if (!cancelled && detail && detail.sessionId === selection.sessionId) {
                    setRunDetail(detail);
                }
            })
            .catch(() => {
                // 独立单测或旧后端返回 404 / 网络失败时静默降级为元数据面板
                if (!cancelled) {
                    setRunDetail(null);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setDetailLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [shouldFetchDetail, selection?.sessionId, selection?.status]);

    const handleCopySessionId = () => {
        if (!selection?.sessionId) return;
        const text = selection.sessionId;
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false)
            );
            return;
        }
        setCopied(true);
    };

    if (!selection) {
        return (
            <div className="ns-session-viewer ns-session-empty" aria-label="阶段会话检查器">
                <div className="ns-session-empty-card">
                    <strong>未选择工种会话节点</strong>
                    <p>
                        点击中栏顶部的 6 圆点流水线胶囊展开阶段图，再点击任意已绑定会话的节点
                        （Librarian / Planner / Writer / Checker / Extractor / Dreamer），即可在此查看实时思考流或历史 Trajectory。
                    </p>
                    <p className="ns-muted">
                        注：Writer 采用零工具单轮净室 Agent（与多轮工种统一基于原生会话记录，无工具与宿主指令污染）。
                    </p>
                </div>
            </div>
        );
    }

    const statusMeta = formatStageStatusText(selection.status);
    const normalizedRoleLabel = normalizeStageRoleDisplayLabel(
        selection.stageId,
        selection.stageLabel
    );
    const traceLampStatusClass =
        selection.status === 'active' ||
        selection.status === 'done' ||
        selection.status === 'healing' ||
        selection.status === 'halt'
            ? selection.status
            : 'idle';
    const resolvedModelLabel = runDetail?.modelId || effectiveModelLabel;
    const activeSessionRef =
        sessionRef && sessionRef.sessionId === selection.sessionId ? sessionRef : null;
    const canMountNative = Boolean(
        !selection.cleanroom &&
            activeSessionRef &&
            SessionProvider &&
            renderStageConversation &&
            !retainError
    );

    const isTerminalDetail = Boolean(
        runDetail &&
            (Boolean(runDetail.finishedAt) ||
                runDetail.status === 'completed' ||
                runDetail.status === 'failed')
    );
    const mergedEvents = mergeSessionEvents(runDetail?.events, liveEvents, isTerminalDetail);
    const hasLiveEvents = Boolean(liveEvents && liveEvents.length > 0);
    const normalizedEvents = normalizeEventsPayload(mergedEvents);
    const topLevelThinking =
        runDetail?.thinking ?? runDetail?.reasoning ?? normalizedEvents.thinking;
    const rootOrEventToolCalls =
        runDetail?.toolCalls && runDetail.toolCalls.length > 0
            ? runDetail.toolCalls
            : normalizedEvents.toolCalls;
    const turnToolCalls = Array.isArray(runDetail?.turns)
        ? runDetail.turns.flatMap((turn) => turn.toolCalls ?? turn.tool_calls ?? [])
        : [];
    const supplementaryToolCalls =
        rootOrEventToolCalls.length > 0 ? rootOrEventToolCalls : turnToolCalls;
    const topLevelOutput =
        runDetail?.output ??
        runDetail?.finalOutput ??
        runDetail?.summary ??
        normalizedEvents.output;
    const hasRequestInput = Boolean(extractRequestInputView(runDetail?.requestInput));
    const hasDetailBody = Boolean(
        (runDetail && Array.isArray(runDetail.turns) && runDetail.turns.length > 0) ||
            topLevelThinking ||
            rootOrEventToolCalls.length > 0 ||
            topLevelOutput ||
            hasRequestInput
    );
    const hasSupplementary = Boolean(
        hasRequestInput ||
            supplementaryToolCalls.some(
                (call) => call.result !== undefined && formatDetailValue(call.result).length > 0
            )
    );

    function renderSessionBody(): React.ReactElement {
        if (selection!.cleanroom) {
            return (
                <div className="ns-session-fallback" role="status">
                    <div className="ns-session-fallback-title">净室隔离执行（未绑定原生会话）</div>
                    <p>
                        Writer（零工具单轮净室 Agent）与 Patch（纯内存段落编辑多轮净室 Agent）均经{' '}
                        <code>ctx.agents.create</code> 隔离运行并留存会话轨迹；当前节点未绑定可回放的{' '}
                        <code>sessionId</code>（可能为早期历史章节），门禁指标与 Token 统计请切换至「运行状态」页签查看。
                    </p>
                </div>
            );
        }

        if (canMountNative && SessionProvider && renderStageConversation && activeSessionRef) {
            const nativeModeLabel = viewMode === 'chat' ? 'Conversation' : 'Trajectory';
            return (
                <>
                    <div
                        className="ns-stage-session-embed"
                        data-stage-session-mode={viewMode}
                        data-session-ready={readyState}
                    >
                        {readyState === 'loading' ? (
                            <div className="ns-session-loading-bar" role="status">
                                正在加载原生 {nativeModeLabel} 会话…
                            </div>
                        ) : null}
                        <SessionProvider key={activeSessionRef.sessionId} session={activeSessionRef}>
                            {renderStageConversation({ view: viewMode })}
                        </SessionProvider>
                    </div>
                    {hasSupplementary ? (
                        <div className="ns-session-supplementary">
                            {renderRequestInputSection(runDetail?.requestInput)}
                            {renderToolResultsSupplementary(supplementaryToolCalls)}
                        </div>
                    ) : null}
                </>
            );
        }

        const fallbackTitle = resolveFallbackTitle({
            hasLiveEvents,
            hasRunDetail: Boolean(runDetail),
            hasDetailBody,
            retainError
        });

        return (
            <div className="ns-session-fallback" data-session-fallback="true">
                <div className="ns-session-fallback-title">{fallbackTitle}</div>
                {renderFallbackNotice(retainError, hasDetailBody, viewMode)}
                <dl className="ns-session-kv ns-mono">
                    <dt>stageId</dt>
                    <dd>{selection!.stageId}</dd>
                    <dt>sessionId</dt>
                    <dd>{selection!.sessionId}</dd>
                    <dt>status</dt>
                    <dd>{selection!.status}</dd>
                    <dt>viewMode</dt>
                    <dd>{viewMode}</dd>
                    {selection!.runId ? (
                        <>
                            <dt>runId</dt>
                            <dd>{selection!.runId}</dd>
                        </>
                    ) : null}
                </dl>

                {detailLoading ? (
                    <div className="ns-session-loading-bar" role="status">
                        正在拉取历史会话明细…
                    </div>
                ) : null}

                {renderFallbackDetailSection({
                    hasDetailBody,
                    hasLiveEvents,
                    runDetail,
                    topLevelThinking,
                    rootOrEventToolCalls,
                    topLevelOutput,
                    viewMode,
                    mergedEvents
                })}
            </div>
        );
    }

    return (
        <div
            className="ns-session-viewer"
            aria-label="阶段会话检查器"
            data-stage-id={selection.stageId}
            data-session-id={selection.sessionId}
        >
            <header className="ns-session-head ns-trace-head">
                <div className="ns-session-title-row">
                    <div className="ns-session-title-group">
                        <span
                            className={`ns-trace-lamp ns-dt ${traceLampStatusClass}`}
                            style={{ viewTransitionName: 'ns-trace-lamp' }}
                            aria-hidden="true"
                        />
                        <strong
                            className="ns-trace-role"
                            style={{ viewTransitionName: 'ns-trace-role' }}
                        >
                            {normalizedRoleLabel}
                        </strong>
                        <span className={statusMeta.pillClass}>{statusMeta.label}</span>
                    </div>
                    {onClose ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-ghost ns-btn-xs"
                            onClick={onClose}
                            aria-label="返回运行状态"
                        >
                            返回
                        </button>
                    ) : null}
                </div>

                {renderModelMetaRow(resolvedModelLabel, runDetail?.thinkingChars)}
                {renderAttemptSessionsRow(
                    attemptSessions,
                    selection.sessionId,
                    onSelectAttemptSession
                )}

                <div className="ns-session-meta-row">
                    <span className="ns-mono ns-session-id-badge" title={selection.sessionId}>
                        session: {selection.sessionId}
                    </span>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        onClick={handleCopySessionId}
                    >
                        {copied ? '已复制' : '复制 ID'}
                    </button>
                </div>

                {selection.runId ? (
                    <div className="ns-session-run-row ns-mono">
                        runId: {selection.runId}
                    </div>
                ) : null}

                {!selection.cleanroom ? renderViewModeSwitcher(viewMode, setViewMode) : null}
            </header>

            <div className="ns-session-body">{renderSessionBody()}</div>
        </div>
    );
}

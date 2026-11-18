import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { handleTabKeyDown } from './tab-keyboard';
import type { StageSessionSelection } from './StageSessionViewer';
import type { RuntimeTaskKind } from './types';

export type { StageSessionSelection } from './StageSessionViewer';

/** 6 节点流水线 ID：只画真正跑大模型的节点 + Dreaming（0-LLM 静态门禁不占节点） */
export type PipelineStageId =
    | 'LIBRARIAN'
    | 'PLANNER'
    | 'WRITER'
    | 'FACT_CHECKER'
    | 'EXTRACTOR'
    | 'DREAMING';

/** 单个流水线节点状态（dormant = Dreaming 条件未达的虚线弱态） */
export type StageNodeStatus = 'idle' | 'active' | 'done' | 'healing' | 'halt' | 'dormant';

/** 流水线节点单次工种尝试会话记录（同一节点可按序保留多次尝试，如 WRITER / LOCAL_PATCH / REWRITE） */
export interface StageAttemptSession {
    runId?: string | undefined;
    stage: string;
    role?: string | undefined;
    status: string;
    sessionId: string;
    parentSessionId?: string | undefined;
    attempt?: number | undefined;
    triggerReason?: string | undefined;
    mode?: string | undefined;
    updatedAt?: string | undefined;
}

/** 流水线节点运行态信息 */
export interface StageNodeState {
    status: StageNodeStatus;
    summary?: string | undefined;
    inputSummary?: string | undefined;
    outputSummary?: string | undefined;
    updatedAt?: string | undefined;
    /** 挂在节点上的局部返修徽标（如「门禁 Patch ×1」「Replan v2」） */
    badge?: string | undefined;
    /** 当前或最近一次绑定的 DSH Agent Session ID（供右侧原生轨迹钻取） */
    sessionId?: string | undefined;
    /** 可选父会话 ID（存在时按父子 SubagentAddress retain） */
    parentSessionId?: string | undefined;
    /** 可选子代理地址模式（one-shot / continuable / unknown） */
    mode?: string | undefined;
    /** 所属运行批次 ID (.ops/runs.jsonl runId) */
    runId?: string | undefined;
    /** 当前阶段按顺序保留的全部尝试会话记录 */
    sessions?: StageAttemptSession[] | undefined;
}

/** 主内容区视图页签 */
export type CenterViewTab = 'prose' | 'plan' | 'diff' | 'views';

/** 物化视图子类型 */
export type MaterializedViewKind = 'entities' | 'horizon' | 'threads';

/** 导演一次性信号下拉类型 */
export type DirectorSignalKind = '下章剧情' | '导演指令' | 'FLASHBACK' | 'PARALLEL' | 'Retcon' | '文风修订';

/** 章节列表摘要项 */
export interface ChapterSummaryItem {
    chapterNumber: number;
    fileName?: string | undefined;
    title: string;
    charCount?: number | undefined;
    dirty?: boolean | undefined;
    commitSha?: string | null | undefined;
}

/** 单章详情数据 */
export interface ChapterDetailData {
    chapterNumber: number;
    title?: string | undefined;
    content: string;
    dirty?: boolean | undefined;
    sha256?: string | undefined;
    diffFromHead?: string | undefined;
    outlineText?: string | null | undefined;
    /** 细纲读取状态：available 已持久化 / missing 历史未留存 / error 读取失败 */
    outlineStatus?: 'available' | 'missing' | 'error' | undefined;
    volumeLabel?: string | undefined;
    featCommitSha?: string | undefined;
    stateCommitSha?: string | undefined;
}

/** SAFE_HALT 单条冲突/违规证据 */
export interface SafeHaltIssueItem {
    rule?: string | undefined;
    line?: number | undefined;
    quote?: string | undefined;
    snippet?: string | undefined;
    sourceRef?: string | undefined;
    sourceQuote?: string | undefined;
    detail?: string | undefined;
}

/** 门禁违规条目（用于裁决卡右栏高亮） */
export interface VerdictGateViolationItem {
    rule: string;
    detail: string;
    line?: number | undefined;
    snippet?: string | undefined;
    patched?: boolean | undefined;
}

/** SAFE_HALT 告警信息 (.ops/safe_halt.json) */
export interface SafeHaltInfo {
    reason: string;
    stage?: string | undefined;
    chapter?: number | undefined;
    conflictId?: string | undefined;
    affectedChapters?: number | undefined;
    rollbackThreshold?: number | undefined;
    leftRef?: string | undefined;
    rightRef?: string | undefined;
    leftExcerpt?: string | undefined;
    rightExcerpt?: string | undefined;
    issues?: SafeHaltIssueItem[] | undefined;
    timestamp?: string | undefined;
    details?: string | undefined;
}

/** 待消费导演信号项 (.ops/signals.jsonl) */
export interface PendingSignalItem {
    type?: string | undefined;
    reason?: string | undefined;
    chapter?: number | undefined;
    suggested_mode?: string | undefined;
    created_at?: string | undefined;
    raw?: string | undefined;
}

/** 只读实体卡片数据 */
export interface EntityViewItem {
    entityId: string;
    canonicalName: string;
    aliases?: string[] | undefined;
    lastSeenChapter?: number | undefined;
    markdown: string;
}

/** 只读物化视图集合 */
export interface MaterializedViewsData {
    entities?: EntityViewItem[] | undefined;
    coldArchiveCount?: number | undefined;
    horizonMarkdown?: string | undefined;
    threadsMarkdown?: string | undefined;
}

/** YOLO 连跑状态 */
export interface YoloStatusData {
    running: boolean;
    stopRequested?: boolean | undefined;
    completedChapters: number;
    targetChapters: number;
    currentStage?: string | null | undefined;
}

/** 投递信号回调参数 */
export interface SubmitSignalPayload {
    kind: DirectorSignalKind;
    content: string;
    runAfter: boolean;
}

/** 外部触发中栏页签切换的命令 */
export interface ExternalViewCommand {
    viewTab: CenterViewTab;
    materialKind?: MaterializedViewKind | undefined;
    nonce: number;
}

/** 作品切换下拉摘要项 */
export interface CenterBookSummary {
    bookRoot: string;
    slug: string;
    title: string;
    currentChapter: number;
}


/** 中栏草稿命令式句柄（根组件守卫在保存成功/放弃修改后调用） */
export interface CenterWorkbenchDraftHandle {
    /** 结束编辑态并清空脏草稿标记；savedContent 传入时用已保存文本作为展示正文（PUT 已成功，不假装回滚） */
    resetDraft: (savedContent?: string) => void;
}

/** CenterWorkbench 组件 Props */
export interface CenterWorkbenchProps {
    bookTitle?: string | undefined;
    bookSlug?: string | undefined;
    currentBookRoot?: string | undefined;
    books?: CenterBookSummary[] | undefined;
    currentChapter: number;
    selectedChapter?: number | undefined;
    timelineMode?: string | undefined;
    walPhase?: string | undefined;
    activeTask?: RuntimeTaskKind | undefined;
    haltRequested?: boolean | undefined;
    haltWaiting?: boolean | undefined;
    yolo?: YoloStatusData | undefined;
    chapters?: ChapterSummaryItem[] | undefined;
    chapterDetail?: ChapterDetailData | null | undefined;
    chapterLoading?: boolean | undefined;
    stages?: Partial<Record<PipelineStageId, StageNodeState>> | undefined;
    latestSseStage?: string | null | undefined;
    safeHalt?: SafeHaltInfo | null | undefined;
    gateViolations?: VerdictGateViolationItem[] | undefined;
    pendingSignals?: PendingSignalItem[] | undefined;
    pendingSignalsCount?: number | undefined;
    materializedViews?: MaterializedViewsData | undefined;
    dirtyChaptersCount?: number | undefined;
    externalViewCommand?: ExternalViewCommand | undefined;
    leftCollapsed?: boolean | undefined;
    rightOpen?: boolean | undefined;
    hasSafeHalt?: boolean | undefined;
    /** 脏草稿快照上报（作品/章号/草稿文本；null=无未保存草稿），供根组件导航守卫与 beforeunload 使用 */
    onDraftDirtyChange?:
        | ((dirty: { bookRoot: string; chapterNumber: number; content: string } | null) => void)
        | undefined;
    /** 草稿控制句柄注册回调：守卫保存成功/放弃修改后由根组件强制结束编辑态；卸载时传 null */
    onDraftControlReady?: ((handle: CenterWorkbenchDraftHandle | null) => void) | undefined;
    onSelectBook?: ((bookRoot: string) => void) | undefined;
    onNewBook?: (() => void) | undefined;
    onToggleLeft?: (() => void) | undefined;
    onToggleRight?: (() => void) | undefined;
    onOpenInspector?: (() => void) | undefined;
    onDismissSignal?: ((index: number) => void) | undefined;
    onSelectChapter?: ((chapterNumber: number) => void) | undefined;
    onStepOne?: (() => Promise<void> | void) | undefined;
    onStartYolo?: ((targetChapters: number) => Promise<void> | void) | undefined;
    onStopYolo?: (() => Promise<void> | void) | undefined;
    onSync?: (() => Promise<void> | void) | undefined;
    onDream?: (() => Promise<void> | void) | undefined;
    /** 保存草稿（失败必须抛错，根组件保存后继续导航时依赖真实结果） */
    onSaveChapter?: ((chapterNumber: number, content: string) => Promise<void> | void) | undefined;
    onSubmitSignal?: ((payload: SubmitSignalPayload) => Promise<void> | void) | undefined;
    onRefreshViews?: (() => Promise<void> | void) | undefined;
    /** 只读重试读取当前章详情（细纲 error 态入口，不触发 Sync/生成） */
    onRetryChapterDetail?: (() => void) | undefined;
    /** 点击任意阶段节点时通知父组件当前检视的阶段 ID */
    onInspectStage?: ((stageId: PipelineStageId) => void) | undefined;
    /** 点击已绑定会话的阶段节点，在右侧打开 DSH 原生 Conversation / Trajectory 检查器 */
    onSelectStageSession?: ((selection: StageSessionSelection) => void) | undefined;
}

interface StageDefinition {
    id: PipelineStageId;
    label: string;
    shortDesc: string;
    defaultInput: string;
    defaultOutput: string;
}

const PIPELINE_STAGES: readonly StageDefinition[] = [
    {
        id: 'LIBRARIAN',
        label: '1. Librarian',
        shortDesc: '检索选页',
        defaultInput: '读取 L0-L2 目录索引、活跃实体列表与待收束伏笔。',
        defaultOutput: '筛选本场焦点实体卡、历史原稿切片查询条件与声纹样本。'
    },
    {
        id: 'PLANNER',
        label: '2. Planner',
        shortDesc: '导演细纲',
        defaultInput: '接收 Librarian 上下文、时间线模式与一次性导演信号。',
        defaultOutput: '输出结构化章节细纲（戏眼、焦点角色、收尾节拍）。'
    },
    {
        id: 'WRITER',
        label: '3. Writer',
        shortDesc: '净室执笔',
        defaultInput: '净室窗口（静态前缀 + 动态尾 + 剥离后 POV 补集卡）。',
        defaultOutput: '单轮流式直出本章正文草稿（无历史会话污染）。'
    },
    {
        id: 'FACT_CHECKER',
        label: '4. Fact Check',
        shortDesc: '异构核查',
        defaultInput: '最新单章正文 + 实体固有属性锁 + 物理/时间线红线。',
        defaultOutput: '双侧原句去标点验真，通过或触发 Rewrite / Replan 自愈。'
    },
    {
        id: 'EXTRACTOR',
        label: '5. Extractor',
        shortDesc: '提态入库',
        defaultInput: '已核查定稿正文 + 当前世界状态快照。',
        defaultOutput: '提取实体行级补丁、L2 章卡并原子提交 Git WAL (feat -> state)。'
    },
    {
        id: 'DREAMING',
        label: '6. Dreaming',
        shortDesc: '条件睡眠自愈',
        defaultInput: '脏实体页水位、open_threads 台账与 future_horizon 多轨触发条件。',
        defaultOutput: '条件达标时离线 VACUUM：清洗脏页、伏笔立项/销账、补货远景与派发 Spotlight。'
    }
];

const STAGE_ORDER: readonly PipelineStageId[] = PIPELINE_STAGES.map((s) => s.id);

/** 斜杠指令定义项 */
interface SlashCommandItem {
    command: string;
    alias: string;
    kind: DirectorSignalKind;
    description: string;
}

/** 底部导演栏斜杠指令列表 */
const SLASH_COMMANDS: ReadonlyArray<SlashCommandItem> = [
    {
        command: '/plot',
        alias: '剧情',
        kind: '导演指令',
        description: '下章剧情 / 视角指示'
    },
    {
        command: '/flashback',
        alias: '插叙',
        kind: 'FLASHBACK',
        description: '强制插叙 · 屏蔽当前状态'
    },
    {
        command: '/parallel',
        alias: '支线',
        kind: 'PARALLEL',
        description: '开启并行多视角支线'
    },
    {
        command: '/retcon',
        alias: '圆谎',
        kind: 'Retcon',
        description: '投递短期 Retcon 圆谎纸条'
    },
    {
        command: '/style',
        alias: '文风',
        kind: '文风修订',
        description: '注入一次性文风修正补丁'
    }
];

/** 按序字符模糊匹配（支持 /fb 匹配 /flashback） */
function isSubsequenceMatch(needle: string, haystack: string): boolean {
    let i = 0;
    for (let j = 0; j < haystack.length && i < needle.length; j++) {
        if (haystack[j] === needle[i]) {
            i++;
        }
    }
    return i === needle.length;
}

/** 过滤并排序匹配的斜杠指令 */
function filterSlashCommands(query: string): SlashCommandItem[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return [...SLASH_COMMANDS];
    }

    const prefixMatches: SlashCommandItem[] = [];
    const fuzzyMatches: SlashCommandItem[] = [];

    for (const item of SLASH_COMMANDS) {
        const cmdBody = item.command.slice(1).toLowerCase();
        const alias = item.alias.toLowerCase();
        const kind = item.kind.toLowerCase();
        if (
            cmdBody.startsWith(normalized) ||
            alias.startsWith(normalized) ||
            kind.startsWith(normalized)
        ) {
            prefixMatches.push(item);
        } else if (
            cmdBody.includes(normalized) ||
            alias.includes(normalized) ||
            kind.includes(normalized) ||
            isSubsequenceMatch(normalized, cmdBody)
        ) {
            fuzzyMatches.push(item);
        }
    }

    return [...prefixMatches, ...fuzzyMatches];
}

const YOLO_PRESETS: ReadonlyArray<{ targetChapters: number; label: string; desc: string }> = [
    { targetChapters: 3, label: '连跑 3 章', desc: '推进 3 章后在安全点停下' },
    { targetChapters: 5, label: '连跑 5 章', desc: '推进 5 章后在安全点停下' },
    { targetChapters: 0, label: '持续直到停机', desc: '无章数上限，遇 SAFE_HALT 或手动停止才停' }
];

const PROSE_FONT_SIZES: readonly number[] = [15, 17, 19];

/** 归一化章节标题用于首行去重比对 */
function normalizeHeadingText(text: string): string {
    return text
        .replace(/^#{1,3}\s+/, '')
        .replace(/^第\s*0*\d+\s*章\s*[:：·\-]?\s*/u, '')
        .replace(/^(?:Ch\.?|Chapter)\s*0*\d+\s*[:：·\-]?\s*/i, '')
        .replace(/\s+/g, '')
        .trim();
}

/** 判断正文首行是否为与章节头重复的 Markdown 标题行 */
function isDuplicateChapterHeading(
    firstLine: string,
    chapterNumber: number,
    chapterTitle?: string
): boolean {
    if (!/^#{1,2}\s+/.test(firstLine)) return false;
    const rawHeading = firstLine.replace(/^#{1,2}\s+/, '').trim();
    if (!rawHeading) return false;
    const normalizedHeading = normalizeHeadingText(rawHeading);
    const normalizedTitle = chapterTitle ? normalizeHeadingText(chapterTitle) : '';
    if (normalizedTitle && normalizedHeading === normalizedTitle) {
        return true;
    }
    return (
        rawHeading === `第${chapterNumber}章` ||
        rawHeading === formatChapterLabel(chapterNumber)
    );
}

/** 将章节正文拆分为阅读段落（识别场景分隔符，并自动略去重复的 Markdown 章节标题行） */
function splitProseParagraphs(
    content: string,
    chapterNumber: number,
    chapterTitle?: string
): Array<{ text: string; isBreak: boolean }> {
    if (!content.trim()) return [];
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length > 0 && isDuplicateChapterHeading(lines[0] ?? '', chapterNumber, chapterTitle)) {
        lines.shift();
    }
    return lines.map((line) => ({
        text: line,
        isBreak: /^([-*_·]\s*){3,}$/.test(line)
    }));
}

/** 细纲节拍比例条单段数据 */
interface ParsedBeatSegment {
    label: string;
    summary: string;
    percent: number;
    isSpotlight: boolean;
}

/** 结构化细纲解析结果 */
interface ParsedStructuredPlan {
    chapterTitle: string;
    /** 时间线模式：细纲未留存该字段时为 null（未提供），不从全局状态推断 */
    timelineMode: string | null;
    /** 视角角色：细纲未留存该字段时为 null（未提供），不从焦点角色顺序推断 */
    povCharacter: string | null;
    targetWordCount: number | null;
    endingBeat: string;
    focusCast: string[];
    backgroundCast: string[];
    spotlight: string;
    endingSummary: string;
    outlineText: string;
    beats: ParsedBeatSegment[];
}

/** 从字符串或数组字段归一化角色列表 */
function normalizeCastList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item).trim())
            .filter((item) => item.length > 0 && item !== '无' && item !== '本章无');
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed || trimmed === '无' || trimmed === '本章无' || trimmed === 'none') {
            return [];
        }
        return trimmed
            .split(/[,，、/|]+/)
            .map((item) => item.trim())
            .filter((item) => item.length > 0 && item !== '无' && item !== '本章无');
    }
    return [];
}

/** 为角色名生成稳定色标 */
function getAvatarColor(name: string): string {
    const palette = ['#5686fe', '#e0664a', '#4ed17e', '#f7ad31', '#a78bfa', '#38bdf8'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return palette[hash % palette.length] ?? '#5686fe';
}

/** 根据 scene_plan 或默认 4 段比例计算总和为 100% 的节拍条 */
function buildPlanBeats(
    scenes: Array<{ location?: string; summary?: string; is_spotlight?: boolean }> | null,
    spotlightFallback: string,
    outlineFallback: string
): ParsedBeatSegment[] {
    if (scenes && scenes.length > 0) {
        const weights = scenes.map((s) => (s.is_spotlight ? 3 : 1));
        const totalWeight = weights.reduce((acc, w) => acc + w, 0) || scenes.length;
        const percents = weights.map((w) => Math.max(8, Math.round((w / totalWeight) * 100)));
        const diff = 100 - percents.reduce((acc, p) => acc + p, 0);
        if (diff !== 0) {
            const spotlightIdx = Math.max(
                0,
                scenes.findIndex((s) => s.is_spotlight)
            );
            percents[spotlightIdx] = Math.max(8, (percents[spotlightIdx] ?? 0) + diff);
        }

        const hasExplicitSpotlight = scenes.some((s) => Boolean(s.is_spotlight));
        return scenes.map((scene, idx) => {
            const isSpot = hasExplicitSpotlight ? Boolean(scene.is_spotlight) : idx === Math.floor(scenes.length / 2);
            const loc = scene.location?.trim();
            const label = isSpot ? '戏眼' : loc || `场次 ${idx + 1}`;
            const summary = scene.summary?.trim() || loc || '推进本场戏剧冲突';
            return {
                label,
                summary,
                percent: percents[idx] ?? Math.floor(100 / scenes.length),
                isSpotlight: isSpot
            };
        });
    }

    const firstSentence =
        outlineFallback
            .split(/[。\n]/)
            .map((s) => s.trim())
            .find((s) => s.length > 0) ?? '承接上章状态入场';
    return [
        {
            label: '开场',
            summary: firstSentence,
            percent: 15,
            isSpotlight: false
        },
        {
            label: '戏眼',
            summary: spotlightFallback || '核心冲突爆发与视角锚定',
            percent: 55,
            isSpotlight: true
        },
        {
            label: '回收',
            summary: '线索收束与关系余波',
            percent: 20,
            isSpotlight: false
        },
        {
            label: '收尾',
            summary: '末句定调与下章钩子',
            percent: 10,
            isSpotlight: false
        }
    ];
}

/** 尝试将章节 outlineText 解析为结构化细纲对象（支持 JSON 与 Markdown/键值回退） */
function parseStructuredPlan(
    rawText: string | undefined,
    fallbackTitle: string
): ParsedStructuredPlan | null {
    const trimmed = rawText?.trim() ?? '';
    if (!trimmed) {
        return null;
    }

    // 1. 尝试提取并解析 JSON（兼容 ```json 代码块）
    let jsonCandidate = trimmed;
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        jsonCandidate = fencedMatch[1].trim();
    }
    if (jsonCandidate.startsWith('{') && jsonCandidate.endsWith('}')) {
        try {
            const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
            const focusCast = normalizeCastList(parsed['focus_cast'] ?? parsed['focusCast']);
            const backgroundCast = normalizeCastList(
                parsed['background_cast'] ?? parsed['backgroundCast']
            );
            const povCharacter =
                typeof parsed['pov_character'] === 'string' && parsed['pov_character'].trim()
                    ? parsed['pov_character'].trim()
                    : typeof parsed['pov'] === 'string' && parsed['pov'].trim()
                      ? parsed['pov'].trim()
                      : null;

            const rawScenes = Array.isArray(parsed['scene_plan'])
                ? (parsed['scene_plan'] as Array<{
                      location?: string;
                      summary?: string;
                      is_spotlight?: boolean;
                  }>)
                : null;
            const spotlightScene = rawScenes?.find((s) => s.is_spotlight);
            const spotlight =
                typeof parsed['spotlight'] === 'string' && parsed['spotlight'].trim()
                    ? parsed['spotlight'].trim()
                    : spotlightScene?.summary?.trim() ?? '';
            const outlineBody =
                typeof parsed['outline_text'] === 'string' && parsed['outline_text'].trim()
                    ? parsed['outline_text'].trim()
                    : trimmed;
            const endingBeat =
                typeof parsed['ending_beat'] === 'string' && parsed['ending_beat'].trim()
                    ? parsed['ending_beat'].trim()
                    : 'HOOK';
            const targetWordCount =
                typeof parsed['target_word_count'] === 'number' &&
                Number.isFinite(parsed['target_word_count'])
                    ? parsed['target_word_count']
                    : null;
            const chapterTitle =
                typeof parsed['chapter_title'] === 'string' && parsed['chapter_title'].trim()
                    ? parsed['chapter_title'].trim()
                    : fallbackTitle;
            // 真实 PlannerOutline 不含 timeline_mode；缺失即未提供，不冒充当前全局模式
            const timelineModeVal =
                typeof parsed['timeline_mode'] === 'string' && parsed['timeline_mode'].trim()
                    ? parsed['timeline_mode'].trim()
                    : null;

            return {
                chapterTitle,
                timelineMode: timelineModeVal,
                povCharacter,
                targetWordCount,
                endingBeat,
                focusCast,
                backgroundCast,
                spotlight: spotlight || outlineBody.split(/[。\n]/)[0] || '待细化',
                endingSummary:
                    typeof parsed['ending_summary'] === 'string' && parsed['ending_summary'].trim()
                        ? parsed['ending_summary'].trim()
                        : `以 ${endingBeat} 节拍收束本章`,
                outlineText: outlineBody,
                beats: buildPlanBeats(rawScenes, spotlight, outlineBody),
            };
        } catch {
            // JSON 解析失败则回退到 Markdown / 键值文本解析
        }
    }

    // 2. Markdown / 键值行文本解析回退
    let chapterTitle = fallbackTitle;
    let timelineModeVal: string | null = null;
    let povCharacter = '';
    let targetWordCount: number | null = null;
    let endingBeat = 'HOOK';
    let focusCast: string[] = [];
    let backgroundCast: string[] = [];
    let spotlight = '';
    let endingSummary = '';
    const bodyLines: string[] = [];
    const parsedScenes: Array<{ location?: string; summary?: string; is_spotlight?: boolean }> = [];

    const lines = trimmed.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            bodyLines.push('');
            continue;
        }
        const kvMatch = line.match(/^(?:[-*]\s*)?([A-Za-z0-9_\u4e00-\u9fa5]+)\s*[:：]\s*(.+)$/);
        if (kvMatch) {
            const key = (kvMatch[1] ?? '').toLowerCase();
            const val = (kvMatch[2] ?? '').trim();
            if (key === '标题' || key === 'chapter_title' || key === 'title') {
                chapterTitle = val;
                continue;
            }
            if (key === '目标字数' || key === 'target_word_count' || key === 'target') {
                const num = Number.parseInt(val.replace(/[^\d]/g, ''), 10);
                if (Number.isFinite(num) && num > 0) targetWordCount = num;
                continue;
            }
            if (key === '收尾节拍' || key === 'ending_beat' || key === 'ending') {
                endingBeat = val;
                continue;
            }
            if (key === '收尾说明' || key === 'ending_summary') {
                endingSummary = val;
                continue;
            }
            if (key === '时间线' || key === '时间线模式' || key === 'timeline_mode') {
                timelineModeVal = val;
                continue;
            }
            if (key === '视角' || key === 'pov' || key === 'pov_character') {
                povCharacter = val;
                continue;
            }
            if (key === '焦点角色' || key === 'focus_cast') {
                focusCast = normalizeCastList(val);
                continue;
            }
            if (key === '背景角色' || key === 'background_cast') {
                backgroundCast = normalizeCastList(val);
                continue;
            }
            if (key === '戏眼' || key === 'spotlight') {
                spotlight = val;
                continue;
            }
        }
        const sceneMatch = line.match(/^(?:[-*]|\d+[.)])\s*(?:\[(戏眼|spotlight)\]\s*)?(.+)$/i);
        if (sceneMatch && line.length <= 120 && (line.includes('戏眼') || line.includes('场次') || line.includes('@'))) {
            parsedScenes.push({
                summary: sceneMatch[2]?.trim() ?? line,
                is_spotlight: Boolean(sceneMatch[1]) || line.includes('戏眼')
            });
        }
        bodyLines.push(rawLine);
    }

    const outlineBody = bodyLines.join('\n').trim() || trimmed;
    // 视角/焦点只认细纲真实字段；缺失即未提供，不从焦点顺序或全局状态推断
    const resolvedPov = povCharacter || null;
    const resolvedFocus = focusCast;
    const resolvedSpotlight =
        spotlight ||
        parsedScenes.find((s) => s.is_spotlight)?.summary ||
        outlineBody
            .split(/[。\n]/)
            .map((s) => s.trim())
            .find((s) => s.length > 0) ||
        '见下方细纲正文';

    return {
        chapterTitle,
        timelineMode: timelineModeVal,
        povCharacter: resolvedPov,
        targetWordCount,
        endingBeat,
        focusCast: resolvedFocus,
        backgroundCast,
        spotlight: resolvedSpotlight,
        endingSummary: endingSummary || `以 ${endingBeat} 节拍收束本章`,
        outlineText: outlineBody,
        beats: buildPlanBeats(parsedScenes.length > 0 ? parsedScenes : null, resolvedSpotlight, outlineBody),
    };
}

/** Unified Diff 单行结构 */
interface ParsedDiffRow {
    kind: 'ctx' | 'add' | 'del';
    lineNumber: number | null;
    glyph: string;
    text: string;
}

/** Unified Diff Hunk 块结构 */
interface ParsedDiffHunk {
    fileName: string;
    header: string;
    rows: ParsedDiffRow[];
    addCount: number;
    delCount: number;
}

/** 将标准 unified diff 解析为结构化 Hunk 块列表 */
function parseUnifiedDiff(rawDiff: string, defaultFileName: string): ParsedDiffHunk[] {
    const trimmed = rawDiff.trim();
    if (!trimmed) {
        return [];
    }

    const lines = rawDiff.split(/\r?\n/);
    const hunks: ParsedDiffHunk[] = [];
    let currentFile = defaultFileName;
    let currentHunk: ParsedDiffHunk | null = null;
    let oldLine = 1;
    let newLine = 1;

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = line.match(/b\/(.+)$/);
            if (match?.[1]) {
                currentFile = match[1].split('/').pop() ?? defaultFileName;
            }
            continue;
        }
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            if (line.startsWith('+++ b/')) {
                currentFile = line.slice(6).split('/').pop() ?? currentFile;
            }
            continue;
        }
        if (line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
            continue;
        }

        const hunkHeaderMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
        if (hunkHeaderMatch) {
            if (currentHunk) {
                hunks.push(currentHunk);
            }
            oldLine = Number.parseInt(hunkHeaderMatch[1] ?? '1', 10);
            newLine = Number.parseInt(hunkHeaderMatch[2] ?? '1', 10);
            const suffix = (hunkHeaderMatch[3] ?? '').trim();
            currentHunk = {
                fileName: currentFile,
                header: `@@ -${oldLine} +${newLine} @@${suffix ? ` ${suffix}` : ''}`,
                rows: [],
                addCount: 0,
                delCount: 0
            };
            continue;
        }

        if (!currentHunk) {
            // 若无标准 @@ 头但存在有效 diff 行，创建一个回退 hunk
            if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                currentHunk = {
                    fileName: currentFile,
                    header: '@@ L1 @@',
                    rows: [],
                    addCount: 0,
                    delCount: 0
                };
            } else {
                continue;
            }
        }

        if (line.startsWith('\\ No newline')) {
            continue;
        }

        if (line.startsWith('+')) {
            currentHunk.rows.push({
                kind: 'add',
                lineNumber: newLine,
                glyph: '+',
                text: line.slice(1)
            });
            currentHunk.addCount += 1;
            newLine += 1;
        } else if (line.startsWith('-')) {
            currentHunk.rows.push({
                kind: 'del',
                lineNumber: oldLine,
                glyph: '-',
                text: line.slice(1)
            });
            currentHunk.delCount += 1;
            oldLine += 1;
        } else {
            currentHunk.rows.push({
                kind: 'ctx',
                lineNumber: newLine,
                glyph: '',
                text: line.startsWith(' ') ? line.slice(1) : line
            });
            oldLine += 1;
            newLine += 1;
        }
    }

    if (currentHunk) {
        hunks.push(currentHunk);
    }

    // 如果输入非空但未匹配任何标准 diff 行，回退展示全文
    if (hunks.length === 0) {
        return [
            {
                fileName: defaultFileName,
                header: '@@ L1 @@',
                rows: lines.map((text, idx) => ({
                    kind: 'ctx',
                    lineNumber: idx + 1,
                    glyph: '',
                    text
                })),
                addCount: 0,
                delCount: 0
            }
        ];
    }

    return hunks;
}

/** 返修阶段展示元信息（统一映射目标节点、徽标与默认摘要） */
export interface StageRepairMeta {
    targetStage: PipelineStageId;
    badge: string;
    defaultSummary: string;
}

/** 返修重演阶段共享元数据表（LOCAL_PATCH / REWRITE / REPLAN） */
export const STAGE_REPAIR_META: Readonly<Record<string, StageRepairMeta>> = {
    LOCAL_PATCH: {
        targetStage: 'WRITER',
        badge: '门禁 Patch',
        defaultSummary: '正在净室内存局部 Patch 自愈'
    },
    REWRITE: {
        targetStage: 'WRITER',
        badge: 'Rewrite',
        defaultSummary: '核查打回，正在整章净室重写自愈'
    },
    REPLAN: {
        targetStage: 'PLANNER',
        badge: 'Replan',
        defaultSummary: '触发 Replan 重排细纲'
    }
};

/**
 * 后端 SSE 阶段名 -> 展示节点映射。
 * PROSE_GATE / LOCAL_PATCH / REWRITE 归并到 WRITER 节点；REPLAN 归并到 PLANNER 节点。
 */
const SSE_STAGE_ALIAS: Readonly<Record<string, PipelineStageId>> = {
    PROSE_GATE: 'WRITER',
    LOCAL_PATCH: STAGE_REPAIR_META['LOCAL_PATCH']!.targetStage,
    REWRITE: STAGE_REPAIR_META['REWRITE']!.targetStage,
    REPLAN: STAGE_REPAIR_META['REPLAN']!.targetStage
};

/** 将后端阶段名归一化为展示节点 ID（未知阶段返回 null） */
export function resolveStageId(stageName: string): PipelineStageId | null {
    const normalized = stageName.trim().toUpperCase();
    const aliased = SSE_STAGE_ALIAS[normalized] ?? normalized;
    return (STAGE_ORDER as readonly string[]).includes(aliased)
        ? (aliased as PipelineStageId)
        : null;
}

/**
 * 根据 SSE 推送的 EngineStageName 字符串推导 6 个节点的默认状态。
 * Dreaming 为条件节点：单章链路中保持 dormant 虚线弱态，仅 DREAMING 事件点亮。
 */
function deriveStagesFromSse(
    sseStage: string | null | undefined,
    overrides?: Partial<Record<PipelineStageId, StageNodeState>>
): Record<PipelineStageId, StageNodeState> {
    const base: Record<PipelineStageId, StageNodeState> = {
        LIBRARIAN: { status: 'idle' },
        PLANNER: { status: 'idle' },
        WRITER: { status: 'idle' },
        FACT_CHECKER: { status: 'idle' },
        EXTRACTOR: { status: 'idle' },
        DREAMING: { status: 'dormant', summary: '条件未达：脏页水位或字数阈值触发后离线执行' }
    };

    if (sseStage) {
        if (sseStage === 'COMMITTED') {
            for (const id of STAGE_ORDER) {
                if (id === 'DREAMING') continue;
                base[id] = { status: 'done', summary: '已完成并提交 WAL' };
            }
        } else if (sseStage === 'SAFE_HALT') {
            base.FACT_CHECKER = { status: 'halt', summary: '触发 SAFE_HALT 停机保护' };
        } else if (sseStage === 'PROSE_GATE') {
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'done' };
            base.WRITER = {
                status: 'active',
                summary: '静态门禁校验中（0-LLM 确定性步骤）'
            };
        } else if (sseStage === 'LOCAL_PATCH') {
            const meta = STAGE_REPAIR_META['LOCAL_PATCH']!;
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'done' };
            base.WRITER = {
                status: 'healing',
                summary: meta.defaultSummary,
                badge: meta.badge
            };
        } else if (sseStage === 'REWRITE') {
            const meta = STAGE_REPAIR_META['REWRITE']!;
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = { status: 'done' };
            base.WRITER = {
                status: 'healing',
                summary: meta.defaultSummary,
                badge: meta.badge
            };
            base.FACT_CHECKER = { status: 'healing', summary: '发现穿帮，触发 Rewrite' };
        } else if (sseStage === 'REPLAN') {
            const meta = STAGE_REPAIR_META['REPLAN']!;
            base.LIBRARIAN = { status: 'done' };
            base.PLANNER = {
                status: 'healing',
                summary: meta.defaultSummary,
                badge: meta.badge
            };
            base.FACT_CHECKER = { status: 'healing', summary: '要求重规划细纲' };
        } else if (sseStage === 'DREAMING') {
            for (const id of STAGE_ORDER) {
                if (id === 'DREAMING') continue;
                base[id] = { status: 'done' };
            }
            base.DREAMING = { status: 'active', summary: '睡眠 VACUUM 与跨章连续性整理运行中' };
        } else {
            const resolved = resolveStageId(sseStage);
            const activeIndex = resolved ? STAGE_ORDER.indexOf(resolved) : -1;
            if (activeIndex >= 0) {
                for (let i = 0; i < STAGE_ORDER.length; i++) {
                    const id = STAGE_ORDER[i];
                    if (!id || id === 'DREAMING') continue;
                    if (i < activeIndex) {
                        base[id] = { status: 'done', summary: '已完成' };
                    } else if (i === activeIndex) {
                        base[id] = { status: 'active', summary: '运行中' };
                    }
                }
            }
        }
    }

    if (overrides) {
        for (const id of STAGE_ORDER) {
            const custom = overrides[id];
            if (custom) {
                base[id] = { ...base[id], ...custom };
            }
        }
    }

    return base;
}

/** 将节点状态映射为中文徽章文案与样式后缀 */
function getStageStatusMeta(status: StageNodeStatus): { text: string; badgeClass: string } {
    switch (status) {
        case 'active':
            return { text: '运行中', badgeClass: 'ns-badge-brand' };
        case 'done':
            return { text: '通过', badgeClass: 'ns-badge-green' };
        case 'healing':
            return { text: '返修', badgeClass: 'ns-badge-amber' };
        case 'halt':
            return { text: '拦截', badgeClass: 'ns-badge-red' };
        case 'dormant':
            return { text: '条件未达', badgeClass: 'ns-badge-muted' };
        case 'idle':
        default:
            return { text: '待命', badgeClass: 'ns-badge-muted' };
    }
}

/** 格式化章节号为 4 位补零展示 */
function formatChapterLabel(chapterNumber: number): string {
    return `Ch.${String(Math.max(0, chapterNumber)).padStart(4, '0')}`;
}

/** 将前端导演下拉类型转换为后端 OpsSignalSchema 兼容格式 */
function buildOpsSignalPayload(
    kind: DirectorSignalKind,
    content: string,
    chapter: number
): Record<string, unknown> {
    const trimmed = content.trim();
    const isRetcon = kind === 'Retcon';
    const base: Record<string, unknown> = {
        type: isRetcon ? 'RETCON' : 'SPOTLIGHT_TRIGGER',
        chapter: Math.max(0, chapter),
        reason: `[${kind}] ${trimmed}`,
        created_at: new Date().toISOString()
    };

    if (kind === 'PARALLEL') {
        base['suggested_mode'] = 'PARALLEL';
    } else if (kind === '下章剧情' || kind === '导演指令') {
        base['suggested_mode'] = 'MAINLINE';
    }

    return base;
}

/**
 * NarrateOS 中栏工作台组件：
 * - 顶部控制条（单步推进、YOLO 拆分下拉、安全点停止、Sync、Dreaming）
 * - SAFE_HALT 高亮告警条
 * - 6 阶段水平流水线图 + 可折叠节点检查条
 * - 正文阅读 / 本章细纲 / 手改 Diff / 物化视图（只读）+ 在线编辑保存 Sync
 * - 底部导演一次性干涉栏
 */
export const CenterWorkbench: React.FC<CenterWorkbenchProps> = ({
    bookTitle,
    bookSlug,
    currentBookRoot,
    books = [],
    currentChapter,
    selectedChapter,
    timelineMode = 'MAINLINE',
    walPhase = 'STATE_COMMITTED',
    activeTask = 'IDLE',
    haltRequested = false,
    haltWaiting = false,
    yolo,
    chapters = [],
    chapterDetail,
    chapterLoading = false,
    stages,
    latestSseStage,
    safeHalt,
    gateViolations = [],
    pendingSignals = [],
    pendingSignalsCount,
    materializedViews,
    dirtyChaptersCount = 0,
    externalViewCommand,
    rightOpen = true,
    hasSafeHalt = false,
    onSelectBook,
    onNewBook,
    onToggleRight,
    onOpenInspector,
    onDismissSignal,
    onSelectChapter,
    onStepOne,
    onStartYolo,
    onStopYolo,
    onSync,
    onDream,
    onSaveChapter,
    onSubmitSignal,
    onRefreshViews,
    onDraftDirtyChange,
    onRetryChapterDetail,
    onDraftControlReady,
    onInspectStage,
    onSelectStageSession
}) => {
    // 显示与保存均以已采纳的详情章身份为准；详情未加载时才回退到导航意图/当前章
    const activeChapterNumber = chapterDetail?.chapterNumber ?? selectedChapter ?? currentChapter;
    const isYoloRunning = Boolean(yolo?.running);
    const isBusy = activeTask !== 'IDLE' || isYoloRunning;

    // 顶部 YOLO 拆分下拉菜单开关
    const [yoloMenuOpen, setYoloMenuOpen] = useState(false);

    // 6 阶段流水线详情检查条开关（默认收起，点击 6 圆点进度胶囊才展开）
    const [stageDrawerOpen, setStageDrawerOpen] = useState(false);

    // 6 阶段流水线选中的检查节点
    const [inspectedStageId, setInspectedStageId] = useState<PipelineStageId>('LIBRARIAN');

    // 主视图页签 & 只读物化视图子页签
    const [viewTab, setViewTab] = useState<CenterViewTab>('prose');
    const [materialKind, setMaterialKind] = useState<MaterializedViewKind>('entities');

    // 响应外部（左栏物化视图导航）联动切换页签与子标签
    useEffect(() => {
        if (!externalViewCommand) return;
        setViewTab(externalViewCommand.viewTab);
        if (externalViewCommand.materialKind) {
            setMaterialKind(externalViewCommand.materialKind);
        }
    }, [externalViewCommand]);

    // 正文阅读字号档位（15 / 17 / 19px）
    const [fontStep, setFontStep] = useState(1);

    // 在线编辑模式
    const [isEditing, setIsEditing] = useState(false);
    const [draftContent, setDraftContent] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);
    // 保存在途同步标记：state 更新前的连续点击不得重入，守卫清稿与在途 PUT 互斥
    const savingRef = useRef(false);
    const [syncingFromDiff, setSyncingFromDiff] = useState(false);
    // 编辑器打开时的基线正文（用于判断草稿是否真的偏离服务器内容）
    const [draftBaseline, setDraftBaseline] = useState<string | null>(null);
    // 取消编辑时若会丢脏草稿，先经宿主 Modal 确认
    const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

    // 底部导演一次性干涉栏输入态
    const [signalKind, setSignalKind] = useState<DirectorSignalKind>('导演指令');
    const [signalInput, setSignalInput] = useState('');
    const [submittingSignal, setSubmittingSignal] = useState(false);
    const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
    const [activeSlashIndex, setActiveSlashIndex] = useState(0);
    const signalInputRef = useRef<HTMLInputElement | null>(null);

    // 局部操作反馈提示
    const [actionMessage, setActionMessage] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // 切换章节/作品时重置编辑态；同章内容刷新（SSE/轮询）与页签切换不得覆盖用户正在编辑的草稿
    const draftChapterRef = useRef<number | null>(null);
    const draftBookRef = useRef<string | null>(null);
    useEffect(() => {
        const nextChapter = chapterDetail?.chapterNumber ?? null;
        const nextBook = currentBookRoot ?? null;
        const contextChanged =
            draftChapterRef.current !== nextChapter || draftBookRef.current !== nextBook;
        draftChapterRef.current = nextChapter;
        draftBookRef.current = nextBook;
        if (contextChanged) {
            // 详情缺失/读取失败时不清空编辑中的草稿，避免空响应吞掉未保存文本
            if (chapterDetail) {
                setDraftContent(chapterDetail.content);
                setDraftBaseline(null);
                setIsEditing(false);
            }
            return;
        }
        if (!isEditing && chapterDetail) {
            setDraftContent(chapterDetail.content);
        }
    }, [chapterDetail?.chapterNumber, chapterDetail?.content, currentBookRoot, isEditing]);

    // 脏草稿 = 编辑器打开且文本偏离基线；上报给根组件做导航守卫与 beforeunload
    const isDraftDirty =
        isEditing && draftBaseline !== null && draftContent !== draftBaseline;
    const draftDirtyLocation =
        isDraftDirty && chapterDetail
            ? {
                  bookRoot: currentBookRoot ?? '',
                  chapterNumber: chapterDetail.chapterNumber,
                  content: draftContent
              }
            : null;
    useEffect(() => {
        onDraftDirtyChange?.(draftDirtyLocation);
    }, [
        onDraftDirtyChange,
        draftDirtyLocation?.bookRoot,
        draftDirtyLocation?.chapterNumber,
        draftDirtyLocation?.content
    ]);
    useEffect(
        () => () => {
            onDraftDirtyChange?.(null);
        },
        [onDraftDirtyChange]
    );

    // 守卫保存成功/放弃修改后强制结束编辑：即使随后详情 GET 失败也不残留脏草稿
    const serverContentRef = useRef<string>('');
    serverContentRef.current = chapterDetail?.content ?? '';
    useEffect(() => {
        if (!onDraftControlReady) return;
        onDraftControlReady({
            resetDraft: (savedContent?: string) => {
                // 普通保存尚在途时不接受守卫清稿：PUT 未决期间草稿必须保留
                if (savingRef.current) return;
                setDraftBaseline(null);
                setIsEditing(false);
                setDraftContent(savedContent ?? serverContentRef.current);
            }
        });
        return () => onDraftControlReady(null);
    }, [onDraftControlReady]);

    // YOLO 浮层：点击外部或 Escape 关闭（焦点回到触发按钮）
    const yoloWrapRef = useRef<HTMLDivElement | null>(null);
    const yoloTriggerRef = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        if (!yoloMenuOpen) return;
        const onPointerDown = (ev: MouseEvent | TouchEvent) => {
            const target = ev.target as Node | null;
            if (target && yoloWrapRef.current && !yoloWrapRef.current.contains(target)) {
                setYoloMenuOpen(false);
            }
        };
        const onKeyDown = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                setYoloMenuOpen(false);
                yoloTriggerRef.current?.focus();
            }
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('touchstart', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('touchstart', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [yoloMenuOpen]);

    const stageMap = useMemo(
        () => deriveStagesFromSse(latestSseStage, stages),
        [latestSseStage, stages]
    );

    const inspectedStageDef = useMemo(
        () => PIPELINE_STAGES.find((item) => item.id === inspectedStageId) ?? null,
        [inspectedStageId]
    );

    const effectiveSignalsCount = pendingSignalsCount ?? pendingSignals.length;

    const showFeedback = (msg: string) => {
        setActionError(null);
        setActionMessage(msg);
    };

    const showError = (err: unknown) => {
        setActionMessage(null);
        setActionError(err instanceof Error ? err.message : String(err));
    };

    /** 触发单步推进 1 章 */
    const handleStepOne = async () => {
        setYoloMenuOpen(false);
        try {
            if (onStepOne) {
                await onStepOne();
            } else {
                const resp = await fetch('/api/narrate/step', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chapterGoal: '按既定主线与人物弧光自然推进下一章'
                    })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `单步推进失败 (${resp.status})`);
                }
            }
            showFeedback('已发起单步推进 1 章');
        } catch (err) {
            showError(err);
        }
    };

    /** 触发 YOLO 连跑 */
    const handleStartYolo = async (targetChapters: number) => {
        setYoloMenuOpen(false);
        try {
            if (onStartYolo) {
                await onStartYolo(targetChapters);
            } else {
                const resp = await fetch('/api/narrate/yolo/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetChapters })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `启动 YOLO 连跑失败 (${resp.status})`);
                }
            }
            showFeedback(
                targetChapters === 0
                    ? '已开启 YOLO 持续连跑（遇安全点或人工停止为止）'
                    : `已开启 YOLO 连跑 ${targetChapters} 章`
            );
        } catch (err) {
            showError(err);
        }
    };

    /** 触发安全点停止 */
    const handleStopYolo = async () => {
        try {
            if (onStopYolo) {
                await onStopYolo();
            } else {
                const resp = await fetch('/api/narrate/yolo/stop', { method: 'POST' });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `发送安全点停止失败 (${resp.status})`);
                }
            }
            showFeedback('已请求安全点停止，将在当前事务提交后停下');
        } catch (err) {
            showError(err);
        }
    };

    /** 触发手动 Sync */
    const handleSync = async () => {
        try {
            if (onSync) {
                await onSync();
            } else {
                const resp = await fetch('/api/narrate/sync', { method: 'POST' });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `手动 Sync 失败 (${resp.status})`);
                }
            }
            showFeedback('已完成手改差异扫描与状态 Sync');
        } catch (err) {
            showError(err);
        }
    };

    /** 放弃编辑：脏草稿需要宿主 Modal 确认，干净草稿直接退出编辑 */
    const handleCancelEditing = () => {
        if (isDraftDirty) {
            setDiscardConfirmOpen(true);
            return;
        }
        setDraftBaseline(null);
        setIsEditing(false);
        setDraftContent(chapterDetail?.content ?? '');
    };

    /** 打开编辑器：以当前服务器正文为基线；已打开时保留草稿不重置 */
    const handleStartEditing = () => {
        if (!chapterDetail) {
            showError('章节详情尚未加载，暂不能编辑');
            return;
        }
        if (!isEditing) {
            setDraftContent(chapterDetail.content);
            setDraftBaseline(chapterDetail.content);
        }
        setIsEditing(true);
    };

    /** 触发手动 Dreaming */
    const handleDream = async () => {
        try {
            if (onDream) {
                await onDream();
            } else {
                const resp = await fetch('/api/narrate/dream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: true })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `手动 Dreaming 失败 (${resp.status})`);
                }
            }
            showFeedback('已触发睡眠 VACUUM 与连续性整理');
        } catch (err) {
            showError(err);
        }
    };

    /** 保存直接编辑的正文并自动 Sync */
    const handleSaveEditedChapter = async () => {
        // 同步 ref 防重入：savingEdit 渲染生效前的重复点击不得发出第二次 PUT
        if (savingRef.current) {
            return;
        }
        // 保存目标取正在显示/编辑的详情章身份，不随导航意图 selectedChapter 漂移
        const targetChapterNumber = chapterDetail?.chapterNumber ?? activeChapterNumber;
        if (!targetChapterNumber || targetChapterNumber <= 0) {
            showError('当前没有可保存的有效章节号');
            return;
        }
        // busy 时后端会拒绝 PUT，不能假装保存成功；保留草稿等待空闲
        if (isBusy) {
            showError('引擎正在执行任务，暂时无法保存；草稿已保留，请待任务结束后重试');
            return;
        }
        const contentToSave = draftContent;
        savingRef.current = true;
        setSavingEdit(true);
        try {
            if (onSaveChapter) {
                await onSaveChapter(targetChapterNumber, contentToSave);
            } else {
                const resp = await fetch('/api/narrate/chapter', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chapterNumber: targetChapterNumber,
                        content: contentToSave
                    })
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `保存并 Sync 失败 (${resp.status})`);
                }
            }
            // 保存成功后以已保存文本为新基线；同章详情刷新不会覆盖草稿
            setDraftBaseline(contentToSave);
            setIsEditing(false);
            showFeedback(`已保存 ${formatChapterLabel(targetChapterNumber)} 并自动完成 Sync`);
        } catch (err) {
            showError(err);
        } finally {
            savingRef.current = false;
            setSavingEdit(false);
        }
    };

    /** 提交一次性导演信号（支持投入队列或入队并推进） */
    const handleSignalAction = async (runAfter: boolean) => {
        const trimmed = signalInput.trim();
        if (!trimmed) {
            if (runAfter) {
                await handleStepOne();
            }
            return;
        }

        setSubmittingSignal(true);
        try {
            if (onSubmitSignal) {
                await onSubmitSignal({ kind: signalKind, content: trimmed, runAfter });
            } else {
                const payload = buildOpsSignalPayload(signalKind, trimmed, currentChapter);
                const resp = await fetch('/api/narrate/signals', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!resp.ok) {
                    const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(errBody.error ?? `投递信号失败 (${resp.status})`);
                }
                if (runAfter) {
                    await handleStepOne();
                }
            }
            setSignalInput('');
            showFeedback(
                runAfter
                    ? '信号已写入 .ops/signals.jsonl 并触发推进'
                    : '信号已投入 .ops/signals.jsonl 队列（安全点消费即焚）'
            );
        } catch (err) {
            showError(err);
        } finally {
            setSubmittingSignal(false);
        }
    };

    /** 计算当前斜杠指令匹配结果 */
    const slashQueryMatch = useMemo(() => /^\/(\S*)$/.exec(signalInput), [signalInput]);
    const filteredSlashCommands = useMemo(
        () => (slashQueryMatch ? filterSlashCommands(slashQueryMatch[1] ?? '') : []),
        [slashQueryMatch]
    );
    const isSlashMenuOpen =
        slashQueryMatch !== null && !slashMenuDismissed && filteredSlashCommands.length > 0;
    const clampedSlashIndex =
        filteredSlashCommands.length > 0
            ? Math.min(activeSlashIndex, filteredSlashCommands.length - 1)
            : 0;

    /** 选中斜杠指令：切换信号类型、剥离 /xxx 前缀并保持输入焦点 */
    const applySlashCommand = (cmd: SlashCommandItem) => {
        setSignalKind(cmd.kind);
        setSignalInput((prev) => prev.replace(/^\/\S*\s*/, ''));
        setSlashMenuDismissed(false);
        setActiveSlashIndex(0);
        signalInputRef.current?.focus();
    };

    /** 切换至历史章节 */
    const handleChapterChange = (nextChapter: number) => {
        if (onSelectChapter) {
            onSelectChapter(nextChapter);
        }
    };

    const yoloProgressText = yolo
        ? yolo.targetChapters > 0
            ? `YOLO 连跑 ${yolo.completedChapters}/${yolo.targetChapters} 章`
            : `YOLO 持续连跑中 · 已完成 ${yolo.completedChapters} 章`
        : '';

    const activeChapterIndex = useMemo(
        () => chapters.findIndex((ch) => ch.chapterNumber === activeChapterNumber),
        [chapters, activeChapterNumber]
    );
    const activeChapterSummary =
        activeChapterIndex >= 0 ? (chapters[activeChapterIndex] ?? null) : null;
    const prevChapterSummary =
        activeChapterIndex > 0 ? (chapters[activeChapterIndex - 1] ?? null) : null;
    const nextChapterSummary =
        activeChapterIndex >= 0 && activeChapterIndex < chapters.length - 1
            ? (chapters[activeChapterIndex + 1] ?? null)
            : null;

    const activeChapterTitle =
        chapterDetail?.title ??
        activeChapterSummary?.title ??
        `${formatChapterLabel(activeChapterNumber)} 正文`;
    const chapterFileName =
        activeChapterSummary?.fileName ??
        `ch_${String(Math.max(0, activeChapterNumber)).padStart(4, '0')}.md`;
    const diffHunks = useMemo(
        () => parseUnifiedDiff(chapterDetail?.diffFromHead ?? '', chapterFileName),
        [chapterDetail?.diffFromHead, chapterFileName]
    );
    const isChapterDirty = Boolean(chapterDetail?.dirty ?? activeChapterSummary?.dirty);
    const proseContent = chapterDetail?.content ?? '';
    const proseCharCount = useMemo(
        () => proseContent.replace(/\s+/g, '').length,
        [proseContent]
    );
    const proseParagraphs = useMemo(
        () => splitProseParagraphs(proseContent, activeChapterNumber, activeChapterTitle),
        [proseContent, activeChapterNumber, activeChapterTitle]
    );

    // SAFE_HALT / Sync 双栏对比裁决卡数据
    const verdictCardData = useMemo(() => {
        const hasPendingSync = isChapterDirty && Boolean(chapterDetail?.diffFromHead?.trim());
        if (!safeHalt && !hasPendingSync) {
            return null;
        }

        const firstViolation = gateViolations[0];

        if (safeHalt) {
            const issues = safeHalt.issues ?? [];
            const firstIssue = issues[0];
            const targetChapterName =
                safeHalt.chapter !== undefined
                    ? `ch_${String(Math.max(0, safeHalt.chapter)).padStart(4, '0')}.md`
                    : chapterFileName;
            const targetLine = firstIssue?.line ?? firstViolation?.line;

            const leftRef =
                safeHalt.leftRef ??
                firstIssue?.sourceRef ??
                (safeHalt.conflictId ? `冲突源 · ${safeHalt.conflictId}` : '设定真源 / 上游锚点');
            const leftExcerpt =
                safeHalt.leftExcerpt ??
                firstIssue?.sourceQuote ??
                safeHalt.details ??
                safeHalt.reason;

            const rightRef =
                safeHalt.rightRef ??
                `${targetChapterName}${targetLine !== undefined ? ` · L${targetLine}` : ''}`;

            const rightItems: Array<{
                line?: number | undefined;
                rule?: string | undefined;
                text: string;
            }> = [];

            for (const issue of issues.slice(0, 3)) {
                const quoteText = issue.quote ?? issue.snippet ?? issue.detail;
                if (quoteText) {
                    rightItems.push({
                        line: issue.line,
                        rule: issue.rule,
                        text: quoteText
                    });
                }
            }
            for (const violation of gateViolations.slice(0, 3)) {
                const quoteText = violation.snippet ?? violation.detail;
                if (quoteText) {
                    rightItems.push({
                        line: violation.line,
                        rule: violation.rule,
                        text: quoteText
                    });
                }
            }

            if (rightItems.length === 0) {
                const fallbackExcerpt =
                    safeHalt.rightExcerpt ??
                    proseParagraphs.find((p) => !p.isBreak)?.text ??
                    '当前章节草稿已被安全门拦截，尚未提交入库。';
                rightItems.push({
                    line: targetLine,
                    rule: safeHalt.stage,
                    text: fallbackExcerpt
                });
            }

            return {
                mode: 'halt' as const,
                eyeText: '需要你拍板 · YOLO 已在安全点挂起',
                tagText: 'SAFE_HALT',
                title: safeHalt.reason,
                affectedChapters: safeHalt.affectedChapters,
                rollbackThreshold: safeHalt.rollbackThreshold,
                stage: safeHalt.stage,
                leftRef,
                leftLine: undefined as number | undefined,
                leftRole: '冲突源 / 原设定引文',
                leftText: leftExcerpt,
                rightRef,
                rightLine: targetLine,
                rightRole:
                    issues.length > 0 || gateViolations.length > 0
                        ? '门禁违规行 / 本章草稿'
                        : '本章草稿',
                rightItems
            };
        }

        // Sync 待对账裁决卡
        let totalAdd = 0;
        let totalDel = 0;
        let firstAdd: ParsedDiffRow | undefined;
        let firstDel: ParsedDiffRow | undefined;
        let firstCtx: ParsedDiffRow | undefined;

        for (const hunk of diffHunks) {
            totalAdd += hunk.addCount;
            totalDel += hunk.delCount;
            for (const row of hunk.rows) {
                if (row.kind === 'add' && !firstAdd) firstAdd = row;
                if (row.kind === 'del' && !firstDel) firstDel = row;
                if (row.kind === 'ctx' && !firstCtx) firstCtx = row;
            }
        }

        const rightItems: Array<{
            line?: number | undefined;
            rule?: string | undefined;
            text: string;
        }> = [];
        for (const violation of gateViolations.slice(0, 3)) {
            const quoteText = violation.snippet ?? violation.detail;
            if (quoteText) {
                rightItems.push({
                    line: violation.line,
                    rule: violation.rule,
                    text: quoteText
                });
            }
        }
        if (rightItems.length === 0) {
            rightItems.push({
                line: firstDel?.lineNumber ?? firstCtx?.lineNumber ?? undefined,
                text:
                    firstDel?.text ??
                    firstCtx?.text ??
                    '本次为纯新增手改，Git HEAD 中无对应旧行。'
            });
        }

        return {
            mode: 'sync' as const,
            eyeText: '需要你拍板 · 手改待对账',
            tagText: 'Sync',
            title: '检测到手稿改动，待执行 Sync 对账与连续性扫描',
            totalAdd,
            totalDel,
            leftRef: `${chapterFileName}${firstAdd?.lineNumber ? ` · L${firstAdd.lineNumber}` : ''}`,
            leftLine: firstAdd?.lineNumber ?? undefined,
            leftRole: '当前手改片段',
            leftText:
                firstAdd?.text ??
                firstCtx?.text ??
                '工作区正文存在未对账修改，待扫描实体与下游连续性。',
            rightRef: firstViolation
                ? `${chapterFileName}${firstViolation.line ? ` · L${firstViolation.line}` : ''}`
                : `${chapterFileName}${firstDel?.lineNumber ? ` · L${firstDel.lineNumber}` : ''}`,
            rightLine: firstViolation?.line ?? firstDel?.lineNumber ?? undefined,
            rightRole: gateViolations.length > 0 ? '门禁违规行' : 'Git HEAD 原文',
            rightItems
        };
    }, [
        chapterDetail?.diffFromHead,
        chapterFileName,
        diffHunks,
        gateViolations,
        isChapterDirty,
        proseParagraphs,
        safeHalt
    ]);
    const featHash =
        chapterDetail?.featCommitSha?.slice(0, 7) ??
        activeChapterSummary?.commitSha?.slice(0, 7) ??
        undefined;
    const stateHash = chapterDetail?.stateCommitSha?.slice(0, 7) ?? undefined;
    // 细纲呈现状态：契约缺失时按历史未留存诚实呈现，不用生成动作冒充读取
    const outlineStatus = chapterDetail?.outlineStatus ?? 'missing';
    const parsedPlan = useMemo(
        () =>
            outlineStatus === 'available'
                ? parseStructuredPlan(chapterDetail?.outlineText ?? undefined, activeChapterTitle)
                : null,
        [outlineStatus, chapterDetail?.outlineText, activeChapterTitle]
    );
    const currentFontSize = PROSE_FONT_SIZES[fontStep] ?? 17;

    // 6 圆点连线进度胶囊当前阶段状态词
    const stageStatusLabel = useMemo(() => {
        if (safeHalt) return 'SAFE_HALT 拦截';
        const activeStage = PIPELINE_STAGES.find((s) => stageMap[s.id].status === 'active');
        if (activeStage) {
            return `${activeStage.label.replace(/^\d+\.\s*/, '')} ${activeStage.shortDesc}`;
        }
        const healingStage = PIPELINE_STAGES.find((s) => stageMap[s.id].status === 'healing');
        if (healingStage) {
            return `${healingStage.label.replace(/^\d+\.\s*/, '')} 自愈中`;
        }
        if (latestSseStage === 'COMMITTED') return '本轮已提交';
        return '链路就绪';
    }, [latestSseStage, safeHalt, stageMap]);

    // 可见待消费纸条列表（撤回由根组件统一调用后端 DELETE 真删，不再本地隐藏）
    const visibleSignals = useMemo(
        () => pendingSignals.map((sig, idx) => ({ sig, idx })),
        [pendingSignals]
    );

    const stopPending = haltRequested || Boolean(yolo?.stopRequested);
    const runtimeStatus = safeHalt
        ? '运行已暂停，请在检查器查看冲突'
        : savingEdit
          ? '正在保存本章并同步'
          : stopPending && isBusy
            ? haltWaiting
                ? '停止请求已收到，当前任务仍在执行，正在等待安全点'
                : '已请求停止，等待当前任务到达安全点'
            : activeTask === 'SYNCING'
              ? '正在同步手改内容'
              : activeTask === 'DREAMING'
                ? '正在整理作品资料'
                : activeTask === 'BOOTING'
                  ? '正在编译开书设置'
                  : isBusy
                    ? '正在生成章节'
                    : stopPending
                      ? '已停止，可以继续审阅或推进'
                      : '就绪，可审阅正文或推进下一章';

    return (
        <main className="ns-center-workbench">
            {/* 顶栏：作品切换与开书，右侧为运行操作 */}
            <header className="ns-topbar">
                <div className="ns-top-left">
                    {books.length > 0 && onSelectBook ? (
                        <select
                            className="ns-top-book-select"
                            aria-label="切换作品"
                            value={currentBookRoot ?? ''}
                            disabled={isBusy}
                            onChange={(e) => {
                                if (e.target.value && e.target.value !== currentBookRoot) {
                                    onSelectBook(e.target.value);
                                }
                            }}
                        >
                            {books.map((book) => (
                                <option key={book.bookRoot} value={book.bookRoot}>
                                    {book.title || book.slug}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <span className="ns-book-name" title={bookTitle || bookSlug || 'NarrateOS'}>
                            {bookTitle || bookSlug || '未命名作品'}
                        </span>
                    )}


                    {onNewBook ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-ghost ns-btn-sm"
                            disabled={isBusy}
                            onClick={onNewBook}
                        >
                            + 开新书
                        </button>
                    ) : null}

                    {activeTask !== 'IDLE' ? (
                        <span className="ns-pill ns-pill-amber">{activeTask}</span>
                    ) : null}
                </div>

                <div className="ns-top-right">
                    <button
                        type="button"
                        className="ns-icon-btn"
                        disabled={isBusy}
                        onClick={() => {
                            if (onRefreshViews) {
                                void onRefreshViews();
                            }
                        }}
                        title="只读刷新工作区视图（不触发 Sync）"
                        aria-label="刷新工作区视图"
                    >
                        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7" />
                            <path d="M13.5 2.5v2.8h-2.8" />
                        </svg>
                    </button>

                    {dirtyChaptersCount > 0 ? (
                        <button
                            type="button"
                            className="ns-btn ns-btn-ghost ns-btn-sm ns-btn-dirty"
                            disabled={isBusy || syncingFromDiff}
                            onClick={() => void handleSync()}
                            title={`检测到 ${dirtyChaptersCount} 章手稿改动，执行 Sync 对账（会调用模型分析差异）`}
                        >
                            {activeTask === 'SYNCING' ? 'Sync 对账中…' : `Sync 手改 (${dirtyChaptersCount})`}
                        </button>
                    ) : null}

                    {isYoloRunning ? (
                        <div className="ns-yolo-running-bar">
                            <span className="ns-pill ns-pill-brand ns-pulse">
                                {yoloProgressText}
                                {yolo?.currentStage ? ` · ${yolo.currentStage}` : ''}
                            </span>
                            <button
                                type="button"
                                className="ns-btn ns-btn-stop ns-btn-sm"
                                disabled={stopPending}
                                onClick={handleStopYolo}
                            >
                                {stopPending ? '等待安全点…' : '安全点停止'}
                            </button>
                        </div>
                    ) : (
                        <div className="ns-split-btn-wrap" ref={yoloWrapRef}>
                            <div className="ns-split-btn">
                                <button
                                    type="button"
                                    className="ns-btn ns-btn-primary ns-btn-sm"
                                    disabled={isBusy}
                                    onClick={handleStepOne}
                                >
                                    ▶ 推进 1 章
                                </button>
                                <button
                                    ref={yoloTriggerRef}
                                    type="button"
                                    className="ns-btn ns-btn-yolo ns-btn-sm"
                                    disabled={isBusy}
                                    aria-expanded={yoloMenuOpen}
                                    aria-haspopup="menu"
                                    onClick={() => setYoloMenuOpen((prev) => !prev)}
                                >
                                    YOLO ▾
                                </button>
                            </div>

                            {yoloMenuOpen ? (
                                <div className="ns-popover ns-yolo-popover" role="menu">
                                    <div className="ns-popover-title">选择 YOLO 连跑模式</div>
                                    {YOLO_PRESETS.map((preset) => (
                                        <button
                                            key={preset.targetChapters}
                                            type="button"
                                            className="ns-popover-item"
                                            onClick={() => handleStartYolo(preset.targetChapters)}
                                        >
                                            <span className="ns-popover-item-title">
                                                {preset.label}
                                            </span>
                                            <span className="ns-popover-item-desc">
                                                {preset.desc}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    )}

                    {onToggleRight ? (
                        <button
                            type="button"
                            className={`ns-icon-btn ${rightOpen ? 'ns-btn-active' : ''} ${hasSafeHalt ? 'ns-btn-halt-alert' : ''}`}
                            onClick={onToggleRight}
                            title={rightOpen ? '收起右侧辅助栏' : '展开右侧辅助栏'}
                            aria-label={rightOpen ? '收起右侧辅助栏' : '展开右侧辅助栏'}
                        >
                            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
                                <path d="M10.5 2.5v11" />
                            </svg>
                            {hasSafeHalt ? <span className="ns-badge-dot ns-badge-red">!</span> : null}
                        </button>
                    ) : null}
                </div>
            </header>

            {/* 顶栏第二行：蓝底线页签（正文 | 细纲 | 修改 | 视图） + 6 圆点连线进度胶囊 + Aa + ✎ 编辑 */}
            <div className="ns-top-2">
                <div className="ns-dsh-tabs" role="tablist" aria-label="章节视图" onKeyDown={handleTabKeyDown}>
                    <button
                        type="button"
                        role="tab"
                        id="ns-tab-prose"
                        aria-controls="ns-chapter-panel"
                        tabIndex={viewTab === 'prose' ? 0 : -1}
                        aria-selected={viewTab === 'prose'}
                        className={`ns-dsh-tab ${viewTab === 'prose' ? 'on' : ''}`}
                        onClick={() => setViewTab('prose')}
                    >
                        正文
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="ns-tab-plan"
                        aria-controls="ns-chapter-panel"
                        tabIndex={viewTab === 'plan' ? 0 : -1}
                        aria-selected={viewTab === 'plan'}
                        className={`ns-dsh-tab ${viewTab === 'plan' ? 'on' : ''}`}
                        onClick={() => setViewTab('plan')}
                    >
                        细纲
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="ns-tab-diff"
                        aria-controls="ns-chapter-panel"
                        tabIndex={viewTab === 'diff' ? 0 : -1}
                        aria-selected={viewTab === 'diff'}
                        className={`ns-dsh-tab ${viewTab === 'diff' ? 'on' : ''}`}
                        onClick={() => setViewTab('diff')}
                    >
                        修改
                        {diffHunks.length > 0 ? (
                            <span className="ns-tab-count">{diffHunks.length}</span>
                        ) : null}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        id="ns-tab-views"
                        aria-controls="ns-chapter-panel"
                        tabIndex={viewTab === 'views' ? 0 : -1}
                        aria-selected={viewTab === 'views'}
                        className={`ns-dsh-tab ${viewTab === 'views' ? 'on' : ''}`}
                        onClick={() => {
                            setViewTab('views');
                            if (onRefreshViews) {
                                void onRefreshViews();
                            }
                        }}
                    >
                        视图
                    </button>
                </div>

                <span className="ns-top2-spacer" />

                <div className="ns-top2-right">
                    <button
                        type="button"
                        className={`ns-thread-btn ${stageDrawerOpen ? 'open' : ''}`}
                        aria-expanded={stageDrawerOpen}
                        onClick={() => setStageDrawerOpen((prev) => !prev)}
                        title="点击展开/收起 6 阶段流水线详情检查条"
                    >
                        <span className="ns-dots" aria-hidden="true">
                            {PIPELINE_STAGES.map((stage, idx) => {
                                const nodeState = stageMap[stage.id];
                                const nextState =
                                    idx < PIPELINE_STAGES.length - 1
                                        ? stageMap[PIPELINE_STAGES[idx + 1]!.id]
                                        : null;
                                const lineLit =
                                    nextState &&
                                    (nextState.status === 'done' ||
                                        nextState.status === 'active' ||
                                        nextState.status === 'healing' ||
                                        nextState.status === 'halt');
                                return (
                                    <React.Fragment key={stage.id}>
                                        <i className={`ns-dt ${nodeState.status}`} />
                                        {idx < PIPELINE_STAGES.length - 1 ? (
                                            <b className={`ns-ln ${lineLit ? 'on' : ''}`} />
                                        ) : null}
                                    </React.Fragment>
                                );
                            })}
                        </span>
                        <span className="ns-thread-label">{stageStatusLabel}</span>
                    </button>

                    {viewTab === 'prose' ? (
                        <>
                            <button
                                type="button"
                                className="ns-icon-btn ns-aa-btn"
                                title={`切换阅读字号 (${currentFontSize}px)`}
                                onClick={() =>
                                    setFontStep((prev) => (prev + 1) % PROSE_FONT_SIZES.length)
                                }
                            >
                                Aa
                            </button>
                            <button
                                type="button"
                                className={`ns-btn ns-btn-ghost ns-btn-sm ${isEditing ? 'ns-btn-active' : ''}`}
                                disabled={savingEdit}
                                onClick={() => {
                                    if (isEditing) {
                                        handleCancelEditing();
                                    } else {
                                        handleStartEditing();
                                    }
                                }}
                            >
                                {isEditing ? '取消' : '✎ 编辑'}
                            </button>
                        </>
                    ) : null}
                </div>
            </div>

            {/* SAFE_HALT 告警条 (.ops/safe_halt.json)：非正文阅读页时保留顶部提示 */}
            {safeHalt && viewTab !== 'prose' ? (
                <section className="ns-safe-halt-banner" role="alert">
                    <div className="ns-safe-halt-head">
                        <strong>SAFE_HALT · 运行已安全挂起</strong>
                        {safeHalt.chapter !== undefined ? (
                            <span className="ns-pill ns-pill-red ns-mono">
                                {formatChapterLabel(safeHalt.chapter)}
                            </span>
                        ) : null}
                        {safeHalt.stage ? (
                            <span className="ns-pill ns-pill-muted ns-mono">
                                {safeHalt.stage}
                            </span>
                        ) : null}
                    </div>
                    <div className="ns-safe-halt-reason">{safeHalt.reason}</div>
                    {safeHalt.details ? (
                        <div className="ns-safe-halt-details ns-mono">{safeHalt.details}</div>
                    ) : null}
                </section>
            ) : null}

            {/* 6 阶段详情检查条（点击 6 圆点进度胶囊才展开） */}
            {stageDrawerOpen ? (
                <section className="ns-stage-strip" aria-label="6 阶段流水线详情">
                    <div className="ns-pipeline-graph">
                        {PIPELINE_STAGES.map((stage, idx) => {
                            const nodeState = stageMap[stage.id];
                            const statusMeta = getStageStatusMeta(nodeState.status);
                            const isSelected = inspectedStageId === stage.id;
                            const boundSessionId = nodeState.sessionId;
                            const isLiveSession =
                                Boolean(boundSessionId) &&
                                (nodeState.status === 'active' || nodeState.status === 'healing');
                            const hasHistoricalSession = Boolean(boundSessionId) && !isLiveSession;
                            return (
                                <React.Fragment key={stage.id}>
                                    <button
                                        type="button"
                                        className={`ns-stage-node ns-stage-${nodeState.status}${isSelected ? ' ns-selected' : ''}${boundSessionId ? ' ns-has-session' : ''}`}
                                        data-stage-id={stage.id}
                                        data-session-id={boundSessionId ?? ''}
                                        title={
                                            boundSessionId
                                                ? `${stage.label} - 点击查看原生会话 (${boundSessionId})`
                                                : `${stage.label} - ${stage.shortDesc}`
                                        }
                                        onClick={() => {
                                            setInspectedStageId(stage.id);
                                            onInspectStage?.(stage.id);
                                            if (boundSessionId && onSelectStageSession) {
                                                onSelectStageSession({
                                                    stageId: stage.id,
                                                    stageLabel: stage.label,
                                                    sessionId: boundSessionId,
                                                    ...(nodeState.parentSessionId !== undefined
                                                        ? { parentSessionId: nodeState.parentSessionId }
                                                        : {}),
                                                    ...(nodeState.mode !== undefined
                                                        ? { mode: nodeState.mode }
                                                        : {}),
                                                    runId: nodeState.runId,
                                                    status: nodeState.status
                                                });
                                            }
                                        }}
                                    >
                                        <span className={`ns-stage-dot ns-dot-${nodeState.status}`} />
                                        <span className="ns-stage-label">{stage.label}</span>
                                        <span className={`ns-stage-status ${statusMeta.badgeClass}`}>
                                            {statusMeta.text}
                                        </span>
                                        {isLiveSession ? (
                                            <span
                                                className="ns-stage-sess-pill ns-sess-live"
                                                aria-label="实时会话运行中"
                                            >
                                                <span className="ns-stage-sess-spinner" aria-hidden="true" />
                                                实时会话
                                            </span>
                                        ) : hasHistoricalSession ? (
                                            <span
                                                className="ns-stage-sess-pill ns-sess-done"
                                                aria-label="已留存历史会话"
                                            >
                                                轨迹
                                            </span>
                                        ) : null}
                                        {nodeState.badge ? (
                                            <span className="ns-stage-repair ns-mono">{nodeState.badge}</span>
                                        ) : null}
                                    </button>
                                    {idx < PIPELINE_STAGES.length - 1 ? (
                                        <span className="ns-stage-arrow" aria-hidden="true">
                                            ›
                                        </span>
                                    ) : null}
                                </React.Fragment>
                            );
                        })}
                    </div>

                    {inspectedStageDef ? (
                        <div className="ns-stage-inspector">
                            <div className="ns-inspector-main">
                                <div className="ns-inspector-title">
                                    <strong>
                                        {inspectedStageDef.label} ({inspectedStageDef.shortDesc})
                                    </strong>
                                    <span className="ns-mono ns-muted">
                                        SSE: {latestSseStage ?? 'IDLE'}
                                    </span>
                                    {stageMap[inspectedStageDef.id].sessionId &&
                                    onSelectStageSession ? (
                                        <button
                                            type="button"
                                            className="ns-btn ns-btn-primary ns-btn-xs"
                                            onClick={() => {
                                                const st = stageMap[inspectedStageDef.id];
                                                if (!st.sessionId) return;
                                                onSelectStageSession({
                                                    stageId: inspectedStageDef.id,
                                                    stageLabel: inspectedStageDef.label,
                                                    sessionId: st.sessionId,
                                                    ...(st.parentSessionId !== undefined
                                                        ? { parentSessionId: st.parentSessionId }
                                                        : {}),
                                                    ...(st.mode !== undefined ? { mode: st.mode } : {}),
                                                    runId: st.runId,
                                                    status: st.status
                                                });
                                            }}
                                        >
                                            打开会话轨迹
                                        </button>
                                    ) : null}
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-ghost ns-btn-xs"
                                        onClick={() => setStageDrawerOpen(false)}
                                    >
                                        收起
                                    </button>
                                </div>
                                <div className="ns-inspector-io">
                                    <span>
                                        <strong>输入概要：</strong>
                                        {stageMap[inspectedStageDef.id].inputSummary ??
                                            inspectedStageDef.defaultInput}
                                    </span>
                                    <span>
                                        <strong>输出概要：</strong>
                                        {stageMap[inspectedStageDef.id].outputSummary ??
                                            inspectedStageDef.defaultOutput}
                                    </span>
                                </div>
                                {stageMap[inspectedStageDef.id].sessionId ? (
                                    <div className="ns-inspector-session-note ns-mono">
                                        已绑定 Session: {stageMap[inspectedStageDef.id].sessionId}
                                        {stageMap[inspectedStageDef.id].runId
                                            ? ` - runId: ${stageMap[inspectedStageDef.id].runId}`
                                            : ''}
                                    </div>
                                ) : inspectedStageDef.id === 'WRITER' ? (
                                    <div className="ns-inspector-cleanroom-note" role="note">
                                        <strong>只读说明：</strong>
                                        该历史章节的 Writer 未绑定原生会话（早期历史记录未留存会话轨迹），门禁与遥测明细请在右侧「检查器」查看。
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                </section>
            ) : null}

            {/* 操作反馈条 */}
            {actionMessage || actionError ? (
                <div className={`ns-feedback-bar ${actionError ? 'ns-feedback-err' : 'ns-feedback-ok'}`}>
                    <span>{actionError ?? actionMessage}</span>
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost ns-btn-xs"
                        onClick={() => {
                            setActionMessage(null);
                            setActionError(null);
                        }}
                    >
                        ×
                    </button>
                </div>
            ) : null}

            {/* 主内容区 */}
            <div className="ns-stage-body" id="ns-chapter-panel" role="tabpanel" aria-labelledby={`ns-tab-${viewTab}`} tabIndex={0}>
                {viewTab === 'prose' ? (
                    <article
                        className="ns-prose-col"
                        style={{ '--ns-fs': `${currentFontSize}px` } as React.CSSProperties}
                    >
                        {/* SAFE_HALT / Sync 双栏对比裁决卡 */}
                        {verdictCardData ? (
                            <section
                                className={`ns-verdict ${verdictCardData.mode === 'halt' ? 'ns-verdict-red' : 'ns-verdict-amber'}`}
                                role="alert"
                                aria-label={verdictCardData.tagText}
                            >
                                <div className="ns-v-eye">
                                    <span className="ns-v-pd" aria-hidden="true" />
                                    <span>{verdictCardData.eyeText}</span>
                                    <span className="ns-v-tag">{verdictCardData.tagText}</span>
                                </div>

                                <h2>{verdictCardData.title}</h2>

                                <p className="ns-v-sub">
                                    {verdictCardData.mode === 'halt' ? (
                                        <>
                                            {verdictCardData.stage ? (
                                                <>
                                                    挂起阶段 <b>{verdictCardData.stage}</b>
                                                    {' · '}
                                                </>
                                            ) : null}
                                            {verdictCardData.affectedChapters !== undefined ? (
                                                <>
                                                    波及 <b>{verdictCardData.affectedChapters}</b> 章
                                                    {verdictCardData.rollbackThreshold !== undefined ? (
                                                        <>
                                                            {' · 超过自动回滚上限 '}
                                                            <b>{verdictCardData.rollbackThreshold}</b>
                                                            {' 章'}
                                                        </>
                                                    ) : null}
                                                </>
                                            ) : (
                                                '安全门已锁定自动写入，请投入纠偏信号或直接编辑本章修复。'
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            当前章节相对 Git HEAD 新增{' '}
                                            <b>+{verdictCardData.totalAdd}</b> / 删除{' '}
                                            <b>-{verdictCardData.totalDel}</b> 行，等待增量刷新视图与实体连续性扫描。
                                        </>
                                    )}
                                </p>

                                <div className="ns-v-ev">
                                    <figure>
                                        <figcaption>
                                            <span>
                                                {verdictCardData.leftRef}
                                                {verdictCardData.leftLine !== undefined ? (
                                                    <>
                                                        {' · '}
                                                        <b>L{verdictCardData.leftLine}</b>
                                                    </>
                                                ) : null}
                                            </span>
                                            <span>{verdictCardData.leftRole}</span>
                                        </figcaption>
                                        <blockquote>
                                            <mark
                                                className={
                                                    verdictCardData.mode === 'sync' ? 'ns-add' : undefined
                                                }
                                            >
                                                {verdictCardData.leftText}
                                            </mark>
                                        </blockquote>
                                    </figure>

                                    <figure>
                                        <figcaption>
                                            <span>
                                                {verdictCardData.rightRef}
                                                {verdictCardData.rightLine !== undefined ? (
                                                    <>
                                                        {' · '}
                                                        <b>L{verdictCardData.rightLine}</b>
                                                    </>
                                                ) : null}
                                            </span>
                                            <span>{verdictCardData.rightRole}</span>
                                        </figcaption>
                                        {verdictCardData.rightItems.length > 1 ? (
                                            <div className="ns-v-issue-list">
                                                {verdictCardData.rightItems.map((item, idx) => (
                                                    <div key={idx} className="ns-v-issue-item">
                                                        {item.line !== undefined || item.rule ? (
                                                            <div className="ns-v-issue-meta">
                                                                {item.line !== undefined ? (
                                                                    <b>L{item.line}</b>
                                                                ) : null}
                                                                {item.rule ? (
                                                                    <span>{item.rule}</span>
                                                                ) : null}
                                                            </div>
                                                        ) : null}
                                                        <blockquote>
                                                            <mark>{item.text}</mark>
                                                        </blockquote>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <blockquote>
                                                <mark>{verdictCardData.rightItems[0]?.text ?? ''}</mark>
                                            </blockquote>
                                        )}
                                    </figure>
                                </div>

                                <div className="ns-v-acts">
                                    {verdictCardData.mode === 'halt' ? (
                                        <button
                                            type="button"
                                            className="ns-v-opt ns-go"
                                            onClick={() => {
                                                if (isEditing) {
                                                    handleCancelEditing();
                                                }
                                                setSignalKind('Retcon');
                                                if (!signalInput.trim() && safeHalt?.reason) {
                                                    setSignalInput(`纠偏：${safeHalt.reason}`);
                                                }
                                                signalInputRef.current?.scrollIntoView({
                                                    behavior: 'smooth',
                                                    block: 'center'
                                                });
                                                signalInputRef.current?.focus();
                                            }}
                                        >
                                            <span className="ns-v-opt-ico" aria-hidden="true">
                                                ↻
                                            </span>
                                            <span>
                                                <b>投入改写/纠偏信号</b>
                                                <small>切至底部导演纸条栏写入 Retcon 约束并重新推进</small>
                                            </span>
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            className="ns-v-opt ns-go"
                                            disabled={isBusy || syncingFromDiff}
                                            onClick={() => {
                                                setSyncingFromDiff(true);
                                                void Promise.resolve(handleSync()).finally(() => {
                                                    setSyncingFromDiff(false);
                                                });
                                            }}
                                        >
                                            <span className="ns-v-opt-ico" aria-hidden="true">
                                                ⇄
                                            </span>
                                            <span>
                                                <b>
                                                    {activeTask === 'SYNCING' || syncingFromDiff
                                                        ? '正在执行 Sync 对账…'
                                                        : '立即执行 Sync 对账'}
                                                </b>
                                                <small>增量更新实体/时间线视图并扫描下游连续性</small>
                                            </span>
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        className="ns-v-opt"
                                        onClick={handleStartEditing}
                                    >
                                        <span className="ns-v-opt-ico" aria-hidden="true">
                                            ✎
                                        </span>
                                        <span>
                                            <b>直接编辑本章修复</b>
                                            <small>打开内置编辑器修订原稿，保存后自动触发 Sync</small>
                                        </span>
                                    </button>
                                </div>

                                <div className="ns-v-more">
                                    {verdictCardData.mode === 'sync' ? (
                                        <button
                                            type="button"
                                            onClick={() => setViewTab('diff')}
                                        >
                                            查看完整手改 Diff
                                        </button>
                                    ) : null}
                                    {onOpenInspector ? (
                                        <button type="button" onClick={onOpenInspector}>
                                            打开右栏检查器（门禁 / Git WAL）
                                        </button>
                                    ) : null}
                                </div>
                            </section>
                        ) : null}

                        {/* 精致章节头：大号半透明章号 + 卷/章 kicker + 标题 + 元信息 */}
                        <header className="ns-chap-header">
                            <div className="ns-chap-numeral">{activeChapterNumber}</div>
                            <div>
                                <div className="ns-chap-kick">
                                    {chapterDetail?.volumeLabel
                                        ? `${chapterDetail.volumeLabel} · `
                                        : bookTitle
                                            ? `${bookTitle} · `
                                            : ''}
                                    {formatChapterLabel(activeChapterNumber)}
                                    {timelineMode ? ` · ${timelineMode}` : ''}
                                </div>
                                <h1>{activeChapterTitle}</h1>
                                <div className="ns-chap-meta">
                                    <span
                                        className={`ns-pill ${isChapterDirty ? 'ns-pill-amber' : 'ns-pill-green'}`}
                                    >
                                        {isChapterDirty ? '有本地手改待 Sync' : '已定稿 · 已对齐 WAL'}
                                    </span>
                                    <span>
                                        {proseCharCount > 0
                                            ? `${proseCharCount.toLocaleString('zh-CN')} 字`
                                            : '暂无正文内容'}
                                    </span>
                                    {featHash ? (
                                        <span className="ns-mono">feat {featHash}</span>
                                    ) : null}
                                    {chapterDetail?.sha256 ? (
                                        <span className="ns-mono">
                                            sha256 {chapterDetail.sha256.slice(0, 7)}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        </header>

                        {isEditing ? (
                            <div className="ns-editor-wrap">
                                <textarea
                                    className="ns-editor-textarea"
                                    value={draftContent}
                                    onChange={(e) => setDraftContent(e.target.value)}
                                    rows={20}
                                    placeholder="在此直接修订本章 Markdown 正文…"
                                />
                                <div className="ns-editor-footer">
                                    <span className="ns-muted">
                                        {isDraftDirty
                                            ? '有未保存修改 · 保存后写入原稿真源并自动 Sync；离开本章前会先确认'
                                            : '保存后将写入原稿真源并自动调用 PUT /api/narrate/chapter 触发 Sync'}
                                    </span>
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-primary"
                                        disabled={savingEdit || isBusy}
                                        title={isBusy ? '引擎任务运行中，暂不能保存；草稿已保留' : undefined}
                                        onClick={handleSaveEditedChapter}
                                    >
                                        {savingEdit ? '正在保存并 Sync…' : '保存并自动 Sync'}
                                    </button>
                                </div>
                            </div>
                        ) : chapterLoading && proseParagraphs.length === 0 ? (
                            <div className="ns-prose-skel" role="status" aria-label="正文加载中">
                                {Array.from({ length: 8 }, (_, idx) => (
                                    <span
                                        key={idx}
                                        className={`ns-skel ns-skel-line${idx % 3 === 2 ? ' ns-skel-line-short' : ''}`}
                                    />
                                ))}
                            </div>
                        ) : proseParagraphs.length > 0 ? (
                            <>
                                <div className="ns-prose">
                                    {proseParagraphs.map((para, idx) =>
                                        para.isBreak ? (
                                            <p key={idx} className="ns-brk">
                                                · · ·
                                            </p>
                                        ) : (
                                            <p key={idx}>{para.text}</p>
                                        )
                                    )}
                                </div>

                                {/* 已提交定稿章节末尾朱印「定稿」钤印 */}
                                {!isChapterDirty ? (
                                    <div className="ns-endmark">
                                        <span className="ns-stamp">定稿</span>
                                        <small>
                                            {featHash ? `feat ${featHash}` : 'WAL 已提交'}
                                            {stateHash ? ` · state ${stateHash}` : ''}
                                            {!stateHash && chapterDetail?.sha256
                                                ? ` · sha256 ${chapterDetail.sha256.slice(0, 7)}`
                                                : ''}
                                        </small>
                                    </div>
                                ) : null}
                            </>
                        ) : (
                            <div className="ns-muted">
                                当前章节尚无正文内容，请点击上方「单步推进 1 章」或切换其他历史章节。
                            </div>
                        )}

                        {/* 章节上下章快捷导航 */}
                        {!isEditing && (prevChapterSummary || nextChapterSummary) ? (
                            <nav className="ns-chap-nav" aria-label="上下章快捷导航">
                                {prevChapterSummary ? (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-ghost"
                                        onClick={() =>
                                            handleChapterChange(prevChapterSummary.chapterNumber)
                                        }
                                    >
                                        上一章 · {prevChapterSummary.title}
                                    </button>
                                ) : (
                                    <span />
                                )}
                                {nextChapterSummary ? (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-ghost"
                                        onClick={() =>
                                            handleChapterChange(nextChapterSummary.chapterNumber)
                                        }
                                    >
                                        下一章 · {nextChapterSummary.title}
                                    </button>
                                ) : (
                                    <span />
                                )}
                            </nav>
                        ) : null}
                    </article>
                ) : null}

                {viewTab === 'plan' ? (
                    <section className="ns-paper">
                        {parsedPlan ? (
                            <>
                                {/* 原型同款头部：PLANNER · 结构化细纲 + 第 N 章 · 标题 + 4 枚胶囊 */}
                                <header className="ns-plan-head">
                                    <div className="ns-plan-kicker">PLANNER · 结构化细纲</div>
                                    <h2 className="ns-plan-title">
                                        第 {activeChapterNumber} 章 · {parsedPlan.chapterTitle}
                                    </h2>
                                    <div className="ns-plan-meta">
                                        <span className="ns-plan-pill">
                                            timeline_mode <b>{parsedPlan.timelineMode ?? '未提供'}</b>
                                        </span>
                                        <span className="ns-plan-pill">
                                            pov <b>{parsedPlan.povCharacter ?? '未提供'}</b>
                                        </span>
                                        <span className="ns-plan-pill">
                                            target{' '}
                                            <b>
                                                {parsedPlan.targetWordCount
                                                    ? `${parsedPlan.targetWordCount.toLocaleString('zh-CN')} 字`
                                                    : '自适应'}
                                            </b>
                                        </span>
                                        <span className="ns-plan-pill">
                                            ending <b>{parsedPlan.endingBeat}</b>
                                        </span>
                                    </div>
                                </header>

                                {/* 节拍比例条 (.ns-beats + .ns-beats-cap) */}
                                <div>
                                    <div className="ns-beats">
                                        {parsedPlan.beats.map((beat, idx) => (
                                            <div
                                                key={`${beat.label}-${idx}`}
                                                className={`ns-beat ${beat.isSpotlight ? 'eye' : ''}`}
                                                style={{ flex: beat.percent }}
                                                title={`${beat.label} (${beat.percent}%): ${beat.summary}`}
                                            >
                                                <b>
                                                    {beat.label} {beat.percent}%
                                                </b>
                                                <span>{beat.summary}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="ns-beats-cap">
                                        <span>0%</span>
                                        {(() => {
                                            let acc = 0;
                                            return parsedPlan.beats.slice(0, -1).map((beat, idx) => {
                                                acc += beat.percent;
                                                return <span key={idx}>{acc}%</span>;
                                            });
                                        })()}
                                        <span>100%</span>
                                    </div>
                                </div>

                                {/* 结构化键值对表 */}
                                <dl className="ns-plan-kv">
                                    <dt>
                                        视角
                                        <small>pov_character</small>
                                    </dt>
                                    <dd>
                                        {parsedPlan.povCharacter ? (
                                            <span className="ns-actor-pill">
                                                <i
                                                    className="ns-actor-avatar"
                                                    style={{ background: getAvatarColor(parsedPlan.povCharacter) }}
                                                >
                                                    {parsedPlan.povCharacter.slice(0, 1)}
                                                </i>
                                                {parsedPlan.povCharacter}
                                            </span>
                                        ) : (
                                            <span className="ns-muted">未提供</span>
                                        )}
                                    </dd>

                                    <dt>
                                        焦点角色
                                        <small>focus_cast</small>
                                    </dt>
                                    <dd>
                                        {parsedPlan.focusCast.length > 0 ? (
                                            parsedPlan.focusCast.map((actor) => (
                                                <span key={actor} className="ns-actor-pill">
                                                    <i
                                                        className="ns-actor-avatar"
                                                        style={{ background: getAvatarColor(actor) }}
                                                    >
                                                        {actor.slice(0, 1)}
                                                    </i>
                                                    {actor}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="ns-muted">本章无</span>
                                        )}
                                    </dd>

                                    <dt>
                                        背景角色
                                        <small>background_cast</small>
                                    </dt>
                                    <dd>
                                        {parsedPlan.backgroundCast.length > 0 ? (
                                            parsedPlan.backgroundCast.map((actor) => (
                                                <span key={actor} className="ns-actor-pill">
                                                    <i
                                                        className="ns-actor-avatar"
                                                        style={{ background: getAvatarColor(actor) }}
                                                    >
                                                        {actor.slice(0, 1)}
                                                    </i>
                                                    {actor}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="ns-muted">本章无</span>
                                        )}
                                    </dd>

                                    <dt>
                                        戏眼
                                        <small>spotlight</small>
                                    </dt>
                                    <dd className="ns-plan-prose">{parsedPlan.spotlight}</dd>

                                    <dt>
                                        收尾节拍
                                        <small>ending_beat</small>
                                    </dt>
                                    <dd className="ns-plan-prose ns-plan-ending">
                                        <span className="ns-pill ns-pill-brand ns-mono">
                                            {parsedPlan.endingBeat}
                                        </span>
                                        <span>{parsedPlan.endingSummary}</span>
                                    </dd>

                                    <dt>
                                        细纲正文
                                        <small>outline_text</small>
                                    </dt>
                                    <dd className="ns-plan-prose ns-plan-outline">
                                        {parsedPlan.outlineText}
                                    </dd>
                                </dl>
                            </>
                        ) : (
                            <div className="ns-plan-empty">
                                <div className="ns-plan-kicker">PLANNER · 结构化细纲</div>
                                <h2 className="ns-plan-title ns-plan-title-sm">
                                    第 {activeChapterNumber} 章 ·{' '}
                                    {outlineStatus === 'error'
                                        ? '细纲读取失败'
                                        : chapterDetail
                                          ? '历史章节未留存细纲'
                                          : '细纲暂不可用'}
                                </h2>
                                <p className="ns-plan-empty-hint">
                                    {outlineStatus === 'error'
                                        ? '本章已保存的细纲文件损坏或读取失败，正文仍可正常审阅；可重试只读读取，不会触发生成或 Sync。'
                                        : chapterDetail
                                          ? '本章生成时未持久化 Planner 细纲，历史细纲无法回看。后续新生成的章节会随正文一并留存细纲。'
                                          : '当前章节详情尚未加载，加载后可查看已留存的细纲。'}
                                </p>
                                {outlineStatus === 'error' && onRetryChapterDetail ? (
                                    <button
                                        type="button"
                                        className="ns-btn ns-btn-ghost ns-btn-sm"
                                        disabled={chapterLoading}
                                        onClick={onRetryChapterDetail}
                                    >
                                        {chapterLoading ? '正在重试…' : '重试读取细纲'}
                                    </button>
                                ) : null}
                            </div>
                        )}
                    </section>
                ) : null}

                {viewTab === 'diff' ? (
                    <section className="ns-paper">
                        <header className="ns-plan-head">
                            <div className="ns-plan-kicker">修改 DIFF</div>
                            <h2 className="ns-plan-title">门禁 Patch 与人工手改</h2>
                        </header>

                        {diffHunks.length > 0 ? (
                            diffHunks.map((hunk, hunkIdx) => (
                                <div
                                    key={`${hunk.fileName}-${hunk.header}-${hunkIdx}`}
                                    className="ns-hunk"
                                >
                                    {/* Hunk 顶部信息栏 */}
                                    <div className="ns-hunk-head">
                                        <span className="ns-mono ns-hunk-file">{hunk.fileName}</span>
                                        <span className="ns-mono ns-hunk-range">{hunk.header}</span>
                                        <span className="ns-hunk-spacer" />
                                        <span
                                            className={`ns-pill ${isChapterDirty ? 'ns-pill-amber' : 'ns-pill-green'}`}
                                        >
                                            {isChapterDirty ? '人工手改 · 待 Sync' : 'WAL 已对齐'}
                                        </span>
                                    </div>

                                    {/* 带行号与红绿高亮的 Diff 行 */}
                                    <div>
                                        {hunk.rows.map((row, rowIdx) => {
                                            const isDel = row.kind === 'del';
                                            const isAdd = row.kind === 'add';
                                            return (
                                                <div
                                                    key={rowIdx}
                                                    className={`ns-diff-row${isDel ? ' ns-diff-row-del' : isAdd ? ' ns-diff-row-add' : ''}`}
                                                >
                                                    <span className="ns-diff-ln">{row.lineNumber ?? ''}</span>
                                                    <span className="ns-diff-glyph">{row.glyph}</span>
                                                    <span className="ns-diff-text">{row.text || ' '}</span>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {/* Hunk 底部提示与快捷 Sync 对账按钮 */}
                                    <div className="ns-hunk-foot">
                                        <span>
                                            SHA-256 指纹变化 · 新增 +{hunk.addCount} / 删除 -{hunk.delCount} 行 · Sync 后自动对齐 WAL 状态
                                        </span>
                                        <button
                                            type="button"
                                            className="ns-btn ns-btn-ghost ns-btn-sm"
                                            disabled={isBusy || syncingFromDiff}
                                            onClick={() => {
                                                setSyncingFromDiff(true);
                                                void Promise.resolve(handleSync()).finally(() => {
                                                    setSyncingFromDiff(false);
                                                });
                                            }}
                                        >
                                            {activeTask === 'SYNCING' || syncingFromDiff
                                                ? '正在对账…'
                                                : '立即触发 Sync 对账'}
                                        </button>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="ns-diff-clean">
                                <div className="ns-diff-clean-head">
                                    <span className="ns-pill ns-pill-green">WAL 已对齐 · 无未同步差异</span>
                                    <span className="ns-mono ns-diff-clean-file">{chapterFileName}</span>
                                </div>
                                <div className="ns-diff-clean-text">
                                    当前章节正文与 Git HEAD 一致，无待对账的人工手改或门禁 Patch 残留。
                                </div>
                                <div className="ns-mono ns-diff-clean-meta">
                                    <span>WAL: {walPhase}</span>
                                    {featHash ? <span>· feat {featHash}</span> : null}
                                    {stateHash ? <span>· state {stateHash}</span> : null}
                                    {chapterDetail?.sha256 ? (
                                        <span>· sha256 {chapterDetail.sha256.slice(0, 12)}</span>
                                    ) : null}
                                </div>
                            </div>
                        )}
                    </section>
                ) : null}

                {viewTab === 'views' ? (
                    <section className="ns-paper">
                        <div className="ns-paper-head">
                            <div className="ns-subtabs">
                                <button
                                    type="button"
                                    className={`ns-vtab ${materialKind === 'entities' ? 'ns-active' : ''}`}
                                    onClick={() => setMaterialKind('entities')}
                                >
                                    entities/ ({materializedViews?.entities?.length ?? 0})
                                </button>
                                <button
                                    type="button"
                                    className={`ns-vtab ${materialKind === 'horizon' ? 'ns-active' : ''}`}
                                    onClick={() => setMaterialKind('horizon')}
                                >
                                    future_horizon.md
                                </button>
                                <button
                                    type="button"
                                    className={`ns-vtab ${materialKind === 'threads' ? 'ns-active' : ''}`}
                                    onClick={() => setMaterialKind('threads')}
                                >
                                    open_threads.md
                                </button>
                            </div>
                            <span className="ns-pill ns-pill-muted">只读物化视图</span>
                        </div>

                        {materialKind === 'entities' ? (
                            <div className="ns-entities-list">
                                {materializedViews?.coldArchiveCount ? (
                                    <div className="ns-muted ns-mono">
                                        冷档实体数量：{materializedViews.coldArchiveCount}
                                    </div>
                                ) : null}
                                {materializedViews?.entities &&
                                materializedViews.entities.length > 0 ? (
                                    materializedViews.entities.map((entity) => (
                                        <details key={entity.entityId} className="ns-entity-card">
                                            <summary className="ns-entity-summary">
                                                <span>
                                                    <strong>{entity.canonicalName}</strong>{' '}
                                                    <span className="ns-mono ns-muted">
                                                        ({entity.entityId})
                                                    </span>
                                                </span>
                                                {entity.lastSeenChapter !== undefined ? (
                                                    <span className="ns-pill ns-pill-muted ns-mono">
                                                        last: Ch.{entity.lastSeenChapter}
                                                    </span>
                                                ) : null}
                                            </summary>
                                            <pre className="ns-mono ns-pre-block">
                                                {entity.markdown}
                                            </pre>
                                        </details>
                                    ))
                                ) : (
                                    <div className="ns-muted">暂无活跃实体档案。</div>
                                )}
                            </div>
                        ) : null}

                        {materialKind === 'horizon' ? (
                            <pre className="ns-mono ns-pre-block">
                                {materializedViews?.horizonMarkdown || 'world/future_horizon.md 为空。'}
                            </pre>
                        ) : null}

                        {materialKind === 'threads' ? (
                            <pre className="ns-mono ns-pre-block">
                                {materializedViews?.threadsMarkdown || 'world/open_threads.md 为空。'}
                            </pre>
                        ) : null}
                    </section>
                ) : null}
            </div>

            {/* 底部悬浮圆角导演信号栏 */}
            <footer className="ns-composer-dock">
                <div className="ns-composer-wrap">
                    {visibleSignals.length > 0 ? (
                        <div className="ns-queue" aria-label="待消费导演纸条队列">
                            {visibleSignals.map(({ sig, idx }) => (
                                <span key={idx} className="ns-qslip">
                                    <span className="ns-qslip-ty">{sig.type ?? 'SIGNAL'}</span>
                                    <span className="ns-qslip-tx">
                                        {sig.reason ?? sig.raw ?? '待消费信号'}
                                    </span>
                                    <button
                                        type="button"
                                        className="ns-qslip-del"
                                        title="撤回纸条（从 .ops/signals.jsonl 删除）"
                                        aria-label="撤回纸条"
                                        disabled={!onDismissSignal || isBusy}
                                        onClick={() => {
                                            if (onDismissSignal) {
                                                onDismissSignal(idx);
                                            }
                                        }}
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                        </div>
                    ) : null}

                    <div className="ns-composer-box">
                        {isSlashMenuOpen ? (
                            <div
                                className="ns-slash-menu"
                                role="listbox"
                                aria-label="导演信号斜杠指令菜单"
                            >
                                {filteredSlashCommands.map((cmd, idx) => {
                                    const active = idx === clampedSlashIndex;
                                    return (
                                        <button
                                            key={cmd.command}
                                            type="button"
                                            role="option"
                                            aria-selected={active}
                                            className={`ns-slash-item${active ? ' is-active' : ''}`}
                                            onMouseEnter={() => setActiveSlashIndex(idx)}
                                            onMouseDown={(e: React.MouseEvent<HTMLButtonElement>) => {
                                                e.preventDefault();
                                                applySlashCommand(cmd);
                                            }}
                                        >
                                            <span className="ns-slash-cmd">{cmd.command}</span>
                                            <span className="ns-slash-alias">{cmd.alias}</span>
                                            <span className="ns-slash-desc">{cmd.description}</span>
                                            <span className="ns-slash-kind">{cmd.kind}</span>
                                        </button>
                                    );
                                })}
                                <div className="ns-slash-foot">
                                    ↑↓ 选择 · Enter / Tab 确认 · Esc 关闭
                                </div>
                            </div>
                        ) : null}

                        <input
                            ref={signalInputRef}
                            type="text"
                            className="ns-composer-input"
                            value={signalInput}
                            onChange={(e) => {
                                setSignalInput(e.target.value);
                                setSlashMenuDismissed(false);
                                setActiveSlashIndex(0);
                            }}
                            onKeyDown={(e) => {
                                const nativeEvent = (
                                    e as unknown as { nativeEvent?: { isComposing?: boolean } }
                                ).nativeEvent;
                                if (nativeEvent?.isComposing) {
                                    return;
                                }
                                if (isSlashMenuOpen) {
                                    if (e.key === 'ArrowDown') {
                                        e.preventDefault();
                                        setActiveSlashIndex(
                                            (clampedSlashIndex + 1) % filteredSlashCommands.length
                                        );
                                        return;
                                    }
                                    if (e.key === 'ArrowUp') {
                                        e.preventDefault();
                                        setActiveSlashIndex(
                                            (clampedSlashIndex - 1 + filteredSlashCommands.length) %
                                                filteredSlashCommands.length
                                        );
                                        return;
                                    }
                                    if (
                                        (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) ||
                                        e.key === 'Tab'
                                    ) {
                                        e.preventDefault();
                                        const chosen = filteredSlashCommands[clampedSlashIndex];
                                        if (chosen) {
                                            applySlashCommand(chosen);
                                        }
                                        return;
                                    }
                                    if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setSlashMenuDismissed(true);
                                        return;
                                    }
                                }

                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    void handleSignalAction(true);
                                } else if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    void handleSignalAction(false);
                                }
                            }}
                            placeholder="给下一章递一张纸条（输入 / 选择指令，安全点消费即焚）"
                        />

                        <div className="ns-composer-bar">
                            {signalKind !== '导演指令' ? (
                                <span className="ns-kind-pill" title="当前已选导演指令类型">
                                    <span className="ns-kind-pill-label">{signalKind}</span>
                                    <button
                                        type="button"
                                        className="ns-kind-pill-clear"
                                        aria-label="清除指令类型并恢复默认"
                                        title="恢复默认（导演指令）"
                                        onClick={() => {
                                            setSignalKind('导演指令');
                                            signalInputRef.current?.focus();
                                        }}
                                    >
                                        ×
                                    </button>
                                </span>
                            ) : (
                                <span className="ns-composer-hint">
                                    输入 / 选择指令类型 · 安全点消费即焚
                                </span>
                            )}

                            <span className="ns-composer-sp" />

                            <button
                                type="button"
                                className="ns-btn ns-btn-ghost ns-btn-sm"
                                disabled={submittingSignal || !signalInput.trim()}
                                onClick={() => handleSignalAction(false)}
                                title="仅写入队列 (Enter)"
                            >
                                投入队列
                            </button>

                            <button
                                type="button"
                                className="ns-send-circle"
                                disabled={submittingSignal || isBusy}
                                onClick={() => handleSignalAction(true)}
                                title="入队并推进 1 章 (Ctrl + Enter)"
                                aria-label="入队并推进"
                            >
                                ↑
                            </button>
                        </div>
                    </div>

                    <div
                        className={`ns-runtime-status${stopPending && isBusy ? ' ns-runtime-status-waiting' : ''}`}
                        role="status"
                        aria-live="polite"
                    >
                        {runtimeStatus}
                    </div>
                </div>
            </footer>

            {/* 取消编辑确认：复用宿主 Modal（body portal / Escape / 焦点恢复） */}
            <Modal
                open={discardConfirmOpen}
                onClose={() => setDiscardConfirmOpen(false)}
                title="放弃未保存的修改？"
                description={`第 ${activeChapterNumber} 章的编辑尚未保存，取消编辑将丢弃这些修改；已提交的手稿不受影响。`}
                closeLabel="继续编辑"
                className="ns-b-modal-shell ns-guard-modal-shell"
                contentClassName="ns-b-modal-content ns-guard-modal-content"
            >
                <div className="ns-guard-actions">
                    <button
                        type="button"
                        className="ns-btn ns-btn-ghost"
                        data-modal-autofocus=""
                        onClick={() => setDiscardConfirmOpen(false)}
                    >
                        继续编辑
                    </button>
                    <button
                        type="button"
                        className="ns-btn ns-btn-stop"
                        onClick={() => {
                            setDiscardConfirmOpen(false);
                            setDraftBaseline(null);
                            setIsEditing(false);
                            setDraftContent(chapterDetail?.content ?? '');
                        }}
                    >
                        放弃修改
                    </button>
                </div>
            </Modal>
        </main>
    );
};

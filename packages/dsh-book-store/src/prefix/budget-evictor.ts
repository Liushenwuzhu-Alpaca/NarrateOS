import type { RecallSlice } from '../recall/index-recall.js';
import {
    sanitizeLoreForWriter,
    stripWriterRestrictedDirectives
} from '../slicer/view-slicer.js';
import type { EntityEntry, EntityProfile } from '../store/schemas.js';
import type { EvictionLevel, PreviousChapterContext } from './types.js';

const DEFAULT_FALLBACK_TAIL_CHARS = 600;
const WARPED_LINE_RE = /\bWARPED\b/i;
const RECALL_RESTRICTED_RE =
    /\b(?:WARPED|OMNISCIENT_SECRET|SELF_ONLY)\b|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale/i;
const CLEANROOM_ENTRY_RESTRICTED_RE =
    /\b(?:WARPED|OMNISCIENT_SECRET)\b|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale/i;
const VALID_VISIBILITIES = new Set(['PUBLIC', 'SELF_ONLY', 'OMNISCIENT_SECRET', 'READER_KNOWN']);
const UNKNOWN_VIS_TAG_KEY_RE =
    /^(?:vis|visibility|unknown_vis|invalid_vis|raw_vis|rawinvalidvisibility|raw_invalid_visibility)$/i;
const INLINE_VIS_TAG_RE = /(?:^|[\[\s|])(?:vis|visibility)\s*:\s*([^\s|\]]+)/gi;

function hasRestrictedInlineCleanroomVis(line: string): boolean {
    INLINE_VIS_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_VIS_TAG_RE.exec(line)) !== null) {
        const val = (match[1] ?? '').trim().toUpperCase();
        if (!VALID_VISIBILITIES.has(val) || val === 'OMNISCIENT_SECRET') {
            return true;
        }
    }
    return false;
}

/** 基于 tokens_per_char 估算文本 Token 数 */
export function estimateTokens(text: string, tokensPerChar: number): number {
    if (!text) return 0;
    return Math.ceil(text.length * tokensPerChar);
}

/** 整块剥离可能残留的 WARPED / Stage Ceiling 导演禁区及其缩进与引用续行，确保正向槽位表达 */
export function sanitizePositiveText(text: string): string {
    return stripWriterRestrictedDirectives(text) ?? '';
}

function renderLedgerBody(entry: EntityEntry, cleanroomDisplay: boolean): string {
    const pairs = Object.entries(entry.ledger ?? {}).map(([k, v]) => `${k}: ${v}`);
    if (pairs.length > 0) {
        return cleanroomDisplay
            ? `数值账本：${pairs.join('，')}`
            : `[Tracked Numeric Ledger] ${pairs.join(' | ')}`;
    }
    return cleanroomDisplay ? entry.text : `[Tracked Numeric Ledger] ${entry.text}`.trim();
}

/** 格式化单条实体记录 */
export function formatEntryLine(
    entry: EntityEntry,
    cleanroomDisplay = false
): string {
    const bodyText = entry.isNumericLedger
        ? renderLedgerBody(entry, cleanroomDisplay)
        : entry.text;

    let prefix = '';
    if (cleanroomDisplay) {
        const timeParts: string[] = [];
        if (entry.storyDay !== undefined) timeParts.push(`第${entry.storyDay}天`);
        if (entry.chapter !== undefined) timeParts.push(`第${entry.chapter}章`);
        prefix = timeParts.length > 0 ? `（${timeParts.join('，')}）` : '';
    } else {
        const tags: string[] = [];
        if (entry.storyDay !== undefined) tags.push(`day:${entry.storyDay}`);
        if (entry.chapter !== undefined) tags.push(`ch:${entry.chapter}`);
        if (entry.slotKey) tags.push(`slot:${entry.slotKey}`);
        if (entry.visibility) tags.push(`vis:${entry.visibility}`);
        if (entry.owner) tags.push(`owner:${entry.owner}`);
        if (entry.status) tags.push(`status:${entry.status}`);
        prefix = tags.length > 0 ? `[${tags.join(' | ')}] ` : '';
    }

    const extra =
        entry.continuationLines.length > 0 ? `\n  ${entry.continuationLines.join('\n  ')}` : '';
    return `- ${prefix}${bodyText}${extra}`;
}

/** 渲染单个实体的完整或裁剪后档案 */
export function renderEntityProfile(
    profile: EntityProfile,
    options: {
        compactCard: boolean;
        recentBufferLimit?: number | undefined;
        stripWarped: boolean;
        cleanroomDisplay?: boolean | undefined;
    }
): string {
    if (options.stripWarped && profile.metadata.status === 'WARPED') {
        return '';
    }

    const cleanroomDisplay = options.cleanroomDisplay ?? false;

    const filterEntries = (entries: EntityEntry[]): EntityEntry[] =>
        entries.filter((entry) => {
            const allLines = [entry.text, ...entry.continuationLines];
            if (options.stripWarped) {
                if (entry.status === 'WARPED') return false;
                if (allLines.some((line) => WARPED_LINE_RE.test(line))) return false;
                if (
                    entry.extraTags &&
                    Object.entries(entry.extraTags).some(
                        ([k, v]) => WARPED_LINE_RE.test(k) || WARPED_LINE_RE.test(v)
                    )
                ) {
                    return false;
                }
            }
            if (cleanroomDisplay) {
                if (Boolean((entry as { rawInvalidVisibility?: unknown }).rawInvalidVisibility)) {
                    return false;
                }
                if (
                    entry.visibility !== undefined &&
                    !VALID_VISIBILITIES.has(entry.visibility.toUpperCase())
                ) {
                    return false;
                }
                if (entry.visibility?.toUpperCase() === 'OMNISCIENT_SECRET') {
                    return false;
                }
                if (
                    entry.extraTags &&
                    Object.keys(entry.extraTags).some((k) => UNKNOWN_VIS_TAG_KEY_RE.test(k.trim()))
                ) {
                    return false;
                }
                if (
                    allLines.some(
                        (line) =>
                            CLEANROOM_ENTRY_RESTRICTED_RE.test(line) ||
                            hasRestrictedInlineCleanroomVis(line)
                    )
                ) {
                    return false;
                }
            }
            return true;
        });

    const innate = filterEntries(profile.innateLocks);
    const acquired = filterEntries(profile.acquiredState);
    const trajectory = filterEntries(profile.irreversibleTrajectory);
    const recentAll = filterEntries(profile.recentBuffer);

    if (options.compactCard) {
        // 第 2 级降级：background_cast 压缩为单行简卡，保留全部可见先天红线、最新当场状态与完整口癖/声纹标本
        const formatCompactEntry = (item: EntityEntry): string => {
            const baseText = item.isNumericLedger
                ? renderLedgerBody(item, cleanroomDisplay)
                : item.text;
            const cont = item.continuationLines.map((line) => line.trim()).filter(Boolean);
            return cont.length > 0 ? `${baseText} ${cont.join(' ')}` : baseText;
        };

        const innateText =
            innate.length > 0 ? innate.map(formatCompactEntry).join('；') : '无特殊先天红线';
        const latestStateEntry = acquired.at(-1) ?? trajectory.at(-1);
        const stateText = latestStateEntry ? formatCompactEntry(latestStateEntry) : '在场';
        const voiceEntry = recentAll.find((item) => /口癖|声纹/.test(item.text));
        const voiceSuffix = voiceEntry ? ` | 口癖/声纹: ${formatCompactEntry(voiceEntry)}` : '';
        const title = profile.metadata.contextual_titles[0]
            ? `(${profile.metadata.contextual_titles[0]})`
            : '';
        return `- **${profile.metadata.canonical_name}**${title} [${profile.metadata.entity_id}] | 红线: ${innateText} | 当场状态: ${stateText}${voiceSuffix}`;
    }

    const lines: string[] = [
        `### ${profile.metadata.canonical_name} (${profile.metadata.entity_id})`
    ];

    if (innate.length > 0) {
        lines.push(profile.sectionHeadings.innateLocks || '#### 1. Innate Locks');
        for (const item of innate) {
            lines.push(formatEntryLine(item, cleanroomDisplay));
        }
    }

    if (acquired.length > 0) {
        lines.push(profile.sectionHeadings.acquiredState || '#### 2. Acquired State');
        for (const item of acquired) {
            lines.push(formatEntryLine(item, cleanroomDisplay));
        }
    }

    if (trajectory.length > 0) {
        lines.push(
            profile.sectionHeadings.irreversibleTrajectory || '#### 3. Irreversible Trajectory'
        );
        for (const item of trajectory) {
            lines.push(formatEntryLine(item, cleanroomDisplay));
        }
    }

    const recentSlice =
        options.recentBufferLimit === undefined
            ? recentAll
            : options.recentBufferLimit <= 0
              ? []
              : recentAll.slice(-options.recentBufferLimit);

    if (recentSlice.length > 0) {
        lines.push(profile.sectionHeadings.recentBuffer || '#### 4. Recent Buffer');
        for (const item of recentSlice) {
            lines.push(formatEntryLine(item, cleanroomDisplay));
        }
    }

    return lines.join('\n');
}

/** 渲染带时间差信封的 IndexRecall 切片（净室模式下整条校验，命中机密或 WARPED 整条丢弃） */
export function renderRecallSlice(slice: RecallSlice, stripWarped: boolean): string {
    if (stripWarped) {
        const combined = [
            slice.snippet,
            slice.text,
            ...slice.contextBefore,
            ...slice.contextAfter
        ]
            .filter(Boolean)
            .join('\n');
        if (RECALL_RESTRICTED_RE.test(combined)) {
            return '';
        }
    }

    const dayDeltaText = slice.deltaDays !== null ? `，相距${slice.deltaDays}天` : '';
    const content = (slice.snippet || slice.text).trim();
    if (!content) return '';
    return `- [${slice.chapterId} | 相距${slice.deltaChapters}章${dayDeltaText}] ${content}`;
}

/** 动态尾结构化草稿，支持四级无损/有损渲染 */
export interface DynamicTailDraft {
    opsStyleAmendments: string;
    craftPluginsSection: string;
    taskSection: string;
    voiceSampleSection: string;
    futureHorizonSection: string;
    focusCast: EntityProfile[];
    backgroundCast: EntityProfile[];
    dramaticIronyLines: string[];
    memoryWakeupLines: string[];
    parallelBroadcastLines: string[];
    recallSlices: RecallSlice[];
    loreEntries: string[];
    previousChapter?: PreviousChapterContext | undefined;
    fallbackTailChars?: number | undefined;
    stripWarped: boolean;
    cleanroomDisplay?: boolean | undefined;
}

interface PartitionedRecallSlices {
    guaranteedIndices: Set<number>;
    optionalIndices: number[];
}

function partitionRecallSlices(slices: RecallSlice[]): PartitionedRecallSlices {
    const guaranteedIndices = new Set<number>();
    const optionalIndices: number[] = [];
    const seenRequiredEntities = new Set<string>();

    for (let i = 0; i < slices.length; i += 1) {
        const slice = slices[i]!;
        const reqId = slice.requiredEntityId?.trim();
        if (reqId && !seenRequiredEntities.has(reqId)) {
            seenRequiredEntities.add(reqId);
            guaranteedIndices.add(i);
        } else {
            optionalIndices.push(i);
        }
    }

    return { guaranteedIndices, optionalIndices };
}

interface RenderState {
    useWindowForPrevChapter: boolean;
    compactBackgroundCast: boolean;
    maxOptionalRecallCount: number;
    maxLoreCount: number;
}

function renderPreviousChapter(
    prev: PreviousChapterContext | undefined,
    useWindow: boolean,
    stripWarped: boolean,
    fallbackTailChars?: number
): string {
    if (!prev) return '';
    const sanitize = (s: string) => (stripWarped ? sanitizePositiveText(s) : s.trim());
    const tailLimit =
        fallbackTailChars !== undefined && fallbackTailChars > 0
            ? fallbackTailChars
            : DEFAULT_FALLBACK_TAIL_CHARS;

    if (!useWindow && prev.fullText) {
        const clean = sanitize(prev.fullText);
        if (clean) {
            return `## 前章衔接原文 (ch_${String(prev.chapterNumber).padStart(4, '0')})\n${clean}`;
        }
    }

    const parts: string[] = [];
    if (prev.summary) {
        const cleanSummary = sanitize(prev.summary);
        if (cleanSummary) parts.push(`摘要: ${cleanSummary}`);
    }
    if (prev.tailWindow) {
        const cleanWindow = sanitize(prev.tailWindow);
        if (cleanWindow) parts.push(`尾窗: ${cleanWindow}`);
    } else if (prev.fullText) {
        const cleanFull = sanitize(prev.fullText);
        if (cleanFull) {
            const tail =
                cleanFull.length > tailLimit
                    ? `...${cleanFull.slice(-tailLimit)}`
                    : cleanFull;
            parts.push(`尾窗: ${tail}`);
        }
    }

    if (parts.length === 0) return '';
    return `## 前章衔接尾窗 (ch_${String(prev.chapterNumber).padStart(4, '0')})\n${parts.join('\n')}`;
}

function renderDynamicTail(
    draft: DynamicTailDraft,
    state: RenderState,
    partitioned: PartitionedRecallSlices
): string {
    const blocks: string[] = [];
    const cleanroomDisplay = draft.cleanroomDisplay ?? false;
    const pushIfNonEmpty = (text: string) => {
        const clean = draft.stripWarped ? sanitizePositiveText(text) : text.trim();
        if (clean) blocks.push(clean);
    };

    if (draft.opsStyleAmendments) {
        pushIfNonEmpty(`## 运维文风修订 (ops_style_amendments)\n${draft.opsStyleAmendments}`);
    }
    if (draft.craftPluginsSection) {
        pushIfNonEmpty(draft.craftPluginsSection);
    }
    if (draft.taskSection) {
        pushIfNonEmpty(draft.taskSection);
    }
    if (draft.voiceSampleSection) {
        pushIfNonEmpty(draft.voiceSampleSection);
    }
    if (draft.futureHorizonSection) {
        pushIfNonEmpty(draft.futureHorizonSection);
    }

    // 焦点角色（绝不压缩先天红线、核心状态与近期缓冲）
    if (draft.focusCast.length > 0) {
        const focusRendered = draft.focusCast
            .map((p) =>
                renderEntityProfile(p, {
                    compactCard: false,
                    stripWarped: draft.stripWarped,
                    cleanroomDisplay
                })
            )
            .filter(Boolean);
        if (focusRendered.length > 0) {
            blocks.push(`## 焦点角色档案 (focus_cast)\n${focusRendered.join('\n\n')}`);
        }
    }

    // 背景/旁观角色
    if (draft.backgroundCast.length > 0) {
        const bgRendered = draft.backgroundCast
            .map((p) =>
                renderEntityProfile(p, {
                    compactCard: state.compactBackgroundCast,
                    stripWarped: draft.stripWarped,
                    cleanroomDisplay
                })
            )
            .filter(Boolean);
        if (bgRendered.length > 0) {
            blocks.push(`## 旁观角色档案 (background_cast)\n${bgRendered.join('\n\n')}`);
        }
    }

    if (draft.dramaticIronyLines.length > 0) {
        pushIfNonEmpty(`## 戏剧反讽悬念线索 (读者已知)\n${draft.dramaticIronyLines.join('\n')}`);
    }
    if (draft.memoryWakeupLines.length > 0) {
        pushIfNonEmpty(`## 重逢感官唤醒线索\n${draft.memoryWakeupLines.join('\n')}`);
    }
    if (draft.parallelBroadcastLines.length > 0) {
        pushIfNonEmpty(`## 平行时间线全局广播\n${draft.parallelBroadcastLines.join('\n')}`);
    }

    // 召回切片（拆分为必配证据保底切片与可裁剪可选切片，受第 3 级预算裁剪控制）
    const keptOptionalSet = new Set(
        partitioned.optionalIndices.slice(0, state.maxOptionalRecallCount)
    );
    const activeSliceEntries: Array<{ index: number; slice: RecallSlice }> = [];
    for (let i = 0; i < draft.recallSlices.length; i += 1) {
        if (partitioned.guaranteedIndices.has(i) || keptOptionalSet.has(i)) {
            activeSliceEntries.push({ index: i, slice: draft.recallSlices[i]! });
        }
    }

    if (activeSliceEntries.length > 0) {
        const renderedSlices = activeSliceEntries
            .map(({ index, slice }) => {
                const rendered = renderRecallSlice(slice, draft.stripWarped);
                if (partitioned.guaranteedIndices.has(index) && !rendered.trim()) {
                    throw new Error(`写手成对召回证据不可挂载: ${slice.requiredEntityId}`);
                }
                return rendered;
            })
            .filter(Boolean);
        if (renderedSlices.length > 0) {
            blocks.push(`## 跨章召回切片 (IndexRecall)\n${renderedSlices.join('\n')}`);
        }
    }

    // 外围设定词条（受第 4 级预算裁剪控制；写手侧强制执行净室机密清洗）
    const activeLore = draft.loreEntries.slice(0, state.maxLoreCount);
    if (activeLore.length > 0) {
        const loreLines = activeLore
            .map((entry) =>
                draft.stripWarped || cleanroomDisplay
                    ? sanitizeLoreForWriter(entry)
                    : entry.trim()
            )
            .filter(Boolean)
            .map((entry) => `- ${entry}`);
        if (loreLines.length > 0) {
            blocks.push(`## 外围设定词条 (lore_library)\n${loreLines.join('\n')}`);
        }
    }

    // 前章衔接（受第 1 级预算裁剪控制）
    const prevBlock = renderPreviousChapter(
        draft.previousChapter,
        state.useWindowForPrevChapter,
        draft.stripWarped,
        draft.fallbackTailChars
    );
    if (prevBlock) {
        blocks.push(prevBlock);
    }

    return blocks.join('\n\n');
}

export interface EvictionResult {
    dynamicTail: string;
    estimatedTokens: number;
    evictionLevel: EvictionLevel;
    truncated: boolean;
    appliedEvictions: string[];
}

/**
 * 按 writer_token_budget 执行可配四级降级压缩：
 * - budget 为 null/undefined 或总 Token 未超限时无损直通；
 * - 超限时严格按 ① -> ② -> ③ -> ④ 逐级裁剪，绝不触碰 staticPrefixBlocks 与核心红线/核心状态。
 */
export function evictDynamicTailToBudget(
    staticPrefixBlocks: string[],
    draft: DynamicTailDraft,
    tokensPerChar: number,
    budget: number | null | undefined
): EvictionResult {
    const staticJoined = staticPrefixBlocks.join('\n\n');
    const calcTotal = (tail: string): number =>
        estimateTokens(staticJoined, tokensPerChar) + estimateTokens(tail, tokensPerChar);

    const partitioned = partitionRecallSlices(draft.recallSlices);
    const state: RenderState = {
        useWindowForPrevChapter: false,
        compactBackgroundCast: false,
        maxOptionalRecallCount: partitioned.optionalIndices.length,
        maxLoreCount: draft.loreEntries.length
    };

    let dynamicTail = renderDynamicTail(draft, state, partitioned);
    let totalTokens = calcTotal(dynamicTail);

    if (budget === null || budget === undefined || totalTokens <= budget) {
        return {
            dynamicTail,
            estimatedTokens: totalTokens,
            evictionLevel: 0,
            truncated: false,
            appliedEvictions: []
        };
    }

    let evictionLevel: EvictionLevel = 0;
    const appliedEvictions: string[] = [];

    // 第 ① 级：将前章完整原文降级为「上章结构摘要 + 末尾原文窗口」
    if (draft.previousChapter?.fullText) {
        state.useWindowForPrevChapter = true;
        evictionLevel = 1;
        appliedEvictions.push('L1:前章全文降级为尾窗摘要');
        dynamicTail = renderDynamicTail(draft, state, partitioned);
        totalTokens = calcTotal(dynamicTail);
        if (totalTokens <= budget) {
            return {
                dynamicTail,
                estimatedTokens: totalTokens,
                evictionLevel,
                truncated: true,
                appliedEvictions
            };
        }
    }

    // 第 ② 级：将 background_cast 压缩为单行简卡（不触碰 loreEntries）
    if (draft.backgroundCast.length > 0) {
        state.compactBackgroundCast = true;
        evictionLevel = 2;
        appliedEvictions.push('L2:background_cast压缩为单行简卡');
        dynamicTail = renderDynamicTail(draft, state, partitioned);
        totalTokens = calcTotal(dynamicTail);
        if (totalTokens <= budget) {
            return {
                dynamicTail,
                estimatedTokens: totalTokens,
                evictionLevel,
                truncated: true,
                appliedEvictions
            };
        }
    }

    // 第 ③ 级：逐条缩减可选 IndexRecall 回表切片（保底切片绝不淘汰，未真实裁掉可选切片时不记 L3）
    if (state.maxOptionalRecallCount > 0) {
        while (state.maxOptionalRecallCount > 0 && totalTokens > budget) {
            state.maxOptionalRecallCount -= 1;
            dynamicTail = renderDynamicTail(draft, state, partitioned);
            totalTokens = calcTotal(dynamicTail);
        }
        if (state.maxOptionalRecallCount < partitioned.optionalIndices.length) {
            evictionLevel = 3;
            const remainingTotal =
                partitioned.guaranteedIndices.size + state.maxOptionalRecallCount;
            appliedEvictions.push(
                `L3:缩减可选召回切片至${state.maxOptionalRecallCount}条(总计${remainingTotal}条)`
            );
        }
        if (totalTokens <= budget) {
            return {
                dynamicTail,
                estimatedTokens: totalTokens,
                evictionLevel,
                truncated: true,
                appliedEvictions
            };
        }
    }

    // 第 ④ 级：逐条缩减 lore_library 外围设定词条数量直至达标或清空，绝不触碰静态前缀、先天红线与焦点角色核心状态
    if (state.maxLoreCount > 0) {
        evictionLevel = 4;
        while (state.maxLoreCount > 0 && totalTokens > budget) {
            state.maxLoreCount -= 1;
            dynamicTail = renderDynamicTail(draft, state, partitioned);
            totalTokens = calcTotal(dynamicTail);
        }
        appliedEvictions.push(`L4:缩减外围设定至${state.maxLoreCount}条`);
        if (totalTokens <= budget) {
            return {
                dynamicTail,
                estimatedTokens: totalTokens,
                evictionLevel,
                truncated: true,
                appliedEvictions
            };
        }
    }

    throw new Error(`写手预算无法满足: 必需上下文估算 ${totalTokens} tokens，预算 ${budget} tokens`);
}

import type { RecallSlice } from '../recall/index-recall.js';
import type { EntityEntry, EntityProfile } from '../store/schemas.js';
import type { EvictionLevel, PreviousChapterContext } from './types.js';

const DEFAULT_FALLBACK_TAIL_CHARS = 600;
const WARPED_LINE_RE = /\bWARPED\b/i;

/** 基于 tokens_per_char 估算文本 Token 数 */
export function estimateTokens(text: string, tokensPerChar: number): number {
    if (!text) return 0;
    return Math.ceil(text.length * tokensPerChar);
}

/** 剥离可能残留的 WARPED 废止词条与标记，确保正向槽位表达 */
export function sanitizePositiveText(text: string): string {
    const lines = text.split('\n');
    const kept = lines.filter((line) => !WARPED_LINE_RE.test(line));
    return kept.join('\n').trim();
}

/** 格式化单条实体记录 */
function formatEntryLine(entry: EntityEntry): string {
    const tags: string[] = [];
    if (entry.storyDay !== undefined) tags.push(`day:${entry.storyDay}`);
    if (entry.chapter !== undefined) tags.push(`ch:${entry.chapter}`);
    if (entry.slotKey) tags.push(`slot:${entry.slotKey}`);
    const prefix = tags.length > 0 ? `[${tags.join(' | ')}] ` : '';
    const extra = entry.continuationLines.length > 0 ? `\n  ${entry.continuationLines.join('\n  ')}` : '';
    return `- ${prefix}${entry.text}${extra}`;
}

/** 渲染单个实体的完整或裁剪后档案 */
export function renderEntityProfile(
    profile: EntityProfile,
    options: {
        compactCard: boolean;
        recentBufferLimit?: number | undefined;
        stripWarped: boolean;
    }
): string {
    if (options.stripWarped && profile.metadata.status === 'WARPED') {
        return '';
    }

    const filterEntries = (entries: EntityEntry[]): EntityEntry[] =>
        entries.filter((entry) => {
            if (options.stripWarped && entry.status === 'WARPED') return false;
            if (options.stripWarped && WARPED_LINE_RE.test(entry.text)) return false;
            return true;
        });

    const innate = filterEntries(profile.innateLocks);
    const acquired = filterEntries(profile.acquiredState);
    const trajectory = filterEntries(profile.irreversibleTrajectory);
    const recentAll = filterEntries(profile.recentBuffer);

    if (options.compactCard) {
        // 第 2 级降级：background_cast 压缩为单行简卡，仅留姓名、先天物理红线、当场位置/状态与口癖/声纹
        const innateText = innate[0]?.text ?? '无特殊先天红线';
        const stateText = acquired[0]?.text ?? trajectory[0]?.text ?? '在场';
        const voiceEntry = recentAll.find((item) => /口癖|声纹/.test(item.text));
        const voiceSuffix = voiceEntry ? ` | 口癖/声纹: ${voiceEntry.text}` : '';
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
        for (const item of innate) lines.push(formatEntryLine(item));
    }

    if (acquired.length > 0) {
        lines.push(profile.sectionHeadings.acquiredState || '#### 2. Acquired State');
        for (const item of acquired) lines.push(formatEntryLine(item));
    }

    if (trajectory.length > 0) {
        lines.push(profile.sectionHeadings.irreversibleTrajectory || '#### 3. Irreversible Trajectory');
        for (const item of trajectory) lines.push(formatEntryLine(item));
    }

    const recentSlice =
        options.recentBufferLimit === undefined
            ? recentAll
            : options.recentBufferLimit <= 0
              ? []
              : recentAll.slice(-options.recentBufferLimit);

    if (recentSlice.length > 0) {
        lines.push(profile.sectionHeadings.recentBuffer || '#### 4. Recent Buffer');
        for (const item of recentSlice) lines.push(formatEntryLine(item));
    }

    return lines.join('\n');
}

/** 渲染带时间差信封的 IndexRecall 切片 */
export function renderRecallSlice(slice: RecallSlice, stripWarped: boolean): string {
    const dayDeltaText =
        slice.deltaDays !== null ? `，相距${slice.deltaDays}天` : '';
    const rawContent = slice.snippet || slice.text;
    const content = stripWarped ? sanitizePositiveText(rawContent) : rawContent;
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
    stripWarped: boolean;
}

interface RenderState {
    useWindowForPrevChapter: boolean;
    compactBackgroundCast: boolean;
    maxRecallCount: number;
    maxLoreCount: number;
}

function renderPreviousChapter(
    prev: PreviousChapterContext | undefined,
    useWindow: boolean,
    stripWarped: boolean
): string {
    if (!prev) return '';
    const sanitize = (s: string) => (stripWarped ? sanitizePositiveText(s) : s.trim());

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
                cleanFull.length > DEFAULT_FALLBACK_TAIL_CHARS
                    ? `...${cleanFull.slice(-DEFAULT_FALLBACK_TAIL_CHARS)}`
                    : cleanFull;
            parts.push(`尾窗: ${tail}`);
        }
    }

    if (parts.length === 0) return '';
    return `## 前章衔接尾窗 (ch_${String(prev.chapterNumber).padStart(4, '0')})\n${parts.join('\n')}`;
}

function renderDynamicTail(draft: DynamicTailDraft, state: RenderState): string {
    const blocks: string[] = [];
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
                    stripWarped: draft.stripWarped
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
                    stripWarped: draft.stripWarped
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

    // 召回切片（受第 3 级预算裁剪控制）
    const activeSlices = draft.recallSlices.filter((slice, index) => slice.requiredEntityId || index < state.maxRecallCount);
    if (activeSlices.length > 0) {
        const renderedSlices = activeSlices.map((slice) => {
            const rendered = renderRecallSlice(slice, draft.stripWarped);
            if (slice.requiredEntityId && !rendered.trim()) {
                throw new Error(`写手成对召回证据不可挂载: ${slice.requiredEntityId}`);
            }
            return rendered;
        }).filter(Boolean);
        if (renderedSlices.length > 0) {
            blocks.push(`## 跨章召回切片 (IndexRecall)\n${renderedSlices.join('\n')}`);
        }
    }

    // 外围设定词条（受第 4 级预算裁剪控制）
    const activeLore = draft.loreEntries.slice(0, state.maxLoreCount);
    if (activeLore.length > 0) {
        const loreLines = activeLore
            .map((entry) => (draft.stripWarped ? sanitizePositiveText(entry) : entry.trim()))
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
        draft.stripWarped
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

    const state: RenderState = {
        useWindowForPrevChapter: false,
        compactBackgroundCast: false,
        maxRecallCount: draft.recallSlices.length,
        maxLoreCount: draft.loreEntries.length
    };

    let dynamicTail = renderDynamicTail(draft, state);
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
        dynamicTail = renderDynamicTail(draft, state);
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
        dynamicTail = renderDynamicTail(draft, state);
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

    // 第 ③ 级：逐条缩减 IndexRecall 回表切片数量直至达标或清空（不触碰 loreEntries）
    if (state.maxRecallCount > 0) {
        evictionLevel = 3;
        while (state.maxRecallCount > 0 && totalTokens > budget) {
            state.maxRecallCount -= 1;
            dynamicTail = renderDynamicTail(draft, state);
            totalTokens = calcTotal(dynamicTail);
        }
        appliedEvictions.push(`L3:缩减召回切片至${state.maxRecallCount}条`);
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
            dynamicTail = renderDynamicTail(draft, state);
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

    return {
        dynamicTail,
        estimatedTokens: totalTokens,
        evictionLevel,
        truncated: true,
        appliedEvictions
    };
}

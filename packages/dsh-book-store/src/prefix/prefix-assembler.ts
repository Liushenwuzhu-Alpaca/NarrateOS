import { hashStaticPrefix, type CleanroomRequest } from '../ports/llm.js';
import { sanitizeLoreForWriter, type SlicedView } from '../slicer/view-slicer.js';
import type { EntityProfile } from '../store/schemas.js';
import {
    evictDynamicTailToBudget,
    sanitizePositiveText,
    type DynamicTailDraft
} from './budget-evictor.js';
import { resolveCraftPluginsSection } from './craft-plugins.js';
import type {
    AssembleResult,
    PlannerAssembleInput,
    StaticPrefixInput,
    VoiceSample,
    VoiceSamplePool,
    WriterAssembleInput
} from './types.js';
import { sampleVoiceLru } from './voice-sampler.js';

/**
 * 构建同卷零字节变动的静态前缀块列表：
 * - Planner 与 Writer 共享此函数，保证同卷内字节与 hashStaticPrefix() 100% 一致；
 * - 未传 systemBaseline 时不注入硬编码单轮冲突话术；
 * - 绝不混入单章动态状态（如章号、日期、POV、声纹标本、临时缓冲等）。
 */
export function buildStaticPrefixBlocks(input: StaticPrefixInput): string[] {
    const blocks: string[] = [];

    const baselineParts: string[] = [];
    if (input.systemBaseline) {
        const cleanBaseline = sanitizePositiveText(input.systemBaseline);
        if (cleanBaseline) {
            baselineParts.push(`## 净室系统基准 (Volume ${input.volumeNumber})`, cleanBaseline);
        }
    }
    if (input.staticBaseAndVoice) {
        const cleanVoice = sanitizePositiveText(input.staticBaseAndVoice);
        if (cleanVoice) {
            if (baselineParts.length === 0) {
                baselineParts.push(`## 净室系统基准 (Volume ${input.volumeNumber})`);
            }
            baselineParts.push(`### 抽象文风纪律锁\n${cleanVoice}`);
        }
    }
    if (baselineParts.length > 0) {
        blocks.push(baselineParts.join('\n\n'));
    }

    const worldParts: string[] = [];
    if (input.currentArcEnvelope) {
        const cleanArc = sanitizePositiveText(input.currentArcEnvelope);
        if (cleanArc) worldParts.push(`## 当前卷域包络\n${cleanArc}`);
    }
    if (input.worldStaticBaseline) {
        const cleanWorld = sanitizePositiveText(input.worldStaticBaseline);
        if (cleanWorld) worldParts.push(`## 世界静态基线\n${cleanWorld}`);
    }
    if (input.sealedLoreSummaries && input.sealedLoreSummaries.length > 0) {
        const cleanLore = input.sealedLoreSummaries
            .map((item) => sanitizePositiveText(item))
            .filter(Boolean);
        if (cleanLore.length > 0) {
            worldParts.push(`## 已封卷静态背景\n${cleanLore.map((s) => `- ${s}`).join('\n')}`);
        }
    }
    if (worldParts.length > 0) {
        blocks.push(worldParts.join('\n\n'));
    }

    if (input.positiveConstraints && input.positiveConstraints.length > 0) {
        const cleanConstraints = input.positiveConstraints
            .map((item) => sanitizePositiveText(item))
            .filter(Boolean);
        if (cleanConstraints.length > 0) {
            blocks.push(
                `## 正向槽位表达约束\n${cleanConstraints.map((c) => `- ${c}`).join('\n')}`
            );
        }
    }

    return blocks;
}

/** 根据 focusCastIds / backgroundCastIds / povCharIds 切分焦点与旁观角色（未列入 focus_cast 者全部兜底归入 backgroundCast） */
function partitionCast(
    slicedView: SlicedView,
    focusCastIds?: string[],
    backgroundCastIds?: string[]
): { focusCast: EntityProfile[]; backgroundCast: EntityProfile[] } {
    const allEntities = Object.values(slicedView.entities);
    const focusSet = new Set(
        focusCastIds && focusCastIds.length > 0 ? focusCastIds : slicedView.povCharIds
    );
    const bgOrder = new Map<string, number>();
    if (backgroundCastIds) {
        backgroundCastIds.forEach((id, index) => {
            if (!bgOrder.has(id)) {
                bgOrder.set(id, index);
            }
        });
    }

    const focusCast: EntityProfile[] = [];
    const explicitBg: EntityProfile[] = [];
    const fallbackBg: EntityProfile[] = [];

    for (const profile of allEntities) {
        const id = profile.metadata.entity_id;
        if (focusSet.has(id)) {
            focusCast.push(profile);
        } else if (bgOrder.has(id)) {
            explicitBg.push(profile);
        } else {
            fallbackBg.push(profile);
        }
    }

    explicitBg.sort(
        (a, b) => (bgOrder.get(a.metadata.entity_id) ?? 0) - (bgOrder.get(b.metadata.entity_id) ?? 0)
    );

    return { focusCast, backgroundCast: [...explicitBg, ...fallbackBg] };
}

/**
 * 双池前缀装配器（PrefixAssembler）
 * - 保证同卷内 Planner 与 Writer 静态前缀字节级 100% 一致；
 * - 内聚 voice_samples.yaml LRU 防连挂抽样；
 * - 拼装动态尾部并确保正向槽位表达（零 WARPED 残留）；
 * - 按 writer_token_budget 执行可配四级降级压缩。
 */
export class PrefixAssembler {
    /** 拼装 Planner 净室请求 */
    assemblePlannerRequest(input: PlannerAssembleInput): AssembleResult {
        const staticPrefixBlocks = buildStaticPrefixBlocks(input.staticPrefix);
        const { focusCast, backgroundCast } = partitionCast(
            input.slicedView,
            input.focusCastIds,
            input.backgroundCastIds
        );

        const craftPluginsSection = resolveCraftPluginsSection(
            input.config.craft_plugins,
            'planner',
            input.customPlugins
        );

        const taskSection = [
            `## 本章规划目标 (ch_${String(input.slicedView.currentCh).padStart(4, '0')} | story_day: ${input.slicedView.targetDay} | mode: ${input.slicedView.timelineMode})`,
            input.chapterGoal.trim()
        ].join('\n');

        const futureHorizonSection = input.futureHorizon?.trim()
            ? `## 远景地平线 (future_horizon)\n${input.futureHorizon.trim()}`
            : '';

        const draft: DynamicTailDraft = {
            opsStyleAmendments: input.opsStyleAmendments?.trim() ?? '',
            craftPluginsSection,
            taskSection,
            voiceSampleSection: '',
            futureHorizonSection,
            focusCast,
            backgroundCast,
            dramaticIronyLines: input.slicedView.dramaticIronyHints.map((h) => `- ${h.formattedHint}`),
            memoryWakeupLines: input.slicedView.memoryWakeupHints.map((h) => `- ${h.formattedHint}`),
            parallelBroadcastLines: input.slicedView.parallelBroadcast.map((b) => `- ${b.text}`),
            recallSlices: input.recallSlices ?? [],
            loreEntries: input.loreEntries ?? [],
            previousChapter: input.previousChapter,
            stripWarped: false,
            cleanroomDisplay: false
        };

        const eviction = evictDynamicTailToBudget(
            staticPrefixBlocks,
            draft,
            input.config.tokens_per_char,
            null
        );

        const request: CleanroomRequest = {
            pool: input.pool ?? 'strong_creative',
            staticPrefixBlocks,
            dynamicTail: eviction.dynamicTail
        };
        if (input.temperature !== undefined) request.temperature = input.temperature;
        if (input.maxTokens !== undefined) request.maxTokens = input.maxTokens;
        if (input.reasoningEffort !== undefined) request.reasoningEffort = input.reasoningEffort;

        return {
            request,
            diagnostics: {
                estimatedTokens: eviction.estimatedTokens,
                budget: null,
                evictionLevel: eviction.evictionLevel,
                truncated: eviction.truncated,
                appliedEvictions: eviction.appliedEvictions,
                selectedVoiceSample: null,
                staticPrefixHash: hashStaticPrefix(staticPrefixBlocks)
            }
        };
    }

    /** 拼装 Prose Writer 净室请求（强制 writer 视图守卫、正向槽位、零 WARPED 残留、声纹 LRU 与四级预算降级） */
    assembleWriterRequest(input: WriterAssembleInput): AssembleResult {
        if (input.slicedView.forRole !== 'writer') {
            throw new Error(
                `assembleWriterRequest 仅接受 forRole === 'writer' 的净室裁剪视图，当前收到: ${input.slicedView.forRole}`
            );
        }

        const staticPrefixBlocks = buildStaticPrefixBlocks(input.staticPrefix);
        const { focusCast, backgroundCast } = partitionCast(
            input.slicedView,
            input.focusCastIds,
            input.backgroundCastIds
        );

        let selectedVoiceSample: VoiceSample | null = null;
        let updatedVoicePool: VoiceSamplePool | undefined;
        if (input.voicePool) {
            const sampled = sampleVoiceLru(input.voicePool, {
                currentCh: input.slicedView.currentCh,
                preferredTag: input.preferredVoiceTag
            });
            selectedVoiceSample = sampled.sample;
            updatedVoicePool = sampled.updatedPool;
        }

        const voiceSampleSection = selectedVoiceSample
            ? `## 当章句法声纹参考标本 [${selectedVoiceSample.tag}]\n> ${sanitizePositiveText(selectedVoiceSample.text)}`
            : '';

        const craftPluginsSection = resolveCraftPluginsSection(
            input.config.craft_plugins,
            'writer',
            input.customPlugins
        );

        const cleanOutline = sanitizePositiveText(input.outline);
        const taskSection = [
            `## 本章执笔细纲 (ch_${String(input.slicedView.currentCh).padStart(4, '0')} | story_day: ${input.slicedView.targetDay} | mode: ${input.slicedView.timelineMode})`,
            cleanOutline
        ].join('\n');

        const cleanLoreEntries = (input.loreEntries ?? [])
            .map((entry) => sanitizeLoreForWriter(entry))
            .filter((entry) => entry.length > 0);

        const draft: DynamicTailDraft = {
            opsStyleAmendments: input.opsStyleAmendments?.trim() ?? '',
            craftPluginsSection,
            taskSection,
            voiceSampleSection,
            futureHorizonSection: '',
            focusCast,
            backgroundCast,
            dramaticIronyLines: input.slicedView.dramaticIronyHints.map((h) => `- ${h.formattedHint}`),
            memoryWakeupLines: input.slicedView.memoryWakeupHints.map((h) => `- ${h.formattedHint}`),
            parallelBroadcastLines: input.slicedView.parallelBroadcast.map((b) => `- ${b.text}`),
            recallSlices: input.recallSlices ?? [],
            loreEntries: cleanLoreEntries,
            previousChapter: input.previousChapter,
            stripWarped: true,
            cleanroomDisplay: true
        };

        const budget = input.config.writer_token_budget ?? null;
        const eviction = evictDynamicTailToBudget(
            staticPrefixBlocks,
            draft,
            input.config.tokens_per_char,
            budget
        );

        const request: CleanroomRequest = {
            pool: input.pool ?? 'strong_creative',
            staticPrefixBlocks,
            dynamicTail: eviction.dynamicTail
        };
        if (input.temperature !== undefined) request.temperature = input.temperature;
        if (input.maxTokens !== undefined) request.maxTokens = input.maxTokens;
        if (input.reasoningEffort !== undefined) request.reasoningEffort = input.reasoningEffort;

        return {
            request,
            diagnostics: {
                estimatedTokens: eviction.estimatedTokens,
                budget,
                evictionLevel: eviction.evictionLevel,
                truncated: eviction.truncated,
                appliedEvictions: eviction.appliedEvictions,
                selectedVoiceSample,
                updatedVoicePool,
                staticPrefixHash: hashStaticPrefix(staticPrefixBlocks)
            }
        };
    }
}

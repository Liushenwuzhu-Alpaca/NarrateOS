import type { CleanroomRequest, LlmPool } from '../ports/llm.js';
import type { RecallSlice } from '../recall/index-recall.js';
import type { SlicedView } from '../slicer/view-slicer.js';
import type { BookConfig } from '../store/schemas.js';

/** 声纹标本单条记录 */
export interface VoiceSample {
    id: string;
    tag: string;
    text: string;
    last_used_ch: number;
    use_count?: number | undefined;
}

/** 声纹标本池结构 (voice_samples.yaml) */
export interface VoiceSamplePool {
    samples: VoiceSample[];
}

/** 声纹 LRU 抽样参数 */
export interface VoiceSampleOptions {
    currentCh: number;
    preferredTag?: string | undefined;
}

/** 声纹 LRU 抽样结果 */
export interface VoiceSampleResult {
    sample: VoiceSample | null;
    updatedPool: VoiceSamplePool;
}

/** 同卷静态前缀输入（整卷零字节变动） */
export interface StaticPrefixInput {
    volumeNumber: number;
    systemBaseline?: string | undefined;
    staticBaseAndVoice?: string | undefined;
    currentArcEnvelope?: string | undefined;
    worldStaticBaseline?: string | undefined;
    sealedLoreSummaries?: string[] | undefined;
    positiveConstraints?: string[] | undefined;
}

/** 前章衔接上下文 */
export interface PreviousChapterContext {
    chapterNumber: number;
    fullText?: string | undefined;
    summary?: string | undefined;
    tailWindow?: string | undefined;
}

/** Craft 插件定义 */
export interface CraftPluginDefinition {
    id: string;
    title: string;
    promptText: string;
    /** 适用角色列表，默认仅 ['planner'] */
    applicable_roles?: Array<'planner' | 'writer'> | undefined;
}

/** Planner 净室请求装配输入 */
export interface PlannerAssembleInput {
    config: BookConfig;
    staticPrefix: StaticPrefixInput;
    slicedView: SlicedView;
    chapterGoal: string;
    focusCastIds?: string[] | undefined;
    backgroundCastIds?: string[] | undefined;
    opsStyleAmendments?: string | undefined;
    futureHorizon?: string | undefined;
    recallSlices?: RecallSlice[] | undefined;
    loreEntries?: string[] | undefined;
    previousChapter?: PreviousChapterContext | undefined;
    customPlugins?: Record<string, CraftPluginDefinition> | undefined;
    pool?: LlmPool | undefined;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
}

/** Writer 净室请求装配输入 */
export interface WriterAssembleInput {
    config: BookConfig;
    staticPrefix: StaticPrefixInput;
    slicedView: SlicedView;
    outline: string;
    focusCastIds?: string[] | undefined;
    backgroundCastIds?: string[] | undefined;
    opsStyleAmendments?: string | undefined;
    recallSlices?: RecallSlice[] | undefined;
    loreEntries?: string[] | undefined;
    previousChapter?: PreviousChapterContext | undefined;
    voicePool?: VoiceSamplePool | undefined;
    preferredVoiceTag?: string | undefined;
    customPlugins?: Record<string, CraftPluginDefinition> | undefined;
    pool?: LlmPool | undefined;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
}

/** 预算降级级别：0 为无损直通，1-4 对应四级逐级裁剪 */
export type EvictionLevel = 0 | 1 | 2 | 3 | 4;

/** 装配诊断遥测 */
export interface AssembleDiagnostics {
    estimatedTokens: number;
    budget: number | null;
    evictionLevel: EvictionLevel;
    truncated: boolean;
    appliedEvictions: string[];
    selectedVoiceSample: VoiceSample | null;
    updatedVoicePool?: VoiceSamplePool | undefined;
    staticPrefixHash: string;
}

/** PrefixAssembler 装配输出 */
export interface AssembleResult {
    request: CleanroomRequest;
    diagnostics: AssembleDiagnostics;
}

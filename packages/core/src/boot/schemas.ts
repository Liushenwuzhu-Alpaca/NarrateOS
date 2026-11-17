import { z } from 'zod';
import { EntryVisibilitySchema } from '../store/schemas.js';

/** 开书编译模式：原创冷启动 / 同人设定包切分 */
export type BootMode = 'original' | 'fanfic';

/** Phase 1B 切口拍板策略：auto_best 自动择优 / interactive 人工指定 */
export type BootDecisionMode = 'auto_best' | 'interactive';

/** 三维正交叙事坐标 Schema */
export const NarrativeTopologySchema = z.enum([
    'CONTINUOUS_ESCALATION',
    'EPISODIC_ANTHOLOGY',
    'MULTI_POV_TAPESTRY'
]);

export const TensionDriverSchema = z.enum([
    'EPISTEMIC_GAP',
    'GOAL_FRICTION',
    'RELATIONAL_POLARITY'
]);

export const EndgameModeSchema = z.enum([
    'CONVERGENT_CLOSURE',
    'OPEN_ROLLING'
]);

export const NarrativeCoordinatesSchema = z.object({
    topology: NarrativeTopologySchema,
    tensionDrivers: z.array(TensionDriverSchema).min(1),
    endgame: EndgameModeSchema
});

export type NarrativeCoordinates = z.infer<typeof NarrativeCoordinatesSchema>;

/** Phase 1A 候选切口 Schema */
export const PitchCandidateSchema = z.object({
    index: z.number().int().min(0),
    title: z.string().min(1),
    logline: z.string().min(1),
    coreHook: z.string().min(1),
    antiClicheNote: z.string().min(1)
});

export type PitchCandidate = z.infer<typeof PitchCandidateSchema>;

export const Phase1PitchProposalSchema = z.object({
    coordinates: NarrativeCoordinatesSchema,
    excludedCliches: z.array(z.string().min(1)).min(1),
    pitches: z.array(PitchCandidateSchema).min(1)
});

export type Phase1PitchProposal = z.infer<typeof Phase1PitchProposalSchema>;

/** Phase 1B 自动择优输出 Schema */
export const Phase1AutoSelectSchema = z.object({
    selectedIndex: z.number().int().min(0),
    rationale: z.string().min(1)
});

export type Phase1AutoSelect = z.infer<typeof Phase1AutoSelectSchema>;

/** Phase 1 纯文本深推演输出结构 */
export interface Phase1PitchAndBibleResult {
    coordinates: NarrativeCoordinates;
    excludedCliches: string[];
    pitches: PitchCandidate[];
    selectedPitchIndex: number;
    selectedPitch: PitchCandidate;
    architectureBibleMarkdown: string;
}

/** 开书编译输入参数 */
export interface BootBookInput {
    bookRoot: string;
    bookSlug: string;
    title: string;
    povCharacter: string;
    mode: BootMode;
    premiseOrSeed?: string | undefined;
    sourceMaterial?: string | undefined;
    t0Anchor?: string | undefined;
    calibrationSampleText?: string | undefined;
    writerTokenBudget?: number | null | undefined;
    maxAutoRollbackChapters?: number | undefined;
    craftPlugins?: string[] | undefined;
    modelRouting?: Record<string, string> | undefined;
    /** Phase 1B 切口拍板模式，默认 auto_best */
    decisionMode?: BootDecisionMode | undefined;
    /** interactive 模式下人工选定的候选切口索引 (0-based) */
    selectedPitchIndex?: number | undefined;
    /** 门禁最低实体数配额（original 模式默认 4，测试小夹具可放宽） */
    minEntityCount?: number | undefined;
    /** 门禁最低卷数配额（original 模式默认 2，测试小夹具可放宽） */
    minVolumeCount?: number | undefined;
    /** 同人盲审最低召回率，默认 0.98 */
    minRecallRate?: number | undefined;
    /** 盲审不达标时的补充重试次数，默认 1 */
    maxAuditRetries?: number | undefined;
}

/** 模型输出的开书编译结构化 Schema */
export const CompiledEntitySchema = z.object({
    entityId: z.string().regex(/^(char|item)_[a-zA-Z0-9_]+$/),
    canonicalName: z.string().min(1),
    uniqueAliases: z.array(z.string()).default([]),
    contextualTitles: z.array(z.string()).default([]),
    innateLocks: z
        .array(
            z.object({
                visibility: EntryVisibilitySchema.default('PUBLIC'),
                text: z.string().min(1)
            })
        )
        .default([]),
    acquiredState: z
        .array(
            z.object({
                storyDay: z.number().int().default(0),
                visibility: EntryVisibilitySchema.default('PUBLIC'),
                slotKey: z.string().optional(),
                text: z.string().min(1)
            })
        )
        .default([]),
    irreversibleTrajectory: z
        .array(
            z.object({
                storyDay: z.number().int().default(0),
                text: z.string().min(1)
            })
        )
        .default([]),
    recentBuffer: z
        .array(
            z.object({
                storyDay: z.number().int().optional(),
                text: z.string().min(1)
            })
        )
        .default([])
});

export type CompiledEntity = z.infer<typeof CompiledEntitySchema>;

export const CompiledLoreEntrySchema = z.object({
    id: z.string().regex(/^lore_[a-zA-Z0-9_]+$/),
    title: z.string().min(1),
    summary: z.string().min(1),
    content: z.string().min(1)
});

export type CompiledLoreEntry = z.infer<typeof CompiledLoreEntrySchema>;

export const BootCompilePayloadSchema = z.object({
    worldSummary: z.string().min(1),
    staticBaseAndVoice: z.string().min(1),
    currentArcEnvelope: z.string().min(1),
    l0SagasMarkdown: z
        .string()
        .min(1)
        .default('# L0 纪元折叠总表\n\n<!-- 每满 10 卷封存一纪元 -->'),
    l1VolumesMarkdown: z
        .string()
        .min(1)
        .default('# L1 活跃卷级总表\n\n- vol_01: 第一卷 (story_day: 0..)'),
    voiceSamples: z
        .array(
            z.object({
                tag: z.string().min(1),
                sample: z.string().min(1)
            })
        )
        .default([]),
    openThreads: z
        .array(
            z.object({
                threadId: z.string().min(1),
                title: z.string().min(1),
                wakeupCondition: z.string().min(1)
            })
        )
        .default([]),
    futureHorizonEvents: z
        .array(
            z.object({
                eventId: z.string().min(1),
                storyDay: z.number().int().positive(),
                premise: z.string().min(1),
                description: z.string().min(1)
            })
        )
        .default([]),
    loreEntries: z.array(CompiledLoreEntrySchema).default([]).refine(
        (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
        'loreEntries 中的 id 必须唯一'
    ),
    entities: z.array(CompiledEntitySchema).min(1).refine(
        (entities) => new Set(entities.map((entity) => entity.entityId)).size === entities.length,
        'entities 中的 entityId 必须唯一'
    )
});

export type BootCompilePayload = z.infer<typeof BootCompilePayloadSchema>;

/** 异构盲审报告 Schema */
export const T0LeakItemSchema = z.object({
    entityId: z.string(),
    field: z.string(),
    excerpt: z.string(),
    reason: z.string()
});

export type T0LeakItem = z.infer<typeof T0LeakItemSchema>;

export const FanficAuditReportSchema = z.object({
    recallRate: z.number().min(0).max(1).default(1),
    missingFacts: z.array(z.string()).default([]),
    t0Leaks: z.array(T0LeakItemSchema).default([]),
    publicSpoilerLeaks: z.array(T0LeakItemSchema).default([]),
    passed: z.boolean(),
    notes: z.string().optional()
});

export type FanficAuditReport = z.infer<typeof FanficAuditReportSchema>;

/** 通用开书异构盲审报告 Schema（别名） */
export const BootAuditReportSchema = FanficAuditReportSchema;
export type BootAuditReport = FanficAuditReport;

/** 开书编译结果 */
export interface BootBookResult {
    bookRoot: string;
    commitSha: string;
    tokensPerChar: number;
    entityIds: string[];
    loreIds: string[];
    coordinates?: NarrativeCoordinates | undefined;
    filteredVoiceSampleCount?: number | undefined;
    auditReport?: FanficAuditReport | undefined;
}

/** 同人 T0 切分异构盲审不达标或存在剧透泄露异常 */
export class BootAuditError extends Error {
    constructor(
        public readonly report: FanficAuditReport,
        message: string
    ) {
        super(message);
        this.name = 'BootAuditError';
    }
}

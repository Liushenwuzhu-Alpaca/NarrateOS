import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { StaticProseGate } from '../gate/static-prose-gate.js';
import {
    generateStructuredJson,
    type LlmPort,
    type StructuredRetryOptions
} from '../ports/llm.js';
import type { SystemPort } from '../ports/system.js';
import { BookStore } from '../store/bookstore.js';
import { DEFAULT_SECTION_HEADINGS, serializeEntityMarkdown } from '../store/entity-parser.js';
import type { BookConfig, EntityEntry, EntityProfile } from '../store/schemas.js';
import {
    BootAuditError,
    BootAuditReportSchema,
    BootCompilePayloadSchema,
    FanficAuditReportSchema,
    Phase1AutoSelectSchema,
    Phase1PitchProposalSchema,
    type BootAuditReport,
    type BootBookInput,
    type BootBookResult,
    type BootCompilePayload,
    type CompiledEntity,
    type FanficAuditReport,
    type NarrativeCoordinates,
    type Phase1PitchAndBibleResult,
    type PitchCandidate,
    type T0LeakItem
} from './schemas.js';

const DEFAULT_CALIBRATION_SAMPLE_TEXT =
    '雨夜的站台只剩一盏昏黄路灯，积水倒映着列车进站的冷光。他低头看了一眼怀表，指针停在十一点四十七分，铁轨尽头传来沉闷的回响。';

const DEFAULT_MIN_RECALL_RATE = 0.98;
const DEFAULT_MAX_AUDIT_RETRIES = 1;
const DEFAULT_MIN_ENTITY_COUNT = 4;
const DEFAULT_MIN_VOLUME_COUNT = 2;
const FALLBACK_TOKENS_PER_CHAR = 0.6;

interface CompileFeedback {
    missingFacts: string[];
    t0Leaks: T0LeakItem[];
    publicSpoilerLeaks: T0LeakItem[];
    quotaErrors: string[];
}

export interface BootBookDependencies {
    llm: LlmPort;
    system: SystemPort;
    retryOptions?: StructuredRetryOptions | undefined;
    signal?: AbortSignal | undefined;
}

/**
 * 利用样本文本与模型实测 usage.inputTokens 动态标定 tokens_per_char 系数。
 */
export async function calibrateTokensPerChar(
    llm: LlmPort,
    sampleText?: string | undefined,
    signal?: AbortSignal | undefined
): Promise<number> {
    const text = sampleText && sampleText.trim().length > 0 ? sampleText : DEFAULT_CALIBRATION_SAMPLE_TEXT;
    const response = await llm.generate(
        {
            pool: 'strong_creative',
            staticPrefixBlocks: [],
            dynamicTail: `请仅回复 OK。\n\n标定样本：\n${text}`,
            temperature: 0,
            maxTokens: 8
        },
        signal
    );

    if (text.length <= 0 || response.usage.inputTokens <= 0) {
        return FALLBACK_TOKENS_PER_CHAR;
    }

    return Number((response.usage.inputTokens / text.length).toFixed(4));
}

/** 统计 L1 卷级总纲中包含的独立卷数 */
function countVolumesInMarkdown(markdown: string): number {
    const volIds = new Set<string>();
    const volRegex = /\bvol_(\d+)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = volRegex.exec(markdown)) !== null) {
        if (match[1]) {
            volIds.add(String(Number(match[1])));
        }
    }

    const cnVolIds = new Set<string>();
    const cnRegex = /第\s*([一二三四五六七八九十百\d]+)\s*卷/g;
    while ((match = cnRegex.exec(markdown)) !== null) {
        if (match[1]) {
            cnVolIds.add(match[1]);
        }
    }

    return Math.max(volIds.size, cnVolIds.size);
}

/** 校验实体列表中是否至少包含 1 条 OMNISCIENT_SECRET 条目 */
function hasOmniscientSecretEntry(entities: CompiledEntity[]): boolean {
    return entities.some(
        (entity) =>
            entity.innateLocks.some((item) => item.visibility === 'OMNISCIENT_SECRET') ||
            entity.acquiredState.some((item) => item.visibility === 'OMNISCIENT_SECRET')
    );
}

/** 使用 0 Token 静态文风门禁清洗声纹样本，自动剔除 AI 八股违规句 */
function filterVoiceSamplesWithProseGate(
    samples: BootCompilePayload['voiceSamples'],
    quotaErrors?: string[]
): { cleanSamples: BootCompilePayload['voiceSamples']; filteredCount: number } {
    const proseGate = new StaticProseGate();
    const cleanSamples: BootCompilePayload['voiceSamples'] = [];
    let filteredCount = 0;

    for (const item of samples) {
        const result = proseGate.evaluate(item.sample);
        if (result.passed) {
            cleanSamples.push(item);
        } else {
            filteredCount += 1;
        }
    }

    if (cleanSamples.length === 0 && samples.length > 0 && quotaErrors) {
        quotaErrors.push(
            '声纹样本全部未通过 StaticProseGate 静态文风门禁，请重新生成不含 AI 八股禁词的合规声纹'
        );
    }

    return { cleanSamples, filteredCount };
}

/** 格式化 Markdown 落盘文本，确保包含换行结尾 */
function formatMarkdownWithFallbackHeading(content: string, fallbackHeading: string): string {
    const trimmed = content.trim();
    if (trimmed.startsWith('#')) {
        return `${trimmed}\n`;
    }
    return `${fallbackHeading}\n\n${trimmed}\n`;
}

/** 确定性校验实体档案中是否存在 storyDay > 0 的 T0 未来时间线泄露 */
function detectDeterministicT0Leaks(entities: CompiledEntity[]): T0LeakItem[] {
    const leaks: T0LeakItem[] = [];

    for (const entity of entities) {
        for (const item of entity.acquiredState) {
            if (item.storyDay > 0) {
                leaks.push({
                    entityId: entity.entityId,
                    field: 'acquiredState',
                    excerpt: item.text,
                    reason: `storyDay=${item.storyDay} 大于 T0 基准日 (0)`
                });
            }
        }
        for (const item of entity.irreversibleTrajectory) {
            if (item.storyDay > 0) {
                leaks.push({
                    entityId: entity.entityId,
                    field: 'irreversibleTrajectory',
                    excerpt: item.text,
                    reason: `storyDay=${item.storyDay} 大于 T0 基准日 (0)`
                });
            }
        }
        for (const item of entity.recentBuffer) {
            if (item.storyDay !== undefined && item.storyDay > 0) {
                leaks.push({
                    entityId: entity.entityId,
                    field: 'recentBuffer',
                    excerpt: item.text,
                    reason: `storyDay=${item.storyDay} 大于 T0 基准日 (0)`
                });
            }
        }
    }

    return leaks;
}

function toEntityProfile(compiled: CompiledEntity): EntityProfile {
    const innateLocks: EntityEntry[] = compiled.innateLocks.map((item) => ({
        visibility: item.visibility,
        text: item.text,
        continuationLines: []
    }));

    const acquiredState: EntityEntry[] = compiled.acquiredState.map((item) => {
        const entry: EntityEntry = {
            storyDay: item.storyDay,
            chapter: 0,
            visibility: item.visibility,
            text: item.text,
            continuationLines: []
        };
        if (item.slotKey !== undefined) {
            entry.slotKey = item.slotKey;
        }
        return entry;
    });

    const irreversibleTrajectory: EntityEntry[] = compiled.irreversibleTrajectory.map((item) => ({
        storyDay: item.storyDay,
        chapter: 0,
        text: item.text,
        continuationLines: []
    }));

    const recentBuffer: EntityEntry[] = compiled.recentBuffer.map((item) => {
        const entry: EntityEntry = {
            chapter: 0,
            text: item.text,
            continuationLines: []
        };
        if (item.storyDay !== undefined) {
            entry.storyDay = item.storyDay;
        }
        return entry;
    });

    return {
        metadata: {
            entity_id: compiled.entityId,
            canonical_name: compiled.canonicalName,
            unique_aliases: compiled.uniqueAliases,
            contextual_titles: compiled.contextualTitles,
            historical_anchors: [],
            last_seen_ch: 0
        },
        sectionHeadings: { ...DEFAULT_SECTION_HEADINGS },
        innateLocks,
        acquiredState,
        irreversibleTrajectory,
        recentBuffer
    };
}

function formatFutureHorizonMarkdown(payload: BootCompilePayload): string {
    const lines: string[] = ['# 世界默认惯性表 (Future Horizon)', ''];
    if (payload.futureHorizonEvents.length === 0) {
        lines.push('<!-- 暂无预定惯性事件 -->');
        return `${lines.join('\n')}\n`;
    }

    for (const evt of payload.futureHorizonEvents) {
        lines.push(
            `- [event:${evt.eventId} | day:${evt.storyDay} | status:ACTIVE] ${evt.description}`,
            `  - Premise: ${evt.premise}`
        );
    }
    return `${lines.join('\n')}\n`;
}

function formatOpenThreadsMarkdown(payload: BootCompilePayload): string {
    const lines: string[] = ['# 跨卷伏笔台账 (Open Threads)', ''];
    if (payload.openThreads.length === 0) {
        lines.push('<!-- 暂无登记伏笔 -->');
        return `${lines.join('\n')}\n`;
    }

    for (const thread of payload.openThreads) {
        lines.push(`- [${thread.threadId}] ${thread.title} | 唤醒条件: ${thread.wakeupCondition}`);
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Phase 1：脱离 JSON 枷锁的纯文本深推演（三维正交叙事坐标定标 -> 双轨拍板 -> 5 大模块纯文本《全书架构圣经》）。
 */
export async function runPhase1PitchAndBible(
    input: BootBookInput,
    deps: BootBookDependencies
): Promise<Phase1PitchAndBibleResult> {
    const seed = input.premiseOrSeed?.trim() || '自由发挥原创长篇开局';
    const decisionMode = input.decisionMode ?? 'auto_best';

    // Phase 1A：定标三维正交叙事坐标、排除 3 个俗套走向并生成 3 组候选切口
    const proposalPrompt = [
        `作品标题: ${input.title}`,
        `作品标识: ${input.bookSlug}`,
        `开局 POV 角色: ${input.povCharacter}`,
        `创作种子: ${seed}`,
        '',
        '请执行 Phase 1A 开局定标与反俗套切口生成，严格输出 ```json ... ```：',
        '1. 定标三维正交叙事坐标 (coordinates)：',
        '   - topology: CONTINUOUS_ESCALATION (连续递进式) | EPISODIC_ANTHOLOGY (单元剧叠加式) | MULTI_POV_TAPESTRY (多线群像织锦式)',
        '   - tensionDrivers: 至少 1 项，从 EPISTEMIC_GAP (认知差悬念) | GOAL_FRICTION (目标冲突) | RELATIONAL_POLARITY (关系张力) 中组合',
        '   - endgame: CONVERGENT_CLOSURE (收敛闭环) | OPEN_ROLLING (开放滚雪球)',
        '2. 显式列出并排除 3 个该题材最常见的俗套走向 (excludedCliches)；',
        '3. 给出 3 组差异化的候选切口 (pitches)，每组含 index (0/1/2)、title、logline、coreHook、antiClicheNote。',
        '注意：仅使用正向具象设定，不要输出纯否定清单。'
    ].join('\n');

    const { data: rawProposal } = await generateStructuredJson(
        deps.llm,
        {
            pool: 'strong_creative',
            staticPrefixBlocks: [],
            dynamicTail: proposalPrompt,
            temperature: 0.7
        },
        Phase1PitchProposalSchema,
        deps.retryOptions,
        deps.signal
    );
    const proposal = Phase1PitchProposalSchema.parse(rawProposal);

    // Phase 1B：双轨拍板 (interactive 人工选定 vs auto_best 由 audit 池自动择优)
    let selectedPitchIndex = 0;
    if (decisionMode === 'interactive') {
        if (input.selectedPitchIndex === undefined) {
            throw new Error('interactive 模式下必须指定 selectedPitchIndex');
        }
        if (input.selectedPitchIndex < 0 || input.selectedPitchIndex >= proposal.pitches.length) {
            throw new Error(
                `selectedPitchIndex=${input.selectedPitchIndex} 越界，候选切口数量为 ${proposal.pitches.length}`
            );
        }
        selectedPitchIndex = input.selectedPitchIndex;
    } else if (proposal.pitches.length > 1) {
        const selectPrompt = [
            `作品标题: ${input.title}`,
            `三维坐标: ${JSON.stringify(proposal.coordinates)}`,
            `已排除俗套: ${JSON.stringify(proposal.excludedCliches)}`,
            `候选切口列表: ${JSON.stringify(proposal.pitches)}`,
            '',
            '请以独立审校视角评估哪组切口最具长篇张力与反套路潜力，输出 JSON：{ "selectedIndex": 0..n, "rationale": "理由" }'
        ].join('\n');
        const { data: rawSelect } = await generateStructuredJson(
            deps.llm,
            {
                pool: 'audit',
                staticPrefixBlocks: [],
                dynamicTail: selectPrompt,
                temperature: 0
            },
            Phase1AutoSelectSchema,
            deps.retryOptions,
            deps.signal
        );
        const selection = Phase1AutoSelectSchema.parse(rawSelect);
        selectedPitchIndex =
            selection.selectedIndex >= 0 && selection.selectedIndex < proposal.pitches.length
                ? selection.selectedIndex
                : 0;
    }

    const selectedPitch: PitchCandidate = proposal.pitches[selectedPitchIndex]!;

    // Phase 1C：脱离 JSON 枷锁，扩写包含 5 大模块的纯文本《全书架构圣经》
    const biblePrompt = [
        `作品标题: ${input.title}`,
        `开局 POV 角色: ${input.povCharacter}`,
        `三维正交坐标: ${JSON.stringify(proposal.coordinates)}`,
        `选定切口: ${selectedPitch.title} - ${selectedPitch.logline}`,
        `核心钩子: ${selectedPitch.coreHook}`,
        `反套路约束: ${selectedPitch.antiClicheNote}`,
        '',
        '请脱离 JSON 格式限制，用纯文本 Markdown 深度推演并扩写《全书架构圣经》，必须完整包含以下 5 大模块：',
        '1. 里账本底层真相与代价定律（明确区分不可提前揭晓的幕后秘密与表面认知）；',
        '2. 全书母题（L0）与 3~5 卷递进蓝图（L1 卷级总纲，含每卷舞台、核心矛盾与跨卷锚点）；',
        '3. 第 1 卷三幕拐点、开篇第 1 章具象点火器（Ch.01 In Medias Res Hook）与本卷阶段天花板禁区（Stage Ceiling）；',
        '4. 4~6 名带秘密底牌与默认行动轨迹（Default Trajectory）的核心角色；',
        '5. 首批跨卷伏笔（open_threads）与近期外部世界惯性事件（future_horizon）。'
    ].join('\n');

    const bibleResponse = await deps.llm.generate(
        {
            pool: 'strong_creative',
            staticPrefixBlocks: [],
            dynamicTail: biblePrompt,
            temperature: 0.6
        },
        deps.signal
    );

    const architectureBibleMarkdown = bibleResponse.text.trim();
    if (architectureBibleMarkdown.length === 0) {
        throw new Error('Phase 1C 生成的纯文本《全书架构圣经》为空');
    }

    return {
        coordinates: proposal.coordinates,
        excludedCliches: proposal.excludedCliches,
        pitches: proposal.pitches,
        selectedPitchIndex,
        selectedPitch,
        architectureBibleMarkdown
    };
}

function buildCompilePrompt(
    input: BootBookInput,
    phase1?: Phase1PitchAndBibleResult,
    feedback?: CompileFeedback
): string {
    const sections: string[] = [
        `作品标题: ${input.title}`,
        `作品标识: ${input.bookSlug}`,
        `开局 POV 角色: ${input.povCharacter}`,
        `编译模式: ${input.mode}`
    ];

    if (input.mode === 'original') {
        sections.push(
            `创作脑洞/开局设定: ${input.premiseOrSeed ?? '自由发挥原创长篇开局'}`,
            '请执行 Phase 2「三把手术刀」结构化编译：',
            '1. 视角刀：严格区分 PUBLIC / SELF_ONLY / OMNISCIENT_SECRET / READER_KNOWN；绝不能将真凶底牌或未揭秘真相标为 PUBLIC；',
            '2. 时序刀：所有 T0 (storyDay <= 0) 既成事实归入 entities 与 loreEntries，T0 之后事件归入 futureHorizonEvents (storyDay > 0)；',
            '3. 冰山刀：抽象文风基调归入 staticBaseAndVoice，厚重设定细节切入 loreEntries。',
            '4. 声纹样本 (voiceSamples)：生成 4~5 类场景标签 x 每标签 2~3 句异构示范句，使用正向具象描写，不使用 AI 八股词。',
            '5. 必须输出完整的 l0SagasMarkdown、l1VolumesMarkdown（含至少 2~5 卷规划）、含开篇点火器与 Stage Ceiling 的 currentArcEnvelope，以及 4~6 名核心角色。'
        );
        if (phase1) {
            sections.push(
                `三维叙事坐标: ${JSON.stringify(phase1.coordinates)}`,
                phase1.coordinates.tensionDrivers.includes('EPISTEMIC_GAP')
                    ? '注意：由于张力源包含 EPISTEMIC_GAP，entities 中必须至少存在 1 条 visibility="OMNISCIENT_SECRET" 的底牌条目。'
                    : '',
                '',
                '## Phase 1 产出的《全书架构圣经》',
                phase1.architectureBibleMarkdown
            );
        }
    } else {
        sections.push(
            `T0 时间锚点: ${input.t0Anchor ?? 'story_day = 0 (开局时刻)'}`,
            '严格要求：',
            '1. 所有 T0 之前（storyDay <= 0）的既成事实归入 entities 与 loreEntries；',
            '2. 所有 T0 之后（storyDay > 0）的原著未来事件必须物理剥离出 entities，仅写入 futureHorizonEvents 并附带成立前提 premise；',
            '3. 保持专有名词与核心设定高召回率，不遗漏关键细节。',
            '',
            '原始设定包：',
            input.sourceMaterial ?? ''
        );
    }

    sections.push(
        '',
        '请严格按照以下 JSON Schema 输出（只输出 ```json ... ``` 代码块，所有 ID 仅限 ASCII 字母/数字/下划线）：',
        '```json',
        '{',
        '  "worldSummary": "世界观与开局核心局势总结",',
        '  "staticBaseAndVoice": "静态文风基调与叙述声线说明",',
        '  "currentArcEnvelope": "当前卷主线冲突、三幕拐点、Ch.01 点火器与 Stage Ceiling 禁区",',
        '  "l0SagasMarkdown": "# L0 纪元折叠总表\\n\\n- saga_01: 全书母题与纪元规划",',
        '  "l1VolumesMarkdown": "# L1 活跃卷级总表\\n\\n- vol_01: 第一卷 (story_day: 0..)\\n- vol_02: 第二卷 (待开启)",',
        '  "voiceSamples": [{ "tag": "声纹标签", "sample": "20-60字参考示例句" }],',
        '  "openThreads": [{ "threadId": "thread_001", "title": "伏笔名称", "wakeupCondition": "唤醒条件" }],',
        '  "futureHorizonEvents": [{ "eventId": "evt_001", "storyDay": 5, "premise": "成立前提", "description": "未来惯性事件描述" }],',
        '  "loreEntries": [{ "id": "lore_001", "title": "设定标题", "summary": "一句话摘要", "content": "详细设定正文" }],',
        '  "entities": [',
        '    {',
        '      "entityId": "char_xxx 或 item_xxx",',
        '      "canonicalName": "唯一标准名",',
        '      "uniqueAliases": [],',
        '      "contextualTitles": [],',
        '      "innateLocks": [{ "visibility": "PUBLIC", "text": "先天物理/性格红线" }],',
        '      "acquiredState": [{ "storyDay": 0, "visibility": "PUBLIC", "slotKey": "location", "text": "当前状态" }],',
        '      "irreversibleTrajectory": [{ "storyDay": 0, "text": "已发生关键履历" }],',
        '      "recentBuffer": [{ "storyDay": 0, "text": "近期动作或感官细节" }]',
        '    }',
        '  ]',
        '}',
        '```',
        '注意：visibility 仅允许 PUBLIC | SELF_ONLY | OMNISCIENT_SECRET | READER_KNOWN；entityId 必须严格以 char_ 或 item_ 开头（只含英文数字下划线）；loreEntries.id 必须严格以 lore_ 开头；futureHorizonEvents.storyDay 必须为正整数。'
    );

    if (feedback) {
        sections.push(
            '',
            '## 上轮盲审/门禁未通过，请针对以下问题补充并彻底剥离剧透后重新输出 JSON：',
            `配额与结构问题: ${JSON.stringify(feedback.quotaErrors)}`,
            `遗漏事实: ${JSON.stringify(feedback.missingFacts)}`,
            `T0 泄露项: ${JSON.stringify(feedback.t0Leaks)}`,
            `PUBLIC 剧透泄露项 (必须改标为 OMNISCIENT_SECRET 并从公开描述剥离): ${JSON.stringify(feedback.publicSpoilerLeaks)}`
        );
    }

    return sections.filter((line) => line !== undefined).join('\n');
}

/** 构造供异构剧透盲审检查的 PUBLIC 公开条目视图 */
function extractPublicFacingView(payload: BootCompilePayload) {
    return {
        worldSummary: payload.worldSummary,
        currentArcEnvelope: payload.currentArcEnvelope,
        entities: payload.entities.map((entity) => ({
            entityId: entity.entityId,
            canonicalName: entity.canonicalName,
            publicInnateLocks: entity.innateLocks.filter((item) => item.visibility === 'PUBLIC'),
            publicAcquiredState: entity.acquiredState.filter((item) => item.visibility === 'PUBLIC'),
            irreversibleTrajectory: entity.irreversibleTrajectory,
            recentBuffer: entity.recentBuffer,
            secretCount:
                entity.innateLocks.filter((item) => item.visibility === 'OMNISCIENT_SECRET').length +
                entity.acquiredState.filter((item) => item.visibility === 'OMNISCIENT_SECRET').length
        }))
    };
}

async function compileOriginalWithGates(
    input: BootBookInput,
    phase1: Phase1PitchAndBibleResult,
    deps: BootBookDependencies
): Promise<{
    payload: BootCompilePayload;
    auditReport: BootAuditReport;
    filteredVoiceSampleCount: number;
}> {
    const minEntityCount = input.minEntityCount ?? DEFAULT_MIN_ENTITY_COUNT;
    const minVolumeCount = input.minVolumeCount ?? DEFAULT_MIN_VOLUME_COUNT;
    const maxAuditRetries = input.maxAuditRetries ?? DEFAULT_MAX_AUDIT_RETRIES;

    let feedback: CompileFeedback | undefined;
    let lastReport: BootAuditReport | undefined;

    for (let attempt = 0; attempt <= maxAuditRetries; attempt++) {
        // Phase 2：三把手术刀结构化编译
        const { data: rawPayload } = await generateStructuredJson(
            deps.llm,
            {
                pool: 'strong_creative',
                staticPrefixBlocks: [],
                dynamicTail: buildCompilePrompt(input, phase1, feedback),
                temperature: 0.4
            },
            BootCompilePayloadSchema,
            deps.retryOptions,
            deps.signal
        );
        const parsedPayload = BootCompilePayloadSchema.parse(rawPayload);

        // Phase 3a：0 Token 配额与 T0 确定性门禁
        const deterministicT0Leaks = detectDeterministicT0Leaks(parsedPayload.entities);
        const quotaErrors: string[] = [];
        if (parsedPayload.entities.length < minEntityCount) {
            quotaErrors.push(
                `实体数量不足：当前 ${parsedPayload.entities.length}，要求 >= ${minEntityCount}`
            );
        }
        const volumeCount = countVolumesInMarkdown(parsedPayload.l1VolumesMarkdown);
        if (volumeCount < minVolumeCount) {
            quotaErrors.push(
                `L1 卷级规划数量不足：当前 ${volumeCount}，要求 >= ${minVolumeCount}`
            );
        }
        if (
            phase1.coordinates.tensionDrivers.includes('EPISTEMIC_GAP') &&
            !hasOmniscientSecretEntry(parsedPayload.entities)
        ) {
            quotaErrors.push(
                '三维坐标包含 EPISTEMIC_GAP，但 entities 中缺少 OMNISCIENT_SECRET 隐藏底牌'
            );
        }

        // Phase 3b：0 Token 声纹清洗（StaticProseGate 自动剔除 AI 八股违规句）
        const { cleanSamples, filteredCount } = filterVoiceSamplesWithProseGate(
            parsedPayload.voiceSamples,
            quotaErrors
        );
        const cleanedPayload: BootCompilePayload = {
            ...parsedPayload,
            voiceSamples: cleanSamples
        };

        // Phase 3c：异构剧透盲审（检查 PUBLIC 条目是否泄露 OMNISCIENT_SECRET 底牌）
        const { data: rawAudit } = await generateStructuredJson(
            deps.llm,
            {
                pool: 'audit',
                staticPrefixBlocks: [],
                dynamicTail: [
                    '请对照《全书架构圣经》中的里账本底牌，对编译后的公开视图 (PUBLIC 条目与公开摘要) 执行异构剧透盲审：',
                    '1. 检查 PUBLIC 栏位、worldSummary 或 currentArcEnvelope 是否将真凶身份、幕后底牌等 OMNISCIENT_SECRET 信息提前泄露为公开事实，列出 publicSpoilerLeaks；',
                    '2. 核查是否存在越过 T0 (storyDay > 0) 的时间线剧透，列出 t0Leaks；',
                    '3. 输出 JSON 报告（含 passed、publicSpoilerLeaks、t0Leaks、missingFacts、recallRate）。',
                    '',
                    '## 全书架构圣经 (参考底牌)',
                    phase1.architectureBibleMarkdown,
                    '',
                    '## 待盲审的公开视图与实体',
                    JSON.stringify(extractPublicFacingView(cleanedPayload))
                ].join('\n'),
                temperature: 0
            },
            BootAuditReportSchema,
            deps.retryOptions,
            deps.signal
        );
        const audit = BootAuditReportSchema.parse(rawAudit);

        const combinedT0Leaks = [...deterministicT0Leaks, ...audit.t0Leaks];
        const combinedMissingFacts = [...audit.missingFacts, ...quotaErrors];
        const passed =
            audit.passed &&
            quotaErrors.length === 0 &&
            combinedT0Leaks.length === 0 &&
            audit.publicSpoilerLeaks.length === 0;

        const mergedReport: BootAuditReport = {
            ...audit,
            missingFacts: combinedMissingFacts,
            t0Leaks: combinedT0Leaks,
            passed
        };
        lastReport = mergedReport;

        if (passed) {
            return {
                payload: cleanedPayload,
                auditReport: mergedReport,
                filteredVoiceSampleCount: filteredCount
            };
        }

        feedback = {
            missingFacts: audit.missingFacts,
            t0Leaks: combinedT0Leaks,
            publicSpoilerLeaks: audit.publicSpoilerLeaks,
            quotaErrors
        };
    }

    const finalReport: BootAuditReport = lastReport ?? {
        recallRate: 0,
        missingFacts: ['未知编译异常'],
        t0Leaks: [],
        publicSpoilerLeaks: [],
        passed: false
    };

    throw new BootAuditError(
        finalReport,
        `原创四阶段开书门禁未通过: publicSpoilerLeaks=${finalReport.publicSpoilerLeaks.length}, t0Leaks=${finalReport.t0Leaks.length}, issues=${finalReport.missingFacts.join('; ')}`
    );
}

async function compileFanficWithAudit(
    input: BootBookInput,
    deps: BootBookDependencies
): Promise<{
    payload: BootCompilePayload;
    auditReport: FanficAuditReport;
    filteredVoiceSampleCount: number;
}> {
    if (!input.sourceMaterial || input.sourceMaterial.trim().length === 0) {
        throw new Error('同人模式 (fanfic) 必须提供 sourceMaterial 设定包文本');
    }

    const minRecallRate = input.minRecallRate ?? DEFAULT_MIN_RECALL_RATE;
    const maxAuditRetries = input.maxAuditRetries ?? DEFAULT_MAX_AUDIT_RETRIES;

    let feedback: CompileFeedback | undefined;
    let lastReport: FanficAuditReport | undefined;

    for (let attempt = 0; attempt <= maxAuditRetries; attempt++) {
        const { data: rawPayload } = await generateStructuredJson(
            deps.llm,
            {
                pool: 'strong_creative',
                staticPrefixBlocks: [],
                dynamicTail: buildCompilePrompt(input, undefined, feedback),
                temperature: 0.2
            },
            BootCompilePayloadSchema,
            deps.retryOptions,
            deps.signal
        );
        const parsedPayload = BootCompilePayloadSchema.parse(rawPayload);
        const quotaErrors: string[] = [];
        const { cleanSamples, filteredCount } = filterVoiceSamplesWithProseGate(
            parsedPayload.voiceSamples,
            quotaErrors
        );
        const payload: BootCompilePayload = {
            ...parsedPayload,
            voiceSamples: cleanSamples
        };

        const deterministicLeaks = detectDeterministicT0Leaks(payload.entities);

        const { data: rawAudit } = await generateStructuredJson(
            deps.llm,
            {
                pool: 'audit',
                staticPrefixBlocks: [],
                dynamicTail: [
                    `请对照原始设定包与 T0 锚点 (${input.t0Anchor ?? 'story_day = 0'}) 执行独立盲审：`,
                    '1. 计算实体与世界书对原始设定关键事实的召回率 recallRate (0..1)，列出 missingFacts；',
                    '2. 核查 entities 中是否混入 T0 之后的未来剧透或未发生事件，列出 t0Leaks；',
                    '3. 核查 PUBLIC 条目是否误泄露应属 OMNISCIENT_SECRET 的底牌，列出 publicSpoilerLeaks；',
                    '4. 输出 JSON 报告。',
                    '',
                    '## 原始设定包',
                    input.sourceMaterial,
                    '',
                    '## 编译后实体与世界书',
                    JSON.stringify({ entities: payload.entities, loreEntries: payload.loreEntries })
                ].join('\n'),
                temperature: 0
            },
            FanficAuditReportSchema,
            deps.retryOptions,
            deps.signal
        );
        const audit = FanficAuditReportSchema.parse(rawAudit);

        const combinedLeaks = [...deterministicLeaks, ...audit.t0Leaks];
        const combinedMissingFacts = [...audit.missingFacts, ...quotaErrors];
        const passed =
            audit.passed &&
            quotaErrors.length === 0 &&
            audit.recallRate >= minRecallRate &&
            combinedLeaks.length === 0 &&
            audit.publicSpoilerLeaks.length === 0;

        const mergedReport: FanficAuditReport = {
            ...audit,
            missingFacts: combinedMissingFacts,
            t0Leaks: combinedLeaks,
            passed
        };
        lastReport = mergedReport;

        if (passed) {
            return { payload, auditReport: mergedReport, filteredVoiceSampleCount: filteredCount };
        }

        feedback = {
            missingFacts: audit.missingFacts,
            t0Leaks: combinedLeaks,
            publicSpoilerLeaks: audit.publicSpoilerLeaks,
            quotaErrors
        };
    }

    const finalReport: FanficAuditReport = lastReport ?? {
        recallRate: 0,
        missingFacts: ['未知编译异常'],
        t0Leaks: [],
        publicSpoilerLeaks: [],
        passed: false
    };

    throw new BootAuditError(
        finalReport,
        `同人 T0 盲审未通过: recallRate=${finalReport.recallRate} (要求 >= ${minRecallRate}), t0Leaks=${finalReport.t0Leaks.length}`
    );
}

/**
 * 开书编译主入口：统一处理原创四阶段开书与同人 T0 切分编译，标定分词率并完成初始 Git 提交。
 */
export async function bootBook(
    input: BootBookInput,
    deps: BootBookDependencies
): Promise<BootBookResult> {
    const tokensPerChar = await calibrateTokensPerChar(
        deps.llm,
        input.calibrationSampleText,
        deps.signal
    );

    let payload: BootCompilePayload;
    let auditReport: BootAuditReport | undefined;
    let coordinates: NarrativeCoordinates | undefined;
    let filteredVoiceSampleCount = 0;

    if (input.mode === 'fanfic') {
        const compiled = await compileFanficWithAudit(input, deps);
        payload = compiled.payload;
        auditReport = compiled.auditReport;
        filteredVoiceSampleCount = compiled.filteredVoiceSampleCount;
    } else {
        const phase1 = await runPhase1PitchAndBible(input, deps);
        coordinates = phase1.coordinates;
        const compiled = await compileOriginalWithGates(input, phase1, deps);
        payload = compiled.payload;
        auditReport = compiled.auditReport;
        filteredVoiceSampleCount = compiled.filteredVoiceSampleCount;
    }

    // 创建完整标准目录树
    const requiredDirs = [
        'manuscripts',
        'entities',
        'entities/cold_archive',
        'world',
        'lore_library',
        'index',
        'index/L2_cards',
        '.ops',
        '.ops/parallel_deltas'
    ];
    for (const dir of requiredDirs) {
        await mkdir(join(input.bookRoot, dir), { recursive: true });
    }

    // 空目录放置 .gitkeep 以确保 Git 仓库完整保留目录结构
    await writeFile(join(input.bookRoot, 'manuscripts/.gitkeep'), '', 'utf8');
    await writeFile(join(input.bookRoot, 'entities/cold_archive/.gitkeep'), '', 'utf8');
    await writeFile(join(input.bookRoot, '.ops/parallel_deltas/.gitkeep'), '', 'utf8');
    if (payload.loreEntries.length === 0) {
        await writeFile(join(input.bookRoot, 'lore_library/.gitkeep'), '', 'utf8');
    }

    const store = new BookStore(input.bookRoot, deps.system);

    const bookConfig: BookConfig = {
        book_slug: input.bookSlug,
        title: input.title,
        tokens_per_char: tokensPerChar,
        writer_token_budget: input.writerTokenBudget ?? null,
        max_auto_rollback_chapters: input.maxAutoRollbackChapters ?? 3,
        structured_json_retry: {
            max_retries: 5,
            backoff_ms: [1000, 2000, 4000, 8000, 16000]
        },
        craft_plugins: input.craftPlugins ?? [],
        prose_gate: {
            enable_anti_cliche: true,
            enable_cross_chapter_simile: true,
            cross_chapter_simile_window: 5
        }
    };
    if (input.modelRouting !== undefined) {
        bookConfig.model_routing = input.modelRouting;
    }
    await store.writeBookConfig(bookConfig);

    await store.writeWorldState({
        frontmatter: {
            story_day: 0,
            current_volume: 1,
            current_chapter: 0,
            pov_character: input.povCharacter,
            timeline_mode: 'MAINLINE'
        },
        summaryMarkdown: payload.worldSummary
    });

    await writeFile(
        join(input.bookRoot, 'world/static_base_and_voice.md'),
        `# 世界底层法则与抽象句法纪律\n\n${payload.staticBaseAndVoice.trim()}\n`,
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, 'world/current_arc_envelope.md'),
        `# 当前卷纲要与阶段锁\n\n${payload.currentArcEnvelope.trim()}\n`,
        'utf8'
    );
    const normalizedVoiceSamples = payload.voiceSamples.map((item, idx) => ({
        id: `voice_${String(idx + 1).padStart(2, '0')}`,
        tag: item.tag,
        text: item.sample,
        sample: item.sample,
        last_used_ch: 0,
        use_count: 0
    }));
    const voiceSamplesYaml = stringifyYaml({ samples: normalizedVoiceSamples }, { lineWidth: 0 });
    await writeFile(
        join(input.bookRoot, 'world/voice_samples.yaml'),
        voiceSamplesYaml,
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, '.ops/voice_samples.yaml'),
        voiceSamplesYaml,
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, 'world/ops_style_amendments.md'),
        '# 卷中风格修订 (Ops Style Amendments)\n\n',
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, 'world/future_horizon.md'),
        formatFutureHorizonMarkdown(payload),
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, 'world/open_threads.md'),
        formatOpenThreadsMarkdown(payload),
        'utf8'
    );

    await writeFile(
        join(input.bookRoot, 'index/L0_sagas.md'),
        formatMarkdownWithFallbackHeading(payload.l0SagasMarkdown, '# L0 纪元折叠总表'),
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, 'index/L1_volumes.md'),
        formatMarkdownWithFallbackHeading(payload.l1VolumesMarkdown, '# L1 活跃卷级总表'),
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, 'index/L2_cards/vol_01_cards.md'),
        '# 第 1 卷双轨章卡\n\n',
        'utf8'
    );

    const loreIds: string[] = [];
    for (const lore of payload.loreEntries) {
        loreIds.push(lore.id);
        const loreContent = [
            `# ${lore.title}`,
            '',
            `> 摘要: ${lore.summary}`,
            '',
            lore.content.trim(),
            ''
        ].join('\n');
        await writeFile(join(input.bookRoot, `lore_library/${lore.id}.md`), loreContent, 'utf8');
    }

    const entityIds: string[] = [];
    for (const compiledEntity of payload.entities) {
        entityIds.push(compiledEntity.entityId);
        const profile = toEntityProfile(compiledEntity);
        const markdown = serializeEntityMarkdown(profile);
        await writeFile(join(input.bookRoot, `entities/${compiledEntity.entityId}.md`), markdown, 'utf8');
    }

    await store.initializeWalFromDisk();

    await deps.system.initRepo(input.bookRoot);
    const { sha } = await deps.system.commitPaths(
        input.bookRoot,
        ['.'],
        `chore(boot): initialize ${input.bookSlug}`
    );

    const result: BootBookResult = {
        bookRoot: input.bookRoot,
        commitSha: sha,
        tokensPerChar,
        entityIds,
        loreIds,
        filteredVoiceSampleCount
    };
    if (coordinates !== undefined) {
        result.coordinates = coordinates;
    }
    if (auditReport !== undefined) {
        result.auditReport = auditReport;
    }
    return result;
}

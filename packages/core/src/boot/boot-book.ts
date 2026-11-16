import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
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
    BootCompilePayloadSchema,
    FanficAuditReportSchema,
    type BootBookInput,
    type BootBookResult,
    type BootCompilePayload,
    type CompiledEntity,
    type FanficAuditReport,
    type T0LeakItem
} from './schemas.js';

const DEFAULT_CALIBRATION_SAMPLE_TEXT =
    '雨夜的站台只剩一盏昏黄路灯，积水倒映着列车进站的冷光。他低头看了一眼怀表，指针停在十一点四十七分，铁轨尽头传来沉闷的回响。';

const DEFAULT_MIN_RECALL_RATE = 0.98;
const DEFAULT_MAX_AUDIT_RETRIES = 1;
const FALLBACK_TOKENS_PER_CHAR = 0.6;

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

function buildCompilePrompt(
    input: BootBookInput,
    feedback?: { missingFacts: string[]; t0Leaks: T0LeakItem[] }
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
            '注意：仅使用正向具象设定，不要输出纯否定列表。'
        );
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
        '  "currentArcEnvelope": "当前卷主线冲突与阶段目标",',
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
            '## 上轮盲审未通过，请针对以下问题补充并彻底剥离剧透后重新输出 JSON：',
            `遗漏事实: ${JSON.stringify(feedback.missingFacts)}`,
            `T0 泄露项: ${JSON.stringify(feedback.t0Leaks)}`
        );
    }

    return sections.join('\n');
}

async function compileOriginal(
    input: BootBookInput,
    deps: BootBookDependencies
): Promise<BootCompilePayload> {
    const { data } = await generateStructuredJson(
        deps.llm,
        {
            pool: 'strong_creative',
            staticPrefixBlocks: [],
            dynamicTail: buildCompilePrompt(input),
            temperature: 0.4
        },
        BootCompilePayloadSchema,
        deps.retryOptions,
        deps.signal
    );
    return BootCompilePayloadSchema.parse(data);
}

async function compileFanficWithAudit(
    input: BootBookInput,
    deps: BootBookDependencies
): Promise<{ payload: BootCompilePayload; auditReport: FanficAuditReport }> {
    if (!input.sourceMaterial || input.sourceMaterial.trim().length === 0) {
        throw new Error('同人模式 (fanfic) 必须提供 sourceMaterial 设定包文本');
    }

    const minRecallRate = input.minRecallRate ?? DEFAULT_MIN_RECALL_RATE;
    const maxAuditRetries = input.maxAuditRetries ?? DEFAULT_MAX_AUDIT_RETRIES;

    let feedback: { missingFacts: string[]; t0Leaks: T0LeakItem[] } | undefined;
    let lastReport: FanficAuditReport | undefined;

    for (let attempt = 0; attempt <= maxAuditRetries; attempt++) {
        const { data: rawPayload } = await generateStructuredJson(
            deps.llm,
            {
                pool: 'strong_creative',
                staticPrefixBlocks: [],
                dynamicTail: buildCompilePrompt(input, feedback),
                temperature: 0.2
            },
            BootCompilePayloadSchema,
            deps.retryOptions,
            deps.signal
        );
        const payload = BootCompilePayloadSchema.parse(rawPayload);

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
                    '3. 输出 JSON 报告。',
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
        const passed =
            audit.passed &&
            audit.recallRate >= minRecallRate &&
            combinedLeaks.length === 0;

        const mergedReport: FanficAuditReport = {
            ...audit,
            t0Leaks: combinedLeaks,
            passed
        };
        lastReport = mergedReport;

        if (passed) {
            return { payload, auditReport: mergedReport };
        }

        feedback = {
            missingFacts: audit.missingFacts,
            t0Leaks: combinedLeaks
        };
    }

    const finalReport = lastReport ?? {
        recallRate: 0,
        missingFacts: ['未知编译异常'],
        t0Leaks: [],
        passed: false
    };

    throw new BootAuditError(
        finalReport,
        `同人 T0 盲审未通过: recallRate=${finalReport.recallRate} (要求 >= ${minRecallRate}), t0Leaks=${finalReport.t0Leaks.length}`
    );
}

/**
 * 开书编译主入口：统一处理原创冷启动与同人 T0 切分编译，标定分词率并完成初始 Git 提交。
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
    let auditReport: FanficAuditReport | undefined;

    if (input.mode === 'fanfic') {
        const compiled = await compileFanficWithAudit(input, deps);
        payload = compiled.payload;
        auditReport = compiled.auditReport;
    } else {
        payload = await compileOriginal(input, deps);
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
        '# L0 纪元折叠总表\n\n<!-- 每满 10 卷封存一纪元 -->\n',
        'utf8'
    );
    await writeFile(
        join(input.bookRoot, 'index/L1_volumes.md'),
        `# L1 活跃卷级总表\n\n- vol_01: ${input.title} 第一卷 (story_day: 0..)\n`,
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
        loreIds
    };
    if (auditReport !== undefined) {
        result.auditReport = auditReport;
    }
    return result;
}

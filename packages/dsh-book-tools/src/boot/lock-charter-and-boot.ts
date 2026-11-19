import { existsSync } from 'node:fs';
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    BookStore,
    DEFAULT_SECTION_HEADINGS,
    NodeSystemAdapter,
    serializeEntityMarkdown,
    type BookConfig,
    type EntityEntry,
    type EntityProfile,
    type NarrationSubjectivity,
    type SystemPort
} from '@narrateos/dsh-book-store';
import { BootGateError } from '../errors.js';
import {
    BootVoiceSampleSchema,
    CompiledEntitySchema,
    CompiledLoreEntrySchema,
    type CompiledEntity
} from '../yield/schemas.js';
import { validateBootBundle } from './boot-validation.js';

const STANDARD_BOOK_GITIGNORE = [
    '# NarrateOS 运行态与事务临时文件（严禁纳入版本历史）',
    '.ops/tx.lock',
    '.ops/pending_writes.json',
    '.ops/runs.jsonl',
    '.ops/llm_calls.jsonl',
    '.ops/session_logs/',
    '.ops/traces/',
    '.ops/recovery/',
    '.ops/safe_halt.json',
    '.ops/quarantine_report.json',
    '.ops/heal_plan.json',
    '.ops/sync_conflicts.json',
    '.ops/manual_edits/',
    ''
].join('\n');

/** 开篇序列节拍（3~5 拍，不绑定章号） */
export const OpeningSequenceBeatSchema = z.object({
    beat_label: z.string().min(1).optional(),
    craft_focus: z.string().min(1),
    clue_budget: z.string().min(1),
    completion_sign: z.string().min(1)
});
export type OpeningSequenceBeat = z.infer<typeof OpeningSequenceBeatSchema>;

/** lock_charter_and_boot 输入契约（放宽至 >=1 卷、>=1 实体、允许 0 秘密与 0 声纹） */
export const LockCharterAndBootInputSchema = z.object({
    book_slug: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'book_slug 仅允许 ASCII 字母、数字、下划线与连字符'),
    title: z.string().min(1),
    pov_character: z.string().min(1),
    t0_anchor: z.string().min(1),
    commitments: z.array(z.string().min(1)).min(1),
    excluded_cliches: z.array(z.string().min(1)).default([]),
    authorization_boundary: z
        .string()
        .min(1)
        .default('在作者契约与阶段天花板授权范围内推进，触及核心承诺改变时安全挂起等待作者裁决'),
    stage_ceiling: z.string().min(1),
    opening_sequence_beats: z.array(OpeningSequenceBeatSchema).min(3).max(5),
    unrevealed_pivots: z.array(z.string().min(1)).default([]),
    current_arc_envelope: z.string().min(1),
    static_base_and_voice: z.string().min(1),
    world_summary: z.string().min(1),
    l0_sagas_markdown: z
        .string()
        .min(1)
        .default('# L0 纪元折叠总表\n\n<!-- 每满 10 卷封存一纪元 -->'),
    l1_volumes_markdown: z.string().min(1),
    entities: z.array(CompiledEntitySchema).min(1),
    lore_entries: z.array(CompiledLoreEntrySchema).default([]),
    open_threads: z
        .array(
            z.object({
                thread_id: z.string().min(1),
                title: z.string().min(1),
                wakeup_condition: z.string().min(1)
            })
        )
        .default([]),
    future_horizon_events: z
        .array(
            z.object({
                event_id: z.string().min(1),
                story_day: z.number().int().positive(),
                premise: z.string().min(1),
                description: z.string().min(1)
            })
        )
        .default([]),
    voice_samples: z.array(BootVoiceSampleSchema).default([]),
    tokens_per_char: z.number().positive().default(0.6),
    narration_subjectivity: z.enum(['objective_third', 'subjective_first']).default('objective_third'),
    writer_token_budget: z.number().int().positive().nullable().default(null),
    max_auto_rollback_chapters: z.number().int().nonnegative().default(3),
    craft_plugins: z.array(z.string()).default([]),
    model_routing: z.record(z.string(), z.string()).optional()
});

export type LockCharterAndBootInput = z.input<typeof LockCharterAndBootInputSchema>;
export type ParsedLockCharterAndBootInput = z.infer<typeof LockCharterAndBootInputSchema>;

/** onBookBooted 回调返回值（用于回报自动切书是否因在途锁冲突被跳过） */
export interface BootSwitchOutcome {
    switchedBook: boolean;
    switchConflictReason?: string | undefined;
}

/** lock_charter_and_boot 执行结果 */
export interface LockCharterAndBootResult {
    bookRoot: string;
    bookSlug: string;
    commitSha: string;
    entityIds: string[];
    loreIds: string[];
    voiceSampleCount: number;
    filteredVoiceSampleCount: number;
    halted: true;
    switchedBook?: boolean | undefined;
    switchConflictReason?: string | undefined;
}

/** lock_charter_and_boot 运行选项 */
export interface LockCharterAndBootOptions {
    booksRoot: string;
    system?: SystemPort | undefined;
    onBookBooted?:
        | ((result: LockCharterAndBootResult) => BootSwitchOutcome | void | Promise<BootSwitchOutcome | void>)
        | undefined;
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
        if (item.owner !== undefined) {
            entry.owner = item.owner;
        }
        return entry;
    });

    const irreversibleTrajectory: EntityEntry[] = compiled.irreversibleTrajectory.map((item) => ({
        storyDay: item.storyDay,
        visibility: item.visibility,
        owner: item.owner,
        chapter: 0,
        text: item.text,
        continuationLines: []
    }));

    const recentBuffer: EntityEntry[] = compiled.recentBuffer.map((item) => {
        const entry: EntityEntry = {
            chapter: 0,
            visibility: item.visibility,
            owner: item.owner,
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

function formatAuthorCharterMarkdown(input: ParsedLockCharterAndBootInput): string {
    const lines: string[] = [
        `# 作者契约 (Author Charter) - ${input.title}`,
        '',
        '## T0 开局现场原话锚点',
        input.t0_anchor.trim(),
        '',
        '## 核心创作承诺与边界',
        ...input.commitments.map((item) => `- ${item.trim()}`),
        '',
        '## 授权边界',
        `- ${input.authorization_boundary.trim()}`,
        ''
    ];

    if (input.excluded_cliches.length > 0) {
        lines.push('## 已排除廉价套路（对写手物理屏蔽）');
        for (const cliche of input.excluded_cliches) {
            lines.push(`- ${cliche.trim()}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function formatArcDirectorPlanMarkdown(input: ParsedLockCharterAndBootInput): string {
    const lines: string[] = [
        '# 导演禁区与开篇节拍计划 (Arc Director Plan)',
        '',
        '## Stage Ceiling (阶段天花板禁区)',
        input.stage_ceiling.trim(),
        '',
        '## Opening Sequence Beats (开篇序列节拍 · 不绑定章号 · 按序消耗)'
    ];

    for (const beat of input.opening_sequence_beats) {
        const titlePart = beat.beat_label ? `${beat.beat_label} | ` : '';
        lines.push(
            `- [status: PENDING] ${titlePart}体验/手艺落点: ${beat.craft_focus.trim()} | 线索预算: ${beat.clue_budget.trim()} | 过拍标志: ${beat.completion_sign.trim()}`
        );
    }

    if (input.unrevealed_pivots.length > 0) {
        lines.push('', '## 未揭秘三幕拐点');
        for (const pivot of input.unrevealed_pivots) {
            lines.push(`- ${pivot.trim()}`);
        }
    }

    lines.push('');
    return lines.join('\n');
}

function formatMarkdownWithFallbackHeading(content: string, fallbackHeading: string): string {
    const trimmed = content.trim();
    if (trimmed.startsWith('#')) {
        return `${trimmed}\n`;
    }
    return `${fallbackHeading}\n\n${trimmed}\n`;
}

function formatFutureHorizonMarkdown(input: ParsedLockCharterAndBootInput): string {
    const lines: string[] = ['# 世界默认惯性表 (Future Horizon)', ''];
    if (input.future_horizon_events.length === 0) {
        lines.push('<!-- 暂无预定惯性事件 -->');
        return `${lines.join('\n')}\n`;
    }
    for (const evt of input.future_horizon_events) {
        lines.push(
            `- [event:${evt.event_id} | day:${evt.story_day} | status:ACTIVE] ${evt.description}`,
            `  - Premise: ${evt.premise}`
        );
    }
    return `${lines.join('\n')}\n`;
}

function formatOpenThreadsMarkdown(input: ParsedLockCharterAndBootInput): string {
    const lines: string[] = ['# 跨卷伏笔台账 (Open Threads)', ''];
    if (input.open_threads.length === 0) {
        lines.push('<!-- 暂无登记伏笔 -->');
        return `${lines.join('\n')}\n`;
    }
    for (const thread of input.open_threads) {
        lines.push(`- [${thread.thread_id} | status: ACTIVE] ${thread.title} | 唤醒条件: ${thread.wakeup_condition}`);
    }
    return `${lines.join('\n')}\n`;
}

/** 对开书编译包执行确定性 T0 防泄露与 StaticProseGate 门禁检验 */
function validateBootPayloadDeterministically(
    parsed: ParsedLockCharterAndBootInput,
    subjectivity: NarrationSubjectivity
): {
    cleanVoiceSamples: ParsedLockCharterAndBootInput['voice_samples'];
    filteredVoiceSampleCount: number;
} {
    const outcome = validateBootBundle(parsed, {
        narrationSubjectivity: subjectivity,
        voiceSampleMode: 'filter'
    });
    if (outcome.issues.length > 0) {
        throw new BootGateError(outcome.issues);
    }
    return {
        cleanVoiceSamples: outcome.cleanVoiceSamples,
        filteredVoiceSampleCount: outcome.filteredVoiceSampleCount
    };
}

const BOOT_REQUIRED_DIRS = [
    'manuscripts',
    'entities',
    'entities/cold_archive',
    'world',
    'lore_library',
    'index',
    'index/L2_cards',
    '.ops',
    '.ops/parallel_deltas'
] as const;

async function prepareBootDirectorySkeleton(bookRoot: string, hasLoreEntries: boolean): Promise<string[]> {
    for (const dir of BOOT_REQUIRED_DIRS) {
        await mkdir(join(bookRoot, dir), { recursive: true });
    }

    const bootCommitPaths: string[] = [
        '.gitignore',
        'manuscripts/.gitkeep',
        'entities/cold_archive/.gitkeep',
        '.ops/parallel_deltas/.gitkeep'
    ];

    await writeFile(join(bookRoot, '.gitignore'), STANDARD_BOOK_GITIGNORE, 'utf8');
    await writeFile(join(bookRoot, 'manuscripts/.gitkeep'), '', 'utf8');
    await writeFile(join(bookRoot, 'entities/cold_archive/.gitkeep'), '', 'utf8');
    await writeFile(join(bookRoot, '.ops/parallel_deltas/.gitkeep'), '', 'utf8');
    if (!hasLoreEntries) {
        await writeFile(join(bookRoot, 'lore_library/.gitkeep'), '', 'utf8');
        bootCommitPaths.push('lore_library/.gitkeep');
    }
    return bootCommitPaths;
}

async function writeBootBookArtifacts(
    bookRoot: string,
    store: BookStore,
    parsed: ParsedLockCharterAndBootInput,
    cleanVoiceSamples: ParsedLockCharterAndBootInput['voice_samples'],
    bootCommitPaths: string[]
): Promise<{ entityIds: string[]; loreIds: string[]; voiceSampleCount: number }> {
    const bookConfig: BookConfig = {
        book_slug: parsed.book_slug,
        title: parsed.title,
        tokens_per_char: parsed.tokens_per_char,
        narration_subjectivity: parsed.narration_subjectivity,
        trace_level: 'full',
        writer_token_budget: parsed.writer_token_budget,
        max_auto_rollback_chapters: parsed.max_auto_rollback_chapters,
        structured_json_retry: {
            max_retries: 5,
            backoff_ms: [1000, 2000, 4000, 8000, 16000]
        },
        craft_plugins: parsed.craft_plugins,
        prose_gate: {
            enable_anti_cliche: true,
            enable_cross_chapter_simile: true,
            cross_chapter_simile_window: 5
        }
    };
    if (parsed.model_routing !== undefined) {
        bookConfig.model_routing = parsed.model_routing;
    }
    await store.writeBookConfig(bookConfig);
    bootCommitPaths.push('world/book_config.yaml');

    await store.writeWorldState({
        frontmatter: {
            story_day: 0,
            current_volume: 1,
            current_chapter: 0,
            pov_character: parsed.pov_character,
            timeline_mode: 'MAINLINE'
        },
        summaryMarkdown: parsed.world_summary
    });
    bootCommitPaths.push('world/world_state.md');

    await store.writeAuthorCharter(formatAuthorCharterMarkdown(parsed));
    await store.writeArcDirectorPlan(formatArcDirectorPlanMarkdown(parsed));
    await store.writeCurrentArcEnvelope(
        formatMarkdownWithFallbackHeading(
            parsed.current_arc_envelope,
            '# 当前卷正向舞台常态 (Current Arc Envelope)'
        )
    );
    await store.writeStaticBaseAndVoice(
        formatMarkdownWithFallbackHeading(
            parsed.static_base_and_voice,
            '# 世界底层法则与抽象句法纪律'
        )
    );
    await store.writeOpsStyleAmendments('# 卷中风格修订 (Ops Style Amendments)\n\n');
    await store.writeFutureHorizon(formatFutureHorizonMarkdown(parsed));
    await store.writeOpenThreads(formatOpenThreadsMarkdown(parsed));
    bootCommitPaths.push(
        'world/author_charter.md',
        'world/arc_director_plan.md',
        'world/current_arc_envelope.md',
        'world/static_base_and_voice.md',
        'world/ops_style_amendments.md',
        'world/future_horizon.md',
        'world/open_threads.md'
    );

    // 统一通过 BookStore.writeVoiceSamples 写入标准字段（零冗余 sample 键）
    const normalizedVoiceSamples = cleanVoiceSamples.map((item, idx) => ({
        id: `voice_${String(idx + 1).padStart(2, '0')}`,
        tag: item.tag,
        text: item.sample,
        last_used_ch: 0,
        use_count: 0,
        ...(item.source !== undefined ? { source: item.source } : {})
    }));
    await store.writeVoiceSamples({ samples: normalizedVoiceSamples });
    bootCommitPaths.push('.ops/voice_samples.yaml');

    await writeFile(
        join(bookRoot, 'index/L0_sagas.md'),
        formatMarkdownWithFallbackHeading(parsed.l0_sagas_markdown, '# L0 纪元折叠总表'),
        'utf8'
    );
    await writeFile(
        join(bookRoot, 'index/L1_volumes.md'),
        formatMarkdownWithFallbackHeading(parsed.l1_volumes_markdown, '# L1 活跃卷级总表'),
        'utf8'
    );
    await writeFile(
        join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
        '# 第 1 卷双轨章卡\n\n',
        'utf8'
    );
    bootCommitPaths.push(
        'index/L0_sagas.md',
        'index/L1_volumes.md',
        'index/L2_cards/vol_01_cards.md'
    );

    const loreIds: string[] = [];
    for (const lore of parsed.lore_entries) {
        loreIds.push(lore.id);
        const loreContent = [
            `# ${lore.title}`,
            '',
            `> 摘要: ${lore.summary}`,
            '',
            lore.content.trim(),
            ''
        ].join('\n');
        const loreRel = `lore_library/${lore.id}.md`;
        await writeFile(join(bookRoot, loreRel), loreContent, 'utf8');
        bootCommitPaths.push(loreRel);
    }

    const entityIds: string[] = [];
    for (const compiledEntity of parsed.entities) {
        entityIds.push(compiledEntity.entityId);
        const profile = toEntityProfile(compiledEntity);
        const entityRel = `entities/${compiledEntity.entityId}.md`;
        await writeFile(
            join(bookRoot, entityRel),
            serializeEntityMarkdown(profile),
            'utf8'
        );
        bootCommitPaths.push(entityRel);
    }

    return {
        entityIds,
        loreIds,
        voiceSampleCount: normalizedVoiceSamples.length
    };
}

async function rollbackFailedBootDirectory(bookRoot: string, bookRootExistedBefore: boolean): Promise<void> {
    if (!bookRootExistedBefore) {
        await rm(bookRoot, { recursive: true, force: true }).catch(() => undefined);
        return;
    }
    try {
        const entries = await readdir(bookRoot);
        await Promise.all(
            entries.map((entry) => rm(join(bookRoot, entry), { recursive: true, force: true }))
        );
    } catch {
        // 保留原始建库失败原因，忽略回滚清理次生异常
    }
}

/**
 * 锁定《作者契约》并原子初始化作品独立 Git 仓库，随后原地停机（永不自动触发第 1 章）。
 */
export async function lockCharterAndBoot(
    rawInput: LockCharterAndBootInput,
    options: LockCharterAndBootOptions
): Promise<LockCharterAndBootResult> {
    const parsed = LockCharterAndBootInputSchema.parse(rawInput);
    const resolvedBooksRoot = resolve(options.booksRoot);
    const bookRoot = resolve(resolvedBooksRoot, parsed.book_slug);

    const relToBooksRoot = relative(resolvedBooksRoot, bookRoot);
    if (relToBooksRoot === '' || relToBooksRoot.startsWith('..') || isAbsolute(relToBooksRoot)) {
        throw new Error(`非法的 book_slug 路径越界: ${parsed.book_slug}`);
    }

    // 所有确定性检查在写入磁盘前完成，确保不留半成品目录
    const { cleanVoiceSamples, filteredVoiceSampleCount } = validateBootPayloadDeterministically(
        parsed,
        parsed.narration_subjectivity
    );

    await mkdir(resolvedBooksRoot, { recursive: true });
    const bootLockPath = join(resolvedBooksRoot, `.boot-lock-${parsed.book_slug}.lock`);
    try {
        const handle = await open(bootLockPath, 'wx');
        await handle.close();
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'EEXIST') {
            throw new Error(`开书正在进行中，禁止并发建库覆盖同一作品: ${parsed.book_slug}`);
        }
        throw err;
    }

    let bookRootExistedBefore = false;
    try {
        bookRootExistedBefore = existsSync(bookRoot);
        if (bookRootExistedBefore && (await readdir(bookRoot)).length > 0) {
            throw new Error(`开书目标目录非空，禁止覆盖已有作品: ${bookRoot}`);
        }

        if (!bookRootExistedBefore) {
            await mkdir(bookRoot);
        }

        try {
            const bootCommitPaths = await prepareBootDirectorySkeleton(
                bookRoot,
                parsed.lore_entries.length > 0
            );
            const system = options.system ?? new NodeSystemAdapter();
            const store = new BookStore(bookRoot, system);

            const { entityIds, loreIds, voiceSampleCount } = await writeBootBookArtifacts(
                bookRoot,
                store,
                parsed,
                cleanVoiceSamples,
                bootCommitPaths
            );

            // 初始化 .ops/tx_state.json (last_committed_ch = 0) 并使用显式受控路径执行初始 Git 提交
            await store.initializeWalFromDisk();
            bootCommitPaths.push('.ops/tx_state.json');

            await system.initRepo(bookRoot);
            const { sha } = await system.commitPaths(
                bookRoot,
                bootCommitPaths,
                `chore(boot): initialize ${parsed.book_slug}`
            );

            const result: LockCharterAndBootResult = {
                bookRoot,
                bookSlug: parsed.book_slug,
                commitSha: sha,
                entityIds,
                loreIds,
                voiceSampleCount,
                filteredVoiceSampleCount,
                halted: true
            };

            if (options.onBookBooted) {
                const switchOutcome = await options.onBookBooted(result);
                if (switchOutcome && typeof switchOutcome === 'object') {
                    result.switchedBook = switchOutcome.switchedBook;
                    if (switchOutcome.switchConflictReason !== undefined) {
                        result.switchConflictReason = switchOutcome.switchConflictReason;
                    }
                }
            }

            return result;
        } catch (err: unknown) {
            await rollbackFailedBootDirectory(bookRoot, bookRootExistedBefore);
            throw err;
        }
    } finally {
        await rm(bootLockPath, { force: true }).catch(() => undefined);
    }
}

/** 创建主对话开书建库工具 lock_charter_and_boot */
export function createLockCharterAndBootTool(options: LockCharterAndBootOptions): ToolDefinition {
    return defineTool({
        name: 'lock_charter_and_boot',
        description:
            '锁定确认后的《作者契约》与开书架构，原子编译并初始化 books/<slug>/ 独立 Git 仓库，完成 T0 防泄露与 StaticProseGate 门禁后立即停机待命（绝不自动开始第 1 章）。',
        parameters: {
            book_slug: { type: 'string', required: true, description: '作品目录标识符（ASCII 字母/数字/下划线/连字符）' },
            title: { type: 'string', required: true, description: '作品标题' },
            pov_character: { type: 'string', required: true, description: '开局 POV 角色 ID 或名称' },
            t0_anchor: { type: 'string', required: true, description: '作者原话逐字锁定的 T0 开局现场' },
            commitments: { type: 'array', required: true, items: { type: 'string' }, description: '核心创作承诺与边界' },
            excluded_cliches: { type: 'array', items: { type: 'string' }, description: '显式排除的廉价套路清单' },
            authorization_boundary: { type: 'string', description: '运行期授权边界' },
            stage_ceiling: { type: 'string', required: true, description: '当前卷阶段天花板禁区' },
            opening_sequence_beats: {
                type: 'array',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        beat_label: { type: 'string' },
                        craft_focus: { type: 'string', required: true },
                        clue_budget: { type: 'string', required: true },
                        completion_sign: { type: 'string', required: true }
                    }
                },
                description: '3~5 个不绑定章号的开篇序列节拍'
            },
            unrevealed_pivots: { type: 'array', items: { type: 'string' }, description: '未揭秘拐点' },
            current_arc_envelope: { type: 'string', required: true, description: '写手可见的正向舞台常态' },
            static_base_and_voice: { type: 'string', required: true, description: '世界底层法则与句法纪律' },
            world_summary: { type: 'string', required: true, description: '开局世界观与局势摘要' },
            l0_sagas_markdown: { type: 'string', description: 'L0 纪元总表 Markdown' },
            l1_volumes_markdown: { type: 'string', required: true, description: 'L1 活跃卷级总表（必填，至少包含 1 个 vol_XX 或 第X卷 标记）' },
            entities: {
                type: 'array',
                required: true,
                items: { type: 'json' },
                description:
                    '初始实体档案列表（>=1 个）。注意 entities[] 元素内部使用 camelCase：entityId (char_*/item_*)、canonicalName (须含中文)、uniqueAliases、contextualTitles、innateLocks ([{ visibility, text }])、acquiredState ([{ storyDay<=0, visibility, slotKey?, text }])、irreversibleTrajectory ([{ storyDay<=0, text }])、recentBuffer ([{ storyDay?<=0, text }])；顶层与其余数组使用 snake_case。'
            },
            lore_entries: {
                type: 'array',
                items: { type: 'json' },
                description: '世界书词条列表（snake_case 数组项：{ id: "lore_*", title, summary, content }）'
            },
            open_threads: {
                type: 'array',
                items: { type: 'json' },
                description: '首批跨卷伏笔列表（最多 15 条，每项为 { thread_id, title, wakeup_condition }）'
            },
            future_horizon_events: {
                type: 'array',
                items: { type: 'json' },
                description: 'T0 后预定惯性事件列表（每项为 { event_id, story_day (>0), premise, description }）'
            },
            voice_samples: {
                type: 'array',
                items: { type: 'json' },
                description:
                    '声纹样本（每项为 { tag, sample, source?: "author_sample" | "boot_seed" | "chapter_harvest" }，须通过 StaticProseGate；无作者样章时可传 [] 或 3~4 条 15~45 字无角色专名的硬动作/对话 boot_seed）'
            },
            tokens_per_char: { type: 'number', description: '分词率系数（默认 0.6）' },
            narration_subjectivity: {
                type: 'string',
                enum: ['objective_third', 'subjective_first'],
                description: '叙述人称主观度（objective_third | subjective_first，默认 objective_third）'
            },
            writer_token_budget: { type: 'integer', description: '写手窗口 Token 预算上限' },
            max_auto_rollback_chapters: { type: 'integer', description: '最大自动回滚章数（>=0，0 表示关闭自动回滚，默认 3）' },
            craft_plugins: { type: 'array', items: { type: 'string' }, description: '启用的认知插件列表' },
            model_routing: { type: 'json', description: '单书模型路由覆盖表' }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    bookRoot: { type: 'string', required: true },
                    bookSlug: { type: 'string', required: true },
                    commitSha: { type: 'string', required: true },
                    entityIds: { type: 'array', required: true, items: { type: 'string' } },
                    loreIds: { type: 'array', required: true, items: { type: 'string' } },
                    voiceSampleCount: { type: 'integer', required: true },
                    filteredVoiceSampleCount: { type: 'integer', required: true },
                    halted: { type: 'boolean', required: true },
                    switchedBook: { type: 'boolean' },
                    switchConflictReason: { type: 'string' }
                }
            },
            render(_args, value) {
                if (value.switchedBook === false) {
                    return [
                        {
                            type: 'text',
                            text: `建库成功但因存在在途任务未自动切书（${value.switchConflictReason ?? '存在在途任务锁冲突'}），请在在途任务结束后手动切书：${value.bookSlug} (commit=${value.commitSha.slice(0, 8)}, 实体=${value.entityIds.length}, 声纹=${value.voiceSampleCount})`
                        }
                    ];
                }
                return [
                    {
                        type: 'text',
                        text: `开书建库完成并已停机待命：${value.bookSlug} (commit=${value.commitSha.slice(0, 8)}, 实体=${value.entityIds.length}, 声纹=${value.voiceSampleCount})`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const res = await lockCharterAndBoot(args as LockCharterAndBootInput, options);
            return {
                bookRoot: res.bookRoot,
                bookSlug: res.bookSlug,
                commitSha: res.commitSha,
                entityIds: res.entityIds,
                loreIds: res.loreIds,
                voiceSampleCount: res.voiceSampleCount,
                filteredVoiceSampleCount: res.filteredVoiceSampleCount,
                halted: res.halted,
                ...(res.switchedBook !== undefined ? { switchedBook: res.switchedBook } : {}),
                ...(res.switchConflictReason !== undefined
                    ? { switchConflictReason: res.switchConflictReason }
                    : {})
            };
        }
    });
}

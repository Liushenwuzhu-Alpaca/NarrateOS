import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { z, ZodType, ZodTypeAny } from 'zod';
import {
    computeTelemetry,
    StaticProseGate,
    stripBlockingTags,
    verifyDualQuotes
} from '../gate/index.js';
import type { GateRuleConfig, GateRuleId, GateViolation, HistoricalChapterInput } from '../gate/types.js';
import { CraftPluginLoader, type LoadedCraftPlugin } from '../plugins/index.js';
import {
    type CleanroomRequest,
    generateStructuredJson,
    type LlmPort,
    type StructuredRetryOptions,
    type TokenUsage
} from '../ports/llm.js';
import type { SystemPort } from '../ports/system.js';
import {
    PrefixAssembler,
    type PreviousChapterContext,
    type StaticPrefixInput,
    type VoiceSamplePool
} from '../prefix/index.js';
import { IndexRecall, type RecallSlice } from '../recall/index.js';
import { type SlicedView, ViewSlicer } from '../slicer/index.js';
import { BookStore } from '../store/bookstore.js';
import { serializeEntityMarkdown } from '../store/entity-parser.js';
import {
    type BookConfig,
    type BookSnapshot,
    type DirtyChapter,
    type EntityPatch,
    type TimelineMode,
    TxStateSchema
} from '../store/schemas.js';
import {
    type DownstreamConflictReport,
    type DownstreamScanOutput,
    DownstreamScanOutputSchema,
    type EngineProgressEvent,
    type EngineStageName,
    type ExtractorOutput,
    ExtractorOutputSchema,
    type FactCheckIssue,
    type FactCheckOutput,
    FactCheckOutputSchema,
    type LibrarianOutput,
    LibrarianOutputSchema,
    PlanConflictError,
    type PlannerOutline,
    PlannerOutlineSchema,
    SafeHaltError,
    type SafeHaltSnapshot,
    type StepChapterOptions,
    type StepChapterResult,
    type SyncDiffAnalysis,
    SyncDiffAnalysisSchema,
    type SyncManuscriptsOptions,
    type SyncManuscriptsResult
} from './schemas.js';

const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;

/** NarrativeEngine 构造依赖 */
export interface NarrativeEngineDeps {
    store: BookStore;
    llm: LlmPort;
    system: SystemPort;
    slicer?: ViewSlicer | undefined;
    recall?: IndexRecall | undefined;
    assembler?: PrefixAssembler | undefined;
    gate?: StaticProseGate | undefined;
    pluginLoader?: CraftPluginLoader | undefined;
    pluginSearchDirs?: string[] | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
}

function formatChapterKey(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}`;
}

function sha256Hex(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function createEmptyUsage(): TokenUsage {
    return {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0
    };
}

function addUsage(target: TokenUsage, delta: TokenUsage): void {
    target.inputTokens += delta.inputTokens;
    target.cacheReadTokens += delta.cacheReadTokens;
    target.cacheWriteTokens += delta.cacheWriteTokens;
    target.outputTokens += delta.outputTokens;
}

/** 适配带 .default() 的 Zod Schema 输出类型调用 generateStructuredJson */
async function generateJson<S extends ZodTypeAny>(
    llm: LlmPort,
    req: CleanroomRequest,
    schema: S,
    retryOptions: StructuredRetryOptions,
    signal?: AbortSignal
): Promise<{ data: z.output<S>; totalUsage: TokenUsage; attempts: number }> {
    return await generateStructuredJson(
        llm,
        req,
        schema as unknown as ZodType<z.output<S>>,
        retryOptions,
        signal
    );
}

async function readOptionalText(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

/** 将正文按非空段落切分 */
function splitParagraphs(text: string): string[] {
    return text
        .split(/\r?\n\s*\r?\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
}

/** 构造同卷零字节变动的静态前缀输入 */
function buildVolumeStaticPrefix(config: BookConfig, volumeNumber: number): StaticPrefixInput {
    return {
        volumeNumber,
        worldStaticBaseline: `书名：${config.title} (${config.book_slug})`
    };
}

/** 将 SlicedView 中的实体与召回切片序列化为审校验真语料 */
function buildVerificationCorpus(
    slicedView: SlicedView,
    recallSlices: RecallSlice[],
    previousChapter?: PreviousChapterContext
): string {
    const parts: string[] = [];
    for (const profile of Object.values(slicedView.entities)) {
        parts.push(serializeEntityMarkdown(profile));
    }
    for (const slice of recallSlices) {
        parts.push(slice.snippet);
    }
    if (previousChapter?.fullText) {
        parts.push(previousChapter.fullText);
    }
    return parts.join('\n\n');
}

/**
 * NarrateOS 核心叙事引擎
 * - 协调 Librarian -> Planner -> Writer -> Static Prose Gate -> Fact Checker -> Extractor 单章 6 步闭环
 * - 执行双粒度 WAL 提交、审校分级自愈（局部 Patch / 整章 REWRITE / PlanConflict 改纲 v2 / SAFE_HALT）
 * - 提供人机共驾手稿真源增量同步（Sync）
 */
export class NarrativeEngine {
    private readonly store: BookStore;
    private readonly llm: LlmPort;
    private readonly system: SystemPort;
    private readonly slicer: ViewSlicer;
    private readonly recall: IndexRecall;
    private readonly assembler: PrefixAssembler;
    private readonly gate: StaticProseGate;
    private readonly pluginLoader: CraftPluginLoader;
    private readonly pluginSearchDirs: string[];
    private readonly retryOptions: StructuredRetryOptions | undefined;

    constructor(deps: NarrativeEngineDeps) {
        this.store = deps.store;
        this.llm = deps.llm;
        this.system = deps.system;
        this.slicer = deps.slicer ?? new ViewSlicer();
        this.recall = deps.recall ?? new IndexRecall(deps.system);
        this.assembler = deps.assembler ?? new PrefixAssembler();
        this.gate = deps.gate ?? new StaticProseGate();
        this.pluginLoader = deps.pluginLoader ?? new CraftPluginLoader();
        this.pluginSearchDirs = deps.pluginSearchDirs ?? [];
        this.retryOptions = deps.retryOptions;
    }

    private resolveRetryOptions(config: BookConfig): StructuredRetryOptions {
        if (this.retryOptions) {
            return this.retryOptions;
        }
        return {
            maxRetries: config.structured_json_retry.max_retries,
            backoffMs: config.structured_json_retry.backoff_ms
        };
    }

    /** 加载激活的文风插件与门禁规则 */
    private async loadActivePlugins(config: BookConfig): Promise<{
        plugins: LoadedCraftPlugin[];
        gateRules: Partial<Record<GateRuleId, GateRuleConfig>>;
        plannerInjection: string;
        writerInjection: string;
    }> {
        if (config.craft_plugins.length === 0 || this.pluginSearchDirs.length === 0) {
            return {
                plugins: [],
                gateRules: {},
                plannerInjection: '',
                writerInjection: ''
            };
        }

        const plugins = await this.pluginLoader.loadForBook({
            searchDirs: this.pluginSearchDirs,
            enabledPluginIds: config.craft_plugins
        });

        return {
            plugins,
            gateRules: this.pluginLoader.mergeExtraGateRules(plugins),
            plannerInjection: this.pluginLoader.mergePromptInjection(plugins, 'planner'),
            writerInjection: this.pluginLoader.mergePromptInjection(plugins, 'writer')
        };
    }

    /** 读取声纹标本池 (.ops/voice_samples.yaml) */
    private async readVoicePool(): Promise<VoiceSamplePool | undefined> {
        const raw = await readOptionalText(join(this.store.bookRoot, '.ops/voice_samples.yaml'));
        if (!raw) return undefined;
        const parsed = parseYaml(raw) as VoiceSamplePool | null;
        if (!parsed || !Array.isArray(parsed.samples)) {
            return undefined;
        }
        return parsed;
    }

    /** 写回更新后的声纹标本池 */
    private async writeVoicePool(pool: VoiceSamplePool): Promise<void> {
        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
        await writeFile(
            join(this.store.bookRoot, '.ops/voice_samples.yaml'),
            stringifyYaml(pool, { lineWidth: 0 }),
            'utf8'
        );
    }

    /** 读取历史章原文用于跨章明喻复读检测 */
    private async loadHistoricalChapters(
        currentCh: number,
        windowSize: number
    ): Promise<HistoricalChapterInput[]> {
        const result: HistoricalChapterInput[] = [];
        const startCh = Math.max(1, currentCh - windowSize);
        for (let ch = startCh; ch < currentCh; ch += 1) {
            const path = join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(ch)}.md`);
            const text = await readOptionalText(path);
            if (text !== null) {
                result.push({ chapter: ch, text });
            }
        }
        return result;
    }

    /** 读取上一章上下文 */
    private async loadPreviousChapter(currentCh: number): Promise<PreviousChapterContext | undefined> {
        if (currentCh <= 1) return undefined;
        const prevCh = currentCh - 1;
        const prevText = await readOptionalText(
            join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(prevCh)}.md`)
        );
        if (prevText === null) return undefined;
        return {
            chapterNumber: prevCh,
            fullText: prevText
        };
    }

    /** 写入 SAFE_HALT 诊断快照并抛出 SafeHaltError */
    private async triggerSafeHalt(snapshot: SafeHaltSnapshot): Promise<never> {
        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
        await writeFile(
            join(this.store.bookRoot, '.ops/safe_halt.json'),
            `${JSON.stringify(snapshot, null, 4)}\n`,
            'utf8'
        );
        throw new SafeHaltError(snapshot);
    }

    /** 执行 Step 1: Librarian 检索选页与成对回表校验 */
    private async runLibrarian(
        snapshot: BookSnapshot,
        chapterNumber: number,
        targetDay: number,
        chapterGoal: string,
        retryOptions: StructuredRetryOptions,
        totalUsage: TokenUsage,
        signal?: AbortSignal
    ): Promise<{ librarianOut: LibrarianOutput; recallSlices: RecallSlice[] }> {
        const catalog = await this.recall.buildLibrarianCatalog(this.store.bookRoot, {
            currentVolume: snapshot.worldState.frontmatter.current_volume
        });

        const entityList = Object.values(snapshot.entities)
            .map((e) => `- ${e.metadata.entity_id}: ${e.metadata.canonical_name}`)
            .join('\n');

        const req: CleanroomRequest = {
            pool: 'fast_retrieval',
            staticPrefixBlocks: [
                '你是小说记忆库图书管理员 (Librarian)。请根据本章目标与卷目录，选出需要挂载的实体 ID 与历史原稿检索关键词，并输出 JSON。',
                catalog.staticPrefix
            ],
            dynamicTail: [
                catalog.dynamicTail,
                '',
                '## 可用实体档案列表',
                entityList || '(暂无实体)',
                '',
                `## 本章目标 (ch_${String(chapterNumber).padStart(4, '0')})`,
                chapterGoal
            ].join('\n')
        };

        const res = await generateJson(
            this.llm,
            req,
            LibrarianOutputSchema,
            retryOptions,
            signal
        );
        addUsage(totalUsage, res.totalUsage);

        const recallSlices: RecallSlice[] = [];
        const queriedIds = new Set<string>();

        for (const q of res.data.recall_queries) {
            const profile = snapshot.entities[q.entity_id];
            if (!profile) continue;
            queriedIds.add(q.entity_id);
            const slices = await this.recall.recallEntitySlices(this.store.bookRoot, {
                profile,
                targetChapter: chapterNumber,
                targetDay,
                extraKeywords: q.extra_keywords
            });
            recallSlices.push(...slices);

            // 执行成对回表校验（触发确定性挂载核对）
            await this.recall.verifyPairedRecall(this.store.bookRoot, {
                profile,
                targetChapter: chapterNumber,
                targetDay,
                extraKeywords: q.extra_keywords,
                focusChapters: q.focus_chapters
            });
        }

        return {
            librarianOut: res.data,
            recallSlices
        };
    }

    /** 执行 Step 2: Planner 结构化细纲规划 */
    private async runPlanner(
        snapshot: BookSnapshot,
        chapterNumber: number,
        targetDay: number,
        timelineMode: TimelineMode,
        povCharIds: string[],
        selectedEntityIds: string[],
        recallSlices: RecallSlice[],
        chapterGoal: string,
        staticPrefix: StaticPrefixInput,
        previousChapter: PreviousChapterContext | undefined,
        futureHorizon: string | undefined,
        opsStyleAmendments: string | undefined,
        plannerInjection: string,
        retryOptions: StructuredRetryOptions,
        totalUsage: TokenUsage,
        planConflictFeedback?: string,
        signal?: AbortSignal
    ): Promise<{ outline: PlannerOutline; plannerView: SlicedView }> {
        const plannerView = this.slicer.slice({
            snapshot,
            forRole: 'planner',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds,
            entityIds: selectedEntityIds.length > 0 ? selectedEntityIds : undefined
        });

        const goalWithFeedback = [
            chapterGoal,
            planConflictFeedback ? `\n## 必须修正的物理/因果冲突 (v2 重规划)\n${planConflictFeedback}` : '',
            plannerInjection ? `\n## 激活文风插件指导\n${plannerInjection}` : '',
            '\n请严格输出符合 PlannerOutlineSchema 的 JSON 细纲（含 chapter_title, target_word_count, focus_cast, background_cast, ending_beat, scene_plan, outline_text）。'
        ]
            .filter(Boolean)
            .join('\n');

        const assembled = this.assembler.assemblePlannerRequest({
            config: snapshot.config,
            staticPrefix,
            slicedView: plannerView,
            chapterGoal: goalWithFeedback,
            recallSlices,
            previousChapter,
            futureHorizon,
            opsStyleAmendments,
            pool: 'strong_creative'
        });

        const res = await generateJson(
            this.llm,
            assembled.request,
            PlannerOutlineSchema,
            retryOptions,
            signal
        );
        addUsage(totalUsage, res.totalUsage);

        return {
            outline: res.data,
            plannerView
        };
    }

    /** 执行 Step 3: Writer 净室单轮执笔 */
    private async runWriter(
        snapshot: BookSnapshot,
        chapterNumber: number,
        targetDay: number,
        timelineMode: TimelineMode,
        povCharIds: string[],
        selectedEntityIds: string[],
        recallSlices: RecallSlice[],
        outline: PlannerOutline,
        staticPrefix: StaticPrefixInput,
        previousChapter: PreviousChapterContext | undefined,
        opsStyleAmendments: string | undefined,
        writerInjection: string,
        voicePool: VoiceSamplePool | undefined,
        totalUsage: TokenUsage,
        signal?: AbortSignal
    ): Promise<{ prose: string; writerView: SlicedView; updatedVoicePool?: VoiceSamplePool | undefined }> {
        const writerView = this.slicer.slice({
            snapshot,
            forRole: 'writer',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds,
            entityIds: selectedEntityIds.length > 0 ? selectedEntityIds : undefined
        });

        const outlineText = [
            `标题：${outline.chapter_title}`,
            `目标字数：${outline.target_word_count}`,
            `收尾节拍：${outline.ending_beat}`,
            outline.outline_text,
            writerInjection ? `\n文风插件要求：\n${writerInjection}` : ''
        ]
            .filter(Boolean)
            .join('\n');

        const assembled = this.assembler.assembleWriterRequest({
            config: snapshot.config,
            staticPrefix,
            slicedView: writerView,
            outline: outlineText,
            focusCastIds: outline.focus_cast,
            backgroundCastIds: outline.background_cast,
            recallSlices,
            previousChapter,
            opsStyleAmendments,
            voicePool,
            preferredVoiceTag: outline.preferred_voice_tag,
            pool: 'strong_creative'
        });

        const res = await this.llm.generate(assembled.request, signal);
        addUsage(totalUsage, res.usage);

        const cleanProse = stripBlockingTags(res.text).cleanText.trim();
        return {
            prose: cleanProse,
            writerView,
            updatedVoicePool: assembled.diagnostics.updatedVoicePool
        };
    }

    /** 执行局部 Patch：仅向模型发送违规段落及其上下紧邻窗口（不重传整章） */
    private async runLocalPatch(
        prose: string,
        violatedIndices: number[],
        reason: string,
        totalUsage: TokenUsage,
        signal?: AbortSignal
    ): Promise<string> {
        const paragraphs = splitParagraphs(prose);
        if (paragraphs.length === 0 || violatedIndices.length === 0) {
            return prose;
        }

        const validIndices = violatedIndices.filter((idx) => idx >= 0 && idx < paragraphs.length);
        if (validIndices.length === 0) {
            return prose;
        }

        const minIdx = Math.min(...validIndices);
        const maxIdx = Math.max(...validIndices);
        const beforeContext = minIdx > 0 ? paragraphs[minIdx - 1] : undefined;
        const afterContext = maxIdx < paragraphs.length - 1 ? paragraphs[maxIdx + 1] : undefined;
        const targetSegments = paragraphs.slice(minIdx, maxIdx + 1);

        const req: CleanroomRequest = {
            pool: 'strong_creative',
            staticPrefixBlocks: [
                '你是小说局部修补专员。请仅重写指定的违规段落，保持前后文语境与人称连贯，只输出修改后的目标段落正文（不要输出前后文参考段落）。'
            ],
            dynamicTail: [
                `## 修补原因\n${reason}`,
                beforeContext ? `## 前文衔接参考（只读勿输出）\n${beforeContext}` : '',
                `## 需重写的目标段落\n${targetSegments.join('\n\n')}`,
                afterContext ? `## 后文衔接参考（只读勿输出）\n${afterContext}` : ''
            ]
                .filter(Boolean)
                .join('\n\n')
        };

        const res = await this.llm.generate(req, signal);
        addUsage(totalUsage, res.usage);

        const patchedClean = stripBlockingTags(res.text).cleanText.trim();
        const replacementParagraphs = splitParagraphs(patchedClean);
        if (replacementParagraphs.length === 0) {
            return prose;
        }

        const merged = [
            ...paragraphs.slice(0, minIdx),
            ...replacementParagraphs,
            ...paragraphs.slice(maxIdx + 1)
        ];
        return merged.join('\n\n');
    }

    /** 执行 Step 5: Fact Checker 审校与双侧原句验真过滤 */
    private async runFactChecker(
        snapshot: BookSnapshot,
        chapterNumber: number,
        targetDay: number,
        timelineMode: TimelineMode,
        povCharIds: string[],
        selectedEntityIds: string[],
        recallSlices: RecallSlice[],
        outline: PlannerOutline,
        prose: string,
        previousChapter: PreviousChapterContext | undefined,
        retryOptions: StructuredRetryOptions,
        totalUsage: TokenUsage,
        signal?: AbortSignal
    ): Promise<FactCheckIssue[]> {
        const auditView = this.slicer.slice({
            snapshot,
            forRole: 'fact_checker',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds,
            entityIds: selectedEntityIds.length > 0 ? selectedEntityIds : undefined
        });

        const corpusText = buildVerificationCorpus(auditView, recallSlices, previousChapter);
        const numberedParagraphs = splitParagraphs(prose)
            .map((p, idx) => `[P${idx}] ${p}`)
            .join('\n\n');

        const req: CleanroomRequest = {
            pool: 'audit',
            staticPrefixBlocks: [
                [
                    '你是冷酷字面核查员 (Fact Checker)。请核查正文是否违反物理红线、POV 视角越界或算术闭合，并严格按以下 JSON 格式输出（只输出 ```json ... ``` 代码块）：',
                    '```json',
                    '{',
                    '  "passed": true,',
                    '  "issues": [',
                    '    {',
                    '      "severity": "LOCAL_PATCH | MULTI_REWRITE | PLAN_CONFLICT",',
                    '      "paragraph_index": 0,',
                    '      "description": "具体矛盾说明",',
                    '      "quote_draft": "正文中的原句摘录",',
                    '      "quote_source": "设定或前文中的原句摘录"',
                    '    }',
                    '  ]',
                    '}',
                    '```',
                    '若核查通过无硬伤，直接输出 {"passed": true, "issues": []}。'
                ].join('\n')
            ],
            dynamicTail: [
                `## 细纲概要\n${outline.outline_text}`,
                `## 事实核查基线语料\n${corpusText}`,
                `## 待审正文（按段落索引标记）\n${numberedParagraphs}`
            ].join('\n\n')
        };

        const res = await generateJson(
            this.llm,
            req,
            FactCheckOutputSchema,
            retryOptions,
            signal
        );
        addUsage(totalUsage, res.totalUsage);

        if (res.data.passed || res.data.issues.length === 0) {
            return [];
        }

        // 双侧原句验真：过滤审校幻觉捏造引文触发的误报
        const verifiedIssues: FactCheckIssue[] = [];
        for (const issue of res.data.issues) {
            const hasDraftQuote = issue.quote_draft.trim().length > 0;
            const hasSourceQuote = issue.quote_source.trim().length > 0;

            if (hasDraftQuote && hasSourceQuote) {
                const verdict = verifyDualQuotes(
                    issue.quote_draft,
                    prose,
                    issue.quote_source,
                    corpusText
                );
                if (!verdict.passed) {
                    continue;
                }
            } else if (hasDraftQuote) {
                const verdict = verifyDualQuotes(issue.quote_draft, prose, issue.quote_draft, prose);
                if (!verdict.passed) {
                    continue;
                }
            }

            verifiedIssues.push(issue);
        }

        return verifiedIssues;
    }

    /** 执行 Step 6: Extractor 结构化抽取、遥测落盘与双粒度状态提交 */
    private async runExtractorAndCommitState(
        snapshot: BookSnapshot,
        chapterNumber: number,
        targetDay: number,
        timelineMode: TimelineMode,
        povCharIds: string[],
        prose: string,
        replanCount: number,
        rewriteCount: number,
        patchRounds: number,
        updatedVoicePool: VoiceSamplePool | undefined,
        retryOptions: StructuredRetryOptions,
        totalUsage: TokenUsage,
        signal?: AbortSignal
    ): Promise<{
        stateCommitSha: string;
        updatedEntities: string[];
        telemetry: ReturnType<typeof computeTelemetry>;
    }> {
        const extractorView = this.slicer.slice({
            snapshot,
            forRole: 'extractor',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds
        });

        const entitySummary = Object.values(extractorView.entities)
            .map((profile) => serializeEntityMarkdown(profile))
            .join('\n\n');

        const req: CleanroomRequest = {
            pool: 'fast_retrieval',
            staticPrefixBlocks: [
                [
                    '你是增量状态抽取器 (Extractor)。请根据定稿正文抽取实体补丁 (entity_patches)、故事天数推进量 (story_day_delta) 与章卡摘要 (chapter_summary)，严格按以下 JSON 格式输出（只输出 ```json ... ``` 代码块）：',
                    '```json',
                    '{',
                    '  "entity_patches": [',
                    '    {',
                    '      "entity_id": "仅限已有实体ID或char_/item_前缀ID",',
                    '      "last_seen_ch": 1,',
                    '      "acquired_state_ops": [',
                    '        { "op": "upsert_slot", "slot_key": "location", "entry": { "storyDay": 0, "visibility": "PUBLIC", "text": "状态描述" } }',
                    '      ],',
                    '      "trajectory_ops": [',
                    '        { "op": "append", "entry": { "storyDay": 0, "visibility": "PUBLIC", "text": "本章不可逆事件" } }',
                    '      ],',
                    '      "buffer_ops": [',
                    '        { "op": "append", "entry": { "storyDay": 0, "visibility": "PUBLIC", "text": "近期动作细节" } }',
                    '      ]',
                    '    }',
                    '  ],',
                    '  "story_day_delta": 0,',
                    '  "chapter_summary": "一句话概括本章核心剧情进展"',
                    '}',
                    '```',
                    '重要：勿修改先天红线(innate_locks_ops)，仅引用已存在实体 ID。'
                ].join('\n')
            ],
            dynamicTail: [
                `## 当前实体档案视图\n${entitySummary || '(暂无实体)'}`,
                `## 第 ${chapterNumber} 章定稿正文\n${prose}`
            ].join('\n\n')
        };

        const res = await generateJson(
            this.llm,
            req,
            ExtractorOutputSchema,
            retryOptions,
            signal
        );
        addUsage(totalUsage, res.totalUsage);

        const extracted: ExtractorOutput = res.data;
        const telemetry = computeTelemetry(prose);

        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
        const telemetryRecord = {
            chapter: chapterNumber,
            timestamp: new Date().toISOString(),
            replan_rate: replanCount > 0 ? 1 : 0,
            replan_count: replanCount,
            rewrite_count: rewriteCount,
            patch_rounds: patchRounds,
            metrics: telemetry,
            token_usage: totalUsage
        };
        await appendFile(
            join(this.store.bookRoot, '.ops/telemetry.jsonl'),
            `${JSON.stringify(telemetryRecord)}\n`,
            'utf8'
        );

        const extraCommitPaths: string[] = ['.ops/telemetry.jsonl'];
        if (updatedVoicePool) {
            await this.writeVoicePool(updatedVoicePool);
            extraCommitPaths.push('.ops/voice_samples.yaml');
        }

        // FLASHBACK 模式严禁推进 story_day 或覆写当前阶段游标
        const worldStateUpdate =
            timelineMode === 'FLASHBACK'
                ? undefined
                : {
                      current_chapter: Math.max(snapshot.worldState.frontmatter.current_chapter, chapterNumber),
                      story_day: snapshot.worldState.frontmatter.story_day + extracted.story_day_delta,
                      pov_character: povCharIds[0] ?? snapshot.worldState.frontmatter.pov_character,
                      timeline_mode: timelineMode,
                      summaryMarkdown: extracted.world_summary_markdown
                  };

        const patchRes = await this.store.applyStatePatch(
            chapterNumber,
            extracted.entity_patches as EntityPatch[],
            {
                worldStateUpdate,
                extraCommitPaths
            }
        );

        return {
            stateCommitSha: patchRes.sha,
            updatedEntities: patchRes.updatedEntities,
            telemetry
        };
    }

    /**
     * 执行单章 6 步闭环生产：
     * Librarian -> Planner -> Writer -> Static Prose Gate -> Fact Checker -> Extractor + 双粒度 WAL 提交
     */
    async stepChapter(options: StepChapterOptions): Promise<StepChapterResult> {
        const emit = (stage: EngineStageName, chapterNum: number, message: string): void => {
            if (!options.onProgress) return;
            try {
                const evt: EngineProgressEvent = {
                    stage,
                    chapterNumber: chapterNum,
                    message,
                    timestamp: new Date().toISOString()
                };
                options.onProgress(evt);
            } catch {
                // 避免进度回调异常影响主流程
            }
        };

        const totalUsage = createEmptyUsage();
        const recovery = await this.store.recoverWal();
        const snapshot = await this.store.loadSnapshot();
        const retryOptions = this.resolveRetryOptions(snapshot.config);

        const timelineMode = options.timelineMode ?? snapshot.worldState.frontmatter.timeline_mode;
        const povCharIds = options.povCharIds ?? [snapshot.worldState.frontmatter.pov_character];

        // 分支 A：从 FEAT_COMMITTED 崩溃恢复，直接接续 Step 6 抽取与状态提交
        if (recovery.action === 'NEEDS_STATE_EXTRACTION' && recovery.activeChapter !== null) {
            const activeCh = recovery.activeChapter;
            emit('WAL_RECOVERY', activeCh, `从 FEAT_COMMITTED 恢复第 ${activeCh} 章状态抽取`);
            const relPath = `manuscripts/${formatChapterKey(activeCh)}.md`;
            const prose = await readFile(join(this.store.bookRoot, relPath), 'utf8');
            const targetDay = options.targetDay ?? snapshot.worldState.frontmatter.story_day;

            emit('EXTRACTOR', activeCh, '增量抽取实体状态与四联遥测');
            const stateRes = await this.runExtractorAndCommitState(
                snapshot,
                activeCh,
                targetDay,
                timelineMode,
                povCharIds,
                prose,
                0,
                0,
                0,
                undefined,
                retryOptions,
                totalUsage,
                options.signal
            );

            return {
                status: 'COMMITTED',
                chapterNumber: activeCh,
                manuscriptPath: relPath,
                featCommitSha: '',
                stateCommitSha: stateRes.stateCommitSha,
                recoveredFromPhase: 'FEAT_COMMITTED',
                outline: null,
                replanCount: 0,
                rewriteCount: 0,
                patchRounds: 0,
                telemetry: stateRes.telemetry,
                totalUsage,
                updatedEntities: stateRes.updatedEntities
            };
        }

        const chapterNumber =
            options.chapterNumber ??
            Math.max(snapshot.worldState.frontmatter.current_chapter, snapshot.txState.last_committed_ch) + 1;
        const targetDay = options.targetDay ?? snapshot.worldState.frontmatter.story_day;
        const staticPrefix = buildVolumeStaticPrefix(
            snapshot.config,
            snapshot.worldState.frontmatter.current_volume
        );

        const { gateRules, plannerInjection, writerInjection } = await this.loadActivePlugins(snapshot.config);
        const previousChapter = await this.loadPreviousChapter(chapterNumber);
        const futureHorizon = (await readOptionalText(join(this.store.bookRoot, 'world/future_horizon.md'))) ?? undefined;
        const opsStyleAmendments = (await readOptionalText(join(this.store.bookRoot, '.ops/style_amendments.md'))) ?? undefined;
        const historicalChapters = await this.loadHistoricalChapters(
            chapterNumber,
            snapshot.config.prose_gate.cross_chapter_simile_window
        );
        const voicePool = await this.readVoicePool();

        // Step 1: Librarian
        emit('LIBRARIAN', chapterNumber, '构建双层目录并执行成对回表检索');
        const { librarianOut, recallSlices } = await this.runLibrarian(
            snapshot,
            chapterNumber,
            targetDay,
            options.chapterGoal,
            retryOptions,
            totalUsage,
            options.signal
        );

        let replanCount = 0;
        let rewriteCount = 0;
        let patchRounds = 0;
        let planConflictFeedback: string | undefined;

        let activeOutline: PlannerOutline;
        let activeProse = '';
        let updatedVoicePool: VoiceSamplePool | undefined;
        let lastGateViolations: GateViolation[] = [];
        let lastFactIssues: FactCheckIssue[] = [];

        // 外层：Planner -> Writer -> (Gate <-> FactChecker) 闭环
        outerLoop: while (true) {
            // Step 2: Planner
            emit('PLANNER', chapterNumber, replanCount > 0 ? '改纲重排细纲 v2' : '生成章节细纲');
            const planned = await this.runPlanner(
                snapshot,
                chapterNumber,
                targetDay,
                timelineMode,
                povCharIds,
                librarianOut.selected_entity_ids,
                recallSlices,
                options.chapterGoal,
                staticPrefix,
                previousChapter,
                futureHorizon,
                opsStyleAmendments,
                plannerInjection,
                retryOptions,
                totalUsage,
                planConflictFeedback,
                options.signal
            );
            activeOutline = planned.outline;

            // Step 3: Writer
            emit('WRITER', chapterNumber, '净室单轮执笔');
            const drafted = await this.runWriter(
                snapshot,
                chapterNumber,
                targetDay,
                timelineMode,
                povCharIds,
                librarianOut.selected_entity_ids,
                recallSlices,
                activeOutline,
                staticPrefix,
                previousChapter,
                opsStyleAmendments,
                writerInjection,
                voicePool,
                totalUsage,
                options.signal
            );
            activeProse = drafted.prose;
            updatedVoicePool = drafted.updatedVoicePool;

            // 内环：Step 4 (Static Prose Gate) <-> Step 5 (Fact Checker)
            while (true) {
                activeProse = stripBlockingTags(activeProse).cleanText.trim();

                emit('PROSE_GATE', chapterNumber, '运行 0 Token 静态文风门禁');
                const gateResult = this.gate.evaluate(activeProse, {
                    enableAntiCliche: snapshot.config.prose_gate.enable_anti_cliche,
                    enableCrossChapterSimile: snapshot.config.prose_gate.enable_cross_chapter_simile,
                    crossChapterSimileWindow: snapshot.config.prose_gate.cross_chapter_simile_window,
                    rules: gateRules,
                    historicalChapters
                });
                lastGateViolations = gateResult.violations;

                if (!gateResult.passed) {
                    if (gateResult.recommendedAction === 'PATCH' && patchRounds < 2) {
                        patchRounds += 1;
                        emit('LOCAL_PATCH', chapterNumber, `Gate 触发第 ${patchRounds} 轮局部修补`);
                        const reason = gateResult.violations
                            .map((v) => `[${v.ruleId}] ${v.message}`)
                            .join('; ');
                        activeProse = await this.runLocalPatch(
                            activeProse,
                            gateResult.violatedParagraphIndices,
                            reason,
                            totalUsage,
                            options.signal
                        );
                        continue;
                    }

                    if (rewriteCount < 1) {
                        rewriteCount += 1;
                        emit('REWRITE', chapterNumber, 'Gate 触发整章重写');
                        const rewritten = await this.runWriter(
                            snapshot,
                            chapterNumber,
                            targetDay,
                            timelineMode,
                            povCharIds,
                            librarianOut.selected_entity_ids,
                            recallSlices,
                            activeOutline,
                            staticPrefix,
                            previousChapter,
                            opsStyleAmendments,
                            writerInjection,
                            voicePool,
                            totalUsage,
                            options.signal
                        );
                        activeProse = rewritten.prose;
                        updatedVoicePool = rewritten.updatedVoicePool;
                        continue;
                    }

                    await this.triggerSafeHalt({
                        status: 'SAFE_HALT',
                        chapterNumber,
                        reason: 'Static Prose Gate 违规且已耗尽局部 Patch 与整章重写额度',
                        replanCount,
                        rewriteCount,
                        patchRounds,
                        issues: lastFactIssues,
                        gateViolations: lastGateViolations,
                        timestamp: new Date().toISOString()
                    });
                }

                // Step 5: Fact Checker
                emit('FACT_CHECKER', chapterNumber, '执行字面核查与双侧原句验真');
                const verifiedIssues = await this.runFactChecker(
                    snapshot,
                    chapterNumber,
                    targetDay,
                    timelineMode,
                    povCharIds,
                    librarianOut.selected_entity_ids,
                    recallSlices,
                    activeOutline,
                    activeProse,
                    previousChapter,
                    retryOptions,
                    totalUsage,
                    options.signal
                );
                lastFactIssues = verifiedIssues;

                if (verifiedIssues.length === 0) {
                    break outerLoop;
                }

                const planConflict = verifiedIssues.find((i) => i.severity === 'PLAN_CONFLICT');
                if (planConflict) {
                    try {
                        throw new PlanConflictError(chapterNumber, planConflict.description);
                    } catch (err) {
                        if (err instanceof PlanConflictError && replanCount < 1) {
                            replanCount += 1;
                            planConflictFeedback = err.reason;
                            continue outerLoop;
                        }
                        await this.triggerSafeHalt({
                            status: 'SAFE_HALT',
                            chapterNumber,
                            reason:
                                err instanceof PlanConflictError
                                    ? `细纲 v2 仍存在物理/因果悖论: ${err.reason}`
                                    : String(err),
                            replanCount,
                            rewriteCount,
                            patchRounds,
                            issues: lastFactIssues,
                            gateViolations: lastGateViolations,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                const hasMultiRewrite = verifiedIssues.some((i) => i.severity === 'MULTI_REWRITE');
                const patchIndices = Array.from(
                    new Set(
                        verifiedIssues.flatMap((i) => [
                            ...(i.paragraph_index !== undefined ? [i.paragraph_index] : []),
                            ...(i.paragraph_indices ?? [])
                        ])
                    )
                );

                if (!hasMultiRewrite && patchIndices.length > 0 && patchIndices.length <= 2 && patchRounds < 2) {
                    patchRounds += 1;
                    const reason = verifiedIssues.map((i) => i.description).join('; ');
                    activeProse = await this.runLocalPatch(
                        activeProse,
                        patchIndices,
                        reason,
                        totalUsage,
                        options.signal
                    );
                    continue;
                }

                if (rewriteCount < 1) {
                    rewriteCount += 1;
                    const rewritten = await this.runWriter(
                        snapshot,
                        chapterNumber,
                        targetDay,
                        timelineMode,
                        povCharIds,
                        librarianOut.selected_entity_ids,
                        recallSlices,
                        activeOutline,
                        staticPrefix,
                        previousChapter,
                        opsStyleAmendments,
                        writerInjection,
                        voicePool,
                        totalUsage,
                        options.signal
                    );
                    activeProse = rewritten.prose;
                    updatedVoicePool = rewritten.updatedVoicePool;
                    continue;
                }

                await this.triggerSafeHalt({
                    status: 'SAFE_HALT',
                    chapterNumber,
                    reason: 'Fact Checker 审校未通过且重试额度已耗尽',
                    replanCount,
                    rewriteCount,
                    patchRounds,
                    issues: lastFactIssues,
                    gateViolations: lastGateViolations,
                    timestamp: new Date().toISOString()
                });
            }
        }

        // Step 6: WAL 第 1 粒度提交 (feat 正文真源) -> Extractor -> WAL 第 2 粒度提交 (state 视图)
        await this.store.beginDraft(chapterNumber);
        const featRes = await this.store.commitDraft(chapterNumber, activeProse);

        emit('EXTRACTOR', chapterNumber, '增量抽取实体状态与四联遥测');
        const stateRes = await this.runExtractorAndCommitState(
            snapshot,
            chapterNumber,
            targetDay,
            timelineMode,
            povCharIds,
            activeProse,
            replanCount,
            rewriteCount,
            patchRounds,
            updatedVoicePool,
            retryOptions,
            totalUsage,
            options.signal
        );

        emit('COMMITTED', chapterNumber, `第 ${chapterNumber} 章双粒度提交完成`);
        return {
            status: 'COMMITTED',
            chapterNumber,
            manuscriptPath: `manuscripts/${formatChapterKey(chapterNumber)}.md`,
            featCommitSha: featRes.sha,
            stateCommitSha: stateRes.stateCommitSha,
            outline: activeOutline,
            replanCount,
            rewriteCount,
            patchRounds,
            telemetry: stateRes.telemetry,
            totalUsage,
            updatedEntities: stateRes.updatedEntities
        };
    }

    /** 仅更新 .ops/tx_state.json 中对应章节的 sha256 指纹并提交 Git */
    private async refreshChapterHashAndCommit(
        dirty: DirtyChapter,
        commitMessage: string
    ): Promise<void> {
        await this.store.withTxLock(async () => {
            const txPath = join(this.store.bookRoot, '.ops/tx_state.json');
            const current = await this.store.readTxState();
            const next = TxStateSchema.parse({
                ...current,
                last_committed_ch: Math.max(current.last_committed_ch, dirty.chapterNumber),
                chapter_hashes: {
                    ...current.chapter_hashes,
                    [dirty.chapterKey]: dirty.actualHash
                },
                updated_at: new Date().toISOString()
            });
            await writeFile(txPath, `${JSON.stringify(next, null, 4)}\n`, 'utf8');
            await this.system.commitPaths(
                this.store.bookRoot,
                [dirty.relativePath, '.ops/tx_state.json'],
                commitMessage
            );
        });
    }

    /** 计算手改章节的差异文本（优先对比 HEAD 版本与工作区当前内容） */
    private async computeChapterDiffText(dirty: DirtyChapter): Promise<{
        diffText: string;
        currentText: string;
    }> {
        const currentText = await readFile(join(this.store.bookRoot, dirty.relativePath), 'utf8');
        const headText = await this.system.readFileAtRef(this.store.bookRoot, 'HEAD', dirty.relativePath);
        if (headText === null) {
            return {
                diffText: currentText,
                currentText
            };
        }

        // 若工作区相对 HEAD 无未提交差异（用户可能已自行 commit），尝试用 SystemPort.diffFile 对比 HEAD~1..HEAD
        if (headText === currentText) {
            try {
                const gitDiff = await this.system.diffFile(
                    this.store.bookRoot,
                    'HEAD~1',
                    'HEAD',
                    dirty.relativePath
                );
                if (gitDiff.trim().length > 0) {
                    return { diffText: gitDiff, currentText };
                }
            } catch {
                // 忽略无父提交场景
            }
        }

        const oldLines = headText.split(/\r?\n/);
        const newLines = currentText.split(/\r?\n/);
        const maxLen = Math.max(oldLines.length, newLines.length);
        const diffLines: string[] = [];
        for (let i = 0; i < maxLen; i += 1) {
            const o = oldLines[i];
            const n = newLines[i];
            if (o !== n) {
                if (o !== undefined) diffLines.push(`- [L${i + 1}] ${o}`);
                if (n !== undefined) diffLines.push(`+ [L${i + 1}] ${n}`);
            }
        }

        return {
            diffText: diffLines.length > 0 ? diffLines.join('\n') : '(仅空白或换行符差异)',
            currentText
        };
    }

    /**
     * 手稿真源增量同步 (`Sync`)：
     * - 最新章纯修辞润色：零重抽，仅刷新 sha256
     * - 最新章涉及实体/事实变动：增量调用 Extractor 并提交 state(sync)
     * - 历史旧章手改：刷新该章指纹并对下游已归档章节执行只读连续性冲突扫描（严禁改写下游手稿）
     */
    async syncManuscripts(options: SyncManuscriptsOptions = {}): Promise<SyncManuscriptsResult> {
        const totalUsage = createEmptyUsage();
        const dirtyChapters = await this.store.detectDirtyChapters();
        if (dirtyChapters.length === 0) {
            return {
                status: 'CLEAN',
                dirtyChapters: [],
                updatedEntities: [],
                downstreamConflicts: [],
                totalUsage
            };
        }

        const snapshot = await this.store.loadSnapshot();
        const retryOptions = this.resolveRetryOptions(snapshot.config);
        const lastCommitted = snapshot.txState.last_committed_ch;

        // 情况 A：仅最新已提交章发生手改
        if (
            dirtyChapters.length === 1 &&
            dirtyChapters[0]?.chapterNumber === lastCommitted &&
            dirtyChapters[0].reason === 'MODIFIED'
        ) {
            const dirty = dirtyChapters[0];
            const { diffText, currentText } = await this.computeChapterDiffText(dirty);

            const diffReq: CleanroomRequest = {
                pool: 'fast_retrieval',
                staticPrefixBlocks: [
                    '你是手稿增量同步定性器。请判断本次手改差异是否仅为字词修辞润色（无剧情事实、人物位置、物品持有或数值变更），输出 JSON。'
                ],
                dynamicTail: `## ${dirty.chapterKey} 修改差异\n${diffText}`
            };

            const diffAnalysis = await generateJson(
                this.llm,
                diffReq,
                SyncDiffAnalysisSchema,
                retryOptions,
                options.signal
            );
            addUsage(totalUsage, diffAnalysis.totalUsage);

            if (diffAnalysis.data.is_prose_polish_only) {
                await this.refreshChapterHashAndCommit(
                    dirty,
                    `chore(sync): polish ${dirty.chapterKey} prose without state change`
                );
                return {
                    status: 'PROSE_POLISH_SYNCED',
                    dirtyChapters,
                    updatedEntities: [],
                    downstreamConflicts: [],
                    totalUsage
                };
            }

            // 涉及实体或剧情事实变更：增量调用 Extractor 刷新对应实体与状态
            const povCharIds = [snapshot.worldState.frontmatter.pov_character];
            const extractorView = this.slicer.slice({
                snapshot,
                forRole: 'extractor',
                targetDay: snapshot.worldState.frontmatter.story_day,
                currentCh: dirty.chapterNumber,
                timelineMode: snapshot.worldState.frontmatter.timeline_mode,
                povCharId: povCharIds
            });
            const entitySummary = Object.values(extractorView.entities)
                .map((p) => serializeEntityMarkdown(p))
                .join('\n\n');

            const extractReq: CleanroomRequest = {
                pool: 'fast_retrieval',
                staticPrefixBlocks: [
                    '你是手稿增量状态抽取器 (Sync Extractor)。请根据最新修订的手稿与差异，输出实体增量补丁与摘要 JSON。'
                ],
                dynamicTail: [
                    `## 当前实体档案视图\n${entitySummary || '(暂无实体)'}`,
                    `## 修改差异\n${diffText}`,
                    `## 修改后完整章节\n${currentText}`
                ].join('\n\n')
            };

            const extracted = await generateJson(
                this.llm,
                extractReq,
                ExtractorOutputSchema,
                retryOptions,
                options.signal
            );
            addUsage(totalUsage, extracted.totalUsage);

            await this.store.commitDraft(dirty.chapterNumber, currentText);
            const patchRes = await this.store.applyStatePatch(
                dirty.chapterNumber,
                extracted.data.entity_patches as EntityPatch[]
            );

            return {
                status: 'STATE_SYNCED',
                dirtyChapters,
                updatedEntities: patchRes.updatedEntities,
                downstreamConflicts: [],
                totalUsage
            };
        }

        // 情况 B：历史旧章手改（或存在多个手改章节）-> 刷新脏章指纹，并对下游执行只读连续性冲突扫描
        const minDirtyChapter = Math.min(...dirtyChapters.map((d) => d.chapterNumber));
        const editedSummaries: string[] = [];

        for (const dirty of dirtyChapters) {
            const { diffText, currentText } = await this.computeChapterDiffText(dirty);
            const actualHash = sha256Hex(currentText);
            await this.refreshChapterHashAndCommit(
                { ...dirty, actualHash },
                `chore(sync): refresh ${dirty.chapterKey} hash`
            );
            editedSummaries.push(`### ${dirty.chapterKey} 修订差异\n${diffText}`);
        }

        // 收集所有下游已归档章节原文（只读读取，严禁改写）
        const manuscriptsDir = join(this.store.bookRoot, 'manuscripts');
        const allFiles = (await readdir(manuscriptsDir)).filter((f) => CHAPTER_FILE_RE.test(f)).sort();
        const downstreamChapters: Array<{ chapterNumber: number; relativePath: string; text: string }> = [];

        for (const fileName of allFiles) {
            const match = CHAPTER_FILE_RE.exec(fileName);
            if (!match?.[1]) continue;
            const chNum = Number(match[1]);
            if (chNum > minDirtyChapter) {
                const relPath = `manuscripts/${fileName}`;
                const text = await readFile(join(manuscriptsDir, fileName), 'utf8');
                downstreamChapters.push({ chapterNumber: chNum, relativePath: relPath, text });
            }
        }

        if (downstreamChapters.length === 0) {
            return {
                status: 'HISTORY_SYNCED_NO_CONFLICT',
                dirtyChapters,
                updatedEntities: [],
                downstreamConflicts: [],
                totalUsage
            };
        }

        const numberedDownstream = downstreamChapters
            .map((ch) => {
                const lines = ch.text
                    .split(/\r?\n/)
                    .map((line, idx) => `L${idx + 1}: ${line}`)
                    .join('\n');
                return `### ${formatChapterKey(ch.chapterNumber)} (${ch.relativePath})\n${lines}`;
            })
            .join('\n\n');

        const scanReq: CleanroomRequest = {
            pool: 'audit',
            staticPrefixBlocks: [
                '你是只读连续性冲突扫描器。历史旧章已被作者修订，请扫描下游已归档章节是否存在与旧章修订内容冲突之处，精确标出章号、行号与原句。严禁建议自动修改下游正文。'
            ],
            dynamicTail: [
                editedSummaries.join('\n\n'),
                '## 下游已归档章节（只读扫描）',
                numberedDownstream
            ].join('\n\n')
        };

        const scanRes = await generateJson(
            this.llm,
            scanReq,
            DownstreamScanOutputSchema,
            retryOptions,
            options.signal
        );
        addUsage(totalUsage, scanRes.totalUsage);

        const downstreamMap = new Map(downstreamChapters.map((c) => [c.chapterNumber, c]));
        const conflicts: DownstreamConflictReport[] = [];

        for (const item of scanRes.data.conflicts) {
            const target = downstreamMap.get(item.chapter_number);
            if (!target) continue;

            let resolvedLine: number | null = item.line_number ?? null;
            if (item.quote.trim().length > 0) {
                const verdict = verifyDualQuotes(item.quote, target.text, item.quote, target.text);
                if (!verdict.passed) {
                    continue;
                }
                resolvedLine = verdict.sideA.lineNumber ?? resolvedLine;
            }

            conflicts.push({
                chapterNumber: item.chapter_number,
                relativePath: target.relativePath,
                lineNumber: resolvedLine,
                quote: item.quote,
                description: item.description
            });
        }

        return {
            status: conflicts.length > 0 ? 'DOWNSTREAM_CONFLICTS_FOUND' : 'HISTORY_SYNCED_NO_CONFLICT',
            dirtyChapters,
            updatedEntities: [],
            downstreamConflicts: conflicts,
            totalUsage
        };
    }
}

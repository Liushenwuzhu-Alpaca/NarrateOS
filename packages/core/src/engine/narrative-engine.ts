import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z, type ZodType, type ZodTypeAny } from 'zod';
import { OpsSignalSchema, type OpsSignal } from '../dreaming/schemas.js';
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
    type AdvanceVolumeOptions,
    type AdvanceVolumeResult,
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
    NextVolumeEnvelopeOutputSchema,
    PlanConflictError,
    type PlannerOutline,
    PlannerOutlineSchema,
    SafeHaltError,
    type SafeHaltSnapshot,
    type StepChapterOptions,
    type StepChapterResult,
    StyleMergeOutputSchema,
    type SyncDiffAnalysis,
    SyncDiffAnalysisSchema,
    type SyncManuscriptsOptions,
    type SyncManuscriptsResult,
    VolumeSealOutputSchema
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

/** 构建带新建实体 canonical_name 强校验的 Extractor Schema */
function buildExtractorSchema(snapshot: BookSnapshot) {
    const knownEntityIds = new Set<string>([
        ...Object.keys(snapshot.entities),
        ...snapshot.coldArchiveIds
    ]);
    return ExtractorOutputSchema.superRefine((data, ctx) => {
        data.entity_patches.forEach((patch, idx) => {
            if (!knownEntityIds.has(patch.entity_id)) {
                const name = patch.canonical_name?.trim();
                if (!name || name === patch.entity_id) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['entity_patches', idx, 'canonical_name'],
                        message: `首次新建实体 ${patch.entity_id} 时必须提供标准中文 canonical_name（禁止省略或直接填写英文 ID）`
                    });
                }
            }
        });
    });
}

/** 清理已有实体补丁上冗余携带的 canonical_name，防止误触 InnateLockViolationError */
function sanitizeExtractorPatches(snapshot: BookSnapshot, patches: EntityPatch[]): EntityPatch[] {
    return patches.map((patch) => {
        if (snapshot.entities[patch.entity_id] && patch.canonical_name !== undefined) {
            const { canonical_name: _ignored, ...rest } = patch;
            return rest;
        }
        return patch;
    });
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
function buildVolumeStaticPrefix(
    config: BookConfig,
    volumeNumber: number,
    staticBaseAndVoice?: string | null,
    currentArcEnvelope?: string | null
): StaticPrefixInput {
    const trimmedVoice = staticBaseAndVoice?.trim();
    const trimmedArc = currentArcEnvelope?.trim();
    return {
        volumeNumber,
        worldStaticBaseline: `书名：${config.title} (${config.book_slug})`,
        ...(trimmedVoice ? { staticBaseAndVoice: trimmedVoice } : {}),
        ...(trimmedArc ? { currentArcEnvelope: trimmedArc } : {})
    };
}

/** 过滤空内容或仅含 `# 卷中风格修订 (Ops Style Amendments)` 空标题的修订文本 */
function normalizeOpsStyleAmendments(raw: string | null): string | undefined {
    if (!raw) return undefined;
    const body = raw
        .replace(/^#\s*卷中风格修订\s*\(Ops Style Amendments\)\s*$/gm, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    if (!body) return undefined;
    return raw.trim();
}

/** 过滤空内容或仅含标题与注释的跨卷伏笔台账模板 */
function normalizeOpenThreads(raw: string | null): string | undefined {
    if (!raw) return undefined;
    const body = raw
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^#+\s*.*$/gm, '')
        .trim();
    if (!body) return undefined;
    return raw.trim();
}

/** 追加或替换 L2 卷级章卡中的单章摘要块 */
function upsertVolumeCardEntry(
    rawCardContent: string | null,
    currentVolume: number,
    chapterNumber: number,
    storyDay: number,
    chapterSummary: string
): string {
    const baseContent =
        rawCardContent && rawCardContent.trim().length > 0
            ? rawCardContent.replace(/\r\n/g, '\n')
            : `# 第 ${currentVolume} 卷双轨章卡\n\n`;
    const chKey = formatChapterKey(chapterNumber);
    const entryBlock = `## ${chKey} (day:${storyDay})\n- 主干剧情：${chapterSummary.trim()}`;
    const sectionRe = new RegExp(
        `^##\\s+${chKey}\\b[^\\n]*\\n[\\s\\S]*?(?=^##\\s+ch_\\d{4}\\b|(?![\\s\\S]))`,
        'm'
    );
    if (sectionRe.test(baseContent)) {
        const replaced = baseContent.replace(sectionRe, `${entryBlock}\n\n`);
        return `${replaced.trimEnd()}\n`;
    }
    return `${baseContent.trimEnd()}\n\n${entryBlock}\n`;
}

/** 将 SlicedView 中的实体、召回切片与卷包络序列化为审校验真语料 */
function buildVerificationCorpus(
    slicedView: SlicedView,
    recallSlices: RecallSlice[],
    previousChapter?: PreviousChapterContext,
    currentArcEnvelope?: string | null
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
    if (currentArcEnvelope && currentArcEnvelope.trim().length > 0) {
        parts.push(`## 当前卷包络与阶段禁区 (current_arc_envelope.md)\n${currentArcEnvelope.trim()}`);
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

    /** 读取声纹标本池（优先读取 .ops/voice_samples.yaml，若不存在则回退读取 world/voice_samples.yaml，并兼容归一化条目） */
    private async readVoicePool(): Promise<VoiceSamplePool | undefined> {
        const raw =
            (await readOptionalText(join(this.store.bookRoot, '.ops/voice_samples.yaml'))) ??
            (await readOptionalText(join(this.store.bookRoot, 'world/voice_samples.yaml')));
        if (!raw) return undefined;
        const parsed = parseYaml(raw) as { samples?: unknown } | null;
        if (!parsed || !Array.isArray(parsed.samples)) {
            return undefined;
        }
        const normalizedSamples = parsed.samples.flatMap((entry, idx) => {
            if (!entry || typeof entry !== 'object') return [];
            const record = entry as Record<string, unknown>;
            const rawText =
                typeof record.text === 'string' && record.text.trim().length > 0
                    ? record.text
                    : typeof record.sample === 'string' && record.sample.trim().length > 0
                      ? record.sample
                      : '';
            if (!rawText) return [];
            const id =
                typeof record.id === 'string' && record.id.trim().length > 0
                    ? record.id.trim()
                    : `voice_${String(idx + 1).padStart(2, '0')}`;
            const tag =
                typeof record.tag === 'string' && record.tag.trim().length > 0
                    ? record.tag.trim()
                    : '默认';
            const lastUsedCh =
                typeof record.last_used_ch === 'number' && Number.isFinite(record.last_used_ch)
                    ? record.last_used_ch
                    : 0;
            const useCount =
                typeof record.use_count === 'number' && Number.isFinite(record.use_count)
                    ? record.use_count
                    : 0;
            return [
                {
                    id,
                    tag,
                    text: rawText,
                    last_used_ch: lastUsedCh,
                    use_count: useCount
                }
            ];
        });
        return { samples: normalizedSamples };
    }

    /** 读取卷中风格修订（优先读取 .ops/style_amendments.md，若不存在或为空则回退读取 world/ops_style_amendments.md） */
    private async readOpsStyleAmendments(): Promise<string | undefined> {
        const primary = normalizeOpsStyleAmendments(
            await readOptionalText(join(this.store.bookRoot, '.ops/style_amendments.md'))
        );
        if (primary) return primary;
        return normalizeOpsStyleAmendments(
            await readOptionalText(join(this.store.bookRoot, 'world/ops_style_amendments.md'))
        );
    }

    /** 读取 Librarian 选中的外围设定词条 (lore_library/lore_*.md) */
    private async loadSelectedLoreEntries(selectedFiles: string[]): Promise<string[]> {
        const entries: string[] = [];
        const seen = new Set<string>();
        for (const rawName of selectedFiles) {
            const trimmed = rawName.trim();
            if (!trimmed) continue;
            const fileName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
            if (!/^lore_[a-zA-Z0-9_-]+\.md$/.test(fileName) || seen.has(fileName)) {
                continue;
            }
            seen.add(fileName);
            const content = await readOptionalText(join(this.store.bookRoot, 'lore_library', fileName));
            if (content && content.trim().length > 0) {
                entries.push(content.trim());
            }
        }
        return entries;
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

    /** 从 L2 卷级章卡中提取指定章节的摘要 */
    private async loadChapterSummaryFromCards(
        chapterNumber: number,
        currentVolume: number
    ): Promise<string | undefined> {
        const chKey = formatChapterKey(chapterNumber);
        const sectionRe = new RegExp(
            `^##\\s+${chKey}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+ch_\\d{4}\\b|(?![\\s\\S]))`,
            'm'
        );
        const candidateVolumes = currentVolume > 1 ? [currentVolume, currentVolume - 1] : [currentVolume];
        for (const vol of candidateVolumes) {
            const cardPath = join(
                this.store.bookRoot,
                `index/L2_cards/vol_${String(vol).padStart(2, '0')}_cards.md`
            );
            const raw = await readOptionalText(cardPath);
            if (!raw) continue;
            const match = raw.match(sectionRe);
            if (!match?.[1]) continue;
            const blockBody = match[1].trim();
            const mainPlotMatch = blockBody.match(/^-\s*主干剧情：\s*(.+)$/m);
            const extracted = mainPlotMatch?.[1]?.trim() || blockBody;
            if (extracted.length > 0) {
                return extracted;
            }
        }
        return undefined;
    }

    /** 读取上一章上下文（含 L2 章卡摘要） */
    private async loadPreviousChapter(
        currentCh: number,
        currentVolume: number
    ): Promise<PreviousChapterContext | undefined> {
        if (currentCh <= 1) return undefined;
        const prevCh = currentCh - 1;
        const prevText = await readOptionalText(
            join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(prevCh)}.md`)
        );
        if (prevText === null) return undefined;
        const summary = await this.loadChapterSummaryFromCards(prevCh, currentVolume);
        return {
            chapterNumber: prevCh,
            fullText: prevText,
            ...(summary ? { summary } : {})
        };
    }

    /** 读取当前章节待响应的 .ops/signals.jsonl 信号（覆盖上一章收尾与本章投递的信号） */
    private async loadActiveSignals(currentCh: number): Promise<OpsSignal[]> {
        const raw = await readOptionalText(join(this.store.bookRoot, '.ops/signals.jsonl'));
        if (!raw) return [];
        const signals: OpsSignal[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = OpsSignalSchema.safeParse(JSON.parse(trimmed));
                if (
                    parsed.success &&
                    parsed.data.chapter >= Math.max(0, currentCh - 1) &&
                    parsed.data.chapter <= currentCh
                ) {
                    signals.push(parsed.data);
                }
            } catch {
                // 忽略损坏行
            }
        }
        return signals;
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
        previousChapter: PreviousChapterContext | undefined,
        retryOptions: StructuredRetryOptions,
        totalUsage: TokenUsage,
        signal?: AbortSignal
    ): Promise<{ librarianOut: LibrarianOutput; recallSlices: RecallSlice[] }> {
        const catalog = await this.recall.buildLibrarianCatalog(this.store.bookRoot, {
            currentVolume: snapshot.worldState.frontmatter.current_volume
        });

        const entityList = Object.values(snapshot.entities)
            .map((e) => {
                const extraParts: string[] = [];
                if (e.metadata.unique_aliases.length > 0) {
                    extraParts.push(`别名: ${e.metadata.unique_aliases.join('、')}`);
                }
                if (e.metadata.contextual_titles.length > 0) {
                    extraParts.push(`称谓: ${e.metadata.contextual_titles.join('、')}`);
                }
                const suffix = extraParts.length > 0 ? ` (${extraParts.join(' | ')})` : '';
                return `- ${e.metadata.entity_id}: ${e.metadata.canonical_name}${suffix}`;
            })
            .join('\n');

        const worldSummary = snapshot.worldState.summaryMarkdown.trim();
        const prevTailSlice = previousChapter?.fullText?.trim()
            ? previousChapter.fullText.trim().slice(-600)
            : '';

        const req: CleanroomRequest = {
            pool: 'fast_retrieval',
            staticPrefixBlocks: [
                '你是小说记忆库图书管理员 (Librarian)。请根据本章目标与卷目录，选出需要挂载的实体 ID 与历史原稿检索关键词，并输出 JSON。',
                catalog.staticPrefix
            ],
            dynamicTail: [
                catalog.dynamicTail,
                ...(worldSummary ? ['', '## 当前全局局势摘要 (world_state.md)', worldSummary] : []),
                ...(prevTailSlice
                    ? ['', '## 上一章末尾片段（防漏选刚登场的道具与词条）', prevTailSlice]
                    : []),
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
        selectedLoreEntries: string[],
        chapterGoal: string,
        staticPrefix: StaticPrefixInput,
        previousChapter: PreviousChapterContext | undefined,
        futureHorizon: string | undefined,
        openThreads: string | undefined,
        opsStyleAmendments: string | undefined,
        plannerInjection: string,
        voicePool: VoiceSamplePool | undefined,
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

        const availableVoiceTags = voicePool
            ? Array.from(new Set(voicePool.samples.map((s) => s.tag.trim()).filter((t) => t.length > 0)))
            : [];

        const goalWithFeedback = [
            chapterGoal,
            openThreads ? `\n## 跨卷未解伏笔 (open_threads.md)\n${openThreads}` : '',
            availableVoiceTags.length > 0
                ? `\n## 可用声纹标签枚举 (preferred_voice_tag)\n请从以下标签中择一填入 preferred_voice_tag：${availableVoiceTags.join('、')}`
                : '',
            planConflictFeedback ? `\n## 必须修正的物理/因果冲突 (v2 重规划)\n${planConflictFeedback}` : '',
            plannerInjection ? `\n## 激活文风插件指导\n${plannerInjection}` : '',
            [
                '\n## 细纲防泄底与波折规范',
                '- director_rationale：结合 OMNISCIENT_SECRET 与 future_horizon 推演幕后因果与长期布局（该字段仅作导演内参，写手不可见）。',
                '- chapter_turn：明确本章发生的实质预期偏差、代价或认知/关系偏移，拒绝零阻力顺水推舟。',
                '- outline_text：仅写当前 POV 可见的表面动作与感官指令，未到揭秘章严禁在 outline_text 中写破底牌。',
                '- 请严格输出符合 PlannerOutlineSchema 的 JSON 细纲（含 chapter_title, target_word_count, focus_cast, background_cast, ending_beat, director_rationale, chapter_turn, scene_plan, outline_text, preferred_voice_tag）。'
            ].join('\n')
        ]
            .filter(Boolean)
            .join('\n');

        const assembled = this.assembler.assemblePlannerRequest({
            config: snapshot.config,
            staticPrefix,
            slicedView: plannerView,
            chapterGoal: goalWithFeedback,
            recallSlices,
            loreEntries: selectedLoreEntries,
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
        selectedLoreEntries: string[],
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

        // 物理丢弃 outline.director_rationale，严禁导演全知内参泄漏至写手信道
        const outlineText = [
            `标题：${outline.chapter_title}`,
            `目标字数：${outline.target_word_count}`,
            `收尾节拍：${outline.ending_beat}`,
            `本章实质波折：${outline.chapter_turn}`,
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
            loreEntries: selectedLoreEntries,
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
        currentArcEnvelope: string | undefined,
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

        const corpusText = buildVerificationCorpus(
            auditView,
            recallSlices,
            previousChapter,
            currentArcEnvelope
        );
        const numberedParagraphs = splitParagraphs(prose)
            .map((p, idx) => `[P${idx}] ${p}`)
            .join('\n\n');

        const req: CleanroomRequest = {
            pool: 'audit',
            staticPrefixBlocks: [
                [
                    '你是冷酷字面核查员 (Fact Checker)。请核查正文是否违反物理红线、POV 视角越界、算术闭合或提前揭穿 current_arc_envelope.md 中的阶段天花板禁区 (Stage Ceiling)，并严格按以下 JSON 格式输出（只输出 ```json ... ``` 代码块）：',
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
                    '若正文或细纲提前揭穿了 current_arc_envelope.md 中的 Stage Ceiling 禁区，必须直接输出 severity: "PLAN_CONFLICT"。',
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
        nextChapterOptions: string[];
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
                    '你是增量状态抽取器 (Extractor)。请根据定稿正文抽取实体补丁 (entity_patches)、故事天数推进量 (story_day_delta)、章卡摘要 (chapter_summary) 与下一章候选推进方向 (next_chapter_options)，严格按以下 JSON 格式输出（只输出 ```json ... ``` 代码块）：',
                    '```json',
                    '{',
                    '  "entity_patches": [',
                    '    {',
                    '      "entity_id": "已有实体ID，或新建char_/item_前缀ID",',
                    '      "canonical_name": "首次新建实体时必填标准中文名称（已有实体勿填）",',
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
                    '  "chapter_summary": "一句话概括本章核心剧情进展",',
                    '  "world_summary_markdown": "更新后的全局当前局势摘要（可选，当主线局势发生推进时填写）",',
                    '  "next_chapter_options": [',
                    '    "结合本章结尾悬念与当前卷目标的下一章具象推进方向 1",',
                    '    "结合本章结尾悬念与当前卷目标的下一章具象推进方向 2"',
                    '  ]',
                    '}',
                    '```',
                    '重要规则：',
                    '1. 勿修改先天红线(innate_locks_ops)；引用已有实体时不填 canonical_name，若首次新建 char_/item_ 实体则必须填写标准中文 canonical_name。',
                    '2. 若本章已正式揭晓某条隐藏秘密，请通过 acquired_state_ops 的 upsert_slot 将对应槽位的 visibility 从 OMNISCIENT_SECRET 翻转为 PUBLIC 或 READER_KNOWN。',
                    '3. 请结合本章结尾悬念与当前卷目标，输出 2~3 条具象的 next_chapter_options 候选推进方向。'
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
            buildExtractorSchema(snapshot),
            retryOptions,
            signal
        );
        addUsage(totalUsage, res.totalUsage);

        const extracted: ExtractorOutput = res.data;
        const sanitizedPatches = sanitizeExtractorPatches(
            snapshot,
            extracted.entity_patches as EntityPatch[]
        );
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

        const nextChapterOptions = extracted.next_chapter_options;
        await writeFile(
            join(this.store.bookRoot, '.ops/next_chapter_options.json'),
            `${JSON.stringify(nextChapterOptions, null, 4)}\n`,
            'utf8'
        );
        extraCommitPaths.push('.ops/next_chapter_options.json');

        // 将本章摘要写入或更新至对应卷的双轨章卡 (index/L2_cards/vol_XX_cards.md)
        const currentVolume = snapshot.worldState.frontmatter.current_volume;
        const freezeMainlineStoryDay =
            timelineMode === 'FLASHBACK' || timelineMode === 'PARALLEL';
        const nextStoryDay = freezeMainlineStoryDay
            ? targetDay
            : snapshot.worldState.frontmatter.story_day + extracted.story_day_delta;
        const cardRelPath = `index/L2_cards/vol_${String(currentVolume).padStart(2, '0')}_cards.md`;
        const cardAbsPath = join(this.store.bookRoot, cardRelPath);
        await mkdir(join(this.store.bookRoot, 'index/L2_cards'), { recursive: true });
        const existingCard = await readOptionalText(cardAbsPath);
        const updatedCard = upsertVolumeCardEntry(
            existingCard,
            currentVolume,
            chapterNumber,
            nextStoryDay,
            extracted.chapter_summary
        );
        await writeFile(cardAbsPath, updatedCard, 'utf8');
        extraCommitPaths.push(cardRelPath);

        // FLASHBACK 模式严禁推进 story_day 或覆写当前阶段游标；PARALLEL 模式不累加主线 story_day
        const worldStateUpdate =
            timelineMode === 'FLASHBACK'
                ? undefined
                : {
                      current_chapter: Math.max(snapshot.worldState.frontmatter.current_chapter, chapterNumber),
                      story_day: freezeMainlineStoryDay
                          ? snapshot.worldState.frontmatter.story_day
                          : snapshot.worldState.frontmatter.story_day + extracted.story_day_delta,
                      pov_character: povCharIds[0] ?? snapshot.worldState.frontmatter.pov_character,
                      timeline_mode: timelineMode,
                      summaryMarkdown: extracted.world_summary_markdown
                  };

        const patchRes = await this.store.applyStatePatch(
            chapterNumber,
            sanitizedPatches,
            {
                worldStateUpdate,
                extraCommitPaths
            }
        );

        return {
            stateCommitSha: patchRes.sha,
            updatedEntities: patchRes.updatedEntities,
            telemetry,
            nextChapterOptions
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
                updatedEntities: stateRes.updatedEntities,
                nextChapterOptions: stateRes.nextChapterOptions
            };
        }

        const chapterNumber =
            options.chapterNumber ??
            Math.max(snapshot.worldState.frontmatter.current_chapter, snapshot.txState.last_committed_ch) + 1;
        const targetDay = options.targetDay ?? snapshot.worldState.frontmatter.story_day;
        const [staticBaseAndVoiceRaw, currentArcEnvelopeRaw] = await Promise.all([
            readOptionalText(join(this.store.bookRoot, 'world/static_base_and_voice.md')),
            readOptionalText(join(this.store.bookRoot, 'world/current_arc_envelope.md'))
        ]);
        const staticPrefix = buildVolumeStaticPrefix(
            snapshot.config,
            snapshot.worldState.frontmatter.current_volume,
            staticBaseAndVoiceRaw,
            currentArcEnvelopeRaw
        );

        const { gateRules, plannerInjection, writerInjection } = await this.loadActivePlugins(snapshot.config);
        const previousChapter = await this.loadPreviousChapter(
            chapterNumber,
            snapshot.worldState.frontmatter.current_volume
        );
        const futureHorizon = (await readOptionalText(join(this.store.bookRoot, 'world/future_horizon.md'))) ?? undefined;
        const openThreads = normalizeOpenThreads(
            await readOptionalText(join(this.store.bookRoot, 'world/open_threads.md'))
        );
        const opsStyleAmendments = await this.readOpsStyleAmendments();
        const historicalChapters = await this.loadHistoricalChapters(
            chapterNumber,
            snapshot.config.prose_gate.cross_chapter_simile_window
        );
        const voicePool = await this.readVoicePool();
        const activeSignals = await this.loadActiveSignals(chapterNumber);

        // Step 1: Librarian
        emit('LIBRARIAN', chapterNumber, '构建双层目录并执行成对回表检索');
        const { librarianOut, recallSlices } = await this.runLibrarian(
            snapshot,
            chapterNumber,
            targetDay,
            options.chapterGoal,
            previousChapter,
            retryOptions,
            totalUsage,
            options.signal
        );
        const selectedLoreEntries = await this.loadSelectedLoreEntries(librarianOut.selected_lore_files);

        // 将 SPOTLIGHT_TRIGGER 关联的已存在实体自动并入本章挂载集合
        const spotlightEntityIds = activeSignals
            .filter((s) => s.type === 'SPOTLIGHT_TRIGGER' && s.entity_id && snapshot.entities[s.entity_id])
            .map((s) => s.entity_id!);
        const mergedSelectedEntityIds = Array.from(
            new Set([...librarianOut.selected_entity_ids, ...spotlightEntityIds])
        );

        const formattedSignalDirective =
            activeSignals.length > 0 && !options.chapterGoal.includes('[待响应运维信号]')
                ? [
                      '## 待响应运维与切镜信号 (.ops/signals.jsonl)',
                      ...activeSignals.map((s) =>
                          s.type === 'SPOTLIGHT_TRIGGER'
                              ? `- [SPOTLIGHT_TRIGGER] 实体 ${s.entity_id ?? '(未指定)'} (建议模式: ${s.suggested_mode ?? 'MAINLINE'}): ${s.reason}（请优先通过前台碰撞让该角色/势力实质介入当前现场，或在必要时切镜呈现，严禁幕后略过）`
                              : `- [RETCON 圆回指令] (${s.conflict_id ?? '细节修正'}): ${s.reason}（请在本章顺带自然圆回该细节偏差）`
                      )
                  ].join('\n')
                : '';
        const effectivePlannerInjection = [plannerInjection, formattedSignalDirective]
            .filter(Boolean)
            .join('\n\n');

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
                mergedSelectedEntityIds,
                recallSlices,
                selectedLoreEntries,
                options.chapterGoal,
                staticPrefix,
                previousChapter,
                futureHorizon,
                openThreads,
                opsStyleAmendments,
                effectivePlannerInjection,
                voicePool,
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
                mergedSelectedEntityIds,
                recallSlices,
                selectedLoreEntries,
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
                            mergedSelectedEntityIds,
                            recallSlices,
                            selectedLoreEntries,
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
                    mergedSelectedEntityIds,
                    recallSlices,
                    activeOutline,
                    activeProse,
                    previousChapter,
                    staticPrefix.currentArcEnvelope,
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
                        mergedSelectedEntityIds,
                        recallSlices,
                        selectedLoreEntries,
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
            updatedEntities: stateRes.updatedEntities,
            nextChapterOptions: stateRes.nextChapterOptions
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
                buildExtractorSchema(snapshot),
                retryOptions,
                options.signal
            );
            addUsage(totalUsage, extracted.totalUsage);

            await this.store.commitDraft(dirty.chapterNumber, currentText);
            const patchRes = await this.store.applyStatePatch(
                dirty.chapterNumber,
                sanitizeExtractorPatches(snapshot, extracted.data.entity_patches as EntityPatch[])
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

    /**
     * 五步原子换卷或全书完结封笔 (全程在 store.withTxLock 保护下执行)
     */
    async advanceVolume(options: AdvanceVolumeOptions = {}): Promise<AdvanceVolumeResult> {
        return await this.store.withTxLock(async () => {
            const completeBook = Boolean(options.completeBook);
            const config = await this.store.readBookConfig();
            const retryOptions = this.resolveRetryOptions(config);
            const worldState = await this.store.readWorldState();
            const sealedVolume = worldState.frontmatter.current_volume;
            const nextVolume = completeBook ? sealedVolume : sealedVolume + 1;
            const sealedVolPad = String(sealedVolume).padStart(2, '0');
            const nextVolPad = String(nextVolume).padStart(2, '0');
            const tagName = `arc-seal-vol-${sealedVolPad}`;

            // Step 1: 封存旧卷 -> 更新 L1_volumes.md 收束摘要与 story_day 跨度，打封存 tag，新建下卷章卡
            const l1Path = join(this.store.bookRoot, 'index/L1_volumes.md');
            const l1Current = (await readOptionalText(l1Path)) ?? '# L1 活跃卷级总表\n\n';
            const sealedCardsPath = join(this.store.bookRoot, `index/L2_cards/vol_${sealedVolPad}_cards.md`);
            const sealedCardsText = (await readOptionalText(sealedCardsPath)) ?? '';

            const sealReq: CleanroomRequest = {
                pool: 'fast_retrieval',
                staticPrefixBlocks: [
                    '你是长篇小说卷级归档编纂器。请根据当前卷章卡与卷级总表，输出本卷简明收束摘要 (volume_summary) 与故事日跨度 (story_day_span) JSON。'
                ],
                dynamicTail: [
                    `## 当前卷号\n第 ${sealedVolume} 卷 (当前 story_day: ${worldState.frontmatter.story_day})`,
                    `## index/L1_volumes.md\n${l1Current}`,
                    `## index/L2_cards/vol_${sealedVolPad}_cards.md\n${sealedCardsText || '(暂无章卡记录)'}`
                ].join('\n\n')
            };
            const sealRes = await generateJson(
                this.llm,
                sealReq,
                VolumeSealOutputSchema,
                retryOptions,
                options.signal
            );
            const sealBlock = [
                `## 第 ${sealedVolume} 卷封存摘要 (vol_${sealedVolPad}) [story_day: ${sealRes.data.story_day_span}]`,
                sealRes.data.volume_summary.trim()
            ].join('\n');
            await mkdir(join(this.store.bookRoot, 'index'), { recursive: true });
            await writeFile(l1Path, `${l1Current.trimEnd()}\n\n${sealBlock}\n`, 'utf8');

            await this.system.createTag(
                this.store.bookRoot,
                tagName,
                `Seal volume ${sealedVolume}`
            );

            if (!completeBook) {
                const cardsDir = join(this.store.bookRoot, 'index/L2_cards');
                await mkdir(cardsDir, { recursive: true });
                const nextCardsPath = join(cardsDir, `vol_${nextVolPad}_cards.md`);
                if ((await readOptionalText(nextCardsPath)) === null) {
                    await writeFile(nextCardsPath, `# 第 ${nextVolume} 卷双轨章卡\n\n`, 'utf8');
                }
            }

            // Step 2: 冷宫归档非随行角色 (保留主角与 companionEntityIds，不移动 item_* 等非角色文件)
            const keepSet = new Set<string>([
                worldState.frontmatter.pov_character,
                ...(options.companionEntityIds ?? [])
            ]);
            const entitiesDir = join(this.store.bookRoot, 'entities');
            const coldArchiveDir = join(entitiesDir, 'cold_archive');
            const archivedEntities: string[] = [];

            let entityFiles: string[] = [];
            try {
                entityFiles = await readdir(entitiesDir);
            } catch (err: unknown) {
                if ((err as { code?: string }).code !== 'ENOENT') {
                    throw err;
                }
            }

            for (const fileName of entityFiles.sort()) {
                if (!/^char_.*\.md$/.test(fileName)) continue;
                const entityId = fileName.slice(0, -3);
                if (keepSet.has(entityId)) continue;
                await mkdir(coldArchiveDir, { recursive: true });
                await rename(join(entitiesDir, fileName), join(coldArchiveDir, fileName));
                archivedEntities.push(entityId);
            }

            // Step 3: 提炼风格修订 -> 合入 static_base_and_voice.md (<= 1500 字) 并清空修订表
            const opsStylePath = join(this.store.bookRoot, '.ops/style_amendments.md');
            const worldStylePath = join(this.store.bookRoot, 'world/ops_style_amendments.md');
            const opsAmendment = normalizeOpsStyleAmendments(await readOptionalText(opsStylePath));
            const worldAmendment = normalizeOpsStyleAmendments(await readOptionalText(worldStylePath));
            const combinedAmendments = [opsAmendment, worldAmendment]
                .filter((s): s is string => Boolean(s))
                .join('\n\n');

            if (combinedAmendments.length > 0) {
                const voiceBasePath = join(this.store.bookRoot, 'world/static_base_and_voice.md');
                const currentVoiceBase = (await readOptionalText(voiceBasePath)) ?? '';
                const mergeReq: CleanroomRequest = {
                    pool: 'fast_retrieval',
                    staticPrefixBlocks: [
                        '你是长篇小说文风基线提炼器。请将卷中风格修订去重压缩并合入 static_base_and_voice.md，输出 JSON 字段 merged_markdown，总字数严格控制在 1500 字以内。'
                    ],
                    dynamicTail: [
                        `## 当前 world/static_base_and_voice.md\n${currentVoiceBase || '(空)'}`,
                        `## 新增风格修订\n${combinedAmendments}`
                    ].join('\n\n')
                };
                const mergeRes = await generateJson(
                    this.llm,
                    mergeReq,
                    StyleMergeOutputSchema,
                    retryOptions,
                    options.signal
                );
                const truncated =
                    mergeRes.data.merged_markdown.length > 1500
                        ? mergeRes.data.merged_markdown.slice(0, 1500)
                        : mergeRes.data.merged_markdown;
                await mkdir(join(this.store.bookRoot, 'world'), { recursive: true });
                await writeFile(voiceBasePath, truncated, 'utf8');

                if ((await readOptionalText(opsStylePath)) !== null) {
                    await writeFile(opsStylePath, '# 卷中风格修订 (Style Amendments)\n\n', 'utf8');
                }
                if ((await readOptionalText(worldStylePath)) !== null) {
                    await writeFile(worldStylePath, '# 卷中风格修订 (Ops Style Amendments)\n\n', 'utf8');
                }
            }

            // Step 4: 完结封笔 vs 新卷包络编译
            const threadsPath = join(this.store.bookRoot, 'world/open_threads.md');
            const openThreadsText = (await readOptionalText(threadsPath)) ?? '';

            if (completeBook) {
                if (openThreadsText.trim().length > 0) {
                    const sealedThreads = markOpenThreadsAsOpenEnding(openThreadsText);
                    await writeFile(threadsPath, sealedThreads, 'utf8');
                }
            } else {
                const l0Text = (await readOptionalText(join(this.store.bookRoot, 'index/L0_sagas.md'))) ?? '';
                const updatedL1Text = (await readOptionalText(l1Path)) ?? '';
                const horizonPath = join(this.store.bookRoot, 'world/future_horizon.md');
                const currentHorizon = (await readOptionalText(horizonPath)) ?? '';

                const survivingParts: string[] = [];
                for (const fileName of entityFiles.sort()) {
                    if (!fileName.endsWith('.md')) continue;
                    const entityId = fileName.slice(0, -3);
                    if (fileName.startsWith('char_') && !keepSet.has(entityId)) continue;
                    const raw = await readOptionalText(join(entitiesDir, fileName));
                    if (raw) survivingParts.push(raw.trim());
                }

                const envelopeReq: CleanroomRequest = {
                    pool: 'strong_creative',
                    staticPrefixBlocks: [
                        '你是长篇小说卷级大纲编译器。请基于 L0 纪元总表、L1 卷级总表、存活角色档案与未解伏笔，编译下一卷的 current_arc_envelope（含新舞台冲突、跨图锚点与新 Stage Ceiling）以及 future_horizon 惯性事件，输出 JSON。'
                    ],
                    dynamicTail: [
                        `## 目标卷号\n第 ${nextVolume} 卷`,
                        `## index/L0_sagas.md\n${l0Text || '(暂无)'}`,
                        `## index/L1_volumes.md\n${updatedL1Text}`,
                        `## 存活角色与道具档案\n${survivingParts.join('\n\n') || '(暂无)'}`,
                        `## world/open_threads.md\n${openThreadsText || '(暂无)'}`,
                        `## 当前 world/future_horizon.md\n${currentHorizon || '(暂无)'}`
                    ].join('\n\n')
                };
                const envelopeRes = await generateJson(
                    this.llm,
                    envelopeReq,
                    NextVolumeEnvelopeOutputSchema,
                    retryOptions,
                    options.signal
                );
                await mkdir(join(this.store.bookRoot, 'world'), { recursive: true });
                await writeFile(
                    join(this.store.bookRoot, 'world/current_arc_envelope.md'),
                    `${envelopeRes.data.current_arc_envelope.trimEnd()}\n`,
                    'utf8'
                );
                await writeFile(
                    horizonPath,
                    `${envelopeRes.data.future_horizon.trimEnd()}\n`,
                    'utf8'
                );
            }

            // Step 5: 递增卷号并执行原子 Git 提交
            if (!completeBook) {
                worldState.frontmatter.current_volume = nextVolume;
                await this.store.writeWorldState(worldState);
            }

            const commitMsg = completeBook
                ? 'chore(volume): complete book'
                : `chore(volume): advance to vol_${nextVolPad}`;
            const { sha: commitSha } = await this.system.commitPaths(this.store.bookRoot, ['.'], commitMsg);

            if (completeBook) {
                await this.system.createTag(this.store.bookRoot, 'novel-completed', 'Novel completed');
            }

            return {
                sealedVolume,
                nextVolume,
                tagName,
                archivedEntities,
                completedBook: completeBook,
                commitSha
            };
        });
    }
}

/** 将 open_threads.md 中仍处于活跃区的未解伏笔标记为 [status: OPEN_ENDING] */
function markOpenThreadsAsOpenEnding(markdown: string): string {
    const lines = markdown.split(/\r?\n/);
    let inResolvedSection = false;
    const out = lines.map((line) => {
        if (/^##\s+.*(Resolved Archive|已回收伏笔)/i.test(line)) {
            inResolvedSection = true;
            return line;
        }
        if (/^##\s+/.test(line)) {
            inResolvedSection = false;
            return line;
        }
        if (inResolvedSection) {
            return line;
        }
        if (/status:\s*ACTIVE/i.test(line)) {
            return line.replace(/status:\s*ACTIVE/gi, 'status: OPEN_ENDING');
        }
        if (/^\s*-\s+/.test(line) && !/status:\s*(OPEN_ENDING|RESOLVED)/i.test(line)) {
            return line.replace(/^(\s*-\s+)/, '$1[status: OPEN_ENDING] ');
        }
        return line;
    });
    return out.join('\n');
}

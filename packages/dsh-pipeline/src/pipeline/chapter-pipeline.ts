import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    analyzeParagraphs,
    BookRepairLoopConfigSchema,
    computeTelemetry,
    CraftPluginLoader,
    IndexRecall,
    formatCrossEntityKnownEntries,
    normalizeForQuoteMatch,
    ParallelSandbox,
    readChapterDays,
    parseL2CardSections,
    parseVoiceSamplesYaml,
    PlannerOutlineSchema,
    PrefixAssembler,
    renderEntityProfile,
    sampleVoiceLru,
    sanitizeLoreForWriter,
    serializeEntityMarkdown,
    sliceWorldDocuments,
    StaticProseGate,
    stripBlockingTags,
    stripWriterRestrictedDirectives,
    traceArtifact,
    traceEvent,
    ViewSlicer,
    withTraceRun,
    withTraceStage,
    type BookSnapshot,
    type BookStore,
    type CraftPluginDefinition,
    type EntityPatch,
    type EntityProfile,
    type ForkParallelWindowOptions,
    type GateRuleConfig,
    type GateRuleId,
    type GateViolation,
    type HistoricalChapterInput,
    type LoadedCraftPlugin,
    type LlmPort,
    type MergeParallelWindowOptions,
    type ParallelBranchDelta,
    type ParallelL2CardEntry,
    type PlannerOutline,
    type PreviousChapterContext,
    type ProseGateOptions,
    type ProseGateResult,
    type RecallSlice,
    type SlicedView,
    type StaticPrefixInput,
    type SystemPort,
    type TimelineMode,
    type TokenUsage,
    type VoiceSamplePool
} from '@narrateos/dsh-book-store';
import { GATE_POSITIVE_GUIDANCE } from '@narrateos/dsh-book-tools';
import type {
    FactCheckIssue,
    FactCheckOutput,
    YieldContextPackResult,
    YieldPatchedDraftResult,
    YieldStatePatchResult
} from '@narrateos/dsh-book-tools';
import { PlanConflictError, SafeHaltError, ValidationError, type SafeHaltSnapshot } from '../errors.js';
import type { RoleLoader } from '../roles/role-loader.js';
import type { RoleRunner } from '../runner/role-runner.js';
import {
    OpsSignalSchema,
    type EngineProgressEvent,
    type EngineStageName,
    type OpsSignal,
    type StageSessionEvent,
    type StepChapterOptions,
    type StepChapterResult,
    type WriterAssemblyReport
} from '../schemas.js';
import {
    addUsage,
    buildVerificationCorpus,
    buildVolumeStaticPrefix,
    collectEntityDisplayNames,
    createEmptyUsage,
    formatChapterKey,
    formatVolumeCardRelPath,
    isAbortError,
    normalizeOpenThreads,
    readCombinedStyleAmendments,
    readOptionalText,
    sha256Hex,
    readSignalsCursorState,
    resolveConsumedSignalIds,
    resolveSignalId,
    sanitizeExtractorPatches,
    splitNonEmptyLines,
    upsertVolumeCardEntry,
    wakeColdArchiveEntitiesInMemory,
    writeNextChapterOptions,
    writeSignalsCursorState
} from './helpers.js';
import { harvestVoiceWithPool } from './voice-harvest.js';
import { resolveWriterGateRules } from './craft-gate.js';
import { settleConfirmedLedger } from './ledger-settlement.js';

export interface ChapterPipelineDeps {
    store: BookStore;
    roleRunner: RoleRunner;
    roleLoader: RoleLoader;
    llm: LlmPort;
    system: SystemPort;
    slicer?: ViewSlicer | undefined;
    recall?: IndexRecall | undefined;
    assembler?: PrefixAssembler | undefined;
    gate?: StaticProseGate | undefined;
    pluginLoader?: CraftPluginLoader | undefined;
    pluginSearchDirs?: string[] | undefined;
}

function formatOpsSignalLine(signal: OpsSignal): string {
    if (signal.type === 'SPOTLIGHT_TRIGGER') {
        return `- [SPOTLIGHT_TRIGGER] 实体 ${signal.entity_id ?? '(未指定)'} (建议模式: ${signal.suggested_mode ?? 'MAINLINE'}): ${signal.reason}（请优先通过前台碰撞让该角色/势力实质介入当前现场，或在必要时切镜呈现，严禁幕后略过）`;
    }
    if (signal.type === 'RETCON') {
        return `- [RETCON 圆回指令] (${signal.conflict_id ?? '细节修正'}): ${signal.reason}（请在本章顺带自然圆回该细节偏差）`;
    }
    return `- [DIRECTOR_NOTE 微调指令]: ${signal.reason}`;
}

function invokeSafeCallback<T>(cb: ((arg: T) => void) | undefined, arg: T): void {
    if (!cb) return;
    try {
        cb(arg);
    } catch {
        // 避免诊断回调异常中断主流程
    }
}

function buildSelectedVoiceSampleSummary(
    sample: { id: string; tag: string; source?: string | undefined } | null | undefined
): WriterAssemblyReport['selectedVoiceSample'] {
    if (!sample) return null;
    return {
        id: sample.id,
        tag: sample.tag,
        ...(sample.source !== undefined ? { source: sample.source } : {})
    };
}


const DEFAULT_REPAIR_LOOP_CFG = BookRepairLoopConfigSchema.parse({});

export const GATE_MAX_PATCH_PARAGRAPHS = 15;
export const CLEANROOM_PATCH_FALLBACK_REASON =
    '请紧扣给定自然段与定位提示，重构人物动作细节、对话神态与场景衔接节奏';

const RESTRICTED_DIRECTIVE_CLAUSE_RE =
    /OMNISCIENT_SECRET|\bWARPED\b|\bSELF_ONLY(?:_[A-Z0-9_]*)?\b|CHARTER_SECRET|DIRECTOR_SECRET|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale|author_charter|arc_director_plan/i;

const RESTRICTED_SOURCE_REF_RE =
    /(?:^|\/)(?:world\/)?(?:author_charter\.md|arc_director_plan\.md|future_horizon\.md)$/i;

export function resolveDefaultEngineCraftPluginDir(): string {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    return resolve(currentDir, '../../dist/assets/plugins/craft');
}

function isRestrictedFactQuoteSource(
    issue: FactCheckIssue,
    snapshot?: BookSnapshot,
    writerView?: SlicedView
): boolean {
    const ref = issue.source_ref?.trim().replace(/\\/g, '/');
    if (ref && RESTRICTED_SOURCE_REF_RE.test(ref)) {
        return true;
    }
    if (issue.quote_source && RESTRICTED_DIRECTIVE_CLAUSE_RE.test(issue.quote_source)) {
        return true;
    }
    if (snapshot && writerView && ref && issue.quote_source) {
        const normQuote = normalizeForQuoteMatch(issue.quote_source);
        if (normQuote.length > 0 && ref.startsWith('entities/')) {
            const entityId = ref.replace(/^entities\/(?:cold_archive\/)?/, '').replace(/\.md$/, '');
            const visibleProfile = writerView.entities[entityId];
            const visibleRendered = visibleProfile
                ? renderEntityProfile(visibleProfile, { compactCard: false, stripWarped: true, cleanroomDisplay: true })
                : formatCrossEntityKnownEntries({
                    ...writerView,
                    crossEntityKnownEntries: writerView.crossEntityKnownEntries.filter((item) => item.entityId === entityId)
                }, true);
            if (!normalizeForQuoteMatch(visibleRendered).includes(normQuote)) {
                return true;
            }

            const rawProfile = snapshot.entities[entityId] ?? snapshot.coldEntities[entityId];
            if (rawProfile) {
                if (rawProfile.metadata.status === 'WARPED') {
                    return true;
                }
                const povSet = new Set(writerView.povCharIds);
                const allRawEntries = [
                    ...rawProfile.innateLocks,
                    ...rawProfile.acquiredState,
                    ...rawProfile.irreversibleTrajectory,
                    ...rawProfile.recentBuffer
                ];
                const hitsRestricted = allRawEntries.some((entry) => {
                    const entryText = [entry.text, ...entry.continuationLines].join(' ');
                    const isRestricted =
                        entry.status === 'WARPED' ||
                        entry.visibility === 'OMNISCIENT_SECRET' ||
                        entry.rawInvalidVisibility !== undefined ||
                        (entry.visibility === 'SELF_ONLY' &&
                            !(entry.owner ?? entityId).split(',').some((owner) => povSet.has(owner.trim()))) ||
                        /\b(?:OMNISCIENT_SECRET|WARPED)\b/i.test(entryText) ||
                        (/\bSELF_ONLY\b/i.test(entryText) &&
                            !(entry.owner ?? entityId).split(',').some((owner) => povSet.has(owner.trim())));
                    if (!isRestricted) return false;
                    return normalizeForQuoteMatch(entryText).includes(normQuote);
                });
                if (hitsRestricted) {
                    return true;
                }
            }
        }
    }
    return false;
}

/** 剥离全知/废止/禁区信息并正向转写，确保净室写手与修补专员零泄露、零负面黑名单词 */
export function sanitizeTextForCleanroomWriter(raw: string, stripStyleTerms = true): string {
    const rawClauses = raw
        .split(/(?<=[。；;\n])/)
        .map((c) => c.trim())
        .filter((c) => c.length > 0 && !RESTRICTED_DIRECTIVE_CLAUSE_RE.test(c));

    const cleanedClauses: string[] = [];
    for (const clause of rawClauses) {
        const rewritten = clause
            .replace(
                /(?:请\s*)?(?:禁止|严禁|不要|不得|切忌|绝不|决不|不能|不可|避免|切勿|莫要|勿)/g,
                '请调整'
            )
            .replace(/(?:必须|务必|千万|绝对)/g, '请确保')
            .replace(/(?:哪怕|就算|即便)/g, '即使')
            .replace(
                /(?:指节泛白|喉结(?:上下)?滚动|瞳孔(?:微缩|地震)|睫毛轻颤|指甲陷进掌心|眼眶泛起水汽|青筋暴起|指节|喉结|瞳孔|睫毛|表皮|角质|毛细血管|心率|肾上腺素|一丝|一抹)/g,
                (match) => stripStyleTerms ? '' : match
            )
            .replace(/(?:""|''|“”|‘’|「」|『』|（）|\(\)|\[\])/g, '')
            .replace(/[：:]\s*(?=[。；;\n]|$)/g, '')
            .replace(/([，,、])\s*[，,、]+/g, '$1')
            .replace(/^[，,、；;：:\s]+/, '')
            .replace(/[，,、：:\s]+(?=[。；;\n]|$)/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (/[\p{L}\p{N}]/u.test(rewritten)) {
            cleanedClauses.push(rewritten);
        }
    }

    return cleanedClauses.join(' ').trim();
}

/** 将静态门禁超标规则正向转写为写手重写的具象写作目标 */
function buildPositiveGateRewriteFeedback(gateResult: ProseGateResult): string {
    const ruleIds = Array.from(
        new Set(
            gateResult.exceededRules.length > 0
                ? gateResult.exceededRules
                : gateResult.violations.map((v) => v.ruleId)
        )
    );
    const directives = ruleIds.map(
        (id) =>
            GATE_POSITIVE_GUIDANCE[id] ??
            '以具体人物动作、感官白描与生活化口语对白重新组织当前段落。'
    );
    return [
        '保持细纲既定场景节奏、事件因果与人物落点，重点强化以下正向写作目标：',
        ...directives.map((d) => `- ${d}`)
    ].join('\n');
}

/** 将 FactChecker 审校问题脱敏并正向转写为写手重写的事实对齐目标 */
function buildPositiveFactRewriteFeedback(
    issues: readonly FactCheckIssue[],
    snapshot?: BookSnapshot,
    writerView?: SlicedView
): string {
    const lines: string[] = [];
    for (const issue of issues) {
        if (issue.severity === 'PLAN_CONFLICT') continue;
        const cleanDesc = sanitizeTextForCleanroomWriter(issue.description);
        if (!cleanDesc) continue;
        const cleanSource =
            issue.quote_source && !isRestrictedFactQuoteSource(issue, snapshot, writerView)
                ? sanitizeTextForCleanroomWriter(issue.quote_source)
                : '';
        lines.push(
            `- 依循前文现场与档案事实校准叙事：${cleanDesc}${cleanSource ? `（对照基准：${cleanSource}）` : ''}`
        );
    }
    if (lines.length === 0) {
        lines.push('- 依循已交付的前文现场与角色档案，逐段核实空间站位、时间顺序与物品流转并重写本章。');
    }
    return [
        '保持视角人物当前实时感知边界与细纲推进方向，逐项校准以下事实与动作衔接目标：',
        ...lines
    ].join('\n');
}

function splitParagraphs(text: string): string[] {
    return analyzeParagraphs(text).paragraphs;
}

/**
 * 校验并兜底补全章首 `# <标题名称>` 行：
 * - 若首行非空文本已匹配 `/^#\s+\S/` 则原样保留；
 * - 否则剥离 `chapterTitle` 前导 `第X章` 编号（空标题兜底为章节数字），在正文顶端拼接 `# ${headingText}\n\n`。
 */
export function ensureChapterHeading(
    prose: string,
    chapterNumber: number,
    chapterTitle?: string
): string {
    const trimmed = prose.trim();
    if (!trimmed) throw new Error('写手未输出有效正文文本');
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (/^#\s+\S/.test(firstLine)) {
        return trimmed;
    }
    const strippedTitle = (chapterTitle ?? '')
        .trim()
        .replace(/^第[0-9零一二三四五六七八九十百千万两]+章[：:\s-]*/, '')
        .trim();
    const headingText = strippedTitle.length > 0 ? strippedTitle : String(chapterNumber);
    return `# ${headingText}\n\n${trimmed}`;
}

/** 从当前卷 L2_cards Markdown 中提取最近至多 limit 条章节卡片 */
function extractRecentL2Cards(rawCardContent: string | null, limit = 2): string {
    if (limit <= 0 || !rawCardContent || rawCardContent.trim().length === 0) {
        return '';
    }
    const normalized = rawCardContent.replace(/\r\n/g, '\n');
    const entryMatches = [
        ...normalized.matchAll(/^##\s+ch_\d{4}\b[\s\S]*?(?=^##\s+ch_\d{4}\b|(?![\s\S]))/gm)
    ];
    if (entryMatches.length === 0) {
        return '';
    }
    return entryMatches
        .slice(-limit)
        .map((m) => m[0].trim())
        .filter((block) => block.length > 0)
        .join('\n\n');
}

function buildPositiveGatePatchReason(gateResult: ProseGateResult): string {
    const ruleIds = Array.from(
        new Set(
            gateResult.exceededRules.length > 0
                ? gateResult.exceededRules
                : gateResult.violations.map((v) => v.ruleId)
        )
    );
    const directives = ruleIds.map(
        (id) =>
            GATE_POSITIVE_GUIDANCE[id] ??
            '以具体人物动作、感官白描与生活化口语对白重新组织当前段落。'
    );
    return directives.join('；') || CLEANROOM_PATCH_FALLBACK_REASON;
}

function filterL2CardByAllowedChapters(
    rawCardContent: string | null,
    allowedChapterNums: ReadonlySet<number>,
    volumeNumber: number
): string {
    if (!rawCardContent || rawCardContent.trim().length === 0) {
        return `# 第 ${volumeNumber} 卷双轨章卡\n\n`;
    }
    const normalized = rawCardContent.replace(/\r\n/g, '\n');
    const firstSectionIdx = normalized.search(/^##\s+ch_\d{4}\b/m);
    const preamble =
        firstSectionIdx >= 0 ? normalized.slice(0, firstSectionIdx).trimEnd() : normalized.trimEnd();
    const sections = [
        ...normalized.matchAll(/^##\s+ch_(\d{4})\b[\s\S]*?(?=^##\s+ch_\d{4}\b|(?![\s\S]))/gm)
    ]
        .filter((m) => allowedChapterNums.has(Number(m[1])))
        .map((m) => m[0].trim());
    return [preamble, ...sections].filter(Boolean).join('\n\n') + '\n';
}

function mergeParallelCardEntries(
    baseContent: string | null,
    volumeNumber: number,
    entries: readonly ParallelL2CardEntry[]
): string {
    let content = baseContent ?? `# 第 ${volumeNumber} 卷双轨章卡\n\n`;
    const sorted = [...entries]
        .filter((e) => e.volumeNumber === volumeNumber)
        .sort((a, b) => a.chapterNumber - b.chapterNumber);
    for (const entry of sorted) {
        content = upsertVolumeCardEntry(
            content,
            entry.volumeNumber,
            entry.chapterNumber,
            entry.storyDay,
            entry.plotSummary,
            entry.appearanceEntityIds,
            entry.proseAnchors
        );
    }
    return content;
}

/**
 * 单章 6 阶段生产管线：
 * - 多轮探查工种 (`Librarian`, `Planner`, `Fact Checker`, `Extractor`) 经 RoleRunner.runMultiTurn (ctx.agents.create + yield_*) 执行；
 * - 文学执笔 (`Writer`, 含 `WRITER` / `REWRITE`) 经 RoleRunner.runCleanroom（零工具单轮净室会话）执行，局部修补 (`Patch`) 经纯内存多轮段落编辑闭环 (`patch_paragraphs` + `yield_patched_draft`) 执行，均物理剥离禁区、隐秘视图与宿主指令；
 * - 完整支持双粒度 WAL 提交与 FEAT_COMMITTED 崩溃恢复、Voice Pool LRU 轮换与 PARALLEL 并行沙盒。
 */
export class ChapterPipeline {
    private readonly store: BookStore;
    private readonly roleRunner: RoleRunner;
    private readonly roleLoader: RoleLoader;
    private readonly llm: LlmPort;
    private readonly system: SystemPort;
    private readonly slicer: ViewSlicer;
    private readonly recall: IndexRecall;
    private readonly assembler: PrefixAssembler;
    private readonly gate: StaticProseGate;
    private readonly pluginLoader: CraftPluginLoader;
    private readonly pluginSearchDirs: string[];

    constructor(deps: ChapterPipelineDeps) {
        this.store = deps.store;
        this.roleRunner = deps.roleRunner;
        this.roleLoader = deps.roleLoader;
        this.llm = deps.llm;
        this.system = deps.system;
        this.slicer = deps.slicer ?? new ViewSlicer();
        this.recall = deps.recall ?? new IndexRecall(deps.system);
        this.assembler = deps.assembler ?? new PrefixAssembler();
        this.gate = deps.gate ?? new StaticProseGate();
        this.pluginLoader = deps.pluginLoader ?? new CraftPluginLoader();
        this.pluginSearchDirs =
            deps.pluginSearchDirs && deps.pluginSearchDirs.length > 0
                ? deps.pluginSearchDirs
                : [resolveDefaultEngineCraftPluginDir(), join(deps.store.bookRoot, 'plugins')];
    }

    async forkParallelWindow(options: ForkParallelWindowOptions) {
        return await new ParallelSandbox(this.store, this.system).forkWindow(options);
    }

    async mergeParallelWindow(options: MergeParallelWindowOptions) {
        return await new ParallelSandbox(this.store, this.system).mergeWindow(options);
    }

    async stepChapter(options: StepChapterOptions): Promise<StepChapterResult> {
        return await withTraceRun(
            this.store.bookRoot,
            'step',
            {
                chapter: options.chapterNumber,
                window: options.parallelWindowId,
                branch: options.parallelBranchId,
                timeline: options.timelineMode
            },
            () => this.store.withTxLock(() => this.stepChapterLocked(options))
        );
    }

    private async stepChapterLocked(options: StepChapterOptions): Promise<StepChapterResult> {
        const emit = (
            stage: EngineStageName,
            chapterNum: number,
            message: string,
            extra?: { activeSessionId?: string; runId?: string }
        ): void => {
            void traceEvent('progress', { stage, chapter: chapterNum, message });
            if (stage === 'WAL_RECOVERY') {
                void traceEvent('run.context', { chapter: chapterNum });
            }
            if (!options.onProgress) return;
            try {
                const evt: EngineProgressEvent = {
                    stage,
                    chapterNumber: chapterNum,
                    message,
                    timestamp: new Date().toISOString(),
                    ...(extra?.activeSessionId ? { activeSessionId: extra.activeSessionId } : {}),
                    ...(extra?.runId ? { runId: extra.runId } : {})
                };
                options.onProgress(evt);
            } catch {
                // 避免进度回调异常中断主流程
            }
        };

        const totalUsage = createEmptyUsage();
        const recovery = await this.store.recoverWal();
        let snapshot = await this.store.loadSnapshot();

        const recoveredContext =
            recovery.action === 'NEEDS_STATE_EXTRACTION'
                ? snapshot.txState.chapter_context
                : undefined;
        const nextChapter = Math.max(snapshot.worldState.frontmatter.current_chapter, snapshot.txState.last_committed_ch) + 1;
        const chapterNumber = options.chapterNumber ?? nextChapter;
        const lookbackChapters = snapshot.config.ops_and_sync?.signal_lookback_chapters ?? 1;
        const signalPlan = recovery.action === 'NEEDS_STATE_EXTRACTION' ? undefined
            : await this.loadActiveSignals(chapterNumber, lookbackChapters);
        const flashbackNote = snapshot.worldState.frontmatter.timeline_mode !== 'PARALLEL'
            ? signalPlan?.signals.findLast((s) => s.type === 'DIRECTOR_NOTE' && s.suggested_mode === 'FLASHBACK')
            : undefined;
        const timelineMode: TimelineMode =
            recoveredContext?.timelineMode ??
            options.timelineMode ??
            (flashbackNote ? 'FLASHBACK' : undefined) ??
            snapshot.worldState.frontmatter.timeline_mode;
        const povCharIds =
            recoveredContext?.povCharIds ??
            options.povCharIds ??
            [snapshot.worldState.frontmatter.pov_character];
        const windowId = recoveredContext?.parallelWindowId ?? options.parallelWindowId;
        const branchId = recoveredContext?.parallelBranchId ?? options.parallelBranchId;
        const parallel =
            timelineMode === 'PARALLEL' && windowId && branchId
                ? { windowId, branchId }
                : undefined;

        await traceEvent('run.context', {
            timeline: timelineMode,
            window: windowId,
            branch: branchId
        });

        if (timelineMode === 'PARALLEL') {
            if (!parallel) {
                throw new Error('PARALLEL 需要 parallelWindowId 与 parallelBranchId');
            }
            snapshot = await new ParallelSandbox(
                this.store,
                this.system
            ).loadBranchSnapshot(snapshot, parallel.windowId, parallel.branchId);
        } else if (snapshot.worldState.frontmatter.timeline_mode === 'PARALLEL') {
            throw new Error('并行窗口必须先显式合并，才能恢复主线推进');
        }

        const branchStagingOverlay = parallel
            ? await this.buildParallelStagingOverlay(snapshot, parallel)
            : undefined;
        const targetDay = recoveredContext?.targetDay ?? options.targetDay ??
            (timelineMode === 'FLASHBACK' ? flashbackNote?.target_day : undefined) ?? snapshot.worldState.frontmatter.story_day;
        let allowedChapterFiles = parallel ? snapshot.chapterFiles : undefined;
        if (timelineMode === 'FLASHBACK') {
            const days = await this.recall.resolveChapterDayMap(this.store.bookRoot, snapshot.chapterFiles,
                await readChapterDays(this.store.bookRoot));
            allowedChapterFiles = snapshot.chapterFiles.filter((file) => {
                const chapterDay = days.get(Number(file.slice(3, -3)));
                return chapterDay !== undefined && chapterDay <= targetDay;
            });
        }

        // 崩溃恢复：处于 FEAT_COMMITTED 时跳过生成直接补跑 Extractor 与 state 提交
        if (recovery.action === 'NEEDS_STATE_EXTRACTION' && recovery.activeChapter !== null) {
            return await this.recoverFromFeatCommitted({
                activeCh: recovery.activeChapter,
                snapshot,
                recoveredContext,
                timelineMode,
                povCharIds,
                totalUsage,
                options,
                parallel,
                allowedChapterFiles,
                branchStagingOverlay,
                emit
            });
        }

        if (parallel) {
            await new ParallelSandbox(this.store, this.system).assertChapterCapacity(parallel.windowId);
        }
        if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1 || chapterNumber > 9999) {
            throw new Error('章号必须是 1 至 9999 的整数');
        }
        if (parallel ? chapterNumber < nextChapter : chapterNumber !== nextChapter) {
            throw new Error(parallel
                ? '并行章号必须大于已提交章号，禁止覆盖主线或其他支线章节'
                : `新章必须按发表顺序推进，下一个章号为 ${nextChapter}`);
        }
        await traceEvent('run.context', { chapter: chapterNumber });

        if (!Number.isSafeInteger(targetDay) ||
            (timelineMode !== 'FLASHBACK' && targetDay < snapshot.worldState.frontmatter.story_day)) {
            throw new Error('目标故事日无效，非插叙章节不能倒退时钟');
        }
        const [
            staticBaseAndVoiceRaw,
            currentArcEnvelopeRaw,
            authorCharterRaw,
            arcDirectorPlanRaw
        ] = await Promise.all([
            this.store.readStaticBaseAndVoice(),
            this.store.readCurrentArcEnvelope(),
            this.store.readAuthorCharter(),
            this.store.readArcDirectorPlan()
        ]);

        // 写手静态前缀仅使用经 ViewSlicer 净室剥离后的正向文档（不重复拼接 writer.md）
        const writerRoleCfg = await this.roleLoader.loadRoleConfig('writer', this.store.bookRoot);
        if (!writerRoleCfg.cleanroom) {
            throw new Error('writer 角色配置必须保持 cleanroom: true');
        }

        const writerWorldDocs = sliceWorldDocuments('writer', {
            authorCharter: authorCharterRaw,
            arcDirectorPlan: arcDirectorPlanRaw,
            currentArcEnvelope: currentArcEnvelopeRaw,
            staticBaseAndVoice: staticBaseAndVoiceRaw
        });
        const writerStaticPrefix = buildVolumeStaticPrefix(
            snapshot.config,
            snapshot.worldState.frontmatter.current_volume,
            writerWorldDocs.staticBaseAndVoice,
            writerWorldDocs.currentArcEnvelope
        );
        const plannerStaticPrefix = buildVolumeStaticPrefix(
            snapshot.config,
            snapshot.worldState.frontmatter.current_volume,
            staticBaseAndVoiceRaw,
            currentArcEnvelopeRaw
        );

        const { plugins, gateRules, customPlugins } = await this.loadActivePlugins(snapshot.config);
        // FLASHBACK 模式下物理屏蔽主线上一章尾窗正文，防止诱导续写未来现场
        const previousChapter =
            timelineMode === 'FLASHBACK'
                ? undefined
                : await this.loadPreviousChapter(
                      chapterNumber,
                      snapshot.worldState.frontmatter.current_volume,
                      snapshot.chapterFiles,
                      branchStagingOverlay
                  );
        const futureHorizon = (await this.store.readFutureHorizon()) ?? undefined;
        const openThreads = normalizeOpenThreads(await this.store.readOpenThreads());
        const opsStyleAmendments = await this.readOpsStyleAmendments();
        const historicalChapters = await this.loadHistoricalChapters(
            chapterNumber,
            snapshot.config.prose_gate.cross_chapter_simile_window,
            allowedChapterFiles ?? snapshot.chapterFiles
        );
        const voicePool = await this.readVoicePool();
        const activeSignals = signalPlan?.signals ?? [];

        // Step 1: Librarian (多轮受控探查 -> yield_context_pack)
        emit('LIBRARIAN', chapterNumber, '构建双层目录并执行成对回表检索');
        const { payload: librarianOut, recalledSlices: recallSlices, selectedLoreEntries, selectedLoreSources } = await this.runLibrarian(
            snapshot,
            chapterNumber,
            targetDay,
            timelineMode,
            options.chapterGoal,
            previousChapter,
            totalUsage,
            options,
            allowedChapterFiles,
            branchStagingOverlay
        );

        const spotlightEntityIds = activeSignals
            .filter((s) => s.type === 'SPOTLIGHT_TRIGGER' && Boolean(s.entity_id))
            .map((s) => s.entity_id!);

        const wokenColdIds = new Set<string>();
        // 冷宫返场唤醒：将 Librarian 选中/唤醒及 POV/切镜涉及的冷宫实体临时加载入本章快照与内存覆盖层
        snapshot = await wakeColdArchiveEntitiesInMemory(
            this.store,
            snapshot,
            [
                ...povCharIds,
                ...librarianOut.wakeup_entity_ids,
                ...librarianOut.selected_entity_ids,
                ...spotlightEntityIds
            ],
            wokenColdIds
        );
        let effectiveStagingOverlay = this.buildEffectiveStagingOverlay(
            branchStagingOverlay,
            snapshot,
            wokenColdIds
        );

        const mergedSelectedEntityIds = Array.from(
            new Set([
                ...librarianOut.selected_entity_ids,
                ...librarianOut.wakeup_entity_ids,
                ...spotlightEntityIds.filter((id) => Boolean(snapshot.entities[id]))
            ])
        );

        const formattedSignalDirective =
            activeSignals.length > 0 && !options.chapterGoal.includes('[待响应运维信号]')
                ? [
                      '## 待响应运维与切镜信号 (.ops/signals.jsonl)',
                      ...activeSignals.map(formatOpsSignalLine)
                  ].join('\n')
                : '';

        const repairLoop = snapshot.config.repair_loop ?? DEFAULT_REPAIR_LOOP_CFG;
        let totalReplans = 0;
        let totalRewrites = 0;
        let totalPatchRounds = 0;
        let writerAttempt = 0;
        let planConflictFeedback: string | undefined;

        let activeOutline: PlannerOutline;
        let activeProse = '';
        let activeCastSelectedIds = mergedSelectedEntityIds;
        let updatedVoicePool: VoiceSamplePool | undefined;
        let latestWriterAssemblyReport: WriterAssemblyReport | undefined;
        let lastGateViolations: GateViolation[] = [];
        let lastFactIssues: FactCheckIssue[] = [];
        let factConfirmations: { completed_beats: string[]; resolved_threads: string[] } | undefined;
        let reviewFocus: { issues: FactCheckIssue[]; paragraphs: number[] } | undefined;

        outerLoop: while (true) {
            let outlineRewriteCount = 0;
            let draftGatePatchRounds = 0;
            let draftFactPatchRounds = 0;
            let skipNextProseGate = false;

            // Step 2: Planner (多轮受控点查 -> yield_outline)
            const plannerStage: 'PLANNER' | 'REPLAN' = totalReplans > 0 ? 'REPLAN' : 'PLANNER';
            const plannerAttempt = totalReplans + 1;
            emit(
                plannerStage,
                chapterNumber,
                totalReplans > 0 ? '改纲重排细纲 v2' : '生成章节细纲'
            );
            const planned = await this.runPlanner({
                snapshot,
                chapterNumber,
                targetDay,
                timelineMode,
                povCharIds,
                selectedEntityIds: activeCastSelectedIds,
                recallSlices,
                selectedLoreEntries,
                chapterGoal: options.chapterGoal,
                staticPrefix: plannerStaticPrefix,
                previousChapter,
                futureHorizon,
                openThreads,
                opsStyleAmendments,
                authorCharter: authorCharterRaw,
                arcDirectorPlan: arcDirectorPlanRaw,
                signalDirective: formattedSignalDirective,
                customPlugins,
                voicePool,
                planConflictFeedback,
                totalUsage,
                stage: plannerStage,
                attempt: plannerAttempt,
                triggerReason: totalReplans > 0 ? 'FACT_PLAN_CONFLICT' : undefined,
                allowedChapterFiles,
                stagingOverlay: effectiveStagingOverlay,
                signal: options.signal,
                onStageSession: options.onStageSession
            });
            activeOutline = planned.outline;

            // 校验 preferred_voice_tag 属于当前声纹池已有标签集
            if (
                activeOutline.preferred_voice_tag !== undefined &&
                voicePool &&
                voicePool.samples.length > 0 &&
                !voicePool.samples.some((s) => s.tag === activeOutline.preferred_voice_tag)
            ) {
                throw new ValidationError(
                    `preferred_voice_tag (${activeOutline.preferred_voice_tag}) 不在当前声纹池已有标签集内`
                );
            }

            // 将 Planner 点查补入的 focus_cast / background_cast 唤醒并并入下游可见实体集与内存覆盖层
            const plannerCastIds = [...activeOutline.focus_cast, ...activeOutline.background_cast];
            snapshot = await wakeColdArchiveEntitiesInMemory(
                this.store,
                snapshot,
                plannerCastIds,
                wokenColdIds
            );
            effectiveStagingOverlay = this.buildEffectiveStagingOverlay(
                branchStagingOverlay,
                snapshot,
                wokenColdIds
            );
            activeCastSelectedIds = Array.from(
                new Set([...activeCastSelectedIds, ...plannerCastIds])
            );

            // Step 3: Writer (净室单轮无工具 Agent)
            writerAttempt += 1;
            emit('WRITER', chapterNumber, '净室单轮 Agent 执笔');
            const drafted = await this.runWriter({
                snapshot,
                chapterNumber,
                targetDay,
                timelineMode,
                povCharIds,
                selectedEntityIds: activeCastSelectedIds,
                recallSlices,
                selectedLoreEntries,
                outline: activeOutline,
                staticPrefix: writerStaticPrefix,
                rolePrompt: writerRoleCfg.promptText,
                previousChapter,
                opsStyleAmendments,
                customPlugins,
                voicePool,
                totalUsage,
                traceStage: 'writer',
                attempt: writerAttempt,
                signal: options.signal,
                onStageSession: options.onStageSession
            });
            activeProse = drafted.prose;
            let activeWriterView = drafted.writerView;
            updatedVoicePool = drafted.updatedVoicePool;
            latestWriterAssemblyReport = drafted.assemblyReport;
            invokeSafeCallback(options.onWriterAssembled, drafted.assemblyReport);

            while (true) {
                activeProse = ensureChapterHeading(
                    stripBlockingTags(activeProse).cleanText.trim(),
                    chapterNumber,
                    activeOutline.chapter_title
                );

                const proseGateOptions: ProseGateOptions = {
                    enableAntiCliche: snapshot.config.prose_gate.enable_anti_cliche,
                    enableCrossChapterSimile:
                        snapshot.config.prose_gate.enable_cross_chapter_simile,
                    crossChapterSimileWindow:
                        snapshot.config.prose_gate.cross_chapter_simile_window,
                    narrationSubjectivity: snapshot.config.narration_subjectivity,
                    maxPatchParagraphs: repairLoop.gate_max_patch_paragraphs,
                    maxPatchParagraphRatio: repairLoop.gate_max_patch_ratio,
                    rules: gateRules,
                    historicalChapters
                };

                if (!skipNextProseGate) {
                    // Step 4: StaticProseGate (0 Token)
                    emit('PROSE_GATE', chapterNumber, '运行 0 Token 静态文风门禁');
                    await traceArtifact('draft.before_gate', activeProse);
                    const gateResult = await withTraceStage('prose_gate', async () =>
                        this.gate.evaluate(activeProse, proseGateOptions)
                    );
                    lastGateViolations = gateResult.violations;
                    const gateTelemetry = computeTelemetry(activeProse);
                    invokeSafeCallback(options.onGateResult, {
                        chapter: chapterNumber,
                        passed: gateResult.passed,
                        violations: gateResult.violations,
                        recommendedAction: gateResult.recommendedAction,
                        metrics: gateTelemetry
                    });
                    await traceArtifact('prose_gate.result', gateResult);
                    await traceEvent('gate.result', {
                        passed: gateResult.passed,
                        violations: gateResult.violations.length,
                        action: gateResult.recommendedAction
                    });

                    if (!gateResult.passed) {
                        const paragraphCount = Math.max(1, splitParagraphs(activeProse).length);
                        const violatedCount = gateResult.violatedParagraphIndices.length;
                        const canPatchGate =
                            violatedCount > 0 &&
                            violatedCount <= repairLoop.gate_max_patch_paragraphs &&
                            violatedCount / paragraphCount <= repairLoop.gate_max_patch_ratio &&
                            draftGatePatchRounds < repairLoop.gate_max_patch_rounds;

                        let patchedSucceeded = false;
                        if (canPatchGate) {
                            draftGatePatchRounds += 1;
                            totalPatchRounds += 1;
                            emit(
                                'LOCAL_PATCH',
                                chapterNumber,
                                `Gate 触发第 ${totalPatchRounds} 轮局部修补`
                            );
                            const positiveGateReason = buildPositiveGatePatchReason(gateResult);
                            const patched = await this.tryRunLocalPatch({
                                snapshot,
                                writerView: activeWriterView,
                                staticBaseAndVoice: writerWorldDocs.staticBaseAndVoice,
                                outline: activeOutline,
                                chapterNumber,
                                prose: activeProse,
                                violatedIndices: gateResult.violatedParagraphIndices,
                                reason: positiveGateReason,
                                totalUsage,
                                proseGateOptions,
                                violations: gateResult.violations,
                                attempt: totalPatchRounds,
                                triggerReason: `PROSE_GATE: ${gateResult.exceededRules.join(',') || 'VIOLATION'}`,
                                signal: options.signal,
                                onStageSession: options.onStageSession
                            });
                            if (patched !== null) {
                                activeProse = patched;
                                patchedSucceeded = true;
                            }
                        }

                        if (patchedSucceeded) {
                            continue;
                        }

                        if (
                            outlineRewriteCount < repairLoop.max_rewrites_per_outline &&
                            totalRewrites < repairLoop.max_total_rewrites_per_chapter
                        ) {
                            outlineRewriteCount += 1;
                            totalRewrites += 1;
                            draftGatePatchRounds = 0;
                            draftFactPatchRounds = 0;
                            skipNextProseGate = false;
                            emit('REWRITE', chapterNumber, 'Gate 触发整章重写');
                            const rewritten = await this.executeRewrite({
                                snapshot,
                                chapterNumber,
                                targetDay,
                                timelineMode,
                                povCharIds,
                                selectedEntityIds: activeCastSelectedIds,
                                recallSlices,
                                selectedLoreEntries,
                                outline: activeOutline,
                                staticPrefix: writerStaticPrefix,
                                rolePrompt: writerRoleCfg.promptText,
                                previousChapter,
                                opsStyleAmendments,
                                customPlugins,
                                voicePool,
                                totalUsage,
                                rewriteFeedback: buildPositiveGateRewriteFeedback(gateResult),
                                attempt: totalRewrites,
                                triggerReason: `PROSE_GATE: ${gateResult.exceededRules.join(',') || 'VIOLATION'}`,
                                signal: options.signal,
                                onStageSession: options.onStageSession
                            });
                            activeProse = rewritten.prose;
                            activeWriterView = rewritten.writerView;
                            updatedVoicePool = rewritten.updatedVoicePool;
                            latestWriterAssemblyReport = rewritten.assemblyReport;
                            invokeSafeCallback(options.onWriterAssembled, rewritten.assemblyReport);
                            continue;
                        }

                        await this.triggerSafeHalt({
                            status: 'SAFE_HALT',
                            chapterNumber,
                            reason: 'Static Prose Gate 违规且已耗尽局部 Patch 与整章重写额度',
                            replanCount: totalReplans,
                            rewriteCount: totalRewrites,
                            patchRounds: totalPatchRounds,
                            issues: lastFactIssues,
                            gateViolations: lastGateViolations,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
                skipNextProseGate = false;

                // Step 5: Fact Checker (多轮受控查证 -> yield_verdict)
                emit('FACT_CHECKER', chapterNumber, '执行字面核查与双侧原句验真');
                const verdict = await this.runFactChecker(
                    snapshot,
                    chapterNumber,
                    targetDay,
                    timelineMode,
                    povCharIds,
                    activeCastSelectedIds,
                    recallSlices,
                    activeOutline,
                    activeProse,
                    previousChapter,
                    currentArcEnvelopeRaw,
                    arcDirectorPlanRaw,
                    authorCharterRaw,
                    totalUsage,
                    this.pluginLoader.mergePromptInjection(plugins, 'fact_checker'),
                    options,
                    allowedChapterFiles,
                    effectiveStagingOverlay,
                    selectedLoreSources,
                    reviewFocus
                );
                const verifiedIssues = verdict.issues;
                reviewFocus = undefined;
                lastFactIssues = verifiedIssues;
                invokeSafeCallback(options.onCheckerResult, {
                    chapter: chapterNumber,
                    passed: verifiedIssues.length === 0,
                    issueCount: verifiedIssues.length,
                    issues: verifiedIssues,
                    replanCount: totalReplans,
                    rewriteCount: totalRewrites,
                    patchRounds: totalPatchRounds
                });

                if (verdict.passed) {
                    factConfirmations = {
                        completed_beats: verdict.confirmed_completed_beats ?? [],
                        resolved_threads: verdict.confirmed_resolved_threads ?? []
                    };
                    break outerLoop;
                }

                const planConflict = verifiedIssues.find((i) => i.severity === 'PLAN_CONFLICT');
                if (planConflict) {
                    try {
                        throw new PlanConflictError(chapterNumber, planConflict.description);
                    } catch (err) {
                        if (
                            err instanceof PlanConflictError &&
                            totalReplans < repairLoop.max_replans_per_chapter
                        ) {
                            totalReplans += 1;
                            planConflictFeedback = err.reason;
                            emit('REPLAN', chapterNumber, `细纲存在悖论，退回重排 v2: ${err.reason}`);
                            continue outerLoop;
                        }
                        await this.triggerSafeHalt({
                            status: 'SAFE_HALT',
                            chapterNumber,
                            reason:
                                err instanceof PlanConflictError
                                    ? `细纲 v2 仍存在物理/因果悖论: ${err.reason}`
                                    : String(err),
                            replanCount: totalReplans,
                            rewriteCount: totalRewrites,
                            patchRounds: totalPatchRounds,
                            issues: lastFactIssues,
                            gateViolations: lastGateViolations,
                            timestamp: new Date().toISOString()
                        });
                    }
                }

                const hasMultiRewrite = verifiedIssues.some(
                    (i) => i.severity === 'MULTI_REWRITE'
                );
                const patchIndices = Array.from(
                    new Set(
                        verifiedIssues.flatMap((i) => [
                            ...(i.paragraph_index !== undefined ? [i.paragraph_index] : []),
                            ...(i.paragraph_indices ?? [])
                        ])
                    )
                );
                const paragraphCount = Math.max(1, splitParagraphs(activeProse).length);
                const canPatchFact =
                    !hasMultiRewrite &&
                    patchIndices.length > 0 &&
                    patchIndices.length <= repairLoop.fact_max_patch_paragraphs &&
                    (patchIndices.length < 2 ||
                        patchIndices.length / paragraphCount <= repairLoop.fact_max_patch_ratio) &&
                    draftFactPatchRounds < repairLoop.fact_max_patch_rounds;

                let factPatchedSucceeded = false;
                if (canPatchFact) {
                    draftFactPatchRounds += 1;
                    totalPatchRounds += 1;
                    emit(
                        'LOCAL_PATCH',
                        chapterNumber,
                        `Fact Checker 触发第 ${totalPatchRounds} 轮局部修补`
                    );
                    const reason = verifiedIssues.map((i) => i.description).join('; ');
                    const patched = await this.tryRunLocalPatch({
                        snapshot,
                        writerView: activeWriterView,
                        staticBaseAndVoice: writerWorldDocs.staticBaseAndVoice,
                        outline: activeOutline,
                        chapterNumber,
                        prose: activeProse,
                        violatedIndices: patchIndices,
                        reason,
                        totalUsage,
                        proseGateOptions,
                        factIssues: verifiedIssues,
                        attempt: totalPatchRounds,
                        triggerReason: `FACT_CHECKER: ${reason}`,
                        signal: options.signal,
                        onStageSession: options.onStageSession
                    });
                    if (patched !== null) {
                        activeProse = patched;
                        reviewFocus = { issues: verifiedIssues, paragraphs: patchIndices };
                        // yield_patched_draft 已通过相同 StaticProseGate 复检，直接回 FactChecker 复核
                        skipNextProseGate = true;
                        factPatchedSucceeded = true;
                    }
                }

                if (factPatchedSucceeded) {
                    continue;
                }

                if (
                    outlineRewriteCount < repairLoop.max_rewrites_per_outline &&
                    totalRewrites < repairLoop.max_total_rewrites_per_chapter
                ) {
                    outlineRewriteCount += 1;
                    totalRewrites += 1;
                    draftGatePatchRounds = 0;
                    draftFactPatchRounds = 0;
                    skipNextProseGate = false;
                    emit('REWRITE', chapterNumber, 'Fact Checker 触发整章重写');
                    const rewritten = await this.executeRewrite({
                        snapshot,
                        chapterNumber,
                        targetDay,
                        timelineMode,
                        povCharIds,
                        selectedEntityIds: activeCastSelectedIds,
                        recallSlices,
                        selectedLoreEntries,
                        outline: activeOutline,
                        staticPrefix: writerStaticPrefix,
                        rolePrompt: writerRoleCfg.promptText,
                        previousChapter,
                        opsStyleAmendments,
                        customPlugins,
                        voicePool,
                        totalUsage,
                        rewriteFeedback: buildPositiveFactRewriteFeedback(
                            verifiedIssues,
                            snapshot,
                            activeWriterView
                        ),
                        attempt: totalRewrites,
                        triggerReason: `FACT_CHECKER: ${verifiedIssues.map((i) => i.severity).join(',')}`,
                        signal: options.signal,
                        onStageSession: options.onStageSession
                    });
                    activeProse = rewritten.prose;
                    activeWriterView = rewritten.writerView;
                    updatedVoicePool = rewritten.updatedVoicePool;
                    latestWriterAssemblyReport = rewritten.assemblyReport;
                    invokeSafeCallback(options.onWriterAssembled, rewritten.assemblyReport);
                    continue;
                }

                await this.triggerSafeHalt({
                    status: 'SAFE_HALT',
                    chapterNumber,
                    reason: 'Fact Checker 审校未通过且重试额度已耗尽',
                    replanCount: totalReplans,
                    rewriteCount: totalRewrites,
                    patchRounds: totalPatchRounds,
                    issues: lastFactIssues,
                    gateViolations: lastGateViolations,
                    timestamp: new Date().toISOString()
                });
            }
        }

        // Step 6: WAL 第 1 粒度提交 (feat + outline snapshot) -> Extractor -> WAL 第 2 粒度提交 (state)
        activeProse = ensureChapterHeading(
            activeProse,
            chapterNumber,
            activeOutline.chapter_title
        );
        const signalCursorUpdate =
            !options.chapterGoal.includes('[待响应运维信号]') && signalPlan?.hasCursorChanges
                ? signalPlan.nextCursorState
                : undefined;

        await this.store.beginDraft(chapterNumber);
        const featRes = await this.store.commitDraft(
            chapterNumber,
            activeProse,
            {
                timelineMode,
                targetDay,
                povCharIds,
                signalCursorUpdate,
                ...(factConfirmations ? { fact_confirmations: factConfirmations } : {}),
                ...(parallel
                    ? {
                          parallelWindowId: parallel.windowId,
                          parallelBranchId: parallel.branchId
                      }
                    : {})
            },
            { outline: activeOutline }
        );

        emit('EXTRACTOR', chapterNumber, '增量抽取实体状态与四联遥测');
        const stateRes = await this.runExtractorAndCommitState({
            snapshot,
            chapterNumber,
            targetDay,
            timelineMode,
            povCharIds,
            selectedEntityIds: activeCastSelectedIds,
            outline: activeOutline,
            prose: activeProse,
            replanCount: totalReplans,
            rewriteCount: totalRewrites,
            patchRounds: totalPatchRounds,
            updatedVoicePool,
            factConfirmations,
            totalUsage,
            options,
            parallel,
            allowedChapterFiles,
            stagingOverlay: effectiveStagingOverlay,
            signalCursorUpdate
        });

        emit('COMMITTED', chapterNumber, `第 ${chapterNumber} 章双粒度提交完成`);
        return {
            status: 'COMMITTED',
            chapterNumber,
            manuscriptPath: `manuscripts/${formatChapterKey(chapterNumber)}.md`,
            featCommitSha: featRes.sha,
            stateCommitSha: stateRes.stateCommitSha,
            outline: activeOutline,
            impactedHorizonEvents: activeOutline.impacted_horizon_events,
            replanCount: totalReplans,
            rewriteCount: totalRewrites,
            patchRounds: totalPatchRounds,
            telemetry: stateRes.telemetry,
            totalUsage,
            updatedEntities: stateRes.updatedEntities,
            nextChapterOptions: stateRes.nextChapterOptions,
            ...(latestWriterAssemblyReport
                ? { writerAssemblyReport: latestWriterAssemblyReport }
                : {})
        };
    }

    /** 崩溃恢复：从 FEAT_COMMITTED 相位跳过正文生成直接补跑状态抽取与提交 */
    private async recoverFromFeatCommitted(params: {
        activeCh: number;
        snapshot: BookSnapshot;
        recoveredContext: BookSnapshot['txState']['chapter_context'];
        timelineMode: TimelineMode;
        povCharIds: string[];
        totalUsage: TokenUsage;
        options: StepChapterOptions;
        parallel?: { windowId: string; branchId: string } | undefined;
        allowedChapterFiles?: string[] | undefined;
        branchStagingOverlay?: Map<string, string | null> | undefined;
        emit: (
            stage: EngineStageName,
            chapterNum: number,
            message: string,
            extra?: { activeSessionId?: string; runId?: string }
        ) => void;
    }): Promise<StepChapterResult> {
        const {
            activeCh,
            recoveredContext,
            timelineMode,
            povCharIds,
            totalUsage,
            options,
            parallel,
            allowedChapterFiles,
            branchStagingOverlay,
            emit
        } = params;
        let snapshot = params.snapshot;
        emit('WAL_RECOVERY', activeCh, `从 FEAT_COMMITTED 恢复第 ${activeCh} 章状态抽取`);
        const relPath = `manuscripts/${formatChapterKey(activeCh)}.md`;
        const featCommitSha = await this.system.currentRevision(this.store.bookRoot);
        const prose = await this.system.readFileAtRef(this.store.bookRoot, featCommitSha, relPath);
        if (prose === null || sha256Hex(prose) !== snapshot.txState.chapter_hashes[formatChapterKey(activeCh)]) {
            throw new Error(`无法恢复第 ${activeCh} 章：Git 正文缺失或与 WAL 指纹不符`);
        }
        const targetDay =
            recoveredContext?.targetDay ??
            options.targetDay ??
            snapshot.worldState.frontmatter.story_day;

        const outlineSnap = await this.store.readChapterOutline(activeCh);
        let recoveredOutline: PlannerOutline | null = null;
        if (outlineSnap.status === 'available' && outlineSnap.outlineText) {
            try {
                recoveredOutline = PlannerOutlineSchema.parse(JSON.parse(outlineSnap.outlineText));
            } catch {
                recoveredOutline = null;
            }
        }

        const wokenColdIds = new Set<string>();
        const recoveryWakeupIds = [
            ...povCharIds,
            ...(recoveredOutline?.focus_cast ?? []),
            ...(recoveredOutline?.background_cast ?? [])
        ];
        snapshot = await wakeColdArchiveEntitiesInMemory(
            this.store,
            snapshot,
            recoveryWakeupIds,
            wokenColdIds
        );
        const recoveryStagingOverlay = this.buildEffectiveStagingOverlay(
            branchStagingOverlay,
            snapshot,
            wokenColdIds
        );

        const recoveryVoicePool = await this.readVoicePool();
        let recoveredUpdatedVoicePool: VoiceSamplePool | undefined;
        if (recoveryVoicePool && recoveryVoicePool.samples.length > 0) {
            const alreadyRecordedForChapter = recoveryVoicePool.samples.some(
                (s) => s.last_used_ch === activeCh
            );
            recoveredUpdatedVoicePool = alreadyRecordedForChapter
                ? recoveryVoicePool
                : sampleVoiceLru(recoveryVoicePool, {
                      currentCh: activeCh,
                      preferredTag: recoveredOutline?.preferred_voice_tag
                  }).updatedPool;
        }

        const recoveredSelectedIds = Array.from(new Set(recoveryWakeupIds));

        emit('EXTRACTOR', activeCh, '增量抽取实体状态与四联遥测');
        const stateRes = await this.runExtractorAndCommitState({
            snapshot,
            chapterNumber: activeCh,
            targetDay,
            timelineMode,
            povCharIds,
            selectedEntityIds: recoveredSelectedIds,
            outline: recoveredOutline,
            prose,
            replanCount: 0,
            rewriteCount: 0,
            patchRounds: 0,
            updatedVoicePool: recoveredUpdatedVoicePool,
            factConfirmations: recoveredContext?.fact_confirmations,
            totalUsage,
            options,
            parallel,
            allowedChapterFiles,
            stagingOverlay: new Map(recoveryStagingOverlay).set(relPath, prose),
            signalCursorUpdate: recoveredContext?.signalCursorUpdate
        });

        return {
            status: 'COMMITTED',
            chapterNumber: activeCh,
            manuscriptPath: relPath,
            featCommitSha,
            stateCommitSha: stateRes.stateCommitSha,
            recoveredFromPhase: 'FEAT_COMMITTED',
            outline: recoveredOutline,
            impactedHorizonEvents: recoveredOutline?.impacted_horizon_events ?? [],
            replanCount: 0,
            rewriteCount: 0,
            patchRounds: 0,
            telemetry: stateRes.telemetry,
            totalUsage,
            updatedEntities: stateRes.updatedEntities,
            nextChapterOptions: stateRes.nextChapterOptions
        };
    }

    /** 执行 Step 1: Librarian 多轮受控探查 -> yield_context_pack */
    private async runLibrarian(
        snapshot: BookSnapshot,
        chapterNumber: number,
        targetDay: number,
        timelineMode: TimelineMode,
        chapterGoal: string,
        previousChapter: PreviousChapterContext | undefined,
        totalUsage: TokenUsage,
        options: StepChapterOptions,
        allowedChapterFiles?: string[] | undefined,
        stagingOverlay?: ReadonlyMap<string, string | null> | undefined
    ): Promise<YieldContextPackResult> {
        const retrievalCfg = snapshot.config.retrieval;
        const catalog = await this.recall.buildLibrarianCatalog(this.store.bookRoot, {
            currentVolume: snapshot.worldState.frontmatter.current_volume,
            chapterFiles: allowedChapterFiles ?? snapshot.chapterFiles,
            librarianRecentL2Window: retrievalCfg?.librarian_recent_l2_window ?? 20,
            ...(stagingOverlay !== undefined ? { stagingOverlay } : {}),
            ...(retrievalCfg?.l2_full_unfrozen_threshold !== undefined
                ? { l2FullUnfrozenThreshold: retrievalCfg.l2_full_unfrozen_threshold }
                : {}),
            ...(retrievalCfg?.l2_freeze_block_chapters !== undefined
                ? { l2FreezeBlockChapters: retrievalCfg.l2_freeze_block_chapters }
                : {})
        });

        const summaryMaxChars = retrievalCfg?.librarian_entity_summary_chars ?? 60;
        const formatEntityCatalogLine = (e: EntityProfile): string => {
                const extraParts: string[] = [];
                if (e.metadata.unique_aliases.length > 0) {
                    extraParts.push(`别名: ${e.metadata.unique_aliases.join('、')}`);
                }
                if (e.metadata.contextual_titles.length > 0) {
                    extraParts.push(`称谓: ${e.metadata.contextual_titles.join('、')}`);
                }
                const suffix = extraParts.length > 0 ? ` (${extraParts.join(' | ')})` : '';
                let latestSummarySource = '';
                if (timelineMode === 'FLASHBACK') {
                    // FLASHBACK 模式下屏蔽主线当前状态与近期缓冲，仅提取 day < targetDay 的历史履历
                    const eligibleTrajectory = e.irreversibleTrajectory.filter(
                        (entry) =>
                            entry.status !== 'WARPED' &&
                            entry.visibility !== 'OMNISCIENT_SECRET' &&
                            entry.storyDay !== undefined &&
                            entry.storyDay < targetDay &&
                            entry.text.trim().length > 0
                    );
                    latestSummarySource = eligibleTrajectory.at(-1)?.text ?? '';
                } else {
                    const eligibleAcquired = e.acquiredState.filter(
                        (entry) =>
                            entry.status !== 'WARPED' &&
                            entry.visibility !== 'OMNISCIENT_SECRET' &&
                            entry.text.trim().length > 0
                    );
                    const eligibleBuffer = e.recentBuffer.filter(
                        (entry) =>
                            entry.status !== 'WARPED' &&
                            entry.visibility !== 'OMNISCIENT_SECRET' &&
                            entry.text.trim().length > 0
                    );
                    latestSummarySource =
                        eligibleAcquired.at(-1)?.text ?? eligibleBuffer.at(-1)?.text ?? '';
                }
                const normalizedSummary = latestSummarySource.replace(/\s+/g, ' ').trim();
                const statusSummary =
                    normalizedSummary.length > summaryMaxChars
                        ? `${normalizedSummary.slice(0, Math.max(1, summaryMaxChars - 1))}…`
                        : normalizedSummary;
                const statusSuffix = statusSummary ? ` | 现状: ${statusSummary}` : '';
                return `- ${e.metadata.entity_id}: ${e.metadata.canonical_name}${suffix} [last_seen_ch=${e.metadata.last_seen_ch}]${statusSuffix}`;
        };
        const entityList = Object.values(snapshot.entities).map(formatEntityCatalogLine).join('\n');

        const coldArchiveSection =
            snapshot.coldArchiveIds.length > 0
                ? [
                      '',
                      '## 冷宫休眠实体清单 (entities/cold_archive/)',
                      snapshot.coldArchiveIds.map((id) => formatEntityCatalogLine(snapshot.coldEntities[id]!)).join('\n')
                  ]
                : [];

        const worldSummary =
            timelineMode === 'FLASHBACK' ? '' : snapshot.worldState.summaryMarkdown.trim();
        const fallbackTailChars = snapshot.config.context_assembly?.fallback_tail_chars ?? 600;
        const prevTailSlice =
            timelineMode !== 'FLASHBACK' && previousChapter?.fullText?.trim()
                ? previousChapter.fullText.trim().slice(-fallbackTailChars)
                : '';

        const taskPrompt = [
            catalog.staticPrefix,
            catalog.dynamicTail,
            ...(worldSummary ? ['', '## 当前全局局势摘要 (world_state.md)', worldSummary] : []),
            ...(prevTailSlice
                ? ['', '## 上一章末尾片段（防漏选刚登场的道具与词条）', prevTailSlice]
                : []),
            '',
            '## 可用实体档案列表',
            entityList || '(暂无实体)',
            ...coldArchiveSection,
            '',
            `## 本章目标 (${formatChapterKey(chapterNumber)}, story_day=${targetDay}, mode=${timelineMode})`,
            chapterGoal,
            '',
            '请使用受控检索工具探查必要档案与原稿切片后，调用 `yield_context_pack` 提交检索结果。'
        ].join('\n');

        const runRes = await this.roleRunner.runMultiTurn<YieldContextPackResult>({
            roleId: 'librarian',
            stage: 'LIBRARIAN',
            chapterNumber,
            bookRoot: this.store.bookRoot,
            bookConfig: snapshot.config,
            targetChapter: chapterNumber,
            targetDay,
            chapterGoal,
            preInjectedFullPaths: new Set(['world/open_threads.md']),
            timelineMode,
            ...(allowedChapterFiles !== undefined ? { allowedChapterFiles } : {}),
            ...(stagingOverlay !== undefined ? { stagingOverlay } : {}),
            taskPrompt,
            signal: options.signal,
            onStageSession: options.onStageSession
        });
        addUsage(totalUsage, runRes.usage);

        return runRes.yieldResult;
    }

    /** 执行 Step 2: Planner / REPLAN 多轮受控点查 -> yield_outline */
    private async runPlanner(params: {
        snapshot: BookSnapshot;
        chapterNumber: number;
        targetDay: number;
        timelineMode: TimelineMode;
        povCharIds: string[];
        selectedEntityIds: string[];
        recallSlices: RecallSlice[];
        selectedLoreEntries: string[];
        chapterGoal: string;
        staticPrefix: StaticPrefixInput;
        previousChapter: PreviousChapterContext | undefined;
        futureHorizon: string | undefined;
        openThreads: string | undefined;
        opsStyleAmendments: string | undefined;
        authorCharter: string | null;
        arcDirectorPlan: string | null;
        signalDirective: string;
        customPlugins?: Record<string, CraftPluginDefinition> | undefined;
        voicePool: VoiceSamplePool | undefined;
        planConflictFeedback: string | undefined;
        totalUsage: TokenUsage;
        stage: 'PLANNER' | 'REPLAN';
        attempt: number;
        triggerReason?: string | undefined;
        allowedChapterFiles?: string[] | undefined;
        stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
        signal?: AbortSignal | undefined;
        onStageSession?: ((event: StageSessionEvent) => void) | undefined;
    }): Promise<{ outline: PlannerOutline; plannerView: ReturnType<ViewSlicer['slice']> }> {
        const effectiveEntityIds = Array.from(
            new Set([...params.selectedEntityIds, ...params.povCharIds])
        );
        const plannerView = this.slicer.slice({
            snapshot: params.snapshot,
            forRole: 'planner',
            targetDay: params.targetDay,
            currentCh: params.chapterNumber,
            timelineMode: params.timelineMode,
            povCharId: params.povCharIds,
            entityIds: effectiveEntityIds,
            parallelBroadcastEntries: params.snapshot.parallelBroadcastEntries
        });

        const availableVoiceTags = params.voicePool
            ? Array.from(
                  new Set(params.voicePool.samples.map((s) => s.tag.trim()).filter((t) => t.length > 0))
              )
            : [];

        const goalWithFeedback = [
            params.chapterGoal,
            params.authorCharter ? `\n## 作者契约 (world/author_charter.md)\n${params.authorCharter.trim()}` : '',
            params.arcDirectorPlan
                ? `\n## 导演禁区计划 (world/arc_director_plan.md)\n${params.arcDirectorPlan.trim()}`
                : '',
            params.openThreads ? `\n## 跨卷未解伏笔 (open_threads.md)\n${params.openThreads}` : '',
            availableVoiceTags.length > 0
                ? `\n## 可用声纹标签枚举 (preferred_voice_tag)\n请从以下标签中择一填入 preferred_voice_tag：${availableVoiceTags.join('、')}`
                : '',
            params.planConflictFeedback
                ? `\n## 必须修正的物理/因果冲突 (v2 重规划)\n${params.planConflictFeedback}`
                : '',
            params.signalDirective ? `\n${params.signalDirective}` : ''
        ]
            .filter(Boolean)
            .join('\n');

        const assembled = this.assembler.assemblePlannerRequest({
            config: params.snapshot.config,
            staticPrefix: params.staticPrefix,
            slicedView: plannerView,
            chapterGoal: goalWithFeedback,
            recallSlices: params.recallSlices,
            loreEntries: params.selectedLoreEntries,
            previousChapter: params.previousChapter,
            futureHorizon: params.futureHorizon,
            opsStyleAmendments: params.opsStyleAmendments,
            customPlugins: params.customPlugins,
            pool: 'strong_creative'
        });

        const taskPrompt = [
            `本章 scene_plan 拍数上限: 1..${params.chapterNumber === 1 ? Math.min(2, params.snapshot.config.opening?.first_chapter_max_beats ?? 1) : 2}${params.chapterNumber === 1 ? '（首章按配置聚焦开场）' : ''}。`,
            ...assembled.request.staticPrefixBlocks,
            assembled.request.dynamicTail,
            '',
            '请完成必要点查后调用 `yield_outline` 提交结构化细纲（严格保持 director_rationale 与 outline_text 里表分流）。'
        ].join('\n\n');

        const visibleEntitiesMap = new Map<string, EntityProfile>(
            Object.entries(params.snapshot.entities)
        );
        const runRes = await this.roleRunner.runMultiTurn<PlannerOutline>({
            roleId: 'planner',
            stage: params.stage,
            attempt: params.attempt,
            ...(params.triggerReason ? { triggerReason: params.triggerReason } : {}),
            chapterNumber: params.chapterNumber,
            bookRoot: this.store.bookRoot,
            bookConfig: params.snapshot.config,
            targetChapter: params.chapterNumber,
            timelineMode: params.timelineMode,
            visibleEntities: visibleEntitiesMap,
            ...(params.allowedChapterFiles !== undefined
                ? { allowedChapterFiles: params.allowedChapterFiles }
                : {}),
            ...(params.stagingOverlay !== undefined
                ? { stagingOverlay: params.stagingOverlay }
                : {}),
            taskPrompt,
            signal: params.signal,
            onStageSession: params.onStageSession
        });
        addUsage(params.totalUsage, runRes.usage);

        return {
            outline: runRes.yieldResult,
            plannerView
        };
    }

    /** 执行净室整章重写 REWRITE（统一收拢 Gate 与 FactChecker 两条重写路径） */
    private async executeRewrite(params: {
        snapshot: BookSnapshot;
        chapterNumber: number;
        targetDay: number;
        timelineMode: TimelineMode;
        povCharIds: string[];
        selectedEntityIds: string[];
        recallSlices: RecallSlice[];
        selectedLoreEntries: string[];
        outline: PlannerOutline;
        staticPrefix: StaticPrefixInput;
        rolePrompt: string;
        previousChapter: PreviousChapterContext | undefined;
        opsStyleAmendments: string | undefined;
        customPlugins?: Record<string, CraftPluginDefinition> | undefined;
        voicePool: VoiceSamplePool | undefined;
        totalUsage: TokenUsage;
        rewriteFeedback: string;
        attempt: number;
        triggerReason: string;
        signal?: AbortSignal | undefined;
        onStageSession?: ((event: StageSessionEvent) => void) | undefined;
    }) {
        return await this.runWriter({
            ...params,
            traceStage: 'rewrite'
        });
    }

    /** 执行 Step 3: Writer 净室单轮执笔（零工具、经 RoleRunner.runCleanroom 创建隔离会话、物理隔离禁区与全知视角） */
    private async runWriter(params: {
        snapshot: BookSnapshot;
        chapterNumber: number;
        targetDay: number;
        timelineMode: TimelineMode;
        povCharIds: string[];
        selectedEntityIds: string[];
        recallSlices: RecallSlice[];
        selectedLoreEntries: string[];
        outline: PlannerOutline;
        staticPrefix: StaticPrefixInput;
        rolePrompt: string;
        previousChapter: PreviousChapterContext | undefined;
        opsStyleAmendments: string | undefined;
        customPlugins?: Record<string, CraftPluginDefinition> | undefined;
        voicePool: VoiceSamplePool | undefined;
        totalUsage: TokenUsage;
        rewriteFeedback?: string | undefined;
        traceStage?: 'writer' | 'rewrite' | undefined;
        attempt?: number | undefined;
        triggerReason?: string | undefined;
        signal?: AbortSignal | undefined;
        onStageSession?: ((event: StageSessionEvent) => void) | undefined;
    }): Promise<{
        prose: string;
        writerView: ReturnType<ViewSlicer['slice']>;
        updatedVoicePool?: VoiceSamplePool | undefined;
        assemblyReport: WriterAssemblyReport;
    }> {
        const effectiveEntityIds = Array.from(
            new Set([...params.selectedEntityIds, ...params.povCharIds])
        );
        const writerView = this.slicer.slice({
            snapshot: params.snapshot,
            forRole: 'writer',
            targetDay: params.targetDay,
            currentCh: params.chapterNumber,
            timelineMode: params.timelineMode,
            povCharId: params.povCharIds,
            entityIds: effectiveEntityIds,
            parallelBroadcastEntries: params.snapshot.parallelBroadcastEntries
        });

        for (const slice of params.recallSlices) {
            if (slice.requiredEntityId && !writerView.entities[slice.requiredEntityId]) {
                throw new Error(`写手成对召回缺少可见实体档案: ${slice.requiredEntityId}`);
            }
        }

        // 物理丢弃 outline.director_rationale，并对世界书片段执行净室清洗
        const cleanLoreEntries = params.selectedLoreEntries
            .map((entry) => sanitizeLoreForWriter(entry))
            .filter((entry) => entry.length > 0);
        const outlineText = [
            `标题：${params.outline.chapter_title}`,
            `目标字数：${params.outline.target_word_count}`,
            `收尾节拍：${params.outline.ending_beat}`,
            `本章实质波折：${params.outline.chapter_turn}`,
            params.outline.outline_text,
            params.rewriteFeedback
                ? `\n本轮重写正向校准目标：\n${params.rewriteFeedback}`
                : ''
        ]
            .filter(Boolean)
            .join('\n');

        const assembled = this.assembler.assembleWriterRequest({
            config: params.snapshot.config,
            staticPrefix: params.staticPrefix,
            slicedView: writerView,
            outline: outlineText,
            focusCastIds: params.outline.focus_cast,
            backgroundCastIds: params.outline.background_cast,
            recallSlices: params.recallSlices,
            loreEntries: cleanLoreEntries,
            previousChapter: params.previousChapter,
            opsStyleAmendments: params.opsStyleAmendments,
            customPlugins: params.customPlugins,
            voicePool: params.voicePool,
            preferredVoiceTag: params.outline.preferred_voice_tag,
            rolePrompt: params.rolePrompt
        });

        const traceStage = params.traceStage ?? 'writer';
        const stage = traceStage === 'rewrite' ? 'REWRITE' : 'WRITER';
        const { response } = await this.roleRunner.runCleanroom({
            roleId: 'writer',
            budgetedRolePrompt: params.rolePrompt,
            stage,
            attempt: params.attempt,
            triggerReason: params.triggerReason,
            bookRoot: this.store.bookRoot,
            bookConfig: params.snapshot.config,
            chapterNumber: params.chapterNumber,
            request: {
                staticPrefixBlocks: assembled.request.staticPrefixBlocks,
                dynamicTail: assembled.request.dynamicTail,
                traceStage
            },
            signal: params.signal,
            onStageSession: params.onStageSession
        });
        addUsage(params.totalUsage, response.usage);

        const cleanProse = ensureChapterHeading(
            stripBlockingTags(response.text).cleanText.trim(),
            params.chapterNumber,
            params.outline.chapter_title
        );
        const assemblyReport: WriterAssemblyReport = {
            chapterNumber: params.chapterNumber,
            estimatedTokens: assembled.diagnostics.estimatedTokens,
            budget: assembled.diagnostics.budget,
            evictionLevel: assembled.diagnostics.evictionLevel,
            truncated: assembled.diagnostics.truncated,
            appliedEvictions: assembled.diagnostics.appliedEvictions,
            staticPrefixHash: assembled.diagnostics.staticPrefixHash,
            selectedVoiceSample: buildSelectedVoiceSampleSummary(
                assembled.diagnostics.selectedVoiceSample
            )
        };
        return {
            prose: cleanProse,
            writerView,
            updatedVoicePool: assembled.diagnostics.updatedVoicePool,
            assemblyReport
        };
    }

    /**
     * 执行纯内存局部 Patch 闭环 (`patch_paragraphs` + `yield_patched_draft`)：
     * - 严格校验 patch.yml 必须保持 cleanroom=false 与 maxReadCalls=0（显式拒止回退单轮 writer）；
     * - 遇到取消信号 (AbortSignal / AbortError) 立即直抛不吞错；其余运行失败平滑返回 null 供外层降级 REWRITE。
     */
    private async tryRunLocalPatch(params: {
        snapshot: BookSnapshot;
        writerView: SlicedView;
        staticBaseAndVoice: string | null;
        outline: PlannerOutline;
        chapterNumber: number;
        prose: string;
        violatedIndices: number[];
        reason: string;
        totalUsage: TokenUsage;
        proseGateOptions?: ProseGateOptions | undefined;
        violations?: GateViolation[] | undefined;
        factIssues?: FactCheckIssue[] | undefined;
        attempt?: number | undefined;
        triggerReason?: string | undefined;
        signal?: AbortSignal | undefined;
        onStageSession?: ((event: StageSessionEvent) => void) | undefined;
    }): Promise<string | null> {
        const paragraphs = splitParagraphs(params.prose);
        if (paragraphs.length === 0 || params.violatedIndices.length === 0) {
            return params.prose;
        }

        const sortedUnique = Array.from(
            new Set(params.violatedIndices.filter((idx) => idx >= 0 && idx < paragraphs.length))
        ).sort((a, b) => a - b);
        if (sortedUnique.length === 0) {
            return params.prose;
        }

        const patchRoleCfg = await this.roleLoader.loadRoleConfig('patch', this.store.bookRoot);
        if (
            patchRoleCfg.cleanroom ||
            patchRoleCfg.maxReadCalls > 0 ||
            !patchRoleCfg.tools.includes('patch_paragraphs') ||
            patchRoleCfg.yieldTool !== 'yield_patched_draft'
        ) {
            throw new ValidationError(
                'patch 角色配置非法：Patch 必须运行在 cleanroom=false、maxReadCalls=0 的纯内存段落编辑闭环中'
            );
        }

        const cleanReason = sanitizeTextForCleanroomWriter(params.reason, !params.factIssues?.length);
        const patchReasonText = cleanReason || CLEANROOM_PATCH_FALLBACK_REASON;

        const violationLines = (params.violations ?? []).map((v) => {
            const guidance =
                GATE_POSITIVE_GUIDANCE[v.ruleId] ??
                '以具体人物动作、感官白描与生活化口语对白重新组织当前段落。';
            return `- [${v.paragraphIndex}] (${v.ruleId}, line ${v.line}:${v.column}) 改写目标：${guidance}`;
        });

        const factIssueLines: string[] = [];
        for (const issue of params.factIssues ?? []) {
            if (isRestrictedFactQuoteSource(issue, params.snapshot, params.writerView)) continue;
            const cleanDesc = sanitizeTextForCleanroomWriter(issue.description, false);
            if (!cleanDesc) continue;
            const indices = [
                ...(issue.paragraph_index !== undefined ? [issue.paragraph_index] : []),
                ...(issue.paragraph_indices ?? [])
            ];
            const idxLabel = indices.length > 0 ? `[${indices.join(', ')}]` : '[待定位]';
            const cleanSource =
                issue.quote_source &&
                !isRestrictedFactQuoteSource(issue, params.snapshot, params.writerView)
                    ? sanitizeTextForCleanroomWriter(issue.quote_source, false)
                    : '';
            const quoteInfo = cleanSource ? ` | 参考基准: ${cleanSource}` : '';
            const draftQuote = issue.quote_draft ? ` | 待修正文原句: ${issue.quote_draft}` : '';
            factIssueLines.push(`- ${idxLabel} ${cleanDesc}${quoteInfo}${draftQuote}`);
        }

        const cleanStaticVoice = params.staticBaseAndVoice
            ? stripWriterRestrictedDirectives(params.staticBaseAndVoice) ?? ''
            : '';
        const cleanOutlineText =
            stripWriterRestrictedDirectives(params.outline.outline_text) ?? '';
        const entityCardsText = Object.values(params.writerView.entities)
            .map((profile) =>
                renderEntityProfile(profile, {
                    compactCard: false,
                    stripWarped: true,
                    cleanroomDisplay: true
                })
            )
            .filter((block) => block.trim().length > 0)
            .join('\n\n');

        const numberedParagraphs = paragraphs
            .map((p, idx) => `[${idx}] ${p}`)
            .join('\n\n');

        const taskPrompt = [
            cleanStaticVoice ? `## 抽象文风纪律锁\n${cleanStaticVoice}` : '',
            cleanOutlineText ? `## 本章细纲基准\n${cleanOutlineText}` : '',
            entityCardsText ? `## 可见出场实体事实基准（净室脱敏）\n${entityCardsText}` : '',
            formatCrossEntityKnownEntries(params.writerView, true),
            `## 修补原因与触发来源\n${patchReasonText}`,
            `## 待修补段落索引 (0-based)\n[${sortedUnique.join(', ')}]`,
            violationLines.length > 0 ? `## 静态门禁违规定位清单\n${violationLines.join('\n')}` : '',
            factIssueLines.length > 0 ? `## 事实核查修补清单\n${factIssueLines.join('\n')}` : '',
            `## 叙事人称与主观度基准\n${params.snapshot.config.narration_subjectivity}`,
            `## 当前待修补正文（0-based 段落索引）\n${numberedParagraphs}`,
            '请对照 0-based 段落索引调用 `patch_paragraphs` 精准替换目标段落；每次修改后依据即时门禁诊断继续微调，确认全部段落通过后调用 `yield_patched_draft` 提交定稿。'
        ]
            .filter(Boolean)
            .join('\n\n');

        try {
            const runRes = await this.roleRunner.runMultiTurn<YieldPatchedDraftResult>({
                roleId: patchRoleCfg.id,
                stage: 'LOCAL_PATCH',
                chapterNumber: params.chapterNumber,
                bookRoot: this.store.bookRoot,
                bookConfig: params.snapshot.config,
                draftText: params.prose,
                proseGateOptions: params.proseGateOptions,
                enforceProseGateOnYield: true,
                attempt: params.attempt,
                triggerReason: params.triggerReason,
                taskPrompt,
                signal: params.signal,
                onStageSession: params.onStageSession
            });
            addUsage(params.totalUsage, runRes.usage);
            return runRes.yieldResult.patchedProse;
        } catch (err: unknown) {
            if (params.signal?.aborted || isAbortError(err)) {
                throw err;
            }
            void traceEvent('local_patch.degraded', {
                chapter: params.chapterNumber,
                reason: err instanceof Error ? err.message : String(err)
            });
            return null;
        }
    }

    /** 执行 Step 5: Fact Checker 多轮受控查证 -> yield_verdict */
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
        currentArcEnvelope: string | null,
        arcDirectorPlan: string | null,
        authorCharter: string | null,
        totalUsage: TokenUsage,
        pluginPrompt: string,
        options: StepChapterOptions,
        allowedChapterFiles?: string[] | undefined,
        stagingOverlay?: ReadonlyMap<string, string | null> | undefined,
        selectedLoreSources: Array<{ path: string; content: string }> = [],
        reviewFocus?: { issues: FactCheckIssue[]; paragraphs: number[] }
    ): Promise<FactCheckOutput> {
        const effectiveEntityIds = Array.from(new Set([...selectedEntityIds, ...povCharIds]));
        const auditView = this.slicer.slice({
            snapshot,
            forRole: 'fact_checker',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds,
            entityIds: effectiveEntityIds,
            parallelBroadcastEntries: snapshot.parallelBroadcastEntries
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
        const openThreadsRaw = await this.store.readOpenThreads();
        const preInjectedFullPaths = new Set<string>();
        if (currentArcEnvelope !== null) preInjectedFullPaths.add('world/current_arc_envelope.md');
        if (openThreadsRaw !== null) preInjectedFullPaths.add('world/open_threads.md');

        const limits = snapshot.config.repair_loop ?? DEFAULT_REPAIR_LOOP_CFG;
        const taskPrompt = [
            reviewFocus ? `## 修补后复审焦点\n上轮问题：${reviewFocus.issues.map((issue) => issue.description).join('；')}\n本次修补前段号：${reviewFocus.paragraphs.join(', ')}；段落拆并后以当前正文标号为准。重点核实改动及关联事实，同时检查其余正文的联动冲突。` : '',
            pluginPrompt,
            `本书 LOCAL_PATCH 门限：最多 ${limits.fact_max_patch_paragraphs} 段，多段时占比不超过 ${limits.fact_max_patch_ratio * 100}%。`,
            authorCharter
                ? `=== SOURCE_REF: world/author_charter.md ===\n${authorCharter}`
                : '',
            arcDirectorPlan
                ? `=== SOURCE_REF: world/arc_director_plan.md ===\n${arcDirectorPlan}`
                : '',
            `=== SOURCE_REF: outline ===\n${outline.outline_text}`,
            outline.target_beat_label ? `本章拟完成节拍：${outline.target_beat_label}` : '',
            openThreadsRaw === null ? '' : `=== SOURCE_REF: world/open_threads.md ===\n${openThreadsRaw}`,
            ...selectedLoreSources.map((entry) => `=== SOURCE_REF: ${entry.path} ===\n${entry.content}`),
            `## 事实核查基线语料\n${corpusText}`,
            `## 待审正文（按段落索引标记）\n${numberedParagraphs}`,
            '',
            '请执行硬性事实核查（必要时通过 book_read / book_grep 回查设定或旧章原句），然后调用 `yield_verdict` 提交核查结论。'
        ]
            .filter(Boolean)
            .join('\n\n');

        const runRes = await this.roleRunner.runMultiTurn<FactCheckOutput>({
            roleId: 'fact-checker',
            stage: 'FACT_CHECKER',
            chapterNumber,
            bookRoot: this.store.bookRoot,
            bookConfig: snapshot.config,
            draftText: prose,
            outlineText: outline.outline_text,
            preInjectedFullPaths,
            timelineMode,
            ...(allowedChapterFiles !== undefined ? { allowedChapterFiles } : {}),
            ...(stagingOverlay !== undefined ? { stagingOverlay } : {}),
            taskPrompt,
            signal: options.signal,
            onStageSession: options.onStageSession
        });
        addUsage(totalUsage, runRes.usage);

        return runRes.yieldResult;
    }

    /** 执行 Step 6: Extractor 多轮抽取 -> yield_state_patch 门禁 -> 遥测/双轨L2卡/Q2声纹/state 提交 */
    private async runExtractorAndCommitState(params: {
        snapshot: BookSnapshot;
        chapterNumber: number;
        targetDay: number;
        timelineMode: TimelineMode;
        povCharIds: string[];
        selectedEntityIds: string[];
        outline: PlannerOutline | null;
        prose: string;
        replanCount: number;
        rewriteCount: number;
        patchRounds: number;
        updatedVoicePool: VoiceSamplePool | undefined;
        factConfirmations?: { completed_beats: string[]; resolved_threads: string[] } | undefined;
        totalUsage: TokenUsage;
        options: StepChapterOptions;
        parallel?: { windowId: string; branchId: string } | undefined;
        allowedChapterFiles?: string[] | undefined;
        stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
        signalCursorUpdate?:
            | { consumedLines: number; consumedIds: string[] }
            | undefined;
    }): Promise<{
        stateCommitSha: string;
        updatedEntities: string[];
        telemetry: ReturnType<typeof computeTelemetry>;
        nextChapterOptions: string[];
    }> {
        const {
            snapshot,
            chapterNumber,
            targetDay,
            timelineMode,
            povCharIds,
            selectedEntityIds,
            outline,
            prose,
            replanCount,
            rewriteCount,
            patchRounds,
            updatedVoicePool,
            factConfirmations,
            totalUsage,
            options,
            parallel,
            allowedChapterFiles,
            stagingOverlay,
            signalCursorUpdate
        } = params;

        const extractorView = this.slicer.slice({
            snapshot,
            forRole: 'extractor',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds,
            parallelBroadcastEntries: snapshot.parallelBroadcastEntries
        });
        const knownMemoryView = this.slicer.slice({
            snapshot, forRole: 'extractor', targetDay, currentCh: chapterNumber,
            timelineMode, povCharId: povCharIds, entityIds: selectedEntityIds
        });

        const retrievalCfg = snapshot.config.retrieval;
        const fullThreshold = retrievalCfg?.extractor_full_entity_threshold ?? 15;
        const recentL2Window = retrievalCfg?.extractor_recent_l2_window ?? 2;

        const entitySummary = this.buildExtractorEntitySummary(
            Object.values(extractorView.entities),
            fullThreshold,
            povCharIds,
            selectedEntityIds,
            prose
        );

        const currentVolume = snapshot.worldState.frontmatter.current_volume;
        const cardRelPath = formatVolumeCardRelPath(currentVolume);
        const [worldStateRaw, openThreadsRaw, diskVolumeCards] = await Promise.all([
            readOptionalText(join(this.store.bookRoot, 'world/world_state.md')),
            readOptionalText(join(this.store.bookRoot, 'world/open_threads.md')),
            readOptionalText(join(this.store.bookRoot, cardRelPath))
        ]);
        const effectiveVolumeCards =
            stagingOverlay?.get(cardRelPath) ?? diskVolumeCards;
        const recentL2Cards = extractRecentL2Cards(effectiveVolumeCards, recentL2Window);

        const taskPrompt = [
            timelineMode !== 'FLASHBACK' && worldStateRaw && worldStateRaw.trim().length > 0
                ? `## 当前世界状态全文 (world/world_state.md)\n${worldStateRaw.trim()}`
                : '',
            ...(openThreadsRaw && openThreadsRaw.trim().length > 0
                ? [`## 当前跨卷伏笔台账 (world/open_threads.md)\n${openThreadsRaw.trim()}`]
                : []),
            ...(recentL2Cards
                ? [`## 当前卷近期章节卡片 (${cardRelPath})\n${recentL2Cards}`]
                : []),
            `## 当前实体档案视图\n${entitySummary || '(暂无实体)'}`,
            formatCrossEntityKnownEntries(knownMemoryView, false),
            Object.keys(extractorView.entities).length > fullThreshold
                ? `实体数量超过 ${fullThreshold}，部分档案已降级为摘要；需要具体槽位时请用 book_read 定点查阅。` : '',
            `## 第 ${chapterNumber} 章定稿正文 (mode=${timelineMode}, story_day=${targetDay})\n${prose}`,
            '',
            '请抽取实体补丁、story_day_delta、双轨章卡摘要 (plot_summary + prose_anchors + appeared_entity_ids) 及 2~3 条 next_chapter_options，并调用 `yield_state_patch` 提交。'
        ]
            .filter(Boolean)
            .join('\n\n');

        const branchReachableIds = parallel
            ? [
                  ...Object.keys(snapshot.entities),
                  ...snapshot.coldArchiveIds,
                  ...snapshot.chapterFiles.map((fileName) => fileName.replace(/\.md$/, ''))
              ]
            : undefined;

        const runRes = await this.roleRunner.runMultiTurn<YieldStatePatchResult>({
            roleId: 'extractor',
            stage: 'EXTRACTOR',
            chapterNumber,
            bookRoot: this.store.bookRoot,
            bookConfig: snapshot.config,
            timelineMode,
            deferCommit: true,
            ...(allowedChapterFiles !== undefined ? { allowedChapterFiles } : {}),
            ...(stagingOverlay !== undefined ? { stagingOverlay } : {}),
            visibleEntities: snapshot.entities,
            ...(parallel ? { reachableIds: branchReachableIds } : {}),
            taskPrompt,
            signal: options.signal,
            onStageSession: options.onStageSession
        });
        addUsage(totalUsage, runRes.usage);

        const extracted = runRes.yieldResult.output;
        const sanitizedPatches = sanitizeExtractorPatches(
            snapshot,
            extracted.entity_patches as EntityPatch[]
        );
        const telemetry = computeTelemetry(prose);
        const branchPath = parallel
            ? `.ops/parallel_deltas/${parallel.windowId}/${parallel.branchId}.json`
            : undefined;

        // Q2: 前 voice_rolling_warmup_chapters 章 MAINLINE 定稿锁内，在 applyStatePatch 前基于内存声纹池置换 boot_seed
        const effectiveVoicePool = await this.resolveWarmupRollingVoicePool({
            snapshot,
            chapterNumber,
            timelineMode,
            prose,
            updatedVoicePool,
            totalUsage,
            addedNames: sanitizedPatches.flatMap((p) => [p.canonical_name ?? '', ...(p.add_unique_aliases ?? [])]),
            signal: options.signal
        });

        const ledgerWrites = new Map<string, string>();
        if (timelineMode === 'MAINLINE' && !parallel && factConfirmations) {
            const ledgers = [
                ['world/arc_director_plan.md', 'beats', factConfirmations.completed_beats],
                ['world/open_threads.md', 'threads', factConfirmations.resolved_threads]
            ] as const;
            for (const [path, kind, labels] of ledgers) {
                if (labels.length === 0) continue;
                const before = await readOptionalText(join(this.store.bookRoot, path));
                if (before === null) {
                    void traceEvent('ledger.confirmation_skipped', { path, reason: '台账不存在' });
                    continue;
                }
                const after = settleConfirmedLedger(before, labels, kind, chapterNumber);
                if (after !== before) ledgerWrites.set(path, after);
            }
        }

        const plannedPaths = [
            '.ops/telemetry.jsonl',
            ...ledgerWrites.keys(),
            ...(!parallel ? ['.ops/next_chapter_options.json'] : []),
            ...(signalCursorUpdate ? ['.ops/signals_cursor.json'] : []),
            ...(effectiveVoicePool ? ['.ops/voice_samples.yaml'] : []),
            ...(branchPath
                ? [branchPath]
                : [
                      cardRelPath,
                      'world/world_state.md',
                      ...sanitizedPatches.map((patch) => `entities/${patch.entity_id}.md`)
                  ])
        ];
        await this.store.recordPendingWrites(plannedPaths);

        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
        const telemetryRecord = {
            chapter: chapterNumber,
            timestamp: new Date().toISOString(),
            replan_rate: replanCount > 0 ? 1 : 0,
            replan_count: replanCount,
            rewrite_count: rewriteCount,
            patch_rounds: patchRounds,
            length_metric: 'charCount',
            target_char_count: outline?.target_word_count,
            metrics: telemetry,
            token_usage: totalUsage
        };
        await appendFile(
            join(this.store.bookRoot, '.ops/telemetry.jsonl'),
            `${JSON.stringify(telemetryRecord)}\n`,
            'utf8'
        );

        const extraCommitPaths: string[] = ['.ops/telemetry.jsonl'];
        for (const [path, content] of ledgerWrites) {
            await writeFile(join(this.store.bookRoot, path), content, 'utf8');
            extraCommitPaths.push(path);
        }
        if (signalCursorUpdate) {
            await writeSignalsCursorState(this.store.bookRoot, signalCursorUpdate);
            extraCommitPaths.push('.ops/signals_cursor.json');
        }
        if (effectiveVoicePool) {
            await this.store.writeVoiceSamples(effectiveVoicePool);
            extraCommitPaths.push('.ops/voice_samples.yaml');
        }

        const nextChapterOptions = extracted.next_chapter_options;
        if (!parallel) {
            await writeNextChapterOptions(this.store.bookRoot, chapterNumber, nextChapterOptions);
            extraCommitPaths.push('.ops/next_chapter_options.json');
        }

        const nextStoryDay = timelineMode === 'FLASHBACK'
            ? targetDay
            : targetDay + extracted.story_day_delta;

        // Q1 确定性合成出场名单：严禁将纯正文字面扫描命中混入出场实体
        const knownEntityIds = new Set<string>([
            ...Object.keys(snapshot.entities),
            ...snapshot.coldArchiveIds,
            ...sanitizedPatches.map((patch) => patch.entity_id)
        ]);
        const validatedAppearedIds = extracted.appeared_entity_ids.filter((id) =>
            knownEntityIds.has(id)
        );
        const appearedInChapterIds = Array.from(
            new Set(
                [
                    ...povCharIds,
                    ...(outline?.focus_cast ?? []),
                    ...(outline?.background_cast ?? []),
                    ...validatedAppearedIds
                ].filter((id) => id.trim().length > 0)
            )
        );
        const finalAppearedIds = Array.from(new Set([
            ...appearedInChapterIds,
            ...sanitizedPatches.map((patch) => patch.entity_id)
        ]));

        const plotSummary = extracted.plot_summary;
        const proseAnchors = extracted.prose_anchors;

        if (!parallel) {
            const cardAbsPath = join(this.store.bookRoot, cardRelPath);
            await mkdir(join(this.store.bookRoot, 'index/L2_cards'), { recursive: true });
            const existingCard = await readOptionalText(cardAbsPath);
            const updatedCard = upsertVolumeCardEntry(
                existingCard,
                currentVolume,
                chapterNumber,
                nextStoryDay,
                plotSummary,
                finalAppearedIds,
                proseAnchors
            );
            await writeFile(cardAbsPath, updatedCard, 'utf8');
            extraCommitPaths.push(cardRelPath);
        }

        const worldStateUpdate =
            timelineMode === 'FLASHBACK' || timelineMode === 'PARALLEL'
                ? undefined
                : {
                      current_chapter: Math.max(
                          snapshot.worldState.frontmatter.current_chapter,
                          chapterNumber
                      ),
                      story_day: nextStoryDay,
                      pov_character:
                          povCharIds[0] ?? snapshot.worldState.frontmatter.pov_character,
                      timeline_mode: timelineMode,
                      summaryMarkdown: extracted.world_summary_markdown
                  };

        if (parallel && branchPath) {
            await new ParallelSandbox(this.store, this.system).appendChapter({
                windowId: parallel.windowId,
                branchId: parallel.branchId,
                chapterNumber,
                patches: sanitizedPatches,
                nextChapterOptions,
                daySpan: nextStoryDay - snapshot.worldState.frontmatter.story_day,
                povCharacter: povCharIds[0],
                l2Card: {
                    volumeNumber: currentVolume,
                    chapterNumber,
                    storyDay: nextStoryDay,
                    plotSummary,
                    ...(proseAnchors.length > 0 ? { proseAnchors } : {}),
                    appearanceEntityIds: finalAppearedIds
                }
            });
            extraCommitPaths.push(branchPath);
        }

        const patchRes = await this.store.applyStatePatch(
            chapterNumber,
            parallel ? [] : sanitizedPatches,
            {
                timelineMode,
                appearedEntityIds: new Set(appearedInChapterIds),
                worldStateUpdate,
                extraCommitPaths
            }
        );

        return {
            stateCommitSha: patchRes.sha,
            updatedEntities: parallel
                ? sanitizedPatches.map((patch) => patch.entity_id)
                : patchRes.updatedEntities,
            telemetry,
            nextChapterOptions
        };
    }

    private buildExtractorEntitySummary(
        allExtractorEntities: readonly EntityProfile[],
        fullThreshold: number,
        povCharIds: readonly string[],
        selectedEntityIds: readonly string[],
        prose: string
    ): string {
        if (allExtractorEntities.length <= fullThreshold) {
            return allExtractorEntities
                .map((profile) => serializeEntityMarkdown(profile))
                .join('\n\n');
        }
        const focusedIds = new Set<string>([...povCharIds, ...selectedEntityIds]);
        for (const profile of allExtractorEntities) {
            const id = profile.metadata.entity_id;
            if (focusedIds.has(id)) continue;
            const namesToCheck = [
                profile.metadata.canonical_name,
                ...profile.metadata.unique_aliases
            ]
                .map((n) => n.trim())
                .filter((n) => n.length >= 2);
            if (prose.includes(id) || namesToCheck.some((name) => prose.includes(name))) {
                focusedIds.add(id);
            }
        }
        const fullBlocks: string[] = [];
        const compactIndexLines: string[] = [];
        for (const profile of allExtractorEntities) {
            if (focusedIds.has(profile.metadata.entity_id)) {
                fullBlocks.push(serializeEntityMarkdown(profile));
                continue;
            }
            const aliases = profile.metadata.unique_aliases.join('、') || '无';
            const slotKeys = Array.from(
                new Set(
                    profile.acquiredState
                        .map((entry) => entry.slotKey)
                        .filter((k): k is string => Boolean(k))
                )
            );
            compactIndexLines.push(
                `- ${profile.metadata.entity_id}: ${profile.metadata.canonical_name} | 别名: ${aliases} | slot_keys: ${slotKeys.join(', ') || '无'}`
            );
        }
        return [
            ...fullBlocks,
            ...(compactIndexLines.length > 0
                ? [
                      '### 其余活跃实体精简名录（如需修订请先用 book_read 读取完整档案）',
                      compactIndexLines.join('\n')
                  ]
                : [])
        ].join('\n\n');
    }

    private async resolveWarmupRollingVoicePool(params: {
        snapshot: BookSnapshot;
        chapterNumber: number;
        timelineMode: TimelineMode;
        prose: string;
        updatedVoicePool: VoiceSamplePool | undefined;
        totalUsage: TokenUsage;
        addedNames: string[];
        signal?: AbortSignal | undefined;
    }): Promise<VoiceSamplePool | undefined> {
        const { snapshot, chapterNumber, timelineMode, prose, updatedVoicePool, signal } = params;
        const openingCfg = snapshot.config.opening;
        const warmupChapters = openingCfg?.voice_rolling_warmup_chapters ?? 3;
        const voiceSeedMode = openingCfg?.voice_seed_mode ?? 'hybrid_rolling';
        if (
            timelineMode !== 'MAINLINE' ||
            voiceSeedMode !== 'hybrid_rolling' ||
            chapterNumber > warmupChapters
        ) {
            return updatedVoicePool;
        }
        const memoryBasePool = updatedVoicePool ?? (await this.readVoicePool());
        if (!memoryBasePool || memoryBasePool.samples.length === 0 || (!memoryBasePool.samples.some((s) => s.source === 'boot_seed') &&
            memoryBasePool.samples.length >= (openingCfg?.target_voice_pool_size ?? 4))) {
            return updatedVoicePool;
        }
        const entityNames = [...collectEntityDisplayNames(snapshot.entities), ...params.addedNames];
        try {
            const harvested = await harvestVoiceWithPool({
                store: this.store,
                llm: this.llm,
                gate: this.gate,
                chapterNumber,
                chapterText: prose,
                currentPool: memoryBasePool,
                entityNames,
                snapshot,
                pluginSearchDirs: this.pluginSearchDirs,
                onUsage: (usage) => addUsage(params.totalUsage, usage),
                rollingReplaceBootSeeds: true,
                writeToDisk: false,
                signal
            });
            return harvested.skipped ? updatedVoicePool : harvested.updatedPool;
        } catch (err: unknown) {
            if (signal?.aborted || isAbortError(err)) {
                throw err;
            }
            void traceEvent('voice.rolling_replace.skipped', {
                chapter: chapterNumber,
                reason: err instanceof Error ? err.message : String(err)
            });
            return updatedVoicePool;
        }
    }

    private async loadActivePlugins(config: BookSnapshot['config']): Promise<{
        plugins: LoadedCraftPlugin[];
        gateRules: Partial<Record<GateRuleId, GateRuleConfig>>;
        customPlugins: Record<string, CraftPluginDefinition> | undefined;
    }> {
        if (config.craft_plugins.length === 0 || this.pluginSearchDirs.length === 0) {
            return {
                plugins: [],
                gateRules: resolveWriterGateRules(this.pluginLoader, [], config),
                customPlugins: undefined
            };
        }

        const plugins = await this.pluginLoader.loadForBook({
            searchDirs: this.pluginSearchDirs,
            onConflict: 'override',
            enabledPluginIds: config.craft_plugins
        });

        const customPlugins: Record<string, CraftPluginDefinition> = {};
        for (const item of plugins) {
            const roles = item.plugin.applicable_roles.filter(
                (r): r is 'planner' | 'writer' => r === 'planner' || r === 'writer'
            );
            customPlugins[item.plugin.id] = {
                id: item.plugin.id,
                title: item.plugin.name,
                promptText: item.plugin.prompt_injection,
                applicable_roles: roles
            };
        }

        return {
            plugins,
            gateRules: resolveWriterGateRules(this.pluginLoader, plugins, config),
            customPlugins: Object.keys(customPlugins).length > 0 ? customPlugins : undefined
        };
    }

    private async readVoicePool(): Promise<VoiceSamplePool | undefined> {
        const opsPool = await this.store.readVoiceSamples();
        if (opsPool.samples.length > 0) {
            return opsPool;
        }
        const legacyRaw = await readOptionalText(
            join(this.store.bookRoot, 'world/voice_samples.yaml')
        );
        if (!legacyRaw) {
            return opsPool;
        }
        try {
            return parseVoiceSamplesYaml(legacyRaw);
        } catch {
            return opsPool;
        }
    }

    private async readOpsStyleAmendments(): Promise<string | undefined> {
        const { combined } = await readCombinedStyleAmendments(this.store.bookRoot, {
            readWorldAmendments: () => this.store.readOpsStyleAmendments(),
            order: 'world-first',
            dedupe: true
        });
        return combined;
    }


    private async loadHistoricalChapters(
        currentCh: number,
        windowSize: number,
        chapterFiles?: string[]
    ): Promise<HistoricalChapterInput[]> {
        const result: HistoricalChapterInput[] = [];
        const startCh = Math.max(1, currentCh - windowSize);
        for (let ch = startCh; ch < currentCh; ch += 1) {
            if (chapterFiles && !chapterFiles.includes(`${formatChapterKey(ch)}.md`)) continue;
            const path = join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(ch)}.md`);
            const text = await readOptionalText(path);
            if (text !== null) {
                result.push({ chapter: ch, text });
            }
        }
        return result;
    }

    private async loadChapterSummaryFromCards(
        chapterNumber: number,
        currentVolume: number,
        overlay?: ReadonlyMap<string, string | null>
    ): Promise<string | undefined> {
        const candidateVolumes =
            currentVolume > 1 ? [currentVolume, currentVolume - 1] : [currentVolume];
        for (const vol of candidateVolumes) {
            const relPath = formatVolumeCardRelPath(vol);
            const raw = overlay?.has(relPath)
                ? overlay.get(relPath)
                : await readOptionalText(join(this.store.bookRoot, relPath));
            if (!raw) continue;
            const section = parseL2CardSections(raw).sections.find((s) => s.chapterNumber === chapterNumber);
            if (section) {
                return section.plotSummary || undefined;
            }
        }
        return undefined;
    }

    private async loadPreviousChapter(
        currentCh: number,
        currentVolume: number,
        chapterFiles?: string[],
        overlay?: ReadonlyMap<string, string | null>
    ): Promise<PreviousChapterContext | undefined> {
        if (currentCh <= 1) return undefined;
        const prevCh = chapterFiles
            ? Math.max(
                  0,
                  ...chapterFiles
                      .map((file) => Number(file.slice(3, -3)))
                      .filter((chapter) => chapter < currentCh)
              )
            : currentCh - 1;
        if (prevCh === 0) return undefined;
        const prevText = await readOptionalText(
            join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(prevCh)}.md`)
        );
        if (prevText === null) return undefined;
        const summary = await this.loadChapterSummaryFromCards(prevCh, currentVolume, overlay);
        return {
            chapterNumber: prevCh,
            fullText: prevText,
            ...(summary ? { summary } : {})
        };
    }

    private buildEffectiveStagingOverlay(
        baseOverlay: Map<string, string | null> | undefined,
        snapshot: BookSnapshot,
        wokenColdIds: ReadonlySet<string>
    ): Map<string, string | null> | undefined {
        if (wokenColdIds.size === 0) {
            return baseOverlay;
        }
        const merged = new Map<string, string | null>(baseOverlay ?? []);
        for (const id of wokenColdIds) {
            const profile = snapshot.entities[id];
            const relPath = `entities/${id}.md`;
            if (profile && !merged.has(relPath)) {
                merged.set(relPath, serializeEntityMarkdown(profile));
            }
        }
        return merged.size > 0 ? merged : undefined;
    }

    private async buildParallelStagingOverlay(
        snapshot: BookSnapshot,
        parallel: { windowId: string; branchId: string }
    ): Promise<Map<string, string | null>> {
        const overlay = new Map<string, string | null>();
        for (const [id, profile] of Object.entries(snapshot.entities)) {
            overlay.set(`entities/${id}.md`, serializeEntityMarkdown(profile));
        }

        const allowedChapterNums = new Set(
            snapshot.chapterFiles
                .map((file) => {
                    const m = /^ch_(\d{4})\.md$/.exec(file);
                    return m?.[1] ? Number(m[1]) : null;
                })
                .filter((num): num is number => num !== null)
        );

        const branchDeltaRaw = await readOptionalText(
            join(
                this.store.bookRoot,
                `.ops/parallel_deltas/${parallel.windowId}/${parallel.branchId}.json`
            )
        );
        let branchL2Cards: ParallelL2CardEntry[] = [];
        if (branchDeltaRaw) {
            try {
                const parsedDelta = JSON.parse(branchDeltaRaw) as ParallelBranchDelta;
                branchL2Cards = parsedDelta.l2Cards ?? [];
            } catch {
                branchL2Cards = [];
            }
        }

        const currentVolume = snapshot.worldState.frontmatter.current_volume;
        const volumesToStage = new Set<number>([
            currentVolume,
            ...branchL2Cards.map((c) => c.volumeNumber)
        ]);
        for (const vol of volumesToStage) {
            const cardRelPath = formatVolumeCardRelPath(vol);
            const diskCard = await readOptionalText(join(this.store.bookRoot, cardRelPath));
            const filtered = filterL2CardByAllowedChapters(diskCard, allowedChapterNums, vol);
            const merged = mergeParallelCardEntries(filtered, vol, branchL2Cards);
            overlay.set(cardRelPath, merged);
        }

        return overlay;
    }

    private async loadActiveSignals(
        currentCh: number,
        lookbackChapters = 1
    ): Promise<{
        signals: OpsSignal[];
        nextCursorState: { consumedLines: number; consumedIds: string[] };
        hasCursorChanges: boolean;
    }> {
        const cursorState = await readSignalsCursorState(this.store.bookRoot);
        const raw = await readOptionalText(join(this.store.bookRoot, '.ops/signals.jsonl'));
        if (!raw) {
            return {
                signals: [],
                nextCursorState: {
                    consumedLines: 0,
                    consumedIds: cursorState.consumedIds
                },
                hasCursorChanges: false
            };
        }
        const nonEmptyLines = splitNonEmptyLines(raw);
        const alreadyConsumedIds = resolveConsumedSignalIds(cursorState, nonEmptyLines);

        const signals: OpsSignal[] = [];
        const newlyConsumedIds: string[] = [];
        const lineIds: Array<string | null> = [];

        for (let idx = 0; idx < nonEmptyLines.length; idx += 1) {
            const trimmed = nonEmptyLines[idx]!;
            try {
                const rawObj = JSON.parse(trimmed) as Record<string, unknown>;
                const parsed = OpsSignalSchema.safeParse(rawObj);
                if (!parsed.success) {
                    lineIds.push(null);
                    continue;
                }
                const sigId = resolveSignalId(rawObj);
                lineIds.push(sigId);

                if (alreadyConsumedIds.has(sigId)) {
                    continue;
                }
                if (parsed.data.chapter > currentCh) {
                    continue;
                }

                const isPersistentType =
                    parsed.data.type === 'RETCON' || parsed.data.type === 'SPOTLIGHT_TRIGGER';
                const withinLookback =
                    parsed.data.chapter >= Math.max(0, currentCh - lookbackChapters);

                if (isPersistentType || withinLookback) {
                    signals.push(parsed.data);
                }
                // 本章可消费信号（及超期未消费的普通 DIRECTOR_NOTE）在本章提交时统一标记为已消费
                newlyConsumedIds.push(sigId);
            } catch {
                lineIds.push(null);
            }
        }

        const nextConsumedSet = new Set<string>([...alreadyConsumedIds, ...newlyConsumedIds]);
        let nextConsumedLines = 0;
        for (let idx = 0; idx < lineIds.length; idx += 1) {
            const sigId = lineIds[idx];
            if (sigId === undefined || sigId === null || nextConsumedSet.has(sigId)) {
                nextConsumedLines = idx + 1;
            } else {
                break;
            }
        }

        return {
            signals,
            nextCursorState: {
                consumedLines: nextConsumedLines,
                consumedIds: Array.from(nextConsumedSet)
            },
            hasCursorChanges: newlyConsumedIds.length > 0
        };
    }

    private async triggerSafeHalt(snapshot: SafeHaltSnapshot): Promise<never> {
        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
        await writeFile(
            join(this.store.bookRoot, '.ops/safe_halt.json'),
            `${JSON.stringify(snapshot, null, 4)}\n`,
            'utf8'
        );
        throw new SafeHaltError(snapshot);
    }
}

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
    analyzeParagraphs,
    computeTelemetry,
    CraftPluginLoader,
    IndexRecall,
    ParallelSandbox,
    PrefixAssembler,
    serializeEntityMarkdown,
    sliceWorldDocuments,
    StaticProseGate,
    stripBlockingTags,
    traceArtifact,
    traceEvent,
    ViewSlicer,
    withTraceRun,
    withTraceStage,
    type BookSnapshot,
    type BookStore,
    type EntityPatch,
    type ForkParallelWindowOptions,
    type GateRuleConfig,
    type GateRuleId,
    type GateViolation,
    type HistoricalChapterInput,
    type LoadedCraftPlugin,
    type LlmPort,
    type MergeParallelWindowOptions,
    type PlannerOutline,
    type PreviousChapterContext,
    type ProseGateOptions,
    type ProseGateResult,
    type RecallSlice,
    type StaticPrefixInput,
    type SystemPort,
    type TimelineMode,
    type TokenUsage,
    type VoiceSamplePool
} from '@narrateos/dsh-book-store';
import type {
    FactCheckIssue,
    FactCheckOutput,
    YieldContextPackResult,
    YieldPatchedDraftResult,
    YieldStatePatchResult
} from '@narrateos/dsh-book-tools';
import { PlanConflictError, SafeHaltError, type SafeHaltSnapshot } from '../errors.js';
import type { RoleLoader } from '../roles/role-loader.js';
import type { RoleRunner } from '../runner/role-runner.js';
import {
    OpsSignalSchema,
    type EngineProgressEvent,
    type EngineStageName,
    type OpsSignal,
    type StageSessionEvent,
    type StepChapterOptions,
    type StepChapterResult
} from '../schemas.js';
import {
    addUsage,
    buildVerificationCorpus,
    buildVolumeStaticPrefix,
    createEmptyUsage,
    formatChapterKey,
    normalizeOpenThreads,
    normalizeOpsStyleAmendments,
    readOptionalText,
    readSignalsCursor,
    upsertVolumeCardEntry,
    writeSignalsCursor
} from './helpers.js';

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

function sanitizeExtractorPatches(
    snapshot: BookSnapshot,
    patches: EntityPatch[]
): EntityPatch[] {
    return patches.map((patch) => {
        if (snapshot.entities[patch.entity_id] && patch.canonical_name !== undefined) {
            const { canonical_name: _ignored, ...rest } = patch;
            return rest;
        }
        return patch;
    });
}

const GATE_POSITIVE_GUIDANCE: Record<string, string> = {
    tag_residue: '直接输出纯粹的小说散文正文，保持段落干净自然。',
    negation_contrast: '直接陈述当下发生的动作、神态与客观场景状态，以正面描摹推进句子。',
    subjective_judgment: '坚持第三人称客观镜头白描，借助具体动作、手势与口语对白自然显现人物态度与情绪。',
    micro_anatomy: '改用整体肢体动作、物件触碰、站位移动或简短对白刻画人物反应。',
    skeletal_quota: '以日常衣着动静、步态姿势与环境交互展现人物体态。',
    filler_trace: '选用具体可感的动作动词与实感细节描摹现场变化。',
    deictic_na: '使用明确的人名、物件名称或干净的短句衔接指代。',
    reduplication_verb: '采用干脆利落的单动作动词推进叙事节奏。',
    deictic_density: '通过具体的光线、声响、温度、气味与触感细节营造现场氛围。',
    filler_cliche: '使用贴合人物身份的生活化口语与日常动作白描推进情节。',
    ending_moralizing: '结尾定格在具体的动作落点、环境声响或待解事态的客观画面上，留出自然余韵。',
    cross_chapter_simile: '采用贴合当下场景的新鲜具象意象或直接白描，呈现独特的现场质感。'
};

export const GATE_MAX_PATCH_PARAGRAPHS = 15;
export const CLEANROOM_PATCH_FALLBACK_REASON =
    '请紧扣给定自然段与定位提示，重构人物动作细节、对话神态与场景衔接节奏';

const RESTRICTED_DIRECTIVE_CLAUSE_RE =
    /OMNISCIENT_SECRET|\bWARPED\b|\bSELF_ONLY(?:_[A-Z0-9_]*)?\b|CHARTER_SECRET|DIRECTOR_SECRET|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale|author_charter|arc_director_plan/i;

/** 剥离全知/废止/禁区信息并正向转写，确保净室写手与修补专员零泄露、零负面黑名单词 */
export function sanitizeTextForCleanroomWriter(raw: string): string {
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
                ''
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
function buildPositiveFactRewriteFeedback(issues: readonly FactCheckIssue[]): string {
    const lines: string[] = [];
    for (const issue of issues) {
        if (issue.severity === 'PLAN_CONFLICT') continue;
        const cleanDesc = sanitizeTextForCleanroomWriter(issue.description);
        if (!cleanDesc) continue;
        const cleanSource = issue.quote_source
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
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (/^#\s+\S/.test(firstLine)) {
        return trimmed;
    }
    const strippedTitle = (chapterTitle ?? '')
        .trim()
        .replace(/^第[0-9零一二三四五六七八九十百千万两]+章[：:\s-]*/, '')
        .trim();
    const headingText = strippedTitle.length > 0 ? strippedTitle : String(chapterNumber);
    return trimmed.length > 0 ? `# ${headingText}\n\n${trimmed}` : `# ${headingText}`;
}

/** 从当前卷 L2_cards Markdown 中提取最近至多 limit 条章节卡片 */
function extractRecentL2Cards(rawCardContent: string | null, limit = 2): string {
    if (!rawCardContent || rawCardContent.trim().length === 0) {
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
        this.pluginSearchDirs = deps.pluginSearchDirs ?? [];
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
        const timelineMode: TimelineMode =
            recoveredContext?.timelineMode ??
            options.timelineMode ??
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

        // 崩溃恢复：处于 FEAT_COMMITTED 时跳过生成直接补跑 Extractor 与 state 提交
        if (recovery.action === 'NEEDS_STATE_EXTRACTION' && recovery.activeChapter !== null) {
            const activeCh = recovery.activeChapter;
            emit('WAL_RECOVERY', activeCh, `从 FEAT_COMMITTED 恢复第 ${activeCh} 章状态抽取`);
            const relPath = `manuscripts/${formatChapterKey(activeCh)}.md`;
            const prose = await readFile(join(this.store.bookRoot, relPath), 'utf8');
            const targetDay =
                recoveredContext?.targetDay ??
                options.targetDay ??
                snapshot.worldState.frontmatter.story_day;

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
                totalUsage,
                options,
                parallel
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
            Math.max(
                snapshot.worldState.frontmatter.current_chapter,
                snapshot.txState.last_committed_ch
            ) + 1;
        if (
            parallel &&
            (!Number.isSafeInteger(chapterNumber) ||
                chapterNumber <=
                    Math.max(
                        snapshot.worldState.frontmatter.current_chapter,
                        snapshot.txState.last_committed_ch
                    ))
        ) {
            throw new Error('并行章号必须大于已提交章号，禁止覆盖主线或其他支线章节');
        }
        await traceEvent('run.context', { chapter: chapterNumber });

        const targetDay = options.targetDay ?? snapshot.worldState.frontmatter.story_day;
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

        // 写手静态前缀仅使用经 ViewSlicer 净室剥离后的正向文档 + writer 外部化角色提示词
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
            writerWorldDocs.currentArcEnvelope,
            writerRoleCfg.promptText
        );
        const plannerStaticPrefix = buildVolumeStaticPrefix(
            snapshot.config,
            snapshot.worldState.frontmatter.current_volume,
            staticBaseAndVoiceRaw,
            currentArcEnvelopeRaw
        );

        const { gateRules, plannerInjection, writerInjection } =
            await this.loadActivePlugins(snapshot.config);
        const previousChapter = await this.loadPreviousChapter(
            chapterNumber,
            snapshot.worldState.frontmatter.current_volume,
            snapshot.chapterFiles
        );
        const futureHorizon = (await this.store.readFutureHorizon()) ?? undefined;
        const openThreads = normalizeOpenThreads(await this.store.readOpenThreads());
        const opsStyleAmendments = await this.readOpsStyleAmendments();
        const historicalChapters = await this.loadHistoricalChapters(
            chapterNumber,
            snapshot.config.prose_gate.cross_chapter_simile_window,
            snapshot.chapterFiles
        );
        const voicePool = await this.readVoicePool();
        const {
            signals: activeSignals,
            currentCursor: signalsCursorBefore,
            nextCursor: signalsCursorAfter
        } = await this.loadActiveSignals(chapterNumber);

        // Step 1: Librarian (多轮受控探查 -> yield_context_pack)
        emit('LIBRARIAN', chapterNumber, '构建双层目录并执行成对回表检索');
        const { librarianOut, recallSlices } = await this.runLibrarian(
            snapshot,
            chapterNumber,
            targetDay,
            options.chapterGoal,
            previousChapter,
            totalUsage,
            options
        );
        const selectedLoreEntries = await this.loadSelectedLoreEntries(
            librarianOut.selected_lore_files
        );

        const spotlightEntityIds = activeSignals
            .filter(
                (s) =>
                    s.type === 'SPOTLIGHT_TRIGGER' &&
                    s.entity_id &&
                    snapshot.entities[s.entity_id]
            )
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
                              : s.type === 'RETCON'
                                ? `- [RETCON 圆回指令] (${s.conflict_id ?? '细节修正'}): ${s.reason}（请在本章顺带自然圆回该细节偏差）`
                                : `- [DIRECTOR_NOTE 微调指令]: ${s.reason}`
                      )
                  ].join('\n')
                : '';
        const effectivePlannerInjection = [plannerInjection, formattedSignalDirective]
            .filter(Boolean)
            .join('\n\n');

        let replanCount = 0;
        let writerAttempt = 0;
        let rewriteCount = 0;
        let patchRounds = 0;
        let planConflictFeedback: string | undefined;

        let activeOutline: PlannerOutline;
        let activeProse = '';
        let updatedVoicePool: VoiceSamplePool | undefined;
        let lastGateViolations: GateViolation[] = [];
        let lastFactIssues: FactCheckIssue[] = [];

        outerLoop: while (true) {
            // Step 2: Planner (多轮受控点查 -> yield_outline)
            const plannerStage: 'PLANNER' | 'REPLAN' = replanCount > 0 ? 'REPLAN' : 'PLANNER';
            const plannerAttempt = replanCount + 1;
            emit(
                plannerStage,
                chapterNumber,
                replanCount > 0 ? '改纲重排细纲 v2' : '生成章节细纲'
            );
            const planned = await this.runPlanner({
                snapshot,
                chapterNumber,
                targetDay,
                timelineMode,
                povCharIds,
                selectedEntityIds: mergedSelectedEntityIds,
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
                plannerInjection: effectivePlannerInjection,
                voicePool,
                planConflictFeedback,
                totalUsage,
                stage: plannerStage,
                attempt: plannerAttempt,
                triggerReason: replanCount > 0 ? 'FACT_PLAN_CONFLICT' : undefined,
                signal: options.signal,
                onStageSession: options.onStageSession
            });
            activeOutline = planned.outline;

            // Step 3: Writer (净室单轮无工具 Agent)
            writerAttempt += 1;
            emit('WRITER', chapterNumber, '净室单轮 Agent 执笔');
            const drafted = await this.runWriter({
                snapshot,
                chapterNumber,
                targetDay,
                timelineMode,
                povCharIds,
                selectedEntityIds: mergedSelectedEntityIds,
                recallSlices,
                selectedLoreEntries,
                outline: activeOutline,
                staticPrefix: writerStaticPrefix,
                previousChapter,
                opsStyleAmendments,
                writerInjection,
                voicePool,
                totalUsage,
                traceStage: 'writer',
                attempt: writerAttempt,
                signal: options.signal,
                onStageSession: options.onStageSession
            });
            activeProse = drafted.prose;
            updatedVoicePool = drafted.updatedVoicePool;

            while (true) {
                activeProse = ensureChapterHeading(
                    stripBlockingTags(activeProse).cleanText.trim(),
                    chapterNumber,
                    activeOutline.chapter_title
                );

                // Step 4: StaticProseGate (0 Token)
                emit('PROSE_GATE', chapterNumber, '运行 0 Token 静态文风门禁');
                await traceArtifact('draft.before_gate', activeProse);
                const proseGateOptions: ProseGateOptions = {
                    enableAntiCliche: snapshot.config.prose_gate.enable_anti_cliche,
                    enableCrossChapterSimile:
                        snapshot.config.prose_gate.enable_cross_chapter_simile,
                    crossChapterSimileWindow:
                        snapshot.config.prose_gate.cross_chapter_simile_window,
                    narrationSubjectivity: snapshot.config.narration_subjectivity,
                    maxPatchParagraphs: GATE_MAX_PATCH_PARAGRAPHS,
                    rules: gateRules,
                    historicalChapters
                };
                const gateResult = await withTraceStage('prose_gate', async () =>
                    this.gate.evaluate(activeProse, proseGateOptions)
                );
                lastGateViolations = gateResult.violations;
                await traceArtifact('prose_gate.result', gateResult);
                await traceEvent('gate.result', {
                    passed: gateResult.passed,
                    violations: gateResult.violations.length,
                    action: gateResult.recommendedAction
                });

                if (!gateResult.passed) {
                    const paragraphCount = Math.max(1, splitParagraphs(activeProse).length);
                    const violatedCount = gateResult.violatedParagraphIndices.length;
                    if (
                        violatedCount > 0 &&
                        violatedCount <= GATE_MAX_PATCH_PARAGRAPHS &&
                        violatedCount / paragraphCount <= 0.6 &&
                        patchRounds < 2
                    ) {
                        patchRounds += 1;
                        emit('LOCAL_PATCH', chapterNumber, `Gate 触发第 ${patchRounds} 轮局部修补`);
                        const reason = gateResult.violations
                            .map((v) => `[${v.ruleId}] ${v.message}`)
                            .join('; ');
                        activeProse = await this.runLocalPatch(
                            snapshot.config,
                            chapterNumber,
                            activeProse,
                            gateResult.violatedParagraphIndices,
                            reason,
                            totalUsage,
                            {
                                proseGateOptions,
                                violations: gateResult.violations,
                                attempt: patchRounds,
                                triggerReason: `PROSE_GATE: ${gateResult.exceededRules.join(',') || 'VIOLATION'}`,
                                signal: options.signal,
                                onStageSession: options.onStageSession
                            }
                        );
                        continue;
                    }

                    if (rewriteCount < 1) {
                        rewriteCount += 1;
                        emit('REWRITE', chapterNumber, 'Gate 触发整章重写');
                        const rewritten = await this.executeRewrite({
                            snapshot,
                            chapterNumber,
                            targetDay,
                            timelineMode,
                            povCharIds,
                            selectedEntityIds: mergedSelectedEntityIds,
                            recallSlices,
                            selectedLoreEntries,
                            outline: activeOutline,
                            staticPrefix: writerStaticPrefix,
                            previousChapter,
                            opsStyleAmendments,
                            writerInjection,
                            voicePool,
                            totalUsage,
                            rewriteFeedback: buildPositiveGateRewriteFeedback(gateResult),
                            attempt: rewriteCount,
                            triggerReason: `PROSE_GATE: ${gateResult.exceededRules.join(',') || 'VIOLATION'}`,
                            signal: options.signal,
                            onStageSession: options.onStageSession
                        });
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

                // Step 5: Fact Checker (多轮受控查证 -> yield_verdict)
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
                    currentArcEnvelopeRaw,
                    arcDirectorPlanRaw,
                    totalUsage,
                    options
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
                            replanCount,
                            rewriteCount,
                            patchRounds,
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

                if (
                    !hasMultiRewrite &&
                    patchIndices.length > 0 &&
                    patchIndices.length <= 4 &&
                    patchRounds < 2
                ) {
                    patchRounds += 1;
                    emit('LOCAL_PATCH', chapterNumber, `Fact Checker 触发第 ${patchRounds} 轮局部修补`);
                    const reason = verifiedIssues.map((i) => i.description).join('; ');
                    activeProse = await this.runLocalPatch(
                        snapshot.config,
                        chapterNumber,
                        activeProse,
                        patchIndices,
                        reason,
                        totalUsage,
                        {
                            proseGateOptions,
                            factIssues: verifiedIssues,
                            attempt: patchRounds,
                            triggerReason: `FACT_CHECKER: ${reason}`,
                            signal: options.signal,
                            onStageSession: options.onStageSession
                        }
                    );
                    continue;
                }

                if (rewriteCount < 1) {
                    rewriteCount += 1;
                    emit('REWRITE', chapterNumber, 'Fact Checker 触发整章重写');
                    const rewritten = await this.executeRewrite({
                        snapshot,
                        chapterNumber,
                        targetDay,
                        timelineMode,
                        povCharIds,
                        selectedEntityIds: mergedSelectedEntityIds,
                        recallSlices,
                        selectedLoreEntries,
                        outline: activeOutline,
                        staticPrefix: writerStaticPrefix,
                        previousChapter,
                        opsStyleAmendments,
                        writerInjection,
                        voicePool,
                        totalUsage,
                        rewriteFeedback: buildPositiveFactRewriteFeedback(verifiedIssues),
                        attempt: rewriteCount,
                        triggerReason: `FACT_CHECKER: ${verifiedIssues.map((i) => i.severity).join(',')}`,
                        signal: options.signal,
                        onStageSession: options.onStageSession
                    });
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

        // Step 6: WAL 第 1 粒度提交 (feat + outline snapshot) -> Extractor -> WAL 第 2 粒度提交 (state)
        activeProse = ensureChapterHeading(
            activeProse,
            chapterNumber,
            activeOutline.chapter_title
        );
        await this.store.beginDraft(chapterNumber);
        const featRes = await this.store.commitDraft(
            chapterNumber,
            activeProse,
            {
                timelineMode,
                targetDay,
                povCharIds,
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
            totalUsage,
            options,
            parallel
        );

        if (
            !options.chapterGoal.includes('[待响应运维信号]') &&
            signalsCursorAfter > signalsCursorBefore
        ) {
            await writeSignalsCursor(this.store.bookRoot, signalsCursorAfter);
        }

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

    /** 执行 Step 1: Librarian 多轮受控探查 -> yield_context_pack */
    private async runLibrarian(
        snapshot: BookSnapshot,
        chapterNumber: number,
        targetDay: number,
        chapterGoal: string,
        previousChapter: PreviousChapterContext | undefined,
        totalUsage: TokenUsage,
        options: StepChapterOptions
    ): Promise<{ librarianOut: YieldContextPackResult['payload']; recallSlices: RecallSlice[] }> {
        const catalog = await this.recall.buildLibrarianCatalog(this.store.bookRoot, {
            currentVolume: snapshot.worldState.frontmatter.current_volume,
            chapterFiles: snapshot.chapterFiles
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
                const latestSummarySource =
                    eligibleAcquired.at(-1)?.text ?? eligibleBuffer.at(-1)?.text ?? '';
                const normalizedSummary = latestSummarySource.replace(/\s+/g, ' ').trim();
                const statusSummary =
                    normalizedSummary.length > 60
                        ? `${normalizedSummary.slice(0, 59)}…`
                        : normalizedSummary;
                const statusSuffix = statusSummary ? ` | 现状: ${statusSummary}` : '';
                return `- ${e.metadata.entity_id}: ${e.metadata.canonical_name}${suffix} [last_seen_ch=${e.metadata.last_seen_ch}]${statusSuffix}`;
            })
            .join('\n');

        const coldArchiveSection =
            snapshot.coldArchiveIds.length > 0
                ? [
                      '',
                      '## 冷宫休眠实体清单 (entities/cold_archive/)',
                      snapshot.coldArchiveIds.map((id) => `- ${id}`).join('\n')
                  ]
                : [];

        const worldSummary = snapshot.worldState.summaryMarkdown.trim();
        const prevTailSlice = previousChapter?.fullText?.trim()
            ? previousChapter.fullText.trim().slice(-600)
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
            `## 本章目标 (${formatChapterKey(chapterNumber)}, story_day=${targetDay})`,
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
            taskPrompt,
            signal: options.signal,
            onStageSession: options.onStageSession
        });
        addUsage(totalUsage, runRes.usage);

        const pack = runRes.yieldResult;
        const mergedSlices: RecallSlice[] = [...pack.recalledSlices];

        for (const rawSlice of pack.payload.recall_slices) {
            if (!mergedSlices.some((s) => s.snippet === rawSlice.snippet)) {
                const chNum = rawSlice.chapter_number ?? 0;
                const chId = chNum > 0 ? formatChapterKey(chNum) : 'ch_0000';
                mergedSlices.push({
                    ...(rawSlice.entity_id ? { requiredEntityId: rawSlice.entity_id } : {}),
                    file: rawSlice.file ?? '',
                    chapterId: chId,
                    chapterNumber: chNum,
                    chapterDay: null,
                    targetChapter: chapterNumber,
                    targetDay,
                    deltaChapters: Math.max(0, chapterNumber - chNum),
                    deltaDays: null,
                    line: 1,
                    text: rawSlice.snippet,
                    contextBefore: [],
                    contextAfter: [],
                    matchedKeys: rawSlice.entity_id ? [rawSlice.entity_id] : [],
                    snippet: rawSlice.snippet
                });
            }
        }

        return {
            librarianOut: pack.payload,
            recallSlices: mergedSlices
        };
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
        plannerInjection: string;
        voicePool: VoiceSamplePool | undefined;
        planConflictFeedback: string | undefined;
        totalUsage: TokenUsage;
        stage: 'PLANNER' | 'REPLAN';
        attempt: number;
        triggerReason?: string | undefined;
        signal?: AbortSignal | undefined;
        onStageSession?: ((event: StageSessionEvent) => void) | undefined;
    }): Promise<{ outline: PlannerOutline; plannerView: ReturnType<ViewSlicer['slice']> }> {
        const plannerView = this.slicer.slice({
            snapshot: params.snapshot,
            forRole: 'planner',
            targetDay: params.targetDay,
            currentCh: params.chapterNumber,
            timelineMode: params.timelineMode,
            povCharId: params.povCharIds,
            entityIds: params.selectedEntityIds.length > 0 ? params.selectedEntityIds : undefined
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
            params.plannerInjection ? `\n## 激活文风插件与调度信号\n${params.plannerInjection}` : ''
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
            pool: 'strong_creative'
        });

        const taskPrompt = [
            ...assembled.request.staticPrefixBlocks,
            assembled.request.dynamicTail,
            '',
            '请完成必要点查后调用 `yield_outline` 提交结构化细纲（严格保持 director_rationale 与 outline_text 里表分流）。'
        ].join('\n\n');

        const runRes = await this.roleRunner.runMultiTurn<PlannerOutline>({
            roleId: 'planner',
            stage: params.stage,
            attempt: params.attempt,
            ...(params.triggerReason ? { triggerReason: params.triggerReason } : {}),
            chapterNumber: params.chapterNumber,
            bookRoot: this.store.bookRoot,
            bookConfig: params.snapshot.config,
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
        previousChapter: PreviousChapterContext | undefined;
        opsStyleAmendments: string | undefined;
        writerInjection: string;
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
        previousChapter: PreviousChapterContext | undefined;
        opsStyleAmendments: string | undefined;
        writerInjection: string;
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
    }> {
        const writerView = this.slicer.slice({
            snapshot: params.snapshot,
            forRole: 'writer',
            targetDay: params.targetDay,
            currentCh: params.chapterNumber,
            timelineMode: params.timelineMode,
            povCharId: params.povCharIds,
            entityIds: params.selectedEntityIds.length > 0 ? params.selectedEntityIds : undefined
        });

        for (const slice of params.recallSlices) {
            if (slice.requiredEntityId && !writerView.entities[slice.requiredEntityId]) {
                throw new Error(`写手成对召回缺少可见实体档案: ${slice.requiredEntityId}`);
            }
        }

        // 物理丢弃 outline.director_rationale，严禁导演全知内参进入写手窗口
        const outlineText = [
            `标题：${params.outline.chapter_title}`,
            `目标字数：${params.outline.target_word_count}`,
            `收尾节拍：${params.outline.ending_beat}`,
            `本章实质波折：${params.outline.chapter_turn}`,
            params.outline.outline_text,
            params.writerInjection ? `\n文风插件要求：\n${params.writerInjection}` : '',
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
            loreEntries: params.selectedLoreEntries,
            previousChapter: params.previousChapter,
            opsStyleAmendments: params.opsStyleAmendments,
            voicePool: params.voicePool,
            preferredVoiceTag: params.outline.preferred_voice_tag,
            pool: 'strong_creative'
        });

        const traceStage = params.traceStage ?? 'writer';
        const stage = traceStage === 'rewrite' ? 'REWRITE' : 'WRITER';
        const { response } = await this.roleRunner.runCleanroom({
            roleId: 'writer',
            stage,
            attempt: params.attempt,
            triggerReason: params.triggerReason,
            bookRoot: this.store.bookRoot,
            bookConfig: params.snapshot.config,
            chapterNumber: params.chapterNumber,
            request: {
                ...assembled.request,
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
        return {
            prose: cleanProse,
            writerView,
            updatedVoicePool: assembled.diagnostics.updatedVoicePool
        };
    }

    /**
     * 执行局部 Patch：
     * - 当 patch.yml 配置 cleanroom=false（默认预设）时，运行纯内存多轮净室闭环（patch_paragraphs + yield_patched_draft）；
     * - 当单书覆写 patch.yml 配置 cleanroom=true 时，保留单轮净室分组改写向后兼容。
     */
    private async runLocalPatch(
        bookConfig: BookSnapshot['config'],
        chapterNumber: number,
        prose: string,
        violatedIndices: number[],
        reason: string,
        totalUsage: TokenUsage,
        patchOptions: {
            proseGateOptions?: ProseGateOptions | undefined;
            violations?: GateViolation[] | undefined;
            factIssues?: FactCheckIssue[] | undefined;
            attempt?: number | undefined;
            triggerReason?: string | undefined;
            signal?: AbortSignal | undefined;
            onStageSession?: ((event: StageSessionEvent) => void) | undefined;
        } = {}
    ): Promise<string> {
        const paragraphs = splitParagraphs(prose);
        if (paragraphs.length === 0 || violatedIndices.length === 0) {
            return prose;
        }

        const sortedUnique = Array.from(
            new Set(violatedIndices.filter((idx) => idx >= 0 && idx < paragraphs.length))
        ).sort((a, b) => a - b);
        if (sortedUnique.length === 0) {
            return prose;
        }

        let patchRoleCfg;
        try {
            patchRoleCfg = await this.roleLoader.loadRoleConfig('patch', this.store.bookRoot);
        } catch (err: unknown) {
            if (err instanceof Error && err.message.includes('未找到角色配置文件')) {
                patchRoleCfg = await this.roleLoader.loadRoleConfig('writer', this.store.bookRoot);
            } else {
                throw err;
            }
        }

        const cleanReason = sanitizeTextForCleanroomWriter(reason);
        const patchReasonText = cleanReason || CLEANROOM_PATCH_FALLBACK_REASON;

        if (!patchRoleCfg.cleanroom) {
            const violationLines = (patchOptions.violations ?? []).map(
                (v) =>
                    `- [${v.paragraphIndex}] (${v.ruleId}, line ${v.line}:${v.column}) 命中 "${v.matchedText}" | 行内容: ${v.lineText}`
            );
            const factIssueLines: string[] = [];
            for (const issue of patchOptions.factIssues ?? []) {
                const cleanDesc = sanitizeTextForCleanroomWriter(issue.description);
                if (!cleanDesc) continue;
                const indices = [
                    ...(issue.paragraph_index !== undefined ? [issue.paragraph_index] : []),
                    ...(issue.paragraph_indices ?? [])
                ];
                const idxLabel = indices.length > 0 ? `[${indices.join(', ')}]` : '[待定位]';
                const cleanSource = issue.quote_source
                    ? sanitizeTextForCleanroomWriter(issue.quote_source)
                    : '';
                const quoteInfo = cleanSource ? ` | 参考基准: ${cleanSource}` : '';
                factIssueLines.push(`- ${idxLabel} ${cleanDesc}${quoteInfo}`);
            }
            const numberedParagraphs = paragraphs
                .map((p, idx) => `[${idx}] ${p}`)
                .join('\n\n');

            const taskPrompt = [
                `## 修补原因与触发来源\n${patchReasonText}`,
                `## 待修补段落索引 (0-based)\n[${sortedUnique.join(', ')}]`,
                violationLines.length > 0 ? `## 静态门禁违规定位清单\n${violationLines.join('\n')}` : '',
                factIssueLines.length > 0 ? `## 事实核查修补清单\n${factIssueLines.join('\n')}` : '',
                `## 叙事人称与主观度基准\n${bookConfig.narration_subjectivity}`,
                `## 当前待修补正文（0-based 段落索引）\n${numberedParagraphs}`,
                '请对照 0-based 段落索引调用 `patch_paragraphs` 精准替换目标段落；每次修改后依据即时门禁诊断继续微调，确认全部段落通过后调用 `yield_patched_draft` 提交定稿。'
            ]
                .filter(Boolean)
                .join('\n\n');

            const runRes = await this.roleRunner.runMultiTurn<YieldPatchedDraftResult>({
                roleId: patchRoleCfg.id,
                stage: 'LOCAL_PATCH',
                chapterNumber,
                bookRoot: this.store.bookRoot,
                bookConfig,
                draftText: prose,
                proseGateOptions: patchOptions.proseGateOptions,
                enforceProseGateOnYield: true,
                attempt: patchOptions.attempt,
                triggerReason: patchOptions.triggerReason,
                taskPrompt,
                signal: patchOptions.signal,
                onStageSession: patchOptions.onStageSession
            });
            addUsage(totalUsage, runRes.usage);
            return runRes.yieldResult.patchedProse;
        }

        // 单书显式覆写 cleanroom=true 时的单轮分组净室兼容分支
        const groups: Array<{ start: number; end: number }> = [];
        for (const idx of sortedUnique) {
            const last = groups[groups.length - 1];
            if (last && idx === last.end + 1) {
                last.end = idx;
            } else {
                groups.push({ start: idx, end: idx });
            }
        }

        const updatedParagraphs = [...paragraphs];
        for (let g = groups.length - 1; g >= 0; g -= 1) {
            const group = groups[g]!;
            const beforeContext = group.start > 0 ? updatedParagraphs[group.start - 1] : undefined;
            const afterContext =
                group.end < updatedParagraphs.length - 1
                    ? updatedParagraphs[group.end + 1]
                    : undefined;
            const targetSegments = updatedParagraphs.slice(group.start, group.end + 1);

            const { response } = await this.roleRunner.runCleanroom({
                roleId: patchRoleCfg.id,
                stage: 'LOCAL_PATCH',
                attempt: patchOptions.attempt,
                triggerReason: patchOptions.triggerReason,
                bookRoot: this.store.bookRoot,
                bookConfig,
                chapterNumber,
                request: {
                    pool: patchRoleCfg.pool,
                    traceStage: 'patch',
                    temperature: patchRoleCfg.temperature,
                    staticPrefixBlocks: [patchRoleCfg.promptText],
                    dynamicTail: [
                        `## 修补原因\n${patchReasonText}`,
                        beforeContext ? `## 前文衔接参考（只读勿输出）\n${beforeContext}` : '',
                        `## 需重写的目标段落\n${targetSegments.join('\n\n')}`,
                        afterContext ? `## 后文衔接参考（只读勿输出）\n${afterContext}` : ''
                    ]
                        .filter(Boolean)
                        .join('\n\n')
                },
                signal: patchOptions.signal,
                onStageSession: patchOptions.onStageSession
            });
            addUsage(totalUsage, response.usage);

            const patchedClean = stripBlockingTags(response.text).cleanText.trim();
            const replacementParagraphs = splitParagraphs(patchedClean);
            if (replacementParagraphs.length > 0) {
                updatedParagraphs.splice(
                    group.start,
                    group.end - group.start + 1,
                    ...replacementParagraphs
                );
            }
        }

        return updatedParagraphs.join('\n\n');
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
        totalUsage: TokenUsage,
        options: StepChapterOptions
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

        const taskPrompt = [
            arcDirectorPlan
                ? `## 导演禁区计划 (world/arc_director_plan.md)\n${arcDirectorPlan.trim()}`
                : '',
            `## 细纲概要\n${outline.outline_text}`,
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
            taskPrompt,
            signal: options.signal,
            onStageSession: options.onStageSession
        });
        addUsage(totalUsage, runRes.usage);

        const verdict = runRes.yieldResult;
        if (verdict.passed || verdict.issues.length === 0) {
            return [];
        }
        return verdict.issues;
    }

    /** 执行 Step 6: Extractor 多轮抽取 -> yield_state_patch 门禁 -> 遥测/L2卡/声纹/state 提交 */
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
        totalUsage: TokenUsage,
        options: StepChapterOptions,
        parallel?: { windowId: string; branchId: string }
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

        const currentVolume = snapshot.worldState.frontmatter.current_volume;
        const cardRelPath = `index/L2_cards/vol_${String(currentVolume).padStart(2, '0')}_cards.md`;
        const [worldStateRaw, openThreadsRaw, rawVolumeCards] = await Promise.all([
            readOptionalText(join(this.store.bookRoot, 'world/world_state.md')),
            readOptionalText(join(this.store.bookRoot, 'world/open_threads.md')),
            readOptionalText(join(this.store.bookRoot, cardRelPath))
        ]);
        const recentL2Cards = extractRecentL2Cards(rawVolumeCards, 2);

        const taskPrompt = [
            ...(worldStateRaw && worldStateRaw.trim().length > 0
                ? [`## 当前世界状态全文 (world/world_state.md)\n${worldStateRaw.trim()}`]
                : []),
            ...(openThreadsRaw && openThreadsRaw.trim().length > 0
                ? [`## 当前跨卷伏笔台账 (world/open_threads.md)\n${openThreadsRaw.trim()}`]
                : []),
            ...(recentL2Cards
                ? [`## 当前卷近期章节卡片 (${cardRelPath})\n${recentL2Cards}`]
                : []),
            `## 当前实体档案视图\n${entitySummary || '(暂无实体)'}`,
            `## 第 ${chapterNumber} 章定稿正文 (mode=${timelineMode}, story_day=${targetDay})\n${prose}`,
            '',
            '请抽取实体补丁、story_day_delta、双轨章卡摘要及 2~3 条 next_chapter_options，并调用 `yield_state_patch` 提交。'
        ].join('\n\n');

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
            ...(parallel
                ? {
                      visibleEntities: snapshot.entities,
                      reachableIds: branchReachableIds
                  }
                : {}),
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

        const plannedPaths = [
            '.ops/telemetry.jsonl',
            '.ops/next_chapter_options.json',
            cardRelPath,
            ...(updatedVoicePool ? ['.ops/voice_samples.yaml'] : []),
            ...(branchPath
                ? [branchPath]
                : sanitizedPatches.map((patch) => `entities/${patch.entity_id}.md`)),
            ...(parallel ? [] : ['world/world_state.md'])
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

        const freezeMainlineStoryDay =
            timelineMode === 'FLASHBACK' || timelineMode === 'PARALLEL';
        const nextStoryDay = freezeMainlineStoryDay
            ? targetDay
            : snapshot.worldState.frontmatter.story_day + extracted.story_day_delta;

        const cardAbsPath = join(this.store.bookRoot, cardRelPath);
        await mkdir(join(this.store.bookRoot, 'index/L2_cards'), { recursive: true });
        const existingCard = await readOptionalText(cardAbsPath);
        const updatedCard = upsertVolumeCardEntry(
            existingCard,
            currentVolume,
            chapterNumber,
            nextStoryDay,
            extracted.chapter_summary,
            [...povCharIds, ...sanitizedPatches.map((patch) => patch.entity_id)]
        );
        await writeFile(cardAbsPath, updatedCard, 'utf8');
        extraCommitPaths.push(cardRelPath);

        const worldStateUpdate =
            timelineMode === 'FLASHBACK' || timelineMode === 'PARALLEL'
                ? undefined
                : {
                      current_chapter: Math.max(
                          snapshot.worldState.frontmatter.current_chapter,
                          chapterNumber
                      ),
                      story_day:
                          snapshot.worldState.frontmatter.story_day + extracted.story_day_delta,
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
                daySpan: extracted.story_day_delta,
                povCharacter: povCharIds[0]
            });
            extraCommitPaths.push(branchPath);
        }

        const patchRes = await this.store.applyStatePatch(
            chapterNumber,
            parallel ? [] : sanitizedPatches,
            {
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

    private async loadActivePlugins(config: BookSnapshot['config']): Promise<{
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
                typeof record['text'] === 'string' && record['text'].trim().length > 0
                    ? record['text']
                    : typeof record['sample'] === 'string' && record['sample'].trim().length > 0
                      ? record['sample']
                      : '';
            if (!rawText) return [];
            const id =
                typeof record['id'] === 'string' && record['id'].trim().length > 0
                    ? record['id'].trim()
                    : `voice_${String(idx + 1).padStart(2, '0')}`;
            const tag =
                typeof record['tag'] === 'string' && record['tag'].trim().length > 0
                    ? record['tag'].trim()
                    : '默认';
            const lastUsedCh =
                typeof record['last_used_ch'] === 'number' &&
                Number.isFinite(record['last_used_ch'])
                    ? record['last_used_ch']
                    : 0;
            const useCount =
                typeof record['use_count'] === 'number' && Number.isFinite(record['use_count'])
                    ? record['use_count']
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

    private async writeVoicePool(pool: VoiceSamplePool): Promise<void> {
        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
        await writeFile(
            join(this.store.bookRoot, '.ops/voice_samples.yaml'),
            stringifyYaml(pool, { lineWidth: 0 }),
            'utf8'
        );
    }

    private async readOpsStyleAmendments(): Promise<string | undefined> {
        const primary = normalizeOpsStyleAmendments(
            await readOptionalText(join(this.store.bookRoot, '.ops/style_amendments.md'))
        );
        if (primary) return primary;
        return normalizeOpsStyleAmendments(
            await this.store.readOpsStyleAmendments()
        );
    }

    private async loadSelectedLoreEntries(selectedFiles: string[]): Promise<string[]> {
        const entries: string[] = [];
        const seen = new Set<string>();
        for (const rawName of selectedFiles) {
            const trimmed = rawName.trim();
            if (!trimmed) continue;
            const normalizedName = trimmed.replace(/^lore_library\//, '');
            const fileName = normalizedName.endsWith('.md')
                ? normalizedName
                : `${normalizedName}.md`;
            if (!/^lore_[a-zA-Z0-9_-]+\.md$/.test(fileName) || seen.has(fileName)) {
                continue;
            }
            seen.add(fileName);
            const content = await readOptionalText(
                join(this.store.bookRoot, 'lore_library', fileName)
            );
            if (content && content.trim().length > 0) {
                entries.push(content.trim());
            }
        }
        return entries;
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
        currentVolume: number
    ): Promise<string | undefined> {
        const chKey = formatChapterKey(chapterNumber);
        const sectionRe = new RegExp(
            `^##\\s+${chKey}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+ch_\\d{4}\\b|(?![\\s\\S]))`,
            'm'
        );
        const candidateVolumes =
            currentVolume > 1 ? [currentVolume, currentVolume - 1] : [currentVolume];
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

    private async loadPreviousChapter(
        currentCh: number,
        currentVolume: number,
        chapterFiles?: string[]
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
        const summary = await this.loadChapterSummaryFromCards(prevCh, currentVolume);
        return {
            chapterNumber: prevCh,
            fullText: prevText,
            ...(summary ? { summary } : {})
        };
    }

    private async loadActiveSignals(currentCh: number): Promise<{
        signals: OpsSignal[];
        currentCursor: number;
        nextCursor: number;
    }> {
        const currentCursor = await readSignalsCursor(this.store.bookRoot);
        const raw = await readOptionalText(join(this.store.bookRoot, '.ops/signals.jsonl'));
        if (!raw) {
            return { signals: [], currentCursor: 0, nextCursor: 0 };
        }
        const nonEmptyLines = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        const safeCursor = currentCursor > nonEmptyLines.length ? 0 : currentCursor;

        const signals: OpsSignal[] = [];
        let nextCursor = safeCursor;
        let contiguousPrefix = true;

        for (let idx = safeCursor; idx < nonEmptyLines.length; idx += 1) {
            const trimmed = nonEmptyLines[idx]!;
            try {
                const parsed = OpsSignalSchema.safeParse(JSON.parse(trimmed));
                if (parsed.success && parsed.data.chapter <= currentCh) {
                    if (parsed.data.chapter >= Math.max(0, currentCh - 1)) {
                        signals.push(parsed.data);
                    }
                    if (contiguousPrefix) {
                        nextCursor = idx + 1;
                    }
                } else if (!parsed.success) {
                    if (contiguousPrefix) {
                        nextCursor = idx + 1;
                    }
                } else {
                    contiguousPrefix = false;
                }
            } catch {
                // 忽略格式异常的信号行
                if (contiguousPrefix) {
                    nextCursor = idx + 1;
                }
            }
        }
        return { signals, currentCursor: safeCursor, nextCursor };
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

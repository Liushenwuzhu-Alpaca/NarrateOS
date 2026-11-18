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

function splitParagraphs(text: string): string[] {
    return analyzeParagraphs(text).paragraphs;
}

/**
 * 单章 6 阶段生产管线：
 * - 多轮探查工种 (`Librarian`, `Planner`, `Fact Checker`, `Extractor`) 经 RoleRunner (ctx.agents.create + yield_*) 执行；
 * - 文学执笔与局部修补 (`Writer`, `Patch`) 经净室零工具单轮流 (ctx.llm) 执行，物理剥离禁区与隐秘视图；
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
            emit(
                'PLANNER',
                chapterNumber,
                replanCount > 0 ? '改纲重排细纲 v2' : '生成章节细纲'
            );
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
                plannerStaticPrefix,
                previousChapter,
                futureHorizon,
                openThreads,
                opsStyleAmendments,
                authorCharterRaw,
                arcDirectorPlanRaw,
                effectivePlannerInjection,
                voicePool,
                planConflictFeedback,
                totalUsage,
                options
            );
            activeOutline = planned.outline;

            // Step 3: Writer (净室单轮无工具 Agent)
            emit('WRITER', chapterNumber, '净室单轮 Agent 执笔');
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
                writerStaticPrefix,
                previousChapter,
                opsStyleAmendments,
                writerInjection,
                voicePool,
                totalUsage,
                options.signal,
                options.onStageSession
            );
            activeProse = drafted.prose;
            updatedVoicePool = drafted.updatedVoicePool;

            while (true) {
                activeProse = stripBlockingTags(activeProse).cleanText.trim();

                // Step 4: StaticProseGate (0 Token)
                emit('PROSE_GATE', chapterNumber, '运行 0 Token 静态文风门禁');
                await traceArtifact('draft.before_gate', activeProse);
                const gateResult = await withTraceStage('prose_gate', async () =>
                    this.gate.evaluate(activeProse, {
                        enableAntiCliche: snapshot.config.prose_gate.enable_anti_cliche,
                        enableCrossChapterSimile:
                            snapshot.config.prose_gate.enable_cross_chapter_simile,
                        crossChapterSimileWindow:
                            snapshot.config.prose_gate.cross_chapter_simile_window,
                        narrationSubjectivity: snapshot.config.narration_subjectivity,
                        rules: gateRules,
                        historicalChapters
                    })
                );
                lastGateViolations = gateResult.violations;
                await traceArtifact('prose_gate.result', gateResult);
                await traceEvent('gate.result', {
                    passed: gateResult.passed,
                    violations: gateResult.violations.length,
                    action: gateResult.recommendedAction
                });

                if (!gateResult.passed) {
                    if (gateResult.recommendedAction === 'PATCH' && patchRounds < 2) {
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
                            options.signal,
                            options.onStageSession
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
                            writerStaticPrefix,
                            previousChapter,
                            opsStyleAmendments,
                            writerInjection,
                            voicePool,
                            totalUsage,
                            options.signal,
                            options.onStageSession
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
                    patchIndices.length <= 2 &&
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
                        options.signal,
                        options.onStageSession
                    );
                    continue;
                }

                if (rewriteCount < 1) {
                    rewriteCount += 1;
                    emit('REWRITE', chapterNumber, 'Fact Checker 触发整章重写');
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
                        writerStaticPrefix,
                        previousChapter,
                        opsStyleAmendments,
                        writerInjection,
                        voicePool,
                        totalUsage,
                        options.signal,
                        options.onStageSession
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

        // Step 6: WAL 第 1 粒度提交 (feat + outline snapshot) -> Extractor -> WAL 第 2 粒度提交 (state)
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
                return `- ${e.metadata.entity_id}: ${e.metadata.canonical_name}${suffix}`;
            })
            .join('\n');

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

    /** 执行 Step 2: Planner 多轮受控点查 -> yield_outline */
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
        authorCharter: string | null,
        arcDirectorPlan: string | null,
        plannerInjection: string,
        voicePool: VoiceSamplePool | undefined,
        planConflictFeedback: string | undefined,
        totalUsage: TokenUsage,
        options: StepChapterOptions
    ): Promise<{ outline: PlannerOutline; plannerView: ReturnType<ViewSlicer['slice']> }> {
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
            ? Array.from(
                  new Set(voicePool.samples.map((s) => s.tag.trim()).filter((t) => t.length > 0))
              )
            : [];

        const goalWithFeedback = [
            chapterGoal,
            authorCharter ? `\n## 作者契约 (world/author_charter.md)\n${authorCharter.trim()}` : '',
            arcDirectorPlan
                ? `\n## 导演禁区计划 (world/arc_director_plan.md)\n${arcDirectorPlan.trim()}`
                : '',
            openThreads ? `\n## 跨卷未解伏笔 (open_threads.md)\n${openThreads}` : '',
            availableVoiceTags.length > 0
                ? `\n## 可用声纹标签枚举 (preferred_voice_tag)\n请从以下标签中择一填入 preferred_voice_tag：${availableVoiceTags.join('、')}`
                : '',
            planConflictFeedback
                ? `\n## 必须修正的物理/因果冲突 (v2 重规划)\n${planConflictFeedback}`
                : '',
            plannerInjection ? `\n## 激活文风插件与调度信号\n${plannerInjection}` : ''
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

        const taskPrompt = [
            ...assembled.request.staticPrefixBlocks,
            assembled.request.dynamicTail,
            '',
            '请完成必要点查后调用 `yield_outline` 提交结构化细纲（严格保持 director_rationale 与 outline_text 里表分流）。'
        ].join('\n\n');

        const runRes = await this.roleRunner.runMultiTurn<PlannerOutline>({
            roleId: 'planner',
            stage: 'PLANNER',
            chapterNumber,
            bookRoot: this.store.bookRoot,
            bookConfig: snapshot.config,
            taskPrompt,
            signal: options.signal,
            onStageSession: options.onStageSession
        });
        addUsage(totalUsage, runRes.usage);

        return {
            outline: runRes.yieldResult,
            plannerView
        };
    }

    /** 执行 Step 3: Writer 净室单轮执笔 (零工具、零 sessionId、物理隔离禁区) */
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
        signal?: AbortSignal,
        onStageSession?: (event: StageSessionEvent) => void
    ): Promise<{
        prose: string;
        writerView: ReturnType<ViewSlicer['slice']>;
        updatedVoicePool?: VoiceSamplePool | undefined;
    }> {
        const writerView = this.slicer.slice({
            snapshot,
            forRole: 'writer',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds,
            entityIds: selectedEntityIds.length > 0 ? selectedEntityIds : undefined
        });

        for (const slice of recallSlices) {
            if (slice.requiredEntityId && !writerView.entities[slice.requiredEntityId]) {
                throw new Error(`写手成对召回缺少可见实体档案: ${slice.requiredEntityId}`);
            }
        }

        // 物理丢弃 outline.director_rationale，严禁导演全知内参进入写手窗口
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

        const { response } = await this.roleRunner.runCleanroom({
            roleId: 'writer',
            bookRoot: this.store.bookRoot,
            bookConfig: snapshot.config,
            chapterNumber,
            request: {
                ...assembled.request,
                traceStage: 'writer'
            },
            signal,
            onStageSession
        });
        addUsage(totalUsage, response.usage);

        const cleanProse = stripBlockingTags(response.text).cleanText.trim();
        return {
            prose: cleanProse,
            writerView,
            updatedVoicePool: assembled.diagnostics.updatedVoicePool
        };
    }

    /** 执行局部 Patch（净室零工具单轮 Agent，按连续相邻索引分组，仅重写目标段落与紧邻参考） */
    private async runLocalPatch(
        bookConfig: BookSnapshot['config'],
        chapterNumber: number,
        prose: string,
        violatedIndices: number[],
        reason: string,
        totalUsage: TokenUsage,
        signal?: AbortSignal,
        onStageSession?: (event: StageSessionEvent) => void
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

        // 将连续相邻索引归并为一个分组，非相邻段落独立分组修补，严禁跨区间重写中间合规段落
        const groups: Array<{ start: number; end: number }> = [];
        for (const idx of sortedUnique) {
            const last = groups[groups.length - 1];
            if (last && idx === last.end + 1) {
                last.end = idx;
            } else {
                groups.push({ start: idx, end: idx });
            }
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
        if (!patchRoleCfg.cleanroom) {
            throw new Error(`角色 ${patchRoleCfg.id} 必须保持 cleanroom: true`);
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
                bookRoot: this.store.bookRoot,
                bookConfig,
                chapterNumber,
                request: {
                    pool: patchRoleCfg.pool,
                    traceStage: 'patch',
                    temperature: patchRoleCfg.temperature,
                    staticPrefixBlocks: [patchRoleCfg.promptText],
                    dynamicTail: [
                        `## 修补原因\n${reason}`,
                        beforeContext ? `## 前文衔接参考（只读勿输出）\n${beforeContext}` : '',
                        `## 需重写的目标段落\n${targetSegments.join('\n\n')}`,
                        afterContext ? `## 后文衔接参考（只读勿输出）\n${afterContext}` : ''
                    ]
                        .filter(Boolean)
                        .join('\n\n')
                },
                signal,
                onStageSession
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

        const taskPrompt = [
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
        const currentVolume = snapshot.worldState.frontmatter.current_volume;
        const cardRelPath = `index/L2_cards/vol_${String(currentVolume).padStart(2, '0')}_cards.md`;
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

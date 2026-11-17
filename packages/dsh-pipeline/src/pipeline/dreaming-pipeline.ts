import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    analyzeParagraphs,
    generateStructuredJson,
    generateTraced,
    stripBlockingTags,
    verifyDualQuotes,
    withTraceRun,
    type BookStore,
    type LlmPort,
    type SystemPort,
    type TxState
} from '@narrateos/dsh-book-store';
import type { DreamCommitRecord } from '@narrateos/dsh-book-tools';
import type { RoleRunner } from '../runner/role-runner.js';
import {
    ConflictClassificationOutputSchema,
    QuarantineReportSchema,
    type ConflictSeverity,
    type HealConflictItemResult,
    type HealConflictsOptions,
    type HealConflictsResult,
    type OpsSignal,
    type QuarantineReport,
    type RunDreamingOptions,
    type RunDreamingResult,
    type SuspectedConflict
} from '../schemas.js';
import {
    addUsage,
    countNonSpaceChars,
    createEmptyUsage,
    formatChapterKey,
    formatChapterTag,
    readOptionalText,
    sha256Hex
} from './helpers.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DREAM_WORD_THRESHOLD = 2000;
const DEFAULT_DREAM_BUFFER_LIMIT = 4;

export interface DreamingPipelineDeps {
    store: BookStore;
    roleRunner: RoleRunner;
    llm: LlmPort;
    system: SystemPort;
}

function isVoiceSpecimenEntry(text: string, continuationLines: string[]): boolean {
    if (text.startsWith('对话声纹')) {
        return true;
    }
    return continuationLines.some((line) => line.includes('标本：'));
}

async function appendSignalJsonl(bookRoot: string, signal: OpsSignal): Promise<string> {
    const opsDir = join(bookRoot, '.ops');
    await mkdir(opsDir, { recursive: true });
    const relPath = '.ops/signals.jsonl';
    await appendFile(join(bookRoot, relPath), `${JSON.stringify(signal)}\n`, 'utf8');
    return relPath;
}

function extractRecentL2Cards(
    rawCardContent: string | null,
    watermarkCh: number,
    currentCh: number
): string {
    if (!rawCardContent) return '(暂无 L2 章卡)';
    const sections = rawCardContent.split(/(?=^##\s+ch_\d{4}\b)/m);
    const matched: string[] = [];
    for (const sec of sections) {
        const m = /^##\s+ch_(\d{4})\b/m.exec(sec);
        if (!m?.[1]) continue;
        const ch = Number(m[1]);
        if (ch > watermarkCh && ch <= currentCh) {
            matched.push(sec.trim());
        }
    }
    return matched.length > 0 ? matched.join('\n\n') : '(水位以来暂无新增章卡)';
}

/**
 * 多轮睡眠整理 (Dreaming) 与三级跨章自愈管线：
 * - Dreaming：在安全相位且非 PARALLEL 窗口下启动多轮 Dreamer Agent（RoleRunner），
 *   仅准入水位以来出场/达缓冲上限的脏实体（未出场干净实体零读取零修改，mtime 保持不变），
 *   在 runId 隔离暂存区执行 book_edit 并由 yield_dream_commit 原子门禁提交。
 * - 三级跨章自愈：双侧原句去标点验真 -> RETCON 信号 -> 净室局部 Patch + Sync -> 自动回滚或 SAFE_HALT/QUARANTINED。
 */
export class DreamingPipeline {
    private readonly store: BookStore;
    private readonly roleRunner: RoleRunner;
    private readonly llm: LlmPort;
    private readonly system: SystemPort;

    constructor(deps: DreamingPipelineDeps) {
        this.store = deps.store;
        this.roleRunner = deps.roleRunner;
        this.llm = deps.llm;
        this.system = deps.system;
    }

    /** 启动多轮 Dreamer 睡眠整理 */
    async runDreaming(options: RunDreamingOptions): Promise<RunDreamingResult> {
        return await withTraceRun(this.store.bookRoot, 'dream', {}, async () => {
            const usage = createEmptyUsage();
            // 1. 前置门禁：拒绝未完成相位 (DRAFTING / FEAT_COMMITTED) 与 PARALLEL 窗口
            await this.store.assertDreamingPhaseSafe();
            const snapshot = await this.store.loadSnapshot();
            if (snapshot.worldState.frontmatter.timeline_mode === 'PARALLEL') {
                throw new Error('并行窗口合并前不能整理主线实体');
            }

            const wordThreshold = options.dreamWordThreshold ?? DEFAULT_DREAM_WORD_THRESHOLD;
            const bufferLimit = options.dreamBufferLimit ?? DEFAULT_DREAM_BUFFER_LIMIT;
            const watermarkObj = await this.store.readDreamWatermark();
            const watermarkCh = watermarkObj?.last_dream_ch ?? 0;
            const currentStoryDay =
                options.currentStoryDay ?? snapshot.worldState.frontmatter.story_day;

            // 计算水位以来的新增字数与脏实体候选（仅检查 last_seen_ch > watermarkCh 的活跃实体，干净实体零读取）
            let recentWordDelta = options.recentWordDelta;
            if (recentWordDelta === undefined) {
                recentWordDelta = 0;
                for (const file of snapshot.chapterFiles) {
                    const ch = Number(file.slice(3, -3));
                    if (ch > watermarkCh && ch <= options.currentChapter) {
                        recentWordDelta += countNonSpaceChars(
                            await readFile(join(this.store.bookRoot, 'manuscripts', file), 'utf8')
                        );
                    }
                }
            }

            const candidateIds =
                options.activeEntityIds ??
                Object.values(snapshot.entities)
                    .filter(
                        (profile) =>
                            profile.metadata.last_seen_ch > watermarkCh &&
                            profile.metadata.last_seen_ch <= options.currentChapter
                    )
                    .map((profile) => profile.metadata.entity_id);

            const dirtyEntityNotes: string[] = [];
            const dirtyEntityIds: string[] = [];
            for (const entityId of candidateIds) {
                const profile = snapshot.entities[entityId];
                if (!profile) continue;
                const eventBufferCount = profile.recentBuffer.filter(
                    (e) => !isVoiceSpecimenEntry(e.text, e.continuationLines)
                ).length;
                if (eventBufferCount >= bufferLimit || options.activeEntityIds?.includes(entityId)) {
                    dirtyEntityIds.push(entityId);
                    dirtyEntityNotes.push(
                        `- ${entityId} (${profile.metadata.canonical_name}): last_seen_ch=${profile.metadata.last_seen_ch}, 第4区缓冲条数=${eventBufferCount}`
                    );
                }
            }

            const wordTriggered = recentWordDelta >= wordThreshold;
            const bufferTriggered = dirtyEntityIds.length > 0;
            const hasHorizonWork =
                (options.offscreenCharacters?.length ?? 0) > 0 ||
                (options.coldArchiveCandidateIds?.length ?? 0) > 0;

            if (!options.force && !wordTriggered && !bufferTriggered && !hasHorizonWork) {
                return {
                    skipped: true,
                    committedPaths: [],
                    spotlightTriggerCount: 0,
                    committedTxState: null,
                    usage
                };
            }

            const volPad = String(snapshot.worldState.frontmatter.current_volume).padStart(2, '0');
            const l2Raw = await readOptionalText(
                join(this.store.bookRoot, `index/L2_cards/vol_${volPad}_cards.md`)
            );
            const recentL2Text = extractRecentL2Cards(l2Raw, watermarkCh, options.currentChapter);

            const taskPrompt = [
                `## 本轮睡眠整理任务 (ch_${String(options.currentChapter).padStart(4, '0')} | story_day=${currentStoryDay})`,
                `- 上次 Dreaming 水位章号: ${watermarkCh}`,
                `- 水位以来累计新增字数: ${recentWordDelta}`,
                `- 建议校验/整理的脏实体范围（其余未出场干净实体严禁读取或修改）:`,
                ...(dirtyEntityNotes.length > 0 ? dirtyEntityNotes : ['- (无达到缓冲上限的脏实体，请重点核对伏笔、未来惯性与节拍)']),
                '',
                '## 自上次水位以来的 L2 双轨章卡',
                recentL2Text,
                ...(options.offscreenCharacters?.length
                    ? [
                          '',
                          '## 离场重要角色幕后待办',
                          ...options.offscreenCharacters.map(
                              (c) =>
                                  `- ${c.entityId}: 目标="${c.pendingGoal}" | 当前进度="${c.progressNote}"`
                          )
                      ]
                    : []),
                ...(options.coldArchiveCandidateIds?.length
                    ? [
                          '',
                          `## 长期退场候选实体 (建议核查归档阈值=${options.coldArchiveInactiveChapters ?? '默认'})`,
                          options.coldArchiveCandidateIds.join(', ')
                      ]
                    : []),
                '',
                '请按规范使用 book_read / book_grep / book_glob 核实相关原稿与世界文档，通过 book_edit 在隔离暂存区联动修改脏实体与计划文件（严禁修改 manuscripts/ 或未出场干净实体），最后调用 `yield_dream_commit` 原子提交。'
            ].join('\n');

            const runRes = await this.roleRunner.runMultiTurn<DreamCommitRecord>({
                roleId: 'dreamer',
                stage: 'DREAMING',
                chapterNumber: options.currentChapter,
                bookRoot: this.store.bookRoot,
                bookConfig: snapshot.config,
                taskPrompt,
                signal: options.signal,
                onStageSession: options.onStageSession
            });

            const committedTxState = await this.store.readTxState();
            return {
                skipped: false,
                summary: runRes.yieldResult.summary,
                committedPaths: runRes.yieldResult.committedPaths,
                spotlightTriggerCount: runRes.yieldResult.spotlightTriggerCount,
                committedTxState,
                sessionId: runRes.sessionId,
                runId: runRes.runId,
                usage
            };
        });
    }

    /**
     * 跨章穿帮三级全自动梯度自愈：
     * 1. SOFT_MINOR -> 投递 RETCON 信号；
     * 2. SINGLE_POINT_HARD -> 净室局部 Patch + hash/视图同步刷新；
     * 3. CASCADING_HARD -> 对照 max_auto_rollback_chapters 自动备份回滚或熔断 QUARANTINED / SAFE_HALT。
     */
    async healCrossChapterConflicts(
        conflicts: SuspectedConflict[],
        options: HealConflictsOptions = {}
    ): Promise<HealConflictsResult> {
        return await withTraceRun(this.store.bookRoot, 'heal', {}, async () => {
            const usage = createEmptyUsage();
            const results: HealConflictItemResult[] = [];
            let quarantined = false;
            let quarantineReport: QuarantineReport | null = null;
            const config = await this.store.readBookConfig();
            const retryOptions = options.retryOptions ?? {
                maxRetries: config.structured_json_retry.max_retries,
                backoffMs: config.structured_json_retry.backoff_ms
            };

            for (const conflict of conflicts) {
                const pathA = join(
                    this.store.bookRoot,
                    'manuscripts',
                    `${formatChapterKey(conflict.chapterA)}.md`
                );
                const pathB = join(
                    this.store.bookRoot,
                    'manuscripts',
                    `${formatChapterKey(conflict.chapterB)}.md`
                );
                const textA = await readOptionalText(pathA);
                const textB = await readOptionalText(pathB);

                if (textA === null || textB === null) {
                    results.push({
                        conflictId: conflict.conflictId,
                        action: 'DISCARDED_HALLUCINATION'
                    });
                    continue;
                }

                // 第一步：双侧原句去标点存在性代码验真
                const verification = verifyDualQuotes(
                    conflict.quoteA,
                    textA,
                    conflict.quoteB,
                    textB
                );
                if (!verification.passed) {
                    results.push({
                        conflictId: conflict.conflictId,
                        action: 'DISCARDED_HALLUCINATION'
                    });
                    continue;
                }

                if (conflict.hasLegitimateTransfer) {
                    results.push({
                        conflictId: conflict.conflictId,
                        action: 'DISCARDED_LEGITIMATE_TRANSFER'
                    });
                    continue;
                }

                let severity: ConflictSeverity;
                let reason = conflict.description;
                let patchedSegment: string | undefined;

                if (conflict.severityHint && conflict.severityHint !== 'SINGLE_POINT_HARD') {
                    severity = conflict.severityHint;
                } else {
                    const classifyPrompt = [
                        `冲突 ID: ${conflict.conflictId}`,
                        `描述: ${conflict.description}`,
                        `前文 (${formatChapterKey(conflict.chapterA)} 第 ${verification.sideA.lineNumber ?? '?'} 行): ${conflict.quoteA}`,
                        `后文 (${formatChapterKey(conflict.chapterB)} 第 ${verification.sideB.lineNumber ?? '?'} 行): ${conflict.quoteB}`,
                        `后文完整上下文:\n${textB}`,
                        '',
                        '请判定冲突级别：',
                        '- SOFT_MINOR: 天气体感口误、次要环境微差，投递 RETCON 信号由下章圆回',
                        '- SINGLE_POINT_HARD: 生死/唯一物/地理硬冲突，但下游未依赖，需在 patched_segment 中提供替代后文违规句的修正文本',
                        '- CASCADING_HARD: 下游章节已建立在该错误事实之上'
                    ].join('\n');

                    const classified = await generateStructuredJson(
                        this.llm,
                        {
                            pool: 'audit',
                            traceStage: 'heal.classify',
                            staticPrefixBlocks: [
                                '你是长篇小说跨章连续性自愈裁判。仅输出合法 JSON。'
                            ],
                            dynamicTail: classifyPrompt
                        },
                        ConflictClassificationOutputSchema,
                        retryOptions,
                        options.signal
                    );
                    addUsage(usage, classified.totalUsage);

                    severity = conflict.severityHint ?? classified.data.severity;
                    reason = classified.data.reason;
                    patchedSegment = classified.data.patched_segment;
                }

                // 级别 1：软微瑕 -> 投递 RETCON 信号
                if (severity === 'SOFT_MINOR') {
                    const sigPath = await appendSignalJsonl(this.store.bookRoot, {
                        type: 'RETCON',
                        created_at: new Date().toISOString(),
                        chapter: conflict.chapterB,
                        conflict_id: conflict.conflictId,
                        chapter_a: conflict.chapterA,
                        chapter_b: conflict.chapterB,
                        reason
                    });
                    await this.system.commitPaths(
                        this.store.bookRoot,
                        [sigPath],
                        `fix(${formatChapterTag(conflict.chapterB)}): emit RETCON signal for ${conflict.conflictId}`
                    );
                    results.push({
                        conflictId: conflict.conflictId,
                        action: 'RETCON_SIGNAL',
                        sideALine: verification.sideA.lineNumber,
                        sideBLine: verification.sideB.lineNumber
                    });
                    continue;
                }

                // 级别 2：单点硬穿帮 -> 净室局部 Patch + Sync
                if (severity === 'SINGLE_POINT_HARD') {
                    let replacement = patchedSegment;
                    if (!replacement || replacement.trim().length === 0) {
                        const patchRes = await generateTraced(
                            this.llm,
                            {
                                pool: 'strong_creative',
                                traceStage: 'heal.patch',
                                temperature: 0.3,
                                staticPrefixBlocks: [
                                    '你是小说跨章单点硬穿帮局部修补专员。请仅输出替换目标违规句/段的修正正文，保持人称、语气与前后文连贯。'
                                ],
                                dynamicTail: [
                                    `## 冲突描述\n${reason}`,
                                    `## 前文锚点 (${formatChapterKey(conflict.chapterA)})\n${conflict.quoteA}`,
                                    `## 需改写的后文原句 (${formatChapterKey(conflict.chapterB)})\n${conflict.quoteB}`,
                                    `## 后文完整上下文\n${textB}`
                                ].join('\n\n')
                            },
                            options.signal
                        );
                        addUsage(usage, patchRes.usage);
                        replacement =
                            stripBlockingTags(patchRes.text).cleanText.trim() || conflict.quoteB;
                    }

                    const patchedText = this.applyLineRangePatch(
                        textB,
                        verification.sideB.startLine,
                        verification.sideB.endLine,
                        replacement
                    );
                    const relChapterPath = `manuscripts/${formatChapterKey(conflict.chapterB)}.md`;
                    await writeFile(pathB, patchedText, 'utf8');

                    if (options.onSyncAfterPatch) {
                        await options.onSyncAfterPatch(conflict.chapterB);
                    }

                    await this.refreshChapterHashAndCommit(
                        conflict.chapterB,
                        relChapterPath,
                        patchedText
                    );

                    results.push({
                        conflictId: conflict.conflictId,
                        action: 'PATCHED_IN_PLACE',
                        sideALine: verification.sideA.lineNumber,
                        sideBLine: verification.sideB.lineNumber
                    });
                    continue;
                }

                // 级别 3：连带支线硬穿帮 -> 自动备份回滚或熔断 QUARANTINED / SAFE_HALT
                const maxAutoRollback =
                    options.maxAutoRollbackChapters ?? config.max_auto_rollback_chapters;
                const txState = await this.store.readTxState();

                const affectedChapters = this.collectAffectedChapters(
                    conflict.chapterB,
                    txState.last_committed_ch,
                    conflict.downstreamDependentChapters
                );
                const rollbackChapters = affectedChapters.length;
                const rollbackWords = await this.sumChaptersWords(affectedChapters);

                let rerunDeadlocked = false;
                let backupTag: string | undefined;

                if (maxAutoRollback > 0 && rollbackChapters <= maxAutoRollback) {
                    backupTag = `backup/pre-heal-${formatChapterTag(conflict.chapterB)}-${Date.now()}`;
                    await this.system.createTag(
                        this.store.bookRoot,
                        backupTag,
                        `Backup before auto-rollback for ${conflict.conflictId}`
                    );

                    const targetChapter = Math.max(0, conflict.chapterB - 1);
                    const rollbackRef = options.resolveRollbackRef
                        ? await options.resolveRollbackRef(targetChapter)
                        : await this.findRollbackRef(targetChapter, rollbackChapters);

                    await this.system.resetHard(this.store.bookRoot, rollbackRef);

                    if (options.onAutoRerun) {
                        try {
                            const rerunOutcome = await options.onAutoRerun({
                                conflict,
                                rollbackToChapter: targetChapter,
                                backupTag,
                                constraint: reason
                            });
                            if (!rerunOutcome.success || rerunOutcome.stillConflicting) {
                                rerunDeadlocked = true;
                            }
                        } catch {
                            rerunDeadlocked = true;
                        }
                    }

                    if (!rerunDeadlocked) {
                        results.push({
                            conflictId: conflict.conflictId,
                            action: 'AUTO_ROLLED_BACK_AND_RERUN',
                            sideALine: verification.sideA.lineNumber,
                            sideBLine: verification.sideB.lineNumber,
                            backupTag
                        });
                        continue;
                    }
                }

                const report = QuarantineReportSchema.parse({
                    status: 'QUARANTINED',
                    conflict_id: conflict.conflictId,
                    side_a_chapter: conflict.chapterA,
                    side_a_line: verification.sideA.lineNumber,
                    side_b_chapter: conflict.chapterB,
                    side_b_line: verification.sideB.lineNumber,
                    rollback_chapters: rollbackChapters,
                    rollback_words: rollbackWords,
                    reason: rerunDeadlocked ? `${reason}（自动重跑 1 次仍死锁）` : reason,
                    created_at: new Date().toISOString()
                });

                await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
                await writeFile(
                    join(this.store.bookRoot, '.ops/quarantine_report.json'),
                    `${JSON.stringify(report, null, 4)}\n`,
                    'utf8'
                );
                await writeFile(
                    join(this.store.bookRoot, '.ops/safe_halt.json'),
                    `${JSON.stringify({ ...report, status: 'SAFE_HALT' }, null, 4)}\n`,
                    'utf8'
                );

                quarantined = true;
                quarantineReport = report;
                results.push({
                    conflictId: conflict.conflictId,
                    action: 'QUARANTINED',
                    sideALine: verification.sideA.lineNumber,
                    sideBLine: verification.sideB.lineNumber,
                    ...(backupTag ? { backupTag } : {}),
                    quarantineReport: report
                });
                break;
            }

            return {
                results,
                quarantined,
                quarantineReport,
                usage
            };
        });
    }

    private applyLineRangePatch(
        sourceText: string,
        startLine: number | null,
        endLine: number | null,
        replacement: string
    ): string {
        if (startLine === null || endLine === null || startLine < 1 || endLine < startLine) {
            return sourceText;
        }
        const lines = sourceText.split(/\r?\n/);
        const before = lines.slice(0, startLine - 1);
        const after = lines.slice(endLine);
        const merged = [...before, replacement, ...after].join('\n');
        return analyzeParagraphs(merged).paragraphs.length > 0 ? merged : sourceText;
    }

    private async refreshChapterHashAndCommit(
        chapterNumber: number,
        relChapterPath: string,
        updatedContent: string
    ): Promise<void> {
        const chKey = formatChapterKey(chapterNumber);
        await this.store.withTxLock(async () => {
            const currentTx = await this.store.readTxState();
            const nextTx: TxState = {
                ...currentTx,
                chapter_hashes: {
                    ...currentTx.chapter_hashes,
                    [chKey]: sha256Hex(updatedContent)
                },
                updated_at: new Date().toISOString()
            };
            await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
            await writeFile(
                join(this.store.bookRoot, '.ops/tx_state.json'),
                `${JSON.stringify(nextTx, null, 4)}\n`,
                'utf8'
            );
            await this.system.commitPaths(
                this.store.bookRoot,
                [relChapterPath, '.ops/tx_state.json'],
                `fix(${formatChapterTag(chapterNumber)}): patch single-point conflict & refresh view`
            );
        });
    }

    private collectAffectedChapters(
        conflictChapterB: number,
        lastCommittedCh: number,
        downstreamDependentChapters?: number[]
    ): number[] {
        if (downstreamDependentChapters && downstreamDependentChapters.length > 0) {
            const set = new Set<number>();
            for (const ch of downstreamDependentChapters) {
                if (ch >= conflictChapterB) {
                    set.add(ch);
                }
            }
            if (!set.has(conflictChapterB)) {
                set.add(conflictChapterB);
            }
            return Array.from(set).sort((a, b) => a - b);
        }

        const end = Math.max(conflictChapterB, lastCommittedCh);
        const list: number[] = [];
        for (let ch = conflictChapterB; ch <= end; ch += 1) {
            list.push(ch);
        }
        return list;
    }

    private async sumChaptersWords(chapters: number[]): Promise<number> {
        let total = 0;
        for (const ch of chapters) {
            const content = await readOptionalText(
                join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(ch)}.md`)
            );
            if (content !== null) {
                total += countNonSpaceChars(content);
            }
        }
        return total;
    }

    private async findRollbackRef(
        targetChapter: number,
        rollbackChapters: number
    ): Promise<string> {
        if (targetChapter > 0) {
            const tagPattern = formatChapterTag(targetChapter);
            try {
                const { stdout } = await execFileAsync(
                    'git',
                    ['-C', this.store.bookRoot, 'log', '-n', '1', '--format=%H', `--grep=${tagPattern}`],
                    { encoding: 'utf8' }
                );
                const sha = stdout.trim();
                if (sha.length > 0) {
                    return sha;
                }
            } catch {
                // 回退使用相对步数
            }
        }

        try {
            const { stdout } = await execFileAsync(
                'git',
                ['-C', this.store.bookRoot, 'rev-list', '--count', 'HEAD'],
                { encoding: 'utf8' }
            );
            const totalCommits = Number(stdout.trim());
            const steps = Math.min(Math.max(1, rollbackChapters), Math.max(0, totalCommits - 1));
            return steps > 0 ? `HEAD~${steps}` : 'HEAD';
        } catch {
            return 'HEAD';
        }
    }
}

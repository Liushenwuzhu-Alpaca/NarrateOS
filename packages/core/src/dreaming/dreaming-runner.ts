import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { verifyDualQuotes } from '../gate/quote-verifier.js';
import { generateStructuredJson, type LlmPort, type TokenUsage } from '../ports/llm.js';
import type { SystemPort } from '../ports/system.js';
import { BookStore, parseEntityMarkdown, serializeEntityMarkdown } from '../store/index.js';
import type { EntityEntry, EntityProfile, TxState } from '../store/schemas.js';
import {
    ConflictClassificationOutputSchema,
    DreamVacuumOutputSchema,
    HorizonEvalOutputSchema,
    QuarantineReportSchema,
    type ConflictSeverity,
    type HealConflictItemResult,
    type HealConflictsOptions,
    type HealConflictsResult,
    type HorizonEvalOutput,
    type OpsSignal,
    type QuarantineReport,
    type RunDreamingOptions,
    type RunDreamingResult,
    type SuspectedConflict
} from './schemas.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DREAM_WORD_THRESHOLD = 2000;
const DEFAULT_DREAM_BUFFER_LIMIT = 4;
const DEFAULT_WARPED_EXPIRE_DAYS = 3;
const MAX_ACTIVE_OPEN_THREADS = 15;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesThreadId(line: string, threadId: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) {
        return false;
    }
    const escaped = escapeRegExp(threadId);
    const pattern = new RegExp(`(?:\\[|\\s|:)${escaped}(?:\\]|\\s|:|$)`);
    return pattern.test(trimmed);
}

function emptyUsage(): TokenUsage {
    return {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0
    };
}

function addUsage(acc: TokenUsage, delta: TokenUsage): void {
    acc.inputTokens += delta.inputTokens;
    acc.cacheReadTokens += delta.cacheReadTokens;
    acc.cacheWriteTokens += delta.cacheWriteTokens;
    acc.outputTokens += delta.outputTokens;
}

function padChapter(chapterNumber: number): string {
    return String(chapterNumber).padStart(4, '0');
}

function formatChapterKey(chapterNumber: number): string {
    return `ch_${padChapter(chapterNumber)}`;
}

function formatChapterTag(chapterNumber: number): string {
    return `ch-${padChapter(chapterNumber)}`;
}

function sha256Hex(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function countNonSpaceChars(text: string): number {
    return text.replace(/\s+/g, '').length;
}

function isVoiceSpecimenEntry(entry: EntityEntry): boolean {
    if (entry.text.startsWith('对话声纹')) {
        return true;
    }
    return entry.continuationLines.some((line) => line.includes('标本：'));
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

async function appendSignalJsonl(bookRoot: string, signal: OpsSignal): Promise<string> {
    const opsDir = join(bookRoot, '.ops');
    await mkdir(opsDir, { recursive: true });
    const relPath = '.ops/signals.jsonl';
    await appendFile(join(bookRoot, relPath), `${JSON.stringify(signal)}\n`, 'utf8');
    return relPath;
}

/** 睡眠整理与三级跨章自愈执行器 */
export class DreamingRunner {
    constructor(
        private readonly store: BookStore,
        private readonly llm: LlmPort,
        private readonly system: SystemPort
    ) {}

    /**
     * 执行按脏页增量 VACUUM、future_horizon 翻转与冷归档，并检查前台镜头原则 Spotlight Trigger
     */
    async runDreaming(options: RunDreamingOptions): Promise<RunDreamingResult> {
        const usage = emptyUsage();
        const wordThreshold = options.dreamWordThreshold ?? DEFAULT_DREAM_WORD_THRESHOLD;
        const bufferLimit = options.dreamBufferLimit ?? DEFAULT_DREAM_BUFFER_LIMIT;
        const warpedExpireDays = options.warpedExpireDays ?? DEFAULT_WARPED_EXPIRE_DAYS;
        const currentStoryDay = options.currentStoryDay ?? options.currentChapter;

        const candidateIds = options.activeEntityIds ?? [];
        const loadedActives = new Map<string, EntityProfile>();
        const dirtyProfiles: EntityProfile[] = [];

        // 仅读取近期出场实体，未出场干净实体零读取、零修改（保持 mtime 完全不变）
        for (const entityId of candidateIds) {
            const raw = await readOptionalText(join(this.store.bookRoot, 'entities', `${entityId}.md`));
            if (raw === null) continue;
            const profile = parseEntityMarkdown(raw);
            loadedActives.set(entityId, profile);
            const eventBufferCount = profile.recentBuffer.filter((e) => !isVoiceSpecimenEntry(e)).length;
            if (eventBufferCount >= bufferLimit) {
                dirtyProfiles.push(profile);
            }
        }

        const wordTriggered = (options.recentWordDelta ?? 0) >= wordThreshold;
        const bufferTriggered = dirtyProfiles.length > 0;
        const hasHorizonWork =
            (options.offscreenCharacters?.length ?? 0) > 0 ||
            (options.coldArchiveCandidateIds?.length ?? 0) > 0;

        if (!options.force && !wordTriggered && !bufferTriggered && !hasHorizonWork) {
            return {
                skipped: true,
                vacuumedEntities: [],
                warpedNodesFlipped: 0,
                archivedFiles: [],
                spotlightTriggers: [],
                resolvedThreads: [],
                addedThreads: [],
                rejectedThreadsCount: 0,
                replenishedHorizonEventsCount: 0,
                committedTxState: null,
                usage
            };
        }

        const committedPaths = new Set<string>();
        const vacuumedEntities: string[] = [];

        // 1. 按脏页局部清洗：仅压缩第 4 区达到水位的脏实体
        for (const profile of dirtyProfiles) {
            const voiceEntries = profile.recentBuffer.filter((e) => isVoiceSpecimenEntry(e));
            const bufferEvents = profile.recentBuffer.filter((e) => !isVoiceSpecimenEntry(e));

            const vacuumPrompt = [
                `实体: ${profile.metadata.entity_id} (${profile.metadata.canonical_name})`,
                '## 现有第 3 区 Irreversible Trajectory',
                ...profile.irreversibleTrajectory.map(
                    (e) => `- [day:${e.storyDay ?? '?'} | ch:${e.chapter ?? '?'}] ${e.text}`
                ),
                '',
                '## 待提炼第 4 区 Recent Buffer',
                ...bufferEvents.map(
                    (e) => `- [day:${e.storyDay ?? '?'} | ch:${e.chapter ?? '?'}] ${e.text}`
                ),
                '',
                '请将第 4 区的关键转折提炼为简洁的第 3 区条目，必须保留原章锚点（如 ch_0002），输出 JSON。'
            ].join('\n');

            const res = await generateStructuredJson(
                this.llm,
                {
                    pool: 'fast_retrieval',
                    staticPrefixBlocks: [
                        '你是长篇小说记忆整理器（Dreaming Vacuum）。仅输出合法 JSON，保留原章锚点与事实边界。'
                    ],
                    dynamicTail: vacuumPrompt
                },
                DreamVacuumOutputSchema,
                options.retryOptions,
                options.signal
            );
            addUsage(usage, res.totalUsage);

            const newTrajectory: EntityEntry[] = res.data.trajectory_entries.map((item) => {
                const textWithAnchor = item.summary.includes(item.anchor)
                    ? item.summary
                    : `${item.summary} [锚点 ${item.anchor}]`;
                const entry: EntityEntry = {
                    chapter: item.chapter,
                    text: textWithAnchor,
                    continuationLines: []
                };
                if (item.story_day !== undefined) {
                    entry.storyDay = item.story_day;
                }
                return entry;
            });

            const keepTexts = new Set(res.data.keep_buffer_texts);
            const keptEvents = bufferEvents.filter((e) => keepTexts.has(e.text));

            const updatedProfile: EntityProfile = {
                ...profile,
                irreversibleTrajectory: [...profile.irreversibleTrajectory, ...newTrajectory],
                recentBuffer: [...keptEvents, ...voiceEntries]
            };

            const relPath = `entities/${profile.metadata.entity_id}.md`;
            await writeFile(join(this.store.bookRoot, relPath), serializeEntityMarkdown(updatedProfile), 'utf8');
            committedPaths.add(relPath);
            vacuumedEntities.push(profile.metadata.entity_id);
        }

        // 2. 核对 future_horizon.md、open_threads.md 与离场角色前台镜头原则
        const horizonRelPath = 'world/future_horizon.md';
        const openThreadsRelPath = 'world/open_threads.md';
        const horizonRaw = await readOptionalText(join(this.store.bookRoot, horizonRelPath));
        const openThreadsRaw = await readOptionalText(join(this.store.bookRoot, openThreadsRelPath));
        let warpedNodesFlipped = 0;
        const archivedFiles: string[] = [];
        const spotlightTriggers: OpsSignal[] = [];
        let resolvedThreads: string[] = [];
        let addedThreads: string[] = [];
        let rejectedThreadsCount = 0;
        let replenishedHorizonEventsCount = 0;

        if (horizonRaw !== null || openThreadsRaw !== null || (options.offscreenCharacters?.length ?? 0) > 0) {
            const horizonEvalPrompt = [
                `当前章节: ch_${padChapter(options.currentChapter)} (story_day: ${currentStoryDay})`,
                '',
                '## world/future_horizon.md',
                horizonRaw ?? '(无)',
                '',
                '## world/open_threads.md',
                openThreadsRaw ?? '(无)',
                '',
                '## 离场重要角色待办与进度',
                ...(options.offscreenCharacters?.map(
                    (c) => `- ${c.entityId}: 目标="${c.pendingGoal}" | 当前进度="${c.progressNote}"`
                ) ?? ['(无)']),
                '',
                '请输出：',
                '1. warped_markers: 已破灭需要翻转为 WARPED 的节点 id 或关键词列表；',
                '2. spotlight_triggers: 蓄力抵达引爆重大冲突临界点的离场角色，严禁后台偷偷结算，必须抛出切镜信号；',
                '3. resolved_thread_ids: 本周期已彻底兑现、可销账归档的伏笔 thread_id 列表；',
                '4. new_threads: 本周期新埋设的跨章悬念（最多 2 条，含 thread_id / title / wakeup_condition）；',
                '5. replenished_horizon_events: 根据离场角色待办目标滚动补货的未来惯性事件（含 event_id / description / premise 及可选 after_ch / story_day）。'
            ].join('\n');

            const evalRes = await generateStructuredJson(
                this.llm,
                {
                    pool: 'audit',
                    staticPrefixBlocks: [
                        '你是长篇小说远景推演、伏笔盘点与前台镜头裁判（On-Screen Principle）。重要冲突必须抛出 Spotlight Trigger 信号，仅输出合法 JSON。'
                    ],
                    dynamicTail: horizonEvalPrompt
                },
                HorizonEvalOutputSchema,
                options.retryOptions,
                options.signal
            );
            addUsage(usage, evalRes.totalUsage);

            const replenishedEvents = evalRes.data.replenished_horizon_events ?? [];
            let nextHorizonMarkdown = horizonRaw;
            let horizonChanged = false;

            if (horizonRaw !== null) {
                const horizonUpdate = this.applyHorizonWarpAndArchive(
                    horizonRaw,
                    evalRes.data.warped_markers ?? [],
                    currentStoryDay,
                    warpedExpireDays
                );
                warpedNodesFlipped = horizonUpdate.flippedCount;
                nextHorizonMarkdown = horizonUpdate.updatedMarkdown;

                if (horizonUpdate.flippedCount > 0 || horizonUpdate.expiredWarpedLines.length > 0) {
                    horizonChanged = true;
                }

                if (horizonUpdate.expiredWarpedLines.length > 0) {
                    const coldArchiveDir = join(this.store.bookRoot, 'entities/cold_archive');
                    await mkdir(coldArchiveDir, { recursive: true });
                    const warpedArchiveRel = 'entities/cold_archive/warped_horizon.md';
                    const warpedArchiveAbs = join(this.store.bookRoot, warpedArchiveRel);
                    const existingArchive = (await readOptionalText(warpedArchiveAbs)) ?? '# Archived WARPED Horizon Nodes\n\n';
                    const mergedArchive = `${existingArchive.trimEnd()}\n${horizonUpdate.expiredWarpedLines.join('\n')}\n`;
                    await writeFile(warpedArchiveAbs, mergedArchive, 'utf8');
                    committedPaths.add(warpedArchiveRel);
                    archivedFiles.push(warpedArchiveRel);
                }
            }

            if (replenishedEvents.length > 0) {
                const appended = this.appendReplenishedHorizonEvents(nextHorizonMarkdown, replenishedEvents);
                if (appended.addedCount > 0) {
                    nextHorizonMarkdown = appended.updatedMarkdown;
                    replenishedHorizonEventsCount = appended.addedCount;
                    horizonChanged = true;
                }
            }

            if (horizonChanged && nextHorizonMarkdown !== null) {
                await writeFile(join(this.store.bookRoot, horizonRelPath), nextHorizonMarkdown, 'utf8');
                committedPaths.add(horizonRelPath);
            }

            // 周期盘点 world/open_threads.md（已兑现归档 + 新增硬锁 <= 15）
            const resolvedIds = evalRes.data.resolved_thread_ids ?? [];
            const newThreads = evalRes.data.new_threads ?? [];
            if (resolvedIds.length > 0 || newThreads.length > 0) {
                const threadUpdate = this.updateOpenThreadsMarkdown(openThreadsRaw, resolvedIds, newThreads);
                resolvedThreads = threadUpdate.resolvedThreads;
                addedThreads = threadUpdate.addedThreads;
                rejectedThreadsCount = threadUpdate.rejectedThreadsCount;

                if (threadUpdate.changed) {
                    await mkdir(join(this.store.bookRoot, 'world'), { recursive: true });
                    await writeFile(join(this.store.bookRoot, openThreadsRelPath), threadUpdate.updatedMarkdown, 'utf8');
                    committedPaths.add(openThreadsRelPath);
                }
            }

            // 抛出 Spotlight Trigger 信号到 .ops/signals.jsonl
            for (const trigger of evalRes.data.spotlight_triggers ?? []) {
                const signalObj: OpsSignal = {
                    type: 'SPOTLIGHT_TRIGGER',
                    created_at: new Date().toISOString(),
                    chapter: options.currentChapter,
                    entity_id: trigger.entity_id,
                    suggested_mode: trigger.suggested_mode,
                    reason: trigger.reason
                };
                const sigPath = await appendSignalJsonl(this.store.bookRoot, signalObj);
                committedPaths.add(sigPath);
                spotlightTriggers.push(signalObj);
            }
        }

        // 3. 长期退场角色移入 entities/cold_archive/
        const archiveThreshold = options.coldArchiveInactiveChapters;
        const archiveCandidates = options.coldArchiveCandidateIds ?? [];
        if (archiveThreshold !== undefined && archiveCandidates.length > 0) {
            const coldArchiveDir = join(this.store.bookRoot, 'entities/cold_archive');
            await mkdir(coldArchiveDir, { recursive: true });

            for (const entityId of archiveCandidates) {
                const srcRel = `entities/${entityId}.md`;
                const srcAbs = join(this.store.bookRoot, srcRel);
                const raw = await readOptionalText(srcAbs);
                if (raw === null) continue;
                const parsed = parseEntityMarkdown(raw);
                if (options.currentChapter - parsed.metadata.last_seen_ch >= archiveThreshold) {
                    const dstRel = `entities/cold_archive/${entityId}.md`;
                    const dstAbs = join(this.store.bookRoot, dstRel);
                    await rename(srcAbs, dstAbs);
                    committedPaths.add(srcRel);
                    committedPaths.add(dstRel);
                    archivedFiles.push(dstRel);
                }
            }
        }

        const committedTxState = await this.store.markDreamCommitted(
            options.currentChapter,
            Array.from(committedPaths)
        );

        return {
            skipped: false,
            vacuumedEntities,
            warpedNodesFlipped,
            archivedFiles,
            spotlightTriggers,
            resolvedThreads,
            addedThreads,
            rejectedThreadsCount,
            replenishedHorizonEventsCount,
            committedTxState,
            usage
        };
    }

    /**
     * 跨章穿帮三级全自动梯度自愈
     */
    async healCrossChapterConflicts(
        conflicts: SuspectedConflict[],
        options: HealConflictsOptions = {}
    ): Promise<HealConflictsResult> {
        const usage = emptyUsage();
        const results: HealConflictItemResult[] = [];
        let quarantined = false;
        let quarantineReport: QuarantineReport | null = null;

        for (const conflict of conflicts) {
            const pathA = join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(conflict.chapterA)}.md`);
            const pathB = join(this.store.bookRoot, 'manuscripts', `${formatChapterKey(conflict.chapterB)}.md`);
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
            const verification = verifyDualQuotes(conflict.quoteA, textA, conflict.quoteB, textB);
            if (!verification.passed) {
                results.push({
                    conflictId: conflict.conflictId,
                    action: 'DISCARDED_HALLUCINATION'
                });
                continue;
            }

            // 中间章节已存在合法转移记录的误报直接静默丢弃
            if (conflict.hasLegitimateTransfer) {
                results.push({
                    conflictId: conflict.conflictId,
                    action: 'DISCARDED_LEGITIMATE_TRANSFER'
                });
                continue;
            }

            // 第二步：确定冲突严重度与修正方案
            let severity: ConflictSeverity;
            let reason = conflict.description;
            let patchedSegment: string | undefined;

            if (conflict.severityHint && conflict.severityHint !== 'SINGLE_POINT_HARD') {
                severity = conflict.severityHint;
            } else {
                const classifyPrompt = [
                    `冲突 ID: ${conflict.conflictId}`,
                    `描述: ${conflict.description}`,
                    `前文 (ch_${padChapter(conflict.chapterA)} 第 ${verification.sideA.lineNumber ?? '?'} 行): ${conflict.quoteA}`,
                    `后文 (ch_${padChapter(conflict.chapterB)} 第 ${verification.sideB.lineNumber ?? '?'} 行): ${conflict.quoteB}`,
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
                        staticPrefixBlocks: [
                            '你是长篇小说跨章连续性自愈裁判。仅输出合法 JSON。'
                        ],
                        dynamicTail: classifyPrompt
                    },
                    ConflictClassificationOutputSchema,
                    options.retryOptions,
                    options.signal
                );
                addUsage(usage, classified.totalUsage);

                severity = conflict.severityHint ?? classified.data.severity;
                reason = classified.data.reason;
                patchedSegment = classified.data.patched_segment;
            }

            // 级别 1：软微瑕 -> 投递 RETCON 信号，0 停机
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

            // 级别 2：单点硬穿帮 -> 局部 Patch 并刷新视图
            if (severity === 'SINGLE_POINT_HARD') {
                const replacement = patchedSegment ?? conflict.quoteB;
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

                await this.refreshChapterHashAndCommit(conflict.chapterB, relChapterPath, patchedText);

                results.push({
                    conflictId: conflict.conflictId,
                    action: 'PATCHED_IN_PLACE',
                    sideALine: verification.sideA.lineNumber,
                    sideBLine: verification.sideB.lineNumber
                });
                continue;
            }

            // 级别 3：连带支线硬穿帮 -> 对照 max_auto_rollback_chapters 决定自动回滚重跑或熔断
            const bookConfig = await this.store.readBookConfig();
            const maxAutoRollback = options.maxAutoRollbackChapters ?? bookConfig.max_auto_rollback_chapters;
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

            // 超阈值、max_auto_rollback_chapters === 0 或重跑 1 次仍死锁 -> 进入 QUARANTINED / SAFE_HALT 熔断
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
    }

    private applyHorizonWarpAndArchive(
        horizonRaw: string,
        warpedMarkers: string[],
        currentStoryDay: number,
        warpedExpireDays: number
    ): {
        updatedMarkdown: string;
        flippedCount: number;
        expiredWarpedLines: string[];
    } {
        const lines = horizonRaw.split(/\r?\n/);
        const keptLines: string[] = [];
        const expiredWarpedLines: string[] = [];
        let flippedCount = 0;

        for (const line of lines) {
            let processed = line;
            const trimmed = line.trim();

            if (trimmed.startsWith('- ')) {
                const shouldFlip = warpedMarkers.some((marker) => marker.length > 0 && trimmed.includes(marker));
                if (shouldFlip && !trimmed.includes('status: WARPED')) {
                    if (/status:\s*ACTIVE/i.test(processed)) {
                        processed = processed.replace(/status:\s*ACTIVE/gi, 'status: WARPED');
                    } else if (processed.includes(']')) {
                        processed = processed.replace(']', ' | status: WARPED]');
                    } else {
                        processed = `${processed} [status: WARPED]`;
                    }
                    flippedCount += 1;
                }

                const isWarped = /status:\s*WARPED/i.test(processed);
                if (isWarped) {
                    const dayMatch = /\bday:\s*(-?\d+)/i.exec(processed);
                    const nodeDay = dayMatch?.[1] !== undefined ? Number(dayMatch[1]) : null;
                    if (nodeDay !== null && currentStoryDay - nodeDay >= warpedExpireDays) {
                        expiredWarpedLines.push(processed);
                        continue;
                    }
                }
            }

            keptLines.push(processed);
        }

        return {
            updatedMarkdown: keptLines.join('\n'),
            flippedCount,
            expiredWarpedLines
        };
    }

    private appendReplenishedHorizonEvents(
        horizonMarkdown: string | null,
        events: HorizonEvalOutput['replenished_horizon_events']
    ): {
        updatedMarkdown: string;
        addedCount: number;
    } {
        const base =
            horizonMarkdown !== null && horizonMarkdown.trim().length > 0
                ? horizonMarkdown.trimEnd()
                : '# 世界默认惯性表 (Future Horizon)';
        const newLines: string[] = [];
        let addedCount = 0;

        for (const evt of events) {
            // 去重：若已存在同 event_id 则跳过
            const escapedId = escapeRegExp(evt.event_id);
            if (new RegExp(`(?:event:|id:\\s*)${escapedId}(?:\\s|\\]|$)`).test(base)) {
                continue;
            }
            const metaParts = [`event:${evt.event_id}`];
            if (evt.story_day !== undefined) {
                metaParts.push(`day:${evt.story_day}`);
            }
            if (evt.after_ch !== undefined) {
                metaParts.push(`after_ch:${evt.after_ch}`);
            }
            metaParts.push('status:ACTIVE');

            newLines.push(`- [${metaParts.join(' | ')}] ${evt.description}`);
            newLines.push(`  - Premise: ${evt.premise}`);
            addedCount += 1;
        }

        if (addedCount === 0) {
            return { updatedMarkdown: horizonMarkdown ?? `${base}\n`, addedCount: 0 };
        }

        return {
            updatedMarkdown: `${base}\n${newLines.join('\n')}\n`,
            addedCount
        };
    }

    private updateOpenThreadsMarkdown(
        openThreadsRaw: string | null,
        resolvedThreadIds: string[],
        newThreads: HorizonEvalOutput['new_threads']
    ): {
        updatedMarkdown: string;
        resolvedThreads: string[];
        addedThreads: string[];
        rejectedThreadsCount: number;
        changed: boolean;
    } {
        const sourceLines = (openThreadsRaw ?? '').split(/\r?\n/);
        let docTitle = '# 跨卷伏笔台账 (Open Threads)';
        const activeLines: string[] = [];
        const archiveLines: string[] = [];
        let currentSection: 'header' | 'active' | 'archive' = 'header';

        for (const line of sourceLines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('# ') && currentSection === 'header') {
                docTitle = trimmed;
                continue;
            }
            if (/^##\s+.*(已回收伏笔归档|Resolved Archive)/i.test(trimmed)) {
                currentSection = 'archive';
                continue;
            }
            if (/^##\s+.*(活跃未解伏笔|Active Threads)/i.test(trimmed)) {
                currentSection = 'active';
                continue;
            }
            if (trimmed.startsWith('- ')) {
                if (currentSection === 'archive') {
                    archiveLines.push(trimmed);
                } else {
                    // 无显式二级标题的初始列表条目默认视为活跃伏笔
                    activeLines.push(trimmed);
                }
            }
        }

        // 1. 将本周期已兑现伏笔从 Active 移入 Resolved Archive
        const resolvedSet = new Set(resolvedThreadIds);
        const remainingActive: string[] = [];
        const resolvedThreads: string[] = [];
        let changed = false;

        for (const line of activeLines) {
            const matchedId = Array.from(resolvedSet).find((id) => matchesThreadId(line, id));
            if (matchedId !== undefined) {
                const archivedLine = /status:\s*RESOLVED/i.test(line)
                    ? line
                    : `${line} [status: RESOLVED]`;
                archiveLines.push(archivedLine);
                if (!resolvedThreads.includes(matchedId)) {
                    resolvedThreads.push(matchedId);
                }
                changed = true;
            } else {
                remainingActive.push(line);
            }
        }

        // 2. 追加新立项伏笔，严格执行 ACTIVE <= 15 硬锁
        const addedThreads: string[] = [];
        let rejectedThreadsCount = 0;

        for (const item of newThreads) {
            const alreadyActive = remainingActive.some((line) => matchesThreadId(line, item.thread_id));
            const alreadyArchived = archiveLines.some((line) => matchesThreadId(line, item.thread_id));
            if (alreadyActive || alreadyArchived) {
                continue;
            }

            if (remainingActive.length >= MAX_ACTIVE_OPEN_THREADS) {
                rejectedThreadsCount += 1;
                continue;
            }

            remainingActive.push(
                `- [${item.thread_id}] ${item.title} | 唤醒条件: ${item.wakeup_condition}`
            );
            addedThreads.push(item.thread_id);
            changed = true;
        }

        if (!changed) {
            return {
                updatedMarkdown: openThreadsRaw ?? `${docTitle}\n`,
                resolvedThreads,
                addedThreads,
                rejectedThreadsCount,
                changed: false
            };
        }

        const outLines: string[] = [
            docTitle,
            '',
            '## 活跃未解伏笔 (Active Threads)',
            ...remainingActive,
            '',
            '## 已回收伏笔归档 (Resolved Archive)',
            ...archiveLines,
            ''
        ];

        return {
            updatedMarkdown: outLines.join('\n'),
            resolvedThreads,
            addedThreads,
            rejectedThreadsCount,
            changed: true
        };
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
        return [...before, replacement, ...after].join('\n');
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

    private async findRollbackRef(targetChapter: number, rollbackChapters: number): Promise<string> {
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

        // 每个章节在双粒度 WAL 下通常对应 2 次提交 (feat + state)，但至少回退 rollbackChapters 步
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

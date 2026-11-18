import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
    analyzeParagraphs,
    generateStructuredJson,
    normalizeForQuoteMatch,
    parseL2CardSections,
    renderEntityProfile,
    StaticProseGate,
    stripWriterRestrictedDirectives,
    TxStateSchema,
    verifyDualQuotes,
    ViewSlicer,
    withTraceRun,
    type BookConfig,
    type BookStore,
    type EntityProfile,
    type LlmPort,
    type ProseGateOptions,
    type SystemPort,
    type TxState
} from '@narrateos/dsh-book-store';
import type { DreamCommitRecord, YieldPatchedDraftResult } from '@narrateos/dsh-book-tools';
import { ValidationError } from '../errors.js';
import type { RoleRunner } from '../runner/role-runner.js';
import {
    ConflictClassificationOutputSchema,
    QuarantineReportSchema,
    type ConflictSeverity,
    type HealConflictItemResult,
    type HealConflictsOptions,
    type HealConflictsResult,
    type OffscreenCharacterProgress,
    type OpsSignal,
    type QuarantineReport,
    type RunDreamingOptions,
    type RunDreamingResult,
    type SuspectedConflict
} from '../schemas.js';
import {
    CLEANROOM_PATCH_FALLBACK_REASON,
    sanitizeTextForCleanroomWriter
} from './chapter-pipeline.js';
import {
    addUsage,
    appendJsonlLineSafe,
    clearHealPlan,
    countNonSpaceChars,
    createEmptyUsage,
    formatChapterKey,
    formatChapterTag,
    readOptionalText,
    readSignalsCursorState,
    resolveSignalId,
    sha256Hex,
    upsertVolumeCardEntry,
    writeHealPlan,
    writeSignalsCursorState
} from './helpers.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DREAM_WORD_THRESHOLD = 15000;
const DEFAULT_DREAM_BUFFER_LIMIT = 6;
const DEFAULT_WARPED_ARCHIVE_AFTER_DAYS = 3;
const DEFAULT_PROMOTE_ANCHOR_MIN_CHAPTERS = 3;
const DEFAULT_HEAL_GIT_LOG_MAX_COUNT = 2000;

function isAbortError(err: unknown): boolean {
    if (err instanceof Error && err.name === 'AbortError') {
        return true;
    }
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { name?: unknown }).name === 'AbortError'
    );
}

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
    const relPath = '.ops/signals.jsonl';
    await appendJsonlLineSafe(join(bookRoot, relPath), JSON.stringify(signal));
    return relPath;
}

/** 扫描未来线与实体卡中超过阈值的过期 WARPED 条目（排除已折叠进 Archived WARPED 的历史条目） */
function scanExpiredWarpedEntries(
    futureHorizonRaw: string | null | undefined,
    entities: Readonly<Record<string, EntityProfile>>,
    currentStoryDay: number,
    warpedArchiveAfterDays: number
): string[] {
    const notes: string[] = [];
    if (futureHorizonRaw) {
        const lines = futureHorizonRaw.replace(/\r\n/g, '\n').split('\n');
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (/^##\s+Archived\s+WARPED\b/i.test(line)) {
                break;
            }
            if (!/\bWARPED\b/i.test(line)) continue;
            const dayMatch = /(?:\bday|故事日)\s*[:：]\s*(-?\d+)/i.exec(line);
            if (!dayMatch?.[1]) continue;
            const entryDay = Number(dayMatch[1]);
            if (Number.isFinite(entryDay) && currentStoryDay - entryDay > warpedArchiveAfterDays) {
                notes.push(`- [future_horizon] ${line}`);
            }
        }
    }

    for (const profile of Object.values(entities)) {
        const entityId = profile.metadata.entity_id;
        for (const entry of [...profile.acquiredState, ...profile.recentBuffer]) {
            const isWarped =
                entry.status === 'WARPED' ||
                /\bWARPED\b/i.test(entry.text) ||
                entry.continuationLines.some((l) => /\bWARPED\b/i.test(l));
            if (!isWarped) continue;
            if (
                entry.storyDay !== undefined &&
                entry.storyDay > 0 &&
                currentStoryDay - entry.storyDay > warpedArchiveAfterDays
            ) {
                notes.push(`- [实体 ${entityId}] day:${entry.storyDay} ${entry.text}`);
            }
        }
    }
    return notes;
}

/** 扫描尚未出场或退场但仍在伏笔/未来线活跃的角色 */
function scanOffscreenEntityNotes(
    explicit: OffscreenCharacterProgress[] | undefined,
    entities: Readonly<Record<string, EntityProfile>>,
    watermarkCh: number,
    currentChapter: number,
    openThreadsRaw: string | null | undefined,
    futureHorizonRaw: string | null | undefined
): OffscreenCharacterProgress[] {
    const merged: OffscreenCharacterProgress[] = [...(explicit ?? [])];
    const seen = new Set(merged.map((item) => item.entityId));
    const horizonBody = (futureHorizonRaw ?? '').split(/^##\s+Archived\s+WARPED\b/im)[0] ?? '';
    const activePlanningText = `${openThreadsRaw ?? ''}\n${horizonBody}`;
    if (!activePlanningText.trim()) {
        return merged;
    }

    for (const profile of Object.values(entities)) {
        const entityId = profile.metadata.entity_id;
        if (seen.has(entityId)) continue;
        if (
            profile.metadata.last_seen_ch <= 0 ||
            profile.metadata.last_seen_ch > watermarkCh ||
            profile.metadata.last_seen_ch >= currentChapter
        ) {
            continue;
        }
        const identityKeys = [
            entityId,
            profile.metadata.canonical_name,
            ...profile.metadata.unique_aliases
        ]
            .map((k) => k.trim())
            .filter((k) => k.length >= 2);
        if (identityKeys.some((key) => activePlanningText.includes(key))) {
            seen.add(entityId);
            merged.push({
                entityId,
                pendingGoal: '伏笔/未来线存在关联未结动态',
                progressNote: `距上次出场 (ch_${String(profile.metadata.last_seen_ch).padStart(4, '0')}) 已间隔 ${currentChapter - profile.metadata.last_seen_ch} 章`
            });
        }
    }
    return merged;
}

/** 扫描 L2 双轨章卡中跨多章复现但尚未建卡/补别名的异象锚点 */
async function scanRecurringProseAnchors(
    bookRoot: string,
    currentVolume: number,
    entities: Readonly<Record<string, EntityProfile>>,
    promoteAnchorMinChapters: number
): Promise<string[]> {
    const knownKeys = new Set<string>();
    for (const profile of Object.values(entities)) {
        for (const rawKey of [
            profile.metadata.entity_id,
            profile.metadata.canonical_name,
            ...profile.metadata.unique_aliases
        ]) {
            const norm = normalizeForQuoteMatch(rawKey);
            if (norm.length >= 2) {
                knownKeys.add(norm);
            }
        }
    }

    const l2Dir = join(bookRoot, 'index/L2_cards');
    let cardFiles: string[] = [];
    try {
        cardFiles = (await readdir(l2Dir)).filter((f) => /^vol_\d+_cards\.md$/.test(f)).sort();
    } catch {
        cardFiles = [`vol_${String(currentVolume).padStart(2, '0')}_cards.md`];
    }

    const anchorCounts = new Map<string, { display: string; chapters: Set<number> }>();
    for (const file of cardFiles) {
        const raw = await readOptionalText(join(l2Dir, file));
        if (!raw) continue;
        const parsed = parseL2CardSections(raw);
        for (const section of parsed.sections) {
            for (const anchor of section.anomalyAnchors) {
                const trimmed = anchor.trim();
                if (!trimmed || trimmed === '无') continue;
                const norm = normalizeForQuoteMatch(trimmed);
                if (norm.length < 2 || knownKeys.has(norm)) continue;
                const existing = anchorCounts.get(norm);
                if (existing) {
                    existing.chapters.add(section.chapterNumber);
                } else {
                    anchorCounts.set(norm, {
                        display: trimmed,
                        chapters: new Set([section.chapterNumber])
                    });
                }
            }
        }
    }

    const candidates: string[] = [];
    for (const item of anchorCounts.values()) {
        if (item.chapters.size >= promoteAnchorMinChapters) {
            const chList = Array.from(item.chapters)
                .sort((a, b) => a - b)
                .map((ch) => formatChapterKey(ch))
                .join(', ');
            candidates.push(
                `- "${item.display}" (已在 ${chList} 共 ${item.chapters.size} 章复现，建议评估转为 entities/item_*.md 或补入已有实体 unique_aliases)`
            );
        }
    }
    return candidates;
}

function buildDreamProseGateOptions(config: BookConfig): ProseGateOptions {
    return {
        enableAntiCliche: config.prose_gate.enable_anti_cliche,
        enableCrossChapterSimile: config.prose_gate.enable_cross_chapter_simile,
        crossChapterSimileWindow: config.prose_gate.cross_chapter_simile_window,
        narrationSubjectivity: config.narration_subjectivity,
        maxPatchParagraphs: config.repair_loop?.gate_max_patch_paragraphs ?? 15,
        maxPatchParagraphRatio: config.repair_loop?.gate_max_patch_ratio ?? 0.6
    };
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
    private readonly gate: StaticProseGate;

    constructor(deps: DreamingPipelineDeps) {
        this.store = deps.store;
        this.roleRunner = deps.roleRunner;
        this.llm = deps.llm;
        this.system = deps.system;
        this.gate = new StaticProseGate();
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

            const dreamingCfg = snapshot.config.dreaming;
            const wordThreshold =
                options.dreamWordThreshold ??
                dreamingCfg?.word_threshold ??
                DEFAULT_DREAM_WORD_THRESHOLD;
            const bufferLimit =
                options.dreamBufferLimit ??
                dreamingCfg?.buffer_limit ??
                DEFAULT_DREAM_BUFFER_LIMIT;
            const warpedArchiveAfterDays =
                dreamingCfg?.warped_archive_after_days ?? DEFAULT_WARPED_ARCHIVE_AFTER_DAYS;
            const promoteAnchorMinChapters =
                dreamingCfg?.promote_anchor_min_chapters ?? DEFAULT_PROMOTE_ANCHOR_MIN_CHAPTERS;
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
            // 若仅由字数达标或强制触发且无实体达到 bufferLimit，仍把水位以来出场实体纳入脏清单避免空转
            if ((wordTriggered || options.force) && dirtyEntityIds.length === 0) {
                for (const entityId of candidateIds) {
                    const profile = snapshot.entities[entityId];
                    if (!profile) continue;
                    const eventBufferCount = profile.recentBuffer.filter(
                        (e) => !isVoiceSpecimenEntry(e.text, e.continuationLines)
                    ).length;
                    dirtyEntityIds.push(entityId);
                    dirtyEntityNotes.push(
                        `- ${entityId} (${profile.metadata.canonical_name}): last_seen_ch=${profile.metadata.last_seen_ch}, 第4区缓冲条数=${eventBufferCount}`
                    );
                }
            }

            const openThreadsRaw = await readOptionalText(
                join(this.store.bookRoot, 'world/open_threads.md')
            );
            const futureHorizonRaw = await readOptionalText(
                join(this.store.bookRoot, 'world/future_horizon.md')
            );

            const offscreenList = scanOffscreenEntityNotes(
                options.offscreenCharacters,
                snapshot.entities,
                watermarkCh,
                options.currentChapter,
                openThreadsRaw,
                futureHorizonRaw
            );
            const expiredWarpedNotes = scanExpiredWarpedEntries(
                futureHorizonRaw,
                snapshot.entities,
                currentStoryDay,
                warpedArchiveAfterDays
            );
            const anchorCandidates = await scanRecurringProseAnchors(
                this.store.bookRoot,
                snapshot.worldState.frontmatter.current_volume,
                snapshot.entities,
                promoteAnchorMinChapters
            );

            const bufferTriggered = dirtyEntityIds.length > 0;
            const hasHorizonWork =
                offscreenList.length > 0 ||
                expiredWarpedNotes.length > 0 ||
                anchorCandidates.length > 0;

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
                ...(dirtyEntityNotes.length > 0
                    ? dirtyEntityNotes
                    : ['- (无达到缓冲上限的脏实体，请重点核对伏笔、未来惯性与节拍)']),
                '',
                '## 自上次水位以来的 L2 双轨章卡',
                recentL2Text,
                ...(offscreenList.length > 0
                    ? [
                          '',
                          '## 离场重要角色幕后待办',
                          ...offscreenList.map(
                              (c) =>
                                  `- ${c.entityId}: 目标="${c.pendingGoal}" | 当前进度="${c.progressNote}"`
                          )
                      ]
                    : []),
                ...(expiredWarpedNotes.length > 0
                    ? [
                          '',
                          `## 超期 WARPED 废止条目待折叠清单（超过 ${warpedArchiveAfterDays} 故事日，请统一折叠至 world/future_horizon.md 底部 ## Archived WARPED 小节，严禁写入 entities/cold_archive/）`,
                          ...expiredWarpedNotes
                      ]
                    : []),
                ...(anchorCandidates.length > 0
                    ? [
                          '',
                          `## 跨章复现异象锚点建卡/补别名候选（出现 >= ${promoteAnchorMinChapters} 章，尚未匹配已知实体名录）`,
                          ...anchorCandidates
                      ]
                    : []),
                '',
                '请按规范使用 book_read / book_grep / book_glob 核实相关原稿与世界文档，通过 book_edit 在隔离暂存区联动修改脏实体与计划文件（严禁修改 manuscripts/、未出场干净实体及 world/current_arc_envelope.md / world/static_base_and_voice.md，冷宫归档仅限换卷时执行），最后调用 `yield_dream_commit` 原子提交。'
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
            addUsage(usage, runRes.usage);

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
     * 1. SOFT_MINOR -> 短锁内投递 RETCON 信号并提交；
     * 2. SINGLE_POINT_HARD -> 单次 tx.lock 内净室 RoleRunner('patch') + StaticProseGate 复检 + WAL/L2/hash 原子提交（同步回调在锁外）；
     * 3. CASCADING_HARD -> 短锁内快照信号/声纹 + 备份回滚 + 写 .ops/heal_plan.json -> 释放 tx.lock 后无锁重跑（失败写 QUARANTINED）。
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
                if (options.signal?.aborted) {
                    const abortErr = new Error('跨章自愈已中止');
                    abortErr.name = 'AbortError';
                    throw abortErr;
                }

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

                // 第一步：双侧原句去标点存在性代码验真（只读操作在锁外执行）
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
                        '- SINGLE_POINT_HARD: 生死/唯一物/地理硬冲突，但下游未依赖',
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
                }

                // 级别 1：软微瑕 -> 短锁内投递 RETCON 信号
                if (severity === 'SOFT_MINOR') {
                    await this.store.withTxLock(async () => {
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
                    });
                    results.push({
                        conflictId: conflict.conflictId,
                        action: 'RETCON_SIGNAL',
                        sideALine: verification.sideA.lineNumber,
                        sideBLine: verification.sideB.lineNumber
                    });
                    continue;
                }

                // 级别 2：单点硬穿帮 -> 单把 tx.lock 内完成净室 RoleRunner('patch') + StaticProseGate + WAL + L2/hash 原子提交
                if (severity === 'SINGLE_POINT_HARD') {
                    const relChapterPath = `manuscripts/${formatChapterKey(conflict.chapterB)}.md`;
                    const patchOutcome = await this.store.withTxLock(async () => {
                        const currentTextB = await readOptionalText(pathB);
                        if (currentTextB === null) {
                            return { missing: true as const };
                        }
                        const liveVerify = verifyDualQuotes(
                            conflict.quoteA,
                            textA,
                            conflict.quoteB,
                            currentTextB
                        );
                        if (!liveVerify.passed) {
                            return { stale: true as const };
                        }

                        const patchRoleCfg = await this.roleRunner.loadRoleConfig(
                            'patch',
                            this.store.bookRoot
                        );
                        if (patchRoleCfg.cleanroom || patchRoleCfg.maxReadCalls > 0) {
                            throw new ValidationError(
                                `Patch 角色配置违规：必须保持 cleanroom=false 且 maxReadCalls=0（当前 cleanroom=${String(patchRoleCfg.cleanroom)}, maxReadCalls=${patchRoleCfg.maxReadCalls}）`
                            );
                        }

                        const snapshot = await this.store.loadSnapshot();
                        const { cardRelPath, cardVolume, cardRaw, section } =
                            await this.locateChapterL2Card(
                                conflict.chapterB,
                                snapshot.worldState.frontmatter.current_volume
                            );
                        const chapterStoryDay = this.resolveChapterStoryDay(
                            section?.dayLabel,
                            snapshot.worldState.frontmatter.story_day
                        );

                        // 为净室 Patch 装配正向文风锁与出场实体卡片（严禁暴露全知禁区与 WARPED）
                        const staticVoiceRaw = await readOptionalText(
                            join(this.store.bookRoot, 'world/static_base_and_voice.md')
                        );
                        const staticVoiceClean = staticVoiceRaw
                            ? stripWriterRestrictedDirectives(staticVoiceRaw) ?? ''
                            : '';
                        const slicer = new ViewSlicer();
                        const focusEntityIds =
                            section && section.appearedEntityIds.length > 0
                                ? section.appearedEntityIds
                                : Object.keys(snapshot.entities);
                        const writerView = slicer.slice({
                            snapshot,
                            forRole: 'writer',
                            currentCh: conflict.chapterB,
                            targetDay: chapterStoryDay,
                            timelineMode: 'MAINLINE',
                            entityIds: focusEntityIds
                        });
                        const entityCardsText = Object.values(writerView.entities)
                            .map((profile) =>
                                renderEntityProfile(profile, {
                                    compactCard: false,
                                    stripWarped: true,
                                    cleanroomDisplay: true
                                })
                            )
                            .filter((block) => block.trim().length > 0)
                            .join('\n\n');

                        const { paragraphs } = analyzeParagraphs(currentTextB);
                        const targetParagraphIndices = this.resolveTargetParagraphIndices(
                            paragraphs,
                            conflict.quoteB,
                            liveVerify.sideB.startLine,
                            liveVerify.sideB.endLine
                        );
                        const numberedParagraphs = paragraphs
                            .map((p, idx) => `[${idx}] ${p}`)
                            .join('\n\n');

                        const cleanReason =
                            sanitizeTextForCleanroomWriter(reason) || CLEANROOM_PATCH_FALLBACK_REASON;
                        const cleanQuoteA = sanitizeTextForCleanroomWriter(conflict.quoteA);
                        const proseGateOptions = buildDreamProseGateOptions(snapshot.config);

                        const taskPrompt = [
                            staticVoiceClean ? `## 抽象文风纪律锁\n${staticVoiceClean}` : '',
                            entityCardsText ? `## 相关出场实体基准（净室脱敏）\n${entityCardsText}` : '',
                            `## 跨章单点硬穿帮修补目标\n${cleanReason}`,
                            cleanQuoteA
                                ? `## 前文锚点基准 (${formatChapterKey(conflict.chapterA)})\n${cleanQuoteA}`
                                : '',
                            `## 待修补段落索引 (0-based)\n[${targetParagraphIndices.join(', ')}]`,
                            `## 需改写的后文原句 (${formatChapterKey(conflict.chapterB)})\n${conflict.quoteB}`,
                            `## 当前待修补正文（0-based 段落索引）\n${numberedParagraphs}`,
                            '请对照 0-based 段落索引调用 `patch_paragraphs` 精准修改目标段落消除事实穿帮，保持人称、语气与前后文连贯，确认通过后调用 `yield_patched_draft` 提交定稿。'
                        ]
                            .filter(Boolean)
                            .join('\n\n');

                        const runRes = await this.roleRunner.runMultiTurn<YieldPatchedDraftResult>({
                            roleId: patchRoleCfg.id,
                            stage: 'HEAL_PATCH',
                            chapterNumber: conflict.chapterB,
                            bookRoot: this.store.bookRoot,
                            bookConfig: snapshot.config,
                            draftText: currentTextB,
                            proseGateOptions,
                            enforceProseGateOnYield: true,
                            taskPrompt,
                            signal: options.signal
                        });
                        addUsage(usage, runRes.usage);

                        const patchedText = runRes.yieldResult.patchedProse;
                        const gateResult = this.gate.evaluate(patchedText, proseGateOptions);
                        if (!gateResult.passed) {
                            throw new ValidationError(
                                `Tier 2 跨章修补未通过静态文风门禁 (${gateResult.violations.map((v) => v.ruleId).join(', ')})`
                            );
                        }

                        // 同一把锁内登记 WAL、写回手稿、刷新双轨 L2 卡与 chapter_hashes 后单次原子提交
                        const normPatched = normalizeForQuoteMatch(patchedText);
                        const preservedAnchors = (section?.anomalyAnchors ?? []).filter(
                            (anchor) => {
                                const trimmed = anchor.trim();
                                return (
                                    trimmed.length > 0 &&
                                    trimmed !== '无' &&
                                    normPatched.includes(normalizeForQuoteMatch(trimmed))
                                );
                            }
                        );
                        const plotSummary =
                            section?.plotSummary?.trim() ||
                            cleanReason ||
                            formatChapterKey(conflict.chapterB);
                        const nextCardContent = upsertVolumeCardEntry(
                            cardRaw,
                            cardVolume,
                            conflict.chapterB,
                            chapterStoryDay,
                            plotSummary,
                            section?.appearedEntityIds ?? [],
                            preservedAnchors
                        );

                        const chKey = formatChapterKey(conflict.chapterB);
                        const currentTx = await this.store.readTxState();
                        const nextTx: TxState = {
                            ...currentTx,
                            chapter_hashes: {
                                ...currentTx.chapter_hashes,
                                [chKey]: sha256Hex(patchedText)
                            },
                            updated_at: new Date().toISOString()
                        };

                        await this.store.recordPendingWrites([relChapterPath, cardRelPath]);
                        await writeFile(pathB, patchedText, 'utf8');
                        await mkdir(join(this.store.bookRoot, 'index/L2_cards'), {
                            recursive: true
                        });
                        await writeFile(join(this.store.bookRoot, cardRelPath), nextCardContent, 'utf8');
                        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
                        await writeFile(
                            join(this.store.bookRoot, '.ops/tx_state.json'),
                            `${JSON.stringify(nextTx, null, 4)}\n`,
                            'utf8'
                        );
                        await this.system.commitPaths(
                            this.store.bookRoot,
                            [relChapterPath, cardRelPath, '.ops/tx_state.json'],
                            `fix(${formatChapterTag(conflict.chapterB)}): cleanroom patch single-point conflict & refresh L2/hash`
                        );

                        return {
                            missing: false as const,
                            stale: false as const,
                            sideALine: verification.sideA.lineNumber,
                            sideBLine: liveVerify.sideB.lineNumber
                        };
                    });

                    if ('missing' in patchOutcome && patchOutcome.missing) {
                        results.push({
                            conflictId: conflict.conflictId,
                            action: 'DISCARDED_HALLUCINATION'
                        });
                        continue;
                    }
                    if ('stale' in patchOutcome && patchOutcome.stale) {
                        results.push({
                            conflictId: conflict.conflictId,
                            action: 'DISCARDED_HALLUCINATION'
                        });
                        continue;
                    }

                    // Sync 回调在释放 tx.lock 之后执行，彻底避免不可重入锁死锁
                    if (options.onSyncAfterPatch) {
                        await options.onSyncAfterPatch(conflict.chapterB);
                    }

                    results.push({
                        conflictId: conflict.conflictId,
                        action: 'PATCHED_IN_PLACE',
                        sideALine: patchOutcome.sideALine,
                        sideBLine: patchOutcome.sideBLine
                    });
                    continue;
                }

                // 级别 3：连带支线硬穿帮 -> 短锁内快照+回滚+写断点 -> 释放 tx.lock 后无锁重跑 -> 失败熔断 QUARANTINED / SAFE_HALT
                const maxAutoRollback =
                    options.maxAutoRollbackChapters ?? config.max_auto_rollback_chapters;
                const healGitLogMaxCount =
                    config.ops_and_sync?.heal_git_log_max_count ?? DEFAULT_HEAL_GIT_LOG_MAX_COUNT;
                const txStateBefore = await this.store.readTxState();
                const affectedChapters = this.collectAffectedChapters(
                    conflict.chapterB,
                    txStateBefore.last_committed_ch,
                    conflict.downstreamDependentChapters
                );
                const rollbackChapters = affectedChapters.length;
                const rollbackWords = await this.sumChaptersWords(affectedChapters);

                let rerunDeadlocked = false;
                let backupTag: string | undefined;
                const targetChapter = Math.max(0, conflict.chapterB - 1);

                if (maxAutoRollback > 0 && rollbackChapters <= maxAutoRollback) {
                    const prepared = await this.store.withTxLock(async () => {
                        const txState = await this.store.readTxState();
                        const signalsRaw = await readOptionalText(
                            join(this.store.bookRoot, '.ops/signals.jsonl')
                        );
                        const cursorState = await readSignalsCursorState(this.store.bookRoot);
                        const voiceSamplesRaw = await readOptionalText(
                            join(this.store.bookRoot, '.ops/voice_samples.yaml')
                        );
                        const lockPath = join(this.store.bookRoot, '.ops/tx.lock');
                        const currentLockContent = await readOptionalText(lockPath);

                        const tag = `backup/pre-heal-${formatChapterTag(conflict.chapterB)}-${Date.now()}`;
                        await this.system.createTag(
                            this.store.bookRoot,
                            tag,
                            `Backup before auto-rollback for ${conflict.conflictId}`
                        );

                        const rollbackRef = options.resolveRollbackRef
                            ? await options.resolveRollbackRef(targetChapter)
                            : await this.findRollbackRef(targetChapter, healGitLogMaxCount);

                        await this.system.resetHard(this.store.bookRoot, rollbackRef);
                        // 立即清除或还原被历史提交误带出的 .ops/tx.lock，保证退出短锁时锁文件被干净释放
                        if (currentLockContent !== null) {
                            await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
                            await writeFile(lockPath, currentLockContent, 'utf8');
                        } else {
                            await rm(lockPath, { force: true });
                        }
                        await this.system.cleanUntracked(this.store.bookRoot, ['.ops/**']);

                        // 合并写回保留的信号队列与声纹池，并追加本次正向重跑修正信号
                        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
                        const preservedLines = (signalsRaw ?? '')
                            .split(/\r?\n/)
                            .map((line) => line.trim())
                            .filter((line) => line.length > 0);
                        const rerunSignal: OpsSignal = {
                            type: 'RETCON',
                            created_at: new Date().toISOString(),
                            chapter: conflict.chapterB,
                            conflict_id: conflict.conflictId,
                            chapter_a: conflict.chapterA,
                            chapter_b: conflict.chapterB,
                            reason: `[HEAL_ROLLBACK_CONSTRAINT] ${reason}`
                        };
                        await writeFile(
                            join(this.store.bookRoot, '.ops/signals.jsonl'),
                            `${[...preservedLines, JSON.stringify(rerunSignal)].join('\n')}\n`,
                            'utf8'
                        );
                        const parsedPreserved = preservedLines.flatMap((line) => {
                            try {
                                const obj = JSON.parse(line) as Record<string, unknown>;
                                return [obj];
                            } catch {
                                return [];
                            }
                        });
                        const rollbackSignalIds = new Set<string>();
                        for (const sigObj of parsedPreserved) {
                            const sigChapter =
                                typeof sigObj['chapter'] === 'number' ? sigObj['chapter'] : 0;
                            if (sigChapter >= conflict.chapterB) {
                                rollbackSignalIds.add(resolveSignalId(sigObj));
                            }
                        }
                        const filteredConsumedIds = cursorState.consumedIds.filter(
                            (id) => !rollbackSignalIds.has(id)
                        );
                        await writeSignalsCursorState(this.store.bookRoot, {
                            consumedLines: Math.min(
                                cursorState.consumedLines,
                                Math.max(0, preservedLines.length - rollbackSignalIds.size)
                            ),
                            consumedIds: filteredConsumedIds
                        });
                        if (voiceSamplesRaw !== null) {
                            await writeFile(
                                join(this.store.bookRoot, '.ops/voice_samples.yaml'),
                                voiceSamplesRaw,
                                'utf8'
                            );
                        }

                        await writeHealPlan(this.store.bookRoot, {
                            conflictId: conflict.conflictId,
                            backupTag: tag,
                            fromChapter: conflict.chapterB,
                            toChapter: Math.max(conflict.chapterB, txState.last_committed_ch),
                            nextChapter: conflict.chapterB,
                            constraint: reason
                        });

                        return { backupTag: tag };
                    });

                    backupTag = prepared.backupTag;

                    // 严格在释放 tx.lock 后执行重跑回调（内部 stepChapter 可安全独立取锁）
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
                        } catch (err) {
                            if (options.signal?.aborted || isAbortError(err)) {
                                throw err;
                            }
                            rerunDeadlocked = true;
                        }
                    }

                    if (!rerunDeadlocked) {
                        await clearHealPlan(this.store.bookRoot);
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

                await this.store.withTxLock(async () => {
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
                });

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

    private async locateChapterL2Card(
        chapterNumber: number,
        defaultVolume: number
    ): Promise<{
        cardRelPath: string;
        cardVolume: number;
        cardRaw: string | null;
        section: ReturnType<typeof parseL2CardSections>['sections'][number] | undefined;
    }> {
        const defaultVolPad = String(defaultVolume).padStart(2, '0');
        const defaultRel = `index/L2_cards/vol_${defaultVolPad}_cards.md`;
        const defaultRaw = await readOptionalText(join(this.store.bookRoot, defaultRel));
        const defaultSec = defaultRaw
            ? parseL2CardSections(defaultRaw).sections.find((s) => s.chapterNumber === chapterNumber)
            : undefined;
        if (defaultSec) {
            return {
                cardRelPath: defaultRel,
                cardVolume: defaultVolume,
                cardRaw: defaultRaw,
                section: defaultSec
            };
        }

        const l2Dir = join(this.store.bookRoot, 'index/L2_cards');
        try {
            const files = (await readdir(l2Dir)).filter((f) => /^vol_(\d+)_cards\.md$/.test(f)).sort();
            for (const file of files) {
                const rel = `index/L2_cards/${file}`;
                const raw = await readOptionalText(join(this.store.bookRoot, rel));
                if (!raw) continue;
                const sec = parseL2CardSections(raw).sections.find(
                    (s) => s.chapterNumber === chapterNumber
                );
                if (sec) {
                    const parsedVol = Number(/^vol_(\d+)_cards\.md$/.exec(file)?.[1] ?? defaultVolume);
                    return {
                        cardRelPath: rel,
                        cardVolume: Number.isFinite(parsedVol) ? parsedVol : defaultVolume,
                        cardRaw: raw,
                        section: sec
                    };
                }
            }
        } catch {
            // index/L2_cards 目录尚未建立时回退当前卷文件
        }

        return {
            cardRelPath: defaultRel,
            cardVolume: defaultVolume,
            cardRaw: defaultRaw,
            section: undefined
        };
    }

    private resolveChapterStoryDay(dayLabel: string | undefined, fallbackStoryDay: number): number {
        if (!dayLabel) return fallbackStoryDay;
        const m = /^day:(-?\d+)$/i.exec(dayLabel.trim());
        if (!m?.[1]) return fallbackStoryDay;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : fallbackStoryDay;
    }

    private resolveTargetParagraphIndices(
        paragraphs: readonly string[],
        quoteB: string,
        startLine: number | null,
        endLine: number | null
    ): number[] {
        const normQuote = normalizeForQuoteMatch(quoteB);
        const byQuote: number[] = [];
        for (let i = 0; i < paragraphs.length; i += 1) {
            const p = paragraphs[i] ?? '';
            if (normQuote && normalizeForQuoteMatch(p).includes(normQuote)) {
                byQuote.push(i);
            }
        }
        if (byQuote.length > 0) {
            return byQuote;
        }
        if (startLine !== null && endLine !== null && paragraphs.length > 0) {
            // 退化按行号粗略定位（至少包含一个有效 0-based 段落索引）
            const clamped = Math.min(paragraphs.length - 1, Math.max(0, startLine > 1 ? 1 : 0));
            return [clamped];
        }
        return paragraphs.length > 1 ? [1] : [0];
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
        maxCount = DEFAULT_HEAL_GIT_LOG_MAX_COUNT
    ): Promise<string> {
        // 1. 优先从 Git commit log 逐条检索 <= targetChapter 的最近有效稳定基线（依据 .ops/tx_state.json 与原稿列表）
        try {
            const { stdout } = await execFileAsync(
                'git',
                [
                    '-C',
                    this.store.bookRoot,
                    'log',
                    '-n',
                    String(Math.max(1, Math.floor(maxCount))),
                    '--format=%H'
                ],
                { encoding: 'utf8' }
            );
            const commits = stdout
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);

            for (const sha of commits) {
                const txRaw = await this.system.readFileAtRef(
                    this.store.bookRoot,
                    sha,
                    '.ops/tx_state.json'
                );
                if (txRaw !== null) {
                    try {
                        const tx = TxStateSchema.parse(JSON.parse(txRaw));
                        if (
                            tx.last_committed_ch <= targetChapter &&
                            tx.phase !== 'DRAFTING' &&
                            tx.phase !== 'FEAT_COMMITTED'
                        ) {
                            return sha;
                        }
                        continue;
                    } catch {
                        // 若该历史提交 tx_state 解析异常，继续检查其原稿章节号
                    }
                }

                // 无有效 tx_state 时回退检查该提交下 manuscripts/ 最大章号
                const { stdout: treeOut } = await execFileAsync(
                    'git',
                    ['-C', this.store.bookRoot, 'ls-tree', '-r', '--name-only', sha, 'manuscripts'],
                    { encoding: 'utf8' }
                );
                const chNumbers = treeOut
                    .split(/\r?\n/)
                    .map((p) => /ch_(\d{4})\.md$/.exec(p.trim())?.[1])
                    .filter((m): m is string => Boolean(m))
                    .map((m) => Number(m));
                const maxCh = chNumbers.length > 0 ? Math.max(...chNumbers) : 0;
                if (maxCh <= targetChapter) {
                    return sha;
                }
            }

            if (commits.length > 0) {
                return commits[commits.length - 1]!;
            }
        } catch {
            // 回退检查 tag 或 HEAD
        }

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
                // 忽略
            }
        }

        return 'HEAD';
    }
}

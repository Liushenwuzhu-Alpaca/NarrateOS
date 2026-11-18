import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ENTITY_ID_RE,
    ForeignKeyError,
    generateStructuredJson,
    IndexRecall,
    mergeEntityProfilePatch,
    normalizeForQuoteMatch,
    parseEntityMarkdown,
    parseL2CardSections,
    serializeEntityMarkdown,
    TxStateSchema,
    verifyDualQuotes,
    ViewSlicer,
    withTraceRun,
    type BookSnapshot,
    type BookStore,
    type DirtyChapter,
    type EntityPatch,
    type EntityProfile,
    type LlmPort,
    type StructuredRetryOptions,
    type SystemPort,
    type TimelineMode,
    type TokenUsage,
    type TxState
} from '@narrateos/dsh-book-store';
import {
    ExtractorOutputSchema,
    type ExtractorOutput,
    type YieldStatePatchResult
} from '@narrateos/dsh-book-tools';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import type { RoleRunner } from '../runner/role-runner.js';
import {
    DownstreamScanOutputSchema,
    SyncDiffAnalysisSchema,
    type DownstreamConflictReport,
    type SyncManuscriptsOptions,
    type SyncManuscriptsResult
} from '../schemas.js';
import {
    addUsage,
    CHAPTER_FILE_RE,
    createEmptyUsage,
    formatChapterKey,
    readOptionalText
} from './helpers.js';

const VOLUME_CARD_FILE_RE = /^vol_(\d+)_cards\.md$/;
const SAGA_SHARD_RE = /_saga_\d+$/;
const DEFAULT_CONFLICT_SCAN_BATCH_CHARS = 24_000;
const DEFAULT_EXTRACTOR_FULL_ENTITY_THRESHOLD = 15;

export interface SyncPipelineDeps {
    store: BookStore;
    llm: LlmPort;
    system: SystemPort;
    slicer?: ViewSlicer | undefined;
    roleRunner?: RoleRunner | undefined;
    indexRecall?: IndexRecall | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
}

interface HistoricalDirtyItem {
    dirty: DirtyChapter;
    diffText: string;
    currentText: string;
    headText: string | null;
    extracted: ExtractorOutput;
}

interface DownstreamChapterData {
    chapterNumber: number;
    relativePath: string;
    text: string;
}

/** 构建带新建实体中文 canonical_name 强校验的 Extractor Schema */
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
                        message: `首次新建实体 ${patch.entity_id} 时必须提供标准中文 canonical_name`
                    });
                }
            }
        });
    });
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

function formatVolumeCardRelPath(volumeNumber: number): string {
    return `index/L2_cards/vol_${String(volumeNumber).padStart(2, '0')}_cards.md`;
}

/** 在本文件内格式化标准双轨 L2 章卡（Phase 4 /simplify 将与 helpers.ts 统一收拢） */
function upsertDualTrackVolumeCardEntry(
    rawCardContent: string | null,
    volumeNumber: number,
    chapterNumber: number,
    storyDay: number,
    plotSummary: string,
    proseAnchors: string[],
    appearanceEntityIds: string[]
): string {
    const baseContent =
        rawCardContent && rawCardContent.trim().length > 0
            ? rawCardContent.replace(/\r\n/g, '\n')
            : `# 第 ${volumeNumber} 卷双轨章卡\n\n`;
    const chKey = formatChapterKey(chapterNumber);
    const cleanAnchors = [...new Set(proseAnchors.map((a) => a.trim()).filter(Boolean))];
    const cleanIds = [...new Set(appearanceEntityIds.map((id) => id.trim()).filter(Boolean))];
    const entryBlock = [
        `## ${chKey} (day:${storyDay})`,
        `- 主干剧情：${plotSummary.trim()}`,
        `- 异象锚点：${cleanAnchors.length > 0 ? cleanAnchors.join('、') : '无'}`,
        `- 出场实体：${cleanIds.join(', ')}`
    ].join('\n');
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

function parseStoryDayFromChapterText(content: string, fallbackDay: number): number {
    const commentMatch = /<!--\s*story_day:\s*(-?\d+)\s*-->/.exec(content);
    if (commentMatch?.[1]) {
        const day = Number(commentMatch[1]);
        if (Number.isInteger(day)) return day;
    }
    const yamlMatch = /^---\r?\n[\s\S]*?story_day:\s*(-?\d+)[\s\S]*?\r?\n---/.exec(content);
    if (yamlMatch?.[1]) {
        const day = Number(yamlMatch[1]);
        if (Number.isInteger(day)) return day;
    }
    return fallbackDay;
}

function extractL1VolumeChapterRanges(
    l1Markdown: string
): Array<{ volumeNumber: number; startChapter: number; endChapter: number }> {
    const ranges: Array<{ volumeNumber: number; startChapter: number; endChapter: number }> = [];
    const lines = l1Markdown.replace(/\r\n/g, '\n').split('\n');
    let currentVol: number | null = null;

    const extractVolNum = (text: string): number | null => {
        const m1 = /\bvol_(\d+)\b/i.exec(text);
        if (m1?.[1]) return Number(m1[1]);
        const m2 = /第\s*(\d+)\s*卷/.exec(text);
        if (m2?.[1]) return Number(m2[1]);
        return null;
    };

    for (const line of lines) {
        const volNum = extractVolNum(line);
        if (volNum !== null && Number.isInteger(volNum) && volNum > 0) {
            currentVol = volNum;
        }
        if (currentVol === null) continue;

        const chKeyRange = /ch_(\d{4})\s*[-~～至]\s*ch_(\d{4})/i.exec(line);
        if (chKeyRange?.[1] && chKeyRange[2]) {
            const start = Number(chKeyRange[1]);
            const end = Number(chKeyRange[2]);
            if (start > 0 && end >= start) {
                ranges.push({ volumeNumber: currentVol, startChapter: start, endChapter: end });
            }
            continue;
        }

        const cnRange = /第\s*(\d+)\s*[-~～至]\s*第?\s*(\d+)\s*章/.exec(line);
        if (cnRange?.[1] && cnRange[2]) {
            const start = Number(cnRange[1]);
            const end = Number(cnRange[2]);
            if (start > 0 && end >= start) {
                ranges.push({ volumeNumber: currentVol, startChapter: start, endChapter: end });
            }
        }
    }
    return ranges;
}

function filterValidProseAnchors(anchors: string[], prose: string): string[] {
    if (anchors.length === 0) return [];
    const normalizedProse = normalizeForQuoteMatch(prose);
    return anchors.filter((anchor) => {
        const norm = normalizeForQuoteMatch(anchor);
        return norm.length >= 2 && normalizedProse.includes(norm);
    });
}

function extractDiffKeywords(diffText: string): string[] {
    const keywords = new Set<string>();
    for (const line of diffText.split(/\r?\n/)) {
        if (!line.startsWith('- ') && !line.startsWith('+ ')) continue;
        const clean = line.replace(/^[-+]\s*(?:\[L\d+\]\s*)?/, '').trim();
        if (!clean) continue;
        for (const match of clean.matchAll(/[\u4e00-\u9fa5]{2,8}|[a-zA-Z0-9_-]{3,24}/g)) {
            const tok = match[0];
            if (tok) keywords.add(tok);
        }
    }
    return [...keywords].slice(0, 40);
}

/**
 * 手稿真源增量同步 (Sync) 管线：
 * - 预检跳号 UNTRACKED 手稿与活跃 PARALLEL 窗口；
 * - Step 1：升序处理历史脏章 (dirtyCh < last_committed_ch)，精准定位所属卷刷新双轨 L2 卡与哈希，严禁触发实体第 2/4 区覆写；
 * - Step 2：升序处理最新章或顺次新章，纯修辞润色仅刷哈希，事实变更保留原 chapter_context 经 Extractor 在内存演进校验；
 * - Step 3：全量预校验通过后，单次 recordPendingWrites + 单次 commitPaths 原子提交全部变更；
 * - Step 4：历史脏章两级分批只读下游冲突扫描 + 双侧 verifyDualQuotes 验真并落盘 .ops/sync_conflicts.json。
 */
export class SyncPipeline {
    private readonly store: BookStore;
    private readonly llm: LlmPort;
    private readonly system: SystemPort;
    private readonly slicer: ViewSlicer;
    private readonly roleRunner: RoleRunner | undefined;
    private readonly indexRecall: IndexRecall;
    private readonly retryOptions: StructuredRetryOptions | undefined;

    constructor(deps: SyncPipelineDeps) {
        this.store = deps.store;
        this.llm = deps.llm;
        this.system = deps.system;
        this.slicer = deps.slicer ?? new ViewSlicer();
        this.roleRunner = deps.roleRunner;
        this.indexRecall = deps.indexRecall ?? new IndexRecall(deps.system);
        this.retryOptions = deps.retryOptions;
    }

    async syncManuscripts(
        options: SyncManuscriptsOptions = {}
    ): Promise<SyncManuscriptsResult> {
        return await withTraceRun(this.store.bookRoot, 'sync', {}, () =>
            this.store.runWithTxLock(() => this.syncManuscriptsLocked(options))
        );
    }

    private async syncManuscriptsLocked(
        options: SyncManuscriptsOptions
    ): Promise<SyncManuscriptsResult> {
        const worldState = await this.store.readWorldState();
        if (worldState.frontmatter.timeline_mode === 'PARALLEL') {
            throw new ValidationError('并行窗口合并前不能执行主线 Sync');
        }

        const totalUsage = createEmptyUsage();
        const detectedDirty = await this.store.detectDirtyChapters();
        if (detectedDirty.length === 0) {
            return {
                status: 'CLEAN',
                dirtyChapters: [],
                updatedEntities: [],
                downstreamConflicts: [],
                totalUsage
            };
        }

        const dirtyChapters = [...detectedDirty].sort((a, b) => a.chapterNumber - b.chapterNumber);
        const snapshot = await this.store.loadSnapshot();
        const lastCommitted = snapshot.txState.last_committed_ch;

        // 预检 1：拒绝处于活跃 PARALLEL 窗口时修改主线章节
        await this.assertNoOpenParallelConflict(dirtyChapters);

        // 预检 2：拒绝章号跳号（> last_committed_ch + 1）的 UNTRACKED 手稿
        const skippedUntracked = dirtyChapters.find(
            (d) => d.reason === 'UNTRACKED' && d.chapterNumber > lastCommitted + 1
        );
        if (skippedUntracked) {
            throw new ValidationError(
                `拒绝同步跳号手稿 ${skippedUntracked.chapterKey}：当前已提交至第 ${lastCommitted} 章，仅允许顺次新增第 ${lastCommitted + 1} 章`
            );
        }

        const retryOptions: StructuredRetryOptions = this.retryOptions ?? {
            maxRetries: snapshot.config.structured_json_retry.max_retries,
            backoffMs: snapshot.config.structured_json_retry.backoff_ms
        };

        const volumeContext = await this.loadVolumeResolutionContext(
            snapshot.worldState.frontmatter.current_volume
        );
        const stagedCards = new Map<string, string>();
        const pendingChapterHashes: Record<string, string> = {};
        const stateDiffAdvisories: string[] = [];

        const historicalDirtyList = dirtyChapters.filter((d) => d.chapterNumber < lastCommitted);
        const headOrNextList = dirtyChapters.filter((d) => d.chapterNumber >= lastCommitted);

        // Step 1：先升序处理所有历史脏章 (dirtyCh < last_committed_ch)，仅刷新所属卷双轨 L2 卡与哈希
        const historicalItems: HistoricalDirtyItem[] = [];
        for (const dirty of historicalDirtyList) {
            const { diffText, currentText, headText } = await this.computeChapterDiffText(dirty);
            const targetVol = this.resolveVolumeForChapter(dirty.chapterNumber, volumeContext);
            const cardRelPath = formatVolumeCardRelPath(targetVol);
            const cardContent = await this.readStagedOrDiskCard(cardRelPath, stagedCards);
            const existingDay = this.findExistingCardStoryDay(
                cardContent,
                dirty.chapterNumber,
                parseStoryDayFromChapterText(currentText, snapshot.worldState.frontmatter.story_day)
            );

            const extractedRes = await this.runExtractorForChapter({
                snapshot,
                chapterNumber: dirty.chapterNumber,
                timelineMode: 'MAINLINE',
                targetDay: existingDay,
                povCharIds: [snapshot.worldState.frontmatter.pov_character],
                diffText,
                currentText,
                isHistorical: true,
                retryOptions,
                signal: options.signal
            });
            addUsage(totalUsage, extractedRes.usage);

            const extracted = extractedRes.output;
            if (extracted.entity_patches.length > 0 || extracted.story_day_delta > 0) {
                const patchIds = extracted.entity_patches.map((p) => p.entity_id);
                const detail =
                    patchIds.length > 0
                        ? `涉实体 [${patchIds.join(', ')}]`
                        : `story_day_delta=${extracted.story_day_delta}`;
                stateDiffAdvisories.push(
                    `${dirty.chapterKey}: 检测到设定/状态差异（${detail}），历史旧章同步已跳过实体第 2/4 区与 world_state 覆写以避免状态倒流`
                );
            }

            const validAnchors = filterValidProseAnchors(extracted.prose_anchors, currentText);
            const knownIds = new Set<string>([
                ...Object.keys(snapshot.entities),
                ...snapshot.coldArchiveIds
            ]);
            const appearedIds = [
                ...new Set([
                    ...extracted.appeared_entity_ids.filter((id) => knownIds.has(id)),
                    ...extracted.entity_patches
                        .map((p) => p.entity_id)
                        .filter((id) => knownIds.has(id))
                ])
            ];
            const plotSummary = (extracted.plot_summary ?? extracted.chapter_summary ?? '').trim();

            stagedCards.set(
                cardRelPath,
                upsertDualTrackVolumeCardEntry(
                    cardContent,
                    targetVol,
                    dirty.chapterNumber,
                    existingDay,
                    plotSummary,
                    validAnchors,
                    appearedIds
                )
            );
            pendingChapterHashes[dirty.chapterKey] = dirty.actualHash;
            historicalItems.push({ dirty, diffText, currentText, headText, extracted });
        }

        // Step 2：再按升序处理最新章 (dirtyCh === last_committed_ch) 与顺次新章 (last_committed_ch + 1)
        // 在内存中演进实体快照、world_state 与约束预校验，校验全数通过前零磁盘写入
        const workingSnapshot: BookSnapshot = {
            ...snapshot,
            worldState: {
                frontmatter: { ...snapshot.worldState.frontmatter },
                summaryMarkdown: snapshot.worldState.summaryMarkdown
            },
            entities: { ...snapshot.entities },
            coldArchiveIds: [...snapshot.coldArchiveIds]
        };
        const stagedEntities = new Map<string, EntityProfile>();
        const wokenColdArchiveIds = new Set<string>();
        const pendingNewEntityIds = new Set<string>();
        let hasFactualHeadOrNext = false;
        let lastFactualChapterNumber: number | null = null;
        let lastPreservedContext: TxState['chapter_context'] | undefined =
            snapshot.txState.chapter_context;
        let latestWorldStateUpdated = false;
        let latestNextChapterOptions: { source_chapter: number; options: string[] } | null = null;
        let prosePolishOnlySingle = false;

        for (const dirty of headOrNextList) {
            const { diffText, currentText } = await this.computeChapterDiffText(dirty);

            if (dirty.reason === 'MODIFIED' && dirty.chapterNumber === lastCommitted) {
                const diffRes = await generateStructuredJson(
                    this.llm,
                    {
                        pool: 'fast_retrieval',
                        traceStage: 'sync.classify',
                        staticPrefixBlocks: [
                            '你是手稿增量同步定性器。请判断本次手改差异是否仅为字词修辞润色（无剧情事实、人物位置、物品持有或数值变更），输出 JSON。'
                        ],
                        dynamicTail: `## ${dirty.chapterKey} 修改差异\n${diffText}`
                    },
                    SyncDiffAnalysisSchema,
                    retryOptions,
                    options.signal
                );
                addUsage(totalUsage, diffRes.totalUsage);

                if (diffRes.data.is_prose_polish_only) {
                    pendingChapterHashes[dirty.chapterKey] = dirty.actualHash;
                    if (historicalItems.length === 0 && headOrNextList.length === 1) {
                        prosePolishOnlySingle = true;
                    }
                    continue;
                }
            }

            const preservedContext: NonNullable<TxState['chapter_context']> =
                dirty.chapterNumber === lastCommitted && workingSnapshot.txState.chapter_context
                    ? workingSnapshot.txState.chapter_context
                    : {
                          timelineMode: workingSnapshot.worldState.frontmatter.timeline_mode,
                          targetDay: workingSnapshot.worldState.frontmatter.story_day,
                          povCharIds: [workingSnapshot.worldState.frontmatter.pov_character]
                      };
            const effectiveTimelineMode = preservedContext.timelineMode;
            const effectiveTargetDay = preservedContext.targetDay;
            const effectivePovCharIds =
                preservedContext.povCharIds.length > 0
                    ? preservedContext.povCharIds
                    : [workingSnapshot.worldState.frontmatter.pov_character];

            const extractedRes = await this.runExtractorForChapter({
                snapshot: workingSnapshot,
                chapterNumber: dirty.chapterNumber,
                timelineMode: effectiveTimelineMode,
                targetDay: effectiveTargetDay,
                povCharIds: effectivePovCharIds,
                diffText,
                currentText,
                isHistorical: false,
                retryOptions,
                signal: options.signal
            });
            addUsage(totalUsage, extractedRes.usage);

            const extracted = extractedRes.output;
            const sanitizedPatches = sanitizeExtractorPatches(
                workingSnapshot,
                extracted.entity_patches as EntityPatch[]
            );

            if (effectiveTimelineMode === 'FLASHBACK' && extracted.story_day_delta > 0) {
                throw new ValidationError(
                    `FLASHBACK 模式下最新章 ${dirty.chapterKey} 严禁推进主线 story_day`
                );
            }

            for (const patch of sanitizedPatches) {
                if (!ENTITY_ID_RE.test(patch.entity_id)) {
                    throw new ValidationError(`非法的 entity_id 格式: ${patch.entity_id}`);
                }
                if (effectiveTimelineMode === 'FLASHBACK') {
                    if (
                        (patch.acquired_state_ops && patch.acquired_state_ops.length > 0) ||
                        (patch.buffer_ops && patch.buffer_ops.length > 0)
                    ) {
                        throw new ValidationError(
                            `FLASHBACK 模式下最新章 ${dirty.chapterKey} 严禁修改实体 ${patch.entity_id} 的第 2/4 区`
                        );
                    }
                }

                let existing: EntityProfile | null =
                    stagedEntities.get(patch.entity_id) ??
                    workingSnapshot.entities[patch.entity_id] ??
                    null;

                if (!existing) {
                    const diskEntityPath = join(
                        this.store.bookRoot,
                        'entities',
                        `${patch.entity_id}.md`
                    );
                    const diskRaw = await readOptionalText(diskEntityPath);
                    if (diskRaw !== null) {
                        existing = parseEntityMarkdown(diskRaw);
                    } else if (!SAGA_SHARD_RE.test(patch.entity_id)) {
                        const coldProfile = await this.store.readColdArchivedEntity(patch.entity_id);
                        if (coldProfile) {
                            if (effectiveTimelineMode !== 'MAINLINE') {
                                throw new ValidationError(
                                    `${effectiveTimelineMode} 模式下禁止将冷宫实体 ${patch.entity_id} 迁回主线 entities/`
                                );
                            }
                            existing = coldProfile;
                            wokenColdArchiveIds.add(patch.entity_id);
                            workingSnapshot.coldArchiveIds = workingSnapshot.coldArchiveIds.filter(
                                (id) => id !== patch.entity_id
                            );
                        }
                    }
                    if (!existing) {
                        pendingNewEntityIds.add(patch.entity_id);
                    }
                }

                const merged = mergeEntityProfilePatch(existing, patch, false);
                stagedEntities.set(patch.entity_id, merged);
                workingSnapshot.entities[patch.entity_id] = merged;
            }

            const targetVol = this.resolveVolumeForChapter(dirty.chapterNumber, volumeContext);
            const cardRelPath = formatVolumeCardRelPath(targetVol);
            const cardContent = await this.readStagedOrDiskCard(cardRelPath, stagedCards);
            const nextStoryDay =
                effectiveTimelineMode === 'MAINLINE'
                    ? effectiveTargetDay + extracted.story_day_delta
                    : effectiveTargetDay;
            const validAnchors = filterValidProseAnchors(extracted.prose_anchors, currentText);
            const knownIds = new Set<string>([
                ...Object.keys(workingSnapshot.entities),
                ...workingSnapshot.coldArchiveIds,
                ...sanitizedPatches.map((p) => p.entity_id)
            ]);
            const appearedIds = [
                ...new Set([
                    ...effectivePovCharIds,
                    ...extracted.appeared_entity_ids.filter((id) => knownIds.has(id)),
                    ...sanitizedPatches.map((p) => p.entity_id)
                ])
            ];
            const plotSummary = (extracted.plot_summary ?? extracted.chapter_summary ?? '').trim();

            stagedCards.set(
                cardRelPath,
                upsertDualTrackVolumeCardEntry(
                    cardContent,
                    targetVol,
                    dirty.chapterNumber,
                    nextStoryDay,
                    plotSummary,
                    validAnchors,
                    appearedIds
                )
            );
            pendingChapterHashes[dirty.chapterKey] = dirty.actualHash;

            if (effectiveTimelineMode === 'MAINLINE') {
                workingSnapshot.worldState = {
                    frontmatter: {
                        ...workingSnapshot.worldState.frontmatter,
                        current_chapter: Math.max(
                            workingSnapshot.worldState.frontmatter.current_chapter,
                            dirty.chapterNumber
                        ),
                        story_day: nextStoryDay,
                        pov_character:
                            effectivePovCharIds[0] ??
                            workingSnapshot.worldState.frontmatter.pov_character,
                        timeline_mode: effectiveTimelineMode
                    },
                    summaryMarkdown:
                        extracted.world_summary_markdown ??
                        workingSnapshot.worldState.summaryMarkdown
                };
                latestWorldStateUpdated = true;
            }

            hasFactualHeadOrNext = true;
            lastFactualChapterNumber = dirty.chapterNumber;
            lastPreservedContext = preservedContext;
            latestNextChapterOptions = {
                source_chapter: dirty.chapterNumber,
                options: extracted.next_chapter_options
            };
        }

        // 1ms 跨实体外键可达性内存全量预校验（不通过前零磁盘写、零 Git 提交）
        if (stagedEntities.size > 0) {
            const reachableKeys = await this.buildReachableKeySet(
                pendingNewEntityIds,
                dirtyChapters.map((d) => d.chapterKey)
            );
            for (const [entityId, profile] of stagedEntities.entries()) {
                this.assertForeignKeysReachable(
                    entityId,
                    serializeEntityMarkdown(profile),
                    reachableKeys
                );
            }
        }

        // Step 3：单次 recordPendingWrites + 单次 commitPaths 原子提交全部变更
        const dirtyPaths = dirtyChapters.map((d) => d.relativePath);
        const cardPaths = [...stagedCards.keys()];
        const entityPaths = [...stagedEntities.keys()].map((id) => `entities/${id}.md`);
        const coldArchivePaths = [...wokenColdArchiveIds].map(
            (id) => `entities/cold_archive/${id}.md`
        );
        const worldStatePaths = latestWorldStateUpdated ? ['world/world_state.md'] : [];
        const nextOptionPaths =
            latestNextChapterOptions !== null ? ['.ops/next_chapter_options.json'] : [];

        const allManagedPaths = [
            ...new Set([
                ...dirtyPaths,
                ...cardPaths,
                ...entityPaths,
                ...coldArchivePaths,
                ...worldStatePaths,
                ...nextOptionPaths
            ])
        ];

        await this.store.recordPendingWrites(allManagedPaths);

        if (stagedEntities.size > 0) {
            await mkdir(join(this.store.bookRoot, 'entities'), { recursive: true });
            for (const [entityId, profile] of stagedEntities.entries()) {
                await writeFile(
                    join(this.store.bookRoot, `entities/${entityId}.md`),
                    serializeEntityMarkdown(profile),
                    'utf8'
                );
            }
        }
        for (const wokenId of wokenColdArchiveIds) {
            await unlink(join(this.store.bookRoot, `entities/cold_archive/${wokenId}.md`));
        }
        if (latestWorldStateUpdated) {
            await this.store.writeWorldState(workingSnapshot.worldState);
        }
        for (const [relPath, content] of stagedCards.entries()) {
            await mkdir(join(this.store.bookRoot, 'index/L2_cards'), { recursive: true });
            await writeFile(join(this.store.bookRoot, relPath), content, 'utf8');
        }
        if (latestNextChapterOptions !== null) {
            await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
            await writeFile(
                join(this.store.bookRoot, '.ops/next_chapter_options.json'),
                `${JSON.stringify(latestNextChapterOptions, null, 4)}\n`,
                'utf8'
            );
        }

        const currentTx = await this.store.readTxState();
        const maxDirtyChapter = Math.max(...dirtyChapters.map((d) => d.chapterNumber));
        const nextTx = TxStateSchema.parse({
            ...currentTx,
            phase: hasFactualHeadOrNext ? 'STATE_COMMITTED' : currentTx.phase,
            active_chapter: hasFactualHeadOrNext ? lastFactualChapterNumber : currentTx.active_chapter,
            last_committed_ch: Math.max(currentTx.last_committed_ch, maxDirtyChapter),
            chapter_context: lastPreservedContext,
            chapter_hashes: {
                ...currentTx.chapter_hashes,
                ...pendingChapterHashes
            },
            updated_at: new Date().toISOString()
        });
        await writeFile(
            join(this.store.bookRoot, '.ops/tx_state.json'),
            `${JSON.stringify(nextTx, null, 4)}\n`,
            'utf8'
        );

        const commitMsg = prosePolishOnlySingle
            ? `chore(sync): polish ${dirtyChapters[0]!.chapterKey} prose without state change`
            : hasFactualHeadOrNext
              ? `state(sync): sync ${dirtyChapters.map((d) => d.chapterKey).join(', ')} views`
              : `chore(sync): refresh ${dirtyChapters.map((d) => d.chapterKey).join(', ')} views`;
        await this.system.commitPaths(
            this.store.bookRoot,
            [...allManagedPaths, '.ops/tx_state.json'],
            commitMsg
        );
        await rm(join(this.store.bookRoot, '.ops/pending_writes.json'), { force: true });

        const updatedEntities = [...stagedEntities.keys()];

        if (prosePolishOnlySingle) {
            return {
                status: 'PROSE_POLISH_SYNCED',
                dirtyChapters,
                updatedEntities: [],
                downstreamConflicts: [],
                totalUsage
            };
        }

        if (historicalItems.length === 0) {
            return {
                status: 'STATE_SYNCED',
                dirtyChapters,
                updatedEntities,
                downstreamConflicts: [],
                totalUsage
            };
        }

        // Step 4：历史脏章触发的两级分批只读下游冲突扫描 + 双侧 verifyDualQuotes 验真
        const { conflicts, scanUsage } = await this.scanDownstreamConflicts({
            snapshot: workingSnapshot,
            historicalItems,
            stagedCards,
            retryOptions,
            signal: options.signal
        });
        addUsage(totalUsage, scanUsage);

        await mkdir(join(this.store.bookRoot, '.ops'), { recursive: true });
        await writeFile(
            join(this.store.bookRoot, '.ops/sync_conflicts.json'),
            `${JSON.stringify(
                {
                    updatedAt: new Date().toISOString(),
                    dirtyChapters: historicalItems.map((item) => item.dirty.chapterNumber),
                    conflicts
                },
                null,
                4
            )}\n`,
            'utf8'
        );

        return {
            status:
                conflicts.length > 0
                    ? 'DOWNSTREAM_CONFLICTS_FOUND'
                    : 'HISTORY_SYNCED_NO_CONFLICT',
            dirtyChapters,
            updatedEntities,
            downstreamConflicts: conflicts,
            ...(stateDiffAdvisories.length > 0 ? { stateDiffAdvisories } : {}),
            totalUsage
        };
    }

    private async buildReachableKeySet(
        pendingNewEntityIds: Set<string>,
        extraChapterKeys: string[]
    ): Promise<Set<string>> {
        const keys = new Set<string>([...pendingNewEntityIds, ...extraChapterKeys]);
        const collectMdIds = async (dirPath: string) => {
            try {
                const files = await readdir(dirPath);
                for (const file of files) {
                    if (!file.endsWith('.md')) continue;
                    const base = file.slice(0, -3);
                    keys.add(base);
                    const sagaMatch = /^((?:char|item)_[a-zA-Z0-9_]+?)_saga_\d+$/.exec(base);
                    if (sagaMatch?.[1]) {
                        keys.add(sagaMatch[1]);
                    }
                }
            } catch (err: unknown) {
                if ((err as { code?: string }).code !== 'ENOENT') throw err;
            }
        };

        await Promise.all([
            collectMdIds(join(this.store.bookRoot, 'entities')),
            collectMdIds(join(this.store.bookRoot, 'entities/cold_archive')),
            collectMdIds(join(this.store.bookRoot, 'manuscripts'))
        ]);
        return keys;
    }

    private assertForeignKeysReachable(
        sourceEntityId: string,
        content: string,
        reachableKeys: Set<string>
    ): void {
        const missing = new Set<string>();
        for (const match of content.matchAll(/\b(char_[a-zA-Z0-9_]+|item_[a-zA-Z0-9_]+|ch_\d{4})\b/g)) {
            const refId = match[1];
            if (refId && !reachableKeys.has(refId)) {
                missing.add(refId);
            }
        }
        if (missing.size > 0) {
            throw new ForeignKeyError([...missing], sourceEntityId);
        }
    }

    private async assertNoOpenParallelConflict(dirtyChapters: DirtyChapter[]): Promise<void> {
        const deltasDir = join(this.store.bookRoot, '.ops/parallel_deltas');
        let entries;
        try {
            entries = await readdir(deltasDir, { withFileTypes: true });
        } catch (err: unknown) {
            if ((err as { code?: string }).code === 'ENOENT') return;
            throw err;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const raw = await readOptionalText(join(deltasDir, entry.name, 'window.json'));
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as { status?: string; baseChapter?: number };
                if (parsed.status === 'OPEN') {
                    const baseCh = parsed.baseChapter ?? 0;
                    if (dirtyChapters.some((d) => d.chapterNumber <= baseCh || baseCh === 0)) {
                        throw new ValidationError(
                            `并行窗口 ${entry.name} 处于活跃 OPEN 状态，禁止修改并同步主线章节`
                        );
                    }
                }
            } catch (err: unknown) {
                if (err instanceof ValidationError) throw err;
            }
        }
    }

    private async loadVolumeResolutionContext(currentVolume: number): Promise<{
        currentVolume: number;
        l2ChapterToVolume: Map<number, number>;
        l1Ranges: Array<{ volumeNumber: number; startChapter: number; endChapter: number }>;
    }> {
        const l2ChapterToVolume = new Map<number, number>();
        const cardsDir = join(this.store.bookRoot, 'index/L2_cards');
        try {
            const cardFiles = (await readdir(cardsDir)).filter((f) => VOLUME_CARD_FILE_RE.test(f)).sort();
            for (const file of cardFiles) {
                const match = VOLUME_CARD_FILE_RE.exec(file);
                if (!match?.[1]) continue;
                const volNum = Number(match[1]);
                const raw = await readOptionalText(join(cardsDir, file));
                if (!raw) continue;
                const parsed = parseL2CardSections(raw);
                for (const section of parsed.sections) {
                    if (!l2ChapterToVolume.has(section.chapterNumber)) {
                        l2ChapterToVolume.set(section.chapterNumber, volNum);
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') throw err;
        }

        const l1Raw = (await readOptionalText(join(this.store.bookRoot, 'index/L1_volumes.md'))) ?? '';
        const l1Ranges = extractL1VolumeChapterRanges(l1Raw);

        return { currentVolume, l2ChapterToVolume, l1Ranges };
    }

    private resolveVolumeForChapter(
        chapterNumber: number,
        ctx: {
            currentVolume: number;
            l2ChapterToVolume: Map<number, number>;
            l1Ranges: Array<{ volumeNumber: number; startChapter: number; endChapter: number }>;
        }
    ): number {
        const fromL2 = ctx.l2ChapterToVolume.get(chapterNumber);
        if (fromL2 !== undefined) {
            return fromL2;
        }
        const fromL1 = ctx.l1Ranges.find(
            (r) => chapterNumber >= r.startChapter && chapterNumber <= r.endChapter
        );
        if (fromL1) {
            return fromL1.volumeNumber;
        }
        return ctx.currentVolume;
    }

    private async readStagedOrDiskCard(
        cardRelPath: string,
        stagedCards: Map<string, string>
    ): Promise<string | null> {
        const staged = stagedCards.get(cardRelPath);
        if (staged !== undefined) {
            return staged;
        }
        return await readOptionalText(join(this.store.bookRoot, cardRelPath));
    }

    private findExistingCardStoryDay(
        cardContent: string | null,
        chapterNumber: number,
        fallbackDay: number
    ): number {
        if (!cardContent) return fallbackDay;
        const parsed = parseL2CardSections(cardContent);
        const section = parsed.sections.find((s) => s.chapterNumber === chapterNumber);
        if (!section) return fallbackDay;
        const m = /^day:(-?\d+)$/.exec(section.dayLabel);
        if (m?.[1]) {
            const day = Number(m[1]);
            if (Number.isInteger(day)) return day;
        }
        return fallbackDay;
    }

    private async runExtractorForChapter(params: {
        snapshot: BookSnapshot;
        chapterNumber: number;
        timelineMode: TimelineMode;
        targetDay: number;
        povCharIds: string[];
        diffText: string;
        currentText: string;
        isHistorical: boolean;
        retryOptions: StructuredRetryOptions;
        signal?: AbortSignal | undefined;
    }): Promise<{ output: ExtractorOutput; usage: TokenUsage }> {
        const {
            snapshot,
            chapterNumber,
            timelineMode,
            targetDay,
            povCharIds,
            diffText,
            currentText,
            isHistorical,
            retryOptions,
            signal
        } = params;

        const allEntityIds = Object.keys(snapshot.entities);
        const fullThreshold =
            snapshot.config.retrieval?.extractor_full_entity_threshold ??
            DEFAULT_EXTRACTOR_FULL_ENTITY_THRESHOLD;

        let targetEntityIds: string[];
        let catalogNotice = '';
        if (allEntityIds.length <= fullThreshold) {
            targetEntityIds = allEntityIds;
        } else {
            const matchedSet = new Set<string>(povCharIds);
            const corpus = `${diffText}\n${currentText}`;
            for (const [id, profile] of Object.entries(snapshot.entities)) {
                const terms = [
                    id,
                    profile.metadata.canonical_name,
                    ...profile.metadata.unique_aliases,
                    ...profile.metadata.contextual_titles
                ].filter((t) => t.trim().length > 0);
                if (terms.some((t) => corpus.includes(t))) {
                    matchedSet.add(id);
                }
            }
            targetEntityIds = [...matchedSet];
            const omitted = allEntityIds
                .filter((id) => !matchedSet.has(id))
                .map((id) => `${id}: ${snapshot.entities[id]?.metadata.canonical_name ?? id}`);
            if (omitted.length > 0) {
                catalogNotice = `\n\n## 其余活跃实体目录（按需读取）\n${omitted.join('\n')}`;
            }
        }

        const extractorView = this.slicer.slice({
            snapshot,
            forRole: 'extractor',
            targetDay,
            currentCh: chapterNumber,
            timelineMode,
            povCharId: povCharIds,
            entityIds: targetEntityIds
        });
        const entitySummary = Object.values(extractorView.entities)
            .map((p) => serializeEntityMarkdown(p))
            .join('\n\n');

        const promptModeHint = isHistorical
            ? '当前为历史旧章增量刷新：请着重抽取双轨 L2 章卡所需 plot_summary、prose_anchors（正文原词）与 appeared_entity_ids，并报告任何设定/状态变更差异。'
            : `当前为第 ${chapterNumber} 章最新定稿状态同步 (mode=${timelineMode}, story_day=${targetDay})：请抽取实体增量补丁、story_day_delta、双轨章卡字段及 next_chapter_options。`;

        const dynamicPrompt = [
            `## 当前实体档案视图\n${entitySummary || '(暂无实体)'}${catalogNotice}`,
            `## 第 ${chapterNumber} 章修改差异\n${diffText}`,
            `## 修改后完整章节\n${currentText}`,
            promptModeHint
        ].join('\n\n');

        if (this.roleRunner) {
            const res = await this.roleRunner.runMultiTurn<YieldStatePatchResult>({
                roleId: 'extractor',
                stage: isHistorical ? 'SYNC_HISTORY_EXTRACTOR' : 'SYNC_EXTRACTOR',
                chapterNumber,
                bookRoot: this.store.bookRoot,
                bookConfig: snapshot.config,
                timelineMode,
                deferCommit: true,
                draftText: currentText,
                visibleEntities: snapshot.entities,
                taskPrompt: `${dynamicPrompt}\n\n请调用 \`yield_state_patch\` 提交抽取结果。`,
                signal
            });
            return { output: res.yieldResult.output, usage: res.usage };
        }

        const extracted = await generateStructuredJson(
            this.llm,
            {
                pool: 'fast_retrieval',
                traceStage: isHistorical ? 'sync.history_extractor' : 'sync.extractor',
                staticPrefixBlocks: [
                    '你是手稿增量状态抽取器 (Sync Extractor)。请根据修订后的手稿与差异，输出实体增量补丁、双轨 L2 章卡字段（plot_summary、prose_anchors、appeared_entity_ids）与摘要 JSON。'
                ],
                dynamicTail: dynamicPrompt
            },
            buildExtractorSchema(snapshot),
            retryOptions,
            signal
        );
        return {
            output: ExtractorOutputSchema.parse(extracted.data),
            usage: extracted.totalUsage
        };
    }

    private async scanDownstreamConflicts(params: {
        snapshot: BookSnapshot;
        historicalItems: HistoricalDirtyItem[];
        stagedCards: Map<string, string>;
        retryOptions: StructuredRetryOptions;
        signal?: AbortSignal | undefined;
    }): Promise<{ conflicts: DownstreamConflictReport[]; scanUsage: TokenUsage }> {
        const { snapshot, historicalItems, stagedCards, retryOptions, signal } = params;
        const scanUsage = createEmptyUsage();
        const minDirtyChapter = Math.min(...historicalItems.map((item) => item.dirty.chapterNumber));

        const manuscriptsDir = join(this.store.bookRoot, 'manuscripts');
        let allFiles: string[] = [];
        try {
            allFiles = (await readdir(manuscriptsDir))
                .filter((f) => CHAPTER_FILE_RE.test(f))
                .sort();
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') throw err;
        }

        const downstreamChapters: DownstreamChapterData[] = [];
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
            return { conflicts: [], scanUsage };
        }

        // 1. 提取历史脏章 HEAD vs 当前文本涉事实体（含冷宫历史实体）与锚点关键词，经 IndexRecall 筛选相关下游章节
        const allCorpus = historicalItems
            .map((item) => [item.diffText, item.headText ?? '', item.currentText].join('\n'))
            .join('\n');
        const diffKeywords = new Set<string>();
        for (const item of historicalItems) {
            for (const kw of extractDiffKeywords(item.diffText)) {
                diffKeywords.add(kw);
            }
            for (const anchor of item.extracted.prose_anchors) {
                if (anchor.trim().length >= 2) diffKeywords.add(anchor.trim());
            }
        }

        const coldEntities =
            snapshot.coldArchiveIds.length > 0
                ? await this.store.readColdArchivedEntities(snapshot.coldArchiveIds)
                : {};
        const combinedEntities: Record<string, EntityProfile> = {
            ...coldEntities,
            ...snapshot.entities
        };

        const matchedEntities: EntityProfile[] = [];
        const matchedEntityIds = new Set<string>();
        for (const [id, profile] of Object.entries(combinedEntities)) {
            const names = [
                id,
                profile.metadata.canonical_name,
                ...profile.metadata.unique_aliases,
                ...profile.metadata.contextual_titles
            ].filter((s) => s.trim().length > 0);
            if (names.some((name) => allCorpus.includes(name))) {
                matchedEntities.push(profile);
                matchedEntityIds.add(id);
            }
        }

        const downstreamFiles = downstreamChapters.map((c) => c.relativePath);
        const maxDownstreamCh = Math.max(...downstreamChapters.map((c) => c.chapterNumber));
        const relevantChapterSet = new Set<number>();

        const keywordList = [...diffKeywords];
        for (const profile of matchedEntities) {
            const slices = await this.indexRecall.recallEntitySlices(this.store.bookRoot, {
                profile,
                targetChapter: maxDownstreamCh,
                targetDay: snapshot.worldState.frontmatter.story_day,
                chapterFiles: downstreamFiles,
                extraKeywords: keywordList,
                includeHistoricalAnchors: true
            });
            for (const slice of slices) {
                relevantChapterSet.add(slice.chapterNumber);
            }
        }

        // 结合 L2 章卡与变更词检索补齐无实体卡纯物件/场景修改的关联章节
        const l2SectionMap = new Map<number, string>();
        const cardsDir = join(this.store.bookRoot, 'index/L2_cards');
        const stagingOverlay = new Map<string, string | null>(stagedCards);
        try {
            const cardFiles = (await readdir(cardsDir)).filter((f) => VOLUME_CARD_FILE_RE.test(f)).sort();
            for (const file of cardFiles) {
                const relPath = `index/L2_cards/${file}`;
                const raw = stagingOverlay.get(relPath) ?? (await readOptionalText(join(cardsDir, file)));
                if (!raw) continue;
                const parsed = parseL2CardSections(raw);
                for (const section of parsed.sections) {
                    if (section.chapterNumber <= minDirtyChapter) continue;
                    l2SectionMap.set(
                        section.chapterNumber,
                        `- ${section.chapterId} (${section.dayLabel}): ${section.plotSummary}`
                    );
                    if (
                        section.appearedEntityIds.some((id) => matchedEntityIds.has(id)) ||
                        keywordList.some(
                            (kw) =>
                                section.plotSummary.includes(kw) ||
                                section.anomalyAnchors.some((a) => a.includes(kw))
                        )
                    ) {
                        relevantChapterSet.add(section.chapterNumber);
                    }
                }
            }
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') throw err;
        }

        if (relevantChapterSet.size === 0 && keywordList.length > 0) {
            for (const ch of downstreamChapters) {
                if (keywordList.some((kw) => ch.text.includes(kw))) {
                    relevantChapterSet.add(ch.chapterNumber);
                }
            }
        }

        const candidateDownstream =
            relevantChapterSet.size > 0
                ? downstreamChapters.filter((ch) => relevantChapterSet.has(ch.chapterNumber))
                : downstreamChapters;

        const nonHitSummaries = downstreamChapters
            .filter((ch) => !candidateDownstream.some((c) => c.chapterNumber === ch.chapterNumber))
            .map((ch) => l2SectionMap.get(ch.chapterNumber))
            .filter((s): s is string => Boolean(s));

        const editedContext = historicalItems
            .map((item) => {
                const numberedCurrent = item.currentText
                    .split(/\r?\n/)
                    .map((line, idx) => `L${idx + 1}: ${line}`)
                    .join('\n');
                return [
                    `### ${item.dirty.chapterKey} (历史修改章号=${item.dirty.chapterNumber})`,
                    `#### 修订差异\n${item.diffText}`,
                    `#### 修改后原文（供摘取 dirty_quote）\n${numberedCurrent}`
                ].join('\n\n');
            })
            .join('\n\n');

        // 2. 按 config.ops_and_sync.conflict_scan_batch_chars 分批扫描候选下游章节
        const batchCharBudget =
            snapshot.config.ops_and_sync?.conflict_scan_batch_chars ??
            DEFAULT_CONFLICT_SCAN_BATCH_CHARS;
        const formattedCandidates = candidateDownstream.map((ch) => {
            const lines = ch.text
                .split(/\r?\n/)
                .map((line, idx) => `L${idx + 1}: ${line}`)
                .join('\n');
            return {
                chapterNumber: ch.chapterNumber,
                block: `### ${formatChapterKey(ch.chapterNumber)} (${ch.relativePath})\n${lines}`
            };
        });

        const batches: Array<{ chapterNumbers: Set<number>; blocks: string[] }> = [];
        let currentBatch: { chapterNumbers: Set<number>; blocks: string[] } = {
            chapterNumbers: new Set<number>(),
            blocks: []
        };
        let currentBatchChars = 0;
        for (const item of formattedCandidates) {
            const len = item.block.length;
            if (currentBatch.blocks.length > 0 && currentBatchChars + len > batchCharBudget) {
                batches.push(currentBatch);
                currentBatch = { chapterNumbers: new Set<number>(), blocks: [] };
                currentBatchChars = 0;
            }
            currentBatch.chapterNumbers.add(item.chapterNumber);
            currentBatch.blocks.push(item.block);
            currentBatchChars += len;
        }
        if (currentBatch.blocks.length > 0) {
            batches.push(currentBatch);
        }

        const downstreamMap = new Map(downstreamChapters.map((c) => [c.chapterNumber, c]));
        const historicalMap = new Map(historicalItems.map((h) => [h.dirty.chapterNumber, h]));
        const conflicts: DownstreamConflictReport[] = [];

        for (const batch of batches) {
            const scanRes = await generateStructuredJson(
                this.llm,
                {
                    pool: 'audit',
                    traceStage: 'sync.audit',
                    staticPrefixBlocks: [
                        '你是只读连续性冲突扫描器。历史旧章已被作者修订，请扫描下游已归档章节是否存在与旧章修订内容冲突之处，精确标出 dirty_chapter、dirty_quote（历史脏章原文原句）、chapter_number、line_number、quote（下游章节原文原句）与 description。严禁建议自动修改下游正文。'
                    ],
                    dynamicTail: [
                        editedContext,
                        ...(nonHitSummaries.length > 0
                            ? [`## 未命中其余下游章 L2 摘要\n${nonHitSummaries.join('\n')}`]
                            : []),
                        '## 本批次下游已归档章节（只读扫描）',
                        batch.blocks.join('\n\n')
                    ].join('\n\n')
                },
                DownstreamScanOutputSchema,
                retryOptions,
                signal
            );
            addUsage(scanUsage, scanRes.totalUsage);

            // 3. 双侧 verifyDualQuotes 去标点验真（拦截单侧或双侧幻觉引文）
            for (const item of scanRes.data.conflicts ?? []) {
                if (!batch.chapterNumbers.has(item.chapter_number)) continue;
                const target = downstreamMap.get(item.chapter_number);
                if (!target) continue;

                const downstreamQuote = (item.quote ?? '').trim();
                const dirtyQuote = (item.dirty_quote ?? '').trim();
                if (downstreamQuote.length === 0 || dirtyQuote.length === 0) {
                    continue;
                }

                const dirtyCandidate =
                    item.dirty_chapter !== undefined
                        ? historicalMap.get(item.dirty_chapter)
                        : historicalItems.length === 1
                          ? historicalItems[0]
                          : historicalItems.find(
                                (h) =>
                                    h.dirty.chapterNumber < item.chapter_number &&
                                    verifyDualQuotes(
                                        dirtyQuote,
                                        h.currentText,
                                        downstreamQuote,
                                        target.text
                                    ).passed
                            );
                if (!dirtyCandidate || dirtyCandidate.dirty.chapterNumber >= item.chapter_number) {
                    continue;
                }

                const verdict = verifyDualQuotes(
                    dirtyQuote,
                    dirtyCandidate.currentText,
                    downstreamQuote,
                    target.text
                );
                if (!verdict.passed) {
                    continue;
                }

                conflicts.push({
                    chapterNumber: item.chapter_number,
                    relativePath: target.relativePath,
                    lineNumber: verdict.sideB.lineNumber ?? item.line_number ?? null,
                    quote: downstreamQuote,
                    description: item.description,
                    dirtyChapter: dirtyCandidate.dirty.chapterNumber,
                    dirtyLineNumber: verdict.sideA.lineNumber ?? null,
                    dirtyQuote
                });
            }
        }

        return { conflicts, scanUsage };
    }

    private async computeChapterDiffText(dirty: DirtyChapter): Promise<{
        diffText: string;
        currentText: string;
        headText: string | null;
    }> {
        const currentText = await readFile(join(this.store.bookRoot, dirty.relativePath), 'utf8');
        const headText = await this.system.readFileAtRef(
            this.store.bookRoot,
            'HEAD',
            dirty.relativePath
        );
        if (headText === null) {
            return { diffText: currentText, currentText, headText: null };
        }

        if (headText === currentText) {
            try {
                const gitDiff = await this.system.diffFile(
                    this.store.bookRoot,
                    'HEAD~1',
                    'HEAD',
                    dirty.relativePath
                );
                if (gitDiff.trim().length > 0) {
                    return { diffText: gitDiff, currentText, headText };
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
            currentText,
            headText
        };
    }
}

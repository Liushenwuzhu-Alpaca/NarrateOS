import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    generateStructuredJson,
    serializeEntityMarkdown,
    TxStateSchema,
    verifyDualQuotes,
    ViewSlicer,
    withTraceRun,
    type BookSnapshot,
    type BookStore,
    type DirtyChapter,
    type EntityPatch,
    type LlmPort,
    type StructuredRetryOptions,
    type SystemPort
} from '@narrateos/dsh-book-store';
import { ExtractorOutputSchema } from '@narrateos/dsh-book-tools';
import { z } from 'zod';
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
    sha256Hex
} from './helpers.js';

export interface SyncPipelineDeps {
    store: BookStore;
    llm: LlmPort;
    system: SystemPort;
    slicer?: ViewSlicer | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
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

/**
 * 手稿真源增量同步 (Sync) 管线：
 * - 最新章纯修辞润色：零重抽，仅刷新 sha256；
 * - 最新章涉及实体/事实变动：增量调用 Extractor 并提交 state(sync)；
 * - 历史旧章手改：刷新该章指纹并对下游已归档章节执行只读连续性冲突扫描（严禁改写下游手稿）。
 */
export class SyncPipeline {
    private readonly store: BookStore;
    private readonly llm: LlmPort;
    private readonly system: SystemPort;
    private readonly slicer: ViewSlicer;
    private readonly retryOptions: StructuredRetryOptions | undefined;

    constructor(deps: SyncPipelineDeps) {
        this.store = deps.store;
        this.llm = deps.llm;
        this.system = deps.system;
        this.slicer = deps.slicer ?? new ViewSlicer();
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
        if ((await this.store.readWorldState()).frontmatter.timeline_mode === 'PARALLEL') {
            throw new Error('并行窗口合并前不能执行主线 Sync');
        }

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
        const retryOptions: StructuredRetryOptions = this.retryOptions ?? {
            maxRetries: snapshot.config.structured_json_retry.max_retries,
            backoffMs: snapshot.config.structured_json_retry.backoff_ms
        };
        const lastCommitted = snapshot.txState.last_committed_ch;

        // 情况 A：仅最新已提交章发生手改
        if (
            dirtyChapters.length === 1 &&
            dirtyChapters[0]?.chapterNumber === lastCommitted &&
            dirtyChapters[0].reason === 'MODIFIED'
        ) {
            const dirty = dirtyChapters[0];
            const { diffText, currentText } = await this.computeChapterDiffText(dirty);

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

            const extracted = await generateStructuredJson(
                this.llm,
                {
                    pool: 'fast_retrieval',
                    traceStage: 'sync.extractor',
                    staticPrefixBlocks: [
                        '你是手稿增量状态抽取器 (Sync Extractor)。请根据最新修订的手稿与差异，输出实体增量补丁与摘要 JSON。'
                    ],
                    dynamicTail: [
                        `## 当前实体档案视图\n${entitySummary || '(暂无实体)'}`,
                        `## 修改差异\n${diffText}`,
                        `## 修改后完整章节\n${currentText}`
                    ].join('\n\n')
                },
                buildExtractorSchema(snapshot),
                retryOptions,
                options.signal
            );
            addUsage(totalUsage, extracted.totalUsage);

            await this.store.commitDraft(dirty.chapterNumber, currentText);
            const patchRes = await this.store.applyStatePatch(
                dirty.chapterNumber,
                sanitizeExtractorPatches(
                    snapshot,
                    extracted.data.entity_patches as EntityPatch[]
                )
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

        const manuscriptsDir = join(this.store.bookRoot, 'manuscripts');
        const allFiles = (await readdir(manuscriptsDir))
            .filter((f) => CHAPTER_FILE_RE.test(f))
            .sort();
        const downstreamChapters: Array<{
            chapterNumber: number;
            relativePath: string;
            text: string;
        }> = [];

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

        const scanRes = await generateStructuredJson(
            this.llm,
            {
                pool: 'audit',
                traceStage: 'sync.audit',
                staticPrefixBlocks: [
                    '你是只读连续性冲突扫描器。历史旧章已被作者修订，请扫描下游已归档章节是否存在与旧章修订内容冲突之处，精确标出章号、行号与原句。严禁建议自动修改下游正文。'
                ],
                dynamicTail: [
                    editedSummaries.join('\n\n'),
                    '## 下游已归档章节（只读扫描）',
                    numberedDownstream
                ].join('\n\n')
            },
            DownstreamScanOutputSchema,
            retryOptions,
            options.signal
        );
        addUsage(totalUsage, scanRes.totalUsage);

        const downstreamMap = new Map(downstreamChapters.map((c) => [c.chapterNumber, c]));
        const conflicts: DownstreamConflictReport[] = [];

        for (const item of scanRes.data.conflicts ?? []) {
            const target = downstreamMap.get(item.chapter_number);
            if (!target) continue;

            const quote = item.quote ?? '';
            let resolvedLine: number | null = item.line_number ?? null;
            if (quote.trim().length > 0) {
                const verdict = verifyDualQuotes(
                    quote,
                    target.text,
                    quote,
                    target.text
                );
                if (!verdict.passed) {
                    continue;
                }
                resolvedLine = verdict.sideA.lineNumber ?? resolvedLine;
            }

            conflicts.push({
                chapterNumber: item.chapter_number,
                relativePath: target.relativePath,
                lineNumber: resolvedLine,
                quote,
                description: item.description
            });
        }

        return {
            status:
                conflicts.length > 0
                    ? 'DOWNSTREAM_CONFLICTS_FOUND'
                    : 'HISTORY_SYNCED_NO_CONFLICT',
            dirtyChapters,
            updatedEntities: [],
            downstreamConflicts: conflicts,
            totalUsage
        };
    }

    private async refreshChapterHashAndCommit(
        dirty: DirtyChapter,
        commitMessage: string
    ): Promise<void> {
        await this.store.runWithTxLock(async () => {
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

    private async computeChapterDiffText(dirty: DirtyChapter): Promise<{
        diffText: string;
        currentText: string;
    }> {
        const currentText = await readFile(join(this.store.bookRoot, dirty.relativePath), 'utf8');
        const headText = await this.system.readFileAtRef(
            this.store.bookRoot,
            'HEAD',
            dirty.relativePath
        );
        if (headText === null) {
            return { diffText: currentText, currentText };
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
}

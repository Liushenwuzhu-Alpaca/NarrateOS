import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    generateStructuredJson,
    isWarpedEntry,
    parseEntityMarkdown,
    sanitizeLoreForWriter,
    withTraceRun,
    type BookStore,
    type EntityProfile,
    type LlmPort,
    type StructuredRetryOptions,
    type SystemPort
} from '@narrateos/dsh-book-store';
import { ValidationError } from '../errors.js';
import {
    NextVolumeEnvelopeOutputSchema,
    StyleMergeOutputSchema,
    VolumeSealOutputSchema,
    type AdvanceVolumeOptions,
    type AdvanceVolumeResult
} from '../schemas.js';
import {
    formatVolumeCardRelPath,
    listOpenParallelWindows,
    readCombinedStyleAmendments,
    readOptionalText
} from './helpers.js';

const DEFAULT_STATIC_BASE_MAX_CHARS = 1500;
const DEFAULT_SAGA_FOLD_VOLUME_INTERVAL = 10;
const ENTITY_FILE_RE = /^((?:char|item)_[a-zA-Z0-9_]+)\.md$/;
const NEGATIVE_PROHIBITION_RE =
    /(?:禁止|严禁|禁用|不要|不得|切忌|绝不|决不|不能|不可|切勿|莫要)/;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LIST_ITEM_START_RE = /^\s*(?:[-*+]|\d+\.)\s/;
const TOP_LEVEL_LIST_ITEM_RE = /^(?:[-*+]|\d+\.)\s/;
const LIST_CONTINUATION_RE = /^(?:\s+\S|>)/;
const SEAL_RECEIPT = 'index/volume_seal.json';
const SealReceipt = z.object({ id: z.string().uuid(), sealedVolume: z.number().int().positive(), nextVolume: z.number().int().positive(), archivedEntities: z.array(z.string()), completedBook: z.boolean() });
const RESOLVED_SECTION = /^##\s+.*(?:Resolved|Archive|已回收|已解决|已兑现|归档)/i;
const CLOSED_THREAD = /(?:status:\s*(?:OPEN_ENDING|RESOLVED|ARCHIVED)|\[(?:RESOLVED|ARCHIVED)\]|^\s*-\s+\[x\])/i;

/** 按顶层条目保留原文与续行，标题只控制其后的归档区语义。 */
function ledgerBlocks(markdown: string): Array<{ text: string; isEntry: boolean; archived: boolean }> {
    let archivedLevel: number | null = null;
    return markdown.split(/(?=^(?:#{1,6}\s|(?:[-*+]|\d+\.)\s))/m).map((text) => {
        const heading = /^(#{1,6})\s+([^\n]*)/.exec(text);
        if (heading) {
            const level = heading[1]!.length;
            if (archivedLevel !== null && level <= archivedLevel) archivedLevel = null;
            if (/(?:Resolved|Archive|WARPED|已回收|已解决|已兑现|归档)/i.test(heading[2]!)) {
                archivedLevel ??= level;
            }
        }
        return { text, isEntry: /^(?:[-*+]|\d+\.)\s/.test(text), archived: archivedLevel !== null };
    });
}

/** 只让未结、未作废条目参与下一卷实体保留，续行与父条目同进退。 */
function activeLedgerText(markdown: string): string {
    return ledgerBlocks(markdown)
        .filter((block) => block.isEntry && !block.archived &&
            !CLOSED_THREAD.test(block.text) && !/\bWARPED\b/i.test(block.text))
        .map((block) => block.text).join('\n');
}

export interface VolumePipelineDeps {
    store: BookStore;
    llm: LlmPort;
    system: SystemPort;
    retryOptions?: StructuredRetryOptions | undefined;
}

/** 将 open_threads.md 中仍处于活跃区的未解伏笔标记为 [status: OPEN_ENDING] */
function markOpenThreadsAsOpenEnding(markdown: string): string {
    const lines = markdown.split(/\r?\n/);
    let inResolvedSection = false;
    const out = lines.map((line) => {
        if (RESOLVED_SECTION.test(line.trim())) {
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
        if (CLOSED_THREAD.test(line)) return line;
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

/** 统计 open_threads.md 中仍活跃的伏笔条数 */
function countActiveThreads(markdown: string): number {
    if (!markdown.trim()) return 0;
    let inResolved = false;
    let count = 0;
    for (const rawLine of markdown.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (RESOLVED_SECTION.test(line)) {
            inResolved = true;
            continue;
        }
        if (/^##\s+/.test(line)) {
            inResolved = false;
            continue;
        }
        if (!inResolved && line.startsWith('- ') && !CLOSED_THREAD.test(line)) {
            count += 1;
        }
    }
    return count;
}

/** 块级剥离包含否定禁令词的标题节、完整列表项（含缩进与 > 续行）及自然段 */
function stripNegativeProhibitionBlocks(raw: string): string {
    const lines = raw.split(/\r?\n/);
    const kept: string[] = [];
    let skipSectionLevel: number | null = null;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trim();
        const headingMatch = MARKDOWN_HEADING_RE.exec(trimmed);

        if (skipSectionLevel !== null) {
            if (headingMatch?.[1]) {
                const level = headingMatch[1].length;
                if (level <= skipSectionLevel) {
                    skipSectionLevel = null;
                } else {
                    i += 1;
                    continue;
                }
            } else {
                i += 1;
                continue;
            }
        }

        if (headingMatch?.[1]) {
            if (NEGATIVE_PROHIBITION_RE.test(line)) {
                skipSectionLevel = headingMatch[1].length;
                i += 1;
                continue;
            }
            kept.push(line);
            i += 1;
            continue;
        }

        if (trimmed.length === 0) {
            kept.push(line);
            i += 1;
            continue;
        }

        if (LIST_ITEM_START_RE.test(line)) {
            let j = i + 1;
            while (j < lines.length) {
                const next = lines[j]!;
                const nextTrimmed = next.trim();
                if (nextTrimmed.length === 0) break;
                if (MARKDOWN_HEADING_RE.test(nextTrimmed)) break;
                if (TOP_LEVEL_LIST_ITEM_RE.test(next)) break;
                if (LIST_CONTINUATION_RE.test(next)) {
                    j += 1;
                    continue;
                }
                break;
            }
            const block = lines.slice(i, j);
            if (!block.some((b) => NEGATIVE_PROHIBITION_RE.test(b))) {
                kept.push(...block);
            }
            i = j;
            continue;
        }

        let j = i + 1;
        while (j < lines.length) {
            const next = lines[j]!;
            const nextTrimmed = next.trim();
            if (nextTrimmed.length === 0) break;
            if (MARKDOWN_HEADING_RE.test(nextTrimmed)) break;
            if (LIST_ITEM_START_RE.test(next)) break;
            j += 1;
        }
        const block = lines.slice(i, j);
        if (!block.some((b) => NEGATIVE_PROHIBITION_RE.test(b))) {
            kept.push(...block);
        }
        i = j;
    }

    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 对写手可见的正向卷纲做块级净室清洗：整块剥离 WARPED / Stage Ceiling / 机密标签及否定禁令 */
function sanitizeArcEnvelopeForCleanroom(rawEnvelope: string, nextVolume: number): string {
    const loreCleaned = sanitizeLoreForWriter(rawEnvelope);
    const clean = stripNegativeProhibitionBlocks(loreCleaned);
    if (clean.length === 0) {
        return `# 第 ${nextVolume} 卷正向舞台\n`;
    }
    return `${clean}\n`;
}

/** 从 L1_volumes.md 提取指定卷区间汇总并折叠追加至 index/L0_sagas.md */
function appendEpochFoldToL0Sagas(params: {
    currentL0: string;
    updatedL1: string;
    openThreadsText: string;
    sealedVolume: number;
    sagaInterval: number;
    completeBook: boolean;
    fallbackSummary: string;
}): string {
    const {
        currentL0,
        updatedL1,
        openThreadsText,
        sealedVolume,
        sagaInterval,
        completeBook,
        fallbackSummary
    } = params;

    const epochIndex = Math.ceil(sealedVolume / sagaInterval);
    const epochStartVol = (epochIndex - 1) * sagaInterval + 1;
    const startPad = String(epochStartVol).padStart(2, '0');
    const endPad = String(sealedVolume).padStart(2, '0');
    const rangeLabel =
        epochStartVol === sealedVolume ? `vol_${endPad}` : `vol_${startPad} - vol_${endPad}`;
    const heading = `## 第 ${epochIndex} 纪元封存摘要 (${rangeLabel})${completeBook ? ' [完结收官]' : ''}`;

    const baseL0 =
        currentL0.trim().length > 0 ? currentL0.trimEnd() : '# L0 纪元折叠总表';
    if (baseL0.includes(heading)) {
        return `${baseL0}\n`;
    }

    const sectionRe = /^##\s+第\s*(\d+)\s*卷[^\n]*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm;
    const volumeBullets: string[] = [];
    let match: RegExpExecArray | null = sectionRe.exec(updatedL1);
    while (match !== null) {
        const volNum = Number(match[1]);
        const body = (match[2] ?? '').trim().replace(/\s+/g, ' ');
        if (volNum >= epochStartVol && volNum <= sealedVolume && body.length > 0) {
            volumeBullets.push(`  - 第 ${volNum} 卷：${body}`);
        }
        match = sectionRe.exec(updatedL1);
    }

    if (volumeBullets.length === 0) {
        volumeBullets.push(`  - 第 ${sealedVolume} 卷：${fallbackSummary.trim()}`);
    }

    const activeThreadsCount = countActiveThreads(openThreadsText);
    const epochBlock = [
        heading,
        '- 卷级收束汇总：',
        ...volumeBullets,
        `- 跨纪元保留活跃伏笔：${activeThreadsCount} 条`
    ].join('\n');

    return `${baseL0}\n\n${epochBlock}\n`;
}

/**
 * 五步原子换卷或全书完结封笔管线 (advanceVolume)
 */
export class VolumePipeline {
    private readonly store: BookStore;
    private readonly llm: LlmPort;
    private readonly system: SystemPort;
    private readonly retryOptions: StructuredRetryOptions | undefined;

    constructor(deps: VolumePipelineDeps) {
        this.store = deps.store;
        this.llm = deps.llm;
        this.system = deps.system;
        this.retryOptions = deps.retryOptions;
    }

    async advanceVolume(
        options: AdvanceVolumeOptions = {}
    ): Promise<AdvanceVolumeResult> {
        return await withTraceRun(this.store.bookRoot, 'advance-volume', {}, () =>
            this.store.withTxLock(async () => {
                await this.store.assertDreamingPhaseSafe();
                const previous = await this.system.readFileAtRef(this.store.bookRoot, 'HEAD', SEAL_RECEIPT);
                if (previous !== null) {
                    const receipt = SealReceipt.parse(JSON.parse(previous));
                    const sha = await this.system.currentRevision(this.store.bookRoot, `HEAD^{/Seal-ID: ${receipt.id}}`);
                    if (await this.publishSeal(receipt, sha)) {
                        const { id: _, ...result } = receipt;
                        return { ...result, tagName: `arc-seal-vol-${String(result.sealedVolume).padStart(2, '0')}`, commitSha: sha };
                    }
                }
                const completeBook = Boolean(options.completeBook);
                const config = await this.store.readBookConfig();
                const retryOptions: StructuredRetryOptions = this.retryOptions ?? {
                    maxRetries: config.structured_json_retry.max_retries,
                    backoffMs: config.structured_json_retry.backoff_ms
                };
                const worldState = await this.store.readWorldState();
                if (worldState.frontmatter.timeline_mode === 'PARALLEL') {
                    throw new ValidationError('换卷前必须合并并行窗口');
                }
                await this.assertNoOpenParallelWindow();

                const staticBaseMaxChars =
                    config.context_assembly?.static_base_max_chars ?? DEFAULT_STATIC_BASE_MAX_CHARS;
                const sagaFoldInterval =
                    config.dreaming?.saga_fold_volume_interval ?? DEFAULT_SAGA_FOLD_VOLUME_INTERVAL;

                const sealedVolume = worldState.frontmatter.current_volume;
                const nextVolume = completeBook ? sealedVolume : sealedVolume + 1;
                const sealedVolPad = String(sealedVolume).padStart(2, '0');
                const nextVolPad = String(nextVolume).padStart(2, '0');
                const tagName = `arc-seal-vol-${sealedVolPad}`;

                // =========================================================================
                // 阶段 A：纯内存读取与 LLM 编译校验（全部通过前零磁盘写、零 Git 提交）
                // =========================================================================
                const l1RelPath = 'index/L1_volumes.md';
                const l0RelPath = 'index/L0_sagas.md';
                const l1Path = join(this.store.bookRoot, l1RelPath);
                const l0Path = join(this.store.bookRoot, l0RelPath);
                const l1Current =
                    (await readOptionalText(l1Path)) ?? '# L1 活跃卷级总表\n\n';
                const sealedCardsPath = join(
                    this.store.bookRoot,
                    formatVolumeCardRelPath(sealedVolume)
                );
                const sealedCardsText = (await readOptionalText(sealedCardsPath)) ?? '';
                const threadsRelPath = 'world/open_threads.md';
                const openThreadsText =
                    (await readOptionalText(join(this.store.bookRoot, threadsRelPath))) ?? '';

                // Step 1: 封存旧卷 -> 编纂 L1_volumes.md 摘要，按周期或完结折叠 L0_sagas.md
                const sealRes = await generateStructuredJson(
                    this.llm,
                    {
                        pool: 'fast_retrieval',
                        traceStage: 'volume.seal',
                        staticPrefixBlocks: [
                            '你是长篇小说卷级归档编纂器。请根据当前卷章卡与卷级总表，输出本卷简明收束摘要 (volume_summary) 与故事日跨度 (story_day_span) JSON。'
                        ],
                        dynamicTail: [
                            `## 当前卷号\n第 ${sealedVolume} 卷 (当前 story_day: ${worldState.frontmatter.story_day})`,
                            `## index/L1_volumes.md\n${l1Current}`,
                            `## ${formatVolumeCardRelPath(sealedVolume)}\n${sealedCardsText || '(暂无章卡记录)'}`,
                            `## world/open_threads.md\n${openThreadsText || '(暂无)'}`
                        ].join('\n\n')
                    },
                    VolumeSealOutputSchema,
                    retryOptions,
                    options.signal
                );

                const sealBlock = [
                    `## 第 ${sealedVolume} 卷封存摘要 (vol_${sealedVolPad}) [story_day: ${sealRes.data.story_day_span}]`,
                    sealRes.data.volume_summary.trim()
                ].join('\n');
                let updatedL1Text = `${l1Current.trimEnd()}\n\n${sealBlock}\n`;

                const nextCardsRelPath = formatVolumeCardRelPath(nextVolume);
                const shouldCreateNextCards =
                    !completeBook &&
                    (await readOptionalText(join(this.store.bookRoot, nextCardsRelPath))) === null;

                // 编译前只读完整活跃档案，新卷因果确定后才计算冷归档集合。
                const companionIds = new Set<string>([
                    worldState.frontmatter.pov_character,
                    ...(options.companionEntityIds ?? [])
                ]);
                const entitiesDir = join(this.store.bookRoot, 'entities');
                const coldArchiveDir = join(entitiesDir, 'cold_archive');
                const entityDocuments: Array<{ fileName: string; profile: EntityProfile; raw: string }> = [];
                const entityFiles = await readdir(entitiesDir).catch((err: unknown) => {
                    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
                    throw err;
                });
                for (const fileName of entityFiles.sort()) {
                    if (!ENTITY_FILE_RE.test(fileName)) continue;
                    const raw = await readFile(join(entitiesDir, fileName), 'utf8');
                    entityDocuments.push({ fileName, raw, profile: parseEntityMarkdown(raw) });
                }

                // Step 3: 提炼风格修订 -> 合入 static_base_and_voice.md (<= static_base_max_chars)，禁止暴力硬截断
                const opsStyleRelPath = '.ops/style_amendments.md';
                const worldStyleRelPath = 'world/ops_style_amendments.md';
                const voiceBaseRelPath = 'world/static_base_and_voice.md';
                const {
                    combined: combinedAmendments,
                    opsRaw: opsStyleExisting,
                    worldRaw: worldStyleExisting
                } = await readCombinedStyleAmendments(this.store.bookRoot, {
                    order: 'ops-first',
                    dedupe: false
                });

                const nextVoiceBaseText = combinedAmendments
                    ? await this.refineStyleAmendments(
                          voiceBaseRelPath,
                          combinedAmendments,
                          staticBaseMaxChars,
                          retryOptions,
                          options.signal
                      )
                    : null;

                // Step 4: 纪元折叠 & 完结封笔 vs 新卷双文件包络编译
                const currentL0Text = (await readOptionalText(l0Path)) ?? '';
                const shouldFoldSaga =
                    sealedVolume % sagaFoldInterval === 0 || completeBook;
                let updatedL0Text = shouldFoldSaga
                    ? appendEpochFoldToL0Sagas({
                          currentL0: currentL0Text,
                          updatedL1: updatedL1Text,
                          openThreadsText,
                          sealedVolume,
                          sagaInterval: sagaFoldInterval,
                          completeBook,
                          fallbackSummary: sealRes.data.volume_summary
                      })
                    : null;

                let sealedThreadsText: string | null = null;
                let nextEnvelopeText: string | null = null;
                let nextDirectorPlanText: string | null = null;
                let nextFutureHorizonText: string | null = null;

                if (completeBook) {
                    if (openThreadsText.trim().length > 0) {
                        sealedThreadsText = markOpenThreadsAsOpenEnding(openThreadsText);
                    }
                } else {
                    const effectiveL0Text = updatedL0Text ?? currentL0Text;
                    const authorCharter = (await this.store.readAuthorCharter()) ?? '';
                    const currentDirectorPlan = (await this.store.readArcDirectorPlan()) ?? '';
                    const currentHorizon = (await this.store.readFutureHorizon()) ?? '';

                    const envelopeRes = await generateStructuredJson(
                        this.llm,
                        {
                            pool: 'strong_creative',
                            traceStage: 'volume.envelope',
                            staticPrefixBlocks: [
                                '你是长篇小说卷级大纲编译器。请基于《作者契约》、L0 纪元总表、L1 卷级总表、当前导演计划、角色与道具档案及完整伏笔备忘录（含本卷已结案记录），编译下一卷：\n1) current_arc_envelope（仅含对写手安全的正向舞台常态与主冲突，严禁包含 Stage Ceiling、否定禁令词、WARPED 或未揭底牌）；\n2) arc_director_plan（承载阶段天花板 Stage Ceiling、未揭拐点与下一卷开篇节拍）；\n3) future_horizon（下一卷世界默认惯性事件，每条注明可证伪的 premise 成立前提），输出 JSON。'
                            ],
                            dynamicTail: [
                                `## 目标卷号\n第 ${nextVolume} 卷`,
                                `## world/author_charter.md\n${authorCharter || '(暂无)'}`,
                                `## index/L0_sagas.md\n${effectiveL0Text || '(暂无)'}`,
                                `## index/L1_volumes.md\n${updatedL1Text}`,
                                `## 当前 world/arc_director_plan.md\n${currentDirectorPlan || '(暂无)'}`,
                                `## 当前角色与道具档案\n${entityDocuments.map((doc) => doc.raw.trim()).join('\n\n') || '(暂无)'}`,
                                `## world/open_threads.md\n${openThreadsText || '(暂无)'}`,
                                `## 当前 world/future_horizon.md\n${currentHorizon || '(暂无)'}`
                            ].join('\n\n')
                        },
                        NextVolumeEnvelopeOutputSchema,
                        retryOptions,
                        options.signal
                    );

                    nextEnvelopeText = sanitizeArcEnvelopeForCleanroom(
                        envelopeRes.data.current_arc_envelope,
                        nextVolume
                    );
                    nextDirectorPlanText = `${envelopeRes.data.arc_director_plan}\n`;
                    nextFutureHorizonText = `${envelopeRes.data.future_horizon.trimEnd()}\n`;

                    const activeBlocks: string[] = [];
                    const resolvedBlocks: string[] = [];
                    for (const block of ledgerBlocks(openThreadsText)) {
                        const resolved = block.isEntry && /\bstatus\s*:\s*RESOLVED\b/i.test(block.text);
                        (resolved ? resolvedBlocks : activeBlocks).push(block.text);
                    }
                    if (resolvedBlocks.length > 0) {
                        sealedThreadsText = activeBlocks.join('');
                        updatedL1Text += `\n### 本卷已结伏笔\n\n${resolvedBlocks.join('')}`;
                        if (shouldFoldSaga) {
                            updatedL0Text = appendEpochFoldToL0Sagas({
                                currentL0: currentL0Text,
                                updatedL1: updatedL1Text,
                                openThreadsText: sealedThreadsText,
                                sealedVolume,
                                sagaInterval: sagaFoldInterval,
                                completeBook,
                                fallbackSummary: sealRes.data.volume_summary
                            });
                        }
                    }
                }

                const entitiesToArchive = await this.planColdArchiveEntities(
                    entityDocuments,
                    companionIds,
                    activeLedgerText(sealedThreadsText ?? openThreadsText),
                    activeLedgerText(nextFutureHorizonText ?? (await this.store.readFutureHorizon()) ?? '')
                );

                // =========================================================================
                // 阶段 B：WAL 写前登记 -> 磁盘写入 -> 显式受控路径 Git 提交 -> 后置打 Tag
                // =========================================================================
                const pendingPaths: string[] = [l1RelPath, SEAL_RECEIPT];
                const commitPaths: string[] = [l1RelPath, SEAL_RECEIPT];

                if (updatedL0Text !== null) {
                    pendingPaths.push(l0RelPath);
                    commitPaths.push(l0RelPath);
                }
                if (shouldCreateNextCards) {
                    pendingPaths.push(nextCardsRelPath);
                    commitPaths.push(nextCardsRelPath);
                }
                for (const item of entitiesToArchive) {
                    const oldRel = `entities/${item.fileName}`;
                    const coldRel = `entities/cold_archive/${item.fileName}`;
                    pendingPaths.push(oldRel, coldRel);
                    commitPaths.push(coldRel);
                    if (item.trackedInHead) {
                        commitPaths.push(oldRel);
                    }
                }
                if (nextVoiceBaseText !== null) {
                    pendingPaths.push(voiceBaseRelPath);
                    commitPaths.push(voiceBaseRelPath);
                    if (opsStyleExisting !== null) {
                        pendingPaths.push(opsStyleRelPath);
                        commitPaths.push(opsStyleRelPath);
                    }
                    if (worldStyleExisting !== null) {
                        pendingPaths.push(worldStyleRelPath);
                        commitPaths.push(worldStyleRelPath);
                    }
                }
                if (sealedThreadsText !== null) {
                    pendingPaths.push(threadsRelPath);
                    commitPaths.push(threadsRelPath);
                }
                if (nextEnvelopeText !== null) {
                    pendingPaths.push('world/current_arc_envelope.md');
                    commitPaths.push('world/current_arc_envelope.md');
                }
                if (nextDirectorPlanText !== null) {
                    pendingPaths.push('world/arc_director_plan.md');
                    commitPaths.push('world/arc_director_plan.md');
                }
                if (nextFutureHorizonText !== null) {
                    pendingPaths.push('world/future_horizon.md');
                    commitPaths.push('world/future_horizon.md');
                }
                if (!completeBook) {
                    pendingPaths.push('world/world_state.md');
                    commitPaths.push('world/world_state.md');
                }

                await this.store.recordPendingWrites([...new Set(pendingPaths)]);

                await mkdir(join(this.store.bookRoot, 'index'), { recursive: true });
                await writeFile(l1Path, updatedL1Text, 'utf8');
                if (updatedL0Text !== null) {
                    await writeFile(l0Path, updatedL0Text, 'utf8');
                }
                if (shouldCreateNextCards) {
                    await mkdir(join(this.store.bookRoot, 'index/L2_cards'), { recursive: true });
                    await writeFile(
                        join(this.store.bookRoot, nextCardsRelPath),
                        `# 第 ${nextVolume} 卷双轨章卡\n\n`,
                        'utf8'
                    );
                }

                const archivedEntities: string[] = [];
                if (entitiesToArchive.length > 0) {
                    await mkdir(coldArchiveDir, { recursive: true });
                    for (const item of entitiesToArchive) {
                        await link(
                            join(entitiesDir, item.fileName),
                            join(coldArchiveDir, item.fileName)
                        );
                        await rm(join(entitiesDir, item.fileName));
                        archivedEntities.push(item.entityId);
                    }
                }

                if (nextVoiceBaseText !== null) {
                    await mkdir(join(this.store.bookRoot, 'world'), { recursive: true });
                    await writeFile(
                        join(this.store.bookRoot, voiceBaseRelPath),
                        nextVoiceBaseText,
                        'utf8'
                    );
                    if (opsStyleExisting !== null) {
                        await writeFile(
                            join(this.store.bookRoot, opsStyleRelPath),
                            '# 卷中风格修订 (Style Amendments)\n\n',
                            'utf8'
                        );
                    }
                    if (worldStyleExisting !== null) {
                        await writeFile(
                            join(this.store.bookRoot, worldStyleRelPath),
                            '# 卷中风格修订 (Ops Style Amendments)\n\n',
                            'utf8'
                        );
                    }
                }

                if (sealedThreadsText !== null) {
                    await writeFile(join(this.store.bookRoot, threadsRelPath), sealedThreadsText, 'utf8');
                }
                if (nextEnvelopeText !== null) {
                    await this.store.writeCurrentArcEnvelope(nextEnvelopeText);
                }
                if (nextDirectorPlanText !== null) {
                    await this.store.writeArcDirectorPlan(nextDirectorPlanText);
                }
                if (nextFutureHorizonText !== null) {
                    await this.store.writeFutureHorizon(nextFutureHorizonText);
                }

                if (!completeBook) {
                    worldState.frontmatter.current_volume = nextVolume;
                    await this.store.writeWorldState(worldState);
                }

                const receipt = { id: randomUUID(), sealedVolume, nextVolume, archivedEntities, completedBook: completeBook };
                await writeFile(join(this.store.bookRoot, SEAL_RECEIPT), JSON.stringify(receipt), 'utf8');
                const commitMsg = completeBook
                    ? 'chore(volume): complete book'
                    : `chore(volume): advance to vol_${nextVolPad}`;
                const { sha: commitSha } = await this.system.commitPaths(
                    this.store.bookRoot,
                    [...new Set(commitPaths)],
                    `${commitMsg}\n\nSeal-ID: ${receipt.id}`
                );
                await rm(join(this.store.bookRoot, '.ops/pending_writes.json'), { force: true });

                await this.publishSeal(receipt, commitSha);

                return {
                    sealedVolume,
                    nextVolume,
                    tagName,
                    archivedEntities,
                    completedBook: completeBook,
                    commitSha
                };
            })
        );
    }

    /** 标签不能覆写；若两个完结标签仅写出一个，重试只补缺失的一个。 */
    private async publishSeal(receipt: z.infer<typeof SealReceipt>, sha: string): Promise<boolean> {
        const root = this.store.bookRoot;
        const tags = [[`arc-seal-vol-${String(receipt.sealedVolume).padStart(2, '0')}`, `Seal volume ${receipt.sealedVolume}`]] as Array<[string, string]>;
        if (receipt.completedBook) tags.push(['novel-completed', 'Novel completed']);
        let repaired = false;
        for (const [name, message] of tags) {
            let target: string;
            try { target = await this.system.currentRevision(root, `refs/tags/${name}`); }
            catch {
                await this.system.createTag(root, name, message, sha);
                repaired = true;
                continue;
            }
            if (target !== sha) throw new ValidationError(`封卷标签 ${name} 已指向不同提交`);
        }
        return repaired;
    }

    private async planColdArchiveEntities(
        documents: ReadonlyArray<{ fileName: string; profile: EntityProfile }>,
        companionIds: ReadonlySet<string>,
        activeThreads: string,
        activeHorizon: string
    ): Promise<Array<{ entityId: string; fileName: string; trackedInHead: boolean }>> {
        const coldDir = join(this.store.bookRoot, 'entities/cold_archive');
        const coldFiles = await readdir(coldDir).catch((err: unknown) => {
            if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
            throw err;
        });
        const nameOwners = new Map<string, string | null>();
        const profiles = documents.map((doc) => doc.profile);
        for (const fileName of coldFiles) {
            if (!ENTITY_FILE_RE.test(fileName)) continue;
            profiles.push(parseEntityMarkdown(await readFile(join(coldDir, fileName), 'utf8')));
        }
        for (const profile of profiles) {
            const id = profile.metadata.entity_id;
            for (const name of new Set([profile.metadata.canonical_name, ...profile.metadata.unique_aliases])) {
                if (name.length < 2) continue;
                const prior = nameOwners.get(name);
                nameOwners.set(name, prior === undefined || prior === id ? id : null);
            }
        }

        const causalText = `${activeThreads}\n${activeHorizon}`;
        const keepSet = new Set(companionIds);
        const activeCompanionIds = new Set(documents
            .map((doc) => doc.profile.metadata.entity_id)
            .filter((id) => id.startsWith('char_') && companionIds.has(id)));
        for (const match of causalText.matchAll(/\b(?:char|item)_[a-zA-Z0-9_]+\b/g)) keepSet.add(match[0]);
        const holderNames: string[] = [];
        for (const [name, id] of nameOwners) {
            if (id === null) continue;
            if (causalText.includes(name)) keepSet.add(id);
            if (activeCompanionIds.has(id)) holderNames.push(name);
        }

        const coldFileSet = new Set(coldFiles);
        const entitiesToArchive: Array<{ entityId: string; fileName: string; trackedInHead: boolean }> = [];
        for (const { fileName, profile } of documents) {
            const entityId = profile.metadata.entity_id;
            if (keepSet.has(entityId)) continue;
            if (entityId.startsWith('item_') && profile.acquiredState.some((entry) => {
                if (isWarpedEntry(entry)) return false;
                const text = [entry.text, ...entry.continuationLines, ...Object.values(entry.ledger ?? {})].join('\n');
                for (const match of text.matchAll(/\bchar_[a-zA-Z0-9_]+\b/g)) {
                    if (activeCompanionIds.has(match[0])) return true;
                }
                return holderNames.some((name) => text.includes(name));
            })) continue;
            if (coldFileSet.has(fileName)) {
                throw new ValidationError(`冷宫已存在同名档案: ${fileName}`);
            }
            const trackedInHead = (await this.system.readFileAtRef(
                this.store.bookRoot, 'HEAD', `entities/${fileName}`
            )) !== null;
            entitiesToArchive.push({ entityId, fileName, trackedInHead });
        }
        return entitiesToArchive;
    }

    private async refineStyleAmendments(
        voiceBaseRelPath: string,
        combinedAmendments: string,
        staticBaseMaxChars: number,
        retryOptions: StructuredRetryOptions,
        signal?: AbortSignal
    ): Promise<string> {
        const currentVoiceBase =
            (await readOptionalText(join(this.store.bookRoot, voiceBaseRelPath))) ?? '';
        const mergeRes = await generateStructuredJson(
            this.llm,
            {
                pool: 'fast_retrieval',
                traceStage: 'volume.style',
                staticPrefixBlocks: [
                    `你是长篇小说文风基线提炼器。请将卷中风格修订去重压缩并合入 static_base_and_voice.md，输出 JSON 字段 merged_markdown，总字数严格控制在 ${staticBaseMaxChars} 字以内。`
                ],
                dynamicTail: [
                    `## 当前 world/static_base_and_voice.md\n${currentVoiceBase || '(空)'}`,
                    `## 新增风格修订\n${combinedAmendments}`
                ].join('\n\n')
            },
            StyleMergeOutputSchema,
            retryOptions,
            signal
        );

        let refined = mergeRes.data.merged_markdown.trim();
        if (refined.length > staticBaseMaxChars) {
            const condenseRes = await generateStructuredJson(
                this.llm,
                {
                    pool: 'fast_retrieval',
                    traceStage: 'volume.style_condense',
                    staticPrefixBlocks: [
                        `你是文风基线精简器。请在不丢失核心句法规则与人称基线的前提下，将如下文档精简至严格 <= ${staticBaseMaxChars} 字，输出 JSON 字段 merged_markdown。`
                    ],
                    dynamicTail: refined
                },
                StyleMergeOutputSchema,
                retryOptions,
                signal
            );
            refined = condenseRes.data.merged_markdown.trim();
        }

        if (refined.length > staticBaseMaxChars) {
            throw new ValidationError(
                `提炼后的 static_base_and_voice.md 长度 (${refined.length}) 超过上限 ${staticBaseMaxChars} 字，请精简风格修订后重试`
            );
        }
        return `${refined}\n`;
    }

    private async assertNoOpenParallelWindow(): Promise<void> {
        const openWindows = await listOpenParallelWindows(this.store.bookRoot);
        if (openWindows.length > 0) {
            throw new ValidationError(
                `并行窗口 ${openWindows[0]!.windowId} 处于活跃 OPEN 状态，换卷前必须先合并`
            );
        }
    }
}

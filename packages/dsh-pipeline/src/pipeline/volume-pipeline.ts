import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    generateStructuredJson,
    parseEntityMarkdown,
    sanitizeLoreForWriter,
    withTraceRun,
    type BookStore,
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
import { normalizeOpsStyleAmendments, readOptionalText } from './helpers.js';

const DEFAULT_STATIC_BASE_MAX_CHARS = 1500;
const DEFAULT_SAGA_FOLD_VOLUME_INTERVAL = 10;
const CHAR_ENTITY_FILE_RE = /^(char_[a-zA-Z0-9_]+)\.md$/;
const NEGATIVE_PROHIBITION_RE =
    /(?:禁止|严禁|禁用|不要|不得|切忌|绝不|决不|不能|不可|切勿|莫要)/;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+)$/;
const LIST_ITEM_START_RE = /^\s*(?:[-*+]|\d+\.)\s/;
const TOP_LEVEL_LIST_ITEM_RE = /^(?:[-*+]|\d+\.)\s/;
const LIST_CONTINUATION_RE = /^(?:\s+\S|>)/;

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

/** 统计 open_threads.md 中仍活跃的伏笔条数 */
function countActiveThreads(markdown: string): number {
    if (!markdown.trim()) return 0;
    let inResolved = false;
    let count = 0;
    for (const rawLine of markdown.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (/^##\s+.*(Resolved Archive|已回收|已解决|已兑现)/i.test(line)) {
            inResolved = true;
            continue;
        }
        if (/^##\s+/.test(line)) {
            inResolved = false;
            continue;
        }
        if (!inResolved && line.startsWith('- ') && !/status:\s*RESOLVED/i.test(line)) {
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

    const sectionRe = /^##\s+第\s*(\d+)\s*卷[^\n]*\n([\s\S]*?)(?=^##\s+|$)/gm;
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
                    `index/L2_cards/vol_${sealedVolPad}_cards.md`
                );
                const sealedCardsText = (await readOptionalText(sealedCardsPath)) ?? '';

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
                            `## index/L2_cards/vol_${sealedVolPad}_cards.md\n${sealedCardsText || '(暂无章卡记录)'}`
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
                const updatedL1Text = `${l1Current.trimEnd()}\n\n${sealBlock}\n`;

                const nextCardsRelPath = `index/L2_cards/vol_${nextVolPad}_cards.md`;
                const shouldCreateNextCards =
                    !completeBook &&
                    (await readOptionalText(join(this.store.bookRoot, nextCardsRelPath))) === null;

                // Step 2: 规划冷宫归档非伴随角色（保持单文件迁移，不拆 *_saga_XX.md）
                const keepSet = new Set<string>([
                    worldState.frontmatter.pov_character,
                    ...(options.companionEntityIds ?? [])
                ]);
                const entitiesDir = join(this.store.bookRoot, 'entities');
                const coldArchiveDir = join(entitiesDir, 'cold_archive');
                let entityFiles: string[] = [];
                try {
                    entityFiles = await readdir(entitiesDir);
                } catch (err: unknown) {
                    if ((err as { code?: string }).code !== 'ENOENT') {
                        throw err;
                    }
                }

                const entitiesToArchive: Array<{
                    entityId: string;
                    fileName: string;
                    trackedInHead: boolean;
                }> = [];
                const survivingEntityFiles: string[] = [];
                for (const fileName of entityFiles.sort()) {
                    if (!fileName.endsWith('.md')) continue;
                    const charMatch = CHAR_ENTITY_FILE_RE.exec(fileName);
                    if (charMatch?.[1]) {
                        const entityId = charMatch[1];
                        if (!keepSet.has(entityId)) {
                            const raw = await readFile(join(entitiesDir, fileName), 'utf8');
                            parseEntityMarkdown(raw);
                            const trackedInHead =
                                (await this.system.readFileAtRef(
                                    this.store.bookRoot,
                                    'HEAD',
                                    `entities/${fileName}`
                                )) !== null;
                            entitiesToArchive.push({ entityId, fileName, trackedInHead });
                            continue;
                        }
                    }
                    survivingEntityFiles.push(fileName);
                }

                // Step 3: 提炼风格修订 -> 合入 static_base_and_voice.md (<= static_base_max_chars)，禁止暴力硬截断
                const opsStyleRelPath = '.ops/style_amendments.md';
                const worldStyleRelPath = 'world/ops_style_amendments.md';
                const voiceBaseRelPath = 'world/static_base_and_voice.md';
                const opsStyleExisting = await readOptionalText(
                    join(this.store.bookRoot, opsStyleRelPath)
                );
                const worldStyleExisting = await readOptionalText(
                    join(this.store.bookRoot, worldStyleRelPath)
                );
                const opsAmendment = normalizeOpsStyleAmendments(opsStyleExisting);
                const worldAmendment = normalizeOpsStyleAmendments(worldStyleExisting);
                const combinedAmendments = [opsAmendment, worldAmendment]
                    .filter((s): s is string => Boolean(s))
                    .join('\n\n');

                let nextVoiceBaseText: string | null = null;
                if (combinedAmendments.length > 0) {
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
                        options.signal
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
                            options.signal
                        );
                        refined = condenseRes.data.merged_markdown.trim();
                    }

                    if (refined.length > staticBaseMaxChars) {
                        throw new ValidationError(
                            `提炼后的 static_base_and_voice.md 长度 (${refined.length}) 超过上限 ${staticBaseMaxChars} 字，请精简风格修订后重试`
                        );
                    }
                    nextVoiceBaseText = `${refined}\n`;
                }

                // Step 4: 纪元折叠 & 完结封笔 vs 新卷双文件包络编译
                const threadsRelPath = 'world/open_threads.md';
                const openThreadsText =
                    (await readOptionalText(join(this.store.bookRoot, threadsRelPath))) ?? '';
                const currentL0Text = (await readOptionalText(l0Path)) ?? '';
                const shouldFoldSaga =
                    sealedVolume % sagaFoldInterval === 0 || completeBook;
                const updatedL0Text = shouldFoldSaga
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

                    const survivingParts: string[] = [];
                    for (const fileName of survivingEntityFiles) {
                        const raw = await readOptionalText(join(entitiesDir, fileName));
                        if (raw) survivingParts.push(raw.trim());
                    }

                    const envelopeRes = await generateStructuredJson(
                        this.llm,
                        {
                            pool: 'strong_creative',
                            traceStage: 'volume.envelope',
                            staticPrefixBlocks: [
                                '你是长篇小说卷级大纲编译器。请基于《作者契约》、L0 纪元总表、L1 卷级总表、当前导演计划、存活角色档案与未解伏笔，编译下一卷：\n1) current_arc_envelope（仅含对写手安全的正向舞台常态与主冲突，严禁包含 Stage Ceiling、否定禁令词、WARPED 或未揭底牌）；\n2) arc_director_plan（承载阶段天花板 Stage Ceiling、未揭拐点与下一卷开篇节拍）；\n3) future_horizon（下一卷世界默认惯性事件），输出 JSON。'
                            ],
                            dynamicTail: [
                                `## 目标卷号\n第 ${nextVolume} 卷`,
                                `## world/author_charter.md\n${authorCharter || '(暂无)'}`,
                                `## index/L0_sagas.md\n${effectiveL0Text || '(暂无)'}`,
                                `## index/L1_volumes.md\n${updatedL1Text}`,
                                `## 当前 world/arc_director_plan.md\n${currentDirectorPlan || '(暂无)'}`,
                                `## 存活角色与道具档案\n${survivingParts.join('\n\n') || '(暂无)'}`,
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
                    if (
                        envelopeRes.data.arc_director_plan &&
                        envelopeRes.data.arc_director_plan.trim().length > 0
                    ) {
                        nextDirectorPlanText = `${envelopeRes.data.arc_director_plan.trimEnd()}\n`;
                    }
                    nextFutureHorizonText = `${envelopeRes.data.future_horizon.trimEnd()}\n`;
                }

                // =========================================================================
                // 阶段 B：WAL 写前登记 -> 磁盘写入 -> 显式受控路径 Git 提交 -> 后置打 Tag
                // =========================================================================
                const pendingPaths: string[] = [l1RelPath];
                const commitPaths: string[] = [l1RelPath];

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
                        await rename(
                            join(entitiesDir, item.fileName),
                            join(coldArchiveDir, item.fileName)
                        );
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

                const commitMsg = completeBook
                    ? 'chore(volume): complete book'
                    : `chore(volume): advance to vol_${nextVolPad}`;
                const { sha: commitSha } = await this.system.commitPaths(
                    this.store.bookRoot,
                    [...new Set(commitPaths)],
                    commitMsg
                );
                await rm(join(this.store.bookRoot, '.ops/pending_writes.json'), { force: true });

                // 先提交后打 Tag：确保封卷 Tag 指向真实的换卷提交而非换卷前旧提交
                await this.system.createTag(
                    this.store.bookRoot,
                    tagName,
                    `Seal volume ${sealedVolume}`
                );
                if (completeBook) {
                    await this.system.createTag(
                        this.store.bookRoot,
                        'novel-completed',
                        'Novel completed'
                    );
                }

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

    private async assertNoOpenParallelWindow(): Promise<void> {
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
                const parsed = JSON.parse(raw) as { status?: string };
                if (parsed.status === 'OPEN') {
                    throw new ValidationError(`并行窗口 ${entry.name} 处于活跃 OPEN 状态，换卷前必须先合并`);
                }
            } catch (err: unknown) {
                if (err instanceof ValidationError) throw err;
            }
        }
    }
}

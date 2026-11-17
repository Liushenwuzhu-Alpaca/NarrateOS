import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    generateStructuredJson,
    withTraceRun,
    type BookStore,
    type LlmPort,
    type StructuredRetryOptions,
    type SystemPort
} from '@narrateos/dsh-book-store';
import {
    NextVolumeEnvelopeOutputSchema,
    StyleMergeOutputSchema,
    VolumeSealOutputSchema,
    type AdvanceVolumeOptions,
    type AdvanceVolumeResult
} from '../schemas.js';
import { normalizeOpsStyleAmendments, readOptionalText } from './helpers.js';

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
                const completeBook = Boolean(options.completeBook);
                const config = await this.store.readBookConfig();
                const retryOptions: StructuredRetryOptions = this.retryOptions ?? {
                    maxRetries: config.structured_json_retry.max_retries,
                    backoffMs: config.structured_json_retry.backoff_ms
                };
                const worldState = await this.store.readWorldState();
                if (worldState.frontmatter.timeline_mode === 'PARALLEL') {
                    throw new Error('换卷前必须合并并行窗口');
                }

                const sealedVolume = worldState.frontmatter.current_volume;
                const nextVolume = completeBook ? sealedVolume : sealedVolume + 1;
                const sealedVolPad = String(sealedVolume).padStart(2, '0');
                const nextVolPad = String(nextVolume).padStart(2, '0');
                const tagName = `arc-seal-vol-${sealedVolPad}`;

                // Step 1: 封存旧卷 -> 更新 L1_volumes.md 收束摘要与 story_day 跨度，打封存 tag，新建下卷章卡
                const l1Path = join(this.store.bookRoot, 'index/L1_volumes.md');
                const l1Current =
                    (await readOptionalText(l1Path)) ?? '# L1 活跃卷级总表\n\n';
                const sealedCardsPath = join(
                    this.store.bookRoot,
                    `index/L2_cards/vol_${sealedVolPad}_cards.md`
                );
                const sealedCardsText = (await readOptionalText(sealedCardsPath)) ?? '';

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
                await mkdir(join(this.store.bookRoot, 'index'), { recursive: true });
                await writeFile(l1Path, `${l1Current.trimEnd()}\n\n${sealBlock}\n`, 'utf8');

                await this.system.createTag(
                    this.store.bookRoot,
                    tagName,
                    `Seal volume ${sealedVolume}`
                );

                if (!completeBook) {
                    const cardsDir = join(this.store.bookRoot, 'index/L2_cards');
                    await mkdir(cardsDir, { recursive: true });
                    const nextCardsPath = join(cardsDir, `vol_${nextVolPad}_cards.md`);
                    if ((await readOptionalText(nextCardsPath)) === null) {
                        await writeFile(
                            nextCardsPath,
                            `# 第 ${nextVolume} 卷双轨章卡\n\n`,
                            'utf8'
                        );
                    }
                }

                // Step 2: 冷宫归档非随行角色
                const keepSet = new Set<string>([
                    worldState.frontmatter.pov_character,
                    ...(options.companionEntityIds ?? [])
                ]);
                const entitiesDir = join(this.store.bookRoot, 'entities');
                const coldArchiveDir = join(entitiesDir, 'cold_archive');
                const archivedEntities: string[] = [];

                let entityFiles: string[] = [];
                try {
                    entityFiles = await readdir(entitiesDir);
                } catch (err: unknown) {
                    if ((err as { code?: string }).code !== 'ENOENT') {
                        throw err;
                    }
                }

                for (const fileName of entityFiles.sort()) {
                    if (!/^char_.*\.md$/.test(fileName)) continue;
                    const entityId = fileName.slice(0, -3);
                    if (keepSet.has(entityId)) continue;
                    await mkdir(coldArchiveDir, { recursive: true });
                    await rename(join(entitiesDir, fileName), join(coldArchiveDir, fileName));
                    archivedEntities.push(entityId);
                }

                // Step 3: 提炼风格修订 -> 合入 static_base_and_voice.md (<= 1500 字) 并清空修订表
                const opsStylePath = join(this.store.bookRoot, '.ops/style_amendments.md');
                const worldStylePath = join(
                    this.store.bookRoot,
                    'world/ops_style_amendments.md'
                );
                const opsAmendment = normalizeOpsStyleAmendments(
                    await readOptionalText(opsStylePath)
                );
                const worldAmendment = normalizeOpsStyleAmendments(
                    await readOptionalText(worldStylePath)
                );
                const combinedAmendments = [opsAmendment, worldAmendment]
                    .filter((s): s is string => Boolean(s))
                    .join('\n\n');

                if (combinedAmendments.length > 0) {
                    const voiceBasePath = join(
                        this.store.bookRoot,
                        'world/static_base_and_voice.md'
                    );
                    const currentVoiceBase = (await readOptionalText(voiceBasePath)) ?? '';
                    const mergeRes = await generateStructuredJson(
                        this.llm,
                        {
                            pool: 'fast_retrieval',
                            traceStage: 'volume.style',
                            staticPrefixBlocks: [
                                '你是长篇小说文风基线提炼器。请将卷中风格修订去重压缩并合入 static_base_and_voice.md，输出 JSON 字段 merged_markdown，总字数严格控制在 1500 字以内。'
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
                    const truncated =
                        mergeRes.data.merged_markdown.length > 1500
                            ? mergeRes.data.merged_markdown.slice(0, 1500)
                            : mergeRes.data.merged_markdown;
                    await mkdir(join(this.store.bookRoot, 'world'), { recursive: true });
                    await writeFile(voiceBasePath, truncated, 'utf8');

                    if ((await readOptionalText(opsStylePath)) !== null) {
                        await writeFile(
                            opsStylePath,
                            '# 卷中风格修订 (Style Amendments)\n\n',
                            'utf8'
                        );
                    }
                    if ((await readOptionalText(worldStylePath)) !== null) {
                        await writeFile(
                            worldStylePath,
                            '# 卷中风格修订 (Ops Style Amendments)\n\n',
                            'utf8'
                        );
                    }
                }

                // Step 4: 完结封笔 vs 新卷包络编译
                const threadsPath = join(this.store.bookRoot, 'world/open_threads.md');
                const openThreadsText = (await readOptionalText(threadsPath)) ?? '';

                if (completeBook) {
                    if (openThreadsText.trim().length > 0) {
                        const sealedThreads = markOpenThreadsAsOpenEnding(openThreadsText);
                        await writeFile(threadsPath, sealedThreads, 'utf8');
                    }
                } else {
                    const l0Text =
                        (await readOptionalText(join(this.store.bookRoot, 'index/L0_sagas.md'))) ??
                        '';
                    const updatedL1Text = (await readOptionalText(l1Path)) ?? '';
                    const horizonPath = join(this.store.bookRoot, 'world/future_horizon.md');
                    const currentHorizon = (await readOptionalText(horizonPath)) ?? '';

                    const survivingParts: string[] = [];
                    for (const fileName of entityFiles.sort()) {
                        if (!fileName.endsWith('.md')) continue;
                        const entityId = fileName.slice(0, -3);
                        if (fileName.startsWith('char_') && !keepSet.has(entityId)) continue;
                        const raw = await readOptionalText(join(entitiesDir, fileName));
                        if (raw) survivingParts.push(raw.trim());
                    }

                    const envelopeRes = await generateStructuredJson(
                        this.llm,
                        {
                            pool: 'strong_creative',
                            traceStage: 'volume.envelope',
                            staticPrefixBlocks: [
                                '你是长篇小说卷级大纲编译器。请基于 L0 纪元总表、L1 卷级总表、存活角色档案与未解伏笔，编译下一卷的 current_arc_envelope（含新舞台冲突、跨图锚点与新 Stage Ceiling）以及 future_horizon 惯性事件，输出 JSON。'
                            ],
                            dynamicTail: [
                                `## 目标卷号\n第 ${nextVolume} 卷`,
                                `## index/L0_sagas.md\n${l0Text || '(暂无)'}`,
                                `## index/L1_volumes.md\n${updatedL1Text}`,
                                `## 存活角色与道具档案\n${survivingParts.join('\n\n') || '(暂无)'}`,
                                `## world/open_threads.md\n${openThreadsText || '(暂无)'}`,
                                `## 当前 world/future_horizon.md\n${currentHorizon || '(暂无)'}`
                            ].join('\n\n')
                        },
                        NextVolumeEnvelopeOutputSchema,
                        retryOptions,
                        options.signal
                    );
                    await mkdir(join(this.store.bookRoot, 'world'), { recursive: true });
                    await writeFile(
                        join(this.store.bookRoot, 'world/current_arc_envelope.md'),
                        `${envelopeRes.data.current_arc_envelope.trimEnd()}\n`,
                        'utf8'
                    );
                    await writeFile(
                        horizonPath,
                        `${envelopeRes.data.future_horizon.trimEnd()}\n`,
                        'utf8'
                    );
                }

                // Step 5: 递增卷号并执行原子 Git 提交
                if (!completeBook) {
                    worldState.frontmatter.current_volume = nextVolume;
                    await this.store.writeWorldState(worldState);
                }

                const commitMsg = completeBook
                    ? 'chore(volume): complete book'
                    : `chore(volume): advance to vol_${nextVolPad}`;
                const { sha: commitSha } = await this.system.commitPaths(
                    this.store.bookRoot,
                    ['.'],
                    commitMsg
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
}

import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CraftPluginLoader,
    withTraceRun,
    type BookSnapshot,
    type TokenUsage,
    generateStructuredJson,
    NodeSystemAdapter,
    StaticProseGate,
    type BookStore,
    type LlmPort,
    type StructuredRetryOptions,
    type SystemPort,
    type VoiceSample,
    type VoiceSamplePool
} from '@narrateos/dsh-book-store';
import { NotFoundError, ValidationError } from '../errors.js';
import { VoiceHarvestOutputSchema, type VoiceHarvestResult } from '../schemas.js';
import { collectEntityDisplayNames, formatChapterKey, readOptionalText } from './helpers.js';
import { resolveWriterGateRules } from './craft-gate.js';

export interface VoiceHarvestOptions {
    store: BookStore;
    llm: LlmPort;
    system?: SystemPort | undefined;
    gate?: StaticProseGate | undefined;
    chapterNumber?: number | undefined;
    chapterText?: string | undefined;
    currentPool?: VoiceSamplePool | undefined;
    entityNames?: readonly string[] | undefined;
    snapshot?: BookSnapshot;
    pluginSearchDirs?: string[];
    onUsage?: (usage: TokenUsage) => void;
    rollingReplaceBootSeeds?: boolean | undefined;
    maxNewSamples?: number | undefined;
    writeToDisk?: boolean | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
    signal?: AbortSignal | undefined;
}

export interface VoiceHarvestExtendedResult extends VoiceHarvestResult {
    updatedPool: VoiceSamplePool;
    replacedIds: string[];
}

function cloneVoicePool(pool: VoiceSamplePool): VoiceSamplePool {
    return {
        samples: pool.samples.map((s) => ({ ...s }))
    };
}

function containsEntityProperNoun(text: string, entityNames: readonly string[]): boolean {
    for (const rawName of entityNames) {
        const name = rawName.trim();
        if (!name) continue;
        if (text.includes(name)) {
            return true;
        }
    }
    return false;
}

function buildVoiceHarvestPrompt(params: {
    chapterNumber: number;
    isRollingMode: boolean;
    sampleBudget: number;
    bootSeedTags: readonly string[];
    existingRealTags: readonly string[];
}): string {
    if (!params.isRollingMode) {
        return [
            '你是长篇小说表达声纹采集器 (Voice Harvest)。请从已确认的开篇正文提取 3-5 句纯语言表达与动作白描示范，写入 JSON 字段 samples（每条含 tag 与 text）。',
            '严格纪律：',
            '1. 仅保留句子骨架、感官动作与对话气口示范，必须脱敏剥离特定案情结论、人名私密真相与具体账目数字；',
            '2. 拒绝空泛套话与心理总结句；',
            '3. 输出合法 JSON 对象 {"samples": [{"tag": "...", "text": "..."}]}。'
        ].join('\n');
    }

    return [
        `你是长篇小说表达声纹采集器 (Voice Harvest)。请从第 ${params.chapterNumber} 章已定稿正文提取 1-${params.sampleBudget} 句真实好句，优先置换临时启动标本，再补足声纹池容量，写入 JSON 字段 samples（每条含 tag 与 text）。`,
        params.bootSeedTags.length > 0
            ? `待替换的临时语域标签参考：${params.bootSeedTags.join('、')}。`
            : '',
        params.existingRealTags.length > 0
            ? `既有真实标本语域（尽量互补）：${params.existingRealTags.join('、')}。`
            : '',
        '严格纪律：',
        '1. 仅保留句子骨架、感官动作与对话气口示范，必须脱敏剥离所有人名/实体专名、特定案情结论与具体账目数字；',
        '2. 拒绝空泛套话与心理总结句；',
        '3. 输出合法 JSON 对象 {"samples": [{"tag": "...", "text": "..."}]}。'
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * 首章校准与 Q2 滚动声纹采集（含内存声纹池与置换详情，供管线事务内原子落盘）。
 */
export async function harvestVoiceWithPool(
    options: VoiceHarvestOptions
): Promise<VoiceHarvestExtendedResult> {
    const chapterNumber = options.chapterNumber ?? 1;
    const basePool = options.currentPool
        ? cloneVoicePool(options.currentPool)
        : await options.store.readVoiceSamples();
    const isRollingMode = options.rollingReplaceBootSeeds === true;
    const bootSeedIndices: number[] = [];
    for (let i = 0; i < basePool.samples.length; i += 1) {
        if (basePool.samples[i]?.source === 'boot_seed') {
            bootSeedIndices.push(i);
        }
    }

    if (!isRollingMode && basePool.samples.length > 0) {
        return {
            harvestedCount: 0,
            skipped: true,
            samples: [],
            updatedPool: basePool,
            replacedIds: []
        };
    }
    const config = await options.store.readBookConfig();
    const capacity = config.opening?.target_voice_pool_size ?? 4;
    const capacityGap = Math.max(0, capacity - basePool.samples.length);
    const replacementBudget = Math.min(2, bootSeedIndices.length);
    const sampleBudget = Math.min(5, options.maxNewSamples ?? 5, replacementBudget + capacityGap);
    if (isRollingMode && sampleBudget <= 0) {
        return {
            harvestedCount: 0,
            skipped: true,
            samples: [],
            updatedPool: basePool,
            replacedIds: []
        };
    }

    const chRelPath = `manuscripts/${formatChapterKey(chapterNumber)}.md`;
    const chapterText =
        options.chapterText ?? (await readOptionalText(join(options.store.bookRoot, chRelPath)));
    if (!chapterText || chapterText.trim().length === 0) {
        throw new NotFoundError(`Voice Harvest 失败：未找到已定稿章节 ${chRelPath}`);
    }

    const retryOptions: StructuredRetryOptions = options.retryOptions ?? {
        maxRetries: config.structured_json_retry.max_retries,
        backoffMs: config.structured_json_retry.backoff_ms
    };
    const gate = options.gate ?? new StaticProseGate();
    const snapshot = options.snapshot ?? await options.store.loadSnapshot();
    const cold = snapshot.coldArchiveIds.length ? await options.store.readColdArchivedEntities(snapshot.coldArchiveIds) : {};
    const entityNames = [...(options.entityNames ?? []), ...collectEntityDisplayNames(snapshot.entities), ...collectEntityDisplayNames(cold)];
    const loader = new CraftPluginLoader();
    const plugins = await loader.loadForBook({ searchDirs: options.pluginSearchDirs ?? [fileURLToPath(new URL('../../../../plugins/craft', import.meta.url)), join(options.store.bookRoot, 'plugins')], enabledPluginIds: config.craft_plugins, onConflict: 'override' });
    const rules = resolveWriterGateRules(loader, plugins, config);

    const existingRealTags = Array.from(
        new Set(
            basePool.samples
                .filter((s) => s.source !== 'boot_seed')
                .map((s) => s.tag.trim())
                .filter(Boolean)
        )
    );
    const bootSeedTags = Array.from(
        new Set(
            bootSeedIndices
                .map((idx) => basePool.samples[idx]?.tag.trim() ?? '')
                .filter(Boolean)
        )
    );

    const promptInstruction = buildVoiceHarvestPrompt({
        chapterNumber,
        isRollingMode,
        sampleBudget,
        bootSeedTags,
        existingRealTags
    });

    const res = await generateStructuredJson(
        options.onUsage ? { generate: async (req, signal) => {
            const result = await options.llm.generate(req, signal);
            options.onUsage!(result.usage);
            return result;
        } } : options.llm,
        {
            pool: 'fast_retrieval',
            traceStage: 'voice.harvest',
            staticPrefixBlocks: [promptInstruction],
            dynamicTail: `## 第 ${chapterNumber} 章定稿正文\n${chapterText}`
        },
        VoiceHarvestOutputSchema,
        retryOptions,
        options.signal
    );

    const existingIds = new Set(basePool.samples.map((s) => s.id));
    let nextIdSeq = 1;
    const allocateSampleId = (): string => {
        while (true) {
            const candidate = `harvest_ch${String(chapterNumber).padStart(2, '0')}_${String(nextIdSeq).padStart(2, '0')}`;
            nextIdSeq += 1;
            if (!existingIds.has(candidate)) {
                existingIds.add(candidate);
                return candidate;
            }
        }
    };

    const existingTexts = new Set(basePool.samples.map((sample) => sample.text.trim()));
    const accepted: VoiceSample[] = [];
    for (const item of res.data.samples) {
        const text = item.text.trim();
        const tag = item.tag.trim();
        if (text.length === 0 || tag.length === 0) continue;
        if (!chapterText.includes(text) || existingTexts.has(text) || accepted.some((sample) => sample.text === text) || containsEntityProperNoun(`${text}\n${tag}`, entityNames)) {
            continue;
        }
        const gateRes = gate.evaluate(text, {
            rules,
            enableAntiCliche: config.prose_gate.enable_anti_cliche,
            enableCrossChapterSimile: false,
            narrationSubjectivity: config.narration_subjectivity
        });
        if (!gateRes.passed) {
            continue;
        }
        accepted.push({
            id: allocateSampleId(),
            tag,
            text,
            last_used_ch: chapterNumber,
            use_count: 0,
            source: 'chapter_harvest'
        });
    }

    if ((!isRollingMode && Math.min(accepted.length, capacity) < 3) || accepted.length === 0) {
        throw new ValidationError('Voice Harvest 有效原句不足：请检查原文、脱专名与门禁要求');
    }

    let nextPool: VoiceSamplePool;
    const replacedIds: string[] = [];
    const committedSamples: VoiceSample[] = [];

    if (isRollingMode) {
        const maxReplace = Math.min(replacementBudget, sampleBudget, accepted.length);
        const remainingBootIndices = [...bootSeedIndices];
        const nextSamples = basePool.samples.map((s) => ({ ...s }));

        for (let i = 0; i < maxReplace; i += 1) {
            const replacement = accepted[i]!;
            // 优先替换同语域 tag 的 boot_seed；若无同 tag 则顺序替换剩余 boot_seed
            const tagMatchPos = remainingBootIndices.findIndex(
                (idx) => nextSamples[idx]?.tag === replacement.tag
            );
            const targetPos = tagMatchPos >= 0 ? tagMatchPos : 0;
            const targetIdx = remainingBootIndices.splice(targetPos, 1)[0]!;
            const oldSample = nextSamples[targetIdx]!;
            replacedIds.push(oldSample.id);
            nextSamples[targetIdx] = replacement;
            committedSamples.push(replacement);
        }
        const appended = accepted.slice(maxReplace, Math.min(sampleBudget, maxReplace + capacityGap));
        nextSamples.push(...appended);
        committedSamples.push(...appended);
        nextPool = { samples: nextSamples };
    } else {
        nextPool = { samples: accepted.slice(0, capacity) };
        committedSamples.push(...nextPool.samples);
    }

    if (options.writeToDisk !== false) {
        const effectiveSystem = options.system ?? new NodeSystemAdapter();
        const shouldCommitGit =
            options.system !== undefined || existsSync(join(options.store.bookRoot, '.git'));
        await options.store.runWithTxLock(async () => {
            if (!isDeepStrictEqual(await options.store.readVoiceSamples(), basePool)) {
                throw new ValidationError('采收期间声纹池已更新，请重新采收');
            }
            if (shouldCommitGit) {
                await options.store.recordPendingWrites(['.ops/voice_samples.yaml']);
            }
            await options.store.writeVoiceSamples(nextPool);
            if (shouldCommitGit) {
                await effectiveSystem.commitPaths(
                    options.store.bookRoot,
                    ['.ops/voice_samples.yaml'],
                    `chore(${formatChapterKey(chapterNumber)}): harvest voice samples`
                );
                await rm(join(options.store.bookRoot, '.ops/pending_writes.json'), {
                    force: true
                });
            }
        });
    }

    return {
        harvestedCount: committedSamples.length,
        skipped: false,
        samples: committedSamples.map((s) => ({ id: s.id, tag: s.tag, text: s.text })),
        updatedPool: nextPool,
        replacedIds
    };
}

/**
 * 首章校准与 Q2 滚动声纹采集 (Voice Harvest)：
 * - 严格返回 VoiceHarvestResult 契约字段（不附带内部内存池字段污染 HTTP/SSE 响应）。
 */
export async function harvestVoiceFromChapter(
    options: VoiceHarvestOptions
): Promise<VoiceHarvestResult> {
    const res = await withTraceRun(options.store.bookRoot, 'voice-harvest', { chapter: options.chapterNumber ?? 1 }, () => harvestVoiceWithPool(options));
    return {
        harvestedCount: res.harvestedCount,
        skipped: res.skipped,
        samples: res.samples
    };
}

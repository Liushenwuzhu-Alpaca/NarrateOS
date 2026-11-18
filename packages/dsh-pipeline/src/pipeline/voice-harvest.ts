import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
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
import { formatChapterKey, readOptionalText } from './helpers.js';

export interface VoiceHarvestOptions {
    store: BookStore;
    llm: LlmPort;
    system?: SystemPort | undefined;
    gate?: StaticProseGate | undefined;
    chapterNumber?: number | undefined;
    chapterText?: string | undefined;
    currentPool?: VoiceSamplePool | undefined;
    entityNames?: readonly string[] | undefined;
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
        if (name.length < 2) continue;
        if (text.includes(name)) {
            return true;
        }
    }
    return false;
}

function buildVoiceHarvestPrompt(params: {
    chapterNumber: number;
    isRollingMode: boolean;
    bootSeedCount: number;
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
        `你是长篇小说表达声纹采集器 (Voice Harvest)。请从第 ${params.chapterNumber} 章已定稿正文提取 1-${Math.min(params.bootSeedCount, 2)} 句真实好句，替换临时启动拐杖标本，写入 JSON 字段 samples（每条含 tag 与 text）。`,
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
    if (isRollingMode && bootSeedIndices.length === 0) {
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

    const config = await options.store.readBookConfig();
    const retryOptions: StructuredRetryOptions = options.retryOptions ?? {
        maxRetries: config.structured_json_retry.max_retries,
        backoffMs: config.structured_json_retry.backoff_ms
    };
    const gate = options.gate ?? new StaticProseGate();
    const entityNames = options.entityNames ?? [];

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
        bootSeedCount: bootSeedIndices.length,
        bootSeedTags,
        existingRealTags
    });

    const res = await generateStructuredJson(
        options.llm,
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

    const accepted: VoiceSample[] = [];
    for (const item of res.data.samples) {
        const text = item.text.trim();
        const tag = item.tag.trim();
        if (text.length === 0 || tag.length === 0) continue;
        if (entityNames.length > 0 && containsEntityProperNoun(text, entityNames)) {
            continue;
        }
        const gateRes = gate.evaluate(text, {
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

    if (accepted.length === 0) {
        throw new ValidationError('Voice Harvest 采集到的候选标本均未通过 StaticProseGate 与脱专名校验');
    }

    let nextPool: VoiceSamplePool;
    const replacedIds: string[] = [];
    const committedSamples: VoiceSample[] = [];

    if (isRollingMode) {
        const maxReplace = Math.min(
            bootSeedIndices.length,
            options.maxNewSamples ?? bootSeedIndices.length,
            accepted.length
        );
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
        nextPool = { samples: nextSamples };
    } else {
        nextPool = { samples: accepted };
        committedSamples.push(...accepted);
    }

    if (options.writeToDisk !== false) {
        const effectiveSystem = options.system ?? new NodeSystemAdapter();
        const shouldCommitGit =
            options.system !== undefined || existsSync(join(options.store.bookRoot, '.git'));
        await options.store.runWithTxLock(async () => {
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
    const res = await harvestVoiceWithPool(options);
    return {
        harvestedCount: res.harvestedCount,
        skipped: res.skipped,
        samples: res.samples
    };
}

import { join } from 'node:path';
import {
    generateStructuredJson,
    StaticProseGate,
    type BookStore,
    type LlmPort,
    type StructuredRetryOptions,
    type VoiceSample
} from '@narrateos/dsh-book-store';
import { VoiceHarvestOutputSchema, type VoiceHarvestResult } from '../schemas.js';
import { formatChapterKey, readOptionalText } from './helpers.js';

export interface VoiceHarvestOptions {
    store: BookStore;
    llm: LlmPort;
    gate?: StaticProseGate | undefined;
    chapterNumber?: number | undefined;
    retryOptions?: StructuredRetryOptions | undefined;
    signal?: AbortSignal | undefined;
}

/**
 * 首章校准声纹采集 (Voice Harvest)：
 * - 仅当 .ops/voice_samples.yaml 为空（0 条）时触发；
 * - 从已定稿章节（默认 ch_0001.md）提炼 3-5 条脱敏、无特定案情结论与人名的纯表达示范；
 * - 逐条经过 StaticProseGate 校验，拦截套话样本后再写入 .ops/voice_samples.yaml。
 */
export async function harvestVoiceFromChapter(
    options: VoiceHarvestOptions
): Promise<VoiceHarvestResult> {
    const chapterNumber = options.chapterNumber ?? 1;
    const pool = await options.store.readVoiceSamples();
    if (pool.samples.length > 0) {
        return {
            harvestedCount: 0,
            skipped: true,
            samples: []
        };
    }

    const chRelPath = `manuscripts/${formatChapterKey(chapterNumber)}.md`;
    const chapterText = await readOptionalText(join(options.store.bookRoot, chRelPath));
    if (!chapterText || chapterText.trim().length === 0) {
        throw new Error(`Voice Harvest 失败：未找到已定稿章节 ${chRelPath}`);
    }

    const config = await options.store.readBookConfig();
    const retryOptions: StructuredRetryOptions = options.retryOptions ?? {
        maxRetries: config.structured_json_retry.max_retries,
        backoffMs: config.structured_json_retry.backoff_ms
    };
    const gate = options.gate ?? new StaticProseGate();

    const res = await generateStructuredJson(
        options.llm,
        {
            pool: 'fast_retrieval',
            traceStage: 'voice.harvest',
            staticPrefixBlocks: [
                [
                    '你是长篇小说表达声纹采集器 (Voice Harvest)。请从已确认的开篇正文提取 3-5 句纯语言表达与动作白描示范，写入 JSON 字段 samples（每条含 tag 与 text）。',
                    '严格纪律：',
                    '1. 仅保留句子骨架、感官动作与对话气口示范，必须脱敏剥离特定案情结论、人名私密真相与具体账目数字；',
                    '2. 拒绝空泛套话与心理总结句；',
                    '3. 输出合法 JSON 对象 {"samples": [{"tag": "...", "text": "..."}]}。'
                ].join('\n')
            ],
            dynamicTail: `## 第 ${chapterNumber} 章定稿正文\n${chapterText}`
        },
        VoiceHarvestOutputSchema,
        retryOptions,
        options.signal
    );

    const accepted: VoiceSample[] = [];
    for (let i = 0; i < res.data.samples.length; i += 1) {
        const item = res.data.samples[i]!;
        const text = item.text.trim();
        if (text.length === 0) continue;
        const gateRes = gate.evaluate(text, {
            enableAntiCliche: config.prose_gate.enable_anti_cliche,
            enableCrossChapterSimile: false,
            narrationSubjectivity: config.narration_subjectivity
        });
        if (!gateRes.passed) {
            continue;
        }
        accepted.push({
            id: `harvest_ch${String(chapterNumber).padStart(2, '0')}_${String(accepted.length + 1).padStart(2, '0')}`,
            tag: item.tag.trim(),
            text,
            last_used_ch: chapterNumber,
            use_count: 0
        });
    }

    if (accepted.length === 0) {
        throw new Error('Voice Harvest 采集到的候选标本均未通过 StaticProseGate 校验');
    }

    await options.store.writeVoiceSamples({ samples: accepted });
    return {
        harvestedCount: accepted.length,
        skipped: false,
        samples: accepted.map((s) => ({ id: s.id, tag: s.tag, text: s.text }))
    };
}

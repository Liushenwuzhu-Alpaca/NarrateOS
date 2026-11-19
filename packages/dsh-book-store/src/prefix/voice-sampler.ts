import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { VoiceSample, VoiceSampleOptions, VoiceSamplePool, VoiceSampleResult } from './types.js';

/** 声纹标本溯源 Schema */
export const VoiceSampleSourceSchema = z.enum(['author_sample', 'boot_seed', 'chapter_harvest']);

/** 单条声纹标本 Schema */
export const VoiceSampleSchema = z.object({
    id: z.string().min(1),
    tag: z.string().min(1),
    text: z.string().min(1),
    last_used_ch: z.number().int().nonnegative().default(0),
    use_count: z.number().int().nonnegative().optional(),
    source: VoiceSampleSourceSchema.optional()
});

/** 声纹标本池 Schema (voice_samples.yaml) */
export const VoiceSamplePoolSchema = z.object({
    samples: z.array(VoiceSampleSchema).default([])
});

/** 解析 voice_samples.yaml 文本；支持空文件或 0 条标本 */
export function parseVoiceSamplesYaml(yamlContent: string): VoiceSamplePool {
    const trimmed = yamlContent.trim();
    if (!trimmed) {
        return { samples: [] };
    }
    const parsed = parseYaml(trimmed) as unknown;
    if (parsed === null || parsed === undefined) {
        return { samples: [] };
    }
    const validated = VoiceSamplePoolSchema.parse(parsed);
    return {
        samples: validated.samples.map((item) => {
            const sample: VoiceSample = {
                id: item.id,
                tag: item.tag,
                text: item.text,
                last_used_ch: item.last_used_ch,
                use_count: item.use_count ?? 0
            };
            if (item.source !== undefined) {
                sample.source = item.source;
            }
            return sample;
        })
    };
}

/** 序列化声纹标本池为 YAML 字符串 */
export function serializeVoiceSamplesYaml(pool: VoiceSamplePool): string {
    const validated = VoiceSamplePoolSchema.parse(pool);
    return stringifyYaml(validated, { lineWidth: 0 });
}

/** 从磁盘加载 voice_samples.yaml（文件不存在时返回空池） */
export async function loadVoiceSamples(filePath: string): Promise<VoiceSamplePool> {
    try {
        const raw = await readFile(filePath, 'utf8');
        return parseVoiceSamplesYaml(raw);
    } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') {
            return { samples: [] };
        }
        throw err;
    }
}

/** 将更新后的声纹标本池持久化至磁盘 */
export async function saveVoiceSamples(filePath: string, pool: VoiceSamplePool): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, serializeVoiceSamplesYaml(pool), 'utf8');
}

/**
 * 确定性 LRU 声纹抽样：
 * - 优先在 preferredTag 下筛选；若未指定或该标签无标本，则退回全池；
 * - 按 last_used_ch 升序、use_count 升序、原顺序排列，选取最久未使用的标本；
 * - 返回选中的标本与不可变更新后的新池（不修改入参）。
 */
export function sampleVoiceLru(
    pool: VoiceSamplePool,
    options: VoiceSampleOptions
): VoiceSampleResult {
    if (pool.samples.length === 0) {
        return {
            sample: null,
            updatedPool: { samples: [] }
        };
    }

    const indexed = pool.samples.map((sample, index) => ({ sample, index }));
    const tagMatched = options.preferredTag
        ? indexed.filter((item) => item.sample.tag === options.preferredTag)
        : [];
    const candidates = tagMatched.length > 0 ? tagMatched : indexed;

    candidates.sort((a, b) => {
        if (a.sample.last_used_ch !== b.sample.last_used_ch) {
            return a.sample.last_used_ch - b.sample.last_used_ch;
        }
        const aCount = a.sample.use_count ?? 0;
        const bCount = b.sample.use_count ?? 0;
        if (aCount !== bCount) {
            return aCount - bCount;
        }
        return a.index - b.index;
    });

    const chosen = candidates[0]!.sample;
    const updatedSample: VoiceSample = {
        ...chosen,
        last_used_ch: options.currentCh,
        use_count: (chosen.use_count ?? 0) + 1
    };

    const updatedPool: VoiceSamplePool = {
        samples: pool.samples.map((item, index) =>
            index === candidates[0]!.index ? updatedSample : { ...item }
        )
    };

    return {
        sample: updatedSample,
        updatedPool
    };
}

import { StaticProseGate, type NarrationSubjectivity } from '@narrateos/dsh-book-store';
import {
    hasChineseCharacter,
    type CompiledEntity,
    type CompiledLoreEntry
} from '../yield/schemas.js';

/** 开书声纹样本输入项 */
export interface BootVoiceSampleInput {
    tag: string;
    sample: string;
}

/** 开书确定性校验输入负载（供 lock_charter_and_boot 与 yield_boot_bundle 共享） */
export interface BootValidationPayload {
    l1_volumes_markdown: string;
    open_threads: ReadonlyArray<unknown>;
    entities: ReadonlyArray<CompiledEntity>;
    lore_entries: ReadonlyArray<CompiledLoreEntry>;
    world_summary: string;
    static_base_and_voice: string;
    current_arc_envelope: string;
    voice_samples: ReadonlyArray<BootVoiceSampleInput>;
}

/** 开书确定性校验选项 */
export interface BootValidationOptions {
    narrationSubjectivity: NarrationSubjectivity;
    /** filter: 过滤违规声纹并在全部失败时报错；strict: 每条声纹均须过审 */
    voiceSampleMode: 'filter' | 'strict';
}

/** 开书确定性校验结果 */
export interface BootValidationOutcome {
    issues: string[];
    cleanVoiceSamples: BootVoiceSampleInput[];
    filteredVoiceSampleCount: number;
}

/** 统计 L1 卷级总表中的卷数量 */
export function countVolumesInMarkdown(markdown: string): number {
    const volIds = new Set<string>();
    const volRegex = /\bvol_(\d+)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = volRegex.exec(markdown)) !== null) {
        if (match[1]) {
            volIds.add(String(Number(match[1])));
        }
    }

    const cnVolIds = new Set<string>();
    const cnRegex = /第\s*([一二三四五六七八九十百\d]+)\s*卷/g;
    while ((match = cnRegex.exec(markdown)) !== null) {
        if (match[1]) {
            cnVolIds.add(match[1]);
        }
    }

    return Math.max(volIds.size, cnVolIds.size);
}

/**
 * 统一执行开书确定性门禁校验（卷数、伏笔上限、实体中文名、T0 防泄露与 StaticProseGate 全覆盖）
 */
export function validateBootBundle(
    payload: BootValidationPayload,
    options: BootValidationOptions
): BootValidationOutcome {
    const issues: string[] = [];

    if (countVolumesInMarkdown(payload.l1_volumes_markdown) < 1) {
        issues.push('L1 卷级总表 (l1_volumes_markdown) 至少需包含 1 卷规划');
    }
    if (payload.open_threads.length > 15) {
        issues.push(`初始活跃伏笔数量 (${payload.open_threads.length}) 超过上限 15 条`);
    }

    const entityIds = new Set<string>();
    for (const entity of payload.entities) {
        if (entityIds.has(entity.entityId)) {
            issues.push(`entities 中存在重复 entityId: ${entity.entityId}`);
        }
        entityIds.add(entity.entityId);

        if (!hasChineseCharacter(entity.canonicalName)) {
            issues.push(
                `实体 ${entity.entityId} 必须提供包含中文字符的标准名称 canonicalName`
            );
        }

        for (const item of entity.acquiredState) {
            if (item.storyDay > 0) {
                issues.push(
                    `T0 泄露 (${entity.entityId}.acquiredState): storyDay=${item.storyDay} > 0`
                );
            }
        }
        for (const item of entity.irreversibleTrajectory) {
            if (item.storyDay > 0) {
                issues.push(
                    `T0 泄露 (${entity.entityId}.irreversibleTrajectory): storyDay=${item.storyDay} > 0`
                );
            }
        }
        for (const item of entity.recentBuffer) {
            if (item.storyDay !== undefined && item.storyDay > 0) {
                issues.push(
                    `T0 泄露 (${entity.entityId}.recentBuffer): storyDay=${item.storyDay} > 0`
                );
            }
        }
    }

    const loreIds = new Set<string>();
    for (const lore of payload.lore_entries) {
        if (loreIds.has(lore.id)) {
            issues.push(`lore_entries 中存在重复 id: ${lore.id}`);
        }
        loreIds.add(lore.id);
    }

    const proseGate = new StaticProseGate();
    const gateChecks: Array<{ label: string; text: string }> = [
        { label: 'worldSummary', text: payload.world_summary },
        { label: 'staticBaseAndVoice', text: payload.static_base_and_voice },
        { label: 'currentArcEnvelope', text: payload.current_arc_envelope }
    ];
    for (const entity of payload.entities) {
        for (const item of entity.innateLocks) {
            gateChecks.push({ label: `${entity.entityId}.innateLocks`, text: item.text });
        }
        for (const item of entity.acquiredState) {
            gateChecks.push({ label: `${entity.entityId}.acquiredState`, text: item.text });
        }
        for (const item of entity.irreversibleTrajectory) {
            gateChecks.push({ label: `${entity.entityId}.irreversibleTrajectory`, text: item.text });
        }
        for (const item of entity.recentBuffer) {
            gateChecks.push({ label: `${entity.entityId}.recentBuffer`, text: item.text });
        }
    }

    for (const check of gateChecks) {
        const res = proseGate.evaluate(check.text, {
            narrationSubjectivity: options.narrationSubjectivity
        });
        if (!res.passed) {
            issues.push(
                `StaticProseGate 未通过 (${check.label}): ${res.violations.map((v) => v.message).join('; ')}`
            );
        }
    }

    const cleanVoiceSamples: BootVoiceSampleInput[] = [];
    let filteredVoiceSampleCount = 0;
    for (const sample of payload.voice_samples) {
        const res = proseGate.evaluate(sample.sample, {
            narrationSubjectivity: options.narrationSubjectivity
        });
        if (res.passed) {
            cleanVoiceSamples.push(sample);
        } else {
            filteredVoiceSampleCount += 1;
            if (options.voiceSampleMode === 'strict') {
                issues.push(
                    `StaticProseGate 未通过 (voice_sample:${sample.tag}): ${res.violations.map((v) => v.message).join('; ')}`
                );
            }
        }
    }

    if (
        options.voiceSampleMode === 'filter' &&
        payload.voice_samples.length > 0 &&
        cleanVoiceSamples.length === 0
    ) {
        issues.push('作者提供的声纹样本全部未通过 StaticProseGate 静态文风门禁');
    }

    return {
        issues,
        cleanVoiceSamples,
        filteredVoiceSampleCount
    };
}

import {
    assertSafeEntityTagValue,
    BookContextAssemblyConfigSchema,
    BookDreamingConfigSchema,
    StaticProseGate,
    type NarrationSubjectivity,
    type VoiceSampleSource
} from '@narrateos/dsh-book-store';
import {
    hasChineseCharacter,
    type CompiledEntity,
    type CompiledLoreEntry
} from '../yield/schemas.js';

const DEFAULT_STATIC_BASE_MAX_CHARS = BookContextAssemblyConfigSchema.parse({}).static_base_max_chars;
const DEFAULT_MAX_ACTIVE_OPEN_THREADS = BookDreamingConfigSchema.parse({}).max_active_open_threads;

const NEGATIVE_PROHIBITION_RE =
    /(?:禁止|严禁|禁用|不要|不得|切忌|绝不|决不|不能|不可|切勿|莫要)/;
const WRITER_SPOILER_DIRECTIVE_RE =
    /\b(?:OMNISCIENT_SECRET|WARPED|SELF_ONLY)\b|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale/i;
const ENTITY_REF_RE = /\b((?:char|item)_[a-zA-Z0-9_]+)\b/g;

/** 开书声纹样本输入项 */
export interface BootVoiceSampleInput {
    tag: string;
    sample: string;
    source?: VoiceSampleSource | undefined;
}

/** 开书伏笔输入项 */
export interface BootOpenThreadInput {
    thread_id: string;
    title: string;
    wakeup_condition: string;
}

/** 开书惯性事件输入项 */
export interface BootFutureHorizonEventInput {
    event_id: string;
    story_day: number;
    premise: string;
    description: string;
}

/** 开书确定性校验输入负载（供 lock_charter_and_boot 与 yield_boot_bundle 共享） */
export interface BootValidationPayload {
    pov_character?: string | undefined;
    l1_volumes_markdown: string;
    open_threads: ReadonlyArray<BootOpenThreadInput | unknown>;
    future_horizon_events?: ReadonlyArray<BootFutureHorizonEventInput> | undefined;
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
    staticBaseMaxChars?: number | undefined;
    maxActiveOpenThreads?: number | undefined;
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

function collectEntityRefs(text: string): string[] {
    const refs: string[] = [];
    for (const match of text.matchAll(ENTITY_REF_RE)) {
        if (match[1]) {
            refs.push(match[1]);
        }
    }
    return refs;
}

/**
 * 统一执行开书确定性门禁校验（卷数、伏笔上限、实体中文名、T0 防泄露、Q2 声纹种子、Q7 分区与 StaticProseGate 全覆盖）
 */
export function validateBootBundle(
    payload: BootValidationPayload,
    options: BootValidationOptions
): BootValidationOutcome {
    const issues: string[] = [];
    const staticBaseMaxChars = options.staticBaseMaxChars ?? DEFAULT_STATIC_BASE_MAX_CHARS;
    const maxActiveOpenThreads = options.maxActiveOpenThreads ?? DEFAULT_MAX_ACTIVE_OPEN_THREADS;

    if (countVolumesInMarkdown(payload.l1_volumes_markdown) < 1) {
        issues.push('L1 卷级总表 (l1_volumes_markdown) 至少需包含 1 卷规划');
    }
    if (payload.open_threads.length > maxActiveOpenThreads) {
        issues.push(
            `初始活跃伏笔数量 (${payload.open_threads.length}) 超过上限 ${maxActiveOpenThreads} 条`
        );
    }

    if (payload.static_base_and_voice.trim().length > staticBaseMaxChars) {
        issues.push(
            `static_base_and_voice 长度 (${payload.static_base_and_voice.trim().length}) 超过上限 ${staticBaseMaxChars} 字`
        );
    }

    for (const cleanroomDoc of [
        { label: 'static_base_and_voice', text: payload.static_base_and_voice },
        { label: 'current_arc_envelope', text: payload.current_arc_envelope }
    ]) {
        const negMatch = NEGATIVE_PROHIBITION_RE.exec(cleanroomDoc.text);
        if (negMatch) {
            issues.push(
                `${cleanroomDoc.label} 禁止包含否定禁令词「${negMatch[0]}」，请改写为正向具象表达`
            );
        }
        const spoilerMatch = WRITER_SPOILER_DIRECTIVE_RE.exec(cleanroomDoc.text);
        if (spoilerMatch) {
            issues.push(
                `${cleanroomDoc.label} 禁止包含剧透或导演禁区标签「${spoilerMatch[0]}」`
            );
        }
    }

    const entityIds = new Set<string>();
    const canonicalNames: string[] = [];
    for (const entity of payload.entities) {
        try {
            assertSafeEntityTagValue('entityId', entity.entityId);
        } catch (err: unknown) {
            issues.push(err instanceof Error ? err.message : String(err));
        }

        if (entityIds.has(entity.entityId)) {
            issues.push(`entities 中存在重复 entityId: ${entity.entityId}`);
        }
        entityIds.add(entity.entityId);

        if (!hasChineseCharacter(entity.canonicalName)) {
            issues.push(
                `实体 ${entity.entityId} 必须提供包含中文字符的标准名称 canonicalName`
            );
        } else {
            canonicalNames.push(entity.canonicalName.trim());
        }

        for (const lockItem of entity.innateLocks) {
            if (lockItem.visibility === 'OMNISCIENT_SECRET') {
                issues.push(
                    `第 1 区 innateLocks (${entity.entityId}) 严禁包含 OMNISCIENT_SECRET，请改放第 2 区 acquiredState 并绑定 slotKey`
                );
            }
        }

        for (const item of entity.acquiredState) {
            if (item.storyDay > 0) {
                issues.push(
                    `T0 泄露 (${entity.entityId}.acquiredState): storyDay=${item.storyDay} > 0`
                );
            }
            if (item.slotKey !== undefined) {
                try {
                    assertSafeEntityTagValue('slotKey', item.slotKey);
                } catch (err: unknown) {
                    issues.push(err instanceof Error ? err.message : String(err));
                }
            }
            if (item.owner !== undefined) {
                try {
                    assertSafeEntityTagValue('owner', item.owner);
                } catch (err: unknown) {
                    issues.push(err instanceof Error ? err.message : String(err));
                }
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

    if (payload.pov_character !== undefined && !entityIds.has(payload.pov_character)) {
        issues.push(`pov_character (${payload.pov_character}) 在 entities 中不存在`);
    }

    for (const entity of payload.entities) {
        for (const item of entity.acquiredState) {
            if (item.owner !== undefined && !entityIds.has(item.owner)) {
                issues.push(
                    `实体 ${entity.entityId} 的 acquiredState.owner (${item.owner}) 在 entities 中不存在`
                );
            }
            for (const ref of collectEntityRefs(item.text)) {
                if (!entityIds.has(ref)) {
                    issues.push(`实体 ${entity.entityId}.acquiredState 引用了不存在的实体: ${ref}`);
                }
            }
        }
        for (const item of entity.innateLocks) {
            for (const ref of collectEntityRefs(item.text)) {
                if (!entityIds.has(ref)) {
                    issues.push(`实体 ${entity.entityId}.innateLocks 引用了不存在的实体: ${ref}`);
                }
            }
        }
        for (const item of entity.irreversibleTrajectory) {
            for (const ref of collectEntityRefs(item.text)) {
                if (!entityIds.has(ref)) {
                    issues.push(
                        `实体 ${entity.entityId}.irreversibleTrajectory 引用了不存在的实体: ${ref}`
                    );
                }
            }
        }
        for (const item of entity.recentBuffer) {
            for (const ref of collectEntityRefs(item.text)) {
                if (!entityIds.has(ref)) {
                    issues.push(`实体 ${entity.entityId}.recentBuffer 引用了不存在的实体: ${ref}`);
                }
            }
        }
    }

    const threadIds = new Set<string>();
    for (const rawThread of payload.open_threads) {
        if (rawThread !== null && typeof rawThread === 'object') {
            const thread = rawThread as Partial<BootOpenThreadInput>;
            if (typeof thread.thread_id === 'string') {
                if (threadIds.has(thread.thread_id)) {
                    issues.push(`open_threads 中存在重复 thread_id: ${thread.thread_id}`);
                }
                threadIds.add(thread.thread_id);
            }
            const combinedText = `${thread.title ?? ''} ${thread.wakeup_condition ?? ''}`;
            const spoilerMatch = /\b(?:OMNISCIENT_SECRET|WARPED|SELF_ONLY)\b/i.exec(combinedText);
            if (spoilerMatch) {
                issues.push(
                    `open_threads (${thread.thread_id ?? 'unknown'}) 禁止包含剧透标签「${spoilerMatch[0]}」`
                );
            }
            for (const ref of collectEntityRefs(combinedText)) {
                if (!entityIds.has(ref)) {
                    issues.push(
                        `open_threads (${thread.thread_id ?? 'unknown'}) 引用了不存在的实体: ${ref}`
                    );
                }
            }
        }
    }

    if (payload.future_horizon_events) {
        const eventIds = new Set<string>();
        for (const evt of payload.future_horizon_events) {
            if (eventIds.has(evt.event_id)) {
                issues.push(`future_horizon_events 中存在重复 event_id: ${evt.event_id}`);
            }
            eventIds.add(evt.event_id);
            for (const ref of collectEntityRefs(`${evt.premise} ${evt.description}`)) {
                if (!entityIds.has(ref)) {
                    issues.push(
                        `future_horizon_events (${evt.event_id}) 引用了不存在的实体: ${ref}`
                    );
                }
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
        try {
            assertSafeEntityTagValue('voice_tag', sample.tag);
        } catch (err: unknown) {
            issues.push(err instanceof Error ? err.message : String(err));
        }

        const res = proseGate.evaluate(sample.sample, {
            narrationSubjectivity: options.narrationSubjectivity
        });

        if (sample.source === 'boot_seed') {
            const nonSpaceLen = sample.sample.replace(/\s+/g, '').length;
            let seedValid = true;
            if (nonSpaceLen < 15 || nonSpaceLen > 45) {
                issues.push(
                    `boot_seed 声纹样本 (${sample.tag}) 长度 (${nonSpaceLen} 字) 必须在 15~45 字之间`
                );
                seedValid = false;
            }
            if (!res.passed) {
                issues.push(
                    `StaticProseGate 未通过 (boot_seed:${sample.tag}): ${res.violations.map((v) => v.message).join('; ')}`
                );
                seedValid = false;
            }
            for (const name of canonicalNames) {
                if (name.length > 0 && sample.sample.includes(name)) {
                    issues.push(
                        `boot_seed 声纹样本 (${sample.tag}) 禁止包含初始角色专名「${name}」`
                    );
                    seedValid = false;
                }
            }
            if (seedValid) {
                cleanVoiceSamples.push(sample);
            } else {
                filteredVoiceSampleCount += 1;
            }
            continue;
        }

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
        cleanVoiceSamples.length === 0 &&
        !payload.voice_samples.every((s) => s.source === 'boot_seed')
    ) {
        issues.push('作者提供的声纹样本全部未通过 StaticProseGate 静态文风门禁');
    }

    return {
        issues,
        cleanVoiceSamples,
        filteredVoiceSampleCount
    };
}

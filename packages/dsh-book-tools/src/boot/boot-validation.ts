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
import { collectEntityRefs, hasOmniscientSecretMarker } from '../yield/shared.js';

const DEFAULT_STATIC_BASE_MAX_CHARS = BookContextAssemblyConfigSchema.parse({}).static_base_max_chars;
const DEFAULT_MAX_ACTIVE_OPEN_THREADS = BookDreamingConfigSchema.parse({}).max_active_open_threads;

const NEGATIVE_PROHIBITION_RE =
    /(?:禁止|严禁|禁用|不要|不得|切忌|绝不|决不|不能|不可|切勿|莫要)/;
const WRITER_SPOILER_DIRECTIVE_RE =
    /\b(?:OMNISCIENT_SECRET|WARPED|SELF_ONLY)\b|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale/i;

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

function pushSafeEntityTagIssue(label: string, value: string, issues: string[]): void {
    try {
        assertSafeEntityTagValue(label, value);
    } catch (err: unknown) {
        issues.push(err instanceof Error ? err.message : String(err));
    }
}

function assertRefsInEntityIds(
    sourceLabel: string,
    text: string,
    entityIds: ReadonlySet<string>,
    issues: string[]
): void {
    for (const ref of collectEntityRefs(text)) {
        if (!entityIds.has(ref)) {
            issues.push(`${sourceLabel} 引用了不存在的实体: ${ref}`);
        }
    }
}

function validateCleanroomNarrativeFields(
    payload: BootValidationPayload,
    staticBaseMaxChars: number,
    issues: string[]
): void {
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
}

function validateBootEntities(
    entities: ReadonlyArray<CompiledEntity>,
    povCharacter: string | undefined,
    issues: string[]
): { entityIds: Set<string>; canonicalNames: string[] } {
    const entityIds = new Set<string>();
    const canonicalNames: string[] = [];

    for (const entity of entities) {
        pushSafeEntityTagIssue('entityId', entity.entityId, issues);
        if (entityIds.has(entity.entityId)) {
            issues.push(`entities 中存在重复 entityId: ${entity.entityId}`);
        }
        entityIds.add(entity.entityId);

        if (!hasChineseCharacter(entity.canonicalName)) {
            issues.push(
                `实体 ${entity.entityId} 必须提供包含中文字符的标准名称 canonicalName`
            );
        } else {
            canonicalNames.push(entity.canonicalName.trim(), ...(entity.uniqueAliases ?? []).map((name) => name.trim()));
        }

        for (const lockItem of entity.innateLocks) {
            if (lockItem.visibility === 'READER_KNOWN') {
                issues.push(`第 1 区 innateLocks (${entity.entityId}) 仅允许 PUBLIC 或 SELF_ONLY`);
            }
            if (hasOmniscientSecretMarker(lockItem)) {
                issues.push(
                    `第 1 区 innateLocks (${entity.entityId}) 严禁包含 OMNISCIENT_SECRET，请改放第 2 区 acquiredState 并绑定 slotKey`
                );
            }
        }

        const slots = new Set<string>();
        for (const item of entity.acquiredState) {
            if (item.storyDay > 0) {
                issues.push(
                    `T0 泄露 (${entity.entityId}.acquiredState): storyDay=${item.storyDay} > 0`
                );
            }
            if (item.visibility === 'OMNISCIENT_SECRET') {
                const hasFlippableSlot =
                    Boolean(item.slotKey?.trim()) ||
                    /^[^:：\s][^:：\n]{0,39}[:：]\s*\S/.test(item.text.trim());
                if (!hasFlippableSlot) {
                    issues.push(
                        `第 2 区 acquiredState (${entity.entityId}) 的 OMNISCIENT_SECRET 条目必须提供显式 slotKey 或「槽位: 内容」前缀以便后续原地揭秘翻转`
                    );
                }
            }
            if (item.slotKey !== undefined) {
                pushSafeEntityTagIssue('slotKey', item.slotKey, issues);
                if (!item.slotKey.trim() || slots.has(item.slotKey.trim())) {
                    issues.push(`实体 ${entity.entityId} 的 acquiredState.slotKey 为空或重复: ${item.slotKey}`);
                }
                slots.add(item.slotKey.trim());
            }
            if (item.owner !== undefined) {
                pushSafeEntityTagIssue('owner', item.owner, issues);
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

    if (povCharacter !== undefined && !entityIds.has(povCharacter)) {
        issues.push(`pov_character (${povCharacter}) 在 entities 中不存在`);
    }

    return { entityIds, canonicalNames };
}

function validateBootEntityAndCollectionRefs(
    payload: BootValidationPayload,
    entityIds: ReadonlySet<string>,
    issues: string[]
): void {
    for (const entity of payload.entities) {
        for (const item of [...entity.irreversibleTrajectory, ...entity.recentBuffer]) {
            if (item.owner !== undefined) {
                pushSafeEntityTagIssue('owner', item.owner, issues);
                if (!entityIds.has(item.owner)) issues.push(`实体 ${entity.entityId} 的 owner (${item.owner}) 在 entities 中不存在`);
            }
        }
        for (const item of entity.acquiredState) {
            if (item.owner !== undefined && !entityIds.has(item.owner)) {
                issues.push(
                    `实体 ${entity.entityId} 的 acquiredState.owner (${item.owner}) 在 entities 中不存在`
                );
            }
            assertRefsInEntityIds(`实体 ${entity.entityId}.acquiredState`, item.text, entityIds, issues);
        }
        for (const item of entity.innateLocks) {
            assertRefsInEntityIds(`实体 ${entity.entityId}.innateLocks`, item.text, entityIds, issues);
        }
        for (const item of entity.irreversibleTrajectory) {
            assertRefsInEntityIds(
                `实体 ${entity.entityId}.irreversibleTrajectory`,
                item.text,
                entityIds,
                issues
            );
        }
        for (const item of entity.recentBuffer) {
            assertRefsInEntityIds(`实体 ${entity.entityId}.recentBuffer`, item.text, entityIds, issues);
        }
    }

    const threadIds = new Set<string>();
    for (const rawThread of payload.open_threads) {
        if (rawThread === null || typeof rawThread !== 'object') continue;
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
        assertRefsInEntityIds(
            `open_threads (${thread.thread_id ?? 'unknown'})`,
            combinedText,
            entityIds,
            issues
        );
    }

    if (payload.future_horizon_events) {
        const eventIds = new Set<string>();
        for (const evt of payload.future_horizon_events) {
            if (eventIds.has(evt.event_id)) {
                issues.push(`future_horizon_events 中存在重复 event_id: ${evt.event_id}`);
            }
            eventIds.add(evt.event_id);
            assertRefsInEntityIds(
                `future_horizon_events (${evt.event_id})`,
                `${evt.premise} ${evt.description}`,
                entityIds,
                issues
            );
        }
    }

    const loreIds = new Set<string>();
    for (const lore of payload.lore_entries) {
        if (loreIds.has(lore.id)) {
            issues.push(`lore_entries 中存在重复 id: ${lore.id}`);
        }
        loreIds.add(lore.id);
    }
}

function validateBootNarrativeProseGate(
    payload: BootValidationPayload,
    narrationSubjectivity: NarrationSubjectivity,
    proseGate: StaticProseGate,
    issues: string[]
): void {
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
        const res = proseGate.evaluate(check.text, { narrationSubjectivity });
        if (!res.passed) {
            issues.push(
                `StaticProseGate 未通过 (${check.label}): ${res.violations.map((v) => v.message).join('; ')}`
            );
        }
    }
}

function validateBootVoiceSamples(
    voiceSamples: ReadonlyArray<BootVoiceSampleInput>,
    canonicalNames: readonly string[],
    options: BootValidationOptions,
    proseGate: StaticProseGate,
    issues: string[]
): { cleanVoiceSamples: BootVoiceSampleInput[]; filteredVoiceSampleCount: number } {
    const cleanVoiceSamples: BootVoiceSampleInput[] = [];
    let filteredVoiceSampleCount = 0;

    for (const sample of voiceSamples) {
        pushSafeEntityTagIssue('voice_tag', sample.tag, issues);
        const res = proseGate.evaluate(sample.sample, {
            narrationSubjectivity: options.narrationSubjectivity
        });
        const properName = canonicalNames.find((name) => name && (sample.sample.includes(name) || sample.tag.includes(name)));

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
            if (properName) {
                issues.push(`boot_seed 声纹样本 (${sample.tag}) 禁止包含初始角色专名「${properName}」`);
                seedValid = false;
            }
            if (seedValid) {
                cleanVoiceSamples.push(sample);
            } else {
                filteredVoiceSampleCount += 1;
            }
            continue;
        }

        if (res.passed && !properName) {
            cleanVoiceSamples.push(sample);
        } else {
            filteredVoiceSampleCount += 1;
            if (options.voiceSampleMode === 'strict') {
                if (properName) issues.push(`声纹样本禁止包含初始角色专名「${properName}」`);
                issues.push(
                    `StaticProseGate 未通过 (voice_sample:${sample.tag}): ${res.violations.map((v) => v.message).join('; ')}`
                );
            }
        }
    }

    if (
        options.voiceSampleMode === 'filter' &&
        voiceSamples.length > 0 &&
        cleanVoiceSamples.length === 0 &&
        !voiceSamples.every((s) => s.source === 'boot_seed')
    ) {
        issues.push('作者提供的声纹样本全部未通过 StaticProseGate 静态文风门禁');
    }

    return { cleanVoiceSamples, filteredVoiceSampleCount };
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

    validateCleanroomNarrativeFields(payload, staticBaseMaxChars, issues);
    const { entityIds, canonicalNames } = validateBootEntities(
        payload.entities,
        payload.pov_character,
        issues
    );
    validateBootEntityAndCollectionRefs(payload, entityIds, issues);

    const proseGate = new StaticProseGate();
    validateBootNarrativeProseGate(payload, options.narrationSubjectivity, proseGate, issues);
    const { cleanVoiceSamples, filteredVoiceSampleCount } = validateBootVoiceSamples(
        payload.voice_samples,
        canonicalNames,
        options,
        proseGate,
        issues
    );

    return {
        issues,
        cleanVoiceSamples,
        filteredVoiceSampleCount
    };
}

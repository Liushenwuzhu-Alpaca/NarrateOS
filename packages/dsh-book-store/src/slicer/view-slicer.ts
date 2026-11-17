import type {
    BookSnapshot,
    EntityEntry,
    EntityProfile,
    TimelineMode
} from '../store/schemas.js';

/** 裁剪目标受众角色 */
export type SlicerRole = 'planner' | 'writer' | 'fact_checker' | 'extractor';

/** ViewSlicer 裁剪请求参数 */
export interface SliceRequest {
    snapshot: BookSnapshot;
    targetDay?: number | undefined;
    currentCh?: number | undefined;
    timelineMode?: TimelineMode | undefined;
    povCharId?: string | string[] | undefined;
    forRole: SlicerRole;
    entityIds?: string[] | undefined;
    parallelBroadcastEntries?: EntityEntry[] | undefined;
    wakeupGapThreshold?: number | undefined;
}

/** 便捷方法参数（省略 forRole 与 snapshot） */
export type RoleSliceOptions = Omit<SliceRequest, 'snapshot' | 'forRole'>;

/** 仅读者已知的戏剧反讽提示（桌下炸弹） */
export interface DramaticIronyHint {
    entityId: string;
    canonicalName: string;
    section: 'innateLocks' | 'acquiredState' | 'irreversibleTrajectory' | 'recentBuffer';
    text: string;
    storyDay?: number | undefined;
    chapter?: number | undefined;
    formattedHint: string;
}

/** 长间隔重逢的感官记忆唤醒提示 */
export interface MemoryWakeupHint {
    entityId: string;
    canonicalName: string;
    lastSeenCh: number;
    gapChapters: number;
    sensoryCue: string;
    formattedHint: string;
}

/** PARALLEL 模式下的只读全局广播条目 */
export type ParallelBroadcastItem = EntityEntry & {
    readonly: true;
};

/** 世界文档集合输入（用于按角色物理裁剪契约、禁区与导演文档） */
export interface WorldDocumentsInput {
    authorCharter?: string | null | undefined;
    arcDirectorPlan?: string | null | undefined;
    currentArcEnvelope?: string | null | undefined;
    staticBaseAndVoice?: string | null | undefined;
    opsStyleAmendments?: string | null | undefined;
    futureHorizon?: string | null | undefined;
}

/** 按角色物理裁剪后的世界文档视图 */
export interface SlicedWorldDocuments {
    forRole: SlicerRole;
    authorCharter: string | null;
    arcDirectorPlan: string | null;
    currentArcEnvelope: string | null;
    staticBaseAndVoice: string | null;
    opsStyleAmendments: string | null;
    futureHorizon: string | null;
}

/** ViewSlicer 裁剪输出视图 */
export interface SlicedView {
    forRole: SlicerRole;
    targetDay: number;
    currentCh: number;
    timelineMode: TimelineMode;
    povCharIds: string[];
    entities: Record<string, EntityProfile>;
    dramaticIronyHints: DramaticIronyHint[];
    memoryWakeupHints: MemoryWakeupHint[];
    parallelBroadcast: ParallelBroadcastItem[];
}

type SectionKey = 'innateLocks' | 'acquiredState' | 'irreversibleTrajectory' | 'recentBuffer';

const DEFAULT_WAKEUP_GAP_THRESHOLD = 30;
const WRITER_RESTRICTED_DIRECTIVE_RE = /\bWARPED\b|Stage\s*Ceiling|阶段天花板|导演禁区|director_rationale/i;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** 剥离写手不可见的 WARPED / Stage Ceiling 导演禁区章节与条目 */
function stripWriterRestrictedDirectives(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) {
        return null;
    }

    const lines = raw.split(/\r?\n/);
    const kept: string[] = [];
    let skipSectionLevel: number | null = null;
    let skipIndentedContinuations = false;

    for (const line of lines) {
        const headingMatch = MARKDOWN_HEADING_RE.exec(line.trim());
        if (headingMatch?.[1] && headingMatch[2]) {
            const level = headingMatch[1].length;
            const headingTitle = headingMatch[2];
            if (skipSectionLevel !== null && level <= skipSectionLevel) {
                skipSectionLevel = null;
            }
            if (skipSectionLevel === null && WRITER_RESTRICTED_DIRECTIVE_RE.test(headingTitle)) {
                skipSectionLevel = level;
                skipIndentedContinuations = false;
                continue;
            }
        }

        if (skipSectionLevel !== null) {
            continue;
        }

        if (skipIndentedContinuations) {
            if (/^\s{2,}\S/.test(line)) {
                continue;
            }
            skipIndentedContinuations = false;
        }

        if (WRITER_RESTRICTED_DIRECTIVE_RE.test(line)) {
            skipIndentedContinuations = true;
            continue;
        }

        kept.push(line);
    }

    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 按受众角色物理裁剪世界级设定与导演文档：
 * - 对 'writer' 物理剥离 authorCharter、arcDirectorPlan、futureHorizon，并清除剩余正向文档中的 WARPED / Stage Ceiling 导演指令；
 * - 对 'planner'、'fact_checker'、'extractor' 保留传入文档视图以便统筹、审校与抽取。
 */
export function sliceWorldDocuments(
    forRole: SlicerRole,
    docs: WorldDocumentsInput
): SlicedWorldDocuments {
    if (forRole === 'writer') {
        return {
            forRole,
            authorCharter: null,
            arcDirectorPlan: null,
            currentArcEnvelope: stripWriterRestrictedDirectives(docs.currentArcEnvelope),
            staticBaseAndVoice: stripWriterRestrictedDirectives(docs.staticBaseAndVoice),
            opsStyleAmendments: stripWriterRestrictedDirectives(docs.opsStyleAmendments),
            futureHorizon: null
        };
    }

    return {
        forRole,
        authorCharter: docs.authorCharter ?? null,
        arcDirectorPlan: docs.arcDirectorPlan ?? null,
        currentArcEnvelope: docs.currentArcEnvelope ?? null,
        staticBaseAndVoice: docs.staticBaseAndVoice ?? null,
        opsStyleAmendments: docs.opsStyleAmendments ?? null,
        futureHorizon: docs.futureHorizon ?? null
    };
}

/** 深拷贝单条实体记录，避免污染原始快照 */
function cloneEntry(entry: EntityEntry): EntityEntry {
    const cloned: EntityEntry = {
        text: entry.text,
        continuationLines: [...entry.continuationLines]
    };
    if (entry.storyDay !== undefined) cloned.storyDay = entry.storyDay;
    if (entry.chapter !== undefined) cloned.chapter = entry.chapter;
    if (entry.visibility !== undefined) cloned.visibility = entry.visibility;
    if (entry.owner !== undefined) cloned.owner = entry.owner;
    if (entry.status !== undefined) cloned.status = entry.status;
    if (entry.slotKey !== undefined) cloned.slotKey = entry.slotKey;
    if (entry.isNumericLedger !== undefined) cloned.isNumericLedger = entry.isNumericLedger;
    if (entry.extraTags) cloned.extraTags = { ...entry.extraTags };
    if (entry.ledger) cloned.ledger = { ...entry.ledger };
    return cloned;
}

/** 深拷贝实体元数据 */
function cloneProfileShell(profile: EntityProfile): EntityProfile {
    return {
        metadata: {
            ...profile.metadata,
            unique_aliases: [...profile.metadata.unique_aliases],
            contextual_titles: [...profile.metadata.contextual_titles],
            historical_anchors: [...profile.metadata.historical_anchors]
        },
        sectionHeadings: { ...profile.sectionHeadings },
        innateLocks: [],
        acquiredState: [],
        irreversibleTrajectory: [],
        recentBuffer: []
    };
}

/** 提取文本首句作为感官半句提示 */
function extractFirstSentence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const match = /^[^。！？!?]+[。！？!?]?/.exec(trimmed);
    return match?.[0]?.trim() ?? trimmed;
}

/** 判定当前角色是否应当物理剥离 WARPED 废止条目 */
function shouldStripWarped(forRole: SlicerRole): boolean {
    return forRole === 'writer' || forRole === 'extractor';
}

/** 判定单条实体记录是否被标记为 WARPED 废止（兼容标签状态与文本内联标记） */
function isWarpedEntry(entry: EntityEntry): boolean {
    return entry.status === 'WARPED' || /\bWARPED\b/.test(entry.text);
}

/**
 * 确定性上下文裁剪器（ViewSlicer）
 * - 零 LLM、零网络、纯内存不可变计算
 * - 负责三态时间线偏序过滤、POV 物理剥离、WARPED 灰象隔离与长间隔感官唤醒
 */
export class ViewSlicer {
    /** 执行完整视图裁剪 */
    slice(request: SliceRequest): SlicedView {
        const { snapshot, forRole } = request;
        const frontmatter = snapshot.worldState.frontmatter;
        const targetDay = request.targetDay ?? frontmatter.story_day;
        const currentCh = request.currentCh ?? frontmatter.current_chapter;
        const timelineMode = request.timelineMode ?? frontmatter.timeline_mode;
        const rawPov = request.povCharId ?? frontmatter.pov_character;
        const povCharIds = Array.isArray(rawPov) ? [...rawPov] : [rawPov];
        const povSet = new Set(povCharIds);
        const wakeupThreshold = request.wakeupGapThreshold ?? DEFAULT_WAKEUP_GAP_THRESHOLD;
        const stripWarped = shouldStripWarped(forRole);

        const targetIds = request.entityIds ?? Object.keys(snapshot.entities);
        const entities: Record<string, EntityProfile> = {};
        const dramaticIronyHints: DramaticIronyHint[] = [];
        const memoryWakeupHints: MemoryWakeupHint[] = [];

        for (const entityId of targetIds) {
            const profile = snapshot.entities[entityId];
            if (!profile) continue;

            // 整卡处于 WARPED 废止状态时，对 writer / extractor 物理剥离
            if (stripWarped && profile.metadata.status === 'WARPED') {
                continue;
            }

            const sliced = this.sliceEntityProfile(
                profile,
                {
                    targetDay,
                    timelineMode,
                    povSet,
                    forRole,
                    stripWarped
                },
                dramaticIronyHints
            );
            entities[entityId] = sliced;

            // 长间隔记忆唤醒（严格基于裁剪后的可见信息提取，避免泄露 SELF_ONLY/OMNISCIENT_SECRET）
            const lastSeenCh = profile.metadata.last_seen_ch;
            if (lastSeenCh !== undefined && currentCh - lastSeenCh > wakeupThreshold) {
                const gapChapters = currentCh - lastSeenCh;
                const sensoryCue = this.pickSensoryCue(sliced);
                memoryWakeupHints.push({
                    entityId,
                    canonicalName: profile.metadata.canonical_name,
                    lastSeenCh,
                    gapChapters,
                    sensoryCue,
                    formattedHint: `时隔 ${gapChapters} 章重逢：${profile.metadata.canonical_name} - 感官唤醒：${sensoryCue}`
                });
            }
        }

        const parallelBroadcast =
            timelineMode === 'PARALLEL'
                ? this.filterParallelBroadcast(
                      request.parallelBroadcastEntries ?? [],
                      targetDay,
                      povSet,
                      forRole,
                      stripWarped
                  )
                : [];

        return {
            forRole,
            targetDay,
            currentCh,
            timelineMode,
            povCharIds,
            entities,
            dramaticIronyHints,
            memoryWakeupHints,
            parallelBroadcast
        };
    }

    /** 为章节导演（Planner）裁剪视图 */
    sliceForPlanner(snapshot: BookSnapshot, options: RoleSliceOptions = {}): SlicedView {
        return this.slice({
            ...options,
            snapshot,
            forRole: 'planner'
        });
    }

    /** 为净室写手（Prose Writer）裁剪视图 */
    sliceForWriter(snapshot: BookSnapshot, options: RoleSliceOptions = {}): SlicedView {
        return this.slice({
            ...options,
            snapshot,
            forRole: 'writer'
        });
    }

    /** 按受众角色物理裁剪世界文档 */
    sliceWorldDocuments(forRole: SlicerRole, docs: WorldDocumentsInput): SlicedWorldDocuments {
        return sliceWorldDocuments(forRole, docs);
    }

    /** 裁剪单个四段式实体档案 */
    private sliceEntityProfile(
        profile: EntityProfile,
        ctx: {
            targetDay: number;
            timelineMode: TimelineMode;
            povSet: Set<string>;
            forRole: SlicerRole;
            stripWarped: boolean;
        },
        ironySink: DramaticIronyHint[]
    ): EntityProfile {
        const result = cloneProfileShell(profile);
        const sections: SectionKey[] = [
            'innateLocks',
            'acquiredState',
            'irreversibleTrajectory',
            'recentBuffer'
        ];

        for (const section of sections) {
            // FLASHBACK 模式物理屏蔽当前 2. Acquired State 与 4. Recent Buffer
            if (
                ctx.timelineMode === 'FLASHBACK' &&
                (section === 'acquiredState' || section === 'recentBuffer')
            ) {
                result[section] = [];
                continue;
            }

            const filtered: EntityEntry[] = [];
            for (const entry of profile[section]) {
                if (ctx.stripWarped && isWarpedEntry(entry)) {
                    continue;
                }

                if (!this.passesTimelineFilter(entry, section, ctx.targetDay, ctx.timelineMode)) {
                    continue;
                }

                const visDecision = this.evaluateVisibility(
                    profile.metadata.entity_id,
                    entry,
                    ctx.povSet,
                    ctx.forRole
                );

                if (visDecision === 'CONVERT_TO_IRONY') {
                    ironySink.push(this.createIronyHint(profile, section, entry));
                    continue;
                }

                if (visDecision === 'KEEP') {
                    // planner 视图中亦同步收集非 POV 的 READER_KNOWN 提示供编排戏眼
                    if (
                        ctx.forRole === 'planner' &&
                        entry.visibility === 'READER_KNOWN' &&
                        !ctx.povSet.has(entry.owner ?? profile.metadata.entity_id)
                    ) {
                        ironySink.push(this.createIronyHint(profile, section, entry));
                    }
                    filtered.push(cloneEntry(entry));
                }
            }

            result[section] = filtered;
        }

        return result;
    }

    /** 三态时间线 story_day 偏序过滤 */
    private passesTimelineFilter(
        entry: EntityEntry,
        section: SectionKey,
        targetDay: number,
        timelineMode: TimelineMode
    ): boolean {
        // 1. Innate Locks 先天红线在所有模式（含插叙）下永不因日期被屏蔽
        if (section === 'innateLocks') {
            return true;
        }

        if (timelineMode === 'FLASHBACK') {
            // 插叙仅挂载严格早于 targetDay 的第 3 区历史履历
            if (section === 'irreversibleTrajectory') {
                return entry.storyDay !== undefined && entry.storyDay < targetDay;
            }
            return false;
        }

        // MAINLINE 与 PARALLEL：保留无日期或 storyDay <= targetDay 的条目
        return entry.storyDay === undefined || entry.storyDay <= targetDay;
    }

    /** POV 可见性判定 */
    private evaluateVisibility(
        entityId: string,
        entry: EntityEntry,
        povSet: Set<string>,
        forRole: SlicerRole
    ): 'KEEP' | 'DROP' | 'CONVERT_TO_IRONY' {
        // planner / fact_checker / extractor 保留全量视角信息以便统筹与核查
        if (forRole !== 'writer') {
            return 'KEEP';
        }

        const visibility = entry.visibility ?? 'PUBLIC';
        const effectiveOwner = entry.owner ?? entityId;
        const isOwnedByPov = povSet.has(effectiveOwner);

        switch (visibility) {
            case 'PUBLIC':
                return 'KEEP';
            case 'SELF_ONLY':
                return isOwnedByPov ? 'KEEP' : 'DROP';
            case 'OMNISCIENT_SECRET':
                return 'DROP';
            case 'READER_KNOWN':
                return isOwnedByPov ? 'KEEP' : 'CONVERT_TO_IRONY';
        }
    }

    /** 过滤 PARALLEL 模式下的全局只读广播条目 */
    private filterParallelBroadcast(
        entries: EntityEntry[],
        targetDay: number,
        povSet: Set<string>,
        forRole: SlicerRole,
        stripWarped: boolean
    ): ParallelBroadcastItem[] {
        const result: ParallelBroadcastItem[] = [];
        for (const entry of entries) {
            if (stripWarped && isWarpedEntry(entry)) {
                continue;
            }
            if (entry.storyDay !== undefined && entry.storyDay > targetDay) {
                continue;
            }
            const visDecision = this.evaluateVisibility('__broadcast__', entry, povSet, forRole);
            if (visDecision !== 'KEEP') {
                continue;
            }
            result.push({
                ...cloneEntry(entry),
                readonly: true
            });
        }
        return result;
    }

    /** 构造读者已知的戏剧反讽提示（桌下炸弹） */
    private createIronyHint(
        profile: EntityProfile,
        section: SectionKey,
        entry: EntityEntry
    ): DramaticIronyHint {
        return {
            entityId: profile.metadata.entity_id,
            canonicalName: profile.metadata.canonical_name,
            section,
            text: entry.text,
            storyDay: entry.storyDay,
            chapter: entry.chapter,
            formattedHint: `[仅读者已知的戏剧张力点 / 桌下炸弹 - 当前视角角色不知] ${profile.metadata.canonical_name}: ${entry.text}`
        };
    }

    /** 从已裁剪的实体视图中提取感官记忆唤醒半句提示 */
    private pickSensoryCue(slicedProfile: EntityProfile): string {
        const isPublic = (e: EntityEntry): boolean => (e.visibility ?? 'PUBLIC') === 'PUBLIC';
        const publicLock = slicedProfile.innateLocks.find(isPublic);
        if (publicLock) {
            return extractFirstSentence(publicLock.text);
        }
        const publicState = slicedProfile.acquiredState.find(isPublic);
        if (publicState) {
            return extractFirstSentence(publicState.text);
        }
        return slicedProfile.metadata.canonical_name;
    }
}

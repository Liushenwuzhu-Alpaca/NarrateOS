import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    mergeEntityProfilePatch,
    normalizeForQuoteMatch,
    parseEntityMarkdown,
    assertForeignKeysReachable,
    type ApplyStatePatchOptions,
    type EntityPatch,
    type EntityProfile,
    type NarrateStoreService,
    type TimelineMode,
    type TxState
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { isEnoentError, readOptionalDiskText } from '../tools/shared.js';
import { ExtractorOutputSchema, hasChineseCharacter, type ExtractorOutput } from './schemas.js';
import {
    collectReachableKeysFromBookDirs,
    ENTITY_FILENAME_RE,
    ENTITY_ID_PATTERN_RE,
    hasOmniscientSecretMarker,
    toVisibleEntityMap
} from './shared.js';

export interface YieldStatePatchResult {
    output: ExtractorOutput;
    commitSha?: string | undefined;
    txState?: TxState | undefined;
    updatedEntities: string[];
}

export interface YieldStatePatchOptions {
    store: NarrateStoreService;
    bookRoot: string;
    chapterNumber: number;
    timelineMode?: TimelineMode | undefined;
    allowInnateMutation?: boolean | undefined;
    deferCommit?: boolean | undefined;
    applyOptions?: ApplyStatePatchOptions | undefined;
    draftText?: string | undefined;
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    /** 可选内存可见实体快照视图（如 PARALLEL 分支已暂存但未落盘的实体） */
    visibleEntities?: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile> | undefined;
    /** 可选额外可达外键集合（如 PARALLEL 分支新增实体或章节键） */
    reachableIds?: ReadonlySet<string> | readonly string[] | undefined;
    onYield?: ((result: YieldStatePatchResult) => void) | undefined;
}

async function buildReachableSetForValidation(
    bookRoot: string,
    newEntityIds: Set<string>,
    visibleEntityMap: ReadonlyMap<string, EntityProfile>,
    extraReachableIds?: ReadonlySet<string> | readonly string[]
): Promise<Set<string>> {
    const keys = await collectReachableKeysFromBookDirs(bookRoot);
    for (const id of newEntityIds) {
        keys.add(id);
    }
    for (const id of visibleEntityMap.keys()) {
        keys.add(id);
    }
    if (extraReachableIds) {
        for (const id of extraReachableIds) {
            keys.add(id);
        }
    }
    return keys;
}

async function collectKnownEntityIdsForAppeared(
    bookRoot: string,
    newEntityIds: ReadonlySet<string>,
    visibleEntityMap: ReadonlyMap<string, EntityProfile>,
    extraReachableIds?: ReadonlySet<string> | readonly string[]
): Promise<Set<string>> {
    const ids = new Set<string>(newEntityIds);
    for (const id of visibleEntityMap.keys()) {
        ids.add(id);
    }
    if (extraReachableIds) {
        for (const id of extraReachableIds) {
            if (ENTITY_ID_PATTERN_RE.test(id)) {
                ids.add(id);
            }
        }
    }
    for (const dir of [join(bookRoot, 'entities'), join(bookRoot, 'entities/cold_archive')]) {
        try {
            const files = await readdir(dir);
            for (const file of files) {
                const match = ENTITY_FILENAME_RE.exec(file);
                if (match?.[1]) {
                    ids.add(match[1]);
                }
            }
        } catch (err: unknown) {
            if (!isEnoentError(err)) {
                throw err;
            }
        }
    }
    return ids;
}

async function resolveDraftTextForAnchorCheck(
    bookRoot: string,
    chapterNumber: number,
    explicitDraftText?: string,
    stagingOverlay?: ReadonlyMap<string, string | null>
): Promise<string | undefined> {
    if (explicitDraftText !== undefined) {
        return explicitDraftText;
    }
    const chRel = `manuscripts/ch_${String(chapterNumber).padStart(4, '0')}.md`;
    if (stagingOverlay?.has(chRel)) {
        return stagingOverlay.get(chRel) ?? undefined;
    }
    try {
        return await readFile(join(bookRoot, chRel), 'utf8');
    } catch {
        return undefined;
    }
}

function assertTimelineStatePatchConstraints(
    parsed: ExtractorOutput,
    timelineMode?: TimelineMode
): void {
    if (timelineMode === 'FLASHBACK' && parsed.story_day_delta > 0) {
        throw new GateValidationError(
            'yield_state_patch',
            `${timelineMode} 模式下严禁推进主线 story_day（story_day_delta 必须为 0，收到 ${parsed.story_day_delta}）`
        );
    }

    if (timelineMode !== 'FLASHBACK') {
        return;
    }
    for (const patch of parsed.entity_patches) {
        if (
            (patch.acquired_state_ops && patch.acquired_state_ops.length > 0) ||
            (patch.buffer_ops && patch.buffer_ops.length > 0)
        ) {
            throw new GateValidationError(
                'yield_state_patch',
                `FLASHBACK 插叙模式下严禁修改实体 ${patch.entity_id} 的 2. Acquired State 或 4. Recent Buffer`
            );
        }
    }
}

async function inspectAndValidateEntityPatches(params: {
    bookRoot: string;
    bookStore: ReturnType<NarrateStoreService['openStore']>;
    patches: ExtractorOutput['entity_patches'];
    visibleEntityMap: ReadonlyMap<string, EntityProfile>;
    allowInnateMutation: boolean;
}): Promise<{ newEntityIds: Set<string>; mergedProfiles: Map<string, EntityProfile> }> {
    const { bookRoot, bookStore, patches, visibleEntityMap, allowInnateMutation } = params;
    const newEntityIds = new Set<string>();
    const mergedProfiles = new Map<string, EntityProfile>();

    for (const patch of patches) {
        if (patch.innate_locks_ops) {
            for (const op of patch.innate_locks_ops) {
                if (op.op === 'append' && hasOmniscientSecretMarker(op.entry)) {
                    throw new GateValidationError(
                        'yield_state_patch',
                        `第 1 区 Innate Locks (${patch.entity_id}) 严禁新增 OMNISCIENT_SECRET，请放入第 2 区 Acquired State 并绑定 slot_key`
                    );
                }
            }
        }

        let existing: EntityProfile | null =
            mergedProfiles.get(patch.entity_id) ??
            visibleEntityMap.get(patch.entity_id) ??
            null;

        if (!existing) {
            const diskRaw = await readOptionalDiskText(
                join(bookRoot, 'entities', `${patch.entity_id}.md`)
            );
            existing =
                diskRaw !== null
                    ? parseEntityMarkdown(diskRaw)
                    : await bookStore.readColdArchivedEntity(patch.entity_id);
        }

        if (existing === null) {
            newEntityIds.add(patch.entity_id);
            if (!patch.canonical_name || !hasChineseCharacter(patch.canonical_name)) {
                throw new GateValidationError(
                    'yield_state_patch',
                    `新建实体 ${patch.entity_id} 必须提供包含中文字符的标准名称 canonical_name`
                );
            }
        }

        mergedProfiles.set(patch.entity_id, mergeEntityProfilePatch(existing, patch, allowInnateMutation));
    }

    return { newEntityIds, mergedProfiles };
}

/** 创建 Extractor 终态门禁工具 yield_state_patch（校验中文标准名、固有锁、1ms 外键可达性与 state 原子提交） */
export function createYieldStatePatchTool(options: YieldStatePatchOptions): ToolDefinition {
    const {
        store,
        bookRoot,
        chapterNumber,
        timelineMode,
        allowInnateMutation = false,
        deferCommit = false,
        applyOptions,
        draftText,
        stagingOverlay,
        visibleEntities,
        reachableIds,
        onYield
    } = options;
    const visibleEntityMap = toVisibleEntityMap(visibleEntities);
    let anchorZeroMatchRetries = 0;

    return defineTool({
        name: 'yield_state_patch',
        description:
            'Extractor 终态交接门禁。校验新建实体中文 canonical_name、Innate Locks 防篡改与 1ms 外键可达性，并执行原子 state 提交；全部成功后方结束回合。',
        parameters: {
            entity_patches: {
                type: 'array',
                required: true,
                items: { type: 'json' },
                description: [
                    '实体增量补丁列表 (EntityPatch[])。每项结构：',
                    '{ entity_id: "char_xxx"|"item_xxx", last_seen_ch?: int>=0, canonical_name?: string(新建必填且含中文，既有不可改),',
                    '  add_unique_aliases?: string[], add_contextual_titles?: string[], add_historical_anchors?: string[],',
                    '  buffer_ops?: Array<{ op: "upsert_slot", slot_key: string, entry: Entry } | { op: "append", entry: Entry } | { op: "trim_buffer", max_entries: int>0 }>,',
                    '  acquired_state_ops?: Array<{ op: "upsert_slot", slot_key: string, entry: Entry } | { op: "append", entry: Entry } | { op: "remove_slot", slot_key: string } | { op: "upsert_ledger", entries: Record<string, string|number> }>,',
                    '  trajectory_ops?: Array<{ op: "append", entry: Entry }>,',
                    '  innate_locks_ops?: Array<{ op: "append", entry: Entry } | { op: "remove_slot", slot_key: string }>(仅新建或显式放行可用) }。',
                    '其中 entry 对象结构：{ text: string(必填), storyDay?: int, chapter?: int>=0, visibility?: "SELF_ONLY"|"OMNISCIENT_SECRET"|"PUBLIC"|"READER_KNOWN", owner?: string, status?: "ACTIVE"|"WARPED", slotKey?: string, extraTags?: Record<string, string>, isNumericLedger?: boolean, ledger?: Record<string, string>, continuationLines?: string[] }。',
                    '示例：{"entity_id":"char_001","last_seen_ch":2,"acquired_state_ops":[{"op":"upsert_slot","slot_key":"location","entry":{"storyDay":2,"chapter":2,"visibility":"PUBLIC","text":"位于旧码头仓库"}},{"op":"upsert_ledger","entries":{"随身银元":"15枚"}}],"trajectory_ops":[{"op":"append","entry":{"storyDay":2,"chapter":2,"text":"确认仓库账本被篡改"}}],"buffer_ops":[{"op":"upsert_slot","slot_key":"focus","entry":{"storyDay":2,"chapter":2,"text":"盘查夜班记录"}},{"op":"append","entry":{"storyDay":2,"chapter":2,"text":"与货主核对提单"}},{"op":"trim_buffer","max_entries":8}]}'
                ].join('\n')
            },
            story_day_delta: {
                type: 'integer',
                required: true,
                description: '本章历时（非负整数；PARALLEL 只累计本支线，FLASHBACK 须为 0）'
            },
            plot_summary: {
                type: 'string',
                description: '主干剧情与意图功能义（与 chapter_summary 二选一，推荐提供 plot_summary）'
            },
            chapter_summary: {
                type: 'string',
                description: '兼容字段：L2 章卡主干剧情摘要（与 plot_summary 二选一）'
            },
            prose_anchors: {
                type: 'array',
                items: { type: 'string' },
                description: '0~8 个本章原稿特写的微物件/场景/关键数字原词（须能在正文中去标点命中）'
            },
            appeared_entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description: '本章实际在场但未产生永久状态变更的实体 ID 列表'
            },
            world_summary_markdown: {
                type: 'string',
                description: '可选更新后的 world_state.md 正文摘要'
            },
            next_chapter_options: {
                type: 'array',
                items: { type: 'string' },
                description: '2~3 条自然延续的下一章候选方向'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    updatedEntities: { type: 'array', required: true, items: { type: 'string' } },
                    commitSha: { type: 'string' }
                }
            },
            render(_args, value) {
                const shaPart = value.commitSha ? ` (commit=${value.commitSha.slice(0, 8)})` : '';
                return [
                    {
                        type: 'text',
                        text: `yield_state_patch 门禁通过：更新实体 [${value.updatedEntities.join(', ')}]${shaPart}。`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const parsed = ExtractorOutputSchema.parse(args);

            assertTimelineStatePatchConstraints(parsed, timelineMode);
            if (timelineMode === 'PARALLEL' && !deferCommit) {
                throw new GateValidationError('yield_state_patch', 'PARALLEL 章必须经分支增量暂存，不得直接提交主线');
            }

            // Q1 防死锁原稿锚点验真：首次全 0 命中打回重提；第 2 次或部分命中则自动过滤未命中词放行
            if (parsed.prose_anchors.length > 0) {
                const effectiveDraft = await resolveDraftTextForAnchorCheck(
                    bookRoot,
                    chapterNumber,
                    draftText,
                    stagingOverlay
                );
                if (effectiveDraft !== undefined) {
                    const normalizedDraft = normalizeForQuoteMatch(effectiveDraft);
                    const matchedAnchors = parsed.prose_anchors.filter((anchor) => {
                        const normAnchor = normalizeForQuoteMatch(anchor);
                        return normAnchor.length >= 2 && normalizedDraft.includes(normAnchor);
                    });
                    if (matchedAnchors.length === 0) {
                        if (anchorZeroMatchRetries === 0) {
                            anchorZeroMatchRetries += 1;
                            throw new GateValidationError(
                                'yield_state_patch',
                                'prose_anchors 中的微物件/数字锚点均未在本章正文命中，请从正文逐字摘取 0~8 个原词重试'
                            );
                        }
                        parsed.prose_anchors = [];
                    } else {
                        parsed.prose_anchors = matchedAnchors;
                    }
                }
            }

            const bookStore = store.openStore(bookRoot);
            // 预检新建实体中文 canonical_name、Q7 第1区禁 OMNISCIENT_SECRET 与既有/冷宫实体 Innate Locks
            const { newEntityIds, mergedProfiles } = await inspectAndValidateEntityPatches({
                bookRoot,
                bookStore,
                patches: parsed.entity_patches,
                visibleEntityMap,
                allowInnateMutation
            });

            if (parsed.appeared_entity_ids.length > 0) {
                const validAppearedSet = await collectKnownEntityIdsForAppeared(
                    bookRoot,
                    newEntityIds,
                    visibleEntityMap,
                    reachableIds
                );
                for (const appearedId of parsed.appeared_entity_ids) {
                    if (!validAppearedSet.has(appearedId)) {
                        throw new GateValidationError(
                            'yield_state_patch',
                            `appeared_entity_ids 引用了未建档且非本轮新建的实体 ID: ${appearedId}`
                        );
                    }
                }
            }

            const patches = parsed.entity_patches as EntityPatch[];

            if (deferCommit) {
                // 延迟提交模式：仍须执行 1ms 外键可达性校验以确保零脏数据入库
                const reachable = await buildReachableSetForValidation(
                    bookRoot,
                    newEntityIds,
                    visibleEntityMap,
                    reachableIds
                );
                for (const [id, profile] of mergedProfiles) {
                    assertForeignKeysReachable(id, profile, reachable);
                }

                const result: YieldStatePatchResult = {
                    output: parsed,
                    updatedEntities: patches.map((p) => p.entity_id)
                };
                onYield?.(result);
                exec.concludeTurn();
                return {
                    accepted: true,
                    updatedEntities: result.updatedEntities
                };
            }

            let effectiveWorldUpdate = applyOptions?.worldStateUpdate;
            if (
                effectiveWorldUpdate === undefined &&
                (parsed.story_day_delta > 0 || parsed.world_summary_markdown !== undefined)
            ) {
                const currentWorld = await bookStore.readWorldState();
                effectiveWorldUpdate = {
                    story_day: currentWorld.frontmatter.story_day + parsed.story_day_delta,
                    current_chapter: Math.max(currentWorld.frontmatter.current_chapter, chapterNumber),
                    ...(parsed.world_summary_markdown !== undefined
                        ? { summaryMarkdown: parsed.world_summary_markdown }
                        : {})
                };
            }

            const commitRes = await bookStore.applyStatePatch(chapterNumber, patches, {
                ...applyOptions,
                allowInnateMutation,
                ...(effectiveWorldUpdate !== undefined ? { worldStateUpdate: effectiveWorldUpdate } : {})
            });

            const result: YieldStatePatchResult = {
                output: parsed,
                commitSha: commitRes.sha,
                txState: commitRes.txState,
                updatedEntities: commitRes.updatedEntities
            };
            onYield?.(result);
            exec.concludeTurn();

            return {
                accepted: true,
                updatedEntities: commitRes.updatedEntities,
                commitSha: commitRes.sha
            };
        }
    });
}

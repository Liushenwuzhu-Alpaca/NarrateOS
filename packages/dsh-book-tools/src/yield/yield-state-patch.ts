import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    ForeignKeyError,
    InnateLockViolationError,
    parseEntityMarkdown,
    serializeEntityMarkdown,
    type ApplyStatePatchOptions,
    type EntityPatch,
    type EntityProfile,
    type NarrateStoreService,
    type TimelineMode,
    type TxState
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { ExtractorOutputSchema, hasChineseCharacter, type ExtractorOutput } from './schemas.js';

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
    /** 可选内存可见实体快照视图（如 PARALLEL 分支已暂存但未落盘的实体） */
    visibleEntities?: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile> | undefined;
    /** 可选额外可达外键集合（如 PARALLEL 分支新增实体或章节键） */
    reachableIds?: ReadonlySet<string> | readonly string[] | undefined;
    onYield?: ((result: YieldStatePatchResult) => void) | undefined;
}

function toVisibleEntityMap(
    input: YieldStatePatchOptions['visibleEntities']
): ReadonlyMap<string, EntityProfile> {
    if (!input) {
        return new Map();
    }
    if (input instanceof Map) {
        return input;
    }
    return new Map(Object.entries(input as Record<string, EntityProfile>));
}

async function buildReachableSetForValidation(
    bookRoot: string,
    newEntityIds: Set<string>,
    visibleEntityMap: ReadonlyMap<string, EntityProfile>,
    extraReachableIds?: ReadonlySet<string> | readonly string[]
): Promise<Set<string>> {
    const keys = new Set<string>(newEntityIds);
    for (const id of visibleEntityMap.keys()) {
        keys.add(id);
    }
    if (extraReachableIds) {
        for (const id of extraReachableIds) {
            keys.add(id);
        }
    }
    const collect = async (dirPath: string) => {
        try {
            const files = await readdir(dirPath);
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const base = file.slice(0, -3);
                keys.add(base);
                const sagaMatch = /^((?:char|item)_[a-zA-Z0-9_]+?)_saga_\d+$/.exec(base);
                if (sagaMatch?.[1]) {
                    keys.add(sagaMatch[1]);
                }
            }
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
        }
    };
    await Promise.all([
        collect(join(bookRoot, 'entities')),
        collect(join(bookRoot, 'entities/cold_archive')),
        collect(join(bookRoot, 'manuscripts'))
    ]);
    return keys;
}

function assertTextForeignKeys(sourceId: string, text: string, reachable: Set<string>): void {
    const missing = new Set<string>();
    for (const match of text.matchAll(/\b(char_[a-zA-Z0-9_]+|item_[a-zA-Z0-9_]+|ch_\d{4})\b/g)) {
        const refId = match[1];
        if (refId && !reachable.has(refId)) {
            missing.add(refId);
        }
    }
    if (missing.size > 0) {
        throw new ForeignKeyError([...missing], sourceId);
    }
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
        visibleEntities,
        reachableIds,
        onYield
    } = options;
    const visibleEntityMap = toVisibleEntityMap(visibleEntities);

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
                description: '本章推进的故事天数增量（非负整数；PARALLEL/FLASHBACK 须为 0）'
            },
            chapter_summary: {
                type: 'string',
                required: true,
                description: '双轨 L2 章卡摘要（含主干剧情与异象锚点）'
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

            if ((timelineMode === 'PARALLEL' || timelineMode === 'FLASHBACK') && parsed.story_day_delta > 0) {
                throw new GateValidationError(
                    'yield_state_patch',
                    `${timelineMode} 模式下严禁推进主线 story_day（story_day_delta 必须为 0，收到 ${parsed.story_day_delta}）`
                );
            }

            const newEntityIds = new Set<string>();
            const existingProfiles = new Map<string, EntityProfile>();

            // 预检新建实体中文 canonical_name 与既有实体 Innate Locks（优先结合内存分支可见快照）
            for (const patch of parsed.entity_patches) {
                let existing: EntityProfile | null =
                    existingProfiles.get(patch.entity_id) ??
                    visibleEntityMap.get(patch.entity_id) ??
                    null;

                if (!existing) {
                    const entityPath = join(bookRoot, 'entities', `${patch.entity_id}.md`);
                    let diskRaw: string | null = null;
                    try {
                        diskRaw = await readFile(entityPath, 'utf8');
                    } catch (err: unknown) {
                        if ((err as { code?: string }).code !== 'ENOENT') {
                            throw err;
                        }
                    }
                    if (diskRaw !== null) {
                        existing = parseEntityMarkdown(diskRaw);
                    }
                }

                if (existing === null) {
                    newEntityIds.add(patch.entity_id);
                    if (!patch.canonical_name || !hasChineseCharacter(patch.canonical_name)) {
                        throw new GateValidationError(
                            'yield_state_patch',
                            `新建实体 ${patch.entity_id} 必须提供包含中文字符的标准名称 canonical_name`
                        );
                    }
                } else {
                    existingProfiles.set(patch.entity_id, existing);
                    if (
                        !allowInnateMutation &&
                        patch.canonical_name !== undefined &&
                        patch.canonical_name !== existing.metadata.canonical_name
                    ) {
                        throw new InnateLockViolationError(
                            patch.entity_id,
                            `禁止篡改既有实体 ${patch.entity_id} 的 canonical_name`
                        );
                    }
                    if (!allowInnateMutation && patch.innate_locks_ops && patch.innate_locks_ops.length > 0) {
                        throw new InnateLockViolationError(
                            patch.entity_id,
                            `禁止篡改既有实体 ${patch.entity_id} 的 1. Innate Locks`
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
                for (const patch of patches) {
                    const serializedPatch = JSON.stringify(patch);
                    assertTextForeignKeys(patch.entity_id, serializedPatch, reachable);
                    const existing = existingProfiles.get(patch.entity_id);
                    if (existing) {
                        assertTextForeignKeys(patch.entity_id, serializeEntityMarkdown(existing), reachable);
                    }
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

            const bookStore = store.openStore(bookRoot);

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

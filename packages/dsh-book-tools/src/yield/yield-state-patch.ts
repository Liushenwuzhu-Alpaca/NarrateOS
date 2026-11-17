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
    onYield?: ((result: YieldStatePatchResult) => void) | undefined;
}

async function buildReachableSetForValidation(
    bookRoot: string,
    newEntityIds: Set<string>
): Promise<Set<string>> {
    const keys = new Set<string>(newEntityIds);
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
        onYield
    } = options;

    return defineTool({
        name: 'yield_state_patch',
        description:
            'Extractor 终态交接门禁。校验新建实体中文 canonical_name、Innate Locks 防篡改与 1ms 外键可达性，并执行原子 state 提交；全部成功后方结束回合。',
        parameters: {
            entity_patches: {
                type: 'array',
                required: true,
                items: { type: 'json' },
                description: '实体增量补丁列表 (EntityPatch[])'
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

            // 预检新建实体中文 canonical_name 与既有实体 Innate Locks
            for (const patch of parsed.entity_patches) {
                const entityPath = join(bookRoot, 'entities', `${patch.entity_id}.md`);
                let diskRaw: string | null = null;
                try {
                    diskRaw = await readFile(entityPath, 'utf8');
                } catch (err: unknown) {
                    if ((err as { code?: string }).code !== 'ENOENT') {
                        throw err;
                    }
                }

                if (diskRaw === null) {
                    newEntityIds.add(patch.entity_id);
                    if (!patch.canonical_name || !hasChineseCharacter(patch.canonical_name)) {
                        throw new GateValidationError(
                            'yield_state_patch',
                            `新建实体 ${patch.entity_id} 必须提供包含中文字符的标准名称 canonical_name`
                        );
                    }
                } else {
                    const existing = parseEntityMarkdown(diskRaw);
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
                const reachable = await buildReachableSetForValidation(bookRoot, newEntityIds);
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

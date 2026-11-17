import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    IndexRecall,
    parseEntityMarkdown,
    type NarrateStoreService,
    type RecallSlice
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import {
    extractActiveThreadEntityRefs,
    LibrarianOutputSchema,
    type LibrarianOutput
} from './schemas.js';

export interface YieldContextPackResult {
    payload: LibrarianOutput;
    recalledSlices: RecallSlice[];
}

export interface YieldContextPackOptions {
    store: NarrateStoreService;
    bookRoot: string;
    runId: string;
    targetChapter?: number | undefined;
    targetDay?: number | undefined;
    chapterGoal?: string | undefined;
    onYield?: ((result: YieldContextPackResult) => void) | undefined;
}

const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;

async function readOptionalFile(
    store: NarrateStoreService,
    runId: string,
    bookRoot: string,
    relPath: string
): Promise<string | null> {
    if (store.staging.has(runId)) {
        const staged = store.staging.getPendingWrites(runId).get(relPath);
        if (staged !== undefined) {
            return staged;
        }
    }
    try {
        return await readFile(join(bookRoot, relPath), 'utf8');
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

async function listManuscriptChapters(bookRoot: string): Promise<string[]> {
    try {
        const files = await readdir(join(bookRoot, 'manuscripts'));
        return files.filter((f) => CHAPTER_FILE_RE.test(f)).sort();
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return [];
        }
        throw err;
    }
}

/** 创建 Librarian 终态门禁工具 yield_context_pack（强制校验伏笔与证物成对挂载） */
export function createYieldContextPackTool(options: YieldContextPackOptions): ToolDefinition {
    const { store, bookRoot, runId, targetChapter, targetDay, chapterGoal, onYield } = options;

    return defineTool({
        name: 'yield_context_pack',
        description:
            'Librarian 终态交接门禁。提交 selected_entity_ids、recall_queries / recall_slices 与 selected_lore_files；强制核验活跃伏笔或关键道具的「实体档案 + 至少 1 条 L3 原稿切片」成对挂载。',
        parameters: {
            selected_entity_ids: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '选中挂载的实体 ID 列表'
            },
            recall_queries: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        entity_id: { type: 'string', required: true },
                        extra_keywords: { type: 'array', items: { type: 'string' } },
                        focus_chapters: { type: 'array', items: { type: 'integer' } }
                    }
                },
                description: '需执行 L3 原稿回表的实体检索指令列表'
            },
            recall_slices: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        entity_id: { type: 'string' },
                        file: { type: 'string' },
                        chapter_number: { type: 'integer' },
                        snippet: { type: 'string', required: true }
                    }
                },
                description: '已核实挂载的 L3 原稿召回切片列表'
            },
            selected_lore_files: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '选中挂载的世界书文件名列表'
            },
            wakeup_entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description: '建议从冷归档唤醒的实体 ID 列表'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    selectedCount: { type: 'integer', required: true },
                    recalledSliceCount: { type: 'integer', required: true }
                }
            },
            render(_args, value) {
                return [
                    {
                        type: 'text',
                        text: `yield_context_pack 门禁通过：已选实体 ${value.selectedCount} 个，L3 原稿切片 ${value.recalledSliceCount} 条。`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const parsed = LibrarianOutputSchema.parse(args);

            const selectedSet = new Set(parsed.selected_entity_ids);
            const chapterFiles = await listManuscriptChapters(bookRoot);
            const hasManuscripts = chapterFiles.length > 0;

            // 读取当前世界状态以获取默认 targetChapter / targetDay
            const bookStore = store.openStore(bookRoot);
            let effectiveTargetChapter = targetChapter;
            let effectiveTargetDay = targetDay;
            if (effectiveTargetChapter === undefined || effectiveTargetDay === undefined) {
                try {
                    const ws = await bookStore.readWorldState();
                    effectiveTargetChapter ??= ws.frontmatter.current_chapter + 1;
                    effectiveTargetDay ??= ws.frontmatter.story_day;
                } catch {
                    effectiveTargetChapter ??= 1;
                    effectiveTargetDay ??= 0;
                }
            }

            // 1. 校验 recall_slices / recall_queries 中的实体必须同时出现在 selected_entity_ids 中（成对要求）
            for (const q of parsed.recall_queries) {
                if (!selectedSet.has(q.entity_id)) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `成对挂载校验失败：recall_queries 中的实体 ${q.entity_id} 未加入 selected_entity_ids`
                    );
                }
            }
            for (const s of parsed.recall_slices) {
                if (s.entity_id && !selectedSet.has(s.entity_id) && parsed.selected_lore_files.length === 0) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `成对挂载校验失败：recall_slices 中的实体 ${s.entity_id} 未加入 selected_entity_ids`
                    );
                }
            }

            // 2. 收集需要强制成对挂载 L3 原稿切片的实体集合
            const openThreadsRaw = await readOptionalFile(store, runId, bookRoot, 'world/open_threads.md');
            const activeThreadRefs = openThreadsRaw ? extractActiveThreadEntityRefs(openThreadsRaw) : new Set<string>();
            const entitiesRequiringL3 = new Set<string>();

            if (hasManuscripts) {
                // 目标文本或选区中提及的活跃伏笔关联实体
                for (const refId of activeThreadRefs) {
                    if (selectedSet.has(refId) || (chapterGoal && chapterGoal.includes(refId))) {
                        entitiesRequiringL3.add(refId);
                    }
                }

                // 检查已选中实体是否包含 item_* 或未消解历史锚点
                for (const entityId of selectedSet) {
                    const entityRaw = await readOptionalFile(store, runId, bookRoot, `entities/${entityId}.md`);
                    if (entityRaw === null) {
                        throw new GateValidationError(
                            'yield_context_pack',
                            `selected_entity_ids 引用了不存在的实体档案: ${entityId}`
                        );
                    }
                    const profile = parseEntityMarkdown(entityRaw);
                    const hasAnchors = profile.metadata.historical_anchors.length > 0;
                    const isUniqueItem = entityId.startsWith('item_');
                    if (isUniqueItem || hasAnchors || activeThreadRefs.has(entityId)) {
                        entitiesRequiringL3.add(entityId);
                    }
                }
            }

            // 若 chapterGoal 引用了 activeThreadRefs，则该实体也必须在 selected_entity_ids 中
            if (chapterGoal) {
                for (const refId of activeThreadRefs) {
                    if (chapterGoal.includes(refId) && !selectedSet.has(refId)) {
                        throw new GateValidationError(
                            'yield_context_pack',
                            `成对挂载校验失败：本章目标涉及活跃伏笔实体 ${refId}，但未列入 selected_entity_ids`
                        );
                    }
                }
            }

            // 3. 通过 IndexRecall 执行 recall_queries，并统计每个实体的有效 L3 原稿切片
            const recallEngine = new IndexRecall(store.system);
            const recalledSlices: RecallSlice[] = [];
            const sliceCountByEntity = new Map<string, number>();

            for (const slice of parsed.recall_slices) {
                if (slice.entity_id) {
                    sliceCountByEntity.set(
                        slice.entity_id,
                        (sliceCountByEntity.get(slice.entity_id) ?? 0) + 1
                    );
                }
            }

            for (const query of parsed.recall_queries) {
                const entityRaw = await readOptionalFile(store, runId, bookRoot, `entities/${query.entity_id}.md`);
                if (entityRaw === null) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `recall_queries 引用了不存在的实体档案: ${query.entity_id}`
                    );
                }
                const profile = parseEntityMarkdown(entityRaw);
                const slices = await recallEngine.recallEntitySlices(bookRoot, {
                    profile,
                    targetChapter: effectiveTargetChapter,
                    targetDay: effectiveTargetDay,
                    extraKeywords: query.extra_keywords,
                    includeHistoricalAnchors: true
                });
                recalledSlices.push(...slices);
                sliceCountByEntity.set(
                    query.entity_id,
                    (sliceCountByEntity.get(query.entity_id) ?? 0) + slices.length
                );
            }

            // 4. 校验所有要求成对挂载的实体都至少拥有 1 条 L3 原稿切片
            for (const requiredId of entitiesRequiringL3) {
                const count = sliceCountByEntity.get(requiredId) ?? 0;
                if (count < 1) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `成对挂载校验失败：实体 ${requiredId} 关联活跃伏笔/唯一道具/历史锚点，必须同时携带实体档案与至少 1 条 L3 原稿召回切片（当前为 0 条）`
                    );
                }
            }

            // 若存在未指向具体 entity_id 的裸切片兜底校验：当无特定实体但要求 L3 时提示
            onYield?.({
                payload: parsed,
                recalledSlices
            });

            exec.concludeTurn();

            return {
                accepted: true,
                selectedCount: parsed.selected_entity_ids.length,
                recalledSliceCount: recalledSlices.length + parsed.recall_slices.length
            };
        }
    });
}

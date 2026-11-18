import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrateStoreService } from '@narrateos/dsh-book-store';
import { PathFence } from './path-fence.js';
import type { ReadQuotaCounter } from './read-quota.js';
import { readContentWithStagingPriority } from './shared.js';

const MAX_BATCH_READ_PATHS = 8;

export interface BookReadItem {
    path: string;
    content: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    fromStaging: boolean;
}

export interface BookReadToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
    quota: ReadQuotaCounter;
    /** 可选内存分支覆盖层（如 PARALLEL 分支视角）；优先读本 runId 暂存，其次读该覆盖层 */
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
}

/** 保序去重路径列表 */
function dedupeStringsPreserveOrder(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            result.push(value);
        }
    }
    return result;
}

function sliceLinesByOffsetLimit(
    rawText: string,
    offset?: number,
    limit?: number
): { content: string; totalLines: number; startLine: number; endLine: number } {
    const allLines = rawText.split(/\r?\n/);
    const totalLines = allLines.length;
    const startLine = offset ?? 1;

    if (offset === undefined && limit === undefined) {
        return {
            content: rawText,
            totalLines,
            startLine,
            endLine: Math.max(startLine - 1, totalLines)
        };
    }

    const sliceEnd = limit !== undefined ? startLine - 1 + limit : undefined;
    const endLine = Math.min(totalLines, startLine - 1 + (limit ?? totalLines));
    return {
        content: allLines.slice(startLine - 1, sliceEnd).join('\n'),
        totalLines,
        startLine,
        endLine: Math.max(startLine - 1, endLine)
    };
}

/** 读取单个已通过 PathFence 校验的目标文件并按 offset/limit 切片 */
async function readSingleTarget(
    store: NarrateStoreService,
    runId: string,
    target: { normalized: string; absPath: string },
    offset?: number,
    limit?: number,
    stagingOverlay?: ReadonlyMap<string, string | null>
): Promise<BookReadItem> {
    const { content: rawText, fromStaging } = await readContentWithStagingPriority({
        store,
        runId,
        normalizedPath: target.normalized,
        absPath: target.absPath,
        stagingOverlay,
        missingInOverlayMessage: `文件在当前分支视图中不存在或不可见: ${target.normalized}`
    });
    const sliced = sliceLinesByOffsetLimit(rawText, offset, limit);

    return {
        path: target.normalized,
        content: sliced.content,
        totalLines: sliced.totalLines,
        startLine: sliced.startLine,
        endLine: sliced.endLine,
        fromStaging
    };
}

/** 创建受控作品只读工具 book_read（优先读取当前 runId 的 StagingSession 暂存覆盖层，支持单文件与最多 8 路批量读取） */
export function createBookReadTool(options: BookReadToolOptions): ToolDefinition {
    const { store, runId, fence, quota, stagingOverlay } = options;

    return defineTool({
        name: 'book_read',
        description:
            '受控读取作品文件（限 world/、lore_library/、index/、entities/、manuscripts/）。支持 path 单文件读取或 paths 批量读取（最多 8 个路径，自动去重且仅消耗 1 次配额）。优先读取当前 runId 的暂存修改（Read-Your-Own-Writes），禁止读取 .ops/、.git/ 或越界路径。',
        parameters: {
            path: {
                type: 'string',
                description: '单文件读取时的作品内相对路径，例如 world/open_threads.md（与 paths 二选一）'
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: '批量读取的作品内相对路径列表（最多 8 个，保序去重），仅消耗 1 次只读配额（与 path 二选一）'
            },
            offset: {
                type: 'integer',
                description: '可选起始行号（1-based，默认 1）'
            },
            limit: {
                type: 'integer',
                description: '可选最多读取行数'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', required: true },
                    content: { type: 'string', required: true },
                    totalLines: { type: 'integer', required: true },
                    startLine: { type: 'integer', required: true },
                    endLine: { type: 'integer', required: true },
                    fromStaging: { type: 'boolean', required: true },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                content: { type: 'string', required: true },
                                totalLines: { type: 'integer', required: true },
                                startLine: { type: 'integer', required: true },
                                endLine: { type: 'integer', required: true },
                                fromStaging: { type: 'boolean', required: true }
                            }
                        }
                    }
                }
            },
            render(_args, value) {
                if (value.items && value.items.length > 1) {
                    return [{ type: 'text', text: value.content }];
                }
                const header = `path: ${value.path} (lines ${value.startLine}-${value.endLine} of ${value.totalLines}, staging=${String(value.fromStaging)})`;
                return [{ type: 'text', text: `${header}\n\n${value.content}` }];
            }
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            if (args.offset !== undefined && args.offset < 1) {
                throw new Error(`book_read 的 offset 必须 >= 1，收到: ${args.offset}`);
            }
            if (args.limit !== undefined && args.limit < 1) {
                throw new Error(`book_read 的 limit 必须 >= 1，收到: ${args.limit}`);
            }

            const requestedPaths: string[] = [];
            if (args.path !== undefined) {
                requestedPaths.push(args.path);
            }
            if (args.paths !== undefined) {
                requestedPaths.push(...args.paths);
            }
            if (requestedPaths.length === 0) {
                throw new Error('book_read 需要提供 path 或非空 paths 参数');
            }

            // 1. 原始路径保序去重后校验数量上限（超限时不消耗配额）
            const dedupedRaw = dedupeStringsPreserveOrder(requestedPaths);
            if (dedupedRaw.length > MAX_BATCH_READ_PATHS) {
                throw new Error(
                    `book_read 单次最多读取 ${MAX_BATCH_READ_PATHS} 个路径，收到 ${dedupedRaw.length} 个`
                );
            }

            // 2. 必须在消耗 ReadQuotaCounter 前对全部目标路径逐一执行 PathFence 校验
            const verifiedTargets: Array<{ normalized: string; absPath: string }> = [];
            const seenNormalized = new Set<string>();
            for (const rawPath of dedupedRaw) {
                exec.signal.throwIfAborted();
                const verified = await fence.assertReadFile(rawPath);
                if (!seenNormalized.has(verified.normalized)) {
                    seenNormalized.add(verified.normalized);
                    verifiedTargets.push(verified);
                }
            }

            // 3. 全部围栏校验通过后，仅消耗 1 次只读配额
            quota.consume('book_read');

            // 4. 逐一读取并保持兼容返回结构
            const items: BookReadItem[] = [];
            for (const target of verifiedTargets) {
                exec.signal.throwIfAborted();
                items.push(
                    await readSingleTarget(store, runId, target, args.offset, args.limit, stagingOverlay)
                );
            }

            const first = items[0]!;
            if (args.paths === undefined && items.length === 1) {
                return first;
            }

            if (items.length === 1) {
                return {
                    ...first,
                    items
                };
            }

            const combinedContent = items
                .map((item) => {
                    const header = `=== ${item.path} (lines ${item.startLine}-${item.endLine} of ${item.totalLines}, staging=${String(item.fromStaging)}) ===`;
                    return `${header}\n${item.content}`;
                })
                .join('\n\n');

            // 多文件批量时顶层 startLine/endLine 以首项为准，避免跨文件行号失真累加；各文件精确范围保留在 items 中
            return {
                path: items.map((item) => item.path).join(', '),
                content: combinedContent,
                totalLines: items.reduce((sum, item) => sum + item.totalLines, 0),
                startLine: first.startLine,
                endLine: first.endLine,
                fromStaging: items.some((item) => item.fromStaging),
                items
            };
        }
    });
}

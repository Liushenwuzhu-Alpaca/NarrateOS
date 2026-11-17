import { readFile } from 'node:fs/promises';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrateStoreService } from '@narrateos/dsh-book-store';
import { PathFence } from './path-fence.js';
import type { ReadQuotaCounter } from './read-quota.js';

export interface BookReadToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
    quota: ReadQuotaCounter;
}

/** 创建受控作品只读工具 book_read（优先读取当前 runId 的 StagingSession 暂存覆盖层） */
export function createBookReadTool(options: BookReadToolOptions): ToolDefinition {
    const { store, runId, fence, quota } = options;

    return defineTool({
        name: 'book_read',
        description:
            '受控读取作品文件（限 world/、lore_library/、index/、entities/、manuscripts/）。优先读取当前 runId 的暂存修改（Read-Your-Own-Writes），禁止读取 .ops/、.git/ 或越界路径。',
        parameters: {
            path: {
                type: 'string',
                required: true,
                description: '作品内相对路径，例如 world/open_threads.md'
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
                    fromStaging: { type: 'boolean', required: true }
                }
            },
            render(_args, value) {
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

            const { normalized, absPath } = await fence.assertReadFile(args.path);
            quota.consume('book_read');

            let rawText: string;
            let fromStaging = false;
            if (store.staging.has(runId)) {
                fromStaging = store.staging.getPendingWrites(runId).has(normalized);
                rawText = await store.staging.read(runId, normalized);
            } else {
                rawText = await readFile(absPath, 'utf8');
            }

            const allLines = rawText.split(/\r?\n/);
            const totalLines = allLines.length;
            const startLine = args.offset ?? 1;
            const sliced =
                args.offset === undefined && args.limit === undefined
                    ? rawText
                    : allLines
                          .slice(startLine - 1, args.limit !== undefined ? startLine - 1 + args.limit : undefined)
                          .join('\n');
            const endLine =
                args.offset === undefined && args.limit === undefined
                    ? totalLines
                    : Math.min(totalLines, startLine - 1 + (args.limit ?? totalLines));

            return {
                path: normalized,
                content: sliced,
                totalLines,
                startLine,
                endLine: Math.max(startLine - 1, endLine),
                fromStaging
            };
        }
    });
}

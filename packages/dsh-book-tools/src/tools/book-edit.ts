import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrateStoreService } from '@narrateos/dsh-book-store';
import { PathFence } from './path-fence.js';

export interface BookEditToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
}

/** 创建隔离暂存编辑工具 book_edit（仅写入 runId 独占 StagingSession，严禁修改 manuscripts/ 与磁盘文件） */
export function createBookEditTool(options: BookEditToolOptions): ToolDefinition {
    const { store, runId, fence } = options;

    return defineTool({
        name: 'book_edit',
        description:
            '在当前 runId 的隔离内存暂存区中编辑或写入作品资产（world/、lore_library/、index/、entities/）。严禁修改 manuscripts/ 或 .ops/，不会直接写入磁盘。',
        parameters: {
            path: {
                type: 'string',
                required: true,
                description: '目标文件相对路径，例如 world/open_threads.md'
            },
            target_text: {
                type: 'string',
                description: '待替换的精确原文片段（mode=replace 时必填）'
            },
            replacement_text: {
                type: 'string',
                required: true,
                description: '替换后的文本（mode=write 时为完整文件内容）'
            },
            mode: {
                type: 'string',
                enum: ['replace', 'write'],
                description: '编辑模式：replace 精确替换（默认），write 全文写入暂存'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    path: { type: 'string', required: true },
                    staged: { type: 'boolean', required: true },
                    mode: { type: 'string', required: true },
                    bytes: { type: 'integer', required: true }
                }
            },
            render(_args, value) {
                return [
                    {
                        type: 'text',
                        text: `已写入暂存区 (${value.mode}): ${value.path} (${value.bytes} bytes)`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const { normalized } = await fence.assertWriteFile(args.path);
            if (!store.staging.has(runId)) {
                throw new Error(`暂存会话未初始化 (runId=${runId})，无法执行 book_edit`);
            }

            const mode = args.mode ?? 'replace';
            let nextContent: string;
            if (mode === 'write') {
                store.staging.stageWrite(runId, normalized, args.replacement_text);
                nextContent = args.replacement_text;
            } else {
                if (args.target_text === undefined || args.target_text.length === 0) {
                    throw new Error('book_edit 在 replace 模式下必须提供非空 target_text');
                }
                nextContent = await store.staging.edit(
                    runId,
                    normalized,
                    args.target_text,
                    args.replacement_text
                );
            }

            return {
                path: normalized,
                staged: true,
                mode,
                bytes: Buffer.byteLength(nextContent, 'utf8')
            };
        }
    });
}

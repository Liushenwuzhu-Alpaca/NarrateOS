import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrateStoreService } from '@narrateos/dsh-book-store';
import { PathFence } from './path-fence.js';
import type { ReadQuotaCounter } from './read-quota.js';

const execFileAsync = promisify(execFile);

export interface BookGrepToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
    quota: ReadQuotaCounter;
}

interface GrepMatchItem {
    file: string;
    line: number;
    text: string;
    contextBefore: string[];
    contextAfter: string[];
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function grepTextInMemory(
    relPath: string,
    content: string,
    pattern: string,
    fixedStrings: boolean,
    contextLines: number
): GrepMatchItem[] {
    const lines = content.split(/\r?\n/);
    const matcher = fixedStrings
        ? new RegExp(escapeRegExp(pattern))
        : new RegExp(pattern);
    const matches: GrepMatchItem[] = [];

    for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i] ?? '';
        if (!matcher.test(lineText)) {
            continue;
        }
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length, i + contextLines + 1);
        matches.push({
            file: relPath,
            line: i + 1,
            text: lineText,
            contextBefore: lines.slice(start, i),
            contextAfter: lines.slice(i + 1, end)
        });
    }
    return matches;
}

function matchesSearchScope(relPath: string, allowedDirs: string[]): boolean {
    return allowedDirs.some((scope) => relPath === scope || relPath.startsWith(`${scope}/`));
}

/** 创建受控全文检索工具 book_grep（底层调用 rg 且锁死于允许目录内） */
export function createBookGrepTool(options: BookGrepToolOptions): ToolDefinition {
    const { store, runId, fence, quota } = options;

    return defineTool({
        name: 'book_grep',
        description:
            '在作品允许目录（world/、lore_library/、index/、entities/、manuscripts/）内执行受控 ripgrep 检索，物理屏蔽 .ops/、.git/ 及跨书路径。',
        parameters: {
            pattern: {
                type: 'string',
                required: true,
                description: '检索关键字或正则表达式'
            },
            path: {
                type: 'string',
                description: '可选限定子目录或文件（必须位于允许目录内）'
            },
            context_lines: {
                type: 'integer',
                description: '命中行上下文扩展行数（0..10，默认 2）'
            },
            fixed_strings: {
                type: 'boolean',
                description: '是否按字面量匹配（默认 false）'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    matches: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                file: { type: 'string', required: true },
                                line: { type: 'integer', required: true },
                                text: { type: 'string', required: true },
                                contextBefore: { type: 'array', required: true, items: { type: 'string' } },
                                contextAfter: { type: 'array', required: true, items: { type: 'string' } }
                            }
                        }
                    },
                    totalMatches: { type: 'integer', required: true }
                }
            },
            render(_args, value) {
                if (value.matches.length === 0) {
                    return [{ type: 'text', text: '未找到匹配内容 (0 matches)' }];
                }
                const formatted = value.matches
                    .map((m) => `${m.file}:${m.line}: ${m.text}`)
                    .join('\n');
                return [{ type: 'text', text: `共命中 ${value.totalMatches} 处:\n${formatted}` }];
            }
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            if (args.pattern.length === 0) {
                throw new Error('book_grep 的 pattern 不能为空');
            }
            const contextLines = args.context_lines ?? 2;
            if (contextLines < 0 || contextLines > 10) {
                throw new Error(`book_grep 的 context_lines 必须在 0..10 之间，收到: ${contextLines}`);
            }
            const fixedStrings = args.fixed_strings ?? false;

            const scope = await fence.assertReadSearchScope(args.path);
            quota.consume('book_grep');

            const existingTargets: string[] = [];
            for (const dir of scope.allowedDirs) {
                try {
                    await lstat(join(fence.bookRoot, dir));
                    if (await fence.isRealPathInsideRoot(dir)) {
                        existingTargets.push(dir);
                    }
                } catch (err: unknown) {
                    if ((err as { code?: string }).code !== 'ENOENT') {
                        throw err;
                    }
                }
            }

            const diskMatches: GrepMatchItem[] = [];
            if (existingTargets.length > 0) {
                const rgArgs = [
                    '--json',
                    '--no-follow',
                    '-C',
                    String(contextLines),
                    '--glob',
                    '!.git/**'
                ];
                if (fixedStrings) {
                    rgArgs.push('-F');
                }
                rgArgs.push('--', args.pattern, ...existingTargets);

                let stdout = '';
                try {
                    const res = await execFileAsync('rg', rgArgs, {
                        cwd: fence.bookRoot,
                        encoding: 'utf8',
                        maxBuffer: 16 * 1024 * 1024,
                        signal: exec.signal
                    });
                    stdout = res.stdout;
                } catch (err: unknown) {
                    const execErr = err as { code?: number };
                    if (execErr.code !== 1) {
                        throw err;
                    }
                }

                if (stdout.length > 0) {
                    let pendingBefore: string[] = [];
                    let activeMatch: GrepMatchItem | null = null;
                    const flush = () => {
                        if (activeMatch) {
                            diskMatches.push(activeMatch);
                            activeMatch = null;
                        }
                    };

                    for (const rawLine of stdout.split('\n')) {
                        if (!rawLine.trim()) continue;
                        const evt = JSON.parse(rawLine) as {
                            type: string;
                            data?: {
                                path?: { text?: string };
                                line_number?: number;
                                lines?: { text?: string };
                            };
                        };
                        if (evt.type === 'begin' || evt.type === 'end') {
                            flush();
                            pendingBefore = [];
                            continue;
                        }
                        const lineText = (evt.data?.lines?.text ?? '').replace(/\r?\n$/, '');
                        if (evt.type === 'context') {
                            if (activeMatch) {
                                activeMatch.contextAfter.push(lineText);
                            } else {
                                pendingBefore.push(lineText);
                            }
                        } else if (evt.type === 'match') {
                            flush();
                            activeMatch = {
                                file: (evt.data?.path?.text ?? '').replace(/\\/g, '/'),
                                line: evt.data?.line_number ?? 0,
                                text: lineText,
                                contextBefore: pendingBefore,
                                contextAfter: []
                            };
                            pendingBefore = [];
                        }
                    }
                    flush();
                }
            }

            // 合并当前 runId 暂存覆盖层，保障 Read-Your-Own-Writes 检索一致性
            const stagedMap = store.staging.has(runId) ? store.staging.getPendingWrites(runId) : new Map<string, string>();
            const filteredDisk = diskMatches.filter((m) => !stagedMap.has(m.file));
            const stagedMatches: GrepMatchItem[] = [];
            for (const [relPath, content] of stagedMap.entries()) {
                if (!matchesSearchScope(relPath, scope.allowedDirs)) {
                    continue;
                }
                stagedMatches.push(...grepTextInMemory(relPath, content, args.pattern, fixedStrings, contextLines));
            }

            const combined = [...filteredDisk, ...stagedMatches].sort((a, b) => {
                const cmp = a.file.localeCompare(b.file);
                return cmp !== 0 ? cmp : a.line - b.line;
            });

            return {
                matches: combined,
                totalMatches: combined.length
            };
        }
    });
}

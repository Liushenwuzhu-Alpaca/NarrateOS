import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrateStoreService } from '@narrateos/dsh-book-store';
import { PathFence } from './path-fence.js';
import type { ReadQuotaCounter } from './read-quota.js';

export interface BookGlobToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
    quota: ReadQuotaCounter;
}

function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/').trim();
    let regexStr = '^';
    for (let i = 0; i < normalized.length; i += 1) {
        const ch = normalized[i]!;
        if (ch === '*') {
            if (normalized[i + 1] === '*') {
                if (normalized[i + 2] === '/') {
                    regexStr += '(?:.*/)?';
                    i += 2;
                } else {
                    regexStr += '.*';
                    i += 1;
                }
            } else {
                regexStr += '[^/]*';
            }
        } else if (ch === '?') {
            regexStr += '[^/]';
        } else if ('.+^${}()|[]\\'.includes(ch)) {
            regexStr += `\\${ch}`;
        } else {
            regexStr += ch;
        }
    }
    regexStr += '$';
    return new RegExp(regexStr);
}

async function collectFilesUnderScope(
    fence: PathFence,
    relTarget: string,
    results: Set<string>
): Promise<void> {
    const absTarget = join(fence.bookRoot, relTarget);
    let targetStat;
    try {
        targetStat = await lstat(absTarget);
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return;
        }
        throw err;
    }

    if (!(await fence.isRealPathInsideRoot(relTarget))) {
        return;
    }

    if (targetStat.isFile()) {
        results.add(relTarget);
        return;
    }
    if (!targetStat.isDirectory()) {
        return;
    }

    const entries = await readdir(absTarget, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const childRel = posix.join(relTarget, entry.name);
        if (!(await fence.isRealPathInsideRoot(childRel))) {
            continue;
        }
        if (entry.isDirectory()) {
            await collectFilesUnderScope(fence, childRel, results);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            results.add(childRel);
        }
    }
}

/** 创建受控目录文件列举工具 book_glob（仅列举允许目录并跳过越界符号链接） */
export function createBookGlobTool(options: BookGlobToolOptions): ToolDefinition {
    const { store, runId, fence, quota } = options;

    return defineTool({
        name: 'book_glob',
        description:
            '列举作品允许目录（world/、lore_library/、index/、entities/、manuscripts/）内的文件清单，物理屏蔽 .ops/、.git/ 及越界路径。',
        parameters: {
            pattern: {
                type: 'string',
                description: '可选通配模式（如 *.md 或 entities/*.md）'
            },
            path: {
                type: 'string',
                description: '可选限定目录（须位于允许目录内）'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    files: { type: 'array', required: true, items: { type: 'string' } }
                }
            },
            render(_args, value) {
                if (value.files.length === 0) {
                    return [{ type: 'text', text: '(无匹配文件)' }];
                }
                return [{ type: 'text', text: value.files.join('\n') }];
            }
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            if (args.pattern !== undefined) {
                fence.assertSafeGlobPattern(args.pattern);
            }

            const scope = await fence.assertReadSearchScope(args.path);
            quota.consume('book_glob');

            const fileSet = new Set<string>();
            for (const dir of scope.allowedDirs) {
                await collectFilesUnderScope(fence, dir, fileSet);
            }

            if (store.staging.has(runId)) {
                for (const stagedRel of store.staging.getPendingWrites(runId).keys()) {
                    if (scope.allowedDirs.some((d) => stagedRel === d || stagedRel.startsWith(`${d}/`))) {
                        fileSet.add(stagedRel);
                    }
                }
            }

            let files = Array.from(fileSet).sort((a, b) => a.localeCompare(b));
            if (args.pattern !== undefined && args.pattern.trim().length > 0) {
                const normalizedPattern = args.pattern.replace(/\\/g, '/').trim();
                const matcher = globToRegExp(normalizedPattern);
                const matchFullPath = normalizedPattern.includes('/');
                files = files.filter((f) => {
                    const target = matchFullPath ? f : posix.basename(f);
                    return matcher.test(target);
                });
            }

            return { files };
        }
    });
}

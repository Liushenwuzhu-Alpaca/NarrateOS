import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrateStoreService } from '@narrateos/dsh-book-store';
import { PathFence } from './path-fence.js';
import type { ReadQuotaCounter } from './read-quota.js';
import { isEnoentError, matchesAnyPathPrefix, readOptionalBookConfig } from './shared.js';

export interface BookGlobToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
    quota: ReadQuotaCounter;
    /** 可选内存分支覆盖层（string 覆写/新增，null 删除） */
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    /** 默认每页最大文件数，缺省读取 retrieval.glob_default_max_results。 */
    defaultMaxResults?: number | undefined;
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
        if (isEnoentError(err)) {
            return;
        }
        throw err;
    }

    if (targetStat.isDirectory()) {
        if (!(await fence.isRealPathInsideRoot(relTarget, 'searchScope'))) {
            return;
        }
    } else if (targetStat.isFile()) {
        if (
            !(await fence.isRealPathInsideRoot(relTarget, 'read')) ||
            !fence.isReadPathAllowed(relTarget)
        ) {
            return;
        }
        results.add(relTarget);
        return;
    } else {
        return;
    }

    const entries = await readdir(absTarget, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const childRel = posix.join(relTarget, entry.name);
        if (entry.isDirectory()) {
            if (!(await fence.isRealPathInsideRoot(childRel, 'searchScope'))) {
                continue;
            }
            await collectFilesUnderScope(fence, childRel, results);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            if (!(await fence.isRealPathInsideRoot(childRel, 'read'))) {
                continue;
            }
            results.add(childRel);
        }
    }
}

function applyOverlayAndStagingToFileSet(
    fileSet: Set<string>,
    store: NarrateStoreService,
    runId: string,
    fence: PathFence,
    allowedDirs: readonly string[],
    stagingOverlay?: ReadonlyMap<string, string | null>
): void {
    if (stagingOverlay) {
        for (const [overlayRel, overlayVal] of stagingOverlay.entries()) {
            if (overlayVal === null) {
                fileSet.delete(overlayRel);
                continue;
            }
            if (matchesAnyPathPrefix(overlayRel, allowedDirs) && fence.isReadPathAllowed(overlayRel)) {
                fileSet.add(overlayRel);
            }
        }
    }

    if (!store.staging.has(runId)) {
        return;
    }
    for (const stagedRel of store.staging.getPendingWrites(runId).keys()) {
        if (matchesAnyPathPrefix(stagedRel, allowedDirs) && fence.isReadPathAllowed(stagedRel)) {
            fileSet.add(stagedRel);
        }
    }
}

/** 创建受控目录文件列举工具 book_glob（仅列举允许目录并跳过越界符号链接与禁读路径） */
export function createBookGlobTool(options: BookGlobToolOptions): ToolDefinition {
    const { store, runId, fence, quota, stagingOverlay } = options;

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
            },
            max_results: {
                type: 'integer',
                description: '单页最多返回文件数（默认 200）'
            },
            offset: {
                type: 'integer',
                description: '跳过的匹配文件数（0-based，默认 0），使用返回的 nextOffset 继续翻页'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    files: { type: 'array', required: true, items: { type: 'string' } },
                    totalFiles: { type: 'integer', required: true },
                    nextOffset: { type: 'integer' }
                }
            },
            render(_args, value) {
                const content = value.files.length === 0 ? '(无匹配文件)' : value.files.join('\n');
                const hint = value.nextOffset === undefined ? '' : `\n[共 ${value.totalFiles} 个匹配文件，结果已分页；使用 offset=${value.nextOffset} 继续读取]`;
                return [{ type: 'text', text: `${content}${hint}\n${quota.render()}` }];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const offset = args.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('book_glob 的 offset 必须为 >= 0 的整数');
            const config = options.defaultMaxResults === undefined ? await readOptionalBookConfig(store, fence.bookRoot) : null;
            const retrieval = config?.retrieval as { glob_default_max_results?: number } | undefined;
            const maxResults = args.max_results ?? options.defaultMaxResults ?? retrieval?.glob_default_max_results ?? 200;
            if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new Error('book_glob 的 max_results 必须为 >= 1 的整数');
            if (args.pattern !== undefined) {
                fence.assertSafeGlobPattern(args.pattern);
            }

            const scope = await fence.assertReadSearchScope(args.path);
            quota.consume('book_glob');

            const fileSet = new Set<string>();
            for (const dir of scope.allowedDirs) {
                await collectFilesUnderScope(fence, dir, fileSet);
            }

            applyOverlayAndStagingToFileSet(
                fileSet,
                store,
                runId,
                fence,
                scope.allowedDirs,
                stagingOverlay
            );

            let files = Array.from(fileSet)
                .filter((f) => fence.isReadPathAllowed(f))
                .sort((a, b) => a.localeCompare(b));
            if (args.pattern !== undefined && args.pattern.trim().length > 0) {
                const normalizedPattern = args.pattern.replace(/\\/g, '/').trim();
                const matcher = globToRegExp(normalizedPattern);
                const matchFullPath = normalizedPattern.includes('/');
                files = files.filter((f) => {
                    const target = matchFullPath ? f : posix.basename(f);
                    return matcher.test(target);
                });
            }

            const totalFiles = files.length;
            const page = files.slice(offset, offset + maxResults);
            const nextOffset = offset + page.length;
            return { files: page, totalFiles, ...(nextOffset < totalFiles ? { nextOffset } : {}) };
        }
    });
}

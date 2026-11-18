import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { BookRetrievalConfigSchema, type NarrateStoreService } from '@narrateos/dsh-book-store';
import { PathFence } from './path-fence.js';
import type { ReadQuotaCounter } from './read-quota.js';

const execFileAsync = promisify(execFile);
const DEFAULT_RETRIEVAL_CONFIG = BookRetrievalConfigSchema.parse({});

export interface BookGrepToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
    quota: ReadQuotaCounter;
    /** 可选内存分支覆盖层（string 覆写/新增，null 删除） */
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    /** 默认最大返回匹配条数（缺省读取 BookConfig.retrieval.grep_default_max_matches = 80） */
    defaultMaxMatches?: number | undefined;
    /** 单次返回总字符硬上限（缺省读取 BookConfig.retrieval.grep_max_output_chars = 12000） */
    maxOutputChars?: number | undefined;
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

function compileSearchRegExp(pattern: string, fixedStrings: boolean): RegExp {
    try {
        return fixedStrings ? new RegExp(escapeRegExp(pattern)) : new RegExp(pattern);
    } catch (err: unknown) {
        if (err instanceof SyntaxError) {
            throw new Error(
                `book_grep 正则表达式参数无效 (${pattern}): ${err.message}。若需按字面量匹配请设置 fixed_strings=true`
            );
        }
        throw err;
    }
}

function grepTextInMemory(
    relPath: string,
    content: string,
    pattern: string,
    fixedStrings: boolean,
    contextLines: number,
    maxPerFile: number
): GrepMatchItem[] {
    const lines = content.split(/\r?\n/);
    const matcher = compileSearchRegExp(pattern, fixedStrings);
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
        if (matches.length >= maxPerFile) {
            break;
        }
    }
    return matches;
}

function matchesSearchScope(relPath: string, allowedDirs: string[]): boolean {
    return allowedDirs.some((scope) => relPath === scope || relPath.startsWith(`${scope}/`));
}

function estimateMatchChars(match: GrepMatchItem): number {
    const contextChars =
        match.contextBefore.reduce((sum, line) => sum + line.length + 1, 0) +
        match.contextAfter.reduce((sum, line) => sum + line.length + 1, 0);
    return match.file.length + String(match.line).length + match.text.length + contextChars + 8;
}

async function resolveGrepLimits(
    store: NarrateStoreService,
    bookRoot: string,
    optionMaxMatches?: number,
    optionMaxChars?: number
): Promise<{ defaultMaxMatches: number; maxOutputChars: number }> {
    let defaultMaxMatches = optionMaxMatches;
    let maxOutputChars = optionMaxChars;
    if (defaultMaxMatches === undefined || maxOutputChars === undefined) {
        try {
            const config = await store.openStore(bookRoot).readBookConfig();
            defaultMaxMatches ??=
                config.retrieval?.grep_default_max_matches ?? DEFAULT_RETRIEVAL_CONFIG.grep_default_max_matches;
            maxOutputChars ??=
                config.retrieval?.grep_max_output_chars ?? DEFAULT_RETRIEVAL_CONFIG.grep_max_output_chars;
        } catch {
            defaultMaxMatches ??= DEFAULT_RETRIEVAL_CONFIG.grep_default_max_matches;
            maxOutputChars ??= DEFAULT_RETRIEVAL_CONFIG.grep_max_output_chars;
        }
    }
    return { defaultMaxMatches, maxOutputChars };
}

/** 创建受控全文检索工具 book_grep（底层调用 rg 且锁死于允许目录内，统一限流截断） */
export function createBookGrepTool(options: BookGrepToolOptions): ToolDefinition {
    const { store, runId, fence, quota, stagingOverlay } = options;

    return defineTool({
        name: 'book_grep',
        description:
            '在作品允许目录（world/、lore_library/、index/、entities/、manuscripts/）内执行受控 ripgrep 检索，物理屏蔽 .ops/、.git/、禁读路径及跨书路径。',
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
            },
            max_matches: {
                type: 'integer',
                description: '可选最大返回匹配条数（默认读取 BookConfig.retrieval.grep_default_max_matches = 80）'
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
                    totalMatches: { type: 'integer', required: true },
                    truncated: { type: 'boolean', required: true },
                    hint: { type: 'string' }
                }
            },
            render(_args, value) {
                if (value.matches.length === 0) {
                    return [{ type: 'text', text: '未找到匹配内容 (0 matches)' }];
                }
                const formatted = value.matches
                    .map((m) => `${m.file}:${m.line}: ${m.text}`)
                    .join('\n');
                const suffix = value.truncated
                    ? `\n${value.hint ?? '结果已达上限被截断，请通过 path 限定目录或使用更精确的 pattern 缩小检索范围。'}`
                    : '';
                return [{ type: 'text', text: `共命中 ${value.totalMatches} 处:\n${formatted}${suffix}` }];
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
            // 入口首行无条件预校验正则表达式合法性，避免无磁盘文件时吞掉 SyntaxError
            compileSearchRegExp(args.pattern, fixedStrings);

            if (args.max_matches !== undefined && args.max_matches < 1) {
                throw new Error(`book_grep 的 max_matches 必须 >= 1，收到: ${args.max_matches}`);
            }

            const scope = await fence.assertReadSearchScope(args.path);
            quota.consume('book_grep');

            const limits = await resolveGrepLimits(
                store,
                fence.bookRoot,
                options.defaultMaxMatches,
                options.maxOutputChars
            );
            const maxMatches = args.max_matches ?? limits.defaultMaxMatches;
            const maxOutputChars = limits.maxOutputChars;

            const existingTargets: string[] = [];
            for (const dir of scope.allowedDirs) {
                if (dir === 'manuscripts' && fence.allowedChapterFileSet !== null) {
                    for (const allowedCh of fence.allowedChapterFileSet) {
                        try {
                            await lstat(join(fence.bookRoot, allowedCh));
                            if (await fence.isRealPathInsideRoot(allowedCh, 'read')) {
                                existingTargets.push(allowedCh);
                            }
                        } catch (err: unknown) {
                            if ((err as { code?: string }).code !== 'ENOENT') {
                                throw err;
                            }
                        }
                    }
                    continue;
                }
                try {
                    await lstat(join(fence.bookRoot, dir));
                    if (await fence.isRealPathInsideRoot(dir, 'searchScope')) {
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
                    '--max-count',
                    String(maxMatches + 1),
                    '-C',
                    String(contextLines),
                    '--glob',
                    '!.git/**'
                ];
                for (const blockedPath of fence.blockedReadPaths) {
                    rgArgs.push('--glob', `!${blockedPath}`, '--glob', `!${blockedPath}/**`);
                }
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
                    const execErr = err as { code?: number | string; stderr?: string };
                    if (execErr.code === 2) {
                        const detail =
                            typeof execErr.stderr === 'string' && execErr.stderr.trim().length > 0
                                ? execErr.stderr.trim()
                                : '正则表达式语法错误或参数非法';
                        throw new Error(
                            `book_grep 正则表达式参数无效 (${args.pattern}): ${detail}。若需按字面量匹配请设置 fixed_strings=true`
                        );
                    }
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

            // 合并分支覆盖层与当前 runId 暂存覆盖层，保障 Read-Your-Own-Writes 与支线视角一致
            const mergedOverlay = new Map<string, string | null>();
            if (stagingOverlay) {
                for (const [relPath, content] of stagingOverlay.entries()) {
                    mergedOverlay.set(relPath, content);
                }
            }
            if (store.staging.has(runId)) {
                for (const [relPath, content] of store.staging.getPendingWrites(runId).entries()) {
                    mergedOverlay.set(relPath, content);
                }
            }

            const filteredDisk = diskMatches.filter(
                (m) => !mergedOverlay.has(m.file) && fence.isReadPathAllowed(m.file)
            );
            const stagedMatches: GrepMatchItem[] = [];
            for (const [relPath, content] of mergedOverlay.entries()) {
                if (content === null) {
                    continue;
                }
                if (!matchesSearchScope(relPath, scope.allowedDirs) || !fence.isReadPathAllowed(relPath)) {
                    continue;
                }
                stagedMatches.push(
                    ...grepTextInMemory(
                        relPath,
                        content,
                        args.pattern,
                        fixedStrings,
                        contextLines,
                        maxMatches + 1
                    )
                );
            }

            const combined = [...filteredDisk, ...stagedMatches].sort((a, b) => {
                const cmp = a.file.localeCompare(b.file);
                return cmp !== 0 ? cmp : a.line - b.line;
            });

            let truncated = combined.length > maxMatches;
            const matchLimited = truncated ? combined.slice(0, maxMatches) : combined;

            const kept: GrepMatchItem[] = [];
            let usedChars = 0;
            for (const item of matchLimited) {
                const cost = estimateMatchChars(item);
                if (usedChars + cost > maxOutputChars) {
                    truncated = true;
                    if (kept.length === 0) {
                        const available = Math.max(40, maxOutputChars - item.file.length - 24);
                        kept.push({
                            file: item.file,
                            line: item.line,
                            text: item.text.slice(0, available),
                            contextBefore: [],
                            contextAfter: []
                        });
                    }
                    break;
                }
                kept.push(item);
                usedChars += cost;
            }

            const hint = truncated
                ? `检索结果已截断（最多返回 ${maxMatches} 条且总字符上限 ${maxOutputChars}），请通过 path 限定子目录、增加 max_matches 或使用更精确的 pattern 缩小检索范围。`
                : undefined;

            return {
                matches: kept,
                totalMatches: kept.length,
                truncated,
                ...(hint !== undefined ? { hint } : {})
            };
        }
    });
}

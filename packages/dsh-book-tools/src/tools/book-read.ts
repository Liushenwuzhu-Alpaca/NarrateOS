import { createHash } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NarrateStoreService } from '@narrateos/dsh-book-store';
import type { PathFence, ReadFileTarget } from './path-fence.js';
import type { ReadQuotaCounter } from './read-quota.js';
import { isEnoentError, readContentWithStagingPriority, readOptionalBookConfig } from './shared.js';

const MAX_BATCH_READ_PATHS = 8;
const DEFAULT_MAX_OUTPUT_CHARS = 24000;
const MAX_AUDIT_WINDOW_LINES = 40;

export interface BookReadItem {
    path: string;
    content: string;
    totalLines: number;
    startLine: number;
    endLine: number;
    fromStaging: boolean;
    nextOffset?: number;
    nextCharOffset?: number;
    hint?: string;
}

export interface BookReadToolOptions {
    store: NarrateStoreService;
    runId: string;
    fence: PathFence;
    quota: ReadQuotaCounter;
    /** 可选内存分支覆盖层；优先读本 runId 暂存，其次读该覆盖层。 */
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    /** 仅包含本次上下文中未经任何裁剪的全文路径。 */
    preInjectedFullPaths?: ReadonlySet<string> | undefined;
    /** 单次输出字符预算，缺省读取 BookConfig.retrieval.read_max_output_chars。 */
    maxOutputChars?: number | undefined;
    manuscriptHits?: ReadonlyMap<string, ReadonlySet<number>> | undefined;
    /** Dreaming 记录成功返回的档案与手稿版本；手稿读到多个版本时失去资格。 */
    dreamReadHashes?: Map<string, string | null> | undefined;
}

interface ReadCoverage {
    readonly start: number;
    readonly end: number;
    readonly total: number;
}

interface DreamCoverageState {
    hash: string;
    total: number;
    intervals: Array<[number, number]>;
    mixed: boolean;
}

/** 合并已读偏移区间，用于校验 Dreaming 否定证据是否覆盖了完整原文。 */
function mergeCoverageInterval(intervals: Array<[number, number]>, start: number, end: number): Array<[number, number]> {
    const merged: Array<[number, number]> = [];
    let inserted = false;
    let curStart = start;
    let curEnd = end;
    for (const [a, b] of intervals) {
        if (b < curStart) {
            merged.push([a, b]);
        } else if (curEnd < a) {
            if (!inserted) {
                merged.push([curStart, curEnd]);
                inserted = true;
            }
            merged.push([a, b]);
        } else {
            curStart = Math.min(curStart, a);
            curEnd = Math.max(curEnd, b);
        }
    }
    if (!inserted) merged.push([curStart, curEnd]);
    return merged;
}

/** 普通文件停在整行边界；单行自身超限时显式给出字符续读游标。 */
function sliceWithinBudget(
    rawText: string,
    path: string,
    budget: number,
    maxOutputChars: number,
    offset = 1,
    limit?: number,
    charOffset = 0
): { item: Omit<BookReadItem, 'fromStaging'>; coverage: ReadCoverage } {
    const lines = rawText.split(/\r?\n/);
    const lineStarts = new Array<number>(lines.length);
    let totalUnits = 0;
    for (let i = 0; i < lines.length; i += 1) {
        lineStarts[i] = totalUnits;
        totalUnits += lines[i]!.length + 1;
    }
    const startIndex = offset - 1;
    const requestedEnd = Math.min(lines.length, startIndex + (limit ?? lines.length));
    if (charOffset > (lines[startIndex]?.length ?? 0)) {
        throw new Error(`book_read 的 char_offset 超出 ${path} 第 ${offset} 行长度`);
    }
    const kept: string[] = [];
    let size = 0;
    let cursor = startIndex;
    let nextCharOffset = 0;
    for (; cursor < requestedEnd; cursor += 1) {
        const line = cursor === startIndex ? lines[cursor]!.slice(charOffset) : lines[cursor]!;
        const cost = line.length + (kept.length > 0 ? 1 : 0);
        if (size + cost > budget) {
            if (kept.length === 0) {
                // UTF-16 游标不得截断代理对；续读仍针对同一物理行。
                let end = budget;
                if (end > 0 && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end -= 1;
                if (end === 0) break;
                kept.push(line.slice(0, end));
                nextCharOffset = charOffset + end;
            }
            break;
        }
        kept.push(line);
        size += cost;
    }
    const truncated = cursor < requestedEnd;
    const nextOffset = cursor + 1;
    const endLine = nextCharOffset > 0 ? nextOffset : Math.max(startIndex, cursor);
    const hint = truncated
        ? `[已触发单次 ${maxOutputChars} 字符上限，本文件显示第 ${offset}~${endLine} 行（共 ${lines.length} 行）${nextCharOffset > 0 ? '，末行仅部分显示' : ''}；续读请传 path="${path}", offset=${nextOffset}, limit=${requestedEnd - cursor}${nextCharOffset > 0 ? `, char_offset=${nextCharOffset}` : ''}]`
        : undefined;
    const coverage: ReadCoverage = kept.length === 0
        ? { start: 0, end: 0, total: totalUnits }
        : {
            start: lineStarts[startIndex]! + charOffset,
            end: nextCharOffset > 0
                ? lineStarts[cursor]! + nextCharOffset
                : (cursor < lines.length ? lineStarts[cursor]! : totalUnits),
            total: totalUnits
        };
    return {
        item: {
            path,
            // 未截断、未切片时保留原始换行字节，避免把 CRLF 全文误标为原文。
            content: !truncated && offset === 1 && limit === undefined && charOffset === 0 && rawText.length <= budget
                ? rawText
                : kept.join('\n'),
            totalLines: lines.length,
            startLine: offset,
            endLine,
            ...(hint !== undefined ? { nextOffset, nextCharOffset, hint } : {})
        },
        coverage
    };
}

/** 创建受控作品只读工具，批量读取按成功调用计费并保留逐文件续读位置。 */
export function createBookReadTool(options: BookReadToolOptions): ToolDefinition {
    const { store, runId, fence, quota, stagingOverlay } = options;
    // 审稿续读只承认本轮实际发出的游标，范围不能超过最初的命中窗口。
    const auditContinuations = options.manuscriptHits
        ? new Map<string, { offset: number; limit: number; charOffset: number }>()
        : undefined;
    const dreamCoverage = options.dreamReadHashes ? new Map<string, DreamCoverageState>() : undefined;
    const remindedPaths = new Set<string>();

    return defineTool({
        name: 'book_read',
        description:
            '受控读取作品文件。path 单读或 paths 批读（最多 8 个路径，成功读取才消耗 1 次共享配额）；缺失批量成员独立跳过。单次默认 24000 字符，整行截断并提供精确续读参数。已完整预注入文件首次提醒免扣，显式切片或再次调用正常读取。优先返回暂存修改，路径与时间线围栏始终生效。'
            + (options.manuscriptHits ? ` 审稿回查手稿时先用 book_grep 定位，再指定单个 path、offset 和 1..${MAX_AUDIT_WINDOW_LINES} 行的 limit。新窗口须包含本轮命中行；续读同一短窗时使用返回的完整参数。` : ''),
        parameters: {
            path: { type: 'string', description: '作品内相对路径，例如 world/open_threads.md，与 paths 二选一' },
            paths: { type: 'array', items: { type: 'string' }, description: '最多 8 个作品内相对路径，保序去重，与 path 二选一' },
            offset: { type: 'integer', description: '起始行号（1-based，默认 1）' },
            limit: { type: 'integer', description: '最多读取行数' },
            char_offset: { type: 'integer', description: '仅超长单行续读时使用返回的字符游标（0-based UTF-16），仅支持 path 单文件，配合 offset 定位原行' }
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
                    nextOffset: { type: 'integer' },
                    nextCharOffset: { type: 'integer' },
                    hint: { type: 'string' },
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
                                fromStaging: { type: 'boolean', required: true },
                                nextOffset: { type: 'integer' },
                                nextCharOffset: { type: 'integer' },
                                hint: { type: 'string' }
                            }
                        }
                    }
                }
            },
            render(_args, value) {
                const header = value.items ? '' : `path: ${value.path} (lines ${value.startLine}-${value.endLine} of ${value.totalLines}, staging=${String(value.fromStaging)})\n\n`;
                return [{ type: 'text', text: `${header}${value.content}${value.hint ? `\n${value.hint}` : ''}\n${quota.render()}` }];
            }
        },
        // 同一角色共享配额，串行执行才能保证成功后扣费不发生并发超卖。
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            for (const key of ['offset', 'limit', 'char_offset'] as const) {
                const value = args[key];
                const minimum = key === 'char_offset' ? 0 : 1;
                if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
                    throw new Error(`book_read 的 ${key} 必须为 >= ${minimum} 的整数`);
                }
            }
            if (args.char_offset !== undefined && (args.path === undefined || args.paths !== undefined)) {
                throw new Error('char_offset 仅支持 path 单文件续读');
            }
            const requestedPaths = [...new Set([...(args.path === undefined ? [] : [args.path]), ...(args.paths ?? [])])];
            if (requestedPaths.length === 0) throw new Error('book_read 需要提供 path 或非空 paths 参数');
            if (requestedPaths.length > MAX_BATCH_READ_PATHS) {
                throw new Error(`book_read 单次最多读取 ${MAX_BATCH_READ_PATHS} 个路径，收到 ${requestedPaths.length} 个`);
            }
            const targets = new Map<string, ReadFileTarget>();
            for (const path of requestedPaths) {
                exec.signal.throwIfAborted();
                const target = await fence.assertReadFile(path);
                targets.set(target.normalized, target);
            }
            if (options.manuscriptHits) {
                for (const { normalized, realNormalized } of targets.values()) {
                    if (!normalized.startsWith('manuscripts/') && !realNormalized.startsWith('manuscripts/')) continue;
                    if (normalized !== realNormalized) throw new Error('审稿回查旧章请使用手稿的原始作品路径');
                    if (args.paths !== undefined) throw new Error('审稿回查旧章仅支持 path 单文件');
                    if (args.offset === undefined || args.limit === undefined || args.limit > MAX_AUDIT_WINDOW_LINES) {
                        throw new Error(`审稿回查旧章须指定 offset 和 1..${MAX_AUDIT_WINDOW_LINES} 行的 limit`);
                    }
                    const continuation = auditContinuations?.get(normalized);
                    if (continuation && continuation.offset === args.offset && continuation.limit === args.limit
                        && continuation.charOffset === (args.char_offset ?? 0)) continue;
                    if (args.char_offset) throw new Error('审稿回查须使用上一段返回的精确字符游标');
                    const hits = options.manuscriptHits.get(normalized);
                    if (!hits) throw new Error(`请先用 book_grep 定位 ${normalized} 的原句`);
                    let includesHit = false;
                    for (let i = 0; i < args.limit; i += 1) {
                        if (hits.has(args.offset + i)) {
                            includesHit = true;
                            break;
                        }
                    }
                    if (!includesHit) {
                        throw new Error(`请调整 offset 和 limit，让窗口包含 ${normalized} 本轮检索的命中行`);
                    }
                }
            }
            const config = options.maxOutputChars === undefined ? await readOptionalBookConfig(store, fence.bookRoot) : null;
            const retrieval = config?.retrieval as { read_max_output_chars?: number } | undefined;
            const maxOutputChars = options.maxOutputChars ?? retrieval?.read_max_output_chars ?? DEFAULT_MAX_OUTPUT_CHARS;
            if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 256) throw new Error('book_read 的字符预算必须为 >= 256 的整数');
            // 预留路径头、逐文件提示与配额尾注；正文预算独立累计，后续文件不会伪装为空文件。
            let remaining = maxOutputChars - quota.render().length - 128
                - [...targets.keys()].reduce((sum, path) => sum + path.length * 3 + 240, 0);
            if (remaining < 2) throw new Error('book_read 的路径与续读提示已占满字符预算，请缩小 paths 批次或提高 read_max_output_chars');
            const items: BookReadItem[] = [];
            const notices: string[] = [];
            const missing: string[] = [];
            let budgetExhausted = false;
            let dreamReads: Array<[path: string, hash: string, coverage: ReadCoverage]> | undefined;
            const staged = store.staging.has(runId) ? store.staging.getPendingWrites(runId) : undefined;
            for (const target of targets.values()) {
                exec.signal.throwIfAborted();
                if (budgetExhausted) {
                    notices.push(`[未读取: ${target.normalized} 因前序文件已占满单次字符预算，请单独调用 book_read]`);
                    continue;
                }
                if (args.offset === undefined && args.limit === undefined && args.char_offset === undefined
                    && options.preInjectedFullPaths?.has(target.normalized) && !remindedPaths.has(target.normalized)
                    && !staged?.has(target.normalized) && !stagingOverlay?.has(target.normalized)) {
                    remindedPaths.add(target.normalized);
                    notices.push(`[提示: ${target.normalized} 全文已在当前上下文上方 === SOURCE_REF: ${target.normalized} === 预注入，请直接查阅；若仍需重读请再次调用]`);
                    continue;
                }
                quota.assertAvailable('book_read');
                try {
                    const read = await readContentWithStagingPriority({ store, runId, normalizedPath: target.normalized,
                        absPath: target.absPath, stagingOverlay, missingInOverlayMessage: `文件在当前分支视图中不存在或不可见: ${target.normalized}` });
                    const sliced = sliceWithinBudget(read.content, target.normalized, remaining, maxOutputChars, args.offset, args.limit, args.char_offset);
                    const item = { ...sliced.item, fromStaging: read.fromStaging };
                    if (auditContinuations && target.normalized.startsWith('manuscripts/')) {
                        if (item.nextOffset === undefined) {
                            auditContinuations.delete(target.normalized);
                        } else {
                            const end = Math.min(item.totalLines, args.offset! + args.limit! - 1);
                            auditContinuations.set(target.normalized, {
                                offset: item.nextOffset, limit: end - item.nextOffset + 1,
                                charOffset: item.nextCharOffset ?? 0
                            });
                        }
                    }
                    if (options.dreamReadHashes && sliced.coverage.end > sliced.coverage.start && target.normalized === target.realNormalized &&
                        /^(?:manuscripts\/ch_\d{4}|entities\/(?:cold_archive\/)?(?:char|item)_[\w]+)\.md$/.test(target.normalized)) {
                        (dreamReads ??= []).push([
                            target.normalized, createHash('sha256').update(read.content).digest('hex'), sliced.coverage
                        ]);
                    }
                    items.push(item);
                    remaining -= item.content.length;
                    budgetExhausted = item.nextOffset !== undefined || remaining <= 0;
                } catch (error: unknown) {
                    if (isEnoentError(error)) {
                        missing.push(target.normalized);
                        continue;
                    }
                    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                    throw new Error(`读取 ${target.normalized} 失败${typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}，请核对文件类型及当前分支可见范围`);
                }
            }
            if (items.length === 0 && notices.length === 0) {
                throw new Error(`文件不存在: ${missing.join(', ')}`);
            }
            if (items.length > 0) quota.consume('book_read');
            if (dreamReads && options.dreamReadHashes && dreamCoverage) {
                for (const [path, hash, coverage] of dreamReads) {
                    const isManuscript = path.startsWith('manuscripts/');
                    let state = dreamCoverage.get(path);
                    const previousHash = options.dreamReadHashes.get(path);
                    if (isManuscript && (state?.mixed || (state && state.hash !== hash) || (previousHash !== undefined && previousHash !== hash))) {
                        dreamCoverage.set(path, { hash, total: coverage.total, intervals: [], mixed: true });
                        options.dreamReadHashes.set(path, null);
                        continue;
                    }
                    if (!state || state.hash !== hash) {
                        if (previousHash !== undefined && previousHash !== hash) options.dreamReadHashes.delete(path);
                        state = { hash, total: coverage.total, intervals: [], mixed: false };
                        dreamCoverage.set(path, state);
                    }
                    state.intervals = mergeCoverageInterval(state.intervals, coverage.start, coverage.end);
                    if (state.intervals.length === 1 && state.intervals[0]![0] === 0 && state.intervals[0]![1] === state.total) {
                        options.dreamReadHashes.set(path, hash);
                    }
                }
            }
            notices.unshift(...missing.map(path => `[跳过不存在的文件: ${path}]`));
            const first = items[0];
            if (args.paths === undefined && first && notices.length === 0) return first;
            return {
                path: [...targets.keys()].join(', '),
                content: [...notices, ...items.map(item => `=== ${item.path} (lines ${item.startLine}-${item.endLine} of ${item.totalLines}, staging=${String(item.fromStaging)}) ===\n${item.content}${item.hint ? `\n${item.hint}` : ''}`)].join('\n\n'),
                totalLines: items.reduce((sum, item) => sum + item.totalLines, 0),
                startLine: first?.startLine ?? 0,
                endLine: first?.endLine ?? 0,
                fromStaging: items.some(item => item.fromStaging),
                items
            };
        }
    });
}

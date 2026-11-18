import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { PathFenceError, ReadQuotaExceededError } from '../errors.js';
import * as bookToolsPlugin from '../index.js';

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

function registerCleanup(fn: () => void | Promise<void>): void {
    cleanups.push(fn);
}

function createMockExec(name: string, args: unknown): ToolRunContext {
    return {
        token: Symbol('exec') as ToolRunContext['token'],
        callId: 'call-1' as ToolRunContext['callId'],
        rootCallId: 'call-1' as ToolRunContext['rootCallId'],
        name,
        arguments: args,
        signal: new AbortController().signal,
        deferContext() {},
        concludeTurn() {}
    };
}

async function createSampleBook(): Promise<{ parentDir: string; bookRoot: string; otherBook: string }> {
    const parentDir = await mkdtemp(join(tmpdir(), 'narrateos-tools-test-'));
    tempDirs.push(parentDir);

    const bookRoot = join(parentDir, 'books', 'book-alpha');
    const otherBook = join(parentDir, 'books', 'book-beta');

    for (const dir of ['world', 'lore_library', 'index/L2_cards', 'entities', 'manuscripts', '.ops']) {
        await mkdir(join(bookRoot, dir), { recursive: true });
        await mkdir(join(otherBook, dir), { recursive: true });
    }

    await writeFile(
        join(bookRoot, 'world/book_config.yaml'),
        'book_slug: book-alpha\ntitle: 测试作品\ntokens_per_char: 0.6\n',
        'utf8'
    );
    await writeFile(
        join(bookRoot, 'world/open_threads.md'),
        '# 跨卷伏笔台账\n\n- [thread_001 | status: ACTIVE] 黄铜钥匙来源\n',
        'utf8'
    );
    await writeFile(
        join(bookRoot, 'entities/char_001.md'),
        '---\nentity_id: char_001\ncanonical_name: 沈默\n---\n\n## 1. Innate Locks\n- [vis: PUBLIC] 左手旧疤\n',
        'utf8'
    );
    await writeFile(
        join(bookRoot, 'manuscripts/ch_0001.md'),
        '# 第一章 雨夜\n\n沈默推开铁门，看见桌上放着黄铜钥匙。\n',
        'utf8'
    );
    await writeFile(join(bookRoot, '.ops/tx_state.json'), '{"phase":"IDLE"}', 'utf8');
    await writeFile(join(bookRoot, '.ops/runs.jsonl'), '{"runId":"r1"}\n', 'utf8');
    await writeFile(join(bookRoot, '.ops/voice_samples.yaml'), 'samples: []\n', 'utf8');
    await writeFile(join(otherBook, 'world/secret.md'), '另一本书的机密设定', 'utf8');

    return { parentDir, bookRoot, otherBook };
}

afterEach(async () => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            await fn();
        }
    }
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('PathFence、ReadQuotaCounter 与受控读写工具', () => {
    it('路径围栏 100% 拦截 ../、跨书路径、.ops/ 与 .git/', async () => {
        const { bookRoot } = await createSampleBook();

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-fence',
            bookRoot
        });
        registerCleanup(() => roleSet.cleanup());

        const bookRead = roleSet.toolMap.get('book_read')!;
        const bookGrep = roleSet.toolMap.get('book_grep')!;
        const bookGlob = roleSet.toolMap.get('book_glob')!;

        const blockedPaths = [
            '../book-beta/world/secret.md',
            '../../outside.txt',
            '.ops/tx_state.json',
            '.ops/runs.jsonl',
            '.ops/voice_samples.yaml',
            '.git/config',
            '/etc/passwd'
        ];

        for (const badPath of blockedPaths) {
            await expect(
                bookRead.execute({ path: badPath }, createMockExec('book_read', { path: badPath }))
            ).rejects.toThrow(PathFenceError);
        }

        // book_grep 与 book_glob 同样拦截 .ops/、../ 与跨书目录
        for (const badDir of ['.ops', '.ops/tx_state.json', '../book-beta', '.git']) {
            await expect(
                bookGrep.execute(
                    { pattern: 'phase', path: badDir },
                    createMockExec('book_grep', { pattern: 'phase', path: badDir })
                )
            ).rejects.toThrow(PathFenceError);

            await expect(
                bookGlob.execute(
                    { path: badDir },
                    createMockExec('book_glob', { path: badDir })
                )
            ).rejects.toThrow(PathFenceError);
        }

        await expect(
            bookGlob.execute(
                { pattern: '../**/*.md' },
                createMockExec('book_glob', { pattern: '../**/*.md' })
            )
        ).rejects.toThrow(PathFenceError);

        // 全书 glob 不得包含 .ops/
        const globRes = (await bookGlob.execute({}, createMockExec('book_glob', {}))) as {
            files: string[];
        };
        expect(globRes.files.some((f) => f.includes('.ops'))).toBe(false);
        expect(globRes.files).toContain('world/open_threads.md');
    });

    // Windows 非特权账号默认无权创建文件符号链接，跳过该平台独占校验
    it.skipIf(process.platform === 'win32')('路径围栏拦截越界符号链接且全书 glob 不暴露符号链接目标', async () => {
        const { parentDir, bookRoot, otherBook } = await createSampleBook();
        const outsideSecret = join(parentDir, 'outside.txt');
        await writeFile(outsideSecret, 'TOP_SECRET', 'utf8');
        await symlink(outsideSecret, join(bookRoot, 'world/escape_link.md'));
        await symlink(join(otherBook, 'world/secret.md'), join(bookRoot, 'entities/cross_book.md'));

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-fence-symlink',
            bookRoot
        });
        registerCleanup(() => roleSet.cleanup());

        const bookRead = roleSet.toolMap.get('book_read')!;
        const bookGlob = roleSet.toolMap.get('book_glob')!;

        for (const badPath of ['world/escape_link.md', 'entities/cross_book.md']) {
            await expect(
                bookRead.execute({ path: badPath }, createMockExec('book_read', { path: badPath }))
            ).rejects.toThrow(PathFenceError);
        }

        const globRes = (await bookGlob.execute({}, createMockExec('book_glob', {}))) as {
            files: string[];
        };
        expect(globRes.files.some((f) => f.includes('escape_link') || f.includes('cross_book'))).toBe(false);
    });

    it('支持为 Dreamer 等显式授予 allowedOpsPaths 白名单，同时永久屏蔽事务核心文件', async () => {
        const { bookRoot } = await createSampleBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-ops-whitelist',
            bookRoot,
            allowedOpsPaths: ['.ops/voice_samples.yaml']
        });
        registerCleanup(() => roleSet.cleanup());

        const bookRead = roleSet.toolMap.get('book_read')!;
        const voiceRes = (await bookRead.execute(
            { path: '.ops/voice_samples.yaml' },
            createMockExec('book_read', { path: '.ops/voice_samples.yaml' })
        )) as { content: string };
        expect(voiceRes.content).toContain('samples: []');

        // 未在白名单的 .ops 文件及核心事务锁/状态依然被拦截
        await expect(
            bookRead.execute(
                { path: '.ops/runs.jsonl' },
                createMockExec('book_read', { path: '.ops/runs.jsonl' })
            )
        ).rejects.toThrow(PathFenceError);
    });

    it('maxReadCalls = 3 时第 4 次只读调用（跨 read/grep/glob 共享）立即阻断并提示 yield_*', async () => {
        const { bookRoot } = await createSampleBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-quota',
            bookRoot,
            maxReadCalls: 3,
            yieldTool: 'yield_outline'
        });
        registerCleanup(() => roleSet.cleanup());

        const bookRead = roleSet.toolMap.get('book_read')!;
        const bookGrep = roleSet.toolMap.get('book_grep')!;
        const bookGlob = roleSet.toolMap.get('book_glob')!;

        await bookGlob.execute({}, createMockExec('book_glob', {}));
        await bookRead.execute({ path: 'world/open_threads.md' }, createMockExec('book_read', { path: 'world/open_threads.md' }));
        await bookGrep.execute({ pattern: '沈默' }, createMockExec('book_grep', { pattern: '沈默' }));

        expect(roleSet.quota.count).toBe(3);
        expect(roleSet.quota.remaining).toBe(0);

        await expect(
            bookRead.execute(
                { path: 'entities/char_001.md' },
                createMockExec('book_read', { path: 'entities/char_001.md' })
            )
        ).rejects.toThrow(ReadQuotaExceededError);

        await expect(
            bookGrep.execute({ pattern: '钥匙' }, createMockExec('book_grep', { pattern: '钥匙' }))
        ).rejects.toThrow(/yield_outline/);
    });

    it('Read-Your-Own-Writes: book_edit 修改 open_threads.md 后 book_read 读回暂存文本，磁盘字节不变，manuscripts/ 当场拒绝', async () => {
        const { bookRoot } = await createSampleBook();
        const diskBefore = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-ryow',
            bookRoot
        });
        registerCleanup(() => roleSet.cleanup());

        const bookEdit = roleSet.toolMap.get('book_edit')!;
        const bookRead = roleSet.toolMap.get('book_read')!;
        const bookGrep = roleSet.toolMap.get('book_grep')!;

        await bookEdit.execute(
            {
                path: 'world/open_threads.md',
                target_text: '- [thread_001 | status: ACTIVE] 黄铜钥匙来源',
                replacement_text: '- [thread_001 | status: RESOLVED] 黄铜钥匙来源（已在 ch_0001 确认）'
            },
            createMockExec('book_edit', {})
        );

        // 磁盘文件保持原样零写入
        const diskDuring = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
        expect(diskDuring).toBe(diskBefore);

        // 同一 runId 立即 book_read 返回暂存版本
        const readRes = (await bookRead.execute(
            { path: 'world/open_threads.md' },
            createMockExec('book_read', { path: 'world/open_threads.md' })
        )) as { content: string; fromStaging: boolean };
        expect(readRes.fromStaging).toBe(true);
        expect(readRes.content).toContain('status: RESOLVED');

        // book_grep 也命中暂存新文本
        const grepRes = (await bookGrep.execute(
            { pattern: '已在 ch_0001 确认', fixed_strings: true },
            createMockExec('book_grep', {})
        )) as { totalMatches: number };
        expect(grepRes.totalMatches).toBe(1);

        // 企图 book_edit 修改 manuscripts/ 当场拒绝
        await expect(
            bookEdit.execute(
                {
                    path: 'manuscripts/ch_0001.md',
                    target_text: '黄铜钥匙',
                    replacement_text: '黄金钥匙'
                },
                createMockExec('book_edit', {})
            )
        ).rejects.toThrow(PathFenceError);

        roleSet.cleanup();
        expect(await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8')).toBe(diskBefore);
    });

    it('PathFence 永久封锁 .ops/dream_watermark.json 与 .ops/safe_halt.json；book_grep 捕获无效正则并返回可操作提示', async () => {
        const { bookRoot } = await createSampleBook();
        await writeFile(join(bookRoot, '.ops/dream_watermark.json'), '{"last_dream_ch":0}\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/safe_halt.json'), '{"halted":false}\n', 'utf8');

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        expect(() =>
            ctx.narrateTools.buildRoleTools({
                runId: 'run-blocked-watermark',
                bookRoot,
                allowedOpsPaths: ['.ops/dream_watermark.json']
            })
        ).toThrow(PathFenceError);

        expect(() =>
            ctx.narrateTools.buildRoleTools({
                runId: 'run-blocked-safehalt',
                bookRoot,
                allowedOpsPaths: ['.ops/safe_halt.json']
            })
        ).toThrow(PathFenceError);

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-grep-invalid-regex',
            bookRoot
        });
        registerCleanup(() => roleSet.cleanup());
        const bookRead = roleSet.toolMap.get('book_read')!;
        const bookGrep = roleSet.toolMap.get('book_grep')!;
        const bookEdit = roleSet.toolMap.get('book_edit')!;

        await expect(
            bookRead.execute(
                { path: '.ops/dream_watermark.json' },
                createMockExec('book_read', { path: '.ops/dream_watermark.json' })
            )
        ).rejects.toThrow(PathFenceError);
        await expect(
            bookRead.execute(
                { path: '.ops/safe_halt.json' },
                createMockExec('book_read', { path: '.ops/safe_halt.json' })
            )
        ).rejects.toThrow(PathFenceError);

        // 磁盘 rg 无效正则 (exit code 2) -> 返回明确参数错误且提示 fixed_strings=true
        await expect(
            bookGrep.execute(
                { pattern: '[unclosed' },
                createMockExec('book_grep', { pattern: '[unclosed' })
            )
        ).rejects.toThrow(/fixed_strings=true/);

        // 暂存内存路径同样拦截无效正则 SyntaxError
        await bookEdit.execute(
            {
                path: 'world/open_threads.md',
                target_text: '黄铜钥匙来源',
                replacement_text: '黄铜钥匙来源（暂存）'
            },
            createMockExec('book_edit', {})
        );
        await expect(
            bookGrep.execute(
                { pattern: '(unclosed', path: 'world/open_threads.md' },
                createMockExec('book_grep', { pattern: '(unclosed', path: 'world/open_threads.md' })
            )
        ).rejects.toThrow(/fixed_strings=true/);
    });

    it('book_read 支持 paths[] 批量保序去重读取、兼容暂存覆盖且仅消耗 1 次配额', async () => {
        const { bookRoot } = await createSampleBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-batch-read',
            bookRoot,
            maxReadCalls: 3
        });
        registerCleanup(() => roleSet.cleanup());

        const bookEdit = roleSet.toolMap.get('book_edit')!;
        const bookRead = roleSet.toolMap.get('book_read')!;

        await bookEdit.execute(
            {
                path: 'world/open_threads.md',
                target_text: '- [thread_001 | status: ACTIVE] 黄铜钥匙来源',
                replacement_text: '- [thread_001 | status: RESOLVED] 黄铜钥匙来源（批量暂存可见）'
            },
            createMockExec('book_edit', {})
        );

        const batchRes = (await bookRead.execute(
            {
                paths: [
                    'entities/char_001.md',
                    'world/open_threads.md',
                    'entities/char_001.md',
                    './world/open_threads.md',
                    'manuscripts/ch_0001.md'
                ]
            },
            createMockExec('book_read', {})
        )) as {
            path: string;
            content: string;
            totalLines: number;
            startLine: number;
            endLine: number;
            fromStaging: boolean;
            items?: Array<{
                path: string;
                content: string;
                totalLines: number;
                startLine: number;
                endLine: number;
                fromStaging: boolean;
            }>;
        };

        // 仅消耗 1 次只读配额
        expect(roleSet.quota.count).toBe(1);
        expect(roleSet.quota.remaining).toBe(2);

        // 去重并保持首次出现顺序
        expect(batchRes.items).toHaveLength(3);
        expect(batchRes.items?.map((item) => item.path)).toEqual([
            'entities/char_001.md',
            'world/open_threads.md',
            'manuscripts/ch_0001.md'
        ]);
        expect(batchRes.items?.[1]?.fromStaging).toBe(true);
        expect(batchRes.items?.[1]?.content).toContain('批量暂存可见');
        expect(batchRes.fromStaging).toBe(true);
        expect(batchRes.content).toContain('沈默');
        expect(batchRes.content).toContain('批量暂存可见');
        expect(batchRes.content).toContain('铁门');

        // 支持单路径与 offset/limit 兼容，也支持批量 offset/limit
        const singleSliced = (await bookRead.execute(
            { path: 'manuscripts/ch_0001.md', offset: 1, limit: 1 },
            createMockExec('book_read', {})
        )) as {
            path: string;
            content: string;
            startLine: number;
            endLine: number;
            fromStaging: boolean;
        };
        expect(singleSliced.path).toBe('manuscripts/ch_0001.md');
        expect(singleSliced.content).toBe('# 第一章 雨夜');
        expect(singleSliced.startLine).toBe(1);
        expect(singleSliced.endLine).toBe(1);
        expect(roleSet.quota.count).toBe(2);
    });

    it('book_read 批量校验在扣配额前执行：任意路径越界、空 paths 或超过 8 个路径均不消耗配额', async () => {
        const { bookRoot } = await createSampleBook();
        for (let i = 1; i <= 9; i += 1) {
            await writeFile(join(bookRoot, `world/note_${i}.md`), `笔记 ${i}\n`, 'utf8');
        }

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-batch-fence-quota',
            bookRoot,
            maxReadCalls: 2
        });
        registerCleanup(() => roleSet.cleanup());

        const bookRead = roleSet.toolMap.get('book_read')!;

        // 1. 合法路径在前、越界路径在后 -> 必须先抛 PathFenceError 且不扣配额
        await expect(
            bookRead.execute(
                { paths: ['world/open_threads.md', '../book-beta/world/secret.md'] },
                createMockExec('book_read', {})
            )
        ).rejects.toThrow(PathFenceError);
        expect(roleSet.quota.count).toBe(0);

        await expect(
            bookRead.execute(
                { paths: ['entities/char_001.md', '.ops/tx_state.json'] },
                createMockExec('book_read', {})
            )
        ).rejects.toThrow(PathFenceError);
        expect(roleSet.quota.count).toBe(0);

        // 2. 空 paths 或无参数 -> 拒绝且不扣配额
        await expect(bookRead.execute({ paths: [] }, createMockExec('book_read', {}))).rejects.toThrow();
        await expect(bookRead.execute({}, createMockExec('book_read', {}))).rejects.toThrow();
        expect(roleSet.quota.count).toBe(0);

        // 3. 超过 8 个去重路径 -> 拒绝且不扣配额
        const ninePaths = Array.from({ length: 9 }, (_, idx) => `world/note_${idx + 1}.md`);
        await expect(bookRead.execute({ paths: ninePaths }, createMockExec('book_read', {}))).rejects.toThrow(/8/);
        expect(roleSet.quota.count).toBe(0);

        // 4. 恰好 8 个路径 -> 成功且仅扣 1 次配额
        const eightRes = (await bookRead.execute(
            { paths: ninePaths.slice(0, 8) },
            createMockExec('book_read', {})
        )) as { items?: unknown[] };
        expect(eightRes.items).toHaveLength(8);
        expect(roleSet.quota.count).toBe(1);
    });
});

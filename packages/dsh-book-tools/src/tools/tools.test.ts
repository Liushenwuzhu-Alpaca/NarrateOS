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
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('PathFence、ReadQuotaCounter 与受控读写工具', () => {
    it('路径围栏 100% 拦截 ../、跨书路径、.ops/、.git/ 与越界符号链接', async () => {
        const { parentDir, bookRoot, otherBook } = await createSampleBook();
        const outsideSecret = join(parentDir, 'outside.txt');
        await writeFile(outsideSecret, 'TOP_SECRET', 'utf8');
        await symlink(outsideSecret, join(bookRoot, 'world/escape_link.md'));
        await symlink(join(otherBook, 'world/secret.md'), join(bookRoot, 'entities/cross_book.md'));

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-fence',
            bookRoot
        });

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
            '/etc/passwd',
            'world/escape_link.md',
            'entities/cross_book.md'
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

        // 全书 glob 不得包含 .ops/ 或越界符号链接
        const globRes = (await bookGlob.execute({}, createMockExec('book_glob', {}))) as {
            files: string[];
        };
        expect(globRes.files.some((f) => f.includes('.ops') || f.includes('escape_link') || f.includes('cross_book'))).toBe(
            false
        );
        expect(globRes.files).toContain('world/open_threads.md');

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('支持为 Dreamer 等显式授予 allowedOpsPaths 白名单，同时永久屏蔽事务核心文件', async () => {
        const { bookRoot } = await createSampleBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-ops-whitelist',
            bookRoot,
            allowedOpsPaths: ['.ops/voice_samples.yaml']
        });

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

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('maxReadCalls = 3 时第 4 次只读调用（跨 read/grep/glob 共享）立即阻断并提示 yield_*', async () => {
        const { bookRoot } = await createSampleBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-quota',
            bookRoot,
            maxReadCalls: 3,
            yieldTool: 'yield_outline'
        });

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

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('Read-Your-Own-Writes: book_edit 修改 open_threads.md 后 book_read 读回暂存文本，磁盘字节不变，manuscripts/ 当场拒绝', async () => {
        const { bookRoot } = await createSampleBook();
        const diskBefore = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-ryow',
            bookRoot
        });

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
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });
});

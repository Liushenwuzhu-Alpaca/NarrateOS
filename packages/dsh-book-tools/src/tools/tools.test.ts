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
    it('审稿回查旧章只能读取本轮检索命中的单章短窗', async () => {
        const { bookRoot } = await createSampleBook();
        const manuscript = 'manuscripts/ch_0001.md';
        await writeFile(join(bookRoot, manuscript), '章首\n货单藏在船底\n下一行\n');
        const ctx = new Context();
        const store = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => store.dispose());
        const tools = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => tools.dispose());
        const audit = ctx.narrateTools.buildRoleTools({
            bookRoot, draftText: '草稿中的货单', yieldTool: 'yield_verdict', tools: ['book_read', 'book_grep']
        });
        registerCleanup(() => audit.cleanup());
        const read = (args: { path?: string; paths?: string[]; offset?: number; limit?: number }) =>
            audit.toolMap.get('book_read')!.execute(args, createMockExec('book_read', args));
        const grep = { path: manuscript, pattern: '货单' };

        await expect(read({ path: manuscript, offset: 2, limit: 1 })).rejects.toThrow('book_grep');
        await audit.toolMap.get('book_grep')!.execute(grep, createMockExec('book_grep', grep));
        await expect(read({ paths: [manuscript], offset: 2, limit: 1 })).rejects.toThrow('单文件');
        await expect(read({ path: manuscript })).rejects.toThrow('offset');
        await expect(read({ path: manuscript, offset: 1, limit: 1 })).rejects.toThrow('命中行');
        await expect(read({ path: manuscript, offset: 1, limit: 999 })).rejects.toThrow('limit');
        await expect(read({ path: manuscript, offset: 2, limit: 1 }))
            .resolves.toMatchObject({ startLine: 2, endLine: 2, content: '货单藏在船底' });
        await expect(read({ path: 'world/open_threads.md' }))
            .resolves.toMatchObject({ startLine: 1, content: expect.stringContaining('黄铜钥匙来源') });
    });

    it('审稿读取可沿字符预算游标读完原窗口，但不能扩展窗口', async () => {
        const { bookRoot } = await createSampleBook();
        const path = 'manuscripts/ch_0001.md';
        const firstLine = `货单${'甲'.repeat(248)}`;
        const secondLine = '乙'.repeat(250);
        await writeFile(join(bookRoot, path), `${firstLine}\n${secondLine}\n窗外\n`);
        await writeFile(
            join(bookRoot, 'world/book_config.yaml'),
            'book_slug: book-alpha\ntitle: 测试作品\ntokens_per_char: 0.6\nretrieval:\n  read_max_output_chars: 768\n'
        );
        const ctx = new Context();
        const store = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => store.dispose());
        const tools = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => tools.dispose());
        const audit = ctx.narrateTools.buildRoleTools({
            bookRoot, draftText: '草稿中的货单', yieldTool: 'yield_verdict', tools: ['book_read', 'book_grep']
        });
        registerCleanup(() => audit.cleanup());
        const grep = { path, pattern: '货单', context_lines: 0 };
        await audit.toolMap.get('book_grep')!.execute(grep, createMockExec('book_grep', grep));
        const read = (args: { path: string; offset: number; limit: number }) =>
            audit.toolMap.get('book_read')!.execute(args, createMockExec('book_read', args));

        await expect(read({ path, offset: 1, limit: 2 }))
            .resolves.toMatchObject({ content: firstLine, nextOffset: 2 });
        await expect(read({ path, offset: 2, limit: 2 })).rejects.toThrow('命中行');
        await expect(read({ path, offset: 2, limit: 1 }))
            .resolves.toMatchObject({ content: secondLine, endLine: 2 });
    });

    it('退役设定退出目录、检索和选页，暂存状态优先且显式读取仍可查档', async () => {
        const { bookRoot } = await createSampleBook();
        const retiredPath = 'lore_library/lore_a_retired.md';
        const activePath = 'lore_library/lore_z_active.md';
        const retired = '---\ntitle: 旧地图\nkind: lore\nvolume: 1\nregion: 北城\nstatus: WARPED\n---\n# 旧地图\n共同检索词：旧规则\n';
        const active = '# 新地图\n共同检索词：新规则\n';
        await writeFile(join(bookRoot, retiredPath), retired, 'utf8');
        await writeFile(join(bookRoot, activePath), active, 'utf8');
        const ctx = new Context();
        const store = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => store.dispose());
        const tools = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => tools.dispose());
        const overlay = new Map<string, string | null>();
        const roleSet = ctx.narrateTools.buildRoleTools({ bookRoot, runId: 'retired-lore', maxReadCalls: 10,
            yieldTool: 'yield_context_pack', targetChapter: 1, stagingOverlay: overlay });
        registerCleanup(() => roleSet.cleanup());
        const grep = roleSet.toolMap.get('book_grep')!;
        const search = async () => await grep.execute({ pattern: '共同检索词', path: 'lore_library', max_matches: 1 },
            createMockExec('book_grep', {})) as { matches: Array<{ file: string; text: string }>; truncated: boolean };
        expect(await search()).toMatchObject({ matches: [{ file: activePath, text: '共同检索词：新规则' }], truncated: false });
        const recall = new bookStorePlugin.IndexRecall(new bookStorePlugin.NodeSystemAdapter());
        const catalog = await recall.buildLibrarianCatalog(bookRoot, { currentVolume: 1 });
        expect(catalog.staticPrefix).not.toContain('lore_a_retired.md');
        expect(catalog.staticPrefix).toContain('lore_z_active.md');
        const read = await roleSet.toolMap.get('book_read')!.execute({ path: retiredPath }, createMockExec('book_read', {})) as { content: string };
        expect(read.content).toContain('共同检索词：旧规则');
        const yieldPack = roleSet.toolMap.get('yield_context_pack')!;
        await expect(yieldPack.execute({ selected_entity_ids: [], selected_lore_files: [retiredPath] }, createMockExec('yield_context_pack', {}))).rejects.toThrow('退役');
        expect(roleSet.getYieldResult()).toBeUndefined();

        overlay.set(retiredPath, '# 重新启用\n共同检索词：复用规则\n');
        overlay.set(activePath, '[status: WARPED]\n共同检索词：暂存退役\n');
        expect(await search()).toMatchObject({ matches: [{ file: retiredPath, text: '共同检索词：复用规则' }], truncated: false });
        const stagedCatalog = await recall.buildLibrarianCatalog(bookRoot, { currentVolume: 1, stagingOverlay: overlay });
        expect(stagedCatalog.staticPrefix).toContain('lore_a_retired.md');
        expect(stagedCatalog.staticPrefix).not.toContain('lore_z_active.md');
        await expect(yieldPack.execute({ selected_entity_ids: [], selected_lore_files: [activePath] }, createMockExec('yield_context_pack', {}))).rejects.toThrow('退役');
        await yieldPack.execute({ selected_entity_ids: [], selected_lore_files: [retiredPath] }, createMockExec('yield_context_pack', {}));
        expect(roleSet.getYieldResult()).toMatchObject({ selectedLoreEntries: ['# 重新启用\n共同检索词：复用规则\n'] });
    });

    it('工具构造失败不留暂存；已建会话不能换书，编辑优先级为本轮 > 分支 > 磁盘', async () => {
        const { bookRoot, otherBook } = await createSampleBook();
        const ctx = new Context();
        const store = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => store.dispose());
        const tools = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => tools.dispose());
        const runId = 'branch-edit';
        expect(() => ctx.narrateTools.buildRoleTools({ bookRoot, runId, maxReadCalls: -1 })).toThrow('maxReadCalls');
        expect(ctx.narrateStore.staging.has(runId)).toBe(false);
        const path = 'world/open_threads.md';
        const stagingOverlay = new Map<string, string | null>([[path, '支线版本']]);
        const roleSet = ctx.narrateTools.buildRoleTools({ bookRoot, runId, stagingOverlay });
        registerCleanup(() => roleSet.cleanup());
        expect(() => ctx.narrateTools.buildRoleTools({ bookRoot: otherBook, runId })).toThrow('不属于当前作品');
        const edit = (target: string, replacement: string) => roleSet.toolMap.get('book_edit')!.execute(
            { path, target_text: target, replacement_text: replacement }, createMockExec('book_edit', {}));
        stagingOverlay.set(path, null);
        await expect(edit('黄铜钥匙', '不应成功')).rejects.toThrow('不存在');
        stagingOverlay.set(path, '支线版本');
        await edit('支线', '本轮');
        await edit('本轮', '再次');
        expect(await ctx.narrateStore.staging.read(runId, path)).toBe('再次版本');
        expect(await readFile(join(bookRoot, path), 'utf8')).toContain('黄铜钥匙');
    });

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

        // 支持单路径与 offset/limit 兼容，也支持批量 offset/limit（顶层 endLine 不跨文件失真累加）
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

        const batchSliced = (await bookRead.execute(
            {
                paths: ['entities/char_001.md', 'manuscripts/ch_0001.md'],
                offset: 2,
                limit: 2
            },
            createMockExec('book_read', {})
        )) as {
            path: string;
            content: string;
            totalLines: number;
            startLine: number;
            endLine: number;
            items?: Array<{
                path: string;
                content: string;
                totalLines: number;
                startLine: number;
                endLine: number;
            }>;
        };
        expect(roleSet.quota.count).toBe(3);
        expect(batchSliced.items).toHaveLength(2);
        // 顶层以首项为准，不把各文件 endLine 相加
        expect(batchSliced.startLine).toBe(2);
        expect(batchSliced.endLine).toBe(3);
        expect(batchSliced.endLine).toBe(batchSliced.items?.[0]?.endLine);
        expect(batchSliced.items?.[0]).toMatchObject({
            path: 'entities/char_001.md',
            startLine: 2,
            endLine: 3,
            totalLines: 8
        });
        expect(batchSliced.items?.[1]).toMatchObject({
            path: 'manuscripts/ch_0001.md',
            startLine: 2,
            endLine: 3,
            totalLines: 4
        });
        expect(batchSliced.items?.[1]?.content).toContain('沈默推开铁门');
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

    it('PathFence 在 realpath 解析后二次校验 .ops 白名单、只读世界保护集与软链逃逸，且支持 blockedReadPaths / allowedChapterFiles / stagingOverlay', async () => {
        const { bookRoot } = await createSampleBook();
        await mkdir(join(bookRoot, 'world/roles/prompts'), { recursive: true });
        await mkdir(join(bookRoot, '.ops/session_logs'), { recursive: true });
        await writeFile(join(bookRoot, 'world/roles/planner.yml'), 'id: planner\n', 'utf8');
        await writeFile(join(bookRoot, 'world/author_charter.md'), '# 作者契约\n绝密承诺\n', 'utf8');
        await writeFile(join(bookRoot, 'world/arc_director_plan.md'), '# 导演计划\n阶段天花板\n', 'utf8');
        await writeFile(join(bookRoot, 'world/ops_style_amendments.md'), '# 风格修订\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/session_logs/s1.json'), '{"secret":true}\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/telemetry.jsonl'), '{"ch":1}\n', 'utf8');
        await writeFile(join(bookRoot, 'manuscripts/ch_0002.md'), '# 第二章 支线秘密\n\n沈默看到第二章。\n', 'utf8');

        if (process.platform !== 'win32') {
            await symlink(join(bookRoot, 'manuscripts/ch_0001.md'), join(bookRoot, 'world/link_ms.md'));
            await symlink(join(bookRoot, 'world/roles/planner.yml'), join(bookRoot, 'world/link_role.yml'));
            await symlink(join(bookRoot, '.ops/session_logs/s1.json'), join(bookRoot, 'world/link_ops.json'));
        }

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        // 1. 越权 .ops 白名单（如 .ops/session_logs/s1.json 或写 .ops/telemetry.jsonl）必须被 PathFence 构造拒绝
        expect(() =>
            ctx.narrateTools.buildRoleTools({
                runId: 'run-bad-ops-read',
                bookRoot,
                allowedOpsPaths: ['.ops/session_logs/s1.json']
            })
        ).toThrow(PathFenceError);
        expect(() =>
            ctx.narrateTools.buildRoleTools({
                runId: 'run-bad-ops-write',
                bookRoot,
                allowedOpsWritePaths: ['.ops/telemetry.jsonl']
            })
        ).toThrow(PathFenceError);

        // 2. 硬只读世界保护集 + blockedReadPaths + allowedChapterFiles + stagingOverlay
        const overlay = new Map<string, string | null>([
            ['entities/char_002.md', '---\nentity_id: char_002\ncanonical_name: 林小满\n---\n支线新角色\n'],
            ['manuscripts/ch_0001.md', '# 第一章 雨夜\n\n支线覆盖版黄铜钥匙。\n']
        ]);

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-isolation-view',
            bookRoot,
            allowedOpsPaths: ['.ops/telemetry.jsonl'],
            blockedReadPaths: ['world/author_charter.md', 'world/arc_director_plan.md'],
            allowedChapterFiles: ['ch_0001.md'],
            stagingOverlay: overlay
        });
        registerCleanup(() => roleSet.cleanup());

        const bookRead = roleSet.toolMap.get('book_read')!;
        const bookEdit = roleSet.toolMap.get('book_edit')!;
        const bookGlob = roleSet.toolMap.get('book_glob')!;
        const bookGrep = roleSet.toolMap.get('book_grep')!;

        // 写入硬只读文件必须拒绝
        for (const roPath of [
            'world/roles/planner.yml',
            'world/author_charter.md',
            'world/book_config.yaml',
            'world/ops_style_amendments.md'
        ]) {
            await expect(
                bookEdit.execute(
                    { path: roPath, mode: 'write', replacement_text: 'tampered' },
                    createMockExec('book_edit', {})
                )
            ).rejects.toThrow(PathFenceError);
        }

        if (process.platform !== 'win32') {
            await expect(
                bookEdit.execute(
                    { path: 'world/link_ms.md', mode: 'write', replacement_text: 'tampered' },
                    createMockExec('book_edit', {})
                )
            ).rejects.toThrow(PathFenceError);
            await expect(
                bookEdit.execute(
                    { path: 'world/link_role.yml', mode: 'write', replacement_text: 'tampered' },
                    createMockExec('book_edit', {})
                )
            ).rejects.toThrow(PathFenceError);
            await expect(
                bookRead.execute({ path: 'world/link_ops.json' }, createMockExec('book_read', {}))
            ).rejects.toThrow(PathFenceError);
        }

        // blockedReadPaths 与未授权章节在 read/glob/grep 全链路生效
        await expect(
            bookRead.execute({ path: 'world/author_charter.md' }, createMockExec('book_read', {}))
        ).rejects.toThrow(PathFenceError);
        await expect(
            bookRead.execute({ path: 'manuscripts/ch_0002.md' }, createMockExec('book_read', {}))
        ).rejects.toThrow(PathFenceError);

        const globRes = (await bookGlob.execute({}, createMockExec('book_glob', {}))) as {
            files: string[];
        };
        expect(globRes.files).not.toContain('world/author_charter.md');
        expect(globRes.files).not.toContain('world/arc_director_plan.md');
        expect(globRes.files).not.toContain('manuscripts/ch_0002.md');
        expect(globRes.files).not.toContain('world/link_ops.json');
        expect(globRes.files).toContain('manuscripts/ch_0001.md');
        expect(globRes.files).toContain('entities/char_002.md');

        const grepHidden = (await bookGrep.execute(
            { pattern: '绝密承诺|支线秘密' },
            createMockExec('book_grep', {})
        )) as { matches: unknown[]; totalMatches: number };
        expect(grepHidden.totalMatches).toBe(0);

        const readOverlay = (await bookRead.execute(
            { path: 'manuscripts/ch_0001.md' },
            createMockExec('book_read', {})
        )) as { content: string; fromStaging: boolean };
        expect(readOverlay.fromStaging).toBe(true);
        expect(readOverlay.content).toContain('支线覆盖版黄铜钥匙');
    });

    it('book_grep 入口无条件预校验正则并支持 max_matches 与 maxOutputChars 限流截断 (ISS-023)', async () => {
        const { bookRoot } = await createSampleBook();
        const manyLines = Array.from({ length: 120 }, (_, i) => `第${i + 1}行：铁门与潮汐标记_${'甲'.repeat(120)}`).join('\n');
        const windows = ['前一', '７号', '后一', '.', '.', '前二', '９号', '后二'].join('\n');
        await writeFile(join(bookRoot, 'lore_library/disk.md'), windows);
        await writeFile(join(bookRoot, 'world/large.md'), manyLines, 'utf8');

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-grep-limit',
            bookRoot,
            stagingOverlay: new Map([['lore_library/staged.md', windows]]),
            maxReadCalls: 10
        });
        registerCleanup(() => roleSet.cleanup());

        const bookGrep = roleSet.toolMap.get('book_grep')!;
        const result = await bookGrep.execute({ pattern: '\\d号', path: 'lore_library', context_lines: 1 }, createMockExec('book_grep', {}));
        expect(result).toMatchObject({ matches: ['disk', 'staged'].flatMap(file => [
            { file: `lore_library/${file}.md`, line: 2, contextBefore: ['前一'], contextAfter: ['后一'] },
            { file: `lore_library/${file}.md`, line: 7, contextBefore: ['前二'], contextAfter: ['后二'] }
        ]) });

        // 1. 即使在空目录或不存在路径分支前，非法正则也必抛错
        await expect(
            bookGrep.execute({ pattern: '[broken', path: 'lore_library' }, createMockExec('book_grep', {}))
        ).rejects.toThrow(/fixed_strings=true/);

        // 2. max_matches 截断并标记 truncated=true
        const countTrunc = (await bookGrep.execute(
            { pattern: '潮汐标记', max_matches: 5, context_lines: 0 },
            createMockExec('book_grep', {})
        )) as { totalMatches: number; truncated: boolean; hint?: string };
        expect(countTrunc.totalMatches).toBe(5);
        expect(countTrunc.truncated).toBe(true);
        expect(countTrunc.hint).toBeTruthy();

        // 3. 默认 maxOutputChars (12000) 保护超长文本不爆窗
        const charTrunc = (await bookGrep.execute(
            { pattern: '潮汐标记', context_lines: 0 },
            createMockExec('book_grep', {})
        )) as { totalMatches: number; truncated: boolean };
        expect(charTrunc.truncated).toBe(true);
        expect(charTrunc.totalMatches).toBeLessThan(80);
    });
});

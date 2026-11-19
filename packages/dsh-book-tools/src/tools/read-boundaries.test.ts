import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { createBookReadTool } from './book-read.js';
import { createBookGlobTool } from './book-glob.js';
import { createBookGrepTool } from './book-grep.js';
import { PathFence } from './path-fence.js';
import { ReadQuotaCounter } from './read-quota.js';

const cleanups: Array<() => Promise<unknown>> = [];
function execute(tool: ToolDefinition, args: Record<string, unknown>) {
    return tool.execute(args, { signal: new AbortController().signal } as ToolRunContext);
}
async function fixture(maxReadCalls = 8) {
    const root = await mkdtemp(join(tmpdir(), 'narrate-read-boundary-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const dir of ['world', 'entities', 'manuscripts']) await mkdir(join(root, dir));
    const ctx = new Context();
    const fiber = await ctx.plugin(bookStorePlugin, { bookRoot: root });
    cleanups.push(async () => fiber.dispose());
    const runId = 'read-boundary';
    ctx.narrateStore.staging.begin(runId, root);
    return { root, store: ctx.narrateStore, runId, fence: new PathFence(root), quota: new ReadQuotaCounter({ maxReadCalls, yieldToolHint: 'yield_verdict' }) };
}
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('只读工具边界', () => {
    it('缺失批量成员不丢弃合法内容，全缺失与单缺失不扣配额且不泄露绝对路径', async () => {
        const f = await fixture();
        await writeFile(join(f.root, 'world/ok.md'), '合法正文');
        const tool = createBookReadTool(f);
        const result = await execute(tool, { paths: ['world/missing.md', 'world/ok.md'] }) as { content: string; items: Array<{ path: string }> };
        expect(result.content).toContain('合法正文');
        expect(result.content).toContain('跳过不存在的文件: world/missing.md');
        expect(result.items.map(item => item.path)).toEqual(['world/ok.md']);
        expect(f.quota.count).toBe(1);
        for (const args of [{ path: 'world/missing.md' }, { paths: ['world/missing.md'] }]) {
            const error = await execute(tool, args).catch(error => error as Error);
            expect(error).toBeInstanceOf(Error);
            if (!(error instanceof Error)) throw new Error('缺失文件应返回明确错误');
            expect(error.message).toContain('world/missing.md');
            expect(error.message).not.toContain(f.root);
        }
        expect(f.quota.count).toBe(1);
    });

    it('预注入全文首次免扣，显式切片及暂存改动直接读取，围栏仍先执行', async () => {
        const f = await fixture();
        const path = 'world/ok.md';
        await writeFile(join(f.root, path), '第一行\n第二行');
        const tool = createBookReadTool({ ...f, preInjectedFullPaths: new Set([path, '.ops/secret.md']) });
        const reminder = await execute(tool, { path }) as { content: string };
        expect(reminder.content).toContain(`SOURCE_REF: ${path}`);
        expect(f.quota.count).toBe(0);
        expect((await execute(tool, { path }) as { content: string }).content).toBe('第一行\n第二行');
        expect(f.quota.count).toBe(1);
        await expect(execute(tool, { path: '.ops/secret.md' })).rejects.toThrow();
        const another = createBookReadTool({ ...f, preInjectedFullPaths: new Set([path]) });
        expect((await execute(another, { path, offset: 2, limit: 1 }) as { content: string }).content).toBe('第二行');
        f.store.staging.stageWrite(f.runId, path, '暂存新版本');
        const staged = createBookReadTool({ ...f, preInjectedFullPaths: new Set([path]) });
        expect((await execute(staged, { path }) as { content: string }).content).toBe('暂存新版本');
    });

    it('整行预算给出可精确拼接的续读行号，并标明后续批量成员未读取', async () => {
        const f = await fixture();
        const path = 'world/long.md';
        const text = Array.from({ length: 500 }, (_, i) => `${i}:` + '甲'.repeat(80)).join('\n');
        await writeFile(join(f.root, path), text);
        await writeFile(join(f.root, 'world/later.md'), '后面的文件');
        const tool = createBookReadTool(f);
        const first = await execute(tool, { paths: [path, 'world/later.md'] }) as { content: string; items: Array<{ content: string; endLine: number }> };
        expect(first.content.length).toBeLessThanOrEqual(24000);
        const rendered = tool.output!.render!({}, first) as Array<{ text: string }>;
        expect(rendered[0]!.text.length).toBeLessThanOrEqual(24000);
        expect(rendered[0]!.text).toContain('只读配额: 1/8, 剩余: 7');
        expect(first.content).toContain('未读取: world/later.md');
        const item = first.items[0]!;
        const next = await execute(tool, { path, offset: item.endLine + 1 }) as { content: string };
        expect(item.content + '\n' + next.content).toBe(text);
        expect(first.content).toContain(`offset=${item.endLine + 1}`);
    });

    it('超长单行按字符续读直至完整返回，不会重复同一段', async () => {
        const f = await fixture();
        const path = 'world/one-line.md';
        const text = '单'.repeat(30000);
        await writeFile(join(f.root, path), text);
        const tool = createBookReadTool(f);
        const first = await execute(tool, { path }) as { content: string; nextOffset: number; nextCharOffset: number };
        expect(first.content.length).toBeLessThanOrEqual(24000);
        const rendered = tool.output!.render!({}, first) as Array<{ text: string }>;
        expect(rendered[0]!.text.length).toBeLessThanOrEqual(24000);
        expect(first.nextOffset).toBe(1);
        expect(first.nextCharOffset).toBeGreaterThan(0);
        const next = await execute(tool, { path, offset: first.nextOffset, char_offset: first.nextCharOffset }) as { content: string };
        expect(first.content + next.content).toBe(text);
    });

    it('glob 按稳定顺序分页，三工具渲染共享配额和终态提示', async () => {
        const f = await fixture(3);
        for (let i = 0; i < 205; i++) await writeFile(join(f.root, `entities/item_${String(i).padStart(3, '0')}.md`), '可查');
        const glob = createBookGlobTool(f);
        const first = await execute(glob, { path: 'entities' }) as { files: string[]; nextOffset: number };
        expect(first.files.length).toBe(200);
        expect(first.nextOffset).toBe(200);
        const pageRendered = glob.output!.render!({}, first) as Array<{ text: string }>;
        expect(pageRendered[0]!.text).toContain('只读配额: 1/3, 剩余: 2');
        const second = await execute(glob, { path: 'entities', offset: first.nextOffset }) as { files: string[] };
        expect(second.files).toEqual(Array.from({ length: 5 }, (_, i) => `entities/item_${200 + i}.md`));
        const grep = createBookGrepTool(f);
        const found = await execute(grep, { path: 'entities/item_000.md', pattern: '可查' }) as { matches: Array<{ file: string; line: number; text: string; contextBefore: string[]; contextAfter: string[] }>; totalMatches: number; truncated: boolean };
        const rendered = grep.output!.render!({}, found) as Array<{ text: string }>;
        expect(rendered[0]!.text).toContain('只读配额: 3/3, 剩余: 0');
        expect(rendered[0]!.text).toContain('yield_verdict');
        await expect(execute(createBookReadTool(f), { path: 'entities/item_000.md' })).rejects.toThrow('配额');
    });

    it('分支覆盖层与章节围栏始终优先于预注入提醒，空文件仍是一次成功读取', async () => {
        const f = await fixture();
        const path = 'world/branch.md';
        await writeFile(join(f.root, path), '主线旧版');
        const tool = createBookReadTool({ ...f, stagingOverlay: new Map([[path, '分支新版']]), preInjectedFullPaths: new Set([path]) });
        const branch = await execute(tool, { path }) as { content: string; fromStaging: boolean };
        expect(branch.content).toBe('分支新版');
        expect(branch.fromStaging).toBe(true);
        const emptyPath = 'world/empty.md';
        await writeFile(join(f.root, emptyPath), '');
        const empty = await execute(tool, { path: emptyPath }) as { content: string };
        expect(empty.content).toBe('');
        expect(f.quota.count).toBe(2);
        const bounded = createBookReadTool({ ...f, fence: new PathFence(f.root, { allowedChapterFiles: [] }), preInjectedFullPaths: new Set(['manuscripts/ch_0001.md']) });
        await expect(execute(bounded, { path: 'manuscripts/ch_0001.md' })).rejects.toThrow('时间线');
        expect(f.quota.count).toBe(2);
    });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';
import * as bookStorePlugin from './index.js';
import { BookSwitchConflictError } from './index.js';

const tempDirs: string[] = [];

async function createBookWorkspace(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `narrateos-svc-${name}-`));
    tempDirs.push(dir);
    await mkdir(join(dir, 'world'), { recursive: true });
    await mkdir(join(dir, '.ops'), { recursive: true });
    await writeFile(
        join(dir, 'world/book_config.yaml'),
        `book_slug: ${name}\ntitle: ${name}\ntokens_per_char: 0.6\n`,
        'utf8'
    );
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('Cordis ctx.narrateStore 插件生命周期与切书保护', () => {
    it('通过 ctx.effect + ctx.provide 提供 ctx.narrateStore 并在卸载时清理全部暂存会话', async () => {
        const bookA = await createBookWorkspace('book-a');
        const ctx = new Context();

        const fiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookA });
        expect(ctx.narrateStore).toBeDefined();
        expect(ctx.narrateStore.bookRoot).toBe(resolve(bookA));

        const storeA = ctx.narrateStore.openStore();
        expect((await storeA.readBookConfig()).book_slug).toBe('book-a');

        const runId = ctx.narrateStore.beginRun('run-lifecycle-1');
        ctx.narrateStore.staging.begin(runId, bookA);
        ctx.narrateStore.staging.stageWrite(runId, 'world/open_threads.md', '- [OPEN] 暂存条目');
        expect(ctx.narrateStore.hasActiveRuns()).toBe(true);

        // 卸载插件后清理运行态并移除 ctx.narrateStore
        await fiber.dispose();
        expect(ctx.get('narrateStore')).toBeUndefined();
    });

    it('在途 runId 未结束或 .ops/tx.lock 仍被持有时 switchBook 返回 409 BookSwitchConflictError', async () => {
        const bookA = await createBookWorkspace('book-a');
        const bookB = await createBookWorkspace('book-b');

        const ctx = new Context();
        const fiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookA });
        const service = ctx.narrateStore;

        // 场景 1：存在活跃 runId 时拒绝切书并返回 409
        const runId = service.beginRun('run-in-flight');
        let caught: unknown;
        try {
            await service.switchBook(bookB);
        } catch (err: unknown) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(BookSwitchConflictError);
        expect((caught as BookSwitchConflictError).statusCode).toBe(409);
        expect(service.bookRoot).toBe(resolve(bookA));

        // 结束运行后解除阻断
        service.endRun(runId);

        // 场景 2：当前作品 .ops/tx.lock 正被持有时拒绝切书并返回 409
        const storeA = service.openStore();
        await storeA.withTxLock(async () => {
            await expect(service.switchBook(bookB)).rejects.toMatchObject({
                name: 'BookSwitchConflictError',
                statusCode: 409
            });
        });

        // 场景 3：死进程残留的无效 PID 锁不阻断正常切书
        await writeFile(
            join(bookA, '.ops/tx.lock'),
            JSON.stringify({ pid: 99999999, acquiredAt: '2020-01-01T00:00:00.000Z' }),
            'utf8'
        );

        const storeB = await service.switchBook(bookB);
        expect(service.bookRoot).toBe(resolve(bookB));
        expect((await storeB.readBookConfig()).book_slug).toBe('book-b');

        await fiber.dispose();
    });

    it('多 Cordis Context 实例之间完全隔离，无模块级可变单例串扰', async () => {
        const bookA = await createBookWorkspace('book-a');
        const bookB = await createBookWorkspace('book-b');

        const ctx1 = new Context();
        const ctx2 = new Context();
        const fiber1 = await ctx1.plugin(bookStorePlugin, { bookRoot: bookA });
        const fiber2 = await ctx2.plugin(bookStorePlugin, { bookRoot: bookB });

        expect(ctx1.narrateStore.bookRoot).toBe(resolve(bookA));
        expect(ctx2.narrateStore.bookRoot).toBe(resolve(bookB));

        ctx1.narrateStore.beginRun('ctx1-only-run');
        expect(ctx1.narrateStore.hasActiveRuns()).toBe(true);
        expect(ctx2.narrateStore.hasActiveRuns()).toBe(false);

        await fiber1.dispose();
        await fiber2.dispose();
    });
});

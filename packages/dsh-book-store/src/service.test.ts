import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bookStorePlugin from './index.js';
import { BookSwitchConflictError, NarrateStoreService } from './index.js';

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

function registerCleanup(fn: () => void | Promise<void>): void {
    cleanups.push(fn);
}

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
    vi.restoreAllMocks();
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

describe('Cordis ctx.narrateStore 插件生命周期与切书保护', () => {
    it('通过 ctx.effect + ctx.provide 提供 ctx.narrateStore 并在卸载时清理全部暂存会话', async () => {
        const bookA = await createBookWorkspace('book-a');
        const ctx = new Context();

        const fiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookA });
        registerCleanup(() => fiber.dispose());
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
        registerCleanup(() => fiber.dispose());
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
    });

    it('多 Cordis Context 实例之间完全隔离，无模块级可变单例串扰', async () => {
        const bookA = await createBookWorkspace('book-a');
        const bookB = await createBookWorkspace('book-b');

        const ctx1 = new Context();
        const ctx2 = new Context();
        const fiber1 = await ctx1.plugin(bookStorePlugin, { bookRoot: bookA });
        registerCleanup(() => fiber1.dispose());
        const fiber2 = await ctx2.plugin(bookStorePlugin, { bookRoot: bookB });
        registerCleanup(() => fiber2.dispose());

        expect(ctx1.narrateStore.bookRoot).toBe(resolve(bookA));
        expect(ctx2.narrateStore.bookRoot).toBe(resolve(bookB));

        ctx1.narrateStore.beginRun('ctx1-only-run');
        expect(ctx1.narrateStore.hasActiveRuns()).toBe(true);
        expect(ctx2.narrateStore.hasActiveRuns()).toBe(false);
    });

    it('支持 booksRoot 与可选 bookRoot，且 Config 符合 Schemastery 原生协议', async () => {
        const booksRoot = await mkdtemp(join(tmpdir(), 'narrateos-books-root-'));
        tempDirs.push(booksRoot);

        // 验证导出 Config 满足 Schemastery 原生图协议（可供 DSH config-schema 投射）
        expect(Reflect.get(bookStorePlugin.Config, Symbol.for('schemastery'))).toBe(true);
        expect(bookStorePlugin.Config.type).toBe('object');
        expect(bookStorePlugin.Config(undefined)).toEqual({});
        expect(bookStorePlugin.Config({ booksRoot: './books' })).toEqual({ booksRoot: './books' });

        const ctx = new Context();
        const fiber = await ctx.plugin(bookStorePlugin, { booksRoot });
        registerCleanup(() => fiber.dispose());
        expect(ctx.narrateStore.booksRoot).toBe(resolve(booksRoot));
        expect(ctx.narrateStore.getBooksRoot()).toBe(resolve(booksRoot));
        expect(ctx.narrateStore.bookRoot).toBeNull();
    });

    it('目标作品 .ops/tx.lock 正被其他进程持有时拒绝切书并返回 409', async () => {
        const bookA = await createBookWorkspace('book-a');
        const bookB = await createBookWorkspace('book-b');

        // 模拟目标作品 bookB 正在被存活进程持锁
        await writeFile(
            join(bookB, '.ops/tx.lock'),
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            'utf8'
        );

        const ctx = new Context();
        const fiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookA });
        registerCleanup(() => fiber.dispose());
        await expect(ctx.narrateStore.switchBook(bookB)).rejects.toMatchObject({
            name: 'BookSwitchConflictError',
            statusCode: 409
        });
        expect(ctx.narrateStore.bookRoot).toBe(resolve(bookA));
    });

    it('switchBook 在异步持锁检测期间若并发开启 runId 则拒绝切换，且并发 switchBook 串行化执行', async () => {
        const bookA = await createBookWorkspace('book-a');
        const bookB = await createBookWorkspace('book-b');
        const bookC = await createBookWorkspace('book-c');

        const service = new NarrateStoreService({ bookRoot: bookA });
        registerCleanup(() => service.dispose());
        let releaseLockProbe!: () => void;
        const lockProbeGate = new Promise<void>((resolveGate) => {
            releaseLockProbe = resolveGate;
        });

        const originalIsTxLockHeld = (
            service as unknown as { isTxLockHeld: (root: string) => Promise<boolean> }
        ).isTxLockHeld.bind(service);
        const lockProbeSpy = vi
            .spyOn(service as unknown as { isTxLockHeld: (root: string) => Promise<boolean> }, 'isTxLockHeld')
            .mockImplementationOnce(async (root: string) => {
                await lockProbeGate;
                return await originalIsTxLockHeld(root);
            });

        // 发起 switchBook(bookB)，此时异步阻塞在持锁检测中
        const pendingSwitchB = service.switchBook(bookB);
        // 等待 microtask 让 switchBook 进入 isTxLockHeld 挂起状态
        await Promise.resolve();
        await Promise.resolve();

        // 竞态场景：等待期间并发开启 runId，放行探测后 switchBook 必须二次核验并拒绝切书
        const runId = service.beginRun('race-run');
        releaseLockProbe();
        await expect(pendingSwitchB).rejects.toMatchObject({
            name: 'BookSwitchConflictError',
            statusCode: 409
        });
        expect(service.bookRoot).toBe(resolve(bookA));
        expect(lockProbeSpy).toHaveBeenCalled();

        service.endRun(runId);

        // 并发发起两个 switchBook 时串行执行，后完成的切书结果生效且无状态损坏
        const [storeB, storeC] = await Promise.all([
            service.switchBook(bookB),
            service.switchBook(bookC)
        ]);
        expect(storeB.bookRoot).toBe(resolve(bookB));
        expect(storeC.bookRoot).toBe(resolve(bookC));
        expect(service.bookRoot).toBe(resolve(bookC));
    });

    it('ctx.effect 卸载时先排空依赖消费者，最后才调用 service.dispose()', async () => {
        const bookA = await createBookWorkspace('book-a');
        const ctx = new Context();
        const events: string[] = [];

        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookA });
        registerCleanup(() => storeFiber.dispose());
        const disposeSpy = vi.spyOn(ctx.narrateStore, 'dispose').mockImplementation(function (
            this: NarrateStoreService
        ) {
            events.push('store.dispose');
            NarrateStoreService.prototype.dispose.call(this);
        });

        const consumerPlugin = {
            name: 'test-consumer',
            inject: ['narrateStore'] as const,
            apply(childCtx: Context) {
                childCtx.effect(() => () => {
                    // 消费者清理期间应早于 store.dispose 执行，且此时仍可读取完整状态
                    events.push(`consumer.cleanup:hasActive=${childCtx.narrateStore.hasActiveRuns()}`);
                });
            }
        };

        await ctx.plugin(consumerPlugin);
        ctx.narrateStore.beginRun('drain-order-run');

        await storeFiber.dispose();
        expect(events).toEqual([
            'consumer.cleanup:hasActive=true',
            'store.dispose'
        ]);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });
});

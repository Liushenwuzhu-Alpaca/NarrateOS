import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { NodeSystemAdapter, type SystemPort } from './ports/system.js';
import { StagingSessionManager } from './staging/staging-session.js';
import { BookStore } from './store/bookstore.js';
import { BookSwitchConflictError, TxLockPayloadSchema } from './store/schemas.js';

const LOCK_STALE_MS = 30_000;

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        return (err as { code?: string }).code !== 'ESRCH';
    }
}

/** Cordis 插件标识 */
export const name = 'narrateos-book-store';

/** 无外部服务静态依赖（纯确定性存储底座） */
export const inject = [] as const;

/** @narrateos/dsh-book-store 插件配置 Schema */
export const Config = z
    .object({
        bookRoot: z.string().min(1).optional()
    })
    .default({});

export type NarrateStoreConfig = z.infer<typeof Config>;

/**
 * Cordis 作品存储服务（ctx.narrateStore）
 * - 管理当前激活作品目录 bookRoot 与多书安全切换（在途运行或持锁时返回 409）；
 * - 追踪活跃 runId 生命周期并在结束时自动回收暂存覆盖层；
 * - 持有按 runId 隔离的 StagingSessionManager。
 */
export class NarrateStoreService {
    public readonly staging = new StagingSessionManager();
    public readonly system: SystemPort;

    private currentBookRoot: string | null;
    private readonly activeRuns = new Set<string>();
    private disposed = false;

    constructor(config?: NarrateStoreConfig, system?: SystemPort) {
        this.currentBookRoot = config?.bookRoot ? resolve(config.bookRoot) : null;
        this.system = system ?? new NodeSystemAdapter();
    }

    /** 当前激活作品目录绝对路径（未选书时为 null） */
    get bookRoot(): string | null {
        return this.currentBookRoot;
    }

    /** 读取当前激活作品目录路径 */
    getBookRoot(): string | null {
        return this.currentBookRoot;
    }

    /** 登记一次运行任务开始，返回活跃 runId */
    beginRun(runId?: string): string {
        if (this.disposed) {
            throw new Error('NarrateStoreService 已卸载，拒绝开启新运行任务');
        }
        const resolvedId = runId ?? randomUUID();
        if (resolvedId.trim().length === 0) {
            throw new Error('beginRun 需要非空 runId');
        }
        if (this.activeRuns.has(resolvedId)) {
            throw new Error(`runId 已处于活跃状态: ${resolvedId}`);
        }
        this.activeRuns.add(resolvedId);
        return resolvedId;
    }

    /** 结束指定 runId 并自动丢弃其未提交的内存暂存覆盖层 */
    endRun(runId: string): void {
        this.activeRuns.delete(runId);
        this.staging.discard(runId);
    }

    /** 是否存在尚未结束的在途运行任务 */
    hasActiveRuns(): boolean {
        return this.activeRuns.size > 0;
    }

    /** 返回当前全部活跃 runId 列表 */
    getActiveRunIds(): string[] {
        return [...this.activeRuns];
    }

    /** 为指定路径（或当前激活 bookRoot）构造 BookStore 实例 */
    openStore(root?: string): BookStore {
        const target = root ?? this.currentBookRoot;
        if (!target || target.trim().length === 0) {
            throw new Error('未设置当前作品目录 (bookRoot)');
        }
        return new BookStore(resolve(target), this.system);
    }

    /**
     * 安全切换当前激活作品目录：
     * 若存在任何在途 runId 或当前作品 .ops/tx.lock 正被持有，则抛出 BookSwitchConflictError (statusCode: 409)。
     */
    async switchBook(nextBookRoot: string): Promise<BookStore> {
        if (this.disposed) {
            throw new Error('NarrateStoreService 已卸载，拒绝切换作品');
        }
        if (typeof nextBookRoot !== 'string' || nextBookRoot.trim().length === 0) {
            throw new Error('switchBook 需要有效的目标作品目录路径');
        }
        const resolvedNext = resolve(nextBookRoot);

        if (this.activeRuns.size > 0) {
            throw new BookSwitchConflictError(
                `当前存在 ${this.activeRuns.size} 个未完成的在途运行任务 (${[...this.activeRuns].join(', ')})，拒绝切换至 ${resolvedNext}`
            );
        }

        if (this.currentBookRoot !== null && (await this.isTxLockHeld(this.currentBookRoot))) {
            throw new BookSwitchConflictError(
                `当前作品 ${this.currentBookRoot} 的事务锁 (.ops/tx.lock) 正在被持有，拒绝切换至 ${resolvedNext}`
            );
        }

        this.currentBookRoot = resolvedNext;
        return new BookStore(resolvedNext, this.system);
    }

    /** 释放服务内部状态与所有残留暂存覆盖层 */
    dispose(): void {
        this.disposed = true;
        this.activeRuns.clear();
        this.staging.discardAll();
    }

    private async isTxLockHeld(bookRoot: string): Promise<boolean> {
        const lockPath = join(bookRoot, '.ops/tx.lock');
        let raw: string;
        try {
            raw = await readFile(lockPath, 'utf8');
        } catch (err: unknown) {
            if ((err as { code?: string }).code === 'ENOENT') {
                return false;
            }
            throw err;
        }

        let payload: unknown = null;
        try {
            payload = JSON.parse(raw);
        } catch {
            payload = null;
        }
        const parsed = TxLockPayloadSchema.safeParse(payload);
        if (parsed.success) {
            return isProcessAlive(parsed.data.pid);
        }

        const lockStat = await stat(lockPath);
        return Date.now() - lockStat.mtimeMs < LOCK_STALE_MS;
    }
}

declare module '@deepseek-ai/cordis' {
    interface Context {
        narrateStore: NarrateStoreService;
    }
}

/**
 * Cordis 插件入口：通过 ctx.effect + ctx.provide 注册 ctx.narrateStore（零模块级可变单例）。
 */
export function apply(ctx: Context, config: NarrateStoreConfig = {}): void {
    const service = new NarrateStoreService(config);
    ctx.effect(function* () {
        yield ctx.provide('narrateStore', service);
        yield () => {
            service.dispose();
        };
    }, 'narrateos-book-store');
}

import {
    BookStore,
    DreamingRunner,
    NarrativeEngine,
    NodeSystemAdapter
} from '@narrateos/core';
import { DshLlmAdapter } from './dsh-llm-adapter.js';
import { NarrateRuntimeController, registerNarrateRoutes, resolveStatusModelRouting } from './routes.js';
import type { DshCordisContext, DshLlmAdapterOptions, NarratePluginConfig } from './types.js';

export const name = 'narrateos-dsh-plugin';
export const inject = ['llm', 'webServer'] as const;

/**
 * Cordis 插件入口：
 * 1. 将 ctx.llm 适配为 @narrateos/core 的 LlmPort（无 sessionId 净室调用）
 * 2. 装配 BookStore / NarrativeEngine / DreamingRunner
 * 3. 注册 ctx.webServer 后端 REST & SSE 路由（不含前端 'main' 槽位）
 * 4. 通过 ctx.effect 注册优雅停机钩子，确保 Safe-Point 收尾与 .ops/tx.lock 释放
 */
export function apply(ctx: DshCordisContext, config?: NarratePluginConfig): void {
    if (!config || typeof config.bookRoot !== 'string' || config.bookRoot.trim().length === 0) {
        throw new Error('NarrateOS 插件缺少有效的 bookRoot 配置');
    }
    for (const pool of ['strong_creative', 'fast_retrieval', 'audit'] as const) {
        const route = config.poolRouting?.[pool];
        if (!route || typeof route.provider !== 'string' || !route.provider.trim()
            || typeof route.model !== 'string' || !route.model.trim()) {
            throw new Error(`NarrateOS 插件缺少有效的 poolRouting.${pool} 配置`);
        }
    }
    const system = config.system ?? new NodeSystemAdapter();
    const modelRoutingDefaults = Object.fromEntries(Object.entries(config.poolRouting).map(([pool, route]) => [pool, route.model]));
    let controller: NarrateRuntimeController;
    const adapterOptions: DshLlmAdapterOptions = {
        poolRouting: config.poolRouting,
        resolveModelRouting: async () => {
            try {
                const currentStore = new BookStore(controller.bookRoot, system);
                return resolveStatusModelRouting((await currentStore.readBookConfig()).model_routing, modelRoutingDefaults);
            } catch (error: unknown) {
                if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
                    return resolveStatusModelRouting(undefined, modelRoutingDefaults);
                }
                throw error;
            }
        }
    };
    if (config.llmRetry?.maxRetries !== undefined) {
        adapterOptions.maxRetries = config.llmRetry.maxRetries;
    }
    if (config.llmRetry?.backoffMs !== undefined) {
        adapterOptions.backoffMs = config.llmRetry.backoffMs;
    }
    if (config.llmRetry?.retryableCodes !== undefined) {
        adapterOptions.retryableCodes = config.llmRetry.retryableCodes;
    }

    const llm = new DshLlmAdapter(ctx.llm, adapterOptions);
    const store = config.store ?? new BookStore(config.bookRoot, system);
    const engine = config.engine ?? new NarrativeEngine({ store, llm, system });
    const dreamingRunner = config.dreamingRunner ?? new DreamingRunner(store, llm, system);

    controller = new NarrateRuntimeController({
        bookRoot: config.bookRoot,
        ...(config.booksRoot !== undefined ? { booksRoot: config.booksRoot } : {}),
        store,
        engine,
        dreamingRunner,
        llm,
        system,
        modelRoutingDefaults,
        ...(config.heartbeatIntervalMs !== undefined
            ? { heartbeatIntervalMs: config.heartbeatIntervalMs }
            : {}),
        ...(config.shutdownTimeoutMs !== undefined
            ? { shutdownTimeoutMs: config.shutdownTimeoutMs }
            : {})
    });

    const disposeRoutes = registerNarrateRoutes(ctx.webServer, controller);

    ctx.effect(
        () => async () => {
            try {
                await controller.shutdown();
            } finally {
                disposeRoutes();
            }
        },
        'narrateos-lifecycle'
    );
}

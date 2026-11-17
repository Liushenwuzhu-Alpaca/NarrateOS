import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-commands';
import '@deepseek-ai/dsh-host-webserver';
import '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-skill';
import Schema from '@deepseek-ai/schemastery';
import '@narrateos/dsh-book-store';
import '@narrateos/dsh-book-tools';
import type { LlmPoolRouting } from './schemas.js';
import { registerNarrateCommands } from './runtime/commands.js';
import { NarrateRuntimeController } from './runtime/controller.js';
import { registerNarrateRoutes } from './runtime/routes.js';
import { registerPresetBootSkill } from './runtime/skills.js';

/** Cordis 插件标识 */
export const name = 'narrateos-pipeline';

/** 静态强依赖核心宿主服务（不强依赖 webServer / commands / skills，支持无头测试） */
export const inject = ['narrateStore', 'narrateTools', 'agents', 'llm'] as const;

/** @narrateos/dsh-pipeline 插件配置类型 */
export interface NarratePipelineConfig {
    /** 可选默认激活作品目录 */
    bookRoot?: string | undefined;
    /** 作品库根目录路径（可选，默认继承 narrateStore.booksRoot） */
    booksRoot?: string | undefined;
    /** 外部角色配置与 Skill 预设包目录（可选，默认自动解析 @narrateos/dsh-preset-narrateos） */
    presetRoot?: string | undefined;
    /** 模型池路由映射 */
    poolRouting?: LlmPoolRouting | undefined;
    /** SSE 保活心跳间隔毫秒数（<= 0 时关闭） */
    heartbeatIntervalMs?: number | undefined;
    /** 卸载排空告警超时毫秒数 */
    shutdownTimeoutMs?: number | undefined;
}

const DEFAULT_POOL_ROUTING: LlmPoolRouting = {
    strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' },
    audit: { provider: 'deepseek-official', model: 'deepseek-flash' }
};

function applyEnvRouteOverride(
    base: LlmPoolRouting['strong_creative'],
    modelEnvKey: string,
    providerEnvKey: string
): LlmPoolRouting['strong_creative'] {
    const model = process.env[modelEnvKey]?.trim();
    const provider = process.env[providerEnvKey]?.trim();
    if (!model && !provider) {
        return base;
    }
    return {
        provider: provider || base.provider,
        model: model || base.model
    };
}

/** @narrateos/dsh-pipeline 插件原生 Schemastery 配置 Schema */
export const Config = Schema.object({
    bookRoot: Schema.string().description('默认激活作品目录绝对路径（可选）'),
    booksRoot: Schema.string().description('作品集根目录路径（可选，默认继承 narrateStore.booksRoot）'),
    presetRoot: Schema.string().description(
        '外部角色配置与 Skill 预设包目录（可选，默认解析 @narrateos/dsh-preset-narrateos）'
    ),
    poolRouting: Schema.object({
        strong_creative: Schema.object({
            provider: Schema.string().default(DEFAULT_POOL_ROUTING.strong_creative.provider),
            model: Schema.string().default(DEFAULT_POOL_ROUTING.strong_creative.model)
        }).default(DEFAULT_POOL_ROUTING.strong_creative),
        fast_retrieval: Schema.object({
            provider: Schema.string().default(DEFAULT_POOL_ROUTING.fast_retrieval.provider),
            model: Schema.string().default(DEFAULT_POOL_ROUTING.fast_retrieval.model)
        }).default(DEFAULT_POOL_ROUTING.fast_retrieval),
        audit: Schema.object({
            provider: Schema.string().default(DEFAULT_POOL_ROUTING.audit.provider),
            model: Schema.string().default(DEFAULT_POOL_ROUTING.audit.model)
        }).default(DEFAULT_POOL_ROUTING.audit)
    }).default(DEFAULT_POOL_ROUTING),
    heartbeatIntervalMs: Schema.number().default(15_000).description('SSE 心跳间隔毫秒数'),
    shutdownTimeoutMs: Schema.number().default(5_000).description('卸载排空等待告警超时毫秒数')
}).default({});

declare module '@deepseek-ai/cordis' {
    interface Context {
        narratePipeline: NarrateRuntimeController;
    }
}

/**
 * Cordis 插件入口：
 * - 通过 ctx.effect(function* () { ... }) 保证严格有序停机：
 *   卸载时先执行 controller.shutdown() 关闭准入并等待在途 Agent / WAL / Git 彻底排空，
 *   排空完成后再依次注销 skills / commands / webServer 路由与 ctx.narratePipeline 服务；
 * - 动态通过 ctx.inject(['webServer' | 'commands' | 'skills']) 挂载控制面，无头宿主下自动跳过。
 */
export function apply(ctx: Context, config: NarratePipelineConfig = {}): void {
    const resolvedRouting: LlmPoolRouting = {
        strong_creative: applyEnvRouteOverride(
            config.poolRouting?.strong_creative ?? DEFAULT_POOL_ROUTING.strong_creative,
            'NARRATEOS_MODEL_STRONG',
            'NARRATEOS_PROVIDER_STRONG'
        ),
        fast_retrieval: applyEnvRouteOverride(
            config.poolRouting?.fast_retrieval ?? DEFAULT_POOL_ROUTING.fast_retrieval,
            'NARRATEOS_MODEL_FAST',
            'NARRATEOS_PROVIDER_FAST'
        ),
        audit: applyEnvRouteOverride(
            config.poolRouting?.audit ?? DEFAULT_POOL_ROUTING.audit,
            'NARRATEOS_MODEL_AUDIT',
            'NARRATEOS_PROVIDER_AUDIT'
        )
    };

    const controller = new NarrateRuntimeController(ctx, ctx.narrateStore, ctx.narrateTools, {
        bookRoot: config.bookRoot,
        booksRoot: config.booksRoot,
        presetRoot: config.presetRoot,
        poolRouting: resolvedRouting,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        shutdownTimeoutMs: config.shutdownTimeoutMs
    });

    ctx.effect(function* () {
        yield ctx.provide('narratePipeline', controller);
        void controller.ensureDefaultBookSelected();

        // 独立子插件隔离 RoleRunner 动态挂载点（session/event 监听与 agents.create 作用域），
        // 确保卸载时先由 controller.shutdown() 排空活跃运行，再释放 runnerFiber。
        const runnerFiber = ctx.plugin({
            name: 'narrateos-pipeline:runner',
            apply(runnerCtx) {
                controller.roleRunner.setExecutionContext(runnerCtx);
                runnerCtx.effect(
                    () => () => {
                        controller.roleRunner.setExecutionContext(ctx);
                    },
                    'narrateos-pipeline:runner-scope'
                );
            }
        });
        yield runnerFiber.dispose;

        const webFiber = ctx.inject(['webServer'], (webCtx) => {
            webCtx.effect(
                () => registerNarrateRoutes(webCtx.webServer, controller),
                'narrateos-pipeline:webserver'
            );
        });
        yield webFiber.dispose;

        const cmdFiber = ctx.inject(['commands'], (cmdCtx) => {
            cmdCtx.effect(
                () => registerNarrateCommands(cmdCtx.commands, controller),
                'narrateos-pipeline:commands'
            );
        });
        yield cmdFiber.dispose;

        const skillFiber = ctx.inject(['skills'], (skillCtx) => {
            let disposed = false;
            let disposeSkill: (() => void) | undefined;
            const isDisposed = () => disposed || controller.isAdmissionClosed;

            skillCtx.effect(
                () => () => {
                    disposed = true;
                    disposeSkill?.();
                    disposeSkill = undefined;
                },
                'narrateos-pipeline:skills'
            );

            void registerPresetBootSkill(skillCtx.skills, controller.roleLoader.presetRoot, {
                isDisposed
            })
                .then((fn) => {
                    if (isDisposed()) {
                        fn();
                    } else {
                        disposeSkill = fn;
                    }
                })
                .catch((err: unknown) => {
                    const logger = (skillCtx as { logger?: { warn?: (msg: string) => void } })
                        .logger;
                    logger?.warn?.(
                        `narrate-boot Skill 异步注册失败（非致命）: ${err instanceof Error ? err.message : String(err)}`
                    );
                });
        });
        yield skillFiber.dispose;

        // 最后一个 yield 在 Cordis 反转卸载时最先执行：关闭准入、安全点收束并等待排空后再释放各子作用域
        yield () => controller.shutdown();
    }, 'narrateos-pipeline');
}

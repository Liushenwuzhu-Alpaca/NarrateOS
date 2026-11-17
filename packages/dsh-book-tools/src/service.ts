import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
    ApplyStatePatchOptions,
    NarrationSubjectivity,
    NarrateStoreService,
    TimelineMode
} from '@narrateos/dsh-book-store';
import {
    createLockCharterAndBootTool,
    lockCharterAndBoot,
    type LockCharterAndBootInput,
    type LockCharterAndBootOptions,
    type LockCharterAndBootResult
} from './boot/lock-charter-and-boot.js';
import { attachYieldEnforcementHook, registerMainSessionWriteGuard, type YieldEnforcementOptions } from './hooks/index.js';
import {
    createBookEditTool,
    createBookGlobTool,
    createBookGrepTool,
    createBookReadTool,
    PathFence,
    ReadQuotaCounter
} from './tools/index.js';
import {
    createYieldBootBundleTool,
    createYieldContextPackTool,
    createYieldDreamCommitTool,
    createYieldOutlineTool,
    createYieldStatePatchTool,
    createYieldVerdictTool
} from './yield/index.js';

/** Cordis 插件标识 */
export const name = 'narrateos-book-tools';

/** 静态依赖作品存储服务 ctx.narrateStore */
export const inject = ['narrateStore'] as const;

/** @narrateos/dsh-book-tools 插件配置接口 */
export interface NarrateToolsConfig {
    /** 默认激活作品目录绝对路径（可选） */
    bookRoot?: string | undefined;
    /** 作品集根目录路径（默认 ./books） */
    booksRoot?: string | undefined;
}

/** @narrateos/dsh-book-tools 插件原生 Schemastery 配置 Schema */
export const Config = Schema.object({
    bookRoot: Schema.string().description('默认激活作品目录绝对路径'),
    booksRoot: Schema.string().description('作品集根目录路径（默认 ./books）')
});

/** 支持的受控读写工具名称 */
export type ControlledBookToolName = 'book_read' | 'book_grep' | 'book_glob' | 'book_edit';

/** 支持的终态门禁工具名称 */
export type YieldToolName =
    | 'yield_context_pack'
    | 'yield_outline'
    | 'yield_verdict'
    | 'yield_state_patch'
    | 'yield_dream_commit'
    | 'yield_boot_bundle';

/** 按 runId 与角色配置实例化受控工具集的参数 */
export interface BuildRoleToolsOptions {
    /** 当前运行唯一标识（缺省自动生成） */
    runId?: string | undefined;
    /** 当前作品根目录（缺省取 narrateStore.bookRoot 或插件配置 bookRoot） */
    bookRoot?: string | undefined;
    /** 只读调用硬限流上限（book_read / book_grep / book_glob 共享） */
    maxReadCalls?: number | undefined;
    /** 允许只读访问的 .ops/ 具体文件白名单（默认空，全面屏蔽 .ops/） */
    allowedOpsPaths?: string[] | undefined;
    /** 允许暂存编辑的 .ops/ 具体文件白名单（默认空，全面屏蔽 .ops/） */
    allowedOpsWritePaths?: string[] | undefined;
    /** 需要实例化的受控读写工具列表（默认全部 4 个） */
    tools?: ControlledBookToolName[] | undefined;
    /** 需要实例化的终态门禁工具名（可选） */
    yieldTool?: YieldToolName | undefined;
    /** Librarian 召回目标章号 */
    targetChapter?: number | undefined;
    /** Librarian 召回目标故事日 */
    targetDay?: number | undefined;
    /** 本章创作目标（用于成对挂载校验） */
    chapterGoal?: string | undefined;
    /** Fact Checker 待审校草稿正文 */
    draftText?: string | undefined;
    /** Fact Checker 待审校草稿路径 */
    draftPath?: string | undefined;
    /** Extractor / Dreamer 关联章号 */
    chapterNumber?: number | undefined;
    /** 三态时间线模式 */
    timelineMode?: TimelineMode | undefined;
    /** 是否允许修改既有实体 Innate Locks */
    allowInnateMutation?: boolean | undefined;
    /** Extractor 是否延迟 Git state 提交（仅校验） */
    deferCommit?: boolean | undefined;
    /** Extractor applyStatePatch 附加参数 */
    applyOptions?: ApplyStatePatchOptions | undefined;
    /** 叙述人称主观度（用于 yield_boot_bundle 门禁） */
    narrationSubjectivity?: NarrationSubjectivity | undefined;
}

/** 一次运行的受控工具集实例与状态控制器 */
export interface BuiltRoleToolSet {
    readonly runId: string;
    readonly bookRoot: string;
    readonly fence: PathFence;
    readonly quota: ReadQuotaCounter;
    readonly tools: ToolDefinition[];
    readonly toolMap: ReadonlyMap<string, ToolDefinition>;
    hasYielded(): boolean;
    getYieldResult<T = unknown>(): T | undefined;
    cleanup(): void;
}

/**
 * Cordis 作品受控工具服务（ctx.narrateTools）
 * - 为每次运行构建按 runId 隔离的受控工具集（PathFence + ReadQuotaCounter + StagingSession + yield_*）；
 * - 提供主对话开书编译工具 lock_charter_and_boot；
 * - 提供 'agent/turn-stopping' 防逃逸 Hook 挂载器。
 */
export class NarrateToolsService {
    public readonly defaultBookRoot: string | null;
    public readonly booksRoot: string;
    private disposed = false;

    constructor(
        public readonly narrateStore: NarrateStoreService,
        config: NarrateToolsConfig = {}
    ) {
        this.defaultBookRoot = config.bookRoot ? resolve(config.bookRoot) : null;
        this.booksRoot = resolve(config.booksRoot ?? narrateStore.booksRoot ?? 'books');
    }

    /** 为单次角色运行实例化受控工具集（零模块级状态） */
    buildRoleTools(options: BuildRoleToolsOptions = {}): BuiltRoleToolSet {
        if (this.disposed) {
            throw new Error('NarrateToolsService 已卸载，拒绝创建工具集');
        }

        const resolvedRoot = options.bookRoot ?? this.narrateStore.bookRoot ?? this.defaultBookRoot;
        if (!resolvedRoot || resolvedRoot.trim().length === 0) {
            throw new Error('buildRoleTools 需要有效的 bookRoot（或先通过 narrateStore.switchBook 选书）');
        }
        const bookRoot = resolve(resolvedRoot);
        const runId = options.runId ?? randomUUID();

        const createdStaging = !this.narrateStore.staging.has(runId);
        if (createdStaging) {
            this.narrateStore.staging.begin(runId, bookRoot);
        }

        const fence = new PathFence(bookRoot, {
            allowedOpsPaths: options.allowedOpsPaths,
            allowedOpsWritePaths: options.allowedOpsWritePaths
        });
        const quota = new ReadQuotaCounter({
            maxReadCalls: options.maxReadCalls,
            yieldToolHint: options.yieldTool ?? 'yield_*'
        });

        let yielded = false;
        let yieldResult: unknown = undefined;

        const requestedTools = options.tools ?? ['book_read', 'book_grep', 'book_glob', 'book_edit'];
        const toolList: ToolDefinition[] = [];

        for (const toolName of requestedTools) {
            if (toolName === 'book_read') {
                toolList.push(
                    createBookReadTool({
                        store: this.narrateStore,
                        runId,
                        fence,
                        quota
                    })
                );
            } else if (toolName === 'book_grep') {
                toolList.push(
                    createBookGrepTool({
                        store: this.narrateStore,
                        runId,
                        fence,
                        quota
                    })
                );
            } else if (toolName === 'book_glob') {
                toolList.push(
                    createBookGlobTool({
                        store: this.narrateStore,
                        runId,
                        fence,
                        quota
                    })
                );
            } else if (toolName === 'book_edit') {
                toolList.push(
                    createBookEditTool({
                        store: this.narrateStore,
                        runId,
                        fence
                    })
                );
            }
        }

        const recordYield = (val: unknown) => {
            yielded = true;
            yieldResult = val;
        };

        if (options.yieldTool === 'yield_context_pack') {
            toolList.push(
                createYieldContextPackTool({
                    store: this.narrateStore,
                    bookRoot,
                    runId,
                    targetChapter: options.targetChapter,
                    targetDay: options.targetDay,
                    chapterGoal: options.chapterGoal,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_outline') {
            toolList.push(
                createYieldOutlineTool({
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_verdict') {
            toolList.push(
                createYieldVerdictTool({
                    store: this.narrateStore,
                    bookRoot,
                    runId,
                    fence,
                    draftText: options.draftText,
                    draftPath: options.draftPath,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_state_patch') {
            toolList.push(
                createYieldStatePatchTool({
                    store: this.narrateStore,
                    bookRoot,
                    chapterNumber: options.chapterNumber ?? 1,
                    timelineMode: options.timelineMode,
                    allowInnateMutation: options.allowInnateMutation,
                    deferCommit: options.deferCommit,
                    applyOptions: options.applyOptions,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_dream_commit') {
            toolList.push(
                createYieldDreamCommitTool({
                    store: this.narrateStore,
                    bookRoot,
                    runId,
                    fence,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_boot_bundle') {
            toolList.push(
                createYieldBootBundleTool({
                    narrationSubjectivity: options.narrationSubjectivity,
                    onYield: recordYield
                })
            );
        }

        const toolMap = new Map<string, ToolDefinition>();
        for (const tool of toolList) {
            toolMap.set(tool.name, tool);
        }

        return {
            runId,
            bookRoot,
            fence,
            quota,
            tools: toolList,
            toolMap,
            hasYielded: () => yielded,
            getYieldResult: <T = unknown>() => yieldResult as T | undefined,
            cleanup: () => {
                if (createdStaging) {
                    this.narrateStore.staging.discard(runId);
                }
            }
        };
    }

    /** 锁定《作者契约》并原子初始化独立作品仓，建完即原地停机 */
    async lockCharterAndBoot(
        input: LockCharterAndBootInput,
        overrides?: Partial<LockCharterAndBootOptions>
    ): Promise<LockCharterAndBootResult> {
        if (this.disposed) {
            throw new Error('NarrateToolsService 已卸载，拒绝执行开书编译');
        }
        return await lockCharterAndBoot(input, {
            booksRoot: overrides?.booksRoot ?? this.booksRoot,
            system: overrides?.system ?? this.narrateStore.system,
            onBookBooted: overrides?.onBookBooted
        });
    }

    /** 为子代理上下文挂载 'agent/turn-stopping' 防逃逸 Hook */
    attachYieldEnforcementHook(agentCtx: Context, options: YieldEnforcementOptions): () => void {
        return attachYieldEnforcementHook(agentCtx, options);
    }

    dispose(): void {
        this.disposed = true;
    }
}

declare module '@deepseek-ai/cordis' {
    interface Context {
        narrateTools: NarrateToolsService;
    }
}

/**
 * Cordis 插件入口：
 * - 先声明清理回调，再提供 ctx.narrateTools 服务；
 * - 动态注入 ctx.tools，注册 lock_charter_and_boot 与主会话 books/<slug>/ 写保护守卫。
 */
export function apply(ctx: Context, config: NarrateToolsConfig = {}): void {
    const service = new NarrateToolsService(ctx.narrateStore, config);

    ctx.effect(function* () {
        yield () => {
            service.dispose();
        };
        yield ctx.provide('narrateTools', service);
    }, 'narrateos-book-tools');

    ctx.inject(['tools'], (toolCtx) => {
        toolCtx.effect(() => {
            const disposeBootTool = toolCtx.tools.register(
                createLockCharterAndBootTool({
                    booksRoot: service.booksRoot,
                    system: ctx.narrateStore.system
                })
            );
            const disposeGuard = registerMainSessionWriteGuard(
                toolCtx.tools,
                service.booksRoot,
                toolCtx
            );
            return () => {
                disposeGuard();
                disposeBootTool();
            };
        }, 'narrateos-book-tools:tools-integration');
    });
}

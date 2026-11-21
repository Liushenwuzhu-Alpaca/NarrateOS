import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type {
    ApplyStatePatchOptions,
    EntityProfile,
    NarrationSubjectivity,
    ProseGateOptions,
    TimelineMode
} from '@narrateos/dsh-book-store';
import { getWorkingDirectory, NarrateStoreService, resolveAgentWorkspaceDirectory } from '@narrateos/dsh-book-store';
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
    createPatchParagraphsTool,
    InMemoryDraftPatchSession,
    PathFence,
    ReadQuotaCounter,
    splitParagraphs
} from './tools/index.js';
import {
    createYieldBootBundleTool,
    createYieldContextPackTool,
    createYieldDreamCommitTool,
    createYieldOutlineTool,
    createYieldPatchedDraftTool,
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
export type ControlledBookToolName =
    | 'book_read'
    | 'book_grep'
    | 'book_glob'
    | 'book_edit'
    | 'patch_paragraphs';

/** 支持的终态门禁工具名称 */
export type YieldToolName =
    | 'yield_context_pack'
    | 'yield_outline'
    | 'yield_verdict'
    | 'yield_state_patch'
    | 'yield_dream_commit'
    | 'yield_boot_bundle'
    | 'yield_patched_draft';

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
    /** 按角色注入的禁读路径清单（如 world/author_charter.md、world/arc_director_plan.md） */
    blockedReadPaths?: string[] | undefined;
    /** 限定 manuscripts/** 仅允许读取/检索该集合内的章节文件（用于 PARALLEL 支线隔离） */
    allowedChapterFiles?: string[] | undefined;
    /** 可选内存分支覆盖层（优先读取本 runId 暂存，其次读取该覆盖层） */
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
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
    /** 本章细纲虚拟来源，仅供 PLAN_CONFLICT 验真 */
    outlineText?: string | undefined;
    /** 当前上下文已逐字全文注入且未经裁剪的路径 */
    preInjectedFullPaths?: ReadonlySet<string> | undefined;
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
    /** 可选内存可见实体快照视图（如 PARALLEL 分支已暂存实体） */
    visibleEntities?: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile> | undefined;
    /** 可选额外可达外键集合（如 PARALLEL 分支新增实体或章节键） */
    reachableIds?: ReadonlySet<string> | readonly string[] | undefined;
    /** 叙述人称主观度（用于 yield_boot_bundle 门禁） */
    narrationSubjectivity?: NarrationSubjectivity | undefined;
    /** 静态文风门禁配置（用于 patch_paragraphs 与 yield_patched_draft） */
    proseGateOptions?: ProseGateOptions | undefined;
    /** 是否在 yield_patched_draft 提交时强制复检 StaticProseGate（默认 true） */
    enforceProseGateOnYield?: boolean | undefined;
}

/** 一次运行的受控工具集实例与状态控制器 */
export interface BuiltRoleToolSet {
    readonly runId: string;
    readonly bookRoot: string | undefined;
    readonly fence: PathFence | undefined;
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
    private readonly configuredBooksRoot: string | undefined;
    private readonly workspaceTools = new Map<string, NarrateToolsService>();
    private readonly startupDirectory = process.cwd();
    private pipelineBooksRoot: string | undefined;
    private defaultDirectory: string | undefined;
    private disposed = false;
    private readonly activeBoots = new Set<Promise<LockCharterAndBootResult>>();

    constructor(
        public readonly narrateStore: NarrateStoreService,
        config: NarrateToolsConfig = {},
        defaultDirectory?: string
    ) {
        this.defaultBookRoot = config.bookRoot ? resolve(config.bookRoot) : null;
        this.configuredBooksRoot = config.booksRoot;
        this.defaultDirectory = defaultDirectory;
    }

    /** 旧配置仍可作为无独立存储配置时的回退；入口共用同一个目录解析规则。 */
    configureWorkspace(booksRoot: string | undefined, defaultDirectory: string | undefined): void {
        this.pipelineBooksRoot = booksRoot;
        this.defaultDirectory = defaultDirectory;
    }

    get booksRoot(): string {
        return this.booksRootFor(this.defaultDirectory);
    }

    booksRootFor(directory: string | undefined): string {
        return resolve(
            directory ?? this.startupDirectory,
            this.narrateStore.booksRootSetting ?? this.configuredBooksRoot ?? this.pipelineBooksRoot ?? 'books'
        );
    }

    forWorkspace(directory: string | undefined): NarrateToolsService {
        if (this.disposed) throw new Error('NarrateToolsService 已卸载');
        if (!directory) return this;
        const booksRoot = this.booksRootFor(directory);
        if (booksRoot === this.booksRoot) return this;
        let tools = this.workspaceTools.get(booksRoot);
        if (!tools) {
            tools = new NarrateToolsService(new NarrateStoreService({ booksRoot }, this.narrateStore.system), { booksRoot });
            this.workspaceTools.set(booksRoot, tools);
        }
        return tools;
    }

    getWorkspaceBookRoots(): string[] {
        return [...this.workspaceTools.keys()];
    }

    /** 为单次角色运行实例化受控工具集（零模块级状态） */
    buildRoleTools(options: BuildRoleToolsOptions = {}): BuiltRoleToolSet {
        if (this.disposed) {
            throw new Error('NarrateToolsService 已卸载，拒绝创建工具集');
        }

        const requestedTools =
            options.tools ??
            (options.yieldTool === 'yield_patched_draft'
                ? []
                : ['book_read', 'book_grep', 'book_glob', 'book_edit']);
        const usesPatchSession =
            requestedTools.includes('patch_paragraphs') || options.yieldTool === 'yield_patched_draft';
        const hasDiskTools =
            requestedTools.some((toolName) => toolName !== 'patch_paragraphs') ||
            (options.yieldTool !== undefined && options.yieldTool !== 'yield_patched_draft');
        const isPureInMemoryPatch = usesPatchSession && !hasDiskTools;

        let patchSession: InMemoryDraftPatchSession | undefined;
        if (usesPatchSession) {
            if (
                typeof options.draftText !== 'string' ||
                options.draftText.trim().length === 0 ||
                splitParagraphs(options.draftText).length === 0
            ) {
                throw new Error('patch_paragraphs / yield_patched_draft 需要有效的非空 draftText');
            }
            patchSession = new InMemoryDraftPatchSession(options.draftText, options.proseGateOptions);
        }

        const resolvedRoot = options.bookRoot ?? this.narrateStore.bookRoot ?? this.defaultBookRoot;
        const bookRoot =
            resolvedRoot && resolvedRoot.trim().length > 0 ? resolve(resolvedRoot) : undefined;
        if (!isPureInMemoryPatch && !bookRoot) {
            throw new Error('buildRoleTools 需要有效的 bookRoot（或先通过 narrateStore.switchBook 选书）');
        }
        const runId = options.runId ?? randomUUID();

        const fence =
            !isPureInMemoryPatch && bookRoot !== undefined
                ? new PathFence(bookRoot, {
                      allowedOpsPaths: options.allowedOpsPaths,
                      allowedOpsWritePaths: options.allowedOpsWritePaths,
                      blockedReadPaths: options.blockedReadPaths,
                      allowedChapterFiles: options.allowedChapterFiles
                  })
                : undefined;
        const quota = new ReadQuotaCounter({
            maxReadCalls: options.maxReadCalls,
            yieldToolHint: options.yieldTool ?? 'yield_*'
        });

        let yielded = false;
        let yieldResult: unknown = undefined;

        const toolList: ToolDefinition[] = [];

        for (const toolName of requestedTools) {
            if (toolName === 'book_read') {
                toolList.push(
                    createBookReadTool({
                        store: this.narrateStore,
                        runId,
                        fence: fence!,
                        quota,
                        preInjectedFullPaths: options.preInjectedFullPaths,
                        stagingOverlay: options.stagingOverlay
                    })
                );
            } else if (toolName === 'book_grep') {
                toolList.push(
                    createBookGrepTool({
                        store: this.narrateStore,
                        runId,
                        fence: fence!,
                        quota,
                        stagingOverlay: options.stagingOverlay
                    })
                );
            } else if (toolName === 'book_glob') {
                toolList.push(
                    createBookGlobTool({
                        store: this.narrateStore,
                        runId,
                        fence: fence!,
                        quota,
                        stagingOverlay: options.stagingOverlay
                    })
                );
            } else if (toolName === 'book_edit') {
                toolList.push(
                    createBookEditTool({
                        store: this.narrateStore,
                        runId,
                        fence: fence!,
                        stagingOverlay: options.stagingOverlay
                    })
                );
            } else if (toolName === 'patch_paragraphs') {
                toolList.push(
                    createPatchParagraphsTool({
                        session: patchSession!
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
                    bookRoot: bookRoot!,
                    runId,
                    fence: fence!,
                    targetChapter: options.targetChapter,
                    targetDay: options.targetDay,
                    chapterGoal: options.chapterGoal,
                    allowedChapterFiles: options.allowedChapterFiles,
                    stagingOverlay: options.stagingOverlay,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_outline') {
            toolList.push(
                createYieldOutlineTool({
                    store: this.narrateStore,
                    bookRoot: bookRoot!,
                    targetChapter: options.targetChapter ?? options.chapterNumber,
                    visibleEntities: options.visibleEntities,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_verdict') {
            toolList.push(
                createYieldVerdictTool({
                    store: this.narrateStore,
                    bookRoot: bookRoot!,
                    runId,
                    fence: fence!,
                    draftText: options.draftText,
                    outlineText: options.outlineText,
                    draftPath: options.draftPath,
                    stagingOverlay: options.stagingOverlay,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_state_patch') {
            toolList.push(
                createYieldStatePatchTool({
                    store: this.narrateStore,
                    bookRoot: bookRoot!,
                    chapterNumber: options.chapterNumber ?? 1,
                    timelineMode: options.timelineMode,
                    allowInnateMutation: options.allowInnateMutation,
                    deferCommit: options.deferCommit,
                    applyOptions: options.applyOptions,
                    draftText: options.draftText,
                    stagingOverlay: options.stagingOverlay,
                    visibleEntities: options.visibleEntities,
                    reachableIds: options.reachableIds,
                    onYield: recordYield
                })
            );
        } else if (options.yieldTool === 'yield_dream_commit') {
            toolList.push(
                createYieldDreamCommitTool({
                    store: this.narrateStore,
                    bookRoot: bookRoot!,
                    runId,
                    fence: fence!,
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
        } else if (options.yieldTool === 'yield_patched_draft') {
            toolList.push(
                createYieldPatchedDraftTool({
                    session: patchSession!,
                    proseGateOptions: options.proseGateOptions,
                    enforceProseGateOnYield: options.enforceProseGateOnYield,
                    onYield: recordYield
                })
            );
        }

        const toolMap = new Map<string, ToolDefinition>();
        for (const tool of toolList) {
            toolMap.set(tool.name, tool);
        }

        const createdStaging = !isPureInMemoryPatch && bookRoot !== undefined && !this.narrateStore.staging.has(runId);
        if (!isPureInMemoryPatch && bookRoot !== undefined) {
            if (createdStaging) this.narrateStore.staging.begin(runId, bookRoot);
            else this.narrateStore.staging.assertBookRoot(runId, bookRoot);
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
        const defaultOnBookBooted = createAutoSwitchBookCallback(this.narrateStore);
        const boot = lockCharterAndBoot(input, {
            booksRoot: overrides?.booksRoot ?? this.booksRoot,
            system: overrides?.system ?? this.narrateStore.system,
            onBookBooted:
                overrides && 'onBookBooted' in overrides
                    ? overrides.onBookBooted
                    : defaultOnBookBooted
        });
        this.activeBoots.add(boot);
        try {
            return await boot;
        } finally {
            this.activeBoots.delete(boot);
        }
    }

    /** 为子代理上下文挂载 'agent/turn-stopping' 防逃逸 Hook */
    attachYieldEnforcementHook(agentCtx: Context, options: YieldEnforcementOptions): () => void {
        return attachYieldEnforcementHook(agentCtx, options);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await Promise.allSettled(this.activeBoots);
        await Promise.all([...this.workspaceTools.values()].map(async (tools) => {
            await tools.dispose();
            tools.narrateStore.dispose();
        }));
        this.workspaceTools.clear();
    }
}

declare module '@deepseek-ai/cordis' {
    interface Context {
        narrateTools: NarrateToolsService;
    }
}

function createAutoSwitchBookCallback(
    narrateStore: NarrateStoreService
): NonNullable<LockCharterAndBootOptions['onBookBooted']> {
    return async (res) => {
        try {
            await narrateStore.switchBook(res.bookRoot);
            return { switchedBook: true };
        } catch (err: unknown) {
            // 若遇在途锁冲突不回滚已落盘建库结果，向调用方显式回报未切书原因
            return {
                switchedBook: false,
                switchConflictReason: err instanceof Error ? err.message : String(err)
            };
        }
    };
}

/**
 * Cordis 插件入口：
 * - 先声明清理回调，再提供 ctx.narrateTools 服务；
 * - 动态注入 ctx.tools，注册 lock_charter_and_boot 与主会话 books/<slug>/ 写保护守卫。
 */
export function apply(ctx: Context, config: NarrateToolsConfig = {}): void {
    const service = new NarrateToolsService(ctx.narrateStore, config, getWorkingDirectory(ctx)?.defaultDirectory);

    ctx.effect(function* () {
        yield ctx.provide('narrateTools', service);
        yield () => service.dispose();
    }, 'narrateos-book-tools');

    ctx.inject(['tools'], (toolCtx) => {
        toolCtx.effect(() => {
            const disposeBootTool = toolCtx.tools.register(
                createLockCharterAndBootTool({ booksRoot: service.booksRoot }, async (input, _options, exec) => {
                    const directory = await resolveAgentWorkspaceDirectory(toolCtx, exec.agent, exec.signal);
                    return await service.forWorkspace(directory).lockCharterAndBoot(input);
                })
            );
            const disposeGuard = registerMainSessionWriteGuard(
                toolCtx.tools,
                service.booksRoot,
                toolCtx,
                (cwd) => [service.booksRoot, service.booksRootFor(cwd), ...service.getWorkspaceBookRoots()]
            );
            return () => {
                disposeGuard();
                disposeBootTool();
            };
        }, 'narrateos-book-tools:tools-integration');
    });
}

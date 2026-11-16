import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
    BookStore,
    bootBook,
    type BootMode,
    DreamingRunner,
    type LlmPort,
    NarrativeEngine,
    NodeSystemAdapter,
    type SystemPort,
    type TimelineMode
} from '@narrateos/core';
import { DshRuntimeClient } from './dsh-runtime.js';
import { runPlotHaystackBenchmark } from './plot-haystack.js';

export type CliCommandName =
    | 'boot'
    | 'step'
    | 'sync'
    | 'dream'
    | 'status'
    | 'plot-haystack'
    | 'help';

export interface ParsedCliCommand {
    command: CliCommandName;
    bookRoot: string;
    json: boolean;
    help: boolean;
    flags: Record<string, string | boolean>;
    positionals: string[];
}

export interface CliRuntimeDeps {
    llm?: LlmPort | undefined;
    system?: SystemPort | undefined;
    stdout?: ((chunk: string) => void) | undefined;
    stderr?: ((chunk: string) => void) | undefined;
    cwd?: string | undefined;
}

const VALID_COMMANDS = new Set<string>([
    'boot',
    'step',
    'sync',
    'dream',
    'status',
    'plot-haystack',
    'help'
]);

const HELP_TEXT = [
    'NarrateOS 无头命令行工具 (@narrateos/cli)',
    '',
    '用法:',
    '  narrateos <command> [options]',
    '',
    '子命令:',
    '  boot           初始化并编译新书纯文本数据库与独立 Git 仓',
    '  step           执行单章流水线 (Librarian -> Planner -> Writer -> Gate -> FactCheck -> Extractor)',
    '  sync           同步手工修改的手稿章节并审计状态/下游冲突',
    '  dream          执行周期睡眠整理 (脏页 VACUUM / WARPED 归档 / 前台切镜信号)',
    '  status         查看当前作品世界状态、事务相位与实体统计',
    '  plot-haystack  运行 40 章 Plot-Haystack 盲测基准并输出 10 枚探针核验报告',
    '',
    '通用选项:',
    '  --book <dir>   作品目录路径 (默认: 当前工作目录)',
    '  --json         以 JSON 格式输出结构化结果',
    '  -h, --help     显示帮助信息'
].join('\n');

/** 解析命令行参数 */
export function parseCliArgs(argv: string[], cwd = process.cwd()): ParsedCliCommand {
    const flags: Record<string, string | boolean> = {};
    const positionals: string[] = [];
    let help = false;

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === undefined) {
            continue;
        }
        if (token === '-h' || token === '--help') {
            help = true;
            continue;
        }
        if (token.startsWith('--')) {
            const eqIdx = token.indexOf('=');
            if (eqIdx !== -1) {
                const key = token.slice(2, eqIdx);
                const val = token.slice(eqIdx + 1);
                flags[key] = val;
            } else {
                const key = token.slice(2);
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith('-')) {
                    flags[key] = next;
                    i += 1;
                } else {
                    flags[key] = true;
                }
            }
            continue;
        }
        positionals.push(token);
    }

    const rawCmd = positionals[0] ?? 'help';
    const command = rawCmd as CliCommandName;
    const rawBook =
        typeof flags['book'] === 'string'
            ? flags['book']
            : typeof flags['book-root'] === 'string'
              ? flags['book-root']
              : cwd;

    return {
        command,
        bookRoot: resolve(cwd, rawBook),
        json: flags['json'] === true,
        help,
        flags,
        positionals
    };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
    const val = flags[key];
    return typeof val === 'string' ? val : undefined;
}

function getIntFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
    const raw = getStringFlag(flags, key);
    if (raw === undefined) {
        return undefined;
    }
    const num = Number.parseInt(raw, 10);
    if (!Number.isFinite(num)) {
        throw new Error(`参数 --${key} 需要整数，收到: ${raw}`);
    }
    return num;
}

function printOutput(
    stdout: (chunk: string) => void,
    asJson: boolean,
    data: unknown,
    humanSummary: string
): void {
    if (asJson) {
        stdout(`${JSON.stringify(data, null, 2)}\n`);
    } else {
        stdout(`${humanSummary}\n`);
    }
}

/**
 * 执行无头 CLI 命令并返回进程退出码 (0 成功, 1 失败)
 */
export async function runCli(argv: string[], deps: CliRuntimeDeps = {}): Promise<number> {
    const stdout = deps.stdout ?? ((chunk: string) => process.stdout.write(chunk));
    const stderr = deps.stderr ?? ((chunk: string) => process.stderr.write(chunk));
    const system = deps.system ?? new NodeSystemAdapter();
    const resolveLlm = (): LlmPort => deps.llm ?? new DshRuntimeClient();

    try {
        const parsed = parseCliArgs(argv, deps.cwd ?? process.cwd());

        if (parsed.help || parsed.command === 'help') {
            stdout(`${HELP_TEXT}\n`);
            return 0;
        }

        if (!VALID_COMMANDS.has(parsed.command)) {
            stderr(`未知子命令: ${parsed.command}\n\n${HELP_TEXT}\n`);
            return 1;
        }

        switch (parsed.command) {
            case 'boot': {
                const slug = getStringFlag(parsed.flags, 'slug') ?? basename(parsed.bookRoot);
                const title = getStringFlag(parsed.flags, 'title') ?? slug;
                const povCharacter = getStringFlag(parsed.flags, 'pov') ?? 'char_protagonist';
                const rawMode = getStringFlag(parsed.flags, 'mode') ?? 'original';
                if (rawMode !== 'original' && rawMode !== 'fanfic') {
                    throw new Error(`--mode 仅支持 original 或 fanfic，收到: ${rawMode}`);
                }
                const mode: BootMode = rawMode;
                const seedFile = getStringFlag(parsed.flags, 'seed-file');
                const seedInline = getStringFlag(parsed.flags, 'seed');
                const seedText = seedFile ? await readFile(seedFile, 'utf8') : seedInline;
                const t0Anchor = getStringFlag(parsed.flags, 't0');

                const result = await bootBook(
                    {
                        bookRoot: parsed.bookRoot,
                        bookSlug: slug,
                        title,
                        povCharacter,
                        mode,
                        ...(mode === 'original'
                            ? { premiseOrSeed: seedText ?? `${title} 核心设定` }
                            : { sourceMaterial: seedText ?? `${title} 同人设定包` }),
                        ...(t0Anchor !== undefined ? { t0Anchor } : {})
                    },
                    {
                        llm: resolveLlm(),
                        system
                    }
                );

                printOutput(
                    stdout,
                    parsed.json,
                    result,
                    `[boot] 已初始化作品 "${slug}" (${result.bookRoot})，创建实体 ${result.entityIds.length} 个。`
                );
                return 0;
            }

            case 'step': {
                const goal = getStringFlag(parsed.flags, 'goal');
                if (!goal) {
                    throw new Error('step 子命令必须提供 --goal <章节目标>');
                }
                const chapterNumber = getIntFlag(parsed.flags, 'chapter');
                const rawMode = getStringFlag(parsed.flags, 'mode');
                let timelineMode: TimelineMode | undefined;
                if (rawMode !== undefined) {
                    if (rawMode !== 'MAINLINE' && rawMode !== 'PARALLEL' && rawMode !== 'FLASHBACK') {
                        throw new Error(`--mode 仅支持 MAINLINE / PARALLEL / FLASHBACK，收到: ${rawMode}`);
                    }
                    timelineMode = rawMode;
                }
                const targetDay = getIntFlag(parsed.flags, 'target-day');
                const rawPov = getStringFlag(parsed.flags, 'pov');
                const povCharIds = rawPov
                    ? rawPov
                          .split(',')
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0)
                    : undefined;

                const store = new BookStore(parsed.bookRoot, system);
                const engine = new NarrativeEngine({
                    store,
                    llm: resolveLlm(),
                    system
                });

                const result = await engine.stepChapter({
                    chapterGoal: goal,
                    ...(chapterNumber !== undefined ? { chapterNumber } : {}),
                    ...(timelineMode !== undefined ? { timelineMode } : {}),
                    ...(targetDay !== undefined ? { targetDay } : {}),
                    ...(povCharIds !== undefined ? { povCharIds } : {})
                });

                printOutput(
                    stdout,
                    parsed.json,
                    result,
                    `[step] 第 ${result.chapterNumber} 章已提交 (${result.manuscriptPath})，feat=${result.featCommitSha.slice(0, 8)} state=${result.stateCommitSha.slice(0, 8)}。`
                );
                return 0;
            }

            case 'sync': {
                const store = new BookStore(parsed.bookRoot, system);
                const engine = new NarrativeEngine({
                    store,
                    llm: resolveLlm(),
                    system
                });

                const result = await engine.syncManuscripts();
                printOutput(
                    stdout,
                    parsed.json,
                    result,
                    `[sync] 状态=${result.status}，脏章=${result.dirtyChapters.length}，下游冲突=${result.downstreamConflicts.length}。`
                );
                return 0;
            }

            case 'dream': {
                const store = new BookStore(parsed.bookRoot, system);
                const [worldState, snapshot] = await Promise.all([
                    store.readWorldState(),
                    store.loadSnapshot()
                ]);
                const currentChapter =
                    getIntFlag(parsed.flags, 'chapter') ?? worldState.frontmatter.current_chapter;
                const currentStoryDay =
                    getIntFlag(parsed.flags, 'story-day') ?? worldState.frontmatter.story_day;
                const force = parsed.flags['force'] === true;
                const rawEntities = getStringFlag(parsed.flags, 'entities');
                const activeEntityIds = rawEntities
                    ? rawEntities
                          .split(',')
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0)
                    : Object.keys(snapshot.entities);

                const runner = new DreamingRunner(store, resolveLlm(), system);
                const result = await runner.runDreaming({
                    currentChapter,
                    currentStoryDay,
                    force,
                    activeEntityIds
                });

                printOutput(
                    stdout,
                    parsed.json,
                    result,
                    result.skipped
                        ? '[dream] 未达到睡眠整理阈值，已跳过。'
                        : `[dream] 清洗实体 ${result.vacuumedEntities.length} 个，归档 ${result.archivedFiles.length} 份，切镜信号 ${result.spotlightTriggers.length} 条。`
                );
                return 0;
            }

            case 'status': {
                const store = new BookStore(parsed.bookRoot, system);
                const [config, worldState, txState, snapshot, dirtyChapters] = await Promise.all([
                    store.readBookConfig(),
                    store.readWorldState(),
                    store.readTxState(),
                    store.loadSnapshot(),
                    store.detectDirtyChapters()
                ]);

                const statusPayload = {
                    bookRoot: parsed.bookRoot,
                    bookSlug: config.book_slug,
                    title: config.title,
                    storyDay: worldState.frontmatter.story_day,
                    currentVolume: worldState.frontmatter.current_volume,
                    currentChapter: worldState.frontmatter.current_chapter,
                    povCharacter: worldState.frontmatter.pov_character,
                    timelineMode: worldState.frontmatter.timeline_mode,
                    walPhase: txState.phase,
                    entityCount: Object.keys(snapshot.entities).length,
                    coldArchiveCount: snapshot.coldArchiveIds.length,
                    dirtyChapterCount: dirtyChapters.length
                };

                printOutput(
                    stdout,
                    parsed.json,
                    statusPayload,
                    [
                        `[status] ${statusPayload.title} (${statusPayload.bookSlug})`,
                        `  进度: 第 ${statusPayload.currentVolume} 卷 第 ${statusPayload.currentChapter} 章 (Day ${statusPayload.storyDay}, ${statusPayload.timelineMode})`,
                        `  主视角: ${statusPayload.povCharacter} | WAL: ${statusPayload.walPhase}`,
                        `  实体: ${statusPayload.entityCount} | 冷归档: ${statusPayload.coldArchiveCount} | 待同步脏章: ${statusPayload.dirtyChapterCount}`
                    ].join('\n')
                );
                return 0;
            }

            case 'plot-haystack': {
                const targetChapters = getIntFlag(parsed.flags, 'chapters') ?? 40;
                const report = await runPlotHaystackBenchmark({
                    bookRoot: parsed.bookRoot,
                    llm: resolveLlm(),
                    system,
                    targetChapters
                });

                printOutput(
                    stdout,
                    parsed.json,
                    report,
                    [
                        `[plot-haystack] ${report.totalChapters} 章盲测完成`,
                        `  探针穿帮率: ${(report.summary.breachRate * 100).toFixed(1)}% (${report.summary.breachedCount}/${report.summary.totalProbes})`,
                        `  成对召回率: ${(report.summary.pairedRecallRate * 100).toFixed(1)}% (${report.summary.recalledCount}/${report.summary.totalProbes})`,
                        `  静态前缀一致率: ${(report.summary.prefixHashConsistencyRate * 100).toFixed(1)}% | Token 缓存命中率: ${(report.summary.tokenCacheHitRate * 100).toFixed(1)}%`,
                        `  四联遥测均值 (首5章 -> 末5章): MATTR ${report.telemetryTrend.earlyWindowAvg.mattr500} -> ${report.telemetryTrend.lateWindowAvg.mattr500}, H_K ${report.telemetryTrend.earlyWindowAvg.kontoyiannisEntropy} -> ${report.telemetryTrend.lateWindowAvg.kontoyiannisEntropy}`
                    ].join('\n')
                );
                return 0;
            }
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        stderr(`错误: ${message}\n`);
        return 1;
    }
}

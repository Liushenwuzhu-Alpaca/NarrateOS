import type { CommandDefinition, CommandInvocation, CommandResult, CommandRuntime } from '@deepseek-ai/dsh-commands';
import type { NarrateRuntimeController, StepChapterInputOptions } from './controller.js';

function formatErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const VALID_TIMELINE_MODES = new Set(['MAINLINE', 'PARALLEL', 'FLASHBACK']);

function tokenizeCommandInput(raw: string): string[] {
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
        const token = match[1] ?? match[2] ?? match[3];
        if (token !== undefined) {
            tokens.push(token);
        }
    }
    return tokens;
}

function parseStepCommandArgs(rawInput: string): StepChapterInputOptions {
    const tokens = tokenizeCommandInput(rawInput.trim());
    const options: StepChapterInputOptions = {};
    const positional: string[] = [];

    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i]!;
        const nextVal = (): string => {
            const val = tokens[i + 1];
            if (val === undefined) {
                throw new Error(`参数 ${token} 缺少取值`);
            }
            i += 1;
            return val;
        };

        if (token === '--mode' || token.startsWith('--mode=')) {
            const rawMode = (token.startsWith('--mode=') ? token.slice(7) : nextVal()).toUpperCase();
            if (!VALID_TIMELINE_MODES.has(rawMode)) {
                throw new Error(`--mode 必须为 MAINLINE | PARALLEL | FLASHBACK，收到：${rawMode}`);
            }
            options.timelineMode = rawMode as StepChapterInputOptions['timelineMode'];
            continue;
        }
        if (token === '--day' || token.startsWith('--day=')) {
            const rawDay = token.startsWith('--day=') ? token.slice(6) : nextVal();
            const day = Number(rawDay);
            if (!rawDay.trim() || !Number.isSafeInteger(day)) {
                throw new Error(`--day 必须为整数，收到：${rawDay}`);
            }
            options.targetDay = day;
            continue;
        }
        if (token === '--pov' || token.startsWith('--pov=')) {
            const rawPov = token.startsWith('--pov=') ? token.slice(6) : nextVal();
            const povIds = rawPov
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id.length > 0);
            if (povIds.length === 0) {
                throw new Error('--pov 至少需要提供一个角色 ID');
            }
            options.povCharIds = povIds;
            continue;
        }
        if (token === '--window' || token.startsWith('--window=')) {
            const win = (token.startsWith('--window=') ? token.slice(9) : nextVal()).trim();
            if (!win) {
                throw new Error('--window 不能为空');
            }
            options.parallelWindowId = win;
            continue;
        }
        if (token === '--branch' || token.startsWith('--branch=')) {
            const branch = (token.startsWith('--branch=') ? token.slice(9) : nextVal()).trim();
            if (!branch) {
                throw new Error('--branch 不能为空');
            }
            options.parallelBranchId = branch;
            continue;
        }
        positional.push(token);
    }

    const goal = positional.join(' ').trim();
    if (goal.length > 0) {
        options.chapterGoal = goal;
    }
    return options;
}

function parseYoloCommandArgs(rawInput: string): { targetChapters: number; defaultGoal?: string } {
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
        return { targetChapters: 3 };
    }
    const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    const firstToken = match?.[1] ?? trimmed;
    const restGoal = match?.[2]?.trim();
    const parsed = Number(firstToken);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`章数参数必须为非负整数，收到：${firstToken}`);
    }
    return {
        targetChapters: parsed,
        ...(restGoal && restGoal.length > 0 ? { defaultGoal: restGoal } : {})
    };
}

function parseHealCommandArgs(rawInput: string): { maxAutoRollbackChapters?: number } {
    const tokens = tokenizeCommandInput(rawInput.trim());
    let maxAutoRollbackChapters: number | undefined;
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i]!;
        if (token === '--max-rollback' || token.startsWith('--max-rollback=')) {
            const rawVal = token.startsWith('--max-rollback=')
                ? token.slice('--max-rollback='.length)
                : tokens[++i];
            if (rawVal === undefined) {
                throw new Error('参数 --max-rollback 缺少取值');
            }
            const parsed = Number(rawVal);
            if (!Number.isInteger(parsed) || parsed < 0) {
                throw new Error(`--max-rollback 必须为非负整数，收到：${rawVal}`);
            }
            maxAutoRollbackChapters = parsed;
            continue;
        }
        throw new Error(`未知参数：${token}`);
    }
    return {
        ...(maxAutoRollbackChapters !== undefined ? { maxAutoRollbackChapters } : {})
    };
}

function dispatchBackgroundCommand(
    controller: NarrateRuntimeController,
    busyText: (activeTask: string) => string,
    runTask: () => { task: Promise<unknown>; successText: string }
): CommandResult {
    try {
        controller.assertAdmissionOpen();
        controller.requireBookStore();
        const rt = controller.runtimeStatus;
        if (rt.yolo.running || rt.activeTask !== 'IDLE') {
            return {
                kind: 'error',
                text: busyText(rt.activeTask)
            };
        }
        const { task, successText } = runTask();
        void controller.trackBackgroundTask(
            task.catch((err) => {
                controller.emitEvent('chapter:phase', {
                    phase: 'FAILED',
                    error: formatErr(err)
                });
            })
        );
        return { kind: 'success', text: successText };
    } catch (err) {
        return { kind: 'error', text: formatErr(err) };
    }
}

/**
 * 注册 NarrateOS 聊天栏零开销斜杠命令：
 * - /narrate-status
 * - /narrate-step [--mode MAINLINE|PARALLEL|FLASHBACK] [--day <N>] [--pov <id1,id2>] [--window <id>] [--branch <id>] [目标]
 * - /narrate-yolo [章数] [默认目标文本]
 * - /narrate-halt [--force]
 * - /narrate-dream [--force]
 * - /narrate-sync
 * - /narrate-heal [--max-rollback <N>]
 * - /narrate-signal <指令内容>
 *
 * 所有命令绕过模型（0 Token），校验准入后立即异步启动后台任务或返回只读状态回执，不阻塞聊天输入框。
 */
export function registerNarrateCommands(
    commands: Pick<CommandRuntime, 'register'>,
    controller: NarrateRuntimeController,
    resolveController?: (inv: CommandInvocation) => Promise<NarrateRuntimeController>
): () => void {
    const definitions = buildNarrateCommands(controller);
    const scopedCommands = new WeakMap([[controller, definitions]]);
    const disposers = definitions.map((def, index) => commands.register({
        ...def,
        async handler(inv) {
            try {
                const target = resolveController ? await resolveController(inv) : controller;
                let entries = scopedCommands.get(target);
                if (!entries) {
                    entries = buildNarrateCommands(target);
                    scopedCommands.set(target, entries);
                }
                return await entries[index]!.handler(inv);
            } catch (error) {
                return { kind: 'error', text: formatErr(error) };
            }
        }
    }));
    return () => {
        for (const dispose of disposers) dispose();
    };
}

function buildNarrateCommands(controller: NarrateRuntimeController): CommandDefinition[] {
    return [
        {
            name: 'narrate-status',
            description: '查看当前激活作品、章号、WAL 相位与运行态摘要（0 Token 只读）',
            handler: async (): Promise<CommandResult> => {
                try {
                    controller.assertAdmissionOpen();
                    const store = controller.requireBookStore();
                    const [config, worldState, txState, pendingSignals] = await Promise.all([
                        store.readBookConfig(),
                        store.readWorldState(),
                        store.readTxState(),
                        controller.countPendingSignals()
                    ]);
                    const rt = controller.runtimeStatus;
                    return {
                        kind: 'success',
                        text: [
                            `作品：${config.title} (${config.book_slug})`,
                            `卷/章：第 ${worldState.frontmatter.current_volume} 卷 第 ${txState.last_committed_ch} 章 (story_day=${worldState.frontmatter.story_day})`,
                            `WAL 相位：${txState.phase} | 运行态：${rt.activeTask} | YOLO：${rt.yolo.running ? '运行中' : '空闲'} | 待消费信号：${pendingSignals}`
                        ].join('\n')
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
        },
        {
            name: 'narrate-step',
            description: '触发单章 6 阶段生产管线（0 Token 后台异步执行）',
            input: {
                hint: '[--mode MAINLINE|PARALLEL|FLASHBACK] [--day <N>] [--pov <id1,id2>] [--window <id>] [--branch <id>] [目标]'
            },
            handler: (inv): CommandResult =>
                dispatchBackgroundCommand(
                    controller,
                    (activeTask) =>
                        `当前正在执行任务 (${activeTask})，请等待完成后再触发单章推进。`,
                    () => {
                        const stepOptions = parseStepCommandArgs(inv.rawInput);
                        const summaryParts = [
                            `目标：${stepOptions.chapterGoal ?? '自动沿用下一章候选方向'}`
                        ];
                        if (stepOptions.timelineMode) {
                            summaryParts.push(`mode=${stepOptions.timelineMode}`);
                        }
                        if (stepOptions.targetDay !== undefined) {
                            summaryParts.push(`day=${stepOptions.targetDay}`);
                        }
                        if (stepOptions.povCharIds) {
                            summaryParts.push(`pov=${stepOptions.povCharIds.join(',')}`);
                        }
                        return {
                            task: controller.stepChapter(stepOptions),
                            successText: `已异步启动下一章生成管线（${summaryParts.join(' | ')}）。`
                        };
                    }
                )
        },
        {
            name: 'narrate-yolo',
            description: '启动 YOLO 连续自治推章（用法：/narrate-yolo [章数，默认 3] [默认目标文本]）',
            input: { hint: '[targetChapters] [defaultGoal]' },
            handler: async (inv): Promise<CommandResult> => {
                try {
                    controller.assertAdmissionOpen();
                    controller.requireBookStore();
                    const parsed = parseYoloCommandArgs(inv.rawInput);
                    const started = await controller.startYolo(parsed);
                    return {
                        kind: 'success',
                        text: `已启动 YOLO 连续推进（目标章数：${started.targetChapters}${parsed.defaultGoal ? ` | 默认目标：${parsed.defaultGoal}` : ''}）。`
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
        },
        {
            name: 'narrate-halt',
            description: '请求停机（默认安全检查点软停机，--force 立即硬中断）',
            input: { hint: '[--force]' },
            handler: (inv): CommandResult => {
                try {
                    const tokens = tokenizeCommandInput(inv.rawInput.trim());
                    for (const token of tokens) {
                        if (token !== '--force') {
                            return {
                                kind: 'error',
                                text: `未知参数：${token}（仅支持 --force）`
                            };
                        }
                    }
                    const force = tokens.includes('--force');
                    const status = controller.requestHalt({ force });
                    return {
                        kind: 'success',
                        text: force
                            ? `已发出立即硬中断停机指令（force=true，当前任务：${status.activeTask}）。`
                            : `已发出安全点优雅停机指令（force=false，当前任务：${status.activeTask}）。`
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
        },
        {
            name: 'narrate-dream',
            description: '后台异步启动多轮 Dreaming 整理与资产维护（支持 --force）',
            input: { hint: '[--force]' },
            handler: (inv): CommandResult =>
                dispatchBackgroundCommand(
                    controller,
                    (activeTask) =>
                        `当前正在执行任务 (${activeTask})，禁止并发启动 Dreaming。`,
                    () => {
                        const force = inv.rawInput.includes('--force');
                        return {
                            task: controller.runDreaming({ force }),
                            successText: `已异步启动多轮 Dreaming 整理任务${force ? ' (force=true)' : ''}。`
                        };
                    }
                )
        },
        {
            name: 'narrate-sync',
            description: '后台异步执行手稿真源 SHA-256 对账同步 (Sync)',
            handler: (): CommandResult =>
                dispatchBackgroundCommand(
                    controller,
                    (activeTask) =>
                        `当前正在执行任务 (${activeTask})，禁止并发执行 Sync。`,
                    () => ({
                        task: controller.syncManuscripts(),
                        successText: '已异步启动手稿增量同步 (Sync)。'
                    })
                )
        },
        {
            name: 'narrate-heal',
            description: '后台异步执行跨章冲突自愈分级修复与回滚重跑',
            input: { hint: '[--max-rollback <N>]' },
            handler: (inv): CommandResult =>
                dispatchBackgroundCommand(
                    controller,
                    (activeTask) =>
                        `当前正在执行任务 (${activeTask})，禁止并发执行自愈。`,
                    () => {
                        const healArgs = parseHealCommandArgs(inv.rawInput);
                        return {
                            task: controller.healFromSyncConflicts(healArgs),
                            successText: `已异步启动跨章冲突自愈流程${healArgs.maxAutoRollbackChapters !== undefined ? ` (maxRollback=${healArgs.maxAutoRollbackChapters})` : ''}。`
                        };
                    }
                )
        },
        {
            name: 'narrate-signal',
            description: '向安全点队列投递微调导演指令（0 Token，下章安全点消费）',
            input: { hint: '<微调指令内容>' },
            handler: async (inv): Promise<CommandResult> => {
                try {
                    controller.assertAdmissionOpen();
                    const reason = inv.rawInput.trim();
                    if (reason.length === 0) {
                        return {
                            kind: 'error',
                            text: '请提供微调指令内容，例如：/narrate-signal 下一章加重码头雾夜压迫感'
                        };
                    }
                    const sig = await controller.enqueueSignal({
                        type: 'DIRECTOR_NOTE',
                        reason
                    });
                    return {
                        kind: 'success',
                        text: `已投递微调信号至安全点队列（目标第 ${sig.chapter} 章）：${sig.reason}`
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
        }
    ];
}

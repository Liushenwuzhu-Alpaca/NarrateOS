import type { CommandDefinition, CommandResult, CommandRuntime } from '@deepseek-ai/dsh-commands';
import { DEFAULT_YOLO_GOAL, type NarrateRuntimeController } from './controller.js';

function formatErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * 注册 NarrateOS 聊天栏零开销斜杠命令：
 * - /narrate-step [目标]
 * - /narrate-yolo [章数]
 * - /narrate-halt
 * - /narrate-dream [--force]
 * - /narrate-sync
 * - /narrate-signal <指令内容>
 *
 * 所有命令绕过模型（0 Token），校验准入后立即异步启动后台任务并返回短文本回执，不阻塞聊天输入框。
 */
export function registerNarrateCommands(
    commands: Pick<CommandRuntime, 'register'>,
    controller: NarrateRuntimeController
): () => void {
    const definitions: CommandDefinition[] = [
        {
            name: 'narrate-step',
            description: '触发单章 6 阶段生产管线（0 Token 后台异步执行）',
            input: { hint: '[可选章节创作目标]' },
            handler: (inv): CommandResult => {
                try {
                    controller.assertAdmissionOpen();
                    controller.requireBookStore();
                    const rt = controller.runtimeStatus;
                    if (rt.yolo.running || rt.activeTask !== 'IDLE') {
                        return {
                            kind: 'error',
                            text: `当前正在执行任务 (${rt.activeTask})，请等待完成后再触发单章推进。`
                        };
                    }

                    const goal = inv.rawInput.trim() || DEFAULT_YOLO_GOAL;
                    void controller.trackBackgroundTask(
                        controller
                            .stepChapter({ chapterGoal: goal })
                            .catch((err) => {
                                controller.emitEvent('chapter:phase', {
                                    phase: 'FAILED',
                                    error: formatErr(err)
                                });
                            })
                    );
                    return {
                        kind: 'success',
                        text: `已异步启动下一章生成管线（目标：${goal}）。`
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
        },
        {
            name: 'narrate-yolo',
            description: '启动 YOLO 连续自治推章（用法：/narrate-yolo [章数，默认 3]）',
            input: { hint: '[targetChapters]' },
            handler: async (inv): Promise<CommandResult> => {
                try {
                    controller.assertAdmissionOpen();
                    controller.requireBookStore();
                    const trimmed = inv.rawInput.trim();
                    let targetChapters = 3;
                    if (trimmed.length > 0) {
                        const parsed = Number(trimmed);
                        if (!Number.isInteger(parsed) || parsed < 0) {
                            return {
                                kind: 'error',
                                text: `章数参数必须为非负整数，收到：${trimmed}`
                            };
                        }
                        targetChapters = parsed;
                    }
                    const started = await controller.startYolo({ targetChapters });
                    return {
                        kind: 'success',
                        text: `已启动 YOLO 连续推进（目标章数：${started.targetChapters}）。`
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
        },
        {
            name: 'narrate-halt',
            description: '请求在当前安全检查点优雅停机并停止 YOLO 连跑',
            handler: (): CommandResult => {
                try {
                    const status = controller.requestHalt();
                    return {
                        kind: 'success',
                        text: `已发出安全点停机指令（当前任务：${status.activeTask}）。`
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
            handler: (inv): CommandResult => {
                try {
                    controller.assertAdmissionOpen();
                    controller.requireBookStore();
                    const rt = controller.runtimeStatus;
                    if (rt.yolo.running || rt.activeTask !== 'IDLE') {
                        return {
                            kind: 'error',
                            text: `当前正在执行任务 (${rt.activeTask})，禁止并发启动 Dreaming。`
                        };
                    }
                    const force = inv.rawInput.includes('--force');
                    void controller.trackBackgroundTask(
                        controller
                            .runDreaming({ force })
                            .catch((err) => {
                                controller.emitEvent('chapter:phase', {
                                    phase: 'FAILED',
                                    error: formatErr(err)
                                });
                            })
                    );
                    return {
                        kind: 'success',
                        text: `已异步启动多轮 Dreaming 整理任务${force ? ' (force=true)' : ''}。`
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
        },
        {
            name: 'narrate-sync',
            description: '后台异步执行手稿真源 SHA-256 对账同步 (Sync)',
            handler: (): CommandResult => {
                try {
                    controller.assertAdmissionOpen();
                    controller.requireBookStore();
                    const rt = controller.runtimeStatus;
                    if (rt.yolo.running || rt.activeTask !== 'IDLE') {
                        return {
                            kind: 'error',
                            text: `当前正在执行任务 (${rt.activeTask})，禁止并发执行 Sync。`
                        };
                    }
                    void controller.trackBackgroundTask(
                        controller
                            .syncManuscripts()
                            .catch((err) => {
                                controller.emitEvent('chapter:phase', {
                                    phase: 'FAILED',
                                    error: formatErr(err)
                                });
                            })
                    );
                    return {
                        kind: 'success',
                        text: '已异步启动手稿增量同步 (Sync)。'
                    };
                } catch (err) {
                    return { kind: 'error', text: formatErr(err) };
                }
            }
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

    const disposers = definitions.map((def) => commands.register(def));
    return () => {
        for (const dispose of disposers) {
            dispose();
        }
    };
}

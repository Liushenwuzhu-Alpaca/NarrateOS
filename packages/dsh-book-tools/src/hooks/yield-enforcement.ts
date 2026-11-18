import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-agent';
import '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'narrateos-book-tools': {
            kind: 'narrateos-book-tools';
        };
    }
}

/** 'agent/turn-stopping' 终态门禁拦截选项 */
export interface YieldEnforcementOptions {
    /** 必须调用方可结束回合的终态工具名（如 yield_outline） */
    expectedYieldTool: string;
    /** 本轮最大步数兜底上限（>= 1） */
    maxSteps: number;
    /** 判断本次运行是否已成功调用终态门禁工具 */
    hasYielded: () => boolean;
    /** 达到 maxSteps 仍未调用终态门禁工具时的收尾回调 */
    onExhausted?: (() => void | Promise<void>) | undefined;
    /** 丢弃未提交 StagingSession 的幂等清理回调 */
    cleanupStaging?: (() => void) | undefined;
}

/**
 * 挂载 'agent/turn-stopping' 防纯文本逃逸 Hook：
 * - 若工种未调用 yield_* 直接企图以纯文本结束回合且 attempts < maxSteps - 1，
 *   调用 agent.steer(...) 注入强制续跑指令；
 * - 达到 maxSteps 仍未提交或 Agent 销毁时安全中止并清理 StagingSession。
 */
export function attachYieldEnforcementHook(
    agentCtx: Context,
    options: YieldEnforcementOptions
): () => void {
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
        throw new Error(`attachYieldEnforcementHook 需要正整数 maxSteps，收到: ${options.maxSteps}`);
    }

    let stepsExecuted = 0;
    let currentStepCountedByPreStep = false;
    let cleaned = false;

    const runCleanupOnce = () => {
        if (cleaned) return;
        cleaned = true;
        options.cleanupStaging?.();
    };

    const disposePreStep = agentCtx.on('agent/pre-step', async (_payload, next) => {
        const decision = await next();
        if (decision.kind === 'enter') {
            stepsExecuted += 1;
            currentStepCountedByPreStep = true;
        }
        return decision;
    });

    const disposePreExecute = agentCtx.on('tools/pre-execute', async (_exec, next) => {
        const decision = await next();
        if (decision.kind !== 'cancel' && !currentStepCountedByPreStep) {
            stepsExecuted += 1;
        }
        return decision;
    });

    const disposeTurnStopping = agentCtx.on('agent/turn-stopping', async ({ agent, signal }) => {
        if (options.hasYielded()) {
            currentStepCountedByPreStep = false;
            return;
        }
        if (signal.aborted) {
            runCleanupOnce();
            return;
        }

        if (currentStepCountedByPreStep) {
            currentStepCountedByPreStep = false;
        } else {
            stepsExecuted += 1;
        }

        if (stepsExecuted < options.maxSteps) {
            const remaining = options.maxSteps - 1 - stepsExecuted;
            agent.steer(
                createUserMessage({
                    content: [
                        {
                            type: 'text',
                            text: `尚未调用终态门禁工具 ${options.expectedYieldTool}，禁止直接以纯文本结束回合。请立即完成必要操作并调用 ${options.expectedYieldTool} 提交结构化结果（剩余纠正步数: ${remaining}）。`
                        }
                    ],
                    source: { kind: 'narrateos-book-tools' }
                })
            );
            return;
        }

        runCleanupOnce();
        if (options.onExhausted) {
            await options.onExhausted();
        }
    });

    const disposeAgentDisposed = agentCtx.on('agent/disposed', () => {
        runCleanupOnce();
    });

    return () => {
        disposePreStep();
        disposePreExecute();
        disposeTurnStopping();
        disposeAgentDisposed();
        runCleanupOnce();
    };
}

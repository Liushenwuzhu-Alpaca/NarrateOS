import { setTimeout as delay } from 'node:timers/promises';
import { inspectTraceRun, listTraceRuns, pruneTraceRun, readTraceCall, readTraceEvents, type TraceEvent } from '@narrateos/core';
import type { ParsedCliCommand } from './cli.js';

/** 只读查看与显式确认清理；不会启动模型或写作任务。 */
export async function runTraceCommand(parsed: ParsedCliCommand, stdout: (text: string) => void): Promise<void> {
    const action = parsed.positionals[1] ?? 'list';
    if (parsed.positionals.length > 2) throw new Error('trace 不接受额外位置参数');
    const flag = (name: string): string | undefined => {
        const value = parsed.flags[name];
        return typeof value === 'string' ? value : undefined;
    };
    const print = (value: unknown): void => stdout(`${JSON.stringify(value, null, 2)}\n`);
    if (action === 'list' || action === 'stats') {
        const result = await listTraceRuns(parsed.bookRoot);
        if (parsed.json || action === 'stats') { print(action === 'stats' ? { runs: result.runs.length, bytes: result.bytes } : result); return; }
        for (const run of result.runs) {
            stdout(`${run.run_id}  ${run.status}  ${run.operation}  ${run.started_at}  ${run.bytes} bytes\n`);
        }
        stdout(`共 ${result.runs.length} 次运行，${result.bytes} bytes\n`);
        return;
    }
    if (!['events', 'follow', 'show', 'prune'].includes(action)) throw new Error(`未知 trace 操作: ${action}`);
    const runId = flag('run');
    if (!runId) throw new Error('请用 --run 指定完整运行 ID（通过 trace list 查看）');
    if (action === 'show') {
        const callId = flag('call');
        const part = flag('part');
        const artifactId = flag('artifact');
        if (artifactId) {
            if (flag('call') || flag('part')) throw new Error('--artifact 不能与 --call 或 --part 混用');
            print(await readTraceCall(parsed.bookRoot, runId, artifactId, 'output'));
            return;
        }
        if (!callId || (part !== 'input' && part !== 'output')) throw new Error('trace show 需要 --call <id> --part input|output');
        print(await readTraceCall(parsed.bookRoot, runId, callId, part));
        return;
    }
    if (action === 'prune') {
        const confirmation = flag('confirm');
        const info = await pruneTraceRun(parsed.bookRoot, runId, confirmation);
        print({ action: confirmation === undefined ? 'preview' : 'deleted', run_id: info.run_id, bytes: info.bytes,
            ...(confirmation === undefined ? { confirmation: `确认清理请追加 --confirm ${info.run_id}` } : {}) });
        return;
    }
    const display = (events: TraceEvent[]): void => {
        for (const event of events) {
            // 事件中没有提示词或生成正文，完整内容只通过 show 显式读取。
            stdout(`${JSON.stringify(event)}\n`);
        }
    };
    const first = await readTraceEvents(parsed.bookRoot, runId);
    display(first.events);
    if (action === 'events') return;
    let offset = first.offset;
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        while (!abort.signal.aborted) {
            const info = await inspectTraceRun(parsed.bookRoot, runId);
            const next = await readTraceEvents(parsed.bookRoot, runId, offset);
            display(next.events);
            offset = next.offset;
            if (info.status !== 'active') {
                print({ run_id: runId, status: info.status });
                break;
            }
            await delay(250, undefined, { signal: abort.signal });
        }
    } catch (error) {
        if (!abort.signal.aborted) throw error;
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}

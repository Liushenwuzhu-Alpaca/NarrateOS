import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateStructuredJson, ScriptedLlmAdapter, type CleanroomRequest } from '../ports/llm.js';
import { NodeSystemAdapter } from '../ports/system.js';
import { generateTraced, inspectTraceRun, listTraceRuns, pruneTraceRun, readTraceCall, readTraceEvents, traceEvent, withTraceRun, withTraceStage } from './trace.js';

const directories: string[] = [];
const request: CleanroomRequest = { pool: 'audit', traceStage: 'fact_checker', staticPrefixBlocks: ['私密设定'], dynamicTail: '核查黄铜钥匙归属' };
const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
async function fixture(level = 'full'): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'narrateos-trace-test-'));
    directories.push(root);
    await mkdir(join(root, 'world'));
    await writeFile(join(root, 'world/book_config.yaml'), `trace_level: ${level}\n`);
    return root;
}
afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('作品运行追踪', () => {
    it('保存结构化修复前后真实输入输出，并关联同一阶段、不同调用与重试序号', async () => {
        const root = await fixture();
        const llm = new ScriptedLlmAdapter([{ text: '{"count":"错误类型"}', usage }, { text: '{"count":2}', usage }]);
        await withTraceRun(root, 'step', { chapter: 4, window: 'w', branch: 'a' }, async () => {
            await generateStructuredJson(llm, request, z.object({ count: z.number() }), { maxRetries: 1, backoffMs: [0] });
        });
        const { runs } = await listTraceRuns(root);
        expect(runs[0]).toMatchObject({ operation: 'step', status: 'ok', attributes: { chapter: 4, branch: 'a' } });
        const runId = runs[0]!.run_id;
        const { events } = await readTraceEvents(root, runId);
        const started = events.filter((event) => event.type === 'call.started');
        expect(started.map((event) => event.data['attempt'])).toEqual([1, 2]);
        expect(started[0]!.data['stage_id']).toBe(started[1]!.data['stage_id']);
        expect(started[0]!.data['call_id']).not.toBe(started[1]!.data['call_id']);
        for (let index = 0; index < started.length; index++) {
            const callId = String(started[index]!.data['call_id']);
            expect(await readTraceCall(root, runId, callId, 'input')).toMatchObject({ dynamicTail: llm.history[index]!.request.dynamicTail });
        }
        expect(await readTraceCall(root, runId, String(started[0]!.data['call_id']), 'output')).toMatchObject({ text: '{"count":"错误类型"}' });
        expect(JSON.stringify(events)).not.toContain('私密设定');
        expect(events.some((event) => event.type === 'call.validation_failed')).toBe(true);
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
        const system = new NodeSystemAdapter();
        await system.initRepo(root);
        await system.commitPaths(root, ['.'], 'test: initialize book');
        const { stdout } = await promisify(execFile)('git', ['-C', root, 'ls-files', '.ops/traces']);
        expect(stdout).toBe('');
        await system.cleanUntracked(root);
        expect((await inspectTraceRun(root, runId)).status).toBe('ok');
    });

    it('追踪列表忽略系统文件和编辑器临时目录，空间统计仍包含它们', async () => {
        const root = await fixture();
        await withTraceRun(root, 'sync', {}, async () => {});
        const before = await listTraceRuns(root);
        const traceRoot = join(root, '.ops/traces');
        await writeFile(join(traceRoot, '.DS_Store'), '系统文件');
        await writeFile(join(traceRoot, 'editor-backup'), '临时备份');
        await mkdir(join(traceRoot, '.editor-temp'));
        const after = await listTraceRuns(root);
        expect(after.runs).toEqual(before.runs);
        expect(after.bytes - before.bytes).toBe(Buffer.byteLength('系统文件临时备份'));
    });

    it.each(['metadata', 'off'])('%s 档不保存内容，业务异常不会导致隐式重跑', async (level) => {
        const root = await fixture(level);
        const failure = new Error('业务失败');
        let calls = 0;
        await expect(withTraceRun(root, 'step', {}, async () => {
            calls++;
            await generateTraced(new ScriptedLlmAdapter([{ text: '原始正文', usage }]), request);
            throw failure;
        })).rejects.toBe(failure);
        expect(calls).toBe(1);
        const result = await listTraceRuns(root);
        if (level === 'off') expect(result.runs).toEqual([]);
        else {
            expect(result.runs[0]!.status).toBe('error');
            const files = await readdir(join(root, '.ops/traces', result.runs[0]!.run_id));
            expect(files.some((file) => /\.(input|output)\.json$/.test(file))).toBe(false);
            expect(JSON.stringify((await readTraceEvents(root, result.runs[0]!.run_id)).events)).not.toContain('原始正文');
        }
    });

    it('记录目录不可用时报警但不改变模型结果或重复业务调用', async () => {
        const root = await fixture();
        await mkdir(join(root, '.ops'));
        await writeFile(join(root, '.ops/traces'), '阻止创建目录');
        const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const llm = new ScriptedLlmAdapter([{ text: '唯一结果', usage }]);
        const result = await withTraceRun(root, 'step', {}, () => generateTraced(llm, request));
        expect(result.text).toBe('唯一结果');
        expect(llm.history).toHaveLength(1);
        expect(warning).toHaveBeenCalled();
    });

    it('响应落盘失败仍返回成功结果，记录标为不完整且不重调模型', async () => {
        const root = await fixture();
        const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const llm = new ScriptedLlmAdapter([async () => {
            const run = (await listTraceRuns(root)).runs[0]!;
            const event = (await readTraceEvents(root, run.run_id)).events.find((item) => item.type === 'call.started')!;
            await mkdir(join(root, '.ops/traces', run.run_id, `${String(event.data['call_id'])}.output.json`));
            return { text: '写作成功', usage };
        }]);
        expect((await withTraceRun(root, 'step', {}, () => generateTraced(llm, request))).text).toBe('写作成功');
        expect(llm.history).toHaveLength(1);
        expect((await listTraceRuns(root)).runs[0]!.status).toBe('incomplete');
        expect(warning).toHaveBeenCalled();
    });

    it('活动运行拒绝清理，结束后预览不删除，完整 ID 确认才清理', async () => {
        const root = await fixture();
        const ready = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const running = withTraceRun(root, 'dream', {}, async () => { ready.resolve(); await release.promise; });
        try {
            await ready.promise;
            const run = (await listTraceRuns(root)).runs[0]!;
            expect(run.status).toBe('active');
            await expect(pruneTraceRun(root, run.run_id, run.run_id)).rejects.toThrow('禁止清理');
            release.resolve();
            await running;
            expect((await pruneTraceRun(root, run.run_id)).status).toBe('ok');
            expect((await inspectTraceRun(root, run.run_id)).status).toBe('ok');
            await expect(pruneTraceRun(root, run.run_id, 'wrong')).rejects.toThrow('确认值');
            await pruneTraceRun(root, run.run_id, run.run_id);
            expect((await listTraceRuns(root)).runs).toEqual([]);
        } finally { release.resolve(); await running; }
    });

    it('并行异步阶段不串用 stage_id，字节游标保留未写完的中文事件', async () => {
        const root = await fixture();
        const release = Promise.withResolvers<void>();
        await withTraceRun(root, 'step', {}, async () => {
            await Promise.all([
                withTraceStage('a', async () => { await release.promise; await traceEvent('marker', { value: '甲' }); }),
                withTraceStage('b', async () => { await traceEvent('marker', { value: '乙' }); release.resolve(); })
            ]);
        });
        const run = (await listTraceRuns(root)).runs[0]!;
        const first = await readTraceEvents(root, run.run_id);
        expect(first.events.filter((event) => event.type === 'marker').map((event) => [event.data['stage'], event.data['value']])).toEqual([['b', '乙'], ['a', '甲']]);
        const path = join(root, '.ops/traces', run.run_id, 'events.jsonl');
        const extra = JSON.stringify({ version: 1, run_id: run.run_id, type: 'marker', data: { value: '中文' } });
        await appendFile(path, extra);
        expect((await readTraceEvents(root, run.run_id, first.offset)).events).toEqual([]);
        await appendFile(path, '\n');
        expect((await readTraceEvents(root, run.run_id, first.offset)).events[0]!.data['value']).toBe('中文');
        await expect(readTraceEvents(root, '../escape')).rejects.toThrow('ID');
        await symlink(join(root, 'world/book_config.yaml'), join(root, '.ops/traces', run.run_id, 'linked.output.json'));
        await expect(readTraceCall(root, run.run_id, 'linked', 'output')).rejects.toThrow('符号链接');
        await expect(pruneTraceRun(root, run.run_id, run.run_id)).rejects.toThrow('符号链接');
        expect(await readFile(join(root, 'world/book_config.yaml'), 'utf8')).toContain('trace_level');
    });

    it('真实子进程被终止后只显示未完成，不伪造业务失败事件', async () => {
        const root = await fixture();
        const moduleUrl = new URL('./trace.ts', import.meta.url).href;
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
            import { withTraceRun } from ${JSON.stringify(moduleUrl)};
            await withTraceRun(${JSON.stringify(root)}, 'step', {}, async () => {
                process.stdin.resume();
                process.stdout.write('ready');
                await new Promise(() => {});
            });
        `], { stdio: ['pipe', 'pipe', 'pipe'] });
        const exited = once(child, 'exit');
        let stderr = '';
        child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        try {
            await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error(`追踪子进程提前退出: ${stderr}`); })]);
            const run = (await listTraceRuns(root)).runs[0]!;
            expect(run.status).toBe('active');
            child.kill('SIGKILL');
            await exited;
            expect((await inspectTraceRun(root, run.run_id)).status).toBe('incomplete');
            expect((await readTraceEvents(root, run.run_id)).events.some((event) => event.type === 'run.finished')).toBe(false);
            await pruneTraceRun(root, run.run_id, run.run_id);
            expect((await listTraceRuns(root)).runs).toEqual([]);
        } finally {
            child.kill('SIGKILL');
            await exited;
        }
    });
});

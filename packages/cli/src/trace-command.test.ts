import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { generateTraced, listTraceRuns, readTraceEvents, ScriptedLlmAdapter, traceArtifact, withTraceRun } from '@narrateos/core';
import { runCli } from './cli.js';

const directories: string[] = [];
afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('trace 命令', () => {
    it('完整查看调用与草稿，预览和错误确认保留记录，正确确认才删除', async () => {
        const root = await mkdtemp(join(tmpdir(), 'narrateos-trace-cli-'));
        directories.push(root);
        await mkdir(join(root, 'world'));
        await writeFile(join(root, 'world/book_config.yaml'), 'trace_level: full\n');
        await withTraceRun(root, 'step', { chapter: 1 }, async () => {
            await generateTraced(new ScriptedLlmAdapter([{ text: '测试正文', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }]), {
                pool: 'strong_creative', traceStage: 'writer', staticPrefixBlocks: ['测试设定'], dynamicTail: '写第一章'
            });
            await traceArtifact('draft.before_gate', '测试正文');
        });
        const runId = (await listTraceRuns(root)).runs[0]!.run_id;
        const events = (await readTraceEvents(root, runId)).events;
        const callId = String(events.find((event) => event.type === 'call.started')!.data['call_id']);
        const artifactId = String(events.find((event) => event.type === 'artifact.saved')!.data['artifact_id']);
        let stdout = '';
        let stderr = '';
        const execute = async (args: string[]) => {
            stdout = ''; stderr = '';
            return await runCli(['trace', ...args, '--book', root], { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } });
        };
        expect(await execute(['list', '--json'])).toBe(0);
        expect(JSON.parse(stdout).runs[0]).toMatchObject({ run_id: runId, status: 'ok', operation: 'step' });
        expect(stdout).not.toContain('测试正文');
        expect(await execute(['stats'])).toBe(0);
        expect(JSON.parse(stdout).bytes).toBeGreaterThan(Buffer.byteLength('测试正文'));
        expect(await execute(['follow', '--run', runId])).toBe(0);
        expect(stdout).toContain('call.started');
        expect(stdout).toContain('run.finished');
        expect(stdout).not.toContain('测试设定');
        expect(await execute(['show', '--run', runId, '--call', callId, '--part', 'input'])).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ dynamicTail: '写第一章', staticPrefixBlocks: ['测试设定'] });
        expect(await execute(['show', '--run', runId, '--call', callId, '--part', 'output'])).toBe(0);
        expect(JSON.parse(stdout).text).toBe('测试正文');
        expect(await execute(['show', '--run', runId, '--artifact', artifactId])).toBe(0);
        expect(JSON.parse(stdout)).toEqual({ kind: 'draft.before_gate', content: '测试正文' });
        expect(await execute(['prune', '--run', runId])).toBe(0);
        expect(JSON.parse(stdout).action).toBe('preview');
        expect(await execute(['prune', '--run', runId, '--confirm', 'wrong'])).toBe(1);
        expect(stderr).toContain('确认值');
        expect((await listTraceRuns(root)).runs[0]!.run_id).toBe(runId);
        expect(await execute(['prune', '--run', runId, '--confirm', runId])).toBe(0);
        expect(JSON.parse(stdout).action).toBe('deleted');
        expect((await listTraceRuns(root)).runs).toEqual([]);
    });
});

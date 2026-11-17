import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StagingSessionManager } from './index.js';

const tempDirs: string[] = [];

async function createBookDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'narrateos-staging-test-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'world'), { recursive: true });
    await mkdir(join(dir, 'entities'), { recursive: true });
    await mkdir(join(dir, 'manuscripts'), { recursive: true });
    await mkdir(join(dir, '.ops'), { recursive: true });
    await mkdir(join(dir, '.git'), { recursive: true });

    await writeFile(join(dir, 'world/open_threads.md'), '- [OPEN] 港口的铁箱尚未开启\n', 'utf8');
    await writeFile(join(dir, 'entities/char_001.md'), '# 陈默\n驻留：码头\n', 'utf8');
    await writeFile(join(dir, 'manuscripts/ch_0001.md'), '第一章正文真源。\n', 'utf8');
    await writeFile(join(dir, '.ops/tx.lock'), JSON.stringify({ pid: process.pid }), 'utf8');
    await writeFile(join(dir, '.ops/runs.jsonl'), '{"runId":"r1"}\n', 'utf8');
    await writeFile(join(dir, '.ops/tx_state.json'), '{"phase":"IDLE"}\n', 'utf8');
    await writeFile(join(dir, '.ops/pending_writes.json'), '{"files":[]}\n', 'utf8');
    await writeFile(join(dir, '.ops/dream_watermark.json'), '{"last_dream_ch":0}\n', 'utf8');
    await writeFile(join(dir, '.ops/safe_halt.json'), '{"halted":false}\n', 'utf8');
    await mkdir(join(dir, '.ops/recovery'), { recursive: true });
    await writeFile(join(dir, '.ops/recovery/backup.md'), 'recovery\n', 'utf8');
    await mkdir(join(dir, '.ops/traces/run-1'), { recursive: true });
    await writeFile(join(dir, '.ops/traces/run-1/events.jsonl'), '{}\n', 'utf8');
    await mkdir(join(dir, '.ops/parallel_deltas'), { recursive: true });
    await writeFile(join(dir, '.ops/parallel_deltas/b1.json'), '{}\n', 'utf8');
    await writeFile(join(dir, '.ops/voice_samples.yaml'), 'samples: []\n', 'utf8');
    await writeFile(join(dir, '.ops/signals.jsonl'), '{"type":"tone"}\n', 'utf8');
    await writeFile(join(dir, '.ops/telemetry.jsonl'), '{"ch":1,"entropy":0.8}\n', 'utf8');
    await writeFile(join(dir, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf8');
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('StagingSessionManager', () => {
    it('支持同一 runId 的 Read-Your-Own-Writes、并发 runId 完全隔离及 discard 后磁盘零变动', async () => {
        const bookRoot = await createBookDir();
        const staging = new StagingSessionManager();

        const beforeThreads = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
        const beforeChar = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');

        staging.begin('run-a', bookRoot);
        staging.begin('run-b', bookRoot);

        await staging.edit(
            'run-a',
            'world/open_threads.md',
            '- [OPEN] 港口的铁箱尚未开启',
            '- [RESOLVED] 港口的铁箱已于第3章开启'
        );
        staging.stageWrite('run-a', 'entities/char_001.md', '# 陈默\n驻留：三号仓库\n');
        staging.stageWrite('run-a', 'world/new_note.md', '新增临时备注');

        // run-a 立即读到自己修改后的暂存内容（含新建未落盘文件）
        expect(await staging.read('run-a', 'world/open_threads.md')).toContain('[RESOLVED]');
        expect(await staging.read('run-a', 'entities/char_001.md')).toContain('三号仓库');
        expect(await staging.read('run-a', 'world/new_note.md')).toBe('新增临时备注');

        // 并发 run-b 完全隔离，只读取磁盘原始版本
        expect(await staging.read('run-b', 'world/open_threads.md')).toBe(beforeThreads);
        expect(await staging.read('run-b', 'entities/char_001.md')).toBe(beforeChar);
        await expect(staging.read('run-b', 'world/new_note.md')).rejects.toThrow();

        // getPendingWrites 返回当前 runId 的待写快照且不影响磁盘
        const pendingA = staging.getPendingWrites('run-a');
        expect(pendingA.size).toBe(3);
        expect(pendingA.get('world/open_threads.md')).toContain('[RESOLVED]');
        expect(staging.getPendingWrites('run-b').size).toBe(0);

        expect(await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8')).toBe(beforeThreads);
        expect(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8')).toBe(beforeChar);

        // discard 后彻底销毁覆盖层，磁盘字节零变动
        staging.discard('run-a');
        staging.discard('run-b');
        expect(staging.has('run-a')).toBe(false);
        expect(await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8')).toBe(beforeThreads);
        expect(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8')).toBe(beforeChar);
    });

    it('严禁越界路径、.git/、.ops/tx.lock 与写入 manuscripts/', async () => {
        const bookRoot = await createBookDir();

        const staging = new StagingSessionManager();
        staging.begin('run-sec', bookRoot);

        // 禁止写入 manuscripts/
        await expect(
            staging.edit('run-sec', 'manuscripts/ch_0001.md', '真源', '篡改')
        ).rejects.toThrow('manuscripts/');
        expect(() => staging.stageWrite('run-sec', 'manuscripts/ch_0002.md', '私自写章')).toThrow('manuscripts/');

        // 禁止路径穿越、.git/ 与 .ops/tx.lock
        await expect(staging.read('run-sec', '../outside.txt')).rejects.toThrow();
        await expect(staging.read('run-sec', 'world/../world/open_threads.md')).rejects.toThrow();
        await expect(staging.read('run-sec', '.git/HEAD')).rejects.toThrow();
        await expect(staging.read('run-sec', '.ops/tx.lock')).rejects.toThrow();
        await expect(staging.read('run-sec', '/etc/passwd')).rejects.toThrow();
        expect(() => staging.stageWrite('run-sec', '.ops/tx.lock', 'fake')).toThrow();
        expect(() => staging.stageWrite('run-sec', '.git/config', 'fake')).toThrow();

        // manuscripts 原文件绝对未动
        expect(await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8')).toBe('第一章正文真源。\n');
        staging.discard('run-sec');
    });

    it('全面屏蔽引擎内部 .ops/ 路径，同时放行 Dreamer 所需的 voice_samples/signals 与只读 telemetry.jsonl', async () => {
        const bookRoot = await createBookDir();

        const staging = new StagingSessionManager();
        staging.begin('run-ops', bookRoot);

        const blockedOpsTargets = [
            '.ops/runs.jsonl',
            '.ops/tx.lock',
            '.ops/tx_state.json',
            '.ops/pending_writes.json',
            '.ops/recovery/backup.md',
            '.ops/traces/run-1/events.jsonl',
            '.ops/parallel_deltas/b1.json',
            '.ops/dream_watermark.json',
            '.ops/safe_halt.json'
        ];

        for (const target of blockedOpsTargets) {
            await expect(staging.read('run-ops', target)).rejects.toThrow();
            expect(() => staging.stageWrite('run-ops', target, 'overwrite')).toThrow();
            await expect(staging.edit('run-ops', target, 'a', 'b')).rejects.toThrow();
        }

        // Dreamer 可读写 .ops/voice_samples.yaml 与 .ops/signals.jsonl
        expect(await staging.read('run-ops', '.ops/voice_samples.yaml')).toBe('samples: []\n');
        await staging.edit('run-ops', '.ops/voice_samples.yaml', 'samples: []', 'samples:\n  - "短句示范"');
        expect(await staging.read('run-ops', '.ops/voice_samples.yaml')).toContain('短句示范');

        expect(await staging.read('run-ops', '.ops/signals.jsonl')).toBe('{"type":"tone"}\n');
        staging.stageWrite('run-ops', '.ops/signals.jsonl', '{"type":"tone","applied":true}\n');
        expect(await staging.read('run-ops', '.ops/signals.jsonl')).toContain('"applied":true');

        // .ops/telemetry.jsonl 仅允许只读诊断，严禁写入或编辑
        expect(await staging.read('run-ops', '.ops/telemetry.jsonl')).toContain('entropy');
        expect(() => staging.stageWrite('run-ops', '.ops/telemetry.jsonl', 'tamper')).toThrow();
        await expect(staging.edit('run-ops', '.ops/telemetry.jsonl', '0.8', '0.9')).rejects.toThrow();

        staging.discard('run-ops');
    });

    // Windows 非特权账号默认无权创建文件符号链接，跳过该平台独占校验
    it.skipIf(process.platform === 'win32')('严禁通过符号链接逃逸到书库外或读取受限 .ops/ 路径', async () => {
        const bookRoot = await createBookDir();
        const outsideDir = await mkdtemp(join(tmpdir(), 'narrateos-outside-'));
        tempDirs.push(outsideDir);
        await writeFile(join(outsideDir, 'secret.txt'), '机密文件', 'utf8');
        await symlink(join(outsideDir, 'secret.txt'), join(bookRoot, 'world/escape.txt'));
        await symlink(join(bookRoot, '.ops/tx_state.json'), join(bookRoot, 'world/tx_link.json'));

        const staging = new StagingSessionManager();
        staging.begin('run-symlink', bookRoot);

        await expect(staging.read('run-symlink', 'world/escape.txt')).rejects.toThrow();
        await expect(staging.read('run-symlink', 'world/tx_link.json')).rejects.toThrow();

        staging.discard('run-symlink');
    });
});

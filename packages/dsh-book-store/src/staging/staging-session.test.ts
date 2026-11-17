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

    it('严禁越界路径、.git/、.ops/tx.lock、符号链接逃逸与写入 manuscripts/', async () => {
        const bookRoot = await createBookDir();
        const outsideDir = await mkdtemp(join(tmpdir(), 'narrateos-outside-'));
        tempDirs.push(outsideDir);
        await writeFile(join(outsideDir, 'secret.txt'), '机密文件', 'utf8');
        await symlink(join(outsideDir, 'secret.txt'), join(bookRoot, 'world/escape.txt'));

        const staging = new StagingSessionManager();
        staging.begin('run-sec', bookRoot);

        // 禁止写入 manuscripts/
        await expect(
            staging.edit('run-sec', 'manuscripts/ch_0001.md', '真源', '篡改')
        ).rejects.toThrow('manuscripts/');
        expect(() => staging.stageWrite('run-sec', 'manuscripts/ch_0002.md', '私自写章')).toThrow('manuscripts/');

        // 禁止路径穿越、.git/、.ops/tx.lock 及符号链接逃逸
        await expect(staging.read('run-sec', '../outside.txt')).rejects.toThrow();
        await expect(staging.read('run-sec', 'world/../world/open_threads.md')).rejects.toThrow();
        await expect(staging.read('run-sec', '.git/HEAD')).rejects.toThrow();
        await expect(staging.read('run-sec', '.ops/tx.lock')).rejects.toThrow();
        await expect(staging.read('run-sec', '/etc/passwd')).rejects.toThrow();
        await expect(staging.read('run-sec', 'world/escape.txt')).rejects.toThrow();
        expect(() => staging.stageWrite('run-sec', '.ops/tx.lock', 'fake')).toThrow();
        expect(() => staging.stageWrite('run-sec', '.git/config', 'fake')).toThrow();

        // manuscripts 原文件绝对未动
        expect(await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8')).toBe('第一章正文真源。\n');
    });
});

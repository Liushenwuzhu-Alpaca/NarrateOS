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

    it('最小 .ops/ 白名单拦截全部未授权目录（chapter_outlines/session_logs/llm_calls/manual_edits）', async () => {
        const bookRoot = await createBookDir();
        await mkdir(join(bookRoot, '.ops/chapter_outlines'), { recursive: true });
        await mkdir(join(bookRoot, '.ops/session_logs'), { recursive: true });
        await mkdir(join(bookRoot, '.ops/manual_edits'), { recursive: true });
        await writeFile(join(bookRoot, '.ops/chapter_outlines/ch_0001.json'), '{"director_rationale":"secret"}\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/session_logs/s1.json'), '{"requestInput":"secret"}\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/llm_calls.jsonl'), '{"tokens":100}\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/manual_edits/ch_0001.diff'), 'diff\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/signals_cursor.json'), '{"consumedLines":0}\n', 'utf8');

        const staging = new StagingSessionManager();
        staging.begin('run-ops-whitelist', bookRoot);

        const unauthorizedPaths = [
            '.ops/chapter_outlines/ch_0001.json',
            '.ops/session_logs/s1.json',
            '.ops/llm_calls.jsonl',
            '.ops/manual_edits/ch_0001.diff',
            '.ops/signals_cursor.json',
            '.ops/custom_unknown.txt'
        ];
        for (const target of unauthorizedPaths) {
            await expect(staging.read('run-ops-whitelist', target)).rejects.toThrow();
            expect(() => staging.stageWrite('run-ops-whitelist', target, 'x')).toThrow();
            await expect(staging.edit('run-ops-whitelist', target, 'a', 'b')).rejects.toThrow();
        }

        staging.discard('run-ops-whitelist');
    });

    it.skipIf(process.platform === 'win32')('read/edit/stageWrite 解析 realpath（含目录软链与悬空软链）并按读写权限二次校验（ISS-001）', async () => {
        const bookRoot = await createBookDir();
        await mkdir(join(bookRoot, '.ops/session_logs'), { recursive: true });
        await writeFile(join(bookRoot, '.ops/session_logs/x.json'), '{"secret":true}\n', 'utf8');

        await symlink(join(bookRoot, 'manuscripts/ch_0001.md'), join(bookRoot, 'world/link.md'));
        await symlink(join(bookRoot, '.ops/session_logs/x.json'), join(bookRoot, 'world/ops_link.json'));
        await symlink(join(bookRoot, '.ops/telemetry.jsonl'), join(bookRoot, 'world/tel_link.jsonl'));
        await symlink(join(bookRoot, 'manuscripts'), join(bookRoot, 'world/manuscripts_dir_link'));
        await symlink(join(bookRoot, '../nonexistent_outside.txt'), join(bookRoot, 'world/dangling.md'));

        const staging = new StagingSessionManager();
        staging.begin('run-symlink-rw', bookRoot);

        // 指向 manuscripts/ 的文件软链允许只读，但 edit 与 stageWrite 必须拦截
        expect(await staging.read('run-symlink-rw', 'world/link.md')).toContain('第一章正文真源');
        await expect(staging.edit('run-symlink-rw', 'world/link.md', '真源', '篡改')).rejects.toThrow('manuscripts/');
        expect(() => staging.stageWrite('run-symlink-rw', 'world/link.md', '篡改')).toThrow('manuscripts/');

        // 指向未授权 .ops/session_logs 的软链在读写两栖全部拦截
        await expect(staging.read('run-symlink-rw', 'world/ops_link.json')).rejects.toThrow();
        await expect(staging.edit('run-symlink-rw', 'world/ops_link.json', 'secret', 'x')).rejects.toThrow();
        expect(() => staging.stageWrite('run-symlink-rw', 'world/ops_link.json', 'x')).toThrow();

        // 指向只读 .ops/telemetry.jsonl 的软链仅允许 read，禁止 edit/stageWrite
        expect(await staging.read('run-symlink-rw', 'world/tel_link.jsonl')).toContain('entropy');
        await expect(staging.edit('run-symlink-rw', 'world/tel_link.jsonl', '0.8', '0.9')).rejects.toThrow();
        expect(() => staging.stageWrite('run-symlink-rw', 'world/tel_link.jsonl', 'tamper')).toThrow();

        // 指向 manuscripts/ 目录的软链下写入新文件也必须通过最近存在父目录 realpath 拦截
        expect(() =>
            staging.stageWrite('run-symlink-rw', 'world/manuscripts_dir_link/ch_0099.md', '私自写章')
        ).toThrow('manuscripts/');

        // 悬空软链必须全面拒绝
        await expect(staging.read('run-symlink-rw', 'world/dangling.md')).rejects.toThrow();
        await expect(staging.edit('run-symlink-rw', 'world/dangling.md', 'a', 'b')).rejects.toThrow();
        expect(() => staging.stageWrite('run-symlink-rw', 'world/dangling.md', 'x')).toThrow();

        staging.discard('run-symlink-rw');
    });

    it.skipIf(process.platform === 'win32')('硬只读世界保护集允许只读但拦截直接写与软链写入 world/roles/**、author_charter、book_config 与 ops_style_amendments（ISS-002）', async () => {
        const bookRoot = await createBookDir();
        await mkdir(join(bookRoot, 'world/roles/prompts'), { recursive: true });
        await writeFile(join(bookRoot, 'world/roles/planner.yml'), 'maxSteps: 6\n', 'utf8');
        await writeFile(join(bookRoot, 'world/roles/prompts/planner.md'), '# Planner\n', 'utf8');
        await writeFile(join(bookRoot, 'world/author_charter.md'), '# 作者契约\n', 'utf8');
        await writeFile(join(bookRoot, 'world/book_config.yaml'), 'book_slug: demo\n', 'utf8');
        await writeFile(join(bookRoot, 'world/ops_style_amendments.md'), '# 风格补丁\n', 'utf8');

        await symlink(join(bookRoot, 'world/author_charter.md'), join(bookRoot, 'world/charter_link.md'));
        await symlink(join(bookRoot, 'world/roles'), join(bookRoot, 'world/roles_link'));

        const staging = new StagingSessionManager();
        staging.begin('run-readonly-world', bookRoot);

        const protectedPaths = [
            'world/roles/planner.yml',
            'world/roles/prompts/planner.md',
            'world/author_charter.md',
            'world/book_config.yaml',
            'world/ops_style_amendments.md'
        ];
        for (const p of protectedPaths) {
            expect(await staging.read('run-readonly-world', p)).toBeTruthy();
            await expect(staging.edit('run-readonly-world', p, '\n', '\n# tamper')).rejects.toThrow('只读世界契约/配置路径');
            expect(() => staging.stageWrite('run-readonly-world', p, 'tamper')).toThrow('只读世界契约/配置路径');
        }

        // 新建未存在角色文件与通过软链写入同样必须拦截
        expect(() => staging.stageWrite('run-readonly-world', 'world/roles/new_role.yml', 'x: 1')).toThrow('只读世界契约/配置路径');
        await expect(staging.edit('run-readonly-world', 'world/charter_link.md', '作者契约', '篡改')).rejects.toThrow('只读世界契约/配置路径');
        expect(() => staging.stageWrite('run-readonly-world', 'world/charter_link.md', 'tamper')).toThrow('只读世界契约/配置路径');
        expect(() => staging.stageWrite('run-readonly-world', 'world/roles_link/patch.yml', 'cleanroom: true')).toThrow('只读世界契约/配置路径');

        staging.discard('run-readonly-world');
    });
});

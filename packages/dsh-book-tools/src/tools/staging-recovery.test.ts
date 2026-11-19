import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as storePlugin from '@narrateos/dsh-book-store';
import { afterEach, expect, it } from 'vitest';
import { StagingSessionManager, mergeEntityProfilePatch, parseEntityMarkdown } from '@narrateos/dsh-book-store';
import { createBookEditTool } from './book-edit.js';
import { PathFence } from './path-fence.js';

const dirs: string[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'staging-recovery-'));
    dirs.push(root);
    for (const dir of ['world', 'entities/cold_archive']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'world/open_threads.md'), '第一行\n铁箱仍然封存\n末行');
    return root;
}
const entity = `---
entity_id: char_keeper
canonical_name: 守门人
---
## 1. Innate Locks
- [vis: PUBLIC | alpha: 1 | beta: 2] 左臂受伤
  持续限制负重
## 2. Acquired State
- [day:1 | ch:1 | vis: PUBLIC] 驻留门房
## 3. Irreversible Trajectory
## 4. Recent Sliding Buffer
- [day:3 | ch:3] 察看铁锁
- [day:1 | ch:1] 接班
- [day:2 | ch:2] 收到通知
- [day:3 | ch:3] 察看铁锁
- [day:1 | ch:1 | vis: PUBLIC] 驻留门房
`;

it('逐步撤销保留前序合法修改，最后一步移除暂存并保持磁盘', async () => {
    const root = await setup();
    const staging = new StagingSessionManager();
    staging.begin('run', root);
    staging.stageWrite('run', 'world/open_threads.md', '合法版本');
    await staging.edit('run', 'world/open_threads.md', '合法', '错误');
    await staging.revert('run', 'world/open_threads.md');
    expect(await staging.read('run', 'world/open_threads.md')).toBe('合法版本');
    await staging.revert('run', 'world/open_threads.md');
    expect(staging.getPendingWrites('run').has('world/open_threads.md')).toBe(false);
    expect(await staging.read('run', 'world/open_threads.md')).toBe('第一行\n铁箱仍然封存\n末行');
    staging.stageWrite('run', 'world/new.md', '');
    staging.stageWrite('run', 'world/new.md', '新增');
    await staging.revert('run', 'world/new.md');
    expect(staging.getPendingWrites('run').get('world/new.md')).toBe('');
    await staging.revert('run', 'world/new.md');
    expect(staging.getPendingWrites('run').has('world/new.md')).toBe(false);
    await staging.revert('run', 'world/new.md');
    expect(await readFile(join(root, 'world/open_threads.md'), 'utf8')).toBe('第一行\n铁箱仍然封存\n末行');
});

it('替换失败提供可定位的相近行而不写入暂存', async () => {
    const root = await setup();
    const staging = new StagingSessionManager();
    staging.begin('run', root);
    await expect(staging.edit('run', 'world/open_threads.md', '铁箱仍然封住', '替换')).rejects.toThrow('第 2 行');
    expect(staging.getPendingWrites('run').size).toBe(0);
});

it('缓冲先排序去重再保留最近条目，排除活跃状态逐字重复', () => {
    const profile = parseEntityMarkdown(entity);
    const merged = mergeEntityProfilePatch(profile, {
        entity_id: 'char_keeper', buffer_ops: [{ op: 'trim_buffer', max_entries: 2 }]
    }, false);
    expect(merged.recentBuffer.map((entry) => [entry.chapter, entry.text])).toEqual([
        [2, '收到通知'], [3, '察看铁锁']
    ]);
    expect(profile.recentBuffer).toHaveLength(5);
});

it('book_edit即时预警并可撤销，冷宫既有锁也受到保护', async () => {
    const root = await setup();
    await writeFile(join(root, 'entities/cold_archive/char_keeper.md'), entity);
    const ctx = new Context();
    const fiber = await ctx.plugin(storePlugin, { bookRoot: root });
    disposers.push(async () => { await fiber.dispose(); });
    ctx.narrateStore.staging.begin('run', root);
    const tool = createBookEditTool({ store: ctx.narrateStore, runId: 'run', fence: new PathFence(root) });
    const exec = { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1];
    const protectedWrite = await tool.execute({ path: 'world/current_arc_envelope.md', mode: 'write', replacement_text: '新包络' }, exec) as { warning?: string };
    expect(protectedWrite.warning).toContain('mode="revert"');
    const changed = await tool.execute({ path: 'entities/char_keeper.md', mode: 'write', replacement_text: entity.replace('持续限制负重', '可以负重') }, exec) as { warning?: string };
    expect(changed.warning).toContain('Innate Locks');
    await tool.execute({ path: 'entities/char_keeper.md', mode: 'revert' }, exec);
    expect(ctx.narrateStore.staging.getPendingWrites('run').has('entities/char_keeper.md')).toBe(false);
});

it('锁标签换序和默认ACTIVE等价，多行正文与扩展语义变动仍预警', async () => {
    const root = await setup();
    await writeFile(join(root, 'entities/char_keeper.md'), entity);
    const ctx = new Context();
    const fiber = await ctx.plugin(storePlugin, { bookRoot: root });
    disposers.push(async () => { await fiber.dispose(); });
    ctx.narrateStore.staging.begin('run', root);
    const tool = createBookEditTool({ store: ctx.narrateStore, runId: 'run', fence: new PathFence(root) });
    const exec = { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1];
    const reordered = entity.replace('vis: PUBLIC | alpha: 1 | beta: 2', 'beta: 2 | status: ACTIVE | alpha: 1 | vis: PUBLIC');
    const accepted = await tool.execute({ path: 'entities/char_keeper.md', mode: 'write', replacement_text: reordered }, exec) as { warning?: string };
    expect(accepted.warning).toBeUndefined();
    for (const replacement of [
        entity.replace('持续限制负重', '负重已经恢复'),
        entity.replace('alpha: 1', 'alpha: 9'),
        entity.replace('alpha: 1', 'slot: changed'),
        entity.replace('alpha: 1', 'day: 9'),
        entity.replace('alpha: 1', 'ch: 9'),
        entity.replace('vis: PUBLIC', 'vis: SELF_ONLY')
    ]) {
        const result = await tool.execute({ path: 'entities/char_keeper.md', mode: 'write', replacement_text: replacement }, exec) as { warning?: string };
        expect(result.warning).toContain('Innate Locks');
    }
    const missing = await tool.execute({ path: 'entities/char_keeper.md', mode: 'write', replacement_text: entity.replace('## 3. Irreversible Trajectory\n', '') }, exec) as { warning?: string };
    expect(missing.warning).toContain('第 3 区');
});

it('缓冲同文但可见性或续行不同的事实保持独立，未标时的声纹不被裁剪', () => {
    const profile = parseEntityMarkdown(entity);
    profile.recentBuffer = [
        { text: '驻留门房', visibility: 'SELF_ONLY', chapter: 4, continuationLines: [] },
        { text: '驻留门房', visibility: 'PUBLIC', chapter: 5, continuationLines: ['  次日仍留守'] },
        { text: '话语简短', continuationLines: [] }
    ];
    const merged = mergeEntityProfilePatch(profile, {
        entity_id: 'char_keeper', buffer_ops: [{ op: 'trim_buffer', max_entries: 1 }]
    }, false);
    expect(merged.recentBuffer).toEqual([profile.recentBuffer[1], profile.recentBuffer[2]]);
});

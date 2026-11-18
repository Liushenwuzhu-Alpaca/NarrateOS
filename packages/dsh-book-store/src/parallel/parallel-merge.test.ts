import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeSystemAdapter } from '../ports/index.js';
import { BookStore, parseEntityMarkdown } from '../store/index.js';
import {
    ParallelConflictError,
    ParallelSandbox,
    ParallelWindowExceededError
} from './index.js';

const FIXTURE_BOOK_DIR = resolve(import.meta.dirname, '../../../../fixtures/sample-book');
const tempDirs: string[] = [];

async function createParallelTestRepo(
    parallelMaxChapters = 4
): Promise<{ bookRoot: string; system: NodeSystemAdapter; store: BookStore; sandbox: ParallelSandbox }> {
    const bookRoot = await mkdtemp(join(tmpdir(), 'narrateos-parallel-test-'));
    tempDirs.push(bookRoot);
    await cp(FIXTURE_BOOK_DIR, bookRoot, { recursive: true });
    await mkdir(join(bookRoot, 'entities/cold_archive'), { recursive: true });
    await mkdir(join(bookRoot, '.ops'), { recursive: true });

    const char001 = [
        '---',
        'entity_id: char_001',
        'canonical_name: 陆沉',
        'unique_aliases: ["小沉"]',
        'contextual_titles: ["社长"]',
        'historical_anchors: ["ch_0001:旧校舍钥匙持有者"]',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 右手惯用中性笔',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC | slot:location] 驻留节点：旧校舍三楼社团活动室',
        '- [Tracked Numeric Ledger] 社团剩余经费: 1200 | 体力: 100',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 收到废部预警单',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 在活动室窗边整理资料',
        ''
    ].join('\n');

    const char002 = [
        '---',
        'entity_id: char_002',
        'canonical_name: 星野琉璃',
        'unique_aliases: ["琉璃"]',
        'contextual_titles: ["学生会书记"]',
        'historical_anchors: []',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 左撇子',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC | slot:location] 驻留节点：学生会办公室',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 签发旧校舍核查令',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 离开学生会办公室',
        ''
    ].join('\n');

    const itemJade = [
        '---',
        'entity_id: item_jade_seal',
        'canonical_name: 旧校舍铜印',
        'unique_aliases: ["社团印章"]',
        'contextual_titles: []',
        'historical_anchors: ["ch_0001:旧校舍铜印"]',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 唯一实物印章，底座刻有编号 07',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC | owner: unowned | status: ACTIVE | slot:ownership] 存放在旧校舍档案柜',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 封存于档案柜中',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 尚未被任何人取走',
        ''
    ].join('\n');

    await writeFile(join(bookRoot, 'entities/char_001.md'), char001, 'utf8');
    await writeFile(join(bookRoot, 'entities/char_002.md'), char002, 'utf8');
    await writeFile(join(bookRoot, 'entities/item_jade_seal.md'), itemJade, 'utf8');

    const system = new NodeSystemAdapter();
    const store = new BookStore(bookRoot, system);

    const baseConfig = await store.readBookConfig();
    await store.writeBookConfig({
        ...baseConfig,
        parallel_max_chapters: parallelMaxChapters
    });

    await system.initRepo(bookRoot);
    await store.initializeWalFromDisk();
    await system.commitPaths(
        bookRoot,
        ['world', 'entities', 'manuscripts', '.ops/tx_state.json'],
        'chore(init): initialize parallel test book'
    );

    const sandbox = new ParallelSandbox(store, system);
    return { bookRoot, system, store, sandbox };
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop()!;
        await rm(dir, { recursive: true, force: true });
    }
});

describe('ParallelSandbox (PARALLEL 分叉暂存与 3-Way Merge)', () => {
    it('开窗提交失败后可复用原标签重试，但拒绝过期分叉标签', async () => {
        const { bookRoot, system, store, sandbox } = await createParallelTestRepo();
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('模拟提交失败'));
        await expect(sandbox.forkWindow({ windowId: 'retry' })).rejects.toThrow('模拟提交失败');
        expect((await store.readWorldState()).frontmatter.timeline_mode).toBe('MAINLINE');
        expect((await sandbox.forkWindow({ windowId: 'retry' })).status).toBe('OPEN');
        await sandbox.mergeWindow({ windowId: 'retry' });
        await expect(sandbox.forkWindow({ windowId: 'retry' })).rejects.toThrow('分叉标签与当前提交不一致');
        expect((await store.readWorldState()).frontmatter.timeline_mode).toBe('MAINLINE');
        expect(await system.readFileAtRef(bookRoot, 'parallel-fork-retry', 'world/world_state.md')).not.toBeNull();
    });
    it('开启 PARALLEL 时间窗会自动打分叉 Git tag、记录广播表并切换 timeline_mode', async () => {
        const { bookRoot, system, store, sandbox } = await createParallelTestRepo(4);

        const windowMeta = await sandbox.forkWindow({
            windowId: 'w01',
            globalBroadcast: {
                weather: '梅雨夜暴雨',
                bellTime: '19:30 全校广播响起'
            }
        });

        expect(windowMeta.windowId).toBe('w01');
        expect(windowMeta.baseTag).toBe('parallel-fork-w01');
        expect(windowMeta.baseDay).toBe(1);
        expect(windowMeta.maxChapters).toBe(4);
        expect(windowMeta.status).toBe('OPEN');
        expect(windowMeta.globalBroadcast).toEqual({
            weather: '梅雨夜暴雨',
            bellTime: '19:30 全校广播响起'
        });

        // 验证 world_state.md 已切换至 PARALLEL，且主时钟保持为 1
        const worldState = await store.readWorldState();
        expect(worldState.frontmatter.timeline_mode).toBe('PARALLEL');
        expect(worldState.frontmatter.story_day).toBe(1);

        // 验证分叉 tag 可读取分叉起点纯净快照
        const snapshotAtTag = await system.readFileAtRef(bookRoot, 'parallel-fork-w01', 'entities/char_001.md');
        expect(snapshotAtTag).toContain('旧校舍三楼社团活动室');

        // 验证窗口元数据持久化在 .ops/parallel_deltas/w01/window.json
        await access(join(bookRoot, '.ops/parallel_deltas/w01/window.json'));
    });

    it('支线增量暂存至 .ops/parallel_deltas/，推进期间不重复累加主时钟，无冲突 3-Way Merge 后单一推进 story_day', async () => {
        const { bookRoot, store, sandbox } = await createParallelTestRepo(4);

        await sandbox.forkWindow({
            windowId: 'w02',
            globalBroadcast: { weather: '台风前夕' }
        });

        // 支线 A：陆沉线推进 1 章、经历 2 天（daySpan: 2）
        await sandbox.stageDelta({
            windowId: 'w02',
            branchId: 'branch_lu',
            povCharacter: 'char_001',
            chaptersUsed: 1,
            daySpan: 2,
            patches: [
                {
                    entity_id: 'char_001',
                    last_seen_ch: 2,
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'location',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                visibility: 'PUBLIC',
                                slotKey: 'location',
                                text: '驻留节点：图书馆地下书库'
                            }
                        }
                    ],
                    buffer_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                text: '在地下书库发现 1998 年社团登记簿'
                            }
                        }
                    ]
                }
            ]
        });

        // 支线 B：星野琉璃线推进 1 章、经历 2 天（daySpan: 2），只修改 char_002
        await sandbox.stageDelta({
            windowId: 'w02',
            branchId: 'branch_ruri',
            povCharacter: 'char_002',
            chaptersUsed: 1,
            daySpan: 2,
            patches: [
                {
                    entity_id: 'char_002',
                    last_seen_ch: 3,
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'location',
                            entry: {
                                storyDay: 2,
                                chapter: 3,
                                visibility: 'PUBLIC',
                                slotKey: 'location',
                                text: '驻留节点：校门警卫室'
                            }
                        }
                    ]
                }
            ]
        });

        // 验证暂存文件已落盘，且暂存期间主时钟 story_day 仍为 1（未重复累加）
        await access(join(bookRoot, '.ops/parallel_deltas/w02/branch_lu.json'));
        await access(join(bookRoot, '.ops/parallel_deltas/w02/branch_ruri.json'));
        const midWorld = await store.readWorldState();
        expect(midWorld.frontmatter.story_day).toBe(1);

        // 汇合执行 3-Way Merge
        const mergeResult = await sandbox.mergeWindow({ windowId: 'w02' });
        expect(mergeResult.mergedBranches).toEqual(['branch_lu', 'branch_ruri']);
        expect(mergeResult.previousStoryDay).toBe(1);
        // 两条并行支线各经历 2 天，主时钟只单一推进 max(2, 2) = 2 天（1 + 2 = 3，绝不重复累加为 5）
        expect(mergeResult.newStoryDay).toBe(3);
        expect(mergeResult.updatedEntities.sort()).toEqual(['char_001', 'char_002']);

        const afterWorld = await store.readWorldState();
        expect(afterWorld.frontmatter.story_day).toBe(3);
        expect(afterWorld.frontmatter.timeline_mode).toBe('MAINLINE');

        const char001Raw = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        const char001 = parseEntityMarkdown(char001Raw);
        expect(char001.acquiredState.some((e) => e.text.includes('图书馆地下书库'))).toBe(true);

        const char002Raw = await readFile(join(bookRoot, 'entities/char_002.md'), 'utf8');
        const char002 = parseEntityMarkdown(char002Raw);
        expect(char002.acquiredState.some((e) => e.text.includes('校门警卫室'))).toBe(true);
    });

    it('同一时间窗内多条支线同时声明获取/转移同一唯一道具时，抛出 ParallelConflictError 并阻断合并', async () => {
        const { bookRoot, store, sandbox } = await createParallelTestRepo(4);

        await sandbox.forkWindow({ windowId: 'w_conflict' });

        // 支线 A 声明由 char_001 取得唯一道具 item_jade_seal
        await sandbox.stageDelta({
            windowId: 'w_conflict',
            branchId: 'branch_a',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'item_jade_seal',
                    last_seen_ch: 2,
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'ownership',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                visibility: 'PUBLIC',
                                owner: 'char_001',
                                status: 'ACTIVE',
                                slotKey: 'ownership',
                                text: '由 char_001 从档案柜取走贴身保管'
                            }
                        }
                    ]
                }
            ]
        });

        // 支线 B 同时声明由 char_002 取得同一唯一道具 item_jade_seal
        await sandbox.stageDelta({
            windowId: 'w_conflict',
            branchId: 'branch_b',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'item_jade_seal',
                    last_seen_ch: 3,
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'ownership',
                            entry: {
                                storyDay: 2,
                                chapter: 3,
                                visibility: 'PUBLIC',
                                owner: 'char_002',
                                status: 'ACTIVE',
                                slotKey: 'ownership',
                                text: '由 char_002 抢先收缴至学生会保险箱'
                            }
                        }
                    ]
                }
            ]
        });

        let caught: unknown;
        try {
            await sandbox.mergeWindow({ windowId: 'w_conflict' });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(ParallelConflictError);
        const conflictErr = caught as ParallelConflictError;
        expect(conflictErr.entityId).toBe('item_jade_seal');
        expect(conflictErr.conflicts).toHaveLength(2);
        expect(conflictErr.conflicts.map((c) => c.branchId).sort()).toEqual(['branch_a', 'branch_b']);

        // 验证合并被阻断：唯一道具磁盘状态未被覆盖，主时钟未推进
        const itemRaw = await readFile(join(bookRoot, 'entities/item_jade_seal.md'), 'utf8');
        expect(itemRaw).toContain('owner: unowned');
        const worldState = await store.readWorldState();
        expect(worldState.frontmatter.story_day).toBe(1);
    });

    it('两条支线在各自角色档案中同时声明持有同一唯一道具时，同样触发 ParallelConflictError 拦截', async () => {
        const { sandbox } = await createParallelTestRepo(4);

        await sandbox.forkWindow({ windowId: 'w_char_item_conflict' });

        await sandbox.stageDelta({
            windowId: 'w_char_item_conflict',
            branchId: 'branch_lu',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'char_001',
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'holding_item_jade_seal',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                visibility: 'PUBLIC',
                                slotKey: 'holding_item_jade_seal',
                                text: '持有唯一道具 item_jade_seal'
                            }
                        }
                    ]
                }
            ]
        });

        await sandbox.stageDelta({
            windowId: 'w_char_item_conflict',
            branchId: 'branch_ruri',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'char_002',
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'holding_item_jade_seal',
                            entry: {
                                storyDay: 2,
                                chapter: 3,
                                visibility: 'PUBLIC',
                                slotKey: 'holding_item_jade_seal',
                                text: '持有唯一道具 item_jade_seal'
                            }
                        }
                    ]
                }
            ]
        });

        await expect(sandbox.mergeWindow({ windowId: 'w_char_item_conflict' })).rejects.toThrow(ParallelConflictError);
    });

    it('对照 book_config.yaml 的 parallel_max_chapters，支线跨度超限时触发显式拦截', async () => {
        const { sandbox } = await createParallelTestRepo(2);

        await sandbox.forkWindow({ windowId: 'w_exceed' });

        await sandbox.stageDelta({
            windowId: 'w_exceed',
            branchId: 'branch_1',
            chaptersUsed: 2,
            daySpan: 1,
            patches: []
        });

        await expect(
            sandbox.stageDelta({
                windowId: 'w_exceed',
                branchId: 'branch_2',
                chaptersUsed: 1,
                daySpan: 1,
                patches: []
            })
        ).rejects.toThrow(ParallelWindowExceededError);
    });

    it('回归[P0]：支线 A 直接修改 item_* 归属而支线 B 在 char_* 中声明持有同一唯一道具时，交叉检测抛出 ParallelConflictError', async () => {
        const { bookRoot, store, sandbox } = await createParallelTestRepo(4);

        await sandbox.forkWindow({ windowId: 'w_cross_path' });

        // 支线 A 直接修改 item_jade_seal 的 owner 为 char_001
        await sandbox.stageDelta({
            windowId: 'w_cross_path',
            branchId: 'branch_a',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'item_jade_seal',
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'ownership',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                visibility: 'PUBLIC',
                                owner: 'char_001',
                                status: 'ACTIVE',
                                slotKey: 'ownership',
                                text: '由 char_001 取得并保管'
                            }
                        }
                    ]
                }
            ]
        });

        // 支线 B 在 char_002 补丁中声明持有 item_jade_seal
        await sandbox.stageDelta({
            windowId: 'w_cross_path',
            branchId: 'branch_b',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'char_002',
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'holding_item_jade_seal',
                            entry: {
                                storyDay: 2,
                                chapter: 3,
                                visibility: 'PUBLIC',
                                slotKey: 'holding_item_jade_seal',
                                text: '持有唯一道具 item_jade_seal'
                            }
                        }
                    ]
                }
            ]
        });

        let caught: unknown;
        try {
            await sandbox.mergeWindow({ windowId: 'w_cross_path' });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(ParallelConflictError);
        const conflictErr = caught as ParallelConflictError;
        expect(conflictErr.entityId).toBe('item_jade_seal');
        expect(conflictErr.conflicts.map((c) => c.branchId).sort()).toEqual(['branch_a', 'branch_b']);

        // 阻断落盘，主时钟不推进
        const itemRaw = await readFile(join(bookRoot, 'entities/item_jade_seal.md'), 'utf8');
        expect(itemRaw).toContain('owner: unowned');
        const worldState = await store.readWorldState();
        expect(worldState.frontmatter.story_day).toBe(1);
    });

    it('回归[P1]：两条支线对同一唯一道具追加互斥 trajectory_ops 时，纳入变动签名并抛出 ParallelConflictError', async () => {
        const { bookRoot, store, sandbox } = await createParallelTestRepo(4);

        await sandbox.forkWindow({ windowId: 'w_traj_conflict' });

        await sandbox.stageDelta({
            windowId: 'w_traj_conflict',
            branchId: 'branch_a',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'item_jade_seal',
                    trajectory_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                text: '在追逐战中沉入旧校舍护城河'
                            }
                        }
                    ]
                }
            ]
        });

        await sandbox.stageDelta({
            windowId: 'w_traj_conflict',
            branchId: 'branch_b',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'item_jade_seal',
                    trajectory_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 3,
                                text: '被学生会锁入地下保险库'
                            }
                        }
                    ]
                }
            ]
        });

        let caught: unknown;
        try {
            await sandbox.mergeWindow({ windowId: 'w_traj_conflict' });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(ParallelConflictError);
        const conflictErr = caught as ParallelConflictError;
        expect(conflictErr.entityId).toBe('item_jade_seal');
        expect(conflictErr.conflicts).toHaveLength(2);

        const itemRaw = await readFile(join(bookRoot, 'entities/item_jade_seal.md'), 'utf8');
        expect(itemRaw).not.toContain('护城河');
        expect(itemRaw).not.toContain('保险库');
        const worldState = await store.readWorldState();
        expect(worldState.frontmatter.story_day).toBe(1);
    });

    it('校验 appendChapter/stageDelta 章号 > baseChapter 与严格递增、统一 daySpan 缺省为 0、回滚清理 pending_writes.json（ISS-049）', async () => {
        const { bookRoot, system, store, sandbox } = await createParallelTestRepo(5);

        // forkWindow 提交失败回滚后不得残留 pending_writes.json
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('模拟 fork 提交失败'));
        await expect(sandbox.forkWindow({ windowId: 'w_fork_fail' })).rejects.toThrow('模拟 fork 提交失败');
        await expect(access(join(bookRoot, '.ops/pending_writes.json'))).rejects.toThrow();

        const meta = await sandbox.forkWindow({ windowId: 'w_order' });
        expect(meta.baseChapter).toBe(1);

        // appendChapter 拒绝 <= baseChapter (1)
        await expect(
            sandbox.appendChapter({
                windowId: 'w_order',
                branchId: 'branch_a',
                chapterNumber: 1,
                patches: []
            })
        ).rejects.toThrow('严格大于分叉基线章号');

        // stageDelta 拒绝 <= baseChapter、非严格递增与跨支线重复章号
        await expect(
            sandbox.stageDelta({
                windowId: 'w_order',
                branchId: 'branch_bad',
                chapterNumbers: [3, 2],
                patches: []
            })
        ).rejects.toThrow('严格递增');

        // 统一 daySpan 缺省为 0
        const ch2Delta = await sandbox.appendChapter({
            windowId: 'w_order',
            branchId: 'branch_a',
            chapterNumber: 2,
            patches: []
        });
        expect(ch2Delta.daySpan).toBe(0);

        const directDelta = await sandbox.stageDelta({
            windowId: 'w_order',
            branchId: 'branch_b',
            chapterNumbers: [3],
            patches: []
        });
        expect(directDelta.daySpan).toBe(0);

        // 同支线非递增章号被拒绝
        await expect(
            sandbox.appendChapter({
                windowId: 'w_order',
                branchId: 'branch_a',
                chapterNumber: 2,
                patches: []
            })
        ).rejects.toThrow('已存在');

        await sandbox.appendChapter({
            windowId: 'w_order',
            branchId: 'branch_a',
            chapterNumber: 4,
            patches: []
        });
        await expect(
            sandbox.appendChapter({
                windowId: 'w_order',
                branchId: 'branch_a',
                chapterNumber: 3,
                patches: []
            })
        ).rejects.toThrow('已存在');
        await expect(
            sandbox.appendChapter({
                windowId: 'w_order',
                branchId: 'branch_a',
                chapterNumber: 4,
                patches: []
            })
        ).rejects.toThrow('已存在');

        // mergeWindow 提交失败回滚后不得残留 pending_writes.json
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('模拟 merge 提交失败'));
        await expect(sandbox.mergeWindow({ windowId: 'w_order' })).rejects.toThrow('模拟 merge 提交失败');
        await expect(access(join(bookRoot, '.ops/pending_writes.json'))).rejects.toThrow();

        const mergeOk = await sandbox.mergeWindow({ windowId: 'w_order' });
        expect(mergeOk.newStoryDay).toBe(1);
        await expect(access(join(bookRoot, '.ops/pending_writes.json'))).rejects.toThrow();
        const headWorld = await system.readFileAtRef(bookRoot, 'HEAD', 'world/world_state.md');
        expect(headWorld).toBe(await readFile(join(bookRoot, 'world/world_state.md'), 'utf8'));
        await store.recoverWal();
    });

    it('extractClaimedItemIds 覆盖第 3/4 区拦截唯一道具冲突（ISS-049）', async () => {
        const { sandbox } = await createParallelTestRepo(4);
        await sandbox.forkWindow({ windowId: 'w_item_sec34' });

        await sandbox.stageDelta({
            windowId: 'w_item_sec34',
            branchId: 'branch_a',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'char_001',
                    trajectory_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                text: '在旧校舍毁掉 item_jade_seal'
                            }
                        }
                    ]
                }
            ]
        });

        await sandbox.stageDelta({
            windowId: 'w_item_sec34',
            branchId: 'branch_b',
            chaptersUsed: 1,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'char_002',
                    buffer_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 3,
                                text: '随身带着 item_jade_seal 前往礼堂'
                            }
                        }
                    ]
                }
            ]
        });

        await expect(sandbox.mergeWindow({ windowId: 'w_item_sec34' })).rejects.toThrow(ParallelConflictError);
    });

    it('并行支线支持 upsert_slot/upsert_ledger 修复、冷宫回查唤醒与分支 L2 章卡增量暂存合并（ISS-005, 006, 024, 046）', async () => {
        const { bookRoot, system, store, sandbox } = await createParallelTestRepo(4);

        const coldChar = [
            '---',
            'entity_id: char_099',
            'canonical_name: 旧任部长',
            'unique_aliases: []',
            'contextual_titles: []',
            'historical_anchors: []',
            'last_seen_ch: 0',
            '---',
            '',
            '## 1. Innate Locks',
            '- [vis: PUBLIC] 已毕业离校',
            '',
            '## 2. Acquired State',
            '',
            '## 3. Irreversible Trajectory',
            '',
            '## 4. Recent Sliding Buffer & Voice',
            ''
        ].join('\n');
        await writeFile(join(bookRoot, 'entities/cold_archive/char_099.md'), coldChar, 'utf8');
        await system.commitPaths(bookRoot, ['entities/cold_archive/char_099.md'], 'chore: add cold archive entity');

        await sandbox.forkWindow({ windowId: 'w_l2_cold' });

        // 支线 A：连续无冒号文本 upsert_slot、upsert_ledger，并暂存第 2 章 L2 卡
        await sandbox.appendChapter({
            windowId: 'w_l2_cold',
            branchId: 'branch_a',
            chapterNumber: 2,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'char_001',
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'location',
                            entry: { storyDay: 2, chapter: 2, text: '转移至二楼楼梯口' }
                        },
                        {
                            op: 'upsert_ledger',
                            entries: { 社团剩余经费: 950 }
                        }
                    ]
                }
            ],
            l2Card: {
                volumeNumber: 1,
                chapterNumber: 2,
                storyDay: 2,
                plotSummary: '陆沉在二楼发现旧档案袋。',
                proseAnchors: ['牛皮纸袋', '半截粉笔'],
                appearanceEntityIds: ['char_001']
            }
        });

        // 支线 B：唤醒冷宫 char_099 并暂存第 3 章 L2 卡（支线间 L2 隔离）
        await sandbox.appendChapter({
            windowId: 'w_l2_cold',
            branchId: 'branch_b',
            chapterNumber: 3,
            daySpan: 1,
            patches: [
                {
                    entity_id: 'char_099',
                    last_seen_ch: 3,
                    acquired_state_ops: [
                        {
                            op: 'upsert_slot',
                            slot_key: 'location',
                            entry: { storyDay: 2, chapter: 3, text: '重返校门口咖啡馆' }
                        }
                    ]
                }
            ],
            l2Card: {
                volumeNumber: 1,
                chapterNumber: 3,
                storyDay: 2,
                plotSummary: '旧任部长现身咖啡馆。',
                appearanceEntityIds: ['char_099']
            }
        });

        expect((await sandbox.getBranchL2Cards('w_l2_cold', 'branch_a')).map((c) => c.chapterNumber)).toEqual([2]);
        expect((await sandbox.getBranchL2Cards('w_l2_cold', 'branch_b')).map((c) => c.chapterNumber)).toEqual([3]);

        // loadBranchSnapshot 对冷宫角色也必须保留原有 Innate Locks
        const baseSnap = await store.loadSnapshot();
        const branchBSnap = await sandbox.loadBranchSnapshot(baseSnap, 'w_l2_cold', 'branch_b');
        expect(branchBSnap.entities['char_099']?.innateLocks[0]?.text).toBe('已毕业离校');
        expect(branchBSnap.coldArchiveIds).not.toContain('char_099');

        const mergeRes = await sandbox.mergeWindow({ windowId: 'w_l2_cold' });
        expect(mergeRes.updatedL2CardPaths).toEqual(['index/L2_cards/vol_01_cards.md']);
        await expect(access(join(bookRoot, '.ops/pending_writes.json'))).rejects.toThrow();
        expect(await system.readFileAtRef(bookRoot, 'HEAD', 'index/L2_cards/vol_01_cards.md')).not.toBeNull();
        expect(await system.readFileAtRef(bookRoot, 'HEAD', 'entities/cold_archive/char_099.md')).toBeNull();
        expect(await system.readFileAtRef(bookRoot, 'HEAD', 'entities/char_099.md')).not.toBeNull();

        const char001 = parseEntityMarkdown(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8'));
        const locs = char001.acquiredState.filter((e) => e.slotKey === 'location');
        expect(locs).toHaveLength(1);
        expect(locs[0]?.text).toBe('转移至二楼楼梯口');
        expect(char001.acquiredState.find((e) => e.isNumericLedger)?.text).toContain('社团剩余经费: 950');

        await expect(access(join(bookRoot, 'entities/cold_archive/char_099.md'))).rejects.toThrow();
        const woken099 = parseEntityMarkdown(await readFile(join(bookRoot, 'entities/char_099.md'), 'utf8'));
        expect(woken099.innateLocks[0]?.text).toBe('已毕业离校');

        const l2CardMd = await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8');
        expect(l2CardMd).toContain('## ch_0002 (day:2)');
        expect(l2CardMd).toContain('- 异象锚点：牛皮纸袋、半截粉笔');
        expect(l2CardMd).toContain('## ch_0003 (day:2)');
        expect(l2CardMd).toContain('旧任部长现身咖啡馆');
    });
});

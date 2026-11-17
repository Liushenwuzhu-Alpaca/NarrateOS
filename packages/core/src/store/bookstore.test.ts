import { access, cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeSystemAdapter } from '../ports/index.js';
import {
    BookStore,
    ForeignKeyError,
    InnateLockViolationError,
    TxLockConflictError,
    parseEntityMarkdown,
    serializeEntityMarkdown
} from './index.js';

const execFileAsync = promisify(execFile);
const FIXTURE_BOOK_DIR = resolve(import.meta.dirname, '../../../../fixtures/sample-book');

const tempDirs: string[] = [];

async function createTempBookRepo(): Promise<{ bookRoot: string; system: NodeSystemAdapter; store: BookStore }> {
    const bookRoot = await mkdtemp(join(tmpdir(), 'narrateos-store-test-'));
    tempDirs.push(bookRoot);
    await cp(FIXTURE_BOOK_DIR, bookRoot, { recursive: true });

    // 补充标准四段式实体与冷归档测试夹具
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
        '- [vis: SELF_ONLY] 左手腕对低温金属过敏',
        '- [vis: PUBLIC] 习惯用右手转中性笔',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC] 驻留节点：旧校舍三楼社团活动室',
        '- [day:1 | ch:01 | vis: SELF_ONLY] 主观认知偏差：以为社团还能撑过月底评审',
        '- [Tracked Numeric Ledger] 社团剩余经费: 1200日元 | 备用钥匙数: 1',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 收到星野琉璃递交的废部预警单',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 在活动室窗边与星野琉璃对峙',
        '- 对话声纹：短句为主，带轻微冷幽默',
        '  > 标本：「废部通知书的纸质不错，拿来折纸飞机刚好。」',
        ''
    ].join('\n');

    const item001 = [
        '---',
        'entity_id: item_001',
        'canonical_name: 黄铜钥匙',
        'unique_aliases: ["旧活动室钥匙"]',
        'contextual_titles: []',
        'historical_anchors: ["ch_0001:黄铜钥匙"]',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 钥匙齿面刻有 1998 字样',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC | owner: char_001 | status: ACTIVE] 持有者：char_001',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 由 char_001 贴身保管',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 放在活动室木桌上反光',
        ''
    ].join('\n');

    const coldChar = [
        '---',
        'entity_id: char_099',
        'canonical_name: 旧任部长',
        'unique_aliases: []',
        'contextual_titles: ["前部长"]',
        'historical_anchors: []',
        'last_seen_ch: 0',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 已毕业离校',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:-30 | ch:00] 移交社团钥匙',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        ''
    ].join('\n');

    await writeFile(join(bookRoot, 'entities/char_001.md'), char001, 'utf8');
    await writeFile(join(bookRoot, 'entities/item_001.md'), item001, 'utf8');
    await writeFile(join(bookRoot, 'entities/cold_archive/char_099.md'), coldChar, 'utf8');

    const system = new NodeSystemAdapter();
    await system.initRepo(bookRoot);
    const store = new BookStore(bookRoot, system);
    await store.initializeWalFromDisk();
    await system.commitPaths(bookRoot, ['.'], 'chore: init sample book fixture');

    return { bookRoot, system, store };
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('BookStore', () => {
    it('排他锁 .ops/tx.lock 支持互斥冲突报错、finally 自动释放及过期死锁清理', async () => {
        const { bookRoot, store } = await createTempBookRepo();

        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolveGate) => {
            releaseFirst = resolveGate;
        });

        const firstTask = store.withTxLock(async () => {
            // 持锁期间并发尝试获取应立即冲突报错
            await expect(store.withTxLock(async () => 'should-not-run')).rejects.toThrow(TxLockConflictError);
            releaseFirst();
            await firstGate;
            return 'ok';
        });

        await expect(firstTask).resolves.toBe('ok');

        // 异常退出后锁也必须释放
        await expect(
            store.withTxLock(async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');

        // 释放后可以再次获取
        await expect(store.withTxLock(async () => 'reacquired')).resolves.toBe('reacquired');

        // 模拟死进程残留的过期锁（不存在的 PID + 过期时间戳）
        await writeFile(
            join(bookRoot, '.ops/tx.lock'),
            JSON.stringify({ pid: 99999999, acquiredAt: '2020-01-01T00:00:00.000Z' }),
            'utf8'
        );
        await expect(store.withTxLock(async () => 'recovered-stale-lock')).resolves.toBe('recovered-stale-lock');
    });

    it('存活持锁进程不因锁龄超时被抢占，释放时保留替换锁', async () => {
        const { bookRoot, store } = await createTempBookRepo();
        const lockPath = join(bookRoot, '.ops/tx.lock');
        const oldLiveLock = JSON.stringify({ pid: process.pid, acquiredAt: '2020-01-01T00:00:00.000Z' });
        await writeFile(lockPath, oldLiveLock, 'utf8');
        await expect(store.withTxLock(async () => '不应进入')).rejects.toThrow(TxLockConflictError);
        expect(await readFile(lockPath, 'utf8')).toBe(oldLiveLock);
        await rm(lockPath);

        await store.withTxLock(async () => {
            await writeFile(lockPath, oldLiveLock, 'utf8');
        });
        expect(await readFile(lockPath, 'utf8')).toBe(oldLiveLock);
    });

    it('正文提交失败后从 Git 已提交相位恢复，不继续抽取未提交正文', async () => {
        const { bookRoot, system, store } = await createTempBookRepo();
        await store.beginDraft(2);
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('提交中断'));
        await expect(store.commitDraft(2, '未提交正文')).rejects.toThrow('提交中断');
        const recovered = await store.recoverWal();
        expect(recovered.action).toBe('ROLLED_BACK_DRAFT');
        expect(recovered.phase).toBe('IDLE');
        expect((await store.readTxState()).last_committed_ch).toBe(1);
        await expect(access(join(bookRoot, 'manuscripts/ch_0002.md'))).rejects.toThrow();
    });

    it('状态提交失败后恢复到已提交正文并要求重新抽取', async () => {
        const { system, store } = await createTempBookRepo();
        await store.commitDraft(2, '已经提交的正文');
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('提交中断'));
        await expect(store.applyStatePatch(2, [])).rejects.toThrow('提交中断');
        const recovered = await store.recoverWal();
        expect(recovered.action).toBe('NEEDS_STATE_EXTRACTION');
        expect(recovered.phase).toBe('FEAT_COMMITTED');
        expect((await store.readTxState()).last_committed_ch).toBe(1);
    });

    it('睡眠提交失败后恢复已提交状态相位', async () => {
        const { system, store } = await createTempBookRepo();
        await store.commitDraft(2, '已经提交的正文');
        await store.applyStatePatch(2, []);
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('提交中断'));
        await expect(store.markDreamCommitted(2)).rejects.toThrow('提交中断');
        const recovered = await store.recoverWal();
        expect(recovered.action).toBe('READY');
        expect(recovered.phase).toBe('STATE_COMMITTED');
        expect((await store.readTxState()).phase).toBe('STATE_COMMITTED');
    });

    it('能够读取并 Zod 校验 book_config.yaml 与 world/world_state.md', async () => {
        const { bookRoot, store } = await createTempBookRepo();
        const config = await store.readBookConfig();
        expect(config.book_slug).toBe('sample-book');
        expect(config.tokens_per_char).toBe(0.65);
        expect(config.writer_token_budget).toBeNull();
        expect(config.max_auto_rollback_chapters).toBe(3);

        const worldState = await store.readWorldState();
        expect(worldState.frontmatter.story_day).toBe(1);
        expect(worldState.frontmatter.pov_character).toBe('char_001');
        expect(worldState.frontmatter.timeline_mode).toBe('MAINLINE');
        expect(worldState.summaryMarkdown).toContain('乡土民俗研究同好会');

        await store.writeWorldState({
            frontmatter: {
                ...worldState.frontmatter,
                story_day: 2,
                current_chapter: 2,
                timeline_mode: 'PARALLEL'
            },
            summaryMarkdown: worldState.summaryMarkdown
        });
        const updated = await store.readWorldState();
        expect(updated.frontmatter.story_day).toBe(2);
        expect(updated.frontmatter.timeline_mode).toBe('PARALLEL');

        // 非法配置必须被 Zod 拦截
        await writeFile(join(bookRoot, 'world/book_config.yaml'), 'book_slug: ""\ntokens_per_char: -1\n', 'utf8');
        await expect(store.readBookConfig()).rejects.toThrow();
    });

    it('支持四段式实体档案解析、行级标签解析与无损往返序列化', async () => {
        const sample = [
            '---',
            'entity_id: char_002',
            'canonical_name: 神代雪乃',
            'unique_aliases: ["雪乃", "冰山副会长"]',
            'contextual_titles: ["副会长", "学姐"]',
            'historical_anchors: ["ch_0002:四楼锁窗女生"]',
            'last_seen_ch: 45',
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: SELF_ONLY] 极度怕黑，无光源密闭环境下无法独自行动 [锚点 ch_0008]',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
            '- [story_day: 12 | ch: 45 | visibility: READER_KNOWN | owner: char_002 | status: ACTIVE] 持有物：item_001（黄铜钥匙）',
            '- [Tracked Numeric Ledger] 社团剩余经费: 1200日元 | 备用钥匙数: 1',
            '',
            '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
            '- [day: -1095 | ch: 21] 曾在四楼音乐室门框悬挂风铃',
            '',
            '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
            '- [day: 12 | ch: 44] 发现铁柜锁舌新划痕',
            '- 对话声纹：句式工整克制',
            '  > 标本：「我只是按章办事。」',
            ''
        ].join('\n');

        const parsed = parseEntityMarkdown(sample);
        expect(parsed.metadata.entity_id).toBe('char_002');
        expect(parsed.metadata.canonical_name).toBe('神代雪乃');
        expect(parsed.metadata.last_seen_ch).toBe(45);
        expect(parsed.innateLocks).toHaveLength(1);
        expect(parsed.innateLocks[0]?.visibility).toBe('SELF_ONLY');

        expect(parsed.acquiredState).toHaveLength(2);
        const slotEntry = parsed.acquiredState[0];
        expect(slotEntry?.storyDay).toBe(12);
        expect(slotEntry?.chapter).toBe(45);
        expect(slotEntry?.visibility).toBe('READER_KNOWN');
        expect(slotEntry?.owner).toBe('char_002');
        expect(slotEntry?.status).toBe('ACTIVE');

        const ledgerEntry = parsed.acquiredState[1];
        expect(ledgerEntry?.isNumericLedger).toBe(true);
        expect(ledgerEntry?.ledger).toEqual({
            社团剩余经费: '1200日元',
            备用钥匙数: '1'
        });

        expect(parsed.recentBuffer[1]?.continuationLines).toEqual(['  > 标本：「我只是按章办事。」']);

        const serialized = serializeEntityMarkdown(parsed);
        const reparsed = parseEntityMarkdown(serialized);
        expect(reparsed).toEqual(parsed);
    });

    it('行级槽位增量补丁合并支持多字段/多行同时更新且零丢失', async () => {
        const { bookRoot, store } = await createTempBookRepo();

        await store.commitDraft(2, '第2章正文：陆沉拿到了新线索。\n');
        await store.applyStatePatch(2, [
            {
                entity_id: 'char_001',
                last_seen_ch: 2,
                add_unique_aliases: ['陆社长'],
                acquired_state_ops: [
                    {
                        op: 'upsert_slot',
                        slot_key: '驻留节点',
                        entry: {
                            storyDay: 2,
                            chapter: 2,
                            visibility: 'PUBLIC',
                            text: '驻留节点：旧校舍二楼档案室'
                        }
                    },
                    {
                        op: 'upsert_ledger',
                        entries: {
                            社团剩余经费: '900日元'
                        }
                    }
                ],
                trajectory_ops: [
                    {
                        op: 'append',
                        entry: {
                            storyDay: 2,
                            chapter: 2,
                            text: '查到十年前社团旧账本'
                        }
                    }
                ],
                buffer_ops: [
                    {
                        op: 'append',
                        entry: {
                            storyDay: 2,
                            chapter: 2,
                            text: '怀疑档案室门锁被人为撬过'
                        }
                    }
                ]
            }
        ]);

        const rawChar = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        const parsed = parseEntityMarkdown(rawChar);

        expect(parsed.metadata.last_seen_ch).toBe(2);
        expect(parsed.metadata.unique_aliases).toEqual(['小沉', '陆社长']);
        // 驻留节点被原地更新，但主观认知偏差与备用钥匙数必须零丢失保留
        expect(parsed.acquiredState.some((e) => e.text.includes('驻留节点：旧校舍二楼档案室'))).toBe(true);
        expect(parsed.acquiredState.some((e) => e.text.includes('旧校舍三楼社团活动室'))).toBe(false);
        expect(parsed.acquiredState.some((e) => e.text.includes('主观认知偏差：以为社团还能撑过月底评审'))).toBe(true);

        const ledger = parsed.acquiredState.find((e) => e.isNumericLedger);
        expect(ledger?.ledger).toEqual({
            社团剩余经费: '900日元',
            备用钥匙数: '1'
        });

        // 第 3 区保留原条目并追加新条目
        expect(parsed.irreversibleTrajectory).toHaveLength(2);
        // 第 4 区保留声纹标本并追加新缓冲
        expect(parsed.recentBuffer.some((e) => e.text.includes('对话声纹'))).toBe(true);
        expect(parsed.recentBuffer.some((e) => e.text.includes('怀疑档案室门锁被人为撬过'))).toBe(true);
    });

    it('拦截篡改 canonical_name 或 Innate Locks 的普通增量补丁，显式授权时放行', async () => {
        const { bookRoot, store } = await createTempBookRepo();
        await store.commitDraft(2, '第2章正文\n');

        await expect(
            store.applyStatePatch(2, [
                {
                    entity_id: 'char_001',
                    canonical_name: '陆沉改名'
                }
            ])
        ).rejects.toThrow(InnateLockViolationError);

        await expect(
            store.applyStatePatch(2, [
                {
                    entity_id: 'char_001',
                    innate_locks_ops: [
                        {
                            op: 'append',
                            entry: {
                                visibility: 'PUBLIC',
                                text: '企图注入先天红线'
                            }
                        }
                    ]
                }
            ])
        ).rejects.toThrow(InnateLockViolationError);

        // 确认文件未被部分污染
        const rawChar = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        expect(parseEntityMarkdown(rawChar).metadata.canonical_name).toBe('陆沉');

        // 显式授权维护标志时允许修改
        await store.applyStatePatch(
            2,
            [
                {
                    entity_id: 'char_001',
                    innate_locks_ops: [
                        {
                            op: 'append',
                            entry: {
                                visibility: 'PUBLIC',
                                text: '左肩新增永久旧伤疤'
                            }
                        }
                    ]
                }
            ],
            { allowInnateMutation: true }
        );
        const updatedRaw = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        expect(parseEntityMarkdown(updatedRaw).innateLocks).toHaveLength(3);
    });

    it('1ms 跨文件外键可达性校验：拦截不存在的 char_*/item_*/ch_* 引用，放行 cold_archive 引用', async () => {
        const { store } = await createTempBookRepo();
        await store.commitDraft(2, '第2章正文\n');

        // 不存在的角色外键
        await expect(
            store.applyStatePatch(2, [
                {
                    entity_id: 'item_001',
                    acquired_state_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                owner: 'char_404',
                                text: '移交给不存在角色 char_404'
                            }
                        }
                    ]
                }
            ])
        ).rejects.toThrow(ForeignKeyError);

        // 不存在的道具外键
        await expect(
            store.applyStatePatch(2, [
                {
                    entity_id: 'char_001',
                    acquired_state_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                text: '拾获 item_999'
                            }
                        }
                    ]
                }
            ])
        ).rejects.toThrow(ForeignKeyError);

        // 不存在的章节外键
        await expect(
            store.applyStatePatch(2, [
                {
                    entity_id: 'char_001',
                    add_historical_anchors: ['ch_0099:未来幻影']
                }
            ])
        ).rejects.toThrow(ForeignKeyError);

        // cold_archive 中的 char_099 应可达并放行
        await expect(
            store.applyStatePatch(2, [
                {
                    entity_id: 'item_001',
                    acquired_state_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                owner: 'char_099',
                                text: '追溯原持有者 char_099（已归档）于 ch_0001 移交'
                            }
                        }
                    ]
                }
            ])
        ).resolves.toBeDefined();
    });

    it('双粒度 WAL 状态机在 FEAT_COMMITTED 中断后可通过 recoverWal() 恢复并保持 Git 零脏文件', async () => {
        const { bookRoot, system, store } = await createTempBookRepo();

        await store.beginDraft(2);
        expect((await store.readTxState()).phase).toBe('DRAFTING');

        await store.commitDraft(2, '第2章定稿正文内容。\n');
        const walAfterFeat = await store.readTxState();
        expect(walAfterFeat.phase).toBe('FEAT_COMMITTED');
        expect(walAfterFeat.active_chapter).toBe(2);
        expect(walAfterFeat.chapter_hashes['ch_0002']).toHaveLength(64);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);

        // 模拟真实状态提交失败，写集先于实体文件持久化。
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('状态提交中断'));
        await expect(store.applyStatePatch(2, [{ entity_id: 'char_001', last_seen_ch: 2 }])).rejects.toThrow('状态提交中断');
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(false);

        // 重启执行 recoverWal()
        const recovery = await store.recoverWal();
        expect(recovery.action).toBe('NEEDS_STATE_EXTRACTION');
        expect(recovery.phase).toBe('FEAT_COMMITTED');
        expect(recovery.activeChapter).toBe(2);
        expect(recovery.clean).toBe(true);

        // Git 必须零脏文件，且 ch_0002.md 正文无损保留
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
        expect(await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8')).toBe('第2章定稿正文内容。\n');
        expect(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8')).toContain('canonical_name: 陆沉');

        // 补齐 state 提交
        await store.applyStatePatch(2, [{ entity_id: 'char_001', last_seen_ch: 2 }]);
        const walAfterState = await store.readTxState();
        expect(walAfterState.phase).toBe('STATE_COMMITTED');
        expect(walAfterState.last_committed_ch).toBe(2);

        const { stdout: logOut } = await execFileAsync('git', ['-C', bookRoot, 'log', '-n', '2', '--oneline'], {
            encoding: 'utf8'
        });
        expect(logOut).toContain('state(ch-0002)');
        expect(logOut).toContain('feat(ch-0002)');
    });

    it('detectDirtyChapters() 基于 SHA-256 精确检出人工手改章节', async () => {
        const { bookRoot, store } = await createTempBookRepo();

        expect(await store.detectDirtyChapters()).toEqual([]);

        // 人工编辑 ch_0001.md
        const ch1Path = join(bookRoot, 'manuscripts/ch_0001.md');
        const original = await readFile(ch1Path, 'utf8');
        await writeFile(ch1Path, `${original}\n（人工润色补充一行）\n`, 'utf8');

        const dirty = await store.detectDirtyChapters();
        expect(dirty).toHaveLength(1);
        expect(dirty[0]?.chapterKey).toBe('ch_0001');
        expect(dirty[0]?.chapterNumber).toBe(1);
        expect(dirty[0]?.reason).toBe('MODIFIED');
        expect(dirty[0]?.actualHash).not.toBe(dirty[0]?.recordedHash);
    });

    it('回归：DRAFTING 恢复后 Git 工作区必须完全干净 (clean === true) 且无残留草稿', async () => {
        const { bookRoot, system, store } = await createTempBookRepo();

        await store.beginDraft(2);
        expect((await store.readTxState()).phase).toBe('DRAFTING');
        await writeFile(join(bookRoot, 'manuscripts/ch_0002.md'), '未定稿半成品草稿\n', 'utf8');
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(false);

        const recovery = await store.recoverWal();
        expect(recovery.action).toBe('ROLLED_BACK_DRAFT');
        expect(recovery.phase).toBe('IDLE');
        expect(recovery.clean).toBe(true);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
        await expect(access(join(bookRoot, 'manuscripts/ch_0002.md'))).rejects.toThrow();
    });

    it('回归：0 字节过期锁文件不导致死锁，且同进程并发调用严格互斥', async () => {
        const { bookRoot, store } = await createTempBookRepo();

        // 0 字节过期锁应落入 mtime 超时清理逻辑
        const lockPath = join(bookRoot, '.ops/tx.lock');
        await writeFile(lockPath, '', 'utf8');
        const past = new Date(Date.now() - 60_000);
        await utimes(lockPath, past, past);
        await expect(store.withTxLock(async () => 'cleaned-zero-byte-lock')).resolves.toBe('cleaned-zero-byte-lock');

        // 同进程异步并发调用不可穿透互斥锁
        let releaseHolder!: () => void;
        const holderGate = new Promise<void>((resolveGate) => {
            releaseHolder = resolveGate;
        });

        const acquired = Promise.withResolvers<void>();
        const holder = store.withTxLock(async () => {
            acquired.resolve();
            await holderGate;
            return 'holder-done';
        });

        // 等到持锁回调确实进入，再从独立异步上下文验证竞争者被拒绝。
        await Promise.race([acquired.promise, holder]);
        try {
            await expect(store.beginDraft(2)).rejects.toThrow(TxLockConflictError);
        } finally {
            releaseHolder();
            await expect(holder).resolves.toBe('holder-done');
        }
    });

    it('FEAT 恢复保留未登记的实体、历史章手改和未跟踪笔记', async () => {
        const { bookRoot, system, store } = await createTempBookRepo();

        await store.commitDraft(2, '第2章定稿内容\n');
        // 未登记的文件不能假定为引擎崩溃残留。
        const untrackedEntityPath = join(bookRoot, 'entities/char_temp.md');
        await writeFile(untrackedEntityPath, 'UNTRACKED ENTITY DRAFT', 'utf8');
        const oldChapter = join(bookRoot, 'manuscripts/ch_0001.md');
        await writeFile(oldChapter, '作者修改的历史章', 'utf8');
        await writeFile(join(bookRoot, 'notes.md'), '作者笔记', 'utf8');
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(false);

        const recovery = await store.recoverWal();
        expect(recovery.action).toBe('NEEDS_STATE_EXTRACTION');
        expect(recovery.phase).toBe('FEAT_COMMITTED');
        expect(recovery.clean).toBe(false);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(false);
        expect(await readFile(untrackedEntityPath, 'utf8')).toBe('UNTRACKED ENTITY DRAFT');
        expect(await readFile(oldChapter, 'utf8')).toBe('作者修改的历史章');
        expect(await readFile(join(bookRoot, 'notes.md'), 'utf8')).toBe('作者笔记');
    });

    it('回归：拦截非法 entity_id 与路径穿越，并校验 WAL 非法前置相位', async () => {
        const { store } = await createTempBookRepo();

        // IDLE 相位下禁止直接 applyStatePatch
        await expect(store.applyStatePatch(2, [{ entity_id: 'char_001', last_seen_ch: 2 }])).rejects.toThrow(
            '非法 WAL 状态迁移'
        );

        await store.beginDraft(2);
        // DRAFTING 相位下禁止重复 beginDraft
        await expect(store.beginDraft(3)).rejects.toThrow('非法 WAL 状态迁移');

        await store.commitDraft(2, '第2章正文\n');
        // FEAT_COMMITTED 相位下禁止重复 commitDraft
        await expect(store.commitDraft(3, '第3章正文\n')).rejects.toThrow('非法 WAL 状态迁移');

        // 拦截路径穿越与非法 entity_id
        await expect(
            store.applyStatePatch(2, [{ entity_id: '../outside', canonical_name: '恶意实体' }])
        ).rejects.toThrow('非法的 entity_id 格式');
        await expect(
            store.applyStatePatch(2, [{ entity_id: 'bad_prefix_001', canonical_name: '非法前缀' }])
        ).rejects.toThrow('非法的 entity_id 格式');
    });

    it('回归：支持带下划线的 cold_archive 分片命名 char_lin_daiyu_saga_01 外键可达，且兼容 UTF-8 BOM + CRLF', async () => {
        const { bookRoot, store } = await createTempBookRepo();

        const sagaContent = [
            '\uFEFF---',
            'entity_id: char_lin_daiyu',
            'canonical_name: 林黛玉',
            'unique_aliases: []',
            'contextual_titles: []',
            'historical_anchors: []',
            'last_seen_ch: 1',
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: PUBLIC] 潇湘馆旧主',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
            '',
            '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
            '',
            '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
            ''
        ].join('\r\n');

        expect(parseEntityMarkdown(sagaContent).metadata.entity_id).toBe('char_lin_daiyu');

        await writeFile(join(bookRoot, 'entities/cold_archive/char_lin_daiyu_saga_01.md'), sagaContent, 'utf8');
        await store.commitDraft(2, '第2章正文\n');

        await expect(
            store.applyStatePatch(2, [
                {
                    entity_id: 'item_001',
                    acquired_state_ops: [
                        {
                            op: 'append',
                            entry: {
                                storyDay: 2,
                                chapter: 2,
                                owner: 'char_lin_daiyu',
                                text: '原属 char_lin_daiyu 的旧物'
                            }
                        }
                    ]
                }
            ])
        ).resolves.toBeDefined();
    });
});

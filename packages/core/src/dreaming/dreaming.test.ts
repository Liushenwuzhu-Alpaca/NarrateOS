import { access, cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSystemAdapter, ScriptedLlmAdapter } from '../ports/index.js';
import { BookStore, parseEntityMarkdown } from '../store/index.js';
import { DreamingRunner, type SuspectedConflict } from './index.js';

const execFileAsync = promisify(execFile);
const FIXTURE_BOOK_DIR = resolve(import.meta.dirname, '../../../../fixtures/sample-book');

const tempDirs: string[] = [];

async function createDreamingTestRepo(): Promise<{
    bookRoot: string;
    system: NodeSystemAdapter;
    store: BookStore;
}> {
    const bookRoot = await mkdtemp(join(tmpdir(), 'narrateos-dreaming-test-'));
    tempDirs.push(bookRoot);
    await cp(FIXTURE_BOOK_DIR, bookRoot, { recursive: true });
    await mkdir(join(bookRoot, 'entities/cold_archive'), { recursive: true });
    await mkdir(join(bookRoot, '.ops'), { recursive: true });

    // 脏实体：第 4 区缓冲攒满 4 条
    const dirtyChar = [
        '---',
        'entity_id: char_001',
        'canonical_name: 陆沉',
        'unique_aliases: ["小沉"]',
        'contextual_titles: ["社长"]',
        'historical_anchors: ["ch_0001:旧校舍钥匙持有者"]',
        'last_seen_ch: 4',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: SELF_ONLY] 左手腕对低温金属过敏',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:4 | ch:04 | vis: PUBLIC] 驻留节点：旧校舍档案室',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 收到废部预警单',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:2 | ch:02] 在资料柜夹层发现十年前的社团印章',
        '- [day:3 | ch:03] 与星野琉璃约定分头核查旧校舍水电账单',
        '- [day:3 | ch:03] 确认地下室铁门锁芯被人为替换过',
        '- [day:4 | ch:04] 拿到旧任部长的匿名留言条',
        '- 对话声纹：短句为主，带轻微冷幽默',
        '  > 标本：「废部通知书的纸质不错，拿来折纸飞机刚好。」',
        ''
    ].join('\n');

    // 未出场干净实体：测试期间必须零读取、零修改，mtime 完全不变
    const cleanChar = [
        '---',
        'entity_id: char_002',
        'canonical_name: 神代雪乃',
        'unique_aliases: []',
        'contextual_titles: ["副会长"]',
        'historical_anchors: []',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 学生会副会长',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 签署社团审查延长通知',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 站在走廊尽头旁听',
        ''
    ].join('\n');

    // 长期退场角色：测试冷归档
    const retiredChar = [
        '---',
        'entity_id: char_003',
        'canonical_name: 佐藤前辈',
        'unique_aliases: []',
        'contextual_titles: []',
        'historical_anchors: []',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 已转学离开本市',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 正式办理转学手续离场',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        ''
    ].join('\n');

    const futureHorizon = [
        '# Future Horizon (远景计划与埋线节点)',
        '',
        '- [day:6 | status: ACTIVE | id: hz_001] 趁夜潜入旧校舍配电室窃取备份钥匙',
        '- [day:1 | status: WARPED | id: hz_002] 计划在学生会例会上直接提交废部复议申请',
        '- [day:9 | status: ACTIVE | id: hz_003] 校外神秘赞助人将在文化祭前夜现身摊牌',
        ''
    ].join('\n');

    await writeFile(join(bookRoot, 'entities/char_001.md'), dirtyChar, 'utf8');
    await writeFile(join(bookRoot, 'entities/char_002.md'), cleanChar, 'utf8');
    await writeFile(join(bookRoot, 'entities/char_003.md'), retiredChar, 'utf8');
    await writeFile(join(bookRoot, 'world/future_horizon.md'), futureHorizon, 'utf8');

    const system = new NodeSystemAdapter();
    await system.initRepo(bookRoot);
    const store = new BookStore(bookRoot, system);
    await store.initializeWalFromDisk();
    await system.commitPaths(bookRoot, ['.'], 'chore: init dreaming test fixture');

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

describe('DreamingRunner', () => {
    it.each(['DRAFTING', 'FEAT_COMMITTED'] as const)('强制 Dreaming 不覆盖 %s 待恢复章节', async (phase) => {
        const { bookRoot, store, system } = await createDreamingTestRepo();
        await store.beginDraft(2);
        if (phase === 'FEAT_COMMITTED') await store.commitDraft(2, '等待抽取的正文');
        const before = await store.readTxState();
        const entityPath = join(bookRoot, 'entities/char_001.md');
        const original = await readFile(entityPath, 'utf8');
        const runner = new DreamingRunner(store, new ScriptedLlmAdapter([]), system);
        await expect(runner.runDreaming({
            currentChapter: 2,
            activeEntityIds: ['char_001'],
            force: true
        })).rejects.toThrow('需要先完成章节恢复');
        await expect(store.markDreamCommitted(2)).rejects.toThrow('非法 WAL 状态迁移');
        expect(await store.readTxState()).toEqual(before);
        expect(await readFile(entityPath, 'utf8')).toBe(original);
    });

    it('按脏页增量 VACUUM：压缩脏缓冲入第 3 区并保留原章锚点，未出场干净实体 mtime 完全不变，并提交 DREAM_COMMITTED', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        // 将干净实体 mtime 设为固定过去时间以便精确比对
        const cleanPath = join(bookRoot, 'entities/char_002.md');
        const fixedPast = new Date('2025-01-01T00:00:00.000Z');
        await utimes(cleanPath, fixedPast, fixedPast);
        const beforeCleanStat = await stat(cleanPath);

        const llm = new ScriptedLlmAdapter([
            {
                text: JSON.stringify({
                    trajectory_entries: [
                        {
                            story_day: 2,
                            chapter: 2,
                            anchor: 'ch_0002',
                            summary: '在资料柜夹层找回十年前的社团印章'
                        },
                        {
                            story_day: 4,
                            chapter: 4,
                            anchor: 'ch_0004',
                            summary: '拿到旧任部长的匿名留言条并确认锁芯被替换'
                        }
                    ],
                    keep_buffer_texts: []
                }),
                usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 50 }
            },
            {
                text: JSON.stringify({
                    warped_markers: [],
                    spotlight_triggers: []
                }),
                usage: { inputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 }
            }
        ]);

        const runner = new DreamingRunner(store, llm, system);
        const result = await runner.runDreaming({
            currentChapter: 4,
            currentStoryDay: 4,
            recentWordDelta: 3500,
            dreamWordThreshold: 2000,
            dreamBufferLimit: 4,
            activeEntityIds: ['char_001'],
            retryOptions: { sleepFn: async () => {} }
        });

        expect(result.skipped).toBe(false);
        expect(result.vacuumedEntities).toEqual(['char_001']);
        expect(result.committedTxState?.phase).toBe('DREAM_COMMITTED');

        // 验证未出场干净实体 mtime 完全不变
        const afterCleanStat = await stat(cleanPath);
        expect(afterCleanStat.mtimeMs).toBe(beforeCleanStat.mtimeMs);

        // 验证脏实体第 3 区获得提炼且保留原章锚点，第 4 区清理缓冲但保留声纹标本
        const updatedDirty = parseEntityMarkdown(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8'));
        expect(
            updatedDirty.irreversibleTrajectory.some(
                (e) => e.chapter === 2 && e.text.includes('ch_0002') && e.text.includes('社团印章')
            )
        ).toBe(true);
        expect(
            updatedDirty.irreversibleTrajectory.some(
                (e) => e.chapter === 4 && e.text.includes('ch_0004') && e.text.includes('匿名留言条')
            )
        ).toBe(true);
        expect(updatedDirty.recentBuffer.some((e) => e.text.includes('对话声纹'))).toBe(true);
        expect(updatedDirty.recentBuffer.some((e) => e.text.includes('发现十年前的社团印章'))).toBe(false);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('翻转破灭节点为 WARPED，将过期 WARPED 死元组及长期退场角色移入 entities/cold_archive/，并写入 Spotlight Trigger 信号', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        const llm = new ScriptedLlmAdapter([
            {
                text: JSON.stringify({
                    trajectory_entries: [
                        {
                            story_day: 4,
                            chapter: 4,
                            anchor: 'ch_0004',
                            summary: '整理旧校舍档案室线索'
                        }
                    ],
                    keep_buffer_texts: []
                }),
                usage: { inputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 }
            },
            {
                text: JSON.stringify({
                    warped_markers: ['hz_001'],
                    spotlight_triggers: [
                        {
                            entity_id: 'char_002',
                            reason: '神代雪乃已锁定旧校舍违规经费证据，即将引爆废部听证会正面冲突',
                            suggested_mode: 'PARALLEL'
                        }
                    ]
                }),
                usage: { inputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 45 }
            }
        ]);

        const runner = new DreamingRunner(store, llm, system);
        const result = await runner.runDreaming({
            currentChapter: 10,
            currentStoryDay: 8,
            recentWordDelta: 4000,
            dreamWordThreshold: 2000,
            dreamBufferLimit: 4,
            activeEntityIds: ['char_001'],
            coldArchiveCandidateIds: ['char_003'],
            coldArchiveInactiveChapters: 5,
            warpedExpireDays: 3,
            offscreenCharacters: [
                {
                    entityId: 'char_002',
                    pendingGoal: '调查社团经费去向',
                    progressNote: '已完成账目比对，抵达听证会发难临界点'
                }
            ],
            retryOptions: { sleepFn: async () => {} }
        });

        expect(result.warpedNodesFlipped).toBeGreaterThanOrEqual(1);
        expect(result.archivedFiles.some((p) => p.includes('entities/cold_archive/'))).toBe(true);
        expect(result.spotlightTriggers).toHaveLength(1);
        expect(result.spotlightTriggers[0]?.type).toBe('SPOTLIGHT_TRIGGER');
        expect(result.spotlightTriggers[0]?.entity_id).toBe('char_002');

        // 检查 future_horizon.md 中 hz_001 已翻转为 WARPED，过期的 hz_002 已被移出
        const horizonRaw = await readFile(join(bookRoot, 'world/future_horizon.md'), 'utf8');
        expect(horizonRaw).toContain('hz_001');
        expect(horizonRaw).toContain('WARPED');
        expect(horizonRaw).not.toContain('hz_002');

        // 检查 cold_archive 下存在归档的死元组文件与退场角色 char_003.md
        await expect(access(join(bookRoot, 'entities/cold_archive/char_003.md'))).resolves.toBeUndefined();
        await expect(access(join(bookRoot, 'entities/char_003.md'))).rejects.toThrow();
        const archivedWarped = await readFile(join(bookRoot, 'entities/cold_archive/warped_horizon.md'), 'utf8');
        expect(archivedWarped).toContain('hz_002');

        // 检查 .ops/signals.jsonl 包含 SPOTLIGHT_TRIGGER
        const signalsRaw = await readFile(join(bookRoot, '.ops/signals.jsonl'), 'utf8');
        const signals = signalsRaw
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(signals.some((s) => s.type === 'SPOTLIGHT_TRIGGER' && s.entity_id === 'char_002')).toBe(true);
    });

    it('双侧原句去标点验真：丢弃捏造引文误报与已合法转移误报', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        await store.commitDraft(
            1,
            '第一行：风声掠过屋檐。\n陆沉把黄铜钥匙放进了左胸口袋。\n窗外树影摇曳。\n'
        );
        await store.applyStatePatch(1, [{ entity_id: 'char_001', last_seen_ch: 1 }]);
        await store.commitDraft(
            2,
            '第二章开篇。\n此时星野琉璃从包里掏出那把黄铜钥匙。\n两人推开了档案室的门。\n'
        );
        await store.applyStatePatch(2, [{ entity_id: 'char_001', last_seen_ch: 2 }]);

        const llm = new ScriptedLlmAdapter([]);
        const runner = new DreamingRunner(store, llm, system);

        const conflicts: SuspectedConflict[] = [
            {
                conflictId: 'c_fake_quote',
                chapterA: 1,
                quoteA: '陆沉把银色匕首扔进了河里', // 原文不存在
                chapterB: 2,
                quoteB: '此时星野琉璃从包里掏出那把黄铜钥匙',
                description: '幻觉引文'
            },
            {
                conflictId: 'c_legit_transfer',
                chapterA: 1,
                quoteA: '陆沉把黄铜钥匙放进了左胸口袋',
                chapterB: 2,
                quoteB: '此时星野琉璃从包里掏出那把黄铜钥匙',
                description: '中间章已合法移交钥匙',
                hasLegitimateTransfer: true
            }
        ];

        const healResult = await runner.healCrossChapterConflicts(conflicts, {
            retryOptions: { sleepFn: async () => {} }
        });

        // 未消耗任何 LLM 调用
        expect(llm.history).toHaveLength(0);
        expect(healResult.quarantined).toBe(false);
        expect(healResult.results).toEqual([
            { conflictId: 'c_fake_quote', action: 'DISCARDED_HALLUCINATION' },
            { conflictId: 'c_legit_transfer', action: 'DISCARDED_LEGITIMATE_TRANSFER' }
        ]);
        await expect(access(join(bookRoot, '.ops/signals.jsonl'))).rejects.toThrow();
    });

    it('三级自愈 - 1 级软微瑕投递 RETCON 信号；2 级单点硬穿帮执行局部 Patch 并刷新视图', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        await store.commitDraft(
            1,
            '傍晚时分，暴雨倾盆而下，走廊地面湿漉漉的。\n陆沉收好雨伞。\n'
        );
        await store.applyStatePatch(1, [{ entity_id: 'char_001', last_seen_ch: 1 }]);
        await store.commitDraft(
            2,
            '十分钟后，烈日当空，操场晒得发烫。\n此时死去的旧任部长突然推门走进活动室。\n陆沉抬头看去。\n'
        );
        await store.applyStatePatch(2, [{ entity_id: 'char_001', last_seen_ch: 2 }]);

        const llm = new ScriptedLlmAdapter([
            // 第 1 个冲突：软微瑕
            {
                text: JSON.stringify({
                    severity: 'SOFT_MINOR',
                    reason: '天气微差属于软微瑕，下章顺嘴圆回即可',
                    downstream_dependent: false
                }),
                usage: { inputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 25 }
            },
            // 第 2 个冲突：单点硬穿帮，给出局部 Patch 文本
            {
                text: JSON.stringify({
                    severity: 'SINGLE_POINT_HARD',
                    reason: '已退场角色凭空现身且下游未依赖该事实，可局部修正',
                    downstream_dependent: false,
                    patched_segment: '此时门外传来脚步声，值班老师推门走进活动室。'
                }),
                usage: { inputTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 35 }
            }
        ]);

        const runner = new DreamingRunner(store, llm, system);
        const healResult = await runner.healCrossChapterConflicts(
            [
                {
                    conflictId: 'c_weather',
                    chapterA: 1,
                    quoteA: '暴雨倾盆而下，走廊地面湿漉漉的',
                    chapterB: 2,
                    quoteB: '十分钟后，烈日当空，操场晒得发烫',
                    description: '短时间内天气突变'
                },
                {
                    conflictId: 'c_single_hard',
                    chapterA: 1,
                    quoteA: '陆沉收好雨伞',
                    chapterB: 2,
                    quoteB: '此时死去的旧任部长突然推门走进活动室',
                    description: '已退场人物死而复生'
                }
            ],
            {
                retryOptions: { sleepFn: async () => {} }
            }
        );

        expect(healResult.quarantined).toBe(false);
        expect(healResult.results.map((r) => r.action)).toEqual(['RETCON_SIGNAL', 'PATCHED_IN_PLACE']);

        // 验证 RETCON 信号落盘
        const signalsRaw = await readFile(join(bookRoot, '.ops/signals.jsonl'), 'utf8');
        expect(signalsRaw).toContain('RETCON');
        expect(signalsRaw).toContain('c_weather');

        // 验证第 2 章正文已被局部 Patch 且视图指纹已刷新（无脏章）
        const ch2After = await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8');
        expect(ch2After).toContain('此时门外传来脚步声，值班老师推门走进活动室。');
        expect(ch2After).not.toContain('死去的旧任部长');
        expect(await store.detectDirtyChapters()).toEqual([]);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('三级自愈 - 3 级连带硬穿帮：阈值内创建 backup tag + reset 回滚并自动重跑；重跑死锁或超阈值触发 QUARANTINED 熔断', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        await store.commitDraft(1, '第一章：黄铜钥匙锁在抽屉里。\n');
        await store.applyStatePatch(1, [{ entity_id: 'char_001', last_seen_ch: 1 }]);
        await store.commitDraft(2, '第二章：黄铜钥匙在暴雨中被熔毁成铁水。\n');
        await store.applyStatePatch(2, [{ entity_id: 'char_001', last_seen_ch: 2 }]);
        await store.commitDraft(3, '第三章：陆沉用那把完好无损的黄铜钥匙打开了阁楼门。\n');
        await store.applyStatePatch(3, [{ entity_id: 'char_001', last_seen_ch: 3 }]);
        await store.commitDraft(4, '第四章：众人在阁楼里继续搜寻旧账本。\n');
        await store.applyStatePatch(4, [{ entity_id: 'char_001', last_seen_ch: 4 }]);

        // 场景 A：波及 2 章 (ch3, ch4) <= max_auto_rollback_chapters (3)，自动打备份 tag、reset 回第 2 章并重跑成功
        const llmAuto = new ScriptedLlmAdapter([
            {
                text: JSON.stringify({
                    severity: 'CASCADING_HARD',
                    reason: '钥匙已在第2章熔毁，第3、4章建立在钥匙完好打开阁楼的基础上',
                    downstream_dependent: true
                }),
                usage: { inputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 }
            }
        ]);

        const runnerAuto = new DreamingRunner(store, llmAuto, system);
        let rerunCalled = false;
        const autoRes = await runnerAuto.healCrossChapterConflicts(
            [
                {
                    conflictId: 'c_cascade_ok',
                    chapterA: 2,
                    quoteA: '黄铜钥匙在暴雨中被熔毁成铁水',
                    chapterB: 3,
                    quoteB: '陆沉用那把完好无损的黄铜钥匙打开了阁楼门',
                    description: '唯一物已销毁却被后续章节继续使用',
                    downstreamDependentChapters: [3, 4]
                }
            ],
            {
                maxAutoRollbackChapters: 3,
                onAutoRerun: async (ctx) => {
                    rerunCalled = true;
                    expect(ctx.rollbackToChapter).toBe(2);
                    expect(ctx.backupTag).toContain('backup/');
                    return { success: true };
                },
                retryOptions: { sleepFn: async () => {} }
            }
        );

        expect(rerunCalled).toBe(true);
        expect(autoRes.quarantined).toBe(false);
        expect(autoRes.results[0]?.action).toBe('AUTO_ROLLED_BACK_AND_RERUN');
        const backupTag = autoRes.results[0]?.backupTag;
        expect(backupTag).toBeTruthy();

        const { stdout: tagOut } = await execFileAsync('git', ['-C', bookRoot, 'tag', '--list', backupTag!], {
            encoding: 'utf8'
        });
        expect(tagOut.trim()).toBe(backupTag);

        // 回滚后 ch_0003.md 应已被重置移除
        await expect(access(join(bookRoot, 'manuscripts/ch_0003.md'))).rejects.toThrow();

        // 场景 B：重新提交第 3、4、5 章，测试超阈值 (3 > 2) 触发 QUARANTINED 熔断与确定性报告
        await store.commitDraft(3, '第三章重写：陆沉用备用铁丝撬开了阁楼门。\n');
        await store.applyStatePatch(3, [{ entity_id: 'char_001', last_seen_ch: 3 }]);
        await store.commitDraft(4, '第四章：阁楼内发现新线索。\n');
        await store.applyStatePatch(4, [{ entity_id: 'char_001', last_seen_ch: 4 }]);
        await store.commitDraft(5, '第五章：两人依据新线索下楼核对。\n');
        await store.applyStatePatch(5, [{ entity_id: 'char_001', last_seen_ch: 5 }]);

        const llmHalt = new ScriptedLlmAdapter([
            {
                text: JSON.stringify({
                    severity: 'CASCADING_HARD',
                    reason: '波及第3、4、5章共3章，超出上限2',
                    downstream_dependent: true
                }),
                usage: { inputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 30 }
            }
        ]);

        const runnerHalt = new DreamingRunner(store, llmHalt, system);
        const haltRes = await runnerHalt.healCrossChapterConflicts(
            [
                {
                    conflictId: 'c_cascade_halt',
                    chapterA: 2,
                    quoteA: '黄铜钥匙在暴雨中被熔毁成铁水',
                    chapterB: 3,
                    quoteB: '陆沉用备用铁丝撬开了阁楼门',
                    description: '假设存在连带设定冲突测试熔断',
                    downstreamDependentChapters: [3, 4, 5]
                }
            ],
            {
                maxAutoRollbackChapters: 2,
                retryOptions: { sleepFn: async () => {} }
            }
        );

        expect(haltRes.quarantined).toBe(true);
        expect(haltRes.results[0]?.action).toBe('QUARANTINED');
        expect(haltRes.quarantineReport?.status).toBe('QUARANTINED');
        expect(haltRes.quarantineReport?.side_a_line).toBe(1);
        expect(haltRes.quarantineReport?.side_b_line).toBe(1);
        expect(haltRes.quarantineReport?.rollback_chapters).toBe(3);
        expect(haltRes.quarantineReport?.rollback_words).toBeGreaterThan(0);

        const reportRaw = await readFile(join(bookRoot, '.ops/quarantine_report.json'), 'utf8');
        const reportJson = JSON.parse(reportRaw);
        expect(reportJson.status).toBe('QUARANTINED');
        expect(reportJson.conflict_id).toBe('c_cascade_halt');
        expect(reportJson.rollback_chapters).toBe(3);
    });

    it('边界条件：水位未达标时跳过；maxAutoRollbackChapters === 0 或重跑 1 次死锁均触发 QUARANTINED 熔断', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        // 1. 水位未达标直接跳过，零 LLM 调用
        const idleLlm = new ScriptedLlmAdapter([]);
        const runner = new DreamingRunner(store, idleLlm, system);
        const skippedRes = await runner.runDreaming({
            currentChapter: 2,
            recentWordDelta: 500,
            dreamWordThreshold: 2000,
            dreamBufferLimit: 10,
            activeEntityIds: ['char_001']
        });
        expect(skippedRes.skipped).toBe(true);
        expect(idleLlm.history).toHaveLength(0);

        // 2. 准备冲突章节，测试 maxAutoRollbackChapters === 0 直接熔断
        await store.commitDraft(1, '第一章：黑猫在客厅睡觉。\n');
        await store.applyStatePatch(1, [{ entity_id: 'char_001', last_seen_ch: 1 }]);
        await store.commitDraft(2, '第二章：黑猫突然飞上了外太空。\n');
        await store.applyStatePatch(2, [{ entity_id: 'char_001', last_seen_ch: 2 }]);

        const zeroRes = await runner.healCrossChapterConflicts(
            [
                {
                    conflictId: 'c_zero_limit',
                    chapterA: 1,
                    quoteA: '黑猫在客厅睡觉',
                    chapterB: 2,
                    quoteB: '黑猫突然飞上了外太空',
                    description: '设定违背物理常识',
                    severityHint: 'CASCADING_HARD',
                    downstreamDependentChapters: [2]
                }
            ],
            {
                maxAutoRollbackChapters: 0,
                retryOptions: { sleepFn: async () => {} }
            }
        );
        expect(zeroRes.quarantined).toBe(true);
        expect(zeroRes.results[0]?.action).toBe('QUARANTINED');

        // 3. 测试重跑 1 次仍死锁时触发 QUARANTINED 熔断
        const deadlockRes = await runner.healCrossChapterConflicts(
            [
                {
                    conflictId: 'c_deadlock',
                    chapterA: 1,
                    quoteA: '黑猫在客厅睡觉',
                    chapterB: 2,
                    quoteB: '黑猫突然飞上了外太空',
                    description: '自动重跑仍无法消除冲突',
                    severityHint: 'CASCADING_HARD',
                    downstreamDependentChapters: [2]
                }
            ],
            {
                maxAutoRollbackChapters: 3,
                onAutoRerun: async () => ({ success: false, stillConflicting: true }),
                retryOptions: { sleepFn: async () => {} }
            }
        );
        expect(deadlockRes.quarantined).toBe(true);
        expect(deadlockRes.quarantineReport?.reason).toContain('死锁');
        const report = JSON.parse(await readFile(join(bookRoot, '.ops/quarantine_report.json'), 'utf8'));
        expect(report.conflict_id).toBe('c_deadlock');
    });

    it('伏笔周期盘点与补货：将 resolved_thread_ids 归档至 Resolved Archive，追加 new_threads 并写入 replenished_horizon_events', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        const openThreadsSeed = [
            '# 跨卷伏笔台账 (Open Threads)',
            '',
            '## 活跃未解伏笔 (Active Threads)',
            '- [th_001] 地下室铁门被替换的新锁芯 | 唤醒条件: 陆沉拿到旧校舍配电室备用钥匙',
            '- [th_002] 十年前社团印章上的缺角 | 唤醒条件: 查阅十年前文化祭档案',
            '- [th_003] 旧任部长的匿名留言条 | 唤醒条件: 对比学生会干事笔迹',
            '',
            '## 已回收伏笔归档 (Resolved Archive)',
            '- [th_000] 废部预警单的签发人 | 唤醒条件: 核对学生会盖章记录 [status: RESOLVED]',
            ''
        ].join('\n');
        await writeFile(join(bookRoot, 'world/open_threads.md'), openThreadsSeed, 'utf8');
        await system.commitPaths(bookRoot, ['world/open_threads.md'], 'chore: seed open_threads');

        const llm = new ScriptedLlmAdapter([
            {
                text: JSON.stringify({
                    warped_markers: [],
                    spotlight_triggers: [],
                    resolved_thread_ids: ['th_001'],
                    new_threads: [
                        {
                            thread_id: 'th_004',
                            title: '配电室电表箱内的加密航海图残片',
                            wakeup_condition: '破译残片背面的摩尔斯电码'
                        }
                    ],
                    replenished_horizon_events: [
                        {
                            event_id: 'hz_004',
                            description: '神代雪乃将带着学生会审计组突击查封旧校舍地下室',
                            premise: '陆沉未能在听证会前销毁违规电表记录',
                            after_ch: 12,
                            story_day: 10
                        }
                    ]
                }),
                usage: { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 80 }
            }
        ]);

        const runner = new DreamingRunner(store, llm, system);
        const result = await runner.runDreaming({
            currentChapter: 6,
            currentStoryDay: 6,
            force: true,
            offscreenCharacters: [
                {
                    entityId: 'char_002',
                    pendingGoal: '申请查封旧校舍地下室',
                    progressNote: '已起草审计通知书'
                }
            ],
            retryOptions: { sleepFn: async () => {} }
        });

        expect(result.skipped).toBe(false);
        expect(result.resolvedThreads).toEqual(['th_001']);
        expect(result.addedThreads).toEqual(['th_004']);
        expect(result.rejectedThreadsCount).toBe(0);
        expect(result.committedTxState?.phase).toBe('DREAM_COMMITTED');
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);

        const threadsAfter = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
        const [activeSection = '', archiveSection = ''] = threadsAfter.split('## 已回收伏笔归档 (Resolved Archive)');

        expect(activeSection).not.toContain('th_001');
        expect(activeSection).toContain('th_002');
        expect(activeSection).toContain('th_003');
        expect(activeSection).toContain('th_004');

        expect(archiveSection).toContain('th_000');
        expect(archiveSection).toContain('th_001');

        const horizonAfter = await readFile(join(bookRoot, 'world/future_horizon.md'), 'utf8');
        expect(horizonAfter).toContain('hz_004');
        expect(horizonAfter).toContain('after_ch:12');
        expect(horizonAfter).toContain('day:10');
        expect(horizonAfter).toContain('Premise: 陆沉未能在听证会前销毁违规电表记录');
    });

    it('伏笔配额硬锁：ACTIVE 伏笔上限 15 条，超额 new_threads 被代码硬拦截并计入 rejectedThreadsCount', async () => {
        const { bookRoot, system, store } = await createDreamingTestRepo();

        const fourteenThreads = Array.from({ length: 14 }, (_, idx) => {
            const num = String(idx + 1).padStart(3, '0');
            return `- [th_${num}] 伏笔标题_${num} | 唤醒条件: 条件_${num}`;
        });
        const openThreadsSeed = [
            '# 跨卷伏笔台账 (Open Threads)',
            '',
            '## 活跃未解伏笔 (Active Threads)',
            ...fourteenThreads,
            '',
            '## 已回收伏笔归档 (Resolved Archive)',
            ''
        ].join('\n');
        await writeFile(join(bookRoot, 'world/open_threads.md'), openThreadsSeed, 'utf8');
        await system.commitPaths(bookRoot, ['world/open_threads.md'], 'chore: seed 14 active threads');

        const llm = new ScriptedLlmAdapter([
            {
                text: JSON.stringify({
                    warped_markers: [],
                    spotlight_triggers: [],
                    resolved_thread_ids: [],
                    new_threads: [
                        {
                            thread_id: 'th_015',
                            title: '第 15 条允许入库的伏笔',
                            wakeup_condition: '条件_015'
                        },
                        {
                            thread_id: 'th_016',
                            title: '第 16 条超额应被硬拦截的伏笔',
                            wakeup_condition: '条件_016'
                        }
                    ],
                    replenished_horizon_events: []
                }),
                usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 60 }
            },
            {
                text: JSON.stringify({
                    warped_markers: [],
                    spotlight_triggers: [],
                    resolved_thread_ids: [],
                    new_threads: [
                        {
                            thread_id: 'th_017',
                            title: '满额后新增应全数拦截的伏笔',
                            wakeup_condition: '条件_017'
                        }
                    ],
                    replenished_horizon_events: []
                }),
                usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }
            }
        ]);

        const runner = new DreamingRunner(store, llm, system);
        const firstRes = await runner.runDreaming({
            currentChapter: 7,
            currentStoryDay: 7,
            force: true,
            retryOptions: { sleepFn: async () => {} }
        });

        expect(firstRes.addedThreads).toEqual(['th_015']);
        expect(firstRes.rejectedThreadsCount).toBe(1);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);

        const threadsAfterFirst = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
        const [activeAfterFirst = ''] = threadsAfterFirst.split('## 已回收伏笔归档 (Resolved Archive)');
        const activeCountFirst = activeAfterFirst
            .split(/\r?\n/)
            .filter((line) => line.trim().startsWith('- ')).length;
        expect(activeCountFirst).toBe(15);
        expect(activeAfterFirst).toContain('th_015');
        expect(activeAfterFirst).not.toContain('th_016');

        // 达到 15 条上限后再次尝试新增，应全部拦截
        const secondRes = await runner.runDreaming({
            currentChapter: 8,
            currentStoryDay: 8,
            force: true,
            retryOptions: { sleepFn: async () => {} }
        });

        expect(secondRes.addedThreads).toEqual([]);
        expect(secondRes.rejectedThreadsCount).toBe(1);
        const threadsAfterSecond = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
        expect(threadsAfterSecond).not.toContain('th_017');
    });
});

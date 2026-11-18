import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import {
    BookStore,
    DEFAULT_SECTION_HEADINGS,
    ForeignKeyError,
    InnateLockViolationError,
    NodeSystemAdapter,
    type EntityProfile
} from '@narrateos/dsh-book-store';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GateValidationError } from '../errors.js';
import * as bookToolsPlugin from '../index.js';

const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void> | void> = [];

function registerCleanup(fn: () => Promise<void> | void): void {
    cleanupCallbacks.push(fn);
}

function createSpyExec(name: string, args: unknown): {
    exec: ToolRunContext;
    concludedCount: () => number;
} {
    let concluded = 0;
    const exec: ToolRunContext = {
        token: Symbol('exec') as ToolRunContext['token'],
        callId: 'call-1' as ToolRunContext['callId'],
        rootCallId: 'call-1' as ToolRunContext['rootCallId'],
        name,
        arguments: args,
        signal: new AbortController().signal,
        deferContext() {},
        concludeTurn() {
            concluded += 1;
        }
    };
    return { exec, concludedCount: () => concluded };
}

async function createInitializedGitBook(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'narrateos-yield-test-'));
    tempDirs.push(dir);

    for (const sub of ['world', 'lore_library', 'index/L2_cards', 'entities', 'entities/cold_archive', 'manuscripts', '.ops']) {
        await mkdir(join(dir, sub), { recursive: true });
    }

    await writeFile(
        join(dir, 'world/book_config.yaml'),
        'book_slug: yield-book\ntitle: 门禁测试作品\ntokens_per_char: 0.6\n',
        'utf8'
    );
    await writeFile(
        join(dir, 'world/world_state.md'),
        '---\nstory_day: 1\ncurrent_volume: 1\ncurrent_chapter: 1\npov_character: char_001\ntimeline_mode: MAINLINE\n---\n\n开局稳定。\n',
        'utf8'
    );
    await writeFile(
        join(dir, 'world/open_threads.md'),
        '# 跨卷伏笔台账\n\n- [thread_001 | status: ACTIVE] item_001 黄铜钥匙去向\n',
        'utf8'
    );
    await writeFile(
        join(dir, 'entities/char_001.md'),
        [
            '---',
            'entity_id: char_001',
            'canonical_name: 沈默',
            'unique_aliases: []',
            'contextual_titles: []',
            'historical_anchors:',
            '  - ch_0001:旧码头接货',
            'last_seen_ch: 1',
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: PUBLIC] 左肩旧伤无法负重',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级更新)',
            '- [day:1 | ch:01 | vis: PUBLIC] 位于旧码头',
            '',
            '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
            '- [day:1 | ch:01] 在旧码头清点木箱',
            '',
            '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
            '- [day:1 | ch:01] 检视铁柜锁扣',
            ''
        ].join('\n'),
        'utf8'
    );
    await writeFile(
        join(dir, 'entities/item_001.md'),
        [
            '---',
            'entity_id: item_001',
            'canonical_name: 黄铜钥匙',
            'unique_aliases: []',
            'contextual_titles: []',
            'historical_anchors: []',
            'last_seen_ch: 1',
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: PUBLIC] 齿痕带编号 K-07',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级更新)',
            '- [day:1 | ch:01 | vis: PUBLIC] 由 char_001 暂存',
            '',
            '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
            '',
            '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
            ''
        ].join('\n'),
        'utf8'
    );
    await writeFile(
        join(dir, 'manuscripts/ch_0001.md'),
        '# 第一章 旧码头\n\n沈默站在旧码头边，手里攥着那把黄铜钥匙。\n\n铁皮棚门吱呀一声推开。\n',
        'utf8'
    );

    const system = new NodeSystemAdapter();
    const ctx = new Context();
    const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot: dir });
    try {
        const store = ctx.narrateStore.openStore(dir);
        await store.initializeWalFromDisk();
        await system.initRepo(dir);
        await system.commitPaths(dir, ['.'], 'chore(boot): init yield test book');
    } finally {
        await storeFiber.dispose();
    }

    return dir;
}

afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
        const fn = cleanupCallbacks.pop();
        if (fn) {
            await fn();
        }
    }
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('yield_* 终态门禁工具确定性校验', () => {
    it('yield_context_pack 强制检验成对挂载，缺 L3 原稿切片时打回，齐备后放行并结束回合', async () => {
        const bookRoot = await createInitializedGitBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-librarian',
            bookRoot,
            yieldTool: 'yield_context_pack',
            targetChapter: 2,
            targetDay: 2,
            chapterGoal: '查明 item_001 归属'
        });
        registerCleanup(() => roleSet.cleanup());

        const yieldPack = roleSet.toolMap.get('yield_context_pack')!;
        expect(yieldPack.isConcurrencySafe?.({})).toBe(false);

        // 选了 item_001 但既无 recall_queries 也无 recall_slices -> 必须拒绝
        const badSpy = createSpyExec('yield_context_pack', {});
        await expect(
            yieldPack.execute(
                {
                    selected_entity_ids: ['item_001'],
                    recall_queries: [],
                    selected_lore_files: []
                },
                badSpy.exec
            )
        ).rejects.toThrow(GateValidationError);
        expect(badSpy.concludedCount()).toBe(0);
        expect(roleSet.hasYielded()).toBe(false);

        // 同时携带 selected_entity_ids 与 recall_queries（命中文稿 ch_0001.md）-> 通过并 concludeTurn
        const goodSpy = createSpyExec('yield_context_pack', {});
        const okRes = (await yieldPack.execute(
            {
                selected_entity_ids: ['item_001', 'char_001'],
                recall_queries: [
                    { entity_id: 'item_001', extra_keywords: [] },
                    { entity_id: 'char_001', extra_keywords: [] }
                ],
                selected_lore_files: []
            },
            goodSpy.exec
        )) as { accepted: boolean; recalledSliceCount: number };

        expect(okRes.accepted).toBe(true);
        expect(okRes.recalledSliceCount).toBeGreaterThanOrEqual(2);
        expect(goodSpy.concludedCount()).toBe(1);
        expect(roleSet.hasYielded()).toBe(true);

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('yield_outline 拒绝 outline_text 直接拷贝 director_rationale，分离后正常提交', async () => {
        const bookRoot = await createInitializedGitBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-planner',
            bookRoot,
            yieldTool: 'yield_outline'
        });
        registerCleanup(() => roleSet.cleanup());
        const yieldOutline = roleSet.toolMap.get('yield_outline')!;

        const secretRationale = '全知幕后推演：真正的接头人将在第三章才现身，此处只是虚晃一枪';
        const badSpy = createSpyExec('yield_outline', {});
        await expect(
            yieldOutline.execute(
                {
                    chapter_title: '第二章 货仓',
                    target_word_count: 2500,
                    focus_cast: ['char_001'],
                    director_rationale: secretRationale,
                    chapter_turn: '账本少了一页',
                    scene_plan: [{ scene_index: 1, location: '旧货仓', summary: '核对装箱单' }],
                    outline_text: `按计划执行，注意${secretRationale}`
                },
                badSpy.exec
            )
        ).rejects.toThrow(GateValidationError);
        expect(badSpy.concludedCount()).toBe(0);

        const goodSpy = createSpyExec('yield_outline', {});
        await yieldOutline.execute(
            {
                chapter_title: '第二章 货仓',
                target_word_count: 2500,
                focus_cast: ['char_001'],
                director_rationale: secretRationale,
                chapter_turn: '账本少了一页',
                scene_plan: [{ scene_index: 1, location: '旧货仓', summary: '核对装箱单', is_spotlight: true }],
                outline_text: '沈默提灯照向货柜夹缝，发现三号箱封条有二次粘合痕迹，随后停下笔等待窗外脚步声。'
            },
            goodSpy.exec
        );
        expect(goodSpy.concludedCount()).toBe(1);

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('yield_verdict 对捏造引文立即报错打回，真实原句（去标点匹配）通过验真', async () => {
        const bookRoot = await createInitializedGitBook();
        const draftText = '沈默低头看了一眼左手，掌心攥紧了黄铜钥匙，抬头望向仓库尽头。';

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-fc',
            bookRoot,
            yieldTool: 'yield_verdict',
            draftText
        });
        registerCleanup(() => roleSet.cleanup());
        const yieldVerdict = roleSet.toolMap.get('yield_verdict')!;

        // 捏造草稿引文 -> 拒绝
        const fakeDraftSpy = createSpyExec('yield_verdict', {});

        // passed=false 但 issues 为空数组 -> 拒绝
        const emptyIssuesSpy = createSpyExec('yield_verdict', {});
        await expect(
            yieldVerdict.execute(
                {
                    passed: false,
                    issues: []
                },
                emptyIssuesSpy.exec
            )
        ).rejects.toThrow(GateValidationError);
        expect(emptyIssuesSpy.concludedCount()).toBe(0);
        await expect(
            yieldVerdict.execute(
                {
                    passed: false,
                    issues: [
                        {
                            severity: 'LOCAL_PATCH',
                            paragraph_index: 0,
                            description: '举重物违背左肩旧伤',
                            quote_draft: '沈默单手扛起两百斤铁箱',
                            quote_source: '左肩旧伤无法负重',
                            source_ref: 'entities/char_001.md'
                        }
                    ]
                },
                fakeDraftSpy.exec
            )
        ).rejects.toThrow(GateValidationError);
        expect(fakeDraftSpy.concludedCount()).toBe(0);

        // 捏造档案引文 -> 拒绝
        const fakeSourceSpy = createSpyExec('yield_verdict', {});
        await expect(
            yieldVerdict.execute(
                {
                    passed: false,
                    issues: [
                        {
                            severity: 'LOCAL_PATCH',
                            paragraph_index: 0,
                            description: '与档案不符',
                            quote_draft: '掌心攥紧了黄铜钥匙',
                            quote_source: '角色其实右手残缺',
                            source_ref: 'entities/char_001.md'
                        }
                    ]
                },
                fakeSourceSpy.exec
            )
        ).rejects.toThrow(GateValidationError);
        expect(fakeSourceSpy.concludedCount()).toBe(0);

        // 双侧真实原句 -> 放行
        const validSpy = createSpyExec('yield_verdict', {});
        const okRes = (await yieldVerdict.execute(
            {
                passed: false,
                issues: [
                    {
                        severity: 'LOCAL_PATCH',
                        paragraph_index: 0,
                        description: '核对钥匙归属表述',
                        quote_draft: '掌心攥紧了黄铜钥匙',
                        quote_source: '由 char_001 暂存',
                        source_ref: 'entities/item_001.md'
                    }
                ]
            },
            validSpy.exec
        )) as { accepted: boolean };
        expect(okRes.accepted).toBe(true);
        expect(validSpy.concludedCount()).toBe(1);

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('yield_state_patch 拒绝篡改 Innate Locks、缺中文 canonical_name、断链外键，且仅在 commit 后 concludeTurn', async () => {
        const bookRoot = await createInitializedGitBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        // 先走完第 2 章正文 feat 提交以进入 FEAT_COMMITTED
        const store = ctx.narrateStore.openStore(bookRoot);
        await store.beginDraft(2);
        await store.commitDraft(2, '# 第二章\n\n林舟在雨中等候。\n');

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-extractor',
            bookRoot,
            yieldTool: 'yield_state_patch',
            chapterNumber: 2
        });
        registerCleanup(() => roleSet.cleanup());
        const yieldPatch = roleSet.toolMap.get('yield_state_patch')!;

        // 1. 篡改既有实体 Innate Locks -> 拒绝
        const innateSpy = createSpyExec('yield_state_patch', {});
        await expect(
            yieldPatch.execute(
                {
                    entity_patches: [
                        {
                            entity_id: 'char_001',
                            innate_locks_ops: [{ op: 'append', entry: { text: '强行改写红线' } }]
                        }
                    ],
                    story_day_delta: 1,
                    chapter_summary: '摘要'
                },
                innateSpy.exec
            )
        ).rejects.toThrow(InnateLockViolationError);
        expect(innateSpy.concludedCount()).toBe(0);

        // 2. 新建实体缺少中文 canonical_name -> 拒绝
        const noChineseSpy = createSpyExec('yield_state_patch', {});
        await expect(
            yieldPatch.execute(
                {
                    entity_patches: [
                        {
                            entity_id: 'char_002',
                            canonical_name: 'LinZhou'
                        }
                    ],
                    story_day_delta: 0,
                    chapter_summary: '摘要'
                },
                noChineseSpy.exec
            )
        ).rejects.toThrow(GateValidationError);
        expect(noChineseSpy.concludedCount()).toBe(0);

        // 3. 断链外键 -> 拒绝且磁盘无 char_002.md
        const fkSpy = createSpyExec('yield_state_patch', {});
        await expect(
            yieldPatch.execute(
                {
                    entity_patches: [
                        {
                            entity_id: 'char_002',
                            canonical_name: '林舟',
                            acquired_state_ops: [
                                {
                                    op: 'append',
                                    entry: { storyDay: 2, chapter: 2, visibility: 'PUBLIC', text: '持有 item_missing' }
                                }
                            ]
                        }
                    ],
                    story_day_delta: 1,
                    chapter_summary: '摘要'
                },
                fkSpy.exec
            )
        ).rejects.toThrow(ForeignKeyError);
        expect(fkSpy.concludedCount()).toBe(0);

        // 4. 合法补丁 -> state 提交成功并触发 concludeTurn
        const okSpy = createSpyExec('yield_state_patch', {});
        const okRes = (await yieldPatch.execute(
            {
                entity_patches: [
                    {
                        entity_id: 'char_002',
                        canonical_name: '林舟',
                        last_seen_ch: 2,
                        acquired_state_ops: [
                            {
                                op: 'append',
                                entry: { storyDay: 2, chapter: 2, visibility: 'PUBLIC', text: '与 char_001 接头' }
                            }
                        ]
                    }
                ],
                story_day_delta: 1,
                chapter_summary: '沈默与林舟接头。',
                next_chapter_options: ['继续追踪钥匙']
            },
            okSpy.exec
        )) as { accepted: boolean; commitSha?: string; updatedEntities: string[] };

        expect(okRes.accepted).toBe(true);
        expect(okRes.commitSha).toBeTruthy();
        expect(okRes.updatedEntities).toEqual(['char_002']);
        expect(okSpy.concludedCount()).toBe(1);
        expect((await store.readTxState()).phase).toBe('STATE_COMMITTED');

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('yield_dream_commit 在门禁失败时磁盘零变动，全部通过后原子落盘、更新水位、commit 并 concludeTurn', async () => {
        const bookRoot = await createInitializedGitBook();
        const diskCharBefore = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        const diskThreadsBefore = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        // 非安全相位 (FEAT_COMMITTED) 时必须拒绝 Dreaming
        const store = ctx.narrateStore.openStore(bookRoot);
        await store.beginDraft(2);
        await store.commitDraft(2, '# 第二章\n\n过渡文本。\n');

        const roleSetPhaseFail = ctx.narrateTools.buildRoleTools({
            runId: 'run-dream-phase-fail',
            bookRoot,
            yieldTool: 'yield_dream_commit'
        });
        registerCleanup(() => roleSetPhaseFail.cleanup());
        const phaseSpy = createSpyExec('yield_dream_commit', {});
        await expect(
            roleSetPhaseFail.toolMap.get('yield_dream_commit')!.execute(
                { summary: '相位校验' },
                phaseSpy.exec
            )
        ).rejects.toThrow(/FEAT_COMMITTED/);
        expect(phaseSpy.concludedCount()).toBe(0);
        roleSetPhaseFail.cleanup();

        // 补齐 state 提交以进入 STATE_COMMITTED
        await store.applyStatePatch(2, []);

        // 测试 1：篡改 Innate Locks -> 拒绝且磁盘零写入
        const roleSetInnate = ctx.narrateTools.buildRoleTools({
            runId: 'run-dream-innate',
            bookRoot,
            yieldTool: 'yield_dream_commit'
        });
        registerCleanup(() => roleSetInnate.cleanup());
        await roleSetInnate.toolMap.get('book_edit')!.execute(
            {
                path: 'entities/char_001.md',
                target_text: '- [vis: PUBLIC] 左肩旧伤无法负重',
                replacement_text: '- [vis: PUBLIC] 左肩完好无损'
            },
            createSpyExec('book_edit', {}).exec
        );
        const innateSpy = createSpyExec('yield_dream_commit', {});
        await expect(
            roleSetInnate.toolMap.get('yield_dream_commit')!.execute(
                { summary: '试图改写红线' },
                innateSpy.exec
            )
        ).rejects.toThrow(InnateLockViolationError);
        expect(innateSpy.concludedCount()).toBe(0);
        expect(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8')).toBe(diskCharBefore);
        roleSetInnate.cleanup();

        // 测试 2：>15 条活跃伏笔 -> 拒绝且磁盘零写入
        const roleSetThreads = ctx.narrateTools.buildRoleTools({
            runId: 'run-dream-threads',
            bookRoot,
            yieldTool: 'yield_dream_commit'
        });
        registerCleanup(() => roleSetThreads.cleanup());
        const sixteenThreads = [
            '# 跨卷伏笔台账',
            '',
            ...Array.from({ length: 16 }, (_, idx) => `- [thread_${String(idx + 1).padStart(3, '0')} | status: ACTIVE] 伏笔 ${idx + 1}`)
        ].join('\n');
        await roleSetThreads.toolMap.get('book_edit')!.execute(
            {
                path: 'world/open_threads.md',
                mode: 'write',
                replacement_text: sixteenThreads
            },
            createSpyExec('book_edit', {}).exec
        );
        const threadSpy = createSpyExec('yield_dream_commit', {});
        await expect(
            roleSetThreads.toolMap.get('yield_dream_commit')!.execute(
                { summary: '超限伏笔' },
                threadSpy.exec
            )
        ).rejects.toThrow(GateValidationError);
        expect(threadSpy.concludedCount()).toBe(0);
        expect(await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8')).toBe(diskThreadsBefore);
        roleSetThreads.cleanup();

        // 测试 3：断链外键 -> 拒绝且磁盘零写入
        const roleSetFk = ctx.narrateTools.buildRoleTools({
            runId: 'run-dream-fk',
            bookRoot,
            yieldTool: 'yield_dream_commit'
        });
        registerCleanup(() => roleSetFk.cleanup());
        await roleSetFk.toolMap.get('book_edit')!.execute(
            {
                path: 'world/open_threads.md',
                target_text: 'item_001 黄铜钥匙去向',
                replacement_text: 'item_999 不存在的钥匙'
            },
            createSpyExec('book_edit', {}).exec
        );
        const fkSpy = createSpyExec('yield_dream_commit', {});
        await expect(
            roleSetFk.toolMap.get('yield_dream_commit')!.execute(
                { summary: '断链测试' },
                fkSpy.exec
            )
        ).rejects.toThrow(ForeignKeyError);
        expect(fkSpy.concludedCount()).toBe(0);
        expect(await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8')).toBe(diskThreadsBefore);
        roleSetFk.cleanup();

        // 测试 4：全部合规（归档伏笔 + 更新实体履历 + 投递 Spotlight Trigger）-> 原子提交并清理暂存
        const roleSetOk = ctx.narrateTools.buildRoleTools({
            runId: 'run-dream-ok',
            bookRoot,
            yieldTool: 'yield_dream_commit'
        });
        registerCleanup(() => roleSetOk.cleanup());
        await roleSetOk.toolMap.get('book_edit')!.execute(
            {
                path: 'world/open_threads.md',
                target_text: '- [thread_001 | status: ACTIVE] item_001 黄铜钥匙去向',
                replacement_text: '- [thread_001 | status: RESOLVED] item_001 黄铜钥匙去向（已核实）'
            },
            createSpyExec('book_edit', {}).exec
        );
        await roleSetOk.toolMap.get('book_edit')!.execute(
            {
                path: 'entities/char_001.md',
                target_text: '- [day:1 | ch:01] 检视铁柜锁扣',
                replacement_text: '- [day:1 | ch:01] 检视铁柜锁扣（已完成整理）'
            },
            createSpyExec('book_edit', {}).exec
        );

        const okSpy = createSpyExec('yield_dream_commit', {});
        const commitRes = (await roleSetOk.toolMap.get('yield_dream_commit')!.execute(
            {
                summary: '完成第 2 章后整理',
                chapter_number: 2,
                accumulated_words: 3200,
                spotlight_triggers: [
                    {
                        entity_id: 'char_001',
                        reason: '旧码头线人已到达汇合临界点',
                        suggested_mode: 'MAINLINE'
                    }
                ]
            },
            okSpy.exec
        )) as { accepted: boolean; chapterNumber: number; committedPaths: string[] };

        expect(commitRes.accepted).toBe(true);
        expect(commitRes.chapterNumber).toBe(2);
        expect(okSpy.concludedCount()).toBe(1);
        expect(ctx.narrateStore.staging.has('run-dream-ok')).toBe(false);
        expect((await store.readTxState()).phase).toBe('DREAM_COMMITTED');
        expect((await store.readDreamWatermark())?.last_dream_ch).toBe(2);
        expect(await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8')).toContain('status: RESOLVED');
        expect(await readFile(join(bookRoot, '.ops/signals.jsonl'), 'utf8')).toContain('SPOTLIGHT_TRIGGER');

        roleSetOk.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('yield_dream_commit 在首份暂存文件写入磁盘前先调用 recordPendingWrites 落盘恢复清单', async () => {
        const bookRoot = await createInitializedGitBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-dream-pending-order',
            bookRoot,
            yieldTool: 'yield_dream_commit'
        });
        await roleSet.toolMap.get('book_edit')!.execute(
            {
                path: 'world/open_threads.md',
                target_text: '- [thread_001 | status: ACTIVE] item_001 黄铜钥匙去向',
                replacement_text: '- [thread_001 | status: RESOLVED] item_001 黄铜钥匙去向（已核实）'
            },
            createSpyExec('book_edit', {}).exec
        );

        let pendingFileExistedAtRecordTime = false;
        let recordedPaths: string[] = [];
        let threadsHadResolvedAtRecordTime = false;
        const origRecord = BookStore.prototype.recordPendingWrites;
        const spy = vi.spyOn(BookStore.prototype, 'recordPendingWrites').mockImplementation(async function (
            this: BookStore,
            paths: string[]
        ) {
            if (recordedPaths.length === 0) {
                recordedPaths = [...paths];
                const diskThreads = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
                threadsHadResolvedAtRecordTime = diskThreads.includes('status: RESOLVED');
            }
            await origRecord.call(this, paths);
            if (!pendingFileExistedAtRecordTime) {
                pendingFileExistedAtRecordTime = existsSync(join(bookRoot, '.ops/pending_writes.json'));
            }
        });

        try {
            const okSpy = createSpyExec('yield_dream_commit', {});
            await roleSet.toolMap.get('yield_dream_commit')!.execute(
                {
                    summary: '崩溃恢复前置测试',
                    chapter_number: 1,
                    spotlight_triggers: [
                        {
                            entity_id: 'char_001',
                            reason: '切镜测试',
                            suggested_mode: 'MAINLINE'
                        }
                    ]
                },
                okSpy.exec
            );

            expect(spy).toHaveBeenCalled();
            expect(threadsHadResolvedAtRecordTime).toBe(false);
            expect(pendingFileExistedAtRecordTime).toBe(true);
            expect(recordedPaths).toEqual(
                expect.arrayContaining([
                    'world/open_threads.md',
                    '.ops/signals.jsonl',
                    '.ops/dream_watermark.json'
                ])
            );
        } finally {
            spy.mockRestore();
            roleSet.cleanup();
            await toolsFiber.dispose();
            await storeFiber.dispose();
        }
    });

    it('yield_boot_bundle 与 lock_charter_and_boot 共享门禁：校验中文名、staticBaseAndVoice、trajectory 与 buffer', async () => {
        const bookRoot = await createInitializedGitBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-boot-bundle',
            bookRoot,
            yieldTool: 'yield_boot_bundle'
        });
        registerCleanup(() => roleSet.cleanup());
        const yieldBoot = roleSet.toolMap.get('yield_boot_bundle')!;

        const validBundle = {
            world_summary: '冬夜港口停工，货仓外只留一盏风灯。',
            static_base_and_voice: '第三人称限知视角，短句克制，重物理器械细节。',
            current_arc_envelope: '沈默核对三号仓货单，寻找消失的木箱去向。',
            stage_ceiling: '第一卷不得揭露海关签批人身份。',
            opening_sequence_beats: [
                { craft_focus: '风灯与铁锁', clue_budget: '三号仓编号', completion_sign: '确认空仓' },
                { craft_focus: '交接账册', clue_budget: '夜班签名', completion_sign: '墨迹未干' },
                { craft_focus: '驳船码头', clue_budget: '拖轮尾号', completion_sign: '锁定航向' }
            ],
            l1_volumes_markdown: '# L1\n\n- vol_01: 封港账',
            entities: [
                {
                    entityId: 'char_001',
                    canonicalName: '沈默',
                    innateLocks: [{ visibility: 'PUBLIC', text: '左手旧伤' }],
                    acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', text: '在港口外廊' }],
                    irreversibleTrajectory: [{ storyDay: 0, text: '接过提货单' }],
                    recentBuffer: [{ storyDay: 0, text: '核对仓号' }]
                }
            ]
        };

        // static_base_and_voice 触发 StaticProseGate -> 拒绝
        await expect(
            yieldBoot.execute(
                {
                    ...validBundle,
                    static_base_and_voice: '他指节泛白，喉结滚动，眼神中闪过一丝犹豫。'
                },
                createSpyExec('yield_boot_bundle', {}).exec
            )
        ).rejects.toThrow(GateValidationError);

        // irreversibleTrajectory 触发 StaticProseGate -> 拒绝
        await expect(
            yieldBoot.execute(
                {
                    ...validBundle,
                    entities: [
                        {
                            ...validBundle.entities[0]!,
                            irreversibleTrajectory: [
                                { storyDay: 0, text: '他指节泛白，眼神中闪过一丝寒意。' }
                            ]
                        }
                    ]
                },
                createSpyExec('yield_boot_bundle', {}).exec
            )
        ).rejects.toThrow(GateValidationError);

        const okSpy = createSpyExec('yield_boot_bundle', {});
        const res = (await yieldBoot.execute(validBundle, okSpy.exec)) as { accepted: boolean };
        expect(res.accepted).toBe(true);
        expect(okSpy.concludedCount()).toBe(1);

        roleSet.cleanup();
        await toolsFiber.dispose();
        await storeFiber.dispose();
    });

    it('deferCommit 模式下 yield_state_patch 识别 visibleEntities 内存分支实体并保持 Innate Locks 防护与外键可达性', async () => {
        const bookRoot = await createInitializedGitBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const branchProfile: EntityProfile = {
            metadata: {
                entity_id: 'char_branch_01',
                canonical_name: '陈九',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 2
            },
            sectionHeadings: { ...DEFAULT_SECTION_HEADINGS },
            innateLocks: [{ visibility: 'PUBLIC', text: '左颊有旧刀疤', continuationLines: [] }],
            acquiredState: [],
            irreversibleTrajectory: [],
            recentBuffer: []
        };
        const visibleEntities = new Map<string, EntityProfile>([[branchProfile.metadata.entity_id, branchProfile]]);

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-defer-branch',
            bookRoot,
            yieldTool: 'yield_state_patch',
            chapterNumber: 3,
            timelineMode: 'PARALLEL',
            deferCommit: true,
            visibleEntities,
            reachableIds: ['ch_0002']
        });
        registerCleanup(() => roleSet.cleanup());

        const yieldPatch = roleSet.toolMap.get('yield_state_patch')!;

        // 1. 篡改内存分支实体的 Innate Locks 必须被拦截
        const innateSpy = createSpyExec('yield_state_patch', {});
        await expect(
            yieldPatch.execute(
                {
                    entity_patches: [
                        {
                            entity_id: 'char_branch_01',
                            innate_locks_ops: [{ op: 'append', entry: { text: '抹去刀疤' } }]
                        }
                    ],
                    story_day_delta: 0,
                    chapter_summary: '测试'
                },
                innateSpy.exec
            )
        ).rejects.toThrow(InnateLockViolationError);
        expect(innateSpy.concludedCount()).toBe(0);

        // 2. 更新磁盘尚未落盘的内存分支实体无需重复 canonical_name，且可引用分支实体与 reachableIds
        const okSpy = createSpyExec('yield_state_patch', {});
        const okRes = (await yieldPatch.execute(
            {
                entity_patches: [
                    {
                        entity_id: 'char_branch_01',
                        last_seen_ch: 3,
                        acquired_state_ops: [
                            {
                                op: 'upsert_slot',
                                slot_key: 'location',
                                entry: {
                                    storyDay: 1,
                                    chapter: 3,
                                    visibility: 'PUBLIC',
                                    text: '在 ch_0002 锚地接应 char_branch_01'
                                }
                            }
                        ]
                    }
                ],
                story_day_delta: 0,
                chapter_summary: '支线二章推进'
            },
            okSpy.exec
        )) as { accepted: boolean; updatedEntities: string[] };

        expect(okRes.accepted).toBe(true);
        expect(okRes.updatedEntities).toEqual(['char_branch_01']);
        expect(okSpy.concludedCount()).toBe(1);
    });

    it('yield_state_patch 的 entity_patches 描述包含完整 ops 与 entry 结构示例且保持严格 Zod 校验', async () => {
        const bookRoot = await createInitializedGitBook();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { bookRoot });
        registerCleanup(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-yield-schema-desc',
            bookRoot,
            yieldTool: 'yield_state_patch',
            chapterNumber: 2
        });
        registerCleanup(() => roleSet.cleanup());

        const yieldPatch = roleSet.toolMap.get('yield_state_patch')!;
        const props = (yieldPatch.parameters as {
            properties?: Record<string, { description?: string }>;
        }).properties;
        const entityPatchesDesc = props?.entity_patches?.description ?? '';

        for (const keyword of [
            'buffer_ops',
            'upsert_slot',
            'append',
            'trim_buffer',
            'max_entries',
            'acquired_state_ops',
            'remove_slot',
            'upsert_ledger',
            'trajectory_ops',
            'innate_locks_ops',
            'slot_key',
            'entry',
            'text',
            'storyDay',
            'chapter',
            'visibility',
            'owner',
            'status',
            'slotKey'
        ]) {
            expect(entityPatchesDesc).toContain(keyword);
        }

        // 校验逻辑不得放松：缺少 text 或非法的 trim_buffer.max_entries 必须拒绝
        const badSpy = createSpyExec('yield_state_patch', {});
        await expect(
            yieldPatch.execute(
                {
                    entity_patches: [
                        {
                            entity_id: 'char_001',
                            buffer_ops: [{ op: 'trim_buffer', max_entries: 0 }]
                        }
                    ],
                    story_day_delta: 0,
                    chapter_summary: '非法参数测试'
                },
                badSpy.exec
            )
        ).rejects.toThrow();
        await expect(
            yieldPatch.execute(
                {
                    entity_patches: [
                        {
                            entity_id: 'char_001',
                            buffer_ops: [{ op: 'append', entry: { storyDay: 2 } }]
                        }
                    ],
                    story_day_delta: 0,
                    chapter_summary: '缺少 entry.text 测试'
                },
                badSpy.exec
            )
        ).rejects.toThrow();
        expect(badSpy.concludedCount()).toBe(0);
    });
});

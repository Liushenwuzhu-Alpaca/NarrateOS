import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import {
    BookStore,
    NodeSystemAdapter,
    type CleanroomRequest,
    type LlmPort,
    type SystemPort
} from '@narrateos/dsh-book-store';
import * as bookToolsPlugin from '@narrateos/dsh-book-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleLoader } from '../roles/role-loader.js';
import { DshLlmAdapter } from '../runner/dsh-llm-adapter.js';
import { RoleRunner } from '../runner/role-runner.js';
import { createGitBookWorkspace, createHeadlessMockServices, textToStreamChunks } from '../test-harness.js';
import { SyncPipeline } from './sync-pipeline.js';
import { VolumePipeline } from './volume-pipeline.js';

const execFileAsync = promisify(execFile);

function createMockLlmPort(
    handler: (req: CleanroomRequest) => string
): { llm: LlmPort; requests: CleanroomRequest[] } {
    const requests: CleanroomRequest[] = [];
    const llm: LlmPort = {
        async generate(req) {
            requests.push(req);
            const text = handler(req);
            return {
                text,
                usage: {
                    inputTokens: 100,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    outputTokens: 50
                },
                finishReason: 'stop'
            };
        }
    };
    return { llm, requests };
}

describe('SyncPipeline & VolumePipeline 单元测试', () => {
    const tempDirs: string[] = [];
    const cleanups: Array<() => Promise<void> | void> = [];

    afterEach(async () => {
        while (cleanups.length > 0) {
            const fn = cleanups.pop()!;
            await fn();
        }
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('完结提交后第二个标签失败，重试在 HEAD 已前移时只补原提交上的标签', async () => {
        const root = await createGitBookWorkspace(tempDirs, 'seal-recovery', { storyDay: 1, currentChapter: 1 });
        class InterruptedTags extends NodeSystemAdapter {
            override async createTag(path: string, name: string, message?: string, sha?: string) {
                if (name === 'novel-completed') throw new Error('标签中断');
                await super.createTag(path, name, message, sha);
            }
        }
        const system = new InterruptedTags();
        const store = new BookStore(root, system);
        const { llm, requests } = createMockLlmPort((req) => JSON.stringify(req.traceStage === 'volume.style'
            ? { merged_markdown: '风吹过码头。' } : { volume_summary: '第一行\n第二行', story_day_span: '1' }));
        await expect(new VolumePipeline({ store, system, llm }).advanceVolume({ completeBook: true })).rejects.toThrow('标签中断');
        const sealed = await system.currentRevision(root);
        const calls = requests.length;
        await writeFile(join(root, 'note.md'), '后续独立工作');
        const next = await system.commitPaths(root, ['note.md'], 'test: unrelated revision');
        const recovered = await new VolumePipeline({ store, system: new NodeSystemAdapter(), llm }).advanceVolume();
        expect(recovered).toMatchObject({ completedBook: true, sealedVolume: 1, commitSha: sealed });
        expect(await system.currentRevision(root, 'refs/tags/novel-completed')).toBe(sealed);
        expect(await system.currentRevision(root)).toBe(next.sha);
        expect(requests).toHaveLength(calls);
        expect(await readFile(join(root, 'index/L0_sagas.md'), 'utf8')).toContain('第一行 第二行');
    });

    it('同书第六章 FEAT 未完成时 Sync 不得结束它，恢复后才可同步第五章', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-ownership', {
            currentChapter: 5, extraChapters: { 'ch_0005.md': '# 五\n\n旧稿。\n' }
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const { llm, requests } = createMockLlmPort(req => req.traceStage === 'sync.audit'
            ? '{"conflicts":[]}'
            : JSON.stringify({ entity_patches: [], story_day_delta: 0, plot_summary: '修订。',
                appeared_entity_ids: [], prose_anchors: [], next_chapter_options: [] }));
        const sync = new SyncPipeline({ store, llm, system });
        await store.beginDraft(6);
        const feat = await store.commitDraft(6, '# 六\n\n第六章正文。\n');
        const path = join(bookRoot, 'manuscripts/ch_0005.md');
        await writeFile(path, '# 五\n\n第五章新事实。\n');
        const before = await store.readTxState();
        await expect(sync.syncManuscripts()).rejects.toThrow(/FEAT_COMMITTED/);
        expect(requests).toHaveLength(0);
        expect(await system.currentRevision(bookRoot)).toBe(feat.sha);
        expect(await store.readTxState()).toEqual(before);
        expect(await readFile(path, 'utf8')).toContain('第五章新事实');
        expect((await store.recoverWal()).activeChapter).toBe(6);
        await store.applyStatePatch(6, []);
        expect((await sync.syncManuscripts()).status).toBe('HISTORY_SYNCED_NO_CONFLICT');
        expect(await store.detectDirtyChapters()).toEqual([]);
        await writeFile(join(bookRoot, '.ops/tx_state.json'), '{');
        expect((await sync.syncManuscripts()).status).toBe('CLEAN');
        await rm(path);
        await expect(sync.syncManuscripts()).rejects.toThrow(/ch_0005.*缺失/);
    });

    it('SyncPipeline 预检拒绝跳号 UNTRACKED 手稿与活跃 PARALLEL 窗口修改', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-precheck', {
            storyDay: 2,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n沈默核对账簿。\n',
                'ch_0002.md': '# 第二章 夜雨\n\n雨势渐大。\n'
            }
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const { llm } = createMockLlmPort(() => '{}');
        const sync = new SyncPipeline({ store, llm, system });

        // 1. 跳号 UNTRACKED (ch_0005 > last_committed_ch + 1 = 3)
        await writeFile(join(bookRoot, 'manuscripts/ch_0005.md'), '# 第五章 跳号\n\n正文。\n', 'utf8');
        await expect(sync.syncManuscripts()).rejects.toThrow(/跳号/);
        await rm(join(bookRoot, 'manuscripts/ch_0005.md'));

        // 2. 活跃 OPEN 并行窗口拒绝修改主线章
        await mkdir(join(bookRoot, '.ops/parallel_deltas/win-open'), { recursive: true });
        await writeFile(
            join(bookRoot, '.ops/parallel_deltas/win-open/window.json'),
            JSON.stringify({ windowId: 'win-open', status: 'OPEN', baseChapter: 2 }),
            'utf8'
        );
        await writeFile(join(bookRoot, 'manuscripts/ch_0001.md'), '# 第一章 码头\n\n沈默改了台词。\n', 'utf8');
        await expect(sync.syncManuscripts()).rejects.toThrow(/并行窗口/);
    });

    it('SyncPipeline 混合修改第 1 章与第 3 章时按序处理、精准刷新跨卷 L2 双轨卡、不倒流覆写最新实体且保留 chapter_context', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-mixed-crossvol', {
            storyDay: 5,
            currentChapter: 3,
            extraChapters: {
                'ch_0001.md': '# 第一章 旧码头\n\n沈默在三号码头清点黄铜提灯。\n',
                'ch_0002.md': '# 第二章 风浪\n\n沈默赶往外港锚地。\n',
                'ch_0003.md': '# 第三章 新局\n\n沈默目前驻留于海关总署二楼。\n'
            }
        });

        // 构造跨卷状态：current_volume = 2，而第 1 章属于第 1 卷
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const ws = await store.readWorldState();
        ws.frontmatter.current_volume = 2;
        await store.writeWorldState(ws);
        await writeFile(
            join(bookRoot, 'index/L1_volumes.md'),
            '# L1 活跃卷级总表\n\n## 第 1 卷 (vol_01) [ch_0001 ~ ch_0002]\n海港初查\n\n## 第 2 卷 (vol_02) [ch_0003 ~ ch_0010]\n总署暗战\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            '# 第 1 卷双轨章卡\n\n## ch_0001 (day:1)\n- 主干剧情：旧摘要。\n- 异象锚点：无\n- 出场实体：char_001\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_02_cards.md'),
            '# 第 2 卷双轨章卡\n\n## ch_0003 (day:5)\n- 主干剧情：旧第3章摘要。\n- 异象锚点：无\n- 出场实体：char_001\n',
            'utf8'
        );
        // 第 3 章写入最新实体的第 2 区位置
        const char1Raw = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        await writeFile(
            join(bookRoot, 'entities/char_001.md'),
            char1Raw.replace('驻留节点：三号码头货栈', '[slot:location] 驻留节点：海关总署二楼'),
            'utf8'
        );
        // 提交并保存第 3 章的 chapter_context
        const txState = await store.readTxState();
        txState.chapter_context = {
            timelineMode: 'MAINLINE',
            targetDay: 5,
            povCharIds: ['char_001']
        };
        await writeFile(join(bookRoot, '.ops/tx_state.json'), `${JSON.stringify(txState, null, 4)}\n`, 'utf8');
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: setup cross-vol state']);

        // 同时手改第 1 章（历史旧章）与第 3 章（最新章）
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0001.md'),
            '# 第一章 旧码头\n\n沈默在三号码头拾起刻痕铜钟，驻留于旧仓库。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0003.md'),
            '# 第三章 新局\n\n沈默携林小满进入海关总署地下档案室。\n',
            'utf8'
        );

        const traceOrder: string[] = [];
        const { llm } = createMockLlmPort((req) => {
            traceOrder.push(req.traceStage ?? 'unknown');
            if (req.traceStage === 'sync.history_extractor') {
                // 故意输出一条会把 location 倒流回旧仓库的 entity_patches，验证 Step 1 绝不覆写实体第 2 区
                return JSON.stringify({
                    entity_patches: [
                        {
                            entity_id: 'char_001',
                            acquired_state_ops: [
                                {
                                    op: 'upsert_slot',
                                    slot_key: 'location',
                                    entry: { storyDay: 1, chapter: 1, text: '倒流旧仓库' }
                                }
                            ]
                        }
                    ],
                    story_day_delta: 0,
                    plot_summary: '沈默在旧仓库拾起刻痕铜钟。',
                    prose_anchors: ['刻痕铜钟', '不存在的幻觉词'],
                    appeared_entity_ids: ['char_001'],
                    next_chapter_options: []
                });
            }
            if (req.traceStage === 'sync.classify') {
                return JSON.stringify({
                    is_prose_polish_only: false,
                    reason: '新增进入地下档案室与同行角色林小满',
                    affected_entity_ids: ['char_001', 'char_002']
                });
            }
            if (req.traceStage === 'sync.extractor') {
                return JSON.stringify({
                    entity_patches: [
                        {
                            entity_id: 'char_001',
                            last_seen_ch: 3,
                            acquired_state_ops: [
                                {
                                    op: 'upsert_slot',
                                    slot_key: 'location',
                                    entry: {
                                        storyDay: 5,
                                        chapter: 3,
                                        visibility: 'PUBLIC',
                                        text: '驻留节点：海关总署地下档案室'
                                    }
                                }
                            ]
                        }
                    ],
                    story_day_delta: 0,
                    plot_summary: '沈默与林小满进入海关总署地下档案室。',
                    prose_anchors: ['地下档案室'],
                    appeared_entity_ids: ['char_001', 'char_002'],
                    next_chapter_options: ['翻查密档', '核对签名']
                });
            }
            if (req.traceStage === 'sync.audit') {
                return JSON.stringify({ conflicts: [] });
            }
            return '{}';
        });

        const sync = new SyncPipeline({ store, llm, system });
        const res = await sync.syncManuscripts();

        expect(res.status).toBe('HISTORY_SYNCED_NO_CONFLICT');
        // 严格先处理历史旧章，再定性与抽取最新章，最后扫描下游
        expect(traceOrder.slice(0, 3)).toEqual([
            'sync.history_extractor',
            'sync.classify',
            'sync.extractor'
        ]);
        expect(res.stateDiffAdvisories?.some((a) => a.includes('ch_0001'))).toBe(true);

        // 第 1 章双轨卡精准落盘至 vol_01_cards.md，而非 vol_02_cards.md
        const vol1Card = await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8');
        expect(vol1Card).toContain('## ch_0001 (day:1)');
        expect(vol1Card).toContain('- 主干剧情：沈默在旧仓库拾起刻痕铜钟。');
        expect(vol1Card).toContain('- 异象锚点：刻痕铜钟');
        expect(vol1Card).not.toContain('不存在的幻觉词');
        expect(vol1Card).toContain('- 出场实体：char_001');

        const vol2Card = await readFile(join(bookRoot, 'index/L2_cards/vol_02_cards.md'), 'utf8');
        expect(vol2Card).not.toContain('## ch_0001');
        expect(vol2Card).toContain('## ch_0003 (day:5)');
        expect(vol2Card).toContain('- 异象锚点：地下档案室');
        expect(vol2Card).toContain('- 出场实体：char_001, char_002');

        // 实体第 2 区为第 3 章新位置，绝不被第 1 章旧态倒流覆盖
        const char1Updated = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        expect(char1Updated).toContain('海关总署地下档案室');
        expect(char1Updated).not.toContain('倒流旧仓库');

        // .ops/next_chapter_options.json 与 txState.chapter_context 保留完整
        const nextOpts = JSON.parse(
            await readFile(join(bookRoot, '.ops/next_chapter_options.json'), 'utf8')
        ) as { source_chapter: number; options: string[] };
        expect(nextOpts).toEqual({ source_chapter: 3, options: ['翻查密档', '核对签名'] });

        const txAfter = await store.readTxState();
        expect(txAfter.chapter_context?.timelineMode).toBe('MAINLINE');
        expect(Object.keys(txAfter.chapter_hashes)).toEqual(
            expect.arrayContaining(['ch_0001', 'ch_0002', 'ch_0003'])
        );
        expect(await store.detectDirtyChapters()).toEqual([]);
    });

    it('SyncPipeline 在最新章为 FLASHBACK 时保留 chapter_context 并拦截第 2/4 区与 world_state 覆写', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-flashback-guard', {
            storyDay: 10,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n主线日第 10 天。\n',
                'ch_0002.md': '# 第二章 十年前旧事\n\n十年前沈默在老桥避雨。\n'
            }
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const tx = await store.readTxState();
        tx.chapter_context = {
            timelineMode: 'FLASHBACK',
            targetDay: -3650,
            povCharIds: ['char_001']
        };
        await writeFile(join(bookRoot, '.ops/tx_state.json'), `${JSON.stringify(tx, null, 4)}\n`, 'utf8');
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: commit flashback ch2']);

        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '# 第二章 十年前旧事\n\n十年前沈默在老桥记住暗门暗号。\n',
            'utf8'
        );

        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'sync.classify') {
                return JSON.stringify({
                    is_prose_polish_only: false,
                    reason: '新增往事记忆',
                    affected_entity_ids: ['char_001']
                });
            }
            return JSON.stringify({
                entity_patches: [
                    {
                        entity_id: 'char_001',
                        trajectory_ops: [
                            { op: 'append', entry: { storyDay: -3650, chapter: 2, text: '记住老桥暗门暗号' } }
                        ]
                    }
                ],
                story_day_delta: 0,
                plot_summary: '回忆十年前老桥暗门暗号。',
                prose_anchors: ['老桥'],
                appeared_entity_ids: ['char_001'],
                next_chapter_options: ['回到主线']
            });
        });

        const sync = new SyncPipeline({ store, llm, system });
        const res = await sync.syncManuscripts();
        expect(res.status).toBe('STATE_SYNCED');
        const wsAfter = await store.readWorldState();
        expect(wsAfter.frontmatter.story_day).toBe(10);
        const txAfter = await store.readTxState();
        expect(txAfter.chapter_context?.timelineMode).toBe('FLASHBACK');
        expect(txAfter.chapter_context?.targetDay).toBe(-3650);
    });

    it('SyncPipeline 下游冲突扫描按 batch 分批、双侧 verifyDualQuotes 拦截幻觉引文并落盘 .ops/sync_conflicts.json', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-downstream-dualquote', {
            storyDay: 3,
            currentChapter: 3,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n沈默左手拎着黄铜提灯。\n',
                'ch_0002.md': '# 第二章 泊位\n\n沈默在二号泊位核对夜班船单。\n',
                'ch_0003.md': '# 第三章 仓库\n\n林小满递过纸条，沈默左手举起铁水壶。\n'
            }
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        // 配置较小 batch 预算触发分批扫描
        const cfg = await store.readBookConfig();
        cfg.ops_and_sync = {
            ...cfg.ops_and_sync,
            conflict_scan_batch_chars: 40
        };
        await store.writeBookConfig(cfg);
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            [
                '# 第 1 卷双轨章卡',
                '',
                '## ch_0001 (day:1)',
                '- 主干剧情：沈默清点提灯。',
                '- 异象锚点：黄铜提灯',
                '- 出场实体：char_001',
                '',
                '## ch_0002 (day:2)',
                '- 主干剧情：沈默核对夜班船单。',
                '- 异象锚点：无',
                '- 出场实体：char_001',
                '',
                '## ch_0003 (day:3)',
                '- 主干剧情：沈默左手举起铁水壶。',
                '- 异象锚点：铁水壶',
                '- 出场实体：char_001, char_002'
            ].join('\n') + '\n',
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: config batch scan']);

        // 手改第 1 章为"左臂缠着夹板无法抬举"，与第 3 章"左手举起铁水壶"实锤冲突
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0001.md'),
            '# 第一章 码头\n\n沈默左臂缠着厚夹板，完全无法抬举。\n',
            'utf8'
        );
        const ch2Before = await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8');
        const ch3Before = await readFile(join(bookRoot, 'manuscripts/ch_0003.md'), 'utf8');

        let auditBatches = 0;
        let failAudit = true;
        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'sync.history_extractor') {
                return JSON.stringify({
                    entity_patches: [],
                    story_day_delta: 0,
                    plot_summary: '沈默左臂打着厚夹板。',
                    prose_anchors: ['厚夹板'],
                    appeared_entity_ids: ['char_001'],
                    next_chapter_options: []
                });
            }
            if (req.traceStage === 'sync.audit') {
                if (failAudit) throw new Error('模拟扫描中断');
                auditBatches += 1;
                return JSON.stringify({
                    conflicts: [
                        {
                            // 幻觉脏章原句 -> 必须拦截
                            dirty_chapter: 1,
                            dirty_quote: '沈默右腿骨折',
                            chapter_number: 2,
                            line_number: 3,
                            quote: '沈默在二号泊位核对夜班船单',
                            description: '伪造历史脏章原句'
                        },
                        {
                            // 幻觉下游原句 -> 必须拦截
                            dirty_chapter: 1,
                            dirty_quote: '沈默左臂缠着厚夹板',
                            chapter_number: 2,
                            line_number: 3,
                            quote: '沈默端起巨石',
                            description: '伪造下游原句'
                        },
                        {
                            // 真实双侧原句（含标点差异） -> 必须放行并验真行号
                            dirty_chapter: 1,
                            dirty_quote: '沈默左臂缠着厚夹板完全无法抬举',
                            chapter_number: 3,
                            line_number: 3,
                            quote: '沈默左手举起铁水壶',
                            description: '左臂缠夹板却举起铁水壶'
                        }
                    ]
                });
            }
            return '{}';
        });

        const sync = new SyncPipeline({ store, llm, system, retryOptions: { maxRetries: 0, backoffMs: [] } });
        const head = await system.currentRevision(bookRoot);
        await expect(sync.syncManuscripts()).rejects.toThrow();
        expect(await system.currentRevision(bookRoot)).toBe(head);
        expect((await store.detectDirtyChapters()).map(d => d.chapterNumber)).toEqual([1]);
        failAudit = false;
        const reportPath = join(bookRoot, '.ops/sync_conflicts.json');
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('提交中断'));
        await expect(sync.syncManuscripts()).rejects.toThrow('提交中断');
        await expect(stat(reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await system.currentRevision(bookRoot)).toBe(head);
        // 报告发布失败，但指纹已提交：重启补发，不再调用模型。
        await mkdir(reportPath);
        await expect(sync.syncManuscripts()).rejects.toThrow();
        expect(await system.currentRevision(bookRoot)).not.toBe(head);
        const completedBatches = auditBatches;
        await rm(reportPath, { recursive: true });
        const restarted = new SyncPipeline({ store: new BookStore(bookRoot, system), llm, system });
        await restarted.syncManuscripts();
        expect(auditBatches).toBe(completedBatches);
        const replayed = JSON.parse(await readFile(reportPath, 'utf8'));
        expect(replayed.conflicts).toHaveLength(1);
        // 再次手改，正常入口返回验真的冲突明细。
        await writeFile(join(bookRoot, 'manuscripts/ch_0001.md'), '# 第一章 码头重修\n\n沈默左臂缠着厚夹板，完全无法抬举。\n');
        const res = await sync.syncManuscripts();

        expect(auditBatches).toBeGreaterThanOrEqual(2);
        expect(res.status).toBe('DOWNSTREAM_CONFLICTS_FOUND');
        expect(res.downstreamConflicts).toHaveLength(1);
        expect(res.downstreamConflicts[0]).toMatchObject({
            chapterNumber: 3,
            dirtyChapter: 1,
            dirtyLineNumber: 3,
            lineNumber: 3,
            quote: '沈默左手举起铁水壶',
            dirtyQuote: '沈默左臂缠着厚夹板完全无法抬举'
        });

        // 零篡改下游手稿
        expect(await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8')).toBe(ch2Before);
        expect(await readFile(join(bookRoot, 'manuscripts/ch_0003.md'), 'utf8')).toBe(ch3Before);

        // 实锤冲突写入 .ops/sync_conflicts.json
        const persisted = JSON.parse(
            await readFile(join(bookRoot, '.ops/sync_conflicts.json'), 'utf8')
        ) as { conflicts: unknown[] };
        expect(persisted.conflicts).toHaveLength(1);
    });

    it('SyncPipeline 支持注入 RoleRunner("extractor") 走 yield_state_patch 提交最新章状态', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-rolerunner', {
            storyDay: 1,
            currentChapter: 1,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n沈默检查货栈。\n'
            }
        });

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        cleanups.push(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        cleanups.push(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        cleanups.push(() => storeFiber.dispose());
        const toolsPluginFiber = await ctx.plugin(bookToolsPlugin);
        cleanups.push(() => toolsPluginFiber.dispose());

        let extractorAgentCalled = false;
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_state_patch')) {
                    extractorAgentCalled = true;
                    await execTool('yield_state_patch', {
                        entity_patches: [
                            {
                                entity_id: 'char_001',
                                last_seen_ch: 1,
                                acquired_state_ops: [
                                    {
                                        op: 'upsert_slot',
                                        slot_key: 'location',
                                        entry: {
                                            storyDay: 1,
                                            chapter: 1,
                                            visibility: 'PUBLIC',
                                            text: '驻留节点：四号旧仓库'
                                        }
                                    }
                                ]
                            }
                        ],
                        story_day_delta: 0,
                        plot_summary: '沈默前往四号旧仓库检查。',
                        prose_anchors: ['四号旧仓库'],
                        appeared_entity_ids: ['char_001'],
                        next_chapter_options: ['继续盘点']
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        await writeFile(
            join(bookRoot, 'manuscripts/ch_0001.md'),
            '# 第一章 码头\n\n沈默转往四号旧仓库检查。\n',
            'utf8'
        );

        const poolRouting = {
            strong_creative: { provider: 'mock', model: 'mock-strong' },
            fast_retrieval: { provider: 'mock', model: 'mock-fast' },
            audit: { provider: 'mock', model: 'mock-audit' }
        };
        const roleLoader = new RoleLoader(
            fileURLToPath(new URL('../../../../presets/dsh-preset-narrateos', import.meta.url))
        );
        const llmAdapter = new DshLlmAdapter(ctx.llm, { poolRouting });
        const roleRunner = new RoleRunner({
            ctx,
            storeService: ctx.narrateStore,
            toolsService: ctx.narrateTools,
            roleLoader,
            llmAdapter,
            poolRouting
        });

        const { llm } = createMockLlmPort(() =>
            JSON.stringify({
                is_prose_polish_only: false,
                reason: '地点迁移',
                affected_entity_ids: ['char_001']
            })
        );
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const sync = new SyncPipeline({ store, llm, system, roleRunner });

        const res = await sync.syncManuscripts();
        expect(extractorAgentCalled).toBe(true);
        expect(res.status).toBe('STATE_SYNCED');
        expect(res.updatedEntities).toContain('char_001');
        expect(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8')).toContain('四号旧仓库');
    });

    it('换卷先编译完整伏笔，再原样封存已结条目并按新卷因果与持有状态归档角色和道具', async () => {
        const entity = (id: string, name: string, state = '', aliases: string[] = []) => [
            '---', `entity_id: ${id}`, `canonical_name: ${name}`,
            `unique_aliases: ${JSON.stringify(aliases)}`, 'contextual_titles: []',
            'historical_anchors: []', 'last_seen_ch: 8', '---',
            '## 1. Innate Locks', '- [vis: PUBLIC] 旧伤未愈',
            '## 2. Acquired State & Numeric Ledger', state,
            '## 3. Irreversible Trajectory', '- [day:0 | ch:1] 永久离开旧港',
            '## 4. Recent Sliding Buffer & Voice', ''
        ].join('\n');
        const root = await createGitBookWorkspace(tempDirs, 'vol-causal-archive', {
            currentChapter: 10,
            extraEntities: {
                char_thread: entity('char_thread', '旧账房', '', ['账房先生']),
                char_future: entity('char_future', '新船长'),
                char_gone: entity('char_gone', '旧舵工'),
                char_warped: entity('char_warped', '旧报人'),
                char_prefix: entity('char_prefix', '旧守卫'),
                char_ambig: entity('char_ambig', '李掌柜', '', ['掌柜先生']),
                char_one: entity('char_one', '王'),
                item_comp: entity('item_comp', '伴随印章'),
                item_cold: entity('item_cold', '旧包裹', '- [status: ACTIVE] char_other 随身持有'),
                item_held: entity('item_held', '随身钥匙', '- [status: ACTIVE] char_002 随身持有'),
                item_old: entity('item_old', '旧钥匙', '- [status: WARPED] char_002 曾随身持有'),
                item_orphan: entity('item_orphan', '旧账簿'),
                item_future: entity('item_future', '新船票')
            }
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(root, system);
        const world = await store.readWorldState();
        world.frontmatter.current_volume = 10;
        await store.writeWorldState(world);
        await writeFile(join(root, 'entities/cold_archive/char_other.md'), entity('char_other', '陈掌柜', '', ['掌柜先生']));
        const resolved = '- [thread_done | status: RESOLVED | ch:10] char_gone 的旧案已结\n  关键证词原样留存。\n> 同一条目的补充引文。\n\n';
        const active = '- [thread_open | status: ACTIVE] 账房先生仍欠一份口供\n';
        const threads = `# 伏笔\n\n## 活跃\n${resolved}${active}\n## 已回收伏笔归档\n`;
        await writeFile(join(root, 'world/open_threads.md'), threads);
        await system.commitPaths(root, ['world/world_state.md', 'world/open_threads.md', 'entities/cold_archive/char_other.md'], 'test: prepare causal archive');
        const { llm, requests } = createMockLlmPort((req) => {
            if (req.traceStage === 'volume.seal') {
                return JSON.stringify({ volume_summary: '旧港清账。', story_day_span: '0 ~ 10' });
            }
            return JSON.stringify({
                current_arc_envelope: '# 新港\n新船开始进港。',
                arc_director_plan: '# 新卷计划\n逐步公开新港冲突。',
                future_horizon: [
                    '# 新卷未来事件',
                    '- [status: ACTIVE] 新船长持 item_future 登船，前提：新航线开放。',
                    '- [status: ACTIVE] char_prefix_suffix 与掌柜先生商议王朝旧账。',
                    '- [status: WARPED] 旧报人原定进港。',
                    '  char_gone 原定同行。',
                    '## Archived WARPED',
                    '### 旧船计划',
                    '- char_prefix 与 item_orphan 已退场。'
                ].join('\n')
            });
        });
        const result = await new VolumePipeline({ store, system, llm }).advanceVolume({ companionEntityIds: ['char_002', 'item_comp', 'char_other'] });
        for (const stage of ['volume.seal', 'volume.envelope']) {
            expect(requests.find((req) => req.traceStage === stage)?.dynamicTail).toContain(threads);
        }
        const remaining = await readFile(join(root, 'world/open_threads.md'), 'utf8');
        expect(remaining).toContain(active);
        expect(remaining).not.toContain('thread_done');
        expect(remaining).not.toContain('关键证词');
        expect(await readFile(join(root, 'index/L1_volumes.md'), 'utf8')).toContain(resolved);
        expect(await readFile(join(root, 'index/L0_sagas.md'), 'utf8')).toContain('关键证词原样留存');
        expect(result.archivedEntities).toEqual(['char_ambig', 'char_gone', 'char_one', 'char_prefix', 'char_warped', 'item_cold', 'item_old', 'item_orphan']);
        const snapshot = await store.loadSnapshot();
        for (const id of ['char_001', 'char_002', 'char_thread', 'char_future', 'item_comp', 'item_held', 'item_future']) {
            expect(snapshot.entities[id]?.metadata.entity_id).toBe(id);
        }
        expect(await readFile(join(root, 'entities/cold_archive/char_gone.md'), 'utf8')).toBe(entity('char_gone', '旧舵工'));
        expect(await system.readFileAtRef(root, result.commitSha, 'world/open_threads.md')).toBe(remaining);
    });

    it('VolumePipeline 废除 git add .、先提交后打 Tag、注入 author_charter 拆离导演计划并折叠 L0_sagas.md', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'vol-advance-isolation', {
            storyDay: 20,
            currentChapter: 10
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        // 设为第 10 卷触发 10 卷纪元折叠，且配置风格修订合并
        const ws = await store.readWorldState();
        ws.frontmatter.current_volume = 10;
        await store.writeWorldState(ws);
        await writeFile(
            join(bookRoot, 'index/L1_volumes.md'),
            '# L1 活跃卷级总表\n\n## 第 9 卷封存摘要 (vol_09) [story_day: day 10 ~ day 15]\n第九卷收束旧港。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/ops_style_amendments.md'),
            '# 卷中风格修订 (Ops Style Amendments)\n\n- 多用冷硬码头器物白描。\n',
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: setup vol 10']);

        // 刻意制造未跟踪运行态垃圾文件（无 .gitignore 时若执行 git add . 必污染提交）
        await mkdir(join(bookRoot, '.ops/session_logs'), { recursive: true });
        await writeFile(join(bookRoot, '.ops/session_logs/secret.json'), '{"secret":true}\n', 'utf8');
        await writeFile(join(bookRoot, '.ops/runs.jsonl'), '{"runId":"r1"}\n', 'utf8');

        const commitCalls: string[][] = [];
        const spySystem: SystemPort = {
            initRepo: (r) => system.initRepo(r),
            commitPaths: async (r, paths, msg) => {
                commitCalls.push(paths);
                return await system.commitPaths(r, paths, msg);
            },
            createTag: (r, t, m) => system.createTag(r, t, m),
            readFileAtRef: (r, ref, p) => system.readFileAtRef(r, ref, p),
            diffFile: (r, a, b, p) => system.diffFile(r, a, b, p),
            resetHard: (r, ref) => system.resetHard(r, ref),
            cleanUntracked: (r, ex) => system.cleanUntracked(r, ex),
            restorePaths: (r, p) => system.restorePaths(r, p),
            currentRevision: (r, ref) => system.currentRevision(r, ref),
            isWorkingTreeClean: (r) => system.isWorkingTreeClean(r),
            ripgrepSearch: (r, pat, f, c) => system.ripgrepSearch(r, pat, f, c)
        };

        let envelopePromptSawCharter = false;
        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'volume.seal') {
                return JSON.stringify({
                    volume_summary: '第十卷彻底封锁旧港暗道。',
                    story_day_span: 'day 16 ~ day 20'
                });
            }
            if (req.traceStage === 'volume.style') {
                return JSON.stringify({
                    merged_markdown: '# 世界静态基线与文风纪律\n\n- 写实海港物流背景。\n- 多用冷硬码头器物白描。'
                });
            }
            if (req.traceStage === 'volume.envelope') {
                envelopePromptSawCharter = req.dynamicTail.includes('CHARTER_SECRET_ANCHOR');
                return JSON.stringify({
                    current_arc_envelope: [
                        '# 第 11 卷正向舞台',
                        '',
                        '远洋航道全面戒严，新旧船行围绕泊位配额展开正面交锋。',
                        '',
                        '## Stage Ceiling 阶段天花板',
                        '严禁第 11 卷揭露沉船保险金黑幕。',
                        '- [vis: OMNISCIENT_SECRET] 幕后指使者为副署长'
                    ].join('\n'),
                    arc_director_plan: [
                        '# 第 11 卷导演禁区与节拍计划',
                        '',
                        '## Stage Ceiling',
                        '本卷不得揭破副署长与沉船保险金关系。',
                        '',
                        '## Opening Sequence Beats',
                        '- [status: PENDING] Beat 1: 新泊位配额公告落地'
                    ].join('\n'),
                    future_horizon: '# 第 11 卷未来惯性\n\n- [event:evt_v11 | day:21 | status:ACTIVE] 外海雾季开始'
                });
            }
            return '{}';
        });

        const pipeline = new VolumePipeline({ store, llm, system: spySystem });
        const volRes = await pipeline.advanceVolume({ companionEntityIds: [] });

        expect(envelopePromptSawCharter).toBe(true);
        expect(volRes.sealedVolume).toBe(10);
        expect(volRes.nextVolume).toBe(11);
        expect(volRes.tagName).toBe('arc-seal-vol-10');
        expect(volRes.archivedEntities).toEqual(['char_002']);

        // 1. 绝不调用 git add . 且提交中不含 .ops/ 运行态垃圾
        expect(commitCalls).toHaveLength(1);
        expect(commitCalls[0]).not.toContain('.');
        expect(commitCalls[0]?.some((p) => p.includes('.ops/session_logs') || p.includes('.ops/tx.lock'))).toBe(false);

        const { stdout: committedFiles } = await execFileAsync('git', [
            '-C',
            bookRoot,
            'show',
            '--name-only',
            '--pretty=format:',
            volRes.commitSha
        ]);
        expect(committedFiles).not.toContain('.ops/session_logs');
        expect(committedFiles).not.toContain('.ops/runs.jsonl');
        expect(committedFiles).not.toContain('.ops/tx.lock');

        // 2. Tag 指向真实的换卷提交 commitSha
        const { stdout: tagCommit } = await execFileAsync('git', [
            '-C',
            bookRoot,
            'rev-parse',
            `${volRes.tagName}^{commit}`
        ]);
        expect(tagCommit.trim()).toBe(volRes.commitSha);

        // 3. 写手可见包络与导演计划物理拆离，且整块兜底剥离禁区/多行机密/独立禁令句
        const envelopeOnDisk = await readFile(join(bookRoot, 'world/current_arc_envelope.md'), 'utf8');
        expect(envelopeOnDisk).toContain('远洋航道全面戒严');
        expect(envelopeOnDisk).not.toContain('Stage Ceiling');
        expect(envelopeOnDisk).not.toContain('OMNISCIENT_SECRET');

        const directorOnDisk = await readFile(join(bookRoot, 'world/arc_director_plan.md'), 'utf8');
        expect(directorOnDisk).toContain('Stage Ceiling');
        expect(directorOnDisk).toContain('Beat 1: 新泊位配额公告落地');

        // 4. 风格修订合并后已清空
        const styleAfter = await readFile(join(bookRoot, 'world/ops_style_amendments.md'), 'utf8');
        expect(styleAfter.trim()).toBe('# 卷中风格修订 (Ops Style Amendments)');

        // 5. 冷宫归档保持单文件迁移（不生成 *_saga_XX.md）
        await expect(stat(join(bookRoot, 'entities/cold_archive/char_002.md'))).resolves.toBeTruthy();
        await expect(stat(join(bookRoot, 'entities/char_002.md'))).rejects.toThrow();

        // 6. 满 10 卷折叠追加 index/L0_sagas.md
        const l0OnDisk = await readFile(join(bookRoot, 'index/L0_sagas.md'), 'utf8');
        expect(l0OnDisk).toContain('第 1 纪元封存摘要 (vol_01 - vol_10)');
        expect(l0OnDisk).toContain('第十卷彻底封锁旧港暗道');
        expect(l0OnDisk).toContain('保留活跃伏笔：1 条');
    });

    it('VolumePipeline 在风格修订精简仍超出 static_base_max_chars 时报错拒绝而非暴力硬截断', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'vol-style-overflow', {
            storyDay: 3,
            currentChapter: 2
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const cfg = await store.readBookConfig();
        cfg.context_assembly = {
            ...cfg.context_assembly,
            static_base_max_chars: 50
        };
        await store.writeBookConfig(cfg);
        await writeFile(
            join(bookRoot, 'world/ops_style_amendments.md'),
            '# 卷中风格修订 (Ops Style Amendments)\n\n- 风格修订一条。\n',
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: set small static base max']);

        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'volume.seal') {
                return JSON.stringify({ volume_summary: '收束。', story_day_span: 'day 1 ~ 3' });
            }
            if (req.traceStage === 'volume.style' || req.traceStage === 'volume.style_condense') {
                return JSON.stringify({
                    merged_markdown: '这是一段超过五十个字符限制的文风规则内容，必须拒绝写入而不是暴力截断成残句。'.repeat(2)
                });
            }
            return '{}';
        });

        const pipeline = new VolumePipeline({ store, llm, system });
        await expect(pipeline.advanceVolume()).rejects.toThrow(/超过上限 50 字/);
    });

    it('VolumePipeline 在 completeBook=true 时标定 OPEN_ENDING、折叠 L0_sagas.md 并在提交后打 novel-completed 标签', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'vol-complete-book', {
            storyDay: 12,
            currentChapter: 5
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'volume.seal') {
                return JSON.stringify({
                    volume_summary: '第一卷终局落幕，码头真相大白。',
                    story_day_span: 'day 0 ~ day 12'
                });
            }
            return '{}';
        });

        const pipeline = new VolumePipeline({ store, llm, system });
        const res = await pipeline.advanceVolume({ completeBook: true });

        expect(res.completedBook).toBe(true);
        expect(res.sealedVolume).toBe(1);
        expect(res.nextVolume).toBe(1);

        const threadsAfter = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
        expect(threadsAfter).toContain('OPEN_ENDING');

        const l0OnDisk = await readFile(join(bookRoot, 'index/L0_sagas.md'), 'utf8');
        expect(l0OnDisk).toContain('[完结收官]');
        expect(l0OnDisk).toContain('第一卷终局落幕，码头真相大白。');

        const { stdout: completedTagCommit } = await execFileAsync('git', [
            '-C',
            bookRoot,
            'rev-parse',
            'novel-completed^{commit}'
        ]);
        expect(completedTagCommit.trim()).toBe(res.commitSha);
    });

    it('SyncPipeline 同时修改最新章 ch_0002 并顺次新增 ch_0003 时全量提交手稿、按序演进实体状态且仅产生 1 笔 Git 提交', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-head-plus-next', {
            storyDay: 2,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n沈默检查旧灯。\n',
                'ch_0002.md': '# 第二章 泊位\n\n沈默巡视二号泊位。\n'
            }
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        const { stdout: countBefore } = await execFileAsync('git', [
            '-C',
            bookRoot,
            'rev-list',
            '--count',
            'HEAD'
        ]);

        // 同时手改第 2 章（最新章）并顺次新建第 3 章（UNTRACKED）
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '# 第二章 泊位\n\n沈默从暗格取出铜钥匙，进驻二号泊位值班室。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0003.md'),
            '# 第三章 暗仓\n\n沈默持铜钥匙开启三号暗仓。\n',
            'utf8'
        );

        let extractorCallIdx = 0;
        let ch3SawCh2State = false;
        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'sync.classify') {
                return JSON.stringify({
                    is_prose_polish_only: false,
                    reason: '新增驻留二号泊位值班室与取出铜钥匙',
                    affected_entity_ids: ['char_001']
                });
            }
            if (req.traceStage === 'sync.extractor') {
                extractorCallIdx += 1;
                if (extractorCallIdx === 1) {
                    return JSON.stringify({
                        entity_patches: [
                            {
                                entity_id: 'char_001',
                                last_seen_ch: 2,
                                acquired_state_ops: [
                                    {
                                        op: 'upsert_slot',
                                        slot_key: 'location',
                                        entry: {
                                            storyDay: 3,
                                            chapter: 2,
                                            visibility: 'PUBLIC',
                                            text: '驻留节点：二号泊位值班室'
                                        }
                                    }
                                ]
                            }
                        ],
                        story_day_delta: 1,
                        plot_summary: '沈默进驻二号泊位值班室。',
                        prose_anchors: ['二号泊位值班室'],
                        appeared_entity_ids: ['char_001'],
                        next_chapter_options: ['开启暗仓']
                    });
                }
                ch3SawCh2State = req.dynamicTail.includes('二号泊位值班室');
                return JSON.stringify({
                    entity_patches: [
                        {
                            entity_id: 'char_001',
                            last_seen_ch: 3,
                            acquired_state_ops: [
                                {
                                    op: 'upsert_slot',
                                    slot_key: 'location',
                                    entry: {
                                        storyDay: 4,
                                        chapter: 3,
                                        visibility: 'PUBLIC',
                                        text: '驻留节点：三号暗仓'
                                    }
                                }
                            ]
                        }
                    ],
                    story_day_delta: 1,
                    plot_summary: '沈默进入三号暗仓。',
                    prose_anchors: ['三号暗仓'],
                    appeared_entity_ids: ['char_001'],
                    next_chapter_options: ['清点箱笼']
                });
            }
            return '{}';
        });

        const sync = new SyncPipeline({ store, llm, system });
        const authorPaths = ['manuscripts/ch_0002.md', 'manuscripts/ch_0003.md'];
        const manuscripts = () => Promise.all(authorPaths.map(path => readFile(join(bookRoot, path), 'utf8')));
        const authorInputs = await manuscripts();
        vi.spyOn(system, 'commitPaths').mockRejectedValueOnce(new Error('提交中断'));
        await expect(sync.syncManuscripts()).rejects.toThrow('提交中断');
        await store.recoverWal();
        expect(await manuscripts()).toEqual(authorInputs);
        extractorCallIdx = 0;
        const res = await sync.syncManuscripts();

        expect(res.status).toBe('STATE_SYNCED');
        expect(ch3SawCh2State).toBe(true);

        // 仅产生 1 笔 Git 提交，且 ch_0002 与 ch_0003 均已干净提交
        const { stdout: countAfter } = await execFileAsync('git', [
            '-C',
            bookRoot,
            'rev-list',
            '--count',
            'HEAD'
        ]);
        expect(Number(countAfter.trim()) - Number(countBefore.trim())).toBe(1);
        expect(await store.detectDirtyChapters()).toEqual([]);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);

        const wsAfter = await store.readWorldState();
        expect(wsAfter.frontmatter.current_chapter).toBe(3);
        expect(wsAfter.frontmatter.story_day).toBe(4);
        expect(await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8')).toContain('三号暗仓');

        // 再次验证：当最新章为纯润色且同时顺次新增下一章时，ch_0003 润色稿也不漏出提交列表
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0003.md'),
            '# 第三章 暗仓\n\n幽暗灯影下，沈默持铜钥匙开启三号暗仓。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0004.md'),
            '# 第四章 账箱\n\n沈默打开铁皮账箱。\n',
            'utf8'
        );
        const { llm: llmPolishPlusNew } = createMockLlmPort((req) => {
            if (req.traceStage === 'sync.classify') {
                return JSON.stringify({
                    is_prose_polish_only: true,
                    reason: '仅增加环境光影修饰',
                    affected_entity_ids: []
                });
            }
            if (req.traceStage === 'sync.extractor') {
                return JSON.stringify({
                    entity_patches: [],
                    story_day_delta: 0,
                    plot_summary: '沈默打开铁皮账箱。',
                    prose_anchors: ['铁皮账箱'],
                    appeared_entity_ids: ['char_001'],
                    next_chapter_options: ['继续核对']
                });
            }
            return '{}';
        });
        const sync2 = new SyncPipeline({ store, llm: llmPolishPlusNew, system });
        const res2 = await sync2.syncManuscripts();
        expect(res2.status).toBe('STATE_SYNCED');
        expect(await store.detectDirtyChapters()).toEqual([]);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('SyncPipeline 在外键校验失败抛错时保持 0 Git 提交、0 L2 脏写且 tx_state 相位不被污染', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-fk-atomic-abort', {
            storyDay: 2,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n沈默查账。\n',
                'ch_0002.md': '# 第二章 夜雨\n\n沈默回房。\n'
            }
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const { stdout: headBefore } = await execFileAsync('git', ['-C', bookRoot, 'rev-parse', 'HEAD']);
        const l2Before = await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8');
        const txBefore = await store.readTxState();

        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '# 第二章 夜雨\n\n沈默收到不明密信。\n',
            'utf8'
        );

        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'sync.classify') {
                return JSON.stringify({
                    is_prose_polish_only: false,
                    reason: '新增关键密信外键',
                    affected_entity_ids: ['char_001']
                });
            }
            if (req.traceStage === 'sync.extractor') {
                return JSON.stringify({
                    entity_patches: [
                        {
                            entity_id: 'char_001',
                            acquired_state_ops: [
                                {
                                    op: 'upsert_slot',
                                    slot_key: 'clue',
                                    entry: {
                                        storyDay: 2,
                                        chapter: 2,
                                        visibility: 'PUBLIC',
                                        text: '持有不存在道具 item_ghost_999'
                                    }
                                }
                            ]
                        }
                    ],
                    story_day_delta: 0,
                    plot_summary: '沈默收到密信。',
                    prose_anchors: ['不明密信'],
                    appeared_entity_ids: ['char_001'],
                    next_chapter_options: ['拆信']
                });
            }
            return '{}';
        });

        const sync = new SyncPipeline({ store, llm, system });
        await expect(sync.syncManuscripts()).rejects.toThrow(/外键可达性校验失败/);

        const { stdout: headAfter } = await execFileAsync('git', ['-C', bookRoot, 'rev-parse', 'HEAD']);
        expect(headAfter.trim()).toBe(headBefore.trim());
        expect(await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8')).toBe(l2Before);
        const txAfter = await store.readTxState();
        expect(txAfter.phase).toBe(txBefore.phase);
        await expect(stat(join(bookRoot, '.ops/pending_writes.json'))).rejects.toThrow();
    });

    it('SyncPipeline 下游冲突扫描可召回已归入 entities/cold_archive/ 的历史角色', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-cold-archive-recall', {
            storyDay: 5,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n周铁匠在铁铺打制船锚。\n',
                'ch_0002.md': '# 第二章 港口\n\n沈默看见周铁匠右手握着断柄铁锤。\n'
            }
        });
        await writeFile(
            join(bookRoot, 'entities/cold_archive/char_zhou.md'),
            [
                '---',
                'entity_id: char_zhou',
                'canonical_name: 周铁匠',
                'unique_aliases: ["老周"]',
                'contextual_titles: []',
                'historical_anchors: []',
                'last_seen_ch: 1',
                '---',
                '',
                '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
                '- [vis: PUBLIC] 右肩有旧伤',
                '',
                '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级更新)',
                '',
                '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
                '',
                '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)'
            ].join('\n') + '\n',
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: add cold archived char_zhou']);

        // 手改第 1 章：周铁匠十年前右臂已齐肩截肢（但第 1 章正文仅写"周铁匠"，未写 char_001 沈默）
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0001.md'),
            '# 第一章 码头\n\n周铁匠早已失去整条右臂，只能靠左手打铁。\n',
            'utf8'
        );

        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);
        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'sync.history_extractor') {
                return JSON.stringify({
                    entity_patches: [],
                    story_day_delta: 0,
                    plot_summary: '周铁匠失去右臂左手打铁。',
                    prose_anchors: ['失去整条右臂'],
                    appeared_entity_ids: ['char_zhou'],
                    next_chapter_options: []
                });
            }
            if (req.traceStage === 'sync.audit') {
                expect(req.dynamicTail).toContain('ch_0002');
                return JSON.stringify({
                    conflicts: [
                        {
                            dirty_chapter: 1,
                            dirty_quote: '周铁匠早已失去整条右臂',
                            chapter_number: 2,
                            line_number: 3,
                            quote: '沈默看见周铁匠右手握着断柄铁锤',
                            description: '第 1 章已无右臂，第 2 章右手握铁锤冲突'
                        }
                    ]
                });
            }
            return '{}';
        });

        const sync = new SyncPipeline({ store, llm, system });
        const res = await sync.syncManuscripts();
        expect(res.status).toBe('DOWNSTREAM_CONFLICTS_FOUND');
        expect(res.downstreamConflicts).toHaveLength(1);
        expect(res.downstreamConflicts[0]?.chapterNumber).toBe(2);
    });

    it('VolumePipeline 拒绝在 DRAFTING / FEAT_COMMITTED 半章相位换卷，且整块剥离多行机密续行与独立否定禁令句', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'vol-phase-and-block-strip', {
            storyDay: 4,
            currentChapter: 2
        });
        const system = new NodeSystemAdapter();
        const store = new BookStore(bookRoot, system);

        // 1. DRAFTING 相位拒绝换卷
        await store.beginDraft(3);
        const { llm } = createMockLlmPort((req) => {
            if (req.traceStage === 'volume.seal') {
                return JSON.stringify({ volume_summary: '第 1 卷收束。', story_day_span: 'day 0 ~ 4' });
            }
            if (req.traceStage === 'volume.envelope') {
                return JSON.stringify({
                    current_arc_envelope: [
                        '# 第 2 卷正向舞台',
                        '',
                        '港务大厅重新开放夜间竞标，各船行围绕新航线正面博弈。',
                        '',
                        '- [vis: OMNISCIENT_SECRET] 隐藏幕后真相首行：',
                        '  SECRET_INDENTED_CONT: 副署长十年前伪造了沉船保单。',
                        '> SECRET_QUOTE_CONT: 船长至今不知真凶正是副署长。',
                        '',
                        '- 严禁在本卷中段提前让主角查出保单原件。',
                        '  PROHIBITION_INDENTED_CONT: 必须压到终局卷才允许翻盘。',
                        '',
                        '独立段落包含不得向主角透露幕后交易的禁令提示。',
                        '',
                        '- 保留的安全正向场景：码头钟楼正午鸣笛。'
                    ].join('\n'),
                    arc_director_plan: '# 第 2 卷导演计划\n\nStage Ceiling: 保持悬念。',
                    future_horizon: '# 第 2 卷惯性\n\n- [event:evt_bid | day:5 | status:ACTIVE] 竞标会开幕'
                });
            }
            return '{}';
        });

        const pipeline = new VolumePipeline({ store, llm, system });
        await expect(pipeline.advanceVolume()).rejects.toThrow(/DRAFTING/);

        // 2. 恢复至 STATE_COMMITTED 后验证块级剥离完整移除多行机密续行与独立禁令句
        await store.recoverWal();
        const res = await pipeline.advanceVolume();
        expect(res.nextVolume).toBe(2);

        const envelope = await readFile(join(bookRoot, 'world/current_arc_envelope.md'), 'utf8');
        expect(envelope).toContain('港务大厅重新开放夜间竞标');
        expect(envelope).toContain('码头钟楼正午鸣笛');
        expect(envelope).not.toContain('OMNISCIENT_SECRET');
        expect(envelope).not.toContain('SECRET_INDENTED_CONT');
        expect(envelope).not.toContain('SECRET_QUOTE_CONT');
        expect(envelope).not.toContain('PROHIBITION_INDENTED_CONT');
        expect(envelope).not.toContain('严禁');
        expect(envelope).not.toContain('不得');
    });
});

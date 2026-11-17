import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import { TxLockConflictError } from '@narrateos/dsh-book-store';
import * as bookToolsPlugin from '@narrateos/dsh-book-tools';
import { afterEach, describe, expect, it } from 'vitest';
import * as pipelinePlugin from './index.js';
import { DshLlmAdapter } from './runner/dsh-llm-adapter.js';
import {
    createGitBookWorkspace,
    createHeadlessMockServices,
    textToStreamChunks
} from './test-harness.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void> | void> = [];

function registerCleanup(fn: () => Promise<void> | void): void {
    cleanupCallbacks.push(fn);
}

afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
        const fn = cleanupCallbacks.pop();
        if (fn) {
            try {
                await fn();
            } catch {
                // 清理期容错
            }
        }
    }
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('Phase 3 无头 Cordis 宿主多智能体管线与配置热覆盖集成测试', () => {
    it('单书 world/roles/planner.yml 与 prompts/planner.md 覆盖无需重新编译即刻生效并限制只读配额', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'role-override');

        await mkdir(join(bookRoot, 'world/roles/prompts'), { recursive: true });
        await writeFile(
            join(bookRoot, 'world/roles/prompts/planner.md'),
            '# 单书定制 Planner 提示词\n\nBOOK_OVERRIDE_PROMPT_MARKER: 专注写实海港调度逻辑。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/roles/planner.yml'),
            [
                'id: planner',
                'pool: strong_creative',
                'cleanroom: false',
                'promptFile: ./prompts/planner.md',
                'temperature: 0.4',
                'reasoningEffort: high',
                'maxSteps: 6',
                'maxReadCalls: 1',
                'tools:',
                '    - book_read',
                'yieldTool: yield_outline'
            ].join('\n') + '\n',
            'utf8'
        );

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let plannerQuotaExceededError: unknown = null;
        const { agentRuns } = await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    // 第 1 次读取放行，第 2 次读取应被单书 maxReadCalls=1 确定性拦截
                    await execTool('book_read', { path: 'world/world_state.md' });
                    try {
                        await execTool('book_read', { path: 'entities/char_001.md' });
                    } catch (err) {
                        plannerQuotaExceededError = err;
                    }
                    await execTool('yield_outline', {
                        chapter_title: '潮汐账簿',
                        target_word_count: 2200,
                        focus_cast: ['char_001'],
                        background_cast: ['char_002'],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛：海关黑幕将在后续揭开，本章仅埋旧账。',
                        chapter_turn: '沈默核对页码时发现潮汐表少了一栏签章。',
                        scene_plan: [
                            {
                                scene_index: 1,
                                location: '三号码头旧货栈',
                                summary: '沈默提灯核对账册并发现撕页痕迹',
                                is_spotlight: true
                            }
                        ],
                        outline_text: '沈默站在货栈账桌前，指尖停在缺失的骑缝章位置。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '沈默核对三号码头账簿发现缺页。',
                        next_chapter_options: ['追查撕页去向', '盘问值班舵工']
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks(
                    '<blocking>三号码头货栈西门内，沈默立于账桌旁。</blocking>\n\n海风穿过货栈木窗，吹动桌面发黄的账页。沈默把煤油灯往左挪了半寸，指腹顺着骑缝编号一路往下滑，停在缺页的折痕上。'
                )
        });

        // 无 webServer / commands / skills 的无头宿主直接加载 pipeline 插件
        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const res = await ctx.narratePipeline.stepChapter({
            chapterGoal: '查验三号码头夜间货单'
        });

        expect(res.status).toBe('COMMITTED');
        expect(plannerQuotaExceededError).toBeInstanceOf(Error);
        expect(String(plannerQuotaExceededError)).toContain('只读调用配额上限 (1');

        const plannerRun = agentRuns.find((r) => r.toolNames.includes('yield_outline'));
        expect(plannerRun).toBeDefined();
        expect(plannerRun?.systemPromptText).toContain('BOOK_OVERRIDE_PROMPT_MARKER');
        expect(plannerRun?.temperature).toBe(0.4);
        expect(plannerRun?.toolNames).toEqual(['book_read', 'yield_outline']);
    });

    it('无头宿主完整跑通 6 阶段 stepChapter（含 Gate Patch、PLAN_CONFLICT 重排 v2、写手净室隔离、.ops/runs.jsonl 与 Voice Harvest）', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'full-6stage', {
            extraEntities: {
                item_001: [
                    '---',
                    'entity_id: item_001',
                    'canonical_name: 黄铜钥匙',
                    'unique_aliases: ["旧铜钥匙"]',
                    'contextual_titles: []',
                    'historical_anchors: ["ch_0001:铁门锁眼旁"]',
                    'last_seen_ch: 1',
                    '---',
                    '',
                    '## 1. Innate Locks',
                    '- [vis: PUBLIC] 齿口刻有04号船坞钢印',
                    '',
                    '## 2. Acquired State & Numeric Ledger',
                    '- [day:0 | ch:1 | vis: PUBLIC] 位于货栈抽屉内',
                    '',
                    '## 3. Irreversible Trajectory',
                    '- [day:0 | ch:1] 首度现身',
                    '',
                    '## 4. Recent Sliding Buffer & Voice',
                    '- [day:0 | ch:1] 表面有盐渍'
                ].join('\n')
            }
        });

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let plannerCallCount = 0;
        let writerCallCount = 0;
        let factCheckerCallCount = 0;

        const { agentRuns, llmCalls } = await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001', 'char_002'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }

                if (tools.has('yield_outline')) {
                    plannerCallCount += 1;
                    await execTool('yield_outline', {
                        chapter_title: plannerCallCount === 1 ? '旧账初探' : '旧账重查',
                        target_word_count: 2400,
                        focus_cast: ['char_001'],
                        background_cast: ['char_002'],
                        ending_beat: 'HOOK',
                        director_rationale:
                            'DIRECTOR_RATIONALE_HIDDEN: 幕后海关黑幕与沈默兄长线索暂不挑明。',
                        chapter_turn: '账簿第十二页的潮水记录与实际船期差了一整天。',
                        scene_plan: [
                            {
                                scene_index: 1,
                                location: '货栈西侧账房',
                                summary: '沈默核对潮汐账与船期',
                                is_spotlight: true
                            }
                        ],
                        outline_text:
                            plannerCallCount === 1
                                ? '沈默翻开潮汐账簿，目光落在十二页边缘的水渍上，转身询问小满昨晚值班登记。'
                                : '沈默按修正后的时间线在西侧账房翻检十二页账簿，确认昨晚值班记录被人改动过。'
                    });
                    return;
                }

                if (tools.has('yield_verdict')) {
                    factCheckerCallCount += 1;
                    if (factCheckerCallCount === 1) {
                        // 首轮核查返回 PLAN_CONFLICT，触发 Planner v2 重排
                        await execTool('yield_verdict', {
                            passed: false,
                            issues: [
                                {
                                    severity: 'PLAN_CONFLICT',
                                    paragraph_index: 0,
                                    description: '时间线与潮汐登记班次存在因果冲突，需重排细纲',
                                    quote_draft: '沈默翻开厚重的潮汐账册，指腹在十二页停住。'
                                }
                            ]
                        });
                    } else {
                        await execTool('yield_verdict', { passed: true, issues: [] });
                    }
                    return;
                }

                if (tools.has('yield_state_patch')) {
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
                                            text: '驻留节点：货栈西侧账房'
                                        }
                                    }
                                ],
                                buffer_ops: [
                                    {
                                        op: 'append',
                                        entry: {
                                            storyDay: 1,
                                            chapter: 1,
                                            visibility: 'PUBLIC',
                                            text: '发现第十二页潮汐时间被涂改'
                                        }
                                    }
                                ]
                            }
                        ],
                        story_day_delta: 1,
                        chapter_summary: '沈默在货栈西侧账房核出潮汐登记涂改痕迹。',
                        next_chapter_options: ['核实二号仓库封条', '询问林小满船票来源']
                    });
                }
            },
            onLlmStream: (opts) => {
                if (opts.system?.includes('局部修补')) {
                    return textToStreamChunks(
                        '他只觉得掌心微潮，手指顺着账册边缘的红墨线划过去。'
                    );
                }
                if (opts.system?.includes('Voice Harvest')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            samples: [
                                {
                                    tag: '白描动作',
                                    text: '煤油灯焰矮了一截，灯罩内壁蒙着一层薄灰，照得桌面木纹发暗。'
                                },
                                {
                                    tag: '克制对白',
                                    text: '「账页是今早才沾的水，昨夜值班簿上可没这一笔。」'
                                },
                                {
                                    tag: '感官节奏',
                                    text: '窗外拖轮鸣了两声短笛，铁链落进水里的闷响隔着木板传进来。'
                                }
                            ]
                        })
                    );
                }
                writerCallCount += 1;
                if (writerCallCount === 1) {
                    // 第 1 次写手产出：包含 1 段触发 StaticProseGate 的套话，触发局部 Patch
                    return textToStreamChunks(
                        [
                            '<blocking>货栈西侧账房内，沈默立于木桌前，林小满在门边算盘旁。</blocking>',
                            '',
                            '沈默翻开厚重的潮汐账册，指腹在十二页停住。',
                            '',
                            '他心中涌起一股莫名的情绪，仿佛整个世界都在这一刻静止了。'
                        ].join('\n')
                    );
                }
                return textToStreamChunks(
                    [
                        '<blocking>货栈西侧账房内，沈默立于木桌前，林小满在门边算盘旁。</blocking>',
                        '',
                        '沈默翻开厚重的潮汐账册，指腹在十二页停住。',
                        '',
                        '「账页是今早才沾的水。」沈默合上铁夹，抬头看向门边的算盘。'
                    ].join('\n')
                );
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const result = await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '夜查三号码头潮汐账册'
        });

        expect(result.status).toBe('COMMITTED');
        expect(result.chapterNumber).toBe(1);
        expect(result.replanCount).toBe(1);
        expect(result.patchRounds).toBe(1);
        expect(plannerCallCount).toBe(2);
        expect(factCheckerCallCount).toBe(2);
        expect(result.featCommitSha).toBeTruthy();
        expect(result.stateCommitSha).toBeTruthy();

        // 1. 验证多轮工种以独立顶层 Session 启动（不带无父地址的 subagent origin）且记录至 .ops/runs.jsonl
        expect(agentRuns.every((r) => r.origin === undefined)).toBe(true);
        const runs = await ctx.narrateStore.openStore().listRunRecords({ chapter: 1 });
        expect(runs.some((r) => r.stage === 'LIBRARIAN' && r.status === 'completed')).toBe(true);
        expect(runs.some((r) => r.stage === 'PLANNER' && r.status === 'completed')).toBe(true);
        expect(runs.some((r) => r.stage === 'FACT_CHECKER' && r.status === 'completed')).toBe(true);
        expect(runs.some((r) => r.stage === 'EXTRACTOR' && r.status === 'completed')).toBe(true);

        // 2. 验证 Writer 净室隔离：零工具、零 sessionId、物理剥离禁区与秘密词汇
        const writerCalls = llmCalls.filter((c) => !c.options.system?.includes('局部修补'));
        expect(writerCalls.length).toBeGreaterThanOrEqual(2);
        for (const call of writerCalls) {
            expect(call.options.tools).toBeUndefined();
            expect(call.options.sessionId).toBeUndefined();
            const fullPrompt = `${call.options.system ?? ''}\n${JSON.stringify(call.options.messages)}`;
            expect(fullPrompt).not.toContain('CHARTER_SECRET_ANCHOR');
            expect(fullPrompt).not.toContain('DIRECTOR_SECRET_CEILING');
            expect(fullPrompt).not.toContain('OMNISCIENT_SECRET_TOKEN');
            expect(fullPrompt).not.toContain('WARPED_SECRET_ENTRY');
            expect(fullPrompt).not.toContain('DIRECTOR_RATIONALE_HIDDEN');
            expect(fullPrompt).not.toContain('SELF_ONLY_CHAR002_SECRET');
        }

        // 3. 验证 L2 章卡与 telemetry.jsonl 均已落盘
        const l2Card = await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8');
        expect(l2Card).toContain('## ch_0001');
        expect(l2Card).toContain('char_001');
        const telemetryRaw = await readFile(join(bookRoot, '.ops/telemetry.jsonl'), 'utf8');
        expect(telemetryRaw).toContain('"chapter":1');

        // 4. 验证首章校准 Voice Harvest 采集并入池
        const harvest = await ctx.narratePipeline.harvestVoiceFromChapter(1);
        expect(harvest.skipped).toBe(false);
        expect(harvest.harvestedCount).toBe(3);
        const voicePool = await ctx.narrateStore.openStore().readVoiceSamples();
        expect(voicePool.samples.length).toBe(3);

        // 5. 验证无残留事务锁
        await expect(stat(join(bookRoot, '.ops/tx.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('多轮 Dreaming 启动 Dreamer 多轮读写并在隔离暂存区联动更新脏实体与计划，干净实体 mtime 零变化', async () => {
        const cleanEntityMd = [
            '---',
            'entity_id: char_clean',
            'canonical_name: 周远',
            'unique_aliases: []',
            'contextual_titles: []',
            'historical_anchors: []',
            'last_seen_ch: 0',
            '---',
            '',
            '## 1. Innate Locks',
            '- [vis: PUBLIC] 左手无名指戴素银戒',
            '',
            '## 2. Acquired State & Numeric Ledger',
            '- [day:0 | ch:0 | vis: PUBLIC] 在外港轮船上值守',
            '',
            '## 3. Irreversible Trajectory',
            '- [day:0 | ch:0] 登船赴外港',
            '',
            '## 4. Recent Sliding Buffer & Voice',
            '- [day:0 | ch:0] 登记出港'
        ].join('\n');

        const dirtyEntityMd = [
            '---',
            'entity_id: char_001',
            'canonical_name: 沈默',
            'unique_aliases: ["默哥"]',
            'contextual_titles: ["验货员"]',
            'historical_anchors: []',
            'last_seen_ch: 2',
            '---',
            '',
            '## 1. Innate Locks',
            '- [vis: PUBLIC] 右手虎口有旧日缆绳勒伤浅疤',
            '',
            '## 2. Acquired State & Numeric Ledger',
            '- [day:2 | ch:2 | vis: PUBLIC] 驻留节点：二号仓库',
            '',
            '## 3. Irreversible Trajectory',
            '- [day:0 | ch:0] 接下三号码头夜班清点任务',
            '',
            '## 4. Recent Sliding Buffer & Voice',
            '- [day:1 | ch:1] 翻开潮汐账簿发现缺页',
            '- [day:1 | ch:1] 询问林小满昨夜值班情况',
            '- [day:2 | ch:2] 在二号仓库外拾到铜锁片',
            '- [day:2 | ch:2] 记下拖轮进港时刻'
        ].join('\n');

        const bookRoot = await createGitBookWorkspace(tempDirs, 'dreaming-multiturn', {
            storyDay: 2,
            currentChapter: 2,
            extraEntities: {
                char_clean: cleanEntityMd,
                char_001: dirtyEntityMd
            },
            extraChapters: {
                'ch_0001.md': '# 第一章 缺页\n\n沈默核出账册缺页，门口留着半枚黄铜钥匙的印痕。\n',
                'ch_0002.md': '# 第二章 拖轮\n\n沈默在二号仓库外拾到铜锁片，记下拖轮进港时刻。\n'
            }
        });

        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            [
                '# 第 1 卷双轨章卡',
                '',
                '## ch_0001 (day:1)',
                '- 主干剧情：沈默核出账册缺页，找到黄铜钥匙印痕。',
                '- 出场实体：char_001',
                '',
                '## ch_0002 (day:2)',
                '- 主干剧情：沈默追踪拖轮进港时刻。',
                '- 出场实体：char_001'
            ].join('\n') + '\n',
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: add chapters for dreaming']);

        // 读取干净实体初始 stat（验证 Dreaming 全程零读取零修改且 mtime 不变）
        const cleanPath = join(bookRoot, 'entities/char_clean.md');
        const beforeStat = await stat(cleanPath);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let ryowReadResult = '';
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ execTool }) => {
                // Dreamer 多轮探查：读取 L2 章卡与原稿核实，编辑脏实体、伏笔表、惯性表与导演节拍
                await execTool('book_read', { path: 'index/L2_cards/vol_01_cards.md' });
                await execTool('book_read', { path: 'manuscripts/ch_0001.md' });
                await execTool('book_read', { path: 'entities/char_001.md' });

                await execTool('book_edit', {
                    path: 'entities/char_001.md',
                    target_text: '- [day:0 | ch:0] 接下三号码头夜班清点任务',
                    replacement_text:
                        '- [day:0 | ch:0] 接下三号码头夜班清点任务\n- [day:2 | ch:2] 查明账页缺损与二号仓库铜锁片关联 [锚点 ch_0002]'
                });
                // 验证 Read-Your-Own-Writes：紧接读取 char_001.md 读回暂存内容
                const readRes = (await execTool('book_read', {
                    path: 'entities/char_001.md'
                })) as { content: string };
                ryowReadResult = readRes.content;

                await execTool('book_edit', {
                    path: 'world/open_threads.md',
                    target_text: '- [thread_key | status: ACTIVE] item_001 黄铜钥匙究竟能打开哪一扇旧闸门',
                    replacement_text:
                        '- [thread_gate | status: ACTIVE] 二号仓库铜锁片指向谁的泊位权限'
                });
                await execTool('book_edit', {
                    path: 'world/future_horizon.md',
                    target_text: '- [event:evt_tide | day:2 | status:ACTIVE] 港务局将在涨潮后查封二号仓库',
                    replacement_text:
                        '- [event:evt_tide | day:2 | status:WARPED] 港务局将在涨潮后查封二号仓库'
                });
                await execTool('book_edit', {
                    path: 'world/arc_director_plan.md',
                    target_text: '- [status: PENDING] Beat 1: 码头核对潮汐单与旧钥匙现身',
                    replacement_text: '- [status: DONE] Beat 1: 码头核对潮汐单与旧钥匙现身'
                });

                await execTool('yield_dream_commit', {
                    summary: '完成 ch_0001-ch_0002 脏实体提炼、伏笔盘点与节拍更新',
                    chapter_number: 2,
                    accumulated_words: 1200,
                    spotlight_triggers: [
                        {
                            entity_id: 'char_002',
                            reason: '林小满的半张船票蓄力已满，下一章前台对质',
                            suggested_mode: 'MAINLINE'
                        }
                    ]
                });
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const dreamRes = await ctx.narratePipeline.runDreaming({
            currentChapter: 2,
            force: true
        });

        expect(dreamRes.skipped).toBe(false);
        expect(dreamRes.spotlightTriggerCount).toBe(1);
        expect(dreamRes.committedPaths).toContain('entities/char_001.md');
        expect(dreamRes.committedPaths).toContain('world/open_threads.md');
        expect(dreamRes.committedPaths).toContain('world/future_horizon.md');
        expect(dreamRes.committedPaths).toContain('world/arc_director_plan.md');
        expect(dreamRes.committedPaths).toContain('.ops/signals.jsonl');
        expect(dreamRes.committedTxState?.phase).toBe('DREAM_COMMITTED');
        expect(ryowReadResult).toContain('查明账页缺损与二号仓库铜锁片关联');

        // 验证未出场干净实体 mtime 与内容绝对不变
        const afterStat = await stat(cleanPath);
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
        expect(await readFile(cleanPath, 'utf8')).toBe(cleanEntityMd);

        // 验证 runs.jsonl 记录了 Dreamer 会话
        const runs = await ctx.narrateStore.openStore().listRunRecords({ chapter: 2 });
        expect(runs.some((r) => r.role === 'dreamer' && r.status === 'completed')).toBe(true);
    });

    it('支持 Sync 手改同步、PARALLEL 分叉合并、advanceVolume 五步换卷与三级跨章自愈', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'sync-parallel-vol-heal', {
            storyDay: 2,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章 码头\n\n沈默左手拎着黄铜提灯。\n',
                'ch_0002.md': '# 第二章 夜雨\n\n天空下着小雨，沈默右手握着铁扳手。\n'
            }
        });

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        await createHeadlessMockServices(ctx, {
            onAgent: async () => {},
            onLlmStream: (opts) => {
                const sys = opts.system ?? '';
                if (sys.includes('手稿增量同步定性器')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            is_prose_polish_only: true,
                            reason: '仅替换修饰词，无事实变化',
                            affected_entity_ids: []
                        })
                    );
                }
                if (sys.includes('连续性自愈裁判')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            severity: 'SINGLE_POINT_HARD',
                            reason: '手持物与第一章冲突',
                            downstream_dependent: false
                        })
                    );
                }
                if (sys.includes('跨章单点硬穿帮局部修补专员')) {
                    return textToStreamChunks('天空下着小雨，沈默左手拎着黄铜提灯。');
                }
                if (sys.includes('卷级归档编纂器')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            volume_summary: '第 1 卷完成三号码头账册初查。',
                            story_day_span: 'day 0 ~ day 2'
                        })
                    );
                }
                if (sys.includes('卷级大纲编译器')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            current_arc_envelope: '# 第 2 卷正向舞台\n\n外港锚地开启全面盘查。',
                            future_horizon: '# 第 2 卷未来惯性\n\n- [event:evt_v2 | day:3 | status:ACTIVE] 锚地封锁'
                        })
                    );
                }
                return textToStreamChunks('ok');
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        // 1. Sync 最新章纯润色
        await writeFile(
            join(bookRoot, 'manuscripts/ch_0002.md'),
            '# 第二章 夜雨\n\n细雨斜飘，沈默右手握着铁扳手。\n',
            'utf8'
        );
        const syncRes = await ctx.narratePipeline.syncManuscripts();
        expect(syncRes.status).toBe('PROSE_POLISH_SYNCED');

        // 2. 三级自愈（Tier 1 RETCON + Tier 2 净室 Patch + Tier 3 熔断 QUARANTINED）
        const healRes = await ctx.narratePipeline.healCrossChapterConflicts([
            {
                conflictId: 'c-soft',
                chapterA: 1,
                quoteA: '沈默左手拎着黄铜提灯。',
                chapterB: 2,
                quoteB: '细雨斜飘，沈默右手握着铁扳手。',
                description: '雨势描述微差',
                severityHint: 'SOFT_MINOR'
            },
            {
                conflictId: 'c-hard',
                chapterA: 1,
                quoteA: '沈默左手拎着黄铜提灯。',
                chapterB: 2,
                quoteB: '细雨斜飘，沈默右手握着铁扳手。',
                description: '手持物硬冲突',
                severityHint: 'SINGLE_POINT_HARD'
            }
        ]);
        expect(healRes.results.map((r) => r.action)).toEqual([
            'RETCON_SIGNAL',
            'PATCHED_IN_PLACE'
        ]);
        expect(await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8')).toContain(
            '沈默左手拎着黄铜提灯'
        );

        // 3. PARALLEL 分叉与三方合并
        await ctx.narratePipeline.forkParallelWindow({ windowId: 'win-1' });
        const mergeRes = await ctx.narratePipeline.mergeParallelWindow({ windowId: 'win-1' });
        expect(mergeRes.windowId).toBe('win-1');

        // 4. advanceVolume 五步换卷
        const volRes = await ctx.narratePipeline.advanceVolume({ companionEntityIds: ['char_002'] });
        expect(volRes.sealedVolume).toBe(1);
        expect(volRes.nextVolume).toBe(2);
        expect(volRes.tagName).toBe('arc-seal-vol-01');
        const wsAfter = await ctx.narrateStore.openStore().readWorldState();
        expect(wsAfter.frontmatter.current_volume).toBe(2);
    });

    it('仅覆写 world/roles/prompts/planner.md（无 planner.yml）时生效，且含 {{mustache}} 文本不抛错并透传 temperature', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'prompt-only-override');
        await mkdir(join(bookRoot, 'world/roles/prompts'), { recursive: true });
        await writeFile(
            join(bookRoot, 'world/roles/prompts/planner.md'),
            '# Prompt-only 覆写\n\nPROMPT_ONLY_MARKER\n保留字面量变量语法：{{unknown_mustache_var}}。\n',
            'utf8'
        );

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        const { agentRuns } = await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, agentCtx, agent }) => {
                if (tools.has('yield_context_pack')) {
                    agentCtx.emit('session/event' as never, agent as never, {} as never);
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '测试覆写',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛留白',
                        chapter_turn: '账页异常',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '查账', is_spotlight: true }
                        ],
                        outline_text: '沈默翻开潮汐账簿。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '测试覆写完成',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks('<blocking>码头</blocking>\n\n沈默合上账册，转身离开。')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const res = await ctx.narratePipeline.stepChapter({ chapterGoal: '检验 prompt-only 覆写' });
        expect(res.status).toBe('COMMITTED');

        const plannerRun = agentRuns.find((r) => r.toolNames.includes('yield_outline'));
        expect(plannerRun?.systemPromptText).toContain('PROMPT_ONLY_MARKER');
        expect(plannerRun?.systemPromptText).toContain('{{unknown_mustache_var}}');
        expect(plannerRun?.temperature).toBe(0.5);
    });

    it('非相邻多段局部 Patch 按连续区间分组改写（零重写中间合规段落），并走外部 patch.yml 配置', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'grouped-local-patch');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let writerCount = 0;
        const patchPrompts: string[] = [];
        const patchTemperatures: Array<number | undefined> = [];

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '分组修补',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'CLOSURE',
                        director_rationale: '秘辛',
                        chapter_turn: '查验货箱',
                        scene_plan: [
                            { scene_index: 1, location: '货栈', summary: '清点', is_spotlight: true }
                        ],
                        outline_text: '沈默核对货箱与账目。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '核对货箱完成。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: (opts) => {
                if (opts.system?.includes('局部修补')) {
                    const userBlock = JSON.stringify(opts.messages);
                    patchPrompts.push(userBlock);
                    patchTemperatures.push(opts.temperature);
                    if (userBlock.includes('第一违规段')) {
                        return textToStreamChunks('沈默低头核对箱号，在簿子上划了一道斜杠。');
                    }
                    return textToStreamChunks('「班次单和船期对不上。」沈默把纸折好塞进口袋。');
                }
                writerCount += 1;
                if (writerCount === 1) {
                    return textToStreamChunks(
                        [
                            '<blocking>货栈</blocking>',
                            '',
                            '第一违规段：他心中涌起一股莫名的情绪，指节泛白。',
                            '',
                            'MIDDLE_CLEAN_PARAGRAPH: 货栈角落的煤油灯晃了两下，灯油快见底了。',
                            '',
                            '第三违规段：他喉结滚动，不由得退后半步。'
                        ].join('\n')
                    );
                }
                return textToStreamChunks('沈默核对完箱号离开了货栈。');
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const res = await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '测试非相邻分组 Patch'
        });

        expect(res.status).toBe('COMMITTED');
        expect(res.patchRounds).toBe(1);
        expect(res.rewriteCount).toBe(0);
        // 两个不相邻违规段落应触发两次独立局部 Patch，且每次传给 patch 的目标段落都不包含中间合规段落
        expect(patchPrompts.length).toBe(2);
        expect(patchTemperatures).toEqual([0.4, 0.4]);
        for (const p of patchPrompts) {
            expect(p).not.toContain('第一违规段：他心中涌起一股莫名的情绪，指节泛白。\n\nMIDDLE_CLEAN_PARAGRAPH');
        }
        const saved = await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8');
        expect(saved).toContain('MIDDLE_CLEAN_PARAGRAPH: 货栈角落的煤油灯晃了两下，灯油快见底了。');
    });

    it('narration_subjectivity=subjective_first 透传 StaticProseGate 并豁免 subjective_judgment 与 negation_contrast', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'subjective-first');
        const cfgPath = join(bookRoot, 'world/book_config.yaml');
        const oldCfg = await readFile(cfgPath, 'utf8');
        await writeFile(
            cfgPath,
            oldCfg.replace('narration_subjectivity: objective_third', 'narration_subjectivity: subjective_first'),
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', 'world/book_config.yaml']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: set subjective_first']);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '主观叙事测试',
                        target_word_count: 1600,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'AFTERGLOW',
                        director_rationale: '秘辛',
                        chapter_turn: '独白推理',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '盘查', is_spotlight: true }
                        ],
                        outline_text: '我站在三号码头看着货栈铁门。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '第一人称独白过审。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks(
                    [
                        '<blocking>码头</blocking>',
                        '',
                        '在我看来，这批货不是人手不够，而是有人故意压着单子。',
                        '',
                        '老实说，港口并非真的封锁，而是风声紧了些。'
                    ].join('\n')
                )
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const res = await ctx.narratePipeline.stepChapter({ chapterGoal: '第一人称强主观试写' });
        expect(res.status).toBe('COMMITTED');
        expect(res.patchRounds).toBe(0);
        expect(res.rewriteCount).toBe(0);
    });

    it('PARALLEL 模式同支线连续两章新建并二次更新同一实体且可合并（deferCommit 快照透传）', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'parallel-branch-entities');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let extractorChapter = 0;
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '支线推进',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '支线线人',
                        chapter_turn: '陈九在支线露面',
                        scene_plan: [
                            { scene_index: 1, location: '外港', summary: '接头', is_spotlight: true }
                        ],
                        outline_text: '陈九在支线与沈默接头。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    extractorChapter += 1;
                    if (extractorChapter === 1) {
                        await execTool('yield_state_patch', {
                            entity_patches: [
                                {
                                    entity_id: 'char_branch_01',
                                    canonical_name: '陈九',
                                    last_seen_ch: 1,
                                    acquired_state_ops: [
                                        {
                                            op: 'upsert_slot',
                                            slot_key: 'location',
                                            entry: {
                                                storyDay: 0,
                                                chapter: 1,
                                                visibility: 'PUBLIC',
                                                text: '外港锚地'
                                            }
                                        }
                                    ]
                                }
                            ],
                            story_day_delta: 0,
                            chapter_summary: '支线第1章新建实体陈九。',
                            next_chapter_options: ['继续']
                        });
                    } else {
                        // 第 2 章不再传入 canonical_name，应通过 visibleEntities 识别为已有支线实体
                        await execTool('yield_state_patch', {
                            entity_patches: [
                                {
                                    entity_id: 'char_branch_01',
                                    last_seen_ch: 2,
                                    acquired_state_ops: [
                                        {
                                            op: 'upsert_slot',
                                            slot_key: 'location',
                                            entry: {
                                                storyDay: 0,
                                                chapter: 2,
                                                visibility: 'PUBLIC',
                                                text: '转赴二号泊位接应 char_001'
                                            }
                                        }
                                    ]
                                }
                            ],
                            story_day_delta: 0,
                            chapter_summary: '支线第2章二次更新陈九位置。',
                            next_chapter_options: ['合并窗口']
                        });
                    }
                }
            },
            onLlmStream: () =>
                textToStreamChunks('<blocking>外港</blocking>\n\n陈九提灯走过泊位木桥。')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await ctx.narratePipeline.forkParallelWindow({ windowId: 'win-branch' });

        const step1 = await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '支线1章新建陈九',
            timelineMode: 'PARALLEL',
            parallelWindowId: 'win-branch',
            parallelBranchId: 'branch-a'
        });
        expect(step1.status).toBe('COMMITTED');
        expect(existsSync(join(bookRoot, 'entities/char_branch_01.md'))).toBe(false);

        const step2 = await ctx.narratePipeline.stepChapter({
            chapterNumber: 2,
            chapterGoal: '支线2章更新陈九',
            timelineMode: 'PARALLEL',
            parallelWindowId: 'win-branch',
            parallelBranchId: 'branch-a'
        });
        expect(step2.status).toBe('COMMITTED');

        const mergeRes = await ctx.narratePipeline.mergeParallelWindow({ windowId: 'win-branch' });
        expect(mergeRes.updatedEntities).toContain('char_branch_01');
        const mergedEntity = await readFile(join(bookRoot, 'entities/char_branch_01.md'), 'utf8');
        expect(mergedEntity).toContain('陈九');
        expect(mergedEntity).toContain('转赴二号泊位接应 char_001');
    });

    it('3 级跨章自愈按 commit log 精准回滚多提交历史并清理未跟踪垃圾文件（保留 .ops 与持锁互斥）', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'heal-multicommit-rollback');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        await createHeadlessMockServices(ctx, {
            onAgent: async () => {},
            onLlmStream: () => textToStreamChunks('ok')
        });

        const store = ctx.narrateStore.openStore();
        // 构建 ch1 (feat+state), ch2 (feat+state), ch3 (feat+state) 共 6 个事务提交
        for (const [ch, text] of [
            [1, '# 第一章\n\n沈默右手戴着铁表。\n'],
            [2, '# 第二章\n\n沈默左手戴着金表，从此换了习惯。\n'],
            [3, '# 第三章\n\n众人盯着沈默的金表看。\n']
        ] as const) {
            await store.beginDraft(ch);
            await store.commitDraft(ch, text);
            await store.applyStatePatch(ch, []);
        }

        // 制造未跟踪垃圾文件与 .ops/runs.jsonl 保护文件
        await writeFile(join(bookRoot, 'manuscripts/ch_9999_orphan.md'), 'orphan', 'utf8');
        await writeFile(join(bookRoot, '.ops/runs.jsonl'), '{"runId":"keep"}\n', 'utf8');

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        let lockHeldInsideRerun = false;
        const healRes = await ctx.narratePipeline.healCrossChapterConflicts(
            [
                {
                    conflictId: 'c-cascade',
                    chapterA: 1,
                    quoteA: '沈默右手戴着铁表。',
                    chapterB: 2,
                    quoteB: '沈默左手戴着金表，从此换了习惯。',
                    description: '手表材质与左右手连环冲突',
                    severityHint: 'CASCADING_HARD'
                }
            ],
            {
                onAutoRerun: async ({ rollbackToChapter }) => {
                    expect(rollbackToChapter).toBe(1);
                    // 验证 healCrossChapterConflicts 全程持有 withTxLock
                    try {
                        await store.withTxLock(async () => {});
                    } catch (err) {
                        if (err instanceof TxLockConflictError) {
                            lockHeldInsideRerun = true;
                        }
                    }
                    return { success: true, stillConflicting: false };
                }
            }
        );

        expect(healRes.results[0]?.action).toBe('AUTO_ROLLED_BACK_AND_RERUN');
        expect(lockHeldInsideRerun).toBe(true);
        expect(existsSync(join(bookRoot, 'manuscripts/ch_0001.md'))).toBe(true);
        expect(existsSync(join(bookRoot, 'manuscripts/ch_0002.md'))).toBe(false);
        expect(existsSync(join(bookRoot, 'manuscripts/ch_0003.md'))).toBe(false);
        expect(existsSync(join(bookRoot, 'manuscripts/ch_9999_orphan.md'))).toBe(false);
        expect(existsSync(join(bookRoot, '.ops/runs.jsonl'))).toBe(true);
        expect((await store.readTxState()).last_committed_ch).toBe(1);
    });

    it('RoleRunner 汇总多轮 assistant/message usage 到 RunDreamingResult.usage 与 StepChapterResult.totalUsage', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'usage-aggregation', {
            storyDay: 1,
            currentChapter: 1,
            extraChapters: {
                'ch_0001.md': '# 第一章\n\n沈默站在码头边。\n'
            }
        });
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ sessionId, execTool }) => {
                ctx.emit('session/event' as never, { id: sessionId } as never, {
                    type: 'assistant/message',
                    data: {
                        usage: {
                            inputTokens: 100,
                            cacheReadTokens: 20,
                            cacheWriteTokens: 5,
                            outputTokens: 40
                        }
                    }
                } as never);
                await execTool('yield_dream_commit', {
                    summary: '汇总用量测试',
                    chapter_number: 1,
                    accumulated_words: 100
                });
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const dreamRes = await ctx.narratePipeline.runDreaming({
            currentChapter: 1,
            force: true
        });
        expect(dreamRes.usage).toEqual({
            inputTokens: 100,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
            outputTokens: 40
        });
    });

    it('RoleRunner 与 DshLlmAdapter 按模型能力适配 reasoningEffort（如 deepseek-flash 仅支持 off）', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'effort-adapt', {
            storyDay: 1,
            currentChapter: 1,
            extraChapters: {
                'ch_0001.md': '# 第一章\n\n沈默站在码头边。\n'
            }
        });
        await mkdir(join(bookRoot, 'roles'), { recursive: true });
        await writeFile(
            join(bookRoot, 'roles/dreamer.yml'),
            [
                'id: dreamer',
                'pool: fast_retrieval',
                'cleanroom: false',
                'promptFile: ./prompts/dreamer.md',
                'temperature: 0.2',
                'reasoningEffort: medium',
                'maxSteps: 6',
                'maxReadCalls: 4',
                'tools:',
                '  - book_read',
                'yieldTool: yield_dream_commit'
            ].join('\n') + '\n',
            'utf8'
        );
        await mkdir(join(bookRoot, 'roles/prompts'), { recursive: true });
        await writeFile(join(bookRoot, 'roles/prompts/dreamer.md'), '你是睡眠整理员。\n', 'utf8');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        const { agentRuns, llmCalls } = await createHeadlessMockServices(ctx, {
            resolveModelInfo: async (provider, model) => ({
                id: model,
                name: model,
                provider,
                reasoning: {
                    efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
                    defaultEffort: ReasoningEffortId('off')
                }
            }),
            onAgent: async ({ execTool }) => {
                await execTool('yield_dream_commit', {
                    summary: '适配 off 档推理',
                    chapter_number: 1,
                    accumulated_words: 100
                });
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await ctx.narratePipeline.runDreaming({
            currentChapter: 1,
            force: true
        });
        expect(agentRuns[0]?.reasoningEffort).toBe('off');

        const adapter = new DshLlmAdapter(ctx.llm, {
            poolRouting: {
                strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
                fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' },
                audit: { provider: 'deepseek-official', model: 'deepseek-flash' }
            }
        });
        await adapter.generate({
            pool: 'fast_retrieval',
            staticPrefixBlocks: ['sys'],
            dynamicTail: 'hi',
            reasoningEffort: 'medium'
        });
        expect(llmCalls[0]?.options.reasoningEffort).toBe('off');
    });

    it('RoleRunner 在 agent/error 触发且未调用 yieldTool 时透传真实错误', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'agent-error-surface', {
            storyDay: 1,
            currentChapter: 1,
            extraChapters: {
                'ch_0001.md': '# 第一章\n\n沈默站在码头边。\n'
            }
        });
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ agentCtx }) => {
                agentCtx.emit(
                    'agent/error' as never,
                    {
                        error: new Error(
                            'provider "deepseek-official" model "deepseek-flash" does not support reasoning effort "medium"'
                        )
                    } as never
                );
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await expect(
            ctx.narratePipeline.runDreaming({
                currentChapter: 1,
                force: true
            })
        ).rejects.toThrow(/does not support reasoning effort "medium"/);
    });

    it('DshLlmAdapter 遇到 MALFORMED_RESPONSE 时自动退避重试并返回后续成功响应', async () => {
        let attempts = 0;
        const mockLlm = {
            async *stream() {
                attempts += 1;
                if (attempts === 1) {
                    yield {
                        type: 'finish',
                        reason: {
                            kind: 'error',
                            failure: {
                                code: 'MALFORMED_RESPONSE',
                                message: 'DeepSeek Messages stream: duplicate message_start'
                            }
                        }
                    };
                    return;
                }
                yield* textToStreamChunks('陈砚合上账册，海风从门缝吹进来。');
            }
        };

        const adapter = new DshLlmAdapter(mockLlm as never, {
            poolRouting: {
                strong_creative: { provider: 'deepseek-official', model: 'mock-strong' },
                fast_retrieval: { provider: 'deepseek-official', model: 'mock-fast' },
                audit: { provider: 'deepseek-official', model: 'mock-audit' }
            },
            backoffMs: [1],
            sleepFn: async () => {}
        });

        const res = await adapter.generate({
            pool: 'strong_creative',
            staticPrefixBlocks: ['正文写手'],
            dynamicTail: '写一章'
        });

        expect(attempts).toBe(2);
        expect(res.text).toContain('陈砚合上账册');
    });
});

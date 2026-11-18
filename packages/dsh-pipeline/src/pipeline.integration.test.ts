import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import { TxLockConflictError } from '@narrateos/dsh-book-store';
import * as bookToolsPlugin from '@narrateos/dsh-book-tools';
import { afterEach, describe, expect, it } from 'vitest';
import * as pipelinePlugin from './index.js';
import {
    CLEANROOM_PATCH_FALLBACK_REASON,
    ensureChapterHeading,
    GATE_MAX_PATCH_PARAGRAPHS,
    sanitizeTextForCleanroomWriter
} from './pipeline/chapter-pipeline.js';
import { DshLlmAdapter, resolveRoleReasoningEffort, resolveRoleRoute } from './runner/dsh-llm-adapter.js';
import { RoleLoader } from './roles/role-loader.js';
import { RoleRunner } from './runner/role-runner.js';
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
        let patchCallCount = 0;
        let factCheckerCallCount = 0;

        const { agentRuns, llmCalls } = await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, systemPromptText, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001', 'char_002'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }

                if (tools.has('yield_patched_draft')) {
                    patchCallCount += 1;
                    // 验证 Patch 净室隔离：无磁盘工具且不泄露任何全知档案或导演禁区
                    expect(tools.has('book_read')).toBe(false);
                    expect(tools.has('book_edit')).toBe(false);
                    const combined = `${systemPromptText}\n${taskPrompt}`;
                    expect(combined).not.toContain('CHARTER_SECRET_ANCHOR');
                    expect(combined).not.toContain('DIRECTOR_SECRET_CEILING');
                    expect(combined).not.toContain('OMNISCIENT_SECRET_TOKEN');
                    expect(combined).not.toContain('WARPED_SECRET_ENTRY');
                    expect(combined).not.toContain('SELF_ONLY_CHAR002_SECRET');

                    await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 2,
                                end_paragraph: 2,
                                replacement_paragraphs: [
                                    '他只觉得掌心微潮，手指顺着账册边缘的红墨线划过去。'
                                ]
                            }
                        ]
                    });
                    await execTool('yield_patched_draft', {
                        summary: '改写第 2 段抽象情绪表达为具体动作'
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
                                    quote_draft: '沈默翻开厚重的潮汐账册，指腹在十二页停住。',
                                    quote_source: '驻留节点：三号码头货栈',
                                    source_ref: 'entities/char_001.md'
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
        expect(patchCallCount).toBe(1);
        expect(plannerCallCount).toBe(2);
        expect(factCheckerCallCount).toBe(2);
        expect(result.featCommitSha).toBeTruthy();
        expect(result.stateCommitSha).toBeTruthy();

        // 1. 验证多轮工种以独立顶层 Session 启动（不带无父地址的 subagent origin）且记录至 .ops/runs.jsonl
        expect(agentRuns.every((r) => r.origin === undefined)).toBe(true);
        const runs = await ctx.narrateStore.openStore().listRunRecords({ chapter: 1 });
        expect(runs.some((r) => r.stage === 'LIBRARIAN' && r.status === 'completed')).toBe(true);
        expect(runs.some((r) => r.stage === 'PLANNER' && r.status === 'completed')).toBe(true);
        expect(runs.some((r) => r.stage === 'LOCAL_PATCH' && r.role === 'patch' && r.status === 'completed')).toBe(true);
        expect(runs.some((r) => r.stage === 'FACT_CHECKER' && r.status === 'completed')).toBe(true);
        expect(runs.some((r) => r.stage === 'EXTRACTOR' && r.status === 'completed')).toBe(true);

        // 2. 验证 Writer 净室隔离：零工具、零 sessionId、物理剥离禁区与秘密词汇
        const writerCalls = llmCalls;
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
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_patched_draft')) {
                    await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 1,
                                end_paragraph: 1,
                                replacement_paragraphs: ['天空下着小雨，沈默左手拎着黄铜提灯。']
                            }
                        ]
                    });
                    await execTool('yield_patched_draft', { summary: '跨章单点硬穿帮净室修补' });
                }
            },
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

    it('非相邻多段局部 Patch 通过 patch_paragraphs + yield_patched_draft 净室多轮闭环改写（门禁未清零拒交、保留标题与未触及段落），且支持单书 cleanroom=true 回退', async () => {
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
        let prematureYieldError: unknown = null;
        let secondPatchPassed = false;
        let capturedPatchTaskPrompt = '';

        const { agentRuns } = await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
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
                if (tools.has('yield_patched_draft')) {
                    capturedPatchTaskPrompt = taskPrompt;
                    // 第 1 次仅修第 1 段，故意漏掉第 3 段并尝试提前 yield，验证 enforceProseGateOnYield 拦截
                    const firstPatch = (await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 1,
                                end_paragraph: 1,
                                replacement_paragraphs: ['沈默低头核对箱号，在簿子上划了一道斜杠。']
                            }
                        ]
                    })) as { passed: boolean; violatedParagraphIndices: number[] };
                    expect(firstPatch.passed).toBe(false);
                    expect(firstPatch.violatedParagraphIndices).toEqual([3]);

                    try {
                        await execTool('yield_patched_draft', { summary: '提前提交' });
                    } catch (err) {
                        prematureYieldError = err;
                    }

                    // 第 2 次修正剩余第 3 段，门禁通过后调用 yield_patched_draft 提交
                    const secondPatch = (await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 3,
                                end_paragraph: 3,
                                replacement_paragraphs: ['「班次单和船期对不上。」沈默把纸折好塞进口袋。']
                            }
                        ]
                    })) as { passed: boolean };
                    secondPatchPassed = secondPatch.passed;
                    await execTool('yield_patched_draft', { summary: '修正第 1 与第 3 段' });
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
            onLlmStream: () => {
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
        expect(prematureYieldError).toBeInstanceOf(Error);
        expect(String(prematureYieldError)).toContain('StaticProseGate');
        expect(secondPatchPassed).toBe(true);
        expect(capturedPatchTaskPrompt).toContain('[1] 第一违规段');
        expect(capturedPatchTaskPrompt).toContain('[3] 第三违规段');

        const patchRun = agentRuns.find((r) => r.toolNames.includes('yield_patched_draft'));
        expect(patchRun).toBeDefined();
        expect(patchRun?.temperature).toBe(0.4);
        expect(patchRun?.toolNames).toEqual(['patch_paragraphs', 'yield_patched_draft']);

        const saved = await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8');
        expect(saved.startsWith('# 分组修补\n\n')).toBe(true);
        expect(saved).toContain('MIDDLE_CLEAN_PARAGRAPH: 货栈角落的煤油灯晃了两下，灯油快见底了。');

        // 补充验证：单书 world/roles/patch.yml 覆盖 cleanroom: true 时显式报错拒绝（不再回退单轮 writer）
        const cleanBookRoot = await createGitBookWorkspace(tempDirs, 'patch-cleanroom-reject');
        await mkdir(join(cleanBookRoot, 'world/roles/prompts'), { recursive: true });
        await writeFile(
            join(cleanBookRoot, 'world/roles/prompts/patch.md'),
            '# 单书净室局部修补专员\n\n违规单轮配置。\n',
            'utf8'
        );
        await writeFile(
            join(cleanBookRoot, 'world/roles/patch.yml'),
            [
                'id: patch',
                'pool: strong_creative',
                'cleanroom: true',
                'promptFile: ./prompts/patch.md',
                'temperature: 0.35',
                'reasoningEffort: low',
                'maxSteps: 1',
                'maxReadCalls: 0',
                'tools: []',
                'yieldTool: null'
            ].join('\n') + '\n',
            'utf8'
        );

        const cleanCtx = new Context();
        const cleanPromptFiber = await cleanCtx.plugin(SystemPrompt);
        registerCleanup(() => cleanPromptFiber.dispose());
        const cleanToolsFiber = await cleanCtx.plugin(ToolsService);
        registerCleanup(() => cleanToolsFiber.dispose());
        const cleanStoreFiber = await cleanCtx.plugin(bookStorePlugin, { bookRoot: cleanBookRoot });
        registerCleanup(() => cleanStoreFiber.dispose());
        const cleanBookToolsFiber = await cleanCtx.plugin(bookToolsPlugin);
        registerCleanup(() => cleanBookToolsFiber.dispose());

        await createHeadlessMockServices(cleanCtx, {
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
                        chapter_title: '拒绝净室覆盖',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'CLOSURE',
                        director_rationale: '秘辛',
                        chapter_turn: '查验货箱',
                        scene_plan: [
                            { scene_index: 1, location: '货栈', summary: '清点', is_spotlight: true }
                        ],
                        outline_text: '沈默核对货箱。'
                    });
                    return;
                }
            },
            onLlmStream: () =>
                textToStreamChunks(
                    [
                        '<blocking>货栈</blocking>',
                        '',
                        '他指节泛白，喉结滚动。',
                        '',
                        'CLEAN_MIDDLE_STAY: 货栈门外的汽笛响了一声。'
                    ].join('\n')
                )
        });
        const cleanPipeFiber = await cleanCtx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => cleanPipeFiber.dispose());

        await expect(
            cleanCtx.narratePipeline.stepChapter({
                chapterNumber: 1,
                chapterGoal: '测试 cleanroom=true 违规配置显式拒止'
            })
        ).rejects.toThrow(/cleanroom=false/);
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
        let healPlanPresentInsideRerun = false;
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
                    healPlanPresentInsideRerun = existsSync(join(bookRoot, '.ops/heal_plan.json'));
                    // 验证 Tier 3 在调用 onAutoRerun 前已释放 tx.lock，内部可安全取锁重跑（无死锁）
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
        expect(lockHeldInsideRerun).toBe(false);
        expect(healPlanPresentInsideRerun).toBe(true);
        expect(existsSync(join(bookRoot, '.ops/heal_plan.json'))).toBe(false);
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

    it('全工种均在最外层过滤 agent-instructions (AGENTS.md)，且 WRITER 支持单轮无工具 Agent 会话与 MALFORMED_RESPONSE 重试', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'writer-isolation');
        const ctx = new Context();

        const storeFiber = await ctx.plugin(bookStorePlugin, { booksRoot: join(bookRoot, '..') });
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot: join(bookRoot, '..') });
        registerCleanup(async () => {
            await toolsFiber.dispose();
            await storeFiber.dispose();
        });

        let sawToolsRegisterOnWriter = false;
        let preStepCapturedMessages: Array<{ source?: { kind?: string }; text?: string }> = [];
        let malformedRetryDecisions: Array<{ kind: string } | undefined> = [];

        const mockSysPromptPlugin = {
            name: 'mock-sys-prompt',
            apply() {}
        };
        void mockSysPromptPlugin;

        const { RoleRunner } = await import('./runner/role-runner.js');
        const { RoleLoader } = await import('./roles/role-loader.js');

        // 模拟宿主先挂的 dsh-agent-instructions：会在 agent/pre-step 内层往 messages 塞一条 agent-instructions
        const outerPreStepWrappers: Array<
            (payload: unknown, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<{
                kind: string;
                messages: unknown[];
            }>
        > = [];
        const preStepListeners: Array<
            (payload: unknown, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<{
                kind: string;
                messages: unknown[];
            }>
        > = [];
        const requestErrorListeners: Array<
            (
                payload: {
                    turn: number;
                    step: number;
                    provider: string;
                    failure: { code: string; message: string };
                    signal: AbortSignal;
                },
                next: () => Promise<{ kind: 'retry' } | undefined>
            ) => Promise<{ kind: 'retry' } | undefined>
        > = [];

        // 外层模拟宿主 @deepseek-ai/dsh-agent-instructions
        outerPreStepWrappers.push(async (_payload, next) => {
            const d = await next();
            return {
                ...d,
                messages: [
                    ...d.messages,
                    {
                        role: 'user',
                        source: { kind: 'agent-instructions' },
                        text: '来自宿主工作区的 AGENTS.md 污染内容'
                    }
                ]
            };
        });

        let latestStreamHandler: ((ev: { frame: unknown }) => void) | undefined;
        let idleResolve: (() => void) | undefined;
        const fakeAgentCtx = {
            tools: {
                restrict() {},
                register() {
                    sawToolsRegisterOnWriter = true;
                }
            },
            systemPrompt: {
                section() {}
            },
            on(event: string, listener: (...args: never[]) => unknown, opts?: { prepend?: boolean }) {
                if (event === 'agent/pre-step') {
                    const fn = listener as (typeof preStepListeners)[number];
                    if (opts?.prepend) {
                        preStepListeners.unshift(fn);
                    } else {
                        preStepListeners.push(fn);
                    }
                } else if (event === 'agent/request-error') {
                    requestErrorListeners.push(listener as (typeof requestErrorListeners)[number]);
                } else if (event === 'agent/assistant-stream') {
                    latestStreamHandler = listener as typeof latestStreamHandler;
                }
                return () => {};
            }
        };

        const mockAgents = {
            async create(opts: {
                sessionId: unknown;
                setup: (agentCtx: typeof fakeAgentCtx) => void;
            }) {
                preStepListeners.length = 0;
                preStepListeners.push(...outerPreStepWrappers);
                requestErrorListeners.length = 0;
                opts.setup(fakeAgentCtx);

                const idlePromise = new Promise<void>((resolve) => {
                    idleResolve = resolve;
                });

                return {
                    agent: {
                        session: { id: opts.sessionId },
                        cancel() {},
                        steer() {},
                        whenIdle: () => idlePromise,
                        followup(msg: { content: unknown[] }) {
                            void (async () => {
                                // 验证最外层 prepend pre-step 能否剥离内层注入的 agent-instructions
                                const dispatchPreStep = async (idx: number): Promise<{
                                    kind: string;
                                    messages: unknown[];
                                }> => {
                                    const fn = preStepListeners[idx];
                                    if (!fn) {
                                        return {
                                            kind: 'enter',
                                            messages: [
                                                {
                                                    role: 'user',
                                                    source: { kind: 'narrateos-pipeline' },
                                                    content: msg.content
                                                }
                                            ]
                                        };
                                    }
                                    return await fn({}, () => dispatchPreStep(idx + 1));
                                };
                                const preStepResult = await dispatchPreStep(0);
                                preStepCapturedMessages = preStepResult.messages as typeof preStepCapturedMessages;

                                // 模拟 3 次 MALFORMED_RESPONSE 请求错误：前 2 次应返回 retry，第 3 次不再无限重试
                                for (let i = 0; i < 3; i += 1) {
                                    const ac = new AbortController();
                                    const reqErrHandler = requestErrorListeners[0];
                                    if (reqErrHandler) {
                                        const action = await reqErrHandler(
                                            {
                                                turn: 1,
                                                step: 1,
                                                provider: 'deepseek-official',
                                                failure: {
                                                    code: 'MALFORMED_RESPONSE',
                                                    message: 'duplicate message_start'
                                                },
                                                signal: ac.signal
                                            },
                                            async () => undefined
                                        );
                                        malformedRetryDecisions.push(action);
                                    }
                                }

                                latestStreamHandler?.({
                                    frame: {
                                        type: 'chunk',
                                        chunk: {
                                            type: 'reasoning-delta',
                                            index: 0,
                                            text: '先锚定潮湿码头与冷风声线'
                                        }
                                    }
                                });
                                latestStreamHandler?.({
                                    frame: {
                                        type: 'chunk',
                                        chunk: {
                                            type: 'text-delta',
                                            index: 0,
                                            text: '海雾压在吊机铁臂上，陈砚把油印票据折进袖口。'
                                        }
                                    }
                                });
                                idleResolve?.();
                            })();
                        }
                    },
                    async dispose() {}
                };
            }
        };

        ctx.provide('agents', mockAgents as never);
        ctx.provide('llm', { stream: () => textToStreamChunks('unused') } as never);

        const roleLoader = new RoleLoader();
        const runner = new RoleRunner({
            ctx,
            storeService: ctx.narrateStore,
            toolsService: ctx.narrateTools,
            roleLoader,
            llmAdapter: new DshLlmAdapter(ctx.llm, {
                poolRouting: {
                    strong_creative: { provider: 'deepseek-official', model: 'mock-strong' },
                    fast_retrieval: { provider: 'deepseek-official', model: 'mock-fast' },
                    audit: { provider: 'deepseek-official', model: 'mock-audit' }
                }
            }),
            poolRouting: {
                strong_creative: { provider: 'deepseek-official', model: 'mock-strong' },
                fast_retrieval: { provider: 'deepseek-official', model: 'mock-fast' },
                audit: { provider: 'deepseek-official', model: 'mock-audit' }
            }
        });

        const stageSessions: Array<{ stage: string; sessionId: string }> = [];
        const writerRes = await runner.runCleanroom({
            roleId: 'writer',
            bookRoot,
            chapterNumber: 3,
            request: {
                staticPrefixBlocks: ['静态前缀设定'],
                dynamicTail: '第三章写作指令',
                traceStage: 'writer'
            },
            onStageSession(ev) {
                stageSessions.push({ stage: ev.stage, sessionId: ev.sessionId });
            }
        });

        expect(sawToolsRegisterOnWriter).toBe(false);
        expect(writerRes.sessionId).toMatch(/^narrate-writer-/);
        expect(stageSessions).toEqual([
            { stage: 'WRITER', sessionId: writerRes.sessionId! }
        ]);
        expect(writerRes.response.text).toContain('陈砚把油印票据折进袖口');
        expect(
            preStepCapturedMessages.some((m) => m.source?.kind === 'agent-instructions')
        ).toBe(false);
        expect(malformedRetryDecisions).toEqual([
            { kind: 'retry' },
            { kind: 'retry' },
            undefined
        ]);

        const runsRaw = await readFile(join(bookRoot, '.ops/runs.jsonl'), 'utf8');
        expect(runsRaw).toContain(writerRes.sessionId!);
        const sessionLogPath = join(bookRoot, `.ops/session_logs/${writerRes.sessionId}.json`);
        expect(existsSync(sessionLogPath)).toBe(true);
        const sessionLog = await readFile(sessionLogPath, 'utf8');
        expect(sessionLog).toContain('先锚定潮湿码头与冷风声线');
        expect(sessionLog).toContain('陈砚把油印票据折进袖口');
    });

    it('Audit #1: session_logs 完整持久化 startedAt/finishedAt/modelId/usage/reasoning/thinkingChars，并支持 assistant/message 思考兜底', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'audit-session-logs');
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
            onAgent: async ({ tools, execTool, agentCtx, agent }) => {
                if (tools.has('yield_context_pack')) {
                    // 模拟只通过 assistant/message content 块返回思考（无流式 reasoning-delta）
                    ctx.emit(
                        'session/event',
                        agent.session as never,
                        {
                            type: 'assistant/message',
                            data: {
                                turn: 1,
                                step: 1,
                                message: {
                                    id: 'msg-1',
                                    role: 'assistant',
                                    source: { kind: 'model' },
                                    content: [
                                        { type: 'reasoning', text: '兜底检索思考链：先锁定三号码头与 char_001' }
                                    ]
                                },
                                usage: {
                                    inputTokens: 210,
                                    cacheReadTokens: 80,
                                    cacheWriteTokens: 20,
                                    outputTokens: 65
                                }
                            }
                        } as never
                    );
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    // 模拟通过流式 reasoning-delta 返回思考
                    agentCtx.emit(
                        scopeTarget(agent, agent),
                        'agent/assistant-stream',
                        {
                            frame: {
                                type: 'chunk',
                                chunk: { type: 'reasoning-delta', index: 0, text: '流式细纲思考' }
                            }
                        } as never
                    );
                    ctx.emit(
                        'session/event',
                        agent.session as never,
                        {
                            type: 'assistant/message',
                            data: {
                                usage: {
                                    inputTokens: 300,
                                    cacheReadTokens: 100,
                                    cacheWriteTokens: 0,
                                    outputTokens: 120
                                }
                            }
                        } as never
                    );
                    await execTool('yield_outline', {
                        chapter_title: '日志观测',
                        target_word_count: 1800,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '查验账页',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '查账', is_spotlight: true }
                        ],
                        outline_text: '沈默核对三号码头账簿。'
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
                        chapter_summary: '日志观测完成。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('# 日志观测\n\n沈默核对完最后一行数字，合上账册。')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const seenSessions: Array<{ stage: string; sessionId: string }> = [];
        await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '验证 session_logs 完整观测字段',
            onStageSession(evt) {
                seenSessions.push({ stage: evt.stage, sessionId: evt.sessionId });
            }
        });

        const librarianSession = seenSessions.find((s) => s.stage === 'LIBRARIAN');
        expect(librarianSession).toBeDefined();
        const libLog = JSON.parse(
            await readFile(join(bookRoot, `.ops/session_logs/${librarianSession!.sessionId}.json`), 'utf8')
        ) as {
            startedAt?: string;
            finishedAt?: string;
            modelId?: string;
            usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
            reasoning?: string;
            thinkingChars?: number;
            events: Array<{ kind: string; text?: string }>;
        };
        expect(libLog.startedAt).toBeTruthy();
        expect(libLog.finishedAt).toBeTruthy();
        expect(libLog.modelId).toBe('deepseek-official:deepseek-flash');
        expect(libLog.usage).toMatchObject({
            inputTokens: 210,
            cacheReadTokens: 80,
            cacheWriteTokens: 20,
            outputTokens: 65
        });
        expect(libLog.reasoning).toBe('兜底检索思考链：先锁定三号码头与 char_001');
        expect(libLog.thinkingChars).toBe('兜底检索思考链：先锁定三号码头与 char_001'.length);
        expect(
            libLog.events.some(
                (ev) =>
                    ev.kind === 'thinking' &&
                    ev.text === '兜底检索思考链：先锁定三号码头与 char_001'
            )
        ).toBe(true);

        const plannerSession = seenSessions.find((s) => s.stage === 'PLANNER');
        expect(plannerSession).toBeDefined();
        const planLog = JSON.parse(
            await readFile(join(bookRoot, `.ops/session_logs/${plannerSession!.sessionId}.json`), 'utf8')
        ) as typeof libLog;
        expect(planLog.modelId).toBe('deepseek-official:deepseek-v4-pro');
        expect(planLog.usage?.outputTokens).toBe(120);
        expect(planLog.reasoning).toBe('流式细纲思考');
        expect(planLog.thinkingChars).toBe('流式细纲思考'.length);

        // 失败路径（未调用 yieldTool）也必须落盘完整 session_logs 元数据
        const failCtx = new Context();
        const failPrompt = await failCtx.plugin(SystemPrompt);
        registerCleanup(() => failPrompt.dispose());
        const failTools = await failCtx.plugin(ToolsService);
        registerCleanup(() => failTools.dispose());
        const failStore = await failCtx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => failStore.dispose());
        const failBookTools = await failCtx.plugin(bookToolsPlugin);
        registerCleanup(() => failBookTools.dispose());
        await createHeadlessMockServices(failCtx, {
            onAgent: async ({ agentCtx, agent }) => {
                agentCtx.emit(
                    scopeTarget(agent, agent),
                    'agent/assistant-stream',
                    {
                        frame: {
                            type: 'chunk',
                            chunk: { type: 'reasoning-delta', index: 0, text: '失败前思考片段' }
                        }
                    } as never
                );
                failCtx.emit(
                    'session/event',
                    agent.session as never,
                    {
                        type: 'assistant/message',
                        data: { usage: { inputTokens: 50, outputTokens: 12 } }
                    } as never
                );
            },
            onLlmStream: () => textToStreamChunks('unused')
        });
        const failPipe = await failCtx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => failPipe.dispose());

        const failSessionId = 'narrate-librarian-fail-audit-01';
        await expect(
            failCtx.narratePipeline.roleRunner.runMultiTurn({
                roleId: 'librarian',
                stage: 'LIBRARIAN',
                bookRoot,
                chapterNumber: 1,
                sessionId: failSessionId,
                taskPrompt: '触发未 yield 失败'
            })
        ).rejects.toThrow(/未调用终态门禁工具/);

        const failLog = JSON.parse(
            await readFile(join(bookRoot, `.ops/session_logs/${failSessionId}.json`), 'utf8')
        ) as typeof libLog & { status?: string };
        expect(failLog.status).toBe('failed');
        expect(failLog.startedAt).toBeTruthy();
        expect(failLog.finishedAt).toBeTruthy();
        expect(failLog.modelId).toBe('deepseek-official:deepseek-flash');
        expect(failLog.usage?.inputTokens).toBe(50);
        expect(failLog.usage?.outputTokens).toBe(12);
        expect(failLog.reasoning).toBe('失败前思考片段');
        expect(failLog.thinkingChars).toBe('失败前思考片段'.length);
    });

    it('两层分角色模型覆盖 (resolveRoleRoute + resolveRoleReasoningEffort) 与 RoleRunner/runCleanroom 兜底生效并向后兼容 model_routing', async () => {
        const poolRouting = {
            strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
            fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' },
            audit: { provider: 'audit-provider', model: 'audit-v1' }
        };

        // 1. 纯路由优先级单元测试
        expect(
            resolveRoleRoute(poolRouting, 'librarian', 'fast_retrieval', {
                model_routing: { strong_creative: 'legacy-strong', fast_retrieval: 'legacy-fast' },
                role_routing: {
                    librarian: { tier: 'strong' },
                    planner: { tier: 'weak', model: 'custom-planner' },
                    writer: { model: 'openai:gpt-5-prose' },
                    patch: { tier: 'weak' }
                }
            })
        ).toEqual({ provider: 'deepseek-official', model: 'legacy-strong' });

        expect(
            resolveRoleRoute(poolRouting, 'planner', 'strong_creative', {
                model_routing: { fast_retrieval: 'legacy-fast' },
                role_routing: {
                    planner: { tier: 'weak', model: 'custom-planner' }
                }
            })
        ).toEqual({ provider: 'deepseek-official', model: 'custom-planner' });

        expect(
            resolveRoleRoute(poolRouting, 'writer', 'strong_creative', {
                role_routing: {
                    writer: { model: 'openai:gpt-5-prose' }
                }
            })
        ).toEqual({ provider: 'openai', model: 'gpt-5-prose' });

        // 无 role_routing 时完全向后兼容 model_routing
        expect(
            resolveRoleRoute(poolRouting, 'fact-checker', 'audit', {
                model_routing: { audit: 'legacy-audit' }
            })
        ).toEqual({ provider: 'audit-provider', model: 'legacy-audit' });

        expect(
            resolveRoleReasoningEffort('writer', 'medium', {
                role_routing: { writer: { reasoning_effort: 'high' } }
            })
        ).toBe('high');
        expect(resolveRoleReasoningEffort('writer', 'medium', {}, 'low')).toBe('low');

        // 2. 无头端到端：验证 agents.create 模式与无 agents.create 兜底 runCleanroom 均按两层覆盖路由
        const bookRoot = await createGitBookWorkspace(tempDirs, 'role-routing-override');
        const cfgPath = join(bookRoot, 'world/book_config.yaml');
        const oldCfg = await readFile(cfgPath, 'utf8');
        await writeFile(
            cfgPath,
            [
                oldCfg.trimEnd(),
                'model_routing:',
                '  fast_retrieval: legacy-fast-model',
                'role_routing:',
                '  librarian:',
                '    tier: strong',
                '  planner:',
                '    tier: weak',
                '    reasoning_effort: low',
                '  writer:',
                '    model: custom-anthropic:claude-prose',
                '    reasoning_effort: high'
            ].join('\n') + '\n',
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', 'world/book_config.yaml']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: set role_routing']);

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
                        chapter_title: '路由测试',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '核对路由',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '核对', is_spotlight: true }
                        ],
                        outline_text: '沈默核对货单。'
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
                        chapter_summary: '路由测试完成。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('# 路由测试\n\n沈默合上货单，朝栈桥外走去。')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, {
            poolRouting,
            heartbeatIntervalMs: 0
        });
        registerCleanup(() => pipeFiber.dispose());

        await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '验证两层路由覆盖'
        });

        const librarianRun = agentRuns.find((r) => r.toolNames.includes('yield_context_pack'));
        const plannerRun = agentRuns.find((r) => r.toolNames.includes('yield_outline'));
        const writerRun = agentRuns.find((r) => r.sessionId.startsWith('narrate-writer-'));
        const factCheckerRun = agentRuns.find((r) => r.toolNames.includes('yield_verdict'));

        expect(librarianRun?.provider).toBe('deepseek-official');
        expect(librarianRun?.model).toBe('deepseek-v4-pro');
        expect(plannerRun?.provider).toBe('deepseek-official');
        expect(plannerRun?.model).toBe('legacy-fast-model');
        expect(plannerRun?.reasoningEffort).toBe(ReasoningEffortId('low'));
        expect(writerRun?.provider).toBe('custom-anthropic');
        expect(writerRun?.model).toBe('claude-prose');
        expect(writerRun?.reasoningEffort).toBe(ReasoningEffortId('high'));
        expect(factCheckerRun?.provider).toBe('audit-provider');
        expect(factCheckerRun?.model).toBe('audit-v1');

        // 3. 无 ctx.agents.create 时兜底 runCleanroom 也必须走 resolveRoleRoute 与 resolveRoleReasoningEffort
        const fallbackLlmCalls: Array<{ provider: string; model: string; reasoningEffort?: string }> = [];
        const fallbackCtx = new Context();
        fallbackCtx.provide('llm', {
            stream(opts: { provider: string; model: string; reasoningEffort?: string }) {
                fallbackLlmCalls.push({
                    provider: opts.provider,
                    model: opts.model,
                    ...(opts.reasoningEffort ? { reasoningEffort: String(opts.reasoningEffort) } : {})
                });
                return textToStreamChunks('# 兜底正文\n\n码头起风了。');
            }
        } as never);
        const fallbackStoreFiber = await fallbackCtx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => fallbackStoreFiber.dispose());
        const fallbackToolsFiber = await fallbackCtx.plugin(bookToolsPlugin);
        registerCleanup(() => fallbackToolsFiber.dispose());

        const bookCfg = await fallbackCtx.narrateStore.openStore(bookRoot).readBookConfig();
        const fallbackRunner = new RoleRunner({
            ctx: fallbackCtx,
            storeService: fallbackCtx.narrateStore,
            toolsService: fallbackCtx.narrateTools,
            roleLoader: new RoleLoader(),
            llmAdapter: new DshLlmAdapter(fallbackCtx.llm, { poolRouting }),
            poolRouting
        });
        const fallbackRes = await fallbackRunner.runCleanroom({
            roleId: 'writer',
            bookRoot,
            bookConfig: bookCfg,
            chapterNumber: 2,
            request: {
                staticPrefixBlocks: ['静态前缀'],
                dynamicTail: '第二章写作指令'
            }
        });
        expect(fallbackRes.response.modelId).toBe('claude-prose');
        expect(fallbackLlmCalls[0]).toEqual({
            provider: 'custom-anthropic',
            model: 'claude-prose',
            reasoningEffort: 'high'
        });
    });

    it('Audit #5: ensureChapterHeading 自动补全首行 # 标题（剥离第X章前缀、纯数字兜底）且已有 # 标题原样保留', async () => {
        expect(ensureChapterHeading('正文第一段。', 2, '第2章：潮汐账簿')).toBe('# 潮汐账簿\n\n正文第一段。');
        expect(ensureChapterHeading('正文第一段。', 2, '第十二章 暗潮')).toBe('# 暗潮\n\n正文第一段。');
        expect(ensureChapterHeading('正文第一段。', 2, '第二章')).toBe('# 2\n\n正文第一段。');
        expect(ensureChapterHeading('正文第一段。', 2)).toBe('# 2\n\n正文第一段。');
        expect(ensureChapterHeading('# 自定义标题\n\n正文第一段。', 2, '第2章：潮汐账簿')).toBe(
            '# 自定义标题\n\n正文第一段。'
        );

        const bookRoot = await createGitBookWorkspace(tempDirs, 'chapter-heading-fallback');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let writerCall = 0;
        let factCheckerDraftSeen = '';
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
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
                        chapter_title: '第1章：夜泊三号码头',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '查验潮汐单',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '查账', is_spotlight: true }
                        ],
                        outline_text: '沈默登船核对账簿。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    factCheckerDraftSeen = taskPrompt;
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '完成夜泊核对。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => {
                writerCall += 1;
                if (writerCall === 1) {
                    // 第 1 章 Writer 未输出 # 标题
                    return textToStreamChunks('<blocking>三号码头</blocking>\n\n沈默站在栈桥边，把灯绳绕回指节。');
                }
                // 第 2 章 Writer 已输出自定义 # 标题
                return textToStreamChunks('<blocking>货栈</blocking>\n\n# 潮起之时\n\n木门吱呀一声开了。');
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await ctx.narratePipeline.stepChapter({ chapterNumber: 1, chapterGoal: '无标题补全' });
        const ch1 = await readFile(join(bookRoot, 'manuscripts/ch_0001.md'), 'utf8');
        expect(ch1.startsWith('# 夜泊三号码头\n\n')).toBe(true);
        expect(factCheckerDraftSeen).toContain('[P0] # 夜泊三号码头');

        await ctx.narratePipeline.stepChapter({ chapterNumber: 2, chapterGoal: '已有标题保留' });
        const ch2 = await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8');
        expect(ch2.startsWith('# 潮起之时\n\n')).toBe(true);
        expect(ch2).not.toContain('# 夜泊三号码头');
    });

    it('Audit #4: Librarian 预注入 last_seen_ch 与冷宫档案清单，Extractor 预注入 world_state/open_threads/近期至多2条L2卡', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'audit-preinjection', {
            currentChapter: 3,
            storyDay: 4
        });
        await writeFile(
            join(bookRoot, 'entities/cold_archive/char_cold.md'),
            [
                '---',
                'entity_id: char_cold',
                'canonical_name: 旧港关长',
                'unique_aliases: []',
                'contextual_titles: []',
                'historical_anchors: []',
                'last_seen_ch: 1',
                '---',
                '',
                '## 1. Innate Locks',
                '- [vis: PUBLIC] 右手戴铜戒',
                '',
                '## 2. Acquired State',
                '- [day:1 | ch:1 | vis: PUBLIC] 已调离本港',
                '',
                '## 3. Irreversible Trajectory',
                '- [day:1 | ch:1] 调离',
                '',
                '## 4. Recent Sliding Buffer',
                '- [day:1 | ch:1] 离开三号码头'
            ].join('\n') + '\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            [
                '# 第 1 卷双轨章卡',
                '',
                '## ch_0001 (day:1)',
                '- 主干剧情：OLDER_CARD_CH1_SHOULD_BE_OMITTED',
                '- 出场实体：char_001',
                '',
                '## ch_0002 (day:2)',
                '- 主干剧情：RECENT_CARD_CH2_EXPECTED',
                '- 出场实体：char_001, char_002',
                '',
                '## ch_0003 (day:4)',
                '- 主干剧情：RECENT_CARD_CH3_EXPECTED',
                '- 出场实体：char_001'
            ].join('\n') + '\n',
            'utf8'
        );
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: add cold entity and l2 cards']);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let librarianPrompt = '';
        let extractorPrompt = '';

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    librarianPrompt = taskPrompt;
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '预注入验证',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '检查冷宫与L2注入',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '巡检', is_spotlight: true }
                        ],
                        outline_text: '沈默沿泊位巡检。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    extractorPrompt = taskPrompt;
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '第四章预注入验证完成。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('# 预注入验证\n\n沈默走过泊位，记录潮位刻度。')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await ctx.narratePipeline.stepChapter({
            chapterNumber: 4,
            chapterGoal: '检验 Librarian 与 Extractor 预注入上下文'
        });

        expect(librarianPrompt).toContain('[last_seen_ch=3]');
        expect(librarianPrompt).toContain('[last_seen_ch=0]');
        expect(librarianPrompt).toContain('char_cold');

        expect(extractorPrompt).toContain('海港处于封港戒备前夕');
        expect(extractorPrompt).toContain('黄铜钥匙究竟能打开哪一扇旧闸门');
        expect(extractorPrompt).toContain('RECENT_CARD_CH2_EXPECTED');
        expect(extractorPrompt).toContain('RECENT_CARD_CH3_EXPECTED');
        expect(extractorPrompt).not.toContain('OLDER_CARD_CH1_SHOULD_BE_OMITTED');
    });

    it('RoleRunner.runCleanroom 空输出在 runAgentSession 记为 failed（runs.jsonl 与 session_logs 一致），且支持仅发 block-end 文本块兜底', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'cleanroom-block-end-and-empty');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let streamMode: 'empty' | 'block-end-only' = 'empty';
        await createHeadlessMockServices(ctx, {
            onAgent: async () => {},
            onLlmStream: () => {
                if (streamMode === 'empty') {
                    return (async function* (): AsyncIterable<StreamChunk> {
                        yield { type: 'block-start', index: 0, blockType: 'text' };
                        yield { type: 'text-delta', index: 0, text: '   \n  ' };
                        yield { type: 'block-end', index: 0, block: { type: 'text', text: '   \n  ' } };
                        yield {
                            type: 'usage',
                            usage: {
                                inputTokens: 10,
                                outputTokens: 2,
                                cacheReadTokens: 0,
                                cacheWriteTokens: 0
                            }
                        };
                        yield { type: 'finish', reason: { kind: 'stop' } };
                    })();
                }
                return (async function* (): AsyncIterable<StreamChunk> {
                    yield { type: 'block-start', index: 0, blockType: 'text' };
                    yield {
                        type: 'block-end',
                        index: 0,
                        block: { type: 'text', text: '# 兜底正文\n\n仅通过 block-end 块输出的正文内容。' }
                    };
                    yield {
                        type: 'usage',
                        usage: {
                            inputTokens: 20,
                            outputTokens: 15,
                            cacheReadTokens: 0,
                            cacheWriteTokens: 0
                        }
                    };
                    yield { type: 'finish', reason: { kind: 'stop' } };
                })();
            }
        });

        const runner = new RoleRunner({
            ctx,
            storeService: ctx.narrateStore,
            toolsService: ctx.narrateTools,
            roleLoader: new RoleLoader(),
            llmAdapter: new DshLlmAdapter(ctx.llm, {
                poolRouting: {
                    strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
                    fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' },
                    audit: { provider: 'deepseek-official', model: 'deepseek-flash' }
                }
            }),
            poolRouting: {
                strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
                fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' },
                audit: { provider: 'deepseek-official', model: 'deepseek-flash' }
            }
        });

        // 1. 净室空输出必须抛出失败，且 runs.jsonl 与 session_logs/*.json 均准确落盘为 failed（无 completed 记录）
        streamMode = 'empty';
        await expect(
            runner.runCleanroom({
                roleId: 'writer',
                bookRoot,
                chapterNumber: 1,
                request: {
                    staticPrefixBlocks: ['静态前缀'],
                    dynamicTail: '第一章写作指令'
                }
            })
        ).rejects.toThrow('净室工种 writer 未输出有效正文文本');

        const runsAfterEmpty = await ctx.narrateStore.openStore().listRunRecords({ chapter: 1 });
        expect(runsAfterEmpty.some((r) => r.role === 'writer' && r.status === 'failed')).toBe(true);
        expect(runsAfterEmpty.some((r) => r.role === 'writer' && r.status === 'completed')).toBe(false);

        const logDir = join(bookRoot, '.ops/session_logs');
        const emptyLogFiles = await readdir(logDir);
        expect(emptyLogFiles.length).toBe(1);
        const failedLog = JSON.parse(await readFile(join(logDir, emptyLogFiles[0]!), 'utf8')) as {
            sessionId: string;
            status: string;
        };
        expect(failedLog.status).toBe('failed');

        // 2. 仅发 block-end 文本块（不发 text-delta）时，兜底收集完整正文并记录为 completed
        streamMode = 'block-end-only';
        const blockEndRes = await runner.runCleanroom({
            roleId: 'writer',
            bookRoot,
            chapterNumber: 2,
            request: {
                staticPrefixBlocks: ['静态前缀'],
                dynamicTail: '第二章写作指令'
            }
        });
        expect(blockEndRes.response.text).toBe('# 兜底正文\n\n仅通过 block-end 块输出的正文内容。');
        expect(blockEndRes.sessionId).toBeTruthy();

        const runsAfterBlockEnd = await ctx.narrateStore.openStore().listRunRecords({ chapter: 2 });
        expect(runsAfterBlockEnd.some((r) => r.role === 'writer' && r.status === 'completed')).toBe(true);

        const completedLog = JSON.parse(
            await readFile(join(logDir, `${blockEndRes.sessionId!}.json`), 'utf8')
        ) as {
            status: string;
            events: Array<{ kind: string; text?: string }>;
        };
        expect(completedLog.status).toBe('completed');
        expect(
            completedLog.events.some(
                (ev) => ev.kind === 'text' && ev.text === '# 兜底正文\n\n仅通过 block-end 块输出的正文内容。'
            )
        ).toBe(true);
    });

    it('Gate 超出2段但<=15段且<=60%优先触发 LOCAL_PATCH，FactChecker <=4段亦走带 proseGateOptions 的 LOCAL_PATCH', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'patch-threshold-and-fc');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let factCheckerRound = 0;
        let patchRoundSeen = 0;
        let fcPatchClicheRejected = false;

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
                        chapter_title: '阈值放宽修补',
                        target_word_count: 1800,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '三处事实与四处文风同时修正',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '核对', is_spotlight: true }
                        ],
                        outline_text: '沈默核对货单。'
                    });
                    return;
                }
                if (tools.has('yield_patched_draft')) {
                    patchRoundSeen += 1;
                    if (patchRoundSeen === 1) {
                        // 第 1 轮修补来自 StaticProseGate 4 个违规段（超过旧版 >2 即 REWRITE 阈值）
                        await execTool('patch_paragraphs', {
                            edits: [
                                { start_paragraph: 2, end_paragraph: 2, replacement_paragraphs: ['沈默把灯绳绕回铁钩。'] },
                                { start_paragraph: 4, end_paragraph: 4, replacement_paragraphs: ['他低声问了一句船期。'] },
                                { start_paragraph: 6, end_paragraph: 6, replacement_paragraphs: ['货栈外传来一声汽笛。'] },
                                { start_paragraph: 8, end_paragraph: 8, replacement_paragraphs: ['林小满合上算盘本。'] }
                            ]
                        });
                        await execTool('yield_patched_draft', { summary: '修正 4 段门禁违规' });
                        return;
                    }
                    // 第 2 轮修补来自 FactChecker（3 个段落）：先故意引入套话，验证 proseGateOptions 生效拦截
                    const badFcPatch = (await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 1,
                                end_paragraph: 1,
                                replacement_paragraphs: ['他指节泛白，喉结滚动。']
                            }
                        ]
                    })) as { passed: boolean };
                    expect(badFcPatch.passed).toBe(false);
                    try {
                        await execTool('yield_patched_draft', { summary: '含套话尝试提交' });
                    } catch {
                        fcPatchClicheRejected = true;
                    }
                    await execTool('patch_paragraphs', {
                        edits: [
                            { start_paragraph: 1, end_paragraph: 1, replacement_paragraphs: ['沈默站在三号泊位木棚下。'] },
                            { start_paragraph: 3, end_paragraph: 3, replacement_paragraphs: ['他右手拎着煤油灯。'] },
                            { start_paragraph: 5, end_paragraph: 5, replacement_paragraphs: ['桌角压着昨夜的船期单。'] }
                        ]
                    });
                    await execTool('yield_patched_draft', { summary: '修正 FactChecker 3 处事实偏差' });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    factCheckerRound += 1;
                    if (factCheckerRound === 1) {
                        await execTool('yield_verdict', {
                            passed: false,
                            issues: [
                                {
                                    severity: 'LOCAL_PATCH',
                                    paragraph_indices: [1, 3, 5],
                                    description: '泊位编号、提灯手别与船期单日期需按档案修正',
                                    quote_draft: '沈默站在二号泊位木棚下。',
                                    quote_source: '驻留节点：三号码头货栈',
                                    source_ref: 'entities/char_001.md'
                                }
                            ]
                        });
                        return;
                    }
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '完成多段局部修补验证。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks(
                    [
                        '沈默站在二号泊位木棚下。',
                        '他指节泛白地握住栏杆。',
                        '他左手拎着煤油灯。',
                        '他不由得停下脚步。',
                        '桌角压着前天的船期单。',
                        '他喉结滚动着咽了口唾沫。',
                        '海风吹得木门吱呀作响。',
                        '林小满下意识地往后缩了半步。',
                        '码头远处的铁锚落水。'
                    ].join('\n\n')
                )
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const res = await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '测试 Gate 4段与 FactChecker 3段局部修补路由'
        });

        expect(res.status).toBe('COMMITTED');
        expect(res.patchRounds).toBe(2);
        expect(res.rewriteCount).toBe(0);
        expect(patchRoundSeen).toBe(2);
        expect(fcPatchClicheRejected).toBe(true);
    });

    it('REWRITE 透传 stage/attempt/triggerReason 并正向转写 rewriteFeedback（零负面黑名单词与零全知/WARPED泄露）', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'rewrite-positive-feedback');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let writerAttempt = 0;
        let fcAttempt = 0;
        let rewritePhase: 'gate' | 'fc' = 'gate';
        const stageSessions: Array<{ stage: string; attempt?: number; triggerReason?: string }> = [];

        const { llmCalls } = await createHeadlessMockServices(ctx, {
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
                    await execTool('yield_outline', {
                        chapter_title: '重写校准',
                        target_word_count: 1600,
                        focus_cast: ['char_001'],
                        background_cast: ['char_002'],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '潮汐对不上',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '核对', is_spotlight: true }
                        ],
                        outline_text: '沈默在货栈核对潮汐账册。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    fcAttempt += 1;
                    if (fcAttempt === 1) {
                        await execTool('yield_verdict', {
                            passed: false,
                            issues: [
                                {
                                    severity: 'MULTI_REWRITE',
                                    paragraph_indices: [1, 2],
                                    description:
                                        '禁止跨越物理动线：第1段写沈默在东侧门，第2段直接写他在西库翻账册；严禁泄露 OMNISCIENT_SECRET_TOKEN 与 WARPED_SECRET_ENTRY。',
                                    quote_draft: '沈默推开铁门走进账房。',
                                    quote_source: '驻留节点：三号码头货栈',
                                    source_ref: 'entities/char_001.md'
                                }
                            ]
                        });
                        return;
                    }
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: '重写校准通过。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => {
                writerAttempt += 1;
                if (rewritePhase === 'gate' && writerAttempt === 1) {
                    // 3/4 段落违规 (75% > 60%)，直接触发 Gate REWRITE
                    return textToStreamChunks(
                        [
                            '他指节泛白，攥着钢笔。',
                            '他喉结滚动，目光落在账册上。',
                            '空气里飘着一丝铁锈味。'
                        ].join('\n\n')
                    );
                }
                return textToStreamChunks(
                    [
                        '沈默推开铁门走进账房。',
                        '煤油灯照亮摊开的潮汐账簿。',
                        '林小满把算盘推到桌角。'
                    ].join('\n\n')
                );
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        // 用 Ch.1 验证 Gate >60% 直接走 REWRITE -> SafeHalt 额度耗尽前先用无 FC 阻塞通过，再测 FC MULTI_REWRITE
        // 这里 Ch.1 在 writerAttempt 2 过 Gate，但因为 rewriteCount 已为 1 且 FC 返回 MULTI_REWRITE，预期触发 SafeHalt，
        // 若先只测 Gate REWRITE，我们在 writerAttempt===2 时让 FC 直接 pass；再单独跑 Ch.2 测 FC MULTI_REWRITE。
        // 调整：让 Ch.1 FC 直接 pass，先完整验证 Gate REWRITE，再用 Ch.2 验证 FactChecker MULTI_REWRITE。
        fcAttempt = 99;
        const gateRes = await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '测试 Gate 触发 REWRITE',
            onStageSession: (evt) => {
                stageSessions.push({
                    stage: evt.stage,
                    ...(evt.attempt !== undefined ? { attempt: evt.attempt } : {}),
                    ...(evt.triggerReason !== undefined ? { triggerReason: evt.triggerReason } : {})
                });
            }
        });

        expect(gateRes.status).toBe('COMMITTED');
        expect(gateRes.patchRounds).toBe(0);
        expect(gateRes.rewriteCount).toBe(1);

        const forbiddenTokens = [
            '禁止', '严禁', '不要', '不得', '切忌',
            '必须', '务必', '千万', '绝对', '哪怕', '就算', '即便',
            '指节', '喉结', '瞳孔', '睫毛', '一丝', '一抹',
            'OMNISCIENT_SECRET', 'WARPED', 'CHARTER_SECRET_ANCHOR',
            'DIRECTOR_SECRET_CEILING', 'SELF_ONLY_CHAR002_SECRET'
        ];
        expect(llmCalls.length).toBe(2);
        const gateRewritePrompt = `${llmCalls[1]!.options.system ?? ''}\n${JSON.stringify(llmCalls[1]!.options.messages)}`;
        expect(gateRewritePrompt).toContain('重写');
        for (const token of forbiddenTokens) {
            expect(gateRewritePrompt).not.toContain(token);
        }

        const ch1Runs = await ctx.narrateStore.openStore().listRunRecords({ chapter: 1 });
        expect(ch1Runs.some((r) => r.stage === 'WRITER' && r.status === 'completed')).toBe(true);
        expect(ch1Runs.some((r) => r.stage === 'REWRITE' && r.status === 'completed')).toBe(true);
        expect(stageSessions.some((s) => s.stage === 'REWRITE' && s.attempt === 1 && Boolean(s.triggerReason))).toBe(true);

        // Ch.2: 验证 FactChecker MULTI_REWRITE 触发 REWRITE 并对含敏感词/负面禁令词的问题做脱敏正向转写
        rewritePhase = 'fc';
        writerAttempt = 0;
        fcAttempt = 0;
        const ch2CallsBefore = llmCalls.length;
        const ch2Res = await ctx.narratePipeline.stepChapter({
            chapterNumber: 2,
            chapterGoal: '测试 FactChecker MULTI_REWRITE 正向转写'
        });
        expect(ch2Res.status).toBe('COMMITTED');
        expect(ch2Res.rewriteCount).toBe(1);

        const fcRewriteCall = llmCalls[ch2CallsBefore + 1]!;
        const fcRewritePrompt = `${fcRewriteCall.options.system ?? ''}\n${JSON.stringify(fcRewriteCall.options.messages)}`;
        expect(fcRewritePrompt).toContain('物理动线');
        expect(fcRewritePrompt).toContain('驻留节点：三号码头货栈');
        for (const token of forbiddenTokens) {
            expect(fcRewritePrompt).not.toContain(token);
        }

        const ch2Runs = await ctx.narrateStore.openStore().listRunRecords({ chapter: 2 });
        const ch2RewriteRun = ch2Runs.find((r) => r.stage === 'REWRITE' && r.status === 'completed');
        expect(ch2RewriteRun).toBeDefined();
    });

    it('session_logs 全量写入 requestInput (trace_level!==off)、放宽 tool-result 截断至 32000，且 Librarian 附加 <=60 字实体现状摘要', async () => {
        const longStatus = '在三号码头旧货栈西侧账房核查十余本发黄的潮汐登记簿并逐页比对进港船舶记录与夜班舵工签名直到天亮前仍未合眼';
        const bookRoot = await createGitBookWorkspace(tempDirs, 'request-input-and-entity-summary', {
            extraEntities: {
                char_long_state: [
                    '---',
                    'entity_id: char_long_state',
                    'canonical_name: 赵老五',
                    'unique_aliases: []',
                    'contextual_titles: []',
                    'historical_anchors: []',
                    'last_seen_ch: 1',
                    '---',
                    '',
                    '## 1. Innate Locks',
                    '- [vis: PUBLIC] 右脚微跛',
                    '',
                    '## 2. Acquired State & Numeric Ledger',
                    `- [day:1 | ch:1 | vis: PUBLIC] ${longStatus}`,
                    '- [day:1 | ch:1 | vis: PUBLIC | status: WARPED] WARPED_SHOULD_SKIP_THIS',
                    '- [day:1 | ch:1 | vis: OMNISCIENT_SECRET] OMNISCIENT_SHOULD_SKIP_THIS',
                    '',
                    '## 3. Irreversible Trajectory',
                    '- [day:1 | ch:1] 受雇看守二号库',
                    '',
                    '## 4. Recent Sliding Buffer & Voice',
                    '- [day:1 | ch:1] 提着马灯巡夜'
                ].join('\n'),
                char_buffer_only: [
                    '---',
                    'entity_id: char_buffer_only',
                    'canonical_name: 钱大',
                    'unique_aliases: []',
                    'contextual_titles: []',
                    'historical_anchors: []',
                    'last_seen_ch: 1',
                    '---',
                    '',
                    '## 1. Innate Locks',
                    '- [vis: PUBLIC] 嗓音沙哑',
                    '',
                    '## 2. Acquired State & Numeric Ledger',
                    '',
                    '## 3. Irreversible Trajectory',
                    '- [day:1 | ch:1] 进港卸货',
                    '',
                    '## 4. Recent Sliding Buffer & Voice',
                    '- [day:1 | ch:1] 在西栈桥搬运盐包'
                ].join('\n')
            }
        });

        // 写入一个 >2000 字符的设定文件，验证 tool-result 不再于 800 字符处截断
        const longLoreContent = `# 海港潮汐细则\n\n${'A'.repeat(2100)}_END_MARKER`;
        await writeFile(join(bookRoot, 'lore_library/lore_tide_rules.md'), longLoreContent, 'utf8');
        await execFileAsync('git', ['-C', bookRoot, 'add', '.']);
        await execFileAsync('git', ['-C', bookRoot, 'commit', '-m', 'chore: add long lore and entities']);

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        let capturedLibrarianPrompt = '';
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    capturedLibrarianPrompt = taskPrompt;
                    await execTool('book_read', { path: 'lore_library/lore_tide_rules.md' });
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '留档与摘要',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '查验档案',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '核对', is_spotlight: true }
                        ],
                        outline_text: '沈默核对三号码头档案。'
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
                        chapter_summary: '完成留档与摘要验证。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('# 留档与摘要\n\n沈默合上潮汐细则册，转身离开货栈。')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const sessions: Array<{ stage: string; sessionId: string }> = [];
        await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '验证 requestInput、32000 tool-result 与实体摘要',
            onStageSession: (evt) => sessions.push({ stage: evt.stage, sessionId: evt.sessionId })
        });

        // 1. 验证 Librarian 实体现状摘要（<=60 字、跳过 WARPED/OMNISCIENT_SECRET、空 acquiredState 回退 recentBuffer）
        const entityLines = capturedLibrarianPrompt
            .split('\n')
            .filter((line) => line.startsWith('- char_'));
        const longLine = entityLines.find((line) => line.startsWith('- char_long_state:'));
        expect(longLine).toBeDefined();
        expect(longLine!).not.toContain('WARPED_SHOULD_SKIP_THIS');
        expect(longLine!).not.toContain('OMNISCIENT_SHOULD_SKIP_THIS');
        const longSummaryPart = longLine!.split('现状: ')[1]?.trim() ?? '';
        expect(longSummaryPart.length).toBeGreaterThan(0);
        expect(longSummaryPart.length).toBeLessThanOrEqual(60);

        const bufferLine = entityLines.find((line) => line.startsWith('- char_buffer_only:'));
        expect(bufferLine).toContain('在西栈桥搬运盐包');

        // 2. 验证 Librarian session_logs 包含完整 requestInput 与超过 800 字符的 tool-result
        const libSession = sessions.find((s) => s.stage === 'LIBRARIAN');
        expect(libSession).toBeDefined();
        const libLog = JSON.parse(
            await readFile(join(bookRoot, `.ops/session_logs/${libSession!.sessionId}.json`), 'utf8')
        ) as {
            requestInput?: {
                systemPrompt?: string;
                taskPromptBlocks?: string[];
                temperature?: number;
                reasoningEffort?: string;
                pool?: string;
                tools?: string[];
            };
            events: Array<{ kind: string; toolName?: string; text?: string }>;
        };
        expect(libLog.requestInput).toBeDefined();
        expect(libLog.requestInput?.systemPrompt).toContain('Librarian');
        expect(libLog.requestInput?.taskPromptBlocks?.[0]).toContain('char_long_state');
        expect(libLog.requestInput?.pool).toBe('fast_retrieval');
        expect(libLog.requestInput?.tools).toContain('book_read');
        expect(typeof libLog.requestInput?.temperature).toBe('number');

        const readResultEvent = libLog.events.find(
            (ev) => ev.kind === 'tool-result' && ev.toolName === 'book_read'
        );
        expect(readResultEvent?.text).toContain('_END_MARKER');
        expect((readResultEvent?.text ?? '').length).toBeGreaterThan(2000);

        // 3. 验证 trace_level='off' 时不写入 requestInput
        const cfgPath = join(bookRoot, 'world/book_config.yaml');
        const oldCfg = await readFile(cfgPath, 'utf8');
        await writeFile(cfgPath, oldCfg.replace('trace_level: full', 'trace_level: off'), 'utf8');
        const offSessions: Array<{ stage: string; sessionId: string }> = [];
        await ctx.narratePipeline.stepChapter({
            chapterNumber: 2,
            chapterGoal: '验证 trace_level=off 不写入 requestInput',
            onStageSession: (evt) => offSessions.push({ stage: evt.stage, sessionId: evt.sessionId })
        });
        const offLibSession = offSessions.find((s) => s.stage === 'LIBRARIAN');
        const offLibLog = JSON.parse(
            await readFile(join(bookRoot, `.ops/session_logs/${offLibSession!.sessionId}.json`), 'utf8')
        ) as { requestInput?: unknown };
        expect(offLibLog.requestInput).toBeUndefined();
    });

    it('sanitizeTextForCleanroomWriter 正确切分 ASCII 分号、剔除 SELF_ONLY/禁令/身体解剖词，且 LOCAL_PATCH（含 cleanroom=true）禁止 fail-open 回退原始 reason', async () => {
        // 1. 单元测试：ASCII `;` 分句 + `\bSELF_ONLY\b` + 扩展否定词 + 空残余子句丢弃
        expect(
            sanitizeTextForCleanroomWriter(
                '请保持码头夜班节奏; 严禁泄露 SELF_ONLY 秘密; 不可写指节、喉结与瞳孔; 切勿泄露 OMNISCIENT_SECRET_X；指节；。'
            )
        ).toBe('请保持码头夜班节奏; 请调整写、与;');

        expect(
            sanitizeTextForCleanroomWriter(
                '不能、不可、避免、切勿、莫要、绝不、决不、勿泄露; SELF_ONLY 隐秘; 指节；瞳孔；'
            )
        ).toBe('请调整、请调整、请调整、请调整、请调整、请调整、请调整、请调整泄露;');

        expect(
            sanitizeTextForCleanroomWriter('严禁泄露 SELF_ONLY 情报; 禁止触犯 Stage Ceiling。')
        ).toBe('');

        // 2. 集成测试：cleanroom=false 默认 Patch 模式禁止回退原始敏感 reason 且物理剥离受限 quote_source；cleanroom=true 单书覆盖显式拒止
        const runPatchSanitizeCheck = async (cleanroomOverride: boolean) => {
            const bookRoot = await createGitBookWorkspace(
                tempDirs,
                `patch-no-failopen-${cleanroomOverride ? 'cleanroom' : 'memory'}`
            );
            if (cleanroomOverride) {
                await mkdir(join(bookRoot, 'world/roles/prompts'), { recursive: true });
                await writeFile(
                    join(bookRoot, 'world/roles/prompts/patch.md'),
                    '# 单书 Patch 净室提示词\n\n禁止配置。',
                    'utf8'
                );
                await writeFile(
                    join(bookRoot, 'world/roles/patch.yml'),
                    [
                        'id: patch',
                        'pool: strong_creative',
                        'reasoningEffort: low',
                        'cleanroom: true',
                        'promptFile: prompts/patch.md',
                        'temperature: 0.4',
                        'maxSteps: 1',
                        'maxReadCalls: 0',
                        'tools: []',
                        'yieldTool: null'
                    ].join('\n'),
                    'utf8'
                );
            }

            const ctx = new Context();
            const promptFiber = await ctx.plugin(SystemPrompt);
            registerCleanup(() => promptFiber.dispose());
            const toolsFiber = await ctx.plugin(ToolsService);
            registerCleanup(() => toolsFiber.dispose());
            const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
            registerCleanup(() => storeFiber.dispose());
            const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
            registerCleanup(() => bookToolsFiber.dispose());

            let fcCalls = 0;
            let capturedPatchPrompt = '';

            await createHeadlessMockServices(ctx, {
                onAgent: async ({ tools, execTool, taskPrompt }) => {
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
                            chapter_title: '防泄漏修补',
                            target_word_count: 1500,
                            focus_cast: ['char_001'],
                            background_cast: [],
                            ending_beat: 'HOOK',
                            director_rationale: '秘辛',
                            chapter_turn: '检查栈桥铁门',
                            scene_plan: [
                                { scene_index: 1, location: '码头', summary: '巡夜', is_spotlight: true }
                            ],
                            outline_text: '沈默核查三号码头铁门锁舌。'
                        });
                        return;
                    }
                    if (tools.has('yield_patched_draft')) {
                        capturedPatchPrompt = taskPrompt;
                        await execTool('patch_paragraphs', {
                            edits: [
                                {
                                    start_paragraph: 1,
                                    end_paragraph: 1,
                                    replacement_paragraphs: ['沈默抬手摸到铁门冰凉的锁舌。']
                                }
                            ]
                        });
                        await execTool('yield_patched_draft', { summary: '安全修补' });
                        return;
                    }
                    if (tools.has('yield_verdict')) {
                        fcCalls += 1;
                        if (fcCalls === 1) {
                            await execTool('yield_verdict', {
                                passed: false,
                                issues: [
                                    {
                                        severity: 'LOCAL_PATCH',
                                        paragraph_index: 1,
                                        description: '严禁泄露 SELF_ONLY 秘密; 禁止触犯 Stage Ceiling。',
                                        quote_draft: '沈默想起铁箱里的隐秘。',
                                        quote_source: '驻留节点：三号码头货栈',
                                        source_ref: 'entities/char_001.md'
                                    }
                                ]
                            });
                            return;
                        }
                        await execTool('yield_verdict', { passed: true, issues: [] });
                        return;
                    }
                    if (tools.has('yield_state_patch')) {
                        await execTool('yield_state_patch', {
                            entity_patches: [],
                            story_day_delta: 0,
                            chapter_summary: '完成防泄漏局部修补验证。',
                            next_chapter_options: ['继续']
                        });
                    }
                },
                onLlmStream: () => textToStreamChunks('# 防泄漏修补\n\n沈默想起铁箱里的隐秘。')
            });

            const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
            registerCleanup(() => pipeFiber.dispose());

            if (cleanroomOverride) {
                await expect(
                    ctx.narratePipeline.stepChapter({
                        chapterNumber: 1,
                        chapterGoal: '验证 cleanroom=true Patch 显式报错'
                    })
                ).rejects.toThrow(/cleanroom=false/);
                return;
            }

            const res = await ctx.narratePipeline.stepChapter({
                chapterNumber: 1,
                chapterGoal: '验证 Patch 不 fail-open'
            });
            expect(res.status).toBe('COMMITTED');
            expect(capturedPatchPrompt).toContain(CLEANROOM_PATCH_FALLBACK_REASON);
            expect(capturedPatchPrompt).not.toContain('SELF_ONLY');
            expect(capturedPatchPrompt).not.toContain('Stage Ceiling');
            expect(capturedPatchPrompt).not.toContain('严禁');
            expect(capturedPatchPrompt).not.toContain('禁止');
            expect(capturedPatchPrompt).not.toContain('## 事实核查修补清单');
            expect(capturedPatchPrompt).not.toContain('- [1] ');
        };

        await runPatchSanitizeCheck(false);
        await runPatchSanitizeCheck(true);
    });

    it('PLAN_CONFLICT 触发 REPLAN 记录真实 REPLAN 阶段、递增 writerAttempt，且 StaticProseGate 传入 maxPatchParagraphs=15', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'replan-and-gate-max-patch');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        const capturedGateOptions: Array<number | undefined> = [];
        const customGate = new bookStorePlugin.StaticProseGate();
        const origEvaluate = customGate.evaluate.bind(customGate);
        customGate.evaluate = (text, opts = {}) => {
            capturedGateOptions.push(opts.maxPatchParagraphs);
            return origEvaluate(text, opts);
        };

        let plannerCount = 0;
        let fcCount = 0;
        let writerCount = 0;
        const stageSessions: Array<{ stage: string; attempt?: number; triggerReason?: string }> = [];

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
                    plannerCount += 1;
                    await execTool('yield_outline', {
                        chapter_title: plannerCount === 1 ? '细纲初稿' : '细纲重排',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: plannerCount === 1 ? '初版转折' : '修正后转折',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '排查', is_spotlight: true }
                        ],
                        outline_text:
                            plannerCount === 1
                                ? '沈默翻找铁箱。'
                                : '沈默按正常物理路径绕过封锁线检查铁箱。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    fcCount += 1;
                    if (fcCount === 1) {
                        await execTool('yield_verdict', {
                            passed: false,
                            issues: [
                                {
                                    severity: 'PLAN_CONFLICT',
                                    paragraph_index: 1,
                                    description: '细纲要求直接穿墙进入封锁区，违背物理连通规则',
                                    quote_draft: '沈默直接走进内库。',
                                    quote_source: '驻留节点：三号码头货栈',
                                    source_ref: 'entities/char_001.md'
                                }
                            ]
                        });
                        return;
                    }
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 0,
                        chapter_summary: 'REPLAN 重排并二次出稿通过。',
                        next_chapter_options: ['继续']
                    });
                }
            },
            onLlmStream: () => {
                writerCount += 1;
                if (writerCount === 1) {
                    return textToStreamChunks('# 细纲初稿\n\n沈默直接走进内库。');
                }
                return textToStreamChunks('# 细纲重排\n\n沈默沿外廊绕行，验看封条后走进货栈。');
            }
        });

        const pipeline = new pipelinePlugin.ChapterPipeline({
            store: ctx.narrateStore.openStore(bookRoot),
            roleRunner: new RoleRunner({
                ctx,
                storeService: ctx.narrateStore,
                toolsService: ctx.narrateTools,
                roleLoader: new RoleLoader(),
                llmAdapter: new DshLlmAdapter(ctx.llm, {
                    poolRouting: {
                        strong_creative: { provider: 'mock', model: 'mock-strong' },
                        fast_retrieval: { provider: 'mock', model: 'mock-fast' },
                        audit: { provider: 'mock', model: 'mock-audit' }
                    }
                }),
                poolRouting: {
                    strong_creative: { provider: 'mock', model: 'mock-strong' },
                    fast_retrieval: { provider: 'mock', model: 'mock-fast' },
                    audit: { provider: 'mock', model: 'mock-audit' }
                }
            }),
            roleLoader: new RoleLoader(),
            llm: new DshLlmAdapter(ctx.llm, {
                poolRouting: {
                    strong_creative: { provider: 'mock', model: 'mock-strong' },
                    fast_retrieval: { provider: 'mock', model: 'mock-fast' },
                    audit: { provider: 'mock', model: 'mock-audit' }
                }
            }),
            system: ctx.narrateStore.system,
            gate: customGate
        });

        const res = await pipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '验证 REPLAN 与 writerAttempt 递增',
            onStageSession: (evt) => {
                stageSessions.push({
                    stage: evt.stage,
                    ...(evt.attempt !== undefined ? { attempt: evt.attempt } : {}),
                    ...(evt.triggerReason !== undefined ? { triggerReason: evt.triggerReason } : {})
                });
            }
        });

        expect(res.status).toBe('COMMITTED');
        expect(res.replanCount).toBe(1);
        expect(capturedGateOptions.length).toBeGreaterThanOrEqual(2);
        for (const maxPatch of capturedGateOptions) {
            expect(maxPatch).toBe(GATE_MAX_PATCH_PARAGRAPHS);
            expect(maxPatch).toBe(15);
        }

        // 验证 onStageSession 回调与 .ops/runs.jsonl 均记录 PLANNER(1) -> WRITER(1) -> REPLAN(2, FACT_PLAN_CONFLICT) -> WRITER(2)
        expect(stageSessions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ stage: 'PLANNER', attempt: 1 }),
                expect.objectContaining({ stage: 'WRITER', attempt: 1 }),
                expect.objectContaining({
                    stage: 'REPLAN',
                    attempt: 2,
                    triggerReason: 'FACT_PLAN_CONFLICT'
                }),
                expect.objectContaining({ stage: 'WRITER', attempt: 2 })
            ])
        );

        const runsRaw = await readFile(join(bookRoot, '.ops/runs.jsonl'), 'utf8');
        const runs = runsRaw
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
            .map(
                (line) =>
                    JSON.parse(line) as {
                        stage: string;
                        status: string;
                        attempt?: number;
                        triggerReason?: string;
                    }
            );
        expect(
            runs.some(
                (r) =>
                    r.stage === 'REPLAN' &&
                    r.status === 'completed' &&
                    r.attempt === 2 &&
                    r.triggerReason === 'FACT_PLAN_CONFLICT'
            )
        ).toBe(true);
        const writerCompletedAttempts = runs
            .filter((r) => r.stage === 'WRITER' && r.status === 'completed')
            .map((r) => r.attempt);
        expect(writerCompletedAttempts).toEqual([1, 2]);
    });
});

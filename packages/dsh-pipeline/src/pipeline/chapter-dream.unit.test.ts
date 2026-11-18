import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import * as bookToolsPlugin from '@narrateos/dsh-book-tools';
import { afterEach, describe, expect, it } from 'vitest';
import * as pipelinePlugin from '../index.js';
import { RoleLoader } from '../roles/role-loader.js';
import { DshLlmAdapter, resolvePoolRoute, resolveRoleRoute } from '../runner/dsh-llm-adapter.js';
import { RoleRunner } from '../runner/role-runner.js';
import {
    createGitBookWorkspace,
    createHeadlessMockServices,
    textToStreamChunks
} from '../test-harness.js';
import {
    clearHealPlan,
    readHealPlan,
    readSignalsCursorState,
    resolveSignalId,
    upsertVolumeCardEntry,
    writeHealPlan,
    writeSignalsCursorState
} from './helpers.js';
import { harvestVoiceFromChapter, harvestVoiceWithPool } from './voice-harvest.js';

const tempDirs: string[] = [];
const cleanupCallbacks: Array<() => Promise<void> | void> = [];

async function isWorkingTreeClean(bookRoot: string): Promise<boolean> {
    return await new bookStorePlugin.NodeSystemAdapter().isWorkingTreeClean(bookRoot);
}

async function setupBookGitignoreAndCommit(
    bookRoot: string,
    extraPaths: readonly string[],
    message: string
): Promise<void> {
    // 仅忽略运行时日志/追踪文件（故意不忽略 .ops/pending_writes.json 与 .ops/signals_cursor.json，以严格验证原子提交与清理）
    await writeFile(
        join(bookRoot, '.gitignore'),
        ['.ops/traces/', '.ops/session_logs/', '.ops/runs.jsonl', ''].join('\n'),
        'utf8'
    );
    await new bookStorePlugin.NodeSystemAdapter().commitPaths(
        bookRoot,
        ['.gitignore', ...extraPaths],
        message
    );
}

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

describe('Wave 3A Chapter & Dreaming 核心机制单测与回归验证', () => {
    it('RoleLoader 支持 blockedReadPaths 解析并拦截符号链接逃逸 bookRoot', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'role-loader-symlink');
        const outsideDir = await mkdtemp(join(tmpdir(), 'outside-secret-'));
        tempDirs.push(outsideDir);
        const secretPromptPath = join(outsideDir, 'leak.md');
        await writeFile(secretPromptPath, '# 外部越权提示词\n', 'utf8');

        await mkdir(join(bookRoot, 'world/roles/prompts'), { recursive: true });
        await writeFile(join(bookRoot, 'world/roles/prompts/librarian.md'), '本地提示词\n', 'utf8');
        await writeFile(
            join(bookRoot, 'world/roles/librarian.yml'),
            [
                'id: librarian',
                'pool: fast_retrieval',
                'cleanroom: false',
                'promptFile: ./prompts/librarian.md',
                'temperature: 0.2',
                'maxSteps: 6',
                'maxReadCalls: 4',
                'blockedReadPaths:',
                '  - world/author_charter.md',
                '  - world/arc_director_plan.md',
                'tools:',
                '  - book_read',
                'yieldTool: yield_context_pack'
            ].join('\n') + '\n',
            'utf8'
        );

        const loader = new RoleLoader();
        const cfg = await loader.loadRoleConfig('librarian', bookRoot);
        expect(cfg.blockedReadPaths).toEqual([
            'world/author_charter.md',
            'world/arc_director_plan.md'
        ]);

        // promptFile 指向逃逸出 bookRoot 的符号链接时必须被 realpath 校验拒绝
        await rm(join(bookRoot, 'world/roles/prompts/librarian.md'), { force: true });
        await symlink(secretPromptPath, join(bookRoot, 'world/roles/prompts/librarian.md'));
        await expect(loader.loadRoleConfig('librarian', bookRoot)).rejects.toThrow(
            /符号链接|越界/
        );
    });

    it('RoleLoader 与 resolvePoolRoute/resolveRoleRoute 对旧书残留 audit 配置无损回退至 strong_creative', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'legacy-audit-fallback');
        await mkdir(join(bookRoot, 'world/roles/prompts'), { recursive: true });
        await writeFile(join(bookRoot, 'world/roles/prompts/fact-checker.md'), '核查提示词正文\n', 'utf8');
        await writeFile(
            join(bookRoot, 'world/roles/fact-checker.yml'),
            [
                'id: fact-checker',
                'pool: audit',
                'cleanroom: false',
                'promptFile: ./prompts/fact-checker.md',
                'temperature: 0.1',
                'maxSteps: 6',
                'maxReadCalls: 5',
                'tools:',
                '  - book_read',
                'yieldTool: yield_verdict'
            ].join('\n') + '\n',
            'utf8'
        );

        const loader = new RoleLoader();
        const loaded = await loader.loadRoleConfig('fact-checker', bookRoot);
        expect(loaded.pool).toBe('strong_creative');

        const dualPoolRouting = {
            strong_creative: { provider: 'openai', model: 'gpt-5-prose' },
            fast_retrieval: { provider: 'openai', model: 'gpt-5-mini' }
        };
        expect(resolvePoolRoute(dualPoolRouting, 'audit')).toEqual({
            provider: 'openai',
            model: 'gpt-5-prose'
        });
        expect(
            resolveRoleRoute(dualPoolRouting, 'fact-checker', 'audit', {
                model_routing: { strong_creative: 'anthropic:claude-sonnet-4-5' }
            })
        ).toEqual({
            provider: 'anthropic',
            model: 'claude-sonnet-4-5'
        });
        expect(
            resolveRoleRoute(dualPoolRouting, 'fact-checker', 'audit', {
                model_routing: { audit: 'legacy-audit-model' }
            })
        ).toEqual({
            provider: 'openai',
            model: 'legacy-audit-model'
        });
    });

    it('DshLlmAdapter 解析 provider:model 复合路由，RoleRunner 保证 beginRun 失败必落账、会话清理跨书隔离且透传真实 finishReason', async () => {
        const route = resolvePoolRoute(
            {
                strong_creative: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
                fast_retrieval: { provider: 'deepseek-official', model: 'deepseek-flash' },
                audit: { provider: 'deepseek-official', model: 'deepseek-flash' }
            },
            'strong_creative',
            { model_routing: { strong_creative: 'anthropic:claude-sonnet-4-5' } }
        );
        expect(route).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });

        const bookRootA = await createGitBookWorkspace(tempDirs, 'runner-book-a');
        const bookRootB = await createGitBookWorkspace(tempDirs, 'runner-book-b');

        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot: bookRootA });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        await createHeadlessMockServices(ctx, {
            onAgent: async () => {},
            onLlmStream: () =>
                (async function* (): AsyncGenerator<StreamChunk> {
                    yield {
                        type: 'text-delta',
                        index: 0,
                        text: '被截断的正文片段'
                    } as unknown as StreamChunk;
                    yield {
                        type: 'finish',
                        reason: { kind: 'max-tokens' },
                        usage: { inputTokens: 10, outputTokens: 5 }
                    } as unknown as StreamChunk;
                })()
        });

        const incompleteRouting = {
            fast_retrieval: { provider: 'deepseek', model: 'flash' }
        } as unknown as {
            strong_creative: { provider: string; model: string };
            fast_retrieval: { provider: string; model: string };
        };
        const errorRunner = new RoleRunner({
            ctx,
            storeService: ctx.narrateStore,
            toolsService: ctx.narrateTools,
            roleLoader: new RoleLoader(),
            llmAdapter: new DshLlmAdapter(ctx.llm, { poolRouting: incompleteRouting }),
            poolRouting: incompleteRouting
        });

        // 1. resolveRoleRoute 早期抛错时，beginRun 已入 try 块，runs.jsonl 必须收口为 failed 且 activeCount=0
        await expect(
            errorRunner.runMultiTurn({
                roleId: 'fact-checker',
                stage: 'FACT_CHECK',
                chapterNumber: 1,
                bookRoot: bookRootA,
                taskPrompt: '触发早期路由错误'
            })
        ).rejects.toThrow(/未配置模型池路由/);
        expect(errorRunner.activeCount).toBe(0);
        const runsAfterErr = await ctx.narrateStore.openStore().listRunRecords({ chapter: 1 });
        expect(runsAfterErr.some((r) => r.status === 'failed')).toBe(true);

        const runner = new RoleRunner({
            ctx,
            storeService: ctx.narrateStore,
            toolsService: ctx.narrateTools,
            roleLoader: new RoleLoader(),
            llmAdapter: new DshLlmAdapter(ctx.llm, {
                poolRouting: {
                    strong_creative: { provider: 'deepseek', model: 'v4' },
                    fast_retrieval: { provider: 'deepseek', model: 'flash' },
                    audit: { provider: 'deepseek', model: 'flash' }
                }
            }),
            poolRouting: {
                strong_creative: { provider: 'deepseek', model: 'v4' },
                fast_retrieval: { provider: 'deepseek', model: 'flash' },
                audit: { provider: 'deepseek', model: 'flash' }
            }
        });

        // 2. runCleanroom 透传流式 finishReason === 'max-tokens'，完成后立即清理 liveSessionDetails 并支持按 bookRoot 隔离读取
        const cleanRes = await runner.runCleanroom({
            roleId: 'writer',
            stage: 'WRITER',
            chapterNumber: 1,
            bookRoot: bookRootA,
            request: {
                staticPrefixBlocks: ['静态前缀'],
                dynamicTail: '动态尾'
            }
        });
        expect(cleanRes.response.finishReason).toBe('max-tokens');
        expect(cleanRes.response.text).toBe('被截断的正文片段');
        expect(cleanRes.sessionId).toBeDefined();
        const sid = cleanRes.sessionId!;
        expect(runner.getLiveSessionDetail(sid, bookRootA)).toBeUndefined();
        expect(await runner.getSessionDetail(sid, bookRootA)).not.toBeNull();
        expect(await runner.getSessionDetail(sid, bookRootB)).toBeNull();
    });

    it('helpers 双轨章卡、游标/自愈断点读写与 voice-harvest Q2 滚动替换 boot_seed（保留 author_sample 与 LRU）', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'helpers-voice-q2');

        const updatedL2 = upsertVolumeCardEntry(
            null,
            1,
            1,
            1,
            '沈默夜探三号码头。',
            ['char_001', 'char_001'],
            ['黄铜提灯', '327号货箱']
        );
        expect(updatedL2).toContain('## ch_0001 (day:1)');
        expect(updatedL2).toContain('- 主干剧情：沈默夜探三号码头。');
        expect(updatedL2).toContain('- 异象锚点：黄铜提灯、327号货箱');
        expect(updatedL2).toContain('- 出场实体：char_001');

        await writeSignalsCursorState(bookRoot, {
            consumedLines: 2,
            consumedIds: ['sig_a', 'sig_b', 'sig_a']
        });
        const cursor = await readSignalsCursorState(bookRoot);
        expect(cursor.consumedLines).toBe(2);
        expect(cursor.consumedIds).toEqual(['sig_a', 'sig_b']);

        await writeHealPlan(bookRoot, {
            conflictId: 'c-1',
            backupTag: 'backup/pre-heal-ch-0002-1',
            fromChapter: 2,
            toChapter: 3,
            nextChapter: 2,
            constraint: '修正铁表颜色'
        });
        expect((await readHealPlan(bookRoot))?.nextChapter).toBe(2);
        await clearHealPlan(bookRoot);
        expect(await readHealPlan(bookRoot)).toBeNull();

        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const store = ctx.narrateStore.openStore();

        const initialPool: bookStorePlugin.VoiceSamplePool = {
            samples: [
                {
                    id: 'v_author',
                    tag: '日常对话',
                    text: '他把茶杯推回桌沿，没再多说半个字。',
                    source: 'author_sample',
                    last_used_ch: 1,
                    use_count: 4
                },
                {
                    id: 'v_boot_1',
                    tag: '动作紧张',
                    text: '指尖扣住门栓，屏住呼吸听门外脚步声。',
                    source: 'boot_seed',
                    last_used_ch: 1,
                    use_count: 1
                }
            ]
        };

        const mockLlm: bookStorePlugin.LlmPort = {
            generate: async () => ({
                text: JSON.stringify({
                    samples: [
                        // 含主角专名"沈默"，应被脱专名过滤拦截
                        { tag: '动作紧张', text: '沈默猛地拽开门栓冲进雨里。' },
                        // 合法去专名且过静态门禁
                        { tag: '动作紧张', text: '风衣领口灌满冷雨，靴底踩碎积水一步跨过门槛。' }
                    ]
                }),
                usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 }
            })
        };

        const harvestRes = await harvestVoiceWithPool({
            store,
            llm: mockLlm,
            chapterNumber: 2,
            chapterText: '# 第二章\n\n风衣领口灌满冷雨，靴底踩碎积水一步跨过门槛。\n',
            currentPool: initialPool,
            entityNames: ['沈默'],
            rollingReplaceBootSeeds: true,
            writeToDisk: false
        });

        expect(harvestRes.replacedIds).toEqual(['v_boot_1']);
        expect(harvestRes.updatedPool.samples.find((s) => s.id === 'v_author')).toEqual(
            initialPool.samples[0]
        );
        expect(harvestRes.updatedPool.samples.some((s) => s.id === 'v_boot_1')).toBe(false);
        const replaced = harvestRes.updatedPool.samples.find(
            (s) => s.source === 'chapter_harvest'
        );
        expect(replaced?.text).toContain('风衣领口灌满冷雨');
    });

    it('Q1/Q2/Q3/Q6/Q9 与三态隔离/冷宫唤醒/崩溃恢复：单章管线端到端不变量', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'chapter-invariants', {
            extraEntities: {
                char_002: [
                    '---',
                    'entity_id: char_002',
                    'entity_type: character',
                    'canonical_name: 林远',
                    'unique_aliases: []',
                    'status: ACTIVE',
                    'last_seen_ch: 1',
                    '---',
                    '',
                    '## 1. 固有属性锁 (Innate Locks)',
                    '- [slot:job | vis:PUBLIC | owner:char_002] 夜班记录员',
                    '',
                    '## 2. 当前状态槽 (Acquired State)',
                    '',
                    '## 3. 历史履历 (Irreversible Trajectory)',
                    '',
                    '## 4. 近期缓冲 (Recent Buffer)',
                    ''
                ].join('\n')
            }
        });
        await mkdir(join(bookRoot, 'entities/cold_archive'), { recursive: true });
        await writeFile(
            join(bookRoot, 'entities/cold_archive/char_099.md'),
            [
                '---',
                'entity_id: char_099',
                'entity_type: character',
                'canonical_name: 程三爷',
                'unique_aliases: ["程三"]',
                'status: ACTIVE',
                'last_seen_ch: 1',
                '---',
                '',
                '## 1. 固有属性锁 (Innate Locks)',
                '- [slot:identity | vis:PUBLIC | owner:char_099] 旧港老验船师',
                '',
                '## 2. 当前状态槽 (Acquired State)',
                '- [slot:residence | vis:PUBLIC | owner:char_099] 退隐老码头茶馆',
                '',
                '## 3. 历史履历 (Irreversible Trajectory)',
                '',
                '## 4. 近期缓冲 (Recent Buffer)',
                ''
            ].join('\n'),
            'utf8'
        );

        // 打开 hybrid_rolling 声纹模式并预置 author_sample + boot_seed
        const cfgPath = join(bookRoot, 'world/book_config.yaml');
        const origCfg = await readFile(cfgPath, 'utf8');
        await writeFile(
            cfgPath,
            `${origCfg}\nopening:\n  voice_seed_mode: hybrid_rolling\n  voice_rolling_warmup_chapters: 3\n`,
            'utf8'
        );
        await writeFile(
            join(bookRoot, '.ops/voice_samples.yaml'),
            [
                'samples:',
                '  - id: v_author',
                '    tag: "日常对话"',
                '    text: "他敲了敲柜台，把铜钥匙推了过去。"',
                '    source: author_sample',
                '    last_used_ch: 0',
                '    use_count: 2',
                '  - id: v_boot',
                '    tag: "环境氛围"',
                '    text: "灯影在湿透的石阶上晃了一圈。"',
                '    source: boot_seed',
                '    last_used_ch: 0',
                '    use_count: 0'
            ].join('\n') + '\n',
            'utf8'
        );

        // 预设含未来章信号与当章信号，验证 signals_cursor 精准记录 consumedIds 且不吞未来章信号
        await writeFile(
            join(bookRoot, '.ops/signals.jsonl'),
            [
                JSON.stringify({
                    type: 'DIRECTOR_NOTE',
                    created_at: '2026-11-18T00:00:00Z',
                    chapter: 2,
                    reason: '未来第二章才消费的信号'
                }),
                JSON.stringify({
                    type: 'DIRECTOR_NOTE',
                    created_at: '2026-11-18T00:01:00Z',
                    chapter: 1,
                    reason: '第一章即时调度信号'
                })
            ].join('\n') + '\n',
            'utf8'
        );
        await setupBookGitignoreAndCommit(
            bookRoot,
            [
                'entities/cold_archive/char_099.md',
                'world/book_config.yaml',
                '.ops/voice_samples.yaml',
                '.ops/signals.jsonl'
            ],
            'test: commit chapter-invariants fixtures'
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

        let plannerSysPromptSeen = '';
        let plannerTaskSeen = '';
        let factCheckerTaskSeen = '';
        let writerCalls = 0;

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, systemPromptText, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001', 'char_099'],
                        wakeup_entity_ids: ['char_099'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    plannerSysPromptSeen = systemPromptText;
                    plannerTaskSeen = taskPrompt;
                    await execTool('yield_outline', {
                        chapter_title: '验船茶馆',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: ['char_099'],
                        preferred_voice_tag: '日常对话',
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '查验旧船契',
                        scene_plan: [
                            { scene_index: 1, location: '茶馆', summary: '会面', is_spotlight: true }
                        ],
                        outline_text: '沈默向程三爷打听旧船契。'
                    });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    factCheckerTaskSeen = taskPrompt;
                    await execTool('yield_verdict', { passed: true, issues: [] });
                    return;
                }
                if (tools.has('yield_state_patch')) {
                    await execTool('yield_state_patch', {
                        entity_patches: [],
                        story_day_delta: 1,
                        chapter_summary: '沈默在茶馆会见程三爷。',
                        prose_anchors: ['旧船契', '不存在的幻觉词'],
                        appeared_entity_ids: ['char_001', 'char_099'],
                        next_chapter_options: ['追查二号码头']
                    });
                }
            },
            onLlmStream: (opts) => {
                const sys = opts.system ?? '';
                if (sys.includes('Voice Harvest')) {
                    return textToStreamChunks(
                        JSON.stringify({
                            samples: [
                                {
                                    tag: '环境氛围',
                                    text: '茶壶嘴冒出的白气在冷风里散得极快，柜台木纹还留着盐渍。'
                                }
                            ]
                        })
                    );
                }
                writerCalls += 1;
                // 正文中提及"林远"(char_002)，但未入选 focus_cast / background_cast / appeared_entity_ids，检验 Q1 防幽灵在场污染
                return textToStreamChunks(
                    '# 验船茶馆\n\n沈默把旧船契摊在桌上，冷宫老友程三爷抬眼看了一眼，顺口提起林远昨晚值班。\n'
                );
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const res = await ctx.narratePipeline.stepChapter({
            chapterNumber: 1,
            chapterGoal: '唤醒冷宫人物程三爷并完成首章双轨提交'
        });

        expect(res.status).toBe('COMMITTED');
        expect(writerCalls).toBe(1);
        // Q9: Planner 注入了冷宫唤醒实体与当章信号，且系统提示词未重复拼接 craft_plugins
        expect(plannerTaskSeen).toContain('程三爷');
        expect(plannerTaskSeen).toContain('第一章即时调度信号');
        expect(plannerTaskSeen).not.toContain('未来第二章才消费的信号');
        expect(plannerSysPromptSeen.match(/BDI/g)?.length ?? 0).toBeLessThanOrEqual(1);
        // ISS-048: FactChecker 注入 author_charter.md
        expect(factCheckerTaskSeen).toContain('author_charter');

        // Q1: 仅保留命中的真实 prose_anchors，且 char_002（仅被台词提及）绝不进入出场实体
        const l2Raw = await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8');
        expect(l2Raw).toContain('- 异象锚点：旧船契');
        expect(l2Raw).not.toContain('不存在的幻觉词');
        expect(l2Raw).toContain('- 出场实体：char_001, char_099');
        expect(l2Raw).not.toContain('char_002');

        // Q2: boot_seed 被替换为 chapter_harvest，author_sample 原样保留且递增 use_count
        const store = ctx.narrateStore.openStore();
        const savedPool = await store.readVoiceSamples();
        const authorSample = savedPool.samples.find((s) => s.id === 'v_author');
        const bootReplaced = savedPool.samples.find((s) => s.source === 'chapter_harvest');
        expect(savedPool.samples.some((s) => s.id === 'v_boot')).toBe(false);
        expect(authorSample?.source).toBe('author_sample');
        expect(authorSample?.use_count).toBe(3);
        expect(bootReplaced?.source).toBe('chapter_harvest');
        expect(bootReplaced?.text).toContain('茶壶嘴冒出的白气');

        // ISS-058 & ISS-004: 未来第 2 章信号未被吞掉，当章第 1 章信号已被记入 consumedIds 且随 state 原子提交（工作区干净）
        const cursorState = await readSignalsCursorState(bookRoot);
        expect(cursorState.consumedIds.length).toBe(1);
        expect(cursorState.consumedLines).toBe(0);
        expect(await isWorkingTreeClean(bookRoot)).toBe(true);

        const resCh2 = await ctx.narratePipeline.stepChapter({
            chapterNumber: 2,
            chapterGoal: '推进第 2 章消费未来信号'
        });
        expect(resCh2.status).toBe('COMMITTED');
        expect(plannerTaskSeen).toContain('未来第二章才消费的信号');
        expect(plannerTaskSeen).not.toContain('第一章即时调度信号');
        const cursorAfterCh2 = await readSignalsCursorState(bookRoot);
        expect(cursorAfterCh2.consumedIds.length).toBe(2);
        expect(cursorAfterCh2.consumedLines).toBe(2);
        expect(await isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('Q3: tryRunLocalPatch 严禁吞掉 AbortError 强停信号', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'patch-abort-rethrow');
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot });
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => bookToolsFiber.dispose());

        const controller = new AbortController();

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
                        chapter_title: '强制中止修补',
                        target_word_count: 1500,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '巡夜',
                        scene_plan: [
                            { scene_index: 1, location: '码头', summary: '巡夜', is_spotlight: true }
                        ],
                        outline_text: '沈默巡夜。'
                    });
                    return;
                }
                if (tools.has('yield_patched_draft')) {
                    controller.abort();
                    const err = new Error('用户强制中止');
                    err.name = 'AbortError';
                    throw err;
                }
            },
            onLlmStream: () => textToStreamChunks('# 强制中止\n\n他指节泛白，喉结滚动。\n')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await expect(
            ctx.narratePipeline.stepChapter({
                chapterNumber: 1,
                chapterGoal: '触发 Gate Patch 后模拟用户强停',
                signal: controller.signal
            })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(existsSync(join(bookRoot, '.ops/safe_halt.json'))).toBe(false);
    });

    it('Q4.2 / Q5: Dreaming 读取 config.dreaming（默认 promote_anchor_min_chapters=2）、注入超期 WARPED/复现异象锚点并移除卷中冷宫搬迁诱导', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'dreaming-prescans', {
            storyDay: 10,
            currentChapter: 3,
            extraChapters: {
                'ch_0001.md': '# 第一章\n\n黑铜钥匙留在门边。\n',
                'ch_0002.md': '# 第二章\n\n黑铜钥匙压着账册。\n',
                'ch_0003.md': '# 第三章\n\n沈默清点货物。\n'
            }
        });

        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            [
                '# 第 1 卷双轨章卡',
                '',
                '## ch_0001 (day:1)',
                '- 主干剧情：初见黑铜钥匙。',
                '- 异象锚点：黑铜钥匙',
                '- 出场实体：char_001',
                '',
                '## ch_0002 (day:2)',
                '- 主干剧情：账册压着黑铜钥匙。',
                '- 异象锚点：黑铜钥匙',
                '- 出场实体：char_001'
            ].join('\n') + '\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/future_horizon.md'),
            [
                '# 未来惯性',
                '',
                '- [day:2] 废弃的码头火灾路线 [WARPED]',
                '',
                '## Archived WARPED',
                '- [day:1] 已折叠的历史废止线 [WARPED]'
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

        let dreamerPromptSeen = '';
        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
                if (tools.has('yield_dream_commit')) {
                    dreamerPromptSeen = taskPrompt;
                    await execTool('yield_dream_commit', {
                        summary: '完成 Dreaming 预扫描整理',
                        chapter_number: 4,
                        accumulated_words: 0
                    });
                }
            },
            onLlmStream: () => textToStreamChunks('ok')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const dreamRes = await ctx.narratePipeline.runDreaming({
            currentChapter: 3,
            coldArchiveCandidateIds: ['char_001']
        });

        expect(dreamRes.skipped).toBe(false);
        expect(dreamerPromptSeen).toContain('黑铜钥匙');
        expect(dreamerPromptSeen).toContain('废弃的码头火灾路线');
        expect(dreamerPromptSeen).not.toContain('已折叠的历史废止线');
        expect(dreamerPromptSeen).not.toContain('长期退场候选实体');
    });

    it('ISS-034 / ISS-048 / ISS-050: Patch 剥离 author_charter 原文引文、FLASHBACK 屏蔽未来尾窗、FEAT_COMMITTED 崩溃恢复补全 L2 与信号游标', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'flashback-and-recovery', {
            storyDay: 5,
            currentChapter: 1,
            extraChapters: {
                'ch_0001.md': '# 第一章 未来主线\n\nFUTURE_MAINLINE_TAIL_MARKER: 第五天的码头已戒严。\n'
            }
        });
        await writeFile(
            join(bookRoot, 'world/author_charter.md'),
            '# 作者契约\n\n- 作者契约绝密原文引用不应出现在写手补丁提示中\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, '.ops/signals.jsonl'),
            JSON.stringify({
                type: 'DIRECTOR_NOTE',
                created_at: '2026-11-18T00:00:00Z',
                chapter: 2,
                reason: '第二章插叙补充信号'
            }) + '\n',
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

        let fcCalls = 0;
        let writerDynamicTail = '';
        let patchPromptSeen = '';

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
                        chapter_title: '往日雨夜',
                        target_word_count: 1200,
                        focus_cast: ['char_001'],
                        background_cast: [],
                        ending_beat: 'CLOSURE',
                        director_rationale: '秘辛',
                        chapter_turn: '回忆十年前',
                        scene_plan: [
                            { scene_index: 1, location: '旧船坞', summary: '雨夜交谈', is_spotlight: true }
                        ],
                        outline_text: '沈默回忆十年前旧船坞雨夜。'
                    });
                    return;
                }
                if (tools.has('yield_patched_draft')) {
                    patchPromptSeen = taskPrompt;
                    await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 1,
                                end_paragraph: 1,
                                replacement_paragraphs: ['十年前的雨夜，木门发出吱呀轻响。']
                            }
                        ]
                    });
                    await execTool('yield_patched_draft', { summary: '脱敏修补' });
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
                                    description: '请核对旧船坞木门细节。',
                                    quote_draft: '十年前的雨夜，铁门发出声响。',
                                    quote_source: '作者契约绝密原文引用不应出现在写手补丁提示中',
                                    source_ref: 'world/author_charter.md'
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
                        chapter_summary: '完成第二章插叙回忆。',
                        prose_anchors: ['木门'],
                        appeared_entity_ids: ['char_001'],
                        next_chapter_options: ['回到主线']
                    });
                }
            },
            onLlmStream: (opts) => {
                writerDynamicTail = JSON.stringify(opts.messages);
                return textToStreamChunks('# 往日雨夜\n\n十年前的雨夜，铁门发出声响。\n');
            }
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const ch2Res = await ctx.narratePipeline.stepChapter({
            chapterNumber: 2,
            timelineMode: 'FLASHBACK',
            targetDay: 1,
            chapterGoal: '插叙十年前旧船坞夜谈'
        });

        expect(ch2Res.status).toBe('COMMITTED');
        // FLASHBACK 物理屏蔽主线未来第 1 章的尾窗文本
        expect(writerDynamicTail).not.toContain('FUTURE_MAINLINE_TAIL_MARKER');
        // Patch 对 source_ref=world/author_charter.md 的问题剥离 quote_source
        expect(patchPromptSeen).toContain('请核对旧船坞木门细节。');
        expect(patchPromptSeen).not.toContain('作者契约绝密原文引用不应出现在写手补丁提示中');

        // 模拟第 3 章在 FEAT_COMMITTED 崩溃后的断点恢复
        const store = ctx.narrateStore.openStore();
        await mkdir(join(bookRoot, '.ops/chapter_outlines'), { recursive: true });
        await writeFile(
            join(bookRoot, '.ops/chapter_outlines/ch_0003.json'),
            JSON.stringify({
                chapter_title: '灾后恢复',
                target_word_count: 1500,
                focus_cast: ['char_001'],
                background_cast: [],
                ending_beat: 'HOOK',
                director_rationale: '秘辛',
                chapter_turn: '继续查验',
                scene_plan: [
                    { scene_index: 1, location: '码头', summary: '核查', is_spotlight: true }
                ],
                outline_text: '沈默核查码头风向。'
            }),
            'utf8'
        );
        const ch3Signal = {
            type: 'DIRECTOR_NOTE',
            created_at: '2026-11-18T00:05:00Z',
            chapter: 3,
            reason: '第三章崩溃恢复时应被消费并写游标的信号'
        };
        await writeFile(
            join(bookRoot, '.ops/signals.jsonl'),
            `${JSON.stringify(ch3Signal)}\n`,
            'utf8'
        );
        await store.beginDraft(3);
        await store.commitDraft(3, '# 灾后恢复\n\n沈默站在旧船坞木门外听风声。\n');

        const recoveryRes = await ctx.narratePipeline.stepChapter({
            chapterNumber: 3,
            chapterGoal: '崩溃恢复第 3 章'
        });
        expect(recoveryRes.recoveredFromPhase).toBe('FEAT_COMMITTED');
        expect(recoveryRes.outline?.chapter_title).toBe('灾后恢复');
        expect(recoveryRes.featCommitSha.length).toBeGreaterThan(0);
        const recoveryCursor = await readSignalsCursorState(bookRoot);
        expect(recoveryCursor.consumedIds).toContain(resolveSignalId(ch3Signal));
        expect(recoveryCursor.consumedLines).toBe(1);
    });

    it('ISS-052: DreamingPipeline Tier 2 锁内原子刷新双轨 L2 卡与哈希并在锁外调用 onSyncAfterPatch', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'dream-tier2-lock', {
            storyDay: 2,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章\n\n沈默左手拎着黄铜提灯。\n',
                'ch_0002.md': '# 第二章\n\n沈默右手握着铁扳手。\n'
            }
        });
        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            [
                '# 第 1 卷双轨章卡',
                '',
                '## ch_0002 (day:2)',
                '- 主干剧情：沈默排查货栈。',
                '- 异象锚点：铁扳手',
                '- 出场实体：char_001'
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

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool }) => {
                if (tools.has('yield_patched_draft')) {
                    await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 1,
                                end_paragraph: 1,
                                replacement_paragraphs: ['沈默左手拎着黄铜提灯穿过雨巷。']
                            }
                        ]
                    });
                    await execTool('yield_patched_draft', { summary: 'Tier 2 净室修补' });
                }
            },
            onLlmStream: () =>
                textToStreamChunks(
                    JSON.stringify({
                        severity: 'SINGLE_POINT_HARD',
                        reason: '手持物冲突',
                        downstream_dependent: false
                    })
                )
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        await setupBookGitignoreAndCommit(
            bookRoot,
            ['index/L2_cards/vol_01_cards.md'],
            'test: commit tier2 L2 card fixture'
        );
        const store = ctx.narrateStore.openStore();
        let syncInsideLock = false;
        let syncCalled = false;

        const res = await ctx.narratePipeline.healCrossChapterConflicts(
            [
                {
                    conflictId: 'c-tier2',
                    chapterA: 1,
                    quoteA: '沈默左手拎着黄铜提灯。',
                    chapterB: 2,
                    quoteB: '沈默右手握着铁扳手。',
                    description: '手持物冲突',
                    severityHint: 'SINGLE_POINT_HARD'
                }
            ],
            {
                onSyncAfterPatch: async () => {
                    syncCalled = true;
                    try {
                        await store.withTxLock(async () => {});
                    } catch {
                        syncInsideLock = true;
                    }
                }
            }
        );

        expect(res.results[0]?.action).toBe('PATCHED_IN_PLACE');
        expect(syncCalled).toBe(true);
        expect(syncInsideLock).toBe(false);
        expect(existsSync(join(bookRoot, '.ops/pending_writes.json'))).toBe(false);
        expect(await isWorkingTreeClean(bookRoot)).toBe(true);
        const l2After = await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8');
        expect(l2After).toContain('- 异象锚点：无');
    });

    it('Reviewer 复审回归: harvestVoiceFromChapter 默认提交 Git、冷宫唤醒实体过 yield_verdict 引文验真、future_horizon/WARPED/未知vis 续行剥离与 Tier 1/2 洁净工作区', async () => {
        const bookRoot = await createGitBookWorkspace(tempDirs, 'reviewer-regressions', {
            storyDay: 2,
            currentChapter: 2,
            extraChapters: {
                'ch_0001.md': '# 第一章\n\n沈默左手拎着黄铜提灯。\n',
                'ch_0002.md': '# 第二章\n\n沈默右手握着铁扳手。\n'
            }
        });
        await mkdir(join(bookRoot, 'entities/cold_archive'), { recursive: true });
        await writeFile(
            join(bookRoot, 'entities/cold_archive/char_099.md'),
            [
                '---',
                'entity_id: char_099',
                'entity_type: character',
                'canonical_name: 程三爷',
                'unique_aliases: ["程三"]',
                'status: ACTIVE',
                'last_seen_ch: 1',
                '---',
                '',
                '## 1. 固有属性锁 (Innate Locks)',
                '- [slot:identity | vis:PUBLIC | owner:char_099] 旧港老验船师',
                '',
                '## 2. 当前状态槽 (Acquired State)',
                '- [slot:residence | vis:PUBLIC | owner:char_099] 退隐老码头茶馆',
                '- [slot:secret | vis:OMNISCIENT_SECRET | owner:char_099] 暗藏半张沉船海图',
                '  > 续行说明：海图藏在茶壶底座暗格里',
                '',
                '## 3. 历史履历 (Irreversible Trajectory)',
                '',
                '## 4. 近期缓冲 (Recent Buffer)',
                ''
            ].join('\n'),
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/future_horizon.md'),
            '# 未来惯性\n\n- [day:5] 港务稽查队将在三号码头封锁仓库\n',
            'utf8'
        );
        await setupBookGitignoreAndCommit(
            bookRoot,
            ['entities/cold_archive/char_099.md', 'world/future_horizon.md'],
            'test: commit reviewer-regressions fixtures'
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

        const store = ctx.narrateStore.openStore();

        // 1. harvestVoiceFromChapter 不传 system 时仍自动原子提交 .ops/voice_samples.yaml 并清理 pending_writes.json
        const harvestOnlyRes = await harvestVoiceFromChapter({
            store,
            llm: {
                generate: async () => ({
                    text: JSON.stringify({
                        samples: [
                            {
                                tag: '动作白描',
                                text: '煤油灯焰晃了一寸，铜钥匙在桌面划出一道细痕。'
                            }
                        ]
                    }),
                    usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 15 }
                })
            },
            chapterNumber: 1
        });
        expect(harvestOnlyRes.harvestedCount).toBe(1);
        expect(existsSync(join(bookRoot, '.ops/pending_writes.json'))).toBe(false);
        expect(await isWorkingTreeClean(bookRoot)).toBe(true);

        // 2. 唤醒冷宫实体 char_099 参与单章：FactChecker 引用 entities/char_099.md 可通过 stagingOverlay 验真，
        // 且 Patch 物理剥离 world/future_horizon.md 与 OMNISCIENT_SECRET 续行的 quote_source
        let fcRound = 0;
        let patchPromptSeen = '';

        await createHeadlessMockServices(ctx, {
            onAgent: async ({ tools, execTool, taskPrompt }) => {
                if (tools.has('yield_context_pack')) {
                    await execTool('yield_context_pack', {
                        selected_entity_ids: ['char_001', 'char_099'],
                        wakeup_entity_ids: ['char_099'],
                        recall_queries: [],
                        selected_lore_files: []
                    });
                    return;
                }
                if (tools.has('yield_outline')) {
                    await execTool('yield_outline', {
                        chapter_title: '冷宫验真',
                        target_word_count: 1200,
                        focus_cast: ['char_001', 'char_099'],
                        background_cast: [],
                        ending_beat: 'HOOK',
                        director_rationale: '秘辛',
                        chapter_turn: '茶馆核查',
                        scene_plan: [
                            { scene_index: 1, location: '茶馆', summary: '会面', is_spotlight: true }
                        ],
                        outline_text: '沈默与程三爷在茶馆会面。'
                    });
                    return;
                }
                if (tools.has('yield_patched_draft')) {
                    patchPromptSeen = taskPrompt;
                    await execTool('patch_paragraphs', {
                        edits: [
                            {
                                start_paragraph: 1,
                                end_paragraph: 1,
                                replacement_paragraphs: ['程三爷把铜茶壶推到桌沿，抬手掸去袖口盐霜。']
                            }
                        ]
                    });
                    await execTool('yield_patched_draft', { summary: '安全修补' });
                    return;
                }
                if (tools.has('yield_verdict')) {
                    fcRound += 1;
                    if (fcRound === 1) {
                        await execTool('yield_verdict', {
                            passed: false,
                            issues: [
                                {
                                    severity: 'LOCAL_PATCH',
                                    paragraph_index: 1,
                                    description: '请依据程三爷在茶馆现身细节改写动作。',
                                    quote_draft: '程三爷提起沉船海图。',
                                    quote_source: '退隐老码头茶馆',
                                    source_ref: 'entities/char_099.md'
                                },
                                {
                                    severity: 'LOCAL_PATCH',
                                    paragraph_index: 1,
                                    description: '请收敛茶馆对话节奏。',
                                    quote_draft: '程三爷提起沉船海图。',
                                    quote_source: '海图藏在茶壶底座暗格里',
                                    source_ref: 'entities/char_099.md'
                                },
                                {
                                    severity: 'LOCAL_PATCH',
                                    paragraph_index: 1,
                                    description: '请保持当前夜间巡检氛围。',
                                    quote_draft: '程三爷提起沉船海图。',
                                    quote_source: '港务稽查队将在三号码头封锁仓库',
                                    source_ref: 'world/future_horizon.md'
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
                        chapter_summary: '完成冷宫唤醒与引文脱敏验证。',
                        prose_anchors: ['茶壶'],
                        appeared_entity_ids: ['char_001', 'char_099'],
                        next_chapter_options: ['继续追查']
                    });
                }
            },
            onLlmStream: () =>
                textToStreamChunks('# 冷宫验真\n\n程三爷提起沉船海图，茶壶底座微微一震。\n')
        });

        const pipeFiber = await ctx.plugin(pipelinePlugin, { heartbeatIntervalMs: 0 });
        registerCleanup(() => pipeFiber.dispose());

        const stepRes = await ctx.narratePipeline.stepChapter({
            chapterNumber: 3,
            chapterGoal: '测试冷宫唤醒实体 yield_verdict 验真与受限引文剥离'
        });
        expect(stepRes.status).toBe('COMMITTED');
        expect(patchPromptSeen).toContain('退隐老码头茶馆');
        expect(patchPromptSeen).not.toContain('海图藏在茶壶底座暗格里');
        expect(patchPromptSeen).not.toContain('港务稽查队将在三号码头封锁仓库');
        expect(await isWorkingTreeClean(bookRoot)).toBe(true);

        // 3. 验证 Tier 1 RETCON 后同样清理 pending_writes.json 并保持工作区干净
        const tier1Res = await ctx.narratePipeline.healCrossChapterConflicts([
            {
                conflictId: 'c-tier1-clean',
                chapterA: 1,
                quoteA: '沈默左手拎着黄铜提灯。',
                chapterB: 2,
                quoteB: '沈默右手握着铁扳手。',
                description: '雨夜描述微差',
                severityHint: 'SOFT_MINOR'
            }
        ]);
        expect(tier1Res.results[0]?.action).toBe('RETCON_SIGNAL');
        expect(existsSync(join(bookRoot, '.ops/pending_writes.json'))).toBe(false);
        expect(await isWorkingTreeClean(bookRoot)).toBe(true);
    });
});

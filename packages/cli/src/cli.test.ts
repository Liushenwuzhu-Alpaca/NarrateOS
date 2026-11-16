import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    type CleanroomRequest,
    type CleanroomResponse,
    type LlmPort,
    ScriptedLlmAdapter
} from '@narrateos/core';
import { parseCliArgs, runCli } from './cli.js';
import { DshRuntimeClient } from './dsh-runtime.js';
import {
    createPlotHaystackScriptedLlm,
    PLOT_HAYSTACK_PROBES,
    runPlotHaystackBenchmark
} from './plot-haystack.js';

const tempDirs: string[] = [];

async function createTempBookDir(prefix = 'narrateos-cli-test-'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function makeUsage(inputTokens = 1200, cacheReadTokens = 800, outputTokens = 300) {
    return {
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
        outputTokens
    };
}

/**
 * 构建支持 boot -> step -> sync -> dream 全流程的脚本化 LLM 适配器
 */
function createLifecycleScriptedLlm(): ScriptedLlmAdapter {
    let chapterCounter = 0;
    const responder = (req: CleanroomRequest): CleanroomResponse => {
        const staticText = req.staticPrefixBlocks.join('\n');
        const tail = req.dynamicTail;

        // 1. bootBook: tokens_per_char 标定
        if (tail.includes('标定样本')) {
            return {
                text: 'OK',
                usage: makeUsage(45, 0, 2),
                modelId: 'mock-strong'
            };
        }

        // 2. bootBook: Phase 1A 开局定标与反俗套切口生成
        if (req.pool === 'strong_creative' && tail.includes('Phase 1A')) {
            return {
                text: JSON.stringify({
                    coordinates: {
                        topology: 'CONTINUOUS_ESCALATION',
                        tensionDrivers: ['EPISTEMIC_GAP', 'GOAL_FRICTION'],
                        endgame: 'CONVERGENT_CLOSURE'
                    },
                    excludedCliches: [
                        '主角开局获得无敌外挂碾压反派',
                        '反派临死前长篇大论主动交代全部阴谋',
                        '所有谜题仅靠天降神秘老人一句话点破'
                    ],
                    pitches: [
                        {
                            index: 0,
                            title: '停摆钟楼与断齿铜钥',
                            logline: '钟表匠沈砚在朔望大潮前追查停摆钟楼里的断齿钥匙之谜。',
                            coreHook: '每停摆一小时，旧港地下排水闸便渗出一寸黑潮。',
                            antiClicheNote: '沈砚必须靠修表手艺与物理试错逐层拆解机关。'
                        },
                        {
                            index: 1,
                            title: '雾港双面潮汐账',
                            logline: '两本互相矛盾的潮汐账本同时出现在旧港当铺。',
                            coreHook: '真账本记录的是活人而非货物的进出港时间。',
                            antiClicheNote: '不依赖超自然预言，全靠时间线交叉比对破局。'
                        }
                    ]
                }),
                usage: makeUsage(600, 0, 260),
                modelId: 'mock-strong'
            };
        }

        // 3. bootBook: Phase 1B 自动择优拍板
        if (req.pool === 'audit' && tail.includes('候选切口列表')) {
            return {
                text: JSON.stringify({
                    selectedIndex: 0,
                    rationale: '切口 0 兼具物理倒计时压迫感与强认知差悬念。'
                }),
                usage: makeUsage(400, 0, 80),
                modelId: 'mock-audit'
            };
        }

        // 4. bootBook: Phase 1C 纯文本《全书架构圣经》
        if (req.pool === 'strong_creative' && tail.includes('请脱离 JSON 格式限制')) {
            return {
                text: [
                    '# 全书架构圣经',
                    '## 1. 里账本底层真相与代价定律',
                    '旧港钟楼底层并非单纯计时机构，而是控制朔望夜防潮闸的机械锁；每次强行拨动主摆都会损耗不可再生的黄铜棘轮。',
                    '## 2. 全书母题（L0）与多卷蓝图（L1）',
                    '第一卷《雾港寻钥》聚焦钟表铺与旧港栈桥；第二卷《潮汐账本》深入地下档案室。',
                    '## 3. 第一卷三幕拐点与开篇点火器',
                    'Ch.01 雨夜接下缺口钥匙图纸，Stage Ceiling 限制主角不得提前越过主闸门。',
                    '## 4. 核心角色与默认轨迹',
                    '沈砚、林默、周管事、苏晴围绕断齿铜钥展开博弈。',
                    '## 5. 首批跨卷伏笔与外部惯性事件',
                    'thread_clock 停摆钟楼；storyDay 5 潮汐倒灌。'
                ].join('\n\n'),
                usage: makeUsage(750, 0, 320),
                modelId: 'mock-strong'
            };
        }

        // 5. bootBook: Phase 2 三把手术刀结构化编译
        if (req.pool === 'strong_creative' && tail.includes('编译模式:')) {
            return {
                text: JSON.stringify({
                    worldSummary: '雾港钟楼与旧城区构成封闭孤岛，潮汐每夜倒灌。',
                    staticBaseAndVoice: '冷峻克制、感官锚定、短句推进。',
                    currentArcEnvelope: '第一卷：雾港寻钥。开篇雨夜接图纸，Stage Ceiling 禁入地下主闸。',
                    l0SagasMarkdown: '# L0 纪元折叠总表\n\n- saga_01: 雾港钟楼与潮汐机械秘史',
                    l1VolumesMarkdown:
                        '# L1 活跃卷级总表\n\n- vol_01: 雾港寻钥 (story_day: 0..)\n- vol_02: 潮汐档案 (待开启)',
                    voiceSamples: [
                        { tag: 'calm_dialogue', sample: '“钥匙不在柜台里，”沈砚把铜牌推回桌面，“你再找找。”' }
                    ],
                    openThreads: [
                        { threadId: 'thread_clock', title: '停摆钟楼', wakeupCondition: '第 2 章查明钟摆缺口' }
                    ],
                    futureHorizonEvents: [
                        { eventId: 'evt_tide', storyDay: 5, premise: '潮汐倒灌', description: '地下档案室将被淹没' }
                    ],
                    loreEntries: [
                        {
                            id: 'lore_fog_port',
                            title: '雾港潮汐律',
                            summary: '每逢朔望夜海潮倒灌旧港。',
                            content: '旧港排水渠年久失修，朔望夜海水会漫过石阶。'
                        }
                    ],
                    entities: [
                        {
                            entityId: 'char_shenyan',
                            canonicalName: '沈砚',
                            uniqueAliases: ['沈先生'],
                            contextualTitles: ['旧钟表匠'],
                            innateLocks: [{ visibility: 'PUBLIC', text: '右腕戴旧铜表，对铁锈味极度敏感' }],
                            acquiredState: [
                                { storyDay: 0, visibility: 'PUBLIC', slotKey: 'location', text: '身处雾港钟表铺' }
                            ],
                            irreversibleTrajectory: [{ storyDay: 0, text: '接手调查停摆钟楼委托' }],
                            recentBuffer: [
                                { storyDay: 0, text: '雨夜擦拭铜表表壳' },
                                { storyDay: 0, text: '清点工作台上的黄铜齿轮' },
                                { storyDay: 0, text: '听见港湾传来低沉汽笛' },
                                { storyDay: 0, text: '记录客人留下的缺口钥匙图纸' }
                            ]
                        },
                        {
                            entityId: 'char_linmo',
                            canonicalName: '林默',
                            uniqueAliases: ['阿默'],
                            contextualTitles: ['学徒'],
                            innateLocks: [{ visibility: 'PUBLIC', text: '随身携带防水油布与潮位尺' }],
                            acquiredState: [
                                { storyDay: 0, visibility: 'PUBLIC', slotKey: 'location', text: '在钟表铺后堂整理工具' }
                            ],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        },
                        {
                            entityId: 'char_zhou',
                            canonicalName: '周管事',
                            uniqueAliases: ['老周'],
                            contextualTitles: ['港务管事'],
                            innateLocks: [
                                {
                                    visibility: 'OMNISCIENT_SECRET',
                                    text: '私下扣留了真正能打开地下防潮闸的备用母钥'
                                }
                            ],
                            acquiredState: [
                                { storyDay: 0, visibility: 'PUBLIC', slotKey: 'location', text: '驻守旧港码头值班室' }
                            ],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        },
                        {
                            entityId: 'item_broken_key',
                            canonicalName: '断齿铜钥图纸',
                            uniqueAliases: ['缺口图纸'],
                            contextualTitles: ['委托物证'],
                            innateLocks: [{ visibility: 'PUBLIC', text: '牛皮纸绘制，第三道轮槽处有明显断齿缺口' }],
                            acquiredState: [
                                { storyDay: 0, visibility: 'PUBLIC', slotKey: 'holder', text: '保存在沈砚工作台抽屉内' }
                            ],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        }
                    ]
                }),
                usage: makeUsage(900, 0, 420),
                modelId: 'mock-strong'
            };
        }

        // 6. bootBook: Phase 3c 异构剧透盲审
        if (req.pool === 'audit' && tail.includes('异构剧透盲审')) {
            return {
                text: JSON.stringify({
                    recallRate: 1,
                    missingFacts: [],
                    t0Leaks: [],
                    publicSpoilerLeaks: [],
                    passed: true,
                    notes: 'PUBLIC 视图未泄露任何 OMNISCIENT_SECRET 与 T0 未来信息。'
                }),
                usage: makeUsage(450, 0, 90),
                modelId: 'mock-audit'
            };
        }

        // 3. syncManuscripts: diff 定性
        if (tail.includes('git diff') || tail.includes('PROSE_POLISH') || tail.includes('is_prose_polish_only')) {
            return {
                text: JSON.stringify({
                    is_prose_polish_only: true,
                    reason: '仅调整了句式节奏与环境描写，未改动实体状态。',
                    affected_entity_ids: []
                }),
                usage: makeUsage(300, 200, 80),
                modelId: 'mock-fast'
            };
        }

        // 4. Dreaming: 第 4 区脏缓冲提炼
        if (tail.includes('trajectory_entries') || tail.includes('keep_buffer_texts')) {
            return {
                text: JSON.stringify({
                    trajectory_entries: [
                        {
                            story_day: 1,
                            chapter: 1,
                            anchor: '雾港钟表铺接下委托',
                            summary: '沈砚在雨夜擦拭铜表后接下停摆钟楼调查委托'
                        }
                    ],
                    keep_buffer_texts: ['记录客人留下的缺口钥匙图纸']
                }),
                usage: makeUsage(400, 0, 120),
                modelId: 'mock-fast'
            };
        }

        // 5. Dreaming: 远景节点与离场切镜
        if (tail.includes('warped_markers') || tail.includes('spotlight_triggers')) {
            return {
                text: JSON.stringify({
                    warped_markers: [],
                    spotlight_triggers: []
                }),
                usage: makeUsage(350, 0, 60),
                modelId: 'mock-fast'
            };
        }

        // 6. Step: Librarian
        if (
            req.pool === 'fast_retrieval' &&
            (staticText.includes('Librarian') ||
                staticText.includes('图书管理员') ||
                tail.includes('可用实体档案列表'))
        ) {
            return {
                text: JSON.stringify({
                    selected_entity_ids: ['char_shenyan'],
                    recall_queries: [],
                    selected_lore_files: ['lore_fog_port']
                }),
                usage: makeUsage(300, 500, 80),
                modelId: 'mock-fast'
            };
        }

        // 7. Step: Writer 正文 (必须在 Planner 之前匹配，因为 Writer 的 tail 含 "本章执笔细纲")
        if (req.pool === 'strong_creative' && tail.includes('本章执笔细纲')) {
            return {
                text: [
                    '雨点斜敲在钟表铺的玻璃窗上，把街灯的光扯成几道晃动的亮线。沈砚把黄铜放大镜架到左眼，指尖按住那张边缘发潮的牛皮纸图纸。',
                    '',
                    '图纸中央画着一枚断齿钥匙，缺口恰好卡在第三道轮槽。他合上怀表盖子，金属扣发出轻响。柜台角落里那盏旧煤油灯还留着半壶油，火苗舔着灯罩内壁，在墙上投出长短不一的影子。',
                    '',
                    '“潮水快漫过石阶了。”他自言自语了一句，把图纸折进内袋，推门走进湿冷的夜雾里。'
                ].join('\n'),
                usage: makeUsage(400, 1000, 260),
                modelId: 'mock-strong'
            };
        }

        // 8. Step: Planner
        if (req.pool === 'strong_creative') {
            chapterCounter += 1;
            return {
                text: JSON.stringify({
                    chapter_title: `第${chapterCounter}章 雾港旧钥`,
                    target_word_count: 1200,
                    focus_cast: ['char_shenyan'],
                    background_cast: [],
                    ending_beat: 'HOOK',
                    chapter_turn: '沈砚从图纸缺口推算出旧钟楼水闸的真实齿距，决定冒雨动身。',
                    scene_plan: [
                        {
                            scene_index: 1,
                            location: '雾港钟表铺',
                            summary: '沈砚核对缺口钥匙图纸并准备前往钟楼。',
                            is_spotlight: true
                        }
                    ],
                    outline_text: '沈砚在灯下比对图纸齿距，随后拎起油灯步入雨幕。'
                }),
                usage: makeUsage(500, 900, 180),
                modelId: 'mock-strong'
            };
        }

        // 8. Step: FactChecker
        if (req.pool === 'audit') {
            return {
                text: JSON.stringify({
                    passed: true,
                    issues: []
                }),
                usage: makeUsage(600, 800, 60),
                modelId: 'mock-audit'
            };
        }

        // 9. Step: Extractor
        if (req.pool === 'fast_retrieval') {
            return {
                text: JSON.stringify({
                    entity_patches: [
                        {
                            entity_id: 'char_shenyan',
                            last_seen_ch: chapterCounter,
                            buffer_ops: [
                                {
                                    op: 'append',
                                    entry: {
                                        storyDay: 2,
                                        chapter: chapterCounter,
                                        text: '带油灯冒雨前往旧钟楼'
                                    }
                                }
                            ]
                        }
                    ],
                    story_day_delta: 1,
                    chapter_summary: '沈砚比对图纸后冒雨前往旧钟楼。'
                }),
                usage: makeUsage(400, 600, 140),
                modelId: 'mock-fast'
            };
        }

        // 10. Step: Writer 正文
        return {
            text: [
                '雨点斜敲在钟表铺的玻璃窗上，把街灯的光扯成几道晃动的亮线。沈砚把黄铜放大镜架到左眼，指尖按住那张边缘发潮的牛皮纸图纸。',
                '',
                '图纸中央画着一枚断齿钥匙，缺口恰好卡在第三道轮槽。他合上怀表盖子，金属扣发出轻响。柜台角落里那盏旧煤油灯还留着半壶油，火苗舔着灯罩内壁，在墙上投出长短不一的影子。',
                '',
                '“潮水快漫过石阶了。”他自言自语了一句，把图纸折进内袋，推门走进湿冷的夜雾里。'
            ].join('\n'),
            usage: makeUsage(400, 1000, 260),
            modelId: 'mock-strong'
        };
    };

    const adapter = new ScriptedLlmAdapter();
    for (let i = 0; i < 64; i += 1) {
        adapter.enqueue(responder);
    }
    return adapter;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('@narrateos/cli', () => {
    it('应该正确解析 CLI 子命令与参数', () => {
        const stepParsed = parseCliArgs([
            'step',
            '--book',
            '/tmp/demo-book',
            '--goal',
            '推进钟楼调查',
            '--chapter',
            '3',
            '--mode',
            'FLASHBACK',
            '--target-day',
            '1',
            '--pov',
            'char_shenyan,char_lin',
            '--json'
        ]);
        expect(stepParsed.command).toBe('step');
        expect(stepParsed.bookRoot).toBe('/tmp/demo-book');
        expect(stepParsed.flags['goal']).toBe('推进钟楼调查');
        expect(stepParsed.flags['chapter']).toBe('3');
        expect(stepParsed.flags['mode']).toBe('FLASHBACK');
        expect(stepParsed.flags['target-day']).toBe('1');
        expect(stepParsed.flags['pov']).toBe('char_shenyan,char_lin');
        expect(stepParsed.json).toBe(true);

        const haystackParsed = parseCliArgs(['plot-haystack', '--chapters', '40', '--json']);
        expect(haystackParsed.command).toBe('plot-haystack');
        expect(haystackParsed.flags['chapters']).toBe('40');
        expect(haystackParsed.json).toBe(true);
    });

    it('应该通过 DshRuntimeClient 动态加载 dsh-llm 调度器并在缺失时给出明确错误', async () => {
        const capturedCalls: unknown[] = [];
        const client = new DshRuntimeClient({
            loader: async () => ({
                generate: async (options) => {
                    capturedCalls.push(options);
                    return {
                        text: '动态调度返回文本',
                        usage: {
                            inputTokens: 100,
                            cacheReadTokens: 40,
                            cacheWriteTokens: 0,
                            outputTokens: 25
                        },
                        modelId: 'deepseek-chat',
                        finishReason: 'stop'
                    };
                }
            })
        });

        const res = await client.generate({
            pool: 'strong_creative',
            staticPrefixBlocks: ['STATIC_WORLD', 'STATIC_VOICE'],
            dynamicTail: '请续写下一段。',
            temperature: 0.7,
            maxTokens: 512
        });

        expect(res.text).toBe('动态调度返回文本');
        expect(res.usage.cacheReadTokens).toBe(40);
        expect(capturedCalls).toHaveLength(1);
        expect((capturedCalls[0] as { staticPrefixBlocks: string[] }).staticPrefixBlocks).toEqual([
            'STATIC_WORLD',
            'STATIC_VOICE'
        ]);

        const missingClient = new DshRuntimeClient({
            loader: async () => {
                throw new Error('Cannot find package @deepseek-ai/dsh-llm');
            }
        });
        await expect(
            missingClient.generate({
                pool: 'fast_retrieval',
                staticPrefixBlocks: [],
                dynamicTail: 'ping'
            })
        ).rejects.toThrow(/dsh-llm/);
    });

    it('应该完成无头 boot -> step -> status -> sync -> dream 端到端闭环', async () => {
        const bookRoot = await createTempBookDir();
        const llm: LlmPort = createLifecycleScriptedLlm();

        const captureStreams = () => {
            const out: string[] = [];
            const err: string[] = [];
            return {
                out,
                err,
                stdout: (chunk: string) => {
                    out.push(chunk);
                },
                stderr: (chunk: string) => {
                    err.push(chunk);
                }
            };
        };

        // 1. boot
        const bootIo = captureStreams();
        const bootCode = await runCli(
            [
                'boot',
                '--book',
                bookRoot,
                '--slug',
                'fog-port',
                '--title',
                '雾港停摆钟',
                '--pov',
                'char_shenyan',
                '--mode',
                'original',
                '--seed',
                '雾港旧钟楼夜半停摆，钟表匠沈砚接手调查。',
                '--json'
            ],
            { llm, stdout: bootIo.stdout, stderr: bootIo.stderr }
        );
        expect(bootCode).toBe(0);
        const bootJson = JSON.parse(bootIo.out.join('')) as { bookRoot: string; entityIds: string[] };
        expect(bootJson.bookRoot).toBe(bookRoot);
        expect(bootJson.entityIds).toContain('char_shenyan');

        // 2. step
        const stepIo = captureStreams();
        const stepCode = await runCli(
            ['step', '--book', bookRoot, '--goal', '沈砚比对钥匙图纸并前往旧钟楼', '--json'],
            { llm, stdout: stepIo.stdout, stderr: stepIo.stderr }
        );
        expect(stepCode).toBe(0);
        const stepJson = JSON.parse(stepIo.out.join('')) as { status: string; chapterNumber: number };
        expect(stepJson.status).toBe('COMMITTED');
        expect(stepJson.chapterNumber).toBe(1);

        // 3. status
        const statusIo = captureStreams();
        const statusCode = await runCli(
            ['status', '--book', bookRoot, '--json'],
            { stdout: statusIo.stdout, stderr: statusIo.stderr }
        );
        expect(statusCode).toBe(0);
        const statusJson = JSON.parse(statusIo.out.join('')) as {
            bookSlug: string;
            currentChapter: number;
            entityCount: number;
        };
        expect(statusJson.bookSlug).toBe('fog-port');
        expect(statusJson.currentChapter).toBe(1);
        expect(statusJson.entityCount).toBeGreaterThanOrEqual(1);

        // 4. 手改正文触发 sync
        const chPath = join(bookRoot, 'manuscripts', 'ch_0001.md');
        const originalText = await readFile(chPath, 'utf8');
        await writeFile(chPath, `${originalText}\n\n远处码头传来一声短促汽笛。`, 'utf8');

        const syncIo = captureStreams();
        const syncCode = await runCli(
            ['sync', '--book', bookRoot, '--json'],
            { llm, stdout: syncIo.stdout, stderr: syncIo.stderr }
        );
        expect(syncCode).toBe(0);
        const syncJson = JSON.parse(syncIo.out.join('')) as { status: string };
        expect(syncJson.status).toBe('PROSE_POLISH_SYNCED');

        // 5. dream
        const dreamIo = captureStreams();
        const dreamCode = await runCli(
            ['dream', '--book', bookRoot, '--force', '--json'],
            { llm, stdout: dreamIo.stdout, stderr: dreamIo.stderr }
        );
        expect(dreamCode).toBe(0);
        const dreamJson = JSON.parse(dreamIo.out.join('')) as { skipped: boolean; vacuumedEntities: string[] };
        expect(dreamJson.skipped).toBe(false);
        expect(dreamJson.vacuumedEntities).toContain('char_shenyan');
    }, 15_000);

    it('应该完整跑通 Plot-Haystack 40 章盲测并输出 10 枚探针核验与四联遥测报告', async () => {
        const bookRoot = await createTempBookDir('narrateos-haystack-');
        const llm = createPlotHaystackScriptedLlm(40);

        expect(PLOT_HAYSTACK_PROBES).toHaveLength(10);

        const report = await runPlotHaystackBenchmark({
            bookRoot,
            llm,
            targetChapters: 40
        });

        expect(report.totalChapters).toBe(40);
        expect(report.probes).toHaveLength(10);
        expect(report.summary.breachRate).toBe(0);
        expect(report.summary.pairedRecallRate).toBe(1);
        expect(report.summary.prefixHashConsistencyRate).toBeGreaterThanOrEqual(0.9);
        expect(report.summary.tokenCacheHitRate).toBeGreaterThan(0.5);
        expect(report.telemetryTrend.chapters).toHaveLength(40);
        expect(report.telemetryTrend.earlyWindowAvg.mattr500).toBeGreaterThan(0);
        expect(report.telemetryTrend.lateWindowAvg.mattr500).toBeGreaterThan(0);

        // 验证 CLI plot-haystack 子命令也能输出 JSON 报告
        const cliBookRoot = await createTempBookDir('narrateos-haystack-cli-');
        const cliLlm = createPlotHaystackScriptedLlm(40);
        const out: string[] = [];
        const err: string[] = [];
        const exitCode = await runCli(
            ['plot-haystack', '--book', cliBookRoot, '--chapters', '40', '--json'],
            {
                llm: cliLlm,
                stdout: (chunk) => out.push(chunk),
                stderr: (chunk) => err.push(chunk)
            }
        );
        expect(exitCode).toBe(0);
        const cliReport = JSON.parse(out.join('')) as {
            totalChapters: number;
            summary: { breachRate: number; pairedRecallRate: number };
        };
        expect(cliReport.totalChapters).toBe(40);
        expect(cliReport.summary.breachRate).toBe(0);
        expect(cliReport.summary.pairedRecallRate).toBe(1);
    }, 30_000);
});

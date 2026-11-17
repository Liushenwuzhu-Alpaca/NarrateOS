import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ScriptedLlmAdapter, type CleanroomRequest } from '../ports/llm.js';
import { NodeSystemAdapter } from '../ports/system.js';
import { BookStore } from '../store/bookstore.js';
import {
    BootAuditError,
    SillyTavernCharacterCardAdapter,
    SillyTavernLorebookAdapter,
    bootBook
} from './index.js';

const tempDirs: string[] = [];

async function createTempBookRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'narrateos-boot-'));
    tempDirs.push(dir);
    return dir;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('bootBook 开书编译与导入接缝', () => {
    it('已有资产和失败初始化目录在调用模型前被拒绝', async () => {
        const bookRoot = await createTempBookRoot();
        const asset = join(bookRoot, 'notes.md');
        await writeFile(asset, '保留原作品笔记', 'utf8');
        const llm = new ScriptedLlmAdapter([]);
        const input = { bookRoot, bookSlug: 'existing', title: '已有作品', povCharacter: 'char_001', mode: 'original' as const, premiseOrSeed: '新种子' };
        const deps = { llm, system: new NodeSystemAdapter() };
        await expect(bootBook(input, deps)).rejects.toThrow('目标目录必须为空');
        expect(await readFile(asset, 'utf8')).toBe('保留原作品笔记');
        expect(llm.history).toEqual([]);
        await rm(asset);
        await expect(bootBook(input, deps)).rejects.toThrow('队列已耗尽');
        expect(await exists(join(bookRoot, '.boot-incomplete'))).toBe(true);
        await expect(bootBook(input, deps)).rejects.toThrow('目标目录必须为空');
        expect(llm.history).toHaveLength(1);
    });

    it('原创冷启动应创建完整目录树、标定 tokens_per_char 并完成初始 Git 提交', async () => {
        const bookRoot = await createTempBookRoot();
        const system = new NodeSystemAdapter();
        const sampleText = '雨夜的站台只剩一盏昏黄路灯，积水倒映着列车进站的冷光。';

        const llm = new ScriptedLlmAdapter([
            // 第 1 次：tokens_per_char 标定
            {
                text: 'OK',
                usage: {
                    inputTokens: sampleText.length * 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    outputTokens: 2
                }
            },
            // 第 2 次：Phase 1A 坐标定标与 3 组候选切口
            {
                text: JSON.stringify({
                    coordinates: {
                        topology: 'CONTINUOUS_ESCALATION',
                        tensionDrivers: ['EPISTEMIC_GAP', 'GOAL_FRICTION'],
                        endgame: 'CONVERGENT_CLOSURE'
                    },
                    excludedCliches: ['开局金手指无敌流', '系统弹窗任务流', '全员降智反派'],
                    pitches: [
                        {
                            index: 0,
                            title: '零号站台失踪案',
                            logline: '夜班巡检员在折叠站台调查失踪列车与自身时间缺口。',
                            coreHook: '黄铜车票每使用一次就会抹去他人对持票人的一段记忆。',
                            antiClicheNote: '无系统面板，全靠物理线索与时间差博弈。'
                        },
                        {
                            index: 1,
                            title: '末班车账本',
                            logline: '地铁调度室隐藏的乘客名单。',
                            coreHook: '名单上的名字逐个消失。',
                            antiClicheNote: '避免超自然打斗。'
                        },
                        {
                            index: 2,
                            title: '铁轨回声',
                            logline: '停运线路上的神秘信号。',
                            coreHook: '无线电传出十年前的求救。',
                            antiClicheNote: '避免单元鬼故事套路。'
                        }
                    ]
                }),
                usage: { inputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 180 }
            },
            // 第 3 次：Phase 1B audit 池自动择优
            {
                text: JSON.stringify({
                    selectedIndex: 0,
                    rationale: '第一组切口的认知差与物理代价最契合长篇悬疑。'
                }),
                usage: { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 }
            },
            // 第 4 次：Phase 1C 纯文本《全书架构圣经》
            {
                text: [
                    '# 全书架构圣经：零号站台',
                    '## 1. 里账本底牌与代价定律',
                    '零号站台实为城市时空折叠节点的泄压阀，林雾十年前曾亲手签署封站协议。',
                    '## 2. L0 母题与 L1 卷级蓝图',
                    '- vol_01: 零号站台失踪案',
                    '- vol_02: 地下环线沉降区',
                    '## 3. 第一卷三幕与点火器',
                    '第1章点火器：午夜巡检发现多出一节无编号车厢。Stage Ceiling：第一卷严禁揭晓林雾是前任站长的真相。',
                    '## 4. 核心角色',
                    '林雾（夜班巡检员）。',
                    '## 5. 首批伏笔与未来惯性',
                    '失踪的末班车长怀表。'
                ].join('\n'),
                usage: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 260 }
            },
            // 第 5 次：Phase 2 三把手术刀结构化编译
            {
                text: JSON.stringify({
                    worldSummary: '近未来都市奇幻，地下铁道存在折叠站台。',
                    staticBaseAndVoice: '冷峻写实第三人称限知视角，禁用无根比喻。',
                    currentArcEnvelope: '第一卷：零号站台失踪案。Ch.01 点火器：午夜巡检发现无编号车厢。Stage Ceiling：本卷严禁揭晓林雾曾签署封站协议。',
                    l0SagasMarkdown: '# L0 纪元折叠总表\n\n- saga_01: 折叠铁道与记忆代价纪元',
                    l1VolumesMarkdown: '# L1 活跃卷级总表\n\n- vol_01: 零号站台失踪案 (story_day: 0..)\n- vol_02: 地下环线沉降区 (待开启)',
                    voiceSamples: [
                        { tag: '悬疑白描', sample: '站牌上的墨迹在雨水里化开，像一只闭不上的眼。' }
                    ],
                    openThreads: [
                        { threadId: 'thread_01', title: '失踪的末班车长', wakeupCondition: '第 5 章前揭晓怀表去向' }
                    ],
                    futureHorizonEvents: [
                        {
                            eventId: 'evt_01',
                            storyDay: 3,
                            premise: '主角仍持有黄铜车票',
                            description: '零号站台闸机在午夜重新开启'
                        }
                    ],
                    entities: [
                        {
                            entityId: 'char_001',
                            canonicalName: '林雾',
                            uniqueAliases: ['林巡检'],
                            contextualTitles: ['夜班巡检员'],
                            innateLocks: [
                                { visibility: 'PUBLIC', text: '左耳佩戴旧式助听器' },
                                { visibility: 'OMNISCIENT_SECRET', text: '十年前曾亲手签署零号站台封站协议' }
                            ],
                            acquiredState: [
                                { storyDay: 0, visibility: 'PUBLIC', slotKey: '持有物', text: '持有物：黄铜车票' }
                            ],
                            irreversibleTrajectory: [
                                { storyDay: 0, text: '接手零号站台夜班巡检任务' }
                            ],
                            recentBuffer: [
                                { storyDay: 0, text: '声纹：简短克制，多用反问' }
                            ]
                        }
                    ]
                }),
                usage: {
                    inputTokens: 300,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    outputTokens: 250
                }
            },
            // 第 6 次：Phase 3 异构剧透盲审
            {
                text: JSON.stringify({
                    recallRate: 1,
                    missingFacts: [],
                    t0Leaks: [],
                    publicSpoilerLeaks: [],
                    passed: true,
                    notes: '里表双账本隔离严密，无剧透泄露。'
                }),
                usage: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }
            }
        ]);

        const result = await bootBook(
            {
                bookRoot,
                bookSlug: 'zero-platform',
                title: '零号站台',
                povCharacter: 'char_001',
                mode: 'original',
                premiseOrSeed: '一个夜班地铁巡检员在雨夜发现多出来的第零号站台',
                calibrationSampleText: sampleText,
                writerTokenBudget: 16000,
                minEntityCount: 1,
                minVolumeCount: 1
            },
            { llm, system }
        );

        expect(result.tokensPerChar).toBeCloseTo(2, 4);
        expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
        expect(result.entityIds).toEqual(['char_001']);

        // 验证完整目录树
        const expectedPaths = [
            'manuscripts',
            'entities',
            'entities/cold_archive',
            'world',
            'lore_library',
            'index/L2_cards',
            '.ops',
            'world/book_config.yaml',
            'world/world_state.md',
            'world/static_base_and_voice.md',
            'world/current_arc_envelope.md',
            'world/voice_samples.yaml',
            '.ops/voice_samples.yaml',
            'world/future_horizon.md',
            'world/open_threads.md',
            'entities/char_001.md',
            '.ops/tx_state.json'
        ];
        for (const rel of expectedPaths) {
            expect(await exists(join(bookRoot, rel))).toBe(true);
        }

        // 验证 world/voice_samples.yaml 与 .ops/voice_samples.yaml 同步写入且完成兼容字段归一化
        const worldVoiceRaw = await readFile(join(bookRoot, 'world/voice_samples.yaml'), 'utf8');
        const opsVoiceRaw = await readFile(join(bookRoot, '.ops/voice_samples.yaml'), 'utf8');
        expect(opsVoiceRaw).toBe(worldVoiceRaw);
        const parsedVoice = parseYaml(worldVoiceRaw) as {
            samples: Array<{
                id: string;
                tag: string;
                text: string;
                sample: string;
                last_used_ch: number;
                use_count: number;
            }>;
        };
        expect(parsedVoice.samples).toEqual([
            {
                id: 'voice_01',
                tag: '悬疑白描',
                text: '站牌上的墨迹在雨水里化开，像一只闭不上的眼。',
                sample: '站牌上的墨迹在雨水里化开，像一只闭不上的眼。',
                last_used_ch: 0,
                use_count: 0
            }
        ]);

        // 验证 book_config.yaml 标定结果
        const rawConfig = await readFile(join(bookRoot, 'world/book_config.yaml'), 'utf8');
        const parsedConfig = parseYaml(rawConfig) as Record<string, unknown>;
        expect(parsedConfig.tokens_per_char).toBe(2);
        expect(parsedConfig.writer_token_budget).toBe(16000);

        // 验证 BookStore 可正常读取快照且 Git 工作区干净
        const store = new BookStore(bookRoot, system);
        const snapshot = await store.loadSnapshot();
        expect(snapshot.worldState.frontmatter.story_day).toBe(0);
        expect(snapshot.worldState.frontmatter.pov_character).toBe('char_001');
        expect(snapshot.txState.phase).toBe('IDLE');
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('同人 T0 切分编译应剥离 T0 后剧透并通过异构盲审 (recallRate >= 0.98)', async () => {
        const bookRoot = await createTempBookRoot();
        const system = new NodeSystemAdapter();
        const calledPools: string[] = [];

        const llm = new ScriptedLlmAdapter([
            // 1. tokens_per_char 标定
            (req: CleanroomRequest) => {
                calledPools.push(req.pool);
                return {
                    text: 'ok',
                    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }
                };
            },
            // 2. 同人 T0 切分编译
            (req: CleanroomRequest) => {
                calledPools.push(req.pool);
                return {
                    text: JSON.stringify({
                        worldSummary: 'T0 开局时刻：新生报到当日，主角刚抵达学院门口。',
                        staticBaseAndVoice: '冷静观察流，严禁提前揭露幕后黑手身份。',
                        currentArcEnvelope: '第一卷：学院入学测验篇。',
                        voiceSamples: [{ tag: '日常对话', sample: '「登记表在左手边第三格。」' }],
                        openThreads: [
                            { threadId: 'thread_t0_1', title: '钟楼地下室传闻', wakeupCondition: '入学后首周触发' }
                        ],
                        futureHorizonEvents: [
                            {
                                eventId: 'canon_ep05',
                                storyDay: 14,
                                premise: '主角顺利通过入学测验并进入学生会',
                                description: '原著第五集：副会长在钟楼地下室被偷袭'
                            }
                        ],
                        loreEntries: [
                            {
                                id: 'lore_academy',
                                title: '圣路易斯学院',
                                summary: '百年历史的全封闭寄宿学院',
                                content: '学院位于山谷高地，夜间十点宵禁。'
                            }
                        ],
                        entities: [
                            {
                                entityId: 'char_001',
                                canonicalName: '白石',
                                uniqueAliases: ['白石同学'],
                                contextualTitles: ['新生'],
                                innateLocks: [{ visibility: 'PUBLIC', text: '右眉尾有一道浅疤' }],
                                acquiredState: [
                                    { storyDay: 0, visibility: 'PUBLIC', slotKey: '位置', text: '位置：学院正门报到处' }
                                ],
                                irreversibleTrajectory: [
                                    { storyDay: -3, text: '收到学院录取通知书' },
                                    { storyDay: 0, text: '抵达学院正门' }
                                ],
                                recentBuffer: []
                            }
                        ]
                    }),
                    usage: { inputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 320 }
                };
            },
            // 3. 异构盲审 (pool === 'audit')
            (req: CleanroomRequest) => {
                calledPools.push(req.pool);
                return {
                    text: JSON.stringify({
                        recallRate: 0.99,
                        missingFacts: [],
                        t0Leaks: [],
                        passed: true,
                        notes: 'T0 边界清晰，无未来剧透泄露。'
                    }),
                    usage: { inputTokens: 350, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 80 }
                };
            }
        ]);

        const result = await bootBook(
            {
                bookRoot,
                bookSlug: 'academy-fanfic',
                title: '学院异闻录',
                povCharacter: 'char_001',
                mode: 'fanfic',
                sourceMaterial: '白石右眉尾有浅疤，开局抵达圣路易斯学院正门；两周后副会长将在钟楼地下室被偷袭。',
                t0Anchor: '入学报到当天 (story_day = 0)',
                calibrationSampleText: 'a'.repeat(100)
            },
            { llm, system }
        );

        expect(calledPools).toContain('audit');
        expect(result.auditReport?.passed).toBe(true);
        expect(result.auditReport?.recallRate).toBe(0.99);
        expect(result.loreIds).toEqual(['lore_academy']);

        const entityContent = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        expect(entityContent).not.toContain('钟楼地下室被偷袭');

        const horizonContent = await readFile(join(bookRoot, 'world/future_horizon.md'), 'utf8');
        expect(horizonContent).toContain('副会长在钟楼地下室被偷袭');

        const loreContent = await readFile(join(bookRoot, 'lore_library/lore_academy.md'), 'utf8');
        expect(loreContent).toContain('圣路易斯学院');
    });

    it('异构盲审召回率低于 0.98 或存在 T0 剧透泄露时应支持重试，仍不达标则拦截报错', async () => {
        const bookRoot = await createTempBookRoot();
        const system = new NodeSystemAdapter();

        const compilePayload = {
            worldSummary: '测试世界',
            staticBaseAndVoice: '冷峻白描',
            currentArcEnvelope: '第一卷',
            voiceSamples: [],
            openThreads: [],
            futureHorizonEvents: [],
            loreEntries: [],
            entities: [
                {
                    entityId: 'char_001',
                    canonicalName: '主角',
                    innateLocks: [],
                    acquiredState: [
                        // 故意混入 storyDay > 0 的未来状态，触发确定性 T0 截断拦截
                        { storyDay: 5, visibility: 'PUBLIC', text: '第 5 天获得隐藏神器' }
                    ],
                    irreversibleTrajectory: [],
                    recentBuffer: []
                }
            ]
        };

        const llm = new ScriptedLlmAdapter([
            // 1. 标定
            {
                text: 'ok',
                usage: { inputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }
            },
            // 2. 第 1 次编译
            {
                text: JSON.stringify(compilePayload),
                usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }
            },
            // 3. 第 1 次盲审：召回率不足 0.98
            {
                text: JSON.stringify({
                    recallRate: 0.85,
                    missingFacts: ['遗漏配角先天伤残设定'],
                    t0Leaks: [{ entityId: 'char_001', field: 'acquiredState', excerpt: '第 5 天获得隐藏神器', reason: '越过 T0 时间锚点' }],
                    passed: false
                }),
                usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }
            },
            // 4. 第 2 次补充编译重试：仍旧不达标
            {
                text: JSON.stringify(compilePayload),
                usage: { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }
            },
            // 5. 第 2 次盲审：依旧不达标
            {
                text: JSON.stringify({
                    recallRate: 0.92,
                    missingFacts: ['仍遗漏关键道具编号'],
                    t0Leaks: [],
                    passed: false
                }),
                usage: { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }
            }
        ]);

        await expect(
            bootBook(
                {
                    bookRoot,
                    bookSlug: 'fail-audit',
                    title: '失败拦截测试',
                    povCharacter: 'char_001',
                    mode: 'fanfic',
                    sourceMaterial: '原著设定包',
                    calibrationSampleText: 'a'.repeat(100),
                    maxAuditRetries: 1,
                    minRecallRate: 0.98
                },
                { llm, system }
            )
        ).rejects.toThrow(BootAuditError);

        // 拦截后不应产生任何已提交的手稿或配置文件
        expect(await exists(join(bookRoot, 'world/book_config.yaml'))).toBe(false);
    });

    it('SillyTavern 导入接缝应标准化解析 V2 角色卡与 World Info JSON', async () => {
        const loreImporter = new SillyTavernLorebookAdapter();
        const cardImporter = new SillyTavernCharacterCardAdapter();

        const loreEntries = await loreImporter.importLorebook({
            entries: {
                '0': {
                    uid: 0,
                    key: ['圣路易斯', '学院'],
                    comment: '学院背景',
                    content: '全封闭寄宿学院，夜间十点宵禁。',
                    disable: false
                },
                '1': {
                    uid: 1,
                    key: ['废弃条目'],
                    content: '不应导入的禁用条目',
                    disable: true
                }
            }
        });

        expect(loreEntries).toHaveLength(1);
        expect(loreEntries[0]?.id).toBe('lore_st_0');
        expect(loreEntries[0]?.keywords).toEqual(['圣路易斯', '学院']);
        expect(loreEntries[0]?.content).toContain('夜间十点宵禁');

        const card = await cardImporter.importCharacterCard({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: '神代雪乃',
                description: '风纪委员长，右手腕内侧有旧烫伤浅疤。',
                personality: '严谨克制，按章办事。',
                scenario: '周五放学后的学生会室。',
                first_mes: '「请把登记表放在桌角。」',
                mes_example: '<START>\n{{char}}: 「我只是按章办事。」',
                character_book: {
                    entries: [
                        {
                            id: 10,
                            keys: ['学生会室'],
                            content: '三楼东侧尽头，常备备用钥匙。',
                            enabled: true
                        }
                    ]
                }
            }
        });

        expect(card.canonicalName).toBe('神代雪乃');
        expect(card.description).toContain('风纪委员长');
        expect(card.embeddedLorebook).toHaveLength(1);
        expect(card.embeddedLorebook[0]?.keywords).toEqual(['学生会室']);
    });

    it('四阶段 original 编译器应落盘 L0/L1 多卷规划、点火器与 Stage Ceiling，并用 StaticProseGate 清洗八股声纹样本', async () => {
        const bookRoot = await createTempBookRoot();
        const system = new NodeSystemAdapter();
        const observedPrompts: string[] = [];

        const llm = new ScriptedLlmAdapter([
            // 1. 标定
            {
                text: 'OK',
                usage: { inputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }
            },
            // 2. Phase 1A：三维正交坐标 + 排除 3 俗套 + 3 候选切口
            (req: CleanroomRequest) => {
                observedPrompts.push(`1A:${req.pool}`);
                return {
                    text: JSON.stringify({
                        coordinates: {
                            topology: 'CONTINUOUS_ESCALATION',
                            tensionDrivers: ['EPISTEMIC_GAP', 'GOAL_FRICTION'],
                            endgame: 'CONVERGENT_CLOSURE'
                        },
                        excludedCliches: ['天降金手指', '全员降智反派', '无代价复活'],
                        pitches: [
                            {
                                index: 0,
                                title: '雾港钟楼谜案',
                                logline: '失聪修表匠在停摆怀表里发现十年前沉船加密日志。',
                                coreHook: '怀表每次走字都会还原一段海底求救声波。',
                                antiClicheNote: '无超能力，全靠机械推理与港口势力博弈。'
                            },
                            {
                                index: 1,
                                title: '港务局幽灵船',
                                logline: '每逢大雾天靠岸的空船。',
                                coreHook: '船舱里只有湿透的船员名单。',
                                antiClicheNote: '拒绝纯灵异吓人。'
                            },
                            {
                                index: 2,
                                title: '灯塔守望者',
                                logline: '灯塔光束照出的海底残骸。',
                                coreHook: '灯光频率对应摩斯密码。',
                                antiClicheNote: '拒绝孤岛逃杀套路。'
                            }
                        ]
                    }),
                    usage: { inputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }
                };
            },
            // 3. Phase 1B：interactive 模式不调用 audit，直接进 Phase 1C 纯文本圣经
            (req: CleanroomRequest) => {
                observedPrompts.push(`1C:${req.pool}`);
                expect(req.dynamicTail).toContain('雾港钟楼谜案');
                return {
                    text: [
                        '# 《雾港残钟》全书架构圣经',
                        '## 一、里账本底层真相',
                        '真凶是港务局现任总工程师沈砚，十年前刻意调偏了引航钟楼频率。',
                        '## 二、L0 母题与 L1 多卷蓝图',
                        '- vol_01: 停摆怀表与雾港钟楼',
                        '- vol_02: 沉船打捞听证会',
                        '- vol_03: 深海电报站闭环',
                        '## 三、第一卷三幕拐点与点火器',
                        'In Medias Res 点火器：暴雨夜，林默拆开匿名送修的黄铜怀表，发条下压着带盐渍的沉船坐标。',
                        'Stage Ceiling：第一卷严禁揭穿沈砚是十年前沉船案主谋。',
                        '## 四、核心角色 (4 名)',
                        '林默、苏晚、沈砚、周伯。',
                        '## 五、首批伏笔与未来惯性',
                        'thread_clock_key；三天后港务局启动旧码头爆破。'
                    ].join('\n'),
                    usage: { inputTokens: 240, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 320 }
                };
            },
            // 4. Phase 2：三把手术刀编译（含 4 实体、3 卷 L1、含八股词声纹）
            (req: CleanroomRequest) => {
                observedPrompts.push(`2:${req.pool}`);
                expect(req.dynamicTail).toContain('全书架构圣经');
                return {
                    text: JSON.stringify({
                        worldSummary: '近现代海港悬疑，大雾季航道频发失踪案。',
                        staticBaseAndVoice: '冷峻工业质感，克制白描，感官锚定机械与海风盐味。',
                        currentArcEnvelope: [
                            '第一卷：停摆怀表与雾港钟楼。',
                            'In Medias Res 开篇点火器：暴雨夜拆开匿名怀表，发现沉船加密坐标。',
                            'Stage Ceiling：第一卷严禁揭穿沈砚的真凶身份与总控室密道。'
                        ].join('\n'),
                        l0SagasMarkdown: '# L0 纪元折叠总表\n\n- saga_01: 雾港沉船真相追索纪元（三卷闭环）',
                        l1VolumesMarkdown: [
                            '# L1 活跃卷级总表',
                            '',
                            '- vol_01: 停摆怀表与雾港钟楼 (story_day: 0..15)',
                            '- vol_02: 沉船打捞听证会 (待开启)',
                            '- vol_03: 深海电报站闭环 (待开启)'
                        ].join('\n'),
                        voiceSamples: [
                            { tag: '机械检修', sample: '镊子夹住游丝末尾，铜齿轮在灯下泛出冷硬的哑光。' },
                            { tag: '机械检修', sample: '他攥紧表壳，指节泛白。' },
                            { tag: '港湾夜色', sample: '防波堤外传来低沉汽笛，雾气把红灯晕成一团模糊的血块。' },
                            { tag: '港湾夜色', sample: '她眼底闪过一丝慌乱，转身钻进雨幕。' },
                            { tag: '人物对峙', sample: '「收据上的签名被海水泡糊了，你确定还要按原价修？」' },
                            { tag: '室内推理', sample: '三枚齿轮的咬合角差了半度，绝不是自然摔落所致。' }
                        ],
                        openThreads: [
                            { threadId: 'thread_clock_key', title: '怀表暗格铜钥', wakeupCondition: '林默前往旧钟楼配对锁孔时触发' }
                        ],
                        futureHorizonEvents: [
                            {
                                eventId: 'evt_pier_blast',
                                storyDay: 4,
                                premise: '林默未在三日内公开加密日志',
                                description: '港务局以危房改造名义封闭旧钟楼东侧'
                            }
                        ],
                        loreEntries: [
                            {
                                id: 'lore_fog_harbor',
                                title: '雾港钟楼潮汐表',
                                summary: '每逢大潮钟楼地下蓄水池淹没三米',
                                content: '建于三十年前的机械报时钟楼，地下联通旧排水暗渠。'
                            }
                        ],
                        entities: [
                            {
                                entityId: 'char_linmo',
                                canonicalName: '林默',
                                uniqueAliases: ['林师傅'],
                                contextualTitles: ['修表匠'],
                                innateLocks: [{ visibility: 'PUBLIC', text: '右耳重度听障，需读唇辅助沟通' }],
                                acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: '位置', text: '旧街区钟表铺工作台前' }],
                                irreversibleTrajectory: [{ storyDay: -365, text: '因沉船事故幸存而失去右耳听力' }],
                                recentBuffer: [{ storyDay: 0, text: '刚拆开匿名送修的黄铜怀表' }]
                            },
                            {
                                entityId: 'char_suwan',
                                canonicalName: '苏晚',
                                uniqueAliases: ['苏记者'],
                                contextualTitles: ['海事周刊调查记者'],
                                innateLocks: [{ visibility: 'PUBLIC', text: '左腕戴防水机械计时表' }],
                                acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: '目的', text: '追查十年前失踪船员名单' }],
                                irreversibleTrajectory: [{ storyDay: -10, text: '拿到半张港务局旧档案复印件' }],
                                recentBuffer: []
                            },
                            {
                                entityId: 'char_shenyan',
                                canonicalName: '沈砚',
                                uniqueAliases: ['沈总工'],
                                contextualTitles: ['港务局总工程师'],
                                innateLocks: [
                                    { visibility: 'PUBLIC', text: '常年主持雾港航道维护工程' },
                                    { visibility: 'OMNISCIENT_SECRET', text: '十年前刻意调偏引航钟楼频率制造沉船案的真凶' }
                                ],
                                acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: '位置', text: '港务局三楼工程总监室' }],
                                irreversibleTrajectory: [{ storyDay: -3650, text: '篡改引航钟楼校准记录' }],
                                recentBuffer: []
                            },
                            {
                                entityId: 'char_zhoubo',
                                canonicalName: '周伯',
                                uniqueAliases: ['老周'],
                                contextualTitles: ['退休灯塔管理员'],
                                innateLocks: [{ visibility: 'PUBLIC', text: '左腿微跛，熟悉旧排水暗渠' }],
                                acquiredState: [{ storyDay: 0, visibility: 'SELF_ONLY', slotKey: '秘密', text: '私藏当年值班室的纸质航海日志副本' }],
                                irreversibleTrajectory: [],
                                recentBuffer: []
                            }
                        ]
                    }),
                    usage: { inputTokens: 420, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 380 }
                };
            },
            // 5. Phase 3：异构剧透盲审 (audit)
            (req: CleanroomRequest) => {
                observedPrompts.push(`3:${req.pool}`);
                return {
                    text: JSON.stringify({
                        recallRate: 1,
                        missingFacts: [],
                        t0Leaks: [],
                        publicSpoilerLeaks: [],
                        passed: true,
                        notes: '真凶底牌严格锁定在 OMNISCIENT_SECRET，PUBLIC 栏位无泄底。'
                    }),
                    usage: { inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 60 }
                };
            }
        ]);

        const result = await bootBook(
            {
                bookRoot,
                bookSlug: 'fog-harbor',
                title: '雾港残钟',
                povCharacter: 'char_linmo',
                mode: 'original',
                premiseOrSeed: '听力受损的修表匠在停摆怀表里发现十年前沉船案的加密航海日志',
                decisionMode: 'interactive',
                selectedPitchIndex: 0,
                calibrationSampleText: 'a'.repeat(100)
            },
            { llm, system }
        );

        // interactive 模式跳过 1B 的 audit 调用
        expect(observedPrompts).toEqual([
            '1A:strong_creative',
            '1C:strong_creative',
            '2:strong_creative',
            '3:audit'
        ]);
        expect(result.coordinates).toEqual({
            topology: 'CONTINUOUS_ESCALATION',
            tensionDrivers: ['EPISTEMIC_GAP', 'GOAL_FRICTION'],
            endgame: 'CONVERGENT_CLOSURE'
        });
        expect(result.filteredVoiceSampleCount).toBe(2);

        // 断言 1：L0_sagas.md 与 L1_volumes.md 包含非空多卷规划
        const l0 = await readFile(join(bookRoot, 'index/L0_sagas.md'), 'utf8');
        const l1 = await readFile(join(bookRoot, 'index/L1_volumes.md'), 'utf8');
        expect(l0).toContain('saga_01');
        expect(l1).toContain('vol_01');
        expect(l1).toContain('vol_02');
        expect(l1).toContain('vol_03');

        // 断言 2：current_arc_envelope.md 包含开篇点火器与 Stage Ceiling
        const arcEnvelope = await readFile(join(bookRoot, 'world/current_arc_envelope.md'), 'utf8');
        expect(arcEnvelope).toContain('点火器');
        expect(arcEnvelope).toContain('Stage Ceiling');

        // 断言 3：含“指节泛白”和“一丝”的八股声纹样本已被 StaticProseGate 自动剔除
        const voiceYaml = await readFile(join(bookRoot, 'world/voice_samples.yaml'), 'utf8');
        expect(voiceYaml).not.toContain('指节泛白');
        expect(voiceYaml).not.toContain('一丝');
        expect(voiceYaml).toContain('铜齿轮在灯下泛出冷硬的哑光');
        expect(voiceYaml).toContain('防波堤外传来低沉汽笛');
    });

    it('注入将真凶底牌误标为 PUBLIC 的载荷应被盲审拦截并触发带反馈回炉重编译', async () => {
        const bookRoot = await createTempBookRoot();
        const system = new NodeSystemAdapter();
        let phase2Attempts = 0;

        const makeEntityList = (leakedPublic: boolean) => [
            {
                entityId: 'char_linmo',
                canonicalName: '林默',
                innateLocks: [{ visibility: 'PUBLIC', text: '右耳听障' }],
                acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: '位置', text: '钟表铺' }],
                irreversibleTrajectory: [],
                recentBuffer: []
            },
            {
                entityId: 'char_suwan',
                canonicalName: '苏晚',
                innateLocks: [{ visibility: 'PUBLIC', text: '调查记者' }],
                acquiredState: [],
                irreversibleTrajectory: [],
                recentBuffer: []
            },
            {
                entityId: 'char_shenyan',
                canonicalName: '沈砚',
                innateLocks: leakedPublic
                    ? [{ visibility: 'PUBLIC', text: '十年前刻意调偏航标制造沉船案的真凶' }]
                    : [
                          { visibility: 'PUBLIC', text: '港务局总工程师' },
                          { visibility: 'OMNISCIENT_SECRET', text: '十年前刻意调偏航标制造沉船案的真凶' }
                      ],
                acquiredState: [],
                irreversibleTrajectory: [],
                recentBuffer: []
            },
            {
                entityId: 'char_zhoubo',
                canonicalName: '周伯',
                innateLocks: [{ visibility: 'PUBLIC', text: '退休灯塔管理员' }],
                acquiredState: [],
                irreversibleTrajectory: [],
                recentBuffer: []
            }
        ];

        const makePayload = (leakedPublic: boolean) => ({
            worldSummary: '雾港海港悬疑开局。',
            staticBaseAndVoice: '冷峻白描。',
            currentArcEnvelope: '第一卷：雾港钟楼。In Medias Res 点火器：暴雨夜拆表。Stage Ceiling：严禁提前揭穿真凶。',
            l0SagasMarkdown: '# L0 纪元折叠总表\n\n- saga_01: 沉船追索',
            l1VolumesMarkdown: '# L1 活跃卷级总表\n\n- vol_01: 雾港钟楼\n- vol_02: 沉船听证会',
            voiceSamples: [{ tag: '机械检修', sample: '铜齿轮在灯下泛出冷硬的哑光。' }],
            openThreads: [],
            futureHorizonEvents: [],
            loreEntries: [],
            entities: makeEntityList(leakedPublic)
        });

        const llm = new ScriptedLlmAdapter([
            // 1. 标定
            { text: 'OK', usage: { inputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } },
            // 2. Phase 1A
            {
                text: JSON.stringify({
                    coordinates: {
                        topology: 'CONTINUOUS_ESCALATION',
                        tensionDrivers: ['EPISTEMIC_GAP'],
                        endgame: 'CONVERGENT_CLOSURE'
                    },
                    excludedCliches: ['无敌流', '系统流', '降智反派'],
                    pitches: [
                        { index: 0, title: '雾港残钟', logline: '修表匠追查沉船案', coreHook: '加密怀表', antiClicheNote: '硬核推理' }
                    ]
                }),
                usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }
            },
            // 3. Phase 1C (仅 1 个候选切口时 auto_best 直接选用 0，无需额外调 audit)
            {
                text: '# 全书架构圣经\n里账本：沈砚是真凶。\nL1：vol_01 / vol_02。\nStage Ceiling：第一卷不揭穿沈砚。',
                usage: { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 120 }
            },
            // 4. Phase 2 第 1 次编译：误把真凶底牌标为 PUBLIC
            (req: CleanroomRequest) => {
                phase2Attempts += 1;
                return {
                    text: JSON.stringify(makePayload(true)),
                    usage: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }
                };
            },
            // 5. Phase 3 第 1 次盲审：拦截 publicSpoilerLeaks
            {
                text: JSON.stringify({
                    recallRate: 1,
                    missingFacts: [],
                    t0Leaks: [],
                    publicSpoilerLeaks: [
                        {
                            entityId: 'char_shenyan',
                            field: 'innateLocks',
                            excerpt: '十年前刻意调偏航标制造沉船案的真凶',
                            reason: '将真凶底牌误标为 PUBLIC，应隔离为 OMNISCIENT_SECRET'
                        }
                    ],
                    passed: false
                }),
                usage: { inputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 80 }
            },
            // 6. Phase 2 回炉重编译：确认收到泄露反馈，修复为 OMNISCIENT_SECRET
            (req: CleanroomRequest) => {
                phase2Attempts += 1;
                expect(req.dynamicTail).toContain('十年前刻意调偏航标制造沉船案的真凶');
                expect(req.dynamicTail).toContain('OMNISCIENT_SECRET');
                return {
                    text: JSON.stringify(makePayload(false)),
                    usage: { inputTokens: 220, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }
                };
            },
            // 7. Phase 3 第 2 次盲审：通过
            {
                text: JSON.stringify({
                    recallRate: 1,
                    missingFacts: [],
                    t0Leaks: [],
                    publicSpoilerLeaks: [],
                    passed: true
                }),
                usage: { inputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 }
            }
        ]);

        const result = await bootBook(
            {
                bookRoot,
                bookSlug: 'fog-harbor-recheck',
                title: '雾港残钟',
                povCharacter: 'char_linmo',
                mode: 'original',
                premiseOrSeed: '修表匠追查沉船案',
                maxAuditRetries: 1,
                calibrationSampleText: 'a'.repeat(100)
            },
            { llm, system }
        );

        expect(phase2Attempts).toBe(2);
        expect(result.auditReport?.passed).toBe(true);
        const shenyanMd = await readFile(join(bookRoot, 'entities/char_shenyan.md'), 'utf8');
        expect(shenyanMd).toContain('[vis: OMNISCIENT_SECRET]');
    });

    it('盲审公开视图应包含 irreversibleTrajectory 与 recentBuffer，且声纹全被门禁剔除时应触发回炉重试', async () => {
        const bookRoot = await createTempBookRoot();
        const system = new NodeSystemAdapter();
        let phase2Attempts = 0;

        const makePayload = (validVoice: boolean) => ({
            worldSummary: '雾港海港悬疑开局。',
            staticBaseAndVoice: '冷峻白描。',
            currentArcEnvelope: '第一卷：雾港钟楼。In Medias Res 点火器：暴雨夜拆表。Stage Ceiling：严禁提前揭穿真凶。',
            l0SagasMarkdown: '# L0 纪元折叠总表\n\n- saga_01: 沉船追索',
            l1VolumesMarkdown: '# L1 活跃卷级总表\n\n- vol_01: 雾港钟楼\n- vol_02: 沉船听证会',
            voiceSamples: validVoice
                ? [{ tag: '机械检修', sample: '铜齿轮在灯下泛出冷硬的哑光。' }]
                : [{ tag: '八股情绪', sample: '他指节泛白，眼底闪过一丝寒意。' }],
            openThreads: [],
            futureHorizonEvents: [],
            loreEntries: [],
            entities: [
                {
                    entityId: 'char_linmo',
                    canonicalName: '林默',
                    innateLocks: [{ visibility: 'PUBLIC', text: '右耳听障' }],
                    acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: '位置', text: '钟表铺' }],
                    irreversibleTrajectory: [{ storyDay: 0, text: '十年前离开港务局档案室' }],
                    recentBuffer: [{ storyDay: 0, text: '袖口沾着潮湿的海盐味' }]
                },
                {
                    entityId: 'char_suwan',
                    canonicalName: '苏晚',
                    innateLocks: [{ visibility: 'PUBLIC', text: '调查记者' }],
                    acquiredState: [],
                    irreversibleTrajectory: [],
                    recentBuffer: []
                },
                {
                    entityId: 'char_shenyan',
                    canonicalName: '沈砚',
                    innateLocks: [
                        { visibility: 'PUBLIC', text: '港务局总工程师' },
                        { visibility: 'OMNISCIENT_SECRET', text: '十年前刻意调偏航标的真凶' }
                    ],
                    acquiredState: [],
                    irreversibleTrajectory: [],
                    recentBuffer: []
                },
                {
                    entityId: 'char_zhoubo',
                    canonicalName: '周伯',
                    innateLocks: [{ visibility: 'PUBLIC', text: '退休灯塔管理员' }],
                    acquiredState: [],
                    irreversibleTrajectory: [],
                    recentBuffer: []
                }
            ]
        });

        const llm = new ScriptedLlmAdapter([
            // 1. 标定
            { text: 'OK', usage: { inputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } },
            // 2. Phase 1A
            {
                text: JSON.stringify({
                    coordinates: {
                        topology: 'CONTINUOUS_ESCALATION',
                        tensionDrivers: ['EPISTEMIC_GAP'],
                        endgame: 'CONVERGENT_CLOSURE'
                    },
                    excludedCliches: ['无敌流', '系统流', '降智反派'],
                    pitches: [
                        { index: 0, title: '雾港残钟', logline: '修表匠追查沉船案', coreHook: '加密怀表', antiClicheNote: '硬核推理' }
                    ]
                }),
                usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }
            },
            // 3. Phase 1C
            {
                text: '# 全书架构圣经\n里账本：沈砚是真凶。\nL1：vol_01 / vol_02。\nStage Ceiling：第一卷不揭穿沈砚。',
                usage: { inputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 120 }
            },
            // 4. Phase 2 第 1 次编译：声纹样本全部命中八股禁词
            () => {
                phase2Attempts += 1;
                return {
                    text: JSON.stringify(makePayload(false)),
                    usage: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }
                };
            },
            // 5. Phase 3 第 1 次盲审：验证公开视图包含 irreversibleTrajectory 与 recentBuffer
            (req: CleanroomRequest) => {
                expect(req.dynamicTail).toContain('irreversibleTrajectory');
                expect(req.dynamicTail).toContain('十年前离开港务局档案室');
                expect(req.dynamicTail).toContain('recentBuffer');
                expect(req.dynamicTail).toContain('袖口沾着潮湿的海盐味');
                return {
                    text: JSON.stringify({
                        recallRate: 1,
                        missingFacts: [],
                        t0Leaks: [],
                        publicSpoilerLeaks: [],
                        passed: true
                    }),
                    usage: { inputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 }
                };
            },
            // 6. Phase 2 回炉重编译：确认收到声纹全被剔除的 quotaErrors 反馈
            (req: CleanroomRequest) => {
                phase2Attempts += 1;
                expect(req.dynamicTail).toContain('StaticProseGate');
                return {
                    text: JSON.stringify(makePayload(true)),
                    usage: { inputTokens: 220, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }
                };
            },
            // 7. Phase 3 第 2 次盲审：通过
            {
                text: JSON.stringify({
                    recallRate: 1,
                    missingFacts: [],
                    t0Leaks: [],
                    publicSpoilerLeaks: [],
                    passed: true
                }),
                usage: { inputTokens: 180, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 }
            }
        ]);

        const result = await bootBook(
            {
                bookRoot,
                bookSlug: 'fog-harbor-voice-retry',
                title: '雾港残钟',
                povCharacter: 'char_linmo',
                mode: 'original',
                premiseOrSeed: '修表匠追查沉船案',
                maxAuditRetries: 1,
                calibrationSampleText: 'a'.repeat(100)
            },
            { llm, system }
        );

        expect(phase2Attempts).toBe(2);
        expect(result.auditReport?.passed).toBe(true);
        expect(result.filteredVoiceSampleCount).toBe(0);
        const voiceYaml = await readFile(join(bookRoot, 'world/voice_samples.yaml'), 'utf8');
        expect(voiceYaml).toContain('铜齿轮在灯下泛出冷硬的哑光');
    });
});

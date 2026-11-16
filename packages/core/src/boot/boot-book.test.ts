import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
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
            // 第 2 次：原创冷启动设定编译
            {
                text: JSON.stringify({
                    worldSummary: '近未来都市奇幻，地下铁道存在折叠站台。',
                    staticBaseAndVoice: '冷峻写实第三人称限知视角，禁用无根比喻。',
                    currentArcEnvelope: '第一卷：零号站台失踪案，主线聚焦调查与逃生。',
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
                            innateLocks: [{ visibility: 'PUBLIC', text: '左耳佩戴旧式助听器' }],
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
                writerTokenBudget: 16000
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
            'world/future_horizon.md',
            'world/open_threads.md',
            'entities/char_001.md',
            '.ops/tx_state.json'
        ];
        for (const rel of expectedPaths) {
            expect(await exists(join(bookRoot, rel))).toBe(true);
        }

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
});

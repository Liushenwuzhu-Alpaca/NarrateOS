import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CraftPluginLoader } from '../plugins/craft-plugin-loader.js';
import { ScriptedLlmAdapter, hashStaticPrefix } from '../ports/llm.js';
import type { RecallSlice } from '../recall/index-recall.js';
import { ViewSlicer } from '../slicer/view-slicer.js';
import type { BookConfig, BookSnapshot, EntityProfile } from '../store/schemas.js';
import {
    PrefixAssembler,
    buildStaticPrefixBlocks,
    evictDynamicTailToBudget,
    loadVoiceSamples,
    parseVoiceSamplesYaml,
    renderEntityProfile,
    renderRecallSlice,
    resolveCraftPluginsSection,
    sampleVoiceLru,
    saveVoiceSamples,
    serializeVoiceSamplesYaml,
    type CraftPluginDefinition,
    type VoiceSamplePool
} from './index.js';

const REPO_CRAFT_PLUGINS_DIR = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../plugins/craft'
);

function createBaseConfig(overrides: Partial<BookConfig> = {}): BookConfig {
    return {
        book_slug: 'test-novel',
        title: '测试长篇',
        tokens_per_char: 0.6,
        narration_subjectivity: 'objective_third',
        writer_token_budget: null,
        max_auto_rollback_chapters: 3,
        structured_json_retry: {
            max_retries: 5,
            backoff_ms: [1000, 2000, 4000, 8000, 16000]
        },
        craft_plugins: [],
        prose_gate: {
            enable_anti_cliche: true,
            enable_cross_chapter_simile: true,
            cross_chapter_simile_window: 5
        },
        ...overrides
    };
}

function createHeroProfile(): EntityProfile {
    return {
        metadata: {
            entity_id: 'char_001',
            canonical_name: '林雾',
            unique_aliases: ['阿雾'],
            contextual_titles: ['值夜生'],
            historical_anchors: ['ch_0001:天台值夜'],
            last_seen_ch: 44
        },
        sectionHeadings: {
            innateLocks: '## 1. Innate Locks',
            acquiredState: '## 2. Acquired State & Numeric Ledger',
            irreversibleTrajectory: '## 3. Irreversible Trajectory',
            recentBuffer: '## 4. Recent Sliding Buffer & Voice'
        },
        innateLocks: [
            {
                visibility: 'PUBLIC',
                text: '左眉骨有一道陈年旧疤，遇冷会泛红。',
                continuationLines: []
            },
            {
                visibility: 'SELF_ONLY',
                text: '对铁锈味极度敏感，闻到会指尖发凉。',
                continuationLines: []
            }
        ],
        acquiredState: [
            {
                storyDay: 10,
                chapter: 40,
                visibility: 'PUBLIC',
                text: '驻留节点：旧校舍天台',
                continuationLines: []
            },
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '持有半枚黄铜钥匙，左袖口沾有煤灰',
                continuationLines: []
            },
            {
                storyDay: 11,
                chapter: 42,
                visibility: 'PUBLIC',
                status: 'WARPED',
                text: '废止线：WARPED 原计划在食堂当众翻脸',
                continuationLines: []
            }
        ],
        irreversibleTrajectory: [
            {
                storyDay: 8,
                chapter: 30,
                visibility: 'PUBLIC',
                text: '已在旧钟楼与沈砚立下互不背叛的口头契约',
                continuationLines: []
            }
        ],
        recentBuffer: [
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '昨晚在走廊尽头听见楼上铁门轻响了一声，尚未查明来源。',
                continuationLines: []
            },
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '顺手把值班日志压在了暖气管下方，避免被巡夜人翻看。',
                continuationLines: []
            }
        ]
    };
}

function createBackgroundProfile(): EntityProfile {
    return {
        metadata: {
            entity_id: 'char_002',
            canonical_name: '神代雪乃',
            unique_aliases: ['雪乃'],
            contextual_titles: ['副会长'],
            historical_anchors: ['ch_0002:锁窗女生'],
            last_seen_ch: 10
        },
        sectionHeadings: {
            innateLocks: '## 1. Innate Locks',
            acquiredState: '## 2. Acquired State & Numeric Ledger',
            irreversibleTrajectory: '## 3. Irreversible Trajectory',
            recentBuffer: '## 4. Recent Sliding Buffer & Voice'
        },
        innateLocks: [
            {
                visibility: 'PUBLIC',
                text: '右手腕内侧有一道旧烫伤浅疤。',
                continuationLines: []
            }
        ],
        acquiredState: [
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '当场位置：站在档案室门外走廊窗边，神色平静。',
                continuationLines: []
            },
            {
                storyDay: 11,
                chapter: 41,
                visibility: 'READER_KNOWN',
                text: '其实早已偷偷备份了地下室备用钥匙。',
                continuationLines: []
            }
        ],
        irreversibleTrajectory: [
            {
                storyDay: 5,
                chapter: 10,
                visibility: 'PUBLIC',
                text: '曾因旧案被理事会记过一次。',
                continuationLines: []
            }
        ],
        recentBuffer: [
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '刚才在楼梯口擦肩而过时，袖口带着淡淡的松节油味道。',
                continuationLines: []
            },
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '口癖：回答问题前习惯先轻叩两下笔记本硬壳。',
                continuationLines: []
            }
        ]
    };
}

function createWarpedProfile(): EntityProfile {
    return {
        metadata: {
            entity_id: 'char_099',
            canonical_name: '废止幽灵角色',
            unique_aliases: [],
            contextual_titles: [],
            historical_anchors: [],
            last_seen_ch: 1,
            status: 'WARPED'
        },
        sectionHeadings: {
            innateLocks: '## 1. Innate Locks',
            acquiredState: '## 2. Acquired State & Numeric Ledger',
            irreversibleTrajectory: '## 3. Irreversible Trajectory',
            recentBuffer: '## 4. Recent Sliding Buffer & Voice'
        },
        innateLocks: [
            {
                visibility: 'PUBLIC',
                text: 'WARPED 不应出现在写手窗口的废止角色。',
                continuationLines: []
            }
        ],
        acquiredState: [],
        irreversibleTrajectory: [],
        recentBuffer: []
    };
}

function createSnapshot(configOverrides: Partial<BookConfig> = {}): BookSnapshot {
    return {
        config: createBaseConfig(configOverrides),
        worldState: {
            frontmatter: {
                story_day: 12,
                current_volume: 1,
                current_chapter: 45,
                pov_character: 'char_001',
                timeline_mode: 'MAINLINE'
            },
            summaryMarkdown: '当前处于第一卷冬夜封校阶段，旧钟楼停摆，众人被困校舍。'
        },
        txState: {
            phase: 'IDLE',
            active_chapter: null,
            last_committed_ch: 44,
            chapter_hashes: {},
            updated_at: '2026-11-16T00:00:00.000Z'
        },
        entities: {
            char_001: createHeroProfile(),
            char_002: createBackgroundProfile(),
            char_099: createWarpedProfile()
        },
        coldArchiveIds: [],
        chapterFiles: ['ch_0044.md']
    };
}

function createSampleRecallSlices(): RecallSlice[] {
    return [
        {
            file: 'manuscripts/vol_01/ch_0002.md',
            chapterId: 'ch_0002',
            chapterNumber: 2,
            chapterDay: 2,
            targetChapter: 45,
            targetDay: 12,
            deltaChapters: 43,
            deltaDays: 10,
            line: 18,
            text: '神代雪乃把黄铜钥匙放进风衣内袋，手指擦过腕侧旧疤。',
            contextBefore: ['走廊尽头的声控灯灭了。'],
            contextAfter: ['窗外正下着细雨。'],
            matchedKeys: ['神代雪乃', '黄铜钥匙'],
            snippet: '走廊尽头的声控灯灭了。\n神代雪乃把黄铜钥匙放进风衣内袋，手指擦过腕侧旧疤。\n窗外正下着细雨。'
        },
        {
            file: 'manuscripts/vol_01/ch_0018.md',
            chapterId: 'ch_0018',
            chapterNumber: 18,
            chapterDay: 6,
            targetChapter: 45,
            targetDay: 12,
            deltaChapters: 27,
            deltaDays: 6,
            line: 42,
            text: '档案室门锁有被撬动过的细微划痕，旁边落着一点松节油渍。',
            contextBefore: [],
            contextAfter: [],
            matchedKeys: ['档案室'],
            snippet: '档案室门锁有被撬动过的细微划痕，旁边落着一点松节油渍。'
        }
    ];
}

describe('PrefixAssembler', () => {
    it('同卷内 Planner 与 Writer 跨多章的 staticPrefixBlocks 字节与 SHA-256 100% 一致', async () => {
        const assembler = new PrefixAssembler();
        const slicer = new ViewSlicer();
        const snapshot = createSnapshot();
        const llm = new ScriptedLlmAdapter([
            {
                text: '细纲完成',
                usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 100, outputTokens: 20 }
            },
            {
                text: '第45章正文',
                usage: { inputTokens: 120, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 500 }
            },
            {
                text: '第46章细纲',
                usage: { inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 20 }
            },
            {
                text: '第46章正文',
                usage: { inputTokens: 120, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 500 }
            }
        ]);

        const staticInputs = {
            volumeNumber: 1,
            systemBaseline: '你是长篇小说创作引擎执行单元，遵循净室单轮生成契约。',
            staticBaseAndVoice: '句式克制精准，通过动作与器物细节推进情绪，不直接贴心理标签。',
            currentArcEnvelope: '第一卷：冬夜封校篇，核心矛盾围绕旧钟楼钥匙归属展开。',
            worldStaticBaseline: snapshot.worldState.summaryMarkdown,
            positiveConstraints: ['所有描写必须落在可感知的物理动作、光线与声音槽位中。']
        };

        const plannerView45 = slicer.sliceForPlanner(snapshot, { targetDay: 12, currentCh: 45 });
        const writerView45 = slicer.sliceForWriter(snapshot, { targetDay: 12, currentCh: 45 });

        const reqPlanner45 = assembler.assemblePlannerRequest({
            config: snapshot.config,
            staticPrefix: staticInputs,
            slicedView: plannerView45,
            chapterGoal: '第45章：林雾在档案室外与神代雪乃试探交锋。',
            opsStyleAmendments: '对话避免连续三轮以上纯站桩问答。'
        });
        const ledgerProfile = plannerView45.entities['char_001']!;
        ledgerProfile.acquiredState.push({ text: '分类测试事实', continuationLines: [], visibility: 'OMNISCIENT_SECRET', owner: 'char_001', status: 'ACTIVE' });
        const tagged = assembler.assemblePlannerRequest({ config: snapshot.config, staticPrefix: staticInputs, slicedView: plannerView45, chapterGoal: '核对账本分类' });
        expect(tagged.request.dynamicTail).toContain('vis:OMNISCIENT_SECRET | owner:char_001 | status:ACTIVE');
        ledgerProfile.acquiredState.at(-1)!.visibility = 'PUBLIC';
        const publicTagged = assembler.assemblePlannerRequest({ config: snapshot.config, staticPrefix: staticInputs, slicedView: plannerView45, chapterGoal: '核对账本分类' });
        expect(publicTagged.request.dynamicTail).toContain('vis:PUBLIC | owner:char_001 | status:ACTIVE');
        expect(publicTagged.request.dynamicTail).not.toBe(tagged.request.dynamicTail);
        const reqWriter45 = assembler.assembleWriterRequest({
            config: snapshot.config,
            staticPrefix: staticInputs,
            slicedView: writerView45,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾推开档案室半扇门，借还钥匙试探神代雪乃反应。',
            opsStyleAmendments: '对话避免连续三轮以上纯站桩问答。'
        });

        // 模拟第 46 章动态状态变化（story_day/current_chapter/ops_style_amendments 均改变）
        const snapshot46 = createSnapshot();
        snapshot46.worldState.frontmatter.story_day = 13;
        snapshot46.worldState.frontmatter.current_chapter = 46;

        const plannerView46 = slicer.sliceForPlanner(snapshot46, { targetDay: 13, currentCh: 46 });
        const writerView46 = slicer.sliceForWriter(snapshot46, { targetDay: 13, currentCh: 46 });

        const reqPlanner46 = assembler.assemblePlannerRequest({
            config: snapshot46.config,
            staticPrefix: staticInputs,
            slicedView: plannerView46,
            chapterGoal: '第46章：钟楼顶层对峙。',
            opsStyleAmendments: '新增修补：雨夜声响描写精简。'
        });
        const reqWriter46 = assembler.assembleWriterRequest({
            config: snapshot46.config,
            staticPrefix: staticInputs,
            slicedView: writerView46,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾登上钟楼顶层。',
            opsStyleAmendments: '新增修补：雨夜声响描写精简。'
        });

        await llm.generate(reqPlanner45.request);
        await llm.generate(reqWriter45.request);
        await llm.generate(reqPlanner46.request);
        await llm.generate(reqWriter46.request);

        expect(llm.history).toHaveLength(4);
        const hashes = llm.history.map((item) => item.prefixHash);
        expect(new Set(hashes).size).toBe(1);
        expect(reqPlanner45.request.staticPrefixBlocks).toEqual(reqWriter45.request.staticPrefixBlocks);
        expect(reqWriter45.request.staticPrefixBlocks).toEqual(reqWriter46.request.staticPrefixBlocks);

        // 换卷后静态前缀指纹应当发生变化
        const reqNextVol = assembler.assembleWriterRequest({
            config: snapshot46.config,
            staticPrefix: {
                ...staticInputs,
                volumeNumber: 2,
                currentArcEnvelope: '第二卷：春季解封篇。'
            },
            slicedView: writerView46,
            focusCastIds: ['char_001'],
            outline: '新卷开篇。'
        });
        expect(hashStaticPrefix(reqNextVol.request.staticPrefixBlocks)).not.toBe(hashes[0]);
    });

    it('voice_samples.yaml 支持自由标签、LRU 连续 3 章以上无连挂抽样及持久化读写', async () => {
        const yamlText = `
samples:
  - id: vs_1
    tag: 冷峻白描
    text: "他没回头，只把打火机合上，金属脆响在空走廊里荡了一瞬。"
    last_used_ch: 10
  - id: vs_2
    tag: 对话机锋
    text: "“你数过楼梯吗？”她把杯沿转了半圈，“第三级昨晚响了两下。”"
    last_used_ch: 11
  - id: vs_3
    tag: 感官收束
    text: "风从门缝钻进来，带着铁锈和潮湿水泥的凉意。"
    last_used_ch: 0
`;
        let pool: VoiceSamplePool = parseVoiceSamplesYaml(yamlText);
        expect(pool.samples).toHaveLength(3);

        // 连续 3 章抽样：第 12、13、14 章应当分别命中 vs_3 -> vs_1 -> vs_2，零连挂重复
        const picks: string[] = [];
        for (const ch of [12, 13, 14]) {
            const res = sampleVoiceLru(pool, { currentCh: ch });
            expect(res.sample).not.toBeNull();
            picks.push(res.sample!.id);
            pool = res.updatedPool;
        }
        expect(picks).toEqual(['vs_3', 'vs_1', 'vs_2']);
        expect(new Set(picks).size).toBe(3);

        // 持久化到临时目录再读回，LRU 状态保持一致
        const tmpDir = await mkdtemp(join(tmpdir(), 'narrateos-voice-'));
        try {
            const yamlPath = join(tmpDir, 'voice_samples.yaml');
            await saveVoiceSamples(yamlPath, pool);
            const reloaded = await loadVoiceSamples(yamlPath);
            expect(reloaded.samples.map((s) => ({ id: s.id, last_used_ch: s.last_used_ch }))).toEqual([
                { id: 'vs_1', last_used_ch: 13 },
                { id: 'vs_2', last_used_ch: 14 },
                { id: 'vs_3', last_used_ch: 12 }
            ]);

            // 支持按指定自定义标签抽样
            const tagged = sampleVoiceLru(reloaded, { currentCh: 15, preferredTag: '对话机锋' });
            expect(tagged.sample?.id).toBe('vs_2');
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }

        // 0 条标本池不报错且返回 null
        const emptyRes = sampleVoiceLru({ samples: [] }, { currentCh: 1 });
        expect(emptyRes.sample).toBeNull();
    });

    it('动态尾完整拼装切片、时间差信封、ops_style_amendments 且零 WARPED 与零规划期插件泄露', async () => {
        const assembler = new PrefixAssembler();
        const slicer = new ViewSlicer();
        const snapshot = createSnapshot({
            craft_plugins: ['vad-bdi', 'dual-reaction', 'scene-act', 'writer-sensory']
        });
        const loader = new CraftPluginLoader();
        const loadedYamlPlugins = await loader.loadForBook({
            searchDirs: [REPO_CRAFT_PLUGINS_DIR],
            enabledPluginIds: ['vad-bdi', 'dual-reaction', 'scene-act']
        });
        const customPlugins: Record<string, CraftPluginDefinition> = {
            'writer-sensory': {
                id: 'writer-sensory',
                title: '轻量感官落点提示',
                promptText: '每场收尾停留在具体器物或光线画面。',
                applicable_roles: ['writer']
            }
        };
        for (const item of loadedYamlPlugins) {
            customPlugins[item.plugin.id] = {
                id: item.plugin.id,
                title: item.plugin.name,
                promptText: item.plugin.prompt_injection,
                applicable_roles: item.plugin.applicable_roles.filter(
                    (role): role is 'planner' | 'writer' => role === 'planner' || role === 'writer'
                )
            };
        }

        const plannerView = slicer.sliceForPlanner(snapshot, { targetDay: 12, currentCh: 45 });
        const writerView = slicer.sliceForWriter(snapshot, { targetDay: 12, currentCh: 45 });
        const slices = createSampleRecallSlices();

        const plannerResult = assembler.assemblePlannerRequest({
            config: snapshot.config,
            staticPrefix: {
                volumeNumber: 1,
                systemBaseline: '净室系统指令',
                staticBaseAndVoice: '抽象句法纪律锁'
            },
            slicedView: plannerView,
            chapterGoal: '安排林雾与神代雪乃的试探交锋。',
            customPlugins
        });
        expect(plannerResult.request.dynamicTail).toContain('vad-bdi');
        expect(plannerResult.request.dynamicTail).toContain('dual-reaction');
        expect(plannerResult.request.dynamicTail).toContain('scene-act');

        const result = assembler.assembleWriterRequest({
            config: snapshot.config,
            staticPrefix: {
                volumeNumber: 1,
                systemBaseline: '净室系统指令',
                staticBaseAndVoice: '抽象句法纪律锁'
            },
            slicedView: writerView,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾与神代雪乃在档案室外简短交锋。',
            opsStyleAmendments: '本卷新增：禁止连续使用抽象形容词堆叠。',
            recallSlices: slices,
            loreEntries: ['设定词条：旧钟楼每逢冬夜十一点会因温差发出一声齿轮咬合响动。'],
            previousChapter: {
                chapterNumber: 44,
                fullText: '上一章完整原文：林雾收起值班手电，沿着二楼东侧走廊走向档案室。',
                summary: '上一章摘要：林雾值夜巡查后前往档案室。',
                tailWindow: '上一章尾窗：林雾的手指刚搭上门把，走廊尽头亮起一点微弱的手机屏幕光。'
            },
            voicePool: {
                samples: [
                    {
                        id: 'vs_a',
                        tag: '冷峻白描',
                        text: '他没有立刻推门，只听着门轴里的一点沙沙声。',
                        last_used_ch: 0,
                        use_count: 0
                    }
                ]
            },
            customPlugins
        });

        const tail = result.request.dynamicTail;
        const fullPrefix = result.request.staticPrefixBlocks.join('\n\n');

        // 零 WARPED 残留
        expect(fullPrefix).not.toContain('WARPED');
        expect(tail).not.toContain('WARPED');
        expect(tail).not.toContain('废止幽灵角色');
        expect(tail).not.toContain('在食堂当众翻脸');

        // Writer 严禁注入规划期重型认知插件，但允许显式标明 writer 的轻量提示
        expect(tail).not.toContain('vad-bdi');
        expect(tail).not.toContain('dual-reaction');
        expect(tail).not.toContain('scene-act');
        expect(tail).toContain('writer-sensory');

        // 各项动态内容齐全
        expect(tail).toContain('禁止连续使用抽象形容词堆叠');
        expect(tail).toContain('相距43章');
        expect(tail).toContain('神代雪乃把黄铜钥匙放进风衣内袋');
        expect(tail).toContain('右手腕内侧有一道旧烫伤浅疤'); // 感官唤醒 hint
        expect(tail).toContain('偷偷备份了地下室备用钥匙'); // 戏剧反讽桌下炸弹
        expect(tail).toContain('冷峻白描');
        expect(tail).toContain('上一章完整原文');
    });

    it('writer_token_budget 为 null 或未超限时无损直通；超限时严格按 L1->L2->L3->L4 顺序逐级降级且不触碰静态前缀与核心红线', () => {
        const assembler = new PrefixAssembler();
        const slicer = new ViewSlicer();
        const baseSnapshot = createSnapshot({ writer_token_budget: null });
        const writerView = slicer.sliceForWriter(baseSnapshot, { targetDay: 12, currentCh: 45 });

        const longPrevFullText = '上一章完整原文：' + '走廊尽头的雨声敲打着旧玻璃窗，林雾握紧手电。'.repeat(40);
        const longTailWindow = '上一章尾窗：林雾停在档案室门前。';
        const slices = createSampleRecallSlices();
        const loreEntries = [
            '外围设定1：旧钟楼建于上世纪三十年代，内部齿轮已锈蚀多年。',
            '外围设定2：档案室东侧百叶窗常年卡死，只能掀开两指宽的缝隙。'
        ];

        const baseInput = {
            staticPrefix: {
                volumeNumber: 1,
                systemBaseline: '净室基准指令',
                staticBaseAndVoice: '抽象文风纪律锁'
            },
            slicedView: writerView,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾推门试探。',
            recallSlices: slices,
            loreEntries,
            previousChapter: {
                chapterNumber: 44,
                fullText: longPrevFullText,
                summary: '上一章摘要：林雾巡夜后抵达档案室门前。',
                tailWindow: longTailWindow
            }
        };

        // 1. budget = null -> 无损直通
        const noBudgetRes = assembler.assembleWriterRequest({
            ...baseInput,
            config: createBaseConfig({ writer_token_budget: null })
        });
        expect(noBudgetRes.diagnostics.evictionLevel).toBe(0);
        expect(noBudgetRes.diagnostics.truncated).toBe(false);
        expect(noBudgetRes.request.dynamicTail).toContain(longPrevFullText);
        expect(noBudgetRes.request.dynamicTail).toContain('刚才在楼梯口擦肩而过时');

        // 2. L1 降级：前章全文 -> 尾窗摘要，L2 及之后不触碰
        const level1Budget = Math.ceil(
            (noBudgetRes.request.staticPrefixBlocks.join('\n\n').length +
                noBudgetRes.request.dynamicTail.length -
                longPrevFullText.length +
                longTailWindow.length +
                80) *
                0.6
        );
        const level1Res = assembler.assembleWriterRequest({
            ...baseInput,
            config: createBaseConfig({ writer_token_budget: level1Budget })
        });
        expect(level1Res.diagnostics.evictionLevel).toBe(1);
        expect(level1Res.request.dynamicTail).not.toContain(longPrevFullText);
        expect(level1Res.request.dynamicTail).toContain(longTailWindow);
        expect(level1Res.request.dynamicTail).toContain('刚才在楼梯口擦肩而过时');
        expect(level1Res.request.dynamicTail).toContain('外围设定1');

        // 3. L2 降级：background_cast 压缩为单行简卡（含口癖/声纹），但 loreEntries 与 recallSlices 仍完整保留
        const level2Budget = level1Res.diagnostics.estimatedTokens - 20;
        const level2Res = assembler.assembleWriterRequest({
            ...baseInput,
            config: createBaseConfig({ writer_token_budget: level2Budget })
        });
        expect(level2Res.diagnostics.evictionLevel).toBe(2);
        expect(level2Res.request.dynamicTail).toContain('神代雪乃');
        expect(level2Res.request.dynamicTail).toContain('口癖：回答问题前习惯先轻叩两下笔记本硬壳');
        expect(level2Res.request.dynamicTail).not.toContain('刚才在楼梯口擦肩而过时');
        expect(level2Res.request.dynamicTail).toContain('神代雪乃把黄铜钥匙放进风衣内袋'); // recallSlices 完整保留
        expect(level2Res.request.dynamicTail).toContain('外围设定2'); // loreEntries 完整保留

        // 4. L3 降级：缩减 recallSlices，仍保留 loreEntries
        const level3Budget = level2Res.diagnostics.estimatedTokens - 35;
        const level3Res = assembler.assembleWriterRequest({
            ...baseInput,
            config: createBaseConfig({ writer_token_budget: level3Budget })
        });
        expect(level3Res.diagnostics.evictionLevel).toBe(3);
        expect(level3Res.request.dynamicTail).toContain('外围设定1');
        expect(level3Res.request.dynamicTail).toContain('外围设定2');

        // 必需上下文本身超预算时必须拒绝，不能返回仍然超限的请求。
        expect(() => assembler.assembleWriterRequest({
            ...baseInput,
            config: createBaseConfig({ writer_token_budget: 1 })
        })).toThrow('写手预算无法满足');
    });

    it('recallSlices 为空时，L4 仍真实重新渲染并重算 totalTokens 直至达标', () => {
        const assembler = new PrefixAssembler();
        const slicer = new ViewSlicer();
        const snapshot = createSnapshot({ writer_token_budget: null });
        const writerView = slicer.sliceForWriter(snapshot, { targetDay: 12, currentCh: 45 });

        const loreEntries = [
            '外围设定A：' + '旧钟楼地下管道在冬夜会持续结霜。'.repeat(6),
            '外围设定B：' + '档案室西窗外种着三棵老槐树。'.repeat(6),
            '外围设定C：' + '值班室煤油灯芯每周五更换一次。'.repeat(6)
        ];

        const baseRes = assembler.assembleWriterRequest({
            config: createBaseConfig({ writer_token_budget: null }),
            staticPrefix: {
                volumeNumber: 1,
                systemBaseline: '净室基准指令'
            },
            slicedView: writerView,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾核对值班表。',
            recallSlices: [],
            loreEntries
        });

        const l2Res = assembler.assembleWriterRequest({
            config: createBaseConfig({
                writer_token_budget: baseRes.diagnostics.estimatedTokens - 10
            }),
            staticPrefix: {
                volumeNumber: 1,
                systemBaseline: '净室基准指令'
            },
            slicedView: writerView,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾核对值班表。',
            recallSlices: [],
            loreEntries
        });
        expect(l2Res.diagnostics.evictionLevel).toBe(2);

        // 预算设在 L2 之后仍超标、仅保留 1 条外围设定后即可达标的区间（跳过空的 L3，直接触发 L4）
        const removedTwoLoreTokens = Math.floor((loreEntries[1]!.length + loreEntries[2]!.length) * 0.6);
        const targetBudget = l2Res.diagnostics.estimatedTokens - removedTwoLoreTokens + 15;

        const res = assembler.assembleWriterRequest({
            config: createBaseConfig({ writer_token_budget: targetBudget }),
            staticPrefix: {
                volumeNumber: 1,
                systemBaseline: '净室基准指令'
            },
            slicedView: writerView,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾核对值班表。',
            recallSlices: [],
            loreEntries
        });

        expect(res.diagnostics.evictionLevel).toBe(4);
        expect(res.diagnostics.estimatedTokens).toBeLessThanOrEqual(targetBudget);
        expect(res.request.dynamicTail).toContain('外围设定A');
        expect(res.request.dynamicTail).not.toContain('外围设定C');
    });

    it('VoiceSample.source 支持 author_sample / boot_seed / chapter_harvest 无损往返序列化与 LRU 保留', () => {
        const yamlText = `
samples:
  - id: vs_author
    tag: 白描
    text: "他把钥匙放在柜台边缘，没有抬头。"
    last_used_ch: 0
    source: author_sample
  - id: vs_boot
    tag: 动作
    text: "风铃响了一声，门帘被一只戴手套的手掀开。"
    last_used_ch: 1
    source: boot_seed
  - id: vs_harvest
    tag: 对话
    text: "“账本还差两页。”她说完合上钢笔帽。"
    last_used_ch: 2
    source: chapter_harvest
  - id: vs_legacy
    tag: 兼容旧格式
    text: "走廊尽头的灯闪烁了两下。"
    last_used_ch: 3
`;
        const parsed = parseVoiceSamplesYaml(yamlText);
        expect(parsed.samples.map((s) => s.source)).toEqual([
            'author_sample',
            'boot_seed',
            'chapter_harvest',
            undefined
        ]);

        const serialized = serializeVoiceSamplesYaml(parsed);
        const reparsed = parseVoiceSamplesYaml(serialized);
        expect(reparsed.samples.map((s) => s.source)).toEqual([
            'author_sample',
            'boot_seed',
            'chapter_harvest',
            undefined
        ]);

        const lruRes = sampleVoiceLru(reparsed, { currentCh: 5 });
        expect(lruRes.sample?.id).toBe('vs_author');
        expect(lruRes.sample?.source).toBe('author_sample');
    });

    it('assembleWriterRequest 拒绝非 writer 视图，清洗 loreEntries 机密，且 buildStaticPrefixBlocks 不注入单轮冲突话术', () => {
        const assembler = new PrefixAssembler();
        const slicer = new ViewSlicer();
        const snapshot = createSnapshot();
        const plannerView = slicer.sliceForPlanner(snapshot, { targetDay: 12, currentCh: 45 });

        expect(() =>
            assembler.assembleWriterRequest({
                config: snapshot.config,
                staticPrefix: { volumeNumber: 1, staticBaseAndVoice: '句法简洁。' },
                slicedView: plannerView,
                outline: '林雾推门试探。'
            })
        ).toThrow("assembleWriterRequest 仅接受 forRole === 'writer'");

        const staticBlocks = buildStaticPrefixBlocks({
            volumeNumber: 1,
            staticBaseAndVoice: '句法简洁。'
        });
        expect(staticBlocks.join('\n')).not.toContain('单轮作答');

        const writerView = slicer.sliceForWriter(snapshot, { targetDay: 12, currentCh: 45 });
        const writerRes = assembler.assembleWriterRequest({
            config: snapshot.config,
            staticPrefix: { volumeNumber: 1, staticBaseAndVoice: '句法简洁。' },
            slicedView: writerView,
            outline: '林雾推门试探。',
            loreEntries: [
                [
                    '- 公开词条：钟楼齿轮每晚十一点响动。',
                    '- [vis: OMNISCIENT_SECRET] 秘密词条：初代校长遗骸在钟摆内部',
                    ' 单空格续行：大结局才能揭晓',
                    '> 顶格引用续行：不可提前曝光',
                    '- [SELF_ONLY] 仅反派知道的暗门位置'
                ].join('\n')
            ]
        });

        expect(writerRes.request.dynamicTail).toContain('钟楼齿轮每晚十一点响动');
        expect(writerRes.request.dynamicTail).not.toContain('OMNISCIENT_SECRET');
        expect(writerRes.request.dynamicTail).not.toContain('单空格续行');
        expect(writerRes.request.dynamicTail).not.toContain('顶格引用续行');
        expect(writerRes.request.dynamicTail).not.toContain('SELF_ONLY');
        expect(writerRes.request.staticPrefixBlocks.join('\n')).not.toContain('单轮作答');
    });

    it('partitionCast 在 background_cast 为空数组时仍将未列入 focus_cast 的活跃实体兜底归入 backgroundCast', () => {
        const assembler = new PrefixAssembler();
        const slicer = new ViewSlicer();
        const snapshot = createSnapshot();
        snapshot.entities['item_001'] = {
            metadata: {
                entity_id: 'item_001',
                canonical_name: '黄铜钥匙',
                unique_aliases: [],
                contextual_titles: [],
                historical_anchors: [],
                last_seen_ch: 44
            },
            sectionHeadings: {
                innateLocks: '## 1. Innate Locks',
                acquiredState: '## 2. Acquired State & Numeric Ledger',
                irreversibleTrajectory: '## 3. Irreversible Trajectory',
                recentBuffer: '## 4. Recent Sliding Buffer & Voice'
            },
            innateLocks: [{ visibility: 'PUBLIC', text: '齿面刻有 04 编号', continuationLines: [] }],
            acquiredState: [{ storyDay: 12, chapter: 44, visibility: 'PUBLIC', text: '放在档案室抽屉内', continuationLines: [] }],
            irreversibleTrajectory: [],
            recentBuffer: []
        };

        const writerView = slicer.sliceForWriter(snapshot, { targetDay: 12, currentCh: 45 });
        const res = assembler.assembleWriterRequest({
            config: snapshot.config,
            staticPrefix: { volumeNumber: 1 },
            slicedView: writerView,
            focusCastIds: ['char_001'],
            backgroundCastIds: [],
            outline: '林雾查找黄铜钥匙。'
        });

        expect(res.request.dynamicTail).toContain('神代雪乃');
        expect(res.request.dynamicTail).toContain('黄铜钥匙');
        expect(res.request.dynamicTail).toContain('齿面刻有 04 编号');
    });

    it('cleanroomDisplay 剥离工程标签并动态渲染 isNumericLedger，compactCard 保留全部先天红线、最新状态与声纹续行', () => {
        const assembler = new PrefixAssembler();
        const slicer = new ViewSlicer();
        const snapshot = createSnapshot();
        const hero = snapshot.entities['char_001']!;
        hero.acquiredState.push(
            {
                storyDay: 12,
                chapter: 44,
                slotKey: 'location',
                visibility: 'PUBLIC',
                owner: 'char_001',
                status: 'ACTIVE',
                text: '当前停留在档案室外走廊',
                continuationLines: []
            },
            {
                isNumericLedger: true,
                ledger: { 剩余手电电量: '35%', 银元: '12' },
                text: '',
                continuationLines: []
            }
        );

        const bg = snapshot.entities['char_002']!;
        bg.innateLocks.push({
            visibility: 'PUBLIC',
            text: '左耳对高频金属摩擦声极度厌恶。',
            continuationLines: []
        });
        bg.acquiredState = [
            { storyDay: 5, chapter: 10, visibility: 'PUBLIC', text: '旧状态：曾在医务室休养', continuationLines: [] },
            { storyDay: 12, chapter: 44, visibility: 'PUBLIC', text: '最新状态：站在档案室窗边警戒', continuationLines: [] }
        ];
        bg.recentBuffer = [
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '口癖：回答问题前先轻叩笔记本硬壳',
                continuationLines: ['  > 标本：「钥匙不在我这，你自己看抽屉。」']
            }
        ];

        const writerView = slicer.sliceForWriter(snapshot, { targetDay: 12, currentCh: 45 });
        const writerRes = assembler.assembleWriterRequest({
            config: snapshot.config,
            staticPrefix: { volumeNumber: 1 },
            slicedView: writerView,
            focusCastIds: ['char_001'],
            backgroundCastIds: ['char_002'],
            outline: '林雾核对电量与钥匙。'
        });

        expect(writerRes.request.dynamicTail).not.toMatch(/\b(?:slot|vis|owner|status):/);
        expect(writerRes.request.dynamicTail).toContain('（第12天，第44章）');
        expect(writerRes.request.dynamicTail).toContain('剩余手电电量: 35%');
        expect(writerRes.request.dynamicTail).toContain('银元: 12');

        const compact = renderEntityProfile(bg, {
            compactCard: true,
            stripWarped: true,
            cleanroomDisplay: true
        });
        expect(compact).toContain('右手腕内侧有一道旧烫伤浅疤。');
        expect(compact).toContain('左耳对高频金属摩擦声极度厌恶。');
        expect(compact).toContain('最新状态：站在档案室窗边警戒');
        expect(compact).not.toContain('旧状态：曾在医务室休养');
        expect(compact).toContain('标本：「钥匙不在我这，你自己看抽屉。」');

        // Planner 模式保持工程标签同时动态渲染 ledger
        const plannerView = slicer.sliceForPlanner(snapshot, { targetDay: 12, currentCh: 45 });
        const plannerRes = assembler.assemblePlannerRequest({
            config: snapshot.config,
            staticPrefix: { volumeNumber: 1 },
            slicedView: plannerView,
            chapterGoal: '核对账本与工程标签。'
        });
        expect(plannerRes.request.dynamicTail).toContain('slot:location | vis:PUBLIC | owner:char_001 | status:ACTIVE');
        expect(plannerRes.request.dynamicTail).toContain('[Tracked Numeric Ledger] 剩余手电电量: 35% | 银元: 12');
    });

    it('renderRecallSlice 命中机密或 WARPED（含上下文续行）整条丢弃，evictDynamicTailToBudget 按每实体保底 1 条区分必需与可选切片', () => {
        const baseSlice: RecallSlice = {
            file: 'manuscripts/vol_01/ch_0005.md',
            chapterId: 'ch_0005',
            chapterNumber: 5,
            chapterDay: 3,
            targetChapter: 45,
            targetDay: 12,
            deltaChapters: 40,
            deltaDays: 9,
            line: 10,
            text: '表面正常的走廊描写。',
            contextBefore: ['窗外风声渐停。'],
            contextAfter: ['[OMNISCIENT_SECRET] 其实密道钥匙就在门框上方。'],
            matchedKeys: ['走廊'],
            snippet: '窗外风声渐停。\n表面正常的走廊描写。\n[OMNISCIENT_SECRET] 其实密道钥匙就在门框上方。'
        };
        expect(renderRecallSlice(baseSlice, true)).toBe('');

        const selfOnlyContextSlice: RecallSlice = {
            ...baseSlice,
            text: '看似公开的对话。',
            contextBefore: ['[SELF_ONLY] 只有反派才知道的暗号'],
            contextAfter: [],
            snippet: '看似公开的对话。'
        };
        expect(renderRecallSlice(selfOnlyContextSlice, true)).toBe('');

        const snapshot = createSnapshot();
        const writerView = new ViewSlicer().sliceForWriter(snapshot, { targetDay: 12, currentCh: 45 });
        const reqSlice1: RecallSlice = {
            ...baseSlice,
            requiredEntityId: 'char_001',
            contextBefore: [],
            contextAfter: [],
            text: '必须保底的第一条核心证据。',
            snippet: '必须保底的第一条核心证据。'
        };
        const reqSlice2Dup: RecallSlice = {
            ...baseSlice,
            requiredEntityId: 'char_001',
            chapterId: 'ch_0006',
            chapterNumber: 6,
            contextBefore: [],
            contextAfter: [],
            text: '同一实体的第二条冗余证据（应归入可选裁剪池，内容较长用于测试裁剪）。' + '冗余补充。'.repeat(12),
            snippet: '同一实体的第二条冗余证据（应归入可选裁剪池，内容较长用于测试裁剪）。' + '冗余补充。'.repeat(12)
        };

        // 仅含 1 条保底切片（0 条可选切片），若仍触发 L4 缩减 lore，绝不伪报 L3
        const onlyRequiredBase = evictDynamicTailToBudget(
            ['静态前缀'],
            {
                opsStyleAmendments: '',
                craftPluginsSection: '',
                taskSection: '## 执笔任务\n写第45章',
                voiceSampleSection: '',
                futureHorizonSection: '',
                focusCast: [writerView.entities['char_001']!],
                backgroundCast: [],
                dramaticIronyLines: [],
                memoryWakeupLines: [],
                parallelBroadcastLines: [],
                recallSlices: [reqSlice1],
                loreEntries: ['外围设定条目：' + '旧校舍走廊风声很大。'.repeat(10)],
                stripWarped: true,
                cleanroomDisplay: true
            },
            0.6,
            null
        );
        const l4NoFakeL3 = evictDynamicTailToBudget(
            ['静态前缀'],
            {
                opsStyleAmendments: '',
                craftPluginsSection: '',
                taskSection: '## 执笔任务\n写第45章',
                voiceSampleSection: '',
                futureHorizonSection: '',
                focusCast: [writerView.entities['char_001']!],
                backgroundCast: [],
                dramaticIronyLines: [],
                memoryWakeupLines: [],
                parallelBroadcastLines: [],
                recallSlices: [reqSlice1],
                loreEntries: ['外围设定条目：' + '旧校舍走廊风声很大。'.repeat(10)],
                stripWarped: true,
                cleanroomDisplay: true
            },
            0.6,
            onlyRequiredBase.estimatedTokens - 20
        );
        expect(l4NoFakeL3.evictionLevel).toBe(4);
        expect(l4NoFakeL3.appliedEvictions.some((e) => e.startsWith('L3:'))).toBe(false);
        expect(l4NoFakeL3.dynamicTail).toContain('必须保底的第一条核心证据');

        // 当同一 requiredEntityId 有 2 条切片时，第 1 条保底，第 2 条可在 L3 被裁掉
        const twoSliceBase = evictDynamicTailToBudget(
            ['静态前缀'],
            {
                opsStyleAmendments: '',
                craftPluginsSection: '',
                taskSection: '## 执笔任务\n写第45章',
                voiceSampleSection: '',
                futureHorizonSection: '',
                focusCast: [writerView.entities['char_001']!],
                backgroundCast: [],
                dramaticIronyLines: [],
                memoryWakeupLines: [],
                parallelBroadcastLines: [],
                recallSlices: [reqSlice1, reqSlice2Dup],
                loreEntries: [],
                stripWarped: true,
                cleanroomDisplay: true
            },
            0.6,
            null
        );
        const l3EvictedDup = evictDynamicTailToBudget(
            ['静态前缀'],
            {
                opsStyleAmendments: '',
                craftPluginsSection: '',
                taskSection: '## 执笔任务\n写第45章',
                voiceSampleSection: '',
                futureHorizonSection: '',
                focusCast: [writerView.entities['char_001']!],
                backgroundCast: [],
                dramaticIronyLines: [],
                memoryWakeupLines: [],
                parallelBroadcastLines: [],
                recallSlices: [reqSlice1, reqSlice2Dup],
                loreEntries: [],
                stripWarped: true,
                cleanroomDisplay: true
            },
            0.6,
            twoSliceBase.estimatedTokens - 10
        );
        expect(l3EvictedDup.evictionLevel).toBe(3);
        expect(l3EvictedDup.dynamicTail).toContain('必须保底的第一条核心证据');
        expect(l3EvictedDup.dynamicTail).not.toContain('同一实体的第二条冗余证据');
    });

    it('resolveCraftPluginsSection 对未知插件 ID 返回空且不输出占位文本', () => {
        expect(resolveCraftPluginsSection(['nonexistent-plugin'], 'planner')).toBe('');
        expect(resolveCraftPluginsSection(['nonexistent-plugin'], 'writer', {})).toBe('');
    });
});

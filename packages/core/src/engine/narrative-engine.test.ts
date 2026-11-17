import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
    type CleanroomResponse,
    NodeSystemAdapter,
    ScriptedLlmAdapter,
    type TokenUsage
} from '../ports/index.js';
import { BookStore, TxLockConflictError } from '../store/index.js';
import {
    NarrativeEngine,
    SafeHaltError,
    type SafeHaltSnapshot
} from './index.js';

const FIXTURE_BOOK_DIR = resolve(import.meta.dirname, '../../../../fixtures/sample-book');
const tempDirs: string[] = [];

const ZERO_USAGE: TokenUsage = {
    inputTokens: 100,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    outputTokens: 50
};

function jsonResponse(payload: unknown): CleanroomResponse {
    return {
        text: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
        usage: { ...ZERO_USAGE }
    };
}

function textResponse(text: string): CleanroomResponse {
    return {
        text,
        usage: { ...ZERO_USAGE }
    };
}

async function createEngineFixture(): Promise<{
    bookRoot: string;
    system: NodeSystemAdapter;
    store: BookStore;
}> {
    const bookRoot = await mkdtemp(join(tmpdir(), 'narrateos-engine-test-'));
    tempDirs.push(bookRoot);
    await cp(FIXTURE_BOOK_DIR, bookRoot, { recursive: true });
    await mkdir(join(bookRoot, 'entities/cold_archive'), { recursive: true });
    await mkdir(join(bookRoot, '.ops'), { recursive: true });

    const char001 = [
        '---',
        'entity_id: char_001',
        'canonical_name: 陆沉',
        'unique_aliases: ["小沉"]',
        'contextual_titles: ["社长"]',
        'historical_anchors: ["ch_0001:旧校舍钥匙"]',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: SELF_ONLY] 左手腕对低温金属过敏',
        '- [vis: PUBLIC] 习惯用右手转中性笔',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC] 驻留节点：旧校舍三楼社团活动室',
        '- [day:1 | ch:01 | vis: OMNISCIENT_SECRET] 秘密持有备用铁盒钥匙',
        '- [day:1 | ch:01 | vis: PUBLIC | status: WARPED] 已遗失旧校舍钥匙的废止记忆',
        '- [Tracked Numeric Ledger] 社团剩余经费: 1200日元 | 备用钥匙数: 1',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 收到星野琉璃递交的废部预警单',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 在活动室窗边与星野琉璃对峙',
        ''
    ].join('\n');

    const char002 = [
        '---',
        'entity_id: char_002',
        'canonical_name: 星野琉璃',
        'unique_aliases: ["琉璃"]',
        'contextual_titles: ["学生会书记"]',
        'historical_anchors: ["ch_0001:星野琉璃"]',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: SELF_ONLY] 随身携带机械秒表但从不向外人展示',
        '- [vis: PUBLIC] 说话语速平稳，习惯扶眼镜框',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC] 当前位置：旧校舍三楼走廊',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 递交废部预警单',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 在活动室门前停步观察',
        ''
    ].join('\n');

    const item001 = [
        '---',
        'entity_id: item_001',
        'canonical_name: 黄铜钥匙',
        'unique_aliases: ["旧活动室钥匙"]',
        'contextual_titles: []',
        'historical_anchors: ["ch_0001:黄铜钥匙"]',
        'last_seen_ch: 1',
        '---',
        '',
        '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
        '- [vis: PUBLIC] 唯一物理实体：齿痕缺了一角的黄铜钥匙',
        '',
        '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
        '- [day:1 | ch:01 | vis: PUBLIC | owner: char_001] 当前归属：陆沉右裤袋',
        '',
        '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
        '- [day:1 | ch:01] 由陆沉从旧校舍门卫室领回',
        '',
        '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
        '- [day:1 | ch:01] 钥匙齿面沾有灰尘',
        ''
    ].join('\n');

    await writeFile(join(bookRoot, 'entities/char_001.md'), char001, 'utf8');
    await writeFile(join(bookRoot, 'entities/char_002.md'), char002, 'utf8');
    await writeFile(join(bookRoot, 'entities/item_001.md'), item001, 'utf8');

    const voicePool = {
        samples: [
            {
                id: 'voice_01',
                tag: '对峙',
                text: '「废部通知书的纸质不错，拿来折纸飞机刚好。」',
                last_used_ch: 0,
                use_count: 0
            },
            {
                id: 'voice_02',
                tag: '日常',
                text: '窗外梧桐叶落进水沟，他把茶杯往桌角挪了两寸。',
                last_used_ch: 1,
                use_count: 1
            }
        ]
    };
    await writeFile(join(bookRoot, '.ops/voice_samples.yaml'), stringifyYaml(voicePool), 'utf8');

    const system = new NodeSystemAdapter();
    await system.initRepo(bookRoot);
    const store = new BookStore(bookRoot, system);
    await store.initializeWalFromDisk();
    await system.commitPaths(bookRoot, ['.'], 'chore: init engine test fixture');

    return { bookRoot, system, store };
}

function makeEngine(store: BookStore, llm: ScriptedLlmAdapter, system: NodeSystemAdapter): NarrativeEngine {
    return new NarrativeEngine({
        store,
        llm,
        system,
        retryOptions: {
            maxRetries: 2,
            backoffMs: [0, 0],
            sleepFn: async () => {}
        }
    });
}

const CLEAN_CHAPTER_PROSE = [
    '黄昏的斜阳穿过旧校舍走廊的高窗，把地砖切出一条长长的橘红色光带。',
    '陆沉把右手从裤袋里抽出来，指尖夹着那枚缺了一角齿痕的黄铜钥匙，金属表面还留着体温。',
    '星野琉璃站在活动室木门外两步远的地方，抬手扶了一下细框眼镜，目光落到门锁上。',
    '「经费报表还差最后三张票据。」她把文件夹递过来，纸页边缘响了一声，「明天放学前补齐，学生会可以暂缓封门。」',
    '陆沉接过文件夹，顺手把黄铜钥匙插进锁孔轻轻一拧，铜舌弹开的脆响在空荡的走廊里传出去很远。'
].join('\n\n');

const LIBRARIAN_OK = {
    selected_entity_ids: ['char_001', 'char_002', 'item_001'],
    recall_queries: [
        {
            entity_id: 'item_001',
            extra_keywords: ['黄铜钥匙'],
            focus_chapters: [1]
        }
    ],
    selected_lore_files: []
};

const PLANNER_OK = {
    chapter_title: '第二章 门锁与票据',
    target_word_count: 2200,
    focus_cast: ['char_001', 'char_002'],
    background_cast: ['item_001'],
    ending_beat: 'HOOK',
    director_rationale: '幕后内参：陆沉暗中藏着备用铁盒钥匙，但本章尚未到揭秘时机，表面仅让他用黄铜钥匙应付星野琉璃的查验。',
    chapter_turn: '星野琉璃突然将票据核验期限提前至明晚放学前，迫使陆沉必须在二十四小时内筹齐三张缺失票据。',
    scene_plan: [
        {
            scene_index: 1,
            location: '旧校舍三楼走廊',
            summary: '星野琉璃带来经费票据补交期限，陆沉用黄铜钥匙打开活动室门锁。',
            is_spotlight: true
        }
    ],
    outline_text: '场景一（旧校舍三楼走廊）：星野琉璃告知明晚放学前补齐三张票据可暂缓封门，陆沉用黄铜钥匙开启活动室门锁。',
    preferred_voice_tag: '对峙'
};

const EXTRACTOR_OK = {
    entity_patches: [
        {
            entity_id: 'char_001',
            last_seen_ch: 2,
            buffer_ops: [
                {
                    op: 'append',
                    entry: {
                        storyDay: 1,
                        chapter: 2,
                        text: '从星野琉璃手中接过经费票据清单并打开活动室门锁'
                    }
                }
            ]
        }
    ],
    story_day_delta: 0,
    chapter_summary: '星野琉璃通知陆沉在次日放学前补齐三张经费票据，陆沉持黄铜钥匙打开活动室门。',
    next_chapter_options: [
        '陆沉翻查社团旧账本追查缺失的三张票据去向',
        '星野琉璃在学生会档案室发现旧校舍封存批文的异常签字'
    ]
};

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('NarrativeEngine', () => {
    it('模型调用期间其他作品实例不能开始写入或恢复在途章节', async () => {
        const { bookRoot, store, system } = await createEngineFixture();
        const competitor = new BookStore(bookRoot, system);
        const assertExclusive = async (): Promise<void> => {
            await expect(competitor.beginDraft(2)).rejects.toThrow(TxLockConflictError);
            await expect(competitor.recoverWal()).rejects.toThrow(TxLockConflictError);
        };
        const llm = new ScriptedLlmAdapter([
            async () => { await assertExclusive(); return jsonResponse(LIBRARIAN_OK); },
            jsonResponse(PLANNER_OK),
            textResponse(CLEAN_CHAPTER_PROSE),
            jsonResponse({ passed: true, issues: [] }),
            async () => { await assertExclusive(); return jsonResponse(EXTRACTOR_OK); }
        ]);
        const result = await makeEngine(store, llm, system).stepChapter({ chapterGoal: '推进社团审查' });
        expect(result.status).toBe('COMMITTED');
        expect((await competitor.recoverWal()).action).toBe('READY');
    });

    it('应完整跑通单章 6 步闭环、隔离隐私/WARPED、过滤幻觉误报并落盘 WAL 与遥测', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        // Fact Checker 返回一个捏造引文误报，应被 verifyDualQuotes 自动过滤并判定通过
        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(`<blocking>草稿思路：注意门锁细节</blocking>\n\n${CLEAN_CHAPTER_PROSE}`),
            jsonResponse({
                passed: false,
                issues: [
                    {
                        severity: 'LOCAL_PATCH',
                        paragraph_index: 1,
                        description: '捏造的引文误报：声称主角使用了不存在的银色钥匙',
                        quote_draft: '他掏出一把崭新的银色钥匙插进锁孔',
                        quote_source: '陆沉早已把银色钥匙丢进河里'
                    }
                ]
            }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '推进活动室废部危机，交付经费票据清单。'
        });

        expect(result.status).toBe('COMMITTED');
        expect(result.chapterNumber).toBe(2);
        expect(result.replanCount).toBe(0);
        expect(result.rewriteCount).toBe(0);
        expect(result.patchRounds).toBe(0);
        expect(result.nextChapterOptions).toEqual(EXTRACTOR_OK.next_chapter_options);

        // 验证 Planner 请求注入了 voicePool 可用 tag 枚举
        const plannerCall = llm.history[1];
        expect(plannerCall?.request.dynamicTail).toContain('对峙');
        expect(plannerCall?.request.dynamicTail).toContain('日常');

        // 验证 Writer 请求严格剥离了 char_002 的 SELF_ONLY、char_001 的 OMNISCIENT_SECRET、WARPED 词条与 director_rationale
        const writerCall = llm.history[2];
        expect(writerCall).toBeDefined();
        expect(writerCall?.request.pool).toBe('strong_creative');
        expect(writerCall?.request.dynamicTail).not.toContain('随身携带机械秒表');
        expect(writerCall?.request.dynamicTail).not.toContain('秘密持有备用铁盒钥匙');
        expect(writerCall?.request.dynamicTail).not.toContain('WARPED');
        expect(writerCall?.request.dynamicTail).not.toContain('已遗失旧校舍钥匙的废止记忆');
        expect(writerCall?.request.dynamicTail).not.toContain(PLANNER_OK.director_rationale);
        expect(writerCall?.request.dynamicTail).toContain(PLANNER_OK.chapter_turn);
        expect(writerCall?.request.dynamicTail).toContain(PLANNER_OK.outline_text);
        // Planner 与 Writer 静态前缀哈希必须一致
        expect(plannerCall?.prefixHash).toBe(writerCall?.prefixHash);

        // 验证 .ops/next_chapter_options.json 已落盘
        const savedOptionsRaw = await readFile(join(bookRoot, '.ops/next_chapter_options.json'), 'utf8');
        expect(JSON.parse(savedOptionsRaw)).toEqual(EXTRACTOR_OK.next_chapter_options);

        // 验证 <blocking> 标签已被剥离，且正文已落盘
        const savedChapter = await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8');
        expect(savedChapter).not.toContain('<blocking>');
        expect(savedChapter).toContain('黄铜钥匙');

        // 验证声纹样本 LRU 已更新 (voice_01 last_used_ch -> 2)
        const updatedVoiceRaw = await readFile(join(bookRoot, '.ops/voice_samples.yaml'), 'utf8');
        const updatedVoice = parseYaml(updatedVoiceRaw) as { samples: Array<{ id: string; last_used_ch: number }> };
        expect(updatedVoice.samples.find((s) => s.id === 'voice_01')?.last_used_ch).toBe(2);

        // 验证遥测文件落盘
        const telemetryRaw = await readFile(join(bookRoot, '.ops/telemetry.jsonl'), 'utf8');
        const telemetryLines = telemetryRaw.trim().split('\n');
        expect(telemetryLines).toHaveLength(1);
        const parsedTelemetry = JSON.parse(telemetryLines[0] ?? '{}') as { chapter: number; replan_rate: number };
        expect(parsedTelemetry.chapter).toBe(2);
        expect(parsedTelemetry.replan_rate).toBe(0);

        // 验证 WAL 状态与工作区干净
        const txState = await store.readTxState();
        expect(txState.phase).toBe('STATE_COMMITTED');
        expect(txState.last_committed_ch).toBe(2);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('应支持从 FEAT_COMMITTED 中断相位直接恢复 Step 6 抽取与状态提交', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        await store.beginDraft(2);
        await store.commitDraft(2, CLEAN_CHAPTER_PROSE);
        expect((await store.readTxState()).phase).toBe('FEAT_COMMITTED');

        // 仅需 1 次 Extractor LLM 调用，跳过 Librarian / Planner / Writer / Gate / FactChecker
        const llm = new ScriptedLlmAdapter([jsonResponse(EXTRACTOR_OK)]);
        const engine = makeEngine(store, llm, system);

        const result = await engine.stepChapter({
            chapterGoal: '恢复中断的第 2 章提交'
        });

        expect(result.recoveredFromPhase).toBe('FEAT_COMMITTED');
        expect(result.chapterNumber).toBe(2);
        expect(llm.history).toHaveLength(1);
        expect((await store.readTxState()).phase).toBe('STATE_COMMITTED');
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('Static Prose Gate 检出 <=2 段违规时应触发局部 Patch 并仅传违规段上下窗口', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        // 第 3 段（index 2）含人体微距套话，触发 micro_anatomy 局部 PATCH
        const proseWithCliche = [
            '第一段：黄昏的光线落在走廊地板上。',
            '第二段：陆沉从裤袋掏出黄铜钥匙。',
            '第三段：他握紧门把手，指节泛白，喉结滚动了一下。',
            '第四段：星野琉璃把文件夹递了过来。',
            '第五段：门锁清脆地弹开。'
        ].join('\n\n');

        const patchedSegment = '第三段：走廊尽头飘来粉笔灰的气味，陆沉抬眼看了一下表盘。';

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(proseWithCliche),
            // 局部 Patch 调用
            textResponse(patchedSegment),
            // Fact Checker 通过
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '测试 Static Prose Gate 局部 Patch'
        });

        expect(result.patchRounds).toBe(1);
        expect(result.rewriteCount).toBe(0);

        // 验证 Patch 请求仅包含局部窗口，不包含远端第 1 段（上下文窗口半径 1 时不含第一段、第五段）
        const patchCall = llm.history[3];
        expect(patchCall?.request.dynamicTail).toContain('第三段');
        expect(patchCall?.request.dynamicTail).not.toContain('第一段：黄昏的光线落在走廊地板上');
        expect(patchCall?.request.dynamicTail).not.toContain('第五段：门锁清脆地弹开');

        const saved = await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8');
        expect(saved).toContain(patchedSegment);
        expect(saved).toContain('第一段：黄昏的光线落在走廊地板上。');
    });

    it('Fact Checker 检出 <=2 段局部穿帮时应局部 Patch 并回流 Static Prose Gate', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        const draftWithLocalFactError = [
            '第一段：黄昏的光线落在走廊地板上。',
            '第二段：陆沉用左手抓起冰冷的铁门把手，皮肤毫无异样。',
            '第三段：星野琉璃把文件夹递了过来。'
        ].join('\n\n');

        const patchedPara = '第二段：陆沉用右手推开活动室木门，左手一直插在风衣口袋里。';

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(draftWithLocalFactError),
            // Fact Checker 检出第 2 段（index 1）局部穿帮，且双侧引文真实存在
            jsonResponse({
                passed: false,
                issues: [
                    {
                        severity: 'LOCAL_PATCH',
                        paragraph_index: 1,
                        description: '陆沉左手腕对低温金属过敏，不应毫无异样地抓冰冷铁门把手',
                        quote_draft: '陆沉用左手抓起冰冷的铁门把手，皮肤毫无异样',
                        quote_source: '左手腕对低温金属过敏'
                    }
                ]
            }),
            // 局部 Patch 返回修正段
            textResponse(patchedPara),
            // 回流 Gate 通过后，第二次 Fact Checker 通过
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '测试 Fact Checker 局部 Patch 回流'
        });

        expect(result.patchRounds).toBe(1);
        expect(result.rewriteCount).toBe(0);
        expect(result.status).toBe('COMMITTED');
        const saved = await readFile(join(bookRoot, 'manuscripts/ch_0002.md'), 'utf8');
        expect(saved).toContain(patchedPara);
    });

    it('Fact Checker 检出多处崩坏时应触发整章 REWRITE 并回流 Gate', async () => {
        const { system, store } = await createEngineFixture();

        const badProse = [
            '陆沉左手戴着冰凉的铁手铐，完全没有过敏反应。',
            '他把三把黄铜钥匙同时扔进了垃圾桶。'
        ].join('\n\n');

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(badProse),
            // Fact Checker 判定 MULTI_REWRITE 且双侧引文真实存在
            jsonResponse({
                passed: false,
                issues: [
                    {
                        severity: 'MULTI_REWRITE',
                        description: '多处物理红线与唯一道具数量冲突',
                        quote_draft: '陆沉左手戴着冰凉的铁手铐，完全没有过敏反应',
                        quote_source: '左手腕对低温金属过敏'
                    }
                ]
            }),
            // 整章 REWRITE 输出干净正文
            textResponse(CLEAN_CHAPTER_PROSE),
            // 回流 Fact Checker 通过
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '测试 MULTI_REWRITE 整章重写'
        });

        expect(result.rewriteCount).toBe(1);
        expect(result.status).toBe('COMMITTED');
    });

    it('Fact Checker 检出细纲级物理悖论时应退回 Planner 改纲 v2 并重新执笔', async () => {
        const { system, store } = await createEngineFixture();

        const badOutline = {
            ...PLANNER_OK,
            outline_text: '让陆沉在活动室用不存在的备用银钥匙开锁。'
        };

        const conflictProse = [
            '陆沉摸出一把银色钥匙，试图打开活动室的门。',
            '星野琉璃在旁边看着他操作。'
        ].join('\n\n');

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(badOutline),
            textResponse(conflictProse),
            // Fact Checker 发现细纲级物理悖论
            jsonResponse({
                passed: false,
                issues: [
                    {
                        severity: 'PLAN_CONFLICT',
                        description: '细纲要求使用银色钥匙，但物理道具唯一为齿痕缺了一角的黄铜钥匙',
                        quote_draft: '陆沉摸出一把银色钥匙',
                        quote_source: '唯一物理实体：齿痕缺了一角的黄铜钥匙'
                    }
                ]
            }),
            // Planner 改纲 v2
            jsonResponse(PLANNER_OK),
            // Writer 按 v2 重新执笔
            textResponse(CLEAN_CHAPTER_PROSE),
            // Fact Checker v2 通过
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '测试 PlanConflict 改纲 v2'
        });

        expect(result.replanCount).toBe(1);
        expect(result.status).toBe('COMMITTED');
    });

    it('细纲 v2 仍失败时应写入 .ops/safe_halt.json 并抛出 SafeHaltError 且不污染主库', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        const conflictProse = '陆沉摸出一把银色钥匙，试图打开活动室的门。';
        const conflictCheck = jsonResponse({
            passed: false,
            issues: [
                {
                    severity: 'PLAN_CONFLICT',
                    description: '银色钥匙与唯一实体黄铜钥匙物理冲突',
                    quote_draft: '陆沉摸出一把银色钥匙',
                    quote_source: '唯一物理实体：齿痕缺了一角的黄铜钥匙'
                }
            ]
        });

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(conflictProse),
            conflictCheck,
            // v2 改纲后再次执笔仍失败
            jsonResponse(PLANNER_OK),
            textResponse(conflictProse),
            conflictCheck
        ]);

        const engine = makeEngine(store, llm, system);

        await expect(
            engine.stepChapter({
                chapterGoal: '测试 SAFE_HALT 挂起'
            })
        ).rejects.toThrow(SafeHaltError);

        // 诊断快照必须存在
        const haltRaw = await readFile(join(bookRoot, '.ops/safe_halt.json'), 'utf8');
        const haltSnapshot = JSON.parse(haltRaw) as SafeHaltSnapshot;
        expect(haltSnapshot.status).toBe('SAFE_HALT');
        expect(haltSnapshot.chapterNumber).toBe(2);
        expect(haltSnapshot.replanCount).toBe(1);

        // 不污染主库：ch_0002.md 不存在，txState 仍为上次状态
        await expect(access(join(bookRoot, 'manuscripts/ch_0002.md'))).rejects.toThrow();
        const txState = await store.readTxState();
        expect(txState.last_committed_ch).toBe(1);
    });

    it('syncManuscripts: 最新章纯修辞润色应零重抽并刷新 sha256', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        // 人工修改最新章 ch_0001.md（仅调整句末措辞，无实体变化）
        const ch1Path = join(bookRoot, 'manuscripts/ch_0001.md');
        const originalCh1 = await readFile(ch1Path, 'utf8');
        await writeFile(ch1Path, `${originalCh1}\n`, 'utf8');

        const llm = new ScriptedLlmAdapter([
            jsonResponse({
                is_prose_polish_only: true,
                reason: '仅调整了末尾空行与修辞标点，无剧情或实体状态变更',
                affected_entity_ids: []
            })
        ]);

        const engine = makeEngine(store, llm, system);
        const res = await engine.syncManuscripts();

        expect(res.status).toBe('PROSE_POLISH_SYNCED');
        expect(res.updatedEntities).toEqual([]);
        // 仅 1 次 LLM 调用（零重抽）
        expect(llm.history).toHaveLength(1);
        expect(await store.detectDirtyChapters()).toEqual([]);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('syncManuscripts: 最新章涉及实体变更时应增量调用 Extractor 并提交 state(sync)', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        const ch1Path = join(bookRoot, 'manuscripts/ch_0001.md');
        const originalCh1 = await readFile(ch1Path, 'utf8');
        await writeFile(ch1Path, `${originalCh1}\n陆沉把社团经费花掉了 200 日元买胶带。\n`, 'utf8');

        const llm = new ScriptedLlmAdapter([
            jsonResponse({
                is_prose_polish_only: false,
                reason: '社团剩余经费发生变动',
                affected_entity_ids: ['char_001']
            }),
            jsonResponse({
                entity_patches: [
                    {
                        entity_id: 'char_001',
                        acquired_state_ops: [
                            {
                                op: 'upsert_ledger',
                                entries: { '社团剩余经费': '1000日元' }
                            }
                        ]
                    }
                ],
                story_day_delta: 0,
                chapter_summary: '补记购买胶带消耗 200 日元'
            })
        ]);

        const engine = makeEngine(store, llm, system);
        const res = await engine.syncManuscripts();

        expect(res.status).toBe('STATE_SYNCED');
        expect(res.updatedEntities).toContain('char_001');
        expect(llm.history).toHaveLength(2);
        const char1Content = await readFile(join(bookRoot, 'entities/char_001.md'), 'utf8');
        expect(char1Content).toContain('1000日元');
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('syncManuscripts: 手改历史旧章应对下游执行只读冲突扫描且严禁改写下游手稿', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        // 先提交第 2 章
        const ch2Rel = 'manuscripts/ch_0002.md';
        const ch2Path = join(bookRoot, ch2Rel);
        const ch2Original = [
            '第一行：清晨的铃声刚刚响过。',
            '第二行：陆沉摸出右裤袋里的黄铜钥匙打开门锁。',
            '第三行：星野琉璃把票据放在桌上。'
        ].join('\n');
        await store.beginDraft(2);
        await store.commitDraft(2, ch2Original);
        await store.applyStatePatch(2, []);

        // 人工修改历史旧章 ch_0001.md（将钥匙设定改为丢弃）
        const ch1Path = join(bookRoot, 'manuscripts/ch_0001.md');
        const originalCh1 = await readFile(ch1Path, 'utf8');
        await writeFile(ch1Path, `${originalCh1}\n陆沉顺手把黄铜钥匙扔进了校门外的水沟。\n`, 'utf8');

        const llm = new ScriptedLlmAdapter([
            jsonResponse({
                conflicts: [
                    {
                        chapter_number: 2,
                        line_number: 2,
                        quote: '陆沉摸出右裤袋里的黄铜钥匙打开门锁',
                        description: '第 1 章已改为扔掉黄铜钥匙，第 2 章第 2 行仍从裤袋摸出该钥匙'
                    }
                ]
            })
        ]);

        const engine = makeEngine(store, llm, system);
        const res = await engine.syncManuscripts();

        expect(res.status).toBe('DOWNSTREAM_CONFLICTS_FOUND');
        expect(res.downstreamConflicts).toHaveLength(1);
        expect(res.downstreamConflicts[0]?.chapterNumber).toBe(2);
        expect(res.downstreamConflicts[0]?.lineNumber).toBe(2);

        // 严禁修改下游 ch_0002.md
        const ch2After = await readFile(ch2Path, 'utf8');
        expect(ch2After).toBe(ch2Original);
    });

    it('Extractor 首次新建实体缺省 canonical_name 时应触发结构化重试，并落盘标准中文名', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(CLEAN_CHAPTER_PROSE),
            jsonResponse({ passed: true, issues: [] }),
            // 第一次 Extractor 尝试新建 item_002 但未填 canonical_name -> 触发 Zod superRefine 拦截重试
            jsonResponse({
                entity_patches: [
                    {
                        entity_id: 'item_002',
                        last_seen_ch: 2,
                        acquired_state_ops: [
                            {
                                op: 'append',
                                entry: {
                                    storyDay: 1,
                                    chapter: 2,
                                    visibility: 'PUBLIC',
                                    text: '装有经费票据的塑料文件夹'
                                }
                            }
                        ]
                    }
                ],
                story_day_delta: 0,
                chapter_summary: '星野琉璃递交塑料文件夹'
            }),
            // 第二次重试补齐 canonical_name（同时在已有实体 char_001 上附带冗余 canonical_name 验证自动剥离）
            jsonResponse({
                entity_patches: [
                    {
                        entity_id: 'char_001',
                        canonical_name: '陆沉（冗余名字）',
                        last_seen_ch: 2
                    },
                    {
                        entity_id: 'item_002',
                        canonical_name: '经费票据文件夹',
                        last_seen_ch: 2,
                        acquired_state_ops: [
                            {
                                op: 'append',
                                entry: {
                                    storyDay: 1,
                                    chapter: 2,
                                    visibility: 'PUBLIC',
                                    text: '装有经费票据的塑料文件夹'
                                }
                            }
                        ]
                    }
                ],
                story_day_delta: 0,
                chapter_summary: '星野琉璃递交经费票据文件夹'
            })
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '测试新建实体 canonical_name 强约束'
        });

        expect(result.status).toBe('COMMITTED');
        expect(result.updatedEntities).toContain('item_002');
        const newEntityMd = await readFile(join(bookRoot, 'entities/item_002.md'), 'utf8');
        expect(newEntityMd).toContain('canonical_name: 经费票据文件夹');
        expect(newEntityMd).not.toContain('canonical_name: item_002');
    });

    it('stepChapter 应自动读取 .ops/signals.jsonl 中的 SPOTLIGHT_TRIGGER 与 RETCON 并注入 Planner', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        const signalsContent = [
            JSON.stringify({
                type: 'SPOTLIGHT_TRIGGER',
                created_at: new Date().toISOString(),
                chapter: 1,
                entity_id: 'char_002',
                suggested_mode: 'MAINLINE',
                reason: '星野琉璃携带废部终审表抵达旧校舍三楼'
            }),
            JSON.stringify({
                type: 'RETCON',
                created_at: new Date().toISOString(),
                chapter: 1,
                conflict_id: 'conf_weather',
                reason: '顺带说明走廊窗户刚被关上'
            })
        ].join('\n');
        await writeFile(join(bookRoot, '.ops/signals.jsonl'), `${signalsContent}\n`, 'utf8');
        await system.commitPaths(bookRoot, ['.ops/signals.jsonl'], 'chore: seed signals.jsonl');

        // Librarian 故意不返回 char_002，验证 SPOTLIGHT_TRIGGER 会将 char_002 自动并入挂载列表
        const librarianWithoutChar2 = {
            selected_entity_ids: ['char_001'],
            recall_queries: [],
            selected_lore_files: []
        };

        const llm = new ScriptedLlmAdapter([
            jsonResponse(librarianWithoutChar2),
            jsonResponse(PLANNER_OK),
            textResponse(CLEAN_CHAPTER_PROSE),
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '推进活动室门前交涉'
        });

        expect(result.status).toBe('COMMITTED');
        const plannerCall = llm.history[1];
        expect(plannerCall?.request.dynamicTail).toContain('SPOTLIGHT_TRIGGER');
        expect(plannerCall?.request.dynamicTail).toContain('星野琉璃携带废部终审表抵达旧校舍三楼');
        expect(plannerCall?.request.dynamicTail).toContain('RETCON 圆回指令');
        // 验证 char_002 的档案也被自动挂载进了 Planner 视图
        expect(plannerCall?.request.dynamicTail).toContain('星野琉璃');
    });

    it('stepChapter 应将 world/static_base_and_voice.md 与 world/current_arc_envelope.md 注入静态前缀并兼容 world/voice_samples.yaml 与 world/ops_style_amendments.md 回退', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        // 模拟 bootBook 产物：写入 static_base_and_voice.md、current_arc_envelope.md、world/voice_samples.yaml（仅含 tag/sample）与 world/ops_style_amendments.md
        await rm(join(bookRoot, '.ops/voice_samples.yaml'), { force: true });
        await writeFile(
            join(bookRoot, 'world/static_base_and_voice.md'),
            '# 世界底层法则与抽象句法纪律\n\n冷峻白描第三人称限知视角，使用具象感官动词。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/current_arc_envelope.md'),
            '# 当前卷纲要与阶段锁\n\n第一卷：旧校舍废部危机，围绕三张经费票据展开交锋。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/voice_samples.yaml'),
            stringifyYaml({
                samples: [
                    {
                        tag: '对峙',
                        sample: '「废部通知书的纸质不错，拿来折纸飞机刚好。」'
                    }
                ]
            }),
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/ops_style_amendments.md'),
            '# 卷中风格修订 (Ops Style Amendments)\n\n- 对话控制在两行以内，优先写手部动作。\n',
            'utf8'
        );
        await system.commitPaths(bookRoot, ['.'], 'chore: seed boot-style world files');

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(CLEAN_CHAPTER_PROSE),
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '验证静态前缀挂载与声纹池回退兼容'
        });

        expect(result.status).toBe('COMMITTED');

        const plannerCall = llm.history[1];
        const writerCall = llm.history[2];
        expect(plannerCall).toBeDefined();
        expect(writerCall).toBeDefined();

        // Planner 与 Writer 静态前缀均包含 static_base_and_voice.md 与 current_arc_envelope.md 内容，且 prefixHash 100% 一致
        const plannerStaticJoined = plannerCall?.request.staticPrefixBlocks.join('\n\n') ?? '';
        const writerStaticJoined = writerCall?.request.staticPrefixBlocks.join('\n\n') ?? '';
        expect(plannerStaticJoined).toContain('冷峻白描第三人称限知视角，使用具象感官动词。');
        expect(plannerStaticJoined).toContain('第一卷：旧校舍废部危机，围绕三张经费票据展开交锋。');
        expect(writerStaticJoined).toBe(plannerStaticJoined);
        expect(plannerCall?.prefixHash).toBe(writerCall?.prefixHash);

        // 验证 world/ops_style_amendments.md 回退生效，且声纹标本注入了 Writer 动态尾部
        expect(plannerCall?.request.dynamicTail).toContain('对话控制在两行以内，优先写手部动作。');
        expect(writerCall?.request.dynamicTail).toContain('对话控制在两行以内，优先写手部动作。');
        expect(writerCall?.request.dynamicTail).toContain('废部通知书的纸质不错，拿来折纸飞机刚好。');

        // 验证归一化后的声纹池已更新 LRU 并持久化至 .ops/voice_samples.yaml
        const updatedVoiceRaw = await readFile(join(bookRoot, '.ops/voice_samples.yaml'), 'utf8');
        const updatedVoice = parseYaml(updatedVoiceRaw) as {
            samples: Array<{ id: string; tag: string; text: string; last_used_ch: number; use_count: number }>;
        };
        expect(updatedVoice.samples).toEqual([
            {
                id: 'voice_01',
                tag: '对峙',
                text: '「废部通知书的纸质不错，拿来折纸飞机刚好。」',
                last_used_ch: 2,
                use_count: 1
            }
        ]);
    });

    it('stepChapter 应挂载 selected_lore_files 至 Planner/Writer、注入 open_threads.md 与实体别名，并将 chapter_summary 写入 L2 卷级章卡', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        await mkdir(join(bookRoot, 'lore_library'), { recursive: true });
        await writeFile(
            join(bookRoot, 'lore_library/lore_001.md'),
            '# 旧校舍管理规约\n\n> 摘要: 社团经费与门禁制度\n\n旧校舍三楼社团每学期须提交三张正规经费票据，逾期由学生会收回黄铜钥匙。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/open_threads.md'),
            '# 跨卷伏笔台账 (Open Threads)\n\n- [thread_001] 铁盒备用钥匙的真正来源 | 唤醒条件: 学生会终审前揭晓\n',
            'utf8'
        );
        await system.commitPaths(bookRoot, ['.'], 'chore: seed lore_001 and open_threads');

        const librarianWithLore = {
            ...LIBRARIAN_OK,
            selected_lore_files: ['lore_001', 'lore_001.md', '../world/book_config.yaml']
        };

        const llm = new ScriptedLlmAdapter([
            jsonResponse(librarianWithLore),
            jsonResponse(PLANNER_OK),
            textResponse(CLEAN_CHAPTER_PROSE),
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '核查外围设定挂载、未解伏笔注入与 L2 章卡落盘'
        });

        expect(result.status).toBe('COMMITTED');

        // 1. 验证 Librarian 请求包含实体唯一别名与职务称谓以及全局局势摘要
        const librarianCall = llm.history[0];
        expect(librarianCall?.request.dynamicTail).toContain('- char_001: 陆沉 (别名: 小沉 | 称谓: 社长)');
        expect(librarianCall?.request.dynamicTail).toContain('- char_002: 星野琉璃 (别名: 琉璃 | 称谓: 学生会书记)');

        // 2. 验证 Planner 与 Writer 的 dynamicTail 均包含 lore_001.md 内容（且去重、拦截非法路径），Planner 包含 open_threads.md
        const plannerCall = llm.history[1];
        const writerCall = llm.history[2];
        expect(plannerCall?.request.dynamicTail).toContain('旧校舍三楼社团每学期须提交三张正规经费票据');
        expect(writerCall?.request.dynamicTail).toContain('旧校舍三楼社团每学期须提交三张正规经费票据');
        expect(plannerCall?.request.dynamicTail).not.toContain('tokens_per_char');
        expect(plannerCall?.request.dynamicTail).toContain('铁盒备用钥匙的真正来源');

        // 3. 验证 Extractor 提示词模板包含 world_summary_markdown 字段说明
        const extractorCall = llm.history[4];
        expect(extractorCall?.request.staticPrefixBlocks.join('\n')).toContain('world_summary_markdown');

        // 4. 验证 index/L2_cards/vol_01_cards.md 已写入 ## ch_0002 与 chapter_summary，且工作区保持 clean
        const l2CardRaw = await readFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), 'utf8');
        expect(l2CardRaw).toContain('## ch_0002 (day:1)');
        expect(l2CardRaw).toContain(`- 主干剧情：${EXTRACTOR_OK.chapter_summary}`);
        expect(await system.isWorkingTreeClean(bookRoot)).toBe(true);
    });

    it('违反 current_arc_envelope.md Stage Ceiling 时应触发 PLAN_CONFLICT 重规划', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        await writeFile(
            join(bookRoot, 'world/current_arc_envelope.md'),
            [
                '# 第一卷包络 (Current Arc Envelope)',
                '',
                '## Stage Ceiling (本卷阶段天花板禁区)',
                '- 本卷严禁提前揭穿「校长室地下室的旧钟楼密道」真相'
            ].join('\n'),
            'utf8'
        );
        await system.commitPaths(bookRoot, ['.'], 'chore: add Stage Ceiling in arc envelope');

        const ceilingBreachOutline = {
            ...PLANNER_OK,
            outline_text: '陆沉在活动室直接推开墙柜，提前揭穿校长室地下室的旧钟楼密道真相。'
        };
        const ceilingBreachProse = [
            '陆沉推开墙柜，当场指认了校长室地下室的旧钟楼密道。',
            '星野琉璃沉默地看着他。'
        ].join('\n\n');

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(ceilingBreachOutline),
            textResponse(ceilingBreachProse),
            jsonResponse({
                passed: false,
                issues: [
                    {
                        severity: 'PLAN_CONFLICT',
                        description: '正文与细纲提前揭穿了 Stage Ceiling 禁区：校长室地下室的旧钟楼密道',
                        quote_draft: '陆沉推开墙柜，当场指认了校长室地下室的旧钟楼密道',
                        quote_source: '本卷严禁提前揭穿「校长室地下室的旧钟楼密道」真相'
                    }
                ]
            }),
            jsonResponse(PLANNER_OK),
            textResponse(CLEAN_CHAPTER_PROSE),
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse(EXTRACTOR_OK)
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '测试 Stage Ceiling 守卫触发 PLAN_CONFLICT'
        });

        expect(result.status).toBe('COMMITTED');
        expect(result.replanCount).toBe(1);

        const factCheckerCall = llm.history[3];
        expect(factCheckerCall?.request.staticPrefixBlocks.join('\n')).toContain('Stage Ceiling');
        expect(factCheckerCall?.request.dynamicTail).toContain('本卷严禁提前揭穿「校长室地下室的旧钟楼密道」真相');
    });

    it('PARALLEL 模式下主线 story_day 保持不变，且能从 L2 章卡提取前章摘要并向 Librarian 附入前章末尾 600 字', async () => {
        const { bookRoot, system, store } = await createEngineFixture();

        // 预置 ch_0001 正文与 L2 章卡摘要，并调低 writer_token_budget 以触发前章摘要+尾窗渲染
        const ch1Tail = '上一章末尾关键动作：星野琉璃把一枚刻着编号 07 的铜铃放在窗台。';
        const ch1Prose = `${'雨滴敲打着旧校舍的玻璃窗。'.repeat(80)}\n\n${ch1Tail}`;
        await mkdir(join(bookRoot, 'manuscripts'), { recursive: true });
        await writeFile(join(bookRoot, 'manuscripts/ch_0001.md'), ch1Prose, 'utf8');
        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            '# 第 1 卷双轨章卡\n\n## ch_0001 (day:1)\n- 主干剧情：星野琉璃留下编号 07 的铜铃并约定次日再会。\n',
            'utf8'
        );
        const cfgRaw = await readFile(join(bookRoot, 'world/book_config.yaml'), 'utf8');
        const cfgObj = parseYaml(cfgRaw) as Record<string, unknown>;
        cfgObj['writer_token_budget'] = 1200;
        await writeFile(join(bookRoot, 'world/book_config.yaml'), stringifyYaml(cfgObj), 'utf8');
        await system.commitPaths(bookRoot, ['.'], 'chore: seed ch_0001 and vol_01_cards');

        const beforeSnapshot = await store.loadSnapshot();
        const beforeStoryDay = beforeSnapshot.worldState.frontmatter.story_day;

        const llm = new ScriptedLlmAdapter([
            jsonResponse(LIBRARIAN_OK),
            jsonResponse(PLANNER_OK),
            textResponse(CLEAN_CHAPTER_PROSE),
            jsonResponse({ passed: true, issues: [] }),
            jsonResponse({
                ...EXTRACTOR_OK,
                story_day_delta: 3
            })
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.stepChapter({
            chapterGoal: '并行视角推进支线',
            timelineMode: 'PARALLEL'
        });

        expect(result.status).toBe('COMMITTED');

        // 1. PARALLEL 模式下主线 story_day 不累加
        const afterSnapshot = await store.loadSnapshot();
        expect(afterSnapshot.worldState.frontmatter.story_day).toBe(beforeStoryDay);

        // 2. Librarian 收到上一章末尾 600 字切片
        const librarianCall = llm.history[0];
        expect(librarianCall?.request.dynamicTail).toContain(ch1Tail);

        // 3. Writer 在预算触发窗口模式时收到从 L2 章卡提取的前章摘要
        const writerCall = llm.history[2];
        expect(writerCall?.request.dynamicTail).toContain('星野琉璃留下编号 07 的铜铃并约定次日再会。');
    });

    it('advanceVolume 应执行五步原子换卷：打封存 tag、冷宫归档非随行角色、合并风格修订、编译新卷包络并递增卷号', async () => {
        const { bookRoot, system, store } = await createEngineFixture();
        const execFileAsync = promisify(execFile);

        // 准备第三名随行角色 char_003 与道具 item_001
        const char003 = [
            '---',
            'entity_id: char_003',
            'canonical_name: 顾南山',
            'unique_aliases: []',
            'contextual_titles: ["档案员"]',
            'historical_anchors: []',
            'last_seen_ch: 1',
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: PUBLIC] 随身携带黄铜袖珍放大镜',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
            '- [day:1 | ch:01 | vis: PUBLIC] 已与陆沉达成临时同行约定',
            '',
            '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
            '- [day:1 | ch:01] 交出旧档案室铜钥',
            '',
            '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)',
            '- [day:1 | ch:01] 站在钟楼门口等候出发',
            ''
        ].join('\n');
        await writeFile(join(bookRoot, 'entities/char_003.md'), char003, 'utf8');

        const item001 = [
            '---',
            'entity_id: item_001',
            'canonical_name: 断齿铜钥',
            'unique_aliases: []',
            'contextual_titles: []',
            'historical_anchors: []',
            'last_seen_ch: 1',
            '---',
            '',
            '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
            '- [vis: PUBLIC] 齿距缺损半度的旧铜钥匙',
            '',
            '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
            '- [day:1 | ch:01 | vis: PUBLIC] 由陆沉贴身保管',
            ''
        ].join('\n');
        await writeFile(join(bookRoot, 'entities/item_001.md'), item001, 'utf8');

        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });
        await writeFile(join(bookRoot, 'index/L0_sagas.md'), '# L0 纪元折叠总表\n\n第一纪元：雾港钟楼谜案。\n', 'utf8');
        await writeFile(join(bookRoot, 'index/L1_volumes.md'), '# L1 活跃卷级总表\n\n- vol_01: 旧校舍试炼\n- vol_02: 雾港地下档案室\n', 'utf8');
        await writeFile(
            join(bookRoot, 'index/L2_cards/vol_01_cards.md'),
            '# 第 1 卷双轨章卡\n\n## ch_0001 (day:1)\n- 主干剧情：陆沉与顾南山取得断齿铜钥。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/static_base_and_voice.md'),
            '# 世界底层法则与抽象句法纪律\n\n保持冷静克制的白描句法。',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/ops_style_amendments.md'),
            '# 卷中风格修订 (Ops Style Amendments)\n\n- 对话尽量短促，少用冗余感叹词。\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/open_threads.md'),
            '# 跨卷伏笔账本\n\n## 活跃未解伏笔 (Active Threads)\n- [thread: t_001 | status: ACTIVE] 断齿铜钥背后的地下排水闸图纸\n',
            'utf8'
        );
        await writeFile(
            join(bookRoot, 'world/future_horizon.md'),
            '# 未来事件惯性表\n\n- [day:5 | status: PENDING] 朔望大潮逼近旧港\n',
            'utf8'
        );
        await system.commitPaths(bookRoot, ['.'], 'chore: seed volume 1 files before advanceVolume');

        const longMergedVoice = `# 世界底层法则与抽象句法纪律\n\n${'保持冷静克制白描与短促对话。'.repeat(160)}`;
        const llm = new ScriptedLlmAdapter([
            // Step 1: 封存旧卷摘要
            jsonResponse({
                volume_summary: '第一卷收束：陆沉拿到断齿铜钥，与顾南山启程前往雾港地下档案室。',
                story_day_span: 'day:1 - day:3'
            }),
            // Step 3: 合并风格修订（故意返回超长文本以验证 1500 字强截断）
            jsonResponse({
                merged_markdown: longMergedVoice
            }),
            // Step 4: 编译第 2 卷 current_arc_envelope & future_horizon
            jsonResponse({
                current_arc_envelope:
                    '# 第 2 卷纲要与阶段锁\n\n## 本卷主线冲突\n雾港地下档案室的水闸真相争夺。\n\n## 跨图锚点\n从旧校舍转移至雾港码头地下区。\n\n## Stage Ceiling\n第二卷严禁提前揭晓总督府底层密约的真正签署人。',
                future_horizon:
                    '# 未来事件惯性表\n\n- [day:8 | status: PENDING] 档案室潮汐闸门每夜子时自动落锁\n'
            })
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.advanceVolume({
            companionEntityIds: ['char_003']
        });

        expect(result.sealedVolume).toBe(1);
        expect(result.nextVolume).toBe(2);
        expect(result.tagName).toBe('arc-seal-vol-01');
        expect(result.completedBook).toBe(false);
        expect(result.archivedEntities).toEqual(['char_002']);
        expect(result.commitSha.length).toBeGreaterThan(6);

        // 断言 Git tag 已创建
        const { stdout: tagsOut } = await execFileAsync('git', ['-C', bookRoot, 'tag', '-l']);
        expect(tagsOut.split(/\r?\n/)).toContain('arc-seal-vol-01');

        // 断言非随行角色 char_002 移入 cold_archive，主角、随行与道具保留在 entities/
        await expect(access(join(bookRoot, 'entities/cold_archive/char_002.md'))).resolves.toBeUndefined();
        await expect(access(join(bookRoot, 'entities/char_002.md'))).rejects.toThrow();
        await expect(access(join(bookRoot, 'entities/char_001.md'))).resolves.toBeUndefined();
        await expect(access(join(bookRoot, 'entities/char_003.md'))).resolves.toBeUndefined();
        await expect(access(join(bookRoot, 'entities/item_001.md'))).resolves.toBeUndefined();

        // 断言新建 vol_02_cards.md
        const vol02Cards = await readFile(join(bookRoot, 'index/L2_cards/vol_02_cards.md'), 'utf8');
        expect(vol02Cards).toContain('第 2 卷');

        // 断言 L1_volumes.md 收束摘要更新
        const l1Text = await readFile(join(bookRoot, 'index/L1_volumes.md'), 'utf8');
        expect(l1Text).toContain('day:1 - day:3');
        expect(l1Text).toContain('第一卷收束：陆沉拿到断齿铜钥');

        // 断言 static_base_and_voice.md 截断 <= 1500 字且修订表已清空
        const voiceText = await readFile(join(bookRoot, 'world/static_base_and_voice.md'), 'utf8');
        expect(voiceText.length).toBeLessThanOrEqual(1500);
        const amendmentsText = await readFile(join(bookRoot, 'world/ops_style_amendments.md'), 'utf8');
        expect(amendmentsText).not.toContain('对话尽量短促');

        // 断言 current_arc_envelope.md 与 future_horizon.md 更新
        const envelopeText = await readFile(join(bookRoot, 'world/current_arc_envelope.md'), 'utf8');
        expect(envelopeText).toContain('雾港地下档案室的水闸真相争夺');
        expect(envelopeText).toContain('Stage Ceiling');
        const horizonText = await readFile(join(bookRoot, 'world/future_horizon.md'), 'utf8');
        expect(horizonText).toContain('档案室潮汐闸门每夜子时自动落锁');

        // 断言 world_state.md current_volume 推进为 2
        const afterState = await store.readWorldState();
        expect(afterState.frontmatter.current_volume).toBe(2);
    });

    it('advanceVolume({ completeBook: true }) 应将活跃伏笔标为 OPEN_ENDING 并打 novel-completed 标签', async () => {
        const { bookRoot, system, store } = await createEngineFixture();
        const execFileAsync = promisify(execFile);

        await mkdir(join(bookRoot, 'index/L2_cards'), { recursive: true });
        await writeFile(join(bookRoot, 'index/L1_volumes.md'), '# L1 活跃卷级总表\n\n- vol_01: 终局卷\n', 'utf8');
        await writeFile(join(bookRoot, 'index/L2_cards/vol_01_cards.md'), '# 第 1 卷双轨章卡\n', 'utf8');
        await writeFile(
            join(bookRoot, 'world/open_threads.md'),
            [
                '# 跨卷伏笔账本',
                '',
                '## 活跃未解伏笔 (Active Threads)',
                '- [thread: t_001 | status: ACTIVE] 钟楼暗格里的无名怀表',
                '',
                '## 已回收伏笔归档 (Resolved Archive)',
                '- [thread: t_000 | status: RESOLVED] 旧校舍废部危机'
            ].join('\n'),
            'utf8'
        );
        await system.commitPaths(bookRoot, ['.'], 'chore: seed complete book fixture');

        const llm = new ScriptedLlmAdapter([
            jsonResponse({
                volume_summary: '全书终局收束：钟楼停摆后雾港恢复平静。',
                story_day_span: 'day:1 - day:10'
            })
        ]);

        const engine = makeEngine(store, llm, system);
        const result = await engine.advanceVolume({ completeBook: true });

        expect(result.completedBook).toBe(true);
        expect(result.tagName).toBe('arc-seal-vol-01');
        expect(result.sealedVolume).toBe(1);
        expect(result.nextVolume).toBe(1);

        const { stdout: tagsOut } = await execFileAsync('git', ['-C', bookRoot, 'tag', '-l']);
        const tags = tagsOut.split(/\r?\n/);
        expect(tags).toContain('arc-seal-vol-01');
        expect(tags).toContain('novel-completed');

        const threadsText = await readFile(join(bookRoot, 'world/open_threads.md'), 'utf8');
        expect(threadsText).toContain('[thread: t_001 | status: OPEN_ENDING]');
        expect(threadsText).toContain('[thread: t_000 | status: RESOLVED]');
        await expect(access(join(bookRoot, 'index/L2_cards/vol_02_cards.md'))).rejects.toThrow();

        const afterState = await store.readWorldState();
        expect(afterState.frontmatter.current_volume).toBe(1);
    });
});

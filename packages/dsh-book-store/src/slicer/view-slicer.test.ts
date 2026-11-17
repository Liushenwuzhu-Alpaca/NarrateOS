import { describe, expect, it } from 'vitest';
import type { BookSnapshot, EntityProfile } from '../store/schemas.js';
import { ViewSlicer, sliceWorldDocuments } from './index.js';

function createTestSnapshot(): BookSnapshot {
    const hero: EntityProfile = {
        metadata: {
            entity_id: 'char_001',
            canonical_name: '林雾',
            unique_aliases: ['阿雾'],
            contextual_titles: ['值夜生'],
            historical_anchors: [],
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
                text: '左眉骨有一道陈年旧疤。遇冷会隐隐发红。',
                continuationLines: []
            },
            {
                visibility: 'SELF_ONLY',
                text: '童年曾被锁在地下室，对铁锈味极度敏感',
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
                visibility: 'SELF_ONLY',
                text: '私下怀疑副会长隐瞒了钥匙去向',
                continuationLines: []
            },
            {
                storyDay: 15,
                chapter: 50,
                visibility: 'PUBLIC',
                text: '未来状态：尚未发生的第15天事件',
                continuationLines: []
            },
            {
                storyDay: 11,
                chapter: 42,
                visibility: 'PUBLIC',
                status: 'WARPED',
                text: '废止线：原计划在食堂当众翻脸',
                continuationLines: []
            }
        ],
        irreversibleTrajectory: [
            {
                storyDay: -365,
                chapter: 5,
                text: '在暴雨夜捡到半枚铜徽章',
                continuationLines: []
            },
            {
                storyDay: 12,
                chapter: 44,
                text: '当众撕毁了值班登记表',
                continuationLines: []
            },
            {
                storyDay: 18,
                chapter: 55,
                text: '未来履历：尚未发生的第18天变迁',
                continuationLines: []
            }
        ],
        recentBuffer: [
            {
                storyDay: 12,
                chapter: 44,
                text: '指节因攥紧栏杆而发白',
                continuationLines: []
            },
            {
                text: '对话声纹：短句冷淡，少用感叹号',
                continuationLines: ['  > 标本：「门没锁，是你自己不敢推。」']
            }
        ]
    };

    const heroine: EntityProfile = {
        metadata: {
            entity_id: 'char_002',
            canonical_name: '神代雪乃',
            unique_aliases: ['雪乃'],
            contextual_titles: ['副会长'],
            historical_anchors: [],
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
                visibility: 'SELF_ONLY',
                text: '极度怕黑，无光源密闭环境下无法独自行动',
                continuationLines: []
            },
            {
                visibility: 'PUBLIC',
                text: '右手腕内侧有旧烫伤浅疤。说话时习惯扶正袖扣。',
                continuationLines: []
            }
        ],
        acquiredState: [
            {
                storyDay: 12,
                chapter: 44,
                visibility: 'PUBLIC',
                text: '持有物：item_001（黄铜钥匙）',
                continuationLines: []
            },
            {
                storyDay: 5,
                chapter: 16,
                visibility: 'SELF_ONLY',
                text: '主观认知偏差：误信《月光》旧琴谱已烧毁',
                continuationLines: []
            },
            {
                storyDay: -1095,
                chapter: 1,
                visibility: 'OMNISCIENT_SECRET',
                text: '隐藏底牌：三年前亲手锁死四楼音乐室真相',
                continuationLines: []
            },
            {
                storyDay: 11,
                chapter: 41,
                visibility: 'READER_KNOWN',
                text: '读者已见其将备用钥匙藏入钢琴琴凳夹层',
                continuationLines: []
            }
        ],
        irreversibleTrajectory: [
            {
                storyDay: -1095,
                chapter: 21,
                text: '曾在四楼音乐室门框悬挂风铃',
                continuationLines: []
            },
            {
                storyDay: 0,
                chapter: 1,
                text: '签发废部通知',
                continuationLines: []
            }
        ],
        recentBuffer: [
            {
                storyDay: 10,
                chapter: 10,
                text: '转身离开音乐室时袖口沾了粉笔灰',
                continuationLines: []
            }
        ]
    };

    const warpedEntity: EntityProfile = {
        metadata: {
            entity_id: 'char_999',
            canonical_name: '已废止旧反派',
            unique_aliases: [],
            contextual_titles: [],
            historical_anchors: [],
            last_seen_ch: 3,
            status: 'WARPED'
        },
        sectionHeadings: {
            innateLocks: '## 1. Innate Locks',
            acquiredState: '## 2. Acquired State & Numeric Ledger',
            irreversibleTrajectory: '## 3. Irreversible Trajectory',
            recentBuffer: '## 4. Recent Sliding Buffer & Voice'
        },
        innateLocks: [{ visibility: 'PUBLIC', text: '旧设定红线', continuationLines: [] }],
        acquiredState: [],
        irreversibleTrajectory: [],
        recentBuffer: []
    };

    return {
        config: {
            book_slug: 'test-book',
            title: '测试长篇',
            tokens_per_char: 0.6,
            narration_subjectivity: 'objective_third',
            writer_token_budget: null,
            max_auto_rollback_chapters: 3,
            structured_json_retry: { max_retries: 5, backoff_ms: [1000] },
            craft_plugins: [],
            prose_gate: {
                enable_anti_cliche: true,
                enable_cross_chapter_simile: true,
                cross_chapter_simile_window: 5
            }
        },
        worldState: {
            frontmatter: {
                story_day: 12,
                current_volume: 1,
                current_chapter: 45,
                pov_character: 'char_001',
                timeline_mode: 'MAINLINE'
            },
            summaryMarkdown: '当前局势摘要'
        },
        txState: {
            phase: 'IDLE',
            active_chapter: null,
            last_committed_ch: 44,
            chapter_hashes: {},
            updated_at: '2026-11-16T00:00:00Z'
        },
        entities: {
            char_001: hero,
            char_002: heroine,
            char_999: warpedEntity
        },
        coldArchiveIds: [],
        chapterFiles: []
    };
}

describe('ViewSlicer', () => {
    it('MAINLINE 模式下按 story_day <= targetDay 过滤未来条目，并保留无日期的先天红线', () => {
        const snapshot = createTestSnapshot();
        const slicer = new ViewSlicer();

        const result = slicer.slice({
            snapshot,
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001',
            forRole: 'writer'
        });

        const hero = result.entities['char_001'];
        expect(hero).toBeDefined();
        expect(hero?.innateLocks).toHaveLength(2);
        expect(hero?.acquiredState.map((e) => e.text)).toEqual([
            '驻留节点：旧校舍天台',
            '私下怀疑副会长隐瞒了钥匙去向'
        ]);
        expect(hero?.irreversibleTrajectory.map((e) => e.text)).toEqual([
            '在暴雨夜捡到半枚铜徽章',
            '当众撕毁了值班登记表'
        ]);
    });

    it('FLASHBACK 模式下保留 Innate Locks，物理屏蔽 Acquired State 与 Recent Buffer，仅保留 day < targetDay 的历史履历', () => {
        const snapshot = createTestSnapshot();
        const slicer = new ViewSlicer();

        const result = slicer.slice({
            snapshot,
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'FLASHBACK',
            povCharId: 'char_001',
            forRole: 'writer'
        });

        const hero = result.entities['char_001'];
        expect(hero).toBeDefined();
        expect(hero?.innateLocks).toHaveLength(2);
        expect(hero?.acquiredState).toEqual([]);
        expect(hero?.recentBuffer).toEqual([]);
        expect(hero?.irreversibleTrajectory.map((e) => e.text)).toEqual([
            '在暴雨夜捡到半枚铜徽章'
        ]);
    });

    it('PARALLEL 模式下过滤未来条目并挂载全局只读广播（同样受 story_day 与 WARPED 约束）', () => {
        const snapshot = createTestSnapshot();
        const slicer = new ViewSlicer();

        const result = slicer.slice({
            snapshot,
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'PARALLEL',
            povCharId: 'char_001',
            forRole: 'writer',
            parallelBroadcastEntries: [
                {
                    storyDay: 12,
                    visibility: 'PUBLIC',
                    text: '广播：暴雨导致旧校舍停电',
                    continuationLines: []
                },
                {
                    storyDay: 14,
                    visibility: 'PUBLIC',
                    text: '未来广播：尚未发生的第14天停水',
                    continuationLines: []
                },
                {
                    storyDay: 12,
                    visibility: 'PUBLIC',
                    status: 'WARPED',
                    text: '废止广播：不应出现在写手视图',
                    continuationLines: []
                }
            ]
        });

        expect(result.parallelBroadcast).toHaveLength(1);
        expect(result.parallelBroadcast[0]?.text).toBe('广播：暴雨导致旧校舍停电');
        expect(result.parallelBroadcast[0]?.readonly).toBe(true);
    });

    it('writer 视角严格执行 POV 物理剥离：剔除他人 SELF_ONLY 与全员 OMNISCIENT_SECRET，并将他人 READER_KNOWN 转化为桌下炸弹提示', () => {
        const snapshot = createTestSnapshot();
        const slicer = new ViewSlicer();

        const result = slicer.sliceForWriter(snapshot, {
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });

        const heroine = result.entities['char_002'];
        expect(heroine).toBeDefined();
        expect(heroine?.innateLocks.map((e) => e.text)).toEqual([
            '右手腕内侧有旧烫伤浅疤。说话时习惯扶正袖扣。'
        ]);
        expect(heroine?.acquiredState.map((e) => e.text)).toEqual([
            '持有物：item_001（黄铜钥匙）'
        ]);

        // 桌下炸弹戏剧反讽提示
        expect(result.dramaticIronyHints).toHaveLength(1);
        expect(result.dramaticIronyHints[0]?.entityId).toBe('char_002');
        expect(result.dramaticIronyHints[0]?.text).toBe('读者已见其将备用钥匙藏入钢琴琴凳夹层');
        expect(result.dramaticIronyHints[0]?.formattedHint).toContain('读者已知');
        expect(result.dramaticIronyHints[0]?.formattedHint).toContain('当前视角角色不知');
    });

    it('支持多 POV 视角色组与显式 owner 归属判定', () => {
        const snapshot = createTestSnapshot();
        // 在 char_002 档案中挂一条 owner 为 char_001 的 SELF_ONLY 条目
        snapshot.entities['char_002']?.acquiredState.push({
            storyDay: 12,
            chapter: 44,
            visibility: 'SELF_ONLY',
            owner: 'char_001',
            text: '林雾暗中记下的雪乃微表情',
            continuationLines: []
        });

        const slicer = new ViewSlicer();
        const result = slicer.slice({
            snapshot,
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: ['char_001'],
            forRole: 'writer'
        });

        const heroineTexts = result.entities['char_002']?.acquiredState.map((e) => e.text) ?? [];
        expect(heroineTexts).toContain('林雾暗中记下的雪乃微表情');
        expect(heroineTexts).not.toContain('主观认知偏差：误信《月光》旧琴谱已烧毁');
    });

    it('writer 物理剥离所有 WARPED 条目与整卡 WARPED 实体；planner 与 fact_checker 保留所需视角与灰象信息', () => {
        const snapshot = createTestSnapshot();
        const slicer = new ViewSlicer();

        const writerView = slicer.sliceForWriter(snapshot, {
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });
        expect(writerView.entities['char_999']).toBeUndefined();
        expect(writerView.entities['char_001']?.acquiredState.some((e) => e.status === 'WARPED')).toBe(false);

        const plannerView = slicer.sliceForPlanner(snapshot, {
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });
        expect(plannerView.entities['char_999']).toBeDefined();
        expect(plannerView.entities['char_001']?.acquiredState.some((e) => e.status === 'WARPED')).toBe(true);
        expect(plannerView.entities['char_002']?.acquiredState.some((e) => e.visibility === 'OMNISCIENT_SECRET')).toBe(true);

        const checkerView = slicer.slice({
            snapshot,
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001',
            forRole: 'fact_checker'
        });
        expect(checkerView.entities['char_999']).toBeDefined();
        expect(checkerView.entities['char_002']?.acquiredState.some((e) => e.visibility === 'SELF_ONLY')).toBe(true);
    });

    it('currentCh - last_seen_ch > 30 时生成感官记忆唤醒提示（提取 PUBLIC Innate Locks 首句），<= 30 时不触发', () => {
        const snapshot = createTestSnapshot();
        const slicer = new ViewSlicer();

        // char_002 last_seen_ch = 10，currentCh = 45 -> 间隔 35 章 (>30)，触发唤醒
        const wakeupResult = slicer.sliceForWriter(snapshot, {
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });

        expect(wakeupResult.memoryWakeupHints).toHaveLength(1);
        expect(wakeupResult.memoryWakeupHints[0]).toMatchObject({
            entityId: 'char_002',
            canonicalName: '神代雪乃',
            lastSeenCh: 10,
            gapChapters: 35,
            sensoryCue: '右手腕内侧有旧烫伤浅疤。'
        });
        expect(wakeupResult.memoryWakeupHints[0]?.formattedHint).toContain('神代雪乃');
        expect(wakeupResult.memoryWakeupHints[0]?.formattedHint).toContain('35');

        // 边界测试：currentCh = 40 -> 间隔 30 章 (<=30)，不触发
        const boundaryResult = slicer.sliceForWriter(snapshot, {
            targetDay: 12,
            currentCh: 40,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });
        expect(boundaryResult.memoryWakeupHints).toHaveLength(0);
    });

    it('感官唤醒不会泄露非 POV 角色的 SELF_ONLY Innate Locks，且不修改输入快照', () => {
        const snapshot = createTestSnapshot();
        const heroine = snapshot.entities['char_002'];
        if (heroine) {
            // 仅保留 SELF_ONLY 的先天红线，移除 PUBLIC
            heroine.innateLocks = heroine.innateLocks.filter((e) => e.visibility === 'SELF_ONLY');
        }
        const beforeJson = JSON.stringify(snapshot);

        const slicer = new ViewSlicer();
        const result = slicer.sliceForWriter(snapshot, {
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });

        expect(result.memoryWakeupHints).toHaveLength(1);
        expect(result.memoryWakeupHints[0]?.sensoryCue).not.toContain('极度怕黑');
        expect(JSON.stringify(snapshot)).toBe(beforeJson);
    });

    it('未标记 visibility 的默认 PUBLIC 条目能被感官唤醒提取', () => {
        const snapshot = createTestSnapshot();
        const heroine = snapshot.entities['char_002'];
        if (heroine) {
            heroine.innateLocks = [
                {
                    text: '左耳戴着一枚褪色银环。总是微侧着头听人说话。',
                    continuationLines: []
                }
            ];
        }

        const slicer = new ViewSlicer();
        const result = slicer.sliceForWriter(snapshot, {
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });

        const heroineHint = result.memoryWakeupHints.find((h) => h.entityId === 'char_002');
        expect(heroineHint?.sensoryCue).toBe('左耳戴着一枚褪色银环。');
    });

    it('planner 视角下 SELF_ONLY 与 OMNISCIENT_SECRET 条目绝不泄露进 memoryWakeupHints', () => {
        const snapshot = createTestSnapshot();
        const heroine = snapshot.entities['char_002'];
        if (heroine) {
            // 仅保留 SELF_ONLY 和 OMNISCIENT_SECRET，无任何 PUBLIC 条目
            heroine.innateLocks = [
                {
                    visibility: 'SELF_ONLY',
                    text: '极度怕黑，无光源密闭环境下无法独自行动',
                    continuationLines: []
                },
                {
                    visibility: 'OMNISCIENT_SECRET',
                    text: '上帝视角底牌：实为双生姐妹中的妹妹',
                    continuationLines: []
                }
            ];
            heroine.acquiredState = [
                {
                    storyDay: 12,
                    chapter: 44,
                    visibility: 'OMNISCIENT_SECRET',
                    text: '暗中掌握校董会密室钥匙',
                    continuationLines: []
                }
            ];
        }

        const slicer = new ViewSlicer();
        const result = slicer.sliceForPlanner(snapshot, {
            targetDay: 12,
            currentCh: 45,
            timelineMode: 'MAINLINE',
            povCharId: 'char_001'
        });

        const heroineHint = result.memoryWakeupHints.find((h) => h.entityId === 'char_002');
        expect(heroineHint).toBeDefined();
        expect(heroineHint?.sensoryCue).toBe('神代雪乃');
        expect(heroineHint?.sensoryCue).not.toContain('极度怕黑');
        expect(heroineHint?.sensoryCue).not.toContain('双生姐妹');
        expect(heroineHint?.sensoryCue).not.toContain('密室钥匙');
    });
});

describe('sliceWorldDocuments', () => {
    const sampleDocs = {
        authorCharter: '# 作者契约\n隐藏真相：港口仓库地下室藏有走私账本。',
        arcDirectorPlan: '# 导演禁区\nStage Ceiling: 第5章前不得揭露幕后主谋。',
        currentArcEnvelope: [
            '## 公开舞台态势',
            '港口雾气沉重，货轮停靠在三号码头。',
            '- [WARPED] 原定码头仓库失火计划已废止',
            '  补充说明：已改走暗访调查线',
            '- 港口巡夜班次调整为两小时一轮',
            '',
            '## Stage Ceiling',
            '禁止在第三章前打开铁门。'
        ].join('\n'),
        staticBaseAndVoice: [
            '# 静态基线',
            '采用客观写实短句。',
            '- [Stage Ceiling] 绝不触发超自然设定',
            '- [WARPED] 旧时代电报设定已作废'
        ].join('\n'),
        opsStyleAmendments: [
            '- 多描写煤油灯与海风咸腥味',
            '- [WARPED] 取消第一卷末尾的暴雨戏'
        ].join('\n'),
        futureHorizon: '- [day:8] 稽查队抵达港口 [WARPED]'
    };

    it('writer 角色物理剥离 authorCharter、arcDirectorPlan、futureHorizon 及一切 WARPED / Stage Ceiling 指令（出现次数为 0）', () => {
        const sliced = sliceWorldDocuments('writer', sampleDocs);

        expect(sliced.forRole).toBe('writer');
        expect(sliced.authorCharter).toBeNull();
        expect(sliced.arcDirectorPlan).toBeNull();
        expect(sliced.futureHorizon).toBeNull();

        const writerCorpus = [
            sliced.currentArcEnvelope ?? '',
            sliced.staticBaseAndVoice ?? '',
            sliced.opsStyleAmendments ?? ''
        ].join('\n');

        expect(writerCorpus).not.toMatch(/\bWARPED\b/i);
        expect(writerCorpus).not.toMatch(/Stage\s*Ceiling/i);
        expect(writerCorpus).not.toContain('隐藏真相');
        expect(writerCorpus).not.toContain('禁止在第三章前打开铁门');
        expect(writerCorpus).not.toContain('原定码头仓库失火计划已废止');
        expect(writerCorpus).not.toContain('已改走暗访调查线');
        expect(writerCorpus).toContain('港口雾气沉重，货轮停靠在三号码头。');
        expect(writerCorpus).toContain('港口巡夜班次调整为两小时一轮');
        expect(writerCorpus).toContain('采用客观写实短句。');
        expect(writerCorpus).toContain('多描写煤油灯与海风咸腥味');
    });

    it('planner 与 fact_checker 角色保留契约、导演禁区与 futureHorizon 供统筹审校', () => {
        const plannerDocs = sliceWorldDocuments('planner', sampleDocs);
        expect(plannerDocs.authorCharter).toContain('走私账本');
        expect(plannerDocs.arcDirectorPlan).toContain('Stage Ceiling');
        expect(plannerDocs.futureHorizon).toContain('WARPED');
        expect(plannerDocs.currentArcEnvelope).toContain('Stage Ceiling');

        const checkerDocs = new ViewSlicer().sliceWorldDocuments('fact_checker', sampleDocs);
        expect(checkerDocs.arcDirectorPlan).toContain('Stage Ceiling');
        expect(checkerDocs.authorCharter).toContain('走私账本');
    });
});

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import { afterEach, describe, expect, it } from 'vitest';
import { BootGateError } from '../errors.js';
import * as bookToolsPlugin from '../index.js';
import { lockCharterAndBoot, type LockCharterAndBootInput } from './lock-charter-and-boot.js';

const tempDirs: string[] = [];

async function makeTempBooksRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'narrateos-boot-test-'));
    tempDirs.push(dir);
    return join(dir, 'books');
}

function buildMinimalValidBootInput(overrides: Partial<LockCharterAndBootInput> = {}): LockCharterAndBootInput {
    return {
        book_slug: 'harbor-slice',
        title: '港口核验记',
        pov_character: 'char_shen',
        t0_anchor: '大雪刚停的码头三号仓，沈默手里只剩半张盖过戳的提货单。',
        commitments: [
            '纯现实主义港口缉私推演，无超自然要素',
            '单卷完成港务账目闭环'
        ],
        excluded_cliches: ['天降神豪注资解围', '反派当众自曝全盘阴谋'],
        stage_ceiling: '第一卷阶段天花板：尚未拿到海关总署原始封存底档，不得揭露幕后总签批人姓名。',
        opening_sequence_beats: [
            {
                beat_label: '节拍一',
                craft_focus: '建立港口冬夜湿冷体感与提货单残缺压迫感',
                clue_budget: '仅放出三号仓编号与油印戳日期',
                completion_sign: '沈默确认货柜已被人提前撬走'
            },
            {
                beat_label: '节拍二',
                craft_focus: '与值班仓管老周的试探对话与账册比对',
                clue_budget: '放出异常夜班交接班次',
                completion_sign: '发现交接签名墨水尚未干透'
            },
            {
                beat_label: '节拍三',
                craft_focus: '顺藤摸瓜锁定驳船停泊区',
                clue_budget: '放出拖轮船号尾数',
                completion_sign: '确定追查方向并引出第一幕转折'
            }
        ],
        current_arc_envelope: '寒冬凌晨的北港三号泊位，货柜刚刚完成夜间倒运，沈默沿码头账目与班次追索缺失货物。',
        static_base_and_voice: '第三人称限知视角，短句克制，重物理器械与票据细节，禁用玄学比喻。',
        world_summary: '时值腊月北港封冻前夕，三号仓刚发生一宗账实不符的夜班提货事件。',
        l1_volumes_markdown: '# L1 活跃卷级总表\n\n- vol_01: 腊月封港账 (单卷完结)\n',
        entities: [
            {
                entityId: 'char_shen',
                canonicalName: '沈默',
                uniqueAliases: ['沈检'],
                contextualTitles: [],
                innateLocks: [{ visibility: 'PUBLIC', text: '右手食指关节因旧伤微曲' }],
                acquiredState: [{ storyDay: 0, visibility: 'PUBLIC', slotKey: 'location', text: '北港三号仓外廊' }],
                irreversibleTrajectory: [{ storyDay: 0, text: '签收半张提货单并赶往码头' }],
                recentBuffer: []
            }
        ],
        ...overrides
    };
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

describe('lock_charter_and_boot 开书建库与门禁停机', () => {
    it('支持单卷 (>=1)、0 条 OMNISCIENT_SECRET、0 条声纹起步，落盘 author_charter 与 arc_director_plan 并原地停机不写 ch_0001.md', async () => {
        const booksRoot = await makeTempBooksRoot();
        let bootedCallbackCount = 0;

        const result = await lockCharterAndBoot(buildMinimalValidBootInput(), {
            booksRoot,
            onBookBooted: () => {
                bootedCallbackCount += 1;
            }
        });

        expect(result.halted).toBe(true);
        expect(result.bookSlug).toBe('harbor-slice');
        expect(result.entityIds).toEqual(['char_shen']);
        expect(result.voiceSampleCount).toBe(0);
        expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/);
        expect(bootedCallbackCount).toBe(1);

        // 校验必需文件存在且 ch_0001.md 不存在
        expect(existsSync(join(result.bookRoot, 'manuscripts/ch_0001.md'))).toBe(false);
        expect(existsSync(join(result.bookRoot, 'world/author_charter.md'))).toBe(true);
        expect(existsSync(join(result.bookRoot, 'world/arc_director_plan.md'))).toBe(true);
        expect(existsSync(join(result.bookRoot, 'world/current_arc_envelope.md'))).toBe(true);

        const charter = await readFile(join(result.bookRoot, 'world/author_charter.md'), 'utf8');
        expect(charter).toContain('大雪刚停的码头三号仓');
        expect(charter).toContain('天降神豪注资解围');

        const directorPlan = await readFile(join(result.bookRoot, 'world/arc_director_plan.md'), 'utf8');
        expect(directorPlan).toContain('Stage Ceiling');
        expect(directorPlan).toContain('Opening Sequence Beats');
        expect(directorPlan).toContain('节拍一');
        expect(directorPlan).toContain('节拍三');

        // 声纹池为空（0 条）
        const voiceYaml = await readFile(join(result.bookRoot, '.ops/voice_samples.yaml'), 'utf8');
        expect(voiceYaml.trim()).toBe('samples: []');

        // tx_state 初始化 last_committed_ch = 0 且 Git 工作区干净
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { bookRoot: result.bookRoot });
        const store = ctx.narrateStore.openStore();
        const txState = await store.readTxState();
        expect(txState.last_committed_ch).toBe(0);
        expect(txState.phase).toBe('IDLE');
        expect(await ctx.narrateStore.system.isWorkingTreeClean(result.bookRoot)).toBe(true);
        await storeFiber.dispose();
    });

    it('拦截 storyDay > 0 的 T0 时间线泄露与 StaticProseGate 违规文本，且不残余半成品目录', async () => {
        const booksRoot = await makeTempBooksRoot();

        // T0 泄露拦截
        await expect(
            lockCharterAndBoot(
                buildMinimalValidBootInput({
                    book_slug: 't0-leak-book',
                    entities: [
                        {
                            entityId: 'char_shen',
                            canonicalName: '沈默',
                            uniqueAliases: [],
                            contextualTitles: [],
                            innateLocks: [],
                            acquiredState: [
                                { storyDay: 3, visibility: 'PUBLIC', text: '三天后拿到关键账本' }
                            ],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        }
                    ]
                }),
                { booksRoot }
            )
        ).rejects.toThrow(BootGateError);
        expect(existsSync(join(booksRoot, 't0-leak-book'))).toBe(false);

        // StaticProseGate 拦截（world_summary 含微距解剖与一丝/一抹违规词）
        await expect(
            lockCharterAndBoot(
                buildMinimalValidBootInput({
                    book_slug: 'cliche-book',
                    world_summary: '他指节泛白，喉结滚动，眼神中闪过一丝笑意。'
                }),
                { booksRoot }
            )
        ).rejects.toThrow(BootGateError);
        expect(existsSync(join(booksRoot, 'cliche-book'))).toBe(false);
    });

    it('通过 ctx.narrateTools.lockCharterAndBoot 可正常过滤作者提供的合歌声纹样本', async () => {
        const booksRoot = await makeTempBooksRoot();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin);
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });

        const res = await ctx.narrateTools.lockCharterAndBoot(
            buildMinimalValidBootInput({
                book_slug: 'with-voice',
                voice_samples: [
                    { tag: '对白', sample: '「单子上的骑缝章少了一角，这批货我不能放行。」' },
                    { tag: '废句', sample: '他深吸一口气，眼神中闪过一丝复杂的情绪。' }
                ]
            })
        );

        expect(res.voiceSampleCount).toBe(1);
        expect(res.filteredVoiceSampleCount).toBe(1);
        const voiceYaml = await readFile(join(res.bookRoot, '.ops/voice_samples.yaml'), 'utf8');
        expect(voiceYaml).toContain('单子上的骑缝章少了一角');
        expect(voiceYaml).not.toContain('深吸一口气');

        await toolsFiber.dispose();
        await storeFiber.dispose();
    });
});

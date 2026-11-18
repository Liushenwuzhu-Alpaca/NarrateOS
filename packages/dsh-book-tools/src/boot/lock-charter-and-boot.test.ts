import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolsService, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import { NodeSystemAdapter } from '@narrateos/dsh-book-store';
import { afterEach, describe, expect, it } from 'vitest';
import { BootGateError } from '../errors.js';
import * as bookToolsPlugin from '../index.js';
import {
    createLockCharterAndBootTool,
    lockCharterAndBoot,
    type LockCharterAndBootInput
} from './lock-charter-and-boot.js';

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

function registerCleanup(fn: () => void | Promise<void>): void {
    cleanups.push(fn);
}

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
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            await fn();
        }
    }
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
        registerCleanup(() => storeFiber.dispose());
        const store = ctx.narrateStore.openStore();
        const txState = await store.readTxState();
        expect(txState.last_committed_ch).toBe(0);
        expect(txState.phase).toBe('IDLE');
        expect(await ctx.narrateStore.system.isWorkingTreeClean(result.bookRoot)).toBe(true);
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
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => toolsFiber.dispose());

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
    });

    it('拒绝缺少中文 canonicalName 与 static_base_and_voice 违规，且写入/Git 失败时彻底回滚新建目录', async () => {
        const booksRoot = await makeTempBooksRoot();

        // 1. 缺中文 canonicalName 拦截
        await expect(
            lockCharterAndBoot(
                buildMinimalValidBootInput({
                    book_slug: 'no-cn-name',
                    entities: [
                        {
                            entityId: 'char_shen',
                            canonicalName: 'ShenMo',
                            uniqueAliases: [],
                            contextualTitles: [],
                            innateLocks: [],
                            acquiredState: [],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        }
                    ]
                }),
                { booksRoot }
            )
        ).rejects.toThrow(BootGateError);
        expect(existsSync(join(booksRoot, 'no-cn-name'))).toBe(false);

        // 2. static_base_and_voice 触发 StaticProseGate 拦截
        await expect(
            lockCharterAndBoot(
                buildMinimalValidBootInput({
                    book_slug: 'bad-static-voice',
                    static_base_and_voice: '他指节泛白，喉结滚动，眼神中闪过一丝寒意。'
                }),
                { booksRoot }
            )
        ).rejects.toThrow(BootGateError);
        expect(existsSync(join(booksRoot, 'bad-static-voice'))).toBe(false);

        // 3. Git initRepo 失败时回滚清理新建的半成品目录，确保重试可直接成功
        const failingSystem = new NodeSystemAdapter();
        failingSystem.initRepo = async () => {
            throw new Error('simulated git init failure');
        };
        await expect(
            lockCharterAndBoot(buildMinimalValidBootInput({ book_slug: 'rollback-retry' }), {
                booksRoot,
                system: failingSystem
            })
        ).rejects.toThrow('simulated git init failure');
        expect(existsSync(join(booksRoot, 'rollback-retry'))).toBe(false);

        // 4. 若空目录预先存在，失败后清空目录内容，重试同样不被残留阻塞
        const emptyPreExisting = join(booksRoot, 'empty-preexisting');
        await mkdir(emptyPreExisting, { recursive: true });
        await expect(
            lockCharterAndBoot(buildMinimalValidBootInput({ book_slug: 'empty-preexisting' }), {
                booksRoot,
                system: failingSystem
            })
        ).rejects.toThrow('simulated git init failure');
        const retryRes = await lockCharterAndBoot(
            buildMinimalValidBootInput({ book_slug: 'empty-preexisting' }),
            { booksRoot }
        );
        expect(retryRes.halted).toBe(true);
    });

    it('NarrateToolsService 继承 narrateStore.booksRoot 且卸载后拒绝调用 lockCharterAndBoot', async () => {
        const booksRoot = await makeTempBooksRoot();
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin, { booksRoot });
        registerCleanup(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin);
        registerCleanup(() => toolsFiber.dispose());

        expect(ctx.narrateTools.booksRoot).toBe(booksRoot);
        const toolsService = ctx.narrateTools;

        await toolsFiber.dispose();
        await expect(
            toolsService.lockCharterAndBoot(buildMinimalValidBootInput({ book_slug: 'after-dispose' }))
        ).rejects.toThrow('已卸载');
    });

    it('允许 max_auto_rollback_chapters 为 0（关闭自动回滚），拒绝负数，且工具 Schema 描述标明 camelCase/snake_case 差异', async () => {
        const booksRoot = await makeTempBooksRoot();

        const res = await lockCharterAndBoot(
            buildMinimalValidBootInput({
                book_slug: 'zero-rollback-book',
                max_auto_rollback_chapters: 0
            }),
            { booksRoot }
        );
        expect(res.halted).toBe(true);
        const bookConfigYaml = await readFile(join(res.bookRoot, 'world/book_config.yaml'), 'utf8');
        expect(bookConfigYaml).toContain('max_auto_rollback_chapters: 0');

        await expect(
            lockCharterAndBoot(
                buildMinimalValidBootInput({
                    book_slug: 'negative-rollback-book',
                    max_auto_rollback_chapters: -1
                }),
                { booksRoot }
            )
        ).rejects.toThrow();
        expect(existsSync(join(booksRoot, 'negative-rollback-book'))).toBe(false);

        const tool = createLockCharterAndBootTool({ booksRoot });
        const props = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties ?? {};
        expect(props['entities']?.description).toContain('camelCase');
        expect(props['entities']?.description).toContain('entityId');
        expect(props['entities']?.description).toContain('snake_case');
        expect(props['lore_entries']?.description).toContain('lore_*');
        expect(props['open_threads']?.description).toContain('15');
        expect(props['future_horizon_events']?.description).toContain('story_day');
        expect(props['voice_samples']?.description).toContain('StaticProseGate');
    });

    it('apply(ctx) 注册的 lock_charter_and_boot 成功建库后自动 switchBook，遇到在途锁冲突时不回滚已落盘目录', async () => {
        const booksRoot = await makeTempBooksRoot();
        const ctx = new Context();
        const promptFiber = await ctx.plugin(SystemPrompt);
        registerCleanup(() => promptFiber.dispose());
        const toolsSvcFiber = await ctx.plugin(ToolsService);
        registerCleanup(() => toolsSvcFiber.dispose());
        const storeFiber = await ctx.plugin(bookStorePlugin);
        registerCleanup(() => storeFiber.dispose());
        const bookToolsFiber = await ctx.plugin(bookToolsPlugin, { booksRoot });
        registerCleanup(() => bookToolsFiber.dispose());

        const bootTool = ctx.tools.get('lock_charter_and_boot');
        expect(bootTool).toBeDefined();

        const execCtx: ToolRunContext = {
            token: Symbol('boot') as ToolRunContext['token'],
            callId: 'call-boot-switch-1' as ToolRunContext['callId'],
            rootCallId: 'call-boot-switch-1' as ToolRunContext['rootCallId'],
            name: 'lock_charter_and_boot',
            arguments: {},
            signal: new AbortController().signal,
            deferContext() {},
            concludeTurn() {}
        };

        // 1. 无冲突：开书后自动切换 ctx.narrateStore.bookRoot 至新书目录
        const firstInput = buildMinimalValidBootInput({ book_slug: 'auto-switch-book' });
        const firstRes = (await bootTool!.execute(firstInput, execCtx)) as {
            bookRoot: string;
            halted: boolean;
        };
        expect(firstRes.halted).toBe(true);
        expect(ctx.narrateStore.bookRoot).toBe(firstRes.bookRoot);

        // 2. 存在在途 runId 锁冲突时：switchBook 被拒绝但不影响建库成功与磁盘产物保留
        ctx.narrateStore.beginRun('in-flight-run');
        try {
            const secondInput = buildMinimalValidBootInput({ book_slug: 'conflict-safe-book' });
            const secondRes = (await bootTool!.execute(secondInput, execCtx)) as {
                bookRoot: string;
                halted: boolean;
            };
            expect(secondRes.halted).toBe(true);
            expect(existsSync(join(secondRes.bookRoot, 'world/author_charter.md'))).toBe(true);
            expect(ctx.narrateStore.bookRoot).toBe(firstRes.bookRoot);
        } finally {
            ctx.narrateStore.endRun('in-flight-run');
        }
    });
});

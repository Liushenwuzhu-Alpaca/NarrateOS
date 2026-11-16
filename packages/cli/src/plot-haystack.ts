import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    BookStore,
    bootBook,
    type CleanroomRequest,
    type CleanroomResponse,
    hashStaticPrefix,
    type LlmPort,
    NarrativeEngine,
    NodeSystemAdapter,
    ScriptedLlmAdapter,
    type SystemPort,
    type TelemetryMetrics,
    type TokenUsage
} from '@narrateos/core';

/** Plot-Haystack 探针分类 */
export type HaystackProbeCategory =
    | 'polarity_reversal'
    | 'negative_redline'
    | 'dialogue_lie_gap'
    | 'anomalous_foreshadowing';

/** 单枚探针定义 */
export interface HaystackProbeSpec {
    id: string;
    category: HaystackProbeCategory;
    title: string;
    plantChapter: number;
    verifyChapter: number;
    plantKeywords: string[];
    recallKeywords: string[];
    forbiddenBreachKeywords: string[];
}

/** 单枚探针核验结果 */
export interface HaystackProbeResult {
    id: string;
    category: HaystackProbeCategory;
    title: string;
    plantChapter: number;
    verifyChapter: number;
    plantMatched: boolean;
    pairedRecallPassed: boolean;
    continuityBreached: boolean;
    details: string;
}

/** 单章四联遥测与缓存采样 */
export interface ChapterBenchmarkSample {
    chapterNumber: number;
    telemetry: TelemetryMetrics;
    usage: TokenUsage;
    prefixHashes: string[];
    prefixCacheHitRatio: number;
}

/** 四联遥测窗口均值 */
export interface TelemetryWindowAvg {
    mattr500: number;
    kontoyiannisEntropy: number;
    sentenceLengthCv: number;
    clicheDensityPer1k: number;
}

/** Plot-Haystack 40 章盲测汇总报告 */
export interface PlotHaystackReport {
    bookRoot: string;
    totalChapters: number;
    probes: HaystackProbeResult[];
    summary: {
        totalProbes: number;
        breachedCount: number;
        breachRate: number;
        recalledCount: number;
        pairedRecallRate: number;
        prefixHashConsistencyRate: number;
        tokenCacheHitRate: number;
        totalUsage: TokenUsage;
    };
    telemetryTrend: {
        chapters: ChapterBenchmarkSample[];
        earlyWindowAvg: TelemetryWindowAvg;
        lateWindowAvg: TelemetryWindowAvg;
    };
}

export interface PlotHaystackOptions {
    bookRoot: string;
    llm: LlmPort;
    system?: SystemPort | undefined;
    targetChapters?: number | undefined;
    bookSlug?: string | undefined;
    title?: string | undefined;
}

/**
 * 按 ARCHITECTURE.md 5.4 节预埋的 10 枚探针：
 * - 3 组得而复失极性反转
 * - 3 条低语义关联负向红线
 * - 2 处台词谎言信息差
 * - 2 个跨 35 章反常闲笔
 */
export const PLOT_HAYSTACK_PROBES: readonly HaystackProbeSpec[] = [
    {
        id: 'probe_polarity_1',
        category: 'polarity_reversal',
        title: '银质怀表得而复失极性反转',
        plantChapter: 1,
        verifyChapter: 36,
        plantKeywords: ['银质怀表'],
        recallKeywords: ['赎回', '银质怀表'],
        forbiddenBreachKeywords: ['从未拥有过银质怀表']
    },
    {
        id: 'probe_polarity_2',
        category: 'polarity_reversal',
        title: '旧港通行铜牌没收与重获',
        plantChapter: 2,
        verifyChapter: 37,
        plantKeywords: ['通行铜牌'],
        recallKeywords: ['取回', '通行铜牌'],
        forbiddenBreachKeywords: ['铜牌一直挂在腰间']
    },
    {
        id: 'probe_polarity_3',
        category: 'polarity_reversal',
        title: '加密潮汐账本损毁与抄本复原',
        plantChapter: 4,
        verifyChapter: 39,
        plantKeywords: ['潮汐账本'],
        recallKeywords: ['抄本', '潮汐账本'],
        forbiddenBreachKeywords: ['原版账本完好无损']
    },
    {
        id: 'probe_redline_1',
        category: 'negative_redline',
        title: '雪松木香严重过敏负向红线',
        plantChapter: 1,
        verifyChapter: 36,
        plantKeywords: ['雪松木香过敏'],
        recallKeywords: ['避开雪松'],
        forbiddenBreachKeywords: ['点燃了雪松香薰', '深吸一口雪松香']
    },
    {
        id: 'probe_redline_2',
        category: 'negative_redline',
        title: '左腕旧伤无法单手反拧铁阀',
        plantChapter: 2,
        verifyChapter: 37,
        plantKeywords: ['左腕旧伤'],
        recallKeywords: ['改用右肩撬棍'],
        forbiddenBreachKeywords: ['左手轻松拧开生锈铁阀']
    },
    {
        id: 'probe_redline_3',
        category: 'negative_redline',
        title: '林默不识旧港渔家密符',
        plantChapter: 3,
        verifyChapter: 38,
        plantKeywords: ['不识渔家密符'],
        recallKeywords: ['请老船工辨认密符'],
        forbiddenBreachKeywords: ['林默一眼读懂了渔家密符']
    },
    {
        id: 'probe_lie_1',
        category: 'dialogue_lie_gap',
        title: '巡夜人盘问时的铜牌谎言信息差',
        plantChapter: 3,
        verifyChapter: 38,
        plantKeywords: ['丢进海湾', '靴底'],
        recallKeywords: ['拆穿了当年靴底藏牌的谎话'],
        forbiddenBreachKeywords: ['巡夜人早已知道铜牌在靴底']
    },
    {
        id: 'probe_lie_2',
        category: 'dialogue_lie_gap',
        title: '北堤灯塔留宿三夜的台词谎言',
        plantChapter: 5,
        verifyChapter: 39,
        plantKeywords: ['从未去过北堤灯塔', '留宿过三夜'],
        recallKeywords: ['北堤灯塔那三夜的登记簿'],
        forbiddenBreachKeywords: ['林默坦白自己常住北堤灯塔']
    },
    {
        id: 'probe_foreshadow_1',
        category: 'anomalous_foreshadowing',
        title: '跨 35 章左袖口缺角银扣闲笔',
        plantChapter: 1,
        verifyChapter: 36,
        plantKeywords: ['缺角银扣'],
        recallKeywords: ['缺角银扣'],
        forbiddenBreachKeywords: ['双袖银扣皆完整无缺']
    },
    {
        id: 'probe_foreshadow_2',
        category: 'anomalous_foreshadowing',
        title: '跨 35 章石阶刻痕 03:17 闲笔',
        plantChapter: 4,
        verifyChapter: 40,
        plantKeywords: ['03:17'],
        recallKeywords: ['03:17'],
        forbiddenBreachKeywords: ['指针停在正午十二点']
    }
];

function formatChapterFilename(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}.md`;
}

function resolveChapterNumberForTarget(originalChapter: number, targetChapters: number): number {
    if (targetChapters >= 40) {
        return originalChapter;
    }
    if (originalChapter <= 5) {
        return Math.min(originalChapter, targetChapters);
    }
    const offsetFromEnd = 40 - originalChapter;
    return Math.max(1, targetChapters - offsetFromEnd);
}

function averageTelemetry(samples: ChapterBenchmarkSample[]): TelemetryWindowAvg {
    if (samples.length === 0) {
        return {
            mattr500: 0,
            kontoyiannisEntropy: 0,
            sentenceLengthCv: 0,
            clicheDensityPer1k: 0
        };
    }
    let mattr = 0;
    let entropy = 0;
    let cv = 0;
    let cliche = 0;
    for (const s of samples) {
        mattr += s.telemetry.mattr500;
        entropy += s.telemetry.kontoyiannisEntropy;
        cv += s.telemetry.sentenceLengthCv;
        cliche += s.telemetry.clicheDensityPer1k;
    }
    const n = samples.length;
    return {
        mattr500: Number((mattr / n).toFixed(4)),
        kontoyiannisEntropy: Number((entropy / n).toFixed(4)),
        sentenceLengthCv: Number((cv / n).toFixed(4)),
        clicheDensityPer1k: Number((cliche / n).toFixed(4))
    };
}

interface PrefixObservation {
    bucketKey: string;
    prefixHash: string | null;
    usage: TokenUsage;
}

function classifyPrefixBucket(req: CleanroomRequest): string {
    const firstBlock = req.staticPrefixBlocks[0] ?? '';
    if (req.pool === 'fast_retrieval') {
        if (firstBlock.includes('Librarian') || firstBlock.includes('图书管理员')) {
            return 'fast_retrieval:librarian';
        }
        if (firstBlock.includes('Extractor') || firstBlock.includes('抽取器')) {
            return 'fast_retrieval:extractor';
        }
    }
    if (req.pool === 'strong_creative') {
        return 'strong_creative:planner_writer';
    }
    return req.pool;
}

class ObservingLlmPort implements LlmPort {
    readonly observations: PrefixObservation[] = [];

    constructor(private readonly inner: LlmPort) {}

    async generate(req: CleanroomRequest, signal?: AbortSignal): Promise<CleanroomResponse> {
        const res = await this.inner.generate(req, signal);
        const prefixHash =
            req.staticPrefixBlocks.length > 0 ? hashStaticPrefix(req.staticPrefixBlocks) : null;
        this.observations.push({
            bucketKey: classifyPrefixBucket(req),
            prefixHash,
            usage: res.usage
        });
        return res;
    }
}

async function readChapterTextSafe(bookRoot: string, chapterNumber: number): Promise<string> {
    try {
        return await readFile(join(bookRoot, 'manuscripts', formatChapterFilename(chapterNumber)), 'utf8');
    } catch {
        return '';
    }
}

/**
 * 运行 Plot-Haystack 40 章盲测基准驱动器
 */
export async function runPlotHaystackBenchmark(options: PlotHaystackOptions): Promise<PlotHaystackReport> {
    const targetChapters = Math.max(1, options.targetChapters ?? 40);
    const system = options.system ?? new NodeSystemAdapter();
    const observer = new ObservingLlmPort(options.llm);

    await bootBook(
        {
            bookRoot: options.bookRoot,
            bookSlug: options.bookSlug ?? 'plot-haystack-bench',
            title: options.title ?? '雾港长卷盲测基准',
            povCharacter: 'char_shenyan',
            mode: 'original',
            premiseOrSeed: '雾港钟楼与旧码头暗流涌动，钟表匠沈砚与学徒林默追查失落账本与停摆钟声。',
            writerTokenBudget: 4096
        },
        {
            llm: observer,
            system
        }
    );

    const store = new BookStore(options.bookRoot, system);
    const engine = new NarrativeEngine({
        store,
        llm: observer,
        system
    });

    const chapterSamples: ChapterBenchmarkSample[] = [];
    const totalUsage: TokenUsage = {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0
    };

    // 按调用阶段分桶记录首次非空静态前缀哈希，核验同卷内 Planner/Writer/Audit 等前缀缓存稳定性
    const baselinePrefixByBucket = new Map<string, string>();
    let totalStaticPrefixCalls = 0;
    let consistentPrefixCalls = 0;

    for (let ch = 1; ch <= targetChapters; ch += 1) {
        const obsStart = observer.observations.length;
        const stepResult = await engine.stepChapter({
            chapterNumber: ch,
            chapterGoal: `推进第 ${ch} 章主线调查并保持长程探针连续性`
        });

        const chapterObs = observer.observations.slice(obsStart);
        const chapterHashes: string[] = [];
        let chapterPromptTokens = 0;
        let chapterCacheReadTokens = 0;

        for (const item of chapterObs) {
            if (item.prefixHash !== null) {
                chapterHashes.push(item.prefixHash);
                totalStaticPrefixCalls += 1;
                const baseline = baselinePrefixByBucket.get(item.bucketKey);
                if (baseline === undefined) {
                    baselinePrefixByBucket.set(item.bucketKey, item.prefixHash);
                    consistentPrefixCalls += 1;
                } else if (baseline === item.prefixHash) {
                    consistentPrefixCalls += 1;
                }
            }
            chapterPromptTokens +=
                item.usage.inputTokens + item.usage.cacheReadTokens + item.usage.cacheWriteTokens;
            chapterCacheReadTokens += item.usage.cacheReadTokens;
        }

        totalUsage.inputTokens += stepResult.totalUsage.inputTokens;
        totalUsage.cacheReadTokens += stepResult.totalUsage.cacheReadTokens;
        totalUsage.cacheWriteTokens += stepResult.totalUsage.cacheWriteTokens;
        totalUsage.outputTokens += stepResult.totalUsage.outputTokens;

        chapterSamples.push({
            chapterNumber: ch,
            telemetry: stepResult.telemetry,
            usage: stepResult.totalUsage,
            prefixHashes: chapterHashes,
            prefixCacheHitRatio:
                chapterPromptTokens > 0
                    ? Number((chapterCacheReadTokens / chapterPromptTokens).toFixed(4))
                    : 0
        });
    }

    // 读取全卷各章手稿用于 10 枚探针确定性核验
    const chapterTexts = new Map<number, string>();
    for (let ch = 1; ch <= targetChapters; ch += 1) {
        chapterTexts.set(ch, await readChapterTextSafe(options.bookRoot, ch));
    }
    const allTextsJoined = Array.from(chapterTexts.values()).join('\n');

    const probeResults: HaystackProbeResult[] = PLOT_HAYSTACK_PROBES.map((spec) => {
        const plantCh = resolveChapterNumberForTarget(spec.plantChapter, targetChapters);
        const verifyCh = resolveChapterNumberForTarget(spec.verifyChapter, targetChapters);
        const plantText = chapterTexts.get(plantCh) ?? '';
        const verifyText = chapterTexts.get(verifyCh) ?? '';

        const plantMatched = spec.plantKeywords.every((kw) => plantText.includes(kw));
        const recallMatched = spec.recallKeywords.every((kw) => verifyText.includes(kw));
        const breachMatched = spec.forbiddenBreachKeywords.some((kw) => allTextsJoined.includes(kw));

        return {
            id: spec.id,
            category: spec.category,
            title: spec.title,
            plantChapter: plantCh,
            verifyChapter: verifyCh,
            plantMatched,
            pairedRecallPassed: plantMatched && recallMatched,
            continuityBreached: breachMatched,
            details: breachMatched
                ? '检测到违禁穿帮词'
                : plantMatched && recallMatched
                  ? `Ch.${plantCh} 预埋并在 Ch.${verifyCh} 成功回收`
                  : `预埋=${plantMatched}, 回收=${recallMatched}`
        };
    });

    const breachedCount = probeResults.filter((p) => p.continuityBreached).length;
    const recalledCount = probeResults.filter((p) => p.pairedRecallPassed).length;
    const totalPromptTokens =
        totalUsage.inputTokens + totalUsage.cacheReadTokens + totalUsage.cacheWriteTokens;

    const earlyWindow = chapterSamples.slice(0, Math.min(5, chapterSamples.length));
    const lateWindow = chapterSamples.slice(Math.max(0, chapterSamples.length - 5));

    return {
        bookRoot: options.bookRoot,
        totalChapters: targetChapters,
        probes: probeResults,
        summary: {
            totalProbes: probeResults.length,
            breachedCount,
            breachRate: Number((breachedCount / probeResults.length).toFixed(4)),
            recalledCount,
            pairedRecallRate: Number((recalledCount / probeResults.length).toFixed(4)),
            prefixHashConsistencyRate:
                totalStaticPrefixCalls > 0
                    ? Number((consistentPrefixCalls / totalStaticPrefixCalls).toFixed(4))
                    : 0,
            tokenCacheHitRate:
                totalPromptTokens > 0
                    ? Number((totalUsage.cacheReadTokens / totalPromptTokens).toFixed(4))
                    : 0,
            totalUsage
        },
        telemetryTrend: {
            chapters: chapterSamples,
            earlyWindowAvg: averageTelemetry(earlyWindow),
            lateWindowAvg: averageTelemetry(lateWindow)
        }
    };
}

function buildHaystackChapterProse(chapterNumber: number, targetChapters: number): string {
    const chMap = (orig: number) => resolveChapterNumberForTarget(orig, targetChapters);
    const locations = ['旧钟表铺', '北堤石阶', '旧港当铺', '灯塔底层', '潮汐水闸'];
    const loc = locations[(chapterNumber - 1) % locations.length] ?? '旧钟表铺';

    const paragraphs: string[] = [
        `第${chapterNumber}日清晨，海雾漫过${loc}的石砌门槛。沈砚拎起黄铜提灯，检查木箱里的游标卡尺、干布与小号平口起子，随后推开吱呀作响的木门。`,
        `街角摊贩刚卸下冰鲜竹篓，青石板路面上还留着昨夜退潮后的盐渍。林默跟在三步之后，把防水油布裹紧在帆布背包外侧，低声报出昨晚潮位尺的刻度记录。`
    ];

    // Ch.01-05 埋设 10 枚探针
    if (chapterNumber === chMap(1)) {
        paragraphs.push(
            '沈砚从木匣最底层取出那枚银质怀表，表壳内侧刻着细小编号。他把怀表放进贴身马甲口袋，又特意绕开柜台旁刚拆封的木盒——自幼雪松木香过敏的老毛病让他绝不靠近任何松脂熏料。起身时，他瞥见门口风衣左袖口少了一颗缺角银扣，线头已经发黑。'
        );
    }
    if (chapterNumber === chMap(2)) {
        paragraphs.push(
            '港务老吏递来一块刻有锚纹的旧港通行铜牌，叮嘱他凭牌进出东侧栈桥。走到水闸铁门前，沈砚因左腕旧伤使不上力，便让林默先用木楔卡住门闩，自己再推开半扇铁门。'
        );
    }
    if (chapterNumber === chMap(3)) {
        paragraphs.push(
            '巡夜人举着马灯拦在巷口盘问铜牌去向，沈砚面不改色地答道：“通行铜牌早在上周大潮时丢进海湾了。”实际上他早已把铜牌塞进右脚靴底夹层。墙根砖缝里画着几道粉笔线，林默盯着看了半晌，坦言自己不识渔家密符，只把线形临摹在便签上。'
        );
    }
    if (chapterNumber === chMap(4)) {
        paragraphs.push(
            '两人在旧仓阁楼撬开铁皮柜，找到半本用蓝墨水写就的潮汐账本。下楼经过钟楼石阶第三级时，提灯光束掠过砖沿上一道极浅的刻痕，上面写着“03:17”四个数字，边缘已经磨平。'
        );
    }
    if (chapterNumber === chMap(5)) {
        paragraphs.push(
            '面对码头管事的试探，林默垂眼整理绳结，轻声回了一句：“我从未去过北堤灯塔。”话音落定后他转过身，独自想起去年腊月自己在那座灯塔二层留宿过三夜的旧事。'
        );
    }

    // 中段 Ch.15 / Ch.20 / Ch.24 极性反转：失去阶段
    if (chapterNumber === 15 && targetChapters >= 20) {
        paragraphs.push(
            '为了筹措修复水下测深仪的铜片，沈砚把银质怀表送进西街典当行，换回三枚银元与一张发黄的当票。'
        );
    }
    if (chapterNumber === 20 && targetChapters >= 25) {
        paragraphs.push(
            '港务巡查队在东栈桥设卡清查旧证，那枚旧港通行铜牌被当场暂扣登记，只留下一纸收据。'
        );
    }
    if (chapterNumber === 24 && targetChapters >= 30) {
        paragraphs.push(
            '渡船抢靠木桩时船身剧烈倾斜，装在油布袋里的潮汐账本掉入混浊海水，纸页瞬间泡烂散架。'
        );
    }

    // Ch.36-40 回收与呼应 10 枚探针
    if (chapterNumber === chMap(36)) {
        paragraphs.push(
            '沈砚拿着积攒的工钱走进西街当铺，当场赎回那枚银质怀表，指尖摩挲着表盖内侧的编号。铺外药柜正晒着熏香，他屏住呼吸绕道下风口，刻意避开雪松气味。转过拐角时，灰呢外套的摊主抬手接过茶碗，袖口那颗缺角银扣在日光下闪了一下。'
        );
    }
    if (chapterNumber === chMap(37)) {
        paragraphs.push(
            '港务老吏核对完失窃卷宗，从铁柜里重新取回旧港通行铜牌交还沈砚。两人随后推开北闸机房，面对卡死的生锈铁阀，沈砚改用右肩撬棍一点点顶松阀轮，避开了左腕旧伤的受力方向。'
        );
    }
    if (chapterNumber === chMap(38)) {
        paragraphs.push(
            '老巡夜人指着当年巷口的记录簿，当场拆穿了当年靴底藏牌的谎话，沈砚只是把铜牌平放在桌面。随后林默掏出早年临摹的便签，请老船工辨认密符，才弄清那串记号标的是旧水闸的暗门方位。'
        );
    }
    if (chapterNumber === chMap(39)) {
        paragraphs.push(
            '档案室管理员从干燥铁箱里翻出早年留档的抄本，蓝墨水字迹与当年泡毁的潮汐账本完全吻合。对质席上，沈砚亮出北堤灯塔那三夜的登记簿，林默沉默片刻后点了点头。'
        );
    }
    if (chapterNumber === chMap(40)) {
        paragraphs.push(
            '夜潮退去，钟楼顶层的黄铜大钟终于露出了底座卡榫。沈砚举灯照向停摆的钟面，两根铜指针稳稳定格在 03:17，与石阶第三级的旧刻痕严丝合缝。'
        );
    }

    paragraphs.push(
        '风从防波堤外侧吹进来，带来湿咸的水汽。两人收拾好工具箱里的铜尺与笔记，沿着石阶一路走回街灯亮起的巷口。'
    );

    return paragraphs.join('\n\n');
}

/**
 * 构建 40 章 Plot-Haystack 离线盲测专用脚本化 LLM 适配器
 */
export function createPlotHaystackScriptedLlm(targetChapters = 40): ScriptedLlmAdapter {
    let plannedChapter = 0;

    const responder = (req: CleanroomRequest): CleanroomResponse => {
        const staticText = req.staticPrefixBlocks.join('\n');
        const tail = req.dynamicTail;

        // 1. bootBook 标定
        if (tail.includes('标定样本')) {
            return {
                text: 'OK',
                usage: { inputTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
                modelId: 'haystack-mock'
            };
        }

        // 2. bootBook 编译世界与实体档案
        if (req.pool === 'strong_creative' && tail.includes('编译模式:')) {
            return {
                text: JSON.stringify({
                    worldSummary: '雾港钟楼与旧港码头构成潮汐孤城，钟表匠沈砚与学徒林默追查失落账本。',
                    staticBaseAndVoice: '冷峻写实，长短句交错，以器物与感官细节推进叙事。',
                    currentArcEnvelope: '第一卷：雾港长卷（40 章盲测主线）。',
                    voiceSamples: [
                        { tag: 'calm_dialogue', sample: '“钟摆不会自己停，”沈砚把铜尺放平，“总有人动过棘轮。”' }
                    ],
                    openThreads: [
                        { threadId: 'thread_0317', title: '03:17 停摆钟面', wakeupCondition: '第 40 章核对石阶刻痕' }
                    ],
                    futureHorizonEvents: [],
                    loreEntries: [
                        {
                            id: 'lore_old_harbor',
                            title: '旧港水闸志',
                            summary: '旧港水闸与钟楼地下水道连通。',
                            content: '每逢大潮退去，旧港水闸底层石阶会露出早年工匠刻下的水位记号。'
                        }
                    ],
                    entities: [
                        {
                            entityId: 'char_shenyan',
                            canonicalName: '沈砚',
                            uniqueAliases: ['沈师傅'],
                            contextualTitles: ['钟表匠'],
                            innateLocks: [
                                { visibility: 'PUBLIC', text: '对雪松木香严重过敏，绝不接触雪松熏料' },
                                { visibility: 'PUBLIC', text: '左腕旧伤无法单手反拧重型生锈铁阀' }
                            ],
                            acquiredState: [
                                { storyDay: 1, visibility: 'PUBLIC', slotKey: 'location', text: '身处旧钟表铺' }
                            ],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        },
                        {
                            entityId: 'char_linmo',
                            canonicalName: '林默',
                            uniqueAliases: ['阿默'],
                            contextualTitles: ['学徒'],
                            innateLocks: [{ visibility: 'PUBLIC', text: '不识旧港渔家密符' }],
                            acquiredState: [
                                { storyDay: 1, visibility: 'PUBLIC', slotKey: 'location', text: '跟随沈砚调查' }
                            ],
                            irreversibleTrajectory: [],
                            recentBuffer: []
                        }
                    ]
                }),
                usage: { inputTokens: 960, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 480 },
                modelId: 'haystack-mock'
            };
        }

        // 3. Step: Librarian
        if (
            req.pool === 'fast_retrieval' &&
            (staticText.includes('Librarian') ||
                staticText.includes('图书管理员') ||
                tail.includes('可用实体档案列表'))
        ) {
            return {
                text: JSON.stringify({
                    selected_entity_ids: ['char_shenyan', 'char_linmo'],
                    recall_queries: [],
                    selected_lore_files: ['lore_old_harbor']
                }),
                usage: { inputTokens: 280, cacheReadTokens: 720, cacheWriteTokens: 0, outputTokens: 75 },
                modelId: 'haystack-mock'
            };
        }

        // 4. Step: Writer 正文 (必须在 Planner 之前匹配，因为 Writer 的 tail 含 "本章执笔细纲")
        if (req.pool === 'strong_creative' && tail.includes('本章执笔细纲')) {
            const ch = Math.max(1, plannedChapter);
            return {
                text: buildHaystackChapterProse(ch, targetChapters),
                usage: { inputTokens: 380, cacheReadTokens: 1420, cacheWriteTokens: 0, outputTokens: 310 },
                modelId: 'haystack-mock'
            };
        }

        // 5. Step: Planner
        if (req.pool === 'strong_creative') {
            plannedChapter += 1;
            return {
                text: JSON.stringify({
                    chapter_title: `第${plannedChapter}章 雾港循迹`,
                    target_word_count: 1000,
                    focus_cast: ['char_shenyan', 'char_linmo'],
                    background_cast: [],
                    ending_beat: 'HOOK',
                    scene_plan: [
                        {
                            scene_index: 1,
                            location: '旧港栈桥',
                            summary: `第 ${plannedChapter} 章推进调查并严格保持既有设定红线。`,
                            is_spotlight: true
                        }
                    ],
                    outline_text: `第 ${plannedChapter} 章由沈砚与林默沿线索排查现场，记录关键物证。`
                }),
                usage: { inputTokens: 420, cacheReadTokens: 1180, cacheWriteTokens: 0, outputTokens: 160 },
                modelId: 'haystack-mock'
            };
        }

        // 5. Step: FactChecker
        if (req.pool === 'audit') {
            return {
                text: JSON.stringify({
                    passed: true,
                    issues: []
                }),
                usage: { inputTokens: 450, cacheReadTokens: 950, cacheWriteTokens: 0, outputTokens: 50 },
                modelId: 'haystack-mock'
            };
        }

        // 6. Step: Extractor
        if (req.pool === 'fast_retrieval') {
            const ch = Math.max(1, plannedChapter);
            return {
                text: JSON.stringify({
                    entity_patches: [
                        {
                            entity_id: 'char_shenyan',
                            last_seen_ch: ch,
                            buffer_ops: [
                                {
                                    op: 'append',
                                    entry: {
                                        storyDay: ch,
                                        chapter: ch,
                                        text: `第 ${ch} 章完成现场勘查`
                                    }
                                },
                                {
                                    op: 'trim_buffer',
                                    max_entries: 4
                                }
                            ]
                        }
                    ],
                    story_day_delta: 1,
                    chapter_summary: `第 ${ch} 章推进调查。`
                }),
                usage: { inputTokens: 320, cacheReadTokens: 680, cacheWriteTokens: 0, outputTokens: 110 },
                modelId: 'haystack-mock'
            };
        }

        // 7. Step: Writer 正文
        const ch = Math.max(1, plannedChapter);
        return {
            text: buildHaystackChapterProse(ch, targetChapters),
            usage: { inputTokens: 380, cacheReadTokens: 1420, cacheWriteTokens: 0, outputTokens: 310 },
            modelId: 'haystack-mock'
        };
    };

    const adapter = new ScriptedLlmAdapter();
    // 2 (boot) + targetChapters * 5 (Librarian, Planner, Writer, FactChecker, Extractor) + 余量
    const totalCalls = 10 + targetChapters * 6;
    for (let i = 0; i < totalCalls; i += 1) {
        adapter.enqueue(responder);
    }
    return adapter;
}

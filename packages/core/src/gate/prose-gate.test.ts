import { describe, expect, it } from 'vitest';
import {
    StaticProseGate,
    computeKontoyiannisEntropy,
    computeMattr500,
    computeSentenceLengthCv,
    computeTelemetry,
    extractConcreteSimiles,
    stripBlockingTags,
    verifyDualQuotes
} from './index.js';

describe('stripBlockingTags', () => {
    it('能够剥离头部及文中的 blocking 标签并返回纯净正文与思考内容', () => {
        const raw = [
            '<blocking>',
            '第一步：先分析角色情绪和场景节奏。',
            '第二步：确定不要使用八股词汇。',
            '</blocking>',
            '',
            '雨点砸在铁皮棚上，发出密集的脆响。',
            '<blocking>局部衔接确认</blocking>陈默把钥匙丢上桌面。'
        ].join('\n');

        const result = stripBlockingTags(raw);

        expect(result.strippedCount).toBe(2);
        expect(result.hasUnclosedTag).toBe(false);
        expect(result.blockingContents).toEqual([
            '第一步：先分析角色情绪和场景节奏。\n第二步：确定不要使用八股词汇。',
            '局部衔接确认'
        ]);
        expect(result.cleanText).not.toContain('<blocking>');
        expect(result.cleanText).not.toContain('</blocking>');
        expect(result.cleanText).toContain('雨点砸在铁皮棚上，发出密集的脆响。');
        expect(result.cleanText).toContain('陈默把钥匙丢上桌面。');
    });

    it('能够识别未闭合的 blocking 标签', () => {
        const raw = '<blocking>未闭合的推理过程\n正文内容';
        const result = stripBlockingTags(raw);

        expect(result.hasUnclosedTag).toBe(true);
    });
});

describe('StaticProseGate', () => {
    it('能够检出八股配额超限、微距人体套话、否定对比句与末段说教并给出精确行号', () => {
        const draft = [
            '他站在窗前，指节泛白。',
            '这不是愤怒，而是失望。',
            '她没有说话，只是锁骨微动，锁骨上的旧疤还在。',
            '他下意识地往后退了一步，声音不大却透着寒意，某种难以言喻的情绪在蔓延。',
            '那一刻，命运的齿轮开始转动。'
        ].join('\n');

        const gate = new StaticProseGate();
        const result = gate.evaluate(draft, {
            rules: {
                micro_anatomy: { enabled: true, maxCount: 0 },
                negation_contrast: { enabled: true, maxCount: 0 },
                skeletal_quota: { enabled: true, maxCount: 1 },
                filler_cliche: { enabled: true, maxCount: 1 },
                ending_moralizing: { enabled: true, maxCount: 0 }
            }
        });

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.ruleId === 'micro_anatomy' && v.line === 1)).toBe(true);
        expect(result.violations.some((v) => v.ruleId === 'negation_contrast' && v.line === 2)).toBe(true);
        expect(result.violations.some((v) => v.ruleId === 'skeletal_quota' && v.line === 3)).toBe(true);
        expect(result.violations.some((v) => v.ruleId === 'filler_cliche' && v.line === 4)).toBe(true);
        expect(result.violations.some((v) => v.ruleId === 'ending_moralizing' && v.line === 5)).toBe(true);
        expect(result.violatedParagraphCount).toBe(5);
        expect(result.recommendedAction).toBe('REWRITE');
    });

    it('支持按规则开关关闭特定检查', () => {
        const draft = '他站在窗前，指节泛白。\n他下意识地看了一眼门外。';
        const gate = new StaticProseGate();

        const disabledResult = gate.evaluate(draft, {
            enableAntiCliche: false,
            rules: {
                micro_anatomy: { enabled: false },
                filler_cliche: { enabled: false }
            }
        });

        expect(disabledResult.passed).toBe(true);
        expect(disabledResult.violations).toHaveLength(0);
        expect(disabledResult.recommendedAction).toBe('PASS');
    });

    it('能够分别检出 deictic_na、reduplication_verb 与零容忍 filler_trace，且常规“拿了钥匙/吃了一惊”零误杀', () => {
        const cleanDraft = '他拿了钥匙就出门，推开铁门时却吃了一惊。';
        const gate = new StaticProseGate();
        const cleanResult = gate.evaluate(cleanDraft);

        expect(cleanResult.passed).toBe(true);
        expect(cleanResult.ruleCounts.reduplication_verb).toBe(0);

        const traceDraft = '她的眼底闪过一丝冷意。';
        const traceResult = gate.evaluate(traceDraft);
        expect(traceResult.passed).toBe(false);
        expect(traceResult.violations.some((v) => v.ruleId === 'filler_trace' && v.matchedText === '一丝')).toBe(true);

        const denseDraft = [
            '那张桌子摆在角落，那双眼睛盯着那抹微光。',
            '他看了看手表，顿了顿脚步，想了想还是推开了门。'
        ].join('\n');
        const denseResult = gate.evaluate(denseDraft);
        expect(denseResult.passed).toBe(false);
        expect(denseResult.violations.some((v) => v.ruleId === 'deictic_na')).toBe(true);
        expect(denseResult.violations.some((v) => v.ruleId === 'reduplication_verb')).toBe(true);
    });

    it('extractConcreteSimiles 能在“像XX一样动作”处截断并精确匹配跨章复读', () => {
        const extracted = extractConcreteSimiles('纸片像白鸽翅膀一样轻轻扑腾。');
        expect(extracted).toHaveLength(1);
        expect(extracted[0]?.vehicle).toBe('白鸽翅膀');

        const gate = new StaticProseGate();
        const result = gate.evaluate('火苗像白鸽翅膀一样翻卷着升向屋顶。', {
            enableCrossChapterSimile: true,
            historicalChapters: [
                { chapter: 1, text: '窗帘被风吹得像白鸽翅膀一样轻轻扑腾。' }
            ]
        });

        expect(result.passed).toBe(false);
        expect(result.violations.some((v) => v.ruleId === 'cross_chapter_simile')).toBe(true);
    });

    it('能够检出末段“那一刻”升华与未闭合 blocking 标签残留', () => {
        const gate = new StaticProseGate();
        const moralResult = gate.evaluate('第一段正常描写。\n那一刻，他决定不再回头。');
        expect(moralResult.passed).toBe(false);
        expect(moralResult.violations.some((v) => v.ruleId === 'ending_moralizing')).toBe(true);

        const unclosedResult = gate.evaluate('<blocking>未闭合思考\n正文内容');
        expect(unclosedResult.passed).toBe(false);
        expect(unclosedResult.violations.some((v) => v.ruleId === 'tag_residue')).toBe(true);
    });

    it('能够检出跨章明喻/喻体复读并定位精确行号，且 <= 2 段违规判定为 PATCH', () => {
        const historicalChapters = [
            { chapter: 1, text: '铁门关上的声音，如同生锈的闸刀劈进木桩。' },
            { chapter: 2, text: '巷口的路灯亮着。' }
        ];
        const currentDraft = [
            '夜风吹过铁皮棚，发出低沉的哨音。',
            '',
            '他推开仓库的门，门轴摩擦的声响如同生锈的闸刀，刺得耳膜生疼。',
            '',
            '桌上放着半杯冷茶。'
        ].join('\n');

        const gate = new StaticProseGate();
        const result = gate.evaluate(currentDraft, {
            enableCrossChapterSimile: true,
            crossChapterSimileWindow: 5,
            historicalChapters
        });

        expect(result.passed).toBe(false);
        const simileViolation = result.violations.find((v) => v.ruleId === 'cross_chapter_simile');
        expect(simileViolation).toBeDefined();
        expect(simileViolation?.line).toBe(3);
        expect(simileViolation?.paragraphIndex).toBe(1);
        expect(result.violatedParagraphCount).toBe(1);
        expect(result.recommendedAction).toBe('PATCH');
    });

    it('关闭跨章明喻开关时不报跨章喻体复读', () => {
        const gate = new StaticProseGate();
        const result = gate.evaluate('门声如同生锈的闸刀。', {
            enableCrossChapterSimile: false,
            historicalSimiles: ['生锈的闸刀']
        });

        expect(result.violations.some((v) => v.ruleId === 'cross_chapter_simile')).toBe(false);
    });
});

describe('verifyDualQuotes', () => {
    const textA = [
        '第一章 码头',
        '陈默左手拎着黑皮箱，',
        '右肩的旧伤在雨夜里隐隐作痛。',
        '他把烟按灭在铁桶边缘。'
    ].join('\n');

    const textB = [
        '第三章 对峙',
        '林岚盯着桌上的照片问道：“你左手不是断过吗？”',
        '陈默没有接话。'
    ].join('\n');

    it('双侧原句去除标点与空白后均存在时返回通过并给出各自精确行号', () => {
        const result = verifyDualQuotes(
            '陈默左手拎着黑皮箱右肩的旧伤在雨夜里隐隐作痛',
            textA,
            '你左手不是断过吗',
            textB
        );

        expect(result.passed).toBe(true);
        expect(result.sideA.matched).toBe(true);
        expect(result.sideA.startLine).toBe(2);
        expect(result.sideA.endLine).toBe(3);
        expect(result.sideB.matched).toBe(true);
        expect(result.sideB.startLine).toBe(2);
    });

    it('任意一侧存在捏造单字差异时 100% 拒止', () => {
        const result = verifyDualQuotes(
            '陈默右手拎着黑皮箱',
            textA,
            '你左手不是断过吗',
            textB
        );

        expect(result.passed).toBe(false);
        expect(result.sideA.matched).toBe(false);
        expect(result.sideA.lineNumber).toBeNull();
        expect(result.sideB.matched).toBe(true);
    });

    it('空引文不得绕过验真', () => {
        const result = verifyDualQuotes('   ...   ', textA, '你左手不是断过吗', textB);

        expect(result.passed).toBe(false);
        expect(result.sideA.matched).toBe(false);
    });
});

describe('零依赖语言退化遥测', () => {
    const naturalText = [
        '凌晨四点，码头起了一层薄雾。老周蹲在缆绳桩旁，把半截旱烟在鞋底磕灭。',
        '江面传来拖轮低沉的汽笛声，震得铁皮棚顶的积水往下滴答。',
        '“船还要多久靠岸？”小刘裹紧了棉大衣，哈出一口白气。',
        '“快了。”老周抬眼望向灯塔方向，“先把三号仓的锁撬开，里面的货不能沾潮气。”',
        '两人踩着湿滑的青石板往仓库走去，脚步一深一浅。',
        '仓库角落堆着十几个贴了封条的木箱，封条上的朱砂印已经褪成暗褐色。',
        '小刘从工具包里摸出撬棍，刚插进箱缝，门外忽然响起一阵急促的自行车铃声。',
        '卖早点的阿婆推着煤炉车从巷口拐出来，锅里的豆浆正冒着热气。'
    ].join('\n');

    const degradedText = Array.from(
        { length: 24 },
        () => '他站在那里，心中涌起某种难以言喻的情绪，指节泛白，命运的齿轮开始转动。'
    ).join('\n');

    it('MATTR-500 在短文本和长文本下均能计算有效 TTR，且自然文本显著高于重复退化语料', () => {
        const longNatural = Array.from({ length: 12 }, (_, idx) => `${naturalText} 第${idx + 1}段补充细节：铁锁、煤油灯、潮汐、账本、棉被、风声。`).join('\n');
        const longDegraded = Array.from({ length: 40 }, () => '他站在那里，心中涌起某种难以言喻的情绪，指节泛白。').join('\n');

        const mattrNatural = computeMattr500(longNatural);
        const mattrDegraded = computeMattr500(longDegraded);

        expect(mattrNatural).toBeGreaterThan(0);
        expect(mattrNatural).toBeLessThanOrEqual(1);
        expect(mattrDegraded).toBeGreaterThan(0);
        expect(mattrNatural).toBeGreaterThan(mattrDegraded);

        // 短于 500 词时退化为全段 TTR
        const shortMattr = computeMattr500('苹果 香蕉 橘子 苹果');
        expect(shortMattr).toBeCloseTo(3 / 4, 5);
    });

    it('Kontoyiannis 非参数熵率在自然文本与重复退化语料之间呈现严格单调区分', () => {
        const hkNatural = computeKontoyiannisEntropy(naturalText);
        const hkDegraded = computeKontoyiannisEntropy(degradedText);

        expect(hkNatural).toBeGreaterThan(0);
        expect(hkDegraded).toBeGreaterThan(0);
        expect(hkNatural).toBeGreaterThan(hkDegraded * 1.5);
    });

    it('句段长变异系数 CV 能区分长短句交错文本与等长重复句文本', () => {
        const cvNatural = computeSentenceLengthCv(naturalText);
        const cvDegraded = computeSentenceLengthCv(degradedText);

        expect(cvNatural).toBeGreaterThan(0.2);
        expect(cvDegraded).toBeCloseTo(0, 5);
        expect(cvNatural).toBeGreaterThan(cvDegraded);
    });

    it('computeTelemetry 汇总四联指标并准确计算 AI 八股千字命中密度', () => {
        const telemetryNatural = computeTelemetry(naturalText);
        const telemetryDegraded = computeTelemetry(degradedText);

        expect(telemetryNatural.mattr500).toBeGreaterThan(telemetryDegraded.mattr500);
        expect(telemetryNatural.kontoyiannisEntropy).toBeGreaterThan(telemetryDegraded.kontoyiannisEntropy);
        expect(telemetryNatural.sentenceLengthCv).toBeGreaterThan(telemetryDegraded.sentenceLengthCv);
        expect(telemetryDegraded.clicheDensityPer1k).toBeGreaterThan(telemetryNatural.clicheDensityPer1k);
        expect(telemetryDegraded.clicheDensityPer1k).toBeGreaterThan(20);
    });
});

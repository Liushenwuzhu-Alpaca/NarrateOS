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
    it('自然段内多行违规共用段号，空白行才开始下一段', () => {
        const result = new StaticProseGate().evaluate('雨落在窗沿。\n<!--内部说明-->\n\n门开了。', { enableAntiCliche: false });
        expect(result.violatedParagraphIndices).toEqual([0]);
        expect(result.violations[0]).toMatchObject({ line: 2, paragraphIndex: 0 });
    });

    it('跨行 HTML 注释按全文检出并保留准确起始行列', () => {
        const gate = new StaticProseGate();
        const result = gate.evaluate('雨落在窗沿。\n\n<!--\n内部工程说明\n-->\n\n门开了。', { enableAntiCliche: false });
        expect(result.passed).toBe(false);
        expect(result.violations).toEqual(expect.arrayContaining([
            expect.objectContaining({ ruleId: 'tag_residue', line: 3, column: 1, matchedText: '<!--\n内部工程说明\n-->' })
        ]));
    });

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
        expect(result.violatedParagraphCount).toBe(1);
        // 整段文本仅 1 个非空自然段且违规，占比 1/1 (100% > 默认 60%)，建议整章重写
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

describe('StaticProseGate 跨行注释定位与第一人称豁免', () => {
    it('跨行 <!-- ... --> 注释无论是否紧接空白行，均映射非负 paragraphIndex 与精确 1-based 行列并触发 PATCH/REWRITE', () => {
        const gate = new StaticProseGate();

        const afterBlank = [
            '码头起雾了。',
            '',
            '  <!--',
            '内部草稿注释',
            '-->',
            '',
            '他提着灯往前走。'
        ].join('\n');
        const res1 = gate.evaluate(afterBlank, { enableAntiCliche: false });
        expect(res1.passed).toBe(false);
        expect(res1.recommendedAction).toBe('PATCH');
        expect(res1.violatedParagraphIndices).toEqual([1]);
        expect(res1.violations[0]).toMatchObject({
            ruleId: 'tag_residue',
            line: 3,
            column: 3,
            paragraphIndex: 1
        });

        // 即使自定义 tag_residue 正则以换行空白行起始，也必须回落至最近非空段落（非负索引）
        const resCustom = gate.evaluate('码头起雾了。\n\n<!--\n注释\n-->\n\n灯灭了。', {
            enableAntiCliche: false,
            rules: {
                tag_residue: {
                    enabled: true,
                    maxCount: 0,
                    patterns: [/\n<!--[\s\S]*?-->/g]
                }
            }
        });
        expect(resCustom.passed).toBe(false);
        expect(resCustom.violations[0]?.line).toBe(2);
        expect(resCustom.violations[0]?.column).toBe(1);
        expect(resCustom.violations[0]?.paragraphIndex).toBeGreaterThanOrEqual(0);
        expect(resCustom.violatedParagraphCount).toBe(1);
        expect(resCustom.recommendedAction).toBe('PATCH');
    });

    it('objective_third 拦截主观评判与先否决对比，subjective_first 自动豁免并保留硬底线规则', () => {
        const gate = new StaticProseGate();
        const firstPersonProse = [
            '在我看来，这桩买卖从头到尾都透着一股寒酸气。',
            '这不是胆怯，而是权衡利弊后的退让；这不是客套，而是彼此留一线。',
            '老实说，屋里的气氛顿时缓和下来。'
        ].join('\n');

        const thirdRes = gate.evaluate(firstPersonProse, {
            narrationSubjectivity: 'objective_third'
        });
        expect(thirdRes.passed).toBe(false);
        expect(thirdRes.exceededRules).toContain('subjective_judgment');
        expect(thirdRes.exceededRules).toContain('negation_contrast');

        const firstRes = gate.evaluate(firstPersonProse, {
            narrationSubjectivity: 'subjective_first'
        });
        expect(firstRes.passed).toBe(true);
        expect(firstRes.ruleCounts.subjective_judgment).toBe(0);
        expect(firstRes.ruleCounts.negation_contrast).toBe(0);

        // 显式在 options.rules 覆盖时仍生效
        const overriddenFirstRes = gate.evaluate(firstPersonProse, {
            narrationSubjectivity: 'subjective_first',
            rules: {
                negation_contrast: { enabled: true, maxCount: 0 }
            }
        });
        expect(overriddenFirstRes.passed).toBe(false);
        expect(overriddenFirstRes.exceededRules).toContain('negation_contrast');

        // subjective_first 依然严查 tag_residue、micro_anatomy、ending_moralizing 与陈腐比喻
        const dirtyFirstPerson = [
            '<!--内部注释-->',
            '我盯着他的喉结上下滚动，心里像被按下了暂停键，他就像精密运转的机器。',
            '那一刻，我终于明白命运的齿轮开始转动。'
        ].join('\n');
        const dirtyRes = gate.evaluate(dirtyFirstPerson, {
            narrationSubjectivity: 'subjective_first'
        });
        expect(dirtyRes.passed).toBe(false);
        expect(dirtyRes.exceededRules).toEqual(
            expect.arrayContaining(['tag_residue', 'micro_anatomy', 'filler_cliche', 'ending_moralizing'])
        );
    });
});

describe('StaticProseGate 阈值边界、微距距离与跨章喻体章节计数 (ISS-032, ISS-033)', () => {
    const buildParagraphDraft = (totalParagraphs: number, violatedCount: number): string => {
        const paragraphs: string[] = [];
        for (let i = 0; i < totalParagraphs; i += 1) {
            if (i < violatedCount) {
                paragraphs.push(`第${i + 1}段他指节泛白，站在门口没动。`);
            } else {
                paragraphs.push(`第${i + 1}段码头风声很轻，灯影落在青石板上。`);
            }
        }
        return paragraphs.join('\n\n');
    };

    it('默认 maxPatchParagraphs=15 与 maxPatchParagraphRatio=0.6 边界及显式覆盖生效', () => {
        const gate = new StaticProseGate();

        // 30 段中 15 段违规：15 <= 15 且 15/30 (0.5) <= 0.6 -> PATCH
        const patchAt15 = gate.evaluate(buildParagraphDraft(30, 15));
        expect(patchAt15.passed).toBe(false);
        expect(patchAt15.violatedParagraphCount).toBe(15);
        expect(patchAt15.recommendedAction).toBe('PATCH');

        // 30 段中 16 段违规：16 > 15（即使 16/30 ≈ 0.533 <= 0.6）-> REWRITE
        const rewriteAt16 = gate.evaluate(buildParagraphDraft(30, 16));
        expect(rewriteAt16.passed).toBe(false);
        expect(rewriteAt16.violatedParagraphCount).toBe(16);
        expect(rewriteAt16.recommendedAction).toBe('REWRITE');

        // 5 段中 3 段违规：3 <= 15 且 3/5 (0.6) <= 0.6 -> PATCH
        const patchAt60Percent = gate.evaluate(buildParagraphDraft(5, 3));
        expect(patchAt60Percent.violatedParagraphCount).toBe(3);
        expect(patchAt60Percent.recommendedAction).toBe('PATCH');

        // 5 段中 4 段违规：4 <= 15 但 4/5 (0.8) > 0.6 -> REWRITE
        const rewriteAbove60Percent = gate.evaluate(buildParagraphDraft(5, 4));
        expect(rewriteAbove60Percent.violatedParagraphCount).toBe(4);
        expect(rewriteAbove60Percent.recommendedAction).toBe('REWRITE');

        // 显式传入 options.maxPatchParagraphs 与 options.maxPatchParagraphRatio 覆盖默认值
        const customMaxCount = gate.evaluate(buildParagraphDraft(10, 3), {
            maxPatchParagraphs: 2
        });
        expect(customMaxCount.recommendedAction).toBe('REWRITE');

        const customMaxRatio = gate.evaluate(buildParagraphDraft(5, 4), {
            maxPatchParagraphRatio: 0.9
        });
        expect(customMaxRatio.recommendedAction).toBe('PATCH');
    });

    it('micro_anatomy 支持通配距离匹配指节与喉结套话且严禁跨换行误匹配', () => {
        const gate = new StaticProseGate();

        const hitResult = gate.evaluate('他攥紧茶杯，指节因用力而泛白，喉结微微滚动。');
        expect(hitResult.passed).toBe(false);
        const microHits = hitResult.violations.filter((v) => v.ruleId === 'micro_anatomy');
        expect(microHits.map((v) => v.matchedText)).toEqual(['指节因用力而泛白', '喉结微微滚动']);

        const multilineClean = gate.evaluate('他低头看着指节\n泛白的手背，喉结\n滚动了一下。');
        expect(multilineClean.ruleCounts.micro_anatomy).toBe(0);
        expect(multilineClean.violations.some((v) => v.ruleId === 'micro_anatomy')).toBe(false);
    });

    it('cross_chapter_simile 第 1 章零历史章内首尾呼应不误报，第 2 章跨章复现才报错且按历史章节去重计数', () => {
        const gate = new StaticProseGate();

        // 第 1 章零历史章节，章首与章尾各出现 1 次同一喻体呼应 -> 零违规
        const ch1Text = [
            '铁门合拢时，门轴发出像生锈的闸刀一样的闷响。',
            '',
            '夜雨下得越发急促，巷口无人经过。',
            '',
            '他反手扣上门闩，耳畔仿佛又响起那声像生锈的闸刀一样的刮擦。'
        ].join('\n');

        const ch1Res = gate.evaluate(ch1Text, {
            enableCrossChapterSimile: true,
            historicalChapters: []
        });
        expect(ch1Res.passed).toBe(true);
        expect(ch1Res.ruleCounts.cross_chapter_simile).toBe(0);

        // 第 2 章出现同一喻体 -> historicalChapterCount=1，跨章复现报错
        const ch2Text = '仓库铁卷帘落下，声音像生锈的闸刀一样刺耳。';
        const ch2Res = gate.evaluate(ch2Text, {
            enableCrossChapterSimile: true,
            historicalChapters: [{ chapter: 1, text: ch1Text }]
        });
        expect(ch2Res.passed).toBe(false);
        expect(ch2Res.exceededRules).toContain('cross_chapter_simile');
        expect(ch2Res.ruleCounts.cross_chapter_simile).toBe(1);

        // 第 1 章出现 2 次只计为 1 个历史章节：若上限设为 2 章，第 2 章合计 2 章仍放行，第 3 章（合计 3 章）才拦截
        const ch2AllowedWithMax2 = gate.evaluate(ch2Text, {
            enableCrossChapterSimile: true,
            crossChapterSimileMaxTotal: 2,
            historicalChapters: [{ chapter: 1, text: ch1Text }]
        });
        expect(ch2AllowedWithMax2.violations.some((v) => v.ruleId === 'cross_chapter_simile')).toBe(false);

        const ch3RejectedWithMax2 = gate.evaluate('风刮过铁皮，像生锈的闸刀一样刮着木框。', {
            enableCrossChapterSimile: true,
            crossChapterSimileMaxTotal: 2,
            historicalChapters: [
                { chapter: 1, text: ch1Text },
                { chapter: 2, text: ch2Text }
            ]
        });
        expect(ch3RejectedWithMax2.violations.some((v) => v.ruleId === 'cross_chapter_simile')).toBe(true);
    });
});

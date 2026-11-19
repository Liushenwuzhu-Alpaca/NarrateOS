import { expect, it } from 'vitest';
import { verifyDualQuotes } from './quote-verifier.js';
import { StaticProseGate } from './static-prose-gate.js';
import { computeKontoyiannisEntropy, computeMattr500, computeTelemetry } from './telemetry.js';

it('引文不能修改符号、小数点或截取部分数字', () => {
    expect(verifyDualQuotes('余额10', '余额-10', '重15', '重1.5').passed).toBe(false);
    expect(verifyDualQuotes('10', '-10', '1', '1.5').passed).toBe(false);
    expect(verifyDualQuotes('余额 -10', '余额：-10', '重1.5', '重 1.5。').passed).toBe(true);
});

it('标签残留涵盖未闭合注释，末段规则跳过标题与范围外文本', () => {
    const gate = new StaticProseGate();
    expect(gate.evaluate('# 标题\n\n文本<!--注释').passed).toBe(false);
    expect(gate.evaluate('# 标题\n\n<!--注释-->\n\n结尾', { rules: { tag_residue: { lastParagraphsOnly: 1 } } }).passed).toBe(true);
    const result = gate.evaluate('# 标题\n\n命中\n \n结尾', { rules: { custom: { patterns: [/命中|^ $/g, /命中/g] } } });
    expect(result.ruleCounts.custom).toBe(2);
    expect(result.violatedParagraphIndices).toEqual([1, 2]);
});

it('句长与句数使用相同分句边界，非法窗口不产生 NaN', () => {
    expect(computeTelemetry('“走吧。”')).toMatchObject({ sentenceCount: 1, sentenceLengthCv: 0 });
    expect(computeTelemetry('Go. Wait here for me.').sentenceLengthCv).toBeGreaterThan(0);
    for (const window of [0, -1, NaN, 0.5]) expect(() => computeMattr500('甲乙', window)).toThrow(RangeError);
});

it('历史匹配不得与自身重叠，重复文本与穷举结果一致', () => {
    for (let bits = 0; bits < 256; bits++) {
        const s = bits.toString(2).padStart(8, '0');
        let sum = 0;
        for (let i = 1; i < s.length; i++) {
            let n = 0;
            while (i + n < s.length && s.slice(0, i).includes(s.slice(i, i + n + 1))) n++;
            sum += (n + 1) / Math.log2(i + 1);
        }
        expect(computeKontoyiannisEntropy(s)).toBeCloseTo((s.length - 1) / sum, 12);
    }
    expect(computeKontoyiannisEntropy('甲'.repeat(50000))).toBeGreaterThan(0);
});

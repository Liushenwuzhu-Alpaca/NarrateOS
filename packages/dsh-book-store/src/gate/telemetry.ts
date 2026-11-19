import { DEFAULT_CLICHE_TERMS, escapeRegExp } from './rules.js';
import type { TelemetryMetrics, TelemetryOptions } from './types.js';

const ZH_WORD_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

/**
 * 使用 Node 原生 Intl.Segmenter 分词并过滤标点与空白
 */
export function segmentWords(text: string): string[] {
    const words: string[] = [];
    for (const seg of ZH_WORD_SEGMENTER.segment(text)) {
        if (seg.isWordLike) {
            words.push(seg.segment.toLowerCase());
        }
    }
    return words;
}

/**
 * 计算滑动窗口 MATTR-500 词汇丰富度（短于窗口时退化为全段 TTR）
 */
export function computeMattr500(text: string, windowSize = 500): number {
    return wordMattr(segmentWords(text), windowSize);
}

function wordMattr(words: string[], windowSize = 500): number {
    if (!Number.isSafeInteger(windowSize) || windowSize <= 0) throw new RangeError('MATTR 窗口必须是正整数');
    const totalWords = words.length;
    if (totalWords === 0) {
        return 0;
    }

    if (totalWords <= windowSize) {
        return new Set(words).size / totalWords;
    }

    const freq = new Map<string, number>();
    for (let i = 0; i < windowSize; i += 1) {
        const word = words[i];
        if (word !== undefined) {
            freq.set(word, (freq.get(word) ?? 0) + 1);
        }
    }

    let ttrSum = freq.size / windowSize;
    const windowCount = totalWords - windowSize + 1;

    for (let i = windowSize; i < totalWords; i += 1) {
        const outWord = words[i - windowSize];
        const inWord = words[i];

        if (outWord !== undefined) {
            const count = (freq.get(outWord) ?? 0) - 1;
            if (count <= 0) {
                freq.delete(outWord);
            } else {
                freq.set(outWord, count);
            }
        }

        if (inWord !== undefined) {
            freq.set(inWord, (freq.get(inWord) ?? 0) + 1);
        }

        ttrSum += freq.size / windowSize;
    }

    return ttrSum / windowCount;
}

/**
 * 基于 Lempel-Ziv 最长匹配长度计算 Kontoyiannis 非参数熵率 H_K
 */
export function computeKontoyiannisEntropy(text: string): number {
    const chars = Array.from(text.replace(/\s+/g, ''));
    const n = chars.length;
    if (n < 2) {
        return 0;
    }

    // 后缀自动机：同一状态的子串共享结束位置集合，最早结束位置决定能否在历史中完整找到。
    type State = { length: number; link: number; firstEnd: number; next: Map<string, number> };
    const states: State[] = [{ length: 0, link: -1, firstEnd: -1, next: new Map() }];
    let last = 0;
    for (const [end, char] of chars.entries()) {
        const cur = states.length;
        states.push({ length: end + 1, link: 0, firstEnd: end, next: new Map() });
        let p = last;
        while (p >= 0 && !states[p]!.next.has(char)) {
            states[p]!.next.set(char, cur);
            p = states[p]!.link;
        }
        if (p >= 0) {
            const q = states[p]!.next.get(char)!;
            if (states[p]!.length + 1 === states[q]!.length) states[cur]!.link = q;
            else {
                const clone = states.length;
                states.push({ ...states[q]!, length: states[p]!.length + 1, next: new Map(states[q]!.next) });
                states[q]!.link = states[cur]!.link = clone;
                while (p >= 0 && states[p]!.next.get(char) === q) {
                    states[p]!.next.set(char, clone);
                    p = states[p]!.link;
                }
            }
        }
        last = cur;
    }
    // 起点右移后，去掉首字的旧匹配仍然有效，右端无需回退。
    let normalizedMatchSum = 0;
    let state = 0;
    let length = 0;
    for (let start = 1; start < n; start++) {
        while (start + length < n) {
            const next = states[state]!.next.get(chars[start + length]!);
            if (next === undefined || states[next]!.firstEnd >= start) break;
            state = next;
            length++;
        }
        normalizedMatchSum += (length + 1) / Math.log2(start + 1);
        if (length > 0) {
            length--;
            const suffix = states[state]!.link;
            if (states[suffix]!.length === length) state = suffix;
        }
    }

    const avgNormalizedLen = normalizedMatchSum / (n - 1);
    return avgNormalizedLen > 0 ? 1 / avgNormalizedLen : 0;
}

/**
 * 按中英文句末标点与换行切分句段，计算句段长变异系数 (CV = 标准差 / 均值)
 */
export function computeSentenceLengthCv(text: string): number {
    return sentenceCv(sentenceLengths(text));
}

function sentenceLengths(text: string): number[] {
    return text.split(/[。！？!?\r\n]+|\.(?!\d)/u).map((s) => Array.from(s.replace(/[\s“”‘’「」『』"«»]/gu, '')).length).filter(Boolean);
}

function sentenceCv(lengths: number[]): number {
    if (lengths.length < 2) {
        return 0;
    }

    const mean = lengths.reduce((sum, len) => sum + len, 0) / lengths.length;
    if (mean <= 0) {
        return 0;
    }

    const variance =
        lengths.reduce((sum, len) => {
            const diff = len - mean;
            return sum + diff * diff;
        }, 0) / lengths.length;

    return Math.sqrt(variance) / mean;
}

/**
 * 计算 AI 八股千字命中密度（每 1,000 非空白字符命中次数）
 */
export function computeClicheDensity(text: string, clicheTerms: readonly string[] = DEFAULT_CLICHE_TERMS): number {
    const charCount = text.replace(/\s+/g, '').length;
    if (charCount === 0 || clicheTerms.length === 0) {
        return 0;
    }

    const validTerms = clicheTerms.map((t) => t.trim()).filter((t) => t.length > 0);
    if (validTerms.length === 0) {
        return 0;
    }

    const regex = new RegExp(`(${validTerms.map(escapeRegExp).join('|')})`, 'g');
    const matches = text.match(regex);
    const hitCount = matches ? matches.length : 0;

    return (hitCount / charCount) * 1000;
}

/**
 * 汇总计算零模型语言退化四联遥测指标
 */
export function computeTelemetry(text: string, options: TelemetryOptions = {}): TelemetryMetrics {
    const words = segmentWords(text);
    const charCount = text.replace(/\s+/g, '').length;
    const lengths = sentenceLengths(text);

    return {
        charCount,
        wordCount: words.length,
        sentenceCount: lengths.length,
        mattr500: wordMattr(words, options.mattrWindowSize),
        kontoyiannisEntropy: computeKontoyiannisEntropy(text),
        sentenceLengthCv: sentenceCv(lengths),
        clicheDensityPer1k: computeClicheDensity(text, options.clicheTerms)
    };
}

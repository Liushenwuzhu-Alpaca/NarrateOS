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
    const words = segmentWords(text);
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

    const positions = new Map<string, number[]>();
    const firstChar = chars[0];
    if (firstChar !== undefined) {
        positions.set(firstChar, [0]);
    }

    let normalizedMatchSum = 0;

    for (let i = 1; i < n; i += 1) {
        const currentChar = chars[i];
        if (currentChar === undefined) {
            continue;
        }

        const prevIndices = positions.get(currentChar);
        let maxMatchLen = 0;

        if (prevIndices !== undefined) {
            const maxPossible = n - i;
            for (let p = prevIndices.length - 1; p >= 0; p -= 1) {
                const start = prevIndices[p];
                if (start === undefined) {
                    continue;
                }
                let matchLen = 1;
                while (
                    matchLen < maxPossible &&
                    start + matchLen < i &&
                    chars[start + matchLen] === chars[i + matchLen]
                ) {
                    matchLen += 1;
                }
                if (matchLen > maxMatchLen) {
                    maxMatchLen = matchLen;
                    if (maxMatchLen === maxPossible) {
                        break;
                    }
                }
            }
        }

        const shortestUnseenLen = maxMatchLen + 1;
        normalizedMatchSum += shortestUnseenLen / Math.log2(i + 1);

        if (prevIndices === undefined) {
            positions.set(currentChar, [i]);
        } else {
            prevIndices.push(i);
        }
    }

    const avgNormalizedLen = normalizedMatchSum / (n - 1);
    return avgNormalizedLen > 0 ? 1 / avgNormalizedLen : 0;
}

/**
 * 按中英文句末标点与换行切分句段，计算句段长变异系数 (CV = 标准差 / 均值)
 */
export function computeSentenceLengthCv(text: string): number {
    const sentences = text
        .split(/[。！？!?\r\n]+/)
        .map((s) => s.replace(/\s+/g, ''))
        .filter((s) => s.length > 0);

    if (sentences.length < 2) {
        return 0;
    }

    const lengths = sentences.map((s) => Array.from(s).length);
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
    const sentenceCount = text
        .split(/[。！？!?\r\n]+/)
        .map((s) => s.replace(/\s+/g, ''))
        .filter((s) => s.length > 0).length;

    return {
        charCount,
        wordCount: words.length,
        sentenceCount,
        mattr500: computeMattr500(text, options.mattrWindowSize),
        kontoyiannisEntropy: computeKontoyiannisEntropy(text),
        sentenceLengthCv: computeSentenceLengthCv(text),
        clicheDensityPer1k: computeClicheDensity(text, options.clicheTerms)
    };
}

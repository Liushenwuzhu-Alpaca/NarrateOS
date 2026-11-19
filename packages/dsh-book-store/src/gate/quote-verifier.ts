import type { DualQuoteVerificationResult, QuoteVerificationSide } from './types.js';

const QUOTE_TOKEN = /[+\-]?(?:\d+(?:\.\d+)?|\.\d+)%?|[^\p{P}\p{S}\s\d]+/gu;

/**
 * 去除标点、符号与空白并统一小写，用于双侧原句归一化比对
 */
export function normalizeForQuoteMatch(text: string): string {
    return (text.normalize('NFKC').replace(/\s+/gu, '').replace(/−/g, '-').match(QUOTE_TOKEN) ?? []).join('').toLowerCase();
}

function verifySingleQuote(quote: string, sourceText: string): QuoteVerificationSide {
    const normalizedQuote = normalizeForQuoteMatch(quote);
    if (normalizedQuote.length === 0) {
        return {
            matched: false,
            lineNumber: null,
            startLine: null,
            endLine: null,
            normalizedQuote
        };
    }

    const lines = sourceText.split(/\r?\n/);
    const charToLine: number[] = [];
    const normalizedChunks: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
        const lineNumber = i + 1;
        const normalizedLine = normalizeForQuoteMatch(lines[i] ?? '');
        if (normalizedLine.length === 0) {
            continue;
        }
        normalizedChunks.push(normalizedLine);
        for (let k = 0; k < normalizedLine.length; k += 1) {
            charToLine.push(lineNumber);
        }
    }

    const normalizedSource = normalizedChunks.join('');
    let matchIndex = normalizedSource.indexOf(normalizedQuote);
    while (matchIndex >= 0) {
        const end = matchIndex + normalizedQuote.length;
        if (!(/^\d/.test(normalizedQuote) && /[\d.+−-]/.test(normalizedSource.charAt(matchIndex - 1))) &&
            !(/\d$/.test(normalizedQuote) && /[\d.%]/.test(normalizedSource.charAt(end)))) break;
        matchIndex = normalizedSource.indexOf(normalizedQuote, matchIndex + 1);
    }
    if (matchIndex === -1) {
        return {
            matched: false,
            lineNumber: null,
            startLine: null,
            endLine: null,
            normalizedQuote
        };
    }

    const startLine = charToLine[matchIndex] ?? null;
    const endLine = charToLine[matchIndex + normalizedQuote.length - 1] ?? startLine;

    return {
        matched: true,
        lineNumber: startLine,
        startLine,
        endLine,
        normalizedQuote
    };
}

/**
 * 双侧原句去标点/空白归一化存在性验真（防止审校幻觉捏造引文触发误报回滚）
 */
export function verifyDualQuotes(
    quoteA: string,
    textA: string,
    quoteB: string,
    textB: string
): DualQuoteVerificationResult {
    const sideA = verifySingleQuote(quoteA, textA);
    const sideB = verifySingleQuote(quoteB, textB);

    return {
        passed: sideA.matched && sideB.matched,
        sideA,
        sideB
    };
}

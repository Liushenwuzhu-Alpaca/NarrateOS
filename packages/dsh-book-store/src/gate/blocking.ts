import type { StripBlockingResult } from './types.js';

const BLOCKING_PAIR_REGEX = /<blocking\b[^>]*>([\s\S]*?)<\/blocking>/gi;
const UNCLOSED_BLOCKING_REGEX = /<\/?blocking\b[^>]*>/i;

/**
 * 剥离 `<blocking>...</blocking>` 思维过程标签，返回纯净正文与被剥离的思考内容。
 */
export function stripBlockingTags(text: string): StripBlockingResult {
    const blockingContents: string[] = [];
    let strippedCount = 0;

    const withoutPairs = text.replace(BLOCKING_PAIR_REGEX, (_match, inner: string) => {
        strippedCount += 1;
        blockingContents.push(inner.trim());
        return '';
    });

    const hasUnclosedTag = UNCLOSED_BLOCKING_REGEX.test(withoutPairs);
    const cleanText = withoutPairs
        .replace(/^\s*\n+/, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();

    return {
        cleanText,
        blockingContents,
        strippedCount,
        hasUnclosedTag
    };
}

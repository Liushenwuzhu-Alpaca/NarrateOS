import { normalizeForQuoteMatch } from '@narrateos/dsh-book-store';

/** 将底牌拆成足以识别原文的子句；冒号前的槽名不是秘密本身。 */
export function extractSubstantiveNormalizedClauses(text: string): string[] {
    const clauses: string[] = [];
    for (const clause of text.split(/[。！？；，,;\n]/)) {
        const colon = clause.search(/[:：]/);
        const candidates = colon > 0 ? [clause, clause.slice(colon + 1)] : [clause];
        for (const candidate of candidates) {
            const normalized = normalizeForQuoteMatch(candidate);
            if (normalized.length >= 10) clauses.push(normalized);
        }
    }
    return clauses;
}

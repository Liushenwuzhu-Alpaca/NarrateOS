import { analyzeParagraphs } from '../text/paragraphs.js';
import { stripBlockingTags } from './blocking.js';
import {
    DEFAULT_CLICHE_TERMS,
    DEFAULT_GATE_RULES,
    escapeRegExp,
    extractConcreteSimiles,
    normalizeSimileVehicle
} from './rules.js';
import type {
    GateRuleConfig,
    GateRuleId,
    GateViolation,
    ProseGateOptions,
    ProseGateResult
} from './types.js';

interface LineMeta {
    lineNumber: number;
    text: string;
    paragraphIndex: number;
}

const ANTI_CLICHE_RULE_IDS = new Set<GateRuleId>([
    'negation_contrast',
    'subjective_judgment',
    'micro_anatomy',
    'skeletal_quota',
    'filler_trace',
    'deictic_na',
    'reduplication_verb',
    'deictic_density',
    'filler_cliche',
    'ending_moralizing'
]);

/** 强主观第一人称视角下默认豁免的主观镜头评判规则 */
const SUBJECTIVE_EXEMPT_RULE_IDS = new Set<GateRuleId>([
    'subjective_judgment',
    'negation_contrast'
]);

type DefaultRuleDef = (typeof DEFAULT_GATE_RULES)[GateRuleId];

function isRuleEnabled(
    ruleId: GateRuleId,
    defaultDef: DefaultRuleDef | undefined,
    overrideCfg: GateRuleConfig | undefined,
    options: ProseGateOptions
): boolean {
    if (overrideCfg?.enabled !== undefined) {
        return overrideCfg.enabled;
    }
    if (options.enableAntiCliche === false && ANTI_CLICHE_RULE_IDS.has(ruleId)) {
        return false;
    }
    if (
        options.narrationSubjectivity === 'subjective_first' &&
        SUBJECTIVE_EXEMPT_RULE_IDS.has(ruleId)
    ) {
        return false;
    }
    return defaultDef?.enabled ?? true;
}

function resolveEffectiveMaxCount(
    maxCount: number,
    scaleByLength: boolean,
    charCount: number,
    referenceChars: number
): number {
    if (maxCount === 0) {
        return 0;
    }
    if (!scaleByLength) {
        return maxCount;
    }
    return Math.max(maxCount, Math.floor((maxCount * charCount) / referenceChars));
}

function resolveRecommendedAction(
    passed: boolean,
    violatedParagraphCount: number,
    violatedParagraphRatio: number,
    maxPatchParagraphs: number,
    maxPatchParagraphRatio: number
): 'PASS' | 'PATCH' | 'REWRITE' {
    if (passed) {
        return 'PASS';
    }
    if (
        violatedParagraphCount <= maxPatchParagraphs &&
        violatedParagraphRatio <= maxPatchParagraphRatio
    ) {
        return 'PATCH';
    }
    return 'REWRITE';
}

function toGlobalRegex(pattern: RegExp): RegExp {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return new RegExp(pattern.source, flags);
}

/** 将跨行匹配定位到非负自然段索引（起始行落在空白行时依次回退至段内或最近非空段落） */
function resolveNonNegativeParagraphIndex(
    lineMetas: LineMeta[],
    startLineIdx: number,
    matchedText: string
): number {
    const clampedIdx = Math.max(0, Math.min(startLineIdx, Math.max(0, lineMetas.length - 1)));
    const startMeta = lineMetas[clampedIdx];
    if (startMeta && startMeta.paragraphIndex >= 0) {
        return startMeta.paragraphIndex;
    }
    const spanLineCount = matchedText.split(/\r?\n/).length;
    for (let offset = 1; offset < spanLineCount; offset++) {
        const innerMeta = lineMetas[clampedIdx + offset];
        if (innerMeta && innerMeta.paragraphIndex >= 0) {
            return innerMeta.paragraphIndex;
        }
    }
    for (let dist = 1; dist < lineMetas.length; dist++) {
        const after = lineMetas[clampedIdx + dist];
        if (after && after.paragraphIndex >= 0) {
            return after.paragraphIndex;
        }
        const before = lineMetas[clampedIdx - dist];
        if (before && before.paragraphIndex >= 0) {
            return before.paragraphIndex;
        }
    }
    return 0;
}

function scanTagResidueHits(
    text: string,
    patterns: RegExp[],
    lineMetas: LineMeta[]
): GateViolation[] {
    const hits: GateViolation[] = [];
    const fallbackLine: LineMeta = { lineNumber: 1, text, paragraphIndex: 0 };

    for (const pattern of patterns) {
        const regex = toGlobalRegex(pattern);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            if (match[0].length === 0) {
                regex.lastIndex += 1;
                continue;
            }
            const prefix = text.slice(0, match.index);
            const startLineIdx = prefix.split('\n').length - 1;
            const actualLine = lineMetas[startLineIdx] ?? fallbackLine;
            hits.push({
                ruleId: 'tag_residue',
                line: actualLine.lineNumber,
                column: match.index - prefix.lastIndexOf('\n'),
                paragraphIndex: resolveNonNegativeParagraphIndex(lineMetas, startLineIdx, match[0]),
                matchedText: match[0],
                lineText: actualLine.text,
                message: `触发规则 tag_residue: "${match[0]}"`
            });
        }
    }

    if (hits.length === 0 && stripBlockingTags(text).hasUnclosedTag) {
        const firstLine = lineMetas[0];
        hits.push({
            ruleId: 'tag_residue',
            line: 1,
            column: 1,
            paragraphIndex: resolveNonNegativeParagraphIndex(lineMetas, 0, '<blocking>'),
            matchedText: '<blocking>',
            lineText: firstLine?.text ?? '',
            message: '检测到未闭合的 <blocking> 标签残留'
        });
    }

    return hits;
}

function scanLineRuleHits(
    ruleId: GateRuleId,
    targetLines: LineMeta[],
    patterns: RegExp[]
): GateViolation[] {
    const hits: GateViolation[] = [];
    for (const lineMeta of targetLines) {
        for (const pattern of patterns) {
            const regex = toGlobalRegex(pattern);
            let match: RegExpExecArray | null;
            while ((match = regex.exec(lineMeta.text)) !== null) {
                if (match[0].length === 0) {
                    regex.lastIndex += 1;
                    continue;
                }
                hits.push({
                    ruleId,
                    line: lineMeta.lineNumber,
                    column: match.index + 1,
                    paragraphIndex: lineMeta.paragraphIndex,
                    matchedText: match[0],
                    lineText: lineMeta.text,
                    message: `触发规则 ${ruleId}: "${match[0]}"`
                });
            }
        }
    }
    return hits;
}

/**
 * 0 Token 静态文风门禁扫描器
 */
export class StaticProseGate {
    /**
     * 对单章正文执行可开关静态规则扫描与跨章明喻复读检测
     */
    evaluate(text: string, options: ProseGateOptions = {}): ProseGateResult {
        const segmentation = analyzeParagraphs(text);
        const lineMetas = segmentation.lines;
        const charCount = text.replace(/\s+/g, '').length;
        const maxPatchParagraphs = options.maxPatchParagraphs ?? 15;
        const maxPatchParagraphRatio = options.maxPatchParagraphRatio ?? 0.6;

        const violations: GateViolation[] = [];
        const exceededRules: GateRuleId[] = [];
        const ruleCounts: Record<string, number> = {};

        // 1. 扫描常规正则/词表规则
        const ruleIds = new Set<GateRuleId>([
            ...(Object.keys(DEFAULT_GATE_RULES) as GateRuleId[]),
            ...(options.rules ? (Object.keys(options.rules) as GateRuleId[]) : [])
        ]);

        for (const ruleId of ruleIds) {
            if (ruleId === 'cross_chapter_simile') {
                continue;
            }

            const defaultDef = DEFAULT_GATE_RULES[ruleId];
            const overrideCfg: GateRuleConfig | undefined = options.rules?.[ruleId];
            if (!isRuleEnabled(ruleId, defaultDef, overrideCfg, options)) {
                ruleCounts[ruleId] = 0;
                continue;
            }

            const patterns = this.resolveRulePatterns(ruleId, defaultDef?.patterns ?? [], overrideCfg, options);
            if (patterns.length === 0) {
                ruleCounts[ruleId] = 0;
                continue;
            }

            const lastParagraphsOnly = overrideCfg?.lastParagraphsOnly ?? defaultDef?.lastParagraphsOnly;
            let hits: GateViolation[];
            if (ruleId === 'tag_residue') {
                hits = scanTagResidueHits(text, patterns, lineMetas);
            } else {
                const minParagraphIdx =
                    lastParagraphsOnly !== undefined && lastParagraphsOnly > 0
                        ? segmentation.paragraphs.length - lastParagraphsOnly
                        : 0;
                const targetLines =
                    lastParagraphsOnly !== undefined && lastParagraphsOnly > 0
                        ? lineMetas.filter(
                              (line) => line.paragraphIndex >= minParagraphIdx && line.paragraphIndex >= 0
                          )
                        : lineMetas;
                hits = scanLineRuleHits(ruleId, targetLines, patterns);
            }

            ruleCounts[ruleId] = hits.length;

            const maxCount = overrideCfg?.maxCount ?? defaultDef?.maxCount ?? 0;
            const scaleByLength = overrideCfg?.scaleByLength ?? defaultDef?.scaleByLength ?? false;
            const referenceChars = overrideCfg?.referenceChars ?? defaultDef?.referenceChars ?? 3000;
            const effectiveMaxCount = resolveEffectiveMaxCount(
                maxCount,
                scaleByLength,
                charCount,
                referenceChars
            );

            if (hits.length > effectiveMaxCount) {
                exceededRules.push(ruleId);
                // 仅将超出配额的条目计入违规，避免合法配额内的段落被误计入从而错误触发整章重写
                violations.push(...hits.slice(effectiveMaxCount));
            }
        }

        // 2. 扫描跨章明喻/喻体复读
        const simileOverride = options.rules?.cross_chapter_simile;
        const simileEnabled =
            simileOverride?.enabled ??
            options.enableCrossChapterSimile ??
            DEFAULT_GATE_RULES.cross_chapter_simile?.enabled ??
            true;

        if (simileEnabled) {
            const simileHits = this.evaluateCrossChapterSimile(lineMetas, options);
            ruleCounts.cross_chapter_simile = simileHits.length;
            if (simileHits.length > 0) {
                exceededRules.push('cross_chapter_simile');
                violations.push(...simileHits);
            }
        } else {
            ruleCounts.cross_chapter_simile = 0;
        }

        violations.sort((a, b) => a.line - b.line || a.column - b.column);

        const violatedParagraphIndices = Array.from(
            new Set(violations.map((v) => v.paragraphIndex).filter((idx) => idx >= 0))
        ).sort((a, b) => a - b);

        const totalParagraphCount = segmentation.paragraphs.length;
        const violatedParagraphCount = violatedParagraphIndices.length;
        const violatedParagraphRatio =
            totalParagraphCount > 0 ? violatedParagraphCount / totalParagraphCount : 0;
        const passed = violations.length === 0;
        const recommendedAction = resolveRecommendedAction(
            passed,
            violatedParagraphCount,
            violatedParagraphRatio,
            maxPatchParagraphs,
            maxPatchParagraphRatio
        );

        return {
            passed,
            charCount,
            violations,
            exceededRules,
            violatedParagraphIndices,
            violatedParagraphCount,
            recommendedAction,
            ruleCounts
        };
    }

    private resolveRulePatterns(
        ruleId: GateRuleId,
        defaultPatterns: RegExp[],
        overrideCfg: GateRuleConfig | undefined,
        options: ProseGateOptions
    ): RegExp[] {
        if (overrideCfg?.patterns && overrideCfg.patterns.length > 0) {
            return overrideCfg.patterns;
        }

        if (ruleId === 'filler_cliche') {
            const terms = [
                ...(overrideCfg?.terms ?? DEFAULT_CLICHE_TERMS),
                ...(options.extraClicheTerms ?? [])
            ]
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
            if (terms.length === 0) {
                return [];
            }
            const alternation = terms.map(escapeRegExp).join('|');
            return [new RegExp(`(${alternation})`, 'g')];
        }

        if (overrideCfg?.terms && overrideCfg.terms.length > 0) {
            const alternation = overrideCfg.terms.map(escapeRegExp).join('|');
            return [new RegExp(`(${alternation})`, 'g')];
        }

        return defaultPatterns;
    }

    private evaluateCrossChapterSimile(lineMetas: LineMeta[], options: ProseGateOptions): GateViolation[] {
        const windowSize = options.crossChapterSimileWindow ?? 5;
        const maxTotal =
            options.crossChapterSimileMaxTotal ?? options.rules?.cross_chapter_simile?.maxCount ?? 1;

        const historicalChapterCounts = new Map<string, number>();

        if (options.historicalChapters && options.historicalChapters.length > 0 && windowSize > 0) {
            for (const ch of options.historicalChapters.slice(-windowSize)) {
                const chapterVehicles = new Set(
                    extractConcreteSimiles(ch.text).map((item) => item.vehicle)
                );
                for (const vehicle of chapterVehicles) {
                    historicalChapterCounts.set(vehicle, (historicalChapterCounts.get(vehicle) ?? 0) + 1);
                }
            }
        }

        if (options.historicalSimiles) {
            for (const simile of options.historicalSimiles) {
                const normalized = normalizeSimileVehicle(simile);
                if (normalized.length >= 2) {
                    historicalChapterCounts.set(
                        normalized,
                        Math.max(historicalChapterCounts.get(normalized) ?? 0, 1)
                    );
                }
            }
        }

        const violations: GateViolation[] = [];
        for (const lineMeta of lineMetas) {
            if (lineMeta.paragraphIndex < 0) {
                continue;
            }
            for (const item of extractConcreteSimiles(lineMeta.text)) {
                const historicalChapterCount = historicalChapterCounts.get(item.vehicle) ?? 0;
                const totalChapterCount = historicalChapterCount + 1;
                if (historicalChapterCount >= 1 && totalChapterCount > maxTotal) {
                    violations.push({
                        ruleId: 'cross_chapter_simile',
                        line: lineMeta.lineNumber,
                        column: item.index + 1,
                        paragraphIndex: lineMeta.paragraphIndex,
                        matchedText: item.matchedText,
                        lineText: lineMeta.text,
                        message: `跨章明喻喻体"${item.vehicle}"已在 ${historicalChapterCount} 个历史章节中出现并在本章复现（跨章累计 ${totalChapterCount} 章，上限 ${maxTotal} 章）`
                    });
                }
            }
        }

        return violations;
    }
}

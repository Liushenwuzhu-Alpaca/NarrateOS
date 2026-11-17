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
    'micro_anatomy',
    'skeletal_quota',
    'filler_trace',
    'deictic_na',
    'reduplication_verb',
    'deictic_density',
    'filler_cliche',
    'ending_moralizing'
]);

/**
 * 0 Token 静态文风门禁扫描器
 */
export class StaticProseGate {
    /**
     * 对单章正文执行可开关静态规则扫描与跨章明喻复读检测
     */
    evaluate(text: string, options: ProseGateOptions = {}): ProseGateResult {
        const lines = text.split(/\r?\n/);
        const lineMetas: LineMeta[] = [];
        let paragraphCounter = 0;

        for (let i = 0; i < lines.length; i += 1) {
            const lineText = lines[i] ?? '';
            const isNonEmpty = lineText.trim().length > 0;
            const paragraphIndex = isNonEmpty ? paragraphCounter++ : -1;
            lineMetas.push({
                lineNumber: i + 1,
                text: lineText,
                paragraphIndex
            });
        }

        const nonEmptyLines = lineMetas.filter((item) => item.paragraphIndex >= 0);
        const charCount = text.replace(/\s+/g, '').length;
        const maxPatchParagraphs = options.maxPatchParagraphs ?? 2;

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

            const baseEnabled = defaultDef?.enabled ?? true;
            const antiClicheDisabled =
                options.enableAntiCliche === false && ANTI_CLICHE_RULE_IDS.has(ruleId);
            const enabled = overrideCfg?.enabled ?? (antiClicheDisabled ? false : baseEnabled);

            if (!enabled) {
                ruleCounts[ruleId] = 0;
                continue;
            }

            const patterns = this.resolveRulePatterns(ruleId, defaultDef?.patterns ?? [], overrideCfg, options);
            if (patterns.length === 0) {
                ruleCounts[ruleId] = 0;
                continue;
            }

            const lastParagraphsOnly = overrideCfg?.lastParagraphsOnly ?? defaultDef?.lastParagraphsOnly;
            const targetLines =
                lastParagraphsOnly !== undefined && lastParagraphsOnly > 0
                    ? nonEmptyLines.slice(-lastParagraphsOnly)
                    : lineMetas;

            const hits: GateViolation[] = [];
            const scanLines = ruleId === 'tag_residue'
                ? [{ lineNumber: 1, text, paragraphIndex: 0 }]
                : targetLines;
            for (const lineMeta of scanLines) {
                for (const pattern of patterns) {
                    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
                    const regex = new RegExp(pattern.source, flags);
                    let match: RegExpExecArray | null;
                    while ((match = regex.exec(lineMeta.text)) !== null) {
                        if (match[0].length === 0) {
                            regex.lastIndex += 1;
                            continue;
                        }
                        const prefix = ruleId === 'tag_residue' ? text.slice(0, match.index) : '';
                        const actualLine = ruleId === 'tag_residue'
                            ? lineMetas[prefix.split('\n').length - 1] ?? lineMeta
                            : lineMeta;
                        hits.push({
                            ruleId,
                            line: actualLine.lineNumber,
                            column: ruleId === 'tag_residue' ? match.index - prefix.lastIndexOf('\n') : match.index + 1,
                            paragraphIndex: actualLine.paragraphIndex,
                            matchedText: match[0],
                            lineText: actualLine.text,
                            message: `触发规则 ${ruleId}: "${match[0]}"`
                        });
                    }
                }
            }

            if (ruleId === 'tag_residue' && hits.length === 0) {
                const blockingScan = stripBlockingTags(text);
                if (blockingScan.hasUnclosedTag) {
                    const firstLine = lineMetas[0];
                    hits.push({
                        ruleId: 'tag_residue',
                        line: 1,
                        column: 1,
                        paragraphIndex: firstLine?.paragraphIndex ?? 0,
                        matchedText: '<blocking>',
                        lineText: firstLine?.text ?? '',
                        message: '检测到未闭合的 <blocking> 标签残留'
                    });
                }
            }

            ruleCounts[ruleId] = hits.length;

            const maxCount = overrideCfg?.maxCount ?? defaultDef?.maxCount ?? 0;
            const scaleByLength = overrideCfg?.scaleByLength ?? defaultDef?.scaleByLength ?? false;
            const referenceChars = overrideCfg?.referenceChars ?? defaultDef?.referenceChars ?? 3000;
            const effectiveMaxCount =
                maxCount === 0
                    ? 0
                    : scaleByLength
                      ? Math.max(maxCount, Math.floor((maxCount * charCount) / referenceChars))
                      : maxCount;

            if (hits.length > effectiveMaxCount) {
                exceededRules.push(ruleId);
                // 仅将超出配额的条目计入违规，避免合法配额内的段落被误计入从而错误触发整章重写
                violations.push(...hits.slice(effectiveMaxCount));
            }
        }

        // 2. 扫描跨章明喻/喻体复读
        const simileOverride = options.rules?.cross_chapter_simile;
        const simileEnabled =
            simileOverride?.enabled ?? options.enableCrossChapterSimile ?? DEFAULT_GATE_RULES.cross_chapter_simile?.enabled ?? true;

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

        const violatedParagraphCount = violatedParagraphIndices.length;
        const passed = violations.length === 0;
        const recommendedAction = passed
            ? 'PASS'
            : violatedParagraphCount <= maxPatchParagraphs
              ? 'PATCH'
              : 'REWRITE';

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
        const maxTotal = options.crossChapterSimileMaxTotal ?? options.rules?.cross_chapter_simile?.maxCount ?? 1;

        const historicalCounts = new Map<string, number>();

        if (options.historicalSimiles) {
            for (const simile of options.historicalSimiles) {
                const normalized = normalizeSimileVehicle(simile);
                if (normalized.length >= 2) {
                    historicalCounts.set(normalized, (historicalCounts.get(normalized) ?? 0) + 1);
                }
            }
        }

        if (options.historicalChapters && options.historicalChapters.length > 0) {
            const recentChapters = options.historicalChapters.slice(-windowSize);
            for (const ch of recentChapters) {
                const similes = extractConcreteSimiles(ch.text);
                for (const item of similes) {
                    historicalCounts.set(item.vehicle, (historicalCounts.get(item.vehicle) ?? 0) + 1);
                }
            }
        }

        const currentHits: Array<{ lineMeta: LineMeta; vehicle: string; matchedText: string; column: number }> = [];
        const currentCounts = new Map<string, number>();

        for (const lineMeta of lineMetas) {
            if (lineMeta.paragraphIndex < 0) {
                continue;
            }
            const similes = extractConcreteSimiles(lineMeta.text);
            for (const item of similes) {
                currentCounts.set(item.vehicle, (currentCounts.get(item.vehicle) ?? 0) + 1);
                currentHits.push({
                    lineMeta,
                    vehicle: item.vehicle,
                    matchedText: item.matchedText,
                    column: item.index + 1
                });
            }
        }

        const violations: GateViolation[] = [];
        for (const hit of currentHits) {
            const totalCount = (historicalCounts.get(hit.vehicle) ?? 0) + (currentCounts.get(hit.vehicle) ?? 0);
            if (totalCount > maxTotal) {
                violations.push({
                    ruleId: 'cross_chapter_simile',
                    line: hit.lineMeta.lineNumber,
                    column: hit.column,
                    paragraphIndex: hit.lineMeta.paragraphIndex,
                    matchedText: hit.matchedText,
                    lineText: hit.lineMeta.text,
                    message: `跨章明喻喻体"${hit.vehicle}"累计出现 ${totalCount} 次（上限 ${maxTotal} 次）`
                });
            }
        }

        return violations;
    }
}

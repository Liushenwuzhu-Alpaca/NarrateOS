/** 剥离 blocking 标签的结果 */
export interface StripBlockingResult {
    cleanText: string;
    blockingContents: string[];
    strippedCount: number;
    hasUnclosedTag: boolean;
}

/** 静态文风门禁规则标识 */
export type GateRuleId =
    | 'tag_residue'
    | 'negation_contrast'
    | 'subjective_judgment'
    | 'micro_anatomy'
    | 'skeletal_quota'
    | 'filler_trace'
    | 'deictic_na'
    | 'reduplication_verb'
    | 'deictic_density'
    | 'filler_cliche'
    | 'ending_moralizing'
    | 'cross_chapter_simile'
    | (string & {});

/** 单条门禁规则的可配选项 */
export interface GateRuleConfig {
    enabled?: boolean | undefined;
    maxCount?: number | undefined;
    scaleByLength?: boolean | undefined;
    referenceChars?: number | undefined;
    patterns?: RegExp[] | undefined;
    terms?: string[] | undefined;
    lastParagraphsOnly?: number | undefined;
}

/** 历史章节输入（用于跨章明喻/喻体复读检测） */
export interface HistoricalChapterInput {
    chapter?: number | undefined;
    text: string;
}

/** StaticProseGate 评估选项 */
export interface ProseGateOptions {
    /** 叙述人称与主观度基线（subjective_first 自动豁免视角主观评判与先否决对比规则） */
    narrationSubjectivity?: 'objective_third' | 'subjective_first' | undefined;
    /** 是否启用反八股规则总开关（与 BookConfig.prose_gate.enable_anti_cliche 对齐） */
    enableAntiCliche?: boolean | undefined;
    /** 是否启用跨章明喻复读检测（与 BookConfig.prose_gate.enable_cross_chapter_simile 对齐） */
    enableCrossChapterSimile?: boolean | undefined;
    /** 跨章明喻检测窗口章数（默认 5） */
    crossChapterSimileWindow?: number | undefined;
    /** 同一具象喻体跨章允许的最多总出现次数阈值，默认 1（即重复 >= 2 次时触发） */
    crossChapterSimileMaxTotal?: number | undefined;
    /** 局部 Patch 最大违规段落数阈值（默认 2，超过则建议整章重写） */
    maxPatchParagraphs?: number | undefined;
    /** 已提取的历史章喻体集合 */
    historicalSimiles?: Iterable<string> | undefined;
    /** 历史章原文列表（将按窗口自动提取喻体） */
    historicalChapters?: HistoricalChapterInput[] | undefined;
    /** 额外追加的 AI 八股词条 */
    extraClicheTerms?: string[] | undefined;
    /** 按规则 ID 覆盖默认配置（开关、阈值、词表或正则） */
    rules?: Partial<Record<GateRuleId, GateRuleConfig>> | undefined;
}

/** 单条门禁违规命中记录 */
export interface GateViolation {
    ruleId: GateRuleId;
    line: number;
    column: number;
    /** 非空段落的 0-based 索引 */
    paragraphIndex: number;
    matchedText: string;
    lineText: string;
    message: string;
}

/** StaticProseGate 评估结果 */
export interface ProseGateResult {
    passed: boolean;
    charCount: number;
    violations: GateViolation[];
    exceededRules: GateRuleId[];
    violatedParagraphIndices: number[];
    violatedParagraphCount: number;
    recommendedAction: 'PASS' | 'PATCH' | 'REWRITE';
    ruleCounts: Record<string, number>;
}

/** 单侧原句验真结果 */
export interface QuoteVerificationSide {
    matched: boolean;
    /** 匹配起始行号（1-based），未匹配为 null */
    lineNumber: number | null;
    startLine: number | null;
    endLine: number | null;
    normalizedQuote: string;
}

/** 双侧原句验真结果 */
export interface DualQuoteVerificationResult {
    passed: boolean;
    sideA: QuoteVerificationSide;
    sideB: QuoteVerificationSide;
}

/** 零模型遥测计算选项 */
export interface TelemetryOptions {
    /** MATTR 滑动窗口词数（默认 500） */
    mattrWindowSize?: number | undefined;
    /** 自定义 AI 八股词表（默认使用内置八股词典） */
    clicheTerms?: string[] | undefined;
}

/** 零模型健康度遥测指标 */
export interface TelemetryMetrics {
    charCount: number;
    wordCount: number;
    sentenceCount: number;
    mattr500: number;
    kontoyiannisEntropy: number;
    sentenceLengthCv: number;
    clicheDensityPer1k: number;
}

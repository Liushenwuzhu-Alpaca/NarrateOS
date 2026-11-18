import { z } from 'zod';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    analyzeParagraphs,
    StaticProseGate,
    type ProseGateOptions,
    type ProseGateResult
} from '@narrateos/dsh-book-store';

/** 单条段落区间替换参数 Schema */
export const PatchParagraphEditSchema = z.object({
    start_paragraph: z.number().int().nonnegative(),
    end_paragraph: z.number().int().nonnegative(),
    replacement_paragraphs: z.array(z.string())
});
export type PatchParagraphEdit = z.infer<typeof PatchParagraphEditSchema>;

/** patch_paragraphs 工具输入参数 Schema */
export const PatchParagraphsInputSchema = z.object({
    edits: z.array(PatchParagraphEditSchema).min(1)
});
export type PatchParagraphsInput = z.infer<typeof PatchParagraphsInputSchema>;

/** 已修改段落区间摘要 */
export type PatchModifiedRange = {
    start_paragraph: number;
    end_paragraph: number;
    replaced_with_count: number;
};

/** patch_paragraphs 返回的单条静态门禁违规明细 */
export type PatchParagraphViolation = {
    paragraphIndex: number;
    ruleId: string;
    line: number;
    column: number;
    matchedText: string;
    lineText: string;
};

/** 违规段落的带编号当前正文快照 */
export type ViolatedParagraphSnapshot = {
    index: number;
    text: string;
};

/** 内存修补文风门禁统一评估报告 */
export interface PatchGateReport {
    configured: boolean;
    passed: boolean;
    violatedParagraphCount: number;
    violatedParagraphIndices: number[];
    violations: PatchParagraphViolation[];
    violatedParagraphs: ViolatedParagraphSnapshot[];
}

/** patch_paragraphs 工具执行结果 */
export type PatchParagraphsResult = {
    totalParagraphs: number;
    editCount: number;
    modifiedRanges: PatchModifiedRange[];
    titlePreserved: boolean;
    passed: boolean;
    violatedParagraphCount: number;
    violatedParagraphIndices: number[];
    violations: PatchParagraphViolation[];
    violatedParagraphs: ViolatedParagraphSnapshot[];
    message: string;
};

/** patch_paragraphs 工具构造选项 */
export interface PatchParagraphsToolOptions {
    session: InMemoryDraftPatchSession;
}

/** 按空行拆分 0-based 自然段列表 */
export function splitParagraphs(text: string): string[] {
    return analyzeParagraphs(text).paragraphs;
}

/** 格式化单条门禁违规描述 */
export function formatPatchViolationsText(
    violations: readonly PatchParagraphViolation[],
    violatedParagraphs: readonly ViolatedParagraphSnapshot[]
): string {
    const lines: string[] = [];
    if (violations.length > 0) {
        lines.push('违规定位清单:');
        for (const v of violations) {
            lines.push(
                `- [${v.paragraphIndex}] (${v.ruleId}, line ${v.line}:${v.column}) 命中 "${v.matchedText}" | 行内容: ${v.lineText}`
            );
        }
    }
    if (violatedParagraphs.length > 0) {
        lines.push('违规段落当前正文:');
        for (const snap of violatedParagraphs) {
            lines.push(`[${snap.index}] ${snap.text}`);
        }
    }
    return lines.join('\n');
}

function validateAndSortPatchEdits(
    edits: readonly PatchParagraphEdit[],
    currentLength: number
): PatchParagraphEdit[] {
    for (const edit of edits) {
        if (edit.start_paragraph > edit.end_paragraph) {
            throw new Error(
                `无效段落区间: start_paragraph (${edit.start_paragraph}) 不能大于 end_paragraph (${edit.end_paragraph})`
            );
        }
        if (edit.end_paragraph >= currentLength) {
            throw new Error(
                `段落索引越界: end_paragraph (${edit.end_paragraph}) 超出当前总段数 (${currentLength})`
            );
        }
    }

    const sortedAsc = [...edits].sort(
        (a, b) => a.start_paragraph - b.start_paragraph || a.end_paragraph - b.end_paragraph
    );
    for (let i = 1; i < sortedAsc.length; i += 1) {
        const prev = sortedAsc[i - 1]!;
        const curr = sortedAsc[i]!;
        if (curr.start_paragraph <= prev.end_paragraph) {
            throw new Error(
                `编辑区间重叠: [${prev.start_paragraph}, ${prev.end_paragraph}] 与 [${curr.start_paragraph}, ${curr.end_paragraph}]`
            );
        }
    }
    return sortedAsc;
}

function buildPatchResultMessage(
    modifiedRanges: readonly PatchModifiedRange[],
    totalParagraphs: number,
    titlePreserved: boolean,
    preservedTitleLine: string | undefined,
    report: PatchGateReport
): string {
    const rangeSummary = modifiedRanges
        .map((r) => `[${r.start_paragraph}..${r.end_paragraph}]->${r.replaced_with_count}段`)
        .join(', ');

    const messageParts: string[] = [
        `已完成段落修补 (${rangeSummary})，最新总段数: ${totalParagraphs}。`
    ];
    if (titlePreserved && preservedTitleLine) {
        messageParts.push(`检测到第 0 段失去一级标题前缀，已自动保留原标题行「${preservedTitleLine}」。`);
    }
    if (!report.configured) {
        messageParts.push('内存段落替换已完成（未配置 StaticProseGate 实时复检），可调用 yield_patched_draft 提交定稿。');
    } else if (report.passed) {
        messageParts.push('已通过静态文风门禁，可立即调用 yield_patched_draft 提交定稿。');
    } else {
        messageParts.push(
            `剩余 ${report.violatedParagraphCount} 个违规段落 [${report.violatedParagraphIndices.join(', ')}]，请继续修正。`
        );
    }
    return messageParts.join(' ');
}

/**
 * 纯内存段落修补会话（零磁盘读写、零全知档案依赖）
 * - 基于 analyzeParagraphs 按空行维护 0-based 段落数组与 editCount；
 * - 支持逆序多区间非重叠替换，并在配置 proseGateOptions 时实时运行 StaticProseGate。
 */
export class InMemoryDraftPatchSession {
    private paragraphs: string[];
    private readonly initialProse: string;
    private editCount = 0;
    public readonly proseGateOptions: ProseGateOptions | undefined;

    constructor(draftText: string, proseGateOptions?: ProseGateOptions) {
        if (typeof draftText !== 'string') {
            throw new TypeError('InMemoryDraftPatchSession 需要字符串类型的 draftText');
        }
        this.paragraphs = splitParagraphs(draftText);
        this.initialProse = this.paragraphs.join('\n\n');
        this.proseGateOptions = proseGateOptions;
    }

    /** 返回初始归一化正文文本 */
    getInitialProse(): string {
        return this.initialProse;
    }

    /** 返回当前 0-based 段落数组副本 */
    getParagraphs(): string[] {
        return [...this.paragraphs];
    }

    /** 返回当前拼接后的完整正文 */
    getProse(): string {
        return this.paragraphs.join('\n\n');
    }

    /** 返回累计已应用的编辑次数 */
    getEditCount(): number {
        return this.editCount;
    }

    /** 若已配置 proseGateOptions 则执行 StaticProseGate 评估 */
    evaluateProseGate(overrideOptions?: ProseGateOptions): ProseGateResult | null {
        const effectiveOptions = overrideOptions ?? this.proseGateOptions;
        if (!effectiveOptions) {
            return null;
        }
        return new StaticProseGate().evaluate(this.getProse(), effectiveOptions);
    }

    /** 生成包含违规明细与违规段落当前正文的统一门禁评估报告 */
    evaluateGateReport(overrideOptions?: ProseGateOptions): PatchGateReport {
        const gateResult = this.evaluateProseGate(overrideOptions);
        if (!gateResult) {
            return {
                configured: false,
                passed: true,
                violatedParagraphCount: 0,
                violatedParagraphIndices: [],
                violations: [],
                violatedParagraphs: []
            };
        }
        const violatedParagraphIndices = gateResult.violatedParagraphIndices;
        const violations: PatchParagraphViolation[] = gateResult.violations.map((v) => ({
            paragraphIndex: v.paragraphIndex,
            ruleId: v.ruleId,
            line: v.line,
            column: v.column,
            matchedText: v.matchedText,
            lineText: v.lineText
        }));
        const violatedParagraphs: ViolatedParagraphSnapshot[] = violatedParagraphIndices.map((idx) => ({
            index: idx,
            text: this.paragraphs[idx] ?? ''
        }));
        return {
            configured: true,
            passed: gateResult.passed,
            violatedParagraphCount: gateResult.violatedParagraphCount,
            violatedParagraphIndices,
            violations,
            violatedParagraphs
        };
    }

    /** 校验并按逆序应用一组互不重叠的 0-based 段落区间替换 */
    applyEdits(rawEdits: readonly PatchParagraphEdit[]): PatchParagraphsResult {
        const parsed = PatchParagraphsInputSchema.parse({ edits: rawEdits });
        const sortedAsc = validateAndSortPatchEdits(parsed.edits, this.paragraphs.length);

        const originalParagraph0 = this.paragraphs[0];
        const nextParagraphs = [...this.paragraphs];
        const sortedDesc = [...sortedAsc].reverse();
        const rangeByStart = new Map<number, PatchModifiedRange>();

        for (const edit of sortedDesc) {
            const normalizedReplacements: string[] = [];
            for (const item of edit.replacement_paragraphs) {
                normalizedReplacements.push(...splitParagraphs(item));
            }
            const deleteCount = edit.end_paragraph - edit.start_paragraph + 1;
            nextParagraphs.splice(edit.start_paragraph, deleteCount, ...normalizedReplacements);
            rangeByStart.set(edit.start_paragraph, {
                start_paragraph: edit.start_paragraph,
                end_paragraph: edit.end_paragraph,
                replaced_with_count: normalizedReplacements.length
            });
        }

        let titlePreserved = false;
        let preservedTitleLine: string | undefined;
        if (originalParagraph0 !== undefined && originalParagraph0.startsWith('# ')) {
            const firstLine = originalParagraph0.split(/\r?\n/)[0] ?? '';
            if (nextParagraphs.length === 0 || !nextParagraphs[0]!.startsWith('# ')) {
                nextParagraphs.unshift(firstLine);
                titlePreserved = true;
                preservedTitleLine = firstLine;
            }
        }

        // 校验替换合并后的非一级标题正文段落数 >= 1，拒绝把正文删空导致后续死锁
        const nonHeadingCount = nextParagraphs.filter((p) => !p.startsWith('# ')).length;
        if (nonHeadingCount < 1) {
            throw new Error('段落修补后必须至少保留 1 个非 # 标题正文段落，禁止将正文删空');
        }

        const modifiedRanges = sortedAsc.map((edit) => rangeByStart.get(edit.start_paragraph)!);

        this.paragraphs = nextParagraphs;
        this.editCount += parsed.edits.length;

        const report = this.evaluateGateReport();

        return {
            totalParagraphs: this.paragraphs.length,
            editCount: this.editCount,
            modifiedRanges,
            titlePreserved,
            passed: report.passed,
            violatedParagraphCount: report.violatedParagraphCount,
            violatedParagraphIndices: report.violatedParagraphIndices,
            violations: report.violations,
            violatedParagraphs: report.violatedParagraphs,
            message: buildPatchResultMessage(
                modifiedRanges,
                this.paragraphs.length,
                titlePreserved,
                preservedTitleLine,
                report
            )
        };
    }
}

/** 创建纯内存段落修补工具 patch_paragraphs */
export function createPatchParagraphsTool(options: PatchParagraphsToolOptions): ToolDefinition {
    const { session } = options;

    return defineTool({
        name: 'patch_paragraphs',
        description:
            '在纯内存草稿会话中按 0-based 段落索引执行非重叠区间替换，并在每次修改后实时返回 StaticProseGate 诊断结果与当前违规段落正文。',
        parameters: {
            edits: {
                type: 'array',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        start_paragraph: {
                            type: 'integer',
                            required: true,
                            description: '起始段落索引（0-based 非负整数）'
                        },
                        end_paragraph: {
                            type: 'integer',
                            required: true,
                            description: '结束段落索引（0-based 非负整数，须满足 start_paragraph <= end_paragraph < 总段数）'
                        },
                        replacement_paragraphs: {
                            type: 'array',
                            required: true,
                            items: { type: 'string' },
                            description: '替换后的段落文本数组（可为空数组表示删除该区间）'
                        }
                    }
                },
                description: '非重叠的段落区间替换指令列表'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    totalParagraphs: { type: 'integer', required: true },
                    editCount: { type: 'integer', required: true },
                    modifiedRanges: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                start_paragraph: { type: 'integer', required: true },
                                end_paragraph: { type: 'integer', required: true },
                                replaced_with_count: { type: 'integer', required: true }
                            }
                        }
                    },
                    titlePreserved: { type: 'boolean', required: true },
                    passed: { type: 'boolean', required: true },
                    violatedParagraphCount: { type: 'integer', required: true },
                    violatedParagraphIndices: {
                        type: 'array',
                        required: true,
                        items: { type: 'integer' }
                    },
                    violations: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                paragraphIndex: { type: 'integer', required: true },
                                ruleId: { type: 'string', required: true },
                                line: { type: 'integer', required: true },
                                column: { type: 'integer', required: true },
                                matchedText: { type: 'string', required: true },
                                lineText: { type: 'string', required: true }
                            }
                        }
                    },
                    violatedParagraphs: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                index: { type: 'integer', required: true },
                                text: { type: 'string', required: true }
                            }
                        }
                    },
                    message: { type: 'string', required: true }
                }
            },
            render(_args, value) {
                const lines: string[] = [value.message];
                if (!value.passed) {
                    const detail = formatPatchViolationsText(value.violations, value.violatedParagraphs);
                    if (detail.length > 0) {
                        lines.push(detail);
                    }
                }
                return [{ type: 'text', text: lines.join('\n') }];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            return session.applyEdits(args.edits);
        }
    });
}

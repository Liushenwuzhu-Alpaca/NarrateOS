import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    analyzeParagraphs,
    BookRepairLoopConfigSchema,
    verifyDualQuotes,
    type NarrateStoreService
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PathFence } from '../tools/path-fence.js';
import { readContentWithStagingPriority, readOptionalBookConfig } from '../tools/shared.js';
import { FactCheckOutputSchema, type FactCheckIssue, type FactCheckOutput } from './schemas.js';

const DEFAULT_REPAIR_LOOP_CFG = BookRepairLoopConfigSchema.parse({});

export interface YieldVerdictOptions {
    store: NarrateStoreService;
    bookRoot: string;
    runId: string;
    fence?: PathFence | undefined;
    draftText?: string | undefined;
    draftPath?: string | undefined;
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    onYield?: ((verdict: FactCheckOutput) => void) | undefined;
}

async function loadSourceContent(
    store: NarrateStoreService,
    runId: string,
    fence: PathFence,
    relPath: string,
    stagingOverlay?: ReadonlyMap<string, string | null>
): Promise<string> {
    const { normalized, absPath } = await fence.assertReadFile(relPath);
    const { content } = await readContentWithStagingPriority({
        store,
        runId,
        normalizedPath: normalized,
        absPath,
        stagingOverlay,
        missingInOverlayMessage: `文件在当前分支视图中不存在: ${normalized}`
    });
    return content;
}

async function resolveRepairLoopLimits(
    store: NarrateStoreService,
    bookRoot: string
): Promise<{ factMaxPatchParagraphs: number; factMaxPatchRatio: number }> {
    const cfg = await readOptionalBookConfig(store, bookRoot);
    return {
        factMaxPatchParagraphs:
            cfg?.repair_loop?.fact_max_patch_paragraphs ?? DEFAULT_REPAIR_LOOP_CFG.fact_max_patch_paragraphs,
        factMaxPatchRatio:
            cfg?.repair_loop?.fact_max_patch_ratio ?? DEFAULT_REPAIR_LOOP_CFG.fact_max_patch_ratio
    };
}

function validateLocalPatchIndices(
    issue: FactCheckIssue,
    issueNumber: number,
    draftParagraphCount: number,
    limits: { factMaxPatchParagraphs: number; factMaxPatchRatio: number }
): void {
    const rawIndices: number[] = [];
    if (issue.paragraph_index !== undefined) {
        rawIndices.push(issue.paragraph_index);
    }
    if (issue.paragraph_indices !== undefined) {
        rawIndices.push(...issue.paragraph_indices);
    }
    const uniqueIndices = Array.from(new Set(rawIndices)).sort((a, b) => a - b);
    if (uniqueIndices.length === 0) {
        throw new GateValidationError(
            'yield_verdict',
            `第 ${issueNumber} 条 LOCAL_PATCH 问题必须提供非空的 0-based paragraph_index 或 paragraph_indices`
        );
    }
    for (const idx of uniqueIndices) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= draftParagraphCount) {
            throw new GateValidationError(
                'yield_verdict',
                `第 ${issueNumber} 条 LOCAL_PATCH 问题的段落索引 (${idx}) 越界，合法范围为 [0..${Math.max(0, draftParagraphCount - 1)}]`
            );
        }
    }
    if (uniqueIndices.length > limits.factMaxPatchParagraphs) {
        throw new GateValidationError(
            'yield_verdict',
            `第 ${issueNumber} 条 LOCAL_PATCH 涉及段落数 (${uniqueIndices.length}) 超过上限 ${limits.factMaxPatchParagraphs}，请改判为 MULTI_REWRITE`
        );
    }
    if (
        uniqueIndices.length >= 2 &&
        draftParagraphCount > 0 &&
        uniqueIndices.length / draftParagraphCount > limits.factMaxPatchRatio
    ) {
        throw new GateValidationError(
            'yield_verdict',
            `第 ${issueNumber} 条 LOCAL_PATCH 涉及段落占比 (${uniqueIndices.length}/${draftParagraphCount}) 超过上限 ${limits.factMaxPatchRatio}，请改判为 MULTI_REWRITE`
        );
    }
}

/** 创建 Fact Checker 终态门禁工具 yield_verdict（强制双侧原句去标点存在性验真与 LOCAL_PATCH 索引边界校验） */
export function createYieldVerdictTool(options: YieldVerdictOptions): ToolDefinition {
    const { store, bookRoot, runId, draftPath, stagingOverlay, onYield } = options;
    const fence = options.fence ?? new PathFence(bookRoot);

    return defineTool({
        name: 'yield_verdict',
        description:
            'Fact Checker 终态交接门禁。对每条问题的 quote_draft 与 quote_source 执行双侧去标点存在性验真，拦截捏造或偏差引文并打回重查。',
        parameters: {
            passed: {
                type: 'boolean',
                required: true,
                description: '审校是否通过'
            },
            issues: {
                type: 'array',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        severity: {
                            type: 'string',
                            required: true,
                            enum: ['LOCAL_PATCH', 'MULTI_REWRITE', 'PLAN_CONFLICT']
                        },
                        paragraph_index: { type: 'integer' },
                        paragraph_indices: { type: 'array', items: { type: 'integer' } },
                        description: { type: 'string', required: true },
                        quote_draft: { type: 'string' },
                        quote_source: { type: 'string' },
                        source_ref: { type: 'string' }
                    }
                },
                description: '发现的硬性事实冲突清单（passed=true 时须为空数组）'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    passed: { type: 'boolean', required: true },
                    issueCount: { type: 'integer', required: true }
                }
            },
            render(_args, value) {
                return [
                    {
                        type: 'text',
                        text: `yield_verdict 门禁通过：passed=${String(value.passed)}，核实问题 ${value.issueCount} 条。`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const verdict = FactCheckOutputSchema.parse(args);

            if (verdict.passed && verdict.issues.length > 0) {
                throw new GateValidationError(
                    'yield_verdict',
                    'passed=true 时 issues 必须为空数组'
                );
            }
            if (!verdict.passed && verdict.issues.length === 0) {
                throw new GateValidationError(
                    'yield_verdict',
                    'passed=false 时 issues 不能为空数组，必须给出至少一条带原句引文的冲突问题'
                );
            }

            let resolvedDraft = options.draftText;
            if (resolvedDraft === undefined && draftPath !== undefined) {
                resolvedDraft = await loadSourceContent(store, runId, fence, draftPath, stagingOverlay);
            }

            const limits = await resolveRepairLoopLimits(store, bookRoot);
            const draftParagraphs =
                resolvedDraft !== undefined ? analyzeParagraphs(resolvedDraft).paragraphs : [];

            for (let i = 0; i < verdict.issues.length; i += 1) {
                const issue = verdict.issues[i]!;
                const issueNumber = i + 1;
                const draftQuote = issue.quote_draft.trim();
                const sourceQuote = issue.quote_source.trim();
                const sourceRef = issue.source_ref?.trim() ?? '';

                if (draftQuote.length === 0) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题缺少 quote_draft 逐字原句引文，请回到草稿核实并补充原句`
                    );
                }
                if (resolvedDraft === undefined) {
                    throw new GateValidationError(
                        'yield_verdict',
                        '无法核验 quote_draft：未提供本章草稿文本或草稿路径'
                    );
                }
                if (sourceRef.length === 0) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题缺少 source_ref 档案/原稿路径（严禁省略事实依据路径）`
                    );
                }
                if (sourceQuote.length === 0) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题缺少 quote_source 逐字引文（严禁省略事实依据引文）`
                    );
                }

                if (issue.severity === 'LOCAL_PATCH') {
                    validateLocalPatchIndices(issue, issueNumber, draftParagraphs.length, limits);
                }

                let sourceText: string;
                try {
                    sourceText = await loadSourceContent(store, runId, fence, sourceRef, stagingOverlay);
                } catch (err: unknown) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题的 source_ref 无法读取 (${sourceRef}): ${err instanceof Error ? err.message : String(err)}`
                    );
                }
                const dual = verifyDualQuotes(draftQuote, resolvedDraft, sourceQuote, sourceText);
                if (!dual.sideA.matched) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题的 quote_draft 未在草稿正文中命中（疑似捏造或改写引文），请重新读取草稿逐字核查`
                    );
                }
                if (!dual.sideB.matched) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题的 quote_source 未在 ${sourceRef} 中命中（疑似捏造或改写引文），请重新读取档案/原稿逐字核查`
                    );
                }
            }

            onYield?.(verdict);
            exec.concludeTurn();

            return {
                accepted: true,
                passed: verdict.passed,
                issueCount: verdict.issues.length
            };
        }
    });
}

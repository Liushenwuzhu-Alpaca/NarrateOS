import { readFile } from 'node:fs/promises';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { verifyDualQuotes, type NarrateStoreService } from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PathFence } from '../tools/path-fence.js';
import { FactCheckOutputSchema, type FactCheckOutput } from './schemas.js';

export interface YieldVerdictOptions {
    store: NarrateStoreService;
    bookRoot: string;
    runId: string;
    fence?: PathFence | undefined;
    draftText?: string | undefined;
    draftPath?: string | undefined;
    onYield?: ((verdict: FactCheckOutput) => void) | undefined;
}

async function loadSourceContent(
    store: NarrateStoreService,
    runId: string,
    fence: PathFence,
    relPath: string
): Promise<string> {
    const { normalized, absPath } = await fence.assertReadFile(relPath);
    if (store.staging.has(runId)) {
        return await store.staging.read(runId, normalized);
    }
    return await readFile(absPath, 'utf8');
}

/** 创建 Fact Checker 终态门禁工具 yield_verdict（强制双侧原句去标点存在性验真） */
export function createYieldVerdictTool(options: YieldVerdictOptions): ToolDefinition {
    const { store, bookRoot, runId, draftPath, onYield } = options;
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

            let resolvedDraft = options.draftText;
            if (resolvedDraft === undefined && draftPath !== undefined) {
                resolvedDraft = await loadSourceContent(store, runId, fence, draftPath);
            }

            for (let i = 0; i < verdict.issues.length; i += 1) {
                const issue = verdict.issues[i]!;
                const draftQuote = issue.quote_draft.trim();
                const sourceQuote = issue.quote_source.trim();
                const sourceRef = issue.source_ref?.trim();

                if (draftQuote.length === 0) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${i + 1} 条问题缺少 quote_draft 逐字原句引文，请回到草稿核实并补充原句`
                    );
                }
                if (resolvedDraft === undefined) {
                    throw new GateValidationError(
                        'yield_verdict',
                        '无法核验 quote_draft：未提供本章草稿文本或草稿路径'
                    );
                }

                if (sourceQuote.length > 0 && !sourceRef) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${i + 1} 条问题提供了 quote_source，但缺少对应的 source_ref 档案/原稿路径`
                    );
                }
                if (sourceRef && sourceQuote.length === 0) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${i + 1} 条问题提供了 source_ref (${sourceRef})，但缺少 quote_source 逐字引文`
                    );
                }

                if (sourceRef && sourceQuote.length > 0) {
                    let sourceText: string;
                    try {
                        sourceText = await loadSourceContent(store, runId, fence, sourceRef);
                    } catch (err: unknown) {
                        throw new GateValidationError(
                            'yield_verdict',
                            `第 ${i + 1} 条问题的 source_ref 无法读取 (${sourceRef}): ${err instanceof Error ? err.message : String(err)}`
                        );
                    }
                    const dual = verifyDualQuotes(draftQuote, resolvedDraft, sourceQuote, sourceText);
                    if (!dual.sideA.matched) {
                        throw new GateValidationError(
                            'yield_verdict',
                            `第 ${i + 1} 条问题的 quote_draft 未在草稿正文中命中（疑似捏造或改写引文），请重新读取草稿逐字核查`
                        );
                    }
                    if (!dual.sideB.matched) {
                        throw new GateValidationError(
                            'yield_verdict',
                            `第 ${i + 1} 条问题的 quote_source 未在 ${sourceRef} 中命中（疑似捏造或改写引文），请重新读取档案/原稿逐字核查`
                        );
                    }
                } else {
                    const draftCheck = verifyDualQuotes(draftQuote, resolvedDraft, draftQuote, resolvedDraft);
                    if (!draftCheck.sideA.matched) {
                        throw new GateValidationError(
                            'yield_verdict',
                            `第 ${i + 1} 条问题的 quote_draft 未在草稿正文中命中（疑似捏造或改写引文），请重新读取草稿逐字核查`
                        );
                    }
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

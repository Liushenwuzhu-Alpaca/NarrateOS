import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    analyzeParagraphs,
    BookRepairLoopConfigSchema,
    normalizeForQuoteMatch,
    verifyDualQuotes,
    type NarrateStoreService
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PathFence } from '../tools/path-fence.js';
import { isEnoentError, readContentWithStagingPriority, readOptionalBookConfig } from '../tools/shared.js';
import { FactCheckOutputSchema, type FactCheckIssue, type FactCheckOutput } from './schemas.js';

const DEFAULT_REPAIR_LOOP_CFG = BookRepairLoopConfigSchema.parse({});

export interface YieldVerdictOptions {
    store: NarrateStoreService;
    bookRoot: string;
    runId: string;
    fence?: PathFence | undefined;
    draftText?: string | undefined;
    draftPath?: string | undefined;
    /** 本章内存细纲，仅供 PLAN_CONFLICT 引用 */
    outlineText?: string | undefined;
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    onYield?: ((verdict: FactCheckOutput) => void) | undefined;
}

const WORLD_SOURCE_NAMES: Record<string, true> = {
    'current_arc_envelope.md': true, 'open_threads.md': true, 'arc_director_plan.md': true,
    'author_charter.md': true, 'static_base_and_voice.md': true, 'world_state.md': true, 'future_horizon.md': true
};

/** 只补齐已知世界文档；其他路径仍交给围栏判定。 */
function canonicalSourceRef(value: string): string {
    return Object.hasOwn(WORLD_SOURCE_NAMES, value) ? `world/${value}` : value;
}

function sourceQuoteHint(quote: string, content: string, sourceRef: string): string {
    const normalizedQuote = normalizeForQuoteMatch(quote);
    const grams = new Set<string>();
    for (let index = 0; index + 1 < normalizedQuote.length; index += 1) {
        grams.add(normalizedQuote.slice(index, index + 2));
    }
    let closest = '';
    let coverage = 0;
    if (grams.size > 0) {
        for (const line of content.split('\n')) {
            const normalizedLine = normalizeForQuoteMatch(line);
            let hits = 0;
            for (const gram of grams) if (normalizedLine.includes(gram)) hits += 1;
            const score = hits / grams.size;
            if (score > coverage) { coverage = score; closest = line; }
        }
    }
    return coverage >= 0.7
        ? `源文件中最接近的原句为：“${closest}”。注意：与你提交的引文存在字词差异，请先核对该原句的真实含义是否仍支持你的冲突指控；若源文件原句含义其实与草稿一致，请直接删除该条误报 issue！`
        : `在 ${sourceRef} 中未找到与 quote_source 相近的表述，请核实该事实依据是否真实存在`;
}

/** 只合并相邻段；不把隔段片段拼成原稿中不存在的引用。 */
function matchesTargetParagraphs(indices: readonly number[], paragraphs: readonly string[], quote: string): boolean {
    let group: string[] = [];
    for (let index = 0; index < indices.length; index += 1) {
        if (index > 0 && indices[index] !== indices[index - 1]! + 1) {
            if (normalizeForQuoteMatch(group.join('\n')).includes(quote)) return true;
            group = [];
        }
        group.push(paragraphs[indices[index]!]!);
    }
    return normalizeForQuoteMatch(group.join('\n')).includes(quote);
}

async function loadSourceContent(
    store: NarrateStoreService,
    runId: string,
    fence: PathFence,
    relPath: string,
    stagingOverlay?: ReadonlyMap<string, string | null>
): Promise<string> {
    const { normalized, absPath } = await fence.assertReadFile(relPath);
    try {
        const { content } = await readContentWithStagingPriority({
            store,
            runId,
            normalizedPath: normalized,
            absPath,
            stagingOverlay,
            missingInOverlayMessage: `文件在当前分支视图中不存在: ${normalized}`
        });
        return content;
    } catch (error: unknown) {
        if (isEnoentError(error) && /^entities\/(?:char|item)_[a-zA-Z0-9_]+\.md$/.test(normalized)
            && !stagingOverlay?.has(normalized)) {
            return loadSourceContent(store, runId, fence, normalized.replace('entities/', 'entities/cold_archive/'), stagingOverlay);
        }
        if (isEnoentError(error)) throw new Error(`文件不存在: ${normalized}`);
        throw error;
    }
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
): number[] {
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
    return uniqueIndices;
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
                        quote_draft: { type: 'string', required: true },
                        quote_source: { type: 'string', required: true },
                        source_ref: { type: 'string', required: true, description: '预注入 SOURCE_REF 路径；outline 仅用于 PLAN_CONFLICT' }
                    }
                },
                description: '发现的硬性事实冲突清单（passed=true 时须为空数组）'
            },
            confirmed_completed_beats: {
                type: 'json',
                description: '可选字符串数组：仅在通过终审时填写，正文已彻底达成 completion_sign 的节拍标签；格式偏差按无附加确认处理'
            },
            confirmed_resolved_threads: {
                type: 'json',
                description: '可选字符串数组：仅在通过终审时填写，正文已彻底结案的 thread_id；格式偏差按无附加确认处理'
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
                const sourceRef = canonicalSourceRef(issue.source_ref?.trim() ?? '');

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

                const targets = issue.severity === 'LOCAL_PATCH'
                    ? validateLocalPatchIndices(issue, issueNumber, draftParagraphs.length, limits)
                    : undefined;

                let sourceText: string;
                if (sourceRef === 'outline' || sourceRef === 'outline_text') {
                    if (issue.severity !== 'PLAN_CONFLICT') {
                        throw new GateValidationError('yield_verdict', 'source_ref=outline 仅限 PLAN_CONFLICT；其他事实冲突请引用 entities/、manuscripts/、lore_library/ 或 world/ 的真实档案');
                    }
                    if (options.outlineText === undefined) {
                        throw new GateValidationError('yield_verdict', '当前运行未提供内存细纲，无法核验 source_ref=outline');
                    }
                    sourceText = options.outlineText;
                } else {
                    try {
                        sourceText = await loadSourceContent(store, runId, fence, sourceRef, stagingOverlay);
                    } catch (err: unknown) {
                        const message = (err instanceof Error ? err.message : String(err)).split(bookRoot).join('<bookRoot>');
                        throw new GateValidationError(
                            'yield_verdict',
                            `第 ${issueNumber} 条问题的 source_ref 无法读取 (${sourceRef}): ${message}`
                        );
                    }
                }
                const dual = verifyDualQuotes(draftQuote, resolvedDraft, sourceQuote, sourceText);
                if (!dual.sideA.matched || (targets && !matchesTargetParagraphs(targets, draftParagraphs, dual.sideA.normalizedQuote))) {
                    const previews = (targets ?? draftParagraphs.map((_, index) => index))
                        .map(index => `[P${index}] ${draftParagraphs[index]!.slice(0, 200)}`).join('\n');
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题的 quote_draft 未在${targets ? '指定段落' : '草稿正文'}中命中，请对照待审正文 [Pxx] 逐字复制：\n${previews}`
                    );
                }
                if (!dual.sideB.matched) {
                    throw new GateValidationError(
                        'yield_verdict',
                        `第 ${issueNumber} 条问题的 quote_source 未在 ${sourceRef} 中命中。${sourceQuoteHint(sourceQuote, sourceText, sourceRef)}`
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

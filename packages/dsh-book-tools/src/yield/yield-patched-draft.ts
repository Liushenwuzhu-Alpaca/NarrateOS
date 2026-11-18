import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ProseGateOptions } from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import {
    formatPatchViolationsText,
    type InMemoryDraftPatchSession
} from '../tools/patch-paragraphs.js';
import {
    YieldPatchedDraftInputSchema,
    type YieldPatchedDraftResult
} from './schemas.js';

/** yield_patched_draft 终态门禁工具构造选项 */
export interface YieldPatchedDraftOptions {
    session: InMemoryDraftPatchSession;
    proseGateOptions?: ProseGateOptions | undefined;
    enforceProseGateOnYield?: boolean | undefined;
    onYield?: ((result: YieldPatchedDraftResult) => void) | undefined;
}

/** 创建 Patch 终态门禁工具 yield_patched_draft（校验文稿非空与 StaticProseGate 复检） */
export function createYieldPatchedDraftTool(options: YieldPatchedDraftOptions): ToolDefinition {
    const { session, proseGateOptions, enforceProseGateOnYield, onYield } = options;

    return defineTool({
        name: 'yield_patched_draft',
        description:
            'Patch 局部修补终态交接门禁。核验当前内存文稿非空且通过 StaticProseGate（如已配置）后，提交最终修补正文并结束回合。',
        parameters: {
            summary: {
                type: 'string',
                description: '本轮修补变更简述（可选）'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    totalParagraphs: { type: 'integer', required: true },
                    editCount: { type: 'integer', required: true },
                    charCount: { type: 'integer', required: true },
                    summary: { type: 'string' }
                }
            },
            render(_args, value) {
                return [
                    {
                        type: 'text',
                        text: `yield_patched_draft 门禁通过：共 ${value.totalParagraphs} 段，累计编辑 ${value.editCount} 处（${value.charCount} 字）。`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const parsed = YieldPatchedDraftInputSchema.parse(args ?? {});
            const patchedProse = session.getProse();

            if (patchedProse.trim().length === 0) {
                throw new GateValidationError(
                    'yield_patched_draft',
                    '当前修补文稿为空，请先使用 patch_paragraphs 恢复有效正文后再提交'
                );
            }

            const effectiveGateOptions = proseGateOptions ?? session.proseGateOptions;
            if (effectiveGateOptions && enforceProseGateOnYield !== false) {
                const report = session.evaluateGateReport(effectiveGateOptions);
                if (report.configured && !report.passed) {
                    const detail = formatPatchViolationsText(report.violations, report.violatedParagraphs);
                    throw new GateValidationError(
                        'yield_patched_draft',
                        `StaticProseGate 终态复检未通过：仍有 ${report.violatedParagraphCount} 个违规段落 [${report.violatedParagraphIndices.join(', ')}]，请继续调用 patch_paragraphs 修正后重试。\n${detail}`
                    );
                }
            }

            const result: YieldPatchedDraftResult = {
                patchedProse,
                editCount: session.getEditCount(),
                ...(parsed.summary !== undefined ? { summary: parsed.summary } : {})
            };

            onYield?.(result);
            exec.concludeTurn();

            return {
                accepted: true,
                totalParagraphs: session.getParagraphs().length,
                editCount: result.editCount,
                charCount: patchedProse.replace(/\s+/g, '').length,
                ...(result.summary !== undefined ? { summary: result.summary } : {})
            };
        }
    });
}

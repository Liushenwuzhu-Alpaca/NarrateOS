import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import { GateValidationError } from '../errors.js';
import {
    createPatchParagraphsTool,
    InMemoryDraftPatchSession
} from '../tools/patch-paragraphs.js';
import type { YieldPatchedDraftResult } from './schemas.js';
import { createYieldPatchedDraftTool } from './yield-patched-draft.js';

function createSpyExec(name: string, args: unknown): {
    exec: ToolRunContext;
    concludedCount: () => number;
} {
    let concluded = 0;
    const exec: ToolRunContext = {
        token: Symbol('exec') as ToolRunContext['token'],
        callId: 'call-yield-patch-1' as ToolRunContext['callId'],
        rootCallId: 'call-yield-patch-1' as ToolRunContext['rootCallId'],
        name,
        arguments: args,
        signal: new AbortController().signal,
        deferContext() {},
        concludeTurn() {
            concluded += 1;
        }
    };
    return { exec, concludedCount: () => concluded };
}

describe('yield_patched_draft 终态门禁工具', () => {
    it('拒绝空文稿提交且不触发 onYield 或 concludeTurn', async () => {
        const session = new InMemoryDraftPatchSession('   \n\n  ');
        let yielded: YieldPatchedDraftResult | undefined;
        const yieldTool = createYieldPatchedDraftTool({
            session,
            onYield: (res) => {
                yielded = res;
            }
        });

        const spy = createSpyExec('yield_patched_draft', { summary: '尝试空提交' });
        await expect(yieldTool.execute({ summary: '尝试空提交' }, spy.exec)).rejects.toThrow(
            GateValidationError
        );
        expect(yielded).toBeUndefined();
        expect(spy.concludedCount()).toBe(0);
    });

    it('启用 StaticProseGate 时拒绝仍含违规段落的提交并输出违规定位清单，修补清零后放行', async () => {
        const draft = [
            '# 第一章 夜班',
            '',
            '他指节泛白，攥着半张提货单。',
            '',
            '值班室窗玻璃上结着薄霜。'
        ].join('\n');

        const proseGateOptions = {
            narrationSubjectivity: 'objective_third' as const,
            enableAntiCliche: true
        };

        const session = new InMemoryDraftPatchSession(draft, proseGateOptions);
        const patchTool = createPatchParagraphsTool({ session });

        let yielded: YieldPatchedDraftResult | undefined;
        const yieldTool = createYieldPatchedDraftTool({
            session,
            proseGateOptions,
            onYield: (res) => {
                yielded = res;
            }
        });

        // 1. 未修补直接提交 -> 被门禁拦截并给出违规定位清单
        const failSpy = createSpyExec('yield_patched_draft', { summary: '直接提交' });
        let caughtError: unknown;
        try {
            await yieldTool.execute({ summary: '直接提交' }, failSpy.exec);
        } catch (err: unknown) {
            caughtError = err;
        }
        expect(caughtError).toBeInstanceOf(GateValidationError);
        expect((caughtError as Error).message).toContain('[1]');
        expect((caughtError as Error).message).toContain('micro_anatomy');
        expect((caughtError as Error).message).not.toContain('指节泛白');
        expect((caughtError as Error).message).toContain('patch_paragraphs');
        expect(yielded).toBeUndefined();
        expect(failSpy.concludedCount()).toBe(0);

        // 2. 通过 patch_paragraphs 修正第 1 段后再提交 -> 门禁放行并回调 onYield
        const patchSpy = createSpyExec('patch_paragraphs', {
            edits: [
                {
                    start_paragraph: 1,
                    end_paragraph: 1,
                    replacement_paragraphs: ['他把半张提货单折进袖口，手掌贴上冷铁门框。']
                }
            ]
        });
        await patchTool.execute(patchSpy.exec.arguments, patchSpy.exec);

        const okSpy = createSpyExec('yield_patched_draft', { summary: '消除微距套话' });
        const result = await yieldTool.execute({ summary: '消除微距套话' }, okSpy.exec);

        expect(result).toMatchObject({
            accepted: true,
            totalParagraphs: 3,
            editCount: 1,
            summary: '消除微距套话'
        });
        expect(okSpy.concludedCount()).toBe(1);
        expect(yielded).toEqual({
            patchedProse: '# 第一章 夜班\n\n他把半张提货单折进袖口，手掌贴上冷铁门框。\n\n值班室窗玻璃上结着薄霜。',
            editCount: 1,
            summary: '消除微距套话'
        });
    });

    it('enforceProseGateOnYield=false 时仍校验至少编辑 1 处且正文变动，修改后跳过 StaticProseGate 终态复检直接提交', async () => {
        const session = new InMemoryDraftPatchSession('他眼神中闪过一丝寒意。');
        const patchTool = createPatchParagraphsTool({ session });
        let yielded: YieldPatchedDraftResult | undefined;

        const yieldTool = createYieldPatchedDraftTool({
            session,
            proseGateOptions: { enableAntiCliche: true },
            enforceProseGateOnYield: false,
            onYield: (res) => {
                yielded = res;
            }
        });

        // 零编辑直接提交必须被 ISS-043 拦截
        const zeroEditSpy = createSpyExec('yield_patched_draft', {});
        await expect(yieldTool.execute({}, zeroEditSpy.exec)).rejects.toThrow(GateValidationError);
        expect(zeroEditSpy.concludedCount()).toBe(0);

        // 实际调用 patch_paragraphs 修改后再提交 -> 跳过静态门禁复检并放行
        await patchTool.execute(
            {
                edits: [
                    {
                        start_paragraph: 0,
                        end_paragraph: 0,
                        replacement_paragraphs: ['他眼神中闪过一丝冷意，抬手合上铁门。']
                    }
                ]
            },
            createSpyExec('patch_paragraphs', {}).exec
        );

        const spy = createSpyExec('yield_patched_draft', {});
        await yieldTool.execute({}, spy.exec);

        expect(spy.concludedCount()).toBe(1);
        expect(yielded).toEqual({
            patchedProse: '他眼神中闪过一丝冷意，抬手合上铁门。',
            editCount: 1
        });
    });
});

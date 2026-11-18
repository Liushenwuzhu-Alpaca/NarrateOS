import { Context } from '@deepseek-ai/cordis';
import * as bookStorePlugin from '@narrateos/dsh-book-store';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { GateValidationError } from '../errors.js';
import * as bookToolsPlugin from '../index.js';
import type { YieldPatchedDraftResult } from '../yield/schemas.js';
import {
    createPatchParagraphsTool,
    InMemoryDraftPatchSession,
    type PatchParagraphsResult
} from './patch-paragraphs.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            await fn();
        }
    }
});

function createMockExec(name: string, args: unknown): ToolRunContext {
    return {
        token: Symbol('exec') as ToolRunContext['token'],
        callId: 'call-patch-1' as ToolRunContext['callId'],
        rootCallId: 'call-patch-1' as ToolRunContext['rootCallId'],
        name,
        arguments: args,
        signal: new AbortController().signal,
        deferContext() {},
        concludeTurn() {}
    };
}

describe('InMemoryDraftPatchSession 与 patch_paragraphs', () => {
    it('按空行拆分 0-based 段落并支持多区间逆序精准替换与 editCount 计数', async () => {
        const draft = [
            '第一段：雨夜码头风急。',
            '',
            '第二段：旧木箱堆在三号闸口。\n门锁已经生锈。',
            '',
            '第三段：值班室灯还亮着。',
            '',
            '第四段：远处的驳船拉响汽笛。'
        ].join('\n');

        const session = new InMemoryDraftPatchSession(draft);
        expect(session.getParagraphs()).toHaveLength(4);
        expect(session.getEditCount()).toBe(0);

        const tool = createPatchParagraphsTool({ session });
        const args = {
            edits: [
                {
                    start_paragraph: 0,
                    end_paragraph: 0,
                    replacement_paragraphs: ['第一段：北港的雪落在铁皮棚顶。']
                },
                {
                    start_paragraph: 2,
                    end_paragraph: 3,
                    replacement_paragraphs: [
                        '第三段（改）：值班室窗口透出昏黄灯光。',
                        '新增第四段：老周正低头翻看交接簿。',
                        '新增第五段：江面传来拖轮低沉的发动机声。'
                    ]
                }
            ]
        };

        const result = (await tool.execute(
            args,
            createMockExec('patch_paragraphs', args)
        )) as PatchParagraphsResult;

        expect(result.totalParagraphs).toBe(5);
        expect(result.editCount).toBe(2);
        expect(result.modifiedRanges).toEqual([
            { start_paragraph: 0, end_paragraph: 0, replaced_with_count: 1 },
            { start_paragraph: 2, end_paragraph: 3, replaced_with_count: 3 }
        ]);
        expect(result.titlePreserved).toBe(false);
        expect(result.passed).toBe(true);
        expect(result.message).toContain('内存段落替换已完成（未配置 StaticProseGate 实时复检）');
        expect(result.message).not.toContain('已通过静态文风门禁');
        expect(session.evaluateGateReport()).toEqual({
            configured: false,
            passed: true,
            violatedParagraphCount: 0,
            violatedParagraphIndices: [],
            violations: [],
            violatedParagraphs: []
        });
        expect(session.getEditCount()).toBe(2);
        expect(session.getParagraphs()).toEqual([
            '第一段：北港的雪落在铁皮棚顶。',
            '第二段：旧木箱堆在三号闸口。\n门锁已经生锈。',
            '第三段（改）：值班室窗口透出昏黄灯光。',
            '新增第四段：老周正低头翻看交接簿。',
            '新增第五段：江面传来拖轮低沉的发动机声。'
        ]);
        expect(session.getProse()).toBe(session.getParagraphs().join('\n\n'));
    });

    it('拦截非法区间（负数/小数/start>end/越界/重叠/空编辑）且不污染会话状态', async () => {
        const draft = '第一段。\n\n第二段。\n\n第三段。';
        const session = new InMemoryDraftPatchSession(draft);
        const tool = createPatchParagraphsTool({ session });

        const invalidCases = [
            { edits: [] },
            { edits: [{ start_paragraph: -1, end_paragraph: 0, replacement_paragraphs: ['x'] }] },
            { edits: [{ start_paragraph: 0.5, end_paragraph: 1, replacement_paragraphs: ['x'] }] },
            { edits: [{ start_paragraph: 2, end_paragraph: 1, replacement_paragraphs: ['x'] }] },
            { edits: [{ start_paragraph: 1, end_paragraph: 3, replacement_paragraphs: ['x'] }] },
            {
                edits: [
                    { start_paragraph: 0, end_paragraph: 1, replacement_paragraphs: ['a'] },
                    { start_paragraph: 1, end_paragraph: 2, replacement_paragraphs: ['b'] }
                ]
            }
        ];

        for (const badArgs of invalidCases) {
            await expect(
                tool.execute(badArgs, createMockExec('patch_paragraphs', badArgs))
            ).rejects.toThrow();
        }

        expect(session.getEditCount()).toBe(0);
        expect(session.getProse()).toBe(draft);
    });

    it('原第 0 段为 # 一级标题且替换后失去 # 前缀时自动保留原标题行并提示', async () => {
        const draft = '# 第一章 寒潮夜泊\n\n沈默推开铁门。\n\n桌上有半张提货单。';
        const session = new InMemoryDraftPatchSession(draft);
        const tool = createPatchParagraphsTool({ session });

        // 1. 替换第 0 段但丢失 # 前缀 -> 自动保留 '# 第一章 寒潮夜泊'
        const loseHeadingArgs = {
            edits: [
                {
                    start_paragraph: 0,
                    end_paragraph: 0,
                    replacement_paragraphs: ['重写后的开场第一段。']
                }
            ]
        };
        const res1 = (await tool.execute(
            loseHeadingArgs,
            createMockExec('patch_paragraphs', loseHeadingArgs)
        )) as PatchParagraphsResult;

        expect(res1.titlePreserved).toBe(true);
        expect(res1.totalParagraphs).toBe(4);
        expect(res1.message).toContain('# 第一章 寒潮夜泊');
        expect(session.getParagraphs()[0]).toBe('# 第一章 寒潮夜泊');
        expect(session.getParagraphs()[1]).toBe('重写后的开场第一段。');

        // 2. 删除第 0 段 ([] ) 同样自动保留原标题行
        const deleteHeadingArgs = {
            edits: [{ start_paragraph: 0, end_paragraph: 0, replacement_paragraphs: [] }]
        };
        const res2 = (await tool.execute(
            deleteHeadingArgs,
            createMockExec('patch_paragraphs', deleteHeadingArgs)
        )) as PatchParagraphsResult;

        expect(res2.titlePreserved).toBe(true);
        expect(session.getParagraphs()[0]).toBe('# 第一章 寒潮夜泊');

        // 3. 若显式替换成另一个 # 标题，则尊重更新后的标题且 titlePreserved=false
        const replaceHeadingArgs = {
            edits: [
                {
                    start_paragraph: 0,
                    end_paragraph: 0,
                    replacement_paragraphs: ['# 第一章 新拟标题']
                }
            ]
        };
        const res3 = (await tool.execute(
            replaceHeadingArgs,
            createMockExec('patch_paragraphs', replaceHeadingArgs)
        )) as PatchParagraphsResult;

        expect(res3.titlePreserved).toBe(false);
        expect(session.getParagraphs()[0]).toBe('# 第一章 新拟标题');
    });

    it('配置 proseGateOptions 时每次编辑实时运行 StaticProseGate 并返回违规明细、带 [index] 正文与通过提示', async () => {
        const draft = [
            '# 第一章 雨夜交接',
            '',
            '沈默指节泛白，死死盯着铁门把手。',
            '',
            '老周嘴角浮现一丝冷意，转身收起账本。'
        ].join('\n');

        const session = new InMemoryDraftPatchSession(draft, {
            narrationSubjectivity: 'objective_third',
            enableAntiCliche: true
        });
        const tool = createPatchParagraphsTool({ session });

        // 第一轮：把第 1 段拆成两段洁净正文，第 2 段因此顺移到新索引 3，且仍含 "一丝" 违规
        const round1Args = {
            edits: [
                {
                    start_paragraph: 1,
                    end_paragraph: 1,
                    replacement_paragraphs: [
                        '沈默攥紧湿透的袖口，指腹蹭过门锁铜环。',
                        '铁门合页发出短促的吱呀声。'
                    ]
                }
            ]
        };
        const res1 = (await tool.execute(
            round1Args,
            createMockExec('patch_paragraphs', round1Args)
        )) as PatchParagraphsResult;

        expect(res1.totalParagraphs).toBe(4);
        expect(res1.passed).toBe(false);
        expect(res1.violatedParagraphCount).toBe(1);
        expect(res1.violatedParagraphIndices).toEqual([3]);
        expect(res1.violations).toHaveLength(1);
        expect(res1.violations[0]).toMatchObject({
            paragraphIndex: 3,
            ruleId: 'filler_trace',
            matchedText: '一丝',
            lineText: '老周嘴角浮现一丝冷意，转身收起账本。'
        });
        expect(res1.violations[0]!.line).toBeGreaterThan(1);
        expect(res1.violations[0]!.column).toBeGreaterThan(0);
        expect(res1.violatedParagraphs).toEqual([
            { index: 3, text: '老周嘴角浮现一丝冷意，转身收起账本。' }
        ]);

        const rendered1 = tool.output!.render!(round1Args, res1);
        const rendered1Text = rendered1.map((part) => ('text' in part ? part.text : '')).join('\n');
        expect(rendered1Text).toContain('[3] 老周嘴角浮现一丝冷意，转身收起账本。');
        expect(rendered1Text).toContain('filler_trace');

        // 第二轮：修补第 3 段，门禁全部清零并提示调用 yield_patched_draft
        const round2Args = {
            edits: [
                {
                    start_paragraph: 3,
                    end_paragraph: 3,
                    replacement_paragraphs: ['老周合上牛皮封面账本，把铜镇纸压在扉页上。']
                }
            ]
        };
        const res2 = (await tool.execute(
            round2Args,
            createMockExec('patch_paragraphs', round2Args)
        )) as PatchParagraphsResult;

        expect(res2.passed).toBe(true);
        expect(res2.violatedParagraphCount).toBe(0);
        expect(res2.violatedParagraphIndices).toEqual([]);
        expect(res2.violations).toEqual([]);
        expect(res2.violatedParagraphs).toEqual([]);
        expect(res2.message).toContain('yield_patched_draft');
        expect(res2.editCount).toBe(2);
    });

    it('NarrateToolsService.buildRoleTools 在纯内存模式下共享 InMemoryDraftPatchSession 且无需 bookRoot 与 StagingSession', async () => {
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin);
        cleanups.push(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin);
        cleanups.push(() => toolsFiber.dispose());

        // 1. 缺少或空 draftText 时立即抛出明确异常
        expect(() =>
            ctx.narrateTools.buildRoleTools({
                tools: ['patch_paragraphs'],
                yieldTool: 'yield_patched_draft'
            })
        ).toThrow('draftText');
        expect(() =>
            ctx.narrateTools.buildRoleTools({
                tools: ['patch_paragraphs'],
                yieldTool: 'yield_patched_draft',
                draftText: '   \n  '
            })
        ).toThrow('draftText');

        // 2. 无 bookRoot 且不创建 StagingSession 的纯内存修补闭环
        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-in-memory-patch',
            tools: ['patch_paragraphs'],
            yieldTool: 'yield_patched_draft',
            draftText: '# 第一章\n\n他指节泛白，死死盯着铁门。',
            proseGateOptions: {
                narrationSubjectivity: 'objective_third',
                enableAntiCliche: true
            },
            enforceProseGateOnYield: true
        });
        cleanups.push(() => roleSet.cleanup());

        expect(ctx.narrateStore.staging.has('run-in-memory-patch')).toBe(false);
        expect(roleSet.bookRoot).toBeUndefined();
        expect(roleSet.fence).toBeUndefined();
        expect(roleSet.toolMap.has('patch_paragraphs')).toBe(true);
        expect(roleSet.toolMap.has('yield_patched_draft')).toBe(true);
        expect(roleSet.hasYielded()).toBe(false);

        const patchTool = roleSet.toolMap.get('patch_paragraphs')!;
        const yieldTool = roleSet.toolMap.get('yield_patched_draft')!;

        // 未修补直接提交 -> 被共享会话门禁拦截
        await expect(
            yieldTool.execute({ summary: '未修补' }, createMockExec('yield_patched_draft', {}))
        ).rejects.toThrow(GateValidationError);
        expect(roleSet.hasYielded()).toBe(false);

        // 修补后再次提交 -> 共享同一会话，顺利通过并记录 yieldResult
        const patchArgs = {
            edits: [
                {
                    start_paragraph: 1,
                    end_paragraph: 1,
                    replacement_paragraphs: ['他双手插进大衣口袋，掌心贴着冷硬的黄铜钥匙。']
                }
            ]
        };
        const patchRes = (await patchTool.execute(
            patchArgs,
            createMockExec('patch_paragraphs', patchArgs)
        )) as PatchParagraphsResult;
        expect(patchRes.passed).toBe(true);

        await yieldTool.execute(
            { summary: '替换微距动作' },
            createMockExec('yield_patched_draft', { summary: '替换微距动作' })
        );
        expect(roleSet.hasYielded()).toBe(true);
        expect(roleSet.getYieldResult<YieldPatchedDraftResult>()).toEqual({
            patchedProse: '# 第一章\n\n他双手插进大衣口袋，掌心贴着冷硬的黄铜钥匙。',
            editCount: 1,
            summary: '替换微距动作'
        });
    });

    it('buildRoleTools({ yieldTool: "yield_patched_draft", draftText }) 缺省 tools 时不挂载磁盘工具且不开启 StagingSession', async () => {
        const ctx = new Context();
        const storeFiber = await ctx.plugin(bookStorePlugin);
        cleanups.push(() => storeFiber.dispose());
        const toolsFiber = await ctx.plugin(bookToolsPlugin);
        cleanups.push(() => toolsFiber.dispose());

        const roleSet = ctx.narrateTools.buildRoleTools({
            runId: 'run-yield-only-patch',
            yieldTool: 'yield_patched_draft',
            draftText: '# 第一章\n\n干净正文段落。'
        });
        cleanups.push(() => roleSet.cleanup());

        expect(ctx.narrateStore.staging.has('run-yield-only-patch')).toBe(false);
        expect(roleSet.bookRoot).toBeUndefined();
        expect(roleSet.fence).toBeUndefined();
        expect(roleSet.tools.map((t) => t.name)).toEqual(['yield_patched_draft']);
        for (const diskTool of ['book_read', 'book_grep', 'book_glob', 'book_edit']) {
            expect(roleSet.toolMap.has(diskTool)).toBe(false);
        }

        await expect(
            roleSet.toolMap.get('yield_patched_draft')!.execute(
                { summary: '直接提交' },
                createMockExec('yield_patched_draft', { summary: '直接提交' })
            )
        ).rejects.toThrow(GateValidationError);
        expect(roleSet.hasYielded()).toBe(false);
    });

    it('拒绝通过 patch_paragraphs 将全部非标题正文段落删空 (ISS-042)', async () => {
        const sessionWithHeading = new InMemoryDraftPatchSession('# 第一章\n\n仅此一段正文。');
        const tool1 = createPatchParagraphsTool({ session: sessionWithHeading });
        await expect(
            tool1.execute(
                {
                    edits: [{ start_paragraph: 1, end_paragraph: 1, replacement_paragraphs: [] }]
                },
                createMockExec('patch_paragraphs', {})
            )
        ).rejects.toThrow(/非 # 标题正文段落/);
        expect(sessionWithHeading.getParagraphs()).toEqual(['# 第一章', '仅此一段正文。']);
        expect(sessionWithHeading.getEditCount()).toBe(0);

        const sessionNoHeading = new InMemoryDraftPatchSession('第一段。\n\n第二段。');
        const tool2 = createPatchParagraphsTool({ session: sessionNoHeading });
        await expect(
            tool2.execute(
                {
                    edits: [{ start_paragraph: 0, end_paragraph: 1, replacement_paragraphs: [] }]
                },
                createMockExec('patch_paragraphs', {})
            )
        ).rejects.toThrow(/非 # 标题正文段落/);
        expect(sessionNoHeading.getParagraphs()).toEqual(['第一段。', '第二段。']);
        expect(sessionNoHeading.getEditCount()).toBe(0);
    });
});

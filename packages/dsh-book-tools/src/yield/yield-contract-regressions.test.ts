import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import * as storePlugin from '@narrateos/dsh-book-store';
import { afterEach, describe, expect, it } from 'vitest';
import { createYieldOutlineTool } from './yield-outline.js';
import { createYieldVerdictTool } from './yield-verdict.js';
import { createYieldStatePatchTool, type YieldStatePatchResult } from './yield-state-patch.js';
import { createYieldContextPackTool } from './yield-context-pack.js';
import { findNegativeDirectives } from './negative-directives.js';
import { ExtractorOutputSchema } from './schemas.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
function exec(): ToolRunContext {
    return { token: Symbol('exec') as ToolRunContext['token'], callId: 'call' as ToolRunContext['callId'], rootCallId: 'call' as ToolRunContext['rootCallId'], name: 'yield', arguments: {}, signal: new AbortController().signal, deferContext() {}, concludeTurn() {} };
}
const outline = { chapter_title: '校门口', target_word_count: 2000, focus_cast: ['char_001'], director_rationale: '', chapter_turn: '警示条挡住去路', scene_plan: [{ scene_index: 1, location: '校门', summary: '二人核对标牌' }], outline_text: '她微不可察地一颤，指向印着“禁止通行”的警示条，提醒同伴不要提到昨晚的事。' };
async function book() {
    const root = await mkdtemp(join(tmpdir(), 'yield-contract-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    for (const dir of ['world', 'entities/cold_archive', 'manuscripts', '.ops']) await mkdir(join(root, dir), { recursive: true });
    const ctx = new Context();
    const fiber = await ctx.plugin(storePlugin, { bookRoot: root });
    cleanups.push(() => fiber.dispose());
    return { root, store: ctx.narrateStore };
}

describe('剧情与事实交接回归', () => {
    it('每实体单章履历限额不能通过拆分补丁绕过，普通状态不受影响', () => {
        const trajectory = { op: 'append', entry: { text: '身份揭破后永失继承权', chapter: 2 } };
        const patch = { entity_id: 'char_001', last_seen_ch: 2, trajectory_ops: [trajectory] };
        const payload = { plot_summary: '继承权被撤销', entity_patches: [patch] };
        expect(ExtractorOutputSchema.parse(payload).entity_patches[0]?.trajectory_ops).toEqual([trajectory]);
        expect(ExtractorOutputSchema.safeParse({ ...payload, entity_patches: [{ ...patch, trajectory_ops: [trajectory, trajectory] }] }).success).toBe(false);
        expect(ExtractorOutputSchema.safeParse({ ...payload, entity_patches: [patch, patch] }).success).toBe(false);
        const independent = ExtractorOutputSchema.parse({ ...payload, entity_patches: [patch, { ...patch, entity_id: 'char_002' }, { entity_id: 'char_001', last_seen_ch: 2, buffer_ops: [{ op: 'append', entry: { text: '暂居旧港' } }] }] });
        expect(independent.entity_patches[2]?.buffer_ops).toEqual([{ op: 'append', entry: { text: '暂居旧港' } }]);
    });

    it('放行剧情否定表达，并准确定位独立字段内的写作指令', async () => {
        const tool = createYieldOutlineTool();
        await expect(tool.execute(outline, exec())).resolves.toMatchObject({ accepted: true });
        await expect(tool.execute({ ...outline, chapter_turn: '本章不要泄露谜底。' }, exec())).rejects.toThrow('[chapter_turn]');
        await expect(tool.execute({ ...outline, outline_text: '她提醒同伴切勿透露姓名。' }, exec())).resolves.toMatchObject({ accepted: true });
    });

    it('接受相邻段落引文，拒绝隔段拼接并提示目标原文', async () => {
        const { root, store } = await book();
        await writeFile(join(root, 'world/current_arc_envelope.md'), '红色制服是本校常服。');
        const draft = ['# 校门', '她穿着蓝色制服。', '胸前扣着银色校徽。', '值班员合上名册。', '院里响起铃声。', '队伍走进大厅。', '门边留下木箱。'].join('\n\n');
        const tool = createYieldVerdictTool({ store, bookRoot: root, runId: 'cross', draftText: draft });
        const issue = { severity: 'LOCAL_PATCH', paragraph_indices: [1, 2], description: '制服色彩冲突', quote_draft: '她穿着蓝色制服。\n胸前扣着银色校徽。', source_ref: 'world/current_arc_envelope.md', quote_source: '红色制服是本校常服。' };
        await expect(tool.execute({ passed: false, issues: [issue] }, exec())).resolves.toMatchObject({ accepted: true });
        await expect(tool.execute({ passed: false, issues: [{ ...issue, paragraph_indices: [1, 3], quote_draft: '她穿着蓝色制服。值班员合上名册。' }] }, exec())).rejects.toThrow('[P1]');
    });

    it('只允许计划冲突使用内存细纲来源', async () => {
        const { root, store } = await book();
        const tool = createYieldVerdictTool({ store, bookRoot: root, runId: 'outline', draftText: '她走进教室。', outlineText: '她留在校门口。' });
        const issue = { severity: 'PLAN_CONFLICT', description: '场景错位', quote_draft: '她走进教室。', source_ref: 'outline', quote_source: '她留在校门口。' };
        await expect(tool.execute({ passed: false, issues: [issue] }, exec())).resolves.toMatchObject({ accepted: true });
        await expect(tool.execute({ passed: false, issues: [{ ...issue, severity: 'MULTI_REWRITE' }] }, exec())).rejects.toThrow('仅限 PLAN_CONFLICT');
    });

    it('冷宫仅在磁盘缺失时回退，分支删除仍遮蔽磁盘', async () => {
        const { root, store } = await book();
        await writeFile(join(root, 'entities/cold_archive/char_001.md'), '她左手旧伤无法提箱。');
        const issue = { severity: 'MULTI_REWRITE', description: '旧伤冲突', quote_draft: '她左手提起木箱。', source_ref: 'entities/char_001.md', quote_source: '她左手旧伤无法提箱。' };
        const options = { store, bookRoot: root, runId: 'cold', draftText: issue.quote_draft };
        await expect(createYieldVerdictTool(options).execute({ passed: false, issues: [issue] }, exec())).resolves.toMatchObject({ accepted: true });
        const blocked = createYieldVerdictTool({ ...options, stagingOverlay: new Map([['entities/char_001.md', null]]) });
        await expect(blocked.execute({ passed: false, issues: [issue] }, exec())).rejects.toThrow('当前分支视图中不存在');
    });

    it('仅为高重合引文回显依据并要求反义自检', async () => {
        const { root, store } = await book();
        const source = '她在周五清晨穿着红色校服来到旧校舍门口。';
        await writeFile(join(root, 'world/current_arc_envelope.md'), source);
        const tool = createYieldVerdictTool({ store, bookRoot: root, runId: 'hint', draftText: '她穿着蓝色校服。' });
        const issue = { severity: 'MULTI_REWRITE', description: '校服颜色', quote_draft: '她穿着蓝色校服。', source_ref: 'current_arc_envelope.md', quote_source: source.replace('红色', '蓝色') };
        await expect(tool.execute({ passed: false, issues: [issue] }, exec())).rejects.toThrow('请直接删除该条误报 issue');
        const mismatch = await tool.execute({ passed: false, issues: [{ ...issue, quote_source: '海港仓库正在装卸盐袋。' }] }, exec()).catch((error: unknown) => error);
        expect(mismatch).toBeInstanceOf(Error);
        expect((mismatch as Error).message).toContain('未找到与 quote_source 相近的表述');
        expect((mismatch as Error).message).not.toContain(source);
    });

    it('静态纪律保留禁令拦截但放行复合成语，剧情定位不受短引号影响', () => {
        expect(findNegativeDirectives('微不可察的句法变化不可或缺。', 'discipline')).toEqual([]);
        expect(findNegativeDirectives('不要堆砌形容词。', 'discipline')[0]?.text).toBe('不要');
        const text = '牌上写着「禁止通行」。本章不要泄底。';
        const hits = findNegativeDirectives(text, 'narrative');
        expect(hits).toHaveLength(1);
        expect(hits[0]?.index).toBe(text.indexOf('本章'));
    });

    it('既有别名不会触发改名锁，新建实体保留中文标准名', async () => {
        const { root, store } = await book();
        const profile = storePlugin.parseEntityMarkdown('---\nentity_id: char_001\ncanonical_name: 沈默\nunique_aliases: [小沈]\ncontextual_titles: [班长]\nhistorical_anchors: []\nlast_seen_ch: 1\n---\n\n' + Object.values(storePlugin.DEFAULT_SECTION_HEADINGS).join('\n\n'));
        let yielded: YieldStatePatchResult | undefined;
        const tool = createYieldStatePatchTool({ store, bookRoot: root, chapterNumber: 2, deferCommit: true, visibleEntities: new Map([['char_001', profile]]), onYield: value => { yielded = value; } });
        await tool.execute({ entity_patches: [{ entity_id: 'char_001', canonical_name: '小沈', last_seen_ch: 2 }, { entity_id: 'item_key', canonical_name: '钥匙', buffer_ops: [{ op: 'append', entry: { text: '钥匙落在桌上', storyDay: 1 } }] }], story_day_delta: 0, plot_summary: '交还钥匙' }, exec());
        expect(yielded?.output.entity_patches[0]?.canonical_name).toBeUndefined();
        expect(yielded?.output.entity_patches[1]?.canonical_name).toBe('钥匙');
    });

    it('手填召回切片接受实体已知职务称谓', async () => {
        const { root, store } = await book();
        await mkdir(join(root, 'index/L2_cards'), { recursive: true });
        await writeFile(join(root, 'world/book_config.yaml'), 'book_slug: title-test\ntitle: 称谓测试\ntokens_per_char: 0.6\n');
        await writeFile(join(root, 'entities/char_001.md'), '---\nentity_id: char_001\ncanonical_name: 沈默\nunique_aliases: []\ncontextual_titles: [班长]\nhistorical_anchors: []\nlast_seen_ch: 1\n---\n\n' + Object.values(storePlugin.DEFAULT_SECTION_HEADINGS).join('\n\n'));
        await writeFile(join(root, 'manuscripts/ch_0001.md'), '# 放学\n\n班长关上教室门。');
        await writeFile(join(root, 'index/L2_cards/vol_01_cards.md'), '## ch_0001\n- 出场实体：char_001\n');
        const tool = createYieldContextPackTool({ store, bookRoot: root, runId: 'title', targetChapter: 2, targetDay: 1 });
        await expect(tool.execute({ selected_entity_ids: ['char_001'], recall_slices: [{ entity_id: 'char_001', file: 'manuscripts/ch_0001.md', snippet: '班长关上教室门。' }], selected_lore_files: [] }, exec())).resolves.toMatchObject({ accepted: true, recalledSliceCount: 1 });
    });
});

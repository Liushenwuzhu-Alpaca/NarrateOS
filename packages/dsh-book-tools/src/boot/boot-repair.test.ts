import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LockCharterAndBootInputSchema, lockCharterAndBoot, type LockCharterAndBootInput } from './lock-charter-and-boot.js';
import { createYieldBootBundleTool } from '../yield/yield-boot-bundle.js';
import { CompiledEntitySchema, type BootBundleOutput } from '../yield/schemas.js';
import { validateBootBundle } from './boot-validation.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function input(): LockCharterAndBootInput {
    return {
        book_slug: 'boot-repair', title: '码头记录', pov_character: 'char_zhou', t0_anchor: '周平坐在码头值班室。',
        commitments: ['追查遗失的货单'], stage_ceiling: '货单签批人的姓名留待下一卷揭晓',
        opening_sequence_beats: ['甲', '乙', '丙'].map(beat_label => ({ beat_label, craft_focus: '核对货单', clue_budget: '货单日期', completion_sign: '找到账册对应行' })),
        current_arc_envelope: '周平带着账册走进值班室。', static_base_and_voice: '短句推进，动作衔接对白。',
        world_summary: '码头正在核对上一班的货单。', l1_volumes_markdown: '# 卷表\n\n- vol_01: 货单',
        entities: [{ entityId: 'char_zhou', canonicalName: '周平' }]
    };
}
function payload() {
    return LockCharterAndBootInputSchema.parse(input());
}
const goodVoice = { tag: '动作', sample: '她把茶杯挪到桌角，拿起账本翻到昨天那一页。', source: 'boot_seed' as const };

describe('开书编译输入与容错回归', () => {
    it('多人知情名单逐个校验实体，支持空格并拒绝名单中未知成员', () => {
        const data = payload();
        data.entities.push(CompiledEntitySchema.parse({ entityId: 'char_li', canonicalName: '李四' }));
        const known = { storyDay: 0, visibility: 'SELF_ONLY' as const, owner: 'char_zhou, char_li', text: '两人已核对过货单' };
        data.entities[0]!.acquiredState.push(known);
        data.entities[0]!.irreversibleTrajectory.push({ ...known });
        data.entities[0]!.recentBuffer.push({ ...known });
        expect(validateBootBundle(data, { narrationSubjectivity: 'objective_third', voiceSampleMode: 'filter' }).issues).toEqual([]);
        data.entities[0]!.acquiredState[0]!.owner = 'char_zhou, char_missing';
        expect(validateBootBundle(data, { narrationSubjectivity: 'objective_third', voiceSampleMode: 'filter' }).issues.join()).toContain('char_missing');
    });
    it('实际建库将单行双转义文档还原，已有真实换行的字面字符保持原样', async () => {
        const root = await mkdtemp(join(tmpdir(), 'narrate-boot-repair-')); roots.push(root);
        const data = input();
        data.l0_sagas_markdown = '# 总表\\n\\n- 卷一';
        data.l1_volumes_markdown = '# 卷表\\n\\n- vol_01: 货单';
        data.static_base_and_voice = '短句推进。\\n动作衔接对白。';
        data.current_arc_envelope = '# 舞台\n牌子上的字符是\\n。';
        const result = await lockCharterAndBoot(data, { booksRoot: root });
        expect(await readFile(join(result.bookRoot, 'index/L0_sagas.md'), 'utf8')).toBe('# 总表\n\n- 卷一\n');
        expect(await readFile(join(result.bookRoot, 'index/L1_volumes.md'), 'utf8')).toBe('# 卷表\n\n- vol_01: 货单\n');
        expect(await readFile(join(result.bookRoot, 'world/static_base_and_voice.md'), 'utf8')).toContain('短句推进。\n动作衔接对白。');
        expect(await readFile(join(result.bookRoot, 'world/current_arc_envelope.md'), 'utf8')).toContain('字符是\\n。');
    });
    it('剧情牌匾与成语通过，文风负指令及剧情元禁令仍被拦截', () => {
        const data = payload();
        data.current_arc_envelope = '门上贴着“禁止通行”，他微不可察地退后，提醒她不要提到昨夜的事。';
        expect(validateBootBundle(data, { narrationSubjectivity: 'objective_third', voiceSampleMode: 'filter' }).issues).toEqual([]);
        data.static_base_and_voice = '不要堆砌形容词';
        expect(validateBootBundle(data, { narrationSubjectivity: 'objective_third', voiceSampleMode: 'filter' }).issues.join()).toContain('static_base_and_voice');
        data.static_base_and_voice = '短句推进'; data.current_arc_envelope = '作者不要写出真相';
        expect(validateBootBundle(data, { narrationSubjectivity: 'objective_third', voiceSampleMode: 'filter' }).issues.join()).toContain('current_arc_envelope');
    });
    it('少量坏种子被过滤，整批失败报告原始下标和原因', () => {
        const data = { ...payload(), voice_samples: [{ ...goodVoice, sample: '太短' }, goodVoice] };
        const outcome = validateBootBundle(data, { narrationSubjectivity: 'objective_third', voiceSampleMode: 'filter' });
        expect(outcome.issues).toEqual([]); expect(outcome.cleanVoiceSamples).toEqual([goodVoice]);
        data.voice_samples = [{ ...goodVoice, sample: '太短' }];
        const failure = validateBootBundle(data, { narrationSubjectivity: 'objective_third', voiceSampleMode: 'filter' });
        expect(failure.issues.join()).toContain('voice_samples[0]'); expect(failure.issues.join()).toContain('15~45');
    });
    it('yield_boot_bundle 只交付过滤后样本', async () => {
        let accepted: BootBundleOutput | undefined;
        const tool = createYieldBootBundleTool({ onYield: value => { accepted = value; } });
        await tool.execute!({ ...payload(), voice_samples: [{ ...goodVoice, sample: '太短' }, goodVoice] }, { signal: new AbortController().signal, concludeTurn() {} } as never);
        expect(accepted && 'voice_samples' in accepted ? accepted.voice_samples : []).toEqual([goodVoice]);
    });
    it('双命名实体与嵌套条目归一化，冲突拼写拒绝覆盖', () => {
        const normalized = CompiledEntitySchema.parse({
            entity_id: 'char_zhou', canonicalName: '周平',
            acquired_state: [{ story_day: -1, slot_key: 'location', text: '坐在码头值班室' }]
        });
        expect(normalized).toMatchObject({ entityId: 'char_zhou', canonicalName: '周平', acquiredState: [{ storyDay: -1, slotKey: 'location' }] });
        expect(() => CompiledEntitySchema.parse({ entity_id: 'char_zhou', entityId: 'char_other', canonical_name: '周平' })).toThrow('不一致');
        expect(() => CompiledEntitySchema.parse({ entity_id: 'char_zhou' })).toThrow();
    });
});

import { expect, it } from 'vitest';
import { parseL2CardSections, upsertVolumeCardEntry } from './index-recall.js';

it('覆写历史章不解释替换模板，读回完整剧情、逐字锚点和正确的出场名单', () => {
    const legacy = '# 卷\n\n## ch_0001 (day:0)\n- 主干: 她交回钥匙。\n他关上门。\n- 锚点: 旧钟、旧船\n- 出场实体: char_old\n\n## ch_0002 (day:1)\n- 主干剧情：次章\n';
    const old = parseL2CardSections(legacy).sections;
    expect(old[0]).toMatchObject({ plotSummary: '她交回钥匙。\n他关上门。', anomalyAnchors: ['旧钟', '旧船'] });
    const plotSummary = '票面印着 $&\n## ch_9999\n- 异象锚点：字面文本';
    const anomalyAnchors = ['甲、乙两枚印章', '1,234', '无'];
    const appearedEntityIds = ['char_new'];
    const updated = upsertVolumeCardEntry(legacy, 1, 1, 2, plotSummary, appearedEntityIds, anomalyAnchors);
    const { sections } = parseL2CardSections(updated);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ plotSummary, anomalyAnchors, appearedEntityIds, dayLabel: 'day:2' });
    expect(sections[1]).toEqual(old[1]);
    expect(upsertVolumeCardEntry(updated, 1, 1, 2, plotSummary, appearedEntityIds, anomalyAnchors)).toBe(updated);
});

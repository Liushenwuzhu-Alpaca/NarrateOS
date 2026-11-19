import { describe, expect, it } from 'vitest';
import { InMemoryDraftPatchSession, formatPatchViolationsText } from './patch-paragraphs.js';

 describe('局部修补跨轮坐标与净室诊断', () => {
    it('拆段后返回当前坐标，并能按新坐标修改后续段落', () => {
        const session = new InMemoryDraftPatchSession('# 夜班\n\n开门。\n\n交接簿留在桌上。');
        const first = session.applyEdits([{ start_paragraph: 1, end_paragraph: 1, replacement_paragraphs: ['推门。', '走进屋内。'] }]);
        expect(first.message).toContain('[3] 交接簿留在桌上。');
        const second = session.applyEdits([{ start_paragraph: 3, end_paragraph: 3, replacement_paragraphs: ['交接簿已装入袋中。'] }]);
        expect(session.getProse()).toBe('# 夜班\n\n推门。\n\n走进屋内。\n\n交接簿已装入袋中。');
        expect(second.message).not.toContain('段落数量已变化');
    });

    it('诊断保留位置及跨章信息，同时去掉命中原词回显', () => {
        const session = new InMemoryDraftPatchSession('# 夜班\n\n他的喉结上下滚动。', {
            narrationSubjectivity: 'objective_third',
            enableAntiCliche: true
        });
        const report = session.evaluateGateReport();
        expect(report.passed).toBe(false);
        const text = formatPatchViolationsText(report.violations, report.violatedParagraphs);
        expect(text).toContain('line');
        expect(text).toContain('整体肢体动作');
        expect(JSON.stringify(report)).not.toContain('喉结上下滚动');
    });
});

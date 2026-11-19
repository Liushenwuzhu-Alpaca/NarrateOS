import { expect, it } from 'vitest';
import { ExtractorOutputSchema } from './schemas.js';

it('空白主字段回退旧摘要，空白世界摘要不构成更新，归一化可重复执行', () => {
    for (const plot_summary of ['', ' \t', undefined]) {
        const output = ExtractorOutputSchema.parse({ plot_summary, chapter_summary: ' 交回钥匙 ', world_summary_markdown: '\n' });
        expect(output.plot_summary).toBe('交回钥匙');
        expect(output.chapter_summary).toBe('交回钥匙');
        expect(output.world_summary_markdown).toBeUndefined();
        expect(ExtractorOutputSchema.parse(output)).toEqual(output);
    }
    expect(ExtractorOutputSchema.safeParse({ plot_summary: ' ', chapter_summary: '\n' }).success).toBe(false);
});

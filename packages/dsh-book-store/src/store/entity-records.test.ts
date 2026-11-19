import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTION_HEADINGS, parseEntityMarkdown, serializeEntityMarkdown } from './entity-parser.js';
import type { EntityEntry, EntityProfile } from './schemas.js';

describe('实体卡在下一次快照读取时保留条目边界', () => {
    const metadata = { entity_id: 'char_p', canonical_name: '甲', unique_aliases: [], contextual_titles: [], historical_anchors: [], last_seen_ch: 1 };
    it.each<EntityEntry>([
        { text: '放下船契\n转身离港', continuationLines: [] },
        { text: '', continuationLines: [] },
        { text: '[vis: PUBLIC] 字面标签', continuationLines: ['## 2. 标题', '- 列表', '', ' 跨\n行'] },
        { text: '银: 2', isNumericLedger: true, ledger: { 银: '2' }, owner: 'char_p', visibility: 'SELF_ONLY', continuationLines: [] }
    ])('逐字段保留 $text', (entry) => {
        const profile: EntityProfile = { metadata, sectionHeadings: DEFAULT_SECTION_HEADINGS, innateLocks: [], acquiredState: [entry], irreversibleTrajectory: [], recentBuffer: [] };
        expect(parseEntityMarkdown(serializeEntityMarkdown(profile))).toEqual(profile);
    });
});

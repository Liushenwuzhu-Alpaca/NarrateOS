import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
    EntityEntry,
    EntityEntrySchema,
    EntityMetadataSchema,
    EntityProfile,
    EntryStatus,
    EntryVisibility
} from './schemas.js';

const FORBIDDEN_TAG_CHARS_RE = /[|\[\]\r\n]/;
const FORBIDDEN_LEDGER_VALUE_RE = /[|\r\n]/;

/** 校验实体元标签键值不得包含分隔符 '|'、'['、']' 或换行符 */
export function assertSafeEntityTagValue(label: string, value: string): void {
    if (FORBIDDEN_TAG_CHARS_RE.test(value)) {
        throw new Error(`实体标签 ${label} 禁止包含 '|', '[', ']' 或换行符: ${value}`);
    }
}

/** 校验数值账本值不得包含管道符或换行符 */
export function assertSafeLedgerValue(value: string): void {
    if (FORBIDDEN_LEDGER_VALUE_RE.test(value)) {
        throw new Error(`实体数值账本值禁止包含 '|' 或换行符: ${value}`);
    }
}

/** 校验单条实体记录的 slotKey、owner、rawInvalidVisibility、extraTags 与数值账本键值安全性 */
export function assertEntryTagsSafe(
    entry: Pick<
        EntityEntry,
        'slotKey' | 'owner' | 'ledger' | 'isNumericLedger' | 'rawInvalidVisibility' | 'extraTags'
    >
): void {
    if (entry.slotKey !== undefined) {
        assertSafeEntityTagValue('slotKey', entry.slotKey);
    }
    if (entry.owner !== undefined) {
        assertSafeEntityTagValue('owner', entry.owner);
    }
    if (entry.rawInvalidVisibility !== undefined) {
        assertSafeEntityTagValue('visibility', entry.rawInvalidVisibility);
    }
    if (entry.extraTags !== undefined) {
        for (const [k, v] of Object.entries(entry.extraTags)) {
            assertSafeEntityTagValue('extraTag_key', k);
            assertSafeEntityTagValue('extraTag_value', v);
        }
    }
    if (entry.ledger !== undefined) {
        for (const [k, v] of Object.entries(entry.ledger)) {
            assertSafeEntityTagValue('ledger_key', k);
            assertSafeLedgerValue(String(v));
        }
    }
}

export const DEFAULT_SECTION_HEADINGS = {
    innateLocks: '## 1. Innate Locks (先天/底层永久红线 · since_day: -inf · 插叙永不屏蔽)',
    acquiredState: '## 2. Acquired State & Numeric Ledger (跨章后天状态与数值账本 · 行级补丁更新)',
    irreversibleTrajectory: '## 3. Irreversible Trajectory (不可逆极性变迁史 · 纪元内禁删)',
    recentBuffer: '## 4. Recent Sliding Buffer & Voice (近期跨章缓冲与专属声纹)'
};

/** 拆分 YAML Frontmatter 与 Markdown 正文 */
export function splitFrontmatter(markdown: string): { rawYaml: string; body: string } {
    const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
    if (!match) {
        throw new Error('缺少合法的 YAML Frontmatter (--- ... ---)');
    }
    return {
        rawYaml: match[1] ?? '',
        body: match[2] ?? ''
    };
}

/** 从条目正文推理隐式槽位键（仅用于补丁匹配，不篡改原始解析字段） */
export function inferSlotKey(entry: EntityEntry): string | undefined {
    if (entry.slotKey) {
        return entry.slotKey;
    }
    if (entry.isNumericLedger) {
        return 'Tracked Numeric Ledger';
    }
    const colonMatch = /^([^：:\n]{1,24})[：:]/.exec(entry.text);
    if (colonMatch?.[1]) {
        return colonMatch[1].trim();
    }
    return undefined;
}

function applyEntryMetadataTag(
    entry: EntityEntry,
    extraTags: Record<string, string>,
    key: string,
    val: string
): void {
    if (key === 'day' || key === 'story_day') {
        const num = Number(val);
        if (Number.isInteger(num)) {
            entry.storyDay = num;
        }
        return;
    }
    if (key === 'ch') {
        const num = Number(val);
        if (Number.isInteger(num) && num >= 0) {
            entry.chapter = num;
        }
        return;
    }
    if (key === 'vis' || key === 'visibility') {
        const normalizedVis = val.toUpperCase();
        if (
            normalizedVis === 'SELF_ONLY' ||
            normalizedVis === 'OMNISCIENT_SECRET' ||
            normalizedVis === 'PUBLIC' ||
            normalizedVis === 'READER_KNOWN'
        ) {
            entry.visibility = normalizedVis as EntryVisibility;
        } else if (val.length > 0) {
            entry.rawInvalidVisibility = val;
            extraTags[key] = val;
        }
        return;
    }
    if (key === 'owner') {
        assertSafeEntityTagValue('owner', val);
        entry.owner = val;
        return;
    }
    if (key === 'status') {
        const normalizedStatus = val.toUpperCase();
        if (normalizedStatus === 'ACTIVE' || normalizedStatus === 'WARPED') {
            entry.status = normalizedStatus as EntryStatus;
        } else if (val.length > 0) {
            extraTags[key] = val;
        }
        return;
    }
    if (key === 'slot') {
        assertSafeEntityTagValue('slotKey', val);
        entry.slotKey = val;
        return;
    }
    extraTags[key] = val;
}

/** 解析单行条目标签与内容 */
function parseEntryLine(lineContent: string): EntityEntry {
    const trimmed = lineContent.trim();

    if (trimmed.startsWith('[Tracked Numeric Ledger]')) {
        const rest = trimmed.slice('[Tracked Numeric Ledger]'.length).trim();
        const ledger: Record<string, string> = {};
        if (rest.length > 0) {
            for (const part of rest.split('|')) {
                const idx = part.indexOf(':');
                if (idx <= 0) continue;
                const key = part.slice(0, idx).trim();
                const val = part.slice(idx + 1).trim();
                if (!key) continue;
                assertSafeEntityTagValue('ledger_key', key);
                assertSafeLedgerValue(val);
                ledger[key] = val;
            }
        }
        return {
            isNumericLedger: true,
            ledger,
            text: rest,
            continuationLines: []
        };
    }

    const entry: EntityEntry = {
        text: trimmed,
        continuationLines: []
    };

    const tagMatch = /^\[([^\]]+)\]\s*(.*)$/.exec(trimmed);
    if (!tagMatch) {
        return entry;
    }

    const rawTags = tagMatch[1] ?? '';
    const bodyText = (tagMatch[2] ?? '').trim();

    // 若方括号内不含 key:value 冒号，说明不是元数据标签块，保留原文本
    if (!rawTags.includes(':')) {
        return entry;
    }

    entry.text = bodyText;
    const extraTags: Record<string, string> = {};

    for (const token of rawTags.split('|')) {
        const sep = token.indexOf(':');
        if (sep === -1) continue;
        const key = token.slice(0, sep).trim().toLowerCase();
        const val = token.slice(sep + 1).trim();
        applyEntryMetadataTag(entry, extraTags, key, val);
    }

    if (Object.keys(extraTags).length > 0) {
        entry.extraTags = extraTags;
    }

    return entry;
}

/** 序列化单个条目为 Markdown 列表项 */
function serializeEntry(entry: EntityEntry): string[] {
    assertEntryTagsSafe(entry);

    // 旧列表语法把换行、方括号前缀和缩进当作结构，不能无损表示这些值。
    const ambiguousText = entry.text.trim() !== entry.text || /[\r\n\u2028\u2029]|^\[/.test(entry.text);
    const ambiguousContinuation = entry.continuationLines.some((line) =>
        !line.trim() || /[\r\n]/.test(line) || !/^(?:\s|>)/.test(line) || detectSectionKey(line) !== null
    );
    if (ambiguousText || ambiguousContinuation || entry.extraTags || entry.rawInvalidVisibility !== undefined ||
        entry.owner?.trim() !== entry.owner || entry.slotKey?.trim() !== entry.slotKey) {
        return [`+ ${JSON.stringify(entry)}`];
    }

    if (entry.isNumericLedger || entry.ledger !== undefined || entry.isNumericLedger === false) {
        const fields = Object.entries(entry.ledger ?? {});
        const body = fields.map(([k, v]) => `${k}: ${v}`).join(' | ');
        const plainLedger = entry.isNumericLedger && entry.ledger !== undefined && entry.text === body &&
            Object.keys(entry).every((k) => ['text', 'ledger', 'isNumericLedger', 'continuationLines'].includes(k)) &&
            fields.every(([k, v]) => k && !k.includes(':') && k !== '__proto__' && k === k.trim() && v === v.trim());
        return plainLedger ? [`- [Tracked Numeric Ledger] ${body}`.trimEnd(), ...entry.continuationLines] : [`+ ${JSON.stringify(entry)}`];
    }

    const tags: string[] = [];
    if (entry.storyDay !== undefined) {
        tags.push(`day:${entry.storyDay}`);
    }
    if (entry.chapter !== undefined) {
        tags.push(`ch:${String(entry.chapter).padStart(2, '0')}`);
    }
    if (entry.visibility !== undefined) {
        tags.push(`vis: ${entry.visibility}`);
    }
    if (entry.owner !== undefined) {
        tags.push(`owner: ${entry.owner}`);
    }
    if (entry.status !== undefined) {
        tags.push(`status: ${entry.status}`);
    }
    if (entry.slotKey !== undefined) {
        tags.push(`slot: ${entry.slotKey}`);
    }

    const prefix = tags.length > 0 ? `[${tags.join(' | ')}] ` : '';
    const mainLine = `- ${prefix}${entry.text}`.trimEnd();
    return [mainLine, ...entry.continuationLines];
}

type SectionKey = 'innateLocks' | 'acquiredState' | 'irreversibleTrajectory' | 'recentBuffer';

function detectSectionKey(line: string): SectionKey | null {
    const trimmed = line.trim();
    if (!/^#{2,3}\s+/.test(trimmed)) return null;
    const headingBody = trimmed.replace(/^#{2,3}\s+/, '');
    if (/^1\./.test(headingBody) || headingBody.includes('Innate Locks')) return 'innateLocks';
    if (/^2\./.test(headingBody) || headingBody.includes('Acquired State')) return 'acquiredState';
    if (/^3\./.test(headingBody) || headingBody.includes('Irreversible Trajectory')) return 'irreversibleTrajectory';
    if (/^4\./.test(headingBody) || headingBody.includes('Recent Sliding Buffer')) return 'recentBuffer';
    return null;
}

/** 解析四段式实体档案 Markdown */
export function parseEntityMarkdown(markdown: string): EntityProfile {
    const { rawYaml, body } = splitFrontmatter(markdown);
    const parsedYaml = parseYaml(rawYaml) as unknown;
    const metadata = EntityMetadataSchema.parse(parsedYaml);

    const profile: EntityProfile = {
        metadata,
        sectionHeadings: { ...DEFAULT_SECTION_HEADINGS },
        innateLocks: [],
        acquiredState: [],
        irreversibleTrajectory: [],
        recentBuffer: []
    };

    let currentSection: SectionKey | null = null;
    let lastEntry: EntityEntry | null = null;

    for (const line of body.split('\n')) {
        const maybeSection = detectSectionKey(line);
        if (maybeSection) {
            currentSection = maybeSection;
            profile.sectionHeadings[maybeSection] = line.trim();
            lastEntry = null;
            continue;
        }

        if (!currentSection) continue;

        if (line.startsWith('+ ') || line.startsWith('- ') || line.startsWith('* ') || line === '-') {
            const entry = line.startsWith('+ ')
                ? EntityEntrySchema.parse(JSON.parse(line.slice(2)))
                : parseEntryLine(line.slice(2));
            assertEntryTagsSafe(entry);
            profile[currentSection].push(entry);
            lastEntry = entry;
        } else if (lastEntry && line.trim().length > 0 && (/^\s+/.test(line) || /^>\s*/.test(line))) {
            lastEntry.continuationLines.push(line);
        } else if (line.trim().length > 0) {
            throw new Error(`实体档案 ${metadata.entity_id} 第 ${currentSection} 区存在无法识别的非列表内容行: ${line}`);
        }
    }

    return profile;
}

/** 序列化四段式实体档案为 Markdown */
export function serializeEntityMarkdown(profile: EntityProfile): string {
    const metadataObj: Record<string, unknown> = {
        entity_id: profile.metadata.entity_id,
        canonical_name: profile.metadata.canonical_name,
        unique_aliases: profile.metadata.unique_aliases,
        contextual_titles: profile.metadata.contextual_titles,
        historical_anchors: profile.metadata.historical_anchors,
        last_seen_ch: profile.metadata.last_seen_ch
    };
    if (profile.metadata.status !== undefined) {
        metadataObj['status'] = profile.metadata.status;
    }

    const yamlBlock = stringifyYaml(metadataObj, { lineWidth: 0 }).trimEnd();

    const formatSection = (heading: string, entries: EntityEntry[]): string[] => {
        const lines: string[] = [heading];
        for (const entry of entries) {
            lines.push(...serializeEntry(entry));
        }
        return lines;
    };

    const parts: string[] = [
        '---',
        yamlBlock,
        '---',
        '',
        ...formatSection(profile.sectionHeadings.innateLocks, profile.innateLocks),
        '',
        ...formatSection(profile.sectionHeadings.acquiredState, profile.acquiredState),
        '',
        ...formatSection(profile.sectionHeadings.irreversibleTrajectory, profile.irreversibleTrajectory),
        '',
        ...formatSection(profile.sectionHeadings.recentBuffer, profile.recentBuffer),
        ''
    ];

    return parts.join('\n');
}

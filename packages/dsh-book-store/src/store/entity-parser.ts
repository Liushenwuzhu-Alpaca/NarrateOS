import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
    EntityEntry,
    EntityMetadataSchema,
    EntityProfile,
    EntryStatus,
    EntryVisibility
} from './schemas.js';

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

/** 解析单行条目标签与内容 */
function parseEntryLine(lineContent: string): EntityEntry {
    const trimmed = lineContent.trim();

    if (trimmed.startsWith('[Tracked Numeric Ledger]')) {
        const rest = trimmed.slice('[Tracked Numeric Ledger]'.length).trim();
        const ledger: Record<string, string> = {};
        if (rest.length > 0) {
            for (const part of rest.split('|')) {
                const idx = part.indexOf(':');
                if (idx > 0) {
                    const key = part.slice(0, idx).trim();
                    const val = part.slice(idx + 1).trim();
                    if (key) {
                        ledger[key] = val;
                    }
                }
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

        if (key === 'day' || key === 'story_day') {
            const num = Number(val);
            if (Number.isInteger(num)) {
                entry.storyDay = num;
            }
        } else if (key === 'ch') {
            const num = Number(val);
            if (Number.isInteger(num) && num >= 0) {
                entry.chapter = num;
            }
        } else if (key === 'vis' || key === 'visibility') {
            if (val === 'SELF_ONLY' || val === 'OMNISCIENT_SECRET' || val === 'PUBLIC' || val === 'READER_KNOWN') {
                entry.visibility = val as EntryVisibility;
            }
        } else if (key === 'owner') {
            entry.owner = val;
        } else if (key === 'status') {
            if (val === 'ACTIVE' || val === 'WARPED') {
                entry.status = val as EntryStatus;
            }
        } else if (key === 'slot') {
            entry.slotKey = val;
        } else {
            extraTags[key] = val;
        }
    }

    if (Object.keys(extraTags).length > 0) {
        entry.extraTags = extraTags;
    }

    return entry;
}

/** 序列化单个条目为 Markdown 列表项 */
function serializeEntry(entry: EntityEntry): string[] {
    if (entry.isNumericLedger) {
        const pairs = Object.entries(entry.ledger ?? {}).map(([k, v]) => `${k}: ${v}`);
        const line = pairs.length > 0
            ? `- [Tracked Numeric Ledger] ${pairs.join(' | ')}`
            : `- [Tracked Numeric Ledger] ${entry.text}`.trimEnd();
        return [line, ...entry.continuationLines];
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
    if (entry.extraTags) {
        for (const [k, v] of Object.entries(entry.extraTags)) {
            tags.push(`${k}: ${v}`);
        }
    }

    const prefix = tags.length > 0 ? `[${tags.join(' | ')}] ` : '';
    const mainLine = `- ${prefix}${entry.text}`.trimEnd();
    return [mainLine, ...entry.continuationLines];
}

type SectionKey = 'innateLocks' | 'acquiredState' | 'irreversibleTrajectory' | 'recentBuffer';

function detectSectionKey(line: string): SectionKey | null {
    if (/^##\s+1\./.test(line) || line.includes('Innate Locks')) return 'innateLocks';
    if (/^##\s+2\./.test(line) || line.includes('Acquired State')) return 'acquiredState';
    if (/^##\s+3\./.test(line) || line.includes('Irreversible Trajectory')) return 'irreversibleTrajectory';
    if (/^##\s+4\./.test(line) || line.includes('Recent Sliding Buffer')) return 'recentBuffer';
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

        if (line.startsWith('- ')) {
            const entry = parseEntryLine(line.slice(2));
            profile[currentSection].push(entry);
            lastEntry = entry;
        } else if (lastEntry && line.trim().length > 0 && /^\s+/.test(line)) {
            lastEntry.continuationLines.push(line);
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

/**
 * SillyTavern 世界书 / 角色卡标准化导入接缝
 * 注：当前提供基于公开 V2 规范的基础 JSON 解析适配器，待真实样本卡扩展后可平滑替换实现。
 */

/** 标准化世界书词条 */
export interface ImportedLoreEntry {
    id: string;
    title: string;
    keywords: string[];
    content: string;
    enabled: boolean;
}

/** 标准化角色卡资产 */
export interface ImportedCharacterCard {
    canonicalName: string;
    description: string;
    personality: string;
    scenario: string;
    firstMessage: string;
    exampleDialogue: string;
    embeddedLorebook: ImportedLoreEntry[];
}

/** 世界书导入端口接缝 */
export interface LorebookImportPort {
    importLorebook(rawJson: unknown): Promise<ImportedLoreEntry[]>;
}

/** 角色卡导入端口接缝 */
export interface CharacterCardImporter {
    importCharacterCard(rawJson: unknown): Promise<ImportedCharacterCard>;
}

interface RawLoreEntryLike {
    uid?: unknown;
    id?: unknown;
    key?: unknown;
    keys?: unknown;
    comment?: unknown;
    name?: unknown;
    content?: unknown;
    disable?: unknown;
    enabled?: unknown;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeLoreEntries(rawEntries: unknown): ImportedLoreEntry[] {
    const items: RawLoreEntryLike[] = Array.isArray(rawEntries)
        ? (rawEntries as RawLoreEntryLike[])
        : rawEntries && typeof rawEntries === 'object'
          ? (Object.values(rawEntries as Record<string, unknown>) as RawLoreEntryLike[])
          : [];

    const results: ImportedLoreEntry[] = [];
    items.forEach((item, index) => {
        if (!item || typeof item !== 'object') return;
        const disabled = item.disable === true || item.enabled === false;
        if (disabled) return;

        const content = typeof item.content === 'string' ? item.content.trim() : '';
        if (!content) return;

        const keywords = [
            ...asStringArray(item.key),
            ...asStringArray(item.keys)
        ];
        const rawUid = item.uid ?? item.id ?? index;
        const safeId = String(rawUid).replace(/[^a-zA-Z0-9_]/g, '_');
        const title =
            (typeof item.comment === 'string' && item.comment.trim()) ||
            (typeof item.name === 'string' && item.name.trim()) ||
            keywords[0] ||
            `条目 ${safeId}`;

        results.push({
            id: `lore_st_${safeId}`,
            title,
            keywords,
            content,
            enabled: true
        });
    });

    return results;
}

/** 基础 SillyTavern World Info JSON 解析适配器（待真实样本卡扩展） */
export class SillyTavernLorebookAdapter implements LorebookImportPort {
    async importLorebook(rawJson: unknown): Promise<ImportedLoreEntry[]> {
        if (!rawJson || typeof rawJson !== 'object') {
            throw new Error('SillyTavern 世界书 JSON 格式无效：根节点必须是对象');
        }
        const record = rawJson as { entries?: unknown };
        if (record.entries === undefined) {
            throw new Error('SillyTavern 世界书 JSON 缺少 entries 字段');
        }
        return normalizeLoreEntries(record.entries);
    }
}

/** 基础 SillyTavern V2 角色卡 JSON 解析适配器（待真实样本卡扩展） */
export class SillyTavernCharacterCardAdapter implements CharacterCardImporter {
    async importCharacterCard(rawJson: unknown): Promise<ImportedCharacterCard> {
        if (!rawJson || typeof rawJson !== 'object') {
            throw new Error('SillyTavern 角色卡 JSON 格式无效：根节点必须是对象');
        }
        const root = rawJson as {
            spec?: unknown;
            data?: Record<string, unknown>;
            name?: unknown;
            description?: unknown;
            personality?: unknown;
            scenario?: unknown;
            first_mes?: unknown;
            mes_example?: unknown;
            character_book?: { entries?: unknown };
        };

        const dataObj: Record<string, unknown> =
            root.data && typeof root.data === 'object' ? root.data : (root as Record<string, unknown>);

        const canonicalName = typeof dataObj.name === 'string' ? dataObj.name.trim() : '';
        if (!canonicalName) {
            throw new Error('SillyTavern 角色卡缺少有效的 name 字段');
        }

        const characterBook =
            dataObj.character_book && typeof dataObj.character_book === 'object'
                ? (dataObj.character_book as { entries?: unknown })
                : undefined;

        return {
            canonicalName,
            description: typeof dataObj.description === 'string' ? dataObj.description.trim() : '',
            personality: typeof dataObj.personality === 'string' ? dataObj.personality.trim() : '',
            scenario: typeof dataObj.scenario === 'string' ? dataObj.scenario.trim() : '',
            firstMessage: typeof dataObj.first_mes === 'string' ? dataObj.first_mes.trim() : '',
            exampleDialogue: typeof dataObj.mes_example === 'string' ? dataObj.mes_example.trim() : '',
            embeddedLorebook: characterBook?.entries ? normalizeLoreEntries(characterBook.entries) : []
        };
    }
}

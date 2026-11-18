import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ForeignKeyError,
    type EntityProfile
} from '@narrateos/dsh-book-store';
import {
    isEnoentError,
    normalizeRelPosixPath,
    readOptionalDiskText
} from '../tools/shared.js';

export const ENTITY_FILENAME_RE = /^((?:char|item)_[a-zA-Z0-9_]+)\.md$/;
export const ENTITY_ID_PATTERN_RE = /^((?:char|item)_[a-zA-Z0-9_]+)$/;
export const ENTITY_REF_RE = /\b((?:char|item)_[a-zA-Z0-9_]+)\b/g;
export const FOREIGN_KEY_REF_RE = /\b(char_[a-zA-Z0-9_]+|item_[a-zA-Z0-9_]+|ch_\d{4})\b/g;
const SAGA_ARCHIVE_STEM_RE = /^((?:char|item)_[a-zA-Z0-9_]+?)_saga_\d+$/;

/** 提取文本中引用的全部实体 ID (char_* / item_*) */
export function collectEntityRefs(text: string): string[] {
    const refs: string[] = [];
    for (const match of text.matchAll(ENTITY_REF_RE)) {
        if (match[1]) {
            refs.push(match[1]);
        }
    }
    return refs;
}

/** 提取 open_threads.md 中处于活跃状态的列表行（自动跳过已归档章节与 RESOLVED 条目） */
export function extractActiveOpenThreadLines(markdown: string): string[] {
    const normalized = markdown.replace(/\r\n/g, '\n');
    let inArchiveSection = false;
    const activeLines: string[] = [];

    for (const rawLine of normalized.split('\n')) {
        const trimmed = rawLine.trim();
        if (/^##\s+.*(已回收|已解决|已兑现|Resolved|Archive)/i.test(trimmed)) {
            inArchiveSection = true;
            continue;
        }
        if (/^##\s+/.test(trimmed)) {
            inArchiveSection = false;
            continue;
        }
        if (!trimmed.startsWith('- ') || inArchiveSection) {
            continue;
        }
        if (/\bstatus:\s*RESOLVED\b/i.test(trimmed) || /\[RESOLVED\]/i.test(trimmed)) {
            continue;
        }
        activeLines.push(trimmed);
    }

    return activeLines;
}

/** 将 Map 或普通对象形态的 visibleEntities 统一归一化为只读 Map */
export function toVisibleEntityMap(
    input: ReadonlyMap<string, EntityProfile> | Record<string, EntityProfile> | undefined
): ReadonlyMap<string, EntityProfile> {
    if (!input) {
        return new Map();
    }
    if (input instanceof Map) {
        return input;
    }
    return new Map(Object.entries(input));
}

/** 优先从内存覆盖层读取可选作品文件，未命中则回落磁盘（不存在返回 null） */
export async function readOptionalWithOverlay(
    bookRoot: string,
    overlay: ReadonlyMap<string, string | null>,
    relPath: string
): Promise<string | null> {
    const normalized = normalizeRelPosixPath(relPath);
    if (overlay.has(normalized)) {
        return overlay.get(normalized) ?? null;
    }
    return await readOptionalDiskText(join(bookRoot, normalized));
}

/** 判断第 1 区条目是否非法混入 OMNISCIENT_SECRET 标记 */
export function hasOmniscientSecretMarker(entry: {
    visibility?: string | undefined;
    rawInvalidVisibility?: string | undefined;
    text: string;
    continuationLines?: readonly string[] | undefined;
}): boolean {
    if (entry.visibility === 'OMNISCIENT_SECRET') {
        return true;
    }
    if (entry.rawInvalidVisibility !== undefined && /\bOMNISCIENT_SECRET\b/i.test(entry.rawInvalidVisibility)) {
        return true;
    }
    if (/\bOMNISCIENT_SECRET\b/i.test(entry.text)) {
        return true;
    }
    return entry.continuationLines?.some((line) => /\bOMNISCIENT_SECRET\b/i.test(line)) ?? false;
}

/** 将实体文件名（含 _saga_N 折叠归档后缀）解析为可达实体主键 */
export function addEntityStemToReachableKeys(stem: string, keys: Set<string>, entityOnly: boolean): void {
    if (!entityOnly || ENTITY_ID_PATTERN_RE.test(stem)) {
        keys.add(stem);
    }
    const sagaMatch = SAGA_ARCHIVE_STEM_RE.exec(stem);
    if (sagaMatch?.[1]) {
        keys.add(sagaMatch[1]);
    }
}

async function collectKeysInDir(
    dirPath: string,
    entityOnly: boolean,
    skipSymlinks: boolean,
    keys: Set<string>
): Promise<void> {
    let files: string[];
    try {
        files = await readdir(dirPath);
    } catch (err: unknown) {
        if (isEnoentError(err)) {
            return;
        }
        throw err;
    }

    for (const file of files) {
        if (!file.endsWith('.md')) continue;
        if (skipSymlinks) {
            try {
                const st = await lstat(join(dirPath, file));
                if (st.isSymbolicLink() || !st.isFile()) {
                    continue;
                }
            } catch {
                continue;
            }
        }
        addEntityStemToReachableKeys(file.slice(0, -3), keys, entityOnly);
    }
}

/** 扫描 entities/、entities/cold_archive/ 与 manuscripts/ 收集所有可达外键 */
export async function collectReachableKeysFromBookDirs(
    bookRoot: string,
    options: { skipSymlinks?: boolean } = {}
): Promise<Set<string>> {
    const keys = new Set<string>();
    const skipSymlinks = options.skipSymlinks ?? false;
    await Promise.all([
        collectKeysInDir(join(bookRoot, 'entities'), true, skipSymlinks, keys),
        collectKeysInDir(join(bookRoot, 'entities/cold_archive'), true, skipSymlinks, keys),
        collectKeysInDir(join(bookRoot, 'manuscripts'), false, skipSymlinks, keys)
    ]);
    return keys;
}

/** 校验文本中全部实体与章节外键 (char_* / item_* / ch_XXXX) 均在可达集合内 */
export function assertTextForeignKeys(
    sourceId: string,
    text: string,
    reachable: ReadonlySet<string>
): void {
    const missing = new Set<string>();
    for (const match of text.matchAll(FOREIGN_KEY_REF_RE)) {
        const refId = match[1];
        if (refId && !reachable.has(refId)) {
            missing.add(refId);
        }
    }
    if (missing.size > 0) {
        throw new ForeignKeyError([...missing], sourceId);
    }
}

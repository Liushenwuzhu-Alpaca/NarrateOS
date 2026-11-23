import { createHash } from 'node:crypto';
import {
    normalizeForQuoteMatch,
    parseEntityMarkdown,
    readBookL2Sections,
    type DreamWatermark,
    type EntityProfile,
    type SystemPort,
    type TxState
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import type { ValidatedDreamEntity } from './dream-write-validation.js';
import type { DreamCommitInput } from './schemas.js';

interface DreamAppearanceOptions {
    bookRoot: string;
    system: SystemPort;
    txState: TxState;
    chapterNumber: number;
    minPromotionChapters: number;
    appearances: DreamCommitInput['appearances'];
    entities: ReadonlyMap<string, ValidatedDreamEntity>;
    reachableIds: ReadonlySet<string>;
    pendingWrites: Map<string, string>;
    readFile: (path: string) => Promise<string | null>;
    absences: NonNullable<DreamWatermark['appearance_absences']>;
    dreamReadHashes: ReadonlyMap<string, string | null> | undefined;
}

/** 规范名和别名决定否定回查结论的适用范围，别名次序不影响身份。 */
export function dreamAppearanceIdentity(metadata: EntityProfile['metadata']): string {
    return createHash('sha256')
        .update(JSON.stringify([metadata.canonical_name, [...new Set(metadata.unique_aliases)].sort()]))
        .digest('hex');
}

/** 仅拼回实际变动的字段；不通过重序列化改写整卷。 */
function backfillVolume(
    path: string, raw: string, chapterIds: ReadonlyMap<number, ReadonlySet<string>>
): string {
    const headings = [...raw.matchAll(/^##[ \t]+ch_(\d{4})\b[^\r\n]*(?:\r?\n|$)/gm)];
    const seen = new Set<number>();
    let result = '';
    let cursor = 0;
    for (const [index, heading] of headings.entries()) {
        const chapter = Number(heading[1]);
        const ids = chapterIds.get(chapter);
        if (!ids) continue;
        if (seen.has(chapter)) {
            throw new GateValidationError('yield_dream_commit', `${path} 第 ${chapter} 章标题重复`);
        }
        seen.add(chapter);
        const bodyStart = heading.index + heading[0].length;
        const bodyEnd = headings[index + 1]?.index ?? raw.length;
        const body = raw.slice(bodyStart, bodyEnd);
        const fields = [...body.matchAll(/^(-[ \t]*出场实体[ \t]*[:：][ \t]*)([^\r\n]*)/gm)];
        if (fields.length > 1) {
            throw new GateValidationError('yield_dream_commit', `${path} 第 ${chapter} 章存在多行出场实体字段`);
        }
        const field = fields[0];
        if (!field) {
            const eol = heading[0].endsWith('\r\n') ? '\r\n' : '\n';
            result += raw.slice(cursor, bodyStart);
            if (!heading[0].endsWith('\n')) result += eol;
            result += `- 出场实体：${[...ids].join(', ')}${eol}`;
            cursor = bodyStart;
            continue;
        }
        const fieldText = field[2]!;
        const original = fieldText.trimEnd();
        const existingIds = original.split(/[,，、\s]+/).filter((id) => id && id !== '无');
        const missingIds = [...ids].filter((id) => !existingIds.includes(id));
        if (missingIds.length === 0) continue;
        const start = bodyStart + field.index + field[1]!.length;
        result += raw.slice(cursor, start);
        if (existingIds.length > 0) result += `${original}, `;
        result += missingIds.join(', ') + fieldText.slice(original.length);
        cursor = start + fieldText.length;
    }
    if (seen.size !== chapterIds.size) {
        throw new GateValidationError('yield_dream_commit', `${path} 暂存版本缺少待补登的历史章标题`);
    }
    return cursor === 0 ? raw : result + raw.slice(cursor);
}

/** 在提交锁内核实逐章证据，只扩展本轮暂存写集，不直接落盘。 */
export async function planDreamAppearances(options: DreamAppearanceOptions): Promise<void> {
    const { bookRoot, system, txState, chapterNumber, appearances, entities, pendingWrites, readFile, absences } = options;
    const promotions = new Map<string, Set<string>>();
    for (const [id, entity] of entities) {
        const names = new Set(entity.newNames.map(normalizeForQuoteMatch).filter((name) => name.length >= 2));
        if (names.size > 0) promotions.set(id, names);
    }
    if (promotions.size === 0 && appearances.length === 0) return;

    const originals = new Map<string, string>();
    const sections = await readBookL2Sections(bookRoot, {
        stagingOverlay: pendingWrites,
        stagingRead: async (path) => {
            const raw = await readFile(path);
            if (raw !== null) originals.set(path, raw);
            return raw;
        }
    });
    const chapters = new Map<number, (typeof sections)[number] | null>();
    const anchorChapters = new Map<string, Set<number>>();
    for (const section of sections) {
        const chapter = section.chapterNumber;
        if (chapter > chapterNumber || !txState.chapter_hashes[section.chapterId]) continue;
        chapters.set(chapter, chapters.has(chapter) ? null : section);
        if (promotions.size === 0) continue;
        for (const anchor of section.anomalyAnchors) {
            const name = normalizeForQuoteMatch(anchor);
            let set = anchorChapters.get(name);
            if (!set) anchorChapters.set(name, set = new Set());
            set.add(chapter);
        }
    }

    const audited = new Map<string, Map<number, string | null>>();
    for (const { entity_id: id, chapter_number: chapter, quote } of appearances) {
        if (!options.reachableIds.has(id)) {
            throw new GateValidationError('yield_dream_commit', `出场实体档案不存在: ${id}`);
        }
        if (!chapters.get(chapter)) {
            throw new GateValidationError('yield_dream_commit', `找不到第 ${chapter} 章唯一可核实的定稿 L2 章卡`);
        }
        let entries = audited.get(id);
        if (!entries) audited.set(id, entries = new Map());
        if (entries.has(chapter) && entries.get(chapter) !== quote) {
            throw new GateValidationError('yield_dream_commit', `${id} 第 ${chapter} 章提交了冲突的出场证据`);
        }
        entries.set(chapter, quote);
    }
    for (const [id, names] of promotions) {
        const reviews = audited.get(id);
        for (const name of names) {
            const candidates = anchorChapters.get(name);
            if (!candidates || candidates.size < options.minPromotionChapters) continue;
            for (const chapter of candidates) {
                if (chapters.get(chapter)?.appearedEntityIds.includes(id) || reviews?.has(chapter)) continue;
                throw new GateValidationError('yield_dream_commit', `${id} 关联复现锚点，须在 appearances 逐章核对第 ${chapter} 章（无实际出场填 quote: null）`);
            }
        }
    }

    const texts = new Map<number, { archived: string; prose?: string }>();
    const byVolume = new Map<string, Map<number, Set<string>>>();
    let revision: string | undefined;
    for (const [id, entries] of audited) {
        const stagedEntity = entities.get(id);
        let entityPath = stagedEntity?.path ?? `entities/${id}.md`;
        let rawEntity = pendingWrites.get(entityPath) ?? await readFile(entityPath);
        if (rawEntity === null) {
            entityPath = `entities/cold_archive/${id}.md`;
            rawEntity = await readFile(entityPath);
        }
        const profile = stagedEntity?.profile ?? (rawEntity === null ? undefined : parseEntityMarkdown(rawEntity));
        if (profile?.metadata.entity_id !== id) {
            throw new GateValidationError('yield_dream_commit', `出场实体档案与 ID 不匹配: ${id}`);
        }
        const names = [profile.metadata.canonical_name, ...profile.metadata.unique_aliases]
            .map(normalizeForQuoteMatch).filter((name) => name.length > 0);
        let identity: string | undefined;
        let identityReadMatches: boolean | undefined;
        for (const [chapter, quote] of entries) {
            const section = chapters.get(chapter)!;
            const chapterHash = txState.chapter_hashes[section.chapterId]!;
            const manuscript = `manuscripts/${section.chapterId}.md`;
            if (quote === null && options.dreamReadHashes?.get(manuscript) !== chapterHash) {
                throw new GateValidationError('yield_dream_commit', `${section.chapterId} 缺少本轮实际读取的定稿证据：请用 book_read 核对已同步的正文，未核实则省略此结论`);
            }
            if (quote === null && !(identityReadMatches ??= rawEntity !== null &&
                options.dreamReadHashes?.get(entityPath) === createHash('sha256').update(rawEntity).digest('hex'))) {
                throw new GateValidationError('yield_dream_commit', `${id} 缺少本轮实际读取的实体档案证据：请用 book_read 核对最终版本的名称和别名`);
            }
            let text = texts.get(chapter);
            if (text === undefined) {
                revision ??= await system.currentRevision(bookRoot);
                const archived = await system.readFileAtRef(bookRoot, revision, manuscript);
                if (archived === null || createHash('sha256').update(archived).digest('hex') !== chapterHash) {
                    throw new GateValidationError('yield_dream_commit', `${section.chapterId} 的定稿与 WAL 指纹不符，不能登记出场核对结论`);
                }
                text = { archived };
                texts.set(chapter, text);
            }
            if (quote === null) {
                if (!section.appearedEntityIds.includes(id)) {
                    (absences[id] ??= {})[section.chapterId] = {
                        chapter_sha256: chapterHash,
                        identity_sha256: identity ??= dreamAppearanceIdentity(profile.metadata)
                    };
                }
                continue;
            }
            text.prose ??= text.archived.replace(/^\uFEFF?# [^\r\n]*(?:\r?\n|$)/, '').replaceAll('\r\n', '\n');
            const normalizedQuote = normalizeForQuoteMatch(quote);
            if (!text.prose.includes(quote.replaceAll('\r\n', '\n')) ||
                !names.some((name) => normalizedQuote.length > name.length && normalizedQuote.includes(name))) {
                throw new GateValidationError('yield_dream_commit', `${id} 第 ${chapter} 章出场引文必须是含实体名称或别名的定稿正文原句`);
            }
            const previousAbsences = absences[id];
            if (previousAbsences) {
                delete previousAbsences[section.chapterId];
                if (Object.keys(previousAbsences).length === 0) delete absences[id];
            }
            let volume = byVolume.get(section.sourcePath);
            if (!volume) byVolume.set(section.sourcePath, volume = new Map());
            let ids = volume.get(chapter);
            if (!ids) volume.set(chapter, ids = new Set());
            ids.add(id);
        }
    }
    for (const [path, targets] of byVolume) {
        const original = pendingWrites.get(path) ?? originals.get(path)!;
        const updated = backfillVolume(path, original, targets);
        if (updated !== original) pendingWrites.set(path, updated);
    }
}

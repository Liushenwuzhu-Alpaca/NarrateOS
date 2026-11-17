import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RipgrepMatch, SystemPort } from '../ports/system.js';
import { splitFrontmatter } from '../store/entity-parser.js';
import { EntityEntry, EntityProfile, WorldStateFrontmatterSchema } from '../store/schemas.js';

const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;
const VOLUME_CARD_FILE_RE = /^vol_(\d+)_cards\.md$/;
const LORE_FILE_RE = /^lore_.*\.md$/;

/** 章节索引条目 */
export interface ChapterIndexEntry {
    chapterNumber: number;
    chapterId: string;
    relativePath: string;
    volumeNumber: number;
    storyDay?: number | undefined;
    title?: string | undefined;
}

/** 构建双层目录的可选参数 */
export interface BuildCatalogOptions {
    currentVolume?: number | undefined;
}

/** Librarian 双层章节目录 */
export interface LibrarianCatalog {
    currentVolume: number;
    sealedVolumes: number[];
    staticPrefix: string;
    dynamicTail: string;
    fullCatalog: string;
    chapters: ChapterIndexEntry[];
}

/** 限章/限时间窗职务称谓规则 */
export interface ContextualTitleRule {
    title: string;
    minChapter?: number | undefined;
    maxChapter?: number | undefined;
    minStoryDay?: number | undefined;
    maxStoryDay?: number | undefined;
    appearanceChapters?: number[] | undefined;
}

/** 实体多身份键检索参数 */
export interface EntityRecallQuery {
    profile: EntityProfile;
    targetChapter: number;
    targetDay: number;
    chapterFiles?: string[] | undefined;
    chapterDays?: Record<number, number> | undefined;
    contextualTitleRules?: ContextualTitleRule[] | undefined;
    appearanceChapters?: number[] | undefined;
    extraKeywords?: string[] | undefined;
    includeHistoricalAnchors?: boolean | undefined;
}

/** 带时间差信封的原稿召回切片 */
export interface RecallSlice {
    /** 成对挂载的必需证据，不参与可选切片裁剪。 */
    requiredEntityId?: string | undefined;
    file: string;
    chapterId: string;
    chapterNumber: number;
    chapterDay: number | null;
    targetChapter: number;
    targetDay: number;
    deltaChapters: number;
    deltaDays: number | null;
    line: number;
    text: string;
    contextBefore: string[];
    contextAfter: string[];
    matchedKeys: string[];
    snippet: string;
}

/** 成对回表校验状态 */
export type PairedRecallStatus =
    | 'paired'
    | 'missing_manuscript_anchor'
    | 'missing_entity_record';

/** 单章成对回表校验明细 */
export interface PairedChapterEvidence {
    chapterNumber: number;
    chapterId: string;
    status: PairedRecallStatus;
    entityEntries: EntityEntry[];
    historicalAnchors: string[];
    manuscriptSlices: RecallSlice[];
}

/** 成对回表校验参数 */
export interface PairedRecallQuery extends EntityRecallQuery {
    /** 仅校验指定章节（可选，默认校验所有档案声明章与原稿命中章） */
    focusChapters?: number[] | undefined;
}

/** 成对回表校验结果 */
export interface PairedRecallResult {
    entityId: string;
    canonicalName: string;
    paired: boolean;
    overallStatus: 'paired' | 'unpaired';
    slices: RecallSlice[];
    chapterVerifications: PairedChapterEvidence[];
    unpairedIssues: PairedChapterEvidence[];
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, 'utf8');
    } catch {
        return null;
    }
}

async function listOptionalDir(dirPath: string): Promise<string[]> {
    try {
        return await readdir(dirPath);
    } catch {
        return [];
    }
}

function formatChapterId(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}`;
}

function parseChapterNumberFromPath(relativePath: string): number | null {
    const normalized = relativePath.replace(/\\/g, '/');
    const fileName = normalized.split('/').pop() ?? '';
    const match = CHAPTER_FILE_RE.exec(fileName);
    if (!match?.[1]) return null;
    const num = Number(match[1]);
    return Number.isInteger(num) && num > 0 ? num : null;
}

function extractChapterMetadata(content: string): { title?: string | undefined; storyDay?: number | undefined } {
    let body = content.replace(/\r\n/g, '\n');
    let storyDay: number | undefined;

    if (body.startsWith('---\n')) {
        try {
            const split = splitFrontmatter(body);
            const parsed = parseYaml(split.rawYaml) as Record<string, unknown> | null;
            if (parsed && typeof parsed['story_day'] === 'number' && Number.isInteger(parsed['story_day'])) {
                storyDay = parsed['story_day'];
            }
            body = split.body;
        } catch {
            // 非法 frontmatter 时忽略，继续按正文注释与标题解析
        }
    }

    if (storyDay === undefined) {
        const commentMatch = /<!--\s*story_day:\s*(-?\d+)\s*-->/.exec(body);
        if (commentMatch?.[1]) {
            const parsedDay = Number(commentMatch[1]);
            if (Number.isInteger(parsedDay)) {
                storyDay = parsedDay;
            }
        }
    }

    let title: string | undefined;
    for (const line of body.split('\n')) {
        const headingMatch = /^#\s+(.+)$/.exec(line.trim());
        if (headingMatch?.[1]) {
            title = headingMatch[1].trim();
            break;
        }
    }

    return { title, storyDay };
}

function extractLoreSummary(fileName: string, content: string): string {
    let body = content.replace(/\r\n/g, '\n');
    if (body.startsWith('---\n')) {
        try {
            body = splitFrontmatter(body).body;
        } catch {
            // 无合法 frontmatter 时直接按正文解析
        }
    }
    const lines = body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const title = lines[0]?.replace(/^#+\s*/, '') ?? fileName;
    const preview = lines.slice(1, 3).join(' ');
    return preview ? `- ${fileName}: ${title} | ${preview}` : `- ${fileName}: ${title}`;
}

function extractChaptersInCard(cardContent: string): Set<number> {
    const chapters = new Set<number>();
    const normalized = cardContent.replace(/\r\n/g, '\n');
    const re = /^##\s+ch_(\d{4})\b/gm;
    let match: RegExpExecArray | null = re.exec(normalized);
    while (match !== null) {
        if (match[1]) {
            const num = Number(match[1]);
            if (Number.isInteger(num) && num > 0) {
                chapters.add(num);
            }
        }
        match = re.exec(normalized);
    }
    return chapters;
}

function formatTimeDeltaEnvelope(
    chapterNumber: number,
    chapterDay: number | null,
    targetChapter: number,
    targetDay: number
): string {
    const chStr = String(chapterNumber).padStart(2, '0');
    const targetChStr = String(targetChapter).padStart(2, '0');
    const dayStr = chapterDay === null ? 'unknown' : String(chapterDay);
    const deltaChapters = targetChapter - chapterNumber;
    const deltaDays = chapterDay === null ? null : targetDay - chapterDay;
    const deltaDaysStr = deltaDays === null ? 'unknown' : String(deltaDays);
    return `[出自第 ${chStr} 章 (day:${dayStr}) | 距当前第 ${targetChStr} 章 (day:${targetDay}) 已过 ${deltaChapters} 章 / ${deltaDaysStr} 天 - 历史现场非当前归属]`;
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAnchorKeyword(anchor: string): string | null {
    const colonIdx = anchor.indexOf(':');
    if (colonIdx === -1) {
        const trimmed = anchor.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    const keyword = anchor.slice(colonIdx + 1).trim();
    return keyword.length > 0 ? keyword : null;
}

function parseAnchorChapter(anchor: string): number | null {
    const match = /\bch_(\d{4})\b/.exec(anchor);
    if (!match?.[1]) return null;
    const num = Number(match[1]);
    return Number.isInteger(num) && num > 0 ? num : null;
}

function buildEffectiveRuleList(query: EntityRecallQuery): ContextualTitleRule[] {
    if (query.contextualTitleRules) {
        return query.contextualTitleRules;
    }

    return query.profile.metadata.contextual_titles.map((raw) => {
        const inlineMatch = /^(.+?)(?:@|\s*\()ch:(\d+)-(\d+)\)?$/.exec(raw.trim());
        if (inlineMatch?.[1] && inlineMatch[2] && inlineMatch[3]) {
            return {
                title: inlineMatch[1].trim(),
                minChapter: Number(inlineMatch[2]),
                maxChapter: Number(inlineMatch[3]),
                appearanceChapters: query.appearanceChapters
            };
        }
        return {
            title: raw.trim(),
            appearanceChapters: query.appearanceChapters
        };
    });
}

function isChapterEligibleForRule(
    rule: ContextualTitleRule,
    chapterNumber: number,
    chapterDay: number | undefined
): boolean {
    if (rule.appearanceChapters && rule.appearanceChapters.length > 0) {
        if (!rule.appearanceChapters.includes(chapterNumber)) {
            return false;
        }
    }
    if (rule.minChapter !== undefined && chapterNumber < rule.minChapter) {
        return false;
    }
    if (rule.maxChapter !== undefined && chapterNumber > rule.maxChapter) {
        return false;
    }
    if (chapterDay !== undefined) {
        if (rule.minStoryDay !== undefined && chapterDay < rule.minStoryDay) {
            return false;
        }
        if (rule.maxStoryDay !== undefined && chapterDay > rule.maxStoryDay) {
            return false;
        }
    }
    return true;
}

function isRuleActiveAtTarget(rule: ContextualTitleRule, query: EntityRecallQuery): boolean {
    if (rule.minChapter !== undefined && query.targetChapter < rule.minChapter) {
        return false;
    }
    if (rule.minStoryDay !== undefined && query.targetDay < rule.minStoryDay) {
        return false;
    }
    return true;
}

function collectEntityDeclaredChapters(profile: EntityProfile, maxChapter: number): Map<number, {
    entries: EntityEntry[];
    anchors: string[];
}> {
    const map = new Map<number, { entries: EntityEntry[]; anchors: string[] }>();
    const ensure = (ch: number) => {
        let bucket = map.get(ch);
        if (!bucket) {
            bucket = { entries: [], anchors: [] };
            map.set(ch, bucket);
        }
        return bucket;
    };

    const sections = [
        profile.innateLocks,
        profile.acquiredState,
        profile.irreversibleTrajectory,
        profile.recentBuffer
    ];

    for (const entries of sections) {
        for (const entry of entries) {
            const linkedChapters = new Set<number>();
            if (entry.chapter !== undefined && entry.chapter > 0 && entry.chapter <= maxChapter) {
                linkedChapters.add(entry.chapter);
            }
            const fullText = [entry.text, ...entry.continuationLines].join('\n');
            const inlineAnchorRe = /\[锚点\s+ch_(\d{4})\]/g;
            let anchorMatch: RegExpExecArray | null = inlineAnchorRe.exec(fullText);
            while (anchorMatch !== null) {
                if (anchorMatch[1]) {
                    const ch = Number(anchorMatch[1]);
                    if (Number.isInteger(ch) && ch > 0 && ch <= maxChapter) {
                        linkedChapters.add(ch);
                    }
                }
                anchorMatch = inlineAnchorRe.exec(fullText);
            }
            for (const ch of linkedChapters) {
                ensure(ch).entries.push(entry);
            }
        }
    }

    for (const anchor of profile.metadata.historical_anchors) {
        const ch = parseAnchorChapter(anchor);
        if (ch !== null && ch <= maxChapter) {
            ensure(ch).anchors.push(anchor);
        }
    }

    return map;
}

/** 确定性双层目录构建、多身份键 rg -C 2 回表与成对校验引擎 */
export class IndexRecall {
    constructor(private readonly system: SystemPort) {}

    /** 构建「已封旧卷静态区 + 当前活跃卷动态尾目录」双层目录 */
    async buildLibrarianCatalog(bookRoot: string, options: BuildCatalogOptions = {}): Promise<LibrarianCatalog> {
        let currentVolume = options.currentVolume;
        if (currentVolume === undefined) {
            const worldStateRaw = await readOptionalUtf8(join(bookRoot, 'world/world_state.md'));
            if (worldStateRaw !== null) {
                try {
                    const { rawYaml } = splitFrontmatter(worldStateRaw);
                    const parsed = WorldStateFrontmatterSchema.parse(parseYaml(rawYaml));
                    currentVolume = parsed.current_volume;
                } catch {
                    currentVolume = undefined;
                }
            }
        }

        const l2Files = (await listOptionalDir(join(bookRoot, 'index/L2_cards')))
            .filter((name) => VOLUME_CARD_FILE_RE.test(name))
            .sort((a, b) => a.localeCompare(b));

        const parsedVolumeCards: Array<{ volumeNumber: number; fileName: string; content: string }> = [];
        for (const fileName of l2Files) {
            const match = VOLUME_CARD_FILE_RE.exec(fileName);
            if (!match?.[1]) continue;
            const volumeNumber = Number(match[1]);
            const content = await readOptionalUtf8(join(bookRoot, 'index/L2_cards', fileName));
            if (content !== null) {
                parsedVolumeCards.push({ volumeNumber, fileName, content });
            }
        }
        parsedVolumeCards.sort((a, b) => a.volumeNumber - b.volumeNumber);

        if (currentVolume === undefined) {
            const maxCardVol = parsedVolumeCards.at(-1)?.volumeNumber ?? 1;
            currentVolume = maxCardVol;
        }

        // 1. 构建静态区（lore 摘要 + L0 + L1 + 已封旧卷章卡，严格按确定性顺序）
        const staticParts: string[] = [];

        const loreFiles = (await listOptionalDir(join(bookRoot, 'lore_library')))
            .filter((name) => LORE_FILE_RE.test(name))
            .sort((a, b) => a.localeCompare(b));

        if (loreFiles.length > 0) {
            const loreSummaries: string[] = ['## Lore Library Index'];
            for (const fileName of loreFiles) {
                const content = await readOptionalUtf8(join(bookRoot, 'lore_library', fileName));
                if (content !== null) {
                    loreSummaries.push(extractLoreSummary(fileName, content));
                }
            }
            staticParts.push(loreSummaries.join('\n'));
        }

        const l0Content = await readOptionalUtf8(join(bookRoot, 'index/L0_sagas.md'));
        if (l0Content !== null && l0Content.trim().length > 0) {
            staticParts.push(l0Content.trimEnd());
        }

        const l1Content = await readOptionalUtf8(join(bookRoot, 'index/L1_volumes.md'));
        if (l1Content !== null && l1Content.trim().length > 0) {
            staticParts.push(l1Content.trimEnd());
        }

        const sealedVolumes: number[] = [];
        const chapterToVolume = new Map<number, number>();
        const activeCards: Array<{ volumeNumber: number; fileName: string; content: string }> = [];

        for (const card of parsedVolumeCards) {
            for (const ch of extractChaptersInCard(card.content)) {
                if (!chapterToVolume.has(ch)) {
                    chapterToVolume.set(ch, card.volumeNumber);
                }
            }
            if (card.volumeNumber < currentVolume) {
                sealedVolumes.push(card.volumeNumber);
                staticParts.push(`## Sealed Volume Card: ${card.fileName}\n${card.content.trimEnd()}`);
            } else {
                activeCards.push(card);
            }
        }

        const staticPrefix = staticParts.join('\n\n');

        // 2. 扫描手稿章节并构建动态尾目录（仅含当前活跃卷章节 + 活跃卷章卡 + open_threads）
        const manuscriptFiles = (await listOptionalDir(join(bookRoot, 'manuscripts')))
            .filter((name) => CHAPTER_FILE_RE.test(name))
            .sort((a, b) => a.localeCompare(b));

        const chapters: ChapterIndexEntry[] = [];
        const activeChapterLines: string[] = [];

        for (const fileName of manuscriptFiles) {
            const relativePath = `manuscripts/${fileName}`;
            const chapterNumber = parseChapterNumberFromPath(relativePath);
            if (chapterNumber === null) continue;

            const content = await readOptionalUtf8(join(bookRoot, relativePath));
            const meta = content !== null ? extractChapterMetadata(content) : {};
            const volumeNumber = chapterToVolume.get(chapterNumber) ?? currentVolume;

            const entry: ChapterIndexEntry = {
                chapterNumber,
                chapterId: formatChapterId(chapterNumber),
                relativePath,
                volumeNumber,
                storyDay: meta.storyDay,
                title: meta.title
            };
            chapters.push(entry);

            if (volumeNumber >= currentVolume) {
                const dayPart = meta.storyDay !== undefined ? `day:${meta.storyDay}` : 'day:unknown';
                const titlePart = meta.title ? ` | ${meta.title}` : '';
                activeChapterLines.push(`- ${entry.chapterId} (${dayPart})${titlePart}`);
            }
        }

        chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);

        const dynamicParts: string[] = [];
        for (const card of activeCards) {
            dynamicParts.push(`## Active Volume Card: ${card.fileName}\n${card.content.trimEnd()}`);
        }
        if (activeChapterLines.length > 0) {
            dynamicParts.push(`## Active Volume Chapters (Vol ${currentVolume})\n${activeChapterLines.join('\n')}`);
        }

        const openThreads = await readOptionalUtf8(join(bookRoot, 'world/open_threads.md'));
        if (openThreads !== null && openThreads.trim().length > 0) {
            dynamicParts.push(`## Open Threads\n${openThreads.trimEnd()}`);
        }

        const dynamicTail = dynamicParts.join('\n\n');
        const fullCatalog = [staticPrefix, dynamicTail].filter((s) => s.length > 0).join('\n\n');

        return {
            currentVolume,
            sealedVolumes,
            staticPrefix,
            dynamicTail,
            fullCatalog,
            chapters
        };
    }

    /** 多身份键 rg -C 2 原稿检索并包装时间差信封 */
    async recallEntitySlices(bookRoot: string, query: EntityRecallQuery): Promise<RecallSlice[]> {
        const candidateFiles = await this.resolveCandidateChapterFiles(bookRoot, query);
        if (candidateFiles.length === 0) {
            return [];
        }

        const chapterDayMap = await this.resolveChapterDayMap(bookRoot, candidateFiles, query.chapterDays);

        // 1. 稳定身份键（实名 + 唯一别名 + 可选历史锚点关键词 + 额外关键词）
        const stablePatterns = new Set<string>();
        if (query.profile.metadata.canonical_name.trim().length > 0) {
            stablePatterns.add(query.profile.metadata.canonical_name.trim());
        }
        for (const alias of query.profile.metadata.unique_aliases) {
            if (alias.trim().length > 0) {
                stablePatterns.add(alias.trim());
            }
        }
        if (query.includeHistoricalAnchors) {
            for (const anchor of query.profile.metadata.historical_anchors) {
                const kw = parseAnchorKeyword(anchor);
                if (kw) stablePatterns.add(kw);
            }
        }
        for (const extra of query.extraKeywords ?? []) {
            if (extra.trim().length > 0) {
                stablePatterns.add(extra.trim());
            }
        }

        const allMatches: Array<{ match: RipgrepMatch; candidatePatterns: string[] }> = [];

        if (stablePatterns.size > 0) {
            const patterns = Array.from(stablePatterns);
            const matches = await this.system.ripgrepSearch(bookRoot, patterns, candidateFiles, 2);
            for (const match of matches) {
                allMatches.push({ match, candidatePatterns: patterns });
            }
        }

        // 2. 限章/限时间窗职务称谓（按 active_ch / story_day 过滤后分组执行 rg -C 2）
        const titleRules = buildEffectiveRuleList(query).filter((rule) =>
            rule.title.length > 0 && isRuleActiveAtTarget(rule, query)
        );

        for (const rule of titleRules) {
            const eligibleFiles = candidateFiles.filter((file) => {
                const ch = parseChapterNumberFromPath(file);
                if (ch === null) return false;
                return isChapterEligibleForRule(rule, ch, chapterDayMap.get(ch));
            });
            if (eligibleFiles.length === 0) continue;

            const matches = await this.system.ripgrepSearch(bookRoot, [rule.title], eligibleFiles, 2);
            for (const match of matches) {
                allMatches.push({ match, candidatePatterns: [rule.title] });
            }
        }

        // 3. 按 (file, line) 去重合并并包装强制时间差信封
        const merged = new Map<string, RecallSlice>();

        for (const { match, candidatePatterns } of allMatches) {
            const normalizedFile = match.file.replace(/\\/g, '/');
            const chapterNumber = parseChapterNumberFromPath(normalizedFile);
            if (chapterNumber === null) continue;

            const key = `${normalizedFile}:${match.line}`;
            const hitKeys = candidatePatterns.filter((p) =>
                new RegExp(escapeRegExp(p)).test(match.text)
            );

            const existing = merged.get(key);
            if (existing) {
                for (const k of hitKeys) {
                    if (!existing.matchedKeys.includes(k)) {
                        existing.matchedKeys.push(k);
                    }
                }
                continue;
            }

            const chapterId = formatChapterId(chapterNumber);
            const chapterDay = chapterDayMap.get(chapterNumber) ?? null;
            const deltaChapters = query.targetChapter - chapterNumber;
            const deltaDays = chapterDay !== null ? query.targetDay - chapterDay : null;
            const envelope = formatTimeDeltaEnvelope(
                chapterNumber,
                chapterDay,
                query.targetChapter,
                query.targetDay
            );

            const contextBefore = match.contextBefore.slice(-2);
            const contextAfter = match.contextAfter.slice(0, 2);
            const bodyLines = [...contextBefore, match.text, ...contextAfter];
            const snippet = `${envelope}\n${bodyLines.join('\n')}`;

            merged.set(key, {
                file: normalizedFile,
                chapterId,
                chapterNumber,
                chapterDay,
                targetChapter: query.targetChapter,
                targetDay: query.targetDay,
                deltaChapters,
                deltaDays,
                line: match.line,
                text: match.text,
                contextBefore,
                contextAfter,
                matchedKeys: hitKeys.length > 0 ? hitKeys : [...candidatePatterns],
                snippet
            });
        }

        return Array.from(merged.values()).sort((a, b) => {
            if (a.chapterNumber !== b.chapterNumber) {
                return a.chapterNumber - b.chapterNumber;
            }
            return a.line - b.line;
        });
    }

    /** 伏笔/唯一道具/关键证据「实体档案 + 原稿切片」成对回表校验 */
    async verifyPairedRecall(bookRoot: string, query: PairedRecallQuery): Promise<PairedRecallResult> {
        const slices = await this.recallEntitySlices(bookRoot, {
            ...query,
            includeHistoricalAnchors: query.includeHistoricalAnchors ?? true
        });

        const declaredByChapter = collectEntityDeclaredChapters(query.profile, query.targetChapter);
        const slicesByChapter = new Map<number, RecallSlice[]>();

        for (const slice of slices) {
            const list = slicesByChapter.get(slice.chapterNumber) ?? [];
            list.push(slice);
            slicesByChapter.set(slice.chapterNumber, list);
        }

        const allChapters = new Set<number>([
            ...declaredByChapter.keys(),
            ...slicesByChapter.keys()
        ]);

        const targetChapterList = (
            query.focusChapters && query.focusChapters.length > 0
                ? query.focusChapters
                : Array.from(allChapters)
        ).sort((a, b) => a - b);

        const chapterVerifications: PairedChapterEvidence[] = [];
        const unpairedIssues: PairedChapterEvidence[] = [];

        for (const chapterNumber of targetChapterList) {
            const declared = declaredByChapter.get(chapterNumber);
            const hasEntityRecord = Boolean(
                declared && (declared.entries.length > 0 || declared.anchors.length > 0)
            );
            const chapterSlices = slicesByChapter.get(chapterNumber) ?? [];
            const hasManuscriptAnchor = chapterSlices.length > 0;

            let status: PairedRecallStatus;
            if (hasEntityRecord && hasManuscriptAnchor) {
                status = 'paired';
            } else if (hasEntityRecord && !hasManuscriptAnchor) {
                status = 'missing_manuscript_anchor';
            } else {
                status = 'missing_entity_record';
            }

            const evidence: PairedChapterEvidence = {
                chapterNumber,
                chapterId: formatChapterId(chapterNumber),
                status,
                entityEntries: declared ? [...declared.entries] : [],
                historicalAnchors: declared ? [...declared.anchors] : [],
                manuscriptSlices: chapterSlices
            };
            chapterVerifications.push(evidence);
            if (status !== 'paired') {
                unpairedIssues.push(evidence);
            }
        }

        const paired = unpairedIssues.length === 0;
        return {
            entityId: query.profile.metadata.entity_id,
            canonicalName: query.profile.metadata.canonical_name,
            paired,
            overallStatus: paired ? 'paired' : 'unpaired',
            slices,
            chapterVerifications,
            unpairedIssues
        };
    }

    private async resolveCandidateChapterFiles(
        bookRoot: string,
        query: EntityRecallQuery
    ): Promise<string[]> {
        let files: string[];
        if (query.chapterFiles && query.chapterFiles.length > 0) {
            files = query.chapterFiles.map((f) => f.replace(/\\/g, '/'));
        } else {
            const entries = await listOptionalDir(join(bookRoot, 'manuscripts'));
            files = entries
                .filter((name) => CHAPTER_FILE_RE.test(name))
                .map((name) => `manuscripts/${name}`);
        }

        return files
            .filter((file) => {
                const ch = parseChapterNumberFromPath(file);
                return ch !== null && ch <= query.targetChapter;
            })
            .sort((a, b) => {
                const chA = parseChapterNumberFromPath(a) ?? 0;
                const chB = parseChapterNumberFromPath(b) ?? 0;
                return chA - chB;
            });
    }

    private async resolveChapterDayMap(
        bookRoot: string,
        chapterFiles: string[],
        explicitDays?: Record<number, number>
    ): Promise<Map<number, number>> {
        const map = new Map<number, number>();
        if (explicitDays) {
            for (const [k, v] of Object.entries(explicitDays)) {
                const ch = Number(k);
                if (Number.isInteger(ch) && Number.isInteger(v)) {
                    map.set(ch, v);
                }
            }
        }

        for (const file of chapterFiles) {
            const ch = parseChapterNumberFromPath(file);
            if (ch === null || map.has(ch)) continue;
            const content = await readOptionalUtf8(join(bookRoot, file));
            if (content !== null) {
                const meta = extractChapterMetadata(content);
                if (meta.storyDay !== undefined) {
                    map.set(ch, meta.storyDay);
                }
            }
        }

        return map;
    }
}

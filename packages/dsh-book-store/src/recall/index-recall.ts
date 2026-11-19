import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SystemPort } from '../ports/system.js';
import { splitFrontmatter } from '../store/entity-parser.js';
import { EntityEntry, EntityProfile, WorldStateFrontmatterSchema } from '../store/schemas.js';

const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;
const VOLUME_CARD_FILE_RE = /^vol_(\d+)_cards\.md$/;
const LORE_FILE_RE = /^lore_.*\.md$/;

const DEFAULT_L2_FULL_UNFROZEN_THRESHOLD = 40;
const DEFAULT_L2_FREEZE_BLOCK_CHAPTERS = 20;

/** 暂存区只读回调：返回 string 表示覆盖内容，null 表示暂存删除，undefined 表示回落磁盘 */
export type StagingReadFn = (
    relativePath: string
) => string | null | undefined | Promise<string | null | undefined>;

/** 暂存与章节哈希校验透传项 */
export interface RecallReadOptions {
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    stagingRead?: StagingReadFn | undefined;
    chapterHashes?: Record<string, string> | undefined;
}

/** 章节索引条目 */
export interface ChapterIndexEntry {
    chapterNumber: number;
    chapterId: string;
    relativePath: string;
    volumeNumber: number;
    storyDay?: number | undefined;
    title?: string | undefined;
}

/** 解析后的 L2 卷级章卡单章结构 */
export interface L2CardSection {
    chapterNumber: number;
    chapterId: string;
    dayLabel: string;
    plotSummary: string;
    anomalyAnchors: string[];
    appearedEntityIds: string[];
    rawSection: string;
}

/** 构建双层目录的可选参数 */
export interface BuildCatalogOptions extends RecallReadOptions {
    currentVolume?: number | undefined;
    chapterFiles?: string[];
    l2FullUnfrozenThreshold?: number | undefined;
    l2FreezeBlockChapters?: number | undefined;
    librarianRecentL2Window?: number | undefined;
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
export interface EntityRecallQuery extends RecallReadOptions {
    profile: EntityProfile;
    targetChapter: number;
    targetDay: number;
    chapterFiles?: string[] | undefined;
    chapterDays?: Record<number, number> | undefined;
    contextualTitleRules?: ContextualTitleRule[] | undefined;
    appearanceChapters?: number[] | undefined;
    extraKeywords?: string[] | undefined;
    includeHistoricalAnchors?: boolean | undefined;
    focusChapters?: number[] | undefined;
    maxSlicesPerEntity?: number | undefined;
    sliceContextParagraphs?: number | undefined;
    sliceMaxChars?: number | undefined;
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
    | 'missing_entity_record'
    | 'missing_both';

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

interface CachedParagraph {
    index: number;
    startLine: number;
    endLine: number;
    text: string;
    lines: string[];
}

interface ParsedChapterContent {
    title?: string | undefined;
    storyDay?: number | undefined;
    lines: string[];
    paragraphs: CachedParagraph[];
}

interface CachedChapterEntry extends ParsedChapterContent {
    mtimeMs: number;
    size: number;
    chapterHash?: string | undefined;
}

interface ScoredCandidateSlice {
    slice: RecallSlice;
    score: number;
}

function normalizeRelativePath(relPath: string): string {
    return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
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

async function readTextWithStaging(
    bookRoot: string,
    relativePath: string,
    options?: RecallReadOptions
): Promise<string | null> {
    const normalized = normalizeRelativePath(relativePath);
    if (options?.stagingOverlay && options.stagingOverlay.has(normalized)) {
        return options.stagingOverlay.get(normalized) ?? null;
    }
    if (options?.stagingRead) {
        const staged = await options.stagingRead(normalized);
        if (staged !== undefined) {
            return staged;
        }
    }
    return await readOptionalUtf8(join(bookRoot, normalized));
}

async function listDirWithStaging(
    bookRoot: string,
    relDir: string,
    fileFilter: RegExp,
    options?: RecallReadOptions
): Promise<string[]> {
    const normalizedDir = normalizeRelativePath(relDir).replace(/\/+$/, '');
    const names = new Set<string>(
        (await listOptionalDir(join(bookRoot, normalizedDir))).filter((name) => fileFilter.test(name))
    );

    if (options?.stagingOverlay) {
        const prefix = `${normalizedDir}/`;
        for (const [key, value] of options.stagingOverlay.entries()) {
            const normKey = normalizeRelativePath(key);
            if (!normKey.startsWith(prefix)) continue;
            const fileName = normKey.slice(prefix.length);
            if (fileName.includes('/') || !fileFilter.test(fileName)) continue;
            if (value === null) {
                names.delete(fileName);
            } else {
                names.add(fileName);
            }
        }
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function formatChapterId(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}`;
}

function normalizeChapterRelativePath(file: string): string {
    const normalized = normalizeRelativePath(file);
    if (!normalized.includes('/') && CHAPTER_FILE_RE.test(normalized)) {
        return `manuscripts/${normalized}`;
    }
    return normalized;
}

function parseChapterNumberFromPath(relativePath: string): number | null {
    const normalized = normalizeRelativePath(relativePath);
    const fileName = normalized.split('/').pop() ?? '';
    const match = CHAPTER_FILE_RE.exec(fileName);
    if (!match?.[1]) return null;
    const num = Number(match[1]);
    return Number.isInteger(num) && num > 0 ? num : null;
}

function resolveExpectedChapterHash(
    chapterHashes: Record<string, string> | undefined,
    normalizedPath: string,
    chapterNumber: number | null
): string | undefined {
    if (!chapterHashes) return undefined;
    if (chapterNumber !== null) {
        const chId = formatChapterId(chapterNumber);
        if (chapterHashes[chId] !== undefined) {
            return chapterHashes[chId];
        }
    }
    return chapterHashes[normalizedPath];
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

function parseChapterContent(content: string): ParsedChapterContent {
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const meta = extractChapterMetadata(normalized);

    const paragraphs: CachedParagraph[] = [];
    let currentLines: string[] = [];
    let currentStartLine = 0;

    const flushParagraph = (endLine: number) => {
        if (currentLines.length === 0) return;
        paragraphs.push({
            index: paragraphs.length,
            startLine: currentStartLine,
            endLine,
            text: currentLines.join('\n'),
            lines: currentLines
        });
        currentLines = [];
        currentStartLine = 0;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.trim().length === 0) {
            flushParagraph(i);
        } else {
            if (currentLines.length === 0) {
                currentStartLine = i + 1;
            }
            currentLines.push(line);
        }
    }
    flushParagraph(lines.length);

    return {
        title: meta.title,
        storyDay: meta.storyDay,
        lines,
        paragraphs
    };
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

function splitListField(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[,，、\s]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item !== '无');
}

function splitCommaField(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[,，、;；]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item !== '无');
}

function extractFirstSentence(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    const match = /^.+?[。！？!?](?=\s|$|[^0-9])/.exec(normalized);
    if (match) {
        return match[0].trim();
    }
    const fallback = /^.+?[。！？!?]/.exec(normalized);
    return (fallback ? fallback[0] : normalized).trim();
}

/** 主线和支线合卷共用写法；特殊锚点用 JSON 数组而非标点分隔。 */
export function upsertVolumeCardEntry(
    raw: string | null, volume: number, chapter: number, day: number, summary: string,
    appeared: readonly string[], anchors: readonly string[] = []
): string {
    const base = raw?.trim() ? raw.replace(/\r\n/g, '\n') : `# 第 ${volume} 卷双轨章卡`;
    const id = formatChapterId(chapter);
    const unique = [...new Set(anchors.map((s) => s.trim()).filter(Boolean))];
    const block = [
        `## ${id} (day:${day})`,
        /[\r\n\u2028\u2029]/.test(summary) ? `- 主干剧情(JSON)：${JSON.stringify(summary.trim())}` : `- 主干剧情：${summary.trim()}`,
        unique.some((s) => /[,，、;；\r\n]/.test(s) || s === '无')
            ? `- 异象锚点(JSON)：${JSON.stringify(unique)}`
            : `- 异象锚点：${unique.join('、') || '无'}`,
        `- 出场实体：${[...new Set(appeared.map((s) => s.trim()).filter(Boolean))].join(', ')}`
    ].join('\n');
    const section = new RegExp(`^##[ \\t]+${id}\\b[^\\n]*(?:\\n|$)[\\s\\S]*?(?=^##[ \\t]+ch_\\d{4}\\b|(?![\\s\\S]))`, 'm');
    return section.test(base) ? `${base.replace(section, () => `${block}\n\n`).trimEnd()}\n` : `${base.trimEnd()}\n\n${block}\n`;
}

/** 解析 L2 卷级章卡为结构化单章列表，同时兼容中文全角与英文半角冒号 */
export function parseL2CardSections(cardContent: string): {
    preamble: string;
    sections: L2CardSection[];
} {
    const normalized = cardContent.replace(/\r\n/g, '\n');
    const headingRe = /^##\s+ch_(\d{4})\b[^\n]*$/gm;
    const matches: Array<{ index: number; chapterNumber: number; headingLine: string }> = [];

    let match: RegExpExecArray | null = headingRe.exec(normalized);
    while (match !== null) {
        if (match[1]) {
            const chapterNumber = Number(match[1]);
            if (Number.isInteger(chapterNumber) && chapterNumber > 0) {
                matches.push({
                    index: match.index,
                    chapterNumber,
                    headingLine: match[0]
                });
            }
        }
        match = headingRe.exec(normalized);
    }

    if (matches.length === 0) {
        return { preamble: normalized.trim(), sections: [] };
    }

    const preamble = normalized.slice(0, matches[0]?.index ?? 0).trim();
    const sections: L2CardSection[] = [];

    for (let i = 0; i < matches.length; i++) {
        const cur = matches[i];
        if (!cur) continue;
        const nextIndex = matches[i + 1]?.index ?? normalized.length;
        const rawSection = normalized.slice(cur.index, nextIndex).trimEnd();
        const dayMatch = /\(day\s*[:：]\s*([^)\s]+)\)/.exec(cur.headingLine);
        const dayLabel = dayMatch?.[1] ? `day:${dayMatch[1]}` : 'day:unknown';

        const plotJson = /^-[ \t]*主干剧情\(JSON\)[ \t]*[:：][ \t]*([^\n]*)/m.exec(rawSection);
        const anchorJson = /^-[ \t]*异象锚点\(JSON\)[ \t]*[:：][ \t]*([^\n]*)/m.exec(rawSection);
        const plotMatch = /^-[ \t]*(?:主干剧情|主干)[ \t]*[:：][ \t]*([\s\S]*?)(?=^-[ \t]*(?:异象锚点(?:\(JSON\))?|锚点|出场实体)[ \t]*[:：]|(?![\s\S]))/m.exec(rawSection);
        const anchorMatch = /^-[ \t]*(?:异象锚点|锚点)[ \t]*[:：][ \t]*([^\n]*)/m.exec(rawSection);
        const entityMatch = /^-[ \t]*出场实体[ \t]*[:：][ \t]*([^\n]*)/m.exec(rawSection);
        const plot: unknown = plotJson ? JSON.parse(plotJson[1]!) : plotMatch?.[1]?.trim() ?? '';
        const anchors: unknown = anchorJson ? JSON.parse(anchorJson[1]!) : splitCommaField(anchorMatch?.[1]);
        if (typeof plot !== 'string' || !Array.isArray(anchors) || !anchors.every((s) => typeof s === 'string')) {
            throw new Error(`章卡 ${cur.headingLine} 摘要或锚点格式错误`);
        }

        sections.push({
            chapterNumber: cur.chapterNumber,
            chapterId: formatChapterId(cur.chapterNumber),
            dayLabel,
            plotSummary: plot,
            anomalyAnchors: anchors,
            appearedEntityIds: [...new Set(splitListField(entityMatch?.[1]))],
            rawSection
        });
    }

    return { preamble, sections };
}

/** 读取所有卷的可见章卡，分支覆盖层优先于磁盘。 */
export async function readBookL2Sections(bookRoot: string, options?: RecallReadOptions): Promise<L2CardSection[]> {
    const dir = 'index/L2_cards';
    const sections: L2CardSection[] = [];
    for (const name of await listDirWithStaging(bookRoot, dir, VOLUME_CARD_FILE_RE, options)) {
        const raw = await readTextWithStaging(bookRoot, `${dir}/${name}`, options);
        if (raw) sections.push(...parseL2CardSections(raw).sections);
    }
    return sections;
}

export async function readChapterDays(bookRoot: string, options?: RecallReadOptions): Promise<Record<number, number>> {
    const days: Record<number, number> = {};
    for (const section of await readBookL2Sections(bookRoot, options)) {
        const match = /^day:(-?\d+)$/.exec(section.dayLabel);
        if (match) days[section.chapterNumber] = Number(match[1]);
    }
    return days;
}

function formatFoldedL2Line(section: L2CardSection): string {
    const firstSentence = extractFirstSentence(section.plotSummary);
    const parts: string[] = [`- ${section.chapterId} (${section.dayLabel})`];
    if (firstSentence) {
        parts.push(firstSentence);
    }
    if (section.appearedEntityIds.length > 0) {
        parts.push(`出场实体: ${section.appearedEntityIds.join(', ')}`);
    }
    return parts.join(' | ');
}

function extractChaptersInCard(cardContent: string): Set<number> {
    const { sections } = parseL2CardSections(cardContent);
    return new Set(sections.map((section) => section.chapterNumber));
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

function parseAnchorKeyword(anchor: string): string | null {
    const colonMatch = /[:：]/.exec(anchor);
    if (!colonMatch) {
        const trimmed = anchor.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    const keyword = anchor.slice(colonMatch.index + 1).trim();
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
        return query.contextualTitleRules.map((rule) => ({
            ...rule,
            appearanceChapters: rule.appearanceChapters ?? query.appearanceChapters ?? []
        }));
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
    if (!rule.appearanceChapters?.includes(chapterNumber)) return false;
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

function isWarpedStatus(status: unknown): boolean {
    return typeof status === 'string' && status.trim().toUpperCase() === 'WARPED';
}

function extractEntryLinkedChapters(entry: EntityEntry, maxChapter: number): Set<number> {
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
    return linkedChapters;
}

function collectEntityDeclaredChapters(profile: EntityProfile, maxChapter: number): Map<number, {
    entries: EntityEntry[];
    anchors: string[];
}> {
    const map = new Map<number, { entries: EntityEntry[]; anchors: string[] }>();
    if (isWarpedStatus(profile.metadata.status)) {
        return map;
    }

    const ensureBucket = (ch: number): { entries: EntityEntry[]; anchors: string[] } => {
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
            const fullText = [entry.text, ...entry.continuationLines].join('\n');
            if (isWarpedStatus(entry.status) || /\bWARPED\b/i.test(fullText)) {
                continue;
            }
            for (const ch of extractEntryLinkedChapters(entry, maxChapter)) {
                ensureBucket(ch).entries.push(entry);
            }
        }
    }

    for (const anchor of profile.metadata.historical_anchors) {
        if (/\bWARPED\b/i.test(anchor)) continue;
        const ch = parseAnchorChapter(anchor);
        if (ch !== null && ch <= maxChapter) {
            ensureBucket(ch).anchors.push(anchor);
        }
    }

    return map;
}

function parseExplicitChapterDayMap(explicitDays?: Record<number, number>): Map<number, number> {
    const map = new Map<number, number>();
    if (!explicitDays) return map;
    for (const [k, v] of Object.entries(explicitDays)) {
        const ch = Number(k);
        if (Number.isInteger(ch) && Number.isInteger(v)) {
            map.set(ch, v);
        }
    }
    return map;
}

interface ParsedVolumeCard {
    volumeNumber: number;
    fileName: string;
    content: string;
}

function partitionActiveVolumeCard(
    card: ParsedVolumeCard,
    threshold: number,
    blockSize: number
): { frozenBlocks: string[]; dynamicCard: ParsedVolumeCard | null } {
    const parsedCard = parseL2CardSections(card.content);
    const sortedSections = [...parsedCard.sections].sort(
        (a, b) => a.chapterNumber - b.chapterNumber
    );
    if (blockSize <= 0 || sortedSections.length <= threshold) {
        return { frozenBlocks: [], dynamicCard: card };
    }

    const frozenCount = Math.floor((sortedSections.length - 1) / blockSize) * blockSize;
    if (frozenCount <= 0) {
        return { frozenBlocks: [], dynamicCard: card };
    }

    const frozenSections = sortedSections.slice(0, frozenCount);
    const unfrozenSections = sortedSections.slice(frozenCount);
    const frozenBlocks: string[] = [];

    for (let start = 0; start < frozenSections.length; start += blockSize) {
        const block = frozenSections.slice(start, start + blockSize);
        const firstCh = block[0]?.chapterId ?? '';
        const lastCh = block.at(-1)?.chapterId ?? '';
        const foldedLines = block.map((section) => formatFoldedL2Line(section));
        frozenBlocks.push(
            `## Frozen Active Volume Index: ${card.fileName} (${firstCh}-${lastCh})\n${foldedLines.join('\n')}`
        );
    }

    const remainingContent = [
        parsedCard.preamble,
        ...unfrozenSections.map((section) => section.rawSection)
    ]
        .filter(Boolean)
        .join('\n\n');

    const dynamicCard =
        remainingContent.trim().length > 0
            ? { volumeNumber: card.volumeNumber, fileName: card.fileName, content: remainingContent }
            : null;

    return { frozenBlocks, dynamicCard };
}

interface RecallSearchTerms {
    stableIdentityKeys: Set<string>;
    phraseTerms: Set<string>;
    queryTerms: Set<string>;
    extraSearchPatterns: Set<string>;
}

function buildRecallSearchTerms(query: EntityRecallQuery): RecallSearchTerms {
    const stableIdentityKeys = new Set<string>();
    const canonicalName = query.profile.metadata.canonical_name.trim();
    if (canonicalName.length > 0) {
        stableIdentityKeys.add(canonicalName);
    }
    for (const alias of query.profile.metadata.unique_aliases) {
        if (alias.trim().length > 0) {
            stableIdentityKeys.add(alias.trim());
        }
    }
    if (query.includeHistoricalAnchors) {
        for (const anchor of query.profile.metadata.historical_anchors) {
            const kw = parseAnchorKeyword(anchor);
            if (kw) stableIdentityKeys.add(kw);
        }
    }

    const phraseTerms = new Set<string>();
    const queryTerms = new Set<string>();
    const extraSearchPatterns = new Set<string>();

    for (const rawExtra of query.extraKeywords ?? []) {
        const trimmed = rawExtra.trim();
        if (trimmed.length === 0) continue;
        extraSearchPatterns.add(trimmed);
        const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
        if (tokens.length <= 1) {
            queryTerms.add(trimmed);
            continue;
        }
        phraseTerms.add(trimmed);
        for (const tok of tokens) {
            queryTerms.add(tok);
            if (tok.length >= 2) {
                extraSearchPatterns.add(tok);
            }
        }
    }

    return { stableIdentityKeys, phraseTerms, queryTerms, extraSearchPatterns };
}

function scoreCorpusText(
    corpusText: string,
    chapterNumber: number,
    inFocusChapter: boolean,
    chapterIdentityKeys: Set<string>,
    queryTerms: Set<string>,
    phraseTerms: Set<string>
): number {
    let matchedIdentityCount = 0;
    for (const key of chapterIdentityKeys) {
        if (corpusText.includes(key)) matchedIdentityCount++;
    }
    let matchedQueryCount = 0;
    for (const term of queryTerms) {
        if (corpusText.includes(term)) matchedQueryCount++;
    }
    let exactPhraseCount = 0;
    for (const phrase of phraseTerms) {
        if (corpusText.includes(phrase)) exactPhraseCount++;
    }
    return (
        (inFocusChapter ? 1000 : 0) +
        exactPhraseCount * 100 +
        matchedQueryCount * 30 +
        matchedIdentityCount * 20 +
        chapterNumber * 0.01
    );
}

function resolvePairedStatus(
    hasEntityRecord: boolean,
    hasManuscriptAnchor: boolean
): PairedRecallStatus {
    if (hasEntityRecord && hasManuscriptAnchor) return 'paired';
    if (hasEntityRecord) return 'missing_manuscript_anchor';
    if (hasManuscriptAnchor) return 'missing_entity_record';
    return 'missing_both';
}

function truncateSliceBody(
    matchedText: string,
    contextBefore: string[],
    contextAfter: string[],
    matchedPatterns: string[],
    maxBodyChars: number
): string {
    if (maxBodyChars <= 0) return '';

    let core = matchedText;
    if (core.length > maxBodyChars) {
        let firstHit = -1;
        for (const pat of matchedPatterns) {
            const idx = core.indexOf(pat);
            if (idx !== -1 && (firstHit === -1 || idx < firstHit)) {
                firstHit = idx;
            }
        }
        if (maxBodyChars === 1) {
            return core.slice(0, 1);
        }
        const windowLen = maxBodyChars - 1;
        const start = firstHit > windowLen ? Math.max(0, firstHit - Math.floor(windowLen / 3)) : 0;
        const end = Math.min(core.length, start + windowLen);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < core.length ? '…' : '';
        const budget = Math.max(1, maxBodyChars - prefix.length - suffix.length);
        core = `${prefix}${core.slice(start, start + budget)}${suffix}`;
        return core.slice(0, maxBodyChars);
    }

    const beforeAcc: string[] = [];
    const afterAcc: string[] = [];
    let currentLen = core.length;

    const maxCtxLen = Math.max(contextBefore.length, contextAfter.length);
    for (let offset = 0; offset < maxCtxLen; offset++) {
        const prevIdx = contextBefore.length - 1 - offset;
        if (prevIdx >= 0) {
            const prev = contextBefore[prevIdx] ?? '';
            if (currentLen + 1 + prev.length <= maxBodyChars) {
                beforeAcc.unshift(prev);
                currentLen += 1 + prev.length;
            }
        }
        if (offset < contextAfter.length) {
            const next = contextAfter[offset] ?? '';
            if (currentLen + 1 + next.length <= maxBodyChars) {
                afterAcc.push(next);
                currentLen += 1 + next.length;
            }
        }
    }

    return [...beforeAcc, core, ...afterAcc].join('\n');
}

function buildSnippetWithMaxChars(
    envelope: string,
    matchedText: string,
    contextBefore: string[],
    contextAfter: string[],
    matchedPatterns: string[],
    sliceMaxChars: number | undefined
): string {
    const fullBody = [...contextBefore, matchedText, ...contextAfter].join('\n');
    const fullSnippet = `${envelope}\n${fullBody}`;
    if (sliceMaxChars === undefined) {
        return fullSnippet;
    }
    if (sliceMaxChars <= 0) {
        return '';
    }
    if (fullSnippet.length <= sliceMaxChars) {
        return fullSnippet;
    }
    const maxBodyChars = sliceMaxChars - envelope.length - 1;
    if (maxBodyChars <= 0) {
        return '';
    }
    const truncatedBody = truncateSliceBody(
        matchedText,
        contextBefore,
        contextAfter,
        matchedPatterns,
        maxBodyChars
    );
    return `${envelope}\n${truncatedBody}`.slice(0, sliceMaxChars);
}

/** 确定性双层目录构建、实例缓存内存回表与成对校验引擎 */
export class IndexRecall {
    private readonly chapterCacheByBook = new Map<string, Map<string, CachedChapterEntry>>();

    constructor(private readonly system?: SystemPort) {
        void this.system;
    }

    /** 清空章节解析缓存（指定 bookRoot 时仅清该书，否则清空全部实例缓存） */
    clearCache(bookRoot?: string): void {
        if (bookRoot !== undefined) {
            this.chapterCacheByBook.delete(resolve(bookRoot));
            return;
        }
        this.chapterCacheByBook.clear();
    }

    private getBookCache(bookRoot: string): Map<string, CachedChapterEntry> {
        const key = resolve(bookRoot);
        let cache = this.chapterCacheByBook.get(key);
        if (!cache) {
            cache = new Map<string, CachedChapterEntry>();
            this.chapterCacheByBook.set(key, cache);
        }
        return cache;
    }

    private async loadChapterData(
        bookRoot: string,
        relativePath: string,
        options?: RecallReadOptions
    ): Promise<ParsedChapterContent | null> {
        const normalizedPath = normalizeRelativePath(relativePath);
        if (options?.stagingOverlay && options.stagingOverlay.has(normalizedPath)) {
            const staged = options.stagingOverlay.get(normalizedPath) ?? null;
            return staged === null ? null : parseChapterContent(staged);
        }
        if (options?.stagingRead) {
            const staged = await options.stagingRead(normalizedPath);
            if (staged !== undefined) {
                return staged === null ? null : parseChapterContent(staged);
            }
        }

        const absPath = join(bookRoot, normalizedPath);
        const bookCache = this.getBookCache(bookRoot);
        let fileStat;
        try {
            fileStat = await stat(absPath);
        } catch {
            bookCache.delete(normalizedPath);
            return null;
        }
        if (!fileStat.isFile()) {
            bookCache.delete(normalizedPath);
            return null;
        }

        const chapterNumber = parseChapterNumberFromPath(normalizedPath);
        const expectedHash = resolveExpectedChapterHash(options?.chapterHashes, normalizedPath, chapterNumber);
        const cached = bookCache.get(normalizedPath);

        if (
            cached &&
            cached.mtimeMs === fileStat.mtimeMs &&
            cached.size === fileStat.size &&
            (expectedHash === undefined || cached.chapterHash === expectedHash)
        ) {
            return cached;
        }

        let rawContent: string;
        try {
            rawContent = await readFile(absPath, 'utf8');
        } catch {
            bookCache.delete(normalizedPath);
            return null;
        }

        const parsed = parseChapterContent(rawContent);
        const entry: CachedChapterEntry = {
            ...parsed,
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
            chapterHash: expectedHash
        };
        bookCache.set(normalizedPath, entry);
        return entry;
    }

    /** 构建「已封旧卷静态区 + 当前活跃卷动态尾目录」双层目录 */
    async buildLibrarianCatalog(bookRoot: string, options: BuildCatalogOptions = {}): Promise<LibrarianCatalog> {
        let currentVolume = await this.resolveCurrentVolume(bookRoot, options);
        const parsedVolumeCards = await this.loadParsedVolumeCards(bookRoot, options);

        if (currentVolume === undefined) {
            currentVolume = parsedVolumeCards.at(-1)?.volumeNumber ?? 1;
        }

        // 1. 构建静态区（lore 摘要 + L0 + L1 + 已封旧卷章卡 + 超阈值定长冻结块）
        const staticParts: string[] = [];

        const loreFiles = await listDirWithStaging(bookRoot, 'lore_library', LORE_FILE_RE, options);
        if (loreFiles.length > 0) {
            const loreSummaries: string[] = ['## Lore Library Index'];
            for (const fileName of loreFiles) {
                const content = await readTextWithStaging(bookRoot, `lore_library/${fileName}`, options);
                if (content !== null) {
                    loreSummaries.push(extractLoreSummary(fileName, content));
                }
            }
            staticParts.push(loreSummaries.join('\n'));
        }

        const l0Content = await readTextWithStaging(bookRoot, 'index/L0_sagas.md', options);
        if (l0Content !== null && l0Content.trim().length > 0) {
            staticParts.push(l0Content.trimEnd());
        }

        const l1Content = await readTextWithStaging(bookRoot, 'index/L1_volumes.md', options);
        if (l1Content !== null && l1Content.trim().length > 0) {
            staticParts.push(l1Content.trimEnd());
        }

        const sealedVolumes: number[] = [];
        const chapterToVolume = new Map<number, number>();
        const activeCards: ParsedVolumeCard[] = [];

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

        const threshold = options.l2FullUnfrozenThreshold ?? DEFAULT_L2_FULL_UNFROZEN_THRESHOLD;
        const blockSize = options.l2FreezeBlockChapters ?? DEFAULT_L2_FREEZE_BLOCK_CHAPTERS;
        const activeDynamicCards: ParsedVolumeCard[] = [];
        const recentWindow = options.librarianRecentL2Window ?? 20;
        const hiddenCardHints: string[] = [];

        for (const card of activeCards) {
            const parsed = parseL2CardSections(card.content);
            const sections = parsed.sections.sort((a, b) => a.chapterNumber - b.chapterNumber);
            let visibleCard = card;
            if (sections.length > recentWindow) {
                visibleCard = {
                    ...card,
                    content: [parsed.preamble, ...sections.slice(sections.length - recentWindow).map((section) => section.rawSection)]
                        .filter(Boolean).join('\n\n')
                };
                hiddenCardHints.push(`较早章节未预注入；请用 book_read 按 offset/limit 分页读取 index/L2_cards/${card.fileName}（offset 为从 1 开始的行号）。`);
            }
            const { frozenBlocks, dynamicCard } = partitionActiveVolumeCard(visibleCard, threshold, blockSize);
            staticParts.push(...frozenBlocks);
            if (dynamicCard) {
                activeDynamicCards.push(dynamicCard);
            }
        }

        const staticPrefix = staticParts.join('\n\n');

        // 2. 扫描手稿章节并构建动态尾目录（走实例章节缓存，避免 O(N) 重复读盘）
        const manuscriptFiles = await this.resolveCatalogManuscriptFiles(bookRoot, options);
        const chapters: ChapterIndexEntry[] = [];
        const activeChapterLines: string[] = [];

        for (const fileName of manuscriptFiles) {
            const relativePath = `manuscripts/${fileName}`;
            const chapterNumber = parseChapterNumberFromPath(relativePath);
            if (chapterNumber === null) continue;

            const cached = await this.loadChapterData(bookRoot, relativePath, options);
            if (!cached) continue;
            const volumeNumber = chapterToVolume.get(chapterNumber) ?? currentVolume;

            const entry: ChapterIndexEntry = {
                chapterNumber,
                chapterId: formatChapterId(chapterNumber),
                relativePath,
                volumeNumber,
                storyDay: cached.storyDay,
                title: cached.title
            };
            chapters.push(entry);

            if (volumeNumber >= currentVolume) {
                const dayPart = cached.storyDay !== undefined ? `day:${cached.storyDay}` : 'day:unknown';
                const titlePart = cached.title ? ` | ${cached.title}` : '';
                activeChapterLines.push(`- ${entry.chapterId} (${dayPart})${titlePart}`);
            }
        }

        chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);

        const dynamicParts: string[] = [];
        for (const card of activeDynamicCards) {
            dynamicParts.push(`## Active Volume Card: ${card.fileName}\n${card.content.trimEnd()}`);
        }
        const recentChapterLines = activeChapterLines.slice(Math.max(0, activeChapterLines.length - recentWindow));
        if (recentChapterLines.length > 0) {
            dynamicParts.push(`## Active Volume Chapters (Vol ${currentVolume})\n${recentChapterLines.join('\n')}`);
        }
        dynamicParts.push(...hiddenCardHints);

        const openThreads = await readTextWithStaging(bookRoot, 'world/open_threads.md', options);
        if (openThreads !== null && openThreads.trim().length > 0) {
            dynamicParts.push(`## Open Threads\n=== SOURCE_REF: world/open_threads.md ===\n${openThreads}`);
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

    private async resolveCurrentVolume(
        bookRoot: string,
        options: BuildCatalogOptions
    ): Promise<number | undefined> {
        if (options.currentVolume !== undefined) {
            return options.currentVolume;
        }
        const worldStateRaw = await readTextWithStaging(bookRoot, 'world/world_state.md', options);
        if (worldStateRaw === null) {
            return undefined;
        }
        try {
            const { rawYaml } = splitFrontmatter(worldStateRaw);
            const parsed = WorldStateFrontmatterSchema.parse(parseYaml(rawYaml));
            return parsed.current_volume;
        } catch {
            return undefined;
        }
    }

    private async loadParsedVolumeCards(
        bookRoot: string,
        options: BuildCatalogOptions
    ): Promise<ParsedVolumeCard[]> {
        const l2Files = await listDirWithStaging(bookRoot, 'index/L2_cards', VOLUME_CARD_FILE_RE, options);
        const allowedChapters = options.chapterFiles
            ? new Set(
                  options.chapterFiles
                      .map((file) => parseChapterNumberFromPath(file))
                      .filter((num): num is number => num !== null)
              )
            : null;

        const cards: ParsedVolumeCard[] = [];
        for (const fileName of l2Files) {
            const match = VOLUME_CARD_FILE_RE.exec(fileName);
            if (!match?.[1]) continue;
            let content = await readTextWithStaging(bookRoot, `index/L2_cards/${fileName}`, options);
            if (content === null) continue;

            if (allowedChapters) {
                const parsedCard = parseL2CardSections(content);
                const keptSections = parsedCard.sections
                    .filter((section) => allowedChapters.has(section.chapterNumber))
                    .map((section) => section.rawSection);
                content = [parsedCard.preamble, ...keptSections].filter(Boolean).join('\n\n');
            }
            cards.push({ volumeNumber: Number(match[1]), fileName, content });
        }

        return cards.sort((a, b) => a.volumeNumber - b.volumeNumber);
    }

    private async resolveCatalogManuscriptFiles(
        bookRoot: string,
        options: BuildCatalogOptions
    ): Promise<string[]> {
        if (!options.chapterFiles) {
            return await listDirWithStaging(bookRoot, 'manuscripts', CHAPTER_FILE_RE, options);
        }
        return options.chapterFiles
            .map((file) => normalizeRelativePath(file).split('/').pop() ?? '')
            .filter(
                (name) =>
                    CHAPTER_FILE_RE.test(name) &&
                    options.stagingOverlay?.get(`manuscripts/${name}`) !== null
            )
            .sort((a, b) => a.localeCompare(b));
    }

    private async collectEntityAppearanceChapters(
        bookRoot: string,
        query: EntityRecallQuery
    ): Promise<number[]> {
        const appearanceChapters: number[] = [];
        const l2Files = await listDirWithStaging(
            bookRoot,
            'index/L2_cards',
            VOLUME_CARD_FILE_RE,
            query
        );
        for (const file of l2Files) {
            const raw = await readTextWithStaging(bookRoot, `index/L2_cards/${file}`, query);
            if (!raw) continue;
            const { sections } = parseL2CardSections(raw);
            for (const section of sections) {
                if (section.appearedEntityIds.includes(query.profile.metadata.entity_id)) {
                    appearanceChapters.push(section.chapterNumber);
                }
            }
        }
        return appearanceChapters;
    }

    /** 多身份键实例缓存原稿检索（支持段级共现排序、focusChapters 优先与限流）并包装时间差信封 */
    async recallEntitySlices(bookRoot: string, query: EntityRecallQuery): Promise<RecallSlice[]> {
        if (query.maxSlicesPerEntity !== undefined && query.maxSlicesPerEntity <= 0) {
            return [];
        }

        const effectiveQuery =
            query.appearanceChapters !== undefined
                ? query
                : {
                      ...query,
                      appearanceChapters: await this.collectEntityAppearanceChapters(bookRoot, query)
                  };

        const candidateFiles = await this.resolveCandidateChapterFiles(bookRoot, effectiveQuery);
        if (candidateFiles.length === 0) {
            return [];
        }

        const terms = buildRecallSearchTerms(effectiveQuery);
        const activeTitleRules = buildEffectiveRuleList(effectiveQuery).filter(
            (rule) => rule.title.length > 0 && isRuleActiveAtTarget(rule, effectiveQuery)
        );
        const explicitDayMap = parseExplicitChapterDayMap(effectiveQuery.chapterDays ?? await readChapterDays(bookRoot, effectiveQuery));
        const focusSet = new Set<number>(
            (effectiveQuery.focusChapters ?? []).filter(
                (ch) => Number.isInteger(ch) && ch > 0 && ch <= effectiveQuery.targetChapter
            )
        );

        const focusFiles: string[] = [];
        const otherFiles: string[] = [];
        for (const file of candidateFiles) {
            const ch = parseChapterNumberFromPath(file);
            if (ch !== null && focusSet.has(ch)) {
                focusFiles.push(file);
            } else {
                otherFiles.push(file);
            }
        }

        const useParagraphMode =
            effectiveQuery.sliceContextParagraphs !== undefined ||
            effectiveQuery.sliceMaxChars !== undefined;
        const useRelevanceSort =
            focusSet.size > 0 ||
            effectiveQuery.maxSlicesPerEntity !== undefined ||
            terms.queryTerms.size > 0;

        const searchBatch = async (files: string[]): Promise<ScoredCandidateSlice[]> => {
            const batchResults: ScoredCandidateSlice[] = [];
            for (const file of files) {
                const chapterNumber = parseChapterNumberFromPath(file);
                if (chapterNumber === null) continue;

                const chapterData = await this.loadChapterData(bookRoot, file, effectiveQuery);
                if (!chapterData) continue;

                const chapterDay = explicitDayMap.get(chapterNumber) ?? chapterData.storyDay ?? null;
                const eligibleTitleKeys = activeTitleRules
                    .filter((rule) => isChapterEligibleForRule(rule, chapterNumber, chapterDay ?? undefined))
                    .map((rule) => rule.title);

                const chapterIdentityKeys = new Set<string>([
                    ...terms.stableIdentityKeys,
                    ...eligibleTitleKeys
                ]);
                const searchPatterns = Array.from(
                    new Set<string>([...chapterIdentityKeys, ...terms.extraSearchPatterns])
                );
                if (searchPatterns.length === 0) continue;

                batchResults.push(
                    ...this.searchChapterSlices(
                        file,
                        chapterNumber,
                        chapterDay,
                        chapterData,
                        effectiveQuery,
                        focusSet.has(chapterNumber),
                        searchPatterns,
                        chapterIdentityKeys,
                        terms.queryTerms,
                        terms.phraseTerms,
                        useParagraphMode
                    )
                );
            }
            return batchResults;
        };

        const scoredSlices: ScoredCandidateSlice[] = [];
        if (focusFiles.length > 0) {
            scoredSlices.push(...(await searchBatch(focusFiles)));
        }

        const hasEnoughFromFocus =
            focusSet.size > 0 &&
            effectiveQuery.maxSlicesPerEntity !== undefined &&
            scoredSlices.length >= effectiveQuery.maxSlicesPerEntity;

        if (!hasEnoughFromFocus && otherFiles.length > 0) {
            scoredSlices.push(...(await searchBatch(otherFiles)));
        }

        scoredSlices.sort((a, b) => {
            if (useRelevanceSort) {
                return b.score - a.score || a.slice.line - b.slice.line;
            }
            return a.slice.chapterNumber - b.slice.chapterNumber || a.slice.line - b.slice.line;
        });

        const ordered = scoredSlices.map((item) => item.slice);
        if (effectiveQuery.maxSlicesPerEntity !== undefined) {
            return ordered.slice(0, effectiveQuery.maxSlicesPerEntity);
        }
        return ordered;
    }

    private searchChapterSlices(
        file: string,
        chapterNumber: number,
        chapterDay: number | null,
        chapterData: ParsedChapterContent,
        query: EntityRecallQuery,
        inFocusChapter: boolean,
        searchPatterns: string[],
        chapterIdentityKeys: Set<string>,
        queryTerms: Set<string>,
        phraseTerms: Set<string>,
        useParagraphMode: boolean
    ): ScoredCandidateSlice[] {
        const chapterId = formatChapterId(chapterNumber);
        const deltaChapters = query.targetChapter - chapterNumber;
        const deltaDays = chapterDay !== null ? query.targetDay - chapterDay : null;
        const envelope = formatTimeDeltaEnvelope(
            chapterNumber,
            chapterDay,
            query.targetChapter,
            query.targetDay
        );

        const computeScore = (corpusText: string): number =>
            scoreCorpusText(
                corpusText,
                chapterNumber,
                inFocusChapter,
                chapterIdentityKeys,
                queryTerms,
                phraseTerms
            );

        if (useParagraphMode) {
            return this.searchParagraphSlices({
                file,
                chapterId,
                chapterNumber,
                chapterDay,
                deltaChapters,
                deltaDays,
                envelope,
                chapterData,
                query,
                searchPatterns,
                computeScore
            });
        }

        return this.searchLineSlices({
            file,
            chapterId,
            chapterNumber,
            chapterDay,
            deltaChapters,
            deltaDays,
            envelope,
            chapterData,
            query,
            searchPatterns,
            computeScore
        });
    }

    private searchParagraphSlices(params: {
        file: string;
        chapterId: string;
        chapterNumber: number;
        chapterDay: number | null;
        deltaChapters: number;
        deltaDays: number | null;
        envelope: string;
        chapterData: ParsedChapterContent;
        query: EntityRecallQuery;
        searchPatterns: string[];
        computeScore: (corpusText: string) => number;
    }): ScoredCandidateSlice[] {
        const {
            file,
            chapterId,
            chapterNumber,
            chapterDay,
            deltaChapters,
            deltaDays,
            envelope,
            chapterData,
            query,
            searchPatterns,
            computeScore
        } = params;
        const results: ScoredCandidateSlice[] = [];
        const contextParagraphs = Math.max(0, query.sliceContextParagraphs ?? 1);

        for (let pIdx = 0; pIdx < chapterData.paragraphs.length; pIdx++) {
            const paragraph = chapterData.paragraphs[pIdx];
            if (!paragraph) continue;
            const matchedKeys = searchPatterns.filter((pat) => paragraph.text.includes(pat));
            if (matchedKeys.length === 0) continue;

            let firstMatchLine = paragraph.startLine;
            for (let lineOffset = 0; lineOffset < paragraph.lines.length; lineOffset++) {
                const lineText = paragraph.lines[lineOffset] ?? '';
                if (matchedKeys.some((pat) => lineText.includes(pat))) {
                    firstMatchLine = paragraph.startLine + lineOffset;
                    break;
                }
            }

            const contextBefore = chapterData.paragraphs
                .slice(Math.max(0, pIdx - contextParagraphs), pIdx)
                .map((p) => p.text);
            const contextAfter = chapterData.paragraphs
                .slice(pIdx + 1, pIdx + 1 + contextParagraphs)
                .map((p) => p.text);

            const snippet = buildSnippetWithMaxChars(envelope, paragraph.text, contextBefore, contextAfter, matchedKeys, query.sliceMaxChars);
            if (!snippet) continue;
            results.push({
                score: computeScore(paragraph.text),
                slice: {
                    file,
                    chapterId,
                    chapterNumber,
                    chapterDay,
                    targetChapter: query.targetChapter,
                    targetDay: query.targetDay,
                    deltaChapters,
                    deltaDays,
                    line: firstMatchLine,
                    text: paragraph.text,
                    contextBefore,
                    contextAfter,
                    matchedKeys,
                    snippet
                }
            });
        }

        return results;
    }

    private searchLineSlices(params: {
        file: string;
        chapterId: string;
        chapterNumber: number;
        chapterDay: number | null;
        deltaChapters: number;
        deltaDays: number | null;
        envelope: string;
        chapterData: ParsedChapterContent;
        query: EntityRecallQuery;
        searchPatterns: string[];
        computeScore: (corpusText: string) => number;
    }): ScoredCandidateSlice[] {
        const {
            file,
            chapterId,
            chapterNumber,
            chapterDay,
            deltaChapters,
            deltaDays,
            envelope,
            chapterData,
            query,
            searchPatterns,
            computeScore
        } = params;
        // 传统行级 -C 2 模式（向后兼容既有行号与 contextBefore/contextAfter 语义），评分基于所在自然段共现
        const paragraphByLine = new Map<number, CachedParagraph>();
        for (const p of chapterData.paragraphs) {
            for (let ln = p.startLine; ln <= p.endLine; ln++) {
                paragraphByLine.set(ln, p);
            }
        }

        const results: ScoredCandidateSlice[] = [];
        for (let lineIdx = 0; lineIdx < chapterData.lines.length; lineIdx++) {
            const lineText = chapterData.lines[lineIdx] ?? '';
            const matchedKeys = searchPatterns.filter((pat) => lineText.includes(pat));
            if (matchedKeys.length === 0) continue;

            const lineNumber = lineIdx + 1;
            const contextBefore = chapterData.lines.slice(Math.max(0, lineIdx - 2), lineIdx);
            const contextAfter = chapterData.lines.slice(lineIdx + 1, lineIdx + 3);
            const snippet = buildSnippetWithMaxChars(envelope, lineText, contextBefore, contextAfter, matchedKeys, query.sliceMaxChars);
            if (!snippet) continue;
            const containingParagraph = paragraphByLine.get(lineNumber);

            results.push({
                score: computeScore(containingParagraph?.text ?? lineText),
                slice: {
                    file,
                    chapterId,
                    chapterNumber,
                    chapterDay,
                    targetChapter: query.targetChapter,
                    targetDay: query.targetDay,
                    deltaChapters,
                    deltaDays,
                    line: lineNumber,
                    text: lineText,
                    contextBefore,
                    contextAfter,
                    matchedKeys,
                    snippet
                }
            });
        }

        return results;
    }

    /** 伏笔/唯一道具/关键证据「实体档案 + 原稿切片」成对回表校验 */
    async verifyPairedRecall(bookRoot: string, query: PairedRecallQuery): Promise<PairedRecallResult> {
        // 成对审计绝不应用 focusChapters/maxSlicesPerEntity 截断，确保跨章证据完整性
        const slices = await this.recallEntitySlices(bookRoot, {
            ...query,
            focusChapters: undefined,
            maxSlicesPerEntity: undefined,
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

        const hasFocusChapters = Boolean(query.focusChapters && query.focusChapters.length > 0);
        const targetChapterList = (
            hasFocusChapters
                ? [...new Set(query.focusChapters)]
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
            const status = resolvePairedStatus(hasEntityRecord, chapterSlices.length > 0);

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

        const paired = chapterVerifications.length > 0 && unpairedIssues.length === 0;
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
        if (query.chapterFiles !== undefined) {
            files = query.chapterFiles
                .map((f) => normalizeChapterRelativePath(f))
                .filter((f) => query.stagingOverlay?.get(f) !== null);
        } else {
            const entries = await listDirWithStaging(bookRoot, 'manuscripts', CHAPTER_FILE_RE, query);
            files = entries.map((name) => `manuscripts/${name}`);
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

    /** 按需获取候选章节的故事日映射（优先显式映射，其余直接走实例缓存读取） */
    async resolveChapterDayMap(
        bookRoot: string,
        chapterFiles: string[],
        explicitDays?: Record<number, number>,
        options?: RecallReadOptions
    ): Promise<Map<number, number>> {
        const map = parseExplicitChapterDayMap(explicitDays);

        for (const file of chapterFiles) {
            const normalized = normalizeChapterRelativePath(file);
            const ch = parseChapterNumberFromPath(normalized);
            if (ch === null || map.has(ch)) continue;
            const cached = await this.loadChapterData(bookRoot, normalized, options);
            if (cached?.storyDay !== undefined) {
                map.set(ch, cached.storyDay);
            }
        }

        return map;
    }
}

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    BookRetrievalConfigSchema,
    IndexRecall,
    isRetiredLore,
    parseEntityMarkdown,
    readChapterDays,
    splitFrontmatter,
    verifyDualQuotes,
    type EntityProfile,
    type NarrateStoreService,
    type RecallSlice
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PathFence } from '../tools/path-fence.js';
import {
    buildCombinedStagingOverlay,
    isEnoentError,
    normalizeRelPosixPath,
    readOptionalBookConfig
} from '../tools/shared.js';
import {
    extractActiveThreadEntityRefs,
    LibrarianOutputSchema,
    type LibrarianOutput
} from './schemas.js';
import { readOptionalWithOverlay } from './shared.js';

export interface YieldContextPackResult {
    payload: LibrarianOutput;
    recalledSlices: RecallSlice[];
    selectedLoreEntries: string[];
    selectedLoreSources: Array<{ path: string; content: string }>;
}

export interface YieldContextPackOptions {
    store: NarrateStoreService;
    bookRoot: string;
    runId: string;
    fence?: PathFence | undefined;
    targetChapter?: number | undefined;
    targetDay?: number | undefined;
    chapterGoal?: string | undefined;
    allowedChapterFiles?: string[] | undefined;
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    onYield?: ((result: YieldContextPackResult) => void) | undefined;
}

const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;
const MANUSCRIPT_CHAPTER_RE = /^manuscripts\/ch_(\d{4})\.md$/;
const L2_CARD_FILE_RE = /^vol_(\d+)_cards\.md$/;
const DEFAULT_RETRIEVAL_CFG = BookRetrievalConfigSchema.parse({});

function parseChapterNumberFromName(nameOrPath: string): number | null {
    const base = nameOrPath.split('/').pop() ?? '';
    const match = CHAPTER_FILE_RE.exec(base);
    if (!match?.[1]) return null;
    const n = Number(match[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeChapterFileName(raw: string): string {
    const normalized = normalizeRelPosixPath(raw);
    return normalized.split('/').pop() ?? normalized;
}

function extractChapterStoryDay(content: string): number | null {
    const normalized = content.replace(/\r\n/g, '\n');
    if (normalized.startsWith('---\n')) {
        try {
            const split = splitFrontmatter(normalized);
            const parsed = parseYaml(split.rawYaml) as Record<string, unknown> | null;
            if (parsed && typeof parsed['story_day'] === 'number' && Number.isInteger(parsed['story_day'])) {
                return parsed['story_day'];
            }
        } catch {
            // 忽略损坏 frontmatter
        }
    }
    const commentMatch = /<!--\s*story_day:\s*(-?\d+)\s*-->/.exec(normalized);
    if (commentMatch?.[1]) {
        const day = Number(commentMatch[1]);
        if (Number.isInteger(day)) {
            return day;
        }
    }
    return null;
}

function truncateSliceText(text: string, maxChars: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, Math.max(1, maxChars - 1))}…`;
}

async function listAccessibleManuscriptChapters(
    bookRoot: string,
    overlay: ReadonlyMap<string, string | null>,
    allowedChapterFiles?: string[]
): Promise<string[]> {
    const names = new Set<string>();
    try {
        const files = await readdir(join(bookRoot, 'manuscripts'));
        for (const f of files) {
            if (CHAPTER_FILE_RE.test(f)) {
                names.add(f);
            }
        }
    } catch (err: unknown) {
        if (!isEnoentError(err)) {
            throw err;
        }
    }

    for (const [relPath, content] of overlay.entries()) {
        if (!relPath.startsWith('manuscripts/')) continue;
        const base = relPath.slice('manuscripts/'.length);
        if (!CHAPTER_FILE_RE.test(base)) continue;
        if (content === null) {
            names.delete(base);
        } else {
            names.add(base);
        }
    }

    let sorted = Array.from(names).sort();
    if (allowedChapterFiles !== undefined) {
        const allowedSet = new Set(allowedChapterFiles.map(normalizeChapterFileName));
        sorted = sorted.filter((name) => allowedSet.has(name));
    }
    return sorted;
}

async function collectAccessibleL2AppearedSet(
    bookRoot: string,
    overlay: ReadonlyMap<string, string | null>,
    targetChapter: number,
    accessiblePastChapterNums: ReadonlySet<number>
): Promise<Set<string>> {
    const appeared = new Set<string>();
    const cardFiles = new Set<string>();
    try {
        const entries = await readdir(join(bookRoot, 'index/L2_cards'));
        for (const entry of entries) {
            if (L2_CARD_FILE_RE.test(entry)) {
                cardFiles.add(`index/L2_cards/${entry}`);
            }
        }
    } catch (err: unknown) {
        if (!isEnoentError(err)) {
            throw err;
        }
    }
    for (const [relPath, content] of overlay.entries()) {
        if (relPath.startsWith('index/L2_cards/') && L2_CARD_FILE_RE.test(relPath.slice('index/L2_cards/'.length))) {
            if (content === null) {
                cardFiles.delete(relPath);
            } else {
                cardFiles.add(relPath);
            }
        }
    }

    for (const relPath of cardFiles) {
        const content = await readOptionalWithOverlay(bookRoot, overlay, relPath);
        if (!content) continue;
        const normalized = content.replace(/\r\n/g, '\n');
        const sections = normalized.split(/(?=^##\s+ch_\d{4}\b)/m);
        for (const section of sections) {
            const headerMatch = /^##\s+ch_(\d{4})\b/.exec(section);
            if (!headerMatch?.[1]) continue;
            const chNum = Number(headerMatch[1]);
            if (chNum <= 0 || chNum >= targetChapter || !accessiblePastChapterNums.has(chNum)) {
                continue;
            }
            const appMatch = /^-\s*出场实体[:：]([^\n]*)/m.exec(section);
            if (!appMatch?.[1]) continue;
            for (const idMatch of appMatch[1].matchAll(/\b((?:char|item)_[a-zA-Z0-9_]+)\b/g)) {
                if (idMatch[1]) {
                    appeared.add(idMatch[1]);
                }
            }
        }
    }

    return appeared;
}

function hasAccessibleHistoricalAnchor(
    profile: EntityProfile,
    targetChapter: number,
    accessiblePastChapterNums: ReadonlySet<number>
): boolean {
    for (const anchor of profile.metadata.historical_anchors) {
        for (const match of anchor.matchAll(/\bch_(\d{4})\b/g)) {
            if (!match[1]) continue;
            const chNum = Number(match[1]);
            if (chNum > 0 && chNum < targetChapter && accessiblePastChapterNums.has(chNum)) {
                return true;
            }
        }
    }
    return false;
}

interface TaggedRecallSlice {
    slice: RecallSlice;
    entityId?: string | undefined;
}

interface ContextPackRuntimeConfig {
    effectiveTargetChapter: number;
    effectiveTargetDay: number;
    retrievalCfg: typeof DEFAULT_RETRIEVAL_CFG;
    chapterHashes: Record<string, string> | undefined;
}

async function resolveContextPackRuntimeConfig(
    store: NarrateStoreService,
    bookRoot: string,
    targetChapter: number | undefined,
    targetDay: number | undefined
): Promise<ContextPackRuntimeConfig> {
    const bookStore = store.openStore(bookRoot);
    let effectiveTargetChapter = targetChapter;
    let effectiveTargetDay = targetDay;
    if (effectiveTargetChapter === undefined || effectiveTargetDay === undefined) {
        try {
            const ws = await bookStore.readWorldState();
            effectiveTargetChapter ??= ws.frontmatter.current_chapter + 1;
            effectiveTargetDay ??= ws.frontmatter.story_day;
        } catch {
            effectiveTargetChapter ??= 1;
            effectiveTargetDay ??= 0;
        }
    }

    const cfg = await readOptionalBookConfig(store, bookRoot);
    const retrievalCfg = cfg?.retrieval
        ? { ...DEFAULT_RETRIEVAL_CFG, ...cfg.retrieval }
        : DEFAULT_RETRIEVAL_CFG;

    let chapterHashes: Record<string, string> | undefined;
    try {
        const txState = await bookStore.readTxState();
        chapterHashes = txState.chapter_hashes;
    } catch {
        // 忽略缺少 tx_state
    }

    return {
        effectiveTargetChapter,
        effectiveTargetDay,
        retrievalCfg,
        chapterHashes
    };
}

function assertRecallEntityPairing(
    parsed: LibrarianOutput,
    validPackEntityIds: ReadonlySet<string>
): void {
    for (const q of parsed.recall_queries) {
        if (!validPackEntityIds.has(q.entity_id)) {
            throw new GateValidationError(
                'yield_context_pack',
                `成对挂载校验失败：recall_queries 中的实体 ${q.entity_id} 未加入 selected_entity_ids`
            );
        }
    }
    for (const s of parsed.recall_slices) {
        if (s.entity_id && !validPackEntityIds.has(s.entity_id)) {
            throw new GateValidationError(
                'yield_context_pack',
                `成对挂载校验失败：recall_slices 中的实体 ${s.entity_id} 未加入 selected_entity_ids`
            );
        }
    }
}

async function validateSelectedLoreFiles(
    bookRoot: string,
    fence: PathFence,
    combinedOverlay: ReadonlyMap<string, string | null>,
    selectedLoreFiles: readonly string[]
): Promise<Array<{ path: string; content: string }>> {
    const entries = new Map<string, string>();
    for (const loreFile of selectedLoreFiles) {
        const normalizedInput = loreFile.replace(/\\/g, '/').trim();
        const relLorePath = normalizedInput.includes('/')
            ? normalizedInput
            : `lore_library/${normalizedInput}`;
        if (!relLorePath.startsWith('lore_library/')) {
            throw new GateValidationError(
                'yield_context_pack',
                `selected_lore_files 仅允许引用 lore_library/ 下的词条: ${loreFile}`
            );
        }
        const verifiedLore = await fence.assertReadFile(relLorePath);
        if (entries.has(verifiedLore.normalized)) continue;
        const loreContent = await readOptionalWithOverlay(
            bookRoot,
            combinedOverlay,
            verifiedLore.normalized
        );
        if (loreContent === null) {
            throw new GateValidationError(
                'yield_context_pack',
                `selected_lore_files 引用了不存在的世界书词条: ${loreFile}`
            );
        }
        if (isRetiredLore(loreContent)) {
            throw new GateValidationError(
                'yield_context_pack',
                `selected_lore_files 引用了已退役的世界书词条，请移除该选页: ${loreFile}`
            );
        }
        entries.set(verifiedLore.normalized, loreContent);
    }
    return Array.from(entries, ([path, content]) => ({ path, content }));
}

async function loadEntityProfileWithOverlay(
    bookRoot: string,
    combinedOverlay: ReadonlyMap<string, string | null>,
    cache: Map<string, EntityProfile>,
    entityId: string
): Promise<EntityProfile | null> {
    const cached = cache.get(entityId);
    if (cached) return cached;

    const activeRaw = await readOptionalWithOverlay(bookRoot, combinedOverlay, `entities/${entityId}.md`);
    if (activeRaw !== null) {
        const parsedProfile = parseEntityMarkdown(activeRaw);
        cache.set(entityId, parsedProfile);
        return parsedProfile;
    }

    const coldOverlayRaw = await readOptionalWithOverlay(
        bookRoot,
        combinedOverlay,
        `entities/cold_archive/${entityId}.md`
    );
    if (coldOverlayRaw !== null) {
        const parsedProfile = parseEntityMarkdown(coldOverlayRaw);
        cache.set(entityId, parsedProfile);
        return parsedProfile;
    }

    return null;
}

async function collectEntitiesRequiringL3(params: {
    bookRoot: string;
    combinedOverlay: ReadonlyMap<string, string | null>;
    chapterGoal: string | undefined;
    validPackEntityIds: ReadonlySet<string>;
    entityProfiles: ReadonlyMap<string, EntityProfile>;
    effectiveTargetChapter: number;
    accessiblePastChapterNums: ReadonlySet<number>;
}): Promise<Set<string>> {
    const {
        bookRoot,
        combinedOverlay,
        chapterGoal,
        validPackEntityIds,
        entityProfiles,
        effectiveTargetChapter,
        accessiblePastChapterNums
    } = params;

    const openThreadsRaw = await readOptionalWithOverlay(
        bookRoot,
        combinedOverlay,
        'world/open_threads.md'
    );
    const activeThreadRefs = openThreadsRaw
        ? extractActiveThreadEntityRefs(openThreadsRaw)
        : new Set<string>();

    if (chapterGoal) {
        for (const refId of activeThreadRefs) {
            if (chapterGoal.includes(refId) && !validPackEntityIds.has(refId)) {
                throw new GateValidationError(
                    'yield_context_pack',
                    `成对挂载校验失败：本章目标涉及活跃伏笔实体 ${refId}，但未列入 selected_entity_ids`
                );
            }
        }
    }

    const entitiesRequiringL3 = new Set<string>();
    if (accessiblePastChapterNums.size === 0) {
        return entitiesRequiringL3;
    }

    const accessibleL2AppearedSet = await collectAccessibleL2AppearedSet(
        bookRoot,
        combinedOverlay,
        effectiveTargetChapter,
        accessiblePastChapterNums
    );

    const candidateRequireIds = new Set<string>(validPackEntityIds);
    for (const refId of activeThreadRefs) {
        if (chapterGoal && chapterGoal.includes(refId)) {
            candidateRequireIds.add(refId);
        }
    }

    for (const entityId of candidateRequireIds) {
        const profile = entityProfiles.get(entityId);
        if (!profile) continue;
        const isUniqueItem = entityId.startsWith('item_');
        const hasAnchors = profile.metadata.historical_anchors.length > 0;
        const touchesThread = activeThreadRefs.has(entityId);
        if (!isUniqueItem && !hasAnchors && !touchesThread) {
            continue;
        }

        // Q1 首次登场豁免：仅当在 < targetChapter 的可达历史原稿/L2卡/锚点确有出场记录时，才强制要求 >= 1 条 L3 切片
        const hasPriorSeen =
            profile.metadata.last_seen_ch > 0 &&
            profile.metadata.last_seen_ch < effectiveTargetChapter &&
            accessiblePastChapterNums.has(profile.metadata.last_seen_ch);
        const hasPriorL2 = accessibleL2AppearedSet.has(entityId);
        const hasPriorAnchor = hasAccessibleHistoricalAnchor(
            profile,
            effectiveTargetChapter,
            accessiblePastChapterNums
        );

        if (hasPriorSeen || hasPriorL2 || hasPriorAnchor) {
            entitiesRequiringL3.add(entityId);
        }
    }

    return entitiesRequiringL3;
}

async function verifyAndEnvelopeManualSlices(params: {
    bookRoot: string;
    fence: PathFence;
    combinedOverlay: ReadonlyMap<string, string | null>;
    rawSlices: LibrarianOutput['recall_slices'];
    effectiveTargetChapter: number;
    effectiveTargetDay: number;
    chapterDays: Record<number, number>;
    accessiblePastChapterNums: ReadonlySet<number>;
    sliceMaxChars: number;
    sliceCountByEntity: Map<string, number>;
    entityProfiles: ReadonlyMap<string, EntityProfile>;
}): Promise<TaggedRecallSlice[]> {
    const {
        bookRoot,
        fence,
        combinedOverlay,
        rawSlices,
        effectiveTargetChapter,
        effectiveTargetDay,
        sliceMaxChars,
        sliceCountByEntity
    } = params;
    const manualSlices: TaggedRecallSlice[] = [];

    for (const [sliceIndex, rawSlice] of rawSlices.entries()) {
        if (!rawSlice.file || rawSlice.file.trim().length === 0) {
            throw new GateValidationError(
                'yield_context_pack',
                '手填 recall_slices 必须提供有效的 manuscripts/ch_XXXX.md 文件路径 file'
            );
        }
        const normalizedInput = rawSlice.file.replace(/\\/g, '/').trim();
        const relChapterPath =
            !normalizedInput.includes('/') && CHAPTER_FILE_RE.test(normalizedInput)
                ? `manuscripts/${normalizedInput}`
                : normalizedInput;

        const verified = await fence.assertReadFile(relChapterPath);
        const chMatch = MANUSCRIPT_CHAPTER_RE.exec(verified.normalized);
        if (!chMatch?.[1]) {
            throw new GateValidationError(
                'yield_context_pack',
                `手填 recall_slices 的 file 必须位于 manuscripts/ch_XXXX.md: ${rawSlice.file}`
            );
        }
        const realChapterNumber = Number(chMatch[1]);
        if (rawSlice.chapter_number !== undefined && rawSlice.chapter_number !== realChapterNumber) {
            throw new GateValidationError(
                'yield_context_pack',
                `手填 recall_slices 的 chapter_number (${rawSlice.chapter_number}) 与文件真实章号 (${realChapterNumber}) 不一致`
            );
        }
        if (realChapterNumber >= effectiveTargetChapter) {
            throw new GateValidationError(
                'yield_context_pack',
                `手填 recall_slices 禁止引用当前或未来章节 (${verified.normalized} >= ch_${String(effectiveTargetChapter).padStart(4, '0')})`
            );
        }

        if (!params.accessiblePastChapterNums.has(realChapterNumber)) {
            throw new GateValidationError('yield_context_pack', `本时间线不可引用手稿 ${verified.normalized}`);
        }
        const chapterText = await readOptionalWithOverlay(
            bookRoot,
            combinedOverlay,
            verified.normalized
        );
        if (chapterText === null) {
            throw new GateValidationError(
                'yield_context_pack',
                `手填 recall_slices 引用了不存在的手稿文件: ${verified.normalized}`
            );
        }

        const quoteVerify = verifyDualQuotes(
            rawSlice.snippet,
            chapterText,
            rawSlice.snippet,
            chapterText
        );
        if (!quoteVerify.sideA.matched) {
            throw new GateValidationError(
                'yield_context_pack',
                `手填 recall_slices 的 snippet 未在 ${verified.normalized} 原稿中命中，禁止捏造切片`
            );
        }

        const chapterDay = params.chapterDays[realChapterNumber] ?? extractChapterStoryDay(chapterText);
        const truncatedSnippet = truncateSliceText(rawSlice.snippet, sliceMaxChars);
        const profile = rawSlice.entity_id ? params.entityProfiles.get(rawSlice.entity_id) : undefined;
        const matchedKeys = profile ? [profile.metadata.entity_id, profile.metadata.canonical_name, ...profile.metadata.unique_aliases, ...profile.metadata.contextual_titles]
            .filter(key => key.length > 0 && truncatedSnippet.includes(key)) : [];
        if (rawSlice.entity_id && matchedKeys.length === 0) {
            throw new GateValidationError('yield_context_pack', `第 ${sliceIndex + 1} 条手填切片缺少实体 ${rawSlice.entity_id} 的身份依据（entity_id、canonical_name、unique_aliases 或 contextual_titles），请使用 recall_queries 核验`);
        }
        const envelopedSlice: RecallSlice = {
            file: verified.normalized,
            chapterId: `ch_${String(realChapterNumber).padStart(4, '0')}`,
            chapterNumber: realChapterNumber,
            chapterDay,
            targetChapter: effectiveTargetChapter,
            targetDay: effectiveTargetDay,
            deltaChapters: effectiveTargetChapter - realChapterNumber,
            deltaDays: chapterDay !== null ? effectiveTargetDay - chapterDay : null,
            line: quoteVerify.sideA.lineNumber ?? 1,
            text: truncatedSnippet,
            contextBefore: [],
            contextAfter: [],
            matchedKeys,
            snippet: truncatedSnippet
        };
        manualSlices.push({ slice: envelopedSlice, entityId: rawSlice.entity_id });
        if (rawSlice.entity_id) {
            sliceCountByEntity.set(
                rawSlice.entity_id,
                (sliceCountByEntity.get(rawSlice.entity_id) ?? 0) + 1
            );
        }
    }

    return manualSlices;
}

function prioritizeAndCapRecallSlices(
    allTagged: readonly TaggedRecallSlice[],
    entitiesRequiringL3: ReadonlySet<string>,
    requiredSlicesPerEntity: number,
    maxChapterSlices: number
): RecallSlice[] {
    const requiredMarkedCount = new Map<string, number>();
    const requiredSlices: RecallSlice[] = [];
    const optionalSlices: RecallSlice[] = [];

    for (const item of allTagged) {
        if (item.entityId && entitiesRequiringL3.has(item.entityId)) {
            const marked = requiredMarkedCount.get(item.entityId) ?? 0;
            if (marked < requiredSlicesPerEntity) {
                item.slice.requiredEntityId = item.entityId;
                requiredMarkedCount.set(item.entityId, marked + 1);
                requiredSlices.push(item.slice);
                continue;
            }
        }
        optionalSlices.push(item.slice);
    }

    return [...requiredSlices, ...optionalSlices].slice(0, maxChapterSlices);
}

/** 创建 Librarian 终态门禁工具 yield_context_pack（强制校验伏笔与证物成对挂载、手填切片验真与冷宫加载） */
export function createYieldContextPackTool(options: YieldContextPackOptions): ToolDefinition {
    const { store, bookRoot, runId, targetChapter, targetDay, chapterGoal, onYield } = options;
    const fence =
        options.fence ??
        new PathFence(bookRoot, {
            ...(options.allowedChapterFiles !== undefined
                ? { allowedChapterFiles: options.allowedChapterFiles }
                : {})
        });

    return defineTool({
        name: 'yield_context_pack',
        description:
            'Librarian 终态交接门禁。提交 selected_entity_ids、recall_queries / recall_slices 与 selected_lore_files；强制核验活跃伏笔或历史复现证物的「实体档案 + 至少 1 条 L3 原稿切片」成对挂载与手填切片原稿验真。',
        parameters: {
            selected_entity_ids: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '选中挂载的实体 ID 列表'
            },
            recall_queries: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        entity_id: { type: 'string', required: true },
                        extra_keywords: { type: 'array', items: { type: 'string' } },
                        focus_chapters: { type: 'array', items: { type: 'integer' } }
                    }
                },
                description: '需执行 L3 原稿回表的实体检索指令列表'
            },
            recall_slices: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        entity_id: { type: 'string' },
                        file: { type: 'string' },
                        chapter_number: { type: 'integer' },
                        snippet: { type: 'string', required: true }
                    }
                },
                description: '已核实的 L3 原稿切片；使用 recall_queries 时请省略或传 []。手填须包含原稿路径、逐字引文及实体身份词'
            },
            selected_lore_files: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description: '选中挂载的世界书文件名列表'
            },
            wakeup_entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description: '建议从冷归档唤醒的实体 ID 列表'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    selectedCount: { type: 'integer', required: true },
                    recalledSliceCount: { type: 'integer', required: true }
                }
            },
            render(_args, value) {
                return [
                    {
                        type: 'text',
                        text: `yield_context_pack 门禁通过：已选实体 ${value.selectedCount} 个，L3 原稿切片 ${value.recalledSliceCount} 条。`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const parsed = LibrarianOutputSchema.parse(args);

            const combinedOverlay = buildCombinedStagingOverlay(store, runId, options.stagingOverlay, {
                normalizeKeys: true
            });
            const selectedSet = new Set(parsed.selected_entity_ids);
            const wakeupSet = new Set(parsed.wakeup_entity_ids);
            const validPackEntityIds = new Set([...selectedSet, ...wakeupSet]);

            const accessibleChapterFiles = await listAccessibleManuscriptChapters(
                bookRoot,
                combinedOverlay,
                options.allowedChapterFiles
            );

            const {
                effectiveTargetChapter,
                effectiveTargetDay,
                retrievalCfg,
                chapterHashes
            } = await resolveContextPackRuntimeConfig(store, bookRoot, targetChapter, targetDay);

            const accessiblePastChapterNums = new Set<number>();
            for (const fileName of accessibleChapterFiles) {
                const ch = parseChapterNumberFromName(fileName);
                if (ch !== null && ch < effectiveTargetChapter) {
                    accessiblePastChapterNums.add(ch);
                }
            }

            // 1. 校验 recall_queries / recall_slices 中的实体必须同时出现在已选/唤醒集合中（无条件执行，严禁短路）
            assertRecallEntityPairing(parsed, validPackEntityIds);

            // 2. 校验 selected_lore_files 合法可达（支持 lore_xxx.md 或 lore_library/lore_xxx.md）
            const selectedLoreSources = await validateSelectedLoreFiles(
                bookRoot,
                fence,
                combinedOverlay,
                parsed.selected_lore_files
            );
            const selectedLoreEntries = selectedLoreSources.map(source => source.content);

            // 3. 加载已选及冷宫唤醒实体档案（支持 entities/ 与 entities/cold_archive/）
            const entityProfiles = new Map<string, EntityProfile>();
            for (const entityId of selectedSet) {
                const profile = await loadEntityProfileWithOverlay(
                    bookRoot,
                    combinedOverlay,
                    entityProfiles,
                    entityId
                );
                if (profile === null) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `selected_entity_ids 引用了不存在的实体档案: ${entityId}`
                    );
                }
            }
            for (const wakeupId of wakeupSet) {
                const profile = await loadEntityProfileWithOverlay(
                    bookRoot,
                    combinedOverlay,
                    entityProfiles,
                    wakeupId
                );
                if (profile === null) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `wakeup_entity_ids 引用了不存在的冷宫/实体档案: ${wakeupId}`
                    );
                }
            }

            // 4. 收集需要强制成对挂载 L3 原稿切片的实体集合（含 Q1 首次登场豁免）
            const entitiesRequiringL3 = await collectEntitiesRequiringL3({
                bookRoot,
                combinedOverlay,
                chapterGoal,
                validPackEntityIds,
                entityProfiles,
                effectiveTargetChapter,
                accessiblePastChapterNums
            });

            // 5. 校验手填 recall_slices 原稿存在性、章号一致性与时间差信封包覆
            const sliceCountByEntity = new Map<string, number>();
            const chapterDays = await readChapterDays(bookRoot, { stagingOverlay: combinedOverlay });
            const manualSlices = await verifyAndEnvelopeManualSlices({
                bookRoot,
                fence,
                combinedOverlay,
                rawSlices: parsed.recall_slices,
                entityProfiles,
                effectiveTargetChapter,
                effectiveTargetDay,
                chapterDays,
                accessiblePastChapterNums,
                sliceMaxChars: retrievalCfg.slice_max_chars,
                sliceCountByEntity
            });

            // 6. 通过 IndexRecall 执行 recall_queries（透传 focus_chapters、上限与支线隔离 chapterFiles）
            const recallEngine = new IndexRecall(store.system);
            const autoSlices: TaggedRecallSlice[] = [];

            for (const query of parsed.recall_queries) {
                const profile = await loadEntityProfileWithOverlay(
                    bookRoot,
                    combinedOverlay,
                    entityProfiles,
                    query.entity_id
                );
                if (profile === null) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `recall_queries 引用了不存在的实体档案: ${query.entity_id}`
                    );
                }
                const slices = await recallEngine.recallEntitySlices(bookRoot, {
                    profile,
                    targetChapter: effectiveTargetChapter,
                    targetDay: effectiveTargetDay,
                    chapterFiles: accessibleChapterFiles.filter(file => accessiblePastChapterNums.has(parseChapterNumberFromName(file) ?? 0)),
                    chapterDays,
                    stagingOverlay: combinedOverlay,
                    chapterHashes,
                    extraKeywords: query.extra_keywords,
                    focusChapters: query.focus_chapters,
                    maxSlicesPerEntity: retrievalCfg.max_slices_per_entity,
                    sliceContextParagraphs: retrievalCfg.slice_context_paragraphs,
                    sliceMaxChars: retrievalCfg.slice_max_chars,
                    includeHistoricalAnchors: true
                });
                for (const s of slices) {
                    autoSlices.push({ slice: s, entityId: query.entity_id });
                }
                sliceCountByEntity.set(
                    query.entity_id,
                    (sliceCountByEntity.get(query.entity_id) ?? 0) + slices.length
                );
            }

            // 7. 校验所有要求成对挂载的实体都至少拥有 1 条 L3 原稿切片
            for (const requiredId of entitiesRequiringL3) {
                if ((sliceCountByEntity.get(requiredId) ?? 0) < 1) {
                    throw new GateValidationError(
                        'yield_context_pack',
                        `成对挂载校验失败：实体 ${requiredId} 关联活跃伏笔/唯一道具/历史锚点，必须同时携带实体档案与至少 1 条 L3 原稿召回切片（当前为 0 条）`
                    );
                }
            }

            // 8. 标记 requiredEntityId 并按 max_slices_per_chapter_pack 封顶（优先保底必需证据切片）
            const recalledSlices = prioritizeAndCapRecallSlices(
                [...autoSlices, ...manualSlices],
                entitiesRequiringL3,
                retrievalCfg.required_slices_per_entity,
                retrievalCfg.max_slices_per_chapter_pack
            );

            onYield?.({
                payload: parsed,
                selectedLoreEntries,
                selectedLoreSources,
                recalledSlices
            });

            exec.concludeTurn();

            return {
                accepted: true,
                selectedCount: parsed.selected_entity_ids.length,
                recalledSliceCount: recalledSlices.length
            };
        }
    });
}

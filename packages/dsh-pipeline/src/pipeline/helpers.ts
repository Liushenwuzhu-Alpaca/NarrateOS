import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
    parseL2CardSections,
    serializeEntityMarkdown,
    type BookConfig,
    type BookSnapshot,
    type BookStore,
    type EntityPatch,
    type EntityProfile,
    type PreviousChapterContext,
    type RecallSlice,
    type SlicedView,
    type StaticPrefixInput,
    type TokenUsage
} from '@narrateos/dsh-book-store';

export const SIGNALS_CURSOR_REL_PATH = '.ops/signals_cursor.json';
export const HEAL_PLAN_REL_PATH = '.ops/heal_plan.json';
export const NEXT_CHAPTER_OPTIONS_REL_PATH = '.ops/next_chapter_options.json';

export const SignalsCursorSchema = z.object({
    consumedLines: z.number().int().nonnegative().default(0),
    consumedIds: z.array(z.string()).default([]),
    updatedAt: z.string()
});
export type SignalsCursorState = z.infer<typeof SignalsCursorSchema>;

/** 读取信号游标与已消费 ID 集合（不存在或损坏时安全回退空状态） */
export async function readSignalsCursorState(bookRoot: string): Promise<SignalsCursorState> {
    const raw = await readOptionalText(join(bookRoot, SIGNALS_CURSOR_REL_PATH));
    if (raw === null) {
        return { consumedLines: 0, consumedIds: [], updatedAt: new Date(0).toISOString() };
    }
    try {
        const parsed = SignalsCursorSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
            return parsed.data;
        }
    } catch {
        // 损坏游标文件安全回退空状态
    }
    return { consumedLines: 0, consumedIds: [], updatedAt: new Date(0).toISOString() };
}

/** 持久化信号行游标与已消费 ID 集合到 .ops/signals_cursor.json */
export async function writeSignalsCursorState(
    bookRoot: string,
    state: {
        consumedLines?: number | undefined;
        consumedIds?: readonly string[] | undefined;
    }
): Promise<SignalsCursorState> {
    const opsDir = join(bookRoot, '.ops');
    await mkdir(opsDir, { recursive: true });
    const uniqueIds = Array.from(
        new Set((state.consumedIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0))
    );
    const payload = SignalsCursorSchema.parse({
        consumedLines: Math.max(0, Math.floor(state.consumedLines ?? 0)),
        consumedIds: uniqueIds,
        updatedAt: new Date().toISOString()
    });
    await writeFile(
        join(bookRoot, SIGNALS_CURSOR_REL_PATH),
        `${JSON.stringify(payload, null, 4)}\n`,
        'utf8'
    );
    return payload;
}

/** 读取已消费信号行游标（不存在或损坏时安全回退 0，向后兼容） */
export async function readSignalsCursor(bookRoot: string): Promise<number> {
    const state = await readSignalsCursorState(bookRoot);
    return state.consumedLines;
}

/** 持久化已消费信号行游标到 .ops/signals_cursor.json（保留既有 consumedIds，向后兼容） */
export async function writeSignalsCursor(bookRoot: string, consumedLines: number): Promise<void> {
    const existing = await readSignalsCursorState(bookRoot);
    await writeSignalsCursorState(bookRoot, {
        consumedLines,
        consumedIds: existing.consumedIds
    });
}

/** 为单条 .ops/signals.jsonl 记录解析确定性唯一标识（优先使用显式 id 字段，否则哈希签名） */
export function resolveSignalId(record: Record<string, unknown>): string {
    if (typeof record['id'] === 'string' && record['id'].trim().length > 0) {
        return record['id'].trim();
    }
    const signature = JSON.stringify([
        typeof record['type'] === 'string' ? record['type'] : '',
        typeof record['created_at'] === 'string' ? record['created_at'] : '',
        typeof record['chapter'] === 'number' ? record['chapter'] : 0,
        typeof record['reason'] === 'string' ? record['reason'] : '',
        typeof record['entity_id'] === 'string' ? record['entity_id'] : '',
        typeof record['conflict_id'] === 'string' ? record['conflict_id'] : ''
    ]);
    return `sig_${createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 16)}`;
}

/** 安全追加单行 JSONL，确保前序内容以换行符收尾避免首尾粘连 */
export async function appendJsonlLineSafe(filePath: string, lineContent: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const existing = await readOptionalText(filePath);
    const trimmedLine = lineContent.replace(/\r?\n$/, '');
    if (existing !== null && existing.length > 0 && !existing.endsWith('\n')) {
        await appendFile(filePath, `\n${trimmedLine}\n`, 'utf8');
        return;
    }
    await appendFile(filePath, `${trimmedLine}\n`, 'utf8');
}

/** 三级自愈持久化断点 Schema (.ops/heal_plan.json) */
export const HealPlanSchema = z.object({
    conflictId: z.string().min(1).optional(),
    backupTag: z.string().min(1),
    fromChapter: z.number().int().positive(),
    toChapter: z.number().int().positive(),
    nextChapter: z.number().int().positive(),
    constraint: z.string().optional(),
    updatedAt: z.string()
}).refine(plan => plan.fromChapter <= plan.nextChapter && plan.nextChapter <= plan.toChapter + 1 && plan.fromChapter <= plan.toChapter, '自愈断点区间无效');
export type HealPlan = z.infer<typeof HealPlanSchema>;

/** 没有计划时返回 null；损坏的计划不可当作无待办处理。 */
export async function readHealPlan(bookRoot: string): Promise<HealPlan | null> {
    const raw = await readOptionalText(join(bookRoot, HEAL_PLAN_REL_PATH));
    if (raw === null) return null;
    return HealPlanSchema.parse(JSON.parse(raw));
}

/** 写入 .ops/heal_plan.json */
export async function writeHealPlan(
    bookRoot: string,
    plan: Omit<HealPlan, 'updatedAt'> & { updatedAt?: string | undefined }
): Promise<HealPlan> {
    const opsDir = join(bookRoot, '.ops');
    await mkdir(opsDir, { recursive: true });
    const payload = HealPlanSchema.parse({
        ...plan,
        updatedAt: plan.updatedAt ?? new Date().toISOString()
    });
    const path = join(bookRoot, HEAL_PLAN_REL_PATH);
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmp, `${JSON.stringify(payload, null, 4)}\n`, { flag: 'wx' });
        await rename(tmp, path);
    } finally {
        await rm(tmp, { force: true });
    }
    return payload;
}

/** 清理 .ops/heal_plan.json */
export async function clearHealPlan(bookRoot: string): Promise<void> {
    await rm(join(bookRoot, HEAL_PLAN_REL_PATH), { force: true });
}

/** .ops/next_chapter_options.json 持久化结构（兼容旧数组格式） */
export const NextChapterOptionsFileSchema = z.object({
    source_chapter: z.number().int().nonnegative(),
    options: z.array(z.string().min(1)).default([])
});
export type NextChapterOptionsFile = z.infer<typeof NextChapterOptionsFileSchema>;

/** 读取 .ops/next_chapter_options.json（兼容对象与旧数组格式） */
export async function readNextChapterOptions(
    bookRoot: string
): Promise<NextChapterOptionsFile | null> {
    const raw = await readOptionalText(join(bookRoot, NEXT_CHAPTER_OPTIONS_REL_PATH));
    if (raw === null) return null;
    try {
        const parsedJson: unknown = JSON.parse(raw);
        if (Array.isArray(parsedJson)) {
            const items = parsedJson.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
            return { source_chapter: 0, options: items };
        }
        const parsed = NextChapterOptionsFileSchema.safeParse(parsedJson);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** 写入 .ops/next_chapter_options.json */
export async function writeNextChapterOptions(
    bookRoot: string,
    sourceChapter: number,
    options: readonly string[]
): Promise<NextChapterOptionsFile> {
    const opsDir = join(bookRoot, '.ops');
    await mkdir(opsDir, { recursive: true });
    const payload = NextChapterOptionsFileSchema.parse({
        source_chapter: Math.max(0, Math.floor(sourceChapter)),
        options: options.map((s) => s.trim()).filter((s) => s.length > 0)
    });
    await writeFile(
        join(bookRoot, NEXT_CHAPTER_OPTIONS_REL_PATH),
        `${JSON.stringify(payload, null, 4)}\n`,
        'utf8'
    );
    return payload;
}

export const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;
export const VOLUME_CARD_FILE_RE = /^vol_(\d+)_cards\.md$/;

export function formatChapterKey(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}`;
}

export function formatChapterTag(chapterNumber: number): string {
    return `ch-${String(chapterNumber).padStart(4, '0')}`;
}

/** 格式化 L2 卷级章卡相对路径 */
export function formatVolumeCardRelPath(volumeNumber: number): string {
    return `index/L2_cards/vol_${String(volumeNumber).padStart(2, '0')}_cards.md`;
}

/** 拆分并过滤空行 */
export function splitNonEmptyLines(raw: string): string[] {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/** 解析 JSONL 文本，损坏行保留为 { raw } 对象 */
export function parseJsonLines(raw: string | null): unknown[] {
    if (raw === null) return [];
    const results: unknown[] = [];
    for (const trimmed of splitNonEmptyLines(raw)) {
        try {
            results.push(JSON.parse(trimmed));
        } catch {
            results.push({ raw: trimmed });
        }
    }
    return results;
}

/** 判断异常是否源于取消或停机中止信号 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
        return true;
    }
    if (err instanceof Error) {
        if (err.name === 'AbortError') return true;
        const code = (err as { code?: unknown }).code;
        if (code === 'ABORT_ERR' || code === 'ABORTED') return true;
        if (err.message === 'SAFE_HALT_REQUESTED' || err.message === 'Aborted') return true;
        return false;
    }
    if (typeof err === 'object' && err !== null) {
        return (err as { name?: unknown }).name === 'AbortError';
    }
    return false;
}

export function sha256Hex(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function countNonSpaceChars(text: string): number {
    return text.replace(/\s+/g, '').length;
}

export function createEmptyUsage(): TokenUsage {
    return {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0
    };
}

export function addUsage(target: TokenUsage, delta: TokenUsage): void {
    target.inputTokens += delta.inputTokens;
    target.cacheReadTokens += delta.cacheReadTokens;
    target.cacheWriteTokens += delta.cacheWriteTokens;
    target.outputTokens += delta.outputTokens;
}

export async function readOptionalText(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, 'utf8');
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

/** 构造同卷零字节变动的静态前缀输入 */
export function buildVolumeStaticPrefix(
    config: BookConfig,
    volumeNumber: number,
    staticBaseAndVoice?: string | null,
    currentArcEnvelope?: string | null,
    systemBaseline?: string | null
): StaticPrefixInput {
    const trimmedVoice = staticBaseAndVoice?.trim();
    const trimmedArc = currentArcEnvelope?.trim();
    const trimmedBase = systemBaseline?.trim();
    return {
        volumeNumber,
        worldStaticBaseline: `书名：${config.title} (${config.book_slug})`,
        ...(trimmedBase ? { systemBaseline: trimmedBase } : {}),
        ...(trimmedVoice ? { staticBaseAndVoice: trimmedVoice } : {}),
        ...(trimmedArc ? { currentArcEnvelope: trimmedArc } : {})
    };
}

/** 过滤空内容或仅含空标题的卷中风格修订文本 */
export function normalizeOpsStyleAmendments(raw: string | null): string | undefined {
    if (!raw) return undefined;
    const body = raw
        .replace(/^#\s*卷中风格修订\s*\((?:Ops )?Style Amendments\)\s*$/gm, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    if (!body) return undefined;
    return raw.trim();
}

/** 过滤空内容或仅含标题与注释的跨卷伏笔台账模板 */
export function normalizeOpenThreads(raw: string | null): string | undefined {
    if (!raw) return undefined;
    const body = raw
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^#+\s*.*$/gm, '')
        .trim();
    if (!body) return undefined;
    return raw.trim();
}

export { upsertVolumeCardEntry } from '@narrateos/dsh-book-store';

/** 将 SlicedView 中的实体、召回切片与卷包络序列化为审校验真语料 */
export function buildVerificationCorpus(
    slicedView: SlicedView,
    recallSlices: RecallSlice[],
    previousChapter?: PreviousChapterContext,
    currentArcEnvelope?: string | null
): string {
    const parts: string[] = [];
    for (const profile of Object.values(slicedView.entities)) {
        parts.push(serializeEntityMarkdown(profile));
    }
    for (const slice of recallSlices) {
        parts.push(slice.snippet);
    }
    if (previousChapter?.fullText) {
        parts.push(previousChapter.fullText);
    }
    if (currentArcEnvelope && currentArcEnvelope.trim().length > 0) {
        parts.push(`## 当前卷包络与阶段禁区 (current_arc_envelope.md)\n${currentArcEnvelope.trim()}`);
    }
    return parts.join('\n\n');
}

/** 剥离已知实体增量补丁中冗余的 canonical_name 覆写字段 */
export function sanitizeExtractorPatches(
    snapshot: BookSnapshot,
    patches: EntityPatch[]
): EntityPatch[] {
    return patches.map((patch) => {
        if (snapshot.entities[patch.entity_id] && patch.canonical_name !== undefined) {
            const { canonical_name: _ignored, ...rest } = patch;
            return rest;
        }
        return patch;
    });
}

/** 收集活跃实体主名与唯一别名集合（供脱专名或声纹过滤使用） */
export function collectEntityDisplayNames(
    entities: Readonly<Record<string, EntityProfile>>
): string[] {
    return Array.from(
        new Set(
            Object.values(entities).flatMap((profile) => [
                profile.metadata.canonical_name,
                ...profile.metadata.unique_aliases
            ])
        )
    );
}

/** 结合游标状态与 JSONL 原文还原已消费信号 ID 集合（兼容仅写 consumedLines 的旧游标） */
export function resolveConsumedSignalIds(
    cursorState: SignalsCursorState,
    nonEmptyLines: readonly string[]
): Set<string> {
    const consumedIds = new Set<string>(cursorState.consumedIds);
    if (
        consumedIds.size === 0 &&
        cursorState.consumedLines > 0 &&
        cursorState.consumedLines <= nonEmptyLines.length
    ) {
        for (let idx = 0; idx < cursorState.consumedLines; idx += 1) {
            try {
                const obj = JSON.parse(nonEmptyLines[idx]!) as Record<string, unknown>;
                consumedIds.add(resolveSignalId(obj));
            } catch {
                // 忽略损坏行
            }
        }
    }
    return consumedIds;
}

/** 从 L2 章卡的 dayLabel（如 day:3）解析故事日，失败时回退默认值 */
export function parseStoryDayLabel(dayLabel: string | undefined, fallbackDay: number): number {
    if (!dayLabel) return fallbackDay;
    const match = /^day:(-?\d+)$/i.exec(dayLabel.trim());
    if (!match?.[1]) return fallbackDay;
    const day = Number(match[1]);
    return Number.isInteger(day) ? day : fallbackDay;
}

export interface LocatedChapterL2Card {
    cardRelPath: string;
    cardVolume: number;
    cardRaw: string | null;
    section: ReturnType<typeof parseL2CardSections>['sections'][number] | undefined;
}

/** 定位指定章节所属的 L2 卷级章卡文件与对应章节分段 */
export async function locateChapterL2Card(
    bookRoot: string,
    chapterNumber: number,
    defaultVolume: number
): Promise<LocatedChapterL2Card> {
    const defaultRel = formatVolumeCardRelPath(defaultVolume);
    const defaultRaw = await readOptionalText(join(bookRoot, defaultRel));
    const defaultSec = defaultRaw
        ? parseL2CardSections(defaultRaw).sections.find((s) => s.chapterNumber === chapterNumber)
        : undefined;
    if (defaultSec) {
        return {
            cardRelPath: defaultRel,
            cardVolume: defaultVolume,
            cardRaw: defaultRaw,
            section: defaultSec
        };
    }

    const l2Dir = join(bookRoot, 'index/L2_cards');
    try {
        const files = (await readdir(l2Dir)).filter((f) => VOLUME_CARD_FILE_RE.test(f)).sort();
        for (const file of files) {
            const rel = `index/L2_cards/${file}`;
            const raw = await readOptionalText(join(bookRoot, rel));
            if (!raw) continue;
            const sec = parseL2CardSections(raw).sections.find(
                (s) => s.chapterNumber === chapterNumber
            );
            if (sec) {
                const parsedVol = Number(VOLUME_CARD_FILE_RE.exec(file)?.[1] ?? defaultVolume);
                return {
                    cardRelPath: rel,
                    cardVolume: Number.isFinite(parsedVol) ? parsedVol : defaultVolume,
                    cardRaw: raw,
                    section: sec
                };
            }
        }
    } catch {
        // index/L2_cards 目录尚未建立时回退当前卷文件
    }

    return {
        cardRelPath: defaultRel,
        cardVolume: defaultVolume,
        cardRaw: defaultRaw,
        section: undefined
    };
}

/** 将冷宫休眠实体按需临时加载入内存快照（不物理迁回主线 entities/） */
export async function wakeColdArchiveEntitiesInMemory(
    store: BookStore,
    snapshot: BookSnapshot,
    candidateIds: readonly string[],
    wokenColdIds?: Set<string>
): Promise<BookSnapshot> {
    if (snapshot.coldArchiveIds.length === 0 || candidateIds.length === 0) {
        return snapshot;
    }
    const coldSet = new Set(snapshot.coldArchiveIds);
    const toLoad = Array.from(
        new Set(candidateIds.filter((id) => coldSet.has(id) && !snapshot.entities[id]))
    );
    if (toLoad.length === 0) {
        return snapshot;
    }
    const loaded = await store.readColdArchivedEntities(toLoad);
    if (Object.keys(loaded).length === 0) {
        return snapshot;
    }
    if (wokenColdIds) {
        for (const id of Object.keys(loaded)) {
            wokenColdIds.add(id);
        }
    }
    return {
        ...snapshot,
        entities: {
            ...snapshot.entities,
            ...loaded
        }
    };
}

/** 扫描 .ops/parallel_deltas 下仍处于 OPEN 状态的并行时间线窗口 */
export async function listOpenParallelWindows(
    bookRoot: string
): Promise<Array<{ windowId: string; baseChapter: number }>> {
    const deltasDir = join(bookRoot, '.ops/parallel_deltas');
    let entries;
    try {
        entries = await readdir(deltasDir, { withFileTypes: true });
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return [];
        }
        throw err;
    }

    const openWindows: Array<{ windowId: string; baseChapter: number }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const raw = await readOptionalText(join(deltasDir, entry.name, 'window.json'));
        if (!raw) throw new Error(`并行窗口 ${entry.name} 缺少元数据`);
        const parsed = JSON.parse(raw) as { status?: unknown; baseChapter?: unknown };
        if (!parsed || !Number.isSafeInteger(parsed.baseChapter) || Number(parsed.baseChapter) < 0 || !['MERGED', 'ABORTED', 'OPEN'].includes(String(parsed.status))) {
            throw new Error(`并行窗口 ${entry.name} 元数据无效`);
        }
        if (parsed.status === 'OPEN') {
            openWindows.push({ windowId: entry.name, baseChapter: Number(parsed.baseChapter) });
        }
    }
    return openWindows;
}

/** 读取并合并 world/ops_style_amendments.md 与 .ops/style_amendments.md 中的有效风格修订 */
export async function readCombinedStyleAmendments(
    bookRoot: string,
    options?: {
        readWorldAmendments?: (() => Promise<string | null>) | undefined;
        order?: 'world-first' | 'ops-first' | undefined;
        dedupe?: boolean | undefined;
    }
): Promise<{
    combined: string | undefined;
    opsRaw: string | null;
    worldRaw: string | null;
}> {
    const readWorldAmendments = options?.readWorldAmendments;
    const order = options?.order ?? 'world-first';
    const dedupe = options?.dedupe ?? true;
    const [worldRaw, opsRaw] = await Promise.all([
        readWorldAmendments
            ? readWorldAmendments()
            : readOptionalText(join(bookRoot, 'world/ops_style_amendments.md')),
        readOptionalText(join(bookRoot, '.ops/style_amendments.md'))
    ]);
    const worldAmendment = normalizeOpsStyleAmendments(worldRaw);
    const opsAmendment = normalizeOpsStyleAmendments(opsRaw);
    const ordered =
        order === 'ops-first' ? [opsAmendment, worldAmendment] : [worldAmendment, opsAmendment];
    const nonEmpty = ordered.filter((s): s is string => Boolean(s));
    const parts = dedupe ? Array.from(new Set(nonEmpty)) : nonEmpty;
    return {
        combined: parts.length > 0 ? parts.join('\n\n') : undefined,
        opsRaw,
        worldRaw
    };
}

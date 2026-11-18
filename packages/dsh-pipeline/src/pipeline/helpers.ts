import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
    serializeEntityMarkdown,
    type BookConfig,
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
});
export type HealPlan = z.infer<typeof HealPlanSchema>;

/** 读取 .ops/heal_plan.json（不存在或损坏时返回 null） */
export async function readHealPlan(bookRoot: string): Promise<HealPlan | null> {
    const raw = await readOptionalText(join(bookRoot, HEAL_PLAN_REL_PATH));
    if (raw === null) return null;
    try {
        const parsed = HealPlanSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
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
    await writeFile(
        join(bookRoot, HEAL_PLAN_REL_PATH),
        `${JSON.stringify(payload, null, 4)}\n`,
        'utf8'
    );
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

export function formatChapterKey(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}`;
}

export function formatChapterTag(chapterNumber: number): string {
    return `ch-${String(chapterNumber).padStart(4, '0')}`;
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
        .replace(/^#\s*卷中风格修订\s*\(Ops Style Amendments\)\s*$/gm, '')
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

/** 追加或替换 L2 卷级章卡中的单章双轨摘要块（主干剧情 + 异象锚点 + 出场实体） */
export function upsertVolumeCardEntry(
    rawCardContent: string | null,
    currentVolume: number,
    chapterNumber: number,
    storyDay: number,
    chapterSummary: string,
    appearanceEntityIds: string[],
    proseAnchors?: readonly string[]
): string {
    const baseContent =
        rawCardContent && rawCardContent.trim().length > 0
            ? rawCardContent.replace(/\r\n/g, '\n')
            : `# 第 ${currentVolume} 卷双轨章卡\n\n`;
    const chKey = formatChapterKey(chapterNumber);
    const uniqueAnchors = proseAnchors
        ? Array.from(
              new Set(proseAnchors.map((a) => a.trim()).filter((a) => a.length > 0))
          )
        : [];
    const uniqueIds = Array.from(
        new Set(appearanceEntityIds.map((id) => id.trim()).filter((id) => id.length > 0))
    );
    const entryBlock = [
        `## ${chKey} (day:${storyDay})`,
        `- 主干剧情：${chapterSummary.trim()}`,
        `- 异象锚点：${uniqueAnchors.length > 0 ? uniqueAnchors.join('、') : '无'}`,
        `- 出场实体：${uniqueIds.join(', ')}`
    ].join('\n');
    const sectionRe = new RegExp(
        `^##\\s+${chKey}\\b[^\\n]*\\n[\\s\\S]*?(?=^##\\s+ch_\\d{4}\\b|(?![\\s\\S]))`,
        'm'
    );
    if (sectionRe.test(baseContent)) {
        const replaced = baseContent.replace(sectionRe, `${entryBlock}\n\n`);
        return `${replaced.trimEnd()}\n`;
    }
    return `${baseContent.trimEnd()}\n\n${entryBlock}\n`;
}

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

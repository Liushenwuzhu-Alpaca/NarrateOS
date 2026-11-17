import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export const SignalsCursorSchema = z.object({
    consumedLines: z.number().int().nonnegative(),
    updatedAt: z.string()
});

/** 读取已消费信号行游标（不存在或损坏时安全回退 0） */
export async function readSignalsCursor(bookRoot: string): Promise<number> {
    const raw = await readOptionalText(join(bookRoot, SIGNALS_CURSOR_REL_PATH));
    if (raw === null) return 0;
    try {
        const parsed = SignalsCursorSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data.consumedLines : 0;
    } catch {
        return 0;
    }
}

/** 持久化已消费信号行游标到 .ops/signals_cursor.json */
export async function writeSignalsCursor(bookRoot: string, consumedLines: number): Promise<void> {
    const opsDir = join(bookRoot, '.ops');
    await mkdir(opsDir, { recursive: true });
    const payload = SignalsCursorSchema.parse({
        consumedLines: Math.max(0, Math.floor(consumedLines)),
        updatedAt: new Date().toISOString()
    });
    await writeFile(
        join(bookRoot, SIGNALS_CURSOR_REL_PATH),
        `${JSON.stringify(payload, null, 4)}\n`,
        'utf8'
    );
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

/** 追加或替换 L2 卷级章卡中的单章摘要块 */
export function upsertVolumeCardEntry(
    rawCardContent: string | null,
    currentVolume: number,
    chapterNumber: number,
    storyDay: number,
    chapterSummary: string,
    appearanceEntityIds: string[]
): string {
    const baseContent =
        rawCardContent && rawCardContent.trim().length > 0
            ? rawCardContent.replace(/\r\n/g, '\n')
            : `# 第 ${currentVolume} 卷双轨章卡\n\n`;
    const chKey = formatChapterKey(chapterNumber);
    const entryBlock = `## ${chKey} (day:${storyDay})\n- 主干剧情：${chapterSummary.trim()}\n- 出场实体：${[...new Set(appearanceEntityIds)].join(', ')}`;
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

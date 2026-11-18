import React from 'react';

/** 格式化章节号为 4 位补零展示 */
export function formatChapterLabel(chapterNumber: number): string {
    return `Ch.${String(Math.max(0, chapterNumber)).padStart(4, '0')}`;
}

/** 归一化章节标题用于首行去重比对 */
function normalizeHeadingText(text: string): string {
    return text
        .replace(/^#{1,3}\s+/, '')
        .replace(/^第\s*0*\d+\s*章\s*[:：·\-]?\s*/u, '')
        .replace(/^(?:Ch\.?|Chapter)\s*0*\d+\s*[:：·\-]?\s*/i, '')
        .replace(/\s+/g, '')
        .trim();
}

/** 判断正文首行是否为与章节头重复的 Markdown 标题行 */
function isDuplicateChapterHeading(
    firstLine: string,
    chapterNumber: number,
    chapterTitle?: string
): boolean {
    if (!/^#{1,2}\s+/.test(firstLine)) return false;
    const rawHeading = firstLine.replace(/^#{1,2}\s+/, '').trim();
    if (!rawHeading) return false;
    const normalizedHeading = normalizeHeadingText(rawHeading);
    const normalizedTitle = chapterTitle ? normalizeHeadingText(chapterTitle) : '';
    if (normalizedTitle && normalizedHeading === normalizedTitle) {
        return true;
    }
    return (
        rawHeading === `第${chapterNumber}章` ||
        rawHeading === formatChapterLabel(chapterNumber)
    );
}

/** 将章节正文拆分为阅读段落（识别场景分隔符，并自动略去重复的 Markdown 章节标题行） */
export function splitProseParagraphs(
    content: string,
    chapterNumber: number,
    chapterTitle?: string
): Array<{ text: string; isBreak: boolean }> {
    if (!content.trim()) return [];
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length > 0 && isDuplicateChapterHeading(lines[0] ?? '', chapterNumber, chapterTitle)) {
        lines.shift();
    }
    return lines.map((line) => ({
        text: line,
        isBreak: /^([-*_·]\s*){3,}$/.test(line)
    }));
}

/** 细纲节拍比例条单段数据 */
export interface ParsedBeatSegment {
    label: string;
    summary: string;
    percent: number;
    isSpotlight: boolean;
}

/** 结构化细纲解析结果 */
export interface ParsedStructuredPlan {
    chapterTitle: string;
    /** 时间线模式：细纲未留存该字段时为 null（未提供），不从全局状态推断 */
    timelineMode: string | null;
    /** 视角角色：细纲未留存该字段时为 null（未提供），不从焦点角色顺序推断 */
    povCharacter: string | null;
    targetWordCount: number | null;
    endingBeat: string;
    focusCast: string[];
    backgroundCast: string[];
    spotlight: string;
    endingSummary: string;
    outlineText: string;
    beats: ParsedBeatSegment[];
}

function normalizeCastList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item).trim())
            .filter((item) => item.length > 0 && item !== '无' && item !== '本章无');
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed || trimmed === '无' || trimmed === '本章无' || trimmed === 'none') {
            return [];
        }
        return trimmed
            .split(/[,，、/|]+/)
            .map((item) => item.trim())
            .filter((item) => item.length > 0 && item !== '无' && item !== '本章无');
    }
    return [];
}

/** 为角色名生成稳定语义索引（映射到 CSS 类，不硬编码十六进制色值） */
export function getAvatarToneIndex(name: string): number {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return hash % 4;
}

function buildPlanBeats(
    scenes: Array<{ location?: string; summary?: string; is_spotlight?: boolean }> | null,
    spotlightFallback: string,
    outlineFallback: string
): ParsedBeatSegment[] {
    if (scenes && scenes.length > 0) {
        const weights = scenes.map((s) => (s.is_spotlight ? 3 : 1));
        const totalWeight = weights.reduce((acc, w) => acc + w, 0) || scenes.length;
        const percents = weights.map((w) => Math.max(8, Math.round((w / totalWeight) * 100)));
        const diff = 100 - percents.reduce((acc, p) => acc + p, 0);
        if (diff !== 0) {
            const spotlightIdx = Math.max(
                0,
                scenes.findIndex((s) => s.is_spotlight)
            );
            percents[spotlightIdx] = Math.max(8, (percents[spotlightIdx] ?? 0) + diff);
        }

        const hasExplicitSpotlight = scenes.some((s) => Boolean(s.is_spotlight));
        return scenes.map((scene, idx) => {
            const isSpot = hasExplicitSpotlight
                ? Boolean(scene.is_spotlight)
                : idx === Math.floor(scenes.length / 2);
            const loc = scene.location?.trim();
            const label = isSpot ? '戏眼' : loc || `场次 ${idx + 1}`;
            const summary = scene.summary?.trim() || loc || '推进本场戏剧冲突';
            return {
                label,
                summary,
                percent: percents[idx] ?? Math.floor(100 / scenes.length),
                isSpotlight: isSpot
            };
        });
    }

    const firstSentence =
        outlineFallback
            .split(/[。\n]/)
            .map((s) => s.trim())
            .find((s) => s.length > 0) ?? '承接上章状态入场';
    return [
        { label: '开场', summary: firstSentence, percent: 15, isSpotlight: false },
        {
            label: '戏眼',
            summary: spotlightFallback || '核心冲突爆发与视角锚定',
            percent: 55,
            isSpotlight: true
        },
        { label: '回收', summary: '线索收束与关系余波', percent: 20, isSpotlight: false },
        { label: '收尾', summary: '末句定调与下章钩子', percent: 10, isSpotlight: false }
    ];
}

function readNonEmptyString(obj: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) {
        const val = obj[key];
        if (typeof val === 'string') {
            const trimmed = val.trim();
            if (trimmed) return trimmed;
        }
    }
    return null;
}

/** 尝试将章节 outlineText 解析为结构化细纲对象（支持 JSON 与 Markdown/键值回退） */
export function parseStructuredPlan(
    rawText: string | undefined,
    fallbackTitle: string
): ParsedStructuredPlan | null {
    const trimmed = rawText?.trim() ?? '';
    if (!trimmed) {
        return null;
    }

    let jsonCandidate = trimmed;
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        jsonCandidate = fencedMatch[1].trim();
    }
    if (jsonCandidate.startsWith('{') && jsonCandidate.endsWith('}')) {
        try {
            const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
            const focusCast = normalizeCastList(parsed['focus_cast'] ?? parsed['focusCast']);
            const backgroundCast = normalizeCastList(
                parsed['background_cast'] ?? parsed['backgroundCast']
            );
            const povCharacter = readNonEmptyString(parsed, 'pov_character', 'pov');

            const rawScenes = Array.isArray(parsed['scene_plan'])
                ? (parsed['scene_plan'] as Array<{
                      location?: string;
                      summary?: string;
                      is_spotlight?: boolean;
                  }>)
                : null;
            const spotlightScene = rawScenes?.find((s) => s.is_spotlight);
            const spotlight =
                readNonEmptyString(parsed, 'spotlight') ?? spotlightScene?.summary?.trim() ?? '';
            const outlineBody = readNonEmptyString(parsed, 'outline_text') ?? trimmed;
            const endingBeat = readNonEmptyString(parsed, 'ending_beat') ?? 'HOOK';
            const targetWordCount =
                typeof parsed['target_word_count'] === 'number' &&
                Number.isFinite(parsed['target_word_count'])
                    ? parsed['target_word_count']
                    : null;
            const chapterTitle = readNonEmptyString(parsed, 'chapter_title') ?? fallbackTitle;
            const timelineModeVal = readNonEmptyString(parsed, 'timeline_mode');

            return {
                chapterTitle,
                timelineMode: timelineModeVal,
                povCharacter,
                targetWordCount,
                endingBeat,
                focusCast,
                backgroundCast,
                spotlight: spotlight || outlineBody.split(/[。\n]/)[0] || '待细化',
                endingSummary:
                    readNonEmptyString(parsed, 'ending_summary') ??
                    `以 ${endingBeat} 节拍收束本章`,
                outlineText: outlineBody,
                beats: buildPlanBeats(rawScenes, spotlight, outlineBody)
            };
        } catch {
            // JSON 解析失败则回退到 Markdown / 键值文本解析
        }
    }

    let chapterTitle = fallbackTitle;
    let timelineModeVal: string | null = null;
    let povCharacter = '';
    let targetWordCount: number | null = null;
    let endingBeat = 'HOOK';
    let focusCast: string[] = [];
    let backgroundCast: string[] = [];
    let spotlight = '';
    let endingSummary = '';
    const bodyLines: string[] = [];
    const parsedScenes: Array<{ location?: string; summary?: string; is_spotlight?: boolean }> = [];

    for (const rawLine of trimmed.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            bodyLines.push('');
            continue;
        }
        const kvMatch = line.match(/^(?:[-*]\s*)?([A-Za-z0-9_\u4e00-\u9fa5]+)\s*[:：]\s*(.+)$/);
        if (kvMatch) {
            const key = (kvMatch[1] ?? '').toLowerCase();
            const val = (kvMatch[2] ?? '').trim();
            if (key === '标题' || key === 'chapter_title' || key === 'title') {
                chapterTitle = val;
                continue;
            }
            if (key === '目标字数' || key === 'target_word_count' || key === 'target') {
                const num = Number.parseInt(val.replace(/[^\d]/g, ''), 10);
                if (Number.isFinite(num) && num > 0) targetWordCount = num;
                continue;
            }
            if (key === '收尾节拍' || key === 'ending_beat' || key === 'ending') {
                endingBeat = val;
                continue;
            }
            if (key === '收尾说明' || key === 'ending_summary') {
                endingSummary = val;
                continue;
            }
            if (key === '时间线' || key === '时间线模式' || key === 'timeline_mode') {
                timelineModeVal = val;
                continue;
            }
            if (key === '视角' || key === 'pov' || key === 'pov_character') {
                povCharacter = val;
                continue;
            }
            if (key === '焦点角色' || key === 'focus_cast') {
                focusCast = normalizeCastList(val);
                continue;
            }
            if (key === '背景角色' || key === 'background_cast') {
                backgroundCast = normalizeCastList(val);
                continue;
            }
            if (key === '戏眼' || key === 'spotlight') {
                spotlight = val;
                continue;
            }
        }
        const sceneMatch = line.match(/^(?:[-*]|\d+[.)])\s*(?:\[(戏眼|spotlight)\]\s*)?(.+)$/i);
        if (
            sceneMatch &&
            line.length <= 120 &&
            (line.includes('戏眼') || line.includes('场次') || line.includes('@'))
        ) {
            parsedScenes.push({
                summary: sceneMatch[2]?.trim() ?? line,
                is_spotlight: Boolean(sceneMatch[1]) || line.includes('戏眼')
            });
        }
        bodyLines.push(rawLine);
    }

    const outlineBody = bodyLines.join('\n').trim() || trimmed;
    const resolvedPov = povCharacter || null;
    const resolvedSpotlight =
        spotlight ||
        parsedScenes.find((s) => s.is_spotlight)?.summary ||
        outlineBody
            .split(/[。\n]/)
            .map((s) => s.trim())
            .find((s) => s.length > 0) ||
        '见下方细纲正文';

    return {
        chapterTitle,
        timelineMode: timelineModeVal,
        povCharacter: resolvedPov,
        targetWordCount,
        endingBeat,
        focusCast,
        backgroundCast,
        spotlight: resolvedSpotlight,
        endingSummary: endingSummary || `以 ${endingBeat} 节拍收束本章`,
        outlineText: outlineBody,
        beats: buildPlanBeats(
            parsedScenes.length > 0 ? parsedScenes : null,
            resolvedSpotlight,
            outlineBody
        )
    };
}

/** Unified Diff 单行结构 */
export interface ParsedDiffRow {
    kind: 'ctx' | 'add' | 'del';
    lineNumber: number | null;
    glyph: string;
    text: string;
}

/** Unified Diff Hunk 块结构 */
export interface ParsedDiffHunk {
    fileName: string;
    header: string;
    rows: ParsedDiffRow[];
    addCount: number;
    delCount: number;
}

/** 将标准 unified diff 解析为结构化 Hunk 块列表 */
export function parseUnifiedDiff(rawDiff: string, defaultFileName: string): ParsedDiffHunk[] {
    if (!rawDiff.trim()) {
        return [];
    }

    const lines = rawDiff.split(/\r?\n/);
    const hunks: ParsedDiffHunk[] = [];
    let currentFile = defaultFileName;
    let currentHunk: ParsedDiffHunk | null = null;
    let oldLine = 1;
    let newLine = 1;

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            const match = line.match(/b\/(.+)$/);
            if (match?.[1]) {
                currentFile = match[1].split('/').pop() ?? defaultFileName;
            }
            continue;
        }
        if (line.startsWith('--- ') || line.startsWith('+++ ')) {
            if (line.startsWith('+++ b/')) {
                currentFile = line.slice(6).split('/').pop() ?? currentFile;
            }
            continue;
        }
        if (
            line.startsWith('index ') ||
            line.startsWith('new file mode') ||
            line.startsWith('deleted file mode')
        ) {
            continue;
        }

        const hunkHeaderMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
        if (hunkHeaderMatch) {
            if (currentHunk) hunks.push(currentHunk);
            oldLine = Number.parseInt(hunkHeaderMatch[1] ?? '1', 10);
            newLine = Number.parseInt(hunkHeaderMatch[2] ?? '1', 10);
            const suffix = (hunkHeaderMatch[3] ?? '').trim();
            currentHunk = {
                fileName: currentFile,
                header: `@@ -${oldLine} +${newLine} @@${suffix ? ` ${suffix}` : ''}`,
                rows: [],
                addCount: 0,
                delCount: 0
            };
            continue;
        }

        if (!currentHunk) {
            if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                currentHunk = {
                    fileName: currentFile,
                    header: '@@ L1 @@',
                    rows: [],
                    addCount: 0,
                    delCount: 0
                };
            } else {
                continue;
            }
        }

        if (line.startsWith('\\ No newline')) continue;

        if (line.startsWith('+')) {
            currentHunk.rows.push({
                kind: 'add',
                lineNumber: newLine,
                glyph: '+',
                text: line.slice(1)
            });
            currentHunk.addCount += 1;
            newLine += 1;
        } else if (line.startsWith('-')) {
            currentHunk.rows.push({
                kind: 'del',
                lineNumber: oldLine,
                glyph: '-',
                text: line.slice(1)
            });
            currentHunk.delCount += 1;
            oldLine += 1;
        } else {
            currentHunk.rows.push({
                kind: 'ctx',
                lineNumber: newLine,
                glyph: '',
                text: line.startsWith(' ') ? line.slice(1) : line
            });
            oldLine += 1;
            newLine += 1;
        }
    }

    if (currentHunk) hunks.push(currentHunk);

    if (hunks.length === 0) {
        return [
            {
                fileName: defaultFileName,
                header: '@@ L1 @@',
                rows: lines.map((text, idx) => ({
                    kind: 'ctx',
                    lineNumber: idx + 1,
                    glyph: '',
                    text
                })),
                addCount: 0,
                delCount: 0
            }
        ];
    }

    return hunks;
}

/** 实体四区解析单条记录 */
export interface EntityZoneEntry {
    text: string;
    writerHidden: boolean;
    visibilityTag?: string | undefined;
}

/** 实体四区解析区块 */
export interface EntityZoneSection {
    zoneIndex: 1 | 2 | 3 | 4;
    label: string;
    writerRestrictedNote?: string | undefined;
    entries: EntityZoneEntry[];
}

const ZONE_DEFAULT_LABELS: Record<1 | 2 | 3 | 4, string> = {
    1: '第 1 区 · 先天红线与隐藏底牌',
    2: '第 2 区 · 当前状态与后天账本',
    3: '第 3 区 · 不可逆极性变迁',
    4: '第 4 区 · 近期缓冲与专属声纹'
};

function stripFrontmatter(markdown: string): string {
    const trimmed = markdown.trim();
    if (!trimmed.startsWith('---')) return trimmed;
    const endIdx = trimmed.indexOf('\n---', 3);
    if (endIdx < 0) return trimmed;
    return trimmed.slice(endIdx + 4).trim();
}

const ZONE_HEADING_PATTERNS: ReadonlyArray<readonly [RegExp, 1 | 2 | 3 | 4]> = [
    [/^##+\s*(?:Innate|先天|固有)/i, 1],
    [/^##+\s*(?:Acquired|后天|当前)/i, 2],
    [/^##+\s*(?:Irreversible|不可逆|变迁)/i, 3],
    [/^##+\s*(?:Recent|近期|声纹)/i, 4]
];

function resolveVisibilityTag(
    hasOmniscient: boolean,
    hasSelfOnly: boolean,
    hasWarped: boolean
): string | undefined {
    if (hasOmniscient) return '隐藏底牌 · 写手不可见';
    if (hasSelfOnly) return '私有心理 · 非本人写手不可见';
    if (hasWarped) return '已作废 · 写手不可见';
    return undefined;
}

function classifyZoneEntry(rawLine: string): EntityZoneEntry {
    const trimmed = rawLine.replace(/^[-*]\s+/, '').trim();
    const hasOmniscient = /\bOMNISCIENT_SECRET\b/i.test(trimmed);
    const hasSelfOnly = /\bSELF_ONLY\b/i.test(trimmed);
    const hasWarped = /\bWARPED\b/i.test(trimmed);
    const cleaned = trimmed
        .replace(/^\[[^\]]*\]\s*/g, '')
        .replace(/^(?:OMNISCIENT_SECRET_TOKEN|SELF_ONLY_[A-Z0-9_]+)\s*:\s*/i, '')
        .trim();
    return {
        text: cleaned || trimmed,
        writerHidden: hasOmniscient || hasSelfOnly || hasWarped,
        visibilityTag: resolveVisibilityTag(hasOmniscient, hasSelfOnly, hasWarped)
    };
}

function detectZoneHeading(line: string): (1 | 2 | 3 | 4) | null {
    const headingMatch = line.match(/^##+\s*([1-4])\b/i);
    if (headingMatch?.[1]) {
        return Number(headingMatch[1]) as 1 | 2 | 3 | 4;
    }
    for (const [pattern, zone] of ZONE_HEADING_PATTERNS) {
        if (pattern.test(line)) return zone;
    }
    return null;
}

/** 解析实体档案 Markdown 为结构化四区列表（标明第 1 区及隐藏底牌写手不可见） */
export function parseEntityZones(markdown: string): EntityZoneSection[] {
    const body = stripFrontmatter(markdown);
    if (!body) return [];

    const buckets = new Map<1 | 2 | 3 | 4, EntityZoneEntry[]>();
    let currentZone: 1 | 2 | 3 | 4 | null = null;

    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const detectedZone = detectZoneHeading(line);
        if (detectedZone !== null) {
            currentZone = detectedZone;
            if (!buckets.has(currentZone)) {
                buckets.set(currentZone, []);
            }
            continue;
        }
        const targetZone: 1 | 2 | 3 | 4 = currentZone ?? 2;
        const list = buckets.get(targetZone) ?? [];
        list.push(classifyZoneEntry(line));
        buckets.set(targetZone, list);
    }

    const sections: EntityZoneSection[] = [];
    for (const zoneIdx of [1, 2, 3, 4] as const) {
        const entries = buckets.get(zoneIdx);
        if (!entries || entries.length === 0) continue;
        const section: EntityZoneSection = {
            zoneIndex: zoneIdx,
            label: ZONE_DEFAULT_LABELS[zoneIdx],
            entries
        };
        if (zoneIdx === 1) {
            section.writerRestrictedNote = entries.some((item) => item.writerHidden)
                ? '第 1 区含隐藏底牌（写手不可见）'
                : '第 1 区先天红线（插叙永不屏蔽 · 秘密底牌对写手隔离）';
        }
        sections.push(section);
    }
    return sections;
}

/** 未来视野条目（区分 WARPED 已推翻废案 与 PENDING 待推进预案） */
export interface HorizonEntryItem {
    kind: 'WARPED' | 'PENDING';
    text: string;
}

/** 解析 world/future_horizon.md 区分 [WARPED] 与 [PENDING] */
export function parseHorizonEntries(markdown: string | undefined): {
    warped: HorizonEntryItem[];
    pending: HorizonEntryItem[];
} {
    const warped: HorizonEntryItem[] = [];
    const pending: HorizonEntryItem[] = [];
    if (!markdown || !markdown.trim()) {
        return { warped, pending };
    }
    for (const rawLine of markdown.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const body = line
            .replace(/^[-*]\s+/, '')
            .replace(/^\d+\.\s+/, '')
            .trim();
        if (!body) continue;
        const isWarped = /\bWARPED\b/i.test(body);
        const cleanText = body
            .replace(/^\[[^\]]*\]\s*/g, '')
            .replace(/\bWARPED_SECRET_ENTRY\s*:\s*/gi, '')
            .trim();
        if (isWarped) {
            warped.push({ kind: 'WARPED', text: cleanText || body });
        } else {
            pending.push({ kind: 'PENDING', text: cleanText || body });
        }
    }
    return { warped, pending };
}

/** 解析 world/open_threads.md 为展示条目 */
export function parseThreadItems(markdown: string | undefined): Array<{
    resolved: boolean;
    text: string;
}> {
    if (!markdown || !markdown.trim()) return [];
    const out: Array<{ resolved: boolean; text: string }> = [];
    let inResolvedSection = false;
    for (const rawLine of markdown.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            inResolvedSection = /已回收|Resolved/i.test(line);
            continue;
        }
        const cleaned = line
            .replace(/^[-*]\s+/, '')
            .replace(/^\d+\.\s+/, '')
            .replace(/^\[[^\]]*\]\s*/g, '')
            .trim();
        if (!cleaned) continue;
        out.push({
            resolved: inResolvedSection || /\bRESOLVED\b/i.test(line),
            text: cleaned
        });
    }
    return out;
}

/** 检测用户是否偏好减弱动态效果 */
export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 安全特性检测执行原生 View Transitions，不支持或减弱动效时同步降级 */
export function runWithViewTransition(fn: () => void): void {
    if (
        !prefersReducedMotion() &&
        typeof document !== 'undefined' &&
        typeof (document as Document & { startViewTransition?: (cb: () => void) => unknown })
            .startViewTransition === 'function'
    ) {
        (document as Document & { startViewTransition: (cb: () => void) => unknown }).startViewTransition(
            fn
        );
        return;
    }
    fn();
}

/** 统一 1.5px 描边内联矢量图标（严禁用 Emoji 或字符替代） */
export const StudioIcons = {
    chev: (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M4.5 6.2L8 9.8l3.5-3.6" />
        </svg>
    ),
    chevUp: (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M4.5 9.8L8 6.2l3.5 3.6" />
        </svg>
    ),
    play: (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.5 3.2l8.3 4.8-8.3 4.8V3.2z" />
        </svg>
    ),
    pause: (
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="3.5" y="3" width="3.2" height="10" rx="0.8" />
            <rect x="9.3" y="3" width="3.2" height="10" rx="0.8" />
        </svg>
    ),
    more: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="12.5" cy="8" r="1.2" />
        </svg>
    ),
    sync: (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.6" />
            <path d="M13.4 2.6v2.6h-2.6" />
        </svg>
    ),
    edit: (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M10.8 2.8l2.4 2.4-7.6 7.6H3.2v-2.4l7.6-7.6z" />
        </svg>
    ),
    spark: (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M8 2l1.6 4.4L14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6L8 2z" />
        </svg>
    ),
    send: (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M8 12.8V3.5M4.2 7.2L8 3.4l3.8 3.8" />
        </svg>
    ),
    back: (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M10 3.5L5.5 8l4.5 4.5" />
        </svg>
    ),
    leftbar: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M5.5 2.5v11" />
        </svg>
    ),
    rightbar: (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
            <path d="M10.5 2.5v11" />
        </svg>
    ),
    close: (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
    )
};

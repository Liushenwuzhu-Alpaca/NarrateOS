import React, { useMemo } from 'react';

/** 作品列表项（对应 GET /api/narrate/books） */
export interface BookSummaryItem {
    bookRoot: string;
    slug: string;
    title: string;
    currentChapter: number;
    storyDay: number;
    walPhase: string;
}

/** 章节状态枚举 */
export type ChapterWalStatus = 'archived' | 'dirty' | 'conflict';

/** 章节列表项（对应 GET /api/narrate/chapters） */
export interface ChapterNavItem {
    chapterNumber: number;
    fileName: string;
    title: string;
    charCount: number;
    sha256: string;
    dirty: boolean;
    commitSha: string | null;
    /** 可选卷标识，如 第一卷 · 寒潮封港 */
    volumeLabel?: string | undefined;
    /** 是否处于暂停或冲突状态 */
    conflict?: boolean | undefined;
}

/** 全书设定集跨章汇总视图类型 */
export type MaterializedViewKind = 'entities' | 'horizon' | 'threads';

/** 左栏目录组件 Props（向后兼容旧版属性，新增属性一律可选） */
export interface LeftBookNavProps {
    /** 当前激活作品根路径 */
    currentBookRoot: string;
    /** 当前作品标题（优先来自 status） */
    currentTitle: string;
    /** 当前作品 slug */
    currentSlug: string;
    /** 当前作品总章数 */
    chapterCount: number;
    /** 当前故事日 */
    storyDay: number;
    /** 当前状态相位 */
    walPhase: string;
    /** 可切换的作品列表 */
    books: BookSummaryItem[];
    /** 章节列表 */
    chapters: ChapterNavItem[];
    /** 当前选中的章节号 */
    selectedChapter: number | null;
    /** 活跃实体数 */
    entityCount: number;
    /** 冷宫归档实体数 */
    coldArchiveCount: number;
    /** 已推翻旧预案条目数（可选） */
    warpedHorizonCount?: number | undefined;
    /** 待推进后续预案条目数（可选） */
    pendingHorizonCount?: number | undefined;
    /** 未解伏笔数（可选） */
    openThreadsCount?: number | undefined;
    /** 当前激活的设定集视图（可选，用于高亮入口） */
    activeViewKind?: MaterializedViewKind | null | undefined;
    /** 是否正在切换或加载中 */
    loading?: boolean | undefined;
    /** 切换作品回调 */
    onSelectBook: (bookRoot: string) => void;
    /** 点击「开新书」回调 */
    onNewBook: () => void;
    /** 点击章节回调 */
    onSelectChapter: (chapterNumber: number) => void;
    /** 是否以嵌入式无头模式渲染（供旧版右栏过渡使用） */
    embedded?: boolean | undefined;
    /** 点击设定集视图入口回调 */
    onOpenView: (kind: MaterializedViewKind) => void;
    /** 当前卷名称（可选，优先于章节自带卷标识） */
    currentVolumeLabel?: string | undefined;
    /** 抽屉模式下点击条目后关闭抽屉的可选回调 */
    onCloseDrawer?: (() => void) | undefined;
}

function formatLegacyChapterCode(chapterNumber: number): string {
    return `Ch.${String(chapterNumber).padStart(4, '0')}`;
}

function resolveVolumeLabel(
    currentVolumeLabel: string | undefined,
    chapters: readonly ChapterNavItem[]
): string {
    if (currentVolumeLabel && currentVolumeLabel.trim().length > 0) {
        return currentVolumeLabel.trim();
    }
    for (let i = chapters.length - 1; i >= 0; i -= 1) {
        const vol = chapters[i]?.volumeLabel?.trim();
        if (vol) {
            return vol;
        }
    }
    return '第一卷';
}

function resolveChapterBadge(chapter: ChapterNavItem): {
    status: ChapterWalStatus;
    label: string;
    badgeClass: string;
} {
    if (chapter.conflict) {
        return {
            status: 'conflict',
            label: '冲突',
            badgeClass: 'ns-badge ns-badge-danger'
        };
    }
    if (chapter.dirty) {
        return {
            status: 'dirty',
            label: '已改',
            badgeClass: 'ns-badge ns-badge-warn'
        };
    }
    return {
        status: 'archived',
        label: String(chapter.charCount),
        badgeClass: 'ns-num ns-ch-chars'
    };
}

function renderChapterListBody(options: {
    hasActiveBook: boolean;
    chapters: readonly ChapterNavItem[];
    activeViewKind: MaterializedViewKind | null;
    selectedChapter: number | null;
    loading: boolean;
    embedded: boolean;
    onSelectChapter: (chapterNumber: number) => void;
}): React.ReactElement {
    const {
        hasActiveBook,
        chapters,
        activeViewKind,
        selectedChapter,
        loading,
        embedded,
        onSelectChapter
    } = options;
    if (!embedded && loading && chapters.length === 0) {
        return (
            <div className="ns-ch-list" aria-label="章节目录加载中" role="status">
                {Array.from({ length: 6 }, (_, idx) => (
                    <div key={idx} className="ns-skel-row">
                        <span className="ns-skel ns-skel-code" />
                        <span className="ns-skel ns-skel-title" />
                        <span className="ns-skel ns-skel-pill" />
                    </div>
                ))}
            </div>
        );
    }

    if (chapters.length === 0) {
        return (
            <div className="ns-empty-hint">
                {hasActiveBook
                    ? '新书契约已就绪，点击右上角「写下一章」开启首章校准。'
                    : '当前尚未开启作品，点击中央「开启新作品」开始创作。'}
            </div>
        );
    }

    return (
        <div className="ns-ch-list">
            {chapters.map((chapter) => {
                const isSelected =
                    activeViewKind === null && selectedChapter === chapter.chapterNumber;
                const badge = resolveChapterBadge(chapter);
                return (
                    <button
                        key={chapter.fileName}
                        type="button"
                        className={`ns-ch-item ns-ch-btn${isSelected ? ' ns-active' : ''}`}
                        onClick={() => onSelectChapter(chapter.chapterNumber)}
                        aria-current={!embedded && isSelected ? 'page' : undefined}
                        title={`${chapter.fileName} (${chapter.charCount} 字)`}
                    >
                        <span className="ns-ch-title-wrap">
                            {embedded ? (
                                <span className="ns-mono ns-ch-code ns-ch-no ns-num">
                                    {formatLegacyChapterCode(chapter.chapterNumber)}
                                </span>
                            ) : (
                                <span className="ns-ch-no ns-num">第 {chapter.chapterNumber} 章</span>
                            )}
                            <span>{chapter.title}</span>
                        </span>
                        <span className={badge.badgeClass} data-wal-status={badge.status}>
                            {badge.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * 东方清样左栏导航组件：
 * - 顶部：当前卷名 + 故事天数胶囊
 * - 中部：可滚动正文章节目录（章号、标题与字数/已改/冲突胶囊）
 * - 底部：固定「全书设定集（跨章汇总）」三入口（人物与物品档案 / 未解伏笔清单 / 剧情预案与废案）
 */
export function LeftBookNav(props: LeftBookNavProps): React.ReactElement {
    const {
        chapterCount,
        storyDay,
        chapters,
        selectedChapter,
        entityCount,
        coldArchiveCount,
        warpedHorizonCount,
        pendingHorizonCount,
        openThreadsCount,
        activeViewKind = null,
        loading = false,
        embedded = false,
        currentVolumeLabel,
        onSelectChapter,
        onOpenView,
        onCloseDrawer
    } = props;

    const sortedChapters = useMemo(() => {
        const copy = [...chapters];
        copy.sort((a, b) => a.chapterNumber - b.chapterNumber);
        return copy;
    }, [chapters]);

    const displayChapterCount = chapterCount > 0 ? chapterCount : sortedChapters.length;
    const volumeLabel = resolveVolumeLabel(currentVolumeLabel, sortedChapters);
    const horizonTotal = (warpedHorizonCount ?? 0) + (pendingHorizonCount ?? 0);

    function handleChapterClick(chapterNumber: number): void {
        onSelectChapter(chapterNumber);
        onCloseDrawer?.();
    }

    function handleOpenCodex(kind: MaterializedViewKind): void {
        onOpenView(kind);
        onCloseDrawer?.();
    }

    const codexSection = (
        <div className="ns-left-codex" aria-label="全书设定集（跨章汇总）">
            <div className="ns-left-group-label">
                <span>全书设定集（跨章汇总）</span>
            </div>
            <button
                type="button"
                className={`ns-codex-row${activeViewKind === 'entities' ? ' ns-active' : ''}`}
                onClick={() => handleOpenCodex('entities')}
                aria-current={activeViewKind === 'entities' ? 'page' : undefined}
                title={`活跃人物与物品 ${entityCount} 项，冷宫归档 ${coldArchiveCount} 项`}
            >
                <span>人物与物品档案</span>
                <span className="ns-badge ns-badge-neutral ns-num">
                    {entityCount} / 冷宫 {coldArchiveCount}
                </span>
            </button>
            <button
                type="button"
                className={`ns-codex-row${activeViewKind === 'threads' ? ' ns-active' : ''}`}
                onClick={() => handleOpenCodex('threads')}
                aria-current={activeViewKind === 'threads' ? 'page' : undefined}
                title="查看跨章未解伏笔清单"
            >
                <span>未解伏笔清单</span>
                <span className="ns-badge ns-badge-neutral ns-num">
                    {openThreadsCount ?? 0}
                </span>
            </button>
            <button
                type="button"
                className={`ns-codex-row${activeViewKind === 'horizon' ? ' ns-active' : ''}`}
                onClick={() => handleOpenCodex('horizon')}
                aria-current={activeViewKind === 'horizon' ? 'page' : undefined}
                title="查看已推翻隔离旧预案与待推进后续预案"
            >
                <span>剧情预案与废案</span>
                <span className="ns-badge ns-badge-neutral ns-num">
                    {horizonTotal}
                </span>
            </button>
        </div>
    );

    const chapterListBody = renderChapterListBody({
        hasActiveBook: Boolean(props.currentBookRoot),
        chapters: sortedChapters,
        activeViewKind,
        selectedChapter,
        loading,
        embedded,
        onSelectChapter: handleChapterClick
    });

    if (embedded) {
        return (
            <div className="ns-toc-embedded" aria-label="章节目录与全书设定集">
                <section className="ns-nav-group" aria-label="章节目录">
                    <div className="ns-left-group-label">
                        <span>正文目录</span>
                        <span className="ns-num">共 {displayChapterCount} 章</span>
                    </div>
                    {chapterListBody}
                </section>
                {codexSection}
            </div>
        );
    }

    return (
        <aside className="ns-left-pane ns-book-nav" aria-label="章节与设定目录">
            <div className="ns-left-vol-bar">
                <span className="ns-left-vol-title" title={volumeLabel}>
                    {volumeLabel}
                </span>
                <span className="ns-badge ns-badge-neutral ns-num">第 {storyDay} 天</span>
            </div>

            <div className="ns-left-list">
                <div className="ns-left-group-label">
                    <span>正文目录</span>
                    <span className="ns-num">共 {displayChapterCount} 章</span>
                </div>
                {chapterListBody}
            </div>

            {codexSection}
        </aside>
    );
}

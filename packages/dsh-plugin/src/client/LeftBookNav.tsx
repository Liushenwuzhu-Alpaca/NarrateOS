import React, { useMemo, useState } from 'react';

/** 作品列表项（对应 GET /api/narrate/books） */
export interface BookSummaryItem {
    bookRoot: string;
    slug: string;
    title: string;
    currentChapter: number;
    storyDay: number;
    walPhase: string;
}

/** 章节 WAL 状态枚举 */
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
    /** 可选卷标识，如 Vol.02 */
    volumeLabel?: string;
    /** 是否处于 SAFE_HALT / QUARANTINED 冲突状态 */
    conflict?: boolean;
}

/** 只读物化视图类型 */
export type MaterializedViewKind = 'entities' | 'horizon' | 'threads';

/** 左栏目录组件 Props */
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
    /** 当前 WAL 相位 */
    walPhase: string;
    /** 可切换的作品列表 */
    books: BookSummaryItem[];
    /** 章节列表 */
    chapters: ChapterNavItem[];
    /** 当前选中的章节号 */
    selectedChapter: number | null;
    /** 活跃实体数 */
    entityCount: number;
    /** 冷归档实体数 */
    coldArchiveCount: number;
    /** WARPED 未来视野条目数（可选） */
    warpedHorizonCount?: number;
    /** 未完结伏笔数（可选） */
    openThreadsCount?: number;
    /** 当前激活的物化视图（可选，用于高亮入口） */
    activeViewKind?: MaterializedViewKind | null;
    /** 是否正在切换或加载中 */
    loading?: boolean;
    /** 切换作品回调 */
    onSelectBook: (bookRoot: string) => void;
    /** 点击「+ 开新书」回调 */
    onNewBook: () => void;
    /** 点击章节回调 */
    onSelectChapter: (chapterNumber: number) => void;
    /** 点击只读物化视图入口回调 */
    onOpenView: (kind: MaterializedViewKind) => void;
}

function formatChapterCode(chapterNumber: number): string {
    return `Ch.${String(chapterNumber).padStart(4, '0')}`;
}

function resolveChapterStatus(chapter: ChapterNavItem): {
    status: ChapterWalStatus;
    label: string;
    pillClass: string;
} {
    if (chapter.conflict) {
        return {
            status: 'conflict',
            label: '冲突',
            pillClass: 'ns-pill ns-pill-red'
        };
    }
    if (chapter.dirty) {
        return {
            status: 'dirty',
            label: '有手改',
            pillClass: 'ns-pill ns-pill-amber'
        };
    }
    return {
        status: 'archived',
        label: '已归档',
        pillClass: 'ns-pill ns-pill-green'
    };
}

function resolveWalPhasePillClass(walPhase: string): string {
    const upper = walPhase.toUpperCase();
    if (upper === 'SAFE_HALT' || upper === 'QUARANTINED') {
        return 'ns-pill ns-pill-red';
    }
    if (upper === 'DRAFTING' || upper === 'FEAT_COMMITTED') {
        return 'ns-pill ns-pill-brand';
    }
    if (upper === 'IDLE' || upper === 'STATE_COMMITTED') {
        return 'ns-pill ns-pill-green';
    }
    return 'ns-pill ns-pill-muted';
}

/**
 * 左栏作品与章节 WAL 目录组件：
 * - 作品切换器（下拉切换多部作品、展示路径/总章数/story_day/WAL 相位、开新书入口）
 * - 章节 WAL 状态列表（支持正序/倒序切换，展示 Ch.XXXX、标题与已归档/有手改/冲突胶囊）
 * - 只读物化视图快捷入口（entities/、future_horizon、open_threads）
 */
export function LeftBookNav(props: LeftBookNavProps): React.ReactElement {
    const {
        currentBookRoot,
        currentTitle,
        currentSlug,
        chapterCount,
        storyDay,
        walPhase,
        books,
        chapters,
        selectedChapter,
        entityCount,
        coldArchiveCount,
        warpedHorizonCount,
        openThreadsCount,
        activeViewKind = null,
        loading = false,
        onSelectBook,
        onNewBook,
        onSelectChapter,
        onOpenView
    } = props;

    // 默认按章节号倒序排列，便于直接定位最新章
    const [sortDesc, setSortDesc] = useState<boolean>(true);

    const sortedChapters = useMemo(() => {
        const copy = [...chapters];
        copy.sort((a, b) => (sortDesc ? b.chapterNumber - a.chapterNumber : a.chapterNumber - b.chapterNumber));
        return copy;
    }, [chapters, sortDesc]);

    const totalCharCount = useMemo(
        () => chapters.reduce((acc, item) => acc + item.charCount, 0),
        [chapters]
    );

    const displayTitle = currentTitle || currentSlug || '未命名作品';
    const displaySlugPath = currentSlug ? `books/${currentSlug}` : 'books/unknown';
    const displayChapterCount = chapterCount > 0 ? chapterCount : chapters.length;

    return (
        <aside className="ns-book-nav" aria-label="作品与章节真源目录">
            <div className="ns-nav-head">
                <strong className="ns-nav-title">作品与章节真源</strong>
                <button
                    type="button"
                    className="ns-btn-ghost ns-btn-sm"
                    onClick={onNewBook}
                    disabled={loading}
                >
                    + 开新书
                </button>
            </div>

            <div className="ns-nav-scroll">
                {/* 作品切换器卡片 */}
                <section className="ns-book-card" aria-label="当前作品信息">
                    <div className="ns-book-card-top">
                        <div className="ns-book-title" title={displayTitle}>
                            {displayTitle}
                        </div>
                        <span className={resolveWalPhasePillClass(walPhase)}>{walPhase || 'IDLE'}</span>
                    </div>

                    <div className="ns-mono ns-book-path" title={currentBookRoot}>
                        {displaySlugPath}
                    </div>

                    {books.length > 0 && (
                        <div className="ns-book-switcher">
                            <select
                                className="ns-book-select"
                                aria-label="切换作品"
                                value={currentBookRoot}
                                disabled={loading}
                                onChange={(e) => {
                                    if (e.target.value && e.target.value !== currentBookRoot) {
                                        onSelectBook(e.target.value);
                                    }
                                }}
                            >
                                {books.map((book) => (
                                    <option key={book.bookRoot} value={book.bookRoot}>
                                        {book.title || book.slug} ({book.currentChapter} 章)
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className="ns-book-meta">
                        <span className="ns-pill ns-pill-green">
                            {displayChapterCount} 章
                            {totalCharCount > 0 ? ` - ${(totalCharCount / 10000).toFixed(1)}万字` : ''}
                        </span>
                        <span className="ns-pill ns-pill-brand">story_day: {storyDay}</span>
                    </div>
                </section>

                {/* 章节 WAL 状态列表 */}
                <section className="ns-nav-group" aria-label="章节 WAL 状态列表">
                    <div className="ns-group-title">
                        <span>章节目录 ({sortedChapters.length})</span>
                        <button
                            type="button"
                            className="ns-link-btn ns-mono"
                            onClick={() => setSortDesc((prev) => !prev)}
                            title="切换章节排序方向"
                        >
                            {sortDesc ? 'WAL 倒序' : 'WAL 正序'}
                        </button>
                    </div>

                    {sortedChapters.length === 0 ? (
                        <div className="ns-empty-hint">暂无已落盘章节，请先开书或推进第 1 章。</div>
                    ) : (
                        <div className="ns-ch-list">
                            {sortedChapters.map((chapter) => {
                                const isSelected = selectedChapter === chapter.chapterNumber;
                                const badge = resolveChapterStatus(chapter);
                                return (
                                    <button
                                        key={chapter.fileName}
                                        type="button"
                                        className={`ns-ch-btn${isSelected ? ' ns-active' : ''}`}
                                        onClick={() => onSelectChapter(chapter.chapterNumber)}
                                        title={`${chapter.fileName} (${chapter.charCount} 字)`}
                                    >
                                        <span className="ns-ch-label">
                                            <span className="ns-mono ns-ch-code">
                                                {formatChapterCode(chapter.chapterNumber)}
                                            </span>
                                            <span className="ns-ch-title"> - {chapter.title}</span>
                                        </span>
                                        <span className={badge.pillClass} data-wal-status={badge.status}>
                                            {badge.label}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </section>

                {/* 只读物化视图快捷入口 */}
                <section className="ns-nav-group" aria-label="物化视图只读入口">
                    <div className="ns-group-title">
                        <span>物化视图入口</span>
                        <span>只读</span>
                    </div>

                    <div className="ns-view-list">
                        <button
                            type="button"
                            className={`ns-ch-btn${activeViewKind === 'entities' ? ' ns-active' : ''}`}
                            onClick={() => onOpenView('entities')}
                        >
                            <span>
                                entities/ (活跃 {entityCount} / 冷档 {coldArchiveCount})
                            </span>
                            <span className="ns-mono ns-view-badge">MD</span>
                        </button>

                        <button
                            type="button"
                            className={`ns-ch-btn${activeViewKind === 'horizon' ? ' ns-active' : ''}`}
                            onClick={() => onOpenView('horizon')}
                        >
                            <span>
                                future_horizon
                                {typeof warpedHorizonCount === 'number'
                                    ? ` (WARPED:${warpedHorizonCount})`
                                    : ''}
                            </span>
                            <span className="ns-mono ns-view-badge">MD</span>
                        </button>

                        <button
                            type="button"
                            className={`ns-ch-btn${activeViewKind === 'threads' ? ' ns-active' : ''}`}
                            onClick={() => onOpenView('threads')}
                        >
                            <span>open_threads (跨卷伏笔)</span>
                            <span className="ns-mono ns-view-badge">
                                {typeof openThreadsCount === 'number' ? openThreadsCount : 'MD'}
                            </span>
                        </button>
                    </div>
                </section>
            </div>
        </aside>
    );
}

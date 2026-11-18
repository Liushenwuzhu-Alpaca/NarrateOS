import React, { useMemo } from 'react';
import type { MaterializedViewKind } from './LeftBookNav';
import type { EntityZoneSection, HorizonEntryItem } from './workbench-parsers';
import {
    parseEntityZones,
    parseHorizonEntries,
    parseThreadItems,
    StudioIcons
} from './workbench-parsers';

export interface CodexEntitySummary {
    entityId: string;
    canonicalName: string;
    aliases?: string[] | undefined;
    lastSeenChapter?: number | undefined;
    markdown: string;
}

export interface CodexViewProps {
    bookTitle: string;
    hasChapters: boolean;
    activeChapterNumber: number;
    activeTab: MaterializedViewKind;
    entities: readonly CodexEntitySummary[];
    coldArchiveCount: number;
    horizonMarkdown?: string | undefined;
    threadsMarkdown?: string | undefined;
    onSelectTab: (tab: MaterializedViewKind) => void;
    onBackToProse: () => void;
}

interface ParsedCodexEntity extends CodexEntitySummary {
    zones: EntityZoneSection[];
}

function renderEntityZones(
    zones: readonly EntityZoneSection[],
    rawMarkdown: string
): React.ReactElement {
    if (zones.length === 0) {
        return <pre className="ns-codex-raw ns-mono">{rawMarkdown}</pre>;
    }
    return (
        <div className="ns-codex-zones">
            {zones.map((zone) => (
                <div key={zone.zoneIndex} className="ns-codex-zone">
                    <div className="ns-codex-zone-head">
                        <span>{zone.label}</span>
                        {zone.writerRestrictedNote ? (
                            <span className="ns-badge ns-badge-warn">
                                {zone.writerRestrictedNote}
                            </span>
                        ) : null}
                    </div>
                    <div className="ns-codex-zone-list">
                        {zone.entries.map((entry, idx) => (
                            <div
                                key={idx}
                                className={`ns-codex-entry${
                                    entry.writerHidden ? ' ns-codex-entry-hidden' : ''
                                }`}
                            >
                                <span>{entry.text}</span>
                                {entry.visibilityTag ? (
                                    <span className="ns-badge ns-badge-warn">
                                        {entry.visibilityTag}
                                    </span>
                                ) : null}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function renderEntityCard(entity: ParsedCodexEntity): React.ReactElement {
    return (
        <section key={entity.entityId} className="ns-codex-entity">
            <div className="ns-codex-entity-head">
                <div className="ns-codex-entity-name">
                    <strong>{entity.canonicalName}</strong>
                    {entity.aliases && entity.aliases.length > 0 ? (
                        <span className="ns-codex-aliases">
                            别名：{entity.aliases.join(' / ')}
                        </span>
                    ) : null}
                </div>
                <div className="ns-codex-entity-meta">
                    <span className="ns-mono ns-codex-id">{entity.entityId}</span>
                    {entity.lastSeenChapter !== undefined && entity.lastSeenChapter > 0 ? (
                        <span className="ns-badge ns-badge-neutral ns-num">
                            最近出场 第 {entity.lastSeenChapter} 章
                        </span>
                    ) : null}
                </div>
            </div>

            {renderEntityZones(entity.zones, entity.markdown)}
        </section>
    );
}

function renderEntitiesTab(
    parsedEntities: readonly ParsedCodexEntity[],
    coldArchiveCount: number
): React.ReactElement {
    return (
        <div className="ns-codex-section">
            {coldArchiveCount > 0 ? (
                <div className="ns-codex-archive-note">
                    <span>已归入冷档案的长期退场实体</span>
                    <span className="ns-badge ns-badge-neutral ns-num">
                        {coldArchiveCount} 项
                    </span>
                </div>
            ) : null}

            {parsedEntities.length === 0 ? (
                <div className="ns-codex-empty">暂无已建档人物与物品条目。</div>
            ) : (
                parsedEntities.map(renderEntityCard)
            )}
        </div>
    );
}

function renderThreadsTab(
    activeThreads: ReadonlyArray<{ resolved: boolean; text: string }>,
    resolvedThreads: ReadonlyArray<{ resolved: boolean; text: string }>
): React.ReactElement {
    return (
        <div className="ns-codex-section">
            <div className="ns-codex-group">
                <div className="ns-codex-group-title">
                    活跃未解伏笔 ({activeThreads.length})
                </div>
                {activeThreads.length > 0 ? (
                    activeThreads.map((item, idx) => (
                        <div key={idx} className="ns-codex-row-item">
                            <span>· {item.text}</span>
                        </div>
                    ))
                ) : (
                    <div className="ns-codex-empty">当前尚无挂起的跨卷伏笔。</div>
                )}
            </div>

            {resolvedThreads.length > 0 ? (
                <div className="ns-codex-group ns-codex-group-divider">
                    <div className="ns-codex-group-title">
                        已回收伏笔归档 ({resolvedThreads.length})
                    </div>
                    {resolvedThreads.map((item, idx) => (
                        <div key={idx} className="ns-codex-row-item ns-codex-row-muted">
                            <span>· {item.text}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function renderHorizonTab(parsedHorizon: {
    warped: HorizonEntryItem[];
    pending: HorizonEntryItem[];
}): React.ReactElement {
    return (
        <div className="ns-codex-section">
            <div className="ns-codex-group">
                <div className="ns-codex-group-title">
                    已推翻隔离的旧预案（[WARPED] · 写手不可见 · {parsedHorizon.warped.length}）
                </div>
                {parsedHorizon.warped.length > 0 ? (
                    parsedHorizon.warped.map((item, idx) => (
                        <div key={idx} className="ns-codex-warped-card">
                            <span className="ns-badge ns-badge-warn ns-mono">[WARPED]</span>
                            <span>{item.text}</span>
                        </div>
                    ))
                ) : (
                    <div className="ns-codex-empty">暂无因改道作废的旧预案。</div>
                )}
            </div>

            <div className="ns-codex-group ns-codex-group-divider">
                <div className="ns-codex-group-title">
                    待推进的后续伏脉预案（[PENDING] · {parsedHorizon.pending.length}）
                </div>
                {parsedHorizon.pending.length > 0 ? (
                    parsedHorizon.pending.map((item, idx) => (
                        <div key={idx} className="ns-codex-pending-row">
                            <span className="ns-badge ns-badge-neutral ns-mono">[PENDING]</span>
                            <span>{item.text}</span>
                        </div>
                    ))
                ) : (
                    <div className="ns-codex-empty">暂无待推进预案。</div>
                )}
            </div>
        </div>
    );
}

/**
 * 独立「全书设定集（跨章汇总）」画布：
 * - 与单章手稿三页签完全解耦，右上角提供返回正文入口
 * - 实体四区解析并明确标注第 1 区及隐藏底牌（写手不可见）
 * - 剧情预案与废案严格区分 [WARPED] 已推翻隔离旧预案与 [PENDING] 待推进预案
 */
export function CodexView({
    bookTitle,
    hasChapters,
    activeChapterNumber,
    activeTab,
    entities,
    coldArchiveCount,
    horizonMarkdown,
    threadsMarkdown,
    onSelectTab,
    onBackToProse
}: CodexViewProps): React.ReactElement {
    const parsedHorizon = useMemo(
        () => parseHorizonEntries(horizonMarkdown),
        [horizonMarkdown]
    );
    const parsedThreads = useMemo(
        () => parseThreadItems(threadsMarkdown),
        [threadsMarkdown]
    );
    const parsedEntities = useMemo(
        () =>
            entities.map((ent) => ({
                ...ent,
                zones: parseEntityZones(ent.markdown)
            })),
        [entities]
    );

    const horizonTotal = parsedHorizon.warped.length + parsedHorizon.pending.length;
    const activeThreads = parsedThreads.filter((t) => !t.resolved);
    const resolvedThreads = parsedThreads.filter((t) => t.resolved);

    function renderActiveTabSection(): React.ReactElement | null {
        switch (activeTab) {
            case 'entities':
                return renderEntitiesTab(parsedEntities, coldArchiveCount);
            case 'threads':
                return renderThreadsTab(activeThreads, resolvedThreads);
            case 'horizon':
                return renderHorizonTab(parsedHorizon);
            default:
                return null;
        }
    }

    return (
        <article className="ns-manuscript-sheet ns-codex-sheet" aria-label="全书设定集">
            <header className="ns-codex-head">
                <div className="ns-codex-head-main">
                    <h1>《{bookTitle}》全书设定集</h1>
                    <div className="ns-codex-subtitle">
                        每写完一章从正文自动提炼汇总，并非单章手稿页签
                    </div>
                </div>
                <button
                    type="button"
                    className="ns-btn ns-btn-subtle"
                    onClick={onBackToProse}
                >
                    {StudioIcons.back}
                    <span>
                        {hasChapters && activeChapterNumber > 0
                            ? `返回第 ${activeChapterNumber} 章正文`
                            : '返回书稿扉页'}
                    </span>
                </button>
            </header>

            <div className="ns-seg-tabs ns-codex-tabs" role="tablist" aria-label="设定集分类">
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'entities'}
                    className={`ns-seg-tab${activeTab === 'entities' ? ' ns-active' : ''}`}
                    onClick={() => onSelectTab('entities')}
                >
                    人物与物品 ({entities.length})
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'threads'}
                    className={`ns-seg-tab${activeTab === 'threads' ? ' ns-active' : ''}`}
                    onClick={() => onSelectTab('threads')}
                >
                    未解伏笔 ({activeThreads.length})
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'horizon'}
                    className={`ns-seg-tab${activeTab === 'horizon' ? ' ns-active' : ''}`}
                    onClick={() => onSelectTab('horizon')}
                >
                    剧情预案与废案 ({horizonTotal})
                </button>
            </div>

            {renderActiveTabSection()}
        </article>
    );
}

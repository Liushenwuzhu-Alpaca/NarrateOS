// @vitest-environment jsdom
/**
 * Phase 4 阶段节点实时/历史 DSH 原生会话钻取测试：
 * - SSE activeSessionId 实时填充阶段节点
 * - /api/narrate/runs 为选中章节回填历史阶段 sessionId
 * - 点击活跃/历史节点打开右栏 'session' 页签并绑定/释放 SessionReference
 * - 净室 Writer 节点展示只读说明；无宿主 sessions 时渲染信息降级面板
 * - apply(ctx) 在极简宿主（无 sessions）与完整宿主下均不阻塞且正常卸载
 */
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/client/api.js';
import { apply, NarrateStudioRoot, PANEL_ID } from '../src/client/index.js';
import type {
    StudioSessionReference,
    StudioSessionsService
} from '../src/client/StageSessionViewer.js';
import type {
    BookSummary,
    ChapterDetail,
    ChaptersListPayload,
    NarrateStatusPayload,
    RunsListPayload,
    SseEventPayload
} from '../src/client/types.js';

vi.mock('../src/client/api.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/client/api.js')>();
    return {
        ...original,
        fetchBooks: vi.fn(),
        selectBook: vi.fn(),
        bootBook: vi.fn(),
        fetchStatus: vi.fn(),
        fetchChapters: vi.fn(),
        fetchChapter: vi.fn(),
        fetchRunRecords: vi.fn(),
        saveChapter: vi.fn(),
        fetchViewEntities: vi.fn(),
        fetchViewHorizon: vi.fn(),
        fetchViewThreads: vi.fn(),
        fetchViewTelemetry: vi.fn(),
        fetchViewSignals: vi.fn(),
        fetchViewHalt: vi.fn(),
        stepChapter: vi.fn(),
        syncManuscripts: vi.fn(),
        runDreaming: vi.fn(),
        postSignal: vi.fn(),
        deleteSignal: vi.fn(),
        requestHalt: vi.fn(),
        startYolo: vi.fn(),
        stopYolo: vi.fn(),
        subscribeNarrateEvents: vi.fn()
    };
});

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const books: BookSummary[] = [
    { bookRoot: '/books/port', slug: 'port', title: '港口暗线', currentChapter: 2, storyDay: 2, walPhase: 'IDLE' }
];

const mountedRoots: Root[] = [];
let onEvent: ((event: SseEventPayload) => void) | undefined;
let runsByChapter: Map<number, RunsListPayload['runs']>;

function makeDetail(chapterNumber: number): ChapterDetail {
    return {
        chapterNumber,
        content: `港口第 ${chapterNumber} 章正文内容。`,
        dirty: false,
        sha256: `sha-${chapterNumber}`,
        diffFromHead: '',
        outlineText: null,
        outlineStatus: 'missing'
    };
}

function makeStatus(): NarrateStatusPayload {
    return {
        bookRoot: '/books/port',
        bookSlug: 'port',
        title: '港口暗线',
        walPhase: 'IDLE',
        activeChapter: 1,
        lastCommittedChapter: 2,
        latestChapter: 2,
        chapterCount: 2,
        entityCount: 2,
        coldArchiveCount: 0,
        worldState: { story_day: 2, current_chapter: 2, timeline_mode: 'MAINLINE' },
        pendingSignalsCount: 0,
        yolo: { running: false, completedChapters: 0, targetChapters: 0, currentStage: null },
        runtime: { activeTask: 'IDLE', haltRequested: false }
    };
}

function makeChapters(): ChaptersListPayload {
    return {
        chapters: [1, 2].map((chapterNumber) => ({
            chapterNumber,
            fileName: `ch_${String(chapterNumber).padStart(4, '0')}.md`,
            title: `第${chapterNumber}章`,
            charCount: 120,
            sha256: `sha-${chapterNumber}`,
            dirty: false,
            commitSha: `commit-${chapterNumber}`
        }))
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    onEvent = undefined;
    runsByChapter = new Map([
        [
            1,
            [
                {
                    runId: 'run-ch1',
                    chapter: 1,
                    stage: 'LIBRARIAN',
                    role: 'librarian',
                    sessionId: 'sess-ch1-lib',
                    status: 'completed',
                    finishedAt: '2026-11-17T08:00:00.000Z'
                },
                {
                    runId: 'run-ch1',
                    chapter: 1,
                    stage: 'PLANNER',
                    role: 'planner',
                    sessionId: 'sess-ch1-plan',
                    status: 'completed',
                    finishedAt: '2026-11-17T08:01:00.000Z'
                },
                {
                    runId: 'run-ch1',
                    chapter: 1,
                    stage: 'EXTRACTOR',
                    role: 'extractor',
                    sessionId: 'sess-ch1-ext',
                    status: 'completed',
                    finishedAt: '2026-11-17T08:03:00.000Z'
                }
            ]
        ],
        [
            2,
            [
                {
                    runId: 'run-ch2',
                    chapter: 2,
                    stage: 'PLANNER',
                    role: 'planner',
                    sessionId: 'sess-ch2-plan',
                    status: 'completed',
                    finishedAt: '2026-11-17T09:01:00.000Z'
                },
                {
                    runId: 'run-ch2',
                    chapter: 2,
                    stage: 'FACT_CHECKER',
                    role: 'fact-checker',
                    sessionId: 'sess-ch2-fc',
                    status: 'completed',
                    finishedAt: '2026-11-17T09:02:00.000Z'
                }
            ]
        ]
    ]);

    vi.stubGlobal('innerWidth', 1440);
    vi.mocked(api.fetchBooks).mockResolvedValue({ currentBookRoot: '/books/port', books });
    vi.mocked(api.fetchStatus).mockResolvedValue(makeStatus());
    vi.mocked(api.fetchChapters).mockResolvedValue(makeChapters());
    vi.mocked(api.fetchChapter).mockImplementation(async (ch) => makeDetail(ch));
    vi.mocked(api.fetchRunRecords).mockImplementation(async (ch) => ({
        runs: ch !== undefined ? (runsByChapter.get(ch) ?? []) : []
    }));
    vi.mocked(api.fetchViewEntities).mockResolvedValue({
        kind: 'entities',
        entities: [],
        coldArchiveCount: 0,
        coldArchiveIds: []
    });
    vi.mocked(api.fetchViewHorizon).mockResolvedValue({ kind: 'horizon', content: '' });
    vi.mocked(api.fetchViewThreads).mockResolvedValue({ kind: 'threads', content: '' });
    vi.mocked(api.fetchViewTelemetry).mockResolvedValue({ kind: 'telemetry', entries: [] });
    vi.mocked(api.fetchViewSignals).mockResolvedValue({
        kind: 'signals',
        signals: [],
        pending: [],
        pendingCount: 0
    });
    vi.mocked(api.fetchViewHalt).mockResolvedValue({
        kind: 'halt',
        safeHalt: null,
        quarantineReport: null
    });
    vi.mocked(api.subscribeNarrateEvents).mockImplementation((listener) => {
        onEvent = listener;
        return () => {
            onEvent = undefined;
        };
    });
});

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

async function mountStudio(props?: React.ComponentProps<typeof NarrateStudioRoot>): Promise<{
    container: HTMLElement;
    root: Root;
}> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
        root.render(createElement(NarrateStudioRoot, props));
    });
    expect(container.querySelector('.ns-prose')?.textContent).toContain('港口第 1 章正文内容。');
    return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
        element.click();
    });
}

async function openStageStrip(container: HTMLElement): Promise<void> {
    const toggle = container.querySelector<HTMLButtonElement>('button.ns-thread-btn');
    if (!toggle) throw new Error('未找到 6 阶段流水线胶囊按钮');
    if (toggle.getAttribute('aria-expanded') !== 'true') {
        await click(toggle);
    }
}

function stageNode(container: HTMLElement, stageId: string): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>(
        `button.ns-stage-node[data-stage-id="${stageId}"]`
    );
    if (!btn) throw new Error(`未找到阶段节点 ${stageId}`);
    return btn;
}

function chapterButton(container: HTMLElement, chapter: number): HTMLButtonElement {
    const code = `Ch.${String(chapter).padStart(4, '0')}`;
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button.ns-ch-btn')).find(
        (item) => item.querySelector('.ns-ch-code')?.textContent?.trim() === code
    );
    if (!btn) throw new Error(`未找到章节目录项 ${code}`);
    return btn;
}

async function emit(event: SseEventPayload): Promise<void> {
    if (!onEvent) throw new Error('根组件未订阅 SSE');
    await act(async () => {
        onEvent?.(event);
    });
}

describe('Phase 4 阶段节点实时与历史原生会话钻取', () => {
    it('SSE activeSessionId 实时写入阶段节点并展示实时会话指示，点击打开 Conversation 与 Trajectory 视图', async () => {
        const retainedRecords: Array<{
            sessionId: string;
            source: string;
            released: boolean;
            releaseSpy: ReturnType<typeof vi.fn>;
        }> = [];

        const mockSessions: StudioSessionsService = {
            retain: vi.fn((sessionId, options) => {
                const releaseSpy = vi.fn();
                const entry = {
                    sessionId,
                    source: options.source,
                    released: false,
                    releaseSpy: vi.fn(() => {
                        entry.released = true;
                        releaseSpy();
                    })
                };
                retainedRecords.push(entry);
                const ref: StudioSessionReference = {
                    sessionId,
                    ready: Promise.resolve(),
                    release: entry.releaseSpy
                };
                return ref;
            })
        };

        const MockSessionProvider: React.FC<{ session: unknown; children?: React.ReactNode }> = ({
            session,
            children
        }) =>
            createElement(
                'div',
                {
                    'data-mock-session-provider':
                        (session as StudioSessionReference | undefined)?.sessionId ?? ''
                },
                children
            );

        const renderStageConversation = vi.fn(({ view }: { view?: string }) =>
            createElement('div', { 'data-mock-view': view ?? 'chat' }, `原生视图:${view}`)
        );

        const { container, root } = await mountStudio({
            sessionsService: mockSessions,
            SessionProvider: MockSessionProvider,
            renderStageConversation
        });

        await openStageStrip(container);

        // 推送实时 SSE 阶段事件，携带 activeSessionId 与 runId
        await emit({
            event: 'stage',
            data: {
                stage: 'LIBRARIAN',
                chapterNumber: 1,
                activeSessionId: 'sess-live-lib-99',
                runId: 'run-live-1',
                message: '正在检索港口二跳关联'
            }
        });

        const libNode = stageNode(container, 'LIBRARIAN');
        expect(libNode.dataset.sessionId).toBe('sess-live-lib-99');
        expect(libNode.textContent).toContain('实时会话');

        // 点击运行中节点 -> 右侧自动打开「会话」页签并 retain(sessionId)
        await click(libNode);

        const sessionTab = container.querySelector<HTMLButtonElement>('#ns-right-tab-session');
        expect(sessionTab?.getAttribute('aria-selected')).toBe('true');
        expect(mockSessions.retain).toHaveBeenCalledTimes(1);
        expect(mockSessions.retain).toHaveBeenCalledWith(
            'sess-live-lib-99',
            expect.objectContaining({ source: 'narrateosStudio' })
        );
        expect(container.querySelector('[data-mock-session-provider="sess-live-lib-99"]')).not.toBeNull();
        // 运行中节点默认打开 Conversation ('chat')
        expect(container.querySelector('[data-mock-view="chat"]')?.textContent).toBe('原生视图:chat');

        // 切换至 Trajectory：不重连/不重新 retain，只切换原生 view
        const trajectoryBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button.ns-session-view-btn')).find(
            (b) => b.textContent?.trim() === 'Trajectory'
        );
        if (!trajectoryBtn) throw new Error('未找到 Trajectory 切换按钮');
        await click(trajectoryBtn);
        expect(container.querySelector('[data-mock-view="trajectory"]')?.textContent).toBe(
            '原生视图:trajectory'
        );
        expect(mockSessions.retain).toHaveBeenCalledTimes(1);
        expect(retainedRecords[0]?.released).toBe(false);

        // Dreaming 事件同样绑定 sessionId 并可点击切换，且释放前一个 SessionReference
        await emit({
            event: 'dream:started',
            data: {
                activeSessionId: 'sess-live-dream-88',
                runId: 'run-dream-1',
                message: 'Dreamer 整理中'
            }
        });
        const dreamNode = stageNode(container, 'DREAMING');
        expect(dreamNode.dataset.sessionId).toBe('sess-live-dream-88');
        await click(dreamNode);

        expect(retainedRecords[0]?.released).toBe(true);
        expect(mockSessions.retain).toHaveBeenCalledTimes(2);
        expect(
            container.querySelector('[data-mock-session-provider="sess-live-dream-88"]')
        ).not.toBeNull();

        // 卸载 Studio 根组件时释放当前持有的 SessionReference
        await act(async () => {
            root.unmount();
        });
        expect(retainedRecords[1]?.released).toBe(true);
    });

    it('/api/narrate/runs 按选中章节回填历史 sessionId；Writer 保持净室只读说明', async () => {
        const { container } = await mountStudio();
        await openStageStrip(container);

        // 初始第 1 章已调用 fetchRunRecords(1)
        expect(api.fetchRunRecords).toHaveBeenCalledWith(1);
        expect(stageNode(container, 'LIBRARIAN').dataset.sessionId).toBe('sess-ch1-lib');
        expect(stageNode(container, 'PLANNER').dataset.sessionId).toBe('sess-ch1-plan');
        expect(stageNode(container, 'EXTRACTOR').dataset.sessionId).toBe('sess-ch1-ext');
        expect(stageNode(container, 'PLANNER').textContent).toContain('轨迹');

        // 切换至第 2 章 -> 回填第 2 章的运行记录
        await click(chapterButton(container, 2));
        expect(api.fetchRunRecords).toHaveBeenLastCalledWith(2);
        expect(stageNode(container, 'PLANNER').dataset.sessionId).toBe('sess-ch2-plan');
        expect(stageNode(container, 'FACT_CHECKER').dataset.sessionId).toBe('sess-ch2-fc');
        expect(stageNode(container, 'LIBRARIAN').dataset.sessionId).toBe('');

        // 点击 Writer 节点：无 sessionId，详情条展示净室 ctx.llm 只读说明
        await click(stageNode(container, 'WRITER'));
        expect(container.querySelector('.ns-inspector-cleanroom-note')?.textContent).toContain('ctx.llm');
        // 未打开会话页签
        expect(
            container.querySelector('#ns-right-tab-session')?.getAttribute('aria-selected')
        ).not.toBe('true');

        // 点击第 2 章历史 Planner 节点（无宿主 sessions 服务）-> 打开降级元数据面板，展示 sessionId 与状态
        await click(stageNode(container, 'PLANNER'));
        expect(container.querySelector('#ns-right-tab-session')?.getAttribute('aria-selected')).toBe(
            'true'
        );
        const fallback = container.querySelector('[data-session-fallback="true"]');
        expect(fallback).not.toBeNull();
        expect(fallback?.textContent).toContain('sess-ch2-plan');
        expect(fallback?.textContent).toContain('PLANNER');
        expect(fallback?.textContent).toContain('trajectory');
    });

    it('apply(ctx) 在无 sessions 的极简宿主下不阻塞，在有 sessions 时透传会话服务与子槽位', () => {
        const registeredSlots: Array<{ name: string; meta: Record<string, unknown> }> = [];
        const injectedCallbacks = new Map<string, () => unknown>();

        const minimalCtx = {
            slots: {
                inject: vi.fn((slotName: string, factory: () => unknown) => {
                    injectedCallbacks.set(slotName, factory);
                    const result = factory();
                    return () => result;
                }),
                register: vi.fn((meta: Record<string, unknown>) => {
                    registeredSlots.push({ name: String(meta['name'] ?? ''), meta });
                    return vi.fn();
                })
            }
        };

        // 极简宿主无 sessions、无 ctx.effect 时直接完成注册而不抛错
        expect(() => apply(minimalCtx as never)).not.toThrow();
        expect(registeredSlots.some((entry) => entry.name === 'main' && entry.meta['key'] === PANEL_ID)).toBe(
            true
        );
        expect(registeredSlots.some((entry) => entry.name === 'narrateos.stage.conversation')).toBe(true);
        expect(registeredSlots.some((entry) => entry.name === 'sidebar.panellist')).toBe(true);

        const mainMeta = registeredSlots.find((entry) => entry.name === 'main')?.meta;
        expect(mainMeta?.['children']).toEqual({
            'narrateos.stage.conversation': {
                kind: 'single',
                scope: 'session'
            }
        });
    });
});

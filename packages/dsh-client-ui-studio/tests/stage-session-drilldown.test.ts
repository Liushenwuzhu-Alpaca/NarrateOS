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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/client/api.js';
import {
    apply,
    NarrateStudioRoot,
    PANEL_ID,
    STAGE_CONVERSATION_SLOT,
    StageConversationSlotPanel
} from '../src/client/index.js';
import {
    StageSessionViewer,
    type StudioSessionReference,
    type StudioSessionsService
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
        fetchRunDetail: vi.fn(),
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

const globalState = globalThis as Record<string, unknown>;
let hadReactActEnv = false;
let prevReactActEnv: unknown;

beforeAll(() => {
    hadReactActEnv = Object.hasOwn(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    prevReactActEnv = globalState['IS_REACT_ACT_ENVIRONMENT'];
    globalState['IS_REACT_ACT_ENVIRONMENT'] = true;
});

afterAll(() => {
    if (hadReactActEnv) {
        globalState['IS_REACT_ACT_ENVIRONMENT'] = prevReactActEnv;
    } else {
        delete globalState['IS_REACT_ACT_ENVIRONMENT'];
    }
});

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
    vi.mocked(api.fetchRunDetail).mockRejectedValue(new api.NarrateApiError('Not Found', 404));
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

    it('/api/narrate/runs 按选中章节回填历史 sessionId；支持无会话历史兼容提示与 Writer 原生会话复用', async () => {
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

        // 切换至第 2 章（历史记录不含 Writer sessionId）-> 点击 Writer 节点展示未绑定会话提示
        await click(stageNode(container, 'WRITER'));
        expect(container.querySelector('.ns-inspector-cleanroom-note')?.textContent).toContain(
            '未绑定原生会话'
        );
        // 未打开会话页签
        expect(
            container.querySelector('#ns-right-tab-session')?.getAttribute('aria-selected')
        ).not.toBe('true');

        // 实时/带 sessionId 的 Writer 节点可直接复用原生 StageSessionViewer 查看
        await emit({
            event: 'stage',
            data: {
                stage: 'WRITER',
                chapterNumber: 3,
                activeSessionId: 'sess-live-writer-3',
                runId: 'run-writer-3',
                message: '净室单轮 Agent 执笔'
            }
        });
        const writerNode = stageNode(container, 'WRITER');
        expect(writerNode.dataset.sessionId).toBe('sess-live-writer-3');
        await click(writerNode);
        expect(
            container.querySelector('#ns-right-tab-session')?.getAttribute('aria-selected')
        ).toBe('true');
        expect(
            container.querySelector('[data-session-fallback="true"]')?.textContent
        ).toContain('sess-live-writer-3');

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

    it('apply(ctx) 在无 uiSession/uiConversation 的极简宿主下不声明 session 子槽位，仅在双方均就绪时动态升级', () => {
        const registeredSlots: Array<{ name: string; meta: Record<string, unknown>; dispose: ReturnType<typeof vi.fn> }> = [];

        const minimalCtx = {
            slots: {
                inject: vi.fn((_slotName: string, factory: () => unknown) => {
                    const dispose = factory() as (() => void) | undefined;
                    return () => {
                        if (typeof dispose === 'function') dispose();
                    };
                }),
                register: vi.fn((meta: Record<string, unknown>) => {
                    const dispose = vi.fn();
                    registeredSlots.push({ name: String(meta['name'] ?? ''), meta, dispose });
                    return dispose;
                })
            }
        };

        // 1. 极简宿主无 uiSession/uiConversation/sessions -> 不声明 scope: 'session' 子槽位，不触发 SlotAssemblyError
        expect(() => apply(minimalCtx as never)).not.toThrow();
        const mainMinimal = registeredSlots.find((entry) => entry.name === 'main' && entry.meta['key'] === PANEL_ID);
        expect(mainMinimal).toBeDefined();
        expect(mainMinimal?.meta['children']).toBeUndefined();
        expect(registeredSlots.some((entry) => entry.name === STAGE_CONVERSATION_SLOT)).toBe(false);
        expect(registeredSlots.some((entry) => entry.name === 'sidebar.panellist')).toBe(true);

        // 2. 仅有 uiSession 而缺少 uiConversation 时同样不得注册 scope: 'session' 子槽位
        const partialInjectListeners = new Map<string, (scope: unknown) => void | (() => void)>();
        const partialRegistered: Array<{ name: string; meta: Record<string, unknown> }> = [];
        const partialCtx = {
            uiSession: {},
            get: vi.fn((key: string) => (key === 'uiSession' ? {} : undefined)),
            inject: vi.fn((deps: string[], cb: (scope: unknown) => void | (() => void)) => {
                partialInjectListeners.set(deps.join(','), cb);
                return () => {};
            }),
            slots: {
                inject: vi.fn((_slotName: string, factory: () => unknown) => {
                    const dispose = factory() as (() => void) | undefined;
                    return () => {
                        if (typeof dispose === 'function') dispose();
                    };
                }),
                register: vi.fn((meta: Record<string, unknown>) => {
                    partialRegistered.push({ name: String(meta['name'] ?? ''), meta });
                    return vi.fn();
                })
            }
        };
        apply(partialCtx as never);
        expect(partialRegistered.find((e) => e.name === 'main')?.meta['children']).toBeUndefined();
        expect(partialRegistered.some((e) => e.name === STAGE_CONVERSATION_SLOT)).toBe(false);

        // 3. 当 uiSession 与 uiConversation 同时就绪后，动态重注册 main 并挂载 narrateos.stage.conversation
        const activeEntries = new Map<string, Record<string, unknown>>();
        const fullCtx = {
            uiSession: {},
            uiConversation: {},
            sessions: { retain: vi.fn() },
            get: vi.fn((key: string) => {
                if (key === 'uiSession' || key === 'uiConversation') return {};
                if (key === 'sessions') return fullCtx.sessions;
                return undefined;
            }),
            inject: vi.fn((deps: string[], cb: (scope: unknown) => void | (() => void)) => {
                if (deps.every((dep) => fullCtx.get(dep) !== undefined)) {
                    cb(fullCtx);
                }
                return () => {};
            }),
            slots: {
                inject: vi.fn((slotName: string, factory: () => unknown) => {
                    const dispose = factory() as (() => void) | undefined;
                    return () => {
                        if (typeof dispose === 'function') dispose();
                        activeEntries.delete(slotName);
                    };
                }),
                register: vi.fn((meta: Record<string, unknown>) => {
                    const slotName = String(meta['name'] ?? '');
                    activeEntries.set(slotName, meta);
                    return () => {
                        activeEntries.delete(slotName);
                    };
                })
            }
        };
        apply(fullCtx as never);
        expect(activeEntries.get('main')?.['children']).toEqual({
            [STAGE_CONVERSATION_SLOT]: {
                kind: 'single',
                scope: 'session'
            }
        });
        expect(activeEntries.has(STAGE_CONVERSATION_SLOT)).toBe(true);
    });

    it('StageConversationSlotPanel 在缺少 useConversation 或未加载 Factory 时安全降级而不抛出 TypeError', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        await act(async () => {
            root.render(
                createElement(StageConversationSlotPanel, {
                    sessionId: 'sess-missing-hooks',
                    view: 'chat'
                })
            );
        });
        expect(container.querySelector('[data-stage-conversation-fallback="true"]')?.textContent).toContain(
            'sess-missing-hooks'
        );

        const renderFactorySlot = vi.fn((_name, _props, overrides) => overrides.fallback ?? null);
        await act(async () => {
            root.render(
                createElement(StageConversationSlotPanel, {
                    sessionId: 'sess-missing-factory',
                    view: 'trajectory',
                    useSession: ((sel: (s: Record<string, unknown>) => unknown) =>
                        sel({ blank: false, awaitingFirstTurn: false })) as never,
                    useConversation: ((sel: (s: Record<string, unknown>) => unknown) =>
                        sel({ activeTargets: { size: 1 } })) as never,
                    useSessions: ((sel: (s: { byId?: Record<string, { blank?: boolean }> }) => unknown) =>
                        sel({ byId: {} })) as never,
                    renderFactorySlot: renderFactorySlot as never
                })
            );
        });
        expect(renderFactorySlot).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[data-stage-conversation-fallback="true"]')?.textContent).toContain(
            'sess-missing-factory'
        );
    });

    it('StageSessionViewer 切换 sessionId 时立即屏蔽旧 sessionRef 并按 sessionId 重新 keyed 挂载，且支持 parentSessionId/mode', async () => {
        const mountedSessions: Array<{ keySeen: string; providerRenderSessionId: string }> = [];
        const retainCalls: Array<unknown> = [];

        const mockSessions: StudioSessionsService = {
            retain: vi.fn((target) => {
                retainCalls.push(target);
                const sid = typeof target === 'string' ? target : target.childSessionId;
                return {
                    sessionId: sid,
                    ready: Promise.resolve(),
                    release: vi.fn()
                };
            })
        };

        const StrictSessionProvider: React.FC<{ session: unknown; children?: React.ReactNode }> = ({
            session,
            children
        }) => {
            const refId = (session as StudioSessionReference).sessionId;
            return createElement('div', { 'data-strict-provider': refId }, children);
        };

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        const renderStageConversation = ({ view }: { view?: string }) => {
            const providerSession =
                container.querySelector('[data-strict-provider]')?.getAttribute('data-strict-provider') ??
                '';
            mountedSessions.push({ keySeen: view ?? 'chat', providerRenderSessionId: providerSession });
            return createElement('div', { 'data-child-view': view ?? 'chat' });
        };

        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'LIBRARIAN',
                        stageLabel: 'Librarian',
                        sessionId: 'sess-A',
                        status: 'active'
                    },
                    sessionsService: mockSessions,
                    SessionProvider: StrictSessionProvider,
                    renderStageConversation
                })
            );
        });
        expect(container.querySelector('[data-strict-provider="sess-A"]')).not.toBeNull();
        expect(retainCalls[0]).toBe('sess-A');

        // 切换至携带 parentSessionId 的 sess-B：不得把旧 sess-A 引用传给新 sessionId 子树
        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'PLANNER',
                        stageLabel: 'Planner',
                        sessionId: 'sess-B',
                        parentSessionId: 'sess-parent-1',
                        status: 'done'
                    },
                    sessionsService: mockSessions,
                    SessionProvider: StrictSessionProvider,
                    renderStageConversation
                })
            );
        });

        expect(retainCalls[1]).toEqual({
            parentSessionId: 'sess-parent-1',
            childSessionId: 'sess-B',
            mode: 'one-shot'
        });
        expect(container.querySelector('[data-strict-provider="sess-A"]')).toBeNull();
        expect(container.querySelector('[data-strict-provider="sess-B"]')).not.toBeNull();
    });

    it('sessionsService 缺失或 retain() 失败时自动回源 GET /api/narrate/runs/detail 并容忍 404', async () => {
        vi.mocked(api.fetchRunDetail).mockResolvedValueOnce({
            sessionId: 'sess-detail-1',
            runId: 'run-detail-1',
            turns: [
                {
                    turnIndex: 0,
                    role: 'assistant',
                    thinking: '先核对港口三号仓实体关系',
                    toolCalls: [
                        {
                            name: 'book_read',
                            arguments: { path: 'entities/char_001.md' },
                            result: 'ok'
                        }
                    ],
                    content: '已完成上下文召回打包'
                }
            ]
        });

        const failingSessions: StudioSessionsService = {
            retain: vi.fn(() => {
                throw new Error('Session reference is not active in this Controller');
            })
        };

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'LIBRARIAN',
                        stageLabel: 'Librarian',
                        sessionId: 'sess-detail-1',
                        runId: 'run-detail-1',
                        status: 'done'
                    },
                    sessionsService: failingSessions,
                    SessionProvider: ({ children }) => createElement('div', null, children),
                    renderStageConversation: () => createElement('div')
                })
            );
        });

        expect(api.fetchRunDetail).toHaveBeenCalledWith('sess-detail-1');
        const detailEl = container.querySelector('[data-session-detail="true"]');
        expect(detailEl).not.toBeNull();
        expect(detailEl?.textContent).toContain('先核对港口三号仓实体关系');
        expect(detailEl?.textContent).toContain('book_read');
        expect(detailEl?.textContent).toContain('已完成上下文召回打包');
        expect(container.textContent).toContain('sess-detail-1');
        expect(container.textContent).toContain('run-detail-1');
    });

    it('sessions.retain 异步 reject 时回源 GET /api/narrate/runs/detail 并解析 events (thinking + tool-call/result)', async () => {
        vi.mocked(api.fetchRunDetail).mockResolvedValueOnce({
            sessionId: 'sess-events-1',
            runId: 'run-events-1',
            stage: 'LIBRARIAN',
            status: 'completed',
            events: [
                {
                    seq: 0,
                    kind: 'thinking',
                    text: '正在检索第 1 章出场人物与三号栈桥伏笔'
                },
                {
                    seq: 1,
                    kind: 'tool-call',
                    toolName: 'book_read',
                    callId: 'c1',
                    text: '{"path":"entities/char_chen.md"}'
                },
                {
                    seq: 2,
                    kind: 'tool-result',
                    toolName: 'book_read',
                    callId: 'c1',
                    text: '# 陈砚\n持有夜查手令',
                    status: 'completed'
                },
                {
                    seq: 3,
                    kind: 'tool-call',
                    toolName: 'yield_context_pack',
                    callId: 'c2',
                    text: '{"selected_entity_ids":["char_chen"]}'
                },
                {
                    seq: 4,
                    kind: 'tool-result',
                    toolName: 'yield_context_pack',
                    callId: 'c2',
                    text: 'ContextPack 已提交',
                    status: 'completed'
                }
            ]
        });

        const rejectingSessions: StudioSessionsService = {
            retain: vi.fn((target) => ({
                sessionId: typeof target === 'string' ? target : target.childSessionId,
                ready: Promise.reject(new Error('sessions.retain: unknown session sess-events-1')),
                release: vi.fn()
            }))
        };

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'LIBRARIAN',
                        stageLabel: '1. Librarian',
                        sessionId: 'sess-events-1',
                        runId: 'run-events-1',
                        status: 'done'
                    },
                    sessionsService: rejectingSessions,
                    SessionProvider: ({ children }) => createElement('div', null, children),
                    renderStageConversation: () => createElement('div')
                })
            );
        });

        await act(async () => {
            await Promise.resolve();
        });

        const detailEl = container.querySelector('[data-session-detail="true"]');
        expect(detailEl).not.toBeNull();
        expect(container.textContent).not.toContain('会话加载失败');
        expect(detailEl?.textContent).toContain('正在检索第 1 章出场人物与三号栈桥伏笔');
        expect(detailEl?.textContent).toContain('book_read');
        expect(detailEl?.textContent).toContain('yield_context_pack');
        expect(detailEl?.textContent).toContain('ContextPack 已提交');
    });
});

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
import { resolveStageId } from '../src/client/CenterWorkbench.js';
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
        fetchViewSyncConflicts: vi.fn(),
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
        bookRoot: '/books/port',
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
    vi.mocked(api.fetchViewSyncConflicts).mockResolvedValue({
        kind: 'sync_conflicts',
        bookSlug: 'demo', reportRevision: null,
        syncConflicts: null,
        conflicts: [],
        dirtyChapters: [],
        stateDiffAdvisories: [],
        updatedAt: null
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
    const toggle = container.querySelector<HTMLButtonElement>('button.ns-pipeline-toggle-btn');
    if (!toggle) throw new Error('未找到 6 阶段流水线胶囊按钮');
    if (toggle.getAttribute('aria-expanded') !== 'true') {
        await click(toggle);
    }
}

function stageNode(container: HTMLElement, stageId: string): HTMLButtonElement {
    const btn = container.querySelector<HTMLButtonElement>(
        `button.ns-pipe-card[data-stage-id="${stageId}"]`
    );
    if (!btn) throw new Error(`未找到阶段节点 ${stageId}`);
    return btn;
}

function chapterButton(container: HTMLElement, chapter: number): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button.ns-ch-btn')).find(
        (item) => item.querySelector('.ns-ch-no')?.textContent?.trim() === `第 ${chapter} 章`
    );
    if (!btn) throw new Error(`未找到章节目录项 第 ${chapter} 章`);
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
        expect(libNode.classList.contains('ns-running-live')).toBe(true);

        // 点击运行中节点 -> 右侧自动打开「思考过程」页签并 retain(sessionId)
        await click(libNode);

        const sessionTab = container.querySelector<HTMLButtonElement>('#ns-right-tab-trace');
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

        // 切换至第 2 章 -> 回填第 2 章的运行记录
        await click(chapterButton(container, 2));
        expect(api.fetchRunRecords).toHaveBeenLastCalledWith(2);
        expect(stageNode(container, 'PLANNER').dataset.sessionId).toBe('sess-ch2-plan');
        expect(stageNode(container, 'FACT_CHECKER').dataset.sessionId).toBe('sess-ch2-fc');
        expect(stageNode(container, 'LIBRARIAN').dataset.sessionId).toBe('');

        // 切换至第 2 章（历史记录不含 Writer sessionId）-> 点击 Writer 节点展示净室隔离说明
        await click(stageNode(container, 'WRITER'));
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('ctx.agents.create');

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
            container.querySelector('#ns-right-tab-trace')?.getAttribute('aria-selected')
        ).toBe('true');
        expect(
            container.querySelector('[data-session-fallback="true"]')?.textContent
        ).toContain('sess-live-writer-3');

        // 点击第 2 章历史 Planner 节点（无宿主 sessions 服务）-> 打开降级元数据面板，展示 sessionId 与状态
        await click(stageNode(container, 'PLANNER'));
        expect(container.querySelector('#ns-right-tab-trace')?.getAttribute('aria-selected')).toBe(
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

        // 3. 当 uiSession 与 uiConversation 同时就绪后，动态重注册 main 并挂载 narrateos.stage.conversation，且卸载释放 sessions 动态注入句柄
        const activeEntries = new Map<string, Record<string, unknown>>();
        const sessionsInjectDispose = vi.fn();
        const sessionUiInjectDispose = vi.fn();
        let capturedEffectCleanup: (() => void) | undefined;
        const fullCtx = {
            uiSession: {},
            uiConversation: {},
            sessions: { retain: vi.fn() },
            get: vi.fn((key: string) => {
                if (key === 'uiSession' || key === 'uiConversation') return {};
                if (key === 'sessions') return fullCtx.sessions;
                return undefined;
            }),
            effect: vi.fn((cb: () => void | (() => void)) => {
                const cleanup = cb();
                if (typeof cleanup === 'function') {
                    capturedEffectCleanup = cleanup;
                }
                return cleanup;
            }),
            inject: vi.fn((deps: string[], cb: (scope: unknown) => void | (() => void)) => {
                if (deps.every((dep) => fullCtx.get(dep) !== undefined)) {
                    cb(fullCtx);
                }
                return deps.includes('sessions') ? sessionsInjectDispose : sessionUiInjectDispose;
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
        expect(capturedEffectCleanup).toBeTypeOf('function');
        capturedEffectCleanup?.();
        expect(sessionsInjectDispose).toHaveBeenCalledTimes(1);
        expect(sessionUiInjectDispose).toHaveBeenCalledTimes(1);
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

    it('LOCAL_PATCH/REWRITE 映射到 WRITER、REPLAN 映射到 PLANNER，历史与实时多尝试序列在检查器按顺序展示并可点击下钻', async () => {
        expect(resolveStageId('LOCAL_PATCH')).toBe('WRITER');
        expect(resolveStageId('REWRITE')).toBe('WRITER');
        expect(resolveStageId('REPLAN')).toBe('PLANNER');

        runsByChapter.set(1, [
            {
                runId: 'run-ch1',
                chapter: 1,
                stage: 'PLANNER',
                role: 'planner',
                sessionId: 'sess-ch1-plan-1',
                status: 'completed',
                attempt: 1
            },
            {
                runId: 'run-ch1',
                chapter: 1,
                stage: 'REPLAN',
                role: 'planner',
                sessionId: 'sess-ch1-replan-2',
                status: 'completed',
                attempt: 2,
                triggerReason: 'FactChecker: 潮汐时间矛盾'
            },
            {
                runId: 'run-ch1',
                chapter: 1,
                stage: 'WRITER',
                role: 'writer',
                sessionId: 'sess-ch1-writer-1',
                status: 'completed',
                attempt: 1,
                mode: 'one-shot'
            },
            {
                runId: 'run-ch1',
                chapter: 1,
                stage: 'LOCAL_PATCH',
                role: 'patch',
                sessionId: 'sess-ch1-patch-2',
                status: 'completed',
                attempt: 2,
                triggerReason: 'StaticProseGate: 2 处套话违规'
            },
            {
                runId: 'run-ch1',
                chapter: 1,
                stage: 'REWRITE',
                role: 'writer',
                sessionId: 'sess-ch1-rewrite-3',
                status: 'completed',
                attempt: 3,
                triggerReason: 'FactChecker: 第 2 段港口锚泊冲突'
            }
        ]);

        const { container } = await mountStudio();
        await openStageStrip(container);

        // 历史节点绑定最新一次尝试
        expect(stageNode(container, 'PLANNER').dataset.sessionId).toBe('sess-ch1-replan-2');
        expect(stageNode(container, 'WRITER').dataset.sessionId).toBe('sess-ch1-rewrite-3');

        // 点击 WRITER 节点后切到运行状态页签，可见 WRITER 的全部 3 次尝试轨迹
        await click(stageNode(container, 'WRITER'));
        const inspTab = container.querySelector<HTMLButtonElement>('#ns-right-tab-status')!;
        await click(inspTab);

        const attemptList = container.querySelector('[aria-label="关联会话轨迹列表"]');
        expect(attemptList).not.toBeNull();
        const attemptButtons = Array.from(
            attemptList!.querySelectorAll<HTMLButtonElement>('button[data-attempt-session-id]')
        );
        expect(attemptButtons.map((b) => b.getAttribute('data-attempt-session-id'))).toEqual([
            'sess-ch1-writer-1',
            'sess-ch1-patch-2',
            'sess-ch1-rewrite-3'
        ]);
        expect(attemptButtons[1]?.textContent).toContain('LOCAL_PATCH');
        expect(attemptButtons[1]?.textContent).toContain('StaticProseGate: 2 处套话违规');
        expect(attemptButtons[1]?.textContent).toContain('completed');

        // 点击历史 LOCAL_PATCH 尝试 -> 打开该次 session 的 StageSessionViewer
        await click(attemptButtons[1]!);
        expect(container.querySelector('#ns-right-tab-trace')?.getAttribute('aria-selected')).toBe(
            'true'
        );
        expect(
            container.querySelector('.ns-session-viewer')?.getAttribute('data-session-id')
        ).toBe('sess-ch1-patch-2');

        // 实时 SSE stage:session 多轮累加：WRITER -> LOCAL_PATCH -> REWRITE
        await emit({ event: 'stage', data: { stage: 'STARTING', chapterNumber: 3 } });
        await emit({
            event: 'stage:session',
            data: {
                stage: 'WRITER',
                role: 'writer',
                chapter: 3,
                runId: 'run-live-3',
                sessionId: 'sess-live-w1',
                attempt: 1,
                status: 'running',
                mode: 'one-shot'
            }
        });
        await emit({
            event: 'stage:session',
            data: {
                stage: 'LOCAL_PATCH',
                role: 'patch',
                chapter: 3,
                runId: 'run-live-3',
                sessionId: 'sess-live-p2',
                attempt: 2,
                triggerReason: 'StaticProseGate: 1 处微距词',
                status: 'running'
            }
        });

        expect(stageNode(container, 'WRITER').dataset.sessionId).toBe('sess-live-p2');
        await click(inspTab);
        const liveAttemptIds = Array.from(
            container.querySelectorAll<HTMLButtonElement>(
                '[aria-label="关联会话轨迹列表"] button[data-attempt-session-id]'
            )
        ).map((b) => b.getAttribute('data-attempt-session-id'));
        expect(liveAttemptIds).toEqual(['sess-live-w1', 'sess-live-p2']);
    });

    it('StageSessionViewer 修正净室文字说明，并在归档回放与实时视图下方展示 modelId、thinkingChars、requestInput 与完整 tool-result', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        // 1. cleanroom: true 占位提示使用最新的 ctx.agents.create 说明，不再误报 ctx.llm / .ops/traces/
        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'WRITER',
                        stageLabel: '3. Writer',
                        sessionId: 'legacy-cleanroom',
                        status: 'done',
                        cleanroom: true
                    }
                })
            );
        });
        expect(container.textContent).toContain('ctx.agents.create');
        expect(container.textContent).not.toContain('直接调用 ctx.llm');
        expect(container.textContent).not.toContain('.ops/traces/');

        // 2. 归档回放展示 modelId、thinkingChars、可折叠 requestInput 与完整 tool-result
        const longToolResult = 'FULL_PARAGRAPH_START_' + '甲'.repeat(1200) + '_FULL_PARAGRAPH_END';
        vi.mocked(api.fetchRunDetail).mockResolvedValue({
            sessionId: 'sess-req-archive',
            runId: 'run-req-1',
            stage: 'LOCAL_PATCH',
            status: 'completed',
            modelId: 'anthropic:claude-sonnet-4-5',
            thinkingChars: 428,
            requestInput: {
                pool: 'strong_creative',
                temperature: 0.4,
                reasoningEffort: 'low',
                maxTokens: 4096,
                tools: ['patch_paragraphs', 'yield_patched_draft'],
                systemPrompt: '系统提示：仅使用 patch_paragraphs 净室修改指定段落。',
                taskPromptBlocks: ['[0] 原文第一段', '[1] 原文第二段']
            },
            events: [
                {
                    seq: 0,
                    kind: 'thinking',
                    text: '定位到第 1 段存在违规套话'
                },
                {
                    seq: 1,
                    kind: 'tool-call',
                    toolName: 'patch_paragraphs',
                    callId: 'call-p1',
                    text: '{"edits":[{"start_paragraph":1,"end_paragraph":1,"replacement_paragraphs":["改写后第二段"]}]}'
                },
                {
                    seq: 2,
                    kind: 'tool-result',
                    toolName: 'patch_paragraphs',
                    callId: 'call-p1',
                    text: longToolResult,
                    status: 'completed'
                }
            ]
        });

        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'WRITER',
                        stageLabel: '3. Writer',
                        sessionId: 'sess-req-archive',
                        runId: 'run-req-1',
                        status: 'done'
                    }
                })
            );
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(container.textContent).toContain('anthropic:claude-sonnet-4-5');
        expect(container.textContent).toContain('428');
        const reqDetails = container.querySelector<HTMLDetailsElement>(
            'details[data-session-request-input="true"]'
        );
        expect(reqDetails).not.toBeNull();
        expect(reqDetails?.textContent).toContain('systemPrompt');
        expect(reqDetails?.textContent).toContain('仅使用 patch_paragraphs 净室修改指定段落');
        expect(reqDetails?.textContent).toContain('[0] 原文第一段');
        expect(reqDetails?.textContent).toContain('0.4');
        expect(reqDetails?.textContent).toContain('low');
        expect(reqDetails?.textContent).toContain('patch_paragraphs, yield_patched_draft');
        expect(container.textContent).toContain(longToolResult);

        // 3. 实时原生视图 (canMountNative=true) 下方同样展示 requestInput、modelId、thinkingChars 与完整 tool-result
        const mockSessions: StudioSessionsService = {
            retain: vi.fn((target) => ({
                sessionId: typeof target === 'string' ? target : target.childSessionId,
                ready: Promise.resolve(),
                release: vi.fn()
            }))
        };
        vi.mocked(api.fetchRunDetail).mockResolvedValue({
            sessionId: 'sess-req-live',
            runId: 'run-req-live',
            stage: 'WRITER',
            status: 'running',
            modelId: 'deepseek:deepseek-reasoner',
            thinkingChars: 910,
            requestInput: {
                pool: 'strong_creative',
                temperature: 0.7,
                reasoningEffort: 'medium',
                systemPrompt: '写手净室系统指令',
                taskPromptBlocks: ['本章细纲：夜探码头']
            },
            events: [
                {
                    seq: 0,
                    kind: 'tool-result',
                    toolName: 'patch_paragraphs',
                    callId: 'call-live-1',
                    text: 'LIVE_TOOL_RESULT_COMPLETE',
                    status: 'completed'
                }
            ]
        });

        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'WRITER',
                        stageLabel: '3. Writer',
                        sessionId: 'sess-req-live',
                        runId: 'run-req-live',
                        status: 'active'
                    },
                    sessionsService: mockSessions,
                    SessionProvider: ({ children }) => createElement('div', { 'data-native-live': 'true' }, children),
                    renderStageConversation: ({ view }) =>
                        createElement('div', { 'data-native-view': view }, 'native-body')
                })
            );
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(container.querySelector('[data-native-live="true"]')).not.toBeNull();
        expect(container.textContent).toContain('deepseek:deepseek-reasoner');
        expect(container.textContent).toContain('910');
        const liveReqDetails = container.querySelector<HTMLDetailsElement>(
            'details[data-session-request-input="true"]'
        );
        expect(liveReqDetails).not.toBeNull();
        expect(liveReqDetails?.textContent).toContain('写手净室系统指令');
        expect(liveReqDetails?.textContent).toContain('本章细纲：夜探码头');
        expect(container.textContent).toContain('LIVE_TOOL_RESULT_COMPLETE');
    });

    it('终态不被 isHealing 覆盖、PROSE_GATE 保持 healing、stage:session 同步 selectedStageSession、且 StageSessionViewer 随 status 变更重拉并兼容 turns[].toolCalls 与空 requestInput', async () => {
        const { container } = await mountStudio();
        await openStageStrip(container);

        // 1. WRITER 启动 -> LOCAL_PATCH (healing) -> PROSE_GATE 保持 healing 与门禁 Patch 徽标 -> 终态 completed 不被 isHealing 覆盖为 healing
        await emit({ event: 'stage', data: { stage: 'STARTING', chapterNumber: 3 } });
        await emit({
            event: 'stage:session',
            data: {
                stage: 'WRITER',
                role: 'writer',
                chapter: 3,
                runId: 'run-heal-1',
                sessionId: 'sess-w1',
                attempt: 1,
                status: 'running'
            }
        });
        await emit({
            event: 'stage:session',
            data: {
                stage: 'LOCAL_PATCH',
                role: 'patch',
                chapter: 3,
                runId: 'run-heal-1',
                sessionId: 'sess-p1',
                attempt: 1,
                triggerReason: 'PROSE_GATE: micro_anatomy',
                status: 'running'
            }
        });
        expect(stageNode(container, 'WRITER').classList.contains('ns-running-live')).toBe(true);
        expect(stageNode(container, 'WRITER').textContent).toContain('润色中');

        // 点击打开 sess-p1 详情面板（此时处于 healing/running 状态）
        vi.mocked(api.fetchRunDetail).mockResolvedValueOnce({
            sessionId: 'sess-p1',
            runId: 'run-heal-1',
            stage: 'LOCAL_PATCH',
            status: 'running'
        });
        await click(stageNode(container, 'WRITER'));
        await act(async () => {
            await Promise.resolve();
        });

        // PROSE_GATE 紧随 LOCAL_PATCH 后仍无终态结果 -> 保持润色运行态
        await emit({
            event: 'stage',
            data: {
                stage: 'PROSE_GATE',
                chapterNumber: 3,
                message: '运行 0 Token 静态文风门禁'
            }
        });
        expect(stageNode(container, 'WRITER').classList.contains('ns-running-live')).toBe(true);
        expect(stageNode(container, 'WRITER').textContent).toContain('润色中');

        // LOCAL_PATCH 终态 completed 到达 -> 状态更新为 done（不再被 isHealing 覆盖），且触发 StageSessionViewer 重新拉取完整持久化详情
        vi.mocked(api.fetchRunDetail).mockResolvedValueOnce({
            sessionId: 'sess-p1',
            runId: 'run-heal-1',
            stage: 'LOCAL_PATCH',
            status: 'completed',
            modelId: 'openai:gpt-5.4',
            thinkingChars: 128,
            requestInput: {
                pool: 'strong_creative',
                systemPrompt: '补丁净室提示'
            },
            turns: [
                {
                    turnIndex: 0,
                    toolCalls: [
                        {
                            id: 'call-turn-1',
                            name: 'patch_paragraphs',
                            arguments: { edits: [] },
                            result: 'FROM_TURN_TOOL_RESULT',
                            status: 'completed'
                        }
                    ]
                }
            ]
        });
        await emit({
            event: 'stage:session',
            data: {
                stage: 'LOCAL_PATCH',
                role: 'patch',
                chapter: 3,
                runId: 'run-heal-1',
                sessionId: 'sess-p1',
                attempt: 1,
                status: 'completed'
            }
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(stageNode(container, 'WRITER').classList.contains('ns-running-live')).toBe(false);
        expect(stageNode(container, 'WRITER').textContent).toContain('已完成');
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('已完成');
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('openai:gpt-5.4');
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('128 chars');
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('补丁净室提示');
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('FROM_TURN_TOOL_RESULT');

        // 2. 下游阶段激活与 FAILED 事件均同步更新 selectedStageSession.status
        await emit({
            event: 'stage:session',
            data: {
                stage: 'FACT_CHECKER',
                role: 'fact-checker',
                chapter: 3,
                runId: 'run-heal-1',
                sessionId: 'sess-fc1',
                status: 'running'
            }
        });
        await click(stageNode(container, 'FACT_CHECKER'));
        await emit({
            event: 'stage',
            data: {
                stage: 'EXTRACTOR',
                chapterNumber: 3,
                runId: 'run-heal-1',
                sessionId: 'sess-ext1',
                status: 'running'
            }
        });
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('已完成');

        await click(stageNode(container, 'EXTRACTOR'));
        await emit({
            event: 'stage',
            data: {
                stage: 'FAILED',
                error: '模拟失败'
            }
        });
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('已拦截');

        // 3. StageSessionViewer 对空 requestInput ({}) 不渲染空 <details>，且在原生视图下补充渲染 turns[].toolCalls
        const singleContainer = document.createElement('div');
        document.body.appendChild(singleContainer);
        const singleRoot = createRoot(singleContainer);
        mountedRoots.push(singleRoot);
        const mockSessions: StudioSessionsService = {
            retain: vi.fn((target) => ({
                sessionId: typeof target === 'string' ? target : target.childSessionId,
                ready: Promise.resolve(),
                release: vi.fn()
            }))
        };
        vi.mocked(api.fetchRunDetail).mockResolvedValueOnce({
            sessionId: 'sess-empty-req',
            runId: 'run-empty-req',
            stage: 'PLANNER',
            status: 'completed',
            requestInput: {},
            turns: [
                {
                    turnIndex: 0,
                    toolCalls: [
                        {
                            id: 'call-sup-turn',
                            name: 'book_grep',
                            result: 'SUPPLEMENTARY_FROM_TURNS',
                            status: 'completed'
                        }
                    ]
                }
            ]
        });
        await act(async () => {
            singleRoot.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'PLANNER',
                        stageLabel: '2. Planner',
                        sessionId: 'sess-empty-req',
                        runId: 'run-empty-req',
                        status: 'done'
                    },
                    sessionsService: mockSessions,
                    SessionProvider: ({ children }) => createElement('div', null, children),
                    renderStageConversation: () => createElement('div', null, 'native')
                })
            );
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(singleContainer.querySelector('details[data-session-request-input="true"]')).toBeNull();
        expect(singleContainer.textContent).toContain('SUPPLEMENTARY_FROM_TURNS');
    });

    it('去框化顶部抬头展示 ns-trace-lamp/ns-trace-role、4. Checker 规范化、effectiveModelLabel 与多尝试胶囊切换', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        const onSelectAttemptSession = vi.fn();
        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'FACT_CHECKER',
                        stageLabel: 'Fact Check',
                        sessionId: 'sess-fc-1',
                        runId: 'run-fc-1',
                        status: 'active'
                    },
                    effectiveModelLabel: 'anthropic:claude-opus-4-6',
                    attemptSessions: [
                        { sessionId: 'sess-fc-1', label: '核查第 1 轮', status: 'running', attempt: 1 },
                        {
                            sessionId: 'sess-fc-2',
                            label: '局部润色 Patch #1',
                            status: 'completed',
                            attempt: 2,
                            triggerReason: '套话门禁'
                        }
                    ],
                    onSelectAttemptSession
                })
            );
        });

        const lamp = container.querySelector<HTMLElement>('.ns-trace-lamp');
        const role = container.querySelector<HTMLElement>('.ns-trace-role');
        expect(lamp).not.toBeNull();
        expect(lamp?.style.viewTransitionName).toBe('ns-trace-lamp');
        expect(role).not.toBeNull();
        expect(role?.style.viewTransitionName).toBe('ns-trace-role');
        expect(role?.textContent).toBe('4. Checker');
        expect(container.textContent).not.toContain('Fact Check');
        expect(container.textContent).toContain('anthropic:claude-opus-4-6');

        const attemptButtons = Array.from(
            container.querySelectorAll<HTMLButtonElement>('[aria-label="同阶段尝试切换"] button[data-attempt-session-id]')
        );
        expect(attemptButtons.map((b) => b.getAttribute('data-attempt-session-id'))).toEqual([
            'sess-fc-1',
            'sess-fc-2'
        ]);
        expect(attemptButtons[0]?.getAttribute('aria-pressed')).toBe('true');
        await click(attemptButtons[1]!);
        expect(onSelectAttemptSession).toHaveBeenCalledExactlyOnceWith('sess-fc-2');
    });

    it('无宿主会话服务时合并渲染 stage:event liveEvents 实时思考链与工具调用，并保留原生 SessionProvider 挂载', async () => {
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
                        sessionId: 'sess-live-sse-1',
                        status: 'active'
                    },
                    liveEvents: [
                        { seq: 0, kind: 'thinking', text: '实时思考：检索三号栈桥历史事件' },
                        {
                            seq: 1,
                            kind: 'tool-call',
                            toolName: 'book_grep',
                            callId: 'live-c1',
                            text: '{"pattern":"三号栈桥"}'
                        },
                        {
                            seq: 2,
                            kind: 'tool-result',
                            toolName: 'book_grep',
                            callId: 'live-c1',
                            text: '命中 ch_0001.md 第 4 行',
                            status: 'completed'
                        },
                        { seq: 3, kind: 'status', status: 'attempt-start' },
                        { seq: 4, kind: 'text', text: '失败尝试的草稿' },
                        { seq: 5, kind: 'status', status: 'attempt-discarded' },
                        { seq: 6, kind: 'status', status: 'attempt-start' },
                        { seq: 7, kind: 'text', text: '已打包港口相关实体。' }
                    ]
                })
            );
        });

        const liveDetail = container.querySelector('[data-session-detail="true"]');
        expect(liveDetail).not.toBeNull();
        expect(liveDetail?.getAttribute('data-session-live-stream')).toBe('true');
        expect(liveDetail?.textContent).toContain('实时思考：检索三号栈桥历史事件');
        expect(liveDetail?.textContent).toContain('book_grep');
        expect(liveDetail?.textContent).toContain('命中 ch_0001.md 第 4 行');
        expect(liveDetail?.textContent).toContain('已打包港口相关实体。');
        expect(liveDetail?.textContent).not.toContain('失败尝试的草稿');
    });

    it('FACT_CHECK 阶段标识规范化为 4. Checker，无 seq 多分片 thinking/text 无缝拼接且与带 seq runDetail 重叠去重', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);

        // 1. FACT_CHECK + 活跃 runDetail (带 seq) 与无 seq liveEvents 重叠且多分片流式 delta 无缝拼接
        vi.mocked(api.fetchRunDetail).mockResolvedValueOnce({
            sessionId: 'sess-stream-dedup',
            runId: 'run-stream-dedup',
            stage: 'FACT_CHECK',
            status: 'running',
            events: [
                { seq: 0, kind: 'thinking', text: '先核' },
                { seq: 1, kind: 'thinking', text: '对 ' },
                {
                    seq: 2,
                    kind: 'tool-call',
                    toolName: 'book_read',
                    callId: 'call-dedup-1',
                    text: '{"path":"entities/char_chen.md"}'
                }
            ]
        });

        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'FACT_CHECK',
                        stageLabel: '核查阶段',
                        sessionId: 'sess-stream-dedup',
                        status: 'active'
                    },
                    liveEvents: [
                        { kind: 'thinking', text: '对 ' },
                        {
                            kind: 'tool-call',
                            toolName: 'book_read',
                            callId: 'call-dedup-1',
                            text: '{"path":"entities/char_chen.md"}'
                        },
                        {
                            kind: 'tool-result',
                            toolName: 'book_read',
                            callId: 'call-dedup-1',
                            text: '左腕旧伤',
                            status: 'completed'
                        },
                        { kind: 'thinking', text: '继续' },
                        { kind: 'thinking', text: '比对' },
                        { kind: 'text', text: '结论：' },
                        { kind: 'text', text: '通过' }
                    ]
                })
            );
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(container.querySelector('.ns-trace-role')?.textContent).toBe('4. Checker');

        const thinkingPre = container.querySelector('.ns-session-turn-thinking pre.ns-session-pre');
        expect(thinkingPre?.textContent).toBe('先核对 \n继续比对');

        const toolCalls = container.querySelectorAll('.ns-session-tool-call');
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]?.textContent).toContain('左腕旧伤');

        const outputDiv = container.querySelector('.ns-session-turn-output');
        expect(outputDiv?.textContent).toBe('结论：通过');

        // 2. runDetail 达到终态 completed 后直接采用归档事件，不因 liveEvents 重复追加
        vi.mocked(api.fetchRunDetail).mockResolvedValueOnce({
            sessionId: 'sess-stream-done',
            runId: 'run-stream-done',
            stage: 'FACT_CHECK',
            status: 'completed',
            finishedAt: '2026-11-18T12:00:00.000Z',
            events: [
                { seq: 0, kind: 'thinking', text: '完整归档思考' },
                { seq: 1, kind: 'text', text: '最终结论' }
            ]
        });

        await act(async () => {
            root.render(
                createElement(StageSessionViewer, {
                    selection: {
                        stageId: 'FACT_CHECK',
                        stageLabel: '核查阶段',
                        sessionId: 'sess-stream-done',
                        status: 'done'
                    },
                    liveEvents: [
                        { kind: 'thinking', text: '完整' },
                        { kind: 'thinking', text: '归档思考' },
                        { kind: 'text', text: '最终结论' }
                    ]
                })
            );
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(
            container.querySelector('.ns-session-turn-thinking pre.ns-session-pre')?.textContent
        ).toBe('完整归档思考');
        expect(container.querySelector('.ns-session-turn-output')?.textContent).toBe('最终结论');
    });

    it('BUG-05: 历史 WRITER + LOCAL_PATCH 并存时点击 3. Writer 与运行状态默认均打开 Writer 原稿，且阶段记录胶囊清晰切换 Patch', async () => {
        runsByChapter.set(1, [
            {
                runId: 'run-ch1-wp',
                chapter: 1,
                stage: 'WRITER',
                role: 'writer',
                sessionId: 'sess-ch1-writer-orig',
                status: 'completed',
                attempt: 1,
                mode: 'one-shot'
            },
            {
                runId: 'run-ch1-wp',
                chapter: 1,
                stage: 'LOCAL_PATCH',
                role: 'patch',
                sessionId: 'sess-ch1-patch-1',
                status: 'completed',
                attempt: 2,
                triggerReason: 'StaticProseGate: 1 处套话违规'
            }
        ]);

        const { container } = await mountStudio();
        await openStageStrip(container);

        const writerNode = stageNode(container, 'WRITER');
        expect(writerNode.dataset.sessionId).toBe('sess-ch1-writer-orig');

        // 点击 3. Writer 默认打开原始 Writer 会话，并渲染高对比度「阶段记录 (2)」切换胶囊
        await click(writerNode);
        expect(
            container.querySelector('.ns-session-viewer')?.getAttribute('data-session-id')
        ).toBe('sess-ch1-writer-orig');

        const attemptsLabel = container.querySelector('.ns-session-attempts-label');
        expect(attemptsLabel?.textContent?.trim()).toBe('阶段记录 (2)');

        const pills = Array.from(
            container.querySelectorAll<HTMLButtonElement>('.ns-session-attempt-pill[data-attempt-session-id]')
        );
        expect(pills.map((p) => p.getAttribute('data-attempt-session-id'))).toEqual([
            'sess-ch1-writer-orig',
            'sess-ch1-patch-1'
        ]);
        expect(pills[0]?.classList.contains('ns-active')).toBe(true);
        expect(pills[0]?.getAttribute('aria-pressed')).toBe('true');
        expect(pills[1]?.classList.contains('ns-active')).toBe(false);

        // 点击 Patch 胶囊可切换至局部润色记录
        await click(pills[1]!);
        expect(
            container.querySelector('.ns-session-viewer')?.getAttribute('data-session-id')
        ).toBe('sess-ch1-patch-1');

        // 切至右栏「运行状态」：默认「查看思考过程」仍指向 Writer 原稿，且关联列表完整保留两条记录
        await click(container.querySelector<HTMLButtonElement>('#ns-right-tab-status')!);
        const primaryInspectBtn = Array.from(
            container.querySelectorAll<HTMLButtonElement>('.ns-i-stage-session-row button')
        ).find((btn) => btn.textContent?.includes('查看思考过程'));
        expect(primaryInspectBtn).toBeDefined();
        await click(primaryInspectBtn!);
        expect(
            container.querySelector('.ns-session-viewer')?.getAttribute('data-session-id')
        ).toBe('sess-ch1-writer-orig');

        await click(container.querySelector<HTMLButtonElement>('#ns-right-tab-status')!);
        const allAttemptIds = Array.from(
            container.querySelectorAll<HTMLButtonElement>(
                '[aria-label="关联会话轨迹列表"] button[data-attempt-session-id]'
            )
        ).map((btn) => btn.getAttribute('data-attempt-session-id'));
        expect(allAttemptIds).toEqual(['sess-ch1-writer-orig', 'sess-ch1-patch-1']);
    });

    it('BUG-02: 0 章新书在 STEPPING 态刷新页面且 runs 暂为空时，仍自动展开 6 节点流水线并承接第 1 章 SSE', async () => {
        vi.mocked(api.fetchStatus).mockResolvedValue({
            ...makeStatus(),
            activeChapter: 0,
            lastCommittedChapter: 0,
            latestChapter: 0,
            chapterCount: 0,
            worldState: { story_day: 1, current_chapter: 0, timeline_mode: 'MAINLINE' },
            runtime: { activeTask: 'STEPPING', haltRequested: false }
        });
        vi.mocked(api.fetchChapters).mockResolvedValue({ chapters: [] });
        vi.mocked(api.fetchRunRecords).mockResolvedValue({ runs: [] });

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);
        await act(async () => {
            root.render(createElement(NarrateStudioRoot));
        });

        expect(api.fetchRunRecords).toHaveBeenCalledWith(1);
        const toggle = container.querySelector<HTMLButtonElement>('button.ns-pipeline-toggle-btn');
        expect(toggle).not.toBeNull();
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
        expect(container.querySelectorAll('.ns-pipe-card')).toHaveLength(6);

        await emit({
            event: 'stage',
            data: {
                stage: 'LIBRARIAN',
                chapterNumber: 1,
                activeSessionId: 'sess-ch1-live-lib',
                status: 'running',
                message: '正在检索第 1 章实体'
            }
        });
        expect(stageNode(container, 'LIBRARIAN').dataset.sessionId).toBe('sess-ch1-live-lib');
    });
});

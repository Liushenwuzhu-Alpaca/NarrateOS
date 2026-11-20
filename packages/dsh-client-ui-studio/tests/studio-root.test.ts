// @vitest-environment jsdom
/**
 * 真实 Root、工作台、目录与弹窗的竞态回归，只替换 API 网络边界。
 * 宿主 Modal 沿用真实 Portal；通过 Promise.withResolvers 控制请求，不轮询或延时。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/client/api.js';
import { NarrateStudioRoot } from '../src/client/index.js';
import type {
    BookSummary, ChapterDetail, ChaptersListPayload, NarrateStatusPayload,
    PutChapterRequest, PutChapterResponse, SseEventPayload
} from '../src/client/types.js';

vi.mock('../src/client/api.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../src/client/api.js')>();
    return {
        ...original,
        fetchBooks: vi.fn(), selectBook: vi.fn(), bootBook: vi.fn(),
        fetchStatus: vi.fn(), fetchChapters: vi.fn(), fetchChapter: vi.fn(), fetchRunRecords: vi.fn(), fetchRunDetail: vi.fn(), saveChapter: vi.fn(),
        saveModelRouting: vi.fn(),
        fetchViewEntities: vi.fn(), fetchViewHorizon: vi.fn(), fetchViewThreads: vi.fn(),
        fetchViewTelemetry: vi.fn(), fetchViewSignals: vi.fn(), fetchViewHalt: vi.fn(),
        fetchViewSyncConflicts: vi.fn(),
        stepChapter: vi.fn(), syncManuscripts: vi.fn(), runDreaming: vi.fn(), harvestVoice: vi.fn(),
        healConflicts: vi.fn(), advanceVolume: vi.fn(), forkParallelWindow: vi.fn(), mergeParallelWindow: vi.fn(),
        postSignal: vi.fn(), deleteSignal: vi.fn(), requestHalt: vi.fn(),
        startYolo: vi.fn(), stopYolo: vi.fn(), subscribeNarrateEvents: vi.fn()
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
    { bookRoot: '/books/a', slug: 'a', title: '作品甲', currentChapter: 2, storyDay: 2, walPhase: 'IDLE' },
    { bookRoot: '/books/b', slug: 'b', title: '作品乙', currentChapter: 2, storyDay: 2, walPhase: 'IDLE' }
];
const mountedRoots: Root[] = [];
let activeBookRoot: string;
let manuscripts: Map<string, string>;
let onEvent: ((event: SseEventPayload) => void) | undefined;
let writes: Array<PutChapterRequest & { bookRoot: string }>;

function manuscriptKey(bookRoot: string, chapterNumber: number): string {
    return `${bookRoot}:${chapterNumber}`;
}

function chapterDetail(bookRoot: string, chapterNumber: number): ChapterDetail {
    const content = manuscripts.get(manuscriptKey(bookRoot, chapterNumber));
    if (content === undefined) throw new Error(`测试章节不存在：${bookRoot}/${chapterNumber}`);
    return {
        bookRoot,
        chapterNumber, content, dirty: false, sha256: `${bookRoot}-${chapterNumber}-sha`,
        diffFromHead: '', outlineText: null, outlineStatus: 'missing'
    };
}

function chaptersPayload(bookRoot: string): ChaptersListPayload {
    return {
        chapters: [1, 2].map((chapterNumber) => ({
            chapterNumber,
            fileName: `ch-${chapterNumber}.md`,
            title: `${bookRoot === '/books/a' ? '甲' : '乙'}第${chapterNumber}章`,
            charCount: chapterDetail(bookRoot, chapterNumber).content.length,
            sha256: `${bookRoot}-${chapterNumber}-sha`, dirty: false, commitSha: `commit-${chapterNumber}`
        }))
    };
}

function statusPayload(bookRoot: string): NarrateStatusPayload {
    const book = books.find((item) => item.bookRoot === bookRoot);
    if (!book) throw new Error(`测试作品不存在：${bookRoot}`);
    return {
        bookRoot, bookSlug: book.slug, title: book.title, walPhase: 'IDLE', activeChapter: 1,
        lastCommittedChapter: 2, latestChapter: 2, chapterCount: 2, entityCount: 0, coldArchiveCount: 0,
        worldState: { story_day: 2, current_chapter: 2, timeline_mode: 'MAINLINE' },
        pendingSignalsCount: 0,
        yolo: { running: false, completedChapters: 0, targetChapters: 0, currentStage: null },
        runtime: { activeTask: 'IDLE', haltRequested: false }
    };
}

function saveResponse(chapterNumber: number): PutChapterResponse {
    return { chapterNumber, sha256: '已保存稿指纹', sync: { status: 'SYNCED', dirtyChapters: [], downstreamConflicts: [] } };
}

beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage?.clear();
    activeBookRoot = '/books/a';
    manuscripts = new Map([
        [manuscriptKey('/books/a', 1), '甲书第一章服务器原稿。'],
        [manuscriptKey('/books/a', 2), '甲书第二章服务器原稿。'],
        [manuscriptKey('/books/b', 1), '乙书第一章服务器原稿。'],
        [manuscriptKey('/books/b', 2), '乙书第二章服务器原稿。']
    ]);
    writes = [];
    onEvent = undefined;
    vi.stubGlobal('innerWidth', 1440);
    vi.mocked(api.fetchBooks).mockImplementation(async () => ({ currentBookRoot: activeBookRoot, books }));
    vi.mocked(api.fetchStatus).mockImplementation(async () => statusPayload(activeBookRoot));
    vi.mocked(api.fetchChapters).mockImplementation(async () => chaptersPayload(activeBookRoot));
    vi.mocked(api.fetchChapter).mockImplementation(async (chapter) => chapterDetail(activeBookRoot, chapter));
    vi.mocked(api.fetchRunRecords).mockResolvedValue({ runs: [] });
    vi.mocked(api.fetchRunDetail).mockRejectedValue(new api.NarrateApiError('Not Found', 404));
    vi.mocked(api.selectBook).mockImplementation(async ({ bookRoot }) => {
        if (!bookRoot || !books.some((book) => book.bookRoot === bookRoot)) {
            throw new Error('测试只允许切换已存在的作品');
        }
        activeBookRoot = bookRoot;
        return { status: 'SWITCHED', bookRoot };
    });
    vi.mocked(api.saveChapter).mockImplementation(async (payload) => {
        writes.push({ ...payload, bookRoot: activeBookRoot });
        manuscripts.set(manuscriptKey(activeBookRoot, payload.chapterNumber), payload.content);
        return saveResponse(payload.chapterNumber);
    });
    vi.mocked(api.saveModelRouting).mockResolvedValue({
        status: 'ok',
        modelRouting: {},
        roleRouting: {},
        roleDefinitions: []
    });
    vi.mocked(api.fetchViewEntities).mockResolvedValue({ kind: 'entities', entities: [], coldArchiveCount: 0, coldArchiveIds: [] });
    vi.mocked(api.fetchViewHorizon).mockResolvedValue({ kind: 'horizon', content: '' });
    vi.mocked(api.fetchViewThreads).mockResolvedValue({ kind: 'threads', content: '' });
    vi.mocked(api.fetchViewTelemetry).mockResolvedValue({ kind: 'telemetry', entries: [] });
    vi.mocked(api.fetchViewSignals).mockResolvedValue({ kind: 'signals', signals: [], pending: [], pendingCount: 0 });
    vi.mocked(api.fetchViewHalt).mockResolvedValue({ kind: 'halt', safeHalt: null, quarantineReport: null });
    vi.mocked(api.fetchViewSyncConflicts).mockResolvedValue({
        kind: 'sync_conflicts', bookSlug: 'a', reportRevision: null,
        syncConflicts: null, conflicts: [], dirtyChapters: [], stateDiffAdvisories: [], updatedAt: null
    });
    vi.mocked(api.bootBook).mockResolvedValue({ status: 'BOOTED', bookRoot: '/books/new', result: {} });
    vi.mocked(api.stepChapter).mockResolvedValue({
        chapterNumber: 3, manuscriptPath: '/books/a/ch-3.md', replanCount: 0, rewriteCount: 0, patchRounds: 0,
        telemetry: { clicheDensityPer1k: 0, mattr500: 0.8, sentenceLengthCv: 0.5 }
    });
    vi.mocked(api.syncManuscripts).mockResolvedValue({ status: 'SYNCED', dirtyChapters: [], downstreamConflicts: [] });
    vi.mocked(api.runDreaming).mockResolvedValue({ skipped: true });
    vi.mocked(api.harvestVoice).mockResolvedValue({ harvestedCount: 0, skipped: true, samples: [] });
    vi.mocked(api.healConflicts).mockResolvedValue({ results: [], quarantined: false, quarantineReport: null });
    vi.mocked(api.advanceVolume).mockResolvedValue({
        sealedVolume: 1, nextVolume: 2, tagName: 'vol-1', archivedEntities: [], completedBook: false, commitSha: 'abc1234'
    });
    vi.mocked(api.forkParallelWindow).mockResolvedValue({
        windowId: 'win-1', baseTag: 't', baseDay: 1, maxChapters: 3, globalBroadcast: {}, baseChapter: 1,
        baseEntityIds: [], status: 'OPEN', createdAt: '2026-11-18T00:00:00Z'
    });
    vi.mocked(api.mergeParallelWindow).mockResolvedValue({
        windowId: 'win-1', baseTag: 't', mergedBranches: ['branch-a'], updatedEntities: [],
        previousStoryDay: 1, newStoryDay: 2, totalChaptersUsed: 1, sha: 'def5678'
    });
    vi.mocked(api.postSignal).mockImplementation(async (signal) => ({ status: 'QUEUED', signal }));
    vi.mocked(api.deleteSignal).mockResolvedValue({ status: 'DELETED', remaining: 0 });
    vi.mocked(api.requestHalt).mockResolvedValue({ haltRequested: true, activeTask: 'IDLE' });
    vi.mocked(api.startYolo).mockResolvedValue({ status: 'STARTED', targetChapters: 1, defaultGoal: '推进下一章' });
    vi.mocked(api.stopYolo).mockResolvedValue({ stopRequested: true, running: false, completedChapters: 0 });
    vi.mocked(api.subscribeNarrateEvents).mockImplementation((listener) => {
        onEvent = listener;
        return () => { onEvent = undefined; };
    });
});

afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

async function mountStudio(): Promise<HTMLElement> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => { root.render(createElement(NarrateStudioRoot)); });
    expect(container.querySelector('.ns-prose')?.textContent).toContain('甲书第一章服务器原稿。');
    return container;
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
    const button = Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.trim() === text);
    if (!button) throw new Error(`未找到按钮「${text}」`);
    return button;
}

async function click(element: HTMLElement): Promise<void> {
    await act(async () => { element.click(); });
}

function editor(container: HTMLElement): HTMLTextAreaElement {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea.ns-editor-textarea');
    if (!textarea) throw new Error('编辑器未打开');
    return textarea;
}

function typeDraft(container: HTMLElement, content: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('jsdom 缺少 textarea value setter');
    act(() => {
        const textarea = editor(container);
        setter.call(textarea, content);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function edit(container: HTMLElement, content: string): Promise<void> {
    await click(buttonByText(container, '直接改稿'));
    typeDraft(container, content);
}

function chapterButton(container: HTMLElement, chapter: number): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button.ns-ch-btn'))
        .find((item) => item.querySelector('.ns-ch-no')?.textContent?.trim() === `第 ${chapter} 章`);
    if (!button) throw new Error(`未找到目录章节 第 ${chapter} 章`);
    return button;
}

async function switchBookViaMenu(container: HTMLElement, bookTitle: string): Promise<void> {
    const switcher = container.querySelector<HTMLButtonElement>('button.ns-book-switcher');
    if (!switcher) throw new Error('作品切换按钮未显示');
    await click(switcher);
    const item = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((btn) => btn.querySelector('b')?.textContent?.trim() === bookTitle);
    if (!item) throw new Error(`未找到作品菜单项「${bookTitle}」`);
    await click(item);
}

async function emit(event: SseEventPayload): Promise<void> {
    if (!onEvent) throw new Error('根组件未订阅 SSE');
    await act(async () => { onEvent?.(event); });
}

it('Studio 只授权当前冲突卡展示的一项', async () => {
    const selection = { bookSlug: 'a', reportRevision: 'a'.repeat(64), conflictIndex: 0 };
    vi.mocked(api.fetchViewSyncConflicts).mockResolvedValue({
        kind: 'sync_conflicts', bookSlug: selection.bookSlug, reportRevision: selection.reportRevision,
        syncConflicts: null, dirtyChapters: [], stateDiffAdvisories: [], updatedAt: null,
        conflicts: [
            { dirtyChapter: 1, dirtyQuote: '柜门已锁。', chapterNumber: 2, quote: '柜门从未上锁。', description: '柜锁状态矛盾' },
            { chapterNumber: 7, quote: '未展示引文', description: '另一项' }
        ]
    });
    const root = await mountStudio();
    const card = root.querySelector('[data-conflict-mode="sync_conflicts"]')!;
    expect(card.textContent).toContain('柜门已锁。');
    expect(card.textContent).toContain('柜门从未上锁。');
    expect(card.textContent).not.toContain('未展示引文');
    await click(buttonByText(card, '处理本条冲突（可能按作品限额回滚重跑）'));
    expect(api.healConflicts).toHaveBeenCalledExactlyOnceWith({ selection });
});

describe('真实根组件的草稿身份与异步隔离', () => {
    it('真实 SSE 订阅接收停止等待与完成事件，状态不依赖完成后的 HTTP 可用性', async () => {
        const streams: EventTarget[] = [];
        class TestEventSource extends EventTarget {
            constructor(_url: string) { super(); streams.push(this); }
            close() {}
        }
        vi.stubGlobal('EventSource', TestEventSource);
        const realApi = await vi.importActual<typeof api>('../src/client/api.js');
        vi.mocked(api.subscribeNarrateEvents).mockImplementation(realApi.subscribeNarrateEvents);
        const container = await mountStudio();
        const send = async (event: string, data: Record<string, unknown> = {}) => act(async () => {
            streams[0]!.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
        });
        await send('stage', { stage: 'STARTING' });
        await send('halt:requested');
        expect(container.querySelector('.ns-center-header')?.textContent).toContain('写完本章即停');
        await send('halt:waiting', { activeTask: 'STEPPING' });
        expect(container.querySelector('.ns-center-header')?.textContent).toContain('等待安全点收束');
        vi.mocked(api.fetchStatus).mockRejectedValue(new Error('宿主已经关闭'));
        await send('halt:completed');
        expect(container.querySelector('.ns-center-header')?.textContent).toContain('写下一章');
        await send('stage', { stage: 'STARTING' });
        expect(container.querySelector('.ns-center-header')?.textContent).toContain('写完本章暂停');
        expect(container.querySelector('.ns-center-header')?.textContent).not.toContain('等待安全点');
    });

    it.each(['章节视图', '作品辅助视图'])('%s支持方向键和首尾键，焦点、选择和面板身份同步', async (label) => {
        const container = await mountStudio();
        await edit(container, '键盘切换页签也必须保留的草稿。');
        const list = container.querySelector<HTMLElement>(`[role="tablist"][aria-label="${label}"]`)!;
        const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        const move = (from: HTMLButtonElement, key: string) => act(async () => {
            from.focus();
            from.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
        await move(tabs[0]!, 'ArrowRight');
        expect(document.activeElement).toBe(tabs[1]);
        expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
        expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[1]]);
        const panel = document.getElementById(tabs[1]!.getAttribute('aria-controls')!);
        expect(panel?.getAttribute('aria-labelledby')).toBe(tabs[1]?.id);
        await move(tabs[1]!, 'End');
        expect(document.activeElement).toBe(tabs.at(-1));
        await move(tabs.at(-1)!, 'ArrowRight');
        expect(document.activeElement).toBe(tabs[0]);
        await move(tabs[0]!, 'ArrowLeft');
        expect(document.activeElement).toBe(tabs.at(-1));
        await move(tabs.at(-1)!, 'Home');
        expect(document.activeElement).toBe(tabs[0]);
        expect(editor(container).value).toBe('键盘切换页签也必须保留的草稿。');
    });

    it('单步失败事件立即刷新并展示刚落盘的诊断证据', async () => {
        const container = await mountStudio();
        vi.mocked(api.fetchViewHalt).mockResolvedValue({
            kind: 'halt', quarantineReport: null,
            safeHalt: { reason: '本章设定冲突', chapterNumber: 3, stage: 'FACT_CHECK',
                issues: [{ description: '与旧伤设定冲突', quote_source: '旧伤未愈', quote_draft: '伤口消失' }] }
        });
        await emit({ event: 'stage', data: { stage: 'FAILED', error: '失败事件' } });
        expect(container.textContent).toContain('本章设定冲突');
    });

    it('第 2 章 GET 在途时编辑仍属于第 1 章，迟到详情不清稿且保存写回第 1 章', async () => {
        const container = await mountStudio();
        const secondChapter = Promise.withResolvers<ChapterDetail>();
        vi.mocked(api.fetchChapter).mockImplementationOnce(() => secondChapter.promise);
        await click(chapterButton(container, 2));
        expect(api.fetchChapter).toHaveBeenLastCalledWith(2);
        expect(container.querySelector('.ns-prose')?.textContent).toContain('甲书第一章服务器原稿。');
        await click(buttonByText(container, '直接改稿'));
        expect(editor(container).value).toBe('甲书第一章服务器原稿。');
        typeDraft(container, '属于甲书第一章的新草稿。');
        await act(async () => {
            secondChapter.resolve(chapterDetail('/books/a', 2));
            await secondChapter.promise;
        });
        expect(editor(container).value).toBe('属于甲书第一章的新草稿。');
        await click(buttonByText(container, '保存并自动同步'));
        expect(api.saveChapter).toHaveBeenCalledExactlyOnceWith({ bookRoot: '/books/a', baseSha256: '/books/a-1-sha', chapterNumber: 1, content: '属于甲书第一章的新草稿。' });
        expect(manuscripts.get(manuscriptKey('/books/a', 2))).toBe('甲书第二章服务器原稿。');
    });

    it('甲书刷新部分在途时切换乙书，旧刷新返回不能切回甲书或覆盖乙书草稿', async () => {
        const container = await mountStudio();
        const oldChapters = Promise.withResolvers<ChaptersListPayload>();
        const snapshot = chaptersPayload('/books/a');
        vi.mocked(api.fetchChapters).mockImplementationOnce(() => oldChapters.promise);
        await emit({ event: 'stage', data: { stage: 'COMMITTED', chapterNumber: 1 } });
        expect(api.fetchBooks).toHaveBeenCalledTimes(2);
        expect(api.fetchStatus).toHaveBeenCalledTimes(2);
        expect(api.fetchChapters).toHaveBeenCalledTimes(2);
        await switchBookViaMenu(container, '作品乙');
        expect(api.selectBook).toHaveBeenCalledExactlyOnceWith({ bookRoot: '/books/b' });
        expect(container.querySelector('.ns-prose')?.textContent).toContain('乙书第一章服务器原稿。');
        await edit(container, '乙书独有的未保存修订。');
        const readsBeforeRelease = vi.mocked(api.fetchChapter).mock.calls.length;
        await act(async () => {
            oldChapters.resolve(snapshot);
            await oldChapters.promise;
        });
        expect(container.querySelector('.ns-book-switcher')?.textContent).toContain('作品乙');
        expect(editor(container).value).toBe('乙书独有的未保存修订。');
        expect(api.fetchChapter).toHaveBeenCalledTimes(readsBeforeRelease);
        await click(buttonByText(container, '保存并自动同步'));
        expect(writes).toEqual([{ bookRoot: '/books/b', baseSha256: '/books/b-1-sha', chapterNumber: 1, content: '乙书独有的未保存修订。' }]);
    });

    it('保存 PUT 成功但详情 GET 失败，重新编辑仍以已保存正文为基线', async () => {
        const container = await mountStudio();
        const saved = '已成功落盘但详情读取失败的新正文。';
        await edit(container, saved);
        const put = Promise.withResolvers<PutChapterResponse>();
        vi.mocked(api.saveChapter).mockImplementationOnce(() => put.promise);
        vi.mocked(api.fetchChapter).mockRejectedValue(new Error('章节详情读取失败'));
        await click(buttonByText(container, '保存并自动同步'));
        expect(api.saveChapter).toHaveBeenCalledExactlyOnceWith({ bookRoot: '/books/a', baseSha256: '/books/a-1-sha', chapterNumber: 1, content: saved });
        await act(async () => {
            manuscripts.set(manuscriptKey('/books/a', 1), saved);
            put.resolve(saveResponse(1));
            await put.promise;
        });
        await emit({ event: 'chapter_synced', data: { chapterNumber: 1 } });
        expect(vi.mocked(api.fetchChapter).mock.calls.length).toBeGreaterThan(1);
        expect(document.body.textContent).toContain('章节详情读取失败');
        expect(container.querySelector('.ns-prose')?.textContent).toContain(saved);
        expect(container.querySelector('textarea.ns-editor-textarea')).toBeNull();
        await click(buttonByText(container, '直接改稿'));
        expect(editor(container).value).toBe(saved);
        typeDraft(container, `${saved}再次修订。`);
        await click(buttonByText(container, '保存并自动同步'));
        expect(api.saveChapter).toHaveBeenCalledTimes(2);
        expect(api.saveChapter).toHaveBeenLastCalledWith({ bookRoot: '/books/a', baseSha256: '已保存稿指纹', chapterNumber: 1, content: `${saved}再次修订。` });
    });

    it('普通 PUT 在途点击跨章不能放行，拒绝后原稿保留且可以重试', async () => {
        const container = await mountStudio();
        const draft = '保存失败也必须保留的原始草稿。';
        await edit(container, draft);
        const put = Promise.withResolvers<PutChapterResponse>();
        vi.mocked(api.saveChapter).mockImplementationOnce(() => put.promise);
        await click(buttonByText(container, '保存并自动同步'));
        expect(buttonByText(container, '正在保存并同步…').disabled).toBe(true);
        const readsBeforeNavigation = vi.mocked(api.fetchChapter).mock.calls.length;
        await click(chapterButton(container, 2));
        expect(api.saveChapter).toHaveBeenCalledTimes(1);
        expect(api.fetchChapter).toHaveBeenCalledTimes(readsBeforeNavigation);
        expect(api.selectBook).not.toHaveBeenCalled();
        expect(editor(container).value).toBe(draft);
        await act(async () => {
            put.reject(new Error('事务锁拒绝本次保存'));
            await put.promise.catch(() => undefined);
        });
        expect(editor(container).value).toBe(draft);
        expect(document.body.textContent).toContain('事务锁拒绝本次保存');
        expect(buttonByText(container, '保存并自动同步').disabled).toBe(false);
        await click(buttonByText(container, '保存并自动同步'));
        expect(api.saveChapter).toHaveBeenCalledTimes(2);
        expect(api.saveChapter).toHaveBeenLastCalledWith({ bookRoot: '/books/a', baseSha256: '/books/a-1-sha', chapterNumber: 1, content: draft });
        expect(container.querySelector('.ns-prose')?.textContent).toContain(draft);
    });

    it('切章、切书与外部 book_switched SSE 自动按 bookRoot::chapter 暂存未保存草稿，不残留旧书正文且支持切回温和恢复', async () => {
        const container = await mountStudio();
        await edit(container, '甲书第一章未保存暂存草稿。');

        // 1. 切到甲书第 2 章：非阻断自动暂存，无确认弹窗
        await click(chapterButton(container, 2));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(container.querySelector('.ns-prose')?.textContent).toContain('甲书第二章服务器原稿。');

        // 2. 切回第 1 章：展示温和恢复条，点「继续改稿」恢复草稿
        await click(chapterButton(container, 1));
        const restoreBar = container.querySelector('.ns-stash-restore-bar');
        expect(restoreBar).not.toBeNull();
        await click(buttonByText(restoreBar!, '继续改稿'));
        expect(editor(container).value).toBe('甲书第一章未保存暂存草稿。');

        // 3. 外部 book_switched SSE 切到乙书：自动暂存甲书草稿并干净展示乙书正文，绝不串书
        activeBookRoot = '/books/b';
        await emit({ event: 'book_switched', data: { bookRoot: '/books/b' } });
        expect(container.querySelector('.ns-book-switcher')?.textContent).toContain('作品乙');
        expect(container.querySelector('.ns-prose')?.textContent).toContain('乙书第一章服务器原稿。');
        expect(container.querySelector('.ns-prose')?.textContent).not.toContain('甲书第一章未保存暂存草稿。');
        expect(container.querySelector('textarea.ns-editor-textarea')).toBeNull();

        // 4. 触发 beforeunload：因为甲书第 1 章仍在暂存池中，hasAnyUnsavedDraft 拦截离开
        const beforeUnloadEv = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(beforeUnloadEv);
        expect(beforeUnloadEv.defaultPrevented).toBe(true);

        // 5. 切回甲书并放弃暂存后，beforeunload 放行
        await switchBookViaMenu(container, '作品甲');
        const backRestoreBar = container.querySelector('.ns-stash-restore-bar');
        expect(backRestoreBar).not.toBeNull();
        await click(buttonByText(backRestoreBar!, '放弃暂存'));
        expect(container.querySelector('.ns-stash-restore-bar')).toBeNull();
        const cleanEv = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(cleanEv);
        expect(cleanEv.defaultPrevented).toBe(false);
    });

    it('容器感知三栏布局：>=1100px 常驻左栏，<1100px 收进顶栏浮层，<820px 右栏变抽屉', async () => {
        let roCallback: ResizeObserverCallback | null = null;
        const disconnectSpy = vi.fn();
        class MockResizeObserver {
            constructor(cb: ResizeObserverCallback) {
                roCallback = cb;
            }
            observe() {}
            unobserve() {}
            disconnect() {
                disconnectSpy();
            }
        }
        vi.stubGlobal('ResizeObserver', MockResizeObserver);

        const container = await mountStudio();
        const shell = container.querySelector('.ns-studio-shell')!;
        expect(shell.classList.contains('ns-layout-wide')).toBe(true);
        expect(container.querySelector('aside.ns-left-pane')).not.toBeNull();

        const rightTabs = Array.from(container.querySelectorAll('.ns-right-tab')).map((b) =>
            b.textContent?.trim()
        );
        expect(rightTabs).toEqual(['思考过程', '运行状态', '模型分配']);

        // 1100px 仍为三栏常驻态
        act(() => {
            roCallback?.([{ contentRect: { width: 1100 } } as ResizeObserverEntry], {} as ResizeObserver);
        });
        expect(shell.classList.contains('ns-layout-wide')).toBe(true);
        expect(container.querySelector('aside.ns-left-pane')).not.toBeNull();

        // 缩放至 1099px (<1100px)：左栏收进顶栏目录浮层，右栏保持常驻
        act(() => {
            roCallback?.([{ contentRect: { width: 1099 } } as ResizeObserverEntry], {} as ResizeObserver);
        });
        expect(shell.classList.contains('ns-layout-medium')).toBe(true);
        expect(container.querySelector('aside.ns-left-pane')).toBeNull();
        expect(container.textContent).toContain('目录与设定集');

        // 缩放至 760px (<820px)：右栏转为浮层抽屉，且不再渲染右侧拖拽分隔条
        act(() => {
            roCallback?.([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver);
        });
        expect(shell.classList.contains('ns-layout-compact')).toBe(true);
        expect(container.querySelector('[role="separator"][aria-label="调整右侧状态栏宽度"]')).toBeNull();
    });

    it('在「模型分配」页签通过双池与单角色原生 <select> 修改并保存，调用 saveModelRouting 并刷新 status', async () => {
        const baseStatus = statusPayload('/books/a');
        let currentStatus: NarrateStatusPayload = {
            ...baseStatus,
            defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
            poolOverrides: {},
            modelRouting: {
                strong_creative: 'anthropic:claude-sonnet-4-5',
                fast_retrieval: 'deepseek:deepseek-chat'
            },
            roleRouting: {},
            roleDefinitions: [
                {
                    id: 'librarian',
                    defaultPool: 'fast_retrieval',
                    effectivePool: 'fast_retrieval',
                    effectiveProvider: 'deepseek',
                    effectiveModel: 'deepseek-chat'
                },
                {
                    id: 'fact_checker',
                    defaultPool: 'strong_creative',
                    effectivePool: 'strong_creative',
                    effectiveProvider: 'anthropic',
                    effectiveModel: 'claude-sonnet-4-5'
                },
                {
                    id: 'writer',
                    defaultPool: 'strong_creative',
                    effectivePool: 'strong_creative',
                    effectiveProvider: 'anthropic',
                    effectiveModel: 'claude-sonnet-4-5'
                }
            ],
            availableModels: [
                { provider: 'anthropic', model: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
                { provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1' },
                { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat' }
            ]
        };
        vi.mocked(api.fetchStatus).mockImplementation(async () => currentStatus);
        vi.mocked(api.saveModelRouting).mockImplementation(async (payload) => {
            currentStatus = {
                ...currentStatus,
                modelRouting: payload.model_routing ?? currentStatus.modelRouting,
                poolOverrides: payload.model_routing ?? {},
                roleRouting: payload.role_routing ?? {}
            };
            return {
                status: 'ok',
                defaultModel: currentStatus.defaultModel,
                poolOverrides: currentStatus.poolOverrides,
                modelRouting: currentStatus.modelRouting,
                roleRouting: currentStatus.roleRouting,
                roleDefinitions: currentStatus.roleDefinitions
            };
        });

        const container = await mountStudio();
        await click(buttonByText(container, '模型分配'));

        // fact_checker 界面展示统一为 Checker，且不存在第 3 个 audit 池
        expect(container.textContent).toContain('Checker');
        expect(container.textContent).not.toContain('Fact Check');
        expect(container.textContent).not.toContain('独立挑错池');

        // 修改第一层强模型池与展开 librarian/writer 行并修改第二层覆盖
        const strongPoolSelect = container.querySelector<HTMLSelectElement>('select[aria-label="强模型池"]')!;
        await click(container.querySelector<HTMLButtonElement>('[data-role-id="librarian"] button.ns-role-summary')!);
        await click(container.querySelector<HTMLButtonElement>('[data-role-id="writer"] button.ns-role-summary')!);

        const librarianTier = container.querySelector<HTMLSelectElement>('select[aria-label="librarian 档位覆盖"]')!;
        const writerModel = container.querySelector<HTMLSelectElement>('select[aria-label="writer 指定模型"]')!;
        await act(async () => {
            strongPoolSelect.value = 'anthropic:claude-opus-4-5';
            strongPoolSelect.dispatchEvent(new Event('change', { bubbles: true }));
            librarianTier.value = 'strong';
            librarianTier.dispatchEvent(new Event('change', { bubbles: true }));
            writerModel.value = 'openai:gpt-4.1';
            writerModel.dispatchEvent(new Event('change', { bubbles: true }));
        });

        const statusCallsBeforeSave = vi.mocked(api.fetchStatus).mock.calls.length;
        const saveBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
            b.textContent?.includes('保存工种模型配置')
        )!;
        await click(saveBtn);

        expect(api.saveModelRouting).toHaveBeenCalledExactlyOnceWith({
            model_routing: {
                strong_creative: 'anthropic:claude-opus-4-5',
                fast_retrieval: ''
            },
            role_routing: {
                librarian: { tier: 'strong' },
                writer: { model: 'openai:gpt-4.1' }
            }
        });
        expect(vi.mocked(api.fetchStatus).mock.calls.length).toBeGreaterThan(statusCallsBeforeSave);
    });

    it('完整消费 6 个新 SSE 事件 (stage:event/signal:withdrawn/volume:advanced/task:idle/heal:started/heal:completed) 并收敛 dream:completed', async () => {
        const container = await mountStudio();

        // 1. stage:event 实时流渲染至 StageSessionViewer
        await emit({
            event: 'stage',
            data: { stage: 'STARTING', chapterNumber: 3 }
        });
        await emit({
            event: 'stage',
            data: { stage: 'LIBRARIAN', chapterNumber: 3, activeSessionId: 'sess-live-sse', status: 'running' }
        });
        await emit({
            event: 'stage:event',
            data: { sessionId: 'sess-live-sse', stage: 'LIBRARIAN', kind: 'thinking', text: '检索码头账本' }
        });
        await emit({
            event: 'stage:event',
            data: { sessionId: 'sess-live-sse', stage: 'LIBRARIAN', kind: 'tool-call', toolName: 'book_grep', callId: 'c1', text: '{"pattern":"驳船"}' }
        });

        // 进入推章态时 3x2 矩阵自动展开，直接点击 Librarian
        const pipelineToggle = container.querySelector<HTMLButtonElement>('.ns-pipeline-toggle-btn')!;
        expect(pipelineToggle.getAttribute('aria-expanded')).toBe('true');
        await click(container.querySelector<HTMLButtonElement>('.ns-pipe-card[data-stage-id="LIBRARIAN"]')!);
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('检索码头账本');
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('book_grep');

        // 2. dream:completed 收敛 DREAMING 会话状态
        await emit({
            event: 'dream:started',
            data: { activeSessionId: 'sess-dream-1', runId: 'run-dream-1' }
        });
        const dreamCard = container.querySelector<HTMLButtonElement>('.ns-pipe-card[data-stage-id="DREAMING"]')!;
        expect(dreamCard.querySelector('.ns-pipe-step-state')?.textContent).toBe('生成中');
        await emit({ event: 'dream:completed', data: { skipped: false } });
        expect(dreamCard.querySelector('.ns-pipe-step-state')?.textContent).toBe('条件未达');
        await click(dreamCard);
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('已完成');

        // 3. signal:withdrawn / volume:advanced / task:idle / heal:started / heal:completed
        const viewsBefore = vi.mocked(api.fetchViewSignals).mock.calls.length;
        await emit({ event: 'signal:withdrawn', data: { created_at: '2026-11-18T00:00:00Z', reason: 'test' } });
        expect(vi.mocked(api.fetchViewSignals).mock.calls.length).toBeGreaterThan(viewsBefore);

        await emit({ event: 'volume:advanced', data: { sealedVolume: 1, nextVolume: 2, completedBook: false } });
        expect(document.body.textContent).toContain('第 1 卷');

        await emit({ event: 'heal:started', data: { conflictCount: 1 } });
        expect(document.body.textContent).toContain('1 处冲突');
        await emit({ event: 'heal:completed', data: { resultCount: 1, quarantined: false } });
        expect(document.body.textContent).toContain('自愈完成');

        await emit({ event: 'task:idle', data: { task: 'STEPPING' } });
    });

    it('全量对接 status 真实诊断字段 (txLockHeld/双SHA/装配报告/Checker筛除/Dreaming水位/切镜队列) 与双命名 halt 映射', async () => {
        vi.mocked(api.fetchStatus).mockResolvedValue({
            ...statusPayload('/books/a'),
            txLockHeld: true,
            featCommitSha: 'feat9988a',
            stateCommitSha: 'stat1122b',
            writerAssemblyReport: {
                estimatedTokens: { staticPrefixTokens: 4120, dynamicTailTokens: 14280, totalInputTokens: 18400 },
                budget: 32000,
                evictionLevel: 1,
                selectedVoiceSample: { id: 'v1', tag: '冷峻克制', text: '封港夜里不过磅。' },
                strippedSecretCount: 2
            },
            lastCheckerResult: {
                chapter: 2,
                passed: true,
                issueCount: 0,
                issues: [],
                filteredOutCount: 3,
                replanCount: 0,
                rewriteCount: 0,
                patchRounds: 1
            },
            dreamWatermark: {
                last_dream_ch: 1,
                accumulated_words_since_dream: 6120,
                updated_at: '2026-11-18T12:00:00Z'
            },
            dirtyEntityCount: 2,
            dirtyEntityThreshold: 6,
            spotlightQueue: [
                { entity_id: 'char_zhou', reason: '幕后积累已久', progressPct: 80 }
            ],
            volumeProgress: {
                currentVolume: 1,
                volumeLabel: '第一卷 · 寒潮封港',
                completedChapters: 2,
                totalChapters: 10
            }
        });
        vi.mocked(api.fetchViewHalt).mockResolvedValue({
            kind: 'halt',
            safeHalt: {
                reason: '左手旧伤未愈不得单手推门',
                stage: 'FACT_CHECK',
                chapterNumber: 3,
                side_a_chapter: 1,
                side_a_line: 14,
                side_b_chapter: 3,
                side_b_line: 5,
                quoteA: '左腕旧骨折未愈',
                quoteB: '抬起左手推开重门',
                rollback_chapters: 2,
                affected_words: 5400,
                issues: [
                    {
                        description: '与第 1 章伤势设定冲突',
                        source_ref: 'ch_0001.md',
                        quote_source: '左腕旧骨折未愈',
                        quote_draft: '抬起左手推开重门'
                    }
                ]
            },
            quarantineReport: null
        });

        const container = await mountStudio();
        await click(buttonByText(container, '运行状态'));

        expect(container.textContent).toContain('4.1k');
        expect(container.textContent).toContain('14.3k');
        expect(container.textContent).toContain('6,120');
        expect(container.textContent).toContain('2 / 6');

        // 展开底层校验与提交明细
        const detailsToggle = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
            b.textContent?.includes('底层校验与提交明细')
        )!;
        await click(detailsToggle);
        expect(container.textContent).toContain('feat998');
        expect(container.textContent).toContain('stat112');
        expect(container.textContent).toContain('3');
        expect(container.textContent).toContain('ch_0001.md:14');
        expect(container.textContent).toContain('ch_0003.md:5');
        expect(container.textContent).toContain('2 章 / 5400 字');
    });

    it('通过顶栏「⋯」菜单点击声纹采集调用 harvestVoice，且在途切书时屏蔽过期提示', async () => {
        vi.mocked(api.harvestVoice).mockResolvedValueOnce({
            harvestedCount: 2,
            skipped: false,
            samples: [
                { id: 'v1', tag: '冷峻克制', text: '把门关上。' },
                { id: 'v2', tag: '压低声线', text: '别往外说。' }
            ]
        });

        const container = await mountStudio();
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="更多创作整理操作"]')!);
        const harvestItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
            (btn) => btn.textContent?.includes('重新提取本章对话声纹')
        )!;
        await click(harvestItem);
        expect(api.harvestVoice).toHaveBeenCalledWith(1);
        expect(document.body.textContent).toContain('2');

        const harvestDeferred = Promise.withResolvers<{
            harvestedCount: number;
            skipped: boolean;
            samples: Array<{ id: string; tag: string; text: string }>;
        }>();
        vi.mocked(api.harvestVoice).mockReturnValueOnce(harvestDeferred.promise);
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="更多创作整理操作"]')!);
        const harvestItem2 = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
            (btn) => btn.textContent?.includes('重新提取本章对话声纹')
        )!;
        await click(harvestItem2);

        activeBookRoot = '/books/b';
        await emit({ event: 'book_switched', data: { bookRoot: '/books/b' } });

        await act(async () => {
            harvestDeferred.resolve({
                harvestedCount: 4,
                skipped: false,
                samples: [{ id: 'stale', tag: '旧书', text: '旧书样本。' }]
            });
            await harvestDeferred.promise;
        });
        expect(document.body.textContent).not.toContain('新增 4 条样本');
    });

    it('handleStepOne 同步防重入锁拦截连击，回忆模式携带 timelineMode 与 targetDay，且 STARTING 清空瞬态 telemetry', async () => {
        const stepDeferred = Promise.withResolvers<{ status: string; message?: string }>();
        vi.mocked(api.stepChapter).mockReturnValueOnce(stepDeferred.promise);

        const container = await mountStudio();
        const stepBtn = buttonByText(container, '写下一章');
        await act(async () => {
            stepBtn.click();
            stepBtn.click();
        });
        expect(api.stepChapter).toHaveBeenCalledTimes(1);

        await act(async () => {
            stepDeferred.resolve({ status: 'accepted' });
            await stepDeferred.promise;
        });

        // 切换便签为「插入回忆」，填写回到第 3 天并立即写下一章
        vi.mocked(api.stepChapter).mockResolvedValueOnce({ status: 'accepted' });
        await click(container.querySelector<HTMLButtonElement>('button.ns-note-kind-btn')!);
        const flashbackItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
            (btn) => btn.textContent?.includes('插入回忆')
        )!;
        await click(flashbackItem);
        const dayInput = container.querySelector<HTMLInputElement>('input[aria-label="回忆目标天数"]')!;
        const noteInput = container.querySelector<HTMLInputElement>('input.ns-note-input')!;
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        await act(async () => {
            inputSetter?.call(dayInput, '3');
            dayInput.dispatchEvent(new Event('input', { bubbles: true }));
            inputSetter?.call(noteInput, '补写码头旧事');
            noteInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="存入便签并立即写下一章"]')!);
        expect(api.stepChapter).toHaveBeenLastCalledWith(
            expect.objectContaining({
                timelineMode: 'FLASHBACK',
                targetDay: 3
            })
        );

        // 先接收一次 telemetry SSE，随后 stage: STARTING 应清空瞬态 liveTelemetry
        await click(buttonByText(container, '运行状态'));
        await emit({
            event: 'telemetry',
            data: {
                metrics: {
                    mattr500: 0.88
                }
            }
        });
        expect(container.textContent).toContain('0.88');

        await emit({
            event: 'stage',
            data: { stage: 'STARTING', chapterNumber: 3 }
        });
        expect(container.textContent).not.toContain('0.88');
    });

    it('通过顶栏「⋯」菜单可打开换卷/完结与多线并行弹窗并提交 API', async () => {
        const container = await mountStudio();
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="更多创作整理操作"]')!);
        const volumeItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
            (btn) => btn.textContent?.includes('结束本卷 / 开启下一卷')
        )!;
        await click(volumeItem);
        const submitVolumeBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('封存本卷并开启下一卷')
        )!;
        await click(submitVolumeBtn);
        expect(api.advanceVolume).toHaveBeenCalledTimes(1);

        await click(container.querySelector<HTMLButtonElement>('button[aria-label="更多创作整理操作"]')!);
        const parallelItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
            (btn) => btn.textContent?.includes('开启多线并行章节')
        )!;
        await click(parallelItem);
        const windowInput = document.body.querySelector<HTMLInputElement>('#ns-parallel-window-id')!;
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        await act(async () => {
            inputSetter?.call(windowInput, 'win-dock-night');
            windowInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const forkBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('开启并行分叉')
        )!;
        await click(forkBtn);
        expect(api.forkParallelWindow).toHaveBeenCalledWith({
            windowId: 'win-dock-night'
        });
        expect(container.textContent).toContain('多线并行 · win-dock-night');

        // 并行窗口内写下一章应透传 timelineMode: 'PARALLEL', parallelWindowId, parallelBranchId (默认 branch-a)
        await click(buttonByText(container, '写下一章'));
        expect(api.stepChapter).toHaveBeenLastCalledWith({
            timelineMode: 'PARALLEL',
            parallelWindowId: 'win-dock-night',
            parallelBranchId: 'branch-a'
        });

        // 再次打开多线并行弹窗切换支线，校验非法 branchId 并切换至 branch-b，禁止二次调用 forkParallelWindow
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="更多创作整理操作"]')!);
        const switchItem = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
            (btn) => btn.textContent?.includes('管理 / 合流多线并行窗口')
        )!;
        await click(switchItem);
        const branchInput = document.body.querySelector<HTMLInputElement>('#ns-parallel-branch-id')!;
        await act(async () => {
            inputSetter?.call(branchInput, 'bad branch!');
            branchInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const switchBtn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
            (btn) => btn.textContent?.includes('切换支线继续写')
        )!;
        await click(switchBtn);
        expect(document.body.textContent).toContain('并行支线标识仅允许字母、数字、下划线(_)与连字符(-)');
        expect(api.forkParallelWindow).toHaveBeenCalledTimes(1);

        await act(async () => {
            inputSetter?.call(branchInput, 'branch-b');
            branchInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(switchBtn);
        expect(api.forkParallelWindow).toHaveBeenCalledTimes(1);

        await click(buttonByText(container, '写下一章'));
        expect(api.stepChapter).toHaveBeenLastCalledWith({
            timelineMode: 'PARALLEL',
            parallelWindowId: 'win-dock-night',
            parallelBranchId: 'branch-b'
        });

        // 外部切书清理 parallelWindowId / parallelBranchId
        activeBookRoot = '/books/b';
        await emit({ event: 'book_switched', data: { bookRoot: '/books/b' } });
        expect(container.textContent).not.toContain('多线并行 · win-dock-night');
    });

    it('全书设定集切 Tab 与返回正文同步左栏高亮，外部 book_switched 重置设定集表面与视图缓存', async () => {
        vi.mocked(api.fetchViewEntities).mockResolvedValue({
            kind: 'entities',
            entities: [{ entityId: 'e1', canonicalName: '陈砚', aliases: [], markdown: '## 1. Innate Locks\n- 审计员' }],
            coldArchiveCount: 0,
            coldArchiveIds: []
        });
        const container = await mountStudio();

        const leftEntitiesBtn = Array.from(
            container.querySelectorAll<HTMLButtonElement>('aside.ns-left-pane button.ns-codex-row')
        ).find((b) => b.textContent?.includes('人物与物品档案'))!;
        await click(leftEntitiesBtn);
        expect(leftEntitiesBtn.getAttribute('aria-current')).toBe('page');
        expect(container.textContent).toContain('全书设定集');

        // 设定集内切换至「未解伏笔」应同步左栏 activeViewKind
        await click(buttonByText(container, '未解伏笔 (0)'));
        const leftThreadsBtn = Array.from(
            container.querySelectorAll<HTMLButtonElement>('aside.ns-left-pane button.ns-codex-row')
        ).find((b) => b.textContent?.includes('未解伏笔清单'))!;
        expect(leftThreadsBtn.getAttribute('aria-current')).toBe('page');
        expect(leftEntitiesBtn.getAttribute('aria-current')).toBeNull();

        // 点击右上角返回正文应清除左栏设定集高亮并回到正文
        await click(buttonByText(container, '返回第 1 章正文'));
        expect(leftThreadsBtn.getAttribute('aria-current')).toBeNull();
        expect(container.textContent).toContain('甲书第一章服务器原稿');

        // 再次进入设定集后接收外部 book_switched，应自动退出设定集并清空旧书实体
        await click(leftEntitiesBtn);
        expect(container.querySelector('article.ns-codex-sheet')).not.toBeNull();
        vi.mocked(api.fetchViewEntities).mockResolvedValue({
            kind: 'entities',
            entities: [],
            coldArchiveCount: 0,
            coldArchiveIds: []
        });
        activeBookRoot = '/books/b';
        await emit({ event: 'book_switched', data: { bookRoot: '/books/b' } });
        expect(container.querySelector('article.ns-codex-sheet')).toBeNull();
        expect(container.textContent).toContain('乙书第一章服务器原稿');
        expect(leftEntitiesBtn.getAttribute('aria-current')).toBeNull();
    });

    it.each([
        { event: 'task:idle', data: { task: 'STEPPING' } },
        { event: 'stage', data: { stage: 'COMMITTED', chapterNumber: 1 } }
    ] as const)('工序徽标只显示本次执行，$event 后仍可下钻归档尝试', async (terminal) => {
        vi.mocked(api.fetchStatus).mockImplementation(async () => {
            const idle = statusPayload(activeBookRoot);
            return { ...idle, yolo: { ...idle.yolo, currentStage: 'WRITER' } };
        });
        vi.mocked(api.fetchRunRecords).mockResolvedValue({
            runs: [{
                runId: 'writer-history', chapter: 1, stage: 'WRITER', role: 'writer',
                sessionId: 'writer-history-session', status: 'completed', attempt: 2
            }]
        });
        const container = await mountStudio();
        const toggle = container.querySelector<HTMLButtonElement>('.ns-pipeline-toggle-btn')!;
        if (toggle.getAttribute('aria-expanded') === 'false') await click(toggle);
        const card = (id: string) =>
            container.querySelector<HTMLButtonElement>(`.ns-pipe-card[data-stage-id="${id}"]`)!;
        const badge = (id: string) => card(id).querySelector('.ns-pipe-step-state')?.textContent;
        expect(badge('WRITER')).toBe('待命');
        await click(card('WRITER'));
        expect(container.querySelector('.ns-session-viewer')?.getAttribute('data-session-id'))
            .toBe('writer-history-session');
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('已完成');

        for (const chapterNumber of [3, 1]) {
            await emit({ event: 'stage', data: { stage: 'STARTING', chapterNumber } });
            expect(badge('LIBRARIAN')).toBe('待命');
            await emit({ event: 'stage', data: { stage: 'LIBRARIAN', chapterNumber, status: 'running' } });
            expect(badge('LIBRARIAN')).toBe('生成中');
            expect(badge('WRITER')).toBe('待命');
        }
        await emit({ event: 'stage', data: {
            stage: 'WRITER', chapterNumber: 1, status: 'running', activeSessionId: 'writer-live-session'
        } });
        expect(badge('LIBRARIAN')).toBe('已完成');
        expect(badge('WRITER')).toBe('生成中');
        expect(card('WRITER').getAttribute('data-session-id')).toBe('writer-live-session');
        if (terminal.event === 'task:idle') {
            await emit({ event: 'stage:session', data: {
                stage: 'WRITER', chapterNumber: 1, status: 'completed', sessionId: 'writer-live-session'
            } });
        }

        await emit(terminal);
        expect(badge('LIBRARIAN')).toBe('待命');
        expect(badge('WRITER')).toBe('待命');
        await click(card('WRITER'));
        expect(container.querySelector('.ns-session-viewer')?.textContent).toContain('已完成');
    });

    it('章节加载期间暂不显示实时徽标，加载完毕后恢复仍在运行的工序', async () => {
        const container = await mountStudio();
        await emit({ event: 'stage', data: { stage: 'STARTING', chapterNumber: 3 } });
        await emit({ event: 'stage', data: { stage: 'LIBRARIAN', chapterNumber: 3, status: 'running' } });
        const toggle = container.querySelector<HTMLButtonElement>('.ns-pipeline-toggle-btn')!;
        if (toggle.getAttribute('aria-expanded') === 'false') await click(toggle);
        const badge = () => container.querySelector(
            '.ns-pipe-card[data-stage-id="LIBRARIAN"] .ns-pipe-step-state'
        )?.textContent;
        expect(badge()).toBe('生成中');
        const secondChapter = Promise.withResolvers<ChapterDetail>();
        vi.mocked(api.fetchChapter).mockImplementationOnce(() => secondChapter.promise);
        await click(chapterButton(container, 2));
        expect(badge()).toBe('待命');
        await act(async () => {
            secondChapter.resolve(chapterDetail('/books/a', 2));
            await secondChapter.promise;
        });
        expect(badge()).toBe('生成中');
    });

    it('点击无 sessionId 的非 Writer 工序卡片会打开右栏思考过程并清空上一工种残留会话', async () => {
        vi.mocked(api.fetchRunRecords).mockResolvedValue({
            runs: [
                {
                    runId: 'run-lib-1',
                    chapter: 1,
                    stage: 'LIBRARIAN',
                    role: 'librarian',
                    sessionId: 'sess-lib-1',
                    status: 'completed',
                    attempt: 1
                }
            ]
        });
        const container = await mountStudio();

        // 展开 3x2 工序矩阵，先点击有 sessionId 的 1. Librarian
        await click(container.querySelector<HTMLButtonElement>('button.ns-pipeline-toggle-btn')!);
        await click(container.querySelector<HTMLButtonElement>('.ns-pipe-card[data-stage-id="LIBRARIAN"]')!);
        expect(container.querySelector('.ns-session-viewer')?.getAttribute('data-session-id')).toBe('sess-lib-1');

        // 切换到「运行状态」并收起右栏，再点击未运行的 6. Dreamer（无 sessionId）
        await click(buttonByText(container, '运行状态'));
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="收起右侧面板"]')!);
        expect(container.querySelector('aside.ns-right-pane')).toBeNull();

        await click(container.querySelector<HTMLButtonElement>('.ns-pipe-card[data-stage-id="DREAMING"]')!);
        expect(container.querySelector('aside.ns-right-pane')).not.toBeNull();
        expect(container.querySelector('#ns-right-tab-trace')?.getAttribute('aria-selected')).toBe('true');
        expect(container.querySelector('.ns-session-viewer')?.getAttribute('data-session-id')).toBeNull();
        expect(container.textContent).toContain('未选择工种会话节点');
    });

    it('无书态调用 fetchStatus 加载双池模型并支持下拉保存、default_model_changed SSE 实时刷新及扉页开启 BootBookModal', async () => {
        activeBookRoot = '';
        vi.mocked(api.fetchBooks).mockResolvedValue({ currentBookRoot: null, books: [] });
        let currentNoBookStatus: NarrateStatusPayload = {
            bookRoot: '',
            bookSlug: '',
            title: '',
            walPhase: 'IDLE',
            activeChapter: null,
            lastCommittedChapter: 0,
            latestChapter: 0,
            chapterCount: 0,
            entityCount: 0,
            coldArchiveCount: 0,
            worldState: { story_day: 0, current_chapter: 0, timeline_mode: 'MAINLINE' },
            pendingSignalsCount: 0,
            yolo: { running: false, completedChapters: 0, targetChapters: 0, currentStage: null },
            runtime: { activeTask: 'IDLE', haltRequested: false },
            defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
            poolOverrides: {},
            modelRouting: {
                strong_creative: 'deepseek-official:deepseek-flash',
                fast_retrieval: 'deepseek-official:deepseek-flash'
            },
            roleDefinitions: [
                {
                    id: 'writer',
                    defaultPool: 'strong_creative',
                    effectivePool: 'strong_creative',
                    effectiveProvider: 'deepseek-official',
                    effectiveModel: 'deepseek-flash'
                }
            ],
            availableModels: [
                { provider: 'deepseek-official', model: 'deepseek-flash', label: 'DeepSeek Flash' },
                { provider: 'deepseek-official', model: 'deepseek-reasoner', label: 'DeepSeek R1' }
            ]
        };
        vi.mocked(api.fetchStatus).mockImplementation(async () => currentNoBookStatus);
        vi.mocked(api.saveModelRouting).mockImplementation(async (payload) => {
            currentNoBookStatus = {
                ...currentNoBookStatus,
                poolOverrides: { strong_creative: payload.model_routing?.['strong_creative'] ?? '' },
                modelRouting: {
                    strong_creative: payload.model_routing?.['strong_creative'] || 'deepseek-official:deepseek-flash',
                    fast_retrieval: payload.model_routing?.['fast_retrieval'] || 'deepseek-official:deepseek-flash'
                }
            };
            return {
                status: 'ok',
                defaultModel: currentNoBookStatus.defaultModel,
                poolOverrides: currentNoBookStatus.poolOverrides,
                modelRouting: currentNoBookStatus.modelRouting,
                roleDefinitions: currentNoBookStatus.roleDefinitions
            };
        });

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        mountedRoots.push(root);
        await act(async () => {
            root.render(createElement(NarrateStudioRoot));
        });

        expect(api.fetchStatus).toHaveBeenCalledTimes(1);

        // 扉页主按钮为「开启新作品」，点击后弹出 BootBookModal
        await click(buttonByText(container, '开启新作品'));
        expect(document.body.querySelector('[role="dialog"][aria-label="开新书编译引导"]')).not.toBeNull();
        await click(document.body.querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!);

        // 切至模型分配：第一层首项为跟随 DSH 本体默认，可选并保存
        await click(buttonByText(container, '模型分配'));
        const strongSelect = container.querySelector<HTMLSelectElement>('select[aria-label="强模型池"]')!;
        expect(strongSelect.options[0]?.textContent).toBe('跟随 DSH 本体默认（deepseek-official:deepseek-flash）');
        expect(strongSelect.value).toBe('');

        await act(async () => {
            strongSelect.value = 'deepseek-official:deepseek-reasoner';
            strongSelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await click(buttonByText(container, '保存工种模型配置'));
        expect(api.saveModelRouting).toHaveBeenCalledWith({
            model_routing: {
                strong_creative: 'deepseek-official:deepseek-reasoner',
                fast_retrieval: ''
            },
            role_routing: {}
        });

        // 接收 default_model_changed SSE 实时更新首项文案
        currentNoBookStatus = {
            ...currentNoBookStatus,
            defaultModel: { provider: 'openai', model: 'gpt-4.1' }
        };
        await emit({
            event: 'default_model_changed',
            data: {
                defaultModel: { provider: 'openai', model: 'gpt-4.1' }
            }
        });
        expect(strongSelect.options[0]?.textContent).toBe('跟随 DSH 本体默认（openai:gpt-4.1）');
    });

    it('支持左栏独立折叠/展开、左右 separator 拖拽调整宽度、双击恢复与键盘微调并持久化至 localStorage', async () => {
        const container = await mountStudio();
        const shell = container.querySelector<HTMLElement>('.ns-studio-shell')!;

        // 1. 顶栏书名左侧存在收起左栏按钮，点击收起并持久化到 localStorage
        const leftToggleBtn = container.querySelector<HTMLButtonElement>('button[aria-label="收起左侧目录栏"]')!;
        expect(leftToggleBtn).not.toBeNull();
        const headerLeftChildren = Array.from(container.querySelector('.ns-header-left')!.children);
        expect(headerLeftChildren[0]).toBe(leftToggleBtn);

        await click(leftToggleBtn);
        expect(container.querySelector('aside.ns-left-pane')).toBeNull();
        expect(shell.classList.contains('ns-left-closed')).toBe(true);
        expect(window.localStorage.getItem('narrateos.studio.leftOpen')).toBe('false');

        // 再次点击展开左栏
        await click(container.querySelector<HTMLButtonElement>('button[aria-label="展开左侧目录栏"]')!);
        expect(container.querySelector('aside.ns-left-pane')).not.toBeNull();
        expect(window.localStorage.getItem('narrateos.studio.leftOpen')).toBe('true');

        // 2. 左栏分隔条：pointer 拖拽（含 setPointerCapture 与 ns-resizing）、边界钳位、双击复位、键盘微调
        const leftSep = container.querySelector<HTMLElement>('[role="separator"][aria-label="调整左侧目录栏宽度"]')!;
        expect(leftSep).not.toBeNull();
        const setPointerCaptureSpy = vi.fn();
        leftSep.setPointerCapture = setPointerCaptureSpy;

        act(() => {
            leftSep.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 224, button: 0 }));
        });
        expect(setPointerCaptureSpy).toHaveBeenCalled();
        expect(shell.classList.contains('ns-resizing')).toBe(true);

        act(() => {
            leftSep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300 }));
        });
        expect(shell.style.getPropertyValue('--ns-left-w')).toBe('300px');

        // 超出上限 380px 钳位
        act(() => {
            leftSep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 600 }));
            leftSep.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 600 }));
        });
        expect(shell.classList.contains('ns-resizing')).toBe(false);
        expect(shell.style.getPropertyValue('--ns-left-w')).toBe('380px');
        expect(window.localStorage.getItem('narrateos.studio.leftWidth')).toBe('380');

        // 键盘 ArrowLeft 微调与双击恢复默认 224px
        act(() => {
            leftSep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        });
        expect(Number.parseInt(shell.style.getPropertyValue('--ns-left-w'), 10)).toBeLessThan(380);
        act(() => {
            leftSep.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        expect(shell.style.getPropertyValue('--ns-left-w')).toBe('224px');

        // 3. 右栏分隔条：向左拖宽（280~540）、双击恢复 340px
        const rightSep = container.querySelector<HTMLElement>('[role="separator"][aria-label="调整右侧状态栏宽度"]')!;
        expect(rightSep).not.toBeNull();
        act(() => {
            rightSep.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1100, button: 0 }));
            rightSep.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1000 }));
            rightSep.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 1000 }));
        });
        expect(shell.style.getPropertyValue('--ns-right-w')).toBe('440px');
        expect(window.localStorage.getItem('narrateos.studio.rightWidth')).toBe('440');

        act(() => {
            rightSep.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        expect(shell.style.getPropertyValue('--ns-right-w')).toBe('340px');
    });
});

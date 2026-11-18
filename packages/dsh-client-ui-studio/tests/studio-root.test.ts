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
        stepChapter: vi.fn(), syncManuscripts: vi.fn(), runDreaming: vi.fn(), harvestVoice: vi.fn(),
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
    return { chapterNumber, sync: { status: 'SYNCED', dirtyChapters: [], downstreamConflicts: [] } };
}

beforeEach(() => {
    vi.resetAllMocks();
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
    vi.mocked(api.bootBook).mockResolvedValue({ status: 'BOOTED', bookRoot: '/books/new', result: {} });
    vi.mocked(api.stepChapter).mockResolvedValue({
        chapterNumber: 3, manuscriptPath: '/books/a/ch-3.md', replanCount: 0, rewriteCount: 0, patchRounds: 0,
        telemetry: { clicheDensityPer1k: 0, mattr500: 0.8, sentenceLengthCv: 0.5 }
    });
    vi.mocked(api.syncManuscripts).mockResolvedValue({ status: 'SYNCED', dirtyChapters: [], downstreamConflicts: [] });
    vi.mocked(api.runDreaming).mockResolvedValue({ skipped: true });
    vi.mocked(api.harvestVoice).mockResolvedValue({ harvestedCount: 0, skipped: true, samples: [] });
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
    await click(buttonByText(container, '✎ 编辑'));
    typeDraft(container, content);
}

function chapterButton(container: HTMLElement, chapter: number): HTMLButtonElement {
    const code = `Ch.${String(chapter).padStart(4, '0')}`;
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button.ns-ch-btn'))
        .find((item) => item.querySelector('.ns-ch-code')?.textContent?.trim() === code);
    if (!button) throw new Error(`未找到目录章节 ${code}`);
    return button;
}

function bookSelect(container: HTMLElement): HTMLSelectElement {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="切换作品"]');
    if (!select) throw new Error('作品切换器未显示');
    return select;
}

function dialog(title: string): HTMLElement {
    const element = document.body.querySelector<HTMLElement>(`[role="dialog"][aria-label="${title}"]`);
    if (!element) throw new Error(`弹窗未打开：${title}`);
    return element;
}

async function emit(event: SseEventPayload): Promise<void> {
    if (!onEvent) throw new Error('根组件未订阅 SSE');
    await act(async () => { onEvent?.(event); });
}

async function startSave(container: HTMLElement, mode: '普通' | '守卫'): Promise<void> {
    if (mode === '普通') {
        await click(buttonByText(container, '保存并自动 Sync'));
    } else {
        await click(buttonByText(container, '+ 开新书'));
        await click(buttonByText(dialog('未保存的修改'), '保存并继续'));
    }
}

async function cancelBoot(mode: '普通' | '守卫'): Promise<void> {
    if (mode === '守卫') {
        await click(buttonByText(dialog('开新书编译引导'), '取消'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    }
}

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
        expect(container.querySelector('.ns-runtime-status')?.textContent).toContain('等待');
        expect(container.querySelector('.ns-runtime-status')?.textContent).not.toContain('已停止');
        await send('halt:waiting', { activeTask: 'STEPPING' });
        expect(container.querySelector('.ns-runtime-status')?.textContent).toContain('当前任务仍在执行');
        vi.mocked(api.fetchStatus).mockRejectedValue(new Error('宿主已经关闭'));
        await send('halt:completed');
        expect(container.querySelector('.ns-runtime-status')?.textContent).toContain('已停止');
        await send('stage', { stage: 'STARTING' });
        expect(container.querySelector('.ns-runtime-status')?.textContent).toContain('正在生成');
        expect(container.querySelector('.ns-runtime-status')?.textContent).not.toContain('等待');
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

    it('第 2 章 GET 在途时编辑仍属于第 1 章，迟到详情不清稿且保存写回第 1 章', async () => {
        const container = await mountStudio();
        const secondChapter = Promise.withResolvers<ChapterDetail>();
        vi.mocked(api.fetchChapter).mockImplementationOnce(() => secondChapter.promise);
        await click(chapterButton(container, 2));
        expect(api.fetchChapter).toHaveBeenLastCalledWith(2);
        expect(container.querySelector('.ns-prose')?.textContent).toContain('甲书第一章服务器原稿。');
        await click(buttonByText(container, '✎ 编辑'));
        expect(editor(container).value).toBe('甲书第一章服务器原稿。');
        typeDraft(container, '属于甲书第一章的新草稿。');
        await act(async () => {
            secondChapter.resolve(chapterDetail('/books/a', 2));
            await secondChapter.promise;
        });
        expect(editor(container).value).toBe('属于甲书第一章的新草稿。');
        await click(buttonByText(container, '保存并自动 Sync'));
        expect(api.saveChapter).toHaveBeenCalledExactlyOnceWith({ chapterNumber: 1, content: '属于甲书第一章的新草稿。' });
        expect(manuscripts.get(manuscriptKey('/books/a', 2))).toBe('甲书第二章服务器原稿。');
    });

    it('甲书刷新部分在途时切换乙书，旧刷新返回不能切回甲书或覆盖乙书草稿', async () => {
        const container = await mountStudio();
        const oldChapters = Promise.withResolvers<ChaptersListPayload>();
        const snapshot = chaptersPayload('/books/a');
        vi.mocked(api.fetchChapters).mockImplementationOnce(() => oldChapters.promise);
        // COMMITTED 走完整 refreshAll；工具栏刷新只加载物化视图，不覆盖此竞态。
        await emit({ event: 'stage', data: { stage: 'COMMITTED', chapterNumber: 1 } });
        expect(api.fetchBooks).toHaveBeenCalledTimes(2);
        expect(api.fetchStatus).toHaveBeenCalledTimes(2);
        expect(api.fetchChapters).toHaveBeenCalledTimes(2);
        const select = bookSelect(container);
        expect(select.disabled).toBe(false);
        await act(async () => {
            select.value = '/books/b';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(api.selectBook).toHaveBeenCalledExactlyOnceWith({ bookRoot: '/books/b' });
        expect(container.querySelector('.ns-prose')?.textContent).toContain('乙书第一章服务器原稿。');
        await edit(container, '乙书独有的未保存修订。');
        const readsBeforeRelease = vi.mocked(api.fetchChapter).mock.calls.length;
        await act(async () => {
            oldChapters.resolve(snapshot);
            await oldChapters.promise;
        });
        expect(bookSelect(container).value).toBe('/books/b');
        expect(bookSelect(container).selectedOptions[0]?.textContent).toBe('作品乙');
        expect(editor(container).value).toBe('乙书独有的未保存修订。');
        expect(api.fetchChapter).toHaveBeenCalledTimes(readsBeforeRelease);
        await click(buttonByText(container, '保存并自动 Sync'));
        expect(writes).toEqual([{ bookRoot: '/books/b', chapterNumber: 1, content: '乙书独有的未保存修订。' }]);
    });

    it.each(['普通', '守卫'] as const)('%s保存 PUT 成功但详情 GET 失败，重新编辑仍以已保存正文为基线', async (mode) => {
        const container = await mountStudio();
        const saved = '已成功落盘但详情读取失败的新正文。';
        await edit(container, saved);
        const put = Promise.withResolvers<PutChapterResponse>();
        vi.mocked(api.saveChapter).mockImplementationOnce(() => put.promise);
        vi.mocked(api.fetchChapter).mockRejectedValue(new Error('章节详情读取失败'));
        await startSave(container, mode);
        expect(api.saveChapter).toHaveBeenCalledExactlyOnceWith({ chapterNumber: 1, content: saved });
        await act(async () => {
            manuscripts.set(manuscriptKey('/books/a', 1), saved);
            put.resolve(saveResponse(1));
            await put.promise;
        });
        // 守卫保存也通过后端同步事件触发 GET，不直接调用根组件内部回调。
        await emit({ event: 'chapter_synced', data: { chapterNumber: 1 } });
        expect(vi.mocked(api.fetchChapter).mock.calls.length).toBeGreaterThan(1);
        expect(document.body.textContent).toContain('章节详情读取失败');
        await cancelBoot(mode);
        expect(container.querySelector('.ns-prose')?.textContent).toContain(saved);
        expect(container.querySelector('textarea.ns-editor-textarea')).toBeNull();
        await click(buttonByText(container, '✎ 编辑'));
        expect(editor(container).value).toBe(saved);
        typeDraft(container, `${saved}再次修订。`);
        await click(buttonByText(container, '保存并自动 Sync'));
        expect(api.saveChapter).toHaveBeenCalledTimes(2);
        expect(api.saveChapter).toHaveBeenLastCalledWith({ chapterNumber: 1, content: `${saved}再次修订。` });
        expect(api.bootBook).not.toHaveBeenCalled();
    });

    it.each(['普通', '守卫'] as const)('%s保存期间同次切书 SSE 迟到，GET 失败也不恢复旧稿', async (mode) => {
        const container = await mountStudio();
        await act(async () => {
            const select = bookSelect(container);
            select.value = '/books/b';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(container.querySelector('.ns-prose')?.textContent).toContain('乙书第一章服务器原稿。');
        const saved = '乙书在迟到切书通知之后仍应保留的修订。';
        await edit(container, saved);
        const put = Promise.withResolvers<PutChapterResponse>();
        vi.mocked(api.saveChapter).mockImplementationOnce(() => put.promise);
        vi.mocked(api.fetchChapter).mockRejectedValue(new Error('章节详情读取失败'));
        await startSave(container, mode);
        await emit({ event: 'book_switched', data: { bookRoot: '/books/b' } });
        await act(async () => {
            manuscripts.set(manuscriptKey('/books/b', 1), saved);
            put.resolve(saveResponse(1));
            await put.promise;
        });
        await emit({ event: 'chapter_synced', data: { chapterNumber: 1 } });
        await cancelBoot(mode);
        expect(bookSelect(container).value).toBe('/books/b');
        expect(container.querySelector('.ns-prose')?.textContent).toContain(saved);
        await click(buttonByText(container, '✎ 编辑'));
        expect(editor(container).value).toBe(saved);
        expect(api.saveChapter).toHaveBeenCalledExactlyOnceWith({ chapterNumber: 1, content: saved });
    });

    it.each(['普通', '守卫'] as const)('%s保存前发出的旧 GET 在保存完成后返回，不能复活旧正文', async (mode) => {
        const container = await mountStudio();
        const oldDetail = Promise.withResolvers<ChapterDetail>();
        const snapshot = chapterDetail('/books/a', 1);
        vi.mocked(api.fetchChapter).mockImplementationOnce(() => oldDetail.promise);
        await emit({ event: 'chapter_synced', data: { chapterNumber: 1 } });
        expect(api.fetchChapter).toHaveBeenCalledTimes(2);
        await edit(container, '保存交接后的唯一正文。');
        await startSave(container, mode);
        await cancelBoot(mode);
        expect(api.saveChapter).toHaveBeenCalledExactlyOnceWith({ chapterNumber: 1, content: '保存交接后的唯一正文。' });
        expect(container.querySelector('textarea.ns-editor-textarea')).toBeNull();
        expect(container.querySelector('.ns-prose')?.textContent).toContain('保存交接后的唯一正文。');
        await act(async () => {
            oldDetail.resolve(snapshot);
            await oldDetail.promise;
        });
        expect(container.querySelector('.ns-prose')?.textContent).toContain('保存交接后的唯一正文。');
        expect(container.querySelector('.ns-prose')?.textContent).not.toContain(snapshot.content);
        await click(buttonByText(container, '✎ 编辑'));
        expect(editor(container).value).toBe('保存交接后的唯一正文。');
    });

    it.each(['开新书', '跨章'] as const)('普通 PUT 在途点击%s不能放行或另发保存，拒绝后原稿保留且可以重试', async (navigation) => {
        const container = await mountStudio();
        const draft = '保存失败也必须保留的原始草稿。';
        await edit(container, draft);
        const put = Promise.withResolvers<PutChapterResponse>();
        vi.mocked(api.saveChapter).mockImplementationOnce(() => put.promise);
        await click(buttonByText(container, '保存并自动 Sync'));
        expect(buttonByText(container, '正在保存并 Sync…').disabled).toBe(true);
        const readsBeforeNavigation = vi.mocked(api.fetchChapter).mock.calls.length;
        await click(navigation === '开新书' ? buttonByText(container, '+ 开新书') : chapterButton(container, 2));
        // 可直接阻止导航，也可展示禁用/拒绝操作的守卫；都不得绕过在途保存。
        const guard = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="未保存的修改"]');
        if (guard) {
            const save = Array.from(guard.querySelectorAll('button')).find((button) => button.textContent?.includes('保存'));
            if (!save) throw new Error('草稿守卫缺少保存操作');
            await click(save);
            await click(buttonByText(guard, '放弃修改'));
        }
        expect(api.saveChapter).toHaveBeenCalledTimes(1);
        expect(api.fetchChapter).toHaveBeenCalledTimes(readsBeforeNavigation);
        expect(api.selectBook).not.toHaveBeenCalled();
        expect(api.bootBook).not.toHaveBeenCalled();
        expect(document.body.querySelector('[role="dialog"][aria-label="开新书编译引导"]')).toBeNull();
        expect(editor(container).value).toBe(draft);
        await act(async () => {
            put.reject(new Error('事务锁拒绝本次保存'));
            await put.promise.catch(() => undefined);
        });
        expect(editor(container).value).toBe(draft);
        expect(document.body.textContent).toContain('事务锁拒绝本次保存');
        expect(api.saveChapter).toHaveBeenCalledTimes(1);
        expect(api.fetchChapter).toHaveBeenCalledTimes(readsBeforeNavigation);
        expect(document.body.querySelector('[role="dialog"][aria-label="开新书编译引导"]')).toBeNull();
        const remainingGuard = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="未保存的修改"]');
        if (remainingGuard) await click(buttonByText(remainingGuard, '取消'));
        expect(buttonByText(container, '保存并自动 Sync').disabled).toBe(false);
        await click(buttonByText(container, '保存并自动 Sync'));
        expect(api.saveChapter).toHaveBeenCalledTimes(2);
        expect(api.saveChapter).toHaveBeenLastCalledWith({ chapterNumber: 1, content: draft });
        expect(container.querySelector('.ns-prose')?.textContent).toContain(draft);
    });

    it('在工具页签修改分角色模型覆盖并保存后调用 saveModelRouting 且刷新 status，检查器保留只读三池遥测', async () => {
        const baseStatus = statusPayload('/books/a');
        let currentStatus: NarrateStatusPayload = {
            ...baseStatus,
            modelRouting: {
                strong_creative: 'anthropic:claude-sonnet-4-5',
                fast_retrieval: 'deepseek:deepseek-chat',
                audit: 'openai:gpt-4.1'
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
                    id: 'writer',
                    defaultPool: 'strong_creative',
                    effectivePool: 'strong_creative',
                    effectiveProvider: 'anthropic',
                    effectiveModel: 'claude-sonnet-4-5'
                }
            ],
            availableModels: [
                { provider: 'openai', model: 'gpt-4.1', label: 'GPT-4.1' },
                { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat' }
            ]
        };
        vi.mocked(api.fetchStatus).mockImplementation(async () => currentStatus);
        vi.mocked(api.saveModelRouting).mockImplementation(async (payload) => {
            currentStatus = {
                ...currentStatus,
                roleRouting: payload.role_routing ?? {},
                roleDefinitions: [
                    {
                        id: 'librarian',
                        defaultPool: 'fast_retrieval',
                        effectiveTier: 'strong',
                        effectivePool: 'strong_creative',
                        effectiveProvider: 'anthropic',
                        effectiveModel: 'claude-sonnet-4-5'
                    },
                    {
                        id: 'writer',
                        defaultPool: 'strong_creative',
                        effectivePool: 'strong_creative',
                        effectiveProvider: 'openai',
                        effectiveModel: 'gpt-4.1'
                    }
                ]
            };
            return {
                status: 'ok',
                modelRouting: currentStatus.modelRouting,
                roleRouting: currentStatus.roleRouting,
                roleDefinitions: currentStatus.roleDefinitions
            };
        });

        const container = await mountStudio();

        // 检查器仅保留只读三池模型路由，不再重复渲染分角色覆盖表单
        await click(buttonByText(container, '检查器'));
        expect(container.textContent).toContain('三池模型路由 (modelRouting)');
        expect(container.querySelector('select[aria-label="librarian 档位覆盖"]')).toBeNull();

        // 工具页签直接挂载 RoleRoutingEditor 位于当前三池模型路由下方
        await click(buttonByText(container, '工具'));
        const toolsPanel = container.querySelector<HTMLElement>('[aria-label="运维工具与模型池"]');
        expect(toolsPanel).not.toBeNull();
        expect(toolsPanel?.textContent).toContain('当前三池模型路由');

        const librarianTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="librarian 档位覆盖"]'
        );
        const writerModel = container.querySelector<HTMLInputElement>(
            'input[aria-label="writer 指定模型"]'
        );
        expect(librarianTier).not.toBeNull();
        expect(writerModel).not.toBeNull();

        await act(async () => {
            librarianTier!.value = 'strong';
            librarianTier!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        await act(async () => {
            inputSetter?.call(writerModel!, 'openai:gpt-4.1');
            writerModel!.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const statusCallsBeforeSave = vi.mocked(api.fetchStatus).mock.calls.length;
        await click(buttonByText(container, '保存工种模型配置'));

        expect(api.saveModelRouting).toHaveBeenCalledExactlyOnceWith({
            role_routing: {
                librarian: { tier: 'strong' },
                writer: { model: 'openai:gpt-4.1' }
            }
        });
        expect(vi.mocked(api.fetchStatus).mock.calls.length).toBeGreaterThan(statusCallsBeforeSave);
        expect(
            container.querySelector('[data-role-id="librarian"]')?.textContent
        ).toContain('anthropic:claude-sonnet-4-5');
        expect(
            container.querySelector('[data-role-id="writer"]')?.textContent
        ).toContain('openai:gpt-4.1');
    });

    it('切书至同样 roleRouting: {} 的 B 书时重置工具页签未保存草稿与提示，roleDefinitions 缺省时显示占位提示', async () => {
        const statusByBook: Record<string, NarrateStatusPayload> = {
            '/books/a': {
                ...statusPayload('/books/a'),
                modelRouting: {
                    strong_creative: 'anthropic:claude-sonnet-4-5',
                    fast_retrieval: 'deepseek:deepseek-chat',
                    audit: 'openai:gpt-4.1'
                },
                roleRouting: {},
                roleDefinitions: [
                    {
                        id: 'writer',
                        defaultPool: 'strong_creative',
                        defaultReasoningEffort: 'medium',
                        effectivePool: 'strong_creative',
                        effectiveProvider: 'anthropic',
                        effectiveModel: 'claude-sonnet-4-5',
                        effectiveReasoningEffort: 'medium'
                    }
                ]
            },
            '/books/b': {
                ...statusPayload('/books/b'),
                modelRouting: {
                    strong_creative: 'anthropic:claude-sonnet-4-5',
                    fast_retrieval: 'deepseek:deepseek-chat',
                    audit: 'openai:gpt-4.1'
                },
                roleRouting: {},
                roleDefinitions: [
                    {
                        id: 'writer',
                        defaultPool: 'strong_creative',
                        defaultReasoningEffort: 'medium',
                        effectivePool: 'strong_creative',
                        effectiveProvider: 'anthropic',
                        effectiveModel: 'claude-sonnet-4-5',
                        effectiveReasoningEffort: 'medium'
                    }
                ]
            }
        };
        vi.mocked(api.fetchStatus).mockImplementation(async () => statusByBook[activeBookRoot]!);

        const container = await mountStudio();
        await click(buttonByText(container, '工具'));

        const writerTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 档位覆盖"]'
        )!;
        const writerEffort = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 推理强度"]'
        )!;
        expect(writerTier.options[0]?.textContent).toBe('继承默认');
        expect(writerEffort.options[0]?.textContent).toBe('继承默认');

        // A 书本地未保存草稿
        await act(async () => {
            writerTier.value = 'weak';
            writerTier.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(writerTier.value).toBe('weak');

        // 切换到同样 roleRouting: {} 的 B 书 -> 未保存草稿必须重置
        await act(async () => {
            const select = bookSelect(container);
            select.value = '/books/b';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const nextWriterTier = container.querySelector<HTMLSelectElement>(
            'select[aria-label="writer 档位覆盖"]'
        )!;
        expect(nextWriterTier.value).toBe('');

        // 若服务端未下发 roleDefinitions 且 roleRouting 为空 -> 呈现清晰占位提示
        statusByBook['/books/b'] = {
            ...statusByBook['/books/b']!,
            roleDefinitions: []
        };
        await emit({ event: 'stage', data: { stage: 'COMMITTED', chapterNumber: 2 } });
        expect(container.textContent).toContain('等待服务端下发工种配置 (roleDefinitions)...');
    });

    it('在工具页签点击声纹采集 (Voice Harvest) 调用 harvestVoice 并展示结果提示', async () => {
        vi.mocked(api.harvestVoice).mockResolvedValueOnce({
            harvestedCount: 2,
            skipped: false,
            samples: [
                { id: 'v1', tag: '冷峻克制', text: '把门关上。' },
                { id: 'v2', tag: '压低声线', text: '别往外说。' }
            ]
        });

        const container = await mountStudio();
        await click(buttonByText(container, '工具'));

        const harvestBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button.ns-tool-card')).find(
            (btn) => btn.textContent?.includes('声纹采集 (Voice Harvest)')
        );
        expect(harvestBtn).toBeDefined();

        await click(harvestBtn!);

        expect(api.harvestVoice).toHaveBeenCalledWith(1);
        expect(document.body.textContent).toContain('2');

        // 1. res.skipped === true 时展示准确提示
        vi.mocked(api.harvestVoice).mockResolvedValueOnce({
            harvestedCount: 0,
            skipped: true,
            samples: []
        });
        await click(harvestBtn!);
        expect(document.body.textContent).toContain('当前作品已有声纹标本，已跳过本次采集');

        // 2. 在途切书（SSE book_switched）使旧工作区声纹采集结果失效，不向新作品弹出旧提示
        const harvestDeferred = Promise.withResolvers<{
            harvestedCount: number;
            skipped: boolean;
            samples: Array<{ id: string; tag: string; text: string }>;
        }>();
        vi.mocked(api.harvestVoice).mockReturnValueOnce(harvestDeferred.promise);
        await click(harvestBtn!);

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
});

// @vitest-environment jsdom
/**
 * CenterWorkbench 保存身份/在途状态与细纲诚实呈现回归测试。
 * 真实 React mount + DOM 事件驱动；宿主原语由 vitest alias 指向 tests/host-ui.ts，
 * 不 mock React hooks，不 mock 被测组件本身；时序用 Promise.withResolvers 精确控制。
 */
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    CenterWorkbench,
    resolvePrimaryStageSession,
    type CenterWorkbenchDraftHandle,
    type CenterWorkbenchProps,
    type ChapterDetailData
} from '../src/client/CenterWorkbench.js';
import { STUDIO_CSS } from '../src/client/styles.js';
import { BOOT_CSS } from '../src/client/boot-styles.js';

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

interface MountedWorkbench {
    container: HTMLElement;
    root: Root;
    rerender: (next?: Partial<CenterWorkbenchProps>) => void;
    unmount: () => void;
}

const mountedRoots: Root[] = [];

/** 挂载真实组件；rerender 模拟父组件 props 变化（如导航意图漂移） */
function mountWorkbench(props: CenterWorkbenchProps): MountedWorkbench {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(createElement(CenterWorkbench, props));
    });
    return {
        container,
        root,
        rerender: (next) => {
            act(() => {
                root.render(createElement(CenterWorkbench, { ...props, ...next }));
            });
        },
        unmount: () => {
            act(() => {
                root.unmount();
            });
            container.remove();
        }
    };
}

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => {
            root.unmount();
        });
    }
    document.body.innerHTML = '';
});

/** 按完整可见文本查找按钮 */
function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
    const btn = Array.from(scope.querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').trim() === text
    );
    if (!btn) {
        throw new Error(`未找到按钮「${text}」`);
    }
    return btn as HTMLButtonElement;
}

function menuItemByTitle(scope: ParentNode, title: string): HTMLButtonElement {
    const btn = Array.from(scope.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
        (b) => b.querySelector('b')?.textContent?.trim() === title
    );
    if (!btn) {
        throw new Error(`未找到菜单项「${title}」`);
    }
    return btn;
}

function click(el: HTMLElement): void {
    act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

/** 走原生 value setter + input 事件，触发 React 受控 onChange */
function typeDraft(textarea: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
    )?.set;
    if (!setter) {
        throw new Error('jsdom 缺少 textarea value setter');
    }
    act(() => {
        setter.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function editorTextarea(container: HTMLElement): HTMLTextAreaElement {
    const el = container.querySelector('textarea.ns-editor-textarea');
    if (!el) {
        throw new Error('编辑器未打开');
    }
    return el as HTMLTextAreaElement;
}

/** 打开编辑器并输入草稿，返回 textarea */
function openEditorWithDraft(view: MountedWorkbench, draft: string): HTMLTextAreaElement {
    click(buttonByText(view.container, '直接改稿'));
    const textarea = editorTextarea(view.container);
    typeDraft(textarea, draft);
    return textarea;
}

function baseProps(detail: ChapterDetailData): CenterWorkbenchProps {
    return {
        bookTitle: '示例作品',
        currentBookRoot: '/books/demo',
        currentChapter: 3,
        selectedChapter: detail.chapterNumber,
        timelineMode: 'MAINLINE',
        activeTask: 'IDLE',
        chapters: [
            { chapterNumber: 1, title: '第一章' },
            { chapterNumber: 2, title: '第二章' },
            { chapterNumber: 3, title: '第三章' }
        ],
        chapterDetail: detail
    };
}

const chapterOneDetail: ChapterDetailData = {
    bookRoot: '/books/demo',
    sha256: '原稿指纹',
    chapterNumber: 1,
    title: '雪夜入城',
    content: '第一章服务器原稿。'
};

describe('普通保存：显示章身份与在途状态', () => {
    it('导航意图漂移到新章时，保存仍写入正在显示/编辑的旧章', async () => {
        const saveGate = Promise.withResolvers<void>();
        const onSaveChapter = vi.fn(() => saveGate.promise);
        const view = mountWorkbench({ ...baseProps(chapterOneDetail), onSaveChapter });
        const textarea = openEditorWithDraft(view, '第一章的未保存修订。');

        // 父组件已把 selectedChapter 指向第 2 章，但详情仍是第 1 章（新章 GET 未采纳）
        view.rerender({ selectedChapter: 2, chapterDetail: { ...chapterOneDetail, sha256: '新版指纹', content: '其他入口改过的正文' } });
        expect(editorTextarea(view.container).value).toBe('第一章的未保存修订。');

        click(buttonByText(view.container, '保存并自动同步'));
        expect(onSaveChapter).toHaveBeenCalledTimes(1);
        expect(onSaveChapter).toHaveBeenCalledWith({ bookRoot: '/books/demo', chapterNumber: 1,
            baseSha256: '原稿指纹', content: '第一章的未保存修订。' });

        await act(async () => {
            saveGate.resolve();
            await saveGate.promise;
        });
        expect(view.container.textContent).toContain('已保存第 1 章');
        expect(view.container.querySelector('textarea.ns-editor-textarea')).toBeNull();
        view.unmount();
    });

    it('恢复暂存稿前比对版本；原稿已改时保留可复制的草稿和当前正文', () => {
        const onRestoreStashedDraft = vi.fn();
        const draft = { bookRoot: '/books/demo', chapterNumber: 1, baseSha256: '旧稿指纹', content: '保留这份草稿', updatedAt: 100 };
        const view = mountWorkbench({ ...baseProps(chapterOneDetail), stashedDraft: draft, onRestoreStashedDraft });
        const restore = buttonByText(view.container, '继续改稿');
        expect(restore.disabled).toBe(true);
        click(restore);
        expect(onRestoreStashedDraft).not.toHaveBeenCalled();
        expect(view.container.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value).toBe(draft.content);
        expect(view.container.textContent).toContain(chapterOneDetail.content);
        view.rerender({ stashedDraft: { ...draft, baseSha256: chapterOneDetail.sha256! } });
        click(buttonByText(view.container, '继续改稿'));
        expect(editorTextarea(view.container).value).toBe(draft.content);
    });

    it('保存在途时按钮禁用并显示进度文案，重复点击不产生第二次 PUT', async () => {
        const saveGate = Promise.withResolvers<void>();
        const onSaveChapter = vi.fn(() => saveGate.promise);
        const view = mountWorkbench({ ...baseProps(chapterOneDetail), onSaveChapter });
        openEditorWithDraft(view, '在途保存草稿。');

        click(buttonByText(view.container, '保存并自动同步'));
        const busyButton = buttonByText(view.container, '正在保存并同步…');
        expect(busyButton.disabled).toBe(true);
        // 即便绕过 disabled 直接派发点击，也不得重入
        click(busyButton);
        expect(onSaveChapter).toHaveBeenCalledTimes(1);

        await act(async () => {
            saveGate.resolve();
            await saveGate.promise;
        });
        expect(onSaveChapter).toHaveBeenCalledTimes(1);
        expect(view.container.querySelector('textarea.ns-editor-textarea')).toBeNull();
        view.unmount();
    });

    it('保存被拒绝时不假装成功：草稿保留、展示真实错误、可重试', async () => {
        const saveGate = Promise.withResolvers<void>();
        const onSaveChapter = vi.fn(() => saveGate.promise);
        const view = mountWorkbench({ ...baseProps(chapterOneDetail), onSaveChapter });
        const textarea = openEditorWithDraft(view, '必须保留的失败草稿。');

        click(buttonByText(view.container, '保存并自动同步'));
        await act(async () => {
            saveGate.reject(new Error('事务锁被占用'));
            await saveGate.promise.catch(() => undefined);
        });

        expect(view.container.textContent).toContain('事务锁被占用');
        expect(view.container.textContent).not.toContain('已保存第 1 章');
        expect(editorTextarea(view.container).value).toBe('必须保留的失败草稿。');
        expect(textarea.isConnected).toBe(true);
        const retryButton = buttonByText(view.container, '保存并自动同步');
        expect(retryButton.disabled).toBe(false);
        view.unmount();
    });

    it('保存在途时守卫 resetDraft 不清稿；保存拒绝后草稿仍在', async () => {
        let handle: CenterWorkbenchDraftHandle | null = null;
        const saveGate = Promise.withResolvers<void>();
        const onSaveChapter = vi.fn(() => saveGate.promise);
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            onSaveChapter,
            onDraftControlReady: (h) => {
                handle = h;
            }
        });
        openEditorWithDraft(view, '在途期间不可被守卫清掉的草稿。');
        click(buttonByText(view.container, '保存并自动同步'));
        expect(handle).not.toBeNull();

        act(() => {
            handle?.resetDraft();
        });
        expect(editorTextarea(view.container).value).toBe('在途期间不可被守卫清掉的草稿。');

        await act(async () => {
            saveGate.reject(new Error('保存失败'));
            await saveGate.promise.catch(() => undefined);
        });
        expect(editorTextarea(view.container).value).toBe('在途期间不可被守卫清掉的草稿。');
        view.unmount();
    });
});

/** 真实 PlannerOutlineSchema 形状：不含 timeline_mode / pov_character */
const realPlannerOutline = {
    chapter_title: '旧城钟声',
    target_word_count: 3200,
    focus_cast: ['林澈', '顾遥'],
    background_cast: ['老掌柜'],
    ending_beat: 'HOOK',
    director_rationale: '推进主线冲突',
    chapter_turn: '主角发现钟声来自旧城',
    scene_plan: [
        { scene_index: 1, location: '城门', summary: '雪夜入城', is_spotlight: false },
        { scene_index: 2, location: '钟楼', summary: '钟声揭示旧城秘密', is_spotlight: true }
    ],
    outline_text: '雪夜入城，钟声引出旧城线索。'
};

function planPillText(container: HTMLElement, label: string): string {
    const pill = Array.from(container.querySelectorAll('.ns-plan-pill')).find((el) =>
        (el.textContent ?? '').trim().startsWith(label)
    );
    if (!pill) {
        throw new Error(`未找到细纲胶囊「${label}」`);
    }
    return (pill.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** dd 文本：取 dt 含指定 small 字段名的项 */
function planFieldText(container: HTMLElement, fieldName: string): string {
    const dl = container.querySelector('dl.ns-plan-kv');
    if (!dl) {
        throw new Error('细纲键值表未渲染');
    }
    const children = Array.from(dl.children);
    for (let i = 0; i < children.length - 1; i++) {
        const dt = children[i];
        const dd = children[i + 1];
        if (
            dt?.tagName === 'DT' &&
            dd?.tagName === 'DD' &&
            dt.querySelector('small')?.textContent === fieldName
        ) {
            return (dd.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
    }
    throw new Error(`未找到细纲字段「${fieldName}」`);
}

function mountPlanTab(detail: ChapterDetailData, timelineMode: string): MountedWorkbench {
    const view = mountWorkbench({ ...baseProps(detail), timelineMode });
    click(buttonByText(view.container, '本章细纲'));
    return view;
}

describe('细纲诚实呈现：缺失元数据不推断', () => {
    it('真实 PlannerOutline JSON 缺 timeline_mode/pov 时显示未提供，不冒充全局模式或首个焦点角色', () => {
        const view = mountPlanTab(
            {
                ...chapterOneDetail,
                outlineStatus: 'available',
                outlineText: JSON.stringify(realPlannerOutline)
            },
            'FLASHBACK'
        );
        expect(view.container.textContent).toContain('旧城钟声');
        expect(planPillText(view.container, 'timeline_mode')).toBe('timeline_mode 未提供');
        expect(planPillText(view.container, 'pov')).toBe('pov 未提供');
        expect(planFieldText(view.container, 'pov_character')).toBe('未提供');
        // 真实存在的字段仍正常展示
        expect(planFieldText(view.container, 'focus_cast')).toContain('林澈');
        expect(planFieldText(view.container, 'focus_cast')).toContain('顾遥');
        expect(planFieldText(view.container, 'background_cast')).toContain('老掌柜');
        expect(planPillText(view.container, 'target')).toContain('3,200 字');
        expect(planFieldText(view.container, 'spotlight')).toContain('钟声揭示旧城秘密');
        expect(planFieldText(view.container, 'outline_text')).toContain('雪夜入城，钟声引出旧城线索。');
        view.unmount();
    });

    it('全局 MAINLINE 也不冒充历史章时间线；POV 不从 focus_cast 推断', () => {
        const view = mountPlanTab(
            {
                ...chapterOneDetail,
                outlineStatus: 'available',
                outlineText: JSON.stringify(realPlannerOutline)
            },
            'MAINLINE'
        );
        expect(planPillText(view.container, 'timeline_mode')).toBe('timeline_mode 未提供');
        expect(planFieldText(view.container, 'pov_character')).not.toContain('林澈');
        view.unmount();
    });

    it('细纲真实带有 timeline_mode/pov 元数据时照常展示', () => {
        const view = mountPlanTab(
            {
                ...chapterOneDetail,
                outlineStatus: 'available',
                outlineText: JSON.stringify({
                    ...realPlannerOutline,
                    timeline_mode: 'FLASHBACK',
                    pov_character: '顾遥'
                })
            },
            'MAINLINE'
        );
        expect(planPillText(view.container, 'timeline_mode')).toBe('timeline_mode FLASHBACK');
        expect(planPillText(view.container, 'pov')).toBe('pov 顾遥');
        expect(planFieldText(view.container, 'pov_character')).toContain('顾遥');
        view.unmount();
    });

    it('Markdown/键值细纲缺时间线与视角时同样显示未提供', () => {
        const markdownOutline = [
            '标题: 旧城钟声',
            '焦点角色: 林澈、顾遥',
            '目标字数: 3200',
            '',
            '雪夜入城，钟声引出旧城线索。'
        ].join('\n');
        const view = mountPlanTab(
            {
                ...chapterOneDetail,
                outlineStatus: 'available',
                outlineText: markdownOutline
            },
            'FLASHBACK'
        );
        expect(view.container.textContent).toContain('旧城钟声');
        expect(planPillText(view.container, 'timeline_mode')).toBe('timeline_mode 未提供');
        expect(planFieldText(view.container, 'pov_character')).toBe('未提供');
        expect(planFieldText(view.container, 'focus_cast')).toContain('林澈');
        view.unmount();
    });
});

describe('Wave 4B 清样画布、3x2 矩阵、独立设定集与动效', () => {
    it('工具栏解耦「本章正文 | 本章细纲 | 改动对比」，无 .sim-bar，3x2 矩阵统一显示 4. Checker 并联动模型名', () => {
        const onSelectStageSession = vi.fn();
        const startViewTransitionSpy = vi.fn((cb: () => void) => {
            cb();
            return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
        });
        Object.defineProperty(document, 'startViewTransition', {
            configurable: true,
            value: startViewTransitionSpy
        });

        try {
            const view = mountWorkbench({
                ...baseProps({
                    ...chapterOneDetail,
                    featCommitSha: '81c4a9e',
                    content: '海风吹过三号栈桥。\n\n周敬山拨动算盘珠子。'
                }),
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
                        effectiveProvider: 'openai',
                        effectiveModel: 'gpt-4.1'
                    }
                ],
                poolRoutes: {
                    strong_creative: 'deepseek:deepseek-reasoner',
                    fast_retrieval: 'deepseek:deepseek-chat'
                },
                stages: {
                    WRITER: { status: 'active', summary: '正在执笔正文', sessionId: 'sess-w1' },
                    FACT_CHECKER: { status: 'done', summary: '核验通过', sessionId: 'sess-fc1' }
                },
                onSelectStageSession
            });

            expect(view.container.querySelector('.sim-bar')).toBeNull();
            const tabTexts = Array.from(
                view.container.querySelectorAll('.ns-seg-tabs [role="tab"]')
            ).map((el) => (el.textContent ?? '').trim());
            expect(tabTexts).toEqual(['本章正文', '本章细纲', '改动对比']);

            // 清样刊头、段号 P01、宣纸 SVG 滤镜、-4deg 定稿印与真实 SHA
            expect(view.container.querySelector('#ns-cinnabar-grain')).not.toBeNull();
            expect(view.container.querySelector('.ns-editorial-numeral')?.textContent).toBe('01');
            const folios = Array.from(view.container.querySelectorAll('.ns-prose-folio')).map((el) =>
                el.textContent?.trim()
            );
            expect(folios).toEqual(['P01', 'P02']);
            expect(view.container.querySelector('.ns-seal-stamp')?.textContent).toBe('定稿');
            expect(view.container.querySelector('.ns-editorial-endmark')?.textContent).toContain('81c4a9e');

            // 展开 3x2 工序矩阵
            const toggleBtn = view.container.querySelector<HTMLButtonElement>('.ns-pipeline-toggle-btn');
            expect(toggleBtn).not.toBeNull();
            click(toggleBtn!);

            const cards = Array.from(view.container.querySelectorAll<HTMLButtonElement>('.ns-pipe-card'));
            expect(cards).toHaveLength(6);
            const matrixText = view.container.querySelector('.ns-pipeline-drawer')?.textContent ?? '';
            expect(matrixText).toContain('1. Librarian');
            expect(matrixText).toContain('2. Planner');
            expect(matrixText).toContain('3. Writer');
            expect(matrixText).toContain('4. Checker');
            expect(matrixText).toContain('5. Extractor');
            expect(matrixText).toContain('6. Dreamer');
            expect(matrixText).not.toContain('Fact Check');
            expect(matrixText).toContain('openai:gpt-4.1');

            const writerCard = cards.find((c) => c.dataset.stageId === 'WRITER');
            expect(writerCard?.classList.contains('ns-running-live')).toBe(true);

            const checkerCard = cards.find((c) => c.dataset.stageId === 'FACT_CHECKER');
            click(checkerCard!);
            expect(startViewTransitionSpy).toHaveBeenCalled();
            expect(onSelectStageSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    stageId: 'FACT_CHECKER',
                    stageLabel: '4. Checker',
                    sessionId: 'sess-fc1'
                })
            );

            view.unmount();
        } finally {
            delete (document as unknown as Record<string, unknown>)['startViewTransition'];
        }
    });

    it('如实呈现 Patch 校勘签并支持跳转润色思考过程，0 章新书展示开卷扉页', () => {
        const onSelectStageSession = vi.fn();
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            stages: {
                WRITER: {
                    status: 'done',
                    sessionId: 'sess-patch-1',
                    sessions: [
                        { stage: 'WRITER', role: 'writer', sessionId: 'sess-writer-1', status: 'completed', attempt: 1 },
                        { stage: 'LOCAL_PATCH', role: 'patch', sessionId: 'sess-patch-1', status: 'completed', attempt: 2 }
                    ]
                }
            },
            gateViolations: [{ rule: 'filler_cliche', detail: '空气仿佛凝固了', patched: true }],
            onSelectStageSession
        });

        const colophon = view.container.querySelector('.ns-patch-colophon-bar');
        expect(colophon).not.toBeNull();
        expect(colophon?.textContent).toContain('校勘记录');
        click(buttonByText(colophon!, '查看润色思考过程 →'));
        expect(onSelectStageSession).toHaveBeenCalledWith(
            expect.objectContaining({
                stageId: 'WRITER',
                sessionId: 'sess-patch-1'
            })
        );

        // 0 章新书扉页
        view.rerender({
            chapters: [],
            chapterDetail: null,
            currentChapter: 0,
            selectedChapter: undefined
        });
        expect(view.container.querySelector('.ns-cover-sheet')?.textContent).toContain('开卷');
        view.unmount();
    });

    it('独立全书设定集视图解析实体四区与隐藏底牌，并区分 [WARPED] 与 [PENDING] 预案', () => {
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            externalViewCommand: { viewTab: 'views', materialKind: 'entities', nonce: 1 },
            materializedViews: {
                entities: [
                    {
                        entityId: 'char_chenyan',
                        canonicalName: '陈砚',
                        aliases: ['审计员'],
                        lastSeenChapter: 2,
                        markdown: [
                            '## 1. Innate Locks (先天红线)',
                            '- [vis: PUBLIC] 左腕旧骨折未愈',
                            '- [vis: OMNISCIENT_SECRET] 暗中奉命追查三年前沉船案',
                            '',
                            '## 2. Acquired State (后天状态)',
                            '- [vis: PUBLIC] 持有五号驳船过磅单',
                            '',
                            '## 3. Irreversible Trajectory (不可逆变迁)',
                            '- [ch:1] 登船封存五号驳船',
                            '',
                            '## 4. Recent Sliding Buffer & Voice (近期缓冲与声纹)',
                            '- 「封港夜里不过磅。」'
                        ].join('\n')
                    }
                ],
                horizonMarkdown: [
                    '- [event:evt_warped | day:1 | status:WARPED] 原定码头工人罢工冲突已作废',
                    '- [event:evt_pending | day:5 | status:ACTIVE] 东港三号冷库夹层藏有医疗器械'
                ].join('\n'),
                threadsMarkdown: '- [thread_01] 五号驳船吃水线异常'
            }
        });

        expect(view.container.textContent).toContain('《示例作品》全书设定集');
        expect(view.container.textContent).toContain('写手不可见');
        expect(view.container.textContent).toContain('左腕旧骨折未愈');
        expect(view.container.textContent).toContain('持有五号驳船过磅单');

        click(buttonByText(view.container, '剧情预案与废案 (2)'));
        expect(view.container.textContent).toContain('已推翻隔离的旧预案');
        expect(view.container.textContent).toContain('原定码头工人罢工冲突已作废');
        expect(view.container.textContent).toContain('待推进的后续伏脉预案');
        expect(view.container.textContent).toContain('东港三号冷库夹层藏有医疗器械');

        const backBtn = buttonByText(view.container, '返回第 1 章正文');
        expect(backBtn.querySelector('svg')).not.toBeNull();
        click(backBtn);
        expect(view.container.querySelector('.ns-prose-body')).not.toBeNull();
        view.unmount();
    });

    it('WAAPI 新章段落显影在切章或卸载时自动 cancel() 清理动画句柄', () => {
        const cancelSpy = vi.fn();
        const animateSpy = vi.fn(() => ({ cancel: cancelSpy }) as unknown as Animation);
        const origAnimate = HTMLElement.prototype.animate;
        HTMLElement.prototype.animate = animateSpy;
        try {
            const view = mountWorkbench({
                ...baseProps(chapterOneDetail),
                revealNonce: 1
            });
            expect(animateSpy).toHaveBeenCalled();
            view.unmount();
            expect(cancelSpy).toHaveBeenCalled();
        } finally {
            HTMLElement.prototype.animate = origAnimate;
        }
    });
});

describe('Wave 4B 双模式冲突裁决卡、走向建议、便签舱与防重入锁', () => {
    it('已落盘跨章冲突 (sync_conflicts) 展示双侧行号引文并触发 heal/改稿/便签', () => {
        const onHealConflicts = vi.fn();
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            syncConflict: {
                conflictId: 'conf-arm-1',
                description: '左腕骨折未愈却单手推开重门',
                leftRef: 'entities/char_chenyan.md',
                leftLine: 12,
                leftExcerpt: '左腕旧骨折未愈，无法单手推举重物',
                rightRef: 'ch_0001.md',
                rightLine: 2,
                rightExcerpt: '陈砚抬起完好无损的左手推开账房木门。',
                affectedChapters: 2,
                affectedWords: 6120
            },
            onHealConflicts
        });

        const card = view.container.querySelector('[data-conflict-mode="sync_conflicts"]');
        expect(card).not.toBeNull();
        expect(card?.textContent).toContain('L12');
        expect(card?.textContent).toContain('L2');
        expect(card?.textContent).toContain('波及 2 章');
        expect(card?.textContent).toContain('6,120 字');

        click(buttonByText(card!, '处理本条冲突（可能按作品限额回滚重跑）'));
        expect(onHealConflicts).toHaveBeenCalledTimes(1);

        click(buttonByText(card!, '我自己动手改稿'));
        expect(view.container.querySelector('textarea.ns-editor-textarea')).not.toBeNull();

        click(buttonByText(card!, '写条便签解释原因'));
        expect(view.container.querySelector('.ns-note-kind-btn')?.textContent).toContain('圆谎修补');
        view.unmount();
    });

    it('未落盘新章拦截 (safe_halt) 展示 issues 与门禁明细，绝不渲染直接改稿或自愈按钮', () => {
        const onSubmitSignal = vi.fn();
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            safeHalt: {
                reason: '第 2 章新草稿存在时间线穿帮',
                stage: 'FACT_CHECK',
                chapter: 2,
                affectedChapters: 1,
                issues: [
                    {
                        rule: 'timeline_order',
                        line: 8,
                        sourceRef: 'ch_0001.md',
                        sourceQuote: '夜班交接尚未开始',
                        quote: '天亮后已查验完所有过磅单',
                        detail: '时间线早于前一章锚点'
                    }
                ]
            },
            gateViolations: [{ rule: 'micro_anatomy', line: 14, detail: '含违禁微距词' }],
            onSubmitSignal
        });

        const card = view.container.querySelector('[data-conflict-mode="safe_halt"]');
        expect(card).not.toBeNull();
        expect(card?.textContent).toContain('timeline_order');
        expect(card?.textContent).toContain('时间线早于前一章锚点');
        expect(card?.textContent).toContain('micro_anatomy');
        expect(card?.textContent).toContain('含违禁微距词');
        expect(card?.textContent).not.toContain('我自己动手改稿');
        expect(card?.textContent).not.toContain('处理本条冲突');

        click(buttonByText(card!, '带上微调便签重写本章'));
        expect(onSubmitSignal).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'RETCON',
                runAfter: true
            })
        );
        view.unmount();
    });

    it('纵向走向建议支持填入微调与直接写，顶部写下一章具同步防重入锁且不硬传泛化 goal', async () => {
        const stepGate = Promise.withResolvers<void>();
        const onStepOne = vi.fn(() => stepGate.promise);
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            nextChapterOptions: ['陈砚当面对质周敬山', '潜入东港冷库查验封条'],
            onStepOne
        });

        // 未填便签直接点「写下一章」不传泛化 goal；连续点击仅发出 1 次请求
        const stepBtn = buttonByText(view.container, '写下一章');
        click(stepBtn);
        click(stepBtn);
        expect(onStepOne).toHaveBeenCalledTimes(1);
        expect(onStepOne).toHaveBeenCalledWith(undefined);

        await act(async () => {
            stepGate.resolve();
            await stepGate.promise;
        });

        // 展开走向建议：点文字填入，点直接写传 goal
        click(view.container.querySelector<HTMLButtonElement>('.ns-next-ideas-header')!);
        const ideaTexts = Array.from(
            view.container.querySelectorAll<HTMLButtonElement>('.ns-next-idea-text')
        );
        expect(ideaTexts).toHaveLength(2);
        click(ideaTexts[0]!);
        const noteInput = view.container.querySelector<HTMLInputElement>('.ns-note-input')!;
        expect(noteInput.value).toBe('陈砚当面对质周敬山');

        const goBtns = Array.from(
            view.container.querySelectorAll<HTMLButtonElement>('.ns-next-idea-go')
        );
        click(goBtns[1]!);
        expect(onStepOne).toHaveBeenLastCalledWith({ chapterGoal: '潜入东港冷库查验封条' });
        view.unmount();
    });

    it('便签舱精确构造 4 类导演信号（含切换视角 entityId 与插入回忆 targetDay），运行态支持强停撤回草稿', async () => {
        const onSubmitSignal = vi.fn();
        const onRequestHalt = vi.fn();
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            materializedViews: {
                entities: [
                    { entityId: 'char_chen', canonicalName: '陈砚', markdown: '' },
                    { entityId: 'char_zhou', canonicalName: '周敬山', markdown: '' }
                ]
            },
            onSubmitSignal,
            onRequestHalt
        });

        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        const setInput = (el: HTMLInputElement, val: string) => {
            act(() => {
                inputSetter?.call(el, val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
        };
        const asyncClick = async (el: HTMLElement) => {
            await act(async () => {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
        };

        const noteInput = view.container.querySelector<HTMLInputElement>('.ns-note-input')!;

        // 0. 剧情微调 -> DIRECTOR_NOTE
        setInput(noteInput, '把冲突提前到栈桥');
        await asyncClick(buttonByText(view.container, '先存便签'));
        expect(onSubmitSignal).toHaveBeenLastCalledWith({
            kind: 'DIRECTOR_NOTE',
            content: '把冲突提前到栈桥',
            runAfter: false
        });

        // 1. 切换视角 -> SPOTLIGHT_TRIGGER + entityId
        await asyncClick(view.container.querySelector<HTMLButtonElement>('.ns-note-kind-btn')!);
        await asyncClick(menuItemByTitle(view.container, '切换视角'));
        const entitySelect = view.container.querySelector<HTMLSelectElement>('select[aria-label="选择切镜人物"]')!;
        act(() => {
            entitySelect.value = 'char_zhou';
            entitySelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
        setInput(noteInput, '切入周敬山密室视角');
        await asyncClick(buttonByText(view.container, '先存便签'));
        expect(onSubmitSignal).toHaveBeenLastCalledWith({
            kind: 'SPOTLIGHT_TRIGGER',
            entityId: 'char_zhou',
            content: '切入周敬山密室视角',
            runAfter: false
        });

        // 2. 插入回忆 -> FLASHBACK + targetDay
        await asyncClick(view.container.querySelector<HTMLButtonElement>('.ns-note-kind-btn')!);
        await asyncClick(menuItemByTitle(view.container, '插入回忆'));
        const dayInput = view.container.querySelector<HTMLInputElement>('input[aria-label="回忆目标天数"]')!;
        setInput(dayInput, '3');
        setInput(noteInput, '回忆三年前沉船夜');
        await asyncClick(view.container.querySelector<HTMLButtonElement>('button[aria-label="存入便签并立即写下一章"]')!);
        expect(onSubmitSignal).toHaveBeenLastCalledWith({
            kind: 'FLASHBACK',
            targetDay: 3,
            content: '回忆三年前沉船夜',
            runAfter: true
        });

        // 3. 圆谎修补 -> RETCON
        await asyncClick(view.container.querySelector<HTMLButtonElement>('.ns-note-kind-btn')!);
        await asyncClick(menuItemByTitle(view.container, '圆谎修补'));
        setInput(noteInput, '左腕用护腕固定');
        await asyncClick(buttonByText(view.container, '先存便签'));
        expect(onSubmitSignal).toHaveBeenLastCalledWith({
            kind: 'RETCON',
            content: '左腕用护腕固定',
            runAfter: false
        });

        // 4. 运行态强停菜单 -> onRequestHalt({ force: true }) 且状态胶囊使用中文创作态文案
        view.rerender({ activeTask: 'STEPPING' });
        const topHeaderText = view.container.querySelector('.ns-header-left')?.textContent ?? '';
        expect(topHeaderText).toContain('正在执笔推进');
        expect(topHeaderText).not.toContain('STEPPING');
        await asyncClick(view.container.querySelector<HTMLButtonElement>('button[aria-label="更多停止选项"]')!);
        await asyncClick(menuItemByTitle(view.container, '立即中断并撤回半截草稿'));
        expect(onRequestHalt).toHaveBeenCalledWith({ force: true });
        view.unmount();
    });

    it('全书设定集切换页签与返回正文时同步触发 onCodexTabChange 与 onCloseCodex', () => {
        const onCodexTabChange = vi.fn();
        const onCloseCodex = vi.fn();
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            externalViewCommand: { viewTab: 'views', materialKind: 'entities', nonce: 1 },
            onCodexTabChange,
            onCloseCodex
        });

        click(buttonByText(view.container, '未解伏笔 (0)'));
        expect(onCodexTabChange).toHaveBeenCalledWith('threads');

        click(buttonByText(view.container, '返回第 1 章正文'));
        expect(onCloseCodex).toHaveBeenCalledTimes(1);
        view.unmount();
    });

    it('无书态中栏扉页主按钮为开启新作品并触发 onNewBook 打开 BootBookModal', () => {
        const onNewBook = vi.fn();
        const onStepOne = vi.fn();
        const view = mountWorkbench({
            currentBookRoot: '',
            bookTitle: '',
            bookSlug: '',
            currentChapter: 0,
            chapters: [],
            chapterDetail: null,
            onNewBook,
            onStepOne
        });

        const cover = view.container.querySelector('.ns-cover-sheet');
        expect(cover).not.toBeNull();
        expect(cover?.textContent).not.toContain('写第 1 章');
        click(buttonByText(cover!, '开启新作品'));
        expect(onNewBook).toHaveBeenCalledTimes(1);
        expect(onStepOne).not.toHaveBeenCalled();
        view.unmount();
    });

    it('DirectorNoteDock 支持 placeholder 斜杠提示、下拉菜单命令标注及键盘 ArrowUp/ArrowDown/Enter/Tab 选指令并清空前缀', () => {
        const onSubmitSignal = vi.fn();
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            materializedViews: {
                entities: [{ entityId: 'char_chen', canonicalName: '陈砚', markdown: '' }]
            },
            onSubmitSignal
        });

        const noteInput = view.container.querySelector<HTMLInputElement>('.ns-note-input')!;
        expect(noteInput.placeholder).toContain('/plot');
        expect(noteInput.placeholder).toContain('/spotlight');
        expect(noteInput.placeholder).toContain('/flashback');
        expect(noteInput.placeholder).toContain('/retcon');

        // 菜单按钮展开项同步标注 /plot 等命令名
        click(view.container.querySelector<HTMLButtonElement>('.ns-note-kind-btn')!);
        const menuText = view.container.querySelector('[role="menu"][aria-label="选择便签类型"]')?.textContent ?? '';
        expect(menuText).toContain('/plot');
        expect(menuText).toContain('/spotlight');
        expect(menuText).toContain('/flashback');
        expect(menuText).toContain('/retcon');
        click(view.container.querySelector<HTMLButtonElement>('.ns-note-kind-btn')!);

        // 输入 / 呼出斜杠联想菜单，ArrowDown 切换高亮，Enter 选中指令并清空前缀且不提交
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        act(() => {
            inputSetter?.call(noteInput, '/');
            noteInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(view.container.querySelector('.ns-slash-menu')).not.toBeNull();

        act(() => {
            noteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        });
        const items = Array.from(view.container.querySelectorAll<HTMLButtonElement>('.ns-slash-item'));
        expect(items[1]?.classList.contains('is-active')).toBe(true);
        expect(items[1]?.getAttribute('aria-selected')).toBe('true');

        act(() => {
            noteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        expect(onSubmitSignal).not.toHaveBeenCalled();
        expect(noteInput.value).toBe('');
        expect(view.container.querySelector('.ns-note-kind-btn')?.textContent).toContain('切换视角');

        // 输入 /ret 后按 Tab 也能选中 /retcon 并清空前缀
        act(() => {
            inputSetter?.call(noteInput, '/ret');
            noteInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        act(() => {
            noteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        });
        expect(onSubmitSignal).not.toHaveBeenCalled();
        expect(noteInput.value).toBe('');
        expect(view.container.querySelector('.ns-note-kind-btn')?.textContent).toContain('圆谎修补');
        view.unmount();
    });
});

/** 提取指定 CSS 选择器的规则体（支持同名多块合并检查） */
function extractCssRuleBodies(cssText: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(cssText)) !== null) {
        matches.push(match[1] ?? '');
    }
    return matches.join('\n');
}

describe('Studio 前端回归修复 (BUG-01 / BUG-02 / BUG-05 / BUG-06)', () => {
    it('BUG-01 & BUG-06: 关键滚动容器、浮层、弹窗弹性链与顶栏/6 节点卡片样式约束完备', () => {
        const sheetRule = extractCssRuleBodies(STUDIO_CSS, '.ns-manuscript-sheet');
        expect(sheetRule).toContain('flex-shrink: 0;');

        const menuPopRule = extractCssRuleBodies(STUDIO_CSS, '.ns-menu-pop');
        expect(menuPopRule).toContain('max-height: min(60vh, 420px);');
        expect(menuPopRule).toContain('overflow-y: auto;');
        expect(menuPopRule).toContain('overscroll-behavior: contain;');

        const sessionEmptyRule = extractCssRuleBodies(STUDIO_CSS, '.ns-session-empty');
        expect(sessionEmptyRule).toContain('overflow-y: auto;');

        const modalFormRule = extractCssRuleBodies(BOOT_CSS, '.ns-b-modal-content > form');
        expect(modalFormRule).toContain('display: flex;');
        expect(modalFormRule).toContain('flex-direction: column;');
        expect(modalFormRule).toContain('flex: 1;');
        expect(modalFormRule).toContain('min-height: 0;');
        expect(extractCssRuleBodies(BOOT_CSS, '.ns-modal-head')).toContain('flex-shrink: 0;');
        expect(extractCssRuleBodies(BOOT_CSS, '.ns-b-steps')).toContain('flex-shrink: 0;');
        expect(extractCssRuleBodies(BOOT_CSS, '.ns-modal-foot')).toContain('flex-shrink: 0;');

        const headerLeftRule = extractCssRuleBodies(STUDIO_CSS, '.ns-header-left');
        expect(headerLeftRule).toContain('flex: 1 1 auto;');
        expect(headerLeftRule).toContain('min-width: 0;');
        expect(headerLeftRule).not.toContain('overflow: hidden;');

        expect(extractCssRuleBodies(STUDIO_CSS, '.ns-header-right')).toContain('flex-shrink: 0;');
        expect(extractCssRuleBodies(STUDIO_CSS, '.ns-header-book-wrap')).toContain('min-width: 0;');

        const bookSwitcherRule = extractCssRuleBodies(STUDIO_CSS, '.ns-book-switcher');
        expect(bookSwitcherRule).toContain('max-width: 100%;');
        expect(bookSwitcherRule).toContain('min-width: 0;');
        expect(bookSwitcherRule).toContain('white-space: nowrap;');

        const stepNameRule = extractCssRuleBodies(STUDIO_CSS, '.ns-pipe-step-name');
        expect(stepNameRule).toContain('min-width: 0;');
        expect(stepNameRule).toContain('flex: 1 1 auto;');
        expect(stepNameRule).toContain('overflow: hidden;');
        expect(stepNameRule).toContain('text-overflow: ellipsis;');
        expect(stepNameRule).toContain('white-space: nowrap;');

        const stepStateRule = extractCssRuleBodies(STUDIO_CSS, '.ns-pipe-step-state');
        expect(stepStateRule).toContain('white-space: nowrap;');
        expect(stepStateRule).toContain('flex-shrink: 0;');
    });

    it('BUG-02: 新书 0 章开写第 1 章期间挂载流水线胶囊并自动展开 6 节点抽屉，允许运行中手动收起', () => {
        const view = mountWorkbench({
            bookTitle: '开卷测试作品',
            currentBookRoot: '/books/fresh',
            currentChapter: 0,
            chapters: [],
            chapterDetail: null,
            activeTask: 'IDLE'
        });

        // 0 章空闲态不挂载工具栏
        expect(view.container.querySelector('.ns-reader-toolbar-wrap')).toBeNull();

        // 进入推章态 -> 自动挂载流水线胶囊、左侧状态标识（无直接改稿按钮）并自动展开 6 节点抽屉
        view.rerender({
            activeTask: 'STEPPING',
            latestSseStage: 'PLANNER'
        });
        const toolbar = view.container.querySelector('.ns-reader-toolbar-wrap');
        expect(toolbar).not.toBeNull();
        expect(toolbar?.querySelector('.ns-reader-status-label')?.textContent).toContain('正在生成第 1 章');
        expect(toolbar?.textContent).not.toContain('直接改稿');

        const toggleBtn = toolbar?.querySelector<HTMLButtonElement>('.ns-pipeline-toggle-btn');
        expect(toggleBtn?.getAttribute('aria-expanded')).toBe('true');
        expect(view.container.querySelectorAll('.ns-pipe-card')).toHaveLength(6);

        // 运行期间用户手动收起后，阶段推进不得再次强行弹开
        click(toggleBtn!);
        expect(toggleBtn?.getAttribute('aria-expanded')).toBe('false');
        expect(view.container.querySelector('.ns-pipeline-drawer')).toBeNull();

        view.rerender({
            activeTask: 'STEPPING',
            latestSseStage: 'WRITER'
        });
        expect(toggleBtn?.getAttribute('aria-expanded')).toBe('false');
        expect(view.container.querySelector('.ns-pipeline-drawer')).toBeNull();

        // 组件直接以推章态挂载时初始即展开 6 节点抽屉
        view.unmount();
        const liveMount = mountWorkbench({
            bookTitle: '开卷测试作品',
            currentBookRoot: '/books/fresh',
            currentChapter: 0,
            chapters: [],
            chapterDetail: null,
            activeTask: 'STEPPING'
        });
        expect(
            liveMount.container.querySelector('.ns-pipeline-toggle-btn')?.getAttribute('aria-expanded')
        ).toBe('true');
        expect(liveMount.container.querySelectorAll('.ns-pipe-card')).toHaveLength(6);
        liveMount.unmount();
    });

    it('BUG-05: WRITER 与 LOCAL_PATCH 并存时，历史态点击 3. Writer 默认看 Writer 原稿，实时 Patch 态看 Patch，校勘条精准看 Patch', () => {
        const onSelectStageSession = vi.fn();

        // 纯函数边界验证
        expect(
            resolvePrimaryStageSession('WRITER', {
                status: 'done',
                sessionId: 'sess-patch-1',
                sessions: [
                    { stage: 'WRITER', role: 'writer', sessionId: 'sess-writer-1', status: 'completed', attempt: 1 },
                    { stage: 'LOCAL_PATCH', role: 'patch', sessionId: 'sess-patch-1', status: 'completed', attempt: 2 }
                ]
            })?.sessionId
        ).toBe('sess-writer-1');
        expect(
            resolvePrimaryStageSession('WRITER', {
                status: 'healing',
                sessionId: 'sess-patch-live',
                sessions: [
                    { stage: 'WRITER', role: 'writer', sessionId: 'sess-writer-1', status: 'completed', attempt: 1 },
                    { stage: 'LOCAL_PATCH', role: 'patch', sessionId: 'sess-patch-live', status: 'running', attempt: 2 }
                ]
            })?.sessionId
        ).toBe('sess-patch-live');

        // 1. 历史完成态：3. Writer 卡片默认指向 sess-writer-1，校勘条仍指向 sess-patch-1
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            stages: {
                WRITER: {
                    status: 'done',
                    sessionId: 'sess-patch-1',
                    sessions: [
                        { stage: 'WRITER', role: 'writer', sessionId: 'sess-writer-1', status: 'completed', attempt: 1 },
                        { stage: 'LOCAL_PATCH', role: 'patch', sessionId: 'sess-patch-1', status: 'completed', attempt: 2 }
                    ]
                }
            },
            gateViolations: [{ rule: 'filler_cliche', detail: '空气仿佛凝固了', patched: true }],
            onSelectStageSession
        });

        click(view.container.querySelector<HTMLButtonElement>('.ns-pipeline-toggle-btn')!);
        const writerCard = view.container.querySelector<HTMLButtonElement>(
            '.ns-pipe-card[data-stage-id="WRITER"]'
        )!;
        expect(writerCard.dataset.sessionId).toBe('sess-writer-1');
        click(writerCard);
        expect(onSelectStageSession).toHaveBeenLastCalledWith(
            expect.objectContaining({
                stageId: 'WRITER',
                sessionId: 'sess-writer-1'
            })
        );

        // 校勘条继续打开 Patch 会话
        click(buttonByText(view.container.querySelector('.ns-patch-colophon-bar')!, '查看润色思考过程 →'));
        expect(onSelectStageSession).toHaveBeenLastCalledWith(
            expect.objectContaining({
                stageId: 'WRITER',
                sessionId: 'sess-patch-1'
            })
        );

        // 2. 实时 Patch 运行态：点击 3. Writer 优先看正在运行的 Patch 会话
        view.rerender({
            stages: {
                WRITER: {
                    status: 'healing',
                    sessionId: 'sess-patch-live',
                    sessions: [
                        { stage: 'WRITER', role: 'writer', sessionId: 'sess-writer-1', status: 'completed', attempt: 1 },
                        { stage: 'LOCAL_PATCH', role: 'patch', sessionId: 'sess-patch-live', status: 'running', attempt: 2 }
                    ]
                }
            }
        });
        expect(writerCard.dataset.sessionId).toBe('sess-patch-live');
        click(writerCard);
        expect(onSelectStageSession).toHaveBeenLastCalledWith(
            expect.objectContaining({
                stageId: 'WRITER',
                sessionId: 'sess-patch-live'
            })
        );
        view.unmount();
    });

    it('BUG-06: 中栏顶栏书名与窄屏目录按钮具备完整悬停 title 与单行省略结构', () => {
        const longTitle = '一本名字特别长特别长会在 1280 宽度下导致溢出遮挡右栏的作品';
        const view = mountWorkbench({
            ...baseProps(chapterOneDetail),
            bookTitle: longTitle,
            showCompactNav: true
        });

        const bookWrap = view.container.querySelector('.ns-header-book-wrap');
        expect(bookWrap).not.toBeNull();
        const switcher = bookWrap?.querySelector<HTMLButtonElement>('.ns-book-switcher');
        expect(switcher?.title).toBe(`《${longTitle}》`);
        expect(switcher?.querySelector('.ns-book-switcher-title')?.textContent).toBe(`《${longTitle}》`);

        const tocWrap = view.container.querySelector('.ns-header-toc-wrap');
        expect(tocWrap?.querySelector('.ns-compact-toc-btn')?.getAttribute('title')).toContain('目录与设定集');
        expect(tocWrap?.querySelector('.ns-compact-toc-label')?.textContent).toContain('目录与设定集');
        view.unmount();
    });
});

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
    type CenterWorkbenchDraftHandle,
    type CenterWorkbenchProps,
    type ChapterDetailData
} from '../src/client/CenterWorkbench.js';

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
    click(buttonByText(view.container, '✎ 编辑'));
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
        view.rerender({ selectedChapter: 2 });
        expect(editorTextarea(view.container).value).toBe('第一章的未保存修订。');

        click(buttonByText(view.container, '保存并自动 Sync'));
        expect(onSaveChapter).toHaveBeenCalledTimes(1);
        expect(onSaveChapter).toHaveBeenCalledWith(1, '第一章的未保存修订。');

        await act(async () => {
            saveGate.resolve();
            await saveGate.promise;
        });
        expect(view.container.textContent).toContain('已保存 Ch.0001');
        expect(view.container.querySelector('textarea.ns-editor-textarea')).toBeNull();
        view.unmount();
    });

    it('保存在途时按钮禁用并显示进度文案，重复点击不产生第二次 PUT', async () => {
        const saveGate = Promise.withResolvers<void>();
        const onSaveChapter = vi.fn(() => saveGate.promise);
        const view = mountWorkbench({ ...baseProps(chapterOneDetail), onSaveChapter });
        openEditorWithDraft(view, '在途保存草稿。');

        click(buttonByText(view.container, '保存并自动 Sync'));
        const busyButton = buttonByText(view.container, '正在保存并 Sync…');
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

        click(buttonByText(view.container, '保存并自动 Sync'));
        await act(async () => {
            saveGate.reject(new Error('事务锁被占用'));
            await saveGate.promise.catch(() => undefined);
        });

        expect(view.container.textContent).toContain('事务锁被占用');
        expect(view.container.textContent).not.toContain('已保存 Ch.0001');
        expect(editorTextarea(view.container).value).toBe('必须保留的失败草稿。');
        expect(textarea.isConnected).toBe(true);
        const retryButton = buttonByText(view.container, '保存并自动 Sync');
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
        click(buttonByText(view.container, '保存并自动 Sync'));
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
    click(buttonByText(view.container, '细纲'));
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
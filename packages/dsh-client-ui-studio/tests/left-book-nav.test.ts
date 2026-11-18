// @vitest-environment jsdom
/**
 * LeftBookNav、BootBookModal 引导条、StudioActionModals 与样式令牌回归测试。
 * 使用真实 React 渲染与 DOM 事件驱动，不 mock 被测组件内部实现。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LeftBookNav, type LeftBookNavProps } from '../src/client/LeftBookNav.js';
import { BootBookModal } from '../src/client/BootBookModal.js';
import { AdvanceVolumeModal, ParallelWindowModal } from '../src/client/StudioActionModals.js';
import { STUDIO_CSS } from '../src/client/styles.js';
import { INSPECTOR_CSS } from '../src/client/inspector-styles.js';
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

const mountedRoots: Root[] = [];

afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
        act(() => root.unmount());
    }
    document.body.replaceChildren();
});

function mountElement(element: React.ReactElement): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(element);
    });
    return container;
}

function click(el: HTMLElement): void {
    act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
}

function baseNavProps(overrides: Partial<LeftBookNavProps> = {}): LeftBookNavProps {
    return {
        currentBookRoot: '/books/port-audit',
        currentTitle: '港口审计',
        currentSlug: 'port-audit',
        chapterCount: 3,
        storyDay: 4,
        walPhase: 'IDLE',
        books: [
            {
                bookRoot: '/books/port-audit',
                slug: 'port-audit',
                title: '港口审计',
                currentChapter: 3,
                storyDay: 4,
                walPhase: 'IDLE'
            }
        ],
        chapters: [
            {
                chapterNumber: 1,
                fileName: 'ch-01.md',
                title: '五号驳船封条',
                charCount: 3180,
                sha256: 'sha1',
                dirty: false,
                commitSha: 'c1',
                volumeLabel: '第一卷 · 寒潮封港'
            },
            {
                chapterNumber: 2,
                fileName: 'ch-02.md',
                title: '夜账缺页',
                charCount: 2940,
                sha256: 'sha2',
                dirty: true,
                commitSha: 'c2',
                volumeLabel: '第一卷 · 寒潮封港'
            },
            {
                chapterNumber: 3,
                fileName: 'ch-03.md',
                title: '冷库铅锁',
                charCount: 1850,
                sha256: 'sha3',
                dirty: false,
                commitSha: null,
                conflict: true,
                volumeLabel: '第一卷 · 寒潮封港'
            }
        ],
        selectedChapter: 1,
        entityCount: 5,
        coldArchiveCount: 2,
        warpedHorizonCount: 1,
        openThreadsCount: 3,
        activeViewKind: null,
        onSelectBook: vi.fn(),
        onNewBook: vi.fn(),
        onSelectChapter: vi.fn(),
        onOpenView: vi.fn(),
        ...overrides
    };
}

describe('LeftBookNav 东方清样左栏导航', () => {
    it('顶部展示当前卷名与故事天数，中部章节列表展示章号、标题与字数/已改/冲突胶囊', () => {
        const onSelectChapter = vi.fn();
        const container = mountElement(createElement(LeftBookNav, baseNavProps({ onSelectChapter })));

        const volBar = container.querySelector('.ns-left-vol-bar');
        expect(volBar).not.toBeNull();
        expect(volBar?.textContent).toContain('第一卷 · 寒潮封港');
        expect(volBar?.textContent).toContain('第 4 天');

        const chItems = Array.from(container.querySelectorAll<HTMLButtonElement>('.ns-ch-item'));
        expect(chItems).toHaveLength(3);
        expect(chItems[0]?.textContent).toContain('第 1 章');
        expect(chItems[0]?.textContent).toContain('五号驳船封条');
        expect(chItems[0]?.textContent).toContain('3180');
        expect(chItems[0]?.classList.contains('ns-active')).toBe(true);

        expect(chItems[1]?.textContent).toContain('夜账缺页');
        expect(chItems[1]?.textContent).toContain('已改');

        expect(chItems[2]?.textContent).toContain('冷库铅锁');
        expect(chItems[2]?.textContent).toContain('冲突');

        click(chItems[1]!);
        expect(onSelectChapter).toHaveBeenCalledWith(2);
    });

    it('底部固定全书设定集三入口并触发对应跨章视图回调', () => {
        const onOpenView = vi.fn();
        const container = mountElement(
            createElement(
                LeftBookNav,
                baseNavProps({
                    activeViewKind: 'threads',
                    pendingHorizonCount: 2,
                    onOpenView
                })
            )
        );

        const codex = container.querySelector('.ns-left-codex');
        expect(codex).not.toBeNull();
        expect(codex?.textContent).toContain('全书设定集（跨章汇总）');

        const rows = Array.from(codex!.querySelectorAll<HTMLButtonElement>('.ns-codex-row'));
        expect(rows).toHaveLength(3);
        expect(rows[0]?.textContent).toContain('人物与物品档案');
        expect(rows[0]?.textContent).toContain('5');
        expect(rows[0]?.textContent).toContain('2');

        expect(rows[1]?.textContent).toContain('未解伏笔清单');
        expect(rows[1]?.textContent).toContain('3');
        expect(rows[1]?.classList.contains('ns-active')).toBe(true);

        expect(rows[2]?.textContent).toContain('剧情预案与废案');
        expect(rows[2]?.textContent).toContain('3');

        click(rows[0]!);
        click(rows[2]!);
        expect(onOpenView).toHaveBeenNthCalledWith(1, 'entities');
        expect(onOpenView).toHaveBeenNthCalledWith(2, 'horizon');
    });

    it('支持嵌入式兼容模式，保留旧版 .ns-ch-btn 与 .ns-ch-code 供未升级宿主过渡', () => {
        const container = mountElement(createElement(LeftBookNav, baseNavProps({ embedded: true })));
        const chBtn = container.querySelector('button.ns-ch-btn');
        expect(chBtn?.querySelector('.ns-ch-code')?.textContent?.trim()).toBe('Ch.0001');
    });
});

describe('BootBookModal 主对话开书构思引导横幅', () => {
    it('顶部展示推荐切回主对话使用 /narrate-boot 构思契约的引导条并可触发切回回调', () => {
        const onSwitchToChatBootHint = vi.fn();
        const onClose = vi.fn();
        mountElement(
            createElement(BootBookModal, {
                open: true,
                onClose,
                onSwitchToChatBootHint
            })
        );

        const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="开新书编译引导"]');
        expect(dialog).not.toBeNull();

        const guide = dialog!.querySelector('.ns-b-chat-guide');
        expect(guide).not.toBeNull();
        expect(guide?.textContent).toContain('/narrate-boot');

        const switchBtn = Array.from(guide!.querySelectorAll('button')).find((b) =>
            b.textContent?.includes('切回主对话')
        );
        expect(switchBtn).toBeDefined();
        click(switchBtn!);
        expect(onSwitchToChatBootHint).toHaveBeenCalledTimes(1);
    });
});

describe('StudioActionModals 换卷封存与多线并行弹窗', () => {
    it('AdvanceVolumeModal 支持勾选随行核心人物与开启 completeBook 完结封笔', () => {
        const onConfirm = vi.fn();
        const onClose = vi.fn();
        mountElement(
            createElement(AdvanceVolumeModal, {
                open: true,
                currentVolumeLabel: '第一卷 · 寒潮封港',
                entities: [
                    { id: 'char_chen', name: '陈砚', role: '主角' },
                    { id: 'char_zhou', name: '周敬山', role: '账房' }
                ],
                onClose,
                onConfirm
            })
        );

        const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="结束本卷 / 开启下一卷"]');
        expect(dialog).not.toBeNull();

        const checkboxes = Array.from(dialog!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
        // 前 2 个为随行人物，默认勾选；最后一个为 completeBook 完结封笔开关
        expect(checkboxes.length).toBe(3);
        expect(checkboxes[0]?.checked).toBe(true);
        expect(checkboxes[1]?.checked).toBe(true);
        expect(checkboxes[2]?.checked).toBe(false);

        // 取消勾选 char_zhou，勾选 completeBook
        act(() => {
            checkboxes[1]!.click();
            checkboxes[2]!.click();
        });
        expect(dialog!.textContent).toContain('不再开启下一卷');

        const confirmBtn = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find(
            (b) => b.type === 'submit' || b.textContent?.includes('完结封笔')
        );
        expect(confirmBtn).toBeDefined();
        click(confirmBtn!);

        expect(onConfirm).toHaveBeenCalledWith({
            companionEntityIds: ['char_chen'],
            completeBook: true
        });
    });

    it('ParallelWindowModal 校验 windowId 格式并支持分叉与合流回主线', () => {
        const onFork = vi.fn();
        const onMerge = vi.fn();
        const onClose = vi.fn();

        mountElement(
            createElement(ParallelWindowModal, {
                open: true,
                parallelActive: true,
                activeWindowId: 'win-dock-night',
                activeBranchId: 'branch-a',
                onClose,
                onFork,
                onMerge
            })
        );

        const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="多线并行章节窗口"]');
        expect(dialog).not.toBeNull();

        const windowInput = dialog!.querySelector<HTMLInputElement>('input[name="windowId"]');
        expect(windowInput).not.toBeNull();
        expect(windowInput?.value).toBe('win-dock-night');

        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        act(() => {
            inputSetter?.call(windowInput!, '非法 窗口');
            windowInput!.dispatchEvent(new Event('input', { bubbles: true }));
            windowInput!.dispatchEvent(new Event('change', { bubbles: true }));
        });

        const forkBtn = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
            b.textContent?.includes('继续写') || b.textContent?.includes('开启并行分叉')
        );
        expect(forkBtn).toBeDefined();
        click(forkBtn!);
        expect(onFork).not.toHaveBeenCalled();
        expect(dialog!.querySelector('[role="alert"]')?.textContent).toContain('字母、数字、下划线');

        act(() => {
            inputSetter?.call(windowInput!, 'win_harbor_02');
            windowInput!.dispatchEvent(new Event('input', { bubbles: true }));
            windowInput!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        click(forkBtn!);
        expect(onFork).toHaveBeenCalledWith({
            windowId: 'win_harbor_02',
            branchId: 'branch-a'
        });

        const mergeBtn = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
            b.textContent?.includes('合流回主线')
        );
        expect(mergeBtn).toBeDefined();
        click(mergeBtn!);
        expect(onMerge).toHaveBeenCalledWith({
            windowId: 'win_harbor_02'
        });
    });
});

describe('DESIGN.md 东方清样样式底座与渐进增强契约', () => {
    it('包含深墨夜读与暖纸日间去框化色阶令牌，并彻底清除 side-tab 粗边条与 U+2011', () => {
        const allCss = STUDIO_CSS + INSPECTOR_CSS + BOOT_CSS;
        expect(allCss).toContain('#121316');
        expect(allCss).toContain('#1f2024');
        expect(allCss).toContain('body:not([data-ds-dark-theme])');
        expect(allCss).toContain('#ece8df');
        expect(allCss).toContain('#fcfbf7');

        expect(allCss).not.toContain('border-left: 3px solid');
        expect(allCss).not.toContain('\u2011');
    });

    it('提供容器感知三栏布局、672px 清样画布、68px 刊头、-4deg 定稿印章及 Overdrive 渐进增强规则', () => {
        expect(STUDIO_CSS).toContain('224px');
        expect(STUDIO_CSS).toContain('.ns-layout-wide');
        expect(STUDIO_CSS).toContain('.ns-layout-medium');
        expect(STUDIO_CSS).toContain('.ns-layout-compact');
        expect(STUDIO_CSS).toContain('.ns-right-drawer');
        expect(STUDIO_CSS).toContain('672px');
        expect(STUDIO_CSS).toContain('68px');
        expect(STUDIO_CSS).toContain('rotate(-4deg)');
        expect(STUDIO_CSS).toContain('@property --ns-beam-angle');
        expect(STUDIO_CSS).toContain('@supports (animation-timeline: scroll())');
        expect(STUDIO_CSS).toContain('::view-transition-');
        expect(STUDIO_CSS).toContain('@media (prefers-reduced-motion: reduce)');
        expect(BOOT_CSS).toContain('.ns-b-chat-guide');
        expect(BOOT_CSS).toContain('.ns-action-modal-shell');
    });
});

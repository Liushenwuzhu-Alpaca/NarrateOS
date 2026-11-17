// @vitest-environment jsdom
/**
 * 检查器章节生成累计 Token 的真实 DOM 回归：
 * 四项互不重叠分布条与图例、命中率由总量重算、无 prompt 数据显示未提供、
 * 范围文案不冒充全书总成本。使用真实 React 渲染，不替换任何组件内部。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    RightOpsInspector,
    type RightOpsInspectorProps
} from '../src/client/RightOpsInspector.js';

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
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();
});

function baseProps(): RightOpsInspectorProps {
    return {
        walLock: {
            walPhase: 'STATE_COMMITTED',
            timelineMode: 'MAINLINE',
            txLockStatus: 'free',
            lastCommittedChapter: 7
        },
        modelPool: {
            fastModel: 'fast',
            strongModel: 'strong',
            auditModel: 'audit',
            inputTokens: 0,
            cacheReadTokens: 0
        },
        stageArtifact: {
            selectedStageIndex: 0,
            stageName: '规划',
            stageStatus: '就绪',
            stageSummary: '阶段摘要'
        },
        proseGate: {
            mattr500: null,
            kontoyiannisEntropy: null,
            sentenceLengthCv: null,
            clicheDensityPer1k: null,
            recentViolations: []
        },
        factChecker: { totalChecked: 0, verifiedPassCount: 0, filteredOutCount: 0 },
        dreaming: {
            dirtyEntityCount: null,
            dirtyThreshold: null,
            coldArchiveCount: 0,
            spotlightQueue: null
        },
        volumeProgress: null
    };
}

/** 挂载检查器；遥测分组默认展开，无需额外交互 */
function mountInspector(props: RightOpsInspectorProps): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => {
        root.render(createElement(RightOpsInspector, props));
    });
    return container;
}

/** 定位「章节生成累计 Token」卡片（含分布条的那张） */
function tokenCard(container: HTMLElement): HTMLElement {
    const card = Array.from(container.querySelectorAll<HTMLElement>('.ns-i-card')).find(
        (el) => el.querySelector('.ns-i-bar') !== null
    );
    if (!card) throw new Error('未找到章节生成累计 Token 卡片');
    return card;
}

function segWidths(card: HTMLElement): string[] {
    return Array.from(card.querySelectorAll<HTMLElement>('.ns-i-bar-seg')).map(
        (el) => el.style.width
    );
}

describe('章节生成累计 Token 分布', () => {
    it('input100/read900/write100/output50：总量 1150 显示 1.1k，四段与图例一致，不再二次扣减', () => {
        const props = baseProps();
        props.modelPool = {
            ...props.modelPool,
            inputTokens: 100,
            cacheReadTokens: 900,
            cacheWriteTokens: 100,
            outputTokens: 50
        };
        const container = mountInspector(props);
        const card = tokenCard(container);
        const text = card.textContent ?? '';
        expect(text).toContain('章节生成累计 Token');
        expect(text).not.toContain('本章实耗');
        expect(card.querySelector('.ns-i-head-value')?.textContent).toBe('1.1k');

        const segs = Array.from(card.querySelectorAll<HTMLElement>('.ns-i-bar-seg'));
        expect(segs).toHaveLength(4);
        expect(segs.map((el) => el.className)).toEqual([
            'ns-i-bar-seg ns-i-seg-in',
            'ns-i-bar-seg ns-i-seg-green',
            'ns-i-bar-seg ns-i-seg-amber',
            'ns-i-bar-seg ns-i-seg-brand'
        ]);
        expect(segs.map((el) => el.getAttribute('title'))).toEqual([
            '未缓存输入 100',
            '缓存读取 900',
            '缓存写入 100',
            '输出 50'
        ]);
        // input 已是未缓存输入：第一段按 100/1150 绘制，不是 (100-900) 截 0
        expect(segWidths(card)).toEqual([
            `${(100 / 1150) * 100}%`,
            `${(900 / 1150) * 100}%`,
            `${(100 / 1150) * 100}%`,
            `${(50 / 1150) * 100}%`
        ]);
    });

    it('命中率按 read/(input+read+write) 重算为 81.8%，不采信外传值', () => {
        const props = baseProps();
        props.modelPool = {
            ...props.modelPool,
            inputTokens: 100,
            cacheReadTokens: 900,
            cacheWriteTokens: 100,
            outputTokens: 50
        };
        const container = mountInspector(props);
        const hitCard = Array.from(
            container.querySelectorAll<HTMLElement>('.ns-i-card')
        ).find((el) => (el.textContent ?? '').includes('静态前缀缓存命中'));
        expect(hitCard?.textContent).toContain('81.8');
        const fill = hitCard?.querySelector<HTMLElement>('.ns-prog-fill');
        expect(fill?.style.width).toBe(`${(900 / 1100) * 100}%`);
    });

    it('全缓存命中显示 100.0%，纯未缓存显示 0.0%', () => {
        const allCache = baseProps();
        allCache.modelPool = {
            ...allCache.modelPool,
            inputTokens: 0,
            cacheReadTokens: 500,
            cacheWriteTokens: 0,
            outputTokens: 80
        };
        expect(mountInspector(allCache).textContent).toContain('100.0');
        act(() => mountedRoots.pop()?.unmount());

        const noCache = baseProps();
        noCache.modelPool = {
            ...noCache.modelPool,
            inputTokens: 300,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 40
        };
        expect(mountInspector(noCache).textContent).toContain('0.0');
    });

    it('无 prompt Token 数据时命中率显示未提供，不画假 0% 进度条', () => {
        const container = mountInspector(baseProps());
        const hitCard = Array.from(
            container.querySelectorAll<HTMLElement>('.ns-i-card')
        ).find((el) => (el.textContent ?? '').includes('静态前缀缓存命中'));
        expect(hitCard?.textContent).toContain('未提供');
        expect(hitCard?.textContent).not.toContain('0.0%');
        expect(hitCard?.querySelector('.ns-prog-fill')).toBeNull();
    });

    it('真实 0 消耗不判缺失：总量 0、四段 0 宽、无 NaN/Infinity', () => {
        const props = baseProps();
        props.modelPool = {
            ...props.modelPool,
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0
        };
        const card = tokenCard(mountInspector(props));
        expect(card.querySelector('.ns-i-head-value')?.textContent).toBe('0');
        for (const width of segWidths(card)) {
            expect(width).toBe('0%');
            expect(width).not.toMatch(/NaN|Infinity/);
        }
    });

    it('缺省 cacheWriteTokens 的旧调用方按 0 呈现，不报错', () => {
        const props = baseProps();
        props.modelPool = {
            ...props.modelPool,
            inputTokens: 100,
            cacheReadTokens: 300,
            outputTokens: 50
        };
        const card = tokenCard(mountInspector(props));
        expect(card.querySelector('.ns-i-head-value')?.textContent).toBe('450');
        expect(card.textContent).toContain('in 100 - read 300 - write 0 - out 50');
    });

    it('范围文案声明只统计章节生成，不冒充全书总成本', () => {
        const text = tokenCard(mountInspector(baseProps())).textContent ?? '';
        expect(text).toContain('只统计已记录的章节生成');
        expect(text).toContain('不含开书、手改同步与整理消耗');
        expect(text).toContain('不是全书总成本');
    });
});
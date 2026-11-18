/**
 * RightOpsInspector 诚实呈现回归测试（A2.2 Dreaming 水位 / A2.3 预算降级 / A2.4 卷进度）。
 *
 * 本组保留轻量元素树断言，使用 vi.mock('react') 替换 hooks 与 createElement，
 * 不覆盖真实 React 生命周期；导航和保存竞态由同目录的 DOM 集成测试覆盖。
 * 这里仅验证展开后的文案与色条宽度，不断言源码文本。
 */
import { describe, expect, it, vi } from 'vitest';

/** 测试用最小元素节点（对应替身 createElement 的输出形状） */
interface StubElement {
    type: unknown;
    props: Record<string, unknown>;
    key: string | null;
}

/** react 替身对外暴露的测试控制接口 */
interface ReactTestStub {
    __resetHookSlots(): void;
    __beginRender(): void;
}

/** 构造替身元素节点，classic 与 automatic JSX 运行时共用 */
function makeStubElement(
    type: unknown,
    props: Record<string, unknown> | null,
    children: unknown[],
    key?: unknown
): StubElement {
    const merged: Record<string, unknown> = { ...(props ?? {}) };
    if (children.length > 0) merged.children = children;
    return {
        type,
        props: merged,
        key: typeof key === 'string' ? key : ((props?.key as string | undefined) ?? null)
    };
}

vi.mock('react', () => {
    const Fragment = Symbol('Fragment');
    let memoSlots: unknown[] = [];
    let memoCursor = 0;
    let stateSlots: unknown[] = [];
    let stateCursor = 0;
    const stub = {
        // 全新挂载：清空全部 hooks 槽位与游标
        __resetHookSlots: (): void => {
            memoSlots = [];
            memoCursor = 0;
            stateSlots = [];
            stateCursor = 0;
        },
        // 同一实例的重渲染：保留槽位内容，仅将游标归零（对应 React 每次渲染重置 hook 游标）
        __beginRender: (): void => {
            memoCursor = 0;
            stateCursor = 0;
        },
        useMemo: <T,>(factory: () => T, _deps: unknown[]): T => {
            const idx = memoCursor++;
            if (!(idx in memoSlots)) memoSlots[idx] = factory();
            return memoSlots[idx] as T;
        },
        useState: <T,>(initial: T): [T, (next: T | ((prev: T) => T)) => void] => {
            const idx = stateCursor++;
            if (!(idx in stateSlots)) stateSlots[idx] = initial;
            return [
                stateSlots[idx] as T,
                (next: T | ((prev: T) => T)) => {
                    stateSlots[idx] =
                        typeof next === 'function'
                            ? (next as (prev: T) => T)(stateSlots[idx] as T)
                            : next;
                }
            ];
        },
        createElement: (
            type: unknown,
            props: Record<string, unknown> | null,
            ...children: unknown[]
        ): StubElement => makeStubElement(type, props, children),
        Fragment
    };
    // 同时提供 default，兼容 esModuleInterop 下的默认导入
    return { ...stub, default: stub };
});

// automatic JSX 运行时（jsx: react-jsx）与本组 React 替身共用元素结构。
// 此替身仅作用于当前测试文件，不替换 DOM 集成测试中的真实 React。
vi.mock('react/jsx-runtime', () => {
    const Fragment = Symbol('Fragment');
    // automatic 运行时 children 位于 props 内，原样保留即可被文本收集器遍历
    const jsx = (
        type: unknown,
        props: Record<string, unknown> | null,
        key?: unknown
    ): StubElement => makeStubElement(type, props, [], key);
    const runtime = { Fragment, jsx, jsxs: jsx };
    return { ...runtime, default: runtime };
});

import * as reactModule from 'react';
import {
    RightOpsInspector,
    type RightOpsInspectorProps
} from '../src/client/RightOpsInspector.js';

// react 模块在本测试中被替换为携带控制接口的替身；生产类型声明无这些成员，
// 属于测试替身边界的已知形状，用受控断言取回。
const reactStub = reactModule as unknown as ReactTestStub;

/** 在元素树中查找满足谓词的节点 */
function findElement(
    node: unknown,
    predicate: (el: StubElement) => boolean
): StubElement | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findElement(child, predicate);
            if (hit) return hit;
        }
        return null;
    }
    if (!node || typeof node !== 'object') return null;
    const el = node as StubElement;
    if (!el.props) return null;
    if (predicate(el)) return el;
    return findElement(el.props.children, predicate);
}

/**
 * 挂载组件并通过真实的「全部展开」按钮 onClick 展开所有手风琴分组，
 * 随后重渲染取回完整输出；不触碰任何私有 hook 槽位。
 */
function renderAllOpen(props: RightOpsInspectorProps): StubElement {
    reactStub.__resetHookSlots();
    const first = RightOpsInspector(props) as unknown as StubElement;
    const expandButton = findElement(
        first,
        (el) =>
            el.type === 'button' && el.props['aria-label'] === '展开全部检查器分组'
    );
    if (!expandButton || typeof expandButton.props.onClick !== 'function') {
        throw new Error('未找到「全部展开」按钮，组件公共交互接缝发生变化');
    }
    (expandButton.props.onClick as () => void)();
    reactStub.__beginRender();
    return RightOpsInspector(props) as unknown as StubElement;
}

/** 深度收集元素树中的全部文本 */
function collectText(node: unknown, out: string[] = []): string[] {
    if (node === null || node === undefined || typeof node === 'boolean') return out;
    if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
        return out;
    }
    if (Array.isArray(node)) {
        for (const child of node) collectText(child, out);
        return out;
    }
    const el = node as StubElement;
    if (el.props) collectText(el.props.children, out);
    return out;
}

/** 拼接文本并折叠空白，模拟浏览器对相邻文本节点的可见呈现 */
function visibleText(node: unknown): string {
    return collectText(node).join(' ').replace(/\s+/g, ' ').trim();
}

/** 收集所有带 style.width 的进度条填充宽度 */
function collectBarWidths(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) {
        for (const child of node) collectBarWidths(child, out);
        return out;
    }
    if (!node || typeof node !== 'object') return out;
    const el = node as StubElement;
    if (!el.props) return out;
    const style = el.props.style as Record<string, unknown> | undefined;
    if (style && typeof style.width === 'string') out.push(style.width);
    collectBarWidths(el.props.children, out);
    return out;
}

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

describe('Dreaming 脏页水位诚实呈现', () => {
    it('未知水位不显示 0 / 5、假百分比或暂无信号', () => {
        const text = visibleText(renderAllOpen(baseProps()));
        expect(text).toContain('未提供');
        expect(text).not.toMatch(/0\s*\/\s*5/);
        expect(text).not.toContain('(0%)');
        expect(text).not.toContain('暂无待切镜幕后角色信号');
    });

    it('真实零水位显示 0 / 5 与 0%，真实空队列显示暂无信号', () => {
        const props = baseProps();
        props.dreaming = {
            dirtyEntityCount: 0,
            dirtyThreshold: 5,
            coldArchiveCount: 0,
            spotlightQueue: []
        };
        const text = visibleText(renderAllOpen(props));
        expect(text).toMatch(/0\s*\/\s*5/);
        expect(text).toContain('(0%)');
        expect(text).toContain('暂无待切镜幕后角色信号');
    });

    it('完整水位数据按真实比例绘制', () => {
        const props = baseProps();
        props.dreaming = {
            dirtyEntityCount: 2,
            dirtyThreshold: 4,
            coldArchiveCount: 3,
            spotlightQueue: []
        };
        const tree = renderAllOpen(props);
        const text = visibleText(tree);
        expect(text).toMatch(/2\s*\/\s*4/);
        expect(text).toContain('(50%)');
        expect(collectBarWidths(tree)).toContain('50%');
    });

    it('真实冷归档 0 仍按数值显示', () => {
        const text = visibleText(renderAllOpen(baseProps()));
        expect(text).toContain('0 冷归档');
    });

    it('未挂载实体且队列未知时不把未知说成 0 活跃', () => {
        const text = visibleText(renderAllOpen(baseProps()));
        expect(text).not.toContain('0 活跃');
        expect(text).toContain('活跃数未提供');
    });

    it('真实空队列允许显示 0 活跃', () => {
        const props = baseProps();
        props.dreaming = {
            dirtyEntityCount: 0,
            dirtyThreshold: 5,
            coldArchiveCount: 0,
            spotlightQueue: []
        };
        const text = visibleText(renderAllOpen(props));
        expect(text).toContain('0 活跃');
    });
});

describe('写手预算与降级诚实呈现', () => {
    it('缺测量不显示 0 级正常 / 总装配 0 tokens / 固定 50% 与 30% 条', () => {
        const tree = renderAllOpen(baseProps());
        const text = visibleText(tree);
        expect(text).not.toContain('0 级正常');
        expect(text).not.toContain('总装配 0 tokens');
        expect(text).toContain('未提供');
        const widths = collectBarWidths(tree);
        expect(widths).not.toContain('50%');
        expect(widths).not.toContain('30%');
    });

    it('完整测量按真实比例绘制且降级级别真实呈现', () => {
        const props = baseProps();
        props.stageArtifact = {
            ...props.stageArtifact,
            staticPrefixTokens: 1000,
            dynamicTailTokens: 500,
            budgetLimitTokens: 4000,
            degradationLevel: 0
        };
        const tree = renderAllOpen(props);
        const text = visibleText(tree);
        expect(text).toContain('0 级正常');
        expect(text).toContain('1.5k / 4.0k');
        const widths = collectBarWidths(tree);
        expect(widths).toContain('25%');
        expect(widths).toContain('12.5%');
    });

    it('合法 0 tokens 与 0 预算不视为缺失且不产生 NaN/Infinity', () => {
        const props = baseProps();
        props.stageArtifact = {
            ...props.stageArtifact,
            staticPrefixTokens: 0,
            dynamicTailTokens: 0,
            budgetLimitTokens: 0,
            degradationLevel: 1
        };
        const tree = renderAllOpen(props);
        const text = visibleText(tree);
        expect(text).toContain('降级 1 级');
        expect(text).not.toContain('NaN');
        expect(text).not.toContain('Infinity');
        for (const width of collectBarWidths(tree)) {
            expect(width).not.toMatch(/NaN|Infinity/);
        }
    });
});

describe('卷纲进度诚实呈现', () => {
    it('无卷快照时不假定 20 章目标，单独标全书已提交章数', () => {
        const text = visibleText(renderAllOpen(baseProps()));
        expect(text).not.toContain('/ 20');
        expect(text).not.toMatch(/7\s*\/\s*20/);
        expect(text).toContain('全书已提交 7 章');
        expect(text).toContain('未提供');
    });

    it('缺当前卷完成数时不用 wal 最后章号顶替、不绘百分比', () => {
        const props = baseProps();
        props.volumeProgress = { volumeLabel: '第一卷', totalChapters: 12 };
        const tree = renderAllOpen(props);
        const text = visibleText(tree);
        expect(text).not.toMatch(/7\s*\/\s*12/);
        expect(text).not.toContain('58%');
        expect(text).toContain('全书已提交 7 章');
        for (const width of collectBarWidths(tree)) {
            expect(width).not.toBe('58%');
        }
    });

    it('完整卷数据仍显示真实比例', () => {
        const props = baseProps();
        props.volumeProgress = {
            volumeLabel: '第一卷',
            completedChapters: 3,
            totalChapters: 12
        };
        const tree = renderAllOpen(props);
        const text = visibleText(tree);
        expect(text).toMatch(/3\s*\/\s*12/);
        expect(text).toContain('25%');
        expect(collectBarWidths(tree)).toContain('25%');
    });

    it('真实卷完成 0 章不被判缺失', () => {
        const props = baseProps();
        props.volumeProgress = { completedChapters: 0, totalChapters: 10 };
        const text = visibleText(renderAllOpen(props));
        expect(text).toMatch(/0\s*\/\s*10/);
        expect(text).toContain('0%');
    });
});

describe('Wave 4A 右栏「运行状态」三段摘要与底层校验明细', () => {
    it('默认直白展示三段核心摘要且全文本统一使用 Checker 而非 Fact Checker', () => {
        reactStub.__resetHookSlots();
        const props = baseProps();
        props.stageArtifact = {
            ...props.stageArtifact,
            staticPrefixTokens: 4120,
            dynamicTailTokens: 14280,
            budgetLimitTokens: 32000,
            degradationLevel: 0,
            strippedItemsSummary: '已隔离 2 项秘密底牌'
        };
        props.selectedVoiceSample = {
            id: 'v1',
            tag: '冷峻克制',
            text: '把门关上。'
        };
        props.strippedSecretCount = 2;
        props.proseGate = {
            mattr500: 0.79,
            kontoyiannisEntropy: 4.12,
            sentenceLengthCv: 0.64,
            clicheDensityPer1k: 0,
            recentViolations: []
        };
        props.dreamWatermark = {
            last_dream_ch: 4,
            accumulated_words_since_dream: 6120,
            word_threshold: 15000
        };
        const tree = RightOpsInspector(props) as unknown as StubElement;
        const text = visibleText(tree);

        expect(text).toContain('本章给写手装入的资料');
        expect(text).toContain('文风体检');
        expect(text).toContain('自动整理进度');
        expect(text).toContain('词汇丰富度');
        expect(text).toContain('信息新鲜度');
        expect(text).toContain('句式长短变化');
        expect(text).toContain('套话密度');
        expect(text).toContain('冷峻克制');
        expect(text).toContain('已屏蔽 2 项');
        expect(text).toContain('6,120 / 15,000 字');
        expect(text).not.toContain('Fact Checker');
        expect(text).not.toContain('Fact Check');

        const lowLevelBody = findElement(
            tree,
            (el) => el.props.id === 'ns-i-body-lowlevel'
        );
        expect(lowLevelBody).not.toBeNull();
        expect(lowLevelBody?.props.hidden).toBe(true);
    });

    it('底层校验与提交明细展示事务锁、双粒度 SHA、Checker 筛除统计与完整双侧冲突诊断', () => {
        const props = baseProps();
        props.walLock = {
            walPhase: 'SAFE_HALT',
            timelineMode: 'MAINLINE',
            txLockStatus: 'locked',
            txLockHolder: 'STEPPING',
            lastCommittedChapter: 2,
            featCommitSha: '81c4a9e1234',
            stateCommitSha: 'f03d72b5678'
        };
        props.factChecker = {
            totalChecked: 8,
            verifiedPassCount: 6,
            filteredOutCount: 2,
            blockedCount: 1
        };
        props.haltDiagnostic = {
            kind: 'SAFE_HALT',
            reason: '陈砚左腕旧伤设定矛盾',
            leftRef: 'entities/char_chenyan.md',
            leftLine: 14,
            leftExcerpt: '左腕旧骨折未愈，无法单手推举重物',
            rightRef: 'manuscripts/ch_0002.md',
            rightLine: 2,
            rightExcerpt: '陈砚抬起完好无损的左手推开账房木门',
            affectedChapters: 2,
            affectedWords: 6120,
            rollbackThreshold: 3,
            issues: [
                {
                    description: '伤势冲突',
                    quote_source: '左腕旧骨折未愈',
                    quote_draft: '完好无损的左手',
                    source_ref: 'entities/char_chenyan.md#L14'
                }
            ]
        };

        const tree = renderAllOpen(props);
        const text = visibleText(tree);
        expect(text).toContain('底层校验与提交明细');
        expect(text).toContain('LOCKED');
        expect(text).toContain('81c4a9e');
        expect(text).toContain('f03d72b');
        expect(text).toContain('Checker 筛除伪引文');
        expect(text).toContain('过滤 2');
        expect(text).toContain('entities/char_chenyan.md:14');
        expect(text).toContain('manuscripts/ch_0002.md:2');
        expect(text).toContain('6120 字');
        expect(text).toContain('左腕旧骨折未愈，无法单手推举重物');
        expect(text).toContain('陈砚抬起完好无损的左手推开账房木门');
        expect(text).toContain('双池模型路由');
        expect(text).not.toContain('独立挑错池');
        expect(text).not.toContain('Fact Checker');
        expect(text).not.toContain('Fact Check');
    });
});
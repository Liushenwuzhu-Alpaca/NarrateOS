import { describe, expect, it } from 'vitest';
import {
    decideDraftNavigation,
    getStashedDraft,
    hasAnyUnsavedDraft,
    makeDraftStashKey,
    putStashedDraft,
    removeStashedDraft,
    resolveBackgroundCommitAction,
    type DraftLocation,
    type DraftStashMap,
    type StashedDraftEntry
} from '../src/client/draft-guard';

const DRAFT: DraftLocation = { bookRoot: '/books/novel-a', chapterNumber: 3, baseSha256: 'sha-a3', content: '未保存的草稿文本' };

describe('decideDraftNavigation - 未保存草稿的主动导航边界', () => {
    it('无脏草稿时任何导航直接放行', () => {
        expect(decideDraftNavigation(null, { kind: 'chapter', chapterNumber: 9 })).toBe('proceed');
        expect(decideDraftNavigation(null, { kind: 'book', bookRoot: '/books/novel-b' })).toBe('proceed');
        expect(decideDraftNavigation(null, { kind: 'new-book' })).toBe('proceed');
    });

    it('脏草稿存在时跨章导航需要确认', () => {
        expect(decideDraftNavigation(DRAFT, { kind: 'chapter', chapterNumber: 4 })).toBe('confirm');
        expect(decideDraftNavigation(DRAFT, { kind: 'chapter', chapterNumber: 1 })).toBe('confirm');
    });

    it('同章重选/刷新不触发确认（草稿无损保留）', () => {
        expect(decideDraftNavigation(DRAFT, { kind: 'chapter', chapterNumber: 3 })).toBe('proceed');
    });

    it('切到其他作品或开新书需要确认，重选当前作品放行', () => {
        expect(decideDraftNavigation(DRAFT, { kind: 'book', bookRoot: '/books/novel-b' })).toBe('confirm');
        expect(decideDraftNavigation(DRAFT, { kind: 'book', bookRoot: '/books/novel-a' })).toBe('proceed');
        expect(decideDraftNavigation(DRAFT, { kind: 'new-book' })).toBe('confirm');
    });
});

describe('resolveBackgroundCommitAction - 后台提交不抢编辑章', () => {
    it('有脏草稿时不同章 COMMITTED 只刷新数据，不切换选章', () => {
        expect(resolveBackgroundCommitAction(7, 3, true)).toBe('refresh-current');
    });

    it('有脏草稿时同章 COMMITTED 也不换章', () => {
        expect(resolveBackgroundCommitAction(3, 3, true)).toBe('refresh-current');
    });

    it('无脏草稿时保持既有自动跟随：不同章跟随，同章原地刷新', () => {
        expect(resolveBackgroundCommitAction(7, 3, false)).toBe('follow');
        expect(resolveBackgroundCommitAction(3, 3, false)).toBe('refresh-current');
    });

    it('提交章号缺失或非法时不跟随', () => {
        expect(resolveBackgroundCommitAction(null, 3, false)).toBe('refresh-current');
        expect(resolveBackgroundCommitAction(0, 3, false)).toBe('refresh-current');
    });

    it('尚未选章时无脏草稿的合法提交章可跟随', () => {
        expect(resolveBackgroundCommitAction(1, null, false)).toBe('follow');
    });
});

describe('内存草稿暂存表（按 bookRoot::chapterNumber 键控）', () => {
    it('makeDraftStashKey 生成 bookRoot::chapterNumber 键并隔离不同书和不同章', () => {
        expect(makeDraftStashKey('/books/alpha', 3)).toBe('/books/alpha::3');
        expect(makeDraftStashKey('/books/beta', 3)).toBe('/books/beta::3');
        expect(makeDraftStashKey('/books/alpha', 4)).toBe('/books/alpha::4');
    });

    it('putStashedDraft / getStashedDraft 不可变写入与跨书跨章读取，且可携带 baseSha256', () => {
        const initial: DraftStashMap = {};
        const entryA3: StashedDraftEntry = {
            bookRoot: '/books/alpha',
            chapterNumber: 3,
            content: '甲书第三章未保存草稿',
            baseSha256: 'sha-a3',
            updatedAt: 1_700_000_001_000
        };
        const entryB3: StashedDraftEntry = {
            bookRoot: '/books/beta',
            chapterNumber: 3,
            content: '乙书第三章未保存草稿',
            baseSha256: 'sha-b3',
            updatedAt: 1_700_000_002_000
        };

        const afterFirst = putStashedDraft(initial, entryA3);
        const afterSecond = putStashedDraft(afterFirst, entryB3);

        expect(initial).toEqual({});
        expect(Object.keys(afterFirst)).toEqual(['/books/alpha::3']);
        expect(getStashedDraft(afterSecond, '/books/alpha', 3)).toEqual(entryA3);
        expect(getStashedDraft(afterSecond, '/books/beta', 3)).toEqual(entryB3);
        expect(getStashedDraft(afterSecond, '/books/alpha', 4)).toBeNull();
    });

    it('putStashedDraft 对同书同章执行不可变覆盖更新', () => {
        const first: StashedDraftEntry = {
            bookRoot: '/books/alpha',
            chapterNumber: 2,
            content: '旧草稿',
            baseSha256: 'sha-old',
            updatedAt: 100
        };
        const updated: StashedDraftEntry = {
            bookRoot: '/books/alpha',
            chapterNumber: 2,
            content: '新草稿',
            baseSha256: 'sha-new',
            updatedAt: 200
        };

        const s1 = putStashedDraft({}, first);
        const s2 = putStashedDraft(s1, updated);

        expect(getStashedDraft(s1, '/books/alpha', 2)?.content).toBe('旧草稿');
        expect(getStashedDraft(s2, '/books/alpha', 2)).toEqual(updated);
    });

    it('removeStashedDraft 不可变移除指定草稿且缺失键时无副作用', () => {
        const entryA1: StashedDraftEntry = {
            bookRoot: '/books/alpha',
            chapterNumber: 1,
            content: '第一章草稿',
            baseSha256: 'sha-a1',
            updatedAt: 100
        };
        const entryA2: StashedDraftEntry = {
            bookRoot: '/books/alpha',
            chapterNumber: 2,
            content: '第二章草稿',
            baseSha256: 'sha-a2',
            updatedAt: 200
        };
        const stash = putStashedDraft(putStashedDraft({}, entryA1), entryA2);

        const afterRemove = removeStashedDraft(stash, '/books/alpha', 1);
        expect(getStashedDraft(stash, '/books/alpha', 1)).toEqual(entryA1);
        expect(getStashedDraft(afterRemove, '/books/alpha', 1)).toBeNull();
        expect(getStashedDraft(afterRemove, '/books/alpha', 2)).toEqual(entryA2);

        const afterMissing = removeStashedDraft(afterRemove, '/books/alpha', 99);
        expect(afterMissing).toEqual(afterRemove);
    });

    it('hasAnyUnsavedDraft 综合判断当前脏编辑与暂存表是否为空', () => {
        expect(hasAnyUnsavedDraft({}, false)).toBe(false);
        expect(hasAnyUnsavedDraft({}, true)).toBe(true);

        const stash = putStashedDraft({}, {
            bookRoot: '/books/alpha',
            chapterNumber: 1,
            content: '草稿',
            baseSha256: 'sha-a1',
            updatedAt: 100
        });
        expect(hasAnyUnsavedDraft(stash, false)).toBe(true);
        expect(hasAnyUnsavedDraft(stash, true)).toBe(true);

        const cleared = removeStashedDraft(stash, '/books/alpha', 1);
        expect(hasAnyUnsavedDraft(cleared, false)).toBe(false);
    });
});
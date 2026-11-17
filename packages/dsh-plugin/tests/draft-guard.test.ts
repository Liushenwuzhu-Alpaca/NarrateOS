import { describe, expect, it } from 'vitest';
import {
    decideDraftNavigation,
    resolveBackgroundCommitAction,
    type DraftLocation
} from '../src/client/draft-guard';

const DRAFT: DraftLocation = { bookRoot: '/books/novel-a', chapterNumber: 3, content: '未保存的草稿文本' };

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
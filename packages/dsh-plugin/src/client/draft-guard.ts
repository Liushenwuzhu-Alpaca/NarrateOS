/**
 * 未保存草稿导航守卫（纯决策逻辑，供根组件与回归测试共用）：
 * - 主动导航（目录选章、上下章、检查器跳章、切作品、开新书）离开脏草稿所在章/作品前必须确认
 * - 后台 COMMITTED 事件不得抢走正在编辑的章；无脏草稿时保持既有自动跟随
 */

/** 脏草稿快照（由编辑器边界上报；null 表示无未保存草稿）；content 供守卫保存使用 */
export interface DraftLocation {
    bookRoot: string;
    chapterNumber: number;
    content: string;
}

/** 主动导航意图 */
export type DraftNavigationIntent =
    | { kind: 'chapter'; chapterNumber: number }
    | { kind: 'book'; bookRoot: string }
    | { kind: 'new-book' };

/** 守卫决策：proceed 直接放行；confirm 需要先保存/放弃/取消确认 */
export type DraftGuardDecision = 'proceed' | 'confirm';

/** 判断一次主动导航是否会离开脏草稿所在位置 */
export function decideDraftNavigation(
    draft: DraftLocation | null,
    intent: DraftNavigationIntent
): DraftGuardDecision {
    if (!draft) return 'proceed';
    if (intent.kind === 'chapter') {
        // 同章刷新/重选不会替换草稿，直接放行
        return intent.chapterNumber === draft.chapterNumber ? 'proceed' : 'confirm';
    }
    if (intent.kind === 'book') {
        return intent.bookRoot === draft.bookRoot ? 'proceed' : 'confirm';
    }
    return 'confirm';
}

/** 后台提交事件的处理动作：follow 跟随切换到提交章；refresh-current 只刷新数据不换章 */
export type BackgroundCommitAction = 'follow' | 'refresh-current';

/** 决定后台 COMMITTED 是否允许自动切换当前浏览章 */
export function resolveBackgroundCommitAction(
    committedChapter: number | null,
    selectedChapter: number | null,
    hasDirtyDraft: boolean
): BackgroundCommitAction {
    // 编辑中的草稿优先：后台提交只刷新目录与运行信息，不抢选章
    if (hasDirtyDraft) return 'refresh-current';
    if (
        committedChapter !== null &&
        committedChapter > 0 &&
        committedChapter !== selectedChapter
    ) {
        return 'follow';
    }
    return 'refresh-current';
}
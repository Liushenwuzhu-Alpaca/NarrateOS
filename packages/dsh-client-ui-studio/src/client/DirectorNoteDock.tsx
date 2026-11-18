import React, { useMemo, useState } from 'react';
import type { PendingSignalItem, SubmitSignalPayload } from './CenterWorkbench';
import type { CodexEntitySummary } from './CodexView';
import { StudioIcons } from './workbench-parsers';

export type NoteSignalKind = 'DIRECTOR_NOTE' | 'SPOTLIGHT_TRIGGER' | 'FLASHBACK' | 'RETCON';

export const NOTE_KIND_OPTIONS: ReadonlyArray<{
    key: NoteSignalKind;
    label: string;
    command: string;
    desc: string;
}> = [
    { key: 'DIRECTOR_NOTE', label: '剧情微调', command: '/plot', desc: '下章剧情与场景走向指示' },
    { key: 'SPOTLIGHT_TRIGGER', label: '切换视角', command: '/spotlight', desc: '指定下一章焦点切镜人物' },
    { key: 'FLASHBACK', label: '插入回忆', command: '/flashback', desc: '回到指定故事日插入回忆段落' },
    { key: 'RETCON', label: '圆谎修补', command: '/retcon', desc: '补圆冲突设定并约束后续写作' }
];

function resolveNoteTypeDisplay(sig: PendingSignalItem): string {
    const rawType = (sig.type ?? '').trim().toUpperCase();
    const mode = (sig.suggested_mode ?? '').trim().toUpperCase();
    if (mode === 'FLASHBACK') return '插入回忆';
    if (rawType === 'SPOTLIGHT_TRIGGER') return '切换视角';
    if (rawType === 'RETCON') return '圆谎修补';
    if (rawType === 'DIRECTOR_NOTE') return '剧情微调';
    return sig.type ?? '导演便签';
}

export interface DirectorNoteDockProps {
    nextChapterOptions?: readonly string[] | undefined;
    pendingSignals: readonly PendingSignalItem[];
    entities: readonly CodexEntitySummary[];
    isBusy: boolean;
    submittingSignal: boolean;
    noteKind: NoteSignalKind;
    noteText: string;
    spotlightEntityId: string;
    flashbackDay: number;
    inputRef: React.RefObject<HTMLInputElement | null>;
    onChangeNoteKind: (kind: NoteSignalKind) => void;
    onChangeNoteText: (text: string) => void;
    onChangeSpotlightEntityId: (entityId: string) => void;
    onChangeFlashbackDay: (day: number) => void;
    onSubmitSignal: (payload: SubmitSignalPayload) => Promise<void> | void;
    onStepWithOption: (chapterGoal?: string) => Promise<void> | void;
    onDismissSignal?: ((index: number) => void) | undefined;
}

/**
 * 底部纵向走向建议与一体式导演便签舱（ISS-060, ISS-062）：
 * - 可收折纵向 nextChapterOptions 建议：点文字填入微调，点「直接写 ->」立即推进指定目标
 * - 四类导演便签精确映射：剧情微调 -> DIRECTOR_NOTE；切换视角 -> SPOTLIGHT_TRIGGER；
 *   插入回忆 -> DIRECTOR_NOTE + FLASHBACK + targetDay；圆谎修补 -> RETCON
 */
export function DirectorNoteDock({
    nextChapterOptions = [],
    pendingSignals,
    entities,
    isBusy,
    submittingSignal,
    noteKind,
    noteText,
    spotlightEntityId,
    flashbackDay,
    inputRef,
    onChangeNoteKind,
    onChangeNoteText,
    onChangeSpotlightEntityId,
    onChangeFlashbackDay,
    onSubmitSignal,
    onStepWithOption,
    onDismissSignal
}: DirectorNoteDockProps): React.ReactElement {
    const [ideasExpanded, setIdeasExpanded] = useState(false);
    const [kindMenuOpen, setKindMenuOpen] = useState(false);
    const [slashDismissed, setSlashDismissed] = useState(false);

    const activeKindMeta =
        NOTE_KIND_OPTIONS.find((item) => item.key === noteKind) ?? NOTE_KIND_OPTIONS[0]!;

    const effectiveSpotlightEntityId = useMemo(() => {
        if (spotlightEntityId && entities.some((ent) => ent.entityId === spotlightEntityId)) {
            return spotlightEntityId;
        }
        return entities[0]?.entityId ?? '';
    }, [entities, spotlightEntityId]);

    const slashQueryMatch = useMemo(() => /^\/(\S*)$/.exec(noteText), [noteText]);
    const filteredSlash = useMemo(() => {
        if (!slashQueryMatch) return [];
        const q = (slashQueryMatch[1] ?? '').trim().toLowerCase();
        if (!q) return [...NOTE_KIND_OPTIONS];
        return NOTE_KIND_OPTIONS.filter(
            (item) =>
                item.command.slice(1).includes(q) ||
                item.label.includes(q) ||
                item.key.toLowerCase().includes(q)
        );
    }, [slashQueryMatch]);
    const isSlashOpen = slashQueryMatch !== null && !slashDismissed && filteredSlash.length > 0;

    const triggerSubmit = async (runAfter: boolean) => {
        const trimmed = noteText.trim();
        if (!trimmed) {
            if (runAfter) {
                await onStepWithOption(undefined);
            }
            return;
        }
        await onSubmitSignal({
            kind: noteKind,
            content: trimmed,
            runAfter,
            ...(noteKind === 'SPOTLIGHT_TRIGGER' && effectiveSpotlightEntityId
                ? { entityId: effectiveSpotlightEntityId }
                : {}),
            ...(noteKind === 'FLASHBACK'
                ? { targetDay: Math.max(1, Math.floor(flashbackDay) || 1) }
                : {})
        });
    };

    return (
        <footer className="ns-director-footer">
            <div className="ns-director-wrap">
                {!isBusy && nextChapterOptions.length > 0 ? (
                    <div className="ns-next-ideas-panel">
                        <button
                            type="button"
                            className="ns-next-ideas-header"
                            aria-expanded={ideasExpanded}
                            onClick={() => setIdeasExpanded((prev) => !prev)}
                        >
                            <span>
                                {StudioIcons.spark}{' '}
                                <b>下一章走向建议 ({nextChapterOptions.length})</b>{' '}
                                <span className="ns-muted">
                                    {ideasExpanded
                                        ? '点文字填入微调，点右侧直接开写'
                                        : '点击展开查看候选剧情'}
                                </span>
                            </span>
                            <span>{ideasExpanded ? StudioIcons.chev : StudioIcons.chevUp}</span>
                        </button>
                        {ideasExpanded ? (
                            <div className="ns-next-idea-list">
                                {nextChapterOptions.map((opt, idx) => (
                                    <div key={`${idx}-${opt}`} className="ns-next-idea-row">
                                        <button
                                            type="button"
                                            className="ns-next-idea-text"
                                            onClick={() => {
                                                onChangeNoteKind('DIRECTOR_NOTE');
                                                onChangeNoteText(opt);
                                                inputRef.current?.focus();
                                            }}
                                        >
                                            {idx + 1}. {opt}
                                        </button>
                                        <button
                                            type="button"
                                            className="ns-next-idea-go"
                                            disabled={isBusy}
                                            onClick={() => void onStepWithOption(opt)}
                                        >
                                            直接写 →
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {pendingSignals.length > 0 ? (
                    <div className="ns-queued-notes" aria-label="待消费导演便签队列">
                        {pendingSignals.map((sig, idx) => (
                            <span key={`${sig.created_at ?? idx}-${idx}`} className="ns-note-tag">
                                <span className="ns-note-tag-kind">
                                    {resolveNoteTypeDisplay(sig)}
                                </span>
                                <span>{sig.reason ?? sig.raw ?? '待消费便签'}</span>
                                <button
                                    type="button"
                                    disabled={!onDismissSignal || isBusy}
                                    title="撤回这张便签"
                                    aria-label="撤回便签"
                                    onClick={() => onDismissSignal?.(idx)}
                                >
                                    ×
                                </button>
                            </span>
                        ))}
                    </div>
                ) : null}

                <div className="ns-note-dock">
                    <div className="ns-note-dock-wrap">
                        <button
                            type="button"
                            className="ns-note-kind-btn"
                            aria-haspopup="menu"
                            aria-expanded={kindMenuOpen}
                            onClick={() => setKindMenuOpen((prev) => !prev)}
                        >
                            <span>{activeKindMeta.label}</span>
                            {StudioIcons.chev}
                        </button>
                        {kindMenuOpen ? (
                            <div
                                className="ns-menu-pop ns-left ns-menu-pop-bottom"
                                role="menu"
                                aria-label="选择便签类型"
                            >
                                {NOTE_KIND_OPTIONS.map((item) => (
                                    <button
                                        key={item.key}
                                        type="button"
                                        role="menuitem"
                                        className="ns-menu-row"
                                        onClick={() => {
                                            onChangeNoteKind(item.key);
                                            setKindMenuOpen(false);
                                            inputRef.current?.focus();
                                        }}
                                    >
                                        <b>{item.label}</b>
                                        <span>{item.desc}</span>
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>

                    {isSlashOpen ? (
                        <div className="ns-slash-menu" role="listbox" aria-label="导演指令联想">
                            {filteredSlash.map((item) => (
                                <button
                                    key={item.key}
                                    type="button"
                                    role="option"
                                    aria-selected={item.key === noteKind}
                                    className="ns-slash-item"
                                    onMouseDown={(e: React.MouseEvent<HTMLButtonElement>) => {
                                        e.preventDefault();
                                        onChangeNoteKind(item.key);
                                        onChangeNoteText(noteText.replace(/^\/\S*\s*/, ''));
                                        setSlashDismissed(false);
                                        inputRef.current?.focus();
                                    }}
                                >
                                    <span className="ns-slash-cmd">{item.command}</span>
                                    <span className="ns-slash-alias">{item.label}</span>
                                    <span className="ns-slash-desc">{item.desc}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}

                    {noteKind === 'SPOTLIGHT_TRIGGER' && entities.length > 0 ? (
                        <select
                            className="ns-spotlight-select"
                            aria-label="选择切镜人物"
                            value={effectiveSpotlightEntityId}
                            onChange={(e) => onChangeSpotlightEntityId(e.target.value)}
                        >
                            {entities.map((ent) => (
                                <option key={ent.entityId} value={ent.entityId}>
                                    {ent.canonicalName}
                                </option>
                            ))}
                        </select>
                    ) : null}

                    {noteKind === 'FLASHBACK' ? (
                        <label className="ns-flashback-day-label">
                            <span>回到第</span>
                            <input
                                type="number"
                                min={1}
                                aria-label="回忆目标天数"
                                className="ns-flashback-day-input"
                                value={flashbackDay}
                                onChange={(e) =>
                                    onChangeFlashbackDay(Math.max(1, Number(e.target.value) || 1))
                                }
                            />
                            <span>天</span>
                        </label>
                    ) : null}

                    <input
                        ref={inputRef}
                        type="text"
                        className="ns-note-input"
                        value={noteText}
                        onChange={(e) => {
                            onChangeNoteText(e.target.value);
                            setSlashDismissed(false);
                        }}
                        onKeyDown={(e) => {
                            const nativeEvent = (
                                e as unknown as { nativeEvent?: { isComposing?: boolean } }
                            ).nativeEvent;
                            if (nativeEvent?.isComposing) return;
                            if (e.key === 'Escape' && isSlashOpen) {
                                e.preventDefault();
                                setSlashDismissed(true);
                                return;
                            }
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                e.preventDefault();
                                void triggerSubmit(true);
                            } else if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                void triggerSubmit(false);
                            }
                        }}
                        placeholder="给下一章递张导演便签（写完下一章自动生效并清空）"
                    />

                    <button
                        type="button"
                        className="ns-btn"
                        disabled={submittingSignal || !noteText.trim()}
                        onClick={() => void triggerSubmit(false)}
                    >
                        先存便签
                    </button>

                    <button
                        type="button"
                        className="ns-btn ns-btn-primary ns-btn-icon-only"
                        disabled={submittingSignal || isBusy}
                        title="存入便签并立即写下一章"
                        aria-label="存入便签并立即写下一章"
                        onClick={() => void triggerSubmit(true)}
                    >
                        {StudioIcons.send}
                    </button>
                </div>
            </div>
        </footer>
    );
}

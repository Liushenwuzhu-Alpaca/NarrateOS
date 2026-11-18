import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    KNOWN_SSE_EVENTS,
    NarrateApiError,
    advanceVolume,
    fetchViewSyncConflicts,
    forkParallelWindow,
    healConflicts,
    mergeParallelWindow,
    postSignal,
    requestHalt,
    stepChapter,
    subscribeNarrateEvents
} from '../src/client/api';
import type {
    AdvanceVolumeResponse,
    HealConflictsResponse,
    NarrateStatusPayload,
    ParallelForkResponse,
    ParallelMergeResponse,
    SseEventName,
    SseEventPayload,
    SyncConflictsViewPayload
} from '../src/client/types';

interface MockFetchCall {
    url: string;
    init: RequestInit | undefined;
}

class FakeEventSource {
    readonly url: string;
    readonly listeners = new Map<string, Array<(ev: Event) => void>>();
    closed = false;
    onerror: ((ev: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
    }

    addEventListener(type: string, listener: (ev: Event) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    emit(type: string, data: unknown): void {
        const list = this.listeners.get(type) ?? [];
        const event = { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent<string>;
        for (const fn of list) {
            fn(event);
        }
    }

    close(): void {
        this.closed = true;
    }
}

describe('Studio HTTP & SSE 运行契约 (Wave 4A)', () => {
    let fetchCalls: MockFetchCall[];

    beforeEach(() => {
        fetchCalls = [];
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function mockFetchJson(status: number, body: unknown, statusText = 'OK'): void {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                fetchCalls.push({ url: String(input), init });
                return new Response(JSON.stringify(body), {
                    status,
                    statusText,
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
    }

    it('KNOWN_SSE_EVENTS 覆盖全部 27 个后端 SSE 事件（含 default_model_changed）并正确分发', () => {
        const expectedEvents: readonly SseEventName[] = [
            'connected',
            'book_switched',
            'default_model_changed',
            'halt:requested',
            'halt:waiting',
            'halt:completed',
            'sync:started',
            'sync:completed',
            'chapter_synced',
            'chapter:phase',
            'stage',
            'stage:session',
            'stage:event',
            'gate:result',
            'checker:result',
            'dream:started',
            'dream:completed',
            'signal:received',
            'signal:withdrawn',
            'volume:advanced',
            'task:idle',
            'heal:started',
            'heal:completed',
            'telemetry',
            'yolo:stop_requested',
            'yolo_halted',
            'yolo_completed'
        ];

        expect(KNOWN_SSE_EVENTS).toHaveLength(expectedEvents.length);
        for (const evtName of expectedEvents) {
            expect(KNOWN_SSE_EVENTS).toContain(evtName);
        }

        let createdSource: FakeEventSource | null = null;
        vi.stubGlobal(
            'EventSource',
            vi.fn((url: string) => {
                createdSource = new FakeEventSource(url);
                return createdSource;
            })
        );

        const received: SseEventPayload[] = [];
        const unsubscribe = subscribeNarrateEvents((payload) => {
            received.push(payload);
        });

        expect(createdSource).not.toBeNull();
        expect(createdSource!.url).toBe('/api/narrate/events');
        for (const evtName of expectedEvents) {
            expect(createdSource!.listeners.has(evtName)).toBe(true);
        }

        createdSource!.emit('stage:event', {
            sessionId: 'sess-writer-1',
            stage: 'WRITER',
            kind: 'thinking',
            text: '正在构思起笔意象'
        });
        createdSource!.emit('signal:withdrawn', {
            id: 'sig-1',
            created_at: '2026-11-18T10:00:00.000Z',
            reason: '临时改道'
        });
        createdSource!.emit('volume:advanced', {
            sealedVolume: 1,
            nextVolume: 2,
            tagName: 'vol-01-end',
            archivedEntities: ['npc-a'],
            completedBook: false,
            commitSha: 'abc1234'
        });
        createdSource!.emit('task:idle', { task: 'STEPPING' });
        createdSource!.emit('heal:started', {
            conflictCount: 1,
            resumedFromPlan: false,
            timestamp: '2026-11-18T10:01:00.000Z'
        });
        createdSource!.emit('heal:completed', {
            resultCount: 1,
            quarantined: false,
            resumedFromPlan: false,
            timestamp: '2026-11-18T10:02:00.000Z'
        });
        createdSource!.emit('default_model_changed', {
            defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' }
        });

        expect(received.map((r) => r.event)).toEqual([
            'stage:event',
            'signal:withdrawn',
            'volume:advanced',
            'task:idle',
            'heal:started',
            'heal:completed',
            'default_model_changed'
        ]);
        expect(received[0]?.data['sessionId']).toBe('sess-writer-1');
        expect(received[3]?.data['task']).toBe('STEPPING');

        unsubscribe();
        unsubscribe();
        expect(createdSource!.closed).toBe(true);
    });

    it('requestHalt 支持默认软停机与显式 force 硬中断', async () => {
        mockFetchJson(202, { haltRequested: true, force: false, activeTask: 'STEPPING' });
        const softRes = await requestHalt();
        expect(softRes).toEqual({ haltRequested: true, force: false, activeTask: 'STEPPING' });
        expect(fetchCalls[0]?.url).toBe('/api/narrate/halt');
        expect(fetchCalls[0]?.init?.method).toBe('POST');
        expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({});

        mockFetchJson(202, { haltRequested: true, force: true, activeTask: 'STEPPING' });
        const hardRes = await requestHalt({ force: true });
        expect(hardRes).toEqual({ haltRequested: true, force: true, activeTask: 'STEPPING' });
        expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toEqual({ force: true });
    });

    it('advanceVolume 调用 POST /api/narrate/volume/advance 并返回封卷结果', async () => {
        const expected: AdvanceVolumeResponse = {
            sealedVolume: 1,
            nextVolume: 2,
            tagName: 'vol-01-sealed',
            archivedEntities: ['npc-old'],
            completedBook: false,
            commitSha: 'deadbeef'
        };
        mockFetchJson(200, expected);

        const res = await advanceVolume({
            companionEntityIds: ['char-lin'],
            completeBook: false
        });
        expect(res).toEqual(expected);
        expect(fetchCalls[0]?.url).toBe('/api/narrate/volume/advance');
        expect(fetchCalls[0]?.init?.method).toBe('POST');
        expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
            companionEntityIds: ['char-lin'],
            completeBook: false
        });
    });

    it('forkParallelWindow 与 mergeParallelWindow 对接并行分叉和三方合流路由', async () => {
        const forkResPayload: ParallelForkResponse = {
            windowId: 'win-dock',
            baseTag: 'parallel-win-dock-base',
            baseDay: 12,
            maxChapters: 4,
            globalBroadcast: { weather: 'rain' },
            baseChapter: 8,
            baseEntityIds: ['char-lin'],
            status: 'OPEN',
            createdAt: '2026-11-18T10:00:00.000Z'
        };
        mockFetchJson(200, forkResPayload);
        const forked = await forkParallelWindow({ windowId: 'win-dock' });
        expect(forked).toEqual(forkResPayload);
        expect(fetchCalls[0]?.url).toBe('/api/narrate/parallel/fork');
        expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ windowId: 'win-dock' });

        const mergeResPayload: ParallelMergeResponse = {
            windowId: 'win-dock',
            baseTag: 'parallel-win-dock-base',
            mergedBranches: ['branch-a', 'branch-b'],
            updatedEntities: ['char-lin'],
            updatedL2CardPaths: ['index/vol-01/ch-09.md'],
            previousStoryDay: 12,
            newStoryDay: 14,
            totalChaptersUsed: 2,
            sha: 'feedcafe'
        };
        mockFetchJson(200, mergeResPayload);
        const merged = await mergeParallelWindow({ windowId: 'win-dock' });
        expect(merged).toEqual(mergeResPayload);
        expect(fetchCalls[1]?.url).toBe('/api/narrate/parallel/merge');
        expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toEqual({ windowId: 'win-dock' });
    });

    it('healConflicts 支持空参数自动修补与显式冲突列表提交', async () => {
        const healResPayload: HealConflictsResponse = {
            results: [
                {
                    conflictId: 'c-1',
                    action: 'PATCHED_IN_PLACE',
                    sideALine: 14,
                    sideBLine: 32
                }
            ],
            quarantined: false,
            quarantineReport: null
        };
        mockFetchJson(200, healResPayload);
        const autoRes = await healConflicts();
        expect(autoRes).toEqual(healResPayload);
        expect(fetchCalls[0]?.url).toBe('/api/narrate/heal');
        expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({});

        mockFetchJson(200, healResPayload);
        await healConflicts({
            maxAutoRollbackChapters: 2,
            conflicts: [
                {
                    conflictId: 'c-1',
                    chapterA: 3,
                    quoteA: '左手的伤已痊愈',
                    chapterB: 5,
                    quoteB: '左手依然缠着渗血绷带',
                    description: '伤势状态前后矛盾',
                    severityHint: 'SINGLE_POINT_HARD'
                }
            ]
        });
        expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toMatchObject({
            maxAutoRollbackChapters: 2,
            conflicts: [{ conflictId: 'c-1' }]
        });
    });

    it('fetchViewSyncConflicts 查询 GET /api/narrate/views?kind=sync_conflicts', async () => {
        const payload: SyncConflictsViewPayload = {
            kind: 'sync_conflicts',
            syncConflicts: { conflicts: [] },
            conflicts: [{ chapterNumber: 5, quote: '银钥匙', description: '物品归属冲突' }],
            dirtyChapters: [{ chapterNumber: 3 }],
            stateDiffAdvisories: ['ch-03 状态微调'],
            updatedAt: '2026-11-18T10:05:00.000Z'
        };
        mockFetchJson(200, payload);

        const res = await fetchViewSyncConflicts();
        expect(res).toEqual(payload);
        expect(fetchCalls[0]?.url).toBe('/api/narrate/views?kind=sync_conflicts');
        expect(fetchCalls[0]?.init?.method).toBe('GET');
    });

    it('stepChapter 支持省略 chapterGoal 并透传并行分支字段，postSignal 兼容 reason 与实体字段', async () => {
        mockFetchJson(200, {
            chapterNumber: 9,
            manuscriptPath: 'manuscripts/ch-09.md',
            replanCount: 0,
            rewriteCount: 0,
            patchRounds: 0,
            telemetry: { clicheDensityPer1k: 0.2, mattr500: 0.78, sentenceLengthCv: 0.45 },
            nextChapterOptions: ['延续码头暗线']
        });
        const stepRes = await stepChapter({
            timelineMode: 'PARALLEL',
            parallelWindowId: 'win-dock',
            parallelBranchId: 'branch-b'
        });
        expect(stepRes.nextChapterOptions).toEqual(['延续码头暗线']);
        expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
            timelineMode: 'PARALLEL',
            parallelWindowId: 'win-dock',
            parallelBranchId: 'branch-b'
        });

        mockFetchJson(201, {
            status: 'QUEUED',
            signal: {
                id: 'sig-2',
                type: 'SPOTLIGHT_TRIGGER',
                reason: '切入反派视角',
                entity_id: 'npc-chen',
                chapter: 10
            }
        });
        const sigRes = await postSignal({
            type: 'SPOTLIGHT_TRIGGER',
            reason: '切入反派视角',
            entity_id: 'npc-chen',
            chapter: 10
        });
        expect(sigRes.status).toBe('QUEUED');
        expect(JSON.parse(String(fetchCalls[1]?.init?.body))).toMatchObject({
            type: 'SPOTLIGHT_TRIGGER',
            reason: '切入反派视角',
            entity_id: 'npc-chen'
        });
    });

    it('NarrateStatusPayload 与 NarrateApiError 兼容全量诊断字段及错误透传', async () => {
        const statusSample: NarrateStatusPayload = {
            bookRoot: '/books/demo',
            bookSlug: 'demo',
            title: '示例作品',
            walPhase: 'IDLE',
            activeChapter: 5,
            lastCommittedChapter: 5,
            latestChapter: 5,
            chapterCount: 5,
            entityCount: 12,
            coldArchiveCount: 3,
            worldState: { story_day: 6, current_chapter: 5, timeline_mode: 'MAINLINE' },
            pendingSignalsCount: 1,
            yolo: { running: false, completedChapters: 0, targetChapters: 0, currentStage: null },
            runtime: { activeTask: 'ADVANCING_VOLUME', haltRequested: false },
            txLockHeld: false,
            featCommitSha: '111aaaa',
            stateCommitSha: '222bbbb',
            recentCommits: { featCommitSha: '111aaaa', stateCommitSha: '222bbbb' },
            writerAssemblyReport: {
                chapterNumber: 5,
                estimatedTokens: 3200,
                budget: 8000,
                evictionLevel: 0,
                appliedEvictions: [],
                strippedSecretCount: 2
            },
            lastCheckerResult: {
                chapter: 5,
                passed: true,
                issueCount: 0,
                issues: [],
                filteredOutCount: 1,
                replanCount: 0,
                rewriteCount: 0,
                patchRounds: 1
            },
            dreamWatermark: {
                last_dream_ch: 3,
                accumulated_words_since_dream: 4500,
                updated_at: '2026-11-18T09:00:00.000Z'
            },
            dirtyEntityCount: 2,
            dirtyEntityThreshold: 6,
            spotlightQueue: [],
            nextChapterOptions: ['继续追查线索'],
            nextChapterOptionsSourceChapter: 5,
            openingBeats: {
                total: 2,
                completed: 1,
                pending: 1,
                beats: [{ index: 1, status: 'DONE', rawStatus: 'DONE', text: '雨夜登场' }]
            },
            volumeProgress: {
                currentVolume: 1,
                volumeLabel: '第一卷',
                completedChapters: 5,
                totalChapters: 20
            },
            healPlan: null,
            syncConflictsCount: 0,
            defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
            poolOverrides: { strong_creative: 'openai:gpt-4.1' }
        };
        expect(statusSample.runtime.activeTask).toBe('ADVANCING_VOLUME');

        mockFetchJson(409, { error: '并行窗口存在互斥冲突', issues: [{ slot: 'key' }] }, 'Conflict');
        await expect(mergeParallelWindow({ windowId: 'win-dock' })).rejects.toThrow(NarrateApiError);
    });
});

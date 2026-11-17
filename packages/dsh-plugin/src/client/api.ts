import type {
    BooksListPayload,
    BootBookRequest,
    BootBookResponse,
    ChapterDetail,
    ChaptersListPayload,
    DreamRequest,
    DreamResponse,
    EntitiesViewPayload,
    HaltResponse,
    HaltViewPayload,
    MarkdownViewPayload,
    NarrateStatusPayload,
    PostSignalRequest,
    PostSignalResponse,
    PutChapterRequest,
    PutChapterResponse,
    SelectBookRequest,
    SelectBookResponse,
    SignalsViewPayload,
    SseEventName,
    SseEventPayload,
    StepChapterRequest,
    StepChapterResponse,
    SyncResponse,
    TelemetryViewPayload,
    YoloStartRequest,
    YoloStartResponse,
    YoloStopResponse
} from './types';

/** API 请求异常，包含 HTTP 状态码与可选的校验问题列表 */
export class NarrateApiError extends Error {
    readonly status: number;
    readonly issues?: unknown[] | undefined;

    constructor(message: string, status: number, issues?: unknown[]) {
        super(message);
        this.name = 'NarrateApiError';
        this.status = status;
        this.issues = issues;
    }
}

async function requestJson<T>(url: string, options?: { method?: string; body?: unknown }): Promise<T> {
    const headers: Record<string, string> = {
        Accept: 'application/json'
    };
    const init: RequestInit = {
        method: options?.method ?? 'GET',
        headers
    };

    if (options && options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
    }

    const res = await fetch(url, init);
    const rawText = await res.text();
    let parsed: unknown = null;

    if (rawText.trim().length > 0) {
        try {
            parsed = JSON.parse(rawText);
        } catch {
            parsed = null;
        }
    }

    if (!res.ok) {
        let message = res.statusText || `HTTP ${res.status}`;
        let issues: unknown[] | undefined;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const errObj = parsed as Record<string, unknown>;
            if (typeof errObj['error'] === 'string' && errObj['error'].trim().length > 0) {
                message = errObj['error'];
            }
            if (Array.isArray(errObj['issues'])) {
                issues = errObj['issues'];
            }
        } else if (rawText.trim().length > 0) {
            message = rawText.trim();
        }
        throw new NarrateApiError(message, res.status, issues);
    }

    return (parsed ?? {}) as T;
}

/** 获取 booksRoot 下的作品列表与当前活跃作品 */
export function fetchBooks(): Promise<BooksListPayload> {
    return requestJson<BooksListPayload>('/api/narrate/books');
}

/** 切换当前活跃作品目录 */
export function selectBook(payload: SelectBookRequest): Promise<SelectBookResponse> {
    return requestJson<SelectBookResponse>('/api/narrate/book/select', {
        method: 'POST',
        body: payload
    });
}

/** 执行 Step 0 开书编译并切换至新书 */
export function bootBook(payload: BootBookRequest): Promise<BootBookResponse> {
    return requestJson<BootBookResponse>('/api/narrate/boot', {
        method: 'POST',
        body: payload
    });
}

/** 获取当前作品的全局 WAL / YOLO / 遥测状态 */
export function fetchStatus(): Promise<NarrateStatusPayload> {
    return requestJson<NarrateStatusPayload>('/api/narrate/status');
}

/** 获取当前作品的所有章节摘要列表 */
export function fetchChapters(): Promise<ChaptersListPayload> {
    return requestJson<ChaptersListPayload>('/api/narrate/chapters');
}

/** 读取指定章节正文与 Git HEAD Diff */
export function fetchChapter(chapterNumber: number): Promise<ChapterDetail> {
    const ch = encodeURIComponent(String(chapterNumber));
    return requestJson<ChapterDetail>(`/api/narrate/chapter?ch=${ch}`);
}

/** 保存章节正文修改并自动触发 SHA-256 增量同步 */
export function saveChapter(payload: PutChapterRequest): Promise<PutChapterResponse> {
    return requestJson<PutChapterResponse>('/api/narrate/chapter', {
        method: 'PUT',
        body: payload
    });
}

/** 查询活跃实体档案与冷档案统计 */
export function fetchViewEntities(): Promise<EntitiesViewPayload> {
    return requestJson<EntitiesViewPayload>('/api/narrate/views?kind=entities');
}

/** 查询未来视野（world/future_horizon.md） */
export function fetchViewHorizon(): Promise<MarkdownViewPayload> {
    return requestJson<MarkdownViewPayload>('/api/narrate/views?kind=horizon');
}

/** 查询跨卷未收伏笔（world/open_threads.md） */
export function fetchViewThreads(): Promise<MarkdownViewPayload> {
    return requestJson<MarkdownViewPayload>('/api/narrate/views?kind=threads');
}

/** 查询历史遥测日志（.ops/telemetry.jsonl） */
export function fetchViewTelemetry(): Promise<TelemetryViewPayload> {
    return requestJson<TelemetryViewPayload>('/api/narrate/views?kind=telemetry');
}

/** 查询待消费与历史导演信号（.ops/signals.jsonl） */
export function fetchViewSignals(): Promise<SignalsViewPayload> {
    return requestJson<SignalsViewPayload>('/api/narrate/views?kind=signals');
}

/** 查询 SAFE_HALT 与隔离报告状态 */
export function fetchViewHalt(): Promise<HaltViewPayload> {
    return requestJson<HaltViewPayload>('/api/narrate/views?kind=halt');
}

/** 推进单章生成流水线 */
export function stepChapter(payload: StepChapterRequest): Promise<StepChapterResponse> {
    return requestJson<StepChapterResponse>('/api/narrate/step', {
        method: 'POST',
        body: payload
    });
}

/** 触发全书手改对账同步 */
export function syncManuscripts(): Promise<SyncResponse> {
    return requestJson<SyncResponse>('/api/narrate/sync', {
        method: 'POST',
        body: {}
    });
}

/** 手动触发离线 Dreaming（VACUUM 与跨章自愈） */
export function runDreaming(payload: DreamRequest = {}): Promise<DreamResponse> {
    return requestJson<DreamResponse>('/api/narrate/dream', {
        method: 'POST',
        body: payload
    });
}

/** 向 .ops/signals.jsonl 投递一次性导演信号 */
export function postSignal(payload: PostSignalRequest): Promise<PostSignalResponse> {
    return requestJson<PostSignalResponse>('/api/narrate/signals', {
        method: 'POST',
        body: payload
    });
}

/** 撤回一条未消费导演信号（按 created_at + reason 内容匹配删除） */
export function deleteSignal(payload: {
    created_at: string;
    reason: string;
}): Promise<{ status: string; remaining: number }> {
    return requestJson<{ status: string; remaining: number }>('/api/narrate/signals/delete', {
        method: 'DELETE',
        body: payload
    });
}

/** 请求在安全检查点停机（Safe-Point Halt） */
export function requestHalt(): Promise<HaltResponse> {
    return requestJson<HaltResponse>('/api/narrate/halt', {
        method: 'POST',
        body: {}
    });
}

/** 启动 YOLO 连续自治推进 */
export function startYolo(payload: YoloStartRequest = {}): Promise<YoloStartResponse> {
    return requestJson<YoloStartResponse>('/api/narrate/yolo/start', {
        method: 'POST',
        body: payload
    });
}

/** 请求在本章安全点后优雅停止 YOLO 连跑 */
export function stopYolo(): Promise<YoloStopResponse> {
    return requestJson<YoloStopResponse>('/api/narrate/yolo/stop', {
        method: 'POST',
        body: {}
    });
}

const KNOWN_SSE_EVENTS: readonly SseEventName[] = [
    'connected',
    'book_switched',
    'halt:requested',
    'halt:waiting',
    'halt:completed',
    'sync:started',
    'sync:completed',
    'chapter_synced',
    'chapter:phase',
    'stage',
    'gate:result',
    'checker:result',
    'dream:started',
    'dream:completed',
    'signal:received',
    'telemetry',
    'yolo:stop_requested',
    'yolo_halted',
    'yolo_completed'
];

/**
 * 订阅 /api/narrate/events SSE 实时事件流。
 * 返回幂等取消订阅函数，调用后立即关闭 EventSource 连接。
 */
export function subscribeNarrateEvents(
    onEvent: (event: SseEventPayload) => void,
    onError?: (err: Event) => void
): () => void {
    const source = new EventSource('/api/narrate/events');
    let closed = false;

    const handleEvent = (eventName: string) => (ev: Event) => {
        if (closed) return;
        const msgEvent = ev as MessageEvent<string>;
        const raw = typeof msgEvent.data === 'string' ? msgEvent.data : '';
        let data: Record<string, unknown> = {};
        if (raw.length > 0) {
            try {
                const parsed: unknown = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    data = parsed as Record<string, unknown>;
                } else {
                    data = { value: parsed };
                }
            } catch {
                data = { raw };
            }
        }
        onEvent({ event: eventName, data });
    };

    for (const eventName of KNOWN_SSE_EVENTS) {
        source.addEventListener(eventName, handleEvent(eventName));
    }

    source.onerror = (err) => {
        if (closed) return;
        onError?.(err);
    };

    return () => {
        if (closed) return;
        closed = true;
        source.close();
    };
}

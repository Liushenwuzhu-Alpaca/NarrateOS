import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { appendFile, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { CleanroomRequest, CleanroomResponse, LlmPort } from '../ports/llm.js';

export type TraceLevel = 'full' | 'metadata' | 'off';
export type TraceAttributes = Record<string, string | number | boolean | undefined>;
export interface TraceEvent {
    version: 1;
    run_id: string;
    sequence: number;
    timestamp: string;
    type: string;
    data: Record<string, unknown>;
}
export interface TraceRunInfo {
    version: 1;
    run_id: string;
    operation: string;
    started_at: string;
    level: Exclude<TraceLevel, 'off'>;
    attributes: TraceAttributes;
    status: 'active' | 'unknown' | 'incomplete' | 'ok' | 'error';
    bytes: number;
}
interface RunContext {
    root: string;
    directory: string;
    info: Omit<TraceRunInfo, 'status' | 'bytes'>;
    sequence: number;
    pending: Promise<void>;
    disabled: boolean;
}
const current = new AsyncLocalStorage<RunContext | undefined>();
const stages = new AsyncLocalStorage<{ runId: string; stage: string; stageId: string }>();
const calls = new AsyncLocalStorage<string>();
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function validateId(id: string): void {
    if (!idPattern.test(id)) throw new Error('追踪 ID 格式非法');
}
function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function errorInfo(error: unknown): { name: string; message: string } {
    const message = error instanceof Error ? error.message : String(error);
    return {
        name: error instanceof Error ? error.name : 'Error',
        message: message
            .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
            .replace(/((?:api[_-]?key|token|authorization|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    };
}
function warn(error: unknown): void {
    // 追踪故障仅报告错误类型，不将底层异常中的请求或认证数据写入终端。
    try { process.stderr.write(`[trace] 追踪记录失败，本次记录可能不完整，写作继续 (${(error as NodeJS.ErrnoException)?.code ?? 'IO_ERROR'})\n`); } catch { /* 终端不可写不影响业务 */ }
}
async function checkDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('追踪目录不能是符号链接或普通文件');
}
async function rootDirectory(bookRoot: string, create = false): Promise<string> {
    const ops = join(resolve(bookRoot), '.ops');
    if (create) await mkdir(ops, { recursive: true });
    await checkDirectory(ops);
    const root = join(ops, 'traces');
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    await checkDirectory(root);
    return root;
}
async function runDirectory(bookRoot: string, runId: string): Promise<string> {
    validateId(runId);
    const directory = join(await rootDirectory(bookRoot), runId);
    await checkDirectory(directory);
    return directory;
}
async function readRegular(path: string): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('追踪文件不能是符号链接');
    return await readFile(path, 'utf8');
}
async function configuredLevel(bookRoot: string): Promise<TraceLevel> {
    try {
        const config = parse(await readFile(join(bookRoot, 'world/book_config.yaml'), 'utf8')) as { trace_level?: unknown } | null;
        const level = config?.trace_level ?? 'full';
        if (level !== 'full' && level !== 'metadata' && level !== 'off') throw new Error('trace_level 必须为 full、metadata 或 off');
        return level;
    } catch (error) {
        if (isMissing(error)) return 'full';
        throw error;
    }
}
function enqueue(context: RunContext, action: () => Promise<void>): Promise<void> {
    // 同一运行严格串行写入；第一次日志故障后停止追加，保留可识别的不完整记录。
    context.pending = context.pending.then(async () => {
        if (context.disabled) return;
        try { await action(); } catch (error) { context.disabled = true; warn(error); }
    });
    return context.pending;
}

/** 事件不携带完整输入输出；调用方可等待落盘，也可让顶层操作统一收尾。 */
export function traceEvent(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const context = current.getStore();
    if (!context || context.disabled) return Promise.resolve();
    if (type === 'run.context') Object.assign(context.info.attributes, data);
    const scope = stages.getStore();
    const event: TraceEvent = {
        version: 1, run_id: context.info.run_id, sequence: ++context.sequence,
        timestamp: new Date().toISOString(), type,
        data: { ...context.info.attributes,
            ...(scope?.runId === context.info.run_id ? { stage: scope.stage, stage_id: scope.stageId } : {}),
            call_id: calls.getStore(), ...data }
    };
    return enqueue(context, () => appendFile(join(context.directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 }));
}

/** 保存非模型生成的草稿版本或确定性诊断；metadata 档只保留事件摘要。 */
export async function traceArtifact(kind: string, content: unknown): Promise<void> {
    const context = current.getStore();
    if (!context || context.info.level !== 'full' || context.disabled) return;
    const id = randomUUID();
    await enqueue(context, () => writeFile(join(context.directory, `${id}.output.json`), JSON.stringify({ kind, content }), { flag: 'wx', mode: 0o600 }));
    await traceEvent('artifact.saved', { artifact_id: id, kind });
}

/** 每次实际业务入口建立运行；同书的嵌套操作保留为该运行的阶段。 */
export async function withTraceRun<T>(bookRoot: string, operation: string, attributes: TraceAttributes, work: () => Promise<T>): Promise<T> {
    const root = resolve(bookRoot);
    const parent = current.getStore();
    if (parent?.root === root) return await withTraceStage(operation, work);
    let level: TraceLevel;
    try { level = await configuredLevel(root); }
    catch (error) { warn(error); return await current.run(undefined, work); }
    if (level === 'off') return await current.run(undefined, work);
    let context: RunContext;
    try {
        const traces = await rootDirectory(root, true);
        // 自包含忽略规则在第一次输入落盘前生效，开书初始化 Git 时同样有效。
        const ignore = join(traces, '.gitignore');
        try { await writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (await readRegular(ignore) !== '*\n') throw new Error('追踪目录忽略规则被修改');
        }
        const runId = `${Date.now()}-${randomUUID()}`;
        const directory = join(traces, runId);
        await mkdir(directory, { mode: 0o700 });
        // 先登记所有者，再发布 manifest，避免清理器看到尚未标记活动的运行。
        await writeFile(join(directory, 'active.json'), JSON.stringify({ pid: process.pid, host: hostname() }), { flag: 'wx', mode: 0o600 });
        const info: RunContext['info'] = { version: 1, run_id: runId, operation, started_at: new Date().toISOString(), level, attributes };
        await writeFile(join(directory, 'run.json'), JSON.stringify(info), { flag: 'wx', mode: 0o600 });
        context = { root, directory, info, sequence: 0, pending: Promise.resolve(), disabled: false };
    } catch (error) {
        warn(error);
        return await current.run(undefined, work);
    }
    return await current.run(context, async () => {
        await traceEvent('run.started', { operation });
        try {
            const result = await work();
            await traceEvent('run.finished', { status: 'ok' });
            return result;
        } catch (error) {
            await traceEvent('run.finished', { status: 'error', error: errorInfo(error) });
            throw error;
        } finally {
            await context.pending;
            try { await rm(join(context.directory, 'active.json'), { force: true }); } catch (error) { warn(error); }
        }
    });
}

/** 阶段使用独立关联 ID；同一阶段内部的结构化重试共享该 ID。 */
export async function withTraceStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const context = current.getStore();
    if (!context) return await work();
    return await stages.run({ runId: context.info.run_id, stage, stageId: randomUUID() }, async () => {
        const started = Date.now();
        await traceEvent('stage.started');
        try {
            const result = await work();
            await traceEvent('stage.finished', { status: 'ok', duration_ms: Date.now() - started });
            return result;
        } catch (error) {
            await traceEvent('stage.finished', { status: 'error', duration_ms: Date.now() - started, error: errorInfo(error) });
            throw error;
        }
    });
}

/** 记录 LlmPort 的实际净室请求与返回值，不接触传输层认证信息。 */
export async function generateTraced(llm: LlmPort, request: CleanroomRequest, signal?: AbortSignal, attempt = 1): Promise<CleanroomResponse> {
    const context = current.getStore();
    if (!context) return await llm.generate(request, signal);
    const stage = request.traceStage ?? 'model';
    const scope = stages.getStore();
    if (scope?.runId !== context.info.run_id || scope.stage !== stage) {
        return await withTraceStage(stage, () => generateTraced(llm, request, signal, attempt));
    }
    const callId = randomUUID();
    const started = Date.now();
    const input = { pool: request.pool, staticPrefixBlocks: request.staticPrefixBlocks, dynamicTail: request.dynamicTail,
        temperature: request.temperature, maxTokens: request.maxTokens, reasoningEffort: request.reasoningEffort };
    if (context.info.level === 'full') {
        await enqueue(context, () => writeFile(join(context.directory, `${callId}.input.json`), JSON.stringify(input), { flag: 'wx', mode: 0o600 }));
    }
    await traceEvent('call.started', { call_id: callId, attempt, pool: request.pool });
    try {
        const response = await calls.run(callId, () => llm.generate(request, signal));
        if (context.info.level === 'full') {
            await enqueue(context, () => writeFile(join(context.directory, `${callId}.output.json`), JSON.stringify({
                text: response.text, usage: response.usage, modelId: response.modelId, finishReason: response.finishReason
            }), { flag: 'wx', mode: 0o600 }));
        }
        await traceEvent('call.finished', { call_id: callId, attempt, status: 'ok', model: response.modelId,
            usage: response.usage, duration_ms: Date.now() - started });
        return response;
    } catch (error) {
        await traceEvent('call.finished', { call_id: callId, attempt, status: 'error', error: errorInfo(error), duration_ms: Date.now() - started });
        throw error;
    }
}

async function sizeOf(path: string): Promise<number> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('追踪目录包含符号链接，拒绝读取或清理');
    if (!info.isDirectory()) return info.size;
    let bytes = 0;
    for (const name of await readdir(path)) bytes += await sizeOf(join(path, name));
    return bytes;
}
async function ownerStatus(directory: string): Promise<'active' | 'unknown' | 'incomplete'> {
    let owner: { pid: number; host: string };
    try { owner = JSON.parse(await readRegular(join(directory, 'active.json'))) as typeof owner; }
    catch (error) { if (isMissing(error)) return 'incomplete'; return 'unknown'; }
    if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'unknown';
    try { process.kill(owner.pid, 0); return 'active'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'incomplete' : 'unknown'; }
}

/** 按字节游标读取事件；未写完的末行保留给下一次读取。 */
export async function readTraceEvents(bookRoot: string, runId: string, offset = 0): Promise<{ events: TraceEvent[]; offset: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('事件游标非法');
    const directory = await runDirectory(bookRoot, runId);
    const path = join(directory, 'events.jsonl');
    let handle;
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('事件文件不能是符号链接');
        handle = await open(path, 'r');
    } catch (error) { if (isMissing(error)) return { events: [], offset }; throw error; }
    try {
        const size = (await handle.stat()).size;
        if (offset > size) throw new Error('事件文件被截断，请重新读取');
        const buffer = Buffer.alloc(size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const end = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (end < 0) return { events: [], offset };
        const events = buffer.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map((line) => {
            const event = JSON.parse(line) as TraceEvent;
            if (event.version !== 1 || event.run_id !== runId || typeof event.type !== 'string') throw new Error('追踪事件格式损坏');
            return event;
        });
        return { events, offset: offset + end + 1 };
    } finally { await handle.close(); }
}

export async function inspectTraceRun(bookRoot: string, runId: string): Promise<TraceRunInfo> {
    const directory = await runDirectory(bookRoot, runId);
    const info = JSON.parse(await readRegular(join(directory, 'run.json'))) as TraceRunInfo;
    if (info.version !== 1 || info.run_id !== runId || !['full', 'metadata'].includes(info.level)) throw new Error('运行记录格式损坏');
    const owner = await ownerStatus(directory);
    const { events } = await readTraceEvents(bookRoot, runId);
    for (const event of events) {
        if (event.type !== 'run.context') continue;
        for (const key of ['chapter', 'timeline', 'window', 'branch', 'volume']) {
            const value = event.data[key];
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') info.attributes[key] = value;
        }
    }
    const last = events.at(-1);
    const status = owner === 'active' || owner === 'unknown' ? owner :
        last?.type === 'run.finished' && (last.data['status'] === 'ok' || last.data['status'] === 'error') ? last.data['status'] : 'incomplete';
    return { ...info, status, bytes: await sizeOf(directory) };
}

export async function listTraceRuns(bookRoot: string): Promise<{ runs: TraceRunInfo[]; bytes: number }> {
    let root: string;
    try { root = await rootDirectory(bookRoot); } catch (error) { if (isMissing(error)) return { runs: [], bytes: 0 }; throw error; }
    const runs: TraceRunInfo[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const name = entry.name;
        if (!entry.isDirectory() || !idPattern.test(name)) continue;
        try { runs.push(await inspectTraceRun(bookRoot, name)); }
        catch (error) { if (!isMissing(error)) throw error; }
    }
    return { runs, bytes: await sizeOf(root) };
}

export async function readTraceCall(bookRoot: string, runId: string, callId: string, part: 'input' | 'output'): Promise<unknown> {
    validateId(callId);
    if (part !== 'input' && part !== 'output') throw new Error('内容类型必须为 input 或 output');
    const directory = await runDirectory(bookRoot, runId);
    try { return JSON.parse(await readRegular(join(directory, `${callId}.${part}.json`))) as unknown; }
    catch (error) { if (isMissing(error)) throw new Error('该内容尚未生成、未启用完整追踪，或记录失败'); throw error; }
}

/** 默认仅预览；确认参数必须等于完整 run_id，删除前重新验证活动状态。 */
export async function pruneTraceRun(bookRoot: string, runId: string, confirmation?: string): Promise<TraceRunInfo> {
    const info = await inspectTraceRun(bookRoot, runId);
    if (info.status === 'active' || info.status === 'unknown') throw new Error('活动或所有者不明的运行禁止清理');
    if (confirmation !== undefined) {
        if (confirmation !== runId) throw new Error('清理确认值必须与完整 run_id 一致');
        const directory = await runDirectory(bookRoot, runId);
        if (await ownerStatus(directory) !== 'incomplete') throw new Error('运行仍在活动，禁止清理');
        await rm(directory, { recursive: true });
    }
    return info;
}

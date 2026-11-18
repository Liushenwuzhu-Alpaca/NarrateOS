import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { SystemPort } from '../ports/system.js';
import type { VoiceSamplePool } from '../prefix/types.js';
import { loadVoiceSamples, saveVoiceSamples } from '../prefix/voice-sampler.js';
import {
    parseEntityMarkdown,
    serializeEntityMarkdown,
    splitFrontmatter
} from './entity-parser.js';
import { ENTITY_ID_RE, mergeEntityProfilePatch } from './entity-patch.js';
import {
    BookConfig,
    BookConfigResolved,
    BookConfigSchema,
    BookSnapshot,
    ChapterOutlineSnapshot,
    DirtyChapter,
    DreamWatermark,
    DreamWatermarkSchema,
    EntityPatch,
    EntityProfile,
    ForeignKeyError,
    PlannerOutlineSchema,
    RunRecord,
    RunRecordSchema,
    TimelineMode,
    TxLockConflictError,
    TxLockPayloadSchema,
    TxState,
    TxStateSchema,
    WalPhase,
    WalRecoveryResult,
    WorldState,
    WorldStateFrontmatter,
    WorldStateFrontmatterSchema
} from './schemas.js';

const DEFAULT_LOCK_STALE_MS = 30_000;
const CHAPTER_FILE_RE = /^ch_(\d{4})\.md$/;
const SAGA_SHARD_RE = /_saga_\d+$/;
const BEGIN_DRAFT_ALLOWED_PHASES = new Set<WalPhase>(['IDLE', 'STATE_COMMITTED', 'DREAM_COMMITTED']);
const COMMIT_DRAFT_ALLOWED_PHASES = new Set<WalPhase>(['IDLE', 'DRAFTING', 'STATE_COMMITTED', 'DREAM_COMMITTED']);
const PendingWritesSchema = z.object({
    baseWal: z.string().nullable(),
    baseRevision: z.string(),
    paths: z.array(z.string().min(1).refine((path) =>
        !isAbsolute(path) && !path.split(/[\\/]/).some((part) => part === '..' || part === '.git')))
});

export type LockAcquireSerializer = <T>(fn: () => Promise<T>) => Promise<T>;

export interface TxLockOptions {
    staleMs?: number | undefined;
}

export interface ApplyStatePatchOptions {
    allowInnateMutation?: boolean | undefined;
    timelineMode?: TimelineMode | undefined;
    worldStateUpdate?: (Partial<WorldStateFrontmatter> & { summaryMarkdown?: string | undefined }) | undefined;
    extraCommitPaths?: string[] | undefined;
}

/** commitDraft 可选载荷：随正文 feat 原子提交的最终细纲快照 */
export interface CommitDraftOptions {
    /** 本章实际使用的 PlannerOutline（改纲后为最终 v2，接受可缺省字段的原始输入）；不传则保留既有快照不覆盖 */
    outline?: z.input<typeof PlannerOutlineSchema> | undefined;
}

function formatChapterKey(chapterNumber: number): string {
    return `ch_${String(chapterNumber).padStart(4, '0')}`;
}

function formatChapterTag(chapterNumber: number): string {
    return `ch-${String(chapterNumber).padStart(4, '0')}`;
}

function sha256Hex(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        return code !== 'ESRCH';
    }
}

/** 作品纯文本数据库存储与原子事务层 */
export class BookStore {
    private readonly lockContext = new AsyncLocalStorage<boolean>();
    private acquireQueue: Promise<void> = Promise.resolve();

    constructor(
        public readonly bookRoot: string,
        private readonly system: SystemPort,
        private readonly runAcquireSerialized?: LockAcquireSerializer
    ) {}

    private serializeLockAcquire<T>(fn: () => Promise<T>): Promise<T> {
        if (this.runAcquireSerialized) {
            return this.runAcquireSerialized(fn);
        }
        const task = this.acquireQueue.then(fn, fn);
        this.acquireQueue = task.then(
            () => undefined,
            () => undefined
        );
        return task;
    }

    private get opsDir(): string {
        return join(this.bookRoot, '.ops');
    }

    private get txLockPath(): string {
        return join(this.opsDir, 'tx.lock');
    }

    private get txStatePath(): string {
        return join(this.opsDir, 'tx_state.json');
    }

    private get configPath(): string {
        return join(this.bookRoot, 'world/book_config.yaml');
    }

    private get worldStatePath(): string {
        return join(this.bookRoot, 'world/world_state.md');
    }

    private get entitiesDir(): string {
        return join(this.bookRoot, 'entities');
    }

    private get coldArchiveDir(): string {
        return join(this.entitiesDir, 'cold_archive');
    }

    private get manuscriptsDir(): string {
        return join(this.bookRoot, 'manuscripts');
    }

    private get chapterOutlinesDir(): string {
        return join(this.opsDir, 'chapter_outlines');
    }

    /** 在 .ops/tx.lock 排他文件锁保护下执行临界区操作（严格互斥） */
    async withTxLock<T>(fn: () => Promise<T>, options?: TxLockOptions): Promise<T> {
        await mkdir(this.opsDir, { recursive: true });
        const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
        const payload = JSON.stringify({
            pid: process.pid,
            owner: randomUUID(),
            acquiredAt: new Date().toISOString()
        });

        await this.serializeLockAcquire(async () => {
            let acquired = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const handle = await open(this.txLockPath, 'wx');
                    try {
                        await handle.writeFile(payload, 'utf8');
                    } finally {
                        await handle.close();
                    }
                    acquired = true;
                    break;
                } catch (err: unknown) {
                    const code = (err as { code?: string }).code;
                    if (code !== 'EEXIST') {
                        throw err;
                    }

                    // 首次遇到已存在锁时检查是否过期或死进程残留
                    if (attempt === 0 && (await this.tryCleanupStaleLock(staleMs))) {
                        continue;
                    }

                    throw new TxLockConflictError(`作品仓库事务锁被占用: ${this.txLockPath}`);
                }
            }

            if (!acquired) {
                throw new TxLockConflictError(`无法获取作品仓库事务锁: ${this.txLockPath}`);
            }
        });

        try {
            return await this.lockContext.run(true, fn);
        } finally {
            try {
                if (await readFile(this.txLockPath, 'utf8') === payload) {
                    await unlink(this.txLockPath);
                }
            } catch (err: unknown) {
                const code = (err as { code?: string }).code;
                if (code !== 'ENOENT') {
                    throw err;
                }
            }
        }
    }

    /** 内部事务辅助：仅允许同一异步调用链重入已持有的事务锁，拦截跨异步任务并发 */
    async runWithTxLock<T>(fn: () => Promise<T>): Promise<T> {
        if (this.lockContext.getStore() === true) {
            return await fn();
        }
        return await this.withTxLock(fn);
    }

    private isLockPayloadStale(raw: string, mtimeMs: number, staleMs: number): boolean {
        let payload: unknown = null;
        try {
            payload = JSON.parse(raw);
        } catch {
            payload = null;
        }
        const parsed = TxLockPayloadSchema.safeParse(payload);
        if (parsed.success) {
            return !isProcessAlive(parsed.data.pid);
        }
        return Date.now() - mtimeMs >= staleMs;
    }

    private async tryCleanupStaleLock(staleMs: number): Promise<boolean> {
        let staleTempPath: string | null = null;
        try {
            const lockStatBefore = await stat(this.txLockPath);
            const raw = await readFile(this.txLockPath, 'utf8');
            if (!this.isLockPayloadStale(raw, lockStatBefore.mtimeMs, staleMs)) {
                return false;
            }

            // 原子重命名后再校验 inode 与内容一致，防止竞态误删并发方刚创建的新锁
            staleTempPath = join(this.opsDir, `tx.lock.stale.${randomUUID()}`);
            await rename(this.txLockPath, staleTempPath);

            const [movedStat, movedRaw] = await Promise.all([
                stat(staleTempPath),
                readFile(staleTempPath, 'utf8')
            ]);
            if (movedStat.ino === lockStatBefore.ino && movedRaw === raw) {
                await unlink(staleTempPath);
                return true;
            }

            if (!this.isLockPayloadStale(movedRaw, movedStat.mtimeMs, staleMs)) {
                // 使用 POSIX link(2) 原子恢复，目标已存在新锁时严格抛 EEXIST，绝不覆盖活跃锁
                try {
                    await link(staleTempPath, this.txLockPath);
                } catch {
                    // 目标已出现新锁时不覆盖
                } finally {
                    await unlink(staleTempPath).catch(() => undefined);
                }
                return false;
            }

            await unlink(staleTempPath);
            return true;
        } catch {
            if (staleTempPath) {
                await unlink(staleTempPath).catch(() => undefined);
            }
            return false;
        }
    }

    /** 读取并校验 world/book_config.yaml */
    async readBookConfig(): Promise<BookConfigResolved> {
        const raw = await readFile(this.configPath, 'utf8');
        const parsed = parseYaml(raw) as unknown;
        return BookConfigSchema.parse(parsed);
    }

    /** 校验并写入 world/book_config.yaml */
    async writeBookConfig(config: BookConfig): Promise<void> {
        const validated = BookConfigSchema.parse(config);
        await mkdir(join(this.bookRoot, 'world'), { recursive: true });
        await writeFile(this.configPath, stringifyYaml(validated, { lineWidth: 0 }), 'utf8');
    }

    /** 读取并校验 world/world_state.md */
    async readWorldState(): Promise<WorldState> {
        const raw = await readFile(this.worldStatePath, 'utf8');
        const { rawYaml, body } = splitFrontmatter(raw);
        const frontmatter = WorldStateFrontmatterSchema.parse(parseYaml(rawYaml) as unknown);
        return {
            frontmatter,
            summaryMarkdown: body.trimStart()
        };
    }

    /** 校验并写入 world/world_state.md */
    async writeWorldState(state: WorldState): Promise<void> {
        const frontmatter = WorldStateFrontmatterSchema.parse(state.frontmatter);
        await mkdir(join(this.bookRoot, 'world'), { recursive: true });
        const yamlBlock = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
        const body = state.summaryMarkdown.trimEnd();
        const content = body.length > 0 ? `---\n${yamlBlock}\n---\n\n${body}\n` : `---\n${yamlBlock}\n---\n`;
        await writeFile(this.worldStatePath, content, 'utf8');
    }

    private async readOptionalRelativeText(relPath: string): Promise<string | null> {
        try {
            return await readFile(join(this.bookRoot, relPath), 'utf8');
        } catch (err: unknown) {
            if ((err as { code?: string }).code === 'ENOENT') {
                return null;
            }
            throw err;
        }
    }

    private async writeRelativeText(relPath: string, content: string): Promise<void> {
        const fullPath = join(this.bookRoot, relPath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, 'utf8');
    }

    /** 读取《作者契约》world/author_charter.md */
    async readAuthorCharter(): Promise<string | null> {
        return await this.readOptionalRelativeText('world/author_charter.md');
    }

    /** 写入《作者契约》world/author_charter.md */
    async writeAuthorCharter(content: string): Promise<void> {
        await this.writeRelativeText('world/author_charter.md', content);
    }

    /** 读取《导演禁区计划》world/arc_director_plan.md */
    async readArcDirectorPlan(): Promise<string | null> {
        return await this.readOptionalRelativeText('world/arc_director_plan.md');
    }

    /** 写入《导演禁区计划》world/arc_director_plan.md */
    async writeArcDirectorPlan(content: string): Promise<void> {
        await this.writeRelativeText('world/arc_director_plan.md', content);
    }

    /** 读取《写手正向卷纲》world/current_arc_envelope.md */
    async readCurrentArcEnvelope(): Promise<string | null> {
        return await this.readOptionalRelativeText('world/current_arc_envelope.md');
    }

    /** 写入《写手正向卷纲》world/current_arc_envelope.md */
    async writeCurrentArcEnvelope(content: string): Promise<void> {
        await this.writeRelativeText('world/current_arc_envelope.md', content);
    }

    /** 读取《写手静态基线》world/static_base_and_voice.md */
    async readStaticBaseAndVoice(): Promise<string | null> {
        return await this.readOptionalRelativeText('world/static_base_and_voice.md');
    }

    /** 写入《写手静态基线》world/static_base_and_voice.md */
    async writeStaticBaseAndVoice(content: string): Promise<void> {
        await this.writeRelativeText('world/static_base_and_voice.md', content);
    }

    /** 读取《动态风格补丁》world/ops_style_amendments.md */
    async readOpsStyleAmendments(): Promise<string | null> {
        return await this.readOptionalRelativeText('world/ops_style_amendments.md');
    }

    /** 写入《动态风格补丁》world/ops_style_amendments.md */
    async writeOpsStyleAmendments(content: string): Promise<void> {
        await this.writeRelativeText('world/ops_style_amendments.md', content);
    }

    /** 读取《世界默认惯性表》world/future_horizon.md */
    async readFutureHorizon(): Promise<string | null> {
        return await this.readOptionalRelativeText('world/future_horizon.md');
    }

    /** 写入《世界默认惯性表》world/future_horizon.md */
    async writeFutureHorizon(content: string): Promise<void> {
        await this.writeRelativeText('world/future_horizon.md', content);
    }

    /** 读取《跨卷必收伏笔台账》world/open_threads.md */
    async readOpenThreads(): Promise<string | null> {
        return await this.readOptionalRelativeText('world/open_threads.md');
    }

    /** 写入《跨卷必收伏笔台账》world/open_threads.md */
    async writeOpenThreads(content: string): Promise<void> {
        await this.writeRelativeText('world/open_threads.md', content);
    }

    /** 读取动态声纹标本池 .ops/voice_samples.yaml（不存在时返回空池） */
    async readVoiceSamples(): Promise<VoiceSamplePool> {
        return await loadVoiceSamples(join(this.opsDir, 'voice_samples.yaml'));
    }

    /** 校验并写入动态声纹标本池 .ops/voice_samples.yaml */
    async writeVoiceSamples(pool: VoiceSamplePool): Promise<void> {
        await saveVoiceSamples(join(this.opsDir, 'voice_samples.yaml'), pool);
    }

    /** 读取周期 Dreaming 水位 .ops/dream_watermark.json（不存在时返回 null） */
    async readDreamWatermark(): Promise<DreamWatermark | null> {
        const raw = await this.readOptionalRelativeText('.ops/dream_watermark.json');
        if (raw === null) {
            return null;
        }
        return DreamWatermarkSchema.parse(JSON.parse(raw));
    }

    /** 校验并写入周期 Dreaming 水位 .ops/dream_watermark.json */
    async writeDreamWatermark(watermark: DreamWatermark): Promise<void> {
        const validated = DreamWatermarkSchema.parse(watermark);
        await mkdir(this.opsDir, { recursive: true });
        await writeFile(
            join(this.opsDir, 'dream_watermark.json'),
            `${JSON.stringify(validated, null, 4)}\n`,
            'utf8'
        );
    }

    /** 追加写入单条工种/整理会话索引记录至 .ops/runs.jsonl */
    async appendRunRecord(record: RunRecord): Promise<RunRecord> {
        const validated = RunRecordSchema.parse(record);
        await mkdir(this.opsDir, { recursive: true });
        await appendFile(join(this.opsDir, 'runs.jsonl'), `${JSON.stringify(validated)}\n`, 'utf8');
        return validated;
    }

    /** 读取并按条件过滤 .ops/runs.jsonl 会话索引记录 */
    async listRunRecords(filter?: {
        chapter?: number | undefined;
        runId?: string | undefined;
        role?: string | undefined;
    }): Promise<RunRecord[]> {
        const raw = await this.readOptionalRelativeText('.ops/runs.jsonl');
        if (raw === null) {
            return [];
        }
        const records: RunRecord[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            const parsed = RunRecordSchema.parse(JSON.parse(trimmed));
            if (filter?.chapter !== undefined && parsed.chapter !== filter.chapter) continue;
            if (filter?.runId !== undefined && parsed.runId !== filter.runId) continue;
            if (filter?.role !== undefined && parsed.role !== filter.role) continue;
            records.push(parsed);
        }
        return records;
    }

    /** 读取 .ops/tx_state.json，不存在时返回默认 IDLE 状态 */
    async readTxState(): Promise<TxState> {
        try {
            const raw = await readFile(this.txStatePath, 'utf8');
            return TxStateSchema.parse(JSON.parse(raw));
        } catch (err: unknown) {
            const code = (err as { code?: string }).code;
            if (code === 'ENOENT') {
                return {
                    phase: 'IDLE',
                    active_chapter: null,
                    last_committed_ch: 0,
                    chapter_hashes: {},
                    updated_at: new Date().toISOString()
                };
            }
            throw err;
        }
    }

    private async writeTxState(state: TxState): Promise<void> {
        await mkdir(this.opsDir, { recursive: true });
        const validated = TxStateSchema.parse({
            ...state,
            updated_at: new Date().toISOString()
        });
        await writeFile(this.txStatePath, `${JSON.stringify(validated, null, 4)}\n`, 'utf8');
    }

    /** 从当前磁盘手稿目录初始化 .ops/tx_state.json（用于夹具或开书初始化） */
    async initializeWalFromDisk(): Promise<TxState> {
        return await this.runWithTxLock(async () => {
            const chapterFiles = await this.listChapterFiles();
            const chapterHashes: Record<string, string> = {};
            let maxChapter = 0;

            for (const fileName of chapterFiles) {
                const match = CHAPTER_FILE_RE.exec(fileName);
                if (!match?.[1]) continue;
                const chNum = Number(match[1]);
                if (chNum > maxChapter) maxChapter = chNum;
                const content = await readFile(join(this.manuscriptsDir, fileName), 'utf8');
                chapterHashes[formatChapterKey(chNum)] = sha256Hex(content);
            }

            const state: TxState = {
                phase: 'IDLE',
                active_chapter: null,
                last_committed_ch: maxChapter,
                chapter_hashes: chapterHashes,
                updated_at: new Date().toISOString()
            };
            await this.writeTxState(state);
            return state;
        });
    }

    private async listChapterFiles(): Promise<string[]> {
        try {
            const entries = await readdir(this.manuscriptsDir);
            return entries.filter((name) => CHAPTER_FILE_RE.test(name)).sort();
        } catch (err: unknown) {
            const code = (err as { code?: string }).code;
            if (code === 'ENOENT') return [];
            throw err;
        }
    }

    /** 加载全量工作区只读快照 */
    async loadSnapshot(): Promise<BookSnapshot> {
        const [config, worldState, txState, chapterFiles] = await Promise.all([
            this.readBookConfig(),
            this.readWorldState(),
            this.readTxState(),
            this.listChapterFiles()
        ]);

        const entities: Record<string, EntityProfile> = {};
        try {
            const files = await readdir(this.entitiesDir);
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const raw = await readFile(join(this.entitiesDir, file), 'utf8');
                const profile = parseEntityMarkdown(raw);
                entities[profile.metadata.entity_id] = profile;
            }
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') throw err;
        }

        const coldArchiveIds: string[] = [];
        try {
            const coldFiles = await readdir(this.coldArchiveDir);
            for (const file of coldFiles) {
                if (!file.endsWith('.md')) continue;
                const base = file.slice(0, -3);
                if (ENTITY_ID_RE.test(base) && !SAGA_SHARD_RE.test(base)) {
                    coldArchiveIds.push(base);
                }
            }
            coldArchiveIds.sort();
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') throw err;
        }

        return {
            config,
            worldState,
            txState,
            entities,
            coldArchiveIds,
            chapterFiles
        };
    }

    /** 读取单个冷宫归档实体档案（entities/cold_archive/{entityId}.md），不存在时返回 null */
    async readColdArchivedEntity(entityId: string): Promise<EntityProfile | null> {
        if (!ENTITY_ID_RE.test(entityId) || SAGA_SHARD_RE.test(entityId)) {
            throw new Error(`非法的冷宫实体 ID: ${entityId}`);
        }
        const coldPath = join(this.coldArchiveDir, `${entityId}.md`);
        try {
            const raw = await readFile(coldPath, 'utf8');
            return parseEntityMarkdown(raw);
        } catch (err: unknown) {
            if ((err as { code?: string }).code === 'ENOENT') {
                return null;
            }
            throw err;
        }
    }

    /** 批量读取指定冷宫归档实体档案（跳过不存在项） */
    async readColdArchivedEntities(entityIds: string[]): Promise<Record<string, EntityProfile>> {
        const result: Record<string, EntityProfile> = {};
        for (const entityId of new Set(entityIds)) {
            const profile = await this.readColdArchivedEntity(entityId);
            if (profile) {
                result[entityId] = profile;
            }
        }
        return result;
    }

    async recordPendingWrites(paths: string[]): Promise<void> {
        const record = PendingWritesSchema.parse({
            baseWal: await this.system.readFileAtRef(this.bookRoot, 'HEAD', '.ops/tx_state.json'),
            baseRevision: await this.system.currentRevision(this.bookRoot),
            paths: [...new Set([...paths, '.ops/tx_state.json'])]
        });
        await mkdir(this.opsDir, { recursive: true });
        const temporaryPath = join(this.opsDir, 'pending_writes.tmp');
        await writeFile(temporaryPath, JSON.stringify(record), 'utf8');
        await rename(temporaryPath, join(this.opsDir, 'pending_writes.json'));
    }

    private async restorePendingWrites(committedRaw: string, fallbackPaths: string[]): Promise<void> {
        const pendingPath = join(this.opsDir, 'pending_writes.json');
        let paths = fallbackPaths;
        try {
            const record = PendingWritesSchema.parse(JSON.parse(await readFile(pendingPath, 'utf8')));
            paths = record.baseRevision === await this.system.currentRevision(this.bookRoot) && record.baseWal === committedRaw ? record.paths : fallbackPaths;
        } catch (error: unknown) {
            if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const backupRoot = join(this.opsDir, 'recovery', randomUUID());
        for (const path of paths) {
            try {
                const content = await readFile(join(this.bookRoot, path));
                const backupPath = join(backupRoot, path);
                await mkdir(dirname(backupPath), { recursive: true });
                await writeFile(backupPath, content);
            } catch (error: unknown) {
                if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
            }
        }
        await this.system.restorePaths(this.bookRoot, paths);
        await rm(pendingPath, { force: true });
    }

    /** 标记进入起草相位 (IDLE/STATE_COMMITTED/DREAM_COMMITTED -> DRAFTING) */
    async beginDraft(chapterNumber: number): Promise<TxState> {
        return await this.runWithTxLock(async () => {
            const current = await this.readTxState();
            if (!BEGIN_DRAFT_ALLOWED_PHASES.has(current.phase)) {
                throw new Error(`非法 WAL 状态迁移: 无法从 ${current.phase} 进入 DRAFTING`);
            }
            const next: TxState = {
                ...current,
                phase: 'DRAFTING',
                active_chapter: chapterNumber,
                updated_at: new Date().toISOString()
            };
            await this.writeTxState(next);
            return next;
        });
    }

    /** 原子提交第 1 粒度：正文真源 + SHA-256 指纹 + 可选细纲快照 -> feat(ch-XXXX) */
    async commitDraft(chapterNumber: number, manuscriptText: string, context?: TxState['chapter_context'], options?: CommitDraftOptions): Promise<{ sha: string; txState: TxState }> {
        return await this.runWithTxLock(async () => {
            const current = await this.readTxState();
            if (!COMMIT_DRAFT_ALLOWED_PHASES.has(current.phase)) {
                throw new Error(`非法 WAL 状态迁移: 无法从 ${current.phase} 执行 commitDraft`);
            }

            await mkdir(this.manuscriptsDir, { recursive: true });
            const chKey = formatChapterKey(chapterNumber);
            const relChapterPath = `manuscripts/${chKey}.md`;
            const commitPaths = [relChapterPath];

            // 细纲是规划快照而非剧情真源：仅在显式传入时随正文同笔 feat 落盘并纳入写集恢复；
            // 手改 Sync 等不带细纲的重提交绝不覆盖既有快照
            if (options?.outline !== undefined) {
                const relOutlinePath = `.ops/chapter_outlines/${chKey}.json`;
                await this.recordPendingWrites([relChapterPath, relOutlinePath]);
                await mkdir(this.chapterOutlinesDir, { recursive: true });
                const validated = PlannerOutlineSchema.parse(options.outline);
                await writeFile(join(this.bookRoot, relOutlinePath), `${JSON.stringify(validated, null, 4)}\n`, 'utf8');
                commitPaths.push(relOutlinePath);
            } else {
                await this.recordPendingWrites([relChapterPath]);
            }
            await writeFile(join(this.bookRoot, relChapterPath), manuscriptText, 'utf8');
            commitPaths.push('.ops/tx_state.json');

            const next: TxState = {
                ...current,
                phase: 'FEAT_COMMITTED',
                chapter_context: context,
                active_chapter: chapterNumber,
                chapter_hashes: {
                    ...current.chapter_hashes,
                    [chKey]: sha256Hex(manuscriptText)
                },
                updated_at: new Date().toISOString()
            };
            await this.writeTxState(next);

            const commitRes = await this.system.commitPaths(
                this.bookRoot,
                commitPaths,
                `feat(${formatChapterTag(chapterNumber)}): settle manuscript`
            );
            await rm(join(this.opsDir, 'pending_writes.json'), { force: true });
            return { sha: commitRes.sha, txState: next };
        });
    }

    /**
     * 读取指定章节的持久化细纲快照（规划快照，非剧情真源）。
     * missing=该章从未留存细纲（旧章诚实缺失，不捏造）；error=快照损坏或非法，正文不受影响。
     * 返回原始 JSON 字符串交由展示层既有解析器复用，不在此处泄漏原始异常或路径。
     */
    async readChapterOutline(chapterNumber: number): Promise<ChapterOutlineSnapshot> {
        const relPath = `.ops/chapter_outlines/${formatChapterKey(chapterNumber)}.json`;
        let raw: string;
        try {
            raw = await readFile(join(this.bookRoot, relPath), 'utf8');
        } catch (err: unknown) {
            if ((err as { code?: string }).code === 'ENOENT') {
                return { outlineText: null, status: 'missing' };
            }
            return { outlineText: null, status: 'error' };
        }
        try {
            PlannerOutlineSchema.parse(JSON.parse(raw));
        } catch {
            return { outlineText: null, status: 'error' };
        }
        return { outlineText: raw, status: 'available' };
    }

    /** 原子提交第 2 粒度：行级补丁合并 + 固有锁保护 + 1ms 外键可达性校验 -> state(ch-XXXX) */
    async applyStatePatch(
        chapterNumber: number,
        patches: EntityPatch[],
        options?: ApplyStatePatchOptions
    ): Promise<{ sha: string; txState: TxState; updatedEntities: string[] }> {
        return await this.runWithTxLock(async () => {
            const currentTx = await this.readTxState();
            if (currentTx.phase !== 'FEAT_COMMITTED') {
                throw new Error(`非法 WAL 状态迁移: 无法从 ${currentTx.phase} 执行 applyStatePatch，需先处于 FEAT_COMMITTED`);
            }

            await mkdir(this.entitiesDir, { recursive: true });

            const allowInnate = options?.allowInnateMutation === true;
            const effectiveTimelineMode: TimelineMode =
                options?.timelineMode ?? currentTx.chapter_context?.timelineMode ?? 'MAINLINE';
            const stagedProfiles = new Map<string, EntityProfile>();
            const pendingNewEntityIds = new Set<string>();
            const wokenColdArchiveIds = new Set<string>();

            // 第一阶段：在内存中校验时间线写保护、entity_id、加载（含冷宫回查）并合并所有补丁
            for (const patch of patches) {
                if (!ENTITY_ID_RE.test(patch.entity_id)) {
                    throw new Error(`非法的 entity_id 格式: ${patch.entity_id}`);
                }

                if (effectiveTimelineMode === 'FLASHBACK') {
                    if (
                        (patch.acquired_state_ops && patch.acquired_state_ops.length > 0) ||
                        (patch.buffer_ops && patch.buffer_ops.length > 0)
                    ) {
                        throw new Error(
                            `FLASHBACK 模式下严禁修改实体 ${patch.entity_id} 的 2. Acquired State 或 4. Recent Buffer`
                        );
                    }
                }

                const entityPath = join(this.entitiesDir, `${patch.entity_id}.md`);
                let existing: EntityProfile | null = stagedProfiles.get(patch.entity_id) ?? null;

                if (!existing) {
                    try {
                        const raw = await readFile(entityPath, 'utf8');
                        existing = parseEntityMarkdown(raw);
                    } catch (err: unknown) {
                        if ((err as { code?: string }).code !== 'ENOENT') throw err;

                        const coldProfile = SAGA_SHARD_RE.test(patch.entity_id)
                            ? null
                            : await this.readColdArchivedEntity(patch.entity_id);
                        if (coldProfile) {
                            if (effectiveTimelineMode !== 'MAINLINE') {
                                throw new Error(
                                    `${effectiveTimelineMode} 模式下禁止将冷宫实体 ${patch.entity_id} 迁回主线 entities/`
                                );
                            }
                            existing = coldProfile;
                            wokenColdArchiveIds.add(patch.entity_id);
                        } else {
                            pendingNewEntityIds.add(patch.entity_id);
                        }
                    }
                }

                const merged = this.mergeEntityPatch(existing, patch, allowInnate);
                stagedProfiles.set(patch.entity_id, merged);
            }

            // 第二阶段：1ms 跨文件外键可达性校验
            const reachableKeys = await this.buildReachableKeySet(pendingNewEntityIds);
            for (const [entityId, profile] of stagedProfiles.entries()) {
                const serialized = serializeEntityMarkdown(profile);
                this.assertForeignKeysReachable(entityId, serialized, reachableKeys);
            }

            // 第三阶段：全部校验通过后落盘（含冷宫唤醒写回与旧档删除双路径）并提交 Git
            const coldArchiveRelPaths = [...wokenColdArchiveIds].map((id) => `entities/cold_archive/${id}.md`);
            await this.recordPendingWrites([
                ...[...stagedProfiles.keys()].map((id) => `entities/${id}.md`),
                ...coldArchiveRelPaths,
                ...(options?.worldStateUpdate ? ['world/world_state.md'] : []),
                ...(options?.extraCommitPaths ?? [])
            ]);
            const commitPaths: string[] = [];
            const updatedEntities: string[] = [];
            for (const [entityId, profile] of stagedProfiles.entries()) {
                const relPath = `entities/${entityId}.md`;
                await writeFile(join(this.bookRoot, relPath), serializeEntityMarkdown(profile), 'utf8');
                commitPaths.push(relPath);
                updatedEntities.push(entityId);
            }
            for (const wokenId of wokenColdArchiveIds) {
                const coldRelPath = `entities/cold_archive/${wokenId}.md`;
                await unlink(join(this.bookRoot, coldRelPath));
                commitPaths.push(coldRelPath);
            }

            if (options?.worldStateUpdate) {
                const currentWorld = await this.readWorldState();
                const { summaryMarkdown, ...fmPatch } = options.worldStateUpdate;
                await this.writeWorldState({
                    frontmatter: {
                        ...currentWorld.frontmatter,
                        ...fmPatch
                    },
                    summaryMarkdown: summaryMarkdown ?? currentWorld.summaryMarkdown
                });
                commitPaths.push('world/world_state.md');
            }

            if (options?.extraCommitPaths) {
                commitPaths.push(...options.extraCommitPaths);
            }

            const nextTx: TxState = {
                ...currentTx,
                phase: 'STATE_COMMITTED',
                active_chapter: chapterNumber,
                last_committed_ch: Math.max(currentTx.last_committed_ch, chapterNumber),
                updated_at: new Date().toISOString()
            };
            await this.writeTxState(nextTx);
            commitPaths.push('.ops/tx_state.json');

            const commitRes = await this.system.commitPaths(
                this.bookRoot,
                commitPaths,
                `state(${formatChapterTag(chapterNumber)}): update entity pages & L2 card`
            );
            await rm(join(this.opsDir, 'pending_writes.json'), { force: true });

            return {
                sha: commitRes.sha,
                txState: nextTx,
                updatedEntities
            };
        });
    }

    /** 校验当前 WAL 相位是否允许启动 Dreaming（拒绝未完成的 DRAFTING 与 FEAT_COMMITTED 相位） */
    async assertDreamingPhaseSafe(): Promise<TxState> {
        const current = await this.readTxState();
        if (!BEGIN_DRAFT_ALLOWED_PHASES.has(current.phase)) {
            throw new Error(`非法 WAL 状态迁移: 无法从 ${current.phase} 执行 Dreaming`);
        }
        return current;
    }

    /** 标记睡眠整理提交 (DREAM_COMMITTED) */
    async markDreamCommitted(chapterNumber: number, extraPaths: string[] = []): Promise<TxState> {
        return await this.runWithTxLock(async () => {
            const current = await this.assertDreamingPhaseSafe();
            await this.recordPendingWrites(extraPaths);
            const next: TxState = {
                ...current,
                phase: 'DREAM_COMMITTED',
                active_chapter: null,
                updated_at: new Date().toISOString()
            };
            await this.writeTxState(next);
            await this.system.commitPaths(
                this.bookRoot,
                [...extraPaths, '.ops/tx_state.json'],
                `dream(${formatChapterTag(chapterNumber)}): vacuum & archive`
            );
            await rm(join(this.opsDir, 'pending_writes.json'), { force: true });
            return next;
        });
    }

    /** 崩溃恢复：检查 WAL 相位并清理未提交脏文件 */
    async recoverWal(): Promise<WalRecoveryResult> {
        const result = await this.runWithTxLock(async (): Promise<Omit<WalRecoveryResult, 'clean'>> => {
            let txState = await this.readTxState();
            const committedRaw = await this.system.readFileAtRef(this.bookRoot, 'HEAD', '.ops/tx_state.json');
            if (committedRaw === null) {
                throw new Error('无法恢复 WAL：Git 中缺少已提交事务状态');
            }
            const committed = TxStateSchema.parse(JSON.parse(committedRaw));
            if (txState.phase !== 'DRAFTING' && JSON.stringify(txState) === JSON.stringify(committed)) {
                try {
                    await stat(join(this.opsDir, 'pending_writes.json'));
                    await this.restorePendingWrites(committedRaw, ['.ops/tx_state.json']);
                } catch (error: unknown) {
                    if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
                }
            }
            if (txState.phase !== 'DRAFTING' && JSON.stringify(txState) !== JSON.stringify(committed)) {
                const pendingChapter = txState.active_chapter;
                const pendingDraft = txState.phase === 'FEAT_COMMITTED' && committed.phase !== 'FEAT_COMMITTED';
                await this.restorePendingWrites(committedRaw, ['.ops/tx_state.json']);
                txState = committed;
                if (pendingDraft) {
                    return {
                        action: 'ROLLED_BACK_DRAFT',
                        phase: committed.phase,
                        activeChapter: pendingChapter
                    };
                }
            }

            if (txState.phase === 'DRAFTING') {
                const paths = ['.ops/tx_state.json'];
                if (txState.active_chapter !== null && !txState.chapter_hashes[formatChapterKey(txState.active_chapter)]) {
                    paths.push(`manuscripts/${formatChapterKey(txState.active_chapter)}.md`);
                }
                await this.restorePendingWrites(committedRaw, paths);
                const restored = await this.readTxState();
                return {
                    action: 'ROLLED_BACK_DRAFT',
                    phase: restored.phase,
                    activeChapter: txState.active_chapter
                };
            }

            if (txState.phase === 'FEAT_COMMITTED') {
                await this.restorePendingWrites(committedRaw, ['.ops/tx_state.json']);
                return {
                    action: 'NEEDS_STATE_EXTRACTION',
                    phase: 'FEAT_COMMITTED',
                    activeChapter: txState.active_chapter
                };
            }

            return {
                action: 'READY',
                phase: txState.phase,
                activeChapter: txState.active_chapter
            };
        });

        // 在事务锁释放后再检查 Git 工作区是否干净，避免将 .ops/tx.lock 自身误判为脏文件
        const clean = await this.system.isWorkingTreeClean(this.bookRoot);
        return { ...result, clean };
    }

    /** 基于 SHA-256 指纹检测手改章节 */
    async detectDirtyChapters(): Promise<DirtyChapter[]> {
        const txState = await this.readTxState();
        const chapterFiles = await this.listChapterFiles();
        const dirty: DirtyChapter[] = [];

        for (const fileName of chapterFiles) {
            const match = CHAPTER_FILE_RE.exec(fileName);
            if (!match?.[1]) continue;

            const chapterNumber = Number(match[1]);
            const chapterKey = formatChapterKey(chapterNumber);
            const relativePath = `manuscripts/${fileName}`;
            const content = await readFile(join(this.bookRoot, relativePath), 'utf8');
            const actualHash = sha256Hex(content);
            const recordedHash = txState.chapter_hashes[chapterKey] ?? null;

            if (recordedHash === null) {
                dirty.push({
                    chapterKey,
                    chapterNumber,
                    relativePath,
                    recordedHash: null,
                    actualHash,
                    reason: 'UNTRACKED'
                });
            } else if (recordedHash !== actualHash) {
                dirty.push({
                    chapterKey,
                    chapterNumber,
                    relativePath,
                    recordedHash,
                    actualHash,
                    reason: 'MODIFIED'
                });
            }
        }

        return dirty;
    }

    private mergeEntityPatch(
        existing: EntityProfile | null,
        patch: EntityPatch,
        allowInnateMutation: boolean
    ): EntityProfile {
        return mergeEntityProfilePatch(existing, patch, allowInnateMutation);
    }

    /** 构建 O(1) 外键可达性查找集合（活跃实体 + 冷归档 + 已落盘章节 + 本批新建实体） */
    private async buildReachableKeySet(pendingNewEntityIds: Set<string>): Promise<Set<string>> {
        const keys = new Set<string>(pendingNewEntityIds);

        const collectMdIds = async (dirPath: string) => {
            try {
                const files = await readdir(dirPath);
                for (const file of files) {
                    if (!file.endsWith('.md')) continue;
                    const base = file.slice(0, -3);
                    keys.add(base);
                    // 支持冷归档旧纪元分片命名 char_001_saga_01.md 与 char_lin_daiyu_saga_01.md
                    const sagaMatch = /^((?:char|item)_[a-zA-Z0-9_]+?)_saga_\d+$/.exec(base);
                    if (sagaMatch?.[1]) {
                        keys.add(sagaMatch[1]);
                    }
                }
            } catch (err: unknown) {
                if ((err as { code?: string }).code !== 'ENOENT') throw err;
            }
        };

        await Promise.all([
            collectMdIds(this.entitiesDir),
            collectMdIds(this.coldArchiveDir),
            collectMdIds(this.manuscriptsDir)
        ]);

        return keys;
    }

    private assertForeignKeysReachable(sourceEntityId: string, content: string, reachableKeys: Set<string>): void {
        const missing = new Set<string>();
        for (const match of content.matchAll(/\b(char_[a-zA-Z0-9_]+|item_[a-zA-Z0-9_]+|ch_\d{4})\b/g)) {
            const refId = match[1];
            if (refId && !reachableKeys.has(refId)) {
                missing.add(refId);
            }
        }
        if (missing.size > 0) {
            throw new ForeignKeyError([...missing], sourceEntityId);
        }
    }
}

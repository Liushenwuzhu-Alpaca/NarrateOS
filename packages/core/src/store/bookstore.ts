import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SystemPort } from '../ports/system.js';
import {
    DEFAULT_SECTION_HEADINGS,
    inferSlotKey,
    parseEntityMarkdown,
    serializeEntityMarkdown,
    splitFrontmatter
} from './entity-parser.js';
import {
    BookConfig,
    BookConfigSchema,
    BookSnapshot,
    DirtyChapter,
    EntityEntry,
    EntityEntryInput,
    EntityMetadataSchema,
    EntityPatch,
    EntityProfile,
    ForeignKeyError,
    InnateLockViolationError,
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
const ENTITY_ID_RE = /^(?:char|item)_[a-zA-Z0-9_]+$/;
const BEGIN_DRAFT_ALLOWED_PHASES = new Set<WalPhase>(['IDLE', 'STATE_COMMITTED', 'DREAM_COMMITTED']);
const COMMIT_DRAFT_ALLOWED_PHASES = new Set<WalPhase>(['IDLE', 'DRAFTING', 'STATE_COMMITTED', 'DREAM_COMMITTED']);

export interface TxLockOptions {
    staleMs?: number | undefined;
}

export interface ApplyStatePatchOptions {
    allowInnateMutation?: boolean | undefined;
    worldStateUpdate?: (Partial<WorldStateFrontmatter> & { summaryMarkdown?: string | undefined }) | undefined;
    extraCommitPaths?: string[] | undefined;
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

function toEntityEntry(input: EntityEntryInput): EntityEntry {
    const entry: EntityEntry = {
        text: input.text,
        continuationLines: input.continuationLines ? [...input.continuationLines] : []
    };
    if (input.storyDay !== undefined) entry.storyDay = input.storyDay;
    if (input.chapter !== undefined) entry.chapter = input.chapter;
    if (input.visibility !== undefined) entry.visibility = input.visibility;
    if (input.owner !== undefined) entry.owner = input.owner;
    if (input.status !== undefined) entry.status = input.status;
    if (input.slotKey !== undefined) entry.slotKey = input.slotKey;
    if (input.extraTags !== undefined) entry.extraTags = { ...input.extraTags };
    if (input.isNumericLedger !== undefined) entry.isNumericLedger = input.isNumericLedger;
    if (input.ledger !== undefined) entry.ledger = { ...input.ledger };
    return entry;
}

function mergeUniqueStrings(existing: string[], additions?: string[]): string[] {
    if (!additions || additions.length === 0) return existing;
    const seen = new Set(existing);
    const result = [...existing];
    for (const item of additions) {
        if (!seen.has(item)) {
            seen.add(item);
            result.push(item);
        }
    }
    return result;
}

/** 作品纯文本数据库存储与原子事务层 */
export class BookStore {
    private readonly lockContext = new AsyncLocalStorage<boolean>();

    constructor(
        public readonly bookRoot: string,
        private readonly system: SystemPort
    ) {}

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

    /** 在 .ops/tx.lock 排他文件锁保护下执行临界区操作（严格互斥） */
    async withTxLock<T>(fn: () => Promise<T>, options?: TxLockOptions): Promise<T> {
        await mkdir(this.opsDir, { recursive: true });
        const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
        const payload = JSON.stringify({
            pid: process.pid,
            owner: randomUUID(),
            acquiredAt: new Date().toISOString()
        });

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
    private async runWithTxLock<T>(fn: () => Promise<T>): Promise<T> {
        if (this.lockContext.getStore() === true) {
            return await fn();
        }
        return await this.withTxLock(fn);
    }

    private async tryCleanupStaleLock(staleMs: number): Promise<boolean> {
        try {
            const raw = await readFile(this.txLockPath, 'utf8');
            let payload: unknown = null;
            try {
                payload = JSON.parse(raw);
            } catch {
                payload = null;
            }
            const parsed = TxLockPayloadSchema.safeParse(payload);
            if (parsed.success) {
                const alive = isProcessAlive(parsed.data.pid);
                if (alive) {
                    return false;
                }
            } else {
                const fileStat = await stat(this.txLockPath);
                if (Date.now() - fileStat.mtimeMs < staleMs) {
                    return false;
                }
            }
            await unlink(this.txLockPath);
            return true;
        } catch {
            return false;
        }
    }

    /** 读取并校验 world/book_config.yaml */
    async readBookConfig(): Promise<BookConfig> {
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
                if (file.endsWith('.md')) {
                    coldArchiveIds.push(file.slice(0, -3));
                }
            }
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

    /** 原子提交第 1 粒度：正文真源 + SHA-256 指纹 -> feat(ch-XXXX) */
    async commitDraft(chapterNumber: number, manuscriptText: string): Promise<{ sha: string; txState: TxState }> {
        return await this.runWithTxLock(async () => {
            const current = await this.readTxState();
            if (!COMMIT_DRAFT_ALLOWED_PHASES.has(current.phase)) {
                throw new Error(`非法 WAL 状态迁移: 无法从 ${current.phase} 执行 commitDraft`);
            }

            await mkdir(this.manuscriptsDir, { recursive: true });
            const chKey = formatChapterKey(chapterNumber);
            const relChapterPath = `manuscripts/${chKey}.md`;
            await writeFile(join(this.bookRoot, relChapterPath), manuscriptText, 'utf8');

            const next: TxState = {
                ...current,
                phase: 'FEAT_COMMITTED',
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
                [relChapterPath, '.ops/tx_state.json'],
                `feat(${formatChapterTag(chapterNumber)}): settle manuscript`
            );
            return { sha: commitRes.sha, txState: next };
        });
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
            const stagedProfiles = new Map<string, EntityProfile>();
            const pendingNewEntityIds = new Set<string>();

            // 第一阶段：在内存中校验 entity_id、加载并合并所有补丁，拦截固有属性篡改与路径穿越
            for (const patch of patches) {
                if (!ENTITY_ID_RE.test(patch.entity_id)) {
                    throw new Error(`非法的 entity_id 格式: ${patch.entity_id}`);
                }

                const entityPath = join(this.entitiesDir, `${patch.entity_id}.md`);
                let existing: EntityProfile | null = stagedProfiles.get(patch.entity_id) ?? null;

                if (!existing) {
                    try {
                        const raw = await readFile(entityPath, 'utf8');
                        existing = parseEntityMarkdown(raw);
                    } catch (err: unknown) {
                        if ((err as { code?: string }).code !== 'ENOENT') throw err;
                        pendingNewEntityIds.add(patch.entity_id);
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

            // 第三阶段：全部校验通过后落盘并提交 Git
            const commitPaths: string[] = [];
            const updatedEntities: string[] = [];
            for (const [entityId, profile] of stagedProfiles.entries()) {
                const relPath = `entities/${entityId}.md`;
                await writeFile(join(this.bookRoot, relPath), serializeEntityMarkdown(profile), 'utf8');
                commitPaths.push(relPath);
                updatedEntities.push(entityId);
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

            return {
                sha: commitRes.sha,
                txState: nextTx,
                updatedEntities
            };
        });
    }

    /** 标记睡眠整理提交 (DREAM_COMMITTED) */
    async markDreamCommitted(chapterNumber: number, extraPaths: string[] = []): Promise<TxState> {
        return await this.runWithTxLock(async () => {
            const current = await this.readTxState();
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
            if (txState.phase !== 'DRAFTING' && JSON.stringify(txState) !== JSON.stringify(committed)) {
                const pendingChapter = txState.active_chapter;
                const pendingDraft = txState.phase === 'FEAT_COMMITTED' && committed.phase !== 'FEAT_COMMITTED';
                await this.system.resetHard(this.bookRoot, 'HEAD');
                await this.system.cleanUntracked(this.bookRoot, ['.ops/']);
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
                await this.system.resetHard(this.bookRoot, 'HEAD');
                await this.system.cleanUntracked(this.bookRoot, ['.ops/']);
                if (txState.active_chapter !== null) {
                    const draftPath = join(this.manuscriptsDir, `${formatChapterKey(txState.active_chapter)}.md`);
                    if (!txState.chapter_hashes[formatChapterKey(txState.active_chapter)]) {
                        await rm(draftPath, { force: true });
                    }
                }
                const restored = await this.readTxState();
                return {
                    action: 'ROLLED_BACK_DRAFT',
                    phase: restored.phase,
                    activeChapter: txState.active_chapter
                };
            }

            if (txState.phase === 'FEAT_COMMITTED') {
                await this.system.resetHard(this.bookRoot, 'HEAD');
                await this.system.cleanUntracked(this.bookRoot, ['.ops/']);
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
        if (!ENTITY_ID_RE.test(patch.entity_id)) {
            throw new Error(`非法的 entity_id 格式: ${patch.entity_id}`);
        }
        if (existing) {
            if (patch.canonical_name !== undefined && patch.canonical_name !== existing.metadata.canonical_name) {
                if (!allowInnateMutation) {
                    throw new InnateLockViolationError(
                        patch.entity_id,
                        `禁止在未授权情况下篡改实体 canonical_name (${existing.metadata.canonical_name} -> ${patch.canonical_name})`
                    );
                }
            }
            if (patch.innate_locks_ops && patch.innate_locks_ops.length > 0 && !allowInnateMutation) {
                throw new InnateLockViolationError(
                    patch.entity_id,
                    `禁止在未授权情况下修改实体 ${patch.entity_id} 的 1. Innate Locks`
                );
            }
        }

        const profile: EntityProfile = existing
            ? {
                  metadata: { ...existing.metadata },
                  sectionHeadings: { ...existing.sectionHeadings },
                  innateLocks: existing.innateLocks.map((e) => ({ ...e, continuationLines: [...e.continuationLines] })),
                  acquiredState: existing.acquiredState.map((e) => ({
                      ...e,
                      continuationLines: [...e.continuationLines],
                      ...(e.ledger ? { ledger: { ...e.ledger } } : {})
                  })),
                  irreversibleTrajectory: existing.irreversibleTrajectory.map((e) => ({
                      ...e,
                      continuationLines: [...e.continuationLines]
                  })),
                  recentBuffer: existing.recentBuffer.map((e) => ({
                      ...e,
                      continuationLines: [...e.continuationLines]
                  }))
              }
            : {
                  metadata: {
                      entity_id: patch.entity_id,
                      canonical_name: patch.canonical_name ?? patch.entity_id,
                      unique_aliases: [],
                      contextual_titles: [],
                      historical_anchors: [],
                      last_seen_ch: patch.last_seen_ch ?? 0
                  },
                  sectionHeadings: { ...DEFAULT_SECTION_HEADINGS },
                  innateLocks: [],
                  acquiredState: [],
                  irreversibleTrajectory: [],
                  recentBuffer: []
              };

        if (patch.canonical_name !== undefined && (allowInnateMutation || !existing)) {
            profile.metadata.canonical_name = patch.canonical_name;
        }
        if (patch.last_seen_ch !== undefined) {
            profile.metadata.last_seen_ch = Math.max(profile.metadata.last_seen_ch, patch.last_seen_ch);
        }
        profile.metadata.unique_aliases = mergeUniqueStrings(profile.metadata.unique_aliases, patch.add_unique_aliases);
        profile.metadata.contextual_titles = mergeUniqueStrings(
            profile.metadata.contextual_titles,
            patch.add_contextual_titles
        );
        profile.metadata.historical_anchors = mergeUniqueStrings(
            profile.metadata.historical_anchors,
            patch.add_historical_anchors
        );

        if (patch.innate_locks_ops) {
            for (const op of patch.innate_locks_ops) {
                if (op.op === 'append') {
                    profile.innateLocks.push(toEntityEntry(op.entry));
                } else if (op.op === 'remove_slot') {
                    profile.innateLocks = profile.innateLocks.filter((e) => inferSlotKey(e) !== op.slot_key);
                }
            }
        }

        if (patch.acquired_state_ops) {
            for (const op of patch.acquired_state_ops) {
                if (op.op === 'upsert_slot') {
                    const nextEntry = toEntityEntry(op.entry);
                    const idx = profile.acquiredState.findIndex((e) => inferSlotKey(e) === op.slot_key);
                    if (idx >= 0) {
                        profile.acquiredState[idx] = nextEntry;
                    } else {
                        profile.acquiredState.push(nextEntry);
                    }
                } else if (op.op === 'remove_slot') {
                    profile.acquiredState = profile.acquiredState.filter((e) => inferSlotKey(e) !== op.slot_key);
                } else if (op.op === 'upsert_ledger') {
                    const ledgerIdx = profile.acquiredState.findIndex((e) => e.isNumericLedger);
                    if (ledgerIdx >= 0) {
                        const existingLedger = profile.acquiredState[ledgerIdx]!;
                        const mergedLedger: Record<string, string> = { ...(existingLedger.ledger ?? {}) };
                        for (const [k, v] of Object.entries(op.entries)) {
                            mergedLedger[k] = String(v);
                        }
                        existingLedger.ledger = mergedLedger;
                    } else {
                        const newLedger: Record<string, string> = {};
                        for (const [k, v] of Object.entries(op.entries)) {
                            newLedger[k] = String(v);
                        }
                        profile.acquiredState.push({
                            isNumericLedger: true,
                            ledger: newLedger,
                            text: '',
                            continuationLines: []
                        });
                    }
                } else if (op.op === 'append') {
                    profile.acquiredState.push(toEntityEntry(op.entry));
                }
            }
        }

        if (patch.trajectory_ops) {
            for (const op of patch.trajectory_ops) {
                if (op.op === 'append') {
                    profile.irreversibleTrajectory.push(toEntityEntry(op.entry));
                }
            }
        }

        if (patch.buffer_ops) {
            for (const op of patch.buffer_ops) {
                if (op.op === 'upsert_slot') {
                    const nextEntry = toEntityEntry(op.entry);
                    const idx = profile.recentBuffer.findIndex((e) => inferSlotKey(e) === op.slot_key);
                    if (idx >= 0) {
                        profile.recentBuffer[idx] = nextEntry;
                    } else {
                        profile.recentBuffer.push(nextEntry);
                    }
                } else if (op.op === 'append') {
                    profile.recentBuffer.push(toEntityEntry(op.entry));
                } else if (op.op === 'trim_buffer') {
                    const timedIndices: number[] = [];
                    profile.recentBuffer.forEach((entry, idx) => {
                        if (entry.storyDay !== undefined || entry.chapter !== undefined) {
                            timedIndices.push(idx);
                        }
                    });
                    if (timedIndices.length > op.max_entries) {
                        const dropCount = timedIndices.length - op.max_entries;
                        const dropSet = new Set(timedIndices.slice(0, dropCount));
                        profile.recentBuffer = profile.recentBuffer.filter((_, idx) => !dropSet.has(idx));
                    }
                }
            }
        }

        profile.metadata = EntityMetadataSchema.parse(profile.metadata);
        return profile;
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

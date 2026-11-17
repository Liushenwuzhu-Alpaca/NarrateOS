import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SystemPort } from '../ports/system.js';
import {
    BookStore,
    BookSnapshot,
    DEFAULT_SECTION_HEADINGS,
    EntityEntry,
    EntityEntryInput,
    EntityMetadataSchema,
    EntityPatch,
    EntityProfile,
    ForeignKeyError,
    InnateLockViolationError,
    TimelineMode,
    inferSlotKey,
    parseEntityMarkdown,
    serializeEntityMarkdown
} from '../store/index.js';

const DEFAULT_PARALLEL_MAX_CHAPTERS = 5;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const ENTITY_ID_RE = /^(?:char|item)_[a-zA-Z0-9_]+$/;
const ITEM_ID_REF_RE = /\b(item_[a-zA-Z0-9_]+)\b/g;

/** 并行支线冲突详情 */
export interface ParallelConflictDetail {
    branchId: string;
    slotKey?: string | undefined;
    summary: string;
}

/** 3-Way Merge 唯一道具/互斥槽位双线冲突异常 */
export class ParallelConflictError extends Error {
    constructor(
        public readonly entityId: string,
        public readonly conflicts: ParallelConflictDetail[],
        public readonly slotKey?: string | undefined
    ) {
        const branchSummary = conflicts.map((c) => `${c.branchId}: ${c.summary}`).join(' vs ');
        const slotDesc = slotKey ? ` [slot:${slotKey}]` : '';
        super(`PARALLEL 3-Way Merge 冲突 (${entityId}${slotDesc}): ${branchSummary}`);
        this.name = 'ParallelConflictError';
    }
}

/** 并行时间窗超出最大章节跨度异常 */
export class ParallelWindowExceededError extends Error {
    constructor(
        public readonly windowId: string,
        public readonly actualChapters: number,
        public readonly maxChapters: number
    ) {
        super(`PARALLEL 时间窗 ${windowId} 跨度超限: 已推进 ${actualChapters} 章，超过上限 ${maxChapters} 章`);
        this.name = 'ParallelWindowExceededError';
    }
}

/** 并行时间窗元数据 (.ops/parallel_deltas/{windowId}/window.json) */
export interface ParallelWindowMetadata {
    windowId: string;
    baseTag: string;
    baseDay: number;
    maxChapters: number;
    globalBroadcast: Record<string, unknown>;
    baseChapter: number;
    baseEntityIds: string[];
    status: 'OPEN' | 'MERGED' | 'ABORTED';
    createdAt: string;
    mergedAt?: string | undefined;
}

/** 单条支线暂存增量 (.ops/parallel_deltas/{windowId}/{branchId}.json) */
export interface ParallelBranchDelta {
    windowId: string;
    branchId: string;
    povCharacter?: string | undefined;
    chaptersUsed: number;
    daySpan: number;
    patches: EntityPatch[];
    stagedAt: string;
    chapterNumbers?: number[];
}

export interface ForkParallelWindowOptions {
    windowId: string;
    maxChapters?: number | undefined;
    globalBroadcast?: Record<string, unknown> | undefined;
}

export interface StageParallelDeltaInput {
    windowId: string;
    branchId: string;
    povCharacter?: string | undefined;
    chaptersUsed?: number | undefined;
    daySpan?: number | undefined;
    patches: EntityPatch[];
    chapterNumbers?: number[];
}

export interface MergeParallelWindowOptions {
    windowId: string;
    advanceDays?: number | undefined;
    restoreTimelineMode?: TimelineMode | undefined;
    allowInnateMutation?: boolean | undefined;
}

export interface MergeParallelWindowResult {
    windowId: string;
    baseTag: string;
    mergedBranches: string[];
    updatedEntities: string[];
    previousStoryDay: number;
    newStoryDay: number;
    totalChaptersUsed: number;
    sha: string;
}

function assertSafeId(value: string, label: string): void {
    if (!SAFE_ID_RE.test(value)) {
        throw new Error(`非法的 ${label} 格式: ${value}`);
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

function applySingleEntityPatch(
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

/** 构造用于比较支线槽位变更是否等价的规范化签名 */
function buildSlotOpSignature(op: NonNullable<EntityPatch['acquired_state_ops']>[number]): string {
    if (op.op === 'remove_slot') {
        return `REMOVE:${op.slot_key}`;
    }
    if (op.op === 'upsert_slot') {
        return JSON.stringify({
            op: 'upsert_slot',
            slot_key: op.slot_key,
            owner: op.entry.owner ?? null,
            status: op.entry.status ?? null,
            visibility: op.entry.visibility ?? null,
            text: op.entry.text
        });
    }
    return JSON.stringify(op);
}

/** 构造唯一道具实体的完整状态变动签名（涵盖 acquired/trajectory/buffer/metadata） */
function buildItemMutationSignature(patch: EntityPatch): string {
    return JSON.stringify({
        canonical_name: patch.canonical_name ?? null,
        add_unique_aliases: patch.add_unique_aliases ?? [],
        add_contextual_titles: patch.add_contextual_titles ?? [],
        add_historical_anchors: patch.add_historical_anchors ?? [],
        innate_locks_ops: patch.innate_locks_ops ?? [],
        acquired_state_ops: (patch.acquired_state_ops ?? []).map(buildSlotOpSignature),
        trajectory_ops: patch.trajectory_ops ?? [],
        buffer_ops: patch.buffer_ops ?? []
    });
}

/** 生成唯一道具实体的可读变更摘要 */
function buildItemMutationSummary(patch: EntityPatch): string {
    const parts: string[] = [];
    if (patch.canonical_name !== undefined) {
        parts.push(`canonical_name=${patch.canonical_name}`);
    }
    if (patch.acquired_state_ops && patch.acquired_state_ops.length > 0) {
        parts.push(
            ...patch.acquired_state_ops.map((op) =>
                op.op === 'upsert_slot'
                    ? `${op.slot_key}=${op.entry.owner ?? op.entry.status ?? op.entry.text}`
                    : op.op
            )
        );
    }
    if (patch.trajectory_ops && patch.trajectory_ops.length > 0) {
        parts.push(...patch.trajectory_ops.map((op) => `trajectory:${op.entry.text}`));
    }
    if (patch.buffer_ops && patch.buffer_ops.length > 0) {
        parts.push(...patch.buffer_ops.map((op) => (op.op === 'trim_buffer' ? 'trim_buffer' : `buffer:${op.entry.text}`)));
    }
    return parts.join('; ') || '修改唯一道具状态';
}

/** 提取角色补丁中声明获取/持有的唯一道具 ID */
function extractClaimedItemIds(patch: EntityPatch): Array<{ itemId: string; slotKey?: string | undefined; summary: string }> {
    const claims: Array<{ itemId: string; slotKey?: string | undefined; summary: string }> = [];
    if (!patch.acquired_state_ops) return claims;

    for (const op of patch.acquired_state_ops) {
        if (op.op !== 'upsert_slot' && op.op !== 'append') continue;
        const slotKey = op.op === 'upsert_slot' ? op.slot_key : op.entry.slotKey;
        const matchedItems = new Set<string>();

        if (slotKey) {
            for (const m of slotKey.matchAll(ITEM_ID_REF_RE)) {
                if (m[1]) matchedItems.add(m[1]);
            }
        }
        for (const m of op.entry.text.matchAll(ITEM_ID_REF_RE)) {
            if (m[1]) matchedItems.add(m[1]);
        }

        for (const itemId of matchedItems) {
            claims.push({
                itemId,
                slotKey,
                summary: `${patch.entity_id} 声明状态 [${op.entry.text}]`
            });
        }
    }
    return claims;
}

/** PARALLEL 三态时间线分叉暂存与 3-Way Merge 沙盒 */
export class ParallelSandbox {
    constructor(
        private readonly store: BookStore,
        private readonly system: SystemPort
    ) {}

    private windowDir(windowId: string): string {
        return join(this.store.bookRoot, '.ops/parallel_deltas', windowId);
    }

    private windowMetaPath(windowId: string): string {
        return join(this.windowDir(windowId), 'window.json');
    }

    private branchDeltaPath(windowId: string, branchId: string): string {
        return join(this.windowDir(windowId), `${branchId}.json`);
    }

    /** 开启 PARALLEL 时间窗：打 Git 分叉标签、记录广播表并切换 timeline_mode */
    async forkWindow(options: ForkParallelWindowOptions): Promise<ParallelWindowMetadata> {
        assertSafeId(options.windowId, 'windowId');
        const baseTag = `parallel-fork-${options.windowId}`;

        return await this.store.runWithTxLock(async () => {
            await this.store.recoverWal();
            const metaPath = this.windowMetaPath(options.windowId);
            const snapshot = await this.store.loadSnapshot();
            if (snapshot.txState.phase === 'DRAFTING' || snapshot.txState.phase === 'FEAT_COMMITTED') {
                throw new Error('开启并行窗口前必须完成章节恢复');
            }
            if (snapshot.worldState.frontmatter.timeline_mode === 'PARALLEL') throw new Error('已有并行窗口尚未合并');
            try {
                const existingRaw = await readFile(metaPath, 'utf8');
                const existing = JSON.parse(existingRaw) as ParallelWindowMetadata;
                if (existing.status === 'OPEN') {
                    throw new Error(`PARALLEL 时间窗 ${options.windowId} 已处于 OPEN 状态`);
                }
            } catch (err: unknown) {
                if ((err as { code?: string }).code !== 'ENOENT') throw err;
            }

            const [config, worldState] = await Promise.all([
                this.store.readBookConfig(),
                this.store.readWorldState()
            ]);

            const maxChapters =
                options.maxChapters ?? config.parallel_max_chapters ?? DEFAULT_PARALLEL_MAX_CHAPTERS;

            // 标签固定分叉前快照，窗口元数据与模式切换在同一提交中生效。
            try {
                await this.system.createTag(this.store.bookRoot, baseTag, `PARALLEL fork window ${options.windowId}`);
            } catch (error) {
                const existingRevision = await this.system.currentRevision(this.store.bookRoot, `refs/tags/${baseTag}`).catch(() => null);
                if (existingRevision === null) throw error;
                if (existingRevision !== await this.system.currentRevision(this.store.bookRoot)) {
                    throw new Error('分叉标签与当前提交不一致，请使用新的窗口 ID');
                }
            }
            const forkPaths = ['world/world_state.md', `.ops/parallel_deltas/${options.windowId}/window.json`];
            await this.store.recordPendingWrites(forkPaths);
            if (worldState.frontmatter.timeline_mode !== 'PARALLEL') {
                await this.store.writeWorldState({
                    frontmatter: {
                        ...worldState.frontmatter,
                        timeline_mode: 'PARALLEL'
                    },
                    summaryMarkdown: worldState.summaryMarkdown
                });
            }


            const metadata: ParallelWindowMetadata = {
                windowId: options.windowId,
                baseTag,
                baseDay: worldState.frontmatter.story_day,
                maxChapters,
                globalBroadcast: options.globalBroadcast ?? {},
                baseChapter: snapshot.txState.last_committed_ch,
                baseEntityIds: Object.keys(snapshot.entities),
                status: 'OPEN',
                createdAt: new Date().toISOString()
            };

            await mkdir(this.windowDir(options.windowId), { recursive: true });
            await writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
            try {
                await this.system.commitPaths(this.store.bookRoot, forkPaths, `parallel(${options.windowId}): persist window`);
            } catch (error) {
                await this.system.restorePaths(this.store.bookRoot, forkPaths);
                throw error;
            }
            await rm(join(this.store.bookRoot, '.ops/pending_writes.json'), { force: true });
            return metadata;
        });
    }

    /** 读取活跃窗口元数据与只读全局环境广播表 */
    async getWindow(windowId: string): Promise<ParallelWindowMetadata> {
        assertSafeId(windowId, 'windowId');
        const raw = await readFile(this.windowMetaPath(windowId), 'utf8');
        return JSON.parse(raw) as ParallelWindowMetadata;
    }

    /** 分叉基线加本支线增量，其他支线实体与章节不进入生成上下文。 */
    async loadBranchSnapshot(snapshot: BookSnapshot, windowId: string, branchId: string): Promise<BookSnapshot> {
        assertSafeId(branchId, 'branchId');
        if (branchId === 'window') throw new Error('支线 ID 不能使用保留名 window');
        const metadata = await this.getWindow(windowId);
        if (metadata.status !== 'OPEN') throw new Error('并行窗口未开放');
        const entities: Record<string, EntityProfile> = {};
        for (const id of metadata.baseEntityIds) {
            const profile = await this.loadBaseProfile(metadata.baseTag, id);
            if (profile) entities[id] = profile;
        }
        const delta = (await this.readBranchDeltas(windowId)).find((item) => item.branchId === branchId);
        for (const patch of delta?.patches ?? []) {
            entities[patch.entity_id] = applySingleEntityPatch(entities[patch.entity_id] ?? null, patch, false);
        }
        const chapterFiles = snapshot.chapterFiles.filter((file) => {
            const chapter = Number(file.slice(3, -3));
            return chapter <= metadata.baseChapter || delta?.chapterNumbers?.includes(chapter);
        });
        return { ...snapshot, entities, chapterFiles, worldState: {
            ...snapshot.worldState,
            summaryMarkdown: `${snapshot.worldState.summaryMarkdown}\n\n全局环境广播：${JSON.stringify(metadata.globalBroadcast)}`,
            frontmatter: { ...snapshot.worldState.frontmatter, story_day: metadata.baseDay + (delta?.daySpan ?? 0) }
        } };
    }

    async appendChapter(input: StageParallelDeltaInput & { chapterNumber: number }): Promise<ParallelBranchDelta> {
        return await this.store.runWithTxLock(async () => {
            assertSafeId(input.windowId, 'windowId');
            assertSafeId(input.branchId, 'branchId');
            const deltas = await this.readBranchDeltas(input.windowId);
            if (deltas.some((item) => item.chapterNumbers?.includes(input.chapterNumber))) {
                throw new Error('并行章节已存在，拒绝跨支线覆盖或重复暂存');
            }
            const previous = deltas.find((item) => item.branchId === input.branchId);
            return await this.stageDelta({ ...input,
                patches: [...(previous?.patches ?? []), ...input.patches],
                chaptersUsed: (previous?.chaptersUsed ?? 0) + 1,
                chapterNumbers: [...(previous?.chapterNumbers ?? []), input.chapterNumber],
                daySpan: (previous?.daySpan ?? 0) + (input.daySpan ?? 0)
            });
        });
    }

    /** 暂存支线状态增量至 .ops/parallel_deltas/{windowId}/{branchId}.json（主时钟不累加） */
    async stageDelta(input: StageParallelDeltaInput): Promise<ParallelBranchDelta> {
        return await this.store.runWithTxLock(() => this.stageDeltaLocked(input));
    }

    private async stageDeltaLocked(input: StageParallelDeltaInput): Promise<ParallelBranchDelta> {
        assertSafeId(input.windowId, 'windowId');
        assertSafeId(input.branchId, 'branchId');
        if (input.branchId === 'window') throw new Error('支线 ID 不能使用保留名 window');

        const windowMeta = await this.getWindow(input.windowId);
        if (windowMeta.status !== 'OPEN') {
            throw new Error(`PARALLEL 时间窗 ${input.windowId} 当前状态为 ${windowMeta.status}，无法暂存支线增量`);
        }

        const chaptersUsed = input.chaptersUsed ?? 1;
        const daySpan = input.daySpan ?? 1;
        if (chaptersUsed < 0 || daySpan < 0) {
            throw new Error('chaptersUsed 与 daySpan 不能为负数');
        }

        const existingDeltas = await this.readBranchDeltas(input.windowId);
        const totalChapters =
            existingDeltas
                .filter((d) => d.branchId !== input.branchId)
                .reduce((acc, d) => acc + d.chaptersUsed, 0) + chaptersUsed;

        if (totalChapters > windowMeta.maxChapters) {
            throw new ParallelWindowExceededError(input.windowId, totalChapters, windowMeta.maxChapters);
        }
        const profiles = new Map<string, EntityProfile>();
        const reachable = await this.buildReachableKeySet(new Set(input.patches.map((patch) => patch.entity_id)));
        for (const patch of input.patches) {
            if (!ENTITY_ID_RE.test(patch.entity_id)) throw new Error(`非法 entity_id: ${patch.entity_id}`);
            const base = profiles.get(patch.entity_id) ?? await this.loadBaseProfile(windowMeta.baseTag, patch.entity_id);
            const profile = applySingleEntityPatch(base, patch, false);
            profiles.set(patch.entity_id, profile);
            this.assertForeignKeysReachable(patch.entity_id, serializeEntityMarkdown(profile), reachable);
        }

        const delta: ParallelBranchDelta = {
            windowId: input.windowId,
            branchId: input.branchId,
            ...(input.povCharacter ? { povCharacter: input.povCharacter } : {}),
            chaptersUsed,
            daySpan,
            patches: input.patches,
            stagedAt: new Date().toISOString(),
            ...(input.chapterNumbers ? { chapterNumbers: input.chapterNumbers } : {}),
        };

        await writeFile(this.branchDeltaPath(input.windowId, input.branchId), JSON.stringify(delta, null, 2), 'utf8');
        return delta;
    }

    /** 汇合执行 3-Way Merge（拦截唯一道具双线冲突与互斥槽位冲突，无冲突则统一推进 story_day） */
    async mergeWindow(options: MergeParallelWindowOptions): Promise<MergeParallelWindowResult> {
        assertSafeId(options.windowId, 'windowId');

        return await this.store.runWithTxLock(async () => {
            const windowMeta = await this.getWindow(options.windowId);
            if (windowMeta.status !== 'OPEN') {
                throw new Error(`PARALLEL 时间窗 ${options.windowId} 当前状态为 ${windowMeta.status}，无法重复合并`);
            }

            const [config, worldState, deltas] = await Promise.all([
                this.store.readBookConfig(),
                this.store.readWorldState(),
                this.readBranchDeltas(options.windowId)
            ]);

            const maxChapters = config.parallel_max_chapters ?? windowMeta.maxChapters;
            const totalChaptersUsed = deltas.reduce((acc, d) => acc + d.chaptersUsed, 0);
            if (totalChaptersUsed > maxChapters) {
                throw new ParallelWindowExceededError(options.windowId, totalChaptersUsed, maxChapters);
            }

            // 第一阶段：3-Way Merge 硬冲突检测（唯一道具双线夺取 / 同实体互斥槽位冲突）
            this.detectConflicts(deltas);

            // 第二阶段：从分叉基线 baseTag 读取实体快照并合成 3-Way Merge 结果
            const allowInnate = options.allowInnateMutation === true;
            const mergedProfiles = new Map<string, EntityProfile>();
            const pendingNewEntityIds = new Set<string>();

            for (const delta of deltas) {
                for (const patch of delta.patches) {
                    let baseProfile = mergedProfiles.get(patch.entity_id) ?? null;
                    if (!baseProfile) {
                        baseProfile = await this.loadBaseProfile(windowMeta.baseTag, patch.entity_id);
                        if (!baseProfile) {
                            pendingNewEntityIds.add(patch.entity_id);
                        }
                    }
                    const nextProfile = applySingleEntityPatch(baseProfile, patch, allowInnate);
                    mergedProfiles.set(patch.entity_id, nextProfile);
                }
            }

            // 第三阶段：外键可达性校验（含新建实体与已有冷归档/章节）
            const reachableKeys = await this.buildReachableKeySet(pendingNewEntityIds);
            for (const [entityId, profile] of mergedProfiles.entries()) {
                const serialized = serializeEntityMarkdown(profile);
                this.assertForeignKeysReachable(entityId, serialized, reachableKeys);
            }

            // 第四阶段：全部无冲突且校验通过后，落盘实体、统一推进主时钟 story_day 并提交 Git
            const tx = await this.store.readTxState();
            if (tx.phase === 'DRAFTING' || tx.phase === 'FEAT_COMMITTED') throw new Error('合并前必须完成章节恢复');
            await this.store.recordPendingWrites([
                ...[...mergedProfiles.keys()].map((id) => `entities/${id}.md`),
                'world/world_state.md', `.ops/parallel_deltas/${options.windowId}/window.json`
            ]);
            const commitPaths: string[] = [];
            const updatedEntities: string[] = [];
            for (const [entityId, profile] of mergedProfiles.entries()) {
                const relPath = `entities/${entityId}.md`;
                await writeFile(join(this.store.bookRoot, relPath), serializeEntityMarkdown(profile), 'utf8');
                commitPaths.push(relPath);
                updatedEntities.push(entityId);
            }

            const maxBranchDaySpan = deltas.reduce((max, d) => Math.max(max, d.daySpan), 0);
            const dayAdvance = options.advanceDays ?? maxBranchDaySpan;
            const previousStoryDay = worldState.frontmatter.story_day;
            const newStoryDay = windowMeta.baseDay + dayAdvance;

            await this.store.writeWorldState({
                frontmatter: {
                    ...worldState.frontmatter,
                    story_day: newStoryDay,
                    timeline_mode: options.restoreTimelineMode ?? 'MAINLINE',
                    current_chapter: tx.last_committed_ch,
                },
                summaryMarkdown: worldState.summaryMarkdown
            });
            commitPaths.push('world/world_state.md');

            const updatedMeta: ParallelWindowMetadata = {
                ...windowMeta,
                status: 'MERGED',
                mergedAt: new Date().toISOString()
            };
            await writeFile(this.windowMetaPath(options.windowId), JSON.stringify(updatedMeta, null, 2), 'utf8');
            commitPaths.push(`.ops/parallel_deltas/${options.windowId}/window.json`);

            let commitRes;
            try {
                commitRes = await this.system.commitPaths(
                    this.store.bookRoot, commitPaths,
                    `merge(parallel-${options.windowId}): 3-way merge ${deltas.length} branches`
                );
            } catch (error) {
                await this.system.restorePaths(this.store.bookRoot, commitPaths);
                throw error;
            }
            await rm(join(this.store.bookRoot, '.ops/pending_writes.json'), { force: true });

            return {
                windowId: options.windowId,
                baseTag: windowMeta.baseTag,
                mergedBranches: deltas.map((d) => d.branchId),
                updatedEntities,
                previousStoryDay,
                newStoryDay,
                totalChaptersUsed,
                sha: commitRes.sha
            };
        });
    }

    private async readBranchDeltas(windowId: string): Promise<ParallelBranchDelta[]> {
        const dir = this.windowDir(windowId);
        let files: string[];
        try {
            files = await readdir(dir);
        } catch (err: unknown) {
            if ((err as { code?: string }).code === 'ENOENT') return [];
            throw err;
        }

        const deltaFiles = files.filter((f) => f.endsWith('.json') && f !== 'window.json').sort();
        const deltas: ParallelBranchDelta[] = [];
        for (const file of deltaFiles) {
            const raw = await readFile(join(dir, file), 'utf8');
            deltas.push(JSON.parse(raw) as ParallelBranchDelta);
        }
        return deltas;
    }

    private detectConflicts(deltas: ParallelBranchDelta[]): void {
        // 1. 唯一道具自身实体 (item_*) 双线互斥变更检测
        const itemMutationsByEntity = new Map<
            string,
            Map<string, { summary: string; signatures: string[] }>
        >();

        // 2. 角色补丁中对同一唯一道具 (item_*) 的双线获取/持有声明检测
        const itemClaimsAcrossBranches = new Map<string, Map<string, ParallelConflictDetail>>();

        // 3. 任意实体的互斥槽位 / 数值账本双线变更检测
        const slotMutations = new Map<
            string,
            Map<string, { branchId: string; signature: string; summary: string }>
        >();
        const ledgerMutations = new Map<string, Map<string, { branchId: string; value: string }>>();

        for (const delta of deltas) {
            for (const patch of delta.patches) {
                const isItemEntity = patch.entity_id.startsWith('item_');

                if (isItemEntity) {
                    const hasStateMutation =
                        (patch.acquired_state_ops && patch.acquired_state_ops.length > 0) ||
                        (patch.trajectory_ops && patch.trajectory_ops.length > 0) ||
                        (patch.buffer_ops && patch.buffer_ops.length > 0) ||
                        (patch.innate_locks_ops && patch.innate_locks_ops.length > 0) ||
                        (patch.add_unique_aliases && patch.add_unique_aliases.length > 0) ||
                        (patch.add_contextual_titles && patch.add_contextual_titles.length > 0) ||
                        (patch.add_historical_anchors && patch.add_historical_anchors.length > 0) ||
                        patch.canonical_name !== undefined;

                    if (hasStateMutation) {
                        let branchMap = itemMutationsByEntity.get(patch.entity_id);
                        if (!branchMap) {
                            branchMap = new Map();
                            itemMutationsByEntity.set(patch.entity_id, branchMap);
                        }
                        const sig = buildItemMutationSignature(patch);
                        const summary = buildItemMutationSummary(patch);
                        const prev = branchMap.get(delta.branchId);
                        if (prev) {
                            prev.signatures.push(sig);
                            prev.summary = `${prev.summary}; ${summary}`;
                        } else {
                            branchMap.set(delta.branchId, { summary, signatures: [sig] });
                        }
                    }
                } else {
                    for (const claim of extractClaimedItemIds(patch)) {
                        let claimMap = itemClaimsAcrossBranches.get(claim.itemId);
                        if (!claimMap) {
                            claimMap = new Map();
                            itemClaimsAcrossBranches.set(claim.itemId, claimMap);
                        }
                        claimMap.set(delta.branchId, {
                            branchId: delta.branchId,
                            slotKey: claim.slotKey,
                            summary: claim.summary
                        });
                    }
                }

                if (patch.acquired_state_ops) {
                    for (const op of patch.acquired_state_ops) {
                        if (op.op === 'upsert_slot' || op.op === 'remove_slot') {
                            const key = `${patch.entity_id}::${op.slot_key}`;
                            let byBranch = slotMutations.get(key);
                            if (!byBranch) {
                                byBranch = new Map();
                                slotMutations.set(key, byBranch);
                            }
                            byBranch.set(delta.branchId, {
                                branchId: delta.branchId,
                                signature: buildSlotOpSignature(op),
                                summary:
                                    op.op === 'remove_slot'
                                        ? `移除槽位 ${op.slot_key}`
                                        : `写入槽位 ${op.slot_key}: ${op.entry.text}`
                            });
                        } else if (op.op === 'upsert_ledger') {
                            for (const [ledgerKey, val] of Object.entries(op.entries)) {
                                const key = `${patch.entity_id}::ledger::${ledgerKey}`;
                                let byBranch = ledgerMutations.get(key);
                                if (!byBranch) {
                                    byBranch = new Map();
                                    ledgerMutations.set(key, byBranch);
                                }
                                byBranch.set(delta.branchId, {
                                    branchId: delta.branchId,
                                    value: String(val)
                                });
                            }
                        }
                    }
                }
            }
        }

        // 统一检查所有涉事唯一道具（含直接修改 item_* 实体与在 char_* 补丁中声明持有 item_* 的双路径交叉冲突）
        const allInvolvedItemIds = new Set([
            ...itemMutationsByEntity.keys(),
            ...itemClaimsAcrossBranches.keys()
        ]);

        for (const itemId of allInvolvedItemIds) {
            const mutationMap = itemMutationsByEntity.get(itemId);
            const claimMap = itemClaimsAcrossBranches.get(itemId);

            const involvedBranches = new Set<string>([
                ...(mutationMap ? mutationMap.keys() : []),
                ...(claimMap ? claimMap.keys() : [])
            ]);

            if (involvedBranches.size < 2) {
                continue;
            }

            const hasCrossPath = Boolean(mutationMap && mutationMap.size > 0 && claimMap && claimMap.size > 0);
            const hasMultiClaim = Boolean(claimMap && claimMap.size >= 2);
            const hasDivergentEntityMutations = Boolean(
                mutationMap &&
                    mutationMap.size >= 2 &&
                    new Set([...mutationMap.values()].map((v) => v.signatures.join('|'))).size > 1
            );

            if (hasCrossPath || hasMultiClaim || hasDivergentEntityMutations) {
                const details: ParallelConflictDetail[] = [];
                for (const branchId of involvedBranches) {
                    const mut = mutationMap?.get(branchId);
                    const clm = claimMap?.get(branchId);
                    const summaryParts: string[] = [];
                    if (mut) summaryParts.push(mut.summary);
                    if (clm) summaryParts.push(clm.summary);
                    details.push({
                        branchId,
                        ...(clm?.slotKey ? { slotKey: clm.slotKey } : {}),
                        summary: summaryParts.join(' | ')
                    });
                }
                throw new ParallelConflictError(itemId, details);
            }
        }

        for (const [compositeKey, byBranch] of slotMutations.entries()) {
            if (byBranch.size >= 2) {
                const uniqueSigs = new Set([...byBranch.values()].map((v) => v.signature));
                if (uniqueSigs.size > 1) {
                    const [entityId, slotKey] = compositeKey.split('::') as [string, string];
                    const details: ParallelConflictDetail[] = [...byBranch.values()].map((v) => ({
                        branchId: v.branchId,
                        slotKey,
                        summary: v.summary
                    }));
                    throw new ParallelConflictError(entityId, details, slotKey);
                }
            }
        }

        for (const [compositeKey, byBranch] of ledgerMutations.entries()) {
            if (byBranch.size >= 2) {
                const uniqueVals = new Set([...byBranch.values()].map((v) => v.value));
                if (uniqueVals.size > 1) {
                    const [entityId, , ledgerKey] = compositeKey.split('::') as [string, string, string];
                    const details: ParallelConflictDetail[] = [...byBranch.values()].map((v) => ({
                        branchId: v.branchId,
                        slotKey: ledgerKey,
                        summary: `账本项 ${ledgerKey}=${v.value}`
                    }));
                    throw new ParallelConflictError(entityId, details, ledgerKey);
                }
            }
        }
    }

    private async loadBaseProfile(baseTag: string, entityId: string): Promise<EntityProfile | null> {
        const relPath = `entities/${entityId}.md`;
        const atTag = await this.system.readFileAtRef(this.store.bookRoot, baseTag, relPath);
        if (atTag !== null) {
            return parseEntityMarkdown(atTag);
        }
        return null;
    }

    private async buildReachableKeySet(pendingNewEntityIds: Set<string>): Promise<Set<string>> {
        const keys = new Set<string>(pendingNewEntityIds);
        const dirs = [
            join(this.store.bookRoot, 'entities'),
            join(this.store.bookRoot, 'entities/cold_archive'),
            join(this.store.bookRoot, 'manuscripts')
        ];

        await Promise.all(
            dirs.map(async (dirPath) => {
                try {
                    const files = await readdir(dirPath);
                    for (const file of files) {
                        if (!file.endsWith('.md')) continue;
                        const base = file.slice(0, -3);
                        keys.add(base);
                        const sagaMatch = /^((?:char|item)_[a-zA-Z0-9_]+?)_saga_\d+$/.exec(base);
                        if (sagaMatch?.[1]) {
                            keys.add(sagaMatch[1]);
                        }
                    }
                } catch (err: unknown) {
                    if ((err as { code?: string }).code !== 'ENOENT') throw err;
                }
            })
        );
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

/** 便捷函数：开启 PARALLEL 时间窗 */
export async function forkParallelWindow(
    store: BookStore,
    system: SystemPort,
    options: ForkParallelWindowOptions
): Promise<ParallelWindowMetadata> {
    return await new ParallelSandbox(store, system).forkWindow(options);
}

/** 便捷函数：暂存支线状态增量 */
export async function stageParallelDelta(
    store: BookStore,
    system: SystemPort,
    input: StageParallelDeltaInput
): Promise<ParallelBranchDelta> {
    return await new ParallelSandbox(store, system).stageDelta(input);
}

/** 便捷函数：执行 PARALLEL 3-Way Merge */
export async function mergeParallelWindow(
    store: BookStore,
    system: SystemPort,
    options: MergeParallelWindowOptions
): Promise<MergeParallelWindowResult> {
    return await new ParallelSandbox(store, system).mergeWindow(options);
}

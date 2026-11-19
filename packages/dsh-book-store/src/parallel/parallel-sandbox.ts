import { withTraceRun } from '../trace/trace.js';
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { upsertVolumeCardEntry } from '../recall/index-recall.js';
import { SystemPort } from '../ports/system.js';
import {
    assertForeignKeysReachable,
    collectReachableKeys,
    isEnoentError
} from '../store/bookstore.js';
import {
    BookStore,
    BookSnapshot,
    ENTITY_ID_RE,
    EntityEntry,
    EntityEntryInput,
    EntityPatch,
    EntityProfile,
    TimelineMode,
    mergeEntityProfilePatch,
    parseEntityMarkdown,
    serializeEntityMarkdown
} from '../store/index.js';

const DEFAULT_PARALLEL_MAX_CHAPTERS = 5;
const DEFAULT_PARALLEL_DAY_SPAN = 0;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
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

/** 分支单章 L2 章卡增量 */
export interface ParallelL2CardEntry {
    volumeNumber: number;
    chapterNumber: number;
    storyDay: number;
    plotSummary: string;
    proseAnchors?: string[] | undefined;
    appearanceEntityIds: string[];
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
    nextChapterOptions?: string[];
    l2Cards?: ParallelL2CardEntry[] | undefined;
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
    nextChapterOptions?: string[];
    l2Cards?: ParallelL2CardEntry[] | undefined;
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
    updatedL2CardPaths?: string[] | undefined;
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

function getOrCreateMap<K, V>(outer: Map<string, Map<K, V>>, key: string): Map<K, V> {
    let inner = outer.get(key);
    if (!inner) {
        inner = new Map<K, V>();
        outer.set(key, inner);
    }
    return inner;
}

function formatBroadcastValue(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function upsertParallelL2CardContent(rawCardContent: string | null, entry: ParallelL2CardEntry): string {
    return upsertVolumeCardEntry(rawCardContent, entry.volumeNumber, entry.chapterNumber, entry.storyDay,
        entry.plotSummary, entry.appearanceEntityIds, entry.proseAnchors);
}

function toParallelBroadcastEntries(
    globalBroadcast: Record<string, unknown>,
    baseDay: number
): EntityEntry[] {
    const entries: EntityEntry[] = [];
    for (const [key, value] of Object.entries(globalBroadcast)) {
        const textValue = formatBroadcastValue(value);
        if (!textValue) continue;
        entries.push({
            storyDay: baseDay,
            visibility: 'PUBLIC',
            slotKey: key,
            text: `${key}：${textValue}`,
            continuationLines: []
        });
    }
    return entries;
}

function mergeParallelL2Cards(
    existing: ParallelL2CardEntry[] | undefined,
    additions: ParallelL2CardEntry[] | undefined
): ParallelL2CardEntry[] | undefined {
    const byChapter = new Map<number, ParallelL2CardEntry>();
    for (const card of existing ?? []) {
        byChapter.set(card.chapterNumber, card);
    }
    for (const card of additions ?? []) {
        byChapter.set(card.chapterNumber, card);
    }
    if (byChapter.size === 0) {
        return undefined;
    }
    return [...byChapter.values()].sort((a, b) => a.chapterNumber - b.chapterNumber);
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

function collectItemClaimsFromEntry(
    entityId: string,
    entry: EntityEntryInput,
    explicitSlotKey: string | undefined,
    claims: Array<{ itemId: string; slotKey?: string | undefined; summary: string }>
): void {
    const slotKey = explicitSlotKey ?? entry.slotKey;
    const matchedItems = new Set<string>();

    const scanText = (raw: string | undefined) => {
        if (!raw) return;
        for (const m of raw.matchAll(ITEM_ID_REF_RE)) {
            if (m[1]) matchedItems.add(m[1]);
        }
    };

    scanText(slotKey);
    scanText(entry.owner);
    scanText(entry.text);
    for (const line of entry.continuationLines ?? []) {
        scanText(line);
    }

    for (const itemId of matchedItems) {
        claims.push({
            itemId,
            slotKey,
            summary: `${entityId} 声明状态 [${entry.text}]`
        });
    }
}

/** 提取角色补丁中声明获取/持有/损毁的唯一道具 ID（覆盖第 2/3/4 全区） */
function extractClaimedItemIds(patch: EntityPatch): Array<{ itemId: string; slotKey?: string | undefined; summary: string }> {
    const claims: Array<{ itemId: string; slotKey?: string | undefined; summary: string }> = [];
    const slotAwareOps = [
        ...(patch.acquired_state_ops ?? []),
        ...(patch.buffer_ops ?? []),
        ...(patch.trajectory_ops ?? [])
    ];

    for (const op of slotAwareOps) {
        if (op.op !== 'upsert_slot' && op.op !== 'append') continue;
        const explicitSlotKey = op.op === 'upsert_slot' ? op.slot_key : op.entry.slotKey;
        collectItemClaimsFromEntry(patch.entity_id, op.entry, explicitSlotKey, claims);
    }

    return claims;
}

function hasAnyItemStateMutation(patch: EntityPatch): boolean {
    return (
        (patch.acquired_state_ops !== undefined && patch.acquired_state_ops.length > 0) ||
        (patch.trajectory_ops !== undefined && patch.trajectory_ops.length > 0) ||
        (patch.buffer_ops !== undefined && patch.buffer_ops.length > 0) ||
        (patch.innate_locks_ops !== undefined && patch.innate_locks_ops.length > 0) ||
        (patch.add_unique_aliases !== undefined && patch.add_unique_aliases.length > 0) ||
        (patch.add_contextual_titles !== undefined && patch.add_contextual_titles.length > 0) ||
        (patch.add_historical_anchors !== undefined && patch.add_historical_anchors.length > 0) ||
        patch.canonical_name !== undefined
    );
}

interface BranchMutationAccumulator {
    itemMutationsByEntity: Map<string, Map<string, { summary: string; signatures: string[] }>>;
    itemClaimsAcrossBranches: Map<string, Map<string, ParallelConflictDetail>>;
    slotMutations: Map<string, Map<string, { branchId: string; signature: string; summary: string }>>;
    ledgerMutations: Map<string, Map<string, { branchId: string; value: string }>>;
}

function collectBranchMutations(deltas: ParallelBranchDelta[]): BranchMutationAccumulator {
    const itemMutationsByEntity = new Map<
        string,
        Map<string, { summary: string; signatures: string[] }>
    >();
    const itemClaimsAcrossBranches = new Map<string, Map<string, ParallelConflictDetail>>();
    const slotMutations = new Map<
        string,
        Map<string, { branchId: string; signature: string; summary: string }>
    >();
    const ledgerMutations = new Map<string, Map<string, { branchId: string; value: string }>>();

    for (const delta of deltas) {
        for (const patch of delta.patches) {
            if (patch.entity_id.startsWith('item_')) {
                if (hasAnyItemStateMutation(patch)) {
                    const branchMap = getOrCreateMap(itemMutationsByEntity, patch.entity_id);
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
                    const claimMap = getOrCreateMap(itemClaimsAcrossBranches, claim.itemId);
                    claimMap.set(delta.branchId, {
                        branchId: delta.branchId,
                        slotKey: claim.slotKey,
                        summary: claim.summary
                    });
                }
            }

            for (const op of patch.acquired_state_ops ?? []) {
                if (op.op === 'upsert_slot' || op.op === 'remove_slot') {
                    const byBranch = getOrCreateMap(slotMutations, `${patch.entity_id}::${op.slot_key}`);
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
                        const byBranch = getOrCreateMap(
                            ledgerMutations,
                            `${patch.entity_id}::ledger::${ledgerKey}`
                        );
                        byBranch.set(delta.branchId, {
                            branchId: delta.branchId,
                            value: String(val)
                        });
                    }
                }
            }
        }
    }

    return { itemMutationsByEntity, itemClaimsAcrossBranches, slotMutations, ledgerMutations };
}

function assertNoItemConflicts(
    itemMutationsByEntity: BranchMutationAccumulator['itemMutationsByEntity'],
    itemClaimsAcrossBranches: BranchMutationAccumulator['itemClaimsAcrossBranches']
): void {
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

        if (!hasCrossPath && !hasMultiClaim && !hasDivergentEntityMutations) {
            continue;
        }

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

function assertNoSlotConflicts(
    slotMutations: BranchMutationAccumulator['slotMutations']
): void {
    for (const [compositeKey, byBranch] of slotMutations.entries()) {
        if (byBranch.size < 2) continue;
        const uniqueSigs = new Set([...byBranch.values()].map((v) => v.signature));
        if (uniqueSigs.size <= 1) continue;

        const [entityId, slotKey] = compositeKey.split('::') as [string, string];
        const details: ParallelConflictDetail[] = [...byBranch.values()].map((v) => ({
            branchId: v.branchId,
            slotKey,
            summary: v.summary
        }));
        throw new ParallelConflictError(entityId, details, slotKey);
    }
}

function assertNoLedgerConflicts(
    ledgerMutations: BranchMutationAccumulator['ledgerMutations']
): void {
    for (const [compositeKey, byBranch] of ledgerMutations.entries()) {
        if (byBranch.size < 2) continue;
        const uniqueVals = new Set([...byBranch.values()].map((v) => v.value));
        if (uniqueVals.size <= 1) continue;

        const [entityId, , ledgerKey] = compositeKey.split('::') as [string, string, string];
        const details: ParallelConflictDetail[] = [...byBranch.values()].map((v) => ({
            branchId: v.branchId,
            slotKey: ledgerKey,
            summary: `账本项 ${ledgerKey}=${v.value}`
        }));
        throw new ParallelConflictError(entityId, details, ledgerKey);
    }
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

        return await withTraceRun(this.store.bookRoot, 'parallel-fork', { window: options.windowId }, () => this.store.runWithTxLock(async () => {
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
                if (!isEnoentError(err)) throw err;
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
            await this.commitPathsWithRollback(
                forkPaths,
                `parallel(${options.windowId}): persist window`
            );
            return metadata;
        }));
    }

    /** 读取活跃窗口元数据与只读全局环境广播表 */
    async getWindow(windowId: string): Promise<ParallelWindowMetadata> {
        assertSafeId(windowId, 'windowId');
        const raw = await readFile(this.windowMetaPath(windowId), 'utf8');
        return JSON.parse(raw) as ParallelWindowMetadata;
    }

    /** 读取指定支线暂存的 L2 章卡增量列表（仅限本支线可见） */
    async getBranchL2Cards(windowId: string, branchId: string): Promise<ParallelL2CardEntry[]> {
        assertSafeId(windowId, 'windowId');
        assertSafeId(branchId, 'branchId');
        const deltas = await this.readBranchDeltas(windowId);
        const target = deltas.find((d) => d.branchId === branchId);
        return [...(target?.l2Cards ?? [])].sort((a, b) => a.chapterNumber - b.chapterNumber);
    }

    async getBranchNextOptions(windowId: string, branchId: string): Promise<string[]> {
        assertSafeId(branchId, 'branchId');
        const meta = await this.getWindow(windowId);
        if (meta.status !== 'OPEN') return [];
        const delta = (await this.readBranchDeltas(windowId)).find((d) => d.branchId === branchId);
        return delta?.nextChapterOptions ?? [];
    }

    /** 在新章生成前检查整个窗口的剩余容量；写入端仍会再次校验。 */
    async assertChapterCapacity(windowId: string): Promise<void> {
        const meta = await this.getWindow(windowId);
        const used = (await this.readBranchDeltas(windowId)).reduce((sum, d) => sum + d.chaptersUsed, 0);
        if (used + 1 > meta.maxChapters) {
            throw new ParallelWindowExceededError(windowId, used + 1, meta.maxChapters);
        }
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
            const baseProfile =
                entities[patch.entity_id] ??
                (await this.loadBaseProfile(metadata.baseTag, patch.entity_id));
            entities[patch.entity_id] = mergeEntityProfilePatch(baseProfile, patch, false);
        }
        const chapterFiles = snapshot.chapterFiles.filter((file) => {
            const chapter = Number(file.slice(3, -3));
            return chapter <= metadata.baseChapter || delta?.chapterNumbers?.includes(chapter);
        });
        const coldArchiveIds = snapshot.coldArchiveIds.filter((id) => !(id in entities));
        const coldEntities: Record<string, EntityProfile> = {};
        for (const id of coldArchiveIds) {
            const profile = await this.loadBaseProfile(metadata.baseTag, id);
            if (profile) coldEntities[id] = profile;
        }
        const parallelBroadcastEntries = toParallelBroadcastEntries(
            metadata.globalBroadcast,
            metadata.baseDay
        );
        return {
            ...snapshot,
            entities,
            coldEntities,
            coldArchiveIds,
            chapterFiles,
            parallelBroadcastEntries,
            worldState: {
                ...snapshot.worldState,
                summaryMarkdown: snapshot.worldState.summaryMarkdown,
                frontmatter: { ...snapshot.worldState.frontmatter, story_day: metadata.baseDay + (delta?.daySpan ?? 0) }
            }
        };
    }

    async appendChapter(
        input: StageParallelDeltaInput & { chapterNumber: number; l2Card?: ParallelL2CardEntry | undefined }
    ): Promise<ParallelBranchDelta> {
        return await this.store.runWithTxLock(async () => {
            assertSafeId(input.windowId, 'windowId');
            assertSafeId(input.branchId, 'branchId');
            if (!Number.isInteger(input.chapterNumber) || input.chapterNumber <= 0) {
                throw new Error(`非法的并行章号: ${String(input.chapterNumber)}`);
            }
            const windowMeta = await this.getWindow(input.windowId);
            if (input.chapterNumber <= windowMeta.baseChapter) {
                throw new Error(
                    `并行章号必须严格大于分叉基线章号 (${windowMeta.baseChapter})，收到 ${input.chapterNumber}`
                );
            }
            const deltas = await this.readBranchDeltas(input.windowId);
            if (deltas.some((item) => item.chapterNumbers?.includes(input.chapterNumber))) {
                throw new Error('并行章节已存在，拒绝跨支线覆盖或重复暂存');
            }
            const previous = deltas.find((item) => item.branchId === input.branchId);
            const prevLastChapter = previous?.chapterNumbers?.at(-1);
            if (prevLastChapter !== undefined && input.chapterNumber <= prevLastChapter) {
                throw new Error(
                    `支线 ${input.branchId} 章号必须严格递增（上一章为 ${prevLastChapter}，收到 ${input.chapterNumber}）`
                );
            }
            const incomingL2Cards = [
                ...(input.l2Cards ?? []),
                ...(input.l2Card ? [input.l2Card] : [])
            ];
            const mergedL2Cards = mergeParallelL2Cards(previous?.l2Cards, incomingL2Cards);
            return await this.stageDeltaLocked({
                ...input,
                patches: [...(previous?.patches ?? []), ...input.patches],
                chaptersUsed: (previous?.chaptersUsed ?? 0) + 1,
                chapterNumbers: [...(previous?.chapterNumbers ?? []), input.chapterNumber],
                daySpan: (previous?.daySpan ?? 0) + (input.daySpan ?? DEFAULT_PARALLEL_DAY_SPAN),
                ...(mergedL2Cards ? { l2Cards: mergedL2Cards } : {})
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
        const daySpan = input.daySpan ?? DEFAULT_PARALLEL_DAY_SPAN;
        if (chaptersUsed < 0 || daySpan < 0) {
            throw new Error('chaptersUsed 与 daySpan 不能为负数');
        }

        const existingDeltas = await this.readBranchDeltas(input.windowId);
        const otherBranchChapters = new Set<number>();
        for (const d of existingDeltas) {
            if (d.branchId === input.branchId) continue;
            for (const ch of d.chapterNumbers ?? []) {
                otherBranchChapters.add(ch);
            }
            for (const card of d.l2Cards ?? []) {
                otherBranchChapters.add(card.chapterNumber);
            }
        }

        if (input.chapterNumbers !== undefined) {
            let prevCh = windowMeta.baseChapter;
            for (const ch of input.chapterNumbers) {
                if (!Number.isInteger(ch) || ch <= 0) {
                    throw new Error(`非法的并行章号: ${String(ch)}`);
                }
                if (ch <= windowMeta.baseChapter) {
                    throw new Error(
                        `并行章号必须严格大于分叉基线章号 (${windowMeta.baseChapter})，收到 ${ch}`
                    );
                }
                if (ch <= prevCh) {
                    throw new Error(
                        `支线 ${input.branchId} 章号列表必须严格递增: ${input.chapterNumbers.join(', ')}`
                    );
                }
                if (otherBranchChapters.has(ch)) {
                    throw new Error(`并行章节已存在，拒绝跨支线覆盖或重复暂存: ${ch}`);
                }
                prevCh = ch;
            }
        }

        if (input.l2Cards !== undefined) {
            const seenL2Chapters = new Set<number>();
            for (const card of input.l2Cards) {
                if (!Number.isInteger(card.volumeNumber) || card.volumeNumber <= 0) {
                    throw new Error(`非法的 L2 章卡卷号: ${String(card.volumeNumber)}`);
                }
                if (!Number.isInteger(card.chapterNumber) || card.chapterNumber <= windowMeta.baseChapter) {
                    throw new Error(
                        `L2 章卡章号必须严格大于分叉基线章号 (${windowMeta.baseChapter})，收到 ${card.chapterNumber}`
                    );
                }
                if (seenL2Chapters.has(card.chapterNumber) || otherBranchChapters.has(card.chapterNumber)) {
                    throw new Error(`L2 章卡章号冲突: ${card.chapterNumber}`);
                }
                seenL2Chapters.add(card.chapterNumber);
            }
        }

        const totalChapters =
            existingDeltas
                .filter((d) => d.branchId !== input.branchId)
                .reduce((acc, d) => acc + d.chaptersUsed, 0) + chaptersUsed;

        if (totalChapters > windowMeta.maxChapters) {
            throw new ParallelWindowExceededError(input.windowId, totalChapters, windowMeta.maxChapters);
        }
        const profiles = new Map<string, EntityProfile>();
        const reachable = await collectReachableKeys(
            this.store.bookRoot,
            new Set(input.patches.map((patch) => patch.entity_id))
        );
        for (const patch of input.patches) {
            if (!ENTITY_ID_RE.test(patch.entity_id)) throw new Error(`非法 entity_id: ${patch.entity_id}`);
            const base =
                profiles.get(patch.entity_id) ??
                (await this.loadBaseProfile(windowMeta.baseTag, patch.entity_id));
            const profile = mergeEntityProfilePatch(base, patch, false);
            profiles.set(patch.entity_id, profile);
        }
        for (const id of new Set(input.patches.map((patch) => patch.entity_id))) {
            assertForeignKeysReachable(id, profiles.get(id)!, reachable);
        }

        const normalizedL2Cards =
            input.l2Cards && input.l2Cards.length > 0
                ? [...input.l2Cards].sort((a, b) => a.chapterNumber - b.chapterNumber)
                : undefined;

        const delta: ParallelBranchDelta = {
            windowId: input.windowId,
            branchId: input.branchId,
            ...(input.povCharacter ? { povCharacter: input.povCharacter } : {}),
            chaptersUsed,
            daySpan,
            patches: input.patches,
            stagedAt: new Date().toISOString(),
            ...(input.chapterNumbers ? { chapterNumbers: input.chapterNumbers } : {}),
            ...(input.nextChapterOptions ? { nextChapterOptions: input.nextChapterOptions } : {}),
            ...(normalizedL2Cards ? { l2Cards: normalizedL2Cards } : {})
        };

        await writeFile(this.branchDeltaPath(input.windowId, input.branchId), JSON.stringify(delta, null, 2), 'utf8');
        return delta;
    }

    /** 汇合执行 3-Way Merge（拦截唯一道具双线冲突与互斥槽位冲突，无冲突则统一推进 story_day 并合入 L2 章卡） */
    async mergeWindow(options: MergeParallelWindowOptions): Promise<MergeParallelWindowResult> {
        assertSafeId(options.windowId, 'windowId');

        return await withTraceRun(this.store.bookRoot, 'parallel-merge', { window: options.windowId }, () => this.store.runWithTxLock(async () => {
            const windowMeta = await this.getWindow(options.windowId);
            if (windowMeta.status !== 'OPEN') {
                throw new Error(`PARALLEL 时间窗 ${options.windowId} 当前状态为 ${windowMeta.status}，无法重复合并`);
            }

            if (options.restoreTimelineMode === 'PARALLEL') {
                throw new Error('并行窗口合并后不能恢复为 PARALLEL');
            }
            const [worldState, deltas] = await Promise.all([
                this.store.readWorldState(),
                this.readBranchDeltas(options.windowId)
            ]);

            const maxChapters = windowMeta.maxChapters;
            const totalChaptersUsed = deltas.reduce((acc, d) => acc + d.chaptersUsed, 0);
            if (totalChaptersUsed > maxChapters) {
                throw new ParallelWindowExceededError(options.windowId, totalChaptersUsed, maxChapters);
            }

            // 第一阶段：3-Way Merge 硬冲突检测（唯一道具双线夺取 / 同实体互斥槽位冲突）
            this.detectConflicts(deltas);

            // 第二阶段：从分叉基线 baseTag 读取实体快照（含冷宫回查）并合成 3-Way Merge 结果
            const allowInnate = options.allowInnateMutation === true;
            const mergedProfiles = new Map<string, EntityProfile>();
            const pendingNewEntityIds = new Set<string>();
            const wokenColdArchiveIds = new Set<string>();

            for (const delta of deltas) {
                for (const patch of delta.patches) {
                    let baseProfile = mergedProfiles.get(patch.entity_id) ?? null;
                    if (!baseProfile && !pendingNewEntityIds.has(patch.entity_id)) {
                        const loaded = await this.loadBaseProfileWithOrigin(windowMeta.baseTag, patch.entity_id);
                        if (loaded) {
                            baseProfile = loaded.profile;
                            if (loaded.fromColdArchive) {
                                wokenColdArchiveIds.add(patch.entity_id);
                            }
                        } else {
                            pendingNewEntityIds.add(patch.entity_id);
                        }
                    }
                    const nextProfile = mergeEntityProfilePatch(baseProfile, patch, allowInnate);
                    mergedProfiles.set(patch.entity_id, nextProfile);
                }
            }

            // 第三阶段：外键可达性校验（含新建实体与已有冷归档/章节）
            const reachableKeys = await collectReachableKeys(
                this.store.bookRoot,
                pendingNewEntityIds
            );
            for (const [entityId, profile] of mergedProfiles.entries()) {
                assertForeignKeysReachable(entityId, profile, reachableKeys);
            }

            // 准备分支 L2 章卡合并映射
            const l2CardsByPath = new Map<string, ParallelL2CardEntry[]>();
            const seenL2Chapters = new Set<number>();
            for (const delta of deltas) {
                for (const card of delta.l2Cards ?? []) {
                    if (seenL2Chapters.has(card.chapterNumber)) {
                        throw new Error(`PARALLEL 合并时发现重复的 L2 章卡章号: ${card.chapterNumber}`);
                    }
                    seenL2Chapters.add(card.chapterNumber);
                    const cardRelPath = `index/L2_cards/vol_${String(card.volumeNumber).padStart(2, '0')}_cards.md`;
                    const list = l2CardsByPath.get(cardRelPath) ?? [];
                    list.push(card);
                    l2CardsByPath.set(cardRelPath, list);
                }
            }
            const l2CardRelPaths = [...l2CardsByPath.keys()].sort();

            // 第四阶段：全部无冲突且校验通过后，落盘实体（含冷宫旧档迁回删除）、合入 L2 章卡、推进主时钟并提交 Git
            const tx = await this.store.readTxState();
            if (tx.phase === 'DRAFTING' || tx.phase === 'FEAT_COMMITTED') throw new Error('合并前必须完成章节恢复');
            const wokenColdRelPaths = [...wokenColdArchiveIds].map((id) => `entities/cold_archive/${id}.md`);
            await this.store.recordPendingWrites([
                ...[...mergedProfiles.keys()].map((id) => `entities/${id}.md`),
                ...wokenColdRelPaths,
                ...l2CardRelPaths,
                'world/world_state.md',
                `.ops/parallel_deltas/${options.windowId}/window.json`
            ]);
            const commitPaths: string[] = [];
            const updatedEntities: string[] = [];
            for (const [entityId, profile] of mergedProfiles.entries()) {
                const relPath = `entities/${entityId}.md`;
                await writeFile(join(this.store.bookRoot, relPath), serializeEntityMarkdown(profile), 'utf8');
                commitPaths.push(relPath);
                updatedEntities.push(entityId);
            }
            for (const wokenId of wokenColdArchiveIds) {
                const coldRelPath = `entities/cold_archive/${wokenId}.md`;
                try {
                    await unlink(join(this.store.bookRoot, coldRelPath));
                    commitPaths.push(coldRelPath);
                } catch (err: unknown) {
                    if (!isEnoentError(err)) throw err;
                }
            }

            for (const cardRelPath of l2CardRelPaths) {
                const entries = [...(l2CardsByPath.get(cardRelPath) ?? [])].sort(
                    (a, b) => a.chapterNumber - b.chapterNumber
                );
                const cardAbsPath = join(this.store.bookRoot, cardRelPath);
                await mkdir(dirname(cardAbsPath), { recursive: true });
                let existingCard: string | null = null;
                try {
                    existingCard = await readFile(cardAbsPath, 'utf8');
                } catch (err: unknown) {
                    if (!isEnoentError(err)) throw err;
                }
                let nextCard = existingCard;
                for (const entry of entries) {
                    nextCard = upsertParallelL2CardContent(nextCard, entry);
                }
                if (nextCard !== null) {
                    await writeFile(cardAbsPath, nextCard, 'utf8');
                    commitPaths.push(cardRelPath);
                }
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

            const commitRes = await this.commitPathsWithRollback(
                commitPaths,
                `merge(parallel-${options.windowId}): 3-way merge ${deltas.length} branches`
            );

            return {
                windowId: options.windowId,
                baseTag: windowMeta.baseTag,
                mergedBranches: deltas.map((d) => d.branchId),
                updatedEntities,
                ...(l2CardRelPaths.length > 0 ? { updatedL2CardPaths: l2CardRelPaths } : {}),
                previousStoryDay,
                newStoryDay,
                totalChaptersUsed,
                sha: commitRes.sha
            };
        }));
    }

    private async commitPathsWithRollback(
        commitPaths: string[],
        message: string
    ): Promise<{ sha: string }> {
        const pendingPath = join(this.store.bookRoot, '.ops/pending_writes.json');
        try {
            const commitRes = await this.system.commitPaths(this.store.bookRoot, commitPaths, message);
            await rm(pendingPath, { force: true });
            return commitRes;
        } catch (error) {
            await this.system.restorePaths(this.store.bookRoot, commitPaths);
            await rm(pendingPath, { force: true });
            throw error;
        }
    }

    private async readBranchDeltas(windowId: string): Promise<ParallelBranchDelta[]> {
        const dir = this.windowDir(windowId);
        let files: string[];
        try {
            files = await readdir(dir);
        } catch (err: unknown) {
            if (isEnoentError(err)) return [];
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
        const {
            itemMutationsByEntity,
            itemClaimsAcrossBranches,
            slotMutations,
            ledgerMutations
        } = collectBranchMutations(deltas);

        assertNoItemConflicts(itemMutationsByEntity, itemClaimsAcrossBranches);
        assertNoSlotConflicts(slotMutations);
        assertNoLedgerConflicts(ledgerMutations);
    }

    private async loadBaseProfile(baseTag: string, entityId: string): Promise<EntityProfile | null> {
        const loaded = await this.loadBaseProfileWithOrigin(baseTag, entityId);
        return loaded?.profile ?? null;
    }

    private async loadBaseProfileWithOrigin(
        baseTag: string,
        entityId: string
    ): Promise<{ profile: EntityProfile; fromColdArchive: boolean } | null> {
        const relPath = `entities/${entityId}.md`;
        const atTag = await this.system.readFileAtRef(this.store.bookRoot, baseTag, relPath);
        if (atTag !== null) {
            return { profile: parseEntityMarkdown(atTag), fromColdArchive: false };
        }
        const coldRelPath = `entities/cold_archive/${entityId}.md`;
        const coldAtTag = await this.system.readFileAtRef(this.store.bookRoot, baseTag, coldRelPath);
        if (coldAtTag !== null) {
            return { profile: parseEntityMarkdown(coldAtTag), fromColdArchive: true };
        }
        return null;
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

import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    assertEntryTagsSafe,
    BookDreamingConfigSchema,
    ForeignKeyError,
    InnateLockViolationError,
    parseEntityMarkdown,
    parseVoiceSamplesYaml,
    StaticProseGate,
    type NarrationSubjectivity,
    type NarrateStoreService
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PathFence } from '../tools/path-fence.js';
import {
    isEnoentError,
    matchesAnyPathPrefix,
    readOptionalBookConfig
} from '../tools/shared.js';
import {
    countActiveOpenThreads,
    DreamCommitInputSchema,
    hasChineseCharacter,
    type DreamCommitInput,
    type DreamCommitRecord
} from './schemas.js';
import {
    addEntityStemToReachableKeys,
    assertTextForeignKeys,
    collectReachableKeysFromBookDirs,
    ENTITY_ID_PATTERN_RE,
    extractActiveOpenThreadLines,
    hasOmniscientSecretMarker
} from './shared.js';

const ENTITY_PROFILE_PATH_RE = /^entities\/(?:cold_archive\/)?([^/]+)\.md$/;
const DEFAULT_DREAMING_CFG = BookDreamingConfigSchema.parse({});
const DREAM_READONLY_PROTECTED_PATHS = [
    'manuscripts',
    'world/roles',
    'world/author_charter.md',
    'world/book_config.yaml',
    'world/ops_style_amendments.md',
    'world/current_arc_envelope.md',
    'world/static_base_and_voice.md'
] as const;

function extractActiveThreadKeys(markdown: string): string[] {
    return extractActiveOpenThreadLines(markdown).map((trimmed) => {
        const idMatch = /^-\s*\[([^|\]]+)/.exec(trimmed);
        return idMatch?.[1]?.trim() || trimmed;
    });
}

export interface YieldDreamCommitOptions {
    store: NarrateStoreService;
    bookRoot: string;
    runId: string;
    fence?: PathFence | undefined;
    onYield?: ((record: DreamCommitRecord) => void) | undefined;
}

async function readDiskOptional(absPath: string): Promise<string | null> {
    try {
        const st = await lstat(absPath);
        if (st.isSymbolicLink()) {
            throw new GateValidationError(
                'yield_dream_commit',
                `禁止通过符号链接目标读取或覆写作品文件: ${absPath}`
            );
        }
        return await readFile(absPath, 'utf8');
    } catch (err: unknown) {
        if (isEnoentError(err)) {
            return null;
        }
        throw err;
    }
}

async function buildDreamReachableKeys(
    bookRoot: string,
    pendingWrites: Map<string, string>
): Promise<Set<string>> {
    const keys = await collectReachableKeysFromBookDirs(bookRoot, { skipSymlinks: true });

    for (const relPath of pendingWrites.keys()) {
        const entityMatch = ENTITY_PROFILE_PATH_RE.exec(relPath);
        if (entityMatch?.[1]) {
            addEntityStemToReachableKeys(entityMatch[1], keys, true);
        }
    }

    return keys;
}

async function assertDreamPendingWritePathsSafe(
    pendingWrites: ReadonlyMap<string, string>,
    fence: PathFence
): Promise<void> {
    for (const relPath of pendingWrites.keys()) {
        if (matchesAnyPathPrefix(relPath, DREAM_READONLY_PROTECTED_PATHS)) {
            const matchedPrefix = DREAM_READONLY_PROTECTED_PATHS.find((prefix) =>
                matchesAnyPathPrefix(relPath, [prefix])
            );
            throw new GateValidationError(
                'yield_dream_commit',
                `禁止 Dreamer 修改只读保护路径 (${matchedPrefix}): ${relPath}`
            );
        }
        await fence.assertWriteFile(relPath);
    }
}

async function validateStagedDreamEntities(
    bookRoot: string,
    pendingWrites: ReadonlyMap<string, string>
): Promise<void> {
    for (const [relPath, stagedContent] of pendingWrites.entries()) {
        const entityMatch = ENTITY_PROFILE_PATH_RE.exec(relPath);
        if (!entityMatch?.[1] || !ENTITY_ID_PATTERN_RE.test(entityMatch[1])) {
            continue;
        }
        const fileStem = entityMatch[1];
        const stagedProfile = parseEntityMarkdown(stagedContent);
        for (const sectionList of [
            stagedProfile.innateLocks,
            stagedProfile.acquiredState,
            stagedProfile.irreversibleTrajectory,
            stagedProfile.recentBuffer
        ]) {
            for (const entry of sectionList) {
                assertEntryTagsSafe(entry);
            }
        }
        if (stagedProfile.metadata.entity_id !== fileStem) {
            throw new GateValidationError(
                'yield_dream_commit',
                `实体档案 ${relPath} 的 entity_id (${stagedProfile.metadata.entity_id}) 与文件名不一致`
            );
        }

        const diskRaw = await readDiskOptional(join(bookRoot, relPath));
        if (diskRaw !== null) {
            const diskProfile = parseEntityMarkdown(diskRaw);
            if (stagedProfile.metadata.canonical_name !== diskProfile.metadata.canonical_name) {
                throw new InnateLockViolationError(
                    stagedProfile.metadata.entity_id,
                    `禁止篡改实体 ${stagedProfile.metadata.entity_id} 的 canonical_name (${diskProfile.metadata.canonical_name} -> ${stagedProfile.metadata.canonical_name})`
                );
            }
            if (JSON.stringify(stagedProfile.innateLocks) !== JSON.stringify(diskProfile.innateLocks)) {
                throw new InnateLockViolationError(
                    stagedProfile.metadata.entity_id,
                    `禁止篡改实体 ${stagedProfile.metadata.entity_id} 的 1. Innate Locks`
                );
            }
            continue;
        }

        if (!hasChineseCharacter(stagedProfile.metadata.canonical_name)) {
            throw new GateValidationError(
                'yield_dream_commit',
                `新建实体 ${stagedProfile.metadata.entity_id} 必须提供包含中文字符的 canonical_name`
            );
        }
        for (const lockEntry of stagedProfile.innateLocks) {
            if (hasOmniscientSecretMarker(lockEntry)) {
                throw new GateValidationError(
                    'yield_dream_commit',
                    `新建实体 ${stagedProfile.metadata.entity_id} 第 1 区 Innate Locks 严禁包含 OMNISCIENT_SECRET`
                );
            }
        }
    }
}

async function validateStagedOpenThreads(
    bookRoot: string,
    stagedThreads: string | undefined,
    dreamingCfg: typeof DEFAULT_DREAMING_CFG
): Promise<void> {
    if (stagedThreads === undefined) {
        return;
    }
    const activeThreads = countActiveOpenThreads(stagedThreads);
    if (activeThreads > dreamingCfg.max_active_open_threads) {
        throw new GateValidationError(
            'yield_dream_commit',
            `world/open_threads.md 活跃伏笔数 (${activeThreads}) 超过上限 ${dreamingCfg.max_active_open_threads} 条，请先归档已兑现伏笔`
        );
    }
    const diskThreadsRaw = (await readDiskOptional(join(bookRoot, 'world/open_threads.md'))) ?? '';
    const diskKeys = new Set(extractActiveThreadKeys(diskThreadsRaw));
    const stagedKeys = extractActiveThreadKeys(stagedThreads);
    const addedThreadCount = stagedKeys.filter((key) => !diskKeys.has(key)).length;
    if (addedThreadCount > dreamingCfg.max_new_threads_per_dream) {
        throw new GateValidationError(
            'yield_dream_commit',
            `单次 Dreaming 新增伏笔数 (${addedThreadCount}) 超过上限 ${dreamingCfg.max_new_threads_per_dream} 条`
        );
    }
}

function validateStagedVoiceSamples(
    stagedVoiceYaml: string | undefined,
    narrationSubjectivity: NarrationSubjectivity
): void {
    if (stagedVoiceYaml === undefined) {
        return;
    }
    const voicePool = parseVoiceSamplesYaml(stagedVoiceYaml);
    const proseGate = new StaticProseGate();
    for (const sample of voicePool.samples) {
        const gateRes = proseGate.evaluate(sample.text, { narrationSubjectivity });
        if (!gateRes.passed) {
            throw new GateValidationError(
                'yield_dream_commit',
                `.ops/voice_samples.yaml 样本 (${sample.id}/${sample.tag}) 未通过 StaticProseGate: ${gateRes.violations.map((v) => v.message).join('; ')}`
            );
        }
    }
}

function normalizeStagedSignalsJsonl(stagedSignalsRaw: string | undefined): string | undefined {
    if (stagedSignalsRaw === undefined) {
        return undefined;
    }
    const lines = stagedSignalsRaw.replace(/\r\n/g, '\n').split('\n');
    const validLines: string[] = [];
    for (let idx = 0; idx < lines.length; idx += 1) {
        const trimmed = lines[idx]!.trim();
        if (!trimmed) continue;
        try {
            JSON.parse(trimmed);
        } catch {
            throw new GateValidationError(
                'yield_dream_commit',
                `.ops/signals.jsonl 第 ${idx + 1} 行不是合法 JSON`
            );
        }
        validLines.push(trimmed);
    }
    return validLines.length > 0 ? `${validLines.join('\n')}\n` : '';
}

async function writeStagedDreamFiles(
    bookRoot: string,
    pendingWrites: ReadonlyMap<string, string>,
    normalizedStagedSignals: string | undefined
): Promise<string[]> {
    const committedRelPaths: string[] = [];
    for (const [relPath, rawContent] of pendingWrites.entries()) {
        const absTarget = join(bookRoot, relPath);
        try {
            const st = await lstat(absTarget);
            if (st.isSymbolicLink()) {
                throw new GateValidationError(
                    'yield_dream_commit',
                    `禁止覆盖符号链接目标: ${relPath}`
                );
            }
        } catch (err: unknown) {
            if (!isEnoentError(err)) {
                throw err;
            }
        }
        const contentToWrite =
            relPath === '.ops/signals.jsonl' && normalizedStagedSignals !== undefined
                ? normalizedStagedSignals
                : rawContent;
        await mkdir(dirname(absTarget), { recursive: true });
        await writeFile(absTarget, contentToWrite, 'utf8');
        committedRelPaths.push(relPath);
    }
    return committedRelPaths;
}

async function appendDreamSpotlightSignals(
    bookRoot: string,
    triggers: DreamCommitInput['spotlight_triggers'],
    chapterNum: number,
    normalizedStagedSignals: string | undefined,
    committedRelPaths: string[]
): Promise<void> {
    if (triggers.length === 0) {
        return;
    }
    const signalsPath = join(bookRoot, '.ops/signals.jsonl');
    await mkdir(dirname(signalsPath), { recursive: true });
    let prefixNewline = '';
    if (normalizedStagedSignals === undefined) {
        const existingSignals = await readDiskOptional(signalsPath);
        if (existingSignals && existingSignals.length > 0 && !existingSignals.endsWith('\n')) {
            prefixNewline = '\n';
        }
    }
    const newLines = triggers.map((trigger) =>
        JSON.stringify({
            id: `sig_dream_${randomUUID()}`,
            type: 'SPOTLIGHT_TRIGGER',
            created_at: new Date().toISOString(),
            chapter: chapterNum,
            entity_id: trigger.entity_id,
            suggested_mode: trigger.suggested_mode,
            reason: trigger.reason
        })
    );
    await appendFile(signalsPath, `${prefixNewline}${newLines.join('\n')}\n`, 'utf8');
    if (!committedRelPaths.includes('.ops/signals.jsonl')) {
        committedRelPaths.push('.ops/signals.jsonl');
    }
}

/** 创建 Dreamer 终态门禁工具 yield_dream_commit（全部校验通过后方写入磁盘、提交 dream 事务并结束回合） */
export function createYieldDreamCommitTool(options: YieldDreamCommitOptions): ToolDefinition {
    const { store, bookRoot, runId, onYield } = options;
    const fence = options.fence ?? new PathFence(bookRoot);

    return defineTool({
        name: 'yield_dream_commit',
        description:
            'Dreamer 终态原子提交门禁。在事务锁下校验非 DRAFTING/FEAT_COMMITTED 相位、manuscripts/ 禁写、Innate Locks 零篡改、活跃伏笔 <= 15 与 1ms 外键可达性；全部通过后原子落盘并提交 Git dream 事务。',
        parameters: {
            summary: {
                type: 'string',
                required: true,
                description: '本轮 Dreaming 整理总结'
            },
            chapter_number: {
                type: 'integer',
                description: '当前关联章节号（可选，默认取 last_committed_ch）'
            },
            accumulated_words: {
                type: 'integer',
                description: '本次清理前累计字数（默认 0）'
            },
            spotlight_triggers: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        entity_id: { type: 'string', required: true },
                        reason: { type: 'string', required: true },
                        suggested_mode: { type: 'string', enum: ['MAINLINE', 'PARALLEL'] }
                    }
                },
                description: '需投递至 .ops/signals.jsonl 的离场角色前台切镜信号'
            }
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    accepted: { type: 'boolean', required: true },
                    chapterNumber: { type: 'integer', required: true },
                    committedPaths: { type: 'array', required: true, items: { type: 'string' } }
                }
            },
            render(_args, value) {
                return [
                    {
                        type: 'text',
                        text: `yield_dream_commit 提交成功 (ch=${value.chapterNumber})，落盘文件: [${value.committedPaths.join(', ')}]`
                    }
                ];
            }
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            exec.signal.throwIfAborted();
            const parsed = DreamCommitInputSchema.parse(args);

            if (!store.staging.has(runId)) {
                throw new GateValidationError('yield_dream_commit', `暂存会话不存在 (runId=${runId})`);
            }

            const bookStore = store.openStore(bookRoot);
            const cfg = await readOptionalBookConfig(store, bookRoot);
            const dreamingCfg = cfg?.dreaming
                ? { ...DEFAULT_DREAMING_CFG, ...cfg.dreaming }
                : DEFAULT_DREAMING_CFG;
            const narrationSubjectivity: NarrationSubjectivity =
                cfg?.narration_subjectivity ?? 'objective_third';

            const record = await bookStore.withTxLock(async (): Promise<DreamCommitRecord> => {
                // 0. 校验当前 WAL 相位允许执行 Dreaming（拒绝 DRAFTING 与 FEAT_COMMITTED）
                const txState = await bookStore.assertDreamingPhaseSafe();
                const pendingWrites = store.staging.getPendingWrites(runId);

                // 1. 校验暂存路径白名单，物理拒止 manuscripts/、只读世界保护集、current_arc_envelope.md 与越界路径
                await assertDreamPendingWritePathsSafe(pendingWrites, fence);

                // 2. 校验所有暂存实体档案（含 cold_archive 实体，跳过非实体文档如 warped_horizon.md）
                await validateStagedDreamEntities(bookRoot, pendingWrites);

                // 3. 校验暂存 world/open_threads.md 的活跃伏笔上限与单次新增伏笔上限
                await validateStagedOpenThreads(
                    bookRoot,
                    pendingWrites.get('world/open_threads.md'),
                    dreamingCfg
                );

                // 3.1 若暂存修改了 .ops/voice_samples.yaml，对每条声纹强制跑 StaticProseGate
                validateStagedVoiceSamples(
                    pendingWrites.get('.ops/voice_samples.yaml'),
                    narrationSubjectivity
                );

                // 3.2 若暂存修改了 .ops/signals.jsonl，校验每行合法 JSON 并确保尾换行
                const normalizedStagedSignals = normalizeStagedSignalsJsonl(
                    pendingWrites.get('.ops/signals.jsonl')
                );

                // 4. 1ms 跨文件外键可达性校验（char_* / item_* / ch_XXXX）
                const reachableKeys = await buildDreamReachableKeys(bookRoot, pendingWrites);
                for (const [relPath, content] of pendingWrites.entries()) {
                    assertTextForeignKeys(relPath, content, reachableKeys);
                }
                for (const trigger of parsed.spotlight_triggers) {
                    if (!reachableKeys.has(trigger.entity_id)) {
                        throw new ForeignKeyError([trigger.entity_id], 'spotlight_triggers');
                    }
                }

                // 5. 全部确定性门禁通过：在首次落盘前写入 .ops/pending_writes.json 崩溃恢复清单
                const allTargetRelPaths = [...pendingWrites.keys()];
                if (
                    parsed.spotlight_triggers.length > 0 &&
                    !allTargetRelPaths.includes('.ops/signals.jsonl')
                ) {
                    allTargetRelPaths.push('.ops/signals.jsonl');
                }
                if (!allTargetRelPaths.includes('.ops/dream_watermark.json')) {
                    allTargetRelPaths.push('.ops/dream_watermark.json');
                }
                await bookStore.recordPendingWrites(allTargetRelPaths);

                // 6. 原子写入暂存文件到磁盘（落盘前再次 lstat 拦截符号链接目标）
                const committedRelPaths = await writeStagedDreamFiles(
                    bookRoot,
                    pendingWrites,
                    normalizedStagedSignals
                );

                const chapterNumber = parsed.chapter_number ?? txState.last_committed_ch;

                // 写入可选 Spotlight Trigger 信号（lstat 防软链 + 补齐既有文件尾换行 + 唯一 id 对齐 Q6）
                await appendDreamSpotlightSignals(
                    bookRoot,
                    parsed.spotlight_triggers,
                    chapterNumber,
                    normalizedStagedSignals,
                    committedRelPaths
                );

                // 更新 .ops/dream_watermark.json（整理完成后将累计新增字数水位确定性归零）
                await bookStore.writeDreamWatermark({
                    last_dream_ch: chapterNumber,
                    accumulated_words_since_dream: 0,
                    updated_at: new Date().toISOString()
                });
                if (!committedRelPaths.includes('.ops/dream_watermark.json')) {
                    committedRelPaths.push('.ops/dream_watermark.json');
                }

                await bookStore.markDreamCommitted(chapterNumber, committedRelPaths);

                // 提交成功后清理暂存会话
                store.staging.discard(runId);

                return {
                    summary: parsed.summary,
                    chapterNumber,
                    committedPaths: committedRelPaths,
                    spotlightTriggerCount: parsed.spotlight_triggers.length
                };
            });

            onYield?.(record);
            exec.concludeTurn();

            return {
                accepted: true,
                chapterNumber: record.chapterNumber,
                committedPaths: record.committedPaths
            };
        }
    });
}

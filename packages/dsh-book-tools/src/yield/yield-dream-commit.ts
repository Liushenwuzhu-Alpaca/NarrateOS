import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
    ForeignKeyError,
    InnateLockViolationError,
    parseEntityMarkdown,
    type NarrateStoreService
} from '@narrateos/dsh-book-store';
import { GateValidationError } from '../errors.js';
import { PathFence } from '../tools/path-fence.js';
import {
    countActiveOpenThreads,
    DreamCommitInputSchema,
    hasChineseCharacter,
    type DreamCommitRecord
} from './schemas.js';

const ENTITY_PROFILE_PATH_RE = /^entities\/([^/]+)\.md$/;
const ENTITY_ID_FILENAME_RE = /^((?:char|item)_[a-zA-Z0-9_]+)$/;

export interface YieldDreamCommitOptions {
    store: NarrateStoreService;
    bookRoot: string;
    runId: string;
    fence?: PathFence | undefined;
    onYield?: ((record: DreamCommitRecord) => void) | undefined;
}

async function readDiskOptional(absPath: string): Promise<string | null> {
    try {
        return await readFile(absPath, 'utf8');
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

async function buildDreamReachableKeys(
    bookRoot: string,
    pendingWrites: Map<string, string>
): Promise<Set<string>> {
    const keys = new Set<string>();

    const collectDir = async (dirPath: string) => {
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
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
        }
    };

    await Promise.all([
        collectDir(join(bookRoot, 'entities')),
        collectDir(join(bookRoot, 'entities/cold_archive')),
        collectDir(join(bookRoot, 'manuscripts'))
    ]);

    for (const relPath of pendingWrites.keys()) {
        const entityMatch = ENTITY_PROFILE_PATH_RE.exec(relPath);
        if (entityMatch?.[1]) {
            keys.add(entityMatch[1]);
            continue;
        }
        const coldMatch = /^entities\/cold_archive\/([^/]+)\.md$/.exec(relPath);
        if (coldMatch?.[1]) {
            keys.add(coldMatch[1]);
            const sagaMatch = /^((?:char|item)_[a-zA-Z0-9_]+?)_saga_\d+$/.exec(coldMatch[1]);
            if (sagaMatch?.[1]) {
                keys.add(sagaMatch[1]);
            }
        }
    }

    return keys;
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

            const record = await bookStore.withTxLock(async (): Promise<DreamCommitRecord> => {
                // 0. 校验当前 WAL 相位允许执行 Dreaming（拒绝 DRAFTING 与 FEAT_COMMITTED）
                const txState = await bookStore.assertDreamingPhaseSafe();
                const pendingWrites = store.staging.getPendingWrites(runId);

                // 1. 校验暂存路径白名单，严格拦截 manuscripts/ 与越界路径
                for (const relPath of pendingWrites.keys()) {
                    if (relPath === 'manuscripts' || relPath.startsWith('manuscripts/')) {
                        throw new GateValidationError(
                            'yield_dream_commit',
                            `禁止 Dreamer 提交修改正稿目录 manuscripts/: ${relPath}`
                        );
                    }
                    await fence.assertWriteFile(relPath);
                }

                // 2. 校验所有暂存实体档案：既有实体 Innate Locks & canonical_name 零篡改，新建实体必填中文 canonical_name
                for (const [relPath, stagedContent] of pendingWrites.entries()) {
                    const entityMatch = ENTITY_PROFILE_PATH_RE.exec(relPath);
                    if (!entityMatch?.[1]) {
                        continue;
                    }
                    const fileStem = entityMatch[1];
                    const stagedProfile = parseEntityMarkdown(stagedContent);
                    if (ENTITY_ID_FILENAME_RE.test(fileStem) && stagedProfile.metadata.entity_id !== fileStem) {
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
                        if (
                            JSON.stringify(stagedProfile.innateLocks) !==
                            JSON.stringify(diskProfile.innateLocks)
                        ) {
                            throw new InnateLockViolationError(
                                stagedProfile.metadata.entity_id,
                                `禁止篡改实体 ${stagedProfile.metadata.entity_id} 的 1. Innate Locks`
                            );
                        }
                    } else if (!hasChineseCharacter(stagedProfile.metadata.canonical_name)) {
                        throw new GateValidationError(
                            'yield_dream_commit',
                            `新建实体 ${stagedProfile.metadata.entity_id} 必须提供包含中文字符的 canonical_name`
                        );
                    }
                }

                // 3. 校验暂存 world/open_threads.md 的活跃伏笔数量 <= 15
                const stagedThreads = pendingWrites.get('world/open_threads.md');
                if (stagedThreads !== undefined) {
                    const activeThreads = countActiveOpenThreads(stagedThreads);
                    if (activeThreads > 15) {
                        throw new GateValidationError(
                            'yield_dream_commit',
                            `world/open_threads.md 活跃伏笔数 (${activeThreads}) 超过上限 15 条，请先归档已兑现伏笔`
                        );
                    }
                }

                // 4. 1ms 跨文件外键可达性校验（char_* / item_* / ch_XXXX）
                const reachableKeys = await buildDreamReachableKeys(bookRoot, pendingWrites);
                for (const [relPath, content] of pendingWrites.entries()) {
                    const missing = new Set<string>();
                    for (const match of content.matchAll(/\b(char_[a-zA-Z0-9_]+|item_[a-zA-Z0-9_]+|ch_\d{4})\b/g)) {
                        const refId = match[1];
                        if (refId && !reachableKeys.has(refId)) {
                            missing.add(refId);
                        }
                    }
                    if (missing.size > 0) {
                        throw new ForeignKeyError([...missing], relPath);
                    }
                }

                // 校验 Spotlight Trigger 中的实体可达性
                for (const trigger of parsed.spotlight_triggers) {
                    if (!reachableKeys.has(trigger.entity_id)) {
                        throw new ForeignKeyError([trigger.entity_id], 'spotlight_triggers');
                    }
                }

                // 5. 全部确定性门禁通过：原子写入暂存文件到磁盘
                const committedRelPaths: string[] = [];
                for (const [relPath, content] of pendingWrites.entries()) {
                    const absTarget = join(bookRoot, relPath);
                    await mkdir(dirname(absTarget), { recursive: true });
                    await writeFile(absTarget, content, 'utf8');
                    committedRelPaths.push(relPath);
                }

                // 写入可选 Spotlight Trigger 信号
                if (parsed.spotlight_triggers.length > 0) {
                    const chapterNum = parsed.chapter_number ?? txState.last_committed_ch;
                    const signalsPath = join(bookRoot, '.ops/signals.jsonl');
                    await mkdir(dirname(signalsPath), { recursive: true });
                    for (const trigger of parsed.spotlight_triggers) {
                        const signalLine = JSON.stringify({
                            type: 'SPOTLIGHT_TRIGGER',
                            created_at: new Date().toISOString(),
                            chapter: chapterNum,
                            entity_id: trigger.entity_id,
                            suggested_mode: trigger.suggested_mode,
                            reason: trigger.reason
                        });
                        await appendFile(signalsPath, `${signalLine}\n`, 'utf8');
                    }
                    committedRelPaths.push('.ops/signals.jsonl');
                }

                const chapterNumber = parsed.chapter_number ?? txState.last_committed_ch;

                // 更新 .ops/dream_watermark.json 并执行 Git dream 提交
                await bookStore.writeDreamWatermark({
                    last_dream_ch: chapterNumber,
                    accumulated_words_since_dream: parsed.accumulated_words,
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

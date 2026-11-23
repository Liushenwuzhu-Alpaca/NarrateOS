import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { TokenUsage } from '@narrateos/dsh-book-store';
import { TaskConflictError } from '../errors.js';
import type { EngineStageName } from '../schemas.js';
import { addUsage, sha256Hex } from './helpers.js';

const retryInputSchema = z.object({
    chapterGoal: z.string(),
    chapterNumber: z.number().int().min(1).max(9999),
    timelineMode: z.enum(['MAINLINE', 'PARALLEL', 'FLASHBACK']),
    targetDay: z.number().int(),
    parallelWindowId: z.string().optional(),
    parallelBranchId: z.string().optional(),
    povCharIds: z.array(z.string())
});

type RetryInput = z.infer<typeof retryInputSchema>;

const retrySchema = z.object({
    version: z.literal(1),
    input: retryInputSchema,
    fingerprint: z.string(),
    pendingStage: z.string(),
    results: z.array(z.object({
        stage: z.string(),
        output: z.unknown(),
        usage: z.object({
            inputTokens: z.number(), outputTokens: z.number(),
            cacheReadTokens: z.number(), cacheWriteTokens: z.number()
        })
    }))
});

type RetryJournal = z.infer<typeof retrySchema>;

// 与诊断产物一样本地保留，但不受 trace_level 影响，不参与 Git 或 WAL。
function retryPath(bookRoot: string): string {
    return join(bookRoot, '.ops/traces/chapter-retry.json');
}

export async function readChapterRetry(bookRoot: string): Promise<RetryJournal | null> {
    let raw: string;
    try {
        raw = await readFile(retryPath(bookRoot), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    try {
        const separator = raw.indexOf('\n');
        if (separator !== 64) return null;
        const data = raw.slice(separator + 1);
        if (sha256Hex(data) !== raw.slice(0, separator)) return null;
        return retrySchema.parse(JSON.parse(data));
    } catch {
        return null;
    }
}

export async function clearChapterRetry(bookRoot: string): Promise<void> {
    await rm(retryPath(bookRoot), { force: true });
}

/** 重放已验证的模型结果，由原管线重新执行确定性门禁与分支判断。 */
export class ChapterRetry {
    private cursor = 0;
    private readonly journal: RetryJournal;

    constructor(
        private readonly bookRoot: string,
        input: RetryInput,
        fingerprint: string,
        saved: RetryJournal | null,
        private readonly usage: TokenUsage,
        private readonly signal: AbortSignal | undefined
    ) {
        if (saved && saved.fingerprint !== fingerprint) {
            throw new TaskConflictError('章节输入或作品资产已变化，断点已保留；请恢复原输入或选择从头重跑');
        }
        this.journal = saved ?? { version: 1, input, fingerprint, pendingStage: 'LIBRARIAN', results: [] };
    }

    private async persist(): Promise<void> {
        const target = retryPath(this.bookRoot);
        const temp = `${target}.${randomUUID()}.tmp`;
        const data = JSON.stringify(this.journal);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        try {
            await writeFile(temp, `${sha256Hex(data)}\n${data}`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await rename(temp, target);
        } catch (error) {
            await rm(temp, { force: true });
            throw error;
        }
    }

    get replaying(): boolean {
        return this.cursor < this.journal.results.length;
    }

    async run<T>(stage: EngineStageName, work: () => Promise<T>): Promise<T> {
        this.signal?.throwIfAborted();
        const previous = this.journal.results[this.cursor];
        if (previous) {
            if (previous.stage !== stage) {
                throw new TaskConflictError('断点与当前管线步骤不一致；请选择从头重跑');
            }
            this.cursor += 1;
            addUsage(this.usage, previous.usage);
            return previous.output as T;
        }
        this.journal.pendingStage = stage;
        await this.persist();
        this.signal?.throwIfAborted();
        const before = { ...this.usage };
        const output = await work();
        this.journal.results.push({
            stage,
            output,
            usage: {
                inputTokens: this.usage.inputTokens - before.inputTokens,
                outputTokens: this.usage.outputTokens - before.outputTokens,
                cacheReadTokens: this.usage.cacheReadTokens - before.cacheReadTokens,
                cacheWriteTokens: this.usage.cacheWriteTokens - before.cacheWriteTokens
            }
        });
        this.cursor += 1;
        await this.persist();
        return output;
    }

    /** 门禁已确认本轮失败时，丢弃被拒产物及以它为输入的后续结果。 */
    async rejectFrom(...stages: EngineStageName[]): Promise<void> {
        const index = this.journal.results.findLastIndex(({ stage }) =>
            stages.some((rejected) => rejected === stage)
        );
        if (index < 0) return;
        this.journal.pendingStage = this.journal.results[index]!.stage;
        this.journal.results.length = index;
        await this.persist();
    }

    async beforeCommit(): Promise<void> {
        this.signal?.throwIfAborted();
        if (this.cursor !== this.journal.results.length) {
            throw new TaskConflictError('断点仍有结果未重放；请选择从头重跑');
        }
        this.journal.pendingStage = 'COMMITTED';
        await this.persist();
        this.signal?.throwIfAborted();
    }
}

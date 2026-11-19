import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BookStore } from '@narrateos/dsh-book-store';
import { PathValidationError, TaskConflictError } from '../errors.js';
import { readOptionalText, sha256Hex } from '../pipeline/helpers.js';
import type { SuspectedConflict } from '../schemas.js';

export interface SyncConflictSelection {
    bookSlug: string;
    reportRevision: string;
    conflictIndex: number;
}

interface ConflictReport {
    conflicts: unknown[];
    dirtyChapters?: number[];
    [key: string]: unknown;
}

export function parseConflictReport(raw: string | null): ConflictReport {
    if (raw === null) return { conflicts: [] };
    try {
        const report = JSON.parse(raw) as ConflictReport;
        if (Array.isArray(report.conflicts)) return report;
    } catch { /* 统一报告损坏错误 */ }
    throw new PathValidationError('.ops/sync_conflicts.json 格式损坏');
}

export function reportConflict(report: ConflictReport, revision: string, index: number): SuspectedConflict {
    const item = report.conflicts[index];
    if (!item || typeof item !== 'object' || !('chapterNumber' in item) ||
        typeof item.chapterNumber !== 'number' || !Number.isSafeInteger(item.chapterNumber) || item.chapterNumber < 1 ||
        !('quote' in item) || typeof item.quote !== 'string' ||
        !('description' in item) || typeof item.description !== 'string') {
        throw new PathValidationError('无法识别所选跨章冲突');
    }
    const chapterA = 'dirtyChapter' in item && typeof item.dirtyChapter === 'number'
        ? item.dirtyChapter : (report.dirtyChapters?.[0] ?? 1);
    return {
        conflictId: `sync-${revision}-${index}`,
        chapterA, quoteA: 'dirtyQuote' in item && typeof item.dirtyQuote === 'string' && item.dirtyQuote.trim()
            ? item.dirtyQuote : item.quote,
        chapterB: item.chapterNumber, quoteB: item.quote, description: item.description
    };
}

/** 只核销本版本已完成的一项。版本变动时不能按旧下标删除。 */
export async function acknowledgeConflict(store: BookStore, raw: string, index: number): Promise<string> {
    return store.withTxLock(async () => {
        const path = join(store.bookRoot, '.ops/sync_conflicts.json');
        if (await readOptionalText(path) !== raw) throw new TaskConflictError('冲突清单已更新，请刷新后重试');
        const report = parseConflictReport(raw);
        report.conflicts.splice(index, 1);
        if (!report.conflicts.length) report.dirtyChapters = [];
        report.updatedAt = new Date().toISOString();
        const next = `${JSON.stringify(report, null, 4)}\n`;
        const tmp = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(tmp, next, { flag: 'wx' });
            await rename(tmp, path);
        } finally {
            await rm(tmp, { force: true });
        }
        return next;
    });
}

export function conflictRevision(bookRoot: string, raw: string | null): string {
    return sha256Hex(`${bookRoot}\0${raw ?? ''}`);
}

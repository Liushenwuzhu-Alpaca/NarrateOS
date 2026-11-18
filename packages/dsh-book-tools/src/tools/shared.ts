import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { BookConfig, NarrateStoreService } from '@narrateos/dsh-book-store';

/** 判断异常是否为文件系统 ENOENT（路径不存在） */
export function isEnoentError(err: unknown): boolean {
    return (err as { code?: string }).code === 'ENOENT';
}

/** 转义正则表达式元字符 */
export function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 将路径分隔符统一为 POSIX `/` 并按需裁剪前导 `./` 与尾斜杠 */
export function normalizeRelPosixPath(
    rawPath: string,
    options: { trim?: boolean; stripTrailingSlash?: boolean } = {}
): string {
    const withForwardSlashes = rawPath.replace(/\\/g, '/');
    const source = options.trim ? withForwardSlashes.trim() : withForwardSlashes;
    const normalized = posix.normalize(source).replace(/^\.\//, '');
    if (options.stripTrailingSlash) {
        return normalized.replace(/\/+$/, '');
    }
    return normalized;
}

/** 判断归一化相对路径是否等于前缀或位于其子路径下 */
export function matchesPathPrefix(relPath: string, prefix: string): boolean {
    return relPath === prefix || relPath.startsWith(`${prefix}/`);
}

/** 判断归一化相对路径是否命中任意作用域前缀 */
export function matchesAnyPathPrefix(relPath: string, prefixes: readonly string[]): boolean {
    return prefixes.some((prefix) => matchesPathPrefix(relPath, prefix));
}

/** 合并分支覆盖层与当前 runId 的 StagingSession 待提交修改 */
export function buildCombinedStagingOverlay(
    store: NarrateStoreService,
    runId: string,
    stagingOverlay?: ReadonlyMap<string, string | null>,
    options: { normalizeKeys?: boolean } = {}
): Map<string, string | null> {
    const combined = new Map<string, string | null>();
    if (stagingOverlay) {
        for (const [key, value] of stagingOverlay.entries()) {
            const targetKey = options.normalizeKeys ? normalizeRelPosixPath(key) : key;
            combined.set(targetKey, value);
        }
    }
    if (store.staging.has(runId)) {
        for (const [key, value] of store.staging.getPendingWrites(runId).entries()) {
            const targetKey = options.normalizeKeys ? normalizeRelPosixPath(key) : key;
            combined.set(targetKey, value);
        }
    }
    return combined;
}

/** 按「本 run 暂存 > 分支覆盖层 > StagingSession 读 > 磁盘」优先级读取文本内容 */
export async function readContentWithStagingPriority(params: {
    store: NarrateStoreService;
    runId: string;
    normalizedPath: string;
    absPath: string;
    stagingOverlay?: ReadonlyMap<string, string | null> | undefined;
    missingInOverlayMessage: string;
}): Promise<{ content: string; fromStaging: boolean }> {
    const { store, runId, normalizedPath, absPath, stagingOverlay, missingInOverlayMessage } = params;
    const hasStagingSession = store.staging.has(runId);

    if (hasStagingSession && store.staging.getPendingWrites(runId).has(normalizedPath)) {
        return {
            content: await store.staging.read(runId, normalizedPath),
            fromStaging: true
        };
    }
    if (stagingOverlay?.has(normalizedPath)) {
        const overlayVal = stagingOverlay.get(normalizedPath);
        if (overlayVal === null || overlayVal === undefined) {
            throw new Error(missingInOverlayMessage);
        }
        return {
            content: overlayVal,
            fromStaging: true
        };
    }
    if (hasStagingSession) {
        return {
            content: await store.staging.read(runId, normalizedPath),
            fromStaging: false
        };
    }
    return {
        content: await readFile(absPath, 'utf8'),
        fromStaging: false
    };
}

/** 读取可选磁盘 UTF-8 文件；不存在时返回 null，其余 I/O 异常原样抛出 */
export async function readOptionalDiskText(absPath: string): Promise<string | null> {
    try {
        return await readFile(absPath, 'utf8');
    } catch (err: unknown) {
        if (isEnoentError(err)) {
            return null;
        }
        throw err;
    }
}

/** 读取可选 book_config.yaml；缺失或不可读时返回 null */
export async function readOptionalBookConfig(
    store: NarrateStoreService,
    bookRoot: string
): Promise<BookConfig | null> {
    try {
        return await store.openStore(bookRoot).readBookConfig();
    } catch {
        return null;
    }
}

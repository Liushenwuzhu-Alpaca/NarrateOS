import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { PathFenceError } from '../errors.js';

/** 允许工种读取/检索的作品顶级目录白名单 */
export const ALLOWED_READ_DIRS = [
    'world',
    'lore_library',
    'index',
    'entities',
    'manuscripts'
] as const;

/** 允许工种通过暂存区编辑的作品顶级目录白名单（物理排除 manuscripts 与 .ops） */
export const ALLOWED_WRITE_DIRS = [
    'world',
    'lore_library',
    'index',
    'entities'
] as const;

/** 永久禁止工种工具访问的 .ops 内部事务/日志路径前缀 */
const HARD_BLOCKED_OPS_PATHS = [
    '.ops/tx.lock',
    '.ops/tx_state.json',
    '.ops/runs.jsonl',
    '.ops/pending_writes.json',
    '.ops/recovery',
    '.ops/traces',
    '.ops/parallel_deltas',
    '.ops/chapter_outlines'
] as const;

const ALLOWED_READ_DIR_SET = new Set<string>(ALLOWED_READ_DIRS);
const ALLOWED_WRITE_DIR_SET = new Set<string>(ALLOWED_WRITE_DIRS);

function isInsideRealRoot(realRoot: string, realCandidate: string): boolean {
    const rel = relative(realRoot, realCandidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isHardBlockedOpsPath(normalized: string): boolean {
    return HARD_BLOCKED_OPS_PATHS.some(
        (blocked) => normalized === blocked || normalized.startsWith(`${blocked}/`)
    );
}

function normalizeOpsWhitelistEntry(raw: string): string {
    const slash = raw.replace(/\\/g, '/').trim();
    if (
        slash.length === 0 ||
        slash.includes('\0') ||
        isAbsolute(slash) ||
        slash.split('/').includes('..')
    ) {
        throw new PathFenceError(raw, `非法的 .ops 白名单条目: ${raw}`);
    }
    const normalized = posix.normalize(slash).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized.startsWith('.ops/')) {
        throw new PathFenceError(raw, `allowedOpsPaths 条目必须以 .ops/ 开头: ${raw}`);
    }
    if (isHardBlockedOpsPath(normalized)) {
        throw new PathFenceError(raw, `禁止将事务核心路径加入白名单: ${raw}`);
    }
    return normalized;
}

async function nearestExistingPath(targetPath: string): Promise<string> {
    let current = targetPath;
    while (true) {
        try {
            await lstat(current);
            return current;
        } catch (err: unknown) {
            if ((err as { code?: string }).code !== 'ENOENT') {
                throw err;
            }
            const parent = dirname(current);
            if (parent === current) {
                return current;
            }
            current = parent;
        }
    }
}

/** PathFence 配置选项 */
export interface PathFenceOptions {
    /** 显式放行只读的 .ops/ 具体文件路径白名单（默认空，全面屏蔽 .ops/） */
    allowedOpsPaths?: string[] | undefined;
    /** 显式放行暂存编辑的 .ops/ 具体文件路径白名单（默认空，全面屏蔽 .ops/） */
    allowedOpsWritePaths?: string[] | undefined;
}

/**
 * 作品路径围栏（PathFence）
 * - 将所有读写检索严格锁死在当前 bookRoot 允许目录内；
 * - 默认物理拦截 ../、跨书路径、.ops/、.git/ 及越界符号链接；
 * - 仅当调用方显式授予 allowedOpsPaths 白名单时，才放行特定非事务 .ops 文件。
 */
export class PathFence {
    public readonly bookRoot: string;
    public readonly allowedOpsReadSet: ReadonlySet<string>;
    public readonly allowedOpsWriteSet: ReadonlySet<string>;

    constructor(bookRoot: string, options: PathFenceOptions = {}) {
        if (typeof bookRoot !== 'string' || bookRoot.trim().length === 0) {
            throw new Error('PathFence 需要非空 bookRoot');
        }
        this.bookRoot = resolve(bookRoot);
        this.allowedOpsReadSet = new Set(
            (options.allowedOpsPaths ?? []).map(normalizeOpsWhitelistEntry)
        );
        this.allowedOpsWriteSet = new Set(
            (options.allowedOpsWritePaths ?? []).map(normalizeOpsWhitelistEntry)
        );
    }

    /** 校验并归一化相对路径，禁止路径穿越、绝对路径与未授权系统目录 */
    normalizeRelPath(relPath: string): string {
        if (typeof relPath !== 'string' || relPath.trim().length === 0 || relPath.includes('\0')) {
            throw new PathFenceError(String(relPath), `非法路径: ${String(relPath)}`);
        }
        if (isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
            throw new PathFenceError(relPath, `禁止使用绝对路径越界访问: ${relPath}`);
        }

        const slashPath = relPath.replace(/\\/g, '/').trim();
        const rawSegments = slashPath.split('/');
        for (const seg of rawSegments) {
            if (seg === '..' || seg === '.git') {
                throw new PathFenceError(relPath, `路径围栏拦截受限段 (${seg}): ${relPath}`);
            }
        }

        const normalized = posix.normalize(slashPath).replace(/^\.\//, '').replace(/\/+$/, '');
        if (
            normalized.length === 0 ||
            normalized === '.' ||
            normalized === '..' ||
            normalized.startsWith('../') ||
            normalized.startsWith('/')
        ) {
            throw new PathFenceError(relPath, `路径围栏拦截越界路径: ${relPath}`);
        }

        const topDir = normalized.split('/')[0] ?? '';
        if (topDir === '.git') {
            throw new PathFenceError(relPath, `禁止访问内部目录 .git/: ${relPath}`);
        }

        if (topDir === '.ops') {
            if (normalized === '.ops' || isHardBlockedOpsPath(normalized)) {
                throw new PathFenceError(relPath, `禁止访问内部目录 .ops/: ${relPath}`);
            }
        } else if (rawSegments.includes('.ops')) {
            throw new PathFenceError(relPath, `路径围栏拦截受限段 (.ops): ${relPath}`);
        }

        const absPath = resolve(this.bookRoot, normalized);
        const relFromRoot = relative(this.bookRoot, absPath);
        if (relFromRoot === '' || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
            throw new PathFenceError(relPath, `路径超出当前作品目录 bookRoot: ${relPath}`);
        }

        return normalized;
    }

    /** 校验只读文件路径：必须位于 ALLOWED_READ_DIRS 或显式白名单 .ops 文件内，且真实路径不逃逸 bookRoot */
    async assertReadFile(relPath: string): Promise<{ normalized: string; absPath: string }> {
        const normalized = this.normalizeRelPath(relPath);
        const slashIdx = normalized.indexOf('/');
        const topDir = slashIdx === -1 ? normalized : normalized.slice(0, slashIdx);

        if (topDir === '.ops') {
            if (!this.allowedOpsReadSet.has(normalized)) {
                throw new PathFenceError(relPath, `禁止读取未授权 .ops 路径: ${relPath}`);
            }
        } else if (!ALLOWED_READ_DIR_SET.has(topDir) || slashIdx === -1) {
            throw new PathFenceError(
                relPath,
                `只读路径必须位于允许目录 (${ALLOWED_READ_DIRS.join(', ')}) 下: ${relPath}`
            );
        }

        const absPath = resolve(this.bookRoot, normalized);
        await this.assertSymlinkSafe(absPath, relPath);
        return { normalized, absPath };
    }

    /**
     * 校验只读检索作用域（用于 book_grep / book_glob）：
     * - 未传路径或传入 "." 时，限定返回 bookRoot 内允许目录白名单（外加显式白名单 .ops 文件）；
     * - 传入具体子路径时，校验其位于 ALLOWED_READ_DIRS 或白名单 .ops 文件内且真实路径不逃逸。
     */
    async assertReadSearchScope(subPath?: string): Promise<{
        normalizedSubPath: string | null;
        allowedDirs: string[];
    }> {
        if (subPath === undefined || subPath.trim() === '' || subPath.trim() === '.' || subPath.trim() === './') {
            return {
                normalizedSubPath: null,
                allowedDirs: [...ALLOWED_READ_DIRS, ...this.allowedOpsReadSet]
            };
        }

        const normalized = this.normalizeRelPath(subPath);
        const topDir = normalized.split('/')[0] ?? '';
        if (topDir === '.ops') {
            if (!this.allowedOpsReadSet.has(normalized)) {
                throw new PathFenceError(subPath, `禁止检索未授权 .ops 路径: ${subPath}`);
            }
        } else if (!ALLOWED_READ_DIR_SET.has(topDir)) {
            throw new PathFenceError(
                subPath,
                `检索路径必须位于允许目录 (${ALLOWED_READ_DIRS.join(', ')}) 内: ${subPath}`
            );
        }

        const absPath = resolve(this.bookRoot, normalized);
        await this.assertSymlinkSafe(absPath, subPath);

        return {
            normalizedSubPath: normalized,
            allowedDirs: [normalized]
        };
    }

    /** 校验可写文件路径（book_edit）：物理禁止 manuscripts/、未授权 .ops/、.git/ 与 ../ */
    async assertWriteFile(relPath: string): Promise<{ normalized: string; absPath: string }> {
        const normalized = this.normalizeRelPath(relPath);
        const slashIdx = normalized.indexOf('/');
        const topDir = slashIdx === -1 ? normalized : normalized.slice(0, slashIdx);

        if (topDir === 'manuscripts') {
            throw new PathFenceError(relPath, `禁止通过 book_edit 修改定稿正稿目录 manuscripts/: ${relPath}`);
        }
        if (topDir === '.ops') {
            if (!this.allowedOpsWriteSet.has(normalized)) {
                throw new PathFenceError(relPath, `禁止通过 book_edit 修改未授权 .ops 路径: ${relPath}`);
            }
        } else if (!ALLOWED_WRITE_DIR_SET.has(topDir) || slashIdx === -1) {
            throw new PathFenceError(
                relPath,
                `只允许编辑 (${ALLOWED_WRITE_DIRS.join(', ')}) 下的文件: ${relPath}`
            );
        }

        const absPath = resolve(this.bookRoot, normalized);
        await this.assertSymlinkSafe(absPath, relPath);
        return { normalized, absPath };
    }

    /** 校验 glob 匹配模式字符串本身不包含路径穿越或未授权目录 */
    assertSafeGlobPattern(pattern: string): void {
        if (pattern.includes('\0')) {
            throw new PathFenceError(pattern, '非法的 glob 模式');
        }
        const normalized = pattern.replace(/\\/g, '/').trim();
        if (normalized.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(normalized)) {
            throw new PathFenceError(pattern, `禁止在 glob 模式中使用绝对路径: ${pattern}`);
        }
        const segments = normalized.split('/');
        for (const seg of segments) {
            if (seg === '..' || seg === '.git') {
                throw new PathFenceError(pattern, `glob 模式禁止包含受限路径段 (${seg}): ${pattern}`);
            }
            if (seg === '.ops' && !this.allowedOpsReadSet.has(normalized)) {
                throw new PathFenceError(pattern, `glob 模式禁止访问未授权 .ops 路径: ${pattern}`);
            }
        }
    }

    /** 校验目标路径（或最近存在祖先）与 bookRoot 的真实路径不发生符号链接逃逸 */
    async assertSymlinkSafe(absPath: string, requestedPath: string): Promise<void> {
        const realRoot = await realpath(this.bookRoot);
        const existing = await nearestExistingPath(absPath);
        const realExisting = await realpath(existing);
        if (!isInsideRealRoot(realRoot, realExisting)) {
            throw new PathFenceError(requestedPath, `符号链接越界 bookRoot: ${requestedPath}`);
        }
    }

    /** 检查实际遍历到的子路径是否仍在 bookRoot 真实目录内 */
    async isRealPathInsideRoot(relPath: string): Promise<boolean> {
        try {
            const realRoot = await realpath(this.bookRoot);
            const realTarget = await realpath(join(this.bookRoot, relPath));
            return isInsideRealRoot(realRoot, realTarget);
        } catch {
            return false;
        }
    }
}

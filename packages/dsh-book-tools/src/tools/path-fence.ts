import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PathFenceError } from '../errors.js';
import { isEnoentError, matchesPathPrefix, normalizeRelPosixPath } from './shared.js';

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

/** .ops/ 只读最小白名单上限（超出范围一律物理拒止，单书角色配置亦不可越界） */
export const OPS_READ_WHITELIST_MAX = new Set<string>([
    '.ops/telemetry.jsonl',
    '.ops/voice_samples.yaml',
    '.ops/signals.jsonl'
]);

/** .ops/ 读写最小白名单上限（仅开放声纹池与信号队列） */
export const OPS_WRITE_WHITELIST_MAX = new Set<string>([
    '.ops/voice_samples.yaml',
    '.ops/signals.jsonl'
]);

/** AI 工种硬只读世界保护集：禁止通过 book_edit 或暂存区写入/篡改 */
export const READONLY_WORLD_PATHS = [
    'world/roles',
    'world/author_charter.md',
    'world/book_config.yaml',
    'world/ops_style_amendments.md'
] as const;

const ALLOWED_READ_DIR_SET = new Set<string>(ALLOWED_READ_DIRS);
const ALLOWED_WRITE_DIR_SET = new Set<string>(ALLOWED_WRITE_DIRS);

export type PathFenceAccessMode = 'read' | 'write' | 'searchScope';

function isInsideRealRoot(realRoot: string, realCandidate: string): boolean {
    const rel = relative(realRoot, realCandidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeRelativeWhitelistItem(raw: string, label: string): string {
    const slash = raw.replace(/\\/g, '/').trim();
    if (
        slash.length === 0 ||
        slash.includes('\0') ||
        isAbsolute(slash) ||
        /^[a-zA-Z]:[\\/]/.test(slash) ||
        slash.split('/').includes('..')
    ) {
        throw new PathFenceError(raw, `非法的 ${label} 条目: ${raw}`);
    }
    const normalized = normalizeRelPosixPath(slash, { stripTrailingSlash: true });
    if (normalized.length === 0 || normalized === '.' || normalized.startsWith('../')) {
        throw new PathFenceError(raw, `非法的 ${label} 条目: ${raw}`);
    }
    return normalized;
}

function normalizeOpsWhitelistEntry(raw: string, forWrite: boolean): string {
    const normalized = normalizeRelativeWhitelistItem(raw, '.ops 白名单');
    if (!normalized.startsWith('.ops/')) {
        throw new PathFenceError(raw, `allowedOpsPaths 条目必须以 .ops/ 开头: ${raw}`);
    }
    const allowedSet = forWrite ? OPS_WRITE_WHITELIST_MAX : OPS_READ_WHITELIST_MAX;
    if (!allowedSet.has(normalized)) {
        throw new PathFenceError(raw, `禁止将未授权的 .ops 路径加入白名单: ${raw}`);
    }
    return normalized;
}

function normalizeChapterWhitelistEntry(raw: string): string {
    const normalized = normalizeRelativeWhitelistItem(raw, 'allowedChapterFiles');
    if (!normalized.includes('/')) {
        return `manuscripts/${normalized}`;
    }
    return normalized;
}

async function resolveTargetRealPath(absPath: string, requestedPath: string): Promise<string> {
    try {
        const st = await lstat(absPath);
        if (st.isSymbolicLink()) {
            try {
                return await realpath(absPath);
            } catch {
                throw new PathFenceError(requestedPath, `符号链接目标不存在或无法解析: ${requestedPath}`);
            }
        }
        return await realpath(absPath);
    } catch (err: unknown) {
        if (!isEnoentError(err)) {
            throw err;
        }
    }

    const suffixSegments: string[] = [];
    let probe = absPath;
    while (true) {
        suffixSegments.unshift(probe.slice(dirname(probe).length).replace(/^[\\/]/, ''));
        const parent = dirname(probe);
        if (parent === probe) {
            throw new PathFenceError(requestedPath, `无法定位路径的已存在父目录: ${requestedPath}`);
        }
        probe = parent;
        try {
            const st = await lstat(probe);
            let realAncestor: string;
            try {
                realAncestor = await realpath(probe);
            } catch {
                const detail = st.isSymbolicLink()
                    ? `父目录符号链接目标不存在或无法解析: ${requestedPath}`
                    : `无法解析父目录真实路径: ${requestedPath}`;
                throw new PathFenceError(requestedPath, detail);
            }
            return resolve(realAncestor, ...suffixSegments);
        } catch (err: unknown) {
            if (!isEnoentError(err)) {
                throw err;
            }
        }
    }
}

/** PathFence 配置选项 */
export interface PathFenceOptions {
    /** 显式放行只读的 .ops/ 具体文件路径白名单（默认空，全面屏蔽 .ops/） */
    allowedOpsPaths?: string[] | undefined;
    /** 显式放行暂存编辑的 .ops/ 具体文件路径白名单（默认空，全面屏蔽 .ops/） */
    allowedOpsWritePaths?: string[] | undefined;
    /** 按角色注入的禁读路径清单（如 world/author_charter.md、world/arc_director_plan.md） */
    blockedReadPaths?: string[] | undefined;
    /** 限定 manuscripts/** 仅允许读取/检索该集合内的章节文件（用于 PARALLEL 支线隔离） */
    allowedChapterFiles?: string[] | undefined;
}

/**
 * 作品路径围栏（PathFence）
 * - 将所有读写检索严格锁死在当前 bookRoot 允许目录内；
 * - 默认物理拦截 ../、跨书路径、.ops/、.git/ 及越界符号链接；
 * - 解析 realpath 后对真实相对路径二次复核白名单、.ops 最小集与只读世界保护集。
 */
export class PathFence {
    public readonly bookRoot: string;
    public readonly allowedOpsReadSet: ReadonlySet<string>;
    public readonly allowedOpsWriteSet: ReadonlySet<string>;
    public readonly blockedReadPaths: readonly string[];
    public readonly allowedChapterFileSet: ReadonlySet<string> | null;

    constructor(bookRoot: string, options: PathFenceOptions = {}) {
        if (typeof bookRoot !== 'string' || bookRoot.trim().length === 0) {
            throw new Error('PathFence 需要非空 bookRoot');
        }
        this.bookRoot = resolve(bookRoot);
        this.allowedOpsReadSet = new Set(
            (options.allowedOpsPaths ?? []).map((entry) => normalizeOpsWhitelistEntry(entry, false))
        );
        this.allowedOpsWriteSet = new Set(
            (options.allowedOpsWritePaths ?? []).map((entry) => normalizeOpsWhitelistEntry(entry, true))
        );
        this.blockedReadPaths = (options.blockedReadPaths ?? []).map((entry) =>
            normalizeRelativeWhitelistItem(entry, 'blockedReadPaths')
        );
        this.allowedChapterFileSet =
            options.allowedChapterFiles !== undefined
                ? new Set(options.allowedChapterFiles.map(normalizeChapterWhitelistEntry))
                : null;
    }

    /** 判断归一化相对路径是否命中角色级禁读列表 */
    isBlockedReadPath(normalizedPath: string): boolean {
        const normalized = normalizeRelPosixPath(normalizedPath, { stripTrailingSlash: true });
        return this.blockedReadPaths.some((blocked) => matchesPathPrefix(normalized, blocked));
    }

    /** 判断章节路径是否位于 allowedChapterFiles 白名单内（未配置白名单时恒为 true） */
    isChapterFileAllowed(normalizedPath: string): boolean {
        if (this.allowedChapterFileSet === null) {
            return true;
        }
        const normalized = normalizeRelPosixPath(normalizedPath, { stripTrailingSlash: true });
        if (!matchesPathPrefix(normalized, 'manuscripts') || normalized === 'manuscripts') {
            return true;
        }
        return this.allowedChapterFileSet.has(normalized);
    }

    /** 判断相对路径是否对当前角色可读/可检索（供 book_grep / book_glob 过滤） */
    isReadPathAllowed(relPath: string): boolean {
        try {
            const normalized = this.normalizeRelPath(relPath);
            this.assertNormalizedAllowed(normalized, relPath, 'read');
            return true;
        } catch {
            return false;
        }
    }

    private assertWritePathAllowed(normalized: string, requestedPath: string, topDir: string, slashIdx: number): void {
        if (matchesPathPrefix(normalized, 'manuscripts')) {
            throw new PathFenceError(
                requestedPath,
                `禁止通过 book_edit 修改定稿正稿目录 manuscripts/: ${requestedPath}`
            );
        }
        for (const readonlyPath of READONLY_WORLD_PATHS) {
            if (matchesPathPrefix(normalized, readonlyPath)) {
                throw new PathFenceError(
                    requestedPath,
                    `禁止修改只读世界契约/角色配置路径 (${readonlyPath}): ${requestedPath}`
                );
            }
        }
        if (topDir === '.ops') {
            if (!this.allowedOpsWriteSet.has(normalized)) {
                throw new PathFenceError(
                    requestedPath,
                    `禁止通过 book_edit 修改未授权 .ops 路径: ${requestedPath}`
                );
            }
            return;
        }
        if (!ALLOWED_WRITE_DIR_SET.has(topDir) || slashIdx === -1) {
            throw new PathFenceError(
                requestedPath,
                `只允许编辑 (${ALLOWED_WRITE_DIRS.join(', ')}) 下的文件: ${requestedPath}`
            );
        }
    }

    private assertReadOrSearchPathAllowed(
        normalized: string,
        requestedPath: string,
        topDir: string,
        slashIdx: number,
        mode: 'read' | 'searchScope'
    ): void {
        if (this.isBlockedReadPath(normalized)) {
            throw new PathFenceError(requestedPath, `角色无权读取受限路径: ${requestedPath}`);
        }

        if (topDir === '.ops') {
            if (!this.allowedOpsReadSet.has(normalized)) {
                throw new PathFenceError(requestedPath, `禁止访问未授权 .ops 路径: ${requestedPath}`);
            }
            return;
        }

        if (mode === 'read') {
            if (!ALLOWED_READ_DIR_SET.has(topDir) || slashIdx === -1) {
                throw new PathFenceError(
                    requestedPath,
                    `只读路径必须位于允许目录 (${ALLOWED_READ_DIRS.join(', ')}) 下: ${requestedPath}`
                );
            }
            if (!this.isChapterFileAllowed(normalized)) {
                throw new PathFenceError(
                    requestedPath,
                    `当前时间线/支线禁止读取该章节手稿: ${requestedPath}`
                );
            }
            return;
        }

        if (!ALLOWED_READ_DIR_SET.has(topDir)) {
            throw new PathFenceError(
                requestedPath,
                `检索路径必须位于允许目录 (${ALLOWED_READ_DIRS.join(', ')}) 内: ${requestedPath}`
            );
        }
        if (normalized !== 'manuscripts' && !this.isChapterFileAllowed(normalized)) {
            throw new PathFenceError(
                requestedPath,
                `当前时间线/支线禁止检索该章节手稿: ${requestedPath}`
            );
        }
    }

    private assertNormalizedAllowed(
        normalized: string,
        requestedPath: string,
        mode: PathFenceAccessMode
    ): void {
        const slashIdx = normalized.indexOf('/');
        const topDir = slashIdx === -1 ? normalized : normalized.slice(0, slashIdx);

        if (topDir === '.git' || normalized.split('/').includes('.git')) {
            throw new PathFenceError(requestedPath, `禁止访问内部目录 .git/: ${requestedPath}`);
        }

        if (mode === 'write') {
            this.assertWritePathAllowed(normalized, requestedPath, topDir, slashIdx);
            return;
        }
        this.assertReadOrSearchPathAllowed(normalized, requestedPath, topDir, slashIdx, mode);
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

        const normalized = normalizeRelPosixPath(slashPath, { stripTrailingSlash: true });
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
            if (
                normalized === '.ops' ||
                (!OPS_READ_WHITELIST_MAX.has(normalized) && !OPS_WRITE_WHITELIST_MAX.has(normalized))
            ) {
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

    private async assertFileAccess(
        relPath: string,
        mode: 'read' | 'write'
    ): Promise<{ normalized: string; absPath: string }> {
        const normalized = this.normalizeRelPath(relPath);
        this.assertNormalizedAllowed(normalized, relPath, mode);

        const absPath = resolve(this.bookRoot, normalized);
        await this.assertSymlinkSafe(absPath, relPath, mode);
        return { normalized, absPath };
    }

    /** 校验只读文件路径：必须位于允许目录或白名单 .ops 文件内，且 realpath 后二次复核合法 */
    async assertReadFile(relPath: string): Promise<{ normalized: string; absPath: string }> {
        return await this.assertFileAccess(relPath, 'read');
    }

    /**
     * 校验只读检索作用域（用于 book_grep / book_glob）：
     * - 未传路径或传入 "." 时，限定返回 bookRoot 内允许目录白名单（外加显式白名单 .ops 文件）；
     * - 传入具体子路径时，校验其位于允许目录或白名单 .ops 文件内且 realpath 不逃逸。
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
        this.assertNormalizedAllowed(normalized, subPath, 'searchScope');

        const absPath = resolve(this.bookRoot, normalized);
        await this.assertSymlinkSafe(absPath, subPath, 'searchScope');

        return {
            normalizedSubPath: normalized,
            allowedDirs: [normalized]
        };
    }

    /** 校验可写文件路径（book_edit）：物理禁止 manuscripts/、只读世界保护集、未授权 .ops/、.git/ 与 ../ */
    async assertWriteFile(relPath: string): Promise<{ normalized: string; absPath: string }> {
        return await this.assertFileAccess(relPath, 'write');
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

    /** 校验目标路径（或最近存在祖先）与 bookRoot 的真实路径不发生符号链接逃逸，并按权限模式二次校验目标相对路径 */
    async assertSymlinkSafe(
        absPath: string,
        requestedPath: string,
        mode: PathFenceAccessMode = 'read'
    ): Promise<void> {
        const realRoot = await realpath(this.bookRoot);
        const realTarget = await resolveTargetRealPath(absPath, requestedPath);
        if (!isInsideRealRoot(realRoot, realTarget)) {
            throw new PathFenceError(requestedPath, `符号链接越界 bookRoot: ${requestedPath}`);
        }
        const realRel = relative(realRoot, realTarget);
        if (realRel !== '') {
            const normalizedRealRel = normalizeRelPosixPath(realRel, { stripTrailingSlash: true });
            this.assertNormalizedAllowed(normalizedRealRel, requestedPath, mode);
        }
    }

    /** 检查实际遍历到的子路径是否仍在 bookRoot 真实目录内且符合指定访问模式 */
    async isRealPathInsideRoot(
        relPath: string,
        mode: PathFenceAccessMode = 'read'
    ): Promise<boolean> {
        try {
            const realRoot = await realpath(this.bookRoot);
            const realTarget = await realpath(join(this.bookRoot, relPath));
            if (!isInsideRealRoot(realRoot, realTarget)) {
                return false;
            }
            const realRel = relative(realRoot, realTarget);
            if (realRel === '') {
                return true;
            }
            const normalizedRealRel = normalizeRelPosixPath(realRel, { stripTrailingSlash: true });
            this.assertNormalizedAllowed(normalizedRealRel, relPath, mode);
            return true;
        } catch {
            return false;
        }
    }
}

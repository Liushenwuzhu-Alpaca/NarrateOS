import { lstatSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';

interface StagingSessionState {
    bookRoot: string;
    overlay: Map<string, string>;
    history: Map<string, string[]>;
}

/** .ops/ 只读最小白名单：仅开放遥测文件供只读诊断 */
const READONLY_OPS_WHITELIST = new Set<string>(['.ops/telemetry.jsonl']);

/** .ops/ 读写最小白名单：仅开放声纹池与运维信号队列 */
const READWRITE_OPS_WHITELIST = new Set<string>(['.ops/voice_samples.yaml', '.ops/signals.jsonl']);

/** AI 工种硬只读世界保护集：允许读取，严禁通过暂存区写入或编辑 */
const READONLY_WORLD_PATHS = [
    'world/roles',
    'world/author_charter.md',
    'world/book_config.yaml',
    'world/ops_style_amendments.md'
] as const;

function matchesPathOrSubpath(normalizedPath: string, prefix: string): boolean {
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
}

function assertAllowedRelativePath(normalized: string, rawRelPath: string, forWrite: boolean): void {
    if (matchesPathOrSubpath(normalized, '.git')) {
        throw new Error(`禁止访问 .git 目录: ${rawRelPath}`);
    }
    if (matchesPathOrSubpath(normalized, '.ops')) {
        if (READWRITE_OPS_WHITELIST.has(normalized)) {
            return;
        }
        if (READONLY_OPS_WHITELIST.has(normalized)) {
            if (forWrite) {
                throw new Error(`禁止通过暂存区修改只读遥测路径 (${normalized}): ${rawRelPath}`);
            }
            return;
        }
        throw new Error(`禁止通过暂存区访问未授权的 .ops/ 路径 (${normalized}): ${rawRelPath}`);
    }
    if (forWrite) {
        if (matchesPathOrSubpath(normalized, 'manuscripts')) {
            throw new Error(`禁止通过暂存区修改正稿目录 manuscripts/: ${rawRelPath}`);
        }
        for (const readonlyWorldPath of READONLY_WORLD_PATHS) {
            if (matchesPathOrSubpath(normalized, readonlyWorldPath)) {
                throw new Error(`禁止通过暂存区修改只读世界契约/配置路径 (${readonlyWorldPath}): ${rawRelPath}`);
            }
        }
    }
}

function assertNormalizedRealTargetInsideRoot(
    realRoot: string,
    realTarget: string,
    rawRelPath: string,
    forWrite: boolean
): string {
    const realRel = relative(realRoot, realTarget);
    if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new Error(`符号链接路径越界 bookRoot: ${rawRelPath}`);
    }
    const normalizedRealRel = posix.normalize(realRel.replace(/\\/g, '/'));
    assertAllowedRelativePath(normalizedRealRel, rawRelPath, forWrite);
    return realTarget;
}

function isEnoent(err: unknown): boolean {
    return (err as { code?: string }).code === 'ENOENT';
}

function stepParentSegment(
    probe: string,
    suffixSegments: string[],
    rawRelPath: string
): string {
    const parent = dirname(probe);
    suffixSegments.unshift(probe.slice(parent.length).replace(/^[\\/]/, ''));
    if (parent === probe) {
        throw new Error(`无法定位路径的已存在父目录: ${rawRelPath}`);
    }
    return parent;
}

function throwUnresolvableRealpath(
    isSymbolicLink: boolean,
    isAncestor: boolean,
    rawRelPath: string
): never {
    if (isAncestor) {
        throw new Error(
            isSymbolicLink
                ? `父目录符号链接目标不存在或无法解析: ${rawRelPath}`
                : `无法解析父目录真实路径: ${rawRelPath}`
        );
    }
    throw new Error(`符号链接目标不存在或无法解析: ${rawRelPath}`);
}

async function resolveTargetRealPathAsync(absPath: string, rawRelPath: string): Promise<string> {
    try {
        const st = await lstat(absPath);
        try {
            return await realpath(absPath);
        } catch (err) {
            if (st.isSymbolicLink()) {
                throwUnresolvableRealpath(true, false, rawRelPath);
            }
            throw err;
        }
    } catch (err: unknown) {
        if (!isEnoent(err)) {
            throw err;
        }
    }

    const suffixSegments: string[] = [];
    let probe = absPath;
    while (true) {
        probe = stepParentSegment(probe, suffixSegments, rawRelPath);
        try {
            const st = await lstat(probe);
            let realAncestor: string;
            try {
                realAncestor = await realpath(probe);
            } catch {
                throwUnresolvableRealpath(st.isSymbolicLink(), true, rawRelPath);
            }
            return resolve(realAncestor, ...suffixSegments);
        } catch (err: unknown) {
            if (!isEnoent(err)) {
                throw err;
            }
        }
    }
}

function resolveTargetRealPathSync(absPath: string, rawRelPath: string): string {
    try {
        const st = lstatSync(absPath);
        try {
            return realpathSync(absPath);
        } catch (err) {
            if (st.isSymbolicLink()) {
                throwUnresolvableRealpath(true, false, rawRelPath);
            }
            throw err;
        }
    } catch (err: unknown) {
        if (!isEnoent(err)) {
            throw err;
        }
    }

    const suffixSegments: string[] = [];
    let probe = absPath;
    while (true) {
        probe = stepParentSegment(probe, suffixSegments, rawRelPath);
        try {
            const st = lstatSync(probe);
            let realAncestor: string;
            try {
                realAncestor = realpathSync(probe);
            } catch {
                throwUnresolvableRealpath(st.isSymbolicLink(), true, rawRelPath);
            }
            return resolve(realAncestor, ...suffixSegments);
        } catch (err: unknown) {
            if (!isEnoent(err)) {
                throw err;
            }
        }
    }
}

async function assertRealPathAllowed(
    bookRoot: string,
    absPath: string,
    rawRelPath: string,
    forWrite: boolean
): Promise<string> {
    const [realRoot, realTarget] = await Promise.all([
        realpath(bookRoot),
        resolveTargetRealPathAsync(absPath, rawRelPath)
    ]);
    return assertNormalizedRealTargetInsideRoot(realRoot, realTarget, rawRelPath, forWrite);
}

function assertRealPathAllowedSync(
    bookRoot: string,
    absPath: string,
    rawRelPath: string,
    forWrite: boolean
): string {
    const realRoot = realpathSync(bookRoot);
    const realTarget = resolveTargetRealPathSync(absPath, rawRelPath);
    return assertNormalizedRealTargetInsideRoot(realRoot, realTarget, rawRelPath, forWrite);
}

/** 校验并归一化暂存区相对路径，禁止路径穿越、.git、引擎内部 .ops/ 路径及（写操作时）manuscripts/ 与只读遥测 */
function normalizeAndValidateRelPath(
    bookRoot: string,
    relPath: string,
    forWrite: boolean
): { normalized: string; absPath: string } {
    if (typeof relPath !== 'string' || relPath.trim().length === 0 || relPath.includes('\0')) {
        throw new Error(`非法的暂存路径: ${String(relPath)}`);
    }
    if (isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
        throw new Error(`暂存路径必须为相对路径: ${relPath}`);
    }

    const slashPath = relPath.replace(/\\/g, '/');
    const rawSegments = slashPath.split('/');
    for (const seg of rawSegments) {
        if (seg === '..' || seg === '.git') {
            throw new Error(`禁止访问受限路径 (${seg}): ${relPath}`);
        }
    }

    const normalized = posix.normalize(slashPath).replace(/^\.\//, '');
    if (
        normalized.length === 0 ||
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.startsWith('/')
    ) {
        throw new Error(`路径越界: ${relPath}`);
    }

    assertAllowedRelativePath(normalized, relPath, forWrite);

    const absPath = resolve(bookRoot, normalized);
    const relFromRoot = relative(bookRoot, absPath);
    if (relFromRoot === '' || relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
        throw new Error(`路径越界 bookRoot: ${relPath}`);
    }

    return { normalized, absPath };
}

/**
 * 按 runId 隔离的内存暂存覆盖层管理器（StagingSessionManager）
 * - 每个 runId 持有独立内存 overlay，实现 Read-Your-Own-Writes；
 * - 并发 runId 之间完全隔离，互不可见；
 * - discard(runId) 丢弃未提交覆盖层且保证磁盘字节零变动。
 */
export class StagingSessionManager {
    private readonly sessions = new Map<string, StagingSessionState>();

    /** 为指定 runId 创建独立的内存暂存覆盖层 */
    begin(runId: string, bookRoot: string): void {
        if (typeof runId !== 'string' || runId.trim().length === 0) {
            throw new Error('StagingSessionManager.begin 需要非空 runId');
        }
        if (typeof bookRoot !== 'string' || bookRoot.trim().length === 0) {
            throw new Error('StagingSessionManager.begin 需要非空 bookRoot');
        }
        if (this.sessions.has(runId)) {
            throw new Error(`暂存会话已存在: ${runId}`);
        }
        this.sessions.set(runId, {
            bookRoot: resolve(bookRoot),
            overlay: new Map<string, string>(),
            history: new Map<string, string[]>()
        });
    }

    /** 判断指定 runId 是否存在活跃暂存会话 */
    has(runId: string): boolean {
        return this.sessions.has(runId);
    }

    /** 检查复用的暂存会话是否属于本次选书。 */
    assertBookRoot(runId: string, bookRoot: string): void {
        if (this.requireSession(runId).bookRoot !== resolve(bookRoot)) {
            throw new Error(`暂存会话 ${runId} 不属于当前作品`);
        }
    }

    /**
     * 读取作品内文件（优先命中本 runId 暂存覆盖层，否则回落磁盘只读）
     * 严禁跨越 bookRoot 或访问 .git/ 与引擎内部 .ops/ 元数据路径。
     */
    async read(runId: string, relPath: string): Promise<string> {
        const session = this.requireSession(runId);
        const { normalized, absPath } = normalizeAndValidateRelPath(session.bookRoot, relPath, false);
        const realTarget = await assertRealPathAllowed(session.bookRoot, absPath, relPath, false);

        const staged = session.overlay.get(normalized);
        if (staged !== undefined) {
            return staged;
        }

        return await readFile(realTarget, 'utf8');
    }

    /**
     * 在当前 runId 暂存覆盖层内执行局部精确字符串替换（不修改磁盘文件）
     * 禁止写入 manuscripts/。
     */
    async edit(
        runId: string,
        relPath: string,
        targetText: string,
        replacementText: string,
        branchOverlay?: ReadonlyMap<string, string | null>
    ): Promise<string> {
        const session = this.requireSession(runId);
        const { normalized, absPath } = normalizeAndValidateRelPath(session.bookRoot, relPath, true);
        if (targetText.length === 0) {
            throw new Error('StagingSessionManager.edit 的 targetText 不能为空');
        }
        await assertRealPathAllowed(session.bookRoot, absPath, relPath, true);

        const base = session.overlay.get(normalized) ?? branchOverlay?.get(normalized);
        if (base === null) throw new Error(`文件在当前分支视图中不存在或不可见: ${normalized}`);
        const current = base ?? await this.read(runId, normalized);
        const firstIdx = current.indexOf(targetText);
        if (firstIdx === -1) {
            const needle = targetText.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
            const prefix = needle.slice(0, Math.min(12, Math.max(1, Math.floor(needle.length / 2))));
            const nearby = current.split(/\r?\n/)
                .map((line, index) => ({ line, index }))
                .filter(({ line }) => prefix && line.includes(prefix))
                .slice(0, 2)
                .map(({ line, index }) => `第 ${index + 1} 行: ${line.slice(0, 200)}`);
            throw new Error(`在 ${normalized} 中未找到匹配的目标文本${nearby.length ? `；相近行：\n${nearby.join('\n')}` : ''}`);
        }
        if (current.indexOf(targetText, firstIdx + targetText.length) !== -1) {
            throw new Error(`在 ${normalized} 中匹配到多处目标文本，请提供更精确上下文`);
        }

        const nextContent =
            current.slice(0, firstIdx) + replacementText + current.slice(firstIdx + targetText.length);
        this.saveVersion(session, normalized, nextContent);
        return nextContent;
    }

    /**
     * 将完整内容写入当前 runId 暂存覆盖层（不修改磁盘文件）
     * 禁止写入 manuscripts/。
     */
    stageWrite(runId: string, relPath: string, content: string): void {
        const session = this.requireSession(runId);
        const { normalized, absPath } = normalizeAndValidateRelPath(session.bookRoot, relPath, true);
        assertRealPathAllowedSync(session.bookRoot, absPath, relPath, true);
        this.saveVersion(session, normalized, content);
    }

    /** 撤销该路径最后一次暂存修改；首次修改撤销后直接回到磁盘或分支视图。 */
    async revert(runId: string, relPath: string): Promise<{ staged: boolean; content: string | null }> {
        const session = this.requireSession(runId);
        const { normalized, absPath } = normalizeAndValidateRelPath(session.bookRoot, relPath, true);
        await assertRealPathAllowed(session.bookRoot, absPath, relPath, true);
        const history = session.history.get(normalized);
        if (history?.length) {
            const content = history.pop()!;
            session.overlay.set(normalized, content);
            if (!history.length) session.history.delete(normalized);
            return { staged: true, content };
        }
        session.overlay.delete(normalized);
        session.history.delete(normalized);
        return { staged: false, content: null };
    }

    private saveVersion(session: StagingSessionState, path: string, content: string): void {
        const previous = session.overlay.get(path);
        if (previous !== undefined) {
            const history = session.history.get(path) ?? [];
            history.push(previous);
            session.history.set(path, history);
        }
        session.overlay.set(path, content);
    }

    /** 返回当前 runId 待提交的暂存文件快照（只读副本） */
    getPendingWrites(runId: string): Map<string, string> {
        const session = this.requireSession(runId);
        return new Map(session.overlay);
    }

    /** 丢弃指定 runId 的全部内存暂存变更（磁盘字节零变动） */
    discard(runId: string): void {
        this.sessions.delete(runId);
    }

    /** 清空全部活跃暂存会话（用于服务卸载清理） */
    discardAll(): void {
        this.sessions.clear();
    }

    private requireSession(runId: string): StagingSessionState {
        const session = this.sessions.get(runId);
        if (!session) {
            throw new Error(`暂存会话不存在: ${runId}`);
        }
        return session;
    }
}

import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';

interface StagingSessionState {
    bookRoot: string;
    overlay: Map<string, string>;
}

/** 引擎内部元数据与事务路径：严禁暂存区读/写/编辑 */
const BLOCKED_OPS_PATHS = [
    '.ops/runs.jsonl',
    '.ops/tx.lock',
    '.ops/tx_state.json',
    '.ops/pending_writes.json',
    '.ops/recovery',
    '.ops/traces',
    '.ops/parallel_deltas',
    '.ops/dream_watermark.json',
    '.ops/safe_halt.json'
] as const;

/** 只读遥测路径：允许读取供诊断，严禁通过暂存区写入/编辑 */
const READONLY_OPS_PATHS = ['.ops/telemetry.jsonl'] as const;

function matchesPathOrSubpath(normalizedPath: string, prefix: string): boolean {
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
}

function assertAllowedRelativePath(normalized: string, rawRelPath: string, forWrite: boolean): void {
    if (matchesPathOrSubpath(normalized, '.git')) {
        throw new Error(`禁止访问 .git 目录: ${rawRelPath}`);
    }
    for (const blocked of BLOCKED_OPS_PATHS) {
        if (matchesPathOrSubpath(normalized, blocked)) {
            throw new Error(`禁止通过暂存区访问引擎内部路径 (${blocked}): ${rawRelPath}`);
        }
    }
    if (forWrite) {
        for (const readonlyPath of READONLY_OPS_PATHS) {
            if (matchesPathOrSubpath(normalized, readonlyPath)) {
                throw new Error(`禁止通过暂存区修改只读遥测路径 (${readonlyPath}): ${rawRelPath}`);
            }
        }
        if (matchesPathOrSubpath(normalized, 'manuscripts')) {
            throw new Error(`禁止通过暂存区修改正稿目录 manuscripts/: ${rawRelPath}`);
        }
    }
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
            overlay: new Map<string, string>()
        });
    }

    /** 判断指定 runId 是否存在活跃暂存会话 */
    has(runId: string): boolean {
        return this.sessions.has(runId);
    }

    /**
     * 读取作品内文件（优先命中本 runId 暂存覆盖层，否则回落磁盘只读）
     * 严禁跨越 bookRoot 或访问 .git/ 与引擎内部 .ops/ 元数据路径。
     */
    async read(runId: string, relPath: string): Promise<string> {
        const session = this.requireSession(runId);
        const { normalized, absPath } = normalizeAndValidateRelPath(session.bookRoot, relPath, false);

        const staged = session.overlay.get(normalized);
        if (staged !== undefined) {
            return staged;
        }

        const [realRoot, realTarget] = await Promise.all([
            realpath(session.bookRoot),
            realpath(absPath)
        ]);
        const realRel = relative(realRoot, realTarget);
        if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
            throw new Error(`符号链接路径越界 bookRoot: ${relPath}`);
        }
        assertAllowedRelativePath(posix.normalize(realRel.replace(/\\/g, '/')), relPath, false);

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
        replacementText: string
    ): Promise<string> {
        const session = this.requireSession(runId);
        const { normalized } = normalizeAndValidateRelPath(session.bookRoot, relPath, true);
        if (targetText.length === 0) {
            throw new Error('StagingSessionManager.edit 的 targetText 不能为空');
        }

        const current = await this.read(runId, normalized);
        const firstIdx = current.indexOf(targetText);
        if (firstIdx === -1) {
            throw new Error(`在 ${normalized} 中未找到匹配的目标文本`);
        }
        if (current.indexOf(targetText, firstIdx + targetText.length) !== -1) {
            throw new Error(`在 ${normalized} 中匹配到多处目标文本，请提供更精确上下文`);
        }

        const nextContent =
            current.slice(0, firstIdx) + replacementText + current.slice(firstIdx + targetText.length);
        session.overlay.set(normalized, nextContent);
        return nextContent;
    }

    /**
     * 将完整内容写入当前 runId 暂存覆盖层（不修改磁盘文件）
     * 禁止写入 manuscripts/。
     */
    stageWrite(runId: string, relPath: string, content: string): void {
        const session = this.requireSession(runId);
        const { normalized } = normalizeAndValidateRelPath(session.bookRoot, relPath, true);
        session.overlay.set(normalized, content);
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

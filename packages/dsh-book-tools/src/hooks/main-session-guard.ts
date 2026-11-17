import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution, ToolsService } from '@deepseek-ai/dsh-tools';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const ALLOWED_BOOK_TOOL_PREFIXES = ['book_', 'yield_'] as const;
const ALLOWED_EXACT_BOOK_TOOLS = new Set<string>(['lock_charter_and_boot']);

const RAW_FILE_WRITE_TOOLS = new Set<string>([
    'write',
    'edit',
    'apply_patch',
    'str_replace_editor',
    'Write',
    'Edit',
    'MultiEdit',
    'tool:write',
    'tool:edit',
    'tool:apply_patch'
]);

const RAW_SHELL_TOOLS = new Set<string>([
    'bash',
    'pwsh',
    'terminal_open',
    'terminal_send',
    'tool:bash',
    'tool:pwsh'
]);

const SHELL_MUTATION_RE =
    /(?:>{1,2}|<<|\b(?:tee|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|truncate|dd|sed|awk|perl|python|python3|ruby|node|nodejs|git|patch|install)\b)/i;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAllowedNarrateTool(toolName: string): boolean {
    if (ALLOWED_EXACT_BOOK_TOOLS.has(toolName)) {
        return true;
    }
    return ALLOWED_BOOK_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isPathInsideDir(targetPath: string, rootDir: string): boolean {
    const rel = relative(rootDir, targetPath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveCandidateTargets(candidate: string, cwd: string, booksParentDir: string): string[] {
    const trimmed = candidate.trim().replace(/\\/g, '/');
    if (trimmed.length === 0) return [];
    if (isAbsolute(trimmed)) {
        return [resolve(trimmed)];
    }
    return [resolve(cwd, trimmed), resolve(booksParentDir, trimmed)];
}

/** 从终端命令或内联脚本中提取潜在文件路径 Token，供 resolveCandidateTargets + isPathInsideDir 统一判定 */
function extractShellPathTokens(command: string): string[] {
    const tokens = new Set<string>();
    const rawParts = command.split(/[\s"'`;|&()<>]+/);
    for (const part of rawParts) {
        const cleaned = part.replace(/,+$/, '').trim();
        if (cleaned.length === 0) continue;
        tokens.add(cleaned);
        const eqIdx = cleaned.indexOf('=');
        if (eqIdx !== -1 && eqIdx < cleaned.length - 1) {
            const rhs = cleaned.slice(eqIdx + 1).trim();
            if (rhs.length > 0) {
                tokens.add(rhs);
            }
        }
    }
    return [...tokens];
}

function extractPatchFilePaths(patchText: string): string[] {
    const paths: string[] = [];
    for (const line of patchText.split(/\r?\n/)) {
        const headerMatch = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/.exec(line) ??
            /^\*\*\*\s+Move\s+to:\s+(.+)$/.exec(line) ??
            /^(?:\+\+\+|---)\s+(?:[ab]\/)?(.+)$/.exec(line);
        if (headerMatch?.[1] && headerMatch[1].trim() !== '/dev/null') {
            paths.push(headerMatch[1].trim());
        }
    }
    return paths;
}

function extractFileWriteCandidates(args: unknown): string[] {
    if (!isRecord(args)) return [];
    const candidates: string[] = [];
    for (const key of ['path', 'file_path', 'filePath', 'target_file', 'targetPath', 'old_path', 'new_path']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim().length > 0) {
            candidates.push(val);
        }
    }
    for (const patchKey of ['patch', 'input']) {
        const val = args[patchKey];
        if (typeof val === 'string' && val.trim().length > 0) {
            candidates.push(...extractPatchFilePaths(val));
        }
    }
    return candidates;
}

function extractShellCommandText(args: unknown): { command: string; cwd?: string } {
    if (!isRecord(args)) {
        return { command: '' };
    }
    const parts: string[] = [];
    for (const key of ['command', 'cmd', 'input', 'script']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim().length > 0) {
            parts.push(val);
        }
    }
    const cwdVal = typeof args['cwd'] === 'string' ? args['cwd'] : undefined;
    return cwdVal !== undefined
        ? { command: parts.join('\n'), cwd: cwdVal }
        : { command: parts.join('\n') };
}

function resolveSessionCwd(exec: Readonly<ToolExecution>): string {
    const meta = (exec.agent?.session as { meta?: { cwd?: unknown } } | undefined)?.meta;
    if (meta && typeof meta.cwd === 'string' && meta.cwd.trim().length > 0) {
        return resolve(meta.cwd);
    }
    return process.cwd();
}

/** 检测工具调用是否企图越过 NarrateOS 受控工具直接修改 books/<slug>/ */
export function evaluateMainSessionWriteGuard(
    exec: Readonly<ToolExecution>,
    booksRoot: string
): string | undefined {
    if (isAllowedNarrateTool(exec.name)) {
        return undefined;
    }

    const resolvedBooksRoot = resolve(booksRoot);
    const booksParentDir = dirname(resolvedBooksRoot);
    const booksDirName = resolvedBooksRoot.split(sep).filter(Boolean).pop() ?? 'books';
    const sessionCwd = resolveSessionCwd(exec);

    if (RAW_FILE_WRITE_TOOLS.has(exec.name)) {
        const candidates = extractFileWriteCandidates(exec.arguments);
        for (const candidate of candidates) {
            for (const absCandidate of resolveCandidateTargets(candidate, sessionCwd, booksParentDir)) {
                if (isPathInsideDir(absCandidate, resolvedBooksRoot)) {
                    return `主会话写保护拦截：禁止使用裸工具 ${exec.name} 直接写入 ${candidate}。请改用 lock_charter_and_boot、book_edit 或 yield_* 受控工具。`;
                }
            }
        }
    }

    if (RAW_SHELL_TOOLS.has(exec.name)) {
        const { command, cwd } = extractShellCommandText(exec.arguments);
        if (cwd) {
            for (const absCwd of resolveCandidateTargets(cwd, sessionCwd, booksParentDir)) {
                if (isPathInsideDir(absCwd, resolvedBooksRoot)) {
                    return `主会话写保护拦截：禁止在受保护作品目录 ${resolvedBooksRoot} 内执行裸终端命令 (${exec.name})。`;
                }
            }
        }

        const escapedDirName = escapeRegExp(booksDirName);
        const relativeBooksRefRe = new RegExp(
            `(?:^|[\\s"'\`=;(&|<>]|\\.\\.?[/\\\\])${escapedDirName}(?:[/\\\\]|$)`
        );
        const tokenHitsBooksRoot = extractShellPathTokens(command).some((token) =>
            resolveCandidateTargets(token, sessionCwd, booksParentDir).some((abs) =>
                isPathInsideDir(abs, resolvedBooksRoot)
            )
        );
        const referencesBooks =
            command.includes(resolvedBooksRoot) ||
            tokenHitsBooksRoot ||
            relativeBooksRefRe.test(command);
        if (referencesBooks && SHELL_MUTATION_RE.test(command)) {
            return `主会话写保护拦截：检测到 ${exec.name} 命令企图修改 ${booksDirName}/ 作品目录，请改用 NarrateOS 受控工具或工作台同步流程。`;
        }
    }

    return undefined;
}

/**
 * 为主会话注册 books/<slug>/ 写保护守卫：
 * 同时挂载 toolsService.guard(...) 与 tools/pre-execute 监听器（若提供 ctx），
 * 拦截普通对话用裸 write/edit/apply_patch/str_replace_editor/bash 直接篡改作品资产。
 */
export function registerMainSessionWriteGuard(
    toolsService: ToolsService,
    booksRoot: string,
    ctx?: Context
): () => void {
    const resolvedBooksRoot = resolve(booksRoot);
    const disposeGuard = toolsService.guard((exec) =>
        evaluateMainSessionWriteGuard(exec, resolvedBooksRoot)
    );

    const targetCtx = ctx ?? (toolsService as unknown as { ctx?: Context }).ctx;
    const disposePreExecute = targetCtx?.on('tools/pre-execute', async (exec, next) => {
        const denial = evaluateMainSessionWriteGuard(exec, resolvedBooksRoot);
        if (denial !== undefined) {
            return { kind: 'deny', reason: denial };
        }
        return await next();
    });

    return () => {
        disposeGuard();
        disposePreExecute?.();
    };
}

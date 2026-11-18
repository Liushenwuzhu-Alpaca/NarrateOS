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

const ALLOWED_READONLY_SHELL_COMMANDS = new Set<string>([
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'stat',
    'nl',
    'file',
    'basename',
    'dirname',
    'realpath',
    'readlink',
    'pwd',
    'rg',
    'grep',
    'egrep',
    'fgrep',
    'find',
    'git'
]);

const ALLOWED_GIT_READONLY_SUBCOMMANDS = new Set<string>([
    'status',
    'log',
    'diff',
    'show',
    'ls-files'
]);

const FIND_MUTATION_OR_EXEC_FLAG_RE =
    /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(?:=|$)/i;

const GIT_UNSAFE_GLOBAL_FLAG_RE =
    /^-(?:c|c.*|-config-env(?:=.*)?|-exec-path(?:=.*)?|-upload-pack(?:=.*)?)$/i;

const GIT_ALLOWED_GLOBAL_NOARG_FLAGS = new Set<string>([
    '--no-pager',
    '--no-optional-locks',
    '--literal-pathspecs',
    '--glob-pathspecs',
    '--noglob-pathspecs',
    '--icase-pathspecs',
    '-p',
    '--paginate',
    '--bare'
]);

const GIT_UNSAFE_SUBCOMMAND_FLAG_RE = /^--(?:ext-diff|exec|output)(?:=|$)/i;
const SEARCH_UNSAFE_FLAG_RE = /^--(?:pre|exec)(?:=|$)/i;

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

/** 解码 Git diff 路径（支持 C 风格双引号转义序列与无引号 `\t<timestamp>` 尾缀） */
function decodeGitQuotedPath(rawValue: string): string {
    const trimmedStart = rawValue.trimStart();
    if (!trimmedStart.startsWith('"')) {
        const tabIdx = trimmedStart.indexOf('\t');
        const withoutTimestamp = tabIdx === -1 ? trimmedStart : trimmedStart.slice(0, tabIdx);
        return withoutTimestamp.trim();
    }

    const bytes: number[] = [];
    let i = 1;
    while (i < trimmedStart.length) {
        const ch = trimmedStart[i]!;
        if (ch === '"') {
            break;
        }
        if (ch !== '\\') {
            bytes.push(...Buffer.from(ch, 'utf8'));
            i += 1;
            continue;
        }
        i += 1;
        if (i >= trimmedStart.length) {
            break;
        }
        const esc = trimmedStart[i]!;
        if (esc >= '0' && esc <= '7') {
            let octal = esc;
            while (
                octal.length < 3 &&
                i + 1 < trimmedStart.length &&
                trimmedStart[i + 1]! >= '0' &&
                trimmedStart[i + 1]! <= '7'
            ) {
                i += 1;
                octal += trimmedStart[i]!;
            }
            bytes.push(Number.parseInt(octal, 8) & 0xff);
            i += 1;
            continue;
        }
        switch (esc) {
            case 'a':
                bytes.push(0x07);
                break;
            case 'b':
                bytes.push(0x08);
                break;
            case 't':
                bytes.push(0x09);
                break;
            case 'n':
                bytes.push(0x0a);
                break;
            case 'v':
                bytes.push(0x0b);
                break;
            case 'f':
                bytes.push(0x0c);
                break;
            case 'r':
                bytes.push(0x0d);
                break;
            case '"':
                bytes.push(0x22);
                break;
            case '\\':
                bytes.push(0x5c);
                break;
            default:
                bytes.push(...Buffer.from(esc, 'utf8'));
                break;
        }
        i += 1;
    }

    return Buffer.from(bytes).toString('utf8').trim();
}

function extractPatchFilePaths(patchText: string): string[] {
    const paths: string[] = [];
    for (const line of patchText.split(/\r?\n/)) {
        const patchHeaderMatch =
            /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/.exec(line) ??
            /^\*\*\*\s+Move\s+to:\s+(.+)$/.exec(line) ??
            /^(?:rename|copy)\s+(?:from|to)\s+(.+)$/.exec(line);
        if (patchHeaderMatch?.[1]) {
            const decoded = decodeGitQuotedPath(patchHeaderMatch[1]);
            if (decoded.length > 0 && decoded !== '/dev/null') {
                paths.push(decoded);
            }
            continue;
        }

        const unifiedHeaderMatch = /^(?:\+\+\+|---)\s+(.+)$/.exec(line);
        if (unifiedHeaderMatch?.[1]) {
            const decoded = decodeGitQuotedPath(unifiedHeaderMatch[1]).replace(/^[ab]\//, '');
            if (decoded.length > 0 && decoded !== '/dev/null') {
                paths.push(decoded);
            }
        }
    }
    return paths;
}

/** 将受保护终端命令拆分为不含重定向/子壳/命令替换的简单命令片段，任一高危语法直接返回 null */
function tokenizeShellSegments(command: string): string[][] | null {
    const segments: string[][] = [];
    let currentSegment: string[] = [];
    let currentToken = '';
    let hasToken = false;
    let quote: "'" | '"' | null = null;

    const flushToken = () => {
        if (hasToken) {
            currentSegment.push(currentToken);
            currentToken = '';
            hasToken = false;
        }
    };

    const flushSegment = () => {
        flushToken();
        if (currentSegment.length > 0) {
            segments.push(currentSegment);
            currentSegment = [];
        }
    };

    for (let i = 0; i < command.length; i += 1) {
        const ch = command[i]!;
        const next = i + 1 < command.length ? command[i + 1]! : '';

        if (quote === "'") {
            if (ch === "'") {
                quote = null;
            } else {
                currentToken += ch;
            }
            continue;
        }

        if (quote === '"') {
            if (ch === '\\') {
                if (i + 1 >= command.length) {
                    return null;
                }
                currentToken += next;
                i += 1;
                continue;
            }
            if (ch === '`' || (ch === '$' && next === '(')) {
                return null;
            }
            if (ch === '"') {
                quote = null;
            } else {
                currentToken += ch;
            }
            continue;
        }

        if (ch === '#' && !hasToken) {
            while (i + 1 < command.length && command[i + 1] !== '\n') {
                i += 1;
            }
            continue;
        }

        if (ch === '\\') {
            if (i + 1 >= command.length) {
                return null;
            }
            if (next !== '\n') {
                currentToken += next;
                hasToken = true;
            }
            i += 1;
            continue;
        }

        if (ch === "'" || ch === '"') {
            quote = ch;
            hasToken = true;
            continue;
        }

        if (
            ch === '`' ||
            ch === '>' ||
            ch === '<' ||
            ch === '(' ||
            ch === ')' ||
            ch === '{' ||
            ch === '}' ||
            (ch === '$' && next === '(')
        ) {
            return null;
        }

        if (ch === ';' || ch === '\n') {
            flushSegment();
            continue;
        }

        if (ch === '&') {
            if (next === '&') {
                flushSegment();
                i += 1;
                continue;
            }
            return null;
        }

        if (ch === '|') {
            flushSegment();
            if (next === '|') {
                i += 1;
            }
            continue;
        }

        if (ch === ' ' || ch === '\t' || ch === '\r') {
            flushToken();
            continue;
        }

        currentToken += ch;
        hasToken = true;
    }

    if (quote !== null) {
        return null;
    }

    flushSegment();
    return segments.length > 0 ? segments : null;
}

function isSafeGitSegment(tokens: string[]): boolean {
    let idx = 1;
    let subcommand: string | undefined;

    while (idx < tokens.length) {
        const arg = tokens[idx]!;
        if (arg === '-C') {
            if (idx + 1 >= tokens.length) {
                return false;
            }
            idx += 2;
            continue;
        }
        if (arg.startsWith('-C') && arg.length > 2) {
            idx += 1;
            continue;
        }
        if (GIT_UNSAFE_GLOBAL_FLAG_RE.test(arg)) {
            return false;
        }
        if (GIT_ALLOWED_GLOBAL_NOARG_FLAGS.has(arg)) {
            idx += 1;
            continue;
        }
        if (arg.startsWith('-')) {
            return false;
        }
        subcommand = arg;
        break;
    }

    if (!subcommand || !ALLOWED_GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
        return false;
    }

    for (const arg of tokens.slice(idx + 1)) {
        if (GIT_UNSAFE_SUBCOMMAND_FLAG_RE.test(arg)) {
            return false;
        }
    }

    return true;
}

function isSafeReadOnlySegment(tokens: string[]): boolean {
    if (tokens.length === 0) {
        return false;
    }
    const cmd = tokens[0]!;
    if (cmd.includes('=') || cmd.includes('/') || cmd.includes('\\')) {
        return false;
    }
    if (!ALLOWED_READONLY_SHELL_COMMANDS.has(cmd)) {
        return false;
    }
    if (cmd === 'git') {
        return isSafeGitSegment(tokens);
    }
    if (cmd === 'find') {
        return tokens.slice(1).every((arg) => !FIND_MUTATION_OR_EXEC_FLAG_RE.test(arg));
    }
    if (cmd === 'rg' || cmd === 'grep' || cmd === 'egrep' || cmd === 'fgrep') {
        return tokens.slice(1).every((arg) => !SEARCH_UNSAFE_FLAG_RE.test(arg));
    }
    return true;
}

function isPureReadOnlyShellCommand(command: string): boolean {
    const segments = tokenizeShellSegments(command);
    if (!segments) {
        return false;
    }
    return segments.every(isSafeReadOnlySegment);
}

function collectProtectedRoots(
    booksRoot: string,
    extraProtectedRoots?: ReadonlyArray<string | null | undefined>
): string[] {
    const roots = new Set<string>([resolve(booksRoot)]);
    if (extraProtectedRoots) {
        for (const extra of extraProtectedRoots) {
            if (typeof extra === 'string' && extra.trim().length > 0) {
                roots.add(resolve(extra.trim()));
            }
        }
    }
    return [...roots];
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

/** 检测工具调用是否企图越过 NarrateOS 受控工具直接修改 books/<slug>/ 或当前激活外部 bookRoot */
export function evaluateMainSessionWriteGuard(
    exec: Readonly<ToolExecution>,
    booksRoot: string,
    extraProtectedRoots?: ReadonlyArray<string | null | undefined>
): string | undefined {
    if (isAllowedNarrateTool(exec.name)) {
        return undefined;
    }

    const protectedRoots = collectProtectedRoots(booksRoot, extraProtectedRoots);
    const sessionCwd = resolveSessionCwd(exec);

    if (RAW_FILE_WRITE_TOOLS.has(exec.name)) {
        const candidates = extractFileWriteCandidates(exec.arguments);
        for (const candidate of candidates) {
            for (const protectedRoot of protectedRoots) {
                const rootParentDir = dirname(protectedRoot);
                for (const absCandidate of resolveCandidateTargets(candidate, sessionCwd, rootParentDir)) {
                    if (isPathInsideDir(absCandidate, protectedRoot)) {
                        return `主会话写保护拦截：禁止使用裸工具 ${exec.name} 直接写入 ${candidate}。请改用 lock_charter_and_boot 或右侧 Studio 工作台操作。`;
                    }
                }
            }
        }
    }

    if (RAW_SHELL_TOOLS.has(exec.name)) {
        const { command, cwd } = extractShellCommandText(exec.arguments);
        if (cwd) {
            for (const protectedRoot of protectedRoots) {
                for (const absCwd of resolveCandidateTargets(cwd, sessionCwd, dirname(protectedRoot))) {
                    if (isPathInsideDir(absCwd, protectedRoot)) {
                        return `主会话写保护拦截：禁止在受保护作品目录 ${protectedRoot} 内执行裸终端命令 (${exec.name})。`;
                    }
                }
            }
        }

        const shellTokens = extractShellPathTokens(command);
        const matchedRoot = protectedRoots.find((protectedRoot) => {
            if (isPathInsideDir(sessionCwd, protectedRoot)) {
                return true;
            }
            if (command.includes(protectedRoot)) {
                return true;
            }
            const rootParentDir = dirname(protectedRoot);
            const rootDirName = protectedRoot.split(sep).filter(Boolean).pop() ?? 'books';
            const relativeRootRefRe = new RegExp(
                `(?:^|[\\s"'\`=;(&|<>]|\\.\\.?[/\\\\])${escapeRegExp(rootDirName)}(?:[/\\\\]|$)`
            );
            if (relativeRootRefRe.test(command)) {
                return true;
            }
            return shellTokens.some((token) =>
                resolveCandidateTargets(token, sessionCwd, rootParentDir).some((abs) =>
                    isPathInsideDir(abs, protectedRoot)
                )
            );
        });

        if (matchedRoot !== undefined && !isPureReadOnlyShellCommand(command)) {
            const matchedDirName = matchedRoot.split(sep).filter(Boolean).pop() ?? 'books';
            return `主会话写保护拦截：检测到 ${exec.name} 命令企图在受保护作品目录 ${matchedDirName}/ 上执行非纯只读操作，请改用 NarrateOS 受控工具或工作台同步流程。`;
        }
    }

    return undefined;
}

/**
 * 为主会话注册 books/<slug>/ 与当前激活外部 bookRoot 写保护守卫：
 * 同时挂载 toolsService.guard(...) 与 tools/pre-execute 监听器（若提供 ctx），
 * 拦截普通对话用裸 write/edit/apply_patch/str_replace_editor/bash 直接篡改作品资产。
 */
export function registerMainSessionWriteGuard(
    toolsService: ToolsService,
    booksRoot: string,
    ctx?: Context
): () => void {
    const resolvedBooksRoot = resolve(booksRoot);
    const targetCtx = ctx ?? (toolsService as unknown as { ctx?: Context }).ctx;
    const getExtraProtectedRoots = (): string[] => {
        const activeBookRoot = (
            targetCtx as { narrateStore?: { bookRoot?: string | null } } | undefined
        )?.narrateStore?.bookRoot;
        return typeof activeBookRoot === 'string' && activeBookRoot.trim().length > 0
            ? [activeBookRoot]
            : [];
    };

    const disposeGuard = toolsService.guard((exec) =>
        evaluateMainSessionWriteGuard(exec, resolvedBooksRoot, getExtraProtectedRoots())
    );

    const disposePreExecute = targetCtx?.on('tools/pre-execute', async (exec, next) => {
        const denial = evaluateMainSessionWriteGuard(
            exec,
            resolvedBooksRoot,
            getExtraProtectedRoots()
        );
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

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Git 提交结果 */
export interface GitCommitResult {
    sha: string;
}

/** Ripgrep 命中片段（按段落上下文封装） */
export interface RipgrepMatch {
    file: string;
    line: number;
    text: string;
    contextBefore: string[];
    contextAfter: string[];
}

/** 版本库与全文检索窄接缝 */
export interface SystemPort {
    initRepo(bookRoot: string): Promise<void>;
    commitPaths(bookRoot: string, paths: string[], message: string): Promise<GitCommitResult>;
    createTag(bookRoot: string, tagName: string, message?: string): Promise<void>;
    readFileAtRef(bookRoot: string, ref: string, relativePath: string): Promise<string | null>;
    diffFile(bookRoot: string, refA: string, refB: string, relativePath: string): Promise<string>;
    resetHard(bookRoot: string, ref: string): Promise<void>;
    cleanUntracked(bookRoot: string, excludePaths?: string[]): Promise<void>;
    isWorkingTreeClean(bookRoot: string): Promise<boolean>;
    ripgrepSearch(
        bookRoot: string,
        patterns: string[],
        chapterFiles: string[],
        contextLines?: number
    ): Promise<RipgrepMatch[]>;
}

/** 基于原生 git 与 rg CLI 的真实系统适配器 */
export class NodeSystemAdapter implements SystemPort {
    private async runGit(bookRoot: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
        return await execFileAsync('git', ['-C', bookRoot, ...args], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024
        });
    }

    async initRepo(bookRoot: string): Promise<void> {
        const gitDir = join(bookRoot, '.git');
        try {
            await access(gitDir);
            return;
        } catch {
            // 尚未初始化时创建独立作品子仓并写入默认提交身份（仅限该子仓局部配置）
            await this.runGit(bookRoot, ['init', '-b', 'main']);
            await this.runGit(bookRoot, ['config', 'user.name', 'NarrateOS']);
            await this.runGit(bookRoot, ['config', 'user.email', 'narrateos@local']);
        }
    }

    async commitPaths(bookRoot: string, paths: string[], message: string): Promise<GitCommitResult> {
        if (paths.length === 0) {
            throw new Error('commitPaths 至少需要指定一个路径');
        }
        await this.runGit(bookRoot, ['add', '--', ...paths]);
        const { stdout: statusOut } = await this.runGit(bookRoot, ['status', '--porcelain', '--', ...paths]);
        if (statusOut.trim().length > 0) {
            await this.runGit(bookRoot, ['commit', '-m', message, '--', ...paths]);
        }
        const { stdout: shaOut } = await this.runGit(bookRoot, ['rev-parse', 'HEAD']);
        return { sha: shaOut.trim() };
    }

    async createTag(bookRoot: string, tagName: string, message?: string): Promise<void> {
        const args = message ? ['tag', '-a', tagName, '-m', message] : ['tag', tagName];
        await this.runGit(bookRoot, args);
    }

    async readFileAtRef(bookRoot: string, ref: string, relativePath: string): Promise<string | null> {
        try {
            const { stdout } = await this.runGit(bookRoot, ['show', `${ref}:${relativePath}`]);
            return stdout;
        } catch {
            return null;
        }
    }

    async diffFile(bookRoot: string, refA: string, refB: string, relativePath: string): Promise<string> {
        const { stdout } = await this.runGit(bookRoot, ['diff', refA, refB, '--', relativePath]);
        return stdout;
    }

    async resetHard(bookRoot: string, ref: string): Promise<void> {
        await this.runGit(bookRoot, ['reset', '--hard', ref]);
    }

    async cleanUntracked(bookRoot: string, excludePaths: string[] = []): Promise<void> {
        const args = ['clean', '-fd'];
        for (const pattern of excludePaths) {
            args.push('-e', pattern);
        }
        await this.runGit(bookRoot, args);
    }

    async isWorkingTreeClean(bookRoot: string): Promise<boolean> {
        const { stdout } = await this.runGit(bookRoot, ['status', '--porcelain']);
        return stdout.trim().length === 0;
    }

    async ripgrepSearch(
        bookRoot: string,
        patterns: string[],
        chapterFiles: string[],
        contextLines = 4
    ): Promise<RipgrepMatch[]> {
        if (patterns.length === 0 || chapterFiles.length === 0) {
            return [];
        }

        const args = ['--json', '-F', '-C', String(contextLines)];
        for (const p of patterns) {
            args.push('-e', p);
        }
        args.push(...chapterFiles);

        let stdout = '';
        try {
            const res = await execFileAsync('rg', args, {
                cwd: bookRoot,
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024
            });
            stdout = res.stdout;
        } catch (err: unknown) {
            // ripgrep 未命中时退出码为 1，属于正常空结果
            const execErr = err as { code?: number; stdout?: string };
            if (execErr.code === 1) {
                return [];
            }
            throw err;
        }

        const results: RipgrepMatch[] = [];
        let pendingBefore: string[] = [];
        let activeMatch: RipgrepMatch | null = null;

        const flushActive = () => {
            if (activeMatch) {
                results.push(activeMatch);
                activeMatch = null;
            }
        };

        for (const rawLine of stdout.split('\n')) {
            if (!rawLine.trim()) continue;
            const evt = JSON.parse(rawLine) as {
                type: string;
                data?: {
                    path?: { text?: string };
                    line_number?: number;
                    lines?: { text?: string };
                };
            };

            if (evt.type === 'begin' || evt.type === 'end') {
                flushActive();
                pendingBefore = [];
                continue;
            }

            const lineText = (evt.data?.lines?.text ?? '').replace(/\r?\n$/, '');
            if (evt.type === 'context') {
                if (activeMatch) {
                    activeMatch.contextAfter.push(lineText);
                } else {
                    pendingBefore.push(lineText);
                }
            } else if (evt.type === 'match') {
                flushActive();
                activeMatch = {
                    file: evt.data?.path?.text ?? '',
                    line: evt.data?.line_number ?? 0,
                    text: lineText,
                    contextBefore: pendingBefore,
                    contextAfter: []
                };
                pendingBefore = [];
            }
        }
        flushActive();
        return results;
    }
}

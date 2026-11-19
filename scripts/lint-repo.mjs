#!/usr/bin/env node
/**
 * 仓库确定性静态门禁检查脚本（零外部依赖）：
 * 1. 全仓禁止出现 U+2011 不换行连字符（统一使用 ASCII '-' U+002D）；
 * 2. 生产源码与预设配置禁止硬编码私有代理模型标识（应由环境变量或作品配置覆盖）；
 * 3. 校验 .env 已被 Git 忽略，且只读样本 manuscript/vol-01/ch-01.md 未被改动；
 * 4. 非 --fast 模式下校验 Studio 前端构建产物存在且不早于源码修改时间。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FAST_MODE = process.argv.includes('--fast');

const TEXT_EXTENSIONS = new Set([
    '.md',
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.cjs',
    '.json',
    '.yaml',
    '.yml',
    '.sh',
    '.css',
    '.html'
]);

const SKIP_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'tmp',
    '.omp',
    '.scratch',
    '.agents',
    'books'
]);

const PRIVATE_PROXY_MODEL_RE = /\bgemini-4-(?:hydrogen|argon|carbon)(?:-[a-z0-9]+)?\b/;

/**
 * 递归收集指定路径下的全部文本文件。
 * @param {string} absPath
 * @param {string[]} out
 */
async function collectTextFiles(absPath, out) {
    let info;
    try {
        info = await stat(absPath);
    } catch {
        return;
    }
    if (info.isFile()) {
        const name = basename(absPath);
        if (name === '.env.example' || TEXT_EXTENSIONS.has(extname(name)) || absPath.split(sep).at(-2) === '.githooks') {
            out.push(absPath);
        }
        return;
    }
    if (!info.isDirectory()) {
        return;
    }
    const entries = await readdir(absPath, { withFileTypes: true });
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) {
            continue;
        }
        await collectTextFiles(join(absPath, entry.name), out);
    }
}

/**
 * 递归计算目录下所有文件的最新修改时间戳（毫秒）。
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
async function latestMtimeMs(dirPath) {
    let latest = 0;
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const full = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            const sub = await latestMtimeMs(full);
            if (sub > latest) {
                latest = sub;
            }
        } else if (entry.isFile()) {
            const st = await stat(full);
            if (st.mtimeMs > latest) {
                latest = st.mtimeMs;
            }
        }
    }
    return latest;
}

/**
 * 判断文件是否属于生产实现或预设配置（排除测试夹具与单测文件）。
 * @param {string} relPath
 * @returns {boolean}
 */
function isProductionCodeOrPreset(relPath) {
    if (!relPath.startsWith('packages/') && !relPath.startsWith('presets/')) {
        return false;
    }
    if (
        relPath.includes('.test.') ||
        relPath.includes('/tests/') ||
        relPath.endsWith('/test-harness.ts')
    ) {
        return false;
    }
    return true;
}

async function main() {
    /** @type {string[]} */
    const violations = [];

    const scanTargets = [
        'AGENTS.md',
        'ROADMAP.md',
        'CODING_STANDARDS.md',
        'package.json',
        'vitest.config.ts',
        'docs',
        'packages',
        'presets',
        'plugins',
        'pnpm-workspace.yaml',
        'tsconfig.base.json',
        '.env.example',
        'scripts',
        '.github',
        '.githooks'
    ];

    /** @type {string[]} */
    const files = [];
    for (const target of scanTargets) {
        await collectTextFiles(join(REPO_ROOT, target), files);
    }

    for (const filePath of files) {
        const rel = relative(REPO_ROOT, filePath).replace(/\\/g, '/');
        const content = await readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const checkProxyModel = isProductionCodeOrPreset(rel);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const u2011Col = line.indexOf('\u2011');
            if (u2011Col !== -1) {
                violations.push(
                    `[no-u2011] ${rel}:${i + 1}:${u2011Col + 1} 发现不换行连字符 U+2011，请替换为 ASCII '-' (U+002D)`
                );
            }
            if (checkProxyModel) {
                const match = PRIVATE_PROXY_MODEL_RE.exec(line);
                if (match) {
                    violations.push(
                        `[no-hardcoded-proxy-model] ${rel}:${i + 1} 生产代码或预设配置禁止硬编码环境私有模型 '${match[0]}'`
                    );
                }
            }
        }
    }

    try {
        execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: REPO_ROOT, stdio: 'ignore' });
    } catch {
        violations.push('[env-gitignored] .gitignore 未忽略 .env，存在密钥误提交风险');
    }

    try {
        const bytes = await readFile(join(REPO_ROOT, 'manuscript/vol-01/ch-01.md'));
        if (createHash('sha256').update(bytes).digest('hex') !==
            'e7f59296b7d61497639739807b5b477246daa046ade6ef38ce55f9020a564dc7') {
            violations.push(
                `[readonly-fixture-clean] 只读样本 manuscript/vol-01/ch-01.md 发生变更`
            );
        }
    } catch (error) {
        // 样本不随 Git 分发；存在时必须可读且与基准一致。
        if (error.code !== 'ENOENT') throw error;
    }

    if (!FAST_MODE) {
        const studioSrcDir = join(REPO_ROOT, 'packages/dsh-client-ui-studio/src');
        const studioDistIndex = join(REPO_ROOT, 'packages/dsh-client-ui-studio/dist/index.js');
        const studioDistClient = join(REPO_ROOT, 'packages/dsh-client-ui-studio/dist/client.js');
        try {
            const [srcMtime, idxStat, cliStat, bundler, clientConfig] = await Promise.all([
                latestMtimeMs(studioSrcDir),
                stat(studioDistIndex),
                stat(studioDistClient),
                stat(join(studioSrcDir, '../scripts/bundle-client.mjs')),
                stat(join(studioSrcDir, '../tsconfig.client.json'))
            ]);
            const oldestDist = Math.min(idxStat.mtimeMs, cliStat.mtimeMs);
            if (oldestDist + 50 < srcMtime || cliStat.mtimeMs + 50 < Math.max(bundler.mtimeMs, clientConfig.mtimeMs)) {
                violations.push(
                    '[studio-bundle-fresh] packages/dsh-client-ui-studio/dist 产物早于 src 源码，请先执行 pnpm run build'
                );
            }
        } catch {
            violations.push(
                '[studio-bundle-fresh] 缺少 packages/dsh-client-ui-studio/dist 构建产物，请先执行 pnpm run build'
            );
        }
    }

    if (violations.length > 0) {
        console.error(`lint-repo 检查未通过（共 ${violations.length} 项）：`);
        for (const item of violations) {
            console.error(`  - ${item}`);
        }
        process.exit(1);
    }

    console.log(
        `lint-repo 通过（已扫描 ${files.length} 个文件${FAST_MODE ? '，fast 模式' : ''}）。`
    );
}

await main();

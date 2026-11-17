import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');
const rawDir = join(packageRoot, 'dist', 'client-raw');
const outFile = join(packageRoot, 'dist', 'client.js');

/**
 * 递归收集目录下所有 .js 文件，返回相对于 baseDir 的 POSIX 路径列表（以 ./ 开头）
 */
async function collectJsFiles(dir, baseDir = dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }

    const files = [];
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await collectJsFiles(fullPath, baseDir);
            files.push(...nested);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            const rel = fullPath
                .slice(baseDir.length)
                .replace(/\\/g, '/')
                .replace(/^\/+/, '');
            files.push(`./${rel}`);
        }
    }
    files.sort((a, b) => a.localeCompare(b));
    return files;
}

/**
 * 将模块源码中的相对路径 require('./...') / require('../...') 改写为 __localRequire(...)，
 * 避免产物中残留任何相对路径同步 require 字面量；外部包名保持 require(...) 透传给宿主。
 */
function rewriteRelativeRequires(code) {
    return code.replace(
        /\brequire\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g,
        (_match, quote, spec) => `__localRequire(${quote}${spec}${quote})`
    );
}

/**
 * 组装单文件 CJS factory bundle，兼容 DSH dsh-client-modules 运行时协议
 */
function buildBundleSource(moduleEntries, entryId) {
    const moduleBlocks = moduleEntries.map(([id, code]) => {
        const transformed = rewriteRelativeRequires(code);
        return `        ${JSON.stringify(id)}: function (module, exports, require, __localRequire) {\n${transformed}\n        }`;
    });

    return `'use strict';
/**
 * NarrateOS DSH Studio 客户端单文件 CJS bundle（由 scripts/bundle-client.mjs 自动生成）
 * 内部相对模块通过内存注册表解析，外部宿主依赖透传给 DSH require(id)。
 */
(function (runFactory) {
    if (
        typeof window !== 'undefined' &&
        window.__ModuleLoader__ &&
        typeof window.__ModuleLoader__.load === 'function'
    ) {
        window.__ModuleLoader__.load({
            id: '@narrateos/dsh-client-ui-studio',
            factory: function (hostRequire) {
                var rootModule = { exports: {} };
                runFactory(hostRequire, rootModule);
                return rootModule.exports;
            }
        });
    } else if (typeof module !== 'undefined' && typeof require === 'function') {
        runFactory(require, module);
    }
})(function (hostRequire, rootModule) {
    var __modules = {
${moduleBlocks.join(',\n')}
    };
    var __cache = Object.create(null);

    function __normalizeRelative(fromId, request) {
        var baseDir = fromId.slice(0, fromId.lastIndexOf('/')) || '.';
        var joined = baseDir + '/' + request;
        var parts = joined.split('/');
        var stack = [];
        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            if (!seg || seg === '.') continue;
            if (seg === '..') {
                if (stack.length > 0) stack.pop();
            } else {
                stack.push(seg);
            }
        }
        return './' + stack.join('/');
    }

    function __resolveModuleId(fromId, request) {
        var normalized = __normalizeRelative(fromId, request);
        var candidates = [
            normalized,
            normalized + '.js',
            normalized + '/index.js'
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (Object.prototype.hasOwnProperty.call(__modules, candidates[i])) {
                return candidates[i];
            }
        }
        return null;
    }

    function __execModule(moduleId) {
        if (Object.prototype.hasOwnProperty.call(__cache, moduleId)) {
            return __cache[moduleId].exports;
        }
        var factory = __modules[moduleId];
        if (!factory) {
            throw new Error('[narrateos-studio-client] 未找到内置模块: ' + moduleId);
        }
        var mod = { exports: {} };
        __cache[moduleId] = mod;

        function localRequire(request) {
            if (typeof request !== 'string') {
                return hostRequire(request);
            }
            if (request.indexOf('./') !== 0 && request.indexOf('../') !== 0) {
                return hostRequire(request);
            }
            var resolved = __resolveModuleId(moduleId, request);
            if (!resolved) {
                throw new Error('[narrateos-studio-client] 无法解析相对模块 "' + request + '" (from ' + moduleId + ')');
            }
            return __execModule(resolved);
        }

        factory(mod, mod.exports, hostRequire, localRequire);
        return mod.exports;
    }

    var entryId = ${JSON.stringify(entryId)};
    if (Object.prototype.hasOwnProperty.call(__modules, entryId)) {
        rootModule.exports = __execModule(entryId);
    } else {
        rootModule.exports = {};
    }
});
`;
}

async function main() {
    const moduleIds = await collectJsFiles(rawDir);
    if (moduleIds.length === 0) {
        throw new Error(`未在 ${rawDir} 找到已编译的 .js 文件，请先执行 tsc -p tsconfig.client.json`);
    }

    const entries = [];
    for (const id of moduleIds) {
        const diskPath = join(rawDir, id.slice(2).split(posix.sep).join('/'));
        const content = await readFile(diskPath, 'utf8');
        entries.push([id, content]);
    }

    const entryId = './index.js';
    const hasEntry = moduleIds.includes(entryId);
    if (!hasEntry) {
        console.warn(`[bundle-client] 警告：未找到入口 ${entryId}，将生成仅包含子模块的 bundle。`);
    }

    const bundleCode = buildBundleSource(entries, entryId);
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, bundleCode, 'utf8');
    await rm(rawDir, { recursive: true, force: true });
    console.log(`[bundle-client] 已打包 ${entries.length} 个模块 -> ${outFile}`);
}

main().catch((err) => {
    console.error('[bundle-client] 构建失败:', err);
    process.exitCode = 1;
});

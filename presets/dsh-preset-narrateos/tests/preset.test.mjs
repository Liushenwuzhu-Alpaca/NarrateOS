import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRESET_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PRESET_ROOT, '../..');

const rootRequire = createRequire(path.join(REPO_ROOT, 'package.json'));

async function importFromRoot(specifier) {
    const resolved = rootRequire.resolve(specifier);
    return await import(pathToFileURL(resolved).href);
}

async function loadYaml() {
    try {
        const mod = await import('yaml');
        return mod.default ?? mod;
    } catch {
        // 回退至工作区已安装的 yaml（pnpm 严格隔离模式下避免修改根 lockfile）
        const req = createRequire(path.join(REPO_ROOT, 'packages/dsh-book-store/package.json'));
        return req('yaml');
    }
}

const YAML = await loadYaml();

function collectFilesRecursively(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFilesRecursively(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }
    return files;
}

function parseFrontmatter(markdown) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown);
    assert.ok(match, 'Markdown 必须包含 YAML frontmatter');
    return YAML.parse(match[1]);
}

test('package.json 与本地化清单符合 DSH Bundle 规范', () => {
    const pkgPath = path.join(PRESET_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    assert.equal(pkg.name, '@narrateos/dsh-preset-narrateos');
    assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');

    for (const exportKey of ['./cordis.patch.yml', './roles/*', './skills/*', './locale/*.json', './package.json']) {
        assert.ok(pkg.exports?.[exportKey], `缺少 exports["${exportKey}"]`);
    }

    const requiredPeers = [
        '@deepseek-ai/dsh-agent-preset',
        '@deepseek-ai/dsh-persona',
        '@deepseek-ai/dsh-tool-fs',
        '@deepseek-ai/dsh-tool-fs-search',
        '@deepseek-ai/dsh-tool-web',
        '@narrateos/dsh-book-store',
        '@narrateos/dsh-book-tools',
        '@narrateos/dsh-pipeline',
        '@narrateos/dsh-client-ui-studio'
    ];
    for (const dep of requiredPeers) {
        assert.ok(pkg.peerDependencies?.[dep], `缺少 peerDependencies["${dep}"]`);
    }

    for (const localeFile of ['en.json', 'zh.json']) {
        const localePath = path.join(PRESET_ROOT, 'locale', localeFile);
        const localeObj = JSON.parse(fs.readFileSync(localePath, 'utf8'));
        assert.equal(typeof localeObj.meta?.title, 'string');
        assert.ok(localeObj.meta.title.trim().length > 0);
        assert.equal(typeof localeObj.meta?.description, 'string');
        assert.ok(localeObj.meta.description.trim().length > 0);
    }
});

test('cordis.patch.yml 遵循宿主平面与预设作用域分层，不动态查找包路径', async () => {
    const patchPath = path.join(PRESET_ROOT, 'cordis.patch.yml');
    const raw = fs.readFileSync(patchPath, 'utf8');

    assert.ok(!raw.includes('createRequire(baseUrl)'), 'cordis.patch.yml 不应依赖 createRequire(baseUrl)');

    const { loadOverlayPatches } = await importFromRoot('@deepseek-ai/dsh-app-boot');
    const parsed = loadOverlayPatches('dsh', patchPath);
    assert.ok(Array.isArray(parsed) && parsed.length >= 1, 'cordis.patch.yml 应为有效补丁列表');

    const insertBlocks = parsed.filter((item) => Array.isArray(item?.insert));
    assert.equal(insertBlocks.length, 1, '应包含单一顶层 insert 块');
    const insertRows = insertBlocks[0].insert;

    // 1. 宿主平面必须挂载共享服务插件与纯浏览器 UI 插件
    const hostByName = new Map(insertRows.map((entry) => [entry.name, entry]));
    for (const hostPlugin of [
        '@narrateos/dsh-book-store',
        '@narrateos/dsh-book-tools',
        '@narrateos/dsh-pipeline',
        '@narrateos/dsh-client-ui-studio'
    ]) {
        const entry = hostByName.get(hostPlugin);
        assert.ok(entry && entry.disabled !== true, `必须在顶层宿主平面挂载 ${hostPlugin}`);
    }

    const bookStore = hostByName.get('@narrateos/dsh-book-store');
    assert.equal(bookStore.id, 'narrateos-book-store');
    assert.equal(bookStore.config?.booksRoot, './books');

    const bookTools = hostByName.get('@narrateos/dsh-book-tools');
    assert.equal(bookTools.id, 'narrateos-book-tools');
    assert.equal(bookTools.config?.booksRoot, './books');

    const pipeline = hostByName.get('@narrateos/dsh-pipeline');
    assert.equal(pipeline.id, 'narrateos-pipeline');
    assert.equal(pipeline.config?.booksRoot, './books');
    assert.equal(pipeline.config?.presetRoot, undefined, 'dsh-pipeline 自行回退解析 presetRoot，不在 patch 中硬编码 !!js');
    assert.equal(pipeline.config?.poolRouting?.audit, undefined, 'cordis.patch.yml 仅暴露强/弱双池，不得残留 audit 第三池');
    for (const pool of ['strong_creative', 'fast_retrieval']) {
        const poolCfg = pipeline.config?.poolRouting?.[pool];
        assert.ok(poolCfg !== undefined && typeof poolCfg === 'object', `缺少 poolRouting.${pool} 双池槽位`);
        assert.equal(poolCfg.provider ?? '', '', `poolRouting.${pool}.provider 不应写死默认假模型提供商`);
        assert.equal(poolCfg.model ?? '', '', `poolRouting.${pool}.model 不应写死默认假模型名`);
    }

    const studioUi = hostByName.get('@narrateos/dsh-client-ui-studio');
    assert.equal(studioUi.id, 'narrateos-client-ui-studio');

    // 2. 仅注册单一 NarrateOS 创作模式
    const presetRows = insertRows.filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset');
    assert.equal(presetRows.length, 1, '必须且只能注册 1 个 @deepseek-ai/dsh-agent-preset');

    const preset = presetRows[0];
    assert.equal(preset.id, 'preset-narrateos');
    assert.equal(preset.config?.id, 'narrateos');
    assert.equal(preset.config?.name, 'NarrateOS 创作模式');
    assert.equal(preset.config?.order, 90);
    assert.ok(typeof preset.config?.description === 'string' && preset.config.description.trim().length > 0);

    const workerIds = ['boot-compiler', 'librarian', 'planner', 'writer', 'fact-checker', 'extractor', 'dreamer'];
    for (const row of insertRows) {
        assert.ok(!workerIds.includes(row?.config?.id), `禁止将后台工种 ${row?.config?.id} 注册为 dsh-agent-preset`);
    }

    // 3. 预设 plugins 仅保留会话级插件：零宿主/UI 插件、零编码向工具、零死 disabled: true 行
    const plugins = preset.config?.plugins;
    assert.ok(Array.isArray(plugins), 'preset.config.plugins 必须为数组');
    for (const entry of plugins) {
        assert.notEqual(entry.disabled, true, `preset.config.plugins 中不应残留死 disabled 行: ${entry.id ?? entry.name}`);
    }

    const presetPluginNames = plugins.map((entry) => entry.name);
    assert.deepEqual(
        presetPluginNames,
        [
            '@deepseek-ai/dsh-persona',
            '@deepseek-ai/dsh-tool-web',
            '@deepseek-ai/dsh-tool-ask-user',
            '@deepseek-ai/dsh-tool-fs',
            '@deepseek-ai/dsh-tool-fs-search',
            '@deepseek-ai/dsh-skill-filesystem',
            '@deepseek-ai/dsh-tool-skill',
            'cordis:group'
        ],
        'preset.config.plugins 必须严格仅包含会话级插件'
    );

    const byName = new Map(plugins.map((entry) => [entry.name, entry]));
    const persona = byName.get('@deepseek-ai/dsh-persona');
    assert.equal(persona.config?.complete, true);
    assert.equal(persona.config?.includeRuntimeContext, false);
    assert.ok(typeof persona.config?.prefix === 'string' && persona.config.prefix.includes('{{model}}'));
    assert.ok(persona.config.prefix.includes('skill') && persona.config.prefix.includes('narrate-boot'));
    assert.ok(!persona.config.prefix.includes('->'), 'persona.prefix 不应展开流程箭头摘要诱发跳过 Skill');

    const web = byName.get('@deepseek-ai/dsh-tool-web');
    assert.equal(web.config?.fetch, true);
    assert.equal(web.config?.searchTimeoutMs, 60000);

    const toolFs = byName.get('@deepseek-ai/dsh-tool-fs');
    assert.equal(toolFs.id, 'tool-fs');
    assert.deepEqual(toolFs.config, {
        read: true,
        readImage: false,
        write: false,
        edit: false,
        applyPatch: false
    });

    const toolFsSearch = byName.get('@deepseek-ai/dsh-tool-fs-search');
    assert.equal(toolFsSearch.id, 'tool-fs-search');
    assert.deepEqual(toolFsSearch.config, {
        sampleOverCapGlobResults: false
    });

    const skillFs = byName.get('@deepseek-ai/dsh-skill-filesystem');
    assert.equal(skillFs.config, undefined, 'skill-filesystem 使用默认安全配置，由 dsh-pipeline 动态挂载 narrate-boot');

    const compaction = plugins.find((entry) => entry.id === 'compaction' && entry.group === true);
    assert.ok(compaction && Array.isArray(compaction.config), '必须包含 compaction 隔离组');
    assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
    const compactionByName = new Map(compaction.config.map((entry) => [entry.name, entry]));
    assert.ok(compactionByName.has('@deepseek-ai/dsh-compaction-basic'));
    assert.ok(compactionByName.has('@deepseek-ai/dsh-command-compact'));
    const pruner = compactionByName.get('@deepseek-ai/dsh-compaction-tool-result-pruner');
    assert.ok(pruner);
    assert.equal(pruner.config?.thresholdChars, 8192);

    // 4. 顶层覆盖必须精确禁用 dsh-base 真实存在的全部 8 个编码/终端/计划宿主行（避免主会话泄露全局写工具）
    const overrideRows = parsed.filter((item) => !Array.isArray(item?.insert));
    const expectedDisabledHostIds = [
        'tool-bash',
        'tool-pwsh',
        'tool-fs',
        'tool-fs-search',
        'tool-jobs',
        'tool-todo',
        'tool-goal',
        'plan-mode'
    ];
    assert.deepEqual(
        overrideRows.map((row) => ({ id: row.id, disabled: row.disabled })),
        expectedDisabledHostIds.map((id) => ({ id, disabled: true })),
        '顶层禁用行应精确覆盖 dsh-base 真实存在的全部 8 个编码/终端向宿主行'
    );
});

test('与真实 dsh-base + dsh-web-app 组合零告警，且 AgentPresetRegistry 实装零 root-realm 泄露并暴露宿主 UI', async () => {
    const { composeEntries, loadOverlayPatches } = await importFromRoot('@deepseek-ai/dsh-app-boot');
    const { Context } = await importFromRoot('@deepseek-ai/cordis');
    const { default: Loader, Group } = await importFromRoot('@deepseek-ai/cordis-plugin-loader');
    const { default: SystemPrompt } = await importFromRoot('@deepseek-ai/dsh-system-prompt');

    const basePatchPath = rootRequire.resolve('@deepseek-ai/dsh-base/cordis.patch.yml');
    const webPatchPath = rootRequire.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml');
    const narratePatchPath = path.join(PRESET_ROOT, 'cordis.patch.yml');

    const basePatches = loadOverlayPatches('dsh', basePatchPath);
    const webPatches = loadOverlayPatches('dsh', webPatchPath);
    const narratePatches = loadOverlayPatches('dsh', narratePatchPath);

    // 1. 校验与 dsh-base + dsh-web-app 及纯 dsh-base 组合均零 patch 告警
    const webWarnings = [];
    const composedWithWeb = composeEntries([basePatches, webPatches, narratePatches], (msg) => webWarnings.push(msg));
    assert.deepEqual(webWarnings, [], '与 dsh-base + dsh-web-app 组合不应产生任何 patch 告警');

    const baseWarnings = [];
    const composedBaseOnly = composeEntries([basePatches, narratePatches], (msg) => baseWarnings.push(msg));
    assert.deepEqual(baseWarnings, [], '与纯 dsh-base 组合不应产生任何 patch 告警');

    for (const composed of [composedWithWeb, composedBaseOnly]) {
        const byId = new Map(composed.map((entry) => [entry.id, entry]));
        for (const hostCodingId of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-todo', 'tool-goal', 'plan-mode']) {
            assert.equal(byId.get(hostCodingId)?.disabled, true, `宿主行 ${hostCodingId} 必须保持 disabled: true`);
        }
        assert.ok(byId.get('narrateos-book-store'), '组合结果缺少 narrateos-book-store');
        assert.ok(byId.get('narrateos-client-ui-studio'), '组合结果缺少 narrateos-client-ui-studio');
        const presetEntry = byId.get('preset-narrateos');
        assert.ok(presetEntry, '组合结果缺少 preset-narrateos');

        const presetPlugins = presetEntry.config?.plugins ?? [];
        const mountedFs = presetPlugins.find((p) => p.id === 'tool-fs');
        const mountedFsSearch = presetPlugins.find((p) => p.id === 'tool-fs-search');
        assert.deepEqual(mountedFs?.config, {
            read: true,
            readImage: false,
            write: false,
            edit: false,
            applyPatch: false
        });
        assert.deepEqual(mountedFsSearch?.config, {
            sampleOverCapGlobResults: false
        });
    }

    // 2. 在真实 Cordis + Loader + AgentPresetRegistry 中挂载全套 4 个核心插件，验证 leakedServices 为 []、宿主入口可发现且仅注册只读文件工具
    const ctx = new Context();
    ctx.baseUrl = pathToFileURL(path.join(REPO_ROOT, 'package.json')).href;
    await ctx.plugin(Loader);
    ctx.loader.builtins.group = Group;
    ctx.loader.internal = {
        async import(specifier) {
            if (specifier === '@narrateos/dsh-book-store') {
                return await import(pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-book-store/dist/index.js')).href);
            }
            if (specifier === '@narrateos/dsh-book-tools') {
                return await import(pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-book-tools/dist/index.js')).href);
            }
            if (specifier === '@narrateos/dsh-pipeline') {
                return await import(pathToFileURL(path.join(REPO_ROOT, 'packages/dsh-pipeline/dist/index.js')).href);
            }
            if (specifier === '@narrateos/dsh-client-ui-studio') {
                const studioDistPath = path.join(REPO_ROOT, 'packages/dsh-client-ui-studio/dist/index.js');
                return await import(pathToFileURL(studioDistPath).href);
            }
            return await importFromRoot(specifier);
        }
    };

    const registeredToolNames = [];
    ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) });
    ctx.provide('agents', { turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: 0 }) });
    ctx.provide('tools', {
        register: (def) => {
            if (def?.name) registeredToolNames.push(def.name);
            return () => {};
        },
        get: () => undefined,
        guard: () => () => {}
    });
    ctx.provide('skills', {
        get: async () => undefined,
        register: () => () => {},
        registerProvider: () => () => {}
    });
    ctx.provide('web', { registerSearchProvider: () => {}, registerFetchProvider: () => {} });
    ctx.provide('userQuestions', { ask: async () => ({}) });
    ctx.provide('commands', { register: () => () => {} });
    ctx.provide('tokenMeter', { register: () => () => {}, measure: () => 0, estimateChars: () => 0 });
    ctx.provide('workingDirectory', { resolve: (p) => p, ensure: async () => REPO_ROOT, cwd: REPO_ROOT });
    ctx.provide('fs', {
        resolve: async (p) => ({ displayPath: p, targetKey: p }),
        stat: async () => undefined,
        readText: async () => '',
        streamText: async function* () {},
        processPath: (target) => target.displayPath
    });
    ctx.provide('subprocess', {
        resolveExecutable: async (command) => command,
        terminalEnvironment: async () => ({ platform: process.platform, shell: '/bin/sh' }),
        spawn: () => ({
            done: Promise.resolve({ exitCode: 1, signal: null }),
            collected: {},
            terminate: () => {},
            waitForExit: async () => ({ exitCode: 1, signal: null })
        })
    });
    ctx.provide('llm', {});
    ctx.provide('sessions', {});
    await ctx.plugin(SystemPrompt);

    try {
        // 挂载完整宿主与预设行（包含全部 4 个核心插件）
        const insertRows = narratePatches[0].insert;
        // 使用 web-app 自带的注册表时，不应实例化第二个注册表或修改宿主默认模式。
        const webRegistry = composedWithWeb.find(row => row.id === 'agent-preset-registry');
        await ctx.loader.root.update([webRegistry, insertRows.find(row => row.id === 'narrateos-headless-registry')]);
        await ctx.loader.await();
        assert.equal(ctx.loader.resolve('narrateos-headless-registry').disabled, true);
        assert.equal(webRegistry.config.default, 'standard');
        await ctx.loader.root.update([]);
        await ctx.loader.await();
        await ctx.loader.root.update(insertRows);
        await ctx.loader.await();

        const hostEntries = [...ctx.loader.entries()];
        const studioEntry = hostEntries.find((entry) => entry.id === 'narrateos-client-ui-studio');
        assert.ok(studioEntry, 'Host ctx.loader.entries() 必须包含 narrateos-client-ui-studio');
        assert.equal(studioEntry.options.name, '@narrateos/dsh-client-ui-studio');

        const storeEntry = hostEntries.find((entry) => entry.id === 'narrateos-book-store');
        assert.ok(storeEntry, 'Host ctx.loader.entries() 必须包含 narrateos-book-store');
        assert.equal(ctx.get('narrateStore')?.booksRoot, path.resolve('./books'));

        const toolsEntry = hostEntries.find((entry) => entry.id === 'narrateos-book-tools');
        assert.ok(toolsEntry, 'Host ctx.loader.entries() 必须包含 narrateos-book-tools');
        assert.ok(ctx.get('narrateTools'), 'Host ctx.get("narrateTools") 必须已注册');

        const pipelineEntry = hostEntries.find((entry) => entry.id === 'narrateos-pipeline');
        assert.ok(pipelineEntry, 'Host ctx.loader.entries() 必须包含 narrateos-pipeline');
        assert.ok(ctx.get('narratePipeline'), 'Host ctx.get("narratePipeline") 必须已注册');

        const compositions = ctx.agentPresets.inspectCompositions();
        assert.equal(compositions.length, 1);
        assert.equal(compositions[0].id, 'narrateos');
        assert.deepEqual(compositions[0].leakedServices, [], 'preset-narrateos 不得向根作用域泄露任何服务');

        const roster = await ctx.agentPresets.list();
        const narrateosRow = roster.find((item) => item.id === 'narrateos');
        assert.ok(narrateosRow, 'agentPresets.list() 应包含 narrateos');
        assert.equal(narrateosRow.broken, undefined, `preset-narrateos 不应存在诊断异常: ${narrateosRow.broken}`);

        for (const expectedReadOnlyTool of ['read', 'glob', 'grep', 'lock_charter_and_boot']) {
            assert.ok(
                registeredToolNames.includes(expectedReadOnlyTool),
                `preset-narrateos 必须挂载工具 ${expectedReadOnlyTool}，实际已注册: ${registeredToolNames.join(', ')}`
            );
        }
        for (const forbiddenWriteTool of ['write', 'edit', 'apply_patch', 'read_image']) {
            assert.ok(
                !registeredToolNames.includes(forbiddenWriteTool),
                `preset-narrateos 禁止注册写/图像工具 ${forbiddenWriteTool}`
            );
        }
    } finally {
        await ctx.fiber.dispose();
    }
});

test('全部 8 个外部化角色 YAML 与正向/受控系统提示词校验通过', () => {
    const rolesDir = path.join(PRESET_ROOT, 'roles');
    const expectedRoles = {
        'boot-compiler': { pool: 'strong_creative', reasoningEffort: 'high', cleanroom: false, yieldTool: 'yield_boot_bundle', tools: [] },
        librarian: { pool: 'fast_retrieval', reasoningEffort: 'low', cleanroom: false, yieldTool: 'yield_context_pack', tools: ['book_glob', 'book_grep', 'book_read'] },
        planner: { pool: 'strong_creative', reasoningEffort: 'medium', cleanroom: false, yieldTool: 'yield_outline', tools: ['book_read', 'book_grep'] },
        writer: { pool: 'strong_creative', reasoningEffort: 'medium', cleanroom: true, yieldTool: null, tools: [], maxSteps: 1, maxReadCalls: 0 },
        patch: { pool: 'strong_creative', reasoningEffort: 'low', cleanroom: false, yieldTool: 'yield_patched_draft', tools: ['patch_paragraphs'], maxSteps: 8, maxReadCalls: 0 },
        'fact-checker': { pool: 'strong_creative', reasoningEffort: 'medium', cleanroom: false, yieldTool: 'yield_verdict', tools: ['book_read', 'book_grep'] },
        extractor: { pool: 'fast_retrieval', reasoningEffort: 'low', cleanroom: false, yieldTool: 'yield_state_patch', tools: ['book_read', 'book_grep'] },
        dreamer: { pool: 'strong_creative', reasoningEffort: 'high', cleanroom: false, yieldTool: 'yield_dream_commit', tools: ['book_read', 'book_grep', 'book_glob', 'book_edit'] }
    };

    for (const [roleId, expected] of Object.entries(expectedRoles)) {
        const ymlPath = path.join(rolesDir, `${roleId}.yml`);
        assert.ok(fs.existsSync(ymlPath), `缺少角色配置文件 ${ymlPath}`);
        const cfg = YAML.parse(fs.readFileSync(ymlPath, 'utf8'));

        assert.equal(cfg.id, roleId);
        assert.equal(cfg.pool, expected.pool);
        assert.equal(cfg.cleanroom, expected.cleanroom);
        assert.equal(typeof cfg.promptFile, 'string');
        assert.equal(typeof cfg.temperature, 'number');
        assert.ok(['off', 'low', 'medium', 'high', 'max'].includes(cfg.reasoningEffort));
        assert.equal(cfg.reasoningEffort, expected.reasoningEffort, `角色 ${roleId} 的 reasoningEffort 应为 ${expected.reasoningEffort}`);
        assert.ok(Number.isInteger(cfg.maxSteps) && cfg.maxSteps >= 1);
        if (expected.maxSteps !== undefined) {
            assert.equal(cfg.maxSteps, expected.maxSteps, `角色 ${roleId} 的 maxSteps 应为 ${expected.maxSteps}`);
        }
        assert.ok(Number.isInteger(cfg.maxReadCalls) && cfg.maxReadCalls >= 0);
        if (expected.maxReadCalls !== undefined) {
            assert.equal(cfg.maxReadCalls, expected.maxReadCalls, `角色 ${roleId} 的 maxReadCalls 应为 ${expected.maxReadCalls}`);
        }
        assert.deepEqual(cfg.tools, expected.tools);
        assert.equal(cfg.yieldTool, expected.yieldTool);

        if (roleId === 'librarian' || roleId === 'extractor') {
            assert.deepEqual(
                cfg.blockedReadPaths,
                ['world/author_charter.md', 'world/arc_director_plan.md'],
                `${roleId}.yml 必须声明 blockedReadPaths 物理屏蔽全知契约与导演底牌`
            );
        }
        if (roleId === 'dreamer') {
            assert.deepEqual(
                cfg.allowedOpsRead,
                ['.ops/voice_samples.yaml', '.ops/signals.jsonl', '.ops/telemetry.jsonl'],
                'dreamer.yml 仅允许只读访问 voice_samples.yaml / signals.jsonl / telemetry.jsonl'
            );
            assert.deepEqual(
                cfg.allowedOpsWrite,
                ['.ops/voice_samples.yaml'],
                'dreamer.yml 严禁包含 .ops/signals.jsonl 写权限'
            );
        }

        const promptPath = path.resolve(rolesDir, cfg.promptFile);
        assert.ok(fs.existsSync(promptPath), `角色 ${roleId} 引用的提示词文件不存在: ${promptPath}`);
        const promptText = fs.readFileSync(promptPath, 'utf8').trim();
        assert.ok(promptText.length > 100, `角色 ${roleId} 提示词过短或为空`);
    }

    // 额外校验写手与局部修补净室正向表达约束（零否定禁令词、零粉红大象反噬样例）
    for (const promptRel of ['prompts/writer.md', 'prompts/patch.md']) {
        const cleanroomPrompt = fs.readFileSync(path.join(rolesDir, promptRel), 'utf8');
        const forbiddenWriterTokens = [
            '禁止', '严禁', '不要', '不得', '切忌',
            '必须', '务必', '千万', '绝对', '哪怕', '就算', '即便',
            '指节', '喉结', '瞳孔', '睫毛', '一丝', '一抹'
        ];
        for (const token of forbiddenWriterTokens) {
            assert.ok(!cleanroomPrompt.includes(token), `${promptRel} 提示词不应包含否定禁令或反噬套词 "${token}"`);
        }
    }

    // 校验 Ch.2 修复相关的提示词契约锚点
    const writerPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/writer.md'), 'utf8');
    assert.ok(writerPrompt.includes('# 标题名称'), 'writer.md 必须正向说明正文首行输出 `# 标题名称` 一级标题');
    assert.ok(!writerPrompt.includes('局部定点修补') && !writerPrompt.includes('Patch'), 'writer.md 不应残留局部定点修补（Patch）模式章节');

    const patchPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/patch.md'), 'utf8');
    for (const marker of ['# ', '0-based', 'patch_paragraphs', 'StaticProseGate', 'yield_patched_draft']) {
        assert.ok(patchPrompt.includes(marker), `patch.md 缺少关键正向契约锚点: ${marker}`);
    }

    const librarianPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/librarian.md'), 'utf8');
    for (const marker of [
        '已由管线预注入',
        'world_state.md',
        'L1_volumes.md',
        'L2_cards',
        'open_threads.md',
        'last_seen_ch',
        'book_read({ paths:',
        'lore_library/lore_xxx.md',
        'maxReadCalls',
        'world/arc_director_plan.md',
        'world/author_charter.md',
        'world/current_arc_envelope.md',
        'world/future_horizon.md',
        'manuscripts/',
        'book_grep',
        'recall_queries',
        'wakeup_entity_ids',
        '首次登场'
    ]) {
        assert.ok(librarianPrompt.includes(marker), `librarian.md 缺少关键契约锚点: ${marker}`);
    }
    assert.ok(!librarianPrompt.includes('"lore_xxx.md"'), 'librarian.md 示例路径必须补全 lore_library/ 前缀，避免触发 PathFence 拦截');
    for (const forbiddenNegative of ['不得读取', '不整章', '不在选页职责范围内']) {
        assert.ok(!librarianPrompt.includes(forbiddenNegative), `librarian.md 应保持纯粹正向陈述，不应包含 "${forbiddenNegative}"`);
    }

    const factCheckerPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/fact-checker.md'), 'utf8');
    for (const marker of [
        '已由管线预注入',
        'manuscripts/ch_0001.md',
        '1-6 个自然段',
        '<= 35%',
        '7+ 段',
        '> 35%',
        'quote_draft',
        'source_ref',
        'quote_source'
    ]) {
        assert.ok(factCheckerPrompt.includes(marker), `fact-checker.md 缺少关键契约锚点: ${marker}`);
    }

    const plannerPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/planner.md'), 'utf8');
    for (const marker of ['实体档案摘要', '上章上下文', '点查']) {
        assert.ok(plannerPrompt.includes(marker), `planner.md 缺少预注入与点查边界锚点: ${marker}`);
    }

    const extractorPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/extractor.md'), 'utf8');
    for (const marker of [
        '已由管线预注入',
        'open_threads.md',
        'buffer_ops',
        'upsert_slot',
        'trim_buffer',
        'max_entries',
        'acquired_state_ops',
        'upsert_ledger',
        'trajectory_ops',
        'entry',
        'yield_state_patch',
        'plot_summary',
        'prose_anchors',
        'appeared_entity_ids',
        'OMNISCIENT_SECRET',
        'READER_KNOWN',
        'slot_key'
    ]) {
        assert.ok(extractorPrompt.includes(marker), `extractor.md 缺少关键契约锚点: ${marker}`);
    }

    const jsonMatch = /```json\r?\n([\s\S]*?)\r?\n```/.exec(extractorPrompt);
    assert.ok(jsonMatch, 'extractor.md 必须包含 JSON 示例块');
    const examplePayload = JSON.parse(jsonMatch[1]);
    assert.equal(typeof examplePayload.plot_summary, 'string');
    assert.ok(Array.isArray(examplePayload.prose_anchors));
    assert.ok(Array.isArray(examplePayload.appeared_entity_ids));
    assert.ok(Array.isArray(examplePayload.entity_patches) && examplePayload.entity_patches.length >= 1);
    const firstPatch = examplePayload.entity_patches[0];
    assert.ok(Array.isArray(firstPatch.acquired_state_ops) && firstPatch.acquired_state_ops.some((op) => op.op === 'upsert_slot'));
    assert.ok(Array.isArray(firstPatch.trajectory_ops) && firstPatch.trajectory_ops.some((op) => op.op === 'append'));
    assert.ok(Array.isArray(firstPatch.buffer_ops) && firstPatch.buffer_ops.some((op) => op.op === 'upsert_slot') && firstPatch.buffer_ops.some((op) => op.op === 'trim_buffer'));

    const dreamerPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/dreamer.md'), 'utf8');
    for (const marker of [
        'advanceVolume',
        'world/current_arc_envelope.md',
        'prose_anchors',
        'Archived WARPED',
        'world/future_horizon.md',
        '.ops/signals.jsonl',
        'spotlight_triggers'
    ]) {
        assert.ok(dreamerPrompt.includes(marker), `dreamer.md 缺少关键契约锚点: ${marker}`);
    }

    const bootPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/boot-compiler.md'), 'utf8');
    for (const marker of [
        'author_sample',
        'boot_seed',
        '15-45',
        'OMNISCIENT_SECRET',
        'slotKey',
        'innateLocks',
        'acquiredState'
    ]) {
        assert.ok(bootPrompt.includes(marker), `boot-compiler.md 缺少关键契约锚点: ${marker}`);
    }

    const readmeText = fs.readFileSync(path.join(PRESET_ROOT, 'README.md'), 'utf8');
    assert.ok(readmeText.includes('8 大工种') && readmeText.includes('patch.yml'), 'README.md 必须更新为 8 大工种并列出 patch.yml');
});

test('narrate-boot Skill 满足 < 8,192 字符预算并附带完整 references', () => {
    const skillDir = path.join(PRESET_ROOT, 'skills/narrate-boot');
    const skillPath = path.join(skillDir, 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), '缺少 skills/narrate-boot/SKILL.md');

    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(
        content.length < 8192,
        `SKILL.md 字符数 (${content.length}) 必须严格小于 8192（tool-result-pruner 阈值）`
    );

    const frontmatter = parseFrontmatter(content);
    assert.equal(frontmatter.name, 'narrate-boot');
    assert.equal(typeof frontmatter.description, 'string');
    assert.ok(frontmatter.description.trim().length > 10);
    assert.ok(!frontmatter.description.includes('->'), 'SKILL.md description 不得包含流程箭头摘要');
    for (const csoKeyword of ['T0', 'Canon Delta', 'SAFE_HALT', 'Stage Ceiling']) {
        assert.ok(frontmatter.description.includes(csoKeyword), `SKILL.md description 缺少 CSO 触发关键词: ${csoKeyword}`);
    }

    for (const marker of [
        'web_search',
        'ask_user_question',
        'lock_charter_and_boot',
        'T0',
        'Voice Harvest',
        'OPEN_HORIZON',
        'Local Closure',
        'Canon Delta',
        'When NOT to Use',
        'Red Flags',
        'StaticProseGate',
        'entityId',
        'camelCase',
        'snake_case',
        'fanfic-canon-delta.md',
        'hybrid_rolling',
        'boot_seed',
        'chapter_harvest',
        'switchConflictReason'
    ]) {
        assert.ok(content.includes(marker), `SKILL.md 缺少关键流程锚点: ${marker}`);
    }

    for (const refFile of ['charter-and-beats.md', 't0-causality-checklist.md', 'replan-protocol.md', 'fanfic-canon-delta.md']) {
        const refPath = path.join(skillDir, 'references', refFile);
        assert.ok(fs.existsSync(refPath), `缺少参考文档 ${refFile}`);
        const refText = fs.readFileSync(refPath, 'utf8').trim();
        assert.ok(refText.length > 200, `参考文档 ${refFile} 内容过短`);
        if (refFile === 'fanfic-canon-delta.md') {
            assert.ok(refText.length < 2500, `同人参考文档 ${refFile} 长度 (${refText.length}) 应控制在 2500 字符以内`);
        }
    }
});

test('全部交付文件零 U+2011 字符且零 TODO/FIXME 占位符', () => {
    const allFiles = collectFilesRecursively(PRESET_ROOT);
    assert.ok(allFiles.length >= 20, '预设包应包含完整配置文件与提示词集合');

    const thisTestFile = path.resolve(__filename);
    for (const filePath of allFiles) {
        const text = fs.readFileSync(filePath, 'utf8');
        assert.ok(!text.includes('\u2011'), `检测到非法 U+2011 不换行连字符: ${path.relative(PRESET_ROOT, filePath)}`);
        if (path.resolve(filePath) !== thisTestFile) {
            assert.ok(!/\b(TODO|FIXME)\b/.test(text), `检测到未清理占位符: ${path.relative(PRESET_ROOT, filePath)}`);
        }
    }
});

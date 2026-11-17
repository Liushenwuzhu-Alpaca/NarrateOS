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

const JS_CUSTOM_TAGS = [
    {
        tag: 'tag:yaml.org,2002:js',
        resolve(str) {
            return { __js: str };
        }
    }
];

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

test('cordis.patch.yml 仅注册单一 NarrateOS 创作模式并禁用编码向冗余工具', () => {
    const patchPath = path.join(PRESET_ROOT, 'cordis.patch.yml');
    const raw = fs.readFileSync(patchPath, 'utf8');
    const parsed = YAML.parse(raw, { customTags: JS_CUSTOM_TAGS });

    assert.ok(Array.isArray(parsed) && parsed.length === 1, 'cordis.patch.yml 应包含单条顶层 patch');
    const insertRows = parsed[0]?.insert;
    assert.ok(Array.isArray(insertRows), '顶层 patch 应为 insert 列表');

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

    const plugins = preset.config?.plugins;
    assert.ok(Array.isArray(plugins), 'preset.config.plugins 必须为数组');

    const byName = new Map(plugins.map((entry) => [entry.name, entry]));

    const persona = byName.get('@deepseek-ai/dsh-persona');
    assert.ok(persona && persona.disabled !== true, '必须挂载 @deepseek-ai/dsh-persona');
    assert.equal(persona.config?.complete, true);
    assert.equal(persona.config?.includeRuntimeContext, false);
    assert.ok(typeof persona.config?.prefix === 'string' && persona.config.prefix.includes('{{model}}'));

    const web = byName.get('@deepseek-ai/dsh-tool-web');
    assert.ok(web && web.disabled !== true, '必须挂载 @deepseek-ai/dsh-tool-web');
    assert.equal(web.config?.fetch, true);
    assert.equal(web.config?.searchTimeoutMs, 60000);

    for (const requiredPlugin of [
        '@deepseek-ai/dsh-tool-ask-user',
        '@deepseek-ai/dsh-skill-filesystem',
        '@deepseek-ai/dsh-tool-skill',
        '@narrateos/dsh-book-store',
        '@narrateos/dsh-book-tools',
        '@narrateos/dsh-pipeline',
        '@narrateos/dsh-client-ui-studio'
    ]) {
        const entry = byName.get(requiredPlugin);
        assert.ok(entry && entry.disabled !== true, `必须启用 ${requiredPlugin}`);
    }

    const skillFs = byName.get('@deepseek-ai/dsh-skill-filesystem');
    assert.ok(Array.isArray(skillFs.config?.customSkillDirs) && skillFs.config.customSkillDirs.length > 0);
    const patchBaseUrl = pathToFileURL(patchPath).href;
    const skillDirExpr = skillFs.config.customSkillDirs[0]?.__js;
    assert.equal(typeof skillDirExpr, 'string', 'customSkillDirs[0] 应使用 !!js 动态解析包内 skills 目录');
    const resolvedSkillsDir = new Function('baseUrl', `return (${skillDirExpr});`)(patchBaseUrl);
    assert.equal(resolvedSkillsDir, path.join(PRESET_ROOT, 'skills'));

    const compaction = plugins.find((entry) => entry.id === 'compaction' && entry.group === true);
    assert.ok(compaction && Array.isArray(compaction.config), '必须包含 compaction 隔离组');
    const compactionByName = new Map(compaction.config.map((entry) => [entry.name, entry]));
    assert.ok(compactionByName.has('@deepseek-ai/dsh-compaction-basic'));
    assert.ok(compactionByName.has('@deepseek-ai/dsh-command-compact'));
    const pruner = compactionByName.get('@deepseek-ai/dsh-compaction-tool-result-pruner');
    assert.ok(pruner);
    assert.equal(pruner.config?.thresholdChars, 8192);

    const pipeline = byName.get('@narrateos/dsh-pipeline');
    assert.equal(pipeline.config?.booksRoot, './books');
    assert.equal(typeof pipeline.config?.presetRoot?.__js, 'string', 'dsh-pipeline 必须通过 !!js 解析 presetRoot');
    const resolvedPresetRoot = new Function('baseUrl', `return (${pipeline.config.presetRoot.__js});`)(patchBaseUrl);
    assert.equal(resolvedPresetRoot, PRESET_ROOT);
    for (const pool of ['strong_creative', 'fast_retrieval', 'audit']) {
        assert.ok(pipeline.config?.poolRouting?.[pool]?.provider, `缺少 poolRouting.${pool}.provider`);
        assert.ok(pipeline.config?.poolRouting?.[pool]?.model, `缺少 poolRouting.${pool}.model`);
    }

    const codingPluginsToDisable = [
        '@deepseek-ai/dsh-tool-bash',
        '@deepseek-ai/dsh-tool-pwsh',
        '@deepseek-ai/dsh-tool-fs',
        '@deepseek-ai/dsh-tool-fs-search',
        '@deepseek-ai/dsh-tool-str-replace-editor',
        '@deepseek-ai/dsh-tool-todo',
        '@deepseek-ai/dsh-tool-goal',
        '@deepseek-ai/dsh-tool-jobs',
        '@deepseek-ai/dsh-tool-schedule',
        '@deepseek-ai/dsh-plan-mode',
        '@deepseek-ai/dsh-tool-ralph'
    ];
    for (const codingPlugin of codingPluginsToDisable) {
        const entry = byName.get(codingPlugin);
        assert.ok(entry, `应在预设中显式声明禁用 ${codingPlugin}`);
        assert.equal(entry.disabled, true, `${codingPlugin} 必须显式设置 disabled: true`);
    }
});

test('全部 7 个外部化角色 YAML 与正向/受控系统提示词校验通过', () => {
    const rolesDir = path.join(PRESET_ROOT, 'roles');
    const expectedRoles = {
        'boot-compiler': { pool: 'strong_creative', cleanroom: false, yieldTool: 'yield_boot_bundle', tools: [] },
        librarian: { pool: 'fast_retrieval', cleanroom: false, yieldTool: 'yield_context_pack', tools: ['book_glob', 'book_grep', 'book_read'] },
        planner: { pool: 'strong_creative', cleanroom: false, yieldTool: 'yield_outline', tools: ['book_read', 'book_grep'] },
        writer: { pool: 'strong_creative', cleanroom: true, yieldTool: null, tools: [] },
        'fact-checker': { pool: 'audit', cleanroom: false, yieldTool: 'yield_verdict', tools: ['book_read', 'book_grep'] },
        extractor: { pool: 'fast_retrieval', cleanroom: false, yieldTool: 'yield_state_patch', tools: ['book_read', 'book_grep'] },
        dreamer: { pool: 'strong_creative', cleanroom: false, yieldTool: 'yield_dream_commit', tools: ['book_read', 'book_grep', 'book_glob', 'book_edit'] }
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
        assert.ok(['low', 'medium', 'high'].includes(cfg.reasoningEffort));
        assert.ok(Number.isInteger(cfg.maxSteps) && cfg.maxSteps >= 1);
        assert.ok(Number.isInteger(cfg.maxReadCalls) && cfg.maxReadCalls >= 0);
        assert.deepEqual(cfg.tools, expected.tools);
        assert.equal(cfg.yieldTool, expected.yieldTool);

        const promptPath = path.resolve(rolesDir, cfg.promptFile);
        assert.ok(fs.existsSync(promptPath), `角色 ${roleId} 引用的提示词文件不存在: ${promptPath}`);
        const promptText = fs.readFileSync(promptPath, 'utf8').trim();
        assert.ok(promptText.length > 100, `角色 ${roleId} 提示词过短或为空`);
    }

    // 额外校验写手净室正向表达约束（零否定禁令词、零粉红大象反噬样例）
    const writerPrompt = fs.readFileSync(path.join(rolesDir, 'prompts/writer.md'), 'utf8');
    const forbiddenWriterTokens = ['禁止', '严禁', '不要', '不得', '切忌', '指节', '喉结', '瞳孔', '睫毛', '一丝', '一抹'];
    for (const token of forbiddenWriterTokens) {
        assert.ok(!writerPrompt.includes(token), `写手提示词不应包含否定禁令或反噬套词 "${token}"`);
    }
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

    for (const marker of ['web_search', 'ask_user_question', 'lock_charter_and_boot', 'T0', 'Voice Harvest', 'OPEN_HORIZON', 'Local Closure', 'Canon Delta']) {
        assert.ok(content.includes(marker), `SKILL.md 缺少关键流程锚点: ${marker}`);
    }

    for (const refFile of ['charter-and-beats.md', 't0-causality-checklist.md', 'replan-protocol.md']) {
        const refPath = path.join(skillDir, 'references', refFile);
        assert.ok(fs.existsSync(refPath), `缺少参考文档 ${refFile}`);
        assert.ok(fs.readFileSync(refPath, 'utf8').trim().length > 200, `参考文档 ${refFile} 内容过短`);
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

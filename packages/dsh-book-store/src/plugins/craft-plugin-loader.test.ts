import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StaticProseGate } from '../gate/static-prose-gate.js';
import {
    CraftPluginLoader,
    CraftPluginConflictError,
    CraftPluginLoadError,
    CraftPluginNotFoundError
} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REPO_CRAFT_PLUGINS_DIR = path.join(REPO_ROOT, 'plugins', 'craft');

describe('CraftPluginLoader', () => {
    let tmpDir: string;
    let repoPluginDir: string;
    let bookPluginDir: string;
    let loader: CraftPluginLoader;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narrateos-plugins-test-'));
        repoPluginDir = path.join(tmpDir, 'repo-plugins');
        bookPluginDir = path.join(tmpDir, 'book-root', 'plugins', 'craft');
        await fs.mkdir(repoPluginDir, { recursive: true });
        await fs.mkdir(bookPluginDir, { recursive: true });
        loader = new CraftPluginLoader();
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('支持加载 .yaml / .yml / .json 插件并忽略无关文件', async () => {
        await fs.writeFile(
            path.join(repoPluginDir, 'alpha.yaml'),
            [
                'id: alpha-craft',
                'name: 感官锚定',
                'version: "1.0.0"',
                'description: 强化感官细节',
                'applicable_roles:',
                '  - writer',
                'prompt_injection: |',
                '  以具体光影、温度与声响锚定当下情绪。',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await fs.writeFile(
            path.join(repoPluginDir, 'beta.yml'),
            [
                'id: beta-craft',
                'name: 潜台词调度',
                'version: "1.0.0"',
                'description: 对话潜台词',
                'applicable_roles:',
                '  - planner',
                '  - writer',
                'prompt_injection: 对话围绕未尽意图推进。',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await fs.writeFile(
            path.join(repoPluginDir, 'gamma.json'),
            JSON.stringify(
                {
                    id: 'gamma-craft',
                    name: '事实核查增强',
                    version: '1.0.0',
                    description: '核查器物因果',
                    applicable_roles: ['fact_checker'],
                    prompt_injection: '核查器物在场状态与时间因果。',
                    enabled: true
                },
                null,
                4
            ),
            'utf-8'
        );

        await fs.writeFile(path.join(repoPluginDir, 'README.md'), '# ignore me', 'utf-8');

        const catalog = await loader.loadAll([repoPluginDir, path.join(tmpDir, 'non-existent-dir')]);
        expect(catalog.size).toBe(3);
        expect(catalog.get('alpha-craft')?.plugin.name).toBe('感官锚定');
        expect(catalog.get('beta-craft')?.plugin.applicable_roles).toEqual(['planner', 'writer']);
        expect(catalog.get('gamma-craft')?.plugin.applicable_roles).toEqual(['fact_checker']);
    });

    it('按 book_config.yaml 的 craft_plugins 白名单有序加载并过滤未启用项', async () => {
        await fs.writeFile(
            path.join(repoPluginDir, 'p1.yaml'),
            [
                'id: plugin-one',
                'name: 插件一',
                'version: "1.0.0"',
                'description: 描述一',
                'applicable_roles: [writer]',
                'prompt_injection: 引导块一',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await fs.writeFile(
            path.join(repoPluginDir, 'p2.yaml'),
            [
                'id: plugin-two',
                'name: 插件二',
                'version: "1.0.0"',
                'description: 描述二',
                'applicable_roles: [planner, writer]',
                'prompt_injection: 引导块二',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await fs.writeFile(
            path.join(repoPluginDir, 'p3.yaml'),
            [
                'id: plugin-disabled',
                'name: 已禁用插件',
                'version: "1.0.0"',
                'description: 禁用项',
                'applicable_roles: [writer]',
                'prompt_injection: 不应被激活',
                'enabled: false'
            ].join('\n'),
            'utf-8'
        );

        await fs.writeFile(
            path.join(repoPluginDir, 'p4.yaml'),
            [
                'id: plugin-unused',
                'name: 未挂载插件',
                'version: "1.0.0"',
                'description: 不在白名单中',
                'applicable_roles: [writer]',
                'prompt_injection: 不在白名单中',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        // 白名单顺序：plugin-two 在前，plugin-one 在后
        const loaded = await loader.loadForBook({
            searchDirs: [repoPluginDir],
            enabledPluginIds: ['plugin-two', 'plugin-one', 'plugin-disabled']
        });

        expect(loaded.map((p) => p.plugin.id)).toEqual(['plugin-two', 'plugin-one']);

        const empty = await loader.loadForBook({
            searchDirs: [repoPluginDir],
            enabledPluginIds: []
        });
        expect(empty).toEqual([]);
    });

    it('enabledPluginIds 为空数组时零磁盘扫描直接返回空数组', async () => {
        await fs.writeFile(
            path.join(repoPluginDir, 'broken.yaml'),
            'id: [unclosed-broken-yaml',
            'utf-8'
        );

        const loaded = await loader.loadForBook({
            searchDirs: [repoPluginDir],
            enabledPluginIds: []
        });
        expect(loaded).toEqual([]);
    });

    it('缺失白名单插件时抛出 CraftPluginNotFoundError', async () => {
        await expect(
            loader.loadForBook({
                searchDirs: [repoPluginDir],
                enabledPluginIds: ['missing-plugin']
            })
        ).rejects.toThrow(CraftPluginNotFoundError);
    });

    it('存在重复插件 ID 时默认抛出 CraftPluginConflictError，支持 override 模式覆盖', async () => {
        await fs.writeFile(
            path.join(repoPluginDir, 'shared.yaml'),
            [
                'id: shared-plugin',
                'name: 全局版本',
                'version: "1.0.0"',
                'description: 全局',
                'applicable_roles: [writer]',
                'prompt_injection: 全局引导',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await fs.writeFile(
            path.join(bookPluginDir, 'shared-override.yaml'),
            [
                'id: shared-plugin',
                'name: 书籍局部版本',
                'version: "1.1.0"',
                'description: 局部覆盖',
                'applicable_roles: [writer]',
                'prompt_injection: 局部覆盖引导',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await expect(
            loader.loadForBook({
                searchDirs: [repoPluginDir, bookPluginDir],
                enabledPluginIds: ['shared-plugin']
            })
        ).rejects.toThrow(CraftPluginConflictError);

        const overridden = await loader.loadForBook({
            searchDirs: [repoPluginDir, bookPluginDir],
            enabledPluginIds: ['shared-plugin'],
            onConflict: 'override'
        });

        expect(overridden).toHaveLength(1);
        expect(overridden[0]?.plugin.name).toBe('书籍局部版本');
        expect(overridden[0]?.plugin.prompt_injection).toBe('局部覆盖引导');
    });

    it('插件 Schema 校验失败或正则非法时抛出 CraftPluginLoadError', async () => {
        await fs.writeFile(
            path.join(repoPluginDir, 'invalid-schema.yaml'),
            ['id: bad-plugin', 'name: 缺少字段'].join('\n'),
            'utf-8'
        );

        await expect(loader.loadAll([repoPluginDir])).rejects.toThrow(CraftPluginLoadError);

        await fs.rm(path.join(repoPluginDir, 'invalid-schema.yaml'));
        await fs.writeFile(
            path.join(repoPluginDir, 'invalid-regex.yaml'),
            [
                'id: bad-regex-plugin',
                'name: 非法正则',
                'version: "1.0.0"',
                'description: 测试非法正则',
                'applicable_roles: [writer]',
                'prompt_injection: 正向引导',
                'extra_gate_rules:',
                '  broken_rule:',
                '    enabled: true',
                '    patterns:',
                '      - "[unclosed("',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await expect(loader.loadAll([repoPluginDir])).rejects.toThrow(CraftPluginLoadError);
    });

    it('支持热加载：磁盘文件变更后再次加载立即生效', async () => {
        const pluginFile = path.join(repoPluginDir, 'hot.yaml');
        await fs.writeFile(
            pluginFile,
            [
                'id: hot-plugin',
                'name: 热加载测试',
                'version: "1.0.0"',
                'description: 初始版本',
                'applicable_roles: [writer]',
                'prompt_injection: 版本一引导',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        const first = await loader.loadForBook({
            searchDirs: [repoPluginDir],
            enabledPluginIds: ['hot-plugin']
        });
        expect(first[0]?.plugin.prompt_injection).toBe('版本一引导');

        await fs.writeFile(
            pluginFile,
            [
                'id: hot-plugin',
                'name: 热加载测试',
                'version: "1.0.1"',
                'description: 更新版本',
                'applicable_roles: [writer, planner]',
                'prompt_injection: 版本二引导',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        const second = await loader.loadForBook({
            searchDirs: [repoPluginDir],
            enabledPluginIds: ['hot-plugin']
        });
        expect(second[0]?.plugin.version).toBe('1.0.1');
        expect(second[0]?.plugin.prompt_injection).toBe('版本二引导');
        expect(second[0]?.plugin.applicable_roles).toEqual(['writer', 'planner']);
    });

    it('支持按角色过滤合并 prompt 块与 extra_gate_rules 并直接对接 StaticProseGate', async () => {
        await fs.writeFile(
            path.join(repoPluginDir, 'planner-only.yaml'),
            [
                'id: planner-only',
                'name: 规划插件',
                'version: "1.0.0"',
                'description: 仅规划使用',
                'applicable_roles: [planner]',
                'prompt_injection: 规划阶段：确立冲突与主次视角。',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        await fs.writeFile(
            path.join(repoPluginDir, 'writer-gate.yaml'),
            [
                'id: writer-gate',
                'name: 执笔门禁扩展',
                'version: "1.0.0"',
                'description: 扩展门禁规则',
                'applicable_roles: [writer]',
                'prompt_injection: 执笔阶段：用物理动作承担情绪变化。',
                'extra_gate_rules:',
                '  custom_abstract_mood:',
                '    enabled: true',
                '    max_count: 0',
                '    scale_by_length: false',
                '    patterns:',
                '      - pattern: "心头猛地一沉"',
                '        flags: "g"',
                '      - "/一阵莫名的悲伤/g"',
                'enabled: true'
            ].join('\n'),
            'utf-8'
        );

        const plugins = await loader.loadForBook({
            searchDirs: [repoPluginDir],
            enabledPluginIds: ['planner-only', 'writer-gate']
        });

        expect(loader.mergePromptInjection(plugins, 'planner')).toBe('规划阶段：确立冲突与主次视角。');
        expect(loader.mergePromptInjection(plugins, 'writer')).toBe('执笔阶段：用物理动作承担情绪变化。');
        expect(loader.mergePromptInjection(plugins, 'fact_checker')).toBe('');

        const gateRules = loader.mergeExtraGateRules(plugins, 'writer');
        expect(gateRules.custom_abstract_mood).toBeDefined();
        expect(gateRules.custom_abstract_mood?.patterns).toHaveLength(2);

        const gate = new StaticProseGate();
        const result = gate.evaluate('他推开木门，心头猛地一沉，望向院中的积雪。', {
            rules: gateRules
        });
        expect(result.passed).toBe(false);
        expect(result.exceededRules).toContain('custom_abstract_mood');
    });

    it('仓库默认模板目录 plugins/craft/ 下提供通用合规的默认插件（含迁出的规划期认知插件）', async () => {
        const catalog = await loader.loadAll([REPO_CRAFT_PLUGINS_DIR]);
        expect(catalog.has('sensory-grounding')).toBe(true);
        expect(catalog.has('dialogue-subtext')).toBe(true);
        expect(catalog.has('vad-bdi')).toBe(true);
        expect(catalog.has('dual-reaction')).toBe(true);
        expect(catalog.has('scene-act')).toBe(true);

        const loaded = await loader.loadForBook({
            searchDirs: [REPO_CRAFT_PLUGINS_DIR],
            enabledPluginIds: ['sensory-grounding', 'dialogue-subtext', 'vad-bdi', 'dual-reaction', 'scene-act']
        });
        expect(loaded).toHaveLength(5);

        const writerPrompt = loader.mergePromptInjection(loaded, 'writer');
        expect(writerPrompt.length).toBeGreaterThan(20);
        expect(writerPrompt).not.toContain('vad-bdi');
        expect(writerPrompt).not.toContain('dual-reaction');
        expect(writerPrompt).not.toContain('scene-act');

        const plannerPrompt = loader.mergePromptInjection(loaded, 'planner');
        expect(plannerPrompt).toContain('vad-bdi');
        expect(plannerPrompt).toContain('dual-reaction');
        expect(plannerPrompt).toContain('scene-act');

        // 确认遵循正向槽位表达（不包含纯否定禁令词如“禁止”“严禁”“不要”）
        expect(writerPrompt).not.toMatch(/禁止|严禁|不要|不得|切忌/);
        expect(plannerPrompt).not.toMatch(/禁止|严禁|不要|不得|切忌/);
    });
});

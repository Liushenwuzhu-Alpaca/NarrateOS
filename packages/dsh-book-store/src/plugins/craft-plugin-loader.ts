import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GateRuleConfig, GateRuleId } from '../gate/types.js';
import {
    CraftPluginSchema,
    type ExtraGateRuleDef,
    type ExtraGateRulePattern,
    type LoadForBookOptions,
    type LoadedCraftPlugin,
    type PluginConflictPolicy,
    type PluginRole
} from './schemas.js';

const SUPPORTED_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/** 插件解析或正则编译失败异常 */
export class CraftPluginLoadError extends Error {
    readonly filePath: string;

    constructor(filePath: string, message: string, cause?: unknown) {
        super(`加载插件失败 (${filePath}): ${message}`, cause !== undefined ? { cause } : undefined);
        this.name = 'CraftPluginLoadError';
        this.filePath = filePath;
    }
}

/** 白名单插件缺失异常 */
export class CraftPluginNotFoundError extends Error {
    readonly missingPluginIds: string[];

    constructor(missingPluginIds: string[]) {
        super(`未找到白名单指定的文风插件: ${missingPluginIds.join(', ')}`);
        this.name = 'CraftPluginNotFoundError';
        this.missingPluginIds = missingPluginIds;
    }
}

/** 插件 ID 重复冲突异常 */
export class CraftPluginConflictError extends Error {
    readonly pluginId: string;
    readonly existingPath: string;
    readonly conflictingPath: string;

    constructor(pluginId: string, existingPath: string, conflictingPath: string) {
        super(`检测到重复的文风插件 ID "${pluginId}": "${existingPath}" 与 "${conflictingPath}"`);
        this.name = 'CraftPluginConflictError';
        this.pluginId = pluginId;
        this.existingPath = existingPath;
        this.conflictingPath = conflictingPath;
    }
}

/** 将声明式正则条目编译为 RegExp */
function compilePatternEntry(entry: ExtraGateRulePattern, filePath: string, ruleId: string): RegExp {
    try {
        if (typeof entry === 'string') {
            const slashMatch = /^\/(.+)\/([gimsuvy]*)$/.exec(entry);
            if (slashMatch) {
                const source = slashMatch[1] ?? '';
                const flags = slashMatch[2] ?? '';
                return new RegExp(source, flags);
            }
            return new RegExp(entry, 'g');
        }
        return new RegExp(entry.pattern, entry.flags ?? 'g');
    } catch (error) {
        throw new CraftPluginLoadError(filePath, `规则 "${ruleId}" 的正则表达式无效`, error);
    }
}

/** 将声明式规则定义编译为 StaticProseGate 可直接消费的 GateRuleConfig */
function compileGateRules(
    extraRules: Record<string, ExtraGateRuleDef> | undefined,
    filePath: string
): Partial<Record<GateRuleId, GateRuleConfig>> {
    if (!extraRules) {
        return {};
    }

    const compiled: Partial<Record<GateRuleId, GateRuleConfig>> = {};
    for (const [ruleId, ruleDef] of Object.entries(extraRules)) {
        const config: GateRuleConfig = {
            enabled: ruleDef.enabled
        };

        if (ruleDef.max_count !== undefined) {
            config.maxCount = ruleDef.max_count;
        }
        if (ruleDef.scale_by_length !== undefined) {
            config.scaleByLength = ruleDef.scale_by_length;
        }
        if (ruleDef.reference_chars !== undefined) {
            config.referenceChars = ruleDef.reference_chars;
        }
        if (ruleDef.patterns !== undefined) {
            config.patterns = ruleDef.patterns.map((item) => compilePatternEntry(item, filePath, ruleId));
        }
        if (ruleDef.terms !== undefined) {
            config.terms = [...ruleDef.terms];
        }
        if (ruleDef.last_paragraphs_only !== undefined) {
            config.lastParagraphsOnly = ruleDef.last_paragraphs_only;
        }

        compiled[ruleId as GateRuleId] = config;
    }

    return compiled;
}

/** 外置文风插件热加载器 */
export class CraftPluginLoader {
    /**
     * 从单个目录加载所有声明式插件（.yaml / .yml / .json）。
     * 目录不存在时返回空数组，文件解析或校验失败则抛出 CraftPluginLoadError。
     */
    async loadFromDirectory(dirPath: string): Promise<LoadedCraftPlugin[]> {
        let entries: string[];
        try {
            entries = await fs.readdir(dirPath);
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code === 'ENOENT') {
                return [];
            }
            throw error;
        }

        const pluginFiles = entries
            .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
            .sort((a, b) => a.localeCompare(b));

        const results: LoadedCraftPlugin[] = [];
        for (const fileName of pluginFiles) {
            const fullPath = path.join(dirPath, fileName);
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) {
                continue;
            }
            results.push(await this.loadFile(fullPath));
        }
        return results;
    }

    /**
     * 从多个目录全量扫描加载插件，校验重复 ID 冲突。
     * 每次调用均直接读取磁盘以支持热加载。
     */
    async loadAll(
        searchDirs: string[],
        onConflict: PluginConflictPolicy = 'error'
    ): Promise<Map<string, LoadedCraftPlugin>> {
        const catalog = new Map<string, LoadedCraftPlugin>();

        for (const dirPath of searchDirs) {
            const loadedList = await this.loadFromDirectory(dirPath);
            for (const item of loadedList) {
                const existing = catalog.get(item.plugin.id);
                if (existing && onConflict === 'error') {
                    throw new CraftPluginConflictError(
                        item.plugin.id,
                        existing.sourcePath,
                        item.sourcePath
                    );
                }
                catalog.set(item.plugin.id, item);
            }
        }

        return catalog;
    }

    /**
     * 按 book_config.yaml 的 craft_plugins 白名单有序加载激活插件。
     * - 校验白名单中缺失的插件 ID 并抛出 CraftPluginNotFoundError
     * - 校验目录间的重复 ID 冲突（默认 error，可配 override）
     * - 过滤掉 enabled === false 的插件
     */
    async loadForBook(options: LoadForBookOptions): Promise<LoadedCraftPlugin[]> {
        if (options.enabledPluginIds.length === 0) {
            return [];
        }

        const catalog = await this.loadAll(options.searchDirs, options.onConflict ?? 'error');

        const missingIds: string[] = [];
        const seenIds = new Set<string>();
        const activePlugins: LoadedCraftPlugin[] = [];

        for (const pluginId of options.enabledPluginIds) {
            if (seenIds.has(pluginId)) {
                continue;
            }
            seenIds.add(pluginId);

            const loaded = catalog.get(pluginId);
            if (!loaded) {
                missingIds.push(pluginId);
                continue;
            }

            if (loaded.plugin.enabled) {
                activePlugins.push(loaded);
            }
        }

        if (missingIds.length > 0) {
            throw new CraftPluginNotFoundError(missingIds);
        }

        return activePlugins;
    }

    /** 按角色过滤并提取适用插件的 prompt_injection 列表（保持加载顺序） */
    getPromptInjections(plugins: LoadedCraftPlugin[], role: PluginRole): string[] {
        return plugins
            .filter((item) => item.plugin.enabled && item.plugin.applicable_roles.includes(role))
            .map((item) => item.plugin.prompt_injection.trim())
            .filter((text) => text.length > 0);
    }

    /** 按角色过滤并合并导出单个 prompt 注入块 */
    mergePromptInjection(plugins: LoadedCraftPlugin[], role: PluginRole, separator = '\n\n'): string {
        return this.getPromptInjections(plugins, role).join(separator);
    }

    /** 合并适用插件的额外静态门禁规则，可直接传入 StaticProseGateOptions.rules */
    mergeExtraGateRules(
        plugins: LoadedCraftPlugin[],
        role?: PluginRole
    ): Partial<Record<GateRuleId, GateRuleConfig>> {
        const merged: Partial<Record<GateRuleId, GateRuleConfig>> = {};

        for (const item of plugins) {
            if (!item.plugin.enabled) {
                continue;
            }
            if (role !== undefined && !item.plugin.applicable_roles.includes(role)) {
                continue;
            }
            for (const [ruleId, ruleConfig] of Object.entries(item.compiledGateRules)) {
                if (ruleConfig !== undefined) {
                    merged[ruleId as GateRuleId] = ruleConfig;
                }
            }
        }

        return merged;
    }

    private async loadFile(filePath: string): Promise<LoadedCraftPlugin> {
        const rawText = await fs.readFile(filePath, 'utf-8');
        const ext = path.extname(filePath).toLowerCase();

        let parsedRaw: unknown;
        try {
            parsedRaw = ext === '.json' ? JSON.parse(rawText) : parseYaml(rawText);
        } catch (error) {
            throw new CraftPluginLoadError(filePath, '文件语法解析失败', error);
        }

        const validation = CraftPluginSchema.safeParse(parsedRaw);
        if (!validation.success) {
            const issues = validation.error.issues
                .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
                .join('; ');
            throw new CraftPluginLoadError(filePath, `Schema 校验失败: ${issues}`);
        }

        const plugin = validation.data;
        const compiledGateRules = compileGateRules(plugin.extra_gate_rules, filePath);

        return {
            plugin,
            sourcePath: filePath,
            compiledGateRules
        };
    }
}

import { z } from 'zod';
import type { GateRuleConfig, GateRuleId } from '../gate/types.js';

/** 已知适用的智能体角色 */
export const KNOWN_PLUGIN_ROLES = ['planner', 'writer', 'fact_checker'] as const;

/** 插件适用角色类型（支持预设角色及自定义扩展角色） */
export type PluginRole = (typeof KNOWN_PLUGIN_ROLES)[number] | (string & {});

/** 门禁规则正则条目 Schema：支持字符串、/pattern/flags 或 { pattern, flags } */
export const ExtraGateRulePatternSchema = z.union([
    z.string().min(1),
    z.object({
        pattern: z.string().min(1),
        flags: z.string().optional()
    })
]);

export type ExtraGateRulePattern = z.infer<typeof ExtraGateRulePatternSchema>;

/** 声明式额外门禁规则定义 Schema（映射到 GateRuleConfig） */
export const ExtraGateRuleDefSchema = z.object({
    enabled: z.boolean().optional(),
    max_count: z.number().int().nonnegative().optional(),
    scale_by_length: z.boolean().optional(),
    reference_chars: z.number().int().positive().optional(),
    patterns: z.array(ExtraGateRulePatternSchema).optional(),
    terms: z.array(z.string().min(1)).optional(),
    last_paragraphs_only: z.number().int().positive().optional()
});

export type ExtraGateRuleDef = z.infer<typeof ExtraGateRuleDefSchema>;

/** 外置文风插件声明 Schema */
export const CraftPluginSchema = z.object({
    id: z
        .string()
        .min(1)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i, '插件 id 仅允许字母、数字与连字符'),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    applicable_roles: z.array(z.string().min(1)).min(1),
    prompt_injection: z.string().min(1),
    extra_gate_rules: z.record(z.string().min(1), ExtraGateRuleDefSchema).optional(),
    enabled: z.boolean().default(true)
});

export type CraftPlugin = z.infer<typeof CraftPluginSchema>;

/** 已加载并完成正则编译的插件实例 */
export interface LoadedCraftPlugin {
    plugin: CraftPlugin;
    sourcePath: string;
    compiledGateRules: Partial<Record<GateRuleId, GateRuleConfig>>;
}

/** 冲突处理策略 */
export type PluginConflictPolicy = 'error' | 'override';

/** 按书籍加载插件的选项 */
export interface LoadForBookOptions {
    /** 插件搜索目录列表（按传入顺序扫描） */
    searchDirs: string[];
    /** 来自 book_config.yaml 的 craft_plugins 白名单（决定激活顺序） */
    enabledPluginIds: string[];
    /** 重复 ID 冲突处理策略，默认 'error' */
    onConflict?: PluginConflictPolicy | undefined;
}

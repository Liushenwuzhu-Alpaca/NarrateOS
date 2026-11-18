import type { CraftPluginDefinition } from './types.js';

/**
 * 解析已激活的 craft_plugins 并按目标角色过滤生成正向提示词文本块：
 * - 仅从外置加载传入的 customPlugins 映射读取定义（零代码硬编码字典与未知插件占位文本）；
 * - planner：允许挂载未指定角色或包含 'planner' 的规划期认知脚手架；
 * - writer：仅注入显式标明 applicable_roles 包含 'writer' 的轻量化提示，严禁泄露规划期重型脚手架。
 */
export function resolveCraftPluginsSection(
    pluginIds: string[],
    targetRole: 'planner' | 'writer' = 'planner',
    customPlugins?: Record<string, CraftPluginDefinition>
): string {
    if (pluginIds.length === 0 || !customPlugins) {
        return '';
    }

    const lines: string[] = ['## 已激活写作插件 (craft_plugins)'];
    for (const rawId of pluginIds) {
        const id = rawId.trim();
        if (!id) continue;
        const def = customPlugins[id];
        if (!def) {
            continue;
        }
        const roles = def.applicable_roles ?? ['planner'];
        if (!roles.includes(targetRole)) {
            continue;
        }
        lines.push(`- [${def.id}] ${def.title}: ${def.promptText}`);
    }

    return lines.length > 1 ? lines.join('\n') : '';
}

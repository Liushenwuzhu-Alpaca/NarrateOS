import type { CraftPluginDefinition } from './types.js';

/** 内置可选认知插件词典（默认关闭，按 book_config.yaml 的 craft_plugins 启用，仅限规划期） */
export const BUILTIN_CRAFT_PLUGINS: Record<string, CraftPluginDefinition> = {
    'vad-bdi': {
        id: 'vad-bdi',
        title: '三维情绪钳位与认知演算链 (vad-bdi)',
        promptText:
            '按效价(Valence)、唤醒度(Arousal)、支配度(Dominance)稳定角色情绪幅度，并沿「信念 -> 欲望 -> 现实约束 -> 意图 -> 行动」推进当场抉择。',
        applicable_roles: ['planner']
    },
    'dual-reaction': {
        id: 'dual-reaction',
        title: '戏眼双反应择优 (dual-reaction)',
        promptText:
            '在核心戏眼节点采用贴合角色长期执念与性格底色的克制第二反应，通过细微动作停顿或器物触碰完成情绪落点。',
        applicable_roles: ['planner']
    },
    'scene-act': {
        id: 'scene-act',
        title: '五元组场面调度 (scene-act)',
        promptText:
            '围绕「now(入场态势) -> beat(核心交锋) -> then(物理后果) -> initiative(主动权归属) -> interplay(视线/器物交互)」组织连续动作与对话穿插。',
        applicable_roles: ['planner']
    }
};

/**
 * 解析已激活的 craft_plugins 并按目标角色过滤生成正向提示词文本块：
 * - planner：允许挂载未指定角色或包含 'planner' 的规划期认知脚手架；
 * - writer：仅注入显式标明 applicable_roles 包含 'writer' 的轻量化提示，严禁泄露规划期重型脚手架。
 */
export function resolveCraftPluginsSection(
    pluginIds: string[],
    targetRole: 'planner' | 'writer' = 'planner',
    customPlugins?: Record<string, CraftPluginDefinition>
): string {
    if (pluginIds.length === 0) {
        return '';
    }

    const lines: string[] = ['## 已激活写作插件 (craft_plugins)'];
    for (const rawId of pluginIds) {
        const id = rawId.trim();
        if (!id) continue;
        const def = customPlugins?.[id] ?? BUILTIN_CRAFT_PLUGINS[id];
        if (def) {
            const roles = def.applicable_roles ?? ['planner'];
            if (!roles.includes(targetRole)) {
                continue;
            }
            lines.push(`- [${def.id}] ${def.title}: ${def.promptText}`);
        } else if (targetRole === 'planner') {
            lines.push(`- [${id}] 按作品配置启用该写作插件规则。`);
        }
    }

    return lines.length > 1 ? lines.join('\n') : '';
}

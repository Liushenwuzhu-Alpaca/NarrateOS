import React from 'react';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { NarrateBrandMark, NarrateBrandName } from './brand';
import {
    NARRATEOS_GLOBAL_THEME_CSS,
    THEME_PLUGIN_ID,
    THEME_STYLE_CSS_ID
} from './theme-styles';
import { NARRATEOS_THEME_TOKENS, type ThemeTokenOverrides } from './tokens';

interface ThemeService {
    overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void;
}

interface SlotsService {
    inject(key: string, callback: () => () => void): () => void;
    register(
        options: { name: string; priority?: number },
        component: React.ComponentType<any>
    ): () => void;
}

export interface NarrateThemeClientContext extends ClientContext {
    theme: ThemeService;
    slots: SlotsService;
    effect(callback: () => () => void, label?: string): () => void;
}

/**
 * 声明依赖的 DSH 客户端服务：
 * - `theme`：提供 overrideTokens 覆盖全局 --dsw-* 令牌并响应浅/深色切换；
 * - `slots`：注入 NarrateOS 朱砂方印与品牌字样到 sidebar.brand.mark / sidebar.brand.name。
 */
export const inject = ['theme', 'slots'] as const;

/**
 * 覆盖优先级：SlotCore 按升序排列（数值越小优先级越高，lowest renders）。
 * 官方品牌插件使用默认 priority 0，此处取 -10 实现无冲突遮蔽，卸载后自动恢复。
 */
export const BRAND_SLOT_PRIORITY = -10;

/**
 * 向 document.head 安装全局主题样式表，并返回幂等的卸载函数。
 */
export function installGlobalThemeStyleSheet(doc: Document = document): () => void {
    const selector = `style[data-plugin-css=${JSON.stringify(THEME_STYLE_CSS_ID)}]`;
    let styleEl = doc.querySelector<HTMLStyleElement>(selector);
    const created = styleEl === null;
    if (!styleEl) {
        styleEl = doc.createElement('style');
        styleEl.dataset.plugin = THEME_PLUGIN_ID;
        styleEl.dataset.pluginCss = THEME_STYLE_CSS_ID;
        doc.head.appendChild(styleEl);
    }
    styleEl.textContent = NARRATEOS_GLOBAL_THEME_CSS;

    return () => {
        if (created && styleEl && styleEl.parentNode) {
            styleEl.parentNode.removeChild(styleEl);
        }
    };
}

/**
 * 在单个 `single` 槽位上安全注册品牌组件（带低数值高优先级遮蔽与异常兜底）。
 */
function registerBrandSlot(
    slots: SlotsService,
    slotName: 'sidebar.brand.mark' | 'sidebar.brand.name',
    component: React.ComponentType<any>
): () => void {
    try {
        return slots.register({ name: slotName, priority: BRAND_SLOT_PRIORITY }, component);
    } catch {
        // 若宿主 SlotCore 版本不支持同槽多优先级遮蔽，降级保持宿主原品牌而不阻塞主题加载
        return () => {};
    }
}

/**
 * NarrateOS 东方清样主题客户端入口。
 * 插件启用即生效，停用或卸载时通过 ctx.effect 全部对称清理。
 */
export function apply(ctx: NarrateThemeClientContext): void {
    ctx.effect(() => {
        const disposeTokens = ctx.theme.overrideTokens(THEME_PLUGIN_ID, NARRATEOS_THEME_TOKENS);
        const disposeStyles = typeof document !== 'undefined' ? installGlobalThemeStyleSheet(document) : () => {};

        const disposeBrandMark = ctx.slots.inject('sidebar.brand.mark', () =>
            registerBrandSlot(ctx.slots, 'sidebar.brand.mark', NarrateBrandMark)
        );
        const disposeBrandName = ctx.slots.inject('sidebar.brand.name', () =>
            registerBrandSlot(ctx.slots, 'sidebar.brand.name', NarrateBrandName)
        );

        return () => {
            disposeBrandName();
            disposeBrandMark();
            disposeStyles();
            disposeTokens();
        };
    }, 'narrateos-global-theme');
}

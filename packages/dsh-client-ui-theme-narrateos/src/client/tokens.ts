export interface ThemeTokenModes {
    light: string;
    dark: string;
}

export type ThemeTokenOverrides = Record<string, ThemeTokenModes>;

/**
 * NarrateOS 东方清样校勘室（Literary Galley Desk）全局语义 Token 覆盖表。
 * 严格提供成对 `{ light, dark }` 值，确保切换 DSH 浅色/深色外观时自动映射为：
 * - light: 暖纸日间（Warm Rag Paper，未漂白棉浆纸感）
 * - dark: 深墨夜读（Ink & Night Paper，温润炭墨底调）
 */
export const NARRATEOS_THEME_TOKENS: ThemeTokenOverrides = {
    // 核心表面色阶：书案底座 -> 侧栏 -> 中央清样舞台 -> 纸面与浮层
    '--dsw-alias-bg-base': {
        light: '#f6f2e9',
        dark: '#191a1d'
    },
    '--dsw-alias-bg-layer-1': {
        light: '#f0ece2',
        dark: '#151619'
    },
    '--dsw-alias-bg-layer-2': {
        light: '#fcfbf7',
        dark: '#1f2024'
    },
    '--dsw-alias-bg-layer-3': {
        light: '#ffffff',
        dark: '#26282d'
    },
    '--dsw-alias-bg-overlay': {
        light: 'rgba(252, 251, 247, 0.94)',
        dark: 'rgba(26, 27, 30, 0.94)'
    },
    '--dsw-alias-bg-module-platform': {
        light: '#ece7dc',
        dark: '#121316'
    },
    '--dsw-alias-bg-skeleton': {
        light: 'rgba(31, 29, 26, 0.06)',
        dark: 'rgba(243, 242, 238, 0.07)'
    },
    '--dsw-alias-bg-document-preview': {
        light: '#f2ede2',
        dark: '#1c1d21'
    },
    '--dsw-alias-bg-document-selection': {
        light: 'rgba(55, 98, 204, 0.22)',
        dark: 'rgba(76, 124, 240, 0.30)'
    },

    // 宿主侧栏、气泡、输入舱与浮层材质
    '--dsw-specific-sidebar-fill': {
        light: '#ebe6dc',
        dark: '#121316'
    },
    '--dsw-specific-sidebar-nav-item-active': {
        light: 'rgba(31, 29, 26, 0.068)',
        dark: 'rgba(243, 242, 238, 0.075)'
    },
    '--dsw-specific-sidebar-nav-item-active-accent': {
        light: 'rgba(55, 98, 204, 0.11)',
        dark: 'rgba(76, 124, 240, 0.16)'
    },
    '--dsw-specific-bubble': {
        light: '#ece7dc',
        dark: '#232429'
    },
    '--dsw-specific-bubble-highlight': {
        light: 'rgba(55, 98, 204, 0.10)',
        dark: 'rgba(76, 124, 240, 0.15)'
    },
    '--dsw-specific-input-major': {
        light: '#fcfbf7',
        dark: '#1f2024'
    },
    '--dsw-specific-menu': {
        light: 'rgba(252, 251, 247, 0.92)',
        dark: 'rgba(28, 29, 34, 0.92)'
    },
    '--dsw-menu-surface-fill': {
        light: 'rgba(252, 251, 247, 0.90)',
        dark: 'rgba(28, 29, 34, 0.90)'
    },
    '--dsw-alias-menu-group-header-fill': {
        light: 'rgba(248, 245, 238, 0.94)',
        dark: 'rgba(24, 25, 29, 0.94)'
    },
    '--dsw-specific-selector': {
        light: '#f2ede3',
        dark: '#222328'
    },
    '--dsw-specific-tip': {
        light: '#f4efe5',
        dark: '#222328'
    },

    // 设置页卡片与提示材质
    '--dsw-alias-settings-card-fill': {
        light: '#fcfbf7',
        dark: '#1b1c20'
    },
    '--dsw-alias-settings-card-stroke': {
        light: 'rgba(31, 29, 26, 0.085)',
        dark: 'rgba(255, 255, 255, 0.08)'
    },
    '--dsw-alias-toast-bg': {
        light: '#24221f',
        dark: '#2b2d33'
    },
    '--dsw-alias-toast-label': {
        light: '#fcfbf7',
        dark: '#f3f2ee'
    },
    '--dsw-alias-tooltip-bg': {
        light: '#262420',
        dark: '#27292f'
    },
    '--dsw-alias-tooltip-key-bg': {
        light: 'rgba(255, 255, 255, 0.14)',
        dark: 'rgba(255, 255, 255, 0.10)'
    },

    // 文字墨阶：温润碳墨与象牙纸白
    '--dsw-alias-label-primary': {
        light: '#1f1d1a',
        dark: '#f3f2ee'
    },
    '--dsw-alias-label-primary-bluish': {
        light: '#222630',
        dark: '#eceef5'
    },
    '--dsw-alias-label-primary-dimmed': {
        light: '#3e3b35',
        dark: '#d6d4cd'
    },
    '--dsw-alias-label-secondary': {
        light: '#555046',
        dark: '#c8c6bf'
    },
    '--dsw-alias-label-tertiary': {
        light: '#777165',
        dark: '#98968f'
    },
    '--dsw-alias-label-caption': {
        light: '#7d776b',
        dark: '#8f8d86'
    },
    '--dsw-alias-label-dimmed': {
        light: '#8f897c',
        dark: '#797770'
    },
    '--dsw-alias-label-document-preview': {
        light: '#4f4a41',
        dark: '#cfcabe'
    },
    '--dsw-alias-menu-icon': {
        light: '#433f37',
        dark: '#d6d4cd'
    },

    // 极淡中性发丝分隔线
    '--dsw-alias-border-l1': {
        light: 'rgba(31, 29, 26, 0.058)',
        dark: 'rgba(255, 255, 255, 0.062)'
    },
    '--dsw-alias-border-l2': {
        light: 'rgba(31, 29, 26, 0.098)',
        dark: 'rgba(255, 255, 255, 0.105)'
    },
    '--dsw-alias-border-l3': {
        light: 'rgba(31, 29, 26, 0.145)',
        dark: 'rgba(255, 255, 255, 0.145)'
    },
    '--dsw-alias-border-l4': {
        light: 'rgba(31, 29, 26, 0.22)',
        dark: 'rgba(255, 255, 255, 0.22)'
    },

    // 交互底色
    '--dsw-alias-interactive-bg-hover': {
        light: 'rgba(31, 29, 26, 0.048)',
        dark: 'rgba(255, 255, 255, 0.052)'
    },
    '--dsw-alias-interactive-bg-active': {
        light: 'rgba(31, 29, 26, 0.085)',
        dark: 'rgba(255, 255, 255, 0.095)'
    },
    '--dsw-alias-interactive-bg-hover-accent': {
        light: 'rgba(55, 98, 204, 0.10)',
        dark: 'rgba(76, 124, 240, 0.16)'
    },

    // Cobalt Dispatch 钴蓝主行动色 & 语义状态色
    '--dsw-alias-brand-primary': {
        light: '#3762cc',
        dark: '#4c7cf0'
    },
    '--dsw-alias-brand-text': {
        light: '#3762cc',
        dark: '#96b6ff'
    },
    '--dsw-alias-link': {
        light: '#3762cc',
        dark: '#96b6ff'
    },
    '--dsw-alias-button-primary-fill': {
        light: '#3762cc',
        dark: '#3762cc'
    },
    '--dsw-alias-button-primary-hover': {
        light: '#2f56b8',
        dark: '#436fd9'
    },
    '--dsw-alias-button-primary-dimmed': {
        light: 'rgba(55, 98, 204, 0.45)',
        dark: 'rgba(76, 124, 240, 0.45)'
    },
    '--dsw-alias-button-elevated-fill': {
        light: '#fcfbf7',
        dark: '#26282d'
    },
    '--dsw-alias-button-floating-fill': {
        light: '#fcfbf7',
        dark: '#22242a'
    },
    '--dsw-alias-button-floating-hover': {
        light: '#f3efe6',
        dark: '#2a2c33'
    },
    '--dsw-alias-state-business-primary': {
        light: '#3762cc',
        dark: '#4c7cf0'
    },
    '--dsw-alias-state-done-primary': {
        light: '#219653',
        dark: '#46c978'
    },
    '--dsw-alias-state-success-primary': {
        light: '#219653',
        dark: '#46c978'
    },
    '--dsw-alias-state-warn-primary': {
        light: '#c77d12',
        dark: '#eba434'
    },
    '--dsw-alias-state-warn-label': {
        light: '#a46409',
        dark: '#f5be62'
    },
    '--dsw-alias-state-error-primary': {
        light: '#cf4444',
        dark: '#e86565'
    },

    // Markdown 代码块与行内代码底色：保持温润纸墨一致
    '--dsw-alias-markdown-code-block': {
        light: '#eee9de',
        dark: '#141518'
    },
    '--dsw-alias-markdown-code-block-banner': {
        light: '#e5dfd2',
        dark: '#1b1c20'
    },
    '--dsw-alias-markdown-inline-code': {
        light: 'rgba(31, 29, 26, 0.065)',
        dark: 'rgba(255, 255, 255, 0.075)'
    },
    '--dsw-alias-markdown-citation': {
        light: 'rgba(223, 100, 71, 0.14)',
        dark: 'rgba(223, 100, 71, 0.20)'
    },

    // 滚动条调和
    '--dsw-alias-scrollbar-bg-l1': {
        light: 'rgba(31, 29, 26, 0.14)',
        dark: 'rgba(243, 242, 238, 0.14)'
    },
    '--dsw-alias-scrollbar-hover-l1': {
        light: 'rgba(31, 29, 26, 0.28)',
        dark: 'rgba(243, 242, 238, 0.28)'
    },
    '--dsw-alias-scrollbar-bg-l2': {
        light: 'rgba(31, 29, 26, 0.20)',
        dark: 'rgba(243, 242, 238, 0.20)'
    },
    '--dsw-alias-scrollbar-hover-l2': {
        light: 'rgba(31, 29, 26, 0.34)',
        dark: 'rgba(243, 242, 238, 0.34)'
    }
};

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
    apply,
    BRAND_SLOT_PRIORITY,
    inject,
    installGlobalThemeStyleSheet
} from '../src/client/index';
import { NarrateBrandMark, NarrateBrandName } from '../src/client/brand';
import {
    NARRATEOS_GLOBAL_THEME_CSS,
    THEME_PLUGIN_ID,
    THEME_STYLE_CSS_ID
} from '../src/client/theme-styles';
import { NARRATEOS_THEME_TOKENS } from '../src/client/tokens';

describe('@narrateos/dsh-client-ui-theme-narrateos', () => {
    it('声明依赖 theme 与 slots 服务并保持 token 双色域完整', () => {
        expect(inject).toEqual(['theme', 'slots']);
        expect(BRAND_SLOT_PRIORITY).toBeLessThan(0);

        const entries = Object.entries(NARRATEOS_THEME_TOKENS);
        expect(entries.length).toBeGreaterThan(25);
        for (const [token, pair] of entries) {
            expect(token.startsWith('--dsw-')).toBe(true);
            expect(typeof pair.light).toBe('string');
            expect(pair.light.length).toBeGreaterThan(0);
            expect(typeof pair.dark).toBe('string');
            expect(pair.dark.length).toBeGreaterThan(0);
        }
    });

    it('全局版式样式覆盖 Card-on-Desk、清样对话流与 Studio 联动且无 U+2011', () => {
        expect(NARRATEOS_GLOBAL_THEME_CSS).not.toContain('\u2011');
        expect(NARRATEOS_GLOBAL_THEME_CSS).toContain('[class*="_centerCol"]');
        expect(NARRATEOS_GLOBAL_THEME_CSS).toContain('[data-chat-flow]');
        expect(NARRATEOS_GLOBAL_THEME_CSS).toContain('[data-composer-card="true"]');
        expect(NARRATEOS_GLOBAL_THEME_CSS).toContain('.ns-studio-shell');
    });

    it('installGlobalThemeStyleSheet 支持幂等安装与干净卸载', () => {
        const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
        const doc = dom.window.document;

        const dispose1 = installGlobalThemeStyleSheet(doc);
        const dispose2 = installGlobalThemeStyleSheet(doc);
        const tags = doc.head.querySelectorAll(`style[data-plugin-css=${JSON.stringify(THEME_STYLE_CSS_ID)}]`);
        expect(tags.length).toBe(1);
        expect(tags[0]?.dataset.plugin).toBe(THEME_PLUGIN_ID);

        dispose2();
        expect(doc.head.querySelectorAll('style').length).toBe(1);

        dispose1();
        expect(doc.head.querySelectorAll('style').length).toBe(0);
    });

    it('apply(ctx) 挂载并在停用时对称释放 token、样式与品牌槽位', () => {
        const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
        const prevDoc = globalThis.document;
        globalThis.document = dom.window.document;

        try {
            let tokenDisposed = false;
            let overrideSource = '';
            const registeredSlots: Array<{ name: string; priority?: number; disposed: boolean }> = [];
            const effectCleanups: Array<() => void> = [];

            const mockCtx = {
                theme: {
                    overrideTokens(source: string) {
                        overrideSource = source;
                        return () => {
                            tokenDisposed = true;
                        };
                    }
                },
                slots: {
                    inject(_key: string, cb: () => () => void) {
                        const cleanup = cb();
                        return () => cleanup();
                    },
                    register(opts: { name: string; priority?: number }) {
                        const rec = { ...opts, disposed: false };
                        registeredSlots.push(rec);
                        return () => {
                            rec.disposed = true;
                        };
                    }
                },
                effect(fn: () => () => void) {
                    effectCleanups.push(fn());
                }
            };

            apply(mockCtx as unknown as Parameters<typeof apply>[0]);

            expect(overrideSource).toBe(THEME_PLUGIN_ID);
            expect(tokenDisposed).toBe(false);
            expect(registeredSlots.map((s) => s.name)).toEqual([
                'sidebar.brand.mark',
                'sidebar.brand.name'
            ]);
            expect(registeredSlots.every((s) => s.priority === BRAND_SLOT_PRIORITY)).toBe(true);
            expect(
                dom.window.document.head.querySelector(`style[data-plugin=${JSON.stringify(THEME_PLUGIN_ID)}]`)
            ).not.toBeNull();

            for (const cleanup of effectCleanups) {
                cleanup();
            }

            expect(tokenDisposed).toBe(true);
            expect(registeredSlots.every((s) => s.disposed)).toBe(true);
            expect(
                dom.window.document.head.querySelector(`style[data-plugin=${JSON.stringify(THEME_PLUGIN_ID)}]`)
            ).toBeNull();
        } finally {
            globalThis.document = prevDoc;
        }
    });

    it('品牌组件可正常构造 React 元素', () => {
        const mark = NarrateBrandMark({ size: 20 });
        const name = NarrateBrandName();
        assert.equal(mark.type, 'span');
        assert.equal(name.type, 'span');
    });
});

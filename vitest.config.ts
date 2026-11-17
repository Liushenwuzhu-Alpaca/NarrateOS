import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        alias: {
            '@deepseek-ai/dsh-client-ui-primitives': new URL(
                './packages/dsh-plugin/tests/host-ui.ts',
                import.meta.url
            ).pathname
        },
        globals: false,
        environment: 'node',
        include: ['packages/*/src/**/*.test.ts', 'packages/*/tests/**/*.test.ts']
    }
});

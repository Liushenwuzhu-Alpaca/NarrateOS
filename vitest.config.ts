import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        alias: {
            '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL(
                './packages/dsh-client-ui-studio/tests/host-ui.ts',
                import.meta.url
            ))
        },
        globals: false,
        environment: 'node',
        include: ['packages/*/src/**/*.test.ts', 'packages/*/tests/**/*.test.ts']
    }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.{test,spec}.{js,ts}'],
        coverage: {
            provider: 'v8',
            include: ['services/**/*.js'],
            thresholds: {
                lines: 80,
                functions: 80,
                branches: 75,
            },
        },
        testTimeout: 30000,
    },
});

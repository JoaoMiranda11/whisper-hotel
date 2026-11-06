import { defineConfig } from 'vitest/config';

// Unit tests cover only pure, renderer-free modules (see src/api/voice).
export default defineConfig({
    test: {
        include: [ 'src/**/*.test.ts' ],
        environment: 'node'
    }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Integration tests hit a real Postgres database sequentially (see test/golden-path.test.ts)
    // — they are not safe to parallelise against each other within a single run.
    fileParallelism: false,
  },
});

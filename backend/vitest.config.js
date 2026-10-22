import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    // Test files share one database and one Redis, so run them one after another
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      CODE_SECRET: 'test-code-secret-not-used-anywhere-else',
      RATE_LIMIT_ENABLED: 'false',
    },
  },
});
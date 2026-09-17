import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/e2e/**/*.test.ts',
      'test/golden/**/*.test.ts',
    ],
    pool: 'forks',
    testTimeout: 30_000,
  },
});

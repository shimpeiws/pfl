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
    coverage: {
      provider: 'v8',
      // The report is written even when a test fails, so a CI failure still
      // shows which area regressed.
      reportOnFailure: true,
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // Floor, not a target: set below the current level so an unintended drop
      // fails the coverage job while ordinary additions have headroom. Raise it
      // deliberately when a gap is closed.
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 90,
        lines: 87,
      },
    },
  },
});

/**
 * Vitest config for Kunii.
 *
 * The ORM is pure TypeScript with zero runtime deps. Tests run in the
 * default Node pool with a mock SqlExecutor that records compiled SQL
 * and bound params. No real D1 / DO needed for unit tests.
 *
 * If we later need a workers-runtime integration suite (real D1 binding
 * or DO SqlStorage), add a second project here using
 * `@cloudflare/vitest-pool-workers`.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**'],
  },
});

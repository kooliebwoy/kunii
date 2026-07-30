/**
 * Integration tests — run inside workerd via @cloudflare/vitest-pool-workers.
 *
 * The pool provides a real Cloudflare runtime (Miniflare-emulated) so we
 * exercise the ORM against a genuine D1 binding and real Durable Object
 * SqlStorage. Both go through different ORM executors but compile via the
 * same source — running the same suite against both catches drift.
 *
 * Test files import `{ env }` from `cloudflare:workers` to access the DB
 * binding and the DO namespace. Storage is isolated per-test by default.
 */

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/integration/wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['test/integration/**/*.test.ts'],
  },
});

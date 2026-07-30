import { describe, expect, it } from 'vitest';

import {
  DRIZZLE_PARITY_BUCKETS,
  DRIZZLE_PARITY_TOTALS,
  DRIZZLE_UPSTREAM_SOURCE,
  getDrizzleParityBuckets,
  type DrizzleParityBucket,
  type DrizzleParityStatus,
} from './fixtures/upstream-drizzle/manifest.js';

const VALID_STATUSES = new Set<DrizzleParityStatus>([
  'converted-pass',
  'partially-converted',
  'intentional-divergence',
  'not-applicable',
  'gap',
]);

function assertClassified(bucket: DrizzleParityBucket): void {
  expect(bucket.id).toBeTruthy();
  expect(bucket.upstreamPath).toBeTruthy();
  expect(bucket.fileCount).toBeGreaterThan(0);
  expect(VALID_STATUSES.has(bucket.status)).toBe(true);
  expect(bucket.notes.trim().length).toBeGreaterThan(20);

  if (bucket.status === 'gap') {
    expect(bucket.nextAction, `${bucket.id} gap needs a next action`).toBeTruthy();
  }

  if (bucket.status === 'partially-converted') {
    expect(bucket.localEvidence?.length, `${bucket.id} partial coverage needs local evidence`).toBeGreaterThan(0);
    expect(bucket.nextAction, `${bucket.id} partial coverage needs a next action`).toBeTruthy();
  }

  if (bucket.status === 'converted-pass') {
    expect(bucket.localEvidence?.length, `${bucket.id} converted coverage needs local evidence`).toBeGreaterThan(0);
    expect(bucket.nextAction, `${bucket.id} should not carry comparison follow-up after conversion`).toBeUndefined();
  }
}

describe('upstream Drizzle parity inventory', () => {
  it('records the upstream source snapshot explicitly', () => {
    expect(DRIZZLE_UPSTREAM_SOURCE.repository).toBe('drizzle-team/drizzle-orm');
    expect(DRIZZLE_UPSTREAM_SOURCE.commit).toBe('48e5406027103a9fca6eb66417187c4a8b5c6aa3');
    expect(DRIZZLE_UPSTREAM_SOURCE.capturedAt).toBe('2026-05-09');
    expect(DRIZZLE_UPSTREAM_SOURCE.focus).toContain('D1');
    expect(DRIZZLE_UPSTREAM_SOURCE.focus).toContain('Durable Objects');
  });

  it('classifies every tracked upstream bucket without treating Drizzle as the golden standard', () => {
    expect(DRIZZLE_PARITY_BUCKETS).toHaveLength(DRIZZLE_PARITY_TOTALS.trackedBuckets);
    expect(new Set(DRIZZLE_PARITY_BUCKETS.map((bucket) => bucket.id)).size).toBe(DRIZZLE_PARITY_BUCKETS.length);

    for (const bucket of DRIZZLE_PARITY_BUCKETS) {
      assertClassified(bucket);
    }
  });

  it('closes the upstream comparison loop without leaving gaps', () => {
    expect(getDrizzleParityBuckets('gap')).toHaveLength(0);
    expect(getDrizzleParityBuckets('partially-converted')).toHaveLength(0);
    expect(getDrizzleParityBuckets('converted-pass').length).toBeGreaterThan(0);
    expect(getDrizzleParityBuckets('intentional-divergence').length).toBeGreaterThan(0);
    expect(getDrizzleParityBuckets('not-applicable').length).toBeGreaterThan(0);
  });

  it('tracks the classified SQLite and non-goal file counts from the sparse upstream snapshot', () => {
    const trackedSqliteRuntimeFiles = DRIZZLE_PARITY_BUCKETS
      .filter((bucket) => bucket.scope === 'sqlite-runtime' || bucket.scope === 'durable-sqlite')
      .reduce((sum, bucket) => sum + bucket.fileCount, 0);
    const nonGoalFiles = DRIZZLE_PARITY_BUCKETS
      .filter((bucket) => bucket.scope === 'non-goal')
      .reduce((sum, bucket) => sum + bucket.fileCount, 0);

    expect(trackedSqliteRuntimeFiles).toBe(DRIZZLE_PARITY_TOTALS.trackedSqliteRuntimeFiles);
    expect(DRIZZLE_PARITY_TOTALS.sqliteRuntimeFiles).toBeGreaterThan(trackedSqliteRuntimeFiles);
    expect(nonGoalFiles).toBe(DRIZZLE_PARITY_TOTALS.nonGoalFiles);
  });
});

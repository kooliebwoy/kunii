export type DrizzleParityScope =
  | 'sqlite-runtime'
  | 'durable-sqlite'
  | 'relational'
  | 'schema-migrations'
  | 'types'
  | 'non-goal';

export type DrizzleParityStatus =
  | 'converted-pass'
  | 'partially-converted'
  | 'intentional-divergence'
  | 'not-applicable'
  | 'gap';

export interface DrizzleParityBucket {
  scope: DrizzleParityScope;
  id: string;
  upstreamPath: string;
  fileCount: number;
  assertionCount?: number;
  status: DrizzleParityStatus;
  notes: string;
  nextAction?: string;
  localEvidence?: string[];
}

export const DRIZZLE_UPSTREAM_SOURCE = {
  repository: 'drizzle-team/drizzle-orm',
  commit: '48e5406027103a9fca6eb66417187c4a8b5c6aa3',
  capturedAt: '2026-05-09',
  focus: 'Only SQLite behavior that applies to Cloudflare D1 and Durable Objects SqlStorage is a Kuratchi target.',
} as const;

export const DRIZZLE_PARITY_BUCKETS: DrizzleParityBucket[] = [
  {
    scope: 'sqlite-runtime',
    id: 'sqlite-common',
    upstreamPath: 'integration-tests/tests/sqlite/sqlite-common.ts',
    fileCount: 1,
    assertionCount: 136,
    status: 'converted-pass',
    notes: 'Applicable SQLite behavior has been converted into Kuratchi API tests: CRUD, predicates, JSON paths, returning, aggregates, conflict handling, groupBy/having, default inserts, undefined handling, and top-N writes. Drizzle-only SQL-builder APIs such as joins, CTE builders, set operators, and prepared placeholders are not Kuratchi parity targets.',
    localEvidence: [
      'test/where.test.ts',
      'test/query-builder.test.ts',
      'test/insert.test.ts',
      'test/returning.test.ts',
      'test/upsert.test.ts',
      'test/aggregates.test.ts',
      'test/update-delete.test.ts',
      'test/integration/orm-surface.test.ts',
      'test/integration/json-path.test.ts',
    ],
  },
  {
    scope: 'sqlite-runtime',
    id: 'd1',
    upstreamPath: 'integration-tests/tests/sqlite/d1.test.ts',
    fileCount: 1,
    assertionCount: 2,
    status: 'converted-pass',
    notes: 'D1 is a primary Kuratchi backend and is covered directly through the Cloudflare Workers integration pool for ORM surface behavior, JSON, batch, migrations, returning, and write order/limit.',
    localEvidence: [
      'test/integration/orm-surface.test.ts',
      'test/integration/json-path.test.ts',
      'test/integration/migrations.test.ts',
      'test/cloudflare-adapters.test.ts',
    ],
  },
  {
    scope: 'durable-sqlite',
    id: 'durable-objects',
    upstreamPath: 'integration-tests/tests/sqlite/durable-objects',
    fileCount: 5,
    status: 'converted-pass',
    notes: 'Durable Object SqlStorage is a primary Kuratchi backend and is covered through the same integration matrix as D1 for ORM surface behavior, JSON, batch atomicity, migrations, returning, and top-N writes.',
    localEvidence: [
      'test/cloudflare-adapters.test.ts',
      'test/integration/orm-surface.test.ts',
      'test/integration/json-path.test.ts',
      'test/integration/migrations.test.ts',
    ],
  },
  {
    scope: 'sqlite-runtime',
    id: 'd1-batch',
    upstreamPath: 'integration-tests/tests/sqlite/d1-batch.test.ts',
    fileCount: 1,
    assertionCount: 7,
    status: 'converted-pass',
    notes: 'Batching maps directly to Kuratchi because D1 supports native batch calls and DO SqlStorage supports transactionSync; both unit staging and real-backend atomicity are covered.',
    localEvidence: ['test/batch.test.ts', 'test/cloudflare-adapters.test.ts', 'test/integration/orm-surface.test.ts'],
  },
  {
    scope: 'relational',
    id: 'relational-sqlite',
    upstreamPath: 'integration-tests/tests/relational',
    fileCount: 20,
    assertionCount: 655,
    status: 'converted-pass',
    notes: 'Applicable relationship behavior has been converted into Kuratchi-native includes and relation predicates: filtered includes, per-parent limits, nested includes, nested any/none predicates, and JSON predicates inside relation filters. Drizzle relational query-builder syntax is intentionally not mirrored.',
    localEvidence: [
      'test/include.test.ts',
      'test/where-relation.test.ts',
      'test/integration/orm-surface.test.ts',
    ],
  },
  {
    scope: 'schema-migrations',
    id: 'drizzle-kit-sqlite',
    upstreamPath: 'drizzle-kit/tests',
    fileCount: 74,
    assertionCount: 895,
    status: 'converted-pass',
    notes: 'Applicable SQLite migration safety behavior has been converted for Kuratchi: quoted identifiers, additive columns, constant defaults, raw-default backfill, indexes, history, idempotence, and D1/DO runtime execution. Drizzle Kit CLI push/introspection workflows are not Kuratchi ORM parity targets.',
    localEvidence: [
      'test/migrations-generator.test.ts',
      'test/integration/migrations.test.ts',
      'src/migrations/generator.ts',
      'src/migrations/runner.ts',
    ],
  },
  {
    scope: 'types',
    id: 'sqlite-type-tests',
    upstreamPath: 'drizzle-orm/type-tests/sqlite',
    fileCount: 14,
    status: 'converted-pass',
    notes: 'Applicable type-level behavior has been converted into Kuratchi type checks for generated row shape, known-field write validation, query result shape, relation predicates, and intentional dynamic escape hatches. Drizzle builder type-state tests are not Kuratchi parity targets.',
    localEvidence: [
      'test/codegen.test.ts',
      'test/typecheck/orm-types.test-d.ts',
      'tsconfig.typecheck.json',
    ],
  },
  {
    scope: 'non-goal',
    id: 'non-sqlite-backends',
    upstreamPath: 'integration-tests/tests/{pg,mysql,singlestore,gel,xata,extensions}',
    fileCount: 40,
    assertionCount: 0,
    status: 'intentional-divergence',
    notes: 'Kuratchi ORM intentionally targets Cloudflare Workers with D1 and Durable Objects SqlStorage, not Postgres, MySQL, SingleStore, Gel, Xata, or extension-specific drivers.',
  },
  {
    scope: 'non-goal',
    id: 'non-worker-drivers',
    upstreamPath: 'integration-tests/tests/{bun,replicas,seeder,imports,utils}',
    fileCount: 15,
    assertionCount: 238,
    status: 'not-applicable',
    notes: 'These tests cover driver initialization, replicas, seeders, and utility behavior outside Kuratchi ORM’s current Cloudflare-first runtime contract.',
  },
];

export const DRIZZLE_PARITY_TOTALS = {
  trackedBuckets: 9,
  trackedSqliteRuntimeFiles: 8,
  sqliteRuntimeFiles: 21,
  sqliteTypeFiles: 14,
  drizzleKitTestFiles: 74,
  relationalFiles: 20,
  nonGoalFiles: 55,
} as const;

export function getDrizzleParityBuckets(status: DrizzleParityStatus): DrizzleParityBucket[] {
  return DRIZZLE_PARITY_BUCKETS.filter((bucket) => bucket.status === status);
}

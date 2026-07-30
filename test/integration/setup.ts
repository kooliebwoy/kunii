/**
 * Shared setup for integration tests.
 *
 * Provides:
 *   - `setupD1()` / `setupDO()` — fresh schema + clean rows for each test
 *   - `d1Client` / `doClient` — drivers that share a fluent surface so the
 *     same test body can run against both backends
 *
 * The DO client serializes chains into commands and ships them across the
 * RPC boundary. The D1 client uses the ORM directly. Both expose the same
 * shape: `db.tableName.where(...).first()` etc.
 */

import { env } from 'cloudflare:workers';
import { kunii } from '../../src/index.js';
import { ensureNormalizedSchema } from '../../src/schema.js';
import { buildInitialSql } from '../../src/migrations/generator.js';
import type { OrmCommand } from './fixture-worker.js';
import { testSchema } from './fixture-worker.js';

declare module 'cloudflare:workers' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_DO: DurableObjectNamespace<any>;
  }
}

// Tables listed in dependency order (children before parents) so the
// per-test reset can delete without tripping FK constraints.
const TABLES = ['comments', 'posts', 'events', 'users'] as const;
type TableName = (typeof TABLES)[number];

// ── D1 setup ─────────────────────────────────────────────────

let d1SchemaInitialized = false;

export async function setupD1() {
  const db = env.DB;
  if (!d1SchemaInitialized) {
    const normalized = ensureNormalizedSchema(testSchema);
    const sql = buildInitialSql(normalized);
    const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await db.prepare(stmt).run();
    }
    d1SchemaInitialized = true;
  }
  // Clean rows between tests — children first to satisfy FKs.
  for (const t of TABLES) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
  // Use the public factory the same way users do — proves schema-aware
  // path-aware compilation works through kunii(binding, schema).
  return kunii(db, testSchema);
}

// ── DO setup ─────────────────────────────────────────────────

/**
 * Builds a thin Proxy that mirrors the ORM's fluent API but, on terminal
 * methods (`many`, `first`, `one`, `count`, `exists`, `insert`, `delete`,
 * `update`, `updateMany`, `distinct`), serializes the chain to a command
 * and dispatches it over RPC to the DO.
 *
 * Test code reads identically to the D1 path. Both backends exercise the
 * same ORM source files; the difference is just D1's async executor vs
 * the DO's synchronous SqlStorage executor under the hood.
 */
function makeDoClient(stub: any) {
  // Methods that always return a Promise (terminal ops). After the
  // single-Table refactor, `update` is always terminal too.
  const ALWAYS_TERMINAL = new Set([
    'many',
    'first',
    'one',
    'count',
    'exists',
    'insert',
    'update',
    'upsert',
    'delete',
    'distinct',
    'sum',
    'avg',
    'min',
    'max',
  ]);

  /**
   * If non-null, terminals are queued onto this list instead of being
   * shipped to the DO. Used to implement `db.batch()` in tests — we
   * collect commands during the user's callback, then ship them as a
   * single `runBatch` RPC call.
   */
  let activeBatchQueue: OrmCommand[] | null = null;

  function buildChain(table: string, steps: [string, any[]][]) {
    return new Proxy(
      {},
      {
        get(_t, prop: PropertyKey) {
          if (typeof prop !== 'string') return undefined;
          if (prop === 'then') return undefined; // not a thenable
          return (...args: any[]) => {
            const next: [string, any[]][] = [...steps, [prop, args]];
            if (ALWAYS_TERMINAL.has(prop)) {
              const cmd: OrmCommand = { table, steps: next };
              if (activeBatchQueue) {
                // Batch mode: queue locally, return a resolved promise
                // so the user can `await` without blocking on DB work.
                activeBatchQueue.push(cmd);
                return Promise.resolve();
              }
              // Reads inside batch should throw — but that's enforced
              // on the DO side when the queue runs.
              return stub.run(cmd);
            }
            return buildChain(table, next);
          };
        },
      }
    );
  }

  const batch = async (callback: any) => {
    const queue: OrmCommand[] = [];
    activeBatchQueue = queue;
    try {
      await callback(
        new Proxy(
          {},
          {
            get(_t, prop: PropertyKey) {
              if (typeof prop !== 'string') return undefined;
              return buildChain(prop, []);
            },
          }
        )
      );
    } finally {
      activeBatchQueue = null;
    }
    return stub.runBatch(queue);
  };

  return new Proxy(
    {},
    {
      get(_t, prop: PropertyKey) {
        if (prop === 'batch') return batch;
        if (typeof prop !== 'string') return undefined;
        return buildChain(prop, []);
      },
    }
  ) as Record<string, any>;
}

export async function setupDO(uniqueId: string = 'test') {
  // A fresh DO id per test ensures clean storage isolation.
  const id = env.TEST_DO.idFromName(`${uniqueId}-${Math.random()}`);
  const stub = env.TEST_DO.get(id);
  await stub.reset();
  return makeDoClient(stub);
}

// ── Backend matrix ───────────────────────────────────────────

/**
 * Run a test body against both D1 and DO in a single `it.each` invocation.
 * Both backends share the same fluent surface, so the test is one body.
 */
export const backends = [
  { name: 'd1', setup: setupD1 },
  { name: 'do', setup: setupDO },
] as const;

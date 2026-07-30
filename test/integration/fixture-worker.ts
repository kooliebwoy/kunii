/**
 * Fixture worker for integration tests.
 *
 * Hosts a Durable Object that runs schema migrations against `ctx.storage`
 * via `autoMigrate()`, then constructs an ORM client via `kunii()`.
 * Tests interact with the DO over an RPC method `run()` that accepts a
 * JSON-serializable command and replays it against the ORM.
 *
 * Why a command shape instead of exposing the ORM proxy directly? The ORM's
 * fluent API uses chained method calls on a Proxy; that surface doesn't
 * cross the DO RPC boundary as-is (the proxy is local-only). The command
 * shape gives tests a JSON-safe transport that exercises the *same* ORM
 * code paths the D1 tests use. Tests share a helper (`runOnDO`) that hides
 * this serialization, so test source reads identically across backends.
 */

import { DurableObject } from 'cloudflare:workers';
import { autoMigrate, kunii } from '../../src/index.js';
import { runMigrations } from '../../src/migrations/index.js';
import type { SchemaDsl } from '../../src/types.js';

export const testSchema: SchemaDsl = {
  name: 'orm-integration',
  version: 1,
  tables: {
    users: {
      id: 'integer primary key',
      email: 'text not null',
      name: 'text',
      tier: 'text default free',
      meta: 'json',
      deleted_at: 'timestamp_ms',
    },
    events: {
      id: 'integer primary key',
      userId: 'integer',
      kind: 'text not null',
      payload: 'json',
    },
    posts: {
      id: 'integer primary key',
      userId: 'integer -> users.id',
      title: 'text not null',
      published: 'integer default 0',
      createdAt: 'integer',
      views: 'integer default 0',
      meta: 'json',
    },
    comments: {
      id: 'integer primary key',
      postId: 'integer -> posts.id',
      body: 'text not null',
    },
  },
};

interface Env {
  DB: D1Database;
  TEST_DO: DurableObjectNamespace<TestDO>;
}

/**
 * A serialized ORM call. Each step is a method invocation on the chain.
 * Example for `db.users.where({ id: 1 }).first()`:
 *   { table: 'users', steps: [['where', [{id:1}]], ['first', []]] }
 */
export type OrmCommand = {
  table: string;
  steps: [string, any[]][];
};

function applyCommand(db: Record<string, any>, cmd: OrmCommand): Promise<any> {
  let cursor: any = db[cmd.table];
  for (const [method, args] of cmd.steps) {
    const fn = cursor[method];
    if (typeof fn !== 'function') {
      throw new Error(`Unknown ORM method '${method}' on ${cmd.table}`);
    }
    cursor = fn.apply(cursor, args);
  }
  return Promise.resolve(cursor);
}

export class TestDO extends DurableObject<Env> {
  db: Record<string, any>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Pass ctx.storage (not ctx.storage.sql) so autoMigrate can pick up
    // transactionSync and attach it to the SqlStorage; kunii uses
    // that for atomic db.batch() commits.
    autoMigrate(ctx.storage, testSchema);
    this.db = kunii(ctx.storage.sql, testSchema);
  }

  async run(cmd: OrmCommand): Promise<any> {
    return await applyCommand(this.db, cmd);
  }

  async runBatch(cmds: OrmCommand[]): Promise<any> {
    // Translate the queued OrmCommands into ORM operations inside a
    // single db.batch() callback so the writes commit atomically.
    return await this.db.batch(async (tx: any) => {
      for (const cmd of cmds) {
        let cursor: any = tx[cmd.table];
        for (const [method, args] of cmd.steps) {
          const fn = cursor[method];
          if (typeof fn !== 'function') {
            throw new Error(
              `Unknown ORM method '${method}' on ${cmd.table} in batch`
            );
          }
          cursor = fn.apply(cursor, args);
        }
        // The terminal call returned its result (a Promise) — await so
        // recording completes before moving on.
        await cursor;
      }
    });
  }

  async reset() {
    // Delete child tables before parents so FK constraints don't fire.
    const orderedTables = ['comments', 'posts', 'events', 'users'];
    for (const name of orderedTables) {
      try {
        this.ctx.storage.sql.exec(`DELETE FROM ${name}`);
      } catch {
        // table may not exist on first run
      }
    }
  }

  async migrateSchema(schema: SchemaDsl): Promise<any> {
    return await runMigrations({
      execute: async (sql, params) => {
        const cursor = params?.length
          ? this.ctx.storage.sql.exec(sql, ...params)
          : this.ctx.storage.sql.exec(sql);
        const rows = cursor?.toArray?.() ?? [];
        return { success: true, data: rows, results: rows };
      },
      schema,
    });
  }

  async exec(sql: string): Promise<any[]> {
    return this.ctx.storage.sql.exec(sql).toArray();
  }
}

export default {
  async fetch() {
    return new Response('ok');
  },
};

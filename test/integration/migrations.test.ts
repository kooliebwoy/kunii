import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/migrations/index.js';
import type { SchemaDsl } from '../../src/types.js';

function d1Executor(db: D1Database) {
  return async (sql: string, params?: any[]) => {
    let stmt = db.prepare(sql);
    if (params?.length) stmt = stmt.bind(...params);
    const result = await stmt.all();
    return { success: result.success ?? true, data: result.results, results: result.results };
  };
}

function d1RawClient(db: D1Database) {
  return {
    prepare: (sql: string) => db.prepare(sql),
    batch: (stmts: any[]) => db.batch(stmts),
  };
}

function schema(version: number, extra: Record<string, string> = {}, indexes?: SchemaDsl['indexes']): SchemaDsl {
  return {
    name: `migration_${version}_${Math.random().toString(16).slice(2)}`,
    version,
    tables: {
      accounts: {
        id: 'integer primary key',
        email: 'text not null',
        ...extra,
      },
    },
    indexes,
  };
}

const evolvedExtra = {
  tier: 'text not null default free',
  created_at: 'integer default (strftime(\'%s\',\'now\'))',
};

describe('runtime migrations on Cloudflare SQLite backends', () => {
  it('D1 applies additive columns, raw default backfill, indexes, and history', async () => {
    const base = schema(1);
    const evolved: SchemaDsl = {
      ...base,
      version: 2,
      tables: {
        accounts: {
          ...base.tables.accounts,
          ...evolvedExtra,
        },
      },
      indexes: {
        accounts: {
          accounts_email_idx: { columns: ['email'], unique: true },
        },
      },
    };

    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    await runMigrations({ execute, client, schema: base });
    await execute('INSERT INTO accounts (id, email) VALUES (?, ?)', [1, 'a@b.com']);

    const result = await runMigrations({ execute, client, schema: evolved });
    expect(result.applied).toBe(true);
    expect(result.statementsRun).toBeGreaterThanOrEqual(3);
    expect(result.warnings.join(' ')).toContain('Cannot preserve non-constant default');

    const rows = await execute('SELECT id, email, tier, created_at FROM accounts');
    expect((rows.data as any[])[0].tier).toBe('free');
    expect((rows.data as any[])[0].created_at).toBeTruthy();

    const indexes = await execute('PRAGMA index_list(accounts)');
    expect((indexes.data as any[]).some((row) => row.name === 'accounts_email_idx')).toBe(true);

    const second = await runMigrations({ execute, client, schema: evolved });
    expect(second.applied).toBe(false);
    expect(second.statementsRun).toBe(0);
  });

  it('Durable Object SqlStorage applies the same additive migration path', async () => {
    const base = schema(10);
    const evolved: SchemaDsl = {
      ...base,
      version: 11,
      tables: {
        accounts: {
          ...base.tables.accounts,
          ...evolvedExtra,
        },
      },
      indexes: {
        accounts: {
          accounts_email_idx: { columns: ['email'], unique: true },
        },
      },
    };

    const id = env.TEST_DO.idFromName(`migration-${Math.random()}`);
    const stub = env.TEST_DO.get(id);
    await stub.migrateSchema(base);
    await stub.exec("INSERT INTO accounts (id, email) VALUES (1, 'a@b.com')");

    const result = await stub.migrateSchema(evolved);
    expect(result.applied).toBe(true);
    expect(result.statementsRun).toBeGreaterThanOrEqual(3);
    expect(result.warnings.join(' ')).toContain('Cannot preserve non-constant default');

    const rows = await stub.exec('SELECT id, email, tier, created_at FROM accounts');
    expect(rows[0].tier).toBe('free');
    expect(rows[0].created_at).toBeTruthy();

    const indexes = await stub.exec('PRAGMA index_list(accounts)');
    expect(indexes.some((row: any) => row.name === 'accounts_email_idx')).toBe(true);
  });
});

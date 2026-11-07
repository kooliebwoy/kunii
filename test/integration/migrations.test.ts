import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasPendingMigrations, runMigrations } from '../../src/migrations/index.js';
import { initKuniiORM } from '../../src/init.js';
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

function synchronizeMigrationWrites(db: D1Database, count: number) {
  const client = d1RawClient(db);
  const writes = new WeakSet<object>();
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return {
    prepare(sql: string) {
      const statement = client.prepare(sql);
      if (!sql.startsWith('INSERT INTO _kuratchi_migrations')) return statement;
      return { bind(...params: any[]) {
        const bound = statement.bind(...params);
        writes.add(bound);
        return bound;
      } };
    },
    async batch(statements: any[]) {
      if (writes.has(statements[0])) {
        if (++arrived === count) release();
        await ready;
      }
      return client.batch(statements);
    },
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
  it('does not certify an adopted FTS definition that differs from the requested columns', async () => {
    const execute = d1Executor(env.DB);
    await execute('CREATE VIRTUAL TABLE review_search USING fts5(old_content)');
    const target: SchemaDsl = {
      name: 'adopt_fts', version: 1, tables: {},
      virtualTables: { review_search: { module: 'fts5', columns: ['new_content'] } },
    };
    const result = await runMigrations({ execute, client: d1RawClient(env.DB), schema: target });
    expect(result).toMatchObject({ applied: false, statementsRun: 0 });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(await hasPendingMigrations({ execute, schema: target })).toBe(true);
    const matching: SchemaDsl = { ...target, virtualTables: { review_search: { module: 'fts5', columns: ['old_content'] } } };
    expect(await runMigrations({ execute, client: d1RawClient(env.DB), schema: matching })).toMatchObject({ warnings: [] });
    expect(await hasPendingMigrations({ execute, schema: matching })).toBe(false);
  });

  it('converges eight simultaneous rename plans to one committed migration', async () => {
    const execute = d1Executor(env.DB);
    const first = schema(1, { phone: 'text' });
    await runMigrations({ execute, client: d1RawClient(env.DB), schema: first });
    await execute("INSERT INTO accounts (email, phone) VALUES ('a', 'keep')");
    const second = { ...first, version: 2, tables: { accounts: { id: 'integer primary key', email: 'text not null', mobile: 'text renameFrom phone' } } };
    const client = synchronizeMigrationWrites(env.DB, 8);
    const results = await Promise.all(Array.from({ length: 8 }, () => runMigrations({ execute, client, schema: second })));
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect((await execute('SELECT mobile FROM accounts')).data).toEqual([{ mobile: 'keep' }]);
    expect((await execute('SELECT version FROM _kuratchi_migrations ORDER BY version')).data).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('rejects a competing schema definition for the same version after its peer commits', async () => {
    const execute = d1Executor(env.DB);
    const first = schema(1);
    await runMigrations({ execute, client: d1RawClient(env.DB), schema: first });
    const a = { ...first, version: 2, tables: { accounts: { ...first.tables.accounts, alpha: 'text' } } };
    const b = { ...first, version: 2, tables: { accounts: { ...first.tables.accounts, beta: 'text' } } };
    const client = synchronizeMigrationWrites(env.DB, 2);
    const results = await Promise.allSettled([runMigrations({ execute, client, schema: a }), runMigrations({ execute, client, schema: b })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toContain('immutable');
    const columns = (await execute('PRAGMA table_info(accounts)')).data!.map(row => row.name);
    expect(columns.filter(name => name === 'alpha' || name === 'beta')).toHaveLength(1);
  });

  it('preserves every value across a populated rebuild and uses a constant read count on the unchanged path', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1);
    await runMigrations({ execute, client, schema: first });
    await execute(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO accounts (id, email) SELECT i, 'user-' || i FROM n`);
    const before = (await execute('SELECT COUNT(*) AS count, SUM(id) AS total, SUM(length(email)) AS lengths FROM accounts')).data;
    const second = { ...first, version: 2, tables: { accounts: { id: 'integer primary key', email: 'text not null unique', created: 'text default now' } } };
    await runMigrations({ execute, client, schema: second });
    expect((await execute('SELECT COUNT(*) AS count, SUM(id) AS total, SUM(length(email)) AS lengths FROM accounts')).data).toEqual(before);
    expect((await execute("SELECT COUNT(*) AS bad FROM accounts WHERE email != 'user-' || id OR created IS NULL")).data).toEqual([{ bad: 0 }]);
    const reads: string[] = [];
    const checked = async (sql: string, params?: any[]) => { reads.push(sql); return execute(sql, params); };
    expect(await runMigrations({ execute: checked, client, schema: second })).toMatchObject({ applied: false, statementsRun: 0 });
    expect(reads).toHaveLength(3);
    expect(reads.some(sql => sql.includes('table_xinfo'))).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid schema version %s before creating history', async version => {
    const execute = d1Executor(env.DB);
    await expect(runMigrations({ execute, client: d1RawClient(env.DB), schema: schema(version) })).rejects.toThrow('positive integer');
    expect((await execute("SELECT name FROM sqlite_master WHERE name = '_kuratchi_migrations'")).data).toEqual([]);
  });

  it('preserves sparse rowids across rebuilds of tables without an integer primary key', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first: SchemaDsl = { name: 'rowids', version: 1, tables: { accounts: { key: 'text primary key', value: 'text' } } };
    await runMigrations({ execute, client, schema: first });
    await execute("INSERT INTO accounts (rowid, key, value) VALUES (17, 'a', 'one'), (93, 'b', 'two')");
    const second: SchemaDsl = { ...first, version: 2, tables: { accounts: { key: 'text primary key', value: 'text not null' } } };
    await runMigrations({ execute, client, schema: second });
    expect((await execute('SELECT rowid, key, value FROM accounts ORDER BY rowid')).data).toEqual([
      { rowid: 17, key: 'a', value: 'one' }, { rowid: 93, key: 'b', value: 'two' },
    ]);
  });

  it('rejects a newly introduced rowid alias before a rebuild', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first: SchemaDsl = { name: 'shadow_rowid', version: 1, tables: { accounts: { key: 'text primary key', value: 'text' } } };
    await runMigrations({ execute, client, schema: first });
    await execute("INSERT INTO accounts (rowid, key, value) VALUES (93, 'a', 'one')");
    const second: SchemaDsl = { ...first, version: 2, tables: { accounts: { key: 'text primary key', value: 'text not null', rowid: 'integer' } } };
    await expect(runMigrations({ execute, client, schema: second })).rejects.toThrow('shadows the row identifier');
    expect((await execute('SELECT rowid FROM accounts')).data).toEqual([{ rowid: 93 }]);
  });

  it('rolls back every table when a later table fails validation', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first: SchemaDsl = { name: 'multi_rollback', version: 1, tables: {
      accounts: { id: 'integer primary key', value: 'text' }, atomic_second: { id: 'integer primary key', value: 'text' },
    } };
    await runMigrations({ execute, client, schema: first });
    await execute("INSERT INTO accounts VALUES (1, 'ok')");
    await execute('INSERT INTO atomic_second VALUES (1, NULL)');
    const second: SchemaDsl = { ...first, version: 2, tables: {
      accounts: { id: 'integer primary key', value: 'text not null' }, atomic_second: { id: 'integer primary key', value: 'text not null' },
    } };
    await expect(runMigrations({ execute, client, schema: second })).rejects.toThrow(/NOT NULL/);
    expect((await execute('PRAGMA table_info(accounts)')).data).toContainEqual(expect.objectContaining({ name: 'value', notnull: 0 }));
    expect((await execute('SELECT version FROM _kuratchi_migrations')).data).toEqual([{ version: 1 }]);
    expect((await execute("SELECT name FROM sqlite_master WHERE name LIKE '_kunii_rebuild_%'")).data).toEqual([]);
    await execute("UPDATE atomic_second SET value = 'fixed'");
    await runMigrations({ execute, client, schema: second });
    expect(await hasPendingMigrations({ execute, schema: second })).toBe(false);
  });

  it('preserves quoted identifiers and literal whitespace through repeated rebuilds', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first: SchemaDsl = { name: 'literal', version: 1, tables: { accounts: {
      id: 'integer primary key', 'display-name': 'text default "a;  b"',
    } } };
    await runMigrations({ execute, client, schema: first });
    await execute('INSERT INTO accounts (id) VALUES (1)');
    const second: SchemaDsl = { ...first, version: 2, tables: { accounts: {
      id: 'integer primary key', 'display-name': 'text not null default "a;  b"',
    } } };
    await runMigrations({ execute, client, schema: second });
    const third: SchemaDsl = { ...second, version: 3, tables: { accounts: {
      id: 'integer primary key', 'display-name': 'text not null default "new;  value"',
    } } };
    await runMigrations({ execute, client, schema: third });
    await execute('INSERT INTO accounts (id) VALUES (2)');
    expect((await execute('SELECT "display-name" AS value FROM accounts ORDER BY id')).data).toEqual([{ value: 'a;  b' }, { value: 'new;  value' }]);
  });

  it('keeps a failed init retryable and caches successful initialization without database reads', async () => {
    const execute = d1Executor(env.DB);
    const first = schema(1);
    await runMigrations({ execute, client: d1RawClient(env.DB), schema: first });
    await execute("INSERT INTO accounts (email) VALUES ('duplicate'), ('duplicate')");
    const second = { ...first, version: 2, tables: { accounts: { id: 'integer primary key', email: 'text not null unique' } } };
    const runtime = initKuniiORM({ DB: second });
    await expect(runtime.migrateOnce({ DB: env.DB })).rejects.toThrow(/UNIQUE/);
    await execute("UPDATE accounts SET email = 'fixed' WHERE id = 2");
    expect((await runtime.migrateOnce({ DB: env.DB })).DB.applied).toBe(true);
    // Removing the table after success makes another database migration observably different.
    await execute('DROP TABLE accounts');
    expect((await runtime.migrateOnce({ DB: env.DB })).DB.applied).toBe(true);
    expect((await execute("SELECT name FROM sqlite_master WHERE name = 'accounts'")).data).toEqual([]);
  });

  it('keeps adopted constraints pending instead of claiming the desired schema exists', async () => {
    const execute = d1Executor(env.DB);
    await execute('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT)');
    const target = schema(1, { email: 'text not null unique' });
    const result = await runMigrations({ execute, client: d1RawClient(env.DB), schema: target });
    expect(result).toMatchObject({ applied: false, statementsRun: 0 });
    expect(result.warnings.join(' ')).toContain('Column definition changed');
    expect(await hasPendingMigrations({ execute, schema: target })).toBe(true);
    expect((await execute('SELECT * FROM _kuratchi_migrations')).data).toEqual([]);
  });

  it('repairs a partial default migration and rebuilds after an ordinary ADD COLUMN', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1);
    await runMigrations({ execute, client, schema: first });
    const added = { ...first, version: 2, tables: { accounts: { ...first.tables.accounts, phone: 'text' } } };
    await runMigrations({ execute, client, schema: added });
    const tightened = { ...added, version: 3, tables: { accounts: { ...added.tables.accounts, phone: 'text unique' } } };
    await runMigrations({ execute, client, schema: tightened });
    const defaults = { ...tightened, version: 4, tables: { accounts: { ...tightened.tables.accounts, created: 'text default now' } } };
    await runMigrations({ execute, schema: defaults });
    expect(await hasPendingMigrations({ execute, schema: defaults })).toBe(true);
    await runMigrations({ execute, client, schema: defaults });
    expect(await hasPendingMigrations({ execute, schema: defaults })).toBe(false);
    await execute("INSERT INTO accounts (email) VALUES ('a')");
    expect((await execute('SELECT created FROM accounts')).data).toEqual([{ created: expect.any(String) }]);
  });

  it('reads foreign-key dependencies once when rebuilding multiple tables', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first: SchemaDsl = {
      name: 'dependency_reads', version: 1,
      tables: { perf_left: { id: 'integer primary key', value: 'text' }, perf_right: { id: 'integer primary key', value: 'text' } },
    };
    await runMigrations({ execute, client, schema: first });
    await execute('CREATE VIEW unrelated_perf_view AS SELECT 1 AS value');
    const second: SchemaDsl = {
      ...first, version: 2,
      tables: { perf_left: { id: 'integer primary key', value: 'text unique' }, perf_right: { id: 'integer primary key', value: 'text unique' } },
    };
    const queries: string[] = [];
    await runMigrations({ execute: async (sql, params) => { queries.push(sql); return execute(sql, params); }, client, schema: second });
    expect(queries.filter(sql => sql.includes('JOIN pragma_foreign_key_list'))).toHaveLength(1);
    await execute('DROP VIEW unrelated_perf_view');
  });

  it('renames populated columns across skipped versions and accepts retained or removed hints', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1, { phone: 'text' }, { accounts: { phone_lookup: { columns: ['phone'] } } });
    await runMigrations({ execute, client, schema: first });
    await execute("INSERT INTO accounts (id, email, phone) VALUES (1, 'a', '555')");
    const renamed = { ...first, version: 3, tables: { accounts: { id: 'integer primary key', email: 'text not null', mobile: 'text renameFrom phone' } }, indexes: { accounts: { phone_lookup: { columns: ['mobile'] } } } };
    expect(await runMigrations({ execute, client, schema: renamed })).toMatchObject({
      statementsRun: 1, warnings: [expect.stringContaining('application code using the old name')],
    });
    expect(await runMigrations({ execute, client, schema: { ...renamed, version: 4 } })).toMatchObject({ statementsRun: 0 });
    const cleaned = { ...renamed, version: 5, tables: { accounts: { ...renamed.tables.accounts, mobile: 'text' } } };
    await runMigrations({ execute, client, schema: cleaned });
    expect((await execute('SELECT mobile FROM accounts')).data).toEqual([{ mobile: '555' }]);
    expect((await execute('PRAGMA table_info(accounts)')).data).not.toContainEqual(expect.objectContaining({ name: 'phone' }));
    const indexed = { ...cleaned, version: 6, indexes: { accounts: { phone_lookup: { columns: ['mobile'], unique: true } } } };
    expect(await runMigrations({ execute, client, schema: indexed })).toMatchObject({ statementsRun: 2, warnings: [] });
  });

  it('creates the destination on a fresh database and rejects ambiguous rename hints', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const target = schema(2, { mobile: 'text renameFrom phone' });
    await runMigrations({ execute, client, schema: target });
    expect((await execute('PRAGMA table_info(accounts)')).data).toContainEqual(expect.objectContaining({ name: 'mobile' }));
    const ambiguous = { ...target, version: 3, tables: { accounts: { id: 'integer primary key', email: 'text not null', mobile: 'text renameFrom phone', office: 'text renameFrom phone' } } };
    await expect(runMigrations({ execute, client, schema: ambiguous })).rejects.toThrow('Ambiguous renameFrom');
  });

  it('rejects conflicting rename destinations before applying other changes', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1, { phone: 'text', mobile: 'text' });
    await runMigrations({ execute, client, schema: first });
    const target = { ...first, version: 2, tables: { accounts: { id: 'integer primary key', email: 'text not null', extra: 'text', mobile: 'text renameFrom phone' } } };
    await expect(runMigrations({ execute, client, schema: target })).rejects.toThrow('also exists');
    expect((await execute('PRAGMA table_info(accounts)')).data).not.toContainEqual(expect.objectContaining({ name: 'extra' }));
  });

  it('rebuilds constraints atomically and preserves data and indexes', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1, {}, { accounts: { lookup: { columns: ['email'] } } });
    await runMigrations({ execute, client, schema: first });
    await execute("INSERT INTO accounts (id, email) VALUES (7, 'a'), (8, 'a')");
    await execute('CREATE TABLE rebuild_audit (account_id INTEGER)');
    await execute('CREATE TRIGGER account_audit AFTER INSERT ON accounts BEGIN INSERT INTO rebuild_audit VALUES (new.id); END');
    const target = { ...first, version: 2, tables: { accounts: { id: 'integer primary key', email: 'text not null unique' } } };
    await expect(runMigrations({ execute, client, schema: target })).rejects.toThrow(/UNIQUE/);
    expect((await execute('SELECT id FROM accounts ORDER BY id')).data).toEqual([{ id: 7 }, { id: 8 }]);
    await execute("UPDATE accounts SET email = 'b' WHERE id = 8");
    expect(await runMigrations({ execute, client, schema: target })).toMatchObject({ applied: true, warnings: [] });
    await expect(execute("INSERT INTO accounts (email) VALUES ('a')")).rejects.toThrow(/UNIQUE/);
    expect((await execute('PRAGMA index_list(accounts)')).data).toContainEqual(expect.objectContaining({ name: 'lookup' }));
    expect((await execute('SELECT id FROM accounts ORDER BY id')).data).toEqual([{ id: 7 }, { id: 8 }]);
    await execute("INSERT INTO accounts (id, email) VALUES (9, 'c')");
    expect((await execute('SELECT account_id FROM rebuild_audit')).data).toEqual([{ account_id: 9 }]);
  });

  it('rejects parent rebuilds before cascades can delete child rows', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1);
    await runMigrations({ execute, client, schema: first });
    await execute("INSERT INTO accounts (id, email) VALUES (1, 'a')");
    await execute('CREATE TABLE rebuild_child (id INTEGER REFERENCES accounts(id) ON DELETE CASCADE)');
    await execute('INSERT INTO rebuild_child VALUES (1)');
    try {
      const target = { ...first, version: 2, tables: { accounts: { id: 'integer primary key', email: 'text not null unique' } } };
      await expect(runMigrations({ execute, client, schema: target })).rejects.toThrow('incoming foreign keys');
      expect((await execute('SELECT id FROM rebuild_child')).data).toEqual([{ id: 1 }]);
    } finally {
      await execute('DROP TABLE rebuild_child');
    }
  });

  beforeEach(async () => {
    const execute = d1Executor(env.DB);
    await execute('DROP TABLE IF EXISTS accounts');
    await execute('DROP TABLE IF EXISTS _kuratchi_migrations');
  });
  it('preserves data on rollback and when a column is renamed in the DSL', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1);
    const second = { ...first, version: 2, tables: { accounts: { ...first.tables.accounts, phone: 'text' } } };
    await runMigrations({ execute, client, schema: first });
    await runMigrations({ execute, client, schema: second });
    await execute("INSERT INTO accounts (id, email, phone) VALUES (1, 'a@b.com', '555')");
    const rolledBack = await runMigrations({ execute, client, schema: first });
    expect(rolledBack).toMatchObject({ applied: false, statementsRun: 0 });
    expect(rolledBack.warnings[0]).toContain('older');
    expect(await hasPendingMigrations({ execute, schema: first })).toBe(false);

    const renamed = { ...first, version: 3, tables: { accounts: { ...first.tables.accounts, mobile: 'text' } } };
    const runtime = initKuniiORM({ DB: renamed });
    const warnings = vi.spyOn(console, 'warn');
    try {
      const result = await runtime.migrateOnce({ DB: env.DB });
      expect(result.DB.warnings).toEqual([expect.stringContaining('"phone"')]);
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining('"phone"'));
      expect((await execute('SELECT phone, mobile FROM accounts')).data).toEqual([{ phone: '555', mobile: null }]);
    } finally {
      warnings.mockRestore();
    }
  });

  it('adopts existing tables and upgrades legacy history without touching unmanaged data', async () => {
    const execute = d1Executor(env.DB);
    await execute('CREATE TABLE "order" (id INTEGER PRIMARY KEY, unmanaged TEXT)');
    await execute('CREATE INDEX "order index" ON "order"(unmanaged)');
    await execute("INSERT INTO \"order\" VALUES (1, 'keep')");
    await execute('CREATE TABLE unrelated (id INTEGER)');
    await execute(`CREATE TABLE _kuratchi_migrations (
      schema_name TEXT, version INTEGER, schema_hash TEXT, statements_run INTEGER, UNIQUE(schema_name, version)
    )`);
    await execute("INSERT INTO _kuratchi_migrations VALUES ('adopt', 4, 'old', 1)");
    const target: SchemaDsl = { name: 'adopt', version: 2, tables: { order: { id: 'integer primary key', extra: 'text' } } };
    const result = await runMigrations({ execute, schema: target });
    expect(result.statementsRun).toBe(1);
    expect(result.warnings.join(' ')).not.toContain('unrelated');
    expect((await execute('SELECT unmanaged, extra FROM "order"')).data).toEqual([{ unmanaged: 'keep', extra: null }]);
    expect((await execute('PRAGMA index_list("order")')).data).toEqual([expect.objectContaining({ name: 'order index' })]);
    expect((await execute('SELECT version FROM _kuratchi_migrations ORDER BY version')).data).toEqual([{ version: 4 }, { version: 5 }]);
  });

  it('recovers when two D1 isolates plan the same migration and rolls back failed batches', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1);
    await runMigrations({ execute, client, schema: first });
    const second = { ...first, version: 2, tables: { accounts: { ...first.tables.accounts, phone: 'text' } } };
    let arrivals = 0;
    let release!: () => void;
    const bothPlanned = new Promise<void>(resolve => { release = resolve; });
    const historyStatements = new WeakSet<object>();
    const racingClient = {
      ...client,
      prepare(sql: string) {
        const statement = client.prepare(sql);
        if (!sql.startsWith('INSERT INTO _kuratchi_migrations')) return statement;
        return {
          bind(...params: any[]) {
            const bound = statement.bind(...params);
            historyStatements.add(bound);
            return bound;
          },
        };
      },
      async batch(statements: any[]) {
        if (historyStatements.has(statements[0])) {
          if (++arrivals === 2) release();
          await bothPlanned;
        }
        return client.batch(statements);
      },
    };
    const results = await Promise.all([
      runMigrations({ execute, client: racingClient, schema: second }),
      runMigrations({ execute, client: racingClient, schema: second }),
    ]);
    expect(results.map(result => result.statementsRun).sort()).toEqual([0, 1]);

    await execute("INSERT INTO accounts (email) VALUES ('duplicate'), ('duplicate')");
    const bad: SchemaDsl = {
      ...second,
      version: 3,
      tables: { accounts: { ...second.tables.accounts, tier: 'text' } },
      indexes: { accounts: { unique_email: { columns: ['email'], unique: true } } },
    };
    await expect(runMigrations({ execute, client, schema: bad })).rejects.toThrow(/UNIQUE/);
    expect((await execute('PRAGMA table_info(accounts)')).data).not.toContainEqual(expect.objectContaining({ name: 'tier' }));
    expect((await execute('SELECT version FROM _kuratchi_migrations ORDER BY version')).data).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('reports unsupported column and index changes without recording them as applied', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1, {}, { accounts: { lookup: { columns: ['email'] } } });
    await runMigrations({ execute, client, schema: first });
    const second: SchemaDsl = {
      ...first,
      version: 1,
      tables: { accounts: { id: 'integer primary key', email: 'text unique' } },
      indexes: { accounts: { lookup: { columns: ['id'], unique: true } } },
    };
    await expect(runMigrations({ execute, client, schema: second })).rejects.toThrow('immutable');
    second.version = 2;
    const result = await runMigrations({ execute, schema: second });
    expect(result).toMatchObject({ applied: false, statementsRun: 0 });
    expect(result.warnings).toEqual([expect.stringContaining('Column definition changed'), expect.stringContaining('Index "lookup" changed')]);
    expect(await hasPendingMigrations({ execute, schema: second })).toBe(true);
    expect((await execute('SELECT version FROM _kuratchi_migrations')).data).toEqual([{ version: 1 }]);

    const mixed = { ...second, tables: { accounts: { ...second.tables.accounts, phone: 'text' } } };
    expect(await runMigrations({ execute, schema: mixed })).toMatchObject({ statementsRun: 1 });
    expect(await hasPendingMigrations({ execute, schema: mixed })).toBe(true);
    expect(await runMigrations({ execute, schema: mixed })).toMatchObject({
      applied: false,
      warnings: [expect.stringContaining('Column definition changed'), expect.stringContaining('Index "lookup" changed')],
    });
  });

  it('replaces a Kunii-owned index on a forward migration and preserves it on rollback', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const first = schema(1, {}, { accounts: { lookup: { columns: ['email'] } } });
    const second: SchemaDsl = { ...first, version: 2, indexes: { accounts: { lookup: { columns: ['id'], unique: true } } } };
    await runMigrations({ execute, client, schema: first });
    await execute("INSERT INTO accounts (email) VALUES ('duplicate'), ('duplicate')");
    const incompatible = { ...first, version: 2, indexes: { accounts: { lookup: { columns: ['email'], unique: true } } } };
    await expect(runMigrations({ execute, client, schema: incompatible })).rejects.toThrow(/UNIQUE/);
    expect((await execute('PRAGMA index_list(accounts)')).data).toEqual([expect.objectContaining({ name: 'lookup', unique: 0 })]);
    expect(await runMigrations({ execute, client, schema: second })).toMatchObject({ statementsRun: 2, warnings: [] });
    await runMigrations({ execute, client, schema: first });
    expect((await execute('PRAGMA index_list(accounts)')).data).toEqual([expect.objectContaining({ name: 'lookup', unique: 1 })]);
    expect((await execute('PRAGMA index_info(lookup)')).data).toEqual([expect.objectContaining({ name: 'id' })]);
  });

  it('preserves an adopted index even when a newer schema changes its definition', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    await execute('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL)');
    await execute('CREATE INDEX lookup ON accounts (email)');
    const first = schema(1, {}, { accounts: { lookup: { columns: ['email'] } } });
    expect(await runMigrations({ execute, client, schema: first })).toMatchObject({ applied: false, warnings: [] });
    const second = { ...first, version: 2, indexes: { accounts: { lookup: { columns: ['id'] } } } };
    expect(await runMigrations({ execute, client, schema: second })).toMatchObject({
      applied: false,
      warnings: [expect.stringContaining('Index "lookup" changed')],
    });
    expect((await execute('PRAGMA index_info(lookup)')).data).toEqual([expect.objectContaining({ name: 'email' })]);
  });

  it('executes SQL literals with semicolons and parses spaced defaults and FK actions', async () => {
    const execute = d1Executor(env.DB);
    const client = d1RawClient(env.DB);
    const target: SchemaDsl = {
      name: 'defaults',
      tables: {
        parent: { id: 'integer primary key' },
        child: {
          id: 'integer primary key',
          label: 'text default "a;b c"',
          stamp: "integer default (strftime('%s', 'now'))",
          nullable: 'integer -> parent.id SET NULL',
          fallback: 'integer default 0 -> parent.id set default',
          fixed: 'integer -> parent.id no action',
        },
      },
    };
    await runMigrations({ execute, client, schema: target });
    await execute('INSERT INTO parent VALUES (0), (1)');
    await execute('INSERT INTO child (nullable, fallback, fixed) VALUES (1, 1, 0)');
    await execute('DELETE FROM parent WHERE id = 1');
    expect((await execute('SELECT label, stamp, nullable, fallback FROM child')).data).toEqual([
      { label: 'a;b c', stamp: expect.any(Number), nullable: null, fallback: 0 },
    ]);
    expect((await execute('PRAGMA foreign_key_list(child)')).data).toContainEqual(expect.objectContaining({ from: 'fixed', on_delete: 'NO ACTION' }));
  });

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
    expect(result.warnings).toEqual([]);

    const rows = await execute('SELECT id, email, tier, created_at FROM accounts');
    expect((rows.data as any[])[0].tier).toBe('free');
    expect((rows.data as any[])[0].created_at).toBeTruthy();
    await execute("INSERT INTO accounts (id, email) VALUES (2, 'new@example.com')");
    expect((await execute('SELECT created_at FROM accounts WHERE id = 2')).data).toEqual([{ created_at: expect.any(Number) }]);

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
    expect(result.warnings).toEqual([]);

    const rows = await stub.exec('SELECT id, email, tier, created_at FROM accounts');
    expect(rows[0].tier).toBe('free');
    expect(rows[0].created_at).toBeTruthy();

    const indexes = await stub.exec('PRAGMA index_list(accounts)');
    expect(indexes.some((row: any) => row.name === 'accounts_email_idx')).toBe(true);
  });
});

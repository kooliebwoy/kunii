import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { initKuniiORM } from '../../src/init.js';
import { splitSqlStatements } from '../../src/migrations/utils.js';
import type { SchemaDsl } from '../../src/types.js';

async function database(backend: 'D1' | 'DO') {
  const table = 'parity_' + crypto.randomUUID().replaceAll('-', '');
  const stub = env.TEST_DO.get(env.TEST_DO.idFromName(table));
  const exec = async (sql: string): Promise<any[]> => {
    if (backend === 'D1') return (await env.DB.prepare(sql).all()).results;
    const result = await stub.execChecked(sql);
    if (result.error) throw new Error(result.error);
    return result.rows;
  };
  const migrate = async (schema: SchemaDsl) => {
    if (backend === 'DO') {
      const result = await stub.initializeSchema(schema);
      if (!result.success) throw new Error(result.error);
    } else await initKuniiORM({ DB: schema }).migrateOnce({ DB: env.DB });
  };
  const schema = (version: number, columns: Record<string, string>): SchemaDsl => ({
    name: table, version, tables: { [table]: { id: 'integer primary key', ...columns } },
  });
  const history = () => exec(`SELECT version FROM _kuratchi_migrations WHERE schema_name = '${table}' ORDER BY version`);
  return { table, exec, migrate, schema, history };
}

describe.each(['D1', 'DO'] as const)('%s public initialization migration parity', backend => {
  it('parses spaced defaults and all multiword foreign-key actions', async () => {
    const { table, exec, migrate } = await database(backend);
    await migrate({ name: table, version: 1, tables: {
      [table]: { id: 'integer primary key' },
      [table + '_child']: {
        id: 'integer primary key',
        nullable: `integer -> ${table}.id set null`,
        fallback: `integer default 0 -> ${table}.id set default`,
        fixed: `integer -> ${table}.id no action`,
        created: "integer default (strftime('%s', 'now'))",
      },
    } });
    await exec(`INSERT INTO ${table} VALUES (0), (1)`);
    await exec(`INSERT INTO ${table}_child (id, nullable, fallback, fixed) VALUES (1, 1, 1, 0)`);
    await exec(`DELETE FROM ${table} WHERE id = 1`);
    expect(await exec(`SELECT nullable, fallback, fixed, created FROM ${table}_child`)).toEqual([
      { nullable: null, fallback: 0, fixed: 0, created: expect.any(Number) },
    ]);
  });

  it('keeps mismatched adopted FTS definitions pending on both backends', async () => {
    const { table, exec, migrate, history } = await database(backend);
    await exec(`CREATE VIRTUAL TABLE ${table} USING fts5(old_content)`);
    await exec(`INSERT INTO ${table} (old_content) VALUES ('keep searchable')`);
    await migrate({ name: table, version: 1, tables: {}, virtualTables: {
      [table]: { module: 'fts5', columns: ['new_content'] },
    } });
    expect(await history()).toHaveLength(0);
    expect(await exec(`SELECT old_content FROM ${table} WHERE ${table} MATCH 'searchable'`)).toEqual([{ old_content: 'keep searchable' }]);
  });

  it('preserves data through rename, rebuild, raw defaults, repeated hints, and rollback', async () => {
    const { table, exec, migrate, schema, history } = await database(backend);
    const first = schema(1, { phone: 'text' });
    await migrate(first);
    await exec(`INSERT INTO ${table} VALUES (1, '555')`);
    await migrate(schema(3, { mobile: 'text renameFrom phone' }));
    await migrate(schema(4, { mobile: 'text renameFrom phone' }));
    const final = schema(5, { mobile: 'text not null unique', created: "text default (strftime('%s', 'now'))", label: 'text default "a;b"' });
    await migrate(final);
    await migrate(final);
    await migrate(first);
    expect(await exec(`SELECT mobile, label, created IS NOT NULL AS stamped FROM ${table}`)).toEqual([{ mobile: '555', label: 'a;b', stamped: 1 }]);
    await exec(`INSERT INTO ${table} (id, mobile) VALUES (2, '666')`);
    expect(await exec(`SELECT COUNT(*) AS n FROM ${table} WHERE created IS NOT NULL`)).toEqual([{ n: 2 }]);
    expect(await history()).toHaveLength(4);
  });

  it('rolls back invalid data and permits a corrected retry', async () => {
    const { table, exec, migrate, schema, history } = await database(backend);
    await migrate(schema(1, { email: 'text' }));
    await exec(`INSERT INTO ${table} VALUES (1, 'same'), (2, 'same')`);
    const next = schema(2, { email: 'text unique' });
    await expect(migrate(next)).rejects.toThrow(/UNIQUE/);
    expect(await history()).toHaveLength(1);
    expect(await exec(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 2 }]);
    await exec(`UPDATE ${table} SET email = 'other' WHERE id = 2`);
    await migrate(next);
    await expect(exec(`INSERT INTO ${table} VALUES (3, 'same')`)).rejects.toThrow(/UNIQUE/);
  });

  it('enforces version immutability and rejects conflicting rename destinations', async () => {
    const { table, exec, migrate, schema, history } = await database(backend);
    await migrate(schema(1, { old: 'text', destination: 'text' }));
    await expect(migrate(schema(1, { changed: 'text' }))).rejects.toThrow('immutable');
    await expect(migrate(schema(2, { destination: 'text renameFrom old' }))).rejects.toThrow('also exists');
    expect(await history()).toHaveLength(1);
    expect((await exec(`PRAGMA table_info(${table})`)).map(row => row.name)).toEqual(['id', 'old', 'destination']);
  });

  it('preserves adopted data and indexes and keeps unverified constraints pending', async () => {
    const { table, exec, migrate, schema, history } = await database(backend);
    await exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, email TEXT, extra TEXT)`);
    await exec(`CREATE INDEX ${table}_extra ON ${table}(extra)`);
    await exec(`INSERT INTO ${table} VALUES (1, NULL, 'keep')`);
    await migrate(schema(1, { email: 'text not null unique' }));
    expect(await history()).toHaveLength(0);
    expect(await exec(`SELECT extra FROM ${table}`)).toEqual([{ extra: 'keep' }]);
    expect(await exec(`PRAGMA index_list(${table})`)).toContainEqual(expect.objectContaining({ name: table + '_extra' }));
  });

  it('automatically replaces an owned index and preserves it on code rollback', async () => {
    const { table, exec, migrate, schema } = await database(backend);
    const first = { ...schema(1, { email: 'text' }), indexes: { [table]: { [table + '_lookup']: { columns: ['email'] } } } };
    await migrate(first);
    await migrate({ ...first, version: 2, indexes: { [table]: { [table + '_lookup']: { columns: ['id'], unique: true } } } });
    await migrate(first);
    expect(await exec(`PRAGMA index_info(${table}_lookup)`)).toEqual([expect.objectContaining({ name: 'id' })]);
    expect(await exec(`PRAGMA index_list(${table})`)).toContainEqual(expect.objectContaining({ unique: 1 }));
  });

  it('protects cascading child rows and permits native parent-column renames', async () => {
    const { table, exec, migrate, schema } = await database(backend);
    await migrate(schema(1, { label: 'text' }));
    await exec(`INSERT INTO ${table} VALUES (1, 'keep')`);
    await exec(`CREATE TABLE ${table}_child (parent INTEGER REFERENCES ${table}(id) ON DELETE CASCADE)`);
    await exec(`INSERT INTO ${table}_child VALUES (1)`);
    await expect(migrate(schema(2, { label: 'text unique' }))).rejects.toThrow('incoming foreign keys');
    await migrate({ name: table, version: 2, tables: { [table]: { key: 'integer primary key renameFrom id', label: 'text' } } });
    expect(await exec(`SELECT parent FROM ${table}_child`)).toEqual([{ parent: 1 }]);
    expect(await exec(`PRAGMA foreign_key_list(${table}_child)`)).toContainEqual(expect.objectContaining({ to: 'key' }));
  });

  it('preserves multi-statement triggers and semicolon literals through rebuilds', async () => {
    const { table, exec, migrate, schema } = await database(backend);
    await migrate(schema(1, { value: 'text' }));
    const script = `CREATE TABLE ${table}_audit (value TEXT);
      CREATE TRIGGER ${table}_trigger AFTER INSERT ON ${table} BEGIN
        INSERT INTO ${table}_audit VALUES (CASE WHEN new.value IS NULL THEN 'null;' ELSE new.value END);
        INSERT INTO ${table}_audit VALUES ('second;');
      END;`;
    for (const statement of splitSqlStatements(script)) await exec(statement);
    await migrate(schema(2, { value: 'text not null default "a;b"' }));
    await exec(`INSERT INTO ${table} (id) VALUES (1)`);
    expect(await exec(`SELECT value FROM ${table}_audit ORDER BY rowid`)).toEqual([{ value: 'a;b' }, { value: 'second;' }]);
  });

  it('preserves every row through a populated rebuild', async () => {
    const { table, exec, migrate, schema } = await database(backend);
    await migrate(schema(1, { value: 'text' }));
    await exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500)
      INSERT INTO ${table} SELECT i, 'value-' || i FROM n`);
    await migrate(schema(2, { value: 'text not null unique' }));
    expect(await exec(`SELECT COUNT(*) AS n, SUM(id) AS total FROM ${table} WHERE value = 'value-' || id`)).toEqual([{ n: 500, total: 125250 }]);
  });
});

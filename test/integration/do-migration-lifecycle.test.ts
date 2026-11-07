import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { initKuniiDO } from '../../src/init.js';
import { runDurableObjectMigrations } from '../../src/migrations/durable-object.js';
import type { SchemaDsl } from '../../src/types.js';

function object() {
  const id = env.TEST_DO.idFromName(crypto.randomUUID());
  return { id, stub: env.TEST_DO.get(id) };
}

function schema(version: number, extra: Record<string, string> = {}): SchemaDsl {
  return { name: 'lifecycle', version, tables: { lifecycle: { id: 'integer primary key', email: 'text', ...extra } } };
}

describe('Durable Object migration lifecycle', () => {
  it('preserves non-SQL storage and alarm state during a SQLite rebuild', async () => {
    const { stub } = object();
    const result = await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('lifecycle-sentinel', { value: 'keep' });
      const alarm = Date.now() + 3_600_000;
      await state.storage.setAlarm(alarm);
      initKuniiDO(state.storage, schema(1));
      state.storage.sql.exec("INSERT INTO lifecycle VALUES (1, 'a')");
      initKuniiDO(state.storage, schema(2, { email: 'text not null unique' }));
      const value = await state.storage.get('lifecycle-sentinel');
      const actualAlarm = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      return { value, alarm, actualAlarm };
    });
    expect(result.value).toEqual({ value: 'keep' });
    expect(result.actualAlarm).toBe(result.alarm);
  });

  it('adopts legacy DO tables without history while preserving unmanaged columns and indexes', async () => {
    const { stub } = object();
    const result = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE lifecycle (id INTEGER PRIMARY KEY, email TEXT, unmanaged TEXT)');
      state.storage.sql.exec('CREATE INDEX lifecycle_unmanaged ON lifecycle(unmanaged)');
      state.storage.sql.exec("INSERT INTO lifecycle VALUES (1, 'a', 'keep')");
      const migration = runDurableObjectMigrations(state.storage, schema(2, { phone: 'text' }));
      return {
        migration,
        rows: state.storage.sql.exec('SELECT unmanaged, phone FROM lifecycle').toArray(),
        indexes: state.storage.sql.exec('PRAGMA index_list(lifecycle)').toArray(),
      };
    });
    expect(result.migration).toMatchObject({ applied: true, statementsRun: 1, isInitial: true });
    expect(result.rows).toEqual([{ unmanaged: 'keep', phone: null }]);
    expect(result.indexes).toContainEqual(expect.objectContaining({ name: 'lifecycle_unmanaged' }));
  });

  it('completes initialization and all migration SQL before the first microtask', async () => {
    const { stub } = object();
    const result = await runInDurableObject(stub, (_instance, state) => {
      let microtaskRan = false;
      queueMicrotask(() => { microtaskRan = true; });
      const client = initKuniiDO(state.storage, schema(1));
      const migration = runDurableObjectMigrations(state.storage, schema(2, { phone: 'text' }));
      return {
        microtaskRan, promise: migration instanceof Promise, client: !!client,
        columns: state.storage.sql.exec('PRAGMA table_info(lifecycle)').toArray().map(row => row.name),
      };
    });
    expect(result).toEqual({ microtaskRan: false, promise: false, client: true, columns: ['id', 'email', 'phone'] });
  });

  it('rolls migration DDL and history back when an enclosing transactionSync fails', async () => {
    const { stub } = object();
    const result = await runInDurableObject(stub, (_instance, state) => {
      initKuniiDO(state.storage, schema(1));
      state.storage.sql.exec("INSERT INTO lifecycle VALUES (1, 'keep')");
      let message = '';
      try {
        state.storage.transactionSync(() => {
          initKuniiDO(state.storage, schema(2, { email: 'text not null unique' }));
          throw new Error('outer rollback');
        });
      } catch (error) { message = (error as Error).message; }
      return {
        message,
        columns: state.storage.sql.exec('PRAGMA table_info(lifecycle)').toArray(),
        versions: state.storage.sql.exec("SELECT version FROM _kuratchi_migrations WHERE schema_name = 'lifecycle'").toArray(),
        rows: state.storage.sql.exec('SELECT * FROM lifecycle').toArray(),
      };
    });
    expect(result.message).toBe('outer rollback');
    expect(result.columns).toContainEqual(expect.objectContaining({ name: 'email', notnull: 0 }));
    expect(result.versions).toEqual([{ version: 1 }]);
    expect(result.rows).toEqual([{ id: 1, email: 'keep' }]);
  });

  it('can catch a failed nested migration, retain outer writes, and retry in the same event', async () => {
    const { stub } = object();
    const result = await runInDurableObject(stub, (_instance, state) => {
      initKuniiDO(state.storage, schema(1));
      state.storage.sql.exec("INSERT INTO lifecycle VALUES (1, 'same'), (2, 'same')");
      return state.storage.transactionSync(() => {
        state.storage.sql.exec("INSERT INTO lifecycle VALUES (3, 'outer')");
        const target = schema(2, { email: 'text unique' });
        let message = '';
        try { initKuniiDO(state.storage, target); }
        catch (error) { message = (error as Error).message; }
        const beforeRetry = state.storage.sql.exec("SELECT version FROM _kuratchi_migrations WHERE schema_name = 'lifecycle'").toArray();
        state.storage.sql.exec("UPDATE lifecycle SET email = 'fixed' WHERE id = 2");
        initKuniiDO(state.storage, target);
        return { message, beforeRetry, rows: state.storage.sql.exec('SELECT * FROM lifecycle ORDER BY id').toArray() };
      });
    });
    expect(result.message).toContain('UNIQUE');
    expect(result.beforeRetry).toEqual([{ version: 1 }]);
    expect(result.rows).toEqual([{ id: 1, email: 'same' }, { id: 2, email: 'fixed' }, { id: 3, email: 'outer' }]);
  });

  it('recovers migration history after the object is destroyed and recreated', async () => {
    const { id, stub } = object();
    await runInDurableObject(stub, (instance, state) => {
      (instance as any).lifecycleMarker = 'old instance';
      initKuniiDO(state.storage, schema(1, { phone: 'text' }));
      state.storage.sql.exec("INSERT INTO lifecycle VALUES (1, 'a', 'keep')");
      initKuniiDO(state.storage, schema(2, { mobile: 'text renameFrom phone' }));
    });
    await abortAllDurableObjects();
    const reopened = env.TEST_DO.get(id);
    const result = await runInDurableObject(reopened, (instance, state) => {
      const repeated = runDurableObjectMigrations(state.storage, schema(2, { mobile: 'text renameFrom phone' }));
      const rollback = runDurableObjectMigrations(state.storage, schema(1, { phone: 'text' }));
      return {
        marker: (instance as any).lifecycleMarker ?? null, repeated, rollback,
        rows: state.storage.sql.exec('SELECT mobile FROM lifecycle').toArray(),
      };
    });
    expect(result.marker).toBeNull();
    expect(result.repeated).toMatchObject({ applied: false, statementsRun: 0 });
    expect(result.rollback).toMatchObject({ applied: false, statementsRun: 0 });
    expect(result.rows).toEqual([{ mobile: 'keep' }]);
  });

  it('serializes simultaneous RPC initialization calls without duplicate migrations', async () => {
    const { stub } = object();
    expect((await stub.initializeSchema(schema(1))).success).toBe(true);
    const target = schema(2, { created: 'text default now' });
    const results = await Promise.all(Array.from({ length: 16 }, () => stub.initializeSchema(target)));
    expect(results.every(result => result.success)).toBe(true);
    expect(await stub.exec("SELECT version FROM _kuratchi_migrations WHERE schema_name = 'lifecycle' ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('keeps migration versions and data isolated between object IDs', async () => {
    const left = object().stub;
    const right = object().stub;
    await left.initializeSchema(schema(1));
    await right.initializeSchema(schema(1));
    await left.exec("INSERT INTO lifecycle VALUES (1, 'left')");
    await right.exec("INSERT INTO lifecycle VALUES (1, 'right')");
    await left.initializeSchema(schema(2, { phone: 'text' }));
    expect(await left.exec('SELECT email, phone FROM lifecycle')).toEqual([{ email: 'left', phone: null }]);
    expect(await right.exec('SELECT * FROM lifecycle')).toEqual([{ id: 1, email: 'right' }]);
    expect(await right.exec("SELECT version FROM _kuratchi_migrations WHERE schema_name = 'lifecycle'")).toEqual([{ version: 1 }]);
  });

  it('uses attached transaction support through the raw SQL alias and guards a bare wrapper', async () => {
    const { stub } = object();
    const result = await runInDurableObject(stub, (_instance, state) => {
      initKuniiDO(state.storage, schema(1, { phone: 'text' }));
      state.storage.sql.exec("INSERT INTO lifecycle VALUES (1, 'a', 'keep')");
      const target = schema(2, { mobile: 'text renameFrom phone' });
      let message = '';
      try { initKuniiDO({ exec: state.storage.sql.exec.bind(state.storage.sql) }, target); }
      catch (error) { message = (error as Error).message; }
      initKuniiDO(state.storage.sql, target);
      return { message, rows: state.storage.sql.exec('SELECT mobile FROM lifecycle').toArray() };
    });
    expect(result.message).toContain('atomic batch client');
    expect(result.rows).toEqual([{ mobile: 'keep' }]);
  });
});

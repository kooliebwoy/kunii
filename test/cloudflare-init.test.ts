import { describe, expect, it } from 'vitest';
import { initKuniiDO, initKuniiORM, initKuratchiDO, initKuratchiORM, kunii, kuniiORM, kuratchiORM } from '../src/index.js';
import { appSchema, MockD1Database, MockSqlStorage } from './cloudflare-helpers.js';

describe('Cloudflare ORM init', () => {
  it('accepts rename hints when initializing a fresh synchronous DO database', () => {
    expect(() => initKuniiDO(new MockSqlStorage(), {
      name: 'rename',
      version: 2,
      tables: { users: { mobile: 'text renameFrom phone' } },
    })).not.toThrow();
  });
  it('runs D1 migrations once per binding object and binding name', async () => {
    const d1 = new MockD1Database();
    const orm = initKuniiORM({ DB: appSchema });

    const first = await orm.migrateOnce({ DB: d1 });
    expect(await orm.migrateOnce({ DB: d1 })).toEqual(first);
    expect(first.DB).toMatchObject({ applied: true, statementsRun: 1, warnings: [] });

    expect(d1.batches).toHaveLength(1);
    expect(d1.batches[0][0]).toMatch(/^INSERT INTO _kuratchi_migrations/);
  });

  it('creates D1 clients without running migrations implicitly', async () => {
    const d1 = new MockD1Database();
    const orm = initKuniiORM({ DB: appSchema });

    const db = orm.db({ DB: d1 }, 'DB');
    await db.todos.many();

    expect(d1.calls.some((call) => call.sql.includes('_kuratchi_migrations'))).toBe(false);
    expect(d1.calls.at(-1)?.sql).toBe('SELECT * FROM todos');
  });

  it('creates all configured clients', async () => {
    const d1 = new MockD1Database();
    const orm = initKuniiORM({ DB: appSchema });

    const clients = orm.clients({ DB: d1 });

    expect(clients.DB).toBeTruthy();
    await clients.DB.todos.many();
    expect(d1.calls.at(-1)?.sql).toBe('SELECT * FROM todos');
  });

  it('throws clear missing binding errors', async () => {
    const orm = initKuniiORM({ DB: appSchema });

    await expect(orm.migrateOnce({})).rejects.toThrow('Missing D1 binding "DB"');
    expect(() => orm.db({}, 'DB')).toThrow('Missing D1 binding "DB"');
  });

  it('initializes Durable Object storage synchronously and returns a client', async () => {
    const sql = new MockSqlStorage();
    const storage = {
      sql,
      transactionSync(callback: () => void) {
        callback();
      },
    };

    const db = initKuniiDO(storage, appSchema);
    await db.todos.many();

    expect(sql.calls.some((sqlText) => sqlText.includes('CREATE TABLE'))).toBe(true);
    expect(sql.calls.at(-1)).toBe('SELECT * FROM todos');
  });

  it('keeps deprecated Kuratchi aliases wired to Kunii APIs', () => {
    expect(kuniiORM).toBe(kunii);
    expect(kuratchiORM).toBe(kuniiORM);
    expect(initKuratchiORM).toBe(initKuniiORM);
    expect(initKuratchiDO).toBe(initKuniiDO);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createRuntimeOrm } from '../src/orm.js';

/**
 * Update + delete are chain-only. There is no `db.users.delete({id})` shortcut
 * and no `db.users.update({...}).where(...).update()` builder form. Cardinality
 * is *always* derived from the chain — narrow the where (typically by primary
 * key) or chain `.limit(1)` to affect a single row. A where is required to
 * prevent accidental table-wide writes.
 */
describe('update', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute);
  });

  it('update with where clause affects matching rows', async () => {
    await db.table('users').where({ id: 1 }).update({ name: 'New' });
    expect(m.lastSql()).toBe('UPDATE users SET name = ? WHERE id = ?');
    expect(m.lastParams()).toEqual(['New', 1]);
  });

  it('update sets multiple columns', async () => {
    await db
      .table('users')
      .where({ id: 1 })
      .update({ name: 'New', tier: 'pro' });
    expect(m.lastSql()).toBe(
      'UPDATE users SET name = ?, tier = ? WHERE id = ?'
    );
    expect(m.lastParams()).toEqual(['New', 'pro', 1]);
  });

  it('update on broad where affects all matches (cardinality from chain)', async () => {
    await db
      .table('users')
      .where({ tier: 'free' })
      .update({ banner_seen: 1 });
    expect(m.lastSql()).toBe(
      'UPDATE users SET banner_seen = ? WHERE tier = ?'
    );
    expect(m.lastParams()).toEqual([1, 'free']);
  });

  it('update honors orderBy and limit for SQLite/D1 top-N writes', async () => {
    await db
      .table('users')
      .where({ verified: false })
      .orderBy({ name: 'asc' })
      .limit(2)
      .update({ verified: true });

    expect(m.lastSql()).toBe(
      'UPDATE users SET verified = ? WHERE verified = ? ORDER BY name ASC LIMIT 2'
    );
    expect(m.lastParams()).toEqual([true, false]);
  });

  it('update without where rejects (safety guard)', async () => {
    const res = await db.table('users').update({ name: 'X' });
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/where clause/);
  });

  it('update with empty values rejects', async () => {
    const res = await db.table('users').where({ id: 1 }).update({});
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/No update values/);
  });

  it('update omits undefined fields instead of binding undefined', async () => {
    await db
      .table('users')
      .where({ id: 1 })
      .update({ name: undefined, tier: 'pro' });
    expect(m.lastSql()).toBe('UPDATE users SET tier = ? WHERE id = ?');
    expect(m.lastParams()).toEqual(['pro', 1]);
  });

  it('update with only undefined values rejects', async () => {
    const res = await db
      .table('users')
      .where({ id: 1 })
      .update({ name: undefined });
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/No update values/);
  });
});

describe('delete', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute);
  });

  it('delete via where chain', async () => {
    await db.table('users').where({ id: 1 }).delete();
    expect(m.lastSql()).toBe('DELETE FROM users WHERE id = ?');
    expect(m.lastParams()).toEqual([1]);
  });

  it('delete on broad where affects all matches', async () => {
    await db.table('users').where({ tier: 'free' }).delete();
    expect(m.lastSql()).toBe('DELETE FROM users WHERE tier = ?');
    expect(m.lastParams()).toEqual(['free']);
  });

  it('delete honors orderBy and limit for SQLite/D1 top-N writes', async () => {
    await db
      .table('users')
      .where({ verified: false })
      .orderBy({ name: 'asc' })
      .limit(1)
      .delete();

    expect(m.lastSql()).toBe(
      'DELETE FROM users WHERE verified = ? ORDER BY name ASC LIMIT 1'
    );
    expect(m.lastParams()).toEqual([false]);
  });

  it('delete without where rejects (safety guard)', async () => {
    const res = await db.table('users').delete();
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/where clause/);
  });
});

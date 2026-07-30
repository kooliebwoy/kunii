import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createRuntimeOrm } from '../src/orm.js';

describe('query builder reads', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute);
  });

  it('select narrows columns', async () => {
    await db.table('users').select(['id', 'email']).many();
    expect(m.lastSql()).toBe('SELECT id, email FROM users');
  });

  it('orderBy with object emits ORDER BY ... ASC/DESC', async () => {
    await db.table('users').orderBy({ created_at: 'desc' }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users ORDER BY created_at DESC'
    );
  });

  it('orderBy with array of items', async () => {
    await db
      .table('users')
      .orderBy([{ tier: 'asc' }, { created_at: 'desc' }])
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users ORDER BY tier ASC, created_at DESC'
    );
  });

  it('limit and offset', async () => {
    await db.table('users').limit(10).offset(20).many();
    expect(m.lastSql()).toBe('SELECT * FROM users LIMIT 10 OFFSET 20');
  });

  it('first() applies LIMIT 1', async () => {
    m.respond([{ match: 'SELECT', rows: [{ id: 1, name: 'a' }] }]);
    const res = await db.table('users').where({ id: 1 }).first();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE id = ? LIMIT 1'
    );
    expect(res.success).toBe(true);
    expect((res as any).data).toEqual({ id: 1, name: 'a' });
  });

  it('one() returns success when exactly one row', async () => {
    m.respond([{ match: 'SELECT', rows: [{ id: 1 }] }]);
    const res = await db.table('users').where({ id: 1 }).one();
    expect(res.success).toBe(true);
    expect((res as any).data).toEqual({ id: 1 });
  });

  it('one() fails when zero rows', async () => {
    m.respond([{ match: 'SELECT', rows: [] }]);
    const res = await db.table('users').where({ id: 999 }).one();
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/Not found/);
  });

  it('one() fails when multiple rows', async () => {
    m.respond([{ match: 'SELECT', rows: [{ id: 1 }, { id: 2 }] }]);
    const res = await db.table('users').where({ tier: 'pro' }).one();
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/exactly one/);
  });

  it('count() emits COUNT(*) and returns number', async () => {
    m.respond([{ match: 'COUNT', rows: [{ count: 42 }] }]);
    const res = await db.table('users').where({ tier: 'pro' }).count();
    expect(m.lastSql()).toBe(
      'SELECT COUNT(*) as count FROM users WHERE tier = ?'
    );
    expect((res as any).data).toBe(42);
  });

  it('exists() returns true for matching row', async () => {
    m.respond([{ match: 'EXISTS', rows: [{ e: 1 }] }]);
    const res = await db.table('users').where({ id: 1 }).exists();
    expect(m.lastSql()).toContain(
      'SELECT EXISTS(SELECT 1 FROM users WHERE id = ? LIMIT 1)'
    );
    expect(res).toBe(true);
  });

  it('exists() returns false for no rows', async () => {
    m.respond([{ match: 'EXISTS', rows: [{ e: 0 }] }]);
    const res = await db.table('users').where({ id: 999 }).exists();
    expect(res).toBe(false);
  });

  it('distinct() returns column values flattened (via query chain)', async () => {
    m.respond([
      { match: 'DISTINCT', rows: [{ tier: 'free' }, { tier: 'pro' }] },
    ]);
    const res = await db
      .table('users')
      .where({ status: 'active' })
      .distinct('tier');
    expect(m.lastSql()).toBe(
      'SELECT DISTINCT tier FROM users WHERE status = ?'
    );
    expect((res as any).data).toEqual(['free', 'pro']);
  });
});

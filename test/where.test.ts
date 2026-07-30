import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createRuntimeOrm } from '../src/orm.js';

describe('where compilation', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute);
  });

  // ── Value-shape shortcuts ────────────────────────────────────

  it('primitive value compiles to equality', async () => {
    await db.table('users').where({ id: 1 }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE id = ?');
    expect(m.lastParams()).toEqual([1]);
  });

  it('null value compiles to IS NULL', async () => {
    await db.table('users').where({ deleted_at: null }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE deleted_at IS NULL');
    expect(m.lastParams()).toEqual([]);
  });

  it('array value compiles to IN via json_each', async () => {
    await db.table('users').where({ tier: ['pro', 'enterprise'] }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE tier IN (SELECT value FROM json_each(?))'
    );
    expect(m.lastParams()).toEqual(['["pro","enterprise"]']);
  });

  it('empty array value matches nothing (predictable for dynamic input)', async () => {
    await db.table('users').where({ id: [] }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE 0');
    expect(m.lastParams()).toEqual([]);
  });

  it('bare string with % stays equality (no auto-LIKE magic)', async () => {
    // Removed in this revision: bare strings are ALWAYS equality. Use
    // { contains } / { like } / { notLike } to opt into pattern matching.
    await db.table('users').where({ name: 'jo%' }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE name = ?');
    expect(m.lastParams()).toEqual(['jo%']);
  });

  // ── Comparison operators ─────────────────────────────────────

  it('eq / ne', async () => {
    await db.table('users').where({ tier: { eq: 'pro' } }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE tier = ?');
    expect(m.lastParams()).toEqual(['pro']);

    m.reset();
    await db.table('users').where({ tier: { ne: 'free' } }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE tier <> ?');
    expect(m.lastParams()).toEqual(['free']);
  });

  it('gt / gte / lt / lte combine with AND on same column', async () => {
    await db.table('events').where({ count: { gte: 5, lt: 100 } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM events WHERE count >= ? AND count < ?'
    );
    expect(m.lastParams()).toEqual([5, 100]);
  });

  // ── Substring matching ──────────────────────────────────────

  it('contains wraps in %...% and escapes wildcards in input', async () => {
    // Literal needle 'discount_50%' must be matched as a substring, not
    // expanded by SQLite's LIKE wildcards. Output uses ESCAPE '\\'.
    await db
      .table('items')
      .where({ name: { contains: 'discount_50%' } })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM items WHERE name LIKE ? ESCAPE '\\'"
    );
    expect(m.lastParams()).toEqual(['%discount\\_50\\%%']);
  });

  it('contains with plain text wraps in %...%', async () => {
    await db.table('users').where({ email: { contains: 'cloud' } }).many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM users WHERE email LIKE ? ESCAPE '\\'"
    );
    expect(m.lastParams()).toEqual(['%cloud%']);
  });

  it('like passes the pattern through verbatim (raw escape hatch)', async () => {
    await db.table('users').where({ name: { like: 'A%a' } }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE name LIKE ?');
    expect(m.lastParams()).toEqual(['A%a']);
  });

  it('notLike passes the pattern through verbatim', async () => {
    await db.table('users').where({ name: { notLike: '%spam%' } }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE name NOT LIKE ?');
    expect(m.lastParams()).toEqual(['%spam%']);
  });

  // ── Set membership ──────────────────────────────────────────

  it('in compiles via json_each (single bound param, no D1 cap)', async () => {
    await db
      .table('users')
      .where({ status: { in: ['active', 'pending'] } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE status IN (SELECT value FROM json_each(?))'
    );
    expect(m.lastParams()).toEqual(['["active","pending"]']);
  });

  it('in handles 500 ids in one bound param', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    await db.table('users').where({ id: { in: ids } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE id IN (SELECT value FROM json_each(?))'
    );
    expect(m.lastParams()).toHaveLength(1);
    expect(JSON.parse(m.lastParams()[0] as string)).toEqual(ids);
  });

  it('notIn via json_each', async () => {
    await db
      .table('users')
      .where({ status: { notIn: ['banned', 'deleted'] } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE status NOT IN (SELECT value FROM json_each(?))'
    );
    expect(m.lastParams()).toEqual(['["banned","deleted"]']);
  });

  it('empty in matches nothing', async () => {
    await db.table('users').where({ id: { in: [] } }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE 0');
  });

  it('empty notIn matches everything (tautology)', async () => {
    await db.table('users').where({ id: { notIn: [] } }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE 1');
  });

  // ── Range operators ─────────────────────────────────────────

  it('between compiles to BETWEEN ? AND ?', async () => {
    await db.table('users').where({ age: { between: [18, 65] } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE age BETWEEN ? AND ?'
    );
    expect(m.lastParams()).toEqual([18, 65]);
  });

  it('notBetween compiles to NOT BETWEEN ? AND ?', async () => {
    await db.table('users').where({ age: { notBetween: [13, 17] } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE age NOT BETWEEN ? AND ?'
    );
    expect(m.lastParams()).toEqual([13, 17]);
  });

  it('between with non-tuple throws', async () => {
    await expect(async () => {
      await db.table('users').where({ age: { between: [18] as any } }).many();
    }).rejects.toThrow(/'between' requires/);
  });

  // ── Null operator (single canonical form) ───────────────────

  it('isNull true compiles to IS NULL', async () => {
    await db.table('users').where({ deleted_at: { isNull: true } }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE deleted_at IS NULL');
  });

  it('isNull false compiles to IS NOT NULL', async () => {
    await db.table('users').where({ verified_at: { isNull: false } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE verified_at IS NOT NULL'
    );
  });

  // ── Multi-key + composition ─────────────────────────────────

  it('combines multiple keys with AND', async () => {
    await db
      .table('users')
      .where({ status: 'active', tier: 'pro' })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (status = ?) AND (tier = ?)'
    );
    expect(m.lastParams()).toEqual(['active', 'pro']);
  });

  it('whereAny emits OR group inline (canonical OR form)', async () => {
    // `orWhere(filter)` was removed in this revision. Use whereAny to
    // express OR conditions declaratively.
    await db
      .table('users')
      .whereAny([{ tier: 'pro' }, { tier: 'enterprise' }])
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (tier = ? OR tier = ?)'
    );
    expect(m.lastParams()).toEqual(['pro', 'enterprise']);
  });

  it('mixes value-shape shortcuts and operator objects', async () => {
    await db
      .table('users')
      .where({
        status: 'active',                    // = 'active'
        tier: ['pro', 'enterprise'],         // IN (...)
        deleted_at: null,                    // IS NULL
        age: { between: [18, 65] },          // BETWEEN
        email: { contains: 'cloud' },        // LIKE %cloud% ESCAPE
      })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM users WHERE (status = ?) AND (tier IN (SELECT value FROM json_each(?))) AND (deleted_at IS NULL) AND (age BETWEEN ? AND ?) AND (email LIKE ? ESCAPE '\\')"
    );
    expect(m.lastParams()).toEqual([
      'active',
      '["pro","enterprise"]',
      18,
      65,
      '%cloud%',
    ]);
  });

  // ── Raw sql() escape hatch (unchanged) ──────────────────────

  it('raw sql() condition appends with ?', async () => {
    await db
      .table('events')
      .where({ tenant: 'acme' })
      .sql({ query: 'created_at > ?', params: ['2024-01-01'] })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM events WHERE (tenant = ? AND created_at > ?)'
    );
    expect(m.lastParams()).toEqual(['acme', '2024-01-01']);
  });

  it('rejects template literal in raw sql()', async () => {
    expect(() =>
      db.table('events').sql({ query: 'created_at > ${val}' })
    ).toThrow(/SQL injection/);
  });

  it('rejects multi-statement in raw sql()', async () => {
    expect(() =>
      db.table('events').sql({ query: "id = 1; DROP TABLE users" })
    ).toThrow(/dangerous SQL/);
  });
});

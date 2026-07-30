/**
 * Phase C: aggregate terminals + groupBy + having + computed-column select.
 *
 * Three additions cover the reporting-query gap:
 *
 *   1. Scalar aggregates: sum / avg / min / max — same shape as count().
 *      Operate on a single column with the chain's where clause applied.
 *
 *   2. groupBy(cols) + having(filter) — standard SQL grouping. having
 *      uses the same operator vocabulary as where, but operates on
 *      SELECT aliases (typically aggregates).
 *
 *   3. Object-form select — projects computed columns alongside plain
 *      columns. Each entry's key becomes the SQL alias.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createRuntimeOrm } from '../src/orm.js';
import type { DatabaseSchema } from '../src/schema.js';

const schema: Pick<DatabaseSchema, 'tables'> = {
  tables: [
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'userId', type: 'integer' },
        { name: 'amount', type: 'real' },
        { name: 'status', type: 'text' },
        { name: 'createdAt', type: 'integer' },
        { name: 'meta', type: 'json' },
      ],
    },
  ],
};

describe('scalar aggregates', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('sum() emits SUM(col) and unwraps scalar', async () => {
    m.respond([{ match: 'SUM', rows: [{ v: 1234.5 }] }]);
    const res = await db
      .table('orders')
      .where({ status: 'paid' })
      .sum('amount');
    expect(m.lastSql()).toBe(
      'SELECT SUM(amount) as v FROM orders WHERE status = ?'
    );
    expect(res.data).toBe(1234.5);
  });

  it('avg() emits AVG(col)', async () => {
    m.respond([{ match: 'AVG', rows: [{ v: 42.7 }] }]);
    const res = await db.table('orders').avg('amount');
    expect(m.lastSql()).toBe('SELECT AVG(amount) as v FROM orders');
    expect(res.data).toBe(42.7);
  });

  it('min() emits MIN(col)', async () => {
    m.respond([{ match: 'MIN', rows: [{ v: 10 }] }]);
    const res = await db.table('orders').min('createdAt');
    expect(m.lastSql()).toBe('SELECT MIN(createdAt) as v FROM orders');
    expect(res.data).toBe(10);
  });

  it('max() emits MAX(col)', async () => {
    m.respond([{ match: 'MAX', rows: [{ v: 99 }] }]);
    const res = await db.table('orders').max('createdAt');
    expect(m.lastSql()).toBe('SELECT MAX(createdAt) as v FROM orders');
    expect(res.data).toBe(99);
  });

  it('aggregate with no rows returns null', async () => {
    m.respond([{ match: 'SUM', rows: [{ v: null }] }]);
    const res = await db.table('orders').sum('amount');
    expect(res.data).toBeNull();
  });

  it('aggregate honors JSON path columns', async () => {
    await db.table('orders').sum('meta.amount');
    expect(m.lastSql()).toBe(
      "SELECT SUM(meta ->> '$.amount') as v FROM orders"
    );
  });

  it('aggregate combines with where chain', async () => {
    await db
      .table('orders')
      .where({ status: 'paid', createdAt: { gte: 100 } })
      .max('amount');
    expect(m.lastSql()).toBe(
      'SELECT MAX(amount) as v FROM orders WHERE (status = ?) AND (createdAt >= ?)'
    );
  });
});

describe('groupBy + having + object-form select', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('object-form select — plain columns and aggregates with aliases', async () => {
    await db
      .table('orders')
      .select({
        userId: true,
        total: { sum: 'amount' },
        orderCount: { count: '*' },
      })
      .groupBy('userId')
      .many();
    expect(m.lastSql()).toBe(
      'SELECT userId, SUM(amount) AS "total", COUNT(*) AS "orderCount" FROM orders GROUP BY userId'
    );
  });

  it('object-form select — string value renames a column', async () => {
    await db
      .table('orders')
      .select({ user: 'userId', total: { sum: 'amount' } })
      .groupBy('userId')
      .many();
    expect(m.lastSql()).toBe(
      'SELECT userId AS "user", SUM(amount) AS "total" FROM orders GROUP BY userId'
    );
  });

  it('having() filters groups by aggregate alias', async () => {
    await db
      .table('orders')
      .select({ userId: true, total: { sum: 'amount' } })
      .groupBy('userId')
      .having({ total: { gte: 1000 } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT userId, SUM(amount) AS "total" FROM orders GROUP BY userId HAVING total >= ?'
    );
    expect(m.lastParams()).toEqual([1000]);
  });

  it('groupBy + having + orderBy + limit compose in correct SQL order', async () => {
    await db
      .table('orders')
      .where({ status: 'paid' })
      .select({ userId: true, total: { sum: 'amount' } })
      .groupBy('userId')
      .having({ total: { gt: 0 } })
      .orderBy({ total: 'desc' })
      .limit(10)
      .many();
    expect(m.lastSql()).toBe(
      'SELECT userId, SUM(amount) AS "total" FROM orders WHERE status = ? GROUP BY userId HAVING total > ? ORDER BY total DESC LIMIT 10'
    );
    expect(m.lastParams()).toEqual(['paid', 0]);
  });

  it('groupBy accepts multiple columns', async () => {
    await db
      .table('orders')
      .select({ userId: true, status: true, n: { count: '*' } })
      .groupBy(['userId', 'status'])
      .many();
    expect(m.lastSql()).toBe(
      'SELECT userId, status, COUNT(*) AS "n" FROM orders GROUP BY userId, status'
    );
  });

  it('having uses same operator vocabulary as where', async () => {
    await db
      .table('orders')
      .select({ userId: true, total: { sum: 'amount' }, n: { count: '*' } })
      .groupBy('userId')
      .having({ total: { between: [100, 1000] }, n: { gte: 5 } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT userId, SUM(amount) AS "total", COUNT(*) AS "n" FROM orders GROUP BY userId HAVING (total BETWEEN ? AND ?) AND (n >= ?)'
    );
    expect(m.lastParams()).toEqual([100, 1000, 5]);
  });

  it('countDistinct aggregate', async () => {
    await db
      .table('orders')
      .select({ kind: { countDistinct: 'status' } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT COUNT(DISTINCT status) AS "kind" FROM orders'
    );
  });

  it('first() with groupBy bypasses the fast path (uses many)', async () => {
    m.respond([{ match: 'SELECT', rows: [{ userId: 1, total: 500 }] }]);
    const res = await db
      .table('orders')
      .select({ userId: true, total: { sum: 'amount' } })
      .groupBy('userId')
      .orderBy({ total: 'desc' })
      .first();
    expect(m.lastSql()).toContain('GROUP BY userId');
    expect(m.lastSql()).toContain('LIMIT 1');
    expect((res as any).data).toEqual({ userId: 1, total: 500 });
  });

  it('rejects unknown select column shape', async () => {
    await expect(async () => {
      await db
        .table('orders')
        .select({ alias: { whatever: 'amount' } as any })
        .many();
    }).rejects.toThrow(/Unrecognized select column/);
  });
});

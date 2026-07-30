/**
 * `returning()` modifier — emits SQLite RETURNING clause on writes.
 *
 * The chain marker is set before the terminal write. The terminal then
 * appends `RETURNING *` (no args) or `RETURNING col1, col2, ...` (cols
 * passed) and surfaces the affected rows in `result.data`. JSON columns
 * are parsed back to objects so the shape matches what reads produce.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createRuntimeOrm } from '../src/orm.js';
import type { DatabaseSchema } from '../src/schema.js';

const schema: Pick<DatabaseSchema, 'tables'> = {
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'email', type: 'text' },
        { name: 'meta', type: 'json' },
      ],
    },
  ],
};

describe('returning()', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  // ── Insert ─────────────────────────────────────────────────

  it('insert with returning() appends RETURNING *', async () => {
    m.respond([
      {
        match: 'INSERT',
        rows: [{ id: 1, email: 'a@b.com', meta: null }],
      },
    ]);
    const res = await db.table('users').returning().insert({
      email: 'a@b.com',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (email) VALUES (?) RETURNING *'
    );
    expect((res as any).data).toEqual([{ id: 1, email: 'a@b.com', meta: null }]);
  });

  it('insert with returning(cols) projects only those columns', async () => {
    m.respond([{ match: 'INSERT', rows: [{ id: 42 }] }]);
    const res = await db.table('users').returning(['id']).insert({
      email: 'a@b.com',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (email) VALUES (?) RETURNING id'
    );
    expect((res as any).data).toEqual([{ id: 42 }]);
  });

  it('insert without returning() does not emit RETURNING', async () => {
    await db.table('users').insert({ email: 'a@b.com' });
    expect(m.lastSql()).toBe('INSERT INTO users (email) VALUES (?)');
  });

  it('returning parses JSON columns on returned rows', async () => {
    m.respond([
      {
        match: 'INSERT',
        rows: [{ id: 1, email: 'a@b.com', meta: '{"k":"v"}' }],
      },
    ]);
    const res = await db.table('users').returning().insert({
      email: 'a@b.com',
      meta: { k: 'v' },
    });
    expect((res as any).data[0].meta).toEqual({ k: 'v' });
  });

  // ── Update ─────────────────────────────────────────────────

  it('update with returning() appends RETURNING *', async () => {
    m.respond([
      {
        match: 'UPDATE',
        rows: [{ id: 1, email: 'new@b.com', meta: null }],
      },
    ]);
    const res = await db
      .table('users')
      .where({ id: 1 })
      .returning()
      .update({ email: 'new@b.com' });
    expect(m.lastSql()).toBe(
      'UPDATE users SET email = ? WHERE id = ? RETURNING *'
    );
    expect((res as any).data[0].email).toBe('new@b.com');
  });

  it('update with returning(cols) narrows the projection', async () => {
    m.respond([{ match: 'UPDATE', rows: [{ id: 1 }] }]);
    await db
      .table('users')
      .where({ id: 1 })
      .returning(['id'])
      .update({ email: 'new@b.com' });
    expect(m.lastSql()).toBe(
      'UPDATE users SET email = ? WHERE id = ? RETURNING id'
    );
  });

  // ── Delete ─────────────────────────────────────────────────

  it('delete with returning() returns the deleted rows', async () => {
    m.respond([
      {
        match: 'DELETE',
        rows: [{ id: 1, email: 'a@b.com', meta: null }],
      },
    ]);
    const res = await db
      .table('users')
      .where({ id: 1 })
      .returning()
      .delete();
    expect(m.lastSql()).toBe(
      'DELETE FROM users WHERE id = ? RETURNING *'
    );
    expect((res as any).data[0].email).toBe('a@b.com');
  });

  it('delete without returning() does not emit RETURNING', async () => {
    await db.table('users').where({ id: 1 }).delete();
    expect(m.lastSql()).toBe('DELETE FROM users WHERE id = ?');
  });

  // ── Order independence ──────────────────────────────────────

  it('returning() can come before or after where()', async () => {
    m.respond([{ match: 'UPDATE', rows: [] }]);
    // Before
    await db
      .table('users')
      .returning()
      .where({ id: 1 })
      .update({ email: 'x' });
    expect(m.lastSql()).toBe(
      'UPDATE users SET email = ? WHERE id = ? RETURNING *'
    );

    m.reset();
    // After
    await db
      .table('users')
      .where({ id: 1 })
      .returning()
      .update({ email: 'x' });
    expect(m.lastSql()).toBe(
      'UPDATE users SET email = ? WHERE id = ? RETURNING *'
    );
  });
});

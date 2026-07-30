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
        { name: 'deleted_at', type: 'integer', mode: 'timestamp_ms' },
      ],
    },
    {
      name: 'logs',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'msg', type: 'text' },
      ],
    },
  ],
};

describe('soft delete', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('many() does not add implicit soft-delete filtering', async () => {
    await db.table('users').many();
    expect(m.lastSql()).toBe('SELECT * FROM users');
  });

  it('many() with explicit where leaves deleted_at to the caller', async () => {
    await db.table('users').where({ id: 1 }).many();
    expect(m.lastSql()).toBe('SELECT * FROM users WHERE id = ?');
  });

  it('explicit deleted_at filter compiles normally', async () => {
    await db
      .table('users')
      .where({ deleted_at: { isNull: false } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE deleted_at IS NOT NULL'
    );
  });

  it('table without deleted_at column is unaffected', async () => {
    await db.table('logs').many();
    expect(m.lastSql()).toBe('SELECT * FROM logs');
  });

  it('count() does not inject soft-delete filtering', async () => {
    await db.table('users').where({ tier: 'pro' }).count();
    expect(m.lastSql()).toBe('SELECT COUNT(*) as count FROM users WHERE tier = ?');
  });
});

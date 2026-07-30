import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createRuntimeOrm } from '../src/orm.js';
import type { DatabaseSchema } from '../src/schema.js';

const usersSchema: Pick<DatabaseSchema, 'tables'> = {
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'email', type: 'text' },
        { name: 'name', type: 'text' },
      ],
    },
  ],
};

describe('insert', () => {
  let m: MockExecutor;

  beforeEach(() => {
    m = createMockExecutor();
  });

  it('single row insert', async () => {
    const db = createRuntimeOrm(m.execute);
    await db.table('users').insert({ id: 1, email: 'a@b.com', name: 'A' });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, name) VALUES (?, ?, ?)'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com', 'A']);
  });

  it('bulk insert with shared columns', async () => {
    const db = createRuntimeOrm(m.execute);
    await db.table('users').insert([
      { id: 1, email: 'a@b.com', name: 'A' },
      { id: 2, email: 'b@b.com', name: 'B' },
    ]);
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, name) VALUES (?, ?, ?), (?, ?, ?)'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com', 'A', 2, 'b@b.com', 'B']);
  });

  it('bulk insert with heterogeneous columns unions keys, fills missing with null', async () => {
    // Row A omits `deleted_at`; row B sets it. The column list must include
    // every key seen across rows so values aren't silently dropped.
    const db = createRuntimeOrm(m.execute);
    await db.table('users').insert([
      { id: 1, email: 'a@b.com' },
      { id: 2, email: 'b@b.com', deleted_at: 12345 },
    ]);
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, deleted_at) VALUES (?, ?, ?), (?, ?, ?)'
    );
    // Row A's deleted_at is filled with NULL; row B's is the real value.
    expect(m.lastParams()).toEqual([1, 'a@b.com', null, 2, 'b@b.com', 12345]);
  });

  it('empty object insert emits DEFAULT VALUES so SQLite defaults apply', async () => {
    const db = createRuntimeOrm(m.execute);
    await db.table('users').insert({});
    expect(m.lastSql()).toBe('INSERT INTO users DEFAULT VALUES');
    expect(m.lastParams()).toEqual([]);
  });

  it('insert omits undefined fields instead of binding undefined', async () => {
    const db = createRuntimeOrm(m.execute);
    await db.table('users').insert({ id: 1, email: undefined, name: 'A' });
    expect(m.lastSql()).toBe('INSERT INTO users (id, name) VALUES (?, ?)');
    expect(m.lastParams()).toEqual([1, 'A']);
  });

  it('bulk insert treats undefined as omitted and fills missing union columns with null', async () => {
    const db = createRuntimeOrm(m.execute);
    await db.table('users').insert([
      { id: 1, email: undefined },
      { id: 2, email: 'b@b.com' },
    ]);
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email) VALUES (?, ?), (?, ?)'
    );
    expect(m.lastParams()).toEqual([1, null, 2, 'b@b.com']);
  });

  it('skips fields not in schema and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createRuntimeOrm(m.execute, usersSchema);
    await db
      .table('users')
      .insert({ id: 1, email: 'a@b.com', name: 'A', bogus: 'nope' } as any);
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, name) VALUES (?, ?, ?)'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com', 'A']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping fields not in schema for table 'users'")
    );
    warn.mockRestore();
  });

  it('returns error on empty insert array', async () => {
    const db = createRuntimeOrm(m.execute);
    const res = await db.table('users').insert([]);
    expect(res.success).toBe(true);
    expect(m.calls).toHaveLength(0);
  });

  it('returns error when no valid columns survive schema filter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createRuntimeOrm(m.execute, usersSchema);
    const res = await db.table('users').insert({ bogus: 'nope' } as any);
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/No valid columns/);
    warn.mockRestore();
  });

  it('schema-aware empty object insert still emits DEFAULT VALUES', async () => {
    const db = createRuntimeOrm(m.execute, usersSchema);
    await db.table('users').insert({});
    expect(m.lastSql()).toBe('INSERT INTO users DEFAULT VALUES');
  });
});

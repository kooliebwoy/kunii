/**
 * `upsert()` — INSERT ... ON CONFLICT(target) DO UPDATE / DO NOTHING.
 *
 * Single-round-trip insert-or-update for idempotent writes (sessions,
 * settings, cache entries). Three update modes:
 *   - 'all'    → SET every inserted column from `excluded.col` (excluding
 *                the conflict target columns)
 *   - 'ignore' → ON CONFLICT DO NOTHING
 *   - object   → explicit SET values (supports JSON-path keys)
 *
 * Pairs cleanly with returning() to read back the row in one call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
        { name: 'tier', type: 'text' },
        { name: 'meta', type: 'json' },
      ],
    },
  ],
};

describe('upsert()', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  // ── update: 'all' ───────────────────────────────────────────

  it("update: 'all' refreshes every non-target column from excluded", async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', tier: 'pro' },
      onConflict: 'id',
      update: 'all',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, tier) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, tier = excluded.tier'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com', 'pro']);
  });

  it("update: 'all' with multi-column conflict target", async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', tier: 'pro' },
      onConflict: ['id', 'email'],
      update: 'all',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, tier) VALUES (?, ?, ?) ON CONFLICT(id, email) DO UPDATE SET tier = excluded.tier'
    );
  });

  it("update: 'all' falls back to DO NOTHING when only target cols are inserted", async () => {
    // Nothing left to update once we exclude the conflict target.
    await db.table('users').upsert({
      values: { id: 1 },
      onConflict: 'id',
      update: 'all',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING'
    );
  });

  // ── update: 'ignore' ────────────────────────────────────────

  it("update: 'ignore' compiles to ON CONFLICT DO NOTHING", async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com' },
      onConflict: 'id',
      update: 'ignore',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com']);
  });

  // ── update: object (explicit SET) ───────────────────────────

  it('update: object SETs explicit values', async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', tier: 'free' },
      onConflict: 'id',
      update: { tier: 'pro' },
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, tier) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tier = ?'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com', 'free', 'pro']);
  });

  it('update: object supports JSON-path keys against json columns', async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', meta: { v: 1 } },
      onConflict: 'id',
      update: { 'meta.v': 2 },
    });
    expect(m.lastSql()).toBe(
      "INSERT INTO users (id, email, meta) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET meta = json_set(meta, '$.v', ?)"
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com', '{"v":1}', 2]);
  });

  // ── Bulk values ─────────────────────────────────────────────

  it('bulk values insert N rows under one ON CONFLICT clause', async () => {
    await db.table('users').upsert({
      values: [
        { id: 1, email: 'a@b.com', tier: 'pro' },
        { id: 2, email: 'b@b.com', tier: 'free' },
      ],
      onConflict: 'id',
      update: 'all',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, tier) VALUES (?, ?, ?), (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, tier = excluded.tier'
    );
    expect(m.lastParams()).toEqual([
      1, 'a@b.com', 'pro',
      2, 'b@b.com', 'free',
    ]);
  });

  it('heterogeneous bulk values union columns and fill with null', async () => {
    await db.table('users').upsert({
      values: [
        { id: 1, email: 'a@b.com' },
        { id: 2, email: 'b@b.com', tier: 'pro' },
      ],
      onConflict: 'id',
      update: 'all',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, tier) VALUES (?, ?, ?), (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, tier = excluded.tier'
    );
    // Row 1 has no tier — gets NULL.
    expect(m.lastParams()).toEqual([
      1, 'a@b.com', null,
      2, 'b@b.com', 'pro',
    ]);
  });

  // ── JSON column auto-stringify on insert side ───────────────

  it('object value for json column is stringified on insert', async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', meta: { plan: 'pro' } },
      onConflict: 'id',
      update: 'all',
    });
    // meta arg is JSON.stringified.
    expect(m.lastParams()).toEqual([1, 'a@b.com', '{"plan":"pro"}']);
  });

  it('omits undefined insert fields before building conflict SQL', async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', tier: undefined },
      onConflict: 'id',
      update: 'all',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com']);
  });

  it('omits undefined explicit update fields in conflict clause', async () => {
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', tier: 'free' },
      onConflict: 'id',
      update: { tier: undefined, email: 'new@b.com' },
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, tier) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = ?'
    );
    expect(m.lastParams()).toEqual([1, 'a@b.com', 'free', 'new@b.com']);
  });

  // ── Pairs with returning() ──────────────────────────────────

  it('returning() appends RETURNING * after the conflict clause', async () => {
    m.respond([
      { match: 'INSERT', rows: [{ id: 1, email: 'a@b.com', tier: 'pro' }] },
    ]);
    const res = await db.table('users').returning().upsert({
      values: { id: 1, email: 'a@b.com', tier: 'pro' },
      onConflict: 'id',
      update: 'all',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email, tier) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, tier = excluded.tier RETURNING *'
    );
    expect((res as any).data).toHaveLength(1);
  });

  // ── Schema column filtering ─────────────────────────────────

  it('drops fields not in schema with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com', bogus: 'nope' } as any,
      onConflict: 'id',
      update: 'ignore',
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping fields not in schema for table 'users'")
    );
    warn.mockRestore();
  });

  // ── Validation errors ───────────────────────────────────────

  it('rejects missing values', async () => {
    const res = await db
      .table('users')
      .upsert({ onConflict: 'id', update: 'ignore' } as any);
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/upsert\(\) requires/);
  });

  it('rejects empty onConflict', async () => {
    const res = await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com' },
      onConflict: [],
      update: 'ignore',
    });
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/onConflict/);
  });

  it('rejects unknown update mode', async () => {
    const res = await db.table('users').upsert({
      values: { id: 1, email: 'a@b.com' },
      onConflict: 'id',
      update: 'something' as any,
    });
    expect(res.success).toBe(false);
    expect((res as any).error).toMatch(/'all', 'ignore', or an object/);
  });
});

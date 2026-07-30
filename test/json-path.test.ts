/**
 * JSON-path tests — first-class JSON column support.
 *
 * The ORM detects columns declared `type: 'json'` in the schema and
 * compiles dotted keys against them to surgical SQLite JSON SQL:
 *   - reads:   `col ->> '$.path'`
 *   - writes:  `col = json_set(col, '$.path', ?)`
 *   - non-primitive write values get `json(?)` so SQLite stores them as JSON.
 *
 * Users never write any of this manually. The schema's `type: 'json'`
 * flag is the only opt-in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createRuntimeOrm, createSchemaClient } from '../src/orm.js';
import type { DatabaseSchema } from '../src/schema.js';

const schema: Pick<DatabaseSchema, 'tables'> = {
  tables: [
    {
      name: 'events',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'kind', type: 'text' },
        { name: 'payload', type: 'json' },
        { name: 'meta', type: 'json' },
      ],
    },
    {
      // No JSON columns — used to verify dotted keys against non-JSON cols
      // pass through unchanged.
      name: 'plain',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'text' },
      ],
    },
  ],
};

describe('JSON path — where reads', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('compiles dotted key against json column to ->>', async () => {
    await db.table('events').where({ 'payload.user': 'a' }).many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.user' = ?"
    );
    expect(m.lastParams()).toEqual(['a']);
  });

  it('handles deep paths', async () => {
    await db
      .table('events')
      .where({ 'payload.user.profile.tier': 'pro' })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.user.profile.tier' = ?"
    );
  });

  it('handles array index syntax', async () => {
    await db.table('events').where({ 'payload.tags[0]': 'urgent' }).many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.tags[0]' = ?"
    );
    expect(m.lastParams()).toEqual(['urgent']);
  });

  it('operator object works on JSON paths', async () => {
    await db
      .table('events')
      .where({ 'payload.score': { gte: 50, lt: 100 } })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.score' >= ? AND payload ->> '$.score' < ?"
    );
    expect(m.lastParams()).toEqual([50, 100]);
  });

  it('null shortcut on JSON path', async () => {
    await db
      .table('events')
      .where({ 'payload.deletedAt': null })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.deletedAt' IS NULL"
    );
  });

  it('isNull operator on JSON path', async () => {
    await db
      .table('events')
      .where({ 'payload.deletedAt': { isNull: false } })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.deletedAt' IS NOT NULL"
    );
  });

  it('in[] on JSON path uses json_each', async () => {
    await db
      .table('events')
      .where({ 'payload.tier': { in: ['pro', 'enterprise'] } })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.tier' IN (SELECT value FROM json_each(?))"
    );
    expect(m.lastParams()).toEqual(['["pro","enterprise"]']);
  });

  it('whole-column null check stays whole-column (not a path)', async () => {
    // `payload` (no dot) is the whole JSON column. null value-shape →
    // IS NULL on the column, not a path traversal.
    await db.table('events').where({ payload: null }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM events WHERE payload IS NULL'
    );
    expect(m.lastParams()).toEqual([]);
  });

  it('non-JSON column dotted key passes through unchanged', async () => {
    // `name.first` against a plain table — column is `name`, not JSON,
    // so no path rewriting. SQL emits `name.first = ?` (which would be
    // a SQL error at runtime, but we don't second-guess the user).
    await db.table('plain').where({ 'name.first': 'Ada' } as any).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM plain WHERE name.first = ?'
    );
  });

  it('mixes plain columns and JSON paths in same where', async () => {
    await db
      .table('events')
      .where({ kind: 'click', 'payload.user': 'a' })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE (kind = ?) AND (payload ->> '$.user' = ?)"
    );
    expect(m.lastParams()).toEqual(['click', 'a']);
  });

  it('whereAny with JSON paths', async () => {
    await db
      .table('events')
      .whereAny([
        { 'payload.tier': 'pro' },
        { 'payload.tier': 'enterprise' },
      ])
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE (payload ->> '$.tier' = ? OR payload ->> '$.tier' = ?)"
    );
    expect(m.lastParams()).toEqual(['pro', 'enterprise']);
  });

  it('orderBy with JSON path', async () => {
    await db
      .table('events')
      .orderBy({ 'payload.priority': 'desc' })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events ORDER BY payload ->> '$.priority' DESC"
    );
  });

  it('array shortcut on JSON path uses json_each on extracted value', async () => {
    await db.table('events').where({ 'payload.tier': ['pro', 'free'] }).many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.tier' IN (SELECT value FROM json_each(?))"
    );
    expect(m.lastParams()).toEqual(['["pro","free"]']);
  });
});

describe('JSON path — select projections', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('select projects JSON paths with aliases', async () => {
    await db.table('events').select(['id', 'payload.user']).many();
    expect(m.lastSql()).toBe(
      "SELECT id, payload ->> '$.user' AS \"payload.user\" FROM events"
    );
  });

  it('select keeps whole-JSON column as-is', async () => {
    await db.table('events').select(['id', 'payload']).many();
    expect(m.lastSql()).toBe('SELECT id, payload FROM events');
  });
});

describe('JSON path — update writes', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('single dotted update compiles to json_set', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ 'payload.tier': 'pro' });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.tier', ?) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual(['pro', 1]);
  });

  it('multiple paths on same column merge into one json_set call', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ 'payload.tier': 'pro', 'payload.seats': 5 });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.tier', ?, '$.seats', ?) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual(['pro', 5, 1]);
  });

  it('object value at path is bound as JSON via json(?)', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ 'payload.flags': { beta: true } });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.flags', json(?)) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual(['{"beta":true}', 1]);
  });

  it('array value at path is bound as JSON via json(?)', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ 'payload.tags': ['a', 'b'] });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.tags', json(?)) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual(['["a","b"]', 1]);
  });

  it('null at path stays as raw NULL bind', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ 'payload.deletedAt': null });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.deletedAt', ?) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual([null, 1]);
  });

  it('mixed plain column + JSON path update', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ kind: 'view', 'payload.user': 'a' });
    expect(m.lastSql()).toBe(
      "UPDATE events SET kind = ?, payload = json_set(payload, '$.user', ?) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual(['view', 'a', 1]);
  });

  it('paths against different JSON columns produce separate json_set per column', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ 'payload.a': 1, 'meta.b': 2 });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.a', ?), meta = json_set(meta, '$.b', ?) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual([1, 2, 1]);
  });

  it('whole-object update against JSON column stringifies', async () => {
    await db
      .table('events')
      .where({ id: 1 })
      .update({ payload: { whole: 'replace' } });
    expect(m.lastSql()).toBe(
      'UPDATE events SET payload = ? WHERE id = ?'
    );
    expect(m.lastParams()).toEqual(['{"whole":"replace"}', 1]);
  });

  it('update with JSON path on broad where affects all matches', async () => {
    await db
      .table('events')
      .where({ kind: 'click' })
      .update({ 'payload.audited': true });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.audited', ?) WHERE kind = ?"
    );
    expect(m.lastParams()).toEqual([true, 'click']);
  });
});

describe('JSON path — insert auto-stringify', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('insert stringifies object values for JSON columns', async () => {
    await db.table('events').insert({
      id: 1,
      kind: 'click',
      payload: { user: 'a' } as any,
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO events (id, kind, payload) VALUES (?, ?, ?)'
    );
    expect(m.lastParams()).toEqual([1, 'click', '{"user":"a"}']);
  });

  it('insert leaves already-stringified JSON as-is', async () => {
    await db.table('events').insert({
      id: 1,
      kind: 'click',
      payload: '{"user":"a"}' as any,
    });
    expect(m.lastParams()).toEqual([1, 'click', '{"user":"a"}']);
  });

  it('insert leaves null JSON column as null', async () => {
    await db.table('events').insert({
      id: 1,
      kind: 'click',
      payload: null as any,
    });
    expect(m.lastParams()).toEqual([1, 'click', null]);
  });
});

describe('JSON path — round-trip with createSchemaClient (parses on read)', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createSchemaClient>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createSchemaClient(m.execute, schema);
  });

  it('JSON path predicate + parsed read', async () => {
    m.respond([
      {
        match: 'SELECT',
        rows: [{ id: 1, kind: 'click', payload: '{"user":"a","tier":"pro"}' }],
      },
    ]);
    const res = await db.events.where({ 'payload.tier': 'pro' }).first();
    expect(m.lastSql()).toBe(
      "SELECT * FROM events WHERE payload ->> '$.tier' = ? LIMIT 1"
    );
    expect((res as any).data.payload).toEqual({ user: 'a', tier: 'pro' });
  });

  it('JSON path update preserves path-aware compilation', async () => {
    await db.events.where({ id: 1 }).update({ 'payload.tier': 'pro' });
    expect(m.lastSql()).toBe(
      "UPDATE events SET payload = json_set(payload, '$.tier', ?) WHERE id = ?"
    );
    expect(m.lastParams()).toEqual(['pro', 1]);
  });
});

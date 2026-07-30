/**
 * Baseline tests for createSchemaClient — whole-blob JSON serialization.
 *
 * These lock in the existing behavior: a column declared `type: 'json'`
 * is stringified on writes and parsed on reads. The new path-aware JSON
 * features must preserve this behavior for whole-object writes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { createSchemaClient } from '../src/orm.js';
import type { DatabaseSchema } from '../src/schema.js';

const schema: Pick<DatabaseSchema, 'tables'> = {
  tables: [
    {
      name: 'events',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'kind', type: 'text' },
        { name: 'payload', type: 'json' },
      ],
    },
  ],
};

describe('createSchemaClient — whole-blob JSON', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createSchemaClient>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createSchemaClient(m.execute, schema);
  });

  it('insert stringifies object payload', async () => {
    await db.events.insert({
      id: 1,
      kind: 'click',
      payload: { user: 'a', ts: 99 } as any,
    });
    expect(m.lastSql()).toBe(
      'INSERT INTO events (id, kind, payload) VALUES (?, ?, ?)'
    );
    expect(m.lastParams()).toEqual([1, 'click', '{"user":"a","ts":99}']);
  });

  it('insert leaves null payload as null', async () => {
    await db.events.insert({ id: 2, kind: 'x', payload: null as any });
    expect(m.lastParams()).toEqual([2, 'x', null]);
  });

  it('insert leaves already-stringified payload as-is', async () => {
    await db.events.insert({
      id: 3,
      kind: 'x',
      payload: '{"already":1}' as any,
    });
    expect(m.lastParams()).toEqual([3, 'x', '{"already":1}']);
  });

  it('whole-object update stringifies', async () => {
    await db.events.where({ id: 1 }).update({ payload: { new: true } });
    expect(m.lastSql()).toBe(
      'UPDATE events SET payload = ? WHERE id = ?'
    );
    expect(m.lastParams()).toEqual(['{"new":true}', 1]);
  });

  it('many() parses payload JSON back to object', async () => {
    m.respond([
      {
        match: 'SELECT',
        rows: [
          { id: 1, kind: 'click', payload: '{"user":"a"}' },
          { id: 2, kind: 'view', payload: '{"user":"b"}' },
        ],
      },
    ]);
    const res = await db.events.many();
    const rows = (res as any).data;
    expect(rows[0].payload).toEqual({ user: 'a' });
    expect(rows[1].payload).toEqual({ user: 'b' });
  });

  it('first() parses payload JSON', async () => {
    m.respond([
      { match: 'SELECT', rows: [{ id: 1, kind: 'x', payload: '{"k":"v"}' }] },
    ]);
    const res = await db.events.where({ id: 1 }).first();
    expect((res as any).data).toEqual({
      id: 1,
      kind: 'x',
      payload: { k: 'v' },
    });
  });

  it('preserves invalid JSON as raw string', async () => {
    m.respond([
      { match: 'SELECT', rows: [{ id: 1, kind: 'x', payload: 'not json' }] },
    ]);
    const res = await db.events.first();
    expect((res as any).data.payload).toBe('not json');
  });
});

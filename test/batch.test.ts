/**
 * `db.batch(callback)` — atomic multi-write.
 *
 * Inside the callback, write terminals stage SQL+params instead of
 * running them. After the callback resolves, the queue commits
 * atomically against the underlying binding (one HTTP RTT on D1, one
 * DO transaction on SqlStorage, sequential on plain executors).
 *
 * Read terminals throw inside batch — run them outside.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createMockExecutor, type MockExecutor } from './helpers.js';
import { kunii } from '../src/index.js';
import type { DatabaseSchema } from '../src/schema.js';

const schema: Pick<DatabaseSchema, 'tables'> = {
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'email', type: 'text' },
        { name: 'tier', type: 'text' },
      ],
    },
    {
      name: 'audit',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'event', type: 'text' },
        { name: 'userId', type: 'integer' },
      ],
    },
  ],
};

describe('db.batch()', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof kunii>;

  beforeEach(() => {
    m = createMockExecutor();
    // Adapter config path — exercises the sequential-fallback commit
    // branch since there's no native batch on a mock executor.
    db = kunii({ adapter: 'executor', execute: m.execute }, schema);
  });

  it('commits multiple writes from a callback', async () => {
    const result = await db.batch(async (tx: any) => {
      await tx.users.where({ id: 1 }).update({ tier: 'pro' });
      await tx.audit.insert({ event: 'tier_change', userId: 1 });
    });
    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0].sql).toBe('UPDATE users SET tier = ? WHERE id = ?');
    expect(m.calls[0].params).toEqual(['pro', 1]);
    expect(m.calls[1].sql).toBe(
      'INSERT INTO audit (event, userId) VALUES (?, ?)'
    );
    expect(m.calls[1].params).toEqual(['tier_change', 1]);
  });

  it('staged terminals do not execute until commit', async () => {
    let executedDuringCallback = 0;
    await db.batch(async (tx: any) => {
      await tx.users.where({ id: 1 }).update({ tier: 'pro' });
      executedDuringCallback = m.calls.length;
      await tx.audit.insert({ event: 'x', userId: 1 });
    });
    // No DB calls happened during the callback (only after).
    expect(executedDuringCallback).toBe(0);
    expect(m.calls).toHaveLength(2);
  });

  it('empty callback commits with empty result', async () => {
    const result = await db.batch(async () => {});
    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
    expect(m.calls).toHaveLength(0);
  });

  it('callback throwing returns failure with error', async () => {
    const result = await db.batch(async () => {
      throw new Error('boom');
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/batch callback threw/);
    expect(m.calls).toHaveLength(0);
  });

  it('reads inside batch throw a clear error', async () => {
    const result = await db.batch(async (tx: any) => {
      await tx.users.where({ id: 1 }).first();
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/'first' is not supported inside batch/);
  });

  it('reads via many() inside batch throw too', async () => {
    const result = await db.batch(async (tx: any) => {
      await tx.users.many();
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/'many' is not supported inside batch/);
  });

  it('chains compose normally inside batch', async () => {
    await db.batch(async (tx: any) => {
      await tx.users
        .where({ tier: 'free' })
        .update({ tier: 'pro' });
    });
    expect(m.calls[0].sql).toBe(
      'UPDATE users SET tier = ? WHERE tier = ?'
    );
  });

  it('returning() inside batch is recorded and commits with RETURNING clause', async () => {
    await db.batch(async (tx: any) => {
      await tx.users.returning().insert({ email: 'a@b.com' });
    });
    expect(m.calls[0].sql).toBe(
      'INSERT INTO users (email) VALUES (?) RETURNING *'
    );
  });

  it('sequential commit stops on first error and reports it', async () => {
    // Set the responder so the first call succeeds, second fails.
    m.respond([
      { match: 'UPDATE users', result: { success: true, data: [], results: [] } },
      { match: 'INSERT INTO audit', result: { success: false, error: 'fk fail' } },
    ]);
    const result = await db.batch(async (tx: any) => {
      await tx.users.where({ id: 1 }).update({ tier: 'pro' });
      await tx.audit.insert({ event: 'x', userId: 999 });
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/fk fail/);
    // Both calls were attempted before failure surfaced.
    expect(m.calls).toHaveLength(2);
  });

  it('batch survives many writes (no D1 placeholder issue at queue level)', async () => {
    await db.batch(async (tx: any) => {
      for (let i = 0; i < 50; i++) {
        await tx.users.insert({ id: i, email: `u${i}@b.com` });
      }
    });
    expect(m.calls).toHaveLength(50);
  });
});

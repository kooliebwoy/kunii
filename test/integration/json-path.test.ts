/**
 * End-to-end JSON path tests.
 *
 * Unlike the unit tests (which assert on emitted SQL strings), these run
 * the queries against a real SQLite (D1 or DO SqlStorage) and assert on
 * the actual returned rows. This catches semantic bugs the unit tests
 * cannot — e.g. a `->>` path that compiles fine but returns the wrong
 * value, or `json(?)` vs `?` write semantics.
 *
 * Each test runs against both D1 and DO backends to verify parity.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { backends } from './setup.js';

for (const backend of backends) {
  describe(`[${backend.name}] JSON path — round trip`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
    });

    it('insert object → query path → returns extracted value', async () => {
      await db.events.insert({
        id: 1,
        userId: 1,
        kind: 'click',
        payload: { user: { tier: 'pro', seats: 5 } },
      });

      // Path filter pulls only matching rows.
      const res = await db.events.where({ 'payload.user.tier': 'pro' }).first();
      expect(res.success).toBe(true);
      expect(res.data.id).toBe(1);
      expect(res.data.payload).toEqual({
        user: { tier: 'pro', seats: 5 },
      });
    });

    it('select projects extracted JSON value with alias', async () => {
      await db.events.insert({
        id: 1,
        userId: 1,
        kind: 'click',
        payload: { score: 42, tier: 'pro' },
      });
      const res = await db.events
        .select(['id', 'payload.score'])
        .where({ id: 1 })
        .first();
      expect(res.success).toBe(true);
      // SQLite ->> returns INTEGER for JSON numbers.
      expect(res.data.id).toBe(1);
      expect(res.data['payload.score']).toBe(42);
    });

    it('numeric path comparisons (gte/lt) match correctly', async () => {
      await db.events.insert([
        { id: 1, userId: 1, kind: 'a', payload: { score: 10 } },
        { id: 2, userId: 1, kind: 'b', payload: { score: 50 } },
        { id: 3, userId: 1, kind: 'c', payload: { score: 99 } },
      ]);
      const res = await db.events
        .where({ 'payload.score': { gte: 50, lt: 100 } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.success).toBe(true);
      expect(res.data.map((r: any) => r.id)).toEqual([2, 3]);
    });

    it('IN against JSON path uses json_each', async () => {
      await db.events.insert([
        { id: 1, userId: 1, kind: 'a', payload: { tier: 'free' } },
        { id: 2, userId: 1, kind: 'b', payload: { tier: 'pro' } },
        { id: 3, userId: 1, kind: 'c', payload: { tier: 'enterprise' } },
      ]);
      const res = await db.events
        .where({ 'payload.tier': { in: ['pro', 'enterprise'] } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((r: any) => r.id)).toEqual([2, 3]);
    });

    it('null value-shape on missing JSON path', async () => {
      await db.events.insert([
        { id: 1, userId: 1, kind: 'a', payload: { tier: 'pro' } },
        { id: 2, userId: 1, kind: 'b', payload: { name: 'x' } },
      ]);
      // Path that doesn't exist returns NULL via ->>.
      const missing = await db.events
        .where({ 'payload.tier': null })
        .orderBy({ id: 'asc' })
        .many();
      expect(missing.data.map((r: any) => r.id)).toEqual([2]);

      const present = await db.events
        .where({ 'payload.tier': { isNull: false } })
        .orderBy({ id: 'asc' })
        .many();
      expect(present.data.map((r: any) => r.id)).toEqual([1]);
    });

    it('orderBy on JSON path sorts by extracted value', async () => {
      await db.events.insert([
        { id: 1, userId: 1, kind: 'a', payload: { priority: 30 } },
        { id: 2, userId: 1, kind: 'b', payload: { priority: 10 } },
        { id: 3, userId: 1, kind: 'c', payload: { priority: 20 } },
      ]);
      const res = await db.events
        .orderBy({ 'payload.priority': 'asc' })
        .many();
      expect(res.data.map((r: any) => r.id)).toEqual([2, 3, 1]);
    });

    it('array index path matches', async () => {
      await db.events.insert({
        id: 1,
        userId: 1,
        kind: 'a',
        payload: { tags: ['urgent', 'p1'] },
      });
      const res = await db.events
        .where({ 'payload.tags[0]': 'urgent' })
        .first();
      expect(res.success).toBe(true);
      expect(res.data.id).toBe(1);
    });
  });

  describe(`[${backend.name}] JSON path — surgical writes`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
      await db.events.insert({
        id: 1,
        userId: 1,
        kind: 'click',
        payload: { user: { tier: 'free', seats: 1 }, version: 1 },
      });
    });

    it('json_set updates one path without disturbing other keys', async () => {
      await db.events.where({ id: 1 }).update({ 'payload.user.tier': 'pro' });
      const res = await db.events.where({ id: 1 }).first();
      expect(res.data.payload).toEqual({
        user: { tier: 'pro', seats: 1 },
        version: 1,
      });
    });

    it('multiple paths merge into one json_set call atomically', async () => {
      await db.events.where({ id: 1 }).update({
        'payload.user.tier': 'pro',
        'payload.user.seats': 5,
        'payload.version': 2,
      });
      const res = await db.events.where({ id: 1 }).first();
      expect(res.data.payload).toEqual({
        user: { tier: 'pro', seats: 5 },
        version: 2,
      });
    });

    it('object value at path stored as queryable JSON (not literal string)', async () => {
      await db.events
        .where({ id: 1 })
        .update({ 'payload.flags': { beta: true, ga: false } });

      // Round-trip: parse must give us the object.
      const res1 = await db.events.where({ id: 1 }).first();
      expect(res1.data.payload.flags).toEqual({ beta: true, ga: false });

      // Critically: must be queryable as JSON (proves we used json(?)).
      // SQLite stores JSON booleans as 0/1, so we query with the SQL
      // representation. The point is that the value is *queryable* — if
      // we'd written it as a literal string, ->> '$.flags.beta' would
      // return null (no such path in a string).
      const res2 = await db.events
        .where({ 'payload.flags.beta': 1 })
        .first();
      expect(res2.success).toBe(true);
      expect(res2.data?.id).toBe(1);
    });

    it('array value at path stored as queryable JSON array', async () => {
      await db.events
        .where({ id: 1 })
        .update({ 'payload.tags': ['urgent', 'p1'] });

      const res1 = await db.events.where({ id: 1 }).first();
      expect(res1.data.payload.tags).toEqual(['urgent', 'p1']);

      // Confirm json_each on the stored array works.
      const res2 = await db.events
        .where({ 'payload.tags[1]': 'p1' })
        .first();
      expect(res2.success).toBe(true);
      expect(res2.data.id).toBe(1);
    });

    it('null at path persists as JSON null', async () => {
      await db.events
        .where({ id: 1 })
        .update({ 'payload.user.tier': null });
      const res = await db.events.where({ id: 1 }).first();
      // SQLite stores JSON null; readback may surface as JS null.
      expect(res.data.payload.user.tier).toBeNull();
    });

    it('whole-object update replaces entire JSON column', async () => {
      await db.events
        .where({ id: 1 })
        .update({ payload: { totally: 'new' } });
      const res = await db.events.where({ id: 1 }).first();
      expect(res.data.payload).toEqual({ totally: 'new' });
    });

    it('update with JSON path applies to all matching rows', async () => {
      await db.events.insert([
        { id: 2, userId: 2, kind: 'click', payload: { user: { tier: 'free' } } },
        { id: 3, userId: 3, kind: 'click', payload: { user: { tier: 'free' } } },
      ]);
      await db.events
        .where({ kind: 'click' })
        .update({ 'payload.user.tier': 'pro' });

      const all = await db.events.where({ kind: 'click' }).orderBy({ id: 'asc' }).many();
      for (const row of all.data) {
        expect(row.payload.user.tier).toBe('pro');
      }
    });
  });
}

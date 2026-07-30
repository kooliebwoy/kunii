/**
 * End-to-end coverage of the rest of the ORM surface — insert, update,
 * delete, soft-delete, includes, count, distinct, exists, where variants —
 * run against a real SQLite (D1 + DO) so we know the SQL we emit is
 * semantically correct, not just textually correct.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { backends } from './setup.js';

for (const backend of backends) {
  describe(`[${backend.name}] insert / read`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
    });

    it('single insert is queryable', async () => {
      await db.users.insert({
        id: 1,
        email: 'a@b.com',
        name: 'Ada',
        tier: 'pro',
      });
      const res = await db.users.where({ id: 1 }).first();
      expect(res.success).toBe(true);
      expect(res.data.email).toBe('a@b.com');
      expect(res.data.tier).toBe('pro');
    });

    it('bulk insert returns all rows on read', async () => {
      await db.users.insert([
        { id: 1, email: 'a@b.com', name: 'A' },
        { id: 2, email: 'b@b.com', name: 'B' },
        { id: 3, email: 'c@b.com', name: 'C' },
      ]);
      const res = await db.users.orderBy({ id: 'asc' }).many();
      expect(res.data).toHaveLength(3);
      expect(res.data.map((u: any) => u.name)).toEqual(['A', 'B', 'C']);
    });

    it('count returns matching rows', async () => {
      await db.users.insert([
        { id: 1, email: 'a@b.com', tier: 'pro' },
        { id: 2, email: 'b@b.com', tier: 'pro' },
        { id: 3, email: 'c@b.com', tier: 'free' },
      ]);
      const total = await db.users.count();
      expect(total.data).toBe(3);
      const pros = await db.users.where({ tier: 'pro' }).count();
      expect(pros.data).toBe(2);
    });

    it('exists reflects presence', async () => {
      await db.users.insert({ id: 1, email: 'a@b.com' });
      const a = await db.users.where({ id: 1 }).exists();
      expect(a).toBe(true);
      const b = await db.users.where({ id: 999 }).exists();
      expect(b).toBe(false);
    });

    it('first returns single row, undefined when empty', async () => {
      const empty = await db.users.where({ id: 999 }).first();
      expect(empty.success).toBe(true);
      expect(empty.data).toBeUndefined();

      await db.users.insert({ id: 1, email: 'a@b.com' });
      const found = await db.users.where({ id: 1 }).first();
      expect(found.data.id).toBe(1);
    });

    it('one() fails when zero / multiple rows, succeeds for exactly one', async () => {
      const empty = await db.users.where({ id: 999 }).one();
      expect(empty.success).toBe(false);

      await db.users.insert([
        { id: 1, email: 'a@b.com', tier: 'pro' },
        { id: 2, email: 'b@b.com', tier: 'pro' },
      ]);
      const ok = await db.users.where({ id: 1 }).one();
      expect(ok.success).toBe(true);
      expect(ok.data.id).toBe(1);

      const dup = await db.users.where({ tier: 'pro' }).one();
      expect(dup.success).toBe(false);
    });

    it('distinct returns unique values', async () => {
      await db.users.insert([
        { id: 1, email: 'a@b.com', tier: 'pro' },
        { id: 2, email: 'b@b.com', tier: 'pro' },
        { id: 3, email: 'c@b.com', tier: 'free' },
      ]);
      const res = await db.users.where({ id: { gt: 0 } }).distinct('tier');
      expect(res.data.sort()).toEqual(['free', 'pro']);
    });
  });

  describe(`[${backend.name}] update / delete`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
      await db.users.insert([
        { id: 1, email: 'a@b.com', name: 'A', tier: 'free' },
        { id: 2, email: 'b@b.com', name: 'B', tier: 'free' },
      ]);
    });

    it('update via where chain mutates row', async () => {
      await db.users.where({ id: 1 }).update({ tier: 'pro' });
      const res = await db.users.where({ id: 1 }).first();
      expect(res.data.tier).toBe('pro');
    });

    it('update on broad where affects all matching rows', async () => {
      await db.users.where({ tier: 'free' }).update({ tier: 'pro' });
      const all = await db.users.orderBy({ id: 'asc' }).many();
      for (const u of all.data) expect(u.tier).toBe('pro');
    });

    it('update honors orderBy + limit on real SQLite backends', async () => {
      await db.users
        .where({ tier: 'free' })
        .orderBy({ name: 'desc' })
        .limit(1)
        .update({ tier: 'pro' });
      const all = await db.users.orderBy({ id: 'asc' }).many();
      expect(all.data.map((u: any) => ({ id: u.id, tier: u.tier }))).toEqual([
        { id: 1, tier: 'free' },
        { id: 2, tier: 'pro' },
      ]);
    });

    it('delete via where removes row', async () => {
      await db.users.where({ id: 1 }).delete();
      const remaining = await db.users.orderBy({ id: 'asc' }).many();
      expect(remaining.data.map((u: any) => u.id)).toEqual([2]);
    });

    it('delete on broad where removes all matching rows', async () => {
      await db.users.where({ tier: 'free' }).delete();
      const remaining = await db.users.many();
      expect(remaining.data).toEqual([]);
    });

    it('delete honors orderBy + limit on real SQLite backends', async () => {
      await db.users
        .where({ tier: 'free' })
        .orderBy({ name: 'asc' })
        .limit(1)
        .delete();
      const remaining = await db.users.orderBy({ id: 'asc' }).many();
      expect(remaining.data.map((u: any) => u.id)).toEqual([2]);
    });
  });

  describe(`[${backend.name}] where variants`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
      await db.users.insert([
        { id: 1, email: 'a@b.com', name: 'Ada', tier: 'free' },
        { id: 2, email: 'b@b.com', name: 'Bob', tier: 'pro' },
        { id: 3, email: 'c@b.com', name: 'Carol', tier: 'enterprise' },
        { id: 4, email: 'd@b.com', name: 'Dan', tier: 'free' },
      ]);
    });

    it('array value finds rows by id list', async () => {
      const res = await db.users
        .where({ id: [1, 3] })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.id)).toEqual([1, 3]);
    });

    it('500 ids in a single bound param via array shortcut', async () => {
      const ids = Array.from({ length: 500 }, (_, i) => i + 100);
      // Insert a mix, only some of which will match.
      await db.users.insert([
        { id: 200, email: '200@b.com' },
        { id: 350, email: '350@b.com' },
      ]);
      const res = await db.users
        .where({ id: ids })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.id)).toEqual([200, 350]);
    });

    it('explicit { in: [...] } also works', async () => {
      const res = await db.users
        .where({ id: { in: [1, 3] } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.id)).toEqual([1, 3]);
    });

    it('whereAny composes OR clauses (canonical OR form)', async () => {
      const res = await db.users
        .whereAny([{ tier: 'pro' }, { tier: 'enterprise' }])
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.id)).toEqual([2, 3]);
    });

    it('contains matches substring with auto-escape (case-insensitive)', async () => {
      // SQLite LIKE is case-insensitive by default for ASCII, so 'da'
      // matches both "Ada" and "Dan". Use a more discriminating needle.
      const res = await db.users
        .where({ name: { contains: 'arol' } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.name)).toEqual(['Carol']);
    });

    it('contains escapes literal % so it matches the character', async () => {
      // Insert a row with a literal % in the name and prove it's findable
      // by `contains`, not by accidental wildcard expansion.
      await db.users.insert({ id: 999, email: 'lit@b.com', name: '50%-off' });
      const res = await db.users
        .where({ name: { contains: '0%-' } })
        .many();
      expect(res.data.map((u: any) => u.id)).toEqual([999]);
    });

    it('like with raw pattern matches (escape hatch)', async () => {
      const res = await db.users
        .where({ name: { like: 'A%' } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.name)).toEqual(['Ada']);
    });

    it('between matches inclusive range', async () => {
      const res = await db.users
        .where({ id: { between: [2, 3] } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.id)).toEqual([2, 3]);
    });

    it('null value-shape filters IS NULL rows', async () => {
      const res = await db.users
        .where({ name: null })
        .orderBy({ id: 'asc' })
        .many();
      // All 4 fixture rows have names — none match.
      expect(res.data).toEqual([]);
    });

    it('limit + offset paginates', async () => {
      const page1 = await db.users.orderBy({ id: 'asc' }).limit(2).offset(0).many();
      expect(page1.data.map((u: any) => u.id)).toEqual([1, 2]);
      const page2 = await db.users.orderBy({ id: 'asc' }).limit(2).offset(2).many();
      expect(page2.data.map((u: any) => u.id)).toEqual([3, 4]);
    });
  });

  describe(`[${backend.name}] soft delete`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
      await db.users.insert([
        { id: 1, email: 'a@b.com', tier: 'free' },
        { id: 2, email: 'b@b.com', tier: 'free', deleted_at: Date.now() },
      ]);
    });

    it('many() returns soft-deleted rows unless the caller filters them out', async () => {
      const res = await db.users.orderBy({ id: 'asc' }).many();
      expect(res.data.map((u: any) => u.id)).toEqual([1, 2]);
    });

    it('count() includes soft-deleted rows unless the caller filters them out', async () => {
      const res = await db.users.count();
      expect(res.data).toBe(2);
    });

    it('explicit deleted_at filters still work', async () => {
      const res = await db.users.where({ deleted_at: { isNull: true } }).orderBy({ id: 'asc' }).many();
      expect(res.data.map((u: any) => u.id)).toEqual([1]);
    });
  });

  describe(`[${backend.name}] include — eager relations`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
      await db.users.insert([
        { id: 1, email: 'a@b.com', name: 'Ada' },
        { id: 2, email: 'b@b.com', name: 'Bob' },
      ]);
      await db.posts.insert([
        { id: 100, userId: 1, title: 'hello',  published: 1, createdAt: 1000 },
        { id: 101, userId: 1, title: 'world',  published: 0, createdAt: 2000, meta: { kind: 'note', rank: 2 } },
        { id: 102, userId: 1, title: 'third',  published: 1, createdAt: 3000, meta: { kind: 'news', rank: 3 } },
        { id: 103, userId: 2, title: 'sup',    published: 1, createdAt: 1500 },
        { id: 104, userId: 2, title: 'draft',  published: 0, createdAt: 2500 },
      ]);
      await db.comments.insert([
        { id: 1000, postId: 100, body: 'hello comment' },
        { id: 1001, postId: 100, body: 'second comment' },
        { id: 1002, postId: 102, body: 'third comment' },
        { id: 1003, postId: 103, body: 'bob comment' },
      ]);
    });

    it('hasMany via foreignKey on child', async () => {
      const res = await db.users
        .include({ posts: { foreignKey: 'userId' } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data).toHaveLength(2);
      const ada = res.data.find((u: any) => u.id === 1);
      expect(ada.posts).toHaveLength(3);
    });

    it('parent rows with no children get an empty array', async () => {
      // Insert a third user with no posts.
      await db.users.insert({ id: 3, email: 'c@b.com', name: 'Carol' });
      const res = await db.users
        .include({ posts: { foreignKey: 'userId' } })
        .orderBy({ id: 'asc' })
        .many();
      const carol = res.data.find((u: any) => u.id === 3);
      expect(carol.posts).toEqual([]);
    });

    // ── Filtered include ─────────────────────────────────────────

    it('filters child rows via where', async () => {
      const res = await db.users
        .include({
          posts: { foreignKey: 'userId', where: { published: 1 } },
        })
        .orderBy({ id: 'asc' })
        .many();
      const ada = res.data.find((u: any) => u.id === 1);
      const bob = res.data.find((u: any) => u.id === 2);
      // Only published posts come back per parent.
      expect(ada.posts.map((p: any) => p.id).sort()).toEqual([100, 102]);
      expect(bob.posts.map((p: any) => p.id)).toEqual([103]);
    });

    it('orders child rows', async () => {
      const res = await db.users
        .include({
          posts: { foreignKey: 'userId', orderBy: { createdAt: 'desc' } },
        })
        .where({ id: 1 })
        .first();
      expect(res.data.posts.map((p: any) => p.id)).toEqual([102, 101, 100]);
    });

    it('per-parent limit gives each parent up to N children (window function)', async () => {
      const res = await db.users
        .include({
          posts: {
            foreignKey: 'userId',
            orderBy: { createdAt: 'desc' },
            limit: 2,
          },
        })
        .orderBy({ id: 'asc' })
        .many();
      const ada = res.data.find((u: any) => u.id === 1);
      const bob = res.data.find((u: any) => u.id === 2);
      // Each user gets at most 2 posts — Ada has 3 total, Bob has 2.
      expect(ada.posts).toHaveLength(2);
      expect(bob.posts).toHaveLength(2);
      // Ada's two should be the most recent two by createdAt.
      expect(ada.posts.map((p: any) => p.id)).toEqual([102, 101]);
    });

    it('select narrows columns and always retains the FK for stitching', async () => {
      const res = await db.users
        .include({
          posts: {
            foreignKey: 'userId',
            select: ['id', 'title'],
            orderBy: { id: 'asc' },
          },
        })
        .where({ id: 1 })
        .first();
      // Children only have id, title, and userId (FK auto-added) — no
      // other columns like published/createdAt.
      expect(res.data.posts).toHaveLength(3);
      const sample = res.data.posts[0];
      expect(Object.keys(sample).sort()).toEqual(['id', 'title', 'userId']);
    });

    it('combines where + orderBy + limit + select', async () => {
      const res = await db.users
        .include({
          posts: {
            foreignKey: 'userId',
            where: { published: 1 },
            orderBy: { createdAt: 'desc' },
            limit: 1,
            select: ['id', 'title'],
          },
        })
        .where({ id: 1 })
        .first();
      // Ada's published posts are 100 and 102; newest = 102.
      expect(res.data.posts).toHaveLength(1);
      expect(res.data.posts[0].id).toBe(102);
      expect(Object.keys(res.data.posts[0]).sort()).toEqual([
        'id',
        'title',
        'userId',
      ]);
    });

    it('child filters and projections support JSON paths', async () => {
      const res = await db.users
        .include({
          posts: {
            foreignKey: 'userId',
            where: { 'meta.kind': 'news' },
            orderBy: { 'meta.rank': 'desc' },
            select: ['id', 'meta.kind'],
          },
        })
        .where({ id: 1 })
        .first();

      expect(res.data.posts).toEqual([
        { id: 102, 'meta.kind': 'news', userId: 1 },
      ]);
    });

    it('loads nested includes on included rows', async () => {
      const res = await db.users
        .include({
          posts: {
            foreignKey: 'userId',
            include: { comments: true },
            orderBy: { id: 'asc' },
          },
        })
        .where({ id: 1 })
        .first();

      const posts = res.data.posts;
      expect(posts.map((p: any) => p.id)).toEqual([100, 101, 102]);
      expect(posts[0].comments.map((c: any) => c.id)).toEqual([1000, 1001]);
      expect(posts[1].comments).toEqual([]);
      expect(posts[2].comments.map((c: any) => c.id)).toEqual([1002]);
    });
  });

  describe(`[${backend.name}] where on hasMany relation`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
      await db.users.insert([
        { id: 1, email: 'a@b.com', name: 'Ada' },
        { id: 2, email: 'b@b.com', name: 'Bob' },
        { id: 3, email: 'c@b.com', name: 'Carol' }, // no posts
      ]);
      await db.posts.insert([
        { id: 100, userId: 1, title: 'p1', published: 1, createdAt: 1000 },
        { id: 101, userId: 1, title: 'p2', published: 0, createdAt: 2000 },
        { id: 102, userId: 1, title: 'p3', published: 1, createdAt: 3000 },
        { id: 103, userId: 2, title: 'p4', published: 0, createdAt: 1500 },
      ]);
    });

    it('any: {} → users with at least one post', async () => {
      const res = await db.users
        .where({ posts: { any: {} } })
        .orderBy({ id: 'asc' })
        .many();
      expect(res.data.map((u: any) => u.id)).toEqual([1, 2]);
    });

    it('any: { published: 1 } → users with any published post', async () => {
      const res = await db.users
        .where({ posts: { any: { published: 1 } } })
        .orderBy({ id: 'asc' })
        .many();
      // Only Ada has published posts.
      expect(res.data.map((u: any) => u.id)).toEqual([1]);
    });

    it('none: {} → users with zero posts', async () => {
      const res = await db.users
        .where({ posts: { none: {} } })
        .orderBy({ id: 'asc' })
        .many();
      // Carol is the only one without posts.
      expect(res.data.map((u: any) => u.id)).toEqual([3]);
    });

    it('none: { published: 1 } → users with no published posts', async () => {
      const res = await db.users
        .where({ posts: { none: { published: 1 } } })
        .orderBy({ id: 'asc' })
        .many();
      // Bob has only unpublished, Carol has none.
      expect(res.data.map((u: any) => u.id)).toEqual([2, 3]);
    });

    it('count = N → users with exactly N posts', async () => {
      const res = await db.users
        .where({ posts: 1 })
        .orderBy({ id: 'asc' })
        .many();
      // Only Bob has exactly 1 post.
      expect(res.data.map((u: any) => u.id)).toEqual([2]);
    });

    it('{ gte: 2 } → users with at least 2 posts', async () => {
      const res = await db.users
        .where({ posts: { gte: 2 } })
        .orderBy({ id: 'asc' })
        .many();
      // Only Ada has 3 posts.
      expect(res.data.map((u: any) => u.id)).toEqual([1]);
    });

    it('{ between: [1, 2] } → users with 1 to 2 posts inclusive', async () => {
      const res = await db.users
        .where({ posts: { between: [1, 2] } })
        .orderBy({ id: 'asc' })
        .many();
      // Bob has 1 (in range). Ada has 3 (not). Carol has 0 (not).
      expect(res.data.map((u: any) => u.id)).toEqual([2]);
    });

    it('combines relation predicate with column predicate (AND)', async () => {
      const res = await db.users
        .where({
          name: { contains: 'a' },
          posts: { any: { published: 1 } },
        })
        .orderBy({ id: 'asc' })
        .many();
      // Ada matches name AND has a published post. Bob matches name but
      // has no published posts. Carol matches but has no posts.
      expect(res.data.map((u: any) => u.id)).toEqual([1]);
    });
  });

  describe(`[${backend.name}] returning()`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
    });

    it('insert with returning() returns the inserted row including auto-id', async () => {
      const res = await db.users
        .returning()
        .insert({ email: 'a@b.com', name: 'Ada' });
      expect(res.success).toBe(true);
      expect(res.data).toHaveLength(1);
      expect(res.data[0].email).toBe('a@b.com');
      expect(res.data[0].name).toBe('Ada');
      // id is auto-assigned by SQLite — should be a positive integer.
      expect(typeof res.data[0].id).toBe('number');
      expect(res.data[0].id).toBeGreaterThan(0);
    });

    it('insert with returning(["id"]) projects only id', async () => {
      const res = await db.users
        .returning(['id'])
        .insert({ email: 'b@b.com', name: 'Bob' });
      expect(res.data).toHaveLength(1);
      expect(Object.keys(res.data[0])).toEqual(['id']);
    });

    it('insert returning parses JSON columns', async () => {
      const res = await db.users
        .returning()
        .insert({ email: 'c@b.com', name: 'Carol', meta: { plan: 'pro' } });
      expect(res.data[0].meta).toEqual({ plan: 'pro' });
    });

    it('update with returning() returns the new row', async () => {
      await db.users.insert({ id: 1, email: 'a@b.com', name: 'Ada' });
      const res = await db.users
        .where({ id: 1 })
        .returning()
        .update({ tier: 'pro' });
      expect(res.data).toHaveLength(1);
      expect(res.data[0].tier).toBe('pro');
      expect(res.data[0].id).toBe(1);
    });

    it('delete with returning() returns the deleted row', async () => {
      await db.users.insert({ id: 1, email: 'a@b.com', name: 'Ada' });
      const res = await db.users
        .where({ id: 1 })
        .returning()
        .delete();
      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe(1);
      expect(res.data[0].email).toBe('a@b.com');
      // Confirm row is actually gone.
      const after = await db.users.where({ id: 1 }).first();
      expect(after.data).toBeUndefined();
    });

    it('bulk insert with returning() returns all inserted rows', async () => {
      const res = await db.users.returning().insert([
        { email: 'a@b.com', name: 'Ada' },
        { email: 'b@b.com', name: 'Bob' },
        { email: 'c@b.com', name: 'Carol' },
      ]);
      expect(res.data).toHaveLength(3);
      expect(res.data.map((u: any) => u.name).sort()).toEqual([
        'Ada', 'Bob', 'Carol',
      ]);
    });
  });

  describe(`[${backend.name}] aggregates / groupBy / having`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
      await db.users.insert([
        { id: 1, email: 'a@b.com', name: 'Ada' },
        { id: 2, email: 'b@b.com', name: 'Bob' },
      ]);
      await db.posts.insert([
        { id: 100, userId: 1, title: 'A', views: 10, createdAt: 1000 },
        { id: 101, userId: 1, title: 'B', views: 20, createdAt: 2000 },
        { id: 102, userId: 1, title: 'C', views: 30, createdAt: 3000 },
        { id: 103, userId: 2, title: 'D', views: 5,  createdAt: 1500 },
        { id: 104, userId: 2, title: 'E', views: 15, createdAt: 2500 },
      ]);
    });

    it('sum() returns the column total', async () => {
      const res = await db.posts.sum('views');
      // 10 + 20 + 30 + 5 + 15 = 80
      expect(res.data).toBe(80);
    });

    it('avg() returns the column average', async () => {
      const res = await db.posts.where({ userId: 1 }).avg('views');
      // (10 + 20 + 30) / 3 = 20
      expect(res.data).toBe(20);
    });

    it('min() / max() return extremes', async () => {
      const min = await db.posts.min('views');
      const max = await db.posts.max('views');
      expect(min.data).toBe(5);
      expect(max.data).toBe(30);
    });

    it('aggregate over empty set returns null', async () => {
      const res = await db.posts.where({ id: 9999 }).sum('views');
      expect(res.data).toBeNull();
    });

    it('groupBy + sum gives per-group totals', async () => {
      const res = await db.posts
        .select({ userId: true, total: { sum: 'views' } })
        .groupBy('userId')
        .orderBy({ userId: 'asc' })
        .many();
      expect(res.data).toEqual([
        { userId: 1, total: 60 },
        { userId: 2, total: 20 },
      ]);
    });

    it('groupBy + count gives per-group row counts', async () => {
      const res = await db.posts
        .select({ userId: true, n: { count: '*' } })
        .groupBy('userId')
        .orderBy({ userId: 'asc' })
        .many();
      expect(res.data).toEqual([
        { userId: 1, n: 3 },
        { userId: 2, n: 2 },
      ]);
    });

    it('having filters groups by aggregate', async () => {
      const res = await db.posts
        .select({ userId: true, total: { sum: 'views' } })
        .groupBy('userId')
        .having({ total: { gte: 50 } })
        .many();
      // Only Ada (60) qualifies; Bob (20) is filtered out.
      expect(res.data).toEqual([{ userId: 1, total: 60 }]);
    });

    it('full report query: where + groupBy + having + orderBy + limit', async () => {
      const res = await db.posts
        .where({ published: 0 }) // all rows in this fixture (default)
        .select({
          userId: true,
          total: { sum: 'views' },
          n: { count: '*' },
        })
        .groupBy('userId')
        .having({ n: { gte: 2 } })
        .orderBy({ total: 'desc' })
        .limit(10)
        .many();
      expect(res.data).toEqual([
        { userId: 1, total: 60, n: 3 },
        { userId: 2, total: 20, n: 2 },
      ]);
    });

    it('countDistinct in select', async () => {
      const res = await db.posts
        .select({ uniqueUsers: { countDistinct: 'userId' } })
        .first();
      expect((res.data as any).uniqueUsers).toBe(2);
    });
  });

  describe(`[${backend.name}] upsert()`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
    });

    it("update: 'all' inserts when row is new", async () => {
      const res = await db.users.returning().upsert({
        values: { id: 1, email: 'a@b.com', name: 'Ada', tier: 'pro' },
        onConflict: 'id',
        update: 'all',
      });
      expect(res.data).toHaveLength(1);
      expect(res.data[0].email).toBe('a@b.com');
      expect(res.data[0].tier).toBe('pro');
    });

    it("update: 'all' updates when row exists", async () => {
      await db.users.insert({ id: 1, email: 'a@b.com', name: 'Ada', tier: 'free' });
      const res = await db.users.returning().upsert({
        values: { id: 1, email: 'a@b.com', name: 'Ada', tier: 'pro' },
        onConflict: 'id',
        update: 'all',
      });
      expect(res.data).toHaveLength(1);
      expect(res.data[0].tier).toBe('pro');
      // Confirm only one row exists.
      const all = await db.users.many();
      expect(all.data).toHaveLength(1);
    });

    it("update: 'ignore' leaves existing row unchanged", async () => {
      await db.users.insert({ id: 1, email: 'a@b.com', name: 'Ada', tier: 'free' });
      await db.users.upsert({
        values: { id: 1, email: 'changed@b.com', name: 'Changed', tier: 'pro' },
        onConflict: 'id',
        update: 'ignore',
      });
      const row = await db.users.where({ id: 1 }).first();
      expect(row.data.email).toBe('a@b.com');
      expect(row.data.tier).toBe('free');
    });

    it('update: object SETs only the listed columns', async () => {
      await db.users.insert({ id: 1, email: 'a@b.com', name: 'Ada', tier: 'free' });
      await db.users.upsert({
        values: { id: 1, email: 'should-not-change@b.com', name: 'NoChange' },
        onConflict: 'id',
        update: { tier: 'pro' }, // only tier should change
      });
      const row = await db.users.where({ id: 1 }).first();
      expect(row.data.email).toBe('a@b.com'); // unchanged
      expect(row.data.tier).toBe('pro');       // changed
    });

    it('upsert with json column round-trips correctly', async () => {
      // Insert path.
      await db.users.upsert({
        values: { id: 1, email: 'a@b.com', meta: { plan: 'free' } },
        onConflict: 'id',
        update: 'all',
      });
      let row = await db.users.where({ id: 1 }).first();
      expect(row.data.meta).toEqual({ plan: 'free' });

      // Update path.
      await db.users.upsert({
        values: { id: 1, email: 'a@b.com', meta: { plan: 'pro' } },
        onConflict: 'id',
        update: 'all',
      });
      row = await db.users.where({ id: 1 }).first();
      expect(row.data.meta).toEqual({ plan: 'pro' });
    });

    it('bulk upsert with mixed insert/update', async () => {
      // Pre-seed one row.
      await db.users.insert({ id: 1, email: 'a@b.com', name: 'Old', tier: 'free' });

      await db.users.upsert({
        values: [
          { id: 1, email: 'a@b.com', name: 'New', tier: 'pro' },   // updates
          { id: 2, email: 'b@b.com', name: 'Bob', tier: 'free' },  // inserts
        ],
        onConflict: 'id',
        update: 'all',
      });

      const all = await db.users.orderBy({ id: 'asc' }).many();
      expect(all.data).toHaveLength(2);
      expect(all.data[0].name).toBe('New');
      expect(all.data[1].name).toBe('Bob');
    });
  });

  describe(`[${backend.name}] db.batch()`, () => {
    let db: any;
    beforeEach(async () => {
      db = await backend.setup();
    });

    it('commits multiple writes atomically', async () => {
      const result = await db.batch(async (tx: any) => {
        await tx.users.insert({ id: 1, email: 'a@b.com', name: 'Ada' });
        await tx.users.insert({ id: 2, email: 'b@b.com', name: 'Bob' });
        await tx.events.insert({ id: 100, kind: 'login', userId: 1 });
      });
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);

      // Verify rows actually committed by reading back.
      const users = await db.users.orderBy({ id: 'asc' }).many();
      expect(users.data.map((u: any) => u.id)).toEqual([1, 2]);
      const events = await db.events.many();
      expect(events.data).toHaveLength(1);
    });

    it('mix of insert / update / delete in one batch', async () => {
      // Seed first.
      await db.users.insert([
        { id: 1, email: 'a@b.com', name: 'Ada', tier: 'free' },
        { id: 2, email: 'b@b.com', name: 'Bob', tier: 'free' },
      ]);

      const result = await db.batch(async (tx: any) => {
        await tx.users.where({ id: 1 }).update({ tier: 'pro' });
        await tx.users.where({ id: 2 }).delete();
        await tx.users.insert({ id: 3, email: 'c@b.com', name: 'Carol' });
      });
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);

      const remaining = await db.users.orderBy({ id: 'asc' }).many();
      // Carol inserted without tier — gets the schema default 'free'.
      expect(remaining.data.map((u: any) => ({ id: u.id, tier: u.tier })))
        .toEqual([
          { id: 1, tier: 'pro' },
          { id: 3, tier: 'free' },
        ]);
    });

    it('empty callback succeeds with no statements', async () => {
      const result = await db.batch(async () => {});
      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });

    it('atomicity: all-or-nothing on FK constraint failure', async () => {
      // Pre-seed a user.
      await db.users.insert({ id: 1, email: 'a@b.com', name: 'Ada' });
      // Attempt a batch where the second statement violates an FK
      // (events.userId points to a non-existent user, but events
      // doesn't have FK constraints in the fixture; instead we'll
      // use a unique-violation: insert id=1 twice).
      const result = await db.batch(async (tx: any) => {
        await tx.users.insert({ id: 2, email: 'b@b.com', name: 'Bob' });
        await tx.users.insert({ id: 1, email: 'dup@b.com', name: 'Dup' }); // PK violation
      });
      expect(result.success).toBe(false);

      // Atomicity check: id=2 should NOT exist on D1 (native batch
      // rolls back). On the sequential-fallback path (custom executor)
      // the first write WOULD have committed, but here we use real D1
      // / DO so atomicity holds.
      const u2 = await db.users.where({ id: 2 }).first();
      expect(u2.data).toBeUndefined();
    });
  });
}

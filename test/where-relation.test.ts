/**
 * where-on-relation tests.
 *
 * Schema declares `posts.userId -> users.id`. From `users`'s POV, `posts`
 * becomes a hasMany relation. The where compiler detects relation keys
 * and emits EXISTS / NOT EXISTS / correlated count subqueries.
 *
 * Vocabulary on the relation value:
 *   - { any: <where> }                       → EXISTS
 *   - { none: <where> }                      → NOT EXISTS
 *   - <number>                               → count = N
 *   - { eq | ne | gt | gte | lt | lte: N }   → count compare
 *   - { between | notBetween: [low, high] }  → count range
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
      ],
    },
    {
      name: 'posts',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'title', type: 'text' },
        { name: 'published', type: 'integer' },
        {
          name: 'userId',
          type: 'integer',
          references: { table: 'users', column: 'id' },
        },
      ],
    },
    {
      name: 'comments',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'body', type: 'text' },
        {
          name: 'postId',
          type: 'integer',
          references: { table: 'posts', column: 'id' },
        },
      ],
    },
  ],
};

describe('where on hasMany relation', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  // ── EXISTS / NOT EXISTS ─────────────────────────────────────

  it('any: {} → EXISTS (no inner predicate)', async () => {
    await db.table('users').where({ posts: { any: {} } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE EXISTS (SELECT 1 FROM posts WHERE posts.userId = users.id)'
    );
    expect(m.lastParams()).toEqual([]);
  });

  it('any: { published: 1 } → EXISTS with AND predicate', async () => {
    await db
      .table('users')
      .where({ posts: { any: { published: 1 } } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE EXISTS (SELECT 1 FROM posts WHERE posts.userId = users.id AND (published = ?))'
    );
    expect(m.lastParams()).toEqual([1]);
  });

  it('none: {} → NOT EXISTS', async () => {
    await db.table('users').where({ posts: { none: {} } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE NOT EXISTS (SELECT 1 FROM posts WHERE posts.userId = users.id)'
    );
  });

  it('none: { published: 1 } → NOT EXISTS with predicate', async () => {
    await db
      .table('users')
      .where({ posts: { none: { published: 1 } } })
      .many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE NOT EXISTS (SELECT 1 FROM posts WHERE posts.userId = users.id AND (published = ?))'
    );
  });

  // ── Count comparisons ───────────────────────────────────────

  it('bare number → count = N', async () => {
    await db.table('users').where({ posts: 5 }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (SELECT count(*) FROM posts WHERE posts.userId = users.id) = ?'
    );
    expect(m.lastParams()).toEqual([5]);
  });

  it('{ gte: 5 } → count >= ?', async () => {
    await db.table('users').where({ posts: { gte: 5 } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (SELECT count(*) FROM posts WHERE posts.userId = users.id) >= ?'
    );
    expect(m.lastParams()).toEqual([5]);
  });

  it('{ lt: 3 } → count < ?', async () => {
    await db.table('users').where({ posts: { lt: 3 } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (SELECT count(*) FROM posts WHERE posts.userId = users.id) < ?'
    );
    expect(m.lastParams()).toEqual([3]);
  });

  it('{ between: [5, 10] } → count BETWEEN', async () => {
    await db.table('users').where({ posts: { between: [5, 10] } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (SELECT count(*) FROM posts WHERE posts.userId = users.id) BETWEEN ? AND ?'
    );
    expect(m.lastParams()).toEqual([5, 10]);
  });

  it('{ ne: 0 } → count <> ?', async () => {
    await db.table('users').where({ posts: { ne: 0 } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (SELECT count(*) FROM posts WHERE posts.userId = users.id) <> ?'
    );
  });

  it('{ gte: 5, lt: 10 } → AND-combined count comparisons', async () => {
    await db.table('users').where({ posts: { gte: 5, lt: 10 } }).many();
    expect(m.lastSql()).toBe(
      'SELECT * FROM users WHERE (SELECT count(*) FROM posts WHERE posts.userId = users.id) >= ? AND (SELECT count(*) FROM posts WHERE posts.userId = users.id) < ?'
    );
    expect(m.lastParams()).toEqual([5, 10]);
  });

  // ── Composition with column predicates ──────────────────────

  it('combines relation predicate with column predicates (AND)', async () => {
    await db
      .table('users')
      .where({ email: { contains: 'cloud' }, posts: { any: { published: 1 } } })
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM users WHERE (email LIKE ? ESCAPE '\\') AND (EXISTS (SELECT 1 FROM posts WHERE posts.userId = users.id AND (published = ?)))"
    );
    expect(m.lastParams()).toEqual(['%cloud%', 1]);
  });

  it('relation predicate inside whereAny (OR group)', async () => {
    await db
      .table('users')
      .whereAny([
        { posts: { any: { published: 1 } } },
        { email: { contains: 'admin' } },
      ])
      .many();
    expect(m.lastSql()).toBe(
      "SELECT * FROM users WHERE (EXISTS (SELECT 1 FROM posts WHERE posts.userId = users.id AND (published = ?)) OR email LIKE ? ESCAPE '\\')"
    );
    expect(m.lastParams()).toEqual([1, '%admin%']);
  });

  // ── Nested relation predicates ──────────────────────────────

  it('any: { comments: { any: {...} } } → nested EXISTS', async () => {
    // "Users with any post that has any comment" — relation predicate
    // nested inside a relation predicate. Each level walks down via
    // EXISTS so the FK chain stays correct.
    await db
      .table('users')
      .where({
        posts: { any: { comments: { any: { body: { contains: 'great' } } } } },
      })
      .many();
    const sql = m.lastSql();
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM posts WHERE posts.userId = users.id AND'
    );
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM comments WHERE comments.postId = posts.id'
    );
    expect(sql).toContain('body LIKE ?');
  });

  // ── Error handling ──────────────────────────────────────────

  it('unknown relation predicate shape throws', async () => {
    await expect(async () => {
      await db
        .table('users')
        .where({ posts: { unknownOp: 5 } as any })
        .many();
    }).rejects.toThrow(/Unrecognized relation predicate/);
  });

  // ── No-schema fallback (no relations registered) ────────────

  it('without schema, relation key falls through to plain column compile', async () => {
    const m2 = createMockExecutor();
    const dbNoSchema = createRuntimeOrm(m2.execute);
    // Without schema, `posts` isn't a known relation — gets treated as
    // a normal column key. The user gets a SQL error at runtime, but
    // we don't second-guess them.
    await dbNoSchema
      .table('users')
      .where({ posts: 5 })
      .many();
    expect(m2.lastSql()).toBe('SELECT * FROM users WHERE posts = ?');
  });
});

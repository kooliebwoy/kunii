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
        { name: 'userId', type: 'integer', references: { table: 'users', column: 'id' } },
        { name: 'title', type: 'text' },
        { name: 'meta', type: 'json' },
      ],
    },
    {
      name: 'comments',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'postId', type: 'integer', references: { table: 'posts', column: 'id' } },
        { name: 'body', type: 'text' },
      ],
    },
  ],
};

describe('include (relations)', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute);
  });

  it('belongsTo via FK column on parent rows', async () => {
    m.respond([
      {
        match: 'SELECT * FROM posts',
        rows: [
          { id: 1, title: 'p1', authorId: 10 },
          { id: 2, title: 'p2', authorId: 20 },
        ],
      },
      {
        match: 'SELECT * FROM authors',
        rows: [
          { id: 10, name: 'Ada' },
          { id: 20, name: 'Bob' },
        ],
      },
    ]);

    const res = await db.table('posts').include({ authors: true }).many();
    expect(res.success).toBe(true);
    const rows = (res as any).data;
    expect(rows[0].authors).toEqual({ id: 10, name: 'Ada' });
    expect(rows[1].authors).toEqual({ id: 20, name: 'Bob' });

    expect(m.calls[0].sql).toBe('SELECT * FROM posts');
    // Includes use json_each — same scaling story as the rest of the ORM.
    expect(m.calls[1].sql).toBe(
      'SELECT * FROM authors WHERE id IN (SELECT value FROM json_each(?))'
    );
    expect(m.calls[1].params).toEqual(['[10,20]']);
  });

  it('hasMany via foreignKey on child', async () => {
    m.respond([
      {
        match: 'SELECT * FROM users',
        rows: [{ id: 1, email: 'a@b.com' }],
      },
      {
        match: 'SELECT * FROM posts',
        rows: [
          { id: 100, userId: 1, title: 'A' },
          { id: 101, userId: 1, title: 'B' },
        ],
      },
    ]);

    const res = await db.table('users').include({ posts: true }).many();
    const rows = (res as any).data;
    expect(rows[0].posts).toHaveLength(2);
    expect(m.calls[1].sql).toBe(
      'SELECT * FROM posts WHERE userId IN (SELECT value FROM json_each(?))'
    );
    expect(m.calls[1].params).toEqual(['[1]']);
  });

  it('include with custom localKey/foreignKey/as', async () => {
    m.respond([
      {
        match: 'SELECT * FROM teams',
        rows: [{ team_id: 7, name: 'Alpha' }],
      },
      {
        match: 'SELECT * FROM members',
        rows: [{ id: 1, team_ref: 7 }],
      },
    ]);

    await db
      .table('teams')
      .include({
        members: {
          table: 'members',
          localKey: 'team_id',
          foreignKey: 'team_ref',
          as: 'roster',
        },
      })
      .many();

    expect(m.calls[1].sql).toBe(
      'SELECT * FROM members WHERE team_ref IN (SELECT value FROM json_each(?))'
    );
  });

  it('parent rows with no matching FK get an empty array (hasMany)', async () => {
    m.respond([
      {
        match: 'SELECT * FROM users',
        rows: [{ id: 1, email: 'a@b.com' }, { id: 2, email: 'b@b.com' }],
      },
      {
        match: 'SELECT * FROM posts',
        rows: [{ id: 100, userId: 1, title: 'A' }],
      },
    ]);
    const res = await db.table('users').include({ posts: true }).many();
    const rows = (res as any).data;
    expect(rows[0].posts).toHaveLength(1);
    expect(rows[1].posts).toEqual([]);
  });

  // ── Filtered include ──────────────────────────────────────────

  describe('filtered include', () => {
    it('hasMany with where filter on children', async () => {
      m.respond([
        { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
        { match: 'SELECT * FROM posts', rows: [{ id: 100, userId: 1 }] },
      ]);

      await db
        .table('users')
        .include({ posts: { where: { published: true } } })
        .many();

      // FK clause + user where AND'd together.
      expect(m.calls[1].sql).toBe(
        'SELECT * FROM posts WHERE userId IN (SELECT value FROM json_each(?)) AND (published = ?)'
      );
      expect(m.calls[1].params).toEqual(['[1]', true]);
    });

    it('hasMany with orderBy on children', async () => {
      m.respond([
        { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
        { match: 'SELECT * FROM posts', rows: [] },
      ]);
      await db
        .table('users')
        .include({ posts: { orderBy: { createdAt: 'desc' } } })
        .many();
      expect(m.calls[1].sql).toBe(
        'SELECT * FROM posts WHERE userId IN (SELECT value FROM json_each(?)) ORDER BY createdAt DESC'
      );
    });

    it('hasMany with limit emits ROW_NUMBER per-parent top-N', async () => {
      m.respond([
        { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
        { match: 'SELECT * FROM', rows: [] },
      ]);
      await db
        .table('users')
        .include({
          posts: { orderBy: { createdAt: 'desc' }, limit: 5 },
        })
        .many();

      const sql = m.calls[1].sql;
      // Outer SELECT wraps an inner subquery with ROW_NUMBER() OVER PARTITION.
      expect(sql).toContain(
        'ROW_NUMBER() OVER (PARTITION BY userId ORDER BY createdAt DESC)'
      );
      expect(sql).toContain('AS __rn');
      expect(sql).toContain('WHERE __rn <= ?');
      // Last param is the per-parent limit.
      expect(m.calls[1].params[m.calls[1].params.length - 1]).toBe(5);
    });

    it('hasMany with limit but no orderBy partitions by FK with stable order', async () => {
      m.respond([
        { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
        { match: 'SELECT * FROM', rows: [] },
      ]);
      await db.table('users').include({ posts: { limit: 3 } }).many();
      const sql = m.calls[1].sql;
      // Without user orderBy, falls back to ordering by the FK so ROW_NUMBER
      // has a deterministic basis.
      expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY userId ORDER BY userId)');
      expect(m.calls[1].params[m.calls[1].params.length - 1]).toBe(3);
    });

    it('hasMany with select narrows columns and always keeps the FK', async () => {
      m.respond([
        { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
        { match: 'SELECT', rows: [] },
      ]);
      await db
        .table('users')
        .include({ posts: { select: ['id', 'title'] } })
        .many();
      const sql = m.calls[1].sql;
      // FK appended automatically.
      expect(sql).toBe(
        'SELECT id, title, userId FROM posts WHERE userId IN (SELECT value FROM json_each(?))'
      );
    });

    it('hasMany with select that already contains the FK does not duplicate', async () => {
      m.respond([
        { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
        { match: 'SELECT', rows: [] },
      ]);
      await db
        .table('users')
        .include({ posts: { select: ['id', 'userId', 'title'] } })
        .many();
      expect(m.calls[1].sql).toBe(
        'SELECT id, userId, title FROM posts WHERE userId IN (SELECT value FROM json_each(?))'
      );
    });

    it('belongsTo with where filter still loads the parent FK target', async () => {
      m.respond([
        {
          match: 'SELECT * FROM posts',
          rows: [{ id: 1, authorId: 10 }],
        },
        {
          match: 'SELECT * FROM authors',
          rows: [{ id: 10, name: 'Ada', active: 1 }],
        },
      ]);
      await db
        .table('posts')
        .include({ authors: { where: { active: 1 } } })
        .many();
      expect(m.calls[1].sql).toBe(
        'SELECT * FROM authors WHERE id IN (SELECT value FROM json_each(?)) AND (active = ?)'
      );
      expect(m.calls[1].params).toEqual(['[10]', 1]);
    });

    it('combines where + orderBy + limit + select', async () => {
      m.respond([
        { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
        { match: 'SELECT', rows: [] },
      ]);
      await db
        .table('users')
        .include({
          posts: {
            where: { published: true },
            orderBy: { createdAt: 'desc' },
            limit: 10,
            select: ['id', 'title'],
          },
        })
        .many();
      const sql = m.calls[1].sql;
      expect(sql).toContain('SELECT id, title, userId, ROW_NUMBER() OVER');
      expect(sql).toContain(
        'WHERE userId IN (SELECT value FROM json_each(?)) AND (published = ?)'
      );
      expect(sql).toContain('WHERE __rn <= ?');
      expect(m.calls[1].params).toEqual(['[1]', true, 10]);
    });
  });
});

describe('include with schema-derived child behavior', () => {
  let m: MockExecutor;
  let db: ReturnType<typeof createRuntimeOrm>;

  beforeEach(() => {
    m = createMockExecutor();
    db = createRuntimeOrm(m.execute, schema);
  });

  it('child where/order/select understand JSON path columns', async () => {
    m.respond([
      { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
      { match: 'SELECT', rows: [] },
    ]);

    await db
      .table('users')
      .include({
        posts: {
          where: { 'meta.kind': 'news' },
          orderBy: { 'meta.rank': 'desc' },
          select: ['id', 'meta.kind'],
        },
      })
      .many();

    expect(m.calls[1].sql).toBe(
      'SELECT id, meta ->> \'$.kind\' AS "meta.kind", userId FROM posts WHERE userId IN (SELECT value FROM json_each(?)) AND (meta ->> \'$.kind\' = ?) ORDER BY meta ->> \'$.rank\' DESC'
    );
    expect(m.calls[1].params).toEqual(['[1]', 'news']);
  });

  it('loads nested hasMany includes on included rows', async () => {
    m.respond([
      { match: 'SELECT * FROM users', rows: [{ id: 1, email: 'a@b.com' }] },
      {
        match: 'SELECT * FROM posts',
        rows: [
          { id: 10, userId: 1, title: 'A' },
          { id: 11, userId: 1, title: 'B' },
        ],
      },
      {
        match: 'SELECT * FROM comments',
        rows: [
          { id: 100, postId: 10, body: 'first' },
          { id: 101, postId: 10, body: 'second' },
          { id: 102, postId: 11, body: 'third' },
        ],
      },
    ]);

    const res = await db
      .table('users')
      .include({ posts: { include: { comments: true }, orderBy: { id: 'asc' } } })
      .many();

    expect(m.calls[2].sql).toBe(
      'SELECT * FROM comments WHERE postId IN (SELECT value FROM json_each(?))'
    );
    expect(m.calls[2].params).toEqual(['[10,11]']);
    expect((res as any).data[0].posts[0].comments.map((c: any) => c.id)).toEqual([100, 101]);
    expect((res as any).data[0].posts[1].comments.map((c: any) => c.id)).toEqual([102]);
  });

  it('include where can use nested relation predicates', async () => {
    m.respond([
      { match: 'SELECT * FROM users', rows: [{ id: 1 }] },
      { match: 'SELECT * FROM posts', rows: [] },
    ]);

    await db
      .table('users')
      .include({
        posts: {
          where: { comments: { any: { body: { contains: 'ship' } } } },
        },
      })
      .many();

    expect(m.calls[1].sql).toContain(
      'EXISTS (SELECT 1 FROM comments WHERE comments.postId = posts.id'
    );
    expect(m.calls[1].params).toEqual(['[1]', '%ship%']);
  });
});

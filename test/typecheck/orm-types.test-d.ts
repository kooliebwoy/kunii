import type { QueryResult, Table } from '../../src/index.js';

type UserRow = {
  id: number;
  email: string;
  tier: 'free' | 'pro' | null;
  meta: { plan: string } | null;
};

declare const users: Table<UserRow>;

// Reads preserve row shape.
const manyResult: Promise<QueryResult<UserRow[]>> = users.many();
const firstResult: Promise<QueryResult<UserRow | undefined>> = users.first();
const oneResult: Promise<QueryResult<UserRow>> = users.one();

void manyResult;
void firstResult;
void oneResult;

// Writes check known row fields.
users.insert({ id: 1, email: 'a@b.com', tier: 'pro', meta: { plan: 'pro' } });
users.insert([{ id: 1, email: 'a@b.com' }, { id: 2, email: 'b@b.com', tier: 'free' }]);
users.where({ id: 1 }).update({ tier: 'pro' });
users.upsert({
  values: { id: 1, email: 'a@b.com', tier: 'free' },
  onConflict: 'id',
  update: { tier: 'pro' },
});

// Kuratchi intentionally permits extra runtime fields and JSON-path writes;
// schema-aware runtime code filters unknown fields when a schema is supplied.
users.insert({ id: 1, email: 'a@b.com', extraRuntimeField: true });
users.where({ id: 1 }).update({ 'meta.plan': 'enterprise' });

// @ts-expect-error known numeric fields reject strings
users.insert({ id: '1', email: 'a@b.com' });

// @ts-expect-error known enum fields reject invalid literals
users.where({ id: 1 }).update({ tier: 'enterprise' });

// @ts-expect-error upsert values check known fields
users.upsert({ values: { id: '1', email: 'a@b.com' }, onConflict: 'id', update: 'ignore' });

// @ts-expect-error explicit upsert update checks known fields
users.upsert({ values: { id: 1, email: 'a@b.com' }, onConflict: 'id', update: { email: 123 } });

// Where remains intentionally permissive so JSON paths, relation predicates,
// and raw-ish dynamic filters can evolve without type-level lock-in.
users.where({ id: 1, 'meta.plan': 'pro', posts: { any: { published: 1 } } });

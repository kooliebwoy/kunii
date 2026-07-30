# Kunii

Workers-native ORM for Cloudflare D1 and Durable Object SQLite.

## Install

```bash
npm install @kuratchi/kunii
```

## D1 usage

```ts
import { kunii } from '@kuratchi/kunii';
import { env } from 'cloudflare:workers';
import { appSchema } from './schema';

// Pass the schema and you get JSON path queries and insert validation
// for free. Without a schema the ORM still works,
// but JSON columns stay opaque.
const db = kunii(env.DB, appSchema);
// or with a deferred binding: kunii(() => env.DB, appSchema)

await db.todos.insert({ title: 'Hello' });
const todos = await db.todos.orderBy({ created_at: 'desc' }).many();
```

## Framework init

Kunii is Cloudflare-only: D1 for async request handlers and
Durable Object SQLite for DO-local state. If your app runs on Cloudflare
Workers through SvelteKit, Next/OpenNext, Nuxt, Astro, or Koze, use
the framework adapter that matches where Cloudflare exposes `env`. Plain
Workers use the top-level primitives directly.

```ts
import { initKuniiORM } from '@kuratchi/kunii';
import { appSchema } from './schema';

const orm = initKuniiORM({ DB: appSchema });

export default {
  async fetch(request, env, ctx) {
    await orm.migrateOnce(env);
    const db = orm.db(env, 'DB');
    const todos = await db.todos.orderBy({ created_at: 'desc' }).many();
    return Response.json(todos.data);
  },
};
```

Available adapter paths:

- `kunii/koze` - `orm.middleware()` for Koze middleware
- `kunii/sveltekit` - `orm.handle()` for `src/hooks.server.ts`
- `kunii/next` - `orm.route(handler)` for OpenNext route handlers
- `kunii/nuxt` - `orm.eventHandler()` for Nitro middleware
- `kunii/astro` - `orm.middleware()` for Astro middleware

Every adapter runs `migrateOnce(env)` before your handler and then gives you
schema-aware clients. Direct query clients (`kunii`, `orm.db`, and
`orm.clients`) never run DDL by themselves.

## Durable Object usage

```ts
import { initKuniiDO } from '@kuratchi/kunii';
import { DurableObject } from 'cloudflare:workers';

export class OrgDO extends DurableObject {
  db;
  constructor(ctx, env) {
    super(ctx, env);
    this.db = initKuniiDO(ctx.storage, appSchema);
  }
}
```

`initKuniiDO` runs the existing synchronous DO migration path
(`CREATE TABLE IF NOT EXISTS` plus additive `ALTER TABLE ADD COLUMN`) and
returns `kunii(ctx.storage.sql, schema)`. Pass `ctx.storage` (preferred)
so atomic `db.batch()` can use `transactionSync`.

## Schema DSL

```ts
import type { SchemaDsl } from '@kuratchi/kunii';

export const appSchema: SchemaDsl = {
  name: 'app',
  version: 1,
  tables: {
    todos: {
      id: 'integer primary key',
      title: 'text not null',
      done: 'integer not null default 0',
    },
  },
};
```

## First-class JSON columns

Mark a column `json` and the ORM compiles dotted keys to surgical SQLite JSON SQL — no manual `json_extract`, no round-trips through your Worker.

```ts
tables: {
  events: { id: 'integer primary key', payload: 'json' },
}

// reads — `payload ->> '$.user.tier'`
await db.events.where({ 'payload.user.tier': 'pro' }).many();

// writes — `json_set(payload, '$.tier', ?)`, multi-path merges into one call
await db.events.where({ id: 1 }).update({
  'payload.tier': 'pro',
  'payload.seats': 5,
});

// large IN lists use `json_each` (single bound param, no D1 placeholder cap)
await db.todos.whereIn('id', tenThousandIds);
```

See [Querying](../../apps/docs/src/content/kunii/querying.md) for full coverage.

## API surface

There is one interface — `Table<Row>`. `db.users` *is* a query (an empty one). Every method either continues the chain (returns `Table<Row>`) or terminates it (returns `Promise<QueryResult>`). Cardinality always comes from the chain, never the verb:

```ts
db.users.where({ id: 1 }).first();           // one row
db.users.where({ id: 1 }).update({ x: 1 });  // updates one row (id is unique)
db.users.where({ tier: 'free' }).delete();   // deletes all matching rows
```

`update` and `delete` require a preceding `where` to prevent accidental table-wide writes. There are no shortcuts (no `delete({ id })` or `count(where)`) — the chain is the only way to express scope, which keeps the model uniform across human and agent authors.

## Filter shape

`where({ ... })` reads value shape and operator object together. Most queries don't need an operator name:

```ts
db.users.where({ id: 1 })                          // = 1
db.users.where({ deleted_at: null })               // IS NULL
db.users.where({ tier: ['pro', 'enterprise'] })    // IN (...)

// Operator object for everything else
db.users.where({ age: { gte: 18, lt: 65 } })
db.users.where({ score: { between: [50, 100] } })
db.users.where({ email: { contains: 'cloud' } })   // auto-escapes %/_
db.users.where({ name: { like: 'A%' } })           // raw LIKE pattern
db.users.where({ tier: { notIn: ['banned'] } })

// OR
db.users.whereAny([
  { tier: 'pro' },
  { tier: 'enterprise', age: { gte: 21 } },
])
```

Bare strings are always equality — no auto-`LIKE` magic. Pass arrays of any size to `IN` (compiles to `json_each`, no D1 placeholder cap). Empty arrays are predictable: `{ in: [] }` matches nothing, `{ notIn: [] }` matches everything.

## Relations

Mark FKs in the schema with `'-> table.column'` and the ORM auto-derives a relation registry. From the parent's POV, the child table becomes a relation key inside `where` and `include`:

```ts
posts: { id: 'integer primary key', userId: 'integer -> users.id' }

// Filter parents by relation existence/count
db.users.where({ posts: { any: { published: 1 } } })   // EXISTS
db.users.where({ posts: { none: {} } })                 // NOT EXISTS
db.users.where({ posts: { gte: 5 } })                   // count >= 5

// Filtered eager loading — same operator shape as a chain
db.users.include({
  posts: {
    where: { published: 1 },
    orderBy: { createdAt: 'desc' },
    limit: 10,                    // top N PER PARENT (window function)
    select: ['id', 'title'],
  },
})
```

## `returning()` / `upsert()` / `db.batch()`

```ts
// Get the inserted row (including auto-id) without a follow-up SELECT.
const { data } = await db.users.returning().insert({ email: 'a@b.com' });

// Insert-or-update in one round-trip.
await db.users.upsert({
  values: { id: 1, email: 'a@b.com', tier: 'pro' },
  onConflict: 'id',
  update: 'all', // or 'ignore' / { explicit: 'set' }
});

// Atomic multi-write: one HTTP round-trip on D1, transactionSync on DO.
await db.batch(async (tx) => {
  await tx.users.where({ id: 1 }).update({ tier: 'pro' });
  await tx.audit.insert({ event: 'tier_change', userId: 1 });
});
```

## Aggregates and groupBy

```ts
const total = await db.orders.where({ status: 'paid' }).sum('amount');

const topByUser = await db.posts
  .select({
    userId: true,
    total: { sum: 'views' },
    n: { count: '*' },
  })
  .groupBy('userId')
  .having({ n: { gte: 5 } })
  .orderBy({ total: 'desc' })
  .limit(10)
  .many();
```

## Type inference

```ts
import { generateTypes } from '@kuratchi/kunii/codegen';
import { writeFile } from 'node:fs/promises';
import { appSchema } from './schema';

await writeFile('src/db-types.d.ts', generateTypes(appSchema));
```

Then in your worker:

```ts
import type { AppOrm } from './db-types';
const db = kunii(env.DB, appSchema) as unknown as AppOrm;
const u = await db.users.where({ id: 1 }).first();
// u.data.email is `string`, u.data.name is `string | null`, etc.
```

See [Querying](../../apps/docs/src/content/kunii/querying.md) for the full reference.

## Testing

Two test suites:

- **Unit (`bun run test`)** — fast (~250ms). Asserts on emitted SQL strings using a mock `SqlExecutor`. 184 tests covering the full `Table<Row>` surface.
- **Integration (`bun run test:integration`)** — runs inside `workerd` via `@cloudflare/vitest-pool-workers`. Same suite executes against a real Cloudflare D1 binding *and* a real Durable Object `SqlStorage`. 156 tests proving the ORM's SQL is semantically correct on both backends.

Run both with `bun run test:all`.

## Auto-migration on cold start

For new Cloudflare apps, prefer the framework adapter paths above. The older
legacy Koze-specific helper remains supported and applies pending migrations on
the first request per worker isolate:

```ts
// src/middleware.ts
import { defineMiddleware } from '@kuratchi/koze';
import { autoMigrate } from '@kuratchi/kunii';
import { adminSchema } from './server/schemas/admin';

export default defineMiddleware({
  migrate: autoMigrate({ DB: adminSchema }),
  // ...other steps
});
```

If you'd rather manage migrations out-of-band (e.g. CI running `wrangler d1 migrations apply`), simply omit the `autoMigrate` step. The query client `kunii(env.DB, schema)` works the same either way - it never issues DDL.

The package also ships `assertSchemaInSync({ DB: schema })` as an opt-in dev check that throws on schema drift. Drop it into your middleware behind an `import.meta.env.DEV` guard to catch missing migrations before they surface as `no such table` errors.

## Generating migration SQL manually

For BYO migration workflows, the underlying DDL helpers are exported under `kunii/migrations`:

```ts
import { buildInitialSql, buildDiffSql, diffSchemas } from '@kuratchi/kunii/migrations';

// First-time creation
const sql = buildInitialSql(adminSchema);

// Diff against an existing DB shape
const diff = diffSchemas(currentSchema, adminSchema);
const { sql: upgradeSql, warnings } = buildDiffSql(currentSchema, adminSchema);
```

## License and use

MIT licensed. You can use, copy, modify, merge, publish, distribute,
sublicense, and sell copies of this package for personal, internal, commercial,
or open source projects. Keep the copyright and license notice with substantial
copies of the software. This package is provided as-is, without warranty.

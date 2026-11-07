# Kunii

Lightweight, zero-dependency, Workers-native ORM for **Cloudflare D1** and **Durable Object SQLite**.

**[Full Documentation → https://kuratchi.dev/docs/kunii](https://kuratchi.dev/docs/kunii)**

---

## Install

```bash
npm install @kuratchi/kunii
```

---

## Quick Start

### 1. Define your schema

Define tables, mixins, indexes, FTS5 virtual tables, JSON columns, enums, and foreign keys with a compact object DSL:

```ts
// src/schema.ts
import type { SchemaDsl } from '@kuratchi/kunii';

export const appSchema: SchemaDsl = {
  name: 'app',
  version: 1,
  mixins: {
    timestamps: {
      created_at: 'text default now',
      updated_at: 'text default now',
    },
  },
  tables: {
    users: {
      id: 'integer primary key',
      email: 'text not null unique',
      tier: 'enum(free,pro,enterprise) default free',
      meta: 'json',
      '...timestamps': true,
    },
    todos: {
      id: 'integer primary key',
      userId: 'integer not null -> users.id cascade',
      title: 'text not null',
      done: 'boolean not null default 0',
      '...timestamps': true,
    },
  },
  indexes: {
    todos: {
      idx_todos_user_done: { columns: ['userId', 'done'] },
    },
  },
  virtualTables: {
    todos_fts: {
      module: 'fts5',
      columns: ['title'],
      options: ["tokenize='porter unicode61'"],
    },
  },
};
```

> 📖 See [Schema DSL](https://kuratchi.dev/docs/kunii/schema-dsl) for all column types (`text`, `integer`, `real`, `blob`, `json`, `boolean`, `timestamp_ms`), constraints, and normalization helpers.

### 2. Connect to D1

Pass your D1 binding and schema to `kunii()`. Passing the schema gives you surgical JSON path queries, automatic JSON serialization/parsing, relation loading, and insert field validation out of the box:

```ts
import { kunii } from '@kuratchi/kunii';
import { env } from 'cloudflare:workers';
import { appSchema } from './schema';

// Immediate binding
const db = kunii(env.DB, appSchema);

// Or lazy getter for module-level singletons (resolved at query time)
const lazyDb = kunii(() => env.DB, appSchema);

await db.todos.insert({ userId: 1, title: 'Ship Kunii' });
const todos = await db.todos.where({ done: false }).orderBy({ created_at: 'desc' }).many();
```

### 3. Connect to Durable Object SQLite

Inside a Durable Object, initialize synchronously in the constructor with `initKuniiDO()`:

```ts
import { DurableObject } from 'cloudflare:workers';
import { initKuniiDO } from '@kuratchi/kunii';
import { appSchema } from './schema';

export class OrgDO extends DurableObject {
  db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = initKuniiDO(ctx.storage, appSchema);
  }

  async listTodos() {
    return this.db.todos.orderBy({ created_at: 'desc' }).many();
  }
}
```

`initKuniiDO(ctx.storage, schema)` runs the same versioned migration engine as D1 synchronously, using `transactionSync` for atomic migrations. It supports the same rename hints, verified rebuilds, index updates, rollback protection, and pending-change rules. It also attaches `transactionSync` for atomic `db.batch()` calls and returns a schema-aware `kunii` client. Pass `ctx.storage` to supply transaction support. Bare `ctx.storage.sql` without an attached transaction function retains the executor-only additive fallback.

---

## Setup & Framework Adapters

Kunii is built specifically for Cloudflare Workers. Every framework adapter runs `migrateOnce(env)` on the first request per Worker isolate and exposes schema-aware clients. Direct query clients (`kunii`, `orm.db`, and `orm.clients`) never run DDL on their own.

| Environment | Import Path | Helper | Where Clients Live |
| :--- | :--- | :--- | :--- |
| **Plain Workers** | `@kuratchi/kunii` | `orm.migrateOnce(env)` + `orm.db(env, 'DB')` | Returned directly |
| **Koze** | `@kuratchi/kunii/koze` | `orm.middleware({ locals: 'kunii' })` | `ctx.locals.kunii.DB` (opt-in) |
| **SvelteKit** | `@kuratchi/kunii/sveltekit` | `orm.handle()` | `event.locals.kunii.DB` |
| **Astro** | `@kuratchi/kunii/astro` | `orm.middleware()` | `context.locals.kunii.DB` |
| **Nuxt (Nitro)** | `@kuratchi/kunii/nuxt` | `orm.eventHandler()` | `event.context.kunii.DB` |
| **Next.js (OpenNext)** | `@kuratchi/kunii/next` | `orm.route(handler)` | `{ db }` handler context (`db.DB`) |

### Plain Cloudflare Workers

```ts
import { initKuniiORM } from '@kuratchi/kunii';
import { appSchema } from './schema';

const orm = initKuniiORM({ DB: appSchema });

export default {
  async fetch(request: Request, env: Env) {
    await orm.migrateOnce(env);
    const db = orm.db(env, 'DB');
    const todos = await db.todos.orderBy({ created_at: 'desc' }).many();
    return Response.json(todos.data);
  },
};
```

### Koze

```ts
// src/middleware.ts
import { defineMiddleware } from '@kuratchi/koze';
import { initKuniiORM } from '@kuratchi/kunii/koze';
import { appSchema } from './server/schemas/app';

const orm = initKuniiORM({ DB: appSchema });

export default defineMiddleware({
  orm: orm.middleware({ locals: 'kunii' }),
});
```

### SvelteKit (`@sveltejs/adapter-cloudflare`)

```ts
// src/hooks.server.ts
import { initKuniiORM } from '@kuratchi/kunii/sveltekit';
import { appSchema } from '$lib/server/schemas/app';

const orm = initKuniiORM({ DB: appSchema });

export const handle = orm.handle(); // populates event.locals.kunii.DB
```

### Astro (`@astrojs/cloudflare`)

```ts
// src/middleware.ts
import { initKuniiORM } from '@kuratchi/kunii/astro';
import { appSchema } from './schemas/app';

const orm = initKuniiORM({ DB: appSchema });

export const onRequest = orm.middleware(); // populates context.locals.kunii.DB
```

### Nuxt (Nitro on Cloudflare)

```ts
// server/middleware/orm.ts
import { initKuniiORM } from '@kuratchi/kunii/nuxt';
import { appSchema } from '../schemas/app';

const orm = initKuniiORM({ DB: appSchema });

export default orm.eventHandler(); // populates event.context.kunii.DB
```

### Next.js (`@opennextjs/cloudflare`)

```ts
// app/api/todos/route.ts
import { initKuniiORM } from '@kuratchi/kunii/next';
import { appSchema } from '@/server/schemas/app';

const orm = initKuniiORM({ DB: appSchema });

export const GET = orm.route(async ({ db }) => {
  const todos = await db.DB.todos.many();
  return Response.json(todos.data);
});
```

> 📖 See [Framework Adapters](https://kuratchi.dev/docs/kunii/framework-adapters) and [Koze Integration](https://kuratchi.dev/docs/kunii/koze-integration) for multi-database configurations and custom binding resolution.

---

## Querying & API Surface

There is one core interface: `Table<Row>`. `db.users` *is* an empty query representing all rows. Every method either continues the chain (returns `Table<Row>`) or terminates it (returns `Promise<QueryResult<T>>` or `Promise<boolean>` for `exists()`).

Cardinality always comes from the chain, never the verb:

```ts
await db.users.many();                                    // all rows
await db.users.where({ id: 1 }).first();                  // first matching row (or undefined)
await db.users.where({ id: 1 }).one();                    // exact single row (errors if 0 or >1)
await db.users.where({ email: 'a@b.com' }).exists();      // boolean
await db.users.where({ tier: 'pro' }).count();            // row count
await db.users.where({ tier: 'pro' }).distinct('email');  // distinct values array

// Writes require a preceding .where() to prevent accidental full-table mutations
await db.users.where({ id: 1 }).update({ tier: 'pro' });  // updates matching rows
await db.users.where({ tier: 'free' }).delete();          // deletes matching rows

// Chain .limit(1) with .orderBy() to narrow a broad update/delete to one row
await db.todos
  .where({ done: 0 })
  .orderBy({ created_at: 'asc' })
  .limit(1)
  .update({ done: 1 });
```

### Filtering (`where` & `whereAny`)

`where({ ... })` reads value shapes for common predicates and accepts an operator object for everything else:

```ts
// Value-shape shortcuts
db.users.where({ id: 1 })                          // id = 1
db.users.where({ deleted_at: null })               // deleted_at IS NULL
db.users.where({ tier: ['pro', 'enterprise'] })    // tier IN (SELECT value FROM json_each(?))

// Operator objects
db.users.where({ age: { gte: 18, lt: 65 } })       // age >= 18 AND age < 65
db.users.where({ score: { between: [50, 100] } })  // score BETWEEN 50 AND 100
db.users.where({ email: { contains: '50%' } })     // LIKE '%50\%%' ESCAPE '\' (auto-escapes % and _)
db.users.where({ name: { like: 'Ada%' } })         // raw LIKE pattern
db.users.where({ name: { notLike: '%bot%' } })     // raw NOT LIKE pattern
db.users.where({ tier: { notIn: ['banned'] } })    // NOT IN via json_each
db.users.where({ bio: { isNull: false } })         // IS NOT NULL

// OR groups — entries OR together, keys inside each entry AND together
db.users.whereAny([
  { tier: 'pro' },
  { tier: 'enterprise', age: { gte: 21 } },
])

// Raw parameterized SQL escape hatch
db.users.sql({ query: 'LOWER(email) = ?', params: ['ada@example.com'] })
```

- **Unbounded `IN` lists:** Both array shortcuts (`{ id: [...] }`) and `{ in: [...] }` / `{ notIn: [...] }` compile to `SELECT value FROM json_each(?)` with a single bound JSON parameter—bypassing D1's placeholder limit even with 10,000+ items.
- **Predictable empty arrays:** `{ id: [] }` / `{ in: [] }` compiles to `WHERE 0` (matches nothing); `{ notIn: [] }` compiles to `WHERE 1` (matches everything).

> 📖 See [Querying](https://kuratchi.dev/docs/kunii/querying) for the complete reference.

---

## First-Class JSON Columns

Mark a column `'json'` in your schema and Kunii compiles dotted paths and array indexes to surgical SQLite JSON expressions—no manual `json_extract` and no hauling full blobs into your Worker just to filter or patch a field.

```ts
// Reads compile to `->>` (SQL-typed extraction)
await db.users.where({ 'meta.profile.tier': 'pro' }).many();
// -> SELECT * FROM users WHERE meta ->> '$.profile.tier' = ?

await db.users.where({ 'meta.tags[0]': 'founder' }).orderBy({ 'meta.score': 'desc' }).many();
await db.users.select(['id', 'meta.profile.tier']).many();

// Writes compile to `json_set(...)` — multiple paths on the same column merge into one call
await db.users.where({ id: 1 }).update({
  'meta.tier': 'pro',
  'meta.seats': 5,
  'meta.flags': { beta: true }, // nested objects/arrays bind safely via json(?)
});
// -> UPDATE users SET meta = json_set(meta, '$.tier', ?, '$.seats', ?, '$.flags', json(?)) WHERE id = ?
```

> 📖 See [JSON Columns](https://kuratchi.dev/docs/kunii/json-columns) for details.

---

## Relations

Declare foreign keys in your schema with `'-> table.column'` and Kunii builds a relation registry for both `where()` existence/count predicates and `include()` eager loading:

```ts
// Filter parents by child existence or count
await db.users.where({ todos: { any: { done: 0 } } }).many();   // EXISTS (...)
await db.users.where({ todos: { none: {} } }).many();           // NOT EXISTS (...)
await db.users.where({ todos: { gte: 5 } }).many();             // (SELECT count(*) ...) >= 5
await db.users.where({ todos: { between: [1, 10] } }).many();   // count BETWEEN 1 AND 10

// Filtered eager loading
await db.users.include({
  todos: {
    where: { done: 0 },
    orderBy: { created_at: 'desc' },
    limit: 5,                   // top 5 PER USER via ROW_NUMBER() window function
    select: ['id', 'title'],    // FK is automatically included to stitch rows
  },
}).many();
```

> 📖 See [Relations](https://kuratchi.dev/docs/kunii/relations) for nested predicates and custom key mappings.

---

## Writes, Upserts & Atomic Batches

```ts
// returning() — get inserted/updated/deleted rows in one round-trip
const { data } = await db.users.returning(['id', 'email']).insert({ email: 'ada@example.com' });

// upsert() — INSERT ... ON CONFLICT DO UPDATE / DO NOTHING
await db.users.upsert({
  values: { id: 1, email: 'ada@example.com', tier: 'pro' },
  onConflict: 'id',
  update: 'all', // or 'ignore' | { tier: 'pro', 'meta.upgraded': true }
});

// db.batch() — single HTTP round-trip on D1, transactionSync on Durable Objects
const batchResult = await db.batch(async (tx) => {
  await tx.users.where({ id: 1 }).update({ tier: 'pro' });
  await tx.todos.insert({ userId: 1, title: 'Onboarding complete' });
});
```

> 📖 See [Writes and Transactions](https://kuratchi.dev/docs/kunii/writes-and-transactions) for details.

---

## Aggregates & Reporting

Run scalar aggregates directly or combine object-form `select()` with `groupBy()` and `having()`:

```ts
const totalViews = await db.posts.where({ published: 1 }).sum('views'); // number | null
const avgScore = await db.users.avg('meta.score');                      // JSON paths work too

const topAuthors = await db.posts
  .where({ published: 1 })
  .select({
    userId: true,
    totalViews: { sum: 'views' },
    postCount: { count: '*' },
    uniqueTags: { countDistinct: 'tag' },
  })
  .groupBy('userId')
  .having({ postCount: { gte: 5 }, totalViews: { gte: 1000 } })
  .orderBy({ totalViews: 'desc' })
  .limit(10)
  .many();
```

> 📖 See [Aggregates and Reporting](https://kuratchi.dev/docs/kunii/aggregates-and-reporting) for details.

---

## Type Generation (`@kuratchi/kunii/codegen`)

Generate a `.d.ts` file from your `SchemaDsl` or `DatabaseSchema` for full row-type inference across chains:

```ts
import { generateTypes } from '@kuratchi/kunii/codegen';
import { writeFile } from 'node:fs/promises';
import { appSchema } from './schema';

const dts = generateTypes(appSchema, {
  ormName: 'AppOrm',
  jsonShapes: {
    users: { meta: "import('./types').UserMeta" },
  },
});

await writeFile('src/db-types.d.ts', dts);
```

Type your client with the generated interface:

```ts
import { kunii } from '@kuratchi/kunii';
import type { AppOrm } from './db-types';
import { appSchema } from './schema';

const db = kunii(env.DB, appSchema) as unknown as AppOrm;
const user = await db.users.where({ id: 1 }).first();
// user.data?.email -> string
// user.data?.tier  -> "free" | "pro" | "enterprise" | null
```

> 📖 See [Type Generation](https://kuratchi.dev/docs/kunii/type-generation) for details.

---

## Migrations & Schema Drift Checks

When using `initKuniiORM` (or framework adapters), Kunii automatically tracks and applies schema changes at runtime in a `_kuratchi_migrations` table.

The D1 migrator creates missing tables, columns, and indexes. It preserves columns and indexes omitted from the target schema, including objects created outside Kunii. A forward version can rename a column with `mobile: 'text renameFrom phone'`, or `renameFrom: 'phone'` on a normalized column. Keep the hint until supported databases have upgraded. Kunii also rebuilds fully verified tables for constraint and default changes when dependencies allow an atomic swap. See [the runtime migration specification](MIGRATIONS.md) for supported operations and dependency limits. Kunii logs migration warnings before executing the plan, and `migrateOnce(env)` returns each binding's result.

Increase `schema.version` for forward deployments. Kunii skips versions older than its recorded snapshot. With a native D1 binding, a newer version can also replace an index that Kunii created and whose live definition still matches its recorded definition. D1 commits the replacement and migration history together. Legacy history is upgraded in place. Deploy this version of Kunii to every active Worker before relying on rollback protection.

For custom or CI/BYO migration workflows, use `@kuratchi/kunii/migrations` directly:

```ts
import {
  buildInitialSql,
  buildDiffSql,
  diffSchemas,
  runMigrations,
  hasPendingMigrations,
} from '@kuratchi/kunii/migrations';

// Generate initial CREATE TABLE / CREATE INDEX / CREATE VIRTUAL TABLE SQL
const initialSql = buildInitialSql(appSchema);

// Diff two schemas for upgrade SQL and safety warnings
const { sql: upgradeSql, warnings } = buildDiffSql(previousSchema, appSchema);

// Or run tracked runtime migrations manually
// Pass the native binding to apply schema changes and history atomically.
await runMigrations({
  execute: (sql, params) => env.DB.prepare(sql).bind(...(params || [])).all(),
  schema: appSchema,
  client: env.DB,
});
```

### Dev-mode Schema Drift Check & Legacy Helpers

If you manage migrations out-of-band, you can wire `assertSchemaInSync({ DB: appSchema })` in development to fail fast if the live D1 database has drifted from your TypeScript schema:

```ts
import { assertSchemaInSync, autoMigrate } from '@kuratchi/kunii';

export default defineMiddleware({
  // Fail fast in dev if migrations haven't been applied
  schemaCheck: import.meta.env.DEV ? assertSchemaInSync({ DB: appSchema }) : null,
  // Or use the standalone autoMigrate middleware helper
  migrate: autoMigrate({ DB: appSchema }),
});
```

> 📖 See [Migrations](https://kuratchi.dev/docs/kunii/migrations) for full details.

---

## Testing

Kunii ships with three verification suites:

- **Unit (`bun run test`)** — Fast (~220ms) SQL compilation and runtime behavioral suite (217 tests across 18 test files).
- **Typecheck (`bun run test:types`)** — Static type inference assertions (`tsc --noEmit`).
- **Integration (`bun run test:integration`)** — Runs inside `workerd` via `@cloudflare/vitest-pool-workers` against a real Cloudflare D1 binding and a real Durable Object `SqlStorage`.

Run everything with:

```bash
bun run test:all
```

---

## License

MIT

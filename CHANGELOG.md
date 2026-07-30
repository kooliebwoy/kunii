# @kuratchi/orm

## 0.2.3

### Patch Changes

- Publish the latest framework, ORM, auth, and UI package updates for real app testing.

## 0.2.2

### Patch Changes

- Release the latest framework and ORM updates in one coordinated patch bump.

  `koze` now ships the virtual-module runtime cleanup around the
  `koze:*` import surface, including the published runtime entrypoints used by
  middleware, access, and generated worker code.

  `@kuratchi/orm` includes the latest adapter and migration-generator work so the
  ORM package stays aligned with the current framework surface.

## 0.2.0

### Minor Changes

Phase B (continued), Phase C, and Phase D from the v0.1.0 roadmap.

#### `upsert()` — INSERT ... ON CONFLICT DO UPDATE

Single-round-trip insert-or-update for idempotent writes. Three modes:

```ts
// Refresh every non-target column from the new values.
await db.users.upsert({
  values: { id: 1, email: 'a@b.com', tier: 'pro' },
  onConflict: 'id',
  update: 'all',
});

// Insert if new, leave existing rows untouched.
await db.users.upsert({
  values: { id: 1, email: 'a@b.com' },
  onConflict: 'id',
  update: 'ignore',
});

// Explicit set values (supports JSON-path keys).
await db.users.upsert({
  values: { id: 1, email: 'a@b.com', meta: { plan: 'free' } },
  onConflict: 'id',
  update: { tier: 'pro', 'meta.plan': 'pro' },
});

// Pairs cleanly with returning() — get the row back in one call.
const { data } = await db.users.returning().upsert({ ... });
```

Single column or composite conflict targets supported. Bulk values arrays work and unite columns across heterogeneous rows.

#### Aggregates — `sum` / `avg` / `min` / `max`

Same shape as `count()`. Combine with the chain's where clause:

```ts
const total = await db.orders.where({ status: "paid" }).sum("amount");
const oldest = await db.users.min("createdAt");
```

JSON paths supported: `db.orders.sum('payload.amount')`.

#### `groupBy()` + `having()` + object-form `select()`

Object-form `select` projects computed columns alongside plain ones, with each entry's key becoming the SQL alias:

```ts
db.posts
  .where({ published: 1 })
  .select({
    userId: true,
    total: { sum: "views" },
    n: { count: "*" },
  })
  .groupBy("userId")
  .having({ total: { gte: 1000 }, n: { gte: 5 } })
  .orderBy({ total: "desc" })
  .limit(10)
  .many();
```

Aggregates supported: `count`, `countDistinct`, `sum`, `avg`, `min`, `max`. `having` reuses the full operator vocabulary (gt/gte/lt/lte/eq/ne/between/notBetween/etc.) operating on SELECT aliases. SQL clause order: WHERE → GROUP BY → HAVING → ORDER BY → LIMIT/OFFSET.

#### Type generation — `@kuratchi/orm/codegen`

The biggest 2026-ergonomics win: full row-type inference from the schema DSL.

```ts
import { generateTypes } from "@kuratchi/orm/codegen";
import { appSchema } from "./schema";

const dts = generateTypes(appSchema, {
  ormName: "AppOrm", // optional override
  jsonShapes: {
    // optional per-column overrides
    users: { preferences: "import('./types').UserPrefs" },
  },
});
await fs.writeFile("src/db-types.d.ts", dts);
```

The generated `.d.ts` exports one `XxxRow` per table plus an `XxxOrm` interface. Type your `db` and reads narrow correctly:

```ts
import type { AppOrm } from "./db-types";
const db = kuratchiORM(env.DB, schema) as unknown as AppOrm;

const u = await db.users.where({ id: 1 }).first();
// u.data.email is `string`, u.data.name is `string | null`, etc.
```

Storage type → TS type mapping:

| schema                       | TS                           |
| ---------------------------- | ---------------------------- |
| `text not null`              | `string`                     |
| `text`                       | `string \| null`             |
| `integer` (no mode)          | `number \| null`             |
| `boolean` mode               | `boolean \| null`            |
| `timestamp_ms` mode          | `number \| null` (epoch ms)  |
| `real`                       | `number \| null`             |
| `blob`                       | `ArrayBuffer \| null`        |
| `enum(a,b,c)`                | `"a" \| "b" \| "c"`          |
| `json` (default)             | `any \| null`                |
| `json` + jsonShapes override | exact TS expression provided |
| primary key                  | always non-null              |

Limitations (intentional):

- JSON column shapes default to `any \| null` — use `jsonShapes` to narrow.
- Foreign keys don't auto-narrow related rows. Relations work at runtime; their types are still `any` on the chain. (Future Phase E.)

#### Tests

- Unit: 184 (was 141) — adds upsert, aggregates, groupBy/having, codegen.
- Integration: 156 (was 126) — same suite runs against real D1 + DO.

#### Migration notes

No breaking changes. All additions are pure new surface — existing v0.1.0 code keeps working.

## 0.1.0

### Minor Changes

This release is a substantial overhaul. The chain API was unified, the operator vocabulary was cleaned, JSON columns became first-class, relations got real predicates, and write paths gained `returning()` and atomic `batch()`. Coverage went from zero tests to 141 unit + 126 integration tests running against real D1 and Durable Object SqlStorage.

#### Single `Table<Row>` interface

`TableApi` and `TableQuery` are collapsed into one `Table<Row>` shape. `db.users` _is_ a query. Every method either chains (returns `Table<Row>`) or terminates (returns a Promise). Cardinality always derives from the chain — there are no shortcuts. `delete({ id })`, `count(where)`, `update({...}).where(...).update()`, `updateMany`, `whereIn`, and `orWhere` are all gone. Use `where().delete()`, `where().count()`, `where().update({...})`, and `whereAny([...])`.

`TableApi` and `TableQuery` are kept as deprecated type aliases for source compat.

#### First-class JSON columns

Mark a column `'json'` in the schema and the ORM compiles dotted keys to surgical SQLite JSON SQL automatically:

- Reads: `where({ 'meta.tier': 'pro' })` → `meta ->> '$.tier' = ?`
- Writes: `update({ 'meta.tier': 'pro', 'meta.seats': 5 })` → `meta = json_set(meta, '$.tier', ?, '$.seats', ?)`
- Object/array values bind via `json(?)` so SQLite stores them as queryable JSON
- Whole-object reads/writes still work; reads parse JSON columns back to objects

`kuratchiORM(binding, schema)` and `initDO(storage, schema)` both wire the schema through.

#### Filter-shape rebuild

```ts
where({ id: 1 }); // = 1
where({ deleted_at: null }); // IS NULL
where({ tier: ["pro", "enterprise"] }); // IN (json_each)
where({ age: { gte: 18, lt: 65 } });
where({ score: { between: [50, 100] } });
where({ email: { contains: "cloud" } }); // LIKE %cloud% with %/_ escaped
where({ name: { like: "A%" } }); // raw LIKE
where({ deleted_at: { isNull: false } }); // IS NOT NULL
```

- New operators: `between`, `notBetween`, `notLike`, `contains` (auto-escapes `%`/`_`), value-shape shortcuts (`null` → IS NULL, array → IN).
- Removed: auto-LIKE magic on bare strings with `%`, three null spellings (`is`/`isNull`/`isNullish` → just `isNull`).
- All `IN`/`NOT IN` use `json_each` — single bound parameter, no D1 100-placeholder cap. Works at any array size. Empty arrays predictable: `{ in: [] }` → `WHERE 0`, `{ notIn: [] }` → `WHERE 1`.

#### Relations: `include` filtering + `where`-on-relation

Foreign keys declared in the schema (`'-> users.id'`) build a relation registry. Two new things:

**Filtered include** — load related rows with a predicate, ordering, per-parent limit, or narrowed projection:

```ts
db.users
  .include({
    posts: {
      where: { published: 1 },
      orderBy: { createdAt: "desc" },
      limit: 10, // per-parent top-N via ROW_NUMBER() OVER PARTITION
      select: ["id", "title"], // FK auto-included for stitching
    },
  })
  .many();
```

**Where on relation** — predicate-filter parents by what children exist:

```ts
db.users.where({ posts: { any: { published: 1 } } }); // EXISTS
db.users.where({ posts: { none: {} } }); // NOT EXISTS
db.users.where({ posts: { gte: 5 } }); // count >= 5
db.users.where({ posts: { between: [1, 10] } }); // count range

// Nested predicates work too
db.users.where({
  posts: { any: { comments: { any: { body: { contains: "great" } } } } },
});
```

#### `returning()` — get affected rows in one round-trip

```ts
const { data } = await db.users.returning().insert({ email: "a@b.com" });
// data: [{ id: 42, email: 'a@b.com', ... }] — auto-id included

await db.users
  .where({ id: 1 })
  .returning(["id", "tier"])
  .update({ tier: "pro" });
await db.users.where({ id: 1 }).returning().delete();
```

Halves D1 round-trips for the common create-then-read pattern. Works on `insert`, `update`, and `delete`. JSON columns parsed on returned rows.

#### `db.batch(async tx => ...)` — atomic multi-write

```ts
await db.batch(async (tx) => {
  await tx.users.where({ id: 1 }).update({ tier: "pro" });
  await tx.audit.insert({ event: "tier_change", userId: 1 });
});
```

- D1: native `db.batch([...])` — one HTTP round-trip, atomic
- DO: wrapped in `ctx.storage.transactionSync(...)` (when `initDO` receives `ctx.storage`)
- Read terminals throw inside a batch; run them before/after.

#### Tests

Two suites:

- **Unit** (`bun run test`, ~200ms): 141 tests. Mock executor, asserts on emitted SQL.
- **Integration** (`bun run test:integration`, ~600ms): 126 tests. `@cloudflare/vitest-pool-workers` runs every test against both real D1 and real DO `SqlStorage`. Asserts on returned rows.

Run both with `bun run test:all`.

#### Bug fixes during development

- `initDO` ignored its schema argument — DOs ran without JSON column awareness so dotted keys hit SQLite as literal column names.
- Heterogeneous bulk insert built the column list from row 0 only, silently dropping columns set on later rows. Now unions keys.
- `createSchemaClient` cached one Table per name, leaking chain state across calls. Now returns a fresh wrapped builder per access.
- `first()` skipped `applyIncludes` on the optimized `fullClient.first` path; relations weren't loaded. Falls through to `many()` when an include spec is set.

#### Migration notes

For consumers of earlier versions:

| before                                         | after                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `db.users.delete({ id })`                      | `db.users.where({ id }).delete()`                                    |
| `db.users.count(where)`                        | `db.users.where(where).count()`                                      |
| `db.users.update({...}).where({...}).update()` | `db.users.where({...}).update({...})`                                |
| `db.users.where(...).updateMany({...})`        | `db.users.where(...).update({...})`                                  |
| `db.users.whereIn('id', [...])`                | `db.users.where({ id: [...] })` or `where({ id: { in: [...] } })`    |
| `db.users.where(...).orWhere({...})`           | `db.users.whereAny([{...}, {...}])`                                  |
| `where({ x: { is: null } })` / `isNullish`     | `where({ x: null })` or `where({ x: { isNull: true } })`             |
| `initDO(ctx.storage.sql, schema)`              | `initDO(ctx.storage, schema)` (preferred — enables atomic `batch()`) |

The old `initDO(ctx.storage.sql, schema)` form still works for non-batch use cases.

## 0.0.3

### Patch Changes

- Add explicit MIT license metadata and package license files so both packages can be published and consumed as public open source packages.

## 0.0.2

### Patch Changes

- Publish latest framework and ORM for LLM docs compatibility

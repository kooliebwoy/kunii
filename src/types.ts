/**
 * Core ORM types
 */

// ── Primitives ──────────────────────────────────────────────

export type Primitive = string | number | boolean | null;

/**
 * The value side of a where clause. The shape carries intent:
 *
 *   - `Primitive` (string/number/boolean/null) → equality
 *   - `null` → `IS NULL`
 *   - `Primitive[]` → `IN (...)` via `json_each`
 *   - `WhereOperators` → explicit operator object
 *
 * The shape shortcuts cover the common cases without an operator name.
 */
export type WhereValue = Primitive | Primitive[] | WhereOperators | Record<string, any>;

/**
 * Operator object for explicit predicates.
 *
 * Operators that exist:
 *   - Equality:        eq, ne
 *   - Comparisons:     gt, gte, lt, lte
 *   - Substring:       contains (auto-escapes %/_), like, notLike
 *   - Sets:            in, notIn
 *   - Ranges:          between, notBetween
 *   - Null:            isNull (true → IS NULL, false → IS NOT NULL)
 */
export type WhereOperators = {
  eq?: Primitive;
  ne?: Primitive;
  gt?: Primitive;
  gte?: Primitive;
  lt?: Primitive;
  lte?: Primitive;
  /** Literal substring match. Auto-escapes %/_ in the input. */
  contains?: string;
  /** Raw LIKE pattern (e.g. `'a%b_c'`). User controls wildcards. */
  like?: string;
  /** Raw NOT LIKE pattern. */
  notLike?: string;
  in?: Primitive[];
  notIn?: Primitive[];
  /** Inclusive range: `[low, high]` → `BETWEEN low AND high`. */
  between?: [Primitive, Primitive];
  /** Inclusive negated range. */
  notBetween?: [Primitive, Primitive];
  /** `true` → `IS NULL`, `false` → `IS NOT NULL`. */
  isNull?: boolean;
};

export type Where = Record<string, WhereValue>;
export type WriteValues<Row = any> = Partial<Row> & Record<string, any>;

export type OrderItem = string | { [column: string]: 'asc' | 'desc' };
export type OrderBy = OrderItem | OrderItem[];

export type FindManyOptions = {
  where?: Where;
  select?: string[];
  orderBy?: OrderBy;
  limit?: number;
  offset?: number;
};

// ── Query Result ────────────────────────────────────────────

export type QueryResult<T = any> = {
  success: boolean;
  data?: T;
  results?: T;
  error?: string;
  meta?: {
    rowsRead?: number;
    rowsWritten?: number;
    duration?: number;
  };
};

// ── SQL Executor ────────────────────────────────────────────

export type SqlExecutor = (sql: string, params?: any[]) => Promise<QueryResult<any>>;

export type SqlCondition = { query: string; params?: any[] };

// ── Full DB Client (native D1 APIs) ─────────────────────────

export interface FullDbClient {
  query?: (sql: string, params?: any[]) => Promise<QueryResult<any>>;
  first?: (sql: string, params?: any[], column?: string) => Promise<QueryResult<any>>;
  exec?: (sql: string) => Promise<QueryResult<any>>;
  batch?: (queries: any[]) => Promise<QueryResult<any>>;
  prepare?: (sql: string) => any;
  raw?: (sql: string, params?: any[]) => Promise<QueryResult<any>>;
  run?: (sql: string, params?: any[]) => Promise<QueryResult<any>>;
}

// ── Include (relations) ─────────────────────────────────────
//
// Filtered include — `where`, `orderBy`, `limit`, `select` apply to the
// child rows being loaded. Inspired by EF Core's filtered includes.
//
// When `limit` is specified, the loader emits a window-function subquery
// (`ROW_NUMBER() OVER (PARTITION BY <fk> ORDER BY ...)`) so each parent
// gets up to `limit` children, not `limit` total. Without `limit`, all
// matching children are loaded.
//
// `where` predicates compose with the FK match. `orderBy` controls per-
// parent ordering when `limit` is set, and overall row order otherwise.
// `select` narrows columns just like the table-level select; the FK
// column is always loaded so we can stitch rows to parents.

export type IncludeConfig = {
  as?: string;
  single?: boolean;
  localKey?: string;
  foreignKey?: string;
  table?: string;
  /** Filter the child rows. */
  where?: Where;
  /** Order the child rows. With `limit`, controls per-parent top-N. */
  orderBy?: OrderBy;
  /** Per-parent row cap. Without orderBy, picks an arbitrary top-N. */
  limit?: number;
  /** Narrow the columns loaded for child rows. FK is always included. */
  select?: string[];
  /** Nested relations to load on the included rows. */
  include?: IncludeSpec;
};

export type IncludeSpec = Record<string, boolean | IncludeConfig>;

// ── Table interface ─────────────────────────────────────────
//
// Single shape for both "table handle" (`db.users`) and any chained
// query (`db.users.where(...).orderBy(...)`). The only special case is
// `insert`, which is naturally terminal and ignores any chain state.
//
// Cardinality is *always* derived from the chain, never from the verb:
//   - `where(...).first()`           → one row
//   - `where(...).many()`            → all matching rows
//   - `where(...).update({...})`     → updates all matching rows
//   - `where(...).delete()`          → deletes all matching rows
//
// To affect a single row, narrow the `where` (typically by primary key)
// or chain `.limit(1)`.

/**
 * Computed-column descriptor for `select(spec)` when used as an object map.
 * Lets you project plain columns alongside aggregates, with each entry's
 * key becoming the SELECT alias.
 */
export type SelectColumn =
  | true
  | string
  | { count: string }              // COUNT(col); '*' is allowed
  | { sum: string }
  | { avg: string }
  | { min: string }
  | { max: string }
  | { countDistinct: string };     // COUNT(DISTINCT col)

/**
 * Selection spec — array form for plain columns, object form when you
 * need aggregates / aliases. The object form pairs naturally with
 * `groupBy` and `having`.
 */
export type SelectSpec = string[] | Record<string, SelectColumn>;

export interface Table<Row = any> {
  // ── Chain builders (all return the same Table<Row>) ────
  where(filter: Where): Table<Row>;
  whereAny(conditions: Where[]): Table<Row>;
  orderBy(order: OrderBy | string): Table<Row>;
  limit(n: number): Table<Row>;
  offset(n: number): Table<Row>;
  include(spec: IncludeSpec): Table<Row>;
  select(cols: SelectSpec): Table<Row>;
  /**
   * GROUP BY one or more columns. Pair with `select()` (object form)
   * for aggregates per group, and optionally `having()` to filter
   * groups by aggregate values.
   */
  groupBy(cols: string | string[]): Table<Row>;
  /**
   * HAVING — same operator vocabulary as `where`, but operates on
   * SELECT aliases (typically aggregates). No JSON-path detection.
   */
  having(filter: Where): Table<Row>;
  sql(condition: SqlCondition): Table<Row>;
  /**
   * Make the next write terminal (`insert`/`update`/`delete`) emit a
   * `RETURNING` clause and surface the affected rows in `result.data`.
   * Halves D1 round-trips for the common create-then-read pattern.
   *
   * Pass column names to narrow the projection; omit for `RETURNING *`.
   * JSON columns are still parsed back to objects on read.
   */
  returning(cols?: string[]): Table<Row>;

  // ── Terminals ──────────────────────────────────────────
  many(): Promise<QueryResult<Row[]>>;
  first(): Promise<QueryResult<Row | undefined>>;
  one(): Promise<QueryResult<Row>>;
  exists(): Promise<boolean>;
  count(): Promise<QueryResult<number>>;
  /** SUM(col) — returns null when no rows match. */
  sum(column: string): Promise<QueryResult<number | null>>;
  /** AVG(col) — returns null when no rows match. */
  avg(column: string): Promise<QueryResult<number | null>>;
  /** MIN(col) — returns the minimum value, or null when no rows match. */
  min(column: string): Promise<QueryResult<any>>;
  /** MAX(col) — returns the maximum value, or null when no rows match. */
  max(column: string): Promise<QueryResult<any>>;
  distinct(column: string): Promise<QueryResult<any[]>>;
  insert(values: WriteValues<Row> | WriteValues<Row>[]): Promise<QueryResult<Row | Row[]>>;
  /** Updates rows matching the chain's where clause. Requires a where. */
  update(values: WriteValues<Row>): Promise<QueryResult<any>>;
  /** Deletes rows matching the chain's where clause. Requires a where. */
  delete(): Promise<QueryResult<any>>;
  /**
   * Insert-or-update in a single round-trip via SQLite's
   * `INSERT ... ON CONFLICT(...) DO UPDATE`.
   *
   * - `values`: row(s) to insert (same shape as `insert`)
   * - `onConflict`: PK or unique column(s) to check for conflict
   * - `update`:
   *     - `'all'`     — SET every inserted column from `excluded.<col>`
   *     - `'ignore'`  — `DO NOTHING` (compiles to `ON CONFLICT DO NOTHING`)
   *     - object map  — explicit SET values; supports JSON-path keys
   */
  upsert(opts: UpsertOptions<Row>): Promise<QueryResult<any>>;
}

export type UpsertOptions<Row = any> = {
  values: WriteValues<Row> | WriteValues<Row>[];
  onConflict: string | string[];
  update: 'all' | 'ignore' | WriteValues<Row>;
};

/** @deprecated Use `Table` instead. Kept as alias for backward source compat. */
export type TableApi<Row = any> = Table<Row>;
/** @deprecated Use `Table` instead. Kept as alias for backward source compat. */
export type TableQuery<Row = any> = Table<Row>;

// ── Batch / atomic multi-write ──────────────────────────────
//
// Inside a batch callback, terminals stage statements instead of running
// them. After the callback resolves, all staged statements commit
// atomically — one HTTP round-trip on D1, one DO transaction on
// SqlStorage. Read terminals (`many`, `first`, `one`, `count`, `exists`,
// `distinct`) are NOT supported inside a batch — run those before/after.
//
// Each terminal returns a Promise<void> for ergonomics; the actual
// affected-row metadata is in the batch result.

export interface BatchTable {
  // Chain methods (return same shape so the rest of the chain works).
  where(filter: Where): BatchTable;
  whereAny(conditions: Where[]): BatchTable;
  orderBy(order: OrderBy | string): BatchTable;
  limit(n: number): BatchTable;
  offset(n: number): BatchTable;
  select(cols: SelectSpec): BatchTable;
  groupBy(cols: string | string[]): BatchTable;
  having(filter: Where): BatchTable;
  sql(condition: SqlCondition): BatchTable;
  returning(cols?: string[]): BatchTable;

  // Write terminals — stage and return.
  insert(values: any | any[]): Promise<void>;
  update(values: Record<string, any>): Promise<void>;
  delete(): Promise<void>;
  upsert(opts: UpsertOptions): Promise<void>;
}

export type BatchTransaction = Record<string, BatchTable>;

export interface BatchResult {
  success: boolean;
  /** Per-statement results, one entry per terminal call inside the batch. */
  results: QueryResult<any>[];
  error?: string;
}

export type BatchCallback = (tx: BatchTransaction) => Promise<void> | void;

/**
 * Top-level ORM client. Behaves like `Record<string, Table>` for table
 * access (`db.users.where(...)`), plus a `batch(callback)` method for
 * atomic multi-write transactions.
 */
export type OrmClient = Record<string, Table> & {
  batch(callback: BatchCallback): Promise<BatchResult>;
};

// ── Schema DSL ──────────────────────────────────────────────

export type ColumnDefString = string;
export type TableDsl = Record<string, ColumnDefString | true>;
export type MixinsDsl = Record<string, TableDsl>;

export type IndexDsl = {
  columns: string[];
  unique?: boolean;
};

export type TableIndexesDsl = Record<string, IndexDsl>;

export type SchemaDsl = {
  name: string;
  version: number;
  mixins?: MixinsDsl;
  tables: Record<string, TableDsl>;
  indexes?: Record<string, TableIndexesDsl>;
};

// ── Adapter Config (advanced — custom executors only) ────────

export interface ExecutorAdapterConfig {
  adapter: 'executor';
  execute: SqlExecutor;
  client?: FullDbClient;
}

export type OrmAdapterConfig = ExecutorAdapterConfig;

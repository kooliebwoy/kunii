/**
 * Core ORM â€” query builder + table API + factory
 *
 * Zero dependencies. Worker-safe. No Node APIs.
 */

import type {
  Primitive, Where, OrderBy, SqlExecutor, SqlCondition,
  FullDbClient, IncludeSpec, IncludeConfig, QueryResult, Table,
  BatchCallback, BatchResult, BatchTable, BatchTransaction, OrmClient,
  OrmAdapterConfig,
} from './types.js';
import { ensureNormalizedSchema } from './schema.js';
import { buildInitialSql } from './migrations/generator.js';
import type { Column, DatabaseSchema } from './schema.js';

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isObject(v: any): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Description of a hasMany relation as seen from the parent table.
 *
 * For example, given `posts.userId -> users.id`, from `users`'s
 * perspective `posts` is a hasMany relation with:
 *   { table: 'posts', foreignKey: 'userId', localKey: 'id' }
 *
 * Relations are derived from the schema's `references` declarations on
 * column definitions (`'integer -> users.id'` in the DSL).
 */
type Relation = {
  table: string;
  foreignKey: string;
  localKey: string;
};

// ── JSON path helpers ───────────────────────────────────────
//
// When the user writes a dotted key (e.g. `'meta.tier'`) and the LHS column
// is declared `type: 'json'` in the schema, we compile to surgical SQLite
// JSON SQL: `meta ->> '$.tier'` for reads/predicates and `json_set(meta, ...)`
// for writes. This eliminates round-trips that would otherwise haul the
// whole JSON blob into TS for client-side filtering.

/**
 * Parse a dotted user key against the JSON column registry.
 * Returns null when the key is a normal column (no path traversal).
 *
 * The first segment must match a known JSON column. We split on `.` only —
 * users can also use `[idx]` array syntax inline, e.g. `'tags[0].name'`.
 */
function parseJsonRef(
  key: string,
  jsonCols?: Set<string>
): { column: string; path: string } | null {
  if (!jsonCols || !jsonCols.size) return null;
  const dot = key.indexOf('.');
  const bracket = key.indexOf('[');
  let split = -1;
  if (dot >= 0 && bracket >= 0) split = Math.min(dot, bracket);
  else if (dot >= 0) split = dot;
  else if (bracket >= 0) split = bracket;
  if (split <= 0) return null;
  const column = key.slice(0, split);
  if (!jsonCols.has(column)) return null;
  const rest = key.slice(split);
  // Normalize to JSON path: leading `.foo` -> `$.foo`; leading `[0]` -> `$[0]`.
  const path = rest.startsWith('[') ? `$${rest}` : `$${rest}`;
  return { column, path };
}

/** Build the SQL fragment used to read a JSON path as a SQL-typed value. */
function jsonReadRef(column: string, path: string): string {
  // `->>` returns the value with SQL type semantics (TEXT/INTEGER/REAL),
  // which is the right shape for predicates and projections.
  return `${column} ->> '${path}'`;
}

/** Bound-param value for a JSON write: stringify if non-primitive. */
function isComplexJsonValue(v: any): boolean {
  return v !== null && typeof v === 'object';
}
function jsonWriteValueSql(v: any): { sql: string; param: any } {
  if (v === undefined || v === null) return { sql: '?', param: v };
  if (isComplexJsonValue(v)) return { sql: 'json(?)', param: JSON.stringify(v) };
  return { sql: '?', param: v };
}

function omitUndefinedFields<T extends Record<string, any>>(row: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) (out as any)[key] = value;
  }
  return out;
}

/**
 * Escape a literal substring for use inside a LIKE pattern.
 *
 * SQLite LIKE treats `%` and `_` as wildcards. When the user passes a
 * literal substring via `{ contains }`, we wrap it in `%...%` and escape
 * any wildcards in the input so a search for `'50%'` doesn't blow up to
 * "anything containing the digit 5". Backslash is the escape char and
 * is conveyed via `ESCAPE '\\'` in the emitted SQL.
 */
function escapeLikeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Optional compile context. Carries everything `compileWhere` needs to
 * recognize JSON paths and relation predicates without an ever-growing
 * parameter list.
 *
 * `relations` is the registry FOR THE PARENT TABLE (relations *off* of
 * `parentTable`). `relationsByTable` is the full registry, used to walk
 * down nested relation predicates (e.g. users → posts → comments).
 * `jsonColsByTable` is the per-child JSON column registry so JSON paths
 * inside a nested relation's where also compile correctly.
 */
type WhereCtx = {
  jsonCols?: Set<string>;
  relations?: Map<string, Relation>;
  /** The table being queried — used to prefix the parent FK in EXISTS. */
  parentTable?: string;
  /** Full registry, indexed by parent table — for nested predicates. */
  relationsByTable?: Map<string, Map<string, Relation>>;
  /** Per-table JSON columns — for JSON paths inside nested predicates. */
  jsonColsByTable?: Map<string, Set<string>>;
};

/**
 * Compile a relation predicate against a hasMany relation.
 *
 * Recognized shapes:
 *   - `{ any: <where> }`            → EXISTS (...)
 *   - `{ none: <where> }`           → NOT EXISTS (...)
 *   - primitive number              → (count subquery) = ?
 *   - `{ eq | ne | gt | gte | lt | lte: number }`  → count compare
 *   - `{ between | notBetween: [a,b] }`             → count range
 */
function compileRelationPredicate(
  parentTable: string,
  rel: Relation,
  rawValue: any,
  ctx?: WhereCtx
): { sql: string; params: any[] } {
  const params: any[] = [];

  // ── EXISTS / NOT EXISTS ───────────────────────────────────
  if (isObject(rawValue) && (rawValue.any !== undefined || rawValue.none !== undefined)) {
    const isAny = rawValue.any !== undefined;
    const innerWhere = isAny ? rawValue.any : rawValue.none;
    const fkClause = `${rel.table}.${rel.foreignKey} = ${parentTable}.${rel.localKey}`;
    let sql = `SELECT 1 FROM ${rel.table} WHERE ${fkClause}`;
    if (innerWhere && Object.keys(innerWhere).length > 0) {
      // The inner predicate is evaluated against the *related* table,
      // so swap parentTable + relations + jsonCols to that table's set
      // before recursing. This is what makes nested relation predicates
      // work: users.posts.comments resolves each level correctly.
      const innerCtx: WhereCtx = {
        ...ctx,
        parentTable: rel.table,
        relations: ctx?.relationsByTable?.get(rel.table),
        jsonCols: ctx?.jsonColsByTable?.get(rel.table),
      };
      const inner = compileWhere(innerWhere, innerCtx);
      if (inner.sql) {
        const stripped = inner.sql.replace(/^WHERE\s+/i, '');
        sql += ` AND (${stripped})`;
        params.push(...inner.params);
      }
    }
    return {
      sql: `${isAny ? 'EXISTS' : 'NOT EXISTS'} (${sql})`,
      params,
    };
  }

  // ── Count comparisons ─────────────────────────────────────
  // Covers: bare number → equality, and operator object (gt/gte/lt/lte/eq/ne/between/notBetween).
  // Plain numeric value: { posts: 5 } means "exactly 5 posts".
  const countSubquery = `(SELECT count(*) FROM ${rel.table} WHERE ${rel.table}.${rel.foreignKey} = ${parentTable}.${rel.localKey})`;

  if (typeof rawValue === 'number') {
    return { sql: `${countSubquery} = ?`, params: [rawValue] };
  }

  if (isObject(rawValue)) {
    const ops: string[] = [];
    if (rawValue.eq !== undefined) { ops.push(`${countSubquery} = ?`); params.push(rawValue.eq); }
    if (rawValue.ne !== undefined) { ops.push(`${countSubquery} <> ?`); params.push(rawValue.ne); }
    if (rawValue.gt !== undefined) { ops.push(`${countSubquery} > ?`); params.push(rawValue.gt); }
    if (rawValue.gte !== undefined) { ops.push(`${countSubquery} >= ?`); params.push(rawValue.gte); }
    if (rawValue.lt !== undefined) { ops.push(`${countSubquery} < ?`); params.push(rawValue.lt); }
    if (rawValue.lte !== undefined) { ops.push(`${countSubquery} <= ?`); params.push(rawValue.lte); }
    if (rawValue.between !== undefined) {
      if (!Array.isArray(rawValue.between) || rawValue.between.length !== 2) {
        throw new Error("'between' on a relation requires a [low, high] tuple");
      }
      ops.push(`${countSubquery} BETWEEN ? AND ?`);
      params.push(rawValue.between[0], rawValue.between[1]);
    }
    if (rawValue.notBetween !== undefined) {
      if (!Array.isArray(rawValue.notBetween) || rawValue.notBetween.length !== 2) {
        throw new Error("'notBetween' on a relation requires a [low, high] tuple");
      }
      ops.push(`${countSubquery} NOT BETWEEN ? AND ?`);
      params.push(rawValue.notBetween[0], rawValue.notBetween[1]);
    }
    if (ops.length > 0) {
      return { sql: ops.join(' AND '), params };
    }
  }

  throw new Error(
    `Unrecognized relation predicate for '${rel.table}'. Use { any: {...} }, { none: {...} }, a number, or { gt|gte|lt|lte|eq|ne|between|notBetween: ... }.`
  );
}

function compileWhere(
  where?: Where,
  ctxOrJsonCols?: WhereCtx | Set<string>
): { sql: string; params: any[] } {
  // Back-compat: callers historically passed `jsonCols` directly. Still work.
  const ctx: WhereCtx | undefined =
    ctxOrJsonCols instanceof Set
      ? { jsonCols: ctxOrJsonCols }
      : ctxOrJsonCols;
  const jsonCols = ctx?.jsonCols;
  const relations = ctx?.relations;
  const parentTable = ctx?.parentTable;

  if (!where || Object.keys(where).length === 0) return { sql: '', params: [] };
  const clauses: string[] = [];
  const params: any[] = [];

  for (const [rawKey, val] of Object.entries(where)) {
    // ── Relation predicate ──────────────────────────────────
    const rel = relations?.get(rawKey);
    if (rel && parentTable) {
      const compiled = compileRelationPredicate(parentTable, rel, val, ctx);
      clauses.push(compiled.sql);
      params.push(...compiled.params);
      continue;
    }

    const ref = parseJsonRef(rawKey, jsonCols);
    const lhs = ref ? jsonReadRef(ref.column, ref.path) : rawKey;

    // ── Value-shape shortcuts ──────────────────────────────
    // null → IS NULL. Plain `where({ deleted_at: null })` works.
    if (val === null) {
      clauses.push(`${lhs} IS NULL`);
      continue;
    }
    // Array → IN. Plain `where({ tier: ['pro', 'enterprise'] })` works.
    // Uses json_each for parity with explicit `{ in: [...] }`.
    if (Array.isArray(val)) {
      if (val.length === 0) {
        // IN of empty set matches nothing — predictable result for
        // dynamic arrays so callers don't need a length guard.
        clauses.push('0');
        continue;
      }
      clauses.push(`${lhs} IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(val));
      continue;
    }
    // Other primitives → equality. Bare strings are ALWAYS equality —
    // `{ contains }` / `{ like }` / `{ notLike }` are the only paths
    // to LIKE. No magic on `%` in input strings.
    if (!isObject(val)) {
      clauses.push(`${lhs} = ?`);
      params.push(val);
      continue;
    }

    // ── Operator object ────────────────────────────────────
    const ops: string[] = [];
    if (val.eq !== undefined) { ops.push(`${lhs} = ?`); params.push(val.eq); }
    if (val.ne !== undefined) { ops.push(`${lhs} <> ?`); params.push(val.ne); }
    if (val.gt !== undefined) { ops.push(`${lhs} > ?`); params.push(val.gt); }
    if (val.gte !== undefined) { ops.push(`${lhs} >= ?`); params.push(val.gte); }
    if (val.lt !== undefined) { ops.push(`${lhs} < ?`); params.push(val.lt); }
    if (val.lte !== undefined) { ops.push(`${lhs} <= ?`); params.push(val.lte); }
    if (val.contains !== undefined) {
      // Auto-escape wildcards in the input so a literal needle like
      // 'discount_50%' matches the literal substring, not any 5-char
      // string starting with 'discount'.
      ops.push(`${lhs} LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLikeLiteral(val.contains)}%`);
    }
    if (val.like !== undefined) {
      ops.push(`${lhs} LIKE ?`);
      params.push(val.like);
    }
    if (val.notLike !== undefined) {
      ops.push(`${lhs} NOT LIKE ?`);
      params.push(val.notLike);
    }
    if (val.in !== undefined) {
      if (!Array.isArray(val.in)) {
        // Defensive: treat non-array as empty.
        ops.push('0');
      } else if (val.in.length === 0) {
        ops.push('0');
      } else {
        ops.push(`${lhs} IN (SELECT value FROM json_each(?))`);
        params.push(JSON.stringify(val.in));
      }
    }
    if (val.notIn !== undefined) {
      if (!Array.isArray(val.notIn) || val.notIn.length === 0) {
        // NOT IN of empty set matches everything — emit a tautology.
        ops.push('1');
      } else {
        ops.push(`${lhs} NOT IN (SELECT value FROM json_each(?))`);
        params.push(JSON.stringify(val.notIn));
      }
    }
    if (val.between !== undefined) {
      if (!Array.isArray(val.between) || val.between.length !== 2) {
        throw new Error("'between' requires a [low, high] tuple");
      }
      ops.push(`${lhs} BETWEEN ? AND ?`);
      params.push(val.between[0], val.between[1]);
    }
    if (val.notBetween !== undefined) {
      if (!Array.isArray(val.notBetween) || val.notBetween.length !== 2) {
        throw new Error("'notBetween' requires a [low, high] tuple");
      }
      ops.push(`${lhs} NOT BETWEEN ? AND ?`);
      params.push(val.notBetween[0], val.notBetween[1]);
    }
    if (Object.prototype.hasOwnProperty.call(val, 'isNull')) {
      ops.push(`${lhs} IS ${val.isNull ? 'NULL' : 'NOT NULL'}`);
    }
    if (ops.length === 0) {
      // Empty operator object — fall back to direct equality with the
      // object as the value (preserves prior behavior for edge cases).
      ops.push(`${lhs} = ?`);
      params.push((val as any) as Primitive);
    }
    const part = ops.join(' AND ');
    clauses.push(part);
  }
  const formatted = clauses.length > 1 ? clauses.map((c) => `(${c})`) : clauses;
  return { sql: `WHERE ${formatted.join(' AND ')}`, params };
}

function compileOrderBy(orderBy?: OrderBy, jsonCols?: Set<string>): string {
  if (!orderBy) return '';
  const parts: string[] = [];
  const arr = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const item of arr) {
    if (typeof item === 'string') {
      const ref = parseJsonRef(item, jsonCols);
      parts.push(ref ? jsonReadRef(ref.column, ref.path) : item);
    } else {
      for (const [col, dir] of Object.entries(item)) {
        const ref = parseJsonRef(col, jsonCols);
        const lhs = ref ? jsonReadRef(ref.column, ref.path) : col;
        parts.push(`${lhs} ${String(dir).toUpperCase()}`);
      }
    }
  }
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

/**
 * Compile a SELECT projection.
 *
 * - Array form (`['id', 'email']`) — plain column names with JSON-path
 *   support: `'meta.tier'` becomes `meta ->> '$.tier' AS "meta.tier"`.
 * - Object form (`{ name: spec }`) — each entry's key becomes the SQL
 *   alias; the value is either `true` (column with same name as alias),
 *   a string (column name), or an aggregate descriptor.
 *
 * Object form pairs with `groupBy` / `having` for aggregate queries.
 */
function compileSelect(
  select?: string[] | Record<string, any>,
  jsonCols?: Set<string>
): string {
  if (!select) return '*';

  if (Array.isArray(select)) {
    if (!select.length) return '*';
    return select
      .map((s) => {
        const ref = parseJsonRef(s, jsonCols);
        if (!ref) return s;
        return `${jsonReadRef(ref.column, ref.path)} AS "${s}"`;
      })
      .join(', ');
  }

  // Object form — alias → spec.
  const entries = Object.entries(select);
  if (!entries.length) return '*';
  return entries.map(([alias, spec]) => compileSelectColumn(alias, spec, jsonCols)).join(', ');
}

function compileSelectColumn(
  alias: string,
  spec: any,
  jsonCols?: Set<string>
): string {
  // `true` → bare column with the alias name. JSON paths in the alias
  // get the same `->>` treatment as the array form.
  if (spec === true) {
    const ref = parseJsonRef(alias, jsonCols);
    if (ref) return `${jsonReadRef(ref.column, ref.path)} AS "${alias}"`;
    return alias;
  }
  // String → that column projected as the given alias.
  if (typeof spec === 'string') {
    const ref = parseJsonRef(spec, jsonCols);
    const expr = ref ? jsonReadRef(ref.column, ref.path) : spec;
    return spec === alias && !ref ? alias : `${expr} AS "${alias}"`;
  }
  // Aggregate descriptor.
  if (spec && typeof spec === 'object') {
    if (typeof spec.count === 'string') {
      const target = spec.count === '*' ? '*' : spec.count;
      return `COUNT(${target}) AS "${alias}"`;
    }
    if (typeof spec.countDistinct === 'string') {
      return `COUNT(DISTINCT ${spec.countDistinct}) AS "${alias}"`;
    }
    if (typeof spec.sum === 'string') return `SUM(${spec.sum}) AS "${alias}"`;
    if (typeof spec.avg === 'string') return `AVG(${spec.avg}) AS "${alias}"`;
    if (typeof spec.min === 'string') return `MIN(${spec.min}) AS "${alias}"`;
    if (typeof spec.max === 'string') return `MAX(${spec.max}) AS "${alias}"`;
  }
  throw new Error(
    `Unrecognized select column for alias '${alias}'. ` +
      `Use true, a column name, or { count | sum | avg | min | max | countDistinct: '<col>' }.`
  );
}

/**
 * Compile a SET clause for UPDATE.
 *
 * Plain columns become `col = ?`. Dotted keys against JSON columns are
 * grouped per column and merged into a single `col = json_set(col, ...)`
 * call. Whole-object writes against a JSON column are stringified.
 */
function compileUpdateSet(
  values: Record<string, any>,
  jsonCols?: Set<string>
): { sql: string; params: any[] } {
  const plain: { col: string; valueSql: string; param: any }[] = [];
  // jsonPaths: column -> ordered list of [path, valueSql, param]
  const jsonPaths = new Map<
    string,
    { path: string; valueSql: string; param: any }[]
  >();

  for (const [key, value] of Object.entries(values)) {
    const ref = parseJsonRef(key, jsonCols);
    if (ref) {
      const w = jsonWriteValueSql(value);
      const list = jsonPaths.get(ref.column) ?? [];
      list.push({ path: ref.path, valueSql: w.sql, param: w.param });
      jsonPaths.set(ref.column, list);
      continue;
    }
    // Whole-column write: stringify if it's a JSON column with a complex value.
    if (jsonCols?.has(key) && isComplexJsonValue(value)) {
      plain.push({ col: key, valueSql: '?', param: JSON.stringify(value) });
      continue;
    }
    plain.push({ col: key, valueSql: '?', param: value });
  }

  const setParts: string[] = [];
  const params: any[] = [];

  for (const p of plain) {
    setParts.push(`${p.col} = ${p.valueSql}`);
    params.push(p.param);
  }
  for (const [col, list] of jsonPaths) {
    const args = list
      .map((e) => `'${e.path}', ${e.valueSql}`)
      .join(', ');
    setParts.push(`${col} = json_set(${col}, ${args})`);
    for (const e of list) params.push(e.param);
  }

  return { sql: setParts.join(', '), params };
}

function compileWhereGroupsWithRaw(
  groups: Where[],
  rawGroups: { sql: string; params: any[] }[][],
  ctxOrJsonCols?: WhereCtx | Set<string>
): { sql: string; params: any[] } {
  const G = groups || [];
  const RG = rawGroups || [];
  const groupCount = Math.max(G.length, RG.length);
  if (groupCount === 0) return { sql: '', params: [] };

  const groupSqls: string[] = [];
  const allParams: any[] = [];

  for (let i = 0; i < groupCount; i++) {
    const base = compileWhere(G[i] || {}, ctxOrJsonCols);
    const raws = (RG[i] || []).filter((r) => r && r.sql && r.sql.trim().length);

    const parts: string[] = [];
    const params: any[] = [];

    if (base.sql) {
      const inner = base.sql.replace(/^WHERE\s+/i, '');
      parts.push(inner);
      params.push(...base.params);
    }
    for (const r of raws) {
      parts.push(r.sql);
      if (r.params && r.params.length) params.push(...r.params);
    }

    if (parts.length === 0) continue;
    const combined = parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0];
    groupSqls.push(combined);
    allParams.push(...params);
  }

  if (groupSqls.length === 0) return { sql: '', params: [] };
  if (groupSqls.length === 1) return { sql: `WHERE ${groupSqls[0]}`, params: allParams };
  return { sql: `WHERE ${groupSqls.map((s) => `(${s})`).join(' OR ')}`, params: allParams };
}

// â”€â”€ Query Builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class QueryBuilder<Row = any> {
  private whereGroups: Where[] = [];
  private rawWhereGroups: { sql: string; params: any[] }[][] = [];
  private order?: OrderBy;
  private limitN?: number;
  private offsetN?: number;
  private includeSpec?: IncludeSpec;
  private selectCols?: any;
  private groupCols?: string[];
  private havingFilter?: Where;
  /** When set, write terminals append RETURNING and surface affected rows. */
  private _returningCols?: string[] | true;

  constructor(
    private readonly tableName: string,
    /**
     * Not `readonly` — `batch()` swaps this for a recording executor so
     * write terminals stage statements instead of running them.
     */
    public execute: SqlExecutor,
    private readonly fullClient?: FullDbClient,
    private readonly _jsonCols?: Set<string>,
    private readonly _allColumns?: Set<string>,
    private readonly _relations?: Map<string, Relation>,
    private readonly _relationsByTable?: Map<string, Map<string, Relation>>,
    private readonly _jsonColsByTable?: Map<string, Set<string>>
  ) {}

  /** Build the WHERE compile context for this builder. */
  private get _ctx(): WhereCtx {
    return {
      jsonCols: this._jsonCols,
      relations: this._relations,
      parentTable: this.tableName,
      relationsByTable: this._relationsByTable,
      jsonColsByTable: this._jsonColsByTable,
    };
  }

  returning(cols?: string[]): this {
    this._returningCols = cols && cols.length > 0 ? cols : true;
    return this;
  }

  /** Build the `RETURNING ...` clause when `_returningCols` is set. */
  private compileReturning(): string {
    if (!this._returningCols) return '';
    if (this._returningCols === true) return 'RETURNING *';
    return `RETURNING ${compileSelect(this._returningCols, this._jsonCols)}`;
  }

  /** Build ORDER BY / LIMIT / OFFSET for write terminals. */
  private compileWriteTail(): string {
    const order = compileOrderBy(this.order, this._jsonCols);
    const limit = typeof this.limitN === 'number' ? `LIMIT ${this.limitN}` : '';
    const offset = typeof this.offsetN === 'number' ? `OFFSET ${this.offsetN}` : '';
    return [order, limit, offset].filter(Boolean).join(' ');
  }

  /** Parse JSON columns on returned rows so RETURNING data matches reads. */
  private parseReturnedRows(rows: any[]): any[] {
    if (!this._jsonCols?.size) return rows;
    return rows.map((row) => {
      const copy: any = { ...row };
      for (const col of this._jsonCols!) {
        const v = copy[col];
        if (v === undefined || v === null) continue;
        if (typeof v === 'string') {
          try { copy[col] = JSON.parse(v); } catch { /* keep as string */ }
        }
      }
      return copy;
    });
  }

  where(filter: Where): this {
    if (this.whereGroups.length === 0) {
      this.whereGroups.push({});
      this.rawWhereGroups.push([]);
    }
    Object.assign(this.whereGroups[this.whereGroups.length - 1], filter || {});
    return this;
  }

  whereAny(conditions: Where[]): this {
    if (!conditions || conditions.length === 0) return this;
    const orParts: string[] = [];
    const allParams: any[] = [];
    for (const condition of conditions) {
      const compiled = compileWhere(condition, this._ctx);
      if (compiled.sql) {
        const sqlPart = compiled.sql.replace(/^WHERE\s+/i, '');
        orParts.push(sqlPart);
        allParams.push(...compiled.params);
      }
    }
    if (orParts.length > 0) {
      const orClause = orParts.length > 1
        ? `(${orParts.join(' OR ')})`
        : orParts[0];
      return this.sql({ query: orClause, params: allParams });
    }
    return this;
  }

  sql(condition: SqlCondition): this {
    if (this.whereGroups.length === 0) {
      this.whereGroups.push({});
      this.rawWhereGroups.push([]);
    }
    const idx = this.whereGroups.length - 1;
    const query = String(condition?.query ?? '').trim();
    const params = Array.isArray(condition?.params) ? condition!.params! : [];

    if (query.includes('${') || /\$\{.*\}/.test(query)) {
      throw new Error('Potential SQL injection detected. Use ? placeholders and params array.');
    }
    if (/["'`]\s*\+|concat\s*\(/i.test(query)) {
      throw new Error('String concatenation detected in SQL. Use ? placeholders instead.');
    }
    if (/;\s*(drop|delete|insert|update|create)\s+/i.test(query)) {
      throw new Error('Potentially dangerous SQL detected. Multiple statements not allowed.');
    }

    if (!query) return this;
    this.rawWhereGroups[idx].push({ sql: query, params });
    return this;
  }

  orderBy(order: OrderBy | string): this {
    this.order = typeof order === 'string' ? order : order;
    return this;
  }

  limit(n: number): this { this.limitN = n; return this; }
  offset(n: number): this { this.offsetN = n; return this; }
  include(spec: IncludeSpec): this { this.includeSpec = spec; return this; }
  select(cols: any): this { this.selectCols = cols; return this; }

  groupBy(cols: string | string[]): this {
    this.groupCols = Array.isArray(cols) ? cols.slice() : [cols];
    return this;
  }

  having(filter: Where): this {
    if (!this.havingFilter) {
      this.havingFilter = { ...filter };
    } else {
      Object.assign(this.havingFilter, filter);
    }
    return this;
  }

  async distinct(column: string): Promise<QueryResult<any[]>> {
    const w = compileWhereGroupsWithRaw(
      this.whereGroups,
      this.rawWhereGroups,
      this._ctx
    );
    // Allow `distinct('payload.kind')` against JSON columns.
    const ref = parseJsonRef(column, this._jsonCols);
    const sel = ref ? `${jsonReadRef(ref.column, ref.path)} AS "${column}"` : column;
    const sql = `SELECT DISTINCT ${sel} FROM ${this.tableName} ${w.sql}`.trim();
    const ret = await this.execute(sql, w.params);
    if (!ret || ret.success === false) return ret as any;
    const rows = ((ret as any).data ?? (ret as any).results ?? []) as any[];
    return { success: true, data: rows.map(r => r[column]) };
  }

  async count(): Promise<QueryResult<number>> {
    const w = compileWhereGroupsWithRaw(
      this.whereGroups,
      this.rawWhereGroups,
      this._ctx
    );
    const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${w.sql}`.trim();
    const ret = await this.execute(sql, w.params);
    if (!ret || ret.success === false) return ret as any;
    const rows = ((ret as any).data ?? (ret as any).results ?? []) as any[];
    const count = rows[0]?.count ?? 0;
    return { success: true, data: count };
  }

  /**
   * Run a single-aggregate scalar query: `SELECT <fn>(<col>) AS v FROM ...`.
   * Used by sum/avg/min/max. Returns null when no rows match (SQL semantics).
   * JSON-path columns are honored (`.sum('payload.amount')` works).
   */
  private async runScalarAggregate(
    fn: 'SUM' | 'AVG' | 'MIN' | 'MAX',
    column: string
  ): Promise<QueryResult<any>> {
    const w = compileWhereGroupsWithRaw(
      this.whereGroups,
      this.rawWhereGroups,
      this._ctx
    );
    const ref = parseJsonRef(column, this._jsonCols);
    const expr = ref ? jsonReadRef(ref.column, ref.path) : column;
    const sql = `SELECT ${fn}(${expr}) as v FROM ${this.tableName} ${w.sql}`.trim();
    const ret = await this.execute(sql, w.params);
    if (!ret || ret.success === false) return ret as any;
    const rows = ((ret as any).data ?? (ret as any).results ?? []) as any[];
    const v = rows[0]?.v ?? null;
    return { success: true, data: v };
  }

  async sum(column: string): Promise<QueryResult<number | null>> {
    return this.runScalarAggregate('SUM', column);
  }

  async avg(column: string): Promise<QueryResult<number | null>> {
    return this.runScalarAggregate('AVG', column);
  }

  async min(column: string): Promise<QueryResult<any>> {
    return this.runScalarAggregate('MIN', column);
  }

  async max(column: string): Promise<QueryResult<any>> {
    return this.runScalarAggregate('MAX', column);
  }

  /**
   * Updates rows matching the chain's where clause.
   *
   * Cardinality is derived from the chain — narrow the where (typically by
   * primary key) or chain `.limit(1)` to affect a single row. A where is
   * required to prevent accidental table-wide updates.
   */
  async update(values: Record<string, any>): Promise<QueryResult<any>> {
    const cleanValues = values ? omitUndefinedFields(values) as Record<string, any> : values;
    if (!cleanValues || Object.keys(cleanValues).length === 0) {
      return { success: false, error: 'No update values provided' } as any;
    }
    const w = compileWhereGroupsWithRaw(
      this.whereGroups,
      this.rawWhereGroups,
      this._ctx
    );
    if (!w.sql) {
      return { success: false, error: 'update() requires a where clause' } as any;
    }
    const setBuild = compileUpdateSet(cleanValues, this._jsonCols);
    const ret = this.compileReturning();
    const sql = [
      `UPDATE ${this.tableName} SET ${setBuild.sql}`,
      w.sql,
      ret,
      this.compileWriteTail(),
    ].filter(Boolean).join(' ');
    const result = await this.execute(sql, [...setBuild.params, ...w.params]);
    return this.applyReturningResult(result);
  }

  /**
   * Deletes rows matching the chain's where clause.
   *
   * Cardinality is derived from the chain. A where is required to prevent
   * accidental table-wide deletes.
   */
  async delete(): Promise<QueryResult<any>> {
    const w = compileWhereGroupsWithRaw(
      this.whereGroups,
      this.rawWhereGroups,
      this._ctx
    );
    if (!w.sql) {
      return { success: false, error: 'Delete requires a where clause for safety' } as any;
    }
    const ret = this.compileReturning();
    const sql = [`DELETE FROM ${this.tableName}`, w.sql, ret, this.compileWriteTail()]
      .filter(Boolean)
      .join(' ');
    const result = await this.execute(sql, w.params);
    return this.applyReturningResult(result);
  }

  /**
   * Post-process a write result when `returning()` was used.
   *
   * D1 / SqlStorage both surface the RETURNING rows in the same `data` /
   * `results` field as a SELECT. We just parse JSON columns on them so
   * the shape matches what the user gets from reads. Without RETURNING,
   * pass through unchanged so callers still see the raw meta.
   */
  private applyReturningResult(result: any): QueryResult<any> {
    if (!this._returningCols || !result || result.success === false) return result;
    const rows = (result.data ?? result.results ?? []) as any[];
    return { ...result, data: this.parseReturnedRows(rows) };
  }

  /**
   * Inserts one row or many rows. Naturally terminal — chain state is
   * ignored. Validates against the schema (drops unknown fields with a
   * warning) and stringifies whole-object values for JSON columns.
   */
  async insert(values: Partial<Row> | Partial<Row>[]): Promise<QueryResult<any>> {
    const rows = Array.isArray(values) ? values : [values];
    if (rows.length === 0) return { success: true };

    let validatedRows: Partial<Row>[] = rows;

    if (this._allColumns) {
      const skippedFields = new Set<string>();
      validatedRows = rows.map((row) => {
        const out: Partial<Row> = {};
        for (const [key, value] of Object.entries(row as any)) {
          if (value === undefined) continue;
          if (this._allColumns!.has(key)) {
            (out as any)[key] = value;
          } else {
            skippedFields.add(key);
          }
        }
        return out;
      });

      if (skippedFields.size > 0) {
        console.warn(
          `[kunii] Skipping fields not in schema for table '${this.tableName}': ${Array.from(skippedFields).join(', ')}`
        );
      }
    } else {
      validatedRows = rows.map((row) => omitUndefinedFields(row as any) as Partial<Row>);
    }

    // Union keys across all rows so heterogeneous bulk inserts (e.g. row A
    // omits `deleted_at`, row B sets it) don't silently drop columns from
    // the column list. Missing values become NULL.
    const colSet = new Set<string>();
    for (const r of validatedRows) {
      for (const k of Object.keys(r as any)) colSet.add(k);
    }
    const cols = Array.from(colSet);
    if (cols.length === 0) {
      if (rows.length === 1 && Object.keys(rows[0] as any).length === 0) {
        const ret = this.compileReturning();
        const result = await this.execute(
          [`INSERT INTO ${this.tableName} DEFAULT VALUES`, ret].filter(Boolean).join(' ')
        );
        return this.applyReturningResult(result);
      }
      return { success: false, error: 'No valid columns to insert' };
    }

    // Auto-stringify whole-object writes to JSON columns.
    const params = validatedRows.flatMap((r) =>
      cols.map((c) => {
        const v = c in (r as any) ? (r as any)[c] : null;
        if (v != null && this._jsonCols?.has(c) && isComplexJsonValue(v)) return JSON.stringify(v);
        return v;
      })
    );
    const placeholders = `(${cols.map(() => '?').join(', ')})`;
    const allPlaceholders = validatedRows.map(() => placeholders).join(', ');
    const ret = this.compileReturning();
    const baseSql = [
      `INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES ${allPlaceholders}`,
      ret,
    ].filter(Boolean).join(' ');
    const result = await this.execute(baseSql, params);
    return this.applyReturningResult(result);
  }

  /**
   * Insert-or-update. Compiles to SQLite's
   *   INSERT INTO t (cols) VALUES (...) ON CONFLICT(target) DO UPDATE SET ...
   * Single round-trip on D1; idempotent semantics on both backends.
   */
  async upsert(opts: any): Promise<QueryResult<any>> {
    if (!opts || !opts.values) {
      return { success: false, error: 'upsert() requires { values, onConflict, update }' } as any;
    }

    const rows = Array.isArray(opts.values) ? opts.values : [opts.values];
    if (rows.length === 0) return { success: true };

    // Schema-validate inserted columns the same way insert() does.
    let validatedRows: any[] = rows;
    if (this._allColumns) {
      const skippedFields = new Set<string>();
      validatedRows = rows.map((row: any) => {
        const out: any = {};
        for (const [key, value] of Object.entries(row)) {
          if (value === undefined) continue;
          if (this._allColumns!.has(key)) {
            out[key] = value;
          } else {
            skippedFields.add(key);
          }
        }
        return out;
      });
      if (skippedFields.size > 0) {
        console.warn(
          `[kunii] Skipping fields not in schema for table '${this.tableName}': ${Array.from(skippedFields).join(', ')}`
        );
      }
    } else {
      validatedRows = rows.map((row: any) => omitUndefinedFields(row));
    }

    // Union keys across all rows (heterogeneous bulk safe).
    const colSet = new Set<string>();
    for (const r of validatedRows) for (const k of Object.keys(r)) colSet.add(k);
    const cols = Array.from(colSet);
    if (cols.length === 0) {
      return { success: false, error: 'No valid columns to upsert' };
    }

    // Build the VALUES clause with JSON stringification for json columns.
    const insertParams = validatedRows.flatMap((r: any) =>
      cols.map((c) => {
        const v = c in r ? r[c] : null;
        if (v != null && this._jsonCols?.has(c) && isComplexJsonValue(v)) return JSON.stringify(v);
        return v;
      })
    );
    const placeholders = `(${cols.map(() => '?').join(', ')})`;
    const allPlaceholders = validatedRows.map(() => placeholders).join(', ');

    // Conflict target: column name(s).
    const targetCols = Array.isArray(opts.onConflict)
      ? opts.onConflict
      : [opts.onConflict];
    if (!targetCols.length) {
      return { success: false, error: 'upsert() requires onConflict: column name(s)' };
    }
    const target = targetCols.join(', ');

    // Conflict resolution clause.
    let conflictSql: string;
    const updateParams: any[] = [];

    if (opts.update === 'ignore') {
      conflictSql = `ON CONFLICT(${target}) DO NOTHING`;
    } else if (opts.update === 'all') {
      // SET every inserted column (excluding the conflict target columns,
      // which are by definition the same row identity) from `excluded`.
      const targetSet = new Set(targetCols);
      const setCols = cols.filter((c) => !targetSet.has(c));
      if (setCols.length === 0) {
        // No non-target columns to update — fall back to DO NOTHING.
        conflictSql = `ON CONFLICT(${target}) DO NOTHING`;
      } else {
        const setSql = setCols.map((c) => `${c} = excluded.${c}`).join(', ');
        conflictSql = `ON CONFLICT(${target}) DO UPDATE SET ${setSql}`;
      }
    } else if (opts.update && typeof opts.update === 'object') {
      // Explicit set values — reuse compileUpdateSet for JSON-path support.
      const setBuild = compileUpdateSet(omitUndefinedFields(opts.update), this._jsonCols);
      if (!setBuild.sql) {
        conflictSql = `ON CONFLICT(${target}) DO NOTHING`;
      } else {
        conflictSql = `ON CONFLICT(${target}) DO UPDATE SET ${setBuild.sql}`;
        updateParams.push(...setBuild.params);
      }
    } else {
      return {
        success: false,
        error: "upsert() update must be 'all', 'ignore', or an object",
      };
    }

    const ret = this.compileReturning();
    const sql = [
      `INSERT INTO ${this.tableName} (${cols.join(', ')}) VALUES ${allPlaceholders}`,
      conflictSql,
      ret,
    ].filter(Boolean).join(' ');
    const result = await this.execute(sql, [...insertParams, ...updateParams]);
    return this.applyReturningResult(result);
  }

  async exists(): Promise<boolean> {
    const w = compileWhereGroupsWithRaw(
      this.whereGroups,
      this.rawWhereGroups,
      this._ctx
    );
    const sql = `SELECT EXISTS(SELECT 1 FROM ${this.tableName} ${w.sql} LIMIT 1) as e`;
    const ret = await this.execute(sql, w.params);
    if (!ret || ret.success === false) return false;
    const rows = (ret as any).data ?? (ret as any).results ?? [];
    return Array.isArray(rows) && rows.length > 0 && (rows[0]?.e === 1 || rows[0]?.e === true);
  }

  /** Compile GROUP BY + HAVING fragments. Returns SQL parts and params. */
  private compileGroupAndHaving(): { groupSql: string; havingSql: string; params: any[] } {
    const groupSql = this.groupCols && this.groupCols.length
      ? `GROUP BY ${this.groupCols.join(', ')}`
      : '';
    if (!this.havingFilter || Object.keys(this.havingFilter).length === 0) {
      return { groupSql, havingSql: '', params: [] };
    }
    // HAVING uses the same operator vocabulary as where, but operates on
    // SELECT aliases — no JSON-path detection or relation expansion.
    const compiled = compileWhere(this.havingFilter);
    if (!compiled.sql) return { groupSql, havingSql: '', params: [] };
    return {
      groupSql,
      havingSql: compiled.sql.replace(/^WHERE/i, 'HAVING'),
      params: compiled.params,
    };
  }

  async many(): Promise<QueryResult<Row[]>> {
    const sel = compileSelect(this.selectCols, this._jsonCols);
    const w = compileWhereGroupsWithRaw(
      this.whereGroups,
      this.rawWhereGroups,
      this._ctx
    );
    const gh = this.compileGroupAndHaving();
    const order = compileOrderBy(this.order, this._jsonCols);
    const limit = typeof this.limitN === 'number' ? `LIMIT ${this.limitN}` : '';
    const offset = typeof this.offsetN === 'number' ? `OFFSET ${this.offsetN}` : '';
    const head = `SELECT ${sel} FROM ${this.tableName}`;
    // Standard SQL ordering: WHERE → GROUP BY → HAVING → ORDER BY → LIMIT/OFFSET.
    const sql = [head, w.sql, gh.groupSql, gh.havingSql, order, limit, offset]
      .filter(Boolean)
      .join(' ');
    const ret = await this.execute(sql, [...w.params, ...gh.params]);
    if (!ret || ret.success === false) return ret as any;
    let rows = ((ret as any).data ?? (ret as any).results ?? []) as Row[];

    if (this.includeSpec && rows.length) {
      rows = await this.applyIncludes(rows, this.includeSpec);
    }

    return { success: true, data: rows } as QueryResult<Row[]>;
  }

  async first(): Promise<QueryResult<Row | undefined>> {
    // Fast path: use the native `first()` API when available, but ONLY
    // when we don't have an include spec or aggregates — relations and
    // GROUP BY need many() so the loader and group SQL run correctly.
    const hasAggregates = !!(this.groupCols?.length || this.havingFilter);
    if (
      this.fullClient?.first &&
      typeof this.limitN !== 'number' &&
      !this.includeSpec &&
      !hasAggregates
    ) {
      const sel = compileSelect(this.selectCols, this._jsonCols);
      const w = compileWhereGroupsWithRaw(
        this.whereGroups,
        this.rawWhereGroups,
        this._ctx
      );
      const order = compileOrderBy(this.order, this._jsonCols);
      const sql = [`SELECT ${sel} FROM ${this.tableName}`, w.sql, order, 'LIMIT 1'].filter(Boolean).join(' ');
      const res = await this.fullClient.first(sql, w.params);
      if (!res || res.success === false) return res as any;
      const row = (res as any).data != null ? (res as any).data : undefined;
      return { success: true, data: row };
    }
    if (typeof this.limitN !== 'number') {
      this.limitN = 1;
    }
    const res = await this.many();
    if (!res.success) return res as any;
    const rows = (res as any).data ?? (res as any).results;
    const first = Array.isArray(rows) ? rows[0] : undefined;
    return { success: true, data: first };
  }

  async one(): Promise<QueryResult<Row>> {
    this.limitN = 2;
    const res = await this.many();
    if (!res.success) return res as any;
    const rows = ((res as any).data ?? (res as any).results ?? []) as Row[];
    if (rows.length !== 1) {
      return { success: false, error: rows.length === 0 ? 'Not found' : 'Expected exactly one row' } as any;
    }
    return { success: true, data: rows[0] } as any;
  }

  private singularize(name: string): string {
    return name.endsWith('s') ? name.slice(0, -1) : name;
  }

  /**
   * Build the column list for an include's child SELECT.
   *
   * - If `select` is provided, use it (rewriting JSON paths) and ALWAYS
   *   add the FK column at the end so the loader can stitch rows back to
   *   their parents (de-duplicated if the user already requested it).
   * - Otherwise SELECT *.
   */
  private compileIncludeSelect(
    includeTable: string,
    fkColumn: string,
    select: string[] | undefined,
    childJsonCols: Set<string> | undefined
  ): string {
    if (!select || !select.length) return '*';
    const requested = new Set(select);
    const cols = [...select];
    if (!requested.has(fkColumn)) cols.push(fkColumn);
    return compileSelect(cols, childJsonCols);
  }

  /**
   * Compose a fully-qualified `WHERE fk IN (...) AND <user-where>` clause
   * for the child query. Returns `{ sql, params }` where `sql` includes
   * the leading `WHERE`.
   */
  private compileIncludeWhere(
    fkColumn: string,
    parentIds: any[],
    userWhere: Where | undefined,
    childTable: string
  ): { sql: string; params: any[] } {
    const fkClause = `${fkColumn} IN (SELECT value FROM json_each(?))`;
    const fkParam = JSON.stringify(parentIds);
    if (!userWhere || Object.keys(userWhere).length === 0) {
      return { sql: `WHERE ${fkClause}`, params: [fkParam] };
    }
    const userCompiled = compileWhere(userWhere, {
      jsonCols: this._jsonColsByTable?.get(childTable),
      relations: this._relationsByTable?.get(childTable),
      parentTable: childTable,
      relationsByTable: this._relationsByTable,
      jsonColsByTable: this._jsonColsByTable,
    });
    if (!userCompiled.sql) {
      return { sql: `WHERE ${fkClause}`, params: [fkParam] };
    }
    const userInner = userCompiled.sql.replace(/^WHERE\s+/i, '');
    return {
      sql: `WHERE ${fkClause} AND (${userInner})`,
      params: [fkParam, ...userCompiled.params],
    };
  }

  private makeChildBuilder(tableName: string): QueryBuilder<any> {
    return new QueryBuilder(
      tableName,
      this.execute,
      this.fullClient,
      this._jsonColsByTable?.get(tableName),
      undefined,
      this._relationsByTable?.get(tableName),
      this._relationsByTable,
      this._jsonColsByTable
    );
  }

  private async applyIncludes(rows: any[], spec: IncludeSpec): Promise<any[]> {
    const out = [...rows];
    for (const [key, rawCfg] of Object.entries(spec)) {
      const cfg: IncludeConfig =
        typeof rawCfg === 'boolean' ? {} : (rawCfg || {});
      const includeTable = cfg.table ?? key;
      const as = cfg.as ?? key;
      const childJsonCols = this._jsonColsByTable?.get(includeTable);

      const candidateFkCols = [
        `${this.singularize(includeTable)}Id`,
        `${includeTable}Id`,
      ];
      const sample = out[0] || {};
      const parentFkCol = candidateFkCols.find((c) => c in sample);

      // ── belongsTo: parent row holds the FK to a single child ─────
      if (parentFkCol) {
        const ids = Array.from(
          new Set(out.map((r) => r[parentFkCol]).filter((v) => v != null))
        );
        if (!ids.length) continue;

        const where = this.compileIncludeWhere(
          'id',
          ids,
          cfg.where,
          includeTable
        );
        const order = compileOrderBy(cfg.orderBy, childJsonCols);
        const sel = this.compileIncludeSelect(
          includeTable,
          'id',
          cfg.select,
          childJsonCols
        );
        const sqlParts = [
          `SELECT ${sel} FROM ${includeTable}`,
          where.sql,
          order,
        ].filter(Boolean);
        const sql = sqlParts.join(' ');

        const ret = await this.execute(sql, where.params);
        if (ret && ret.success !== false) {
          let rows2 = ((ret as any).data ?? (ret as any).results ?? []) as any[];
          if (cfg.include && rows2.length) {
            rows2 = await this.makeChildBuilder(includeTable).applyIncludes(rows2, cfg.include);
          }
          const map = new Map(rows2.map((r) => [r.id, r]));
          for (const r of out) (r as any)[as] = map.get(r[parentFkCol]);
        }
        continue;
      }

      // ── hasMany: child holds the FK back to parent ───────────────
      const localKey = cfg.localKey ?? 'id';
      const foreignKey =
        cfg.foreignKey ?? `${this.singularize(this.tableName)}Id`;
      const ids = Array.from(
        new Set(out.map((r) => r[localKey]).filter((v) => v != null))
      );
      if (!ids.length) {
        // Still need to default to empty arrays for parents.
        for (const r of out) (r as any)[as] = [];
        continue;
      }

      const where = this.compileIncludeWhere(
        foreignKey,
        ids,
        cfg.where,
        includeTable
      );
      const order = compileOrderBy(cfg.orderBy, childJsonCols);
      const sel = this.compileIncludeSelect(
        includeTable,
        foreignKey,
        cfg.select,
        childJsonCols
      );

      let sql: string;
      let params: any[];

      if (typeof cfg.limit === 'number' && cfg.limit > 0) {
        // Per-parent top-N via window function. `ROW_NUMBER()` partitions
        // by the FK and ranks each child within its parent's group, then
        // an outer SELECT keeps only those with rn <= limit. This way
        // every parent gets up to `limit` children (not `limit` total).
        const orderForWindow = order
          ? order.replace(/^ORDER BY\s+/i, '')
          : foreignKey; // arbitrary but stable order if user didn't pick one
        const inner = [
          `SELECT ${sel === '*' ? '*' : sel}, ROW_NUMBER() OVER (PARTITION BY ${foreignKey} ORDER BY ${orderForWindow}) AS __rn`,
          `FROM ${includeTable}`,
          where.sql,
        ].join(' ');
        sql = `SELECT * FROM (${inner}) WHERE __rn <= ?`;
        params = [...where.params, cfg.limit];
      } else {
        const sqlParts = [
          `SELECT ${sel} FROM ${includeTable}`,
          where.sql,
          order,
        ].filter(Boolean);
        sql = sqlParts.join(' ');
        params = where.params;
      }

      const ret = await this.execute(sql, params);
      if (ret && ret.success !== false) {
        let rows2 = ((ret as any).data ?? (ret as any).results ?? []) as any[];
        if (cfg.include && rows2.length) {
          rows2 = await this.makeChildBuilder(includeTable).applyIncludes(rows2, cfg.include);
        }
        const groups = new Map<any, any[]>();
        for (const r of rows2) {
          const k = (r as any)[foreignKey];
          // Drop the synthetic __rn column from window-function results.
          if ('__rn' in r) delete r.__rn;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(r);
        }
        for (const r of out) (r as any)[as] = groups.get((r as any)[localKey]) ?? [];
      }
    }
    return out;
  }
}

// â”€â”€ createRuntimeOrm â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createRuntimeOrm(
  execute: SqlExecutor,
  schema?: Pick<DatabaseSchema, 'tables'>,
  fullClient?: FullDbClient
) {
  const schemaColumnsByTable = new Map<string, Set<string>>();
  const jsonColsByTable = new Map<string, Set<string>>();

  // Relation registry built from schema's `references` declarations.
  // Keyed by parent table name, then by relation name (= child table).
  // E.g. { users: { posts: { table: 'posts', foreignKey: 'userId', localKey: 'id' } } }
  const relationsByTable = new Map<string, Map<string, Relation>>();

  if (schema?.tables) {
    for (const table of schema.tables) {
      const columns = new Set(table.columns.map(col => col.name));
      schemaColumnsByTable.set(table.name, columns);
      const jsonCols = new Set<string>();
      for (const col of table.columns) {
        if ((col as any).type === 'json') jsonCols.add(col.name);
      }
      if (jsonCols.size) jsonColsByTable.set(table.name, jsonCols);
    }

    // Walk every column with a `references` declaration to build the
    // hasMany registry. From the parent's POV (the referenced table),
    // each child table that points to it becomes a relation keyed by
    // the child table name.
    for (const table of schema.tables) {
      for (const col of table.columns) {
        const ref = (col as any).references;
        if (!ref || !ref.table || !ref.column) continue;
        // Parent: ref.table. Child: table.name. FK: col.name. LocalKey: ref.column.
        let parentRelations = relationsByTable.get(ref.table);
        if (!parentRelations) {
          parentRelations = new Map<string, Relation>();
          relationsByTable.set(ref.table, parentRelations);
        }
        // Use the child table name as the relation key. If two FKs point
        // to the same parent from the same child (rare), the second
        // overwrites — users with that shape can use named relations
        // (a future feature) or fall back to db.raw.
        parentRelations.set(table.name, {
          table: table.name,
          foreignKey: col.name,
          localKey: ref.column,
        });
      }
    }
  }

  /**
   * Returns a `Table<Row>` for the given name. Each call creates a fresh
   * builder so callers cannot accidentally leak chain state between queries.
   *
   * `db.users` and `db.users.where(...).orderBy(...)` are the same shape.
   * Chain methods mutate-and-return-this on the underlying builder; terminals
   * return a Promise. There is no separate "table handle" vs. "query" type.
   */
  function table<Row = any>(tableName: string): Table<Row> {
    const jsonCols = jsonColsByTable.get(tableName);
    const allColumns = schemaColumnsByTable.get(tableName);
    const relations = relationsByTable.get(tableName);
    return new QueryBuilder<Row>(
      tableName,
      execute,
      fullClient,
      jsonCols,
      allColumns,
      relations,
      relationsByTable,
      jsonColsByTable
    ) as unknown as Table<Row>;
  }

  return { table, raw: execute };
}

// â”€â”€ Schema-aware client (auto JSON parse on reads) â”€â”€â”€â”€â”€â”€â”€â”€
//
// All write-side serialization (INSERT stringify, UPDATE json_set + json(?))
// happens inside `createRuntimeOrm` because it knows the schema's JSON
// columns. This wrapper is only responsible for parsing JSON columns back
// into objects on reads — the inverse of what the runtime does on writes.
//
// We use a Proxy so we don't have to enumerate the entire `Table` surface
// (which is the whole point of having a single interface). New methods on
// `Table<Row>` work here automatically; only the read terminals (`many`,
// `first`, `one`) need parse interception.

export function createSchemaClient(
  execute: SqlExecutor,
  schema: Pick<DatabaseSchema, 'tables'>,
  opts?: { client?: FullDbClient }
): Record<string, Table> {
  const fullClient = opts?.client;
  const jsonColsByTable = new Map<string, Set<string>>();
  for (const t of schema.tables) {
    const s = new Set<string>();
    for (const col of t.columns) {
      if ((col as any).type === 'json') s.add(col.name);
    }
    if (s.size > 0) jsonColsByTable.set(t.name, s);
  }

  const base = createRuntimeOrm(execute, schema, fullClient);

  const deserializeRows = (tableName: string, rows: any[]): any[] => {
    const jsonCols = jsonColsByTable.get(tableName);
    if (!jsonCols?.size || !Array.isArray(rows) || !rows.length) return rows;
    return rows.map((row: any) => {
      const copy: any = { ...row };
      for (const col of jsonCols) {
        const v = copy[col];
        if (v === undefined || v === null) continue;
        if (typeof v === 'string') {
          try { copy[col] = JSON.parse(v); } catch { /* leave as string */ }
        }
      }
      return copy;
    });
  };

  /**
   * Wrap a `Table<Row>` so that read terminals deserialize JSON columns.
   *
   * Chain methods are passed through and re-wrapped so the deserialization
   * follows the chain. Write terminals pass through unchanged — they don't
   * surface JSON-column row data to the caller.
   */
  const READ_TERMINALS = new Set(['many', 'first', 'one']);

  function wrap(tableName: string, target: Table<any>): Table<any> {
    return new Proxy(target as any, {
      get(t, prop: PropertyKey, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof value !== 'function') return value;

        const propName = String(prop);

        if (READ_TERMINALS.has(propName)) {
          return async (...args: any[]) => {
            const res = await value.apply(t, args);
            if (!res || res.success === false) return res;
            const data = (res as any).data;
            if (Array.isArray(data)) {
              return { ...res, data: deserializeRows(tableName, data) };
            }
            if (data && typeof data === 'object') {
              return { ...res, data: deserializeRows(tableName, [data])[0] };
            }
            return res;
          };
        }

        // Other methods: invoke; if the return is the same Table (chain
        // continuation), wrap it; otherwise pass through (terminals like
        // insert/update/delete/count/exists/distinct return Promises).
        return (...args: any[]) => {
          const out = value.apply(t, args);
          if (out === t) return receiver;
          if (out && typeof out === 'object' && typeof (out as any).many === 'function') {
            return wrap(tableName, out as Table<any>);
          }
          return out;
        };
      },
    });
  }

  // Each access to `db.users` MUST return a fresh wrapped Table — chain
  // state lives on the underlying QueryBuilder instance, so reusing a single
  // wrapper across calls would cross-contaminate filters between queries.
  const knownTables = new Set(schema.tables.map((t) => t.name));
  return new Proxy({} as Record<string, Table>, {
    get(_, prop: PropertyKey) {
      if (typeof prop !== 'string') return undefined;
      // Only wrap declared tables; unknown access falls back to the raw
      // base table (no JSON parsing). This keeps `db.unknownTable` working
      // for ad-hoc usage.
      if (!knownTables.has(prop)) return base.table(prop);
      return wrap(prop, base.table(prop));
    },
  });
}

// â”€â”€ D1 helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Convert a SQL error into a more actionable message when it points to
 * a likely missing-migration situation. The framework no longer auto-runs
 * migrations on cold start (that opt-out happened when `kuratchi.config.ts`
 * went away) — so seeing "no such table" usually means the user forgot to
 * wire `autoMigrate` into their middleware. We surface that in the error
 * message rather than silently returning `success: false`.
 */
function explainSqlError(message: string | undefined): string | undefined {
  if (!message) return message;
  const m = /no such table:\s*(\S+)/i.exec(message);
  if (m) {
    return `${message}. Did you forget to wire \`autoMigrate({ <BINDING>: schema })\` into your middleware? See https://kuratchi.dev/docs/orm/auto-migrate for details.`;
  }
  return message;
}

function d1Executor(database: any): { execute: SqlExecutor; fullClient: FullDbClient } {
  const execute: SqlExecutor = async (sql, params) => {
    try {
      let stmt = database.prepare(sql);
      if (params?.length) stmt = stmt.bind(...params);
      const result = await stmt.all();
      return {
        success: result.success ?? true,
        data: result.results,
        results: result.results,
        error: explainSqlError(result.error),
        meta: result.meta
      };
    } catch (error: any) {
      return { success: false, error: explainSqlError(error?.message || String(error)) };
    }
  };

  const fullClient: FullDbClient = {
    first: async (sql, params, column) => {
      try {
        let stmt = database.prepare(sql);
        if (params?.length) stmt = stmt.bind(...params);
        const result = column ? await stmt.first(column) : await stmt.first();
        return { success: true, data: result, results: result ? [result] : [] };
      } catch (error: any) {
        return { success: false, error: explainSqlError(error?.message || String(error)) };
      }
    },
    batch: async (queries) => {
      try {
        const stmts = queries.map(q => {
          let stmt = database.prepare(q.query);
          if (q.params?.length) stmt = stmt.bind(...q.params);
          return stmt;
        });
        const results = await database.batch(stmts);
        return { success: true, results: results.map((r: any) => r.results || []) };
      } catch (error: any) {
        return { success: false, error: explainSqlError(error?.message || String(error)) };
      }
    },
    run: async (sql, params) => {
      try {
        let stmt = database.prepare(sql);
        if (params?.length) stmt = stmt.bind(...params);
        const result = await stmt.run();
        return { success: result.success ?? true, meta: result.meta, error: explainSqlError(result.error) };
      } catch (error: any) {
        return { success: false, error: explainSqlError(error?.message || String(error)) };
      }
    },
    raw: async (sql, params) => {
      try {
        let stmt = database.prepare(sql);
        if (params?.length) stmt = stmt.bind(...params);
        const result = await stmt.raw();
        return { success: true, data: result, results: result };
      } catch (error: any) {
        return { success: false, error: explainSqlError(error?.message || String(error)) };
      }
    }
  };

  return { execute, fullClient };
}

// Unified factory.

/**
 * Create an ORM client.
 *
 * - Pass a D1 binding directly for immediate use
 * - Pass a getter function for deferred binding (module-level singletons)
 * - Pass a config object for Durable Objects / custom executors
 *
 * @example D1 binding (inline)
 * ```ts
 * const db = kunii(env.DB);
 * await db.todos.many();
 * ```
 *
 * @example D1 getter (module-level â€” binding resolved at query time)
 * ```ts
 * const db = kunii(() => getEnv<Env>().DB);
 * await db.todos.orderBy({ created_at: 'desc' }).many();
 * ```
 *
 * @example Durable Object (inside DO class â€” direct SqlStorage)
 * ```ts
 * const db = kunii(this.sql);
 * await db.stats.where({ key: 'total_added' }).first();
 * ```
 */

/**
 * Run schema migrations. Two surfaces, one verb:
 *
 *   1. **Durable Object form** (synchronous):
 *      ```ts
 *      autoMigrate(ctx.storage, schema);
 *      this.db = kunii(ctx.storage.sql, schema);
 *      ```
 *      Runs `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE` for any
 *      newly-declared columns. Idempotent across DO restarts. Call this
 *      inside the DO constructor before any `this.db` access.
 *
 *      Accepts either `ctx.storage` (preferred — enables atomic batch via
 *      `transactionSync`) or `ctx.storage.sql` (the SqlStorage surface).
 *
 *   2. **D1 middleware form** (async, per-isolate):
 *      ```ts
 *      export default defineMiddleware({
 *        migrate: autoMigrate({ DB: adminSchema }),
 *      });
 *      ```
 *      Returns a middleware step that runs `runMigrations` against every
 *      binding in the map on the first request per worker isolate, then
 *      short-circuits via an in-isolate flag.
 *
 * Replaces the older `initDO` (which conflated init / migrate / build-orm).
 * The framework no longer scrapes config to wire migrations -
 * users opt in explicitly by calling `autoMigrate` in their DO file or
 * middleware. This makes it obvious where DDL runs and lets users disable
 * auto-migration without a config knob (e.g. CI-managed migrations).
 */
export function autoMigrate(
  storage: any,
  schema: DatabaseSchema | any
): void;
export function autoMigrate(
  bindings: Record<string, DatabaseSchema | any>
): { request: (ctx: any, next: () => Promise<Response>) => Promise<Response> };
export function autoMigrate(
  arg0: any,
  schema?: any
): void | { request: (ctx: any, next: () => Promise<Response>) => Promise<Response> } {
  // DO synchronous form: autoMigrate(storage, schema).
  if (schema !== undefined) {
    autoMigrateDO(arg0, schema);
    return;
  }

  // D1 middleware form: autoMigrate({ BINDING: schema, ... }).
  if (!arg0 || typeof arg0 !== 'object') {
    throw new Error('[kunii] autoMigrate: expected a binding map (e.g. { DB: schema }) or a (storage, schema) pair.');
  }
  // Guard against accidental SqlStorage being passed without a schema —
  // that shape would silently fall through and never migrate anything.
  if (typeof (arg0 as any).exec === 'function' || typeof (arg0 as any).sql?.exec === 'function') {
    throw new Error('[kunii] autoMigrate(storage) called without a schema. Pass `autoMigrate(ctx.storage, schema)` for the DO form.');
  }
  return autoMigrateMiddleware(arg0 as Record<string, DatabaseSchema | any>);
}

function autoMigrateDO(storageOrSql: any, schema: any): void {
  const normalized = ensureNormalizedSchema(schema);

  // Accept either `ctx.storage` (preferred — has `.sql` AND `.transactionSync`)
  // or `ctx.storage.sql` (the SqlStorage object only). When the parent is
  // passed, attach `transactionSync` to the SqlStorage so `kunii` picks
  // it up for atomic `batch()`.
  const sql =
    typeof storageOrSql?.sql?.exec === 'function' ? storageOrSql.sql : storageOrSql;
  if (!sql || typeof sql.exec !== 'function') {
    throw new Error('[kunii] autoMigrate: expected ctx.storage or ctx.storage.sql; got ' + typeof storageOrSql);
  }
  const transactionSync: ((cb: () => any) => any) | undefined =
    typeof storageOrSql?.transactionSync === 'function'
      ? (storageOrSql.transactionSync.bind(storageOrSql) as any)
      : undefined;

  // Snapshot which tables exist BEFORE running initial SQL.
  // Tables not in this set were just created — no additive migration needed.
  const existingTables = new Set<string>();
  try {
    const rows = sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray?.() ?? [];
    for (const r of rows) existingTables.add(String(r?.name ?? ''));
  } catch {}

  // Run CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS statements.
  const migrationSql = buildInitialSql(normalized);
  const statements = migrationSql.split(';').map((s: string) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    sql.exec(stmt);
  }

  // Only check for missing columns on tables that pre-existed.
  // Fresh tables (just created above) are already complete.
  applyDoAdditiveMigrations(sql, normalized, existingTables);

  // When transactionSync is available, attach it to the SqlStorage object
  // (a benign augmentation) so `kunii` picks it up for atomic batch.
  if (transactionSync && !sql.transactionSync) {
    try {
      Object.defineProperty(sql, 'transactionSync', {
        value: transactionSync,
        writable: false,
        configurable: false,
      });
    } catch {
      // Some SqlStorage implementations are frozen — fall back silently.
      (sql as any).transactionSync = transactionSync;
    }
  }
}

function autoMigrateMiddleware(
  bindings: Record<string, DatabaseSchema | any>
): { request: (ctx: any, next: () => Promise<Response>) => Promise<Response> } {
  const migratedBindings = new Set<string>();
  return {
    async request(ctx: any, next: () => Promise<Response>) {
      if (migratedBindings.size < Object.keys(bindings).length) {
        // Lazy import to avoid pulling the migrations runner into bundles
        // that only use `autoMigrate` for DOs.
        const { runMigrations } = await import('./migrations/runner.js');
        const failures: string[] = [];
        for (const [bindingName, schema] of Object.entries(bindings)) {
          if (migratedBindings.has(bindingName)) continue;
          const binding = (ctx?.env as Record<string, any>)?.[bindingName];
          if (!binding) {
            console.warn(`[kunii] autoMigrate: env binding "${bindingName}" not found; skipping.`);
            continue;
          }
          if (typeof binding.prepare !== 'function') {
            console.warn(`[kunii] autoMigrate: env.${bindingName} is not a D1-compatible binding (no .prepare()); skipping.`);
            continue;
          }
          try {
            const execute: SqlExecutor = (sql, params) => {
              let stmt = binding.prepare(sql);
              if (params?.length) stmt = stmt.bind(...params);
              return stmt.all().then((r: any) => ({
                success: r.success ?? true,
                data: r.results,
                results: r.results,
              }));
              };
              const result = await runMigrations({ execute, schema, client: binding });
              migratedBindings.add(bindingName);
              if (result.applied) {
                console.log(`[kunii] ${bindingName}: migrated (${result.statementsRun} statements)`);
              }
              for (const w of result.warnings) {
                console.warn(`[kunii] ${bindingName}: ${w}`);
              }
            } catch (err: any) {
            const message = err?.message ?? String(err);
            console.error(`[kunii] ${bindingName} migration failed: ${message}`);
            failures.push(`${bindingName}: ${message}`);
            }
          }
        if (failures.length > 0) {
          throw new Error(
            `[kunii] autoMigrate failed for ${failures.length} binding(s): ${failures.join(' | ')}`
          );
        }
        }
      return next();
    },
  };
}

/**
 * Dev-only sanity check: throws if the live database schema differs from
 * the declared schema. Use during development to catch "I forgot to wire
 * `autoMigrate`" before it surfaces as a confusing `no such table` at
 * runtime.
 *
 * Runs once per worker isolate. Logs (does not throw) for missing bindings —
 * drift is the failure mode this guards against, not configuration mistakes.
 *
 * @example
 * ```ts
 * import { assertSchemaInSync } from '@kuratchi/kunii';
 *
 * export default defineMiddleware({
 *   schemaCheck: import.meta.env.DEV ? assertSchemaInSync({ DB: adminSchema }) : null,
 * });
 * ```
 */
export function assertSchemaInSync(
  bindings: Record<string, DatabaseSchema | any>
): { request: (ctx: any, next: () => Promise<Response>) => Promise<Response> } {
  let checked = false;
  return {
    async request(ctx: any, next: () => Promise<Response>) {
      if (!checked) {
        checked = true;
        const { hasPendingMigrations } = await import('./migrations/runner.js');
        for (const [bindingName, schema] of Object.entries(bindings)) {
          const binding = (ctx?.env as Record<string, any>)?.[bindingName];
          if (!binding || typeof binding.prepare !== 'function') continue;
          const execute: SqlExecutor = (sql, params) => {
            let stmt = binding.prepare(sql);
            if (params?.length) stmt = stmt.bind(...params);
            return stmt.all().then((r: any) => ({ success: r.success ?? true, data: r.results, results: r.results }));
          };
          const pending = await hasPendingMigrations({ execute, schema });
          if (pending) {
            const normalized = ensureNormalizedSchema(schema);
            throw new Error(
              `[kunii] Schema drift on env.${bindingName} (schema "${normalized.name}"). ` +
              `The database has pending migrations. Wire \`autoMigrate({ ${bindingName}: ${normalized.name}Schema })\` ` +
              `into your middleware, or apply migrations out-of-band before booting.`
            );
          }
        }
      }
      return next();
    },
  };
}

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function columnSqlType(col: Column): string {
  switch (col.type) {
    case 'text': return 'TEXT';
    case 'integer': return 'INTEGER';
    case 'real': return 'REAL';
    case 'blob': return 'BLOB';
    case 'json': return 'TEXT';
    default: return 'TEXT';
  }
}

function columnDefaultSql(col: Column): string | null {
  if (!col.default) return null;
  if (col.default.kind === 'raw') return `DEFAULT ${col.default.sql}`;
  const v = col.default.value;
  if (v === null) return 'DEFAULT NULL';
  if (typeof v === 'number') return `DEFAULT ${v}`;
  if (typeof v === 'boolean') return `DEFAULT ${v ? 1 : 0}`;
  const escaped = String(v).replace(/'/g, "''");
  return `DEFAULT '${escaped}'`;
}

function buildAddColumnSql(tableName: string, col: Column): { statements: string[]; warning?: string } {
  const parts: string[] = [
    `ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN ${quoteIdent(col.name)} ${columnSqlType(col)}`
  ];
  const statements: string[] = [];
  let warning: string | undefined;
  const dsql = columnDefaultSql(col);
  const hasRawDefault = col.default?.kind === 'raw';
  if (dsql && !hasRawDefault) parts.push(dsql);
  if (col.notNull && dsql && !hasRawDefault) {
    parts.push('NOT NULL');
  } else if (col.notNull) {
    warning = `[kunii] DO migration: adding ${tableName}.${col.name} without NOT NULL because SQLite cannot add NOT NULL columns with non-constant or missing defaults.`;
  }
  statements.push(parts.join(' '));
  if (col.default?.kind === 'raw') {
    statements.push(
      `UPDATE ${quoteIdent(tableName)} SET ${quoteIdent(col.name)} = ${col.default.sql} WHERE ${quoteIdent(col.name)} IS NULL`
    );
    const rawDefaultWarning = `[kunii] DO migration: added ${tableName}.${col.name} without preserving its schema-level non-constant default; existing rows were backfilled.`;
    warning = warning ? `${warning} ${rawDefaultWarning}` : rawDefaultWarning;
  }
  return { statements, warning };
}

function applyDoAdditiveMigrations(sql: any, schema: DatabaseSchema, existingTables: Set<string>): void {
  for (const table of schema.tables) {
    // Table was created fresh this instantiation — skip entirely.
    if (!existingTables.has(table.name)) continue;

    let existingCols = new Set<string>();
    try {
      const pragmaRows = sql.exec(`PRAGMA table_info(${quoteIdent(table.name)})`)?.toArray?.() ?? [];
      existingCols = new Set(pragmaRows.map((r: any) => String(r?.name ?? '')));
    } catch (err: any) {
      console.warn(`[kunii] DO migration: unable to inspect table ${table.name}: ${err?.message || String(err)}`);
      continue;
    }

    for (const col of table.columns) {
      if (existingCols.has(col.name)) continue;
      const { statements, warning } = buildAddColumnSql(table.name, col);
      if (warning) console.warn(warning);
      try {
        for (const statement of statements) sql.exec(statement);
        console.log(`[kunii] DO migration: added column ${table.name}.${col.name}`);
      } catch (err: any) {
        console.warn(`[kunii] DO migration: failed adding column ${table.name}.${col.name}: ${err?.message || String(err)}`);
      }
    }
    // Index creation is handled by buildInitialSql (CREATE INDEX IF NOT EXISTS).
    // No duplicate work needed here.
  }
}

/**
 * Create a SqlExecutor from DO SqlStorage (synchronous .exec() API).
 * SqlStorage.exec(query) returns a Cursor with .toArray().
 */
function sqlStorageExecutor(storage: any): { execute: SqlExecutor } {
  const execute: SqlExecutor = async (sql: string, params?: any[]) => {
    try {
      let cursor;
      if (params?.length) {
        cursor = storage.exec(sql, ...params);
      } else {
        cursor = storage.exec(sql);
      }
      // .exec() returns a Cursor â€” .toArray() gives us rows
      const rows = cursor?.toArray?.() ?? [];
      return { success: true, data: rows, results: rows };
    } catch (error: any) {
      return { success: false, error: explainSqlError(error?.message || String(error)) };
    }
  };
  return { execute };
}

/**
 * Detect whether an object is SqlStorage (DO) vs D1 binding.
 * SqlStorage has .exec() but no .prepare().
 * D1 has .prepare().
 */
function isSqlStorage(obj: any): boolean {
  return typeof obj?.exec === 'function' && typeof obj?.prepare !== 'function';
}

function resolveExecutor(binding: any): { execute: SqlExecutor; fullClient?: FullDbClient } {
  if (isSqlStorage(binding)) {
    return sqlStorageExecutor(binding);
  }
  return d1Executor(binding);
}

// ── Batch (atomic multi-write) ──────────────────────────────
//
// Inside a batch callback, write terminals stage SQL+params instead of
// executing. After the callback resolves, all staged statements commit
// atomically:
//
//   - D1: collect into a single `db.batch([...])` call → one HTTP RTT
//   - DO SqlStorage: replay synchronously inside `ctx.storage.transaction()`
//   - Plain executor (no native batch): run sequentially (best-effort
//     atomicity, useful for testing or custom adapters)
//
// Read terminals are NOT supported inside the callback — run them
// outside, before/after the batch. This matches Drizzle's batch semantics.
type StagedStatement = { sql: string; params: any[] };

/**
 * Build a recording proxy whose chain shape matches `Table<Row>` but
 * whose write terminals push staged statements onto the supplied queue
 * instead of executing immediately. Read terminals throw — they're not
 * meaningful before commit.
 */
function makeBatchTransaction(
  queue: StagedStatement[],
  buildBuilder: (tableName: string) => any
): BatchTransaction {
  // Recording executor: capture (sql, params) onto the queue and return
  // a generic success result so the caller can `await` without breaking.
  const recordingExecute: SqlExecutor = async (sql, params) => {
    queue.push({ sql, params: params ?? [] });
    return { success: true, data: [], results: [] };
  };

  // Wrap a builder with a recording executor by reassigning the private
  // `execute` field. We use a Proxy to keep this surgical and avoid
  // patching read-method bodies that would also mutate state.
  const wrapBuilder = (b: any) =>
    new Proxy(b, {
      get(target, prop: PropertyKey, receiver) {
        const value = Reflect.get(target, prop, receiver);
        const propName = String(prop);
        if (
          propName === 'many' ||
          propName === 'first' ||
          propName === 'one' ||
          propName === 'exists' ||
          propName === 'count' ||
          propName === 'distinct'
        ) {
          return () => {
            throw new Error(
              `'${propName}' is not supported inside batch(). Run reads before or after the batch.`
            );
          };
        }
        return value;
      },
    });

  return new Proxy({} as BatchTransaction, {
    get(_t, prop: PropertyKey) {
      if (typeof prop !== 'string') return undefined;
      const builder = buildBuilder(prop);
      // Replace the executor on this builder instance only.
      builder.execute = recordingExecute;
      return wrapBuilder(builder);
    },
  });
}

/**
 * Commit a queue of staged statements atomically against the underlying
 * binding. Picks the best available transport per backend.
 */
async function commitBatch(
  queue: StagedStatement[],
  binding: any,
  fullClient: FullDbClient | undefined,
  execute: SqlExecutor
): Promise<BatchResult> {
  if (queue.length === 0) {
    return { success: true, results: [] };
  }

  // D1 path: native db.batch([...]) — single HTTP round-trip, atomic.
  if (typeof binding?.batch === 'function' && typeof binding?.prepare === 'function') {
    try {
      const stmts = queue.map((s) => {
        let stmt = binding.prepare(s.sql);
        if (s.params.length) stmt = stmt.bind(...s.params);
        return stmt;
      });
      const raw = await binding.batch(stmts);
      const results: QueryResult<any>[] = (raw as any[]).map((r) => ({
        success: r.success ?? true,
        data: r.results ?? [],
        results: r.results ?? [],
        meta: r.meta,
      }));
      return { success: true, results };
    } catch (error: any) {
      return { success: false, results: [], error: String(error?.message ?? error) };
    }
  }

  // DO SqlStorage path: ctx.storage.transaction wraps the synchronous
  // exec calls so the writes commit atomically. We don't have direct
  // access to ctx.storage here — only the SqlStorage object — but
  // SqlStorage.transactionSync (or the implicit DO request transaction)
  // gives us atomicity in practice.
  if (isSqlStorage(binding)) {
    try {
      const results: QueryResult<any>[] = [];
      // SqlStorage exposes `transactionSync(callback)` for synchronous
      // atomic blocks. Fall back to plain sequential exec if unavailable.
      const runAll = () => {
        for (const s of queue) {
          const cursor = s.params.length
            ? binding.exec(s.sql, ...s.params)
            : binding.exec(s.sql);
          const rows = cursor?.toArray?.() ?? [];
          results.push({ success: true, data: rows, results: rows });
        }
      };
      if (typeof binding.transactionSync === 'function') {
        binding.transactionSync(runAll);
      } else {
        runAll();
      }
      return { success: true, results };
    } catch (error: any) {
      return { success: false, results: [], error: String(error?.message ?? error) };
    }
  }

  // Custom executor path: run sequentially. No atomicity guarantee, but
  // works for adapter configs and tests with a mock executor.
  const results: QueryResult<any>[] = [];
  for (const s of queue) {
    const r = await execute(s.sql, s.params);
    results.push(r);
    if (!r || r.success === false) {
      return {
        success: false,
        results,
        error: (r as any)?.error ?? 'batch statement failed',
      };
    }
  }
  return { success: true, results };
}

/**
 * Create an ORM client.
 *
 * @param binding - A D1 binding, a DO `SqlStorage`, a getter function that
 *                  resolves to a binding lazily, or an executor adapter config.
 * @param schema  - Optional schema. When supplied, the ORM:
 *                    - Filters insert payloads to only schema columns
 *                    - Auto-stringifies whole-object writes to JSON columns
 *                    - Compiles dotted keys against JSON columns to surgical
 *                      `->>` reads and `json_set(...)` writes
 *                    - Parses JSON columns back to objects on reads
 *
 * Without a schema the ORM still works for raw queries — but JSON columns
 * stay opaque (you'd handle stringify/parse yourself), and dotted keys are
 * treated as literal column names.
 */
export function kuniiORM(
  binding: any | (() => any) | OrmAdapterConfig,
  schema?: Pick<DatabaseSchema, 'tables'> | any
): OrmClient {
  const normalizedSchema = schema ? ensureNormalizedSchema(schema) : undefined;

  /**
   * Build the per-binding base ORM (used for `db.tableName...` access
   * AND as the source of `QueryBuilder` instances inside `batch()`).
   * Returns the schema client when a schema was supplied so the user
   * sees JSON parsing + relation registry the same way for both paths.
   */
  const buildBaseClient = (
    execute: SqlExecutor,
    fullClient?: FullDbClient
  ): { tableProxy: Record<string, Table>; getBuilder: (name: string) => any } => {
    if (normalizedSchema) {
      const tableProxy = createSchemaClient(execute, normalizedSchema, {
        client: fullClient,
      });
      // For batch, we want raw QueryBuilder access (no read-side JSON
      // parse wrapper, since we only do writes). Build a sibling
      // runtime ORM with the same schema for that.
      const runtime = createRuntimeOrm(execute, normalizedSchema, fullClient);
      return { tableProxy, getBuilder: (name) => runtime.table(name) };
    }
    const runtime = createRuntimeOrm(execute, undefined, fullClient);
    const tableProxy = new Proxy({} as Record<string, Table>, {
      get(_, prop: PropertyKey) {
        if (typeof prop !== 'string') return undefined;
        return runtime.table(prop);
      },
    });
    return { tableProxy, getBuilder: (name) => runtime.table(name) };
  };

  /**
   * Wrap the table proxy with a top-level `batch` method, producing the
   * full `OrmClient` shape. `batch` is intercepted via Proxy so it
   * never collides with a real table named "batch".
   */
  const wrapWithBatch = (
    base: { tableProxy: Record<string, Table>; getBuilder: (name: string) => any },
    bindingForCommit: any,
    execute: SqlExecutor,
    fullClient?: FullDbClient
  ): OrmClient => {
    const batch = async (callback: BatchCallback): Promise<BatchResult> => {
      const queue: StagedStatement[] = [];
      const tx = makeBatchTransaction(queue, base.getBuilder);
      try {
        await callback(tx);
      } catch (error: any) {
        return {
          success: false,
          results: [],
          error: `batch callback threw: ${String(error?.message ?? error)}`,
        };
      }
      return commitBatch(queue, bindingForCommit, fullClient, execute);
    };

    return new Proxy({} as OrmClient, {
      get(_, prop: PropertyKey) {
        if (prop === 'batch') return batch;
        if (typeof prop !== 'string') return undefined;
        return base.tableProxy[prop];
      },
    }) as OrmClient;
  };

  // Getter function — resolve binding lazily, cache per binding reference.
  if (typeof binding === 'function') {
    let cachedBinding: any;
    let cachedClient: OrmClient | undefined;
    return new Proxy({} as OrmClient, {
      get(_, prop: PropertyKey) {
        const resolved = (binding as () => any)();
        if (resolved !== cachedBinding || !cachedClient) {
          cachedBinding = resolved;
          const { execute, fullClient } = resolveExecutor(resolved);
          const base = buildBaseClient(execute, fullClient);
          cachedClient = wrapWithBatch(base, resolved, execute, fullClient);
        }
        return (cachedClient as any)[prop];
      },
    }) as OrmClient;
  }

  let execute: SqlExecutor;
  let fullClient: FullDbClient | undefined;
  let bindingForCommit: any = binding;

  // D1 binding (has .prepare()) or SqlStorage (has .exec()).
  if (typeof binding?.prepare === 'function' || isSqlStorage(binding)) {
    const resolved = resolveExecutor(binding);
    execute = resolved.execute;
    fullClient = resolved.fullClient;
  } else {
    // Adapter config (executor-only — for custom use cases).
    const config = binding as OrmAdapterConfig;
    if (config.adapter === 'executor') {
      execute = config.execute;
      fullClient = config.client;
      bindingForCommit = null; // no native batch path
    } else {
      throw new Error(`Unknown adapter: ${(config as any).adapter}`);
    }
  }

  const base = buildBaseClient(execute, fullClient);
  return wrapWithBatch(base, bindingForCommit, execute, fullClient);
}

export const kunii = kuniiORM;

/** @deprecated Use `kunii` or `kuniiORM` instead. */
export const kuratchiORM = kuniiORM;



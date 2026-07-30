/**
 * Migration Runner â€” runtime migration execution with history tracking and schema diffing.
 *
 * Tracks applied migrations in a `_kuratchi_migrations` table.
 * Supports initial creation, incremental schema diffs (ADD/DROP COLUMN, indexes),
 * and idempotent re-runs.
 */

import type { SqlExecutor, QueryResult, FullDbClient } from '../types.js';
import type { DatabaseSchema } from '../schema.js';
import type { SchemaDsl } from '../types.js';
import { ensureNormalizedSchema } from '../schema.js';
import { buildInitialSql } from './generator.js';
import { diffSchemas } from './generator.js';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface MigrateOptions {
  /** SQL executor — how to run queries against the database */
  execute: SqlExecutor;
  /** Schema to migrate to (SchemaDsl or DatabaseSchema) */
  schema: DatabaseSchema | SchemaDsl;
  /** Schema name — used as the migration tag prefix */
  schemaName?: string;
  /** Full D1 client — enables batch execution for migrations and introspection */
  client?: FullDbClient;
}

export interface MigrateResult {
  /** Whether migrations were applied */
  applied: boolean;
  /** Number of statements executed */
  statementsRun: number;
  /** Number of tables in the schema */
  tableCount: number;
  /** Warnings from schema diffing (e.g., unsafe operations) */
  warnings: string[];
  /** Whether this was the initial migration (no prior history) */
  isInitial: boolean;
}

// â”€â”€ Internal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MIGRATIONS_TABLE = '_kuratchi_migrations';

function getBatchResultRows(result: any): any[][] {
  if (Array.isArray(result)) {
    return result.map((entry) => entry?.results ?? entry?.data ?? []);
  }
  return result?.results ?? result?.data ?? [];
}

function getBatchResultFailure(result: any): string | null {
  if (Array.isArray(result)) {
    const failed = result.find((entry) => entry && entry.success === false);
    return failed ? String(failed.error ?? 'unknown batch statement error') : null;
  }
  return result?.success === false ? String(result.error ?? 'unknown batch error') : null;
}

async function ensureMigrationsTable(execute: SqlExecutor): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      schema_hash TEXT NOT NULL,
      statements_run INTEGER NOT NULL DEFAULT 0,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(schema_name, version)
    )`
  );
}

function hashSchema(schema: DatabaseSchema): string {
  // Deterministic hash of the schema structure for change detection
  const str = JSON.stringify(schema.tables.map(t => ({
    name: t.name,
    columns: t.columns.map(c => ({ name: c.name, type: c.type, notNull: c.notNull, primaryKey: c.primaryKey, unique: c.unique, default: c.default, references: c.references, enum: c.enum })),
    indexes: t.indexes,
    checks: t.checks,
  })));
  // Simple FNV-1a hash â€” no crypto needed, just change detection
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function getLatestMigration(
  execute: SqlExecutor,
  schemaName: string
): Promise<{ version: number; schema_hash: string } | null> {
  const result = await execute(
    `SELECT version, schema_hash FROM ${MIGRATIONS_TABLE} WHERE schema_name = ? ORDER BY version DESC LIMIT 1`,
    [schemaName]
  );
  if (!result || result.success === false) return null;
  const rows = (result as any).data ?? (result as any).results ?? [];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

async function recordMigration(
  execute: SqlExecutor,
  schemaName: string,
  version: number,
  schemaHash: string,
  statementsRun: number
): Promise<void> {
  await execute(
    `INSERT INTO ${MIGRATIONS_TABLE} (schema_name, version, schema_hash, statements_run) VALUES (?, ?, ?, ?)`,
    [schemaName, version, schemaHash, statementsRun]
  );
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// ── Introspect current DB schema ──────────────────────────────

function parseIntrospectedCol(c: any): any {
  const col: any = {
    name: c.name,
    type: (c.type || 'text').toLowerCase().includes('int') ? 'integer'
        : (c.type || 'text').toLowerCase().includes('real') ? 'real'
        : (c.type || 'text').toLowerCase().includes('blob') ? 'blob'
        : 'text',
  };
  if (c.notnull) col.notNull = true;
  if (c.pk) col.primaryKey = true;
  return col;
}

async function introspectSchema(
  execute: SqlExecutor,
  schemaName: string,
  client?: FullDbClient
): Promise<DatabaseSchema | null> {
  const tablesResult = await execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != ?",
    [MIGRATIONS_TABLE]
  );
  if (!tablesResult || tablesResult.success === false) return null;
  const tableNames: string[] = ((tablesResult as any).data ?? (tablesResult as any).results ?? []).map((r: any) => r.name);
  if (tableNames.length === 0) return null;

  if (client?.batch && client.prepare) {
    // Batch 1: interleaved PRAGMA table_info + PRAGMA index_list for every table.
    // results[i*2]     = table_info rows for tableNames[i]
    // results[i*2 + 1] = index_list rows for tableNames[i]
    const pragmaBatch = tableNames.flatMap(t => [
      client.prepare!(`PRAGMA table_info(${t})`),
      client.prepare!(`PRAGMA index_list(${t})`),
    ]);
    const pragmaResult = await client.batch(pragmaBatch);
    const pragmaFailure = getBatchResultFailure(pragmaResult);
    if (pragmaFailure) {
      throw new Error(`Schema introspection batch failed: ${pragmaFailure}`);
    }
    const pragmaRows: any[][] = getBatchResultRows(pragmaResult);

    // Collect index metadata in order so we can correlate index_info results.
    type IndexMeta = { name: string; unique: boolean; tableIdx: number };
    const indexMeta: IndexMeta[] = [];
    for (let i = 0; i < tableNames.length; i++) {
      const rawIdxs: any[] = pragmaRows[i * 2 + 1] ?? [];
      for (const idx of rawIdxs) {
        if (!String(idx.name).startsWith('sqlite_')) {
          indexMeta.push({ name: idx.name, unique: !!idx.unique, tableIdx: i });
        }
      }
    }

    // Batch 2: PRAGMA index_info for every index collected above.
    let indexInfoRows: any[][] = [];
    if (indexMeta.length > 0) {
      const indexInfoResult = await client.batch(indexMeta.map(m => client.prepare!(`PRAGMA index_info(${m.name})`)));
      const indexInfoFailure = getBatchResultFailure(indexInfoResult);
      if (indexInfoFailure) {
        throw new Error(`Index introspection batch failed: ${indexInfoFailure}`);
      }
      indexInfoRows = getBatchResultRows(indexInfoResult);
    }

    // Build per-table index lists keyed by table array index.
    const tableIndexMap = new Map<number, { name: string; columns: string[]; unique: boolean }[]>();
    for (let j = 0; j < indexMeta.length; j++) {
      const { tableIdx, name, unique } = indexMeta[j];
      const cols = (indexInfoRows[j] ?? []).map((r: any) => r.name);
      if (!tableIndexMap.has(tableIdx)) tableIndexMap.set(tableIdx, []);
      tableIndexMap.get(tableIdx)!.push({ name, columns: cols, unique });
    }

    const tables: DatabaseSchema['tables'] = [];
    for (let i = 0; i < tableNames.length; i++) {
      const columns = (pragmaRows[i * 2] ?? []).map(parseIntrospectedCol);
      const indexes = tableIndexMap.get(i);
      tables.push({ name: tableNames[i], columns, indexes: indexes?.length ? indexes : undefined });
    }
    return { name: schemaName, tables };
  }

  // Sequential fallback (no batch support)
  const tables: DatabaseSchema['tables'] = [];
  for (const tableName of tableNames) {
    const colsResult = await execute(`PRAGMA table_info(${tableName})`);
    if (!colsResult || colsResult.success === false) continue;
    const columns = ((colsResult as any).data ?? (colsResult as any).results ?? []).map(parseIntrospectedCol);

    const idxResult = await execute(`PRAGMA index_list(${tableName})`);
    const rawIdxs = (idxResult as any)?.data ?? (idxResult as any)?.results ?? [];
    const indexes: any[] = [];
    for (const idx of rawIdxs) {
      if (idx.name.startsWith('sqlite_')) continue;
      const idxInfoResult = await execute(`PRAGMA index_info(${idx.name})`);
      const idxCols = ((idxInfoResult as any)?.data ?? (idxInfoResult as any)?.results ?? []).map((r: any) => r.name);
      indexes.push({ name: idx.name, columns: idxCols, unique: !!idx.unique });
    }
    tables.push({ name: tableName, columns, indexes: indexes.length > 0 ? indexes : undefined });
  }
  return { name: schemaName, tables };
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Run migrations for a schema against a database.
 *
 * - First run: generates full `CREATE TABLE IF NOT EXISTS` statements
 * - Subsequent runs: diffs current DB schema against target, generates `ALTER TABLE` statements
 * - Idempotent: skips if schema hash hasn't changed
 *
 * @example Runtime (inside a Worker)
 * ```ts
 * import { runMigrations } from '@kuratchi/kunii/migrations';
 * import { todoSchema } from './schemas/todo';
 *
 * await runMigrations({
 *   execute: (sql, params) => env.DB.prepare(sql).bind(...(params || [])).all(),
 *   schema: todoSchema,
 * });
 * ```
 */
export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const { execute, schema: rawSchema, client } = options;
  const targetSchema = ensureNormalizedSchema(rawSchema);
  const schemaName = options.schemaName ?? targetSchema.name;
  const targetHash = hashSchema(targetSchema);

  await ensureMigrationsTable(execute);

  const latest = await getLatestMigration(execute, schemaName);

  if (latest && latest.schema_hash === targetHash) {
    return { applied: false, statementsRun: 0, tableCount: targetSchema.tables.length, warnings: [], isInitial: false };
  }

  let sql: string;
  let warnings: string[] = [];
  let isInitial = !latest;

  if (!latest) {
    sql = buildInitialSql(targetSchema);
  } else {
    const currentSchema = await introspectSchema(execute, schemaName, client);
    if (currentSchema) {
      const diff = diffSchemas(currentSchema, targetSchema);
      sql = diff.statements.join('\n');
      warnings = diff.warnings;
      if (!sql.trim()) {
        const version = (latest.version ?? 0) + 1;
        await recordMigration(execute, schemaName, version, targetHash, 0);
        return { applied: true, statementsRun: 0, tableCount: targetSchema.tables.length, warnings, isInitial: false };
      }
    } else {
      sql = buildInitialSql(targetSchema);
      isInitial = true;
    }
  }

  const statements = splitStatements(sql);

  // Use batch when available — reduces N sequential D1 round-trips to 1.
  if (client?.batch && client.prepare && statements.length > 0) {
    const batchStatements = statements.map((statement) => client.prepare!(statement));
    const batchResult = await client.batch(batchStatements);
    const batchFailure = getBatchResultFailure(batchResult);
    if (batchFailure) {
      throw new Error(`Migration batch failed: ${batchFailure}`);
    }
  } else {
    for (const stmt of statements) {
      const result = await execute(stmt);
      if (result && result.success === false) {
        throw new Error(`Migration failed: ${result.error}\nStatement: ${stmt}`);
      }
    }
  }

  const version = (latest?.version ?? 0) + 1;
  await recordMigration(execute, schemaName, version, targetHash, statements.length);

  return { applied: true, statementsRun: statements.length, tableCount: targetSchema.tables.length, warnings, isInitial };
}

/**
 * Check if there are pending migrations (schema has changed since last apply).
 */
export async function hasPendingMigrations(options: MigrateOptions): Promise<boolean> {
  const { execute, schema: rawSchema } = options;
  const targetSchema = ensureNormalizedSchema(rawSchema);
  const schemaName = options.schemaName ?? targetSchema.name;
  const targetHash = hashSchema(targetSchema);

  try {
    await ensureMigrationsTable(execute);
    const latest = await getLatestMigration(execute, schemaName);
    if (!latest) return true;
    return latest.schema_hash !== targetHash;
  } catch {
    return true;
  }
}




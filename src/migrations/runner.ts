/** Runtime migrations for D1 and SQLite. */
import type { SchemaDsl } from '../types.js';
import type { Column, DatabaseSchema, Index, Table } from '../schema.js';
import { ensureNormalizedSchema } from '../schema.js';
import { addedColumnDefinition, diffSchemas, q, sameIndexDefinition, renderColumnDef, renderCreateVirtualTableSql } from './generator.js';
import { matchesTableDefinition, sameSql, sqlTokens, tableClauses } from './definitions.js';
import { runAsync, runSync, type MigrationSteps, type MigrationExecutor, type MigrationClient } from './execution.js';
import { planColumnRenames } from './renames.js';
import { planTableRebuilds } from './rebuilds.js';
export interface MigrateOptions {
  /** SQL executor — how to run queries against the database */
  execute: MigrationExecutor;
  /** Schema to migrate to (SchemaDsl or DatabaseSchema) */
  schema: DatabaseSchema | SchemaDsl;
  /** Schema name — used as the migration tag prefix */
  schemaName?: string;
  /** Full D1 client — enables batch execution for migrations and introspection */
  client?: MigrationClient;
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

const MIGRATIONS_TABLE = '_kuratchi_migrations';
const INSERT_HISTORY = `INSERT INTO ${MIGRATIONS_TABLE}
  (schema_name, version, schema_hash, statements_run, schema_json) VALUES (?, ?, ?, ?, ?)`;

type Migration = { version: number; schema_hash: string; schema_json: string | null };
type OwnedIndex = { table: string; index: Index };
type Snapshot = DatabaseSchema & { ownedIndexes?: OwnedIndex[]; unresolved?: boolean; format?: number; requested?: string };

function inspectedColumn(row: any): Column {
  const type = String(row.type).toLowerCase();
  const column: Column = {
    name: row.name,
    type: type === 'integer' ? 'integer' : type === 'real' ? 'real' : type === 'blob' ? 'blob' : 'text',
  };
  if (row.notnull) column.notNull = true;
  if (row.pk) column.primaryKey = true;
  if (row.dflt_value != null) {
    const value = String(row.dflt_value);
    if (value.startsWith("'") && value.endsWith("'")) column.default = { kind: 'value', value: value.slice(1, -1).replace(/''/g, "'") };
    else if (/^null$/i.test(value)) column.default = { kind: 'value', value: null };
    else if (/^-?\d+(\.\d+)?$/.test(value)) column.default = { kind: 'value', value: Number(value) };
    else column.default = { kind: 'raw', sql: value };
  }
  return column;
}

function* query<T>(execute: MigrationExecutor, sql: string, params?: unknown[]): MigrationSteps<T[]> {
  const result = yield execute(sql, params);
  if (!result || result.success === false) {
    throw new Error(`Migration SQL failed: ${result?.error ?? 'no result'}\nStatement: ${sql}`);
  }
  return result.data ?? result.results ?? [];
}

function* ensureMigrationsTable(execute: MigrationExecutor): MigrationSteps<void> {
  yield* query(execute, `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    schema_hash TEXT NOT NULL,
    statements_run INTEGER NOT NULL DEFAULT 0,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    schema_json TEXT,
    UNIQUE(schema_name, version)
  )`);

  const columns = () => query<{ name: string }>(execute, `PRAGMA table_info(${MIGRATIONS_TABLE})`);
  if ((yield* columns()).some(column => column.name === 'schema_json')) return;

  try {
    yield* query(execute, `ALTER TABLE ${MIGRATIONS_TABLE} ADD COLUMN schema_json TEXT`);
  } catch (error) {
    // Another isolate may have upgraded the history table since our read.
    if (!(yield* columns()).some(column => column.name === 'schema_json')) throw error;
  }
}
function hashSchema(schema: DatabaseSchema): string {
  // Deterministic hash of the schema structure for change detection
  const str = JSON.stringify({
    tables: schema.tables.map(t => ({
      name: t.name,
      columns: t.columns.map(c => ({ name: c.name, type: c.type, notNull: c.notNull, primaryKey: c.primaryKey, unique: c.unique, default: c.default, references: c.references, enum: c.enum, renameFrom: c.renameFrom })),
      indexes: t.indexes,
      checks: t.checks,
    })),
    virtualTables: schema.virtualTables ?? [],
  });
  // Simple FNV-1a hash â€” no crypto needed, just change detection
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function* getLatestMigration(execute: MigrationExecutor, schemaName: string): MigrationSteps<Migration | undefined> {
  const [latest] = yield* query<Migration>(execute,
    `SELECT version, schema_hash, schema_json FROM ${MIGRATIONS_TABLE}
     WHERE schema_name = ? ORDER BY version DESC LIMIT 1`, [schemaName]);
  return latest;
}

function batchError(results: unknown): void {
  const failed = (Array.isArray(results) ? results : [results]).find(result => result?.success === false);
  if (failed) throw new Error(`Migration batch failed: ${failed.error ?? 'unknown batch error'}`);
}

function* readSchema(execute: MigrationExecutor, target: DatabaseSchema, previous: DatabaseSchema | undefined, client?: MigrationClient): MigrationSteps<DatabaseSchema & { unverifiedTables: string[] }> {
  const tableNames = target.tables.map(table => table.name);
  const virtualNames = (target.virtualTables ?? []).map(table => table.name);
  const indexNames = target.tables.flatMap(table => (table.indexes ?? []).map(index => index.name));
  const objects = yield* query<{ name: string; type: string; tbl_name: string; sql: string }>(execute,
    `SELECT name, type, tbl_name, sql FROM sqlite_master
     WHERE name COLLATE NOCASE IN (SELECT value FROM json_each(?))`,
    [JSON.stringify([...tableNames, ...virtualNames, ...indexNames])]);
  const byName = new Map(objects.map(object => [object.name.toLowerCase(), object]));
  for (const table of target.tables) {
    for (const index of table.indexes ?? []) {
      const existing = byName.get(index.name.toLowerCase());
      if (existing && (existing.type !== 'index' || existing.tbl_name.toLowerCase() !== table.name.toLowerCase())) {
        throw new Error(`Index ${q(index.name)} conflicts with an existing database object.`);
      }
    }
  }

  const existingTables = target.tables.filter(table => byName.get(table.name.toLowerCase())?.type === 'table');
  const reads = existingTables.flatMap(table => [
    `PRAGMA table_xinfo(${q(table.name)})`,
    `SELECT l.name AS index_name, l."unique" AS is_unique, l.partial, i.name AS column_name,
            i."desc" AS descending, i.coll AS collation
     FROM pragma_index_list('${table.name.replace(/'/g, "''")}') AS l
     JOIN pragma_index_xinfo(l.name) AS i
     WHERE l.origin = 'c' AND i."key" = 1 ORDER BY l.name, i.seqno`,
  ]);
  let rows: any[][];
  if (client?.batch && client.prepare && reads.length) {
    const result = yield client.batch(reads.map(sql => client.prepare!(sql)));
    batchError(result);
    rows = (result as unknown as { data?: any[]; results?: any[] }[]).map(entry => entry.results ?? entry.data ?? []);
  } else {
    rows = [];
    for (const sql of reads) rows.push(yield* query(execute, sql));
  }

  const unverifiedTables: string[] = [];
  const tables: Table[] = existingTables.map((table, i) => {
    const prior = previous?.tables.find(candidate => candidate.name === table.name);
    const definition = byName.get(table.name.toLowerCase())!.sql;
    const clauses = tableClauses(definition);
    const columns = rows[2 * i].map((row: any) => {
      const clause = clauses.find(candidate => candidate[0] === row.name.toUpperCase());
      const known = prior?.columns.find(column => column.name === row.name);
      const desired = table.columns.find(column => column.name.toLowerCase() === row.name.toLowerCase());
      const verified = [known, desired].find(column => column && clause && sameSql(clause, sqlTokens(renderColumnDef(column))));
      return verified ? { ...verified, name: row.name } : inspectedColumn(row);
    });
    const indexes = new Map<string, Index>();
    for (const row of rows[2 * i + 1]) {
      const desired = table.indexes?.find(index => index.name.toLowerCase() === row.index_name.toLowerCase());
      const name = desired?.name ?? row.index_name;
      const index: Index = indexes.get(name) ?? { name, unique: !!row.is_unique, columns: [] };
      const desiredColumn = desired?.columns.find(column => column.toLowerCase() === row.column_name?.toLowerCase());
      const simple = !row.partial && !row.descending && row.collation === 'BINARY' && row.column_name != null;
      index.columns.push(simple ? desiredColumn ?? row.column_name : '');
      indexes.set(name, index);
    }
    const observed = { name: table.name, columns, indexes: [...indexes.values()], checks: prior?.checks };
    if (!matchesTableDefinition(definition, observed)) {
      const withDesiredChecks = { ...observed, checks: table.checks };
      if (matchesTableDefinition(definition, withDesiredChecks)) observed.checks = table.checks;
      else unverifiedTables.push(table.name);
    }
    return observed;
  });
  for (const table of previous?.tables ?? []) {
    if (!tableNames.includes(table.name)) tables.push(table);
  }
  const virtualTables = (target.virtualTables ?? [])
    .filter(table => byName.get(table.name.toLowerCase())?.type === 'table')
    .map(table => {
      const definition = byName.get(table.name.toLowerCase())!.sql;
      const tokens = (sql: string) => sqlTokens(sql.replace(/^CREATE VIRTUAL TABLE IF NOT EXISTS /i, 'CREATE VIRTUAL TABLE ').replace(/;\s*$/, ''));
      const prior = previous?.virtualTables?.find(candidate => candidate.name === table.name);
      const verified = [prior, table].find(candidate => candidate && sameSql(tokens(definition), tokens(renderCreateVirtualTableSql(candidate))));
      if (!verified) unverifiedTables.push(table.name);
      return verified ?? table;
    });
  return { name: target.name, tables, virtualTables, unverifiedTables };
}

function isOlder(target: DatabaseSchema, previous?: DatabaseSchema): boolean {
  return target.version !== undefined && previous?.version !== undefined && target.version < previous.version;
}

/** Apply safe runtime changes. Pass the native D1 client for atomic execution. */
function* migrationSteps(options: MigrateOptions): MigrationSteps<MigrateResult> {
  const { execute, client } = options;
  const target = ensureNormalizedSchema(options.schema);
  if (target.version !== undefined && (!Number.isSafeInteger(target.version) || target.version < 1)) {
    throw new Error('Schema version must be a positive integer');
  }
  const schemaName = options.schemaName ?? target.name;
  const hash = hashSchema(target);
  const requested = JSON.stringify(target);
  yield* ensureMigrationsTable(execute);

  for (let attempt = 0; ; attempt++) {
    const latest = yield* getLatestMigration(execute, schemaName);
    const previous = latest?.schema_json ? JSON.parse(latest.schema_json) as Snapshot : undefined;
    const result: MigrateResult = {
      applied: false, statementsRun: 0, tableCount: target.tables.length, warnings: [], isInitial: !latest,
    };
    if (isOlder(target, previous)) {
      result.warnings.push(`Schema version ${target.version} is older than applied version ${previous?.version}; migration skipped.`);
    } else if (previous?.version !== undefined && target.version === undefined) {
      throw new Error('A versioned database requires a versioned schema');
    } else if (previous && previous.version === target.version && target.version !== undefined &&
      (previous.requested !== undefined ? previous.requested !== requested : latest?.schema_hash !== hash)) {
      throw new Error(`Schema version ${target.version} is immutable; increment the version for schema changes`);
    } else if (latest?.schema_hash === hash && previous?.format === 2 && !previous.unresolved &&
      (target.version ?? -Infinity) <= (previous.version ?? -Infinity)) {
      return result;
    } else {
      const observed = yield* readSchema(execute, target, previous, client);
      const renames = planColumnRenames(observed, target);
      if (renames.statements.length && !(client?.batch && client.prepare && target.version !== undefined &&
        (previous?.version === undefined || target.version > previous.version))) {
        throw new Error('Column renames require a newer schema version and an atomic batch client');
      }
      const current = renames.schema;
      const forward = client?.batch && client.prepare && previous?.version !== undefined &&
        target.version !== undefined && (target.version > previous.version ||
          (target.version === previous.version && previous.unresolved));
      const rebuilds = forward ? yield* planTableRebuilds(execute, current, target, previous) : [];
      const ownedBefore = previous?.ownedIndexes?.map(entry => {
        const desired = target.tables.find(table => table.name === entry.table);
        const live = observed.tables.find(table => table.name === entry.table);
        return {
          ...entry,
          index: {
            ...entry.index,
            columns: entry.index.columns.map(name => {
              const renamed = desired?.columns.find(column => column.renameFrom?.toLowerCase() === name.toLowerCase());
              return renamed && live?.columns.some(column => column.name.toLowerCase() === name.toLowerCase()) ? renamed.name : name;
            }),
          },
        };
      });
      const owns = (table: Table, index: Index) => ownedBefore?.some(entry =>
        entry.table === table.name && entry.index.name === index.name && sameIndexDefinition(entry.index, index));
      const canReplaceIndex = (table: Table, index: Index) =>
        !!(client?.batch && client.prepare && previous?.version !== undefined &&
          target.version !== undefined && target.version > previous.version && owns(table, index));
      const plan = diffSchemas(current, target, { additiveOnly: true, canReplaceIndex });
      plan.statements.unshift(...renames.statements, ...rebuilds);
      result.warnings = plan.warnings;
      if (renames.statements.length) {
        result.warnings.push('Physical column rename applied by this plan: application code using the old name must be updated.');
      }
      for (const name of observed.unverifiedTables) {
        plan.unresolved = true;
        result.warnings.push(`Live constraints for ${q(name)} could not be fully verified; migration remains pending.`);
      }
      if (!plan.statements.length && latest && !previous && latest.schema_hash !== hash) {
        result.warnings.push('Existing column definitions could not be verified against legacy migration history.');
      }
      for (const warning of result.warnings) console.warn(`[kunii/${schemaName}] ${warning}`);
      if (!plan.statements.length && result.warnings.length) return result;

      const ownedIndexes: OwnedIndex[] = [];
      for (const table of target.tables) {
        const live = current.tables.find(existing => existing.name === table.name);
        for (const index of table.indexes ?? []) {
          const existing = live?.indexes?.find(candidate => candidate.name === index.name);
          if (!existing || canReplaceIndex(table, existing)) ownedIndexes.push({ table: table.name, index });
          else if (owns(table, existing)) ownedIndexes.push({ table: table.name, index: existing });
        }
      }
      const snapshot: Snapshot = {
        ...target,
        version: target.version ?? previous?.version,
        ownedIndexes,
        format: 2,
        requested,
        unresolved: plan.unresolved,
        tables: target.tables.map(table => {
          const existing = current.tables.find(candidate => candidate.name === table.name);
          if (!existing) return table;
          return {
            ...table,
            columns: [
              ...existing.columns,
              ...table.columns.filter(column => !existing.columns.some(candidate => candidate.name === column.name)).map(addedColumnDefinition),
            ],
            indexes: [
              ...(existing.indexes ?? []).map(index => {
                const desired = table.indexes?.find(candidate => candidate.name === index.name);
                return desired && canReplaceIndex(table, index) ? desired : index;
              }),
              ...(table.indexes ?? []).filter(index => !existing.indexes?.some(candidate => candidate.name === index.name)),
            ],
            checks: existing.checks,
          };
        }),
        virtualTables: target.virtualTables?.map(table => current.virtualTables?.find(existing => existing.name === table.name) ?? table),
      };
      const params = [schemaName, (latest?.version ?? 0) + 1, hash, plan.statements.length, JSON.stringify(snapshot)];
      if (client?.batch && client.prepare) {
        try {
          // The unique history version makes stale plans fail within the same transaction as their DDL.
          const history = client.prepare(INSERT_HISTORY).bind(...params);
          const statements = plan.statements.map(sql => client.prepare!(sql));
          batchError(yield client.batch([history, ...statements]));
        } catch (error) {
          const winner = yield* getLatestMigration(execute, schemaName);
          if (winner && winner.version !== latest?.version && attempt < 3) continue;
          throw error;
        }
      } else {
        for (const sql of plan.statements) yield* query(execute, sql);
        yield* query(execute, INSERT_HISTORY, params);
      }
      return { ...result, applied: plan.statements.length > 0, statementsRun: plan.statements.length };
    }

    for (const warning of result.warnings) console.warn(`[kunii/${schemaName}] ${warning}`);
    return result;
  }
}

/** Check whether this schema has changes newer than the recorded migration. */
function* pendingSteps(options: MigrateOptions): MigrationSteps<boolean> {
  const target = ensureNormalizedSchema(options.schema);
  try {
    yield* ensureMigrationsTable(options.execute);
    const latest = yield* getLatestMigration(options.execute, options.schemaName ?? target.name);
    const previous = latest?.schema_json ? JSON.parse(latest.schema_json) as Snapshot : undefined;
    return !isOlder(target, previous) && (latest?.schema_hash !== hashSchema(target) ||
      (previous?.requested !== undefined && previous.requested !== JSON.stringify(target)) ||
      previous?.unresolved === true || previous?.format !== 2 ||
      (previous !== undefined && (target.version ?? -Infinity) > (previous.version ?? -Infinity)));
  } catch {
    return true;
  }
}

/** Run the shared migration engine with an asynchronous SQL executor. */
export function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  return runAsync(migrationSteps(options));
}

export function hasPendingMigrations(options: MigrateOptions): Promise<boolean> {
  return runAsync(pendingSteps(options));
}

/** Run the same engine synchronously inside Durable Object transactionSync. */
export function runMigrationsSync(options: MigrateOptions): MigrateResult {
  return runSync(migrationSteps(options));
}

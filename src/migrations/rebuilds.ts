import type { DatabaseSchema, Table } from '../schema.js';
import type { MigrationExecutor, MigrationSteps } from './execution.js';
import { q, renderColumnDef, renderCreateTableSql } from './generator.js';
import { matchesTableDefinition, sqlTokens } from './definitions.js';

function* rows(execute: MigrationExecutor, sql: string, params?: unknown[]): MigrationSteps<any[]> {
  const result = yield execute(sql, params);
  if (!result || result.success === false) throw new Error(result?.error ?? 'Schema inspection failed');
  return result.data ?? result.results ?? [];
}

/** Rebuild fully understood tables whose incoming dependencies permit an atomic swap. */
export function* planTableRebuilds(
  execute: MigrationExecutor,
  current: DatabaseSchema,
  target: DatabaseSchema,
  previous: DatabaseSchema | undefined,
): MigrationSteps<string[]> {
  const statements: string[] = [];
  let dependencies: { parents: Set<string>; viewTokens: Set<string> } | undefined;
  for (const desired of target.tables) {
    const live = current.tables.find(table => table.name === desired.name);
    const prior = previous?.tables.find(table => table.name === desired.name);
    if (!live || !prior) continue;
    const changed = desired.columns.some(column => {
      const existing = live.columns.find(candidate => candidate.name === column.name);
      return existing ? renderColumnDef(existing) !== renderColumnDef(column) :
        !!(column.default?.kind === 'raw' || column.unique || column.primaryKey || column.references ||
          column.enum?.length || (column.notNull && (!column.default || column.default.kind !== 'value' || column.default.value === null)));
    }) || JSON.stringify(live.checks ?? []) !== JSON.stringify(desired.checks ?? []);
    if (!changed) continue;

    const fail = (reason: string): never => {
      throw new Error(`Cannot automatically rebuild ${q(desired.name)}: ${reason}`);
    };
    if (live.columns.some(column => !desired.columns.some(candidate => candidate.name === column.name))) {
      fail('the table contains omitted columns that must be preserved');
    }
    for (const column of desired.columns) {
      const existing = live.columns.find(candidate => candidate.name === column.name);
      if (existing && (existing.type !== column.type || !!existing.primaryKey !== !!column.primaryKey)) {
        fail('type and primary-key transformations require a data transformation policy');
      }
    }
    const [definition] = yield* rows(execute, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [desired.name]);
    if (!definition || !matchesTableDefinition(definition.sql, live)) {
      fail('the live definition differs from the recorded schema');
    }
    if (!dependencies) {
      const tables = yield* rows(execute,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(lower(name), 1, 4) != '_cf_' AND substr(lower(name), 1, 7) != 'sqlite_'");
      const incoming = yield* rows(execute,
        `SELECT f."table" AS parent FROM json_each(?) AS m JOIN pragma_foreign_key_list(m.value) AS f`,
        [JSON.stringify(tables.map(table => table.name))]);
      const views = yield* rows(execute, "SELECT sql FROM sqlite_master WHERE type = 'view'");
      const plannedParents = target.tables.flatMap(table => table.columns.flatMap(column =>
        column.references ? [column.references.table.toLowerCase()] : []));
      dependencies = {
        parents: new Set([...incoming.map(row => row.parent.toLowerCase()), ...plannedParents]),
        viewTokens: new Set(views.flatMap(view => sqlTokens(view.sql))),
      };
    }
    if (dependencies.parents.has(desired.name.toLowerCase())) fail('incoming foreign keys need a coordinated dependency rebuild');
    if (dependencies.viewTokens.has(desired.name.toUpperCase())) fail('view dependencies need a coordinated dependency rebuild');
    const dependents = yield* rows(execute,
      "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      [desired.name]);
    const temporary = `_kunii_rebuild_${desired.name}`;
    if ((yield* rows(execute, 'SELECT name FROM sqlite_master WHERE name = ? COLLATE NOCASE', [temporary])).length) {
      fail('the replacement table name is already in use');
    }
    const replacement: Table = { ...desired, name: temporary };
    const copied = live.columns.map(column => column.name);
    if (!live.columns.some(column => column.primaryKey && column.type === 'integer')) {
      if ([...live.columns, ...desired.columns].some(column => ['rowid', '_rowid_', 'oid'].includes(column.name.toLowerCase()))) {
        fail('a column shadows the row identifier');
      }
      copied.unshift('rowid');
    }
    const names = copied.map(q).join(', ');
    statements.push(
      renderCreateTableSql(replacement).replace('IF NOT EXISTS ', '') + ';',
      `INSERT INTO ${q(temporary)} (${names}) SELECT ${names} FROM ${q(desired.name)};`,
      `DROP TABLE ${q(desired.name)};`,
      `ALTER TABLE ${q(temporary)} RENAME TO ${q(desired.name)};`,
      ...dependents.map(row => row.sql),
    );
    // Reflect the effective schema for the subsequent column/index diff and snapshot.
    live.columns = structuredClone(desired.columns);
    live.checks = desired.checks;
  }
  return statements;
}

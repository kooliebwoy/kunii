/**
 * SQL Generation and Schema Diffing
 */

import type { Column, DatabaseSchema, Index, Table, VirtualTable } from '../schema.js';

// === SQL Generation ===

function q(str: string): string {
  return `"${str.replace(/"/g, '""')}"`;
}

function sqlType(col: Column): string {
  switch (col.type) {
    case 'text': return 'TEXT';
    case 'integer': return 'INTEGER';
    case 'real': return 'REAL';
    case 'blob': return 'BLOB';
    case 'json': return 'TEXT';
    default: return 'TEXT';
  }
}

function defaultSql(d?: Column['default']): string | undefined {
  if (!d) return undefined;
  if (d.kind === 'raw') return `DEFAULT ${d.sql}`;
  const v = d.value;
  if (v === null) return 'DEFAULT NULL';
  if (typeof v === 'number') return `DEFAULT ${v}`;
  if (typeof v === 'boolean') return `DEFAULT ${v ? 1 : 0}`;
  const escaped = String(v).replace(/'/g, "''");
  return `DEFAULT '${escaped}'`;
}

function enumCheck(col: Column): string | undefined {
  if (!col.enum || !col.enum.length) return undefined;
  const values = col.enum.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
  return `CHECK (${q(col.name)} IN (${values}))`;
}

function columnDef(col: Column): string {
  const parts: string[] = [q(col.name), sqlType(col)];
  if (col.notNull) parts.push('NOT NULL');
  if (col.unique) parts.push('UNIQUE');
  if (col.primaryKey) parts.push('PRIMARY KEY');
  const dsql = defaultSql(col.default);
  if (dsql) parts.push(dsql);
  if (col.references) {
    const ref = col.references;
    let r = `REFERENCES ${q(ref.table)}(${q(ref.column)})`;
    if (ref.onDelete) r += ` ON DELETE ${ref.onDelete.toUpperCase()}`;
    parts.push(r);
  }
  const chk = enumCheck(col);
  if (chk) parts.push(chk);
  return parts.join(' ');
}

function createTableSql(t: Table): string {
  const lines: string[] = t.columns.map((c) => `  ${columnDef(c)}`);
  if (t.checks && t.checks.length) {
    for (const c of t.checks) lines.push(`  CHECK (${c})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${q(t.name)} (\n${lines.join(',\n')}\n)`;
}

function createIndexSql(table: Table, idx: Index): string {
  const cols = idx.columns.map((c) => q(c)).join(', ');
  const uniq = idx.unique ? 'UNIQUE ' : '';
  return `CREATE ${uniq}INDEX IF NOT EXISTS ${q(idx.name)} ON ${q(table.name)}(${cols})`;
}

function createVirtualTableSql(table: VirtualTable): string {
  if (table.module !== 'fts5') throw new Error(`Unsupported SQLite virtual table module: ${table.module}`);
  if (table.columns.length === 0) throw new Error(`Virtual table ${table.name} needs at least one column`);
  const args = [...table.columns.map(q), ...(table.options ?? [])].join(', ');
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${q(table.name)} USING fts5(${args})`;
}

export function schemaToSqlStatements(schema: DatabaseSchema): { tables: string[]; indexes: string[]; virtualTables: string[] } {
  const tables: string[] = [];
  const indexes: string[] = [];
  const virtualTables = (schema.virtualTables ?? []).map(createVirtualTableSql);
  for (const t of schema.tables) {
    tables.push(createTableSql(t));
    if (t.indexes) {
      for (const idx of t.indexes) indexes.push(createIndexSql(t, idx));
    }
  }
  return { tables, indexes, virtualTables };
}

export function buildInitialSql(schema: DatabaseSchema): string {
  const { tables, indexes, virtualTables } = schemaToSqlStatements(schema);
  return [...tables, ...indexes, ...virtualTables].map((s) => `${s};`).join('\n\n');
}

export function renderColumnDef(col: Column): string { return columnDef(col); }
export function renderCreateTableSql(t: Table): string { return createTableSql(t); }
export function renderCreateIndexSql(table: Table, idx: Index): string { return createIndexSql(table, idx); }
export function renderCreateVirtualTableSql(table: VirtualTable): string { return createVirtualTableSql(table); }

// === Schema Diffing ===

export type DiffResult = {
  statements: string[];
  warnings: string[];
};

function byName<T extends { name: string }>(arr: T[]): Map<string, T> {
  const m = new Map<T['name'], T>();
  for (const x of arr) m.set(x.name, x);
  return m;
}

function safeAddColumnSql(table: Table, col: Column): { statements: string[]; warning?: string } {
  const type = sqlType(col);
  const tableName = q(table.name);
  const columnName = q(col.name);
  const parts: string[] = [`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${type}`];
  const statements: string[] = [];
  let warning: string | undefined;
  let canKeepNotNull = false;

  if (col.default) {
    if (col.default.kind === 'raw') {
      warning = `Cannot preserve non-constant default when adding ${tableName}.${columnName} in SQLite; adding the column without a schema-level DEFAULT and backfilling existing rows.`;
    } else {
      const v = col.default.value;
      if (v === null) parts.push('DEFAULT NULL');
      else if (typeof v === 'number') parts.push(`DEFAULT ${v}`);
      else if (typeof v === 'boolean') parts.push(`DEFAULT ${v ? 1 : 0}`);
      else {
        const escaped = String(v).replace(/'/g, "''");
        parts.push(`DEFAULT '${escaped}'`);
      }
      canKeepNotNull = true;
    }
  }

  if (col.notNull) {
    if (canKeepNotNull) {
      parts.push('NOT NULL');
    } else {
      const notNullWarning = `Cannot safely add NOT NULL column ${tableName}.${columnName} without a constant DEFAULT in SQLite; adding as nullable.`;
      warning = warning ? `${warning} ${notNullWarning}` : notNullWarning;
    }
  }

  if (col.unique || col.primaryKey || col.references || (col.enum && col.enum.length)) {
    const w = `Constraints for ${tableName}.${columnName} (unique/pk/fk/check) require table rebuild; not applied in ADD COLUMN.`;
    warning = warning ? `${warning} ${w}` : w;
  }

  statements.push(parts.join(' '));
  if (col.default?.kind === 'raw') {
    statements.push(`UPDATE ${tableName} SET ${columnName} = ${col.default.sql} WHERE ${columnName} IS NULL`);
  }

  return { statements, warning };
}

export function diffSchemas(from: DatabaseSchema, to: DatabaseSchema): DiffResult {
  const statements: string[] = [];
  const warnings: string[] = [];

  const fromTables = byName(from.tables);
  const toTables = byName(to.tables);

  for (const table of to.virtualTables ?? []) {
    statements.push(renderCreateVirtualTableSql(table) + ';');
  }

  for (const [tname, t] of toTables) {
    if (!fromTables.has(tname)) {
      statements.push(renderCreateTableSql(t) + ';');
      if (t.indexes) {
        for (const idx of t.indexes) statements.push(renderCreateIndexSql(t, idx) + ';');
      }
    }
  }

  for (const [tname, tTo] of toTables) {
    const tFrom = fromTables.get(tname);
    if (!tFrom) continue;

    const fromCols = byName(tFrom.columns);
    const toCols = byName(tTo.columns);
    for (const col of tTo.columns) {
      if (!fromCols.has(col.name)) {
        const { statements: addStatements, warning } = safeAddColumnSql(tTo, col);
        for (const statement of addStatements) statements.push(statement + ';');
        if (warning) warnings.push(warning);
      }
    }

    for (const [colName, colFrom] of fromCols) {
      if (!toCols.has(colName)) {
        statements.push(`ALTER TABLE ${q(tname)} DROP COLUMN ${q(colName)};`);
        warnings.push(`Dropping column ${q(tname)}.${q(colName)} removes existing data.${colFrom.primaryKey ? ' Ensure a new primary key is defined.' : ''}`);
      }
    }

    const toIdx = new Map<string, Index>();
    if (tTo.indexes) for (const i of tTo.indexes) toIdx.set(i.name, i);
    const fromIdx = new Map<string, Index>();
    if (tFrom.indexes) for (const i of tFrom.indexes) fromIdx.set(i.name, i);

    for (const [iname, idx] of toIdx) {
      const existing = fromIdx.get(iname);
      const same = existing && existing.unique === idx.unique &&
        JSON.stringify(existing.columns) === JSON.stringify(idx.columns);
      if (!existing || !same) {
        statements.push(renderCreateIndexSql(tTo, idx) + ';');
      }
    }

    for (const [iname, idxFrom] of fromIdx) {
      if (!toIdx.has(iname)) {
        statements.push(`DROP INDEX IF EXISTS ${q(iname)};`);
        warnings.push(`Index ${q(iname)} on ${q(tname)} referencing columns (${idxFrom.columns.map(q).join(', ')}) removed.`);
      }
    }

    if (tTo.checks && JSON.stringify(tTo.checks) !== JSON.stringify(tFrom.checks || [])) {
      warnings.push(`CHECK constraints changed for table ${q(tname)}; full table rebuild required.`);
    }
  }

  for (const [tname] of fromTables) {
    if (!toTables.has(tname)) {
      warnings.push(`Table ${q(tname)} removed in target schema; dropping tables is not performed automatically.`);
    }
  }

  return { statements, warnings };
}

export function buildDiffSql(from: DatabaseSchema, to: DatabaseSchema): { sql: string; warnings: string[] } {
  const { statements, warnings } = diffSchemas(from, to);
  return { sql: statements.join('\n\n'), warnings };
}

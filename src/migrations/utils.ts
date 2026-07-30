/**
 * Migration utilities
 */

import type { DatabaseSchema } from '../schema.js';
import type { SchemaDsl } from '../types.js';
import { ensureNormalizedSchema as ensureSchema } from '../schema.js';
import { buildInitialSql } from './generator.js';

export type MigrationJournal = { entries: { idx: number; tag: string }[] };

export { ensureSchema as ensureNormalizedSchema };

export function generateInitialMigrationBundle(schema: DatabaseSchema, opts?: { tag?: string }) {
  const tag = opts?.tag || 'initial';
  const sql = buildInitialSql(schema);
  const journal: MigrationJournal = { entries: [{ idx: 1, tag }] };
  const migrations: Record<string, () => Promise<string>> = {
    m0001: async () => sql,
  };
  return { journal, migrations };
}

export function generateInitialMigration(schema: DatabaseSchema | SchemaDsl): {
  journal: any;
  migrations: Record<string, () => Promise<string>>;
} {
  const normalized = ensureSchema(schema);
  return generateInitialMigrationBundle(normalized);
}

export function splitSqlStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => statement.endsWith(';') ? statement : statement + ';');
}

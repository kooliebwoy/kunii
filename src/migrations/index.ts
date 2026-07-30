/**
 * Migration utilities — SQL generation, schema diffing, runtime runner
 */

export { buildInitialSql, schemaToSqlStatements, diffSchemas, buildDiffSql, renderColumnDef, renderCreateTableSql, renderCreateIndexSql } from './generator.js';
export type { DiffResult } from './generator.js';
export { generateInitialMigrationBundle, generateInitialMigration, ensureNormalizedSchema, splitSqlStatements } from './utils.js';
export type { MigrationJournal } from './utils.js';
export { runMigrations, hasPendingMigrations } from './runner.js';
export type { MigrateOptions, MigrateResult } from './runner.js';

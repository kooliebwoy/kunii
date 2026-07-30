/**
 * Kunii - Lightweight D1/SQLite ORM for Cloudflare Workers
 *
 * Zero dependencies. Worker-safe. No Node APIs.
 */

// Core factory
export { kunii, kuniiORM, kuratchiORM, autoMigrate, assertSchemaInSync, createRuntimeOrm, createSchemaClient } from './orm.js';
export { initKuniiORM, initKuniiDO, initKuratchiORM, initKuratchiDO } from './init.js';
export type {
  KuniiEnv,
  KuniiClients,
  KuniiInitOptions,
  KuniiRuntime,
  KuniiSchema,
  KuniiSchemas,
  CloudflareEnv,
  CloudflareOrmClients,
  CloudflareOrmInitOptions,
  CloudflareOrmRuntime,
  CloudflareOrmSchema,
  CloudflareOrmSchemas,
} from './init.js';

// Schema
export { normalizeSchema, ensureNormalizedSchema } from './schema.js';
export type { DatabaseSchema, Column, Index, SqlDefault, Reference } from './schema.js';
// `Table` from schema.js is a column-list table definition. Renamed on
// re-export to avoid clashing with the query-side `Table<Row>` interface
// from types.js, which is the user-facing API surface and gets the bare
// name. Both are defined types — there is no runtime collision.
export type { Table as SchemaTable } from './schema.js';
export { isDatabaseSchema } from './schema.js';

// Types
export type {
  Primitive, Where, WhereValue, WhereOperators, OrderBy, OrderItem, FindManyOptions,
  QueryResult, SqlExecutor, SqlCondition, FullDbClient, IncludeSpec, IncludeConfig,
  Table, UpsertOptions, SelectSpec, SelectColumn,
  // Deprecated aliases — both resolve to Table.
  TableApi, TableQuery,
  // Batch.
  BatchTable, BatchTransaction, BatchCallback, BatchResult,
  ColumnDefString, TableDsl, MixinsDsl, IndexDsl, TableIndexesDsl, SchemaDsl,
  OrmAdapterConfig, ExecutorAdapterConfig,
} from './types.js';




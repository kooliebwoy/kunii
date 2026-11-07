/**
 * Runtime init helpers for D1 and Durable Object SQLite.
 *
 * This layer is intentionally Cloudflare-only: D1 bindings for async
 * migrations/queries, and Durable Object SqlStorage for synchronous setup.
 */

import { autoMigrate, kunii } from './orm.js';
import { runMigrations, type MigrateResult } from './migrations/runner.js';
import type { DatabaseSchema } from './schema.js';
import type { FullDbClient, OrmClient, SchemaDsl, SqlExecutor } from './types.js';

export type KuniiSchema = DatabaseSchema | SchemaDsl;
export type KuniiSchemas = Record<string, KuniiSchema>;
export type KuniiEnv = Record<string, any>;
export type KuniiClients<Schemas extends KuniiSchemas> = {
  [Name in keyof Schemas]: OrmClient;
};

export interface KuniiInitOptions {
  /** Label used in thrown setup errors. Adapters override this. */
  label?: string;
}

export interface KuniiRuntime<Schemas extends KuniiSchemas> {
  readonly schemas: Schemas;
  /** Run migrations every time. `runMigrations` still skips unchanged schemas. */
  migrate(env: KuniiEnv): Promise<void>;
  /** Run migrations once per isolate and return the result for each binding. */
  migrateOnce(env: KuniiEnv): Promise<Record<string, MigrateResult>>;
  /** Create one ORM client for a binding. This does not run DDL. */
  db<Name extends keyof Schemas & string>(env: KuniiEnv, bindingName: Name): OrmClient;
  /** Create ORM clients for every configured binding. This does not run DDL. */
  clients(env: KuniiEnv): KuniiClients<Schemas>;
  /** Testing/dev helper for clearing this runtime's in-isolate migration cache. */
  resetMigrationCache(): void;
}

/** @deprecated Use `KuniiSchema` instead. */
export type CloudflareOrmSchema = KuniiSchema;
/** @deprecated Use `KuniiSchemas` instead. */
export type CloudflareOrmSchemas = KuniiSchemas;
/** @deprecated Use `KuniiEnv` instead. */
export type CloudflareEnv = KuniiEnv;
/** @deprecated Use `KuniiClients` instead. */
export type CloudflareOrmClients<Schemas extends KuniiSchemas> = KuniiClients<Schemas>;
/** @deprecated Use `KuniiInitOptions` instead. */
export type CloudflareOrmInitOptions = KuniiInitOptions;
/** @deprecated Use `KuniiRuntime` instead. */
export type CloudflareOrmRuntime<Schemas extends KuniiSchemas> = KuniiRuntime<Schemas>;

type MigrationCache = WeakMap<object, Map<string, Promise<MigrateResult>>>;

function makeLabel(label?: string): string {
  return label ? `kunii/${label}` : 'kunii';
}

function explainD1SqlError(message: string | undefined): string | undefined {
  if (!message) return message;
  const m = /no such table:\s*(\S+)/i.exec(message);
  if (m) {
    return `${message}. Did you forget to run \`migrateOnce(env)\` through a Cloudflare framework adapter?`;
  }
  return message;
}

function getD1Binding(env: KuniiEnv | undefined, bindingName: string, label?: string): any {
  const display = makeLabel(label);
  if (!env || typeof env !== 'object') {
    throw new Error(`[${display}] Cloudflare env is required to access D1 binding "${bindingName}".`);
  }
  const binding = env[bindingName];
  if (!binding) {
    throw new Error(`[${display}] Missing D1 binding "${bindingName}" on Cloudflare env.`);
  }
  if (typeof binding.prepare !== 'function') {
    throw new Error(`[${display}] env.${bindingName} is not a D1Database binding (missing .prepare()).`);
  }
  return binding;
}

function d1Executor(database: any): { execute: SqlExecutor; client: FullDbClient } {
  const execute: SqlExecutor = async (sql, params) => {
    try {
      let stmt = database.prepare(sql);
      if (params?.length) stmt = stmt.bind(...params);
      const result = await stmt.all();
      return {
        success: result.success ?? true,
        data: result.results,
        results: result.results,
        error: explainD1SqlError(result.error),
        meta: result.meta,
      };
    } catch (error: any) {
      return { success: false, error: explainD1SqlError(error?.message || String(error)) };
    }
  };

  return { execute, client: database as FullDbClient };
}

async function migrateBinding(
  binding: any,
  schema: KuniiSchema,
): Promise<MigrateResult> {
  const { execute, client } = d1Executor(binding);
  return runMigrations({ execute, schema, client });
}

function cacheForBinding(cache: MigrationCache, binding: object): Map<string, Promise<MigrateResult>> {
  let byName = cache.get(binding);
  if (!byName) {
    byName = new Map();
    cache.set(binding, byName);
  }
  return byName;
}

export function initKuniiORM<Schemas extends KuniiSchemas>(
  schemas: Schemas,
  options: KuniiInitOptions = {},
): KuniiRuntime<Schemas> {
  let migrationCache: MigrationCache = new WeakMap();
  const bindingNames = Object.keys(schemas) as Array<keyof Schemas & string>;

  const migrate = async (env: KuniiEnv): Promise<void> => {
    for (const bindingName of bindingNames) {
      const binding = getD1Binding(env, bindingName, options.label);
      await migrateBinding(binding, schemas[bindingName]);
    }
  };

  const migrateOnce = async (env: KuniiEnv): Promise<Record<string, MigrateResult>> => {
    const results = new Map<string, MigrateResult>();
    for (const bindingName of bindingNames) {
      const binding = getD1Binding(env, bindingName, options.label);
      const byName = cacheForBinding(migrationCache, binding);
      let migration = byName.get(bindingName);
      if (!migration) {
        migration = migrateBinding(binding, schemas[bindingName]).catch((error) => {
          byName.delete(bindingName);
          throw error;
        });
        byName.set(bindingName, migration);
      }
      results.set(bindingName, await migration);
    }
    return Object.fromEntries(results);
  };

  const db = <Name extends keyof Schemas & string>(
    env: KuniiEnv,
    bindingName: Name,
  ): OrmClient => {
    const binding = getD1Binding(env, bindingName, options.label);
    return kunii(binding, schemas[bindingName]);
  };

  const clients = (env: KuniiEnv): KuniiClients<Schemas> => {
    const out: Partial<KuniiClients<Schemas>> = {};
    for (const bindingName of bindingNames) {
      out[bindingName as keyof Schemas] = db(env, bindingName) as any;
    }
    return out as KuniiClients<Schemas>;
  };

  return {
    schemas,
    migrate,
    migrateOnce,
    db,
    clients,
    resetMigrationCache() {
      migrationCache = new WeakMap();
    },
  };
}

export function initKuniiDO(
  storageOrSql: any,
  schema: KuniiSchema,
): OrmClient {
  autoMigrate(storageOrSql, schema);
  const sql = typeof storageOrSql?.sql?.exec === 'function' ? storageOrSql.sql : storageOrSql;
  return kunii(sql, schema);
}

/** @deprecated Use `initKuniiORM` instead. */
export const initKuratchiORM: typeof initKuniiORM = initKuniiORM;

/** @deprecated Use `initKuniiDO` instead. */
export const initKuratchiDO: typeof initKuniiDO = initKuniiDO;

import type { DatabaseSchema } from '../schema.js';
import type { SchemaDsl } from '../types.js';
import { runMigrationsSync, type MigrateResult } from './runner.js';

/** Adapt synchronous DO SQLite operations to the shared migration engine. */
export function runDurableObjectMigrations(storage: any, schema: DatabaseSchema | SchemaDsl): MigrateResult {
  const sql = storage?.sql ?? storage;
  if (typeof sql?.exec !== 'function') throw new Error('Expected Durable Object storage or SqlStorage');
  const transaction = typeof storage?.transactionSync === 'function'
    ? storage.transactionSync.bind(storage)
    : typeof sql.transactionSync === 'function' ? sql.transactionSync.bind(sql) : undefined;
  const execute = (statement: string, params: any[] = []) => {
    const data = sql.exec(statement, ...params).toArray();
    return { success: true, data };
  };
  const prepare = (statement: string) => ({
    statement,
    params: [] as any[],
    bind(...params: any[]) { return { statement, params }; },
  });
  const client = transaction ? {
    prepare,
    batch: (statements: { statement: string; params: any[] }[]) =>
      transaction(() => statements.map(statement => execute(statement.statement, statement.params))),
  } : undefined;
  return runMigrationsSync({ execute, client, schema });
}

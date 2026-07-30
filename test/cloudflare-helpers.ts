import type { SchemaDsl } from '../src/types.js';

export const appSchema: SchemaDsl = {
  name: 'app',
  version: 1,
  tables: {
    todos: {
      id: 'integer primary key',
      title: 'text not null',
    },
  },
};

type D1Call = {
  sql: string;
  params: any[];
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export class MockD1Database {
  calls: D1Call[] = [];
  batches: string[][] = [];

  prepare(sql: string) {
    const database = this;
    const normalized = normalizeSql(sql);
    const statement = {
      query: normalized,
      params: [] as any[],
      bind(...params: any[]) {
        return {
          ...statement,
          params,
        };
      },
      async all() {
        database.calls.push({ sql: normalized, params: statement.params });
        if (/SELECT version, schema_hash FROM _kuratchi_migrations/i.test(normalized)) {
          return { success: true, results: [] };
        }
        if (/SELECT name FROM sqlite_master/i.test(normalized)) {
          return { success: true, results: [] };
        }
        return { success: true, results: [] };
      },
      async first() {
        database.calls.push({ sql: normalized, params: statement.params });
        return undefined;
      },
      async run() {
        database.calls.push({ sql: normalized, params: statement.params });
        return { success: true, meta: {} };
      },
      async raw() {
        database.calls.push({ sql: normalized, params: statement.params });
        return [];
      },
    };
    return statement;
  }

  async batch(statements: Array<{ query?: string }>) {
    this.batches.push(statements.map((statement) => normalizeSql(statement.query ?? '')));
    return statements.map(() => ({ success: true, results: [] }));
  }
}

export class MockSqlStorage {
  calls: string[] = [];

  exec(sql: string, ..._params: any[]) {
    this.calls.push(normalizeSql(sql));
    return {
      toArray() {
        return [];
      },
    };
  }
}


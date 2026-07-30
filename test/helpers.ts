/**
 * Test helpers — mock SqlExecutor that records every call.
 *
 * Tests assert on the compiled SQL string + bound params, which is
 * the precise contract the ORM owes its users. No real DB needed.
 */

import type { SqlExecutor, FullDbClient, QueryResult } from '../src/types.js';

export type RecordedCall = {
  sql: string;
  params: any[];
};

export type ResponderEntry = {
  match: RegExp | string;
  rows?: any[];
  result?: QueryResult<any>;
};

export type MockExecutor = {
  execute: SqlExecutor;
  fullClient: FullDbClient;
  calls: RecordedCall[];
  /** Last SQL string (whitespace-collapsed). */
  lastSql(): string;
  /** Last bound params. */
  lastParams(): any[];
  /** Reset call log. */
  reset(): void;
  /** Set canned responses keyed by SQL substring or regex. Order matters; first match wins. */
  respond(entries: ResponderEntry[]): void;
};

/**
 * Collapse internal whitespace so tests can write expected SQL readably.
 */
export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function createMockExecutor(initial?: ResponderEntry[]): MockExecutor {
  let responders: ResponderEntry[] = initial ?? [];
  const calls: RecordedCall[] = [];

  const findResponse = (sql: string): QueryResult<any> | null => {
    for (const r of responders) {
      const matches =
        typeof r.match === 'string' ? sql.includes(r.match) : r.match.test(sql);
      if (matches) {
        if (r.result) return r.result;
        const rows = r.rows ?? [];
        return { success: true, data: rows, results: rows };
      }
    }
    return null;
  };

  const execute: SqlExecutor = async (sql, params) => {
    calls.push({ sql: normalizeSql(sql), params: params ?? [] });
    const canned = findResponse(sql);
    if (canned) return canned;
    return { success: true, data: [], results: [] };
  };

  const fullClient: FullDbClient = {
    first: async (sql, params) => {
      calls.push({ sql: normalizeSql(sql), params: params ?? [] });
      const canned = findResponse(sql);
      if (canned) {
        const rows = (canned as any).data ?? (canned as any).results ?? [];
        const first = Array.isArray(rows) ? rows[0] : undefined;
        return { success: true, data: first, results: first ? [first] : [] };
      }
      return { success: true, data: undefined, results: [] };
    },
  };

  return {
    execute,
    fullClient,
    calls,
    lastSql() {
      return calls[calls.length - 1]?.sql ?? '';
    },
    lastParams() {
      return calls[calls.length - 1]?.params ?? [];
    },
    reset() {
      calls.length = 0;
    },
    respond(entries) {
      responders = entries;
    },
  };
}

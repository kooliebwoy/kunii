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


/** Split SQLite statements without breaking literals, comments, or trigger bodies. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;
  let tokens: string[] = [];
  let trigger = false;
  let triggerEnd = false;
  let cases = 0;
  const finish = (end: number) => {
    const statement = sql.slice(start, end).trim();
    if (tokens.length || quote) statements.push(statement.endsWith(';') ? statement : statement + (lineComment ? '\n;' : ';'));
    start = end;
    tokens = [];
    trigger = false;
    triggerEnd = false;
    cases = 0;
  };
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
    } else if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; i++; }
    } else if (quote) {
      if (char === quote) {
        if (next === quote && quote !== ']') i++;
        else quote = undefined;
      }
    } else if (char === '-' && next === '-') {
      lineComment = true; i++;
    } else if (char === '/' && next === '*') {
      blockComment = true; i++;
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char === '[' ? ']' : char;
    } else if (/[A-Za-z_]/.test(char)) {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z_0-9]/.test(sql[end])) end++;
      const token = sql.slice(i, end).toUpperCase();
      const previous = tokens.at(-1);
      tokens.push(token);
      if (tokens[0] === 'CREATE' && token === 'TRIGGER' && tokens.length <= 3) trigger = true;
      if (trigger && token === 'CASE') cases++;
      if (trigger && token === 'END') {
        if (cases) cases--;
        else if (previous === ';' || previous === 'BEGIN') triggerEnd = true;
      }
      i = end - 1;
    } else if (char === ';' && (!trigger || triggerEnd)) {
      finish(i + 1);
    } else if (char === ';') {
      tokens.push(';');
    }
  }
  if (quote || blockComment) throw new Error('Unterminated SQL literal or comment');
  if (trigger && !triggerEnd) throw new Error('Unterminated SQL trigger');
  finish(sql.length);
  return statements;
}

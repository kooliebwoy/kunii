import type { Table } from '../schema.js';
import { renderCreateTableSql } from './generator.js';

/** SQL tokens preserve string contents while ignoring layout and identifier quoting. */
export function sqlTokens(sql: string): string[] {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g) ?? [];
  return tokens.map(token => {
    if (token.startsWith("'")) return token;
    if (token.startsWith('"')) return token.slice(1, -1).replace(/""/g, '"').toUpperCase();
    if (token.startsWith('`')) return token.slice(1, -1).replace(/``/g, '`').toUpperCase();
    if (token.startsWith('[')) return token.slice(1, -1).toUpperCase();
    return token.toUpperCase();
  });
}

/** Split a CREATE TABLE body into complete column and table constraint clauses. */
export function tableClauses(sql: string): string[][] {
  const tokens = sqlTokens(sql);
  const start = tokens.indexOf('(');
  if (start < 0) return [];
  const clauses: string[][] = [];
  let clause: string[] = [];
  let depth = 0;
  for (const token of tokens.slice(start + 1)) {
    if (token === ')' && depth === 0) {
      clauses.push(clause);
      // Additional table options need separate support before automatic rebuilding.
      return clauses;
    }
    if (token === ',' && depth === 0) {
      clauses.push(clause);
      clause = [];
    } else {
      clause.push(token);
      if (token === '(') depth++;
      if (token === ')') depth--;
    }
  }
  return [];
}

export function sameSql(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function matchesTableDefinition(sql: string, table: Table): boolean {
  const actual = sqlTokens(sql);
  const expected = sqlTokens(renderCreateTableSql(table));
  const body = (tokens: string[]) => tokens.slice(tokens.indexOf('(')).filter((token, index, all) =>
    !(token === ';' && index === all.length - 1));
  return sameSql(body(actual), body(expected));
}

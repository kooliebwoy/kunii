import type { DatabaseSchema } from '../schema.js';
import { q } from './generator.js';

/** Model native renames so the remaining diff sees the names SQLite will use. */
export function planColumnRenames(current: DatabaseSchema, target: DatabaseSchema) {
  const schema = structuredClone(current);
  const statements: string[] = [];
  for (const table of target.tables) {
    const live = schema.tables.find(candidate => candidate.name === table.name);
    const sources = new Set<string>();
    for (const column of table.columns) {
      if (!column.renameFrom) continue;
      const sourceName = column.renameFrom.toLowerCase();
      if (sourceName === column.name.toLowerCase() || sources.has(sourceName) ||
        table.columns.some(candidate => candidate.name.toLowerCase() === sourceName)) {
        throw new Error(`Ambiguous renameFrom ${q(column.renameFrom)} in ${q(table.name)}`);
      }
      sources.add(sourceName);
      if (!live) continue;
      const source = live.columns.find(candidate => candidate.name.toLowerCase() === sourceName);
      const destination = live.columns.find(candidate => candidate.name.toLowerCase() === column.name.toLowerCase());
      if (source && destination) throw new Error(`Cannot rename ${q(table.name)}.${q(source.name)}: ${q(column.name)} also exists`);
      if (!source) continue;
      statements.push(`ALTER TABLE ${q(table.name)} RENAME COLUMN ${q(source.name)} TO ${q(column.name)};`);
      source.name = column.name;
      for (const index of live.indexes ?? []) {
        index.columns = index.columns.map(name => name.toLowerCase() === sourceName ? column.name : name);
      }
      for (const dependent of schema.tables) {
        for (const reference of dependent.columns.map(candidate => candidate.references)) {
          if (reference?.table.toLowerCase() === table.name.toLowerCase() &&
            reference.column.toLowerCase() === sourceName) reference.column = column.name;
        }
      }
    }
  }
  return { schema, statements };
}

/**
 * Schema types and normalization
 *
 * Defines the JSON-based schema format for SQLite tables,
 * plus a shorthand DSL for defining schemas concisely.
 */

import type { SchemaDsl, TableDsl } from './types.js';

// ── JSON Schema Types ───────────────────────────────────────

export type SqlDefault =
  | { kind: 'raw'; sql: string }
  | { kind: 'value'; value: string | number | boolean | null };

export type Reference = {
  table: string;
  column: string;
  onDelete?: 'cascade' | 'restrict' | 'set null' | 'no action' | 'set default';
};

export type Column = {
  name: string;
  type: 'text' | 'integer' | 'real' | 'blob' | 'json';
  mode?: 'boolean' | 'timestamp_ms';
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  enum?: string[];
  default?: SqlDefault;
  references?: Reference;
};

export type Index = {
  name: string;
  columns: string[];
  unique?: boolean;
};

export type Table = {
  name: string;
  columns: Column[];
  indexes?: Index[];
  checks?: string[];
  comment?: string;
};

export type DatabaseSchema = {
  name: string;
  version?: number;
  tables: Table[];
};

export function isDatabaseSchema(v: any): v is DatabaseSchema {
  return v && typeof v === 'object' && typeof v.name === 'string' && Array.isArray(v.tables);
}

// ── DSL → Schema Normalization ──────────────────────────────

function parseEnum(arg: string): string[] | null {
  const m = arg.match(/^enum\((.*)\)$/i);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function parseDefault(tokens: string[], i: number): { def?: Column['default']; next: number } {
  if (!/^default$/i.test(tokens[i])) return { next: i };
  const t = tokens[i + 1];
  if (!t) return { next: i + 1 };
  // `default now` → ISO 8601 UTC string with explicit `Z` suffix so downstream
  // `new Date(value)` parses unambiguously across V8/JSC runtimes. The bare
  // `CURRENT_TIMESTAMP` form emits `YYYY-MM-DD HH:MM:SS` without a timezone
  // designator, which V8 interprets as *local* time.
  if (/^now$/i.test(t)) return { def: { kind: 'raw', sql: "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" }, next: i + 2 };
  if (/^null$/i.test(t)) return { def: { kind: 'value', value: null }, next: i + 2 };
  if (/^\(.*\)$/.test(t)) return { def: { kind: 'raw', sql: t }, next: i + 2 };
  if (/^\d+$/.test(t)) return { def: { kind: 'value', value: Number(t) }, next: i + 2 };
  if (/^\d+\.\d+$/.test(t)) return { def: { kind: 'value', value: Number(t) }, next: i + 2 };
  return { def: { kind: 'value', value: t.replace(/^"|"$/g, '') }, next: i + 2 };
}

function parseReferences(tokens: string[], i: number): { ref?: Column['references']; next: number } {
  if (tokens[i] !== '->') return { next: i };
  const target = tokens[i + 1];
  if (!target || !target.includes('.')) return { next: i + 1 };
  const [table, column] = target.split('.', 2);
  let onDelete: Column['references'] extends { onDelete: infer OD } ? OD : any = undefined;
  const od = tokens[i + 2];
  if (od && /^(cascade|restrict|set|null|no\s?action|set\s?default)$/i.test(od)) {
    onDelete = od.toLowerCase() as any;
    return { ref: { table, column, onDelete }, next: i + 3 };
  }
  return { ref: { table, column }, next: i + 2 };
}

function parseColumnDef(name: string, def: string): Column {
  const tokens = def.trim().split(/\s+/);
  let i = 0;
  let typeTok = tokens[i++]?.toLowerCase() || 'text';
  const col: Column = { name, type: 'text' } as Column;

  switch (typeTok) {
    case 'text': col.type = 'text'; break;
    case 'integer': col.type = 'integer'; break;
    case 'real': col.type = 'real'; break;
    case 'blob': col.type = 'blob'; break;
    case 'json': col.type = 'json'; break;
    default:
      if (typeTok === 'timestamp_ms') { col.type = 'integer'; col.mode = 'timestamp_ms'; }
      else if (typeTok === 'boolean') { col.type = 'integer'; col.mode = 'boolean'; }
      else { col.type = 'text'; }
  }

  while (i < tokens.length) {
    const tok = tokens[i].toLowerCase();
    if (tok === 'primary') {
      if (tokens[i + 1]?.toLowerCase() === 'key') { col.primaryKey = true; i += 2; continue; }
    }
    if (tok === 'not' && tokens[i + 1]?.toLowerCase() === 'null') { col.notNull = true; i += 2; continue; }
    if (tok === 'unique') { col.unique = true; i++; continue; }

    const en = parseEnum(tokens[i]);
    if (en) { col.enum = en; i++; continue; }

    const d = parseDefault(tokens, i);
    if (d.def || d.next !== i) { col.default = d.def; i = d.next; continue; }

    const r = parseReferences(tokens, i);
    if (r.ref || r.next !== i) { col.references = r.ref; i = r.next; continue; }

    if (tok === 'boolean') { col.type = 'integer'; col.mode = 'boolean'; i++; continue; }
    if (tok === 'timestamp_ms') { col.type = 'integer'; col.mode = 'timestamp_ms'; i++; continue; }

    i++;
  }

  return col;
}

function expandMixins(tables: Record<string, TableDsl>, mixins?: Record<string, TableDsl>): Record<string, TableDsl> {
  if (!mixins) return tables;
  const out: Record<string, TableDsl> = {};
  for (const [tname, tdef] of Object.entries(tables)) {
    const merged: TableDsl = {};
    for (const [k, v] of Object.entries(tdef)) {
      if (k.startsWith('...')) {
        const mix = k.slice(3);
        const m = mixins[mix];
        if (!m) throw new Error(`Unknown mixin: ${mix}`);
        Object.assign(merged, m);
      } else {
        merged[k] = v;
      }
    }
    out[tname] = merged;
  }
  return out;
}

/**
 * Normalize a schema DSL to DatabaseSchema format
 */
export function normalizeSchema(dsl: SchemaDsl): DatabaseSchema {
  const tables: Table[] = [];
  const expanded = expandMixins(dsl.tables, dsl.mixins);
  for (const [tname, tdef] of Object.entries(expanded)) {
    const cols: Column[] = [];
    for (const [cname, cdef] of Object.entries(tdef)) {
      if (cdef === true) continue;
      cols.push(parseColumnDef(cname, cdef));
    }

    const indexes: Index[] = [];
    if (dsl.indexes && dsl.indexes[tname]) {
      for (const [idxName, idxDef] of Object.entries(dsl.indexes[tname])) {
        indexes.push({
          name: idxName,
          columns: idxDef.columns,
          unique: idxDef.unique,
        });
      }
    }

    tables.push({ name: tname, columns: cols, indexes: indexes.length > 0 ? indexes : undefined });
  }
  return { name: dsl.name, version: dsl.version, tables };
}

/**
 * Ensure schema is normalized to DatabaseSchema format.
 * Accepts both DatabaseSchema (already normalized) and SchemaDsl (needs normalization).
 */
export function ensureNormalizedSchema(schema: DatabaseSchema | SchemaDsl): DatabaseSchema {
  const tables: any = (schema as any)?.tables;
  if (Array.isArray(tables)) {
    return schema as DatabaseSchema;
  }
  return normalizeSchema(schema as SchemaDsl);
}

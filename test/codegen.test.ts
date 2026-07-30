/**
 * Phase D: type generation from schema DSL.
 *
 * `generateTypes(schema)` walks the schema and produces a `.d.ts` source
 * string with one `XxxRow` interface per table plus an `XxxOrm`
 * top-level interface that maps tables to `Table<Row>`. Users save
 * the output and import the interface to get full row inference on
 * `db.users.where(...).first()`.
 *
 * Tests cover:
 *   - Column type mappings (integer/real/text/blob/json + modes)
 *   - Nullability (notNull, primaryKey, default-nullable)
 *   - Enum types
 *   - JSON shape overrides
 *   - Naming conventions (PascalCase row interfaces)
 *   - Exact emitted text for a representative schema
 */

import { describe, it, expect } from 'vitest';
import { generateTypes } from '../src/codegen.js';
import type { SchemaDsl } from '../src/types.js';

describe('generateTypes', () => {
  it('emits one XxxRow interface per table + XxxOrm top-level', () => {
    const schema: SchemaDsl = {
      name: 'app',
      version: 1,
      tables: {
        users: {
          id: 'integer primary key',
          email: 'text not null',
        },
        posts: {
          id: 'integer primary key',
          title: 'text not null',
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain('export interface UsersRow {');
    expect(dts).toContain('export interface PostsRow {');
    expect(dts).toContain('export interface AppOrm {');
    expect(dts).toContain('users: Table<UsersRow>;');
    expect(dts).toContain('posts: Table<PostsRow>;');
    expect(dts).toContain(
      "import type { Table, BatchCallback, BatchResult } from '@kuratchi/kunii';"
    );
    expect(dts).toContain('batch(callback: BatchCallback): Promise<BatchResult>;');
  });

  it('maps storage types to TS types', () => {
    const schema: SchemaDsl = {
      name: 'demo',
      version: 1,
      tables: {
        types: {
          int: 'integer not null',
          real: 'real not null',
          text: 'text not null',
          blob: 'blob not null',
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain('int: number;');
    expect(dts).toContain('real: number;');
    expect(dts).toContain('text: string;');
    expect(dts).toContain('blob: ArrayBuffer;');
  });

  it('honors mode: boolean and timestamp_ms', () => {
    const schema: SchemaDsl = {
      name: 'demo',
      version: 1,
      tables: {
        items: {
          flag: 'boolean not null',
          createdAt: 'timestamp_ms not null',
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain('flag: boolean;');
    expect(dts).toContain('createdAt: number;');
  });

  it('makes columns nullable when not declared NOT NULL or PK', () => {
    const schema: SchemaDsl = {
      name: 'demo',
      version: 1,
      tables: {
        items: {
          id: 'integer primary key',           // not null (PK)
          required: 'text not null',           // not null
          optional: 'text',                    // nullable
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain('id: number;');
    expect(dts).toContain('required: string;');
    expect(dts).toContain('optional: string | null;');
  });

  it('emits enum literals as union type', () => {
    const schema: SchemaDsl = {
      name: 'demo',
      version: 1,
      tables: {
        users: {
          id: 'integer primary key',
          tier: 'text enum(free,pro,enterprise) not null',
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain('tier: "free" | "pro" | "enterprise";');
  });

  it('JSON columns default to any | null', () => {
    const schema: SchemaDsl = {
      name: 'demo',
      version: 1,
      tables: {
        events: {
          id: 'integer primary key',
          payload: 'json',
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain('payload: any | null;');
  });

  it('JSON columns honor jsonShapes override', () => {
    const schema: SchemaDsl = {
      name: 'demo',
      version: 1,
      tables: {
        events: {
          id: 'integer primary key',
          payload: 'json not null',
        },
      },
    };
    const dts = generateTypes(schema, {
      jsonShapes: { events: { payload: "import('./types').Payload" } },
    });
    expect(dts).toContain("payload: import('./types').Payload;");
  });

  it('quotes table/column names that are not bare identifiers', () => {
    const schema: SchemaDsl = {
      name: 'demo',
      version: 1,
      tables: {
        users: {
          'first-name': 'text',
          email_address: 'text',
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain("'first-name': string | null;");
    // Snake case is a bare identifier — no quotes.
    expect(dts).toMatch(/^\s*email_address: string \| null;$/m);
  });

  it('PascalCases multi-word schema names for the Orm interface', () => {
    const schema: SchemaDsl = {
      name: 'admin-portal',
      version: 1,
      tables: { users: { id: 'integer primary key' } },
    };
    const dts = generateTypes(schema);
    expect(dts).toContain('export interface AdminPortalOrm {');
  });

  it('respects ormName option', () => {
    const schema: SchemaDsl = {
      name: 'app',
      version: 1,
      tables: { users: { id: 'integer primary key' } },
    };
    const dts = generateTypes(schema, { ormName: 'MyDb' });
    expect(dts).toContain('export interface MyDb {');
    expect(dts).not.toContain('export interface AppOrm {');
  });

  it('respects importFrom option', () => {
    const schema: SchemaDsl = {
      name: 'app',
      version: 1,
      tables: { users: { id: 'integer primary key' } },
    };
    const dts = generateTypes(schema, { importFrom: '../../packages/kunii/src' });
    expect(dts).toContain(
      "import type { Table, BatchCallback, BatchResult } from '../../packages/kunii/src';"
    );
  });

  it('produces a stable, predictable snapshot', () => {
    // Lock in the exact emitted text for a representative schema.
    // Updates here are intentional behavior changes — review carefully.
    const schema: SchemaDsl = {
      name: 'app',
      version: 2,
      tables: {
        users: {
          id: 'integer primary key',
          email: 'text not null',
          name: 'text',
          tier: 'text enum(free,pro) not null default free',
          meta: 'json',
          deleted_at: 'timestamp_ms',
        },
        posts: {
          id: 'integer primary key',
          userId: 'integer -> users.id',
          title: 'text not null',
          published: 'boolean not null default 0',
        },
      },
    };
    const dts = generateTypes(schema);
    expect(dts).toBe(
      [
        '// AUTO-GENERATED by kunii - do not edit by hand.',
        '// Source schema: app v2',
        '',
        "import type { Table, BatchCallback, BatchResult } from '@kuratchi/kunii';",
        '',
        'export interface UsersRow {',
        '  id: number;',
        '  email: string;',
        '  name: string | null;',
        '  tier: "free" | "pro";',
        '  meta: any | null;',
        '  deleted_at: number | null;',
        '}',
        '',
        'export interface PostsRow {',
        '  id: number;',
        '  userId: number | null;',
        '  title: string;',
        '  published: boolean;',
        '}',
        '',
        'export interface AppOrm {',
        '  users: Table<UsersRow>;',
        '  posts: Table<PostsRow>;',
        '  batch(callback: BatchCallback): Promise<BatchResult>;',
        '}',
        '',
      ].join('\n')
    );
  });

  it('accepts a normalized DatabaseSchema (not just DSL)', () => {
    // ensureNormalizedSchema short-circuits for already-normalized input.
    const dts = generateTypes({
      name: 'app',
      version: 1,
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'email', type: 'text', notNull: true },
          ],
        },
      ],
    });
    expect(dts).toContain('export interface UsersRow {');
    expect(dts).toContain('id: number;');
    expect(dts).toContain('email: string;');
  });
});

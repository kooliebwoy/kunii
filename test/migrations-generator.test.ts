import { describe, expect, it } from 'vitest';

import type { DatabaseSchema } from '../src/schema.js';
import { buildInitialSql, diffSchemas } from '../src/migrations/generator.js';

describe('migration SQL generation', () => {
  it('quotes identifiers in initial table and index creation', () => {
    const schema: DatabaseSchema = {
      name: 'app',
      tables: [
        {
          name: 'user profiles',
          columns: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'display-name', type: 'text', default: { kind: 'value', value: "Ada's" } },
          ],
          indexes: [
            { name: 'idx user display', columns: ['display-name'] },
          ],
        },
      ],
    };

    const sql = buildInitialSql(schema);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "user profiles"');
    expect(sql).toContain('"display-name" TEXT DEFAULT \'Ada\'\'s\'');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx user display" ON "user profiles"("display-name")');
  });

  it('quotes identifiers in additive column and index diffs', () => {
    const from: DatabaseSchema = {
      name: 'app',
      tables: [
        {
          name: 'user profiles',
          columns: [{ name: 'id', type: 'integer', primaryKey: true }],
        },
      ],
    };
    const to: DatabaseSchema = {
      name: 'app',
      tables: [
        {
          name: 'user profiles',
          columns: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'display-name', type: 'text', default: { kind: 'value', value: 'Ada' } },
          ],
          indexes: [
            { name: 'idx user display', columns: ['display-name'] },
          ],
        },
      ],
    };

    const diff = diffSchemas(from, to);
    expect(diff.statements).toContain(
      'ALTER TABLE "user profiles" ADD COLUMN "display-name" TEXT DEFAULT \'Ada\';'
    );
    expect(diff.statements).toContain(
      'CREATE INDEX IF NOT EXISTS "idx user display" ON "user profiles"("display-name");'
    );
  });

  it('warns and backfills raw defaults when adding a column', () => {
    const from: DatabaseSchema = {
      name: 'app',
      tables: [
        { name: 'events', columns: [{ name: 'id', type: 'integer', primaryKey: true }] },
      ],
    };
    const to: DatabaseSchema = {
      name: 'app',
      tables: [
        {
          name: 'events',
          columns: [
            { name: 'id', type: 'integer', primaryKey: true },
            {
              name: 'created-at',
              type: 'integer',
              notNull: true,
              default: { kind: 'raw', sql: "(strftime('%s','now'))" },
            },
          ],
        },
      ],
    };

    const diff = diffSchemas(from, to);
    expect(diff.statements).toEqual([
      'ALTER TABLE "events" ADD COLUMN "created-at" INTEGER;',
      'UPDATE "events" SET "created-at" = (strftime(\'%s\',\'now\')) WHERE "created-at" IS NULL;',
    ]);
    expect(diff.warnings.join(' ')).toContain('Cannot preserve non-constant default');
    expect(diff.warnings.join(' ')).toContain('adding as nullable');
  });

  it('does not auto-drop removed tables', () => {
    const from: DatabaseSchema = {
      name: 'app',
      tables: [
        { name: 'old table', columns: [{ name: 'id', type: 'integer', primaryKey: true }] },
      ],
    };
    const to: DatabaseSchema = { name: 'app', tables: [] };

    const diff = diffSchemas(from, to);
    expect(diff.statements).toEqual([]);
    expect(diff.warnings).toEqual([
      'Table "old table" removed in target schema; dropping tables is not performed automatically.',
    ]);
  });

  it('creates FTS5 virtual tables from the schema DSL shape', () => {
    const schema: DatabaseSchema = {
      name: 'knowledge',
      tables: [],
      virtualTables: [{
        name: 'knowledge_chunks_fts',
        module: 'fts5',
        columns: ['chunk_id', 'title', 'heading', 'content'],
        options: ["tokenize='porter unicode61'"],
      }],
    };

    expect(buildInitialSql(schema)).toContain(
      'CREATE VIRTUAL TABLE IF NOT EXISTS "knowledge_chunks_fts" USING fts5("chunk_id", "title", "heading", "content", tokenize=\'porter unicode61\')'
    );
  });
});

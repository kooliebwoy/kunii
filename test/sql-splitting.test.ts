import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../src/migrations/utils.js';

describe('SQLite statement splitting', () => {
  it('preserves semicolons and escaped quotes inside literals and identifiers', () => {
    expect(splitSqlStatements(`SELECT 'a;''b', "c;d", [e;f]; SELECT 2`)).toEqual([
      `SELECT 'a;''b', "c;d", [e;f];`, 'SELECT 2;',
    ]);
  });

  it('ignores comment delimiters and terminates a trailing line comment', () => {
    expect(splitSqlStatements('SELECT 1 /* ; */; -- ;\nSELECT 2 -- tail')).toEqual([
      'SELECT 1 /* ; */;', '-- ;\nSELECT 2 -- tail\n;',
    ]);
    expect(splitSqlStatements('-- comment only;')).toEqual([]);
  });

  it('preserves trigger bodies, CASE expressions, and END used as an identifier', () => {
    const trigger = `CREATE TEMP TRIGGER IF NOT EXISTS audit AFTER INSERT ON records
      BEGIN
        INSERT INTO log SELECT CASE WHEN new.value = ';' THEN 'yes' ELSE 'no' END;
        INSERT INTO log SELECT end FROM records;
      END;`;
    expect(splitSqlStatements(trigger + '\nSELECT 1;')).toEqual([trigger, 'SELECT 1;']);
  });

  it.each(["SELECT 'unfinished", 'SELECT 1 /* unfinished', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1;'])(
    'rejects incomplete SQL %s', sql => expect(() => splitSqlStatements(sql)).toThrow('Unterminated'),
  );
});

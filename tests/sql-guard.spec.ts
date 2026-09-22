import { describe, expect, it } from 'vitest'
import { UnsafeSqlError, assertReadOnlySql } from '../src/sql-guard.js'

describe('assertReadOnlySql', () => {
  it('accepts plain read queries and strips a trailing semicolon', () => {
    expect(assertReadOnlySql('SELECT * FROM blocks')).toBe('SELECT * FROM blocks')
    expect(assertReadOnlySql('  select id from blocks ;  ')).toBe('select id from blocks')
    expect(assertReadOnlySql('WITH t AS (SELECT 1) SELECT * FROM t')).toMatch(/^WITH/)
    expect(assertReadOnlySql('EXPLAIN SELECT 1')).toMatch(/^EXPLAIN/)
  })

  it('rejects empty statements', () => {
    expect(() => assertReadOnlySql('   ')).toThrow(UnsafeSqlError)
    expect(() => assertReadOnlySql(';')).toThrow(/empty/)
    expect(() => assertReadOnlySql('-- just a comment')).toThrow(/no executable SQL/)
  })

  it('rejects statements that do not start with a read keyword', () => {
    expect(() => assertReadOnlySql('DELETE FROM blocks')).toThrow(/must start with SELECT/)
    expect(() => assertReadOnlySql('INSERT INTO blocks VALUES (1)')).toThrow(/must start with SELECT/)
  })

  it('rejects every mutating verb, including behind a SELECT prefix', () => {
    for (const stmt of [
      "SELECT 1; DROP TABLE blocks",
      'SELECT 1 WHERE 1=1 UNION SELECT 1 FROM (UPDATE blocks SET content=1)',
      'SELECT * FROM blocks; PRAGMA user_version',
      'SELECT 1 /* x */ ; VACUUM',
      'SELECT 1 FROM blocks WHERE id = (SELECT 1 FROM (DELETE FROM blocks))',
    ]) {
      expect(() => assertReadOnlySql(stmt), stmt).toThrow(UnsafeSqlError)
    }
  })

  it('rejects stacked statements', () => {
    expect(() => assertReadOnlySql('SELECT 1; SELECT 2')).toThrow(/single SQL statement/)
  })

  it('ignores keywords that only appear in comments or string literals', () => {
    // A naive regex scan over the raw text would reject all of these.
    expect(() => assertReadOnlySql('SELECT 1 FROM blocks LIMIT 1 OFFSET 0 -- commit')).not.toThrow()
    expect(() => assertReadOnlySql('SELECT * FROM (SELECT 1) WHERE 1=1 /* vacuum */')).not.toThrow()
    expect(() =>
      assertReadOnlySql("SELECT * FROM blocks WHERE content = 'please delete this'"),
    ).not.toThrow()
    expect(() =>
      assertReadOnlySql('SELECT id FROM blocks WHERE tag LIKE "%update%"'),
    ).not.toThrow()
  })

  it('allows the replace() scalar function but not REPLACE INTO', () => {
    expect(() =>
      assertReadOnlySql("SELECT replace(content, 'a', 'b') FROM blocks"),
    ).not.toThrow()
    expect(() => assertReadOnlySql("REPLACE INTO blocks VALUES (1)")).toThrow(/must start with SELECT/)
    expect(() => assertReadOnlySql('SELECT 1 WHERE 1=1 UNION REPLACE INTO x VALUES (1)')).toThrow(
      /REPLACE INTO/,
    )
  })

  it('does not confuse identifiers containing keywords', () => {
    expect(() =>
      assertReadOnlySql('SELECT created, updated FROM blocks WHERE deleted_at IS NULL'),
    ).not.toThrow()
  })

  it('names the offending keyword in the error', () => {
    // No embedded ";" here, so the keyword check is what rejects it.
    expect(() => assertReadOnlySql('SELECT 1 WHERE 1=1 UNION DROP TABLE blocks')).toThrow(/DROP/)
    expect(() => assertReadOnlySql('SELECT 1 /* x */ UNION VACUUM')).toThrow(/VACUUM/)
  })
})

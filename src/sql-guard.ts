/**
 * Guards for the `sql_query` tool.
 *
 * `/api/query/sql` is documented as a query endpoint but the kernel happily
 * executes mutating statements through it (verified on 3.8.4: `DELETE FROM
 * blocks WHERE 1=0` returns `code: 0`). Exposing that verbatim would let a
 * model bypass every block-level write tool and corrupt the index, so the
 * statement is restricted to reads here.
 */

/** Leading keywords that begin a read-only statement. */
const READ_ONLY_STARTS = /^(select|with|explain)\b/i

/**
 * Keywords that are unsafe wherever they appear, with the reason shown to the
 * model. Bare `replace` is deliberately absent: SQLite's `replace(X,Y,Z)`
 * scalar function is legitimate in a read query, so only the `REPLACE INTO`
 * write form is treated as unsafe (see below).
 */
const WRITE_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\binsert\b/i, 'INSERT'],
  [/\bupdate\b/i, 'UPDATE'],
  [/\bdelete\b/i, 'DELETE'],
  [/\bdrop\b/i, 'DROP'],
  [/\balter\b/i, 'ALTER'],
  [/\bcreate\b/i, 'CREATE'],
  [/\breplace\s+into\b/i, 'REPLACE INTO'],
  [/\battach\b/i, 'ATTACH'],
  [/\bdetach\b/i, 'DETACH'],
  [/\bpragma\b/i, 'PRAGMA'],
  [/\bvacuum\b/i, 'VACUUM'],
  [/\breindex\b/i, 'REINDEX'],
  [/\bbegin\b/i, 'BEGIN'],
  [/\bcommit\b/i, 'COMMIT'],
  [/\brollback\b/i, 'ROLLBACK'],
  [/\bsavepoint\b/i, 'SAVEPOINT'],
]

export class UnsafeSqlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeSqlError'
  }
}

/**
 * Reduce `sql` to the code that the engine actually executes, with comments and
 * string literals replaced by placeholders.
 *
 * Structural checks run against this skeleton so that inert text — a keyword
 * inside a string literal or a commented-out fragment — cannot trigger a false
 * rejection, and cannot hide real syntax either.
 */
function skeleton(sql: string): string {
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!
    const next = sql[i + 1]

    // Line comment.
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      if (end === -1) break
      i = end
      out += ' '
      continue
    }
    // Block comment.
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) {
        out += ' '
        break
      }
      i = end + 1
      out += ' '
      continue
    }
    // String / quoted-identifier literal.
    if (char === "'" || char === '"' || char === '`') {
      const end = sql.indexOf(char, i + 1)
      if (end === -1) {
        out += ' '
        break
      }
      i = end
      out += " '' "
      continue
    }
    out += char
  }
  return out
}

/**
 * Assert that `stmt` is a single read-only statement, returning the original
 * text normalised (trailing semicolons and surrounding whitespace removed).
 *
 * This is a keyword-based defence in depth, not a full SQL parser: it reliably
 * blocks the direct write paths a model would reach for, and the kernel's own
 * index remains the final authority.
 */
export function assertReadOnlySql(stmt: string): string {
  const original = stmt.trim().replace(/;+\s*$/, '').trim()
  if (!original) throw new UnsafeSqlError('The SQL statement is empty.')

  const code = skeleton(original).trim()
  if (!code) throw new UnsafeSqlError('The SQL statement contains no executable SQL.')

  if (code.includes(';')) {
    throw new UnsafeSqlError(
      'Only a single SQL statement is allowed (found an embedded ";"). Split it into separate calls.',
    )
  }
  if (!READ_ONLY_STARTS.test(code)) {
    throw new UnsafeSqlError(
      'Only read-only queries are allowed: the statement must start with SELECT, WITH or EXPLAIN. ' +
        'Use the block and document tools for writes.',
    )
  }
  const write = WRITE_KEYWORDS.find(([pattern]) => pattern.test(code))
  if (write) {
    throw new UnsafeSqlError(
      `Only read-only queries are allowed (found "${write[1]}"). ` +
        'Use the block and document tools for writes.',
    )
  }
  return original
}

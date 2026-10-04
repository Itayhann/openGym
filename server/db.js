/* Real database wiring: wraps a `pg` Pool in the small interface the app uses
 * (`query(text, params) -> { rows }`, `exec(text)`). Tests use PGlite, which already has that shape. */
import pg from 'pg'

export function pgAdapter(pool) {
  return { query: (text, params) => pool.query(text, params), exec: text => pool.query(text), end: () => pool.end() }
}

export function connect(connectionString, { max = 3 } = {}) {
  return pgAdapter(new pg.Pool({ connectionString, max }))
}

/** Host part of a connection string, safe to print (never the credentials). */
export function describeTarget(connectionString) {
  try { const u = new URL(connectionString); return `${u.hostname}${u.pathname}` } catch { return '(unparseable connection string)' }
}

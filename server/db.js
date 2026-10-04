/* Real database wiring: wraps a `pg` Pool in the small interface the app uses
 * (`query(text, params) -> { rows }`, `exec(text)`). Tests use PGlite, which already has that shape. */
import pg from 'pg'

export function pgAdapter(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    exec: text => pool.query(text),
    end: () => pool.end(),
    transaction: async fn => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const tx = {
          query: (text, params) => client.query(text, params),
          exec: text => client.query(text)
        }
        const result = await fn(tx)
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }
  }
}

export function connect(connectionString, { max = 3 } = {}) {
  return pgAdapter(new pg.Pool({ connectionString, max }))
}

/** Host part of a connection string, safe to print (never the credentials). */
export function describeTarget(connectionString) {
  try { const u = new URL(connectionString); return `${u.hostname}${u.pathname}` } catch { return '(unparseable connection string)' }
}

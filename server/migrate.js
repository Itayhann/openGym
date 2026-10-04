/* Applies server/migrations/*.sql in filename order, once each.
 * Takes any db with `query(text, params)` and `exec(text)` (PGlite directly, or `connect()` from db.js).
 * Each file runs in its own transaction together with its bookkeeping row, so a failed migration
 * leaves nothing half-applied and is retried on the next run. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function migrate(db, { dir = DIR, log = () => {} } = {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name))
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort()
  const applied = []
  for (const file of files) {
    if (done.has(file)) continue
    const sql = await fs.readFile(path.join(dir, file), 'utf8')
    const record = `INSERT INTO schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}');`
    await db.exec(`BEGIN;\n${sql}\n${record}\nCOMMIT;`).catch(async e => {
      await db.exec('ROLLBACK').catch(() => {})
      throw new Error(`migration ${file} failed: ${e.message}`)
    })
    log(`applied ${file}`)
    applied.push(file)
  }
  return applied
}

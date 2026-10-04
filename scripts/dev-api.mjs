// Local API for `npm --prefix frontend run dev` (its proxy targets http://127.0.0.1:3000).
// Uses DATABASE_URL (point it at a throwaway Neon dev branch, never production) or, when unset,
// an on-disk Postgres in .dev-db/ that needs no setup. Passkeys work on http://localhost.
import http from 'node:http'
import { PGlite } from '@electric-sql/pglite'
import { createHandler } from '../server/handler.js'
import { loadConfig } from '../server/env.js'
import { connect, describeTarget } from '../server/db.js'
import { migrate } from '../server/migrate.js'
import { nodeListener } from '../server/node-adapter.js'
import { loadLocalEnv, realSleep, systemClock, unconfiguredPush } from '../server/runtime.js'

loadLocalEnv()
process.env.RP_ID ||= 'localhost'
process.env.ORIGIN ||= 'http://localhost:5173'
process.env.SETUP_CODE ||= 'dev-setup-code'
process.env.SESSION_SECRET ||= 'dev-session-secret-change-in-production'
const config = loadConfig()

let db
if (process.env.DATABASE_URL) {
  db = connect(process.env.DATABASE_URL)
  console.log(`database: ${describeTarget(process.env.DATABASE_URL)}`)
} else {
  db = new PGlite('.dev-db')
  console.log('database: local PGlite in .dev-db/')
}
await migrate(db, { log: m => console.log('migrated', m) })

const handler = createHandler({
  db, config,
  clock: systemClock, sleep: realSleep, push: unconfiguredPush
})
const port = Number(process.env.PORT) || 3000
http.createServer(nodeListener(handler)).listen(port, '127.0.0.1', () => {
  console.log(`api on http://127.0.0.1:${port}  rpId=${config.rpId} origin=${config.origin} setup code=${config.setupCode}`)
})

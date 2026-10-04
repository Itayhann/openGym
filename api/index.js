/* Vercel function entry: wires the real database, clock and config into the request handler.
   vercel.json rewrites every /api/* request here. Behaviour lives in server/; this file is wiring. */
import { createHandler } from '../server/handler.js'
import { loadConfig } from '../server/env.js'
import { connect } from '../server/db.js'
import { nodeListener } from '../server/node-adapter.js'

const config = loadConfig()
if (!process.env.DATABASE_URL) throw new Error('missing required environment variable(s): DATABASE_URL')

const handler = createHandler({
  db: connect(process.env.DATABASE_URL),
  clock: { now: () => Date.now() },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  // The real Web Push sender arrives with the push work (#6); until then sending fails loudly.
  push: { send: async () => { throw new Error('push is not configured yet') } },
  config
})

export default nodeListener(handler)

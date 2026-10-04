/* Vercel function entry: wires the real database, clock and config into the request handler.
   vercel.json rewrites every /api/* request here. Behaviour lives in server/; this file is wiring. */
import { createHandler } from '../server/handler.js'
import { loadConfig } from '../server/env.js'
import { connect } from '../server/db.js'
import { nodeListener } from '../server/node-adapter.js'
import { createPushSender, realSleep, systemClock } from '../server/runtime.js'

const config = loadConfig()
if (!process.env.DATABASE_URL) throw new Error('missing required environment variable(s): DATABASE_URL')

const push = createPushSender({
  publicKey: config.vapidPublicKey,
  privateKey: process.env.VAPID_PRIVATE_KEY?.trim(),
  subject: config.vapidSubject
})

const handler = createHandler({
  db: connect(process.env.DATABASE_URL),
  clock: systemClock,
  sleep: realSleep,
  push,
  config
})

export default nodeListener(handler)

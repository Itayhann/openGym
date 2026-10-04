/* Test harness for the API request handler — the one seam all server behaviour is tested through.
 *
 * `createTestApp()` builds a real handler over a real in-process Postgres (PGlite) with the real
 * migrations applied. Only the edges are faked: the clock, sleep and the push sender. Nothing about
 * the database is mocked, so tests assert on what a caller could observe through later requests.
 *
 *   const app = await createTestApp({ config: { setupCode: 'CODE-1234' } })
 *   const res = await app.request('GET', '/api/config')   // -> { status, headers, json, body }
 *   app.clock.advance(60_000)                              // move the fake clock
 *   app.push.sent                                          // pushes the fake sender recorded
 *
 * Passkey ceremonies: see ./authenticator.js, built to be driven through `app.request`.
 */
import { PGlite } from '@electric-sql/pglite'
import { createHandler } from '../../handler.js'
import { migrate } from '../../migrate.js'

export const TEST_ORIGIN = 'https://opengym.test'
export const TEST_RP_ID = 'opengym.test'

export function fakeClock(start = Date.parse('2026-10-05T08:00:00Z')) {
  let t = start
  return {
    now: () => t,
    advance: ms => { t += ms }
  }
}

/** Sleep that never waits: it advances the fake clock by the requested time instead. */
export function fakeSleep(clock) {
  return async ms => { clock.advance(ms) }
}

/** Push sender that records instead of sending. `failWith(statusCode)` makes the next sends reject. */
export function recordingPush() {
  const sent = []
  let failure = null
  return {
    sent,
    failWith(statusCode) { failure = statusCode },
    async send(subscription, payload) {
      if (failure) throw Object.assign(new Error('push failed'), { statusCode: failure })
      sent.push({ subscription, payload })
    }
  }
}

// Booting Postgres-in-WASM costs ~1s, so each test file shares one migrated instance and every
// test starts from empty tables. Test files run in separate workers, so they never share state.
let shared
async function freshDb() {
  if (!shared) {
    shared = new PGlite()
    await migrate(shared)
  }
  const { rows } = await shared.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'")
  if (rows.length) await shared.exec(`TRUNCATE ${rows.map(r => `"${r.tablename}"`).join(', ')} CASCADE`)
  return shared
}

/** `db` may be passed to run the handler over a stand-in, e.g. one that always fails. */
export async function createTestApp({ config = {}, clock = fakeClock(), db } = {}) {
  db ??= await freshDb()
  if (!db.transaction) db.transaction = async fn => fn(db)
  const sleep = fakeSleep(clock)
  const push = recordingPush()
  const fullConfig = {
    rpId: TEST_RP_ID,
    rpName: 'openGym',
    origin: TEST_ORIGIN,
    setupCode: null,
    maxProfiles: 1,
    sessionSecret: 'test-session-secret-at-least-32-chars-long',
    sessionDays: 90,
    cronSecret: 'test-cron-secret',
    vapidPublicKey: 'test-vapid-public-key',
    vapidSubject: 'mailto:admin@test.com',
    ...config
  }
  const handler = createHandler({ db, clock, sleep, push, config: fullConfig })

  async function request(method, path, { body, headers = {} } = {}) {
    const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
    const res = await handler({ method, url: path, headers, body: raw })
    let json = null
    try { json = res.body ? JSON.parse(res.body) : null } catch { /* non-JSON body */ }
    return { ...res, json }
  }

  return { db, clock, sleep, push, config: fullConfig, handler, request }
}

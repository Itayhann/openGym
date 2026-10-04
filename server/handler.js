/* The API request handler — the single seam all server behaviour is tested through.
 *
 *   const handle = createHandler({ db, clock, sleep, push, config })
 *   const res = await handle({ method, url, headers, body })   // body: raw string
 *   // res: { status, headers, body }                           // body: JSON string
 *
 * Collaborators are injected so tests can drive it with real Postgres (PGlite) and fake edges:
 *   db     { query(text, params) -> { rows }, exec(text) }
 *   clock  { now() -> epoch ms }
 *   sleep  async (ms) => void
 *   push   { send(subscription, payload) }     // rejects with { statusCode } on failure
 *   config { rpId, rpName, origin, setupCode, maxProfiles, ... }
 * Thin runtime entry points (api/index.js, scripts/dev-api.mjs) wire the real ones. */
import { routes } from './routes.js'

const MAX_BODY = 4 * 1024 * 1024 // below Vercel's ~4.5 MB request-body ceiling

export function createHandler(deps) {
  return async function handle(req) {
    const url = new URL(req.url, 'http://x')

    // Body checks come first so an oversized or malformed request is told so plainly, never
    // truncated or half-handled, whichever route it was aimed at.
    const raw = req.body || ''
    if (Buffer.byteLength(raw) > MAX_BODY) return reply(413, { error: 'request too large' })
    let body = {}
    if (raw) {
      try { body = JSON.parse(raw) } catch { return reply(400, { error: 'bad json' }) }
      // Routes read fields off `body`, so anything but a JSON object is refused here.
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'bad json' })
    }

    const route = routes[req.method + ' ' + url.pathname]
    if (!route) return reply(404, { error: 'not found' })

    try {
      return await route({ ...deps, req, url, body, reply })
    } catch (e) {
      console.error(req.method, url.pathname, e)
      return reply(500, { error: 'server error' })
    }
  }
}

export function reply(status, obj, headers = {}) {
  return {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
    body: JSON.stringify(obj)
  }
}

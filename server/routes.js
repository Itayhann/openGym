/* Route table: 'METHOD /path' -> async ({ db, clock, sleep, push, config, req, url, body, reply }) => response */
export const routes = {
  'GET /api/health': async ({ db, clock, reply }) => {
    try { await db.query('SELECT 1') } catch (e) {
      console.error('health: database unreachable', e.message)
      return reply(503, { ok: false })
    }
    return reply(200, { ok: true, time: new Date(clock.now()).toISOString() })
  },

  // Public config the login screen needs before anyone is signed in. `invite_only` is the field
  // the existing frontend reads to show its code box, so it carries the Setup code requirement:
  // true exactly while a registration could succeed — a code is configured and either there is
  // room for a (first) Profile or the Profile has no Passkey left (Re-enrolment).
  'GET /api/config': async ({ db, config, reply }) => {
    if (!config.setupCode) return reply(200, { invite_only: false })
    const { rows } = await db.query(
      `SELECT count(*)::int AS profiles,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM passkeys k WHERE k.profile_id = p.id))::int AS without_passkey
         FROM profiles p`)
    const { profiles, without_passkey } = rows[0]
    return reply(200, { invite_only: profiles < config.maxProfiles || without_passkey > 0 })
  }
}

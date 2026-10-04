import crypto from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server'
import {
  clearCookie,
  getRegistrationEligibility,
  readSession,
  sessionCookie,
  verifySetupCode
} from './auth.js'

async function refuseAdmin({ req, db, clock, config, reply }) {
  const profile = await readSession(req, { db, clock, config })
  if (!profile) return reply(401, { error: 'not signed in' })
  return reply(403, { error: 'forbidden' })
}

export async function sendPushToProfile(db, push, profileId, payload) {
  const { rows: subs } = await db.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE profile_id = $1',
    [profileId]
  )
  if (!subs.length) return
  await Promise.all(subs.map(async sub => {
    try {
      await push.send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      )
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint])
      }
    }
  }))
}

export function verifyCronAuth(req, config) {
  if (!config.cronSecret) return false
  const auth = req.headers.authorization || req.headers.Authorization
  if (!auth) return false
  const expected = `Bearer ${config.cronSecret}`
  if (auth.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function profileNow(tz, epochMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(new Date(epochMs))
    const g = t => parts.find(p => p.type === t)?.value
    return {
      date: `${g('year')}-${g('month')}-${g('day')}`,
      hhmm: `${g('hour')}:${g('minute')}`
    }
  } catch {
    return null
  }
}

export function effectiveRoutineId(S, isoDate) {
  const ov = S.dayPlan?.[isoDate]
  if (ov === 'rest') return null
  if (ov && (S.routines || []).some(r => r.id === ov)) return ov
  const wd = new Date(isoDate + 'T12:00:00Z').getUTCDay()
  const rid = S.week?.[wd]
  if (!rid || rid === 'rest') return null
  return rid
}

async function handleCronSweep({ req, db, clock, push, config, reply }) {
  if (!verifyCronAuth(req, config)) return reply(401, { error: 'unauthorized' })
  const nowIso = new Date(clock.now()).toISOString()

  // 1. Rest alerts due
  const { rows } = await db.query(
    'DELETE FROM rest_alerts WHERE due_at <= $1 RETURNING profile_id',
    [nowIso]
  )
  const sent = new Set()
  for (const row of rows) {
    if (!sent.has(row.profile_id)) {
      sent.add(row.profile_id)
      await sendPushToProfile(db, push, row.profile_id, {
        title: 'Rest over 💪',
        body: 'Time for your next set.',
        tag: 'rest-timer'
      })
    }
  }

  // 2. Daily reminders
  const { rows: candidateProfiles } = await db.query(
    `SELECT p.id, p.last_reminder_date, d.state
       FROM profiles p
       JOIN profile_data d ON d.profile_id = p.id
      WHERE p.disabled = false
        AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.profile_id = p.id)`
  )

  for (const candidate of candidateProfiles) {
    const S = candidate.state
    if (!S?.reminder?.on || !S.reminder.time) continue

    const now = profileNow(S.reminder.tz || 'UTC', clock.now())
    if (!now) continue // invalid timezone -> skip
    if (candidate.last_reminder_date === now.date) continue // already sent today

    const diff = toMinutes(now.hhmm) - toMinutes(S.reminder.time)
    if (diff < 0 || diff > 15) continue // outside grace window

    if ((S.workouts || []).some(w => w.d === now.date)) continue // already worked out today

    const rid = effectiveRoutineId(S, now.date)
    if (!rid) continue // rest day or nothing planned

    // Mark sent atomically before sending so duplicate cron cannot send twice
    const { rows: updated } = await db.query(
      `UPDATE profiles
          SET last_reminder_date = $1
        WHERE id = $2 AND (last_reminder_date IS NULL OR last_reminder_date <> $1)
       RETURNING id`,
      [now.date, candidate.id]
    )
    if (!updated.length) continue

    const routine = (S.routines || []).find(r => r.id === rid)
    const title = routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today'
    await sendPushToProfile(db, push, candidate.id, {
      title,
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    })
  }

  return reply(200, { ok: true })
}

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
    const { canRegister } = await getRegistrationEligibility(db, config)
    return reply(200, { invite_only: canRegister })
  },

  'POST /api/register/options': async ({ db, clock, config, body, reply }) => {
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    const { canRegister, withoutPasskey } = await getRegistrationEligibility(db, config)
    if (!canRegister || !verifySetupCode(code, config.setupCode)) {
      return reply(403, { error: 'forbidden' })
    }

    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 40) : ''
    if (!name) return reply(400, { error: 'name required' })

    let targetProfileId
    if (withoutPasskey > 0) {
      const { rows } = await db.query(
        `SELECT id FROM profiles p
          WHERE NOT EXISTS (SELECT 1 FROM passkeys k WHERE k.profile_id = p.id)
          ORDER BY created_at ASC LIMIT 1`
      )
      targetProfileId = rows[0].id
    } else {
      targetProfileId = crypto.randomBytes(12).toString('base64url')
    }

    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userID: Buffer.from(targetProfileId),
      userName: name,
      userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    })

    const cid = crypto.randomBytes(16).toString('base64url')
    const nowIso = new Date(clock.now()).toISOString()
    const expiresAt = new Date(clock.now() + 5 * 60 * 1000).toISOString()

    await db.query(
      `INSERT INTO challenges (id, challenge, purpose, pending_profile_id, pending_name, expires_at)
       VALUES ($1, $2, 'register', $3, $4, $5)`,
      [cid, options.challenge, targetProfileId, name, expiresAt]
    )

    // Best-effort cleanup of expired challenges
    await db.query('DELETE FROM challenges WHERE expires_at <= $1', [nowIso]).catch(() => {})

    return reply(200, { cid, options })
  },

  'POST /api/register/verify': async ({ db, clock, config, body, reply }) => {
    if (!body?.cid || !body?.credential?.id) {
      return reply(400, { error: 'invalid request' })
    }

    const nowIso = new Date(clock.now()).toISOString()
    const { rows: challengeRows } = await db.query(
      `DELETE FROM challenges
        WHERE id = $1 AND purpose = 'register' AND expires_at > $2
       RETURNING *`,
      [body.cid, nowIso]
    )
    const challengeRow = challengeRows[0]
    if (!challengeRow) {
      return reply(400, { error: 'challenge expired — try again' })
    }

    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: false
      })
    } catch (e) {
      return reply(400, { error: 'verification failed: ' + e.message })
    }

    if (!verification.verified) {
      return reply(400, { error: 'not verified' })
    }

    const { credential } = verification.registrationInfo
    const existingCred = await db.query('SELECT 1 FROM passkeys WHERE credential_id = $1', [credential.id])
    if (existingCred.rows.length) {
      return reply(409, { error: 'credential already registered' })
    }

    let profile
    try {
      profile = await db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(1)')
        const existing = (await tx.query('SELECT id, name, session_version FROM profiles WHERE id = $1', [challengeRow.pending_profile_id])).rows[0]

        if (existing) {
          // Re-enrolment: verify the profile still has zero passkeys
          const { rows: kRows } = await tx.query('SELECT count(*)::int AS count FROM passkeys WHERE profile_id = $1', [existing.id])
          if (kRows[0].count > 0) {
            const err = new Error('registration closed')
            err.status = 403
            throw err
          }
          await tx.query(
            `INSERT INTO passkeys (credential_id, profile_id, public_key, counter, transports)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              credential.id,
              existing.id,
              Buffer.from(credential.publicKey).toString('base64url'),
              credential.counter || 0,
              body.credential?.response?.transports || []
            ]
          )
          return existing
        } else {
          // New profile: check profile count against maxProfiles
          const { rows: pRows } = await tx.query('SELECT count(*)::int AS count FROM profiles')
          if (pRows[0].count >= config.maxProfiles) {
            const err = new Error('registration closed')
            err.status = 403
            throw err
          }
          await tx.query('INSERT INTO profiles (id, name) VALUES ($1, $2)', [challengeRow.pending_profile_id, challengeRow.pending_name])
          await tx.query(
            `INSERT INTO passkeys (credential_id, profile_id, public_key, counter, transports)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              credential.id,
              challengeRow.pending_profile_id,
              Buffer.from(credential.publicKey).toString('base64url'),
              credential.counter || 0,
              body.credential?.response?.transports || []
            ]
          )
          return { id: challengeRow.pending_profile_id, name: challengeRow.pending_name, session_version: 0 }
        }
      })
    } catch (e) {
      if (e.status === 403) return reply(403, { error: 'forbidden' })
      throw e
    }

    return reply(
      200,
      { user: { id: profile.id, name: profile.name, admin: false } },
      { 'Set-Cookie': sessionCookie(profile, config, clock) }
    )
  },

  'POST /api/login/options': async ({ db, clock, config, reply }) => {
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: 'preferred',
      allowCredentials: []
    })

    const cid = crypto.randomBytes(16).toString('base64url')
    const nowIso = new Date(clock.now()).toISOString()
    const expiresAt = new Date(clock.now() + 5 * 60 * 1000).toISOString()

    await db.query(
      `INSERT INTO challenges (id, challenge, purpose, expires_at)
       VALUES ($1, $2, 'login', $3)`,
      [cid, options.challenge, expiresAt]
    )

    await db.query('DELETE FROM challenges WHERE expires_at <= $1', [nowIso]).catch(() => {})

    return reply(200, { cid, options })
  },

  'POST /api/login/verify': async ({ db, clock, config, body, reply }) => {
    if (!body?.cid || !body?.credential?.id) {
      return reply(400, { error: 'invalid request' })
    }

    const nowIso = new Date(clock.now()).toISOString()
    const { rows: challengeRows } = await db.query(
      `DELETE FROM challenges
        WHERE id = $1 AND purpose = 'login' AND expires_at > $2
       RETURNING *`,
      [body.cid, nowIso]
    )
    const challengeRow = challengeRows[0]
    if (!challengeRow) {
      return reply(400, { error: 'challenge expired — try again' })
    }

    const { rows: passkeyRows } = await db.query(
      `SELECT k.credential_id, k.profile_id, k.public_key, k.counter, k.transports,
              p.id AS p_id, p.name AS p_name, p.disabled AS p_disabled, p.session_version AS p_session_version
         FROM passkeys k
         JOIN profiles p ON p.id = k.profile_id
        WHERE k.credential_id = $1`,
      [body.credential.id]
    )
    const row = passkeyRows[0]
    if (!row) {
      return reply(404, { error: 'unknown passkey — create a profile first' })
    }

    if (row.p_disabled) {
      return reply(403, { error: 'this account has been disabled' })
    }

    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpId,
        requireUserVerification: false,
        credential: {
          id: row.credential_id,
          publicKey: Buffer.from(row.public_key, 'base64url'),
          counter: Number(row.counter),
          transports: row.transports
        }
      })
    } catch (e) {
      return reply(400, { error: 'verification failed: ' + e.message })
    }

    if (!verification.verified) {
      return reply(400, { error: 'not verified' })
    }

    await db.query(
      'UPDATE passkeys SET counter = $1 WHERE credential_id = $2',
      [verification.authenticationInfo.newCounter, row.credential_id]
    )

    const profile = { id: row.p_id, name: row.p_name, session_version: row.p_session_version }
    return reply(
      200,
      { user: { id: profile.id, name: profile.name, admin: false } },
      { 'Set-Cookie': sessionCookie(profile, config, clock) }
    )
  },

  'GET /api/me': async ({ req, db, clock, config, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    return reply(200, { user: { id: profile.id, name: profile.name, admin: false } })
  },

  'POST /api/logout': async ({ config, reply }) => {
    return reply(200, { ok: true }, { 'Set-Cookie': clearCookie(config) })
  },

  'POST /api/logout/all': async ({ req, db, clock, config, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    await db.query('UPDATE profiles SET session_version = session_version + 1 WHERE id = $1', [profile.id])
    return reply(200, { ok: true }, { 'Set-Cookie': clearCookie(config) })
  },

  'POST /api/activity': async ({ req, db, clock, config, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    return reply(200, { ok: true })
  },

  'GET /api/data': async ({ req, db, clock, config, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    const { rows } = await db.query('SELECT state FROM profile_data WHERE profile_id = $1', [profile.id])
    return reply(200, { state: rows[0]?.state ?? null })
  },

  'PUT /api/data': async ({ req, db, clock, config, body, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    if (!body?.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
      return reply(400, { error: 'state required' })
    }
    delete body.state.active
    await db.query(
      `INSERT INTO profile_data (profile_id, state, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (profile_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [profile.id, body.state]
    )
    return reply(200, { ok: true, ts: body.state._ts || null })
  },

  'GET /api/push/public-key': async ({ config, reply }) => {
    return reply(200, { key: config.vapidPublicKey || '' })
  },

  'POST /api/push/subscribe': async ({ req, db, clock, config, body, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    const sub = body?.subscription
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return reply(400, { error: 'invalid subscription' })
    }
    await db.query(
      `INSERT INTO push_subscriptions (endpoint, profile_id, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (endpoint) DO UPDATE SET profile_id = EXCLUDED.profile_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = EXCLUDED.created_at`,
      [sub.endpoint, profile.id, sub.keys.p256dh, sub.keys.auth]
    )
    return reply(200, { ok: true })
  },

  'POST /api/push/unsubscribe': async ({ req, db, clock, config, body, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    const endpoint = body?.endpoint
    if (endpoint) {
      await db.query('DELETE FROM push_subscriptions WHERE profile_id = $1 AND endpoint = $2', [profile.id, endpoint])
    }
    return reply(200, { ok: true })
  },

  'POST /api/push/test': async ({ req, db, clock, push, config, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    await sendPushToProfile(db, push, profile.id, {
      title: 'openGym',
      body: 'Test notification ✅ — this is what alerts look like.',
      tag: 'test'
    })
    return reply(200, { ok: true })
  },

  'POST /api/push/rest-timer': async ({ req, db, clock, sleep, push, config, body, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    const sec = Math.round(Number(body?.seconds))
    if (!Number.isFinite(sec) || sec <= 0) return reply(400, { error: 'seconds required' })

    const alertId = crypto.randomBytes(16).toString('base64url')
    const dueAt = new Date(clock.now() + sec * 1000).toISOString()

    await db.query(
      `INSERT INTO rest_alerts (profile_id, id, due_at, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (profile_id) DO UPDATE SET id = EXCLUDED.id, due_at = EXCLUDED.due_at, created_at = EXCLUDED.created_at`,
      [profile.id, alertId, dueAt]
    )

    if (sec <= 600) {
      await sleep(sec * 1000)
      const { rows } = await db.query(
        'DELETE FROM rest_alerts WHERE profile_id = $1 AND id = $2 RETURNING *',
        [profile.id, alertId]
      )
      if (rows.length) {
        await sendPushToProfile(db, push, profile.id, {
          title: 'Rest over 💪',
          body: 'Time for your next set.',
          tag: 'rest-timer'
        })
      }
    }

    return reply(200, { ok: true })
  },

  'POST /api/push/rest-timer/cancel': async ({ req, db, clock, config, reply }) => {
    const profile = await readSession(req, { db, clock, config })
    if (!profile) return reply(401, { error: 'not signed in' })
    await db.query('DELETE FROM rest_alerts WHERE profile_id = $1', [profile.id])
    return reply(200, { ok: true })
  },

  'GET /api/cron/sweep': async ({ req, db, clock, push, config, reply }) => {
    return handleCronSweep({ req, db, clock, push, config, reply })
  },

  'POST /api/cron/sweep': async ({ req, db, clock, push, config, reply }) => {
    return handleCronSweep({ req, db, clock, push, config, reply })
  },

  // Admin routes always refuse: 401 when signed out, 403 when signed in.
  'GET /api/admin/users': refuseAdmin,
  'GET /api/admin/user': refuseAdmin,
  'POST /api/admin/user/disable': refuseAdmin,
  'GET /api/admin/invites': refuseAdmin,
  'POST /api/admin/invites/new': refuseAdmin,
  'POST /api/admin/invites/revoke': refuseAdmin
}

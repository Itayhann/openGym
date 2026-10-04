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

  // Admin routes always refuse: 401 when signed out, 403 when signed in.
  'GET /api/admin/users': refuseAdmin,
  'GET /api/admin/user': refuseAdmin,
  'POST /api/admin/user/disable': refuseAdmin,
  'GET /api/admin/invites': refuseAdmin,
  'POST /api/admin/invites/new': refuseAdmin,
  'POST /api/admin/invites/revoke': refuseAdmin
}

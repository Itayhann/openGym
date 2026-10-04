import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthenticator } from './test/support/authenticator.js'
import { createTestApp } from './test/support/app.js'

describe('Single-profile passkey auth', () => {
  let app
  const setupCode = 'SETUP-CODE-1234'

  beforeEach(async () => {
    app = await createTestApp({ config: { setupCode } })
  })

  function extractCookie(res) {
    const raw = res.headers['Set-Cookie']
    if (!raw) return null
    return raw.split(';')[0]
  }

  describe('First registration', () => {
    it('creates the profile, records the passkey, and issues a session cookie', async () => {
      const phone = createAuthenticator()

      const { status: optStatus, json: optJson } = await app.request('POST', '/api/register/options', {
        body: { name: 'Owner', code: setupCode }
      })
      expect(optStatus).toBe(200)
      expect(optJson.cid).toBeTruthy()
      expect(optJson.options.challenge).toBeTruthy()

      const credential = phone.createCredential(optJson.options)
      const res = await app.request('POST', '/api/register/verify', {
        body: { cid: optJson.cid, credential }
      })

      expect(res.status).toBe(200)
      expect(res.json.user).toMatchObject({ id: expect.any(String), name: 'Owner', admin: false })
      expect(res.headers['Set-Cookie']).toMatch(/gymsid=[^;]+;.*HttpOnly;.*SameSite=Lax; Secure/)

      const cookie = extractCookie(res)
      const meRes = await app.request('GET', '/api/me', { headers: { cookie } })
      expect(meRes.status).toBe(200)
      expect(meRes.json.user).toEqual(res.json.user)

      // Database state
      const { rows: profiles } = await app.db.query('SELECT * FROM profiles')
      expect(profiles).toHaveLength(1)
      expect(profiles[0].name).toBe('Owner')

      const { rows: passkeys } = await app.db.query('SELECT * FROM passkeys')
      expect(passkeys).toHaveLength(1)
      expect(passkeys[0].credential_id).toBe(phone.credentialId)
      expect(Number(passkeys[0].counter)).toBe(0)
      expect(passkeys[0].transports).toEqual(['internal'])

      // Single-use challenge has been deleted
      const { rows: challenges } = await app.db.query('SELECT * FROM challenges')
      expect(challenges).toHaveLength(0)
    })

    it('refuses registration when name is missing', async () => {
      const res = await app.request('POST', '/api/register/options', {
        body: { name: '   ', code: setupCode }
      })
      expect(res.status).toBe(400)
      expect(res.json.error).toMatch(/name required/)
    })
  })

  describe('Setup code refusal', () => {
    it('refuses wrong code with 403 and no detail on why', async () => {
      const res = await app.request('POST', '/api/register/options', {
        body: { name: 'Owner', code: 'WRONG-CODE' }
      })
      expect(res.status).toBe(403)
      expect(res.json).toEqual({ error: 'forbidden' })
    })

    it('refuses missing or blank code with 403 and no detail on why', async () => {
      const missing = await app.request('POST', '/api/register/options', {
        body: { name: 'Owner' }
      })
      expect(missing.status).toBe(403)
      expect(missing.json).toEqual({ error: 'forbidden' })

      const blank = await app.request('POST', '/api/register/options', {
        body: { name: 'Owner', code: '   ' }
      })
      expect(blank.status).toBe(403)
      expect(blank.json).toEqual({ error: 'forbidden' })
    })

    it('refuses registration when setup code is unset in config', async () => {
      const closedApp = await createTestApp({ config: { setupCode: null } })
      const res = await closedApp.request('POST', '/api/register/options', {
        body: { name: 'Owner', code: 'ANY-CODE' }
      })
      expect(res.status).toBe(403)
      expect(res.json).toEqual({ error: 'forbidden' })
    })
  })

  describe('Closing registration', () => {
    it('refuses a second registration options request when a profile has a passkey', async () => {
      const phone = createAuthenticator()
      const { json: reg } = await app.request('POST', '/api/register/options', { body: { name: 'Owner', code: setupCode } })
      await app.request('POST', '/api/register/verify', { body: { cid: reg.cid, credential: phone.createCredential(reg.options) } })

      const second = await app.request('POST', '/api/register/options', {
        body: { name: 'Stranger', code: setupCode }
      })
      expect(second.status).toBe(403)
      expect(second.json).toEqual({ error: 'forbidden' })
    })

    it('refuses verify of a second registration even if options were obtained before', async () => {
      const phone1 = createAuthenticator()
      const phone2 = createAuthenticator()

      const { json: reg1 } = await app.request('POST', '/api/register/options', { body: { name: 'Owner', code: setupCode } })
      const { json: reg2 } = await app.request('POST', '/api/register/options', { body: { name: 'Racer', code: setupCode } })

      // First finishes
      const res1 = await app.request('POST', '/api/register/verify', { body: { cid: reg1.cid, credential: phone1.createCredential(reg1.options) } })
      expect(res1.status).toBe(200)

      // Second attempts to verify
      const res2 = await app.request('POST', '/api/register/verify', { body: { cid: reg2.cid, credential: phone2.createCredential(reg2.options) } })
      expect(res2.status).toBe(403)
      expect(res2.json).toEqual({ error: 'forbidden' })

      const { rows } = await app.db.query('SELECT * FROM profiles')
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe('Owner')
    })
  })

  describe('Re-enrolment', () => {
    it('attaches a new passkey to an existing profile that has lost its passkeys, preserving profile id', async () => {
      // Seed an existing profile with no passkeys
      await app.db.query("INSERT INTO profiles (id, name) VALUES ('existing-owner-id', 'Original Owner')")

      // Config reflects re-enrolment is possible
      const configRes = await app.request('GET', '/api/config')
      expect(configRes.json).toEqual({ invite_only: true })

      const phone = createAuthenticator()
      const { status: optStatus, json: optJson } = await app.request('POST', '/api/register/options', {
        body: { name: 'Ignored', code: setupCode }
      })
      expect(optStatus).toBe(200)

      const credential = phone.createCredential(optJson.options)
      const res = await app.request('POST', '/api/register/verify', {
        body: { cid: optJson.cid, credential }
      })
      expect(res.status).toBe(200)
      expect(res.json.user).toEqual({ id: 'existing-owner-id', name: 'Original Owner', admin: false })

      // Passkey attached to existing profile
      const { rows: passkeys } = await app.db.query('SELECT * FROM passkeys WHERE profile_id = $1', ['existing-owner-id'])
      expect(passkeys).toHaveLength(1)
      expect(passkeys[0].credential_id).toBe(phone.credentialId)

      // Only one profile exists
      const { rows: profiles } = await app.db.query('SELECT * FROM profiles')
      expect(profiles).toHaveLength(1)

      // Now registration is closed again
      const configAfter = await app.request('GET', '/api/config')
      expect(configAfter.json).toEqual({ invite_only: false })
    })
  })

  describe('Login', () => {
    let phone, user

    beforeEach(async () => {
      phone = createAuthenticator()
      const { json: reg } = await app.request('POST', '/api/register/options', { body: { name: 'Owner', code: setupCode } })
      const res = await app.request('POST', '/api/register/verify', { body: { cid: reg.cid, credential: phone.createCredential(reg.options) } })
      user = res.json.user
    })

    it('logs in successfully and updates the signature counter', async () => {
      for (const expectedCounter of [1, 2]) {
        const { status: optStatus, json: optJson } = await app.request('POST', '/api/login/options')
        expect(optStatus).toBe(200)
        expect(optJson.cid).toBeTruthy()

        const assertion = phone.getAssertion(optJson.options)
        const res = await app.request('POST', '/api/login/verify', {
          body: { cid: optJson.cid, credential: assertion }
        })
        expect(res.status).toBe(200)
        expect(res.json.user).toEqual(user)
        expect(res.headers['Set-Cookie']).toMatch(/gymsid=[^;]+;/)

        const { rows } = await app.db.query('SELECT counter FROM passkeys WHERE credential_id = $1', [phone.credentialId])
        expect(Number(rows[0].counter)).toBe(expectedCounter)
      }
    })

    it('refuses replayed challenges', async () => {
      const { json: optJson } = await app.request('POST', '/api/login/options')
      const assertion = phone.getAssertion(optJson.options)

      const first = await app.request('POST', '/api/login/verify', {
        body: { cid: optJson.cid, credential: assertion }
      })
      expect(first.status).toBe(200)

      const second = await app.request('POST', '/api/login/verify', {
        body: { cid: optJson.cid, credential: assertion }
      })
      expect(second.status).toBe(400)
      expect(second.json.error).toMatch(/challenge expired/)
    })

    it('refuses expired challenges (> 5 minutes)', async () => {
      const { json: optJson } = await app.request('POST', '/api/login/options')
      const assertion = phone.getAssertion(optJson.options)

      app.clock.advance(5 * 60 * 1000 + 1)

      const res = await app.request('POST', '/api/login/verify', {
        body: { cid: optJson.cid, credential: assertion }
      })
      expect(res.status).toBe(400)
      expect(res.json.error).toMatch(/challenge expired/)
    })

    it('refuses an unknown passkey with 404', async () => {
      const stranger = createAuthenticator()
      const { json: optJson } = await app.request('POST', '/api/login/options')
      const assertion = stranger.getAssertion(optJson.options)

      const res = await app.request('POST', '/api/login/verify', {
        body: { cid: optJson.cid, credential: assertion }
      })
      expect(res.status).toBe(404)
      expect(res.json.error).toMatch(/unknown passkey/)
    })

    it('refuses forged signature for a known credential id with 400', async () => {
      const stranger = createAuthenticator()
      const { json: optJson } = await app.request('POST', '/api/login/options')
      const forged = phone.getAssertion(optJson.options, { signWith: stranger })

      const res = await app.request('POST', '/api/login/verify', {
        body: { cid: optJson.cid, credential: forged }
      })
      expect(res.status).toBe(400)
      expect(res.json.error).toMatch(/not verified/)
    })

    it('refuses login when the profile is disabled with 403', async () => {
      await app.db.query('UPDATE profiles SET disabled = true WHERE id = $1', [user.id])

      const { json: optJson } = await app.request('POST', '/api/login/options')
      const assertion = phone.getAssertion(optJson.options)

      const res = await app.request('POST', '/api/login/verify', {
        body: { cid: optJson.cid, credential: assertion }
      })
      expect(res.status).toBe(403)
      expect(res.json.error).toMatch(/disabled/)
    })
  })

  describe('Session lifecycle', () => {
    let phone, cookie

    beforeEach(async () => {
      phone = createAuthenticator()
      const { json: reg } = await app.request('POST', '/api/register/options', { body: { name: 'Owner', code: setupCode } })
      const res = await app.request('POST', '/api/register/verify', { body: { cid: reg.cid, credential: phone.createCredential(reg.options) } })
      cookie = extractCookie(res)
    })

    it('rejects tampered cookie signature', async () => {
      const tampered = cookie.slice(0, -4) + 'zzzz'
      const res = await app.request('GET', '/api/me', { headers: { cookie: tampered } })
      expect(res.status).toBe(401)
      expect(res.json.error).toMatch(/not signed in/)
    })

    it('rejects tampered cookie payload', async () => {
      const token = cookie.replace('gymsid=', '')
      const dot = token.lastIndexOf('.')
      const tampered = 'gymsid=someone-else:9999999999999:0' + token.slice(dot)
      const res = await app.request('GET', '/api/me', { headers: { cookie: tampered } })
      expect(res.status).toBe(401)
    })

    it('rejects expired cookies', async () => {
      app.clock.advance(91 * 86400 * 1000)
      const res = await app.request('GET', '/api/me', { headers: { cookie } })
      expect(res.status).toBe(401)
    })

    it('POST /api/logout clears cookie', async () => {
      const res = await app.request('POST', '/api/logout', { headers: { cookie } })
      expect(res.status).toBe(200)
      expect(res.headers['Set-Cookie']).toMatch(/gymsid=;.*Max-Age=0/)
    })

    it('POST /api/logout/all bumps session version and invalidates existing sessions', async () => {
      const res = await app.request('POST', '/api/logout/all', { headers: { cookie } })
      expect(res.status).toBe(200)
      expect(res.headers['Set-Cookie']).toMatch(/gymsid=;.*Max-Age=0/)

      // The old cookie is now invalid because session_version has bumped
      const meAfter = await app.request('GET', '/api/me', { headers: { cookie } })
      expect(meAfter.status).toBe(401)

      // Logging in fresh generates a valid new session with updated version
      const { json: optJson } = await app.request('POST', '/api/login/options')
      const loginRes = await app.request('POST', '/api/login/verify', {
        body: { cid: optJson.cid, credential: phone.getAssertion(optJson.options) }
      })
      const newCookie = extractCookie(loginRes)
      const meNew = await app.request('GET', '/api/me', { headers: { cookie: newCookie } })
      expect(meNew.status).toBe(200)
    })

    it('rejects disabled accounts even with a valid unexpired cookie', async () => {
      const { rows } = await app.db.query('SELECT id FROM profiles')
      await app.db.query('UPDATE profiles SET disabled = true WHERE id = $1', [rows[0].id])

      const res = await app.request('GET', '/api/me', { headers: { cookie } })
      expect(res.status).toBe(401)
    })
  })

  describe('Admin routes', () => {
    const adminRoutes = [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/user'],
      ['POST', '/api/admin/user/disable'],
      ['GET', '/api/admin/invites'],
      ['POST', '/api/admin/invites/new'],
      ['POST', '/api/admin/invites/revoke']
    ]

    it('refuse with 401 when signed out', async () => {
      for (const [method, path] of adminRoutes) {
        const res = await app.request(method, path)
        expect(res.status).toBe(401)
        expect(res.json.error).toMatch(/not signed in/)
      }
    })

    it('refuse with 403 when signed in', async () => {
      const phone = createAuthenticator()
      const { json: reg } = await app.request('POST', '/api/register/options', { body: { name: 'Owner', code: setupCode } })
      const regRes = await app.request('POST', '/api/register/verify', { body: { cid: reg.cid, credential: phone.createCredential(reg.options) } })
      const cookie = extractCookie(regRes)

      for (const [method, path] of adminRoutes) {
        const res = await app.request(method, path, { headers: { cookie } })
        expect(res.status).toBe(403)
        expect(res.json.error).toMatch(/forbidden/)
      }
    })
  })

  describe('Activity endpoint', () => {
    it('refuses with 401 when signed out', async () => {
      const res = await app.request('POST', '/api/activity')
      expect(res.status).toBe(401)
    })

    it('succeeds with 200 when signed in', async () => {
      const phone = createAuthenticator()
      const { json: reg } = await app.request('POST', '/api/register/options', { body: { name: 'Owner', code: setupCode } })
      const regRes = await app.request('POST', '/api/register/verify', { body: { cid: reg.cid, credential: phone.createCredential(reg.options) } })
      const cookie = extractCookie(regRes)

      const res = await app.request('POST', '/api/activity', { headers: { cookie }, body: { active: true } })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ ok: true })
    })
  })
})

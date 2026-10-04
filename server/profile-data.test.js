import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthenticator } from './test/support/authenticator.js'
import { createTestApp } from './test/support/app.js'

describe('Profile data sync', () => {
  let app, cookie, profileId

  beforeEach(async () => {
    app = await createTestApp({ config: { setupCode: 'DATA-SYNC-CODE' } })
    const phone = createAuthenticator()
    const { json: reg } = await app.request('POST', '/api/register/options', {
      body: { name: 'Owner', code: 'DATA-SYNC-CODE' }
    })
    const res = await app.request('POST', '/api/register/verify', {
      body: { cid: reg.cid, credential: phone.createCredential(reg.options) }
    })
    cookie = res.headers['Set-Cookie'].split(';')[0]
    profileId = res.json.user.id
  })

  it('returns state: null before any state has been saved', async () => {
    const res = await app.request('GET', '/api/data', { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ state: null })
  })

  it('save then load round-trips the document', async () => {
    const state = {
      _ts: 1728000000000,
      unit: 'kg',
      routines: [{ id: 'r1', name: 'Upper Body', emoji: '💪' }],
      workouts: [{ id: 'w1', d: '2026-10-04', routine: 'Upper Body' }]
    }

    const putRes = await app.request('PUT', '/api/data', {
      headers: { cookie },
      body: { state }
    })
    expect(putRes.status).toBe(200)
    expect(putRes.json).toEqual({ ok: true, ts: 1728000000000 })

    const getRes = await app.request('GET', '/api/data', { headers: { cookie } })
    expect(getRes.status).toBe(200)
    expect(getRes.json.state).toEqual(state)
  })

  it('the active workout field is never stored', async () => {
    const stateWithActive = {
      _ts: 1728000001000,
      active: { id: 'w-live', name: 'Squats in progress', startedAt: 1728000000000 },
      workouts: []
    }

    const putRes = await app.request('PUT', '/api/data', {
      headers: { cookie },
      body: { state: stateWithActive }
    })
    expect(putRes.status).toBe(200)

    const getRes = await app.request('GET', '/api/data', { headers: { cookie } })
    expect(getRes.status).toBe(200)
    expect(getRes.json.state.active).toBeUndefined()
    expect(getRes.json.state._ts).toBe(1728000001000)

    // Direct database check confirms active was stripped before writing
    const { rows } = await app.db.query('SELECT state FROM profile_data WHERE profile_id = $1', [profileId])
    expect(rows[0].state.active).toBeUndefined()
  })

  it('rejects invalid or missing state body with 400', async () => {
    for (const body of [{}, { state: null }, { state: 'not-an-object' }, { state: [1, 2] }]) {
      const res = await app.request('PUT', '/api/data', { headers: { cookie }, body })
      expect(res.status).toBe(400)
      expect(res.json.error).toMatch(/state required/)
    }
  })

  it('an oversized save is rejected clearly and the stored data is unchanged', async () => {
    const initial = { _ts: 100, workouts: [{ id: 'w0' }] }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: initial } })

    // Payload exceeding MAX_BODY (4MB)
    const bigBlob = 'x'.repeat(4 * 1024 * 1024 + 1024)
    const res = await app.request('PUT', '/api/data', {
      headers: { cookie },
      body: JSON.stringify({ state: { blob: bigBlob } })
    })

    expect(res.status).toBe(413)
    expect(res.json.error).toMatch(/too large/)

    // Existing data is untouched
    const getRes = await app.request('GET', '/api/data', { headers: { cookie } })
    expect(getRes.status).toBe(200)
    expect(getRes.json.state).toEqual(initial)
  })

  it('unauthenticated load and save are refused with 401', async () => {
    const getRes = await app.request('GET', '/api/data')
    expect(getRes.status).toBe(401)
    expect(getRes.json.error).toMatch(/not signed in/)

    const putRes = await app.request('PUT', '/api/data', { body: { state: {} } })
    expect(putRes.status).toBe(401)
    expect(putRes.json.error).toMatch(/not signed in/)
  })

  it('the presence endpoint returns success without storing anything', async () => {
    const res = await app.request('POST', '/api/activity', {
      headers: { cookie },
      body: { active: true, name: 'Live workout' }
    })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })

    const { rows } = await app.db.query('SELECT count(*)::int AS count FROM profile_data')
    expect(rows[0].count).toBe(0)
  })
})

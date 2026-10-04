import { describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'
import { createTestApp } from './test/support/app.js'

let app

async function seedProfile(app, { passkeys = 1 } = {}) {
  await app.db.query("INSERT INTO profiles (id, name) VALUES ('p1', 'Owner')")
  for (let i = 0; i < passkeys; i++) {
    await app.db.query("INSERT INTO passkeys (credential_id, profile_id, public_key) VALUES ($1, 'p1', 'pk')", ['cred' + i])
  }
}

describe('health', () => {
  it('reports the service is up and the time the handler sees', async () => {
    app = await createTestApp()
    const res = await app.request('GET', '/api/health')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, time: new Date(app.clock.now()).toISOString() })
  })

  it('reports 503 when the database cannot be reached', async () => {
    app = await createTestApp({ db: { query: async () => { throw new Error('connection refused') }, exec: async () => {} } })
    const res = await app.request('GET', '/api/health')
    expect(res.status).toBe(503)
    expect(res.json).toEqual({ ok: false })
  })
})

describe('request handling', () => {
  it('answers unknown routes with 404', async () => {
    app = await createTestApp()
    expect((await app.request('GET', '/api/nope')).status).toBe(404)
    expect((await app.request('POST', '/api/health')).status).toBe(404)
  })

  it('refuses malformed JSON with 400', async () => {
    app = await createTestApp()
    const res = await app.request('POST', '/api/logout', { body: '{not json' })
    expect(res.status).toBe(400)
  })

  it('refuses a body that is valid JSON but not an object', async () => {
    app = await createTestApp()
    for (const body of ['null', '[]', '"x"', '5']) {
      expect((await app.request('POST', '/api/logout', { body })).status).toBe(400)
    }
  })

  it('refuses an oversized body with a clear 413 instead of truncating', async () => {
    app = await createTestApp()
    const res = await app.request('PUT', '/api/data', { body: JSON.stringify({ blob: 'x'.repeat(5 * 1024 * 1024) }) })
    expect(res.status).toBe(413)
    expect(res.json.error).toMatch(/too large/)
  })

  it('never caches API responses', async () => {
    app = await createTestApp()
    expect((await app.request('GET', '/api/health')).headers['Cache-Control']).toBe('no-store')
  })
})

describe('config', () => {
  it('asks for the setup code on a fresh instance that has one configured', async () => {
    app = await createTestApp({ config: { setupCode: 'S3TUP' } })
    expect((await app.request('GET', '/api/config')).json).toEqual({ invite_only: true })
  })

  it('does not ask for it when no setup code is configured (registration is closed)', async () => {
    app = await createTestApp({ config: { setupCode: null } })
    expect((await app.request('GET', '/api/config')).json).toEqual({ invite_only: false })
  })

  it('does not ask for it once the profile has a passkey', async () => {
    app = await createTestApp({ config: { setupCode: 'S3TUP' } })
    await seedProfile(app, { passkeys: 1 })
    expect((await app.request('GET', '/api/config')).json).toEqual({ invite_only: false })
  })

  it('asks for it again when the profile has lost all its passkeys (re-enrolment)', async () => {
    app = await createTestApp({ config: { setupCode: 'S3TUP' } })
    await seedProfile(app, { passkeys: 0 })
    expect((await app.request('GET', '/api/config')).json).toEqual({ invite_only: true })
  })
})

describe('migrations', () => {
  it('are applied once and are safe to run again', async () => {
    app = await createTestApp()
    expect(await migrate(app.db)).toEqual([])
  })
})

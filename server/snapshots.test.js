import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthenticator } from './test/support/authenticator.js'
import { createTestApp, fakeClock } from './test/support/app.js'

describe('Nightly snapshots', () => {
  let app, cookie, profileId
  const cronSecret = 'test-cron-secret'
  const startTime = Date.parse('2026-10-04T03:00:00Z')

  beforeEach(async () => {
    app = await createTestApp({
      clock: fakeClock(startTime),
      config: {
        setupCode: 'SNAP-CODE',
        cronSecret
      }
    })
    const phone = createAuthenticator()
    const { json: reg } = await app.request('POST', '/api/register/options', {
      body: { name: 'Owner', code: 'SNAP-CODE' }
    })
    const res = await app.request('POST', '/api/register/verify', {
      body: { cid: reg.cid, credential: phone.createCredential(reg.options) }
    })
    cookie = res.headers['Set-Cookie'].split(';')[0]
    profileId = res.json.user.id
  })

  it('refuses requests without the cron secret with 401', async () => {
    const unauth = await app.request('POST', '/api/cron/snapshot')
    expect(unauth.status).toBe(401)
    expect(unauth.json.error).toMatch(/unauthorized/)

    const wrong = await app.request('POST', '/api/cron/snapshot', {
      headers: { authorization: 'Bearer WRONG' }
    })
    expect(wrong.status).toBe(401)
  })

  it('takes a nightly snapshot of the profile state', async () => {
    const state = { _ts: 100, workouts: [{ id: 'w1' }] }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state } })

    const res = await app.request('POST', '/api/cron/snapshot', {
      headers: { authorization: `Bearer ${cronSecret}` }
    })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })

    const { rows } = await app.db.query('SELECT * FROM profile_snapshots WHERE profile_id = $1', [profileId])
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toEqual(state)
  })

  it('an unchanged profile produces no new snapshot', async () => {
    const state = { _ts: 100, workouts: [{ id: 'w1' }] }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state } })

    // Night 1 snapshot
    await app.request('POST', '/api/cron/snapshot', {
      headers: { authorization: `Bearer ${cronSecret}` }
    })

    // Advance 24 hours to Night 2 with no changes made
    app.clock.advance(24 * 3600 * 1000)
    await app.request('POST', '/api/cron/snapshot', {
      headers: { authorization: `Bearer ${cronSecret}` }
    })

    // Snapshot count is still 1
    const { rows } = await app.db.query('SELECT * FROM profile_snapshots WHERE profile_id = $1', [profileId])
    expect(rows).toHaveLength(1)

    // Now update profile state
    const updatedState = { _ts: 200, workouts: [{ id: 'w1' }, { id: 'w2' }] }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: updatedState } })

    // Advance 24 hours to Night 3
    app.clock.advance(24 * 3600 * 1000)
    await app.request('POST', '/api/cron/snapshot', {
      headers: { authorization: `Bearer ${cronSecret}` }
    })

    // Snapshot count is now 2
    const { rows: rowsAfter } = await app.db.query('SELECT * FROM profile_snapshots WHERE profile_id = $1 ORDER BY created_at ASC', [profileId])
    expect(rowsAfter).toHaveLength(2)
    expect(rowsAfter[0].state).toEqual(state)
    expect(rowsAfter[1].state).toEqual(updatedState)
  })

  it('prunes snapshots older than 30 days and keeps newer ones', async () => {
    // Insert an old snapshot from 31 days ago directly
    const oldDate = new Date(app.clock.now() - 31 * 86400 * 1000).toISOString()
    await app.db.query(
      'INSERT INTO profile_snapshots (profile_id, state, created_at) VALUES ($1, $2, $3)',
      [profileId, { _ts: 1 }, oldDate]
    )

    // Save live data and run snapshot cron today
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: { _ts: 2 } } })
    await app.request('POST', '/api/cron/snapshot', {
      headers: { authorization: `Bearer ${cronSecret}` }
    })

    const { rows } = await app.db.query('SELECT * FROM profile_snapshots WHERE profile_id = $1', [profileId])
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toEqual({ _ts: 2 })
  })

  it('verifies restore instructions against the database and handler seam', async () => {
    // 1. Initial good state
    const originalState = { _ts: 100, workouts: [{ id: 'w-important', name: 'Original Workout' }] }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: originalState } })

    // 2. Snapshot is taken
    await app.request('POST', '/api/cron/snapshot', {
      headers: { authorization: `Bearer ${cronSecret}` }
    })

    const { rows: snapshots } = await app.db.query(
      'SELECT id FROM profile_snapshots WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 1',
      [profileId]
    )
    const snapshotId = snapshots[0].id

    // 3. User accidentally modifies or overwrites data
    const corruptedState = { _ts: 999, workouts: [] }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: corruptedState } })

    // Verify data is currently corrupted
    const corruptedGet = await app.request('GET', '/api/data', { headers: { cookie } })
    expect(corruptedGet.json.state).toEqual(corruptedState)

    // 4. Execute the documented restore step from docs/restore.md
    await app.db.query(
      `INSERT INTO profile_data (profile_id, state, updated_at)
       SELECT profile_id, state, now()
         FROM profile_snapshots
        WHERE id = $1
       ON CONFLICT (profile_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [snapshotId]
    )

    // 5. Verify live GET /api/data returns the restored state completely
    const restoredGet = await app.request('GET', '/api/data', { headers: { cookie } })
    expect(restoredGet.status).toBe(200)
    expect(restoredGet.json.state).toEqual(originalState)
  })
})

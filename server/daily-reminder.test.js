import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthenticator } from './test/support/authenticator.js'
import { createTestApp, fakeClock } from './test/support/app.js'

describe('Daily reminder', () => {
  let app, cookie, profileId
  const cronSecret = 'test-cron-secret'

  // 2026-10-04 is a Sunday (day 0)
  const sundayMorning = Date.parse('2026-10-04T07:59:00Z')

  beforeEach(async () => {
    const clock = fakeClock(sundayMorning)
    app = await createTestApp({
      clock,
      config: {
        setupCode: 'REMINDER-CODE',
        cronSecret,
        vapidPublicKey: 'test-vapid-key'
      }
    })
    const phone = createAuthenticator()
    const { json: reg } = await app.request('POST', '/api/register/options', {
      body: { name: 'Owner', code: 'REMINDER-CODE' }
    })
    const res = await app.request('POST', '/api/register/verify', {
      body: { cid: reg.cid, credential: phone.createCredential(reg.options) }
    })
    cookie = res.headers['Set-Cookie'].split(';')[0]
    profileId = res.json.user.id

    // Subscribe to push
    await app.request('POST', '/api/push/subscribe', {
      headers: { cookie },
      body: {
        subscription: {
          endpoint: 'https://push.example.com/sub/1',
          keys: { p256dh: 'pk', auth: 'auth' }
        }
      }
    })
  })

  const baseState = {
    reminder: { on: true, time: '08:00', tz: 'UTC' },
    routines: [{ id: 'r-pull', name: 'Pull Day', emoji: '💪' }],
    week: ['r-pull', null, null, null, null, null, null], // Sunday = r-pull
    workouts: []
  }

  it('fires inside the grace window; not before the chosen time, not after the window', async () => {
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: baseState } })

    // At 07:59:00 (1 minute before 08:00) -> should NOT fire
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(0)

    // Advance 1 minute to 08:00:00 -> fires!
    app.clock.advance(60 * 1000)
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(1)
    expect(app.push.sent[0].payload.title).toBe('💪 Pull Day today')
    expect(app.push.sent[0].payload.tag).toBe('day-reminder')
  })

  it('does not fire after the 15-minute grace window has passed', async () => {
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: baseState } })

    // Advance past 08:15 (e.g. to 08:16:00 = 17 minutes from 07:59)
    app.clock.advance(17 * 60 * 1000)
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(0)
  })

  it('at most one reminder per day, including when the sweep runs twice', async () => {
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: baseState } })

    // Advance to 08:00:00
    app.clock.advance(60 * 1000)
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(1)

    // Sweep runs again at 08:05:00
    app.clock.advance(5 * 60 * 1000)
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(1) // Still exactly 1
  })

  it('uses the profile timezone and skips an invalid timezone string', async () => {
    // 08:00 in America/New_York (UTC-4) corresponds to 12:00 UTC
    const nyState = {
      ...baseState,
      reminder: { on: true, time: '08:00', tz: 'America/New_York' }
    }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: nyState } })

    // At 08:00 UTC, it is 04:00 in NY -> should not fire
    app.clock.advance(60 * 1000)
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(0)

    // Advance 4 hours to 12:00 UTC (08:00 in NY) -> fires!
    app.clock.advance(4 * 3600 * 1000)
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(1)

    // Invalid timezone skips without throwing
    const invalidTzState = {
      ...baseState,
      reminder: { on: true, time: '08:00', tz: 'Bad/Timezone' }
    }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: invalidTzState } })
    const res = await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(res.status).toBe(200)
  })

  it('no reminder on a rest day, with a rest override, or when a workout is already logged today', async () => {
    // 1. Rest day in weekly plan (Monday Oct 5 has no routine)
    const mondayState = {
      ...baseState,
      week: [null, null, null, null, null, null, null]
    }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: mondayState } })
    app.clock.advance(60 * 1000) // 08:00 UTC
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(0)

    // 2. Rest day override for today
    const restOverrideState = {
      ...baseState,
      dayPlan: { '2026-10-04': 'rest' }
    }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: restOverrideState } })
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(0)

    // 3. Workout already logged today
    const workoutLoggedState = {
      ...baseState,
      workouts: [{ d: '2026-10-04', routine: 'Pull Day' }]
    }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: workoutLoggedState } })
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(0)
  })

  it('the reminder names the planned routine and falls back gracefully when emoji is omitted', async () => {
    const routineWithoutEmoji = {
      ...baseState,
      routines: [{ id: 'r-pull', name: 'Pull Day' }] // no emoji
    }
    await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: routineWithoutEmoji } })
    app.clock.advance(60 * 1000) // 08:00 UTC
    await app.request('POST', '/api/cron/sweep', { headers: { authorization: `Bearer ${cronSecret}` } })
    expect(app.push.sent).toHaveLength(1)
    expect(app.push.sent[0].payload.title).toBe('🏋️ Pull Day today')
  })
})

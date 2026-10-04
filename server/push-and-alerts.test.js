import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthenticator } from './test/support/authenticator.js'
import { createTestApp } from './test/support/app.js'

describe('Push subscriptions and rest alerts', () => {
  let app, cookie, profileId
  const cronSecret = 'test-cron-secret'

  beforeEach(async () => {
    app = await createTestApp({
      config: {
        setupCode: 'PUSH-CODE',
        cronSecret,
        vapidPublicKey: 'test-vapid-key'
      }
    })
    const phone = createAuthenticator()
    const { json: reg } = await app.request('POST', '/api/register/options', {
      body: { name: 'Owner', code: 'PUSH-CODE' }
    })
    const res = await app.request('POST', '/api/register/verify', {
      body: { cid: reg.cid, credential: phone.createCredential(reg.options) }
    })
    cookie = res.headers['Set-Cookie'].split(';')[0]
    profileId = res.json.user.id
  })

  const dummySub = {
    endpoint: 'https://push.example.com/sub/123',
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=',
      auth: 'tBHItJI5svbpez7KI4CCXg=='
    }
  }

  describe('Public key and subscription management', () => {
    it('returns the configured VAPID public key', async () => {
      const res = await app.request('GET', '/api/push/public-key')
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ key: 'test-vapid-key' })
    })

    it('refuses subscribe, unsubscribe and test notification when unauthenticated', async () => {
      expect((await app.request('POST', '/api/push/subscribe', { body: { subscription: dummySub } })).status).toBe(401)
      expect((await app.request('POST', '/api/push/unsubscribe', { body: { endpoint: dummySub.endpoint } })).status).toBe(401)
      expect((await app.request('POST', '/api/push/test')).status).toBe(401)
    })

    it('subscribes, sends test notification, and unsubscribes', async () => {
      const subRes = await app.request('POST', '/api/push/subscribe', {
        headers: { cookie },
        body: { subscription: dummySub }
      })
      expect(subRes.status).toBe(200)
      expect(subRes.json).toEqual({ ok: true })

      const { rows } = await app.db.query('SELECT * FROM push_subscriptions WHERE profile_id = $1', [profileId])
      expect(rows).toHaveLength(1)
      expect(rows[0].endpoint).toBe(dummySub.endpoint)

      // Test notification
      const testRes = await app.request('POST', '/api/push/test', { headers: { cookie } })
      expect(testRes.status).toBe(200)
      expect(app.push.sent).toHaveLength(1)
      expect(app.push.sent[0].subscription.endpoint).toBe(dummySub.endpoint)
      expect(app.push.sent[0].payload.tag).toBe('test')

      // Unsubscribe
      const unsubRes = await app.request('POST', '/api/push/unsubscribe', {
        headers: { cookie },
        body: { endpoint: dummySub.endpoint }
      })
      expect(unsubRes.status).toBe(200)

      const { rows: rowsAfter } = await app.db.query('SELECT * FROM push_subscriptions WHERE profile_id = $1', [profileId])
      expect(rowsAfter).toHaveLength(0)
    })

    it('removes dead subscriptions when the push service reports them gone (410 or 404)', async () => {
      await app.request('POST', '/api/push/subscribe', {
        headers: { cookie },
        body: { subscription: dummySub }
      })

      app.push.failWith(410)

      await app.request('POST', '/api/push/test', { headers: { cookie } })

      const { rows } = await app.db.query('SELECT * FROM push_subscriptions WHERE profile_id = $1', [profileId])
      expect(rows).toHaveLength(0)
    })
  })

  describe('Rest alert delivery', () => {
    beforeEach(async () => {
      await app.request('POST', '/api/push/subscribe', {
        headers: { cookie },
        body: { subscription: dummySub }
      })
    })

    it('delivers a short rest alert once at its due time', async () => {
      const start = app.clock.now()
      const res = await app.request('POST', '/api/push/rest-timer', {
        headers: { cookie },
        body: { seconds: 30 }
      })
      expect(res.status).toBe(200)
      expect(res.json).toEqual({ ok: true })

      // Fake clock was advanced by 30 seconds
      expect(app.clock.now() - start).toBe(30000)

      // Alert delivered
      expect(app.push.sent).toHaveLength(1)
      expect(app.push.sent[0].payload.title).toMatch(/Rest over/)
      expect(app.push.sent[0].payload.tag).toBe('rest-timer')

      // Alert row has been claimed and deleted
      const { rows } = await app.db.query('SELECT * FROM rest_alerts WHERE profile_id = $1', [profileId])
      expect(rows).toHaveLength(0)
    })

    it('a newer alert replaces a pending one and cancels earlier delivery', async () => {
      let resolveFirst
      let customSleep
      const enteredFirstSleep = new Promise(r => {
        customSleep = ms => {
          if (ms === 30000) {
            return new Promise(resolve => {
              resolveFirst = resolve
              r()
            })
          }
          return Promise.resolve()
        }
      })

      const { createHandler } = await import('./handler.js')
      const handler = createHandler({
        db: app.db,
        clock: app.clock,
        sleep: ms => customSleep(ms),
        push: app.push,
        config: app.config
      })

      // Start first alert (30s)
      const p1 = handler({
        method: 'POST',
        url: '/api/push/rest-timer',
        headers: { cookie },
        body: JSON.stringify({ seconds: 30 })
      })

      await enteredFirstSleep

      // Immediately start second alert (60s) which replaces the first
      await app.request('POST', '/api/push/rest-timer', {
        headers: { cookie },
        body: { seconds: 60 }
      })

      // Wake first sleep
      app.clock.advance(30000)
      resolveFirst()
      await p1

      // First alert must NOT have sent a push because it was replaced!
      expect(app.push.sent).toHaveLength(1) // only the second one sent
    })

    it('a cancelled alert is never sent', async () => {
      let resolveFirst
      let customSleep
      const enteredSleep = new Promise(r => {
        customSleep = () => new Promise(resolve => {
          resolveFirst = resolve
          r()
        })
      })

      const { createHandler } = await import('./handler.js')
      const handler = createHandler({
        db: app.db,
        clock: app.clock,
        sleep: ms => customSleep(ms),
        push: app.push,
        config: app.config
      })

      const p1 = handler({
        method: 'POST',
        url: '/api/push/rest-timer',
        headers: { cookie },
        body: JSON.stringify({ seconds: 30 })
      })

      await enteredSleep

      // Cancel the alert
      const cancelRes = await app.request('POST', '/api/push/rest-timer/cancel', { headers: { cookie } })
      expect(cancelRes.status).toBe(200)

      // Wake first sleep
      app.clock.advance(30000)
      resolveFirst()
      await p1

      // Nothing sent
      expect(app.push.sent).toHaveLength(0)
    })

    it('delivers a long rest (> 10m) via the cron sweep', async () => {
      // 15 minutes = 900 seconds
      const res = await app.request('POST', '/api/push/rest-timer', {
        headers: { cookie },
        body: { seconds: 900 }
      })
      expect(res.status).toBe(200)

      // Did not hold or send immediately
      expect(app.push.sent).toHaveLength(0)

      // Sweep before due time sends nothing
      app.clock.advance(800 * 1000)
      await app.request('POST', '/api/cron/sweep', {
        headers: { authorization: `Bearer ${cronSecret}` }
      })
      expect(app.push.sent).toHaveLength(0)

      // Advance past 900 seconds
      app.clock.advance(101 * 1000)
      const sweepRes = await app.request('POST', '/api/cron/sweep', {
        headers: { authorization: `Bearer ${cronSecret}` }
      })
      expect(sweepRes.status).toBe(200)

      expect(app.push.sent).toHaveLength(1)
      expect(app.push.sent[0].payload.tag).toBe('rest-timer')

      // Running sweep again sends nothing (idempotent / safe to run twice)
      await app.request('POST', '/api/cron/sweep', {
        headers: { authorization: `Bearer ${cronSecret}` }
      })
      expect(app.push.sent).toHaveLength(1)
    })

    it('a held function and the sweep racing on one alert send exactly one push', async () => {
      let resolveSleep
      let customSleep
      const enteredSleep = new Promise(r => {
        customSleep = () => new Promise(resolve => {
          resolveSleep = resolve
          r()
        })
      })

      const { createHandler } = await import('./handler.js')
      const handler = createHandler({
        db: app.db,
        clock: app.clock,
        sleep: ms => customSleep(ms),
        push: app.push,
        config: app.config
      })

      // Start short rest
      const p1 = handler({
        method: 'POST',
        url: '/api/push/rest-timer',
        headers: { cookie },
        body: JSON.stringify({ seconds: 30 })
      })

      await enteredSleep

      // Clock advances to due time
      app.clock.advance(30000)

      // Sweep runs first and claims alert
      await app.request('POST', '/api/cron/sweep', {
        headers: { authorization: `Bearer ${cronSecret}` }
      })
      expect(app.push.sent).toHaveLength(1)

      // Now held function wakes up
      resolveSleep()
      await p1

      // Total pushes remains exactly 1
      expect(app.push.sent).toHaveLength(1)
    })
  })

  describe('Cron endpoint authorization', () => {
    it('refuses requests without the cron secret with 401', async () => {
      const res = await app.request('POST', '/api/cron/sweep')
      expect(res.status).toBe(401)
      expect(res.json.error).toMatch(/unauthorized/)

      const wrongSecret = await app.request('POST', '/api/cron/sweep', {
        headers: { authorization: 'Bearer WRONG-SECRET' }
      })
      expect(wrongSecret.status).toBe(401)
    })

    it('accepts GET and POST with correct bearer token', async () => {
      const getRes = await app.request('GET', '/api/cron/sweep', {
        headers: { authorization: `Bearer ${cronSecret}` }
      })
      expect(getRes.status).toBe(200)
      expect(getRes.json).toEqual({ ok: true })

      const postRes = await app.request('POST', '/api/cron/sweep', {
        headers: { authorization: `Bearer ${cronSecret}` }
      })
      expect(postRes.status).toBe(200)
      expect(postRes.json).toEqual({ ok: true })
    })
  })
})

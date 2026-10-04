/* The real (non-test) collaborators, shared by the two entry points (api/index.js, scripts/dev-api.mjs). */
import webpush from 'web-push'

export const systemClock = { now: () => Date.now() }

export const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function createPushSender({ publicKey, privateKey, subject } = {}) {
  if (!publicKey || !privateKey) {
    return {
      send: async () => { throw new Error('push is not configured (missing VAPID keys)') }
    }
  }
  return {
    send: async (subscription, payload) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      await webpush.sendNotification(
        subscription,
        body,
        {
          vapidDetails: {
            subject: subject || 'mailto:admin@localhost',
            publicKey,
            privateKey
          },
          urgency: 'high'
        }
      )
    }
  }
}

export const unconfiguredPush = createPushSender()

/** Loads .env.local (what `vercel env pull` writes) into process.env when it exists. */
export function loadLocalEnv() {
  try { process.loadEnvFile('.env.local') } catch { /* no .env.local: use the real environment */ }
}

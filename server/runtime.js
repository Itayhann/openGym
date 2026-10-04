/* The real (non-test) collaborators, shared by the two entry points (api/index.js, scripts/dev-api.mjs). */
export const systemClock = { now: () => Date.now() }

export const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The real Web Push sender arrives with the push work (#6); until then sending fails loudly.
export const unconfiguredPush = { send: async () => { throw new Error('push is not configured yet') } }

/** Loads .env.local (what `vercel env pull` writes) into process.env when it exists. */
export function loadLocalEnv() {
  try { process.loadEnvFile('.env.local') } catch { /* no .env.local: use the real environment */ }
}

/* Turns environment variables into the handler's `config`. Everything instance-specific comes from
 * here (set in Vercel's project settings in production); nothing falls back to a hard-coded host,
 * because a passkey is bound to its hostname and a wrong guess would silently lock the owner out. */
export function loadConfig(env = process.env) {
  const missing = ['RP_ID', 'ORIGIN'].filter(k => !env[k]?.trim())
  if (missing.length) throw new Error(`missing required environment variable(s): ${missing.join(', ')}`)
  const maxProfiles = Math.floor(Number(env.MAX_PROFILES))
  return {
    rpId: env.RP_ID.trim(),
    origin: env.ORIGIN.trim(),
    rpName: env.RP_NAME?.trim() || 'openGym',
    // Unset or blank means registration is closed, never open.
    setupCode: env.SETUP_CODE?.trim() || null,
    maxProfiles: maxProfiles >= 1 ? maxProfiles : 1
  }
}

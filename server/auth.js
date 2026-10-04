import crypto from 'node:crypto'

/**
 * Constant-time comparison for the setup code.
 * Hashes both sides with SHA-256 first to ensure equal length before timingSafeEqual.
 */
export function verifySetupCode(providedCode, configuredCode) {
  if (!configuredCode || typeof providedCode !== 'string' || !providedCode) return false
  const a = crypto.createHash('sha256').update(providedCode).digest()
  const b = crypto.createHash('sha256').update(configuredCode).digest()
  return crypto.timingSafeEqual(a, b)
}

export function signToken(payload, secret) {
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null
  const i = token.lastIndexOf('.')
  if (i < 0) return null
  const payload = token.slice(0, i)
  const mac = token.slice(i + 1)
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  const macBuf = Buffer.from(mac)
  const expBuf = Buffer.from(expected)
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return null
  return payload
}

export function parseCookies(headers = {}) {
  const cookieHeader = headers.cookie || headers.Cookie || ''
  const cookies = {}
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=')
    if (idx > -1) {
      cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
    }
  }
  return cookies
}

export function sessionCookie(profile, config, clock) {
  const maxAge = config.sessionDays * 86400
  const exp = clock.now() + maxAge * 1000
  const token = signToken(`${profile.id}:${exp}:${profile.session_version || 0}`, config.sessionSecret)
  const secure = /^https:/i.test(config.origin) ? '; Secure' : ''
  return `gymsid=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
}

export function clearCookie(config) {
  const secure = /^https:/i.test(config.origin) ? '; Secure' : ''
  return `gymsid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`
}

export async function readSession(req, { db, clock, config }) {
  const cookies = parseCookies(req.headers)
  const tok = cookies.gymsid
  if (!tok) return null
  const payload = verifyToken(tok, config.sessionSecret)
  if (!payload) return null
  const parts = payload.split(':')
  if (parts.length < 2) return null
  const [profileId, expStr, verStr] = parts
  const exp = Number(expStr)
  if (!profileId || !Number.isFinite(exp) || exp < clock.now()) return null
  const claimedVersion = verStr === undefined ? 0 : Number(verStr)
  if (!Number.isInteger(claimedVersion)) return null

  const { rows } = await db.query(
    'SELECT id, name, disabled, session_version FROM profiles WHERE id = $1',
    [profileId]
  )
  const profile = rows[0]
  if (!profile || profile.disabled) return null
  if (profile.session_version !== claimedVersion) return null
  return profile
}

export async function getRegistrationEligibility(db, config) {
  if (!config.setupCode) return { canRegister: false, profiles: 0, withoutPasskey: 0 }
  const { rows } = await db.query(
    `SELECT count(*)::int AS profiles,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM passkeys k WHERE k.profile_id = p.id))::int AS without_passkey
       FROM profiles p`
  )
  const { profiles, without_passkey } = rows[0]
  const canRegister = profiles < config.maxProfiles || without_passkey > 0
  return { canRegister, profiles, withoutPasskey: without_passkey }
}

import { describe, expect, it } from 'vitest'
import {
  clearCookie,
  parseCookies,
  sessionCookie,
  signToken,
  verifySetupCode,
  verifyToken
} from './auth.js'

describe('auth primitives', () => {
  describe('verifySetupCode', () => {
    it('accepts matching codes', () => {
      expect(verifySetupCode('secret123', 'secret123')).toBe(true)
    })

    it('rejects non-matching codes or different lengths', () => {
      expect(verifySetupCode('secret123', 'secret456')).toBe(false)
      expect(verifySetupCode('short', 'longer-secret')).toBe(false)
    })

    it('rejects empty, null, or undefined codes', () => {
      expect(verifySetupCode('', 'secret123')).toBe(false)
      expect(verifySetupCode(null, 'secret123')).toBe(false)
      expect(verifySetupCode(undefined, 'secret123')).toBe(false)
      expect(verifySetupCode('secret123', null)).toBe(false)
      expect(verifySetupCode('secret123', '')).toBe(false)
    })
  })

  describe('signToken and verifyToken', () => {
    const secret = 'super-secret-key-32-chars-at-least'

    it('signs and verifies payload correctly', () => {
      const token = signToken('user-1:1234567890:0', secret)
      expect(verifyToken(token, secret)).toBe('user-1:1234567890:0')
    })

    it('rejects tampered signature', () => {
      const token = signToken('user-1:1234567890:0', secret)
      const tampered = token.slice(0, -4) + 'abcd'
      expect(verifyToken(tampered, secret)).toBeNull()
    })

    it('rejects tampered payload', () => {
      const token = signToken('user-1:1234567890:0', secret)
      const i = token.lastIndexOf('.')
      const tampered = 'user-2:1234567890:0' + token.slice(i)
      expect(verifyToken(tampered, secret)).toBeNull()
    })

    it('rejects tokens signed with a different secret', () => {
      const token = signToken('user-1:1234567890:0', secret)
      expect(verifyToken(token, 'other-secret-key')).toBeNull()
    })

    it('rejects malformed tokens', () => {
      expect(verifyToken('no-dot-token', secret)).toBeNull()
      expect(verifyToken('', secret)).toBeNull()
      expect(verifyToken(null, secret)).toBeNull()
    })
  })

  describe('parseCookies', () => {
    it('extracts cookies from Cookie header', () => {
      const cookies = parseCookies({ cookie: 'gymsid=abc; other=xyz; theme=dark' })
      expect(cookies).toEqual({ gymsid: 'abc', other: 'xyz', theme: 'dark' })
    })

    it('handles empty or missing header', () => {
      expect(parseCookies({})).toEqual({})
      expect(parseCookies({ cookie: '' })).toEqual({})
    })
  })

  describe('cookie formatting', () => {
    const profile = { id: 'p1', session_version: 0 }
    const clock = { now: () => 1700000000000 }

    it('formats session cookie for https origin with Secure attribute', () => {
      const config = {
        origin: 'https://opengym.test',
        sessionSecret: 'secret',
        sessionDays: 90
      }
      const cookie = sessionCookie(profile, config, clock)
      expect(cookie).toMatch(/^gymsid=p1:1707776000000:0\.[A-Za-z0-9_-]+; Path=\/; Max-Age=7776000; HttpOnly; SameSite=Lax; Secure$/)
    })

    it('formats session cookie for http origin without Secure attribute', () => {
      const config = {
        origin: 'http://localhost:3000',
        sessionSecret: 'secret',
        sessionDays: 30
      }
      const cookie = sessionCookie(profile, config, clock)
      expect(cookie).toMatch(/^gymsid=p1:1702592000000:0\.[A-Za-z0-9_-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/)
      expect(cookie).not.toContain('Secure')
    })

    it('formats clearCookie with Max-Age=0', () => {
      expect(clearCookie({ origin: 'https://opengym.test' })).toBe('gymsid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure')
      expect(clearCookie({ origin: 'http://localhost:3000' })).toBe('gymsid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
    })
  })
})

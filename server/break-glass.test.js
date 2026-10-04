import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthenticator } from './test/support/authenticator.js'
import { createTestApp, fakeClock } from './test/support/app.js'
import {
  extractHost,
  verifyConfirmation,
  resetPasskeys,
  executeBreakGlass
} from './break-glass.js'
import { parseArgs } from '../scripts/break-glass-reset.mjs'


describe('Break-glass passkey reset', () => {
  describe('host extraction and confirmation', () => {
    it('extracts hostname from postgres connection string', () => {
      expect(
        extractHost('postgres://user:pass@ep-silent-hill-12345.us-east-2.aws.neon.tech/neondb?sslmode=require')
      ).toBe('ep-silent-hill-12345.us-east-2.aws.neon.tech')

      expect(extractHost('postgresql://app:secret@db.internal:5432/production')).toBe('db.internal')
      expect(extractHost('invalid-uri')).toBeNull()
      expect(extractHost('')).toBeNull()
      expect(extractHost(null)).toBeNull()
    })

    it('verifies confirmation matches target host (case-insensitive, trimmed)', () => {
      expect(verifyConfirmation('ep-cool.neon.tech', 'ep-cool.neon.tech')).toBe(true)
      expect(verifyConfirmation('ep-cool.neon.tech', '  EP-COOL.neon.tech  ')).toBe(true)
      expect(verifyConfirmation('ep-cool.neon.tech', 'ep-other.neon.tech')).toBe(false)
      expect(verifyConfirmation('ep-cool.neon.tech', 'yes')).toBe(false)
      expect(verifyConfirmation('ep-cool.neon.tech', '')).toBe(false)
      expect(verifyConfirmation('ep-cool.neon.tech', null)).toBe(false)
    })

    it('parses CLI arguments for --confirm', () => {
      expect(parseArgs(['--confirm', 'target.db.host'])).toEqual({ confirmHost: 'target.db.host' })
      expect(parseArgs(['--confirm=target.db.host'])).toEqual({ confirmHost: 'target.db.host' })
      expect(parseArgs([])).toEqual({ confirmHost: null })
    })
  })

  describe('database and session observable effects', () => {
    let app, cookie, profileId
    const setupCode = 'BREAK-GLASS-CODE'
    const targetHost = 'ep-test-db.neon.tech'
    const connectionString = `postgres://user:pass@${targetHost}/neondb`
    const initialData = { _ts: 12345, workouts: [{ id: 'w1', name: 'Deadlift Day' }] }

    beforeEach(async () => {
      app = await createTestApp({
        clock: fakeClock(),
        config: { setupCode }
      })

      // Register initial owner profile
      const phone = createAuthenticator()
      const { json: reg } = await app.request('POST', '/api/register/options', {
        body: { name: 'Owner', code: setupCode }
      })
      const res = await app.request('POST', '/api/register/verify', {
        body: { cid: reg.cid, credential: phone.createCredential(reg.options) }
      })
      cookie = res.headers['Set-Cookie'].split(';')[0]
      profileId = res.json.user.id

      // Save initial profile data
      await app.request('PUT', '/api/data', { headers: { cookie }, body: { state: initialData } })
    })

    it('refuses to run without explicit confirmation of the target host', async () => {
      // 1. Omitted / empty confirmation
      await expect(
        executeBreakGlass({
          connectionString,
          confirmedHost: '',
          db: app.db,
          log: () => {}
        })
      ).rejects.toThrow(/confirmation "" does not match target host/i)

      // 2. Wrong hostname typed (e.g. typing "yes" instead of host)
      await expect(
        executeBreakGlass({
          connectionString,
          confirmedHost: 'yes',
          db: app.db,
          log: () => {}
        })
      ).rejects.toThrow(/confirmation "yes" does not match target host/i)

      // 3. Different host typed
      await expect(
        executeBreakGlass({
          connectionString,
          confirmedHost: 'other-host.neon.tech',
          db: app.db,
          log: () => {}
        })
      ).rejects.toThrow(/confirmation "other-host.neon.tech" does not match target host/i)

      // Observable effect: passkeys still exist, session is still valid, data untouched
      const { rows: passkeys } = await app.db.query('SELECT * FROM passkeys WHERE profile_id = $1', [profileId])
      expect(passkeys.length).toBe(1)

      const meRes = await app.request('GET', '/api/me', { headers: { cookie } })
      expect(meRes.status).toBe(200)

      const dataRes = await app.request('GET', '/api/data', { headers: { cookie } })
      expect(dataRes.json.state).toEqual(initialData)
    })

    it('after running: passkeys are gone, old sessions are invalid, and profile data is unchanged', async () => {
      const logs = []
      const result = await executeBreakGlass({
        connectionString,
        confirmedHost: targetHost,
        db: app.db,
        log: msg => logs.push(msg)
      })

      expect(result.ok).toBe(true)
      expect(result.passkeysDeleted).toBe(1)
      expect(result.profilesReset).toHaveLength(1)
      expect(result.profilesReset[0].id).toBe(profileId)

      // 1. Passkeys are gone
      const { rows: passkeysAfter } = await app.db.query('SELECT * FROM passkeys WHERE profile_id = $1', [profileId])
      expect(passkeysAfter).toHaveLength(0)

      // 2. Old session cookie is rejected
      const meAfter = await app.request('GET', '/api/me', { headers: { cookie } })
      expect(meAfter.status).toBe(401)

      const dataAfter = await app.request('GET', '/api/data', { headers: { cookie } })
      expect(dataAfter.status).toBe(401)

      // 3. Profile and profile_data are unchanged in database
      const { rows: profileRows } = await app.db.query('SELECT * FROM profiles WHERE id = $1', [profileId])
      expect(profileRows).toHaveLength(1)
      expect(profileRows[0].name).toBe('Owner')
      expect(profileRows[0].session_version).toBe(1) // incremented from 0

      const { rows: dataRows } = await app.db.query('SELECT * FROM profile_data WHERE profile_id = $1', [profileId])
      expect(dataRows).toHaveLength(1)
      expect(dataRows[0].state).toEqual(initialData)
    })

    it('after running, registering with a valid setup code attaches a new passkey to the same profile', async () => {
      // Execute break glass reset
      await executeBreakGlass({
        connectionString,
        confirmedHost: targetHost,
        db: app.db,
        log: () => {}
      })

      // 1. Public config indicates registration is open for re-enrolment
      const configRes = await app.request('GET', '/api/config')
      expect(configRes.json).toEqual({ invite_only: true })

      // 2. Re-enrol with a new phone authenticator and the setup code
      const newPhone = createAuthenticator()
      const optRes = await app.request('POST', '/api/register/options', {
        body: { name: 'Owner New Device', code: setupCode }
      })
      expect(optRes.status).toBe(200)

      const verifyRes = await app.request('POST', '/api/register/verify', {
        body: {
          cid: optRes.json.cid,
          credential: newPhone.createCredential(optRes.json.options)
        }
      })
      expect(verifyRes.status).toBe(200)
      expect(verifyRes.json.user.id).toBe(profileId) // MUST be the SAME profile ID

      const newCookie = verifyRes.headers['Set-Cookie'].split(';')[0]
      expect(newCookie).toBeDefined()

      // 3. Authenticate with new session and verify all original data is present
      const meNew = await app.request('GET', '/api/me', { headers: { cookie: newCookie } })
      expect(meNew.status).toBe(200)
      expect(meNew.json.user.id).toBe(profileId)

      const dataNew = await app.request('GET', '/api/data', { headers: { cookie: newCookie } })
      expect(dataNew.status).toBe(200)
      expect(dataNew.json.state).toEqual(initialData)

      // 4. Registration closes again now that profile has a passkey
      const configClosed = await app.request('GET', '/api/config')
      expect(configClosed.json).toEqual({ invite_only: false })
    })

    it('handles database with no profiles gracefully', async () => {
      await app.db.query('DELETE FROM passkeys')
      await app.db.query('DELETE FROM profile_data')
      await app.db.query('DELETE FROM profiles')

      const logs = []
      const res = await executeBreakGlass({
        connectionString,
        confirmedHost: targetHost,
        db: app.db,
        log: msg => logs.push(msg)
      })

      expect(res.ok).toBe(false)
      expect(res.reason).toBe('no_profiles')
      expect(logs).toContain('No profiles found in database. Nothing to reset.')
    })
  })

  describe('CLI script execution', () => {
    const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/break-glass-reset.mjs')

    function runScript(args = [], { env = {}, input = null } = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptPath, ...args], {
          env: { ...process.env, ...env }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => { stdout += d.toString() })
        child.stderr.on('data', d => { stderr += d.toString() })
        if (input !== null) {
          child.stdin.end(input)
        }
        child.on('close', code => {
          resolve({ code, stdout, stderr })
        })
      })
    }

    it('CLI: fails immediately when connection string is missing', async () => {
      const { code, stderr } = await runScript([], {
        env: { DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' }
      })
      expect(code).toBe(1)
      expect(stderr).toMatch(/Set DATABASE_URL_UNPOOLED/i)
    })

    it('CLI: fails when connection string host cannot be parsed', async () => {
      const { code, stderr } = await runScript([], {
        env: { DATABASE_URL: 'invalid-url' }
      })
      expect(code).toBe(1)
      expect(stderr).toMatch(/Could not parse hostname/i)
    })

    it('CLI: refuses to run when --confirm does not match target host', async () => {
      const { code, stdout, stderr } = await runScript(
        ['--confirm', 'wrong.host.neon.tech'],
        { env: { DATABASE_URL: 'postgres://user:pass@ep-valid.neon.tech/neondb' } }
      )
      expect(code).toBe(1)
      expect(stdout).toMatch(/Target host:\s+ep-valid\.neon\.tech/)
      expect(stderr).toMatch(/does not match target host/i)
    })

    it('CLI: refuses to run when confirmation is empty or mismatched via stdin', async () => {
      const { code, stdout, stderr } = await runScript([], {
        env: { DATABASE_URL: 'postgres://user:pass@ep-valid.neon.tech/neondb' },
        input: 'wrong-host\n'
      })
      expect(code).toBe(1)
      expect(stdout).toMatch(/Target host:\s+ep-valid\.neon\.tech/)
      expect(stderr).toMatch(/Refusing to run: confirmation "wrong-host" does not match target host/i)
    })
  })
})


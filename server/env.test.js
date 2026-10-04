import { describe, expect, it } from 'vitest'
import { loadConfig } from './env.js'

const base = { RP_ID: 'opengym-itay.vercel.app', ORIGIN: 'https://opengym-itay.vercel.app', DATABASE_URL: 'postgres://x' }

describe('loadConfig', () => {
  it('reads the relying party and origin from the environment, never from defaults', () => {
    const c = loadConfig(base)
    expect(c).toMatchObject({ rpId: 'opengym-itay.vercel.app', origin: 'https://opengym-itay.vercel.app', maxProfiles: 1, setupCode: null })
  })

  it('fails fast, naming every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/RP_ID.*ORIGIN|ORIGIN.*RP_ID/)
    expect(() => loadConfig({ RP_ID: 'x' })).toThrow(/ORIGIN/)
  })

  it('treats a blank setup code as unset, so registration stays closed', () => {
    expect(loadConfig({ ...base, SETUP_CODE: '   ' }).setupCode).toBeNull()
    expect(loadConfig({ ...base, SETUP_CODE: ' abc ' }).setupCode).toBe('abc')
  })

  it('reads the maximum profile count and ignores nonsense', () => {
    expect(loadConfig({ ...base, MAX_PROFILES: '3' }).maxProfiles).toBe(3)
    expect(loadConfig({ ...base, MAX_PROFILES: 'lots' }).maxProfiles).toBe(1)
    expect(loadConfig({ ...base, MAX_PROFILES: '0' }).maxProfiles).toBe(1)
  })
})

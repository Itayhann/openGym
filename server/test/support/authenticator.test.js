// The virtual authenticator is test infrastructure for every later ticket, so it is checked against
// the real verifier library the server uses: if this passes, the server will accept what it makes.
import { describe, expect, it } from 'vitest'
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse
} from '@simplewebauthn/server'
import { createAuthenticator } from './authenticator.js'
import { TEST_ORIGIN, TEST_RP_ID } from './app.js'

const register = async (authn, { userID = 'user-1' } = {}) => {
  const options = await generateRegistrationOptions({
    rpName: 'openGym', rpID: TEST_RP_ID, userID: Buffer.from(userID), userName: 'Owner',
    attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
  })
  const response = authn.createCredential(options)
  const verification = await verifyRegistrationResponse({
    response, expectedChallenge: options.challenge, expectedOrigin: TEST_ORIGIN, expectedRPID: TEST_RP_ID,
    requireUserVerification: false
  })
  return { options, response, verification }
}

describe('virtual authenticator', () => {
  it('makes a registration the server library verifies', async () => {
    const authn = createAuthenticator()
    const { response, verification } = await register(authn)
    expect(verification.verified).toBe(true)
    expect(verification.registrationInfo.credential.id).toBe(authn.credentialId)
    expect(response.id).toBe(authn.credentialId)
    expect(response.response.transports).toEqual(['internal'])
  })

  it('makes a login the server library verifies, with a rising signature counter', async () => {
    const authn = createAuthenticator()
    const { verification } = await register(authn)
    let { credential } = verification.registrationInfo

    for (const expected of [1, 2]) {
      const options = await generateAuthenticationOptions({ rpID: TEST_RP_ID, userVerification: 'preferred' })
      const response = authn.getAssertion(options)
      const result = await verifyAuthenticationResponse({
        response, expectedChallenge: options.challenge, expectedOrigin: TEST_ORIGIN, expectedRPID: TEST_RP_ID,
        requireUserVerification: false, credential
      })
      expect(result.verified).toBe(true)
      expect(result.authenticationInfo.newCounter).toBe(expected)
      credential = { ...credential, counter: result.authenticationInfo.newCounter }
      expect(response.response.userHandle).toBeTruthy()
    }
  })

  it('is rejected for the wrong challenge, origin or rp id, so tests can exercise failures', async () => {
    const authn = createAuthenticator()
    const { verification } = await register(authn)
    const { credential } = verification.registrationInfo
    const options = await generateAuthenticationOptions({ rpID: TEST_RP_ID })
    const response = authn.getAssertion(options)
    const base = { response, expectedChallenge: options.challenge, expectedOrigin: TEST_ORIGIN, expectedRPID: TEST_RP_ID, credential }
    await expect(verifyAuthenticationResponse({ ...base, expectedChallenge: 'other' })).rejects.toThrow()
    await expect(verifyAuthenticationResponse({ ...base, expectedOrigin: 'https://evil.test' })).rejects.toThrow()
    await expect(verifyAuthenticationResponse({ ...base, expectedRPID: 'evil.test' })).rejects.toThrow()
  })

  it('keeps separate authenticators distinct, as two phones would be', async () => {
    const a = createAuthenticator(), b = createAuthenticator()
    await register(a); await register(b, { userID: 'user-2' })
    expect(a.credentialId).not.toBe(b.credentialId)
  })

  it('can sign a login with another key to simulate a stranger', async () => {
    const owner = createAuthenticator()
    const { verification } = await register(owner)
    const { credential } = verification.registrationInfo
    const options = await generateAuthenticationOptions({ rpID: TEST_RP_ID })
    const forged = owner.getAssertion(options, { signWith: createAuthenticator() })
    // A bad signature resolves with verified: false rather than throwing, so routes must check it.
    const result = await verifyAuthenticationResponse({
      response: forged, expectedChallenge: options.challenge, expectedOrigin: TEST_ORIGIN, expectedRPID: TEST_RP_ID, credential
    })
    expect(result.verified).toBe(false)
  })
})

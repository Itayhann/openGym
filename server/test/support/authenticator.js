/* Virtual WebAuthn authenticator for tests: a software stand-in for the phone's keychain.
 *
 * It does what a real platform authenticator does at the wire level (ES256 key, attestation
 * "none", signed assertions, a rising signature counter), so the server's real verification code
 * runs against it, not a mock. Feed it the options the server returned and send its output back:
 *
 *   const phone = createAuthenticator()
 *   const { json: reg } = await app.request('POST', '/api/register/options', { body: { name, code } })
 *   const credential = phone.createCredential(reg.options)
 *   await app.request('POST', '/api/register/verify', { body: { cid: reg.cid, credential } })
 *
 *   const { json: login } = await app.request('POST', '/api/login/options')
 *   const assertion = phone.getAssertion(login.options)
 *   await app.request('POST', '/api/login/verify', { body: { cid: login.cid, credential: assertion } })
 *
 * Use one authenticator per simulated device. `getAssertion(options, { signWith: other })` signs
 * with a different authenticator's key to simulate a stranger presenting a known credential id.
 * Note the library throws for a wrong challenge, origin or rp id but resolves `verified: false` for
 * a bad signature, so server code has to check `verified` as well as catch.
 * Options are the JSON shapes @simplewebauthn/server produces; responses are the JSON shapes it
 * verifies. Origin and rp id default to the test app's; override them to simulate a phishing site.
 */
import crypto from 'node:crypto'
import { TEST_ORIGIN, TEST_RP_ID } from './app.js'

const b64u = buf => Buffer.from(buf).toString('base64url')
const sha256 = data => crypto.createHash('sha256').update(data).digest()

/* Just enough CBOR for an attestation object and a COSE key: unsigned/negative ints, byte and text
   strings, and maps (as Map, to keep integer keys). */
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255])
    throw new Error('cbor: length too large for test encoder')
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]) }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
  }
  throw new Error('cbor: unsupported value')
}

export function createAuthenticator({ rpId = TEST_RP_ID, origin = TEST_ORIGIN } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  const credentialIdBytes = crypto.randomBytes(32)
  const credentialId = b64u(credentialIdBytes)
  let userHandle = null
  let signCount = 0

  const coseKey = cbor(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]
  ]))
  const rpIdHash = () => sha256(rpId)
  const counterBytes = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const UP = 0x01, UV = 0x04, AT = 0x40

  const self = {
    credentialId,
    get signCount() { return signCount },
    sign: data => crypto.sign('sha256', data, privateKey),

    /** Registration: takes PublicKeyCredentialCreationOptionsJSON, returns RegistrationResponseJSON. */
    createCredential(options) {
      userHandle = options.user?.id ?? null
      const authData = Buffer.concat([
        rpIdHash(), Buffer.from([UP | UV | AT]), counterBytes(signCount),
        Buffer.alloc(16), // aaguid: all zeros, as for an authenticator that does not identify its model
        Buffer.from([credentialIdBytes.length >> 8, credentialIdBytes.length & 255]), credentialIdBytes, coseKey
      ])
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }))
      return {
        id: credentialId, rawId: credentialId, type: 'public-key', authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] }
      }
    },

    /** Login: takes PublicKeyCredentialRequestOptionsJSON, returns AuthenticationResponseJSON. */
    getAssertion(options, { signWith = self } = {}) {
      signCount += 1
      const authData = Buffer.concat([rpIdHash(), Buffer.from([UP | UV]), counterBytes(signCount)])
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }))
      const signature = signWith.sign(Buffer.concat([authData, sha256(clientDataJSON)]))
      return {
        id: credentialId, rawId: credentialId, type: 'public-key', authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle }
      }
    }
  }
  return self
}

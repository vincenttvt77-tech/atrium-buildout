import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto'

/** Test-only CBOR writer for protocol fixtures, not a production parser. */
function cbor(value) {
  const header = (major, size) => {
    if (size < 24) return Buffer.from([(major << 5) | size])
    if (size <= 0xff) return Buffer.from([(major << 5) | 24, size])
    if (size <= 0xffff) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(size, 1); return b }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(size, 1); return b
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([header(2, value.length), Buffer.from(value)])
  if (typeof value === 'string') { const b = Buffer.from(value); return Buffer.concat([header(3, b.length), b]) }
  if (Number.isSafeInteger(value)) return header(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value)
  if (value instanceof Map) return Buffer.concat([header(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])])
  throw new Error('Unsupported synthetic CBOR value')
}
const hash = value => createHash('sha256').update(value).digest()
const base64 = value => Buffer.from(value).toString('base64url')

/**
 * Actual P-256 signatures and WebAuthn wire-format responses. This fixture emulates
 * authenticator flags; it does not prove a native browser, biometric, PIN or device.
 * Registration uses unsigned `none` attestation; authentication proves possession.
 */
export class SoftwareAuthenticator {
  constructor({ credentialId = base64(randomBytes(32)), counter = 0 } = {}) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.privateKey = pair.privateKey
    this.credentialId = credentialId
    this.counter = counter
    const jwk = pair.publicKey.export({ format: 'jwk' })
    this.coseKey = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
    this.publicKey = base64(cbor(this.coseKey))
  }
  sign(bytes) { return cryptoSign('sha256', bytes, { key: this.privateKey, dsaEncoding: 'der' }) }
  clientData({ challenge, origin, type, crossOrigin = false, topOrigin }) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin, ...(topOrigin === undefined ? {} : { topOrigin }) }))
  }
  authenticatorData({ rpId, counter = this.counter, uv = true, up = true, backupEligible = false, backedUp = false, registration = false }) {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter)
    const flags = Number(up) | (Number(uv) << 2) | (Number(backupEligible) << 3) | (Number(backedUp) << 4) | (Number(registration) << 6)
    return Buffer.concat([hash(rpId), Buffer.from([flags]), count])
  }
  registrationResponse(options) {
    const { credentialId = this.credentialId, publicKey = this.coseKey, transports = ['internal'], fmt = 'none' } = options
    const id = Buffer.from(credentialId, 'base64url'), length = Buffer.alloc(2); length.writeUInt16BE(id.length)
    const authData = Buffer.concat([this.authenticatorData({ ...options, registration: true }), Buffer.alloc(16), length, id, cbor(publicKey)])
    const clientData = this.clientData({ ...options, type: options.type ?? 'webauthn.create' })
    return { id: credentialId, rawId: credentialId, type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: base64(clientData), attestationObject: base64(cbor(new Map([['fmt', fmt], ['attStmt', new Map()], ['authData', authData]]))), transports },
      clientExtensionResults: {} }
  }
  authenticationResponse(options) {
    const { credentialId = this.credentialId, userHandle, signer = this } = options
    const authData = this.authenticatorData(options)
    const clientData = this.clientData({ ...options, type: options.type ?? 'webauthn.get' })
    return { id: credentialId, rawId: credentialId, type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: base64(clientData), authenticatorData: base64(authData),
        signature: base64(signer.sign(Buffer.concat([authData, hash(clientData)]))),
        ...(userHandle === undefined ? {} : { userHandle }) }, clientExtensionResults: {} }
  }
}

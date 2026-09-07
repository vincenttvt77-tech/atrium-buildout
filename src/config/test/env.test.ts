import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { requireSecret, hasSecret, redact, checkSecrets, MissingSecretError } from '../env.ts'

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv

describe('secrets fail loudly rather than silently', () => {
  test('throws when missing', () => {
    assert.throws(() => requireSecret('VAPI_WEBHOOK_SECRET', env({})), MissingSecretError)
  })

  test('treats empty and whitespace as missing', () => {
    assert.throws(() => requireSecret('VAPI_PRIVATE_KEY', env({ VAPI_PRIVATE_KEY: '   ' })))
    assert.equal(hasSecret('VAPI_PRIVATE_KEY', env({ VAPI_PRIVATE_KEY: '' })), false)
  })

  test('the error names the secret and its purpose without revealing a value', () => {
    try {
      requireSecret('VAPI_WEBHOOK_SECRET', env({}))
      assert.fail('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      assert.match(msg, /VAPI_WEBHOOK_SECRET/)
      assert.match(msg, /never in the repo/)
    }
  })

  test('returns the value when present', () => {
    assert.equal(requireSecret('VAPI_PRIVATE_KEY', env({ VAPI_PRIVATE_KEY: 'abc123' })), 'abc123')
  })
})

describe('redaction never leaks a usable secret', () => {
  test('shows a fingerprint, not the key', () => {
    const secret = 'vapi_live_9f8e7d6c5b4a3210'
    const out = redact(secret)
    assert.ok(!out.includes('9f8e7d6c5b4a'), 'must not contain the body of the secret')
    assert.match(out, /^vapi…10 \(\d+ chars\)$/)
  })

  test('short values are fully masked', () => {
    assert.equal(redact('short'), '****')
  })
})

describe('startup check reports every gap at once', () => {
  test('lists all missing secrets together', () => {
    const r = checkSecrets(['VAPI_PRIVATE_KEY', 'VAPI_WEBHOOK_SECRET'], env({}))
    assert.equal(r.ok, false)
    assert.deepEqual(r.ok === false && r.missing, ['VAPI_PRIVATE_KEY', 'VAPI_WEBHOOK_SECRET'])
  })

  test('ok when all present', () => {
    const r = checkSecrets(['VAPI_PRIVATE_KEY'], env({ VAPI_PRIVATE_KEY: 'k' }))
    assert.equal(r.ok, true)
  })
})

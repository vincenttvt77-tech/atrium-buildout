import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mfaConfiguration } from '../mfa-config.ts'

test('RP identity comes from one exact deployment origin', () => {
  assert.deepEqual(mfaConfiguration('https://portal.atrium.example'), {
    origin: 'https://portal.atrium.example', rpId: 'portal.atrium.example', rpName: 'Atrium',
  })
  assert.equal(mfaConfiguration('http://localhost:4300').rpId, 'localhost')
  assert.equal(mfaConfiguration('https://portal.atrium.example:444').origin, 'https://portal.atrium.example:444')
})
test('ambiguous, insecure, path-bearing or IP origins fail closed', () => {
  for (const origin of [undefined, null, '', 'null', 'https://portal.atrium.example/',
    'https://portal.atrium.example/login', 'https://portal.atrium.example?x=1',
    'https://portal.atrium.example#fragment', 'https://user:password@portal.atrium.example',
    'https://portal.atrium.example:443', 'http://portal.atrium.example', 'http://localhost.evil.example',
    'http://127.0.0.1:4300', 'https://127.0.0.1', 'http://[::1]:4300',
    'https://portal.atrium.example.', 'https://-bad.example', 'https://portal..example',
    'https://UPPER.example', 'https://singlelabel', 'https://portal_atrium.example',
    'https://portal.atrium.example https://other.example']) {
    assert.throws(() => mfaConfiguration(origin), { code: 'mfa_unavailable' }, String(origin))
  }
})

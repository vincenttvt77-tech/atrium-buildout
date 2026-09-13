import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPS_COOKIE, SESSION_TTL_MS, authorizeOps, clearedSessionCookie, constantTimeEquals,
  isSecureRequest, mintSession, opsPasscode, parseCookies, sessionCookie, verifySession,
} from '../session.ts'

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
const PASS = 'a-long-random-operations-passcode'
const CONFIGURED = env({ OPS_DASHBOARD_PASSCODE: PASS })
const NOW = new Date('2026-09-07T14:00:00Z')
const LEGACY_IDENTITY = { username: 'legacy', tenantId: 'legacy', displayName: 'Operations', assistantIds: [] }

describe('the gate fails closed', () => {
  test('an unconfigured passcode authorises nobody, not even with a cookie', () => {
    const token = mintSession(NOW, PASS)
    const auth = authorizeOps({ cookie: `${OPS_COOKIE}=${token}` }, NOW, env({}))
    assert.deepEqual(auth, { ok: false, reason: 'not_configured' })
  })

  test('a whitespace-only passcode counts as unconfigured', () => {
    const auth = authorizeOps({}, NOW, env({ OPS_DASHBOARD_PASSCODE: '   ' }))
    assert.equal(auth.ok, false)
    assert.equal(opsPasscode(env({ OPS_DASHBOARD_PASSCODE: '   ' })), null)
  })

  test('a request with no credentials at all is unauthenticated', () => {
    assert.deepEqual(authorizeOps({}, NOW, CONFIGURED), { ok: false, reason: 'unauthenticated' })
  })

  test('the Vapi webhook secret does not open the dashboard', () => {
    const both = env({ OPS_DASHBOARD_PASSCODE: PASS, VAPI_WEBHOOK_SECRET: 'machine-secret' })
    const auth = authorizeOps({ 'x-vapi-secret': 'machine-secret' }, NOW, both)
    assert.equal(auth.ok, false)
  })
})

describe('sessions', () => {
  test('a freshly minted session authorises', () => {
    const token = mintSession(NOW, PASS)
    const auth = authorizeOps({ cookie: `${OPS_COOKIE}=${token}` }, NOW, CONFIGURED)
    assert.deepEqual(auth, { ok: true, via: 'session', ...LEGACY_IDENTITY })
  })

  test('expires on its own', () => {
    const token = mintSession(NOW, PASS, 60_000)
    assert.equal(verifySession(token, new Date(NOW.getTime() + 59_000), PASS), true)
    assert.equal(verifySession(token, new Date(NOW.getTime() + 61_000), PASS), false)
  })

  test('a forged expiry does not extend it — the signature covers the expiry', () => {
    const token = mintSession(NOW, PASS, 60_000)
    const signature = token.slice(token.indexOf('.') + 1)
    const forged = `${NOW.getTime() + 10 * SESSION_TTL_MS}.${signature}`
    assert.equal(verifySession(forged, NOW, PASS), false)
  })

  test('a session minted under a different passcode is rejected — rotation logs everyone out', () => {
    assert.equal(verifySession(mintSession(NOW, 'old-passcode'), NOW, PASS), false)
  })

  test('malformed tokens are rejected rather than throwing', () => {
    for (const bad of ['', '.', 'nope', '.sig', 'abc.sig', '1e400.sig', `${NOW.getTime()}.`]) {
      assert.equal(verifySession(bad, NOW, PASS), false, `should reject ${JSON.stringify(bad)}`)
    }
    assert.equal(verifySession(undefined, NOW, PASS), false)
  })
})

describe('the passcode header, for a monitor or a curl', () => {
  test('the right passcode authorises', () => {
    const auth = authorizeOps({ 'x-ops-passcode': PASS }, NOW, CONFIGURED)
    assert.deepEqual(auth, { ok: true, via: 'passcode-header', ...LEGACY_IDENTITY })
  })

  test('a near miss does not', () => {
    assert.equal(authorizeOps({ 'x-ops-passcode': `${PASS}x` }, NOW, CONFIGURED).ok, false)
    assert.equal(authorizeOps({ 'x-ops-passcode': '' }, NOW, CONFIGURED).ok, false)
  })

  test('comparison is length-independent, so it cannot be probed a character at a time', () => {
    assert.equal(constantTimeEquals('a', 'a-much-longer-value'), false)
    assert.equal(constantTimeEquals(PASS, PASS), true)
  })
})

describe('cookie parsing', () => {
  test('picks one cookie out of many', () => {
    const jar = parseCookies(`_vercel_jwt=x; ${OPS_COOKIE}=token-here; other=y`)
    assert.equal(jar[OPS_COOKIE], 'token-here')
  })

  test('survives junk without throwing', () => {
    assert.deepEqual(parseCookies(undefined), {})
    assert.deepEqual(parseCookies('; ;=novalue;'), {})
    assert.equal(parseCookies('a=%E0%A4%A')['a'], '%E0%A4%A', 'bad escapes stay raw')
  })

  test('the first value wins, so an appended duplicate cannot override it', () => {
    assert.equal(parseCookies(`${OPS_COOKIE}=real; ${OPS_COOKIE}=forged`)[OPS_COOKIE], 'real')
  })
})

describe('cookie attributes', () => {
  test('is HttpOnly, SameSite=Strict and Secure over https', () => {
    const c = sessionCookie('t', { secure: true })
    assert.match(c, /HttpOnly/)
    assert.match(c, /SameSite=Strict/)
    assert.match(c, /Secure/)
    assert.match(c, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`))
  })

  test('drops Secure only for plain-http localhost', () => {
    assert.equal(isSecureRequest({ 'x-forwarded-proto': 'https' }), true)
    assert.equal(isSecureRequest({ host: 'ghost-building.vercel.app' }), true)
    assert.equal(isSecureRequest({ host: 'localhost:3000' }), false)
    assert.ok(!sessionCookie('t', { secure: false }).includes('Secure'))
  })

  test('sign-out expires the cookie immediately', () => {
    assert.match(clearedSessionCookie({ secure: true }), /Max-Age=0/)
  })
})

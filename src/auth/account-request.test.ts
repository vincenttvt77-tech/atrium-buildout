import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from './identity.ts'
import { mintAccountFormToken, verifyAccountFormToken, isSameOriginAccountRequest } from './account-request.ts'

const now = new Date('2026-09-09T23:30:00Z'), secret = randomBytes(36).toString('base64url')
const session = { id: randomUUID(), expiresAt: now.getTime() + 8 * 60 * 60_000 }
const principal = issueAuthenticatedUser({ id: 'synthetic-user', username: 'synthetic', displayName: 'Synthetic User', status: 'active', credentialVersion: 1 }, session)
const headers = { origin: 'https://atrium.example', host: 'atrium.example', 'x-forwarded-proto': 'https',
  'x-atrium-account-action': 'change-password', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

test('account form tokens expire and cannot survive identity or credential changes', () => {
  const token = mintAccountFormToken(principal, now, secret)
  assert.equal(verifyAccountFormToken(token, principal, now, secret), true)
  assert.equal(verifyAccountFormToken(token, principal, new Date(now.getTime() + 3_600_000), secret), false)
  assert.equal(verifyAccountFormToken(token, principal, new Date(now.getTime() - 1), secret), false)
  assert.equal(verifyAccountFormToken(token, principal, now, `${secret}-wrong`), false)
  for (const changed of [{ id: 'someone-else', credentialVersion: 1 }, { id: 'synthetic-user', credentialVersion: 2 }]) {
    const other = issueAuthenticatedUser({ ...changed, username: 'synthetic', displayName: 'Synthetic', status: 'active' }, session)
    assert.equal(verifyAccountFormToken(token, other, now, secret), false)
  }
  assert.throws(() => verifyAccountFormToken(token, { ...principal }, now, secret), { code: 'unauthenticated' })
  const otherSession = issueAuthenticatedUser({ id: 'synthetic-user', username: 'synthetic', displayName: 'Synthetic User', status: 'active', credentialVersion: 1 },
    { id: randomUUID(), expiresAt: session.expiresAt })
  assert.equal(verifyAccountFormToken(token, otherSession, now, secret), false, 'a stale form cannot cross a same-account session switch')
})

test('malformed and multibyte signatures fail without throwing or authenticating', () => {
  const token = mintAccountFormToken(principal, now, secret), payload = token.split('.')[0]
  for (const invalid of [undefined, [], '', `${token}.suffix`, `${payload}.${'é'.repeat(43)}`, `${payload}.${'a'.repeat(43)}`,
    `${payload}=.${token.split('.')[1]}`, 'x'.repeat(1025)]) {
    assert.equal(verifyAccountFormToken(invalid, principal, now, secret), false)
  }
})

test('account writes require a nonsimple same-origin request and unambiguous headers', () => {
  assert.equal(isSameOriginAccountRequest(headers), true)
  assert.equal(isSameOriginAccountRequest({ ...headers, origin: 'http://127.0.0.1:4300', host: '127.0.0.1:4300', 'x-forwarded-proto': 'http' }), true)
  for (const altered of [
    { origin: undefined }, { origin: 'null' }, { origin: 'https://attacker.example' }, { origin: 'https://atrium.example/' },
    { origin: 'https://u:p@atrium.example' }, { host: ['atrium.example'] }, { origin: ['https://atrium.example'] },
    { 'x-forwarded-proto': ['https'] }, { 'sec-fetch-site': 'same-site' }, { 'x-atrium-account-action': undefined },
    { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': ['application/json'] },
    { origin: 'http://atrium.example', 'x-forwarded-proto': 'http' },
  ]) assert.equal(isSameOriginAccountRequest({ ...headers, ...altered }), false, JSON.stringify(altered))
})

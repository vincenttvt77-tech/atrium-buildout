import test from 'node:test'
import assert from 'node:assert/strict'
import type { AuthenticatedUser } from '../../auth/model.ts'
import { mintPlanningInboxCursor, readPlanningInboxCursor, planningScanLifetimeMs } from '../planning-inbox-cursor.ts'

const now = new Date('2026-09-13T12:00:00.000Z'), secret = 'synthetic-inbox-cursor-secret-for-tests'
const principal: AuthenticatedUser = { kind: 'user', userId: 'staff-one', username: 'staff', displayName: 'Synthetic Staff', credentialVersion: 1, sessionId: 'session-one' }
const scope = { organizationId: 'org-one', propertyId: 'property-one', configurationVersion: 1, permissionVersion: 'scope-one' }
const query = { limit: 25, filter: 'attention' as const, unitId: '19A' }
const before = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-09-12T12:00:00.000Z' }
const scan = { startedAt: now.getTime(), expiresAt: now.getTime() + planningScanLifetimeMs, policyVersion: 3 }
const token = () => mintPlanningInboxCursor(before, scan, principal, scope, query, now, secret)

test('a signed scan continuation preserves consumed position and original finite lifetime', () => {
  const restored = readPlanningInboxCursor(token(), principal, scope, query, new Date(now.getTime() + 1000), secret)
  assert.deepEqual(restored, { ...scan, before })
  const advanced = { ...before, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
  const next = mintPlanningInboxCursor(advanced, restored, principal, scope, query, new Date(now.getTime() + 2000), secret)
  assert.equal(readPlanningInboxCursor(next, principal, scope, query, new Date(now.getTime() + 3000), secret).expiresAt, scan.expiresAt)
})
test('continuations cannot cross user, session, credential, property, configuration or filter boundaries', () => {
  const value = token()
  const { sessionId: _sessionId, ...sessionless } = principal
  for (const changed of [{ ...principal, userId: 'other' }, { ...principal, sessionId: 'other' }, { ...principal, credentialVersion: 2 }, sessionless]) {
    assert.throws(() => readPlanningInboxCursor(value, changed, scope, query, now, secret), { code: 'planning_cursor_expired' })
  }
  for (const changed of [{ ...scope, organizationId: 'other' }, { ...scope, propertyId: 'other' }, { ...scope, configurationVersion: 2 }, { ...scope, permissionVersion: 'new' }]) {
    assert.throws(() => readPlanningInboxCursor(value, principal, changed, query, now, secret), { code: 'planning_cursor_expired' })
  }
  for (const changed of [{ ...query, filter: 'waiting' as const }, { ...query, unitId: '20A' }, { ...query, limit: 50 }]) {
    assert.throws(() => readPlanningInboxCursor(value, principal, scope, changed, now, secret), { code: 'planning_cursor_expired' })
  }
})
test('malformed, tampered, wrong-key, future and expired cursors require a fresh scan', () => {
  const value = token()
  for (const bad of ['', 'a.b.c', value.slice(0, -3), value + 'x', value.replace(/^./, value[0] === 'a' ? 'b' : 'a'), 'x'.repeat(801)]) {
    assert.throws(() => readPlanningInboxCursor(bad, principal, scope, query, now, secret), { code: 'planning_cursor_expired' })
  }
  assert.throws(() => readPlanningInboxCursor(value, principal, scope, query, now, 'different-key'), { code: 'planning_cursor_expired' })
  assert.throws(() => readPlanningInboxCursor(value, principal, scope, query, new Date(now.getTime() - 1), secret), { code: 'planning_cursor_expired' })
  assert.throws(() => readPlanningInboxCursor(value, principal, scope, query, new Date(scan.expiresAt), secret), { code: 'planning_cursor_expired' })
  assert.throws(() => mintPlanningInboxCursor(before, { ...scan, expiresAt: scan.expiresAt + 1 }, principal, scope, query, now, secret), { code: 'planning_cursor_expired' })
})

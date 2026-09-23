import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { callbackBinding, callbackOpen, callbackDeadline, callbackPolicy } from '../config.ts'
import { callbackRequest, callbackObservation, callbackSummary } from '../service.ts'
import { CallbackChallenge, CallbackTransport } from '../transport.ts'
import type { PropertySnapshot } from '../../properties/model.ts'
import type { WorkflowAction } from '../../workflows/model.ts'
const now = new Date('2026-09-23T16:00:00Z')
const binding = { enabled: true as const, organizationId: 'org', propertyId: 'property', channelId: 'website', origin: 'https://leasing.example.test',
  providerOrgId: randomUUID(), assistantId: randomUUID(), phoneNumberId: randomUUID(), assistantVersion: '23', dailyLimit: 10,
  reviewedAt: '2026-09-22T00:00:00Z', reviewExpiresAt: '2026-09-29T00:00:00Z', hours: [{ day: 3, start: 600, end: 1080 }] }
const snapshot = { organizationId: 'org', propertyId: 'property', version: 1, publishedAt: binding.reviewedAt, timeZone: 'America/New_York',
  property: { buildingName: 'Synthetic Larkin', websiteCallback: binding } } as unknown as PropertySnapshot

test('reviewed callback bindings reject hidden fields, bad ownership, expiry and unsafe origins', () => {
  assert.equal(callbackBinding(snapshot, now).assistantVersion, '23')
  for (const patch of [{ propertyId: 'foreign' }, { enabled: false }, { origin: 'http://leasing.example.test' }, { origin: 'https://127.0.0.1' },
    { origin: 'https://leasing.example.test/' }, { origin: 'https://leasing.example.test@evil.example.test' }, { assistantId: 'not-a-uuid' },
    { phoneNumberId: 'not-a-uuid' }, { dailyLimit: 51 }, { reviewExpiresAt: now.toISOString() }, { reviewedAt: '2026-09-24T00:00:00Z' },
    { hours: [{ day: 7, start: 600, end: 1080 }] }, { hours: [{ day: 3, start: 1080, end: 600 }] }, { extra: 'unreviewed' }]) {
    assert.throws(() => callbackBinding({ ...snapshot, property: { ...snapshot.property, websiteCallback: { ...binding, ...patch } } }, now), { code: 'callback_unavailable' })
  }
})
test('calling windows use property time zone and DST, with exclusive close boundary', () => {
  assert.equal(callbackOpen(binding, 'America/New_York', now), true)
  assert.equal(callbackOpen(binding, 'America/New_York', new Date('2026-09-23T22:00:00Z')), false)
  assert.equal(callbackOpen(binding, 'America/Los_Angeles', new Date('2026-09-23T16:00:00Z')), false)
  const sunday = { ...binding, hours: [{ day: 0, start: 60, end: 120 }] }
  assert.equal(callbackOpen(sunday, 'America/New_York', new Date('2026-11-01T05:30:00Z')), true)
  assert.equal(callbackOpen(sunday, 'America/New_York', new Date('2026-11-01T06:30:00Z')), true)
  assert.equal(callbackOpen(sunday, 'America/New_York', new Date('2026-11-01T07:00:00Z')), false)
})
test('consent hash changes with version, hours, routing and displayed building name', () => {
  const initial = callbackPolicy(snapshot, binding).policySha256
  assert.notEqual(callbackPolicy({ ...snapshot, version: 2 }, binding).policySha256, initial)
  assert.notEqual(callbackPolicy(snapshot, { ...binding, assistantVersion: '24' }).policySha256, initial)
  assert.notEqual(callbackPolicy({ ...snapshot, property: { ...snapshot.property, buildingName: 'Other building' } }, binding).policySha256, initial)
})
test('one-call request validation rejects unconfirmed permission and arbitrary recipients or overrides', () => {
  const input = { requestId: randomUUID(), receiptToken: 'a'.repeat(64), name: 'Ana María', phone: '+12125550123', consent: true, policySha256: 'b'.repeat(64) }
  assert.equal(callbackRequest(input).name, input.name)
  for (const patch of [{ consent: false }, { consent: 'yes' }, { phone: '2125550123' }, { name: '<script>' }, { receiptToken: 'short' }, { assistant: {} }]) {
    assert.throws(() => callbackRequest({ ...input, ...patch }), { code: 'callback_invalid_input' })
  }
})
test('Turnstile server verification binds hostname, action, widget and freshness', async () => {
  const base = { success: true, hostname: 'leasing.example.test', action: 'atrium-callback', cdata: 'website', challenge_ts: now.toISOString() }
  for (const patch of [{}, { success: false }, { hostname: 'foreign.example.test' }, { action: 'login' }, { cdata: 'other' }, { challenge_ts: '2026-09-23T15:00:00Z' }]) {
    const transport = new CallbackChallenge('synthetic-secret', (async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify'); assert.equal(init.redirect, 'error')
      assert.equal(JSON.parse(String(init.body)).remoteip, '127.0.0.1')
      return new Response(JSON.stringify({ ...base, ...patch }))
    }) as typeof fetch)
    assert.equal(await transport.verify('synthetic', binding.origin, 'website', '127.0.0.1', now), Object.keys(patch).length === 0)
  }
})
test('provider transport rejects invalid lookup IDs, redirects and oversized responses', async () => {
  let calls = 0
  const transport = new CallbackTransport('synthetic-secret', (async (_url: string, init: RequestInit) => {
    calls++; assert.equal(init.redirect, 'error'); return new Response('x'.repeat(1048577))
  }) as typeof fetch)
  await assert.rejects(() => transport.read('../foreign', AbortSignal.timeout(1000))); assert.equal(calls, 0)
  await assert.rejects(() => transport.read(randomUUID(), AbortSignal.timeout(1000))); assert.equal(calls, 1)
})
test('exact readback correlates assistant version, account, customer and outgoing disclosure', () => {
  const id = randomUUID(), action = { id: randomUUID(), providerReference: id, input: { binding, phone: '+12125550123', name: 'Ana',
    requestedAt: now.toISOString(), expiresAt: new Date(+now + 120000).toISOString(), firstMessage: 'Synthetic disclosure' } } as unknown as WorkflowAction
  const call = { id, orgId: binding.providerOrgId, type: 'outboundPhoneCall', name: 'ac-' + action.id, assistantId: binding.assistantId,
    assistantVersion: '23', phoneNumberId: binding.phoneNumberId, customer: { name: 'Ana', number: '+12125550123' },
    createdAt: now.toISOString(), status: 'queued', schedulePlan: { earliestAt: new Date(+now + 3000).toISOString(), latestAt: new Date(+now + 120000).toISOString() }, assistantOverrides: { firstMessage: 'Synthetic disclosure', firstMessageMode: 'assistant-speaks-first', maxDurationSeconds: 300 } }
  assert.equal(callbackObservation(call, action)?.status, 'queued')
  for (const patch of [{ orgId: randomUUID() }, { assistantVersion: '24' }, { name: 'foreign' }, { status: 'complete' }, { customer: { number: '+12125550124', name: 'Ana' } }, { assistantOverrides: {} }, { schedulePlan: { earliestAt: now.toISOString(), latestAt: '2026-09-24T16:00:00Z' } }]) {
    assert.equal(callbackObservation({ ...call, ...patch }, action), null)
  }
  assert.equal(callbackSummary({ ...action, state: 'succeeded', evidence: { callStatus: 'queued' } }).stage, 'queued')
  assert.equal(callbackSummary({ ...action, state: 'verifying', dispatchStarted: true }).stage, 'checking')
})

test('call readback accommodates conversation artifacts while keeping a hard response cap', async () => {
  const transport = new CallbackTransport('synthetic-secret', (async () => new Response(JSON.stringify({ id: randomUUID(), artifact: { transcript: 'synthetic '.repeat(10000) } }))) as typeof fetch)
  const result = await transport.read(randomUUID(), AbortSignal.timeout(1000))
  assert.equal(result.artifact.transcript.length, 100000)
})

test('provider scheduling expires within permission and before property closing, including DST', () => {
  assert.equal(callbackDeadline(binding, 'America/New_York', now), '2026-09-23T16:02:00.000Z')
  assert.equal(callbackDeadline(binding, 'America/New_York', new Date('2026-09-23T21:59:30Z')), '2026-09-23T21:59:59.000Z')
  assert.equal(callbackDeadline({ ...binding, hours: [{ day: 0, start: 60, end: 120 }] }, 'America/New_York', new Date('2026-11-01T06:59:30Z')), '2026-11-01T06:59:59.000Z')
})

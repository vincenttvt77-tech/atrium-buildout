import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResendTransport } from '../render.ts'
import { emailWorkflowAction, emailMessageDigest, createResendEmailConnector } from '../workflow.ts'
import { hashJson } from '../../workflows/validation.ts'
import type { WorkflowAction } from '../../workflows/model.ts'
import type { EmailMessage } from '../render.ts'

const message: EmailMessage = { to: 'prospect@example.test', from: 'Leasing <leasing@example.test>',
  subject: 'Tour confirmation', html: '<p>A confirmed synthetic tour.</p>' }
const stamp = '2026-09-22T12:00:00.000Z'
const id = 'cbcd2156-9273-4f31-945c-dba617422261'
const consent = () => ({ purpose: 'tour_confirmation' as const, recipient: message.to, contentSha256: emailMessageDigest(message),
  recordedAt: stamp, expiresAt: '2026-09-22T13:00:00.000Z', receiptId: 'permission-1' })
function action(): WorkflowAction {
  const next = emailWorkflowAction(message, consent(), 'confirmation-1')
  return { ...next, operationKey: 'a'.repeat(64), id: 'action-1', receiptId: 'receipt-1', organizationId: 'org-a', propertyId: 'property-a',
    configurationVersion: 1, requestId: 'request-1', origin: { kind: 'user', userId: 'staff-a', credentialVersion: 1 },
    state: 'queued', phase: 'dispatch', dispatchAttempts: 0, verificationAttempts: 0, verificationAttemptsAtReplay: 0,
    maxAttempts: 10, availableAt: stamp, createdAt: stamp, updatedAt: stamp, completedAt: null, lastErrorCode: null,
    dispatchStarted: false, providerReference: null, evidence: null, inputSha256: hashJson(next.input) }
}
function fixture(patch: Record<string, unknown> = {}, current = stamp) {
  const requests: string[] = [], intent = action()
  const body = { object: 'email', id, from: message.from, to: [message.to], subject: message.subject, html: message.html,
    cc: [], bcc: [], reply_to: [], last_event: 'delivered',
    tags: [{ name: 'atrium_operation', value: intent.operationKey }, { name: 'atrium_input', value: intent.inputSha256 }], ...patch }
  const transport = new ResendTransport('synthetic-key', { now: () => new Date(current), fetch: async (url, init) => {
    requests.push(String(url)); return Response.json(init?.method === 'POST' ? { id } : body)
  } })
  const connector = createResendEmailConnector({ organizationId: 'org-a', propertyId: 'property-a', from: message.from,
    transport, now: () => new Date(current) })
  return { connector, intent, requests }
}
const signal = () => new AbortController().signal

test('email permission binds the exact recipient, content, purpose and time interval', () => {
  const valid = consent()
  for (const patch of [{ recipient: 'other@example.test' }, { contentSha256: 'f'.repeat(64) }, { purpose: 'marketing' },
    { recordedAt: '2026-02-30T00:00:00Z' }, { expiresAt: stamp }, { expiresAt: '2026-09-24T00:00:00Z' },
    { receiptId: '' }, { extra: true }]) {
    assert.throws(() => emailWorkflowAction(message, { ...valid, ...patch } as never, 'operation'), /permission receipt/)
  }
  const detached = emailWorkflowAction(message, valid, 'operation')
  valid.recipient = 'changed@example.test'
  assert.equal((detached.input.consent as { recipient: string }).recipient, message.to)
})

test('scope, sender, reply address, input digest and expired permission are checked before provider IO', async () => {
  const scenarios = [
    (a: WorkflowAction) => { a.organizationId = 'org-b' },
    (a: WorkflowAction) => { a.propertyId = 'property-b' },
    (a: WorkflowAction) => { a.kind = 'other' },
    (a: WorkflowAction) => { a.inputSha256 = 'f'.repeat(64) },
    (a: WorkflowAction) => { a.input.message = { ...message, from: 'other@example.test' }; a.inputSha256 = hashJson(a.input) },
    (a: WorkflowAction) => { a.input.message = { ...message, replyTo: 'other@example.test' }; a.inputSha256 = hashJson(a.input) },
    (a: WorkflowAction) => { a.createdAt = '2026-09-22T11:59:59Z' },
  ]
  for (const change of scenarios) {
    const s = fixture(); change(s.intent)
    assert.equal((await s.connector.dispatch(s.intent, signal())).status, 'rejected')
    assert.equal(s.requests.length, 0)
  }
  const expired = fixture({}, '2026-09-22T13:00:00Z')
  assert.deepEqual(await expired.connector.dispatch(expired.intent, signal()), { status: 'rejected', code: 'email_consent_expired', retryable: false })
  assert.equal(expired.requests.length, 0)
})

test('acceptance requires reference persistence; a missing acknowledgement never causes a guessed readback', async () => {
  const s = fixture()
  assert.equal(s.connector.idempotentWrites, false)
  assert.equal(s.connector.verificationRequiresReference, true)
  assert.deepEqual(await s.connector.dispatch(s.intent, signal()), { status: 'accepted', providerReference: id })
  assert.deepEqual(await s.connector.verify(s.intent, signal()), { status: 'unknown', code: 'email_acknowledgement_missing' })
  assert.equal(s.requests.length, 1)
})

test('delivery requires matching identity, recipient, content, sender, tags and no hidden recipients', async () => {
  for (const patch of [{ id: 'dbcd2156-9273-4f31-945c-dba617422261' }, { object: 'other' },
    { to: ['other@example.test'] }, { from: 'other@example.test' }, { html: '<p>Wrong tour</p>' },
    { subject: 'Wrong subject' }, { cc: ['other@example.test'] }, { bcc: ['other@example.test'] },
    { reply_to: ['other@example.test'] }, { tags: [] }, { tags: [{ name: 'atrium_operation', value: 'bad' }] }]) {
    const s = fixture(patch); s.intent.providerReference = id
    assert.equal((await s.connector.verify(s.intent, signal())).status, 'mismatch')
  }
  const s = fixture(); s.intent.providerReference = id
  const result = await s.connector.verify(s.intent, signal())
  assert.equal(result.status, 'matched')
  if (result.status !== 'matched') return
  assert.equal(result.evidence.deliveryStatus, 'delivered')
  assert.equal(result.evidence.recipientRead, 'not_established')
  assert.equal(JSON.stringify(result.evidence).includes(message.to), false)
  assert.equal(result.operationKey, s.intent.operationKey)
  assert.equal(result.inputSha256, s.intent.inputSha256)
})

test('sent, queued, tracking and unknown events cannot be reported as delivery; failures need review', async () => {
  for (const last_event of ['sent','queued','delivery_delayed','opened','clicked','new_event',null]) {
    const s = fixture({ last_event }); s.intent.providerReference = id
    assert.deepEqual(await s.connector.verify(s.intent, signal()), { status: 'unknown', code: 'email_delivery_unverified' })
  }
  for (const last_event of ['bounced','failed','suppressed','complained','canceled']) {
    const s = fixture({ last_event }); s.intent.providerReference = id
    assert.deepEqual(await s.connector.verify(s.intent, signal()), { status: 'mismatch', code: 'email_delivery_failed' })
  }
})

test('delivery can be observed after consent expires, without authorizing another dispatch', async () => {
  const s = fixture({}, '2026-09-23T12:00:00Z'); s.intent.providerReference = id
  assert.equal((await s.connector.verify(s.intent, signal())).status, 'matched')
  assert.equal((await s.connector.dispatch(s.intent, signal())).status, 'rejected')
  assert.equal(s.requests.length, 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../vapi.ts'
import { documentStoreFromEnv } from '../../src/store/documents.ts'
import { listProfiles, listFollowUps } from '../../src/leads/consolidate.ts'

function response() {
  const res: any = {
    code: 0, body: null,
    status(code: number) { res.code = code; return res },
    json(body: unknown) { res.body = body; return res },
    setHeader() { return res },
  }
  return res
}

async function send(message: Record<string, unknown>) {
  const res = response()
  await handler({ method: 'POST', headers: {}, body: { message } }, res)
  return res
}

test('repeated end reports keep the callback identity captured by a caller with no caller ID', async () => {
  const call = { id: 'hidden-callback-repeated', startedAt: '2026-09-09T14:00:00Z', endedAt: '2026-09-09T14:01:00Z' }
  await send({ type: 'tool-calls', call, toolCallList: [{ id: 'contact', name: 'capture_contact', arguments: {
    name: 'Hidden caller', phone: '5165550147', email: 'hidden@example.com', excerpt: 'Call me back at 5165550147',
  } }] })
  await send({ type: 'end-of-call-report', call })
  await send({ type: 'end-of-call-report', call })
  const profiles = (await listProfiles(documentStoreFromEnv())).filter((p) => p.calls.some((c) => c.callId === call.id))
  assert.equal(profiles.length, 1, 'a retry must not create an empty anonymous copy of the caller')
  assert.equal(profiles[0]!.phone, '+15165550147')
  assert.equal(profiles[0]!.name, 'Hidden caller')
  assert.equal(profiles[0]!.email, 'hidden@example.com')
})

test('a repeated finished call cannot execute tools again or replace its saved identity', async () => {
  const call = { id: 'terminal-call-identity', customer: { number: '+15165550148' } }
  await send({ type: 'end-of-call-report', call })
  const result = await send({ type: 'tool-calls', call, toolCallList: [{ id: 'late-contact', name: 'capture_contact', arguments: {
    phone: '5165550149', name: 'Late update', excerpt: 'Use another number',
  } }] })
  assert.match(result.body.results[0].result, /ended/i)
  await send({ type: 'end-of-call-report', call })
  const profiles = (await listProfiles(documentStoreFromEnv())).filter((p) => p.calls.some((c) => c.callId === call.id))
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0]!.phone, '+15165550148')
})

test('a finished-call report without an identifier does not create a shared unknown caller', async () => {
  const res = await send({ type: 'end-of-call-report', call: {} })
  assert.equal(res.code, 400)
  assert.equal(await documentStoreFromEnv().get('lead:anonymous:unknown-call'), null)
})

test('delayed report timestamps reflect when the call ended, including follow-up timing', async () => {
  const call = { id: 'delayed-report-clock', customer: { number: '+15165550146' }, startedAt: '2026-09-09T14:00:00Z', endedAt: '2026-09-09T14:01:00Z' }
  await send({ type: 'transcript', call, role: 'user', transcriptType: 'final', transcript: 'I smell gas' })
  await send({ type: 'end-of-call-report', call })
  const profile = (await listProfiles(documentStoreFromEnv())).find((p) => p.phone === '+15165550146')!
  assert.equal(profile.calls[0]!.at, '2026-09-09T14:01:00.000Z')
  assert.equal(profile.calls[0]!.durationSeconds, 60)
  const followUp = (await listFollowUps(documentStoreFromEnv())).find((f) => f.createdFromCall === call.id)!
  assert.equal(followUp.createdAt, '2026-09-09T14:01:00.000Z')
})

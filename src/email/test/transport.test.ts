import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ResendTransport, validEmailMessage, transportFromEnv } from '../render.ts'
import type { EmailMessage, EmailAttempt } from '../render.ts'

const message: EmailMessage = { to: 'prospect@example.test', from: 'Leasing <leasing@example.test>',
  replyTo: 'leasing@example.test', subject: 'Your selected residences', html: '<p>Fixture only.</p>' }
const stamp = '2026-09-22T12:00:00.000Z'
const attempt: EmailAttempt = { operationKey: 'a'.repeat(64), inputSha256: 'b'.repeat(64), createdAt: stamp }
const id = 'cbcd2156-9273-4f31-945c-dba617422261'
function fixture(response: () => Response | Promise<Response>) {
  const requests: Array<{ url: string; options: RequestInit }> = []
  const transport = new ResendTransport('synthetic-key', { now: () => new Date(stamp), fetch: async (url, options) => {
    requests.push({ url: String(url), options: options! }); return response()
  } })
  return { transport, requests }
}

test('provider acceptance uses a stable key and tags, but never claims sent or delivered', async () => {
  const s = fixture(() => Response.json({ id }))
  const result = await s.transport.send(message, attempt)
  assert.equal(result.status, 'accepted'); assert.equal(result.accepted, true)
  assert.equal(result.sent, false); assert.equal(result.delivered, false)
  const request = s.requests[0]!
  assert.equal(request.url, 'https://api.resend.com/emails')
  assert.equal(request.options.redirect, 'error')
  const headers = new Headers(request.options.headers)
  assert.equal(headers.get('idempotency-key'), 'atrium-' + attempt.operationKey)
  assert.equal(headers.get('authorization'), 'Bearer synthetic-key')
  const body = JSON.parse(String(request.options.body))
  assert.deepEqual(body.to, [message.to]); assert.deepEqual(body.reply_to, [message.replyTo])
  assert.deepEqual(body.tags, [{ name: 'atrium_operation', value: attempt.operationKey }, { name: 'atrium_input', value: attempt.inputSha256 }])
  await s.transport.send(message, attempt)
  assert.equal(new Headers(s.requests[1]!.options.headers).get('idempotency-key'), headers.get('idempotency-key'))
})

test('missing durable identity, invalid recipients and expired dispatch windows make no request', async () => {
  const s = fixture(() => Response.json({ id }))
  assert.equal((await s.transport.send(message)).status, 'rejected')
  for (const patch of [{ operationKey: 'new-random-key' }, { inputSha256: '' }, { createdAt: 'invalid' },
    { createdAt: '2026-09-22T12:00:01Z' }, { createdAt: '2026-09-21T13:00:00Z' }]) {
    assert.equal((await s.transport.send(message, { ...attempt, ...patch })).status, 'rejected')
  }
  for (const patch of [{ to: 'a@example.test,b@example.test' }, { to: 'a@example.test\nBcc: b@example.test' },
    { from: 'Bad\u0000 <a@example.test>' }, { subject: 'Hi\r\nBcc: secret' }, { bcc: ['b@example.test'] },
    { replyTo: 'a@example.test,b@example.test' }, { html: 'x'.repeat(65537) }]) {
    const invalid = { ...message, ...patch }
    assert.equal(validEmailMessage(invalid), false)
    assert.equal((await s.transport.send(invalid, attempt)).status, 'rejected')
  }
  assert.equal(s.requests.length, 0)
})

test('a successful status with malformed acknowledgement stays unknown and never invents a message ID', async () => {
  for (const body of ['{}', '{broken', 'null', '{"id":"unknown"}', '{"id":"https://evil.test"}']) {
    const s = fixture(() => new Response(body, { status: 200 }))
    const result = await s.transport.send(message, attempt)
    assert.equal(result.status, 'unknown'); assert.equal(result.accepted, false)
    assert.equal('id' in result, false)
  }
})

test('provider errors and network exceptions never expose raw bodies, credentials or caller data', async () => {
  for (const status of [400,401,403,409,422,429,500,503]) {
    const s = fixture(() => Response.json({ secret: 'never-echo-provider-content' }, { status }))
    const result = await s.transport.send(message, attempt)
    assert.equal(result.status, [400,401,403,422,429].includes(status) ? 'rejected' : 'unknown')
    assert.equal(result.reason, 'email_provider_http_' + status)
    assert.equal(JSON.stringify(result).includes('never-echo'), false)
  }
  const s = fixture(() => { throw new Error('secret synthetic-key prospect@example.test') })
  assert.equal((await s.transport.send(message, attempt)).reason, 'email_submission_unverified')
})

test('oversized response and cancellation after dispatch stay uncertain; pre-cancellation makes no request', async () => {
  const large = fixture(() => new Response('x'.repeat(262145)))
  assert.equal((await large.transport.send(message, attempt)).status, 'unknown')
  const signal = AbortSignal.abort()
  const before = fixture(() => Response.json({ id }))
  assert.equal((await before.transport.send(message, { ...attempt, signal })).reason, 'email_cancelled_before_dispatch')
  assert.equal(before.requests.length, 0)
  const controller = new AbortController()
  const transport = new ResendTransport('synthetic-key', { now: () => new Date(stamp), fetch: async (_url, options) => {
    controller.abort(); options!.signal!.throwIfAborted(); return Response.json({ id })
  } })
  assert.equal((await transport.send(message, { ...attempt, signal: controller.signal })).status, 'unknown')
})

test('readback accepts only a message UUID on the fixed provider origin and disallows redirects', async () => {
  const s = fixture(() => Response.json({ id }))
  for (const value of ['https://evil.test/x', '../emails', id + '?redirect=evil', 'unknown']) {
    await assert.rejects(s.transport.retrieve(value), /Invalid provider message identity/)
  }
  assert.equal(s.requests.length, 0)
  await s.transport.retrieve(id)
  assert.equal(s.requests[0]!.url, 'https://api.resend.com/emails/' + id)
  assert.equal(s.requests[0]!.options.method, 'GET')
  assert.equal(s.requests[0]!.options.redirect, 'error')
})

test('no-provider transport remains only a detached preview', async () => {
  const result = await transportFromEnv({}).send(message)
  assert.equal(result.status, 'not_configured'); assert.equal(result.accepted, false)
  assert.match(result.reason, /nothing queued or sent/)
})

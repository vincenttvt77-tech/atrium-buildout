import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getRecording, hasRecording, safeRecordingUrl, RecordingError } from '../vapi-recording.ts'
import { normaliseCall } from '../vapi-calls.ts'
const id = '11111111-1111-4111-8111-111111111111'
const signed = 'https://storage.vapi.ai/private.wav?signature=synthetic-capability'
const base = { callId: id, apiKey: 'synthetic-private-key', assistantIds: ['assistant-a'], revalidate: async () => {} }
function transport(call: unknown = { id, assistantId: 'assistant-a' }, status = 302, location = signed) {
  const requests: Array<{ url: string; options: RequestInit | undefined }> = []
  const fetchImpl: typeof fetch = async (url, options) => { requests.push({ url: String(url), options })
    return String(url).endsWith('/mono-recording') ? new Response(null, { status, headers: { location } }) : Response.json(call) }
  return { fetchImpl, requests }
}
test('checks the exact call owner, then mints a fresh capability without following the redirect', async () => {
  const mock = transport(); let validations = 0
  assert.deepEqual(await getRecording({ ...base, ...mock, revalidate: async () => { validations++ } }), { callId: id, url: signed })
  assert.equal(validations, 2); assert.equal(mock.requests.length, 2)
  assert.equal(mock.requests[0]!.url, `https://api.vapi.ai/call/${id}`)
  assert.equal(mock.requests[0]!.options?.redirect, 'error'); assert.equal(mock.requests[1]!.options?.redirect, 'manual')
  assert.equal((mock.requests[1]!.options?.headers as any).authorization, 'Bearer synthetic-private-key')
  await getRecording({ ...base, ...mock }); assert.equal(mock.requests.length, 4, 'Never cache a signed capability')
})
test('unbound, foreign, missing-owner and mismatched records never reach the recording endpoint', async () => {
  for (const call of [{ id, assistantId: 'foreign' }, { id }, { id: 'other', assistantId: 'assistant-a' }]) {
    const mock = transport(call)
    await assert.rejects(getRecording({ ...base, ...mock }), (e: any) => e.status === 404)
    assert.equal(mock.requests.length, 1)
  }
  const mock = transport()
  await assert.rejects(getRecording({ ...base, ...mock, assistantIds: [] }), (e: any) => e.status === 404)
  await assert.rejects(getRecording({ ...base, ...mock, callId: '../credential' }), (e: any) => e.status === 400)
  assert.equal(mock.requests.length, 0)
})
test('authority loss at either provider boundary releases no capability and never downgrades the error', async () => {
  for (const at of [1, 2]) {
    const mock = transport(); let checks = 0; const denied = new Error('synthetic authority changed')
    await assert.rejects(getRecording({ ...base, ...mock, revalidate: async () => { if (++checks === at) throw denied } }), e => e === denied)
    assert.equal(mock.requests.length, at)
  }
})
test('provider errors, malformed JSON, oversized records and invalid redirects remain sanitized', async () => {
  for (const response of [new Response('private provider body', { status: 401 }), new Response('{bad'), Response.json('wrong'), new Response('x'.repeat(1048577))]) {
    await assert.rejects(getRecording({ ...base, fetchImpl: async () => response }), (e: any) => e.status === 503 && !/private|synthetic-private/.test(e.message))
  }
  for (const status of [200, 301, 307, 401, 500]) await assert.rejects(getRecording({ ...base, ...transport(undefined, status) }), (e: any) => e.status === 503)
  await assert.rejects(getRecording({ ...base, ...transport(undefined, 404) }), (e: any) => e.status === 404)
  await assert.rejects(getRecording({ ...base, fetchImpl: async () => { throw new Error('secret URL') } }), RecordingError)
})
test('recording URLs reject script, local, IP, credential and malformed destinations', async () => {
  for (const url of ['javascript:alert(1)', 'http://storage.vapi.ai/x', 'https://user:secret@storage.vapi.ai/x', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://[::1]/x', 'https://localhost/x', 'https://voice.internal/x', 'https://media.example.com/x', 'https://storage.vapi.ai:8443/x', 'https://storage.vapi.ai/x#secret', 'https://storage.vapi.ai/\\evil', '//storage.vapi.ai/x', signed + 'x'.repeat(16384)]) {
    assert.equal(safeRecordingUrl(url), false, url.slice(0, 80))
    await assert.rejects(getRecording({ ...base, ...transport(undefined, 302, url) }), (e: any) => e.status === 503)
  }
  assert.equal(safeRecordingUrl(signed), true)
})
test('history advertises available audio without leaking direct or presigned URLs', () => {
  for (const raw of [{ id, recordingUrl: signed }, { id, artifact: { presignedMonoUrl: signed } }, { id, stereoRecordingUrl: signed }]) {
    assert.equal(hasRecording(raw), true)
    const call = normaliseCall(raw); assert.equal(call.recordingAvailable, true); assert.equal(call.recordingUrl, null)
    assert.doesNotMatch(JSON.stringify(call), /signature|storage\.vapi/)
  }
  assert.equal(hasRecording({ id: 'local-fixture', recordingUrl: signed }), false)
  assert.equal(hasRecording({ id, recordingUrl: 'https://example.com/recording.wav' }), false)
})
test('timeout cannot return a download capability', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(getRecording({ ...base, signal: controller.signal, fetchImpl: async (_url, options) => { options?.signal?.throwIfAborted(); throw Error('unreachable') } }), (e: any) => e.status === 503)
})

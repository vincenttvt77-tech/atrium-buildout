import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import vapi from '../vapi.ts'
import { MemoryDocumentStore, documentStoreFromEnv } from '../../src/store/documents.ts'
import { receiptKey, type CallReceipt } from '../../src/leads/inbox.ts'

const invoke = async (id: string) => {
  const res: any = { code: 0, body: null, headers: {}, setHeader(k: string, v: string) { this.headers[k] = v }, status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this } }
  await vapi({ method: 'POST', headers: {}, body: { message: { type: 'end-of-call-report', call: { id, customer: { number: '+17185550123' } } } } }, res)
  return res
}

test('a finished-call write failure returns retryable 503 and a redelivery completes the saved receipt', async () => {
  const originalEnv = { ...process.env }
  for (const key of ['OPS_ACCOUNTS_JSON', 'VAPI_WEBHOOK_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'NODE_ENV', 'VERCEL']) delete process.env[key]
  const original = MemoryDocumentStore.prototype.update
  const intercepted = mock.method(MemoryDocumentStore.prototype, 'update', function(this: MemoryDocumentStore, key: string, initial: unknown, fn: (v: unknown) => unknown) {
    if (key.startsWith('lead:')) throw new Error('simulated profile outage')
    return original.call(this, key, initial, fn)
  })
  try {
    const first = await invoke('recovery-call')
    assert.equal(first.code, 503)
    assert.equal(first.body.retryable, true)
    assert.equal(first.headers['retry-after'], '30')
    assert.match(first.headers['x-request-id'], /^[a-f0-9-]{36}$/)
    assert.doesNotMatch(JSON.stringify(first.body), /17185550123|simulated profile/)
    const store = documentStoreFromEnv()
    assert.equal((await store.get<CallReceipt>(receiptKey('recovery-call')))?.status, 'pending')
    intercepted.mock.restore()
    const retry = await invoke('recovery-call')
    assert.equal(retry.code, 200)
    assert.notEqual(retry.headers['x-request-id'], first.headers['x-request-id'])
    assert.equal((await store.get<CallReceipt>(receiptKey('recovery-call')))?.status, 'complete')
    assert.equal((await store.list('lead:')).length, 1)
    assert.equal((await invoke('recovery-call')).code, 200)
    assert.equal((await store.list('lead:')).length, 1)
  } finally {
    intercepted.mock.restore()
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  }
})

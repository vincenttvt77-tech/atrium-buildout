import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalJson, hashJson, validateReceiptInput } from '../validation.ts'
import { WorkflowError } from '../model.ts'

const receipt = () => ({ source: 'vapi', eventId: 'call-1:end', payload: { callId: 'call-1' },
  actions: [{ kind: 'call.project', connector: 'internal', operationKey: 'call-1:project', input: { visitor: 'Synthetic Visitor' } }] })
const rejects = (value: unknown) => assert.throws(() => validateReceiptInput(value), {
  name: 'WorkflowError', code: 'workflow_invalid_input', message: 'The workflow receipt or JSON value is invalid.',
})

test('canonical JSON recursively orders keys, retains array order and hashes the exact UTF-8 bytes', () => {
  const a = { z: [3, { b: 'é', a: true }], a: null }
  const b = { a: null, z: [3, { a: true, b: 'é' }] }
  const expected = '{"a":null,"z":[3,{"a":true,"b":"é"}]}'
  assert.equal(canonicalJson(a), expected)
  assert.equal(canonicalJson(b), expected)
  assert.equal(hashJson(a), hashJson(b))
  assert.equal(hashJson(a), createHash('sha256').update(expected, 'utf8').digest('hex'))
  assert.notEqual(hashJson([1, 2]), hashJson([2, 1]))
  assert.notEqual(hashJson({ amount: 1 }), hashJson({ amount: '1' }))
  assert.equal(hashJson(-0), hashJson(0))
})

test('non-JSON primitives and exotic objects never coerce into accepted JSON', () => {
  for (const value of [undefined, () => 1, Symbol('value'), 1n, NaN, Infinity, -Infinity,
    new Date(), new Map(), new Set(), /pattern/, new String('value'), Object.create({ inherited: true }),
    { value: undefined }, [undefined]]) {
    assert.throws(() => canonicalJson(value), WorkflowError)
  }
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}')
})

test('PostgreSQL-incompatible NUL and lone surrogates are refused in string values and keys', () => {
  const unsupported = [
    JSON.parse('"\\ud800"'), JSON.parse('"\\udfff"'), JSON.parse('"\\u0000"'),
    'before\u0000after', '\ud800x', '\ud800\ud800', '\udc00\ud800',
  ]
  for (const value of unsupported) {
    assert.throws(() => canonicalJson(value), WorkflowError)
    assert.throws(() => canonicalJson({ [value]: 'value' }), WorkflowError)
    rejects({ ...receipt(), payload: { nested: [value] } })
    rejects({ ...receipt(), actions: [{ ...receipt().actions[0], input: { [value]: 'value' } }] })
  }
})

test('valid surrogate pairs, emoji, newlines and escaped text remain stable JSONB-compatible data', () => {
  const emoji = JSON.parse('"\\ud83d\\ude00"')
  assert.equal(emoji, '😀')
  const value = { ['emoji ' + emoji]: 'line one\nline two\t"quoted"\\path', value: emoji }
  assert.equal(canonicalJson(value), '{"emoji 😀":"line one\\nline two\\t\\"quoted\\"\\\\path","value":"😀"}')
  assert.equal(hashJson({ value: emoji }), hashJson({ value: '😀' }))
  assert.deepEqual(validateReceiptInput({ ...receipt(), payload: value }).payload, value)
})

test('getters, toJSON hooks and proxies cannot execute during validation', () => {
  let executed = 0
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { executed++; return 1 } })
  const toJSON = { toJSON() { executed++; return 'converted' } }
  const proxy = new Proxy({}, { ownKeys() { executed++; return [] } })
  for (const value of [getter, toJSON, proxy]) assert.throws(() => canonicalJson(value), WorkflowError)
  assert.equal(executed, 0)
})

test('hidden properties, symbol keys, sparse arrays and extra array properties cannot silently disappear', () => {
  const hidden = Object.defineProperty({}, 'hidden', { value: 1 })
  const symbol = { [Symbol('hidden')]: 1 }
  const extra = Object.assign([1], { extra: 2 })
  const getter = Object.defineProperty([], '0', { enumerable: true, get: () => 1 })
  for (const value of [hidden, symbol, new Array(2), [1, , 3], extra, getter]) {
    assert.throws(() => canonicalJson(value), WorkflowError)
  }
})

test('cycles, excessive nesting and node counts are bounded while shared acyclic objects remain valid', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  assert.throws(() => canonicalJson(cyclic), WorkflowError)
  let nested: unknown = 1
  for (let i = 0; i < 20; i++) nested = [nested]
  assert.doesNotThrow(() => canonicalJson(nested))
  assert.throws(() => canonicalJson([nested]), WorkflowError)
  assert.doesNotThrow(() => canonicalJson(Array(9999).fill(null)))
  assert.throws(() => canonicalJson(Array(10_000).fill(null)), WorkflowError)
  const shared = { value: 1 }
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"value":1},"b":{"value":1}}')
})

test('validated receipt is detached, preserves action order and materializes attempt defaults', () => {
  const input = receipt()
  input.actions.push({ ...input.actions[0]!, operationKey: 'call-1:second' })
  const output = validateReceiptInput(input)
  assert.deepEqual(output.actions.map(action => [action.operationKey, action.maxAttempts]), [['call-1:project', 5], ['call-1:second', 5]])
  input.payload.callId = 'changed'
  input.actions[0]!.input.visitor = 'changed'
  assert.equal(output.payload.callId, 'call-1')
  assert.equal(output.actions[0]!.input.visitor, 'Synthetic Visitor')
  output.actions[0]!.input.visitor = 'only first copy'
  assert.equal(output.actions[1]!.input.visitor, 'Synthetic Visitor')
  const explicit = receipt()
  Object.assign(explicit.actions[0]!, { maxAttempts: 5 })
  assert.equal(hashJson(validateReceiptInput(receipt())), hashJson(validateReceiptInput(explicit)))
})

test('unknown envelope/action keys, missing object payloads and duplicate logical keys are refused', () => {
  rejects({ ...receipt(), organizationId: 'spoofed' })
  rejects({ ...receipt(), unknown: true })
  for (const value of [null, [], 'text', 1]) {
    rejects({ ...receipt(), payload: value })
    rejects({ ...receipt(), actions: [{ ...receipt().actions[0], input: value }] })
  }
  rejects({ ...receipt(), actions: [{ ...receipt().actions[0], state: 'succeeded' }] })
  rejects({ ...receipt(), actions: [receipt().actions[0], { ...receipt().actions[0], connector: 'other' }] })
  const missing: Record<string, unknown> = receipt(); delete missing.eventId; rejects(missing)
})

test('receipt IDs, machine IDs, action counts and retry bounds are validated without trimming or coercion', () => {
  for (const value of ['', ' ', ' call', 'call ', 'call\n1', 'call\u00851', 'x'.repeat(257), 123]) {
    rejects({ ...receipt(), eventId: value })
    rejects({ ...receipt(), actions: [{ ...receipt().actions[0], operationKey: value }] })
  }
  for (const value of ['', 'Vapi', 'bad/name', 'x'.repeat(65), '1source', 'a b']) {
    rejects({ ...receipt(), source: value })
    for (const key of ['kind', 'connector']) rejects({ ...receipt(), actions: [{ ...receipt().actions[0], [key]: value }] })
  }
  rejects({ ...receipt(), actions: [] })
  rejects({ ...receipt(), actions: Array.from({ length: 21 }, (_, n) => ({ ...receipt().actions[0], operationKey: `key-${n}` })) })
  for (const value of [0, 11, -1, 1.5, '5', null]) rejects({ ...receipt(), actions: [{ ...receipt().actions[0], maxAttempts: value }] })
  assert.equal(validateReceiptInput({ ...receipt(), source: 'a'.repeat(64), eventId: 'e'.repeat(256),
    actions: Array.from({ length: 20 }, (_, n) => ({ ...receipt().actions[0], operationKey: `key-${n}`, maxAttempts: 10 })) }).actions.length, 20)
})

test('input and total receipt sizes use UTF-8 encoded JSON including default fields', () => {
  const inputBytes = 128 * 1024
  const sizedInput = { text: 'x'.repeat(inputBytes - 11) }
  assert.equal(Buffer.byteLength(canonicalJson(sizedInput)), inputBytes)
  assert.doesNotThrow(() => validateReceiptInput({ ...receipt(), actions: [{ ...receipt().actions[0], input: sizedInput }] }))
  rejects({ ...receipt(), actions: [{ ...receipt().actions[0], input: { text: sizedInput.text + 'x' } }] })
  rejects({ ...receipt(), actions: [{ ...receipt().actions[0], input: { text: 'é'.repeat(inputBytes / 2) } }] })
  rejects({ ...receipt(), payload: { text: 'x'.repeat(1024 * 1024) } })
  rejects({ ...receipt(), actions: Array.from({ length: 9 }, (_, n) => ({ ...receipt().actions[0], operationKey: `key-${n}`, input: sizedInput })) })
})

test('credential fields and prototype pollution keys are refused at every payload depth', () => {
  for (const key of ['password', 'password_hash', 'Authorization', 'api-key', 'private_key', 'accessToken', 'refresh_token',
    'webhook-secret', 'credentials', 'token', 'VAPI_API_KEY', 'x-api-key', 'client_password', 'sessionSecret', 'Cookie', 'databaseUrl']) {
    rejects({ ...receipt(), payload: { nested: [{ [key]: 'synthetic-secret-value' }] } })
    rejects({ ...receipt(), actions: [{ ...receipt().actions[0], input: { [key]: 'synthetic-secret-value' } }] })
  }
  rejects({ ...receipt(), payload: JSON.parse('{"__proto__":{"polluted":true}}') })
  assert.doesNotThrow(() => validateReceiptInput({ ...receipt(), payload: {
    credentialRef: 'vault-reference', credentialVersion: 2, webhookSecretRef: 'vault-webhook', apiKeyVersion: 3,
  } }))
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

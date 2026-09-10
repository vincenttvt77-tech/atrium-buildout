import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../vapi.ts'

const savedEnv = { ...process.env }, savedFetch = globalThis.fetch
const secret = 'synthetic-vapi-auth-secret'
const kvUrl = 'https://webhook-auth-kv.invalid'
let commands: string[][], records: Map<string, string>, sequence = 0

beforeEach(() => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'ATRIUM_DATABASE_URL', 'ATRIUM_AUTH_DATABASE_URL',
    'ATRIUM_SIMULATION', 'OPS_ACCOUNTS_JSON', 'VAPI_API_KEY', 'VAPI_PRIVATE_KEY', 'VERCEL']) delete process.env[key]
  Object.assign(process.env, { NODE_ENV: 'production', VAPI_WEBHOOK_SECRET: secret,
    KV_REST_API_URL: kvUrl, KV_REST_API_TOKEN: 'synthetic-kv-token' })
  commands = []; records = new Map()
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), kvUrl, 'only the synthetic Redis adapter is available')
    const command = JSON.parse(String(init?.body)) as string[]
    commands.push(command)
    let result: unknown
    if (command[0] === 'GET') result = records.get(command[1]!) ?? null
    else if (command[0] === 'EVAL') {
      assert.equal(command[2], '1')
      const [, , , key, presence, prior, next] = command
      const matches = presence === 'missing' ? !records.has(key!) : records.get(key!) === prior
      if (matches) records.set(key!, next!)
      result = Number(matches)
    } else assert.fail(`Unexpected Redis operation: ${command[0]}`)
    return new Response(JSON.stringify({ result }))
  }
})

afterEach(() => {
  globalThis.fetch = savedFetch
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function invoke(headers: Record<string, unknown>, rawHeaders?: string[]) {
  const id = `synthetic-auth-${++sequence}`
  let runtimeReads = 0
  const req: any = { method: 'POST', headers, rawHeaders,
    body: { message: { type: 'tool-calls', call: { id, assistantId: 'synthetic-assistant' },
      toolCallList: [{ id: 'contact', name: 'capture_contact', arguments: { name: 'Synthetic Visitor', excerpt: 'My name is Synthetic Visitor' } }] } } }
  Object.defineProperty(req, 'atriumRuntime', { get() { runtimeReads++; throw new Error('Unverified runtime read') } })
  const res: any = { code: 0, body: null,
    setHeader() {}, status(code: number) { this.code = code; return this }, json(body: unknown) { this.body = body; return this } }
  await handler(req, res)
  return { ...res, id, runtimeReads }
}

test('KV handler accepts explicit bearer despite stale inherited legacy credentials and persists the tool result', async () => {
  const response = await invoke({ authorization: `Bearer ${secret}`,
    'x-vapi-secret': 'stale-phone-secret', 'x-vapi-signature': 'stale-signature' })
  assert.equal(response.code, 200)
  assert.equal(JSON.parse(records.get(`atrium:call:${response.id}`)!).name, 'Synthetic Visitor')
  assert.ok(commands.some(command => command[0] === 'EVAL'))
})

test('KV handler retains legacy secret and signature compatibility only with Authorization absent', async () => {
  for (const headers of [{ 'x-vapi-secret': secret }, { 'x-vapi-signature': secret }]) {
    const response = await invoke(headers)
    assert.equal(response.code, 200)
    assert.equal(JSON.parse(records.get(`atrium:call:${response.id}`)!).name, 'Synthetic Visitor')
  }
})

const invalidAuthorization: Array<[string, unknown]> = [
  ['wrong bearer', 'Bearer wrong'], ['empty', ''], ['undefined but present', undefined],
  ['null', null], ['array', [`Bearer ${secret}`]], ['multiple array', [`Bearer ${secret}`, 'Bearer wrong']],
  ['missing token', 'Bearer '], ['wrong scheme', `Basic ${secret}`], ['bare token', secret],
  ['comma-joined tokens', `Bearer ${secret}, Bearer wrong`], ['extra token', `Bearer ${secret} extra`],
  ['extra space', `Bearer  ${secret}`], ['trailing whitespace', `Bearer ${secret} `],
  ['control character', `Bearer ${secret}\n`],
]

for (const mode of ['kv', 'postgres']) {
  for (const [label, authorization] of invalidAuthorization) {
    test(`${mode} rejects ${label} Authorization without legacy fallback or storage access`, async () => {
      if (mode === 'postgres') process.env.ATRIUM_RUNTIME_MODE = 'postgres'
      const response = await invoke({ authorization, 'x-vapi-secret': secret, 'x-vapi-signature': secret })
      assert.equal(response.code, 401)
      assert.deepEqual(response.body, { error: 'unauthorized' })
      assert.equal(response.runtimeReads, 0)
      assert.equal(commands.length, 0)
    })
  }

  test(`${mode} rejects duplicate raw Authorization even when Node normalized the first valid value`, async () => {
    if (mode === 'postgres') process.env.ATRIUM_RUNTIME_MODE = 'postgres'
    const response = await invoke({ authorization: `Bearer ${secret}`, 'x-vapi-secret': secret },
      ['Authorization', `Bearer ${secret}`, 'authorization', 'Bearer wrong'])
    assert.equal(response.code, 401)
    assert.equal(response.runtimeReads, 0)
    assert.equal(commands.length, 0)
  })

  test(`${mode} rejects duplicate case variants and raw Authorization omitted from normalized headers`, async () => {
    if (mode === 'postgres') process.env.ATRIUM_RUNTIME_MODE = 'postgres'
    const duplicate = await invoke({ Authorization: `Bearer ${secret}`, authorization: `Bearer ${secret}`, 'x-vapi-secret': secret })
    const missing = await invoke({ 'x-vapi-secret': secret }, ['Authorization', `Bearer ${secret}`])
    assert.equal(duplicate.code, 401); assert.equal(missing.code, 401)
    assert.equal(duplicate.runtimeReads + missing.runtimeReads, 0)
    assert.equal(commands.length, 0)
  })

  test(`${mode} rejects missing credentials and still fails closed when verification is not configured`, async () => {
    if (mode === 'postgres') process.env.ATRIUM_RUNTIME_MODE = 'postgres'
    const missing = await invoke({})
    assert.equal(missing.code, 401)
    delete process.env.VAPI_WEBHOOK_SECRET
    const unconfigured = await invoke({ authorization: `Bearer ${secret}`, 'x-vapi-secret': secret })
    assert.equal(unconfigured.code, 503)
    assert.equal(missing.runtimeReads + unconfigured.runtimeReads, 0)
    assert.equal(commands.length, 0)
  })
}

import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, type OpsAccount } from '../../src/ops/accounts.ts'
import { mintAccountSession, OPS_COOKIE } from '../../src/ops/session.ts'
import { documentStoreFromEnv } from '../../src/store/documents.ts'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { withTenant } from '../../src/tenancy/context.ts'
import leads from '../leads.ts'
import calendar from '../calendar.ts'
import vapi from '../vapi.ts'

const originalEnv = { ...process.env }
let accounts: OpsAccount[]
const phone = '+17185550101'
const secret = 'tenant-test-webhook-secret'
const docs = documentStoreFromEnv()
const cal = calendarStoreFromEnv()
before(async () => {
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  delete process.env.VAPI_PRIVATE_KEY
  delete process.env.VAPI_API_KEY
  process.env.OPS_SESSION_SECRET = 'tenant-test-independent-signing-key-at-least-32'
  process.env.VAPI_WEBHOOK_SECRET = secret
  const passwordHash = await hashPassword('TenantTestPassword123!')
  accounts = ['alpha', 'bravo'].map((id) => ({ username: id, tenantId: `test-${id}`,
    displayName: id, passwordHash, assistantIds: [`assistant-${id}`] }))
  process.env.OPS_ACCOUNTS_JSON = JSON.stringify(accounts)
})
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
})

function headers(index: number) {
  return { cookie: `${OPS_COOKIE}=${mintAccountSession(new Date(), accounts[index]!)}` }
}
async function invoke(handler: (req: any, res: any) => unknown, req: any) {
  const response: any = { code: 0, body: null, headers: {},
    setHeader(k: string, v: string) { this.headers[k] = v; return this },
    status(code: number) { this.code = code; return this },
    json(body: unknown) { this.body = body; return this } }
  await handler(req, response)
  return response
}
async function webhook(index: number, message: any, authenticated = true, callId = 'same-call-id') {
  return invoke(vapi, { method: 'POST', headers: authenticated ? { 'x-vapi-secret': secret } : {},
    body: { message: { ...message, call: { id: callId, assistantId: accounts[index]!.assistantIds[0] } } } })
}

test('identical caller/call IDs stay separate through webhook, leads, notes, events and reset', async () => {
  for (let index = 0; index < 2; index++) {
    const response = await webhook(index, { type: 'tool-calls', toolCallList: [{ id: 'contact',
      function: { name: 'capture_contact', arguments: { name: accounts[index]!.displayName,
        phone, excerpt: `My name is ${accounts[index]!.displayName}; call me at ${phone}.` } } }] })
    assert.equal(response.code, 200)
    assert.doesNotMatch(response.body.results[0].result, /could not verify/)
    await webhook(index, { type: 'status-update', status: `status-${index}` })
    await webhook(index, { type: 'end-of-call-report' })
  }
  const a = await invoke(leads, { method: 'GET', headers: headers(0), query: { tenantId: accounts[1]!.tenantId } })
  const b = await invoke(leads, { method: 'GET', headers: headers(1) })
  assert.equal(a.body.profiles.length, 1)
  assert.equal(b.body.profiles.length, 1)
  assert.equal(a.body.profiles[0].name, 'alpha')
  assert.equal(b.body.profiles[0].name, 'bravo')
  assert.equal((await invoke(leads, { method: 'POST', headers: headers(0), body: {
    action: 'note', phone, text: 'Alpha only', tenantId: accounts[1]!.tenantId,
  } })).code, 200)
  const other = await invoke(leads, { method: 'GET', headers: headers(1) })
  assert.deepEqual(other.body.profiles[0].notes, [])
  const eventsA = await invoke(vapi, { method: 'GET', headers: headers(0) })
  const eventsB = await invoke(vapi, { method: 'GET', headers: headers(1) })
  assert.ok(eventsA.body.events.some((e: any) => e.status === 'status-0'))
  assert.ok(!eventsA.body.events.some((e: any) => e.status === 'status-1'))
  assert.ok(eventsB.body.events.some((e: any) => e.status === 'status-1'))
  await invoke(leads, { method: 'POST', headers: headers(0), body: { action: 'clear_leads', tenantId: accounts[1]!.tenantId } })
  assert.equal((await invoke(leads, { method: 'GET', headers: headers(0) })).body.profiles.length, 0)
  assert.equal((await invoke(leads, { method: 'GET', headers: headers(1) })).body.profiles.length, 1)
})

test('calendar blocks and reset controls affect only the authenticated tenant', async () => {
  const date = '2026-09-15'
  await Promise.all(accounts.map((_, index) => invoke(calendar, { method: 'POST', headers: headers(index),
    body: { action: 'block', target: date, reason: `Private reason ${index}` } })))
  assert.equal((await invoke(calendar, { method: 'GET', headers: headers(0) })).body.blocks[0].reason, 'Private reason 0')
  assert.equal((await invoke(calendar, { method: 'GET', headers: headers(1) })).body.blocks[0].reason, 'Private reason 1')
  await invoke(calendar, { method: 'POST', headers: headers(0), body: { action: 'clear_blocks', tenantId: accounts[1]!.tenantId } })
  assert.equal((await invoke(calendar, { method: 'GET', headers: headers(1) })).body.blocks.length, 1)
})

test('tour settings and Vapi availability use each account’s own capacity', async () => {
  const saved = await Promise.all(accounts.map((account) => withTenant(account.tenantId, () => cal.read())))
  const from = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  const to = new Date(Date.now() + 37 * 86400000).toISOString().slice(0, 10)
  const query = { from, to }
  try {
    for (const account of accounts) await withTenant(account.tenantId, () => cal.mutate(() => ({ blocks: [], bookings: [] })))
    const initial = await invoke(calendar, { method: 'GET', headers: headers(0), query })
    assert.equal(initial.code, 200)
    assert.equal(initial.body.settings.capacity, 2)
    const changed = await invoke(calendar, { method: 'POST', headers: headers(0), body: {
      action: 'settings', settings: { ...initial.body.settings, capacity: 3 }, settingsRevision: initial.body.settingsRevision,
      tenantId: accounts[1]!.tenantId, ...query,
    } })
    assert.equal(changed.code, 200)
    assert.equal(changed.body.settings.capacity, 3)
    assert.equal(changed.body.settingsRevision, initial.body.settingsRevision + 1)
    const bravo = await invoke(calendar, { method: 'GET', headers: headers(1), query })
    assert.equal(bravo.body.settings.capacity, 2)
    assert.equal(bravo.body.settingsRevision, 0)
    const first = changed.body.slots.find((slot: any) => slot.status === 'open')
    assert.ok(first, 'the future range must include an offered weekday')
    assert.ok(bravo.body.slots.some((slot: any) => slot.slotId === first.slotId && slot.status === 'open'))
    for (const account of accounts) await withTenant(account.tenantId, () => cal.mutate((state) => ({ ...state,
      bookings: [0, 1].map((index) => ({ slotId: first.slotId, externalId: `capacity-test-${index}`,
        startsAt: first.startsAt, endsAt: first.endsAt, prospectName: `Existing tour ${index}`,
        prospectPhone: `+1718555010${index + 2}`, prospectEmail: null, unitId: null, bookedAt: new Date().toISOString() })),
    })))
    const [alphaView, bravoView] = await Promise.all([0, 1].map((index) => invoke(calendar, { method: 'GET', headers: headers(index), query })))
    assert.equal(alphaView.body.slots.find((slot: any) => slot.slotId === first.slotId).status, 'open')
    assert.equal(bravoView.body.slots.find((slot: any) => slot.slotId === first.slotId).status, 'booked')
    for (let index = 0; index < 2; index++) {
      const voice = await webhook(index, { type: 'tool-calls', toolCallList: [{ id: 'capacity-times',
        function: { name: 'list_tour_slots', arguments: { preferredDate: first.date } } }] }, true, 'settings-capacity-call')
      assert.equal(voice.code, 200)
      const answer = String(voice.body.results[0].result)
      assert.match(answer, /Real open tour times/)
      assert.equal(answer.includes(first.slotId), index === 0, 'Vapi must offer the remaining place only in the capacity-three tenant')
    }
    assert.equal((await withTenant(accounts[0]!.tenantId, () => cal.read())).settings?.capacity, 3)
    assert.equal((await withTenant(accounts[1]!.tenantId, () => cal.read())).settings, undefined)
  } finally {
    for (let index = 0; index < accounts.length; index++) await withTenant(accounts[index]!.tenantId, () => cal.mutate(() => saved[index]!))
  }
})

test('a known follow-up ID in a different account does not grant mutation access', async () => {
  await withTenant(accounts[1]!.tenantId, () => docs.set('followup:fu-bravo-private', { id: 'fu-bravo-private', status: 'scheduled' }))
  const result = await invoke(leads, { method: 'POST', headers: headers(0), body: {
    action: 'followup_status', id: 'fu-bravo-private', status: 'done', tenantId: accounts[1]!.tenantId,
  } })
  assert.equal(result.code, 404)
  assert.deepEqual(await withTenant(accounts[1]!.tenantId, () => docs.get('followup:fu-bravo-private')), { id: 'fu-bravo-private', status: 'scheduled' })
})

test('unmapped assistants, forged scope headers, and unsigned named-tenant webhooks cannot write', async () => {
  assert.equal((await webhook(0, { type: 'status-update', status: 'unsigned' }, false)).code, 401)
  const unmapped = await invoke(vapi, { method: 'POST', headers: { 'x-vapi-secret': secret, 'x-tenant-id': accounts[0]!.tenantId },
    body: { tenantId: accounts[0]!.tenantId, message: { type: 'status-update', call: { id: 'forged', assistantId: 'not-assigned' } } } })
  assert.equal(unmapped.code, 403)
  assert.equal((await invoke(leads, { method: 'GET', headers: { 'x-tenant-id': accounts[0]!.tenantId, 'x-ops-passcode': 'demo' } })).code, 401)
})

test('async store adapters keep concurrent request scopes and legacy data distinct', async () => {
  await docs.set('private:shared', { owner: 'legacy' })
  await Promise.all(accounts.map((account) => withTenant(account.tenantId, async () => {
    await docs.set('private:shared', { owner: account.tenantId })
    await new Promise((resolve) => setTimeout(resolve, 2))
    assert.deepEqual(await docs.get('private:shared'), { owner: account.tenantId })
    await cal.mutate((state) => ({ ...state, bookings: [{ idempotencyKey: 'shared', slotId: 'same-slot',
      startsAt: '2026-09-15T16:00:00Z', endsAt: '2026-09-15T16:30:00Z', prospectName: account.tenantId,
      prospectPhone: phone, unitId: 'same-unit' } as any] }))
  })))
  assert.deepEqual(await docs.get('private:shared'), { owner: 'legacy' })
  for (const account of accounts) {
    assert.equal((await withTenant(account.tenantId, () => cal.read())).bookings[0]!.prospectName, account.tenantId)
  }
})

test('cached Vapi history never reuses another account’s call list', async () => {
  const previous = accounts
  const previousFetch = globalThis.fetch
  let requests = 0
  accounts = ['charlie', 'delta'].map((id) => ({ ...previous[0]!, username: id, tenantId: `test-${id}`,
    displayName: id, assistantIds: [`assistant-${id}`] }))
  process.env.OPS_ACCOUNTS_JSON = JSON.stringify(accounts)
  process.env.VAPI_API_KEY = 'local-test-only'
  globalThis.fetch = async () => {
    requests++
    // Intentionally return both tenants even though the request asks Vapi for one.
    return new Response(JSON.stringify(accounts.map((account) => ({ id: `call-${account.username}`,
      assistantId: account.assistantIds[0], transcript: `${account.username} private transcript` }))))
  }
  try {
    const a = await invoke(vapi, { method: 'GET', headers: headers(0) })
    const b = await invoke(vapi, { method: 'GET', headers: headers(1) })
    const cachedA = await invoke(vapi, { method: 'GET', headers: headers(0) })
    assert.deepEqual(a.body.calls.map((c: any) => c.id), ['call-charlie'])
    assert.deepEqual(b.body.calls.map((c: any) => c.id), ['call-delta'])
    assert.deepEqual(cachedA.body.calls.map((c: any) => c.id), ['call-charlie'])
    assert.equal(requests, 2)
  } finally {
    globalThis.fetch = previousFetch
    accounts = previous
    process.env.OPS_ACCOUNTS_JSON = JSON.stringify(accounts)
    delete process.env.VAPI_API_KEY
  }
})

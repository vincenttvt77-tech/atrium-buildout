import { before, beforeEach, after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { runWorkflowOnce } from '../../src/workflows/worker.ts'
import { ResendTransport } from '../../src/email/render.ts'
import { createResendEmailConnector, emailWorkflowAction, emailMessageDigest } from '../../src/email/workflow.ts'

// Actual Resend adapter and restricted PostgreSQL roles; only this synthetic HTTP
// server receives traffic. No deployment environment or real provider credentials.
let db, connection, authorization, password, server, origin
const requests = [], providerErrors = [], observations = [], behavior = new Map()
const application = 'atrium-email-fixture'
const sender = 'Fixture Leasing <leasing@example.test>'
function workerConnection() {
  const value = db.createAppConnection(); value.pool.options.application_name = application; return value
}
async function handle(request, response) {
  const active = (await db.admin.query('SELECT xact_start FROM pg_catalog.pg_stat_activity WHERE application_name=$1', [application])).rows
  observations.push(active)
  assert.ok(active.length > 0 && active.every(row => row.xact_start === null), 'provider IO must be outside worker transactions')
  assert.equal(request.headers.authorization, 'Bearer fixture-only-key')
  const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  if (request.method === 'POST' && request.url === '/emails') {
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    const body = JSON.parse(raw)
    const key = body.tags.find(tag => tag.name === 'atrium_operation').value
    assert.equal(request.headers['idempotency-key'], 'atrium-' + key)
    requests.push({ method: 'POST', key })
    await db.admin.query('INSERT INTO synthetic_email.messages(id,operation_key,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(operation_key) DO NOTHING',
      [randomUUID(), key, JSON.stringify(body)])
    const row = (await db.admin.query('SELECT * FROM synthetic_email.messages WHERE operation_key=$1', [key])).rows[0]
    if (behavior.get(key) === 'drop_ack') { request.socket.destroy(); return }
    reply(200, { id: row.id }); return
  }
  const match = request.url?.match(/^\/emails\/([a-f0-9-]{36})$/)
  if (request.method === 'GET' && match) {
    const row = (await db.admin.query('SELECT * FROM synthetic_email.messages WHERE id=$1', [match[1]])).rows[0]
    requests.push({ method: 'GET', key: row?.operation_key })
    if (!row || behavior.get(row.operation_key) === 'missing') { reply(404, {}); return }
    const mode = behavior.get(row.operation_key)
    if (mode === 'revoke') await db.admin.query("UPDATE atrium.property_grants SET status='revoked',permission_version=permission_version+1 WHERE membership_id='member-staff-a' AND property_id='property-a1'")
    reply(200, { object: 'email', id: row.id, ...row.body, cc: [], bcc: [], reply_to: row.body.reply_to ?? [],
      ...(mode === 'wrong_recipient' ? { to: ['different@example.test'] } : {}),
      ...(mode === 'wrong_content' ? { html: '<p>Different tour</p>' } : {}),
      last_event: mode === 'pending' ? 'sent' : mode === 'bounced' ? 'bounced' : 'delivered' })
    return
  }
  reply(404, {})
}

before(async () => {
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth)); connection = workerConnection()
  for (const [org, prop] of [['organization-a','property-a1'], ['organization-b','property-b1']]) {
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3::jsonb,now(),'synthetic email fixture',now())`,
    [org, prop, JSON.stringify({ property: { id: prop }, inventory: [], floorplans: [], knowledge: [] })])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2', [org,prop])
  }
  await db.admin.query('CREATE SCHEMA synthetic_email; CREATE TABLE synthetic_email.messages(id uuid PRIMARY KEY,operation_key text UNIQUE NOT NULL,body jsonb NOT NULL)')
  server = createServer((request, response) => handle(request, response).catch(error => {
    providerErrors.push(error); if (!response.headersSent) response.writeHead(500); response.end()
  }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
})
beforeEach(async () => {
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,synthetic_email.messages')
  await db.admin.query("UPDATE atrium.property_grants SET status='active' WHERE membership_id='member-staff-a'")
  requests.length = 0; providerErrors.length = 0; observations.length = 0; behavior.clear()
})
afterEach(() => assert.deepEqual(providerErrors, []))
after(async () => {
  if (server) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  await connection?.close(); await db?.close()
})
async function scope(username = 'owner-a', property = 'property-a1') {
  const principal = await authorization.authenticatePassword(username, password); assert.ok(principal)
  return authorization.authorizeProperty(principal, property, 'operate')
}
const repository = (selected, conn = connection) => new PostgresWorkflowRepository(conn, selected, { requestId: 'email-fixture', configurationVersion: 1 })
function receipt(options = {}) {
  const message = { to: 'prospect@example.test', from: sender, subject: 'Synthetic tour confirmation', html: '<p>Confirmed fixture tour.</p>' }
  const now = Date.now(), recorded = now - (options.expired ? 120000 : 1000)
  const consent = { purpose: 'tour_confirmation', recipient: message.to, contentSha256: emailMessageDigest(message),
    recordedAt: new Date(recorded).toISOString(), expiresAt: new Date(now + (options.expired ? -60000 : 600000)).toISOString(), receiptId: 'permission-fixture' }
  return { source: 'synthetic_email', eventId: 'event-fixture', payload: { fixture: true },
    actions: [{ ...emailWorkflowAction(message, consent, 'same-logical-email'), maxAttempts: 2 }] }
}
function run(repo, org = 'organization-a', property = 'property-a1', overrides = {}) {
  // The real adapter still builds/validates its fixed provider URL. Injection only
  // redirects those exact test requests to our known local synthetic server.
  const transport = new ResendTransport('fixture-only-key', { fetch: async (url, options) => {
    const parsed = new URL(url); assert.equal(parsed.origin, 'https://api.resend.com')
    assert.equal(parsed.search, ''); assert.equal(parsed.hash, '')
    assert.equal(options.redirect, 'error')
    return fetch(origin + parsed.pathname, options)
  } })
  const connector = createResendEmailConnector({ organizationId: org, propertyId: property, from: sender, transport })
  return runWorkflowOnce({ repository: repo, connectors: new Map([[connector.id, connector]]), workerId: 'email-fixture-worker',
    leaseMs: 10000, timeoutMs: 2000, baseBackoffMs: 1, maxBackoffMs: 1, random: () => 0, ...overrides })
}
const count = method => requests.filter(request => request.method === method).length
const advance = () => delay(5)

test('email acknowledgement persists before restart; exact delivery readback completes once with no duplicate send', async () => {
  const selectedScope = await scope(), selected = repository(selectedScope), input = receipt()
  const a = (await selected.accept(input)).actions[0]
  const accepted = await run(selected)
  assert.equal(accepted.state, 'verifying')
  const pending = await selected.get(a.id)
  assert.ok(pending.providerReference); assert.equal(pending.verificationAttempts, 0)
  assert.equal(pending.evidence, null); assert.equal(count('POST'), 1); assert.equal(count('GET'), 0)
  assert.equal((await selected.accept(input)).duplicate, true)
  const replacement = workerConnection()
  try {
    await advance()
    const restarted = repository(selectedScope, replacement)
    assert.equal((await run(restarted)).state, 'succeeded')
    const saved = await restarted.get(a.id)
    assert.equal(saved.providerReference, pending.providerReference)
    assert.equal(saved.evidence.deliveryStatus, 'delivered')
    assert.equal(saved.evidence.recipientRead, 'not_established')
    assert.equal(saved.dispatchAttempts, 1); assert.equal(saved.verificationAttempts, 1)
    assert.deepEqual(await run(restarted), { status: 'idle' })
  } finally { await replacement.close() }
  assert.equal(count('POST'), 1); assert.equal(count('GET'), 1)
  assert.equal(observations.length, 2)
})

test('committed email with lost acknowledgement reaches review and operator replay never sends again', async () => {
  const selected = repository(await scope()), a = (await selected.accept(receipt())).actions[0]
  behavior.set(a.operationKey, 'drop_ack')
  await run(selected); await advance(); await run(selected)
  const held = await selected.get(a.id)
  assert.equal(held.state, 'needs_review'); assert.equal(held.providerReference, null)
  assert.equal(count('POST'), 1); assert.equal(count('GET'), 0)
  assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM synthetic_email.messages')).rows[0].count, 1)
  await selected.replay(a.id, 'operator_inspected_uncertain_email', held.revision)
  await run(selected); await advance(); await run(selected)
  assert.equal((await selected.get(a.id)).state, 'needs_review')
  assert.equal(count('POST'), 1)
})

test('pending delivery and missing provider record remain unconfirmed without resend', async () => {
  for (const mode of ['pending','missing']) {
    const selected = repository(await scope()), input = receipt(); input.eventId = mode; input.actions[0].operationKey = mode
    const a = (await selected.accept(input)).actions[0]; behavior.set(a.operationKey, mode)
    await run(selected); await advance(); await run(selected)
    assert.equal((await selected.get(a.id)).state, 'verifying')
    await advance(); await run(selected)
    assert.equal((await selected.get(a.id)).state, 'needs_review')
    assert.equal(requests.filter(r => r.key === a.operationKey && r.method === 'POST').length, 1)
  }
})

test('wrong recipient, changed content and bounce cannot produce delivery success', async () => {
  for (const mode of ['wrong_recipient','wrong_content','bounced']) {
    const selected = repository(await scope()), input = receipt(); input.eventId = mode; input.actions[0].operationKey = mode
    const a = (await selected.accept(input)).actions[0]; behavior.set(a.operationKey, mode)
    await run(selected); await advance(); await run(selected)
    const saved = await selected.get(a.id)
    assert.equal(saved.state, 'needs_review'); assert.equal(saved.evidence, null)
    assert.equal(saved.dispatchAttempts, 1)
  }
})

test('expired permission prevents provider IO and retains its reason for staff review', async () => {
  const selected = repository(await scope()), a = (await selected.accept(receipt({ expired: true }))).actions[0]
  await run(selected)
  const saved = await selected.get(a.id)
  assert.equal(saved.state, 'needs_review'); assert.equal(saved.lastErrorCode, 'email_consent_expired')
  assert.equal(requests.length, 0)
})

test('an origin revoked during delivery readback prevents committing success', async () => {
  const staff = repository(await scope('staff-a')), worker = repository(await scope())
  const a = (await staff.accept(receipt())).actions[0]; behavior.set(a.operationKey, 'revoke')
  await run(worker); await advance()
  const result = await run(worker)
  assert.equal(result.status, 'stale')
  const saved = await worker.get(a.id)
  assert.equal(saved.state, 'needs_review'); assert.equal(saved.evidence, null)
  assert.equal(count('POST'), 1); assert.equal(count('GET'), 1)
})

test('identical source email keys are property scoped; a wrong connector binding makes no provider request', async () => {
  const a = repository(await scope()), b = repository(await scope('owner-b','property-b1'))
  const input = receipt(), aa = (await a.accept(input)).actions[0], bb = (await b.accept(input)).actions[0]
  assert.notEqual(aa.operationKey, bb.operationKey)
  await run(a); await advance(); await run(a)
  await run(b) // Deliberately use A's connector: scope validation rejects before IO.
  assert.equal((await a.get(aa.id)).state, 'succeeded')
  assert.equal((await b.get(bb.id)).state, 'needs_review')
  assert.equal(await a.get(bb.id), null); assert.equal(await b.get(aa.id), null)
  assert.equal(count('POST'), 1)
})

test('process failure before acknowledgement persistence recovers by verification, never a second email', async () => {
  const selected = repository(await scope()), a = (await selected.accept(receipt())).actions[0]
  let lease
  const interrupted = {
    claim: async options => { lease = await selected.claim(options); return lease }, startDispatch: selected.startDispatch.bind(selected),
    startVerification: selected.startVerification.bind(selected),
    settle: async () => { throw new Error('synthetic process stopped before acknowledgement commit') },
  }
  await assert.rejects(run(interrupted, 'organization-a', 'property-a1', { leaseMs: 1500 }), /synthetic process stopped/)
  const pending = await selected.get(a.id)
  assert.equal(pending.providerReference, null); assert.equal(pending.dispatchStarted, true)
  assert.equal(count('POST'), 1)
  await delay(Math.max(1, Date.parse(lease.expiresAt) - Date.now() + 30))
  await run(selected); await advance(); await run(selected)
  assert.equal((await selected.get(a.id)).state, 'needs_review')
  assert.equal(count('POST'), 1); assert.equal(count('GET'), 0)
})

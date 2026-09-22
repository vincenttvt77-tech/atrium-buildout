import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { canonicalJson, hashJson } from '../../src/workflows/validation.ts'
import { runWorkflowOnce } from '../../src/workflows/worker.ts'

// This provider and every database below are disposable, synthetic fixtures. No
// deployment environment, persistent preview or external provider is consulted.
const WORKER_APP = 'atrium-workflow-http-test'
let db, connection, authorization, password, server, origin
const behavior = new Map(), requests = [], transactionObservations = [], providerErrors = []

function workerConnection() {
  const value = db.createAppConnection()
  value.pool.options.application_name = WORKER_APP
  return value
}

async function localFetch(url, options = {}) {
  if (new URL(url).origin !== origin) throw new Error('Only the synthetic loopback provider is allowed')
  return fetch(url, { ...options, redirect: 'error' })
}

const scopeHeaders = action => ({
  'x-test-organization': action.organizationId,
  'x-test-property': action.propertyId,
})

async function handleProvider(request, response) {
  const active = (await db.admin.query(`SELECT state,xact_start FROM pg_catalog.pg_stat_activity
    WHERE application_name=$1`, [WORKER_APP])).rows
  // A query on a second connection observes actual PostgreSQL transactions while
  // HTTP is in progress, rather than trusting a repository mock's call order.
  transactionObservations.push(active)
  assert.ok(active.length > 0, 'the worker connection must be visible to the observer')
  assert.ok(active.every(row => row.xact_start === null), 'HTTP must run outside worker database transactions')
  const organizationId = request.headers['x-test-organization']
  const propertyId = request.headers['x-test-property']
  const reply = (status, value) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  if (request.method === 'POST' && request.url === '/operations') {
    let text = ''
    for await (const chunk of request) {
      text += chunk.toString('utf8')
      assert.ok(Buffer.byteLength(text) < 16_384)
    }
    const body = JSON.parse(text)
    assert.equal(body.organizationId, organizationId)
    assert.equal(body.propertyId, propertyId)
    assert.equal(body.inputSha256, hashJson(body.input))
    requests.push({ method: 'POST', operationKey: body.operationKey, organizationId, propertyId })
    // A separate schema represents the provider's durable state. Autocommit ends
    // before either the acknowledgment or the deliberate socket failure.
    await db.admin.query(`INSERT INTO synthetic_provider.effects
      (operation_key,organization_id,property_id,input,input_sha256,provider_reference)
      VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(operation_key) DO NOTHING`,
    [body.operationKey, organizationId, propertyId, canonicalJson(body.input), hashJson(body.input), randomUUID()])
    const row = (await db.admin.query('SELECT * FROM synthetic_provider.effects WHERE operation_key=$1', [body.operationKey])).rows[0]
    assert.equal(row.organization_id, organizationId)
    assert.equal(row.property_id, propertyId)
    assert.deepEqual(row.input, body.input)
    if (behavior.get(body.operationKey) === 'drop_after_commit') {
      request.socket.destroy()
      return
    }
    reply(200, { providerReference: row.provider_reference })
    return
  }
  const match = request.url?.match(/^\/operations\/([a-f0-9]{64})$/)
  if (request.method === 'GET' && match) {
    const operationKey = match[1]
    requests.push({ method: 'GET', operationKey, organizationId, propertyId })
    const row = (await db.admin.query(`SELECT * FROM synthetic_provider.effects
      WHERE operation_key=$1 AND organization_id=$2 AND property_id=$3`,
    [operationKey, organizationId, propertyId])).rows[0]
    if (!row) { reply(404, { found: false }); return }
    const mode = behavior.get(operationKey)
    if (mode === 'revoke_before_readback') {
      // The worker already passed startVerification. Revoke the ORIGINAL staff
      // actor while HTTP is outstanding; the owner worker remains authorized.
      await db.admin.query(`UPDATE atrium.property_grants SET status='revoked',permission_version=permission_version+1
        WHERE membership_id='member-staff-a' AND property_id='property-a1'`)
    }
    reply(200, {
      operationKey: row.operation_key,
      inputSha256: mode === 'wrong_hash' ? '0'.repeat(64) : row.input_sha256,
      input: mode === 'wrong_unit' ? { ...row.input, unitId: '99Z' } : row.input,
      providerReference: row.provider_reference,
    })
    return
  }
  reply(404, { found: false })
}

const connector = {
  id: 'synthetic', idempotentWrites: true,
  async dispatch(action, signal) {
    const response = await localFetch(`${origin}/operations`, {
      method: 'POST', signal, headers: { ...scopeHeaders(action), 'content-type': 'application/json' },
      body: JSON.stringify({ operationKey: action.operationKey, organizationId: action.organizationId,
        propertyId: action.propertyId, inputSha256: action.inputSha256, input: action.input }),
    })
    if (!response.ok) return { status: 'unknown', code: 'synthetic_provider_unavailable' }
    return { status: 'accepted', providerReference: (await response.json()).providerReference }
  },
  async verify(action, signal) {
    const response = await localFetch(`${origin}/operations/${action.operationKey}`, { signal, headers: scopeHeaders(action) })
    if (response.status === 404) return { status: 'not_found', authoritative: true }
    if (!response.ok) return { status: 'unknown', code: 'synthetic_provider_unavailable' }
    const record = await response.json()
    // A connector compares the actual provider object, not merely its echoed key.
    // The generic worker independently checks the returned operation key/digest.
    if (canonicalJson(record.input) !== canonicalJson(action.input)) return { status: 'mismatch', code: 'provider_input_mismatch' }
    return { status: 'matched', operationKey: record.operationKey, inputSha256: record.inputSha256,
      providerReference: record.providerReference, evidence: { unitId: record.input.unitId, startsAt: record.input.startsAt } }
  },
}

before(async () => {
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  connection = workerConnection()
  for (const [organizationId, propertyId] of [['organization-a', 'property-a1'], ['organization-b', 'property-b1']]) {
    const bundle = { property: { id: propertyId }, inventory: [], floorplans: [], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3::jsonb,'2026-09-01T00:00:00Z','synthetic workflow HTTP fixture',now())`,
    [organizationId, propertyId, JSON.stringify(bundle)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2',
      [organizationId, propertyId])
  }
  await db.admin.query(`CREATE SCHEMA synthetic_provider;
    CREATE TABLE synthetic_provider.effects (
      operation_key text PRIMARY KEY, organization_id text NOT NULL, property_id text NOT NULL,
      input jsonb NOT NULL, input_sha256 text NOT NULL, provider_reference text NOT NULL UNIQUE)`)
  server = createServer((request, response) => {
    handleProvider(request, response).catch(error => {
      providerErrors.push(error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
})

beforeEach(async () => {
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,synthetic_provider.effects')
  await db.admin.query("UPDATE atrium.property_grants SET status='active' WHERE membership_id='member-staff-a'")
  behavior.clear(); requests.length = 0; transactionObservations.length = 0; providerErrors.length = 0
})

after(async () => {
  if (server) await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
  await connection?.close()
  await db?.close()
})

async function userScope(username = 'owner-a', propertyId = 'property-a1') {
  const principal = await authorization.authenticatePassword(username, password)
  assert.ok(principal)
  return authorization.authorizeProperty(principal, propertyId, 'operate')
}
const repository = (scope, selectedConnection = connection) => new PostgresWorkflowRepository(selectedConnection, scope,
  { requestId: 'workflow-http-test', configurationVersion: 1 })
const receipt = (eventId = 'synthetic-event', operationKey = 'synthetic-operation', unitId = '4A') => ({
  source: 'synthetic', eventId, payload: { source: 'loopback-test' },
  actions: [{ kind: 'tour.create', connector: 'synthetic', operationKey,
    input: { unitId, startsAt: '2026-10-01T16:00:00.000Z' }, maxAttempts: 3 }],
})
const run = (selected, overrides = {}) => runWorkflowOnce({
  repository: selected, connectors: new Map([[connector.id, connector]]), workerId: 'http-test-worker',
  leaseMs: 10_000, timeoutMs: 2_000, random: () => 0, ...overrides,
})
const calls = (method, operationKey) => requests.filter(request => request.method === method && request.operationKey === operationKey)
async function effect(operationKey) {
  return (await db.admin.query('SELECT * FROM synthetic_provider.effects WHERE operation_key=$1', [operationKey])).rows[0]
}
async function events(actionId) {
  return (await db.admin.query('SELECT event_kind,details FROM atrium.workflow_events WHERE action_id=$1 ORDER BY created_at,id', [actionId])).rows
}
function assertProviderHealthy() {
  assert.deepEqual(providerErrors, [])
  assert.ok(transactionObservations.length >= 2)
  assert.ok(transactionObservations.every(rows => rows.length > 0 && rows.every(row => row.xact_start === null)))
}

test('real HTTP effect and matching readback commit success, with no worker transaction held during network IO', async () => {
  const selected = repository(await userScope())
  const accepted = await selected.accept(receipt()), action = accepted.actions[0]
  assert.equal(accepted.duplicate, false)
  assert.deepEqual(await run(selected), { status: 'settled', actionId: action.id, state: 'succeeded' })
  const saved = await selected.get(action.id), remote = await effect(action.operationKey)
  assert.equal(saved.state, 'succeeded')
  assert.equal(saved.providerReference, remote.provider_reference)
  assert.deepEqual(saved.evidence, action.input)
  assert.equal(remote.input_sha256, action.inputSha256)
  assert.equal(calls('POST', action.operationKey).length, 1)
  assert.equal(calls('GET', action.operationKey).length, 1)
  assert.equal((await selected.accept(receipt())).duplicate, true)
  assert.deepEqual(await run(selected), { status: 'idle' })
  await assert.rejects(localFetch('https://example.invalid/never-sent'), /Only the synthetic loopback/)
  assertProviderHealthy()
})

test('a committed effect with a dropped HTTP response survives worker interruption and expired-lease restart without another POST', async () => {
  const scope = await userScope(), selected = repository(scope)
  const action = (await selected.accept(receipt())).actions[0]
  behavior.set(action.operationKey, 'drop_after_commit')
  let lease
  // Model process termination at the next repository boundary, after the actual
  // provider committed but before verification/settlement could be attempted.
  const interrupted = {
    claim: async options => { lease = await selected.claim(options); return lease },
    startDispatch: selected.startDispatch.bind(selected),
    startVerification: async () => { throw new Error('synthetic worker interruption') },
    settle: selected.settle.bind(selected),
  }
  await assert.rejects(run(interrupted, { leaseMs: 1_500 }), /synthetic worker interruption/)
  assert.ok(await effect(action.operationKey))
  assert.equal(calls('POST', action.operationKey).length, 1)
  assert.equal(calls('GET', action.operationKey).length, 0)
  const pending = await selected.get(action.id)
  assert.equal(pending.state, 'running')
  assert.equal(pending.phase, 'verify')
  assert.equal(pending.dispatchStarted, true)
  assert.equal(pending.verificationAttempts, 0)
  await delay(Math.max(1, Date.parse(lease.expiresAt) - Date.now() + 30))
  const restartedConnection = workerConnection()
  try {
    const restarted = repository(scope, restartedConnection)
    assert.deepEqual(await run(restarted, { workerId: 'restarted-http-worker' }),
      { status: 'settled', actionId: action.id, state: 'succeeded' })
    const saved = await restarted.get(action.id)
    assert.equal(saved.dispatchAttempts, 1)
    assert.equal(saved.verificationAttempts, 1)
    assert.equal(saved.providerReference, (await effect(action.operationKey)).provider_reference)
    assert.ok((await events(action.id)).some(event => event.event_kind === 'lease_recovered'))
  } finally { await restartedConnection.close() }
  assert.equal(calls('POST', action.operationKey).length, 1)
  assert.equal(calls('GET', action.operationKey).length, 1)
  assertProviderHealthy()
})

test('the same logical operation in two organizations produces separate provider keys and never exposes the other property result', async () => {
  const a = repository(await userScope()), b = repository(await userScope('owner-b', 'property-b1'))
  const actionA = (await a.accept(receipt('same-event', 'same-logical-key', '4A'))).actions[0]
  const actionB = (await b.accept(receipt('same-event', 'same-logical-key', '7B'))).actions[0]
  assert.notEqual(actionA.operationKey, actionB.operationKey)
  assert.equal((await run(a)).state, 'succeeded')
  assert.equal((await run(b)).state, 'succeeded')
  assert.equal(await a.get(actionB.id), null)
  assert.equal(await b.get(actionA.id), null)
  assert.deepEqual((await a.list()).map(action => action.id), [actionA.id])
  assert.deepEqual((await b.list()).map(action => action.id), [actionB.id])
  for (const action of [actionA, actionB]) {
    const saved = await effect(action.operationKey)
    assert.equal(saved.organization_id, action.organizationId)
    assert.equal(saved.property_id, action.propertyId)
    assert.deepEqual(saved.input, action.input)
    assert.equal(calls('POST', action.operationKey).length, 1)
  }
  const foreign = await localFetch(`${origin}/operations/${actionB.operationKey}`, { headers: scopeHeaders(actionA) })
  assert.equal(foreign.status, 404)
  assert.deepEqual(await foreign.json(), { found: false })
  assertProviderHealthy()
})

for (const [mode, code] of [['wrong_hash', 'verification_identity_mismatch'], ['wrong_unit', 'provider_input_mismatch']]) {
  test(`provider readback with ${mode} requires review and never becomes a confirmed effect`, async () => {
    const selected = repository(await userScope())
    const action = (await selected.accept(receipt())).actions[0]
    behavior.set(action.operationKey, mode)
    assert.deepEqual(await run(selected), { status: 'settled', actionId: action.id, state: 'needs_review', code })
    const saved = await selected.get(action.id)
    assert.equal(saved.state, 'needs_review')
    assert.equal(saved.lastErrorCode, code)
    assert.equal(saved.evidence, null)
    assert.ok(await effect(action.operationKey), 'the provider effect exists, but is not verified')
    assert.equal((await events(action.id)).some(event => event.details.state === 'succeeded'), false)
    assertProviderHealthy()
  })
}

test('revoking the original staff grant after HTTP dispatch and before completion holds the result instead of reporting success', async () => {
  const staff = repository(await userScope('staff-a'))
  const action = (await staff.accept(receipt())).actions[0]
  const ownerWorker = repository(await userScope())
  behavior.set(action.operationKey, 'revoke_before_readback')
  assert.deepEqual(await run(ownerWorker), { status: 'stale', actionId: action.id })
  const saved = await ownerWorker.get(action.id)
  assert.equal(saved.state, 'needs_review')
  assert.equal(saved.lastErrorCode, 'original_authorization_changed')
  assert.equal(saved.evidence, null)
  assert.equal(saved.origin.userId, 'staff-a')
  assert.ok(await effect(action.operationKey), 'revocation cannot undo an external effect that already happened')
  assert.ok((await events(action.id)).some(event => event.event_kind === 'held' && event.details.code === 'original_authorization_changed'))
  assert.equal((await events(action.id)).some(event => event.details.state === 'succeeded'), false)
  assert.equal(calls('POST', action.operationKey).length, 1)
  assert.equal(calls('GET', action.operationKey).length, 1)
  assertProviderHealthy()
})

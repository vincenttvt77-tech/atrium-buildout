import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import workflows from '../../api/workflows.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'

const priorMode = process.env.ATRIUM_RUNTIME_MODE
let db, runtime, server, origin, password
const cookies = {}, repositories = {}, initial = {}
const buildings = [['organization-a', 'property-a1', 'owner-a'], ['organization-a', 'property-a2', 'owner-a'], ['organization-b', 'property-b1', 'owner-b']]
const settings = { capacity: 3, slotMinutes: 30, startIntervalMinutes: 30, bufferMinutes: 0,
  minimumNoticeMinutes: 0, bookingWindowDays: null, sameUnitPolicy: 'exclusive', hours: { 1: { openHour: 9, closeHour: 17 } } }

async function accept(property, marker = randomUUID()) {
  const result = await repositories[property].accept({ source: 'synthetic-queue-http', eventId: marker,
    payload: { sensitive: 'synthetic-private-resident-history' }, actions: [{ kind: 'maintenance.create', connector: 'synthetic-pms',
      operationKey: marker, input: { sensitive: 'synthetic-private-resident-history' } }] })
  return result.actions[0]
}
before(async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase()
  password = (await seedFoundationTestDatabase(db.admin)).password
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: 'synthetic-workflow-http-session-secret-long-enough', authOrigin: TEST_AUTH_ORIGIN })
  for (const [org, property, user] of buildings) {
    const timeZone = property === 'property-a2' ? 'America/Chicago' : property === 'property-b1' ? 'America/Los_Angeles' : 'America/New_York'
    const bundle = { property: { id: property, organizationId: org, buildingName: property,
      timeZone, jurisdiction: 'NY', tourSettings: settings }, inventory: [], floorplans: [], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,clock_timestamp(),'synthetic-queue',clock_timestamp())`, [org, property, JSON.stringify(bundle)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2', [org, property])
    const principal = await runtime.authorization.authenticatePassword(user, password)
    const scope = await runtime.authorization.authorizeProperty(principal, property, 'configure')
    repositories[property] = new PostgresWorkflowRepository(db.app, scope, { requestId: `seed-${property}`, configurationVersion: 1 })
    initial[property] = await accept(property)
  }
  server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = runtime
      let raw = ''; for await (const chunk of req) raw += chunk
      req.body = raw
      const url = new URL(req.url, 'http://localhost')
      req.query = {}
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key); req.query[key] = values.length === 1 ? values[0] : values
      }
      res.status = code => { res.statusCode = code; return res }
      res.send = body => { res.end(body); return res }
      res.json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res }
      await (url.pathname === '/api/dashboard' ? dashboard : workflows)(req, res)
    } catch { res.statusCode = 500; res.end(JSON.stringify({ error: 'test-server-failed' })) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
  for (const user of ['owner-a', 'owner-b', 'staff-a', 'viewer-a']) {
    const response = await fetch(origin + '/api/dashboard', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: user, password }) })
    assert.equal(response.status, 303)
    cookies[user] = response.headers.get('set-cookie').split(';')[0]
    await response.text(); await verifyMfaCookie(runtime, cookies[user], password)
  }
})
after(async () => {
  if (server) { server.close(); server.closeAllConnections(); await once(server, 'close') }
  if (db) await db.close()
  priorMode === undefined ? delete process.env.ATRIUM_RUNTIME_MODE : process.env.ATRIUM_RUNTIME_MODE = priorMode
})
async function request(query = '?state=all', { user = 'owner-a', property = 'property-a1', org = 'organization-a', body, headers = {}, method } = {}) {
  const response = await fetch(origin + '/api/workflows' + query, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { cookie: cookies[user] ?? '', 'x-atrium-organization-id': org, 'x-atrium-property-id': property,
      'x-atrium-config-version': '1', ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  return { status: response.status, body: await response.json(), headers: response.headers }
}
const command = (action, row, reason) => ({ action, id: row.id, expectedRevision: row.revision, reason })

test('queue HTTP returns only the chosen property and a small safe projection', async () => {
  for (const [org, property, user] of buildings) {
    const result = await request('?state=all', { org, property, user })
    assert.equal(result.status, 200)
    assert.equal(result.body.actions.length, 1)
    assert.equal(result.body.actions[0].id, initial[property].id)
    assert.equal(result.body.scope.propertyId, property)
    assert.equal(result.body.canManage, true)
    assert.equal(result.body.executionEnabled, false)
    assert.match(result.body.actions[0].revision, /^[a-f0-9]{64}$/)
    assert.match(result.headers.get('cache-control'), /no-store/)
    assert.doesNotMatch(JSON.stringify(result.body), /synthetic-private-resident-history|inputSha256|operationKey|receiptId|origin_user|lease_token/)
  }
  const viewer = await request('?state=all', { user: 'viewer-a' })
  assert.equal(viewer.status, 200); assert.equal(viewer.body.canManage, false)
  assert.equal(viewer.body.actions[0].canReplay, false); assert.equal(viewer.body.actions[0].canCancel, false)
})

test('anonymous, forged property, stale configuration, mixed scope and unsupported method are refused', async () => {
  assert.equal((await request('', { user: 'missing' })).status, 401)
  assert.equal((await request('', { org: 'organization-b', property: 'property-b1' })).status, 403)
  assert.equal((await request('', { org: 'organization-b' })).status, 403)
  assert.equal((await request('', { user: 'staff-a', property: 'property-a2' })).status, 403)
  assert.equal((await request('', { headers: { 'x-atrium-config-version': '999' } })).status, 409)
  assert.equal((await request('', { headers: { 'x-atrium-property-id': '' } })).status, 428)
  assert.equal((await request('', { method: 'DELETE' })).status, 405)
})

test('recovery requires current configure authority, same origin, exact command and matching property', async () => {
  const body = command('cancel', initial['property-a1'], 'no_longer_needed')
  for (const user of ['staff-a', 'viewer-a']) assert.equal((await request('', { user, body })).status, 403)
  for (const headers of [{ origin: 'https://foreign.invalid' }, { origin: '' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await request('', { body, headers })).status, 403)
  }
  for (const invalid of [{ ...body, expectedRevision: undefined }, { ...body, role: 'owner' }, { ...body, action: 'dispatch' }, '{not-json', ' '.repeat(2049)]) {
    assert.equal((await request('', { body: invalid })).status, 400)
  }
  const foreign = command('cancel', initial['property-b1'], 'no_longer_needed')
  assert.equal((await request('', { body: foreign })).status, 404)
  assert.equal((await repositories['property-a1'].get(body.id)).state, 'queued')
  assert.equal((await repositories['property-b1'].get(foreign.id)).state, 'queued')
})

test('HTTP cancellation is durable and audit attributed; stale retry cannot replay a changed row', async () => {
  const row = await accept('property-a1')
  const cancelled = await request('', { body: command('cancel', row, 'no_longer_needed') })
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.action.state, 'cancelled')
  assert.equal(cancelled.body.action.canCancel, false)
  assert.notEqual(cancelled.body.action.revision, row.revision)
  const stale = await request('', { body: command('replay', row, 'reviewed_request') })
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'workflow_revision_conflict')
  assert.equal((await repositories['property-a1'].get(row.id)).state, 'cancelled')
  const audit = (await db.admin.query("SELECT actor_user_id,event_kind,details FROM atrium.workflow_events WHERE action_id=$1 AND event_kind='cancelled'", [row.id])).rows
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, 'owner-a')
  assert.equal(audit[0].details.reason, 'no_longer_needed')
  const replay = await request('', { body: command('replay', cancelled.body.action, 'reviewed_request') })
  assert.equal(replay.status, 200); assert.equal(replay.body.action.state, 'queued')
  assert.equal(replay.body.executionEnabled, false)
  assert.equal((await repositories['property-a1'].get(row.id)).dispatchAttempts, 0)
})

test('an action that might already have dispatched is shown as uncertain and cannot be cancelled', async () => {
  const property = 'property-a2', repository = repositories[property]
  const claim = await repository.claim({ workerId: 'synthetic-queue-worker', leaseMs: 30000 })
  assert.ok(claim)
  const started = await repository.startDispatch(claim)
  assert.equal(started.status, 'ready')
  assert.equal(await repository.settle(started.claim, { state: 'needs_review', code: 'verification_unknown' }), true)
  const result = await request('?state=attention', { property })
  assert.equal(result.status, 200); assert.equal(result.body.actions.length, 1)
  const row = result.body.actions[0]
  assert.equal(row.state, 'needs_review'); assert.equal(row.dispatchStarted, true); assert.equal(row.canCancel, false)
  assert.equal((await request('', { property, body: command('cancel', row, 'no_longer_needed') })).status, 409)
  const replay = await request('', { property, body: command('replay', row, 'provider_recovered') })
  assert.equal(replay.status, 200); assert.equal(replay.body.action.state, 'verifying')
  assert.equal(replay.body.action.dispatchAttempts, 1)
})

test('queue pagination visits every exact-timestamp row once and rejects malformed cursors', async () => {
  for (let i = 0; i < 6; i++) await accept('property-a1')
  const expected = await repositories['property-a1'].list({ limit: 100 })
  const ids = []
  let query = '?state=all&limit=2'
  for (let page = 0; page < 20; page++) {
    const result = await request(query)
    assert.equal(result.status, 200)
    ids.push(...result.body.actions.map(row => row.id))
    if (!result.body.nextCursor) break
    query = '?' + new URLSearchParams({ state: 'all', limit: '2', beforeCreatedAt: result.body.nextCursor.createdAt, beforeId: result.body.nextCursor.id })
  }
  assert.deepEqual(ids, expected.map(row => row.id)); assert.equal(new Set(ids).size, ids.length)
  for (const query of ['?state=all&state=active', '?limit=1000', '?beforeId=one', '?beforeCreatedAt=today&beforeId=one', '?state=all&role=owner']) {
    assert.equal((await request(query)).status, 400)
  }
})

test('revoked current membership and session fail before recovery; legacy mode has no fallback queue', async () => {
  const row = await accept('property-a1')
  await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'")
  try { assert.equal((await request('', { body: command('cancel', row, 'no_longer_needed') })).status, 403) }
  finally { await db.admin.query("UPDATE atrium.memberships SET status='active' WHERE id='member-owner-a'") }
  const principal = await runtime.authenticate({ cookie: cookies['owner-a'] }, new Date())
  await runtime.sessions.revoke(principal, principal.sessionId)
  assert.equal((await request('', { body: command('cancel', row, 'no_longer_needed') })).status, 401)
  assert.equal((await repositories['property-a1'].get(row.id)).state, 'queued')
  delete process.env.ATRIUM_RUNTIME_MODE
  try { assert.equal((await request()).status, 404) }
  finally { process.env.ATRIUM_RUNTIME_MODE = 'postgres' }
})

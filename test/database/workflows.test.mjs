import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { scopeContext } from '../../src/database/scope.ts'
import { hashJson } from '../../src/workflows/validation.ts'
import { runWorkflowOnce } from '../../src/workflows/worker.ts'

let db, authorization, password
const properties = [['organization-a','property-a1'],['organization-a','property-a2'],['organization-b','property-b1'],['organization-b','property-b2']]
before(async () => {
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  for (const [org, property] of properties) {
    const bundle = { property: { id: property }, inventory: [], floorplans: [], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3::jsonb,now(),'synthetic workflow fixture',now())`, [org,property,JSON.stringify(bundle)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1', [property])
  }
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('channel-a-two','vapi','synthetic-assistant-a-two','organization-a','property-a1','active',ARRAY['read','operate'])`)
})
beforeEach(async () => {
  // Only this disposable fixture is truncated. No persistent demo or provider is used.
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events')
  await db.admin.query("UPDATE atrium.users SET status='active',credential_version=1")
  await db.admin.query("UPDATE atrium.memberships SET status='active'")
  await db.admin.query("UPDATE atrium.property_grants SET status='active'")
  await db.admin.query("UPDATE atrium.channel_bindings SET status='active',permission_version=1")
  await db.admin.query("UPDATE atrium.properties SET status='active',published_configuration_version=1")
})
after(async () => { await db?.close() })
async function scope(user = 'owner-a', property = 'property-a1', permission = 'operate') {
  const principal = await authorization.authenticatePassword(user, password)
  assert.ok(principal)
  return authorization.authorizeProperty(principal, property, permission)
}
const repo = (selected, connection = db.app) => new PostgresWorkflowRepository(connection, selected,
  { requestId: 'workflow-test-request', configurationVersion: 1 })
const receipt = (overrides = {}) => ({ source: 'synthetic', eventId: 'event-one', payload: { number: 1 },
  actions: [{ kind: 'test.create', connector: 'synthetic', operationKey: 'operation-one', input: { target: 'synthetic-object' }, maxAttempts: 2 }], ...overrides })
async function accepted(repository, input = receipt()) { return (await repository.accept(input)).actions[0] }
async function claim(repository) { const value = await repository.claim({ workerId: 'test-worker', leaseMs: 30_000 }); assert.ok(value); return value }
async function started(repository) {
  let value = await claim(repository)
  const dispatch = await repository.startDispatch(value); assert.equal(dispatch.status, 'ready'); value = dispatch.claim
  const verification = await repository.startVerification(value); assert.equal(verification.status, 'ready')
  return verification.claim
}
async function expire(id) {
  await db.admin.query(`UPDATE atrium.outbox_messages SET lease_acquired_at=clock_timestamp()-interval '2 seconds',
    lease_expires_at=clock_timestamp()-interval '1 second' WHERE action_id=$1`, [id])
}
async function events(id) { return (await db.admin.query('SELECT event_kind,details FROM atrium.workflow_events WHERE action_id=$1 ORDER BY created_at,id',[id])).rows }

test('one receipt atomically creates actions and outbox jobs; exact duplicates reuse them and conflicting payloads/manifests fail', async () => {
  const repository = repo(await scope())
  const input = receipt({ actions: [receipt().actions[0], { ...receipt().actions[0], operationKey: 'second-operation' }] })
  const first = await repository.accept(input), duplicate = await repository.accept(structuredClone(input))
  assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.receiptId, first.receiptId)
  assert.deepEqual(duplicate.actions.map(a => a.id), first.actions.map(a => a.id))
  assert.ok(first.actions.every(a => a.inputSha256 === hashJson(a.input)))
  for (const changed of [receipt({ payload: { number: 2 }, actions: input.actions }),
    receipt({ actions: [{ ...input.actions[0], maxAttempts: 1 }, input.actions[1]] }),
    receipt({ actions: [...input.actions].reverse() })]) {
    await assert.rejects(repository.accept(changed), { code: 'workflow_receipt_conflict' })
  }
  await assert.rejects(repository.accept(receipt({ eventId: 'other-event', actions: [
    { ...input.actions[0], operationKey: 'unique-first' }, input.actions[1]] })), { code: 'workflow_operation_conflict' })
  for (const table of ['inbox_events','action_intents','outbox_messages','workflow_events']) {
    const count = Number((await db.admin.query(`SELECT count(*) FROM atrium.${table}`)).rows[0].count)
    assert.equal(count, table === 'inbox_events' ? 1 : 2, `conflict must roll back all ${table} writes`)
  }
})

test('receipts accept twenty actions atomically and reject twenty-one without partial writes', async () => {
  const repository = repo(await scope())
  const actions = Array.from({ length: 20 }, (_, index) => ({ ...receipt().actions[0], operationKey: `bulk-${index}` }))
  const input = receipt({ actions })
  const first = await repository.accept(input)
  assert.equal(first.actions.length, 20)
  assert.deepEqual((await repository.accept(input)).actions.map(action => action.id), first.actions.map(action => action.id))
  await assert.rejects(repository.accept(receipt({ eventId: 'oversized', actions: [
    ...actions, { ...receipt().actions[0], operationKey: 'bulk-20' }
  ] })), { code: 'workflow_invalid_input' })
  for (const table of ['inbox_events','action_intents','outbox_messages','workflow_events']) {
    const count = Number((await db.admin.query(`SELECT count(*) FROM atrium.${table}`)).rows[0].count)
    assert.equal(count, table === 'inbox_events' ? 1 : 20)
  }
})

test('two organizations and two properties retain separate receipts, lists and provider operation keys', async () => {
  const repos = await Promise.all(properties.map(async ([org, property]) => repo(await scope(org === 'organization-a' ? 'owner-a' : 'owner-b', property))))
  const actions = await Promise.all(repos.map(repository => accepted(repository)))
  assert.equal(new Set(actions.map(a => a.operationKey)).size, 4)
  for (let index = 0; index < repos.length; index++) {
    assert.equal((await repos[index].list()).length, 1)
    assert.equal((await repos[index].get(actions[index].id)).propertyId, properties[index][1])
    assert.equal(await repos[index].get(actions[(index + 1) % 4].id), null)
    assert.equal(actions[index].operationKey, hashJson([...properties[index], 'synthetic', 'test.create', 'operation-one']))
  }
})

test('event identities are scoped to the original user or binding as well as the property', async () => {
  const owner = repo(await scope())
  const channel = repo(await authorization.authorizeChannel('vapi','synthetic-assistant-a','operate'))
  const secondChannel = repo(await authorization.authorizeChannel('vapi','synthetic-assistant-a-two','operate'))
  const actions = []
  for (const [index, repository] of [owner,channel,secondChannel].entries()) {
    const input = receipt({ actions: [{ ...receipt().actions[0], operationKey: `origin-operation-${index}` }] })
    actions.push(await accepted(repository, input))
    assert.equal((await repository.accept(input)).duplicate, true)
  }
  assert.equal(new Set(actions.map(a => a.receiptId)).size, 3)
  assert.deepEqual(actions.map(a => a.origin.kind), ['user','channel','channel'])
})

test('forced RLS and grants prevent unscoped reads, viewer writes, authenticator access and cross-property ownership moves', async () => {
  const selected = await scope(), repository = repo(selected), a = await accepted(repository)
  const flags = (await db.admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='atrium' AND c.relname IN ('inbox_events','action_intents','outbox_messages','workflow_events')`)).rows
  assert.equal(flags.length, 4); assert.ok(flags.every(row => row.relrowsecurity && row.relforcerowsecurity))
  const unscoped = await db.app.transaction({}, client => client.query('SELECT id FROM atrium.action_intents'))
  assert.equal(unscoped.rowCount, 0)
  await assert.rejects(db.auth.transaction({}, client => client.query('SELECT id FROM atrium.action_intents')), { code: '42501' })
  await assert.rejects(repo(await scope('viewer-a','property-a1','read')).accept(receipt()), { code: 'forbidden' })
  await assert.rejects(db.app.transaction(scopeContext(selected), client => client.query('DELETE FROM atrium.outbox_messages')), { code: '42501' })
  await assert.rejects(db.app.transaction(scopeContext(selected), client => client.query('TRUNCATE atrium.outbox_messages')), { code: '42501' })
  await assert.rejects(db.admin.query("UPDATE atrium.action_intents SET property_id='property-a2' WHERE id=$1",[a.id]), { code: '23514' })
  await assert.rejects(db.admin.query("UPDATE atrium.inbox_events SET payload='{}'::jsonb WHERE id=$1",[a.receiptId]), { code: '23514' })
  await assert.rejects(db.admin.query("UPDATE atrium.action_intents SET max_attempts=10 WHERE id=$1",[a.id]), { code: '23514' })
  await assert.rejects(db.admin.query("UPDATE atrium.workflow_events SET details='{}'::jsonb WHERE action_id=$1",[a.id]), { code: '23514' })
  await assert.rejects(db.admin.query(`INSERT INTO atrium.outbox_messages(organization_id,property_id,action_id)
    VALUES('organization-b','property-b1',$1)`, [a.id]), { code: '23503' })
  await assert.rejects(db.admin.query("UPDATE atrium.outbox_messages SET state='running' WHERE action_id=$1", [a.id]), { code: '23514' })
})

test('concurrent accepts and SKIP LOCKED claims create exactly one action and one active lease', async () => {
  const selected = await scope(), firstConnection = db.createAppConnection(), secondConnection = db.createAppConnection()
  try {
    const first = repo(selected, firstConnection), second = repo(selected, secondConnection)
    const acceptedRows = await Promise.all([first.accept(receipt()),second.accept(receipt())])
    assert.equal(new Set(acceptedRows.map(row => row.receiptId)).size, 1)
    assert.deepEqual(acceptedRows.map(row => row.duplicate).sort(), [false,true])
    const claims = await Promise.all([first.claim({workerId:'worker-one',leaseMs:30_000}), second.claim({workerId:'worker-two',leaseMs:30_000})])
    assert.equal(claims.filter(Boolean).length, 1)
    const active = claims.find(Boolean)
    assert.ok(Date.parse(active.expiresAt) > Date.parse(active.acquiredAt))
  } finally { await firstConnection.close(); await secondConnection.close() }
})

test('expired dispatch leases recover in verify phase and stale tokens cannot settle or start another write', async () => {
  const repository = repo(await scope()), a = await accepted(repository)
  const old = await claim(repository), start = await repository.startDispatch(old)
  assert.equal(start.status, 'ready'); assert.equal(start.claim.action.dispatchStarted, true)
  assert.equal((await repository.startDispatch(old)).status, 'stale')
  await expire(a.id)
  assert.equal(await repository.settle(start.claim, { state:'needs_review',code:'old_worker' }), false)
  const recovered = await claim(repository)
  assert.notEqual(recovered.token, old.token); assert.equal(recovered.action.phase, 'verify')
  assert.equal((await repository.startDispatch(recovered)).status, 'stale')
  const verification = await repository.startVerification(recovered)
  assert.equal(verification.status, 'ready')
  assert.equal(await repository.settle(old, {state:'needs_review',code:'late_worker'}), false)
  assert.equal(await repository.settle(verification.claim, {state:'succeeded',providerReference:'synthetic-remote-object',evidence:{matched:true}}), true)
  assert.equal((await repository.get(a.id)).state, 'succeeded')
  assert.ok((await events(a.id)).some(e => e.event_kind === 'lease_recovered'))
})

test('a worker clock cannot extend a database lease or authorize forged cross-property claims', async () => {
  const repository = repo(await scope()), a = await accepted(repository), value = await claim(repository)
  await expire(a.id)
  const forgedTime = {...value,expiresAt:'9999-01-01T00:00:00.000Z'}
  assert.equal((await repository.startDispatch(forgedTime)).status, 'stale')
  const other = repo(await scope('owner-b','property-b1'))
  assert.equal((await other.startDispatch(value)).status, 'stale')
  assert.equal(await other.settle(value,{state:'needs_review',code:'forged'}), false)
})

test('original user revocation and credential rotation hold jobs even when a different authorized worker claims them', async () => {
  for (const mutation of ["UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-staff-a'",
    "UPDATE atrium.users SET credential_version=2 WHERE id='staff-a'"]) {
    await db.admin.query("UPDATE atrium.property_grants SET status='active' WHERE membership_id='member-staff-a'")
    await db.admin.query("UPDATE atrium.users SET credential_version=1 WHERE id='staff-a'")
    const producer = repo(await scope('staff-a')), worker = repo(await scope())
    const a = await accepted(producer,receipt({eventId:mutation,actions:[{...receipt().actions[0],operationKey:mutation}]}))
    await db.admin.query(mutation)
    const decision = await worker.startDispatch(await claim(worker))
    assert.deepEqual(decision,{status:'held',code:'original_authorization_changed'})
    assert.equal((await worker.get(a.id)).state,'needs_review')
    assert.equal((await worker.get(a.id)).dispatchAttempts,0)
    // The ordinary worker context was restored before writes and its exit recheck.
    assert.ok((await events(a.id)).some(e=>e.event_kind==='held'))
  }
})

test('original channel deactivation and property publication changes require review before IO', async () => {
  const channel = repo(await authorization.authorizeChannel('vapi','synthetic-assistant-a','operate')), worker = repo(await scope())
  const a = await accepted(channel)
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='channel-a'")
  assert.deepEqual(await worker.startDispatch(await claim(worker)),{status:'held',code:'original_authorization_changed'})
  assert.equal((await worker.get(a.id)).state,'needs_review')
  const b = await accepted(worker,receipt({eventId:'config-event',actions:[{...receipt().actions[0],operationKey:'config-operation'}]}))
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    SELECT organization_id,property_id,2,status,configuration,inventory_read_at,inventory_source,published_at FROM atrium.property_configurations
    WHERE property_id='property-a1' AND version=1 ON CONFLICT DO NOTHING`)
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
  assert.deepEqual(await worker.startDispatch(await claim(worker)),{status:'held',code:'original_configuration_changed'})
  assert.equal((await worker.get(b.id)).state,'needs_review')
})

test('revocation after read-back refuses succeeded settlement and persists review under the worker identity', async () => {
  const producer = repo(await scope('staff-a')), worker = repo(await scope()), a = await accepted(producer)
  const value = await started(worker)
  await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-staff-a'")
  assert.equal(await worker.settle(value,{state:'succeeded',providerReference:'synthetic-confirmed-object',evidence:{matched:true}}),false)
  const held = await worker.get(a.id)
  assert.equal(held.state,'needs_review'); assert.equal(held.lastErrorCode,'original_authorization_changed')
  assert.equal(held.evidence,null)
  assert.equal((await db.admin.query("SELECT actor_user_id FROM atrium.workflow_events WHERE action_id=$1 AND event_kind='held'",[a.id])).rows[0].actor_user_id,'owner-a')
})

test('bounded safe retries retain provider key and audit evidence; ambiguous replay always verifies', async () => {
  const repository=repo(await scope()),a=await accepted(repository)
  let value=await started(repository)
  await assert.rejects(repository.settle(value,{state:'retry_wait',code:'retry',delayMs:0}),{code:'workflow_invalid_input'})
  assert.equal(await repository.settle(value,{state:'retry_wait',code:'verified_absent',delayMs:0,retryEvidence:'authoritative_absence_idempotent'}),true)
  value=await claim(repository)
  assert.equal(value.action.phase,'dispatch'); assert.equal(value.action.operationKey,a.operationKey)
  const dispatch=await repository.startDispatch(value);assert.equal(dispatch.status,'ready')
  const verified=await repository.startVerification(dispatch.claim);assert.equal(verified.status,'ready')
  await repository.settle(verified.claim,{state:'needs_review',code:'verification_unknown'})
  const replayed=await repository.replay(a.id,'operator_checked_provider')
  assert.equal(replayed.phase,'verify');assert.equal(replayed.operationKey,a.operationKey)
  assert.equal(replayed.dispatchAttempts,2)
  assert.ok((await events(a.id)).some(e=>e.details.retryEvidence==='authoritative_absence_idempotent'))
})

test('operator replay grants only a new bounded verification generation, preserving lifetime counters and operation identity', async () => {
  const repository=repo(await scope()),a=await accepted(repository,receipt({actions:[{...receipt().actions[0],maxAttempts:1}]}))
  const first=await started(repository)
  assert.equal(await repository.settle(first,{state:'verifying',code:'verification_unknown',delayMs:0}),true)
  const exhausted=await repository.startVerification(await claim(repository))
  assert.deepEqual(exhausted,{status:'held',code:'verification_attempts_exhausted'})
  const staff=repo(await scope('staff-a'))
  await assert.rejects(staff.replay(a.id,'operator_review'),{code:'forbidden'})
  const replayed=await repository.replay(a.id,'operator_review')
  assert.equal(replayed.operationKey,a.operationKey);assert.equal(replayed.verificationAttempts,1)
  assert.equal(replayed.verificationAttemptsAtReplay,1);assert.equal(replayed.dispatchAttempts,1)
  assert.equal(replayed.phase,'verify')
  const next=await claim(repository), verified=await repository.startVerification(next)
  assert.equal(verified.status,'ready');assert.equal(verified.claim.action.verificationAttempts,2)
  assert.equal(verified.claim.action.dispatchAttempts,1)
  await repository.settle(verified.claim,{state:'succeeded',providerReference:'recovered-same-object',evidence:{matched:true}})
  assert.equal((await repository.get(a.id)).state,'succeeded')
  await assert.rejects(repository.replay(a.id,'again'),{code:'workflow_replay_refused'})
  assert.ok((await events(a.id)).some(e=>e.event_kind==='replayed' && e.details.verificationAttemptsAtReplay===1))
})

test('cancel fences a claimed but undispatched job; possibly dispatched actions cannot be cancelled', async () => {
  const repository=repo(await scope()),a=await accepted(repository),value=await claim(repository)
  assert.equal((await repository.cancel(a.id,'operator_cancelled')).state,'cancelled')
  assert.equal((await repository.startDispatch(value)).status,'stale')
  const b=await accepted(repository,receipt({eventId:'second',actions:[{...receipt().actions[0],operationKey:'second'}]}))
  assert.equal((await repository.startDispatch(await claim(repository))).status,'ready')
  await assert.rejects(repository.cancel(b.id,'operator_cancelled'),{code:'workflow_cancel_refused'})
  await assert.rejects(db.admin.query('UPDATE atrium.outbox_messages SET dispatch_started=false WHERE action_id=$1',[b.id]),{code:'23514'})
})

test('real PostgreSQL worker roundtrip requires read-back and recovers after a crash before provider IO', async () => {
  const repository=repo(await scope()),a=await accepted(repository)
  let writes=0,reads=0
  const connector={id:'synthetic',idempotentWrites:true,
    async dispatch(){writes++;return {status:'accepted',providerReference:'synthetic-provider-object'}},
    async verify(action){reads++;return {status:'matched',providerReference:'synthetic-provider-object',operationKey:action.operationKey,inputSha256:action.inputSha256,evidence:{matched:true}}}}
  const result=await runWorkflowOnce({repository,connectors:new Map([['synthetic',connector]]),workerId:'real-pg-worker'})
  assert.equal(result.state,'succeeded');assert.equal(writes,1);assert.equal(reads,1)
  assert.equal((await repository.get(a.id)).state,'succeeded')
  const b=await accepted(repository,receipt({eventId:'recover',actions:[{...receipt().actions[0],operationKey:'recover'}]}))
  await repository.startDispatch(await claim(repository));await expire(b.id)
  const recovered=await runWorkflowOnce({repository,connectors:new Map([['synthetic',connector]]),workerId:'recovery-worker'})
  assert.equal(recovered.state,'succeeded');assert.equal(writes,1,'recovery performs no second write')
  assert.equal(reads,2)
})

test('pagination and state filters remain property scoped with equal timestamp records', async () => {
  const repository=repo(await scope())
  await repository.accept(receipt({actions:Array.from({length:5},(_,i)=>({...receipt().actions[0],operationKey:`page-${i}`}))}))
  const first=await repository.list({limit:2}),second=await repository.list({limit:2,before:{createdAt:first[1].createdAt,id:first[1].id}})
  const third=await repository.list({limit:2,before:{createdAt:second[1].createdAt,id:second[1].id}})
  assert.equal(new Set([...first,...second,...third].map(a=>a.id)).size,5)
  await repository.cancel(first[0].id,'pagination_test')
  assert.equal((await repository.list({states:['cancelled']})).length,1)
  assert.equal((await repository.list({states:['queued']})).length,4)
})

import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'

let db, staffScope, workerScope
before(async () => {
  db = await createFoundationTestDatabase()
  const { password } = await seedFoundationTestDatabase(db.admin)
  const authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  const scope = async (username, permission) => authorization.authorizeProperty(
    await authorization.authenticatePassword(username, password), 'property-a1', permission)
  staffScope = await scope('staff-a', 'operate')
  workerScope = await scope('owner-a', 'configure')
  const bundle = { property: { id: 'property-a1' }, inventory: [], floorplans: [], knowledge: [] }
  for (const version of [1, 2]) {
    await db.admin.query(`INSERT INTO atrium.property_configurations
      (organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES('organization-a','property-a1',$1,'published',$2::jsonb,now(),'synthetic authority race fixture',now())`,
    [version, JSON.stringify(bundle)])
  }
})
beforeEach(async () => {
  // Disposable loopback database only; no persistent demonstration or provider.
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events')
  await db.admin.query("UPDATE atrium.property_grants SET status='active' WHERE membership_id='member-staff-a'")
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
})
after(async () => { await db?.close() })

const repository = (scope = workerScope, connection = db.app) => new PostgresWorkflowRepository(connection, scope,
  { requestId: 'workflow-authority-race', configurationVersion: 1 })
const receipt = () => ({ source: 'synthetic', eventId: 'race-event', payload: { synthetic: true }, actions: [{
  kind: 'test.create', connector: 'synthetic', operationKey: 'race-operation', input: { target: 'synthetic-object' }, maxAttempts: 1,
}] })
const eventKinds = async id => (await db.admin.query(
  'SELECT event_kind FROM atrium.workflow_events WHERE action_id=$1', [id])).rows.map(row => row.event_kind).sort()

/** Pause after a real state transition's audit INSERT, then commit the original
 * actor revocation/config change through a separate admin connection. The worker
 * remains authorized. The test covers a between-statement race, not revocation
 * occurring after the transaction's final authorization gate. */
function changeAfterAudit(eventKind, change) {
  let changed = false
  return {
    get changed() { return changed },
    transaction(context, work) {
      return db.app.transaction(context, client => work(new Proxy(client, {
        get(target, key) {
          if (key !== 'query') return Reflect.get(target, key)
          return async (...args) => {
            const result = await client.query(...args)
            if (!changed && String(args[0]).includes('INSERT INTO atrium.workflow_events') && args[1]?.[4] === eventKind) {
              changed = true
              await db.admin.query(change === 'grant'
                ? "UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-staff-a'"
                : "UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
            }
            return result
          }
        },
      })))
    },
  }
}

for (const change of ['grant', 'configuration']) {
  const code = change === 'grant' ? 'original_authorization_changed' : 'original_configuration_changed'
  for (const transition of ['dispatch', 'verification', 'settlement', 'replay']) {
    test(`${transition} rolls back its state and audit when original ${change} changes after its write`, async () => {
      const accepted = (await repository(staffScope).accept(receipt())).actions[0]
      const normal = repository()
      let claim = await normal.claim({ workerId: 'race-worker', leaseMs: 30_000 })
      assert.ok(claim)
      if (transition !== 'dispatch') {
        const started = await normal.startDispatch(claim)
        assert.equal(started.status, 'ready')
        claim = started.claim
      }
      if (transition === 'settlement' || transition === 'replay') {
        const verifying = await normal.startVerification(claim)
        assert.equal(verifying.status, 'ready')
        claim = verifying.claim
      }
      if (transition === 'replay') {
        assert.equal(await normal.settle(claim, { state: 'needs_review', code: 'verification_attempts_exhausted' }), true)
      }
      const before = await normal.get(accepted.id)
      const beforeEvents = await eventKinds(accepted.id)
      const auditKind = { dispatch: 'dispatch_started', verification: 'verification_started', settlement: 'settled', replay: 'replayed' }[transition]
      const connection = changeAfterAudit(auditKind, change)
      const racing = repository(workerScope, connection)
      let result
      if (transition === 'dispatch') result = await racing.startDispatch(claim)
      if (transition === 'verification') result = await racing.startVerification(claim)
      if (transition === 'settlement') result = await racing.settle(claim, {
        state: 'succeeded', providerReference: 'synthetic-external-reference', evidence: { matched: true },
      })
      if (transition === 'replay') result = await racing.replay(accepted.id, 'operator_verified_recovery')

      assert.equal(connection.changed, true, 'the external transaction must commit after the requested write and audit')
      if (transition === 'dispatch' || transition === 'verification') assert.deepEqual(result, { status: 'held', code })
      if (transition === 'settlement') assert.equal(result, false, 'a persisted hold must never report success')
      if (transition === 'replay') assert.equal(result.state, 'needs_review')
      const held = await normal.get(accepted.id)
      assert.equal(held.state, 'needs_review')
      assert.equal(held.lastErrorCode, code)
      assert.equal(held.dispatchStarted, before.dispatchStarted)
      assert.equal(held.dispatchAttempts, before.dispatchAttempts)
      assert.equal(held.verificationAttempts, before.verificationAttempts)
      assert.equal(held.verificationAttemptsAtReplay, before.verificationAttemptsAtReplay,
        'an unauthorized replay must not renew its verification budget')
      assert.equal(held.operationKey, before.operationKey)
      assert.equal(held.inputSha256, before.inputSha256)
      assert.equal(held.providerReference, before.providerReference)
      assert.deepEqual(held.evidence, before.evidence)
      assert.deepEqual(await eventKinds(accepted.id), [...beforeEvents, transition === 'replay' ? 'replay_held' : 'held'].sort(),
        'the rejected transition audit must roll back with its state; only the hold is appended')
      const stored = (await db.admin.query('SELECT lease_token,worker_id,lease_acquired_at,lease_expires_at FROM atrium.outbox_messages WHERE action_id=$1', [accepted.id])).rows[0]
      assert.ok(Object.values(stored).every(value => value === null), 'the persisted hold releases the lease')
    })
  }
}

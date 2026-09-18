import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createAuthorizationService } from '../../src/auth/index.ts'
import { PgAuthorizationRepository } from '../../src/database/authorization.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { mockPropertyConnector, MOCK_CONNECTOR_ID } from '../../src/demo/pms/connector.ts'
import { memoryMockStore } from '../../src/demo/pms/memory-store.ts'
import { runQueue } from '../../src/demo/runner.ts'

/**
 * The demo connector against the durable workflow engine and the PostgreSQL repository, as
 * they actually are. The engine's own behaviour is covered by its unit tests; what is new
 * here is that a connector exists at all and that the queue moves when something turns it.
 *
 * Synthetic fixture data only. The stand-in property system is explicitly a fixture.
 */

let db, authorization, password
const ORGANIZATION = 'organization-a'
const PROPERTY = 'property-a1'
const scopeRef = { organizationId: ORGANIZATION, propertyId: PROPERTY }

before(async () => {
  db = await createFoundationTestDatabase()
  ;({ password } = await seedFoundationTestDatabase(db.admin))
  authorization = createAuthorizationService(new PgAuthorizationRepository(db.auth))
  const bundle = { property: { id: PROPERTY }, inventory: [], floorplans: [], knowledge: [] }
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES($1,$2,1,'published',$3::jsonb,now(),'synthetic demo connector fixture',now())`, [ORGANIZATION, PROPERTY, JSON.stringify(bundle)])
  await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1', [PROPERTY])
})
beforeEach(async () => {
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events')
  await db.admin.query("UPDATE atrium.users SET status='active',credential_version=1")
  await db.admin.query("UPDATE atrium.memberships SET status='active'")
  await db.admin.query("UPDATE atrium.property_grants SET status='active'")
  await db.admin.query("UPDATE atrium.properties SET status='active'")
  // Only this property has a published configuration; the others would break the foreign key.
  await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1', [PROPERTY])
})
after(async () => { await db?.close() })

async function scope() {
  const principal = await authorization.authenticatePassword('owner-a', password)
  assert.ok(principal)
  return authorization.authorizeProperty(principal, PROPERTY, 'operate')
}

const repository = async () => new PostgresWorkflowRepository(db.app, await scope(),
  { requestId: 'demo-connector-request', configurationVersion: 1 })

async function enqueue(repo, operationKey = 'prop-a1:book_tour:lead-7') {
  const result = await repo.accept({
    source: 'demo', eventId: `event-${operationKey}`, payload: { demo: true },
    actions: [{
      kind: 'demo.book_tour', connector: MOCK_CONNECTOR_ID, operationKey,
      input: { unit: '4B', scheduled_for: '2026-09-18T15:00:00Z' }, maxAttempts: 3,
    }],
  })
  return result.actions[0]
}

/** Arms the stand-in target, enqueues one action, and turns the crank. */
async function run(behavior, { steps = 4 } = {}) {
  const store = memoryMockStore()
  if (behavior !== 'accept') await store.armBehavior(scopeRef, behavior)
  const repo = await repository()
  const action = await enqueue(repo)
  const connectors = new Map([[MOCK_CONNECTOR_ID, mockPropertyConnector(store)]])
  const summary = await runQueue({ repository: repo, connectors, workerId: 'demo-test-worker', maxSteps: steps })
  return { store, repo, action, connectors, summary, final: await repo.get(action.id) }
}

/** Clears a backoff wait so a test does not sit through it. */
async function makeDue(actionId) {
  await db.admin.query('UPDATE atrium.outbox_messages SET available_at=clock_timestamp() WHERE action_id=$1', [actionId])
}

test('a queued action reaches succeeded, which nothing in this repository could do before', async () => {
  const { final, store, summary } = await run('accept')
  assert.equal(final.state, 'succeeded')
  assert.ok(final.providerReference)
  assert.deepEqual(final.evidence, { unit: '4B', scheduled_for: '2026-09-18T15:00:00Z' })
  assert.equal(store.size, 1)
  assert.ok(summary.settled >= 1)
})

test('a lost response after the write landed recovers to succeeded without a second booking', async () => {
  const { final, store } = await run('timeout_after_write')
  assert.equal(final.state, 'succeeded')
  // The whole reason the read-back exists: one record at the target, not two.
  assert.equal(store.size, 1)
})

test('a target that filed something else stops for a person instead of reporting success', async () => {
  const { final } = await run('drift')
  assert.equal(final.state, 'needs_review')
  assert.equal(final.lastErrorCode, 'mock_record_differs_from_request')
})

test('a refused write stops for a person and writes nothing', async () => {
  const { final, store } = await run('reject')
  assert.equal(final.state, 'needs_review')
  assert.equal(store.size, 0)
})

test('silence with nothing written waits, then retries once and succeeds', async () => {
  const { final, store, action, repo, connectors } = await run('timeout', { steps: 1 })
  assert.equal(final.state, 'retry_wait')
  assert.equal(store.size, 0)
  assert.equal(final.dispatchAttempts, 1)

  // The armed fault applied once, so the retry meets a target that now behaves. Clearing
  // the backoff only skips the wait; the engine still decides whether a retry is permitted,
  // and it is here only because this connector enforces the key itself.
  await makeDue(action.id)
  await runQueue({ repository: repo, connectors, workerId: 'demo-test-worker', maxSteps: 3 })
  const settled = await repo.get(action.id)
  assert.equal(settled.state, 'succeeded')
  assert.equal(settled.dispatchAttempts, 2)
  assert.equal(store.size, 1)
})

test('a record the target has not yet made readable is waited on, not declared missing', async () => {
  const { final } = await run('invisible_once', { steps: 1 })
  assert.equal(final.state, 'verifying')
})

test('an unknown connector stops for a person rather than silently doing nothing', async () => {
  const repo = await repository()
  const action = await enqueue(repo, 'prop-a1:book_tour:lead-9')
  const summary = await runQueue({ repository: repo, connectors: new Map(), workerId: 'demo-test-worker', maxSteps: 2 })
  const final = await repo.get(action.id)
  assert.equal(final.state, 'needs_review')
  assert.equal(final.lastErrorCode, 'connector_unavailable')
  assert.ok(summary.steps.length >= 1)
})

test('an empty queue drains instead of spinning', async () => {
  const repo = await repository()
  const connectors = new Map([[MOCK_CONNECTOR_ID, mockPropertyConnector(memoryMockStore())]])
  const summary = await runQueue({ repository: repo, connectors, workerId: 'demo-test-worker', maxSteps: 5 })
  assert.equal(summary.drained, true)
  assert.equal(summary.steps.length, 0)
})

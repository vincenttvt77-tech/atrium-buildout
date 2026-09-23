import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { scopeContext } from '../../src/database/scope.ts'
import { TEST_AUTH_ORIGIN, verifyMfaSession } from '../helpers/mfa-session.mjs'
import { seedWorkflowHistory } from '../helpers/workflow-history.mjs'

let db, runtime, selected, principal, repository, captured
const properties = [['organization-a', 'property-a1', 'owner-a'],
  ['organization-a', 'property-a2', 'owner-a'], ['organization-b', 'property-b1', 'owner-b']]
const expected = {}

before(async () => {
  db = await createFoundationTestDatabase()
  const { password } = await seedFoundationTestDatabase(db.admin)
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth,
    sessionSecret: 'synthetic-queue-performance-session-secret', authOrigin: TEST_AUTH_ORIGIN })
  for (const [organizationId, propertyId, userId] of properties) {
    const configuration = { property: { id: propertyId }, inventory: [], floorplans: [], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,
      configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,clock_timestamp(),'synthetic-history',clock_timestamp())`,
    [organizationId, propertyId, JSON.stringify(configuration)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1', [propertyId])
    expected[propertyId] = (await seedWorkflowHistory(db.admin, { organizationId, propertyId, userId,
      count: propertyId === 'property-a1' ? 3000 : 300 })).reverse()
  }
  principal = await runtime.sessions.start(await runtime.authorization.authenticatePassword('owner-a', password),
    { label: 'Synthetic history reader' })
  await verifyMfaSession(runtime, principal, password)
  selected = await runtime.authorization.authorizeProperty(principal, 'property-a1', 'configure')
  // Record only this synthetic fixture's actual page query; use its real role,
  // current session/MFA, transaction settings and RLS for EXPLAIN, too.
  const measured = { transaction: (context, work) => db.app.transaction(context, client => work(new Proxy(client, {
    get(target, key) {
      if (key === 'query') return (text, parameters) => {
        if (typeof text === 'string' && text.includes('FROM atrium.action_intents a')
          && text.includes('ORDER BY a.created_at DESC')) captured = { text, parameters }
        return target.query(text, parameters)
      }
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))) }
  repository = new PostgresWorkflowRepository(measured, selected, { requestId: 'history-page', configurationVersion: 1 })
})
after(async () => { await db?.close() })

test('a fresh 3600-action database returns the first scoped page under real runtime limits with identical exact-read revisions', async t => {
  const started = performance.now()
  const page = await repository.list({ limit: 26 })
  t.diagnostic(`Synthetic first page: ${Math.round(performance.now() - started)} ms; not a hosted latency measurement.`)
  assert.deepEqual(page.map(row => row.id), expected['property-a1'].slice(0, 26))
  for (const index of [0, 12, 25]) assert.deepEqual(page[index], await repository.get(page[index].id))
  assert.equal(await repository.get(expected['property-a2'][0]), null)
  assert.equal(await repository.get(expected['property-b1'][0]), null)
  const plan = (await db.app.transaction(scopeContext(selected), client => client.query(
    'EXPLAIN (ANALYZE, BUFFERS, TIMING FALSE, FORMAT JSON) ' + captured.text, captured.parameters))).rows[0]['QUERY PLAN'][0]
  const nodes = []
  function walk(node) { nodes.push(node); for (const child of node.Plans ?? []) walk(child) }
  walk(plan.Plan)
  assert.equal(plan.Plan['Actual Rows'], 26)
  // The old plan discarded property-wide receipt/outbox joins repeatedly before
  // producing a page. Check measured work, not an index name or exact plan shape.
  assert.equal(nodes.reduce((sum, node) => sum + (node['Rows Removed by Join Filter'] ?? 0) * node['Actual Loops'], 0), 0)
  for (const table of ['action_intents', 'inbox_events', 'outbox_messages']) {
    const returned = nodes.filter(node => node['Relation Name'] === table)
      .reduce((sum, node) => sum + node['Actual Rows'] * node['Actual Loops'], 0)
    assert.ok(returned <= 26, `${table} must not feed an entire property history into the page joins: ${returned}`)
  }
})

test('keyset pages retain exact timestamp ties and cover all 3000 scoped actions once', async () => {
  const ids = []
  let before
  for (let number = 0; number < 40; number++) {
    const page = await repository.list({ limit: 97, ...(before ? { before } : {}) })
    ids.push(...page.map(row => row.id))
    if (page.length < 97) break
    const last = page.at(-1); before = { createdAt: last.createdAt, id: last.id }
  }
  assert.equal(new Set(ids).size, 3000)
  assert.deepEqual(ids, expected['property-a1'])
})

test('sparse state filters apply before page limits and retain cancelled history and revisions', async t => {
  const retained = [expected['property-a1'][40], expected['property-a1'][130], expected['property-a1'][2999]]
  await db.admin.query(`UPDATE atrium.outbox_messages SET state='cancelled',completed_at=clock_timestamp()
    WHERE organization_id='organization-a' AND property_id='property-a1' AND NOT(action_id=ANY($1::text[]))`, [retained])
  const first = await repository.list({ states: ['queued'], limit: 2 })
  assert.deepEqual(first.map(row => row.id), retained.slice(0, 2))
  const last = first.at(-1)
  const second = await repository.list({ states: ['queued'], limit: 2, before: { createdAt: last.createdAt, id: last.id } })
  assert.deepEqual(second.map(row => row.id), retained.slice(2))
  const cancelled = await repository.list({ states: ['cancelled'], limit: 10 })
  assert.equal(cancelled.length, 10)
  assert.deepEqual(cancelled[0], await repository.get(cancelled[0].id))
  const started = performance.now()
  assert.equal((await repository.list({ states: ['succeeded'], limit: 2 })).length, 0)
  t.diagnostic(`Synthetic empty history filter: ${Math.round(performance.now() - started)} ms.`)
})

test('a page revision authorizes exactly that unchanged action and refuses the stale page after cancellation', async () => {
  const row = (await repository.list({ states: ['queued'], limit: 1 }))[0]
  const cancelled = await repository.cancel(row.id, 'no_longer_needed', row.revision)
  assert.equal(cancelled.state, 'cancelled')
  assert.deepEqual(cancelled, await repository.get(row.id))
  const page = await repository.list({ states: ['cancelled'], limit: 100 })
  assert.deepEqual(page.find(item => item.id === row.id), cancelled)
  await assert.rejects(repository.replay(row.id, 'reviewed_request', row.revision), { code: 'workflow_revision_conflict' })
})

const tables = ['inbox_events', 'action_intents', 'outbox_messages', 'workflow_events']
async function countRows(client, table) {
  return Number((await client.query(`SELECT count(*) FROM atrium.${table}`)).rows[0].count)
}

test('raw RLS reads require the exact property and current identity even without repository predicates', async () => {
  const context = scopeContext(selected)
  for (const table of tables) {
    const expectedCount = table === 'workflow_events' ? 1 : 3000
    assert.equal(await db.app.transaction(context, client => countRows(client, table)), expectedCount)
    for (const denied of [{}, { ...context, organizationId: 'organization-b' },
      { ...context, propertyId: 'property-b1' }, { ...context, credentialVersion: 999 },
      { ...context, sessionAudience: 'resident' }, { ...context, actorUserId: undefined }]) {
      assert.equal(await db.app.transaction(denied, client => countRows(client, table)), 0)
    }
    const other = { ...context, propertyId: 'property-a2' }
    assert.equal(await db.app.transaction(other, client => countRows(client, table)), table === 'workflow_events' ? 0 : 300)
    await assert.rejects(db.auth.transaction(context, client => countRows(client, table)), { code: '42501' })
  }
})

test('prepared and pooled reads reevaluate context each execution rather than retaining an earlier property grant', async () => {
  const query = { name: 'synthetic-prepared-history', text: 'SELECT id FROM atrium.action_intents ORDER BY id LIMIT 1' }
  for (let round = 0; round < 6; round++) {
    for (const propertyId of ['property-a1', 'property-a2', 'property-b1']) {
      const rows = await db.app.transaction({ ...scopeContext(selected), propertyId }, async client => {
        const value = (await client.query(query)).rows
        await client.query("SELECT set_config('atrium.property_id','property-b1',true)")
        assert.equal((await client.query(query)).rowCount, 0)
        return value
      })
      assert.deepEqual(rows.map(row => row.id), propertyId === 'property-b1' ? [] : [expected[propertyId].at(-1)])
    }
  }
})

test('permission revocation and channel binding changes affect the next statement in the same transaction', async () => {
  await db.app.transaction(scopeContext(selected), async client => {
    assert.equal(await countRows(client, 'action_intents'), 3000)
    await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'")
    try { assert.equal(await countRows(client, 'action_intents'), 0) }
    finally { await db.admin.query("UPDATE atrium.memberships SET status='active' WHERE id='member-owner-a'") }
    assert.equal(await countRows(client, 'action_intents'), 3000)
  })
  const channel = await runtime.authorization.authorizeChannel('vapi', 'synthetic-assistant-a', 'read')
  await db.app.transaction(scopeContext(channel), async client => {
    assert.equal(await countRows(client, 'action_intents'), 3000)
    await db.admin.query("UPDATE atrium.channel_bindings SET permission_version=2 WHERE id='channel-a'")
    try { assert.equal(await countRows(client, 'action_intents'), 0) }
    finally { await db.admin.query("UPDATE atrium.channel_bindings SET permission_version=1 WHERE id='channel-a'") }
    assert.equal(await countRows(client, 'action_intents'), 3000)
    await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='channel-a'")
    try { assert.equal(await countRows(client, 'action_intents'), 0) }
    finally { await db.admin.query("UPDATE atrium.channel_bindings SET status='active' WHERE id='channel-a'") }
  })
})

test('the additive read-policy migration preserves existing rows, forced RLS, roles and all write policies', async () => {
  const sql = await readFile(new URL('../../db/workflow-read-policies.sql', import.meta.url), 'utf8')
  assert.equal(sql, await readFile(new URL('../../supabase/migrations/20260923200722_workflow_read_policies.sql', import.meta.url), 'utf8'))
  async function snapshot() {
    const rows = {}
    for (const table of tables) rows[table] = (await db.admin.query(`SELECT count(*),
      md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS digest FROM atrium.${table} t`)).rows
    const policies = (await db.admin.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
      FROM pg_policies WHERE schemaname='atrium' AND tablename=ANY($1) AND policyname<>'scoped_read'
      ORDER BY tablename,policyname`, [tables])).rows
    const flags = (await db.admin.query(`SELECT relname,relrowsecurity,relforcerowsecurity,relacl
      FROM pg_class WHERE relnamespace='atrium'::regnamespace AND relname=ANY($1) ORDER BY relname`, [tables])).rows
    return { rows, policies, flags }
  }
  const before = await snapshot()
  assert.ok(before.flags.every(row => row.relrowsecurity && row.relforcerowsecurity))
  // Reconstruct only the previous read policies in this disposable fixture, then
  // apply the exact migration SQL over populated tables without touching records.
  await db.admin.query('BEGIN')
  try {
    for (const table of tables) await db.admin.query(`ALTER POLICY scoped_read ON atrium.${table}
      USING (atrium.can_access_property(organization_id,property_id,'read'))`)
    await db.admin.query(sql)
    await db.admin.query('COMMIT')
  } catch (error) { await db.admin.query('ROLLBACK'); throw error }
  assert.deepEqual(await snapshot(), before)
  assert.equal((await repository.list({ states: ['succeeded'], limit: 26 })).length, 0)
})

test('revoked authority remains refused with a captured scope and substantial history', async () => {
  await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'")
  try { await assert.rejects(repository.list({ limit: 26 }), { code: 'forbidden' }) }
  finally { await db.admin.query("UPDATE atrium.memberships SET status='active' WHERE id='member-owner-a'") }
  await runtime.sessions.revoke(principal, principal.sessionId)
  await assert.rejects(repository.list({ limit: 26 }), { code: 'forbidden' })
})

import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import dashboard from '../../api/dashboard.ts'
import { createTourConfirmationsHandler } from '../../api/tour-confirmations.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { ResendTransport } from '../../src/email/render.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'

const oldMode = process.env.ATRIUM_RUNTIME_MODE
let db, runtime, server, origin, password, providerServer, providerOrigin, handler
const cookies = {}, effects = new Map(), requests = [], failures = []
let configured = true, dropAcknowledgement = false
const buildings = [['organization-a','property-a1'], ['organization-b','property-b1']]
const startsAt = new Date(Math.ceil((Date.now() + 2 * 86400000) / 60000) * 60000).toISOString()
const endsAt = new Date(Date.parse(startsAt) + 1800000).toISOString()
const booking = { externalId: 'confirmed-fixture-1', slotId: 'slot-' + startsAt.slice(0,16), startsAt, endsAt,
  prospectName: 'Test Visitor', prospectEmail: 'visitor@example.test', prospectPhone: '+12025550101', unitId: null,
  bookedAt: new Date().toISOString(), revision: 0 }
const settings = { capacity: 3, slotMinutes: 30, startIntervalMinutes: 30, bufferMinutes: 0, minimumNoticeMinutes: 0,
  bookingWindowDays: null, sameUnitPolicy: 'exclusive', hours: { 1: { openHour: 9, closeHour: 17 } } }
const state = () => ({ bookings: [structuredClone(booking)], blocks: [] })
async function saveCalendar(value, property = 'property-a1', org = 'organization-a') {
  await db.admin.query('INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES($1,$2,$3::jsonb) ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state', [org, property, JSON.stringify(value)])
}
before(async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase(); password = (await seedFoundationTestDatabase(db.admin)).password
  runtime = createDatabaseRuntime({ app: db.app, auth: db.auth, sessionSecret: 'synthetic-confirmation-session-secret-long-enough', authOrigin: TEST_AUTH_ORIGIN })
  for (const [org, property] of buildings) {
    const bundle = { property: { id: property, organizationId: org, buildingName: 'Fixture Building', address: '1 Test Avenue',
      timeZone: property === 'property-b1' ? 'America/Los_Angeles' : 'America/New_York', jurisdiction: 'NY', tourSettings: settings,
      tourConfirmationEmail: { provider: 'resend', organizationId: org, propertyId: property, from: 'Fixture <leasing@example.test>',
        replyTo: 'leasing@example.test', reviewExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } }, inventory: [], floorplans: [], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,now(),'synthetic-confirmation',now())`, [org, property, JSON.stringify(bundle)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2', [org,property])
  }
  providerServer = createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/emails') {
        let body = ''; for await (const chunk of req) body += chunk
        const parsed = JSON.parse(body), key = req.headers['idempotency-key']
        requests.push({ method: 'POST', key })
        const id = randomUUID(); effects.set(id, parsed)
        if (dropAcknowledgement) { req.socket.destroy(); return }
        res.setHeader('content-type','application/json'); res.end(JSON.stringify({ id })); return
      }
      const id = req.url.split('/').at(-1), effect = effects.get(id)
      requests.push({ method: 'GET', id })
      if (!effect) { res.statusCode = 404; res.end('{}'); return }
      res.setHeader('content-type','application/json')
      res.end(JSON.stringify({ object: 'email', id, ...effect, cc: [], bcc: [], reply_to: effect.reply_to ?? [], last_event: 'delivered' }))
    } catch (error) { failures.push(error); res.statusCode = 500; res.end('{}') }
  })
  providerServer.listen(0,'127.0.0.1'); await once(providerServer,'listening')
  providerOrigin = `http://127.0.0.1:${providerServer.address().port}`
  handler = createTourConfirmationsHandler({ provider: { get configured() { return configured }, transport: () => new ResendTransport('synthetic-only-key', {
    fetch: async (url, options) => { const parsed = new URL(url); assert.equal(parsed.origin,'https://api.resend.com'); return fetch(providerOrigin + parsed.pathname, options) },
  }) } })
  server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = runtime
      let body = ''; for await (const chunk of req) body += chunk
      req.body = body
      const url = new URL(req.url,'http://localhost'); req.query = Object.fromEntries(url.searchParams)
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(value)); return res }
      await (url.pathname === '/api/dashboard' ? dashboard : handler)(req,res)
    } catch (error) { failures.push(error); res.statusCode = 500; res.end('{}') }
  })
  server.listen(0,'127.0.0.1'); await once(server,'listening'); origin = `http://127.0.0.1:${server.address().port}`
  for (const user of ['owner-a','owner-b','staff-a','viewer-a']) {
    const response = await fetch(origin + '/api/dashboard', { method:'POST', redirect:'manual', headers: { 'content-type':'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username:user,password }) })
    assert.equal(response.status,303); cookies[user] = response.headers.get('set-cookie').split(';')[0]
    await response.text(); await verifyMfaCookie(runtime,cookies[user],password)
  }
})
beforeEach(async () => {
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,atrium.operational_documents')
  await db.admin.query("UPDATE atrium.property_grants SET status='active' WHERE membership_id='member-staff-a'")
  for (const [org,prop] of buildings) await saveCalendar(state(),prop,org)
  configured = true; dropAcknowledgement = false; effects.clear(); requests.length = 0; failures.length = 0
})
after(async () => {
  for (const instance of [server,providerServer]) if (instance) { instance.close(); instance.closeAllConnections(); await once(instance,'close') }
  await db?.close(); if (oldMode === undefined) delete process.env.ATRIUM_RUNTIME_MODE; else process.env.ATRIUM_RUNTIME_MODE = oldMode
})
async function request({ body, user = 'owner-a', property = 'property-a1', org = 'organization-a', headers = {}, query } = {}) {
  const response = await fetch(origin + '/api/tour-confirmations' + (body === undefined ? query ?? '?externalId=' + booking.externalId : ''), {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookies[user] ?? '', 'x-atrium-organization-id':org,'x-atrium-property-id':property,'x-atrium-config-version':'1',
      ...(body === undefined ? {} : { origin,'content-type':'application/json' }), ...headers }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) })
  return { status:response.status, body:await response.json() }
}
const queue = draft => ({ action:'queue', externalId:booking.externalId, bookingSha256:draft.bookingSha256, permissionConfirmed:true })
const processEmail = id => request({ body:{ action:'process',confirmationId:id } })
async function admitted(user = 'owner-a') {
  const preview = await request({ user }); assert.equal(preview.status,200)
  const accepted = await request({ user, body:queue(preview.body.preview) }); assert.equal(accepted.status,200)
  return accepted.body.confirmation
}

test('staff preview, permission, actual HTTP submission and exact delivery form one usable flow', async () => {
  const preview = await request()
  assert.equal(preview.status,200); assert.equal(preview.body.preview.recipient,booking.prospectEmail)
  assert.equal(preview.body.ready,true); assert.equal(preview.body.confirmation,null); assert.equal(requests.length,0)
  const saved = await admitted()
  assert.equal(saved.state,'queued'); assert.equal(saved.delivery,'not_verified')
  const submitted = await processEmail(saved.id)
  assert.equal(submitted.body.confirmation.state,'verifying'); assert.equal(submitted.body.confirmation.delivery,'not_verified')
  await delay(1100)
  const delivered = await processEmail(saved.id)
  assert.equal(delivered.body.confirmation.state,'succeeded'); assert.equal(delivered.body.confirmation.delivery,'delivered')
  assert.equal((await request()).body.confirmation.id,saved.id)
  assert.equal(requests.filter(row => row.method === 'POST').length,1)
  assert.deepEqual(failures,[])
})

test('two operators and double clicks share one immutable confirmation and permission receipt', async () => {
  const draft = (await request()).body.preview
  const replies = await Promise.all(['owner-a','staff-a','owner-a'].map(user => request({ user,body:queue(draft) })))
  assert.ok(replies.every(r => r.status === 200)); assert.equal(new Set(replies.map(r => r.body.confirmation.id)).size,1)
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.action_intents')).rows[0].n,1)
  const records=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE key LIKE 'tour-confirmation:%'")).rows
  const indexes=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE key LIKE 'tour-confirmation-index:%'")).rows
  assert.equal(records.length,1);assert.equal(indexes.length,1)
  assert.equal(records[0].value.id,replies[0].body.confirmation.id)
  assert.equal(indexes[0].value.externalId,booking.externalId)
  assert.deepEqual(indexes[0].value.ids,[records[0].value.id])
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.inbox_events')).rows[0].n,1)
  assert.equal(requests.length,0)
})

test('missing permission, injected recipient/content and changed booking cannot enter the queue', async () => {
  const draft = (await request()).body.preview
  for (const patch of [{ permissionConfirmed:false },{ to:'other@example.test' },{ html:'injected' }]) {
    assert.equal((await request({ body:{ ...queue(draft),...patch } })).status,400)
  }
  const changed = state(); changed.bookings[0].revision = 1; await saveCalendar(changed)
  assert.equal((await request({ body:queue(draft) })).status,409)
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.action_intents')).rows[0].n,0)
})

test('known reschedule, cancellation or hold after permission prevents provider dispatch', async () => {
  for (const change of ['reschedule','cancel','block']) {
    const saved = await admitted()
    const changed = state()
    if (change === 'reschedule') changed.bookings[0].revision = 2
    else if (change === 'cancel') changed.bookings = []
    else changed.blocks = [{ target:booking.slotId, reason:'Fixture hold',blockedAt:new Date().toISOString() }]
    await saveCalendar(changed)
    const result = await processEmail(saved.id)
    assert.equal(result.body.confirmation.state,'needs_review'); assert.equal(requests.length,0)
    // Make the next saved reservation distinct; never reset an already admitted identity.
    booking.revision += 3; await saveCalendar(state())
  }
})

test('provider-unconfigured preview is honest and cannot enqueue or send', async () => {
  configured = false
  const preview = await request(); assert.equal(preview.status,200); assert.equal(preview.body.ready,false)
  assert.equal((await request({ body:queue(preview.body.preview) })).status,503)
  assert.equal(requests.length,0)
})

test('anonymous, viewer, cross-property and cross-site requests cannot operate confirmations', async () => {
  assert.equal((await request({ user:'anonymous' })).status,401)
  assert.equal((await request({ user:'viewer-a' })).status,403)
  assert.equal((await request({ property:'property-b1',org:'organization-b' })).status,403)
  const draft = (await request()).body.preview
  assert.equal((await request({ body:queue(draft),headers:{ origin:'https://unrelated.example.test' } })).status,403)
  const saved = await admitted()
  assert.equal((await request({ user:'owner-b',property:'property-b1',org:'organization-b',body:{ action:'process',confirmationId:saved.id } })).status,404)
  assert.equal(requests.length,0)
})

test('targeted email processing leaves unrelated queue work untouched', async () => {
  const principal = await runtime.authorization.authenticatePassword('owner-a',password)
  const scope = await runtime.authorization.authorizeProperty(principal,'property-a1','operate')
  const repository = new PostgresWorkflowRepository(db.app,scope,{ requestId:'unrelated-fixture',configurationVersion:1 })
  const unrelated = (await repository.accept({ source:'fixture',eventId:'event-1',payload:{},actions:[{kind:'other_work',connector:'unknown_connector',operationKey:'other',input:{}}] })).actions[0]
  const saved = await admitted(); await processEmail(saved.id)
  assert.equal((await repository.get(unrelated.id)).state,'queued')
  assert.equal(requests.filter(row => row.method === 'POST').length,1)
})

test('concurrent processing shares one lease and performs one provider submission', async () => {
  const saved = await admitted()
  const replies = await Promise.all([processEmail(saved.id), processEmail(saved.id), processEmail(saved.id)])
  assert.ok(replies.every(result => result.status === 200 && result.body.confirmation.delivery === 'not_verified'))
  assert.equal(requests.filter(row => row.method === 'POST').length,1)
  assert.equal((await request()).body.confirmation.state,'verifying')
})

test('a damaged permission record cannot silently attach to a different staff origin', async () => {
  const saved = await admitted()
  await db.admin.query(`UPDATE atrium.operational_documents SET value=jsonb_set(value,'{actorId}','"different-actor"')
    WHERE organization_id='organization-a' AND property_id='property-a1' AND key=$1`,['tour-confirmation:'+saved.id])
  assert.equal((await request()).status,409)
  assert.equal((await processEmail(saved.id)).status,409)
  assert.equal(requests.length,0)
})

test('revoked original permission blocks another operator from dispatching the email', async () => {
  const saved = await admitted('staff-a')
  await db.admin.query("UPDATE atrium.property_grants SET status='revoked',permission_version=permission_version+1 WHERE membership_id='member-staff-a' AND property_id='property-a1'")
  const result = await processEmail(saved.id)
  assert.equal(result.body.confirmation.state,'needs_review'); assert.equal(requests.length,0)
})

test('lost provider acknowledgement remains unverified and repeated processing never sends again', async () => {
  dropAcknowledgement = true
  const saved = await admitted()
  assert.equal((await processEmail(saved.id)).body.confirmation.delivery,'not_verified')
  await delay(1100)
  assert.equal((await processEmail(saved.id)).body.confirmation.delivery,'not_verified')
  assert.equal(requests.filter(row => row.method === 'POST').length,1)
})

test('failure saving permission rolls back the workflow receipt and outbox together', async () => {
  const draft = (await request()).body.preview
  await db.admin.query(`CREATE FUNCTION public.reject_fixture_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic document storage failure'; END $$;
    CREATE TRIGGER reject_fixture_confirmation BEFORE INSERT ON atrium.operational_documents
    FOR EACH ROW WHEN (NEW.key LIKE 'tour-confirmation:%') EXECUTE FUNCTION public.reject_fixture_confirmation()`)
  try {
    assert.equal((await request({ body:queue(draft) })).status,503)
    for (const table of ['action_intents','outbox_messages','inbox_events','operational_documents']) {
      assert.equal((await db.admin.query(`SELECT count(*)::int n FROM atrium.${table}`)).rows[0].n,0)
    }
  } finally { await db.admin.query('DROP TRIGGER reject_fixture_confirmation ON atrium.operational_documents; DROP FUNCTION public.reject_fixture_confirmation()') }
})

test('admission waits for the calendar mutation lock and rejects a concurrently changed tour', async () => {
  const draft = (await request()).body.preview, updated = state(); updated.bookings[0].revision++
  await db.admin.query('BEGIN')
  let pending
  try {
    await db.admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['organization-a','property-a1','calendar'])])
    await saveCalendar(updated)
    let finished = false
    pending = request({ body:queue(draft) }).then(result => { finished = true; return result })
    await delay(75); assert.equal(finished,false)
    await db.admin.query('COMMIT')
    assert.equal((await pending).status,409)
    assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.action_intents')).rows[0].n,0)
  } finally { await db.admin.query('ROLLBACK'); await pending }
})

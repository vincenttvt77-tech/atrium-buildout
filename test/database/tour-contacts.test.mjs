import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import dashboard from '../../api/dashboard.ts'
import handler from '../../api/tour-contacts.ts'
import { resolveOpsRuntime } from '../../src/application/runtime.ts'
import { hashJson } from '../../src/workflows/validation.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'

const oldMode = process.env.ATRIUM_RUNTIME_MODE
let db, runtime, server, origin, password
const cookies = {}, failures = []
let dropReply = false
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
  server = createServer(async (req, res) => {
    try {
      req.atriumRuntime = runtime
      let body = ''; for await (const chunk of req) body += chunk
      req.body = body
      const url = new URL(req.url,'http://localhost'); req.query = {}; for (const key of new Set(url.searchParams.keys())) { const values=url.searchParams.getAll(key); req.query[key]=values.length===1?values[0]:values }
      res.status = code => { res.statusCode = code; return res }
      res.send = value => { res.end(value); return res }
      res.json = value => { if (dropReply && req.method==='POST' && res.statusCode===200) { dropReply=false; req.socket.destroy(); return res } res.setHeader('content-type','application/json'); res.end(JSON.stringify(value)); return res }
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
  dropReply = false; failures.length = 0
})
after(async () => {
  for (const instance of [server]) if (instance) { instance.close(); instance.closeAllConnections(); await once(instance,'close') }
  await db?.close(); if (oldMode === undefined) delete process.env.ATRIUM_RUNTIME_MODE; else process.env.ATRIUM_RUNTIME_MODE = oldMode
})
async function request({ body, user = 'owner-a', property = 'property-a1', org = 'organization-a', headers = {}, query, method } = {}) {
  const response = await fetch(origin + '/api/tour-contacts' + (body === undefined ? query ?? '?externalId=' + booking.externalId : ''), {
    method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { cookie: cookies[user] ?? '', 'x-atrium-organization-id':org,'x-atrium-property-id':property,'x-atrium-config-version':'1',
      ...(body === undefined ? {} : { origin,'content-type':'application/json' }), ...headers }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) })
  return { status:response.status, body:await response.json() }
}
const command = (current, patch = {}) => ({ action:'save', externalId:booking.externalId, expectedSha256:current.expectedSha256,
  requestId:randomUUID(), name:'Corrected Visitor', email:'corrected@example.test', reason:'Prospect corrected contact details', ...patch })
const current = async () => { const r=await request();assert.equal(r.status,200,JSON.stringify(r.body));return r.body.current }
const calendar = async () => (await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state
const documents = async () => (await db.admin.query("SELECT key,value FROM atrium.operational_documents WHERE property_id='property-a1' ORDER BY key")).rows
const auditCount = async () => (await db.admin.query('SELECT count(*)::int n FROM atrium.audit_events')).rows[0].n

test('staff correction preserves reservation identity and schedule; history and receipts commit without messages', async () => {
  const before = state();Object.assign(before.bookings[0],{interactionId:'original-call',occupiedStartsAt:startsAt,occupiedEndsAt:endsAt,revision:8})
  await saveCalendar(before)
  await db.admin.query("INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-a1','call:original-call',$1),('organization-a','property-a1','lead:original',$1)",[JSON.stringify({name:'Old record',email:'old@example.test'})])
  const untouched = await documents(), view=await current(), cmd=command(view)
  const result=await request({user:'staff-a',body:cmd})
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.replayed,false)
  assert.equal(result.body.current.contactRevision,1);assert.equal(result.body.current.reviewedByStaff,true)
  assert.equal(result.body.change.actorId,'staff-a');assert.equal(result.body.current.history.length,1)
  assert.deepEqual(await calendar(),{...before,bookings:[{...before.bookings[0],prospectName:cmd.name,prospectEmail:cmd.email,contactRevision:1,contactReviewedByStaff:true}]})
  assert.deepEqual((await documents()).filter(r=>!r.key.startsWith('tour-contact-')),untouched)
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.action_intents')).rows[0].n,0)
  const foreign=(await request({user:'owner-b',org:'organization-b',property:'property-b1'})).body.current
  assert.equal(foreign.contactRevision,0);assert.equal(foreign.email,booking.prospectEmail)
})

test('simultaneous exact retries create one change; stale and reused commands cannot overwrite later edits', async () => {
  const cmd=command(await current()), replies=await Promise.all(Array.from({length:4},()=>request({body:cmd})))
  assert.ok(replies.every(r=>r.status===200));assert.equal(replies.filter(r=>!r.body.replayed).length,1)
  assert.equal((await current()).historyCount,1)
  const next=command(await current(),{name:'Latest Name',email:null});assert.equal((await request({body:next})).status,200)
  const replay=await request({body:cmd});assert.equal(replay.body.replayed,true);assert.equal(replay.body.change.revision,1)
  assert.equal(replay.body.current.contactRevision,2);assert.equal(replay.body.current.email,null)
  for(const altered of [{...cmd,email:'other@example.test'},{...cmd,requestId:randomUUID()}]) assert.equal((await request({body:altered})).status,409)
  assert.equal((await request({user:'staff-a',body:cmd})).status,409)
  assert.equal((await current()).historyCount,2)
})

test('lost committed HTTP reply is recovered by the same durable command after reconnect', async () => {
  const cmd=command(await current());dropReply=true
  await assert.rejects(request({body:cmd}))
  const replay=await request({body:cmd});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true)
  assert.equal((await current()).historyCount,1)
  await saveCalendar({bookings:[],blocks:[]})
  const removed=await request({body:cmd});assert.equal(removed.status,200);assert.equal(removed.body.current,null)
})

test('two different concurrent edits and a stale scheduling snapshot cannot overwrite', async () => {
  const old=await current()
  const results=await Promise.all(['one','two'].map(name=>request({body:command(old,{name})})))
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await current()).historyCount,1)
  const view=await current(), altered=await calendar();altered.bookings[0].revision++;await saveCalendar(altered)
  assert.equal((await request({body:command(view)})).body.code,'tour_contact_changed')
})

test('auth, property, current role, config, origin, strict command and duplicate query boundaries fail closed', async () => {
  const cmd=command(await current())
  for(const args of [{user:'missing'},{user:'viewer-a'},{property:'property-b1'},{org:'organization-b'},
    {headers:{'x-atrium-config-version':'2'}},{headers:{origin:'https://foreign.invalid'}},{headers:{'sec-fetch-site':'cross-site'}},{headers:{'content-type':'text/plain'}}]) {
    assert.ok([401,403,409].includes((await request({...args,body:cmd})).status),JSON.stringify(args))
  }
  for(const patch of [{email:'not-an-email'},{name:'\nInjected'},{reason:'x'},{requestId:'short'},{prospectPhone:'+12025550222'},{externalId:undefined}]) assert.equal((await request({body:{...cmd,...patch}})).status,400)
  for(const query of ['?externalId=x&externalId=y','?externalId=x&beforeRevision=0','?externalId=x&beforeRevision=1002','?externalId=x&propertyId=property-b1']) assert.equal((await request({query})).status,400)
  assert.equal((await request({method:'DELETE'})).status,405)
  await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-staff-a'")
  assert.equal((await request({user:'staff-a',body:cmd})).status,403)
  assert.equal((await current()).contactRevision,0)
})

test('past, ambiguous, missing, pending-review and invalid history rows cannot be edited', async () => {
  const old=await current()
  for(const kind of ['past','times','pending','duplicate','missing']) {
    const value=state()
    if(kind==='past'){value.bookings[0].startsAt='2000-01-01T12:00:00Z';value.bookings[0].endsAt='2000-01-01T12:30:00Z'}
    if(kind==='times')delete value.bookings[0].endsAt
    if(kind==='pending')value.bookings[0].rescheduleHistory=[{projection:'pending'}]
    if(kind==='duplicate')value.bookings.push({...booking})
    if(kind==='missing')value.bookings=[]
    await saveCalendar(value)
    const found=await request()
    if(['past','times','pending'].includes(kind)){assert.equal(found.status,200);assert.equal(found.body.current.canEdit,false);assert.equal((await request({body:command(found.body.current)})).status,409)}
    else assert.ok([404,409].includes(found.status))
    assert.ok([404,409].includes((await request({body:command(old)})).status))
  }
  await saveCalendar(state())
  await db.admin.query("INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-a','property-a1',$1,$2)",['tour-contact-history:'+hashJson(booking.externalId),JSON.stringify({format:'tour-contact-history-v1',externalId:booking.externalId,changes:[]})])
  assert.equal((await request()).body.code,'tour_contact_history_invalid')
})

test('receipt or audit persistence failure rolls back calendar, history and audit together', async () => {
  for(const table of ['operational_documents','audit_events']) {
    const before=await calendar(), docs=await documents(), audits=await auditCount(), cmd=command(await current())
    await db.admin.query(`CREATE FUNCTION atrium.test_contact_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${table==='operational_documents'?"IF NEW.key LIKE 'tour-contact-command:%' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF;":"RAISE EXCEPTION 'synthetic audit failure';"} RETURN NEW; END $$;
      CREATE TRIGGER test_contact_failure BEFORE INSERT ON atrium.${table} FOR EACH ROW EXECUTE FUNCTION atrium.test_contact_failure()`)
    try{assert.equal((await request({body:cmd})).status,503)}finally{await db.admin.query(`DROP TRIGGER test_contact_failure ON atrium.${table};DROP FUNCTION atrium.test_contact_failure()`)}
    assert.deepEqual(await calendar(),before);assert.deepEqual(await documents(),docs);assert.equal(await auditCount(),audits)
  }
})

test('history pagination remains exact; malformed receipt/history cannot claim a successful retry', async () => {
  for(let i=0;i<23;i++){const result=await request({body:command(await current(),{name:'Visitor '+i})});assert.equal(result.status,200)}
  const first=await current();assert.equal(first.history.length,20);assert.equal(first.nextBeforeRevision,4)
  const second=await request({query:'?externalId='+booking.externalId+'&beforeRevision=4'})
  assert.deepEqual(second.body.current.history.map(c=>c.revision),[3,2,1]);assert.equal(second.body.current.nextBeforeRevision,null)
  assert.equal(second.body.current.expectedSha256,first.expectedSha256)
  const cmd=command(first);assert.equal((await request({body:cmd})).status,200)
  await db.admin.query("UPDATE atrium.operational_documents SET value=jsonb_set(value,'{change,actorId}','\"foreign-user\"') WHERE key=$1",['tour-contact-command:'+hashJson(cmd.requestId)])
  assert.equal((await request({body:cmd})).body.code,'tour_contact_history_invalid')
  await db.admin.query("UPDATE atrium.operational_documents SET value=jsonb_set(value,'{changes,1,previous,name}','\"broken-chain\"') WHERE key=$1",['tour-contact-history:'+hashJson(booking.externalId)])
  assert.equal((await request()).body.code,'tour_contact_history_invalid')
})

test('locked calendar reader expires when the owning transaction ends', async () => {
  const property=await resolveOpsRuntime({atriumRuntime:runtime,headers:{cookie:cookies['owner-a'],'x-atrium-organization-id':'organization-a','x-atrium-property-id':'property-a1','x-atrium-config-version':'1'}},'operate')
  let saved
  await property.calendarStore.transaction(async unit=>{saved=unit.readCalendar;assert.deepEqual(await saved(),state())})
  await assert.rejects(saved())
  assert.deepEqual(failures,[])
})

test('revoked session cannot replay a saved command or read contact history; legacy has no fallback', async () => {
  const cmd=command(await current());assert.equal((await request({body:cmd})).status,200)
  const principal=await runtime.authenticate({cookie:cookies['owner-a']},new Date())
  await runtime.sessions.revoke(principal,principal.sessionId)
  assert.equal((await request()).status,401);assert.equal((await request({body:cmd})).status,401)
  delete process.env.ATRIUM_RUNTIME_MODE
  try{assert.equal((await request()).status,404)}finally{process.env.ATRIUM_RUNTIME_MODE='postgres'}
})

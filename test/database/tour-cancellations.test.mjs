import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createTourCancellationService } from '../../src/calendar/tour-cancellations.ts'
import { consolidateCall } from '../../src/leads/consolidate.ts'
import { emptyProfile } from '../../src/leads/profile.ts'
import { deriveFollowUps } from '../../src/leads/followups.ts'
import { reconcileRescheduledTour } from '../../src/leads/reschedule.ts'
import { occupancyPeak, bookingSlot } from '../../src/calendar/slots.ts'
import { storeBackedCalendar } from '../../src/calendar/port.ts'
import leadsHandler from '../../api/leads.ts'
import dashboard from '../../api/dashboard.ts'
import handler from '../../api/tour-cancellations.ts'
import { resolveOpsRuntime } from '../../src/application/runtime.ts'
import { hashJson } from '../../src/workflows/validation.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'

const oldMode = process.env.ATRIUM_RUNTIME_MODE
let db, app, runtime, server, origin, password
const cookies = {}, failures = []
let dropReply = false
const buildings = [['organization-a','property-a1'], ['organization-b','property-b1']]
const startsAt = new Date(Math.ceil((Date.now() + 2 * 86400000) / 60000) * 60000).toISOString()
const endsAt = new Date(Date.parse(startsAt) + 1800000).toISOString()
const booking = { externalId: 'confirmed-fixture-1', slotId: 'slot-' + startsAt.slice(0,16), startsAt, endsAt,
  prospectName: 'Test Visitor', prospectEmail: 'visitor@example.test', prospectPhone: '+12025550101', unitId: null,
  bookedAt: new Date().toISOString(), revision: 0, interactionId: 'original-call' }
const settings = { capacity: 3, slotMinutes: 30, startIntervalMinutes: 30, bufferMinutes: 0, minimumNoticeMinutes: 0,
  bookingWindowDays: null, sameUnitPolicy: 'exclusive', hours: { 1: { openHour: 9, closeHour: 17 } } }
const state = () => ({ bookings: [structuredClone(booking)], blocks: [] })
async function saveCalendar(value, property = 'property-a1', org = 'organization-a') {
  await db.admin.query('INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES($1,$2,$3::jsonb) ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state', [org, property, JSON.stringify(value)])
}
before(async () => {
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  db = await createFoundationTestDatabase(); app = db.createAppConnection(); password = (await seedFoundationTestDatabase(db.admin)).password
  runtime = createDatabaseRuntime({ app, auth: db.auth, sessionSecret: 'synthetic-confirmation-session-secret-long-enough', authOrigin: TEST_AUTH_ORIGIN })
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
      await (url.pathname === '/api/dashboard' ? dashboard : url.pathname === '/api/leads' ? leadsHandler : handler)(req,res)
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
  await app?.close(); await db?.close(); if (oldMode === undefined) delete process.env.ATRIUM_RUNTIME_MODE; else process.env.ATRIUM_RUNTIME_MODE = oldMode
})
async function request({ body, user = 'owner-a', property = 'property-a1', org = 'organization-a', headers = {}, query, method } = {}) {
  const response = await fetch(origin + '/api/tour-cancellations' + (body === undefined ? query ?? '?externalId=' + booking.externalId : ''), {
    method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { cookie: cookies[user] ?? '', 'x-atrium-organization-id':org,'x-atrium-property-id':property,'x-atrium-config-version':'1',
      ...(body === undefined ? {} : { origin,'content-type':'application/json' }), ...headers }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) })
  return { status:response.status, body:await response.json() }
}
const command = (current, patch = {}) => ({ action:'cancel', externalId:booking.externalId, expectedSha256:current.expectedSha256,
  requestId:randomUUID(), reason:'Prospect requested cancellation', verified:true, ...patch })
const current = async () => { const r=await request();assert.equal(r.status,200,JSON.stringify(r.body));return r.body.current }
const calendar = async () => (await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state
const documents = async () => (await db.admin.query("SELECT key,value FROM atrium.operational_documents WHERE property_id='property-a1' ORDER BY key")).rows
const auditCount = async () => (await db.admin.query('SELECT count(*)::int n FROM atrium.audit_events')).rows[0].n

const profileKey='lead:'+booking.prospectPhone
const selected = () => resolveOpsRuntime({atriumRuntime:runtime,headers:{cookie:cookies['owner-a'],'x-atrium-organization-id':'organization-a','x-atrium-property-id':'property-a1','x-atrium-config-version':'1'}},'operate')
const outcome = () => ({callId:booking.interactionId,phone:booking.prospectPhone,at:new Date(booking.bookedAt),durationSeconds:60,
  qualification:{},name:booking.prospectName,email:booking.prospectEmail,unitsDiscussed:[],booking:{externalId:booking.externalId,
    slotId:booking.slotId,startsAt,endsAt,unitId:null,status:'confirmed'},lossReason:null,escalation:null,toolsCalled:['book_tour']})
const project = async (work = store=>consolidateCall(store,outcome(),'America/New_York')) => (await selected()).documents.transaction(work)
async function lead() { return (await selected()).documents.get(profileKey) }
async function followups() { return (await documents()).filter(r=>r.key.startsWith('followup:')).map(r=>r.value) }
const gate = () => { let resolve; const promise=new Promise(r=>{resolve=r});return {promise,resolve} }

test('cancellation frees capacity, retains exact history/contact and retires only matching scheduled tour work',async()=>{
  await project()
  const p=await selected(), before=await calendar(), originalProfile=await lead()
  await p.documents.set('followup:manual-callback',{id:'manual-callback',phone:booking.prospectPhone,kind:'callback',status:'scheduled',createdFromCall:booking.interactionId,executable:false})
  const rows=await followups(), done=rows.find(r=>r.kind==='post_tour')
  await p.documents.update('followup:'+done.id,done,current=>({...current,status:'done'}))
  const cmd=command(await current()), result=await request({user:'staff-a',body:cmd})
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.current.status,'cancelled')
  assert.equal(result.body.current.notification,'not_sent');assert.equal(result.body.current.cancellation.actorId,'staff-a')
  const after=await calendar();assert.equal(after.bookings.length,0);assert.equal(after.cancelledBookings.length,1)
  assert.deepEqual(after.cancelledBookings[0].booking,before.bookings[0])
  const slot=bookingSlot(booking);assert.equal(occupancyPeak(slot,before,settings),1);assert.equal(occupancyPeak(slot,after,settings),0)
  assert.equal((await lead()).bookings[0].status,'cancelled');assert.deepEqual((await lead()).calls,originalProfile.calls)
  for(const row of await followups()) assert.equal(row.status,row.id===done.id?'done':row.id==='manual-callback'?'scheduled':'skipped')
  const reopened=await fetch(origin+'/api/leads',{method:'POST',headers:{cookie:cookies['owner-a'],'x-atrium-organization-id':'organization-a','x-atrium-property-id':'property-a1','x-atrium-config-version':'1',origin,'content-type':'application/json'},body:JSON.stringify({action:'followup_status',id:done.id,status:'scheduled'})})
  assert.equal(reopened.status,409);assert.match((await reopened.json()).error,/cancelled tour/)
  assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.action_intents')).rows[0].n,0)
  assert.equal((await request({user:'owner-b',org:'organization-b',property:'property-b1'})).body.current.status,'active')
})

test('simultaneous retries commit one cancellation and changed commands cannot reuse its identity',async()=>{
  const cmd=command(await current()), results=await Promise.all(Array.from({length:4},()=>request({body:cmd})))
  assert.ok(results.every(r=>r.status===200),JSON.stringify(results));assert.equal(results.filter(r=>!r.body.replayed).length,1)
  assert.equal((await calendar()).cancelledBookings.length,1)
  for(const patch of [{reason:'Different request'},{requestId:randomUUID()}]) assert.equal((await request({body:{...cmd,...patch}})).status,409)
  assert.equal((await request({user:'staff-a',body:cmd})).status,409)
  const unrelated={...booking,externalId:'another-reservation',interactionId:'another-call'}
  const saved=await calendar();saved.bookings.push(unrelated);await saveCalendar(saved)
  assert.equal((await request({body:cmd})).body.replayed,true);assert.deepEqual((await calendar()).bookings,[unrelated])
})

test('lost committed cancellation reply recovers using exactly the same command',async()=>{
  const cmd=command(await current());dropReply=true;await assert.rejects(request({body:cmd}))
  const replay=await request({body:cmd});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true)
  assert.equal((await current()).status,'cancelled');assert.equal((await calendar()).cancelledBookings.length,1)
})

test('authorization, revoked grants, origin, configuration, strict input and query fail closed',async()=>{
  const cmd=command(await current())
  for(const args of [{user:'missing'},{user:'viewer-a'},{property:'property-b1'},{org:'organization-b'},
    {headers:{'x-atrium-config-version':'2'}},{headers:{origin:'https://foreign.invalid'}},{headers:{'sec-fetch-site':'cross-site'}},{headers:{'content-type':'text/plain'}}]) {
    assert.ok([401,403,409].includes((await request({...args,body:cmd})).status),JSON.stringify(args))
  }
  for(const patch of [{verified:false},{verified:undefined},{reason:'x'},{reason:'\nInjected'},{requestId:'x'},{notification:'sent'},{externalId:undefined}]) assert.equal((await request({body:{...cmd,...patch}})).status,400)
  assert.equal((await request({query:'?externalId=x&externalId=y'})).status,400)
  assert.equal((await request({method:'DELETE'})).status,405)
  await db.admin.query("UPDATE atrium.property_grants SET status='revoked' WHERE membership_id='member-staff-a'")
  assert.equal((await request({user:'staff-a',body:cmd})).status,403);assert.equal((await calendar()).bookings.length,1)
})

test('stale contact/reschedule snapshot, duplicate identity, past and pending tours refuse cancellation',async()=>{
  const old=await current()
  for(const kind of ['contact','schedule','past','pending','duplicate','missing']) {
    const value=state()
    if(kind==='contact')value.bookings[0].prospectName='New contact'
    if(kind==='schedule')value.bookings[0].revision=2
    if(kind==='past'){value.bookings[0].startsAt='2000-01-01T12:00:00.000Z';value.bookings[0].endsAt='2000-01-01T12:30:00.000Z'}
    if(kind==='pending')value.bookings[0].rescheduleHistory=[{projection:'pending'}]
    if(kind==='duplicate')value.bookings.push({...booking})
    if(kind==='missing')value.bookings=[]
    await saveCalendar(value);assert.ok([404,409].includes((await request({body:command(old)})).status),kind)
    if(['past','pending'].includes(kind)){const fresh=await current();assert.equal(fresh.canCancel,false);assert.equal((await request({body:command(fresh)})).status,409)}
    assert.deepEqual(await calendar(),value)
  }
})

test('receipt, profile, cancellation index and audit failures roll back capacity, archive and all follow-ups',async()=>{
  await project()
  for(const failure of ['receipt','profile','index','audit']) {
    const before=await calendar(), docs=await documents(), audits=await auditCount(), cmd=command(await current())
    const table=failure==='audit'?'audit_events':'operational_documents'
    const prefix=failure==='receipt'?'tour-cancellation-command:%':failure==='profile'?'lead:%':'tour-cancellation-lead:%'
    await db.admin.query(`CREATE FUNCTION atrium.test_cancel_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${failure==='audit'?"RAISE EXCEPTION 'synthetic audit failure';":`IF NEW.key LIKE '${prefix}' THEN RAISE EXCEPTION 'synthetic cancellation failure'; END IF;`} RETURN NEW; END $$;
      CREATE TRIGGER test_cancel_failure BEFORE INSERT OR UPDATE ON atrium.${table} FOR EACH ROW EXECUTE FUNCTION atrium.test_cancel_failure()`)
    try{assert.equal((await request({body:cmd})).status,503,failure)}finally{await db.admin.query(`DROP TRIGGER test_cancel_failure ON atrium.${table};DROP FUNCTION atrium.test_cancel_failure()`)}
    assert.deepEqual(await calendar(),before);assert.deepEqual(await documents(),docs);assert.equal(await auditCount(),audits)
  }
})

test('cancellation before first finished call prevents late projection from restoring bookings or follow-ups',async()=>{
  const cmd=command(await current()), result=await request({body:cmd});assert.equal(result.status,200)
  assert.equal(result.body.projection.status,'awaiting_call');assert.equal(await lead(),null)
  for(let i=0;i<3;i++) await project()
  const profile=await lead();assert.equal(profile.bookings.length,1);assert.equal(profile.bookings[0].status,'cancelled')
  assert.equal(profile.calls.length,1);assert.equal(profile.calls[0].outcome,'Booked a tour')
  assert.equal(profile.stage,'new');assert.equal((await followups()).filter(r=>r.status==='scheduled').length,0)
})

test('missing lead lock serializes cancellation ahead of an already-started original-call projection',async()=>{
  const p=await selected(), entered=gate(), release=gate(), original=p.calendarStore.transaction.bind(p.calendarStore)
  p.calendarStore.transaction=work=>original(unit=>work({...unit,readLockedDocument:async key=>{const value=await unit.readLockedDocument(key);entered.resolve();await release.promise;return value}}))
  const cancelling=createTourCancellationService(p).cancel(command(await current()))
  await entered.promise
  let completed=false
  const projecting=project().then(v=>{completed=true;return v})
  try { await new Promise(r=>setTimeout(r,50));assert.equal(completed,false) } finally { release.resolve() }
  await cancelling;await projecting
  assert.equal((await lead()).bookings[0].status,'cancelled');assert.equal((await followups()).filter(r=>r.status==='scheduled').length,0)
})

test('projection that wins profile lock is fully retired by cancellation after its commit',async()=>{
  const entered=gate(), release=gate(), cmd=command(await current())
  const projecting=project(store=>consolidateCall({...store,update:async(key,initial,fn)=>{const result=await store.update(key,initial,fn);if(key===profileKey){entered.resolve();await release.promise}return result}},outcome(),'America/New_York'))
  await entered.promise
  let completed=false
  const cancelling=request({body:cmd}).then(r=>{completed=true;return r})
  try{await new Promise(r=>setTimeout(r,50));assert.equal(completed,false)}finally{release.resolve()}
  await projecting;assert.equal((await cancelling).status,200)
  assert.equal((await lead()).bookings[0].status,'cancelled');assert.ok((await followups()).length>0)
  assert.ok((await followups()).every(r=>r.status==='skipped'))
})

test('original-call and exact-key late creates are fenced; a fresh call can use released capacity',async()=>{
  assert.equal((await request({body:command(await current())})).status,200)
  const p=await selected(), port=storeBackedCalendar(p.calendarStore,()=>new Date(booking.bookedAt),{...settings,timeZone:'UTC',hours:Object.fromEntries(Array.from({length:7},(_,i)=>[i,{openHour:0,closeHour:24}]))})
  const requestFor=(call,id)=>({idempotencyKey:id,request:{propertyId:'property-a1',interactionId:call,slot:bookingSlot(booking),unitId:null,prospectName:'Visitor',prospectEmail:null,prospectPhone:booking.prospectPhone}})
  assert.equal(await port.readBooking(booking.externalId),null)
  await assert.rejects(port.createBooking(requestFor(booking.interactionId,'new-tool-id')),/cancelled/i)
  await assert.rejects(port.createBooking(requestFor('new-call',booking.externalId)),/cancelled/i)
  // Align to a valid slot for the independent new call; old key remains permanently fenced.
  const slots=await port.listSlots('property-a1',new Date(Date.parse(startsAt)-86400000),new Date(Date.parse(endsAt)+86400000))
  assert.ok(slots.length);const intent=requestFor('new-call','new-reservation');intent.request.slot=slots[0]
  assert.equal((await port.createBooking(intent)).externalId,'new-reservation')
  assert.equal((await calendar()).bookings.length,1);assert.equal((await calendar()).cancelledBookings.length,1)
})

test('cancelled reschedule history cannot be projected back to confirmed',async()=>{
  await project()
  const c=await calendar(), old=c.bookings[0], moved={...old,slotId:'slot-'+new Date(Date.parse(startsAt)+3600000).toISOString().slice(0,16),startsAt:new Date(Date.parse(startsAt)+3600000).toISOString(),endsAt:new Date(Date.parse(endsAt)+3600000).toISOString(),revision:1}
  const change={requestId:'old-reschedule',revision:1,at:booking.bookedAt,actorId:'owner-a',timeZone:'America/New_York',from:{slotId:old.slotId,startsAt:old.startsAt,endsAt:old.endsAt,unitId:null},to:{slotId:moved.slotId,startsAt:moved.startsAt,endsAt:moved.endsAt,unitId:null},projection:'complete'}
  moved.rescheduleHistory=[change];await saveCalendar({...c,bookings:[moved]})
  const p=await selected();await p.documents.transaction(store=>reconcileRescheduledTour(store,{booking:moved,change}))
  assert.equal((await request({body:command(await current())})).status,200)
  await p.documents.transaction(store=>reconcileRescheduledTour(store,{booking:moved,change}));await project()
  assert.equal((await lead()).bookings[0].status,'cancelled');assert.ok((await followups()).every(r=>r.status!=='scheduled'))
})

test('locked missing-document reader expires and leaves no fabricated records',async()=>{
  const p=await selected();let read
  await p.calendarStore.transaction(async unit=>{read=unit.readLockedDocument;assert.equal(await read('lead:missing'),null)})
  await assert.rejects(read('lead:missing'));assert.equal(await p.documents.get('lead:missing'),null)
  assert.deepEqual(failures,[])
})

test('anonymous callers remain separated and an unidentifiable legacy reservation requires review',async()=>{
  const c=state();c.bookings[0].prospectPhone='unknown';await saveCalendar(c)
  const p=await selected(), first={...outcome(),phone:'unknown'}, second={...first,callId:'another-hidden-call',booking:{...first.booking,externalId:'another-hidden-booking'}}
  await p.documents.transaction(store=>consolidateCall(store,first,'America/New_York'))
  await p.documents.transaction(store=>consolidateCall(store,second,'America/New_York'))
  const before=await p.documents.get('lead:anonymous:another-hidden-call')
  assert.equal((await request({body:command(await current())})).status,200)
  assert.equal((await p.documents.get('lead:anonymous:'+booking.interactionId)).bookings[0].status,'cancelled')
  assert.deepEqual(await p.documents.get('lead:anonymous:another-hidden-call'),before)
  await saveCalendar({blocks:[],bookings:[{...c.bookings[0],interactionId:undefined}]})
  const legacy=await current();assert.equal(legacy.canCancel,false);assert.equal((await request({body:command(legacy)})).status,409)
})

test('other reservations and callback tasks survive cancellation; ambiguous old reminders remain flagged',async()=>{
  await project()
  const p=await selected(), original=await lead(), other={...original.bookings[0],externalId:'other-tour',unitId:'9B'}
  await p.documents.update(profileKey,original,current=>({...current,bookings:[...current.bookings,other]}))
  for(const f of deriveFollowUps({...original,bookings:[other]},new Date(booking.bookedAt),booking.interactionId,'America/New_York')) await p.documents.set('followup:'+f.id,f)
  const before=await followups(), unrelated=before.filter(r=>r.source?.booking?.externalId==='other-tour')
  assert.ok(unrelated.length)
  const old={id:'legacy-ambiguous',phone:booking.prospectPhone,kind:'post_tour',channel:'call',dueAt:endsAt,reason:'old reminder',status:'scheduled',createdAt:booking.bookedAt,createdFromCall:booking.interactionId,executable:false}
  await p.documents.set('followup:'+old.id,old)
  const result=await request({body:command(await current())});assert.equal(result.status,200);assert.equal(result.body.projection.status,'needs_review')
  const rows=await followups();assert.deepEqual(rows.filter(r=>r.source?.booking?.externalId==='other-tour'),unrelated)
  assert.equal((await lead()).bookings.find(b=>b.externalId==='other-tour').status,'confirmed')
  assert.equal(rows.find(r=>r.id===old.id).reconciliation.status,'needs_review')
})

test('legacy physical booking and source-less unique follow-up are retired without erasing history',async()=>{
  await project();const p=await selected(), original=await lead()
  await p.documents.update(profileKey,original,current=>({...current,bookings:current.bookings.map(({externalId,...b})=>b)}))
  const f=(await followups()).find(r=>r.kind==='post_tour')
  await p.documents.update('followup:'+f.id,f,({source,...current})=>current)
  assert.equal((await request({body:command(await current())})).status,200)
  assert.equal((await lead()).bookings[0].status,'cancelled')
  assert.equal((await p.documents.get('followup:'+f.id)).status,'skipped')
  await project();assert.equal((await lead()).bookings.length,1)
})

test('current permission revocation during a cancellation rolls the entire operation back',async()=>{
  const p=await selected(), entered=gate(), release=gate(), original=p.calendarStore.transaction.bind(p.calendarStore)
  p.calendarStore.transaction=work=>original(unit=>work({...unit,readLockedDocument:async key=>{const value=await unit.readLockedDocument(key);entered.resolve();await release.promise;return value}}))
  const cmd=command(await current()), before=await calendar(), beforeDocs=await documents()
  const operation=createTourCancellationService(p).cancel(cmd)
  const rejection=assert.rejects(operation)
  await entered.promise
  await db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-owner-a'")
  release.resolve()
  try{await rejection;assert.deepEqual(await calendar(),before);assert.deepEqual(await documents(),beforeDocs)}finally{await db.admin.query("UPDATE atrium.memberships SET status='active' WHERE id='member-owner-a'")}
})

test('legacy reservations require one original-call association before cancellation',async()=>{
  const c=state();delete c.bookings[0].interactionId;await saveCalendar(c)
  let view=await current();assert.equal(view.canCancel,false);assert.match(view.reason,/original call/)
  assert.equal((await request({body:command(view)})).status,409)
  await project();view=await current();assert.equal(view.canCancel,true)
  assert.equal((await request({body:command(view)})).status,200)
  assert.deepEqual((await calendar()).cancelledBookings[0].interactionIds,[booking.interactionId])
})

import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createTourChangeResolutionFixture } from '../helpers/tour-change-resolution-fixture.mjs'
import { createTourChangeResolutionService } from '../../src/leads/tour-change-resolution.ts'
import { reviewTourChangeRequest } from '../../src/leads/tour-change.ts'

let f
before(async()=>{f=await createTourChangeResolutionFixture()})
beforeEach(async()=>{await f.reset()})
after(async()=>{await f?.close()})
const preview=async()=>{const r=await f.request();assert.equal(r.status,200,JSON.stringify(r.body));return r.body}
const current=async()=> (await f.context()).documents.get(f.id)
const counts=async()=> (await f.db.admin.query("SELECT count(*)::int n FROM atrium.operational_documents WHERE property_id='property-a1' AND key LIKE 'tour-change-resolution:%'")).rows[0].n
const auditCount=async()=> (await f.db.admin.query('SELECT count(*)::int n FROM atrium.audit_events')).rows[0].n

test('review is not resolution; explicit no-change decision is atomic, audited and makes no calendar/provider changes',async()=>{
  const c=await f.context(),initial=await current()
  await reviewTourChangeRequest(c.documents,{id:f.id,expectedRevision:initial.revision,actorId:'owner-a',at:new Date(),note:'Reviewing request'})
  const p=await preview();assert.equal(p.request.status,'reviewed');assert.equal(p.canResolve,true)
  const calendar=await f.calendar(),command={...f.command(p),note:'Verified caller.\nThey kept the existing tour.'},r=await f.request({body:command})
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.request.status,'resolved')
  assert.equal(r.body.resolution.association,'staff_decision');assert.equal(r.body.resolution.notification,'not_sent_by_resolution')
  assert.equal(r.body.resolution.note,command.note)
  assert.equal(await counts(),1);assert.deepEqual(await f.calendar(),calendar);assert.equal(f.requests.length,0)
  const audits=await f.db.admin.query("SELECT * FROM atrium.audit_events WHERE organization_id='organization-a' AND property_id='property-a1' AND operation='document.set'")
  assert.ok(audits.rows.length>=2);assert.match(r.headers.get('cache-control'),/no-store/)
})
for(const outcome of ['cancelled','rescheduled'])test(`actual HTTP ${outcome} can be linked to the exact staff-verified request`,async()=>{
  outcome==='cancelled'?await f.cancel():await f.reschedule()
  const p=await preview();assert.equal(p.candidates.length,1);assert.equal(p.candidates[0].outcome,outcome)
  const calendar=await f.calendar(),r=await f.request({body:f.command(p,outcome)})
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.resolution.source.externalId,f.booking.externalId)
  assert.equal(r.body.resolution.association,'staff_verified');assert.equal(r.body.request.identityVerified,false)
  assert.deepEqual(await f.calendar(),calendar);assert.equal(f.requests.length,0)
})
test('duplicate saves and simultaneous different decisions produce one outcome',async()=>{
  const p=await preview(),command=f.command(p)
  const replies=await Promise.all([f.request({body:command}),f.request({body:command})])
  assert.deepEqual(replies.map(r=>r.status),[200,200]);assert.equal(replies.filter(r=>r.body.replayed).length,1)
  assert.equal((await current()).resolutions.length,1);assert.equal(await counts(),1)
  await f.reset();const fresh=await preview()
  const race=await Promise.all([f.request({body:f.command(fresh)}),f.request({user:'staff-a',body:f.command(fresh)})])
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal((await current()).resolutions.length,1)
})
test('new evidence makes an old form stale and reopens a closed request without losing its decision',async()=>{
  const p=await preview(),command=f.command(p),r=await f.request({body:command});assert.equal(r.status,200)
  await f.evidence('Please cancel instead; I cannot attend.')
  const retry=await f.request({body:command});assert.equal(retry.status,200);assert.equal(retry.body.replayed,true)
  assert.equal(retry.body.request.status,'pending');assert.equal(retry.body.request.resolutions.length,1)
  assert.equal(retry.body.resolution.requestId,command.requestId)
  assert.equal((await f.request({body:f.command(p)})).status,409)
  const next=await f.request({body:f.command(await preview())});assert.equal(next.status,200);assert.equal(next.body.request.resolutions.length,2)
})
test('changed source, pending reschedule or conflicting active/archive identity cannot close a request',async()=>{
  await f.cancel();let p=await preview(),state=await f.calendar();state.cancelledBookings[0].booking.prospectPhone='+12025550999';await f.saveCalendar(state)
  assert.equal((await f.request({body:f.command(p,'cancelled')})).status,409)
  state.bookings=[f.booking];await f.saveCalendar(state);assert.equal((await preview()).candidates.length,0)
  await f.reset();await f.reschedule();state=await f.calendar();state.bookings[0].rescheduleHistory[0].projection='pending';await f.saveCalendar(state)
  assert.equal((await preview()).candidates.length,0);assert.equal(await counts(),0)
})
test('earlier completed changes cannot answer newer caller instructions',async()=>{
  await f.cancel();assert.equal((await preview()).candidates.length,1)
  await f.evidence('Now I want a new time instead of cancellation.')
  assert.equal((await preview()).candidates.length,0)
})
test('same command identity cannot be reused for another note or actor',async()=>{
  const command=f.command(await preview());assert.equal((await f.request({body:command})).status,200)
  assert.equal((await f.request({body:{...command,note:'Another decision entirely'}})).status,409)
  assert.equal((await f.request({body:command,user:'staff-a'})).status,409);assert.equal(await counts(),1)
})
test('sign-in, role, organization/property, current configuration and CSRF are independently enforced',async()=>{
  const command=f.command(await preview())
  for(const [options,status] of [[{user:'anonymous'},401],[{user:'viewer-a'},403],[{property:'property-b1',org:'organization-b'},403],
    [{extraHeaders:{'x-atrium-config-version':'99'}},409],[{extraHeaders:{origin:'https://foreign.example.test'}},403]])
    assert.equal((await f.request({...options,body:command})).status,status)
  assert.equal((await f.request({body:command,property:'property-b1',org:'organization-b',user:'owner-b'})).status,409)
  assert.equal(await counts(),0)
  await f.db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE user_id='owner-a'")
  assert.equal((await f.request({body:command})).status,403)
})
test('new property publication requires rereview and revoked staff authority invalidates an already resolved service',async()=>{
  const p=await preview(),c=await f.context(),service=createTourChangeResolutionService(c)
  await f.publish(f.configurations['property-a1'])
  assert.equal((await f.request({body:f.command(p)})).status,409)
  await assert.rejects(service.resolve(f.command(p)))
  assert.equal(await counts(),0)
})
test('malformed commands, unsupported outcomes and repeated query keys never write',async()=>{
  const command=f.command(await preview())
  for(const patch of [{verified:false},{note:' '},{outcome:'contacted'},{sourceSha256:'a'.repeat(64)},
    {extra:'invented'},{expectedRevision:-1},{requestId:'bad id'},{id:'other-property-key'}])
    assert.equal((await f.request({body:{...command,...patch}})).status,400)
  assert.equal((await f.request({body:'x'.repeat(9000)})).status,400)
  assert.equal((await f.request({query:'?id='+f.id+'&id=other'})).status,400)
  assert.equal((await f.request({query:'?id='+f.id+'&search='+encodeURIComponent('x'.repeat(121))})).status,400)
  assert.equal((await f.request({body:command,query:'?id='+f.id})).status,403)
  assert.equal((await f.request({method:'DELETE'})).status,405);assert.equal(await counts(),0)
})
test('receipt write failure rolls back decision and its audit; replay can then complete safely',async()=>{
  const command=f.command(await preview()),before=await current(),auditBefore=await auditCount()
  await f.db.admin.query(`CREATE FUNCTION atrium.reject_resolution_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key LIKE 'tour-change-resolution:%' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_resolution_receipt BEFORE INSERT ON atrium.operational_documents FOR EACH ROW EXECUTE FUNCTION atrium.reject_resolution_receipt()`)
  try{assert.equal((await f.request({body:command})).status,503);assert.deepEqual(await current(),before);assert.equal(await counts(),0);assert.equal(await auditCount(),auditBefore)}
  finally{await f.db.admin.query('DROP TRIGGER reject_resolution_receipt ON atrium.operational_documents; DROP FUNCTION atrium.reject_resolution_receipt()')}
  assert.equal((await f.request({body:command})).status,200)
})

test('calendar transaction orders an in-flight source edit ahead of outcome admission',async()=>{
  await f.cancel();const command=f.command(await preview(),'cancelled'),c=await f.context()
  let entered,release;const began=new Promise(r=>entered=r),gate=new Promise(r=>release=r)
  const changing=c.calendarStore.transaction(async unit=>{
    await unit.readCalendar();entered();await gate
    await unit.calendar.mutate(state=>{state.cancelledBookings[0].booking.prospectName='Corrected Visitor';return state})
  })
  await began;const resolving=f.request({body:command});release();await changing
  assert.equal((await resolving).status,409);assert.equal((await current()).status,'pending');assert.equal(await counts(),0)
})

test('a current staff service loses mutation authority when its membership is revoked',async()=>{
  const p=await preview(),c=await f.context('property-a1','organization-a','staff-a'),service=createTourChangeResolutionService(c)
  await f.db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE user_id='staff-a'")
  await assert.rejects(service.resolve(f.command(p)));assert.equal(await counts(),0)
})
test('bounded candidate search exposes incomplete coverage and can find an exact later match',async()=>{
  await f.cancel();const state=await f.calendar(),row=state.cancelledBookings[0]
  state.cancelledBookings=Array.from({length:102},(_,i)=>({...structuredClone(row),requestId:'cancel-'+i,
    booking:{...row.booking,externalId:'tour-'+String(i).padStart(3,'0'),prospectName:i===101?'Special Guest':'Visitor '+i}}))
  await f.saveCalendar(state)
  const first=await preview();assert.equal(first.candidates.length,100);assert.equal(first.more,true)
  const found=await f.request({query:'?id='+f.id+'&search=Special'});assert.equal(found.status,200)
  assert.equal(found.body.candidates.length,1);assert.equal(found.body.more,false);assert.equal(found.body.candidates[0].name,'Special Guest')
})

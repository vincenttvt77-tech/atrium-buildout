import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createCancellationEmailFixture } from '../helpers/cancellation-email-fixture.mjs'

let f
before(async () => { f = await createCancellationEmailFixture() })
beforeEach(async () => { await f.reset() })
after(async () => { await f?.close() })
const queue = preview => ({ action: 'queue', externalId: preview.externalId, bookingSha256: preview.bookingSha256, permissionConfirmed: true })
const processEmail = id => f.request({ body: { action: 'process', confirmationId: id } })
const posts = () => f.requests.filter(row => row.method === 'POST')
async function admitted(user = 'owner-a') {
  const preview = await f.request({ user }); assert.equal(preview.status, 200, JSON.stringify(preview.body))
  const result = await f.request({ user, body: queue(preview.body.preview) }); assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.confirmation
}
async function counts() {
  const result = {}
  for (const table of ['action_intents','outbox_messages','inbox_events']) result[table] = (await f.db.admin.query(`SELECT count(*)::int n FROM atrium.${table}`)).rows[0].n
  result.documents = (await f.db.admin.query("SELECT count(*)::int n FROM atrium.operational_documents WHERE key LIKE 'tour-cancellation-email%' ")).rows[0].n
  return result
}
async function configuration(change) {
  const value = structuredClone(f.configurations['property-a1']); change(value.property)
  await f.publish(value)
}

test('actual cancellation, exact permission, HTTP send and verified delivery preserve the released tour', async () => {
  const calendar = await f.calendar(), preview = await f.request()
  assert.equal(preview.status,200); assert.equal(preview.body.ready,true); assert.equal(preview.body.preview.recipient,f.booking.prospectEmail)
  assert.match(preview.body.preview.body,/has been cancelled/); assert.match(preview.body.preview.body,/America\/New_York/)
  assert.doesNotMatch(JSON.stringify(preview.body),/Internal staff reason|12025550101/)
  assert.match(preview.headers.get('cache-control'),/no-store/); assert.equal(f.requests.length,0)
  const saved = await admitted(); assert.equal(saved.state,'queued'); assert.equal(saved.delivery,'not_verified')
  const sent = await processEmail(saved.id); assert.equal(sent.status,200); assert.equal(sent.body.confirmation.delivery,'not_verified')
  await f.due(); const verified = await processEmail(saved.id)
  assert.equal(verified.body.confirmation.delivery,'delivered'); assert.equal(verified.body.confirmation.state,'succeeded')
  assert.match(verified.body.confirmation.message,/does not mean the prospect read it/)
  assert.equal(posts().length,1); assert.deepEqual(await f.calendar(),calendar)
  assert.equal((await f.request()).body.confirmation.id,saved.id); assert.deepEqual(f.errors,[])
})

test('concurrent operators share one permission, action and purpose index across real pooled connections', async () => {
  const draft = (await f.request()).body.preview
  const replies = await Promise.all(['owner-a','staff-a','owner-a','staff-a'].map(user => f.request({ user,body:queue(draft) })))
  assert.ok(replies.every(r=>r.status===200),JSON.stringify(replies)); assert.equal(new Set(replies.map(r=>r.body.confirmation.id)).size,1)
  assert.deepEqual(await counts(),{action_intents:1,outbox_messages:1,inbox_events:1,documents:2})
  const saved=replies[0].body.confirmation
  const processed=await Promise.all([processEmail(saved.id),processEmail(saved.id),processEmail(saved.id)])
  assert.ok(processed.every(r=>r.status===200)); assert.equal(posts().length,1)
  await f.due(); assert.equal((await processEmail(saved.id)).body.confirmation.delivery,'delivered')
})

test('lost committed queue and process HTTP replies recover the same email without another send', async () => {
  const draft=(await f.request()).body.preview; f.flags.dropQueueReply=true
  await assert.rejects(f.request({body:queue(draft)}),/fetch failed/)
  const recovered=await f.request({body:queue(draft)}); assert.equal(recovered.status,200)
  f.flags.dropProcessReply=true; await assert.rejects(processEmail(recovered.body.confirmation.id),/fetch failed/)
  const current=(await f.request()).body.confirmation; assert.equal(current.id,recovered.body.confirmation.id)
  await f.due(); assert.equal((await processEmail(current.id)).body.confirmation.delivery,'delivered')
  assert.equal(posts().length,1); assert.deepEqual(await counts(),{action_intents:1,outbox_messages:1,inbox_events:1,documents:2})
})

test('a provider effect with a lost acknowledgement is held and never blindly resent', async () => {
  const saved=await admitted(); f.flags.dropProviderReply=true
  assert.equal((await processEmail(saved.id)).body.confirmation.delivery,'not_verified')
  let checked
  for(let i=0;i<10;i++){await f.due();checked=await processEmail(saved.id);assert.equal(checked.body.confirmation.delivery,'not_verified')}
  assert.equal(checked.body.confirmation.state,'needs_review')
  await processEmail(saved.id); assert.equal(posts().length,1); assert.equal(f.effects.size,1)
})

test('only archived cancellations qualify, and a conflicting active tour prevents a message', async () => {
  await f.reset({cancelled:false}); assert.equal((await f.request()).status,404)
  await f.cancel(); const state=await f.calendar(); state.bookings=[f.booking];await f.saveCalendar(state)
  assert.equal((await f.request()).status,409); assert.equal(f.requests.length,0)
})

test('missing permission, injected copy/recipient, repeated queries and cross-site requests cannot enqueue', async () => {
  const draft=(await f.request()).body.preview
  for(const patch of [{permissionConfirmed:false},{to:'wrong@example.test'},{html:'injected'}]) assert.equal((await f.request({body:{...queue(draft),...patch}})).status,400)
  assert.equal((await f.request({query:'?externalId=a&externalId=b'})).status,400)
  assert.equal((await f.request({body:queue(draft),query:'?externalId=other'})).status,403)
  assert.equal((await f.request({body:queue(draft),extraHeaders:{origin:'https://foreign.example.test'}})).status,403)
  assert.equal((await f.request({body:'x'.repeat(5000)})).status,400)
  assert.equal((await f.request({body:{action:'process',confirmationId:draft.bookingSha256,recipient:'wrong'}})).status,400)
  assert.deepEqual(await counts(),{action_intents:0,outbox_messages:0,inbox_events:0,documents:0})
})

test('sign-in, current role, organization, property and configuration are independently enforced', async () => {
  for(const [options,status] of [[{user:'anonymous'},401],[{user:'viewer-a'},403],[{property:'property-b1',org:'organization-b'},403],[{extraHeaders:{'x-atrium-config-version':'99'}},409]]) {
    assert.equal((await f.request(options)).status,status)
  }
  const saved=await admitted()
  assert.equal((await f.request({user:'owner-b',property:'property-b1',org:'organization-b',body:{action:'process',confirmationId:saved.id}})).status,404)
  const other=(await f.request({user:'owner-b',property:'property-b1',org:'organization-b'})).body.preview
  const queued=await f.request({user:'owner-b',property:'property-b1',org:'organization-b',body:queue(other)})
  assert.equal(queued.status,200);assert.notEqual(queued.body.confirmation.id,saved.id);assert.equal(posts().length,0)
})

test('provider and cancellation-specific reviewed sender must both be configured', async () => {
  let draft=(await f.request()).body.preview; f.flags.configured=false
  assert.equal((await f.request()).body.ready,false);assert.equal((await f.request({body:queue(draft)})).status,503)
  f.flags.configured=true
  await configuration(p=>{p.tourConfirmationEmail=p.tourCancellationEmail;delete p.tourCancellationEmail})
  draft=(await f.request()).body.preview;assert.equal((await f.request()).body.ready,false)
  assert.equal((await f.request({body:queue(draft)})).status,503);assert.equal(posts().length,0)
})

test('changed archived details require fresh review and cannot create a second purpose after admission', async () => {
  const draft=(await f.request()).body.preview,state=await f.calendar()
  state.cancelledBookings[0].booking.prospectEmail='new@example.test';await f.saveCalendar(state)
  assert.equal((await f.request({body:queue(draft)})).status,409)
  const saved=await admitted()
  state.cancelledBookings[0].booking.prospectEmail='third@example.test';await f.saveCalendar(state)
  const next=await f.request();assert.equal(next.body.ready,false);assert.equal(next.body.priorConfirmation.id,saved.id)
  assert.equal(next.body.priorConfirmation.recipient,'new@example.test')
  assert.equal((await f.request({body:queue(next.body.preview)})).status,409)
  assert.equal((await processEmail(saved.id)).body.confirmation.state,'needs_review');assert.equal(posts().length,0)
  assert.deepEqual(await counts(),{action_intents:1,outbox_messages:1,inbox_events:1,documents:2})
})

test('cleared archived email retains the exact earlier recipient for staff recovery', async () => {
  const saved=await admitted(),state=await f.calendar();state.cancelledBookings[0].booking.prospectEmail=null;await f.saveCalendar(state)
  const read=await f.request();assert.equal(read.status,200);assert.equal(read.body.preview,null);assert.equal(read.body.ready,false)
  assert.equal(read.body.priorConfirmation.id,saved.id);assert.equal(read.body.priorConfirmation.recipient,f.booking.prospectEmail)
  assert.equal(Object.hasOwn(read.body.priorConfirmation,'input'),false)
})

test('cancelled source removal or resurrection after permission prevents dispatch', async () => {
  for(const mutation of ['missing','active']) {
    await f.reset();const saved=await admitted(),state=await f.calendar()
    if(mutation==='missing')state.cancelledBookings=[];else state.bookings=[f.booking]
    await f.saveCalendar(state);const result=await processEmail(saved.id)
    assert.equal(result.body.confirmation.state,'needs_review');assert.equal(posts().length,0)
  }
})

test('admission waits for calendar serialization and refuses a concurrently changed source', async () => {
  const draft=(await f.request()).body.preview,state=await f.calendar();state.cancelledBookings[0].booking.prospectEmail='changed@example.test'
  await f.db.admin.query('BEGIN');let pending
  try {
    await f.db.admin.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['organization-a','property-a1','calendar'])])
    await f.saveCalendar(state);let finished=false
    pending=f.request({body:queue(draft)}).then(r=>{finished=true;return r});await delay(75);assert.equal(finished,false)
    await f.db.admin.query('COMMIT');assert.equal((await pending).status,409)
    assert.equal((await counts()).action_intents,0)
  } finally {await f.db.admin.query('ROLLBACK');await pending}
})

test('failure writing the purpose index rolls back receipt, action, outbox and message record', async () => {
  const draft=(await f.request()).body.preview
  await f.db.admin.query(`CREATE FUNCTION public.reject_cancellation_email_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic storage failure'; END $$;
    CREATE TRIGGER reject_cancellation_email_fixture BEFORE INSERT ON atrium.operational_documents
    FOR EACH ROW WHEN (NEW.key LIKE 'tour-cancellation-email-index:%') EXECUTE FUNCTION public.reject_cancellation_email_fixture()`)
  try {assert.equal((await f.request({body:queue(draft)})).status,503);assert.deepEqual(await counts(),{action_intents:0,outbox_messages:0,inbox_events:0,documents:0})}
  finally {await f.db.admin.query('DROP TRIGGER reject_cancellation_email_fixture ON atrium.operational_documents; DROP FUNCTION public.reject_cancellation_email_fixture()')}
})

test('revoked original staff authority blocks another operator from using its permission', async () => {
  const saved=await admitted('staff-a')
  await f.db.admin.query("UPDATE atrium.property_grants SET status='revoked',permission_version=permission_version+1 WHERE membership_id='member-staff-a' AND property_id='property-a1'")
  const result=await processEmail(saved.id);assert.equal(result.body.confirmation.state,'needs_review');assert.equal(posts().length,0)
})

test('expired permission is not a fresh sending instruction', async () => {
  f.flags.clockOffset=-2*3600000;const saved=await admitted();f.flags.clockOffset=0
  const result=await processEmail(saved.id);assert.equal(result.body.confirmation.state,'needs_review');assert.equal(result.body.confirmation.code,'email_consent_expired');assert.equal(posts().length,0)
})

test('different sender after admission refuses first dispatch', async () => {
  const saved=await admitted();await configuration(p=>{p.tourCancellationEmail.from='Changed <changed@example.test>'})
  const result=await processEmail(saved.id);assert.equal(result.body.confirmation.state,'needs_review');assert.equal(posts().length,0)
})

test('a mismatched provider recipient cannot be called delivered', async () => {
  const saved=await admitted();await processEmail(saved.id);await f.due();f.flags.wrongRecipient=true
  const result=await processEmail(saved.id);assert.equal(result.body.confirmation.state,'needs_review');assert.equal(result.body.confirmation.delivery,'not_verified');assert.equal(posts().length,1)
})

test('accepted or opened provider status is not proof of delivered or read email', async () => {
  const saved=await admitted();await processEmail(saved.id)
  for(const event of ['sent','opened']) {await f.due();f.flags.providerEvent=event;const result=await processEmail(saved.id);assert.equal(result.body.confirmation.delivery,'not_verified')}
  f.flags.providerEvent='delivered';await f.due();assert.equal((await processEmail(saved.id)).body.confirmation.delivery,'delivered');assert.equal(posts().length,1)
})

test('Work queue verification uses the cancellation purpose and cannot initiate a first send', async () => {
  const saved=await admitted()
  // Read the public revision from the same queued action that the portal exposes.
  const listing=await f.request({path:'/api/workflows',query:'?state=all'})
  assert.equal(listing.status,200);const row=listing.body.actions.find(row=>row.id===saved.actionId);assert.ok(row)
  assert.equal((await f.request({path:'/api/email-reconciliation',body:{actionId:row.id,expectedRevision:row.revision}})).status,409)
  await processEmail(saved.id);await f.due()
  const current=(await f.request({path:'/api/workflows',query:'?state=all'})).body.actions.find(row=>row.id===saved.actionId)
  const result=await f.request({path:'/api/email-reconciliation',body:{actionId:current.id,expectedRevision:current.revision}})
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.action.state,'succeeded');assert.equal(result.body.verificationOnly,true);assert.equal(posts().length,1)
})

test('after provider acceptance verification checks original frozen content despite later source corrections', async () => {
  const saved=await admitted();await processEmail(saved.id);const state=await f.calendar()
  state.cancelledBookings[0].booking.prospectEmail='new@example.test';await f.saveCalendar(state);await f.due()
  const verified=await processEmail(saved.id);assert.equal(verified.body.confirmation.delivery,'delivered');assert.equal(posts().length,1)
  const read=await f.request();assert.equal(read.body.ready,false);assert.equal(read.body.priorConfirmation.recipient,f.booking.prospectEmail)
})

test('damaged record or purpose index is held instead of creating a replacement message', async () => {
  const saved=await admitted()
  await f.db.admin.query("UPDATE atrium.operational_documents SET value=jsonb_set(value,'{actorId}','\"different-actor\"') WHERE key=$1",['tour-cancellation-email:'+saved.id])
  assert.equal((await f.request()).status,409);assert.equal((await processEmail(saved.id)).status,409);assert.equal(posts().length,0)
})

test('HTML in stored names is escaped and internal cancellation notes are never disclosed', async () => {
  const state=await f.calendar();state.cancelledBookings[0].booking.prospectName='<img src=x onerror=alert(1)>';await f.saveCalendar(state)
  const saved=await admitted();await processEmail(saved.id)
  assert.equal(posts().length,1);assert.match(posts()[0].message.html,/&lt;img/);assert.doesNotMatch(posts()[0].message.html,/<img|Internal staff reason/)
})

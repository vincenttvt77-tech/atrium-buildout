import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import handler from '../../api/vapi.ts'
import dashboard from '../../api/dashboard.ts'
import tourConfirmations from '../../api/tour-confirmations.ts'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { PostgresCalendarStore } from '../../src/database/operations.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { prepareUnitBlock } from '../../src/calendar/unit-blocks.ts'
import { localDate } from '../../src/calendar/time.ts'

const env = { ...process.env }, originalFetch = globalThis.fetch
const secret = 'synthetic-voice-email-webhook-secret-only'
let db, runtime, server, provider, origin, providerOrigin, dropProviderReply = false, dropToolReply = false
const effects = new Map(), posts = [], errors = []
let staffCookie, onProviderSend = null, wrongReadback = false
const stamp = new Date(), sourceAt = new Date(stamp.getTime() - 10000).toISOString()
const scopes = [['organization-a','property-a1'],['organization-b','property-b1']]
function bundle(org,property) {
  return { property: { id:property, organizationId:org, buildingName:'Synthetic Leasing', address:'1 Synthetic Avenue', timeZone:property === 'property-a1' ? 'America/New_York' : 'America/Los_Angeles', jurisdiction:'NY',
    tourSettings:{...defaultSettings(),minimumNoticeMinutes:0,bookingWindowDays:null,hours:Object.fromEntries([0,1,2,3,4,5,6].map(day=>[day,{openHour:0,closeHour:24}]))},
    voiceTourConfirmation:{ enabled:true,organizationId:org,propertyId:property,reviewExpiresAt:new Date(stamp.getTime()+86400000).toISOString() },
    publicShortlistWebsite:{ format:'atrium-shortlist-v1', organizationId:org,propertyId:property,inventorySource:'synthetic-email',
      baseUrl:`https://${property}.example.test/`,reviewedAt:sourceAt,reviewExpiresAt:new Date(stamp.getTime()+86400000).toISOString() },
    tourConfirmationEmail:{ provider:'resend',organizationId:org,propertyId:property,from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',reviewExpiresAt:new Date(stamp.getTime()+86400000).toISOString() } },
    inventory:['4A','9L'].map(unitId => ({ unitId,propertyId:property,floorPlanId:'one',floor:4,monthlyRent:3000,availableFrom:stamp.toISOString().slice(0,10),status:'available' })),
    floorplans:[{ id:'one',bedrooms:1,bathrooms:1,sqft:700 }],knowledge:[] }
}
before(async () => {
  db = await createFoundationTestDatabase(); db.app.pool.options.max=3; const {password}=await seedFoundationTestDatabase(db.admin)
  runtime = createDatabaseRuntime({ app:db.app,auth:db.auth,sessionSecret:'synthetic-voice-email-session-secret-long-enough',authOrigin:TEST_AUTH_ORIGIN })
  await db.admin.query("INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities) VALUES('channel-b','vapi','synthetic-assistant-b','organization-b','property-b1','active',ARRAY['read','operate'])")
  for (const [org,property] of scopes) {
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES($1,$2,1,'published',$3,$4,'synthetic-email',$4)`,[org,property,JSON.stringify(bundle(org,property)),sourceAt])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2',[org,property])
  }
  provider = createServer(async (req,res) => {
    try {
      if (req.method === 'POST' && req.url === '/emails') {
        let body = ''; for await (const chunk of req) body += chunk
        const id = randomUUID(), value = JSON.parse(body)
        posts.push({ key:req.headers['idempotency-key'],value }); effects.set(id,value);await onProviderSend?.()
        if (dropProviderReply) { req.socket.destroy(); return }
        res.setHeader('content-type','application/json'); res.end(JSON.stringify({id})); return
      }
      const id = req.url.split('/').at(-1), value = effects.get(id)
      res.setHeader('content-type','application/json')
      if (!value) { res.statusCode=404; res.end('{}'); return }
      res.end(JSON.stringify({ object:'email',id,...value,cc:[],bcc:[],reply_to:value.reply_to??[],last_event:'delivered',...(wrongReadback?{to:['foreign@example.test']}: {}) }))
    } catch(error) { errors.push(error); res.statusCode=500; res.end('{}') }
  })
  provider.listen(0,'127.0.0.1'); await once(provider,'listening'); providerOrigin=`http://127.0.0.1:${provider.address().port}`
  globalThis.fetch = (url,options) => {
    const target = new URL(String(url)); assert.equal(target.origin,'https://api.resend.com','No live provider calls')
    return originalFetch(providerOrigin+target.pathname,options)
  }
  process.env.ATRIUM_RUNTIME_MODE='postgres'; process.env.VAPI_WEBHOOK_SECRET=secret; process.env.RESEND_API_KEY='synthetic-email-provider-key'
  server=createServer(async (req,res) => {
    try {
      req.atriumRuntime=runtime; let body=''; for await (const chunk of req) body+=chunk; req.body=body
      const url=new URL(req.url,'http://localhost');req.query=Object.fromEntries(url.searchParams)
      res.send=value=>{res.end(value);return res}
      res.status=code=>{res.statusCode=code;return res}
      res.json=value=>{ if(dropToolReply){dropToolReply=false;req.socket.destroy();return res} res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return res }
      if(req.url.startsWith('/api/dashboard'))await dashboard(req,res)
      else if(req.url.startsWith('/api/tour-confirmations'))await tourConfirmations(req,res)
      else await handler(req,res)
    } catch(error) {errors.push(error);res.statusCode=500;res.end('{}')}
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`
  const login=await originalFetch(origin+'/api/dashboard',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'owner-a',password})})
  assert.equal(login.status,303);staffCookie=login.headers.get('set-cookie').split(';')[0];await login.text();await verifyMfaCookie(runtime,staffCookie,password)
})
beforeEach(async()=>{
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,atrium.operational_documents,atrium.calendars')
  await db.admin.query("UPDATE atrium.channel_bindings SET status='active',capabilities=ARRAY['read','operate'] WHERE id IN ('channel-a','channel-b')")
  for(const [org,property] of scopes) await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2',[org,property])
  posts.length=0;effects.clear();errors.length=0;dropProviderReply=false;dropToolReply=false;onProviderSend=null;wrongReadback=false;process.env.RESEND_API_KEY='synthetic-email-provider-key'
})
after(async()=>{
  globalThis.fetch=originalFetch
  for(const key of ['ATRIUM_RUNTIME_MODE','VAPI_WEBHOOK_SECRET','RESEND_API_KEY']) { if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key] }
  for(const s of [server,provider]) if(s){s.close();s.closeAllConnections();await once(s,'close')}
  await db?.close()
})
const tool=(name,args,id=randomUUID())=>({ id,name,arguments:args })
const initial=[{role:'user',message:'I would like to tour Residence 4A. My email is visitor@example.test.'}]
const consent=(offer,reply='Yes, please.')=>[...initial,{role:'bot',message:offer.question},{role:'user',message:reply}]
async function post(tools,{callId='email-call',assistant='synthetic-assistant-a',messages=initial,headers={},message={}}={}) {
  const response=await originalFetch(origin+'/api/vapi',{method:'POST',headers:{'content-type':'application/json','x-vapi-secret':secret,...headers},
    body:JSON.stringify({message:{type:'tool-calls',call:{id:callId,assistantId:assistant,customer:{number:'+12025550101'}},toolCallList:tools,artifact:{messages},...message}})})
  const body=await response.json();return{status:response.status,body,text:body.results?.[0]?.result}
}
const email=(action,offer,opts={})=>post([tool('email_tour_confirmation',{action,...(offer?{offerId:offer.offerId}:{})})],opts)
async function book(opts={}) {
  await post([tool('capture_contact',{name:'Test Visitor',email:'visitor@example.test',excerpt:'My name is Test Visitor and my email is visitor@example.test'})],opts)
  const slots=await post([tool('list_tour_slots',{unitId:'4A',preferredDate:new Date(Date.now()+2*86400000).toISOString().slice(0,10)})],opts)
  const slotId=slots.text.match(/slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)?.[0];assert.ok(slotId,slots.text)
  const booked=await post([tool('book_tour',{slotId,unitId:'4A',prospectName:'Test Visitor',prospectEmail:'visitor@example.test'})],opts)
  assert.match(booked.text,/confirmation email is available/,booked.text)
  return (await db.admin.query('SELECT state FROM atrium.calendars WHERE property_id=$1',[opts.assistant==='synthetic-assistant-b'?'property-b1':'property-a1'])).rows[0].state.bookings[0]
}
async function prepare(opts={}) {
  await book(opts)
  const response=await email('prepare',null,opts);assert.equal(response.status,200)
  const value=JSON.parse(response.text);assert.equal(value.status,'permission_required');assert.equal(posts.length,0);return value
}
async function staff(booking,body) {
  const response=await originalFetch(origin+'/api/tour-confirmations'+(body?'':'?externalId='+encodeURIComponent(booking.externalId)),{
    method:body?'POST':'GET',headers:{cookie:staffCookie,'x-atrium-organization-id':'organization-a','x-atrium-property-id':'property-a1','x-atrium-config-version':'1',origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  return {status:response.status,body:await response.json()}
}
async function calendarChange(change){const row=(await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0];change(row.state);await db.admin.query("UPDATE atrium.calendars SET state=$1 WHERE property_id='property-a1'",[JSON.stringify(row.state)])}
async function callChange(change){const row=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-a1' AND key='call:email-call'")).rows[0];change(row.value);await db.admin.query("UPDATE atrium.operational_documents SET value=$1 WHERE property_id='property-a1' AND key='call:email-call'",[JSON.stringify(row.value)])}
async function countActions(){return(await db.admin.query('SELECT count(*)::int n FROM atrium.action_intents')).rows[0].n}
async function publishNext(configuration,readAt=sourceAt){
  const version=Number((await db.admin.query("SELECT max(version) n FROM atrium.property_configurations WHERE property_id='property-a1'")).rows[0].n)+1
  await db.admin.query("INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at) VALUES('organization-a','property-a1',$1,'published',$2,$3,'synthetic-email',now())",[version,JSON.stringify(configuration),readAt])
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=$1 WHERE id='property-a1'",[version])
}

test('real webhook books, obtains spoken permission, sends once and shares delivery with the staff calendar',async()=>{
  const booking=await book(), offer=JSON.parse((await email('prepare')).text)
  assert.equal(offer.status,'permission_required');assert.match(offer.question,/visitor at example dot test/)
  assert.equal(posts.length,0)
  const accepted=await email('send',offer,{messages:consent(offer)})
  assert.equal(JSON.parse(accepted.text).status,'accepted',accepted.text)
  assert.equal(posts.length,1);assert.deepEqual(posts[0].value.to,['visitor@example.test'])
  assert.match(posts[0].value.html,/Residence 4A/);assert.match(posts[0].value.html,/1 Synthetic Avenue/)
  assert.match(posts[0].value.html,/America\/New_York/);assert.doesNotMatch(posts[0].value.html,/property-b1|synthetic-email-provider-key/)
  const staffView=await staff(booking);assert.equal(staffView.status,200);assert.equal(staffView.body.confirmation.delivery,'not_verified')
  await delay(1100)
  assert.equal(JSON.parse((await email('status',offer)).text).status,'delivered')
  assert.equal((await staff(booking)).body.confirmation.delivery,'delivered')
  const again=await staff(booking,{action:'queue',externalId:booking.externalId,bookingSha256:staffView.body.preview.bookingSha256,permissionConfirmed:true})
  assert.equal(again.status,200);assert.equal(again.body.confirmation.id,staffView.body.confirmation.id)
  assert.equal(await countActions(),1);assert.equal(posts.length,1);assert.deepEqual(errors,[])
  const receipt=(await db.admin.query('SELECT payload FROM atrium.inbox_events')).rows[0].payload
  assert.match(receipt.permissionSha256,/^[a-f0-9]{64}$/);assert.equal(receipt.evidenceSource,'authenticated_vapi_artifact_question_reply')
})

test('refusals, unrelated yes, missing artifacts and model-injected permission cannot send',async()=>{
  const offer=await prepare()
  for(const messages of [null,[],consent(offer,'No thank you'),consent(offer,'Yes, but use a different email'),consent(offer,'Yes?'),
    [...initial,{role:'bot',message:'Is that your budget?'},{role:'user',message:'Yes'}]]) {
    const response=await email('send',offer,{messages});assert.equal(response.status,200);assert.doesNotMatch(response.text,/"status":"accepted"/)
  }
  const injected=await post([tool('email_tour_confirmation',{action:'send',offerId:offer.offerId,consent:true,email:'other@example.test'})])
  assert.match(injected.text,/Use the prepared/);assert.equal(await countActions(),0);assert.equal(posts.length,0)
})

test('permission for an earlier preparation cannot authorize a replacement offer',async()=>{
  const first=await prepare(), newer=JSON.parse((await email('prepare',null,{messages:consent(first)})).text)
  assert.notEqual(newer.offerId,first.offerId)
  assert.match((await email('send',first,{messages:consent(first)})).text,/unavailable/)
  assert.match((await email('send',newer,{messages:consent(first)})).text,/new permission/)
  assert.equal(posts.length,0)
})

test('known UUID or caller number grants no permission for another property or call',async()=>{
  const offer=await prepare()
  assert.equal((await email('send',offer,{headers:{'x-vapi-secret':'wrong'},messages:consent(offer)})).status,401)
  const foreign=await prepare({callId:'other-call',assistant:'synthetic-assistant-b'})
  assert.match((await email('send',offer,{callId:'other-call',assistant:'synthetic-assistant-b',messages:consent(offer)})).text,/unavailable/)
  assert.equal(JSON.parse((await email('send',foreign,{callId:'other-call',assistant:'synthetic-assistant-b',messages:consent(foreign)})).text).status,'accepted')
  assert.match(posts[0].value.html,/America\/Los_Angeles/);assert.equal(posts.length,1)
})

for(const kind of ['recipient','revision','time','foreign_call','removed','unit_hold','uncertain'])test(`a ${kind} change invalidates the prepared confirmation without sending`,async()=>{
  const offer=await prepare()
  if(kind==='recipient')await post([tool('capture_contact',{email:'corrected@example.test',excerpt:'Use corrected@example.test instead'})])
  else if(kind==='uncertain')await callChange(call=>{call.booking.status='arranging'})
  else await calendarChange(calendar=>{
    const booking=calendar.bookings[0]
    if(kind==='revision')booking.revision=(booking.revision??0)+1
    if(kind==='time')booking.startsAt=new Date(Date.parse(booking.startsAt)+60000).toISOString()
    if(kind==='foreign_call')booking.interactionId='different-call'
    if(kind==='removed')calendar.bookings=[]
    if(kind==='unit_hold')calendar.unitBlocks=[prepareUnitBlock({requestId:'unit-hold-case',unitId:'4A',date:localDate(new Date(booking.startsAt),'America/New_York'),allDay:true,reason:'Painting'},['4A','9L'],'America/New_York',new Date())]
  })
  const response=await email('send',offer,{messages:consent(offer)})
  assert.equal(response.status,200);assert.doesNotMatch(response.text,/"status":"accepted"/)
  if(kind==='unit_hold')assert.match(response.text,/availability hold/)
  assert.equal(posts.length,0);assert.equal(await countActions(),0)
})

test('a blackout on a different apartment does not prevent this unit confirmation',async()=>{
  const offer=await prepare()
  await calendarChange(calendar=>{calendar.unitBlocks=[prepareUnitBlock({requestId:'other-unit-hold',unitId:'9L',date:localDate(new Date(calendar.bookings[0].startsAt),'America/New_York'),allDay:true,reason:'Painting'},['4A','9L'],'America/New_York',new Date())]})
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted');assert.equal(posts.length,1)
})

test('missing provider and expired, missing or foreign voice opt-in refuse admission',async()=>{
  const offer=await prepare();delete process.env.RESEND_API_KEY
  assert.match((await email('send',offer,{messages:consent(offer)})).text,/not configured/)
  process.env.RESEND_API_KEY='synthetic-email-provider-key'
  for(const mode of ['expired','foreign','missing']){
    const config=bundle('organization-a','property-a1')
    if(mode==='expired')config.property.voiceTourConfirmation.reviewExpiresAt=sourceAt
    if(mode==='foreign')config.property.voiceTourConfirmation.propertyId='property-b1'
    if(mode==='missing')delete config.property.voiceTourConfirmation
    await publishNext(config)
    assert.match((await email('prepare',null,{callId:'disabled-'+mode})).text,/not configured/)
  }
  assert.equal(posts.length,0);assert.equal(await countActions(),0)
})

test('staff and voice admission racing on one confirmed tour create one durable email',async()=>{
  const booking=await book(), offer=JSON.parse((await email('prepare')).text), preview=(await staff(booking)).body.preview
  const [voice,operator]=await Promise.all([email('send',offer,{messages:consent(offer)}),staff(booking,{action:'queue',externalId:booking.externalId,bookingSha256:preview.bookingSha256,permissionConfirmed:true})])
  assert.equal(voice.status,200);assert.equal(operator.status,200,JSON.stringify(operator.body));assert.equal(await countActions(),1)
  const stored=(await staff(booking)).body.confirmation
  await staff(booking,{action:'process',confirmationId:stored.id})
  assert.equal(posts.length,1)
  // A slower runner may already have reached verification on the previous query.
  // Make that boundary deterministic instead of assuming delivery is still pending.
  await db.admin.query("UPDATE atrium.outbox_messages SET available_at=clock_timestamp() WHERE state='verifying'")
  const repeat=JSON.parse((await email('prepare')).text);assert.equal(repeat.status,'delivered',JSON.stringify(repeat))
  const finalView=await staff(booking)
  assert.equal(finalView.status,200);assert.equal(finalView.body.confirmation.id,stored.id)
  assert.equal(finalView.body.confirmation.delivery,'delivered')
  const action=(await db.admin.query('SELECT state,dispatch_attempts,verification_attempts,evidence FROM atrium.outbox_messages')).rows[0]
  assert.equal(action.state,'succeeded');assert.equal(action.dispatch_attempts,1)
  assert.equal(Number(action.verification_attempts),1);assert.equal(action.evidence.deliveryStatus,'delivered')
  assert.equal(posts.length,1);assert.equal(await countActions(),1)
})

test('duplicate tools and a lost webhook response do not send a second email',async()=>{
  const offer=await prepare(), command=tool('email_tour_confirmation',{action:'send',offerId:offer.offerId})
  dropToolReply=true
  await assert.rejects(post([command],{messages:consent(offer)}))
  const replay=await post([command],{messages:consent(offer)});assert.equal(JSON.parse(replay.text).status,'accepted')
  await email('send',offer,{messages:consent(offer)})
  assert.equal(posts.length,1);assert.equal(await countActions(),1)
})

test('lost provider acknowledgement remains unconfirmed and is never blindly resent',async()=>{
  const offer=await prepare();dropProviderReply=true
  const sent=JSON.parse((await email('send',offer,{messages:consent(offer)})).text)
  assert.equal(sent.status,'unconfirmed');assert.equal(posts.length,1)
  await delay(1100);await email('status',offer);await email('send',offer,{messages:consent(offer)})
  assert.equal(posts.length,1);assert.equal(await countActions(),1)
})

test('provider mismatched recipient is held for review rather than called delivered',async()=>{
  const offer=await prepare();await email('send',offer,{messages:consent(offer)});wrongReadback=true
  await delay(1100);const checked=JSON.parse((await email('status',offer)).text)
  assert.equal(checked.status,'needs_review');assert.match(checked.say,/Delivery is not confirmed/);assert.equal(posts.length,1)
})

test('revoked channel after preparation cannot send',async()=>{
  const offer=await prepare()
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive',permission_version=permission_version+1 WHERE id='channel-a'")
  assert.notEqual((await email('send',offer,{messages:consent(offer)})).status,200)
  assert.equal(await countActions(),0);assert.equal(posts.length,0)
})

test('booking without an email succeeds but cannot send a guessed confirmation',async()=>{
  const slots=await post([tool('list_tour_slots',{unitId:'4A'})])
  const slotId=slots.text.match(/slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)[0]
  const booked=await post([tool('book_tour',{slotId,unitId:'4A',prospectName:'Test Visitor'})])
  assert.doesNotMatch(booked.text,/confirmation email is available/)
  const state=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE key='call:email-call'")).rows[0].value
  assert.equal(state.booking.status,'confirmed');assert.equal(state.email,null)
  assert.match((await email('prepare')).text,/details need staff review/);assert.equal(await countActions(),0)
})

test('an expired preparation requires new permission before admission',async()=>{
  const offer=await prepare()
  await db.admin.query("UPDATE atrium.operational_documents SET value=jsonb_set(jsonb_set(value,'{preparedAt}',to_jsonb(to_char(now()-interval '6 minutes','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))),'{expiresAt}',to_jsonb(to_char(now()-interval '1 minute','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE key LIKE 'voice-tour-email:%'")
  assert.match((await email('send',offer,{messages:consent(offer)})).text,/expired/)
  assert.equal(await countActions(),0);assert.equal(posts.length,0)
})

test('a completed call cannot authorize a delayed confirmation; staff can verify an earlier send',async()=>{
  const booking=await book(), offer=JSON.parse((await email('prepare')).text)
  await email('send',offer,{messages:consent(offer)})
  assert.equal((await post([],{message:{type:'end-of-call-report',endedAt:new Date().toISOString(),durationSeconds:30}})).status,200)
  assert.doesNotMatch((await email('send',offer,{messages:consent(offer)})).text??'',/"status":"accepted"/)
  await delay(1100)
  const confirmation=(await staff(booking)).body.confirmation
  const checked=await staff(booking,{action:'process',confirmationId:confirmation.id})
  assert.equal(checked.status,200);assert.equal(checked.body.confirmation.delivery,'delivered');assert.equal(posts.length,1)
})

test('permission, receipt and outbox roll back together if saving the shared confirmation fails',async()=>{
  const offer=await prepare()
  await db.admin.query(`CREATE FUNCTION atrium.test_fail_tour_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key LIKE 'tour-confirmation:%' THEN RAISE EXCEPTION 'synthetic save failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fail_tour_email BEFORE INSERT ON atrium.operational_documents FOR EACH ROW EXECUTE FUNCTION atrium.test_fail_tour_email()`)
  try {
    assert.match((await email('send',offer,{messages:consent(offer)})).text,/could not be verified/)
    assert.equal(await countActions(),0);assert.equal(posts.length,0)
    assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.inbox_events')).rows[0].n,0)
  } finally {await db.admin.query('DROP TRIGGER test_fail_tour_email ON atrium.operational_documents; DROP FUNCTION atrium.test_fail_tour_email()')}
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted');assert.equal(posts.length,1)
})

test('saved but unstarted confirmation stays queued through voice retries and can be processed by staff',async()=>{
  const booking=await book(), offer=JSON.parse((await email('prepare')).text)
  await db.admin.query(`CREATE FUNCTION atrium.test_fail_tour_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state='running' THEN RAISE EXCEPTION 'synthetic claim failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fail_tour_claim BEFORE UPDATE ON atrium.outbox_messages FOR EACH ROW EXECUTE FUNCTION atrium.test_fail_tour_claim()`)
  try {assert.match((await email('send',offer,{messages:consent(offer)})).text,/could not be verified/)}
  finally {await db.admin.query('DROP TRIGGER test_fail_tour_claim ON atrium.outbox_messages; DROP FUNCTION atrium.test_fail_tour_claim()')}
  assert.equal(JSON.parse((await email('status',offer)).text).status,'queued')
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'queued')
  assert.equal(posts.length,0);assert.equal(await countActions(),1)
  const saved=(await staff(booking)).body.confirmation
  const sent=await staff(booking,{action:'process',confirmationId:saved.id})
  assert.equal(sent.status,200);assert.equal(sent.body.confirmation.delivery,'not_verified');assert.equal(posts.length,1)
})

test('a tour changed between dispatch admission and provider IO is rejected without sending',async()=>{
  const offer=await prepare(), original=PostgresWorkflowRepository.prototype.startDispatch
  PostgresWorkflowRepository.prototype.startDispatch=async function(...args){
    const value=await original.apply(this,args)
    await calendarChange(calendar=>{calendar.bookings[0].revision=(calendar.bookings[0].revision??0)+1})
    return value
  }
  try {
    assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'needs_review')
    assert.equal(posts.length,0);assert.equal(await countActions(),1)
  } finally {PostgresWorkflowRepository.prototype.startDispatch=original}
})


test('an email supplied after booking updates the same reservation and requires new permission',async()=>{
  const slots=await post([tool('list_tour_slots',{unitId:'4A',preferredDate:new Date(Date.now()+2*86400000).toISOString().slice(0,10)})])
  const slotId=slots.text.match(/slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)[0]
  await post([tool('book_tour',{slotId,unitId:'4A',prospectName:'Test Visitor'})])
  const before=(await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state.bookings[0]
  const capture=await post([tool('capture_contact',{email:'late@example.test',excerpt:'Email me at late@example.test'})])
  assert.equal(capture.status,200)
  const after=(await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state.bookings
  assert.equal(after.length,1);assert.equal(after[0].externalId,before.externalId)
  assert.equal(after[0].prospectEmail,'late@example.test')
  assert.equal(after[0].startsAt,before.startsAt);assert.equal(after[0].revision,before.revision)
  const offer=JSON.parse((await email('prepare')).text)
  assert.equal(offer.status,'permission_required');assert.match(offer.question,/late at example dot test/)
  assert.equal(posts.length,0)
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted')
  assert.deepEqual(posts[0].value.to,['late@example.test']);assert.equal(posts.length,1)
})

test('changing the saved recipient cannot create a second confirmation for the same reservation revision',async()=>{
  const booking=await book(), offer=JSON.parse((await email('prepare')).text)
  await email('send',offer,{messages:consent(offer)})
  await calendarChange(calendar=>{calendar.bookings[0].prospectEmail='corrected@example.test'})
  const preview=await staff(booking)
  assert.equal(preview.status,200);assert.equal(preview.body.ready,false)
  assert.match(preview.body.reason,/earlier confirmation/i)
  assert.equal(posts.length,1);assert.equal(await countActions(),1)
})


const correct=(emailAddress='corrected@example.test',extra={})=>post([tool('capture_contact',{email:emailAddress,excerpt:'Use '+emailAddress+' instead',...extra})])
const savedCalendar=async(property='property-a1')=>(await db.admin.query('SELECT state FROM atrium.calendars WHERE property_id=$1',[property])).rows[0].state
const savedCall=async()=>(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-a1' AND key='call:email-call'")).rows[0].value
async function queueStaff(booking){const preview=(await staff(booking)).body.preview;return staff(booking,{action:'queue',externalId:booking.externalId,bookingSha256:preview.bookingSha256,permissionConfirmed:true})}

test('correcting contact invalidates old permission and retains original caller identity',async()=>{
  const old=await prepare(), before=await savedCall()
  assert.match((await correct('corrected@example.test',{name:'Corrected Visitor',phone:'+12025550199'})).text,/existing reservation/)
  const saved=await savedCall(), booking=(await savedCalendar()).bookings[0]
  assert.equal(saved.phone,before.phone);assert.equal(booking.prospectPhone,before.phone)
  assert.equal(saved.callbackPhone.value,'+12025550199');assert.equal(booking.prospectName,'Corrected Visitor')
  assert.equal(booking.prospectEmail,saved.email);assert.equal(saved.email,'corrected@example.test')
  assert.match((await email('send',old,{messages:consent(old)})).text,/changed/)
  const fresh=JSON.parse((await email('prepare')).text)
  assert.match((await email('send',fresh,{messages:consent(old)})).text,/permission|question/i)
  assert.equal(posts.length,0)
  assert.equal(JSON.parse((await email('send',fresh,{messages:consent(fresh)})).text).status,'accepted')
  assert.equal(await countActions(),1);assert.equal(posts.length,1)
})

for(const mode of ['accepted','unknown','queued'])test(`a contact correction preserves ${mode} email evidence without a replacement`,async()=>{
  const booking=await book(), offer=JSON.parse((await email('prepare')).text)
  if(mode==='queued')await queueStaff(booking)
  else {dropProviderReply=mode==='unknown';await email('send',offer,{messages:consent(offer)})}
  const sent=posts.length
  assert.match((await correct()).text,/existing reservation/)
  assert.equal((await savedCalendar()).bookings[0].prospectEmail,'corrected@example.test')
  assert.match((await email('prepare')).text,/earlier confirmation/)
  const current=await staff(booking);assert.equal(current.body.ready,false)
  const attempt=await staff(booking,{action:'queue',externalId:booking.externalId,bookingSha256:current.body.preview.bookingSha256,permissionConfirmed:true})
  assert.equal(attempt.status,409);assert.equal(await countActions(),1)
  if(mode!=='queued')await db.admin.query("UPDATE atrium.outbox_messages SET available_at=clock_timestamp() WHERE state='verifying'")
  const status=JSON.parse((await email('status',offer)).text)
  if(mode==='unknown'){assert.ok(['unconfirmed','needs_review'].includes(status.status));assert.match(status.say,/unconfirmed|not confirmed/)}
  else assert.equal(status.status,mode==='accepted'?'delivered':'queued')
  assert.equal(posts.length,sent)
  assert.match(status.say,/original saved email to visitor at example dot test/)
  assert.doesNotMatch(status.say,/corrected at/)
  if(mode==='queued'){
    const id=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE key LIKE 'tour-confirmation:%'")).rows[0].value.id
    await staff(booking,{action:'process',confirmationId:id})
    assert.equal(posts.length,0)
  }
})

test('authorized cancellation before dispatch permits a fresh corrected confirmation with new permission',async()=>{
  const booking=await book();await queueStaff(booking)
  const user=await runtime.authenticate({cookie:staffCookie},new Date())
  const scoped=await runtime.loadUserProperty(user,{organizationId:'organization-a',propertyId:'property-a1'},'configure')
  const repo=new PostgresWorkflowRepository(db.app,scoped.scope,{requestId:randomUUID(),configurationVersion:1})
  const [action]=await repo.list();await repo.cancel(action.id,'correct_recipient',action.revision)
  await correct()
  const offer=JSON.parse((await email('prepare')).text);assert.equal(offer.status,'permission_required')
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted')
  assert.equal(await countActions(),2);assert.equal(posts.length,1);assert.deepEqual(posts[0].value.to,['corrected@example.test'])
})

test('legacy confirmation history without an index or scheduling revision still prevents a replacement',async()=>{
  const booking=await book();await queueStaff(booking)
  await db.admin.query("DELETE FROM atrium.operational_documents WHERE key LIKE 'tour-confirmation-index:%'")
  await db.admin.query("UPDATE atrium.operational_documents SET value=value-'reservationRevision' WHERE key LIKE 'tour-confirmation:%'")
  await correct()
  assert.equal((await staff(booking)).body.ready,false)
  assert.match((await email('prepare')).text,/earlier confirmation/)
  assert.equal(await countActions(),1);assert.equal(posts.length,0)
})

test('a new scheduling revision can receive its own confirmation after the prior revision',async()=>{
  const booking=await book();await queueStaff(booking)
  await calendarChange(calendar=>{calendar.bookings[0].revision=1})
  const preview=await staff(booking);assert.equal(preview.body.ready,true)
  assert.equal((await queueStaff(booking)).status,200);assert.equal(await countActions(),2);assert.equal(posts.length,0)
})

for(const kind of ['foreign_call','changed_time','staff_contact','duplicate','pending'])test(`contact correction refuses a ${kind} reservation and keeps volunteered details for staff`,async()=>{
  await book()
  await calendarChange(calendar=>{
    const row=calendar.bookings[0]
    if(kind==='foreign_call')row.interactionId='different-call'
    if(kind==='changed_time')row.startsAt=new Date(Date.parse(row.startsAt)+3600000).toISOString()
    if(kind==='staff_contact')row.prospectEmail='staff-reviewed@example.test'
    if(kind==='duplicate')calendar.bookings.push({...row})
    if(kind==='pending')row.rescheduleHistory=[{projection:'pending'}]
  })
  const before=await savedCalendar()
  assert.match((await correct()).text,/reservation could not be updated safely/)
  assert.deepEqual(await savedCalendar(),before);assert.equal((await savedCall()).email,'corrected@example.test')
  assert.equal(posts.length,0)
})

test('a failed call-contact write rolls back the calendar and its audit, then a new request can succeed',async()=>{
  await book();const before=await savedCalendar()
  const audit=()=>db.admin.query("SELECT count(*)::int n FROM atrium.audit_events WHERE operation='calendar.update'")
  const n=(await audit()).rows[0].n
  await db.admin.query(`CREATE FUNCTION atrium.test_fail_contact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.value->>'email'='rollback@example.test' THEN RAISE EXCEPTION 'synthetic contact failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fail_contact BEFORE UPDATE ON atrium.operational_documents FOR EACH ROW EXECUTE FUNCTION atrium.test_fail_contact()`)
  try{
    assert.match((await correct('rollback@example.test')).text,/could not verify/)
    assert.deepEqual(await savedCalendar(),before);assert.equal((await savedCall()).email,'visitor@example.test')
    assert.equal((await audit()).rows[0].n,n)
  }finally{await db.admin.query('DROP TRIGGER test_fail_contact ON atrium.operational_documents; DROP FUNCTION atrium.test_fail_contact()')}
  assert.match((await correct('rollback@example.test')).text,/existing reservation/)
  assert.equal((await savedCalendar()).bookings[0].prospectEmail,'rollback@example.test')
})

test('lost contact acknowledgement replays once and cannot overwrite a subsequent correction',async()=>{
  await book();const command=tool('capture_contact',{email:'first@example.test',excerpt:'Use first@example.test'})
  dropToolReply=true;await assert.rejects(post([command]))
  assert.match((await post([command])).text,/existing reservation/)
  await correct('latest@example.test')
  assert.match((await post([command])).text,/existing reservation/)
  assert.equal((await savedCalendar()).bookings[0].prospectEmail,'latest@example.test');assert.equal((await savedCall()).email,'latest@example.test')
  assert.equal(posts.length,0)
})

test('staff queue racing a correction cannot authorize either a stale send or two emails',async()=>{
  const booking=await book(), preview=(await staff(booking)).body.preview
  const [capture,queued]=await Promise.all([correct(),staff(booking,{action:'queue',externalId:booking.externalId,bookingSha256:preview.bookingSha256,permissionConfirmed:true})])
  assert.match(capture.text,/existing reservation/);assert.ok([200,409].includes(queued.status))
  assert.ok(db.app.pool.totalCount>=2)
  const next=await email('prepare')
  if(queued.status===200){assert.match(next.text,/earlier confirmation/);assert.equal(await countActions(),1)}
  else{const offer=JSON.parse(next.text);await email('send',offer,{messages:consent(offer)});assert.equal(posts.length,1);assert.equal(await countActions(),1)}
})

test('identical call and caller IDs in another organization never receive the correction',async()=>{
  await book();await book({assistant:'synthetic-assistant-b'})
  const other=await savedCalendar('property-b1');await correct()
  assert.deepEqual(await savedCalendar('property-b1'),other)
  assert.equal((await savedCalendar()).bookings[0].prospectEmail,'corrected@example.test')
  const unrelated=await correct('unrelated@example.test')
  assert.match(unrelated.text,/existing reservation/);assert.equal(posts.length,0)
})

test('a previously admitted correction completes before a racing call end projects its lead',async()=>{
  await book();const original=PostgresCalendarStore.prototype.transaction;let ending
  PostgresCalendarStore.prototype.transaction=async function(work){
    PostgresCalendarStore.prototype.transaction=original
    ending=await post([],{message:{type:'end-of-call-report',endedAt:new Date().toISOString(),durationSeconds:30}})
    return original.call(this,work)
  }
  try{assert.match((await correct()).text,/existing reservation/)}finally{PostgresCalendarStore.prototype.transaction=original}
  assert.equal(ending.status,503);assert.equal(ending.body.code,'call_work_unresolved')
  assert.ok((await savedCall()).completedAt)
  const lead=(await db.admin.query("SELECT value FROM atrium.operational_documents WHERE property_id='property-a1' AND key='lead:+12025550101'")).rows[0].value
  assert.equal(lead.email,'corrected@example.test')
  assert.equal((await savedCalendar()).bookings[0].prospectEmail,'corrected@example.test')
})

test('booking and then capturing a missing email in the same admitted batch preserves read-back',async()=>{
  const slots=await post([tool('list_tour_slots',{unitId:'4A'})])
  const slotId=slots.text.match(/slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)[0]
  const response=await post([tool('book_tour',{slotId,unitId:'4A',prospectName:'Test Visitor'}),tool('capture_contact',{email:'same-batch@example.test',excerpt:'Use same-batch@example.test'})])
  assert.match(response.body.results[1].result,/existing reservation/)
  assert.equal((await savedCalendar()).bookings[0].prospectEmail,'same-batch@example.test')
  assert.equal((await savedCall()).booking.status,'confirmed')
  assert.equal(JSON.parse((await email('prepare')).text).status,'permission_required')
})


test('confirmation index failure rolls permission, action and confirmation back together',async()=>{
  const offer=await prepare()
  await db.admin.query(`CREATE FUNCTION atrium.test_fail_confirmation_index() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key LIKE 'tour-confirmation-index:%' THEN RAISE EXCEPTION 'synthetic index failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fail_confirmation_index BEFORE INSERT ON atrium.operational_documents FOR EACH ROW EXECUTE FUNCTION atrium.test_fail_confirmation_index()`)
  try{
    assert.match((await email('send',offer,{messages:consent(offer)})).text,/could not be verified/)
    assert.equal(await countActions(),0);assert.equal(posts.length,0)
    assert.equal((await db.admin.query("SELECT count(*)::int n FROM atrium.operational_documents WHERE key LIKE 'tour-confirmation:%'")).rows[0].n,0)
  }finally{await db.admin.query('DROP TRIGGER test_fail_confirmation_index ON atrium.operational_documents; DROP FUNCTION atrium.test_fail_confirmation_index()')}
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted')
  assert.equal(posts.length,1)
})

test('invalid confirmation index cannot hide an earlier confirmation and enable sending',async()=>{
  const booking=await book();await queueStaff(booking);await correct()
  await db.admin.query("UPDATE atrium.operational_documents SET value=jsonb_set(value,'{externalId}','\"foreign-reservation\"') WHERE key LIKE 'tour-confirmation-index:%'")
  assert.match((await email('prepare')).text,/history needs administrator review/)
  assert.equal((await staff(booking)).status,409);assert.equal(posts.length,0);assert.equal(await countActions(),1)
})


test('legacy lookup is exact, property-scoped, and expires with its owning transaction',async()=>{
  const booking=await book();await queueStaff(booking)
  const own=(await db.admin.query("SELECT key FROM atrium.operational_documents WHERE property_id='property-a1' AND key LIKE 'tour-confirmation:%'")).rows[0].key
  await db.admin.query("INSERT INTO atrium.operational_documents(organization_id,property_id,key,value) VALUES('organization-b','property-b1','tour-confirmation:foreign',$1),('organization-a','property-a1','tour-confirmation:unrelated',$2)",
    [JSON.stringify({externalId:booking.externalId}),JSON.stringify({externalId:'another-reservation'})])
  const scoped=await runtime.loadChannel('vapi','synthetic-assistant-a')
  const repo=new PostgresWorkflowRepository(db.app,scoped.scope,{requestId:randomUUID(),configurationVersion:1})
  let retained
  await repo.transaction(async unit=>{
    retained=unit
    assert.deepEqual(await unit.tourConfirmationKeys(booking.externalId),[own])
    assert.deepEqual(await unit.tourConfirmationKeys("% OR '1'='1"),[])
  })
  await assert.rejects(retained.tourConfirmationKeys(booking.externalId),/closed/)
})


test('an older writer missing from an existing index cannot hide another saved confirmation',async()=>{
  const booking=await book();const first=(await queueStaff(booking)).body.confirmation
  const user=await runtime.authenticate({cookie:staffCookie},new Date())
  const scoped=await runtime.loadUserProperty(user,{organizationId:'organization-a',propertyId:'property-a1'},'configure')
  const repo=new PostgresWorkflowRepository(db.app,scoped.scope,{requestId:randomUUID(),configurationVersion:1})
  const [action]=await repo.list();await repo.cancel(action.id,'correct_recipient',action.revision)
  await correct('second@example.test');await queueStaff(booking)
  await db.admin.query("UPDATE atrium.operational_documents SET value=jsonb_set(value,'{ids}',$1::jsonb) WHERE key LIKE 'tour-confirmation-index:%'",[JSON.stringify([first.id])])
  await correct('third@example.test')
  assert.match((await email('prepare')).text,/earlier confirmation/)
  assert.equal((await staff(booking)).body.ready,false)
  assert.equal(await countActions(),2);assert.equal(posts.length,0)
})

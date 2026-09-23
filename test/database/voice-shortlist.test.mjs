import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import handler from '../../api/vapi.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { defaultSettings } from '../../src/calendar/settings.ts'

const env = { ...process.env }, originalFetch = globalThis.fetch
const secret = 'synthetic-voice-email-webhook-secret-only'
let db, runtime, server, provider, origin, providerOrigin, dropProviderReply = false, dropToolReply = false
const effects = new Map(), posts = [], errors = []
const stamp = new Date(), sourceAt = new Date(stamp.getTime() - 10000).toISOString()
const scopes = [['organization-a','property-a1'],['organization-b','property-b1']]
function bundle(org,property) {
  return { property: { id:property, organizationId:org, buildingName:'Synthetic Leasing', timeZone:property === 'property-a1' ? 'America/New_York' : 'America/Los_Angeles', jurisdiction:'NY',
    tourSettings:defaultSettings(),
    publicShortlistWebsite:{ format:'atrium-shortlist-v1', organizationId:org,propertyId:property,inventorySource:'synthetic-email',
      baseUrl:`https://${property}.example.test/`,reviewedAt:sourceAt,reviewExpiresAt:new Date(stamp.getTime()+86400000).toISOString() },
    voiceShortlistEmail:{ provider:'resend',organizationId:org,propertyId:property,from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',reviewExpiresAt:new Date(stamp.getTime()+86400000).toISOString() } },
    inventory:['4A','9L'].map(unitId => ({ unitId,propertyId:property,floorPlanId:'one',floor:4,monthlyRent:3000,availableFrom:stamp.toISOString().slice(0,10),status:'available' })),
    floorplans:[{ id:'one',bedrooms:1,bathrooms:1,sqft:700 }],knowledge:[] }
}
before(async () => {
  db = await createFoundationTestDatabase(); await seedFoundationTestDatabase(db.admin)
  runtime = createDatabaseRuntime({ app:db.app,auth:db.auth,sessionSecret:'synthetic-voice-email-session-secret-long-enough' })
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
        posts.push({ key:req.headers['idempotency-key'],value }); effects.set(id,value)
        if (dropProviderReply) { req.socket.destroy(); return }
        res.setHeader('content-type','application/json'); res.end(JSON.stringify({id})); return
      }
      const id = req.url.split('/').at(-1), value = effects.get(id)
      res.setHeader('content-type','application/json')
      if (!value) { res.statusCode=404; res.end('{}'); return }
      res.end(JSON.stringify({ object:'email',id,...value,cc:[],bcc:[],reply_to:value.reply_to??[],last_event:'delivered' }))
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
      res.status=code=>{res.statusCode=code;return res}
      res.json=value=>{ if(dropToolReply){dropToolReply=false;req.socket.destroy();return res} res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return res }
      await handler(req,res)
    } catch(error) {errors.push(error);res.statusCode=500;res.end('{}')}
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`
})
beforeEach(async()=>{
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,atrium.operational_documents,atrium.calendars')
  await db.admin.query("UPDATE atrium.channel_bindings SET status='active',capabilities=ARRAY['read','operate'] WHERE id IN ('channel-a','channel-b')")
  for(const [org,property] of scopes) await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2',[org,property])
  posts.length=0;effects.clear();errors.length=0;dropProviderReply=false;dropToolReply=false;process.env.RESEND_API_KEY='synthetic-email-provider-key'
})
after(async()=>{
  globalThis.fetch=originalFetch
  for(const key of ['ATRIUM_RUNTIME_MODE','VAPI_WEBHOOK_SECRET','RESEND_API_KEY']) { if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key] }
  for(const s of [server,provider]) if(s){s.close();s.closeAllConnections();await once(s,'close')}
  await db?.close()
})
const tool=(name,args,id=randomUUID())=>({ id,name,arguments:args })
const initial=[{role:'user',message:'Please email the apartment options to visitor@example.test.'}]
const consent=(offer,reply='Yes, please.')=>[...initial,{role:'bot',message:offer.question},{role:'user',message:reply}]
async function post(tools,{callId='email-call',assistant='synthetic-assistant-a',messages=initial,headers={},message={}}={}) {
  const response=await originalFetch(origin+'/api/vapi',{method:'POST',headers:{'content-type':'application/json','x-vapi-secret':secret,...headers},
    body:JSON.stringify({message:{type:'tool-calls',call:{id:callId,assistantId:assistant,customer:{number:'+12025550101'}},toolCallList:tools,artifact:{messages},...message}})})
  const body=await response.json();return{status:response.status,body,text:body.results?.[0]?.result}
}
const email=(action,offer,opts={})=>post([tool('email_shortlist',{action,...(offer?{offerId:offer.offerId}:{})})],opts)
async function prepare(opts={}) {
  const start=await post([tool('capture_contact',{email:'visitor@example.test',excerpt:'My email is visitor@example.test'}),tool('check_availability',{unitId:'4A'})],opts)
  assert.equal(start.status,200,JSON.stringify(start.body));assert.match(start.body.results[1].result,/ask its exact permission question/)
  const response=await email('prepare',null,opts);assert.equal(response.status,200)
  const value=JSON.parse(response.text);assert.equal(value.status,'permission_required');assert.equal(posts.length,0);return value
}
async function countActions(){return(await db.admin.query('SELECT count(*)::int n FROM atrium.action_intents')).rows[0].n}
async function publishNext(configuration,readAt=sourceAt){
  const version=Number((await db.admin.query("SELECT max(version) n FROM atrium.property_configurations WHERE property_id='property-a1'")).rows[0].n)+1
  await db.admin.query("INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at) VALUES('organization-a','property-a1',$1,'published',$2,$3,'synthetic-email',now())",[version,JSON.stringify(configuration),readAt])
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=$1 WHERE id='property-a1'",[version])
}

test('actual voice webhook prepares, records permission, sends once and verifies the exact email',async()=>{
  const offer=await prepare();assert.match(offer.question,/visitor at example dot test/)
  const sent=await email('send',offer,{messages:consent(offer)})
  assert.equal(sent.status,200);assert.equal(JSON.parse(sent.text).status,'accepted');assert.equal(posts.length,1)
  assert.deepEqual(posts[0].value.to,['visitor@example.test']);assert.match(posts[0].value.html,/property-a1\.example\.test\/.*units=4A/)
  assert.doesNotMatch(posts[0].value.html,/property-b1|synthetic-email-provider-key/)
  await delay(1100)
  const checked=await email('status',offer);assert.equal(JSON.parse(checked.text).status,'delivered')
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'delivered')
  assert.equal(await countActions(),1);assert.equal(posts.length,1);assert.deepEqual(errors,[])
  const receipt=(await db.admin.query('SELECT payload FROM atrium.inbox_events')).rows[0].payload
  assert.match(receipt.permissionSha256,/^[a-f0-9]{64}$/);assert.equal(receipt.evidenceSource,'authenticated_vapi_artifact_question_reply')
})

test('refusal, missing history, unrelated yes and model-supplied consent never dispatch',async()=>{
  const offer=await prepare()
  for(const messages of [undefined,[],consent(offer,'No thanks'),consent(offer,'Yes but not to that address'),[...initial,{role:'bot',message:'Is your budget three thousand?'},{role:'user',message:'Yes'}]]){
    const response=await email('send',offer,{messages:messages??null});assert.equal(response.status,200);assert.doesNotMatch(response.text,/"status":"accepted"/)
  }
  const injected=await post([tool('email_shortlist',{action:'send',offerId:offer.offerId,consent:true,recipient:'other@example.test',artifact:{messages:consent(offer)}})])
  assert.match(injected.text,/Use the prepared/);assert.equal(posts.length,0);assert.equal(await countActions(),0)
})

test('address correction requires a new read-back; old offer cannot send to either address',async()=>{
  const offer=await prepare()
  await post([tool('capture_contact',{email:'corrected@example.test',excerpt:'Use corrected@example.test'})])
  assert.match((await email('send',offer,{messages:consent(offer)})).text,/changed or expired/)
  const revised=JSON.parse((await email('prepare')).text);assert.notEqual(revised.offerId,offer.offerId)
  assert.match(revised.question,/corrected at example dot test/)
  assert.match((await email('send',offer,{messages:consent(offer)})).text,/unavailable/)
  assert.equal(JSON.parse((await email('send',revised,{messages:consent(revised)})).text).status,'accepted')
  assert.deepEqual(posts[0].value.to,['corrected@example.test']);assert.equal(posts.length,1)
})

test('a different or failed apartment search invalidates the prior permission offer',async()=>{
  const offer=await prepare()
  await post([tool('check_availability',{unitId:'9L'})])
  assert.match((await email('send',offer,{messages:consent(offer)})).text,/changed or expired/)
  await post([tool('check_availability',{unitId:'UNKNOWN'})])
  assert.match((await email('prepare')).text,/Check availability/)
  assert.equal(await countActions(),0);assert.equal(posts.length,0)
})

test('property and authenticated channel boundaries reject foreign offers and forged calls',async()=>{
  const offer=await prepare()
  assert.equal((await email('send',offer,{messages:consent(offer),headers:{'x-vapi-secret':'wrong'}})).status,401)
  const other=await prepare({callId:'other-call',assistant:'synthetic-assistant-b'})
  const foreign=await email('send',offer,{callId:'other-call',assistant:'synthetic-assistant-b',messages:consent(offer)})
  assert.match(foreign.text,/unavailable/);assert.doesNotMatch(foreign.text,/property-a1/)
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive',permission_version=permission_version+1 WHERE id='channel-a'")
  assert.notEqual((await email('send',offer,{messages:consent(offer)})).status,200)
  assert.equal(JSON.parse((await email('send',other,{callId:'other-call',assistant:'synthetic-assistant-b',messages:consent(other)})).text).status,'accepted')
  assert.match(posts[0].value.html,/property-b1/);assert.equal(posts.length,1)
})

test('missing provider or wrong/expired sender binding cannot accept an email',async()=>{
  const offer=await prepare();delete process.env.RESEND_API_KEY
  assert.match((await email('send',offer,{messages:consent(offer)})).text,/not configured/)
  process.env.RESEND_API_KEY='synthetic-email-provider-key'
  for(const change of ['foreign','expired','missing']){
    const changed=bundle('organization-a','property-a1')
    if(change==='foreign')changed.property.voiceShortlistEmail.propertyId='property-b1'
    if(change==='expired')changed.property.voiceShortlistEmail.reviewExpiresAt=sourceAt
    if(change==='missing')delete changed.property.voiceShortlistEmail
    await publishNext(changed)
    assert.match((await email('prepare',null,{callId:'missing-'+change})).text,/not configured/)
  }
  assert.equal(posts.length,0);assert.equal(await countActions(),0)
})

test('stale inventory, expired offer and damaged saved state never become sends',async()=>{
  const offer=await prepare()
  await publishNext(bundle('organization-a','property-a1'),new Date(Date.now()-3600000).toISOString())
  const changed=await email('send',offer,{messages:consent(offer)})
  assert.notEqual(changed.status,200,'changed configuration closes admission on the old call')
  await post([tool('capture_contact',{email:'visitor@example.test',excerpt:'visitor@example.test'}),tool('check_availability',{unitId:'4A'})],{callId:'stale-inventory'})
  assert.match((await email('prepare',null,{callId:'stale-inventory'})).text,/Check availability/)
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  const record=(await db.admin.query("SELECT key,value FROM atrium.operational_documents WHERE key LIKE 'voice-shortlist-email:%'")).rows[0]
  for(const patch of [{preparedAt:'bad',expiresAt:'bad'}, {preparedAt:new Date(Date.now()-600000).toISOString(),expiresAt:new Date(Date.now()-300000).toISOString()}, {question:'Is that your email address?'}]){
    await db.admin.query('UPDATE atrium.operational_documents SET value=$2 WHERE key=$1',[record.key,JSON.stringify({...record.value,...patch})])
    assert.doesNotMatch((await email('send',offer,{messages:consent(offer)})).text,/"status":"accepted"/)
  }
  assert.equal(posts.length,0);assert.equal(await countActions(),0)
})

test('dropped provider acknowledgement remains one uncertain send across new tool requests',async()=>{
  const offer=await prepare();dropProviderReply=true
  const sent=await email('send',offer,{messages:consent(offer)});assert.equal(JSON.parse(sent.text).status,'unconfirmed')
  await delay(1100)
  for(const action of ['status','send','prepare']){
    const response=await email(action,action==='prepare'?null:offer,{messages:consent(offer)})
    assert.ok(['unconfirmed','needs_review'].includes(JSON.parse(response.text).status))
  }
  assert.equal(posts.length,1);assert.equal(await countActions(),1)
})

test('lost webhook reply recovers the same durable email without a replacement',async()=>{
  const offer=await prepare();dropToolReply=true
  await assert.rejects(email('send',offer,{messages:consent(offer)}))
  await delay(1100)
  assert.equal(JSON.parse((await email('status',offer)).text).status,'delivered')
  assert.equal(posts.length,1);assert.equal(await countActions(),1)
})

test('concurrent sends admit one action and provider submission',async()=>{
  const offer=await prepare()
  const responses=await Promise.all(Array.from({length:3},()=>email('send',offer,{messages:consent(offer)})))
  assert.ok(responses.some(r=>r.status===200&&r.text?.includes('accepted')))
  assert.equal(await countActions(),1);assert.equal(posts.length,1)
})

test('receipt and consent record rollback together when saving the admitted offer fails',async()=>{
  const offer=await prepare()
  await db.admin.query(`CREATE FUNCTION atrium.test_fail_voice_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key LIKE 'voice-shortlist-email:%' AND NEW.value->>'actionId' IS NOT NULL THEN RAISE EXCEPTION 'synthetic save failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fail_voice_email BEFORE UPDATE ON atrium.operational_documents FOR EACH ROW EXECUTE FUNCTION atrium.test_fail_voice_email()`)
  try{
    assert.match((await email('send',offer,{messages:consent(offer)})).text,/could not be verified/)
    assert.equal(await countActions(),0);assert.equal(posts.length,0)
    assert.equal((await db.admin.query('SELECT count(*)::int n FROM atrium.inbox_events')).rows[0].n,0)
  }finally{await db.admin.query('DROP TRIGGER test_fail_voice_email ON atrium.operational_documents; DROP FUNCTION atrium.test_fail_voice_email()')}
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted');assert.equal(posts.length,1)
})

test('a known emergency cannot grant email permission',async()=>{
  const offer=await prepare()
  await post([],{message:{type:'transcript',role:'user',transcriptType:'final',transcript:'There is smoke in my apartment'}})
  assert.doesNotMatch((await email('send',offer,{messages:consent(offer)})).text,/"status":"accepted"/)
  assert.equal(posts.length,0);assert.equal(await countActions(),0)
})

test('fresh preparation after repeating the same search replaces the old offer and history boundary',async()=>{
  const first=await prepare()
  await post([tool('check_availability',{unitId:'4A'})])
  const offer=JSON.parse((await email('prepare')).text)
  assert.notEqual(offer.offerId,first.offerId)
  assert.match((await email('send',first,{messages:consent(first)})).text,/unavailable/)
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted')
  assert.equal(posts.length,1)
})

test('a completed call cannot authorize a delayed permission tool',async()=>{
  const offer=await prepare()
  const end=await post([],{message:{type:'end-of-call-report',endedAt:new Date().toISOString(),durationSeconds:30}})
  assert.equal(end.status,200)
  const response=await email('send',offer,{messages:consent(offer)})
  assert.doesNotMatch(response.text??JSON.stringify(response.body),/"status":"accepted"/)
  assert.equal(posts.length,0);assert.equal(await countActions(),0)
})

async function queuedAfterClaimFailure(){
  const offer=await prepare()
  await db.admin.query(`CREATE FUNCTION atrium.test_fail_voice_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state='running' THEN RAISE EXCEPTION 'synthetic claim failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fail_voice_claim BEFORE UPDATE ON atrium.outbox_messages FOR EACH ROW EXECUTE FUNCTION atrium.test_fail_voice_claim()`)
  try {assert.match((await email('send',offer,{messages:consent(offer)})).text,/could not be verified/)}
  finally {await db.admin.query('DROP TRIGGER test_fail_voice_claim ON atrium.outbox_messages; DROP FUNCTION atrium.test_fail_voice_claim()')}
  assert.equal(await countActions(),1);assert.equal(posts.length,0);return offer
}
test('checking status or preparing again cannot start an email that has not dispatched',async()=>{
  const offer=await queuedAfterClaimFailure()
  assert.equal(JSON.parse((await email('status',offer)).text).status,'queued')
  assert.equal(JSON.parse((await email('prepare')).text).status,'queued');assert.equal(posts.length,0)
  assert.equal(JSON.parse((await email('send',offer,{messages:consent(offer)})).text).status,'accepted')
  assert.equal(posts.length,1);assert.equal(await countActions(),1)
})
test('known contact changes after queue admission stop the first dispatch on recovery',async()=>{
  const offer=await queuedAfterClaimFailure()
  await post([tool('capture_contact',{email:'corrected@example.test',excerpt:'Use corrected@example.test instead'})])
  const response=JSON.parse((await email('send',offer,{messages:consent(offer)})).text)
  assert.equal(response.status,'needs_review');assert.equal(posts.length,0);assert.equal(await countActions(),1)
})

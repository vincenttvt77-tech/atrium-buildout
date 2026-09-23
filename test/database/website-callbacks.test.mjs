import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { callbackFixture } from '../helpers/callback-fixture.mjs'
let f
before(async()=>{f=await callbackFixture()})
beforeEach(async()=>{await f.reset()})
after(async()=>{await f?.close()})
const status=command=>f.request({action:'status',requestId:command.requestId,receiptToken:command.receiptToken})
async function action(){return (await f.db.admin.query('SELECT id FROM atrium.action_intents LIMIT 1')).rows[0]?.id}
async function due(){await f.db.admin.query("UPDATE atrium.outbox_messages SET available_at=clock_timestamp()-interval '1 second'")}

test('public consent reaches a pinned Vapi call and exact readback without exposing private identifiers',async()=>{
  const c=await f.command(),started=Date.now(),result=await f.submit(c)
  assert.equal(result.status,200);assert.equal(result.body.stage,'queued');assert.equal(f.state.posts,1);assert.ok(Date.now()-started<15000,'synthetic request initiation target')
  assert.doesNotMatch(JSON.stringify(result.body),new RegExp(c.phone.replaceAll('+','\\+')+'|'+c.receiptToken+'|'+f.binding.assistantId))
  const call=[...f.state.effects.values()][0];assert.equal(call.assistantVersion,'23');assert.equal(call.assistantId,f.binding.assistantId)
  assert.match(call.assistantOverrides.firstMessage,/returning the call you requested/);assert.match(call.assistantOverrides.firstMessage,/AI.*recorded/)
  assert.equal(call.assistantOverrides.maxDurationSeconds,300)
  assert.ok(Date.parse(call.schedulePlan.latestAt)-Date.parse(call.schedulePlan.earliestAt)<=120000)
  assert.equal((await status(c)).body.stage,'queued');assert.equal(f.state.posts,1)
  const row=(await f.db.admin.query('SELECT input FROM atrium.action_intents')).rows[0]
  assert.match(row.input.consent,/one immediate call/);assert.doesNotMatch(JSON.stringify(row),/synthetic-challenge|receiptToken/)
})
test('parallel identical requests persist one receipt, one budget and one provider call',async()=>{
  const c=await f.command();const results=await Promise.all(Array.from({length:5},()=>f.submit(c)))
  assert.ok(results.every(r=>r.status===200));assert.equal(f.state.posts,1)
  assert.equal((await f.db.admin.query('SELECT count(*) FROM atrium.action_intents')).rows[0].count,'1')
  const rows=(await f.db.admin.query("SELECT value FROM atrium.operational_documents WHERE key='callback-admissions'")).rows
  assert.equal(rows[0].value.length,1)
})
test('a new request id for the same number cannot place a second call',async()=>{
  await f.submit(await f.command());const result=await f.submit(await f.command());assert.equal(result.status,429);assert.equal(f.state.posts,1)
})
test('network and property admission limits commit with requests under concurrency',async()=>{
  const commands=await Promise.all(Array.from({length:5},(_,i)=>f.command({phone:`+1212555012${i}`})))
  const results=await Promise.all(commands.map(c=>f.submit(c)));assert.equal(results.filter(r=>r.status===200).length,3);assert.equal(f.state.posts,3)
})
test('failed challenges and foreign origin cannot dial or persist consent',async()=>{
  const c=await f.command()
  for(const challengeMode of ['failed','hostname']){f.state.challengeMode=challengeMode;assert.equal((await f.submit(c)).status,403)}
  assert.equal((await f.request({action:'bootstrap'},{origin:'https://foreign.example.test'})).status,403)
  assert.equal((await f.request({action:'bootstrap'},{},'?widgetId=website-a&propertyId=property-b1')).status,403)
  assert.equal(f.state.posts,0);assert.equal(await action(),undefined)
})
test('affirmative exact-form consent is mandatory and client routing overrides are rejected',async()=>{
  for(const patch of [{consent:false},{consent:'true'},{assistantId:f.binding.assistantId},{phone:'+442012345678'},{policySha256:'0'.repeat(64)},{name:'{{ injected }}'}]){
    const result=await f.submit(await f.command(patch));assert.ok([400,409].includes(result.status))
  }
  assert.equal(f.state.posts,0);assert.equal(await action(),undefined)
})
test('closed and expired property configuration never queues a later surprise callback',async()=>{
  await f.publish(2,{hours:[{day:(new Date().getUTCDay()+3)%7,start:0,end:1}]})
  const result=await f.submit(await f.command());assert.ok([409,503].includes(result.status));assert.equal(f.state.posts,0)
  await f.publish(3,{reviewExpiresAt:new Date(Date.now()-1000).toISOString()});assert.equal((await f.request({action:'bootstrap'})).status,503)
})
test('lost provider acknowledgement never redials on receipt retries, status checks or recovered leases',async()=>{
  const c=await f.command();f.state.mode='lost';assert.equal((await f.submit(c)).status,200)
  for(let i=0;i<5;i++){await due();await status(c);await f.submit(c)}
  assert.equal(f.state.posts,1);assert.equal(f.state.effects.size,1)
  assert.equal((await status(c)).body.stage,'needs_review')
})
test('missing acknowledgement and readback mismatch never assert connection or tour completion',async()=>{
  const c=await f.command();f.state.mode='missing-id';let result=await f.submit(c);assert.equal(result.body.stage,'checking');assert.equal(f.state.posts,1)
  await f.reset();f.state.mode='mismatch';result=await f.submit(await f.command());assert.equal(result.body.stage,'needs_review');assert.equal(f.state.posts,1)
})
test('public receipt capabilities resist enumeration and request replacement',async()=>{
  const c=await f.command();await f.submit(c)
  assert.equal((await status({...c,receiptToken:'0'.repeat(64)})).status,404)
  assert.equal((await f.submit({...c,phone:'+12125550144'})).status,409);assert.equal(f.state.posts,1)
})
test('revoked website authority and changed publication prevent subsequent provider access',async()=>{
  const c=await f.command();await f.submit(c);const reads=f.state.reads
  await f.db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='website-binding-a'")
  assert.equal((await status(c)).status,403);assert.equal(f.state.reads,reads)
  await f.db.admin.query("UPDATE atrium.channel_bindings SET status='active' WHERE id='website-binding-a'")
  await f.publish(4,{assistantVersion:'24'});assert.equal((await status(c)).status,409);assert.equal(f.state.posts,1)
})
test('admission transaction rolls back consent, budget and outbox together on a document failure',async()=>{
  await f.db.admin.query(`CREATE FUNCTION atrium.test_callback_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key LIKE 'website-callback:%' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$`)
  await f.db.admin.query('CREATE TRIGGER test_callback_fail BEFORE INSERT ON atrium.operational_documents FOR EACH ROW EXECUTE FUNCTION atrium.test_callback_fail()')
  try {assert.equal((await f.submit(await f.command())).status,503);assert.equal(await action(),undefined);assert.equal(f.state.posts,0)}
  finally {await f.db.admin.query('DROP TRIGGER test_callback_fail ON atrium.operational_documents');await f.db.admin.query('DROP FUNCTION atrium.test_callback_fail()')}
})
test('staff queue exposes scoped callback contact and check requires operate, revision and same origin',async()=>{
  const c=await f.command();await f.submit(c)
  const headers={cookie:f.cookies['staff-a'],'x-atrium-organization-id':'organization-a','x-atrium-property-id':'property-a1','x-atrium-config-version':'1'}
  const queue=await f.originalFetch(f.origin+'/api/workflows?state=all',{headers});assert.equal(queue.status,200)
  const body=await queue.json(),item=body.actions[0];assert.equal(item.callback.name,c.name);assert.equal(item.callback.canCheck,true)
  assert.doesNotMatch(JSON.stringify(body),new RegExp(c.receiptToken+'|'+f.binding.phoneNumberId))
  const check=async patch=>f.originalFetch(f.origin+'/api/callbacks',{method:'POST',headers:{...headers,origin:f.origin,'content-type':'application/json',...patch},body:JSON.stringify({actionId:item.id,expectedRevision:item.revision})})
  assert.equal((await check({})).status,200)
  assert.equal((await check({cookie:f.cookies['viewer-a']})).status,403)
  assert.equal((await check({origin:'https://foreign.example.test'})).status,403)
  assert.equal((await check({cookie:f.cookies['owner-b']})).status,403)
  assert.equal(f.state.posts,1)
})
test('later provider observation displays ringing and ended without claiming the prospect answered or booked',async()=>{
  const c=await f.command();await f.submit(c);const call=[...f.state.effects.values()][0]
  const expire=()=>f.db.admin.query("DELETE FROM atrium.operational_documents WHERE key LIKE 'callback-observation:%'")
  call.status='ringing';await expire();assert.equal((await status(c)).body.stage,'ringing')
  call.status='ended';await expire();const result=await status(c);assert.equal(result.body.stage,'ended');assert.doesNotMatch(result.body.message,/tour confirmed|successfully booked/i)
  const reads=f.state.reads;await status(c);assert.equal(f.state.reads,reads);assert.equal(f.state.posts,1)
})

test('the callback assistant can use the authenticated voice tool boundary and retain a completed lead',async()=>{
  const c=await f.command();await f.submit(c);const call=[...f.state.effects.values()][0]
  const post=async message=>{
    const response=await f.originalFetch(f.origin+'/api/vapi',{method:'POST',headers:{'content-type':'application/json','x-vapi-secret':'synthetic-callback-webhook-secret'},body:JSON.stringify({message:{call,...message}})})
    return {status:response.status,body:await response.json()}
  }
  const captured=await post({type:'tool-calls',toolCallList:[{id:'callback-capture',name:'capture_contact',arguments:{name:c.name,phone:c.phone,requestType:'leasing',excerpt:'My name is Test Visitor. Please help me find an apartment.'}}],artifact:{messages:[{role:'user',message:'My name is Test Visitor. Please help me find an apartment.'}]}})
  assert.equal(captured.status,200);assert.ok(captured.body.results?.length)
  const ended=await post({type:'end-of-call-report',endedAt:new Date().toISOString(),durationSeconds:30});assert.equal(ended.status,200)
  const response=await f.originalFetch(f.origin+'/api/leads',{headers:{cookie:f.cookies['staff-a'],'x-atrium-organization-id':'organization-a','x-atrium-property-id':'property-a1','x-atrium-config-version':'1'}})
  assert.equal(response.status,200);const body=await response.json();assert.ok(body.profiles.some(p=>p.name===c.name||p.phone===c.phone),JSON.stringify(body.profiles))
  assert.equal(f.state.posts,1)
})
test('voice route revocation during readback cannot publish a successful call initiation',async()=>{
  const c=await f.command()
  f.state.beforeRead=()=>f.db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='callback-vapi-a'")
  const response=await f.submit(c);assert.notEqual(response.body.stage,'queued')
  assert.equal(f.state.posts,1)
  assert.equal((await f.db.admin.query("SELECT count(*) FROM atrium.outbox_messages WHERE state='succeeded'")).rows[0].count,'0')
})
test('preflight binds one registered website and never contacts the call provider',async()=>{
  const response=await f.originalFetch(f.origin+'/api/website-callbacks?widgetId=website-a',{method:'OPTIONS',headers:{origin:f.binding.origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}})
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),f.binding.origin)
  assert.equal(response.headers.get('access-control-allow-credentials'),null);assert.equal(f.state.posts,0)
})

import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import dashboard from '../../api/dashboard.ts'
import handler from '../../api/email-reconciliation.ts'
import workflows from '../../api/workflows.ts'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { PostgresWorkflowRepository } from '../../src/database/workflows.ts'
import { emailWorkflowAction, emailMessageDigest } from '../../src/email/workflow.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from '../helpers/mfa-session.mjs'
const env = { ...process.env }, originalFetch = globalThis.fetch, secret = 'synthetic-reconciliation-cron-secret-only'
let db, runtime, server, provider, origin, providerOrigin, password, providerMode = 'delivered', onRead, reads = 0, writes = 0
const errors = [], cookies = {}, effects = new Map(), repositories = {}
const scopes = [['organization-a','property-a1','owner-a','America/New_York'],['organization-b','property-b1','owner-b','America/Los_Angeles']]
const now = new Date(), expires = new Date(now.getTime() + 86400000).toISOString()
function bundle(org, property, timeZone, patch = {}) {
  const sender = { provider:'resend', organizationId:org, propertyId:property, from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',reviewExpiresAt:expires }
  return { property: { id:property,organizationId:org,buildingName:property,timeZone,jurisdiction:'NY',tourSettings:defaultSettings(),
    voiceShortlistEmail:sender,tourConfirmationEmail:sender,
    emailReconciliation:{enabled:true,organizationId:org,propertyId:property,runnerId:`runner-${property}`,reviewExpiresAt:expires},...patch },
    inventory:[],floorplans:[],knowledge:[] }
}
async function publish(org, property, zone, version, patch) {
  await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
    VALUES($1,$2,$3,'published',$4,clock_timestamp(),'synthetic-email',clock_timestamp())`, [org,property,version,JSON.stringify(bundle(org,property,zone,patch))])
  await db.admin.query('UPDATE atrium.properties SET published_configuration_version=$3 WHERE organization_id=$1 AND id=$2',[org,property,version])
}
before(async () => {
  db = await createFoundationTestDatabase(); password = (await seedFoundationTestDatabase(db.admin)).password
  runtime = createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:'synthetic-email-reconciliation-session-secret',authOrigin:TEST_AUTH_ORIGIN})
  for (const [org,property,user,zone] of scopes) {
    await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
      VALUES($1,'email-reconciler',$2,$3,$4,'active',ARRAY['read','operate'])`,[`worker-${property}`,`runner-${property}`,org,property])
    await publish(org,property,zone,1,{})
    const principal = await runtime.authorization.authenticatePassword(user,password)
    const scope = await runtime.authorization.authorizeProperty(principal,property,'configure')
    repositories[property] = new PostgresWorkflowRepository(db.app,scope,{requestId:`synthetic-${property}`,configurationVersion:1})
  }
  provider = createServer(async(req,res) => {
    try {
      if (req.method !== 'GET') { writes++; throw new Error('Reconciler attempted a provider write') }
      reads++; if (onRead) await onRead()
      if (providerMode === 'timeout') { await delay(2500); res.end('{}'); return }
      const id = req.url.split('/').at(-1), value = effects.get(id)
      res.setHeader('content-type','application/json')
      if (!value || providerMode === 'unavailable') { res.statusCode=503;res.end('{}');return }
      res.end(JSON.stringify({object:'email',id,...value,...(providerMode==='mismatch'?{to:['wrong@example.test']} : {}),last_event:providerMode}))
    } catch(error) { errors.push(error);res.statusCode=500;res.end('{}') }
  })
  provider.listen(0,'127.0.0.1');await once(provider,'listening');providerOrigin=`http://127.0.0.1:${provider.address().port}`
  globalThis.fetch = (url,options) => {
    const target=new URL(String(url));assert.equal(target.origin,'https://api.resend.com','No live services');
    return originalFetch(providerOrigin+target.pathname,options)
  }
  process.env.ATRIUM_RUNTIME_MODE='postgres';process.env.CRON_SECRET=secret;process.env.RESEND_API_KEY='synthetic-email-provider-key'
  server=createServer(async(req,res)=>{
    try {
      req.atriumRuntime=runtime;let body='';for await(const chunk of req)body+=chunk;req.body=body
      const url=new URL(req.url,'http://localhost');req.query={}
      for(const key of new Set(url.searchParams.keys())) { const values=url.searchParams.getAll(key);req.query[key]=values.length===1?values[0]:values }
      res.status=code=>{res.statusCode=code;return res};res.send=body=>{res.end(body);return res}
      res.json=body=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(body));return res}
      await (url.pathname==='/api/dashboard'?dashboard:url.pathname==='/api/workflows'?workflows:handler)(req,res)
    } catch(error){errors.push(error);res.statusCode=500;res.end('{}')}
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`
  for(const user of ['owner-a','owner-b','staff-a','viewer-a']) {
    const response=await originalFetch(origin+'/api/dashboard',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:user,password})})
    assert.equal(response.status,303);cookies[user]=response.headers.get('set-cookie').split(';')[0];await response.text();await verifyMfaCookie(runtime,cookies[user],password)
  }
})
beforeEach(async()=>{
  await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,atrium.operational_documents')
  await db.admin.query("UPDATE atrium.channel_bindings SET status='active',capabilities=ARRAY['read','operate']")
  for(const [org,property] of scopes)await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2',[org,property])
  effects.clear();errors.length=0;reads=0;writes=0;onRead=null;providerMode='delivered';process.env.CRON_SECRET=secret;process.env.RESEND_API_KEY='synthetic-email-provider-key'
})
after(async()=>{
  globalThis.fetch=originalFetch
  for(const key of ['ATRIUM_RUNTIME_MODE','CRON_SECRET','RESEND_API_KEY']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key]}
  for(const item of [server,provider])if(item){item.close();item.closeAllConnections();await once(item,'close')}
  await db?.close()
})
async function seed({property='property-a1',repository=repositories[property],dispatched=true,ack=true,kind='leasing_email',maxAttempts=10,purpose='leasing_shortlist'}={}) {
  const key=randomUUID(),recordedAt=new Date(Date.now()-1000).toISOString()
  const message={to:'synthetic-recipient@example.test',from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',subject:'Your requested homes',html:'<p>Synthetic exact consented content</p>'}
  const input=emailWorkflowAction(message,{purpose,recipient:message.to,contentSha256:emailMessageDigest(message),recordedAt,expiresAt:expires,receiptId:key},key)
  const action=(await repository.accept({source:'synthetic-reconciliation',eventId:key,payload:{synthetic:true},actions:[{...input,kind,maxAttempts}]})).actions[0]
  if(!dispatched)return action
  const claim=await repository.claim({workerId:'synthetic-submission',leaseMs:30000,actionId:action.id})
  const started=await repository.startDispatch(claim);assert.equal(started.status,'ready')
  const reference=randomUUID()
  effects.set(reference,{from:message.from,to:[message.to],reply_to:[message.replyTo],subject:message.subject,html:message.html,cc:[],bcc:[],tags:[{name:'atrium_operation',value:action.operationKey},{name:'atrium_input',value:action.inputSha256}]})
  assert.equal(await repository.settle(started.claim,{state:'verifying',code:ack?'provider_accepted':'email_acknowledgement_missing',delayMs:0,...(ack?{providerReference:reference}:{})}),true)
  return repository.get(action.id)
}
async function request({user,action,body,query='?runnerId=runner-property-a1',headers={},property='property-a1',org='organization-a',path='/api/email-reconciliation',method}={}) {
  const post=user!==undefined||action!==undefined||body!==undefined
  const response=await originalFetch(origin+path+(post?'':query),{method:method??(post?'POST':'GET'),headers:post?{
    cookie:cookies[user??'owner-a']??'',origin,'content-type':'application/json','x-atrium-organization-id':org,'x-atrium-property-id':property,'x-atrium-config-version':'1',...headers
  }:{authorization:`Bearer ${secret}`,...headers},...(post?{body:typeof body==='string'?body:JSON.stringify(body??{actionId:action.id,expectedRevision:action.revision})}:{})})
  return {status:response.status,body:await response.json()}
}
async function due(id) {await db.admin.query("UPDATE atrium.outbox_messages SET available_at=clock_timestamp()-interval '1 second' WHERE action_id=$1",[id])}

test('worker authenticates before runtime or channel lookup and refuses malformed query selection',async()=>{
  const invalidRuntime={method:'GET',headers:{authorization:'Bearer incorrect'},query:{runnerId:'foreign'},atriumRuntime:{invalid:true}}
  let status;const res={setHeader(){},status(v){status=v;return this},json(){}}
  await handler(invalidRuntime,res);assert.equal(status,401)
  for(const authorization of ['','Bearer bad',`Bearer ${secret}, Bearer ${secret}`,[`Bearer ${secret}`]]) {
    await handler({...invalidRuntime,headers:{authorization}},res);assert.equal(status,401)
  }
  assert.equal((await request({query:'?runnerId=runner-property-a1&runnerId=other'})).status,400)
  assert.equal((await request({query:'?runnerId=runner-property-a1&propertyId=property-b1'})).status,400)
  assert.equal((await request({query:'?runnerId=unregistered'})).status,403)
  delete process.env.CRON_SECRET;assert.equal((await request()).status,503)
  assert.equal(reads,0)
})
test('worker checks dispatched emails after call completion without requiring an active call',async()=>{
  const channel=await runtime.loadChannel('vapi','synthetic-assistant-a','call-completed')
  const repository=new PostgresWorkflowRepository(db.app,channel.scope,{requestId:'call-completed',configurationVersion:1})
  const action=await seed({repository})
  await channel.documents.set('synthetic-ended-call',{lifecycle:'ended',actionId:action.id})
  const result=await request();assert.equal(result.status,200);assert.equal(result.body.actions[0].state,'succeeded')
  const saved=await repository.get(action.id);assert.equal(saved.evidence.deliveryStatus,'delivered');assert.equal(saved.dispatchAttempts,1)
  assert.equal(reads,1);assert.equal(writes,0)
  assert.doesNotMatch(JSON.stringify(result.body),/synthetic-recipient|html|providerReference|operationKey/)
})
test('staff with operate can verify exact email; viewers and foreign properties cannot',async()=>{
  const action=await seed()
  assert.equal((await request({user:'viewer-a',action})).status,403)
  assert.equal((await request({user:'missing',action})).status,401)
  assert.equal((await request({user:'owner-b',action,org:'organization-b',property:'property-b1'})).status,404)
  assert.equal((await request({user:'owner-a',action,org:'organization-b',property:'property-b1'})).status,403)
  const result=await request({user:'staff-a',action});assert.equal(result.status,200);assert.equal(result.body.action.emailDelivery,'delivered')
  assert.equal(result.body.action.canReplay,false);assert.equal(result.body.verificationOnly,true);assert.equal(writes,0)
})
test('same-origin, exact commands and current displayed revision are required',async()=>{
  const action=await seed()
  for(const headers of [{origin:'https://foreign.test'},{'content-type':'text/plain'},{'sec-fetch-site':'cross-site'},{'x-atrium-config-version':'99'}]) {
    assert.ok([403,409].includes((await request({action,headers})).status))
  }
  assert.equal((await request({body:{actionId:action.id,expectedRevision:action.revision,to:'other@example.test'}})).status,400)
  assert.equal((await request({body:'{broken'})).status,400)
  assert.equal((await request({body:{actionId:action.id,expectedRevision:'a'.repeat(64)}})).status,409)
  assert.equal(reads,0)
})
test('first dispatches and unrelated work cannot be consumed by scheduler or manual checks',async()=>{
  const pending=await seed({dispatched:false}),foreignKind=await seed({kind:'synthetic_other'})
  assert.equal((await request({action:pending})).status,409)
  assert.equal((await request({action:foreignKind})).status,409)
  assert.equal((await request()).body.inspected,0)
  assert.equal((await repositories['property-a1'].get(pending.id)).dispatchStarted,false)
  assert.equal(reads,0);assert.equal(writes,0)
})
test('bounded oldest-due selection ignores other tenants, future retries and first-send backlog',async()=>{
  const oldest=await seed();for(let i=0;i<6;i++)await seed()
  await seed({property:'property-b1'})
  const future=await seed();await db.admin.query("UPDATE atrium.outbox_messages SET available_at=clock_timestamp()+interval '1 hour' WHERE action_id=$1",[future.id])
  for(let i=0;i<8;i++)await seed({dispatched:false})
  const first=await request();assert.equal(first.status,200);assert.equal(first.body.inspected,5);assert.equal(first.body.actions[0].id,oldest.id)
  assert.equal((await request()).body.inspected,2);assert.equal((await request()).body.inspected,0)
  assert.equal((await request({query:'?runnerId=runner-property-b1'})).body.inspected,1)
  assert.equal((await repositories['property-a1'].get(future.id)).state,'verifying');assert.equal(writes,0)
})
test('overlapping workers and staff verification share one fenced readback',async()=>{
  const action=await seed();onRead=()=>delay(150)
  const results=await Promise.all([request(),request(),request({action})])
  assert.ok(results.every(r=>[200,409].includes(r.status)));assert.equal(reads,1);assert.equal(writes,0)
  assert.equal((await repositories['property-a1'].get(action.id)).verificationAttempts,1)
})
test('unknown submission cannot be resent or declared delivered and reaches bounded review',async()=>{
  const action=await seed({ack:false,maxAttempts:2})
  assert.equal((await request()).status,200);await due(action.id)
  assert.equal((await request()).body.actions[0].state,'needs_review')
  const saved=await repositories['property-a1'].get(action.id);assert.equal(saved.lastErrorCode,'verification_attempts_exhausted')
  assert.equal(saved.dispatchAttempts,1);assert.equal(reads,0);assert.equal(writes,0)
})
for(const [mode,expected,code] of [['sent','verifying','email_delivery_unverified'],['bounced','needs_review','email_delivery_failed'],['mismatch','needs_review','email_provider_payload_mismatch'],['unavailable','verifying','email_readback_unavailable'],['timeout','verifying','connector_timeout']]) {
  test(`provider ${mode} never becomes a false delivery or new send`,async()=>{
    const action=await seed({purpose:'tour_confirmation'});providerMode=mode
    const result=await request();assert.equal(result.status,200);const saved=await repositories['property-a1'].get(action.id)
    assert.equal(saved.state,expected);assert.equal(saved.lastErrorCode,code);assert.equal(saved.dispatchAttempts,1);assert.equal(writes,0)
  })
}
test('revoked original actor is held before provider IO; revoked worker cannot run',async()=>{
  const channel=await runtime.loadChannel('vapi','synthetic-assistant-a','original-voice')
  const repository=new PostgresWorkflowRepository(db.app,channel.scope,{requestId:'original-voice',configurationVersion:1})
  const action=await seed({repository})
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='channel-a'")
  assert.equal((await request()).body.actions[0].state,'needs_review');assert.equal(reads,0)
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='worker-property-a1'")
  assert.equal((await request()).status,403);assert.equal(writes,0)
})
test('configuration changes during verification cannot commit success',async()=>{
  const action=await seed()
  onRead=()=>publish('organization-a','property-a1','America/New_York',2,{})
  assert.equal((await request()).status,409)
  const saved=await repositories['property-a1'].get(action.id)
  assert.equal(saved.state,'needs_review');assert.equal(saved.lastErrorCode,'original_configuration_changed');assert.equal(writes,0)
})
test('disabled property worker and missing provider cannot touch delivery',async()=>{
  await seed();await publish('organization-a','property-a1','America/New_York',3,{emailReconciliation:{enabled:false}})
  assert.equal((await request()).status,403)
  await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'")
  delete process.env.RESEND_API_KEY;assert.equal((await request()).status,503);assert.equal(reads,0)
})
test('atomic verification-only claim refuses first dispatch and detects stale revision',async()=>{
  const repository=repositories['property-a1'],pending=await seed({dispatched:false})
  assert.equal(await repository.claim({actionId:pending.id,workerId:'check',leaseMs:30000,verifyOnly:true}),null)
  const action=await seed()
  await assert.rejects(repository.claim({actionId:action.id,workerId:'check',leaseMs:30000,verifyOnly:true,expectedRevision:'b'.repeat(64)}),{code:'workflow_revision_conflict'})
  const claim=await repository.claim({actionId:action.id,workerId:'check',leaseMs:30000,verifyOnly:true,expectedRevision:action.revision})
  assert.equal(claim.action.phase,'verify');assert.equal(claim.action.dispatchAttempts,1)
  assert.deepEqual(errors,[])
})

test('expired leases recover verification while active leases and cancelled first sends stay untouched',async()=>{
  const repository=repositories['property-a1'],action=await seed(),active=await seed(),cancelled=await seed({dispatched:false})
  await repository.claim({actionId:action.id,workerId:'dead-worker',leaseMs:10,verifyOnly:true})
  await repository.claim({actionId:active.id,workerId:'live-worker',leaseMs:30000,verifyOnly:true})
  await repository.cancel(cancelled.id,'no_longer_needed',cancelled.revision)
  await delay(15)
  const result=await request();assert.equal(result.status,200);assert.equal(result.body.inspected,1)
  assert.equal(result.body.actions[0].id,action.id);assert.equal(result.body.actions[0].state,'succeeded')
  assert.equal((await repository.get(active.id)).state,'running');assert.equal(reads,1);assert.equal(writes,0)
})
test('unavailable sender consumes bounded checks without blocking another eligible email',async()=>{
  await publish('organization-a','property-a1','America/New_York',4,{voiceShortlistEmail:null})
  const property=await runtime.loadChannel('email-reconciler','runner-property-a1','binding-test')
  const repository=new PostgresWorkflowRepository(db.app,property.scope,{requestId:'binding-test',configurationVersion:4})
  const missing=await seed({repository}),eligible=await seed({repository,purpose:'tour_confirmation'})
  const result=await request();assert.equal(result.status,200);assert.equal(result.body.inspected,2)
  assert.equal((await repository.get(missing.id)).lastErrorCode,'email_binding_unavailable')
  assert.equal((await repository.get(eligible.id)).state,'succeeded');assert.equal(reads,1);assert.equal(writes,0)
})

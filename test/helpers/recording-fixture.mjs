import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import dashboard from '../../api/dashboard.ts'
import recordings from '../../api/recordings.ts'
import { createDatabaseRuntime, resolveOpsRuntime, readRuntimeError } from '../../src/application/runtime.ts'
import { normaliseCall } from '../../src/ops/vapi-calls.ts'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { TEST_AUTH_ORIGIN, verifyMfaCookie } from './mfa-session.mjs'

export const recordingId = '11111111-1111-4111-8111-111111111111'
export const recordingUrl = 'https://storage.vapi.ai/synthetic.wav?signature=synthetic-only'
export async function recordingFixture() {
  const originalFetch=globalThis.fetch, keys=['ATRIUM_RUNTIME_MODE','VAPI_PRIVATE_KEY','VAPI_API_KEY'], env={...process.env}
  let db,server,provider
  const state={metadataStatus:200,recordingStatus:302,location:recordingUrl,callId:recordingId,assistantId:'synthetic-assistant-a',onMetadata:null,onRecording:null,requests:[],errors:[]}
  const cookies={}
  async function close() {
    globalThis.fetch=originalFetch
    for(const key of keys)env[key]===undefined?delete process.env[key]:process.env[key]=env[key]
    for(const item of [server,provider])if(item?.listening){item.close();item.closeAllConnections();await once(item,'close')}
    await db?.close()
  }
  try {
    db=await createFoundationTestDatabase();const {password}=await seedFoundationTestDatabase(db.admin)
    const runtime=createDatabaseRuntime({app:db.app,auth:db.auth,sessionSecret:'synthetic-recording-fixture-session-secret',authOrigin:TEST_AUTH_ORIGIN})
    for(const [org,property,zone] of [['organization-a','property-a1','America/New_York'],['organization-a','property-a2','America/Chicago'],['organization-b','property-b1','America/Los_Angeles']]){
      const config={property:{id:property,organizationId:org,buildingName:property,timeZone:zone,jurisdiction:'NY',tourSettings:defaultSettings()},inventory:[],floorplans:[],knowledge:[]}
      for(const version of [1,2])await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
        VALUES($1,$2,$3,'published',$4,clock_timestamp(),'synthetic-recording',clock_timestamp())`,[org,property,version,JSON.stringify(config)])
      await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE organization_id=$1 AND id=$2',[org,property])
    }
    await db.admin.query("INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities) VALUES('channel-b','vapi','synthetic-assistant-b','organization-b','property-b1','active',ARRAY['read','operate'])")
    provider=createServer(async(req,res)=>{
      try {
        assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer synthetic-recording-key')
        state.requests.push(req.url)
        if(req.url===`/call/${recordingId}`){await state.onMetadata?.();res.statusCode=state.metadataStatus;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:state.callId,assistantId:state.assistantId}));return}
        assert.equal(req.url,`/call/${recordingId}/mono-recording`);await state.onRecording?.()
        res.statusCode=state.recordingStatus;res.setHeader('location',state.location);res.end()
      }catch(error){state.errors.push(error);res.statusCode=500;res.end('{}')}
    })
    provider.listen(0,'127.0.0.1');await once(provider,'listening');const providerOrigin=`http://127.0.0.1:${provider.address().port}`
    globalThis.fetch=(url,options)=>{const target=new URL(String(url));assert.equal(target.origin,'https://api.vapi.ai','No real provider access');return originalFetch(providerOrigin+target.pathname,options)}
    process.env.ATRIUM_RUNTIME_MODE='postgres';delete process.env.VAPI_PRIVATE_KEY;process.env.VAPI_API_KEY='synthetic-recording-key'
    server=createServer(async(req,res)=>{
      try{
        req.atriumRuntime=runtime;let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('fixture request too large')}req.body=body
        const url=new URL(req.url,'http://localhost');req.query={};for(const key of new Set(url.searchParams.keys())){const values=url.searchParams.getAll(key);req.query[key]=values.length===1?values[0]:values}
        res.status=code=>{res.statusCode=code;return res};res.send=value=>{res.end(value);return res};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return res}
        if(url.pathname==='/api/recordings'){await recordings(req,res);return}
        if(url.pathname==='/api/dashboard'){await dashboard(req,res);return}
        if(url.pathname==='/api/health'){res.json({ok:true,durable:true,store:'postgres',callHistory:true});return}
        const property=await resolveOpsRuntime(req,'read')
        const common={scope:property.responseScope,generatedAt:new Date().toISOString()}
        if(url.pathname==='/api/vapi')res.json({...common,calls:[normaliseCall({id:recordingId,startedAt:'2026-09-23T13:00:00Z',endedAt:'2026-09-23T13:01:00Z',customer:{number:'+12125550101'},transcript:'User: A synthetic recording test.',recordingUrl})],events:[],callsConfigured:true,callsError:null})
        else if(url.pathname==='/api/leads')res.json({...common,profiles:[],followUps:[],tourChangeRequests:[],durable:true})
        else if(url.pathname==='/api/calendar')res.json({...common,bookings:[],slots:[],blocks:[],timeZone:property.snapshot.timeZone,durable:true})
        else res.status(404).json({error:'fixture route not found'})
      }catch(error){const failure=readRuntimeError(error);res.statusCode=failure.status;res.setHeader('content-type','application/json');res.end(JSON.stringify(failure.body))}
    })
    server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`
    for(const username of ['owner-a','owner-b','viewer-a','staff-a']){
      const response=await originalFetch(origin+'/api/dashboard',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username,password})})
      assert.equal(response.status,303);cookies[username]=response.headers.get('set-cookie').split(';')[0];await response.text();await verifyMfaCookie(runtime,cookies[username],password)
    }
    async function request({user='owner-a',org='organization-a',property='property-a1',headers={},query=`?callId=${recordingId}`}={}){
      const response=await originalFetch(origin+'/api/recordings'+query,{headers:{cookie:cookies[user]??'','x-atrium-organization-id':org,'x-atrium-property-id':property,'x-atrium-config-version':'1',...headers},redirect:'manual'})
      return {status:response.status,headers:response.headers,body:await response.json()}
    }
    async function reset(){
      Object.assign(state,{metadataStatus:200,recordingStatus:302,location:recordingUrl,callId:recordingId,assistantId:'synthetic-assistant-a',onMetadata:null,onRecording:null});state.requests.length=0;state.errors.length=0
      await db.admin.query("UPDATE atrium.memberships SET status='active'")
      await db.admin.query("UPDATE atrium.channel_bindings SET status='active'")
      await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE published_configuration_version IS NOT NULL')
    }
    return {db,runtime,origin,cookies,state,request,reset,close}
  }catch(error){await close();throw error}
}

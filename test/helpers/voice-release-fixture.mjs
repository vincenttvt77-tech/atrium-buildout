import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createCancellationEmailFixture } from './cancellation-email-fixture.mjs'
import { VOICE_CONTRACT } from '../../src/vapi/contract.ts'

export async function createVoiceReleaseFixture() {
  const originalFetch=globalThis.fetch, originalEnv={...process.env}
  const f=await createCancellationEmailFixture({extraRoutes:['vapi-sync']})
  let provider
  const restore=()=>{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];Object.assign(process.env,originalEnv)}
  try {
  const requests=[], saved=new Map(), flags={dropWrite:false,unavailable:false,wrongRoute:false,backend:true,beforeRead:null}
  provider=createServer(async(req,res)=>{
    try {
      const id=decodeURIComponent(req.url.split('/').at(-1)); assert.ok(saved.has(id),'only a synthetic bound assistant is read')
      requests.push({method:req.method,id})
      if(req.method==='PATCH') {
        let body='';for await(const chunk of req)body+=chunk
        const journals=(await f.db.admin.query("SELECT value FROM atrium.operational_documents WHERE key=$1",['voice-release:'+id])).rows
        assert.equal(journals.length,1);assert.equal(journals[0].value.releases.filter(r=>r.state==='sending').length,1)
        saved.set(id,{...saved.get(id),...JSON.parse(body)})
        if(flags.wrongRoute)saved.get(id).model.tools[0].server.url='https://foreign.example/api/vapi'
        if(flags.dropWrite){req.socket.destroy();return}
      } else if(flags.beforeRead) await flags.beforeRead({id,saved,requests})
      if(flags.unavailable&&req.method==='GET'){res.statusCode=503;res.end('sensitive-synthetic-outage');return}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(saved.get(id)))
    }catch(error){f.errors.push({name:error.name,message:error.message});res.statusCode=500;res.end('{}')}
  })
  provider.listen(0,'127.0.0.1');await once(provider,'listening')
  const providerOrigin='http://127.0.0.1:'+provider.address().port
  Object.assign(process.env,{VAPI_PRIVATE_KEY:'synthetic-key',VAPI_WEBHOOK_SECRET:'synthetic-webhook-secret-for-managed-release',
    VAPI_WEBHOOK_CREDENTIAL_ID:'synthetic-credential',VAPI_ORGANIZATION_ID:'synthetic-provider-org',VAPI_SERVER_BASE_URL:'https://voice-backend.example'})
  delete process.env.VERCEL_ENV
  globalThis.fetch=async(url,init)=>{
    const target=new URL(String(url))
    if(target.origin==='https://voice-backend.example'&&target.pathname==='/api/health')return Response.json({ok:flags.backend,durable:true,voiceContract:VOICE_CONTRACT})
    assert.equal(target.origin,'https://api.vapi.ai','no real external request is permitted')
    if(target.pathname==='/call')return Response.json([])
    assert.match(target.pathname,/^\/assistant\/synthetic-release-assistant-[ab]$/)
    return originalFetch(providerOrigin+target.pathname,init)
  }
  async function reset(){
    await f.reset({cancelled:false});requests.length=0;saved.clear()
    Object.assign(flags,{dropWrite:false,unavailable:false,wrongRoute:false,backend:true,beforeRead:null})
    await f.db.admin.query("UPDATE atrium.memberships SET role=CASE WHEN user_id LIKE 'owner-%' THEN 'owner' WHEN user_id LIKE 'viewer-%' THEN 'viewer' ELSE 'staff' END; UPDATE atrium.channel_bindings SET status='inactive'")
    for(const letter of ['a','b']){
      const id='synthetic-release-assistant-'+letter
      saved.set(id,{id,orgId:'synthetic-provider-org',name:'Synthetic '+letter,voice:{provider:'synthetic',voiceId:'chosen-'+letter},
        transcriber:{provider:'synthetic',language:'en'},model:{provider:'custom-llm',model:'synthetic-model',url:'https://model.example/v1',temperature:0.3},
        server:{url:'https://voice-backend.example/api/vapi',credentialId:'synthetic-credential'}})
      await f.db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
        VALUES($1,'vapi',$2,$3,$4,'active',ARRAY['read','operate']) ON CONFLICT(id) DO UPDATE SET status='active'`,
      ['synthetic-release-binding-'+letter,id,'organization-'+letter,'property-'+letter+'1'])
    }
  }
  const request=options=>f.request({path:'/api/vapi-sync',...options})
  const prepare=async(options={})=>{
    const r=await request({...options,body:{action:'prepare',requestId:randomUUID()}})
    assert.equal(r.status,200,JSON.stringify(r.body));return r.body
  }
  const publish=(plan,options={})=>request({...options,body:{action:'publish',id:plan.release.id,reviewHash:plan.release.reviewHash}})
  await reset()
  return {...f,publishConfiguration:f.publish,request,prepare,publish,reset,voiceRequests:requests,saved,voiceFlags:flags,
    async close(){globalThis.fetch=originalFetch;provider.close();provider.closeAllConnections();await once(provider,'close');await f.close();restore()},
  }
  }catch(error){
    globalThis.fetch=originalFetch
    if(provider?.listening){provider.close();provider.closeAllConnections();await once(provider,'close')}
    await f.close();restore();throw error
  }
}

import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { createWebsiteCallbackHandler } from '../../api/website-callbacks.ts'
import { CallbackTransport, CallbackChallenge } from '../../src/callbacks/transport.ts'
import { verifyMfaCookie, TEST_AUTH_ORIGIN } from './mfa-session.mjs'

export async function callbackFixture() {
  const originalFetch = globalThis.fetch, oldMode = process.env.ATRIUM_RUNTIME_MODE, oldKey = process.env.VAPI_API_KEY, oldWebhook = process.env.VAPI_WEBHOOK_SECRET
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'; process.env.VAPI_API_KEY = 'synthetic-callback-key'; process.env.VAPI_WEBHOOK_SECRET = 'synthetic-callback-webhook-secret'
  const db = await createFoundationTestDatabase(), app = db.createAppConnection()
  try {
  const { password } = await seedFoundationTestDatabase(db.admin)
  const runtime = createDatabaseRuntime({ app, auth: db.auth, sessionSecret: 'synthetic-callback-session-secret-for-testing', authOrigin: TEST_AUTH_ORIGIN })
  const binding = { enabled: true, organizationId: 'organization-a', propertyId: 'property-a1', channelId: 'website-a',
    origin: 'https://leasing.example.test', providerOrgId: randomUUID(), assistantId: randomUUID(), phoneNumberId: randomUUID(), assistantVersion: '23',
    reviewedAt: new Date(Date.now()-60000).toISOString(), reviewExpiresAt: new Date(Date.now()+86400000).toISOString(), dailyLimit: 10,
    hours: Array.from({ length: 7 }, (_, day) => ({ day, start: 0, end: 1440 })) }
  const state = { posts: 0, reads: 0, challenges: 0, effects: new Map(), mode: 'normal', challengeMode: 'normal', beforeCreate: null, beforeRead: null, errors: [], clock: null }
  const bundle = patch => ({ property: { id: binding.propertyId, organizationId: binding.organizationId, buildingName: 'Synthetic Larkin', timeZone: 'America/New_York', jurisdiction: 'NY', tourSettings: defaultSettings(), websiteCallback: { ...binding, ...patch } }, inventory: [], floorplans: [], knowledge: [] })
  async function publish(version, patch = {}) {
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,inventory_read_at,inventory_source,published_at)
      VALUES('organization-a','property-a1',$1,'published',$2,clock_timestamp(),'synthetic-callback',clock_timestamp())`, [version, JSON.stringify(bundle(patch))])
    await db.admin.query("UPDATE atrium.properties SET published_configuration_version=$1 WHERE id='property-a1'", [version])
  }
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('callback-vapi-a','vapi',$1,'organization-a','property-a1','active',ARRAY['read','operate'])`, [binding.assistantId])
  await db.admin.query(`INSERT INTO atrium.channel_bindings(id,provider,external_id,organization_id,property_id,status,capabilities)
    VALUES('website-binding-a','website-callback','website-a','organization-a','property-a1','active',ARRAY['read','operate'])`)
  await publish(1)
  const provider = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      res.setHeader('content-type', 'application/json')
      if (req.url === '/turnstile/v0/siteverify') {
        state.challenges++; const body = JSON.parse(raw)
        res.end(JSON.stringify({ success: body.response === 'synthetic-challenge' && state.challengeMode !== 'failed', hostname: state.challengeMode === 'hostname' ? 'foreign.example.test' : 'leasing.example.test',
          action: 'atrium-callback', cdata: 'website-a', challenge_ts: new Date().toISOString() })); return
      }
      if (req.method === 'POST' && req.url === '/call') {
        state.posts++; const body = JSON.parse(raw)
        if (state.beforeCreate) await state.beforeCreate()
        const id = randomUUID(), value = { ...body, id, orgId: binding.providerOrgId, type: 'outboundPhoneCall', status: 'queued', createdAt: new Date().toISOString() }
        state.effects.set(id, value)
        if (state.mode === 'lost') { req.socket.destroy(); return }
        res.end(JSON.stringify(state.mode === 'missing-id' ? { accepted: true } : { id })); return
      }
      if (req.method === 'GET' && req.url.split('?')[0] === '/call') { res.end('[]'); return }
      state.reads++; if (state.beforeRead) await state.beforeRead()
      const value = state.effects.get(req.url.split('/').at(-1))
      if (!value || state.mode === 'read-unavailable') { res.statusCode=503;res.end('{}');return }
      res.end(JSON.stringify({ ...value, ...(state.mode === 'mismatch' ? { customer: { number: '+12125550099', name: 'Different person' } } : {}) }))
    } catch(error) { state.errors.push(error); res.statusCode=500;res.end('{}') }
  })
  provider.listen(0,'127.0.0.1');await once(provider,'listening')
  const providerOrigin = `http://127.0.0.1:${provider.address().port}`
  const providerFetch = (url, options) => {
    const target = new URL(String(url))
    if (!['https://api.vapi.ai','https://challenges.cloudflare.com'].includes(target.origin)) throw new Error('Unexpected external URL')
    return originalFetch(providerOrigin + target.pathname, options)
  }
  globalThis.fetch = providerFetch
  const challenge = new CallbackChallenge('synthetic-turnstile-secret', providerFetch)
  const website = createWebsiteCallbackHandler({ now: () => state.clock ?? new Date(), provider: { configured: true, transport: () => new CallbackTransport('synthetic-callback-key', providerFetch) }, challenge: { siteKey: 'synthetic-site-key', verify: challenge.verify.bind(challenge) } })
  const routes = new Map(await Promise.all(['dashboard','callbacks','workflows','mfa','account','properties','calendar','leads','vapi','health'].map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
  routes.set('/api/website-callbacks', website)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/') { res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/callback-widget.css"></head><body><main><div data-atrium-callback data-widget-id="website-a"></div></main><script src="/callback-widget.js" defer></script></body></html>');return }
      if (['/callback-widget.js','/callback-widget.css'].includes(url.pathname)) { res.setHeader('content-type',url.pathname.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(new URL('../../public'+url.pathname,import.meta.url)));return }
      if (url.pathname === '/favicon.ico') {res.statusCode=204;res.end();return}
      const handler = routes.get(url.pathname); if(!handler){res.statusCode=404;res.end();return}
      req.atriumRuntime=runtime;let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw new Error('Oversize')}
      req.body=req.headers['content-type']?.includes('application/x-www-form-urlencoded')?Object.fromEntries(new URLSearchParams(raw)):raw
      req.query={};for(const name of new Set(url.searchParams.keys())){const values=url.searchParams.getAll(name);req.query[name]=values.length===1?values[0]:values}
      res.status=code=>{res.statusCode=code;return res};res.json=body=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(body));return res};res.send=body=>{res.end(body);return res}
      await handler(req,res)
    }catch(error){state.errors.push(error);res.statusCode=500;res.end('{}')}
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const origin=`http://localhost:${server.address().port}`, cookies={}
  for(const user of ['owner-a','staff-a','viewer-a','owner-b']){
    const response=await originalFetch(origin+'/api/dashboard',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:user,password})})
    cookies[user]=response.headers.get('set-cookie')?.split(';')[0];await response.text();await verifyMfaCookie(runtime,cookies[user],password)
  }
  async function request(body, headers={}, query='?widgetId=website-a') {
    const result=await originalFetch(origin+'/api/website-callbacks'+query,{method:'POST',headers:{origin:binding.origin,'content-type':'application/json',...headers},body:JSON.stringify(body)})
    return {status:result.status,body:await result.json(),headers:result.headers}
  }
  async function command(patch={}) {const config=await request({action:'bootstrap'});return {requestId:randomUUID(),receiptToken:randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),name:'Test Visitor',phone:'+12125550123',consent:true,policySha256:config.body.policySha256,...patch}}
  async function submit(value) {return request({action:'request',challengeToken:'synthetic-challenge',request:value})}
  async function reset(){await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,atrium.operational_documents');await db.admin.query("UPDATE atrium.properties SET published_configuration_version=1 WHERE id='property-a1'");await db.admin.query("UPDATE atrium.channel_bindings SET status='active',capabilities=ARRAY['read','operate']");Object.assign(state,{posts:0,reads:0,challenges:0,mode:'normal',challengeMode:'normal',beforeCreate:null,beforeRead:null,clock:null});state.effects.clear();state.errors.length=0}
  return {db,runtime,binding,state,origin,cookies,password,originalFetch,request,command,submit,publish,reset,
    async close(){globalThis.fetch=originalFetch;for(const [key,value]of [['ATRIUM_RUNTIME_MODE',oldMode],['VAPI_API_KEY',oldKey],['VAPI_WEBHOOK_SECRET',oldWebhook]]){if(value===undefined)delete process.env[key];else process.env[key]=value}for(const item of [server,provider]){item.close();item.closeAllConnections();await once(item,'close')}await app.close();await db.close()}}
  } catch(error) { await app.close(); await db.close(); throw error }
}

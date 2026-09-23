import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createFoundationTestDatabase, seedFoundationTestDatabase } from '../../scripts/lib/foundation-test.mjs'
import { createDatabaseRuntime } from '../../src/application/runtime.ts'
import { createCancellationEmailsHandler } from '../../api/tour-cancellation-emails.ts'
import { createEmailReconciliationHandler } from '../../api/email-reconciliation.ts'
import { ResendTransport } from '../../src/email/render.ts'
import { defaultSettings } from '../../src/calendar/settings.ts'
import { verifyMfaCookie } from './mfa-session.mjs'

/** Real local HTTP, signed MFA, separate connection pool and synthetic provider. */
export async function createCancellationEmailFixture() {
  const originalMode = process.env.ATRIUM_RUNTIME_MODE, originalFetch = globalThis.fetch
  process.env.ATRIUM_RUNTIME_MODE = 'postgres'
  const db = await createFoundationTestDatabase(), app = db.createAppConnection()
  let server
  try {
  const { password } = await seedFoundationTestDatabase(db.admin)
  const routes = new Map(await Promise.all(['dashboard','mfa','account','properties','calendar','leads','vapi','health','workflows','tour-cancellations']
    .map(async name => [`/api/${name}`, (await import(`../../api/${name}.ts`)).default])))
  const configurations = {}, versions = {}, cookies = {}, effects = new Map(), requests = [], errors = []
  const flags = { configured: true, dropQueueReply: false, dropProcessReply: false, dropProviderReply: false,
    providerEvent: 'delivered', wrongRecipient: false, clockOffset: 0 }
  const now = () => new Date(Date.now() + flags.clockOffset)
  let runtime, origin, beforeResponse = null
  const start = new Date(Date.now() + 2 * 86400000); start.setUTCSeconds(0, 0)
  const booking = { externalId: 'synthetic-cancelled-tour', interactionId: 'synthetic-original-call',
    startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 1800000).toISOString(),
    slotId: 'slot-' + start.toISOString().slice(0, 16), prospectName: 'Test Visitor', prospectEmail: 'visitor@example.test',
    prospectPhone: '+12025550101', unitId: null, bookedAt: new Date().toISOString(), revision: 0 }
  for (const [org, property] of [['organization-a','property-a1'],['organization-b','property-b1']]) {
    configurations[property] = { property: { id: property, organizationId: org, buildingName: 'Synthetic Building',
      address: '1 Synthetic Avenue', timeZone: property === 'property-a1' ? 'America/New_York' : 'America/Los_Angeles',
      jurisdiction: 'NY', tourSettings: defaultSettings(), tourCancellationEmail: { provider: 'resend', organizationId: org,
        propertyId: property, from: 'Leasing <leasing@example.test>', replyTo: 'leasing@example.test',
        reviewExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } }, inventory: [], floorplans: [], knowledge: [] }
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,
      inventory_read_at,inventory_source,published_at) VALUES($1,$2,1,'published',$3,clock_timestamp(),'synthetic-cancellation',clock_timestamp())`,
    [org, property, JSON.stringify(configurations[property])])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1', [property])
    versions[property] = 1
  }
  await db.admin.query("UPDATE atrium.channel_bindings SET status='inactive'")
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin)
      if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return }
      let body = ''; for await (const part of req) body += part
      if (url.pathname.startsWith('/synthetic-provider/')) {
        if (req.method === 'POST') {
          const id = randomUUID(), message = JSON.parse(body); effects.set(id, message)
          requests.push({ method: 'POST', id, message, key: req.headers['idempotency-key'] })
          if (flags.dropProviderReply) { req.socket.destroy(); return }
          res.setHeader('content-type','application/json'); res.end(JSON.stringify({ id })); return
        }
        const id = url.pathname.split('/').at(-1), message = effects.get(id)
        requests.push({ method: 'GET', id })
        if (!message) { res.statusCode = 404; res.end('{}'); return }
        res.setHeader('content-type','application/json'); res.end(JSON.stringify({ object:'email',id,...message,
          ...(flags.wrongRecipient ? { to:['someone-else@example.test'] } : {}), cc:[],bcc:[],reply_to:message.reply_to??[],last_event:flags.providerEvent })); return
      }
      const handler = routes.get(url.pathname)
      if (!handler) { res.statusCode = 404; res.end('{}'); return }
      req.atriumRuntime = runtime
      req.body = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body)) : body
      req.query = {}; for (const key of new Set(url.searchParams.keys())) { const values=url.searchParams.getAll(key);req.query[key]=values.length===1?values[0]:values }
      res.status = code => { res.statusCode = code; return res };res.send = value => {res.end(value);return res}
      res.json = value => {
        if (url.pathname === '/api/tour-cancellation-emails' && req.method === 'POST' && res.statusCode === 200) {
          const action = JSON.parse(body).action, flag = action === 'queue' ? 'dropQueueReply' : 'dropProcessReply'
          if (flags[flag]) { flags[flag] = false; req.socket.destroy(); return res }
        }
        const send = () => {res.setHeader('content-type','application/json');res.end(JSON.stringify(value))}
        if (beforeResponse) void Promise.resolve(beforeResponse({req, value})).then(send).catch(error => { errors.push({name:error.name,code:error.code}); res.destroy() })
        else send()
        return res
      }
      await handler(req,res)
    } catch (error) { errors.push({name:error.name,code:error.code});res.statusCode=500;res.end('{}') }
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://localhost:${server.address().port}`
  runtime = createDatabaseRuntime({ app, auth:db.auth, sessionSecret:'synthetic-cancellation-email-session-secret',authOrigin:origin })
  const provider = { get configured() {return flags.configured}, transport:()=>new ResendTransport('synthetic-key-only',{
    now,fetch:async(url, options)=>{const parsed=new URL(url);assert.equal(parsed.origin,'https://api.resend.com');return originalFetch(origin+'/synthetic-provider'+parsed.pathname,options)},
  }) }
  routes.set('/api/tour-cancellation-emails',createCancellationEmailsHandler({provider,now}))
  routes.set('/api/email-reconciliation',createEmailReconciliationHandler({provider,now}))
  for (const user of ['owner-a','owner-b','staff-a','viewer-a']) {
    const response=await originalFetch(origin+'/api/dashboard',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:user,password})})
    assert.equal(response.status,303);cookies[user]=response.headers.get('set-cookie').split(';')[0];await response.text();await verifyMfaCookie(runtime,cookies[user],password)
  }
  const headers=(user='owner-a',property='property-a1',org='organization-a')=>({cookie:cookies[user]??'','x-atrium-organization-id':org,'x-atrium-property-id':property,'x-atrium-config-version':String(versions[property])})
  async function request({path='/api/tour-cancellation-emails',query,body,user='owner-a',property='property-a1',org='organization-a',extraHeaders={},method}={}) {
    const response=await originalFetch(origin+path+(query??(body===undefined&&path==='/api/tour-cancellation-emails'?'?externalId='+booking.externalId:'')),{
      method:method??(body===undefined?'GET':'POST'),headers:{...headers(user,property,org),...(body===undefined?{}:{origin,'content-type':'application/json'}),...extraHeaders},
      ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})})
    return {status:response.status,body:await response.json(),headers:response.headers}
  }
  async function saveCalendar(state,property='property-a1',org='organization-a') {
    await db.admin.query(`INSERT INTO atrium.calendars(organization_id,property_id,state) VALUES($1,$2,$3)
      ON CONFLICT(organization_id,property_id) DO UPDATE SET state=EXCLUDED.state`,[org,property,JSON.stringify(state)])
  }
  async function publish(configuration,property='property-a1',org='organization-a') {
    const version=(await db.admin.query('SELECT max(version)::int n FROM atrium.property_configurations WHERE property_id=$1',[property])).rows[0].n+1
    await db.admin.query(`INSERT INTO atrium.property_configurations(organization_id,property_id,version,status,configuration,
      inventory_read_at,inventory_source,published_at) VALUES($1,$2,$3,'published',$4,clock_timestamp(),'synthetic-cancellation',clock_timestamp())`,[org,property,version,JSON.stringify(configuration)])
    await db.admin.query('UPDATE atrium.properties SET published_configuration_version=$2 WHERE id=$1',[property,version]);versions[property]=version
  }
  async function cancel(property='property-a1',org='organization-a',user='owner-a') {
    const preview=await request({path:'/api/tour-cancellations',query:'?externalId='+booking.externalId,property,org,user});assert.equal(preview.status,200,JSON.stringify(preview.body))
    const result=await request({path:'/api/tour-cancellations',property,org,user,body:{action:'cancel',externalId:booking.externalId,
      expectedSha256:preview.body.current.expectedSha256,requestId:randomUUID(),reason:'Internal staff reason - do not email',verified:true}})
    assert.equal(result.status,200,JSON.stringify(result.body));return result.body.current
  }
  async function reset({cancelled=true}={}) {
    flags.configured=true;flags.dropQueueReply=false;flags.dropProcessReply=false;flags.dropProviderReply=false;flags.providerEvent='delivered';flags.wrongRecipient=false;flags.clockOffset=0;beforeResponse=null
    effects.clear();requests.length=0;errors.length=0
    await db.admin.query('TRUNCATE atrium.workflow_events,atrium.outbox_messages,atrium.action_intents,atrium.inbox_events,atrium.operational_documents')
    await db.admin.query("UPDATE atrium.memberships SET status='active'; UPDATE atrium.property_grants SET status='active'")
    for(const [org,property,user] of [['organization-a','property-a1','owner-a'],['organization-b','property-b1','owner-b']]) {
      await saveCalendar({bookings:[structuredClone(booking)],blocks:[]},property,org)
      await db.admin.query('UPDATE atrium.properties SET published_configuration_version=1 WHERE id=$1',[property]);versions[property]=1
      if(cancelled)await cancel(property,org,user)
    }
  }
  await reset()
  return {db,app,runtime,origin,password,cookies,flags,configurations,requests,effects,errors,booking,request,headers,reset,cancel,saveCalendar,publish,
    setBeforeResponse:fn=>{beforeResponse=fn},
    calendar:async()=> (await db.admin.query("SELECT state FROM atrium.calendars WHERE property_id='property-a1'")).rows[0].state,
    due:()=>db.admin.query("UPDATE atrium.outbox_messages SET available_at=clock_timestamp()-interval '1 second' WHERE state='verifying'"),
    async close(){server.close();server.closeAllConnections();await once(server,'close');await app.close();await db.close();originalMode===undefined?delete process.env.ATRIUM_RUNTIME_MODE:process.env.ATRIUM_RUNTIME_MODE=originalMode},
  }
  } catch(error) {
    if(server?.listening){server.close();server.closeAllConnections();await once(server,'close')}
    await app.close();await db.close();originalMode===undefined?delete process.env.ATRIUM_RUNTIME_MODE:process.env.ATRIUM_RUNTIME_MODE=originalMode
    throw error
  }
}

import { beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import handler from '../recordings.ts'
import { mintSession, mintAccountSession } from '../../src/ops/session.ts'
import { hashPassword } from '../../src/ops/accounts.ts'
const original = { ...process.env }, originalFetch = globalThis.fetch
const id = '11111111-1111-4111-8111-111111111111'
let requests: string[] = [], onFetch: (() => void) | undefined
const keys = ['ATRIUM_RUNTIME_MODE','ATRIUM_DATABASE_URL','ATRIUM_AUTH_DATABASE_URL','OPS_ACCOUNTS_JSON','OPS_SESSION_SECRET','OPS_DASHBOARD_PASSCODE','VAPI_PRIVATE_KEY','VAPI_API_KEY']
beforeEach(() => {
  for (const key of keys) delete process.env[key]
  process.env.OPS_DASHBOARD_PASSCODE = 'synthetic-passcode'; process.env.VAPI_API_KEY = 'synthetic-key'
  requests = []; onFetch = undefined
  globalThis.fetch = async url => { requests.push(String(url)); onFetch?.()
    return String(url).endsWith('/mono-recording') ? new Response(null, {status:302,headers:{location:'https://storage.vapi.ai/recording.wav?signature=synthetic'}})
      : Response.json({ id, assistantId:'synthetic-assistant' }) }
})
after(() => { globalThis.fetch=originalFetch; for(const key of keys) original[key]===undefined?delete process.env[key]:process.env[key]=original[key] })
async function request(patch: any = {}) {
  const req = { method:'GET', query:{callId:id}, headers:{cookie:'atrium_ops='+mintSession(new Date(), 'synthetic-passcode'),'x-atrium-tenant-id':'legacy'}, ...patch }
  const res = { code:0, body:undefined as any, headers:{} as any, setHeader(k:string,v:string){this.headers[k]=v}, status(v:number){this.code=v;return this}, json(v:unknown){this.body=v} }
  await handler(req,res);return res
}
test('legacy session and exact tenant header precede provider access; private responses cannot be cached', async () => {
  assert.equal((await request({headers:{}})).code,401)
  assert.equal((await request({headers:{'x-ops-passcode':'synthetic-passcode','x-atrium-tenant-id':'other'}})).code,409)
  assert.equal(requests.length,0)
  const response=await request();assert.equal(response.code,200);assert.equal(response.body.callId,id)
  assert.match(response.headers['cache-control'],/no-store/);assert.equal(response.headers['referrer-policy'],'no-referrer')
  assert.doesNotMatch(JSON.stringify(response),/synthetic-key|authorization/)
})
test('malformed IDs, duplicate values and unexpected fields do not reach Vapi', async () => {
  for(const query of [{},{callId:[id,id]},{callId:'../x'},{callId:id,url:'https://foreign.invalid'}]) assert.equal((await request({query})).code,400)
  assert.equal((await request({method:'POST'})).code,405);assert.equal(requests.length,0)
})
test('a credential change while awaiting the provider releases no recording URL', async () => {
  onFetch=()=>{process.env.OPS_DASHBOARD_PASSCODE='rotated-synthetic-passcode'}
  const result=await request();assert.equal(result.code,401);assert.equal(requests.length,1);assert.equal(result.body.url,undefined)
})
test('legacy named accounts enforce assistant ownership, empty bindings and stale tenant headers', async () => {
  const passwordHash=await hashPassword('synthetic-recording-account-password')
  const account={username:'alpha',tenantId:'tenant-alpha',displayName:'Synthetic alpha',passwordHash,assistantIds:['synthetic-assistant']}
  process.env.OPS_SESSION_SECRET='synthetic-independent-signing-key-at-least32'
  process.env.OPS_ACCOUNTS_JSON=JSON.stringify([account])
  let headers={cookie:'atrium_ops='+mintAccountSession(new Date(),account),'x-atrium-tenant-id':account.tenantId}
  assert.equal((await request({headers})).code,200)
  assert.equal((await request({headers:{...headers,'x-atrium-tenant-id':'tenant-bravo'}})).code,409)
  process.env.OPS_ACCOUNTS_JSON=JSON.stringify([{...account,assistantIds:['foreign-assistant']}])
  assert.equal((await request({headers})).code,401,'A binding change revokes the old account session')
  headers={...headers,cookie:'atrium_ops='+mintAccountSession(new Date(),{...account,assistantIds:['foreign-assistant']})}
  assert.equal((await request({headers})).code,404)
  process.env.OPS_ACCOUNTS_JSON=JSON.stringify([{...account,assistantIds:[]}]);requests=[]
  headers={...headers,cookie:'atrium_ops='+mintAccountSession(new Date(),{...account,assistantIds:[]})}
  assert.equal((await request({headers})).code,404);assert.equal(requests.length,0)
  process.env.OPS_ACCOUNTS_JSON=JSON.stringify([account])
  headers={...headers,cookie:'atrium_ops='+mintAccountSession(new Date(),account)}
  onFetch=()=>{process.env.OPS_ACCOUNTS_JSON=JSON.stringify([{...account,assistantIds:['foreign-assistant']}])}
  assert.equal((await request({headers})).code,401);assert.equal(requests.length,1)
})

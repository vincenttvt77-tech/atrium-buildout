import {before,beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createVoiceReleaseFixture} from '../helpers/voice-release-fixture.mjs'
let f
before(async()=>{f=await createVoiceReleaseFixture()})
beforeEach(async()=>{await f.reset()})
after(async()=>{await f?.close()})
const patches=()=>f.voiceRequests.filter(r=>r.method==='PATCH')
test('real HTTP/PG review and publish use the selected property and preserve its provider components',async()=>{
  const a=await f.prepare(),beforeB=structuredClone(f.saved.get('synthetic-release-assistant-b'))
  assert.equal(a.proposal.knowledgeSource,'approved-property-tools')
  assert.doesNotMatch(JSON.stringify(a),/synthetic-other-property-file/)
  assert.match(a.proposal.prompt[0].content,/America\/New_York/)
  assert.equal(patches().length,0)
  const result=await f.publish(a);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.release.state,'verified')
  assert.equal(patches().length,1);assert.deepEqual(f.saved.get('synthetic-release-assistant-b'),beforeB)
  assert.equal(Object.hasOwn(f.saved.get('synthetic-release-assistant-a').model,'knowledgeBase'),false)
  const b=await f.prepare({user:'owner-b',property:'property-b1',org:'organization-b'})
  assert.match(b.proposal.prompt[0].content,/America\/Los_Angeles/);assert.doesNotMatch(b.proposal.prompt[0].content,/The Larkin/)
  const audit=(await f.db.admin.query("SELECT actor_user_id,configuration_version FROM atrium.audit_events WHERE operation='document.update' ORDER BY created_at DESC LIMIT 1")).rows[0]
  assert.equal(audit.actor_user_id,'owner-b');assert.equal(audit.configuration_version,'1')
})
test('simultaneous actual HTTP publication claims one durable dispatch',async()=>{
  const p=await f.prepare(),replies=await Promise.all(Array.from({length:4},()=>f.publish(p)))
  assert.ok(replies.every(r=>r.status===200),JSON.stringify(replies));assert.equal(patches().length,1)
  const current=await f.request({query:'?id='+p.release.id});assert.equal(current.body.release.state,'verified')
})
test('provider lost reply and dashboard lost reply recover without repeating PATCH',async()=>{
  const p=await f.prepare();f.voiceFlags.dropWrite=true
  let drop=true;f.setBeforeResponse(({req})=>{if(drop&&req.method==='POST'&&req.url==='/api/vapi-sync'){drop=false;req.socket.destroy()}})
  await assert.rejects(f.publish(p));f.setBeforeResponse(null)
  const recovered=await f.publish(p);assert.equal(recovered.status,200);assert.equal(recovered.body.release.state,'verified');assert.equal(patches().length,1)
})
test('wrong saved route remains unconfirmed and forbids another release',async()=>{
  const p=await f.prepare();f.voiceFlags.wrongRoute=true
  const result=await f.publish(p);assert.equal(result.status,200);assert.equal(result.body.release.state,'sending');assert.equal(result.body.release.check,'differs')
  const next=await f.request({body:{action:'prepare',requestId:randomUUID()}});assert.equal(next.status,409);assert.equal(patches().length,1)
  const cancelled=await f.request({body:{action:'cancel',id:p.release.id,reviewHash:p.release.reviewHash}});assert.equal(cancelled.status,409)
})
test('retained provider knowledge stays unconfirmed and read-only recovery cannot repeat the write',async()=>{
  const p=await f.prepare();f.voiceFlags.wrongKnowledge=true
  const result=await f.publish(p)
  assert.equal(result.status,200);assert.equal(result.body.release.state,'sending');assert.equal(result.body.release.check,'differs')
  assert.equal((await f.request({body:{action:'prepare',requestId:randomUUID()}})).status,409)
  const recovered=await f.request({body:{action:'verify',id:p.release.id}})
  assert.equal(recovered.body.release.state,'sending');assert.equal(patches().length,1)
  delete f.saved.get('synthetic-release-assistant-a').model.knowledgeBase
  assert.equal((await f.request({body:{action:'verify',id:p.release.id}})).body.release.state,'verified')
  assert.equal(patches().length,1)
})
test('auth, current role, scope, JSON and exact review are required',async()=>{
  const p=await f.prepare()
  for(const [options,status] of [[{user:'anonymous'},401],[{user:'staff-a'},403],[{user:'viewer-a'},403],
    [{property:'property-b1',org:'organization-b'},403],[{extraHeaders:{origin:'https://foreign.example'}},403]])
    assert.equal((await f.publish(p,options)).status,status,JSON.stringify(options))
  const malformed=await f.request({body:{action:'publish',id:p.release.id,reviewHash:p.release.reviewHash,assistantId:'synthetic-release-assistant-b'}})
  assert.equal(malformed.status,400);assert.equal(patches().length,0)
  const b=await f.request({user:'owner-b',property:'property-b1',org:'organization-b',query:'?id='+p.release.id});assert.equal(b.status,404)
})
test('role downgrade during provider read refuses before dispatch and leaks no provider response',async()=>{
  const p=await f.prepare()
  f.voiceFlags.beforeRead=async()=>{await f.db.admin.query("UPDATE atrium.memberships SET role='staff',permission_version=permission_version+1 WHERE user_id='owner-a'")}
  const result=await f.publish(p);assert.equal(result.status,403,JSON.stringify(result.body));assert.equal(patches().length,0)
})
test('channel revocation and new published configuration fence a reviewed release',async()=>{
  const p=await f.prepare()
  f.voiceFlags.beforeRead=async()=>{await f.db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='synthetic-release-binding-a'")}
  assert.equal((await f.publish(p)).status,409);assert.equal(patches().length,0)
  await f.reset();const next=await f.prepare();await f.publishConfiguration(f.configurations['property-a1'])
  const response=await f.publish(next);assert.equal(response.status,409);assert.equal(patches().length,0)
})
test('audit failure rolls back release admission before external write',async()=>{
  const p=await f.prepare()
  await f.db.admin.query(`CREATE FUNCTION atrium.reject_voice_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='document.update' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_voice_audit BEFORE INSERT ON atrium.audit_events FOR EACH ROW EXECUTE FUNCTION atrium.reject_voice_audit()`)
  try{assert.equal((await f.publish(p)).status,503);assert.equal(patches().length,0)}
  finally{await f.db.admin.query('DROP TRIGGER reject_voice_audit ON atrium.audit_events; DROP FUNCTION atrium.reject_voice_audit()')}
  assert.equal((await f.request({query:'?id='+p.release.id})).body.release.state,'prepared')
  assert.equal((await f.publish(p)).body.release.state,'verified')
})
test('preview, backend mismatch and wrong provider account never patch',async()=>{
  const p=await f.prepare();process.env.VERCEL_ENV='preview'
  try{assert.equal((await f.publish(p)).status,409)}finally{delete process.env.VERCEL_ENV}
  f.voiceFlags.backend=false;assert.equal((await f.publish(p)).status,409);f.voiceFlags.backend=true
  f.saved.get('synthetic-release-assistant-a').orgId='wrong-provider-org';assert.equal((await f.publish(p)).status,502)
  assert.equal(patches().length,0)
})

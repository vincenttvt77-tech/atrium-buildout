import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { recordingFixture, recordingId, recordingUrl } from '../helpers/recording-fixture.mjs'
let fixture
before(async()=>{fixture=await recordingFixture()})
beforeEach(async()=>{await fixture.reset()})
after(async()=>{await fixture?.close()})
test('current viewer, staff and owner sessions can open only the matched property recording',async()=>{
  for(const user of ['viewer-a','staff-a','owner-a']){
    const result=await fixture.request({user});assert.equal(result.status,200);assert.equal(result.body.url,recordingUrl)
    assert.equal(result.body.callId,recordingId);assert.equal(result.body.scope.propertyId,'property-a1');assert.match(result.headers.get('cache-control'),/no-store/)
    assert.doesNotMatch(JSON.stringify(result.body),/synthetic-recording-key|authorization/)
  }
  assert.equal(fixture.state.requests.length,6);assert.deepEqual(fixture.state.errors,[])
})
test('signed-out, foreign-property, missing selection and stale configuration requests do not reach Vapi',async()=>{
  assert.equal((await fixture.request({user:'missing'})).status,401)
  assert.equal((await fixture.request({user:'owner-b'})).status,403)
  assert.equal((await fixture.request({headers:{'x-atrium-property-id':''}})).status,428)
  assert.equal((await fixture.request({headers:{'x-atrium-config-version':'99'}})).status,409)
  assert.equal(fixture.state.requests.length,0)
})
test('a provider call from another organization is not released even if the caller knows its UUID',async()=>{
  fixture.state.assistantId='synthetic-assistant-b'
  const denied=await fixture.request();assert.equal(denied.status,404);assert.equal(denied.body.url,undefined);assert.equal(fixture.state.requests.length,1)
  const allowed=await fixture.request({user:'owner-b',org:'organization-b',property:'property-b1'});assert.equal(allowed.status,200)
})
test('an unbound sibling property does not inherit organization-wide call access',async()=>{
  const result=await fixture.request({property:'property-a2'});assert.equal(result.status,404);assert.equal(fixture.state.requests.length,0)
})
test('membership revoked during call metadata IO prevents the second provider request',async()=>{
  fixture.state.onMetadata=()=>fixture.db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE id='member-viewer-a'")
  const result=await fixture.request({user:'viewer-a'});assert.equal(result.status,403);assert.equal(result.body.url,undefined);assert.equal(fixture.state.requests.length,1)
})
test('assistant binding changes while a recording capability is being minted release no URL',async()=>{
  fixture.state.onRecording=()=>fixture.db.admin.query("UPDATE atrium.channel_bindings SET status='inactive' WHERE id='channel-a'")
  const result=await fixture.request();assert.equal(result.status,409);assert.equal(result.body.url,undefined);assert.equal(fixture.state.requests.length,2)
})
test('a newly published property version during the provider read invalidates the old request',async()=>{
  fixture.state.onRecording=()=>fixture.db.admin.query("UPDATE atrium.properties SET published_configuration_version=2 WHERE id='property-a1'")
  const result=await fixture.request();assert.equal(result.status,409);assert.equal(result.body.url,undefined)
})
test('revoking the requesting session during provider IO releases no URL',async()=>{
  const principal=await fixture.runtime.authenticate({cookie:fixture.cookies['staff-a']},new Date())
  fixture.state.onRecording=()=>fixture.runtime.sessions.revoke(principal,principal.sessionId)
  const result=await fixture.request({user:'staff-a'});assert.ok([401,403].includes(result.status));assert.equal(result.body.url,undefined)
})
test('malformed query and unavailable or removed audio return bounded truthful errors',async()=>{
  assert.equal((await fixture.request({query:`?callId=${recordingId}&callId=${recordingId}`})).status,400)
  assert.equal((await fixture.request({query:`?callId=${recordingId}&url=https://foreign.invalid`})).status,400)
  fixture.state.recordingStatus=404;assert.equal((await fixture.request()).status,404)
  fixture.state.recordingStatus=503;assert.equal((await fixture.request()).status,503)
  fixture.state.recordingStatus=302;fixture.state.location='https://127.0.0.1/private';const result=await fixture.request();assert.equal(result.status,503);assert.equal(result.body.url,undefined)
})

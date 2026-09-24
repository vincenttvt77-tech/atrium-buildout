import { before,beforeEach,after,test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createFollowUpDecisionsFixture } from '../helpers/followup-decisions-fixture.mjs'
let f
before(async()=>{f=await createFollowUpDecisionsFixture()})
beforeEach(async()=>{await f.reset()})
after(async()=>{await f?.close()})
test('HTTP staff completion is scoped, audited, source-preserving and sends nothing',async()=>{
  const before=await f.raw(),foreign=await f.raw('property-b1'),calendar=await f.calendar()
  const result=await f.request({user:'staff-a',body:f.command(await f.current())})
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.decision.actorId,'staff-a')
  assert.equal(result.body.followUp.status,'done');assert.equal(result.body.replayed,false)
  assert.equal(result.body.followUp.staffDecisions.length,1)
  assert.deepEqual({...await f.raw(),status:before.status,staffDecisions:undefined},{...before,staffDecisions:undefined})
  assert.deepEqual(await f.raw('property-b1'),foreign);assert.deepEqual(await f.calendar(),calendar);assert.equal(f.requests.length,0)
  const audit=await f.db.admin.query('SELECT actor_user_id FROM atrium.audit_events WHERE record_key=$1 ORDER BY created_at DESC',
    ['sha256:'+createHash('sha256').update('followup:'+f.row.id).digest('hex')])
  assert.equal(audit.rows[0].actor_user_id,'staff-a');assert.match(result.headers.get('cache-control'),/no-store/)
})
test('simultaneous identical retries commit one decision; different staff decisions have one winner',async()=>{
  const command=f.command(await f.current()),replies=await Promise.all(Array.from({length:4},()=>f.request({body:command})))
  assert.ok(replies.every(r=>r.status===200),JSON.stringify(replies));assert.equal(replies.filter(r=>!r.body.replayed).length,1)
  assert.equal((await f.raw()).staffDecisions.length,1)
  await f.reset();const current=await f.current()
  const race=await Promise.all([f.request({body:f.command(current)}),f.request({user:'staff-a',body:f.command(current,'skipped')})])
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal((await f.raw()).staffDecisions.length,1)
})
test('stale Undo and changed source are refused; old lost-reply recovery preserves the newest decision',async()=>{
  const original=f.command(await f.current()),first=await f.request({body:original})
  const oldUndo=f.command(first.body.followUp,'scheduled')
  assert.equal((await f.request({user:'staff-a',body:f.command(await f.current(),'skipped')})).status,200)
  assert.equal((await f.request({body:oldUndo})).status,409)
  const recovered=await f.request({body:original});assert.equal(recovered.status,200);assert.equal(recovered.body.replayed,true)
  assert.equal(recovered.body.decision.to,'done');assert.equal(recovered.body.followUp.status,'skipped')
  assert.equal(recovered.body.followUp.staffDecisions.length,2)
  const stale=f.command(await f.current(),'scheduled');await f.save({...await f.raw(),reason:'Updated caller context'})
  assert.equal((await f.request({body:stale})).status,409)
})
test('a socket lost after commit recovers through the identical command without a second decision',async()=>{
  const command=f.command(await f.current());let drop=true
  f.setBeforeResponse(({req})=>{if(drop&&req.method==='POST'&&req.url==='/api/leads'){drop=false;req.socket.destroy()}})
  await assert.rejects(f.request({body:command}));f.setBeforeResponse(null)
  const reply=await f.request({body:command});assert.equal(reply.status,200);assert.equal(reply.body.replayed,true)
  assert.equal((await f.raw()).staffDecisions.length,1)
})
test('sign-in, current role, property/organization and CSRF constrain decisions and replays',async()=>{
  const command=f.command(await f.current())
  for(const [options,status] of [[{user:'anonymous'},401],[{user:'viewer-a'},403],
    [{property:'property-b1',org:'organization-b'},403],[{extraHeaders:{origin:'https://foreign.example.test'}},403]])
    assert.equal((await f.request({...options,body:command})).status,status)
  assert.equal((await f.request({body:command})).status,200)
  await f.db.admin.query("UPDATE atrium.memberships SET status='revoked' WHERE user_id='owner-a'")
  assert.equal((await f.request({body:command})).status,403)
})
test('current configuration and actor identity cannot be bypassed using a previous receipt',async()=>{
  const command=f.command(await f.current());assert.equal((await f.request({body:command})).status,200)
  assert.equal((await f.request({user:'staff-a',body:command})).status,409)
  await f.publish(f.configurations['property-a1'])
  assert.equal((await f.request({body:command,extraHeaders:{'x-atrium-config-version':'1'}})).status,409)
})
test('strict command fields, missing revision and deleted rows refuse mutation without recreation',async()=>{
  const command=f.command(await f.current())
  for(const change of [{requestId:''},{expectedSha256:null},{status:'other'},{id:['fu-wrong']},{actorId:'other'},{tenantId:'foreign'}])
    assert.equal((await f.request({body:{...command,...change}})).status,400)
  await f.db.admin.query('DELETE FROM atrium.operational_documents WHERE property_id=$1 AND key=$2',['property-a1','followup:'+f.row.id])
  assert.equal((await f.request({body:command})).status,404);assert.equal(await f.raw(),undefined)
})
test('audit failure rolls back status and acknowledgement together; retry later completes',async()=>{
  const before=await f.raw(),command=f.command(await f.current())
  await f.db.admin.query(`CREATE FUNCTION atrium.reject_followup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.operation='document.update' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_followup_audit BEFORE INSERT ON atrium.audit_events FOR EACH ROW EXECUTE FUNCTION atrium.reject_followup_audit()`)
  try{assert.equal((await f.request({body:command})).status,503);assert.deepEqual(await f.raw(),before)}
  finally{await f.db.admin.query('DROP TRIGGER reject_followup_audit ON atrium.audit_events; DROP FUNCTION atrium.reject_followup_audit()')}
  assert.equal((await f.request({body:command})).status,200);assert.equal((await f.raw()).staffDecisions.length,1)
})
test('all lead mutations reject cross-site and non-JSON browser submissions before writes',async()=>{
  const before=await f.raw()
  for(const action of ['followup_status','note','unit_feedback_add','unit_feedback_edit','review_tour_change','clear_leads']) {
    for(const extraHeaders of [{origin:'https://foreign.example.test'},{origin:''},{'content-type':'text/plain'},{'sec-fetch-site':'cross-site'}]) {
      const result=await f.request({body:{...f.command(await f.current()),action},extraHeaders})
      assert.equal(result.status,403,JSON.stringify({action,extraHeaders,result}));assert.equal(result.body.code,'staff_request_invalid')
    }
  }
  assert.deepEqual(await f.raw(),before)
})

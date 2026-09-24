import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { decideFollowUp, followUpFingerprint, presentFollowUp } from '../followup-decisions.ts'
import type { FollowUp } from '../followups.ts'
const row: FollowUp = { id:'fu-synthetic',phone:'+12025550101',kind:'callback',channel:'call',dueAt:'2032-01-01T14:00:00Z',
  reason:'Caller requested staff',status:'scheduled',createdAt:'2032-01-01T13:00:00Z',createdFromCall:'synthetic-call',executable:false }
const actor = {id:'staff-a',label:'Synthetic Staff'}, at=new Date('2032-01-01T14:00:00Z'), key='followup:'+row.id
async function fixture() { const store=new MemoryDocumentStore();await store.set(key,row);return store }
const command=(f:FollowUp,id='command-one',status:FollowUp['status']='done')=>({id:f.id,requestId:id,status,expectedSha256:followUpFingerprint(f)})
test('follow-up decisions retain provenance, actor, exact retry and canonical JSONB fingerprint',async()=>{
  const store=await fixture(),input=command(row),first=await decideFollowUp(store,input,actor,at)
  assert.equal(first.replayed,false);assert.equal(first.followUp.status,'done');assert.equal(first.decision.actorId,actor.id)
  assert.deepEqual(await decideFollowUp(store,input,actor,at),{...first,replayed:true})
  const saved=await store.get<FollowUp>(key)
  assert.deepEqual({...saved,status:row.status,staffDecisions:undefined},{...row,staffDecisions:undefined})
  assert.equal(followUpFingerprint(row),followUpFingerprint(Object.fromEntries(Object.entries(row).reverse()) as unknown as FollowUp))
  assert.equal(presentFollowUp(row).expectedSha256,input.expectedSha256)
})
test('stale completion and stale Undo cannot overwrite a newer staff decision',async()=>{
  const store=await fixture(),done=await decideFollowUp(store,command(row),actor,at)
  const raw=await store.get<FollowUp>(key)
  await decideFollowUp(store,command(raw!,'command-two','skipped'),{id:'staff-b',label:'Other Staff'},at)
  await assert.rejects(decideFollowUp(store,{...command(row),requestId:'new-command'},actor,at),{code:'followup_changed'})
  await assert.rejects(decideFollowUp(store,{id:row.id,status:'scheduled',requestId:'undo',expectedSha256:done.followUp.expectedSha256},actor,at),{code:'followup_changed'})
  assert.equal((await store.get<FollowUp>(key))!.status,'skipped')
})
test('recovering a lost reply returns the original receipt and preserves newer status/history',async()=>{
  const store=await fixture(),input=command(row);const first=await decideFollowUp(store,input,actor,at)
  const latest=await store.get<FollowUp>(key);await decideFollowUp(store,command(latest!,'second','scheduled'),actor,at)
  const recovered=await decideFollowUp(store,input,actor,at)
  assert.equal(recovered.replayed,true);assert.deepEqual(recovered.decision,first.decision)
  assert.equal(recovered.followUp.status,'scheduled');assert.equal(recovered.followUp.staffDecisions!.length,2)
})
test('same request ID cannot change purpose or actor',async()=>{
  const store=await fixture(),input=command(row);await decideFollowUp(store,input,actor,at)
  for(const changed of [{...input,status:'skipped' as const},{...input,expectedSha256:'0'.repeat(64)}])
    await assert.rejects(decideFollowUp(store,changed,actor,at),{code:'followup_changed'})
  await assert.rejects(decideFollowUp(store,input,{id:'someone-else',label:'Someone'},at),{code:'followup_changed'})
})
test('changed source or supersession fences writes; deleted tasks are never recreated',async()=>{
  const store=await fixture(),input=command(row)
  await store.set(key,{...row,reason:'Different caller instructions'})
  await assert.rejects(decideFollowUp(store,input,actor,at),{code:'followup_changed'})
  const retired:FollowUp={...row,status:'skipped',superseded:{reason:'tour_cancelled',bookingExternalId:'tour',revision:1,requestId:'cancel',at:at.toISOString()}}
  await store.set(key,retired)
  await assert.rejects(decideFollowUp(store,command(retired,'reopen','scheduled'),actor,at),{code:'tour_reminder_superseded'})
  await store.delete(key);await assert.rejects(decideFollowUp(store,input,actor,at),{code:'followup_not_found'})
  assert.equal(await store.get(key),null)
})
test('malformed commands/history refuse writes and same-status changes are not new decisions',async()=>{
  const store=await fixture(),input=command(row)
  for(const changed of [{...input,requestId:''},{...input,expectedSha256:'bad'},{...input,status:'other'}])
    await assert.rejects(decideFollowUp(store,changed as typeof input,actor,at),{code:'followup_command_invalid'})
  await assert.rejects(decideFollowUp(store,command(row,'same','scheduled'),actor,at),{code:'followup_changed'})
  await store.set(key,{...row,staffDecisions:[{}]})
  await assert.rejects(decideFollowUp(store,input,actor,at),{code:'followup_record_invalid'})
})
test('history capacity preserves every acknowledgement and exact retry without silent eviction',async()=>{
  const store=await fixture();let last=command(row)
  for(let i=0;i<100;i++) {
    last=command((await store.get<FollowUp>(key))!,'decision-'+i,i%2?'scheduled':'done')
    await decideFollowUp(store,last,actor,at)
  }
  const saved=(await store.get<FollowUp>(key))!
  await assert.rejects(decideFollowUp(store,command(saved,'one-too-many','done'),actor,at),{code:'followup_history_full'})
  assert.deepEqual(await store.get(key),saved);assert.equal((await decideFollowUp(store,last,actor,at)).replayed,true)
})

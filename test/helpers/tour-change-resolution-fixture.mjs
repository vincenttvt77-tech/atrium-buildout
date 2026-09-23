import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createCancellationEmailFixture } from './cancellation-email-fixture.mjs'
import { resolveOpsRuntime } from '../../src/application/runtime.ts'
import { recordTourChangeRequest, tourChangeRequestKey } from '../../src/leads/tour-change.ts'
import { consolidateCall } from '../../src/leads/consolidate.ts'

export async function createTourChangeResolutionFixture() {
  const f = await createCancellationEmailFixture({extraRoutes:['tour-change-resolutions']})
  const id = tourChangeRequestKey('synthetic-change-call')
  const context = (property='property-a1',org='organization-a',user='owner-a') => resolveOpsRuntime({
    headers:f.headers(user,property,org),atriumRuntime:f.runtime,
  },'operate')
  async function evidence(excerpt='Please move my tour to another day.',options={}) {
    const c = await context(options.property,options.org,options.user)
    return recordTourChangeRequest(c.documents,{callId:'synthetic-change-call',at:options.at??new Date(),
      reason:'caller_requested',excerpt,name:options.name??'Test Visitor',phone:options.phone??'+12025550101'})
  }
  const request = options => f.request({path:'/api/tour-change-resolutions',query:options?.body===undefined?'?id='+id:undefined,...options})
  const command = (preview,outcome='no_change') => ({action:'resolve',id,requestId:randomUUID(),
    expectedRevision:preview.request.revision,expectedSha256:preview.expectedSha256,outcome,
    sourceSha256:outcome==='no_change'?null:preview.candidates.find(c=>c.outcome===outcome)?.source.sha256,
    note:'Verified caller and the correct reservation',verified:true})
  async function reset() {
    await f.reset({cancelled:false})
    for(const [property,org,user] of [['property-a1','organization-a','owner-a'],['property-b1','organization-b','owner-b']])
      await evidence(undefined,{property,org,user,at:new Date(Date.now()-60000)})
  }
  async function reschedule() {
    const c=await context(),b=(await f.calendar()).bookings[0]
    await c.documents.transaction(store=>consolidateCall(store,{callId:b.interactionId,phone:b.prospectPhone,at:new Date(b.bookedAt),durationSeconds:60,
      qualification:{},name:b.prospectName,email:b.prospectEmail,unitsDiscussed:[],booking:{externalId:b.externalId,
        slotId:b.slotId,startsAt:b.startsAt,endsAt:b.endsAt,unitId:b.unitId,status:'confirmed'},lossReason:null,escalation:null,toolsCalled:['book_tour']},'America/New_York'))
    const start = new Date(f.booking.startsAt); start.setUTCDate(start.getUTCDate()+1); start.setUTCHours(16,0,0,0)
    const result=await f.request({path:'/api/calendar',body:{action:'reschedule',externalId:f.booking.externalId,
      requestId:randomUUID(),expectedRevision:(await f.calendar()).bookings[0].revision,
      slotId:'slot-'+start.toISOString().slice(0,16),unitId:null,expectedTimeZone:'America/New_York'}})
    assert.equal(result.status,200,JSON.stringify(result.body.reschedule??result.body)); return result
  }
  await reset()
  return {...f,id,context,evidence,request,command,reset,reschedule}
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { recordTourChangeRequest, checkedTourChangeRequest, reviewTourChangeRequest, type TourChangeRequest, type TourChangeResolution } from '../tour-change.ts'
import { tourChangeCandidates } from '../tour-change-resolution.ts'
import type { CalendarState, SlotBooking } from '../../calendar/types.ts'

const first = new Date('2032-06-01T12:00:00.000Z'), now = new Date('2032-06-01T14:00:00.000Z')
const slot = {slotId:'slot-2032-06-02T14:00',startsAt:'2032-06-02T14:00:00.000Z',endsAt:'2032-06-02T14:30:00.000Z',unitId:'19A'}
const booking = ():SlotBooking => ({...slot,externalId:'tour-one',prospectName:'Test Visitor',prospectPhone:'+12025550101',prospectEmail:null,
  bookedAt:first.toISOString(),revision:1,rescheduleHistory:[{requestId:'move-one',revision:1,actorId:'staff',timeZone:'America/New_York',
    at:'2032-06-01T13:00:00.000Z',from:{...slot,unitId:'12A'},to:{...slot},projection:'complete'}]})
async function fixture() {
  const store=new MemoryDocumentStore(),request=await recordTourChangeRequest(store,{callId:'change-call',at:first,reason:'caller_requested',excerpt:'Please move my tour'})
  return {store,request}
}
const outcome = (r:TourChangeRequest):TourChangeResolution => ({requestId:'decision-one',requestRevision:r.revision,actorId:'staff',at:now.toISOString(),note:'Caller kept the existing tour',
  outcome:'no_change',source:null,association:'staff_decision',notification:'not_sent_by_resolution'})

test('only an exact current, completely reconciled reschedule can support an outcome',async()=>{
  const {request}=await fixture(),state:CalendarState={bookings:[booking()],blocks:[]}
  assert.equal(tourChangeCandidates(state,request,now).length,1)
  for(const change of [(b:SlotBooking)=>b.revision=2,(b:SlotBooking)=>b.unitId='12B',
    (b:SlotBooking)=>b.rescheduleHistory![0]!.projection='pending',(b:SlotBooking)=>b.rescheduleHistory![0]!.at='2032-06-01T15:00:00.000Z',
    (b:SlotBooking)=>b.rescheduleHistory![0]!.at='2032-06-01T11:00:00.000Z']) {
    const b=booking();change(b);assert.equal(tourChangeCandidates({bookings:[b],blocks:[]},request,now).length,0)
  }
  assert.equal(tourChangeCandidates({bookings:[booking(),booking()],blocks:[]},request,now).length,0)
})
test('source fingerprints include contact and exact calendar evidence; no caller-ID match is inferred',async()=>{
  const {request}=await fixture(),a=booking(),b=booking();b.prospectPhone='+12025550999'
  const one=tourChangeCandidates({bookings:[a],blocks:[]},request,now),two=tourChangeCandidates({bookings:[b],blocks:[]},request,now)
  assert.equal(two.length,1);assert.notEqual(one[0]!.source.sha256,two[0]!.source.sha256)
})
test('review time does not replace caller-evidence time; legacy evidence falls back conservatively',async()=>{
  const {request,store}=await fixture()
  const reviewed=await reviewTourChangeRequest(store,{id:request.id,expectedRevision:0,actorId:'staff',at:now})
  assert.equal(tourChangeCandidates({bookings:[booking()],blocks:[]},reviewed,now).length,1)
  delete reviewed.lastRequestedAt
  assert.equal(tourChangeCandidates({bookings:[booking()],blocks:[]},reviewed,now).length,0)
})
test('new caller evidence reopens resolved requests, retains decisions, and excludes older saved changes',async()=>{
  const {request,store}=await fixture(),resolved=checkedTourChangeRequest({...request,status:'resolved',revision:1,lastUpdatedAt:now.toISOString(),resolutions:[outcome(request)]})
  await store.set(request.id,resolved)
  const replay=await recordTourChangeRequest(store,{callId:request.callId,at:new Date(now.getTime()+1000),reason:'caller_requested',excerpt:request.excerpts[0]!})
  assert.deepEqual(replay,resolved)
  const reopened=await recordTourChangeRequest(store,{callId:request.callId,at:new Date(now.getTime()+2000),reason:'caller_requested',excerpt:'Please cancel my tour instead'})
  assert.equal(reopened.status,'pending');assert.equal(reopened.revision,2);assert.deepEqual(reopened.resolutions,resolved.resolutions)
  assert.equal(tourChangeCandidates({bookings:[booking()],blocks:[]},reopened,new Date(now.getTime()+3000)).length,0)
  const delayed=await recordTourChangeRequest(store,{callId:request.callId,at:first,reason:'caller_requested',excerpt:'An older unprocessed instruction'})
  assert.equal(delayed.status,'pending');assert.equal(delayed.lastRequestedAt,reopened.lastRequestedAt)
  assert.ok(delayed.excerpts.includes('An older unprocessed instruction'))
})
test('resolved records require a valid ordered decision and cannot be downgraded by review',async()=>{
  const {request,store}=await fixture(),resolved:TourChangeRequest={...request,status:'resolved',revision:1,lastUpdatedAt:now.toISOString(),resolutions:[outcome(request)]}
  for(const change of [(r:TourChangeRequest)=>r.resolutions=[],(r:TourChangeRequest)=>r.resolutions![0]!.requestRevision=1,
    (r:TourChangeRequest)=>r.resolutions!.push(outcome(request)),(r:TourChangeRequest)=>r.resolutions![0]!.note='',
    (r:TourChangeRequest)=>r.resolutions![0]!.actorId='x'.repeat(257)]) {
    const copy=structuredClone(resolved);change(copy);assert.throws(()=>checkedTourChangeRequest(copy))
  }
  await store.set(request.id,resolved)
  await assert.rejects(reviewTourChangeRequest(store,{id:request.id,expectedRevision:1,actorId:'staff',at:now}),/tour_change_conflict/)
})

test('legacy delayed timestamps remain readable while new evidence and staff review cannot move the boundary backwards',async()=>{
  const {request,store}=await fixture(),legacy={...request,lastUpdatedAt:'2032-06-01T11:00:00.000Z'}
  delete legacy.lastRequestedAt
  checkedTourChangeRequest(legacy);await store.set(request.id,legacy)
  await assert.rejects(reviewTourChangeRequest(store,{id:request.id,expectedRevision:0,actorId:'staff',at:new Date('2032-06-01T10:00:00.000Z')}),/tour_change_conflict/)
  assert.deepEqual(await store.get(request.id),legacy)
  const updated=await recordTourChangeRequest(store,{callId:request.callId,at:new Date(legacy.lastUpdatedAt),reason:'caller_requested',excerpt:'Delayed additional instructions'})
  assert.equal(updated.lastRequestedAt,first.toISOString());checkedTourChangeRequest(updated)
})

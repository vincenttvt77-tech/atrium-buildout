import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareTourConfirmation, tourEmailBinding } from '../tour-confirmation.ts'
import type { CalendarState } from '../../calendar/types.ts'
import type { PropertySnapshot } from '../../properties/model.ts'
const now = new Date('2026-09-22T12:00:00Z')
const config = () => ({ organizationId:'org-a',propertyId:'prop-a',version:1,timeZone:'America/New_York',
  property:{ buildingName:'Test Building',address:'1 Test Avenue',tourConfirmationEmail:{ provider:'resend',organizationId:'org-a',propertyId:'prop-a',
    from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',reviewExpiresAt:'2026-09-29T12:00:00Z' } } }) as unknown as PropertySnapshot
const state = (): CalendarState => ({ blocks:[],bookings:[{ externalId:'tour-1',slotId:'slot-2026-09-23T14:00',startsAt:'2026-09-23T14:00:00Z',endsAt:'2026-09-23T14:30:00Z',
  prospectName:'Visitor <script>',prospectEmail:'visitor@example.test',prospectPhone:'+12025550101',unitId:'19A',bookedAt:now.toISOString(),revision:0 }] })
test('confirmed tour preview uses property timezone and safely renders names without pricing guesses',()=>{
  const draft=prepareTourConfirmation(state(),config(),'tour-1',now)
  assert.match(draft.body,/10:00 AM/); assert.match(draft.body,/America\/New_York/)
  assert.match(draft.message!.html,/Visitor &lt;script&gt;/); assert.doesNotMatch(draft.message!.html,/<script>/)
  assert.equal(draft.recipient,'visitor@example.test')
  assert.equal(prepareTourConfirmation(state(),config(),'tour-1',new Date(now.getTime()+1000)).bookingSha256,draft.bookingSha256)
  const updated=state(); updated.bookings[0]!.revision=1
  assert.notEqual(prepareTourConfirmation(updated,config(),'tour-1',now).bookingSha256,draft.bookingSha256)
})
test('unknown exact times, missing email and past tours cannot produce an actionable confirmation',()=>{
  for(const change of [(s:CalendarState)=>{delete s.bookings[0]!.endsAt},(s:CalendarState)=>{s.bookings[0]!.prospectEmail=null},(s:CalendarState)=>{s.bookings=[]}]){
    const s=state();change(s);assert.throws(()=>prepareTourConfirmation(s,config(),'tour-1',now))
  }
  assert.throws(()=>prepareTourConfirmation(state(),config(),'tour-1',new Date('2026-10-01')),/future/)
})
test('missing, expired, foreign and unsafe sending configuration never enables delivery',()=>{
  for(const patch of [{propertyId:'other'},{organizationId:'other'},{provider:'other'},{from:'Bad\n <x@example.test>'},
    {replyTo:'x@example.test,y@example.test'},{reviewExpiresAt:now.toISOString()},{reviewExpiresAt:'2030-01-01T00:00:00Z'}]){
    const snapshot=config();Object.assign(snapshot.property.tourConfirmationEmail as object,patch)
    assert.equal(tourEmailBinding(snapshot,now),null)
    assert.equal(prepareTourConfirmation(state(),snapshot,'tour-1',now).message,null)
  }
  const snapshot=config();delete snapshot.property.tourConfirmationEmail
  assert.equal(tourEmailBinding(snapshot,now),null)
})
test('a unit hold overlapping reserved preparation time prevents confirmation',()=>{
  const s=state();s.bookings[0]!.occupiedStartsAt='2026-09-23T13:45:00Z'
  s.unitBlocks=[{id:'hold',requestId:'fixture',unitId:'19A',date:'2026-09-23',endDate:'2026-09-23',allDay:false,
    startsAt:'2026-09-23T13:45:00Z',endsAt:'2026-09-23T13:50:00Z',reason:'Painting',blockedAt:now.toISOString(),timeZone:'America/New_York',revision:0}]
  assert.throws(()=>prepareTourConfirmation(s,config(),'tour-1',now),/availability hold/)
  s.unitBlocks[0]!.unitId='20B';assert.ok(prepareTourConfirmation(s,config(),'tour-1',now).message)
})

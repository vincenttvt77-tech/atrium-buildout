import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareCancellationEmail } from '../tour-cancellation.ts'
import type { CalendarState } from '../../calendar/types.ts'
import type { PropertySnapshot } from '../../properties/model.ts'
const now = new Date('2026-09-23T12:00:00Z')
const config = () => ({ organizationId:'org-a',propertyId:'prop-a',version:1,timeZone:'America/New_York',
  property:{buildingName:'Test Building',tourCancellationEmail:{provider:'resend',organizationId:'org-a',propertyId:'prop-a',
    from:'Leasing <leasing@example.test>',replyTo:'leasing@example.test',reviewExpiresAt:'2026-09-29T12:00:00Z'}} }) as unknown as PropertySnapshot
const state = (): CalendarState => ({bookings:[],blocks:[],cancelledBookings:[{format:'tour-cancellation-v1',requestId:'cancellation-1',
  actorId:'staff-1',at:now.toISOString(),reason:'Internal private staff note',interactionIds:['call-1'],notification:'not_sent',
  booking:{externalId:'tour-1',slotId:'slot-2026-09-24T14:00',startsAt:'2026-09-24T14:00:00Z',endsAt:'2026-09-24T14:30:00Z',
    prospectName:'Visitor <script>',prospectEmail:'visitor@example.test',prospectPhone:'+12025550101',unitId:'19A',bookedAt:now.toISOString(),revision:0}}]})

test('cancellation copy uses the exact saved time and unit, omits private reason and escapes HTML',()=>{
  const draft=prepareCancellationEmail(state(),config(),'tour-1',now)
  assert.match(draft.body,/10:00 AM.*America\/New_York/);assert.match(draft.body,/Residence 19A/)
  assert.match(draft.message!.html,/Visitor &lt;script&gt;/);assert.doesNotMatch(draft.message!.html,/<script>|Internal private|12025550101/)
  assert.match(draft.body,/does not reserve a replacement/)
})
test('a cancellation remains truthful after its scheduled tour time has passed',()=>{
  const later=new Date('2026-09-25T12:00:00Z')
  assert.ok(prepareCancellationEmail(state(),config(),'tour-1',later).message)
})
test('unknown or duplicate cancellation, active source conflict and missing exact time refuse a draft',()=>{
  assert.throws(()=>prepareCancellationEmail(state(),config(),'unknown',now))
  const duplicate=state();duplicate.cancelledBookings!.push(duplicate.cancelledBookings![0]!)
  assert.throws(()=>prepareCancellationEmail(duplicate,config(),'tour-1',now))
  const active=state();active.bookings.push(active.cancelledBookings![0]!.booking)
  assert.throws(()=>prepareCancellationEmail(active,config(),'tour-1',now),/status needs staff review/)
  const missing=state();delete missing.cancelledBookings![0]!.booking.startsAt
  assert.throws(()=>prepareCancellationEmail(missing,config(),'tour-1',now),/details need review/)
})
test('wrong-purpose, expired, foreign or unsafe sender does not enable cancellation email',()=>{
  for(const patch of [{propertyId:'other'},{organizationId:'other'},{provider:'other'},{from:'Bad\n <x@example.test>'},
    {replyTo:'x@example.test,y@example.test'},{reviewExpiresAt:now.toISOString()}]){
    const snapshot=config();Object.assign(snapshot.property.tourCancellationEmail as object,patch)
    assert.equal(prepareCancellationEmail(state(),snapshot,'tour-1',now).message,null)
  }
  const snapshot=config();snapshot.property.tourConfirmationEmail=snapshot.property.tourCancellationEmail;delete snapshot.property.tourCancellationEmail
  assert.equal(prepareCancellationEmail(state(),snapshot,'tour-1',now).message,null)
})
test('a malformed recipient and invalid clock cannot produce a reviewable message',()=>{
  const invalid=state();invalid.cancelledBookings![0]!.booking.prospectEmail='not-an-email'
  assert.throws(()=>prepareCancellationEmail(invalid,config(),'tour-1',now),/valid saved email/)
  assert.throws(()=>prepareCancellationEmail(state(),config(),'tour-1',new Date(NaN)),/clock/)
})

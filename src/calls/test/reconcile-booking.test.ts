import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { MemoryCalendarStore } from '../../calendar/store.ts'
import { storeBackedCalendar } from '../../calendar/port.ts'
import { reconcileRescheduledTour } from '../../leads/reschedule.ts'
import { rescheduleBooking, completeRescheduleProjection } from '../../calendar/reschedule.ts'
import { emptyQualification } from '../../leasing/qualification.ts'
import { initializeCallLifecycle, admitToolBatch, markToolDispatch, completeToolBatch, requestCallEnd,
  hashCallToolArgs, freezeCall } from '../lifecycle.ts'
import { recordBookingReview, getBookingReview } from '../booking-review.ts'
import { projectFrozenCall, type CallState } from '../completion.ts'
import { reconcileBookingReview, type ReconcileBookingReviewInput } from '../reconcile-booking.ts'
import type { SlotBooking, BookingReviewAttempt } from '../../calendar/types.ts'
import { calendarBookingReviewForCall } from '../../calendar/booking-review.ts'
import type { LeadProfile } from '../../leads/profile.ts'
import { receiptKey, type CallReceipt } from '../../leads/inbox.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const now = new Date('2032-06-01T10:00:00.000Z'), callId = 'reviewed-call', phone = '+15555550101'
const attempt: BookingReviewAttempt = { externalId: `property-a1|${phone}|slot-2032-06-01T14:00`, slotId: 'slot-2032-06-01T14:00',
  startsAt: '2032-06-01T14:00:00.000Z', endsAt: '2032-06-01T14:30:00.000Z', unitId: '12A' }
const provenance = { tenantId: 'review-tenant', timeZone: 'America/Chicago' }
function call(status: 'needs_review' | 'dispatch_started' = 'needs_review'): CallState {
  let work = initializeCallLifecycle({ now: now.toISOString(), provenance })
  work = admitToolBatch(work, { token: 'admission-one', now: now.toISOString(), provenance,
    tools: [{ id: 'booking-tool', name: 'book_tour', argsHash: hashCallToolArgs({ slotId: attempt.slotId, unitId: attempt.unitId }) }] }).work
  work = markToolDispatch(work, { token: 'admission-one', toolId: 'booking-tool', now: now.toISOString() })
  if (status === 'needs_review') work = completeToolBatch(work, { token: 'admission-one', now: now.toISOString(),
    results: [{ toolId: 'booking-tool', result: 'This booking could not be verified.', outcome: 'needs_review' }] })
  work = requestCallEnd(work, { now: now.toISOString(), provenance, metadata: { eventKey: 'end-report-one', reportedPhone: phone, durationSeconds: 40 } })
  return { qualification: emptyQualification(), phone, name: 'Synthetic visitor', email: 'synthetic@example.test', unitsDiscussed: ['12A'],
    booking: { ...attempt, status: 'arranging' }, bookingAttempt: { ...attempt, toolId: 'booking-tool' },
    lossReason: null, escalation: null, emergency: null, toolsCalled: ['book_tour'], work,
    callbackPhone: { value: '+15555550999', excerpt: 'Use this callback number.', callId, at: now.toISOString(), confidence: 1 } }
}
const booking = (): SlotBooking => ({ ...attempt, prospectName: 'Synthetic visitor', prospectPhone: phone,
  prospectEmail: 'synthetic@example.test', interactionId: callId, bookedAt: now.toISOString() })
async function fixture(exists = true, state = call()) {
  const documents = new MemoryDocumentStore(), calendar = new MemoryCalendarStore()
  await documents.set(`call:${callId}`, state)
  await recordBookingReview(documents, { ...state, callId, now })
  if (exists) await calendar.mutate(current => ({ ...current, bookings: [booking()] }))
  const input: ReconcileBookingReviewInput = { callId, sourceRevision: state.work!.revision, requestId: 'review-request-one', actorId: 'staff-one', now,
    scope: { tenantId: provenance.tenantId } }
  return { documents, calendar, input }
}
const expectedError = (code: string) => ({ code })

test('staff verifies existing tour, completes lead/receipt/callback work and closes review without creating anything', async () => {
  const { documents, calendar, input } = await fixture()
  const result = await reconcileBookingReview(calendar, documents, input)
  assert.equal(result.status, 'complete'); assert.equal(result.notificationSent, false)
  assert.equal(result.bookingReview.needsReview, false); assert.equal(result.bookingReview.resolution?.outcome, 'confirmed')
  assert.equal(result.bookingReview.resolution?.projection, 'complete')
  const completed = (await documents.get<CallState>(`call:${callId}`))!
  assert.equal(completed.work?.phase, 'complete'); assert.equal(completed.bookingReviewWork?.requestId, input.requestId)
  assert.equal(JSON.parse(completed.work!.intents[0]!.result!).decision, 'staff_booking_review')
  const profile = (await documents.get<LeadProfile>(`lead:${phone}`))!
  assert.equal(profile.calls.length, 1); assert.equal(profile.bookings[0]?.status, 'confirmed')
  assert.equal(profile.callbackPhone?.value, '+15555550999'); assert.equal(profile.phone, phone)
  assert.equal((await documents.get<CallReceipt>(receiptKey(callId)))?.status, 'complete')
  assert.equal((await documents.get<CallReceipt>(receiptKey(callId)))?.timeZone, 'America/Chicago')
  assert.equal((await calendar.read()).bookings.length, 1)
  assert.ok((await documents.list('followup:')).length > 0)
})

test('fenced absence produces contact follow-up and never claims or creates a reservation', async () => {
  const { documents, calendar, input } = await fixture(false)
  const result = await reconcileBookingReview(calendar, documents, input)
  assert.equal(result.bookingReview.resolution?.outcome, 'not_booked')
  assert.equal((await calendar.read()).bookings.length, 0)
  const profile = (await documents.get<LeadProfile>(`lead:${phone}`))!
  assert.equal(profile.bookings[0]?.status, 'failed'); assert.equal(profile.escalations[0]?.trigger, 'booking_failed')
  assert.ok((await documents.list('followup:')).length > 0)
})

test('ended dispatch-started attempt is recovered with exact evidence rather than left stranded after worker loss', async () => {
  const { documents, calendar, input } = await fixture(true, call('dispatch_started'))
  assert.equal((await reconcileBookingReview(calendar, documents, input)).status, 'complete')
  assert.equal((await documents.get<CallState>(`call:${callId}`))?.work?.phase, 'complete')
})

test('active call, other pending work, missing dispatch evidence, stale revision and foreign scope refuse before fence', async () => {
  for (const mutate of [
    (state: CallState) => { state.work!.end = null; state.work!.phase = 'needs_review' },
    (state: CallState) => { state.work!.intents.push({ ...state.work!.intents[0]!, id: 'another-booking' }) },
    (state: CallState) => { delete state.bookingAttempt },
    (state: CallState) => { state.work!.revision++ },
    (state: CallState) => { state.work!.provenance = { tenantId: 'foreign-tenant', timeZone: 'America/Chicago' } },
    (state: CallState) => { state.work!.provenance = null },
    (state: CallState) => { state.completedAt = now.toISOString() },
  ]) {
    const { documents, calendar, input } = await fixture()
    const changed = call(); mutate(changed); await documents.set(`call:${callId}`, changed)
    await assert.rejects(reconcileBookingReview(calendar, documents, input))
    assert.equal((await calendar.read()).bookingReviewResolutions, undefined)
    assert.equal((await documents.get<CallState>(`call:${callId}`))?.bookingReviewWork, undefined)
  }
})

test('original webhook freeze winning before claim is refused without reserving staff ownership or calendar fence', async () => {
  const { documents, calendar, input } = await fixture()
  const current = call()
  current.work = completeToolBatch(current.work!, { token: 'admission-one', now: now.toISOString(),
    results: [{ toolId: 'booking-tool', result: 'Original booking completed', outcome: 'complete' }] })
  current.work = freezeCall(current.work, { now: now.toISOString() })
  await documents.set(`call:${callId}`, current)
  await assert.rejects(reconcileBookingReview(calendar, documents, input), expectedError('booking_review_call_completed'))
  assert.equal((await calendar.read()).bookingReviewResolutions, undefined)
  assert.equal((await documents.get<CallState>(`call:${callId}`))?.bookingReviewWork, undefined)
})

for (const phase of ['claim', 'calendar', 'intent', 'frozen', 'lead', 'call_complete', 'review_pending', 'calendar_complete', 'review_complete'] as const) {
  test(`lost ${phase} acknowledgement recovers via canonical claim and another authorized operator`, async () => {
    const { documents, calendar, input } = await fixture()
    const original = documents.update.bind(documents), mutate = calendar.mutate.bind(calendar)
    let failed = false
    documents.update = async (key, initial, fn) => {
      const next = await original(key, initial, fn), value = next as any
      const matches = (phase === 'claim' && key === `call:${callId}` && value.bookingReviewWork && value.work?.phase === 'needs_review')
        || (phase === 'intent' && key === `call:${callId}` && value.work?.phase === 'ending')
        || (phase === 'frozen' && key === `call:${callId}` && value.work?.phase === 'frozen')
        || (phase === 'lead' && key === `lead:${phone}`)
        || (phase === 'call_complete' && key === `call:${callId}` && value.work?.phase === 'complete')
        || (phase === 'review_pending' && key === `booking-review:${callId}` && value.resolution?.projection === 'pending')
        || (phase === 'review_complete' && key === `booking-review:${callId}` && value.resolution?.projection === 'complete')
      if (!failed && matches) { failed = true; throw new Error('Synthetic lost acknowledgement') }
      return next
    }
    calendar.mutate = async fn => {
      const next = await mutate(fn), marker = calendarBookingReviewForCall(next, callId)
      if (!failed && ((phase === 'calendar' && marker?.projection === 'pending') || (phase === 'calendar_complete' && marker?.projection === 'complete'))) {
        failed = true; throw new Error('Synthetic lost acknowledgement')
      }
      return next
    }
    const first = await reconcileBookingReview(calendar, documents, input)
    assert.equal(failed, true); assert.equal(first.status, 'pending_projection')
    const result = await reconcileBookingReview(calendar, documents, { ...input, requestId: 'review-another-tab', actorId: 'staff-two' })
    assert.equal(result.status, 'complete'); assert.equal(result.bookingReview.resolution?.requestId, input.requestId)
    assert.equal(result.bookingReview.resolution?.actorId, 'staff-one')
    assert.equal((await documents.get<LeadProfile>(`lead:${phone}`))?.calls.length, 1)
    assert.equal((await calendar.read()).bookings.length, 1)
    assert.equal((await calendar.read()).bookingReviewResolutions?.length, 1)
  })
}

test('webhook projector cannot complete a claimed call and claim has no age-based unlock', async () => {
  const { documents, calendar, input } = await fixture()
  const original = calendar.read.bind(calendar)
  calendar.read = async () => { throw new Error('Synthetic temporary calendar outage') }
  assert.equal((await reconcileBookingReview(calendar, documents, input)).status, 'pending_projection')
  const claimed = (await documents.get<CallState>(`call:${callId}`))!
  await assert.rejects(projectFrozenCall(documents, callId, new Date('2032-06-02T10:00:00.000Z')), expectedError('call_admission_stale'))
  assert.equal((await documents.get<CallState>(`call:${callId}`))?.bookingReviewWork?.claimedAt, claimed.bookingReviewWork?.claimedAt)
  calendar.read = original
  assert.equal((await reconcileBookingReview(calendar, documents, { ...input, now: new Date('2032-06-02T10:00:00.000Z'), actorId: 'staff-two' })).status, 'complete')
})

test('completed calendar ACK loss followed by manual reschedule cannot restore stale lead facts on retry', async () => {
  const { documents, calendar, input } = await fixture(), mutate = calendar.mutate.bind(calendar)
  let fail = true
  calendar.mutate = async fn => {
    const next = await mutate(fn)
    if (fail && calendarBookingReviewForCall(next, callId)?.projection === 'complete') { fail = false; throw new Error('Completion ACK lost') }
    return next
  }
  assert.equal((await reconcileBookingReview(calendar, documents, input)).status, 'pending_projection')
  await calendar.mutate(state => rescheduleBooking(state, { externalId: attempt.externalId, requestId: 'later-staff-move', expectedRevision: 0,
    slotId: 'slot-2032-06-01T15:00' }, now, { timeZone: 'America/New_York', unitIds: ['12A'], minimumNoticeMinutes: 0 }, 'staff-two'))
  const original = documents.update.bind(documents)
  documents.update = async (key, initial, fn) => {
    assert.ok(!key.startsWith('lead:') && !key.startsWith('followup:') && !key.startsWith('call-receipt:'), 'completed receipt replay must not rerun projections')
    return original(key, initial, fn)
  }
  assert.equal((await reconcileBookingReview(calendar, documents, { ...input, requestId: 'second-tab-review', actorId: 'staff-two' })).status, 'complete')
  assert.equal((await calendar.read()).bookings[0]?.slotId, 'slot-2032-06-01T15:00')
})

test('completed absence followed by a new caller attempt stays historical on old review replay', async () => {
  const { documents, calendar, input } = await fixture(false)
  await reconcileBookingReview(calendar, documents, input)
  const port = storeBackedCalendar(calendar, () => now, { timeZone: 'America/New_York', unitIds: ['12A'], minimumNoticeMinutes: 0 })
  await port.createBooking({ intentId: 'new-intent', idempotencyKey: attempt.externalId, createdAt: now, request: {
    propertyId: propertyId('property-a1'), interactionId: interactionId('new-call'), personId: null, prospectName: 'New call', prospectPhone: phone,
    prospectEmail: null, unitId: '12A', floorPlanId: null,
    slot: { slotId: attempt.slotId, startsAt: new Date(attempt.startsAt), endsAt: new Date(attempt.endsAt) } } })
  const replay = await reconcileBookingReview(calendar, documents, { ...input, actorId: 'staff-two', requestId: 'another-review-tab' })
  assert.equal(replay.status, 'complete'); assert.equal(replay.bookingReview.resolution?.outcome, 'not_booked')
  assert.equal((await calendar.read()).bookings[0]?.interactionId, 'new-call')
})

test('historical channel/configuration/timezone is retained under current same-property staff scope', async () => {
  const state = call(), old = { organizationId: 'organization-a', propertyId: 'property-a1', channelBindingId: 'old-binding',
    channelBindingVersion: 2, configurationVersion: 3, timeZone: 'America/Chicago' }
  state.work!.provenance = old; state.routing = { organizationId: old.organizationId, propertyId: old.propertyId, channelBindingId: old.channelBindingId }
  const { documents, calendar, input } = await fixture(true, state)
  await reconcileBookingReview(calendar, documents, { ...input, scope: { organizationId: old.organizationId, propertyId: old.propertyId } })
  const saved = (await documents.get<CallReceipt>(receiptKey(callId)))!
  assert.equal(saved.scope?.channelBindingId, 'old-binding'); assert.equal(saved.scope?.configurationVersion, 3)
  assert.equal(saved.timeZone, 'America/Chicago')
})

test('staff reconciliation preserves safety and tour-change records and calendar admission holds', async () => {
  const state = call()
  state.emergency = { kind: 'gas', matched: 'smell gas', instruction: 'Leave the area.' } as never
  state.escalation = { trigger: 'emergency', detail: 'Reported gas concern' }; state.tourChangeRequested = true
  const { documents, calendar, input } = await fixture(false, state)
  await calendar.mutate(current => ({ ...current, emergencyHolds: [{ interactionId: callId, kind: 'gas', recordedAt: now.toISOString() }],
    tourChangeHolds: [{ interactionId: callId, recordedAt: now.toISOString() }] }))
  await reconcileBookingReview(calendar, documents, input)
  const completed = (await documents.get<CallState>(`call:${callId}`))!
  assert.deepEqual(completed.emergency, state.emergency); assert.deepEqual(completed.escalation, state.escalation)
  assert.equal(completed.tourChangeRequested, true)
  assert.equal((await calendar.read()).emergencyHolds?.length, 1); assert.equal((await calendar.read()).tourChangeHolds?.length, 1)
  assert.equal((await documents.get<LeadProfile>(`lead:${phone}`))?.escalations[0]?.trigger, 'emergency')
})

test('two staff resumptions cannot undo later reschedule when one stale follow-up projection resumes after fence release', async () => {
  const { documents, calendar, input } = await fixture(), context = new AsyncLocalStorage<string>()
  const originalUpdate = documents.update.bind(documents), originalMutate = calendar.mutate.bind(calendar)
  let firstHeld = false, secondHeld = false, firstArrive!: () => void, firstRelease!: () => void, secondArrive!: () => void, secondRelease!: () => void
  const firstAtReceipt = new Promise<void>(resolve => { firstArrive = resolve })
  const releaseFirst = new Promise<void>(resolve => { firstRelease = resolve })
  const secondAtFollowup = new Promise<void>(resolve => { secondArrive = resolve })
  const releaseSecond = new Promise<void>(resolve => { secondRelease = resolve })
  calendar.mutate = async fn => {
    const value = await originalMutate(fn)
    if (context.getStore() === 'first' && !firstHeld && calendarBookingReviewForCall(value, callId)?.projection === 'pending') {
      firstHeld = true; firstArrive(); await releaseFirst
    }
    return value
  }
  documents.update = async (key, initial, fn) => {
    if (context.getStore() === 'second' && !secondHeld && key.startsWith('followup:')) {
      secondHeld = true; secondArrive(); await releaseSecond
    }
    return originalUpdate(key, initial, fn)
  }
  const first = context.run('first', () => reconcileBookingReview(calendar, documents, input))
  await firstAtReceipt
  const second = context.run('second', () => reconcileBookingReview(calendar, documents, { ...input, requestId: 'second-staff-tab', actorId: 'staff-two' }))
  await secondAtFollowup
  firstRelease()
  assert.equal((await first).status, 'complete')
  const moved = await calendar.mutate(state => rescheduleBooking(state, { externalId: attempt.externalId, requestId: 'later-staff-move', expectedRevision: 0,
    slotId: 'slot-2032-06-01T15:00' }, now, { timeZone: 'America/New_York', unitIds: ['12A'], minimumNoticeMinutes: 0 }, 'staff-two'))
  const updated = moved.bookings[0]!, change = updated.rescheduleHistory![0]!
  assert.equal((await reconcileRescheduledTour(documents, { booking: updated, change })).status, 'complete')
  await calendar.mutate(state => completeRescheduleProjection(state, updated.externalId, change.requestId, change.revision))
  const before = await documents.get<LeadProfile>(`lead:${phone}`)
  const followups = await Promise.all((await documents.list('followup:')).map(key => documents.get(key)))
  secondRelease()
  assert.equal((await second).status, 'complete')
  assert.deepEqual(await documents.get<LeadProfile>(`lead:${phone}`), before)
  assert.deepEqual(await Promise.all((await documents.list('followup:')).map(key => documents.get(key))), followups)
  assert.equal((await calendar.read()).bookings[0]?.startsAt, '2032-06-01T15:00:00.000Z')
})

test('failed first claim creates no calendar fence and failed follow-up writes remain recoverable', async () => {
  const { documents, calendar, input } = await fixture(), original = documents.update.bind(documents)
  let failure: 'claim' | 'followup' | null = 'claim'
  documents.update = async (key, initial, fn) => {
    if (failure === 'claim' && key === `call:${callId}`) throw new Error('Claim store unavailable')
    if (failure === 'followup' && key.startsWith('followup:')) throw new Error('Follow-up store unavailable')
    return original(key, initial, fn)
  }
  await assert.rejects(reconcileBookingReview(calendar, documents, input), /Claim store unavailable/)
  assert.equal((await calendar.read()).bookingReviewResolutions, undefined)
  failure = 'followup'
  const pending = await reconcileBookingReview(calendar, documents, input)
  assert.equal(pending.status, 'pending_projection'); assert.equal(pending.bookingReview.needsReview, true)
  assert.equal((await documents.get<CallReceipt>(receiptKey(callId)))?.status, 'pending')
  assert.equal((await documents.get<LeadProfile>(`lead:${phone}`))?.calls.length, 1)
  assert.equal(calendarBookingReviewForCall(await calendar.read(), callId)?.projection, 'pending')
  failure = null
  assert.equal((await reconcileBookingReview(calendar, documents, input)).status, 'complete')
  assert.equal((await documents.get<LeadProfile>(`lead:${phone}`))?.calls.length, 1)
})

test('original calendar write between staff claim and calendar observation is observed rather than assumed absent', async () => {
  const { documents, calendar, input } = await fixture(false), read = calendar.read.bind(calendar)
  let first = true
  calendar.read = async () => {
    if (first) {
      first = false
      assert.ok((await documents.get<CallState>(`call:${callId}`))?.bookingReviewWork, 'call ownership precedes calendar access')
      await calendar.mutate(current => ({ ...current, bookings: [booking()] }))
    }
    return read()
  }
  assert.equal((await reconcileBookingReview(calendar, documents, input)).bookingReview.resolution?.outcome, 'confirmed')
  assert.equal((await calendar.read()).bookings.length, 1)
})

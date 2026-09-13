import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { emptyProfile, deriveStage, normalisePhone } from '../profile.ts'
import { deriveFollowUps } from '../followups.ts'
import { pinnedName } from '../profile.ts'
import { consolidateCall } from '../consolidate.ts'
import { MemoryDocumentStore } from '../../store/documents.ts'
import { emptyQualification } from '../../leasing/qualification.ts'

const NOW = new Date('2026-09-07T18:00:00Z') // Monday 2pm ET

describe('one phone number is one person', () => {
  test('every way of writing a US number normalises to the same key', () => {
    const forms = ['+1 (516) 990-9252', '5169909252', '+15169909252', '1-516-990-9252', '516.990.9252']
    assert.equal(new Set(forms.map(normalisePhone)).size, 1)
  })

  test('an empty number is unknown rather than a throw', () => {
    assert.equal(normalisePhone(''), 'unknown')
  })
})

describe('stage is derived from the facts, never typed', () => {
  test('a confirmed future booking is tour_scheduled', () => {
    const p = emptyProfile('+1', NOW)
    p.bookings.push({ slotId: 's', startsAt: '2026-09-08T21:00:00Z', unitId: null, status: 'confirmed', callId: 'c' })
    assert.equal(deriveStage(p, NOW), 'tour_scheduled')
  })

  test('a past confirmed booking remains tour_scheduled without attendance evidence', () => {
    const p = emptyProfile('+1', NOW)
    p.bookings.push({ slotId: 's', startsAt: '2026-09-06T21:00:00Z', unitId: null, status: 'confirmed', callId: 'c' })
    assert.equal(deriveStage(p, NOW), 'tour_scheduled')
    assert.equal(deriveStage(p, new Date('2027-01-01')), 'tour_scheduled', 'elapsed time alone never proves attendance')
  })

  test('an older appointment cannot mark a lead with a future booking as toured', () => {
    const p = emptyProfile('+1', NOW)
    p.bookings = [
      { slotId: 'past', startsAt: '2026-09-06T21:00:00Z', unitId: null, status: 'confirmed', callId: 'a' },
      { slotId: 'future', startsAt: '2026-09-08T21:00:00Z', unitId: null, status: 'confirmed', callId: 'b' },
    ]
    assert.equal(deriveStage(p, NOW), 'tour_scheduled')
  })

  test('failed and unverified past bookings prove neither a booking nor attendance', () => {
    for (const status of ['failed', 'arranging'] as const) {
      const p = emptyProfile('+1', NOW)
      p.bookings.push({ slotId: 's', startsAt: '2026-09-06T21:00:00Z', unitId: null, status, callId: 'c' })
      assert.equal(deriveStage(p, NOW), 'new', status)
    }
  })

  test('a legacy toured stage is not itself evidence of attendance', () => {
    const p = emptyProfile('+1', NOW)
    p.stage = 'toured'
    p.bookings.push({ slotId: 's', startsAt: '2026-09-06T21:00:00Z', unitId: null, status: 'confirmed', callId: 'c' })
    assert.equal(deriveStage(p, NOW), 'tour_scheduled')
  })

  test('two core signals make a lead qualified', () => {
    const p = emptyProfile('+1', NOW)
    p.signals.budget = { value: 4000, excerpt: 'four thousand', callId: 'c', at: '', confidence: 0.9 }
    p.signals.bedrooms = { value: 1, excerpt: 'one bed', callId: 'c', at: '', confidence: 0.9 }
    assert.equal(deriveStage(p, NOW), 'qualified')
  })

  test('a loss reason with nothing booked is lost', () => {
    const p = emptyProfile('+1', NOW)
    p.lossReasons.push({ kind: 'priced_out', detail: '$800 over', evidence: 'too much', confidence: 0.9, at: NOW, callId: 'c' })
    assert.equal(deriveStage(p, NOW), 'lost')
  })

  test('a booking outranks a loss reason — they booked anyway', () => {
    const p = emptyProfile('+1', NOW)
    p.lossReasons.push({ kind: 'priced_out', detail: '', evidence: '', confidence: 0.9, at: NOW, callId: 'c' })
    p.bookings.push({ slotId: 's', startsAt: '2026-09-08T21:00:00Z', unitId: null, status: 'confirmed', callId: 'c' })
    assert.equal(deriveStage(p, NOW), 'tour_scheduled')
  })
})

describe('follow-ups are the system showing it knows what to do next', () => {
  const booked = () => {
    const p = emptyProfile('+15165551234', NOW)
    p.name = 'Vin'
    p.bookings.push({ slotId: 's', startsAt: '2026-09-08T21:00:00Z', unitId: '12A', status: 'confirmed', callId: 'c1' })
    return p
  }

  test('a tour tomorrow at five gets a confirmation call tomorrow at two', () => {
    const f = deriveFollowUps(booked(), NOW, 'c1').find((x) => x.kind === 'confirm_tour')!
    assert.ok(f)
    const due = new Date(f.dueAt)
    assert.equal(due.toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'America/New_York' }), '2 PM')
    assert.match(f.reason, /5:00 PM/)
    assert.match(f.reason, /12A/)
  })

  test('a booking with no email produces a nudge to get one', () => {
    const f = deriveFollowUps(booked(), NOW, 'c1').find((x) => x.kind === 'collect_email')
    assert.ok(f, 'the confirmation email has nowhere to go')
  })

  test('with an email, the reminder goes by email and no nudge is needed', () => {
    const p = booked(); p.email = 'v@e.com'
    const fs = deriveFollowUps(p, NOW, 'c1')
    assert.ok(!fs.some((x) => x.kind === 'collect_email'))
    assert.equal(fs.find((x) => x.kind === 'remind_tour')?.channel, 'email')
  })

  test('nothing is executable, and says so', () => {
    for (const f of deriveFollowUps(booked(), NOW, 'c1')) assert.equal(f.executable, false)
  })

  test('follow-up after a scheduled time asks whether they attended instead of claiming they toured', () => {
    const p = booked()
    p.bookings[0]!.startsAt = '2026-09-06T21:00:00Z'
    const followUp = deriveFollowUps(p, NOW, 'c1').find(f => f.kind === 'post_tour')
    assert.ok(followUp)
    assert.match(followUp.reason, /was scheduled to tour residence 12A/)
    assert.match(followUp.reason, /confirm whether they attended/)
    assert.doesNotMatch(followUp.reason, /\btoured\b|find out how it went/)
    assert.equal(followUp.executable, false)
  })

  test('failed or unverified bookings do not produce an attendance follow-up', () => {
    for (const status of ['failed', 'arranging'] as const) {
      const p = booked()
      p.bookings[0]!.startsAt = '2026-09-06T21:00:00Z'
      p.bookings[0]!.status = status
      assert.ok(!deriveFollowUps(p, NOW, 'c1').some(f => f.kind === 'post_tour'), status)
    }
  })

  test('re-deriving after a second call does not duplicate', () => {
    const p = booked()
    const a = deriveFollowUps(p, NOW, 'c1').map((f) => f.id)
    const b = deriveFollowUps(p, NOW, 'c2').map((f) => f.id)
    assert.deepEqual(a, b, 'ids are deterministic so a re-run is a no-op')
  })

  test('priced out with nothing booked schedules a watch', () => {
    const p = emptyProfile('+1', NOW); p.name = 'Dana'
    p.lossReasons.push({ kind: 'priced_out', detail: '$1,475 over', evidence: 'three thousand', confidence: 0.9, at: NOW, callId: 'c' })
    const f = deriveFollowUps(p, NOW, 'c').find((x) => x.kind === 'priced_out_watch')
    assert.ok(f)
    assert.match(f!.reason, /\$1,475/)
  })

  test('an escalation gets a human callback', () => {
    const p = emptyProfile('+1', NOW)
    p.escalations.push({ trigger: 'restricted:reasonable_accommodation', detail: 'service dog', callId: 'c', at: '' })
    const f = deriveFollowUps(p, NOW, 'c').find((x) => x.kind === 'callback')
    assert.ok(f)
    assert.match(f!.reason, /service dog/)
  })

  test('nothing is scheduled outside business hours', () => {
    const late = new Date('2026-09-07T23:30:00Z') // 7:30pm ET
    const p = emptyProfile('+1', late)
    p.escalations.push({ trigger: 'human_requested', detail: 'x', callId: 'c', at: '' })
    for (const f of deriveFollowUps(p, late, 'c')) {
      const h = Number(new Date(f.dueAt).toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }))
      assert.ok(h >= 10 && h < 18, `${f.kind} due at ${h}:00 ET`)
    }
  })
})

describe('a human note pins the name', () => {
  const call = (callId: string, name: string | null, at: Date) => ({
    callId, phone: '+1 (516) 990-9252', at, durationSeconds: 90, qualification: emptyQualification(),
    name, email: null, unitsDiscussed: [], booking: null, lossReason: null, escalation: null, toolsCalled: [],
  })

  test('a stamped "name:" note is read, and the last one wins', () => {
    assert.equal(pinnedName(['2026-09-07T18:00:00.000Z name: Vincent T.']), 'Vincent T.')
    assert.equal(pinnedName(['name: A', '2026-09-07T18:00:00.000Z name: B']), 'B')
    assert.equal(pinnedName(['2026-09-07T18:00:00.000Z called back, no answer']), null)
  })

  test('a later call cannot overwrite a pinned name', async () => {
    const store = new MemoryDocumentStore()
    const first = await consolidateCall(store, call('c1', 'Vince', NOW))
    assert.equal(first.profile.name, 'Vince')
    await store.update(`lead:${first.profile.phone}`, first.profile, (p) => ({
      ...p, notes: [...p.notes, '2026-09-07T18:30:00.000Z name: Vincent T.'],
    }))
    const second = await consolidateCall(store, call('c2', 'Vinny', new Date(NOW.getTime() + 3_600_000)))
    assert.equal(second.profile.name, 'Vincent T.')
  })
})

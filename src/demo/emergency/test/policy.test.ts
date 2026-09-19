import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EMERGENCY_POLICY, instructionFor, nextStep, orderedContacts,
} from '../policy.ts'
import type { AttemptRecord, EmergencyContact } from '../policy.ts'
import type { EmergencySignal } from '../../../escalation/emergency.ts'

const T0 = 1_760_000_000_000
const WINDOW = DEFAULT_EMERGENCY_POLICY.acknowledgeWithinMs

const contact = (position: number, name: string): EmergencyContact =>
  ({ position, name, channel: 'sms', address: `+1555000000${position}` })

const contacts = [contact(1, 'Duty manager'), contact(2, 'Property manager'), contact(3, 'Regional on-call')]

const attempt = (position: number, atMs: number, outcome: AttemptRecord['outcome'] = 'recorded'): AttemptRecord =>
  ({ position, attemptedAtMs: atMs, outcome })

const signal = (kind: EmergencySignal['kind'], callEmergencyServices = true): EmergencySignal =>
  ({ kind, matched: 'test phrase', callEmergencyServices })

test('with nothing tried yet, the first contact is notified immediately', () => {
  const step = nextStep({ contacts, attempts: [], acknowledgedAtMs: null, nowMs: T0 })
  assert.equal(step.action, 'notify')
  if (step.action !== 'notify') return
  assert.equal(step.contact.position, 1)
})

test('no elapsed time, no configuration and no ordering can delay the first attempt', () => {
  // The same call at the instant the escalation opens, and with the contacts supplied out
  // of order, still goes straight out to position 1.
  const shuffled = [contact(3, 'Regional on-call'), contact(1, 'Duty manager'), contact(2, 'Property manager')]
  const step = nextStep({ contacts: shuffled, attempts: [], acknowledgedAtMs: null, nowMs: 0 })
  assert.equal(step.action, 'notify')
  if (step.action !== 'notify') return
  assert.equal(step.contact.name, 'Duty manager')
})

test('inside the window, the chain waits on the person already contacted', () => {
  const step = nextStep({
    contacts, attempts: [attempt(1, T0)], acknowledgedAtMs: null, nowMs: T0 + WINDOW - 1,
  })
  assert.equal(step.action, 'wait')
  if (step.action !== 'wait') return
  assert.equal(step.untilMs, T0 + WINDOW)
  assert.equal(step.awaiting, 1)
})

test('silence past the window moves to the next contact', () => {
  const step = nextStep({
    contacts, attempts: [attempt(1, T0)], acknowledgedAtMs: null, nowMs: T0 + WINDOW,
  })
  assert.equal(step.action, 'notify')
  if (step.action !== 'notify') return
  assert.equal(step.contact.position, 2)
})

test('a failed send does not consume the window, because nobody was reached', () => {
  const step = nextStep({
    contacts, attempts: [attempt(1, T0, 'failed')], acknowledgedAtMs: null, nowMs: T0 + 1,
  })
  assert.equal(step.action, 'notify')
  if (step.action !== 'notify') return
  assert.equal(step.contact.position, 2)
})

test('a delivered message still gets its window, because ringing is not answering', () => {
  const step = nextStep({
    contacts, attempts: [attempt(1, T0, 'delivered')], acknowledgedAtMs: null, nowMs: T0 + 1,
  })
  assert.equal(step.action, 'wait')
})

test('the chain works down the list and then reports that it ran out', () => {
  const walked = [attempt(1, T0), attempt(2, T0 + WINDOW), attempt(3, T0 + WINDOW * 2)]
  const step = nextStep({ contacts, attempts: walked, acknowledgedAtMs: null, nowMs: T0 + WINDOW * 3 })
  // Running out is a state a person has to see, not a silent end.
  assert.equal(step.action, 'exhausted')
})

test('an acknowledgement stops the chain wherever it had got to', () => {
  const step = nextStep({
    contacts, attempts: [attempt(1, T0)], acknowledgedAtMs: T0 + 30_000, nowMs: T0 + WINDOW * 5,
  })
  assert.equal(step.action, 'acknowledged')
})

test('a property with no emergency contacts is reported, not silently skipped', () => {
  const step = nextStep({ contacts: [], attempts: [], acknowledgedAtMs: null, nowMs: T0 })
  assert.equal(step.action, 'exhausted')
})

test('nobody is contacted twice for the same escalation', () => {
  const step = nextStep({
    contacts, attempts: [attempt(1, T0), attempt(2, T0 + WINDOW)], acknowledgedAtMs: null,
    nowMs: T0 + WINDOW * 2,
  })
  assert.equal(step.action, 'notify')
  if (step.action !== 'notify') return
  assert.equal(step.contact.position, 3)
})

test('the contact list is ordered, de-duplicated and capped', () => {
  const messy = [contact(2, 'Second'), contact(1, 'First'), contact(2, 'Duplicate'), contact(0, 'Invalid')]
  const ordered = orderedContacts(messy)
  assert.deepEqual(ordered.map(entry => entry.name), ['First', 'Second'])
  const many = Array.from({ length: 9 }, (_, index) => contact(index + 1, `Contact ${index + 1}`))
  assert.equal(orderedContacts(many).length, DEFAULT_EMERGENCY_POLICY.maxContacts)
})

test('a life-safety instruction says to call emergency services', () => {
  for (const kind of ['gas', 'smoke_or_fire', 'carbon_monoxide', 'injury', 'intruder'] as const) {
    const instruction = instructionFor(signal(kind))
    assert.equal(instruction.callEmergencyServices, true)
    assert.match(instruction.text, /911/)
    assert.equal(instruction.source, 'default')
  }
})

test("a property's approved wording is used and reported as the property's", () => {
  const approved = { gas: 'Leave by the north stairwell and call 911 from the forecourt.' }
  const instruction = instructionFor(signal('gas'), approved)
  assert.equal(instruction.text, approved.gas)
  assert.equal(instruction.source, 'property')
})

test('blank approved wording falls back rather than leaving a caller with nothing', () => {
  const instruction = instructionFor(signal('gas'), { gas: '   ' })
  assert.equal(instruction.source, 'default')
  assert.match(instruction.text, /Leave the building/)
})

test('a non-life-safety emergency does not tell the caller to ring 911 unprompted', () => {
  const instruction = instructionFor(signal('flooding', false))
  assert.equal(instruction.callEmergencyServices, false)
  assert.doesNotMatch(instruction.text, /911/)
})

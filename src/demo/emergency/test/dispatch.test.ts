import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acknowledgeEmergency, advance, openEmergency } from '../dispatch.ts'
import { memoryEmergencyStore } from '../memory-store.ts'
import { recordingTransport } from '../transport.ts'
import { DEFAULT_EMERGENCY_POLICY } from '../policy.ts'
import type { EmergencyContact } from '../policy.ts'
import type { EmergencyPorts } from '../dispatch.ts'
import type { AlertTransport } from '../transport.ts'
import type { EmergencySignal } from '../../../escalation/emergency.ts'

const SCOPE = { organizationId: 'org-demo-larkin', propertyId: 'prop-demo' }
const KEY = `${SCOPE.organizationId}/${SCOPE.propertyId}`
const T0 = 1_760_000_000_000
const WINDOW = DEFAULT_EMERGENCY_POLICY.acknowledgeWithinMs

const gas: EmergencySignal = { kind: 'gas', matched: 'I smell gas in the hallway', callEmergencyServices: true }

const contacts: EmergencyContact[] = [
  { position: 1, name: 'Duty manager', channel: 'sms', address: '+15550000001' },
  { position: 2, name: 'Property manager', channel: 'sms', address: '+15550000002' },
  { position: 3, name: 'Regional on-call', channel: 'voice', address: '+15550000003' },
]

function harness(options: {
  contacts?: EmergencyContact[]
  transport?: AlertTransport
  clock?: { nowMs: number }
} = {}) {
  const store = memoryEmergencyStore({ [KEY]: options.contacts ?? contacts })
  const clock = options.clock ?? { nowMs: T0 }
  let counter = 0
  const ports: EmergencyPorts = {
    store,
    transport: options.transport ?? recordingTransport(),
    propertyName: 'The Larkin',
    now: () => new Date(clock.nowMs),
    newId: () => { counter += 1; return `escalation-${counter}` },
  }
  return { store, ports, clock }
}

test('opening an emergency contacts the first person in the same call', async () => {
  const { store, ports } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: gas, unitLabel: '4B', callerNumber: '+15551234567' }, ports)

  assert.equal(opened.first.action, 'notified')
  if (opened.first.action !== 'notified') return
  assert.equal(opened.first.position, 1)
  assert.equal(opened.first.contactName, 'Duty manager')
  assert.equal(store.sent.length, 1)
})

test('the caller is given words before anyone else is contacted, and is sent to 911', async () => {
  const { ports } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)
  assert.equal(opened.callEmergencyServices, true)
  assert.match(opened.instruction, /911/)
})

test('a property with no emergency contacts still gives the caller an instruction', async () => {
  const { ports } = harness({ contacts: [] })
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)
  assert.match(opened.instruction, /Leave the building/)
  assert.equal(opened.first.action, 'exhausted')
  if (opened.first.action !== 'exhausted') return
  // A property nobody can be reached at is a configuration fault someone has to see.
  assert.equal(opened.first.reason, 'no_contacts')
})

test('the alert says what the caller actually said, not a summary of it', async () => {
  const { store, ports } = harness()
  await openEmergency({ ...SCOPE, signal: gas, unitLabel: '4B', callerNumber: '+15551234567' }, ports)
  const alert = store.sent[0]
  assert.ok(alert)
  assert.match(alert.body, /I smell gas in the hallway/)
  assert.match(alert.subject, /Gas smell reported at The Larkin, unit 4B/)
  assert.match(alert.body, /\+15551234567/)
})

test('a stand-in transport records the alert and never reports it as delivered', async () => {
  const { store, ports } = harness()
  await openEmergency({ ...SCOPE, signal: gas }, ports)
  const alert = store.sent[0]
  assert.ok(alert)
  assert.equal(alert.outcome, 'recorded')
  assert.equal(alert.delivered, false)
  assert.match(alert.detail, /nobody was contacted/)
})

test('silence past the window moves to the next contact', async () => {
  const { store, ports, clock } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)

  clock.nowMs = T0 + WINDOW - 1
  const waiting = await advance(opened.escalation.id, ports)
  assert.equal(waiting.action, 'waiting')
  assert.equal(store.sent.length, 1)

  clock.nowMs = T0 + WINDOW
  const second = await advance(opened.escalation.id, ports)
  assert.equal(second.action, 'notified')
  if (second.action !== 'notified') return
  assert.equal(second.position, 2)
  assert.equal(store.sent.length, 2)
})

test('a contact who cannot be reached is skipped at once rather than waited on', async () => {
  const { store, ports } = harness({ transport: recordingTransport({ failAddresses: ['+15550000001'] }) })
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)
  assert.equal(opened.first.action, 'notified')
  if (opened.first.action !== 'notified') return
  assert.equal(opened.first.outcome, 'failed')

  // No clock movement: a failed send did not give anyone a chance to answer.
  const second = await advance(opened.escalation.id, ports)
  assert.equal(second.action, 'notified')
  if (second.action !== 'notified') return
  assert.equal(second.position, 2)
  assert.equal(store.sent.length, 2)
})

test('a transport that throws is recorded as a failure and the chain carries on', async () => {
  const throwing: AlertTransport = {
    id: 'throwing', delivers: false,
    async send() { throw new Error('provider unreachable') },
  }
  const { store, ports } = harness({ transport: throwing })
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)
  assert.equal(opened.first.action, 'notified')
  if (opened.first.action !== 'notified') return
  assert.equal(opened.first.outcome, 'failed')
  assert.equal(store.sent[0]?.detail, 'provider unreachable')

  const second = await advance(opened.escalation.id, ports)
  assert.equal(second.action, 'notified')
})

test('an acknowledgement stops the chain and cannot be overwritten', async () => {
  const { store, ports, clock } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)

  clock.nowMs = T0 + 30_000
  assert.equal(await acknowledgeEmergency(opened.escalation.id, 'duty-manager', ports), true)
  assert.equal(await acknowledgeEmergency(opened.escalation.id, 'someone-else', ports), false)

  clock.nowMs = T0 + WINDOW * 5
  const after = await advance(opened.escalation.id, ports)
  assert.equal(after.action, 'acknowledged')
  assert.equal(store.sent.length, 1)

  const record = await store.get(opened.escalation.id)
  assert.equal(record?.status, 'acknowledged')
  assert.equal(record?.acknowledgedBy, 'duty-manager')
})

test('working through every contact without an answer ends in a state a person can see', async () => {
  const { store, ports, clock } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)
  for (let i = 1; i <= 3; i += 1) {
    clock.nowMs = T0 + WINDOW * i
    await advance(opened.escalation.id, ports)
  }
  clock.nowMs = T0 + WINDOW * 4
  const final = await advance(opened.escalation.id, ports)
  assert.equal(final.action, 'exhausted')
  if (final.action !== 'exhausted') return
  assert.equal(final.reason, 'contacts_exhausted')
  assert.equal(store.sent.length, 3)

  const record = await store.get(opened.escalation.id)
  assert.equal(record?.status, 'exhausted')
})

test('advancing repeatedly inside the window contacts nobody extra', async () => {
  const { store, ports } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: gas }, ports)
  for (let i = 0; i < 5; i += 1) await advance(opened.escalation.id, ports)
  assert.equal(store.sent.length, 1)
})

test("a property's approved wording reaches both the caller and the alert", async () => {
  const { store, ports } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: gas }, {
    ...ports, approvedInstructions: { gas: 'Leave by the north stairwell, then call 911.' },
  })
  assert.equal(opened.instruction, 'Leave by the north stairwell, then call 911.')
  assert.equal(opened.escalation.instructionSource, 'property')
  assert.match(String(store.sent[0]?.body), /north stairwell/)
})

test('a non-life-safety emergency still reaches a person', async () => {
  const flooding: EmergencySignal = { kind: 'flooding', matched: 'water coming through the ceiling', callEmergencyServices: false }
  const { store, ports } = harness()
  const opened = await openEmergency({ ...SCOPE, signal: flooding }, ports)
  assert.equal(opened.callEmergencyServices, false)
  assert.equal(opened.first.action, 'notified')
  assert.match(String(store.sent[0]?.body), /not treated as an immediate danger to life/)
})

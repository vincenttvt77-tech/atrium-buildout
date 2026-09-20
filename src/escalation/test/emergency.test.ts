import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { detectEmergency, primaryEmergency, safetyInstruction } from '../emergency.ts'
import { buildEscalation, priorityFor } from '../escalate.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const NOW = new Date('2026-09-07T12:00:00Z')

describe('life-safety phrases are detected as people actually say them', () => {
  const cases: [string, string][] = [
    ['I smell gas in the hallway', 'gas'],
    ['it smells like gas', 'gas'],
    ["there's a gas leak", 'gas'],
    ['there is a fire on eleven', 'smoke_or_fire'],
    ['smoke coming from under the door', 'smoke_or_fire'],
    ['something is burning', 'smoke_or_fire'],
    ['my carbon monoxide detector is going off', 'carbon_monoxide'],
    ['my neighbor is unconscious', 'injury'],
    ["there's blood everywhere", 'injury'],
    ['someone broke in', 'intruder'],
    ["someone's in my apartment", 'intruder'],
    ['my ceiling is leaking and water is everywhere', 'flooding'],
    ['a pipe burst under the sink', 'flooding'],
    ['we have no heat and it is freezing', 'no_heat'],
    ['my apartment is on fire', 'smoke_or_fire'],
    ['I see smoke in the hallway', 'smoke_or_fire'],
    ['the fire alarm is going off', 'smoke_or_fire'],
    ['I smell smoke', 'smoke_or_fire'],
    ['my bathroom is flooded', 'flooding'],
    ['there is flooding in the hallway', 'flooding'],
    ['water is everywhere', 'flooding'],
  ]

  for (const [utterance, expected] of cases) {
    test(`"${utterance}" → ${expected}`, () => {
      const signals = detectEmergency(utterance)
      assert.ok(signals.some((s) => s.kind === expected),
        `expected ${expected}, got ${signals.map((s) => s.kind).join(', ') || 'nothing'}`)
    })
  }
})

describe('ordinary leasing talk does not trip the emergency path', () => {
  // Every one of these was a real false positive found by probing the detector. A leasing
  // line takes far more amenity questions than emergencies, so a detector that escalates
  // "can I smoke in my apartment" is worse than useless — it trains staff to ignore alerts.
  const benign = [
    'do you allow dogs',
    'what is the rent on the two bedroom',
    'I would like to book a tour for Sunday',
    'my budget is around three thousand',
    'is there a gas stove in the kitchen',
    'do the units have gas stoves',
    'do you have a gas range',
    'can I smoke in my apartment',
    'do you allow smoking on the balcony',
    'what is your smoking policy',
    'does the building have a fire pit on the roof',
    'do you have a firepit',
    'does the unit have a fireplace',
    'where are the fire stairs',
    'is there a fire escape',
    'is the fire alarm tested monthly',
    'fire safety questions',
    'is there a smoke detector in every room',
    'is there a grill on the roof deck',
    'the building flooded the market with concessions',
  ]
  for (const utterance of benign) {
    test(`"${utterance}" is not an emergency`, () => {
      assert.equal(detectEmergency(utterance).length, 0,
        `false positive on: ${detectEmergency(utterance).map((s) => s.kind).join(', ')}`)
    })
  }
})

describe('life-safety outranks everything else present', () => {
  test('a fire alongside flooding leads with the fire', () => {
    const signals = detectEmergency('there is a fire and water everywhere')
    const primary = primaryEmergency(signals)
    assert.equal(primary?.callEmergencyServices, true)
  })

  test('every life-safety instruction directs the caller to 911', () => {
    for (const u of ['I smell gas', 'there is a fire', 'someone is unconscious', 'someone broke in']) {
      const p = primaryEmergency(detectEmergency(u))!
      assert.match(safetyInstruction(p), /911/, `no 911 instruction for: ${u}`)
    }
  })

  test('the gas instruction warns against light switches and phones indoors', () => {
    const p = primaryEmergency(detectEmergency('I smell gas'))!
    const text = safetyInstruction(p)
    assert.match(text, /light switch/i)
    assert.match(text, /leave the apartment/i)
  })

  test('the fire instruction says stairs, not elevator', () => {
    const p = primaryEmergency(detectEmergency('there is a fire'))!
    assert.match(safetyInstruction(p), /stairs, not the elevator/i)
  })

  test('every safety response distinguishes guidance from notifications or dispatch', () => {
    for (const utterance of ['I smell gas', 'there is a fire', 'carbon monoxide alarm', 'someone is injured',
      'someone broke in', 'my bathroom is flooding', 'we have no heat', 'the ceiling collapsed']) {
      const p = primaryEmergency(detectEmergency(utterance))!
      assert.ok(p, utterance)
      const instruction = safetyInstruction(p)
      assert.match(instruction, /I have not contacted emergency services or building staff/, utterance)
      assert.doesNotMatch(instruction, /I.?m (alerting|dispatching)|I (have )?(alerted|dispatched|notified)|on (their|the) way/i, utterance)
    }
  })

  test('flooding does not ask a caller to handle electrical equipment in water', () => {
    const text = safetyInstruction(primaryEmergency(detectEmergency('my bathroom is flooding'))!)
    assert.match(text, /Stay out of the water/)
    assert.match(text, /Don't touch switches, plugs, or appliances while wet or standing in water/)
    assert.match(text, /Contact the building.*directly/i)
    assert.doesNotMatch(text, /move anything electrical|shut off the water|dispatching/i)
  })
})

describe('heating context distinguishes policy and past issues from current reports', () => {
  const ordinary = [
    'What happens if there is no heat?',
    "What should I do if the heat is out?",
    'Can I call you if the heat is not working?',
    'If there is no heat, who should I contact?',
    'What is your policy for no heat?',
    'What is the procedure for no heat in winter?',
    'I had no heat at my old apartment last winter.',
    'We had no heat yesterday, but it was repaired.',
    'We had no heat and it is working again.',
    'We had no heat yesterday. The heat has been restored.',
    'We had no heat yesterday; it was fixed this morning.',
    'I am not reporting no heat; I want to book a tour.',
    "I'm not saying there is no heat.",
    "I don't have a problem with no heat.",
    'No heat is not the problem.',
    "It's not freezing in here.",
  ]
  for (const utterance of ordinary) {
    test(`does not hold a call for ${JSON.stringify(utterance)}`, () => {
      assert.deepEqual(detectEmergency(utterance), [])
    })
  }

  const current = [
    'There is no heat.',
    'No heat.',
    'We have no heat and it is freezing.',
    'The heat is out.',
    'The heat is not working.',
    'It is freezing in here.',
    'I had no heat.',
    'We had no heat yesterday.',
    'We had no heat last night.',
    'We had no heat yesterday and the problem continues.',
    'We had no heat last night and nobody has fixed it.',
    'We had no heat yesterday, it has not been repaired.',
    'I reported no heat yesterday. Please send somebody to fix it.',
    'We had no heat yesterday. It was not fixed.',
    'We had no heat yesterday. It has never been resolved.',
    'We had no heat yesterday. I do not believe it was fixed.',
    'We had no heat yesterday. Nobody said it was fixed.',
    'We had no heat yesterday. It is fixed?',
    'We had no heat yesterday. It was fixed but the problem continues.',
    'We had no heat yesterday; it was fixed but broke again.',
    'We had no heat yesterday; it was fixed but has stopped working again.',
    'We had no heat yesterday; it was fixed. It stopped working again.',
    'No heat again after they fixed it yesterday.',
    'What should I do when there is no heat?',
    'What should I do if I have no heat right now?',
    'What is your policy for no heat since yesterday?',
    'What should I do if the heat is still out?',
    'I had no heat yesterday and it is still not fixed.',
    'What happens if there is no heat? Anyway, there is no heat in my apartment.',
    'What is your policy for no heat, but we have no heat right now.',
    'I am not reporting no heat in that unit; my heat is out.',
    'If the heat is out, actually my heat is out right now.',
    'We had no heat last winter. Now we have no heat again.',
  ]
  for (const utterance of current) {
    test(`preserves the heating guard for ${JSON.stringify(utterance)}`, () => {
      assert.ok(detectEmergency(utterance).some(signal => signal.kind === 'no_heat'))
    })
  }

  test('hypothetical heating wording cannot suppress stronger reports or life-safety guidance', () => {
    for (const [text, kind] of [
      ['What if there is no heat? I smell gas now.', 'gas'],
      ['I had no heat in my old apartment last winter, and there is a fire in my apartment.', 'smoke_or_fire'],
      ["I'm not reporting no heat, but my carbon monoxide alarm is going off.", 'carbon_monoxide'],
      ['What is your policy for no heat? My bathroom is flooding.', 'flooding'],
    ]) {
      const signals = detectEmergency(text!)
      assert.equal(signals.some(signal => signal.kind === 'no_heat'), false, text)
      assert.equal(primaryEmergency(signals)?.kind, kind, text)
    }
  })
})

describe('escalation carries everything the human needs', () => {
  test('an emergency gets a two-minute SLA', () => {
    const signal = primaryEmergency(detectEmergency('I smell gas'))!
    const e = buildEscalation({
      trigger: { kind: 'emergency', signal },
      propertyId: propertyId('prop-demo'),
      interactionId: interactionId('int-1'),
      transcript: [{ speaker: 'caller', text: 'I smell gas', at: NOW }],
      completedSteps: ['Gave gas safety instruction', 'Directed caller to 911'],
      pendingTask: 'Dispatch emergency gas vendor',
      now: NOW,
    })
    assert.equal(e.priority, 'emergency')
    assert.equal(e.respondBy.getTime() - NOW.getTime(), 120_000)
    assert.equal(e.transcript.length, 1, 'the human reads what was said, not a summary')
    assert.ok(e.completedSteps.length > 0, 'the human must not repeat work already done')
  })

  test('accommodation requests are urgent and never evaluated by the agent', () => {
    assert.equal(priorityFor({ kind: 'restricted_topic', topic: 'reasonable_accommodation' }), 'urgent')
    const e = buildEscalation({
      trigger: { kind: 'restricted_topic', topic: 'reasonable_accommodation' },
      propertyId: propertyId('prop-demo'),
      interactionId: interactionId('int-2'),
      transcript: [], completedSteps: [], pendingTask: 'Route accommodation request', now: NOW,
    })
    assert.match(e.recommendedNextAction, /Fair Housing/)
    assert.match(e.recommendedNextAction, /Do not evaluate/)
  })

  test('a caller asking for a person gets a callback recommendation', () => {
    const e = buildEscalation({
      trigger: { kind: 'human_requested' },
      propertyId: propertyId('prop-demo'),
      interactionId: interactionId('int-3'),
      callerNumber: '+15169909252',
      transcript: [], completedSteps: [], pendingTask: 'Call back', now: NOW,
    })
    assert.match(e.recommendedNextAction, /transcript already read/)
    assert.equal(e.callerNumber, '+15169909252')
  })
})

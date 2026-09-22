import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const appSource = await readFile(new URL('../../ops/src/app.js', import.meta.url), 'utf8')
const callsSource = await readFile(new URL('../../ops/src/calls.js', import.meta.url), 'utf8')
const at = '2032-06-01T15:00:00.000Z'
const question = 'How many bedrooms does residence 4A have?'
const tool = (name, result, args = {}) => ({ name, arguments: args, result })
const answer = result => tool('answer_question', result, { question, topic: 'general_property_fact' })

function workspace() {
  const window = { addEventListener() {}, scrollTo() {}, ATRIUM_RUNTIME_MODE: 'postgres',
    ATRIUM_ACCOUNT: { username: 'operator', displayName: 'Operator', userId: 'user-one' },
    ATRIUM_PROPERTY: { organizationId: 'org-one', propertyId: 'building-one', buildingName: 'Synthetic House',
      configurationVersion: 1, permissionVersion: 'permissions-one', timeZone: 'America/New_York',
      permissions: ['read', 'operate'], hours: {} } }
  const document = { readyState: 'loading', addEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [], getElementById: () => null,
    body: { classList: { toggle() {}, add() {}, remove() {} } } }
  const context = { window, document, location: { hash: '#/calls' }, Intl, Date, URLSearchParams,
    structuredClone, console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: false }),
    fetch: () => assert.fail('Synthetic call rendering must not contact any provider') }
  runInNewContext(appSource, context)
  runInNewContext(callsSource.replace("A.register('calls', view)",
    "window.callTruthUi = { rowHtml, panelHtml }; A.register('calls', view)"), context)
  const A = window.Atrium
  A.state.leads = { profiles: [], followUps: [], tourChangeRequests: [] }
  A.state.calendar = { bookings: [] }
  return {
    story(toolCalls = [], events = [], overrides = {}) {
      const record = { id: 'call-synthetic-truth', phone: '+13125550101', name: 'Dana Sample',
        displayName: 'Dana Sample', startedAt: at, durationSeconds: 75, profile: null,
        events, call: { startedAt: at, transcript: '', toolCalls }, ...overrides }
      const story = A.derive.callStory(record, A.state)
      return { story, html: window.callTruthUi.rowHtml(record, story, false, false, false)
        + window.callTruthUi.panelHtml(record, story, A.state) }
    },
  }
}

const narrative = story => [story.sentence, ...story.steps.map(step => step.text), ...story.chips.map(chip => chip.text)].join('\n')
const unsupportedSuccess = /answered from the approved information|Answered "|Offered \d+ tour times?|Checked what's available|Noted what they want|Noted it may not work out|Tour booked|Booked a tour/i

test('an all-unauthorized apartment enquiry is shown as failed instead of answered or scheduled', () => {
  const { story, html } = workspace().story([
    tool('check_availability', 'unauthorized', { unitId: '4A' }),
    tool('list_tour_slots', 'unauthorized', { unitId: '4A', preferredDate: '2032-06-02', preferredTime: '10:00' }),
    answer('unauthorized'),
    tool('check_availability', 'unauthorized', { bedrooms: 3 }),
  ])
  assert.equal(story.findings.answered.length, 0)
  assert.equal(story.findings.units.length, 0)
  assert.equal(story.findings.slots, null)
  assert.equal(story.booked, null)
  assert.equal(story.needsPerson, true)
  assert.equal(story.steps.length, 4)
  assert.match(story.sentence, /failed|could not be verified/i)
  for (const step of story.steps) assert.match(step.text, /error|not confirmed/i)
  assert.doesNotMatch(narrative(story), unsupportedSuccess)
  assert.match(html, /System step failed|system error/)
  assert.doesNotMatch(html, /answered from the approved information|Offered 0 tour times/)
  assert.match(html, /A system step needs review/)
  assert.doesNotMatch(html, /tour but it couldn't be booked|Staff must help arrange a time/)
  assert.doesNotMatch(narrative(story), /staff notified|took their details|offered a call back|apologised/i)
})

test('case, whitespace, HTTP failures and JSON error envelopes cannot become approved answers', () => {
  const ui = workspace()
  for (const result of ['  UnAuThOrIzEd\n', '403 Forbidden', 'HTTP 401 Unauthorized',
    'Error: Request failed with status code 503', 'Gateway Timeout.',
    '{"error":"unauthorized"}', '{"error":{"code":"upstream_failure"}}']) {
    const { story } = ui.story([answer(result)])
    assert.equal(story.findings.answered.length, 0, result)
    assert.equal(story.needsPerson, true, result)
    assert.match(story.sentence, /failed|could not be verified/i, result)
    assert.doesNotMatch(narrative(story), unsupportedSuccess, result)
  }
})

test('failed capture and booking attempts never create saved requirements, loss reasons or tours', () => {
  const { story } = workspace().story([
    tool('capture_signal', 'unauthorized', { signal: 'bedrooms', value: 2, excerpt: 'Two bedrooms please.' }),
    tool('capture_contact', 'unauthorized', { name: 'Dana Sample', phone: '+13125550102' }),
    tool('capture_loss_reason', 'unauthorized', { kind: 'priced_out', detail: 'Too expensive', evidence: 'Above my budget.' }),
    tool('book_tour', 'unauthorized', { slotId: 'slot-synthetic', unitId: '4A' }),
  ])
  assert.equal(Object.keys(story.findings.captured).length, 0)
  assert.equal(story.findings.loss, null)
  assert.equal(story.facts.length, 0)
  assert.equal(story.booked, null)
  assert.doesNotMatch(narrative(story), unsupportedSuccess)
  assert.doesNotMatch(narrative(story), /Priced out|Didn't work out|details.*(?:saved|recorded)/i)
})

test('a genuine booking survives an unrelated tool failure while the failed step still needs review', () => {
  const { story, html } = workspace().story([
    tool('book_tour', "You're all set. I've got you down for June 2 at 10 AM.", { unitId: '4A', slotId: 'slot-synthetic' }),
    answer('unauthorized'),
  ], [{ kind: 'tour_booked', status: 'confirmed', unitId: '4A', slot: 'June 2 at 10 AM', at }])
  assert.equal(story.booked.unitId, '4A')
  assert.match(story.sentence, /booked a tour of apartment 4A/)
  assert.equal(story.needsPerson, true)
  assert.equal(story.findings.answered.length, 0)
  assert.ok(story.chips.some(chip => chip.text === 'Tour booked'))
  assert.ok(story.chips.some(chip => /System step failed/i.test(chip.text)))
  assert.match(story.steps[1].text, /error|not confirmed/i)
  assert.match(html, /A system step needs review/)
  assert.doesNotMatch(html, /tour but it couldn't be booked|Staff must help arrange a time/)
})

test('a matching structured approved answer keeps its successful explanation', () => {
  const { story } = workspace().story([answer('Residence 4A has two bedrooms.')],
    [{ kind: 'question_answered', decision: 'answer', question, topic: 'general_property_fact',
      sources: ['synthetic-floorplan@v1'], at }])
  assert.equal(story.findings.answered.length, 1)
  assert.match(story.sentence, /answered from the approved information/)
  assert.match(story.steps[0].text, /Answered.*two bedrooms/)
  assert.equal(story.needsPerson, false)
})

test('unfamiliar free-form answer text does not establish an approved answer', () => {
  const { story } = workspace().story([answer('A response from an unrecognized tool version.')])
  assert.equal(story.findings.answered.length, 0)
  assert.doesNotMatch(narrative(story), /approved information|Answered "/)
  assert.match(story.steps[0].text, /response.*recorded|recorded.*response/i)
})

test('an approved event for another question does not approve an unrelated tool response', () => {
  const { story } = workspace().story([answer('An unverified bedroom response.')],
    [{ kind: 'question_answered', decision: 'answer', question: 'Does the building have a gym?',
      topic: 'amenities', sources: ['synthetic-amenities@v1'], at }])
  assert.equal(story.findings.answered.length, 1)
  assert.doesNotMatch(story.steps[0].text, /Answered|approved information/)
  assert.match(story.steps[0].text, /response.*recorded|recorded.*response/i)
})

test('empty or missing tool results remain unverified without asserting success or a dropped call', () => {
  const ui = workspace()
  for (const result of ['', ' \n ', null, undefined]) {
    const { story, html } = ui.story([answer(result)])
    assert.equal(story.findings.answered.length, 0)
    assert.equal(story.booked, null)
    assert.match(story.steps[0].text, /unverified|no result was saved/i)
    assert.doesNotMatch(narrative(story), /approved information|Answered "|Call dropped|hung up|apologised/)
    assert.doesNotMatch(html, /Call dropped|answered without needing/i)
  }
})

test('absence of tool activity does not imply the caller was answered or hung up before speaking', () => {
  const ui = workspace()
  for (const durationSeconds of [5, 75]) {
    const { story, html } = ui.story([], [], { durationSeconds })
    assert.match(story.sentence, /no tool activity|no verified outcome|no.*recorded/i)
    assert.doesNotMatch(narrative(story), /answered|hung up|before saying|Call dropped/i)
    assert.doesNotMatch(html, /hung up before saying|answered without needing/i)
  }
})

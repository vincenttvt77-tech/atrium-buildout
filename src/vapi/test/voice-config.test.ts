import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoAssistantConfig } from '../config.ts'
import { TOOL_DEFINITIONS, TOOL_MESSAGES } from '../assistant.ts'
import property from '../../../data/property.json' with { type: 'json' }

const config = demoAssistantConfig(property, 'https://example.test')

test('contact spelling retains time to finish without imposing that delay on ordinary leasing answers', () => {
  const [rule] = config.startSpeakingPlan.customEndpointingRules
  const regex = new RegExp(rule!.regex, 'i')
  for (const question of ['What is your email?', 'What callback number should the office use?', 'Could you spell your name?']) {
    assert.equal(regex.test(question), true, question)
  }
  for (const question of ['When are you looking to move?', 'How many bedrooms?', 'What is your budget?', 'Would you like to see it?']) {
    assert.equal(regex.test(question), false, question)
  }
  assert.equal(rule!.timeoutSeconds, 3)
  assert.ok(config.startSpeakingPlan.waitSeconds <= 0.4)
  assert.ok(config.startSpeakingPlan.transcriptionEndpointingPlan.onNumberSeconds > config.startSpeakingPlan.transcriptionEndpointingPlan.onPunctuationSeconds)
})

test('the Larkin configuration distinguishes an illustrative demo and excludes frozen scheduling policy', () => {
  assert.match(config.firstMessage, /Larkin demo/)
  assert.match(config.firstMessage, /AI assistant.*recorded/)
  assert.match(config.model.messages[0]!.content, /fictional demonstration property/)
  assert.ok(!config.model.messages[0]!.content.includes(property.leasingHours))
  assert.ok(!config.model.messages[0]!.content.includes('Two model residences open for tours'))
  const realProperty = { ...property, sourceNote: '' }
  assert.doesNotMatch(demoAssistantConfig(realProperty, 'https://example.test').firstMessage, / demo/)
})

test('calendar tool schema carries the apartment filter and keeps email optional', () => {
  const slots = TOOL_DEFINITIONS.find((tool) => tool.function.name === 'list_tour_slots')!
  const booking = TOOL_DEFINITIONS.find((tool) => tool.function.name === 'book_tour')!
  assert.ok(Object.hasOwn(slots.function.parameters.properties, 'unitId'))
  const slotProperties = slots.function.parameters.properties
  assert.ok('preferredTime' in slotProperties)
  assert.ok(new RegExp(slotProperties.preferredTime.pattern).test('16:00'))
  assert.equal(new RegExp(slotProperties.preferredTime.pattern).test('24:00'), false)
  const required = (booking.function.parameters as { required?: readonly string[] }).required ?? []
  assert.ok(!required.includes('prospectEmail'))
  assert.equal(TOOL_MESSAGES.book_tour![0]!.blocking, false)
  assert.doesNotMatch(String(TOOL_MESSAGES.book_tour![0]!.content), /confirmed|locked|locking/i)
})

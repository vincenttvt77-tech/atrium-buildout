import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBedrooms, parseBudget, captureSignal, checkAvailability } from '../tools.ts'
import type { ToolContext } from '../tools.ts'
import { emptyQualification } from '../../leasing/qualification.ts'
import { propertyId, interactionId } from '../../domain/ids.ts'

const now = new Date('2026-09-09T12:00:00Z')
const ctx = (): ToolContext => ({
  propertyId: propertyId('prop-demo'), interactionId: interactionId('voice-numbers'),
  inventory: { readAt: now, source: 'test', floorPlans: [], units: [
    { unitId: 'A', floorPlanId: 'A1', bedrooms: 1, bathrooms: 1, sqft: 700, floor: 2, monthlyRent: 4490, availableFrom: '2026-09-10', status: 'available' },
    { unitId: 'S', floorPlanId: 'S1', bedrooms: 0, bathrooms: 1, sqft: 500, floor: 2, monthlyRent: 3500, availableFrom: '2026-09-10', status: 'available' },
  ] },
  articles: [], qualification: emptyQualification(), jurisdiction: 'NY', confidenceThreshold: 0.7, now,
})

test('common spoken budget amounts keep the complete number', () => {
  for (const [speech, expected] of [
    ['four thousand five hundred', 4500], ['four thousand and five hundred and fifty', 4550],
    ['thirty-eight hundred', 3800], ['forty-two hundred', 4200], ['4 thousand 5 hundred', 4500],
    ['4.5 thousand', 4500], ['$4. 500', 4500], ['four grand', 4000],
  ] as const) assert.equal(parseBudget(speech, speech), expected, speech)
})

test('spoken bedrooms distinguish one bedroom from studios and reject ambiguous or missing sizes', () => {
  for (const [speech, expected] of [['one bedroom', 1], ['two bedrooms', 2], ['2br', 2], ['studio', 0], ['zero bedrooms', 0]] as const) {
    assert.equal(parseBedrooms(speech), expected, speech)
  }
  for (const speech of ['', 'whatever', 'one or two bedrooms', 'one and two bedrooms', '12 bedrooms', '1.5']) {
    assert.equal(parseBedrooms(speech), null, speech)
    const result = captureSignal({ signal: 'bedrooms', value: speech, excerpt: speech || 'unclear' }, ctx())
    assert.equal(result.record.captured, false, speech)
    assert.equal(result.qualificationPatch?.bedrooms, undefined)
  }
})

test('one inline lookup uses the full spoken budget and correct bedroom need', () => {
  const result = checkAvailability(ctx(), { bedrooms: 'one bedroom', budget: 'four thousand five hundred', moveIn: 'September' })
  assert.equal(result.qualificationPatch?.budget?.value.maxMonthly, 4500)
  assert.equal(result.qualificationPatch?.bedrooms?.value.min, 1)
  assert.deepEqual(result.record.unitsOffered, ['A'])
})

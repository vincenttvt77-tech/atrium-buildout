import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voiceTourEmailEnabled } from '../voice-tour-confirmation.ts'
import type { PropertySnapshot } from '../../properties/model.ts'
test('voice tour opt-in is explicit, scoped, exact and expires independently of staff email', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const valid = { enabled:true, organizationId:'org-a', propertyId:'prop-a', reviewExpiresAt:'2026-09-24T12:00:00Z' }
  const snapshot = (value: unknown) => ({ organizationId:'org-a', propertyId:'prop-a', property:{voiceTourConfirmation:value} }) as unknown as PropertySnapshot
  assert.equal(voiceTourEmailEnabled(snapshot(valid),now),true)
  for(const value of [null,true,{}, {...valid,enabled:false},{...valid,organizationId:'org-b'},{...valid,propertyId:'prop-b'},
    {...valid,reviewExpiresAt:now.toISOString()},{...valid,reviewExpiresAt:'invalid'},{...valid,reviewExpiresAt:'2027-01-01T00:00:00Z'}, {...valid,unreviewed:true}]) {
    assert.equal(voiceTourEmailEnabled(snapshot(value),now),false)
  }
})

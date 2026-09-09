import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCalendarHandler } from '../calendar.ts'
import { calendarStoreFromEnv } from '../../src/calendar/store.ts'
import { documentStoreFromEnv } from '../../src/store/documents.ts'
import { emptyProfile } from '../../src/leads/profile.ts'
import { profileKey, followUpKey } from '../../src/leads/consolidate.ts'
import { deriveFollowUps } from '../../src/leads/followups.ts'
import { hashPassword, type OpsAccount } from '../../src/ops/accounts.ts'
import { mintAccountSession, OPS_COOKIE } from '../../src/ops/session.ts'
import { withTenant } from '../../src/tenancy/context.ts'
import type { InventorySnapshot } from '../../src/inventory/types.ts'

const environment = { ...process.env }
const now = new Date('2032-06-01T10:00:00Z')
const passcode = 'calendar-actions-local-test'
const phone = '+12025550101'
const store = calendarStoreFromEnv(), documents = documentStoreFromEnv()
const inventory: InventorySnapshot = { units: ['12A', '12B'].map(unitId => ({ unitId, floorPlanId: 'A', floor: 12,
  bedrooms: 1, bathrooms: 1, sqft: 800, monthlyRent: 4000, availableFrom: '2032-01-01', status: 'available' })),
  floorPlans: [], readAt: now, source: 'Synthetic test inventory' }
const handler = createCalendarHandler({ now: () => now, inventory })
const booking = { externalId: 'existing-booking', slotId: 'slot-2032-06-01T14:00', startsAt: '2032-06-01T14:00:00.000Z',
  endsAt: '2032-06-01T14:30:00.000Z', prospectName: 'Synthetic visitor', prospectPhone: phone, prospectEmail: 'visitor@example.com',
  unitId: '12A', bookedAt: '2032-05-25T14:00:00.000Z', interactionId: 'original-call' }
before(() => {
  for (const key of ['ATRIUM_RUNTIME_MODE', 'OPS_ACCOUNTS_JSON', 'OPS_SESSION_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL', 'NODE_ENV']) delete process.env[key]
  process.env.OPS_DASHBOARD_PASSCODE = passcode
})
after(() => { for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment) })
beforeEach(async () => {
  await store.mutate(() => ({ blocks: [], bookings: [] }))
  for (const key of await documents.list('')) await documents.delete(key)
})
async function invoke(method: string, body?: Record<string, unknown>, headers: Record<string, string> = {}, query: Record<string, string> = {}, target = handler) {
  const result: any = { code: 0, body: null, setHeader() {}, status(code: number) { this.code = code; return this }, json(value: unknown) { this.body = value; return this } }
  await target({ method, headers: { 'x-ops-passcode': passcode, 'x-atrium-tenant-id': 'legacy', ...headers },
    query: { from: '2032-06-01', to: '2032-06-03', ...query }, body: body ? { expectedTimeZone: 'America/New_York', ...body } : undefined }, result)
  return result
}
const blockInput = { action: 'unit_block', requestId: 'block-api-request', unitId: '12A', date: '2032-06-01', endDate: '2032-06-02', allDay: true, reason: 'Renovation' }
const moveInput = { action: 'reschedule', requestId: 'reschedule-api-request', externalId: booking.externalId, expectedRevision: 0, slotId: 'slot-2032-06-02T15:00', unitId: '12A' }
async function seed() {
  await store.mutate(state => ({ ...state, bookings: [structuredClone(booking)] }))
  const profile = { ...emptyProfile(phone, new Date(booking.bookedAt)), name: booking.prospectName, email: booking.prospectEmail,
    calls: [{ callId: booking.interactionId, at: booking.bookedAt, durationSeconds: null, outcome: 'Booked a tour', toolsCalled: ['book_tour'] }],
    bookings: [{ externalId: booking.externalId, slotId: booking.slotId, startsAt: booking.startsAt, unitId: booking.unitId, status: 'confirmed' as const, callId: booking.interactionId }] }
  await documents.set(profileKey(phone), profile)
  for (const followup of deriveFollowUps(profile, new Date(booking.bookedAt), booking.interactionId)) await documents.set(followUpKey(followup.id), followup)
}

test('calendar keeps unit blackouts separate, exposes inventory/conflicts and never cancels an existing tour', async () => {
  await seed()
  const response = await invoke('POST', blockInput)
  assert.equal(response.code, 200)
  assert.deepEqual(response.body.units.map((unit: any) => unit.id), ['12A', '12B'])
  assert.equal(response.body.blocks.length, 0)
  assert.equal(response.body.unitBlocks.length, 1)
  assert.deepEqual(response.body.unitBlocks[0].conflictingBookingIds, [booking.externalId])
  assert.equal(response.body.bookings.length, 1)
  assert.deepEqual(response.body.bookings[0].conflictBlockIds, [response.body.unitBlocks[0].id])
  const foreign = await invoke('POST', { ...blockInput, requestId: 'foreign-unit-request', unitId: '99Z' })
  assert.equal(foreign.code, 400)
  assert.equal((await store.read()).unitBlocks?.length, 1)
  const removed = await invoke('POST', { action: 'unit_unblock', blockId: response.body.unitBlocks[0].id, revision: 0 })
  assert.equal(removed.code, 200)
  assert.equal(removed.body.unitBlocks.length, 0)
  assert.equal(removed.body.bookings.length, 1)
})

test('manual move updates one booking and lead, supersedes old reminders, and exact retry creates no duplicate', async () => {
  await seed()
  const moved = await invoke('POST', moveInput)
  assert.equal(moved.code, 200, JSON.stringify(moved.body))
  assert.equal(moved.body.reschedule.status, 'complete')
  assert.equal(moved.body.reschedule.notificationSent, false)
  assert.equal(moved.body.bookings.length, 1)
  assert.equal(moved.body.bookings[0].externalId, booking.externalId)
  assert.equal(moved.body.bookings[0].bookedAt, booking.bookedAt)
  assert.equal(moved.body.bookings[0].revision, 1)
  const profile: any = await documents.get(profileKey(phone))
  assert.equal(profile.bookings.length, 1)
  assert.equal(profile.bookings[0].startsAt, '2032-06-02T15:00:00.000Z')
  const followups: any[] = await Promise.all((await documents.list('followup:')).map(key => documents.get(key)))
  assert.ok(!followups.some(row => row.status === 'scheduled' && ['remind_tour', 'confirm_tour', 'post_tour'].includes(row.kind) && row.source?.booking?.startsAt === booking.startsAt))
  const retry = await invoke('POST', moveInput)
  assert.equal(retry.code, 200)
  assert.equal(retry.body.bookings[0].rescheduleHistory.length, 1)
  const changed = await invoke('POST', { ...moveInput, slotId: 'slot-2032-06-02T16:00' })
  assert.equal(changed.code, 409)
})

test('availability preview excludes original booking and a conflicting move preserves it', async () => {
  await seed()
  const preview = await invoke('GET', undefined, {}, { rescheduleBookingId: booking.externalId, unitId: '12A' })
  assert.equal(preview.code, 200)
  assert.ok(preview.body.reschedule.slots.some((slot: any) => slot.slotId === booking.slotId))
  await invoke('POST', { ...blockInput, date: '2032-06-02', endDate: '2032-06-02' })
  const before = await store.read()
  const response = await invoke('POST', moveInput)
  assert.equal(response.code, 409)
  assert.deepEqual(await store.read(), before)
})

test('partial document write returns durable pending status and reschedule_sync safely repairs it', async () => {
  await seed()
  let fail = true
  const faulty = createCalendarHandler({ now: () => now, inventory, documents: { ...documents,
    update: (key, initial, fn) => { if (fail && key.startsWith('followup:')) return Promise.reject(new Error('Synthetic document outage')); return documents.update(key, initial, fn) } } })
  const pending = await invoke('POST', moveInput, {}, {}, faulty)
  assert.equal(pending.code, 202)
  assert.equal(pending.body.reschedule.status, 'pending_projection')
  assert.equal(pending.body.bookings[0].startsAt, '2032-06-02T15:00:00.000Z')
  assert.equal(pending.body.rescheduleProjectionPending.length, 1)
  fail = false
  const retry = await invoke('POST', { action: 'reschedule_sync', externalId: booking.externalId, revision: 1, requestId: moveInput.requestId }, {}, {}, faulty)
  assert.equal(retry.code, 200)
  assert.equal(retry.body.reschedule.status, 'complete')
  assert.deepEqual(retry.body.rescheduleProjectionPending, [])
  assert.equal((await store.read()).bookings.length, 1)
})

test('new writes require the frozen tenant header and stale tabs cannot read or mutate the newly signed-in account', async () => {
  const result: any = { code: 0, body: null, setHeader() {}, status(code: number) { this.code = code; return this }, json(value: unknown) { this.body = value; return this } }
  await handler({ method: 'POST', headers: { 'x-ops-passcode': passcode }, body: { ...blockInput, expectedTimeZone: 'America/New_York' } }, result)
  assert.equal(result.code, 428)
  const accounts: OpsAccount[] = ['alpha', 'bravo'].map(id => ({ username: id, tenantId: `action-${id}`, displayName: id,
    passwordHash: '', assistantIds: [] }))
  const hash = await hashPassword('Only-for-local-account-switch-test')
  accounts.forEach(account => { account.passwordHash = hash })
  process.env.OPS_ACCOUNTS_JSON = JSON.stringify(accounts)
  process.env.OPS_SESSION_SECRET = 'local-calendar-action-session-signing-at-least-32'
  try {
    const switched = { cookie: `${OPS_COOKIE}=${mintAccountSession(new Date(), accounts[1]!)}`, 'x-atrium-tenant-id': accounts[0]!.tenantId }
    for (const method of ['GET', 'POST']) {
      const rejected = await invoke(method, method === 'POST' ? blockInput : undefined, switched)
      assert.equal(rejected.code, 409)
      assert.equal(rejected.body.code, 'portal_tenant_changed')
    }
    assert.equal((await withTenant(accounts[1]!.tenantId, () => store.read())).unitBlocks, undefined)
    const accepted = await invoke('POST', blockInput, { ...switched, 'x-atrium-tenant-id': accounts[1]!.tenantId })
    assert.equal(accepted.code, 200)
    assert.equal((await withTenant(accounts[0]!.tenantId, () => store.read())).unitBlocks, undefined)
  } finally { delete process.env.OPS_ACCOUNTS_JSON; delete process.env.OPS_SESSION_SECRET }
})

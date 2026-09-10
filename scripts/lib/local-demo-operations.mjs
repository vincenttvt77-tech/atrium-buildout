import { generateSlots, statusOf, slotDate } from '../../src/calendar/slots.ts'
import { effectiveOptions, validateSettings } from '../../src/calendar/settings.ts'
import { calendarRange } from '../../src/calendar/range.ts'
import { listProfiles, listFollowUps, profileKey, followUpKey } from '../../src/leads/consolidate.ts'
import { normalisePhone, pinnedName } from '../../src/leads/profile.ts'

/** Startup-only template import. Uses the demo channel's scoped, audited stores;
 * never creates a human session or enrolls a synthetic passkey on a real account.
 * This finite operation set is not mounted as an HTTP endpoint.
 */
export function localDemoOperations(runtime, { organizationId, propertyId }) {
  if (runtime.scope.actor.kind !== 'channel' || runtime.scope.organizationId !== organizationId
    || runtime.scope.propertyId !== propertyId || runtime.snapshot.inventory.provenance?.sourceMode !== 'demo') {
    throw new Error('Template import requires the exact fictional demo channel.')
  }
  const timeZone = runtime.snapshot.timeZone
  const defaults = { ...runtime.tourSettings, timeZone, unitIds: runtime.snapshot.inventory.units.map(unit => unit.unitId) }
  async function calendar(now) {
    const state = await runtime.calendarStore.read(), options = effectiveOptions(state, defaults)
    const settings = validateSettings(options), range = calendarRange(undefined, undefined, now, timeZone)
    const generated = generateSlots(now, { ...options, from: range.start, to: range.end })
    return { ...state, slots: generated.map(slot => ({ slotId: slot.slotId, date: slotDate(slot.startsAt, timeZone),
      startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), status: statusOf(slot, state, settings.capacity, options) })) }
  }
  return async (method, path, body, now = new Date()) => {
    await runtime.revalidate()
    if (method === 'GET' && path === '/api/calendar') return calendar(now)
    if (method === 'GET' && path === '/api/leads') return {
      profiles: await listProfiles(runtime.documents), followUps: await listFollowUps(runtime.documents) }
    if (method !== 'POST' || !body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unsupported template operation.')
    if (path === '/api/calendar' && body.action === 'block') {
      const target = String(body.target ?? '').trim(), reason = String(body.reason ?? '').trim().slice(0, 120) || 'blocked'
      let interval
      if (target.startsWith('slot-')) {
        const slot = (await calendar(now)).slots.find(slot => slot.slotId === target)
        if (!slot) throw new Error('Template block does not match an available calendar slot.')
        interval = { startsAt: slot.startsAt, endsAt: slot.endsAt }
      } else {
        const range = calendarRange(target, target, now, timeZone)
        interval = { startsAt: range.start.toISOString(), endsAt: range.end.toISOString() }
      }
      await runtime.calendarStore.mutate(state => {
        if (state.blocks.some(block => block.target === target)) throw new Error('Template block already exists; inspect import progress before resuming.')
        return { ...state, blocks: [...state.blocks, { target, reason, blockedAt: now.toISOString(), ...interval }] }
      })
      return calendar(now)
    }
    if (path === '/api/leads' && body.action === 'note') {
      const phone = normalisePhone(String(body.phone ?? '')), text = String(body.text ?? '').trim().slice(0, 500)
      if (phone === 'unknown' || !text) throw new Error('Template note requires a phone and text.')
      const existing = await runtime.documents.get(profileKey(phone))
      if (!existing) throw new Error('Template note has no matching prospect.')
      const profile = await runtime.documents.update(profileKey(phone), existing, value => {
        const notes = [...value.notes, `${now.toISOString()} ${text}`], name = pinnedName(notes)
        return { ...value, notes, ...(name ? { name } : {}) }
      })
      return { profile }
    }
    if (path === '/api/leads' && body.action === 'followup_status') {
      if (!/^fu-/.test(body.id) || !['scheduled', 'done', 'skipped'].includes(body.status)) throw new Error('Invalid template follow-up change.')
      const existing = await runtime.documents.get(followUpKey(body.id))
      if (!existing) throw new Error('Template follow-up does not exist.')
      const followUp = await runtime.documents.update(followUpKey(body.id), existing, value => {
        if (value.superseded && body.status === 'scheduled') throw new Error('Cannot restore a superseded template reminder.')
        return { ...value, status: body.status }
      })
      return { followUp }
    }
    throw new Error('Unsupported template operation.')
  }
}

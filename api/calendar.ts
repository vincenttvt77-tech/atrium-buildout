import { authorizeOps } from '../src/ops/session.ts'
import { calendarStoreFromEnv } from '../src/calendar/store.ts'
import { generateSlots, statusOf, slotDate, blockFor, bookingsFor, bookingSlot, occupancyPeak, occupied, unitBlocksFor } from '../src/calendar/slots.ts'
import { defaultSettings, effectiveOptions, validateSettings } from '../src/calendar/settings.ts'
import { addCalendarDays, calendarRange, parseCalendarDate } from '../src/calendar/range.ts'
import { withTenant } from '../src/tenancy/context.ts'
import { isHostedRuntime } from '../src/store/config.ts'
import { propertyTimeZone } from '../src/config/property.ts'
import { isPostgresRuntime, resolveOpsRuntime, runWithPropertyRuntime, readRuntimeError } from '../src/application/runtime.ts'
import type { ResolvedPropertyRuntime } from '../src/application/runtime.ts'
import type { SlotOptions } from '../src/calendar/slots.ts'
import { randomUUID } from 'node:crypto'
import { CalendarActionError, activeUnitBlocks, addUnitBlock, prepareUnitBlock, removeUnitBlock, requestIdentity } from '../src/calendar/unit-blocks.ts'
import { bookingRevision, findBooking, previewReschedule, rescheduleBooking, completeRescheduleProjection } from '../src/calendar/reschedule.ts'
import type { CalendarStore, CalendarState } from '../src/calendar/types.ts'
import { documentStoreFromEnv } from '../src/store/documents.ts'
import type { DocumentStore } from '../src/store/documents.ts'
import { reconcileRescheduledTour } from '../src/leads/reschedule.ts'
import rawUnits from '../data/inventory.json' with { type: 'json' }
import rawPlans from '../data/floorplans.json' with { type: 'json' }
import rawInventorySource from '../data/inventory-source.json' with { type: 'json' }
import { loadInventory } from '../src/inventory/load.ts'
import type { InventorySnapshot } from '../src/inventory/types.ts'

const store = calendarStoreFromEnv()
const documents = documentStoreFromEnv()
export const TOUR_CAPACITY = defaultSettings().capacity

function calendarView(now: Date, state: Awaited<ReturnType<typeof store.read>>, range: ReturnType<typeof calendarRange>, timeZone: string, defaults: SlotOptions = {}, inventory?: InventorySnapshot) {
  const opts = effectiveOptions(state, { ...defaults, timeZone })
  const settings = validateSettings(opts)
  const generated = generateSlots(now, { ...opts, from: range.start, to: range.end, enforceBookingRules: false })
  const allowed = new Set(generateSlots(now, { ...opts, from: range.start, to: range.end }).map(s => s.slotId))
  // A retained date block may cover only part of a local day after a timezone
  // correction. Tell the portal which visible dates it actually covers in full.
  const dates: string[] = []
  for (let date = range.from; date <= range.to; date = addCalendarDays(date, 1)) dates.push(date)
  const blocks = state.blocks.map(block => ({ ...block, wholeDayDates: block.target.startsWith('slot-') ? [] : dates.filter(date => {
    if (block.startsAt === undefined && block.endsAt === undefined) return block.target === date
    const day = calendarRange(date, date, now, timeZone)
    return Date.parse(block.startsAt ?? '') <= day.start.getTime() && Date.parse(block.endsAt ?? '') >= day.end.getTime()
  }) }))
  // Saved tours always retain their actual times, even on days that are now closed.
  const slots = new Map(generated.map(s => [s.slotId, s]))
  for (const booking of state.bookings) {
    const saved = bookingSlot(booking)
    if (saved && saved.startsAt >= range.start && saved.startsAt < range.end && !slots.has(saved.slotId)) slots.set(saved.slotId, saved)
  }
  const unitBlocks = activeUnitBlocks(state).map(block => ({ ...block,
    conflictingBookingIds: state.bookings.filter(booking => {
      const interval = occupied(booking)
      return booking.unitId?.toUpperCase() === block.unitId.toUpperCase() && interval
        && interval[0] < Date.parse(block.endsAt) && interval[1] > Date.parse(block.startsAt)
    }).map(booking => booking.externalId),
  }))
  const savedBookings = state.bookings.map(booking => ({ ...booking, revision: bookingRevision(booking),
    conflictBlockIds: unitBlocks.filter(block => block.conflictingBookingIds.includes(booking.externalId)).map(block => block.id),
  }))
  return {
    capacity: settings.capacity, settings, settingsRevision: state.settingsRevision ?? 0,
    timeZone, range: { from: range.from, to: range.to },
    slots: [...slots.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map(s => {
      const actualStatus = statusOf(s, state, settings.capacity, opts)
      const bookings = bookingsFor(s, state).map(b => ({ externalId: b.externalId, prospectName: b.prospectName, unitId: b.unitId, startsAt: bookingSlot(b)!.startsAt.toISOString(), endsAt: bookingSlot(b)!.endsAt.toISOString(), revision: bookingRevision(b), conflictBlockIds: savedBookings.find(row => row.externalId === b.externalId)!.conflictBlockIds }))
      const block = blockFor(s, state, opts)
      const unavailable = !allowed.has(s.slotId)
      const reason = s.startsAt < now ? 'Past tour time' : s.startsAt.getTime() < now.getTime() + settings.minimumNoticeMinutes * 60000 ? 'Inside minimum notice' : 'Outside booking window or current tour hours'
      return {
        slotId: s.slotId, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), date: slotDate(s.startsAt, timeZone),
        status: actualStatus === 'open' && unavailable ? 'unavailable' : actualStatus,
        ...(unavailable ? { reason } : {}), capacity: settings.capacity,
        booked: occupancyPeak(s, state, opts), bookings,
        blockedUnitIds: [...new Set(unitBlocksFor(s, state, opts).map(block => block.unitId))],
        ...(bookings[0] ? { booking: bookings[0] } : {}),
        ...(block ? { block: { target: block.target, reason: block.reason, wholeDay: blocks.find(b => b.target === block.target)?.wholeDayDates.includes(slotDate(s.startsAt, timeZone)) ?? false } } : {}),
      }
    }),
    blocks, bookings: savedBookings, unitBlocks,
    units: (inventory?.units ?? []).map(unit => ({ id: unit.unitId, unitId: unit.unitId, label: unit.unitId,
      floorPlanId: unit.floorPlanId, floorPlanName: inventory?.floorPlans.find(plan => plan.id === unit.floorPlanId)?.name ?? unit.floorPlanId,
      bedrooms: unit.bedrooms, bathrooms: unit.bathrooms, sqft: unit.sqft, floor: unit.floor, monthlyRent: unit.monthlyRent, status: unit.status })),
    inventory: inventory ? { sourceMode: inventory.provenance?.sourceMode ?? 'live', readAt: inventory.readAt.toISOString(),
      source: inventory.source, fictional: inventory.provenance?.sourceMode === 'demo' } : null,
    rescheduleProjectionPending: state.bookings.flatMap(booking => (booking.rescheduleHistory ?? []).filter(change => change.projection === 'pending')
      .map(change => ({ externalId: booking.externalId, requestId: change.requestId, revision: change.revision,
        changedAt: change.at, status: 'pending_projection' }))),
    store: store.describe(), generatedAt: now.toISOString(),
  }
}

/** Injection is server-owned configuration for tests and the future property resolver. */
export function createCalendarHandler(options: { property?: Record<string, unknown>; now?: () => Date; inventory?: InventorySnapshot; documents?: DocumentStore } = {}) {
return async function handler(req: any, res: any) {
  req.atriumRequestId = randomUUID()
  res.setHeader('x-request-id', req.atriumRequestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  const now = options.now?.() ?? new Date()
  let runtime: ResolvedPropertyRuntime | undefined
  let tenantId: string | undefined
  let actorId: string
  try {
    if (isPostgresRuntime()) {
      let action: unknown
      try { if (req.method === 'POST') action = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body)?.action }
      catch { res.status(400).json({error:'Invalid JSON request.'}); return }
      runtime = await resolveOpsRuntime(req, req.method === 'GET' ? 'read' : action === 'settings' ? 'configure' : 'operate', now)
      if (runtime.scope.actor.kind !== 'user') throw new Error('Staff authentication is required.')
      actorId = runtime.scope.actor.userId
      const json = res.json.bind(res)
      res.json = (body: Record<string, unknown>) => json({...body,scope:runtime!.responseScope})
    } else {
      const auth = authorizeOps(req.headers ?? {}, new Date())
      if (!auth.ok) {
        res.status(auth.reason === 'not_configured' ? 503 : 401).json({ error: auth.reason === 'not_configured' ? 'The calendar requires a configured portal account.' : 'unauthorized' })
        return
      }
      tenantId = auth.tenantId
      actorId = auth.username
      const selectedTenant = req.headers?.['x-atrium-tenant-id']
      if (selectedTenant !== undefined && selectedTenant !== tenantId) {
        res.status(409).json({ error: 'The signed-in account changed. Reload the portal before continuing.', code: 'portal_tenant_changed' }); return
      }
    }
  } catch (error) { const failure = readRuntimeError(error); res.status(failure.status).json(failure.body); return }
  const run = async () => {
    let timeZone: string
    try { timeZone = runtime?.snapshot.timeZone ?? propertyTimeZone(options.property) }
    catch { res.status(503).json({ error: 'The property timezone is invalid. Ask an administrator to correct its IANA timezone.', code: 'property_timezone_invalid' }); return }
    let body: any, range: ReturnType<typeof calendarRange>
    try {
      body = req.method === 'GET' ? {} : typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('A JSON object is required.')
      range = calendarRange(req.query?.from ?? body.from, req.query?.to ?? body.to, now, timeZone)
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' }); return }
    if (req.method === 'POST' && body.expectedTimeZone === undefined) {
      res.status(428).json({ error: 'The portal must provide its property timezone. Reload the portal before changing tours.' }); return
    }
    if (req.method === 'POST' && body.expectedTimeZone !== timeZone) {
      res.status(409).json({ error: 'The property timezone changed. Reload the portal before changing tours.' }); return
    }
    if (!runtime && req.method === 'POST' && ['unit_block', 'unit_unblock', 'reschedule', 'reschedule_sync'].includes(body.action)
      && req.headers?.['x-atrium-tenant-id'] === undefined) {
      res.status(428).json({ error: 'Reload the portal to confirm the current account before changing apartment availability or tours.', code: 'portal_tenant_required' }); return
    }
    try {
      const inventory = runtime?.snapshot.inventory ?? options.inventory ?? (() => {
        const loaded = loadInventory(rawUnits, rawPlans, new Date(rawInventorySource.catalogAsOf), 'Bundled fictional demo inventory; no PMS connection', rawInventorySource, now)
        if (loaded.problems.length) throw new Error('The property inventory configuration is invalid.')
        return loaded.snapshot
      })()
      const defaults: SlotOptions = { ...runtime?.tourSettings, timeZone, unitIds: inventory.units.map(unit => unit.unitId) }
      const view = (state: CalendarState) => calendarView(now, state, range, timeZone, defaults, inventory)
      if (req.method === 'GET') {
        const state = await store.read()
        const result = view(state)
        const preview = req.query?.rescheduleBookingId === undefined ? undefined
          : previewReschedule(state, req.query.rescheduleBookingId, req.query.unitId === '' ? null : req.query.unitId, now, range, defaults)
        if (runtime) await runtime.revalidate()
        res.status(200).json({ ...result, ...(preview ? { reschedule: preview } : {}) }); return
      }
      if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return }
      if (body.action === 'reschedule' || body.action === 'reschedule_sync') {
        const requestId = requestIdentity(body.requestId)
        const perform = async (calendar: CalendarStore, projectionDocuments: DocumentStore) => {
          let state = body.action === 'reschedule'
            ? await calendar.mutate(current => rescheduleBooking(current, body, now, defaults, actorId!)) : await calendar.read()
          const booking = findBooking(state, body.externalId)
          const change = booking.rescheduleHistory?.find(item => item.requestId === requestId)
          if (!change || (body.action === 'reschedule_sync' && change.revision !== body.revision)) {
            throw new CalendarActionError('reschedule_request_conflict', 'Use the saved reschedule request and revision to retry.', 409)
          }
          let status: 'complete' | 'pending_projection' | 'superseded' = change.revision === bookingRevision(booking) ? 'complete' : 'superseded'
          if (change.projection === 'pending' && status !== 'superseded') {
            const projected = await reconcileRescheduledTour(projectionDocuments, { booking, change })
            if (projected.status === 'complete') state = await calendar.mutate(current => completeRescheduleProjection(current, booking.externalId, requestId, change.revision))
            else status = 'pending_projection'
          }
          return { state, status, externalId: booking.externalId, requestId, revision: change.revision,
            notificationSent: false, message: status === 'pending_projection'
              ? 'The tour moved on the calendar. Lead and follow-up records still need reconciliation; retry this saved change. No notification was sent.'
              : status === 'superseded' ? 'This saved change was already followed by a newer reschedule. The current tour is shown. No notification was sent.'
                : 'The tour and associated lead/follow-up records are updated. Tell the visitor about the new time; no notification was sent.' }
        }
        try {
          const result = runtime ? await runtime.calendarStore.transaction(unit => perform(unit.calendar, unit.documents)) : await perform(store, options.documents ?? documents)
          const { state, ...reschedule } = result
          res.status(result.status === 'pending_projection' ? 202 : 200).json({ ...view(state), reschedule })
        } catch (error) {
          if (error instanceof CalendarActionError) throw error
          if (!runtime) {
            // KV cannot atomically update several documents. Read the durable calendar
            // marker before describing an uncertain result; never claim rollback.
            const state = await store.read()
            const booking = state.bookings.find(row => row.externalId === body.externalId)
            const change = booking?.rescheduleHistory?.find(row => row.requestId === requestId)
            if (booking && change?.projection === 'pending') {
              res.status(202).json({ ...view(state), reschedule: { status: 'pending_projection', externalId: booking.externalId,
                requestId, revision: change.revision, notificationSent: false,
                message: 'The tour moved on the calendar, but associated records are still pending. Retry this saved change. No notification was sent.' } }); return
            }
          }
          throw error
        }
        return
      }
      let state
      switch (String(body.action ?? '')) {
        case 'unit_block': {
          const block = prepareUnitBlock(body, defaults.unitIds!, timeZone, now)
          state = await store.mutate(current => addUnitBlock(current, block))
          break
        }
        case 'unit_unblock':
          state = await store.mutate(current => removeUnitBlock(current, body.blockId, body.revision, now))
          break
        case 'settings': {
          let settings
          try { settings = validateSettings(body.settings) } catch (error) { res.status(400).json({ error: (error as Error).message }); return }
          if (!Number.isInteger(body.settingsRevision) || body.settingsRevision < 0) { res.status(400).json({ error: 'settingsRevision is required' }); return }
          state = await store.mutate(s => {
            if ((s.settingsRevision ?? 0) !== body.settingsRevision) throw new Error('SETTINGS_CONFLICT')
            return { ...s, settings, settingsRevision: (s.settingsRevision ?? 0) + 1 }
          })
          break
        }
        case 'block': {
          const target = String(body.target ?? '').trim()
          let startsAt: Date | null = null
          let restoredEnd: Date | null = null
          let wholeDayEnd: Date | null = null
          try {
            if (target.startsWith('slot-')) {
              if (!/^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(target)) throw new Error('Invalid slot id')
              // A slot identifier encodes a UTC instant, not a local calendar date.
              parseCalendarDate(target.slice(5, 15), 'UTC')
              startsAt = new Date(`${target.slice(5)}:00.000Z`)
              if (!Number.isFinite(startsAt.getTime()) || startsAt.toISOString().slice(0, 16) !== target.slice(5)) throw new Error('Invalid slot time')
            } else {
              const day = calendarRange(target, target, now, timeZone)
              startsAt = day.start
              wholeDayEnd = day.end
            }
            if (body.startsAt !== undefined || body.endsAt !== undefined) {
              if (!startsAt || typeof body.startsAt !== 'string' || typeof body.endsAt !== 'string'
                || (!wholeDayEnd && Date.parse(body.startsAt) !== startsAt.getTime())) throw new Error('Invalid restored block')
              const restoredStart = new Date(body.startsAt)
              restoredEnd = new Date(body.endsAt)
              const duration = restoredEnd.getTime() - restoredStart.getTime()
              if (!Number.isFinite(duration) || duration <= 0 || duration > (wholeDayEnd ? 2880 : 1440) * 60000 || duration % 60000 !== 0
                || restoredStart.getTime() % 60000 !== 0) throw new Error('Invalid restored block duration')
              if (restoredStart.toISOString() !== body.startsAt || restoredEnd.toISOString() !== body.endsAt) throw new Error('Use stored ISO block times')
              if (wholeDayEnd) {
                // Undo preserves the original authorized UTC interval. Its start must
                // remain within one UTC day of the date label, even after a zone change.
                const dateAnchor = parseCalendarDate(target, 'UTC').getTime()
                if (Math.abs(restoredStart.getTime() - dateAnchor) > 86400000) throw new Error('Restored block is outside its date')
                startsAt = restoredStart
              }
            }
          } catch { res.status(400).json({ error: 'target must be a valid slot id or YYYY-MM-DD date' }); return }
          const reason = String(body.reason ?? 'blocked').trim().slice(0, 120) || 'blocked'
          state = await store.mutate(s => {
            const existing = s.blocks.find(b => b.target === target)
            if (body.expectedBlock !== undefined && (!existing || !wholeDayEnd || !restoredEnd
              || body.expectedBlock?.startsAt !== existing.startsAt || body.expectedBlock?.endsAt !== existing.endsAt)) throw new Error('BLOCK_CONFLICT')
            if (existing) {
              if (body.expectedBlock !== undefined && startsAt && restoredEnd) return {
                ...s, blocks: s.blocks.map(b => b === existing ? { ...b, reason,
                  startsAt: startsAt!.toISOString(), endsAt: restoredEnd!.toISOString() } : b),
              }
              if (wholeDayEnd && !restoredEnd && startsAt && existing.startsAt && existing.endsAt) {
                // An explicit new whole-day request can extend a retained partial
                // interval after a timezone correction, without losing old coverage.
                const oldStart = Date.parse(existing.startsAt), oldEnd = Date.parse(existing.endsAt)
                if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd) || oldEnd <= oldStart) throw new Error('Stored block has invalid times')
                const expanded = { ...existing, startsAt: new Date(Math.min(oldStart, startsAt.getTime())).toISOString(),
                  endsAt: new Date(Math.max(oldEnd, wholeDayEnd.getTime())).toISOString() }
                if (Date.parse(expanded.endsAt) - Date.parse(expanded.startsAt) > 2880 * 60000) throw new Error('BLOCK_CONFLICT')
                return { ...s, blocks: s.blocks.map(b => b === existing ? expanded : b) }
              }
              return s
            }
            return { ...s, blocks: [...s.blocks, { target, reason, blockedAt: now.toISOString(), ...(startsAt ? { startsAt: startsAt.toISOString(), endsAt: (restoredEnd ?? wholeDayEnd ?? new Date(startsAt.getTime() + (effectiveOptions(s, { ...runtime?.tourSettings, timeZone }).slotMinutes ?? 30) * 60000)).toISOString() } : {}) }] }
          })
          break
        }
        case 'unblock':
          state = await store.mutate(s => ({ ...s, blocks: s.blocks.filter(b => b.target !== String(body.target ?? '').trim()) }))
          break
        case 'clear_blocks':
          state = await store.mutate(s => ({ ...s, blocks: [] }))
          break
        case 'clear_bookings':
          if (runtime || isHostedRuntime()) { res.status(403).json({ error: 'Bulk tour reset is only available in local testing' }); return }
          state = await store.mutate(s => ({ ...s, bookings: [] }))
          break
        default: res.status(400).json({ error: 'Unknown calendar action' }); return
      }
      res.status(200).json(view(state))
    } catch (error) {
      if (error instanceof CalendarActionError) { res.status(error.status).json({ error: error.message, code: error.code }); return }
      if (error instanceof Error && error.message === 'BLOCK_CONFLICT') { res.status(409).json({ error: 'The saved block changed or cannot be extended safely. Reload the calendar before changing it.' }); return }
      if (error instanceof Error && error.message === 'SETTINGS_CONFLICT') { res.status(409).json({ error: 'Showing settings changed in another session. Reload and try again.' }); return }
      if (runtime) { const failure = readRuntimeError(error); res.status(failure.status).json(failure.body); return }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  }
  return runtime ? runWithPropertyRuntime(runtime,run) : withTenant(tenantId!,run)
}
}

export default createCalendarHandler()

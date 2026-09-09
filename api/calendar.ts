import { authorizeOps } from '../src/ops/session.ts'
import { calendarStoreFromEnv } from '../src/calendar/store.ts'
import { generateSlots, statusOf, slotDate, blockFor, bookingsFor, bookingSlot, occupancyPeak } from '../src/calendar/slots.ts'
import { defaultSettings, effectiveOptions, validateSettings } from '../src/calendar/settings.ts'
import { addCalendarDays, calendarRange, parseCalendarDate } from '../src/calendar/range.ts'
import { withTenant } from '../src/tenancy/context.ts'
import { isHostedRuntime } from '../src/store/config.ts'
import { propertyTimeZone } from '../src/config/property.ts'

const store = calendarStoreFromEnv()
export const TOUR_CAPACITY = defaultSettings().capacity

function calendarView(now: Date, state: Awaited<ReturnType<typeof store.read>>, range: ReturnType<typeof calendarRange>, timeZone: string) {
  const opts = effectiveOptions(state, { timeZone })
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
  return {
    capacity: settings.capacity, settings, settingsRevision: state.settingsRevision ?? 0,
    timeZone, range: { from: range.from, to: range.to },
    slots: [...slots.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map(s => {
      const actualStatus = statusOf(s, state, settings.capacity, opts)
      const bookings = bookingsFor(s, state).map(b => ({ externalId: b.externalId, prospectName: b.prospectName, unitId: b.unitId, startsAt: bookingSlot(b)!.startsAt.toISOString(), endsAt: bookingSlot(b)!.endsAt.toISOString() }))
      const block = blockFor(s, state, opts)
      const unavailable = !allowed.has(s.slotId)
      const reason = s.startsAt < now ? 'Past tour time' : s.startsAt.getTime() < now.getTime() + settings.minimumNoticeMinutes * 60000 ? 'Inside minimum notice' : 'Outside booking window or current tour hours'
      return {
        slotId: s.slotId, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), date: slotDate(s.startsAt, timeZone),
        status: actualStatus === 'open' && unavailable ? 'unavailable' : actualStatus,
        ...(unavailable ? { reason } : {}), capacity: settings.capacity,
        booked: occupancyPeak(s, state, opts), bookings,
        ...(bookings[0] ? { booking: bookings[0] } : {}),
        ...(block ? { block: { target: block.target, reason: block.reason, wholeDay: blocks.find(b => b.target === block.target)?.wholeDayDates.includes(slotDate(s.startsAt, timeZone)) ?? false } } : {}),
      }
    }),
    blocks, bookings: state.bookings, store: store.describe(), generatedAt: now.toISOString(),
  }
}

/** Injection is server-owned configuration for tests and the future property resolver. */
export function createCalendarHandler(options: { property?: Record<string, unknown>; now?: () => Date } = {}) {
return async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  const auth = authorizeOps(req.headers ?? {}, new Date())
  if (!auth.ok) {
    res.status(auth.reason === 'not_configured' ? 503 : 401).json({ error: auth.reason === 'not_configured' ? 'The calendar requires a configured portal account.' : 'unauthorized' })
    return
  }
  return withTenant(auth.tenantId, async () => {
    const now = options.now?.() ?? new Date()
    let timeZone: string
    try { timeZone = propertyTimeZone(options.property) }
    catch { res.status(503).json({ error: 'The property timezone is invalid. Ask an administrator to correct its IANA timezone.', code: 'property_timezone_invalid' }); return }
    let body: any, range: ReturnType<typeof calendarRange>
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
      range = calendarRange(req.query?.from ?? body.from, req.query?.to ?? body.to, now, timeZone)
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' }); return }
    if (req.method === 'POST' && body.expectedTimeZone === undefined) {
      res.status(428).json({ error: 'The portal must provide its property timezone. Reload the portal before changing tours.' }); return
    }
    if (req.method === 'POST' && body.expectedTimeZone !== timeZone) {
      res.status(409).json({ error: 'The property timezone changed. Reload the portal before changing tours.' }); return
    }
    try {
      if (req.method === 'GET') { res.status(200).json(calendarView(now, await store.read(), range, timeZone)); return }
      if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return }
      let state
      switch (String(body.action ?? '')) {
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
            return { ...s, blocks: [...s.blocks, { target, reason, blockedAt: now.toISOString(), ...(startsAt ? { startsAt: startsAt.toISOString(), endsAt: (restoredEnd ?? wholeDayEnd ?? new Date(startsAt.getTime() + (effectiveOptions(s, { timeZone }).slotMinutes ?? 30) * 60000)).toISOString() } : {}) }] }
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
          if (isHostedRuntime()) { res.status(403).json({ error: 'Bulk tour reset is only available in local testing' }); return }
          state = await store.mutate(s => ({ ...s, bookings: [] }))
          break
        default: res.status(400).json({ error: 'Unknown calendar action' }); return
      }
      res.status(200).json(calendarView(now, state, range, timeZone))
    } catch (error) {
      if (error instanceof Error && error.message === 'BLOCK_CONFLICT') { res.status(409).json({ error: 'The saved block changed or cannot be extended safely. Reload the calendar before changing it.' }); return }
      if (error instanceof Error && error.message === 'SETTINGS_CONFLICT') { res.status(409).json({ error: 'Showing settings changed in another session. Reload and try again.' }); return }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
}

export default createCalendarHandler()

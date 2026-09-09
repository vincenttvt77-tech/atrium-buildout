import { authorizeOps } from '../src/ops/session.ts'
import { calendarStoreFromEnv } from '../src/calendar/store.ts'
import { generateSlots, statusOf, slotDate, blockFor, bookingsFor, bookingSlot, occupancyPeak } from '../src/calendar/slots.ts'
import { defaultSettings, effectiveOptions, validateSettings } from '../src/calendar/settings.ts'
import { calendarRange, parseCalendarDate } from '../src/calendar/range.ts'
import { withTenant } from '../src/tenancy/context.ts'
import { isHostedRuntime } from '../src/store/config.ts'

const store = calendarStoreFromEnv()
export const TOUR_CAPACITY = defaultSettings().capacity

function calendarView(now: Date, state: Awaited<ReturnType<typeof store.read>>, range: ReturnType<typeof calendarRange>) {
  const opts = effectiveOptions(state)
  const settings = validateSettings(opts)
  const generated = generateSlots(now, { ...opts, from: range.start, to: range.end, enforceBookingRules: false })
  const allowed = new Set(generateSlots(now, { ...opts, from: range.start, to: range.end }).map(s => s.slotId))
  // Saved tours always retain their actual times, even on days that are now closed.
  const slots = new Map(generated.map(s => [s.slotId, s]))
  for (const booking of state.bookings) {
    const saved = bookingSlot(booking)
    if (saved && saved.startsAt >= range.start && saved.startsAt < range.end && !slots.has(saved.slotId)) slots.set(saved.slotId, saved)
  }
  return {
    capacity: settings.capacity, settings, settingsRevision: state.settingsRevision ?? 0,
    timeZone: 'America/New_York', range: { from: range.from, to: range.to },
    slots: [...slots.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map(s => {
      const actualStatus = statusOf(s, state, settings.capacity, opts)
      const bookings = bookingsFor(s, state).map(b => ({ externalId: b.externalId, prospectName: b.prospectName, unitId: b.unitId, startsAt: bookingSlot(b)!.startsAt.toISOString(), endsAt: bookingSlot(b)!.endsAt.toISOString() }))
      const block = blockFor(s, state, opts)
      const unavailable = !allowed.has(s.slotId)
      const reason = s.startsAt < now ? 'Past tour time' : s.startsAt.getTime() < now.getTime() + settings.minimumNoticeMinutes * 60000 ? 'Inside minimum notice' : 'Outside booking window or current tour hours'
      return {
        slotId: s.slotId, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), date: slotDate(s.startsAt),
        status: actualStatus === 'open' && unavailable ? 'unavailable' : actualStatus,
        ...(unavailable ? { reason } : {}), capacity: settings.capacity,
        booked: occupancyPeak(s, state, opts), bookings,
        ...(bookings[0] ? { booking: bookings[0] } : {}),
        ...(block ? { block: { target: block.target, reason: block.reason, wholeDay: !block.target.startsWith('slot-') } } : {}),
      }
    }),
    blocks: state.blocks, bookings: state.bookings, store: store.describe(), generatedAt: now.toISOString(),
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
  const auth = authorizeOps(req.headers ?? {}, new Date())
  if (!auth.ok) {
    res.status(auth.reason === 'not_configured' ? 503 : 401).json({ error: auth.reason === 'not_configured' ? 'The calendar requires a configured portal account.' : 'unauthorized' })
    return
  }
  return withTenant(auth.tenantId, async () => {
    const now = new Date()
    let body: any, range: ReturnType<typeof calendarRange>
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
      range = calendarRange(req.query?.from ?? body.from, req.query?.to ?? body.to, now)
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' }); return }
    try {
      if (req.method === 'GET') { res.status(200).json(calendarView(now, await store.read(), range)); return }
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
          try {
            if (target.startsWith('slot-')) {
              if (!/^slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(target)) throw new Error('Invalid slot id')
              parseCalendarDate(target.slice(5, 15))
              startsAt = new Date(`${target.slice(5)}:00.000Z`)
              if (!Number.isFinite(startsAt.getTime()) || startsAt.toISOString().slice(0, 16) !== target.slice(5)) throw new Error('Invalid slot time')
            } else parseCalendarDate(target)
            if (body.startsAt !== undefined || body.endsAt !== undefined) {
              if (!startsAt || typeof body.startsAt !== 'string' || typeof body.endsAt !== 'string'
                || Date.parse(body.startsAt) !== startsAt.getTime()) throw new Error('Invalid restored block')
              restoredEnd = new Date(body.endsAt)
              const duration = restoredEnd.getTime() - startsAt.getTime()
              if (!Number.isFinite(duration) || duration <= 0 || duration > 1440 * 60000 || duration % 60000 !== 0) throw new Error('Invalid restored block duration')
            }
          } catch { res.status(400).json({ error: 'target must be a valid slot id or YYYY-MM-DD date' }); return }
          const reason = String(body.reason ?? 'blocked').trim().slice(0, 120) || 'blocked'
          state = await store.mutate(s => s.blocks.some(b => b.target === target) ? s : {
            ...s, blocks: [...s.blocks, { target, reason, blockedAt: now.toISOString(), ...(startsAt ? { startsAt: startsAt.toISOString(), endsAt: (restoredEnd ?? new Date(startsAt.getTime() + (effectiveOptions(s).slotMinutes ?? 30) * 60000)).toISOString() } : {}) }],
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
      res.status(200).json(calendarView(now, state, range))
    } catch (error) {
      if (error instanceof Error && error.message === 'SETTINGS_CONFLICT') { res.status(409).json({ error: 'Showing settings changed in another session. Reload and try again.' }); return }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}

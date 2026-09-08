import { authorizeOps } from '../src/ops/session.ts'
import { calendarStoreFromEnv } from '../src/calendar/store.ts'
import { generateSlots, statusOf, slotDate, blockFor } from '../src/calendar/slots.ts'

/**
 * The tour calendar, for the operations dashboard.
 *
 * GET returns every slot in the window with its status, so staff can see what the agent
 * will and will not offer. POST blocks and unblocks. Both sit behind the same passcode as
 * the dashboard: a calendar anyone can edit is a calendar anyone can empty.
 *
 * The store this reads is the store the phone line books against. That is the point —
 * block a Tuesday here, and a caller asking for Tuesday is told there is nothing.
 */

const store = calendarStoreFromEnv()

function slotsView(now: Date, state: Awaited<ReturnType<typeof store.read>>) {
  return generateSlots(now).map((s) => {
    const status = statusOf(s, state)
    const booking = status === 'booked' ? state.bookings.find((b) => b.slotId === s.slotId) : undefined
    const block = status === 'blocked' ? blockFor(s, state) : undefined
    return {
      slotId: s.slotId,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      date: slotDate(s.startsAt),
      status,
      ...(booking ? { booking: { prospectName: booking.prospectName, unitId: booking.unitId } } : {}),
      ...(block ? { block: { reason: block.reason, wholeDay: block.target !== s.slotId } } : {}),
    }
  })
}

export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')

  const auth = authorizeOps(req.headers ?? {}, new Date())
  if (!auth.ok) {
    res.status(auth.reason === 'not_configured' ? 503 : 401).json({
      error: auth.reason === 'not_configured'
        ? 'The calendar is closed until OPS_DASHBOARD_PASSCODE is set.'
        : 'unauthorized',
    })
    return
  }

  const now = new Date()

  try {
    if (req.method === 'GET') {
      const state = await store.read()
      res.status(200).json({
        slots: slotsView(now, state),
        blocks: state.blocks,
        bookings: state.bookings,
        store: store.describe(),
        generatedAt: now.toISOString(),
      })
      return
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
      const action = String(body.action ?? '')

      let state
      switch (action) {
        case 'block': {
          const target = String(body.target ?? '').trim()
          // A slot id carries minutes since 2:00 and 2:30 stopped sharing one; the hour-only
          // pattern here rejected every id the calendar itself hands out, so only whole days
          // could be blocked. Accept exactly what generateSlots() emits.
          if (!/^(slot-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\d{4}-\d{2}-\d{2})$/.test(target)) {
            res.status(400).json({ error: 'target must be a slot id or a YYYY-MM-DD date' })
            return
          }
          const reason = String(body.reason ?? 'blocked').slice(0, 120)
          state = await store.mutate((s) => s.blocks.some((b) => b.target === target)
            ? s
            : { ...s, blocks: [...s.blocks, { target, reason, blockedAt: now.toISOString() }] })
          break
        }
        case 'unblock': {
          const target = String(body.target ?? '').trim()
          state = await store.mutate((s) => ({ ...s, blocks: s.blocks.filter((b) => b.target !== target) }))
          break
        }
        case 'clear_blocks':
          state = await store.mutate((s) => ({ ...s, blocks: [] }))
          break
        case 'clear_bookings':
          // For resetting a demo between test calls. Real bookings would never be cleared
          // this way, which is why the dashboard labels it as a test control.
          state = await store.mutate((s) => ({ ...s, bookings: [] }))
          break
        default:
          res.status(400).json({ error: `unknown action "${action}"` })
          return
      }

      res.status(200).json({
        slots: slotsView(now, state),
        blocks: state.blocks,
        bookings: state.bookings,
        store: store.describe(),
      })
      return
    }

    res.status(405).json({ error: 'GET or POST only' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

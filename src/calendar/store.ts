import type { CalendarState, CalendarStore } from './types.ts'
import { emptyCalendar } from './types.ts'

/**
 * In-process. Survives nothing.
 *
 * Kept as the fallback so the calendar works with no configuration at all, but a block set
 * through one lambda is invisible to the next — which is exactly how the event log lost a
 * call. The dashboard says so rather than letting someone block a morning and wonder why
 * the agent still offers it.
 */
export class MemoryCalendarStore implements CalendarStore {
  private state: CalendarState = emptyCalendar()

  async read(): Promise<CalendarState> {
    return structuredClone(this.state)
  }

  async mutate(fn: (s: CalendarState) => CalendarState): Promise<CalendarState> {
    this.state = fn(structuredClone(this.state))
    return structuredClone(this.state)
  }

  describe() {
    return {
      kind: 'memory' as const,
      durable: false,
      note: 'In-process only. Blocks will not survive a cold start and may be invisible to other instances. Set KV_REST_API_URL and KV_REST_API_TOKEN for a calendar that persists.',
    }
  }
}

/**
 * Vercel KV / Upstash over its REST API — no SDK, so nothing to keep in step.
 *
 * mutate() re-reads inside the call rather than trusting a value fetched earlier, so two
 * people blocking slots in the same second do not silently drop one of the changes.
 */
export class KvCalendarStore implements CalendarStore {
  private readonly url: string
  private readonly token: string
  private readonly key: string
  private readonly fetchImpl: typeof fetch

  constructor(url: string, token: string, opts: { key?: string; fetchImpl?: typeof fetch } = {}) {
    this.url = url.replace(/\/$/, '')
    this.token = token
    this.key = opts.key ?? 'atrium:calendar'
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async command(parts: string[]): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}/${parts.map(encodeURIComponent).join('/')}`, {
      headers: { authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`KV ${res.status}`)
    const body = await res.json() as { result?: unknown }
    return body.result
  }

  async read(): Promise<CalendarState> {
    try {
      const raw = await this.command(['get', this.key])
      if (typeof raw !== 'string' || raw.length === 0) return emptyCalendar()
      const parsed = JSON.parse(raw) as Partial<CalendarState>
      return {
        blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
        bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [],
      }
    } catch {
      // A calendar that throws when the store is briefly unreachable would take the phone
      // line down with it. An empty calendar offers no times, which is honest and safe.
      return emptyCalendar()
    }
  }

  async mutate(fn: (s: CalendarState) => CalendarState): Promise<CalendarState> {
    const next = fn(await this.read())
    await this.command(['set', this.key, JSON.stringify(next)])
    return next
  }

  describe() {
    return { kind: 'kv' as const, durable: true, note: 'Persisted in KV.' }
  }
}

/*
 * One memory store per process, not per caller.
 *
 * api/calendar.ts and api/vapi.ts both ask for the store at module load. Handing each its
 * own MemoryCalendarStore put a block into one and had the phone line read the other, so
 * a blocked slot was still offered and then booked. KV does not have this problem — both
 * read the same key — but the fallback has to behave the same way or the local test of
 * the whole feature passes for the wrong reason.
 */
let sharedMemoryStore: MemoryCalendarStore | null = null

/** KV when it is configured, memory when it is not. Never throws on startup. */
export function calendarStoreFromEnv(env: NodeJS.ProcessEnv = process.env): CalendarStore {
  const url = env.KV_REST_API_URL
  const token = env.KV_REST_API_TOKEN
  if (url && token && url.trim() && token.trim()) return new KvCalendarStore(url, token)
  if (!sharedMemoryStore) sharedMemoryStore = new MemoryCalendarStore()
  return sharedMemoryStore
}

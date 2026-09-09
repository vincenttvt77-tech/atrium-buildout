import { KvClient } from '../store/kv.ts'
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
  private client: KvClient
  private key: string
  constructor(url: string, token: string, opts: { key?: string; fetchImpl?: typeof fetch } = {}) {
    this.client = new KvClient(url, token, opts.fetchImpl)
    this.key = opts.key ?? 'atrium:calendar'
  }
  private validate(state: CalendarState): CalendarState {
    if (!state || !Array.isArray(state.blocks) || !Array.isArray(state.bookings)) {
      throw new Error('Calendar data is invalid; availability cannot be verified')
    }
    return state
  }
  async read(): Promise<CalendarState> {
    // A missing key is new. An unreachable key is unknown, never an open calendar.
    return this.validate((await this.client.read<CalendarState>(this.key)) ?? emptyCalendar())
  }
  async mutate(fn: (s: CalendarState) => CalendarState): Promise<CalendarState> {
    return this.client.update(this.key, emptyCalendar(), (state) => this.validate(fn(this.validate(state))))
  }
  describe() { return this.client.describe() }
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

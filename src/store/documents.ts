/**
 * A JSON document store: KV when configured, one shared in-process map when not.
 *
 * Everything that used to live in a module-level variable — the event log, the tour
 * calendar, the per-call conversation state — has the same failure on serverless: each
 * request may land on a different instance, so state written by one is invisible to the
 * next. That is how the dashboard lost a call, how a blocked slot got booked, and very
 * possibly how a caller who said "studio" was told there were none: the instance that took
 * check_availability had never seen the instance that took capture_signal.
 *
 * One store, one pattern, one fallback that says out loud when it will not persist.
 */

export interface DocumentStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  /** Read-modify-write. Two writers in the same second do not drop each other's change. */
  update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T>
  /** Keys under a prefix, for listing profiles and follow-ups. */
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
  describe(): { kind: 'memory' | 'kv'; durable: boolean; note: string }
}

export class MemoryDocumentStore implements DocumentStore {
  private docs = new Map<string, string>()

  async get<T>(key: string): Promise<T | null> {
    const raw = this.docs.get(key)
    return raw === undefined ? null : JSON.parse(raw) as T
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.docs.set(key, JSON.stringify(value))
  }

  async update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T> {
    const next = fn((await this.get<T>(key)) ?? initial)
    await this.set(key, next)
    return next
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.docs.keys()].filter((k) => k.startsWith(prefix)).sort()
  }

  async delete(key: string): Promise<void> {
    this.docs.delete(key)
  }

  describe() {
    return {
      kind: 'memory' as const,
      durable: false,
      note: 'In-process only. State will not survive a cold start and may be invisible to other instances. Set KV_REST_API_URL and KV_REST_API_TOKEN to persist it.',
    }
  }
}

/** Vercel KV / Upstash over REST. No SDK to keep in step. */
export class KvDocumentStore implements DocumentStore {
  private readonly url: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly namespace: string

  constructor(url: string, token: string, opts: { namespace?: string; fetchImpl?: typeof fetch } = {}) {
    this.url = url.replace(/\/$/, '')
    this.token = token
    this.namespace = opts.namespace ?? 'atrium'
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private k(key: string) { return `${this.namespace}:${key}` }

  private async command(parts: string[]): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}/${parts.map(encodeURIComponent).join('/')}`, {
      headers: { authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) { this.lastError = `HTTP ${res.status}`; throw new Error(`KV ${res.status}`) }
    this.lastError = null
    return ((await res.json()) as { result?: unknown }).result
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.command(['get', this.k(key)])
      return typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) as T : null
    } catch (err) {
      // Treat an unreachable store as empty rather than throwing: the phone line must not
      // go down because the profile store had a bad second. But remember it, so the
      // dashboard stops claiming state is persisting.
      this.lastError = this.lastError ?? (err instanceof Error ? err.message : String(err))
      return null
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.command(['set', this.k(key), JSON.stringify(value)])
  }

  async update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T> {
    const next = fn((await this.get<T>(key)) ?? initial)
    await this.set(key, next)
    return next
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const keys = await this.command(['keys', `${this.k(prefix)}*`])
      const strip = `${this.namespace}:`
      return (Array.isArray(keys) ? keys : [])
        .map((k) => String(k))
        .filter((k) => k.startsWith(strip))
        .map((k) => k.slice(strip.length))
        .sort()
    } catch {
      return []
    }
  }

  async delete(key: string): Promise<void> {
    await this.command(['del', this.k(key)])
  }

  /** Set when a read or write last failed, so describe() cannot claim durability it is
   *  not delivering. */
  private lastError: string | null = null

  describe() {
    return this.lastError
      ? { kind: 'kv' as const, durable: false, note: `KV configured but unreachable: ${this.lastError}. State is not persisting until this clears.` }
      : { kind: 'kv' as const, durable: true, note: 'Persisted in KV.' }
  }
}

let sharedMemory: MemoryDocumentStore | null = null

/** One memory store per process, so two modules asking for it read the same state. */
export function documentStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DocumentStore {
  const url = env.KV_REST_API_URL
  const token = env.KV_REST_API_TOKEN
  if (url && token && url.trim() && token.trim()) return new KvDocumentStore(url, token)
  if (!sharedMemory) sharedMemory = new MemoryDocumentStore()
  return sharedMemory
}

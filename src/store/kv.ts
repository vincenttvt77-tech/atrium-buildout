/** Redis REST commands with atomic compare-and-set for shared JSON documents. */
export class KvClient {
  private url: string
  private token: string
  private fetchImpl: typeof fetch
  private failed = false

  constructor(url: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.url = url.trim().replace(/\/$/, '')
    this.token = token.trim()
    this.fetchImpl = fetchImpl
  }

  async command(parts: string[]): Promise<unknown> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(parts),
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`KV HTTP ${response.status}`)
      const body = await response.json() as { result?: unknown; error?: unknown }
      if (body.error || !Object.hasOwn(body, 'result')) throw new Error('KV command failed')
      this.failed = false
      return body.result
    } catch (err) {
      this.failed = true
      throw err
    }
  }

  async read<T>(key: string): Promise<T | null> {
    const raw = await this.command(['GET', key])
    if (raw === null) return null
    try {
      if (typeof raw !== 'string') throw new Error('KV returned invalid data')
      return JSON.parse(raw) as T
    } catch (err) { this.failed = true; throw err }
  }

  /** Retry only a known conflict. Never overwrite a failed read or retry an uncertain write. */
  async update<T>(key: string, initial: T, fn: (value: T) => T): Promise<T> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const raw = await this.command(['GET', key])
      let current: T
      try {
        if (raw !== null && typeof raw !== 'string') throw new Error('KV returned invalid data')
        current = raw === null ? structuredClone(initial) : JSON.parse(raw as string) as T
      } catch (err) { this.failed = true; throw err }
      const next = fn(current)
      const result = await this.command(['EVAL',
        "local v = redis.call('GET', KEYS[1]); if (ARGV[1] == 'missing' and v == false) or (ARGV[1] == 'present' and v == ARGV[2]) then redis.call('SET', KEYS[1], ARGV[3]); return 1 end; return 0",
        '1', key, raw === null ? 'missing' : 'present', raw as string ?? '', JSON.stringify(next)])
      if (result === 1) return next
      if (result !== 0) { this.failed = true; throw new Error('KV returned invalid write result') }
    }
    throw new Error('KV update contention; please retry')
  }

  describe() {
    return { kind: 'kv' as const, durable: !this.failed, note: this.failed
      ? 'KV is not responding. Changes cannot be saved until the connection recovers.'
      : 'Persisted in KV.' }
  }
}

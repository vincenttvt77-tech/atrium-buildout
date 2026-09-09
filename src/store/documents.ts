import { KvClient } from './kv.ts'
import { storageConfig } from './config.ts'
import { currentTenantId, tenantNamespace } from '../tenancy/context.ts'
import { isPostgresRuntime } from '../database/mode.ts'
import { requirePropertyRuntime } from '../database/request.ts'

/**
 * A JSON document store: KV in hosted runtimes, tenant-scoped memory for local previews.
 *
 * Everything that used to live in a module-level variable — the event log, the tour
 * calendar, the per-call conversation state — has the same failure on serverless: each
 * request may land on a different instance, so state written by one is invisible to the
 * next. That is how the dashboard lost a call, how a blocked slot got booked, and very
 * possibly how a caller who said "studio" was told there were none: the instance that took
 * check_availability had never seen the instance that took capture_signal.
 *
 * Hosted runtimes fail closed until durable storage is configured.
 */

export interface DocumentStore {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  /** Read-modify-write. Two writers in the same second do not drop each other's change. */
  update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T>
  /** Keys under a prefix, for listing profiles and follow-ups. */
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
  describe(): { kind: 'memory' | 'kv' | 'postgres'; durable: boolean; note: string }
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
    const raw = this.docs.get(key)
    const next = fn(raw === undefined ? structuredClone(initial) : JSON.parse(raw) as T)
    this.docs.set(key, JSON.stringify(next))
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
  private client: KvClient
  private namespace: string
  constructor(url: string, token: string, opts: { namespace?: string; fetchImpl?: typeof fetch } = {}) {
    this.client = new KvClient(url, token, opts.fetchImpl)
    this.namespace = opts.namespace ?? 'atrium'
  }
  private k(key: string) {
    if (this.namespace === 'atrium' && key.startsWith('tenant:')) throw new Error('Reserved tenant namespace')
    return `${this.namespace}:${key}`
  }
  async get<T>(key: string): Promise<T | null> { return this.client.read<T>(this.k(key)) }
  async set<T>(key: string, value: T): Promise<void> {
    await this.client.command(['SET', this.k(key), JSON.stringify(value)])
  }
  async update<T>(key: string, initial: T, fn: (current: T) => T): Promise<T> {
    return this.client.update(this.k(key), initial, fn)
  }
  async list(prefix: string): Promise<string[]> {
    const keys = new Set<string>()
    let cursor = '0'
    do {
      const result = await this.client.command(['SCAN', cursor, 'MATCH', `${this.k(prefix)}*`, 'COUNT', '100'])
      if (!Array.isArray(result) || !Array.isArray(result[1])) throw new Error('KV returned invalid key list')
      cursor = String(result[0])
      for (const key of result[1]) {
        if (typeof key !== 'string' || !key.startsWith(this.k(prefix))) continue
        const logicalKey = key.slice(this.namespace.length + 1)
        if (this.namespace === 'atrium' && logicalKey.startsWith('tenant:')) continue
        keys.add(logicalKey)
      }
    } while (cursor !== '0')
    return [...keys].sort()
  }
  async delete(key: string): Promise<void> { await this.client.command(['DEL', this.k(key)]) }
  describe() { return this.client.describe() }
}

const tenantMemory = new Map<string, MemoryDocumentStore>()

/** Resolve scope on each operation, so a module-level adapter cannot capture another tenant. */
export function documentStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DocumentStore {
  const kvStores = new Map<string, KvDocumentStore>()
  const resolve = (): DocumentStore => {
    if (isPostgresRuntime(env)) return requirePropertyRuntime().documents
    const tenantId = currentTenantId()
    const namespace = tenantNamespace(tenantId)
    const config = storageConfig(env)
    if (config.kind === 'kv') {
      const { url, token } = config
      const cacheKey = JSON.stringify([url, token, namespace])
      if (!kvStores.has(cacheKey)) kvStores.set(cacheKey, new KvDocumentStore(url, token, { namespace }))
      return kvStores.get(cacheKey)!
    }
    if (!tenantMemory.has(tenantId)) tenantMemory.set(tenantId, new MemoryDocumentStore())
    return tenantMemory.get(tenantId)!
  }
  return {
    get: <T>(key: string) => resolve().get<T>(key),
    set: <T>(key: string, value: T) => resolve().set(key, value),
    update: <T>(key: string, initial: T, fn: (current: T) => T) => resolve().update(key, initial, fn),
    list: (prefix) => resolve().list(prefix),
    delete: (key) => resolve().delete(key),
    describe: () => resolve().describe(),
  }
}

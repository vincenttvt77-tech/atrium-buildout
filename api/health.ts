import { documentStoreFromEnv } from '../src/store/documents.ts'
import { StorageConfigurationError } from '../src/store/config.ts'
import { LEGACY_TENANT, withTenant } from '../src/tenancy/context.ts'

/**
 * Unauthenticated on purpose, and therefore says almost nothing.
 *
 * It exists to answer one question without opening the dashboard: is state persisting?
 * After connecting a database in Vercel the only visible difference is a variable name in
 * a settings page, and picking Postgres or Edge Config instead of Redis produces a
 * deployment that looks identical and silently forgets everything. This reports which
 * store the code actually found. It never reports a URL, a token, a count, or a caller.
 */
export default async function handler(_req: any, res: any) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  const documents = documentStoreFromEnv()
  const callHistory = Boolean(process.env.VAPI_PRIVATE_KEY || process.env.VAPI_API_KEY)
  // An explicit infrastructure probe, independent of any authenticated tenant.
  return withTenant(LEGACY_TENANT, async () => {
    try {
      await documents.get('health:probe')
      const store = documents.describe()
      res.status(200).json({
        ok: true, store: store.kind, durable: store.durable, callHistory,
        hint: store.durable ? 'Storage is connected. Shared records use KV.'
          : 'Local memory only. Records reset when the preview restarts. Deployed environments require KV_REST_API_URL and KV_REST_API_TOKEN.',
      })
    } catch (error) {
      const unconfigured = error instanceof StorageConfigurationError
      res.status(503).json({
        ok: false, store: unconfigured ? 'unconfigured' : 'kv', durable: false, callHistory,
        code: unconfigured ? error.code : 'storage_unavailable',
        hint: unconfigured ? error.message : 'Storage is not responding. Check the Redis/KV connection and credentials. Availability and saved records cannot be verified.',
      })
    }
  })
}

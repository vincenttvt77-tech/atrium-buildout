import { documentStoreFromEnv } from '../src/store/documents.ts'

/**
 * Unauthenticated on purpose, and therefore says almost nothing.
 *
 * It exists to answer one question without opening the dashboard: is state persisting?
 * After connecting a database in Vercel the only visible difference is a variable name in
 * a settings page, and picking Postgres or Edge Config instead of Redis produces a
 * deployment that looks identical and silently forgets everything. This reports which
 * store the code actually found. It never reports a URL, a token, a count, or a caller.
 */
export default function handler(_req: any, res: any) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  const store = documentStoreFromEnv().describe()
  res.status(200).json({
    ok: true,
    store: store.kind,
    durable: store.durable,
    callHistory: Boolean(process.env.VAPI_PRIVATE_KEY || process.env.VAPI_API_KEY),
    hint: store.durable
      ? 'State persists across instances and cold starts.'
      : 'Memory only. Connect a Redis/KV database in Vercel → Storage; it must inject KV_REST_API_URL and KV_REST_API_TOKEN. Postgres and Edge Config will not.',
  })
}

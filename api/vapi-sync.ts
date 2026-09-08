import rawProperty from '../data/property.json' with { type: 'json' }
import { authorizeOps } from '../src/ops/session.ts'
import { demoAssistantConfig } from '../src/vapi/config.ts'
import { syncAssistant } from '../src/vapi/sync.ts'

/**
 * "Update the phone assistant" — pushes the repository's script and tools to Vapi.
 *
 * Behind the dashboard passcode, because it rewrites what the phone line says. It uses
 * the deployment's own Vapi key and its own host for the server address, so the assistant
 * it writes points back at the deployment that wrote it.
 */
export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }

  const auth = authorizeOps(req.headers ?? {}, new Date())
  if (!auth.ok) {
    res.status(auth.reason === 'not_configured' ? 503 : 401).json({ error: auth.reason === 'not_configured' ? 'OPS_DASHBOARD_PASSCODE is not set' : 'sign in first' })
    return
  }

  const apiKey = process.env.VAPI_PRIVATE_KEY ?? process.env.VAPI_API_KEY
  if (!apiKey?.trim()) {
    res.status(503).json({ ok: false, error: 'VAPI_API_KEY (the private key) is not set in Vercel, so the assistant cannot be updated from here.' })
    return
  }

  const headers = req.headers ?? {}
  const host = String(headers['x-forwarded-host'] ?? headers.host ?? 'ghost-building.vercel.app').split(',')[0]!.trim()
  const proto = String(headers['x-forwarded-proto'] ?? 'https').split(',')[0]!.trim()
  const config = demoAssistantConfig(rawProperty as Record<string, unknown>, `${proto}://${host}`, new Date())

  try {
    const result = await syncAssistant({ apiKey, assistantId: process.env.VAPI_ASSISTANT_ID, config })
    console.log('[vapi-sync]', JSON.stringify({ ok: result.ok, assistant: result.assistant?.id ?? null, error: result.error ?? null }))
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[vapi-sync] failed', message)
    res.status(502).json({ ok: false, error: `Could not reach Vapi: ${message}` })
  }
}

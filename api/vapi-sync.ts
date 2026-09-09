import rawProperty from '../data/property.json' with { type: 'json' }
import { authorizeOps } from '../src/ops/session.ts'
import { demoAssistantConfig } from '../src/vapi/config.ts'
import { syncAssistant } from '../src/vapi/sync.ts'
import { isPostgresRuntime, resolveOpsRuntime, readRuntimeError } from '../src/application/runtime.ts'
import { verifyVoiceBackend } from '../src/vapi/contract.ts'

/**
 * "Update the phone assistant" — pushes the repository's script and tools to Vapi.
 *
 * Authorized by workspace, because it rewrites what the phone line says. The webhook
 * destination is explicit deployment configuration; browser Host headers are not trusted.
 */
export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }

  let databaseMode: boolean
  try { databaseMode = isPostgresRuntime() }
  catch (error) {
    const result = readRuntimeError(error)
    res.status(result.status).json(result.body)
    return
  }
  if (databaseMode) {
    try {
      const runtime = await resolveOpsRuntime(req, 'configure', new Date())
      if (runtime.assistantIds.length !== 1) {
        res.status(409).json({ ok: false, error: runtime.assistantIds.length
          ? 'This property has multiple connected assistants. Select a property assistant through the configuration workflow.'
          : 'This property has no active voice assistant connected.', scope: runtime.responseScope })
        return
      }
      // The existing publisher builds a bundled Larkin assistant. It cannot publish a
      // customer property until a versioned configuration/action rollout is available.
      res.status(409).json({ ok: false, code: 'property_assistant_publish_unavailable',
        error: 'Property assistant publishing requires a coordinated configuration and webhook rollout. No changes were sent to Vapi.',
        scope: runtime.responseScope })
    } catch (error) {
      const result = readRuntimeError(error)
      res.status(result.status).json(result.body)
    }
    return
  }

  const auth = authorizeOps(req.headers ?? {}, new Date())
  if (!auth.ok) {
    res.status(auth.reason === 'not_configured' ? 503 : 401).json({ error: auth.reason === 'not_configured' ? 'Portal authentication is not configured.' : 'sign in first' })
    return
  }

  if (process.env.VERCEL_ENV === 'preview') {
    res.status(409).json({ ok: false, error: 'Assistant updates are disabled on preview deployments. Update from the production portal to keep the phone line on its production webhook.' })
    return
  }
  const named = auth.tenantId !== 'legacy'
  if (named && process.env.VAPI_SYNC_TENANT_ID !== auth.tenantId) {
    res.status(403).json({ ok: false, error: 'This workspace is not configured to publish the bundled property assistant. Set VAPI_SYNC_TENANT_ID only for the workspace that owns this property configuration.' })
    return
  }
  if (named && auth.assistantIds.length !== 1) {
    res.status(409).json({ ok: false, error: auth.assistantIds.length === 0
      ? 'This workspace has no phone assistant connected yet.'
      : 'This workspace has multiple phone assistants. Configure a single assistant before updating it from the portal.' })
    return
  }
  const origin = configuredServerOrigin()
  if (!origin) {
    res.status(503).json({ ok: false, error: 'Set VAPI_SERVER_BASE_URL to the HTTPS origin of the production webhook before updating the assistant.' })
    return
  }

  const apiKey = process.env.VAPI_PRIVATE_KEY ?? process.env.VAPI_API_KEY
  if (!apiKey?.trim()) {
    res.status(503).json({ ok: false, error: 'VAPI_API_KEY (the private key) is not set in Vercel, so the assistant cannot be updated from here.' })
    return
  }

  const credentialId = process.env.VAPI_WEBHOOK_CREDENTIAL_ID?.trim()
  if (!process.env.VAPI_WEBHOOK_SECRET?.trim() || !credentialId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(credentialId)) {
    res.status(503).json({ ok: false, code: 'voice_authentication_not_configured',
      error: 'Configure the webhook secret and its matching Vapi credential before publishing the phone assistant. No changes were sent to Vapi.' })
    return
  }
  if (!await verifyVoiceBackend(origin)) {
    res.status(409).json({ ok: false, code: 'voice_backend_contract_mismatch',
      error: 'The deployed backend is unavailable or does not match these voice tools. Deploy and verify the matching backend before publishing the assistant. No changes were sent to Vapi.' })
    return
  }
  const base = demoAssistantConfig(rawProperty as Record<string, unknown>, origin, new Date())
  const config = { ...base, server: { ...base.server, credentialId } }

  try {
    const result = await syncAssistant({ apiKey, assistantId: named ? auth.assistantIds[0] : process.env.VAPI_ASSISTANT_ID, config })
    console.log('[vapi-sync]', JSON.stringify({ ok: result.ok, assistant: result.assistant?.id ?? null, error: result.error ?? null }))
    res.status(result.ok ? 200 : 502).json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[vapi-sync] failed', message)
    res.status(502).json({ ok: false, error: `Could not reach Vapi: ${message}` })
  }
}

function configuredServerOrigin(): string | null {
  const raw = process.env.VAPI_SERVER_BASE_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const production = Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    if (localhost && production) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost && !production)) return null
    return url.origin
  } catch { return null }
}

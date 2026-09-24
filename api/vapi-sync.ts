import rawProperty from '../data/property.json' with { type: 'json' }
import { authorizeOps } from '../src/ops/session.ts'
import { demoAssistantConfig, managedAssistantConfig } from '../src/vapi/config.ts'
import { syncAssistant } from '../src/vapi/sync.ts'
import { isPostgresRuntime, resolveOpsRuntime, readRuntimeError, runtimeForRequest } from '../src/application/runtime.ts'
import { verifyVoiceBackend } from '../src/vapi/contract.ts'
import { randomUUID } from 'node:crypto'
import { isSameOriginJsonRequest } from '../src/auth/account-request.ts'
import { voiceReleaseStore } from '../src/database/voice-releases.ts'
import { createManagedVoiceRelease, VoiceReleaseError } from '../src/vapi/managed-release.ts'
import { vapiReleaseProvider } from '../src/vapi/release-provider.ts'

/**
 * "Update the phone assistant" — pushes the repository's script and tools to Vapi.
 *
 * Authorized by workspace, because it rewrites what the phone line says. The webhook
 * destination is explicit deployment configuration; browser Host headers are not trusted.
 */
export default async function handler(req: any, res: any) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-robots-tag', 'noindex, nofollow')
  if (!['GET', 'POST'].includes(req.method)) { res.status(405).json({ error: 'GET or POST only' }); return }

  let databaseMode: boolean
  try { databaseMode = isPostgresRuntime() }
  catch (error) {
    const result = readRuntimeError(error)
    res.status(result.status).json(result.body)
    return
  }
  if (databaseMode) {
    req.atriumRequestId = randomUUID()
    res.setHeader('x-request-id', req.atriumRequestId)
    try {
      const runtime = await resolveOpsRuntime(req, 'configure', new Date())
      if (runtime.assistantIds.length !== 1) {
        res.status(409).json({ ok: false, error: runtime.assistantIds.length
          ? 'This property has multiple connected assistants. Select a property assistant through the configuration workflow.'
          : 'This property has no active voice assistant connected.', scope: runtime.responseScope })
        return
      }
      if (process.env.VERCEL_ENV === 'preview') throw new VoiceReleaseError(409, 'voice_preview_disabled',
        'Live assistant updates are disabled on preview deployments.')
      let body = req.body
      if (req.method === 'POST') {
        if (!isSameOriginJsonRequest(req.headers ?? {}) || Object.keys(req.query ?? {}).length) {
          throw new VoiceReleaseError(403, 'staff_request_invalid', 'Reload the property workspace before recording a voice release.')
        }
        if (typeof body === 'string' && Buffer.byteLength(body) <= 2048) { try { body = JSON.parse(body) } catch { body = null } }
        const fields = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join(',') : ''
        if (!body || !['prepare', 'publish', 'verify', 'cancel'].includes(body.action)
          || fields !== (body.action === 'prepare' ? 'action,requestId' : body.action === 'verify' ? 'action,id' : 'action,id,reviewHash')
          || typeof (body.action === 'prepare' ? body.requestId : body.id) !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(body.action === 'prepare' ? body.requestId : body.id)
          || (['publish', 'cancel'].includes(body.action) && (typeof body.reviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.reviewHash)))) {
          throw new VoiceReleaseError(400, 'voice_release_command', 'Choose a reviewed assistant release and its exact action.')
        }
      } else if (Object.keys(req.query ?? {}).some(k => k !== 'id')
        || (req.query?.id !== undefined && (typeof req.query.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(req.query.id)))) {
        throw new VoiceReleaseError(400, 'voice_release_command', 'Choose a saved assistant release.')
      }
      const origin = configuredServerOrigin(), apiKey = process.env.VAPI_PRIVATE_KEY ?? process.env.VAPI_API_KEY
      const credentialId = process.env.VAPI_WEBHOOK_CREDENTIAL_ID?.trim(), providerOrganizationId = process.env.VAPI_ORGANIZATION_ID?.trim()
      if (!origin || !apiKey?.trim() || !process.env.VAPI_WEBHOOK_SECRET?.trim() || !credentialId
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(credentialId) || !providerOrganizationId
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(providerOrganizationId)) {
        throw new VoiceReleaseError(503, 'voice_release_configuration', 'The production voice destination, provider account and saved webhook credential need administrator configuration.')
      }
      let generated
      try { generated = managedAssistantConfig(runtime.snapshot, runtime.scope, origin) }
      catch { throw new VoiceReleaseError(409, 'voice_property_configuration', 'Review the published property name, address and timezone before preparing its assistant.') }
      const service = createManagedVoiceRelease({
        store: voiceReleaseStore(runtimeForRequest(req).app, runtime),
        context: { organizationId: runtime.scope.organizationId, propertyId: runtime.scope.propertyId,
          configurationVersion: runtime.snapshot.version, bindingFingerprint: runtime.bindingFingerprint,
          assistantId: runtime.assistantIds[0]!, providerOrganizationId },
        config: { ...generated, server: { ...generated.server, credentialId } },
        actorId: runtime.scope.actor.kind === 'user' ? runtime.scope.actor.userId : '',
        provider: vapiReleaseProvider(apiKey), authorize: () => runtime.revalidate(),
        backendReady: () => verifyVoiceBackend(origin),
      })
      const result = req.method === 'GET' ? req.query?.id ? await service.read(req.query.id) : await service.list()
        : body.action === 'prepare' ? await service.prepare(body.requestId)
          : body.action === 'publish' ? await service.publish(body.id, body.reviewHash)
            : body.action === 'cancel' ? await service.cancel(body.id, body.reviewHash) : await service.verify(body.id)
      await runtime.revalidate()
      res.status(200).json({ ...result, scope: runtime.responseScope })
    } catch (error) {
      if (error instanceof VoiceReleaseError) { res.status(error.status).json({ error: error.message, code: error.code }); return }
      const result = readRuntimeError(error)
      res.status(result.status).json(result.body)
    }
    return
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }

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

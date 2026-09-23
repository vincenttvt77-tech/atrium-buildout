import { randomUUID } from 'node:crypto'
import { authorizeOps } from '../src/ops/session.ts'
import { getRecording, RecordingError, recordingCallId } from '../src/ops/vapi-recording.ts'
import { isPostgresRuntime, resolveOpsRuntime, readRuntimeError } from '../src/application/runtime.ts'

/** Read-only access to a fresh, short-lived audio capability; never proxy arbitrary URLs. */
export default async function handler(req: any, res: any) {
  req.atriumRequestId = randomUUID()
  for (const [name, value] of Object.entries({ 'x-request-id': req.atriumRequestId,
    'cache-control': 'no-store, no-cache, must-revalidate, private', 'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })) res.setHeader(name, value)
  try {
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); res.status(405).json({ error: 'GET only' }); return }
    const managed = isPostgresRuntime(), property = managed ? await resolveOpsRuntime(req, 'read') : undefined
    const auth = managed ? undefined : authorizeOps(req.headers ?? {}, new Date())
    if (auth && !auth.ok) { res.status(auth.reason === 'not_configured' ? 503 : 401).json({ error: auth.reason === 'not_configured' ? 'Workspace sign-in is unavailable.' : 'unauthorized' }); return }
    if (auth?.ok && req.headers?.['x-atrium-tenant-id'] !== auth.tenantId) {
      res.status(409).json({ code: 'portal_tenant_changed', error: 'Reload this workspace before opening a recording.' }); return
    }
    const query = req.query ?? {}
    if (Object.keys(query).sort().join(',') !== 'callId' || !recordingCallId(query.callId)) {
      res.status(400).json({ code: 'invalid_call', error: 'Choose a saved call.' }); return
    }
    const assistantIds = property ? property.assistantIds : auth?.ok && auth.tenantId !== 'legacy' ? auth.assistantIds : undefined
    const revalidate = async () => {
      if (property) { await property.revalidate(); return }
      const current = authorizeOps(req.headers ?? {}, new Date())
      if (!current.ok) throw new RecordingError(401, 'session_ended', 'Sign in again to open this recording.')
      if (!auth?.ok || current.tenantId !== auth.tenantId || current.username !== auth.username
          || JSON.stringify(current.assistantIds) !== JSON.stringify(auth.assistantIds)) {
        throw new RecordingError(409, 'portal_tenant_changed', 'The workspace changed. Reload before continuing.')
      }
    }
    const result = await getRecording({ callId: query.callId,
      apiKey: process.env.VAPI_PRIVATE_KEY ?? process.env.VAPI_API_KEY ?? '', assistantIds, revalidate })
    res.status(200).json({ ...result, ...(property ? { scope: property.responseScope } : {}) })
  } catch (error) {
    if (error instanceof RecordingError) { res.status(error.status).json({ code: error.code, error: error.message }); return }
    const failure = readRuntimeError(error); res.status(failure.status).json(failure.body)
  }
}

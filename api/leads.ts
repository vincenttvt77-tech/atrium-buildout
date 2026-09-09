import { authorizeOps } from '../src/ops/session.ts'
import { documentStoreFromEnv } from '../src/store/documents.ts'
import { isHostedRuntime } from '../src/store/config.ts'
import { listProfiles, listFollowUps, profileKey, followUpKey } from '../src/leads/consolidate.ts'
import type { LeadProfile } from '../src/leads/profile.ts'
import type { FollowUp } from '../src/leads/followups.ts'
import { normalisePhone, pinnedName } from '../src/leads/profile.ts'
import { withTenant } from '../src/tenancy/context.ts'
import { isPostgresRuntime, resolveOpsRuntime, runWithPropertyRuntime, readRuntimeError } from '../src/application/runtime.ts'
import type { ResolvedPropertyRuntime } from '../src/application/runtime.ts'
import { randomUUID } from 'node:crypto'

/**
 * Lead profiles and the follow-up queue, for the operations dashboard.
 *
 * GET returns every profile and every follow-up. POST marks a follow-up done or skipped,
 * or adds a note to a profile. Behind the same passcode as everything else here — this is
 * every caller's name, number, email and stated budget.
 */

const store = documentStoreFromEnv()

export default async function handler(req: any, res: any) {
  req.atriumRequestId = randomUUID()
  res.setHeader('x-request-id', req.atriumRequestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')

  let runtime: ResolvedPropertyRuntime | undefined
  let tenantId: string | undefined
  try {
    if (isPostgresRuntime()) {
      runtime = await resolveOpsRuntime(req, req.method === 'GET' ? 'read' : 'operate')
      const json = res.json.bind(res)
      res.json = (body: Record<string, unknown>) => json({...body,scope:runtime!.responseScope})
    } else {
      const auth = authorizeOps(req.headers ?? {}, new Date())
      if (!auth.ok) {
        res.status(auth.reason === 'not_configured' ? 503 : 401).json({error:auth.reason === 'not_configured' ? 'Leads require a configured portal account.' : 'unauthorized'})
        return
      }
      tenantId = auth.tenantId
    }
  } catch(error) { const failure = readRuntimeError(error); res.status(failure.status).json(failure.body); return }
  const run = async () => {
  const now = new Date()

  try {
    if (req.method === 'GET') {
      const [profiles, followUps] = await Promise.all([listProfiles(store), listFollowUps(store)])
      res.status(200).json({
        profiles,
        followUps,
        // Outbound is not enabled. The dashboard shows follow-ups as scheduled intentions,
        // and says so, rather than implying a call went out.
        outboundEnabled: false,
        store: store.describe(),
        generatedAt: now.toISOString(),
      })
      return
    }

    if (req.method === 'POST') {
      let body: any
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {}) }
      catch { res.status(400).json({error:'Invalid JSON request.'}); return }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {res.status(400).json({error:'A JSON object is required.'}); return}
      const action = String(body.action ?? '')

      if (action === 'followup_status') {
        const id = String(body.id ?? '')
        const status = String(body.status ?? '')
        if (!/^fu-/.test(id) || !['scheduled', 'done', 'skipped'].includes(status)) {
          res.status(400).json({ error: 'id must be a follow-up id and status one of scheduled|done|skipped' })
          return
        }
        const existing = await store.get<FollowUp>(followUpKey(id))
        if (!existing) { res.status(404).json({ error: 'no such follow-up' }); return }
        const updated = await store.update<FollowUp>(followUpKey(id), existing, (f) => ({ ...f, status: status as FollowUp['status'] }))
        res.status(200).json({ followUp: updated })
        return
      }

      if (action === 'note') {
        const phone = normalisePhone(String(body.phone ?? ''))
        const text = String(body.text ?? '').trim().slice(0, 500)
        if (phone === 'unknown' || !text) { res.status(400).json({ error: 'phone and text are required' }); return }
        const existing = await store.get<LeadProfile>(profileKey(phone))
        if (!existing) { res.status(404).json({ error: 'no such lead' }); return }
        const updated = await store.update<LeadProfile>(profileKey(phone), existing, (p) => {
          const notes = [...p.notes, `${now.toISOString()} ${text}`]
          const pinned = pinnedName(notes)
          return { ...p, notes, ...(pinned ? { name: pinned } : {}) }
        })
        res.status(200).json({ profile: updated })
        return
      }

      if (action === 'clear_leads') {
        // Test control for resetting the demo. Labelled as such on the dashboard.
        if (runtime || isHostedRuntime()) {
          res.status(403).json({ error: 'Bulk lead reset is only available in local testing' })
          return
        }
        for (const k of [...await store.list('lead:'), ...await store.list('followup:')]) await store.delete(k)
        res.status(200).json({ profiles: [], followUps: [] })
        return
      }

      res.status(400).json({ error: `unknown action "${action}"` })
      return
    }

    res.status(405).json({ error: 'GET or POST only' })
  } catch (err) {
    if (runtime) { const failure = readRuntimeError(err); res.status(failure.status).json(failure.body); return }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
  }
  return runtime ? runWithPropertyRuntime(runtime,run) : withTenant(tenantId!,run)
}

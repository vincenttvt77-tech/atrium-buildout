import { authorizeOps } from '../src/ops/session.ts'
import { documentStoreFromEnv } from '../src/store/documents.ts'
import { isHostedRuntime } from '../src/store/config.ts'
import { listProfiles, listFollowUps, profileKey, followUpKey } from '../src/leads/consolidate.ts'
import type { LeadProfile } from '../src/leads/profile.ts'
import type { FollowUp } from '../src/leads/followups.ts'
import { normalisePhone, pinnedName } from '../src/leads/profile.ts'
import { withTenant } from '../src/tenancy/context.ts'
import { isPostgresRuntime, resolveOpsRuntime, runWithPropertyRuntime, readRuntimeError, runtimeForRequest, RuntimeRequestError } from '../src/application/runtime.ts'
import type { ResolvedPropertyRuntime } from '../src/application/runtime.ts'
import { randomUUID } from 'node:crypto'
import rawUnits from '../data/inventory.json' with { type: 'json' }
import rawPlans from '../data/floorplans.json' with { type: 'json' }
import rawInventorySource from '../data/inventory-source.json' with { type: 'json' }
import { loadInventory } from '../src/inventory/load.ts'
import { propertyTimeZone } from '../src/config/property.ts'
import { addUnitFeedback, editUnitFeedback, listUnitFeedback, feedbackInventory, UnitFeedbackError } from '../src/leads/unit-feedback.ts'
import type { FeedbackActor } from '../src/leads/unit-feedback.ts'
import { calendarStoreFromEnv } from '../src/calendar/store.ts'
import { pendingRescheduleVisibility } from '../src/leads/reschedule.ts'
import { listTourChangeRequests, reviewTourChangeRequest, TourChangeRequestError } from '../src/leads/tour-change.ts'

/**
 * Lead profiles and the follow-up queue, for the operations dashboard.
 *
 * GET returns every profile and every follow-up. POST marks a follow-up done or skipped,
 * or adds a note to a profile. Behind the same passcode as everything else here — this is
 * every caller's name, number, email and stated budget.
 */

const store = documentStoreFromEnv()
const calendar = calendarStoreFromEnv()

export default async function handler(req: any, res: any) {
  req.atriumRequestId = randomUUID()
  res.setHeader('x-request-id', req.atriumRequestId)
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')

  let runtime: ResolvedPropertyRuntime | undefined
  let tenantId: string | undefined
  let feedbackActor: FeedbackActor
  try {
    if (isPostgresRuntime()) {
      runtime = await resolveOpsRuntime(req, req.method === 'GET' ? 'read' : 'operate')
      if (runtime.scope.actor.kind !== 'user') throw new Error('Staff authentication is required')
      const principal = await runtimeForRequest(req).authenticate(req.headers ?? {}, new Date())
      if (!principal || principal.userId !== runtime.scope.actor.userId) throw new RuntimeRequestError(401, 'unauthenticated', 'Sign in again.')
      feedbackActor = { id: principal.userId, label: principal.displayName }
      const json = res.json.bind(res)
      res.json = (body: Record<string, unknown>) => json({...body,scope:runtime!.responseScope})
    } else {
      const auth = authorizeOps(req.headers ?? {}, new Date())
      if (!auth.ok) {
        res.status(auth.reason === 'not_configured' ? 503 : 401).json({error:auth.reason === 'not_configured' ? 'Leads require a configured portal account.' : 'unauthorized'})
        return
      }
      tenantId = auth.tenantId
      const selectedTenant = req.headers?.['x-atrium-tenant-id']
      if (selectedTenant !== undefined && selectedTenant !== tenantId) {
        res.status(409).json({error:'The signed-in workspace changed. Reload this page before continuing.',code:'portal_tenant_changed'})
        return
      }
      feedbackActor = { id: auth.username, label: auth.displayName }
    }
  } catch(error) { const failure = readRuntimeError(error); res.status(failure.status).json(failure.body); return }
  const run = async () => {
  const now = new Date()
  const feedbackScope = JSON.stringify(runtime ? ['property', runtime.scope.organizationId, runtime.scope.propertyId] : ['tenant', tenantId])
  const inventory = () => {
    if (runtime) return runtime.snapshot.inventory
    const loaded = loadInventory(rawUnits, rawPlans, new Date(rawInventorySource.catalogAsOf), 'Bundled fictional demo inventory; no PMS connection', rawInventorySource, now)
    if (loaded.problems.length) throw new Error('The property inventory configuration is invalid')
    return loaded.snapshot
  }

  try {
    if (req.method === 'GET') {
      const [profiles, followUps, feedback, calendarState, tourChangeRequests] = await Promise.all([listProfiles(store), listFollowUps(store), listUnitFeedback(store, feedbackScope), calendar.read(), listTourChangeRequests(store)])
      const descriptors = feedbackInventory(inventory())
      if (runtime) await runtime.revalidate()
      res.status(200).json({
        profiles,
        tourChangeRequests,
        ...pendingRescheduleVisibility(calendarState, followUps),
        ...feedback,
        ...descriptors,
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

      if (action === 'unit_feedback_add' || action === 'unit_feedback_edit') {
        if (!runtime && req.headers?.['x-atrium-tenant-id'] === undefined) {
          res.status(428).json({error:'Reload the workspace before saving unit feedback.',code:'portal_tenant_required'})
          return
        }
        const { action: _action, ...input } = body
        const context = { scopeKey: feedbackScope, actor: feedbackActor!, inventory: inventory(),
          timeZone: runtime?.snapshot.timeZone ?? propertyTimeZone(), now }
        const save = (documents: typeof store) => action === 'unit_feedback_add'
          ? addUnitFeedback(documents, input, context) : editUnitFeedback(documents, input, context)
        // Keep reference reads, feedback and mutation audit together in PostgreSQL.
        // Legacy KV uses a single feedback CAS envelope, within its existing tenant scope.
        const unitFeedback = runtime ? await runtime.documents.transaction(save) : await save(store)
        res.status(200).json({ unitFeedback })
        return
      }

      if (action === 'review_tour_change') {
        if (!runtime && req.headers?.['x-atrium-tenant-id'] === undefined) {
          res.status(428).json({error:'Reload the workspace before reviewing a tour-change request.',code:'portal_tenant_required'})
          return
        }
        if (Object.keys(body).some(key => !['action', 'id', 'expectedRevision', 'note'].includes(key))
          || typeof body.id !== 'string') throw new TourChangeRequestError('tour_change_invalid')
        const review = (documents: typeof store) => reviewTourChangeRequest(documents, {
          id: body.id, expectedRevision: body.expectedRevision, note: body.note, at: now, actorId: feedbackActor.id,
        })
        const tourChangeRequest = runtime ? await runtime.documents.transaction(review) : await review(store)
        res.status(200).json({tourChangeRequest})
        return
      }

      if (action === 'followup_status') {
        const id = String(body.id ?? '')
        const status = String(body.status ?? '')
        if (!/^fu-/.test(id) || !['scheduled', 'done', 'skipped'].includes(status)) {
          res.status(400).json({ error: 'id must be a follow-up id and status one of scheduled|done|skipped' })
          return
        }
        const existing = await store.get<FollowUp>(followUpKey(id))
        if (!existing) { res.status(404).json({ error: 'no such follow-up' }); return }
        const updated = await store.update<FollowUp>(followUpKey(id), existing, (f) => {
          if (f.superseded && status === 'scheduled') throw new RuntimeRequestError(409, 'tour_reminder_superseded', 'This reminder belongs to an earlier tour time. Use the current tour’s follow-up instead.')
          return { ...f, status: status as FollowUp['status'] }
        })
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
    if (err instanceof TourChangeRequestError) {
      const status = err.code === 'tour_change_not_found' ? 404 : err.code === 'tour_change_conflict' ? 409 : 400
      const error = status === 404 ? 'This tour-change request is no longer available.' : status === 409
        ? 'This request changed. Refresh and review the latest caller details.' : 'Check the tour-change request and review note.'
      res.status(status).json({error,code:err.code}); return
    }
    if (err instanceof UnitFeedbackError) { res.status(err.status).json({error:err.message,code:err.code}); return }
    if (runtime || err instanceof RuntimeRequestError) { const failure = readRuntimeError(err); res.status(failure.status).json(failure.body); return }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
  }
  return runtime ? runWithPropertyRuntime(runtime,run) : withTenant(tenantId!,run)
}

import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import type { PostgresWorkflowRepository } from '../database/workflows.ts'
import type { PropertySnapshot } from '../properties/model.ts'
import { WorkflowError } from '../workflows/model.ts'
import { runWorkflowOnce } from '../workflows/worker.ts'
import { createResendEmailConnector } from './workflow.ts'
import { propertyEmailBinding } from './sender.ts'
import type { ResendTransport } from './render.ts'

export const EMAIL_RECONCILER = 'email-reconciler'
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)

/** An explicit, expiring publication binds a registered worker to one property. */
export function emailReconciliationEnabled(snapshot: PropertySnapshot, runnerId: string, now: Date): boolean {
  const raw = snapshot.property.emailReconciliation
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !id(runnerId) || !Number.isFinite(now.getTime())) return false
  const v = raw as Record<string, unknown>
  return Object.keys(v).sort().join(',') === 'enabled,organizationId,propertyId,reviewExpiresAt,runnerId'
    && v.enabled === true && v.organizationId === snapshot.organizationId && v.propertyId === snapshot.propertyId
    && v.runnerId === runnerId && typeof v.reviewExpiresAt === 'string'
    && Date.parse(v.reviewExpiresAt) > now.getTime() && Date.parse(v.reviewExpiresAt) - now.getTime() <= 30 * 86400000
}

export function emailVerificationCommand(value: unknown): { actionId: string; expectedRevision: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError('workflow_invalid_input', 'Choose an email in the work queue.')
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'actionId,expectedRevision' || !id(v.actionId)
    || typeof v.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(v.expectedRevision)) {
    throw new WorkflowError('workflow_invalid_input', 'Reload the work queue and choose an email.')
  }
  return { actionId: v.actionId, expectedRevision: v.expectedRevision }
}

export function createEmailReconciliationService(property: ResolvedPropertyRuntime, repository: PostgresWorkflowRepository,
  provider: { configured: boolean; transport: () => ResendTransport }, now: () => Date = () => new Date()) {
  const guard = async () => {
    await property.revalidate()
    const actor = property.scope.actor
    if (actor.kind === 'channel' && (actor.provider !== EMAIL_RECONCILER
      || !emailReconciliationEnabled(property.snapshot, actor.externalId, now()))) {
      throw new WorkflowError('email_reconciliation_disabled', 'Delivery checks are not enabled for this property worker.')
    }
    if (!provider.configured) throw new WorkflowError('email_not_configured', 'The email provider is not connected.')
  }
  async function verify(actionId: string, expectedRevision?: string) {
    await guard()
    const action = await repository.get(actionId)
    if (!action) throw new WorkflowError('workflow_not_found', 'The email action was not found in this property.')
    if (expectedRevision !== undefined && action.revision !== expectedRevision) {
      throw new WorkflowError('workflow_revision_conflict', 'This action changed. Refresh the queue before checking it.')
    }
    if (action.kind !== 'leasing_email' || action.connector !== 'resend_email_v1' || !action.dispatchStarted) {
      throw new WorkflowError('email_verification_refused', 'Only an email with an existing dispatch attempt can be checked here.')
    }
    // Completed/review-held work is inspection only. Explicit configure-authorized
    // recovery is separate; this endpoint cannot reset attempts or clear a hold.
    if (['succeeded','needs_review','cancelled'].includes(action.state)) return action
    const consent = action.input.consent
    const purpose = consent && typeof consent === 'object' && !Array.isArray(consent)
      ? consent.purpose === 'leasing_shortlist' ? 'voiceShortlistEmail' : consent.purpose === 'tour_confirmation' ? 'tourConfirmationEmail' : null : null
    // A missing/expired sender still consumes bounded verification attempts rather
    // than starving every later email in the property batch. It makes no provider call.
    const readOnly = {
      id: 'resend_email_v1', idempotentWrites: false, verificationRequiresReference: true,
      async dispatch(): Promise<never> { throw new Error('Delivery reconciliation cannot send email') },
      async verify(current: typeof action, signal: AbortSignal) {
        await guard()
        const binding = purpose && propertyEmailBinding(property.snapshot, now(), purpose)
        if (!binding) return { status: 'unknown' as const, code: 'email_binding_unavailable' }
        const connector = createResendEmailConnector({ organizationId: property.scope.organizationId, propertyId: property.scope.propertyId,
          from: binding.from, replyTo: binding.replyTo, transport: provider.transport(), now })
        const result = await connector.verify(current, signal)
        await guard()
        if (!propertyEmailBinding(property.snapshot, now(), purpose!)) return { status: 'unknown' as const, code: 'email_binding_unavailable' }
        return result
      },
    }
    await runWorkflowOnce({ repository, connectors: new Map([[readOnly.id, readOnly]]), actionId, ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      verifyOnly: true, workerId: `email-check:${property.requestId}`, leaseMs: 15000, timeoutMs: 2000,
      baseBackoffMs: 60000, maxBackoffMs: 3600000 })
    await property.revalidate()
    return (await repository.get(actionId))!
  }
  return {
    verify,
    async runDue() {
      await guard()
      if (property.scope.actor.kind !== 'channel' || property.scope.actor.provider !== EMAIL_RECONCILER) {
        throw new WorkflowError('email_reconciliation_disabled', 'A registered property worker is required.')
      }
      const actions = await repository.dueEmailVerifications(5)
      const results = []
      for (const action of actions) {
        // The atomic targeted claim resolves overlapping invocations. No in-process
        // locks, detached promises or first-send fallback are involved.
        const current = await verify(action.id)
        results.push({ id: current.id, state: current.state })
      }
      await property.revalidate()
      return { inspected: results.length, actions: results }
    },
  }
}

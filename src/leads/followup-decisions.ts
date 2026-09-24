import type { DocumentStore } from '../store/documents.ts'
import type { FollowUp, FollowUpDecision } from './followups.ts'
import { hashJson } from '../workflows/validation.ts'

const statuses = ['scheduled', 'done', 'skipped']
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0
  && value.length <= limit && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
const commandId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
export class FollowUpDecisionError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
const conflict = () => new FollowUpDecisionError(409, 'followup_changed', 'This follow-up changed. Reload and review the latest decision before continuing.')

function checked(row: FollowUp): FollowUp {
  if (!row || !text(row.id, 512) || !statuses.includes(row.status)
    || (row.staffDecisions !== undefined && (!Array.isArray(row.staffDecisions) || row.staffDecisions.length > 100
      || new Set(row.staffDecisions.map(d => d?.requestId)).size !== row.staffDecisions.length
      || row.staffDecisions.some(d => !d || !commandId(d.requestId) || !digest(d.expectedSha256)
        || !statuses.includes(d.from) || !statuses.includes(d.to) || d.from === d.to
        || !text(d.actorId, 256) || !text(d.actorLabel, 256) || !Number.isFinite(Date.parse(d.at)))))) {
    throw new FollowUpDecisionError(503, 'followup_record_invalid', 'The saved follow-up needs administrator review.')
  }
  return row
}

/** Canonical JSON keeps the same fingerprint through PostgreSQL JSONB key ordering. */
export function followUpFingerprint(row: FollowUp): string { return hashJson(checked(row)) }
export function presentFollowUp(row: FollowUp) { return { ...row, expectedSha256: followUpFingerprint(row) } }

/** One document CAS couples status, immutable acknowledgement and staff history in KV and PG. */
export async function decideFollowUp(store: DocumentStore, input: {
  id: string; status: FollowUp['status']; requestId: string; expectedSha256: string
}, actor: { id: string; label: string }, at: Date) {
  if (!text(input.id, 512) || !input.id.startsWith('fu-') || !statuses.includes(input.status)
    || !commandId(input.requestId) || !digest(input.expectedSha256)
    || !text(actor.id, 256) || !text(actor.label, 256) || !Number.isFinite(at.getTime())) {
    throw new FollowUpDecisionError(400, 'followup_command_invalid', 'Reload the follow-up before recording a decision.')
  }
  let replayed = false
  const updated = await store.update<FollowUp | null>(`followup:${input.id}`, null, current => {
    if (!current) throw new FollowUpDecisionError(404, 'followup_not_found', 'This follow-up is no longer available.')
    checked(current)
    if (current.id !== input.id) throw new FollowUpDecisionError(503, 'followup_record_invalid', 'The saved follow-up identity could not be verified.')
    const decisions = current.staffDecisions ?? [], saved = decisions.find(d => d.requestId === input.requestId)
    replayed = Boolean(saved)
    if (saved) {
      if (saved.expectedSha256 !== input.expectedSha256 || saved.to !== input.status || saved.actorId !== actor.id) throw conflict()
      return current
    }
    if (followUpFingerprint(current) !== input.expectedSha256 || current.status === input.status) throw conflict()
    if (current.superseded && input.status === 'scheduled') throw new FollowUpDecisionError(409, 'tour_reminder_superseded',
      current.superseded.reason === 'tour_cancelled' ? 'This reminder belongs to a cancelled tour and cannot be reopened.'
        : 'This reminder belongs to an earlier tour time. Use the current tour’s follow-up instead.')
    if (decisions.length >= 100) throw new FollowUpDecisionError(409, 'followup_history_full', 'This follow-up needs administrator review before another change. Its history has been retained.')
    const decision: FollowUpDecision = { requestId: input.requestId, expectedSha256: input.expectedSha256,
      from: current.status, to: input.status, actorId: actor.id, actorLabel: actor.label, at: at.toISOString() }
    return { ...current, status: input.status, staffDecisions: [...decisions, decision] }
  })
  const decision = updated!.staffDecisions!.find(d => d.requestId === input.requestId)!
  return { followUp: presentFollowUp(updated!), decision, replayed }
}

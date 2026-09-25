import { randomUUID } from 'node:crypto'
import type { DocumentStore } from '../store/documents.ts'
import { hashJson } from '../workflows/validation.ts'
import { assistantPatch } from './sync.ts'
import type { DemoAssistantConfig } from './config.ts'

type JsonRecord = Record<string, unknown>
type Patch = ReturnType<typeof assistantPatch>
const record = (v: unknown): v is JsonRecord => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const FIELDS = ['firstMessage', 'firstMessageMode', 'server', 'model', 'startSpeakingPlan', 'stopSpeakingPlan'] as const
const LIMIT = 100
const TTL = 15 * 60_000

export class VoiceReleaseError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code }
}
const changed = () => new VoiceReleaseError(409, 'voice_release_changed', 'The property or assistant changed. Review a fresh release before publishing.')
const invalid = () => new VoiceReleaseError(503, 'voice_release_invalid', 'The saved assistant release needs administrator review. Nothing was sent.')

export interface VoiceReleaseContext {
  organizationId: string
  propertyId: string
  configurationVersion: number
  bindingFingerprint: string
  assistantId: string
  providerOrganizationId: string
}
export interface VoiceReleaseProvider {
  /** Read this exact ID only. Implementations must bound replies and reject redirects. */
  read(assistantId: string): Promise<JsonRecord>
  /** Exactly one attempt: no SDK, transport or application retries. */
  patch(assistantId: string, patch: Patch): Promise<void>
}
interface Release {
  id: string
  context: VoiceReleaseContext
  preparedBy: string
  preparedAt: string
  expiresAt: string
  configurationHash: string
  beforeHash: string
  writtenHashes: Record<typeof FIELDS[number], string>
  retainedHash: string
  reviewHash: string
  state: 'prepared' | 'sending' | 'verified' | 'cancelled'
  dispatch?: { id: string; actorId: string; at: string }
  checkedAt?: string
  check?: 'matches' | 'differs' | 'unavailable'
  cancelledBy?: string
  cancelledAt?: string
}
interface Journal { format: 1; releases: Release[] }
const empty = (): Journal => ({ format: 1, releases: [] })

function reviewContent(r: Release) {
  return { id: r.id, context: r.context, preparedBy: r.preparedBy, preparedAt: r.preparedAt,
    expiresAt: r.expiresAt, configurationHash: r.configurationHash, beforeHash: r.beforeHash,
    writtenHashes: r.writtenHashes, retainedHash: r.retainedHash }
}
function validContext(c: VoiceReleaseContext): boolean {
  return Boolean(c) && id(c.organizationId) && id(c.propertyId) && id(c.assistantId)
    && id(c.providerOrganizationId) && digest(c.bindingFingerprint)
    && Number.isSafeInteger(c.configurationVersion) && c.configurationVersion > 0
}
function checked(j: Journal): Journal {
  if (!j || j.format !== 1 || !Array.isArray(j.releases) || j.releases.length > LIMIT
    || new Set(j.releases.map(r => r?.id)).size !== j.releases.length
    || j.releases.filter(r => r.state === 'sending').length > 1) throw invalid()
  for (const r of j.releases) {
    if (!r || !id(r.id) || !validContext(r.context) || !id(r.preparedBy)
      || !instant(r.preparedAt) || !instant(r.expiresAt) || Date.parse(r.expiresAt) - Date.parse(r.preparedAt) !== TTL
      || !digest(r.configurationHash) || !digest(r.beforeHash) || !digest(r.retainedHash)
      || !record(r.writtenHashes) || Object.keys(r.writtenHashes).sort().join() !== [...FIELDS].sort().join()
      || !FIELDS.every(k => digest(r.writtenHashes[k])) || !digest(r.reviewHash)
      || r.reviewHash !== hashJson(reviewContent(r)) || !['prepared', 'sending', 'verified', 'cancelled'].includes(r.state)
      || (['sending', 'verified'].includes(r.state) !== Boolean(r.dispatch))
      || (r.dispatch && (!id(r.dispatch.id) || !id(r.dispatch.actorId) || !instant(r.dispatch.at)))
      || (r.checkedAt !== undefined && !instant(r.checkedAt))
      || (r.check !== undefined && !['matches', 'differs', 'unavailable'].includes(r.check))
      || (r.state === 'verified' && (r.check !== 'matches' || !r.checkedAt))
      || (r.state === 'cancelled' && (!id(r.cancelledBy) || !instant(r.cancelledAt)))) throw invalid()
  }
  return j
}

function projectionHash(value: unknown): string { return hashJson(value ?? null) }
function writtenHashes(value: JsonRecord): Release['writtenHashes'] {
  return Object.fromEntries(FIELDS.map(k => [k, projectionHash(value[k])])) as Release['writtenHashes']
}
/** The entire model (including a custom endpoint) is reviewed; raw credentials are never persisted. */
function retainedHash(value: JsonRecord): string {
  return hashJson({ voice: value.voice ?? null, transcriber: value.transcriber ?? null })
}
function verifyIdentity(value: JsonRecord, context: VoiceReleaseContext): void {
  if (!record(value) || value.id !== context.assistantId || value.orgId !== context.providerOrganizationId
    || !record(value.model) || typeof value.model.provider !== 'string' || !value.model.provider
    || !record(value.voice) || !record(value.transcriber)) {
    throw new VoiceReleaseError(502, 'voice_provider_identity', 'The configured assistant, provider account or speech configuration could not be verified.')
  }
  // Canonicalization rejects malformed, cyclic, excessively deep or oversized data.
  hashJson(value)
}

function reviewedPatch(existing: JsonRecord, config: DemoAssistantConfig): Patch {
  const patch = assistantPatch(existing, config)
  // Vapi replaces the complete model object. Provider files/custom knowledge servers
  // have no authorized property provenance here; approved knowledge uses Atrium tools.
  delete patch.model.knowledgeBase
  const containsMaskedValue = (value: unknown): boolean => value === '[REDACTED]'
    || Boolean(value && typeof value === 'object' && Object.values(value).some(containsMaskedValue))
  if (containsMaskedValue(patch)) throw new VoiceReleaseError(409, 'voice_provider_masked',
    'The provider masked a setting that this update must preserve. Review its saved credential references before publishing. No update was sent.')
  return patch
}

/**
 * A property-owned release journal. The production store must authorize configure and
 * check this exact binding/configuration inside every transaction. External I/O happens
 * after the durable dispatch admission, never inside a replayable storage callback.
 */
export function createManagedVoiceRelease(options: {
  store: Pick<DocumentStore, 'get' | 'update'>
  context: VoiceReleaseContext
  config: DemoAssistantConfig & { server: { url: string; credentialId: string } }
  actorId: string
  provider: VoiceReleaseProvider
  authorize(): Promise<void>
  backendReady(): Promise<boolean>
  clock?: () => Date
}) {
  const { store, provider, actorId } = options
  const context = structuredClone(options.context), config = structuredClone(options.config)
  if (!validContext(context) || !id(actorId)) throw invalid()
  const key = `voice-release:${context.assistantId}`
  // Older prepared reviews authorized retaining provider knowledge. Require a new
  // review for this policy; dispatched records still verify against their saved hashes.
  const configurationHash = hashJson({ context, config, knowledgePolicy: 'property-tools-v1' })
  const now = () => {
    const date = options.clock?.() ?? new Date()
    if (!Number.isFinite(date.getTime())) throw invalid()
    return date
  }
  const ownJournal = (j: Journal) => {
    checked(j)
    if (j.releases.some(r => r.context.organizationId !== context.organizationId || r.context.propertyId !== context.propertyId
      || r.context.assistantId !== context.assistantId)) throw invalid()
    return j
  }
  const load = async () => ownJournal(await store.get<Journal>(key) ?? empty())
  const update = (change: (journal: Journal) => Journal) => store.update<Journal>(key, empty(), j => ownJournal(change(ownJournal(j))))
  const locate = (j: Journal, releaseId: string) => {
    const release = j.releases.find(r => r.id === releaseId)
    if (!release) throw new VoiceReleaseError(404, 'voice_release_missing', 'This assistant release is no longer available.')
    if (release.context.organizationId !== context.organizationId || release.context.propertyId !== context.propertyId
      || release.context.assistantId !== context.assistantId) throw invalid()
    return release
  }
  const present = (r: Release) => ({ id: r.id, state: r.state, reviewHash: r.reviewHash,
    configurationVersion: r.context.configurationVersion, preparedAt: r.preparedAt, preparedBy: r.preparedBy,
    expiresAt: r.expiresAt, current: r.configurationHash === configurationHash,
    ...(r.dispatch ? { submittedAt: r.dispatch.at, submittedBy: r.dispatch.actorId } : {}),
    ...(r.checkedAt ? { checkedAt: r.checkedAt, check: r.check } : {}),
    ...(r.state === 'cancelled' ? { cancelledAt: r.cancelledAt, cancelledBy: r.cancelledBy } : {}) })
  const requireCurrent = (r: Release) => {
    if (r.configurationHash !== configurationHash || hashJson(r.context) !== hashJson(context)
      || Date.parse(r.expiresAt) <= now().getTime()) throw changed()
  }
  const review = (r: Release) => {
    const current = r.configurationHash === configurationHash
    return { release: present(r), proposal: current ? { firstMessage: config.firstMessage,
      prompt: config.model.messages, tools: config.model.tools, serverUrl: config.server.url,
      startSpeakingPlan: config.startSpeakingPlan, stopSpeakingPlan: config.stopSpeakingPlan,
      knowledgeSource: 'approved-property-tools',
      kept: ['voice', 'transcriber', 'model and custom endpoint', 'unrelated assistant settings'] } : null }
  }
  const ready = async () => {
    await options.authorize()
    if (!await options.backendReady()) throw new VoiceReleaseError(409, 'voice_backend_contract_mismatch',
      'The configured backend does not match these voice tools. No update was sent.')
    await options.authorize()
  }
  const readProvider = async () => {
    let value: JsonRecord
    try { value = await provider.read(context.assistantId) }
    catch { throw new VoiceReleaseError(502, 'voice_provider_unavailable', 'The phone provider could not be read. No new update was sent.') }
    verifyIdentity(value, context)
    await options.authorize()
    return value
  }
  const verify = async (releaseId: string) => {
    await options.authorize()
    const release = locate(await load(), releaseId)
    if (!release.dispatch || release.state === 'verified') return review(release)
    // Recovery never writes the provider, even if preparation/source/credentials changed.
    let observation: Release['check'] = 'unavailable'
    try {
      const current = await readProvider()
      observation = hashJson(writtenHashes(current)) === hashJson(release.writtenHashes)
        && retainedHash(current) === release.retainedHash ? 'matches' : 'differs'
    } catch { /* A separate authority check below must still pass before recording/returning. */ }
    await options.authorize()
    const result = await update(j => {
      const r = locate(j, releaseId)
      if (r.state !== 'sending' || r.dispatch?.id !== release.dispatch?.id) return j
      r.checkedAt = now().toISOString(); r.check = observation
      if (observation === 'matches') r.state = 'verified'
      return j
    })
    return review(locate(result, releaseId))
  }
  return {
    async list() { await options.authorize(); const j = await load(); return { releases: j.releases.map(present).reverse() } },
    async read(releaseId: string) { await options.authorize(); return review(locate(await load(), releaseId)) },
    async prepare(requestId: string) {
      if (!id(requestId)) throw new VoiceReleaseError(400, 'voice_release_command', 'Use a fresh assistant review request.')
      await options.authorize()
      const journal = await load(), prior = journal.releases.find(r => r.id === requestId)
      if (prior) {
        if (prior.preparedBy !== actorId) throw changed()
        return review(prior)
      }
      if (journal.releases.some(r => r.state === 'sending')) throw new VoiceReleaseError(409, 'voice_release_unconfirmed',
        'An earlier update is unconfirmed. Check its saved result before preparing another update.')
      await ready()
      const existing = await readProvider(), patch = reviewedPatch(existing, config)
      const at = now(), plan = { id: requestId, context, preparedBy: actorId, preparedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + TTL).toISOString(), configurationHash,
        beforeHash: hashJson(existing), writtenHashes: writtenHashes(patch), retainedHash: retainedHash(existing),
        reviewHash: '', state: 'prepared' as const }
      plan.reviewHash = hashJson(reviewContent(plan))
      const saved = await update(j => {
        const same = j.releases.find(r => r.id === requestId)
        if (same) { if (same.preparedBy !== actorId) throw changed(); return j }
        if (j.releases.some(r => r.state === 'sending')) throw new VoiceReleaseError(409, 'voice_release_unconfirmed',
          'An earlier update is unconfirmed. Check its saved result before preparing another update.')
        if (j.releases.length >= LIMIT) throw new VoiceReleaseError(409, 'voice_release_history_full', 'Release history needs administrator review. All saved evidence has been retained.')
        return { format: 1, releases: [...j.releases, plan] }
      })
      return review(locate(saved, requestId))
    },
    async publish(releaseId: string, reviewHash: string) {
      await options.authorize()
      const release = locate(await load(), releaseId)
      if (release.reviewHash !== reviewHash) throw changed()
      if (release.state !== 'prepared') return review(release)
      requireCurrent(release)
      await ready()
      const existing = await readProvider()
      if (hashJson(existing) !== release.beforeHash) throw changed()
      const patch = reviewedPatch(existing, config)
      if (hashJson(writtenHashes(patch)) !== hashJson(release.writtenHashes)
        || retainedHash(existing) !== release.retainedHash) throw changed()
      const dispatchId = randomUUID()
      const saved = await update(j => {
        const r = locate(j, releaseId)
        if (r.reviewHash !== reviewHash) throw changed()
        if (r.state !== 'prepared') return j
        requireCurrent(r)
        if (j.releases.some(other => other.state === 'sending')) throw changed()
        r.state = 'sending'; r.dispatch = { id: dispatchId, actorId, at: now().toISOString() }
        return j
      })
      if (locate(saved, releaseId).dispatch?.id !== dispatchId) return review(locate(saved, releaseId))
      // Admission is durable before I/O. Neither a lost reply nor an HTTP error permits retry.
      try { await provider.patch(context.assistantId, patch) } catch { /* Verify the saved result without sending again. */ }
      return verify(releaseId)
    },
    async cancel(releaseId: string, reviewHash: string) {
      await options.authorize()
      const saved = await update(j => {
        const r = locate(j, releaseId)
        if (r.reviewHash !== reviewHash) throw changed()
        if (r.state === 'cancelled') return j
        if (r.state !== 'prepared') throw new VoiceReleaseError(409, 'voice_release_dispatched', 'This update may already have reached Vapi. Check its result; it cannot be cancelled here.')
        r.state = 'cancelled'; r.cancelledBy = actorId; r.cancelledAt = now().toISOString()
        return j
      })
      return review(locate(saved, releaseId))
    },
    verify,
  }
}

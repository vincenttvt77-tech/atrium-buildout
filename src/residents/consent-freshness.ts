import { ConsentError } from './consent-model.ts'

/** Call after the last awaited authorization check, only for current projections. */
export function assertConsentFreshness(deadlines: readonly (string | number | null)[], now = Date.now()): void {
  if (!Number.isFinite(now)) throw new ConsentError('consent_changed')
  for (const deadline of deadlines) {
    if (deadline === null) continue
    const expiresAt = typeof deadline === 'number' ? deadline : Date.parse(deadline)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new ConsentError('consent_changed')
  }
}

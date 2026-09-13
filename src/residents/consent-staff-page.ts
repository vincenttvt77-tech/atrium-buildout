import type { AuthenticatedUser } from '../auth/model.ts'
import type { PropertyResponseScope } from '../application/runtime.ts'
import { residentEscape as esc, residentJson as json, residentPageStyle } from './portal-page.ts'
import { consentPageStyle } from './consent-page.ts'

export interface MaintenanceConsentPageInput {
  principal: AuthenticatedUser
  scope: PropertyResponseScope
  caseId: string | null
  nonce: string
  formToken: string
  error?: string
}
export function renderMaintenanceConsentPage({ principal, scope, caseId, nonce, formToken, error }: MaintenanceConsentPageInput, clientScript: string): string {
  if (principal.audience !== 'staff' || !principal.sessionId) throw new Error('A registered staff session is required')
  const safeScope = { organizationId: scope.organizationId, propertyId: scope.propertyId, configurationVersion: scope.configurationVersion, permissionVersion: scope.permissionVersion }
  const back = `/api/dashboard?organizationId=${encodeURIComponent(scope.organizationId)}&propertyId=${encodeURIComponent(scope.propertyId)}#/services?tab=plans${caseId ? '&id=' + encodeURIComponent(caseId) : ''}`
  const bootstrap = { audience: 'staff', userId: principal.userId, sessionId: principal.sessionId, scope: safeScope, caseId, formToken }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Resident decisions — Atrium</title><style nonce="${esc(nonce)}">${residentPageStyle}${consentPageStyle}</style></head><body>
<header><div class="brand">atrium<span>.</span></div><a class="link" href="${esc(back)}">Back to Service</a></header><main id="consent-staff-root">
<section class="hero"><span class="eyebrow">MAINTENANCE · RESIDENT DECISIONS</span><h1>Prepare a clear review</h1><p>Confirm who may decide, publish the exact work and payment terms, and see what is still needed.</p></section>
<p class="identity"><strong>${esc(principal.displayName)}</strong>${esc(principal.username)}</p>
<p id="consent-staff-notice" class="notice" role="status" aria-live="polite"${error ? ' data-error="true"' : ''}>${esc(error ?? '')}</p>
<section id="consent-staff-recovery" class="panel warning" hidden tabindex="-1" aria-label="Check consent change"></section>
<div class="actions consent-toolbar"><button type="button" class="secondary" id="consent-staff-refresh" disabled>Refresh current readiness</button><a class="link" href="/api/mfa">Verify administrator access</a></div>
<section id="consent-staff-state" aria-busy="true"><div class="panel"><h2>Loading current readiness</h2><p>Checking the property rules, work plan and resident decision requirements.</p></div></section>
<section id="consent-staff-task" class="panel review" hidden tabindex="-1" aria-label="Review consent change"></section>
<p class="scope-note">Staff prepare the review. Each resident decides using their own account and passkey. No invitation delivery, appointment, dispatch or payment is performed here.</p>
<noscript><p>JavaScript is required to prepare or change resident review terms. No change can be submitted without it.</p></noscript>
</main><script nonce="${esc(nonce)}">window.ATRIUM_MAINTENANCE_CONSENT=${json(bootstrap)};</script><script nonce="${esc(nonce)}">${clientScript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}

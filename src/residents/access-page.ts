import type { AuthenticatedUser } from '../auth/model.ts'
import type { PropertyResponseScope } from '../application/runtime.ts'
import { residentEscape as esc, residentJson as json, residentPageStyle } from './portal-page.ts'

export interface ResidentAccessPageInput {
  principal: AuthenticatedUser
  scope: PropertyResponseScope
  residentId: string
  nonce: string
  formToken: string
  error?: string
}
export function renderResidentAccessPage({ principal, scope, residentId, nonce, formToken, error }: ResidentAccessPageInput, clientScript: string): string {
  if (principal.audience !== 'staff') throw new Error('Staff audience required')
  const safeScope = { organizationId: scope.organizationId, propertyId: scope.propertyId,
    configurationVersion: scope.configurationVersion, permissionVersion: scope.permissionVersion }
  const bootstrap = { userId: principal.userId, sessionId: principal.sessionId, scope: safeScope, residentId, formToken }
  const back = `/api/dashboard?organizationId=${encodeURIComponent(scope.organizationId)}&propertyId=${encodeURIComponent(scope.propertyId)}#/services?tab=residents&state=all&id=${encodeURIComponent(residentId)}`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Resident access management — Atrium</title><style nonce="${esc(nonce)}">${residentPageStyle}</style></head><body>
<header><div class="brand">atrium<span>.</span></div><a class="link" href="${esc(back)}">Back to Service</a></header><main id="access-root">
<section class="hero"><span class="eyebrow">RESIDENT OPERATIONS</span><h1>Resident access</h1><p>Review the recipient in person, prepare a private invitation, and keep account access separate from occupancy and consent.</p></section>
<p class="identity"><strong>${esc(principal.displayName)}</strong>${esc(principal.username)}</p>
<p id="access-notice" class="notice" role="status" aria-live="polite"${error ? ' data-error="true"' : ''}>${esc(error ?? '')}</p>
<section id="access-recovery" class="panel warning" hidden tabindex="-1" aria-label="Check enrollment change"></section>
<section id="access-link" class="panel" hidden tabindex="-1" aria-label="Private invitation link"></section>
<div class="actions"><button type="button" id="access-refresh" class="secondary" disabled>Refresh access</button></div>
<section id="access-state" aria-busy="true"><div class="panel"><h2>Loading current access</h2><p>Waiting for the current resident record and property protocol.</p></div></section>
<section id="access-task" class="panel review" hidden tabindex="-1" aria-label="Review access change"></section>
<p class="scope-note">Atrium prepares the invitation. No email or text message is sent. Activation grants no maintenance approval, entry permission or staff access.</p>
<noscript><p>JavaScript is required to prepare or change resident access. No change can be submitted without it.</p></noscript>
</main><script nonce="${esc(nonce)}">window.ATRIUM_RESIDENT_ACCESS=${json(bootstrap)};</script><script nonce="${esc(nonce)}">${clientScript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}

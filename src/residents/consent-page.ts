import type { AuthenticatedUser } from '../auth/model.ts'
import { residentEscape as esc, residentJson as json, residentPageStyle } from './portal-page.ts'

export interface ResidentConsentPageInput {
  principal: AuthenticatedUser
  requestId?: string | null
  nonce: string
  formToken: string
  error?: string
}

export function renderResidentConsentPage({ principal, requestId = null, nonce, formToken, error }: ResidentConsentPageInput, clientScript: string): string {
  if (principal.audience !== 'resident' || !principal.sessionId) throw new Error('A registered resident session is required')
  const bootstrap = { audience: 'resident', userId: principal.userId, sessionId: principal.sessionId, requestId, formToken }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Review maintenance work — Atrium</title><style nonce="${esc(nonce)}">${residentPageStyle}${consentPageStyle}</style></head><body>
<header><div class="brand">atrium<span>.</span></div><a class="link" href="/api/resident">Resident home</a></header>
<main id="consent-root"><section class="hero"><span class="eyebrow">YOUR BUILDING · YOUR DECISION</span><h1>Review maintenance work</h1><p>See the proposed work and any costs to you. Decide about the work and apartment entry separately.</p></section>
<p class="identity"><strong>${esc(principal.displayName)}</strong>${esc(principal.username)}</p>
<p id="consent-notice" class="notice" role="status" aria-live="polite"${error ? ' data-error="true"' : ''}>${esc(error ?? '')}</p>
<section id="consent-recovery" class="panel warning" hidden tabindex="-1" aria-label="Check your decision"></section>
<div class="actions consent-toolbar"><button type="button" class="secondary" id="consent-refresh" disabled>Refresh requests</button><a class="link" href="/api/resident?resource=mfa">Resident passkeys</a></div>
<div class="consent-workspace"><section id="consent-list" aria-label="Your maintenance requests" aria-busy="true"><div class="panel"><h2>Loading your requests</h2><p>Checking which maintenance decisions are available to your account.</p></div></section><section id="consent-detail" aria-label="Selected maintenance review"></section></div>
<section id="consent-task" class="panel review" hidden tabindex="-1" aria-label="Review your decision"></section>
<section id="consent-help" aria-label="Property help"></section>
<p class="scope-note">A recorded decision is not an appointment or confirmation that anyone has been dispatched.</p>
<noscript><div class="panel warning"><h2>JavaScript is needed for online review</h2><p>No decision can be submitted from this page without it. Contact your property team for its supported assistance process. Do not share your account or passkey with staff.</p></div></noscript>
</main><script nonce="${esc(nonce)}">window.ATRIUM_RESIDENT_CONSENT=${json(bootstrap)};</script><script nonce="${esc(nonce)}">${clientScript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}

export const consentPageStyle = `
.consent-toolbar{align-items:center;justify-content:space-between;margin:0 0 22px}.consent-workspace{display:grid;grid-template-columns:minmax(240px,.72fr) minmax(0,1.28fr);gap:24px;align-items:start}.consent-workspace>section{min-width:0}.consent-list{max-height:640px;overflow:auto;scrollbar-gutter:stable}.consent-item{width:100%;text-align:left;display:block;background:#fff;color:#152743;border:1px solid #dce4f0;margin-bottom:10px;padding:18px}.consent-item[aria-current=true]{background:#edf3ff;border-color:#638bcb;box-shadow:inset 3px 0 #245cd4}.consent-item strong{display:block;font-size:18px;line-height:1.4}.consent-item span{display:block;font-size:14px;font-weight:400;margin-top:7px}.consent-item .badge{display:inline-block;font-size:12px}.consent-section{scroll-margin-top:20px}.consent-summary{font-size:18px;color:#233e62}.consent-choice{border-top:1px solid #dce4f0;padding-top:20px;margin-top:22px}.consent-choice .actions{margin-top:16px}.consent-current{border-left:4px solid #426ea9;padding-left:16px;margin:20px 0}.consent-conditions{white-space:pre-wrap;overflow-wrap:anywhere}.consent-empty{padding:24px;text-align:left}.consent-history{margin-top:22px}.consent-history summary{min-height:48px;display:flex;align-items:center;font-weight:650;cursor:pointer}.consent-history li{font-size:14px}.consent-review-heading{outline-offset:5px}.consent-policy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}.consent-authority-card{border:1px solid #dce4f0;border-radius:10px;padding:18px;margin:14px 0}.consent-authority-card .check{margin:8px 0}.consent-date-row{display:grid;grid-template-columns:minmax(0,1fr) 125px;gap:12px}.consent-danger{color:#963548}.consent-mini{font-size:13px;color:#586c88}.consent-steps{display:flex;gap:12px;flex-wrap:wrap;padding:0;list-style:none}.consent-steps li{font-size:14px;padding:7px 12px;background:#edf3ff;border-radius:20px}.consent-roster{max-height:480px;overflow:auto;scrollbar-gutter:stable}.consent-readiness{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:18px 0}.consent-readiness>div{padding:16px;border:1px solid #dce4f0;border-radius:10px}.consent-readiness strong,.consent-readiness span{display:block}.consent-readiness span{font-size:14px;color:#586c88;margin-top:5px}.consent-status{font-size:18px;font-weight:650;color:#152743}.consent-workspace:has(#consent-list:empty){grid-template-columns:minmax(0,1fr)}
@media(max-width:760px){.consent-workspace{grid-template-columns:minmax(0,1fr)}.consent-list{max-height:290px}.consent-toolbar{align-items:stretch}.consent-policy-grid,.consent-readiness{grid-template-columns:minmax(0,1fr)}.consent-date-row{grid-template-columns:minmax(0,1fr)}.consent-item{padding:16px}.consent-steps{gap:8px}.consent-steps li{font-size:13px}}
`

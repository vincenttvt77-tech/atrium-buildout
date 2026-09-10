import type { AuthenticatedUser } from './model.ts'

export interface PublicMfaState {
  securityVersion: number
  required: boolean
  everEnabled: boolean
  sessionVerified: boolean
  manageVerified: boolean
  administratorVerified: boolean
  factors: Array<{ id: string; label: string; status: 'pending' | 'active'; createdAt: number; lastUsedAt: number | null }>
  recoveryRemaining: number
}
export interface MfaPageInput {
  principal: AuthenticatedUser
  formToken: string
  nonce: string
  state: PublicMfaState
  error?: string
}
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** Only public state reaches this page; the nonce script is the application's bundled client. */
export function renderMfaPage({ principal, formToken, nonce, state, error }: MfaPageInput, clientScript: string): string {
  // Project again at the HTML boundary so passing a richer domain record cannot leak credential material.
  const publicState: PublicMfaState = {
    securityVersion: state.securityVersion, required: state.required, everEnabled: state.everEnabled,
    sessionVerified: state.sessionVerified, manageVerified: state.manageVerified,
    administratorVerified: state.administratorVerified, recoveryRemaining: state.recoveryRemaining,
    factors: state.factors.map(factor => ({ id: factor.id, label: factor.label, status: factor.status,
      createdAt: factor.createdAt, lastUsedAt: factor.lastUsedAt })),
  }
  const bootstrap = { userId: principal.userId, sessionId: principal.sessionId, formToken, state: publicState }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Passkeys — Atrium</title><style nonce="${esc(nonce)}">
:root{color-scheme:light;font:16px/1.55 system-ui,-apple-system,sans-serif;color:#152743;background:#f3f6fb}*{box-sizing:border-box}body{margin:0}header{background:#102443;color:#fff;padding:20px max(24px,calc((100vw - 1060px)/2));display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{font-size:30px;font-weight:650;letter-spacing:-2px}.brand span{color:#90b8ff}header a{color:#e4ecff;font-size:14px}a{color:#245cd4;text-underline-offset:3px}main{max-width:1060px;margin:48px auto;padding:0 24px;display:grid;grid-template-columns:280px minmax(0,1fr);gap:48px}.eyebrow{font-size:12px;font-weight:650;letter-spacing:1.5px;color:#426391}h1{font-size:36px;line-height:1.15;letter-spacing:-1.3px;margin:14px 0 20px}h2{font-size:21px;line-height:1.3;margin:0 0 12px}h3{font-size:16px;margin:0 0 6px}p{color:#586c88;margin:0 0 18px}.identity{border-top:1px solid #d5dfed;margin-top:28px;padding-top:20px;overflow-wrap:anywhere}.identity strong{display:block;color:#142948}.workspace{min-width:0}.panel{padding:28px;background:#fff;border:1px solid #dce4f0;border-radius:14px;box-shadow:0 8px 28px #14294806;margin-bottom:20px}.summary{border-left:4px solid #245cd4}.hint{font-size:13px;color:#5a6e8a}.badge{font-size:12px;padding:3px 8px;display:inline-block;border-radius:20px;background:#edf3ff;color:#244e90}.factor{padding:20px 0;border-top:1px solid #dce4f0;overflow-wrap:anywhere}.factor-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.factor p{margin:8px 0}.factor:last-child{padding-bottom:0}.actions{display:flex;gap:10px;flex-wrap:wrap}button{min-height:48px;font:inherit;font-size:14px;font-weight:600;border:1px solid #245cd4;border-radius:8px;padding:11px 16px;background:#245cd4;color:#fff;cursor:pointer}button.secondary{background:#edf3ff;color:#19458b;border-color:#bfd0ef}button.danger{background:#fff;color:#963548;border-color:#dcbac2}button:disabled{opacity:.6;cursor:not-allowed}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #94b9fc;outline-offset:3px}label{display:block;font-size:14px;font-weight:600;margin:18px 0 7px}input{width:100%;min-height:48px;padding:11px 13px;font:inherit;color:#152743;background:#fff;border:1px solid #abbcd2;border-radius:7px}form .actions{margin-top:22px}#mfa-task{border-color:#9fbbe8;scroll-margin-top:20px}#mfa-notice{white-space:pre-line;overflow-wrap:anywhere;margin:0 0 16px}#mfa-notice[data-error=true]{color:#a22d40}#mfa-next{padding:16px;background:#fff4e8;border-radius:8px}#mfa-codes{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f7ff;border:1px solid #cbdcf9;padding:18px;border-radius:8px;font:15px/1.8 ui-monospace,monospace;user-select:all}[hidden]{display:none!important}.back-link{display:inline-flex;align-items:center;min-height:44px}.step{color:#426391;font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px}.empty{padding:12px 0}.workspace>*:last-child{margin-bottom:0}
@media(max-width:720px){header{padding:16px 20px}header a{max-width:170px;text-align:right}main{display:block;margin:28px auto;padding:0 20px}.identity{margin:20px 0 28px;padding-top:16px}h1{font-size:30px}.panel{padding:22px}.actions{display:grid;grid-template-columns:minmax(0,1fr)}.actions button{width:100%}.factor-head{align-items:flex-start}.factor-head strong{min-width:0}.summary{margin-top:24px}}
</style></head><body><header><div class="brand">atrium<span>.</span></div><a class="back-link" href="/api/account">Back to account security</a></header>
<main id="mfa-root"><aside><span class="eyebrow">YOUR ACCOUNT</span><h1>Passkeys</h1><p>Use your device’s screen lock or a security key to protect your account.</p><p class="hint">Atrium receives a verification result. It does not receive your fingerprint, face scan or device PIN.</p><div class="identity"><strong>${esc(principal.displayName)}</strong><span>${esc(principal.username)}</span></div></aside>
<div class="workspace"><section id="mfa-summary" class="panel summary"><h2>Loading security settings</h2><p>Your settings will appear when this page is ready.</p></section>
<p id="mfa-notice" role="status" aria-live="polite"${error ? ' data-error="true"' : ''}>${esc(error ?? '')}</p>
<p id="mfa-next" hidden><a class="back-link" href="/api/mfa">Reload passkeys</a> · <a class="back-link" href="/api/dashboard?reauthenticate=1">Sign in again</a></p>
<section id="mfa-task" class="panel" hidden tabindex="-1" aria-label="Passkey action"><div id="mfa-task-content"></div></section>
<section id="mfa-recovery-codes" class="panel" hidden tabindex="-1" aria-labelledby="codes-heading"><h2 id="codes-heading">Save your recovery codes</h2><p>These codes are shown only now. Store them in your password manager or another secure place. Each code can be used once.</p><pre id="mfa-codes"></pre><p class="hint">Generating a new set replaces the previous set. Atrium cannot show these codes again.</p><button type="button" data-action="dismiss-codes">I saved these codes</button></section>
<section class="panel"><h2>Your passkeys</h2><div id="mfa-factors"></div><div id="mfa-actions" class="actions"></div></section>
<section id="mfa-recovery" class="panel"></section><noscript><p>JavaScript and a browser that supports passkeys are required. No security change can be submitted from this page without JavaScript.</p></noscript>
</div></main><script nonce="${esc(nonce)}">window.ATRIUM_MFA=${json(bootstrap)};</script><script nonce="${esc(nonce)}">${clientScript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
}

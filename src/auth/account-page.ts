import type { AuthenticatedUser, UserSessionRecord } from './model.ts'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

function sessionPanel(principal: AuthenticatedUser, sessions: readonly UserSessionRecord[]): string {
  const time = (value: number) => `<time datetime="${new Date(value).toISOString()}">${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC</time>`
  return `<section class="panel sessions" aria-labelledby="sessions-heading"><div class="session-heading"><div><h2 id="sessions-heading">Signed-in sessions</h2><p>Sign out of a session you no longer use or don’t recognize.</p></div><button id="sign-out-others" class="secondary" type="button" disabled>Sign out other sessions</button></div>
<p class="hint">Sessions end eight hours after sign-in. At most 20 can stay signed in; a new sign-in ends the oldest when that limit is reached. Browser labels are approximate.</p>
<p class="hint" id="session-timezone">Times shown in UTC. Activity includes automatic workspace refreshes.</p><div id="session-list">${sessions.map(session => `<article class="session-row" data-session-id="${escapeHtml(session.id)}"><div><strong>${escapeHtml(session.label)}</strong>${session.id === principal.sessionId ? ' <span class="session-badge">This session</span>' : ''}<dl><div><dt>Signed in</dt><dd>${time(session.createdAt)}</dd></div><div><dt>Last connection</dt><dd>${time(session.lastSeenAt)}</dd></div><div><dt>Ends</dt><dd>${time(session.expiresAt)}</dd></div></dl></div><button class="secondary session-revoke" type="button" data-session-id="${escapeHtml(session.id)}" disabled>${session.id === principal.sessionId ? 'Sign out this session' : 'Sign out session'}</button></article>`).join('')}</div>
<p id="session-notice" role="status" aria-live="polite"></p><p id="session-next" hidden><a href="/api/account">Reload account security</a> · <a href="/api/dashboard?reauthenticate=1">Sign in again</a></p><noscript>JavaScript is required to manage signed-in sessions.</noscript></section>`
}

/** Separate from property data: a user with no current building access still owns their identity. */
export function accountSecurityPage(principal: AuthenticatedUser, token: string, nonce: string, sessions: readonly UserSessionRecord[] = []): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Account security — Atrium</title><style nonce="${nonce}">
:root{color-scheme:light;font:16px/1.6 system-ui,-apple-system,sans-serif;color:#152743;background:#f3f6fb}*{box-sizing:border-box}
body{margin:0}header{background:#102443;color:#fff;padding:20px max(24px,calc((100vw - 1000px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand{font-size:30px;font-weight:650;letter-spacing:-2px}.brand span{color:#90b8ff}header a{color:#e4ecff;font-size:14px}
main{max-width:1000px;margin:56px auto;padding:0 24px;display:grid;grid-template-columns:1fr 1.2fr;gap:64px}h1{font-size:36px;line-height:1.2;letter-spacing:-1.3px;margin:14px 0 20px}h2{font-size:22px;margin:0 0 8px}
.eyebrow{font-size:12px;font-weight:650;letter-spacing:1.5px;color:#426391}p{color:#586c88;margin:0 0 20px}.identity{border-top:1px solid #d5dfed;margin-top:32px;padding-top:20px;overflow-wrap:anywhere}.identity strong{display:block;color:#142948}
.panel{padding:32px;background:white;border:1px solid #dce4f0;border-radius:16px;box-shadow:0 8px 28px #14294806}label{display:block;font-size:14px;font-weight:600;margin:20px 0 7px}
input{width:100%;min-height:48px;padding:11px 13px;border:1px solid #abbcd2;border-radius:7px;color:#152743;font:inherit;background:white}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #94b9fc;outline-offset:3px}
.hint{font-size:13px;margin:8px 0;color:#5a6e8a}button{min-height:48px;width:100%;border:0;border-radius:8px;padding:12px 16px;background:#245cd4;color:white;font:inherit;font-weight:600;cursor:pointer;margin-top:24px}button:disabled{opacity:.65;cursor:wait}a{color:#245cd4}#notice{margin-top:16px;font-size:14px;white-space:pre-line}#notice[data-error=true]{color:#a22d40}[hidden]{display:none!important}.outcome{padding:20px;border:1px solid #cbdcf9;background:#f3f7ff;border-radius:9px}.outcome h2{font-size:20px}.outcome p{margin-bottom:14px}.footer{margin-top:22px;font-size:13px}
.sessions{grid-column:1/-1}.session-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.session-heading p{margin-bottom:12px}.secondary{width:auto;background:#edf3ff;color:#19458b;border:1px solid #bfd0ef;margin:0;white-space:normal}.session-row{padding:24px 0;border-top:1px solid #dce4f0;display:flex;justify-content:space-between;align-items:center;gap:24px}.session-row strong{overflow-wrap:anywhere}.session-row button{flex-shrink:0}.session-badge{display:inline-block;padding:1px 8px;border-radius:20px;background:#e7efff;font-size:12px;color:#174486}.session-row dl{margin:12px 0 0;color:#586c88;font-size:13px}.session-row dl div{display:flex;gap:12px}.session-row dt{min-width:110px}.session-row dd{margin:0}#session-notice{white-space:pre-line;margin-top:16px;color:#174486}#session-notice[data-error=true]{color:#a22d40}
@media(max-width:700px){.sessions{margin-top:28px}.session-heading,.session-row{display:block}.session-heading button{margin:8px 0 16px;width:100%}.session-row button{width:100%;margin-top:16px}.session-row dl div{display:block;margin-top:8px}.session-row dt{font-weight:600}}
@media(max-width:700px){header{padding:16px 20px}main{display:block;margin:30px auto;padding:0 20px}h1{font-size:30px}.identity{margin:20px 0 28px;padding-top:16px}.panel{padding:24px}header a{max-width:150px;text-align:right}}
</style></head><body><header><div class="brand">atrium<span>.</span></div><a href="/api/dashboard">Back to workspace</a></header>
<main><section><span class="eyebrow">YOUR ACCOUNT</span><h1>Account security</h1><p>Manage your password and signed-in sessions.</p>
<p>Your account can belong to several properties and organizations. A password change applies everywhere you sign in.</p><p><a href="/api/mfa">Manage passkeys and recovery codes</a></p><p><a href="/api/organizations">Manage your organization’s team</a></p><div class="identity"><strong>${escapeHtml(principal.displayName)}</strong><span>${escapeHtml(principal.username)}</span></div></section>
<section class="panel" aria-labelledby="password-heading"><h2 id="password-heading">Change password</h2><p>Confirm your current password to choose a new one. You’ll then sign in again on each device.</p>
<form id="password-form" method="post" action="/api/account" data-user-id="${escapeHtml(principal.userId)}" data-session-id="${escapeHtml(principal.sessionId ?? '')}" data-form-token="${escapeHtml(token)}">
<input type="text" name="username" autocomplete="username" value="${escapeHtml(principal.username)}" hidden readonly>
<label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required>
<label for="new-password">New password</label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" maxlength="256" aria-describedby="password-hint" required>
<p class="hint" id="password-hint">Use at least 15 characters. A long, unique phrase works well. Spaces are welcome.</p>
<label for="confirm-password">Confirm new password</label><input id="confirm-password" type="password" autocomplete="new-password" maxlength="256" required>
<button type="submit" id="save-password" disabled>Change password</button></form><p id="notice" role="status" aria-live="polite"></p>
<div id="outcome" class="outcome" hidden tabindex="-1"><h2 id="outcome-title"></h2><p id="outcome-message"></p><a href="/api/dashboard?reauthenticate=1">Sign in again</a></div>
<p class="footer">Use a password manager to keep your new password. Atrium will never display it after saving.</p><noscript>JavaScript is required to change your password securely.</noscript></section>${sessionPanel(principal, sessions)}</main>
<script nonce="${nonce}">
const form = document.getElementById('password-form');
const notice = document.getElementById('notice');
const button = document.getElementById('save-password');
const identity = form.dataset.userId;
const activeSession = form.dataset.sessionId;
const csrfToken = form.dataset.formToken;
const inputs = ['current-password', 'new-password', 'confirm-password'].map(id => document.getElementById(id));
let busy = false;
function tell(message) { notice.textContent = message; notice.dataset.error = 'true'; }
function finish(confirmed) {
  form.reset(); form.hidden = true; notice.textContent = '';
  document.getElementById('session-list').hidden = true;
  document.getElementById('sign-out-others').hidden = true;
  document.getElementById('outcome-title').textContent = confirmed ? 'Password changed' : 'Check your sign-in';
  document.getElementById('outcome-message').textContent = confirmed
    ? 'Your new password is saved. Previous sessions can no longer access your account. Sign in again to continue.'
    : 'We couldn’t confirm whether your password changed. Sign in with the new password first. If it doesn’t work, try your previous password. This form will not submit another change.';
  const outcome = document.getElementById('outcome'); outcome.hidden = false; outcome.focus();
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy || changingSession) return;
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  if (Array.from(newPassword).length < 15) { tell('Use at least 15 characters for your new password.'); return; }
  if (newPassword !== document.getElementById('confirm-password').value) { tell('The new passwords don’t match.'); return; }
  if (newPassword === currentPassword) { tell('Choose a different password from your current one.'); return; }
  busy = true; sessionControls().forEach(control => { control.disabled = true; }); button.disabled = true; inputs.forEach(input => { input.disabled = true; }); button.textContent = 'Saving…'; notice.textContent = '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-atrium-account-action': 'change-password', 'x-atrium-user-id': identity, 'x-atrium-session-id': activeSession, 'x-atrium-csrf': csrfToken },
      body: JSON.stringify({ action: 'change-password', currentPassword, newPassword }) });
    const data = await response.json();
    if (response.status === 200 && data?.status === 'password_changed' && data.userId === identity) { finish(true); return; }
    if ([400, 429].includes(response.status) && ['invalid_password', 'incorrect_password', 'password_unchanged', 'rate_limited'].includes(data?.code) && typeof data.error === 'string') {
      tell(data.error); busy = false; sessionButtons.forEach(control => { control.disabled = false; }); othersButton.disabled = otherRows().length === 0; button.disabled = false; inputs.forEach(input => { input.disabled = false; }); button.textContent = 'Change password'; return;
    }
    if ([401, 403, 409].includes(response.status) && ['unauthenticated', 'invalid_account_form', 'account_changed'].includes(data?.code)) {
      finish(false); document.getElementById('outcome-message').textContent = 'Your sign-in or security form is no longer current. Sign in again before changing your password.'; return;
    }
    finish(false);
  } catch { finish(false); } finally { clearTimeout(timeout); }
});
button.disabled = false;
const sessionButtons = [...document.querySelectorAll('.session-revoke')];
const othersButton = document.getElementById('sign-out-others');
const sessionNotice = document.getElementById('session-notice');
const sessionNext = document.getElementById('session-next');
let changingSession = false;
const sessionControls = () => [...sessionButtons, othersButton];
const otherRows = () => [...document.querySelectorAll('.session-row')].filter(row => row.dataset.sessionId !== activeSession);
sessionButtons.forEach(control => { control.disabled = false; });
othersButton.disabled = otherRows().length === 0;
try {
  document.querySelectorAll('.sessions time').forEach(node => {
    node.textContent = new Date(node.dateTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  });
  document.getElementById('session-timezone').textContent = 'Times use ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '. Activity includes automatic workspace refreshes.';
} catch {}
function uncertainSession(message) {
  sessionNotice.textContent = message; sessionNotice.dataset.error = 'true'; sessionNext.hidden = false;
  sessionControls().forEach(control => { control.disabled = true; });
}
async function revokeSession(target) {
  if (changingSession || busy) return;
  changingSession = true; sessionNotice.textContent = ''; sessionControls().forEach(control => { control.disabled = true; });
  button.disabled = true;
  const action = target === 'others' ? 'revoke-other-sessions' : 'revoke-session';
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-atrium-account-action': action, 'x-atrium-user-id': identity, 'x-atrium-session-id': activeSession, 'x-atrium-csrf': csrfToken },
      body: JSON.stringify(target === 'others' ? { action } : { action, sessionId: target }) });
    const data = await response.json();
    if (response.status === 200 && data?.status === 'sessions_revoked' && data.userId === identity && data.actingSessionId === activeSession
      && typeof data.currentRevoked === 'boolean' && Array.isArray(data.revokedIds) && data.revokedIds.length <= 20 && new Set(data.revokedIds).size === data.revokedIds.length
      && data.revokedIds.every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
      && data.currentRevoked === data.revokedIds.includes(activeSession) && (target !== activeSession || data.currentRevoked)
      && (target === 'others' ? !data.currentRevoked : data.revokedIds.every(id => id === target))) {
      if (data.currentRevoked) {
        form.reset(); form.hidden = true; sessionNotice.textContent = 'This session is signed out. Sign in again to continue.';
        document.getElementById('session-list').hidden = true; sessionNext.hidden = false; return;
      }
      document.querySelectorAll('.session-row').forEach(row => { if (target === 'others' ? row.dataset.sessionId !== activeSession : row.dataset.sessionId === target) row.remove(); });
      sessionNotice.dataset.error = 'false'; sessionNotice.textContent = target === 'others' ? 'Other sessions signed out. Reload to check for newer sign-ins.' : 'The selected session is signed out.';
      sessionButtons.forEach(control => { control.disabled = false; }); othersButton.disabled = otherRows().length === 0;
      changingSession = false; button.disabled = false; return;
    }
    if ([401, 403, 409].includes(response.status)) {
      uncertainSession('Your sign-in or security form changed. Reload account security or sign in again before another action.'); return;
    }
    uncertainSession('We couldn’t confirm the session change. Reload account security to check which sessions are still signed in before trying again.');
  } catch {
    uncertainSession('We couldn’t confirm the session change. Reload account security to check which sessions are still signed in before trying again.');
  } finally { clearTimeout(timeout); }
}
sessionButtons.forEach(control => control.addEventListener('click', () => revokeSession(control.dataset.sessionId)));
othersButton.addEventListener('click', () => revokeSession('others'));
</script></body></html>`
}

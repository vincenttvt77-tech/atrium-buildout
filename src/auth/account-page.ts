import type { AuthenticatedUser } from './model.ts'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

/** Separate from property data: a user with no current building access still owns their identity. */
export function accountSecurityPage(principal: AuthenticatedUser, token: string, nonce: string): string {
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
@media(max-width:700px){header{padding:16px 20px}main{display:block;margin:30px auto;padding:0 20px}h1{font-size:30px}.identity{margin:20px 0 28px;padding-top:16px}.panel{padding:24px}header a{max-width:150px;text-align:right}}
</style></head><body><header><div class="brand">atrium<span>.</span></div><a href="/api/dashboard">Back to workspace</a></header>
<main><section><span class="eyebrow">YOUR ACCOUNT</span><h1>Account security</h1><p>Manage the password for your Atrium account.</p>
<p>Your account can belong to several properties and organizations. A password change applies everywhere you sign in.</p><div class="identity"><strong>${escapeHtml(principal.displayName)}</strong><span>${escapeHtml(principal.username)}</span></div></section>
<section class="panel" aria-labelledby="password-heading"><h2 id="password-heading">Change password</h2><p>Confirm your current password to choose a new one. You’ll then sign in again on each device.</p>
<form id="password-form" method="post" action="/api/account" data-user-id="${escapeHtml(principal.userId)}" data-form-token="${escapeHtml(token)}">
<input type="text" name="username" autocomplete="username" value="${escapeHtml(principal.username)}" hidden readonly>
<label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" maxlength="256" required>
<label for="new-password">New password</label><input id="new-password" name="newPassword" type="password" autocomplete="new-password" maxlength="256" aria-describedby="password-hint" required>
<p class="hint" id="password-hint">Use at least 15 characters. A long, unique phrase works well. Spaces are welcome.</p>
<label for="confirm-password">Confirm new password</label><input id="confirm-password" type="password" autocomplete="new-password" maxlength="256" required>
<button type="submit" id="save-password" disabled>Change password</button></form><p id="notice" role="status" aria-live="polite"></p>
<div id="outcome" class="outcome" hidden tabindex="-1"><h2 id="outcome-title"></h2><p id="outcome-message"></p><a href="/api/dashboard?reauthenticate=1">Sign in again</a></div>
<p class="footer">Use a password manager to keep your new password. Atrium will never display it after saving.</p><noscript>JavaScript is required to change your password securely.</noscript></section></main>
<script nonce="${nonce}">
const form = document.getElementById('password-form');
const notice = document.getElementById('notice');
const button = document.getElementById('save-password');
const identity = form.dataset.userId;
const csrfToken = form.dataset.formToken;
const inputs = ['current-password', 'new-password', 'confirm-password'].map(id => document.getElementById(id));
let busy = false;
function tell(message) { notice.textContent = message; notice.dataset.error = 'true'; }
function finish(confirmed) {
  form.reset(); form.hidden = true; notice.textContent = '';
  document.getElementById('outcome-title').textContent = confirmed ? 'Password changed' : 'Check your sign-in';
  document.getElementById('outcome-message').textContent = confirmed
    ? 'Your new password is saved. Previous sessions can no longer access your account. Sign in again to continue.'
    : 'We couldn’t confirm whether your password changed. Sign in with the new password first. If it doesn’t work, try your previous password. This form will not submit another change.';
  const outcome = document.getElementById('outcome'); outcome.hidden = false; outcome.focus();
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  if (Array.from(newPassword).length < 15) { tell('Use at least 15 characters for your new password.'); return; }
  if (newPassword !== document.getElementById('confirm-password').value) { tell('The new passwords don’t match.'); return; }
  if (newPassword === currentPassword) { tell('Choose a different password from your current one.'); return; }
  busy = true; button.disabled = true; inputs.forEach(input => { input.disabled = true; }); button.textContent = 'Saving…'; notice.textContent = '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/account', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-atrium-account-action': 'change-password', 'x-atrium-user-id': identity, 'x-atrium-csrf': csrfToken },
      body: JSON.stringify({ action: 'change-password', currentPassword, newPassword }) });
    const data = await response.json();
    if (response.status === 200 && data?.status === 'password_changed' && data.userId === identity) { finish(true); return; }
    if ([400, 429].includes(response.status) && ['invalid_password', 'incorrect_password', 'password_unchanged', 'rate_limited'].includes(data?.code) && typeof data.error === 'string') {
      tell(data.error); busy = false; button.disabled = false; inputs.forEach(input => { input.disabled = false; }); button.textContent = 'Change password'; return;
    }
    if ([401, 403, 409].includes(response.status) && ['unauthenticated', 'invalid_account_form', 'account_changed'].includes(data?.code)) {
      finish(false); document.getElementById('outcome-message').textContent = 'Your sign-in or security form is no longer current. Sign in again before changing your password.'; return;
    }
    finish(false);
  } catch { finish(false); } finally { clearTimeout(timeout); }
});
button.disabled = false;
</script></body></html>`
}

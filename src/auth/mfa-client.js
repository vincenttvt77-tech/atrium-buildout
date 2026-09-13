import { startRegistration, startAuthentication } from '@simplewebauthn/browser'

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const integer = value => Number.isSafeInteger(value) && value > 0
const record = value => !!value && typeof value === 'object' && !Array.isArray(value)
const text = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const purposeFlag = { session_login: 'sessionVerified', manage_factors: 'manageVerified', organization_administration: 'administratorVerified' }
const knownErrors = {
  incorrect_password: 'Your current password was not correct. Enter it again to continue.',
  invalid_input: 'Check the information you entered and start again.',
  verification_failed: 'The passkey could not be verified. Start a new verification.',
  challenge_used: 'That verification was already attempted. Start a new verification.',
  challenge_expired: 'That verification expired. Start a new verification.',
  mfa_required: 'Verify this session with an existing passkey before changing security settings.',
  reauthentication_required: 'Confirm your current password again before continuing.',
  last_factor: 'Add and verify another passkey before removing your last active passkey.',
  factor_limit: 'You have reached the passkey limit. Verify an existing key before removing an unused one.',
  rate_limited: 'Too many security attempts. Wait before trying again.',
  recovery_failed: 'The recovery code could not be accepted. Check it and start again.',
}
class Unconfirmed extends Error {}
class Rejected extends Error { constructor(code) { super(knownErrors[code]); this.code = code } }
function publicState(value) {
  if (!record(value) || !integer(value.securityVersion)
    || ['required', 'everEnabled', 'sessionVerified', 'manageVerified', 'administratorVerified'].some(key => typeof value[key] !== 'boolean')
    || !Number.isSafeInteger(value.recoveryRemaining) || value.recoveryRemaining < 0 || value.recoveryRemaining > 10
    || !Array.isArray(value.factors) || value.factors.length > 11
    || value.factors.filter(factor => factor?.status === 'active').length > 10) throw new Unconfirmed()
  const factors = value.factors.map(factor => {
    if (!record(factor) || !id(factor.id) || typeof factor.label !== 'string' || !factor.label.trim() || factor.label.length > 80
      || !['pending', 'active'].includes(factor.status) || !integer(factor.createdAt)
      || (factor.lastUsedAt !== null && !integer(factor.lastUsedAt))) throw new Unconfirmed()
    return { id: factor.id, label: factor.label, status: factor.status, createdAt: factor.createdAt, lastUsedAt: factor.lastUsedAt }
  })
  if (new Set(factors.map(factor => factor.id)).size !== factors.length) throw new Unconfirmed()
  return { securityVersion: value.securityVersion, required: value.required, everEnabled: value.everEnabled,
    sessionVerified: value.sessionVerified, manageVerified: value.manageVerified,
    administratorVerified: value.administratorVerified, recoveryRemaining: value.recoveryRemaining, factors }
}

/** Browser state is presentation only. Every request carries its rendered, immutable session binding. */
export function mountMfaClient() {
  const root = document.getElementById('mfa-root')
  const el = name => document.getElementById(name)
  const bootstrap = window.ATRIUM_MFA
  let state, binding
  let busy = false, locked = false, retired = false, stage = null, codesVisible = false
  const requests = new Set()
  const notice = (message, error = false) => { el('mfa-notice').textContent = message; el('mfa-notice').dataset.error = String(error) }
  const controls = () => root.querySelectorAll('button, input')
  const syncBusy = () => controls().forEach(control => {
    control.disabled = busy || locked || (codesVisible && control.dataset.action !== 'dismiss-codes')
  })
  const clearCodes = () => { el('mfa-codes').textContent = ''; el('mfa-recovery-codes').hidden = true; codesVisible = false }
  function freeze(message = 'We couldn’t confirm the security change. Reload passkeys to check your settings before trying again.') {
    locked = true; stage = null
    clearCodes()
    el('mfa-task').hidden = true; el('mfa-task-content').textContent = ''
    notice(message, true); el('mfa-next').hidden = false; syncBusy()
  }
  try {
    if (!record(bootstrap) || !id(bootstrap.userId) || !id(bootstrap.sessionId)
      || typeof bootstrap.formToken !== 'string' || !bootstrap.formToken) throw new Unconfirmed()
    binding = Object.freeze({ userId: bootstrap.userId, sessionId: bootstrap.sessionId, formToken: bootstrap.formToken })
    state = publicState(bootstrap.state)
  } catch { freeze('Your security settings could not be loaded. Reload this page or sign in again.'); return }

  const button = (action, label, extra = '', style = 'secondary') => `<button type="button" class="${style}" data-action="${action}" ${extra}>${label}</button>`
  const date = value => { try { return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) } catch { return 'Unknown date' } }
  function render() {
    const active = state.factors.filter(factor => factor.status === 'active')
    const pending = state.factors.filter(factor => factor.status === 'pending')
    const heading = state.sessionVerified ? 'This session is verified' : state.required ? 'Verify to continue' : active.length ? 'Passkey protection is set up' : 'Set up passkey protection'
    const summary = state.sessionVerified ? 'Your passkey was verified for this sign-in. Sensitive changes may need another verification.'
      : state.required ? 'This account requires passkey verification before privileged access. Complete setup or verify an existing passkey.'
        : active.length ? 'Verify this sign-in with your passkey when you need to continue or manage security.'
          : 'First confirm your password, create a passkey, then use it once to finish setup.'
    const actions = []
    if (active.length) {
      if (!state.sessionVerified) actions.push(button('verify-session', 'Verify this sign-in', '', ''))
      if (!state.manageVerified) actions.push(button('verify-management', 'Verify security changes'))
      if (state.required && !state.administratorVerified) actions.push(button('verify-administration', 'Verify administrator access'))
    }
    el('mfa-summary').innerHTML = `<h2>${heading}</h2><p>${summary}</p><div class="actions">${actions.join('')}${(!state.required || state.sessionVerified) ? '<a class="back-link" href="/api/dashboard">Continue to workspace</a>' : ''}</div>`
    el('mfa-factors').innerHTML = state.factors.length ? state.factors.map(factor => `<article class="factor"><div class="factor-head"><strong>${text(factor.label)}</strong><span class="badge">${factor.status === 'active' ? 'Active' : 'Setup unfinished'}</span></div><p class="hint">Added ${text(date(factor.createdAt))}${factor.lastUsedAt ? ` · Last used ${text(date(factor.lastUsedAt))}` : ''}</p>${factor.status === 'pending' ? '<p>Use this new passkey once to finish setup. Creating it on your device alone does not complete protection.</p>' : ''}<div class="actions">${factor.status === 'pending' ? button('activate', 'Complete setup', `data-factor-id="${text(factor.id)}"`, '') : ''}${state.manageVerified && (factor.status === 'pending' || active.length > 1) ? button('remove', 'Remove passkey', `data-factor-id="${text(factor.id)}"`, 'danger') : ''}</div></article>`).join('') : '<p class="empty">No passkeys are registered yet.</p>'
    el('mfa-actions').innerHTML = (!state.everEnabled || state.manageVerified) ? button('add', pending.length ? 'Create another passkey' : active.length ? 'Add a passkey' : 'Set up a passkey', '', '') : ''
    el('mfa-recovery').innerHTML = `<h2>Recovery</h2><p>${state.everEnabled ? `${state.recoveryRemaining} unused recovery code${state.recoveryRemaining === 1 ? '' : 's'} remain.` : 'After setup, save recovery codes and add a spare passkey so you can regain access if a device is lost.'}</p><div class="actions">${active.length && state.manageVerified ? button('rotate', state.recoveryRemaining ? 'Replace recovery codes' : 'Create recovery codes') : ''}${state.everEnabled ? button('recover', 'Use a recovery code') : ''}</div><p class="hint">A recovery code and your password authorize a replacement passkey. They do not by themselves verify this session. Your existing passkeys remain until the replacement is verified.</p>`
    syncBusy()
  }
  function task(html, nextStage) {
    stage = nextStage
    el('mfa-task-content').innerHTML = html
    el('mfa-task').hidden = false
    el('mfa-task').focus()
    syncBusy()
  }
  function endTask() { stage = null; el('mfa-task').hidden = true; el('mfa-task-content').textContent = '' }
  const field = (name, label, type = 'text', extras = '') => `<label for="${name}">${label}</label><input id="${name}" type="${type}" ${extras} required>`
  function passwordTask(kind, factorId = null) {
    const selected = state.factors.find(factor => factor.id === factorId)
    const titles = { add: 'Add a passkey', remove: 'Remove this passkey?', rotate: 'Create recovery codes', recover: 'Recover passkey access' }
    const help = kind === 'remove' ? `You’re removing ${text(selected?.label ?? 'this passkey')} from your Atrium account. It will no longer verify access.`
      : kind === 'rotate' ? 'New codes replace every previous recovery code. They will be shown once after saving.'
        : kind === 'recover' ? 'Enter your password and one unused recovery code. Then create and verify a replacement passkey.'
          : 'Confirm your password, then choose a recognizable name for this passkey. You’ll create it in a separate device prompt.'
    task(`<p class="step">Confirm it’s you</p><h2>${titles[kind]}</h2><p>${help}</p><form id="mfa-action-form" method="post" action="/api/mfa">${kind === 'add' ? field('mfa-label', 'Passkey name', 'text', 'maxlength="80" autocomplete="off" placeholder="For example, personal phone"') : ''}${field('mfa-password', 'Current password', 'password', 'maxlength="256" autocomplete="current-password"')}${kind === 'recover' ? field('mfa-recovery-code', 'Recovery code', 'text', 'maxlength="256" autocomplete="off" autocapitalize="none" spellcheck="false"') : ''}<div class="actions"><button type="submit">${kind === 'remove' ? 'Confirm removal' : kind === 'rotate' ? 'Create new recovery codes' : 'Continue'}</button>${button('cancel', 'Cancel')}</div></form>`, { kind, factorId })
  }
  async function api(action, payload, validate) {
    if (retired) throw new Unconfirmed()
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000)
    requests.add(controller)
    try {
      const response = await fetch('/api/mfa', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-atrium-account-action': action, 'x-atrium-user-id': binding.userId,
          'x-atrium-session-id': binding.sessionId, 'x-atrium-csrf': binding.formToken },
        body: JSON.stringify({ action, ...payload }) })
      const data = await response.json()
      if (retired) throw new Unconfirmed()
      if (response.status !== 200) {
        if ([400, 403, 409, 429].includes(response.status) && Object.hasOwn(knownErrors, data?.code)) throw new Rejected(data.code)
        throw new Unconfirmed()
      }
      if (!record(data) || data.ok !== true || data.userId !== binding.userId || data.sessionId !== binding.sessionId || data.action !== action) throw new Unconfirmed()
      const next = publicState(data.state)
      if (next.securityVersion < state.securityVersion || !validate(data, next)) throw new Unconfirmed()
      state = next
      return data
    } finally { clearTimeout(timeout); requests.delete(controller) }
  }
  function optionsValid(data, kind) {
    return id(data.challengeId) && integer(data.expiresAt) && data.expiresAt > Date.now()
      && record(data.optionsJSON) && typeof data.optionsJSON.challenge === 'string' && data.optionsJSON.challenge.length >= 16
      && (kind === 'registration' ? record(data.optionsJSON.rp) && typeof data.optionsJSON.rp.id === 'string'
        && record(data.optionsJSON.user) && typeof data.optionsJSON.user.id === 'string' : typeof data.optionsJSON.rpId === 'string')
  }
  function prepareBrowser(kind, data, purpose = null, factorId = null) {
    const registration = kind === 'registration'
    task(`<p class="step">${registration ? 'Create on your device' : 'Use your passkey'}</p><h2>${registration ? 'Ready to create your passkey' : 'Ready to verify'}</h2><p>${registration ? 'Your browser will ask where to save the passkey. After creation, you’ll use it once more to finish setup.' : 'Use your device’s screen lock or security key. Only a confirmed verification will complete this step.'}</p><div class="actions">${button('ceremony', registration ? 'Create passkey on this device' : 'Open passkey prompt', '', '')}${button('cancel', 'Cancel')}</div>`, { kind: 'ceremony', ceremony: kind, challengeId: data.challengeId, optionsJSON: data.optionsJSON, expiresAt: data.expiresAt, purpose, factorId })
  }
  async function authentication(purpose, factorId = null) {
    const data = await api('authentication-options', { purpose, factorId }, value => optionsValid(value, 'authentication'))
    prepareBrowser('authentication', data, purpose, factorId)
  }
  async function registration(label, reauthenticationId, recoveryGrantId = null) {
    const data = await api('registration-options', { label, reauthenticationId, recoveryGrantId }, value => optionsValid(value, 'registration'))
    prepareBrowser('registration', data)
  }
  async function executePassword() {
    const current = stage
    if (!current || !['add', 'remove', 'rotate', 'recover'].includes(current.kind)) return
    const password = el('mfa-password').value
    const label = current.kind === 'add' ? el('mfa-label').value.trim() : null
    const code = current.kind === 'recover' ? el('mfa-recovery-code').value.trim() : null
    if (!password || (current.kind === 'add' && !label) || (current.kind === 'recover' && !code)) {
      notice('Complete the required fields to continue.', true); return
    }
    el('mfa-password').value = ''
    if (current.kind === 'recover') el('mfa-recovery-code').value = ''
    const confirmed = await api('password', { password }, value => id(value.reauthenticationId) && integer(value.expiresAt) && value.expiresAt > Date.now())
    const reauthenticationId = confirmed.reauthenticationId
    if (current.kind === 'add') { await registration(label, reauthenticationId); return }
    const requestId = crypto.randomUUID(), expectedSecurityVersion = state.securityVersion
    const common = { expectedSecurityVersion, reauthenticationId, requestId }
    if (current.kind === 'remove') {
      await api('remove-factor', { ...common, factorId: current.factorId }, (value, next) => value.factorId === current.factorId && value.requestId === requestId
        && next.securityVersion > expectedSecurityVersion && !next.factors.some(factor => factor.id === current.factorId))
      endTask(); render(); notice('The passkey was removed from your account.'); return
    }
    if (current.kind === 'rotate') {
      const data = await api('rotate-recovery', common, (value, next) => value.requestId === requestId
        && Array.isArray(value.codes) && value.codes.length === 10
        && value.codes.every(code => typeof code === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/.test(code))
        && new Set(value.codes).size === value.codes.length && next.recoveryRemaining === value.codes.length)
      endTask(); render(); codesVisible = true
      el('mfa-codes').textContent = data.codes.join('\n'); data.codes.length = 0
      el('mfa-recovery-codes').hidden = false; el('mfa-recovery-codes').focus()
      notice('New recovery codes were saved. Store them before leaving this page.'); return
    }
    const data = await api('recover', { ...common, code }, value => value.requestId === requestId && id(value.recoveryGrantId))
    task(`<p class="step">Recovery accepted</p><h2>Create your replacement passkey</h2><p>Your existing passkeys have not been removed. Complete the new passkey and its verification to finish recovery.</p><form id="mfa-action-form" method="post" action="/api/mfa">${field('mfa-label', 'Replacement passkey name', 'text', 'maxlength="80" autocomplete="off"')}<div class="actions"><button type="submit">Continue to device setup</button>${button('cancel', 'Cancel')}</div></form>`,
      { kind: 'replacement', reauthenticationId, recoveryGrantId: data.recoveryGrantId })
    notice('The recovery code was accepted for replacement setup. This session is not yet verified.')
  }
  async function ceremony() {
    const current = stage
    if (!current || current.kind !== 'ceremony') return
    if (Date.now() >= current.expiresAt) throw new Rejected('challenge_expired')
    let response
    try {
      response = current.ceremony === 'registration'
        ? await startRegistration({ optionsJSON: current.optionsJSON })
        : await startAuthentication({ optionsJSON: current.optionsJSON })
    } catch (error) {
      if (retired) return
      endTask(); render()
      notice(error?.name === 'NotAllowedError' || error?.code === 'ERROR_CEREMONY_ABORTED'
        ? 'The passkey prompt was closed or timed out. No setup or verification was confirmed. Start again when ready.'
        : 'The passkey prompt could not finish. No setup or verification was confirmed. Try a supported browser or security key.', true)
      return
    }
    if (retired) return
    const action = `${current.ceremony}-finish`
    const data = await api(action, { challengeId: current.challengeId, response }, (value, next) => {
      const receipt = value.receipt
      if (!record(receipt) || receipt.challengeId !== current.challengeId || receipt.securityVersion !== next.securityVersion || !id(receipt.factorId)) return false
      const factor = next.factors.find(factor => factor.id === receipt.factorId)
      if (current.ceremony === 'registration') return receipt.outcome === 'factor_pending' && receipt.assurance === null && factor?.status === 'pending'
      const proof = receipt.assurance
      return receipt.outcome === 'verified' && factor?.status === 'active' && (!current.factorId || receipt.factorId === current.factorId)
        && record(proof) && id(proof.id) && proof.userId === binding.userId && proof.sessionId === binding.sessionId
        && proof.factorId === receipt.factorId && proof.securityVersion === next.securityVersion && proof.purpose === current.purpose
        && integer(proof.verifiedAt) && proof.verifiedAt <= Date.now() + 5000 && integer(proof.expiresAt) && proof.expiresAt > Date.now()
        && next[purposeFlag[current.purpose]] === true
    })
    endTask(); render()
    if (current.ceremony === 'registration') {
      task(`<p class="step">One more step</p><h2>Verify your new passkey</h2><p>The passkey is saved but setup is unfinished. Use this same key once to activate it.</p><div class="actions">${button('activate', 'Verify new passkey', `data-factor-id="${text(data.receipt.factorId)}"`, '')}</div>`, { kind: 'activation', factorId: data.receipt.factorId })
      notice('Passkey saved. Complete its verification to finish setup.')
    } else notice(current.purpose === 'manage_factors' ? 'This session is verified for security changes.'
      : current.purpose === 'organization_administration' ? 'This session is verified for administrator actions. Your organization permissions still apply.'
        : 'Your passkey was verified for this sign-in.')
  }
  async function run(work) {
    if (busy || locked || codesVisible) return
    busy = true; notice(''); syncBusy()
    try { await work() } catch (error) {
      if (retired) return
      if (error instanceof Rejected) {
        if (error.code === 'mfa_required') state = { ...state, sessionVerified: false, manageVerified: false, administratorVerified: false }
        endTask(); render(); notice(error.message, true)
      } else freeze()
    } finally { busy = false; syncBusy() }
  }
  root.addEventListener('click', event => {
    const control = event.target.closest('button[data-action]')
    if (!control || !root.contains(control) || control.disabled) return
    const action = control.dataset.action
    if (action === 'dismiss-codes') { clearCodes(); notice('Recovery codes hidden. Keep your saved copy secure.'); syncBusy(); return }
    if (busy || locked || codesVisible) return
    if (action === 'cancel') { endTask(); notice('This step was closed. Any already saved passkey or recovery step remains recorded.'); return }
    if (['add', 'remove', 'rotate', 'recover'].includes(action)) {
      if (action === 'remove' && !state.factors.some(factor => factor.id === control.dataset.factorId)) return
      passwordTask(action, control.dataset.factorId ?? null); return
    }
    if (action === 'ceremony') return run(ceremony)
    if (action === 'activate') {
      const factor = state.factors.find(factor => factor.id === control.dataset.factorId && factor.status === 'pending')
      if (factor) return run(() => authentication('session_login', factor.id))
      return
    }
    const purpose = { 'verify-session': 'session_login', 'verify-management': 'manage_factors', 'verify-administration': 'organization_administration' }[action]
    if (purpose) return run(() => authentication(purpose))
  })
  root.addEventListener('submit', event => {
    if (event.target.id !== 'mfa-action-form') return
    event.preventDefault()
    return run(async () => {
      if (stage?.kind === 'replacement') {
        const label = el('mfa-label').value.trim()
        if (!label) { notice('Give your replacement passkey a name.', true); return }
        await registration(label, stage.reauthenticationId, stage.recoveryGrantId)
      } else await executePassword()
    })
  })
  window.addEventListener('pagehide', () => {
    retired = true
    for (const controller of requests) controller.abort()
    freeze('Reload passkeys to confirm the current security settings before continuing.')
  })
  render()
}

if (typeof window !== 'undefined' && window.ATRIUM_MFA) mountMfaClient()

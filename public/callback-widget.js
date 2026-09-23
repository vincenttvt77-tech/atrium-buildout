/* Embeddable, explicitly configured property callback form. No browser provider keys. */
(function () {
  'use strict'
  const scriptUrl = document.currentScript?.src
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  let challengeScript
  function loadChallenge() {
    if (window.turnstile) return Promise.resolve()
    if (!challengeScript) challengeScript = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.onload = resolve; script.onerror = reject; document.head.append(script)
    })
    return challengeScript
  }
  for (const root of document.querySelectorAll('[data-atrium-callback]')) {
    const widgetId = root.dataset.widgetId
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(widgetId || '')) continue
    const endpoint = new URL('/api/website-callbacks', scriptUrl || location.href)
    endpoint.searchParams.set('widgetId', widgetId)
    const storageKey = 'atrium-callback:' + endpoint.origin + ':' + widgetId
    let config, busy = false, challengeId, challengeToken = '', receipt, timer
    const stored = () => { try { return JSON.parse(sessionStorage.getItem(storageKey)) } catch { return null } }
    const save = value => { try { sessionStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* In-memory receipt remains usable. */ } }
    const post = async body => {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(16000) })
      const result = await response.json()
      if (!response.ok) throw Object.assign(new Error(result.error || 'The request could not be checked.'), { status: response.status, code: result.code })
      return result
    }
    root.classList.add('atrium-callback')
    root.innerHTML = '<p class="ac-eyebrow">A CONVERSATION, ON YOUR TIME</p><h3>Let leasing call you.</h3><p class="ac-message" role="status" aria-live="polite">Checking callback availability…</p><div class="ac-content"></div>'
    const message = text => { root.querySelector('.ac-message').textContent = text }
    const content = root.querySelector('.ac-content')
    function showStatus(result) {
      if (typeof result?.message !== 'string' || !['saved','checking','requested','scheduled','queued','ringing','in-progress','forwarding','ended','needs_review','cancelled'].includes(result.stage)) throw new Error('The saved status could not be read.')
      message(result.message)
      content.innerHTML = `<p class="ac-stamp">Last checked ${escape(new Date(result.observedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}. A request is not a confirmed tour.</p><button type="button" class="ac-button ac-check">Check this request</button>`
      content.querySelector('button').addEventListener('click', check)
      clearTimeout(timer)
      if (receipt && Date.now() - receipt.savedAt < 90000 && !['ended','needs_review','cancelled'].includes(result.stage)) timer = setTimeout(check, 6000)
    }
    async function check() {
      if (busy || !receipt) return
      busy = true; const button = content.querySelector('button'); if (button) button.disabled = true
      try { showStatus(await post({ action: 'status', requestId: receipt.requestId, receiptToken: receipt.receiptToken })) }
      catch (error) {
        message(error.status === 404 ? 'No saved request could be found yet. Please check again or call leasing directly.'
          : 'Your last request is still unconfirmed. Check it again or call leasing directly; do not submit another request.')
        content.innerHTML = '<button type="button" class="ac-button ac-check">Check this request</button>'
        content.querySelector('button').addEventListener('click', check)
      } finally { busy = false; const button = content.querySelector('button'); if (button) button.disabled = false }
    }
    function hoursText(hours, zone) {
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
      const time = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
      return hours.map(h => `${days[h.day]} ${time(h.start)}–${time(h.end)}`).join(' · ') + ` (${zone})`
    }
    async function start() {
      try {
        config = await post({ action: 'bootstrap' })
        if (typeof config.consent !== 'string' || !/^[a-f0-9]{64}$/.test(config.policySha256) || !Array.isArray(config.hours)) throw new Error('Invalid form')
        const prior = stored()
        if (prior && Number.isFinite(prior.savedAt) && Date.now() - prior.savedAt >= 0 && Date.now() - prior.savedAt < 86400000 && /^[a-f0-9-]{36}$/.test(prior.requestId) && /^[a-f0-9]{64}$/.test(prior.receiptToken)) {
          receipt = prior; message('Checking your existing request…'); await check(); return
        }
        if (!config.open) { message('Callbacks are closed right now. You can still use the building’s published contact number.'); content.textContent = hoursText(config.hours, config.timeZone); return }
        message('Request one call from our AI leasing assistant. We aim to start the call within about 15 seconds when the calling service is ready.')
        content.innerHTML = `<form class="ac-form"><label>Your name<input name="name" autocomplete="given-name" maxlength="80" required></label><label>Phone number<input name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+1 (555) 234-5678" required></label><label class="ac-consent"><input name="consent" type="checkbox" required><span>${escape(config.consent)}</span></label><div class="ac-challenge"></div><button class="ac-button" type="submit" disabled>Call me</button><details><summary>Callback hours</summary><p>${escape(hoursText(config.hours, config.timeZone))}</p></details></form>`
        const form = content.querySelector('form'), button = form.querySelector('button')
        form.addEventListener('submit', async event => {
          event.preventDefault()
          if (busy || !challengeToken || !form.reportValidity()) return
          let phone = form.elements.phone.value.trim().replace(/[\s().-]/g, '')
          if (/^\d{10}$/.test(phone)) phone = '+1' + phone
          else if (/^1\d{10}$/.test(phone)) phone = '+' + phone
          if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(phone)) { message('Please enter a valid +1 phone number.'); form.elements.phone.focus(); return }
          busy = true; button.disabled = true
          const bytes = crypto.getRandomValues(new Uint8Array(32))
          receipt = { requestId: crypto.randomUUID(), receiptToken: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), savedAt: Date.now() }
          save(receipt); message('Saving your permission and requesting your call…')
          try {
            const result = await post({ action: 'request', challengeToken, request: { requestId: receipt.requestId, receiptToken: receipt.receiptToken,
              name: form.elements.name.value.trim(), phone, consent: form.elements.consent.checked, policySha256: config.policySha256 } })
            showStatus(result)
          } catch (error) {
            // A transport failure can happen after persistence or dialing. Keep the
            // same opaque receipt across reloads; never automatically redial.
            if (['callback_invalid_input','callback_challenge_failed','callback_closed','callback_limited','callback_unavailable'].includes(error.code)) {
              receipt = null; try { sessionStorage.removeItem(storageKey) } catch {}
              message(error.message); challengeToken = ''; window.turnstile?.reset(challengeId)
            } else {
              message('Your request may have been saved. Check this request before doing anything else.')
              content.innerHTML = '<button type="button" class="ac-button ac-check">Check this request</button>'
              content.querySelector('button').addEventListener('click', check)
            }
          } finally { busy = false; if (button.isConnected) button.disabled = !challengeToken; const checkButton = content.querySelector('.ac-check'); if (checkButton) checkButton.disabled = false }
        })
        await loadChallenge()
        challengeId = window.turnstile.render(form.querySelector('.ac-challenge'), { sitekey: config.siteKey, action: 'atrium-callback', cData: widgetId, size: 'flexible',
          callback: token => { challengeToken = token; button.disabled = busy }, 'expired-callback': () => { challengeToken = ''; button.disabled = true },
          'error-callback': () => { challengeToken = ''; button.disabled = true; message('Verification is unavailable. Please call leasing directly.'); return true } })
      } catch { message('Online callbacks are unavailable. Please use the building’s published contact number.'); content.textContent = '' }
    }
    start()
    window.addEventListener('pagehide', () => clearTimeout(timer), { once: true })
  }
})()

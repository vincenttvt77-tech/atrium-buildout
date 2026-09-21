/** Bounded, unauthenticated observations only. Never logs response bodies or credentials. */
export const READINESS_PATHS = Object.freeze(['/', '/api/health', '/api/dashboard', '/api/vapi', '/api/calendar', '/api/leads'])
export const UNVERIFIED = Object.freeze([
  'Authenticated sign-in and property isolation',
  'Authenticated dashboard data and browser interactions',
  'Vapi credit, published assistant and webhook credential equality',
  'Live tool execution, phone audio and response latency',
  'Booking, rescheduling, notifications and other writes',
  'Future uptime and deployment commit identity',
])

export function validateOrigin(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f\\@?#]/u.test(value) || !/^https:\/\/[^/]+\/?$/i.test(value)) {
    throw new Error('Supply an HTTPS origin without credentials, path, query or fragment.')
  }
  let url
  try { url = new URL(value) } catch { throw new Error('Supply a valid HTTPS origin.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Supply an HTTPS origin without credentials, path, query or fragment.')
  }
  return url.origin
}

class ProbeError extends Error {
  constructor(code) { super(code); this.code = code }
}

async function boundedText(response, signal, limit) {
  const reader = response.body?.getReader()
  if (!reader) throw new ProbeError('missing_body')
  const chunks = [], decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new ProbeError('timeout')
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > limit) throw new ProbeError('response_too_large')
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    // Cancellation must not itself prolong the deadline if a transport is stalled.
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

async function probe(origin, path, fetchImpl, timeoutMs) {
  const controller = new AbortController(), started = performance.now()
  let timer, httpStatus = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ProbeError('timeout')) }, timeoutMs)
  })
  const request = (async () => {
    const response = await fetchImpl(new URL(path, origin), {
      method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { accept: path === '/' || path === '/api/dashboard' ? 'text/html' : 'application/json', 'cache-control': 'no-store' },
    })
    httpStatus = response.status
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {})
      throw new ProbeError('timeout')
    }
    if (response.redirected || (httpStatus >= 300 && httpStatus < 400)) {
      void response.body?.cancel().catch(() => {})
      throw new ProbeError('redirect_refused')
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const body = await boundedText(response, controller.signal, path === '/' || path === '/api/dashboard' ? 1024 * 1024 : 64 * 1024)
    return { path, httpStatus, contentType, body }
  })()
  try {
    return { ...await Promise.race([request, deadline]), elapsedMs: Math.round(performance.now() - started) }
  } catch (error) {
    controller.abort()
    return { path, httpStatus, elapsedMs: Math.round(performance.now() - started),
      error: error instanceof ProbeError ? error.code : 'request_failed' }
  } finally { clearTimeout(timer) }
}

function objectBody(read) {
  if (read.contentType !== 'application/json') return null
  try {
    const body = JSON.parse(read.body)
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch { return null }
}

function attributes(tag, name) {
  let rest = tag.replace(new RegExp(`^<${name}\\b`, 'i'), '').slice(0, -1)
  const result = new Map()
  while (rest.trim() && rest.trim() !== '/') {
    const match = rest.match(/^\s+([a-z_:][a-z\d_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i)
    if (!match) return null
    const key = match[1].toLowerCase()
    if (result.has(key)) return null
    result.set(key, match[2] ?? match[3] ?? match[4] ?? '')
    rest = rest.slice(match[0].length)
  }
  return result
}

function loginForm(html) {
  // This is a conservative marker check for the generated sign-in page, not a DOM audit.
  // Discard inert/raw-text regions before looking for real tag attributes. Greedy removal
  // can reject a changed template for browser review, rather than accepting hidden markup.
  html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|template|textarea|title|xmp|iframe|noscript)\b[^>]*>[\s\S]*<\/\1\s*>/gi, '')
    .replace(/<(script|style|template|textarea|title|xmp|iframe|noscript)\b[^>]*>[\s\S]*$/gi, '')
  for (const [form] of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi)) {
    const fields = attributes(form.slice(0, form.indexOf('>') + 1), 'form')
    if (fields?.get('method')?.toLowerCase() !== 'post' || fields.get('action') !== '/api/dashboard') continue
    for (const [input] of form.matchAll(/<input\b[^>]*>/gi)) {
      const field = attributes(input, 'input')
      if (field?.get('type')?.toLowerCase() === 'password' && ['password', 'passcode'].includes(field.get('name'))) return true
    }
  }
  return false
}

function authRefusal(body) {
  if (!body || Object.keys(body).some(key => !['error', 'code'].includes(key))) return false
  return (body.error === 'unauthorized' && body.code === undefined)
    || (body.error === 'Authentication is required.' && body.code === 'unauthenticated')
}

export async function checkDemoReadiness({ origin, expectedContract, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  origin = validateOrigin(origin)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Timeout must be an integer from 100 to 30000 milliseconds.')
  if (!expectedContract || expectedContract.version !== 1 || !/^[a-f0-9]{64}$/.test(expectedContract.toolSchemaSha256)) {
    throw new Error('A valid locally sourced voice contract is required.')
  }
  const startedAt = new Date().toISOString()
  const reads = await Promise.all(READINESS_PATHS.map(path => probe(origin, path, fetchImpl, timeoutMs)))
  const checks = []
  const add = (read, id, status, code, detail) => checks.push({ id, path: read.path, status, code, detail,
    httpStatus: read.httpStatus, elapsedMs: read.elapsedMs })
  for (const read of reads) {
    const id = read.path === '/' ? 'website' : read.path === '/api/health' ? 'backend' : read.path === '/api/dashboard' ? 'sign_in_page' : `access_${read.path.slice(5)}`
    if (read.error) { add(read, id, 'fail', read.error, 'The bounded request did not return a verifiable response.'); continue }
    if (read.path === '/') {
      const good = read.httpStatus === 200 && read.contentType === 'text/html' && /<html\b/i.test(read.body) && /<body\b/i.test(read.body)
      add(read, id, good ? 'pass' : 'fail', good ? 'html_served' : 'website_response_invalid',
        good ? 'Public HTML is served. Rendering and assets need browser acceptance.' : 'The public page did not return the expected HTML response.')
    } else if (read.path === '/api/health') {
      const body = objectBody(read)
      const good = read.httpStatus === 200 && body?.ok === true && body.durable === true && ['kv', 'postgres'].includes(body.store)
      add(read, 'storage', good ? 'pass' : 'fail', good ? 'persistent_storage_reported' : 'storage_unverified',
        good ? 'Health reports a connected persistent store.' : 'A healthy persistent store was not verified.')
      const contract = body?.voiceContract
      const matches = good && contract?.version === expectedContract.version && contract?.toolSchemaSha256 === expectedContract.toolSchemaSha256
      add(read, 'backend_tool_contract', matches ? 'pass' : 'fail', matches ? 'contract_matches_source' : 'contract_unverified',
        matches ? 'Backend tool contract matches this checkout. The saved assistant was not inspected.' : 'Backend tool contract could not be matched to this checkout.')
      const historyKnown = good && typeof body.callHistory === 'boolean'
      add(read, 'history_configuration', historyKnown && body.callHistory ? 'pass' : 'warn',
        historyKnown ? body.callHistory ? 'key_presence_reported' : 'global_history_not_reported' : 'history_configuration_unknown',
        historyKnown && body.callHistory ? 'Health reports a history key is configured; provider authentication was not tested.'
          : 'Global call-history configuration is unverified. PostgreSQL uses separate property configuration; inspect authorized history.')
    } else if (read.path === '/api/dashboard') {
      const good = read.httpStatus === 401 && read.contentType === 'text/html' && loginForm(read.body)
      add(read, id, good ? 'pass' : 'fail', good ? 'sign_in_required' : 'sign_in_page_unverified',
        good ? 'Unauthenticated access returns the expected sign-in form. No login was attempted.' : 'The expected protected sign-in form was not verified.')
    } else {
      const good = read.httpStatus === 401 && authRefusal(objectBody(read))
      add(read, id, good ? 'pass' : 'fail', good ? 'unauthenticated_request_refused' : 'access_gate_unverified',
        good ? 'The application refuses this unauthenticated request.' : 'Expected application JSON refusal was not verified. Inspect access and deployment protection.')
    }
  }
  return { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(), origin,
    status: checks.some(check => check.status === 'fail') ? 'read_only_checks_failed'
      : checks.some(check => check.status === 'warn') ? 'read_only_checks_need_attention' : 'read_only_checks_passed',
    scope: 'Unauthenticated HTTP preflight only; not full demo, phone, security or future-uptime acceptance.',
    checks, unverified: [...UNVERIFIED] }
}

export function parseReadinessArgs(args) {
  const values = new Map()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--origin', '--timeout-ms', '--json', '--help'].includes(key) || values.has(key)) throw new Error('Unknown or duplicate option. Use --help.')
    if (key === '--json' || key === '--help') values.set(key, true)
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error('An option value is missing. Use --help.')
      values.set(key, value)
    }
  }
  if (values.has('--help')) {
    if (values.size !== 1) throw new Error('Use --help by itself.')
    return { help: true }
  }
  const origin = validateOrigin(values.get('--origin'))
  const timeoutValue = values.get('--timeout-ms') || '10000'
  if (!/^\d+$/.test(timeoutValue) || Number(timeoutValue) < 100 || Number(timeoutValue) > 30000) throw new Error('Timeout must be an integer from 100 to 30000 milliseconds.')
  return { origin, timeoutMs: Number(timeoutValue), json: values.has('--json') }
}

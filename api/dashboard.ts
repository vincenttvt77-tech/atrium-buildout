import page from '../ops/dashboard.page.json' with { type: 'json' }
import { randomUUID } from 'node:crypto'
import {
  authorizeOps, clearedSessionCookie, constantTimeEquals, isSecureRequest, mintSession,
  mintAccountSession, opsPasscode, sessionCookie, SESSION_TTL_MS,
} from '../src/ops/session.ts'
import type { OpsAuth } from '../src/ops/session.ts'
import { authenticateAccount, readAccountsConfig } from '../src/ops/accounts.ts'
import { propertyTimeZone } from '../src/config/property.ts'
import { AuthorizationError, mintUserSession } from '../src/auth/index.ts'
import type { AuthenticatedUser, AuthorizedProperty, AuthorizedScope } from '../src/auth/index.ts'
import { assertPropertySnapshot, PropertyConfigurationError } from '../src/properties/index.ts'
import type { PropertySnapshot } from '../src/properties/index.ts'
import { validId } from '../src/auth/validation.ts'
import { runtimeForRequest, isPostgresRuntime, readRuntimeError } from '../src/application/runtime.ts'

/**
 * Serves the operations dashboard, behind a passcode.
 *
 * The page used to sit in `public/` as `/dashboard.html`, which on this project means the
 * deployment root: no authentication, and a five-second poll of a log containing prospect
 * names, email addresses, budget ceilings and verbatim call excerpts. Anyone who guessed
 * the URL read the entire leasing pipeline, which is a NY SHIELD Act reasonable-safeguards
 * failure and a straight contradiction of the privacy notice on the website.
 *
 * So the page is no longer a static file. It is compiled into this function
 * (`ops/dashboard.html` → `ops/dashboard.page.json`, see `npm run build:ops`) and handed
 * out only after this handler is satisfied. `api/vapi.ts` applies the same check to the log
 * itself, because moving the page without gating the data would only have moved the sign.
 */

const HTML_HEADERS: Array<[string, string]> = [
  ['content-type', 'text/html; charset=utf-8'],
  ['cache-control', 'no-store, no-cache, must-revalidate, private'],
  ['x-robots-tag', 'noindex, nofollow, noarchive, nosnippet'],
  ['referrer-policy', 'no-referrer'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['content-security-policy',
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'"],
]

function send(res: any, status: number, html: string, cookie?: string) {
  for (const [k, v] of HTML_HEADERS) res.setHeader(k, v)
  if (cookie) res.setHeader('set-cookie', cookie)
  res.status(status).send(html)
}

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  :root{color-scheme:light;--ink:#14233e;--paper:#f3f6fb;--panel:#fff;--line:#dce4f0;--muted:#596a83;--accent:#245cd4;--danger:#b33143}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#102443;color:var(--ink);font:16px/1.55 Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:40px;box-shadow:0 24px 80px #06152d55}
  .wordmark{font-size:32px;font-weight:650;letter-spacing:-.065em;color:#102443;margin-bottom:36px}.wordmark span{color:#245cd4}
  h1{font-size:26px;font-weight:600;letter-spacing:-.035em;margin:0 0 10px}
  p{color:var(--muted);font-size:15px;margin:0 0 28px}
  label{display:block;font-size:14px;font-weight:500;color:var(--ink);margin-bottom:8px}
  input{width:100%;font:inherit;padding:12px 14px;border:1px solid #a8b8ce;border-radius:8px;background:#fff;color:var(--ink)}
  input:focus{outline:3px solid #c5d9ff;border-color:var(--accent);outline-offset:1px}
  button{width:100%;margin-top:20px;font:inherit;font-weight:600;padding:12px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
  button:hover{background:#1848af}button:focus-visible{outline:3px solid #91b8ff;outline-offset:3px}
  .err{color:var(--danger);font-size:14px;margin:0 0 18px}
  .login-foot{font-size:13px;margin:24px 0 0;padding-top:20px;border-top:1px solid var(--line)}
  a{color:var(--accent)}code{font:13px ui-monospace,monospace;background:#edf2f9;padding:2px 5px;border-radius:4px}
  @media(max-width:480px){.card{padding:28px}body{padding:18px}}
</style>
</head>
<body><main class="card"><div class="wordmark">atrium<span>.</span></div>${body}</main></body>
</html>
`

const loginPage = (failed: boolean, accountMode: boolean, action = '/api/dashboard') => shell('Sign in — Atrium Operations', `
  <h1>Welcome back.</h1>
  <p>Sign in to manage your leasing workspace.</p>
  ${failed ? `<p class="err" role="alert">${accountMode ? 'The username or password was not right.' : 'That passcode was not right.'} Please try again.</p>` : ''}
  <form method="post" action="${escapeHtml(action)}">
    ${accountMode ? `<label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none"
           spellcheck="false" maxlength="64" autofocus required style="margin-bottom:20px">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required>` : `
    <label for="passcode">Operations passcode</label>
    <input id="passcode" name="passcode" type="password" autocomplete="current-password"
           autofocus required>`}
    <button type="submit">Sign in to workspace</button>
  </form>
  <p class="login-foot">Staff access only. Prospect details and conversations are private.</p>
`)

const notConfiguredPage = () => shell('Not configured — Atrium Operations', `
  <h1>Sign-in is unavailable</h1>
  <p>The workspace account settings are missing or need attention. Contact your Atrium administrator to restore access.</p>
`)

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

export function propertyDashboardUrl(organizationId: string, propertyId: string): string {
  return `/api/dashboard?${new URLSearchParams({ organizationId, propertyId })}`
}

function propertyPicker(principal: AuthenticatedUser, properties: readonly AuthorizedProperty[]): string {
  return shell('Choose a property — Atrium Operations', `
    <h1>Choose a property.</h1>
    <p>Signed in as ${escapeHtml(principal.displayName)}. Each property opens in its own workspace.</p>
    ${properties.length ? `<nav aria-label="Your properties">${properties.map(property => `
      <a href="${escapeHtml(propertyDashboardUrl(property.organizationId, property.id))}" style="display:block;padding:16px;margin:12px 0;border:1px solid var(--line);border-radius:10px;text-decoration:none">
        <strong style="display:block;color:var(--ink)">${escapeHtml(property.name)}</strong>
        <span style="font-size:13px;color:var(--muted)">${escapeHtml(property.organizationName)} · ${escapeHtml(property.role)}</span>
      </a>`).join('')}</nav>` : '<p role="status">Your account does not have access to an active property. Contact your organization administrator.</p>'}
    <form method="post" action="/api/dashboard"><input type="hidden" name="action" value="logout"><button type="submit">Sign out</button></form>
  `)
}

function portalHours(property: Record<string, unknown>): Record<string, [number, number]> {
  const source = property.hours ?? property.leasingHoursByDay
  if (source === undefined || source === null) return {}
  if (typeof source !== 'object' || Array.isArray(source)) throw new PropertyConfigurationError('property_configuration_invalid', 'property.leasingHoursByDay')
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const hours: Record<string, [number, number]> = {}
  for (let day = 0; day < 7; day++) {
    const value = (source as Record<string, unknown>)[String(day)] ?? (source as Record<string, unknown>)[weekdays[day]!]
    if (value === undefined || value === null || value === 'closed') continue
    let range: unknown = value
    if (typeof value === 'string') {
      const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(value.trim())
      if (!match || [match[1], match[4]].some(hour => Number(hour) < 1 || Number(hour) > 12)
        || [match[2], match[5]].some(minute => minute !== undefined && Number(minute) > 59)) throw new PropertyConfigurationError('property_configuration_invalid', 'property.leasingHoursByDay')
      const hour = (h: string, minute: string | undefined, period: string) => Number(h) % 12 + (period.toLowerCase() === 'pm' ? 12 : 0) + Number(minute ?? 0) / 60
      const start = hour(match[1]!, match[2], match[3]!), end = hour(match[4]!, match[5], match[6]!)
      range = [start, end === 0 ? 24 : end]
    }
    if (!Array.isArray(range) || range.length !== 2 || range.some(value => typeof value !== 'number' || !Number.isFinite(value))
      || range[0] < 0 || range[1] > 24 || range[0] >= range[1]) throw new PropertyConfigurationError('property_configuration_invalid', 'property.leasingHoursByDay')
    hours[day] = [range[0], range[1]]
  }
  return hours
}

/** Only allowlisted display fields cross into the page; a bootstrap is never API authority. */
export function decoratePropertyDashboard(html: string, principal: AuthenticatedUser, scope: AuthorizedScope, snapshot: PropertySnapshot): string {
  assertPropertySnapshot(snapshot, scope)
  if (scope.actor.kind !== 'user' || scope.actor.userId !== principal.userId || scope.actor.credentialVersion !== principal.credentialVersion) throw new AuthorizationError('forbidden')
  const property = snapshot.property
  const phone = typeof property.leasingPhone === 'string' && /^[+()\d .-]{7,32}$/.test(property.leasingPhone) ? property.leasingPhone.trim() : null
  const location = typeof property.locationLabel === 'string' ? property.locationLabel : typeof property.address === 'string' ? property.address : ''
  const publicProperty = { organizationId: scope.organizationId, propertyId: scope.propertyId,
    buildingName: String(property.buildingName), timeZone: snapshot.timeZone, configurationVersion: snapshot.version,
    permissionVersion: scope.permissionVersion, permissions: scope.permissions,
    leasingPhone: phone?.replace(/[^+\d]/g, '') ?? null, leasingPhoneDisplay: phone, hours: portalHours(property), locationLabel: location.slice(0, 300) }
  const account = { userId: principal.userId, username: principal.username, displayName: principal.displayName }
  const script = `<script>window.ATRIUM_RUNTIME_MODE="postgres";window.ATRIUM_ACCOUNT=Object.freeze(${scriptJson(account)});window.ATRIUM_PROPERTY=Object.freeze(${scriptJson(publicProperty)});</script>`
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

/** Only the verified, nonsecret identity reaches the page; it cannot select API storage. */
export function decorateDashboard(html: string, auth: Extract<OpsAuth, { ok: true }>, property?: Record<string, unknown>): string {
  const identity = JSON.stringify({ username: auth.username, tenantId: auth.tenantId, displayName: auth.displayName })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const timeZone = JSON.stringify(propertyTimeZone(property))
  const script = `<script>window.ATRIUM_ACCOUNT=Object.freeze(${identity});window.ATRIUM_PROPERTY=Object.freeze({"timeZone":${timeZone}});</script>`
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

/**
 * Blunts online guessing. Per warm instance and therefore not a real rate limiter — that
 * belongs at the edge — but it turns a fast passcode grind into a slow one for free, and
 * costs a legitimate operator who mistypes once a quarter of a second.
 */
const failures = new Map<string, number>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function clientKey(req: any): string {
  const fwd = req.headers?.['x-forwarded-for']
  const raw = Array.isArray(fwd) ? fwd[0] : fwd
  return String(raw ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0]?.trim() || 'unknown'
}

async function penalise(key: string) {
  const n = (failures.get(key) ?? 0) + 1
  failures.set(key, n)
  if (failures.size > 5000) failures.clear()
  await sleep(Math.min(250 * n, 2000))
}

function bodyFields(req: any): Record<string, string> {
  const raw = req.body
  if (!raw) return {}
  if (typeof raw === 'object') {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v
    return out
  }
  const text = String(raw)
  const type = String(req.headers?.['content-type'] ?? '')
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {}
    } catch { return {} }
  }
  return Object.fromEntries(new URLSearchParams(text))
}

async function legacyDashboard(req: any, res: any) {
  const headers = req.headers ?? {}
  const now = new Date()
  const secure = isSecureRequest(headers)
  const config = readAccountsConfig()
  const passcode = opsPasscode()

  if (req.method === 'POST') {
    const fields = bodyFields(req)

    if (fields['action'] === 'logout') {
      send(res, 200, shell('Signed out', '<h1>Signed out</h1><p><a href="/api/dashboard">Sign in again</a></p>'),
        clearedSessionCookie({ secure }))
      return
    }

    if (config.mode === 'invalid' || (config.mode === 'legacy' && passcode === null)) {
      send(res, 503, notConfiguredPage()); return
    }

    const account = config.mode === 'accounts'
      ? await authenticateAccount(fields['username'] ?? '', fields['password'] ?? '') : null
    const authenticated = config.mode === 'accounts'
      ? account !== null : constantTimeEquals(fields['passcode'] ?? '', passcode!)
    if (!authenticated) {
      await penalise(clientKey(req))
      send(res, 401, loginPage(true, config.mode === 'accounts'))
      return
    }

    failures.delete(clientKey(req))
    // 303 so a refresh after signing in does not re-post the passcode.
    for (const [k, v] of HTML_HEADERS) res.setHeader(k, v)
    const token = account ? mintAccountSession(now, account) : mintSession(now, passcode!)
    res.setHeader('set-cookie', sessionCookie(token, { secure }))
    res.setHeader('location', '/api/dashboard')
    res.status(303).send('')
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD, POST')
    res.status(405).json({ error: 'GET or POST only' })
    return
  }

  const auth = authorizeOps(headers, now)
  if (!auth.ok) {
    send(res, auth.reason === 'not_configured' ? 503 : 401,
      auth.reason === 'not_configured' ? notConfiguredPage() : loginPage(false, config.mode === 'accounts'))
    return
  }

  // Renew on use, so an operator watching a live call is not signed out mid-tour.
  if (auth.via === 'session') {
    const account = config.mode === 'accounts'
      ? config.accounts.find((candidate) => candidate.username === auth.username && candidate.tenantId === auth.tenantId) : null
    const token = account ? mintAccountSession(now, account) : mintSession(now, passcode!)
    res.setHeader('set-cookie',
      sessionCookie(token, { secure, ttlMs: SESSION_TTL_MS }))
  }
  try {
    const html = decorateDashboard(page.html, auth)
    for (const [k, v] of HTML_HEADERS) res.setHeader(k, v)
    res.status(200).send(html)
  } catch {
    send(res, 503, shell('Property configuration unavailable', '<h1>Property configuration needs attention</h1><p>The property timezone is invalid. Ask an administrator to correct its IANA timezone, then reload the portal.</p>'))
  }
}

class InvalidSelection extends Error {}
function selectedProperty(req: any): { organizationId: string; propertyId: string } | null {
  let organizationId: unknown, propertyId: unknown
  if (typeof req.url === 'string' && req.url.includes('?')) {
    const params = new URL(req.url, 'http://localhost').searchParams
    if (params.getAll('organizationId').length > 1 || params.getAll('propertyId').length > 1) throw new InvalidSelection()
    organizationId = params.get('organizationId') ?? undefined; propertyId = params.get('propertyId') ?? undefined
  } else { organizationId = req.query?.organizationId; propertyId = req.query?.propertyId }
  if (organizationId === undefined && propertyId === undefined) return null
  if (!validId(organizationId) || !validId(propertyId)) throw new InvalidSelection()
  return { organizationId, propertyId }
}

async function databaseDashboard(req: any, res: any) {
  const headers = req.headers ?? {}, secure = isSecureRequest(headers), now = new Date()
  if (req.method === 'POST' && bodyFields(req).action === 'logout') {
    send(res, 200, shell('Signed out', '<h1>Signed out</h1><p><a href="/api/dashboard">Sign in again</a></p>'), clearedSessionCookie({ secure }))
    return
  }
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
    res.setHeader('allow', 'GET, HEAD, POST'); send(res, 405, shell('Method not allowed', '<h1>Method not allowed</h1>')); return
  }
  // Injection is a server-owned request field for local composition/tests. HTTP
  // query parameters, headers and parsed JSON cannot create a runtime instance.
  const runtime = runtimeForRequest(req)
  const selection = selectedProperty(req)
  const destination = selection ? propertyDashboardUrl(selection.organizationId, selection.propertyId) : '/api/dashboard'
  if (req.method === 'POST') {
    const fields = bodyFields(req)
    const principal = await runtime.authorization.authenticatePassword(fields.username ?? '', fields.password ?? '')
    if (!principal) { await penalise(clientKey(req)); send(res, 401, loginPage(true, true, destination)); return }
    failures.delete(clientKey(req))
    for (const [key, value] of HTML_HEADERS) res.setHeader(key, value)
    res.setHeader('set-cookie', sessionCookie(mintUserSession(principal, now, runtime.sessionSecret), { secure }))
    res.setHeader('location', destination); res.status(303).send(''); return
  }
  const principal = await runtime.authenticate(headers, now)
  if (!principal) { send(res, 401, loginPage(false, true, destination)); return }
  res.setHeader('set-cookie', sessionCookie(mintUserSession(principal, now, runtime.sessionSecret), { secure, ttlMs: SESSION_TTL_MS }))
  if (!selection) {
    const properties = await runtime.authorization.listAuthorizedProperties(principal)
    if (properties.length === 1) {
      for (const [key, value] of HTML_HEADERS) res.setHeader(key, value)
      const property = properties[0]!
      res.setHeader('location', propertyDashboardUrl(property.organizationId, property.id)); res.status(303).send(''); return
    }
    send(res, properties.length ? 200 : 403, propertyPicker(principal, properties)); return
  }
  const resolved = await runtime.loadUserProperty(principal, selection, 'read', randomUUID())
  send(res, 200, decoratePropertyDashboard(page.html, principal, resolved.scope, resolved.snapshot))
}

export default async function handler(req: any, res: any) {
  try {
    if (isPostgresRuntime()) { await databaseDashboard(req, res); return }
  } catch (error) {
    if (error instanceof InvalidSelection) {
      send(res, 400, shell('Choose a property', '<h1>Choose a property</h1><p>The workspace link needs one organization and one property. <a href="/api/dashboard">Return to your properties</a>.</p>')); return
    }
    const failure = readRuntimeError(error)
    if (failure.status === 401) { send(res, 401, loginPage(false, true)); return }
    const title = failure.status === 403 ? 'Property access unavailable' : 'Workspace unavailable'
    const message = failure.status === 403 ? 'Your account cannot open this property. Return to your properties or contact your organization administrator.'
      : 'The workspace is temporarily unavailable. Please try again, or contact your Atrium administrator if the problem continues.'
    send(res, failure.status, shell(title, `<h1>${title}</h1><p>${message}</p><a href="/api/dashboard">Return to your properties</a>`)); return
  }
  return legacyDashboard(req, res)
}

import page from '../ops/dashboard.page.json' with { type: 'json' }
import {
  authorizeOps, clearedSessionCookie, constantTimeEquals, isSecureRequest, mintSession,
  mintAccountSession, opsPasscode, sessionCookie, SESSION_TTL_MS,
} from '../src/ops/session.ts'
import type { OpsAuth } from '../src/ops/session.ts'
import { authenticateAccount, readAccountsConfig } from '../src/ops/accounts.ts'

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

const loginPage = (failed: boolean, accountMode: boolean) => shell('Sign in — Atrium Operations', `
  <h1>Welcome back.</h1>
  <p>Sign in to manage your leasing workspace.</p>
  ${failed ? `<p class="err" role="alert">${accountMode ? 'The username or password was not right.' : 'That passcode was not right.'} Please try again.</p>` : ''}
  <form method="post" action="/api/dashboard">
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

/** Only the verified, nonsecret identity reaches the page; it cannot select API storage. */
export function decorateDashboard(html: string, auth: Extract<OpsAuth, { ok: true }>): string {
  const identity = JSON.stringify({ username: auth.username, tenantId: auth.tenantId, displayName: auth.displayName })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const script = `<script>window.ATRIUM_ACCOUNT=Object.freeze(${identity});</script>`
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

export default async function handler(req: any, res: any) {
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
  for (const [k, v] of HTML_HEADERS) res.setHeader(k, v)
  res.status(200).send(decorateDashboard(page.html, auth))
}

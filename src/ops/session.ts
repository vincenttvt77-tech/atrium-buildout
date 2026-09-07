/**
 * The session gate in front of the operations dashboard and its event log.
 *
 * The log is not operational telemetry. It carries prospect names, email addresses, budget
 * ceilings and verbatim excerpts of what a caller actually said — personal information the
 * NY SHIELD Act requires reasonable safeguards for, and which the website's own privacy
 * notice promises is shared only with the people operating the property. An endpoint that
 * hands the whole leasing pipeline to anyone who guesses a URL is not a reasonable
 * safeguard, so both the page and the log fail closed:
 *
 *   - no passcode configured  → nothing is served at all, rather than served openly
 *   - passcode configured     → a name, an email address or an excerpt reaches a request
 *                               only after this module has said yes
 *
 * There is deliberately no redacted-but-public mode. A "safe" summary is a thing someone
 * later adds a field to.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hasSecret, requireSecret } from '../config/env.ts'

export const OPS_COOKIE = 'atrium_ops'

/** One working day. Long enough for a shift, short enough that a stale laptop closes. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000

/** Version tag in the signature so a format change invalidates every old cookie. */
const CONTEXT = 'atrium-ops-session-v1'

/**
 * Per-process key for comparing untrusted strings.
 *
 * Hashing both sides to a fixed 32 bytes before comparing means the comparison is constant
 * time in the value *and* in its length — a bare timingSafeEqual has to reject mismatched
 * lengths early, which leaks how long the passcode is.
 */
const COMPARE_KEY = randomBytes(32)

export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest()
  const hb = createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/** The configured passcode, or null when the operator has not set one yet. */
export function opsPasscode(env: NodeJS.ProcessEnv = process.env): string | null {
  return hasSecret('OPS_DASHBOARD_PASSCODE', env)
    ? requireSecret('OPS_DASHBOARD_PASSCODE', env)
    : null
}

function sign(payload: string, passcode: string): string {
  return createHmac('sha256', passcode).update(`${CONTEXT}|${payload}`).digest('base64url')
}

/**
 * A session cookie value: an expiry, and an HMAC of that expiry keyed by the passcode.
 *
 * Stateless on purpose — serverless instances do not share memory, so a session held in a
 * Map would log people out every time a cold start moved them to a different instance.
 */
export function mintSession(now: Date, passcode: string, ttlMs: number = SESSION_TTL_MS): string {
  const expiresAt = String(now.getTime() + ttlMs)
  return `${expiresAt}.${sign(expiresAt, passcode)}`
}

export function verifySession(
  token: string | undefined, now: Date, passcode: string,
): boolean {
  if (!token) return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const expiresAt = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  // Bound the expiry before Number() so a huge or non-numeric value cannot be smuggled in.
  if (!/^[0-9]{1,15}$/.test(expiresAt)) return false
  if (!constantTimeEquals(signature, sign(expiresAt, passcode))) return false
  return Number(expiresAt) > now.getTime()
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = Array.isArray(header) ? header.join('; ') : header
  if (!raw) return out
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || Object.hasOwn(out, name)) continue
    const value = part.slice(eq + 1).trim()
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

export type OpsAuth =
  /** Authorised. `via` is for the audit line, not for branching on trust. */
  | { ok: true; via: 'session' | 'passcode-header' }
  /** No passcode is configured, so nothing can be authorised. Serve nothing. */
  | { ok: false; reason: 'not_configured' }
  /** A passcode is configured and this request did not present it. */
  | { ok: false; reason: 'unauthenticated' }

type Headers = Record<string, string | string[] | undefined>

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v

/**
 * Decides whether a request may see the dashboard or the log.
 *
 * Two ways in: the session cookie a human gets after typing the passcode, and an
 * `x-ops-passcode` header for a monitor or a curl. Both are the same secret; neither is the
 * Vapi webhook secret, which belongs to a machine and would otherwise end up pasted into a
 * browser by someone checking a booking.
 */
export function authorizeOps(
  headers: Headers, now: Date, env: NodeJS.ProcessEnv = process.env,
): OpsAuth {
  const passcode = opsPasscode(env)
  if (passcode === null) return { ok: false, reason: 'not_configured' }

  const presented = first(headers['x-ops-passcode'])
  if (presented !== undefined && constantTimeEquals(presented, passcode)) {
    return { ok: true, via: 'passcode-header' }
  }

  const token = parseCookies(headers['cookie'])[OPS_COOKIE]
  if (verifySession(token, now, passcode)) return { ok: true, via: 'session' }

  return { ok: false, reason: 'unauthenticated' }
}

/**
 * `Secure` is dropped only for plain-http localhost. Vercel always terminates TLS and sets
 * x-forwarded-proto, so in production this is always a Secure cookie.
 */
export function isSecureRequest(headers: Headers): boolean {
  const proto = first(headers['x-forwarded-proto'])
  if (proto) return proto.split(',')[0]?.trim() === 'https'
  const host = first(headers['host']) ?? ''
  return !(host.startsWith('localhost') || host.startsWith('127.0.0.1'))
}

export function sessionCookie(
  token: string, opts: { secure: boolean; ttlMs?: number },
): string {
  const maxAge = Math.floor((opts.ttlMs ?? SESSION_TTL_MS) / 1000)
  return [
    `${OPS_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ')
}

export function clearedSessionCookie(opts: { secure: boolean }): string {
  return [
    `${OPS_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ')
}

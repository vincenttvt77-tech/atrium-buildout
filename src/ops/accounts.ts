import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/** Server-only account configuration. Password hashes must never reach the dashboard. */
export interface OpsAccount {
  username: string
  passwordHash: string
  tenantId: string
  displayName: string
  assistantIds: string[]
}

export type AccountsConfig =
  | { mode: 'legacy' }
  | { mode: 'invalid' }
  | { mode: 'accounts'; accounts: OpsAccount[] }

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/
const TENANT = /^[a-z][a-z0-9-]{0,62}$/
const ASSISTANT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const HASH = /^scrypt\$65536\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/
const SCRYPT_OPTIONS = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key))
  })
}

/** Generate once when provisioning an account, then store only this value in the environment. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('Account passwords must contain between 12 and 256 characters.')
  }
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return `scrypt$65536$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`
}

function parseHash(value: unknown): { salt: Buffer; key: Buffer } | null {
  if (typeof value !== 'string') return null
  const match = HASH.exec(value)
  if (!match) return null
  const salt = Buffer.from(match[1]!, 'base64url')
  const key = Buffer.from(match[2]!, 'base64url')
  return salt.toString('base64url') === match[1] && key.toString('base64url') === match[2]
    ? { salt, key } : null
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const parsed = parseHash(passwordHash)
  if (!parsed || typeof password !== 'string' || password.length > 256 || !password.length) return false
  const presented = await derive(password, parsed.salt)
  return timingSafeEqual(presented, parsed.key)
}

/**
 * Presence selects account mode, even for empty or malformed JSON. A configuration typo must
 * never silently reopen the old shared passcode. IDs are canonical so storage prefixes and
 * voice routing cannot disagree about which workspace is being selected.
 */
export function readAccountsConfig(env: NodeJS.ProcessEnv = process.env): AccountsConfig {
  const raw = env.OPS_ACCOUNTS_JSON
  if (raw === undefined) return { mode: 'legacy' }
  if (!env.OPS_SESSION_SECRET || env.OPS_SESSION_SECRET.trim().length < 32) return { mode: 'invalid' }
  if (raw.length > 512_000) return { mode: 'invalid' }
  try {
    const entries: unknown = JSON.parse(raw)
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 500) return { mode: 'invalid' }
    const usernames = new Set<string>()
    const assistantTenants = new Map<string, string>()
    const accounts: OpsAccount[] = []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { mode: 'invalid' }
      const { username, tenantId, passwordHash, displayName, assistantIds = [] } = entry
      if (typeof username !== 'string' || !USERNAME.test(username) || usernames.has(username) ||
          typeof tenantId !== 'string' || !TENANT.test(tenantId) || tenantId === 'legacy' ||
          !parseHash(passwordHash) || typeof displayName !== 'string' || !displayName.trim() ||
          displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(displayName) ||
          !Array.isArray(assistantIds) || assistantIds.length > 100 ||
          assistantIds.some((id: unknown) => typeof id !== 'string' || !ASSISTANT.test(id)) ||
          new Set(assistantIds).size !== assistantIds.length) return { mode: 'invalid' }
      usernames.add(username)
      for (const id of assistantIds) {
        const existing = assistantTenants.get(id)
        if (existing && existing !== tenantId) return { mode: 'invalid' }
        assistantTenants.set(id, tenantId)
      }
      accounts.push({ username, tenantId, passwordHash, displayName: displayName.trim(), assistantIds: [...assistantIds] })
    }
    return { mode: 'accounts', accounts }
  } catch { return { mode: 'invalid' } }
}

export async function authenticateAccount(
  username: string, password: string, env: NodeJS.ProcessEnv = process.env,
): Promise<OpsAccount | null> {
  const config = readAccountsConfig(env)
  if (config.mode !== 'accounts') return null
  const normalized = typeof username === 'string' ? username.trim().toLowerCase() : ''
  const account = config.accounts.find((candidate) => candidate.username === normalized)
  // An unknown username still pays the same password-derivation cost as a known one.
  const verified = await verifyPassword(password, (account ?? config.accounts[0]!).passwordHash)
  return account && verified ? account : null
}

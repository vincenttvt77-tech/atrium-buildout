import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { hashPassword, readAccountsConfig } from '../src/ops/accounts.ts'

export const DEMO_TENANT = 'demo-larkin'
export const DEMO_ASSISTANT = 'demo-larkin-assistant'

/** Local preview only. Persist hashes and a signing secret; never create a deployed default. */
export async function configureDemoAccount(root) {
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error('The fixture preview cannot run in production.')
  }
  const path = new URL('.env.demo-account.json', root)
  if (process.env.OPS_ACCOUNTS_JSON === undefined) {
    let saved
    try { saved = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      saved = {
        sessionSecret: randomBytes(48).toString('base64url'),
        accounts: [{ username: 'larkin', passwordHash: await hashPassword('LarkinDemo123!'),
          tenantId: DEMO_TENANT, displayName: 'The Larkin · Demo', assistantIds: [DEMO_ASSISTANT] }],
      }
      await writeFile(path, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    }
    process.env.OPS_ACCOUNTS_JSON = JSON.stringify(saved.accounts)
    process.env.OPS_SESSION_SECRET = saved.sessionSecret
  }
  const config = readAccountsConfig()
  if (config.mode !== 'accounts') throw new Error('Named demo account configuration is invalid.')
  const demo = config.accounts.find((account) => account.tenantId === DEMO_TENANT && account.assistantIds.includes(DEMO_ASSISTANT))
  if (!demo) throw new Error('The local fixture preview requires an explicit demo-larkin account binding.')
  return demo
}

import { randomUUID } from 'node:crypto'
import { assertAuthenticatedUser } from './identity.ts'
import type { AuthenticatedUser } from './model.ts'
import { hashPassword, verifyPassword } from '../ops/accounts.ts'

export type PasswordChangeCode = 'invalid_password' | 'password_unchanged' | 'incorrect_password'
  | 'unauthenticated' | 'rate_limited' | 'password_change_unavailable'
const messages: Record<PasswordChangeCode, string> = {
  invalid_password: 'Use a new password of at least 15 characters. This entry is too short or too long.',
  password_unchanged: 'Choose a password different from your current password.',
  incorrect_password: 'Your current password was not correct.',
  unauthenticated: 'Your sign-in changed. Sign in again before changing your password.',
  rate_limited: 'Too many password-change attempts. Wait before trying again.',
  password_change_unavailable: 'The password change could not be confirmed. Try signing in again before retrying.',
}
export class PasswordChangeError extends Error {
  readonly code: PasswordChangeCode
  readonly status: number
  readonly retryAfterSeconds?: number
  constructor(code: PasswordChangeCode, retryAfterSeconds?: number) {
    super(messages[code]); this.code = code
    this.status = code === 'unauthenticated' ? 401 : code === 'rate_limited' ? 429
      : code === 'password_change_unavailable' ? 503 : 400
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds
  }
}
export interface PasswordChangeReservation { attemptId: string; passwordHash: string; credentialVersion: number }
/** Reservations commit before scrypt; writes compare the same credential under a lock. */
export interface PasswordChangeRepository {
  reserve(principal: AuthenticatedUser, attemptId: string): Promise<PasswordChangeReservation>
  commit(principal: AuthenticatedUser, reservation: PasswordChangeReservation, replacementHash: string): Promise<void>
}
interface PasswordCryptography {
  verify(password: string, hash: string): Promise<boolean>
  hash(password: string): Promise<string>
}
const supportedHash = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const parts = /^scrypt\$65536\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(value)
  return !!parts && Buffer.from(parts[1]!, 'base64url').toString('base64url') === parts[1]
    && Buffer.from(parts[2]!, 'base64url').toString('base64url') === parts[2]
}
export function createPasswordChangeService(repository: PasswordChangeRepository,
  cryptography: PasswordCryptography = { verify: verifyPassword, hash: hashPassword }) {
  return Object.freeze({
    async changeOwnPassword(principal: AuthenticatedUser, input: { currentPassword: unknown; newPassword: unknown }): Promise<void> {
      try { assertAuthenticatedUser(principal) }
      catch { throw new PasswordChangeError('unauthenticated') }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'currentPassword' && key !== 'newPassword')
        || typeof input.currentPassword !== 'string' || input.currentPassword.length < 1 || input.currentPassword.length > 256
        || typeof input.newPassword !== 'string' || input.newPassword.length > 256 || [...input.newPassword].length < 15
        || /[\ud800-\udfff]/u.test(input.newPassword)) throw new PasswordChangeError('invalid_password')
      try {
        const reservation = await repository.reserve(principal, randomUUID())
        if (!reservation || reservation.credentialVersion !== principal.credentialVersion
          || !supportedHash(reservation.passwordHash)) throw new PasswordChangeError('password_change_unavailable')
        if (!await cryptography.verify(input.currentPassword, reservation.passwordHash)) throw new PasswordChangeError('incorrect_password')
        if (input.currentPassword === input.newPassword) throw new PasswordChangeError('password_unchanged')
        const replacementHash = await cryptography.hash(input.newPassword)
        if (!supportedHash(replacementHash)) throw new PasswordChangeError('password_change_unavailable')
        await repository.commit(principal, reservation, replacementHash)
      } catch (error) {
        if (error instanceof PasswordChangeError) throw error
        // Do not expose database statements, hashes, connection settings or raw errors.
        throw new PasswordChangeError('password_change_unavailable')
      }
    },
  })
}

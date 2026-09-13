import { randomUUID } from 'node:crypto'
import type { AuthenticatedUser, AuthorizedScope } from '../auth/model.ts'
import { assertStaffUser } from '../auth/identity.ts'
import { assertManagedSession } from '../auth/session-management.ts'
import { assertAuthorizedScope } from '../auth/authorization.ts'
import { hashPassword, verifyPassword } from '../ops/accounts.ts'
import { isoTimestamp } from './validation.ts'
import { EnrollmentError } from './enrollment-model.ts'
import type { ResidentEnrollmentRepository, EnrollmentReservation, EnrollmentAcceptanceReceipt } from './enrollment-model.ts'
import { enrollmentId, enrollmentDigest, enrollmentUsername, enrollmentDisplayName, validateResidentPassword, supportedResidentHash, parseEnrollmentStaffCommand } from './enrollment-validation.ts'
import { hashEnrollmentToken, newEnrollmentToken } from './enrollment-tokens.ts'

export interface EnrollmentSecurity {
  reserveLogin(username: string, clientAddress: string): Promise<void>
  requireResidentLogin(principal: AuthenticatedUser): Promise<void>
  requireStaffAdministration(principal: AuthenticatedUser): Promise<string>
}
interface Cryptography { hash(password: string): Promise<string>; verify(password: string, hash: string): Promise<boolean> }
export function assertResidentPrincipal(principal: AuthenticatedUser): void {
  assertManagedSession(principal)
  if (principal.audience !== 'resident') throw new EnrollmentError('enrollment_forbidden')
}
function receipt(value: EnrollmentAcceptanceReceipt, reservation: EnrollmentReservation): EnrollmentAcceptanceReceipt {
  if (!value || value.requestId !== reservation.requestId || value.invitationId !== reservation.invitationId
    || value.userId !== reservation.userId || !Number.isSafeInteger(value.bindingVersion) || value.bindingVersion < 1
    || typeof value.replayed !== 'boolean') throw new EnrollmentError('enrollment_unavailable')
  enrollmentId(value.bindingId); enrollmentId(value.invitationId); isoTimestamp(value.activatedAt)
  return value
}
function checkedReservation(value: EnrollmentReservation, input: { requestId: string; tokenHash: string; browserHash: string;
  username: string; displayName: string; mode: 'new' | 'existing'; expectedInvitationVersion: number }, principal: AuthenticatedUser | null): EnrollmentReservation {
  if (!value || value.requestId !== input.requestId || value.tokenHash !== input.tokenHash || value.browserHash !== input.browserHash
    || value.mode !== input.mode || value.username !== input.username || value.displayName !== input.displayName
    || value.invitationVersion !== input.expectedInvitationVersion || !Number.isSafeInteger(value.credentialVersion) || value.credentialVersion < 1
    || (principal ? value.userId !== principal.userId || value.sessionId !== principal.sessionId || value.credentialVersion !== principal.credentialVersion
      : value.sessionId !== null) || (value.passwordHash !== null && !supportedResidentHash(value.passwordHash))) throw new EnrollmentError('enrollment_unavailable')
  enrollmentId(value.id); enrollmentId(value.invitationId)
  if (Date.parse(isoTimestamp(value.expiresAt)) <= Date.now()) throw new EnrollmentError('enrollment_changed')
  return value
}
/** No password, invitation digest or server reservation may leave this service as an HTTP DTO. */
export function createResidentEnrollmentService(repository: ResidentEnrollmentRepository, security: EnrollmentSecurity,
  cryptography: Cryptography = { hash: hashPassword, verify: verifyPassword }) {
  return Object.freeze({
    async executeStaff(principal: AuthenticatedUser, scope: AuthorizedScope, configurationVersion: number, raw: unknown) {
      assertStaffUser(principal); assertManagedSession(principal); assertAuthorizedScope(scope, 'configure')
      if (scope.actor.kind !== 'user' || scope.actor.userId !== principal.userId || scope.actor.sessionId !== principal.sessionId) throw new EnrollmentError('enrollment_forbidden')
      const command = parseEnrollmentStaffCommand(raw), proofId = await security.requireStaffAdministration(principal)
      const token = command.action === 'issue_invitation' ? newEnrollmentToken() : null
      const material = token ? { id: randomUUID(), tokenHash: hashEnrollmentToken(token) } : undefined
      const result = await repository.executeStaff(scope, configurationVersion, proofId, command, material)
      if (!result || result.action !== command.action || result.requestId !== command.requestId || result.actorUserId !== principal.userId
        || result.organizationId !== scope.organizationId || result.propertyId !== scope.propertyId || typeof result.replayed !== 'boolean') throw new EnrollmentError('enrollment_unavailable')
      // A digest-only replay cannot recover the original URL. Never attach a fresh unrelated token.
      if (material && !result.replayed && (result.id !== material.id || result.version !== 1)) throw new EnrollmentError('enrollment_unavailable')
      return { receipt: result, ...(token && !result.replayed ? { invitationToken: token } : {}) }
    },
    async accept(principal: AuthenticatedUser | null, input: {
      mode: 'new' | 'existing'; requestId: unknown; tokenHash: string; browserHash: string; clientKey: string; clientAddress: string;
      invitationVersion: unknown; username?: unknown; displayName?: unknown; password: unknown;
    }): Promise<EnrollmentAcceptanceReceipt> {
      if (!input || !['new','existing'].includes(input.mode) || !Number.isSafeInteger(input.invitationVersion) || Number(input.invitationVersion) < 1) throw new EnrollmentError('enrollment_invalid_input')
      if (input.mode === 'existing') {
        if (!principal) throw new EnrollmentError('enrollment_unauthenticated')
        assertResidentPrincipal(principal); await security.requireResidentLogin(principal)
      } else if (principal) throw new EnrollmentError('enrollment_invalid_input')
      const username = input.mode === 'new' ? enrollmentUsername(input.username) : principal!.username
      const displayName = input.mode === 'new' ? enrollmentDisplayName(input.displayName) : principal!.displayName
      const password = validateResidentPassword(input.password, input.mode === 'new')
      await security.reserveLogin(username, input.clientAddress)
      const request = { requestId: enrollmentId(input.requestId), tokenHash: enrollmentDigest(input.tokenHash), browserHash: enrollmentDigest(input.browserHash),
        clientKey: enrollmentDigest(input.clientKey), mode: input.mode, expectedInvitationVersion: Number(input.invitationVersion), username, displayName }
      const reservation = checkedReservation(await repository.reserveAcceptance(principal, request), request, principal)
      if (reservation.completedReceipt) {
        if (!reservation.passwordHash || !await cryptography.verify(password, reservation.passwordHash)) throw new EnrollmentError('enrollment_reconcile_required')
        const saved = input.mode === 'existing' ? await repository.acceptExisting(principal!, reservation)
          : await repository.acceptNew(reservation, { passwordHash: reservation.passwordHash })
        return receipt(saved, reservation)
      }
      if (input.mode === 'existing') {
        if (!reservation.passwordHash || !await cryptography.verify(password, reservation.passwordHash)) throw new EnrollmentError('enrollment_password_incorrect')
        return receipt(await repository.acceptExisting(principal!, reservation), reservation)
      }
      if (reservation.passwordHash !== null) throw new EnrollmentError('enrollment_unavailable')
      const passwordHash = await cryptography.hash(password)
      if (!supportedResidentHash(passwordHash)) throw new EnrollmentError('enrollment_unavailable')
      return receipt(await repository.acceptNew(reservation, { passwordHash }), reservation)
    },
  })
}

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { generateAuthenticationOptions } from '@simplewebauthn/server'
import type { AuthenticatedUser, AuthorizedScope } from '../auth/model.ts'
import type { MfaConfiguration } from '../auth/mfa-model.ts'
import { assertManagedSession } from '../auth/session-management.ts'
import { assertStaffUser } from '../auth/identity.ts'
import { assertAuthorizedScope } from '../auth/authorization.ts'
import { verifyConsentWebAuthn } from '../auth/consent-webauthn.ts'
import { ConsentError } from './consent-model.ts'
import type { ResidentConsentRepository } from './consent-model.ts'
import { consentId, consentObject, parseConsentStaffCommand, parseConsentGrant, parseConsentOwnCommand } from './consent-validation.ts'
export interface ConsentSecurity {
 requireResidentLogin(principal:AuthenticatedUser):Promise<void>
 requireStaffAdministration(principal:AuthenticatedUser):Promise<string>
}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
function resident(principal:AuthenticatedUser){assertManagedSession(principal);if(principal.audience!=='resident')throw new ConsentError('consent_unauthenticated')}
export function createResidentConsentService(repository:ResidentConsentRepository,security:ConsentSecurity,configuration:MfaConfiguration){
 return Object.freeze({
  async executeStaff(principal:AuthenticatedUser,scope:AuthorizedScope,configurationVersion:number,expectedCaseId:string,raw:unknown){
   assertStaffUser(principal);assertManagedSession(principal)
   const command=parseConsentStaffCommand(raw),privileged=!['publish_request','withdraw_request'].includes(command.action)
   assertAuthorizedScope(scope,privileged?'configure':'operate')
   if(scope.actor.kind!=='user'||scope.actor.userId!==principal.userId||scope.actor.sessionId!==principal.sessionId)throw new ConsentError('consent_forbidden')
   const proof=privileged?await security.requireStaffAdministration(principal):null
   return repository.executeStaff(scope,configurationVersion,consentId(expectedCaseId),proof,command)
  },
  async beginGrant(principal:AuthenticatedUser,raw:unknown){
   resident(principal);const command=parseConsentGrant(raw);await security.requireResidentLogin(principal)
   const optionsJSON=await generateAuthenticationOptions({rpID:configuration.rpId,userVerification:'required',challenge:randomBytes(32)})
   const challengeId=randomUUID(),startedAt=Date.now()
   const expiresAt=startedAt+300_000
   const ceremony=await repository.beginGrant(principal,{...command,challengeId,challengeHash:digest(optionsJSON.challenge),expiresAt})
   if(ceremony.id!==challengeId||ceremony.userId!==principal.userId||ceremony.sessionId!==principal.sessionId||ceremony.credentialVersion!==principal.credentialVersion
    ||ceremony.origin!==configuration.origin||ceremony.rpId!==configuration.rpId||ceremony.challengeHash!==digest(optionsJSON.challenge)
    ||!isDeepStrictEqual(parseConsentGrant(ceremony.command),command)||!Number.isSafeInteger(ceremony.expiresAt)||ceremony.expiresAt<=Date.now()||ceremony.expiresAt>startedAt+300_000
    ||!Number.isSafeInteger(ceremony.securityVersion)||ceremony.securityVersion<1||!Array.isArray(ceremony.factors)||!ceremony.factors.length||ceremony.factors.length>10
    ||ceremony.factors.some(f=>f.status!=='active'))throw new ConsentError('consent_unavailable')
   optionsJSON.allowCredentials=ceremony.factors.map(f=>({id:f.credentialId,type:'public-key'}))
   return {challengeId:ceremony.id,expiresAt:ceremony.expiresAt,optionsJSON}
  },
  async finishGrant(principal:AuthenticatedUser,raw:unknown){
   resident(principal);const input=consentObject(raw,['challengeId','response']),challengeId=consentId(input.challengeId)
   let text:string,response:any
   try{text=JSON.stringify(input.response);if(!text||text.length>65536)throw new Error();response=JSON.parse(text)}catch{throw new ConsentError('consent_invalid_input')}
   if(!response||typeof response!=='object'||Array.isArray(response)||typeof response.id!=='string'||response.id.length>1364)throw new ConsentError('consent_invalid_input')
   await security.requireResidentLogin(principal)
   const attemptId=randomUUID(),responseDigest=digest(text)
   const claim=await repository.claimGrant(principal,{challengeId,attemptId,responseDigest,credentialId:response.id})
   let verified
   try{
    if(claim.id!==challengeId||claim.attemptId!==attemptId||claim.responseDigest!==responseDigest||claim.userId!==principal.userId
     ||claim.sessionId!==principal.sessionId||claim.credentialVersion!==principal.credentialVersion||claim.audience!=='resident'
     ||claim.origin!==configuration.origin||claim.rpId!==configuration.rpId||claim.factor.credentialId!==response.id)throw new Error('Unmatched ceremony')
    verified=await verifyConsentWebAuthn(claim,response)
   }catch{
    await repository.rejectGrant(principal,claim);throw new ConsentError('consent_passkey_required')
   }
   return repository.finishGrant(principal,verified)
  },
  async decideOwn(principal:AuthenticatedUser,raw:unknown){resident(principal);const command=parseConsentOwnCommand(raw);await security.requireResidentLogin(principal);return repository.decideOwn(principal,command)},
 })
}

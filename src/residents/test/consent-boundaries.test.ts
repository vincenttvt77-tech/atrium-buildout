import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { issueAuthenticatedUser } from '../../auth/identity.ts'
import { createResidentConsentService } from '../consent-service.ts'
import { parseConsentEntryWindow, parseConsentRoster, parseConsentPolicy, parseConsentGrant } from '../consent-validation.ts'
import type { ResidentConsentRepository } from '../consent-model.ts'

const source={reference:'Explicit reviewed evidence',version:'v1',observedAt:'2026-09-01T00:00:00.000Z',validUntil:'2026-10-01T00:00:00.000Z'}
test('entry intervals reject DST gaps and require an explicit offset for a repeated local time',()=>{
 const valid={startsAt:'2026-11-01T05:30:00.000Z',endsAt:'2026-11-01T06:30:00.000Z',startsLocal:'2026-11-01T01:30:00.000-04:00',endsLocal:'2026-11-01T01:30:00.000-05:00',timeZone:'America/New_York'}
 assert.deepEqual(parseConsentEntryWindow(valid),valid)
 assert.throws(()=>parseConsentEntryWindow({...valid,startsLocal:'2026-11-01T01:30:00.000'}),{code:'consent_invalid_input'})
 assert.throws(()=>parseConsentEntryWindow({...valid,startsAt:'2026-03-08T07:30:00.000Z',startsLocal:'2026-03-08T02:30:00.000-05:00',endsAt:'2026-03-08T08:30:00.000Z',endsLocal:'2026-03-08T04:30:00.000-04:00'}),{code:'consent_invalid_input'})
})
test('roster records reviewed non-approvers without duplicating a resident or silently accepting partial confirmation',()=>{
 const id=randomUUID(),details={unitId:'19A',members:[{residentId:id,residentVersion:1,requiredPurposes:[]}],source,complete:true,protocolCompleted:true}
 assert.deepEqual(parseConsentRoster(details).members[0]?.requiredPurposes,[])
 assert.throws(()=>parseConsentRoster({...details,members:[...details.members,...details.members]}),{code:'consent_invalid_input'})
 assert.throws(()=>parseConsentRoster({...details,complete:false}),{code:'consent_invalid_input'})
 assert.throws(()=>parseConsentRoster({...details,members:[{...details.members[0],requiredPurposes:['work','work']}]}),{code:'consent_invalid_input'})
})
test('owner policy requires explicit no-charge funding and a concrete help route',()=>{
 const p={enabled:true,funding:'property_no_resident_charge',recipientRule:'reviewed_complete_roster',requireWorkConsent:true,noChargeStatement:'The property pays and the resident is not charged.',recipientProtocol:'Review complete current household authority records.',entryProtocol:'Review the exact unit, named party and time window.',maximumResponseMinutes:60,maximumConsentMinutes:1440,maximumEntryMinutes:120,helpLabel:'Property team',helpPhone:'+15555550101',helpUrl:null,emergencyInstructions:'For immediate danger contact emergency services and the property team.',source}
 assert.equal(parseConsentPolicy(p).funding,'property_no_resident_charge')
 for(const change of [{funding:'resident_pays'},{helpPhone:''},{helpUrl:'http://help.example/'},{helpUrl:'https://user:password@help.example/'},{maximumEntryMinutes:1441}])assert.throws(()=>parseConsentPolicy({...p,...change}),{code:'consent_invalid_input'})
})
test('command parser refuses inherited, extra and accessor command fields',()=>{
 const command={action:'grant',commandId:randomUUID(),requestId:randomUUID(),requestVersion:1,expectedDecisionVersion:0,purpose:'work',termsDigest:'a'.repeat(64),materialDigest:'b'.repeat(64)}
 assert.throws(()=>parseConsentGrant({...command,actorUserId:'someone-else'}),{code:'consent_invalid_input'})
 assert.throws(()=>parseConsentGrant(Object.create(command)),{code:'consent_invalid_input'})
 let invoked=false;const accessor={...command};Object.defineProperty(accessor,'termsDigest',{get(){invoked=true;return command.termsDigest},enumerable:true})
 assert.throws(()=>parseConsentGrant(accessor),{code:'consent_invalid_input'});assert.equal(invoked,false)
})
function serviceFixture(){
 const principal=issueAuthenticatedUser({id:'synthetic-resident',username:'synthetic-resident',displayName:'Synthetic Resident',status:'active',credentialVersion:1},{id:randomUUID(),expiresAt:Date.now()+3600000},'resident')
 const command={action:'grant' as const,commandId:randomUUID(),requestId:randomUUID(),requestVersion:1,expectedDecisionVersion:0,purpose:'work' as const,termsDigest:'a'.repeat(64),materialDigest:'b'.repeat(64)}
 let change:(v:any)=>any=v=>v,login=0,rejected=0,finished=0
 const repo={beginGrant:async (_:unknown,v:any)=>change({id:v.challengeId,userId:principal.userId,sessionId:principal.sessionId,credentialVersion:1,securityVersion:1,origin:'https://resident.example',rpId:'resident.example',challengeHash:v.challengeHash,expiresAt:v.expiresAt,userHandle:'c3ludGhldGlj',organizationId:'org',propertyId:'prop',command:Object.fromEntries(Object.entries(command).reverse()),factors:[{id:randomUUID(),label:'Device',credentialId:'c3ludGhldGlj',publicKey:'public',counter:0,counterRevision:1,status:'active',backupEligible:false,backedUp:false,transports:[],createdAt:Date.now(),lastUsedAt:null}]}),rejectGrant:async()=>{rejected++},finishGrant:async()=>{finished++;throw new Error('unexpected')}} as unknown as ResidentConsentRepository
 const service=createResidentConsentService(repo,{requireResidentLogin:async()=>{login++},requireStaffAdministration:async()=>{throw new Error('not staff')}},{origin:'https://resident.example',rpId:'resident.example',rpName:'Synthetic'})
 return {principal,command,repo,service,setChange:(fn:typeof change)=>{change=fn},counts:()=>({login,rejected,finished})}
}
test('ceremony accepts semantic JSONB command ordering and persists the exact requested deadline',async()=>{
 const f=serviceFixture();const result=await f.service.beginGrant(f.principal,f.command)
 assert.equal(result.optionsJSON.userVerification,'required');assert.equal(result.optionsJSON.allowCredentials?.[0]?.type,'public-key');assert.equal(f.counts().login,1)
})
test('ceremony rejects another challenge or principal, oversized lifetime and pending factors',async()=>{
 for(const mutate of [(v:any)=>({...v,id:randomUUID()}),(v:any)=>({...v,sessionId:randomUUID()}),(v:any)=>({...v,expiresAt:v.expiresAt+1}),(v:any)=>({...v,securityVersion:0}),(v:any)=>({...v,factors:[{...v.factors[0],status:'pending'}]})]){
  const f=serviceFixture();f.setChange(mutate);await assert.rejects(f.service.beginGrant(f.principal,f.command),{code:'consent_unavailable'})
 }
})
test('finish refuses unmatched claimed ceremony before cryptography and consumes the reserved failed attempt',async()=>{
 const f=serviceFixture(),challengeId=randomUUID()
 f.repo.claimGrant=async(_principal,input)=>({id:challengeId,attemptId:input.attemptId,responseDigest:input.responseDigest,userId:'different-account'} as any)
 await assert.rejects(f.service.finishGrant(f.principal,{challengeId,response:{id:'c3ludGhldGlj'}}),{code:'consent_passkey_required'})
 assert.deepEqual(f.counts(),{login:1,rejected:1,finished:0})
})
test('copied principals and staff sessions cannot start resident decision ceremonies',async()=>{
 const f=serviceFixture();await assert.rejects(f.service.beginGrant({...f.principal},f.command))
 const staff=issueAuthenticatedUser({id:'synthetic-resident',username:'synthetic-resident',displayName:'Resident also staff',status:'active',credentialVersion:1},{id:randomUUID(),expiresAt:Date.now()+3600000},'staff')
 await assert.rejects(f.service.beginGrant(staff,f.command),{code:'consent_unauthenticated'});assert.equal(f.counts().login,0)
})

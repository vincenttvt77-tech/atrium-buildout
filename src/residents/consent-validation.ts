import { ConsentError } from './consent-model.ts'
import type { ConsentPolicyDetails, ConsentSource, ConsentRosterDetails, ConsentAuthorityDetails, ConsentEntryWindow,
 ConsentStaffCommand, ConsentGrantCommand, ConsentOwnCommand, ConsentListQuery, ConsentPurpose } from './consent-model.ts'
import { recordId, isoTimestamp } from './validation.ts'
import { validSessionId } from '../auth/session.ts'
export const consentLimits = Object.freeze({ sourceDays:90, rosterMembers:50, list:50, history:50,
 responseMinutes:10080, validMinutes:43200, entryMinutes:1440, ceremonyMinutes:5, ceremoniesPerQuarterHour:60 })
const invalid=():never=>{throw new ConsentError('consent_invalid_input')}
export const consentId=(v:unknown):string=>validSessionId(v)?v:invalid()
export const consentRecordId=(v:unknown):string=>recordId(v)?v:invalid()
export const consentDigest=(v:unknown):string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:invalid()
export const consentVersion=(v:unknown,zero=false):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=(zero?0:1)?v:invalid()
export const consentPurpose=(v:unknown):ConsentPurpose=>v==='work'||v==='entry'?v:invalid()
export function consentObject(v:unknown,keys:string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return invalid()
 const descriptors=Object.getOwnPropertyDescriptors(v)
 if(Object.getOwnPropertySymbols(v).length||Object.keys(descriptors).sort().join(',')!==[...keys].sort().join(',')
 ||Object.values(descriptors).some(d=>!d.enumerable||!('value'in d)))return invalid()
 return v as Record<string,unknown>
}
export function consentText(v:unknown,min:number,max:number):string{
 if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
 ||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v))return invalid()
 const text=v.replace(/\r\n?/g,'\n').trim();return text.length>=min?text:invalid()
}
export function consentTime(v:unknown):string{try{return isoTimestamp(v)}catch{return invalid()}}
const integer=(v:unknown,min:number,max:number):number=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max?v:invalid()
const bool=(v:unknown):boolean=>typeof v==='boolean'?v:invalid()
export function parseConsentSource(input:unknown):ConsentSource{
 const v=consentObject(input,['reference','version','observedAt','validUntil']),observedAt=consentTime(v.observedAt),validUntil=consentTime(v.validUntil)
 const duration=Date.parse(validUntil)-Date.parse(observedAt);if(duration<=0||duration>consentLimits.sourceDays*86400000)return invalid()
 return {reference:consentText(v.reference,3,240),version:consentText(v.version,1,80),observedAt,validUntil}
}
export function parseConsentPolicy(input:unknown):ConsentPolicyDetails{
 const v=consentObject(input,['enabled','funding','recipientRule','requireWorkConsent','noChargeStatement','recipientProtocol','entryProtocol','maximumResponseMinutes','maximumConsentMinutes','maximumEntryMinutes','helpLabel','helpPhone','helpUrl','emergencyInstructions','source'])
 if(v.funding!=='property_no_resident_charge'||v.recipientRule!=='reviewed_complete_roster')return invalid()
 const helpPhone=consentText(v.helpPhone,8,16);if(!/^\+[1-9][0-9]{6,14}$/.test(helpPhone))return invalid()
 let helpUrl:string|null=null
 if(v.helpUrl!==null){helpUrl=consentText(v.helpUrl,8,2000);let url:URL;try{url=new URL(helpUrl)}catch{return invalid()}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href!==helpUrl)return invalid()}
 return {enabled:bool(v.enabled),funding:v.funding,recipientRule:v.recipientRule,requireWorkConsent:bool(v.requireWorkConsent),
 noChargeStatement:consentText(v.noChargeStatement,20,1000),recipientProtocol:consentText(v.recipientProtocol,20,2000),entryProtocol:consentText(v.entryProtocol,20,2000),
 maximumResponseMinutes:integer(v.maximumResponseMinutes,1,consentLimits.responseMinutes),maximumConsentMinutes:integer(v.maximumConsentMinutes,1,consentLimits.validMinutes),
 maximumEntryMinutes:integer(v.maximumEntryMinutes,1,consentLimits.entryMinutes),helpLabel:consentText(v.helpLabel,3,120),helpPhone,helpUrl,
 emergencyInstructions:consentText(v.emergencyInstructions,20,2000),source:parseConsentSource(v.source)}
}
export function parseConsentRoster(input:unknown):ConsentRosterDetails{
 const v=consentObject(input,['unitId','members','source','complete','protocolCompleted'])
 if(v.complete!==true||v.protocolCompleted!==true||!Array.isArray(v.members)||v.members.length>consentLimits.rosterMembers)return invalid()
 const members=v.members.map(raw=>{const m=consentObject(raw,['residentId','residentVersion','requiredPurposes'])
 if(!Array.isArray(m.requiredPurposes)||m.requiredPurposes.length>2)return invalid()
 const requiredPurposes=m.requiredPurposes.map(consentPurpose).sort();if(new Set(requiredPurposes).size!==requiredPurposes.length)return invalid()
 return {residentId:consentId(m.residentId),residentVersion:consentVersion(m.residentVersion),requiredPurposes}}).sort((a,b)=>a.residentId.localeCompare(b.residentId))
 if(new Set(members.map(m=>m.residentId)).size!==members.length)return invalid()
 return {unitId:consentRecordId(v.unitId),members,source:parseConsentSource(v.source),complete:true,protocolCompleted:true}
}
export function parseConsentAuthority(input:unknown):ConsentAuthorityDetails{
 const v=consentObject(input,['bindingId','bindingVersion','residentId','residentVersion','purpose','source','protocolCompleted'])
 if(v.protocolCompleted!==true)return invalid()
 return {bindingId:consentId(v.bindingId),bindingVersion:consentVersion(v.bindingVersion),residentId:consentId(v.residentId),residentVersion:consentVersion(v.residentVersion),
 purpose:consentPurpose(v.purpose),source:parseConsentSource(v.source),protocolCompleted:true}
}
function localMatches(local:string,utc:string,zone:string):boolean{
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/.test(local)||Date.parse(local)!==Date.parse(utc))return false
 try{
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(utc)).map(p=>[p.type,p.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`===local.slice(0,19)&&utc.slice(20,23)===local.slice(20,23)
 }catch{return false}
}
export function parseConsentEntryWindow(input:unknown):ConsentEntryWindow{
 const v=consentObject(input,['startsAt','endsAt','startsLocal','endsLocal','timeZone']),startsAt=consentTime(v.startsAt),endsAt=consentTime(v.endsAt)
 const timeZone=consentText(v.timeZone,1,100),startsLocal=consentText(v.startsLocal,29,29),endsLocal=consentText(v.endsLocal,29,29)
 if(!localMatches(startsLocal,startsAt,timeZone)||!localMatches(endsLocal,endsAt,timeZone)||Date.parse(endsAt)<=Date.parse(startsAt)
 ||Date.parse(endsAt)-Date.parse(startsAt)>consentLimits.entryMinutes*60000)return invalid()
 return {startsAt,endsAt,startsLocal,endsLocal,timeZone}
}
export function parseConsentStaffCommand(input:unknown):ConsentStaffCommand{
 const raw=input as {action?:unknown};const action=raw?.action
 if(action==='publish_policy') {const v=consentObject(input,['action','commandId','expectedVersion','details','reason']);return {action,commandId:consentId(v.commandId),expectedVersion:consentVersion(v.expectedVersion,true),details:parseConsentPolicy(v.details),reason:consentText(v.reason,3,1000)}}
 if(action==='publish_roster') {const v=consentObject(input,['action','commandId','expectedVersion','policyVersion','details','reason']);return {action,commandId:consentId(v.commandId),expectedVersion:consentVersion(v.expectedVersion,true),policyVersion:consentVersion(v.policyVersion),details:parseConsentRoster(v.details),reason:consentText(v.reason,3,1000)}}
 if(action==='save_authority') {const v=consentObject(input,['action','commandId','id','expectedVersion','policyVersion','details','reason']);const id=v.id===null?null:consentId(v.id),expectedVersion=consentVersion(v.expectedVersion,true);if((id===null)!==(expectedVersion===0))return invalid();return {action,commandId:consentId(v.commandId),id,expectedVersion,policyVersion:consentVersion(v.policyVersion),details:parseConsentAuthority(v.details),reason:consentText(v.reason,3,1000)}}
 if(action==='revoke_authority') {const v=consentObject(input,['action','commandId','id','expectedVersion','reason']);return {action,commandId:consentId(v.commandId),id:consentId(v.id),expectedVersion:consentVersion(v.expectedVersion),reason:consentText(v.reason,3,1000)}}
 if(action==='withdraw_request') {const v=consentObject(input,['action','commandId','requestId','expectedVersion','reason']);return {action,commandId:consentId(v.commandId),requestId:consentId(v.requestId),expectedVersion:consentVersion(v.expectedVersion),reason:consentText(v.reason,3,1000)}}
 if(action==='publish_request'){
  const v=consentObject(input,['action','commandId','caseId','expectedCaseVersion','planId','planVersion','purpose','expectedVersion','consentPolicyVersion','rosterId','rosterVersion','publicSummary','conditions','funding','reviewedAgainstPlan','responseDeadline','consentValidUntil','entryWindow','reason'])
  if(v.funding!=='property_no_resident_charge'||v.reviewedAgainstPlan!==true)return invalid()
  const purpose=consentPurpose(v.purpose),entryWindow=v.entryWindow===null?null:parseConsentEntryWindow(v.entryWindow)
  if(purpose==='work'&&entryWindow!==null)return invalid()
  const responseDeadline=consentTime(v.responseDeadline),consentValidUntil=consentTime(v.consentValidUntil)
  if(responseDeadline>consentValidUntil||(entryWindow&&(responseDeadline>entryWindow.startsAt||consentValidUntil<entryWindow.endsAt)))return invalid()
  return {action,commandId:consentId(v.commandId),caseId:consentId(v.caseId),expectedCaseVersion:consentVersion(v.expectedCaseVersion),planId:consentId(v.planId),planVersion:consentVersion(v.planVersion),purpose,
   expectedVersion:consentVersion(v.expectedVersion,true),consentPolicyVersion:consentVersion(v.consentPolicyVersion),rosterId:consentId(v.rosterId),rosterVersion:consentVersion(v.rosterVersion),
   publicSummary:consentText(v.publicSummary,10,1000),conditions:consentText(v.conditions,0,2000),funding:v.funding,reviewedAgainstPlan:true,responseDeadline,consentValidUntil,entryWindow,reason:consentText(v.reason,3,1000)}
 }
 return invalid()
}
export function parseConsentGrant(input:unknown):ConsentGrantCommand{
 const v=consentObject(input,['action','commandId','requestId','requestVersion','expectedDecisionVersion','purpose','termsDigest','materialDigest'])
 if(v.action!=='grant')return invalid()
 return {action:'grant',commandId:consentId(v.commandId),requestId:consentId(v.requestId),requestVersion:consentVersion(v.requestVersion),expectedDecisionVersion:consentVersion(v.expectedDecisionVersion,true),purpose:consentPurpose(v.purpose),termsDigest:consentDigest(v.termsDigest),materialDigest:consentDigest(v.materialDigest)}
}
export function parseConsentOwnCommand(input:unknown):ConsentOwnCommand{
 const action=(input as {action?:unknown})?.action
 if(action!=='decline'&&action!=='revoke')return invalid()
 const v=consentObject(input,['action','commandId','requestId','requestVersion','expectedDecisionVersion','purpose',action==='revoke'?'grantId':'termsDigest'])
 const base={commandId:consentId(v.commandId),requestId:consentId(v.requestId),requestVersion:consentVersion(v.requestVersion),expectedDecisionVersion:consentVersion(v.expectedDecisionVersion,true),purpose:consentPurpose(v.purpose)}
 return action==='revoke'?{...base,action,grantId:consentId(v.grantId)}:{...base,action,termsDigest:consentDigest(v.termsDigest)}
}
export function parseConsentList(input:unknown):ConsentListQuery{
 const raw=input as {before?:unknown};const v=consentObject(input,raw?.before===undefined?['limit']:['limit','before']),limit=integer(v.limit,1,consentLimits.list)
 if(v.before===undefined)return {limit}
 const before=consentObject(v.before,['createdAt','id']);return {limit,before:{createdAt:consentTime(before.createdAt),id:consentId(before.id)}}
}

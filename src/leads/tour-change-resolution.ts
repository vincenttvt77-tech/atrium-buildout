import type { ResolvedPropertyRuntime } from '../application/runtime.ts'
import type { CalendarState, SlotBooking } from '../calendar/types.ts'
import { cancellations } from '../calendar/cancellation.ts'
import { bookingSlot } from '../calendar/slots.ts'
import { bookingReviewProjectionPending } from '../calendar/booking-review.ts'
import { CalendarActionError, requestIdentity } from '../calendar/unit-blocks.ts'
import { assertAuthorizedScope } from '../auth/authorization.ts'
import { hashJson } from '../workflows/validation.ts'
import { checkedTourChangeRequest, type TourChangeRequest, type TourChangeResolution } from './tour-change.ts'

const fail = (code: string, message: string, status = 409): never => { throw new CalendarActionError(code, message, status) }
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const noteText = (v: unknown): v is string => typeof v === 'string' && v.length <= 1000 && v.trim().length >= 3
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(v)
const requestKey = (id: unknown): string => typeof id === 'string' && /^tour-change:[a-f0-9]{64}$/.test(id)
  ? id : fail('tour_resolution_input_invalid', 'Choose a saved caller request.', 400)
const receiptKey = (id: string) => 'tour-change-resolution:' + hashJson(id)
interface Candidate { outcome: 'rescheduled' | 'cancelled'; name: string; source: NonNullable<TourChangeResolution['source']> }

/** Proves only a current saved calendar outcome. Staff must verify whose request it addresses. */
export function tourChangeCandidates(state: CalendarState, request: TourChangeRequest, now: Date): Candidate[] {
  checkedTourChangeRequest(request)
  if (!Number.isFinite(now.getTime())) return fail('tour_resolution_clock_invalid', 'The review clock is unavailable.')
  const archived = cancellations(state), candidates: Candidate[] = []
  const counts = new Map<string, number>()
  for (const row of [...state.bookings, ...archived.map(c=>c.booking)]) counts.set(row.externalId,(counts.get(row.externalId)??0)+1)
  const eligible = (booking: SlotBooking, at: string): boolean => counts.get(booking.externalId) === 1
    && text(booking.externalId, 1024) && !!booking.startsAt && !!booking.endsAt && !!bookingSlot(booking)
    && (booking.unitId === null || text(booking.unitId, 80))
    && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Math.max(Date.parse(request.lastRequestedAt ?? request.lastUpdatedAt),Date.parse(request.firstRequestedAt)) && Date.parse(at) <= now.getTime()
  const add = (outcome: Candidate['outcome'], booking: SlotBooking, operationId: string, at: string, proof: unknown) => {
    if (!text(operationId,128) || !eligible(booking,at)) return
    candidates.push({ outcome, name: typeof booking.prospectName === 'string' ? booking.prospectName : '', source: {
      externalId: booking.externalId, operationId, at, sha256: hashJson({ outcome, booking, proof }),
      startsAt: booking.startsAt!, endsAt: booking.endsAt!, unitId: booking.unitId,
    } })
  }
  for (const c of archived) add('cancelled',c.booking,c.requestId,c.at,c)
  for (const b of state.bookings) {
    const history = b.rescheduleHistory
    if (!Array.isArray(history) || !history.length || history.some(r=>!r || r.projection !== 'complete')
      || bookingReviewProjectionPending(state,b.externalId)) continue
    const latest = history.at(-1)!
    if (!Number.isSafeInteger(latest.revision) || latest.revision <= 0 || latest.revision !== b.revision
      || history.some((r,i)=>!Number.isSafeInteger(r.revision) || r.revision <= 0 || i>0 && r.revision<=history[i-1]!.revision)
      || !latest.to || b.slotId !== latest.to.slotId || b.startsAt !== latest.to.startsAt || b.endsAt !== latest.to.endsAt || b.unitId !== latest.to.unitId) continue
    add('rescheduled',b,latest.requestId,latest.at,latest)
  }
  return candidates.sort((a,b)=>b.source.at.localeCompare(a.source.at)||a.source.externalId.localeCompare(b.source.externalId))
}

function parse(input: unknown) {
  const v = input as Record<string,unknown> | null
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || Object.keys(v).sort().join(',') !== 'action,expectedRevision,expectedSha256,id,note,outcome,requestId,sourceSha256,verified'
    || v.action !== 'resolve' || !Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision)<0 || !digest(v.expectedSha256)
    || !['cancelled','rescheduled','no_change'].includes(String(v.outcome)) || !noteText(v.note) || v.verified!==true
    || (v.outcome==='no_change' ? v.sourceSha256!==null : !digest(v.sourceSha256))) return fail('tour_resolution_input_invalid','Review the latest request, select an outcome and record what you verified.',400)
  return { action:'resolve' as const,id:requestKey(v.id),expectedRevision:Number(v.expectedRevision),expectedSha256:v.expectedSha256,
    requestId:requestIdentity(v.requestId),outcome:v.outcome as TourChangeResolution['outcome'],sourceSha256:v.sourceSha256 as string|null,note:v.note.trim(),verified:true as const }
}
interface Receipt { format:'tour-change-resolution-v1'; manifestSha256:string; id:string; resolution:TourChangeResolution }

export function createTourChangeResolutionService(runtime: ResolvedPropertyRuntime, now=()=>new Date()) {
  assertAuthorizedScope(runtime.scope,'operate')
  const actor=runtime.scope.actor
  if(actor.kind!=='user')return fail('tour_resolution_staff_required','Staff sign-in is required.',403)
  const fingerprint=(request:TourChangeRequest)=>hashJson({organizationId:runtime.scope.organizationId,propertyId:runtime.scope.propertyId,
    configurationVersion:runtime.snapshot.version,request})
  const found=(raw:TourChangeRequest|null,id:string)=>{
    if(!raw)return fail('tour_resolution_missing','This caller request is not available in this property.',404)
    const request=checkedTourChangeRequest(raw)
    if(request.id!==id)return fail('tour_resolution_corrupt','The request record needs administrator review.')
    return request
  }
  return {
    async read(id:unknown, search:unknown='') {
      const key=requestKey(id)
      if(typeof search!=='string'||search.length>120||/[\u0000-\u001f\u007f]/.test(search))return fail('tour_resolution_input_invalid','Use a short name or apartment search.',400)
      return runtime.calendarStore.transaction(async unit=>{
        const state=await unit.readCalendar(),request=found(await unit.readLockedDocument<TourChangeRequest>(key),key)
        const matches=tourChangeCandidates(state,request,now()).filter(row=>!search.trim()||[row.name,row.source.unitId??''].join(' ').toLowerCase().includes(search.trim().toLowerCase()))
        return {request,expectedSha256:fingerprint(request),candidates:matches.slice(0,100),more:matches.length>100,
          canResolve:request.status!=='resolved'&&(request.resolutions?.length??0)<100&&request.revision<Number.MAX_SAFE_INTEGER}
      })
    },
    async resolve(input:unknown) {
      const command=parse(input),manifestSha256=hashJson({...command,actorId:actor.userId})
      return runtime.calendarStore.transaction(async unit=>{
        // Match calendar writers' lock order, then serialize new caller evidence and this decision.
        const state=await unit.readCalendar(),request=found(await unit.readLockedDocument<TourChangeRequest>(command.id),command.id)
        const prior=await unit.documents.get<Receipt>(receiptKey(command.requestId))
        if(prior){
          if(prior.format!=='tour-change-resolution-v1'||!digest(prior.manifestSha256)||prior.id!==command.id
            || !prior.resolution || prior.resolution.requestId !== command.requestId
            || !request.resolutions?.some(r=>hashJson(r)===hashJson(prior.resolution)))return fail('tour_resolution_corrupt','The saved outcome requires administrator review.')
          if(prior.manifestSha256!==manifestSha256)return fail('tour_resolution_conflict','This saved request belongs to a different decision. Reload before continuing.')
          // Historical acknowledgement must not re-close a request reopened by later caller evidence.
          return {request,resolution:prior.resolution,replayed:true}
        }
        if(request.status==='resolved'||request.revision!==command.expectedRevision||fingerprint(request)!==command.expectedSha256)
          return fail('tour_resolution_changed','The caller request or property changed. Review the latest details before recording an outcome.')
        if((request.resolutions?.length??0)>=100||request.revision>=Number.MAX_SAFE_INTEGER)return fail('tour_resolution_limit','This request needs administrator review before another outcome.')
        const at=now();if(!Number.isFinite(at.getTime())||at.getTime()<Math.max(Date.parse(request.lastUpdatedAt),Date.parse(request.firstRequestedAt)))return fail('tour_resolution_clock_invalid','The review clock is unavailable.')
        const matches=command.outcome==='no_change'?[]:tourChangeCandidates(state,request,at).filter(c=>c.outcome===command.outcome&&c.source.sha256===command.sourceSha256)
        if(command.outcome!=='no_change'&&matches.length!==1)return fail('tour_resolution_source_changed','That saved tour change is no longer current or cannot be verified. Reload the calendar and request.')
        const resolution:TourChangeResolution={requestId:command.requestId,requestRevision:request.revision,actorId:actor.userId,at:at.toISOString(),
          note:command.note,outcome:command.outcome,source:matches[0]?.source??null,association:command.outcome==='no_change'?'staff_decision':'staff_verified',notification:'not_sent_by_resolution'}
        const next=checkedTourChangeRequest({...request,status:'resolved',revision:request.revision+1,lastUpdatedAt:resolution.at,resolutions:[...(request.resolutions??[]),resolution]})
        await unit.documents.set(command.id,next)
        await unit.documents.set<Receipt>(receiptKey(command.requestId),{format:'tour-change-resolution-v1',manifestSha256,id:command.id,resolution})
        return {request:next,resolution,replayed:false}
      })
    },
  }
}

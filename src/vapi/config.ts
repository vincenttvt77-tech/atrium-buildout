import { assistantConfig } from './assistant.ts'
import type { AuthorizedScope } from '../auth/index.ts'
import { assertPropertySnapshot } from '../properties/snapshot.ts'
import type { PropertySnapshot } from '../properties/model.ts'

/**
 * The demo property's assistant, built from the property record.
 *
 * One function, used by the script that prints the configuration and by the endpoint
 * that pushes it to Vapi, so the phone line and the repository cannot describe two
 * different assistants.
 */
type PropertyRecord = Record<string, unknown> & {
  buildingName?: string; address?: string; leasingHours?: string; managementCompany?: string
  floors?: number; yearBuilt?: number; totalUnits?: number; leasingOffice?: string
  buildingFacts?: { height?: string; residenceNumbering?: string }
  team?: { leasing?: string }
  neighborhood?: string | { transit?: string[]; nearby?: string[] }
  sourceNote?: string
}

/** The property record nests transit and nearby places; the prompt wants prose. */
function neighborhoodText(n: PropertyRecord['neighborhood']): string {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return 'the neighborhood'
  return [...(n.transit ?? []), ...(n.nearby ?? [])].join('. ')
}

function buildingFacts(p: PropertyRecord): string[] {
  const f: string[] = []
  if (p.buildingFacts?.height) f.push(`${p.floors} floors, ${p.buildingFacts.height} tall, completed ${p.yearBuilt}.`)
  if (p.totalUnits) f.push(`${p.totalUnits} residences.`)
  if (p.buildingFacts?.residenceNumbering) f.push(p.buildingFacts.residenceNumbering)
  // The office paragraph also advertises same-day/self-guided tours; those are calendar
  // capabilities, not stable identity facts. Keep only the physical entrance sentence.
  if (p.leasingOffice) f.push(p.leasingOffice.split(/(?<=\.)\s/)[0]!)
  // Only the two transit facts a caller asks about unprompted. The rest is in the
  // knowledge base, where it costs nothing until someone actually asks.
  const n = p.neighborhood
  const transit = n && typeof n === 'object' ? (n.transit ?? []) : []
  for (const t of transit.slice(0, 2)) f.push(`Transit: ${t}`)
  return f
}

export function demoAssistantConfig(property: PropertyRecord, deploymentUrl: string, now: Date = new Date(), opts: { dynamicDate?: boolean; timeZone?: string } = {}) {
  const buildingName = property.buildingName ?? 'the building'
  const demo = /DEMO PROPERTY\s*[—-]\s*FICTIONAL/i.test(property.sourceNote ?? '')
  return assistantConfig({
    buildingName,
    address: property.address ?? '',
    neighborhood: neighborhoodText(property.neighborhood),
    leasingHours: property.leasingHours ?? '',
    managementCompany: property.managementCompany ?? 'the management office',
    facts: buildingFacts(property),
    today: now,
    dynamicDate: opts.dynamicDate ?? true,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    demo,
    serverUrl: `${deploymentUrl.replace(/\/$/, '')}/api/vapi`,
    firstMessage: `Thanks for calling ${buildingName}${demo ? ' demo' : ''}. I'm an AI assistant for the building and this call is recorded — how can I help?`,
  })
}

export type DemoAssistantConfig = ReturnType<typeof demoAssistantConfig>

/** Approved property identity only; mutable facts and policies stay behind scoped tools. */
export function managedAssistantConfig(snapshot: PropertySnapshot, scope: AuthorizedScope, deploymentUrl: string) {
  assertPropertySnapshot(snapshot, scope)
  const text = (key: string, required = false): string | undefined => {
    const value = snapshot.property[key]
    if (value === undefined && !required) return undefined
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 500
      || /[\u0000-\u001f\u007f-\u009f{}]/.test(value)) {
      throw new Error('Publish a valid property name, address and management identity before reviewing its phone assistant.')
    }
    return value
  }
  const buildingName = text('buildingName', true)!, address = text('address', true)!
  const managementCompany = text('managementCompany')
  const sourceNote = text('sourceNote')
  return demoAssistantConfig({ buildingName, address,
    ...(managementCompany ? { managementCompany } : {}), ...(sourceNote ? { sourceNote } : {}) },
  deploymentUrl, new Date(0), { dynamicDate: true, timeZone: snapshot.timeZone })
}

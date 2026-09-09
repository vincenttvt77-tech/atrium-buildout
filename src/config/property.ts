import property from '../../data/property.json' with { type: 'json' }
import { DEFAULT_TIME_ZONE, validateTimeZone } from '../calendar/time.ts'

/** The bundled demo remains one property. Only an absent legacy field uses New York. */
export function propertyTimeZone(record: Record<string, unknown> = property): string {
  return validateTimeZone(Object.hasOwn(record, 'timeZone') ? record.timeZone : DEFAULT_TIME_ZONE)
}

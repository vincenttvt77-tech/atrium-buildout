/** Branded identifiers: stop a PropertyId ever being passed where a PersonId belongs. */
declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type OrganizationId = Brand<string, 'OrganizationId'>
export type PropertyId = Brand<string, 'PropertyId'>
export type UnitId = Brand<string, 'UnitId'>
export type PersonId = Brand<string, 'PersonId'>
export type InteractionId = Brand<string, 'InteractionId'>
export type ArticleId = Brand<string, 'ArticleId'>

export const organizationId = (v: string) => v as OrganizationId
export const propertyId = (v: string) => v as PropertyId
export const unitId = (v: string) => v as UnitId
export const personId = (v: string) => v as PersonId
export const interactionId = (v: string) => v as InteractionId
export const articleId = (v: string) => v as ArticleId

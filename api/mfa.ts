import { handleMfaRequest } from '../src/auth/mfa-http.ts'

/** Staff endpoint: the request cannot select its authentication audience. */
export default async function handler(req: any, res: any) {
  return handleMfaRequest(req, res, 'staff')
}

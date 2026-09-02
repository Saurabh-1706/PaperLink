/**
 * The authenticated caller, resolved from a verified access token. Every signed-in
 * user has full access within their organization — there is no role/permission layer.
 */
import { decodeToken } from "./security";

export interface Principal {
  userId: string;
  organizationId: string;
}

export async function principalFromAccessToken(token: string): Promise<Principal | null> {
  try {
    const claims = await decodeToken(token, "access");
    return { userId: claims.sub, organizationId: claims.org };
  } catch {
    return null;
  }
}

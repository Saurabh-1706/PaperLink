import type { Role } from "@/lib/rbac/roles";

/** The signed-in principal, derived from the backend's JWT claims. */
export interface AuthUser {
  id: string; // JWT `sub`
  organizationId: string; // JWT `org`
  role: Role; // JWT `role`
  email: string;
  /** Display name — the backend's token carries no name claim, so it is derived from the email. */
  name: string;
}

export interface Credentials {
  email: string;
  password: string;
}

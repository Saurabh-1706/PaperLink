"use client";

import { useAuth } from "@/features/auth/hooks/useAuth";
import type { Permission } from "@/lib/rbac/roles";

/**
 * Renders `children` only when the signed-in role holds `permission`.
 *
 * This hides controls the API would reject; it is not a security boundary.
 * The backend re-checks every permission (`require()` in api/v1/deps.py).
 */
export function Can({
  permission,
  fallback = null,
  children,
}: {
  permission: Permission;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  return useAuth().can(permission) ? <>{children}</> : <>{fallback}</>;
}

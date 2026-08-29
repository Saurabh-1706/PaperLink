"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/features/auth/hooks/useAuth";
import type { Permission } from "@/lib/rbac/roles";

/**
 * Route-level guard. `middleware.ts` already blocks the request for the routes
 * listed in lib/rbac/navigation.ts; this covers client-side navigations and
 * any page whose requirement is finer-grained than its URL.
 */
export function RoleGate({
  permission,
  children,
}: {
  permission: Permission;
  children: React.ReactNode;
}) {
  const { can, isLoading } = useAuth();
  const router = useRouter();
  const allowed = can(permission);

  useEffect(() => {
    if (!isLoading && !allowed) router.replace("/forbidden");
  }, [isLoading, allowed, router]);

  if (isLoading || !allowed) return null;
  return <>{children}</>;
}

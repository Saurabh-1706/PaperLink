import { ROLE_PERMISSIONS, type Permission, type Role } from "./roles";

/** Mirrors `has_permission()` in backend/app/core/permissions.py. */
export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function hasAnyPermission(role: Role | null | undefined, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

export type { Permission, Role };

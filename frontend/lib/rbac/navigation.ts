import type { Permission } from "./roles";

/**
 * The primary navigation, declared once. `Sidebar` filters this by the signed-in
 * role and `middleware.ts` uses the same list to guard the routes, so a nav item
 * a user cannot see is also a URL they cannot open.
 */
export interface NavItem {
  id: string;
  label: string;
  /** Material Symbols ligature. */
  icon: string;
  href: string;
  /** Omitted = visible to every authenticated user. */
  permission?: Permission;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", href: "/dashboard" },
  { id: "assessments", label: "Assessments", icon: "fact_check", href: "/assessments" },
  { id: "classroom", label: "My Classes", icon: "school", href: "/classes" },
  { id: "library", label: "Library", icon: "local_library", href: "/library" },
  { id: "reports", label: "Reports", icon: "assessment", href: "/reports" },
  { id: "settings", label: "Settings", icon: "settings", href: "/settings", permission: "manage_org" },
];

/** Route → permission required to open it. Kept next to NAV_ITEMS so the two never drift. */
export const ROUTE_PERMISSIONS: { prefix: string; permission: Permission }[] = NAV_ITEMS.filter(
  (i): i is NavItem & { permission: Permission } => !!i.permission
).map((i) => ({ prefix: i.href, permission: i.permission }));

export function requiredPermissionFor(pathname: string): Permission | null {
  const match = ROUTE_PERMISSIONS.find(
    (r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`)
  );
  return match?.permission ?? null;
}

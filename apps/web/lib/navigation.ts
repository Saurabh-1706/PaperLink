/**
 * The primary navigation, declared once and shown in full to every signed-in user
 * — there is no role/permission gating on routes or nav items.
 */
export interface NavItem {
  id: string;
  label: string;
  /** Material Symbols ligature. */
  icon: string;
  href: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", href: "/dashboard" },
  { id: "assessments", label: "Assessments", icon: "fact_check", href: "/assessments" },
  { id: "classroom", label: "My Classes", icon: "school", href: "/classes" },
  { id: "library", label: "Library", icon: "local_library", href: "/library" },
  { id: "reports", label: "Reports", icon: "assessment", href: "/reports" },
  { id: "settings", label: "Settings", icon: "settings", href: "/settings" },
];

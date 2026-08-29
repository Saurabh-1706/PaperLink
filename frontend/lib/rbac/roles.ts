/**
 * Roles and the capability matrix.
 *
 * SOURCE OF TRUTH: `backend/app/core/permissions.py` (see docs/05-rbac.md).
 * This file mirrors it exactly — same role strings, same permission strings,
 * same matrix. The client copy exists only so the UI can hide what the API
 * would refuse; it is never the enforcement point.
 */

export const ROLES = ["admin", "teacher", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "manage_org",
  "create_assessment",
  "upload_document",
  "trigger_processing",
  "read",
  "review_mapping",
  "grade",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const TEACHER: Permission[] = [
  "create_assessment",
  "upload_document",
  "trigger_processing",
  "read",
  "grade",
  "review_mapping",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: ["manage_org", ...TEACHER],
  teacher: TEACHER,
  // Reviewer reads everything and resolves needs_review; no upload, no delete.
  reviewer: ["read", "review_mapping"],
};

/** Human label shown in the app chrome. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  teacher: "Academic Lead",
  reviewer: "Reviewer",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
